/* ================================================
   pets.js — BarangayConnect
   Pet Board: Firestore subscription, card rendering,
   filters (type / species / my reports), pagination.
   Phase 2 — read-only display. No writes.

   WHAT IS IN HERE:
     · initPets()               → entry point, called by community.html
     · subscribeToReports()     → Firestore onSnapshot (active + own)
     · renderPets(gridEl)       → filter + paginate + inject cards
     · buildPetCard(report)     → full card HTML string per report
     · buildStatusBar(report)   → resolved/pending/rejected/expired bar
     · buildCardFooter(report)  → CTA buttons based on type + owner
     · renderSkeletons(gridEl)  → 4 skeleton placeholders while loading
     · _filterReports()         → applies type / species / myReports filters
     · window._filterPetType()  → called by pill clicks
     · window._petsPage(dir)    → called by pagination buttons
     · window.submitPetContact()    → stub (Phase 3)
     · window.confirmPetResolve()   → stub (Phase 3)
     · window.editRejectedPetReport() → stub (Phase 3)

   WHAT IS NOT IN HERE:
     · Write logic (submit / approve / reject) → Phase 3 (pets-write.js)
     · Admin queue                             → pets-admin.js
     · Photo upload helpers                    → Phase 3

   REQUIRED IMPORTS:
     · /js/core/firebase-config.js  (db)
     · /js/core/db-paths.js         (petsCol)
     · firebase-firestore.js@10.12.0

   QUICK REFERENCE:
     initPets()        → called from community.html module script
     window._communityBid must be set by nav-auth.js before this runs
================================================ */

