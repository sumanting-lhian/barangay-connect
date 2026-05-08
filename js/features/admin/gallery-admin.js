/* ================================================
   gallery-admin.js — BarangayConnect
   Admin panel gallery management sub-panel.
   Renders inside #galleryAdminContainer with
   section tabs: Featured, Pending, Albums.

   WHAT IS IN HERE:
     · Bootstrap — auth, barangay resolution, subscriptions
     · Featured posts list-view with unfeature / set-hero actions
     · Pending feature request queue with approve / reject
     · Albums list with create / edit / delete
     · Section tab switcher (_renderSection)

   WHAT IS NOT IN HERE:
     · Full masonry/grid gallery view  → gallery.js
     · Image viewer modal              → image-viewer.js
     · Confirm modal                   → confirm-modal.js

   REQUIRED IMPORTS:
     · /js/core/firebase-config.js
     · /js/core/db-paths.js
     · firebase-firestore.js@10.12.0
     · firebase-auth.js@10.12.0
================================================ */


// ================================================
// IMPORTS
// ================================================

import { auth, db }                          from '/js/core/firebase-config.js';
import { userIndexDoc, barangayId as toBid } from '/js/core/db-paths.js';
import { showConfirm }                       from '/js/shared/confirm-modal.js';

import {
  collection, query, where, orderBy, onSnapshot,
  doc, updateDoc, addDoc, deleteDoc,
  serverTimestamp, getDoc, deleteField, setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";


// ================================================
// MODULE STATE
// ================================================

let BID                   = null;
let _currentUserRole      = 'admin';
let _featuredAnn          = [];
let _featuredComm         = [];
let _pendingAnn           = [];
let _pendingComm          = [];
let _albums               = [];
let _albumOrder           = [];
let _photoOrder           = [];
let _activeSection        = 'featured'; // 'featured' | 'pending' | 'albums'
let _gaSelectedFeatured   = new Set();  // postIds selected for bulk unfeature
let _gaSelectedAlbums     = new Set();  // albumIds selected for bulk delete
let _gaSelectedPending    = new Set();  // postIds selected for bulk approve/reject


// ================================================
// CONSTANTS
// ================================================

const CATEGORY_MAP = {
  announcements:  { tagClass: 'tag--blue',   label: 'Announcement'   },
  health:         { tagClass: 'tag--green',  label: 'Health'         },
  infrastructure: { tagClass: 'tag--amber',  label: 'Infrastructure' },
  safety:         { tagClass: 'tag--red',    label: 'Safety'         },
  events:         { tagClass: 'tag--purple', label: 'Events'         },
  general:        { tagClass: 'tag--teal',   label: 'General'        },
};

const categoryMeta = cat => CATEGORY_MAP[cat] ?? CATEGORY_MAP.general;

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _dateStr(ts) {
  return ts?.toDate?.()?.toLocaleDateString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric',
  }) ?? '—';
}


// ================================================
// BOOTSTRAP
// ================================================

onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  const snap = await getDoc(userIndexDoc(user.uid));
  if (!snap.exists()) return;

  const { barangay, role } = snap.data();
  if (role !== 'admin' && role !== 'officer') return;

  _currentUserRole = role;
  BID = toBid(barangay);

  _renderShell();
  _subscribe();
});


// ================================================
// SHELL — section tabs + content slot
// ================================================

function _renderShell() {
  const el = document.getElementById('galleryAdminContainer');
  if (!el) return;

  el.innerHTML = `
    <h1 class="panel-heading">Gallery Management</h1>
    <div class="admin-subtab-row" id="galleryAdminSectionRow">
      <button class="gallery-admin-sec-btn bulletin-section-btn admin-subtab-btn active" style="line-height:1;"
        onclick="window._switchGallerySection('featured',this)">
        <i data-lucide="star" style="width:13px;height:13px;"></i> Featured
        <span id="gaFeaturedBadge" style="display:none;background:rgba(0,0,0,.09);
          border-radius:999px;padding:0 6px;font-size:.68rem;"></span>
      </button>
      <button class="gallery-admin-sec-btn bulletin-section-btn admin-subtab-btn" style="line-height:1;"
        onclick="window._switchGallerySection('pending',this)">
        <i data-lucide="clock" style="width:13px;height:13px;"></i> Pending
        <span id="gaP endingBadge" style="display:none;background:rgba(0,0,0,.09);
          border-radius:999px;padding:0 6px;font-size:.68rem;"></span>
      </button>
      <button class="gallery-admin-sec-btn bulletin-section-btn admin-subtab-btn" style="line-height:1;"
        onclick="window._switchGallerySection('albums',this)">
        <i data-lucide="folder" style="width:13px;height:13px;"></i> Albums
        <span id="gaAlbumsBadge" style="display:none;background:rgba(0,0,0,.09);
          border-radius:999px;padding:0 6px;font-size:.68rem;"></span>
      </button>
    </div>
    <div id="galleryAdminList" style="display:flex;flex-direction:column;gap:.75rem;"></div>`;

  lucide.createIcons({ el });
}

window._switchGallerySection = function (section, btn) {
  _activeSection = section;
  _gaSelectedFeatured.clear(); /* reset selection on tab switch */
  _gaSelectedAlbums.clear();
  _gaSelectedPending.clear();
  document.querySelectorAll('.gallery-admin-sec-btn')
    .forEach(b => b.classList.remove('active', 'is-active'));
  btn.classList.add('active');
  _renderSection();
};


// ================================================
// SUBSCRIPTIONS
// ================================================

