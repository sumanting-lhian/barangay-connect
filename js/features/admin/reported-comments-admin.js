/* ================================================
   reported-comments-admin.js — BarangayConnect
   Admin panel module for reviewing user-reported
   comments. Subscribes to pending reports in real
   time and renders a moderation list with dismiss
   and delete actions. Restricted to admin and
   officer roles.

   Firestore path:
     barangays/{barangayId}/reportedComments/{id}

   WHAT IS IN HERE:
     · Auth-gated initialization with role check
     · Real-time subscription to pending reports
     · Badge count update on the admin nav
     · Report list renderer with enriched comment/post data
     · Dismiss report action (status → dismissed)
     · Delete comment action with commentCount decrement
       and report status update (status → actioned)

   WHAT IS NOT IN HERE:
     · Comment thread UI              → comments.js
     · Community post moderation      → community-posts-admin.js
     · Admin panel layout and styles  → admin.css
     · Firebase config                → firebase-config.js
     · Firestore path helpers         → db-paths.js

   REQUIRED IMPORTS:
     · ../../core/firebase-config.js           (auth, db)
     · ../../core/db-paths.js                  (userIndexDoc, barangayId)
     · firebase-firestore.js@10.12.0  (collection, onSnapshot, query,
                                       where, orderBy, doc, updateDoc,
                                       deleteDoc, getDoc, serverTimestamp,
                                       increment)
     · firebase-auth.js@10.12.0       (onAuthStateChanged)
     · Lucide Icons                   — loaded before this script

   QUICK REFERENCE:
     Init              → onAuthStateChanged (auto-runs on import)
     Dismiss report    → window.dismissCommentReport(reportId)
     Delete comment    → window.deleteReportedComment(reportId, postId, commentId)
     Badge element     → #reportedCommentsBadge
     List element      → #reportedCommentsList
================================================ */


/* ================================================
   IMPORTS
================================================ */

import { auth, db } from '../../core/firebase-config.js';
import { userIndexDoc, barangayId as toBid } from '../../core/db-paths.js';

import {
  collection, onSnapshot, query, where, orderBy,
  doc, updateDoc, deleteDoc, getDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import { showConfirm } from '/js/shared/confirm-modal.js';


/* ================================================
   MODULE STATE
================================================ */

let _bid = null;


/* ================================================
   INIT — auth-gated, role-restricted
   Resolves the barangay ID then subscribes to
   pending reported comments. Admin and officer
   roles only; all others are silently ignored.
================================================ */

onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  const snap = await getDoc(userIndexDoc(user.uid));
  if (!snap.exists()) return;

  const { barangay, role } = snap.data();
  if (role !== 'admin' && role !== 'officer') return;

  _bid = toBid(barangay);

  const q = query(
    collection(db, 'barangays', _bid, 'reportedComments'),
    where('status', '==', 'pending'),
    orderBy('createdAt', 'desc'),
  );

  onSnapshot(q, snap => {
    const reports = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    /* Update nav badge count */
    const badge = document.getElementById('reportedCommentsBadge');
    if (badge) {
      badge.textContent   = reports.length;
      badge.style.display = reports.length ? 'inline' : 'none';
      badge.style.background = 'rgba(0,0,0,0.12)';
      badge.style.color      = '#374151';
    }

    renderReportedComments(reports);
  });
});


/* ================================================
   RENDER
   Fetches comment body and post title for each
   report in parallel, then renders the full list.
   Checks both communityPosts and announcements
   collections as the comment may belong to either.
================================================ */

