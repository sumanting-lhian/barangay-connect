/* ================================================
   profile.js — BarangayConnect
   Profile page controller. Handles Firebase auth
   resolution, Firestore data subscriptions, and
   all page rendering for the resident profile view.

   DEMO FALLBACK LOGIC:
     · Opened via file://          → always demo (no Firebase access)
     · Auth resolves, no user      → redirect to login
     · Firebase error / 4s timeout → demo mode with banner
     · Logged-in active user       → full Firebase mode

   WHAT IS IN HERE:
     · Demo data constants (user, reports, docs, announcements)
     · Auth resolution with timeout fallback
     · Page init — hero, drawer, ID card, sign-out
     · Real-time reports subscription and renderer
     · Real-time document requests subscription and renderer
     · Real-time announcements subscription and renderer
     · Stat card updates
     · Demo mode banner
     · Shared utility functions (setEl, esc, fmtDate, relTime, etc.)

   WHAT IS NOT IN HERE:
     · ID card component rendering  → id-card.js (window.renderIDCard)
     · Weather widget logic         → weather.js
     · Navbar auth and role pill    → nav-auth.js
     · Firebase config              → firebase-config.js
     · Firestore path helpers       → db-paths.js

   REQUIRED IMPORTS:
     · ../../core/firebase-config.js          (auth, db)
     · ../../core/db-paths.js                 (userDoc, userIndexDoc, barangayId)
     · ../../shared/weather.js                  (loadWeather)
     · ../../shared/nav-auth.js                 (initNavAuth)
     · firebase-firestore.js@10.12.0 (getDoc, collection, query, where,
                                      orderBy, limit, onSnapshot)
     · firebase-auth.js@10.12.0      (onAuthStateChanged, signOut)
     · Lucide Icons                  — loaded before this script

   QUICK REFERENCE:
     Entry point       → IS_LOCAL check at module root
     Page hydration    → initPage(userData, isDemo)
     Reports           → subscribeReports(barangay, uid) / renderReports(reports)
     Documents         → subscribeDocuments(barangay, uid) / renderDocuments(docs)
     Announcements     → subscribeAnnouncements(barangay) / renderAnnouncements(items)
     Stat cards        → updateStatCards(reports, announcements)

   COLLECTIONS USED (all barangay-scoped):
     barangays/{bId}/reports          — where('uid','==',uid), status != 'resolved'
     barangays/{bId}/documentRequests — where('uid','==',uid)
     barangays/{bId}/announcements    — orderBy createdAt desc, limit 5
================================================ */


/* ================================================
   IMPORTS
================================================ */

import { auth, db } from '../../core/firebase-config.js';
import { userDoc, userIndexDoc, barangayId } from '../../core/db-paths.js';

