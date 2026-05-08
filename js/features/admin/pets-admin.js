/* ================================================
   pets-admin.js — BarangayConnect
   Admin/officer panel for the Pet Board.
   Manages pending approval queue, active reports,
   resolution, rejection, and auto-expiry archiving.

   Firestore paths:
     barangays/{barangayId}/pets/{reportId}
     barangays/{barangayId}/pets/{reportId}/contacts/{contactId}
     barangays/{barangayId}/meta/settings  (lastExpiryCheck)

   WHAT IS IN HERE:
     · Auth-gated init — admin and officer only
     · 4 sub-tabs: Pending / Active / Resolved / Archive
     · Live onSnapshot subscriptions per status
     · Approve with pet_approved notification
     · Inline rejection form — preset chips + custom reason
     · Reject with pet_rejected notification + reason
     · Manual resolve for any active report
     · Auto-expiry batch check with 24h guard via lastExpiryCheck
     · Contact log viewer modal per report
     · Toast notifications

   WHAT IS NOT IN HERE:
     · Resident submission flow   → pets.js
     · Pet Board card rendering   → pets.js
     · Firestore path helpers     → db-paths.js
     · Notification sending       → notifications.js

   REQUIRED IMPORTS:
     · ../../core/firebase-config.js  (auth, db)
     · ../../core/db-paths.js         (userIndexDoc, barangayId as toBid,
                                       petsCol, petDoc, petContactsCol)
     · /js/shared/notifications.js    (sendNotification)
     · firebase-firestore.js@10.12.0
     · firebase-auth.js@10.12.0

   QUICK REFERENCE:
     Init                → onAuthStateChanged (auto-runs on import)
     Sub-tab switch      → window.setPetsAdminSubTab(sub, btn)
     Approve             → window.approvePetReport(reportId)
     Open reject form    → window.openPetRejectionForm(reportId, petName)
     Preset chip select  → window.selectPetRejectPreset(reportId, btn)
     Confirm rejection   → window.confirmPetRejection(reportId, reporterUid)
     Cancel rejection    → window.cancelRejectionForm(reportId)
     Manual resolve      → window.manualResolvePet(reportId, petName)
     Contact log         → window.openPetContactLog(reportId, petName, count)
     Auto-expiry         → checkAndExpirePets() (called on init)
================================================ */


// ================================================
// IMPORTS
// ================================================

import { auth, db } from '../../core/firebase-config.js';
import {
  userIndexDoc, barangayId as toBid,
  petsCol, petDoc, petContactsCol,
} from '../../core/db-paths.js';
import { sendNotification } from '/js/shared/notifications.js';

