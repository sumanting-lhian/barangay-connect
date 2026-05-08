/* ================================================
   events-admin.js — BarangayConnect
   Admin/officer Events management panel.
   Lives inside Community Board tab, replacing Services.
   Mirrors bulletin-admin.js structure exactly.

   Filter tabs: All Events | Pending | Official | Community

   WHAT IS IN HERE:
     · onAuthStateChanged bootstrap
     · Filter-based single list renderer
     · Approval queue (Pending filter) — View + Approve + Reject
     · Event detail viewer for pending submissions
     · Official event create / edit / delete form (bottom, like bulletin)
     · Attendee viewer modal — remove attendee, increase slots
     · showConfirm for all destructive actions

   WHAT IS NOT IN HERE:
     · Firebase config          → firebase-config.js
     · Firestore path helpers   → db-paths.js
     · Resident-facing events   → events.js
     · Global modal styles      → frames.css

   REQUIRED IMPORTS:
     · /js/core/firebase-config.js
     · /js/core/db-paths.js
     · /js/core/storage.js
     · /js/shared/confirm-modal.js
     · firebase-firestore.js@10.12.0
     · firebase-auth.js@10.12.0

   QUICK REFERENCE:
     Filter switch     → window.setEventsAdminFilter(filter, btn)
     View pending      → window.viewEventAdminDetail(id)
     Approve           → window.approveEvent(id)
     Reject            → window.rejectEvent(id)
     Edit (official)   → window.editEventAdmin(id)
     Save form         → window.eventAdminSave()
     Cancel edit       → window.eventAdminCancelEdit()
     Show create form  → window.eventAdminShowForm()
     Delete            → window.deleteEventAdmin(id, title)
     View attendees    → window.viewEventAttendees(id)
     Remove attendee   → window.removeAttendeeAdmin(eventId, uid)
     Increase slots    → window.increaseSlotsAdmin(eventId)
================================================ */


// ================================================
// IMPORTS
// ================================================

import { auth, db }                                        from '/js/core/firebase-config.js';
import { userIndexDoc, eventsCol, eventDoc,
         eventRsvpsCol, eventPhotoPath,
         barangayId as toBid }                             from '/js/core/db-paths.js';
import { uploadImage }                                     from '/js/core/storage.js';
import { showConfirm }                                     from '/js/shared/confirm-modal.js';

