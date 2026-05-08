/* ================================================
   bulletin.js — BarangayConnect
   Resident-facing Community Bulletin board.
   Renders official announcements and community posts
   in a unified, paginated feed with reactions,
   comments, image carousels, and moderation actions.

   WHAT IS IN HERE:
     · initBulletin — bootstrap, auth resolution, Firestore subscriptions
     · renderBulletin — combined feed sort, filter, pagination, DOM diffing
     · buildPostRow — full post article HTML including carousel, reactions,
       comments thread, author badge, and action buttons
     · buildReactionSummary — aggregates reaction counts into bubble + total
     · buildRoleBadge — renders role pill (Official / Admin / Officer / Resident)
     · loadReactionState — per-post like document lookup for current user
     · _applyReactUI — patches reaction button without full re-render
     · handleReaction / handleReactionToggle — Firestore like write / delete
     · Carousel helpers (carouselGoTo / carouselPrev / carouselNext)
     · Post actions: editCommunityPost, deleteCommunityPost,
       adminDeleteCommunityPost, reportPost, submitReport
     · Pagination (_bulletinPage) and category filter (_filterByCategory)
     · Skeleton loader and toast notification helpers
     · Global click-away listeners for pickers and action rows

   WHAT IS NOT IN HERE:
     · Admin create / edit / delete UI       → bulletin-admin.js
     · Comment rendering and threading       → comments.js
     · Community post submission form        → community-posts.js
     · Notification badge and dropdown       → notifications.js
     · Image lightbox injection              → image-viewer.js
     · Firebase config and db instance       → firebase-config.js
     · Firestore path helpers                → db-paths.js
     · Bulletin page markup and styles       → bulletin.html / bulletin.css

   REQUIRED IMPORTS:
     · ../../core/firebase-config.js          (db, auth — dynamic)
     · ../../core/db-paths.js                 (userIndexDoc, barangayId as toBid — dynamic)
     · ../../shared/comments.js                 (initComments, buildCommentThread,
                                      restoreOpenThreads)
     · ./community-posts.js          (initCommunityPosts, subscribeCommunityPosts,
                                      submitCommunityPost, getModerationSettings)
     · ../../shared/notifications.js            (initNotifications)
     · ../../shared/image-viewer.js             (openImageViewer as _openViewer,
                                      _injectImageViewer)
     · firebase-firestore.js@10.12.0 (collection, onSnapshot, query,
                                      where, orderBy — static;
                                      getDoc, doc, setDoc, deleteDoc,
                                      updateDoc, increment, addDoc,
                                      getDocs, serverTimestamp — dynamic)

   QUICK REFERENCE:
     Bootstrap            → export async function initBulletin()
     Feed render          → renderBulletin(listEl)
     Post HTML builder    → buildPostRow(post)
     Reaction write       → window.handleReaction(postId, type)
     Reaction toggle      → window.handleReactionToggle(postId)
     Carousel             → window.carouselGoTo / carouselPrev / carouselNext
     Pagination           → window._bulletinPage(dir)
     Category filter      → window._filterByCategory(category)
     Report post          → window.reportPost(postId, title)
     Submit report        → window.submitReport()
================================================ */


// ================================================
// IMPORTS
// ================================================

import { db } from '/js/core/firebase-config.js';

import {
  collection, onSnapshot, query, where, orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  initComments, buildCommentThread, restoreOpenThreads,
} from '../../shared/comments.js';

import {
  initCommunityPosts, subscribeCommunityPosts,
  submitCommunityPost, getModerationSettings,
} from './community-posts.js';

import { initNotifications }                            from '../../shared/notifications.js';
import { openImageViewer as _openViewer, _injectImageViewer } from '../../shared/image-viewer.js';

import { showConfirm } from '/js/shared/confirm-modal.js';


// ================================================
// MODULE STATE
// ================================================

let BARANGAY_ID        = null;
let _activeFilter      = 'all';
let _sourceFilter      = 'all';
let _allPosts          = [];
let _allCommunityPosts = [];
let _currentUid        = null;
let _currentUserName   = 'Resident';
let _currentUserRole   = 'resident';
const PAGE_SIZE        = 10;
let _currentPage       = 0;
let _sortMode          = 'newest'; // 'newest' | 'oldest' | 'popular' | 'commented'
let _scrollHandled     = false;


// ================================================
// REACTION STATE
// ================================================

const _reactLock     = new Set();
const _reactPrev     = new Map();
const _reactBaseline = new Map(); // postId → reactions counts captured before write
const _reactState    = new Map();

function _getOptimisticReactions(postId, post) {
  const base = _reactBaseline.has(postId)
    ? _reactBaseline.get(postId)
    : (post?.reactions ?? {});
  const reactions = { ...base };
  if (_reactPrev.has(postId)) {
    const prev = _reactPrev.get(postId);
    const cur  = _reactState.get(postId)?.type ?? null;
    if (prev)                reactions[prev] = Math.max(0, (reactions[prev] ?? 0) - 1);
    if (cur && cur !== prev) reactions[cur]  = (reactions[cur]  ?? 0) + 1;
  }
  return reactions;
}

// ================================================
// CONSTANTS — Emoji, Categories
// ================================================

const EMOJI = {
  heart: '❤️',
  laugh: '😂',
  wow:   '😮',
  sad:   '😢',
  like:  '👍',
};

const CATEGORY_MAP = {
  announcements:  { tagClass: 'tag--blue',   accentClass: 'post-row--blue',   label: 'Announcement'   },
  health:         { tagClass: 'tag--green',  accentClass: 'post-row--green',  label: 'Health'         },
  infrastructure: { tagClass: 'tag--amber',  accentClass: 'post-row--orange', label: 'Infrastructure' },
  safety:         { tagClass: 'tag--red',    accentClass: 'post-row--red',    label: 'Safety'         },
  events:         { tagClass: 'tag--purple', accentClass: 'post-row--purple', label: 'Events'         },
  general:        { tagClass: 'tag--teal',   accentClass: 'post-row--teal',   label: 'General'        },
};

const categoryMeta = cat => CATEGORY_MAP[cat] ?? CATEGORY_MAP.general;

