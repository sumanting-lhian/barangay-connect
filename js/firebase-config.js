// js/firebase-config.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth }        from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore }   from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getStorage }     from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyA-OaTntJKO61eVoS2Mgd1rM-jBspdrJj4",
  authDomain: "barangay-connect-project.firebaseapp.com",
  projectId: "barangay-connect-project",
  storageBucket: "barangay-connect-project.firebasestorage.app",
  messagingSenderId: "1098756792151",
  appId: "1:1098756792151:web:126e8b183cd7404d926812",
  measurementId: "G-3X1MGJQ0WR"
};

const app = initializeApp(firebaseConfig);
export const auth      = getAuth(app);
export const db        = getFirestore(app);
export const storage   = getStorage(app);