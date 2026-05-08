/* ================================================
   events.js — BarangayConnect
   Resident-facing events system for community.html.
   Renders the Events tab: card grid, filters,
   pagination, and a read-only event detail modal.
   RSVP writes are Phase 3.

   Firestore path:
     barangays/{barangayId}/events/{eventId}
     barangays/{barangayId}/events/{eventId}/rsvps/{uid}

   Event document shape (relevant fields):
     title, description, category, imageURL,
     authorRole ("official"|"resident"),
     isApproved, dateStart, dateEnd, timeStart, timeEnd,
     location, totalSlots, showSlotsPublicly,
     waitlistEnabled, attendees[], waitlist[],
     status ("active"|"postponed"|"cancelled"|"completed"),
     statusReason, isPinned, isWalkIn,
     submittedBy, submittedByName, createdAt

   WHAT IS IN HERE:
     · initEvents() — auth bootstrap + Firestore subscription
     · Real-time onSnapshot — pinned first, then newest
     · Filter state — category, source, availability, myEvents
     · Card renderer with skeleton loader
     · Event detail modal (read-only)
     · View toggle wiring — Cards ↔ Calendar
     · Filter pill wiring — all controls in the Events panel
     · Pagination (PAGE_SIZE = 9)
     · Toast helper and XSS escape utility

   WHAT IS NOT IN HERE:
     · RSVP writes / waitlist joins     → events.js Phase 3
     · Calendar widget                  → events-calendar.js
     · Admin event management           → events-admin.js
     · Firestore path helpers           → db-paths.js
     · Firebase config                  → firebase-config.js

   REQUIRED IMPORTS:
     · /js/core/firebase-config.js      (db, auth)
     · /js/core/db-paths.js             (eventsCol, userIndexDoc, barangayId)
     · firebase-firestore.js@10.12.0    (onSnapshot, query, where, orderBy,
                                         orderBy, getDocs, getDoc)
     · firebase-auth.js@10.12.0         (onAuthStateChanged)

   QUICK REFERENCE:
     Init            → initEvents() [called from bootstrap on auth]
     Open detail     → window.openEventDetail(eventId)
     Category filter → window._filterEventCategory(cat)
     Pagination      → window._eventsPage(dir)
================================================ */


// ================================================
// IMPORTS
// ================================================

import { db, auth } from '/js/core/firebase-config.js';
import { eventsCol, eventDoc, eventRsvpsCol, userIndexDoc, barangayId as toBid } from '/js/core/db-paths.js';