function _subscribe() {
  /* Featured announcements */
  onSnapshot(
    query(collection(db, 'barangays', BID, 'announcements'),
      where('isFeatured', '==', true), orderBy('featuredAt', 'desc')),
    snap => {
      _featuredAnn = snap.docs.map(d => ({ id: d.id, _col: 'announcements', ...d.data() }));
      _updateBadge('gaFeaturedBadge', _featuredAnn.length + _featuredComm.length);
      if (_activeSection === 'featured') _renderSection();
    }
  );

  /* Featured community posts */
  onSnapshot(
    query(collection(db, 'barangays', BID, 'communityPosts'),
      where('isFeatured', '==', true), where('status', '==', 'published'),
      orderBy('featuredAt', 'desc')),
    snap => {
      _featuredComm = snap.docs.map(d => ({ id: d.id, _col: 'communityPosts', ...d.data() }));
      _updateBadge('gaFeaturedBadge', _featuredAnn.length + _featuredComm.length);
      if (_activeSection === 'featured') _renderSection();
    }
  );

  /* Pending feature requests */
  if (_currentUserRole === 'admin') {
    onSnapshot(
      query(collection(db, 'barangays', BID, 'announcements'),
        where('pendingFeatured', '==', true)),
      snap => {
        _pendingAnn = snap.docs.map(d => ({ id: d.id, _col: 'announcements', ...d.data() }));
        _updateBadge('gaPendingBadge', _pendingAnn.length + _pendingComm.length);
        if (_activeSection === 'pending') _renderSection();
      }
    );
    onSnapshot(
      query(collection(db, 'barangays', BID, 'communityPosts'),
        where('pendingFeatured', '==', true), where('status', '==', 'published')),
      snap => {
        _pendingComm = snap.docs.map(d => ({ id: d.id, _col: 'communityPosts', ...d.data() }));
        _updateBadge('gaPendingBadge', _pendingAnn.length + _pendingComm.length);
        if (_activeSection === 'pending') _renderSection();
      }
    );
  }

  /* Albums */
  onSnapshot(
    query(collection(db, 'barangays', BID, 'albums'), orderBy('createdAt', 'desc')),
    snap => {
      _albums = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      _updateBadge('gaAlbumsBadge', _albums.length);
      if (_activeSection === 'albums') _renderSection();
    }
  );

  /* Real-time photo/album order — written by both gallery.js and admin drag */
  onSnapshot(doc(db, 'barangays', BID, 'meta', 'gallery'), snap => {
    const d = snap.exists() ? snap.data() : {};
    _albumOrder = d.albumOrder ?? [];
    _photoOrder = d.photoOrder ?? [];
    if (_activeSection === 'albums')  _renderSection();
    if (_activeSection === 'featured') _renderSection();
  });
}

function _updateBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent   = count;
  el.style.display = count > 0 ? 'inline' : 'none';
}


// ================================================
// RENDER — Section dispatcher
// ================================================

function _renderSection() {
  const el = document.getElementById('galleryAdminList');
  if (!el) return;
  if (_activeSection === 'featured') _renderFeatured(el);
  else if (_activeSection === 'pending') _renderPending(el);
  else _renderAlbums(el);
}


// ================================================
// RENDER — Featured Posts
// ================================================

function _renderFeatured(el) {
  let all = [
    ..._featuredAnn.map(p => ({ ...p })),
    ..._featuredComm.map(p => ({ ...p })),
  ];
  if (_photoOrder.length) {
    const orderMap = new Map(_photoOrder.map((id, i) => [id, i]));
    all.sort((a, b) => {
      if (a.isHeroFeatured && !b.isHeroFeatured) return -1;
      if (!a.isHeroFeatured && b.isHeroFeatured) return  1;
      const ai = orderMap.has(a.id) ? orderMap.get(a.id) : Infinity;
      const bi = orderMap.has(b.id) ? orderMap.get(b.id) : Infinity;
      return ai === Infinity && bi === Infinity ? 0 : ai - bi;
    });
  } else {
    all.sort((a, b) => {
      if (a.isHeroFeatured && !b.isHeroFeatured) return -1;
      if (!a.isHeroFeatured && b.isHeroFeatured) return  1;
      const ta = a.featuredAt?.toDate?.() ?? new Date(0);
      const tb = b.featuredAt?.toDate?.() ?? new Date(0);
      return tb - ta;
    });
  }

  if (!all.length) {
    el.innerHTML = _emptyState('star', 'No featured posts yet.',
      'Feature posts from the Community Bulletin to display them here.');
    return;
  }

  /* Bulk toolbar — visible when any rows are checked */
  const _bulkBar = _gaSelectedFeatured.size > 0 ? `
    <div style="display:flex;align-items:center;gap:.75rem;padding:.6rem 1rem;
      margin-bottom:.5rem;background:#fef3c7;border-radius:10px;
      border:1.5px solid #fde68a;flex-wrap:wrap;">
      <span style="font-size:.82rem;font-weight:700;color:#92400e;flex:1;">
        ${_gaSelectedFeatured.size} post${_gaSelectedFeatured.size !== 1 ? 's' : ''} selected
      </span>
      <button onclick="window._gaSelectAllFeatured()"
        style="${_btnStyle('#f0fdf4','#15803d','#bbf7d0')}padding:.35rem .75rem;font-size:.78rem;">
        Select All
      </button>
      <button onclick="window._gaClearFeaturedSelection()"
        style="${_btnStyle('#fff','#6b7280','#d1d5db')}padding:.35rem .75rem;font-size:.78rem;">
        Clear
      </button>
      <button onclick="window._gaBulkUnfeature()"
        style="${_btnStyle('#fff','#dc2626','#fca5a5')}padding:.35rem .75rem;font-size:.78rem;">
        <i data-lucide="star-off" style="width:11px;height:11px;"></i>
        Unfeature ${_gaSelectedFeatured.size}
      </button>
    </div>` : '';

  el.innerHTML = _bulkBar + all.map(p => {
    const meta   = categoryMeta(p.category);
    const cover  = p.imageURLs?.[p.featuredCoverIndex ?? 0] ?? p.imageURL ?? null;
    const heroLabel = p.isHeroFeatured
      ? `<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:999px;
           font-size:.68rem;font-weight:700;">⭐ Spotlight</span>` : '';

      const _sel = _gaSelectedFeatured.has(p.id);
      return `
        <div class="_gaFeaturedRow" data-post-id="${esc(p.id)}"
          style="background:${_sel ? '#f0fdf4' : '#fff'};border-radius:12px;padding:1rem 1.25rem;
          box-shadow:0 1px 4px rgba(0,0,0,.07);display:flex;align-items:center;
          gap:1rem;flex-wrap:wrap;border-left:3px solid ${_sel ? '#16a34a' : 'var(--green-dark)'};cursor:grab;">
          <i data-lucide="grip-vertical"
            style="width:14px;height:14px;color:#d1d5db;flex-shrink:0;cursor:grab;"></i>
          <div onclick="event.stopPropagation();window._gaToggleFeaturedSelect('${esc(p.id)}')"
            style="width:18px;height:18px;border-radius:4px;flex-shrink:0;cursor:pointer;
              border:2px solid ${_sel ? '#16a34a' : '#d1d5db'};background:${_sel ? '#16a34a' : '#fff'};
              display:flex;align-items:center;justify-content:center;">
            ${_sel ? `<i data-lucide="check" style="width:11px;height:11px;color:#fff;pointer-events:none;"></i>` : ''}
          </div>
          ${cover ? (() => { const _imgs = p.imageURLs?.length ? p.imageURLs : (cover ? [cover] : []); const _enc = encodeURIComponent(JSON.stringify(_imgs)); return `<img src="${esc(cover)}" style="width:72px;height:56px;object-fit:cover;border-radius:8px;flex-shrink:0;border:1px solid #e5e7eb;cursor:pointer;" onclick="window.openImageViewer(JSON.parse(decodeURIComponent('${_enc}')),0,'${esc(p.title ?? '')}')" />`; })() : ''}
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;margin-bottom:2px;">
            <span style="font-weight:700;font-size:.9rem;">${esc(p.title ?? '')}</span>
            ${heroLabel}
          </div>
          <p style="font-size:.75rem;color:#6b7280;margin:0;">
            ${esc(meta.label)} · by ${esc(p.authorName ?? '—')} ·
            featured ${_dateStr(p.featuredAt)}
            ${p.featuredByName ? `· by <strong>${esc(p.featuredByName)}</strong>` : ''}
          </p>
        </div>
        <div style="display:flex;gap:.4rem;flex-shrink:0;flex-wrap:wrap;">
          ${_gaSelectedFeatured.size <= 1 ? (!p.isHeroFeatured ? `
          <button onclick="window._gaSetHero('${esc(p.id)}','${esc(p._col)}')"
            style="${_btnStyle('#f9fafb','#374151','#e5e7eb')}">
            <i data-lucide="crown" style="width:12px;height:12px;"></i> Spotlight
          </button>` : `
          <button onclick="window._gaRemoveHero('${esc(p.id)}','${esc(p._col)}')"
            style="${_btnStyle('#fef3c7','#92400e','#fde68a')}">
            <i data-lucide="crown" style="width:12px;height:12px;"></i> Remove
          </button>`) : ''}
          ${_gaSelectedFeatured.size === 0 ? `
          <button onclick="window._gaUnfeature('${esc(p.id)}','${esc(p._col)}')"
            style="${_btnStyle('#fff','#dc2626','#fca5a5')}">
            <i data-lucide="star-off" style="width:12px;height:12px;"></i> Unfeature
          </button>` : ''}
        </div>
      </div>`;
  }).join('');

  lucide.createIcons({ el });
  _wireDragReorderFeatured(el, all);
}