import {
  getDoc,
  collection, query, where, orderBy, limit, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import { loadWeather }  from '../../shared/weather.js';
import { initNavAuth }  from '../../shared/nav-auth.js';


/* ================================================
   DEMO DATA
================================================ */

const DEMO_USER = {
  uid:              'demo-uid-000001',
  fullName:         'Juan dela Cruz',
  email:            'juan@gmail.com',
  phone:            '09171234567',
  dob:              '1990-05-12',
  province:         'Cavite',
  municipality:     'Indang',
  barangay:         'Bancod',
  yearsResident:    7,
  role:             'resident',
  createdAt:        new Date('2018-03-15'),
  residentIdNumber: 'BRY-BAN-2018-00001',
  validUntil:       new Date('2027-03-15'),
  photoURL:         null,
};

const DEMO_REPORTS = [
  { id: 'CON-2025-0498', category: 'Flooded Road', categoryColor: 'blue',  location: 'Rizal St. near Elem. School',   status: 'inprogress', createdAt: new Date('2025-06-01') },
  { id: 'CON-2025-0471', category: 'Garbage',       categoryColor: 'amber', location: 'Corner Bonifacio & Mabini St.', status: 'reviewing',  createdAt: new Date('2025-05-28') },
];

const DEMO_DOCS = [
  { id: 'REQ-2025-0412', name: 'Barangay Clearance',       status: 'ready',      requestedAt: new Date('2025-06-05'), downloadURL: null },
  { id: 'REQ-2025-0388', name: 'Certificate of Residency', status: 'processing', requestedAt: new Date('2025-06-03'), downloadURL: null },
  { id: 'REQ-2025-0341', name: 'Indigency Letter',          status: 'completed',  requestedAt: new Date('2025-05-22'), downloadURL: null },
];

const DEMO_ANNOUNCEMENTS = [
  { category: 'Safety',         color: 'red',    icon: 'alert-triangle', title: 'Weather Advisory: Signal No. 1 in effect', excerpt: 'Residents are advised to stay indoors. Monitor PAGASA for updates.', time: '2 hours ago'  },
  { category: 'Health',         color: 'red',    icon: 'heart-pulse',    title: 'Dengue Alert — Clear stagnant water NOW',   excerpt: 'Rising dengue cases reported. Fogging operations begin Tuesday.',   time: 'Yesterday'    },
  { category: 'Events',         color: 'green',  icon: 'calendar',       title: 'Free Medical Mission — June 12',            excerpt: 'Free check-ups, dental services, and medicine at Brgy. Hall.',      time: 'June 5, 2025' },
  { category: 'Infrastructure', color: 'orange', icon: 'hard-hat',       title: 'Rizal Street road repair begins Monday',    excerpt: 'Expect lane closures from 7AM–5PM. Use alternate routes.',          time: 'June 3, 2025' },
];


/* ================================================
   ENTRY POINT
   file:// always uses demo. Otherwise, auth is
   resolved with a 4-second fallback to demo mode.
================================================ */

const IS_LOCAL = window.location.protocol === 'file:';

if (IS_LOCAL) {
  initPage(DEMO_USER, true);
} else {
  let resolved = false;

  const fallbackTimer = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      console.info('[profile.js] Auth timeout — falling back to demo.');
      initPage(DEMO_USER, true);
    }
  }, 4000);

  onAuthStateChanged(auth, async (firebaseUser) => {
    if (resolved) return;
    clearTimeout(fallbackTimer);
    resolved = true;

    if (!firebaseUser) {
      window.location.href = '/index.html';;
      return;
    }

    try {
      const indexSnap = await getDoc(userIndexDoc(firebaseUser.uid));
      if (!indexSnap.exists()) {
        await signOut(auth);
        window.location.href = '/index.html';;
        return;
      }

      const { barangay, status, role } = indexSnap.data();

      if (status !== 'active') {
        await signOut(auth);
        window.location.href = '/index.html';;
        return;
      }

      const userSnap = await getDoc(userDoc(barangay, firebaseUser.uid));
      const userData = {
        uid: firebaseUser.uid,
        barangay,
        role,
        ...(userSnap.exists() ? userSnap.data() : {}),
      };

      initPage(userData, false);
      subscribeReports(barangay, firebaseUser.uid);
      subscribeDocuments(barangay, firebaseUser.uid);
      subscribeAnnouncements(barangay);

    } catch (err) {
      console.error('[profile.js] Load error:', err);
      initPage(DEMO_USER, true);
    }
  });
}


/* ================================================
   INIT PAGE
   Populates the hero, profile drawer, ID card,
   and sign-out button. In demo mode, also renders
   all section content from static demo data.
================================================ */

