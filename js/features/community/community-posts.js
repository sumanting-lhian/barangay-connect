/* ================================================
   community-posts.js — BarangayConnect
   Resident community posts — submission, moderation
   checks, and real-time subscription. Posts are
   merged into the bulletin feed on the Community page.

   Firestore path:
     barangays/{barangayId}/communityPosts/{id}

   Fields:
     title, body, category, imageURLs (opt), authorId,
     authorName, authorRole, status (pending|published),
     flagReason, likeCount, commentCount, createdAt, updatedAt
     (dailyCount is not stored here — tracked via a separate
      date-keyed doc per user)

   WHAT IS IN HERE:
     · Module state initialization (initCommunityPosts)
     · Real-time published-posts subscription (subscribeCommunityPosts)
     · Daily post count check per user (getTodayPostCount)
     · Moderation settings fetch with defaults (getModerationSettings)
     · Approval requirement check (requiresApproval)
     · Full post submission flow with moderation (submitCommunityPost):
         – Daily limit enforcement with per-user override
         – Blocked-word, blocked-link, and profanity checks
         – Image upload via storage helper
         – Pending vs. published status assignment

   WHAT IS NOT IN HERE:
     · Admin approval queue UI                → community-posts-admin.js
     · Image viewer implementation            → window.openImageViewer (external)
     · Comment thread UI                      → comments.js
     · Firebase config and db instance        → firebase-config.js
     · Image upload helper                    → storage.js
     · Firestore path helpers                 → db-paths.js

   REQUIRED IMPORTS:
     · ../../core/firebase-config.js          (db)
     · ../../core/storage.js                  (uploadImage)
     · ../../core/db-paths.js                 (postPhotoPath)
     · firebase-firestore.js@10.12.0 (collection, addDoc, query, where,
                                      orderBy, onSnapshot, serverTimestamp,
                                      getDoc, doc, updateDoc, increment,
                                      getDocs, limit)

   QUICK REFERENCE:
     Init module          → initCommunityPosts(barangayId, uid, userName, role)
     Subscribe to posts   → subscribeCommunityPosts(callback) → unsub fn
     Submit a post        → submitCommunityPost({ title, body, category, imageFiles })
     Check approval flag  → requiresApproval() → Promise<boolean>
     Fetch settings       → getModerationSettings() → Promise<object>
================================================ */


// ================================================
// IMPORTS
// ================================================

import { db } from '../../core/firebase-config.js';

import {
  collection, addDoc, query, where, orderBy,
  onSnapshot, serverTimestamp, getDoc, doc, updateDoc,
  increment, getDocs, limit,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { uploadImage }  from '../../core/storage.js';
import { postPhotoPath } from '../../core/db-paths.js';


// ================================================
// MODULE STATE
// ================================================

let _barangayId = null;
let _uid        = null;
let _role       = 'resident';
let _userName   = 'Resident';


// ================================================
// INIT
// ================================================

/* Initializes module-level state; must be called after auth resolves */
export function initCommunityPosts(barangayId, uid, userName, role) {
  _barangayId = barangayId;
  _uid        = uid;
  _role       = role || 'resident';
  _userName   = userName;
}


// ================================================
// SUBSCRIPTION
// ================================================

/* Subscribes to published community posts, newest first; returns unsub fn */
export function subscribeCommunityPosts(callback) {
  if (!_barangayId) return () => {};

  const col = collection(db, 'barangays', _barangayId, 'communityPosts');
  const q   = query(col, where('status', '==', 'published'), orderBy('createdAt', 'desc'));

  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => ({ id: d.id, _type: 'post', ...d.data() })));
  });
}


// ================================================
// MODERATION SETTINGS
// ================================================

/* Fetches barangay moderation settings; returns safe defaults on failure */
export async function getModerationSettings() {
  if (!_barangayId) {
    return { requirePostApproval: false, blockedWords: [], blockedLinksEnabled: true, postWarningText: '' };
  }
  try {
    const snap = await getDoc(doc(db, 'barangays', _barangayId, 'meta', 'settings'));
    if (!snap.exists()) {
      return { requirePostApproval: false, blockedWords: [], blockedLinksEnabled: true, postWarningText: '' };
    }
    return snap.data();
  } catch {
    return { requirePostApproval: false, blockedWords: [], blockedLinksEnabled: true, postWarningText: '' };
  }
}

/* Returns true if the barangay requires admin approval for new posts */
export async function requiresApproval() {
  const s = await getModerationSettings();
  return s.requirePostApproval ?? false;
}


// ================================================
// DAILY LIMIT
// ================================================