/* Expose openImageViewer globally for inline onclick handlers */
/* Bulletin-aware viewer — injects live reaction UI into the accent bar */
window.bulletinOpenViewer = function(images, index, title, postId) {
  _openViewer(images, index, title);
  requestAnimationFrame(() => {
    const accent = document.querySelector('#imgViewerOverlay .img-viewer__accent');
    if (!accent || !postId) return;

    const post    = [..._allPosts, ..._allCommunityPosts].find(p => p.id === postId);
    const state   = _reactState.get(postId);
    const summary = post ? buildReactionSummary(post.reactions, post.likeCount) : { total: 0, html: '' };

    const EMOJI_MAP = { heart:'❤️', laugh:'😂', wow:'😮', sad:'😢', like:'👍' };

    /* ── Build react bubble HTML with user's react first ── */
    const _ents  = Object.entries(post?.reactions ?? {}).filter(([,v])=>v>0).sort(([,a],[,b])=>b-a);
    const _myType = state?.type ?? null;
    const _ord    = _myType
      ? [_myType, ..._ents.filter(([t])=>t!==_myType).map(([t])=>t)]
      : _ents.map(([t])=>t);
    const _top    = _ord.slice(0,3);
    const _total = _ents.reduce((s,[,v])=>s+v,0) || (post?.likeCount ?? 0);
    const _bubs  = _top.map((type,i)=>
      `<span class="reaction-bubble" style="z-index:${3-i};margin-left:${i===0?0:-6}px;">${EMOJI_MAP[type]}</span>`
    ).join('');
    const _countInner = _total > 0
      ? `<span style="display:inline-flex;align-items:center;gap:2px;">${_bubs}<span style="font-size:var(--text-xs);font-weight:600;margin-left:3px;">${_total}</span></span>`
      : _myType
      ? `<span style="font-size:var(--text-xs);font-weight:600;color:#fca5a5;">${EMOJI_MAP[_myType] ?? '❤️'} 1</span>`
      : `<span style="font-size:var(--text-xs);font-weight:600;">Like</span>`;

    /* ── Meta: category + date ── */
    const _meta = CATEGORY_MAP[post?.category] ?? CATEGORY_MAP.general;
    const _date = post?.createdAt?.toDate
      ? post.createdAt.toDate().toLocaleDateString('en-PH',{ month:'short', day:'numeric', year:'numeric' })
      : '';

    /* ── Layout wrapper: left info | right actions ── */
    const layout = document.createElement('div');
    layout.className = post?.body ? 'bv-layout' : 'bv-layout bv-layout--no-body';
    layout.innerHTML = `
      <div class="bv-info">
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-bottom:3px;">
          <span class="tag ${_meta.tagClass}"
            style="font-size:var(--text-2xs);padding:1px 7px;pointer-events:none;">
            ${esc(_meta.label)}
          </span>
          ${_date ? `<span style="font-size:var(--text-2xs);color:rgba(255,255,255,0.5);
            font-family:var(--font-display);">${_date}</span>` : ''}
        </div>
        <p class="bv-info__title">${esc(post?.title ?? '')}</p>
        ${post?.body ? `<p class="bv-info__body">${esc(post.body.slice(0,100))}${post.body.length>100?'…':''}</p>` : ''}
        <div style="display:flex;align-items:center;gap:4px;margin-top:2px;">
          <i data-lucide="user" style="width:10px;height:10px;color:rgba(255,255,255,0.45);flex-shrink:0;"></i>
          <span style="font-size:var(--text-2xs);color:rgba(255,255,255,0.45);font-family:var(--font-display);">
            ${esc(post?.authorName ?? 'BarangayConnect')}
          </span>
        </div>
      </div>
      <div class="bv-actions">
        <a class="bv-view-btn"
          href="community.html?scrollTo=${encodeURIComponent(postId)}&tab=bulletin"
          onclick="event.stopPropagation()" title="View original post">
          <i data-lucide="arrow-up-right"></i> View Post
        </a>
        <div style="position:relative;display:inline-flex;">
          <button id="_vreact-btn-${postId}" class="bv-react-btn"
            style="background:${state?'rgba(220,38,38,.18)':'var(--overlay-white-12)'};
              color:${state?'#fca5a5':'rgba(255,255,255,0.75)'};
              border-color:${state?'rgba(220,38,38,.3)':'rgba(255,255,255,0.18)'};"
            onmouseenter="document.getElementById('_vreact-picker-${postId}').style.display='flex'"
            onclick="handleReactionToggle('${postId}');setTimeout(()=>window._refreshViewerReact('${postId}'),1500)">
            <span id="_vreact-icon-${postId}"
              style="display:${state?'none':'inline-flex'};align-items:center;">
              <i data-lucide="heart" style="width:13px;height:13px;stroke-width:2;pointer-events:none;"></i>
            </span>
            <span id="_vreact-count-${postId}">${_countInner}</span>
          </button>
          <div id="_vreact-picker-${postId}" class="bv-picker" style="display:none;">
            ${Object.entries(EMOJI_MAP).map(([type,em])=>
              `<button data-type="${type}" data-mytype="${state?.type??''}" style="background:transparent;background-color:transparent;border:none;box-shadow:none;cursor:pointer;font-size:1.3rem;padding:3px 4px;border-radius:0;"
                onmouseenter="this.style.transform=(this.dataset.mytype===this.dataset.type?'scale(1.6) translateY(-3px)':'scale(1.2) translateY(-2px)')"
                onmouseleave="this.style.transform=(this.dataset.mytype===this.dataset.type?'scale(1.2)':'')"
                onclick="handleReaction('${postId}','${type}');document.getElementById('_vreact-picker-${postId}').style.display='none'">${em}</button>`
            ).join('')}
          </div>
        </div>
      </div>`;

    /* Hover timer for picker */
    const _bvPicker = layout.querySelector(`#_vreact-picker-${postId}`);
    const _bvBtn    = layout.querySelector(`#_vreact-btn-${postId}`);
    let _bvTimer;
    _bvBtn?.addEventListener('mouseleave', () => {
      _bvTimer = setTimeout(() => { if (_bvPicker) _bvPicker.style.display = 'none'; }, 300);
    });
    _bvPicker?.addEventListener('mouseenter', () => clearTimeout(_bvTimer));
    _bvPicker?.addEventListener('mouseleave', () => {
      _bvTimer = setTimeout(() => { if (_bvPicker) _bvPicker.style.display = 'none'; }, 200);
    });

    accent.appendChild(layout);
    lucide.createIcons({ el: layout });
  });
};

window._refreshViewerReact = function(postId) {
  const state   = _reactState.get(postId);
  const myType  = state?.type ?? null;
  const isReact = !!state;
  const post    = [..._allPosts, ..._allCommunityPosts].find(p => p.id === postId);
  const btn     = document.getElementById(`_vreact-btn-${postId}`);
  if (!btn) return;

  const _EMOJI = { heart:'❤️', laugh:'😂', wow:'😮', sad:'😢', like:'👍' };
  const _EORD  = ['heart','laugh','wow','sad','like'];

  const _raw = _getOptimisticReactions(postId, post);

  const _ents  = Object.entries(_raw).filter(([, v]) => v > 0)
    .sort(([ka, a], [kb, b]) => b - a || _EORD.indexOf(ka) - _EORD.indexOf(kb));
  const _total = _ents.reduce((s, [, v]) => s + v, 0) || (post?.likeCount ?? 0);

  /* Button chrome */
  btn.style.background  = isReact ? 'rgba(220,38,38,.18)' : 'var(--overlay-white-12)';
  btn.style.color       = isReact ? '#fca5a5'              : 'rgba(255,255,255,0.75)';
  btn.style.borderColor = isReact ? 'rgba(220,38,38,.3)'   : 'rgba(255,255,255,0.18)';

  /* Icon — hidden when reacted */
  const iconWrap = document.getElementById(`_vreact-icon-${postId}`);
  if (iconWrap) {
    iconWrap.style.display = isReact ? 'none' : 'inline-flex';
    if (!isReact) {
      iconWrap.innerHTML = '<i data-lucide="heart" style="width:13px;height:13px;stroke-width:2;color:rgba(255,255,255,0.75);pointer-events:none;"></i>';
      lucide.createIcons({ el: iconWrap });
    }
  }

  /* Count — rebuild from scratch */
  const count = document.getElementById(`_vreact-count-${postId}`);
  if (!count) return;

  if (!isReact) {
    /* No user reaction: top 3 by count desc, or plain "Like" */
    if (_total > 0) {
      const _bubs = _ents.slice(0, 3).map(([t], i) =>
        `<span style="font-size:.9rem;z-index:${3-i};margin-left:${i===0?0:-4}px;display:inline-block;">${_EMOJI[t]}</span>`
      ).join('');
      count.innerHTML = `<span style="display:inline-flex;align-items:center;gap:2px;">${_bubs}<span style="font-size:var(--text-xs);font-weight:600;margin-left:3px;">${_total}</span></span>`;
    } else {
      count.innerHTML = `<span style="font-size:var(--text-xs);font-weight:600;color:rgba(255,255,255,0.75);">Like</span>`;
    }
    return;
  }

  /* User reacted: myType always first, then top remaining by count */
  if (_total > 0) {
    const _others = _ents.filter(([t]) => t !== myType).map(([t]) => t);
    const _ord    = [myType, ..._others].slice(0, 3);
    const _bubs   = _ord.map((t, i) =>
      `<span style="font-size:.9rem;z-index:${3-i};margin-left:${i===0?0:-4}px;display:inline-block;">${_EMOJI[t]}</span>`
    ).join('');
    count.innerHTML = `<span style="display:inline-flex;align-items:center;gap:2px;">${_bubs}<span style="font-size:var(--text-xs);font-weight:600;color:#fca5a5;margin-left:3px;">${_total}</span></span>`;
  } else {
    /* Optimistic — Firestore count not yet reflected */
    count.innerHTML = `<span style="font-size:var(--text-xs);font-weight:600;color:#fca5a5;">${_EMOJI[myType]??'❤️'} 1</span>`;
  }
};

window.openImageViewer = _openViewer;


// ================================================
// UTILITIES
// ================================================

