/* ================================================
   alerts-admin.js — BarangayConnect
   Admin interface for broadcasting and managing site-wide alerts.
   Runs only for authenticated users; scoped to their barangay.

   WHAT IS IN HERE:
     · Severity design token maps and label strings
     · Module-level state (countdown timer, current collection ref, form visibility)
     · injectConfirmModal     — lazily injects the two-step publish modal into the DOM
     · showPublishConfirm     — returns a Promise; resolves on publish, rejects on cancel
     · renderAlertForm        — toggles between the collapsed button and the full form
     · handleCreateAlert      — reads form, runs the confirm flow, writes to Firestore
     · initAlertsAdmin        — bootstraps the snapshot listener and form for a barangay
     · renderAlertList        — renders the full list of alert management rows
     · buildAlertRow          — builds a single alert row element with toggle / delete actions
     · toggleAlert            — flips the active flag on an alert document
     · deleteAlert            — permanently removes an alert document
     · esc                    — HTML-escapes strings for safe innerHTML interpolation
     · showAdminToast         — appends a transient toast to #toastContainer

   WHAT IS NOT IN HERE:
     · Firebase config and db instance         → firebase-config.js
     · Firestore path helpers                  → db-paths.js
     · Global modal / frame styles             → frames.css
     · Resident-facing alert banner rendering  → alerts.js

   REQUIRED IMPORTS:
     · ../../core/firebase-config.js          (auth, db)
     · ../../core/db-paths.js                 (userIndexDoc, barangayId as toBid)
     · firebase-firestore.js@10.12.0 (collection, onSnapshot, addDoc, updateDoc,
                                      deleteDoc, doc, serverTimestamp, Timestamp,
                                      orderBy, query, getDoc)
     · firebase-auth.js@10.12.0      (onAuthStateChanged)

   QUICK REFERENCE:
     Bootstrap          → onAuthStateChanged (top-level, runs on load)
     Init per barangay  → initAlertsAdmin(barangay)
     Confirm flow       → showPublishConfirm(alertData) → Promise
     Form toggle        → window.showAlertForm() / window.hideAlertForm()
     Row actions        → window.toggleAlert(id, barangayId, newState)
                          window.deleteAlert(id, barangay)
================================================ */


// ================================================
// IMPORTS
// ================================================

import { auth, db }                           from '../../core/firebase-config.js';
import { userIndexDoc, barangayId as toBid }  from '../../core/db-paths.js';

import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp, Timestamp, orderBy, query,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import { showConfirm } from '/js/shared/confirm-modal.js';


// ================================================
// CONSTANTS — Severity Maps
// ================================================

/* Maps severity keys to design token sets for inline styling */
const SEVERITY = {
  red:    { bg: 'var(--red-100)',  text: 'var(--red-900)',     border: 'var(--red)'          },
  orange: { bg: 'var(--amber-50)', text: 'var(--amber-950)',   border: 'var(--orange-hover)' },
  green:  { bg: 'var(--green-50)', text: 'var(--success-800)', border: 'var(--green-dark)'   },
  blue:   { bg: 'var(--blue-50)',  text: 'var(--blue-800)',    border: 'var(--blue-600)'     },
};

/* Fallback tokens used when a severity key is unrecognised */
const SEVERITY_FALLBACK = {
  bg: 'var(--gray-100)', text: 'var(--gray-700)', border: 'var(--gray-400)',
};

/* Human-readable labels rendered in the publish confirm summary */
const SEVERITY_LABELS = {
  green:  'Green',
  blue:   'Blue',
  orange: 'Orange',
  red:    'Red',
};


// ================================================
// CONSTANTS — Countdown Ring
// ================================================

const COUNTDOWN_SECS     = 5;
const RING_CIRCUMFERENCE = 163.4;   // 2π × r(26) — kept for reference
const RING_R             = 30;
const RING_CIRC          = 2 * Math.PI * RING_R;  // 188.5 — used by the ring animation


// ================================================
// MODULE STATE
// ================================================

let _countdownTimer   = null;   // setInterval handle for the publish countdown
let _currentCol       = null;   // Firestore collection ref, set by initAlertsAdmin
let _alertFormVisible = false;  // tracks whether the create form is expanded
let _alertSeverityFilter = 'all';
let _alertTypeFilter     = 'all';
let _alertDocs           = [];
let _alertBarangay       = null;


// ================================================
// CONFIRM MODAL — Injection
// ================================================

/*
   Lazily injects the two-step publish modal into the document body.
   Safe to call multiple times — exits early if the modal already exists.
*/