import {
  onSnapshot, query, where, orderBy, getDoc, getDocs, addDoc, Timestamp,
  runTransaction, arrayUnion, arrayRemove,
  setDoc, updateDoc, serverTimestamp, doc,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

import {
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';


// ================================================
// CATEGORY META
// Updated to match Phase 1 category set.
// ================================================

const EVENT_CATS = {
  health:     { label: 'Health',      tagClass: 'tag--green', icon: 'activity'  },
  sports:     { label: 'Sports',      tagClass: 'tag--amber', icon: 'trophy'    },
  youth:      { label: 'Youth',       tagClass: 'tag--purple',icon: 'zap'       },
  livelihood: { label: 'Livelihood',  tagClass: 'tag--blue',  icon: 'briefcase' },
  culture:    { label: 'Culture',     tagClass: 'tag--teal',  icon: 'sparkles'  },
  seniors:    { label: 'Seniors',     tagClass: 'tag--red',   icon: 'heart'     },
};

const STATUS_LABELS = {
  postponed:  'Postponed',
  cancelled:  'Cancelled',
  completed:  'Completed',
};


// ================================================
// MODULE STATE
// ================================================

let _barangayId       = null;
let _uid              = null;
let _role             = 'resident';
let _allEvents        = [];       // live snapshot cache
let _userRsvps        = new Set(); // eventIds the user is attending
let _userName         = '';
let _unsub            = null;

/* Filter state */
let _activeCategory   = 'all';
let _activeSource     = 'all';   // 'all' | 'official' | 'community'
let _activeAvail      = 'all';   // 'all' | 'open' | 'walkin'
let _myEventsOnly     = false;

let _proposeFiles     = [];       // files staged in Propose form

/* Pagination */
const PAGE_SIZE       = 9;
let _currentPage      = 0;


// ================================================
// INIT
// ================================================

/*
   Called after auth resolves with the user's resolved barangayId.
   Wires all filter controls then starts the Firestore subscription.
*/
export async function initEvents(barangayId, uid, role) {
  _barangayId = barangayId;
  _uid        = uid;
  _role       = role ?? 'resident';

  const grid = document.getElementById('eventsCardsGrid');
  if (!grid || !_barangayId) return;

  _wireFilters();
  _wireViewToggle();
  _renderSkeleton(grid);
  _subscribe(grid);

  /* Show Propose button for logged-in users */
  if (_uid) {
    const proposeBtn = document.getElementById('proposeEventBtn');
    if (proposeBtn) {
      proposeBtn.style.display = '';
      proposeBtn.addEventListener('click', _openProposeForm);
    }
  }

  /* Show My Events toggle for logged-in users */
  if (_uid) {
    const myToggle = document.getElementById('myEventsToggle');
    if (myToggle) myToggle.style.display = '';
  }
}


// ================================================
// SUBSCRIPTION
// ================================================

/*
   Listens to approved, non-deleted events.
   Pinned events first, then newest first.
   Pending events from the current user are also included
   so they can see their own submissions.
*/
function _subscribe(grid) {
  if (_unsub) _unsub();

  const q = query(
    eventsCol(_barangayId),
    where('isApproved', '==', true),
    orderBy('isPinned',  'desc'),
    orderBy('createdAt', 'desc'),
  );

  _unsub = onSnapshot(q, snap => {
    _allEvents = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (_uid) {
      _userRsvps = new Set(
        snap.docs
          .filter(d => (d.data().attendees ?? []).includes(_uid))
          .map(d => d.id)
      );
    }
    _currentPage = 0;
    _renderEvents(grid);
    /* If detail modal is open, refresh it so RSVP state stays current */
    const openModal = document.getElementById('eventDetailModal');
    const openId    = openModal?.dataset.openEventId;
    if (openModal?.classList.contains('is-open') && openId) {
      window.openEventDetail(openId);
    }
    /* Keep calendar in sync if it's currently visible */
    if (window.updateEventsCalendar
        && document.getElementById('eventsCalendarView')?.style.display !== 'none') {
      window.updateEventsCalendar(_applyFilters(_allEvents));
    }
  }, err => {
    console.error('[events] subscription error', err);
  });
}

// ================================================
// RSVP WRITES
// ================================================

async function _rsvpRegister(eventId) {
  const eventRef = eventDoc(_barangayId, eventId);
  const rsvpRef  = doc(eventRsvpsCol(_barangayId, eventId), _uid);
  await runTransaction(db, async tx => {
    const snap = await tx.get(eventRef);
    if (!snap.exists()) throw new Error('Event not found.');
    const data = snap.data();
    if ((data.attendees ?? []).includes(_uid)) return;
    const taken     = (data.attendees ?? []).length;
    const slotsLeft = data.totalSlots == null ? Infinity : data.totalSlots - taken;
    if (slotsLeft > 0) {
      tx.update(eventRef, { attendees: arrayUnion(_uid), updatedAt: serverTimestamp() });
      tx.set(rsvpRef, { uid: _uid, name: _userName, registeredAt: serverTimestamp(), status: 'registered' });
    } else if (data.waitlistEnabled) {
      tx.update(eventRef, { waitlist: arrayUnion(_uid), updatedAt: serverTimestamp() });
      tx.set(rsvpRef, { uid: _uid, name: _userName, registeredAt: serverTimestamp(), status: 'waitlisted' });
    }
  });
}

async function _rsvpCancel(eventId) {
  const eventRef = eventDoc(_barangayId, eventId);
  const rsvpRef  = doc(eventRsvpsCol(_barangayId, eventId), _uid);
  let _promoted  = null;
  await runTransaction(db, async tx => {
    const snap = await tx.get(eventRef);
    if (!snap.exists()) return;
    const waitlist = snap.data().waitlist ?? [];
    if (waitlist.length > 0) _promoted = waitlist[0];
    tx.update(eventRef, { attendees: arrayRemove(_uid), updatedAt: serverTimestamp() });
    tx.set(rsvpRef, { status: 'cancelled' }, { merge: true });
    /* Auto-promote first waitlisted user */
    if (waitlist.length > 0) {
      const promoted = waitlist[0];
      tx.update(eventRef, { waitlist: arrayRemove(promoted), attendees: arrayUnion(promoted), updatedAt: serverTimestamp() });
    }
  });
  if (_promoted) {
    try {
      const { sendNotification } = await import('/js/features/community/notifications.js');
      await sendNotification(_barangayId, _promoted, {
        type: 'waitlist_promo', actorId: 'system', actorName: 'BarangayConnect',
        postId: eventId, postTitle: _allEvents.find(e => e.id === eventId)?.title ?? 'Event',
      });
    } catch { /* non-fatal */ }
  }
}

async function _rsvpJoinWaitlist(eventId) {
  const eventRef = eventDoc(_barangayId, eventId);
  const rsvpRef  = doc(eventRsvpsCol(_barangayId, eventId), _uid);
  await runTransaction(db, async tx => {
    const snap = await tx.get(eventRef);
    if (!snap.exists()) return;
    if ((snap.data().waitlist ?? []).includes(_uid)) return;
    tx.update(eventRef, { waitlist: arrayUnion(_uid), updatedAt: serverTimestamp() });
    tx.set(rsvpRef, { uid: _uid, name: _userName, registeredAt: serverTimestamp(), status: 'waitlisted' }, { merge: true });
  });
}

async function _rsvpLeaveWaitlist(eventId) {
  const eventRef = eventDoc(_barangayId, eventId);
  const rsvpRef  = doc(eventRsvpsCol(_barangayId, eventId), _uid);
  await runTransaction(db, async tx => {
    tx.update(eventRef, { waitlist: arrayRemove(_uid), updatedAt: serverTimestamp() });
    tx.set(rsvpRef, { status: 'cancelled' }, { merge: true });
  });
}


// ================================================
// FILTER HELPERS
// ================================================

function _applyFilters(events) {
  return events.filter(ev => {
    /* Category */
    if (_activeCategory !== 'all' && ev.category !== _activeCategory) return false;

    /* Source */
    if (_activeSource === 'official'  && ev.authorRole !== 'official')  return false;
    if (_activeSource === 'community' && ev.authorRole !== 'resident')  return false;

    /* Availability */
    if (_activeAvail === 'walkin' && !ev.isWalkIn) return false;
    if (_activeAvail === 'open') {
      const full = ev.totalSlots != null
        && (ev.attendees?.length ?? 0) >= ev.totalSlots
        && !ev.waitlistEnabled;
      if (full || ev.isWalkIn) return false;
    }

    /* My Events */
    if (_myEventsOnly && _uid) {
      if (!_userRsvps.has(ev.id) && ev.submittedBy !== _uid) return false;
    }

    return true;
  });
}


// ================================================
// RENDER — CARDS
// ================================================

function _renderEvents(grid) {
  if (!grid) return;

  const filtered = _applyFilters(_allEvents);
  const total    = filtered.length;
  const start    = _currentPage * PAGE_SIZE;
  const page     = filtered.slice(start, start + PAGE_SIZE);

  if (!total) {
    grid.innerHTML = _buildEmptyState();
    _renderPagination(null, 0, 0);
    if (typeof lucide !== 'undefined') lucide.createIcons({ el: grid });
    return;
  }

  grid.innerHTML = page.map(_buildEventCard).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons({ el: grid });

  _renderPagination(grid.parentElement, _currentPage, Math.ceil(total / PAGE_SIZE));
}

function _buildEventCard(ev) {
  const cat      = EVENT_CATS[ev.category] ?? { label: ev.category, tagClass: 'tag--gray', icon: 'calendar' };
  const dateStr  = _formatDateRange(ev.dateStart, ev.dateEnd);
  const timeStr  = ev.timeStart
    ? `${_fmt12(ev.timeStart)}${ev.timeEnd ? ` – ${_fmt12(ev.timeEnd)}` : ''}`
    : '';

  const categoryTag = `<span class="event-card__category-tag tag ${cat.tagClass}">${cat.label}</span>`;

  const sourceBadge = ev.authorRole === 'official'
    ? `<span class="event-card__source-badge"><i data-lucide="shield-check" style="width:10px;height:10px;"></i> Official</span>`
    : `<span class="event-card__source-badge event-card__source-badge--community"><i data-lucide="users" style="width:10px;height:10px;"></i> Community</span>`;

  const pinnedBadge = ev.isPinned
    ? `<div class="post-pin-bar" style="position:absolute;top:var(--space-sm);left:var(--space-sm);z-index:3;background:rgba(255,255,255,0.92);padding:2px 8px;border-radius:var(--radius-full);box-shadow:var(--shadow-sm);">
         <i data-lucide="pin"></i> PINNED
       </div>`
    : '';

  const _sbarMeta = {
    postponed: { bg:'#fff8ed', color:'#92400e', border:'#fde68a', icon:'clock'        },
    cancelled: { bg:'#fef2f2', color:'#991b1b', border:'#fecaca', icon:'x-circle'     },
    completed: { bg:'#f0fdf4', color:'#14532d', border:'#bbf7d0', icon:'check-circle' },
  };
  const _sm = _sbarMeta[ev.status] ?? {};
  const statusBar = ev.status && ev.status !== 'active' && STATUS_LABELS[ev.status]
    ? `<div class="event-card__status-bar event-card__status-bar--${esc(ev.status)}">
         <i data-lucide="${_sm.icon}" style="width:12px;height:12px;"></i>
         ${STATUS_LABELS[ev.status]}
       </div>`
    : '';

  const imgSrc = ev.imageURL || ev.imageURLs?.[0] || '';
  const imgHtml = imgSrc
    ? `<img class="event-card__img" src="${esc(imgSrc)}" alt="${esc(ev.title)}" loading="lazy" />`
    : `<div class="event-card__img" style="background:var(--gray-100);display:flex;align-items:center;justify-content:center;">
         <i data-lucide="${cat.icon}" style="width:32px;height:32px;color:var(--gray-300);stroke-width:1.5;"></i>
       </div>`;

  return `
    <article class="event-card" data-event-id="${esc(ev.id)}">
      ${statusBar}
      <div class="event-card__img-wrap">
        ${imgHtml}
        ${categoryTag}
        ${pinnedBadge}
        ${sourceBadge}
      </div>
      <div class="event-card__body">
        <h3 class="event-card__title">${esc(ev.title)}</h3>
        ${dateStr ? `<p class="event-card__date-row">
          <i data-lucide="calendar" style="width:13px;height:13px;"></i> ${esc(dateStr)}
        </p>` : ''}
        ${timeStr ? `<p class="event-card__date-row">
          <i data-lucide="clock" style="width:13px;height:13px;"></i> ${esc(timeStr)}
        </p>` : ''}
        ${ev.location ? `<p class="event-card__location-row">
          <i data-lucide="map-pin" style="width:13px;height:13px;"></i> ${esc(ev.location)}
        </p>` : ''}
        <div class="event-card__footer">
          ${_buildSlotsBadge(ev, _userRsvps.has(ev.id))}
          <button class="btn btn--green btn--sm"
            onclick="openEventDetail('${esc(ev.id)}')">
            View Details
          </button>
        </div>
      </div>
    </article>`;
}

function _buildSlotsBadge(ev, isRsvpd = false) {
  if (isRsvpd) {
    return `<span class="badge-slots badge-slots--registered">
      <i data-lucide="check-circle"></i> Registered
    </span>`;
  }
  if (ev.isWalkIn) {
    return `<span class="badge-slots" style="background:var(--green-100);color:var(--green-800);">
      <i data-lucide="check-circle"></i> Walk-in
    </span>`;
  }
  if (ev.totalSlots == null) {
    return `<span class="badge-slots" style="background:var(--green-100);color:var(--green-800);">
      <i data-lucide="users"></i> Open
    </span>`;
  }
  const taken    = ev.attendees?.length ?? 0;
  const remaining = ev.totalSlots - taken;
  if (remaining <= 0) {
    return ev.waitlistEnabled
      ? `<span class="badge-slots"><i data-lucide="clock"></i> Waitlist open</span>`
      : `<span class="badge-slots" style="background:var(--red-50);color:var(--red);">
           <i data-lucide="x-circle"></i> Full
         </span>`;
  }
  return `<span class="badge-slots"><i data-lucide="users"></i> ${remaining} slot${remaining !== 1 ? 's' : ''} left</span>`;
}

function _buildEmptyState() {
  return `
    <div class="events-empty" style="grid-column:1/-1;">
      <i data-lucide="calendar-x"></i>
      <p class="events-empty__title">No events found</p>
      <p class="events-empty__sub">Try a different category or check back later.</p>
    </div>`;
}


// ================================================
// RENDER — SKELETON
// ================================================

function _renderSkeleton(grid) {
  grid.innerHTML = Array.from({ length: 6 }).map(() => `
    <div class="events-skeleton">
      <div class="events-skeleton__img"></div>
      <div class="events-skeleton__body">
        <div class="skeleton skeleton--tag" style="width:70px;margin-bottom:4px;"></div>
        <div class="skeleton skeleton--title" style="margin-bottom:6px;"></div>
        <div class="skeleton skeleton--body"></div>
        <div class="skeleton skeleton--body-sm" style="margin-top:4px;"></div>
      </div>
    </div>`).join('');
}


// ================================================
// RENDER — PAGINATION
// ================================================

function _renderPagination(container, page, totalPages) {
  const existing = document.getElementById('eventsPagination');
  if (existing) existing.remove();
  if (!container || totalPages <= 1) return;
  /* Don't show pagination while calendar is active */
  if (document.getElementById('eventsCalendarView')?.style.display !== 'none') return;

  const nav = document.createElement('div');
  nav.id = 'eventsPagination';
  nav.className = 'bulletin-pagination';
  nav.innerHTML = `
    <button class="btn btn--outline btn--sm" onclick="window._eventsPage(-1)"
      ${page === 0 ? 'disabled' : ''}>
      <i data-lucide="chevron-left"></i> Prev
    </button>
    <span class="bulletin-pagination__label">Page ${page + 1} of ${totalPages}</span>
    <button class="btn btn--outline btn--sm" onclick="window._eventsPage(1)"
      ${page >= totalPages - 1 ? 'disabled' : ''}>
      Next <i data-lucide="chevron-right"></i>
    </button>`;
  container.after(nav);
  if (typeof lucide !== 'undefined') lucide.createIcons({ el: nav });
}

window._eventsPage = function (dir) {
  const filtered    = _applyFilters(_allEvents);
  const totalPages  = Math.ceil(filtered.length / PAGE_SIZE);
  _currentPage      = Math.max(0, Math.min(_currentPage + dir, totalPages - 1));
  const grid        = document.getElementById('eventsCardsGrid');
  if (grid) {
    _renderEvents(grid);
    grid.closest('.community-panel-inner')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};

window._rsvpAction = async function (eventId, action) {
  const btn = document.getElementById('rsvpActionBtn');
  const originalText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

  try {
    if      (action === 'register')      await _rsvpRegister(eventId);
    else if (action === 'cancel')        await _rsvpCancel(eventId);
    else if (action === 'waitlist')      await _rsvpJoinWaitlist(eventId);
    else if (action === 'leaveWaitlist') await _rsvpLeaveWaitlist(eventId);

    /* Optimistic local state + patch cache so modal re-renders correct slots */
    const cachedIdx = _allEvents.findIndex(e => e.id === eventId);
    if (cachedIdx !== -1) {
      const ev = { ..._allEvents[cachedIdx] };
      if (action === 'register') {
        ev.attendees = [...(ev.attendees ?? []), _uid];
        _userRsvps.add(eventId);
      } else if (action === 'cancel') {
        ev.attendees = (ev.attendees ?? []).filter(u => u !== _uid);
        _userRsvps.delete(eventId);
      } else if (action === 'waitlist') {
        ev.waitlist = [...(ev.waitlist ?? []), _uid];
      } else if (action === 'leaveWaitlist') {
        ev.waitlist = (ev.waitlist ?? []).filter(u => u !== _uid);
      }
      _allEvents[cachedIdx] = ev;
    }

    if (action === 'cancel' || action === 'leaveWaitlist') {
      /* Close modal — snapshot will update card badge; reopening shows fresh data */
      document.getElementById('eventDetailModal')?.classList.remove('is-open');
      _showToast('Registration removed.', 'error');
    } else {
      await window.openEventDetail(eventId);
      _showToast('Registered successfully!');
    }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
    _showToast(err.message || 'Something went wrong.', 'error');
  }
};

/* ── Event image viewer — populates accent bar with event info ── */
window.eventOpenViewer = function(images, index, title, eventId) {
  window.openImageViewer?.(images, index, title);
  requestAnimationFrame(() => {
    const accent = document.querySelector('#imgViewerOverlay .img-viewer__accent');
    if (!accent || !eventId) return;
    const ev  = _allEvents.find(e => e.id === eventId);
    if (!ev) return;
    const cat = EVENT_CATS[ev.category] ?? { label: 'Event', tagClass: 'tag--gray', icon: 'calendar' };
    const _fmtD = s => s ? new Date(s + 'T00:00:00').toLocaleDateString('en-PH',{ month:'short', day:'numeric', year:'numeric' }) : '';
    accent.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;width:100%;gap:1rem;flex-wrap:wrap;">
        <div>
          <span class="tag ${esc(cat.tagClass)}" style="font-size:var(--text-2xs);padding:1px 7px;pointer-events:none;">${esc(cat.label)}</span>
          <p style="font-family:var(--font-display);font-weight:700;color:#fff;margin:4px 0 0;font-size:var(--text-sm);">${esc(ev.title)}</p>
          ${ev.location ? `<p style="font-size:var(--text-xs);color:rgba(255,255,255,0.5);margin:2px 0 0;display:flex;align-items:center;gap:3px;"><i data-lucide="map-pin" style="width:10px;height:10px;"></i>${esc(ev.location)}</p>` : ''}
          ${ev.dateStart ? `<p style="font-size:var(--text-xs);color:rgba(255,255,255,0.5);margin:2px 0 0;">${_fmtD(ev.dateStart)}</p>` : ''}
        </div>
      </div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons({ el: accent });
  });
};

// ================================================
// EVENT DETAIL MODAL
// ================================================

window.openEventDetail = async function (eventId) {
  const modal   = document.getElementById('eventDetailModal');
  const bodyEl  = document.getElementById('eventDetailBody');
  const footerEl = document.getElementById('eventDetailFooter');
  if (!modal || !bodyEl) return;

  modal.classList.add('is-open');
  modal.dataset.openEventId = eventId;

  /* Try cache first, fall back to Firestore */
  let ev = _allEvents.find(e => e.id === eventId);
  if (!ev) {
    try {
      const snap = await getDoc(eventDoc(_barangayId, eventId));
      if (snap.exists()) ev = { id: snap.id, ...snap.data() };
    } catch { /* non-fatal */ }
  }

  if (!ev) {
    bodyEl.innerHTML = `<p style="color:var(--gray-400);text-align:center;padding:var(--space-xl) 0;">
      Event not found.
    </p>`;
    return;
  }

  const cat     = EVENT_CATS[ev.category] ?? { label: ev.category, tagClass: 'tag--gray', icon: 'calendar' };
  const dateStr     = _formatDateRange(ev.dateStart, ev.dateEnd);
  const showDateTime = !ev.status || ev.status === 'active';
  const _hideTime = ev.status === 'postponed' || ev.status === 'cancelled';
  const timeStr = !_hideTime && ev.timeStart
    ? `${_fmt12(ev.timeStart)}${ev.timeEnd ? ` – ${_fmt12(ev.timeEnd)}` : ''}`
    : '';

  /* ── Header (injected into modal body since modal--event-detail has no header slot) ── */
  const _catHeaderColors = {
    health: 'var(--green-dark)', sports: '#76410f', youth: '#42207c',
    livelihood: '#184096', culture: '#0f766e', seniors: '#760f0f',
  };
  const headerColor = _catHeaderColors[ev.category] ?? (ev.authorRole === 'official' ? 'var(--green-dark)' : '#374151');
  const headerHtml = `
    <div class="modal__header" style="background:${headerColor};">
      <div class="modal__header-icon"><i data-lucide="${cat.icon}"></i></div>
      <div class="modal__header-content">
        <p class="modal__header-label">${cat.label}</p>
        <h2 class="modal__header-title">${esc(ev.title)}</h2>
        ${ev.authorRole === 'official'
          ? `<p class="modal__header-sub"><i data-lucide="shield-check" style="width:12px;height:12px;display:inline;vertical-align:middle;"></i> Official Event</p>`
          : `<p class="modal__header-sub">Community-submitted · ${esc(ev.submittedByName ?? 'Resident')}</p>`}
      </div>
      <button class="btn btn--close btn--sm modal__close" onclick="event.stopPropagation();closeModal('eventDetailModal')">
        <i data-lucide="x"></i>
      </button>
    </div>`;

  /* ── Slots info ── */
  const taken     = ev.attendees?.length ?? 0;
  const remaining = ev.totalSlots != null ? ev.totalSlots - taken : null;
  const slotsHtml = ev.showSlotsPublicly && ev.totalSlots != null
    ? `<div style="display:flex;align-items:center;gap:.5rem;font-size:var(--text-sm);color:var(--gray-600);margin-top:var(--space-sm);">
         <i data-lucide="users" style="width:14px;height:14px;flex-shrink:0;"></i>
         <span>${taken} registered · ${remaining != null ? `${remaining} slot${remaining !== 1 ? 's' : ''} remaining` : 'Unlimited'}</span>
       </div>
       ${ev.waitlistEnabled && ev.waitlist?.length
         ? `<div style="display:flex;align-items:center;gap:.5rem;font-size:var(--text-sm);color:var(--gray-500);">
              <i data-lucide="clock" style="width:14px;height:14px;flex-shrink:0;"></i>
              ${ev.waitlist.length} on waitlist
            </div>`
         : ''}`
    : '';

  /* ── Status notice ── */
  const statusHtml = ev.status && ev.status !== 'active'
    ? `<div class="event-card__status-bar event-card__status-bar--${esc(ev.status)}" style="border-radius:var(--radius-sm);margin-bottom:var(--space-md);">
         <i data-lucide="clock" style="width:14px;height:14px;"></i>
         ${STATUS_LABELS[ev.status] ?? ev.status}
         ${ev.statusReason ? ` — ${esc(ev.statusReason)}` : ''}
       </div>`
    : '';

  bodyEl.innerHTML = headerHtml + `
    <div style="padding:var(--space-lg);display:flex;flex-direction:column;gap:var(--space-md);">
      ${statusHtml}
      <div style="display:flex;flex-direction:column;gap:var(--space-sm);">
        ${showDateTime ? `<p class="modal-section-label">Date &amp; Time</p>` : ''}
        ${showDateTime && dateStr ? `<div style="display:flex;align-items:center;gap:.5rem;font-size:var(--text-sm);color:var(--gray-700);">
          <i data-lucide="calendar" style="width:14px;height:14px;flex-shrink:0;"></i> ${esc(dateStr)}
        </div>` : ''}
        ${showDateTime && timeStr ? `<div style="display:flex;align-items:center;gap:.5rem;font-size:var(--text-sm);color:var(--gray-700);">
          <i data-lucide="clock" style="width:14px;height:14px;flex-shrink:0;"></i> ${esc(timeStr)}
        </div>` : ''}
        ${ev.location ? `<div style="display:flex;align-items:center;gap:.5rem;font-size:var(--text-sm);color:var(--gray-700);">
          <i data-lucide="map-pin" style="width:14px;height:14px;flex-shrink:0;"></i> ${esc(ev.location)}
        </div>` : ''}
      </div>
      ${ev.description ? `
        <div>
          <p class="modal-section-label">About this Event</p>
          <p style="font-size:var(--text-sm);color:var(--gray-600);line-height:var(--lh-relaxed);margin:0;">${esc(ev.description)}</p>
        </div>` : ''}
      ${slotsHtml ? `<div style="display:flex;flex-direction:column;gap:.25rem;">${slotsHtml}</div>` : ''}
    </div>`;

  /* ── Footer — RSVP stub (Phase 3) ── */
  if (footerEl) {
    const isRsvpd      = _userRsvps.has(ev.id);
    const isWaitlisted = (ev.waitlist ?? []).includes(_uid);
    const isFull       = remaining !== null && remaining <= 0;
    const notActive    = ev.status && ev.status !== 'active';

    let actionBtn;
    if (!_uid) {
      actionBtn = `<span style="font-size:var(--text-sm);color:var(--gray-400);">Sign in to RSVP</span>`;
    } else if (notActive) {
      actionBtn = `<button class="btn btn--outline btn--full" disabled>Event ${STATUS_LABELS[ev.status] ?? ev.status}</button>`;
    } else if (ev.isWalkIn) {
      actionBtn = `<button class="btn btn--green btn--full" disabled>Walk-in</button>`;
    } else if (isRsvpd) {
      actionBtn = `<button id="rsvpActionBtn" class="btn btn--outline btn--full"
        onclick="window._rsvpAction('${esc(ev.id)}','cancel')">Cancel Registration</button>`;
    } else if (isWaitlisted) {
      actionBtn = `<button id="rsvpActionBtn" class="btn btn--outline btn--full"
        onclick="window._rsvpAction('${esc(ev.id)}','leaveWaitlist')">Leave Waitlist</button>`;
    } else if (isFull && ev.waitlistEnabled) {
      actionBtn = `<button id="rsvpActionBtn" class="btn btn--orange btn--full"
        onclick="window._rsvpAction('${esc(ev.id)}','waitlist')">Join Waitlist</button>`;
    } else if (isFull) {
      actionBtn = `<button class="btn btn--outline btn--full" disabled>Event Full</button>`;
    } else {
      actionBtn = `<button id="rsvpActionBtn" class="btn btn--green btn--full"
        onclick="window._rsvpAction('${esc(ev.id)}','register')">Register Now</button>`;
    }

    footerEl.innerHTML = `
      <button class="btn btn--outline" onclick="closeModal('eventDetailModal')">Close</button>
      ${actionBtn}`;
  }

  if (typeof lucide !== 'undefined') lucide.createIcons({ el: modal });
};


// ================================================
// FILTER WIRING
// ================================================

function _wireFilters() {

  /* Category pills */
  document.getElementById('eventsCategoryFilters')?.querySelectorAll('.btn--filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('eventsCategoryFilters').querySelectorAll('.btn--filter')
        .forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      _activeCategory = btn.dataset.category ?? 'all';
      _currentPage = 0;
      _renderEvents(document.getElementById('eventsCardsGrid'));
      _maybeUpdateCalendar();
    });
  });

  /* Source seg */
  document.querySelectorAll('.events-seg-btn[data-source]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.events-seg-btn[data-source]')
        .forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      _activeSource = btn.dataset.source ?? 'all';
      _currentPage = 0;
      _renderEvents(document.getElementById('eventsCardsGrid'));
      _maybeUpdateCalendar();
    });
  });

  /* Availability seg */
  document.querySelectorAll('.events-seg-btn[data-avail]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.events-seg-btn[data-avail]')
        .forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      _activeAvail = btn.dataset.avail ?? 'all';
      _currentPage = 0;
      _renderEvents(document.getElementById('eventsCardsGrid'));
      _maybeUpdateCalendar();
    });
  });

  /* My Events toggle */
  document.getElementById('myEventsCheck')?.addEventListener('change', e => {
    _myEventsOnly = e.target.checked;
    _currentPage  = 0;
    _renderEvents(document.getElementById('eventsCardsGrid'));
    _maybeUpdateCalendar();
  });
}

