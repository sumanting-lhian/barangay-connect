/* ================================================
   curfew-admin.js — BarangayConnect
   Admin interface for managing barangay curfew
   schedules. Supports weekly, one-time, and manual
   schedule types with live active-status detection.

   Firestore paths:
     barangays/{barangayId}/curfewSchedules/{id}
     barangays/{barangayId}/siteAlerts/curfew-{id}

   WHAT IS IN HERE:
     · onAuthStateChanged bootstrap — resolves barangay and collection refs
     · Real-time onSnapshot listener for curfew schedules
     · Live active-status detection (getActiveScheduleId, updateActiveBadges)
     · 60-second live-timer for badge refresh (restartLiveTimer)
     · Schedule list renderer (renderList, buildListRow)
     · Add/edit form renderer (renderForm)
     · Form dirty-check (_isFormDirty)
     · Save, cancel, edit, delete, duplicate, toggle actions
     · Exception date management (add, remove, render tags)
     · siteAlerts sync for manual curfew type (syncCurfewAlert)
     · Shared confirm modal (showConfirmModal)
     · Type chip builder (typeChip)
     · Next-trigger label calculator (nextTriggerLabel)
     · Affects normalization for legacy data (normalizeAffects)
     · Toast notifications (showCurfewToast)
     · XSS escape utility (esc)
     · Shared inline style constants (labelStyle, inputStyle)

   WHAT IS NOT IN HERE:
     · Resident-facing curfew banner display    → community.js / alerts.js
     · Firebase config and db instance          → firebase-config.js
     · Firestore path helpers                   → db-paths.js
     · Global modal structure and styles        → frames.css

   REQUIRED IMPORTS:
     · ../../core/firebase-config.js          (auth, db)
     · ../../core/db-paths.js                 (userIndexDoc, barangayId as toBid)
     · firebase-firestore.js@10.12.0 (collection, onSnapshot, addDoc, updateDoc,
                                      deleteDoc, doc, serverTimestamp, orderBy,
                                      query, getDoc, setDoc)
     · firebase-auth.js@10.12.0      (onAuthStateChanged)

   QUICK REFERENCE:
     Bootstrap        → onAuthStateChanged (top-level, runs on load)
     Show add form    → window.curfewShowForm()
     Edit schedule    → window.curfewEdit(id)
     Save schedule    → window.curfewSave()
     Cancel edit      → window.curfewCancelEdit()
     Toggle active    → window.curfewToggle(id, newState)
     Duplicate        → window.curfewDuplicate(id)
     Delete           → window.curfewDelete(id, name)
     Add exception    → window.curfewAddException()
     Remove exception → window.curfewRemoveException(dt)
     Type change      → window.curfewTypeChange()
     Affects change   → window.curfewAffectsChange()
     Day toggle       → window.curfewDayToggle(day, checked)
================================================ */


// ================================================
// IMPORTS
// ================================================

import { auth, db }                          from '../../core/firebase-config.js';
import { userIndexDoc, barangayId as toBid } from '../../core/db-paths.js';

import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp, orderBy, query,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import { showConfirm } from '/js/shared/confirm-modal.js';


// ================================================
// CONFIGURATION
// ================================================

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];


// ================================================
// MODULE STATE
// ================================================

let _editId           = null;
let _editActive       = true;
let _editOriginalData = null;  // snapshot at edit-start, used for dirty-check
let _formVisible      = false; // whether the add/edit form panel is open
let _barangay         = null;
let _col              = null;
let _alertsCol        = null;
let _exceptions       = [];
let _schedules        = [];
let _liveTimer        = null;
let _curfewTypeFilter = 'all';


// ================================================
// STYLE CONSTANTS
// ================================================

/* Shared inline styles used throughout the form HTML */
const labelStyle = `display:block;font-size:.73rem;font-weight:700;
  text-transform:uppercase;color:#888;margin-bottom:4px;letter-spacing:.04em;`;

const inputStyle = `width:100%;padding:.55rem .75rem;border:1.5px solid #e0e0e0;
  border-radius:8px;font-size:.875rem;outline:none;
  transition:border-color .15s;box-sizing:border-box;`;


// ================================================
// UTILITIES
// ================================================

/* Normalizes legacy lowercase affects values to Title Case */
function normalizeAffects(val) {
  if (!val || val.toLowerCase() === 'all ages') return 'All Ages';
  if (val.toLowerCase() === 'minors only')       return 'Minors Only';
  return val; // custom string — return as-is
}

/* HTML-escapes a value for safe use in innerHTML interpolation */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

/* Appends a transient toast to #toastContainer; auto-removes after 3.5s */
function showCurfewToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const t     = document.createElement('div');
  t.className = `toast toast--${type}`;
  t.innerHTML = `<i data-lucide="${type === 'success' ? 'check' : 'x-circle'}"></i>${esc(msg)}`;

  container.appendChild(t);
  lucide.createIcons({ el: t });
  setTimeout(() => t.remove(), 3500);
}

/* Returns a type chip span for a given schedule type */
function typeChip(type) {
  const map = {
    weekly: { bg: '#eff6ff', color: '#1d4ed8', icon: 'repeat',   label: 'Weekly'   },
    once:   { bg: '#faf5ff', color: '#7e22ce', icon: 'calendar', label: 'One-time' },
    manual: { bg: '#fff7ed', color: '#c2410c', icon: 'sliders',  label: 'Manual'   },
  };
  const t = map[type] ?? map.weekly;
  return `
    <span style="background:${t.bg};color:${t.color};padding:1px 7px;
      border-radius:999px;font-size:.68rem;font-weight:700;
      display:inline-flex;align-items:center;gap:3px;">
      <i data-lucide="${t.icon}" style="width:11px;height:11px;"></i>${t.label}
    </span>`;
}

