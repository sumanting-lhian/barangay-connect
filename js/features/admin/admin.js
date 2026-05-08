/* ================================================
   admin.js — BarangayConnect
   Admin dashboard logic for the pending user approval page.
   Runs only for authenticated users with role "admin".

   WHAT IS IN HERE:
     · Auth guard — redirects non-admins to index
     · loadPendingUsers — real-time snapshot of pending accounts,
       with live search filtering by name, email, and resident ID
     · buildCard — renders a single applicant card with ID photos,
       detail grid, and approve / reject action buttons
     · approveUser — sets status to active, scrubs verification data,
       cleans up Storage photos
     · rejectUser  — deletes Storage photos and user document;
       Cloud Function handles Auth + userIndex cleanup

   WHAT IS NOT IN HERE:
     · Firebase config and auth/db instances  → firebase-config.js
     · Storage photo deletion utility         → storage.js
     · Firestore collection / doc path refs   → db-paths.js
     · ID lightbox logic                      → invoked via window.openLightbox

   REQUIRED IMPORTS:
     · ../../core/firebase-config.js          (auth, db)
     · ../../core/storage.js                  (deleteIdPhotos)
     · ../../core/db-paths.js                 (usersCol, userDoc, userIndexDoc)
     · firebase-firestore.js@10.12.0 (query, where, onSnapshot, updateDoc,
                                      deleteDoc, serverTimestamp, getDoc, deleteField)
     · firebase-auth.js@10.12.0      (onAuthStateChanged)

   QUICK REFERENCE:
     Auth guard         → onAuthStateChanged (top-level, runs on load)
     Snapshot listener  → loadPendingUsers(barangay, currentUid)
     Card builder       → buildCard(user) → HTMLElement
     Approve handler    → window.approveUser(uid, barangay, name)
     Reject handler     → window.rejectUser(uid, barangay, name)
================================================ */


// ================================================
// IMPORTS
// ================================================

import { auth, db } from '../../core/firebase-config.js';
import { deleteIdPhotos } from '../../core/storage.js';
import { usersCol, userDoc, userIndexDoc } from '../../core/db-paths.js';

import {
  query, where, onSnapshot,
  updateDoc, deleteDoc, serverTimestamp, getDoc,
  deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import { showConfirm } from '/js/shared/confirm-modal.js';


// ================================================
// AUTH GUARD
// ================================================

/*
   Runs on page load. Redirects to index if the user is not
   authenticated, has no userIndex entry, or is not an admin.
   On success, scopes the page to the admin's barangay.
*/

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = '/index.html';; return; }

  const indexSnap = await getDoc(userIndexDoc(user.uid));
  if (!indexSnap.exists()) { window.location.href = '/index.html';; return; }

  const { barangay, role } = indexSnap.data();
  if (role !== 'admin') { window.location.href = '/index.html';; return; }

  loadPendingUsers(barangay, user.uid);
});


// ================================================
// LOAD PENDING USERS
// ================================================

/*
   Opens a real-time snapshot of all pending users for the given barangay.
   Updates the pending count badge, sorts results alphabetically (current
   admin first), and delegates rendering to renderFiltered().

   Search strips dashes before comparing so partial IDs like "BAN2024"
   match formatted strings like "BRY-BAN-2024-00001".
*/

let _pendingTotal = 0;
let allUsers        = [];
let _pendingSort    = 'newest';
let _pendingIdType  = 'all';