/* Keeps calendar in sync whenever filters change */
function _maybeUpdateCalendar() {
  if (window.updateEventsCalendar &&
      document.getElementById('eventsCalendarView')?.style.display !== 'none') {
    window.updateEventsCalendar(_applyFilters(_allEvents));
  }
}


// ================================================
// VIEW TOGGLE WIRING — Cards ↔ Calendar
// ================================================

function _wireViewToggle() {
  document.querySelectorAll('.events-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.events-view-btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      const view = btn.dataset.view;
      const cardsView = document.getElementById('eventsCardsView');
      const calView   = document.getElementById('eventsCalendarView');
      if (cardsView) cardsView.style.display = view === 'cards' ? '' : 'none';
      if (calView)   calView.style.display   = view === 'calendar' ? '' : 'none';
      /* Phase 2.5 — calendar module hook */
      document.getElementById('eventsPagination')?.remove();
      const _pag = document.getElementById('eventsPagination');
      if (_pag) _pag.style.display = view === 'calendar' ? 'none' : '';
      if (view === 'calendar' && window.initEventsCalendar) {
        window.initEventsCalendar(_applyFilters(_allEvents), 'eventsCalContainer', 'eventsCalSidebarList', 'eventsCalSidebarTitle');
      }
    });
  });
}