/* Returns a human-readable label for the schedule's next enforcement trigger */
function nextTriggerLabel(d) {
  if (!d.active) return 'Paused';
  if (d.type === 'manual') return 'Manual — enforced while active';

  if (d.type === 'once') {
    const now = new Date().toISOString().slice(0, 10);
    if (d.date <  now) return 'One-time — date passed';
    if (d.date === now) return `Today, ${d.startTime}–${d.endTime}`;
    return `${d.date}, ${d.startTime}–${d.endTime}`;
  }

  const today    = new Date();
  const todayDay = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][today.getDay()];
  const hhmm     = `${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}`;
  const days     = d.days || [];

  if (days.includes(todayDay) && !(d.exceptions || []).includes(today.toISOString().slice(0, 10))) {
    const crosses  = d.endTime < d.startTime;
    const inWindow = crosses
      ? (hhmm >= d.startTime || hhmm < d.endTime)
      : (hhmm >= d.startTime && hhmm < d.endTime);
    if (inWindow)          return `Enforcing now — until ${d.endTime}`;
    if (hhmm < d.startTime) return `Today at ${d.startTime}`;
  }

  const dayOrder = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const todayIdx = today.getDay();
  for (let i = 1; i <= 7; i++) {
    const idx = (todayIdx + i) % 7;
    if (days.includes(dayOrder[idx])) {
      return i === 1 ? `Tomorrow at ${d.startTime}` : `${dayOrder[idx]} at ${d.startTime}`;
    }
  }

  return 'No upcoming days';
}


// ================================================
// BOOTSTRAP
// ================================================

/*
   Resolves the admin's barangay from userIndex, sets collection refs,
   and starts the real-time schedule listener.
*/
onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  const { getDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
  const snap = await getDoc(userIndexDoc(user.uid));
  if (!snap.exists()) return;

  _barangay  = snap.data().barangay;
  _col       = collection(db, 'barangays', toBid(_barangay), 'curfewSchedules');
  _alertsCol = collection(db, 'barangays', toBid(_barangay), 'siteAlerts');

  onSnapshot(query(_col, orderBy('createdAt', 'desc')), snap => {
    _schedules = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList(snap.docs);
    if (!_editId && !_formVisible) renderForm(null);
    restartLiveTimer();
  });

  renderForm(null); // renders the "Add Schedule" CTA on initial load
});


// ================================================
// LIVE STATUS
// ================================================

/* Restarts the 60-second interval that refreshes active-status badges */
function restartLiveTimer() {
  if (_liveTimer) clearInterval(_liveTimer);
  updateActiveBadges();
  _liveTimer = setInterval(updateActiveBadges, 60_000);
}

/* Returns the ID of the currently enforcing schedule, or null */
function getActiveScheduleId() {
  const now     = new Date();
  const today   = now.toISOString().slice(0, 10);
  const hhmm    = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()];

  for (const s of _schedules) {
    if (!s.active) continue;

    if (s.type === 'weekly') {
      if (!(s.days || []).includes(dayName)) continue;
      if ((s.exceptions || []).includes(today)) continue;
    } else if (s.type === 'once') {
      if (s.date !== today) continue;
    }

    if (s.type === 'manual') return s.id;

    const crosses  = s.endTime < s.startTime;
    const inWindow = crosses
      ? (hhmm >= s.startTime || hhmm < s.endTime)
      : (hhmm >= s.startTime && hhmm < s.endTime);
    if (inWindow) return s.id;
  }

  return null;
}

/* Updates live-badge visibility and row highlight for all schedule rows */
function updateActiveBadges() {
  const activeId = getActiveScheduleId();

  document.querySelectorAll('[data-curfew-id]').forEach(row => {
    const id     = row.dataset.curfewId;
    const badge  = row.querySelector('.curfew-live-badge');
    const active = id === activeId;

    /* Use style.display — avoids [hidden] vs inline-style specificity conflicts */
    if (badge) badge.style.display = active ? 'inline-flex' : 'none';
    row.style.background = active ? 'linear-gradient(to right, #f0fdf4, #fff)' : '';
    row.style.borderLeft = active ? '3px solid #16a34a' : '3px solid transparent';
  });

  const pill = document.getElementById('curfewLivePill');
  if (pill) pill.style.display = activeId ? 'inline-flex' : 'none';

  /* Keep the form's inline warning banners in sync without a full re-render */
  if (_editId) _updateFormWarnings();
}

/* Updates only the paused and enforcing warning banners inside the edit form */
function _updateFormWarnings() {
  const pausedWarn    = document.getElementById('cfPausedWarning');
  const enforcingWarn = document.getElementById('cfEnforcingWarning');
  if (!pausedWarn && !enforcingWarn) return;

  const enforcingNow = _editActive && getActiveScheduleId() === _editId;
  if (pausedWarn)    pausedWarn.style.display    = _editActive ? 'none' : 'flex';
  if (enforcingWarn) enforcingWarn.style.display = enforcingNow ? 'flex' : 'none';
}


// ================================================
// ALERT FEED SYNC
// ================================================