function loadPendingUsers(barangay, currentUid) {
  const container    = document.getElementById('pendingList');
  const emptyState   = document.getElementById('emptyState');
  const loadingState = document.getElementById('loadingState');
  const searchInput  = document.getElementById('pendingSearch');

  /* Filters allUsers by the current search term and re-renders the list */
  window._renderPendingFiltered = (term) => renderFiltered(term ?? searchInput?.value.trim().toLowerCase() ?? '');

  function renderFiltered(term) {
    container.innerHTML = '';

    let list = [...allUsers];

    if (_pendingIdType !== 'all') {
      list = list.filter(u => (u.idType ?? '').toLowerCase().includes(_pendingIdType.toLowerCase()));
    }

    if (term) {
      const termClean = term.replace(/-/g, '');
      list = list.filter(u => {
        const name    = (u.fullName ?? `${u.firstName ?? ''} ${u.lastName ?? ''}`).toLowerCase();
        const mail    = (u.email ?? '').toLowerCase();
        const id      = (u.residentIdNumber ?? '').toLowerCase();
        const idClean = id.replace(/-/g, '');
        return name.includes(term) || mail.includes(term) || id.includes(term) || idClean.includes(termClean);
      });
    }

    if (_pendingSort === 'newest') {
      list.sort((a, b) => (b.createdAt?.toDate?.() ?? new Date(0)) - (a.createdAt?.toDate?.() ?? new Date(0)));
    } else if (_pendingSort === 'oldest') {
      list.sort((a, b) => (a.createdAt?.toDate?.() ?? new Date(0)) - (b.createdAt?.toDate?.() ?? new Date(0)));
    } else {
      list.sort((a, b) => {
        const an = (a.fullName ?? `${a.firstName} ${a.lastName}`).toLowerCase();
        const bn = (b.fullName ?? `${b.firstName} ${b.lastName}`).toLowerCase();
        return an.localeCompare(bn);
      });
    }

    if (list.length === 0) {
      emptyState.hidden = false;
      container.innerHTML = (term || _pendingIdType !== 'all')
        ? `<p style="color:#888;padding:1rem 0">No results for the current filter.</p>` : '';
      return;
    }

    emptyState.hidden = true;
    list.forEach(user => container.appendChild(buildCard(user)));
  }

  /* Real-time listener — scoped to pending status for this barangay */
  const q = query(usersCol(barangay), where('status', '==', 'pending'));

  onSnapshot(q, (snapshot) => {
    loadingState.hidden = true;

    /* Update all pending count badges */
    const badge = document.getElementById('pendingBadgeCount');
    if (badge) {
      _pendingTotal = snapshot.size;
      badge.textContent  = snapshot.size;
      badge.style.display = snapshot.size > 0 ? 'inline' : 'none';

      const subBadge = document.getElementById('pendingSubBadge');
      if (subBadge) {
        subBadge.textContent  = snapshot.size;
        subBadge.style.display = snapshot.size > 0 ? 'inline' : 'none';
      }
    }

    if (snapshot.empty) {
      emptyState.hidden   = false;
      container.innerHTML = '';
      return;
    }

    emptyState.hidden = true;

    allUsers = snapshot.docs.map(d => ({ uid: d.id, _barangay: barangay, ...d.data() }));

    /* Sort alphabetically; surface the current admin's own entry first */
    allUsers.sort((a, b) => {
      if (a.uid === currentUid) return -1;
      if (b.uid === currentUid) return  1;
      const aName = (a.fullName ?? `${a.firstName} ${a.lastName}`).toLowerCase();
      const bName = (b.fullName ?? `${b.firstName} ${b.lastName}`).toLowerCase();
      return aName.localeCompare(bName);
    });

    /* Re-apply active search + filters after a live list refresh */
    renderFiltered(searchInput?.value.trim().toLowerCase() ?? '');
  });
}

