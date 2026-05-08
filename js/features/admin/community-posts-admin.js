/* ================================================
   community-posts-admin.js — BarangayConnect
   Admin approval queue for resident-submitted
   community posts. Listens to pending posts in
   real time and exposes approve / reject actions.

   Firestore path:
     barangays/{barangayId}/communityPosts

   WHAT IS IN HERE:
     · onAuthStateChanged bootstrap — resolves barangay, role, and collection ref
     · Real-time onSnapshot listener for pending posts
     · Pending badge count update (sidebar and main badge)
     · Pending post list renderer (renderPendingPosts)
     · Pending post row builder (buildPendingRow)
     · Approve action — sets status to 'published' (window.approvePost)
     · Reject action — deletes the post document (window.rejectPost)
     · Flag reason formatter (formatFlagReason)
     · Toast notification helper (showToast)
     · XSS escape utility (esc)

   WHAT IS NOT IN HERE:
     · Resident-facing post submission UI     → community.js
     · Reported-post review flow             → reports-admin.js
     · Image viewer implementation           → window.openImageViewer (external)
     · Post detail modal                     → window.viewReportedPost (external)
     · Firebase config and db instance       → firebase-config.js
     · Firestore path helpers                → db-paths.js

   REQUIRED IMPORTS:
     · ../../core/firebase-config.js          (auth, db)
     · ../../core/db-paths.js                 (userIndexDoc, barangayId as toBid)
     · firebase-firestore.js@10.12.0 (collection, onSnapshot, query, where,
                                      orderBy, doc, updateDoc, deleteDoc,
                                      serverTimestamp, getDoc)
     · firebase-auth.js@10.12.0      (onAuthStateChanged)

   QUICK REFERENCE:
     Bootstrap       → onAuthStateChanged (top-level, runs on load)
     Render queue    → renderPendingPosts(posts)
     Approve post    → window.approvePost(id)
     Reject post     → window.rejectPost(id, title)
================================================ */


// ================================================
// IMPORTS
// ================================================

import { auth, db }                          from '../../core/firebase-config.js';
import { userIndexDoc, barangayId as toBid } from '../../core/db-paths.js';

import {
  collection, onSnapshot, query, where,
  orderBy, doc, updateDoc, deleteDoc, serverTimestamp, getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";


// ================================================
// MODULE STATE
// ================================================

let _col = null; // Firestore communityPosts collection reference


// ================================================
// BOOTSTRAP
// ================================================

/*
   Resolves the admin's barangay and role from userIndex.
   Sets _col and starts the real-time pending-posts listener.
*/
onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  const snap = await getDoc(userIndexDoc(user.uid));
  if (!snap.exists()) return;

  const { barangay, role } = snap.data();
  if (role !== 'admin' && role !== 'officer') return;

  const bid = toBid(barangay);
  _col = collection(db, 'barangays', bid, 'communityPosts');

  /* Listen to pending posts only, newest first */
  const q = query(_col, where('status', '==', 'pending'), orderBy('createdAt', 'desc'));

  onSnapshot(q, snap => {
    const posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    /* Update sidebar and main pending-count badges */
    const badge = document.getElementById('pendingPostsBadge');
    if (badge) {
      badge.textContent   = posts.length;
      badge.style.display = posts.length > 0 ? 'inline' : 'none';
      badge.style.background = 'rgba(0,0,0,0.12)';
      badge.style.color      = '#374151';
      const mainBadge = document.getElementById('reportsMainBadge');
    if (mainBadge) {
      mainBadge.textContent   = posts.length;
      mainBadge.style.display = posts.length > 0 ? 'inline' : 'none';
    }
  }
    window._pendingPostsCount = posts.length;
    renderPendingPosts(posts);
  });
});


// ================================================
// RENDER — Pending Post List
// ================================================