import {
  onSnapshot, addDoc, updateDoc, deleteDoc, doc,
  serverTimestamp, orderBy, query, where,
  getDoc, getDocs, arrayUnion, arrayRemove, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";


// ================================================
// MODULE STATE
// ================================================

let _pending    = [];   // isApproved: false
let _official   = [];   // authorRole: 'official', isApproved: true
let _community  = [];   // authorRole: 'resident', isApproved: true
let _editId     = null;
let _formVisible = false;
let _activeFilter = 'all';  // 'all' | 'pending'
let _activeSource = 'all';  // 'all' | 'official' | 'community'
let _barangay   = null;
let _uid        = null;
let _userName   = 'Admin';
let _imageFiles = [];


// ================================================
// CONSTANTS
// ================================================

const CATS = {
  health:     'Health',
  sports:     'Sports',
  youth:      'Youth',
  livelihood: 'Livelihood',
  culture:    'Culture',
  seniors:    'Seniors',
  community:  'Community',
};

/* Shared inline style strings — mirrors bulletin-admin.js */
const LS = `display:block;font-size:.73rem;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:4px;letter-spacing:.04em;`;
const IS = `width:100%;padding:.55rem .75rem;border:1.5px solid #e0e0e0;border-radius:8px;font-size:.875rem;outline:none;transition:border-color .15s;box-sizing:border-box;`;


// ================================================
// BOOTSTRAP
// ================================================

onAuthStateChanged(auth, async (user) => {
  if (!document.getElementById('eventsAdminList')) return;
  if (!user) return;

  const snap = await getDoc(userIndexDoc(user.uid));
  if (!snap.exists()) return;
  const { barangay, role } = snap.data();
  if (role !== 'admin' && role !== 'officer') return;

  _barangay = barangay;
  _uid      = user.uid;
  _userName = snap.data().fullName ?? snap.data().displayName ?? user.displayName ?? 'Admin';

  /* Pending — awaiting approval */
  onSnapshot(
    query(eventsCol(_barangay), where('isApproved', '==', false), orderBy('createdAt', 'desc')),
    s => {
      _pending = s.docs.map(d => ({ id: d.id, ...d.data() }));
      _syncBadge(_pending.length);
      if (_activeFilter === 'pending' || _activeFilter === 'all') _renderEventsList();
    }
  );

  /* Official events */
  onSnapshot(
    query(
      eventsCol(_barangay),
      where('authorRole', '==', 'official'),
      orderBy('isPinned', 'desc'),
      orderBy('createdAt', 'desc'),
    ),
    s => {
      _official = s.docs.map(d => ({ id: d.id, ...d.data() }));
      _renderEventsList();
      if (!_editId && !_formVisible) _renderForm(null);
    }
  );

  /* Community (approved resident submissions) */
  onSnapshot(
    query(
      eventsCol(_barangay),
      where('authorRole', '==', 'resident'),
      where('isApproved', '==', true),
      orderBy('createdAt', 'desc'),
    ),
    s => {
      _community = s.docs.map(d => ({ id: d.id, ...d.data() }));
      if (_activeFilter === 'community' || _activeFilter === 'all') _renderEventsList();
    }
  );

});

/* Auto-delete completed events past the configured threshold */
  (async () => {
    try {
      const settingsSnap = await getDoc(doc(db, 'barangays', toBid(_barangay), 'meta', 'settings'));
      const deleteDays   = settingsSnap.data()?.completedEventDeleteDays ?? 1;
      const cutoff       = new Date();
      cutoff.setDate(cutoff.getDate() - deleteDays);

      const q = query(eventsCol(_barangay), where('status', '==', 'completed'));
      const snap = await getDocs(q);
      snap.docs.forEach(async d => {
        const updated = d.data().updatedAt?.toDate?.() ?? d.data().createdAt?.toDate?.();
        if (updated && updated < cutoff) {
          await deleteDoc(eventDoc(_barangay, d.id));
        }
      });
    } catch (err) {
      console.warn('[events-admin] auto-delete check failed:', err.message);
    }
  })();

  
  _renderEventsList();
  _renderForm(null);

// ================================================
// FILTER SWITCHER
// ================================================

window.setEventsAdminFilter = function (filter, btn) {
  _activeFilter = filter;
  document.querySelectorAll('.events-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  /* Hide source row when showing pending (pending are always community submissions) */
  const sourceRow = document.getElementById('eventsAdminSourceRow');
  if (sourceRow) sourceRow.style.display = filter === 'pending' ? 'none' : '';

  _renderEventsList();
  if (!_editId && !_formVisible) _renderForm(null);
};

window.setEventsAdminSource = function (source, btn) {
  _activeSource = source;
  document.querySelectorAll('.events-source-btn').forEach(b => b.classList.remove('is-active'));
  if (btn) btn.classList.add('is-active');
  _renderEventsList();
};


// ================================================
// LIST RENDERER
// ================================================

/*
   Single renderer that filters _pending / _official / _community
   based on _activeFilter and renders rows into #eventsAdminList.
   Mirrors how renderList works in bulletin-admin.js.
*/
function _renderEventsList() {
  const el = document.getElementById('eventsAdminList');
  if (!el) return;

  let events;
  if (_activeFilter === 'pending') {
    events = _pending;
  } else {
    const all = [..._official, ..._community].sort((a, b) =>
      (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0)
    );
    if (_activeSource === 'official')  events = _official;
    else if (_activeSource === 'community') events = _community;
    else events = all;
  }

  if (!events.length) {
    el.innerHTML = _emptyState(
      _activeFilter === 'pending' ? 'clock' : 'calendar-x',
      _activeFilter === 'pending' ? 'No Pending Submissions' : 'No Events Found',
      _activeFilter === 'pending'
        ? 'Community submissions awaiting approval will appear here.'
        : 'Events will appear here once created or approved.'
    );
    lucide.createIcons({ el });
    return;
  }

  /* Header row — mirrors bulletin's grid header */
  el.innerHTML = `
    <div style="background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.07);overflow:hidden;">
      <div style="display:grid;grid-template-columns:2fr 1fr auto;padding:.55rem 1.25rem;
        border-bottom:1.5px solid #f0f0f0;font-size:.7rem;font-weight:700;text-transform:uppercase;
        letter-spacing:.07em;color:#bbb;background:#fafafa;">
        <span>Title &amp; Category</span>
        <span>Date &amp; Slots</span>
        <span></span>
      </div>
      ${events.map(ev => _buildRow(ev)).join('')}
    </div>`;

  lucide.createIcons({ el });
}


// ================================================
// ROW BUILDER
// ================================================

/*
   Single row builder. Action buttons vary by:
   - _activeFilter === 'pending'  → View + Approve + Reject  (no edit until approved)
   - official                     → Attendees + Edit + Delete
   - community                    → Attendees + Delete
   - all                          → same as above based on authorRole
   Mirrors bulletin-admin.js buildListRow inline button style exactly.
*/
function _buildRow(ev) {
  const isEditing  = _editId === ev.id;
  const isPending  = !ev.isApproved;
  const isOfficial = ev.authorRole === 'official';

  const cat     = CATS[ev.category] ?? ev.category ?? '—';
  const _fmtD   = s => s ? new Date(s + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const date    = ev.dateStart
    ? `${_fmtD(ev.dateStart)}${ev.dateEnd && ev.dateEnd !== ev.dateStart ? ` – ${_fmtD(ev.dateEnd)}` : ''}`
    : '—';
  const taken   = ev.attendees?.length ?? 0;
  const slots   = ev.totalSlots != null ? `${taken} / ${ev.totalSlots} slots` : `${taken} attending`;

  const _statusMeta = {
    postponed: { cls: 'admin-badge--pending',  label: 'Postponed' },
    cancelled: { cls: 'admin-badge--urgent',   label: 'Cancelled' },
    completed: { cls: 'admin-badge--inactive', label: 'Completed' },
  };
  const statusBadge = ev.status && ev.status !== 'active' && _statusMeta[ev.status]
    ? `<span class="admin-badge ${_statusMeta[ev.status].cls}" style="text-transform:none;">${_statusMeta[ev.status].label}</span>`
    : '';

  const pinnedBadge = ev.isPinned
    ? `<span class="admin-badge admin-badge--pinned"><i data-lucide="pin"></i> Pinned</span>`
    : '';

  const editingBadge = isEditing
    ? `<span class="admin-badge admin-badge--editing">Editing</span>`
    : '';

  const sourceBadge = `<span class="admin-badge admin-badge--${isOfficial ? 'active' : 'pending'}"
    style="text-transform:none;">${isOfficial ? 'Official' : 'Community'}</span>`;

  const _evImgs = ev.imageURLs?.length ? ev.imageURLs : (ev.imageURL ? [ev.imageURL] : []);
const _evEnc  = encodeURIComponent(JSON.stringify(_evImgs));
const thumb   = _evImgs.length ? `
    <div style="display:flex;gap:.3rem;flex-wrap:wrap;margin-top:5px;">
      ${_evImgs.slice(0,3).map((url, i) => `
        <img src="${esc(url)}" alt=""
          style="width:44px;height:30px;object-fit:cover;border-radius:4px;
            border:1px solid #e5e7eb;display:block;cursor:pointer;"
          onclick="window.openImageViewer(JSON.parse(decodeURIComponent('${_evEnc}')),${i},'${esc(ev.title)}')" />`
      ).join('')}
    </div>` : '';

  /* ── Action buttons — inline styles matching bulletin-admin.js ── */
  let actionsHtml = '';

  if (isPending) {
    /* Pending: View | Approve | Reject */
    actionsHtml = `
      <button onclick="window.viewEventAdminDetail('${esc(ev.id)}')"
        title="View submission"
        style="display:inline-flex;align-items:center;gap:.3rem;padding:5px 10px;
          border-radius:7px;border:1.5px solid #e0e0e0;background:#fff;cursor:pointer;
          color:#555;font-size:.78rem;font-weight:500;transition:all .15s;"
        onmouseover="this.style.background='#f4f6f9'"
        onmouseout="this.style.background='#fff'">
        <i data-lucide="eye" style="width:13px;height:13px;"></i>
      </button>
      <button onclick="window.approveEvent('${esc(ev.id)}')"
        title="Approve"
        style="display:inline-flex;align-items:center;padding:5px 8px;
          border-radius:7px;border:1.5px solid #bbf7d0;background:#f0fdf4;cursor:pointer;
          color:#14532d;transition:all .15s;"
        onmouseover="this.style.background='#dcfce7'"
        onmouseout="this.style.background='#f0fdf4'">
        <i data-lucide="check" style="width:13px;height:13px;"></i> Approve
      </button>
      <button onclick="window.rejectEvent('${esc(ev.id)}')"
        title="Reject"
        style="display:inline-flex;align-items:center;padding:5px 8px;
          border-radius:7px;border:1.5px solid #fecaca;background:#fff;cursor:pointer;
          color:#dc2626;transition:all .15s;"
        onmouseover="this.style.background='#fef2f2'"
        onmouseout="this.style.background='#fff'">
        <i data-lucide="x" style="width:13px;height:13px;"></i> Reject
      </button>`;
  } else {
    /* Approved events: View | Attendees | Edit (official only) | Delete */
    actionsHtml = `
      <button onclick="window.viewEventAdminDetail('${esc(ev.id)}')"
        title="View details"
        style="display:inline-flex;align-items:center;gap:.3rem;padding:5px 10px;
          border-radius:7px;border:1.5px solid #e0e0e0;background:#fff;cursor:pointer;
          color:#555;font-size:.78rem;font-weight:500;transition:all .15s;"
        onmouseover="this.style.background='#f4f6f9'"
        onmouseout="this.style.background='#fff'">
        <i data-lucide="eye" style="width:13px;height:13px;"></i>
      </button>
      <button onclick="window.viewEventAttendees('${esc(ev.id)}')"
        title="View attendees"
        style="display:inline-flex;align-items:center;padding:5px 8px;
          border-radius:7px;border:1.5px solid #e0e0e0;background:#fff;cursor:pointer;
          color:#555;transition:all .15s;"
        onmouseover="this.style.background='#f4f6f9'"
        onmouseout="this.style.background='#fff'">
        <i data-lucide="users" style="width:13px;height:13px;"></i>
      </button>
      ${isOfficial ? `
      <button onclick="window.editEventAdmin('${esc(ev.id)}')"
        title="${isEditing ? 'Cancel editing' : 'Edit'}"
        style="display:inline-flex;align-items:center;gap:.3rem;padding:5px 10px;
          border-radius:7px;border:1.5px solid ${isEditing ? '#dc2626' : '#e0e0e0'};
          background:${isEditing ? '#fff5f5' : '#fff'};cursor:pointer;
          color:${isEditing ? '#dc2626' : '#555'};font-size:.78rem;font-weight:500;transition:all .15s;"
        onmouseover="this.style.background='${isEditing ? '#fee2e2' : '#f4f6f9'}'"
        onmouseout="this.style.background='${isEditing ? '#fff5f5' : '#fff'}'">
        <i data-lucide="${isEditing ? 'x' : 'pencil'}" style="width:13px;height:13px;"></i>
        ${isEditing ? 'Cancel' : 'Edit'}
      </button>` : ''}
      <button onclick="window.deleteEventAdmin('${esc(ev.id)}','${esc(ev.title)}')"
        title="Delete permanently"
        style="display:inline-flex;align-items:center;gap:.3rem;padding:5px 10px;
          border-radius:7px;border:1.5px solid #fca5a5;background:#fff;cursor:pointer;
          color:#dc2626;font-size:.78rem;font-weight:500;transition:all .15s;"
        onmouseover="this.style.background='#fef2f2'"
        onmouseout="this.style.background='#fff'">
        <i data-lucide="trash-2" style="width:13px;height:13px;"></i>
      </button>`;
  }

  return `
    <div data-event-id="${esc(ev.id)}" style="
      display:grid;grid-template-columns:2fr 1fr auto;align-items:center;
      gap:.75rem;padding:.9rem 1.25rem;border-bottom:1px solid #f0f0f0;
      transition:background .2s,border-left .2s;
      border-left:3px solid ${ev.status === 'cancelled' ? '#dc2626'
        : ev.status === 'postponed' ? '#FFA135'
        : isPending ? '#fde68a'
        : isOfficial ? 'var(--green-dark)' : '#9ca3af'};
      ${isEditing ? 'background:#f0fdf4;border-left:3px solid #1a3a1a!important;' : ''}
    ">
      <div>
        <div style="font-weight:700;font-size:.9rem;display:flex;align-items:center;
          flex-wrap:wrap;gap:.35rem;margin-bottom:4px;">
          ${esc(ev.title)}
          ${editingBadge}${pinnedBadge}${statusBadge}${sourceBadge}
        </div>
        <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;">
          <span style="font-size:.73rem;color:#6b7280;">${esc(cat)}</span>
          ${ev.location ? `<span style="font-size:.73rem;color:#9ca3af;">· ${esc(ev.location)}</span>` : ''}
          ${ev.submittedByName ? `<span style="font-size:.73rem;color:#9ca3af;">by ${esc(ev.submittedByName)}</span>` : ''}
        </div>
        ${thumb}
      </div>
      <div>
        <div style="font-size:.78rem;color:#555;">${esc(date)}</div>
        <div style="font-size:.73rem;color:#9ca3af;margin-top:2px;">${esc(slots)}</div>
      </div>
      <div style="display:flex;gap:.35rem;align-items:center;flex-shrink:0;">
        ${actionsHtml}
      </div>
    </div>`;
}

window._eaOnStatusChange = function (status) {
  const hide = status !== 'active';
  ['eaDateRow', 'eaTimeRow'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = hide ? 'none' : '';
  });
};


// ================================================
// FORM — Render (Create / Edit Official Events)
// ================================================

function _renderForm(prefill) {
  const el = document.getElementById('eventsAdminForm');
  if (!el) return;

  /* Hide create button entirely when viewing pending submissions */
  if (_activeFilter === 'pending') { el.innerHTML = ''; return; }

  if (!_formVisible && !_editId) {
    el.innerHTML = `
      <button onclick="window.eventAdminShowForm()"
        style="display:flex;align-items:center;justify-content:center;gap:.6rem;
          width:100%;padding:.85rem 1.5rem;border-radius:12px;border:2px dashed #d1d5db;
          background:white;color:#374151;font-size:.9rem;font-weight:600;cursor:pointer;
          transition:all .2s;box-shadow:0 1px 3px rgba(0,0,0,.04);"
        onmouseover="this.style.borderColor='#1a3a1a';this.style.color='#1a3a1a';this.style.background='#f0fdf4'"
        onmouseout="this.style.borderColor='#d1d5db';this.style.color='#374151';this.style.background='white'">
        <i data-lucide="plus-circle" style="width:18px;height:18px;"></i>
        Create Official Event
      </button>`;
    lucide.createIcons({ el });
    return;
  }

  const d      = prefill || {};
  const isEdit = !!_editId;
  const today  = new Date().toISOString().slice(0, 10);

  el.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:1.5rem;box-shadow:0 1px 4px rgba(0,0,0,.07);">

      <div style="display:flex;align-items:center;justify-content:space-between;
        margin-bottom:1.25rem;flex-wrap:wrap;gap:.5rem;">
        <h2 style="font-size:1rem;font-weight:700;margin:0;display:flex;align-items:center;gap:.5rem;">
          <i data-lucide="${isEdit ? 'pencil' : 'plus-circle'}" style="width:17px;height:17px;color:#1a3a1a;"></i>
          ${isEdit ? 'Edit Official Event' : 'Create Official Event'}
        </h2>
        ${isEdit ? `<span style="background:#fef9c3;color:#854d0e;padding:3px 10px;border-radius:999px;
          font-size:.73rem;font-weight:700;border:1px solid #fde68a;">
          Editing: ${esc(d.title || '')}</span>` : ''}
      </div>

      <div style="display:grid;gap:1rem;">

        <div>
          <label style="${LS}">Title</label>
          <input id="eaTitle" type="text" value="${esc(d.title || '')}"
            placeholder="Event title…" maxlength="100" style="${IS}" />
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
          <div>
            <label style="${LS}">Category</label>
            <select id="eaCategory" style="${IS}">
              ${Object.entries(CATS).map(([v, l]) =>
                `<option value="${v}" ${d.category === v ? 'selected' : ''}>${l}</option>`
              ).join('')}
            </select>
          </div>
          <div>
            <label style="${LS}">Status</label>
            <select id="eaStatus" style="${IS}" onchange="window._eaOnStatusChange(this.value)">
              ${isEdit ? `
                <option value="active"    ${(d.status ?? 'active') === 'active'    ? 'selected' : ''}>Active</option>
                <option value="postponed" ${d.status === 'postponed' ? 'selected' : ''}>Postponed</option>
                <option value="cancelled" ${d.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
                <option value="completed" ${d.status === 'completed' ? 'selected' : ''}>Completed</option>
              ` : `
                <option value="active" selected>Active</option>
              `}
            </select>
          </div>
        </div>

        <div>
          <label style="${LS}">Description</label>
          <textarea id="eaDesc" rows="3" maxlength="500"
            placeholder="What is this event about?"
            style="${IS} resize:vertical;">${esc(d.description || '')}</textarea>
        </div>

        <div id="eaDateRow" style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
          <div>
            <label style="${LS}">Date Start</label>
            <input id="eaDateStart" type="date" value="${esc(d.dateStart || '')}" min="${today}" style="${IS}" />
          </div>
          <div>
            <label style="${LS}">Date End</label>
            <input id="eaDateEnd" type="date" value="${esc(d.dateEnd || '')}" min="${today}" style="${IS}" />
          </div>
        </div>

        <div id="eaTimeRow" style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
          <div>
            <label style="${LS}">Time Start</label>
            <input id="eaTimeStart" type="time" value="${esc(d.timeStart || '')}" style="${IS}" />
          </div>
          <div>
            <label style="${LS}">Time End</label>
            <input id="eaTimeEnd" type="time" value="${esc(d.timeEnd || '')}" style="${IS}" />
          </div>
        </div>

        <div>
          <label style="${LS}">Location</label>
          <input id="eaLocation" type="text" value="${esc(d.location || '')}"
            placeholder="e.g. Barangay Hall" maxlength="100" style="${IS}" />
        </div>

        <!-- Image upload -->
        <div>
          <label style="${LS}">Photos (optional · up to 4)</label>
          ${d.imageURL ? `
            <div style="margin-bottom:.5rem;position:relative;display:inline-block;">
              <img src="${esc(d.imageURL)}" alt=""
                style="width:100%;max-height:120px;object-fit:cover;border-radius:8px;
                  border:1px solid #e0e0e0;display:block;" />
              <button type="button"
                onclick="this.closest('div').dataset.remove='1';this.closest('div').style.opacity='.35';
                  this.style.display='none';document.getElementById('eaRemoveImage').checked=true;"
                style="position:absolute;top:-8px;right:-8px;width:22px;height:22px;
                  border-radius:50%;background:#dc2626;color:#fff;border:none;cursor:pointer;
                  font-size:.8rem;display:flex;align-items:center;justify-content:center;">✕</button>
              <input type="checkbox" id="eaRemoveImage" style="display:none;" />
            </div>` : ''}
          <label for="eaImageFile"
            style="display:flex;align-items:center;gap:.6rem;padding:.6rem .75rem;
              border:1.5px dashed #d1d5db;border-radius:8px;cursor:pointer;
              font-size:.82rem;color:#6b7280;background:#fafafa;"
            onmouseover="this.style.borderColor='#1a3a1a';this.style.color='#1a3a1a'"
            onmouseout="this.style.borderColor='#d1d5db';this.style.color='#6b7280'">
            <i data-lucide="image" style="width:15px;height:15px;flex-shrink:0;"></i>
            Tap to add photos (up to 4)
          </label>
          <input type="file" id="eaImageFile" accept="image/jpeg,image/png,image/webp"
            multiple style="display:none;"
            onchange="window._eaPreviewImages(this)" />
          <div id="eaImagePreviews" style="display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.5rem;"></div>
          <input type="hidden" id="eaCurrentImageURL" value="${esc(d.imageURL || '')}" />
        </div>

        <div id="eaSlotsRow" style="display:${d.isWalkIn ? 'none' : 'grid'};grid-template-columns:1fr 1fr;gap:1rem;">
          <div>
            <label style="${LS}">Total Slots (blank = unlimited)</label>
            <input id="eaSlots" type="number" min="1"
              value="${d.totalSlots != null ? d.totalSlots : ''}"
              placeholder="e.g. 100" style="${IS}" />
          </div>
        </div>

        <!-- Admin-only flags -->
        <div style="display:flex;gap:1.5rem;flex-wrap:wrap;align-items:center;">
          ${_checkField('eaPinned',    'pin',       '#c2410c', 'Pin to top',              d.isPinned)}
          ${_checkField('eaShowSlots', 'eye',       '#2563eb', 'Show slot count publicly', d.showSlotsPublicly ?? true)}
          ${_checkField('eaWaitlist',  'list',      '#1a3a1a', 'Enable waitlist',          d.waitlistEnabled)}
          ${_checkField('eaWalkin',    'door-open', '#1a3a1a', 'Walk-in welcome',          d.isWalkIn, 'window._eaOnWalkinChange(this)')}
        </div>

        <div style="display:flex;gap:.6rem;margin-top:.25rem;flex-wrap:wrap;align-items:center;">
          <button type="button" onclick="window.eventAdminSave()"
            style="display:inline-flex;align-items:center;gap:.45rem;padding:.6rem 1.4rem;
              border-radius:8px;background:#1a3a1a;color:#fff;border:none;
              font-size:.9rem;font-weight:600;cursor:pointer;transition:background .15s;"
            onmouseover="this.style.background='#14291a'"
            onmouseout="this.style.background='#1a3a1a'">
            <i data-lucide="send" style="width:15px;height:15px;"></i>
            ${isEdit ? 'Update Event' : 'Publish Event'}
          </button>
          <button type="button" onclick="window.eventAdminCancelEdit()"
            style="padding:.6rem 1.1rem;border-radius:8px;border:1.5px solid #e0e0e0;
              background:#fff;color:#555;font-size:.9rem;font-weight:500;cursor:pointer;"
            onmouseover="this.style.background='#f4f6f9'"
            onmouseout="this.style.background='#fff'">
            ${isEdit ? 'Cancel' : 'Discard'}
          </button>
        </div>

      </div>
    </div>`;

  _imageFiles = [];
  lucide.createIcons({ el });
  if (d.status && d.status !== 'active') window._eaOnStatusChange?.(d.status);
}

window._eaOnWalkinChange = function (checkbox) {
  const row = document.getElementById('eaSlotsRow');
  if (!row) return;
  row.style.display = checkbox.checked ? 'none' : 'grid';
  if (checkbox.checked) {
    const slotsEl = document.getElementById('eaSlots');
    if (slotsEl) slotsEl.value = '';
  }
};

function _checkField(id, icon, color, label, checked, onchange = '') {
  return `
    <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer;
      font-size:.82rem;font-weight:600;color:#555;">
      <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}
        ${onchange ? `onchange="${onchange}"` : ''}
        style="width:15px;height:15px;accent-color:${color};cursor:pointer;" />
      <i data-lucide="${icon}" style="width:14px;height:14px;color:${color};"></i>
      ${label}
    </label>`;
}


// ================================================
// FORM — Show / Cancel / Edit
// ================================================

window.eventAdminShowForm = function () {
  _formVisible = true;
  _editId      = null;
  _renderForm(null);
  document.getElementById('eventsAdminForm')
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.eventAdminCancelEdit = function () {
  _editId      = null;
  _formVisible = false;
  _imageFiles  = [];
  _renderForm(null);
  _renderEventsList();
};

window.editEventAdmin = async function (id) {
  if (_editId === id) {
    window.eventAdminCancelEdit();
    return;
  }
  const snap = await getDoc(eventDoc(_barangay, id));
  if (!snap.exists()) return;

  _editId      = id;
  _formVisible = true;
  _imageFiles  = [];
  _renderForm(snap.data());
  _renderEventsList(); /* re-render so editing badge appears on the row */
  setTimeout(() =>
    document.getElementById('eventsAdminForm')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
};

/* Returns a Promise that resolves with the typed reason, or rejects on cancel */
function _promptStatusReason(newStatus) {
  return new Promise((resolve, reject) => {
    const modal   = document.getElementById('eventsStatusReasonModal');
    const titleEl = document.getElementById('statusReasonModalTitle');
    const inputEl = document.getElementById('statusReasonInput');
    const errEl   = document.getElementById('statusReasonError');
    if (!modal || !inputEl) { resolve(window.prompt(`Reason for ${newStatus}?`) ?? ''); return; }

    if (titleEl) titleEl.textContent = `Reason for marking as ${newStatus.charAt(0).toUpperCase() + newStatus.slice(1)}`;
    inputEl.value = '';
    if (errEl) errEl.style.display = 'none';
    inputEl.style.borderColor = '#e0e0e0';
    modal.classList.add('is-open');
    lucide.createIcons({ el: modal });

    window._statusReasonConfirm = () => {
      const reason = inputEl.value.trim();
      if (!reason) {
        inputEl.style.borderColor = '#dc2626';
        if (errEl) errEl.style.display = '';
        return;
      }
      modal.classList.remove('is-open');
      window._statusReasonConfirm = null;
      window._statusReasonReject  = null;
      resolve(reason);
    };
    window._statusReasonReject = () => {
      modal.classList.remove('is-open');
      window._statusReasonConfirm = null;
      window._statusReasonReject  = null;
      reject(new Error('cancelled'));
    };
  });
}


// ================================================
// FORM — Save (Create / Update)
// ================================================

window.eventAdminSave = async function () {
  const title      = document.getElementById('eaTitle')?.value.trim();
  const category   = document.getElementById('eaCategory')?.value;
  const desc       = document.getElementById('eaDesc')?.value.trim();
  const dateStart  = document.getElementById('eaDateStart')?.value;
  const dateEnd    = document.getElementById('eaDateEnd')?.value;
  const timeStart  = document.getElementById('eaTimeStart')?.value;
  const timeEnd    = document.getElementById('eaTimeEnd')?.value;
  const location   = document.getElementById('eaLocation')?.value.trim();
  const slotsRaw   = document.getElementById('eaSlots')?.value.trim();
  const status     = document.getElementById('eaStatus')?.value || 'active';
  const isPinned   = document.getElementById('eaPinned')?.checked   ?? false;
  const showSlots  = document.getElementById('eaShowSlots')?.checked ?? true;
  const waitlist   = document.getElementById('eaWaitlist')?.checked  ?? false;
  const walkin     = document.getElementById('eaWalkin')?.checked    ?? false;

  if (!title)     return _showToast('Please enter a title.', 'error');
  if (!category)  return _showToast('Please select a category.', 'error');
  if (!desc)      return _showToast('Please enter a description.', 'error');
  if (!dateStart) return _showToast('Please select a start date.', 'error');
  if (!dateEnd)   return _showToast('Please select an end date.', 'error');
  if (!timeStart) return _showToast('Please enter a start time.', 'error');
  if (!location)  return _showToast('Please enter a location.', 'error');

  /* ── Safety checks and status reason (before disabling button so user can cancel) ── */
  let statusReason = '';
  let origEv = null;
  if (_editId) {
    origEv = [..._official, ..._community].find(e => e.id === _editId);
    if (origEv) {
      const currentAttendees = origEv.attendees?.length ?? 0;
      const currentWaitlist  = origEv.waitlist?.length  ?? 0;
      const newSlots = slotsRaw ? parseInt(slotsRaw, 10) : null;

      /* Prevent reducing slots below registered count */
      if (newSlots !== null && newSlots < currentAttendees) {
        return _showToast(`Cannot reduce slots to ${newSlots} — ${currentAttendees} people are already registered.`, 'error');
      }
      /* Warn if disabling waitlist while people are queued */
      if (!waitlist && origEv.waitlistEnabled && currentWaitlist > 0) {
        const ok = await showConfirm({
          title: 'Disable Waitlist?',
          body: `${currentWaitlist} ${currentWaitlist === 1 ? 'person is' : 'people are'} currently on the waitlist. They will remain but won't be auto-promoted if a slot opens.`,
          confirm: 'Disable Anyway', cancel: 'Keep Waitlist', variant: 'warning',
        });
        if (!ok) return;
      }
      /* Warn if enabling walk-in while registrations exist */
      if (walkin && !origEv.isWalkIn && currentAttendees > 0) {
        const ok = await showConfirm({
          title: 'Enable Walk-in?',
          body: `${currentAttendees} people are already registered. Enabling walk-in removes slot restrictions — existing registrations are unaffected.`,
          confirm: 'Enable Anyway', cancel: 'Cancel', variant: 'warning',
        });
        if (!ok) return;
      }

      /* Status reason prompt */
      const origStatus = origEv.status ?? 'active';
      if ((status === 'postponed' || status === 'cancelled') && status !== origStatus) {
        try { statusReason = await _promptStatusReason(status); }
        catch { return; } /* user cancelled */
      } else if (status === 'active') {
        statusReason = ''; /* clear reason when restoring to active */
      } else {
        statusReason = origEv.statusReason ?? ''; /* keep existing reason for completed, etc. */
      }
    }
  }

  const saveBtn = document.querySelector('#eventsAdminForm button[onclick="window.eventAdminSave()"]');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  try {
    /* Resolve images */
    const currentURL  = document.getElementById('eaCurrentImageURL')?.value || null;
    const removeImage = document.getElementById('eaRemoveImage')?.checked ?? false;
    const fileEl      = document.getElementById('eaImageFile');
    const newFiles    = _imageFiles.length
      ? _imageFiles
      : (fileEl?.files ? Array.from(fileEl.files).slice(0, 4) : []);

    let imageURLs = [];
    if (removeImage) {
      imageURLs = [];
    } else if (newFiles.length) {
      for (const file of newFiles) {
        const path = eventPhotoPath(
          _barangay, _uid,
          `${Date.now()}-${Math.random().toString(36).slice(2)}.webp`
        );
        imageURLs.push(await uploadImage(file, path));
      }
    } else if (currentURL) {
      imageURLs = [currentURL];
    }

    const payload = {
      title, category, description: desc, dateStart, dateEnd,
      timeStart, timeEnd, location, status, statusReason,
      totalSlots:        slotsRaw ? parseInt(slotsRaw, 10) : null,
      isPinned,
      showSlotsPublicly: showSlots,
      waitlistEnabled:   waitlist,
      isWalkIn:          walkin,
      imageURLs,
      imageURL:          imageURLs[0] ?? null,
      updatedAt:         serverTimestamp(),
    };

    if (_editId) {
      await updateDoc(eventDoc(_barangay, _editId), payload);
      _showToast('Event updated.');
      if (origEv && (status === 'postponed' || status === 'cancelled')
          && status !== (origEv.status ?? 'active')) {
        try {
          const { sendNotification: _sn } = await import('/js/features/community/notifications.js');
          await Promise.all((origEv.attendees ?? []).map(aUid =>
            _sn(_barangay, aUid, { type: 'status_change', actorId: 'system',
              actorName: 'BarangayConnect', postId: _editId, postTitle: payload.title })
          ));
        } catch { /* non-fatal */ }
      }
    } else {
      await addDoc(eventsCol(_barangay), {
        ...payload,
        authorRole:      'official',
        isApproved:      true,
        submittedBy:     _uid,
        submittedByName: _userName,
        attendees:       [],
        waitlist:        [],
        statusReason:    '',
        createdAt:       serverTimestamp(),
      });
      _showToast('Event published.');
    }

    _editId      = null;
    _formVisible = false;
    _imageFiles  = [];
    _renderForm(null);

  } catch (err) {
    console.error('[events-admin] save error:', err.code, err.message);
    _showToast(`Failed to save: ${err.message}`, 'error');
    if (saveBtn) {
      saveBtn.disabled    = false;
      saveBtn.textContent = _editId ? 'Update Event' : 'Publish Event';
    }
  }
};


