/* ================================================
   db-paths.js — BarangayConnect
   Single source of truth for all Firestore document
   references and Storage path strings in the project.
   Import from here everywhere — never hardcode paths
   in individual feature files.

   FIRESTORE STRUCTURE:
     barangays/{barangayId}/users/{uid}      full user document
     barangays/{barangayId}/meta/counter     sequential ID counter
     barangays/{barangayId}/meta/settings    moderation and config
     userIndex/{uid}                         fast auth routing
                                             (top-level: auth needs this
                                             before the barangay is known)
     barangays/{barangayId}/polls/{pollId}              poll document (options embedded)
     barangays/{barangayId}/polls/{pollId}/votes/{uid}  one vote per user (uid = doc ID)
     barangays/{barangayId}/polls/{pollId}/poll_actions audit trail

   STORAGE STRUCTURE:
     barangays/{barangayId}/id-photos/{uid}/front.webp
     barangays/{barangayId}/id-photos/{uid}/back.webp
     barangays/{barangayId}/avatars/{uid}.webp
     barangays/{barangayId}/reports/{uid}/{reportId}.webp
     barangays/{barangayId}/announcements/{fileName}
     barangays/{barangayId}/posts/{uid}/{fileName}
     barangays/{barangayId}/pets/{uid}/{fileName}

   WHAT IS IN HERE:
     · barangayId — display name → safe Firestore/Storage key
     · barangayAbbrev — display name → 3-letter uppercase ID prefix
     · Firestore doc/collection helpers: userDoc, usersCol,
       userIndexDoc, barangaySettingsDoc, barangayCounterDoc
     · Storage path helpers: idPhotoFrontPath, idPhotoBackPath,
       avatarPath, reportPhotoPath, announcementPhotoPath,
       postPhotoPath, petPhotoPath
      · pollsCol, pollDoc, voteDoc, pollActionsCol — poll Firestore path helpers

   WHAT IS NOT IN HERE:
     · Firebase initialization          → firebase-config.js
     · Storage ref creation             → import ref() at call site
     · Any read/write Firestore logic   → feature modules

   REQUIRED IMPORTS:
     · ./firebase-config.js          (db)
     · firebase-firestore.js@10.12.0 (doc, collection)

   QUICK REFERENCE:
     Barangay key     → barangayId(name)
     Barangay abbrev  → barangayAbbrev(name)
     User doc         → userDoc(barangay, uid)
     Auth index doc   → userIndexDoc(uid)
     ID counter doc   → barangayCounterDoc(barangay)
     Settings doc     → barangaySettingsDoc(barangay)
     Poll collection  → pollsCol(barangay)
     Poll doc         → pollDoc(barangay, pollId)
     Vote doc         → voteDoc(barangay, pollId, userId)
     Poll actions col → pollActionsCol(barangay, pollId)
     Storage paths    → *Path(...) helpers below
================================================ */


// ================================================
// IMPORTS
// ================================================

import { db } from './firebase-config.js';