import {
  onSnapshot, query, where, orderBy,
  updateDoc, getDocs, writeBatch, serverTimestamp,
  Timestamp, doc, getDoc, setDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

import {
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';


// ================================================
// MODULE STATE
// ================================================

let BARANGAY_ID = null;
let _currentUid = null;
let _pending    = [];   // local mirror — used by approve() for notification lookup
let _active     = [];

const TYPE_LABEL = { missing: 'Missing', found: 'Found Stray', adoption: 'For Adoption' };

/* ── Admin photo viewer — adapts plain URLs to openLightbox's {url,label} format ── */
window._openPetPhotosAdmin = function(urls, idx, name) {
  const images = Array.isArray(urls) ? urls : [urls];
  window.openImageViewer(images, idx ?? 0, name);
};

/* ── Pet detail viewer — reuses eventsDetailModal to avoid a second modal ── */
window.openPetAdminDetail = async function(reportId) {
  let r = [..._pending, ..._active].find(p => p.id === reportId);
  if (!r) {
    try {
      const snap = await getDoc(petDoc(BARANGAY_ID, reportId));
      if (!snap.exists()) return;
      r = { id: snap.id, ...snap.data() };
    } catch(e) { showAdminPetsToast('Could not load report.', 'error'); return; }
  }

  const modal   = document.getElementById('eventsDetailModal');
  const titleEl = document.getElementById('eventsDetailTitle');
  const metaEl  = document.getElementById('eventsDetailMeta');
  const bodyEl  = document.getElementById('eventsDetailBody');
  const footerEl = document.getElementById('eventsDetailFooter');
  if (!modal || !bodyEl) return;

  if (titleEl) titleEl.textContent = r.petName || 'Unknown Pet';
  if (metaEl)  metaEl.textContent  =
    `${esc(TYPE_LABEL[r.type] ?? r.type)} · by ${esc(r.reportedByName || '—')} · ${relTime(r.createdAt?.toDate?.() ?? new Date())}`;

  const images = r.imageURLs?.length ? r.imageURLs : (r.imageURL ? [r.imageURL] : []);
  const name   = r.petName || 'Unknown';
  const encodedImgs = encodeURIComponent(JSON.stringify(images));

  bodyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:var(--space-md);">
      ${images.length ? `
      <div>
        <p class="modal-section-label">Photos</p>
        <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.25rem;">
          ${images.map((url, i) => `
            <img src="${esc(url)}" alt="Photo ${i+1}"
              style="width:88px;height:64px;object-fit:cover;border-radius:8px;
                border:1.5px solid #e5e7eb;cursor:pointer;transition:opacity .15s;"
              onmouseover="this.style.opacity='.8'" onmouseout="this.style.opacity='1'"
              onclick="window._openPetPhotosAdmin(JSON.parse(decodeURIComponent('${encodedImgs}')),${i},'${esc(name)}')" />`
          ).join('')}
        </div>
      </div>` : ''}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-sm);">
        <div>
          <p class="modal-section-label">Species</p>
          <p style="font-size:var(--text-sm);color:#374151;margin:0;">${esc(r.species || '—')}</p>
        </div>
        <div>
          <p class="modal-section-label">Breed</p>
          <p style="font-size:var(--text-sm);color:#374151;margin:0;">${esc(r.breed || '—')}</p>
        </div>
        <div>
          <p class="modal-section-label">Age</p>
          <p style="font-size:var(--text-sm);color:#374151;margin:0;">${esc(r.age || '—')}</p>
        </div>
        <div>
          <p class="modal-section-label">Status</p>
          <p style="font-size:var(--text-sm);color:#374151;margin:0;text-transform:capitalize;">${esc(r.status || '—')}</p>
        </div>
      </div>
      <div>
        <p class="modal-section-label">Location</p>
        <p style="font-size:var(--text-sm);color:#374151;margin:0;">${esc(r.location || '—')}</p>
      </div>
      <div>
        <p class="modal-section-label">Description</p>
        <p style="font-size:var(--text-sm);color:#374151;line-height:1.6;margin:0;">${esc(r.description || '—')}</p>
      </div>
    </div>`;

  if (footerEl) {
    footerEl.innerHTML = r.status === 'pending'
      ? `<button class="btn btn--outline"
           onclick="document.getElementById('eventsDetailModal').classList.remove('is-open')">
           Close
         </button>
         <button onclick="document.getElementById('eventsDetailModal').classList.remove('is-open');window.openPetRejectionForm('${r.id}')"
           style="display:inline-flex;align-items:center;gap:.4rem;padding:.6rem 1.2rem;
             border-radius:8px;border:1.5px solid #fecaca;background:#fff;color:#dc2626;
             font-size:.9rem;font-weight:600;cursor:pointer;">
           <i data-lucide="x" style="width:14px;height:14px;"></i> Reject
         </button>
         <button onclick="document.getElementById('eventsDetailModal').classList.remove('is-open');window.approvePetReport('${r.id}')"
           style="display:inline-flex;align-items:center;gap:.4rem;padding:.6rem 1.2rem;
             border-radius:8px;border:none;background:#1a3a1a;color:#fff;
             font-size:.9rem;font-weight:600;cursor:pointer;">
           <i data-lucide="check" style="width:14px;height:14px;"></i> Approve
         </button>`
      : `<button class="btn btn--outline"
           onclick="document.getElementById('eventsDetailModal').classList.remove('is-open')">
           Close
         </button>`;
  }

  modal.classList.add('is-open');
  lucide?.createIcons?.({ el: modal });
};

/* ── Pet detail viewer — reuses eventsDetailModal to avoid a second modal ── */
window.openPetAdminDetail = async function(reportId) {
  let r = [..._pending, ..._active].find(p => p.id === reportId);
  if (!r) {
    try {
      const snap = await getDoc(petDoc(BARANGAY_ID, reportId));
      if (!snap.exists()) return;
      r = { id: snap.id, ...snap.data() };
    } catch(e) { showAdminPetsToast('Could not load report.', 'error'); return; }
  }

  const modal   = document.getElementById('eventsDetailModal');
  const titleEl = document.getElementById('eventsDetailTitle');
  const metaEl  = document.getElementById('eventsDetailMeta');
  const bodyEl  = document.getElementById('eventsDetailBody');
  const footerEl = document.getElementById('eventsDetailFooter');
  if (!modal || !bodyEl) return;

  if (titleEl) titleEl.textContent = r.petName || 'Unknown Pet';
  if (metaEl)  metaEl.textContent  =
    `${esc(TYPE_LABEL[r.type] ?? r.type)} · by ${esc(r.reportedByName || '—')} · ${relTime(r.createdAt?.toDate?.() ?? new Date())}`;

  const images = r.imageURLs?.length ? r.imageURLs : (r.imageURL ? [r.imageURL] : []);
  const name   = r.petName || 'Unknown';
  const encodedImgs = encodeURIComponent(JSON.stringify(images));

  bodyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:var(--space-md);">
      ${images.length ? `
      <div>
        <p class="modal-section-label">Photos</p>
        <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.25rem;">
          ${images.map((url, i) => `
            <img src="${esc(url)}" alt="Photo ${i+1}"
              style="width:88px;height:64px;object-fit:cover;border-radius:8px;
                border:1.5px solid #e5e7eb;cursor:pointer;transition:opacity .15s;"
              onmouseover="this.style.opacity='.8'" onmouseout="this.style.opacity='1'"
              onclick="window._openPetPhotosAdmin(JSON.parse(decodeURIComponent('${encodedImgs}')),${i},'${esc(name)}')" />`
          ).join('')}
        </div>
      </div>` : ''}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-sm);">
        <div>
          <p class="modal-section-label">Species</p>
          <p style="font-size:var(--text-sm);color:#374151;margin:0;">${esc(r.species || '—')}</p>
        </div>
        <div>
          <p class="modal-section-label">Breed</p>
          <p style="font-size:var(--text-sm);color:#374151;margin:0;">${esc(r.breed || '—')}</p>
        </div>
        <div>
          <p class="modal-section-label">Age</p>
          <p style="font-size:var(--text-sm);color:#374151;margin:0;">${esc(r.age || '—')}</p>
        </div>
        <div>
          <p class="modal-section-label">Status</p>
          <p style="font-size:var(--text-sm);color:#374151;margin:0;text-transform:capitalize;">${esc(r.status || '—')}</p>
        </div>
      </div>
      <div>
        <p class="modal-section-label">Location</p>
        <p style="font-size:var(--text-sm);color:#374151;margin:0;">${esc(r.location || '—')}</p>
      </div>
      <div>
        <p class="modal-section-label">Description</p>
        <p style="font-size:var(--text-sm);color:#374151;line-height:1.6;margin:0;">${esc(r.description || '—')}</p>
      </div>
    </div>`;

  if (footerEl) {
    footerEl.innerHTML = r.status === 'pending'
      ? `<button class="btn btn--outline"
           onclick="document.getElementById('eventsDetailModal').classList.remove('is-open')">
           Close
         </button>
         <button onclick="document.getElementById('eventsDetailModal').classList.remove('is-open');window.openPetRejectionForm('${r.id}')"
           style="display:inline-flex;align-items:center;gap:.4rem;padding:.6rem 1.2rem;
             border-radius:8px;border:1.5px solid #fecaca;background:#fff;color:#dc2626;
             font-size:.9rem;font-weight:600;cursor:pointer;">
           <i data-lucide="x" style="width:14px;height:14px;"></i> Reject
         </button>
         <button onclick="document.getElementById('eventsDetailModal').classList.remove('is-open');window.approvePetReport('${r.id}')"
           style="display:inline-flex;align-items:center;gap:.4rem;padding:.6rem 1.2rem;
             border-radius:8px;border:none;background:#1a3a1a;color:#fff;
             font-size:.9rem;font-weight:600;cursor:pointer;">
           <i data-lucide="check" style="width:14px;height:14px;"></i> Approve
         </button>`
      : `<button class="btn btn--outline"
           onclick="document.getElementById('eventsDetailModal').classList.remove('is-open')">
           Close
         </button>`;
  }

  modal.classList.add('is-open');
  lucide?.createIcons?.({ el: modal });
};

// ================================================
// BOOTSTRAP
// ================================================

onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  const snap = await getDoc(userIndexDoc(user.uid));
  if (!snap.exists()) return;

  const { barangay, role } = snap.data();
  if (role !== 'admin' && role !== 'officer') return;

  BARANGAY_ID = toBid(barangay);
  _currentUid = user.uid;

  _injectContactModal();
  _subscribeAll();
  checkAndExpirePets();
});