/* Drag reorder for the featured list — writes photoOrder to meta/gallery */
function _wireDragReorderFeatured(listEl, orderedPosts) {
  let _src = null;
  const rows = [...listEl.querySelectorAll('._gaFeaturedRow')];
  rows.forEach(row => {
    row.setAttribute('draggable', 'true');
    row.style.cursor = 'grab';
    row.addEventListener('dragstart', e => {
      _src = row; row.style.opacity = '.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      row.style.opacity = '';
      rows.forEach(r => r.style.outline = '');
      _src = null;
    });
    row.addEventListener('dragover', e => {
      e.preventDefault();
      if (row !== _src) {
        rows.forEach(r => r.style.outline = '');
        row.style.outline = '2px solid var(--green-dark)';
        row.style.outlineOffset = '2px';
      }
    });
    row.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation();
      if (!_src || _src === row) return;
      row.style.outline = '';
      const ids = [...listEl.querySelectorAll('._gaFeaturedRow')].map(r => r.dataset.postId);
      const from = ids.indexOf(_src.dataset.postId);
      const to   = ids.indexOf(row.dataset.postId);
      if (from === -1 || to === -1) return;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      row.parentNode.insertBefore(_src, to > from ? row.nextSibling : row);
      try {
        await setDoc(doc(db, 'barangays', BID, 'meta', 'gallery'),
          { photoOrder: ids }, { merge: true });
        _showGaToast('Photo order saved.');
      } catch (err) { _showGaToast('Failed to save order.', 'error'); }
    });
  });
}

/* Toggles a single post in/out of the featured bulk selection */
window._gaToggleFeaturedSelect = function (postId) {
  if (_gaSelectedFeatured.has(postId)) _gaSelectedFeatured.delete(postId);
  else _gaSelectedFeatured.add(postId);
  const el = document.getElementById('galleryAdminList');
  if (el) _renderFeatured(el);
};

window._gaSelectAllFeatured = function () {
  const all = [..._featuredAnn, ..._featuredComm];
  all.forEach(p => _gaSelectedFeatured.add(p.id));
  const el = document.getElementById('galleryAdminList');
  if (el) _renderFeatured(el);
};

window._gaClearFeaturedSelection = function () {
  _gaSelectedFeatured.clear();
  const el = document.getElementById('galleryAdminList');
  if (el) _renderFeatured(el);
};

/* Bulk-unfeatures all selected posts */
window._gaBulkUnfeature = async function () {
  if (!_gaSelectedFeatured.size) return;
  const count = _gaSelectedFeatured.size;
  const ok = await showConfirm({
    title:   `Remove ${count} post${count !== 1 ? 's' : ''} from Gallery?`,
    body:    'These posts will no longer appear in the Featured Gallery.',
    confirm: 'Remove', cancel: 'Go Back', variant: 'warning',
  });
  if (!ok) return;
  const all = [..._featuredAnn, ..._featuredComm];
  try {
    await Promise.all([..._gaSelectedFeatured].map(postId => {
      const p = all.find(x => x.id === postId);
      if (!p) return Promise.resolve();
      return updateDoc(doc(db, 'barangays', BID, p._col, postId), {
        isFeatured: deleteField(), featuredAt: deleteField(),
        isHeroFeatured: deleteField(), featuredBy: deleteField(),
        featuredByName: deleteField(), featuredCoverIndex: deleteField(),
      });
    }));
    _gaSelectedFeatured.clear();
    _showGaToast(`${count} post${count !== 1 ? 's' : ''} removed from gallery.`, 'error');
  } catch (err) { _showGaToast('Failed. Try again.', 'error'); }
};


// ================================================
// RENDER — Pending Requests
// ================================================