/* Returns a human-readable relative time string from a Firestore timestamp */
function relativeTime(ts) {
  if (!ts?.toDate) return '';
  const diff  = Date.now() - ts.toDate().getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins  <  1) return 'Just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days  <  2) return 'Yesterday';
  if (days  <  7) return `${days} days ago`;
  return ts.toDate().toLocaleDateString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

/* HTML-escapes a value for safe use in innerHTML interpolation */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

/* Removes the page param from the URL hash without a navigation event */
function _clearHashPage() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  params.delete('page');
  const newHash = params.toString();
  if (newHash) {
    window.location.hash = newHash;
  } else {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}


// ================================================
// BOOTSTRAP
// ================================================

/*
   Resolves the authenticated user's barangay and role, then:
     · Initialises comments, notifications, and community posts modules
     · Subscribes to community posts (live) and announcements (live)
     · Wires source segmented control and category filter pill listeners
*/

export async function initBulletin() {
  const listEl = document.getElementById('bulletinList');
  if (!listEl) return;

  renderSkeleton(listEl);
  _injectImageViewer();

  try {
    const { getDoc, doc: _docFn } =
      await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const { auth }                            = await import('../../core/firebase-config.js');
    const { userIndexDoc, barangayId: toBid } = await import('../../core/db-paths.js');

    await new Promise(resolve => {
      const unsub = auth.onAuthStateChanged(user => { unsub(); resolve(user); });
    }).then(async user => {
      if (!user) {
        listEl.innerHTML = `<p class="bulletin-empty-msg">Sign in to view announcements.</p>`;
        return;
      }

      _currentUid = user.uid;
      const snap  = await getDoc(userIndexDoc(user.uid));
      if (!snap.exists()) return;

      const data       = snap.data();
      BARANGAY_ID      = toBid(data.barangay);
      _currentUserRole = data.role || 'resident';

      /* Reveal admin-only UI elements for elevated roles */
      if (_currentUserRole === 'admin' || _currentUserRole === 'officer') {
        document.querySelectorAll('.admin-only-option').forEach(o => o.style.display = '');
      }

      try {
        const uSnap      = await getDoc(_docFn(db, 'barangays', BARANGAY_ID, 'users', user.uid));
        _currentUserName = uSnap.exists()
          ? (uSnap.data().fullName ?? user.displayName ?? 'Resident')
          : (user.displayName ?? 'Resident');
      } catch { _currentUserName = user.displayName ?? 'Resident'; }
    });

  } catch (err) {
    console.error('[bulletin] could not resolve barangay:', err);
    return;
  }

  if (!BARANGAY_ID) return;

  initComments(BARANGAY_ID, _currentUid, _currentUserName, _currentUserRole);
  /* initNotifications already called globally by nav-auth.js — skip here */
  initCommunityPosts(BARANGAY_ID, _currentUid, _currentUserName, _currentUserRole);

  /* Expose barangay and role for cross-module use */
  window._communityBid       = BARANGAY_ID;
  window._currentUserRole    = _currentUserRole;
  window._communityUid       = _currentUid;
  window._communityUserName  = _currentUserName;

  /* Eagerly load gallery module so window._addPostToAlbum is always available
     even if the user never visits the gallery tab. Fire-and-forget. */
  import('../gallery/gallery.js').then(({ initGallery }) => initGallery()).catch(() => {});

  /* Community posts live subscription */
  let _communityInitialLoad = true;

  subscribeCommunityPosts(posts => {
    const newIds    = posts.filter(p => !_allCommunityPosts.find(o => o.id === p.id)).map(p => p.id);
    const prevCount = _allCommunityPosts.length;
    _allCommunityPosts = posts;

    /* Reset page only on structural changes after initial load */
    if (!_communityInitialLoad && posts.length !== prevCount) _currentPage = 0;
    _communityInitialLoad = false;

    renderBulletin(listEl);
    if (newIds.length) loadReactionState(newIds);
  });

  /* Official announcements live subscription */
  const q = query(
    collection(db, 'barangays', BARANGAY_ID, 'announcements'),
    where('status', '==', 'published'),
    orderBy('isPinned',   'desc'),
    orderBy('createdAt', 'desc'),
  );

  const hashPage = parseInt(
    new URLSearchParams(window.location.hash.slice(1)).get('page'), 10,
  );
  if (!isNaN(hashPage) && hashPage > 0) _currentPage = hashPage;

  let _postsInitialLoad = true;

  onSnapshot(q, snap => {
    const newPosts  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const newIds    = newPosts.filter(p => !_allPosts.find(o => o.id === p.id)).map(p => p.id);
    const prevCount = _allPosts.length;
    _allPosts = newPosts;

    /* Reset page only on structural changes after initial load */
    if (!_postsInitialLoad && _allPosts.length !== prevCount) _currentPage = 0;
    _postsInitialLoad = false;

    renderBulletin(listEl);
    if (newIds.length) loadReactionState(newIds);
  });

  /* Source segmented control (All / Official / Community) */
  document.querySelectorAll('#tab-bulletin .bulletin-source-seg__btn:not(.bulletin-sort-seg__btn)').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-bulletin .bulletin-source-seg__btn:not(.bulletin-sort-seg__btn)')
        .forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      _sourceFilter = btn.dataset.source ?? 'all';
      _currentPage  = 0;
      _clearHashPage();
      renderBulletin(listEl);
    });
  });

  /* Sort sub-filter */
  document.querySelectorAll('#tab-bulletin .bulletin-sort-seg__btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-bulletin .bulletin-sort-seg__btn')
        .forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      _sortMode = btn.dataset.sort ?? 'newest';
      _currentPage = 0;
      _clearHashPage();
      renderBulletin(listEl);
    });
  });

  /* Category filter pills */
  document.querySelectorAll('#bulletinCategoryFilters .btn--filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#bulletinCategoryFilters .btn--filter')
        .forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      _activeFilter = btn.textContent.trim().toLowerCase() === 'all'
        ? 'all'
        : btn.textContent.trim().toLowerCase();
      _currentPage = 0;
      _clearHashPage();
      renderBulletin(listEl);
      loadReactionState([
        ..._allPosts.map(p => p.id),
        ..._allCommunityPosts.map(p => p.id),
      ]);
    });
  });
}


// ================================================
// RENDER — Feed
// ================================================

/*
   Merges official announcements and community posts, applies source and
   category filters, paginates the result, and either patches the existing
   DOM (same structure) or fully rebuilds it (structural change).
   Also manages the pagination nav element.
*/