/* Writes or deactivates a siteAlert document for manual curfew schedules */
async function syncCurfewAlert(id, data, nowActive) {
  if (!_alertsCol) return;
  if (data.type !== 'manual') return;

  const ref = doc(_alertsCol, `curfew-${id}`);
  try {
    if (nowActive) {
      const { setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
      await setDoc(ref, {
        type:        'curfew',
        severity:    'orange',
        title:       `Curfew Enforced — ${data.name}`,
        message:     `${data.startTime} – ${data.endTime}. ${
          data.affects?.toLowerCase() === 'minors only'
            ? 'Minors must be accompanied by a guardian.'
            : 'All residents must observe curfew hours.'}`,
        source:      'admin',
        active:      true,
        dismissible: false,
        createdAt:   serverTimestamp(),
        createdBy:   auth.currentUser?.uid ?? 'system',
        expiresAt:   null,
      });
    } else {
      const { updateDoc: upd } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
      await upd(ref, { active: false }).catch(() => {});
    }
  } catch (err) {
    console.warn('[curfew] alert sync failed:', err.message);
  }
}


// ================================================
// RENDER — Schedule List
// ================================================

/* Rebuilds the schedule list DOM from the current snapshot */
function renderList(docs) {
  const el = document.getElementById('curfewList');
  if (!el) return;

  const badge  = document.getElementById('curfewBadgeCount');
  const active = docs.filter(d => d.data().active).length;
  if (badge) {
    badge.textContent   = active;
    badge.style.display = active > 0 ? 'inline' : 'none';
  }

  const filtered = _curfewTypeFilter === 'all'
    ? docs : docs.filter(d => d.data().type === _curfewTypeFilter);

  /* Header + filter row — always rendered regardless of filtered results */
  const headerHtml = `
    <style>@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.3)}}</style>
    <div style="margin-bottom:.75rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;
        flex-wrap:wrap;gap:.5rem;margin-bottom:.5rem;">
        <span id="curfewLivePill" style="display:none;align-items:center;gap:.4rem;
          background:#dcfce7;color:#15803d;padding:4px 12px;border-radius:999px;
          font-size:.75rem;font-weight:700;border:1.5px solid #86efac;">
          <span style="width:7px;height:7px;background:#16a34a;border-radius:50%;
            animation:pulse 1.5s infinite;display:inline-block;"></span>
          Curfew enforcing now
        </span>
        <span style="font-size:.75rem;color:#aaa;">Active-status updates every 60 s</span>
      </div>
      <div style="display:flex;align-items:center;gap:.5rem;">
      <span style="font-size:.65rem;font-weight:700;text-transform:uppercase;color:#9ca3af;letter-spacing:.06em;min-width:48px;">Type</span>
      <div style="display:inline-flex;background:var(--alpha-ink-07);
        border-radius:var(--radius-full);padding:3px;gap:2px;">
        <button class="bulletin-view-btn admin-subtab-btn curfew-type-btn ${_curfewTypeFilter === 'all' ? 'is-active' : ''}" onclick="setCurfewTypeFilter('all',this)">All</button>
        <button class="bulletin-view-btn admin-subtab-btn curfew-type-btn ${_curfewTypeFilter === 'weekly' ? 'is-active' : ''}" onclick="setCurfewTypeFilter('weekly',this)">
          <i data-lucide="repeat" style="width:11px;height:11px;"></i> Weekly
        </button>
        <button class="bulletin-view-btn admin-subtab-btn curfew-type-btn ${_curfewTypeFilter === 'once' ? 'is-active' : ''}" onclick="setCurfewTypeFilter('once',this)">
          <i data-lucide="calendar" style="width:11px;height:11px;"></i> One-time
        </button>
        <button class="bulletin-view-btn admin-subtab-btn curfew-type-btn ${_curfewTypeFilter === 'manual' ? 'is-active' : ''}" onclick="setCurfewTypeFilter('manual',this)">
          <i data-lucide="sliders" style="width:11px;height:11px;"></i> Manual
        </button>
      </div>
      </div>
    </div>`;

  if (!docs.length) {
    el.innerHTML = headerHtml + `
      <div style="background:#fff;border-radius:12px;padding:2.5rem;text-align:center;
        color:#aaa;box-shadow:0 1px 4px rgba(0,0,0,.07);">
        <i data-lucide="moon" style="width:32px;height:32px;color:#d1d5db;display:block;margin:0 auto .75rem;"></i>
        <p style="margin:0;font-size:.9rem;">No curfew schedules yet.<br>Use the button below to add one.</p>
      </div>`;
    lucide.createIcons({ el });
    updateActiveBadges();
    return;
  }

  if (!filtered.length) {
    el.innerHTML = headerHtml + `
      <div style="background:#fff;border-radius:12px;padding:2.5rem;text-align:center;
        color:#aaa;box-shadow:0 1px 4px rgba(0,0,0,.07);">
        <i data-lucide="filter-x" style="width:32px;height:32px;color:#d1d5db;display:block;margin:0 auto .75rem;"></i>
        <p style="margin:0;font-size:.9rem;">No schedules match this filter.</p>
      </div>`;
    lucide.createIcons({ el });
    updateActiveBadges();
    return;
  }

  const now = new Date();
  el.innerHTML = headerHtml + `
    <div style="background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.07);overflow:hidden">
      <div style="display:grid;grid-template-columns:2fr 1.5fr 1fr auto;
        padding:.55rem 1.25rem;border-bottom:1.5px solid #f0f0f0;
        font-size:.7rem;font-weight:700;text-transform:uppercase;
        letter-spacing:.07em;color:#bbb;background:#fafafa;">
        <span>Name &amp; Type</span><span>Hours &amp; Status</span>
        <span>Next trigger</span><span></span>
      </div>
      ${filtered.map(d => buildListRow(d.id, d.data(), now)).join('')}
    </div>`;

  lucide.createIcons({ el });
  updateActiveBadges();
}

/* Constructs and returns the HTML string for a single schedule row */
function buildListRow(id, d, now) {
  const isExpired = d.type === 'once' && d.date && d.date < now.toISOString().slice(0, 10);
  const isEditing = _editId === id;

  const statusChip = isExpired
    ? `<span style="background:#f5f5f5;color:#aaa;padding:2px 9px;border-radius:999px;font-size:.72rem;font-weight:700;">Expired</span>`
    : d.active
      ? `<span style="background:#dcfce7;color:#15803d;padding:2px 9px;border-radius:999px;font-size:.72rem;font-weight:700;">Active</span>`
      : `<span style="background:#f3f4f6;color:#9ca3af;padding:2px 9px;border-radius:999px;font-size:.72rem;font-weight:700;">Paused</span>`;

  /* Starts display:none — updateActiveBadges() controls visibility via style.display */
  const liveBadge = `
    <span class="curfew-live-badge" style="display:none;align-items:center;gap:4px;
      background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:999px;
      font-size:.68rem;font-weight:700;border:1px solid #86efac;
      vertical-align:middle;margin-left:4px;">
      <span style="width:6px;height:6px;background:#16a34a;border-radius:50%;
        animation:pulse 1.5s infinite;display:inline-block;flex-shrink:0;"></span>
      Enforcing
    </span>`;

  const patternLine = d.type === 'weekly'
    ? (d.days || []).join(' · ')
    : d.type === 'once' ? `One-time · ${d.date}` : 'Manual trigger';

  const exceptionLine = (d.exceptions || []).length
    ? `<span style="color:#b45309;font-size:.72rem;">${d.exceptions.length} exception${d.exceptions.length > 1 ? 's' : ''}</span>`
    : '';

  const endLabel = d.endTime < d.startTime
    ? `${d.endTime} <span style="font-size:.65rem;color:#aaa;">+1d</span>`
    : d.endTime;

  const toggleLabel = d.type === 'manual'
    ? (d.active ? 'Stop' : 'Enforce Now')
    : (d.active ? 'Pause' : 'Resume');
  const toggleIcon  = d.type === 'manual'
    ? (d.active ? 'square' : 'play')
    : (d.active ? 'pause'  : 'play');

  /* Edit button becomes a styled "Cancel" indicator when this row is being edited */
  const editIcon   = isEditing ? 'x'             : 'pencil';
  const editLabel  = isEditing ? 'Cancel'         : 'Edit';
  const editTitle  = isEditing ? 'Cancel editing' : 'Edit schedule';
  const editBorder = isEditing ? '#dc2626'        : '#e0e0e0';
  const editBg     = isEditing ? '#fff5f5'        : '#fff';
  const editColor  = isEditing ? '#dc2626'        : '#555';
  const editHover  = isEditing ? '#fee2e2'        : '#f4f6f9';

  return `
    <div data-curfew-id="${id}"
      style="display:grid;grid-template-columns:2fr 1.5fr 1fr auto;
        align-items:center;gap:.75rem;padding:.9rem 1.25rem;
        border-bottom:1px solid #f0f0f0;transition:background .2s,border-left .2s;
        border-left:3px solid transparent;
        ${isEditing ? 'background:#f0fdf4;border-left:3px solid #1a3a1a!important;' : ''}">

      <div>
        <div style="font-weight:700;font-size:.9rem;display:flex;align-items:center;flex-wrap:wrap;gap:.35rem;">
          ${esc(d.name)}${liveBadge}
          ${isEditing ? `<span class="admin-badge admin-badge--editing">Editing</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:.4rem;margin-top:4px;flex-wrap:wrap;">
          ${typeChip(d.type)}
          <span style="font-size:.74rem;color:#888;">${esc(patternLine)}</span>
        </div>
        ${exceptionLine}
      </div>

      <div>
        <div style="font-weight:600;font-size:.92rem;">${d.startTime} – ${endLabel}</div>
        <div style="display:flex;align-items:center;gap:.4rem;margin-top:3px;flex-wrap:wrap;">
          ${statusChip}
          <span style="font-size:.73rem;color:#aaa;">${esc(normalizeAffects(d.affects || 'all ages'))}</span>
        </div>
      </div>

      <div style="font-size:.78rem;color:#555;line-height:1.5;">
        ${esc(nextTriggerLabel(d))}
        ${d.note ? `<div style="font-size:.7rem;color:#bbb;margin-top:2px;">${esc(d.note)}</div>` : ''}
      </div>

      <div style="display:flex;gap:.35rem;align-items:center;flex-shrink:0;">
        ${!isExpired ? `
          <button onclick="curfewToggle('${id}',${!d.active})" title="${toggleLabel}"
            style="display:inline-flex;align-items:center;gap:.3rem;padding:5px 10px;
              border-radius:7px;border:1.5px solid #e0e0e0;background:#fff;
              cursor:pointer;color:#555;font-size:.78rem;font-weight:500;
              transition:all .15s;white-space:nowrap;"
            onmouseover="this.style.background='#f4f6f9'"
            onmouseout="this.style.background='#fff'">
            <i data-lucide="${toggleIcon}" style="width:13px;height:13px;"></i>${toggleLabel}
          </button>
          <button onclick="curfewEdit('${id}')" title="${editTitle}"
            style="display:inline-flex;align-items:center;gap:.3rem;padding:5px 10px;
              border-radius:7px;border:1.5px solid ${editBorder};background:${editBg};
              cursor:pointer;color:${editColor};font-size:.78rem;font-weight:500;transition:all .15s;"
            onmouseover="this.style.background='${editHover}'"
            onmouseout="this.style.background='${editBg}'">
            <i data-lucide="${editIcon}" style="width:13px;height:13px;"></i>${editLabel}
          </button>
          <button onclick="curfewDuplicate('${id}')" title="Duplicate"
            style="display:inline-flex;align-items:center;gap:.3rem;padding:5px 10px;
              border-radius:7px;border:1.5px solid #e0e0e0;background:#fff;
              cursor:pointer;color:#555;font-size:.78rem;font-weight:500;transition:all .15s;"
            onmouseover="this.style.background='#f4f6f9'"
            onmouseout="this.style.background='#fff'">
            <i data-lucide="copy" style="width:13px;height:13px;"></i>
          </button>` : ''}
        <button onclick="curfewDelete('${id}','${esc(d.name)}')" title="Delete permanently"
          style="display:inline-flex;align-items:center;gap:.3rem;padding:5px 10px;
            border-radius:7px;border:1.5px solid #fca5a5;background:#fff;
            cursor:pointer;color:#dc2626;font-size:.78rem;font-weight:500;transition:all .15s;"
          onmouseover="this.style.background='#fef2f2'"
          onmouseout="this.style.background='#fff'">
          <i data-lucide="trash-2" style="width:13px;height:13px;"></i>
        </button>
      </div>
    </div>`;
}


// ================================================
// ACTIONS — Toggle / Duplicate / Delete
// ================================================

/* Toggles a schedule's active state and syncs the siteAlert for manual types */
window.curfewToggle = async function (id, newState) {
  try {
    const idx = _schedules.findIndex(s => s.id === id);
    if (idx !== -1) _schedules[idx].active = newState;

    /* Keep _editActive in sync so saving preserves the toggled state */
    if (_editId === id) _editActive = newState;

    /* Instant visual feedback — also calls _updateFormWarnings() if editing */
    updateActiveBadges();

    const schedule = _schedules.find(s => s.id === id);
    await updateDoc(doc(_col, id), { active: newState });
    if (schedule) await syncCurfewAlert(id, schedule, newState);

    const verb = schedule?.type === 'manual'
      ? (newState ? 'Curfew is now being enforced.' : 'Curfew enforcement stopped.')
      : (newState ? 'Schedule activated.'           : 'Schedule paused.');
    showCurfewToast(verb, 'success');
  } catch {
    showCurfewToast('Could not update schedule.', 'error');
  }
};

window.setCurfewTypeFilter = function (type, btn) {
  _curfewTypeFilter = type;
  document.querySelectorAll('.curfew-type-btn')
    .forEach(b => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  renderList(_schedules.map(s => ({ id: s.id, data: () => s })));
};

/* Duplicates a schedule as a new paused document */
window.curfewDuplicate = async function (id) {
  const schedule = _schedules.find(s => s.id === id);
  if (!schedule) return;

  const { id: _id, ...data } = schedule;
  try {
    await addDoc(_col, { ...data, name: `${data.name} (Copy)`, active: false, createdAt: serverTimestamp() });
    showCurfewToast('Schedule duplicated — starts paused.', 'success');
  } catch {
    showCurfewToast('Could not duplicate schedule.', 'error');
  }
};

/* Confirms and permanently deletes a schedule document */
window.curfewDelete = async function (id, name) {
  const ok = await showConfirm({
  title:   'Delete Schedule?',
  body:    `This will permanently remove <strong>${esc(name)}</strong>. Residents won't see it again.`,
  confirm: 'Delete',
  cancel:  'Go Back',
  variant: 'danger',
});
  if (!ok) return;

  try {
    const schedule = _schedules.find(s => s.id === id);
    if (schedule) await syncCurfewAlert(id, schedule, false);
    await deleteDoc(doc(_col, id));
    showCurfewToast('Schedule deleted.', 'success');

    if (_editId === id) {
      _editId = null; _editActive = true; _editOriginalData = null; _formVisible = false;
      renderForm(null);
      renderList(_schedules.map(s => ({ id: s.id, data: () => s })));
    }
  } catch {
    showCurfewToast('Could not delete. Try again.', 'error');
  }
};