function initPage(userData, isDemo) {
  const role = userData.role || 'resident';

  /* Body role class controls navbar officer/admin link visibility */
  document.body.className = `role-${role}`;
  document.body.removeAttribute('data-role-init');

  /* ── Hero ── */
  const h        = new Date().getHours();
  const greeting = h < 12 ? 'Good Morning, ' : h < 18 ? 'Good Afternoon, ' : 'Good Evening, ';
  const heroGreetEl = document.getElementById('heroGreet');
  if (heroGreetEl) heroGreetEl.textContent = greeting;

  const firstName     = (userData.fullName || `${userData.firstName || ''}`).split(' ')[0] || 'Resident';
  const barangayLabel = [userData.barangay, userData.municipality, userData.province].filter(Boolean).join(', ');
  const sinceYear     = extractYear(userData.createdAt);
  const muniSuffix    = userData.municipality ? ', ' + esc(userData.municipality) : '';

  setEl('heroName',      esc(firstName) + '.');
  setEl('heroBarangay',  'Barangay ' + esc(barangayLabel));
  setEl('heroSince',     sinceYear);
  setEl('widgetLocation','Brgy. ' + esc(userData.barangay || '') + muniSuffix);
  loadWeather(userData.municipality, userData.province);

  /* ── Profile drawer ── */
  const displayName = userData.fullName
    || `${userData.firstName || ''} ${userData.lastName || ''}`.trim()
    || 'Guest';
  const initials = displayName.split(' ').slice(0, 2).map(n => n[0] || '').join('').toUpperCase() || '??';
  const idNumber = userData.residentIdNumber || '—';

  setEl('drawerAvatar',   esc(initials));
  setEl('drawerName',     esc(displayName));
  setEl('drawerRole',     esc(roleLabel(role)) + ' · Barangay ' + esc(userData.barangay || ''));
  setEl('drawerIdNumber', '<i data-lucide="id-card"></i> ' + esc(idNumber));

  const drawerEl = document.getElementById('profileDrawer');
  if (drawerEl) lucide.createIcons({ el: drawerEl });

  /* ── Digital ID card ── */
  if (typeof window.renderIDCard === 'function') {
    window.renderIDCard(userData, 'idCardContainer');
    window.renderIDCard(userData, 'idCardModalContainer');
  }

  /* ── Sign-out confirm ── */
  const confirmBtn = document.getElementById('confirmSignOutBtn');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      if (!IS_LOCAL) {
        try { await signOut(auth); } catch (_) {}
      }
      window.location.href = '/index.html';;
    });
  }

  /* ── Demo mode ── */
  if (isDemo) {
    s('weatherTemp', '32°');
    s('weatherDesc', 'Partly Cloudy');
    renderReports(DEMO_REPORTS);
    renderDocuments(DEMO_DOCS);
    renderAnnouncements(DEMO_ANNOUNCEMENTS);
    updateStatCards(DEMO_REPORTS, DEMO_ANNOUNCEMENTS);
    showDemoBanner();
  }
}


/* ================================================
   REPORTS — subscription and renderer
================================================ */

function subscribeReports(barangay, uid) {
  const bId = barangayId(barangay);

  const q = query(
    collection(db, 'barangays', bId, 'reports'),
    where('uid',    '==', uid),
    where('status', 'in', ['pending', 'reviewing', 'inprogress']),
    orderBy('createdAt', 'desc'),
    limit(10)
  );

  onSnapshot(q, (snap) => {
    const reports = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderReports(reports);
    updateStatCards(reports, null);
  }, (err) => {
    console.warn('[profile.js] Reports snapshot error:', err.message);
    renderReports(DEMO_REPORTS);
  });
}

function renderReports(reports) {
  const list  = document.getElementById('reportsList');
  const empty = document.getElementById('reportsEmpty');
  if (!list) return;

  if (!reports || reports.length === 0) {
    list.innerHTML = '';
    list.hidden    = true;
    if (empty) empty.hidden = false;
    return;
  }

  list.hidden = false;
  if (empty) empty.hidden = true;

  const STEP_KEYS   = ['pending', 'reviewing', 'inprogress', 'resolved'];
  const STEP_LABELS = ['Submitted', 'Under Review', 'In Progress', 'Resolved'];

  list.innerHTML = reports.map(r => {
    const statusIdx = Math.max(0, STEP_KEYS.indexOf(r.status ?? 'pending'));
    const dateStr   = fmtDate(r.createdAt);
    const color     = r.categoryColor || tagColorForCategory(r.category || '');

    const steps = STEP_LABELS.map((label, i) => {
      const isDone   = i < statusIdx;
      const isActive = i === statusIdx;
      return `<div class="step-progress__item${isDone ? ' is-done' : ''}${isActive ? ' is-active' : ''}">
        <div class="step-progress__circle">${isDone ? '<i data-lucide="check"></i>' : ''}</div>
        <span class="step-progress__label">${label}</span>
      </div>`;
    }).join('');

    return `<div class="report-item card">
      <div class="report-item__header">
        <span class="tag tag--${color}">${esc(r.category || 'Report')}</span>
        <span class="report-item__id">${esc(r.id)} · ${dateStr}</span>
      </div>
      ${r.location ? `<p class="report-item__location"><i data-lucide="map-pin"></i> ${esc(r.location)}</p>` : ''}
      <div class="step-progress report-item__progress">${steps}</div>
    </div>`;
  }).join('');

  lucide.createIcons({ el: list });
}


