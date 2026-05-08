/* ================================================
   notifications.js — BarangayConnect
   Per-user notification bell for the resident navbar.
   Subscribes to the user's notification subcollection
   in real time and renders a dropdown panel with
   read/dismiss/clear-all functionality.

   Firestore path:
     barangays/{barangayId}/users/{uid}/notifications/{id}

   WHAT IS IN HERE:
     · Real-time notification subscription (initNotifications)
     · Bell badge unread count render
     · Dropdown panel render with icon map and rel-time
     · Notification click handler — marks read, scrolls to post
     · Single notification dismiss with slide-out animation
     · Clear-all with staggered slide-out and batch delete
     · Mark-all-read on panel open
     · sendNotification helper for writing to Firestore
     · HTML-escape and relative-time utilities

   WHAT IS NOT IN HERE:
     · Comment thread UI              → comments.js
     · Auth initialization            → firebase-config.js
     · Firestore path helpers         → db-paths.js
     · Navbar bell element and styles → navbar.css

   REQUIRED IMPORTS:
     · ../core/firebase-config.js           (db)
     · firebase-firestore.js@10.12.0  (collection, query, orderBy,
                                       limit, onSnapshot, updateDoc,
                                       deleteDoc, doc, writeBatch,
                                       getDocs, where, addDoc,
                                       serverTimestamp)
     · Lucide Icons                   — loaded before this script

   QUICK REFERENCE:
     Init bell        → initNotifications(barangayId, uid)
     Send notif       → sendNotification(barangayId, recipientUid, data)
     Click handler    → window.handleNotifClick(notifId, postId, barangayId, uid)
     Dismiss one      → window.dismissNotif(notifId, barangayId, uid)
     Clear all        → window.clearAllNotifications(barangayId, uid)
================================================ */


/* ================================================
   IMPORTS
================================================ */

import { db } from '../core/firebase-config.js';