import { db } from '/js/core/firebase-config.js';
import { petsCol } from '/js/core/db-paths.js';
import {
  query, where, orderBy, onSnapshot,
  addDoc, updateDoc, serverTimestamp, getDocs, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { uploadImage } from '/js/core/storage.js';
import { petDoc, petContactsCol, petPhotoPath } from '/js/core/db-paths.js';


// ================================================
// MODULE STATE
// ================================================

let _barangayId   = null;
let _currentUid   = null;
let _currentRole  = 'resident';
let _allReports   = [];
let _unsub        = null;       // active Firestore listener unsubscribe
let _myUnsub      = null;       // "my reports" listener unsubscribe

let _activeType    = 'all';     // all | missing | found | adoption
let _activeSpecies = 'all';     // all | Dog | Cat | Bird | Other
let _myReportsOnly = false;

const PAGE_SIZE = 8;
let _currentPage = 0;

// map report type → display label
const TYPE_LABEL = { missing: 'Missing', found: 'Found Stray', adoption: 'For Adoption' };

let _selectedPetFiles  = [];
let _selectedPetType   = 'missing';
let _linkedMissingId   = null;   // set by matcher selection
let _barangayDisplayName = null;  // raw display name for petPhotoPath
let _currentUserName   = null;


// ================================================
// INIT
// ================================================

export async function initPets() {
  /* Wait for nav-auth — guard against event firing before we listen */
  if (!window._communityBid) {
    await new Promise(resolve => {
      if (window._communityBid) return resolve();
      window.addEventListener('bc:auth-ready', resolve, { once: true });
    });
  }
  const bid  = window._communityBid;
  const uid  = window._currentUid;
  const role = window._currentUserRole || 'resident';
  if (!bid) return;

  _barangayId          = bid;
  _currentUid          = uid || null;
  _currentRole         = role;
  _barangayDisplayName = window._communityBarangayName || bid;
  _currentUserName     = window._currentUserName || '';

  /* Fetch name from users subcollection — same pattern as bulletin.js */
  if (_currentUid && _barangayId) {
    try {
      const { getDoc: _gd, doc: _sd } =
        await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
      const uSnap = await _gd(_sd(db, 'barangays', _barangayId, 'users', _currentUid));
      if (uSnap.exists()) {
        _currentUserName = uSnap.data().fullName ?? uSnap.data().name ?? _currentUserName;
      }
    } catch(e) { console.warn('[pets] name fetch failed:', e); }
  }

  const grid = document.getElementById('petsGrid');
  if (!grid) return;

  /* Show toggle + button only after login */
  if (uid) {
    const toggle = document.getElementById('petsMyReportsToggle');
    if (toggle) toggle.style.display = 'flex';
  }

  _wireFilters();
  _wireSubmitModal();
  renderSkeletons(grid);
  _subscribeActive(grid);

  /* Ensure image viewer is available for pet detail modal */
  if (!window.openImageViewer) {
    import('/js/shared/image-viewer.js').then(m => {
      window.openImageViewer = m.openImageViewer;
      m._injectImageViewer();
    });
  }
}


// ================================================
// FIRESTORE SUBSCRIPTIONS
// ================================================

function _subscribeActive(grid) {
  if (_unsub) _unsub();

  const col = petsCol(_barangayId);
  const q = query(col, where('status', '==', 'active'), orderBy('createdAt', 'desc'));

  _unsub = onSnapshot(q, snap => {
    const active = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (_myReportsOnly && _currentUid) {
      /* Merge: keep existing own reports already fetched */
      const ownIds = new Set(_allReports.filter(r => r.reportedBy === _currentUid).map(r => r.id));
      const freshIds = new Set(active.map(r => r.id));
      /* Remove stale active-only reports that are no longer active */
      _allReports = _allReports.filter(r => r.reportedBy === _currentUid || freshIds.has(r.id));
      active.forEach(r => { if (!ownIds.has(r.id)) _allReports.push(r); });
    } else {
      _allReports = active;
    }

    _currentPage = 0;
    renderPets(grid);
  });
}

function _subscribeMyReports(grid) {
  if (_myUnsub) _myUnsub();
  if (!_currentUid) return;

  const col = petsCol(_barangayId);
  const q = query(col, where('reportedBy', '==', _currentUid), orderBy('createdAt', 'desc'));

  _myUnsub = onSnapshot(q, snap => {
    const mine = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    /* Merge: keep active reports from others, replace own */
    const others = _allReports.filter(r => r.reportedBy !== _currentUid);
    _allReports = [...mine, ...others];
    _currentPage = 0;
    renderPets(grid);
  });
}


// ================================================
// FILTER + PAGINATE + RENDER
// ================================================

function _filterReports() {
  return _allReports.filter(r => {
    if (_myReportsOnly && _currentUid && r.reportedBy !== _currentUid) return false;
    if (_activeType !== 'all' && r.type !== _activeType) return false;
    if (_activeSpecies !== 'all' && r.species !== _activeSpecies) return false;
    return true;
  });
}

export function renderPets(grid) {
  if (!grid) return;
  const filtered = _filterReports();
  const total    = filtered.length;
  const pages    = Math.ceil(total / PAGE_SIZE);
  const slice    = filtered.slice(_currentPage * PAGE_SIZE, (_currentPage + 1) * PAGE_SIZE);

  /* Remove old pagination if present */
  const oldPag = grid.nextElementSibling;
  if (oldPag?.classList.contains('pets-pagination')) oldPag.remove();

  if (total === 0) {
    grid.innerHTML = _buildEmptyState();
    lucide?.createIcons?.({ el: grid });
    return;
  }

  grid.innerHTML = slice.map(buildPetCard).join('');
  lucide?.createIcons?.({ el: grid });

  /* Pagination */
  if (pages > 1) {
    const pag = document.createElement('div');
    pag.className = 'pets-pagination';
    pag.innerHTML = `
      <button class="btn btn--outline btn--sm" ${_currentPage === 0 ? 'disabled' : ''}
        onclick="window._petsPage(-1)">← Prev</button>
      <span class="pets-pagination__label">Page ${_currentPage + 1} of ${pages}</span>
      <button class="btn btn--outline btn--sm" ${_currentPage >= pages - 1 ? 'disabled' : ''}
        onclick="window._petsPage(1)">Next →</button>`;
    grid.after(pag);
    lucide?.createIcons?.({ el: pag });
  }
}


// ================================================
// CARD BUILDER
// ================================================

export function buildPetCard(r) {
  const isOwner   = _currentUid && r.reportedBy === _currentUid;
  const isPending  = r.status === 'pending';
  const isResolved = r.status === 'resolved';
  const isRejected = r.status === 'rejected';
  const isExpired  = r.status === 'expired';

  /* Card modifier classes */
  const cardCls = [
    'pet-card',
    isResolved ? 'pet-card--resolved' : '',
    isPending  ? 'pet-card--pending'  : '',
    isExpired  ? 'pet-card--expired'  : '',
  ].filter(Boolean).join(' ');

  /* Truncate description */
  const desc = (r.description || '').length > 80
    ? r.description.slice(0, 77) + '…'
    : (r.description || '');

  const imgSrc  = r.imageURL || r.imageURLs?.[0] || '';
  const petName = r.petName  || 'Unknown';
  const meta    = [r.species, r.breed, r.age].filter(Boolean).join(' · ');

  /* Pending badge (owner only, top-right) */
  const pendingBadge = (isPending && isOwner)
    ? `<span style="position:absolute;top:8px;left:8px;background:#fef3c7;color:#92400e;
        font-size:var(--text-xs);font-weight:700;font-family:var(--font-display);
        padding:3px 10px;border-radius:999px;letter-spacing:.03em;
        box-shadow:0 2px 6px rgba(0,0,0,.25);border:1.5px solid #f59e0b;">Pending</span>`
    : '';

  /* Type badge (top-left) — shown only for active reports */
  const typeBadge = (!isPending && !isResolved && !isRejected && !isExpired)
    ? `<span class="pet-status pet-status--${r.type}">${TYPE_LABEL[r.type] || r.type}</span>`
    : '';

  return `
<div class="${cardCls}" data-report-id="${r.id}"
  style="cursor:pointer;"
  onclick="window._openPetDetail('${r.id}')">
  <div class="pet-card__img-wrap">
    ${imgSrc ? `<img src="${imgSrc}" alt="${petName}" class="pet-card__img" loading="lazy" />` : ''}
    ${typeBadge}
    ${pendingBadge}
  </div>
  ${buildStatusBar(r, isOwner)}
  <div class="pet-card__body">
    <h3 class="pet-card__name">${petName}</h3>
    ${meta ? `<p class="pet-card__meta">${meta}</p>` : ''}
    ${desc ? `<p class="pet-card__desc">${desc}</p>` : ''}
    <p class="pet-card__meta" style="margin-top:4px;">
      <i data-lucide="map-pin" style="width:12px;height:12px;"></i> ${r.location || '—'}
    </p>
    ${buildCardFooter(r, isOwner)}
  </div>
</div>`;
}


// ================================================
// STATUS BAR
// ================================================

export function buildStatusBar(r, isOwner) {
  if (r.status === 'resolved') {
    return `<div class="pet-card__status-bar pet-card__status-bar--resolved">
      <i data-lucide="check-circle" style="width:12px;height:12px;"></i> Resolved
    </div>`;
  }
  if (r.status === 'pending' && isOwner) {
    return `<div class="pet-card__status-bar pet-card__status-bar--pending">
      <i data-lucide="clock" style="width:12px;height:12px;"></i> Pending Review
    </div>`;
  }
  if (r.status === 'rejected' && isOwner) {
    return `<div class="pet-card__status-bar pet-card__status-bar--rejected"
      onclick="window._showRejection('${r.id}','${(r.petName||'this pet').replace(/'/g,"\\'")}','${(r.rejectionReason||'').replace(/'/g,"\\'")}')">
      <i data-lucide="alert-circle" style="width:12px;height:12px;"></i> Not Approved — tap to view reason
    </div>`;
  }
  if (r.status === 'expired') {
    return `<div class="pet-card__status-bar pet-card__status-bar--expired">
      <i data-lucide="clock" style="width:12px;height:12px;"></i> Expired
    </div>`;
  }
  return '';
}


// ================================================
// CARD FOOTER — CTA BUTTONS
// ================================================

export function buildCardFooter(r, isOwner) {
  /* Resolved — no action */
  /* Stop all footer button clicks from opening the detail modal */
  const _stop = `onclick="event.stopPropagation()"`;

  if (r.status === 'resolved') {
    const note = r.resolvedNote ? `<p class="pet-card__meta" style="margin-top:4px;font-style:italic;">"${r.resolvedNote}"</p>` : '';
    return `<div style="margin-top:8px;display:flex;flex-direction:column;gap:4px;" ${_stop}>
      <span style="display:inline-flex;align-items:center;gap:4px;font-size:var(--text-xs);color:var(--green-dark);font-weight:var(--fw-bold);">
        <i data-lucide="check-circle" style="width:12px;height:12px;"></i> Resolved
      </span>${note}</div>`;
  }

  /* Expired — owner can repost (stub) */
  if (r.status === 'expired') {
    return `<div style="margin-top:8px;" ${_stop}>
      <span style="font-size:var(--text-xs);color:var(--gray-400);">This report has expired.</span>
    </div>`;
  }

  /* Rejected — owner sees reason button */
  if (r.status === 'rejected' && isOwner) {
    return `<div style="margin-top:8px;" ${_stop}>
      <button class="btn btn--outline btn--sm btn--full"
        onclick="window._showRejection('${r.id}','${(r.petName||'this pet').replace(/'/g,"\\'")}','${(r.rejectionReason||'').replace(/'/g,"\\'")}')">
        <i data-lucide="alert-circle"></i> View Rejection Reason
      </button>
    </div>`;
  }

  /* Pending — owner sees disabled state */
  if (r.status === 'pending' && isOwner) {
    return `<div style="margin-top:8px;" ${_stop}>
      <button class="btn btn--outline btn--sm btn--full" disabled>
        <i data-lucide="clock"></i> Pending Review
      </button>
    </div>`;
  }

  /* Active — owner controls */
  if (r.status === 'active' && isOwner) {
    return `<div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;" ${_stop}>
      <div style="display:flex;gap:6px;">
        <button class="btn btn--outline btn--sm" style="flex:1;"
          onclick="window._openPetEdit?.('${r.id}')">
          <i data-lucide="pencil"></i> Edit
        </button>
        <button class="btn btn--green btn--sm" style="flex:1;"
          onclick="window._openResolveModal('${r.id}','${(r.type||'').replace(/'/g,"\\'")}','${(r.petName||'Unknown').replace(/'/g,"\\'")}')">
          <i data-lucide="check"></i> Resolve
        </button>
        <button class="btn btn--outline btn--sm"
          style="color:var(--red,#dc2626);border-color:var(--red,#dc2626);padding:0 10px;"
          onclick="window._confirmDeletePetReport?.('${r.id}','${(r.petName||'Unknown').replace(/'/g,"\\'")}')">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
      ${r.contactCount ? `<button class="btn btn--outline btn--sm btn--full"
        onclick="window._openContactInbox('${r.id}')">
        <i data-lucide="inbox"></i> ${r.contactCount} message${r.contactCount !== 1 ? 's' : ''}
      </button>` : ''}
    </div>`;
  }

  /* Active — non-owner CTAs by type */
  /* Non-owner CTAs — hide entirely if viewer is the owner */
  if (r.reportedBy === _currentUid) return '';

  if (r.type === 'missing') {
    return `<div style="margin-top:8px;" ${_stop}>
      <button class="btn btn--green btn--sm btn--full"
        onclick="window._openContactModal('${r.id}','missing','${(r.petName||'Unknown').replace(/'/g,"\\'")}')">
        <i data-lucide="phone"></i> Share Info
      </button>
    </div>`;
  }
  if (r.type === 'found') {
    return `<div style="margin-top:8px;" ${_stop}>
      <button class="btn btn--outline btn--sm btn--full"
        onclick="window._openContactModal('${r.id}','found','${(r.petName||'Unknown').replace(/'/g,"\\'")}')">
        <i data-lucide="map-pin"></i> View Location
      </button>
    </div>`;
  }
  if (r.type === 'adoption') {
    return `<div style="margin-top:8px;" ${_stop}>
      <button class="btn btn--green btn--sm btn--full"
        onclick="window._openContactModal('${r.id}','adoption','${(r.petName||'Unknown').replace(/'/g,"\\'")}')">
        <i data-lucide="heart"></i> Adopt Pet
      </button>
    </div>`;
  }

  return '';
}


// ================================================
// EMPTY STATE
// ================================================

function _buildEmptyState() {
  const typeLabel = _activeType === 'all' ? 'reports' : `${_activeType} reports`;
  return `<div class="pets-empty">
    <div class="pets-empty__icon"><i data-lucide="paw-print" style="width:48px;height:48px;color:var(--gray-300);"></i></div>
    <p class="pets-empty__title">No pets here yet</p>
    <p>No ${typeLabel} in your area right now.</p>
  </div>`;
}


// ================================================
// SKELETON
// ================================================

export function renderSkeletons(grid) {
  const skelly = () => `
<div class="pets-skeleton">
  <div class="pets-skeleton__img skeleton-shimmer"></div>
  <div class="pets-skeleton__body">
    <div class="skeleton-line skeleton-shimmer" style="width:60%;height:14px;border-radius:4px;"></div>
    <div class="skeleton-line skeleton-shimmer" style="width:80%;height:11px;border-radius:4px;"></div>
    <div class="skeleton-line skeleton-shimmer" style="width:90%;height:11px;border-radius:4px;"></div>
    <div class="skeleton-line skeleton-shimmer" style="width:50%;height:11px;border-radius:4px;"></div>
  </div>
</div>`;
  grid.innerHTML = skelly() + skelly() + skelly() + skelly();
}


// ================================================
// FILTER WIRING
// ================================================

function _wireFilters() {
  /* Type pills */
  document.querySelectorAll('#petsTypeFilters .btn--filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#petsTypeFilters .btn--filter')
        .forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      _activeType = btn.dataset.petType || 'all';
      _currentPage = 0;
      renderPets(document.getElementById('petsGrid'));
    });
  });

  /* Species select */
  document.getElementById('petsSpeciesFilter')?.addEventListener('change', e => {
    _activeSpecies = e.target.value;
    _currentPage = 0;
    renderPets(document.getElementById('petsGrid'));
  });

  /* My Reports toggle */
  document.getElementById('petsMyReportsCheck')?.addEventListener('change', e => {
    _myReportsOnly = e.target.checked;
    _currentPage   = 0;
    const grid = document.getElementById('petsGrid');

    if (_myReportsOnly) {
      /* Subscribe to all own reports (any status) */
      _subscribeMyReports(grid);
    } else {
      /* Tear down own-reports listener, go back to active-only */
      if (_myUnsub) { _myUnsub(); _myUnsub = null; }
      _allReports = [];
      renderSkeletons(grid);
      _subscribeActive(grid);
    }
  });
}


// ================================================
// WINDOW GLOBALS — called from card HTML / modals
// ================================================

