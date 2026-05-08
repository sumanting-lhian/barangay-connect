/* ================================================
   comments.js — BarangayConnect
   Expandable comment threads for bulletin posts.
   Handles resident-facing comment and reply UI,
   submission, deletion, likes, and reporting.

   Firestore path:
     barangays/{barangayId}/announcements/{id}/comments/{commentId}

   Fields: body, authorId, authorName, createdAt

   WHAT IS IN HERE:
     · Module state initialization (initComments)
     · Thread toggle and Firestore subscription (_subscribe)
     · Comment row and thread container HTML builders
     · Reply thread toggle and reply input box toggle
     · Comment and reply submission handlers
     · Comment deletion handler
     · Comment like / unlike handler
     · Comment report flow with duplicate and daily-limit guards
     · Moderation: PurgoMalum profanity check + admin blocked-word check
     · Toast notifications for report feedback
     · XSS escape and relative-time utilities

   WHAT IS NOT IN HERE:
     · Admin comment manager UI and bulk load  → comment-manager-admin.js
     · Firebase config and db instance         → firebase-config.js
     · Notification dispatch                   → notifications.js
     · Global modal and frame styles           → frames.css

   REQUIRED IMPORTS:
     · ../core/firebase-config.js          (db)
     · ./notifications.js            (sendNotification)
     · firebase-firestore.js@10.12.0 (collection, addDoc, deleteDoc, getDocs,
                                      doc, onSnapshot, query, where, orderBy,
                                      serverTimestamp, increment, updateDoc,
                                      getDoc, setDoc)

   QUICK REFERENCE:
     Init module          → initComments(barangayId, uid, userName, role, parentCol?)
     Restore open threads → restoreOpenThreads()
     Build thread HTML    → buildCommentThread(postId, parentCol?)
     Toggle thread        → window.toggleComments(postId)
     Submit comment       → window.handleCommentSubmit(postId, parentCol)
     Submit reply         → window.handleReplySubmit(postId, commentId, parentCol, inputId?)
     Delete comment       → window.deleteComment(postId, commentId, parentCol)
     Like / unlike        → window.handleCommentLike(postId, commentId)
     Report comment       → window.reportComment(postId, commentId)
================================================ */


// ================================================
// IMPORTS
// ================================================

import { db }              from '../core/firebase-config.js';
import { sendNotification } from './notifications.js';

import { showConfirm } from '/js/shared/confirm-modal.js';