function injectConfirmModal() {
  if (document.getElementById('alertPublishModal')) return;

  const el = document.createElement('div');
  el.id = 'alertPublishModal';
  el.style.cssText = `
    position:fixed;inset:0;z-index:2000;display:none;
    align-items:center;justify-content:center;
    background:rgba(0,0,0,0.55);backdrop-filter:blur(4px);padding:1rem;
  `;
  el.innerHTML = `
    <style>
      #apmCancelBtn1:hover,#apmCancelBtn2:hover{background:#f3f4f6!important;}
      #apmProceedBtn:hover,#apmPublishNowBtn:hover{background:#6f1c1c!important;}
    </style>
    <div id="apmCard" style="background:#fff;border-radius:20px;width:100%;max-width:460px;
      max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.22);padding:2rem;">

      <!-- STEP 1 -->
      <div id="apmStep1">
        <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:1.25rem;">
          <div style="width:44px;height:44px;border-radius:50%;background:#fff8ed;border:2px solid #fed7aa;
            display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <i data-lucide="triangle-alert" style="width:20px;height:20px;color:#d97706;"></i>
          </div>
          <div>
            <h2 style="font-size:1.1rem;font-weight:800;color:#1a1a1a;margin:0;">Broadcast Alert?</h2>
            <p style="font-size:.8rem;color:#9ca3af;margin:0;">Review before publishing</p>
          </div>
        </div>

        <!-- Warning notice -->
        <div style="background:#fff8ed;border:1.5px solid #fed7aa;border-radius:12px;
          padding:.875rem 1rem;margin-bottom:1rem;display:flex;gap:.6rem;align-items:flex-start;">
          <i data-lucide="users" style="width:16px;height:16px;color:#d97706;flex-shrink:0;margin-top:2px;"></i>
          <p style="font-size:.82rem;font-weight:600;color:#92400e;margin:0;line-height:1.5;">
            This alert will be <strong>immediately visible to every resident</strong>
            currently viewing the site. Non-dismissible alerts cannot be closed until you deactivate them.
          </p>
        </div>

        <!-- Alert summary -->
        <div id="apmSummary" style="background:#f9fafb;border:1.5px solid #e5e7eb;border-radius:12px;
          padding:.875rem 1rem;margin-bottom:1.5rem;font-size:.82rem;color:#374151;line-height:1.6;">
        </div>

        <!-- Actions -->
        <div style="display:flex;gap:.5rem;">
          <button id="apmCancelBtn1" style="flex:1;padding:.65rem 1rem;border-radius:999px;
            border:1.5px solid #e5e7eb;background:#fff;color:#374151;font-family:inherit;
            font-size:.85rem;font-weight:600;cursor:pointer;
            onmouseover="this.style.background='#f3f4f6'" onmouseout="this.style.background='#fff'"
            display:flex;align-items:center;
            justify-content:center;gap:.4rem;">
            <i data-lucide="x" style="width:14px;height:14px;"></i> Cancel
          </button>
          <button id="apmProceedBtn" style="flex:2;padding:.65rem 1rem;border-radius:999px;
            border:none;background:#7f1d1d;color:#fff;font-family:inherit;
            font-size:.85rem;font-weight:700;cursor:pointer;
            onmouseover="this.style.background='#6f1c1c'" onmouseout="this.style.background='#7f1d1d'"
            display:flex;align-items:center;
            justify-content:center;gap:.4rem;">
            <i data-lucide="arrow-right" style="width:14px;height:14px;"></i> I Understand, Proceed
          </button>
        </div>
      </div>

      <!-- STEP 2 -->
      <div id="apmStep2" hidden>
        <div style="text-align:center;padding:.5rem 0;">
          <div style="width:44px;height:44px;border-radius:50%;background:#fff8ed;border:2px solid #fed7aa;
            display:flex;align-items:center;justify-content:center;margin:0 auto .75rem;">
            <i data-lucide="clock" style="width:20px;height:20px;color:#d97706;"></i>
          </div>
          <h2 style="font-size:1.1rem;font-weight:800;color:#1a1a1a;margin:0 0 .35rem;">Publishing in…</h2>
          <p style="font-size:.82rem;color:#9ca3af;margin:0 0 1.5rem;line-height:1.5;">
            The alert will go live when the timer hits zero.<br>You can still cancel now.
          </p>

          <!-- Countdown ring -->
          <div style="position:relative;width:80px;height:80px;margin:0 auto 1rem;">
            <svg width="80" height="80" style="transform:rotate(-90deg);">
              <circle cx="40" cy="40" r="34" fill="none" stroke="#f3f4f6" stroke-width="6"/>
              <circle id="apmRing" cx="40" cy="40" r="34" fill="none" stroke="#f97316"
                stroke-width="6" stroke-linecap="round"
                stroke-dasharray="213.6" stroke-dashoffset="0"
                style="transition:stroke-dashoffset 1s linear,stroke .3s;"/>
            </svg>
            <span id="apmCountNum" style="position:absolute;inset:0;display:flex;align-items:center;
              justify-content:center;font-size:1.6rem;font-weight:900;color:#f97316;">5</span>
          </div>
          <p style="font-size:.8rem;color:#9ca3af;margin:0 0 1.5rem;">
            Auto-publishing in <strong id="apmCountLabel" style="color:#374151;">5</strong>s…
          </p>

          <!-- Actions -->
          <div style="display:flex;gap:.5rem;">
            <button id="apmCancelBtn2" style="flex:1;padding:.65rem 1rem;border-radius:999px;
              border:1.5px solid #e5e7eb;background:#fff;color:#374151;font-family:inherit;
              font-size:.85rem;font-weight:600;cursor:pointer;
              onmouseover="this.style.background='#f3f4f6'" onmouseout="this.style.background='#fff'"
              display:flex;align-items:center;
              justify-content:center;gap:.4rem;">
              <i data-lucide="x" style="width:14px;height:14px;"></i> Cancel
            </button>
            <button id="apmPublishNowBtn" style="flex:2;padding:.65rem 1rem;border-radius:999px;
              border:none;background:#7f1d1d;color:#fff;font-family:inherit;
              font-size:.85rem;font-weight:700;cursor:pointer;
              onmouseover="this.style.background='#6f1c1c'" onmouseout="this.style.background='#7f1d1d'"
              display:flex;align-items:center;
              justify-content:center;gap:.4rem;">
              <i data-lucide="send" style="width:14px;height:14px;"></i> Publish Now
            </button>
          </div>
        </div>
      </div>

    </div>
  `;

  document.body.appendChild(el);
  lucide.createIcons({ el });
  if (_currentUserRole === 'admin' || _currentUserRole === 'officer') _wireDragReorderFeatured(el, all);
}


