/* ================================================
   auth.js — BarangayConnect
   Login form validation and Firebase authentication.
   Handles sign-in, account status checks, lastSeen
   updates, and role-based redirects on successful login.

   WHAT IS IN HERE:
     · onAuthStateChanged redirect — bypasses login for active sessions
     · Password visibility toggle
     · Client-side form validation (email format, required fields)
     · Login form submit handler with Firebase sign-in
     · Account status gating (pending / inactive)
     · lastSeen timestamp write on successful login
     · Role-based redirect helper (admin / officer / resident)
     · Firebase error code → user-friendly message map

   WHAT IS NOT IN HERE:
     · User registration flow          → register.js (or equivalent)
     · Firebase config and db instance → firebase-config.js
     · Firestore path helpers          → db-paths.js
     · Login page markup and styles    → login.html / login.css

   REQUIRED IMPORTS:
     · ../../core/firebase-config.js          (auth, db)
     · ../../core/db-paths.js                 (userDoc, userIndexDoc)
     · firebase-auth.js@10.12.0      (signInWithEmailAndPassword,
                                      onAuthStateChanged, signOut)
     · firebase-firestore.js@10.12.0 (getDoc, updateDoc, serverTimestamp)

   QUICK REFERENCE:
     Session redirect   → onAuthStateChanged (top-level, runs on load)
     Form submit        → loginForm 'submit' listener
     Role redirect      → redirectByRole(role)
     Loading state      → setLoading(isLoading)
     Error messages     → getFirebaseErrorMessage(code)
================================================ */


// ================================================
// IMPORTS
// ================================================

import { auth, db } from '../../core/firebase-config.js';
import { userDoc, userIndexDoc } from '../../core/db-paths.js';

import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  getDoc, updateDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";


// ================================================
// ELEMENT REFERENCES
// ================================================

const loginForm     = document.getElementById('loginForm');
const loginEmail    = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');
const loginBtn      = document.getElementById('loginBtn');
const loginSpinner  = document.getElementById('loginSpinner');
const loginError    = document.getElementById('loginError');
const emailError    = document.getElementById('emailError');
const passwordError = document.getElementById('passwordError');
const togglePwBtn   = document.getElementById('togglePassword');


// ================================================
// SESSION REDIRECT — Skip Login If Already Active
// ================================================

/*
   If the user is already authenticated and active, write lastSeen
   and redirect immediately without requiring them to log in again.
*/

onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  const indexSnap = await getDoc(userIndexDoc(user.uid));
  if (!indexSnap.exists()) return;

  const { barangay, status, role } = indexSnap.data();
  if (status !== 'active') return;

  try {
    await updateDoc(userDoc(barangay, user.uid), {
      lastSeen: serverTimestamp(),
    });
  } catch (e) {
    console.warn('Could not write lastSeen:', e.message);
  }

  redirectByRole(role || 'resident');
});


// ================================================
// PASSWORD VISIBILITY TOGGLE
// ================================================

if (togglePwBtn) {
  togglePwBtn.addEventListener('click', () => {
    const isPassword = loginPassword.type === 'password';
    loginPassword.type = isPassword ? 'text' : 'password';
    togglePwBtn.innerHTML = isPassword
      ? '<i data-lucide="eye-off"></i>'
      : '<i data-lucide="eye"></i>';
    lucide.createIcons();
  });
}


// ================================================
// FORM VALIDATION
// ================================================

/* Validates all fields and surfaces inline errors; returns true if the form is valid */
function validateLoginForm() {
  let valid = true;
  clearErrors();

  const email    = loginEmail.value.trim();
  const password = loginPassword.value;

  if (!email) {
    showError(emailError, loginEmail, 'Email address is required.');
    valid = false;
  } else if (!isValidEmail(email)) {
    showError(emailError, loginEmail, 'Please enter a valid email address.');
    valid = false;
  }

  if (!password) {
    showError(passwordError, loginPassword, 'Password is required.');
    valid = false;
  } else if (password.length < 6) {
    showError(passwordError, loginPassword, 'Password must be at least 6 characters.');
    valid = false;
  }

  return valid;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function showError(errorEl, inputEl, message) {
  if (errorEl) errorEl.textContent = message;
  if (inputEl) inputEl.classList.add('is-error');
}

function clearErrors() {
  [emailError, passwordError].forEach(el => { if (el) el.textContent = ''; });
  [loginEmail, loginPassword].forEach(el => { if (el) el.classList.remove('is-error'); });
  if (loginError) loginError.textContent = '';
}


// ================================================
// LOGIN FORM — Submit Handler
// ================================================

/*
   Sequence on submit:
     1. Client-side validation
     2. Firebase sign-in
     3. userIndex lookup — resolves barangay, role, status
     4. Account status gate (pending / inactive → sign out with message)
     5. lastSeen write to the barangay-scoped user document
     6. Role-based redirect
*/

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateLoginForm()) return;

    setLoading(true);

    const email    = loginEmail.value.trim();
    const password = loginPassword.value;

    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      const user = userCredential.user;

      /* Step 1 — fast index lookup: barangay, role, status */
      const indexSnap = await getDoc(userIndexDoc(user.uid));
      if (!indexSnap.exists()) {
        await signOut(auth);
        setLoading(false);
        loginError.textContent = 'Account not found. Contact the barangay office.';
        return;
      }

      const { barangay, role, status } = indexSnap.data();

      /* Step 2 — account status gate */
      if (status === 'pending') {
        await signOut(auth);
        setLoading(false);
        loginError.textContent = 'Your account is pending barangay approval. Please check back in 1–2 business days.';
        return;
      }

      if (status === 'inactive') {
        await signOut(auth);
        setLoading(false);
        loginError.textContent = 'Your account has been deactivated. Please contact the barangay office.';
        return;
      }

      /* Step 3 — write lastSeen to the barangay-scoped user document */
      try {
        await updateDoc(userDoc(barangay, user.uid), {
          lastSeen: serverTimestamp(),
        });
      } catch (e) {
        console.error('lastSeen FAILED:', e.code, e.message);
      }

      redirectByRole(role || 'resident');

    } catch (error) {
      setLoading(false);
      loginError.textContent = getFirebaseErrorMessage(error.code);
    }
  });
}


// ================================================
// HELPERS
// ================================================

/* Redirects to the appropriate landing page based on the user's role */
function redirectByRole(role) {
  switch (role) {
    case 'admin':   window.location.href = '/admin.html';    break;
    case 'officer': window.location.href = '/pages/features/home.html'; break;
    default:        window.location.href = '/pages/features/home.html'; break;
  }
}

/* Toggles the submit button and spinner during async sign-in */
function setLoading(isLoading) {
  loginBtn.disabled           = isLoading;
  loginSpinner.hidden         = !isLoading;
  loginBtn.querySelector('span:first-of-type').textContent = isLoading ? 'Signing in…' : 'Sign In';
}

/* Maps Firebase auth error codes to user-friendly messages */
function getFirebaseErrorMessage(code) {
  const messages = {
    'auth/user-not-found':         'No account found with that email address.',
    'auth/wrong-password':         'Incorrect password. Please try again.',
    'auth/invalid-email':          "That email address doesn't look right.",
    'auth/too-many-requests':      'Too many failed attempts. Please wait a moment.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/invalid-credential':     'Invalid email or password.',
  };
  return messages[code] || 'Something went wrong. Please try again.';
}