function renderBulletin(listEl) {
  /* Close any open pickers before rebuilding */
  document.querySelectorAll('.reaction-picker.is-open').forEach(p => p.classList.remove('is-open'));

  const now = new Date();

  /* Merge and sort: pinned always first, then by _sortMode */
  const combined = [
    ..._allPosts.map(p => ({ ...p, _type: 'announcement' })),
    ..._allCommunityPosts,
  ].sort((a, b) => {
    if (a.isPinned && !b.isPinned) return -1;
    if (!a.isPinned && b.isPinned) return  1;

    if (_sortMode === 'oldest') {
      const ta = a.createdAt?.toDate?.() ?? new Date(0);
      const tb = b.createdAt?.toDate?.() ?? new Date(0);
      return ta - tb;
    }
    if (_sortMode === 'popular') {
      const ra = Object.values(a.reactions ?? {}).reduce((s, v) => s + v, 0) + (a.likeCount ?? 0);
      const rb = Object.values(b.reactions ?? {}).reduce((s, v) => s + v, 0) + (b.likeCount ?? 0);
      return rb - ra;
    }
    if (_sortMode === 'commented') {
      return (Number(b.commentCount) || 0) - (Number(a.commentCount) || 0);
    }
    /* default: newest */
    const ta = a.createdAt?.toDate?.() ?? new Date(0);
    const tb = b.createdAt?.toDate?.() ?? new Date(0);
    return tb - ta;
  });

  const filtered = (_activeFilter === 'all'
    ? combined
    : combined.filter(p => p.category === _activeFilter)
  ).filter(p => {
    if (_sourceFilter === 'official'  && p._type === 'post')         return false;
    if (_sourceFilter === 'community' && p._type !== 'post')         return false;
    return !p.expiresAt || p.expiresAt.toDate() > now;
  });

  if (!filtered.length) {
    listEl.innerHTML = `
      <div class="bulletin-empty">
        <p class="bulletin-empty__text">No posts for this category yet.</p>
      </div>`;
    document.getElementById('bulletinPaginationNav')?.remove();
    return;
  }

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  if (_currentPage >= totalPages) _currentPage = Math.max(0, totalPages - 1);

  const paginated = filtered.slice(
    _currentPage * PAGE_SIZE,
    (_currentPage + 1) * PAGE_SIZE,
  );

  /* Preserve carousel scroll positions across re-renders */
  const savedCarousel = new Map();
  listEl.querySelectorAll('[id^="carousel-track-"]').forEach(track => {
    const pid = track.id.replace('carousel-track-', '');
    const w   = track.offsetWidth;
    savedCarousel.set(pid, w > 0 ? Math.round(track.scrollLeft / w) : 0);
  });

  const existingIds   = [...listEl.querySelectorAll('article[data-post-id]')].map(a => a.dataset.postId);
  const newIds        = paginated.map(p => p.id);
  const sameStructure = existingIds.length === newIds.length && newIds.every((id, i) => id === existingIds[i]);

  if (sameStructure) {
    /* Patch only mutable fields to avoid unnecessary DOM churn */
    paginated.forEach(post => {
      const article = listEl.querySelector(`article[data-post-id="${post.id}"]`);
      if (!article) return;

      /* Patch comment count */
      const commentBtn = article.querySelector('.post-comment-btn');
      if (commentBtn) {
        commentBtn.childNodes[commentBtn.childNodes.length - 1].textContent = ` ${post.commentCount ?? 0}`;
      }

      /* Patch reaction summary (only when not in a reacted state) */
      const countSpan = document.getElementById(`like-count-${post.id}`);
      if (countSpan) {
        const myType  = _reactState.get(post.id)?.type ?? null;
        const summary = buildReactionSummary(_getOptimisticReactions(post.id, post), post.likeCount, myType);
        countSpan.innerHTML = summary.total > 0
          ? summary.html
          : `<span style="color:var(--gray-400);font-size:var(--text-xs);font-family:var(--font-display);font-weight:var(--fw-semibold);">Like</span>`;
      }

    /* Patch featured star button — including pending state */
      const canSeePending = _currentUserRole === 'admin' || _currentUserRole === 'officer';
      const starBtn = article.querySelector('.post-action-icon[onclick*="toggleFeatured"]');
      if (starBtn) {
        starBtn.classList.toggle('is-featured-active', !!post.isFeatured);
        starBtn.classList.toggle('is-pending-active', !!post.pendingFeatured && !post.isFeatured);
        starBtn.title = post.isFeatured
          ? 'Remove from Gallery'
          : (post.pendingFeatured ? 'Cancel Feature Request' : 'Add to Gallery');
        const starIcon = starBtn.querySelector('[data-lucide]');
        if (starIcon) {
          const newIcon = post.pendingFeatured && !post.isFeatured ? 'clock' : 'star';
          if (starIcon.getAttribute('data-lucide') !== newIcon) {
            starIcon.setAttribute('data-lucide', newIcon);
            lucide.createIcons({ el: starBtn });
          }
        }
      }

      /* Patch featured / pending badge */
      const existingBadge = article.querySelector('.post-featured-badge');
      if (post.isFeatured) {
        if (!existingBadge || existingBadge.classList.contains('post-featured-badge--pending')) {
          existingBadge?.remove();
          const tagsRow = article.querySelector('.post-row__tags');
          if (tagsRow) {
            const badge     = document.createElement('span');
            badge.className = 'post-featured-badge';
            badge.title     = post.featuredByName ? `Featured by ${post.featuredByName}` : 'Featured in Gallery';
            badge.innerHTML = `<i data-lucide="star" style="width:10px;height:10px;fill:var(--orange);color:var(--orange);pointer-events:none;"></i> Featured`;
            tagsRow.appendChild(badge);
            lucide.createIcons({ el: badge });
          }
        }
      } else if (post.pendingFeatured && canSeePending) {
        if (!existingBadge) {
          const tagsRow = article.querySelector('.post-row__tags');
          if (tagsRow) {
            const badge     = document.createElement('span');
            badge.className = 'post-featured-badge post-featured-badge--pending';
            badge.title     = 'Pending admin approval';
            badge.innerHTML = `<i data-lucide="clock" style="width:10px;height:10px;pointer-events:none;"></i> Pending`;
            tagsRow.appendChild(badge);
            lucide.createIcons({ el: badge });
          }
        }
      } else if (existingBadge) {
        existingBadge.remove();
      }
    });

    _reactState.forEach((state, postId) => { _applyReactUI(postId); });
    return;
  }

  /* Full rebuild */
  listEl.innerHTML = paginated.map(post => buildPostRow(post)).join('');
  lucide.createIcons({ el: listEl });

  savedCarousel.forEach((idx, pid) => { if (idx > 0) carouselGoTo(pid, idx); });
  _reactState.forEach((state, postId) => { if (state) _applyReactUI(postId); });

  /* Wire reaction picker close-on-mouseleave per post */
  listEl.querySelectorAll('.post-reaction-wrap').forEach(wrap => {
    const btn    = wrap.querySelector('[id^="like-btn-"]');
    const picker = wrap.querySelector('.reaction-picker');
    if (!btn || !picker) return;

    let closeTimer;
    btn.addEventListener(   'mouseleave',  () => { closeTimer = setTimeout(() => picker.classList.remove('is-open'), 300); });
    picker.addEventListener('mouseenter', ()  => clearTimeout(closeTimer));
    picker.addEventListener('mouseleave',  () => { closeTimer = setTimeout(() => picker.classList.remove('is-open'), 200); });
  });

  /* Pagination nav */
  document.getElementById('bulletinPaginationNav')?.remove();

  if (totalPages > 1) {
    const nav       = document.createElement('div');
    nav.id          = 'bulletinPaginationNav';
    nav.className   = 'bulletin-pagination';
    nav.innerHTML   = `
      <button class="btn btn--outline btn--sm" onclick="window._bulletinPage(-1)"
        ${_currentPage === 0 ? 'disabled' : ''}>← Prev</button>
      <span class="bulletin-pagination__label">Page ${_currentPage + 1} of ${totalPages}</span>
      <button class="btn btn--outline btn--sm" onclick="window._bulletinPage(1)"
        ${_currentPage >= totalPages - 1 ? 'disabled' : ''}>Next →</button>`;
    listEl.after(nav);
  }

  restoreOpenThreads();

    if (!_scrollHandled) {
    const _qp     = new URLSearchParams(window.location.search);
    const _scrollTo = _qp.get('scrollTo');
    const _tabParam = _qp.get('tab');

    // If the URL explicitly targets the polls tab, let community-polls.js handle it
    if (_scrollTo && _tabParam !== 'polls') {
      _scrollHandled = true;

      // Ensure the bulletin tab is active before we start looking
      const bulletinTabBtn = document.querySelector('[data-tab="bulletin"]');
      if (bulletinTabBtn) {
        const active =
          bulletinTabBtn.classList.contains('is-active') ||
          bulletinTabBtn.getAttribute('aria-selected') === 'true';
        if (!active) bulletinTabBtn.click();
      }

      let _attempts = 0;
      const _MAX    = 14;

      (function tryScroll() {
        const el =
          document.getElementById(`comment-thread-${_scrollTo}`)?.closest('article') ??
          document.getElementById(`opts_${_scrollTo}`)?.closest('.poll-card');

        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.style.transition = 'box-shadow .35s';
          el.style.boxShadow  = '0 0 0 3px #f97316, 0 0 0 7px rgba(249,115,22,.18)';
          setTimeout(() => { el.style.boxShadow = ''; }, 2200);
        } else if (_attempts++ < _MAX) {
          setTimeout(tryScroll, 250);
        } else {
          showToast('This post is no longer available.', 'error');
        }
      })();
    }
  }
}


// ================================================
// BUILD POST ROW
// ================================================