function _renderPending(el) {
  const all = [
    ..._pendingAnn.map(p => ({ ...p })),
    ..._pendingComm.map(p => ({ ...p })),
  ];

  if (!all.length) {
    el.innerHTML = _emptyState('check-circle', 'No pending requests.',
      'Feature requests from officers will appear here.');
    return;
  }

  const _pendingBulkBar = _gaSelectedPending.size > 0 ? `
    <div style="display:flex;align-items:center;gap:.75rem;padding:.6rem 1rem;
      margin-bottom:.5rem;background:#fef3c7;border-radius:10px;
      border:1.5px solid #fde68a;flex-wrap:wrap;">
      <span style="font-size:.82rem;font-weight:700;color:#92400e;flex:1;">
        ${_gaSelectedPending.size} request${_gaSelectedPending.size !== 1 ? 's' : ''} selected
      </span>
      <button onclick="window._gaSelectAllPending()"
        style="${_btnStyle('#f0fdf4','#15803d','#bbf7d0')}padding:.35rem .75rem;font-size:.78rem;">
        Select All
      </button>
      <button onclick="window._gaClearPendingSelection()"
        style="${_btnStyle('#fff','#6b7280','#d1d5db')}padding:.35rem .75rem;font-size:.78rem;">
        Clear
      </button>
      <button onclick="window._gaBulkApprovePending()"
        style="${_btnStyle('#1a3a1a','#fff','#1a3a1a')}padding:.35rem .75rem;font-size:.78rem;">
        <i data-lucide="check" style="width:11px;height:11px;"></i>
        Approve ${_gaSelectedPending.size}
      </button>
      <button onclick="window._gaBulkRejectPending()"
        style="${_btnStyle('#fff','#dc2626','#fca5a5')}padding:.35rem .75rem;font-size:.78rem;">
        <i data-lucide="x" style="width:11px;height:11px;"></i>
        Reject ${_gaSelectedPending.size}
      </button>
    </div>` : '';

  el.innerHTML = _pendingBulkBar + all.map(p => {
    const _psel = _gaSelectedPending.has(p.id);
    const meta = categoryMeta(p.category);
    return `
      <div style="background:${_psel ? '#f0fdf4' : '#fff'};border-radius:12px;padding:1rem 1.25rem;
        box-shadow:0 1px 4px rgba(0,0,0,.07);display:flex;align-items:center;
        gap:1rem;flex-wrap:wrap;border-left:3px solid ${_psel ? '#16a34a' : '#f59e0b'};">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;margin-bottom:2px;">
            <span style="font-weight:700;font-size:.9rem;">${esc(p.title ?? '')}</span>
            <span style="background:#fef3c7;color:#92400e;padding:2px 8px;
              border-radius:999px;font-size:.68rem;font-weight:700;">Pending</span>
          </div>
          <p style="font-size:.75rem;color:#6b7280;margin:0;">
            ${esc(meta.label)} · Requested by <strong>${esc(p.featuredByName ?? 'Officer')}</strong>
          </p>
        </div>
        <div style="display:flex;gap:.4rem;flex-shrink:0;align-items:center;">
          <div onclick="event.stopPropagation();window._gaTogglePendingSelect('${esc(p.id)}')"
            style="width:18px;height:18px;border-radius:4px;flex-shrink:0;cursor:pointer;
              border:2px solid ${_gaSelectedPending.has(p.id) ? '#16a34a' : '#d1d5db'};
              background:${_gaSelectedPending.has(p.id) ? '#16a34a' : '#fff'};
              display:flex;align-items:center;justify-content:center;">
            ${_gaSelectedPending.has(p.id) ? `<i data-lucide="check" style="width:11px;height:11px;color:#fff;pointer-events:none;"></i>` : ''}
          </div>
          ${_gaSelectedPending.size === 0 ? `
          <button onclick="window._gaApprovePending('${esc(p.id)}','${esc(p._col)}')"
            style="${_btnStyle('#1a3a1a','#fff','#1a3a1a')}">
            <i data-lucide="check" style="width:12px;height:12px;"></i> Approve
          </button>
          <button onclick="window._gaRejectPending('${esc(p.id)}','${esc(p._col)}')"
            style="${_btnStyle('#fff','#dc2626','#fca5a5')}">
            <i data-lucide="x" style="width:12px;height:12px;"></i> Reject
          </button>` : ''}
        </div>
      </div>`;
  }).join('');

  lucide.createIcons({ el });
}


// ================================================
// RENDER — Albums
// ================================================

function _renderAlbums(el) {
  const createBtn = `
    <button onclick="window._gaOpenCreateAlbum()"
      style="${_btnStyle('#1a3a1a','#fff','#1a3a1a')}margin-bottom:.75rem;">
      <i data-lucide="folder-plus" style="width:12px;height:12px;"></i> New Album
    </button>`;

  if (!_albums.length) {
    el.innerHTML = createBtn + _emptyState('folder-open', 'No albums yet.',
      'Create albums to group featured posts together.');
    lucide.createIcons({ el });
    return;
  }

  const _albumBulkBar = _gaSelectedAlbums.size > 0 ? `
    <div style="display:flex;align-items:center;gap:.75rem;padding:.6rem 1rem;
      margin-bottom:.5rem;background:#fef3c7;border-radius:10px;
      border:1.5px solid #fde68a;flex-wrap:wrap;">
      <span style="font-size:.82rem;font-weight:700;color:#92400e;flex:1;">
        ${_gaSelectedAlbums.size} album${_gaSelectedAlbums.size !== 1 ? 's' : ''} selected
      </span>
      <button onclick="window._gaSelectAllAlbums()"
        style="${_btnStyle('#f0fdf4','#15803d','#bbf7d0')}padding:.35rem .75rem;font-size:.78rem;">
        Select All
      </button>
      <button onclick="window._gaClearAlbumSelection()"
        style="${_btnStyle('#fff','#6b7280','#d1d5db')}padding:.35rem .75rem;font-size:.78rem;">
        Clear
      </button>
      <button onclick="window._gaBulkDeleteAlbums()"
        style="${_btnStyle('#fff','#dc2626','#fca5a5')}padding:.35rem .75rem;font-size:.78rem;">
        <i data-lucide="trash-2" style="width:11px;height:11px;"></i>
        Delete ${_gaSelectedAlbums.size}
      </button>
    </div>` : '';

  const _ordered = _albumOrder.length
    ? [..._albums].sort((a, b) => {
        const ai = _albumOrder.indexOf(a.id);
        const bi = _albumOrder.indexOf(b.id);
        return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
      })
    : _albums;
  el.innerHTML = createBtn + _albumBulkBar + `<div id="_gaAlbumList" style="display:flex;flex-direction:column;gap:.5rem;">` +
    _ordered.map(album => _buildAdminAlbumRow(album)).join('') + `</div>`;

  lucide.createIcons({ el });
  _wireAdminAlbumDrag(document.getElementById('_gaAlbumList'));
}