/* Pagination */
window._petsPage = function(dir) {
  const filtered = _filterReports();
  const pages = Math.ceil(filtered.length / PAGE_SIZE);
  const next = _currentPage + dir;
  if (next < 0 || next >= pages) return;
  _currentPage = next;
  renderPets(document.getElementById('petsGrid'));
  document.getElementById('tab-pets')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

/* Open Contact Bridge modal with context */
window._openContactModal = function(reportId, type, petName, fromDetail = false) {
  /* Reset body to contact form — clears any stale inbox HTML from _openContactInbox */
  const bodyEl = document.querySelector('#petContactModal .modal__body');
  if (bodyEl) bodyEl.innerHTML = `
    <div class="form-group">
      <label class="form-label">Your Message</label>
      <textarea id="petContactMessage" class="form-input" rows="3"
        placeholder="e.g. I saw your dog near the bakery on Rizal Street this morning."
        maxlength="300"
        oninput="document.getElementById('petContactMsgCount').textContent =
          this.value.length + ' / 300'"></textarea>
      <span class="char-count" id="petContactMsgCount">0 / 300</span>
    </div>
    <div class="form-group">
      <label class="form-label">When did you see the pet?
        <span style="color:#9ca3af;font-size:.75rem;">(optional)</span>
      </label>
      <input type="text" id="petContactWhen" class="form-input"
        placeholder="e.g. This morning around 8AM, Yesterday afternoon"
        maxlength="80" />
    </div>
    <div class="form-group">
      <label class="form-label">Your Contact Info</label>
      <input type="text" id="petContactInfo" class="form-input"
        placeholder="e.g. 0917-123-4567 or fb.com/yourname" maxlength="100" />
      <p style="font-size:.7rem;color:#9ca3af;margin-top:3px;">
        Only the report owner can see this. Never shared publicly.
      </p>
    </div>`;
  const titleEl = document.getElementById('petContactModalTitle');
  const subEl   = document.getElementById('petContactModalSub');
  const labelEl = document.getElementById('petContactModalLabel');
  if (labelEl) labelEl.textContent = 'Pet Board';
  if (titleEl) titleEl.textContent =
    type === 'adoption' ? 'Interested in Adopting' :
    type === 'found'    ? 'Contact About Found Pet' : 'I Have Information';
  if (subEl) subEl.textContent =
    type === 'adoption' ? 'Your message will be sent to the owner' :
    type === 'found'    ? 'Share your location or details with the finder' :
                         'Tell the owner where you last saw their pet';

  /* Update message placeholder based on context */
  const msgEl = document.getElementById('petContactMessage');
  if (msgEl) msgEl.placeholder =
    type === 'adoption' ? 'e.g. I\'m interested in adopting. Can I visit this weekend?' :
    type === 'found'    ? 'e.g. I think I know whose pet this is. They live on Rizal St.' :
                         'e.g. I saw your dog near the bakery on Rizal Street this morning.';

  /* Store context on the submit button for Phase 3 */
  const submitBtn = document.getElementById('petContactSubmitBtn');
  if (submitBtn) {
    submitBtn.dataset.reportId  = reportId;
    submitBtn.dataset.petName   = petName;
    submitBtn.dataset.fromDetail = fromDetail ? '1' : '';
  }

  /* Cancel/Back button */
  const cancelBtn = document.getElementById('petContactCancelBtn');
  if (cancelBtn) {
    if (fromDetail) {
      cancelBtn.textContent = '← Back';
      cancelBtn.onclick = () => {
        closeModal('petContactModal');
        window._openPetDetail(reportId);
      };
    } else {
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = () => closeModal('petContactModal');
    }
  }

  openModal?.('petContactModal');
};

/* Delete own report */
window._confirmDeletePetReport = async function(reportId, petName) {
  if (!confirm(`Delete your report for "${petName}"? This cannot be undone.`)) return;
  try {
    const { deleteDoc: _del, doc: _d } =
      await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    await _del(_d(db, 'barangays', _barangayId, 'pets', reportId));
    _showPetToast('Report deleted.');
  } catch(e) { _showPetToast('Failed to delete. Try again.', 'error'); }
};

/* Open Resolve modal */
window._openResolveModal = function(reportId, type, petName) {
  const titleEl = document.getElementById('petResolveTitle');
  const bodyEl  = document.getElementById('petResolveBody');
  const noteEl  = document.getElementById('petResolveNote');

  const titles = {
    missing:  `${petName || 'Your pet'} was found?`,
    found:    'Pet has been returned?',
    adoption: `${petName || 'Your pet'} found a home?`,
  };
  const bodies = {
    missing:  'Let the community know the good news.',
    found:    'The pet has been reunited with their owner.',
    adoption: 'Let the community know this pet found a home.',
  };

  if (titleEl) titleEl.textContent = titles[type] || 'Mark as Resolved?';
  if (bodyEl)  bodyEl.textContent  = bodies[type] || '';
  if (noteEl)  noteEl.value        = '';

  const btn = document.getElementById('petResolveConfirmBtn');
  if (btn) btn.dataset.reportId = reportId;

  openModal?.('petResolveModal');
};

/* ── Contact inbox — owner reviews messages sent to their report ── */
window._openContactInbox = async function(reportId) {
  const r = _allReports.find(p => p.id === reportId);
  if (!r) return;

  const titleEl  = document.getElementById('petContactModalTitle');
  const subEl    = document.getElementById('petContactModalSub');
  const bodyEl   = document.querySelector('#petContactModal .modal__body');
  const footerEl = document.querySelector('#petContactModal .modal__footer');

  if (titleEl)  titleEl.textContent = `Messages for ${r.petName || 'your report'}`;
  if (subEl)    subEl.textContent   = `${r.contactCount || 0} message${r.contactCount !== 1 ? 's' : ''} received`;
  if (footerEl) footerEl.innerHTML  = `
    <button class="btn btn--outline btn--full"
      onclick="closeModal('petContactModal')">Close</button>`;

  if (bodyEl) bodyEl.innerHTML = `<p style="color:var(--gray-400);font-size:var(--text-sm);
    text-align:center;padding:var(--space-lg) 0;">Loading messages…</p>`;

  openModal?.('petContactModal');

  try {
    const { getDocs: _gd, query: _q, orderBy: _ob, deleteDoc: _del, doc: _d, updateDoc: _upd, increment: _inc, serverTimestamp: _ts } =
      await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    const snap = await _gd(_q(petContactsCol(_barangayId, reportId), _ob('sentAt', 'desc')));
    if (!bodyEl) return;

    if (snap.empty) {
      bodyEl.innerHTML = `<div style="text-align:center;padding:var(--space-xl) 0;color:var(--gray-400);">
        <i data-lucide="inbox" style="width:32px;height:32px;color:var(--gray-300);margin-bottom:8px;"></i>
        <p style="font-size:var(--text-sm);">No messages yet.</p>
      </div>`;
      lucide?.createIcons?.({ el: bodyEl });
      return;
    }

    /* Store messages for search filtering */
    const _msgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    /* Delete single message */
    window._deletePetContact = async function(contactId) {
      if (!confirm('Delete this message?')) return;
      try {
        await _del(_d(db, 'barangays', _barangayId, 'pets', reportId, 'contacts', contactId));
        await _upd(petDoc(_barangayId, reportId), { contactCount: _inc(-1), updatedAt: _ts() });
        const localReport = _allReports.find(p => p.id === reportId);
        if (localReport) localReport.contactCount = Math.max(0, (localReport.contactCount || 1) - 1);
        document.getElementById(`_petMsg-${contactId}`)?.remove();
        _showPetToast('Message deleted.');
      } catch(e) { _showPetToast('Failed to delete.', 'error'); }
    };

    /* Delete all messages from a specific sender */
    window._deleteAllFromSender = async function(senderUid, senderName) {
      if (!confirm(`Delete all messages from ${senderName}?`)) return;
      try {
        const toDelete = _msgs.filter(m => m.senderUid === senderUid);
        await Promise.all(toDelete.map(m =>
          _del(_d(db, 'barangays', _barangayId, 'pets', reportId, 'contacts', m.id))
        ));
        await _upd(petDoc(_barangayId, reportId), {
          contactCount: _inc(-toDelete.length),
          updatedAt: _ts(),
        });
        const localReport = _allReports.find(p => p.id === reportId);
        if (localReport) localReport.contactCount = Math.max(0, (localReport.contactCount || toDelete.length) - toDelete.length);
        toDelete.forEach(m => document.getElementById(`_petMsg-${m.id}`)?.remove());
        _showPetToast(`Deleted ${toDelete.length} message${toDelete.length !== 1 ? 's' : ''} from ${senderName}.`);
      } catch(e) { _showPetToast('Failed to delete.', 'error'); }
    };

    const _renderMsgs = (filter = '') => {
      const filtered = filter
        ? _msgs.filter(m => (m.senderName || '').toLowerCase().includes(filter.toLowerCase()))
        : _msgs;

      const list = document.getElementById('_petInboxList');
      if (!list) return;

      if (!filtered.length) {
        list.innerHTML = `<p style="color:var(--gray-400);font-size:var(--text-sm);
          text-align:center;padding:var(--space-lg) 0;">No messages match your search.</p>`;
        return;
      }

      /* Group by sender for easy "delete all from user" */
      const bySender = {};
      filtered.forEach(m => {
        if (!bySender[m.senderUid]) bySender[m.senderUid] = [];
        bySender[m.senderUid].push(m);
      });

      list.innerHTML = Object.entries(bySender).map(([uid, msgs]) => {
        const name    = msgs[0].senderName || 'Anonymous';
        const gid     = `_senderGroup-${uid.slice(0,8)}`;
        return `
          <div style="margin-bottom:var(--space-md);">
            <div style="display:flex;justify-content:space-between;align-items:center;
              margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid var(--gray-100);">
              <button onclick="
                  var g=document.getElementById('${gid}');
                  var a=document.getElementById('${gid}-arrow');
                  var open=g.style.display!=='none';
                  g.style.display=open?'none':'block';
                  a.style.transform=open?'rotate(-90deg)':'rotate(0deg)';"
                style="display:flex;align-items:center;gap:4px;background:none;border:none;
                  cursor:pointer;font-size:var(--text-xs);font-weight:700;text-transform:uppercase;
                  letter-spacing:.06em;color:var(--gray-500);padding:0;">
                <i data-lucide="chevron-down" id="${gid}-arrow"
                  style="width:12px;height:12px;transition:transform .2s;"></i>
                ${name}
                <span style="color:var(--gray-400);font-weight:400;">(${msgs.length})</span>
              </button>
              <button onclick="_deleteAllFromSender('${uid}','${name.replace(/'/g,"\\'")}'"
                style="font-size:var(--text-xs);color:var(--red,#dc2626);background:none;
                  border:none;cursor:pointer;font-family:var(--font-display);font-weight:600;">
                Delete all
              </button>
            </div>
            <div id="${gid}">
            ${msgs.map(m => {
              const ago = m.sentAt?.toDate ? _petRelTime(m.sentAt.toDate()) : '';
              return `
                <div id="_petMsg-${m.id}" style="border:1px solid var(--gray-100);
                  border-radius:var(--radius-md);padding:var(--space-sm) var(--space-md);
                  margin-bottom:6px;background:#fafafa;">
                  <div style="display:flex;justify-content:space-between;
                    align-items:flex-start;gap:8px;">
                    <p style="margin:0 0 4px;font-size:var(--text-sm);color:var(--gray-700);
                      line-height:1.5;flex:1;">${m.message || ''}</p>
                    <button onclick="_deletePetContact('${m.id}')"
                      style="flex-shrink:0;background:none;border:none;cursor:pointer;
                        color:var(--gray-300);padding:0;transition:color .15s;"
                      onmouseover="this.style.color='#dc2626'"
                      onmouseout="this.style.color='var(--gray-300)'">
                      <i data-lucide="trash-2" style="width:13px;height:13px;pointer-events:none;"></i>
                    </button>
                  </div>
                  ${m.when ? `<p style="margin:0 0 4px;font-size:var(--text-xs);
                    color:var(--gray-500);display:flex;align-items:center;gap:3px;">
                    <i data-lucide="clock" style="width:11px;height:11px;flex-shrink:0;"></i> ${m.when}</p>` : ''}
                  <div style="display:flex;align-items:center;justify-content:space-between;">
                    <div style="display:flex;align-items:center;gap:4px;font-size:var(--text-xs);
                      color:var(--gray-500);">
                      <i data-lucide="phone" style="width:11px;height:11px;flex-shrink:0;"></i>
                      <span>${m.contactInfo || '—'}</span>
                    </div>
                    <span style="font-size:var(--text-xs);color:var(--gray-400);">${ago}</span>
                  </div>
                </div>`;
            }).join('')}
            </div>
          </div>`;
      }).join('');

      lucide?.createIcons?.({ el: list });
    };

    /* Build search + list layout */
    bodyEl.innerHTML = `
      <div style="margin-bottom:var(--space-sm);">
        <input type="text" class="form-input" placeholder="Search by name…"
          style="font-size:var(--text-sm);"
          oninput="_renderMsgs(this.value)" />
      </div>
      <div id="_petInboxList"></div>`;

    _renderMsgs();

  } catch(err) {
    console.error('[pets] inbox:', err);
    if (bodyEl) bodyEl.innerHTML = `<p style="color:var(--red);font-size:var(--text-sm);
      text-align:center;padding:var(--space-lg) 0;">Failed to load messages.</p>`;
  }
};

/* Show rejection detail modal */
window._showRejection = function(reportId, petName, reason) {
  const nameEl   = document.getElementById('petRejectedName');
  const reasonEl = document.getElementById('petRejectionReason');
  const modal    = document.getElementById('petRejectionModal');
  if (nameEl)   nameEl.textContent     = petName;
  if (reasonEl) reasonEl.textContent   = reason || 'No reason provided.';
  if (modal)    modal.dataset.reportId = reportId;
  openModal?.('petRejectionModal');
};

/* ── Phase 3: Modal wiring ── */
function _wireSubmitModal() {
  document.getElementById('petReportSubmitBtn')
    ?.addEventListener('click', _handlePetReportSubmit);

  /* Reset on cancel/close */
  document.querySelector('#petReportModal .modal__close')
    ?.addEventListener('click', _resetPetModal);
  document.querySelector('#petReportModal .btn--outline')
    ?.addEventListener('click', _resetPetModal);

  /* Reset every time the modal opens fresh (FAB path) */
  document.getElementById('postPetReportBtn')
    ?.addEventListener('click', _resetPetModal);

  /* Species "Other" reveal */
  document.getElementById('petSpeciesInput')
    ?.addEventListener('change', e => {
      const og = document.getElementById('petSpeciesOtherGroup');
      if (og) og.style.display = e.target.value === 'Other' ? '' : 'none';
      if (_selectedPetType === 'found') runPetMatcher();
    });

  /* Re-run matcher when user types a custom species in the Other field */
  document.getElementById('petSpeciesOtherInput')
    ?.addEventListener('input', () => {
      if (_selectedPetType === 'found') runPetMatcher();
    });
}


/* ── selectPetType — updates modal labels dynamically ── */
window.selectPetType = function(type, btn) {
  /* Block type changes during edit/resubmit */
  const isEditing = !!document.getElementById('petReportSubmitBtn')?.dataset.resubmitId;
  if (isEditing) return;
  _selectedPetType = type;
  document.querySelectorAll('#petTypeToggle .report-type-toggle__btn')
    .forEach(b => b.classList.remove('is-active'));
  btn.classList.add('is-active');

  const labels = { missing: 'Last Seen Location', found: 'Found Location', adoption: 'Current Location' };
  const el = document.getElementById('petLocationLabel');
  if (el) el.textContent = labels[type];

  const nameGrp = document.getElementById('petNameGroup');
  if (nameGrp) nameGrp.style.display = type === 'found' ? 'none' : '';

  /* Matcher — show/hide on type change */
  if (type === 'found') { runPetMatcher(); }
  else {
    const ms = document.getElementById('petMatcherSection');
    if (ms) ms.style.display = 'none';
    _linkedMissingId = null;
  }

  const subs = {
    missing:  'Help find a lost pet',
    found:    'Help return a found pet to its owner',
    adoption: 'Help a pet find a new home',
  };
  const subEl = document.querySelector('#petReportModal .modal__header-sub');
  if (subEl) subEl.textContent = subs[type];
};


/* ── previewPetImages — mandatory photo guard ── */
window.previewPetImages = function(input) {
  const newFiles = Array.from(input.files || []);
  newFiles.forEach(f => {
    if (_selectedPetFiles.length < 3 &&
        !_selectedPetFiles.some(x => x.name === f.name && x.size === f.size)) {
      _selectedPetFiles.push(f);
    }
  });

  const submitBtn = document.getElementById('petReportSubmitBtn');
  const required  = document.getElementById('petPhotoRequired');
  const label     = document.getElementById('petImageLabel');
  const preview   = document.getElementById('petImagePreviews');

  if (_selectedPetFiles.length > 0) {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.classList.remove('is-disabled'); }
    if (required)  required.style.display = 'none';
  } else {
    if (submitBtn) submitBtn.disabled = true;
    if (required)  required.style.display = 'block';
  }

  if (label) label.textContent = _selectedPetFiles.length > 0
    ? `${_selectedPetFiles.length} photo${_selectedPetFiles.length > 1 ? 's' : ''} selected`
    : 'Tap to add photos (up to 3)';

  if (!preview) return;
  preview.innerHTML = '';
  _selectedPetFiles.forEach((file, idx) => {
    const reader = new FileReader();
    reader.onload = e => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;width:80px;height:60px;flex-shrink:0;';
      const img = document.createElement('img');
      img.src = e.target.result;
      img.style.cssText = 'width:80px;height:60px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb;display:block;';
      const rm = document.createElement('button');
      rm.innerHTML = '×';
      rm.style.cssText = `position:absolute;top:-5px;right:-5px;width:18px;height:18px;
        border-radius:50%;background:#dc2626;color:#fff;border:none;cursor:pointer;
        font-size:.75rem;line-height:1;display:flex;align-items:center;justify-content:center;`;
      rm.onclick = () => {
        _selectedPetFiles.splice(idx, 1);
        previewPetImages({ files: [] });
      };
      wrap.appendChild(img); wrap.appendChild(rm);
      preview.appendChild(wrap);
    };
    reader.readAsDataURL(file);
  });
};