/* Aggregates reaction counts into emoji bubble HTML and a total */
function buildReactionSummary(reactions, fallbackCount, myType = null) {
  const EMOJI_ORDER = ['heart','laugh','wow','sad','like'];
  const entries = Object.entries(reactions ?? {})
    .filter(([, v]) => v > 0)
    .sort(([ka, a], [kb, b]) => b - a || EMOJI_ORDER.indexOf(ka) - EMOJI_ORDER.indexOf(kb));

  const total = entries.reduce((s, [, v]) => s + v, 0) || (fallbackCount ?? 0);
  if (!total) return { html: '', total: 0, topEmoji: null };

  const tip      = entries.map(([t, c]) => `${EMOJI[t]} ${c}`).join('  ');
  const topTypes = myType
    ? [myType, ...entries.filter(([t]) => t !== myType).map(([t]) => t)].slice(0, 3)
    : entries.slice(0, 3).map(([t]) => t);
  const bubbles  = topTypes.map((type, i) =>
    `<span style="z-index:${3 - i};margin-left:${i === 0 ? 0 : -4}px;display:inline-block;font-size:.9rem;">${EMOJI[type]}</span>`,
  ).join('');

  return {
    html:     `<span class="reaction-summary-wrap" title="${tip}">${bubbles}<span class="reaction-summary-count">${total}</span></span>`,
    total,
    topEmoji: topTypes[0] ?? null,
  };
}

/* Returns the appropriate role pill HTML for a post's author */
function buildRoleBadge(post, isCPost) {
  if (!isCPost) return `<span class="post-role-badge post-role-badge--official">✓ Official</span>`;
  const role = post.authorId === _currentUid ? _currentUserRole : (post.authorRole ?? 'resident');
  if (role === 'admin')   return `<span class="post-role-badge post-role-badge--admin">Admin</span>`;
  if (role === 'officer') return `<span class="post-role-badge post-role-badge--officer">Officer</span>`;
  return `<span class="post-role-badge post-role-badge--resident">Resident</span>`;
}

/* Constructs and returns the full HTML string for a single post article */
function buildPostRow(post) {
  const isCPost = post._type === 'post';
  const meta    = categoryMeta(post.category);
  const time    = relativeTime(post.createdAt);
  const excerpt = esc(post.body?.slice(0, 160) ?? '');
  const isLong  = (post.body?.length ?? 0) > 160;
  const pid     = esc(post.id);
  const ptitle  = esc(post.title ?? '');

  /* Image carousel */
  const images         = post.imageURLs?.length ? post.imageURLs : (post.imageURL ? [post.imageURL] : []);
  const imagesEncoded  = encodeURIComponent(JSON.stringify(images));

  const imageSection = images.length ? `
    <div class="post-carousel" id="carousel-${pid}">
      <div class="post-carousel__track" id="carousel-track-${pid}">
        ${images.map((url, i) => `
          <div class="post-carousel__slide"
            onclick="bulletinOpenViewer(JSON.parse(decodeURIComponent('${imagesEncoded}')), ${i}, '${ptitle}','${pid}')">
            <img src="${esc(url)}" alt="Post image ${i + 1}" loading="lazy" />
          </div>`).join('')}
      </div>
      ${images.length > 1 ? `
        <button class="post-carousel__nav post-carousel__nav--prev"
          onclick="event.stopPropagation();carouselGoTo('${pid}', carouselPrev('${pid}',${images.length}))"
          aria-label="Previous image">
          <i data-lucide="chevron-left"></i>
        </button>
        <button class="post-carousel__nav post-carousel__nav--next"
          onclick="event.stopPropagation();carouselGoTo('${pid}', carouselNext('${pid}',${images.length}))"
          aria-label="Next image">
          <i data-lucide="chevron-right"></i>
        </button>
        <div class="post-carousel__dots">
          ${images.map((_, i) => `
            <button class="post-carousel__dot${i === 0 ? ' is-active' : ''}"
              id="carousel-dot-${pid}-${i}"
              onclick="event.stopPropagation();carouselGoTo('${pid}',${i})"
              aria-label="Image ${i + 1}"></button>`).join('')}
        </div>` : ''}
    </div>` : '';

  /* Decorative status bars */
  const pinnedBar = post.isPinned
    ? `<div class="post-pin-bar"><i data-lucide="pin"></i> PINNED</div>`      : '';
  const urgentBar = post.isUrgent
    ? `<div class="post-urgent-bar"><i data-lucide="alert-circle"></i> URGENT</div>` : '';

  /* Reaction button state */
  const myState  = _reactState.get(post.id);
  const summary  = buildReactionSummary(_getOptimisticReactions(post.id, post), post.likeCount, _reactState.get(post.id)?.type ?? null);
  const btnEmoji = myState
    ? (EMOJI[myState.type] ?? '❤️')
    : (summary.topEmoji ? EMOJI[summary.topEmoji] : '🤍');
  const isReacted = !!myState;

  const pickerBtns = Object.entries(EMOJI).map(([type, em]) => `
    <button class="reaction-picker__btn"
      onclick="handleReaction('${pid}','${type}')" title="${type}">${em}</button>`,
  ).join('');

  /* Action buttons (··· menu) — visibility depends on role and ownership */
  const canAdminDel = isCPost && (
    _currentUserRole === 'admin' ||
    (_currentUserRole === 'officer' && post.authorRole !== 'admin')
  );
  const isOwn      = isCPost && post.authorId === _currentUid && _currentUserRole === 'resident';
  const isOther    = isCPost && post.authorId !== _currentUid;
  const canFeature = _currentUserRole === 'admin' || _currentUserRole === 'officer';

  const actionBtns = [
    canFeature && (post.imageURLs?.length || post.imageURL)  ? `<button class="post-action-icon${post.isFeatured ? ' is-featured-active' : (post.pendingFeatured ? ' is-pending-active' : '')}" onclick="toggleFeatured('${pid}','${isCPost ? 'communityPosts' : 'announcements'}')" title="${post.isFeatured ? 'Remove from Gallery' : (post.pendingFeatured ? 'Cancel Feature Request' : 'Add to Gallery')}"><i data-lucide="${post.pendingFeatured && !post.isFeatured ? 'clock' : 'star'}"></i></button>` : '',
    canFeature && (post.imageURLs?.length || post.imageURL) ? `<button class="post-action-icon" onclick="window._addPostToAlbum('${pid}','${isCPost ? 'communityPosts' : 'announcements'}',this)" title="Add to Album"><i data-lucide="folder-plus"></i></button>` : '',
    canAdminDel ? `<button class="post-action-icon post-action-icon--danger" onclick="adminDeleteCommunityPost('${pid}')" title="Delete"><i data-lucide="trash-2"></i></button>` : '',
    isOwn       ? `<button class="post-action-icon" onclick="editCommunityPost('${pid}')" title="Edit"><i data-lucide="pencil"></i></button>` : '',
    isOwn       ? `<button class="post-action-icon post-action-icon--danger" onclick="deleteCommunityPost('${pid}')" title="Delete"><i data-lucide="trash-2"></i></button>` : '',
    isOther     ? `<button class="post-action-icon post-action-icon--danger" onclick="reportPost('${pid}','${ptitle}')" title="Report"><i data-lucide="flag"></i></button>` : '',
  ].filter(Boolean).join('');

  const moreSection = actionBtns ? `
    <button class="post-more-btn" onclick="togglePostActions('${pid}')" title="More">···</button>
    <div class="post-action-row" id="post-actions-${pid}">${actionBtns}</div>` : '';

  const articleClass = [
    'post-row',
    isCPost
      ? `post-row--community post-row--accented ${meta.accentClass}`.trim()
      : `post-row--accented ${meta.accentClass}`.trim(),
  ].filter(Boolean).join(' ');

  return `
    <article class="${articleClass}"
      data-post-id="${pid}"
      data-parent-col="${isCPost ? 'communityPosts' : 'announcements'}">

      ${pinnedBar}
      ${urgentBar}

      <div class="post-row__tags">
        <span class="tag ${meta.tagClass}"
          onclick="window._filterByCategory('${esc(post.category)}')"
          style="cursor:pointer">${esc(meta.label)}</span>
        <span class="post-row__time">${time}</span>
        ${post.isEdited ? `<span class="post-edited-label">edited</span>` : ''}
        ${post.isFeatured
          ? `<span class="post-featured-badge"
              title="${post.featuredByName ? `Featured by ${esc(post.featuredByName)}` : 'Featured in Gallery'}">
              <i data-lucide="star" style="width:10px;height:10px;fill:var(--orange);color:var(--orange);pointer-events:none;"></i> Featured</span>`
          : (post.pendingFeatured && canFeature
            ? `<span class="post-featured-badge post-featured-badge--pending" title="Pending admin approval">
                <i data-lucide="clock" style="width:10px;height:10px;pointer-events:none;"></i> Pending</span>`
            : '')}
      </div>

      <h3 class="post-row__title">${esc(post.title)}</h3>

      ${imageSection}

      <p class="post-row__excerpt">${excerpt}${isLong ? `<span style="color:var(--gray-400)">…</span>` : ''}</p>

      <div class="post-row__footer">

        <div class="post-footer__left">
          <div class="post-author-avatar">
            ${esc((post.authorName ?? 'BC').slice(0, 2).toUpperCase())}
          </div>
          <div class="post-footer__name-wrap">
            <span class="post-row__author">${esc(post.authorName ?? 'BarangayConnect')}</span>
            ${buildRoleBadge(post, isCPost)}
          </div>
        </div>

        <div class="post-footer__right">

          <div class="post-reaction-wrap">
            <button class="post-react-btn${isReacted ? ' is-reacted' : ''}"
              id="like-btn-${pid}"
              onmouseenter="toggleReactionPicker('${pid}')"
              onclick="handleReactionToggle('${pid}')">
              <span id="like-icon-display-${pid}" ${isReacted ? 'style="display:none;"' : ''}>
                <i data-lucide="heart" style="width:15px;height:15px;stroke-width:2;color:var(--gray-400);pointer-events:none;"></i>
              </span>
              <span class="post-react-btn__count" id="like-count-${pid}">
                ${summary.total > 0
                  ? summary.html
                  : `<span style="color:var(--gray-400);font-size:var(--text-xs);font-family:var(--font-display);font-weight:var(--fw-semibold);">Like</span>`}
              </span>
            </button>
            <div class="reaction-picker" id="reaction-picker-${pid}">
              ${pickerBtns}
            </div>
          </div>

          <button class="post-comment-btn" onclick="toggleComments('${pid}')">
            <i data-lucide="message-circle"></i>
            ${post.commentCount ?? 0}
          </button>

          ${moreSection}

        </div>
      </div>

      ${buildCommentThread(post.id, isCPost ? 'communityPosts' : 'announcements')}
    </article>`;
}