// ================================================
// CONTACT LOG MODAL — injected once into admin.html DOM
// ================================================

function _injectContactModal() {
  if (document.getElementById('petsContactLogModal')) return;
  const el = document.createElement('div');
  el.className = 'modal-overlay';
  el.id        = 'petsContactLogModal';
  el.onclick   = function(e) { if (e.target === this) this.classList.remove('is-open'); };
  el.innerHTML = `
    <div class="modal" style="max-width:520px;" onclick="event.stopPropagation()">
      <div class="modal__header modal__header--green">
        <div class="modal__header-icon"><i data-lucide="inbox"></i></div>
        <div class="modal__header-content">
          <p class="modal__header-label">Pet Board</p>
          <h2 class="modal__header-title" id="petsContactLogTitle">Contact Log</h2>
          <p class="modal__header-sub"  id="petsContactLogSub"></p>
        </div>
        <button class="btn btn--close btn--sm modal__close"
          onclick="document.getElementById('petsContactLogModal').classList.remove('is-open')">
          <i data-lucide="x"></i>
        </button>
      </div>
      <div class="modal__body" id="petsContactLogBody"
        style="max-height:60vh;overflow-y:auto;padding:var(--space-lg);"></div>
      <div class="modal__footer">
        <button class="btn btn--outline btn--full"
          onclick="document.getElementById('petsContactLogModal').classList.remove('is-open')">
          Close
        </button>
      </div>
    </div>`;
  document.body.appendChild(el);
  lucide.createIcons({ el });
}