/* ── Anti-spam: 3 reports per day ── */
async function _checkPetDailyLimit(uid, limit = 3) {
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(today + 'T00:00:00');
  const end   = new Date(today + 'T23:59:59');
  const snap  = await getDocs(query(
    petsCol(_barangayId),
    where('reportedBy', '==', uid),
    where('createdAt', '>=', Timestamp.fromDate(start)),
    where('createdAt', '<=', Timestamp.fromDate(end)),
  ));
  return snap.size >= limit;
}


/* ── Main submit handler ── */
async function _handlePetReportSubmit() {
  const btn = document.getElementById('petReportSubmitBtn');

  /* Photo guard */
  if (_selectedPetFiles.length === 0) {
    const req = document.getElementById('petPhotoRequired');
    if (req) req.style.display = 'block';
    return;
  }

  /* Field validation */
  const locationVal = document.getElementById('petLocationInput')?.value.trim();
  const descVal     = document.getElementById('petDescInput')?.value.trim();
  if (!locationVal || !descVal) {
    _showPetToast('Please fill in the location and description.', 'error');
    return;
  }

  /* Anti-spam — read limit from settings, fallback to 3 */
  const { getDoc: _sgd, doc: _sd } =
    await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
  const { db: _sdb } = await import('/js/core/firebase-config.js');
  const settingsSnap  = await _sgd(_sd(_sdb, 'barangays', _barangayId, 'meta', 'settings'));
  const _settings     = settingsSnap.exists() ? settingsSnap.data() : {};
  const dailyLimit    = _settings.petReportDailyLimit ?? 3;
  const requireApproval = _settings.requirePetApproval ?? true;

  const _isResubmit = !!document.getElementById('petReportSubmitBtn')?.dataset.resubmitId;
  if (!_isResubmit) {
    const overLimit = await _checkPetDailyLimit(_currentUid, dailyLimit);
    if (overLimit) {
      _showPetToast(`You've reached the daily limit of ${dailyLimit} pet reports. Try again tomorrow.`, 'error');
      return;
    }
  }

  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader"></i> Submitting…';
  lucide?.createIcons?.({ el: btn });

  try {
    /* Upload images */
    const imageURLs = [];
    for (const file of _selectedPetFiles) {
      const path = petPhotoPath(
        _barangayDisplayName, _currentUid,
        `${Date.now()}-${Math.random().toString(36).slice(2)}.webp`,
      );
      const url = await uploadImage(file, path);
      imageURLs.push(url);
    }

    /* Collect fields */
    const species = document.getElementById('petSpeciesInput')?.value || 'Dog';
    const speciesOther = document.getElementById('petSpeciesOtherInput')?.value.trim();

    const payload = {
      type:            _selectedPetType,
      status:          requireApproval ? 'pending' : 'active',
      petName:         document.getElementById('petNameInput')?.value.trim() || null,
      species:         species === 'Other' && speciesOther ? speciesOther : species,
      breed:           document.getElementById('petBreedInput')?.value.trim() || '',
      age:             document.getElementById('petAgeInput')?.value.trim() || '',
      description:     descVal,
      location:        locationVal,
      imageURLs,
      imageURL:        imageURLs[0],
      reportedBy:      _currentUid,
      reportedByName:  _currentUserName,
      expiryDate:      null,
      rejectionReason: '',
      rejectedBy:      null,
      approvedBy:      null,
      approvedAt:      null,
      resolvedBy:      null,
      resolvedAt:      null,
      resolvedNote:    '',
      contactCount:    0,
      linkedMissingId: _linkedMissingId || null,
      createdAt:       serverTimestamp(),
      updatedAt:       serverTimestamp(),
    };

    const resubmitId = document.getElementById('petReportSubmitBtn')?.dataset.resubmitId;
    let ref;
    if (resubmitId) {
      /* Resubmit — update existing doc, reset to pending */
      const { updateDoc: _upd } =
        await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
      await _upd(petDoc(_barangayId, resubmitId), { ...payload, status: requireApproval ? 'pending' : 'active' });
      ref = { id: resubmitId };
      delete document.getElementById('petReportSubmitBtn').dataset.resubmitId;
    } else {
      ref = await addDoc(petsCol(_barangayId), payload);
    }

    /* Notify officers/admins */
    window._sendPetNotification?.(_barangayId, ref.id, _currentUserName);

    /* Phase 3.5 — auto-link: notify missing report owner + write to contacts */
    if (_linkedMissingId) {
      try {
        const { getDoc: _gd, addDoc: _ad, updateDoc: _upd,
                increment: _inc, serverTimestamp: _ts2 } =
          await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
        const missingSnap = await _gd(petDoc(_barangayId, _linkedMissingId));
        if (missingSnap.exists()) {
          const mr = missingSnap.data();
          const { sendNotification } = await import('/js/shared/notifications.js');
          await sendNotification(_barangayId, mr.reportedBy, {
            type:      'pet_linked',
            actorId:   _currentUid,
            actorName: _currentUserName,
            postId:    _linkedMissingId,
            linkedFoundId: ref.id,
            postTitle: mr.petName || 'your missing pet',
            description: `${_currentUserName} thinks they found ${mr.petName || 'your pet'}. Contact: ${document.getElementById('petContactInfo')?.value || 'see their Found report'}`,
          });
          await _ad(petContactsCol(_barangayId, _linkedMissingId), {
            senderUid:         _currentUid,
            senderName:        _currentUserName,
            message:           `I think I found your pet! I've posted a Found report with more details.`,
            contactInfo:       document.getElementById('petContactInfo')?.value || 'See my Found report',
            linkedFoundReportId: ref.id,
            sentAt:            _ts2(),
            seen:              false,
            isAutoLinked:      true,
          });
          await _upd(petDoc(_barangayId, _linkedMissingId), {
            contactCount: _inc(1),
            updatedAt:    _ts2(),
          });
        }
      } catch (e) { console.warn('[pets] auto-link notify failed:', e); }
    }

    closeModal?.('petReportModal');
    _resetPetModal();
    _showPetToast('Your pet report has been submitted and is awaiting review.');

  } catch (err) {
    console.error('[pets] submit error', err);
    _showPetToast('Something went wrong. Please try again.', 'error');
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="paw-print"></i> Post Pet Report';
    lucide?.createIcons?.({ el: btn });
  }
}