// ================================================
// SKELETON LOADER
// ================================================

/* Renders three placeholder skeleton cards while data loads */
function renderSkeleton(listEl) {
  listEl.innerHTML = [1, 2, 3].map(() => `
    <article class="post-row post-row--accented" style="border-left-color:var(--gray-100);">
      <div class="post-row__tags">
        <span class="skeleton skeleton--tag"></span>
        <span class="skeleton skeleton--time"></span>
      </div>
      <div class="skeleton skeleton--title" style="margin-bottom:var(--space-sm);"></div>
      <div class="skeleton skeleton--body"  style="margin-bottom:4px;"></div>
      <div class="skeleton skeleton--body-sm"></div>
    </article>`).join('');
}


// ================================================
// REACTION STATE — Load / Apply
// ================================================

/*
   Fetches the current user's like document for each given post ID.
   Skips posts already tracked in _reactState.
*/

async function loadReactionState(postIds) {
  if (!_currentUid || !BARANGAY_ID || !postIds.length) return;

  postIds = postIds.filter(id => !_reactState.has(id));
  if (!postIds.length) return;

  const { getDoc, doc: _d } =
    await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

  await Promise.all(postIds.map(async postId => {
    try {
      const isCPost = !!_allCommunityPosts.find(p => p.id === postId);
      const col     = isCPost ? 'communityPosts' : 'announcements';
      const snap    = await getDoc(_d(db, 'barangays', BARANGAY_ID, col, postId, 'likes', _currentUid));
      _reactState.set(postId, snap.exists() ? { type: snap.data()?.type ?? 'heart' } : null);
      _applyReactUI(postId);
    } catch { /* non-fatal */ }
  }));
}

/* Patches the reaction button UI for a single post without rebuilding the DOM */
function _applyReactUI(postId) {
  const btn       = document.getElementById(`like-btn-${postId}`);
  const iconSpan  = document.getElementById(`like-icon-display-${postId}`);
  const countSpan = document.getElementById(`like-count-${postId}`);
  if (!btn) return;

  const state = _reactState.get(postId);
  btn.classList.toggle('is-reacted', !!state);

  const myType = state?.type ?? null;
  const _post  = [..._allPosts, ..._allCommunityPosts].find(p => p.id === postId);

  const _reactions = _getOptimisticReactions(postId, _post);
  const _s = _post ? buildReactionSummary(_reactions, _post.likeCount, myType) : { html: '', total: 0 };

  if (state) {
    if (iconSpan) iconSpan.style.display = 'none';
    if (countSpan) countSpan.innerHTML = _s.total > 0
      ? _s.html
      : `<span style="color:var(--red);font-size:var(--text-xs);font-family:var(--font-display);font-weight:var(--fw-semibold);">${EMOJI[myType] ?? '❤️'} 1</span>`;
  } else {
    if (iconSpan) {
      iconSpan.style.display = '';
      /* Re-inject SVG — lucide may have wiped innerHTML on a prior render */
      if (!iconSpan.querySelector('svg')) {
        iconSpan.innerHTML = '<i data-lucide="heart" style="width:15px;height:15px;stroke-width:2;color:var(--gray-400);pointer-events:none;"></i>';
        lucide.createIcons({ el: iconSpan });
      }
    }
    if (countSpan) countSpan.innerHTML = _s.total > 0
      ? _s.html
      : '<span style="color:var(--gray-400);font-size:var(--text-xs);font-family:var(--font-display);font-weight:var(--fw-semibold);">Like</span>';
  }

  /* Highlight already-picked emoji in the picker on hover */
  const picker = document.getElementById(`reaction-picker-${postId}`);
  if (picker) {
    picker.querySelectorAll('.reaction-picker__btn').forEach(btn => {
      const isActive = !!state && btn.getAttribute('title') === myType;
      btn.style.transform    = isActive ? 'scale(1.35) translateY(-2px)' : '';
      btn.style.background   = isActive ? 'rgba(220,38,38,0.12)' : '';
      btn.style.borderRadius = isActive ? 'var(--radius-sm)' : '';
    });
  }

  /* Sync viewer reaction bar if it's open for this post */
  if (window._refreshViewerReact && document.getElementById(`_vreact-btn-${postId}`)) {
    window._refreshViewerReact(postId);
  }
}


// ================================================
// REACTIONS — Handle
// ================================================

/* Toggles the user's existing reaction (same type = remove, else swap) */
window.handleReactionToggle = function (postId) {
  handleReaction(postId, (_reactState.get(postId)?.type) ?? 'heart');
};

