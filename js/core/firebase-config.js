/* ================================================
   firebase-config.js — BarangayConnect
   Initializes the Firebase app and exports the shared
   Auth, Firestore, and Storage service instances used
   across the entire project.

   WHAT IS IN HERE:
     · Firebase app initialization (initializeApp)
     · Exported auth   — Firebase Authentication instance
     · Exported db     — Cloud Firestore instance
     · Exported storage — Cloud Storage instance

   WHAT IS NOT IN HERE:
     · Firestore document/collection path helpers  → db-paths.js
     · Auth state listeners and user routing       → auth.js
     · Storage upload helpers                      → storage.js

   REQUIRED IMPORTS:
     · firebase-app.js@10.12.0       (initializeApp)
     · firebase-auth.js@10.12.0      (getAuth)
     · firebase-firestore.js@10.12.0 (getFirestore)
     · firebase-storage.js@10.12.0   (getStorage)

   QUICK REFERENCE:
     import { auth, db, storage } from './firebase-config.js';
================================================ */


// ================================================
// IMPORTS
// ================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth }       from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore }  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getStorage }    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";


// ================================================
// CONFIGURATION
// ================================================

const firebaseConfig = {
  apiKey:            "AIzaSyA-OaTntJKO61eVoS2Mgd1rM-jBspdrJj4",
  authDomain:        "barangay-connect-project.firebaseapp.com",
  projectId:         "barangay-connect-project",
  storageBucket:     "barangay-connect-project.firebasestorage.app",
  messagingSenderId: "1098756792151",
  appId:             "1:1098756792151:web:126e8b183cd7404d926812",
  measurementId:     "G-3X1MGJQ0WR",
};


// ================================================
// SERVICE INSTANCES
// ================================================

const app = initializeApp(firebaseConfig);

export const auth    = getAuth(app);
export const db      = getFirestore(app);
export const storage = getStorage(app);