async function renderReportedComments(reports) {
  const el = document.getElementById('reportedCommentsList');
  if (!el) return;

  if (!reports.length) {
    el.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:3rem;text-align:center;
        color:#aaa;box-shadow:0 1px 4px rgba(0,0,0,.07);">
        <div style="font-size:2rem;margin-bottom:.5rem;">💬</div>
        <p style="margin:0;font-size:.9rem;">No reported comments.</p>
      </div>`;
    return;
  }

  /* Enrich each report with its comment body and parent post title */
  const enriched = await Promise.all(reports.map(async r => {
    let commentBody = '(comment not found)';
    let postTitle   = '(post not found)';

    for (const col of ['communityPosts', 'announcements']) {
      try {
        const cSnap = await getDoc(
          doc(db, 'barangays', _bid, col, r.postId, 'comments', r.commentId)
        );
        if (cSnap.exists()) {
          commentBody    = cSnap.data().body ?? commentBody;
          const pSnap    = await getDoc(doc(db, 'barangays', _bid, col, r.postId));
          if (pSnap.exists()) postTitle = pSnap.data().title ?? postTitle;
          break;
        }
      } catch {}
    }

    return { ...r, commentBody, postTitle };
  }));

  el.innerHTML = enriched.map(r => `
    <div style="background:#fff;border-radius:12px;padding:1.25rem;
      box-shadow:0 1px 4px rgba(0,0,0,.07);border-left:3px solid #f59e0b;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;
        gap:1rem;flex-wrap:wrap;">

        <div style="flex:1;min-width:0;">
          <p style="font-size:.72rem;color:#9ca3af;margin:0 0 .2rem;">
            On post: <strong style="color:#374151;">${esc(r.postTitle)}</strong>
          </p>
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;
            padding:.55rem .75rem;margin-bottom:.4rem;">
            <p style="font-size:.85rem;color:#374151;margin:0;line-height:1.5;">
              "${esc(r.commentBody)}"
            </p>
          </div>
          <p style="font-size:.78rem;color:var(--gray-500);margin:0 0 .15rem;">
            Reported by: <strong>${esc(r.reportedByName ?? r.reportedBy)}</strong>
          </p>
          <p style="font-size:.78rem;color:var(--red);margin:0 0 .1rem;">
            Reason: ${esc(r.reason?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) ?? '—')}
          </p>
          ${r.details
            ? `<p style="font-size:.75rem;color:var(--gray-400);margin:0;">${esc(r.details)}</p>`
            : ''}
        </div>

        <div style="display:flex;gap:.5rem;flex-shrink:0;flex-wrap:wrap;">
          <button onclick="dismissCommentReport('${esc(r.id)}')"
            style="display:inline-flex;align-items:center;gap:.35rem;padding:.5rem 1rem;
              border-radius:8px;background:#1a3a1a;color:#fff;border:none;
              font-size:.82rem;font-weight:600;cursor:pointer;">
            Dismiss
          </button>
          <button onclick="deleteReportedComment('${esc(r.id)}','${esc(r.postId)}','${esc(r.commentId)}')"
            style="display:inline-flex;align-items:center;gap:.35rem;padding:.5rem 1rem;
              border-radius:8px;background:#fff;color:#dc2626;border:1.5px solid #fca5a5;
              font-size:.82rem;font-weight:600;cursor:pointer;">
            Delete Comment
          </button>
        </div>

      </div>
    </div>`).join('');

  lucide.createIcons({ el });
}


/* ================================================
   DISMISS REPORT
   Marks the report as dismissed without touching
   the underlying comment.
================================================ */

window.dismissCommentReport = async function (reportId) {
  const ok = await showConfirm({ title: 'Dismiss Report?', body: 'The comment will stay up and this report will be marked as dismissed.', confirm: 'Dismiss', cancel: 'Go Back', variant: 'warning' });
  if (!ok) return;
  if (!_bid) return;
  await updateDoc(doc(db, 'barangays', _bid, 'reportedComments', reportId), {
    status:    'dismissed',
    updatedAt: serverTimestamp(),
  });
};


/* ================================================
   DELETE REPORTED COMMENT
   Deletes the comment from whichever collection it
   belongs to, decrements the parent post's
   commentCount, then marks the report as actioned.
================================================ */

window.deleteReportedComment = async function (reportId, postId, commentId) {
  const ok = await showConfirm({ title: 'Delete Comment?', body: 'This comment will be permanently removed.', confirm: 'Delete', cancel: 'Go Back', variant: 'danger' });
if (!ok) return;
  if (!_bid) return;

  for (const col of ['communityPosts', 'announcements']) {
    try {
      const ref  = doc(db, 'barangays', _bid, col, postId, 'comments', commentId);
      const snap = await getDoc(ref);
      if (!snap.exists()) continue;

      await deleteDoc(ref);

      const { increment: _inc, updateDoc: _upd } =
        await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
      await _upd(doc(db, 'barangays', _bid, col, postId), { commentCount: _inc(-1) });

      break;
    } catch {}
  }

  await updateDoc(doc(db, 'barangays', _bid, 'reportedComments', reportId), {
    status:    'actioned',
    updatedAt: serverTimestamp(),
  });
};


/* ================================================
   UTILITIES
================================================ */

/* Escapes a value for safe inline HTML use */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}