/*
   Writes or removes a reaction for the current user.
   Uses an optimistic UI update via _reactState; confirms via getDoc on success.
   A per-post lock prevents concurrent writes.
*/
window.handleReaction = async function (postId, type) {
  if (!_currentUid || !BARANGAY_ID || _reactLock.has(postId)) return;
  _reactLock.add(postId);

  const btn    = document.getElementById(`like-btn-${postId}`);
  const picker = document.getElementById(`reaction-picker-${postId}`);
  if (btn)    btn.style.pointerEvents = 'none';
  if (picker) {
    picker.classList.remove('is-open');
    picker.querySelectorAll('button').forEach(b => b.disabled = true);
  }

  const prevState  = _reactState.get(postId) ?? null;
  const prevType   = prevState?.type ?? null;
  const isSameType = prevType === type;

  const _basePost = [..._allPosts, ..._allCommunityPosts].find(p => p.id === postId);
  _reactBaseline.set(postId, { ...(_basePost?.reactions ?? {}) });
  _reactPrev.set(postId, prevType);
  /* Optimistic — update UI instantly before Firestore write */
  _reactState.set(postId, isSameType ? null : { type });
  _applyReactUI(postId);

  try {
    const {
      doc: _d, setDoc, deleteDoc, updateDoc,
      increment, serverTimestamp: _ts, getDoc,
    } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

    const isCPost = !!_allCommunityPosts.find(p => p.id === postId);
    const col     = isCPost ? 'communityPosts' : 'announcements';
    const postRef = _d(db, 'barangays', BARANGAY_ID, col, postId);
    const likeRef = _d(db, 'barangays', BARANGAY_ID, col, postId, 'likes', _currentUid);

    if (isSameType) {
      /* Remove existing reaction */
      await deleteDoc(likeRef);
      await updateDoc(postRef, { [`reactions.${type}`]: increment(-1) });
      _reactState.set(postId, null);
    } else if (prevType) {
      /* Swap reaction type */
      await setDoc(likeRef, { type, userId: _currentUid, userName: _currentUserName, createdAt: _ts() }, { merge: true });
      await updateDoc(postRef, {
        [`reactions.${prevType}`]: increment(-1),
        [`reactions.${type}`]:    increment(1),
      });
      _reactState.set(postId, { type });
    } else {
      /* New reaction */
      await setDoc(likeRef, { type, userId: _currentUid, userName: _currentUserName, createdAt: _ts() }, { merge: true });
      await updateDoc(postRef, { [`reactions.${type}`]: increment(1) });
      _reactState.set(postId, { type });
    }

    /* Confirm final state from Firestore */
    const confirm = await getDoc(likeRef);
    _reactState.set(postId, confirm.exists() ? { type: confirm.data()?.type ?? type } : null);

  } catch (err) {
    console.error('[reaction]', err);
    _reactState.set(postId, prevState); // roll back on error
  } finally {
    _reactPrev.delete(postId);
    _reactBaseline.delete(postId);
    _applyReactUI(postId);
    _reactLock.delete(postId);
    const b = document.getElementById(`like-btn-${postId}`);
    const p = document.getElementById(`reaction-picker-${postId}`);
    if (b) b.style.pointerEvents = '';
    if (p) p.querySelectorAll('button').forEach(b => b.disabled = false);
  }
};


// ================================================
// CAROUSEL HELPERS
// ================================================

window.carouselGoTo = function (postId, index) {
  const track = document.getElementById(`carousel-track-${postId}`);
  if (!track) return;
  track.scrollLeft = track.offsetWidth * index;
  document.querySelectorAll(`[id^="carousel-dot-${postId}-"]`).forEach((dot, i) => {
    dot.classList.toggle('is-active', i === index);
  });
};

window.carouselPrev = function (postId, total) {
  const track   = document.getElementById(`carousel-track-${postId}`);
  if (!track) return 0;
  const current = track.offsetWidth > 0 ? Math.round(track.scrollLeft / track.offsetWidth) : 0;
  return (current - 1 + total) % total;
};

window.carouselNext = function (postId, total) {
  const track   = document.getElementById(`carousel-track-${postId}`);
  if (!track) return 0;
  const current = track.offsetWidth > 0 ? Math.round(track.scrollLeft / track.offsetWidth) : 0;
  return (current + 1) % total;
};


// ================================================
// POST ACTIONS — Toggle Menu / Click-Away
// ================================================

window.togglePostActions = function (postId) {
  const row = document.getElementById(`post-actions-${postId}`);
  if (!row) return;
  /* Close other open action rows first */
  document.querySelectorAll('.post-action-row.is-open').forEach(r => {
    if (r.id !== `post-actions-${postId}`) r.classList.remove('is-open');
  });
  row.classList.toggle('is-open');
};

/* Global click-away: closes action rows and reaction pickers */
document.addEventListener('click', e => {
  if (!e.target.closest('.post-more-btn') && !e.target.closest('.post-action-row')) {
    document.querySelectorAll('.post-action-row.is-open').forEach(r => r.classList.remove('is-open'));
  }
  if (!e.target.closest('.post-reaction-wrap')) {
    document.querySelectorAll('.reaction-picker').forEach(p => p.classList.remove('is-open'));
  }
});

window.toggleReactionPicker = function (postId) {
  const picker = document.getElementById(`reaction-picker-${postId}`);
  if (!picker) return;
  /* Close all other open pickers first */
  document.querySelectorAll('.reaction-picker').forEach(p => {
    if (p.id !== `reaction-picker-${postId}`) p.classList.remove('is-open');
  });
  picker.classList.add('is-open');
};


// ================================================
// POST ACTIONS — Edit / Delete / Report
// ================================================

/* Opens the community post modal pre-filled with the post's current data */
window.editCommunityPost = async function (postId) {
  const { getDoc: _gd, doc: _d } =
    await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

  const snap = await _gd(_d(db, 'barangays', BARANGAY_ID, 'communityPosts', postId));
  if (!snap.exists()) return;

  const data = snap.data();
  document.getElementById('newPostTitle').value    = data.title    ?? '';
  document.getElementById('newPostBody').value     = data.body     ?? '';
  document.getElementById('newPostCategory').value = data.category ?? 'general';
  document.getElementById('newPostCharCount').textContent = `${(data.body ?? '').length} / 500`;

  /* Hide image upload in edit mode */
  const imgSection = document.getElementById('newPostImages')?.closest('.form-group');
  if (imgSection) imgSection.style.display = 'none';
  const imgPreviews = document.getElementById('newPostImagePreviews');
  if (imgPreviews) imgPreviews.innerHTML = '';

  const btn = document.getElementById('newPostSubmitBtn');
  btn.dataset.editId = postId;
  btn.innerHTML = '<i data-lucide="save"></i> Update Post';
  lucide.createIcons({ el: btn });

  const settings = await getModerationSettings?.() ?? {};
  const banner   = document.getElementById('postWarningBanner');
  if (banner) {
    banner.textContent   = settings.postWarningText || '';
    banner.style.display = settings.postWarningText ? 'block' : 'none';
  }

  openModal('newPostModal');
};

/* Opens the report modal for a given post */
window.reportPost = function (postId, title) {
  const modal = document.getElementById('reportPostModal');
  if (!modal) return;
  modal.dataset.postId    = postId;
  modal.dataset.postTitle = title;
  openModal('reportPostModal');
};

/* Submits a report for the post currently identified in the report modal */
window.submitReport = async function () {
  if (!_currentUid || !BARANGAY_ID) return;

  /* Enforce daily report limit for non-admin users */
  try {
    const { getDoc: _gd, doc: _d, collection: _c, query: _q, where: _w, getDocs } =
      await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

    const settingsSnap = await _gd(_d(db, 'barangays', BARANGAY_ID, 'meta', 'settings'));
    const dailyLimit   = settingsSnap.exists() ? (settingsSnap.data().dailyReportLimit ?? 3) : 3;

    if (_currentUserRole !== 'admin' && _currentUserRole !== 'officer') {
      const today = new Date().toISOString().slice(0, 10);
      const start = new Date(today + 'T00:00:00');
      const end   = new Date(today + 'T23:59:59');
      const rSnap = await getDocs(
        _q(_c(db, 'barangays', BARANGAY_ID, 'reportedPosts'), _w('reportedBy', '==', _currentUid)),
      );
      const count = rSnap.docs.filter(d => {
        const t = d.data().createdAt?.toDate?.() ?? null;
        return t ? t >= start && t <= end : true;
      }).length;

      if (count >= dailyLimit) {
        alert(`You've reached the report limit of ${dailyLimit} per day.`);
        return;
      }
    }
  } catch { /* non-fatal — proceed with submission */ }

  const modal    = document.getElementById('reportPostModal');
  const postId   = modal?.dataset.postId;
  const title    = modal?.dataset.postTitle;
  const category = document.getElementById('reportCategory')?.value;
  const desc     = document.getElementById('reportDescription')?.value.trim() || '';
  if (!postId) return;

  /* Prevent duplicate reports from the same user */
  const { getDocs: _gs, collection: _c2, query: _q2, where: _w2 } =
    await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

  const existing = await _gs(_q2(
    _c2(db, 'barangays', BARANGAY_ID, 'reportedPosts'),
    _w2('reportedBy', '==', _currentUid),
    _w2('postId', '==', postId),
  ));
  if (!existing.empty) {
    closeModal('reportPostModal');
    showToast('You already reported this post.', 'error');
    return;
  }

  const submitBtn = modal.querySelector('.btn--red');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; }

  try {
    const { addDoc: _add, collection: _c3, serverTimestamp: _ts } =
      await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

    await _add(_c3(db, 'barangays', BARANGAY_ID, 'reportedPosts'), {
      postId,
      postTitle:       title,
      reportedBy:      _currentUid,
      reportedByName:  _currentUserName,
      category,
      reason:          desc || category,
      status:          'pending',
      createdAt:       _ts(),
    });

    closeModal('reportPostModal');
    showToast('Report submitted. Thank you.');
  } catch (err) {
    console.error('[report]', err);
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit Report'; }
  }
};