/*
   Counts how many posts the current user has submitted today.
   Uses a client-side date filter over a capped getDocs query.
*/
async function getTodayPostCount() {
  if (!_barangayId || !_uid) {
    console.warn('[limit] not ready', _barangayId, _uid);
    return 0;
  }

  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(today + 'T00:00:00');
  const end   = new Date(today + 'T23:59:59');

  const col  = collection(db, 'barangays', _barangayId, 'communityPosts');
  const q    = query(col, where('authorId', '==', _uid), limit(20));
  const snap = await getDocs(q);

  const count = snap.docs.filter(d => {
    const t = d.data().createdAt?.toDate?.() ?? new Date(0);
    return t >= start && t <= end;
  }).length;

  console.log('[limit] today count:', count);
  return count;
}


// ================================================
// SUBMIT POST
// ================================================

/*
   Full submission flow:
     1. Validate title
     2. Enforce daily limit (with per-user override)
     3. Run moderation checks: blocked words, links, profanity API
     4. Upload any image files
     5. Write post document with pending or published status
   Returns true if the post requires approval, false if published immediately.
*/
export async function submitCommunityPost({ title, body, category, imageFiles }) {
  if (!_barangayId || !_uid) throw new Error('Not initialized.');
  if (!title?.trim()) throw new Error('Title is required.');

  // ── 1. Daily limit check ──────────────────────────────────────
  const count    = await getTodayPostCount();
  const settings = await getModerationSettings();

  let effectiveLimit = settings.defaultPostLimit ?? 3;

  /* Check for per-user override from their barangay user doc */
  try {
    const { getDoc: _gd, doc: _d } =
      await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const uSnap = await _gd(_d(db, 'barangays', _barangayId, 'users', _uid));
    if (uSnap.exists()) {
      const role     = uSnap.data().role;
      const override = uSnap.data().postLimitOverride;
      if (role === 'admin' || role === 'officer') {
        effectiveLimit = Infinity; // admins and officers are always unlimited
      } else if (typeof override === 'number') {
        effectiveLimit = override === -1 ? Infinity : override;
      }
    }
  } catch { /* non-fatal — fall back to default limit */ }

  if (effectiveLimit !== Infinity && count >= effectiveLimit) {
    throw new Error(`You've reached the daily limit of ${effectiveLimit} posts. Try again tomorrow.`);
  }

  // ── 2. Moderation checks ──────────────────────────────────────
  const blockedWords = settings.blockedWords ?? [];
  const blockLinks   = settings.blockedLinksEnabled ?? false;
  const combined     = `${title} ${body}`.toLowerCase();

  const hitWord = blockedWords.find(w => w && combined.includes(w.toLowerCase()));
  const hasLink = blockLinks && /https?:\/\/|www\./i.test(combined);

  /* Profanity check via PurgoMalum — fail-open if API is unavailable */
  let hasProfanity = false;
  try {
    const apiRes = await fetch(
      `https://www.purgomalum.com/service/containsprofanity?text=${encodeURIComponent(combined)}`,
      { signal: AbortSignal.timeout(3000) }
    );
    hasProfanity = (await apiRes.text()).trim() === 'true';
  } catch {
    hasProfanity = false;
  }

  const userRole     = _role;
  const isPrivileged = userRole === 'admin' || userRole === 'officer';

  /* Determine flag reason; privileged users are never flagged */
  let flagReason = null;
  if (!isPrivileged) {
    if (hasProfanity)                    flagReason = 'profanity';
    else if (hitWord)                    flagReason = `blocked_word:${hitWord}`;
    else if (hasLink)                    flagReason = 'link';
    else if (settings.requirePostApproval) flagReason = 'approval_required';
  }

  const needsApproval = !isPrivileged &&
    ((settings.requirePostApproval ?? false) || !!hitWord || hasLink || hasProfanity);

  // ── 3. Image uploads ──────────────────────────────────────────
  const imageURLs = [];

  if (imageFiles?.length) {
    for (const file of imageFiles) {
      const path = postPhotoPath(
        _barangayId,
        _uid,
        `${Date.now()}-${Math.random().toString(36).slice(2)}.webp`,
      );
      const url = await uploadImage(file, path);
      imageURLs.push(url);
    }
  }

  // ── 4. Write post document ────────────────────────────────────
  const payload = {
    title:        title.trim(),
    body:         body.trim(),
    category:     category || 'general',
    imageURLs,
    authorId:     _uid,
    authorName:   _userName,
    authorRole:   userRole,
    status:       needsApproval ? 'pending' : 'published',
    flagReason:   flagReason ?? null,
    likeCount:    0,
    commentCount: 0,
    createdAt:    serverTimestamp(),
    updatedAt:    serverTimestamp(),
  };

  await addDoc(collection(db, 'barangays', _barangayId, 'communityPosts'), payload);
  return needsApproval;
}