/* ── Reset modal to blank state ── */
function _resetPetModal() {
  _selectedPetFiles  = [];
  _selectedPetType   = 'missing';
  _linkedMissingId   = null;

  const ids = ['petNameInput','petLocationInput','petDescInput','petBreedInput','petAgeInput','petSpeciesOtherInput'];
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });

  const speciesEl = document.getElementById('petSpeciesInput');
  if (speciesEl) speciesEl.value = 'Dog';

  document.getElementById('petDescCount')?.textContent !== undefined &&
    (document.getElementById('petDescCount').textContent = '0 / 300');

  const preview = document.getElementById('petImagePreviews');
  if (preview) preview.innerHTML = '';

  const label = document.getElementById('petImageLabel');
  if (label) label.textContent = 'Tap to add photos (up to 3)';

  const btn = document.getElementById('petReportSubmitBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="paw-print"></i> Post Pet Report';
    delete btn.dataset.resubmitId;
  }

  const required = document.getElementById('petPhotoRequired');
  if (required) required.style.display = 'none';

  /* Re-show photo upload for fresh reports */
  const photoGrp2 = document.getElementById('petImageInput')?.closest('.form-group');
  if (photoGrp2) photoGrp2.style.display = '';

  const og = document.getElementById('petSpeciesOtherGroup');
  if (og) og.style.display = 'none';

  /* Reset type toggle back to "missing" — re-enable all buttons */
  document.querySelectorAll('#petTypeToggle .report-type-toggle__btn')
    .forEach(b => {
      b.classList.toggle('is-active', b.dataset.petType === 'missing');
      b.disabled = false;
      b.style.opacity = '';
    });

  const locLabel = document.getElementById('petLocationLabel');
  if (locLabel) locLabel.textContent = 'Last Seen Location';

  const nameGrp = document.getElementById('petNameGroup');
  if (nameGrp) nameGrp.style.display = '';

  const subEl = document.querySelector('#petReportModal .modal__header-sub');
  if (subEl) subEl.textContent = 'Help reunite pets with their families';

  const ms = document.getElementById('petMatcherSection');
  if (ms) ms.style.display = 'none';
  const ml = document.getElementById('petMatcherList');
  if (ml) ml.innerHTML = '';

  lucide?.createIcons?.();
}


/* ── Contact Bridge submit ── */
window.submitPetContact = async function() {
  const btn      = document.getElementById('petContactSubmitBtn');
  const reportId = btn?.dataset.reportId;
  const msg      = document.getElementById('petContactMessage')?.value.trim();
  const contact  = document.getElementById('petContactInfo')?.value.trim();

  _currentUserName = window._currentUserName || _currentUserName;
  if (!msg)     { _showPetToast('Please add a message.', 'error'); return; }
  if (!contact) { _showPetToast('Please add your contact info.', 'error'); return; }
  if (!reportId || !_currentUid) return;

  /* Block owner from contacting themselves */
  const report = _allReports.find(r => r.id === reportId);
  if (report?.reportedBy === _currentUid) {
    _showPetToast('This is your own report.', 'error'); return;
  }

  /* Spam guard — max 3 messages per user per report */
  try {
    const { getDocs: _gd, query: _q, where: _w } =
      await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const existing = await _gd(_q(
      petContactsCol(_barangayId, reportId),
      _w('senderUid', '==', _currentUid),
    ));
    const { getDoc: _sgd2, doc: _sd2 } =
      await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const { db: _sdb2 } = await import('/js/core/firebase-config.js');
    const _contactSettingsSnap = await _sgd2(_sd2(_sdb2, 'barangays', _barangayId, 'meta', 'settings'));
    const _contactLimit = _contactSettingsSnap.exists()
      ? (_contactSettingsSnap.data().maxPetContactsPerSender ?? 3) : 3;
    if (existing.size >= _contactLimit) {
      _showPetToast(`You've already sent ${_contactLimit} messages to this report.`, 'error'); return;
    }
  } catch(e) { console.warn('[pets] spam check failed:', e); }

  btn.disabled = true;
  try {
    const { addDoc: _add, updateDoc: _upd, increment: _inc, serverTimestamp: _ts } =
      await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    const when = document.getElementById('petContactWhen')?.value.trim() || null;

    /* 1. Write contact to subcollection */
    await _add(petContactsCol(_barangayId, reportId), {
      senderUid:   _currentUid,
      senderName:  _currentUserName || window._currentUserName || 'Anonymous',
      message:     msg,
      contactInfo: contact,
      when,
      sentAt:      _ts(),
      seen:        false,
    });

    /* 2. Increment contactCount on parent report */
    await _upd(petDoc(_barangayId, reportId), {
      contactCount: _inc(1),
      updatedAt:    _ts(),
    });

    /* 3. Notify the report owner */
    if (report?.reportedBy) {
      try {
        const { sendNotification } = await import('/js/shared/notifications.js');
        await sendNotification(_barangayId, report.reportedBy, {
          type:        'pet_contact',
          actorId:     _currentUid,
          actorName:   _currentUserName || window._currentUserName || 'Someone',
          postId:      reportId,
          postTitle:   report.petName || 'your pet report',
          description: `"${msg.slice(0, 60)}${msg.length > 60 ? '…' : ''}" — ${contact}`,
        });
        console.log('[pets] notification sent to', report.reportedBy);
      } catch(e) { console.error('[pets] notify FAILED:', e); }
    }

    /* 4. Update local copy so card counter updates immediately */
    const localReport = _allReports.find(r => r.id === reportId);
    if (localReport) {
      localReport.contactCount = (localReport.contactCount || 0) + 1;
      renderPets(document.getElementById('petsGrid'));
    }

    closeModal?.('petContactModal');
    document.getElementById('petContactMessage').value = '';
    document.getElementById('petContactInfo').value    = '';
    const whenEl = document.getElementById('petContactWhen');
    if (whenEl) whenEl.value = '';
    _showPetToast('Your message has been sent to the owner!');

  } catch (err) {
    console.error('[pets] contact error', err);
    _showPetToast('Failed to send. Please try again.', 'error');
  } finally { btn.disabled = false; }
};


