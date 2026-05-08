/* ================================================
   reported-posts-admin.js — BarangayConnect
   Admin panel module for reviewing user-reported
   posts. Subscribes to pending reports in real
   time and renders a moderation list with view,
   dismiss, and delete actions. Restricted to
   admin and officer roles.

   Firestore path:
     barangays/{barangayId}/reportedPosts/{id}

   WHAT IS IN HERE:
     · Auth-gated initialization with role check
     · Real-time subscription to pending reports
     · Badge count update on the admin nav
     · Report list renderer with post preview modal
     · Dismiss report action (status → dismissed)
     · Delete post action with role-based permission
       check and report status update (status → actioned)
     · Image grid viewer with fullscreen support

   WHAT IS NOT IN HERE:
     · Comment moderation                 → reported-comments-admin.js
     · Admin panel layout and styles      → admin.css
     · Firebase config                    → firebase-config.js
     · Firestore path helpers             → db-paths.js

   REQUIRED IMPORTS:
     · ../../core/firebase-config.js           (auth, db)
     · ../../core/db-paths.js                  (userIndexDoc, barangayId)
     · firebase-firestore.js@10.12.0  (collection, onSnapshot, query,
                                       where, orderBy, doc, updateDoc,
                                       deleteDoc, getDoc, serverTimestamp)
     · firebase-auth.js@10.12.0       (onAuthStateChanged)
     · Lucide Icons                   — loaded before this script

   QUICK REFERENCE:
     Init              → onAuthStateChanged (auto-runs on import)
     Dismiss report    → window.dismissReport(reportId)
     Delete post       → window.deleteReportedPost(reportId, postId)
     View post         → window.viewReportedPost(postId)
     Badge element     → #reportedPostsBadge
     List element      → #reportedPostsList
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
   pending reported posts. Admin and officer roles
   only; all others are silently ignored.
================================================ */

onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  const snap = await getDoc(userIndexDoc(user.uid));
  if (!snap.exists()) return;

  const { barangay, role } = snap.data();
  if (role !== 'admin' && role !== 'officer') return;

  _bid = toBid(barangay);

  const q = query(
    collection(db, 'barangays', _bid, 'reportedPosts'),
    where('status', '==', 'pending'),
    orderBy('createdAt', 'desc'),
  );

  onSnapshot(q, snap => {
    const reports = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    /* Update nav badge count */
    /* Update whichever badge elements are currently in the DOM */
    ['reportedPostsBadge', 'reportsMainBadge'].forEach(id => {
      const badge = document.getElementById(id);
      if (!badge) return;
      badge.textContent   = reports.length;
      badge.style.display = reports.length ? 'inline' : 'none';
    });

    renderReports(reports);
  });
});


/* ================================================
   RENDER
   Renders the full list of pending reported posts.
   Each card shows the post title, report reason,
   reporter name, and action buttons.
================================================ */