// ================================================
// SUBSCRIPTIONS — one per status
// ================================================

function _subscribeAll() {
  const _configs = [
    { status: 'pending',  listId: 'petsAdminPendingList',  builder: buildPendingRow  },
    { status: 'active',   listId: 'petsAdminActiveList',   builder: buildActiveRow   },
    { status: 'resolved', listId: 'petsAdminResolvedList', builder: buildResolvedRow },
    { status: 'expired',  listId: 'petsAdminArchiveList',  builder: buildResolvedRow },
  ];

  _configs.forEach(({ status, listId, builder }) => {
    onSnapshot(
      query(petsCol(BARANGAY_ID), where('status', '==', status), orderBy('createdAt', 'desc')),
      snap => {
        const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (status === 'pending') {
          _pending = docs;
          const badge = document.getElementById('petsAdminPendingBadge');
          if (badge) {
            badge.textContent   = docs.length;
            badge.style.display = docs.length > 0 ? 'inline' : 'none';
          }
        }
        if (status === 'active') _active = docs;
        _renderList(listId, docs, builder);
      }
    );
  });
}


// ================================================
// RENDER — shared list injector
// ================================================

function _renderList(containerId, docs, builder) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!docs.length) {
    el.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:2.5rem;
        text-align:center;color:#aaa;box-shadow:0 1px 4px rgba(0,0,0,.07);">
        <div style="font-size:2rem;margin-bottom:.5rem;"><i data-lucide="paw-print"></i></div>
        <p style="margin:0;font-size:.9rem;">No reports here.</p>
      </div>`;
    lucide?.createIcons?.({ el });
    return;
  }

  el.innerHTML = docs.map(r => builder(r)).join('');
  lucide?.createIcons?.({ el });
}


// ================================================
// ROW BUILDERS
// ================================================

/* Reusable inline action button style — mirrors bulletin-admin.js row buttons */
function _btn(bg = '#fff', border = '#e0e0e0', color = '#555') {
  return `display:inline-flex;align-items:center;gap:.3rem;padding:5px 10px;
    border-radius:7px;border:1.5px solid ${border};background:${bg};cursor:pointer;
    color:${color};font-size:.78rem;font-weight:500;transition:all .15s;white-space:nowrap;`;
}

function buildPendingRow(r) {
  const imgSrc  = r.imageURL || r.imageURLs?.[0] || '';
  const imgList = r.imageURLs?.length ? r.imageURLs : (imgSrc ? [imgSrc] : []);
  const encoded = encodeURIComponent(JSON.stringify(imgList));
  const name    = esc(r.petName || 'Unknown');
  const time    = relTime(r.createdAt?.toDate?.() ?? new Date());

  return `
<div style="background:#fff;border-radius:12px;padding:1.25rem;
  box-shadow:0 1px 4px rgba(0,0,0,.07);border-left:3px solid #f59e0b;">

  <div style="display:flex;gap:1rem;">
    ${imgSrc ? `<img src="${esc(imgSrc)}"
      style="width:72px;height:72px;object-fit:cover;border-radius:8px;
        flex-shrink:0;cursor:pointer;"
      onclick="window._openPetPhotosAdmin(JSON.parse(decodeURIComponent('${encoded}')),0,'${name}')" />` : ''}
    <div style="flex:1;min-width:0;">
      <div style="display:flex;align-items:center;gap:.35rem;flex-wrap:wrap;margin-bottom:4px;">
        <span class="pet-status pet-status--${esc(r.type)}"
          style="position:static;font-size:.68rem;">
          ${esc(TYPE_LABEL[r.type] ?? r.type)}</span>
        <strong style="font-size:.9rem;">${name}</strong>
        <span class="admin-badge admin-badge--pending">Pending</span>
      </div>
      <p style="font-size:.78rem;color:#6b7280;margin:0 0 2px;">
        ${esc(r.species)}${r.breed ? ' · ' + esc(r.breed) : ''} · ${esc(r.location || '—')}
      </p>
      <p style="font-size:.73rem;color:#9ca3af;margin:0;">
        by ${esc(r.reportedByName || '—')} · ${time}
      </p>
    </div>
  </div>

  <div style="display:flex;gap:.35rem;flex-wrap:wrap;margin-top:.75rem;">
    <button onclick="window.openPetAdminDetail('${r.id}')"
      style="${_btn()}">
      <i data-lucide="eye" style="width:13px;height:13px;"></i> View
    </button>
    <button onclick="window.approvePetReport('${r.id}')"
      style="${_btn('#f0fdf4','#bbf7d0','#15803d')}">
      <i data-lucide="check" style="width:13px;height:13px;"></i> Approve
    </button>
    <button onclick="window.openPetRejectionForm('${r.id}')"
      style="${_btn('#fff0f0','#fecaca','#dc2626')}">
      <i data-lucide="x" style="width:13px;height:13px;"></i> Reject
    </button>
  </div>

  <!-- Inline rejection form — hidden by default -->
  <div id="rejectionForm_${r.id}" style="display:none;background:#fff8f8;
    border:1.5px solid #fecaca;border-radius:8px;padding:1rem;margin-top:.75rem;">
    <p style="font-size:.78rem;font-weight:700;margin:0 0 .5rem;">Rejection Reason:</p>
    <div style="display:flex;flex-wrap:wrap;gap:.35rem;margin-bottom:.5rem;">
      <button class="pet-reject-preset" onclick="window.selectPetRejectPreset('${r.id}',this)"
        data-reason="Blurry or unclear photo"
        style="${_btn()}">Blurry Photo</button>
      <button class="pet-reject-preset" onclick="window.selectPetRejectPreset('${r.id}',this)"
        data-reason="Incomplete location details"
        style="${_btn()}">No Location</button>
      <button class="pet-reject-preset" onclick="window.selectPetRejectPreset('${r.id}',this)"
        data-reason="Inappropriate content"
        style="${_btn()}">Inappropriate</button>
      <button class="pet-reject-preset" onclick="window.selectPetRejectPreset('${r.id}',this)"
        data-reason="Duplicate report"
        style="${_btn()}">Duplicate</button>
    </div>
    <textarea id="customReason_${r.id}" class="form-input" rows="2"
      placeholder="Or type a custom reason…" maxlength="150"
      style="font-size:.82rem;"></textarea>
    <div style="display:flex;gap:.35rem;margin-top:.5rem;">
      <button onclick="window.confirmPetRejection('${r.id}','${esc(r.reportedBy)}')"
        style="${_btn('#fff0f0','#fecaca','#dc2626')}">
        <i data-lucide="send" style="width:13px;height:13px;"></i> Send Rejection
      </button>
      <button onclick="window.cancelRejectionForm('${r.id}')"
        style="${_btn()}">Cancel</button>
    </div>
  </div>

</div>`;
}

function buildActiveRow(r) {
  const imgSrc  = r.imageURL || r.imageURLs?.[0] || '';
  const imgList = r.imageURLs?.length ? r.imageURLs : (imgSrc ? [imgSrc] : []);
  const encoded = encodeURIComponent(JSON.stringify(imgList));
  const name    = esc(r.petName || 'Unknown');
  const time    = relTime(r.createdAt?.toDate?.() ?? new Date());
  const count   = r.contactCount || 0;
  const expiry  = r.expiryDate?.toDate?.();

  return `
<div style="background:#fff;border-radius:12px;padding:1.25rem;
  box-shadow:0 1px 4px rgba(0,0,0,.07);border-left:3px solid #1a3a1a;">

  <div style="display:flex;gap:1rem;">
    ${imgSrc ? `<img src="${esc(imgSrc)}"
      style="width:72px;height:72px;object-fit:cover;border-radius:8px;
        flex-shrink:0;cursor:pointer;"
      onclick="window._openPetPhotosAdmin(JSON.parse(decodeURIComponent('${encoded}')),0,'${name}')" />` : ''}
    <div style="flex:1;min-width:0;">
      <div style="display:flex;align-items:center;gap:.35rem;flex-wrap:wrap;margin-bottom:4px;">
        <span class="pet-status pet-status--${esc(r.type)}"
          style="position:static;font-size:.68rem;">
          ${esc(TYPE_LABEL[r.type] ?? r.type)}</span>
        <strong style="font-size:.9rem;">${name}</strong>
      </div>
      <p style="font-size:.78rem;color:#6b7280;margin:0 0 2px;">
        ${esc(r.species)}${r.breed ? ' · ' + esc(r.breed) : ''} · ${esc(r.location || '—')}
      </p>
      <p style="font-size:.73rem;color:#9ca3af;margin:0;">
        by ${esc(r.reportedByName || '—')} · ${time}
        ${expiry ? ` · <span style="color:#f59e0b;">Expires ${expiry.toLocaleDateString('en-PH',{month:'short',day:'numeric'})}</span>` : ''}
      </p>
    </div>
  </div>

  <div style="display:flex;gap:.35rem;flex-wrap:wrap;margin-top:.75rem;">
    <button onclick="window.openPetAdminDetail('${r.id}')"
      style="${_btn()}">
      <i data-lucide="eye" style="width:13px;height:13px;"></i> View
    </button>
    <button onclick="window.openPetContactLog('${r.id}','${name}',${count})"
      style="${_btn()}">
      <i data-lucide="inbox" style="width:13px;height:13px;"></i> Contacts (${count})
    </button>
    <button onclick="window.manualResolvePet('${r.id}','${name}')"
      style="${_btn('#f0fdf4','#bbf7d0','#15803d')}">
      <i data-lucide="check-circle" style="width:13px;height:13px;"></i> Mark Resolved
    </button>
  </div>

</div>`;
}

function buildResolvedRow(r) {
  const imgSrc  = r.imageURL || r.imageURLs?.[0] || '';
  const name    = esc(r.petName || 'Unknown');
  const time    = relTime(r.resolvedAt?.toDate?.() ?? r.createdAt?.toDate?.() ?? new Date());
  const isAuto  = (r.resolvedNote || '').includes('Auto-archived');
  const accent  = isAuto ? '#d1d5db' : '#bbf7d0';

  return `
<div style="background:#fff;border-radius:12px;padding:1.25rem;
  box-shadow:0 1px 4px rgba(0,0,0,.07);opacity:.85;border-left:3px solid ${accent};">
  <div style="display:flex;gap:1rem;align-items:center;">
    ${imgSrc ? `<img src="${esc(imgSrc)}"
      style="width:56px;height:56px;object-fit:cover;border-radius:8px;
        flex-shrink:0;filter:grayscale(.5);" />` : ''}
    <div style="flex:1;min-width:0;">
      <div style="display:flex;align-items:center;gap:.35rem;flex-wrap:wrap;margin-bottom:2px;">
        <span class="pet-status pet-status--${esc(r.type)}"
          style="position:static;font-size:.68rem;">
          ${esc(TYPE_LABEL[r.type] ?? r.type)}</span>
        <strong style="font-size:.88rem;">${name}</strong>
        <span class="admin-badge admin-badge--active" style="font-size:.68rem;">
          ${isAuto ? 'Auto-archived' : 'Resolved'}
        </span>
      </div>
      <p style="font-size:.73rem;color:#9ca3af;margin:0;">
        ${esc(r.reportedByName || '—')} · Resolved ${time}
        ${r.resolvedNote && !isAuto ? ` · "${esc(r.resolvedNote)}"` : ''}
      </p>
    </div>
  </div>
</div>`;
}


// ================================================
// SUB-TAB SWITCHER
// ================================================

window.setPetsAdminSubTab = function(sub, btn) {
  ['pending','active','resolved','archive'].forEach(s => {
    const el = document.getElementById(`pets-admin-sub-${s}`);
    if (el) el.hidden = s !== sub;
  });
  document.querySelectorAll('.pets-admin-sub-btn')
    .forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
};


// ================================================
// APPROVE
// ================================================

window.approvePetReport = async function(reportId) {
  const report = _pending.find(r => r.id === reportId);
  if (!report) return;
  try {
    await updateDoc(petDoc(BARANGAY_ID, reportId), {
      status:     'active',
      approvedBy: _currentUid,
      approvedAt: serverTimestamp(),
      updatedAt:  serverTimestamp(),
    });
    await sendNotification(BARANGAY_ID, report.reportedBy, {
      type:      'pet_approved',
      actorId:   _currentUid,
      actorName: 'BarangayConnect',
      postId:    reportId,
      postTitle: report.petName || 'your pet report',
    });
    showAdminPetsToast('Report approved and now live.');
  } catch(e) {
    console.error('[pets-admin] approve:', e);
    showAdminPetsToast('Failed to approve. Try again.', 'error');
  }
};


// ================================================
// REJECTION FLOW
// ================================================

window.openPetRejectionForm = function(reportId) {
  const form = document.getElementById(`rejectionForm_${reportId}`);
  if (!form) return;
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
};

window.selectPetRejectPreset = function(reportId, btn) {
  const form = document.getElementById(`rejectionForm_${reportId}`);
  if (!form) return;
  /* Deselect all presets in this form */
  form.querySelectorAll('.pet-reject-preset').forEach(b => {
    b.classList.remove('is-active');
    b.style.background  = '#fff';
    b.style.borderColor = '#e0e0e0';
    b.style.color       = '#555';
  });
  /* Select clicked */
  btn.classList.add('is-active');
  btn.style.background  = '#fff0f0';
  btn.style.borderColor = '#fecaca';
  btn.style.color       = '#dc2626';
  /* Clear custom textarea */
  const ta = document.getElementById(`customReason_${reportId}`);
  if (ta) ta.value = '';
};

window.confirmPetRejection = async function(reportId, reporterUid) {
  const custom = document.getElementById(`customReason_${reportId}`)?.value.trim();
  const preset = document.querySelector(`#rejectionForm_${reportId} .pet-reject-preset.is-active`);
  const reason = custom || preset?.dataset.reason || '';

  if (!reason) {
    showAdminPetsToast('Please select or type a rejection reason.', 'error');
    return;
  }

  try {
    await updateDoc(petDoc(BARANGAY_ID, reportId), {
      status:          'rejected',
      rejectionReason: reason,
      rejectedBy:      _currentUid,
      updatedAt:       serverTimestamp(),
    });
    await sendNotification(BARANGAY_ID, reporterUid, {
      type:        'pet_rejected',
      actorId:     _currentUid,
      actorName:   'BarangayConnect',
      postId:      reportId,
      postTitle:   'your pet report',
      description: `Reason: ${reason}`,
    });
    showAdminPetsToast('Report rejected. User has been notified.');
  } catch(e) {
    console.error('[pets-admin] reject:', e);
    showAdminPetsToast('Failed to reject. Try again.', 'error');
  }
};