/* ── Resolve confirm ── */
window.confirmPetResolve = async function() {
  const btn      = document.getElementById('petResolveConfirmBtn');
  const reportId = btn?.dataset.reportId;
  const note     = document.getElementById('petResolveNote')?.value.trim() || '';
  if (!reportId) return;

  btn.disabled    = true;
  btn.textContent = 'Saving…';

  try {
    /* Read admin setting for how many days before a resolved report auto-deletes */
    let _deleteDays = 3;
    try {
      const { getDoc: _gd, doc: _d } =
        await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
      const _snap = await _gd(_d(db, 'barangays', _barangayId, 'meta', 'settings'));
      if (_snap.exists()) _deleteDays = _snap.data().petResolvedDeleteDays ?? 3;
    } catch(e) { /* fallback to 3 */ }

    const _deleteAt = _deleteDays > 0
      ? new Date(Date.now() + _deleteDays * 86_400_000)
      : null;

    await updateDoc(petDoc(_barangayId, reportId), {
      status:       'resolved',
      resolvedBy:   _currentUid,
      resolvedAt:   serverTimestamp(),
      resolvedNote: note,
      expiryDate:   _deleteAt,
      updatedAt:    serverTimestamp(),
    });

    closeModal?.('petResolveModal');
    _showPetToast('Report marked as resolved.');

    /* Card celebration animation */
    const card = document.querySelector(`[data-report-id="${reportId}"]`);
    if (card) {
      card.classList.add('pet-resolve-success');
      setTimeout(() => card.classList.remove('pet-resolve-success'), 600);
    }

  } catch (err) {
    console.error('[pets] resolve error', err);
    _showPetToast('Failed to resolve. Please try again.', 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Yes, Mark Resolved';
  }
};


/* ── Edit rejected report — reopen modal pre-filled (basic) ── */
window.editRejectedPetReport = async function() {
  const modal    = document.getElementById('petRejectionModal');
  const reportId = modal?.dataset?.reportId;
  closeModal?.('petRejectionModal');

  if (!reportId) { openModal?.('petReportModal'); return; }

  /* Fetch original report data and pre-fill the form */
  try {
    const { getDoc: _gd } =
      await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const snap = await _gd(petDoc(_barangayId, reportId));
    if (!snap.exists()) { openModal?.('petReportModal'); return; }

    const r = snap.data();

    /* Pre-fill type toggle */
    _selectedPetType = r.type || 'missing';
    document.querySelectorAll('#petTypeToggle .report-type-toggle__btn')
      .forEach(b => b.classList.toggle('is-active', b.dataset.petType === _selectedPetType));

    /* Pre-fill fields */
    const _set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    _set('petNameInput',     r.petName);
    _set('petBreedInput',    r.breed);
    _set('petAgeInput',      r.age);
    _set('petLocationInput', r.location);
    _set('petDescInput',     r.description);

    /* Species */
    const speciesEl = document.getElementById('petSpeciesInput');
    const knownSpecies = ['Dog','Cat','Bird','Other'];
    if (speciesEl) {
      if (knownSpecies.includes(r.species)) {
        speciesEl.value = r.species;
      } else {
        speciesEl.value = 'Other';
        _set('petSpeciesOtherInput', r.species);
        const og = document.getElementById('petSpeciesOtherGroup');
        if (og) og.style.display = '';
      }
    }

    /* Char count */
    const descCount = document.getElementById('petDescCount');
    if (descCount) descCount.textContent = `${(r.description || '').length} / 300`;

    /* Location label */
    const labels = { missing: 'Last Seen Location', found: 'Found Location', adoption: 'Current Location' };
    const locLabel = document.getElementById('petLocationLabel');
    if (locLabel) locLabel.textContent = labels[_selectedPetType] || 'Last Seen Location';

    /* Pet name group visibility */
    const nameGrp = document.getElementById('petNameGroup');
    if (nameGrp) nameGrp.style.display = _selectedPetType === 'found' ? 'none' : '';

    /* Mark submit button as resubmit — store reportId for updateDoc instead of addDoc */
    const submitBtn = document.getElementById('petReportSubmitBtn');
    if (submitBtn) {
      submitBtn.disabled  = false;
      submitBtn.innerHTML = '<i data-lucide="send"></i> Resubmit Report';
      submitBtn.dataset.resubmitId = reportId;
      lucide?.createIcons?.({ el: submitBtn });
    }

  /* Lock type toggle on resubmit too */
  document.querySelectorAll('#petTypeToggle .report-type-toggle__btn')
    .forEach(b => { b.disabled = b.dataset.petType !== _selectedPetType; b.style.opacity = b.disabled ? '.35' : ''; });

  /* Hide matcher */
  const ms2 = document.getElementById('petMatcherSection');
  if (ms2) ms2.style.display = 'none';

  } catch(e) {
    console.error('[pets] pre-fill rejected report:', e);
  }

  openModal?.('petReportModal');
};

/* ── Edit active report — pre-fill modal same as resubmit ── */
window._openPetEdit = async function(reportId) {
  try {
    const { getDoc: _gd } =
      await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const snap = await _gd(petDoc(_barangayId, reportId));
    if (!snap.exists()) return;

    const r = snap.data();
    _selectedPetType = r.type || 'missing';

    document.querySelectorAll('#petTypeToggle .report-type-toggle__btn')
      .forEach(b => b.classList.toggle('is-active', b.dataset.petType === _selectedPetType));

    const _set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    _set('petNameInput',     r.petName);
    _set('petBreedInput',    r.breed);
    _set('petAgeInput',      r.age);
    _set('petLocationInput', r.location);
    _set('petDescInput',     r.description);

    const speciesEl    = document.getElementById('petSpeciesInput');
    const knownSpecies = ['Dog','Cat','Bird','Other'];
    if (speciesEl) {
      if (knownSpecies.includes(r.species)) {
        speciesEl.value = r.species;
      } else {
        speciesEl.value = 'Other';
        _set('petSpeciesOtherInput', r.species);
        const og = document.getElementById('petSpeciesOtherGroup');
        if (og) og.style.display = '';
      }
    }

    const descCount = document.getElementById('petDescCount');
    if (descCount) descCount.textContent = `${(r.description || '').length} / 300`;

    const labels   = { missing: 'Last Seen Location', found: 'Found Location', adoption: 'Current Location' };
    const locLabel = document.getElementById('petLocationLabel');
    if (locLabel)  locLabel.textContent = labels[_selectedPetType] || 'Last Seen Location';

    const nameGrp = document.getElementById('petNameGroup');
    if (nameGrp)  nameGrp.style.display = _selectedPetType === 'found' ? 'none' : '';

    const submitBtn = document.getElementById('petReportSubmitBtn');
  if (submitBtn) {
    submitBtn.disabled  = false;
    submitBtn.innerHTML = '<i data-lucide="save"></i> Save Changes';
    submitBtn.dataset.resubmitId = reportId;
    lucide?.createIcons?.({ el: submitBtn });
  }

  /* Lock type toggle — can't change type on edit */
  document.querySelectorAll('#petTypeToggle .report-type-toggle__btn')
    .forEach(b => { b.disabled = b.dataset.petType !== _selectedPetType; b.style.opacity = b.disabled ? '.35' : ''; });

  /* Hide photo upload during edit — avoids orphaned Storage files */
  const photoGrp = document.getElementById('petImageInput')?.closest('.form-group');
  if (photoGrp) photoGrp.style.display = 'none';

  /* Hide matcher — not applicable when editing */
  const ms = document.getElementById('petMatcherSection');
  if (ms) ms.style.display = 'none';

  } catch(e) { console.error('[pets] edit report:', e); }

  openModal?.('petReportModal');
};

/* ── Pet pending notification — sent to all officers/admins on submit ── */
window._sendPetNotification = async function(barangayId, reportId, senderName) {
  try {
    const { getDocs, collection: _col } =
      await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const { sendNotification } = await import('/js/shared/notifications.js');

    const snap = await getDocs(_col(db, 'barangays', barangayId, 'users'));
    await Promise.all(
      snap.docs
        .filter(d => ['admin','officer'].includes(d.data().role) && d.id !== _currentUid)
        .map(d => sendNotification(barangayId, d.id, {
          type:      'pet_pending',
          actorId:   _currentUid,
          actorName: senderName,
          postId:    reportId,
          postTitle: 'Pet Report',
        }))
    );
  } catch (e) { console.warn('[pets] notify failed:', e); }
};

async function runPetMatcher() {
  const speciesSelect = document.getElementById('petSpeciesInput')?.value;
  const speciesOther  = document.getElementById('petSpeciesOtherInput')?.value.trim();
  const species = speciesSelect === 'Other' && speciesOther ? speciesOther : speciesSelect;
  const section = document.getElementById('petMatcherSection');
  const list    = document.getElementById('petMatcherList');
  const empty   = document.getElementById('petMatcherEmpty');
  if (!species || !_barangayId) return;

  section.style.display = '';
  list.innerHTML = '<p style="font-size:var(--text-sm);color:var(--gray-400);padding:.25rem 0;">Searching…</p>';
  if (empty) empty.style.display = 'none';

  try {
    const { getDocs: _gd2, query: _q2, where: _w2, orderBy: _ob2, limit: _lim2 } =
      await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    const snap = await _gd2(_q2(
      petsCol(_barangayId),
      _w2('type',    '==', 'missing'),
      _w2('status',  '==', 'active'),
      _w2('species', '==', species),
      _ob2('createdAt', 'desc'),
      _lim2(5),
    ));

    list.innerHTML = '';

    /* Inject radio color override scoped to matcher list */
    if (!document.getElementById('_matcherRadioStyle')) {
      const s = document.createElement('style');
      s.id = '_matcherRadioStyle';
      s.textContent = `
        #petMatcherList input[type="radio"] { accent-color: var(--green-dark, #1a3a1a) !important; }
        #petMatcherList input[type="radio"][value="none"]:not(:checked) { accent-color: #6b7280 !important; }
      `;
      document.head.appendChild(s);
    }

    /* Trap scroll — prevent modal body from scrolling when list is scrollable */
    if (!list._scrollTrapped) {
      list._scrollTrapped = true;
      list.addEventListener('wheel', e => {
        e.stopPropagation();
        const atTop    = list.scrollTop === 0 && e.deltaY < 0;
        const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1 && e.deltaY > 0;
        if (!atTop && !atBottom) e.preventDefault();
        list.scrollTop += e.deltaY;
      }, { passive: false });

      list.addEventListener('touchstart', e => {
        list._touchStartY = e.touches[0].clientY;
      }, { passive: true });

      list.addEventListener('touchmove', e => {
        const dy = list._touchStartY - e.touches[0].clientY;
        const atTop    = list.scrollTop === 0;
        const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
        if ((dy < 0 && atTop) || (dy > 0 && atBottom)) return;
        e.stopPropagation();
      }, { passive: false });
    }

    if (snap.empty) {
      if (empty) empty.style.display = '';
      list.insertAdjacentHTML('beforeend', buildNoneRadio());
      return;
    }
    snap.forEach(d => list.insertAdjacentHTML('beforeend', buildMatcherItem({ id: d.id, ...d.data() })));
    list.insertAdjacentHTML('beforeend', buildNoneRadio());

    /* Wire radio change — capture selection, highlight border, autofill fields */
    list.querySelectorAll('input[name="petMatchLink"]').forEach(radio => {
      radio.addEventListener('change', () => {
        _linkedMissingId = radio.value === 'none' ? null : radio.value;

        /* Border highlight */
        list.querySelectorAll('[id^="matcherCard-"]').forEach(card => {
          const inp = card.querySelector('input[type="radio"]');
          const isNoneCard = card.id === 'matcherCard-none';
          card.style.borderColor = inp?.checked ? 'var(--green-dark)' : '#e5e7eb';
        });

        /* Autofill — only when a real missing report is selected */
        if (_linkedMissingId) {
          const r = _allReports.find(p => p.id === _linkedMissingId);
          if (!r) return;

          /* Species — set select value */
          const speciesEl = document.getElementById('petSpeciesInput');
          const ogEl      = document.getElementById('petSpeciesOtherGroup');
          const knownSpecies = ['Dog','Cat','Bird','Other'];
          if (speciesEl) {
            if (knownSpecies.includes(r.species)) {
              speciesEl.value = r.species;
              if (ogEl) ogEl.style.display = r.species === 'Other' ? '' : 'none';
            } else {
              /* Custom species — set to "Other" and fill the text field */
              speciesEl.value = 'Other';
              if (ogEl) ogEl.style.display = '';
              const otherInput = document.getElementById('petSpeciesOtherInput');
              if (otherInput) otherInput.value = r.species;
            }
          }

          /* Breed — optional */
          const breedEl = document.getElementById('petBreedInput');
          if (breedEl && r.breed) breedEl.value = r.breed;

          /* Age — optional */
          const ageEl = document.getElementById('petAgeInput');
          if (ageEl && r.age) ageEl.value = r.age;

          /* Pet name — pre-fill with a note (user can edit) */
          const nameEl = document.getElementById('petNameInput');
          if (nameEl && r.petName) nameEl.value = r.petName;

        } else {
          /* "None of these" selected — clear autofilled fields */
          ['petSpeciesInput','petBreedInput','petAgeInput','petNameInput'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = id === 'petSpeciesInput' ? 'Dog' : '';
          });
          const ogEl = document.getElementById('petSpeciesOtherGroup');
          if (ogEl) ogEl.style.display = 'none';
          const otherInput = document.getElementById('petSpeciesOtherInput');
          if (otherInput) otherInput.value = '';
        }
      });
    });

    /* Set initial border states — "none" is checked by default, so it gets green */
    list.querySelectorAll('[id^="matcherCard-"]').forEach(card => {
      const inp = card.querySelector('input[type="radio"]');
      card.style.borderColor = inp?.checked ? 'var(--green-dark)' : '#e5e7eb';
    });

    lucide?.createIcons?.({ el: list });
  } catch (err) {
    console.error('[pets] matcher:', err);
    list.innerHTML = '<p style="font-size:var(--text-sm);color:var(--gray-400);">Could not load suggestions.</p>';
  }
}