function renderReports(reports) {
  const el = document.getElementById('reportedPostsList');
  if (!el) return;

  if (!reports.length) {
    el.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:3rem;text-align:center;
        color:#aaa;box-shadow:0 1px 4px rgba(0,0,0,.07);">
        <div style="font-size:2rem;margin-bottom:.5rem;">🛡️</div>
        <p style="margin:0;font-size:.9rem;">No reported posts.</p>
      </div>`;
    return;
  }

  el.innerHTML = reports.map(r => `
    <div style="background:#fff;border-radius:12px;padding:1.25rem;
      box-shadow:0 1px 4px rgba(0,0,0,.07);border-left:3px solid #dc2626;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;
        gap:1rem;flex-wrap:wrap;">

        <div>
          <p style="font-weight:700;font-size:.9rem;margin:0 0 .25rem;">
            ${esc(r.postTitle)}
          </p>
          <p style="font-size:.78rem;color:#6b7280;margin:0 0 .25rem;">
            Reason: ${esc(r.reason)}
          </p>
          <p style="font-size:.72rem;color:#9ca3af;margin:0;">
            Reported by: ${esc(r.reportedByName ?? r.reportedBy)}
          </p>
        </div>

        <div style="display:flex;gap:.5rem;flex-shrink:0;">
          <button onclick="viewReportedPost('${esc(r.postId)}')"
            style="display:inline-flex;align-items:center;gap:.35rem;padding:.5rem 1rem;
              border-radius:8px;background:#f3f4f6;color:#374151;border:1.5px solid #e5e7eb;
              font-size:.82rem;font-weight:600;cursor:pointer;">
            <i data-lucide="eye" style="width:13px;height:13px;"></i> View Post
          </button>
          <button onclick="dismissReport('${esc(r.id)}')"
            style="display:inline-flex;align-items:center;gap:.35rem;padding:.5rem 1rem;
              border-radius:8px;background:#1a3a1a;color:#fff;border:none;
              font-size:.82rem;font-weight:600;cursor:pointer;">
            Dismiss
          </button>
          <button onclick="deleteReportedPost('${esc(r.id)}','${esc(r.postId)}')"
            style="display:inline-flex;align-items:center;gap:.35rem;padding:.5rem 1rem;
              border-radius:8px;background:#fff;color:#dc2626;border:1.5px solid #fca5a5;
              font-size:.82rem;font-weight:600;cursor:pointer;">
            Delete Post
          </button>
        </div>

      </div>
    </div>`).join('');

  lucide.createIcons({ el });
}


/* ================================================
   DISMISS REPORT
   Marks the report as dismissed without touching
   the underlying post.
================================================ */

window.dismissReport = async function (reportId) {
  if (!_bid) return;
  await updateDoc(doc(db, 'barangays', _bid, 'reportedPosts', reportId), {
    status:    'dismissed',
    updatedAt: serverTimestamp(),
  });
};


/* ================================================
   DELETE REPORTED POST
   Searches both communityPosts and announcements
   for the target post. Enforces that officers
   cannot delete admin-authored posts. Deletes the
   post if found, then marks the report as actioned.
================================================ */

window.deleteReportedPost = async function (reportId, postId) {
  const ok = await showConfirm({ title: 'Delete Post?', body: 'The post will be deleted and the report dismissed.', confirm: 'Delete', cancel: 'Go Back', variant: 'danger' });
if (!ok) return;
  if (!_bid) return;

  try {
    let deleted = false;

    for (const col of ['communityPosts', 'announcements']) {
      try {
        const snap = await getDoc(doc(db, 'barangays', _bid, col, postId));
        if (!snap.exists()) continue;

        const postAuthorRole = snap.data().authorRole ?? 'resident';

        /* Officers cannot delete admin-authored posts */
        const { getDoc: _gd, doc: _d } =
          await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
        const mySnap = await getDoc(doc(db, 'barangays', _bid, 'users', auth.currentUser.uid));
        const myRole = mySnap.exists() ? mySnap.data().role : 'officer';

        if (myRole === 'officer' && postAuthorRole === 'admin') {
          await showConfirm({ title: 'Not Allowed', body: 'Officers cannot delete admin posts.', confirm: 'OK', cancel: '', variant: 'warning' });
          return;
        }

        await deleteDoc(doc(db, 'barangays', _bid, col, postId));
        deleted = true;
        break;
      } catch (err) {
        if (err.code === 'permission-denied') {
          await showConfirm({ title: 'Permission Denied', body: 'You do not have permission to delete this post.', confirm: 'OK', cancel: '', variant: 'warning' });
          return;
        }
      }
    }

    if (!deleted) console.warn('[delete] Post not found:', postId);

    await updateDoc(doc(db, 'barangays', _bid, 'reportedPosts', reportId), {
      status:    'actioned',
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.error(err);
  }
};


/* ================================================
   VIEW REPORTED POST
   Lazily creates the preview modal on first call,
   then fetches and displays the post content from
   whichever collection it belongs to. Renders an
   image grid with zoom-in hover and fullscreen
   viewer support.
================================================ */

window.viewReportedPost = async function (postId) {

  /* Create modal on first use */
  if (!document.getElementById('reportPreviewModal')) {
    const m = document.createElement('div');
    m.id            = 'reportPreviewModal';
    m.style.cssText = `
      display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);
      z-index:3000;align-items:center;justify-content:center;`;

    m.onclick = function (e) { if (e.target === m) m.style.display = 'none'; };

    m.innerHTML = `
      <div style="background:#fff;border-radius:16px;max-width:560px;width:92vw;
        max-height:88vh;overflow-y:auto;padding:1.5rem;
        box-shadow:0 20px 60px rgba(0,0,0,.3);position:relative;">
        <div style="display:flex;justify-content:space-between;align-items:center;
          margin-bottom:1rem;">
          <h3 id="rpTitle" style="margin:0;font-size:1rem;font-weight:700;"></h3>
          <button onclick="document.getElementById('reportPreviewModal').style.display='none'"
            style="background:none;border:none;cursor:pointer;font-size:1.1rem;
              color:#9ca3af;padding:4px;line-height:1;">✕</button>
        </div>
        <p id="rpMeta"   style="font-size:.78rem;color:#6b7280;margin:0 0 .75rem;"></p>
        <p id="rpBody"   style="font-size:.9rem;color:#374151;line-height:1.6;
          white-space:pre-wrap;margin:0 0 1rem;"></p>
        <div id="rpImages"></div>
      </div>`;

    document.body.appendChild(m);
    lucide.createIcons({ el: m });
  }

  /* Show modal with loading state */
  const modal = document.getElementById('reportPreviewModal');
  document.getElementById('rpTitle').textContent = 'Loading…';
  document.getElementById('rpMeta').textContent  = '';
  document.getElementById('rpBody').textContent  = '';
  document.getElementById('rpImages').innerHTML  = '';
  modal.style.display = 'flex';

  /* Fetch post from either collection */
  let postData = null;
  for (const col of ['communityPosts', 'announcements']) {
    try {
      const snap = await getDoc(doc(db, 'barangays', _bid, col, postId));
      if (snap.exists()) { postData = { _col: col, ...snap.data() }; break; }
    } catch {}
  }

  if (!postData) {
    document.getElementById('rpTitle').textContent = 'Post not found';
    document.getElementById('rpBody').textContent  = 'This post may have already been deleted.';
    return;
  }

  /* Populate modal fields */
  document.getElementById('rpTitle').textContent = postData.title ?? '(no title)';
  document.getElementById('rpMeta').textContent  =
    `by ${postData.authorName ?? '—'} · ${postData._col === 'communityPosts' ? 'Community Post' : 'Official Announcement'}`;
  document.getElementById('rpBody').textContent  = postData.body ?? '';

  /* Resolve image list from either imageURLs array or legacy imageURL field */
  const imgs = postData.imageURLs?.length
    ? postData.imageURLs
    : (postData.imageURL ? [postData.imageURL] : []);

  if (!imgs.length) return;

  /* Build image grid */
  const container    = document.getElementById('rpImages');
  const grid         = document.createElement('div');
  grid.style.cssText = `display:flex;flex-wrap:wrap;gap:.5rem;`;

  imgs.forEach((url, i) => {
    const thumb         = document.createElement('div');
    thumb.style.cssText = `
      flex:1 1 calc(50% - .25rem);min-width:120px;max-width:100%;
      border-radius:8px;overflow:hidden;background:#f3f4f6;
      border:1px solid #e5e7eb;cursor:zoom-in;
      display:flex;align-items:center;justify-content:center;
      height:180px;`;

    const img         = document.createElement('img');
    img.alt           = `Image ${i + 1}`;
    img.style.cssText = `
      width:100%;height:180px;object-fit:contain;display:block;
      transition:transform .2s;opacity:0;transition:opacity .2s,transform .2s;`;
    img.onload  = () => { img.style.opacity = '1'; };
    img.src     = url;

    img.onmouseover = () => img.style.transform = 'scale(1.03)';
    img.onmouseout  = () => img.style.transform = 'scale(1)';
    img.onclick     = () => window.openImageViewer?.(imgs, i, postData.title ?? '');

    thumb.appendChild(img);
    grid.appendChild(thumb);
  });

  /* Single image spans full width */
  if (imgs.length === 1) grid.firstChild.style.flex = '1 1 100%';

  container.appendChild(grid);
};


/* ================================================
   UTILITIES
================================================ */

/* Escapes a value for safe inline HTML use */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}