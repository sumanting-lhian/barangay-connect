// js/auth.js
// =====================================================
// Handles: Login form validation + Firebase sign-in
// Used on: login.html
// =====================================================

import { auth, db } from './firebase-config.js';
import {
  signInWithEmailAndPassword,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";


// ---- Element references ----
const loginForm     = document.getElementById('loginForm');
const loginEmail    = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');
const loginBtn      = document.getElementById('loginBtn');
const loginSpinner  = document.getElementById('loginSpinner');
const loginError    = document.getElementById('loginError');
const emailError    = document.getElementById('emailError');
const passwordError = document.getElementById('passwordError');
const togglePwBtn   = document.getElementById('togglePassword');


// =====================================================
// 1. REDIRECT IF ALREADY LOGGED IN
//    When user visits login page but is already signed in,
//    redirect them to the dashboard automatically.
// =====================================================
onAuthStateChanged(auth, async (user) => {
  if (user) {
    // User is logged in — fetch their role and redirect
    const role = await getUserRole(user.uid);
    redirectByRole(role);
  }
});


// =====================================================
// 2. TOGGLE PASSWORD VISIBILITY
// =====================================================
if (togglePwBtn) {
  togglePwBtn.addEventListener('click', () => {
    const isPassword = loginPassword.type === 'password';
    loginPassword.type = isPassword ? 'text' : 'password';
    // Swap icon (Lucide)
    togglePwBtn.innerHTML = isPassword
      ? '<i data-lucide="eye-off"></i>'
      : '<i data-lucide="eye"></i>';
    lucide.createIcons();
  });
}


// =====================================================
// 3. FORM VALIDATION (runs before Firebase call)
// =====================================================
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


// =====================================================
// 4. LOGIN FORM SUBMIT
// =====================================================
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!validateLoginForm()) return;

    // Show loading state
    setLoading(true);

    const email    = loginEmail.value.trim();
    const password = loginPassword.value;

    try {
      // ---- FIREBASE: Sign in ----
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      const user = userCredential.user;

      // ---- FIREBASE: Get user role from Firestore ----
      const role = await getUserRole(user.uid);

      // ---- Check if account is pending ----
      const userSnap = await getDoc(doc(db, 'users', user.uid));
      if (userSnap.exists()) {
        const userData = userSnap.data();
        if (userData.status === 'pending') {
          setLoading(false);
          loginError.textContent = 'Your account is pending admin approval. Please wait.';
          return;
        }
        if (userData.status === 'inactive') {
          setLoading(false);
          loginError.textContent = 'Your account has been deactivated. Contact the barangay office.';
          return;
        }
      }

      // ---- Success: redirect based on role ----
      redirectByRole(role);

    } catch (error) {
      setLoading(false);
      loginError.textContent = getFirebaseErrorMessage(error.code);
    }
  });
}


// =====================================================
// 5. HELPER: Get user role from Firestore
// =====================================================
async function getUserRole(uid) {
  try {
    const userSnap = await getDoc(doc(db, 'users', uid));
    if (userSnap.exists()) {
      return userSnap.data().role || 'resident';
    }
    return 'resident';
  } catch {
    return 'resident';
  }
}


// =====================================================
// 6. HELPER: Redirect based on role
// =====================================================
function redirectByRole(role) {
  switch (role) {
    case 'admin':
      window.location.href = 'admin.html';
      break;
    case 'officer':
      window.location.href = 'dashboard.html'; // officers use main dashboard
      break;
    default:
      window.location.href = 'dashboard.html';
  }
}


// =====================================================
// 7. HELPER: Loading state toggle
// =====================================================
function setLoading(isLoading) {
  loginBtn.disabled = isLoading;
  loginSpinner.hidden = !isLoading;
  loginBtn.querySelector('span:first-of-type').textContent = isLoading ? 'Signing in...' : 'Sign In';
}


// =====================================================
// 8. HELPER: Friendly Firebase error messages
// =====================================================
function getFirebaseErrorMessage(code) {
  const messages = {
    'auth/user-not-found':       'No account found with that email address.',
    'auth/wrong-password':       'Incorrect password. Please try again.',
    'auth/invalid-email':        'That email address doesn\'t look right.',
    'auth/too-many-requests':    'Too many failed attempts. Please wait a moment.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/invalid-credential':   'Invalid email or password.',
  };
  return messages[code] || 'Something went wrong. Please try again.';
}