function buildMatcherItem(r) {
  const timeAgo = _petRelTime(r.createdAt?.toDate?.() || new Date());
  const rid = r.id;
  return `
    <div style="border:1.5px solid var(--gray-100);border-radius:var(--radius-md);
      overflow:hidden;transition:border-color .15s;" id="matcherCard-${rid}">
      <label data-match-label="1" style="display:flex;align-items:center;gap:.65rem;
        padding:.55rem .65rem;cursor:pointer;font-size:var(--text-sm);">
        <input type="radio" name="petMatchLink" value="${rid}"
          style="accent-color:var(--green-dark);flex-shrink:0;width:15px;height:15px;
            appearance:auto;-webkit-appearance:radio;cursor:pointer;" />
        <img src="${r.imageURL || ''}" alt="${r.petName || 'Missing pet'}"
          style="width:40px;height:40px;object-fit:cover;border-radius:6px;flex-shrink:0;" />
        <div style="flex:1;min-width:0;">
          <p style="font-weight:var(--fw-semibold);color:var(--gray-800);margin:0;
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${r.petName || 'Unknown name'}</p>
          <p style="color:var(--gray-500);margin:0;font-size:.75rem;">
            ${r.species}${r.breed ? ' · ' + r.breed : ''} · Last seen: ${r.location || '—'}
          </p>
          <p style="color:var(--gray-400);margin:0;font-size:.7rem;">
            Reported by ${r.reportedByName || '—'} · ${timeAgo}
          </p>
        </div>
        <button type="button"
          onclick="event.preventDefault();event.stopPropagation();_previewMatcherReport('${rid}')"
          style="flex-shrink:0;padding:3px 10px;border-radius:999px;border:1.5px solid var(--gray-200);
            background:#fff;font-size:.7rem;font-weight:700;color:var(--gray-600);cursor:pointer;
            font-family:var(--font-display);white-space:nowrap;">
          View
        </button>
      </label>
    </div>`;
}

function buildNoneRadio() {
  return `
    <label id="matcherCard-none" style="display:flex;align-items:center;gap:.65rem;
      padding:.45rem .65rem;border:1.5px solid var(--green-dark);border-radius:var(--radius-md);
      font-size:var(--text-sm);color:#4b5563;cursor:pointer;background:#f9fafb;">
      <input type="radio" name="petMatchLink" value="none" checked
        style="accent-color:var(--green-dark);flex-shrink:0;width:15px;height:15px;
          appearance:auto;-webkit-appearance:radio;cursor:pointer;" />
      Post as a new Found report
    </label>`;
}

/* Opens pet detail modal for a matcher card — report modal stays open behind it */
window._previewMatcherReport = function(reportId) {
  const r = _allReports.find(p => p.id === reportId);
  if (!r) return;
  /* Temporarily override the detail footer to just a Close button */
  window._openPetDetail(reportId);
  /* After detail opens, replace its footer so Close returns to report modal */
  setTimeout(() => {
    const footerEl = document.getElementById('petDetailFooter');
    if (footerEl) footerEl.innerHTML = `
      <button class="btn btn--outline btn--full"
        onclick="closeModal('petDetailModal')">
        <i data-lucide="arrow-left"></i> Back to Report
      </button>`;
    lucide?.createIcons?.({ el: footerEl });
  }, 50);
};

/* Local relative time (matcher only — avoids importing) */
function _petRelTime(date) {
  if (!date) return '';
  const m = Math.floor((Date.now() - date.getTime()) / 60_000);
  const h = Math.floor(m / 60);
  if (m  <  1) return 'just now';
  if (m  < 60) return `${m}m ago`;
  if (h  < 24) return `${h}h ago`;
  return date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}