import {
  collection, query, orderBy, limit,
  onSnapshot, updateDoc, deleteDoc, doc,
  writeBatch, getDocs, where,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";


/* ================================================
   MODULE STATE
================================================ */

let _barangayId = null;
let _uid        = null;
let _unsub      = null;


/* ================================================
   INIT
   Subscribes to the user's notification collection
   and re-renders the bell and dropdown on every update.
================================================ */

export function initNotifications(barangayId, uid) {
  _barangayId = barangayId;
  _uid        = uid;

  const col = collection(db, 'barangays', barangayId, 'users', uid, 'notifications');
  const q   = query(col, orderBy('createdAt', 'desc'), limit(20));

  _unsub = onSnapshot(q, snap => {
    const notifs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const unread = notifs.filter(n => !n.read).length;
    renderBell(unread);
    renderDropdown(notifs, barangayId, uid);
  });
}


/* ================================================
   BELL BADGE
   Shows or hides the unread dot; caps display at 9+.
================================================ */

function renderBell(unreadCount) {
  const dot = document.querySelector('.navbar__bell-dot');
  if (!dot) return;
  dot.style.display = unreadCount > 0 ? 'block' : 'none';
  dot.textContent   = unreadCount > 9 ? '9+' : (unreadCount || '');
}


/* ================================================
   DROPDOWN PANEL
   Injects the panel into the DOM on first call and
   reuses it on subsequent renders. Rebuilds innerHTML
   for every snapshot update.
================================================ */

function renderDropdown(notifs, barangayId, uid) {
  let panel = document.getElementById('notif-panel');

  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'notif-panel';
    panel.style.cssText = `
      position:fixed;top:60px;right:1rem;
      width:min(360px,94vw);max-height:80vh;
      background:#fff;border-radius:16px;
      box-shadow:0 8px 32px rgba(0,0,0,.18);
      overflow:hidden;z-index:500;display:none;
      flex-direction:column;`;
    document.body.appendChild(panel);

    /* Toggle panel and mark all read on bell click */
    document.querySelector('.navbar__bell')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = panel.style.display === 'flex';
      panel.style.display = isOpen ? 'none' : 'flex';
      if (!isOpen) markAllRead(barangayId, uid);
    });

    /* Close panel on outside click */
    document.addEventListener('click', () => { panel.style.display = 'none'; });
    panel.addEventListener('click', e => e.stopPropagation());
  }

  const unread = notifs.filter(n => !n.read).length;

  /* Icon config per notification type */
  const ICONS = {
  comment: { icon: 'message-circle',   bg: '#f0fdf4', color: '#15803d' },
  reply:   { icon: 'corner-down-right',bg: '#f0fdf4', color: '#15803d' },
  like:    { icon: 'heart',            bg: '#fef2f2', color: '#dc2626' },
  poll_created:   { icon: 'bar-chart-2',    bg: '#f0fdf4', color: '#15803d' },
  poll_closed:    { icon: 'square',         bg: '#fef2f2', color: '#dc2626' },
  poll_deadline:  { icon: 'clock',          bg: '#fffbeb', color: '#92400e' },
  event_pending:  { icon: 'calendar-plus',  bg: '#fff8ed', color: '#92400e' },
  event_approved: { icon: 'calendar-check', bg: '#f0fdf4', color: '#15803d' },
  event_rejected: { icon: 'calendar-x',     bg: '#fef2f2', color: '#dc2626' },
  status_change:  { icon: 'alert-circle',   bg: '#fef2f2', color: '#dc2626' },
  waitlist_promo: { icon: 'arrow-up-circle',bg: '#f0fdf4', color: '#15803d' },
  event_reminder: { icon: 'bell',           bg: '#eff6ff', color: '#2563eb' },
  pet_contact:  { icon: 'paw-print',    bg: '#f0fdf4', color: '#15803d' },
  pet_pending:  { icon: 'clock',        bg: '#fffbeb', color: '#92400e' },
  pet_approved: { icon: 'check-circle', bg: '#f0fdf4', color: '#15803d' },
  pet_rejected: { icon: 'x-circle',     bg: '#fef2f2', color: '#dc2626' },
  pet_resolved: { icon: 'heart',        bg: '#f0fdf4', color: '#15803d' },
  pet_linked:   { icon: 'link',         bg: '#f0fdf4', color: '#15803d' },
};

  panel.innerHTML = `
    <!-- Header -->
    <div style="background:#1a3a1a;padding:1rem 1.1rem .75rem;flex-shrink:0;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.35rem;">
        <div style="display:flex;align-items:center;gap:.55rem;">
          <i data-lucide="bell" style="width:18px;height:18px;color:#fff;"></i>
          <span style="font-weight:700;font-size:1rem;color:#fff;">Notifications</span>
          ${unread > 0 ? `<span style="background:#f97316;color:#fff;font-size:.68rem;
            font-weight:700;padding:2px 8px;border-radius:999px;">${unread} new</span>` : ''}
        </div>
        <button onclick="document.getElementById('notif-panel').style.display='none'"
          style="background:rgba(255,255,255,.15);border:none;cursor:pointer;
            width:28px;height:28px;border-radius:50%;color:#fff;
            display:flex;align-items:center;justify-content:center;">
          <i data-lucide="x" style="width:14px;height:14px;pointer-events:none;"></i>
        </button>
      </div>
      ${notifs.length ? `
      <button onclick="clearAllNotifications('${barangayId}','${uid}')"
        style="background:none;border:none;cursor:pointer;color:rgba(255,255,255,.7);
          font-size:.75rem;padding:0;transition:color .15s;"
        onmouseover="this.style.color='#fff'"
        onmouseout="this.style.color='rgba(255,255,255,.7)'">
        Clear all notifications
      </button>` : ''}
    </div>

    <!-- List -->
    <div id="notif-list" style="overflow-y:auto;flex:1;">
      ${!notifs.length
        ? `<p style="padding:2.5rem;text-align:center;color:#9ca3af;font-size:.85rem;margin:0;">
             No notifications yet.
           </p>`
        : notifs.map(n => {
            const isPet = n.type?.startsWith('pet_');
            const meta = ICONS[n.type] ?? ICONS.comment;
            const msg =
            n.type === 'like'           ? (n.commentId ? 'liked your comment on' : 'liked your post') :
            n.type === 'reply'          ? 'replied to your comment on' :
            n.type === 'poll_created'   ? 'A new community poll has been published:' :
            n.type === 'poll_closed'    ? 'A community poll has been closed:' :
            n.type === 'poll_deadline'  ? 'A poll is closing within 24 hours:' :
            n.type === 'event_pending'  ? 'A new event needs your review:' :
            n.type === 'event_approved' ? 'Your event has been approved:' :
            n.type === 'event_rejected' ? 'Your event was not approved:' :
            n.type === 'status_change'  ? 'An event status has changed:' :
            n.type === 'waitlist_promo' ? "You're off the waitlist for:" :
            n.type === 'event_reminder' ? 'Upcoming event reminder:' :
            n.type === 'pet_pending'    ? 'A new pet report needs your review:' :
            n.type === 'pet_linked'     ? 'thinks they found your missing pet:' :
            n.type === 'pet_contact'    ? 'sent you a message about your pet report:' :
            n.type === 'pet_pending'    ? 'A new pet report needs your review:' :
            n.type === 'pet_approved'   ? 'Your pet report has been approved:' :
            n.type === 'pet_rejected'   ? 'Your pet report was not approved:' :
            n.type === 'pet_resolved'   ? 'Your pet report has been resolved:' :
            'commented on your post';

            return `
            <div id="notif-row-${esc(n.id)}"
              onclick="handleNotifClick('${esc(n.id)}','${esc(n.postId)}','${esc(barangayId)}','${esc(uid)}','${esc(n.type)}')"
              style="display:flex;align-items:flex-start;gap:.75rem;
                padding:.85rem 1.1rem;border-bottom:1px solid #f3f4f6;
                cursor:pointer;transition:background .15s;position:relative;"
              onmouseover="this.style.background='#f9fafb'"
              onmouseout="this.style.background='transparent'">

              <!-- Icon -->
              <div style="width:40px;height:40px;border-radius:10px;flex-shrink:0;
                background:${meta.bg};display:flex;align-items:center;justify-content:center;">
                <i data-lucide="${meta.icon}" style="width:18px;height:18px;color:${meta.color};pointer-events:none;"></i>
              </div>

              <!-- Text -->
              <div style="flex:1;min-width:0;padding-right:1.5rem;">
                <p style="margin:0 0 2px;font-size:.82rem;color:#374151;line-height:1.4;
                  font-weight:${n.read ? '400' : '600'};">
                  ${['poll_created','poll_closed','poll_deadline',
                  'event_pending','event_approved','event_rejected',
                  'status_change','waitlist_promo','event_reminder'].includes(n.type)
                  ? `${msg} <em>"${esc(n.postTitle)}"</em>${n.description ? `<br><span style="color:#6b7280;font-size:.76rem;">${esc(n.description)}</span>` : ''}`
                  : (n.type === 'pet_linked' || n.type === 'pet_contact')
                  ? `<strong>${esc(n.actorName)}</strong> ${msg} <em>"${esc(n.postTitle)}"</em>${n.description ? `<br><span style="color:#6b7280;font-size:.76rem;">${esc(n.description)}</span>` : ''}`
                  : isPet
                  ? `${msg} <em>"${esc(n.postTitle)}"</em>${n.description ? `<br><span style="color:#6b7280;font-size:.76rem;">${esc(n.description)}</span>` : ''}`
                  : `<strong>${esc(n.actorName)}</strong> ${msg} <em>"${esc(n.postTitle)}"</em>`
                }
                </p>
                <p style="margin:0;font-size:.7rem;color:#9ca3af;">${relTime(n.createdAt)}</p>
              </div>

              <!-- Unread dot + dismiss -->
              <div style="position:absolute;right:.75rem;top:.85rem;
                display:flex;flex-direction:column;align-items:center;gap:.4rem;">
                ${!n.read
                  ? `<div style="width:8px;height:8px;border-radius:50%;
                       background:#f97316;flex-shrink:0;"></div>`
                  : '<div style="width:8px;"></div>'}
                <button onclick="event.stopPropagation();dismissNotif('${esc(n.id)}','${esc(barangayId)}','${esc(uid)}')"
                  style="background:none;border:none;cursor:pointer;color:#d1d5db;
                    padding:0;display:flex;transition:color .15s;"
                  onmouseover="this.style.color='#6b7280'"
                  onmouseout="this.style.color='#d1d5db'">
                  <i data-lucide="x" style="width:13px;height:13px;pointer-events:none;"></i>
                </button>
              </div>

            </div>`;
          }).join('')
      }
    </div>`;

  lucide.createIcons({ el: panel });
}

/*
   Sends a poll notification to every user in the barangay
   except the actor. Used by polls-admin.js and community-polls.js.
   data shape: { type, actorId, postId, postTitle, description? }
*/
export async function notifyAllInBarangay(barangayId, data, audience = {}) {
  /*
     audience shape: { targetRoles?: string, targetGroups?: string }
     Role filtering is done here (cheap — userIndex has role).
     Age filtering is skipped server-side — too expensive without
     reading every full user doc. Age-gated polls will over-notify
     but the poll card itself will block ineligible users from voting.
  */
  try {
    const { getDocs: _get, collection: _col } =
      await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

    const snap = await _get(_col(db, 'barangays', barangayId, 'users'));

    await Promise.all(
      snap.docs
        .filter(d => {
          if (d.id === data.actorId) return false;

          /* Role filter — skip if targetRoles is set and user doesn't match */
          if (audience.targetRoles && audience.targetRoles !== 'all') {
            const userRole = d.data().role ?? 'resident';
            const isOfficial = userRole === 'admin' || userRole === 'officer';
            if (audience.targetRoles === 'officials' && !isOfficial) return false;
            if (audience.targetRoles === 'residents' &&  isOfficial) return false;
          }

          return true;
        })
        .map(d => sendNotification(barangayId, d.id, { ...data, actorName: 'BarangayConnect' }))
    );
  } catch (e) { console.error('[notif] notifyAllInBarangay:', e); }
}


/* ================================================
   SEND NOTIFICATION
   Writes a notification doc to the recipient's
   subcollection. Never notifies the actor themselves.
================================================ */

export async function sendNotification(barangayId, recipientUid, data) {
  if (!recipientUid || recipientUid === data.actorId) return;

  const { addDoc, collection: _col, serverTimestamp: _ts } =
    await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

  await addDoc(
    _col(db, 'barangays', barangayId, 'users', recipientUid, 'notifications'),
    {
      type:        data.type,
      actorId:     data.actorId,
      actorName:   data.actorName,
      postId:      data.postId,
      postTitle:   data.postTitle,
      commentId:   data.commentId   ?? null,
      description: data.description ?? null,
      read:        false,
      createdAt:   _ts(),
    }
  );
}


  /* ================================================
    NOTIFICATION CLICK
    Marks the notification as read, closes the panel,
    determines the target page + tab, and either
    navigates cross-page (with ?tab=&scrollTo= params)
    or switches tab + retries scrolling in-place.
  ================================================ */

  window.handleNotifClick = async function (notifId, postId, barangayId, uid, type) {
    try {
      const ref = doc(db, 'barangays', barangayId, 'users', uid, 'notifications', notifId);
      await updateDoc(ref, { read: true });
    } catch (e) { /* non-fatal */ }

    document.getElementById('notif-panel').style.display = 'none';

    const isPoll    = ['poll_created', 'poll_closed', 'poll_deadline'].includes(type);
    const isEvent   = ['event_pending','event_approved','event_rejected',
                       'status_change','waitlist_promo','event_reminder'].includes(type);
    const isPetLink = type === 'pet_linked';
    const isPet     = type?.startsWith('pet_');
    const targetTab = isPoll ? 'polls' : isEvent ? 'events' : isPet ? 'pets' : 'bulletin';

    // Detect community page by the presence of its root containers
    const onCommunity = !!(
      document.getElementById('bulletinList') ||
      document.getElementById('pollsList')
    );

    if (!onCommunity) {
      // Navigate cross-page — community.html reads ?tab= and ?scrollTo= on load
      window.location.href =
  `/pages/features/community.html?tab=${targetTab}&scrollTo=${encodeURIComponent(postId)}`;
      return;
    }

    // Already on community page — switch to the correct tab first
    const tabBtn = document.querySelector(`[data-tab="${targetTab}"]`);
    if (tabBtn) {
      const isActive =
        tabBtn.classList.contains('is-active') ||
        tabBtn.getAttribute('aria-selected') === 'true' ||
        tabBtn.dataset.active === 'true';
      if (!isActive) tabBtn.click();
    }

    /* Events — switch tab and open detail modal */
    if (isEvent) {
      const evTabBtn = document.querySelector('[data-tab="events"]');
      if (evTabBtn) evTabBtn.click();
      setTimeout(() => window.openEventDetail?.(postId), 400);
      return;
    }

    /* Pet notifications (non-link) — just switch to pets tab */
    if (isPet && !isPetLink) {
      const petsTabBtn = document.querySelector('[data-tab="pets"]');
      if (petsTabBtn) petsTabBtn.click();
      return;
    }

    /* Pet linked — switch to pets tab, scroll to the missing report card */
    if (isPetLink) {
      const petsTabBtn = document.querySelector('[data-tab="pets"]');
      if (petsTabBtn) petsTabBtn.click();
      setTimeout(() => {
        const card = document.querySelector(`[data-report-id="${postId}"]`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.style.transition = 'box-shadow .3s';
          card.style.boxShadow  = '0 0 0 2px var(--green-dark)';
          setTimeout(() => { card.style.boxShadow = ''; }, 1800);
        }
      }, 600);
      return;
    }

    // Then retry-scroll until the element renders (data may still be loading)
    _notifScrollToPost(postId);
  };


  /* ================================================
    SCROLL WITH RETRY
    Polls the DOM every 250 ms for up to ~3.5 s after
    a tab switch or fresh page load. Shows a toast if
    the post can't be found (likely deleted).
  ================================================ */

  function _notifScrollToPost(postId, attempt = 0) {
    const MAX_ATTEMPTS = 14;
    const INTERVAL_MS  = 250;

    const el =
      document.getElementById(`comment-thread-${postId}`)?.closest('article') ??
      document.getElementById(`opts_${postId}`)?.closest('.poll-card');

    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.transition = 'box-shadow .35s';
      el.style.boxShadow  = '0 0 0 3px #f97316, 0 0 0 7px rgba(249,115,22,.18)';
      setTimeout(() => { el.style.boxShadow = ''; }, 2200);

      // Auto-open the comment thread if it's a comment/reply notification
      const thread = document.getElementById(`comment-thread-${postId}`);
      if (thread && (thread.style.display === 'none' || !thread.style.display)) {
        window.toggleComments?.(postId);
      }
      return;
    }

    if (attempt < MAX_ATTEMPTS) {
      if (attempt === 7) {
        window._bcTab?.('archived');
      }
      setTimeout(() => _notifScrollToPost(postId, attempt + 1), INTERVAL_MS);
    } else {
      _showNotifToast('This post is no longer available.', 'error');
  }
  }


  /* ================================================
    NOTIFICATION TOAST
    Falls back to creating its own container if the
    page doesn't have a known toast container yet.
  ================================================ */

  function _showNotifToast(msg, type = 'info') {
    let c =
      document.getElementById('bulletinToastContainer') ??
      document.getElementById('toastContainer') ??
      document.getElementById('_pollToasts');

    if (!c) {
      c    = document.createElement('div');
      c.id = '_notifToastContainer';
      c.style.cssText =
        'position:fixed;bottom:1.5rem;right:1.5rem;' +
        'display:flex;flex-direction:column;gap:.5rem;z-index:4000;pointer-events:none;';
      document.body.appendChild(c);
    }

    const bg = { error: '#9b1c1c', success: '#1a3a1a', info: '#374151' }[type] ?? '#374151';
    const t  = document.createElement('div');
    t.style.cssText =
      `display:flex;align-items:center;gap:.55rem;background:${bg};color:#fff;` +
      `padding:.75rem 1.1rem;border-radius:10px;font-size:.875rem;font-weight:500;` +
      `box-shadow:0 4px 16px rgba(0,0,0,.22);pointer-events:all;` +
      `animation:toastIn .25s ease both;`;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }


/* ================================================
   DISMISS SINGLE NOTIFICATION
   Slides the row out, then deletes the Firestore doc.
================================================ */

window.dismissNotif = async function (notifId, barangayId, uid) {
  const row = document.getElementById(`notif-row-${notifId}`);
  if (row) {
    row.style.transition = 'transform .25s ease, opacity .25s ease';
    row.style.transform  = 'translateX(100%)';
    row.style.opacity    = '0';
    setTimeout(() => row.remove(), 260);
  }

  try {
    await deleteDoc(doc(db, 'barangays', barangayId, 'users', uid, 'notifications', notifId));
  } catch (e) {
    console.error('[notif] dismiss:', e);
  }
};


/* ================================================
   CLEAR ALL NOTIFICATIONS
   Staggered slide-out animation, then batch-deletes
   all notification docs from Firestore.
================================================ */

window.clearAllNotifications = async function (barangayId, uid) {
  const list = document.getElementById('notif-list');
  const rows = list?.querySelectorAll('[id^="notif-row-"]');
  if (!rows?.length) return;

  rows.forEach((row, i) => {
    setTimeout(() => {
      row.style.transition = 'transform .22s ease, opacity .22s ease';
      row.style.transform  = 'translateX(110%)';
      row.style.opacity    = '0';
    }, i * 45);
  });

  setTimeout(async () => {
    try {
      const col   = collection(db, 'barangays', barangayId, 'users', uid, 'notifications');
      const snap  = await getDocs(col);
      const batch = writeBatch(db);
      snap.forEach(d => batch.delete(d.ref));
      await batch.commit();
    } catch (e) {
      console.error('[notif] clear all:', e);
    }
  }, rows.length * 45 + 250);
};