function _buildAdminAlbumRow(album) {
  const count   = album.postIds?.length ?? 0;
  const date    = _dateStr(album.createdAt);
  const aid     = esc(album.id);
  const posts   = (album.postIds ?? [])
    .map(id => {
      const p = [...(_featuredAnn ?? []), ...(_featuredComm ?? [])].find(x => x.id === id);
      return p ? `
        <div class="_gaAlbumPost" data-post-id="${esc(id)}"
          style="display:flex;align-items:center;gap:.5rem;padding:.35rem .5rem;
            background:#f9fafb;border-radius:6px;border:1px solid #e5e7eb;cursor:grab;">
          <i data-lucide="grip-vertical" style="width:12px;height:12px;color:#d1d5db;flex-shrink:0;"></i>
          ${p.imageURLs?.[0] || p.imageURL
            ? `<img src="${esc(p.imageURLs?.[0] ?? p.imageURL)}"
                style="width:36px;height:28px;object-fit:cover;border-radius:4px;flex-shrink:0;" />`
            : `<div style="width:36px;height:28px;background:#e5e7eb;border-radius:4px;flex-shrink:0;"></div>`}
          <span style="font-size:.78rem;font-weight:600;flex:1;min-width:0;
            overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${esc(p.title ?? id)}
          </span>
          <button onclick="window._gaRemovePostFromAlbum('${aid}','${esc(id)}')"
            style="${_btnStyle('#fff','#dc2626','#fca5a5')}padding:.25rem .5rem;font-size:.72rem;">
            <i data-lucide="x" style="width:10px;height:10px;"></i>
          </button>
        </div>` : '';
    }).filter(Boolean).join('');

  return `
    <div class="_gaAlbumRow" data-album-id="${aid}"
      style="background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.07);
        border-left:3px solid #6b7280;overflow:hidden;">
      <div onclick="window._gaToggleAlbumPosts('${aid}')"
        style="display:flex;align-items:center;gap:.75rem;padding:.85rem 1.25rem;
          flex-wrap:wrap;cursor:pointer;user-select:none;">
        <i data-lucide="grip-vertical"
          style="width:14px;height:14px;color:#d1d5db;flex-shrink:0;cursor:grab;"
          onclick="event.stopPropagation()"></i>
        <i data-lucide="chevron-right" id="_gaAlbumChevron_${aid}"
          style="width:14px;height:14px;color:#9ca3af;flex-shrink:0;transition:transform .2s;"></i>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap;">
            <span style="font-weight:700;font-size:.9rem;">${esc(album.title)}</span>
            <span style="font-size:.72rem;color:#9ca3af;">${date}</span>
          </div>
          <p style="font-size:.75rem;color:#6b7280;margin:0;">
            ${count} post${count !== 1 ? 's' : ''}
            ${album.description ? ` · ${esc(album.description.slice(0, 60))}` : ''}
          </p>
        </div>
        <div style="display:flex;gap:.4rem;flex-shrink:0;align-items:center;"
          onclick="event.stopPropagation()">
          <div onclick="event.stopPropagation();window._gaToggleAlbumSelect('${aid}')"
            style="width:18px;height:18px;border-radius:4px;flex-shrink:0;cursor:pointer;
              border:2px solid ${_gaSelectedAlbums.has(aid) ? '#16a34a' : '#d1d5db'};
              background:${_gaSelectedAlbums.has(aid) ? '#16a34a' : '#fff'};
              display:flex;align-items:center;justify-content:center;">
            ${_gaSelectedAlbums.has(aid) ? `<i data-lucide="check" style="width:11px;height:11px;color:#fff;pointer-events:none;"></i>` : ''}
          </div>
          <button onclick="window._gaEditAlbum('${aid}')"
            style="${_btnStyle('#f9fafb','#374151','#e5e7eb')}">
            <i data-lucide="pencil" style="width:12px;height:12px;"></i> Edit
          </button>
          ${_gaSelectedAlbums.size === 0 ? `
          <button onclick="window._gaDeleteAlbum('${aid}','${esc(album.title)}')"
            style="${_btnStyle('#fff','#dc2626','#fca5a5')}">
            <i data-lucide="trash-2" style="width:12px;height:12px;"></i>
          </button>` : ''}
        </div>
      </div>
      <div id="_gaAlbumPosts_${aid}" style="display:none;padding:.5rem 1rem .75rem 1rem;
        border-top:1px solid #f0f0f0;display:none;">
        <p style="font-size:.7rem;font-weight:700;text-transform:uppercase;
          color:#9ca3af;letter-spacing:.06em;margin:0 0 .4rem;">
          Posts — drag to reorder
        </p>
        <div id="_gaAlbumPostList_${aid}"
          style="display:flex;flex-direction:column;gap:.3rem;">
          ${posts.length ? posts : `<p style="font-size:.8rem;color:#aaa;margin:0;">No posts in this album.</p>`}
        </div>
      </div>
    </div>`;
}


// ================================================
// ACTIONS — Featured
// ================================================

window._gaSetHero = async function (postId, col) {
  const ok = await showConfirm({
    title: 'Set as Spotlight?',
    body: 'This post will be spotlighted at the top of the gallery. The current spotlight (if any) will return to the grid.',
    confirm: 'Set Spotlight', cancel: 'Go Back', variant: 'confirm',
  });
  if (!ok) return;
  try {
    /* Demote existing hero first */
    const all = [..._featuredAnn, ..._featuredComm];
    const existing = all.filter(p => p.isHeroFeatured && p.id !== postId);
    await Promise.all(existing.map(h =>
      updateDoc(doc(db, 'barangays', BID, h._col, h.id), { isHeroFeatured: deleteField() })
    ));
    await updateDoc(doc(db, 'barangays', BID, col, postId), { isHeroFeatured: true });
    _showGaToast('Spotlight set.');
  } catch (err) { _showGaToast('Failed. Try again.', 'error'); }
};

window._gaRemoveHero = async function (postId, col) {
  const ok = await showConfirm({
    title: 'Remove Spotlight?',
    body: 'This post will return to the regular gallery grid.',
    confirm: 'Remove', cancel: 'Go Back', variant: 'warning',
  });
  if (!ok) return;
  try {
    await updateDoc(doc(db, 'barangays', BID, col, postId), { isHeroFeatured: deleteField() });
    _showGaToast('Spotlight removed.', 'error');
  } catch (err) { _showGaToast('Failed. Try again.', 'error'); }
};