// ================================================
// ACTIONS — Approve / Reject
// ================================================

window.approveEvent = async function (id) {
  const ev = _pending.find(e => e.id === id);
  const ok = await showConfirm({
    title:   'Approve Event?',
    body:    `<strong>${esc(ev?.title ?? 'This event')}</strong> will go live on the public grid.`,
    confirm: 'Approve',
    cancel:  'Go Back',
  });
  if (!ok) return;
  try {
    await updateDoc(eventDoc(_barangay, id), {
      isApproved: true, updatedAt: serverTimestamp(),
    });
    _showToast('Event approved and is now live.');
    try {
      const { sendNotification } = await import('/js/features/community/notifications.js');
      await sendNotification(_barangay, ev?.submittedBy, {
        type: 'event_approved', actorId: 'system', actorName: 'BarangayConnect',
        postId: id, postTitle: ev?.title ?? 'Your event',
      });
    } catch { /* non-fatal */ }
  } catch {
    _showToast('Could not approve. Try again.', 'error');
  }
};

window.rejectEvent = async function (id) {
  const ev  = _pending.find(e => e.id === id);
  const ok  = await showConfirm({
    title:   'Reject Submission?',
    body:    `<strong>${esc(ev?.title ?? 'This event')}</strong> will be permanently removed.`,
    confirm: 'Reject & Delete',
    cancel:  'Go Back',
    variant: 'danger',
  });
  if (!ok) return;
  try {
    await deleteDoc(eventDoc(_barangay, id));
    _showToast('Submission rejected and removed.', 'error');
    try {
      const { sendNotification } = await import('/js/features/community/notifications.js');
      await sendNotification(_barangay, ev?.submittedBy, {
        type: 'event_rejected', actorId: 'system', actorName: 'BarangayConnect',
        postId: id, postTitle: ev?.title ?? 'Your event',
      });
    } catch { /* non-fatal */ }
  } catch {
    _showToast('Could not reject. Try again.', 'error');
  }
};