/* ================================================
   MARK ALL READ
   Batch-updates all unread notification docs to read.
   Called automatically when the panel is opened.
================================================ */

async function markAllRead(barangayId, uid) {
  const col = collection(db, 'barangays', barangayId, 'users', uid, 'notifications');

  const { getDocs: _getDocs, where: _where } =
    await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

  const unreadQ    = query(col, _where('read', '==', false));
  const unreadSnap = await _getDocs(unreadQ);
  const batch      = writeBatch(db);

  unreadSnap.forEach(d => batch.update(d.ref, { read: true }));
  await batch.commit();
}

function _scrollAndHighlight(el, postId) {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.style.transition = 'box-shadow .3s';
  el.style.boxShadow  = '0 0 0 2px #f97316';
  setTimeout(() => { el.style.boxShadow = ''; }, 1800);
  const thread = document.getElementById(`comment-thread-${postId}`);
  if (thread && (thread.style.display === 'none' || !thread.style.display)) {
    window.toggleComments?.(postId);
  }
}

function _switchToTab(tabName) {
  // These selectors need to match your actual tab buttons
  // Look in your HTML for the tab buttons and adjust the selector
  const tabBtn = document.querySelector(`[data-tab="${tabName}"], [onclick*="${tabName}"], #tab-${tabName}`);
  if (tabBtn) tabBtn.click();
}


/* ================================================
   UTILITIES
================================================ */

/* Formats a Firestore timestamp into a relative time string */
function relTime(ts) {
  if (!ts?.toDate && !ts?.seconds) return '';
  const date = ts.toDate ? ts.toDate() : new Date(ts.seconds * 1000);
  const d    = Date.now() - date.getTime();
  const m    = Math.floor(d / 60_000);
  const h    = Math.floor(d / 3_600_000);
  if (m  <  1) return 'just now';
  if (m  < 60) return `${m}m ago`;
  if (h  < 24) return `${h}h ago`;
  return date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}

/* Escapes a value for safe inline HTML attribute and content use */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}