// ================================================
// ACTIONS — Save
// ================================================

/* Validates form inputs and writes an add or update to Firestore */
window.curfewSave = async function () {
  if (!_col) { showCurfewToast('Not ready yet. Please wait a moment.', 'error'); return; }

  const name      = document.getElementById('cfName')?.value.trim();
  const type      = document.querySelector('input[name="cfType"]:checked')?.value || 'weekly';
  const startTime = document.getElementById('cfStart')?.value;
  const endTime   = document.getElementById('cfEnd')?.value;
  const note      = document.getElementById('cfNote')?.value.trim() || '';

  /* Affects — handle the Custom radio option */
  const affectsRadio = document.querySelector('input[name="cfAffects"]:checked')?.value || 'All Ages';
  const ageMin       = document.getElementById('cfAgeMin')?.value;
  const ageMax       = document.getElementById('cfAgeMax')?.value;
  const affects      = affectsRadio === 'Custom'
    ? (ageMin && ageMax ? `Ages ${ageMin}-${ageMax}` : '')
    : affectsRadio;

  if (!name) { showCurfewToast('Please enter a name.', 'error'); return; }
  if (affectsRadio === 'Custom' && (!ageMin || !ageMax)) {
    showCurfewToast('Please enter both a minimum and maximum age.', 'error'); return;
  }
  if (type !== 'manual') {
    if (!startTime || !endTime) { showCurfewToast('Please set start and end times.', 'error'); return; }
    if (startTime === endTime)  { showCurfewToast('Start and end time cannot be the same.', 'error'); return; }
  }

  const days = type === 'weekly'
    ? [...document.querySelectorAll('input[name="cfDays"]:checked')].map(i => i.value) : [];
  const date = type === 'once'
    ? (document.getElementById('cfDate')?.value || null) : null;

  if (type === 'weekly' && !days.length) { showCurfewToast('Select at least one day.', 'error'); return; }
  if (type === 'once'   && !date)        { showCurfewToast('Please pick a date.', 'error'); return; }

  const saveBtn      = document.querySelector('#curfewForm button[onclick="curfewSave()"]');
  const isActuallyDirty = _isFormDirty();
  if (saveBtn) saveBtn.disabled = true;

  const payload = {
    name, type, startTime, endTime, affects, note,
    days:       type === 'weekly' ? days       : [],
    date:       type === 'once'   ? date       : null,
    exceptions: type === 'weekly' ? _exceptions : [],
    /* Preserve active state when editing; default true for new schedules */
    active:     _editId ? _editActive : true,
  };

  try {
    if (_editId) {
      await updateDoc(doc(_col, _editId), payload);
      showCurfewToast(isActuallyDirty ? 'Schedule updated.' : 'No changes — schedule kept as is.', 'success');
      const idx = _schedules.findIndex(s => s.id === _editId);
      if (idx !== -1) _schedules[idx] = { ..._schedules[idx], ...payload };
    } else {
      await addDoc(_col, { ...payload, createdAt: serverTimestamp() });
      showCurfewToast('Schedule saved.', 'success');
    }

    _editId = null; _editActive = true; _editOriginalData = null; _formVisible = false;
    renderForm(null);
    renderList(_schedules.map(s => ({ id: s.id, data: () => s })));
  } catch (err) {
    console.error('Curfew save error:', err.code, err.message);
    showCurfewToast(`Failed to save: ${err.message}`, 'error');
    if (saveBtn) saveBtn.disabled = false;
  }
};