window._gaUnfeature = async function (postId, col) {
  const ok = await showConfirm({
    title: 'Remove from Gallery?',
    body: 'This post will no longer appear in the Featured Gallery.',
    confirm: 'Remove', cancel: 'Go Back', variant: 'warning',
  });
  if (!ok) return;
  try {
    await updateDoc(doc(db, 'barangays', BID, col, postId), {
      isFeatured:       deleteField(),
      featuredAt:       deleteField(),
      isHeroFeatured:   deleteField(),
      featuredBy:       deleteField(),
      featuredByName:   deleteField(),
      featuredCoverIndex: deleteField(),
    });
    _showGaToast('Removed from gallery.', 'error');
  } catch (err) { _showGaToast('Failed. Try again.', 'error'); }
};


// ================================================
// ACTIONS — Pending
// ================================================

window._gaApprovePending = async function (postId, col) {
  const ok = await showConfirm({
    title: 'Approve Feature Request?',
    body: 'This post will be added to the Featured Gallery.',
    confirm: 'Approve', cancel: 'Go Back', variant: 'confirm',
  });
  if (!ok) return;
  try {
    await updateDoc(doc(db, 'barangays', BID, col, postId), {
      isFeatured: true, featuredAt: serverTimestamp(), pendingFeatured: deleteField(),
    });
    _showGaToast('Approved.');
  } catch (err) { _showGaToast('Failed. Try again.', 'error'); }
};

window._gaRejectPending = async function (postId, col) {
  const ok = await showConfirm({
    title: 'Reject Request?',
    body: "The officer's request will be dismissed.",
    confirm: 'Reject', cancel: 'Go Back', variant: 'danger',
  });
  if (!ok) return;
  try {
    await updateDoc(doc(db, 'barangays', BID, col, postId), {
      pendingFeatured: deleteField(), featuredBy: deleteField(), featuredByName: deleteField(),
    });
    _showGaToast('Rejected.', 'error');
  } catch (err) { _showGaToast('Failed. Try again.', 'error'); }
};


// ================================================
// ACTIONS — Albums (create / edit / delete)
// ================================================

window._gaOpenCreateAlbum = function () { _gaOpenAlbumModal(null); };
window._gaEditAlbum       = function (id) { _gaOpenAlbumModal(id); };

