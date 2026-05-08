/* ================================================
   nav-auth.js — BarangayConnect
   Shared auth resolver for all authenticated pages.
   Reads the user's role from Firestore, applies the
   body role class, updates the navbar role pill, and
   bootstraps notifications. Auto-runs on import.

   WHAT IS IN HERE:
     · Cached role application on load (no flash)
     · Auth state listener with role resolution
     · Body class and navbar pill updates
     · Notification bootstrap after auth resolves
     · Hamburger drawer toggle on DOMContentLoaded
     · Navbar transparency on scroll

   WHAT IS NOT IN HERE:
     · Notification rendering logic   → notifications.js
     · Auth initialization            → firebase-config.js
     · Firestore path helpers         → db-paths.js
     · Navbar styles                  → navbar.css

   REQUIRED IMPORTS:
     · ../core/firebase-config.js           (auth)
     · ./notifications.js             (initNotifications)
     · ../core/db-paths.js                  (userIndexDoc)
     · firebase-auth.js@10.12.0       (onAuthStateChanged)
     · firebase-firestore.js@10.12.0  (getDoc)

   QUICK REFERENCE:
     Init nav auth    → initNavAuth({ onResolved })
     Role application → _applyRole(role)
     Auto-runs        → initNavAuth() called on import
================================================ */


/* ================================================
   IMPORTS
================================================ */

import { auth } from '../core/firebase-config.js';
import { userIndexDoc } from '../core/db-paths.js';

import {
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import { initNotifications } from './notifications.js';

import {
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { barangayId as toBid } from '../core/db-paths.js';


/* ================================================
   INIT NAV AUTH
   Applies cached role immediately to prevent flash,
   then resolves the live role from Firestore once
   auth state is confirmed.
================================================ */

export function initNavAuth({ onResolved } = {}) {

  /* Apply cached role instantly while auth resolves */
  const cached = localStorage.getItem('bc_role');
  if (cached) _applyRole(cached);

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      localStorage.removeItem('bc_role');
      document.body.removeAttribute('data-role-init');
      return;
    }

    try {
      const snap     = await getDoc(userIndexDoc(user.uid));
      const role     = snap.exists() ? (snap.data().role || 'resident') : 'resident';
      const barangay = snap.data().barangay;

      localStorage.setItem('bc_role', role);
      _applyRole(role);

      /* Inject barangay name into community hero eyebrow if present */
      const _heroNameEl = document.getElementById('heroBarangayName');
      if (_heroNameEl && barangay) _heroNameEl.textContent = barangay.toUpperCase();

      /* Expose barangay + user globally so feature modules can read them */
      window._communityBid           = toBid(barangay);
      window._currentUid             = user.uid;
      window._currentUserRole        = role;
      window._communityBarangayName  = barangay;
      window._currentUserName = snap.data().fullName || snap.data().name || snap.data().displayName || '';

      initNotifications(toBid(barangay), user.uid);
      onResolved?.({ user, role, barangay });

      /* Signal all feature modules that auth + barangay are ready */
      window.dispatchEvent(new Event('bc:auth-ready'));

    } catch (_) {
      /* Non-fatal — body class and navbar may remain at cached state */
    } finally {
      document.body.removeAttribute('data-role-init');
    }
  });
}


/* ================================================
   APPLY ROLE
   Sets the body role class and updates the navbar
   role pill label and modifier class.
================================================ */

function _applyRole(role) {
  document.body.className = `role-${role}`;

  const navRoleEl = document.getElementById('navRole');
  if (!navRoleEl) return;

  const label = { resident: 'Resident', officer: 'Barangay Officer', admin: 'Admin' }[role] || 'Resident';
  navRoleEl.textContent = label;
  navRoleEl.className   = `navbar__role navbar__role--${role}`;
}


/* ================================================
   DOM — hamburger drawer + scroll transparency
================================================ */

document.addEventListener('DOMContentLoaded', () => {

  /* Mobile drawer toggle */
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const mobileDrawer = document.getElementById('mobileDrawer');

  if (hamburgerBtn && mobileDrawer) {
    hamburgerBtn.addEventListener('click', () => mobileDrawer.classList.toggle('is-open'));
  }

  /* Navbar transparency — removed past 60px scroll */
  const navbar = document.getElementById('mainNavbar');

  if (navbar) {
    window.addEventListener('scroll', () => {
      if (window.scrollY > 60) {
        navbar.classList.remove('navbar--transparent');
      } else {
        navbar.classList.add('navbar--transparent');
      }
    }, { passive: true });
  }
});


/* ================================================
   AUTO-RUN
   Executes on every page that imports this module.
================================================ */

initNavAuth();