// ================================================
// UTILITIES
// ================================================

function _formatDateRange(start, end) {
  if (!start) return '';
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  const s    = new Date(start + 'T00:00:00');
  if (!end || end === start) return s.toLocaleDateString('en-PH', opts);
  const e    = new Date(end   + 'T00:00:00');
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
    return `${s.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })} – ${e.getDate()}, ${e.getFullYear()}`;
  }
  return `${s.toLocaleDateString('en-PH', opts)} – ${e.toLocaleDateString('en-PH', opts)}`;
}

function _fmt12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm   = h >= 12 ? 'PM' : 'AM';
  const h12    = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _showToast(msg, type = 'success') {
  let c = document.getElementById('_eventsToasts');
  if (!c) {
    c = document.createElement('div');
    c.id = '_eventsToasts';
    c.style.cssText = 'position:fixed;bottom:1.5rem;right:1.5rem;display:flex;flex-direction:column;gap:.5rem;z-index:2100;pointer-events:none;';
    document.body.appendChild(c);
  }
  const t = document.createElement('div');
  t.className = `toast toast--${type}`;
  t.style.pointerEvents = 'all';
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ================================================
// PROPOSE EVENT
// ================================================

function _openProposeForm() {
  const body = document.getElementById('proposeEventBody');
  if (!body) return;

  const today = new Date().toISOString().slice(0, 10);
  _proposeFiles = [];

  body.innerHTML = `
    <div style="padding:var(--space-lg);display:flex;flex-direction:column;gap:var(--space-md);">

      <div class="form-group">
        <label class="form-label">Title <span style="color:var(--red);">*</span></label>
        <input type="text" id="pev-title" class="form-input" placeholder="Event title…" maxlength="100" />
      </div>

      <div class="form-group">
        <label class="form-label">Category <span style="color:var(--red);">*</span></label>
        <select id="pev-category" class="form-select">
          <option value="">Select a category…</option>
          <option value="youth">Youth &amp; Sports</option>
          <option value="seniors">Seniors</option>
          <option value="health">Health</option>
          <option value="livelihood">Livelihood</option>
          <option value="culture">Culture</option>
          <option value="community">Community</option>
        </select>
      </div>

      <div class="form-group">
        <label class="form-label">Description <span style="color:var(--red);">*</span></label>
        <textarea id="pev-desc" class="form-input" rows="3" maxlength="500"
          placeholder="Tell residents what this event is about…"
          oninput="document.getElementById('pev-desc-count').textContent=this.value.length+' / 500'"></textarea>
        <span class="char-count" id="pev-desc-count">0 / 500</span>
      </div>

      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Date Start <span style="color:var(--red);">*</span></label>
          <input type="date" id="pev-date-start" class="form-input" min="${today}"
            onchange="document.getElementById('pev-date-end').min=this.value" />
        </div>
        <div class="form-group">
          <label class="form-label">Date End <span style="color:var(--red);">*</span></label>
          <input type="date" id="pev-date-end" class="form-input" min="${today}" />
        </div>
      </div>

      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Time Start <span style="color:var(--red);">*</span></label>
          <input type="time" id="pev-time-start" class="form-input" />
        </div>
        <div class="form-group">
          <label class="form-label">Time End <span style="color:var(--red);">*</span></label>
          <input type="time" id="pev-time-end" class="form-input" />
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Location <span style="color:var(--red);">*</span></label>
        <input type="text" id="pev-location" class="form-input" placeholder="e.g. Barangay Hall" maxlength="100" />
      </div>

      <div class="form-group">
        <label class="form-label">
          Photos <span style="color:var(--gray-400);font-weight:400;font-size:.75rem;">(optional · up to 4)</span>
        </label>
        <label for="pev-photos"
          style="display:flex;align-items:center;gap:.6rem;padding:.6rem .75rem;
            border:1.5px dashed #d1d5db;border-radius:8px;cursor:pointer;
            font-size:.82rem;color:#6b7280;background:#fafafa;transition:all .2s;"
          onmouseover="this.style.borderColor='var(--green-dark)';this.style.color='var(--green-dark)'"
          onmouseout="this.style.borderColor='#d1d5db';this.style.color='#6b7280'">
          <i data-lucide="image" style="width:15px;height:15px;flex-shrink:0;"></i>
          <span id="pev-photo-label">Tap to add photos (up to 4)</span>
        </label>
        <input type="file" id="pev-photos" accept="image/jpeg,image/png,image/webp" multiple
          style="display:none;" onchange="window._proposePreviewImages(this)" />
        <div id="pev-photo-previews" style="display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.5rem;"></div>
      </div>

      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">
            Total Slots <span style="color:var(--gray-400);font-weight:400;font-size:.75rem;">(blank = unlimited)</span>
          </label>
          <input type="number" id="pev-slots" class="form-input" min="1" placeholder="e.g. 50" />
        </div>
        <div class="form-group" style="display:flex;align-items:flex-end;padding-bottom:2px;">
          <label class="events-my-toggle" style="display:flex;">
            <input type="checkbox" id="pev-walkin" class="toggle-input" />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span style="font-size:var(--text-sm);font-weight:var(--fw-semibold);color:var(--gray-700);margin-left:var(--space-sm);">Walk-in welcome</span>
          </label>
        </div>
      </div>

      <p style="background:#f9fafb;border:1px solid var(--gray-100);border-radius:var(--radius-sm);
        padding:var(--space-sm) var(--space-md);font-size:var(--text-xs);color:var(--gray-500);margin:0;">
        <i data-lucide="info" style="width:12px;height:12px;display:inline;vertical-align:middle;margin-right:4px;"></i>
        You may submit 1 event per day. Your submission will be reviewed before going live.
      </p>

      <div id="pev-error" style="display:none;background:#fef2f2;border:1px solid #fecaca;
        border-radius:var(--radius-sm);padding:var(--space-sm) var(--space-md);
        font-size:var(--text-sm);color:var(--red);"></div>

    </div>`;

  const submitBtn = document.getElementById('proposeEventSubmitBtn');
  if (submitBtn) {
    submitBtn.disabled  = false;
    submitBtn.onclick   = window._proposeSubmit;
    submitBtn.innerHTML = '<i data-lucide="send"></i> Submit for Review';
  }

  if (typeof lucide !== 'undefined') lucide.createIcons({ el: body });
  openModal('proposeEventModal');
  /* #7 — officer/admin notice */
  if (_role === 'admin' || _role === 'officer') {
    const _nb = document.getElementById('proposeEventBody');
    if (_nb && !_nb.querySelector('.propose-role-notice')) {
      const _ni = document.createElement('div');
      _ni.className = 'propose-role-notice';
      _ni.style.cssText = 'display:flex;align-items:flex-start;gap:.5rem;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:.6rem .85rem;font-size:.78rem;color:#1e40af;margin-bottom:.75rem;';
      _ni.innerHTML = `<i data-lucide="info" style="width:14px;height:14px;flex-shrink:0;margin-top:1px;"></i>
        <span>Submitting as <strong>${_role === 'admin' ? 'Admin' : 'Officer'}</strong> — this will be tagged as a <strong>Community</strong> event. To create an <strong>Official</strong> event, use the <a href="/admin.html" style="color:#1e40af;font-weight:700;text-decoration:underline;">Admin Panel</a> instead.</span>`;
      _nb.prepend(_ni);
      if (typeof lucide !== 'undefined') lucide.createIcons({ el: _ni });
    }
  }
}


window._proposePreviewImages = function (input) {
  if (input.files?.length) {
    Array.from(input.files).forEach(f => {
      const dup = _proposeFiles.some(e => e.name === f.name && e.size === f.size);
      if (!dup) _proposeFiles.push(f);
    });
  }
  if (_proposeFiles.length > 4) _proposeFiles = _proposeFiles.slice(0, 4);

  const container = document.getElementById('pev-photo-previews');
  const label     = document.getElementById('pev-photo-label');
  if (!container) return;
  container.innerHTML = '';

  if (!_proposeFiles.length) {
    if (label) label.textContent = 'Tap to add photos (up to 4)';
    return;
  }
  if (label) label.textContent = `${_proposeFiles.length} photo${_proposeFiles.length > 1 ? 's' : ''} selected`;

  _proposeFiles.forEach((file, idx) => {
    const reader = new FileReader();
    reader.onload = e => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;width:80px;height:60px;flex-shrink:0;';
      const img = document.createElement('img');
      img.src = e.target.result;
      img.style.cssText = 'width:80px;height:60px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb;display:block;';
      const rm = document.createElement('button');
      rm.innerHTML = '×';
      rm.style.cssText = 'position:absolute;top:-5px;right:-5px;width:18px;height:18px;border-radius:50%;background:#dc2626;color:#fff;border:none;cursor:pointer;font-size:.75rem;line-height:1;display:flex;align-items:center;justify-content:center;';
      rm.onclick = () => { _proposeFiles.splice(idx, 1); window._proposePreviewImages({ files: null }); };
      wrap.appendChild(img);
      wrap.appendChild(rm);
      container.appendChild(wrap);
    };
    reader.readAsDataURL(file);
  });
};


