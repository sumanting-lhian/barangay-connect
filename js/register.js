// js/register.js
// =====================================================
// Handles: 3-step registration form
// Uploads: ID photos to Firebase Storage
// Saves:   User data to Firestore as status: "pending"
// =====================================================

import { auth, db } from './firebase-config.js';
import { uploadIdPhotos } from './storage.js';          // ← replaces cloudinary.js
import {
  createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";


// =====================================================
// STATE — collected across all 3 steps
// =====================================================
const formData = {
  // Step 1
  firstName:    '',
  lastName:     '',
  email:        '',
  phone:        '',
  dob:          '',
  password:     '',
  // Step 2
  barangay:     '',
  purok:        '',
  yearsResident:'',
  // Step 3
  idType:       '',
  idNumber:     '',
  idFrontURL:   '',  // Firebase Storage URL after upload
  idBackURL:    '',  // Firebase Storage URL after upload
};

// Track which step we're on
let currentStep = 1;

// Raw File objects (before upload)
let idFrontFile = null;
let idBackFile  = null;


// =====================================================
// ELEMENTS
// =====================================================
const steps = {
  1: document.getElementById('step1'),
  2: document.getElementById('step2'),
  3: document.getElementById('step3'),
};
const successScreen  = document.getElementById('successScreen');
const registerHeader = document.querySelector('.register-header');
const stepIndicator  = document.getElementById('stepIndicator');

// Step dots and connectors
const stepDots   = [null, document.getElementById('stepDot1'), document.getElementById('stepDot2'), document.getElementById('stepDot3')];
const connectors = [null, document.getElementById('connector1'), document.getElementById('connector2')];

// Step 1 elements
const step1Form   = document.getElementById('step1Form');
const toggleRegPw = document.getElementById('toggleRegPassword');
const regPassword = document.getElementById('regPassword');

// Step 2 elements
const step2Form = document.getElementById('step2Form');
const step2Back = document.getElementById('step2Back');

// Step 3 elements
const step3Form      = document.getElementById('step3Form');
const step3Back      = document.getElementById('step3Back');
const step3Btn       = document.getElementById('step3Btn');
const submitSpinner  = document.getElementById('submitSpinner');
const submitError    = document.getElementById('submitError');

// Upload areas
const uploadFrontArea = document.getElementById('uploadFrontArea');
const uploadBackArea  = document.getElementById('uploadBackArea');
const idPhotoFront    = document.getElementById('idPhotoFront');
const idPhotoBack     = document.getElementById('idPhotoBack');
const previewFront    = document.getElementById('previewFront');
const previewBack     = document.getElementById('previewBack');


// =====================================================
// STEP NAVIGATION
// =====================================================
function goToStep(n) {
  Object.values(steps).forEach(el => { if (el) el.hidden = true; });
  if (steps[n]) steps[n].hidden = false;
  currentStep = n;
  updateStepIndicator(n);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateStepIndicator(active) {
  stepDots.forEach((dot, i) => {
    if (!dot) return;
    dot.classList.remove('active', 'completed', 'pending');
    if (i < active)        dot.classList.add('completed');
    else if (i === active) dot.classList.add('active');
    else                   dot.classList.add('pending');

    const circle = dot.querySelector('.step-item__circle');
    if (i < active) {
      circle.innerHTML = '<i data-lucide="check"></i>';
    } else {
      circle.textContent = i;
    }
  });

  connectors.forEach((c, i) => {
    if (!c) return;
    c.classList.toggle('active', i < active);
  });

  lucide.createIcons();
}


// =====================================================
// STEP 1 — SUBMIT
// =====================================================
if (step1Form) {
  step1Form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!validateStep1()) return;

    formData.firstName = document.getElementById('firstName').value.trim();
    formData.lastName  = document.getElementById('lastName').value.trim();
    formData.email     = document.getElementById('regEmail').value.trim();
    formData.phone     = document.getElementById('phone').value.trim();
    formData.dob       = document.getElementById('dob').value;
    formData.password  = document.getElementById('regPassword').value;

    goToStep(2);
  });
}

// Password toggle on step 1
if (toggleRegPw) {
  toggleRegPw.addEventListener('click', () => {
    const isPassword = regPassword.type === 'password';
    regPassword.type = isPassword ? 'text' : 'password';
    toggleRegPw.innerHTML = isPassword
      ? '<i data-lucide="eye-off"></i>'
      : '<i data-lucide="eye"></i>';
    lucide.createIcons();
  });
}