// ================================================
// ACTIONS — Delete
// ================================================

window.deleteEventAdmin = async function (id, title) {
  const ok = await showConfirm({
    title:   'Delete Event?',
    body:    `<strong>${esc(title)}</strong> will be permanently removed.`,
    confirm: 'Delete',
    cancel:  'Go Back',
    variant: 'danger',
  });
  if (!ok) return;
  try {
    await deleteDoc(eventDoc(_barangay, id));
    if (_editId === id) { _editId = null; _formVisible = false; _renderForm(null); }
    _showToast('Event deleted.', 'error');
  } catch {
    _showToast('Could not delete. Try again.', 'error');
  }
};

/* ── Quick status manager — prompts for reason on non-active transitions ── */
window.updateEventStatus = async function(eventId, newStatus) {
  const evRef = eventDoc(_barangay, eventId);
  try {
    if (newStatus !== 'active') {
      const reason = prompt(`Reason for marking as ${newStatus}?`);
      if (!reason) return;
      await updateDoc(evRef, { status: newStatus, statusReason: reason, updatedAt: serverTimestamp() });
    } else {
      await updateDoc(evRef, { status: 'active', statusReason: '', updatedAt: serverTimestamp() });
    }
    _showToast(`Status changed to ${newStatus}.`);
  } catch { _showToast('Could not update status.', 'error'); }
};