/* Rebuilds the pending posts list DOM from the current snapshot */
function renderPendingPosts(posts) {
  const el = document.getElementById('pendingPostsList');
  if (!el) return;

  if (!posts.length) {
    el.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:3rem;text-align:center;
        color:#aaa;box-shadow:0 1px 4px rgba(0,0,0,.07);">
        <div style="font-size:2rem;margin-bottom:.5rem;">✅</div>
        <p style="margin:0;font-size:.9rem;">No posts awaiting approval.</p>
      </div>`;
    return;
  }

  el.innerHTML = posts.map(p => buildPendingRow(p)).join('');
  lucide.createIcons({ el });
}


// ================================================
// BUILD — Pending Post Row
// ================================================

/* Constructs and returns the HTML string for a single pending post card */
function buildPendingRow(p) {
  const time = p.createdAt?.toDate?.()
    ?.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) ?? '—';

  const imgsJson = p.imageURLs?.length
    ? encodeURIComponent(JSON.stringify(p.imageURLs))
    : null;

  const images = p.imageURLs?.length
    ? `<div style="display:flex;gap:.5rem;flex-wrap:wrap;margin:.6rem 0;">
        ${p.imageURLs.map((url, i) => `
          <div style="cursor:zoom-in;border-radius:8px;overflow:hidden;flex-shrink:0;
            border:1px solid #e5e7eb;background:#f3f4f6;"
            />` : ''}
            <img src="${esc(url)}"
              style="width:120px;height:88px;object-fit:contain;display:block;" />
          </div>`).join('')}
       </div>`
    : '';

  const flagChip = p.flagReason ? `
    <span style="background:#fef2f2;color:#dc2626;padding:2px 8px;
      border-radius:999px;font-size:.68rem;font-weight:700;border:1px solid #fca5a5;">
      ⚑ ${formatFlagReason(p.flagReason)}
    </span>` : '';

  const categoryChip = p.category && p.category !== 'general' ? `
    <span style="background:#f3f4f6;color:#374151;padding:2px 8px;
      border-radius:999px;font-size:.68rem;font-weight:600;">${esc(p.category)}</span>` : '';

  return `
    <div style="background:#fff;border-radius:12px;padding:1.25rem;
      box-shadow:0 1px 4px rgba(0,0,0,.07);border-left:3px solid #f59e0b;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;
        gap:1rem;flex-wrap:wrap;">

        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.3rem;flex-wrap:wrap;">
            <span style="font-weight:700;font-size:.95rem;">${esc(p.title)}</span>
            <span style="background:#fef3c7;color:#92400e;padding:2px 8px;
              border-radius:999px;font-size:.68rem;font-weight:700;">Pending</span>
            ${flagChip}
            ${categoryChip}
          </div>
          <p style="font-size:.78rem;color:#6b7280;margin:0 0 .4rem;">
            by ${esc(p.authorName)} · ${time}
          </p>
          <p style="font-size:.85rem;color:#374151;margin:0;line-height:1.5;">
            ${esc(p.body?.slice(0, 200))}${(p.body?.length ?? 0) > 200 ? '…' : ''}
          </p>
          ${images}
        </div>

        <div style="display:flex;gap:.5rem;flex-shrink:0;">
          <button onclick="viewReportedPost('${esc(p.id)}')"
            style="display:inline-flex;align-items:center;gap:.35rem;padding:.5rem 1rem;
              border-radius:8px;background:#f3f4f6;color:#374151;border:1.5px solid #e5e7eb;
              font-size:.82rem;font-weight:600;cursor:pointer;">
            <i data-lucide="eye" style="width:13px;height:13px;"></i> View
          </button>
          <button onclick="approvePost('${esc(p.id)}')"
            style="display:inline-flex;align-items:center;gap:.35rem;padding:.5rem 1rem;
              border-radius:8px;background:#1a3a1a;color:#fff;border:none;
              font-size:.82rem;font-weight:600;cursor:pointer;">
            <i data-lucide="check" style="width:13px;height:13px;"></i> Approve
          </button>
          <button onclick="rejectPost('${esc(p.id)}','${esc(p.title)}')"
            style="display:inline-flex;align-items:center;gap:.35rem;padding:.5rem 1rem;
              border-radius:8px;background:#fff;color:#dc2626;border:1.5px solid #fca5a5;
              font-size:.82rem;font-weight:600;cursor:pointer;">
            <i data-lucide="x" style="width:13px;height:13px;"></i> Reject
          </button>
        </div>

      </div>
    </div>`;
}


// ================================================
// ACTIONS — Approve / Reject
// ================================================

/* Sets the post status to 'published', making it visible to all residents */
window.approvePost = async function (id) {
  const ok = await showConfirm({ title: 'Approve Post?', body: 'This post will be visible to all residents.', confirm: 'Approve', cancel: 'Go Back', variant: 'confirm' });
if (!ok) return;
  if (!_col) return;
  try {
    await updateDoc(doc(_col, id), {
      status:    'published',
      updatedAt: serverTimestamp(),
    });
    showToast('Post approved and published.', 'success');
  } catch (err) {
    showToast('Failed to approve post.', 'error');
  }
};

/* Permanently deletes the post document from Firestore */
window.rejectPost = async function (id, title) {
  const ok = await showConfirm({ title: 'Reject Post?', body: `<strong>${title}</strong> will be permanently deleted.`, confirm: 'Reject', cancel: 'Go Back', variant: 'danger' });
if (!ok) return;
  if (!_col) return;
  try {
    await deleteDoc(doc(_col, id));
    showToast('Post rejected and removed.', 'success');
  } catch (err) {
    showToast('Failed to reject post.', 'error');
  }
};


// ================================================
// UTILITIES — Toast / Format / Escape
// ================================================

/* Appends a transient toast to #toastContainer; auto-removes after 3.5s */
function showToast(msg, type) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const t     = document.createElement('div');
  t.className = `toast toast--${type}`;
  t.innerHTML = `<i data-lucide="${type === 'success' ? 'check' : 'x-circle'}"></i>${esc(msg)}`;

  container.appendChild(t);
  lucide.createIcons({ el: t });
  setTimeout(() => t.remove(), 3500);
}

/* Converts a raw flagReason string into a human-readable label */
function formatFlagReason(reason) {
  if (!reason) return '';
  if (reason.startsWith('blocked_word:')) {
    return 'Blocked Word: ' + reason.replace('blocked_word:', '').trim();
  }
  return reason.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/* HTML-escapes a value for safe use in innerHTML interpolation */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}