// ================================================
// CONFIRM MODAL — Two-Step Publish Flow
// ================================================

/*
   Returns a Promise that resolves when the admin confirms publication
   (either via "Publish Now" or countdown expiry) and rejects on cancel.

   Step 1 — displays a broadcast warning and alert summary.
            Admin must click "I Understand, Proceed" to continue.
   Step 2 — shows a 5-second countdown ring; auto-resolves at zero.
            Admin can still cancel or skip ahead with "Publish Now".

   Nothing is written to Firestore here — the caller (handleCreateAlert)
   awaits this Promise and writes only on resolve.
*/

function showPublishConfirm(alertData) {
  injectConfirmModal();

  return new Promise((resolve, reject) => {
    const modal      = document.getElementById('alertPublishModal');
    const step1      = document.getElementById('apmStep1');
    const step2      = document.getElementById('apmStep2');
    const summary    = document.getElementById('apmSummary');
    const ring       = document.getElementById('apmRing');
    const countNum   = document.getElementById('apmCountNum');
    const countLabel = document.getElementById('apmCountLabel');
    const cancelBtn1 = document.getElementById('apmCancelBtn1');
    const cancelBtn2 = document.getElementById('apmCancelBtn2');
    const proceedBtn = document.getElementById('apmProceedBtn');
    const nowBtn     = document.getElementById('apmPublishNowBtn');

    const RING_CIRC = 213.6;

    /* Reset to step 1 */
    step1.hidden = false;
    step2.hidden = true;

    summary.innerHTML = `
      <strong style="font-size:.92rem;display:block;margin-bottom:.4rem;color:#1a1a1a;line-height:1.4;">${esc(alertData.title)}</strong>
      <p style="font-size:.82rem;color:#6b7280;margin:0 0 .75rem;line-height:1.5;">${esc(alertData.message)}</p>
      <div style="display:flex;flex-wrap:wrap;gap:.35rem;">
        <span style="background:#f3f4f6;color:#374151;border:1px solid #e5e7eb;padding:2px 10px;border-radius:999px;font-size:.7rem;font-weight:700;">${SEVERITY_LABELS[alertData.severity] ?? alertData.severity}</span>
        <span style="background:#f3f4f6;color:#374151;border:1px solid #e5e7eb;padding:2px 10px;border-radius:999px;font-size:.7rem;font-weight:700;">${esc((alertData.type||'').replace(/\b\w/g,c=>c.toUpperCase()))}</span>
        ${alertData.dismissible
          ? `<span style="background:#f3f4f6;color:#374151;border:1px solid #e5e7eb;padding:2px 10px;border-radius:999px;font-size:.7rem;font-weight:700;">Dismissible</span>`
          : `<span style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;padding:2px 10px;border-radius:999px;font-size:.7rem;font-weight:700;">Non-dismissible</span>`}
        ${alertData.expiresAt
          ? `<span style="background:#fff8ed;color:#92400e;border:1px solid #fed7aa;padding:2px 10px;border-radius:999px;font-size:.7rem;font-weight:700;">⏱ ${alertData.expiresAt.toDate().toLocaleString('en-PH',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span>`
          : ''}
      </div>
    `;

    lucide.createIcons({ el: document.getElementById('apmCard') });
    modal.style.display = 'flex';

    function onCancel() {
      cleanup();
      reject(new Error('cancelled'));
    }

    function onProceed() {
      step1.hidden = true;
      step2.hidden = false;
      lucide.createIcons({ el: document.getElementById('apmCard') });
      startCountdown();
    }

    cancelBtn1.addEventListener('click', onCancel,  { once: true });
    proceedBtn.addEventListener('click', onProceed, { once: true });
    modal.addEventListener('click', (e) => { if (e.target === modal) onCancel(); }, { once: true });

    function startCountdown() {
      let remaining = COUNTDOWN_SECS;
      ring.style.strokeDashoffset = '0';
      ring.style.stroke = '#f97316';
      countNum.style.color = '#f97316';
      countNum.textContent = remaining;
      countLabel.textContent = remaining;

      function tick() {
        remaining -= 1;
        countNum.textContent = remaining;
        countLabel.textContent = remaining;
        ring.style.strokeDashoffset = String(RING_CIRC * ((COUNTDOWN_SECS - remaining) / COUNTDOWN_SECS));
        if (remaining <= 2) {
          ring.style.stroke = '#dc2626';
          countNum.style.color = '#dc2626';
        }
        if (remaining <= 0) { cleanup(); resolve(); }
      }

      _countdownTimer = setInterval(tick, 1000);
      cancelBtn2.addEventListener('click', onCancel,     { once: true });
      nowBtn.addEventListener(    'click', onPublishNow, { once: true });
    }

    function onPublishNow() { cleanup(); resolve(); }

    function cleanup() {
      clearInterval(_countdownTimer);
      _countdownTimer = null;
      modal.style.display = 'none';
      cancelBtn1.removeEventListener('click', onCancel);
      cancelBtn2.removeEventListener('click', onCancel);
      proceedBtn.removeEventListener('click', onProceed);
      nowBtn.removeEventListener(   'click', onPublishNow);
    }
  });
}


// ================================================
// ALERT FORM — Render, Show, Hide
// ================================================

/*
   Renders either the collapsed "Publish New Alert" trigger button
   or the full create form, depending on _alertFormVisible.
   Called by initAlertsAdmin on load and by show/hideAlertForm.
*/

function renderAlertForm(col) {
  const wrap = document.getElementById('alertCreateFormWrap');
  if (!wrap) return;

  if (!_alertFormVisible) {
    wrap.innerHTML = `
      <button onclick="showAlertForm()"
        style="display:flex;align-items:center;justify-content:center;gap:.6rem;
          width:100%;padding:.85rem 1.5rem;border-radius:12px;
          border:2px dashed #d1d5db;background:white;
          color:#374151;font-size:.9rem;font-weight:600;cursor:pointer;
          transition:all .2s;box-shadow:0 1px 3px rgba(0,0,0,.04);margin-bottom:2rem;"
        onmouseover="this.style.borderColor='#1a3a1a';this.style.color='#1a3a1a';this.style.background='#f0fdf4'"
        onmouseout="this.style.borderColor='#d1d5db';this.style.color='#374151';this.style.background='white'">
        <i data-lucide="plus-circle" style="width:18px;height:18px;"></i>
        Publish New Alert
      </button>`;
    lucide.createIcons({ el: wrap });
    return;
  }

  wrap.innerHTML = `
    <div style="background:white;border-radius:12px;padding:1.5rem;
      box-shadow:0 1px 4px rgba(0,0,0,0.08);margin-bottom:2rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem;">
        <h2 style="font-size:1rem;font-weight:700;margin:0;">Publish New Alert</h2>
        <button onclick="hideAlertForm()"
          style="padding:.4rem .9rem;border-radius:8px;border:1.5px solid #e0e0e0;
            background:#fff;color:#555;font-size:.8rem;font-weight:500;cursor:pointer;">
          Cancel
        </button>
      </div>
      <form id="alertCreateForm" style="display:grid;gap:1rem;" novalidate>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;">
          <div>
            <label style="display:block;font-size:0.75rem;font-weight:600;text-transform:uppercase;color:#888;margin-bottom:4px">Severity</label>
            <select id="alertSeverity" style="width:100%;padding:0.55rem 0.75rem;border:1.5px solid #e0e0e0;border-radius:8px;font-size:0.875rem;outline:none;">
              <option value="blue">Blue</option>
              <option value="green">Green</option>  
              <option value="orange">Orange</option>
              <option value="red">Red</option>
            </select>
          </div>
          <div>
            <label style="display:block;font-size:0.75rem;font-weight:600;text-transform:uppercase;color:#888;margin-bottom:4px">Type</label>
            <select id="alertType" style="width:100%;padding:0.55rem 0.75rem;border:1.5px solid #e0e0e0;border-radius:8px;font-size:0.875rem;outline:none;">
              <option value="weather">Weather</option>
              <option value="earthquake">Earthquake</option>
              <option value="emergency">Emergency</option>
              <option value="maintenance">Maintenance</option>
              <option value="info">Info</option>
            </select>
          </div>
          <div style="display:flex;align-items:flex-end;gap:0.5rem;padding-bottom:2px;">
            <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.875rem;font-weight:500;cursor:pointer;">
              <input type="checkbox" id="alertDismissible" checked style="width:16px;height:16px;" />
              Users can dismiss
            </label>
          </div>
        </div>
        <div>
          <label style="display:block;font-size:0.75rem;font-weight:600;text-transform:uppercase;color:#888;margin-bottom:4px">Title</label>
          <input id="alertTitle" type="text" placeholder="e.g. Weather Advisory, Typhoon Carina"
            style="width:100%;padding:0.55rem 0.75rem;border:1.5px solid #e0e0e0;border-radius:8px;font-size:0.875rem;outline:none;" />
        </div>
        <div>
          <label style="display:block;font-size:0.75rem;font-weight:600;text-transform:uppercase;color:#888;margin-bottom:4px">Message</label>
          <textarea id="alertMessage" rows="3" placeholder="Brief description visible to all residents…"
            oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,180)+'px'"
            style="width:100%;padding:0.55rem 0.75rem;border:1.5px solid #e0e0e0;border-radius:8px;font-size:0.875rem;
            outline:none;resize:none;min-height:72px;max-height:180px;overflow-y:auto;transition:height .1s;"></textarea>
        </div>
        <div>
          <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.875rem;font-weight:500;cursor:pointer;margin-bottom:0.5rem;">
            <input type="checkbox" id="alertExpiresToggle" style="width:16px;height:16px;" onchange="document.getElementById('alertExpiresWrap').hidden = !this.checked" />
            Set expiry time (auto-hide after)
          </label>
          <div id="alertExpiresWrap" hidden>
            <input type="datetime-local" id="alertExpiresAt"
              style="padding:0.55rem 0.75rem;border:1.5px solid #e0e0e0;border-radius:8px;font-size:0.875rem;outline:none;" />
          </div>
        </div>
        <div>
          <button type="submit" id="alertCreateBtn" class="btn btn--success">
            <i data-lucide="send"></i> Publish Alert
          </button>
        </div>
      </form>
    </div>`;

  lucide.createIcons({ el: wrap });

  document.getElementById('alertCreateForm')
    ?.addEventListener('submit', (e) => { e.preventDefault(); handleCreateAlert(col); });
}

/* Expands the create form and scrolls it into view */
window.showAlertForm = function() {
  _alertFormVisible = true;
  renderAlertForm(_currentCol);
  document.getElementById('alertCreateFormWrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

/* Collapses the create form back to the trigger button */
window.hideAlertForm = function() {
  _alertFormVisible = false;
  renderAlertForm(_currentCol);
};


// ================================================
// ALERT FORM — Create Handler
// ================================================

/*
   Reads and validates the form fields, runs the two-step publish confirm,
   and writes the new alert to Firestore on resolve.
   The form stays populated if the admin cancels the confirm flow.
*/

async function handleCreateAlert(col) {
  const btn = document.getElementById('alertCreateBtn');

  const title       = document.getElementById('alertTitle').value.trim();
  const message     = document.getElementById('alertMessage').value.trim();
  const severity    = document.getElementById('alertSeverity').value;
  const type        = document.getElementById('alertType').value;
  const dismissible = document.getElementById('alertDismissible').checked;
  const useExpiry   = document.getElementById('alertExpiresToggle').checked;
  const expiresVal  = document.getElementById('alertExpiresAt').value;

  let expiresAt = null;
  if (useExpiry && expiresVal) {
    expiresAt = Timestamp.fromDate(new Date(expiresVal));
  }

  if (!title) { showAdminToast('Please enter an alert title.', 'error'); return; }
  if (!message) { showAdminToast('Please enter an alert message.', 'error'); return; }
  if (useExpiry && !expiresVal) { showAdminToast('Please set an expiry date or uncheck the expiry option.', 'error'); return; }

  const alertData = {
    type, severity, title, message,
    source: 'admin', active: true, dismissible, expiresAt,
  };

  /* Run two-step confirm before touching Firestore */
  try {
    await showPublishConfirm(alertData);
  } catch {
    return; // Admin cancelled — form stays populated, nothing written
  }

  btn.disabled = true;

  try {
    await addDoc(col, {
      ...alertData,
      createdAt: serverTimestamp(),
      createdBy: auth.currentUser.uid,
    });

    _alertFormVisible = false;
    renderAlertForm(col);
    showAdminToast('Alert published — visible to all residents now.', 'success');

  } catch (err) {
    console.error('Create alert failed:', err);
    showAdminToast('Failed to publish alert. Please try again.', 'error');
  } finally {
    btn.disabled = false;
  }
}


// ================================================
// BOOTSTRAP
// ================================================

/*
   Resolves the admin's barangay from userIndex, then initialises
   the snapshot listener and form. Dynamic import of getDoc avoids
   a circular dependency with the top-level imports.
*/

onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  const { getDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
  const snap = await getDoc(userIndexDoc(user.uid));
  if (!snap.exists()) return;

  const { barangay } = snap.data();
  initAlertsAdmin(barangay);
});

function initAlertsAdmin(barangay) {
  _alertBarangay = barangay;
  const col = collection(db, 'barangays', toBid(barangay), 'siteAlerts');
  _currentCol = col;

  const q = query(col, orderBy('createdAt', 'desc'));
  onSnapshot(q, (snap) => {
  _alertDocs = snap.docs;
  renderAlertList(barangay, snap.docs);
});

  renderAlertForm(col);

  document.getElementById('alertExpiresToggle')
    ?.addEventListener('change', (e) => {
      document.getElementById('alertExpiresWrap').hidden = !e.target.checked;
    });
}


// ================================================
// ALERT LIST — Render
// ================================================

/*
   Renders all alert management rows into #alertsList.
   Shows an empty state when the snapshot contains no documents.
   Note: the empty-state innerHTML must be set explicitly here —
   the initial "Loading…" placeholder is never auto-cleared by the snapshot.
*/

function renderAlertList(barangay, docs) {
  const container = document.getElementById('alertsList');
  if (!container) return;

  const filtered = _alertSeverityFilter === 'all' && _alertTypeFilter === 'all'
  ? docs
  : docs.filter(d => {
      const data = d.data();
      const okSev  = _alertSeverityFilter === 'all' || data.severity === _alertSeverityFilter;
      const okType = _alertTypeFilter     === 'all' || data.type     === _alertTypeFilter;
      return okSev && okType;
    });

  const _dot = (color) =>
    `<span style="width:8px;height:8px;border-radius:50%;background:${color};
      display:inline-block;flex-shrink:0;"></span>`;

  const filterHtml = `
  <div style="display:flex;flex-direction:row;align-items:center;gap:1rem;margin-bottom:1rem;flex-wrap:wrap;">
    <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
      <span style="font-size:.65rem;font-weight:700;text-transform:uppercase;
        color:#9ca3af;letter-spacing:.06em;min-width:48px;">Severity</span>
      <div style="display:inline-flex;background:var(--alpha-ink-07);
        border-radius:var(--radius-full);padding:3px;gap:2px;">
        <button class="bulletin-view-btn admin-subtab-btn alert-severity-btn ${_alertSeverityFilter==='all'?'is-active':''}" onclick="setAlertSeverityFilter('all',this)">All</button>
        <button class="bulletin-view-btn admin-subtab-btn alert-severity-btn ${_alertSeverityFilter==='blue'?'is-active':''}" onclick="setAlertSeverityFilter('blue',this)">Blue</button>
        <button class="bulletin-view-btn admin-subtab-btn alert-severity-btn ${_alertSeverityFilter==='green'?'is-active':''}" onclick="setAlertSeverityFilter('green',this)">Green</button>
        <button class="bulletin-view-btn admin-subtab-btn alert-severity-btn ${_alertSeverityFilter==='orange'?'is-active':''}" onclick="setAlertSeverityFilter('orange',this)">Orange</button>
        <button class="bulletin-view-btn admin-subtab-btn alert-severity-btn ${_alertSeverityFilter==='red'?'is-active':''}" onclick="setAlertSeverityFilter('red',this)">Red</button>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
      <span style="font-size:.65rem;font-weight:700;text-transform:uppercase;
        color:#9ca3af;letter-spacing:.06em;min-width:48px;">Type</span>
      <div style="display:inline-flex;background:var(--alpha-ink-07);
        border-radius:var(--radius-full);padding:3px;gap:2px;flex-wrap:wrap;">
        <button class="bulletin-view-btn admin-subtab-btn alert-type-btn ${_alertTypeFilter==='all'?'is-active':''}" onclick="setAlertTypeFilter('all',this)">All</button>
        <button class="bulletin-view-btn admin-subtab-btn alert-type-btn ${_alertTypeFilter==='weather'?'is-active':''}" onclick="setAlertTypeFilter('weather',this)">Weather</button>
        <button class="bulletin-view-btn admin-subtab-btn alert-type-btn ${_alertTypeFilter==='earthquake'?'is-active':''}" onclick="setAlertTypeFilter('earthquake',this)">Earthquake</button>
        <button class="bulletin-view-btn admin-subtab-btn alert-type-btn ${_alertTypeFilter==='emergency'?'is-active':''}" onclick="setAlertTypeFilter('emergency',this)">Emergency</button>
        <button class="bulletin-view-btn admin-subtab-btn alert-type-btn ${_alertTypeFilter==='maintenance'?'is-active':''}" onclick="setAlertTypeFilter('maintenance',this)">Maintenance</button>
        <button class="bulletin-view-btn admin-subtab-btn alert-type-btn ${_alertTypeFilter==='info'?'is-active':''}" onclick="setAlertTypeFilter('info',this)">Info</button>
      </div>
    </div>
  </div>`;

  if (!docs.length) {
    container.innerHTML = filterHtml + `
      <div style="background:var(--white);border-radius:var(--radius-md);
        padding:var(--space-2xl) var(--space-lg);box-shadow:var(--shadow-sm);
        text-align:center;color:var(--gray-400);">
        <i data-lucide="bell-off" style="width:32px;height:32px;margin-bottom:var(--space-sm);
          color:var(--gray-200);display:block;margin-inline:auto;"></i>
        <p style="font-size:var(--text-sm);margin:0;">No alerts yet. Use the form below to broadcast one.</p>
      </div>`;
    lucide.createIcons({ el: container });
    return;
  }

  if (!filtered.length) {
    container.innerHTML = filterHtml + `
      <div style="background:var(--white);border-radius:var(--radius-md);
        padding:var(--space-2xl) var(--space-lg);box-shadow:var(--shadow-sm);
        text-align:center;color:var(--gray-400);">
        <i data-lucide="filter-x" style="width:32px;height:32px;margin-bottom:var(--space-sm);
          color:var(--gray-200);display:block;margin-inline:auto;"></i>
        <p style="font-size:var(--text-sm);margin:0;">No alerts match this filter.</p>
      </div>`;
    lucide.createIcons({ el: container });
    return;
  }

  container.innerHTML = filterHtml;
  filtered.forEach(docSnap => {
    container.appendChild(buildAlertRow(barangay, docSnap.id, docSnap.data()));
  });
  lucide.createIcons({ el: container });
}


// ================================================
// ALERT LIST — Build Row
// ================================================

/*
   Constructs and returns the DOM element for a single alert management row.
   Includes severity pill, title, message, metadata, and toggle / delete buttons.
*/

function buildAlertRow(barangay, id, d) {
  const sev     = SEVERITY[d.severity] ?? SEVERITY_FALLBACK;
  const expires = d.expiresAt
    ? `Expires ${d.expiresAt.toDate().toLocaleString('en-PH', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })}`
    : 'No expiry';
  const created = d.createdAt?.toDate?.()
    ?.toLocaleString('en-PH', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    ?? '—';

  const row = document.createElement('div');
  row.style.cssText = `
    background:    var(--white);
    border-radius: var(--radius-md);
    padding:       var(--space-md) var(--space-lg);
    box-shadow:    var(--shadow-sm);
    display:       grid;
    grid-template-columns: auto 1fr auto;
    gap:           var(--space-md);
    align-items:   start;
    opacity:       ${d.active ? '1' : '0.55'};
    border-left:   4px solid ${sev.border};
    transition:    opacity var(--transition);
  `;

  row.innerHTML = `
    <div>
      <span style="
        display:        inline-flex;
        align-items:    center;
        background:     ${sev.bg};
        color:          ${sev.text};
        padding:        4px 10px;
        border-radius:  var(--radius-full);
        font-size:      var(--text-2xs);
        font-weight:    var(--fw-bold);
        font-family:    var(--font-display);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        white-space:    nowrap;
      ">${esc(d.severity ?? 'blue')}</span>
    </div>

    <div>
      <p style="
        font-weight: var(--fw-semibold);
        font-size:   var(--text-base-sm);
        font-family: var(--font-display);
        color:       var(--text-dark);
        margin:      0 0 2px;
      ">
        ${esc(d.title)}
        ${d.active
          ? `<span class="admin-badge admin-badge--live" style="margin-left:6px;">LIVE</span>`
          : `<span class="admin-badge admin-badge--inactive" style="margin-left:6px;">INACTIVE</span>`
        }
      </p>
      <p style="font-size:var(--text-sm);color:var(--text-muted);
                margin:0 0 var(--space-xs);">
        ${esc(d.message)}
      </p>
      <p style="font-size:var(--text-2xs);color:var(--gray-400);margin:0;">
        ${esc((d.type||'').replace(/\b\w/g,c=>c.toUpperCase()))} &middot; ${esc((d.source||'').replace(/\b\w/g,c=>c.toUpperCase()))}
        &middot; Created ${created} &middot; ${expires}
        ${d.dismissible
          ? ''
          : `&middot; <strong style="color:var(--red);">Non-dismissible</strong>`}
      </p>
    </div>

    <div style="display:flex;gap:var(--space-sm);flex-shrink:0;">
      <button
        onclick="toggleAlert('${id}','${toBid(barangay)}',${!d.active})"
        title="${d.active ? 'Deactivate' : 'Reactivate'}"
        style="padding:6px 12px;border-radius:var(--radius-sm);
               border:1.5px solid var(--gray-200);background:var(--white);
               color:var(--gray-700);font-size:var(--text-sm);
               font-weight:var(--fw-semibold);cursor:pointer;">
        <i data-lucide="${d.active ? 'eye-off' : 'eye'}"></i>
      </button>
      <button
        onclick="deleteAlert('${id}','${barangay}')"
        title="Delete permanently"
        style="padding:6px 12px;border-radius:var(--radius-sm);
               border:1.5px solid var(--red-200);background:var(--red-50);
               color:var(--red);font-size:var(--text-sm);
               font-weight:var(--fw-semibold);cursor:pointer;">
        <i data-lucide="trash-2"></i>
      </button>
    </div>
  `;

  return row;
}


// ================================================
// ALERT ACTIONS — Toggle / Delete
// ================================================

window.setAlertSeverityFilter = function (severity, btn) {
  _alertSeverityFilter = severity;
  document.querySelectorAll('.alert-severity-btn')
    .forEach(b => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  renderAlertList(_alertBarangay, _alertDocs);
};

window.setAlertTypeFilter = function (type, btn) {
  _alertTypeFilter = type;
  document.querySelectorAll('.alert-type-btn')
    .forEach(b => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  renderAlertList(_alertBarangay, _alertDocs);
};

/* Flips the active flag on an alert document */
window.toggleAlert = async function(id, barangayId, newState) {
  try {
    await updateDoc(doc(db, 'barangays', barangayId, 'siteAlerts', id), {
      active: newState,
    });
    showAdminToast(newState ? 'Alert reactivated.' : 'Alert deactivated.', 'success');
  } catch (err) {
    console.error('Toggle failed:', err);
    showAdminToast('Could not update alert.', 'error');
  }
};

/* Permanently removes an alert document after a native confirm */
window.deleteAlert = async function(id, barangay) {
  const ok = await showConfirm({ title: 'Delete Alert?',
    body: 'This alert will be permanently removed and residents will no longer see it.', confirm: 'Delete', cancel: 'Go Back', variant: 'danger' });
  if (!ok) return;
  try {
    await deleteDoc(doc(db, 'barangays', toBid(barangay), 'siteAlerts', id));
    showAdminToast('Alert deleted.', 'success');
  } catch (err) {
    console.error('Delete failed:', err);
    showAdminToast('Could not delete alert.', 'error');
  }
};


// ================================================
// UTILITIES
// ================================================

/* HTML-escapes a value for safe use in innerHTML interpolation */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

/* Appends a transient toast to #toastContainer; auto-removes after 3.5s */
function showAdminToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast     = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <i data-lucide="${type === 'success' ? 'check' : 'x-circle'}"></i>
    ${esc(message)}
  `;

  container.appendChild(toast);
  lucide.createIcons({ el: toast });
  setTimeout(() => toast.remove(), 3500);
}