import {
  collection, addDoc, deleteDoc, getDocs,
  doc as _doc, onSnapshot, query, where, orderBy,
  serverTimestamp, increment, updateDoc, getDoc, setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";


// ================================================
// MODULE STATE
// ================================================

let _barangayId = null;
let _uid        = null;
let _userName   = 'Resident';
let _role       = 'resident';
let _parentCol  = 'announcements'; // default collection

const _listeners       = new Map(); // postId / reply-key → unsub fn
const _openThreads     = new Map(); // postId → parentCol
const _likedCommentIds = new Set();
const _openReplies     = new Map();

/*
   Local cache of comment IDs this user has already reported.
   Populated on successful submit AND on Firestore duplicate check.
   Prevents repeat reports within the same session without a round-trip.
*/
const _reportedCommentIds = new Set();

let _moderationSettings = null;


// ================================================
// MODERATION HELPERS
// ================================================

/* Fetches and caches barangay moderation settings from Firestore */
async function _getModerationSettings() {
  if (_moderationSettings) return _moderationSettings;
  try {
    const snap = await getDoc(_doc(db, 'barangays', _barangayId, 'meta', 'settings'));
    _moderationSettings = snap.exists() ? snap.data() : {};
  } catch {
    _moderationSettings = {};
  }
  return _moderationSettings;
}

/* Returns the first matching blocked word found in body, or null */
function _hasBlockedWord(body, blockedWords = []) {
  const lower = body.toLowerCase();
  return blockedWords.find(w => w && lower.includes(w.toLowerCase())) ?? null;
}


// ================================================
// INIT
// ================================================

/* Initializes module-level state; must be called after auth resolves */
export function initComments(barangayId, uid, userName, role, parentCol = 'announcements') {
  _barangayId         = barangayId;
  _parentCol          = parentCol;
  _uid                = uid;
  _userName           = userName || 'Resident';
  _role               = role     || 'resident';
  _moderationSettings = null;
}


// ================================================
// THREAD RESTORATION
// ================================================

/* Re-opens all tracked comment threads after a full DOM rebuild */
export function restoreOpenThreads() {
  _listeners.forEach(unsub => unsub());
  _listeners.clear();

  const gone = [];
  _openThreads.forEach((pCol, postId) => {
    const threadEl = document.getElementById(`comment-thread-${postId}`);
    if (!threadEl) { gone.push(postId); return; }
    threadEl.style.display = 'block';
    _subscribe(postId, pCol);
  });
  gone.forEach(id => _openThreads.delete(id));
}


// ================================================
// THREAD TOGGLE
// ================================================

/* Toggles a post's comment thread open or closed */
window.toggleComments = function (postId) {
  const threadEl = document.getElementById(`comment-thread-${postId}`);
  if (!threadEl) return;

  const isOpen = threadEl.style.display !== 'none' && threadEl.style.display !== '';

  if (isOpen) {
    threadEl.style.display = 'none';
    _openThreads.delete(postId);
    if (_listeners.has(postId)) {
      _listeners.get(postId)();
      _listeners.delete(postId);
    }
  } else {
    threadEl.style.display = 'block';
    const article = document.getElementById(`comment-thread-${postId}`)?.closest('article');
    const pCol    = article?.dataset.parentCol || 'announcements';
    _openThreads.set(postId, pCol);
    _subscribe(postId, pCol);
  }
};


// ================================================
// FIRESTORE SUBSCRIPTION
// ================================================

/* Subscribes to a post's comments subcollection and updates the DOM on change */
function _subscribe(postId, parentCol) {
  if (!_barangayId) return;

  const resolvedCol = parentCol || _parentCol;
  if (_listeners.has(postId)) { _listeners.get(postId)(); }

  const col = collection(db, 'barangays', _barangayId, resolvedCol, postId, 'comments');
  const q   = query(col, orderBy('createdAt', 'asc'));

  const unsub = onSnapshot(q, async snap => {
    const listEl = document.getElementById(`comment-list-${postId}`);
    if (!listEl) return;

    if (snap.empty) {
      listEl.innerHTML = `
        <p style="color:#9ca3af;font-size:.82rem;padding:.6rem 0;text-align:center;margin:0;">
          No comments yet — be the first!
        </p>`;
      return;
    }

    const topLevel = snap.docs.filter(d => !d.data().parentCommentId);

    /* Pre-fetch like state for all top-level comments */
    if (_uid) {
      await Promise.all(topLevel.map(async d => {
        try {
          const likeRef  = _doc(db, 'barangays', _barangayId, resolvedCol, postId, 'comments', d.id, 'likes', _uid);
          const likeSnap = await getDoc(likeRef);
          if (likeSnap.exists()) _likedCommentIds.add(d.id);
          else _likedCommentIds.delete(d.id);
        } catch { /* non-fatal */ }
      }));
    }

    /* Patch like counts in-place if the comment structure has not changed */
    const existingIds    = [...listEl.querySelectorAll('[data-comment-id]')].map(el => el.dataset.commentId);
    const newIds         = topLevel.map(d => d.id);
    const sameStructure  = existingIds.length === newIds.length && newIds.every((id, i) => id === existingIds[i]);

    if (sameStructure) {
      topLevel.forEach(d => {
        const countEl = document.getElementById(`clcount-${d.id}`);
        const btn     = document.getElementById(`clbtn-${d.id}`);
        if (countEl) countEl.textContent = d.data().likeCount ?? 0;
        if (btn) {
          const liked = _likedCommentIds.has(d.id);
          btn.style.color = liked ? 'var(--red)' : 'var(--gray-200)';
          const svg = btn.querySelector('svg');
          if (svg) svg.style.fill = liked ? 'var(--red)' : 'none';
        }
      });
      return;
    }

    /* Full re-render */
    listEl.innerHTML = topLevel.map(d => _buildRow(d.id, d.data(), postId, resolvedCol)).join('');
    lucide.createIcons({ el: listEl });

    topLevel.forEach(d => _loadReplyCount(postId, d.id, resolvedCol));

    /* Re-open any reply threads that were open before re-render */
    _openReplies.forEach(({ postId: rPostId, parentCol: rCol }, cid) => {
      const thread = document.getElementById(`reply-thread-${cid}`);
      if (thread) {
        thread.style.display    = 'block';
        thread.dataset.loaded    = '1';
        thread.dataset.postId    = rPostId;
        thread.dataset.parentCol = rCol;
        _loadReplies(rPostId, cid, rCol);
      }
    });
  });

  _listeners.set(postId, unsub);
}


// ================================================
// BUILD — Comment Row
// ================================================

/* Returns the HTML string for a single top-level comment row */
function _buildRow(commentId, data, postId, parentCol) {
  const isOwner  = data.authorId === _uid;
  const canDel   = isOwner || _role === 'admin' || _role === 'officer';
  const time     = _relTime(data.createdAt);
  const initials = String(data.authorName ?? 'U').slice(0, 2).toUpperCase();
  const pCol     = _esc(parentCol || _parentCol);

  return `
    <div data-comment-id="${_esc(commentId)}" style="padding:.5rem 0;border-bottom:1px solid #f3f4f6;">

      <!-- Top row: avatar · content · action buttons -->
      <div style="display:flex;gap:.55rem;align-items:flex-start;">

        <div style="width:24px;height:24px;border-radius:50%;background:#e5e7eb;
          display:flex;align-items:center;justify-content:center;
          flex-shrink:0;font-size:.58rem;font-weight:700;color:#6b7280;margin-top:1px;">
          ${_esc(initials)}
        </div>

        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:.35rem;margin-bottom:2px;flex-wrap:wrap;">
            <span style="font-size:.78rem;font-weight:700;color:#374151;">${_esc(data.authorName ?? 'Resident')}</span>
            <span style="font-size:.68rem;color:#9ca3af;">${time}</span>
          </div>
          <p style="font-size:.82rem;color:#4b5563;margin:0;line-height:1.4;word-break:break-word;">${_esc(data.body)}</p>
        </div>

      </div><!-- /top row -->

      <!-- Reply controls (indented under the comment text) -->
      <div style="margin-left:32px;margin-top:4px;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;">

        <!-- "N replies" toggle — hidden until there are replies -->
        <button
          id="reply-view-btn-${_esc(commentId)}"
          onclick="window.loadAndToggleReplies('${_esc(postId)}','${_esc(commentId)}','${pCol}')"
          style="display:none;background:none;border:none;cursor:pointer;font-size:.72rem;
            color:#6b7280;padding:0;transition:color .15s;"
          onmouseover="this.style.color='#374151'"
          onmouseout="this.style.color='#6b7280'">
          <span id="reply-count-label-${_esc(commentId)}"></span>
        </button>

        <!-- "Reply" action button — always visible -->
        <button
          onclick="window.toggleReplyBox('${_esc(postId)}','${_esc(commentId)}','${pCol}')"
          style="background:none;border:none;cursor:pointer;font-size:.72rem;
            color:#9ca3af;padding:0;transition:color .15s;"
          onmouseover="this.style.color='#374151'"
          onmouseout="this.style.color='#9ca3af'">
          Reply
        </button>

        <!-- Like button -->
        <button onclick="handleCommentLike('${_esc(postId)}','${_esc(commentId)}')"
          id="clbtn-${_esc(commentId)}"
          style="background:none;border:none;cursor:pointer;
            display:flex;align-items:center;gap:3px;
            color:${_likedCommentIds.has(commentId) ? 'var(--red)' : 'var(--gray-200)'};
            font-size:.7rem;padding:2px;transition:color .15s;">
          <i data-lucide="heart" style="width:12px;height:12px;pointer-events:none;
            fill:${_likedCommentIds.has(commentId) ? 'var(--red)' : 'none'};"></i>
          <span id="clcount-${_esc(commentId)}">${data.likeCount ?? 0}</span>
        </button>

        ${canDel ? `
        <button onclick="deleteComment('${_esc(postId)}','${_esc(commentId)}','${pCol}')"
          style="background:none;border:none;cursor:pointer;
            color:#d1d5db;padding:2px;border-radius:4px;transition:color .15s;"
          onmouseover="this.style.color='#ef4444'"
          onmouseout="this.style.color='#d1d5db'"
          title="Delete comment">
          <i data-lucide="trash-2" style="width:13px;height:13px;pointer-events:none;"></i>
        </button>` : ''}

        ${_uid && data.authorId !== _uid && _role !== 'admin' && _role !== 'officer' ? `
        <button onclick="reportComment('${_esc(postId)}','${_esc(commentId)}')"
          style="background:none;border:none;cursor:pointer;color:#d1d5db;
            padding:2px;transition:color .15s;"
          onmouseover="this.style.color='#ef4444'"
          onmouseout="this.style.color='#d1d5db'"
          title="Report comment">
          <i data-lucide="flag" style="width:12px;height:12px;pointer-events:none;"></i>
        </button>` : ''}

      </div>

      <!-- Expanded reply thread (shown when "N replies" is clicked) -->
      <div id="reply-thread-${_esc(commentId)}"
        style="margin-left:32px;margin-top:.3rem;display:none;"></div>

      <!-- Reply input box (shown when "Reply" is clicked) -->
      <div id="reply-box-${_esc(commentId)}"
        style="display:none;margin-left:32px;margin-top:.4rem;">
        <div style="display:flex;gap:.4rem;align-items:center;">
          <input id="reply-input-${_esc(commentId)}"
            type="text" placeholder="Write a reply…" maxlength="300"
            style="flex:1;padding:.35rem .6rem;border:1.5px solid #e5e7eb;
              border-radius:8px;font-size:.78rem;outline:none;background:#fafafa;"
            onkeydown="if(event.key==='Enter'){event.preventDefault();
              window.handleReplySubmit('${_esc(postId)}','${_esc(commentId)}','${pCol}');}" />
          <button
            onclick="window.handleReplySubmit('${_esc(postId)}','${_esc(commentId)}','${pCol}')"
            style="width:26px;height:26px;border-radius:7px;background:#1a3a1a;
              color:#fff;border:none;cursor:pointer;display:flex;
              align-items:center;justify-content:center;flex-shrink:0;">
            <i data-lucide="send" style="width:11px;height:11px;pointer-events:none;"></i>
          </button>
        </div>
      </div>

    </div>`;
}


// ================================================
// BUILD — Thread Container
// ================================================

/* Returns the thread container HTML injected inside each post row */
export function buildCommentThread(postId, parentCol = 'announcements') {
  const pid = _esc(postId);

  return `
    <div id="comment-thread-${pid}"
      style="display:none;margin-top:.75rem;padding-top:.75rem;
        border-top:1px solid #f0f0f0;">
      <div id="comment-list-${pid}"
        style="max-height:220px;overflow-y:auto;margin-bottom:.65rem;
          padding-right:.1rem;"></div>
      <div style="display:flex;gap:.4rem;align-items:center;">
        <input id="comment-input-${pid}"
          type="text" placeholder="Write a comment…" maxlength="300"
          style="flex:1;padding:.4rem .65rem;border:1.5px solid #e5e7eb;border-radius:8px;
            font-size:.82rem;outline:none;background:#fafafa;
            transition:border-color .15s,background .15s;"
          onfocus="this.style.borderColor='#9ca3af';this.style.background='#fff'"
          onblur="this.style.borderColor='#e5e7eb';this.style.background='#fafafa'"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window.handleCommentSubmit('${pid}','${parentCol}');}" />
        <button id="comment-submit-${pid}"
          onclick="window.handleCommentSubmit('${pid}','${parentCol}')"
          style="display:inline-flex;align-items:center;justify-content:center;
            width:30px;height:30px;flex-shrink:0;border-radius:8px;
            background:#1a3a1a;color:#fff;border:none;cursor:pointer;
            transition:background .15s;"
          onmouseover="this.style.background='#14291a'"
          onmouseout="this.style.background='#1a3a1a'"
          title="Post comment">
          <i data-lucide="send" style="width:13px;height:13px;pointer-events:none;"></i>
        </button>
      </div>
    </div>`;
}


// ================================================
// REPLY COUNT
// ================================================

/* Subscribes to reply count for a comment and shows/hides the view-replies button */
function _loadReplyCount(postId, commentId, parentCol) {
  const resolvedCol = parentCol || _parentCol;
  const col = collection(db, 'barangays', _barangayId, resolvedCol, postId, 'comments');
  const q   = query(col, where('parentCommentId', '==', commentId));

  onSnapshot(q, snap => {
    const n       = snap.size;
    const label   = document.getElementById(`reply-count-label-${commentId}`);
    const viewBtn = document.getElementById(`reply-view-btn-${commentId}`);
    if (viewBtn) viewBtn.style.display = n > 0 ? 'inline' : 'none';
    if (label)   label.textContent     = `${n} ${n === 1 ? 'reply' : 'replies'}`;
  });
}


// ================================================
// REPLY THREAD TOGGLE
// ================================================

/* Expands or collapses a reply thread under a comment */
window.loadAndToggleReplies = function (postId, commentId, parentCol) {
  const thread = document.getElementById(`reply-thread-${commentId}`);
  if (!thread) return;

  const isOpen = thread.style.display !== 'none' && thread.dataset.loaded === '1';
  if (isOpen) {
    thread.style.display = 'none';
    _openReplies.delete(commentId);
  } else {
    thread.style.display    = 'block';
    thread.dataset.loaded    = '1';
    thread.dataset.postId    = postId;
    thread.dataset.parentCol = parentCol;
    _openReplies.set(commentId, { postId, parentCol });
    _loadReplies(postId, commentId, parentCol);
  }
};


// ================================================
// REPLY INPUT BOX TOGGLE
// ================================================

/* Toggles the reply input box and expands the reply thread for context */
window.toggleReplyBox = function (postId, commentId, parentCol) {
  const box = document.getElementById(`reply-box-${commentId}`);
  if (!box) return;

  const isOpen      = box.style.display !== 'none';
  box.style.display = isOpen ? 'none' : 'flex';

  if (!isOpen) {
    document.getElementById(`reply-input-${commentId}`)?.focus();

    /* Also expand the reply thread so existing replies are visible while typing */
    const replyThread = document.getElementById(`reply-thread-${commentId}`);
    if (replyThread) {
      replyThread.style.display    = 'block';
      replyThread.dataset.loaded    = '1';
      replyThread.dataset.postId    = postId;
      replyThread.dataset.parentCol = parentCol;
      _openReplies.set(commentId, { postId, parentCol });
    }
    _loadReplies(postId, commentId, parentCol);
  }
};


// ================================================
// LOAD — Replies Subcollection
// ================================================

/* Subscribes to and renders replies under a given comment */
function _loadReplies(postId, commentId, parentCol) {
  const threadEl = document.getElementById(`reply-thread-${commentId}`);
  if (!threadEl) return;

  const resolvedCol = parentCol || _parentCol;
  const col = collection(db, 'barangays', _barangayId, resolvedCol, postId, 'comments');
  const q   = query(col, where('parentCommentId', '==', commentId), orderBy('createdAt', 'asc'));

  const key = `reply-${postId}-${commentId}`;
  if (_listeners.has(key)) { _listeners.get(key)(); }

  const unsub = onSnapshot(q, async snap => {
    const replies = snap.docs
      .filter(d => d.data().parentCommentId === commentId)
      .map(d => ({ id: d.id, ...d.data() }));

    /* Pre-fetch like state for all replies */
    if (_uid && replies.length) {
      await Promise.all(replies.map(async r => {
        try {
          const likeRef  = _doc(db, 'barangays', _barangayId, resolvedCol, postId, 'comments', r.id, 'likes', _uid);
          const likeSnap = await getDoc(likeRef);
          if (likeSnap.exists()) _likedCommentIds.add(r.id);
          else _likedCommentIds.delete(r.id);
        } catch { /* non-fatal */ }
      }));
    }

    if (!replies.length) {
      threadEl.innerHTML = '';
      return;
    }

    const rCol = _esc(resolvedCol);

    threadEl.innerHTML = replies.map(r => {
      const canDel   = r.authorId === _uid || _role === 'admin' || _role === 'officer';
      const initials = _esc(String(r.authorName ?? 'U').slice(0, 2).toUpperCase());
      const rid      = _esc(r.id);

      return `
      <div style="padding:.35rem 0 .35rem .6rem;
        border-left:2px solid #e5e7eb;margin-bottom:.2rem;">

        <div style="display:flex;gap:.45rem;align-items:flex-start;">
          <div style="width:20px;height:20px;border-radius:50%;background:#e5e7eb;
            display:flex;align-items:center;justify-content:center;
            flex-shrink:0;font-size:.5rem;font-weight:700;color:#6b7280;">
            ${initials}
          </div>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:.3rem;flex-wrap:wrap;">
              <span style="font-size:.75rem;font-weight:700;color:#374151;">
                ${_esc(r.authorName ?? 'Resident')}
              </span>
              <span style="font-size:.65rem;color:#9ca3af;">${_relTime(r.createdAt)}</span>
            </div>
            <p style="font-size:.78rem;color:#4b5563;margin:2px 0 0;
              line-height:1.4;word-break:break-word;">${_esc(r.body)}</p>
          </div>
        </div>

        <div style="margin-left:25px;margin-top:4px;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;">

          <button onclick="handleCommentLike('${_esc(postId)}','${rid}')"
            id="clbtn-${rid}"
            style="background:none;border:none;cursor:pointer;
              display:flex;align-items:center;gap:3px;
              color:${_likedCommentIds.has(r.id) ? 'var(--red)' : 'var(--gray-200)'};
              font-size:.7rem;padding:2px;transition:color .15s;">
            <i data-lucide="heart" style="width:12px;height:12px;pointer-events:none;
              fill:${_likedCommentIds.has(r.id) ? 'var(--red)' : 'none'};"></i>
            <span id="clcount-${rid}">${r.likeCount ?? 0}</span>
          </button>

          <button
            id="reply-view-btn-${rid}"
            onclick="window.loadAndToggleReplies('${_esc(postId)}','${rid}','${rCol}')"
            style="display:none;background:none;border:none;cursor:pointer;font-size:.72rem;
              color:#6b7280;padding:0;transition:color .15s;"
            onmouseover="this.style.color='#374151'"
            onmouseout="this.style.color='#6b7280'">
            <span id="reply-count-label-${rid}"></span>
          </button>

          <button
            onclick="window.toggleReplyBox('${_esc(postId)}','${rid}','${rCol}')"
            style="background:none;border:none;cursor:pointer;font-size:.72rem;
              color:#9ca3af;padding:0;transition:color .15s;"
            onmouseover="this.style.color='#374151'"
            onmouseout="this.style.color='#9ca3af'">
            Reply
          </button>

          ${canDel ? `
          <button onclick="deleteComment('${_esc(postId)}','${rid}','${rCol}')"
            style="background:none;border:none;cursor:pointer;
              color:#d1d5db;padding:2px;border-radius:4px;transition:color .15s;"
            onmouseover="this.style.color='#ef4444'"
            onmouseout="this.style.color='#d1d5db'"
            title="Delete reply">
            <i data-lucide="trash-2" style="width:13px;height:13px;pointer-events:none;"></i>
          </button>` : ''}

          ${_uid && r.authorId !== _uid && _role !== 'admin' && _role !== 'officer' ? `
          <button onclick="reportComment('${_esc(postId)}','${rid}')"
            style="background:none;border:none;cursor:pointer;color:#d1d5db;
              padding:2px;transition:color .15s;"
            onmouseover="this.style.color='#ef4444'"
            onmouseout="this.style.color='#d1d5db'"
            title="Report comment">
            <i data-lucide="flag" style="width:12px;height:12px;pointer-events:none;"></i>
          </button>` : ''}

        </div>

        <div id="reply-box-${rid}"
          style="display:none;margin-left:29px;margin-top:.4rem;">
          <div style="display:flex;gap:.4rem;align-items:center;">
            <input id="reply-input-${rid}"
              type="text" placeholder="Write a reply…" maxlength="300"
              style="flex:1;padding:.35rem .6rem;border:1.5px solid #e5e7eb;
                border-radius:8px;font-size:.78rem;outline:none;background:#fafafa;"
              onkeydown="if(event.key==='Enter'){event.preventDefault();
                window.handleReplySubmit('${_esc(postId)}','${rid}','${rCol}');}" />
            <button
              onclick="window.handleReplySubmit('${_esc(postId)}','${rid}','${rCol}')"
              style="width:26px;height:26px;border-radius:7px;background:#1a3a1a;
                color:#fff;border:none;cursor:pointer;display:flex;
                align-items:center;justify-content:center;flex-shrink:0;">
              <i data-lucide="send" style="width:11px;height:11px;pointer-events:none;"></i>
            </button>
          </div>
        </div>

        <div id="reply-thread-${rid}"
          style="margin-left:29px;margin-top:.3rem;display:none;"></div>

      </div>`;
    }).join('');

    lucide.createIcons({ el: threadEl });

    replies.forEach(r => {
      _loadReplyCount(postId, r.id, resolvedCol);
      if (_openReplies.has(r.id)) {
        const thread = document.getElementById(`reply-thread-${r.id}`);
        if (thread) {
          thread.style.display    = 'block';
          thread.dataset.loaded    = '1';
          thread.dataset.postId    = postId;
          thread.dataset.parentCol = resolvedCol;
          _loadReplies(postId, r.id, resolvedCol);
        }
      }
    });
  });

  _listeners.set(key, unsub);
}


// ================================================
// ACTIONS — Submit Comment
// ================================================

/* Validates and writes a new top-level comment to Firestore */
window.handleCommentSubmit = async function (postId, parentCol) {
  if (!_uid || !_barangayId) return;

  const col       = parentCol || _parentCol;
  const inputEl   = document.getElementById(`comment-input-${postId}`);
  const submitBtn = document.getElementById(`comment-submit-${postId}`);
  const body      = inputEl?.value.trim();
  if (!body) return;

  if (submitBtn) submitBtn.disabled = true;

  try {
    const annoRef = _doc(db, 'barangays', _barangayId, col, postId);
    const comCol  = collection(db, 'barangays', _barangayId, col, postId, 'comments');

    /* Profanity check via PurgoMalum — fail-open if API is unavailable */
    try {
      const pRes = await fetch(
        `https://www.purgomalum.com/service/containsprofanity?text=${encodeURIComponent(body)}`,
        { signal: AbortSignal.timeout(3000) }
      );
      if ((await pRes.text()).trim() === 'true') {
        if (inputEl) inputEl.style.borderColor = '#dc2626';
        setTimeout(() => { if (inputEl) inputEl.style.borderColor = ''; }, 2000);
        if (submitBtn) submitBtn.disabled = false;
        return;
      }
    } catch { /* API unavailable — allow through */ }

    /* Admin blocked-word check */
    const settings   = await _getModerationSettings();
    const blockedHit = _hasBlockedWord(body, settings.blockedWords ?? []);
    if (blockedHit) {
      if (inputEl) {
        inputEl.style.borderColor = '#dc2626';
        setTimeout(() => { inputEl.style.borderColor = ''; }, 2000);
      }
      if (submitBtn) submitBtn.disabled = false;
      return;
    }

    const commentRef = await addDoc(comCol, {
      body,
      authorId:   _uid,
      authorName: _userName,
      createdAt:  serverTimestamp(),
      likeCount:  0,
    });
    await updateDoc(annoRef, { commentCount: increment(1) });

    /* Notify the post author */
    const postSnap = await getDoc(annoRef);
    const postData = postSnap.data();
    if (postData?.authorId) {
      try {
        await sendNotification(_barangayId, postData.authorId, {
          type:      'comment',
          actorId:   _uid,
          actorName: _userName,
          postId,
          postTitle: postData.title ?? 'a post',
          commentId: commentRef.id,
        });
      } catch (notifErr) {
        console.error('[notif] FAILED:', notifErr.code, notifErr.message);
      }
    }

    if (inputEl) inputEl.value = '';
  } catch (err) {
    console.error('[comments] submit error:', err);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
};


// ================================================
// ACTIONS — Submit Reply
// ================================================

/* Validates and writes a new reply to Firestore; notifies the parent comment's author */
window.handleReplySubmit = async function (postId, commentId, parentCol, inputId) {
  if (!_uid || !_barangayId) return;

  const resolvedCol = parentCol || _parentCol;
  const inputEl     = document.getElementById(`reply-input-${inputId || commentId}`);
  const body        = inputEl?.value.trim();
  if (!body) return;

  /* Admin blocked-word check */
  const settings   = await _getModerationSettings();
  const blockedHit = _hasBlockedWord(body, settings.blockedWords ?? []);
  if (blockedHit) {
    if (inputEl) {
      inputEl.style.borderColor = '#dc2626';
      setTimeout(() => { inputEl.style.borderColor = ''; }, 2000);
    }
    return;
  }

  const { addDoc: _add, collection: _col, serverTimestamp: _ts } =
    await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

  try {
    const comCol   = _col(db, 'barangays', _barangayId, resolvedCol, postId, 'comments');
    const replyRef = await _add(comCol, {
      body,
      authorId:        _uid,
      authorName:      _userName,
      parentCommentId: commentId,
      createdAt:       _ts(),
      likeCount:       0,
    });

    /* Notify the parent comment's author */
    const parentRef  = _doc(db, 'barangays', _barangayId, resolvedCol, postId, 'comments', commentId);
    const parentSnap = await (await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js")).getDoc(parentRef);
    const parentData = parentSnap.data();

    const postRef  = _doc(db, 'barangays', _barangayId, resolvedCol, postId);
    const postSnap = await getDoc(postRef);

    if (parentData?.authorId) {
      await sendNotification(_barangayId, parentData.authorId, {
        type:      'reply',
        actorId:   _uid,
        actorName: _userName,
        postId,
        postTitle: postSnap.data()?.title ?? 'a post',
        commentId: replyRef.id,
      });
    }

    if (inputEl) inputEl.value = '';
  } catch (err) {
    console.error('[comments] reply error:', err);
  }
};


// ================================================
// ACTIONS — Delete Comment
// ================================================

/* Deletes a comment from Firestore and decrements the post's commentCount */
window.deleteComment = async function (postId, commentId, parentCol) {
  if (!_barangayId) return;
  const ok = await showConfirm({ title: 'Delete Comment?', body: 'This comment and all its replies will be permanently removed.', confirm: 'Delete', cancel: 'Go Back', variant: 'danger' });
if (!ok) return;

  const resolvedCol = parentCol || _parentCol;
  try {
    const annoRef = _doc(db, 'barangays', _barangayId, resolvedCol, postId);
    const comRef  = _doc(db, 'barangays', _barangayId, resolvedCol, postId, 'comments', commentId);
    await deleteDoc(comRef);
    await updateDoc(annoRef, { commentCount: increment(-1) });
    _showCommentReportToast('Comment deleted.', 'error');
  } catch (err) {
    console.error('[comments] delete error:', err);
    _showCommentReportToast('Could not delete comment. Try again.', 'error');
  }
};


// ================================================
// ACTIONS — Like / Unlike Comment
// ================================================

/* Toggles a like on a comment; sends a milestone notification at 10 likes */
window.handleCommentLike = async function (postId, commentId) {
  if (!_uid || !_barangayId) return;

  const btn     = document.getElementById(`clbtn-${commentId}`);
  const countEl = document.getElementById(`clcount-${commentId}`);
  if (btn) btn.disabled = true;

  const isCPost = !!document.querySelector(`[id="comment-thread-${postId}"]`)
    ?.closest('article[data-parent-col="communityPosts"]');
  const col     = isCPost ? 'communityPosts' : 'announcements';
  const comRef  = _doc(db, 'barangays', _barangayId, col, postId, 'comments', commentId);
  const likeRef = _doc(db, 'barangays', _barangayId, col, postId, 'comments', commentId, 'likes', _uid);

  try {
    const likeSnap = await getDoc(likeRef);
    const isLiked  = likeSnap.exists();
    const current  = parseInt(countEl?.textContent ?? '0', 10) || 0;

    if (isLiked) {
      _likedCommentIds.delete(commentId);
      if (countEl) countEl.textContent = Math.max(0, current - 1);
      if (btn) {
        btn.style.color = 'var(--gray-200)';
        const _sv = btn.querySelector('svg');
        if (_sv) _sv.style.fill = 'none';
      }
      await deleteDoc(likeRef);
      await updateDoc(comRef, { likeCount: increment(-1) });
    } else {
      _likedCommentIds.add(commentId);
      if (countEl) countEl.textContent = current + 1;
      if (btn) {
        btn.style.color = 'var(--red)';
        const _sv = btn.querySelector('svg');
        if (_sv) _sv.style.fill = 'var(--red)';
      }
      await setDoc(likeRef, { uid: _uid, createdAt: serverTimestamp() });
      await updateDoc(comRef, { likeCount: increment(1) });

      /* Notify author at 10-like milestone */
      if (current + 1 === 10) {
        const comSnap  = await getDoc(comRef);
        const comData  = comSnap.data();
        const postRef  = _doc(db, 'barangays', _barangayId, col, postId);
        const postSnap = await getDoc(postRef);
        if (comData?.authorId) {
          await sendNotification(_barangayId, comData.authorId, {
            type:      'like',
            actorId:   _uid,
            actorName: _userName,
            postId,
            postTitle: postSnap.data()?.title ?? 'a post',
            commentId,
          });
        }
      }
    }
  } catch (err) {
    console.error('[comments] like error:', err);
  } finally {
    if (btn) btn.disabled = false;
  }
};


// ================================================
// ACTIONS — Report Comment
// ================================================

/*
   Multi-stage report flow:
     1. Fast local cache check (no network)
     2. Firestore duplicate check (catches previous sessions)
     3. Daily report limit check against barangay settings
     4. Injects and displays a modal (once per page load)
     5. On submit: final Firestore guard + write + cache + toast
*/
window.reportComment = async function (postId, commentId) {
  if (!_uid || !_barangayId) return;

  // ── 1. Fast local cache check ─────────────────────────────────
  if (_reportedCommentIds.has(commentId)) {
    _showCommentReportToast('You already reported this comment.');
    return;
  }

  // ── 2. Firestore duplicate check ──────────────────────────────
  try {
    const existingSnap = await getDocs(
      query(
        collection(db, 'barangays', _barangayId, 'reportedComments'),
        where('reportedBy', '==', _uid),
        where('commentId', '==', commentId),
      )
    );
    if (!existingSnap.empty) {
      _reportedCommentIds.add(commentId);
      _showCommentReportToast('You already reported this comment.');
      return;
    }
  } catch { /* non-fatal, fall through */ }

  // ── 3. Daily limit check ──────────────────────────────────────
  if (_role !== 'admin' && _role !== 'officer') {
    try {
      const settingsSnap = await getDoc(_doc(db, 'barangays', _barangayId, 'meta', 'settings'));
      const dailyLimit   = settingsSnap.exists()
        ? (settingsSnap.data().dailyCommentReportLimit ?? 5) : 5;

      const today = new Date().toISOString().slice(0, 10);
      const start = new Date(today + 'T00:00:00');
      const end   = new Date(today + 'T23:59:59');
      const rSnap = await getDocs(
        query(
          collection(db, 'barangays', _barangayId, 'reportedComments'),
          where('reportedBy', '==', _uid),
        )
      );
      const todayCount = rSnap.docs.filter(d => {
        const t = d.data().createdAt?.toDate?.() ?? null;
        return t ? t >= start && t <= end : true;
      }).length;

      if (todayCount >= dailyLimit) {
        _showCommentReportToast(
          `You've reached the comment report limit of ${dailyLimit} per day.`
        );
        return;
      }
    } catch { /* non-fatal */ }
  }

  // ── 4. Inject modal once per page load ────────────────────────
  if (!document.getElementById('reportCommentModal')) {
    const m   = document.createElement('div');
    m.id      = 'reportCommentModal';
    m.style.cssText = `display:none;position:fixed;inset:0;
      background:var(--overlay-black-55);backdrop-filter:blur(4px);
      z-index:3000;align-items:center;justify-content:center;padding:var(--space-md);`;
    m.onclick = e => { if (e.target === m) m.style.display = 'none'; };
    m.innerHTML = `
      <div class="modal">
        <div style="display:flex;justify-content:space-between;align-items:center;
          padding:var(--space-lg) var(--space-xl) var(--space-md);">
          <h3 style="margin:0;font-family:var(--font-display);font-size:var(--text-lg);
            font-weight:var(--fw-bold);color:var(--text-dark);">Report Comment</h3>
          <button onclick="document.getElementById('reportCommentModal').style.display='none'"
            class="btn btn--close btn--sm" aria-label="Close">
            <i data-lucide="x"></i>
          </button>
        </div>
        <div class="modal__body">
          <div class="form-group">
            <label class="form-label">Reason</label>
            <select id="reportCommentCategory" class="form-select">
              <option value="spam">Spam</option>
              <option value="harassment">Harassment</option>
              <option value="hate_speech">Hate Speech</option>
              <option value="misinformation">Misinformation</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" style="font-size:var(--text-base-sm);">
              Additional details
              <span style="color:var(--gray-400);font-weight:var(--fw-normal);">(optional)</span>
            </label>
            <textarea id="reportCommentDescription" class="form-input" rows="3" maxlength="200"
              placeholder="Describe the issue…" style="resize:vertical;"></textarea>
          </div>
        </div>
        <div class="modal__footer">
          <button onclick="document.getElementById('reportCommentModal').style.display='none'"
            class="btn btn--outline btn--sm">Cancel</button>
          <button id="reportCommentSubmitBtn" class="btn btn--red btn--sm">
            Submit Report
          </button>
        </div>
      </div>`;
    document.body.appendChild(m);
    lucide.createIcons({ el: m });
  }

  // ── 5. Attach context and a fresh submit handler ──────────────
  const modal = document.getElementById('reportCommentModal');
  modal.dataset.postId    = postId;
  modal.dataset.commentId = commentId;

  /* Clone to strip any stale event listeners from a previous open */
  const oldBtn   = document.getElementById('reportCommentSubmitBtn');
  const freshBtn = oldBtn.cloneNode(true);
  oldBtn.replaceWith(freshBtn);

  freshBtn.addEventListener('click', async () => {
    const cid = modal.dataset.commentId;
    const pid = modal.dataset.postId;

    /* Guard against fast double-click */
    if (_reportedCommentIds.has(cid)) {
      modal.style.display = 'none';
      _showCommentReportToast('You already reported this comment.');
      return;
    }

    const category = document.getElementById('reportCommentCategory').value;
    const desc     = document.getElementById('reportCommentDescription').value.trim();

    freshBtn.disabled    = true;
    freshBtn.textContent = 'Submitting…';

    try {
      /* Final Firestore duplicate guard before writing */
      const dupeSnap = await getDocs(
        query(
          collection(db, 'barangays', _barangayId, 'reportedComments'),
          where('reportedBy', '==', _uid),
          where('commentId', '==', cid),
        )
      );
      if (!dupeSnap.empty) {
        _reportedCommentIds.add(cid);
        modal.style.display = 'none';
        _showCommentReportToast('You already reported this comment.');
        return;
      }

      await addDoc(
        collection(db, 'barangays', _barangayId, 'reportedComments'),
        {
          postId:         pid,
          commentId:      cid,
          reportedBy:     _uid,
          reportedByName: _userName,
          reason:         category,
          details:        desc || null,
          status:         'pending',
          createdAt:      serverTimestamp(),
        }
      );

      /* Cache so repeat clicks in this session are instant-blocked */
      _reportedCommentIds.add(cid);

      modal.style.display = 'none';
      document.getElementById('reportCommentDescription').value = '';
      _showCommentReportToast('Report submitted. Thank you.', 'success');

    } catch (err) {
      console.error('[reportComment]', err);
      _showCommentReportToast('Failed to submit report. Try again.', 'error');
    } finally {
      freshBtn.disabled    = false;
      freshBtn.textContent = 'Submit Report';
    }
  });

  modal.style.display = 'flex';
};


// ================================================
// UTILITIES — Toast
// ================================================

/* Appends a transient toast for report feedback; auto-removes after 3.5s */
function _showCommentReportToast(msg, type = 'info') {
  let container = document.getElementById('bulletinToastContainer')
    ?? document.getElementById('toastContainer');

  if (!container) {
    container    = document.createElement('div');
    container.id = 'commentReportToastContainer';
    container.style.cssText = `position:fixed;bottom:1.5rem;right:1.5rem;
      display:flex;flex-direction:column;gap:.5rem;z-index:4000;`;
    document.body.appendChild(container);
  }

  const bg = type === 'error'   ? '#9b1c1c'
           : type === 'success' ? '#1a3a1a'
           : '#374151';

  const t = document.createElement('div');
  t.style.cssText = `display:flex;align-items:center;gap:.6rem;background:${bg};color:#fff;
    padding:.75rem 1.1rem;border-radius:10px;font-size:.875rem;font-weight:500;
    box-shadow:0 4px 16px rgba(0,0,0,.2);animation:toastIn .25s ease both;`;
  t.textContent = msg;

  container.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}


// ================================================
// UTILITIES — Escape / Relative Time
// ================================================

/* HTML-escapes a value for safe use in innerHTML interpolation */
function _esc(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

/* Returns a human-readable relative timestamp from a Firestore Timestamp */
function _relTime(ts) {
  if (!ts?.toDate) return '';
  const d  = Date.now() - ts.toDate().getTime();
  const m  = Math.floor(d / 60_000);
  const h  = Math.floor(d / 3_600_000);
  const dy = Math.floor(d / 86_400_000);
  if (m  <  1) return 'just now';
  if (m  < 60) return `${m}m ago`;
  if (h  < 24) return `${h}h ago`;
  if (dy <  2) return 'yesterday';
  return ts.toDate().toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}