// ================================================
// ACTIONS — Edit / Cancel
// ================================================

/* Opens the add form panel and resets edit state */
window.curfewShowForm = function () {
  _formVisible = true; _editId = null; _editOriginalData = null;
  _editActive = true; _exceptions = [];
  renderForm(null);
  document.getElementById('curfewForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

/* Opens the edit form for a schedule; guards against unsaved changes */
window.curfewEdit = async function (id) {

  /* Clicking Edit/Cancel on the currently-editing row */
  if (_editId === id) {
    if (_isFormDirty()) {
      const ok = await showConfirm({
        title:   'Discard Changes?',
        body:    `Unsaved edits to <strong>${esc(_editOriginalData?.name || 'this schedule')}</strong> will be lost.`,
        confirm: 'Discard',
        cancel:  'Keep Editing',
        variant: 'warning',
      });
      if (!ok) return;
    }
    /* Cancel without calling curfewCancelEdit — avoids re-confirming */
    _editId = null; _editActive = true; _editOriginalData = null; _formVisible = false;
    renderForm(null);
    renderList(_schedules.map(s => ({ id: s.id, data: () => s })));
    return;
  }

  /* Switching to a different edit while the form is already open */
  if (_editId || _formVisible) {
    if (_isFormDirty()) {
      const ok = await showConfirm({
        title:   'Discard Changes?',
        body:    'Unsaved changes will be lost.',
        confirm: 'Discard',
        cancel:  'Keep Editing',
        variant: 'warning',
      });
      if (!ok) return;
    }
  }

  const { getDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
  const snap = await getDoc(doc(_col, id));
  if (!snap.exists()) return;

  _editId           = id;
  _editActive       = Boolean(snap.data().active); // explicit cast — prevents undefined → true
  _editOriginalData = { ...snap.data() };
  _formVisible      = true;

  renderForm(snap.data());
  renderList(_schedules.map(s => ({ id: s.id, data: () => s })));
  document.getElementById('curfewForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

/* Discards unsaved changes and resets form state; prompts if dirty */
window.curfewCancelEdit = async function () {
  if (_isFormDirty()) {
    const title = _editId ? 'Discard Changes?' : 'Discard New Schedule?';
    const body  = _editId
      ? `Unsaved edits to <strong>${esc(_editOriginalData?.name || 'this schedule')}</strong> will be lost.`
      : 'Your new schedule setup will be discarded.';
    const ok = await showConfirm({
      title,
      body,
      confirm: 'Discard',
      cancel:  'Keep Editing',
      variant: 'warning',
    });
    if (!ok) return;
  }

  _editId = null; _editActive = true; _editOriginalData = null; _formVisible = false;
  renderForm(null);
  renderList(_schedules.map(s => ({ id: s.id, data: () => s })));
};


// ================================================
// DIRTY-CHECK
// ================================================

/* Returns true if form fields differ from the original snapshot */
function _isFormDirty() {
  if (!_editId) {
    /* Add mode — dirty if the name field has any content */
    return (document.getElementById('cfName')?.value.trim() || '') !== '';
  }

  const d     = _editOriginalData || {};
  const name  = document.getElementById('cfName')?.value.trim()               ?? '';
  const note  = document.getElementById('cfNote')?.value.trim()               ?? '';
  const type  = document.querySelector('input[name="cfType"]:checked')?.value ?? 'weekly';
  const start = document.getElementById('cfStart')?.value                     ?? '';
  const end   = document.getElementById('cfEnd')?.value                       ?? '';

  return (
    name  !== (d.name      || '')       ||
    note  !== (d.note      || '')       ||
    type  !== (d.type      || 'weekly') ||
    start !== (d.startTime || '22:00')  ||
    end   !== (d.endTime   || '05:00')
  );
}


// ================================================
// EXCEPTION DATES
// ================================================

/* Adds a date to the exceptions list and re-renders tags */
window.curfewAddException = function () {
  const inp = document.getElementById('cfExInput');
  if (!inp?.value) {
    inp.style.borderColor = '#dc2626';
    setTimeout(() => { inp.style.borderColor = ''; }, 2000);
    return;
  }
  inp.style.borderColor = '';
  if (!_exceptions.includes(inp.value)) { _exceptions.push(inp.value); _exceptions.sort(); }
  inp.value = '';
  _renderExTags();
};

/* Removes a date from the exceptions list and re-renders tags */
window.curfewRemoveException = function (dt) {
  _exceptions = _exceptions.filter(e => e !== dt);
  _renderExTags();
};

/* Renders the current exception dates as removable tag chips */
function _renderExTags() {
  const wrap = document.getElementById('cfExTags');
  if (!wrap) return;

  if (!_exceptions.length) {
    wrap.innerHTML = `<span style="font-size:.75rem;color:#bbb;font-style:italic;">No exceptions set</span>`;
    return;
  }

  wrap.innerHTML = _exceptions.map(dt => `
    <span style="display:inline-flex;align-items:center;gap:.35rem;
      background:#fff3cd;color:#856404;border-radius:6px;padding:3px 9px;
      font-size:.75rem;font-weight:600;">
      ${dt}
      <button onclick="curfewRemoveException('${dt}')" type="button"
        style="border:none;background:none;cursor:pointer;color:#856404;
          font-size:.9rem;line-height:1;padding:0;">&times;</button>
    </span>`).join('');
}


// ================================================
// FORM HELPERS
// ================================================

/* Updates type radio pill styles and shows/hides type-dependent fields */
window.curfewTypeChange = function () {
  const type = document.querySelector('input[name="cfType"]:checked')?.value || 'weekly';

  document.getElementById('cfDayRow').hidden                  = type !== 'weekly';
  document.getElementById('cfDateRow').hidden                 = type !== 'once';
  document.getElementById('cfExRow').hidden                   = type !== 'weekly';
  document.getElementById('cfManualNote').hidden              = type !== 'manual';
  document.getElementById('cfTimeRow').style.display          = type === 'manual' ? 'none' : 'flex';

  document.querySelectorAll('input[name="cfType"]').forEach(inp => {
    const lbl = inp.closest('label');
    const on  = inp.value === type;
    lbl.style.background  = on ? '#1a3a1a' : '#fff';
    lbl.style.color       = on ? '#fff'    : '#555';
    lbl.style.borderColor = on ? '#1a3a1a' : '#e0e0e0';
  });
};

/* Updates affects radio pill styles and shows/hides the custom age range inputs */
window.curfewAffectsChange = function () {
  const val = document.querySelector('input[name="cfAffects"]:checked')?.value || 'All Ages';

  document.querySelectorAll('input[name="cfAffects"]').forEach(inp => {
    const lbl = inp.closest('label');
    const on  = inp.value === val;
    lbl.style.background  = on ? '#1a3a1a' : '#fff';
    lbl.style.color       = on ? '#fff'    : '#555';
    lbl.style.borderColor = on ? '#1a3a1a' : '#e0e0e0';
  });

  const customWrap = document.getElementById('cfAffectsCustomWrap');
  if (customWrap) customWrap.style.display = (val === 'Custom') ? 'flex' : 'none';
};

/* Updates a single day-pill's active style on checkbox change */
window.curfewDayToggle = function (day, checked) {
  const label = document.getElementById(`cfDayLabel-${day}`);
  if (!label) return;
  label.style.background  = checked ? '#1a3a1a' : '#fff';
  label.style.color       = checked ? '#fff'    : '#555';
  label.style.borderColor = checked ? '#1a3a1a' : '#e0e0e0';
};


// ================================================
// RENDER — Form
// ================================================

/* Renders the add/edit form, or the "Add Schedule" CTA when not in form mode */
function renderForm(prefill) {
  const el = document.getElementById('curfewForm');
  if (!el) return;

  /* When not in add/edit mode, show the Add Schedule call-to-action */
  if (!_formVisible && !_editId) {
    el.innerHTML = `
      <button onclick="curfewShowForm()"
        style="display:flex;align-items:center;justify-content:center;gap:.6rem;
          width:100%;padding:.85rem 1.5rem;border-radius:12px;
          border:2px dashed #d1d5db;background:white;
          color:#374151;font-size:.9rem;font-weight:600;cursor:pointer;
          transition:all .2s;box-shadow:0 1px 3px rgba(0,0,0,.04);"
        onmouseover="this.style.borderColor='#1a3a1a';this.style.color='#1a3a1a';this.style.background='#f0fdf4'"
        onmouseout="this.style.borderColor='#d1d5db';this.style.color='#374151';this.style.background='white'">
        <i data-lucide="plus-circle" style="width:18px;height:18px;"></i>
        Add Curfew Schedule
      </button>`;
    lucide.createIcons({ el });
    return;
  }

  _exceptions = prefill?.exceptions || [];

  const d      = prefill || {};
  const isEdit = !!_editId;
  const type   = d.type || 'weekly';
  const enforcingNow = isEdit && _editActive && getActiveScheduleId() === _editId;

  /* Normalize affects for initial render — handles legacy lowercase */
  const rawAffects    = normalizeAffects(d.affects || 'All Ages');
  const knownAffects  = ['All Ages', 'Minors Only'];
  const isCustom      = !knownAffects.includes(rawAffects);
  const affectsVal    = isCustom ? 'Custom'  : rawAffects;
  const customAffects = isCustom ? rawAffects : '';

  el.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:1.5rem;
      box-shadow:0 1px 4px rgba(0,0,0,.07);">

      <div style="display:flex;align-items:center;justify-content:space-between;
        margin-bottom:1.25rem;flex-wrap:wrap;gap:.5rem;">
        <h2 style="font-size:1rem;font-weight:700;margin:0;
          display:flex;align-items:center;gap:.5rem;">
          <i data-lucide="${isEdit ? 'pencil' : 'plus-circle'}" style="width:17px;height:17px;color:#1a3a1a;"></i>
          ${isEdit ? 'Edit Schedule' : 'Add Curfew Schedule'}
        </h2>
        ${isEdit ? `
          <span style="background:#fef9c3;color:#854d0e;padding:3px 10px;
            border-radius:999px;font-size:.73rem;font-weight:700;border:1px solid #fde68a;">
            Editing: ${esc(d.name || '')}
          </span>` : ''}
      </div>

      <div style="display:grid;gap:1rem;">

        <!-- Paused warning — shown when editing a paused schedule -->
        <div id="cfPausedWarning"
          style="background:#fef9c3;border:1.5px solid #fde68a;border-radius:8px;
            padding:.65rem 1rem;font-size:.82rem;color:#854d0e;
            display:${isEdit && !_editActive ? 'flex' : 'none'};align-items:center;gap:.5rem;">
          <i data-lucide="pause-circle" style="width:16px;height:16px;flex-shrink:0;"></i>
          <span>This schedule is currently <strong>paused</strong>.
            It will remain paused after saving.</span>
        </div>

        <!-- Enforcing warning — shown when the schedule is live right now -->
        <div id="cfEnforcingWarning"
          style="background:#dcfce7;border:1.5px solid #86efac;border-radius:8px;
            padding:.65rem 1rem;font-size:.82rem;color:#15803d;
            display:${enforcingNow ? 'flex' : 'none'};align-items:center;gap:.5rem;">
          <span style="width:8px;height:8px;background:#16a34a;border-radius:50%;
            animation:pulse 1.5s infinite;flex-shrink:0;display:inline-block;"></span>
          <span>This schedule is <strong>currently enforcing</strong>.
            Changes take effect immediately on save.</span>
        </div>

        <!-- Name -->
        <div>
          <label style="${labelStyle}">Name</label>
          <input id="cfName" type="text" required
            value="${esc(d.name || '')}" placeholder="e.g. Nightly Curfew"
            style="${inputStyle}" />
        </div>

        <!-- Type -->
        <div>
          <label style="${labelStyle}">Type</label>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap;">
            ${[['weekly', 'repeat', 'Weekly repeat'], ['once', 'calendar', 'One-time date'], ['manual', 'sliders', 'Manual control']]
              .map(([t, em, lbl]) => `
                <label style="display:inline-flex;align-items:center;gap:.4rem;
                  padding:.4rem .9rem;border-radius:999px;cursor:pointer;
                  border:1.5px solid ${type === t ? '#1a3a1a' : '#e0e0e0'};
                  background:${type === t ? '#1a3a1a' : '#fff'};
                  color:${type === t ? '#fff' : '#555'};
                  font-size:.8rem;font-weight:600;transition:all .15s;">
                  <input type="radio" name="cfType" value="${t}"
                    ${type === t ? 'checked' : ''} style="display:none"
                    onchange="curfewTypeChange()" /><i data-lucide="${em}" style="width:13px;height:13px;"></i> ${lbl}
                </label>`).join('')}
          </div>
        </div>

        <!-- Manual info note -->
        <div id="cfManualNote" ${type !== 'manual' ? 'hidden' : ''}
          style="background:#fff7ed;border:1.5px solid #fed7aa;border-radius:8px;
            padding:.75rem 1rem;font-size:.82rem;color:#92400e;line-height:1.5;">
          <strong>Manual control</strong> — activating this schedule makes residents
          immediately see a curfew banner. Toggle it off to lift the curfew.
          No start/end times needed.
        </div>

        <!-- Day picker -->
        <div id="cfDayRow" ${type !== 'weekly' ? 'hidden' : ''}>
          <label style="${labelStyle}">Days</label>
          <div style="display:flex;gap:.4rem;flex-wrap:wrap;">
            ${DAYS.map(day => `
              <label id="cfDayLabel-${day}"
                style="display:inline-flex;align-items:center;justify-content:center;
                  width:46px;height:36px;border-radius:999px;border:1.5px solid #e0e0e0;
                  background:#fff;font-size:.8rem;font-weight:600;cursor:pointer;transition:all .15s;">
                <input type="checkbox" name="cfDays" value="${day}"
                  ${(d.days || []).includes(day) ? 'checked' : ''} style="display:none"
                  onchange="curfewDayToggle('${day}',this.checked)" />${day}
              </label>`).join('')}
          </div>
        </div>

        <!-- Date picker -->
        <div id="cfDateRow" ${type !== 'once' ? 'hidden' : ''}>
          <label style="${labelStyle}">Date</label>
          <input id="cfDate" type="date" value="${d.date || ''}" style="${inputStyle} width:auto;" />
        </div>

        <!-- Times (hidden for manual type) -->
        <div id="cfTimeRow"
          style="display:${type === 'manual' ? 'none' : 'flex'};align-items:flex-end;gap:1rem;flex-wrap:wrap;">
          <div>
            <label style="${labelStyle}">Start time</label>
            <input id="cfStart" type="time" value="${d.startTime || '22:00'}"
              style="${inputStyle} width:auto;" />
          </div>
          <div>
            <label style="${labelStyle}">End time</label>
            <input id="cfEnd" type="time" value="${d.endTime || '05:00'}"
              style="${inputStyle} width:auto;" />
          </div>
          <p style="font-size:.77rem;color:#aaa;margin:0 0 .45rem;">
            End &lt; start → curfew ends next day
          </p>
        </div>

        <!-- Affects -->
        <div>
          <label style="${labelStyle}">Affects</label>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;">
            ${[['All Ages', 'users'], ['Minors Only', 'baby'], ['Custom', 'pencil-line']].map(([a, em]) => `
              <label style="display:inline-flex;align-items:center;gap:.4rem;
                padding:.4rem .9rem;border-radius:999px;cursor:pointer;
                border:1.5px solid ${affectsVal === a ? '#1a3a1a' : '#e0e0e0'};
                background:${affectsVal === a ? '#1a3a1a' : '#fff'};
                color:${affectsVal === a ? '#fff' : '#555'};
                font-size:.8rem;font-weight:600;transition:all .15s;">
                <input type="radio" name="cfAffects" value="${a}"
                  ${affectsVal === a ? 'checked' : ''} style="display:none"
                  onchange="curfewAffectsChange()" /><i data-lucide="${em}" style="width:13px;height:13px;"></i> ${a}
              </label>`).join('')}
          </div>
          <div id="cfAffectsCustomWrap"
            style="margin-top:.6rem;display:${affectsVal === 'Custom' ? 'flex' : 'none'};align-items:center;gap:.5rem;">
            <input id="cfAgeMin" type="number" min="0" max="100"
              placeholder="Min age"
              value="${isCustom && customAffects.includes('-') ? customAffects.split('-')[0].replace('Ages ', '').trim() : ''}"
              style="${inputStyle} width:90px;" />
            <span style="color:#888;font-size:.85rem;">to</span>
            <input id="cfAgeMax" type="number" min="0" max="100"
              placeholder="Max age"
              value="${isCustom && customAffects.includes('-') ? customAffects.split('-')[1]?.trim() : ''}"
              style="${inputStyle} width:90px;" />
          </div>
        </div>

        <!-- Exception dates (weekly only) -->
        <div id="cfExRow" ${type !== 'weekly' ? 'hidden' : ''}>
          <label style="${labelStyle}">Exception dates
            <span style="font-weight:400;text-transform:none;">(skip curfew on these days)</span>
          </label>
          <div id="cfExTags" style="display:flex;flex-wrap:wrap;gap:.4rem;min-height:24px;margin-bottom:.5rem;"></div>
          <div style="display:flex;gap:.5rem;align-items:center;">
            <input id="cfExInput" type="date" style="${inputStyle} width:auto;" />
            <button type="button" onclick="curfewAddException()"
              style="padding:.45rem .9rem;border-radius:8px;border:1.5px solid #1a3a1a;
                background:#fff;color:#1a3a1a;font-size:.8rem;font-weight:600;cursor:pointer;">
              + Add
            </button>
          </div>
          <p style="font-size:.73rem;color:#aaa;margin:.3rem 0 0;">
            Curfew is skipped entirely on exception dates.
          </p>
        </div>

        <!-- Internal note -->
        <div>
          <label style="${labelStyle}">Internal note
            <span style="font-weight:400;text-transform:none;">(optional)</span>
          </label>
          <input id="cfNote" type="text"
            value="${esc(d.note || '')}"
            placeholder="e.g. Per Barangay Resolution No. 2024-01"
            style="${inputStyle}" />
        </div>

        <!-- Actions -->
        <div style="display:flex;gap:.6rem;margin-top:.25rem;flex-wrap:wrap;align-items:center;">
          <button type="button" id="cfSaveBtn" onclick="curfewSave()"
            style="display:inline-flex;align-items:center;gap:.45rem;
              padding:.6rem 1.4rem;border-radius:8px;background:#1a3a1a;
              color:#fff;border:none;font-size:.9rem;font-weight:600;cursor:pointer;transition:background .15s;"
            onmouseover="this.style.background='#14291a'"
            onmouseout="this.style.background='#1a3a1a'">
            <i data-lucide="save" style="width:15px;height:15px;"></i>
            ${isEdit ? 'Update Schedule' : 'Save Schedule'}
          </button>
          <button type="button" onclick="curfewCancelEdit()"
            style="padding:.6rem 1.1rem;border-radius:8px;border:1.5px solid #e0e0e0;
              background:#fff;color:#555;font-size:.9rem;font-weight:500;cursor:pointer;transition:background .15s;"
            onmouseover="this.style.background='#f4f6f9'"
            onmouseout="this.style.background='#fff'">
            ${isEdit ? 'Cancel' : 'Discard'}
          </button>
        </div>

      </div>
    </div>`;

  _renderExTags();
  lucide.createIcons({ el });

  DAYS.forEach(day => {
    const inp = el.querySelector(`input[value="${day}"][name="cfDays"]`);
    if (inp) curfewDayToggle(day, inp.checked);
  });
}
