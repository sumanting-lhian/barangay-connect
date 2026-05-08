/* ================================================
   lastSeen.js — BarangayConnect
   Shared last-seen heartbeat for authenticated pages.
   Writes a Firestore timestamp on page load and repeats
   on a fixed interval while the tab remains visible.
   Import and call startLastSeenHeartbeat() on every
   authenticated page (dashboard.html, admin.html, etc.)

   WHAT IS IN HERE:
     · One-shot and interval-based lastSeen writes
     · Auth state listener with heartbeat lifecycle
     · Barangay resolution via userIndex doc
     · Visibility check to skip writes on hidden tabs

   WHAT IS NOT IN HERE:
     · Auth initialization                → firebase-config.js
     · Firestore path helpers             → db-paths.js
     · Online/offline presence tracking  → presence.js (if applicable)

   REQUIRED IMPORTS:
     · ../core/firebase-config.js              (auth, db)
     · ../core/db-paths.js                     (userDoc, userIndexDoc)
     · firebase-firestore.js@10.12.0     (updateDoc, serverTimestamp, getDoc)
     · firebase-auth.js@10.12.0          (onAuthStateChanged)

   QUICK REFERENCE:
     Start heartbeat  → startLastSeenHeartbeat()   (call once per page)
     Interval         → HEARTBEAT_INTERVAL_MS       (default: 5 minutes)
================================================ */


/* ================================================
   IMPORTS
================================================ */

import { auth, db } from '../core/firebase-config.js';
import { userDoc, userIndexDoc } from '../core/db-paths.js';

import {
  updateDoc, serverTimestamp, getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";


/* ================================================
   CONFIG
================================================ */

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes


/* ================================================
   MODULE STATE
================================================ */

let _heartbeatTimer = null;


/* ================================================
   WRITE LAST SEEN
   Non-fatal — a failed write does not block the user.
================================================ */

async function writeLastSeen(barangay, uid) {
  try {
    await updateDoc(userDoc(barangay, uid), {
      lastSeen: serverTimestamp(),
    });
  } catch (e) {
    console.warn('lastSeen write failed:', e.message);
  }
}


/* ================================================
   HEARTBEAT
   Resolves the user's barangay from their index doc,
   writes immediately on auth resolve, then repeats on
   the configured interval. Skips writes when the tab
   is hidden to avoid unnecessary Firestore usage.
================================================ */

export async function startLastSeenHeartbeat() {
  onAuthStateChanged(auth, async (user) => {

    /* Clear any previous timer if auth state fires more than once */
    if (_heartbeatTimer) {
      clearInterval(_heartbeatTimer);
      _heartbeatTimer = null;
    }

    if (!user) return;

    /* Resolve barangay from the user index doc */
    let barangay;
    try {
      const indexSnap = await getDoc(userIndexDoc(user.uid));
      if (!indexSnap.exists()) return;

      const data = indexSnap.data();
      if (data.status !== 'active') return;
      barangay = data.barangay;
    } catch (e) {
      console.warn('lastSeen: could not read userIndex', e.message);
      return;
    }

    /* Write immediately on page load / auth resolve */
    await writeLastSeen(barangay, user.uid);

    /* Repeat on interval while the tab remains open */
    _heartbeatTimer = setInterval(async () => {
      if (document.visibilityState === 'hidden') return;
      await writeLastSeen(barangay, user.uid);
    }, HEARTBEAT_INTERVAL_MS);
  });
}