window.cancelRejectionForm = function(reportId) {
  const form = document.getElementById(`rejectionForm_${reportId}`);
  if (form) form.style.display = 'none';
};


// ================================================
// MANUAL RESOLVE (admin/officer override)
// ================================================

window.manualResolvePet = async function(reportId, petName) {
  if (!confirm(`Mark "${petName}" as resolved?`)) return;
  try {
    /* Read cleanup delay from settings — mirrors confirmPetResolve in pets.js */
    let _deleteDays = 3;
    try {
      const settingsRef2  = doc(db, 'barangays', BARANGAY_ID, 'meta', 'settings');
      const settingsSnap2 = await getDoc(settingsRef2);
      if (settingsSnap2.exists()) _deleteDays = settingsSnap2.data().petResolvedDeleteDays ?? 3;
    } catch(e) { /* fallback to 3 */ }

    const _deleteAt = _deleteDays > 0
      ? new Date(Date.now() + _deleteDays * 86_400_000)
      : null;

    await updateDoc(petDoc(BARANGAY_ID, reportId), {
      status:       'resolved',
      resolvedBy:   _currentUid,
      resolvedAt:   serverTimestamp(),
      resolvedNote: 'Manually resolved by officer/admin',
      expiryDate:   _deleteAt,
      updatedAt:    serverTimestamp(),
    });
    showAdminPetsToast('Report marked as resolved.');
  } catch(e) {
    console.error('[pets-admin] manual resolve:', e);
    showAdminPetsToast('Failed to resolve. Try again.', 'error');
  }
};