window.setPendingSort = function (sort, btn) {
  _pendingSort = sort;
  document.querySelectorAll('#pendingSortNewest,#pendingSortOldest,#pendingSortName')
    .forEach(b => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  const searchInput = document.getElementById('pendingSearch');
  _renderPendingFiltered(searchInput?.value.trim().toLowerCase() ?? '');
};

window.setPendingIdType = function (type, btn) {
  _pendingIdType = type;
  document.querySelectorAll('[onclick^="setPendingIdType"]')
    .forEach(b => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  const searchInput = document.getElementById('pendingSearch');
  _renderPendingFiltered(searchInput?.value.trim().toLowerCase() ?? '');
};


// ================================================
// BUILD APPLICANT CARD
// ================================================

/*
   Constructs and returns the DOM element for a single pending applicant.
   ID photo URLs are stored on dataset.idurls so the lightbox can read
   them without embedding long Firebase URLs inside onclick strings.
*/

function buildCard(user) {
  const card    = document.createElement('div');
  card.className = 'applicant-card';
  card.id        = `card-${user.uid}`;

  card.dataset.idurls = JSON.stringify([
    { url: user.idFrontURL || '', label: 'Front of ID' },
    { url: user.idBackURL  || '', label: 'Back of ID'  },
  ]);

  const dob = user.dob
    ? new Date(user.dob).toLocaleDateString('en-PH', {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : '—';

  const createdAt = user.createdAt?.toDate?.()
    ?.toLocaleDateString('en-PH', {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    ?? '—';

  const frontThumb = user.idFrontURL
    ? `<img class="id-photo" src="${user.idFrontURL}" alt="ID Front"
          onclick="openLightbox(JSON.parse(this.closest('.applicant-card').dataset.idurls), 0)"
          title="Click to enlarge" />`
    : '<p class="id-photo--missing">Photo not available</p>';

  const backThumb = user.idBackURL
    ? `<img class="id-photo" src="${user.idBackURL}" alt="ID Back"
          onclick="openLightbox(JSON.parse(this.closest('.applicant-card').dataset.idurls), 1)"
          title="Click to enlarge" />`
    : '<p class="id-photo--missing">Photo not available</p>';

  card.innerHTML = `
    <div class="applicant-card__header">
      <div class="applicant-card__name">${user.fullName ?? `${user.firstName} ${user.lastName}`}</div>
      <span class="badge badge--pending">Pending</span>
    </div>

    <div class="applicant-card__grid">
      <div class="detail-item">
        <span class="detail-item__label">Email</span>
        <span class="detail-item__value">${user.email}</span>
      </div>
      <div class="detail-item">
        <span class="detail-item__label">Phone</span>
        <span class="detail-item__value">${user.phone}</span>
      </div>
      <div class="detail-item">
        <span class="detail-item__label">Date of Birth</span>
        <span class="detail-item__value">${dob}</span>
      </div>
      <div class="detail-item">
        <span class="detail-item__label">Barangay</span>
        <span class="detail-item__value">${user.barangay}</span>
      </div>
      <div class="detail-item" style="grid-column: 1 / -1;">
        <span class="detail-item__label">Home Address</span>
        <span class="detail-item__value">${user.streetAddress || '—'}</span>
      </div>
      <div class="detail-item">
        <span class="detail-item__label">Years as Resident</span>
        <span class="detail-item__value">${user.yearsResident}</span>
      </div>
      <div class="detail-item">
        <span class="detail-item__label">ID Type</span>
        <span class="detail-item__value">${user.idType}</span>
      </div>
      <div class="detail-item">
        <span class="detail-item__label">ID Number</span>
        <span class="detail-item__value">${user.idNumber}</span>
      </div>
      <div class="detail-item">
        <span class="detail-item__label">Submitted</span>
        <span class="detail-item__value">${createdAt}</span>
      </div>
      <div class="detail-item">
        <span class="detail-item__label">Resident ID</span>
        <span class="detail-item__value">${user.residentIdNumber ?? '—'}</span>
      </div>
    </div>

    <div class="applicant-card__ids">
      <div class="id-photo-wrap">
        <span class="id-photo-wrap__label">Front of ID</span>
        ${frontThumb}
      </div>
      <div class="id-photo-wrap">
        <span class="id-photo-wrap__label">Back of ID</span>
        ${backThumb}
      </div>
    </div>

    <div class="applicant-card__actions">
      <button class="btn btn--danger"
        onclick="rejectUser('${user.uid}', '${user._barangay}', '${user.fullName ?? user.firstName}')">
        <i data-lucide="x-circle"></i> Reject
      </button>
      <button class="btn btn--success"
        onclick="approveUser('${user.uid}', '${user._barangay}', '${user.fullName ?? user.firstName}')">
        <i data-lucide="check-circle"></i> Approve
      </button>
    </div>

    <p class="applicant-card__feedback" id="feedback-${user.uid}"></p>
  `;

  lucide.createIcons({ el: card });
  return card;
}


// ================================================
// APPROVE USER
// ================================================

/*
   Sets status → active and scrubs all verification fields from the
   user document. Updates userIndex, then deletes Storage photos.
   The Cloud Function also handles photo cleanup as a safety net —
   whichever runs first, the other becomes a no-op.
   Card disappears automatically via the onSnapshot listener.
*/

window.approveUser = async function(uid, barangay, name) {
  const ok = await showConfirm({ title: 'Approve Applicant?',
  body: `<strong>${name}</strong> will be able to sign in immediately.`,
  confirm: 'Approve', cancel: 'Go Back', variant: 'confirm' });
  if (!ok) return;

  const btn      = document.querySelector(`#card-${uid} .btn--success`);
  const feedback = document.getElementById(`feedback-${uid}`);
  btn.disabled    = true;
  btn.textContent = 'Approving…';

  try {
    await updateDoc(userDoc(barangay, uid), {
      status:     'active',
      approvedAt: serverTimestamp(),
      idNumber:   deleteField(),
      idType:     deleteField(),
      idFrontURL: deleteField(),
      idBackURL:  deleteField(),
    });

    await updateDoc(userIndexDoc(uid), {
      role:   'resident',
      status: 'active',
    });

    try {
      await deleteIdPhotos(barangay, uid);
    } catch (storageErr) {
      /* Non-fatal — photos may already be gone via Cloud Function */
      console.warn('Storage cleanup on approval:', storageErr.message);
    }

  } catch (err) {
    console.error('Approve failed:', err);
    btn.disabled  = false;
    btn.innerHTML = '<i data-lucide="check-circle"></i> Approve';
    feedback.textContent = 'Failed to approve. Try again.';
    feedback.style.color = 'red';
    lucide.createIcons({ el: btn });
  }
};


// ================================================
// REJECT USER
// ================================================

/*
   Deletes Storage photos then the user document.
   Deleting the document triggers the Cloud Function which
   removes the Auth account and userIndex entry.
   Card disappears automatically via the onSnapshot listener.
*/

window.rejectUser = async function(uid, barangay, name) {
  const ok = await showConfirm({ title: 'Reject Applicant?',
    body: `This will permanently delete <strong>${name}</strong>'s application.`,
    confirm: 'Reject', cancel: 'Go Back', variant: 'danger' });
  if (!ok) return;

  const btn      = document.querySelector(`#card-${uid} .btn--danger`);
  const feedback = document.getElementById(`feedback-${uid}`);
  btn.disabled    = true;
  btn.textContent = 'Rejecting…';

  try {
    await deleteIdPhotos(barangay, uid);
    await deleteDoc(userDoc(barangay, uid));

  } catch (err) {
    console.error('Reject failed:', err);
    btn.disabled  = false;
    btn.innerHTML = '<i data-lucide="x-circle"></i> Reject';
    feedback.textContent = 'Failed to reject. Try again.';
    feedback.style.color = 'red';
    lucide.createIcons({ el: btn });
  }
};