function _gaOpenAlbumModal(albumId) {
  const isEdit = albumId !== null;
  const album  = isEdit ? _albums.find(a => a.id === albumId) : null;

  let overlay = document.getElementById('_gaAlbumModal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id        = '_gaAlbumModal';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }

  /* Build cover options from currently-featured posts that belong to this album */
  const _allFeat = [..._featuredAnn, ..._featuredComm];
  const coverOptions = isEdit
    ? (album?.postIds ?? [])
        .map(id => _allFeat.find(p => p.id === id))
        .filter(p => p && (p.imageURLs?.[0] || p.imageURL))
        .map(p => `<option value="${esc(p.id)}" ${album?.coverPostId === p.id ? 'selected' : ''}>
          ${esc(p.title ?? p.id)}</option>`).join('')
    : '';

  overlay.innerHTML = `
    <div class="modal modal--confirm" onclick="event.stopPropagation()" style="max-width:420px;">
      <div class="modal-confirm__icon" style="background:#f0fdf4;border-color:#bbf7d0;">
        <i data-lucide="folder-plus" style="width:28px;height:28px;stroke-width:2;color:#15803d;pointer-events:none;"></i>
      </div>
      <h2 class="modal-confirm__title">${isEdit ? 'Edit Album' : 'New Album'}</h2>
      <div style="display:flex;flex-direction:column;gap:var(--space-md);padding:0 var(--space-lg) var(--space-md);">
        <div class="form-group">
          <label class="form-label">Album Title</label>
          <input id="_gaAlbumTitle" class="form-input"
            placeholder="e.g. Fiesta 2025" maxlength="60"
            value="${esc(album?.title ?? '')}" />
        </div>
        <div class="form-group">
          <label class="form-label">Description
            <span style="color:var(--gray-400);font-size:var(--text-xs);font-weight:400;">(optional)</span>
          </label>
          <textarea id="_gaAlbumDesc" class="form-input" rows="2"
            maxlength="200" placeholder="A short description…">${esc(album?.description ?? '')}</textarea>
        </div>
        ${isEdit ? `
        <div class="form-group">
          <label class="form-label">Cover Photo
            <span style="color:var(--gray-400);font-size:var(--text-xs);font-weight:400;">(optional)</span>
          </label>
          <select id="_gaAlbumCover" class="form-select">
            <option value="">— Auto (first photo in album)</option>
            ${coverOptions}
          </select>
          <p style="font-size:var(--text-xs);color:var(--gray-400);margin-top:4px;">
            Picking a cover here pins it — reordering won't change it.
          </p>
        </div>` : `<input id="_gaAlbumCover" type="hidden" value="" />`}
      </div>
      <div class="modal-confirm__footer">
        <button class="btn btn--outline"
          onclick="document.getElementById('_gaAlbumModal').classList.remove('is-open')">
          Cancel
        </button>
        <button class="btn btn--green btn--full"
          onclick="window._gaSaveAlbum(${isEdit ? `'${esc(albumId)}'` : 'null'})">
          <i data-lucide="${isEdit ? 'save' : 'folder-plus'}"></i>
          ${isEdit ? 'Save Changes' : 'Create Album'}
        </button>
      </div>
    </div>`;

  overlay.classList.add('is-open');
  overlay.onclick = e => { if (e.target === overlay) overlay.classList.remove('is-open'); };
  lucide.createIcons({ el: overlay });
}

window._gaSaveAlbum = async function (albumId) {
  const title   = document.getElementById('_gaAlbumTitle')?.value.trim();
  const desc    = document.getElementById('_gaAlbumDesc')?.value.trim() || '';
  const coverId = document.getElementById('_gaAlbumCover')?.value || '';
  if (!title) { document.getElementById('_gaAlbumTitle')?.focus(); return; }

  try {
    if (albumId) {
      await updateDoc(doc(db, 'barangays', BID, 'albums', albumId),
        { title, description: desc, coverPostId: coverId || null, coverMode: coverId ? 'manual' : 'auto', updatedAt: serverTimestamp() });
    } else {
      await addDoc(collection(db, 'barangays', BID, 'albums'),
        { title, description: desc, postIds: [], createdAt: serverTimestamp() });
    }
    document.getElementById('_gaAlbumModal')?.classList.remove('is-open');
    _showGaToast(albumId ? 'Album updated.' : `"${title}" created.`);
  } catch (err) { _showGaToast('Failed. Try again.', 'error'); }
};

window._gaDeleteAlbum = async function (albumId, title) {
  const ok = await showConfirm({
    title: 'Delete Album?',
    body: `"${title}" will be deleted. Posts inside are not affected.`,
    confirm: 'Delete', cancel: 'Go Back', variant: 'danger',
  });
  if (!ok) return;
  try {
    await deleteDoc(doc(db, 'barangays', BID, 'albums', albumId));
    _showGaToast('Album deleted.', 'error');
  } catch (err) { _showGaToast('Failed. Try again.', 'error'); }
};


window._gaToggleAlbumSelect = function (albumId) {
  if (_gaSelectedAlbums.has(albumId)) _gaSelectedAlbums.delete(albumId);
  else _gaSelectedAlbums.add(albumId);
  const el = document.getElementById('galleryAdminList');
  if (el) _renderAlbums(el);
};

window._gaSelectAllAlbums = function () {
  _albums.forEach(a => _gaSelectedAlbums.add(a.id));
  const el = document.getElementById('galleryAdminList');
  if (el) _renderAlbums(el);
};

window._gaClearAlbumSelection = function () {
  _gaSelectedAlbums.clear();
  const el = document.getElementById('galleryAdminList');
  if (el) _renderAlbums(el);
};

window._gaBulkDeleteAlbums = async function () {
  if (!_gaSelectedAlbums.size) return;
  const count = _gaSelectedAlbums.size;
  const ok = await showConfirm({
    title:   `Delete ${count} album${count !== 1 ? 's' : ''}?`,
    body:    'Albums will be deleted. Posts inside are not affected.',
    confirm: 'Delete', cancel: 'Go Back', variant: 'danger',
  });
  if (!ok) return;
  try {
    await Promise.all([..._gaSelectedAlbums].map(id =>
      deleteDoc(doc(db, 'barangays', BID, 'albums', id))
    ));
    _gaSelectedAlbums.clear();
    _showGaToast(`${count} album${count !== 1 ? 's' : ''} deleted.`, 'error');
  } catch (err) { _showGaToast('Failed. Try again.', 'error'); }
};


window._gaTogglePendingSelect = function (postId) {
  if (_gaSelectedPending.has(postId)) _gaSelectedPending.delete(postId);
  else _gaSelectedPending.add(postId);
  const el = document.getElementById('galleryAdminList');
  if (el) _renderPending(el);
};

window._gaSelectAllPending = function () {
  [..._pendingAnn, ..._pendingComm].forEach(p => _gaSelectedPending.add(p.id));
  const el = document.getElementById('galleryAdminList');
  if (el) _renderPending(el);
};

window._gaClearPendingSelection = function () {
  _gaSelectedPending.clear();
  const el = document.getElementById('galleryAdminList');
  if (el) _renderPending(el);
};

window._gaBulkApprovePending = async function () {
  if (!_gaSelectedPending.size) return;
  const count = _gaSelectedPending.size;
  const ok = await showConfirm({
    title:   `Approve ${count} request${count !== 1 ? 's' : ''}?`,
    body:    'These posts will be added to the Featured Gallery.',
    confirm: 'Approve', cancel: 'Go Back', variant: 'confirm',
  });
  if (!ok) return;
  const all = [..._pendingAnn, ..._pendingComm];
  try {
    await Promise.all([..._gaSelectedPending].map(postId => {
      const p = all.find(x => x.id === postId);
      if (!p) return Promise.resolve();
      return updateDoc(doc(db, 'barangays', BID, p._col, postId), {
        isFeatured: true, featuredAt: serverTimestamp(), pendingFeatured: deleteField(),
      });
    }));
    _gaSelectedPending.clear();
    _showGaToast(`${count} request${count !== 1 ? 's' : ''} approved.`);
  } catch (err) { _showGaToast('Failed. Try again.', 'error'); }
};

window._gaBulkRejectPending = async function () {
  if (!_gaSelectedPending.size) return;
  const count = _gaSelectedPending.size;
  const ok = await showConfirm({
    title:   `Reject ${count} request${count !== 1 ? 's' : ''}?`,
    body:    "These feature requests will be dismissed.",
    confirm: 'Reject', cancel: 'Go Back', variant: 'danger',
  });
  if (!ok) return;
  const all = [..._pendingAnn, ..._pendingComm];
  try {
    await Promise.all([..._gaSelectedPending].map(postId => {
      const p = all.find(x => x.id === postId);
      if (!p) return Promise.resolve();
      return updateDoc(doc(db, 'barangays', BID, p._col, postId), {
        pendingFeatured: deleteField(), featuredBy: deleteField(), featuredByName: deleteField(),
      });
    }));
    _gaSelectedPending.clear();
    _showGaToast(`${count} request${count !== 1 ? 's' : ''} rejected.`, 'error');
  } catch (err) { _showGaToast('Failed. Try again.', 'error'); }
};


// ================================================
// UTILITIES
// ================================================

function _emptyState(icon, title, sub) {
  return `
    <div style="background:#fff;border-radius:12px;padding:3rem;text-align:center;
      color:#aaa;box-shadow:0 1px 4px rgba(0,0,0,.07);">
      <div style="font-size:2rem;margin-bottom:.5rem;"><i data-lucide="${icon}"></i></div>
      <p style="margin:0 0 .25rem;font-size:.9rem;font-weight:600;color:#6b7280;">${title}</p>
      <p style="margin:0;font-size:.82rem;">${sub}</p>
    </div>`;
}

function _btnStyle(bg, color, border) {
  return `display:inline-flex;align-items:center;gap:.35rem;padding:.45rem .9rem;
    border-radius:8px;background:${bg};color:${color};border:1.5px solid ${border};
    font-size:.8rem;font-weight:600;cursor:pointer;`;
}

/* Toggle post list inside an admin album row */
window._gaToggleAlbumPosts = function (albumId) {
  const el      = document.getElementById(`_gaAlbumPosts_${albumId}`);
  const chevron = document.getElementById(`_gaAlbumChevron_${albumId}`);
  if (!el) return;
  const showing = el.style.display !== 'block';
  el.style.display = showing ? 'block' : 'none';
  if (chevron) chevron.style.transform = showing ? 'rotate(90deg)' : '';
  if (showing) _wireAdminPostDrag(albumId);
};

/* Drag reorder for posts inside an expanded admin album row */
function _wireAdminPostDrag(albumId) {
  const listEl = document.getElementById(`_gaAlbumPostList_${albumId}`);
  if (!listEl) return;
  const posts = [...listEl.querySelectorAll('._gaAlbumPost')];
  let _src = null;
  let _isDirty = false;

  /* Inject save/discard bar if not already there */
  const barId = `_gaPostOrderBar_${albumId}`;
  if (!document.getElementById(barId)) {
    const bar = document.createElement('div');
    bar.id        = barId;
    bar.style.cssText = `display:none;align-items:center;gap:.5rem;padding:.5rem 0;
      margin-bottom:.4rem;flex-wrap:wrap;`;
    bar.innerHTML = `
      <span style="font-size:.75rem;color:#92400e;font-weight:600;">
        <i data-lucide="move" style="width:11px;height:11px;"></i> Unsaved changes
      </span>
      <button onclick="window._gaPostOrderSave('${albumId}')"
        style="${_btnStyle('#1a3a1a','#fff','#1a3a1a')}padding:.3rem .75rem;font-size:.75rem;">
        <i data-lucide="save" style="width:11px;height:11px;"></i> Save
      </button>
      <button onclick="window._gaPostOrderDiscard('${albumId}')"
        style="${_btnStyle('#fff','#6b7280','#d1d5db')}padding:.3rem .75rem;font-size:.75rem;">
        Discard
      </button>`;
    listEl.parentNode.insertBefore(bar, listEl);
    lucide.createIcons({ el: bar });
  }

  function _markDirty() {
    _isDirty = true;
    const bar = document.getElementById(barId);
    if (bar) bar.style.display = 'flex';
  }

  /* Store original order for discard */
  const _origIds = posts.map(p => p.dataset.postId);

  window._gaPostOrderSave = async function (aid) {
    const ids = [...listEl.querySelectorAll('._gaAlbumPost')].map(p => p.dataset.postId);
    try {
      await updateDoc(doc(db, 'barangays', BID, 'albums', aid), { postIds: ids });
      _showGaToast('Post order saved.');
      const bar = document.getElementById(`_gaPostOrderBar_${aid}`);
      if (bar) bar.style.display = 'none';
      _isDirty = false;
    } catch (err) { _showGaToast('Failed to save order.', 'error'); }
  };

  window._gaPostOrderDiscard = function (aid) {
    /* Re-append in original order */
    _origIds.forEach(id => {
      const card = listEl.querySelector(`[data-post-id="${id}"]`);
      if (card) listEl.appendChild(card);
    });
    const bar = document.getElementById(`_gaPostOrderBar_${aid}`);
    if (bar) bar.style.display = 'none';
    _isDirty = false;
    _showGaToast('Changes discarded.', 'error');
  };

  posts.forEach(post => {
    post.setAttribute('draggable', 'true');
    post.addEventListener('dragstart', e => {
      e.stopPropagation();
      _src = post; post.style.opacity = '.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    post.addEventListener('dragend', () => {
      post.style.opacity = '';
      posts.forEach(p => p.style.outline = '');
      _src = null;
    });
    post.addEventListener('dragover', e => {
      e.preventDefault(); e.stopPropagation();
      if (post !== _src) {
        posts.forEach(p => p.style.outline = '');
        post.style.outline = '2px solid var(--green-dark)';
      }
    });
    post.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      if (!_src || _src === post) return;
      post.style.outline = '';
      const ids   = [...listEl.querySelectorAll('._gaAlbumPost')].map(p => p.dataset.postId);
      const from  = ids.indexOf(_src.dataset.postId);
      const to    = ids.indexOf(post.dataset.postId);
      if (from === -1 || to === -1) return;
      post.parentNode.insertBefore(_src, to > from ? post.nextSibling : post);
      _markDirty();
    });
  });
}