// ================================================
// CONTACT LOG VIEWER
// ================================================

window.openPetContactLog = async function(reportId, petName, count) {
  const modal = document.getElementById('petsContactLogModal');
  const title = document.getElementById('petsContactLogTitle');
  const sub   = document.getElementById('petsContactLogSub');
  const body  = document.getElementById('petsContactLogBody');
  if (!modal) return;

  if (title) title.textContent = `Contacts for ${petName}`;
  if (sub)   sub.textContent   = `${count} message${count !== 1 ? 's' : ''} received`;
  if (body)  body.innerHTML    = `<p style="color:#9ca3af;font-size:.875rem;
    text-align:center;padding:2rem 0;">Loading…</p>`;

  modal.classList.add('is-open');

  try {
    const { getDocs: _gd, query: _q, orderBy: _ob } =
      await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    const snap = await _gd(_q(petContactsCol(BARANGAY_ID, reportId), _ob('sentAt', 'desc')));
    if (!body) return;

    if (snap.empty) {
      body.innerHTML = `<p style="text-align:center;color:#9ca3af;
        font-size:.875rem;padding:2rem 0;">No messages yet.</p>`;
      return;
    }

    body.innerHTML = snap.docs.map(d => {
      const m   = d.data();
      const ago = relTime(m.sentAt?.toDate?.() ?? new Date());
      return `
<div style="border:1px solid #f3f4f6;border-radius:8px;padding:.75rem 1rem;
  margin-bottom:.5rem;background:#fafafa;">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
    <div style="flex:1;min-width:0;">
      <p style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;
        color:#6b7280;margin:0 0 3px;">${esc(m.senderName || 'Anonymous')}</p>
      <p style="font-size:.875rem;color:#374151;margin:0 0 4px;">${esc(m.message || '')}</p>
      ${m.when ? `<p style="font-size:.72rem;color:#9ca3af;margin:0 0 2px;">
        Seen: ${esc(m.when)}</p>` : ''}
      <p style="font-size:.72rem;color:#6b7280;margin:0;">
        <i data-lucide="phone" style="width:11px;height:11px;display:inline;"></i>
        ${esc(m.contactInfo || '—')}
      </p>
    </div>
    <span style="font-size:.7rem;color:#9ca3af;white-space:nowrap;flex-shrink:0;">${ago}</span>
  </div>
</div>`;
    }).join('');

    lucide?.createIcons?.({ el: body });
  } catch(err) {
    console.error('[pets-admin] contact log:', err);
    if (body) body.innerHTML = `<p style="color:#dc2626;text-align:center;
      font-size:.875rem;padding:2rem 0;">Failed to load messages.</p>`;
  }
};