/* Deletes a community post as an admin or officer */
window.adminDeleteCommunityPost = async function (postId) {
  if (_currentUserRole !== 'admin' && _currentUserRole !== 'officer') return;
  const ok = await showConfirm({ title: 'Delete Post?', body: 'This community post will be permanently deleted.', confirm: 'Delete', cancel: 'Go Back', variant: 'danger' });
if (!ok) return;
  try {
    const { doc: _d, deleteDoc } =
      await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    await deleteDoc(_d(db, 'barangays', BARANGAY_ID, 'communityPosts', postId));
  } catch (err) { console.error('[admin delete]', err); }
};

/* Deletes the current user's own community post */
window.deleteCommunityPost = async function (postId) {
  if (!_currentUid || !BARANGAY_ID) return;
  const ok = await showConfirm({ title: 'Delete Post?', body: 'Your post will be permanently deleted.', confirm: 'Delete', cancel: 'Go Back', variant: 'danger' });
if (!ok) return;
  try {
    const { doc: _d, deleteDoc } =
      await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    await deleteDoc(_d(db, 'barangays', BARANGAY_ID, 'communityPosts', postId));
  } catch (err) { console.error('[delete post]', err); }
};

// ================================================
// FEATURED — Toggle Gallery Flag
// ================================================

/* Toggles isFeatured + featuredAt on a post for gallery curation.
   Works on both communityPosts and announcements collections. */
window.toggleFeatured = async function (postId, col) {
  if (_currentUserRole !== 'admin' && _currentUserRole !== 'officer') return;
  if (!_currentUid || !BARANGAY_ID) return;

  const post                = [..._allPosts, ..._allCommunityPosts].find(p => p.id === postId);
  const isCurrentlyFeatured = post?.isFeatured     ?? false;
  const isPending           = post?.pendingFeatured ?? false;

  const ok = await showConfirm({
    title:   isCurrentlyFeatured ? 'Remove from Gallery?'
           : isPending           ? 'Cancel Feature Request?'
           :                       'Add to Gallery?',
    body:    isCurrentlyFeatured
           ? 'This post will no longer appear in the Featured Gallery.'
           : isPending
           ? 'The pending feature request will be cancelled.'
           : 'This post will be highlighted in the Featured Gallery.',
    confirm: isCurrentlyFeatured ? 'Remove'
           : isPending           ? 'Cancel Request'
           :                       'Add to Gallery',
    cancel:  'Go Back',
    variant: isCurrentlyFeatured || isPending ? 'warning' : 'confirm',
  });
  if (!ok) return;

  try {
    const {
      doc: _d, updateDoc, serverTimestamp: _ts, deleteField,
      getDoc, getDocs, collection: _col, query: _q, where: _w,
    } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

    const postRef = _d(db, 'barangays', BARANGAY_ID, col, postId);

    /* ── Remove or cancel pending ── */
    if (isCurrentlyFeatured || isPending) {
      await updateDoc(postRef, {
        isFeatured:      false,
        pendingFeatured: deleteField(),
        featuredAt:      deleteField(),
        featuredBy:      deleteField(),
        featuredByName:  deleteField(),
        isHeroFeatured:  deleteField(),
      });

      /* Remove post from any albums it belongs to */
      try {
        const { getDocs, collection: _ac, query: _aq, where: _aw, arrayRemove: _arr } =
          await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
        const albumSnap = await getDocs(
          _aq(_ac(db, 'barangays', BARANGAY_ID, 'albums'), _aw('postIds', 'array-contains', postId))
        );
        await Promise.all(albumSnap.docs.map(a =>
          updateDoc(_d(db, 'barangays', BARANGAY_ID, 'albums', a.id), { postIds: _arr(postId) })
        ));
      } catch (_ae) { console.warn('[toggleFeatured] album cleanup failed:', _ae); }

      return;
    }

    /* ── Read settings (cap + approval flag) ── */
    const settingsSnap = await getDoc(_d(db, 'barangays', BARANGAY_ID, 'meta', 'settings'));
    const settings     = settingsSnap.exists() ? settingsSnap.data() : {};
    const cap          = Number(settings.featuredPostLimit ?? 20);

    /* ── Cap check: count featured posts across both collections ── */
    const [annoSnap, comSnap] = await Promise.all([
      getDocs(_q(_col(db, 'barangays', BARANGAY_ID, 'announcements'),   _w('isFeatured', '==', true))),
      getDocs(_q(_col(db, 'barangays', BARANGAY_ID, 'communityPosts'), _w('isFeatured', '==', true))),
    ]);
    if (annoSnap.size + comSnap.size >= cap) {
      showToast(`Gallery is full (${cap} posts max). Remove a featured post first.`, 'error');
      return;
    }

    /* ── Block posts without images — gallery is image-only ── */
    const postImages = post?.imageURLs?.length ? post.imageURLs
      : (post?.imageURL ? [post.imageURL] : []);

    if (!postImages.length) {
      showToast('Only posts with images can be added to the Gallery.', 'error');
      return;
    }

    /* ── Cover selection for multi-image posts ── */
    let coverIndex = 0;

    if (postImages.length > 1 && window.showCoverSelectModal) {
      const result = await window.showCoverSelectModal(post, col);
      if (!result.confirmed) return;
      coverIndex = result.coverIndex ?? 0;
    }

    /* ── Approval gate: officers submit for review if setting is on ── */
    const requireApproval = settings.requireApprovalToFeature ?? false;

    if (requireApproval && _currentUserRole === 'officer') {
      await updateDoc(postRef, {
        pendingFeatured:    true,
        featuredCoverIndex: coverIndex,
        featuredBy:         _currentUid,
        featuredByName:     _currentUserName,
      });
      showToast('Feature request submitted — awaiting admin approval.');
    } else {
      await updateDoc(postRef, {
        isFeatured:         true,
        featuredAt:         _ts(),
        featuredCoverIndex: coverIndex,
        featuredBy:         _currentUid,
        featuredByName:     _currentUserName,
      });
      showToast('Post added to the Featured Gallery!');
    }
  } catch (err) {
    console.error('[toggleFeatured]', err);
  }
};


// ================================================
// PAGINATION
// ================================================

window._bulletinPage = function (dir) {
  _currentPage += dir;

  const params = new URLSearchParams(window.location.hash.slice(1));
  if (_currentPage === 0) {
    _clearHashPage();
  } else {
    params.set('page', _currentPage);
    window.location.hash = params.toString();
  }

  renderBulletin(document.getElementById('bulletinList'));
  document.getElementById('bulletinList')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};


// ================================================
// CATEGORY FILTER
// ================================================

window._filterByCategory = function (category) {
  _activeFilter = category;
  _currentPage  = 0;
  _clearHashPage();
  document.querySelectorAll('#bulletinCategoryFilters .btn--filter').forEach(b => {
    b.classList.toggle('is-active', b.textContent.trim().toLowerCase() === category);
  });
  renderBulletin(document.getElementById('bulletinList'));
};


// ================================================
// TOAST
// ================================================

/* Appends a transient toast to #bulletinToastContainer; auto-removes after 3.5s */
function showToast(message, type = 'success') {
  let c = document.getElementById('bulletinToastContainer');
  if (!c) {
    c           = document.createElement('div');
    c.id        = 'bulletinToastContainer';
    c.className = 'toast-container';
    document.body.appendChild(c);
  }

  const t       = document.createElement('div');
  t.className   = `toast toast--${type}`;
  t.textContent = message;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}