// ================================================
// PENDING — Event Detail Viewer
// ================================================

/*
   Read-only detail modal for reviewing pending submissions.
   Shows images through openImageViewer if available.
   Approve / Reject buttons in footer.
*/
window.viewEventAdminDetail = async function (id) {
  const modal   = document.getElementById('eventsDetailModal');
  const bodyEl  = document.getElementById('eventsDetailBody');
  const titleEl = document.getElementById('eventsDetailTitle');
  const metaEl  = document.getElementById('eventsDetailMeta');
  const footerEl = document.getElementById('eventsDetailFooter');
  if (!modal || !bodyEl) return;

  bodyEl.innerHTML = `<div style="text-align:center;padding:2rem;color:#aaa;">Loading…</div>`;
  modal.classList.add('is-open');

  const ev = _pending.find(e => e.id === id) || await getDoc(eventDoc(_barangay, id))
    .then(s => s.exists() ? { id: s.id, ...s.data() } : null);

  if (!ev) {
    bodyEl.innerHTML = `<div style="text-align:center;padding:2rem;color:#dc2626;">Event not found.</div>`;
    return;
  }

  if (titleEl) titleEl.textContent = ev.title;
  if (metaEl) metaEl.textContent =
    `Submitted by ${ev.submittedByName ?? 'Resident'} · ${CATS[ev.category] ?? ev.category}`;

  const imgs   = ev.imageURLs?.length ? ev.imageURLs : (ev.imageURL ? [ev.imageURL] : []);
  const date   = ev.dateStart
    ? `${ev.dateStart}${ev.dateEnd && ev.dateEnd !== ev.dateStart ? ` – ${ev.dateEnd}` : ''}`
    : '—';
  const timeStr = ev.timeStart
    ? `${ev.timeStart}${ev.timeEnd ? ` – ${ev.timeEnd}` : ''}`
    : '';
  const taken  = ev.attendees?.length ?? 0;
  const slots  = ev.totalSlots != null ? `${ev.totalSlots} slots total` : 'Unlimited';

  const imgsHtml = imgs.length ? `
    <div>
      <p class="modal-section-label">Photos</p>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.25rem;">
        ${imgs.map((url, i) => `
          <img src="${esc(url)}" alt="Event photo ${i + 1}"
            style="width:80px;height:60px;object-fit:cover;border-radius:8px;
              border:1px solid #e5e7eb;cursor:pointer;"
            onclick="window.eventOpenViewer(['${imgs.map(u => esc(u)).join("','")}'],${i},'${esc(ev.title)}','${esc(ev.id)}')" />`
        ).join('')}
      </div>
    </div>` : '';

  bodyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:var(--space-md);">
      <div>
        <p class="modal-section-label">Date &amp; Time</p>
        <p style="font-size:var(--text-sm);color:#374151;margin:0;">
          ${esc(date)}${timeStr ? ` · ${esc(timeStr)}` : ''}
        </p>
      </div>
      ${ev.location ? `<div>
        <p class="modal-section-label">Location</p>
        <p style="font-size:var(--text-sm);color:#374151;margin:0;">${esc(ev.location)}</p>
      </div>` : ''}
      ${ev.description ? `<div>
        <p class="modal-section-label">Description</p>
        <p style="font-size:var(--text-sm);color:#374151;line-height:1.6;margin:0;">
          ${esc(ev.description)}
        </p>
      </div>` : ''}
      <div>
        <p class="modal-section-label">Capacity</p>
        <p style="font-size:var(--text-sm);color:#374151;margin:0;">
          ${esc(slots)}${ev.isWalkIn ? ' · Walk-in welcome' : ''}
          ${ev.waitlistEnabled ? ' · Waitlist enabled' : ''}
        </p>
      </div>
      ${imgsHtml}
    </div>`;

  if (footerEl) {
    footerEl.innerHTML = ev.isApproved
      ? `<button class="btn btn--outline"
           onclick="document.getElementById('eventsDetailModal').classList.remove('is-open')">
           Close
         </button>`
      : `<button class="btn btn--outline"
           onclick="document.getElementById('eventsDetailModal').classList.remove('is-open')">
           Close
         </button>
         <button onclick="document.getElementById('eventsDetailModal').classList.remove('is-open');window.rejectEvent('${esc(ev.id)}')"
           style="display:inline-flex;align-items:center;gap:.4rem;padding:.6rem 1.2rem;
             border-radius:8px;border:1.5px solid #fca5a5;background:#fff;color:#dc2626;
             font-size:.9rem;font-weight:600;cursor:pointer;">
           <i data-lucide="x" style="width:14px;height:14px;"></i> Reject
         </button>
         <button onclick="document.getElementById('eventsDetailModal').classList.remove('is-open');window.approveEvent('${esc(ev.id)}')"
           style="display:inline-flex;align-items:center;gap:.4rem;padding:.6rem 1.2rem;
             border-radius:8px;border:none;background:#1a3a1a;color:#fff;
             font-size:.9rem;font-weight:600;cursor:pointer;">
           <i data-lucide="check" style="width:14px;height:14px;"></i> Approve
         </button>`;
  }

  lucide.createIcons({ el: modal });
};


// ================================================
// ATTENDEE VIEWER MODAL
// ================================================

window.viewEventAttendees = async function (eventId) {
  const modal   = document.getElementById('eventsAttendeeModal');
  const bodyEl  = document.getElementById('eventsAttendeeBody');
  const titleEl = document.getElementById('attendeeModalTitle');
  if (!modal || !bodyEl) return;

  bodyEl.innerHTML = `<div style="padding:2rem;text-align:center;color:#aaa;">Loading…</div>`;
  modal.classList.add('is-open');

  try {
    const evSnap = await getDoc(eventDoc(_barangay, eventId));
    if (!evSnap.exists()) return;
    const ev = { id: evSnap.id, ...evSnap.data() };

    if (titleEl) titleEl.textContent = ev.title;

    const attendees  = ev.attendees ?? [];
    const waitlist   = ev.waitlist  ?? [];
    const totalSlots = ev.totalSlots;

    const rsvpSnap = await getDocs(eventRsvpsCol(_barangay, eventId));
    const nameMap  = {};
    rsvpSnap.docs.forEach(d => { nameMap[d.id] = d.data().name ?? d.id; });

    const _canEditSlots = ev.authorRole === 'official' && totalSlots != null;
    const slotHtml = totalSlots != null ? `
      <div style="display:flex;align-items:center;justify-content:space-between;
        gap:1rem;padding:.75rem 1.25rem;background:#f9fafb;border-bottom:1px solid #f0f0f0;">
        <span style="font-size:.85rem;color:#374151;">
          <strong>${attendees.length}</strong> / ${totalSlots} slots filled
        </span>
        ${_canEditSlots ? `<div style="display:flex;align-items:center;gap:.5rem;">
          <input id="eaNewSlots" type="number" min="${totalSlots}" value="${totalSlots}"
            style="width:80px;padding:.4rem .5rem;border:1.5px solid #e0e0e0;
              border-radius:6px;font-size:.85rem;outline:none;" />
          <button onclick="window.increaseSlotsAdmin('${esc(eventId)}')"
            style="display:inline-flex;align-items:center;gap:.3rem;padding:5px 10px;
              border-radius:7px;border:1.5px solid #bbf7d0;background:#f0fdf4;cursor:pointer;
              color:#14532d;font-size:.78rem;font-weight:600;white-space:nowrap;"
            onmouseover="this.style.background='#dcfce7'"
            onmouseout="this.style.background='#f0fdf4'">
            <i data-lucide="plus" style="width:13px;height:13px;"></i> Update Slots
          </button>
        </div>` : ''}
      </div>` : `
      <div style="padding:.75rem 1.25rem;background:#f9fafb;border-bottom:1px solid #f0f0f0;
        font-size:.85rem;color:#6b7280;">
        <strong>${attendees.length}</strong> attending · Unlimited slots
      </div>`;

    const attendeeRows = attendees.length
      ? attendees.map(uid => `
          <div style="display:flex;align-items:center;justify-content:space-between;
            padding:.65rem 1.25rem;border-bottom:1px solid #f0f0f0;">
            <div>
              <div style="font-size:.85rem;font-weight:600;">${esc(nameMap[uid] ?? uid)}</div>
              <div style="font-size:.72rem;color:#9ca3af;">${esc(uid)}</div>
            </div>
            <button onclick="window.removeAttendeeAdmin('${esc(eventId)}','${esc(uid)}')"
              style="display:inline-flex;align-items:center;gap:.3rem;padding:5px 10px;
                border-radius:7px;border:1.5px solid #fecaca;background:#fff;cursor:pointer;
                color:#dc2626;font-size:.72rem;font-weight:500;"
              onmouseover="this.style.background='#fef2f2'"
              onmouseout="this.style.background='#fff'">
              <i data-lucide="user-minus" style="width:12px;height:12px;"></i> Remove
            </button>
          </div>`).join('')
      : `<div style="padding:1.5rem;text-align:center;color:#aaa;font-size:.85rem;">No attendees yet.</div>`;

    const waitlistRows = waitlist.length ? `
      <div style="padding:.65rem 1.25rem;background:#fffbeb;border-top:2px solid #fde68a;">
        <p style="font-size:.73rem;font-weight:700;text-transform:uppercase;
          color:#92400e;letter-spacing:.06em;margin:0 0 .5rem;">
          Waitlist (${waitlist.length})
        </p>
        ${waitlist.map((uid, idx) => `
          <div style="display:flex;justify-content:space-between;padding:.4rem 0;
            ${idx < waitlist.length - 1 ? 'border-bottom:1px solid #fde68a;' : ''}">
            <span style="font-size:.78rem;font-weight:600;">${esc(nameMap[uid] ?? uid)}</span>
            <span style="font-size:.68rem;color:#b45309;">#${idx + 1} in queue</span>
          </div>`).join('')}
      </div>` : '';

    bodyEl.innerHTML = slotHtml + attendeeRows + waitlistRows;
    lucide.createIcons({ el: bodyEl });

  } catch (err) {
    console.error('[events-admin] attendee load error:', err);
    bodyEl.innerHTML = `<div style="padding:2rem;text-align:center;color:#dc2626;">Failed to load.</div>`;
  }
};

window.removeAttendeeAdmin = async function (eventId, uid) {
  const ok = await showConfirm({
    title:   'Remove Attendee?',
    body:    'They will be removed. The next person on the waitlist will be promoted.',
    confirm: 'Remove',
    cancel:  'Go Back',
    variant: 'danger',
  });
  if (!ok) return;
  try {
    const evRef = eventDoc(_barangay, eventId);
    await runTransaction(db, async tx => {
      const snap    = await tx.get(evRef);
      if (!snap.exists()) return;
      const waitlist = snap.data().waitlist ?? [];
      tx.update(evRef, { attendees: arrayRemove(uid), updatedAt: serverTimestamp() });
      if (waitlist.length > 0) {
        tx.update(evRef, {
          waitlist:  arrayRemove(waitlist[0]),
          attendees: arrayUnion(waitlist[0]),
        });
      }
    });
    _showToast('Attendee removed.');
    window.viewEventAttendees(eventId);
  } catch {
    _showToast('Could not remove attendee.', 'error');
  }
};

window.increaseSlotsAdmin = async function (eventId) {
  const newVal = parseInt(document.getElementById('eaNewSlots')?.value ?? '0', 10);
  if (!newVal || newVal < 1) return _showToast('Enter a valid slot count.', 'error');

  try {
    const evRef = eventDoc(_barangay, eventId);
    await runTransaction(db, async tx => {
      const snap     = await tx.get(evRef);
      if (!snap.exists()) return;
      const ev       = snap.data();
      if (newVal <= (ev.totalSlots ?? 0)) return;
      const openSlots = newVal - (ev.attendees?.length ?? 0);
      const promote   = (ev.waitlist ?? []).slice(0, Math.max(0, openSlots));
      const update    = { totalSlots: newVal, updatedAt: serverTimestamp() };
      if (promote.length) {
        update.attendees = arrayUnion(...promote);
        update.waitlist  = arrayRemove(...promote);
      }
      tx.update(evRef, update);
    });
    _showToast('Slots updated.');
    window.viewEventAttendees(eventId);
  } catch {
    _showToast('Could not update slots.', 'error');
  }
};


// ================================================
// IMAGE PREVIEW (form)
// ================================================

window._eaPreviewImages = function (input) {
  const container = document.getElementById('eaImagePreviews');
  if (!container) return;

  if (input.files?.length) {
    Array.from(input.files).forEach(f => {
      const dup = _imageFiles.some(e => e.name === f.name && e.size === f.size);
      if (!dup) _imageFiles.push(f);
    });
  }
  if (_imageFiles.length > 4) _imageFiles = _imageFiles.slice(0, 4);

  container.innerHTML = '';
  _imageFiles.forEach((file, idx) => {
    const reader = new FileReader();
    reader.onload = e => {
      const wrap        = document.createElement('div');
      wrap.style.cssText = 'position:relative;width:80px;height:60px;flex-shrink:0;';
      const img         = document.createElement('img');
      img.src           = e.target.result;
      img.style.cssText = 'width:80px;height:60px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb;display:block;';
      const rm          = document.createElement('button');
      rm.innerHTML      = '×';
      rm.type           = 'button';
      rm.style.cssText  = 'position:absolute;top:-5px;right:-5px;width:18px;height:18px;border-radius:50%;background:#dc2626;color:#fff;border:none;cursor:pointer;font-size:.75rem;display:flex;align-items:center;justify-content:center;';
      rm.onclick        = () => { _imageFiles.splice(idx, 1); window._eaPreviewImages({ files: null }); };
      wrap.appendChild(img);
      wrap.appendChild(rm);
      container.appendChild(wrap);
    };
    reader.readAsDataURL(file);
  });
};


// ================================================
// UTILITIES
// ================================================

function _syncBadge(count) {
  ['eventsAdminPendingBadge', 'eventsAdminPendingBadgeInner'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent   = count;
    el.style.display = count > 0 ? 'inline' : 'none';
  });
}

function _emptyState(icon, title, sub) {
  return `
    <div class="admin-empty">
      <i data-lucide="${icon}"></i>
      <p class="admin-empty__title">${title}</p>
      <p>${sub}</p>
    </div>`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _showToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const t       = document.createElement('div');
  t.className   = `toast toast--${type}`;
  t.innerHTML   = `<i data-lucide="${type === 'success' ? 'check' : 'x-circle'}"></i>${esc(msg)}`;
  container.appendChild(t);
  lucide.createIcons({ el: t });
  setTimeout(() => t.remove(), 3500);
}