// =====================================================
// STEP 2 — SUBMIT + BACK
// =====================================================
if (step2Back) step2Back.addEventListener('click', () => goToStep(1));

if (step2Form) {
  step2Form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!validateStep2()) return;

    formData.barangay      = document.getElementById('barangay').value;
    formData.purok         = document.getElementById('purok').value;
    formData.yearsResident = document.getElementById('yearsResident').value;

    goToStep(3);
  });
}


// =====================================================
// STEP 3 — FILE UPLOAD PREVIEWS
// =====================================================

uploadFrontArea.addEventListener('click', () => idPhotoFront.click());
uploadBackArea.addEventListener('click',  () => idPhotoBack.click());

idPhotoFront.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!isValidImage(file)) {
    showFieldError('idFrontError', 'File must be JPG, PNG, or WEBP under 5MB.');
    return;
  }
  idFrontFile = file;
  showImagePreview(previewFront, uploadFrontArea, file);
  clearFieldError('idFrontError');
});

idPhotoBack.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!isValidImage(file)) {
    showFieldError('idBackError', 'File must be JPG, PNG, or WEBP under 5MB.');
    return;
  }
  idBackFile = file;
  showImagePreview(previewBack, uploadBackArea, file);
  clearFieldError('idBackError');
});

function isValidImage(file) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  const maxSize = 5 * 1024 * 1024;
  return allowed.includes(file.type) && file.size <= maxSize;
}

function showImagePreview(imgEl, areaEl, file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    imgEl.src = e.target.result;
    imgEl.style.display = 'block';
    areaEl.querySelectorAll('[data-lucide], .upload-area__label, .upload-area__hint')
      .forEach(el => el.style.display = 'none');
  };
  reader.readAsDataURL(file);
}


// =====================================================
// STEP 3 — BACK
// =====================================================
if (step3Back) step3Back.addEventListener('click', () => goToStep(2));


// =====================================================
// STEP 3 — SUBMIT (Main registration)
// =====================================================
if (step3Form) {
  step3Form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateStep3()) return;

    formData.idType   = document.getElementById('idType').value;
    formData.idNumber = document.getElementById('idNumber').value.trim();

    setSubmitLoading(true);
    submitError.textContent = '';

    try {
      // ---- 1. Create Firebase Auth account (we need the UID for storage paths) ----
      const userCredential = await createUserWithEmailAndPassword(
        auth,
        formData.email,
        formData.password
      );
      const uid = userCredential.user.uid;

      // ---- 2. Upload ID photos to Firebase Storage ----
      // Files are compressed to WebP automatically inside uploadIdPhotos()
      // Stored at: id-photos/{uid}/front.webp and id-photos/{uid}/back.webp
      const { frontURL, backURL } = await uploadIdPhotos(uid, idFrontFile, idBackFile);

      formData.idFrontURL = frontURL;
      formData.idBackURL  = backURL;

      // ---- 3. Save user profile to Firestore ----
      // status: "pending" — admin must approve before user can access the app
      // idFrontURL / idBackURL will be cleared by Cloud Function after approval
      await setDoc(doc(db, 'users', uid), {
        uid,
        firstName:     formData.firstName,
        lastName:      formData.lastName,
        fullName:      `${formData.firstName} ${formData.lastName}`,
        email:         formData.email,
        phone:         formData.phone,
        dob:           formData.dob,
        barangay:      formData.barangay,
        purok:         formData.purok,
        yearsResident: Number(formData.yearsResident),
        idType:        formData.idType,
        idNumber:      formData.idNumber,
        idFrontURL:    formData.idFrontURL,
        idBackURL:     formData.idBackURL,
        role:          'resident',
        status:        'pending',
        createdAt:     serverTimestamp(),
      });

      // ---- 4. Show success screen ----
      showSuccess();

    } catch (error) {
      setSubmitLoading(false);
      submitError.textContent = getRegisterErrorMessage(error.code, error.message);
    }
  });
}


// =====================================================
// SUCCESS SCREEN
// =====================================================
function showSuccess() {
  Object.values(steps).forEach(el => { if (el) el.hidden = true; });
  registerHeader.hidden = true;
  stepIndicator.hidden  = true;
  successScreen.hidden  = false;
}


