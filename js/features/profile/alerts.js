/* ================================================
   alerts.js — BarangayConnect
   Shared alert banner system. Attach to every page via:
     <script type="module" src="js/features/profile/alerts.js"></script>
     (adjust path depth as needed — "../../js/features/profile/alerts.js" etc.)

   WHAT IS IN HERE:
     · USGS Earthquake API polling (Philippines bbox, mag ≥ 4.5, every 5 min)
     · Firestore real-time listener for admin-created siteAlerts
     · Curfew schedule listener with age-based filtering
     · Banner stack DOM injection and per-banner render/remove helpers
     · Session-persistent dismiss state (localStorage)
     · Alert sound playback mapped by severity
     · createTestAlert — dev/console helper for writing a test alert

   WHAT IS NOT IN HERE:
     · Admin create / toggle / delete UI     → alerts-admin.js
     · Firebase config and db instance       → firebase-config.js
     · Firestore path helpers                → db-paths.js
     · Global alert banner styles            → frames.css (or equivalent)

   REQUIRED IMPORTS:
     · ../../core/firebase-config.js          (auth, db)
     · ../../core/db-paths.js                 (userIndexDoc, barangayId as toBid, userDoc)
     · firebase-firestore.js@10.12.0 (collection, query, where, onSnapshot,
                                      getDoc, addDoc, Timestamp)
     · firebase-auth.js@10.12.0      (onAuthStateChanged)

   QUICK REFERENCE:
     Bootstrap              → onAuthStateChanged (top-level, runs on load)
     Firestore listener     → listenAlerts(barangay)
     Curfew listener        → listenCurfews(barangay, userDob)
     USGS poller            → pollUsgs()
     Banner render/remove   → renderBanner(id, opts) / removeBanner(id)
     Dev helper             → window.createTestAlert(barangayName?)
================================================ */


// ================================================
// IMPORTS
// ================================================

import { auth, db }                                   from '../../core/firebase-config.js';
import { userIndexDoc, barangayId as toBid, userDoc } from '../../core/db-paths.js';

import {
  collection, query, where, onSnapshot,
  getDoc, addDoc, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";


// ================================================
// CONSTANTS — Polling and Lookback
// ================================================

const USGS_POLL_MS  = 5 * 60 * 1000;      // re-poll every 5 minutes
const USGS_LOOKBACK = 6 * 60 * 60 * 1000; // ignore quakes older than 6 hours
const STORAGE_KEY   = 'bc_dismissed_alerts';


// ================================================
// CONSTANTS — Alert Sounds
// ================================================

/*
   Add audio files to assets/sounds/ and map them by severity key.
   Adjust path depth if alerts.js is consumed by pages in subdirectories
   (e.g. '../assets/sounds/...' for pages one level deep).
*/

const ALERT_SOUNDS = {
  red:    new Audio('/assets/sounds/alert-red.mp3'),
  orange: new Audio('/assets/sounds/alert-orange.mp3'),
  green:  new Audio('/assets/sounds/alert-green.mp3'),
  blue:   new Audio('/assets/sounds/alert-blue.mp3'),
};

/* Preload so there is no delay on first playback */
Object.values(ALERT_SOUNDS).forEach(a => { a.preload = 'auto'; });


// ================================================
// CONSTANTS — Severity Map
// ================================================

/* Maps severity keys to CSS modifier class and Lucide icon name */
const SEVERITY_MAP = {
  red:    { cls: 'alert-banner--red',    icon: 'siren'          },
  orange: { cls: 'alert-banner--orange', icon: 'triangle-alert' },
  green:  { cls: 'alert-banner--green',  icon: 'circle-check'   },
  blue:   { cls: 'alert-banner--blue',   icon: 'info'           },
};


// ================================================
// MODULE STATE
// ================================================

let _unsubFirestore = null; // onSnapshot unsubscribe handle for siteAlerts
let _curfewTimer    = null; // setInterval handle for per-minute curfew checks
let _lastUsgsId     = localStorage.getItem('bc_usgs_last') || null; // dedup last USGS event


// ================================================
// SOUND PLAYBACK
// ================================================

/*
   Plays the sound mapped to the given severity key.
   Browsers block autoplay until the user has interacted with the page —
   if playback is rejected the banner still renders; failure is silent.
*/

function playAlertSound(severity) {
  const audio = ALERT_SOUNDS[severity];
  if (!audio) return;

  audio.currentTime = 0; // rewind so repeated alerts replay from the start
  audio.play().catch(() => {});
}


// ================================================
// DISMISS STATE — localStorage
// ================================================

/*
   Dismissed alert IDs are persisted in localStorage so they survive
   page navigation within the same browser session.
*/

function getDismissed() {
  try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')); }
  catch { return new Set(); }
}

function saveDismissed(id) {
  const s = getDismissed();
  s.add(id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...s]));
}


// ================================================
// BANNER STACK — DOM Container
// ================================================

/*
   Injects the sticky banner stack container once, positioned immediately
   after the navbar (or prepended to body as a fallback).
   Subsequent calls return the existing element.
*/