async function _checkDailyLimit() {
  const today = new Date().toISOString().slice(0, 10);
  const start = Timestamp.fromDate(new Date(today + 'T00:00:00'));
  const end   = Timestamp.fromDate(new Date(today + 'T23:59:59'));
  const snap  = await getDocs(query(
    eventsCol(_barangayId),
    where('submittedBy', '==', _uid),
    where('createdAt',   '>=', start),
    where('createdAt',   '<=', end),
  ));
  return snap.size >= 1;
}


window._proposeSubmit = async function () {
  const errEl     = document.getElementById('pev-error');
  const btn       = document.getElementById('proposeEventSubmitBtn');
  const showErr   = msg => {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.style.display = 'block';
    errEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const title     = document.getElementById('pev-title')?.value.trim();
  const category  = document.getElementById('pev-category')?.value;
  const desc      = document.getElementById('pev-desc')?.value.trim();
  const dateStart = document.getElementById('pev-date-start')?.value;
  const dateEnd   = document.getElementById('pev-date-end')?.value;
  const timeStart = document.getElementById('pev-time-start')?.value;
  const timeEnd   = document.getElementById('pev-time-end')?.value;
  const location  = document.getElementById('pev-location')?.value.trim();
  const slots     = document.getElementById('pev-slots')?.value?.trim();
  const walkin    = document.getElementById('pev-walkin')?.checked ?? false;
  const today     = new Date().toISOString().slice(0, 10);

  /* Validation */
  if (!title)              return showErr('Please enter a title.');
  if (!category)           return showErr('Please select a category.');
  if (!desc)               return showErr('Please enter a description.');
  if (!dateStart)          return showErr('Please select a start date.');
  if (dateStart < today)   return showErr('Start date cannot be in the past.');
  if (!dateEnd)            return showErr('Please select an end date.');
  if (dateEnd < dateStart) return showErr('End date cannot be before start date.');
  if (!timeStart)          return showErr('Please enter a start time.');
  if (!timeEnd)            return showErr('Please enter an end time.');
  if (!location)           return showErr('Please enter a location.');
  if (slots !== '' && slots !== null && parseInt(slots, 10) < 1)
                           return showErr('Total slots must be at least 1, or leave blank for unlimited.');
  if (errEl) errEl.style.display = 'none';

  btn.disabled    = true;
  btn.textContent = 'Submitting…';

  try {
    /* Anti-spam */
    if (await _checkDailyLimit()) {
      showErr('You may only submit 1 event per day. Please try again tomorrow.');
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="send"></i> Submit for Review';
      if (typeof lucide !== 'undefined') lucide.createIcons({ el: btn });
      return;
    }

    /* #10 — approval setting */
    let _requireApproval = true;
    try {
      const _setSnap = await getDoc(doc(db, 'barangays', _barangayId, 'meta', 'settings'));
      _requireApproval = _setSnap.data()?.requireEventApproval ?? true;
    } catch { /* non-fatal */ }

    /* Upload photos */
    let imageURLs = [];
    if (_proposeFiles.length) {
      const { getStorage, ref, uploadBytes, getDownloadURL } =
        await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js');
      const storage = getStorage();
      imageURLs = await Promise.all(
        _proposeFiles.map(async file => {
          const sRef = ref(storage, `barangays/${_barangayId}/events/${_uid}/${Date.now()}_${file.name}`);
          await uploadBytes(sRef, file);
          return getDownloadURL(sRef);
        })
      );
    }

    /* Write — isApproved: false so it won't appear in the public grid */
    await addDoc(eventsCol(_barangayId), {
      title,
      description:       desc,
      category,
      dateStart,
      dateEnd,
      timeStart,
      timeEnd,
      location,
      imageURLs,
      imageURL:          imageURLs[0] ?? null,
      totalSlots:        slots ? parseInt(slots, 10) : null,
      isWalkIn:          walkin,
      showSlotsPublicly: true,
      waitlistEnabled:   !!slots,
      submittedBy:       _uid,
      submittedByName:   _userName,
      authorRole:        'resident',
      isApproved:        !_requireApproval,
      status:            'active',
      statusReason:      '',
      isPinned:          false,
      attendees:         [],
      waitlist:          [],
      createdAt:         serverTimestamp(),
      updatedAt:         serverTimestamp(),
    });

    /* Notify officers/admins — wrapped; full wiring in Phase 7 */
    try {
      const { notifyAllInBarangay } =
        await import('/js/features/community/notifications.js');
      await notifyAllInBarangay(
        _barangayId,
        { type: 'event_pending', actorId: _uid, actorName: _userName, postId: '', postTitle: title },
        { targetRoles: 'officials' },
      );
    } catch { /* non-fatal — Phase 7 will add a Cloud Function fallback */ }

    _proposeFiles = [];
    closeModal('proposeEventModal');
    _showToast('Your event has been submitted and is awaiting review.');

  } catch (err) {
    console.error('[events] propose submit', err);
    showErr(err.message || 'Something went wrong. Please try again.');
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="send"></i> Submit for Review';
    if (typeof lucide !== 'undefined') lucide.createIcons({ el: btn });
  }
};

// ================================================
// BOOTSTRAP
// ================================================

/*
   Resolves auth state → userIndex → barangayId → initEvents.
   Shares the same auth listener pattern as community-polls.js
   and bulletin.js so they race-free resolve in parallel.
*/
onAuthStateChanged(auth, async user => {
  const grid = document.getElementById('eventsCardsGrid');
  if (!grid) return; // not on community page

  if (!user) {
    /* Guest — still show events if they exist, just no RSVP or propose */
    /* If _communityBid is already set by bulletin.js bootstrap, reuse it */
    if (window._communityBid) {
      _barangayId = window._communityBid;
      _wireFilters();
      _wireViewToggle();
      _renderSkeleton(grid);
      _subscribe(grid);
    } else {
      grid.innerHTML = _buildEmptyState();
    }
    return;
  }

  try {
    const snap  = await getDoc(userIndexDoc(user.uid));
    if (!snap.exists()) return;
    const { barangay, role } = snap.data();
    _userName = snap.data().displayName ?? snap.data().name ?? user.displayName ?? 'Resident';

    await initEvents(
      toBid(barangay),
      user.uid,
      role ?? 'resident',
    );
  } catch (err) {
    console.error('[events] bootstrap error', err);
    _showToast('Failed to load events.', 'error');
  }
});