// =====================================================
// VALIDATION — Step 1
// =====================================================
function validateStep1() {
  clearAllErrors(['firstNameError','lastNameError','regEmailError','phoneError','dobError','regPasswordError']);
  let valid = true;

  const firstName = document.getElementById('firstName').value.trim();
  const lastName  = document.getElementById('lastName').value.trim();
  const email     = document.getElementById('regEmail').value.trim();
  const phone     = document.getElementById('phone').value.trim();
  const dob       = document.getElementById('dob').value;
  const password  = document.getElementById('regPassword').value;

  if (!firstName) { showFieldError('firstNameError', 'First name is required.'); valid = false; }
  if (!lastName)  { showFieldError('lastNameError',  'Last name is required.');  valid = false; }

  if (!email) {
    showFieldError('regEmailError', 'Email is required.');
    valid = false;
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showFieldError('regEmailError', 'Enter a valid email address.');
    valid = false;
  }

  if (!phone) {
    showFieldError('phoneError', 'Phone number is required.');
    valid = false;
  } else if (!/^09\d{9}$/.test(phone)) {
    showFieldError('phoneError', 'Enter a valid PH number (e.g. 09XX XXX XXXX).');
    valid = false;
  }

  if (!dob) {
    showFieldError('dobError', 'Date of birth is required.');
    valid = false;
  } else {
    const age = getAge(dob);
    if (age < 15) {
      showFieldError('dobError', 'You must be at least 15 years old to register.');
      valid = false;
    }
  }

  if (!password) {
    showFieldError('regPasswordError', 'Password is required.');
    valid = false;
  } else if (password.length < 8) {
    showFieldError('regPasswordError', 'Password must be at least 8 characters.');
    valid = false;
  }

  return valid;
}


// =====================================================
// VALIDATION — Step 2
// =====================================================
function validateStep2() {
  clearAllErrors(['barangayError','purokError','yearsError']);
  let valid = true;

  const barangay      = document.getElementById('barangay').value;
  const purok         = document.getElementById('purok').value;
  const yearsResident = document.getElementById('yearsResident').value;

  if (!barangay)      { showFieldError('barangayError', 'Please select your barangay.'); valid = false; }
  if (!purok)         { showFieldError('purokError',    'Please select your purok.');    valid = false; }
  if (!yearsResident || yearsResident < 0) {
    showFieldError('yearsError', 'Enter how many years you have been a resident.');
    valid = false;
  }

  return valid;
}


// =====================================================
// VALIDATION — Step 3
// =====================================================
function validateStep3() {
  clearAllErrors(['idTypeError','idNumberError','idFrontError','idBackError']);
  let valid = true;

  const idType   = document.getElementById('idType').value;
  const idNumber = document.getElementById('idNumber').value.trim();

  if (!idType)      { showFieldError('idTypeError',   'Please select your ID type.');          valid = false; }
  if (!idNumber)    { showFieldError('idNumberError', 'ID number is required.');               valid = false; }
  if (!idFrontFile) { showFieldError('idFrontError',  'Please upload the front of your ID.'); valid = false; }
  if (!idBackFile)  { showFieldError('idBackError',   'Please upload the back of your ID.');  valid = false; }

  return valid;
}


// =====================================================
// HELPERS
// =====================================================
function showFieldError(id, message) {
  const el = document.getElementById(id);
  if (el) el.textContent = message;
}

function clearFieldError(id) {
  const el = document.getElementById(id);
  if (el) el.textContent = '';
}

function clearAllErrors(ids) {
  ids.forEach(id => clearFieldError(id));
}

function getAge(dobString) {
  const today = new Date();
  const birth  = new Date(dobString);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

function setSubmitLoading(isLoading) {
  step3Btn.disabled    = isLoading;
  submitSpinner.hidden = !isLoading;
  step3Btn.querySelector('span:first-of-type').textContent = isLoading
    ? 'Submitting...'
    : 'Submit Registration';
}

function getRegisterErrorMessage(code, fallback) {
  const messages = {
    'auth/email-already-in-use':   'An account with that email already exists. Try signing in.',
    'auth/invalid-email':          'That email address is not valid.',
    'auth/weak-password':          'Password is too weak. Use at least 8 characters.',
    'auth/network-request-failed': 'Network error. Check your connection.',
  };
  return messages[code] || fallback || 'Something went wrong. Please try again.';
}