import {
  doc, collection,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";


// ================================================
// BARANGAY KEY HELPERS
// ================================================

/*
   Converts a barangay display name to a safe, lowercase
   Firestore/Storage path segment.
     "San Isidro" → "san_isidro"
     "Barangay 1" → "barangay_1"
*/
export function barangayId(barangayName) {
  return String(barangayName)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

/*
   Produces a 3-letter uppercase code for use in resident ID numbers.
     "Bancod"     → "BAN"
     "San Isidro" → "SAN"
     "Barangay 1" → "BAR"
     "Bo"         → "BO0"  (padded to 3 chars)
*/
export function barangayAbbrev(barangayName) {
  return String(barangayName)
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '') // strip non-alphanumeric
    .slice(0, 3)
    .toUpperCase()
    .padEnd(3, '0');               // zero-pad if shorter than 3 chars
}


// ================================================
// FIRESTORE PATHS
// ================================================

/* Full user document: barangays/{barangayId}/users/{uid} */
export function userDoc(barangay, uid) {
  return doc(db, 'barangays', barangayId(barangay), 'users', uid);
}

/* Users subcollection: barangays/{barangayId}/users */
export function usersCol(barangay) {
  return collection(db, 'barangays', barangayId(barangay), 'users');
}

/*
   Lightweight auth index: userIndex/{uid}
   Stays top-level — auth.js needs this before it knows the barangay.
   Document shape: { barangay, barangayId, role, status }
*/
export function userIndexDoc(uid) {
  return doc(db, 'userIndex', uid);
}

/* Moderation and config settings: barangays/{barangayId}/meta/settings */
export function barangaySettingsDoc(barangay) {
  return doc(db, 'barangays', barangayId(barangay), 'meta', 'settings');
}

/*
   Sequential ID counter: barangays/{barangayId}/meta/counter
   Document shape: { total: <number> }
   Always increment via runTransaction — never write directly.
*/
export function barangayCounterDoc(barangay) {
  return doc(db, 'barangays', barangayId(barangay), 'meta', 'counter');
}


// ================================================
// STORAGE PATHS
// ================================================

/*
   All asset paths live under barangays/{barangayId}/ first,
   grouped by type. Returns string paths — import ref() at the
   call site to create a Storage reference from these strings.
*/

/* barangays/{barangayId}/id-photos/{uid}/front.webp */
export function idPhotoFrontPath(barangay, uid) {
  return `barangays/${barangayId(barangay)}/id-photos/${uid}/front.webp`;
}

/* barangays/{barangayId}/id-photos/{uid}/back.webp */
export function idPhotoBackPath(barangay, uid) {
  return `barangays/${barangayId(barangay)}/id-photos/${uid}/back.webp`;
}

/* barangays/{barangayId}/avatars/{uid}.webp */
export function avatarPath(barangay, uid) {
  return `barangays/${barangayId(barangay)}/avatars/${uid}.webp`;
}

/* barangays/{barangayId}/reports/{uid}/{reportId}.webp */
export function reportPhotoPath(barangay, uid, reportId) {
  return `barangays/${barangayId(barangay)}/reports/${uid}/${reportId}.webp`;
}

/* barangays/{barangayId}/announcements/{fileName} */
export function announcementPhotoPath(barangay, fileName) {
  return `barangays/${barangayId(barangay)}/announcements/${fileName}`;
}

/* barangays/{barangayId}/posts/{uid}/{fileName} */
export function postPhotoPath(barangay, uid, fileName) {
  return `barangays/${barangayId(barangay)}/posts/${uid}/${fileName}`;
}

/* barangays/{barangayId}/pets/{uid}/{fileName} */
export function petPhotoPath(barangay, uid, fileName) {
  return `barangays/${barangayId(barangay)}/pets/${uid}/${fileName}`;
}

// ================================================
// POLL PATHS
// ================================================

/* barangays/{barangayId}/polls */
export function pollsCol(barangay) {
  return collection(db, 'barangays', barangayId(barangay), 'polls');
}

/* barangays/{barangayId}/polls/{pollId} */
export function pollDoc(barangay, pollId) {
  return doc(db, 'barangays', barangayId(barangay), 'polls', pollId);
}

/*
   barangays/{barangayId}/polls/{pollId}/votes/{userId}
   userId used as the document ID — Firestore enforces the 1-vote
   constraint by making a second setDoc silently fail inside a transaction.
*/
export function voteDoc(barangay, pollId, userId) {
  return doc(db, 'barangays', barangayId(barangay), 'polls', pollId, 'votes', userId);
}

/* barangays/{barangayId}/polls/{pollId}/poll_actions */
export function pollActionsCol(barangay, pollId) {
  return collection(db, 'barangays', barangayId(barangay), 'polls', pollId, 'poll_actions');
}

export function eventsCol(barangay) {
  return collection(db, 'barangays', barangayId(barangay), 'events');
}
export function eventDoc(barangay, eventId) {
  return doc(db, 'barangays', barangayId(barangay), 'events', eventId);
}
export function eventRsvpsCol(barangay, eventId) {
  return collection(db, 'barangays', barangayId(barangay), 'events', eventId, 'rsvps');
}
export function eventPhotoPath(barangay, uid, fileName) {
  return `barangays/${barangayId(barangay)}/events/${uid}/${fileName}`;
}

/* barangays/{barangayId}/pets */
export function petsCol(barangay) {
  return collection(db, 'barangays', barangayId(barangay), 'pets');
}
/* barangays/{barangayId}/pets/{reportId} */
export function petDoc(barangay, reportId) {
  return doc(db, 'barangays', barangayId(barangay), 'pets', reportId);
}
/* barangays/{barangayId}/pets/{reportId}/contacts */
export function petContactsCol(barangay, reportId) {
  return collection(db, 'barangays', barangayId(barangay), 'pets', reportId, 'contacts');
}