/* ================================================
   DOCUMENTS — subscription and renderer
================================================ */

function subscribeDocuments(barangay, uid) {
  const bId = barangayId(barangay);

  const q = query(
    collection(db, 'barangays', bId, 'documentRequests'),
    where('uid', '==', uid),
    orderBy('requestedAt', 'desc'),
    limit(10)
  );

  onSnapshot(q, (snap) => {
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderDocuments(docs);
  }, (err) => {
    console.warn('[profile.js] Documents snapshot error:', err.message);
    renderDocuments(DEMO_DOCS);
  });
}

function renderDocuments(docs) {
  const list = document.getElementById('docsList');
  if (!list) return;

  if (!docs || docs.length === 0) {
    list.innerHTML = `<p style="font-size:var(--text-sm);color:var(--gray-400);padding:var(--space-md) 0">No document requests yet.</p>`;
    return;
  }

  const CFG = {
    ready:      { badge: 'badge--resolved',       iconColor: 'green-muted',  label: 'Ready'      },
    processing: { badge: 'badge--doc-processing', iconColor: 'orange-muted', label: 'Processing' },
    completed:  { badge: 'badge--draft',           iconColor: 'gray',         label: 'Completed'  },
  };

  list.innerHTML = docs.map(d => {
    const cfg     = CFG[d.status] || CFG.processing;
    const dateStr = fmtDate(d.requestedAt, { month: 'short', day: 'numeric', year: 'numeric' });
    const dlBtn   = (d.status === 'ready' && d.downloadURL)
      ? `<a href="${esc(d.downloadURL)}" class="doc-download" target="_blank" rel="noopener">
           <i data-lucide="download"></i> Download
         </a>`
      : '';

    return `<div class="profile-doc-row">
      <div class="post-icon post-icon--${cfg.iconColor} post-icon--sm">
        <i data-lucide="file-text"></i>
      </div>
      <div class="profile-doc-row__body">
        <span class="profile-doc-row__name">${esc(d.name || d.type || 'Document')}</span>
        <span class="profile-doc-row__meta">${esc(d.id)} · ${dateStr}</span>
      </div>
      <div class="profile-doc-row__status">
        <span class="badge ${cfg.badge}">${cfg.label}</span>
        ${dlBtn}
      </div>
    </div>`;
  }).join('');

  lucide.createIcons({ el: list });
}


/* ================================================
   ANNOUNCEMENTS — subscription and renderer
================================================ */

function subscribeAnnouncements(barangay) {
  const bId = barangayId(barangay);

  const q = query(
    collection(db, 'barangays', bId, 'announcements'),
    orderBy('createdAt', 'desc'),
    limit(5)
  );

  onSnapshot(q, (snap) => {
    const announcements = snap.docs.map(d => {
      const data = d.data();
      const ts   = data.createdAt?.toDate?.() ?? (data.createdAt ? new Date(data.createdAt) : null);
      return { ...data, id: d.id, time: ts ? relTime(ts) : '' };
    });
    renderAnnouncements(announcements);
    updateStatCards(null, announcements);
  }, (err) => {
    console.warn('[profile.js] Announcements snapshot error:', err.message);
    renderAnnouncements(DEMO_ANNOUNCEMENTS);
  });
}