function getStack() {
  let el = document.getElementById('js-alert-stack');
  if (!el) {
    el = document.createElement('div');
    el.id = 'js-alert-stack';
    el.style.cssText = `
      position: fixed;
      top: var(--navbar-h);
      z-index: 399;
      width: 100%;
      left: 0;
    `;

    const navbar = document.querySelector('.navbar');
    if (navbar) {
      navbar.insertAdjacentElement('afterend', el);
    } else {
      document.body.prepend(el);
    }
  }
  return el;
}


// ================================================
// BANNER — Render / Remove
// ================================================

/* Renders a single alert banner into the stack; skips if already dismissed or present */
function renderBanner(id, { severity = 'blue', title, message, dismissible = true }) {
  if (getDismissed().has(id))               return;
  if (document.getElementById(`jsa-${id}`)) return;

  const { cls, icon } = SEVERITY_MAP[severity] ?? SEVERITY_MAP.blue;

  const div = document.createElement('div');
  div.id        = `jsa-${id}`;
  div.className = `alert-banner ${cls}`;
  div.setAttribute('role', 'alert');
  div.innerHTML = `
    <i data-lucide="${icon}"></i>
    <p><strong>${esc(title)}:</strong> ${esc(message)}</p>
    ${dismissible
      ? `<button class="btn btn--close btn--sm" aria-label="Dismiss alert">
           <i data-lucide="x"></i>
         </button>`
      : ''}
  `;

  if (dismissible) {
    div.querySelector('button').addEventListener('click', () => {
      saveDismissed(id);
      div.remove();
    });
  }

  getStack().prepend(div);
  if (window.lucide) lucide.createIcons({ el: div });

  playAlertSound(severity);
}

/* Removes a banner from the DOM by its logical ID */
function removeBanner(id) {
  document.getElementById(`jsa-${id}`)?.remove();
}


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


// ================================================
// FIRESTORE LISTENER — siteAlerts
// ================================================

/*
   Opens a real-time onSnapshot listener scoped to the user's barangay.
   Instantly reflects admin create / edit / deactivate actions across all
   open tabs. Re-subscribing replaces the previous listener.
*/

function listenAlerts(barangay) {
  if (_unsubFirestore) { _unsubFirestore(); }

  const col = collection(db, 'barangays', toBid(barangay), 'siteAlerts');
  const q   = query(col, where('active', '==', true));

  _unsubFirestore = onSnapshot(q, (snap) => {
    const now       = new Date();
    const activeIds = new Set();

    snap.forEach(docSnap => {
      const d = docSnap.data();

      /* Treat as inactive if a hard expiry has passed */
      if (d.expiresAt && d.expiresAt.toDate() < now) return;

      activeIds.add(docSnap.id);
      renderBanner(docSnap.id, d);
    });

    /* Remove banners for alerts deleted or deactivated in Firestore */
    document.querySelectorAll('[id^="jsa-"]').forEach(el => {
      const rawId = el.id.slice(4); // strip "jsa-" prefix
      if (rawId.startsWith('usgs-')) return; // USGS banners are managed separately
      if (!activeIds.has(rawId)) el.remove();
    });
  });
}


// ================================================
// FIRESTORE LISTENER — Curfew Schedules
// ================================================

/*
   Subscribes to active curfew schedules and re-evaluates every minute.
   Supports weekly, once, and manual schedule types with overnight windows.
   Optionally filters by the resident's age when affects targets a subset.
*/

function listenCurfews(barangay, userDob = null) {
  const col = collection(db, 'barangays', toBid(barangay), 'curfewSchedules');
  const q   = query(col, where('active', '==', true));

  /* Derives the resident's current age from an ISO date string (YYYY-MM-DD) */
  function getUserAge() {
    if (!userDob) return null;
    const today = new Date(), birth = new Date(userDob + 'T00:00:00');
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return age;
  }

  onSnapshot(q, (snap) => {
    if (_curfewTimer) clearInterval(_curfewTimer);
    const schedules = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    function check() {
      const now     = new Date();
      const today   = now.toISOString().slice(0, 10);
      const hhmm    = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()];
      //console.log('[curfew check]', { hhmm, dayName, schedules });

      let active = null;

      for (const s of schedules) {
        if (s.type === 'weekly') {
          if (!(s.days || []).includes(dayName))    continue;
          if ((s.exceptions || []).includes(today)) continue;
        } else if (s.type === 'once') {
          if (s.date !== today) continue;
        } else {
          /* manual — already filtered by active:true, so always show */
          active = s;
          break;
        }

        /* Handles overnight windows (e.g. 22:00 – 05:00) */
        const crosses  = s.endTime < s.startTime;
        const inWindow = crosses
          ? (hhmm >= s.startTime || hhmm < s.endTime)
          : (hhmm >= s.startTime && hhmm < s.endTime);

        if (inWindow) { active = s; break; }
      }

      if (active) {
        const age = getUserAge();

        /* Determine whether this curfew applies to the current resident */
        const shouldSkip = (() => {
          if (!age) return false;
          if (active.affects === 'Minors Only' && age >= 18) return true;
          if (active.affects?.startsWith('Ages ')) {
            const parts = active.affects.replace('Ages ', '').split('-');
            const min = Number(parts[0]), max = Number(parts[1]);
            if (age < min || age > max) return true;
          }
          return false;
        })();

        if (shouldSkip) {
          removeBanner('curfew-active');
        } else {
          removeBanner('curfew-active');
          renderBanner('curfew-active', {
            severity:    'orange',
            title:       `Curfew in effect — ${active.name}`,
            message:     `${active.startTime} – ${active.endTime}. ${
              active.affects?.toLowerCase() === 'minors only'
                ? 'Minors must be accompanied by a guardian.'
                : 'All residents must observe curfew hours.'
            }`,
            dismissible: false,
          });
        }
      } else {
        removeBanner('curfew-active');
      }
    }

    check();
    _curfewTimer = setInterval(check, 60_000); // re-evaluate every minute
  });
}