/* ── Toast helper (local, avoids cross-module deps) ── */
function _showPetToast(msg, type = 'success') {
  let c = document.getElementById('residentToastContainer');
  if (!c) {
    c = document.createElement('div');
    c.id = 'residentToastContainer';
    c.style.cssText = 'position:fixed;bottom:1.5rem;right:1.5rem;display:flex;flex-direction:column;gap:.5rem;z-index:2000;';
    document.body.appendChild(c);
  }
  const t = document.createElement('div');
  t.style.cssText = `display:flex;align-items:center;gap:.6rem;
    background:${type === 'error' ? '#9b1c1c' : '#1a3a1a'};color:#fff;
    padding:.75rem 1.1rem;border-radius:10px;font-size:.875rem;font-weight:500;
    box-shadow:0 4px 16px rgba(0,0,0,.2);animation:toastIn .25s ease both;`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

/* ── Pet Detail Modal ── */
window._openPetDetail = function(reportId) {
  const r = _allReports.find(p => p.id === reportId);
  if (!r) return;

  /* Ensure viewer is injected before any thumbnail click fires */
  if (window._injectImageViewer) window._injectImageViewer();
  else import('/js/shared/image-viewer.js').then(m => { m._injectImageViewer(); window.openImageViewer = m.openImageViewer; });

  const isOwner = _currentUid && r.reportedBy === _currentUid;

  /* Header */
  const typeLabels = { missing: 'Missing Pet', found: 'Found Stray', adoption: 'For Adoption' };
  const typeSubs   = { missing: 'Help find this pet', found: 'Found a stray — looking for the owner', adoption: 'Looking for a new home' };
  document.getElementById('petDetailLabel').textContent = typeLabels[r.type] ?? 'Pet Board';
  document.getElementById('petDetailName').textContent  = r.petName || 'Unknown Pet';
  document.getElementById('petDetailSub').textContent   = typeSubs[r.type] ?? '';

  /* Info fields */
  document.getElementById('petDetailSpecies').textContent  = r.species  || '—';
  document.getElementById('petDetailBreed').textContent    = r.breed    || '—';
  document.getElementById('petDetailAge').textContent      = r.age      || '—';
  document.getElementById('petDetailReporter').textContent = r.reportedByName || '—';
  document.getElementById('petDetailLocation').textContent = r.location || '—';
  document.getElementById('petDetailDesc').textContent     = r.description || '—';

  /* Photo strip */
  const stripEl = document.getElementById('petDetailPhotoStrip');
const images  = r.imageURLs?.length ? r.imageURLs : (r.imageURL ? [r.imageURL] : []);
  /* ── Photo carousel — mirrors bulletin post-carousel pattern ── */
    const _pid = `pet-${r.id}`;
    if (images.length) {
      stripEl.innerHTML = `
        <div class="post-carousel" id="carousel-${_pid}"
          style="margin:0;border-radius:0;cursor:pointer;">
          <div class="post-carousel__track" id="carousel-track-${_pid}">
            ${images.map((url, i) => `
              <div class="post-carousel__slide" id="_petSlide-${_pid}-${i}"
                style="cursor:pointer;">
                <img src="${url}" alt="Pet photo ${i+1}" loading="lazy"
                  style="width:100%;height:100%;object-fit:cover;" />
              </div>`).join('')}
          </div>
          ${images.length > 1 ? `
          <button class="post-carousel__nav post-carousel__nav--prev"
            id="_petPrev-${_pid}" aria-label="Previous">
            <i data-lucide="chevron-left"></i>
          </button>
          <button class="post-carousel__nav post-carousel__nav--next"
            id="_petNext-${_pid}" aria-label="Next">
            <i data-lucide="chevron-right"></i>
          </button>
          <div class="post-carousel__dots" id="_petDots-${_pid}">
            ${images.map((_, i) => `
              <button class="post-carousel__dot${i===0?' is-active':''}"
  id="_petDot-${_pid}-${i}" aria-label="Photo ${i+1}"
  style="background:${i===0?'var(--orange,#f97316)':'rgba(0,0,0,.3)'}"></button>`).join('')}
          </div>` : ''}
          ${images.length > 1 ? `
          <span style="position:absolute;top:8px;left:8px;display:inline-flex;align-items:center;
            gap:3px;background:rgba(0,0,0,.55);color:#fff;font-size:var(--text-xs);
            font-family:var(--font-display);font-weight:600;padding:2px 8px 2px 6px;
            border-radius:999px;pointer-events:none;backdrop-filter:blur(4px);">
            <i data-lucide="images" style="width:11px;height:11px;flex-shrink:0;"></i>
            ${images.length} photos
          </span>` : ''}
          <span style="position:absolute;bottom:8px;right:8px;
            padding:3px 10px;border-radius:999px;font-size:var(--text-xs);
            font-family:var(--font-display);font-weight:700;pointer-events:none;
            background:${r.type==='missing'?'#dc2626':r.type==='found'?'#16a34a':'#ea580c'};
            color:#fff;">
            ${TYPE_LABEL[r.type] ?? r.type}
          </span>
        </div>`;

      lucide?.createIcons?.({ el: stripEl });

      /* Track current carousel index */
      let _petIdx = 0;

      const track = document.getElementById(`carousel-track-${_pid}`);
      const dots  = document.getElementById(`_petDots-${_pid}`);

      function _petGoTo(i) {
        _petIdx = i;
        if (track) track.scrollTo({ left: track.offsetWidth * i, behavior: 'smooth' });
        if (dots) dots.querySelectorAll('.post-carousel__dot')
          .forEach((d, di) => {
            d.classList.toggle('is-active', di === i);
            d.style.background = di === i ? 'var(--orange,#f97316)' : 'rgba(0,0,0,.3)';
          });
      }

      /* Prev / next buttons */
      document.getElementById(`_petPrev-${_pid}`)?.addEventListener('click', e => {
        e.stopPropagation();
        _petGoTo((_petIdx - 1 + images.length) % images.length);
      });
      document.getElementById(`_petNext-${_pid}`)?.addEventListener('click', e => {
        e.stopPropagation();
        _petGoTo((_petIdx + 1) % images.length);
      });

      /* Dot buttons */
      if (dots) dots.querySelectorAll('.post-carousel__dot').forEach((d, i) => {
        d.addEventListener('click', e => { e.stopPropagation(); _petGoTo(i); });
      });

      /* Click big image → open viewer at current index */
      track?.addEventListener('click', () => {
        window.openImageViewer(images, _petIdx, r.petName || 'Pet');
      });

      /* Wheel over photo strip — debounced so one scroll = one slide */
    if (images.length > 1) {
      let _wheelLocked = false;
      stripEl.addEventListener('wheel', e => {
        e.preventDefault();
        if (_wheelLocked) return;
        _wheelLocked = true;
        _petGoTo((_petIdx + (e.deltaY > 0 ? 1 : -1) + images.length) % images.length);
        setTimeout(() => { _wheelLocked = false; }, 600);
      }, { passive: false });
    }

    /* Sync dot on scroll (swipe) — do NOT call _petGoTo here, that causes a loop */
    track?.addEventListener('scroll', () => {
        const w = track.offsetWidth;
        if (!w) return;
        const i = Math.round(track.scrollLeft / w);
        if (i === _petIdx) return;
        _petIdx = i;
        if (dots) dots.querySelectorAll('.post-carousel__dot')
          .forEach((d, di) => {
            d.classList.toggle('is-active', di === i);
            d.style.background = di === i ? 'var(--orange,#f97316)' : 'rgba(0,0,0,.3)';
          });
      });

    } else {
      stripEl.innerHTML = `
        <div style="aspect-ratio:16/9;background:var(--gray-100);display:flex;
          align-items:center;justify-content:center;color:var(--gray-300);">
          <i data-lucide="image-off" style="width:40px;height:40px;"></i>
        </div>`;
      lucide?.createIcons?.({ el: stripEl });
    }

  /* Footer CTAs */
  const footerEl = document.getElementById('petDetailFooter');
  if (r.status === 'resolved') {
    footerEl.innerHTML = `<span style="font-size:var(--text-sm);color:var(--green-dark);
      font-weight:700;">✓ Resolved${r.resolvedNote ? ` — "${r.resolvedNote}"` : ''}</span>`;
  } else if (r.status === 'pending' && isOwner) {
    footerEl.innerHTML = `
      <button class="btn btn--outline btn--full" disabled>
        <i data-lucide="clock"></i> Pending Review
      </button>`;
  } else if (r.status === 'active' && isOwner) {
    const _rn = (r.petName||'Unknown').replace(/'/g,"\\'");
    footerEl.innerHTML = `
      <button class="btn btn--outline"
        onclick="closeModal('petDetailModal');window._openResolveModal('${r.id}','${r.type}','${_rn}')">
        Mark Resolved
      </button>
      <button class="btn btn--green btn--full"
        onclick="closeModal('petDetailModal');window._openContactInbox('${r.id}')">
        <i data-lucide="phone"></i> View Messages (${r.contactCount || 0})
      </button>`;
  } else if (r.type === 'missing') {
    footerEl.innerHTML = `
      <button class="btn btn--outline" onclick="closeModal('petDetailModal')">Close</button>
      <button class="btn btn--green btn--full"
        onclick="closeModal('petDetailModal');window._openContactModal('${r.id}','missing','${(r.petName||'Unknown').replace(/'/g,"\\'")}',true)">
        <i data-lucide="phone"></i> Share Info
      </button>`;
  } else if (r.type === 'found') {
    footerEl.innerHTML = `
      <button class="btn btn--outline" onclick="closeModal('petDetailModal')">Close</button>
      <button class="btn btn--outline btn--full"
        onclick="closeModal('petDetailModal');window._openContactModal('${r.id}','found','${(r.petName||'Unknown').replace(/'/g,"\\'")}',true)">
        <i data-lucide="map-pin"></i> Contact Finder
      </button>`;
  } else if (r.type === 'adoption') {
    footerEl.innerHTML = `
      <button class="btn btn--outline" onclick="closeModal('petDetailModal')">Close</button>
      <button class="btn btn--green btn--full"
        onclick="closeModal('petDetailModal');window._openContactModal('${r.id}','adoption','${(r.petName||'Unknown').replace(/'/g,"\\'")}')">
        <i data-lucide="heart"></i> Adopt Pet
      </button>`;
  } else {
    footerEl.innerHTML = `
      <button class="btn btn--outline btn--full" onclick="closeModal('petDetailModal')">Close</button>`;
  }

  lucide?.createIcons?.({ el: document.getElementById('petDetailModal') });
  openModal?.('petDetailModal');
};