/* Remove a post from an album — admin panel version */
window._gaRemovePostFromAlbum = async function (albumId, postId) {
  const ok = await showConfirm({
    title: 'Remove Post from Album?',
    body: 'The post stays in the gallery but will be removed from this album.',
    confirm: 'Remove', cancel: 'Go Back', variant: 'warning',
  });
  if (!ok) return;
  try {
    const { doc: _d, updateDoc, arrayRemove } =
      await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    await updateDoc(_d(db, 'barangays', BID, 'albums', albumId), {
      postIds: arrayRemove(postId),
    });
    _showGaToast('Post removed from album.', 'error');
  } catch (err) { _showGaToast('Failed. Try again.', 'error'); }
};

/* Drag reorder for the admin album list — saves albumOrder to Firestore */
function _wireAdminAlbumDrag(listEl) {
  if (!listEl) return;
  let _src = null;

  listEl.querySelectorAll('._gaAlbumRow').forEach(row => {
    row.setAttribute('draggable', 'true');
    row.addEventListener('dragstart', e => {
      /* If drag started from inside the expanded post list, let that handle it */
      if (e.target.closest(`#_gaAlbumPostList_${row.dataset.albumId}`)) return;
      _src = row; row.style.opacity = '.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      row.style.opacity = '';
      listEl.querySelectorAll('._gaAlbumRow').forEach(r => r.style.outline = '');
      _src = null;
    });
    row.addEventListener('dragover', e => {
      e.preventDefault();
      if (row !== _src) {
        listEl.querySelectorAll('._gaAlbumRow').forEach(r => r.style.outline = '');
        row.style.outline = '2px solid var(--green-dark)';
        row.style.outlineOffset = '2px';
      }
    });
    row.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation();
      if (!_src || _src === row) return;
      row.style.outline = '';
      const rows    = [...listEl.querySelectorAll('._gaAlbumRow')];
      const ids     = rows.map(r => r.dataset.albumId);
      const fromIdx = ids.indexOf(_src.dataset.albumId);
      const toIdx   = ids.indexOf(row.dataset.albumId);
      if (fromIdx === -1 || toIdx === -1) return;
      ids.splice(toIdx, 0, ids.splice(fromIdx, 1)[0]);
      row.parentNode.insertBefore(_src, toIdx > fromIdx ? row.nextSibling : row);
      try {
        const { doc: _d, setDoc: _set } =
          await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
        await _set(_d(db, 'barangays', BID, 'meta', 'gallery'),
          { albumOrder: ids }, { merge: true });
        _showGaToast('Album order saved.');
      } catch (err) { _showGaToast('Failed to save order.', 'error'); }
    });
  });
}

function _showGaToast(msg, type = 'success') {
  const c = document.getElementById('toastContainer');
  if (!c) return;
  const t = document.createElement('div');
  t.className   = `toast toast--${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}