// ================================================
// USGS EARTHQUAKE POLLING
// ================================================

/*
   Polls the USGS FDSN Event API on a 5-minute interval.
   Scoped to the Philippines bounding box (lat 5.5–21.5, lon 115–127), mag ≥ 4.5.
   Deduplicates against the last seen event ID stored in localStorage.
   Renders locally only — does not write to Firestore.

   Optional extension: OpenWeatherMap weather alerts via the One Call API
   (https://api.openweathermap.org/data/3.0/onecall). Add 'alerts' to the
   exclude param, parse res.alerts[], and call renderBanner for each entry.
   Requires a free API key from openweathermap.org.
*/

async function pollUsgs() {
  const since = new Date(Date.now() - USGS_LOOKBACK).toISOString().slice(0, 19);
  const url   =
    'https://earthquake.usgs.gov/fdsnws/event/1/query' +
    '?format=geojson&minmagnitude=4.5' +
    '&minlatitude=5.5&maxlatitude=21.5' +
    '&minlongitude=115&maxlongitude=127' +
    `&starttime=${since}&orderby=time&limit=1`;

  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return;

    const json = await res.json();
    if (!json.features?.length) return;

    const { id, properties: p } = json.features[0];

    if (id === _lastUsgsId) return; // same event as last poll — skip
    _lastUsgsId = id;
    localStorage.setItem('bc_usgs_last', id);

    const mag   = Number(p.mag ?? 0).toFixed(1);
    const place = p.place || 'near the Philippines';
    const time  = new Date(p.time).toLocaleTimeString('en-PH', {
      hour: '2-digit', minute: '2-digit',
    });

    renderBanner(`usgs-${id}`, {
      severity:    parseFloat(mag) >= 6.0 ? 'red' : 'orange',
      title:       `Earthquake M${mag}`,
      message:     `${place} at ${time}. Stay calm and follow PHIVOLCS advisories.`,
      dismissible: true,
    });

  } catch {
    /* Network error — fail silently, never break the page */
  }
}


// ================================================
// DEV HELPER — Test Alert (Admin Console Only)
// ================================================

/*
   Writes a temporary test alert to Firestore for the given barangay.
   Usage from the browser console: createTestAlert()
*/

window.createTestAlert = async function (barangayName = 'Bancod') {
  const bid = toBid(barangayName);
  const col = collection(db, 'barangays', bid, 'siteAlerts');
  const ref = await addDoc(col, {
    type:        'test',
    severity:    'orange',
    title:       'TEST ALERT — Admin Drill',
    message:     'This is a test. Dismiss it and reload — it should stay dismissed.',
    source:      'admin',
    active:      true,
    dismissible: true,
    expiresAt:   Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
    createdAt:   Timestamp.now(),
    createdBy:   'admin-test',
  });
  console.log('[test] Alert written:', ref.id);
};


// ================================================
// BOOTSTRAP
// ================================================

/*
   USGS polling starts unconditionally — no login required.
   Firestore listeners (siteAlerts, curfewSchedules) are scoped to the
   authenticated user's barangay, resolved from their userIndex document.
*/

onAuthStateChanged(auth, async (user) => {
  await pollUsgs();
  setInterval(pollUsgs, USGS_POLL_MS);

  if (!user) return;

  try {
    const snap = await getDoc(userIndexDoc(user.uid));
    if (!snap.exists()) return;

    const { barangay } = snap.data();
    listenAlerts(barangay);

    /* Fetch DOB for age-based curfew filtering */
    let userDob = null;
    try {
      const fullSnap = await getDoc(userDoc(barangay, user.uid));
      if (fullSnap.exists()) userDob = fullSnap.data().dob ?? null;
    } catch { /* non-fatal — curfew will show for all ages if DOB is unavailable */ }

    listenCurfews(barangay, userDob);

  } catch (err) {
    console.warn('[alerts.js] Firestore subscription failed:', err.message);
  }
});