function renderAnnouncements(announcements) {
  const list = document.getElementById('announcementList');
  if (!list) return;

  if (!announcements || announcements.length === 0) {
    list.innerHTML = `<p style="font-size:var(--text-sm);color:var(--gray-400);padding:var(--space-md) 0">No announcements yet.</p>`;
    return;
  }

  const COLOR_MAP = {
    Safety:         { color: 'red',    icon: 'alert-triangle' },
    Health:         { color: 'red',    icon: 'heart-pulse'    },
    Events:         { color: 'green',  icon: 'calendar'       },
    Infrastructure: { color: 'orange', icon: 'hard-hat'       },
    General:        { color: 'blue',   icon: 'info'           },
  };

  list.innerHTML = announcements.map(a => {
    const cfg       = COLOR_MAP[a.category] || { color: 'blue', icon: 'megaphone' };
    const color     = a.color || cfg.color;
    const icon      = a.icon  || cfg.icon;
    const accentMod = color === 'orange' ? 'post-row--orange' : `post-row--${color}`;
    const tagColor  = color === 'orange' ? 'amber' : color;

    return `<div class="post-row post-row--accented ${accentMod}">
      <div class="post-row__tags">
        <span class="tag tag--${tagColor}"><i data-lucide="${icon}"></i> ${esc(a.category || 'General')}</span>
        <span class="post-row__time">${esc(a.time || '')}</span>
      </div>
      <h3 class="post-row__title">${esc(a.title || '')}</h3>
      ${a.excerpt ? `<p class="post-row__excerpt">${esc(a.excerpt)}</p>` : ''}
    </div>`;
  }).join('');

  lucide.createIcons({ el: list });
}


/* ================================================
   STAT CARDS
   Accepts null for either argument to update only
   the relevant card without touching the other.
================================================ */

function updateStatCards(reports, announcements) {
  if (reports !== null) {
    const active     = reports.length;
    const reviewing  = reports.filter(r => r.status === 'reviewing').length;
    const inprogress = reports.filter(r => r.status === 'inprogress').length;
    const parts      = [];
    if (reviewing  > 0) parts.push(`${reviewing} under review`);
    if (inprogress > 0) parts.push(`${inprogress} in progress`);

    setEl('statReports',    active);
    setEl('statReportsSub', parts.join(' · ') || 'All submitted');
  }

  if (announcements !== null) {
    const urgent = announcements.filter(a =>
      a.color === 'red' || a.category === 'Safety' || a.category === 'Health'
    ).length;

    setEl('statAnnouncements',    announcements.length);
    setEl('statAnnouncementsSub', urgent > 0 ? `${urgent} marked urgent` : 'No urgent announcements');
  }
}


/* ================================================
   DEMO BANNER
   Fixed pill shown when the page runs in demo mode.
================================================ */

function showDemoBanner() {
  const banner = document.createElement('div');
  banner.style.cssText = [
    'position:fixed', 'bottom:20px', 'left:50%', 'transform:translateX(-50%)',
    'background:#1a1a1a', 'color:#fff', 'padding:8px 20px',
    'border-radius:999px', 'font-size:13px', 'font-family:var(--font-body)',
    'z-index:9999', 'box-shadow:0 4px 20px rgba(0,0,0,.3)',
    'opacity:.88', 'pointer-events:none', 'white-space:nowrap',
  ].join(';');
  banner.textContent = 'Demo mode — open via a server to connect to Firebase';
  document.body.appendChild(banner);
}


/* ================================================
   UTILITIES
================================================ */

/* Sets innerHTML of an element by id */
function setEl(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = String(html);
}

/* Sets textContent of an element by id */
function s(id, v) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(v);
}

/* Escapes a value for safe inline HTML use */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* Maps a role key to its display label */
function roleLabel(role) {
  return { resident: 'Resident', officer: 'Barangay Officer', admin: 'Admin' }[role] || 'Resident';
}

/* Maps a report category name to its tag color token */
function tagColorForCategory(cat) {
  return {
    'Flooded Road': 'blue',
    Garbage:        'amber',
    Noise:          'amber',
    Fire:           'red',
    Safety:         'red',
    Health:         'red',
  }[cat] || 'blue';
}

/* Extracts the year from a Firestore timestamp or Date */
function extractYear(ts) {
  if (!ts) return '—';
  const d = ts?.toDate?.() ?? new Date(ts);
  return isNaN(d) ? '—' : d.getFullYear();
}

/* Formats a Firestore timestamp or Date to a locale date string */
function fmtDate(ts, opts = { year: 'numeric', month: 'short', day: 'numeric' }) {
  if (!ts) return '—';
  const d = ts?.toDate?.() ?? new Date(ts);
  return isNaN(d) ? '—' : d.toLocaleDateString('en-PH', opts);
}

/* Formats a Date into a human-readable relative time string */
function relTime(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins <  1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs  < 24) return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });
}