// ================================================
// AUTO-EXPIRY CHECK — once per 24h via lastExpiryCheck
// ================================================

async function checkAndExpirePets() {
  if (!BARANGAY_ID) return;
  try {
    const settingsRef  = doc(db, 'barangays', BARANGAY_ID, 'meta', 'settings');
    const settingsSnap = await getDoc(settingsRef);
    const lastCheck    = settingsSnap.data()?.lastExpiryCheck?.toDate?.() ?? null;

    /* 24h guard — skip if already ran today */
    if (lastCheck && (Date.now() - lastCheck.getTime()) < 86_400_000) return;

    const now  = new Date();
    const snap = await getDocs(query(
      petsCol(BARANGAY_ID),
      where('status',     '==', 'active'),
      where('expiryDate', '<',  Timestamp.fromDate(now)),
    ));

    if (!snap.empty) {
      const batch = writeBatch(db);
      snap.forEach(d => batch.update(d.ref, {
        status:       'expired',
        resolvedNote: 'Auto-archived after 30 days',
        resolvedAt:   serverTimestamp(),
        updatedAt:    serverTimestamp(),
      }));
      await batch.commit();
      showAdminPetsToast(`${snap.size} expired report(s) archived.`);
    }

    /* Always update timestamp so the 24h guard resets */
    await setDoc(settingsRef, { lastExpiryCheck: serverTimestamp() }, { merge: true });

  } catch(e) { console.error('[pets-admin] expiry check:', e); }
}


// ================================================
// TOAST
// ================================================

function showAdminPetsToast(msg, type = 'success') {
  const c = document.getElementById('toastContainer');
  if (!c) return;
  const t     = document.createElement('div');
  t.className = `toast toast--${type}`;
  t.innerHTML = `<i data-lucide="${type === 'success' ? 'check' : 'x-circle'}"></i>${esc(msg)}`;
  c.appendChild(t);
  lucide?.createIcons?.({ el: t });
  setTimeout(() => t.remove(), 3500);
}


// ================================================
// UTILITIES
// ================================================

function relTime(date) {
  if (!date) return '';
  const m = Math.floor((Date.now() - date.getTime()) / 60_000);
  const h = Math.floor(m / 60);
  if (m  <  1) return 'just now';
  if (m  < 60) return `${m}m ago`;
  if (h  < 24) return `${h}h ago`;
  return date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}