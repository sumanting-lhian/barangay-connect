/* ================================================
   roles-admin.js — BarangayConnect
   Admin panel module for managing users and roles,
   scoped to the authenticated admin's barangay.
   Handles real-time user listing, role assignment,
   post limit overrides, and household grouping.

   Firestore path:
     barangays/{barangayId}/users/{uid}

   WHAT IS IN HERE:
     · Auth-gated initialization with admin role check
     · Real-time user list subscription and rendering
     · Role assignment modal with admin confirmation guard
     · Filter and search by role, name, email, or ID
     · Household grouping bar with filter support
     · Per-resident post limit override controls
     · Today's post count display per resident
     · Status indicator (online / recently active / offline)
     · JS tooltip system for role action buttons
     · Toast notification system

   WHAT IS NOT IN HERE:
     · Reported post moderation        → reported-posts-admin.js
     · Reported comment moderation     → reported-comments-admin.js
     · Admin panel layout and styles   → admin.css
     · Firebase config                 → firebase-config.js
     · Firestore path helpers          → db-paths.js

   REQUIRED IMPORTS:
     · ../../core/firebase-config.js           (auth, db)
     · ../../core/db-paths.js                  (usersCol, userDoc, userIndexDoc)
     · firebase-firestore.js@10.12.0  (query, where, onSnapshot,
                                       updateDoc, serverTimestamp, getDoc)
     · firebase-auth.js@10.12.0       (onAuthStateChanged)
     · Lucide Icons                   — loaded before this script

   QUICK REFERENCE:
     Init                → onAuthStateChanged (auto-runs on import)
     Tab switching       → window.switchTab(tab)
     Role filter         → window.setRoleFilter(role, btn)
     Search              → window.filterUsers()
     Role modal          → window.openRoleModal(...)
     Confirm role change → window.confirmRoleChange()
     Post limit save     → window.savePostLimit(uid)
     Household filter    → window.setHouseholdFilter(id)
     Badge element       → #reportedPostsBadge
     List element        → #usersTable
================================================ */


/* ================================================
   IMPORTS
================================================ */

import { auth, db } from '../../core/firebase-config.js';
import { usersCol, userDoc, userIndexDoc } from '../../core/db-paths.js';

import {
  query, where, onSnapshot,
  updateDoc, serverTimestamp, getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";


/* ================================================
   MODULE STATE
================================================ */

let allUsers         = [];
let currentFilter    = 'all';
let currentSearch    = '';
let adminBarangay    = '';
let adminUid         = '';
let currentHousehold = '';
let pendingChange    = null;

/* ================================================
   INIT — auth-gated, admin-only
   Resolves the barangay ID, writes lastSeen for
   the admin, then starts the user subscription.
   Silently exits for non-admin roles.
================================================ */

onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  const indexSnap = await getDoc(userIndexDoc(user.uid));
  if (!indexSnap.exists() || indexSnap.data().role !== 'admin') return;

  adminUid      = user.uid;
  adminBarangay = indexSnap.data().barangay || '';

  /* Record admin's last active timestamp */
  try {
    await updateDoc(userDoc(adminBarangay, user.uid), {
      lastSeen: serverTimestamp(),
    });
  } catch (e) {
    console.warn('lastSeen write failed:', e.message);
  }

  loadUsers();
});


/* ================================================
   LOAD USERS
   Subscribes in real time to all active users in
   the admin's barangay and triggers a re-render
   on every change.
================================================ */

function loadUsers() {
  const q = query(
    usersCol(adminBarangay),
    where('status', '==', 'active'),
  );

  onSnapshot(q, (snapshot) => {
    allUsers = [];

    snapshot.forEach((docSnap) => {
      const d = docSnap.data();
      allUsers.push({
        uid:               docSnap.id,
        fullName:          d.fullName ?? `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim(),
        email:             d.email    ?? '',
        phone:             d.phone    ?? '',
        role:              d.role     ?? 'resident',
        barangay:          d.barangay ?? '',
        residentIdNumber:  d.residentIdNumber ?? '—',
        streetAddress:     d.streetAddress    ?? '',
        householdId:       d.householdId      ?? '',
        createdAt:         d.createdAt,
        lastSeen:          d.lastSeen  ?? null,
        superAdmin:        d.superAdmin === true,
        postLimitOverride: typeof d.postLimitOverride === 'number' ? d.postLimitOverride : null,
      });
    });

    renderUsers();
  });
}


/* ================================================
   RENDER
   Applies active role filter, search query, and
   household filter to the user list, then builds
   and injects all user rows.
================================================ */

function renderUsers() {
  const table = document.getElementById('usersTable');
  let list    = [...allUsers];

  /* Role filter */
  if (currentFilter !== 'all') list = list.filter(u => u.role === currentFilter);

  /* Search filter — matches name, email, or resident ID */
  if (currentSearch) {
    const q      = currentSearch.toLowerCase();
    const qClean = q.replace(/-/g, '');
    list = list.filter(u => {
      const id      = (u.residentIdNumber ?? '').toLowerCase();
      const idClean = id.replace(/-/g, '');
      return (
        u.fullName.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q)    ||
        id.includes(q)                       ||
        idClean.includes(qClean)
      );
    });
  }

  /* Sort: current admin first, then alphabetically */
  list.sort((a, b) => {
    if (a.uid === adminUid) return -1;
    if (b.uid === adminUid) return  1;
    return a.fullName.localeCompare(b.fullName);
  });

  if (list.length === 0) {
    table.innerHTML = `<div class="users-empty">No users found.</div>`;
    lucide.createIcons({ el: table });
    return;
  }

  /* Household filter applied after sort */
  if (currentHousehold) {
    list = list.filter(u => u.householdId === currentHousehold);
  }

  table.innerHTML = list.map(u => buildUserRow(u)).join('');

  list.filter(u => u.role === 'resident').forEach(u => {
    loadTodayPostCount(u.uid, adminBarangay);
  });

  buildHouseholdBar();
  lucide.createIcons({ el: table });
  initTooltips();
}


/* ================================================
   BUILD USER ROW
   Constructs the full HTML for a single user row,
   including avatar, contact info, role badge,
   status indicator, role action buttons, and the
   post limit accordion for residents.
================================================ */

function buildUserRow(user) {
  const isMe         = user.uid === adminUid;
  const isSuperAdmin = user.superAdmin === true;

  const initials       = getInitials(user.fullName);
  const roleBadgeClass = `role-badge--${user.role}`;
  const joinDate       = user.createdAt?.toDate?.()
    ? user.createdAt.toDate().toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';

  const { statusClass, statusLabel } = getStatusInfo(user.lastSeen);

  const youChip = isMe
    ? `<span class="you-chip" title="You cannot change your own role">
         <i data-lucide="user-check"></i> You
       </span>`
    : '';

  const superBadge = isSuperAdmin
    ? `<span class="super-badge" title="Protected — cannot be modified by any admin">
         <i data-lucide="crown"></i> Protected
       </span>`
    : '';

  /* Builds a single role action button with appropriate state and tooltip */
  const makeBtn = (role, icon) => {
    const isCurrent    = user.role === role;
    const currentClass = isCurrent ? `current-role current-role--${role}` : '';
    const colorClass   = `role-action-btn--${role}`;
    let tooltip;
    let disabled = '';

    if (isSuperAdmin)   { disabled = 'disabled'; tooltip = 'Protected — cannot be modified'; }
    else if (isMe)      { disabled = 'disabled'; tooltip = "This is you — you can't change your own role"; }
    else if (isCurrent) { disabled = 'disabled'; tooltip = `Already ${roleDisplayName(role)}`; }
    else                { tooltip = `Set as ${roleDisplayName(role)}`; }

    const _rc  = { resident:'#15803d', officer:'#c2410c', admin:'#dc2626' }[role] ?? '#6b7280';
    const _rbd = isCurrent ? _rc : '#e0e0e0';
    const _rbg = isCurrent ? ({ resident:'#f0fdf4', officer:'#fff7ed', admin:'#fef2f2' }[role] ?? '#f9fafb') : '#fff';

    return `<button
      class="role-action-btn ${colorClass} ${currentClass}"
      data-tooltip="${tooltip}"
      onclick="openRoleModal('${user.uid}', '${escapeAttr(user.fullName)}', '${user.role}', '${role}', ${isSuperAdmin}, ${isMe})"
      ${disabled}
    style="width:32px;height:32px;border-radius:50%;style="width:32px;height:32px;border-radius:50%;border:1.5px solid ${_rbd};
    background:${_rbg};cursor:pointer;display:inline-flex;align-items:center;
    justify-content:center;color:${isCurrent ? _rc : '#d1d5db'};transition:all .15s;"
    ><i data-lucide="${icon}"></i></button>`;
  };

  return `
    <div class="user-row user-row--${user.role}" id="row-${user.uid}" ${isMe ? 'style="background:#f8fdf9"' : ''}>

      <div class="user-info">
        <div class="user-avatar user-avatar--${user.role}">${initials}</div>
        <div style="min-width:0;">
          <div class="user-name">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">
              ${escapeHtml(user.fullName)}
            </span>
            ${youChip}${superBadge}
          </div>
          <div class="user-since">Since ${joinDate}</div>
          <div style="font-size:0.72rem;color:#aaa;margin-top:2px;font-family:monospace;">
            ${escapeHtml(user.residentIdNumber)}
          </div>
        </div>
      </div>

      <div style="min-width:0;display:flex;flex-direction:column;gap:3px;overflow:hidden;">
        <span style="font-size:0.82rem;font-weight:500;white-space:nowrap;overflow:hidden;
          text-overflow:ellipsis;color:#333;">${escapeHtml(user.email)}</span>
        <span style="font-size:0.78rem;color:#999;">${escapeHtml(user.phone || '—')}</span>
        <span style="font-size:0.75rem;color:#bbb;white-space:nowrap;overflow:hidden;
          text-overflow:ellipsis;">${escapeHtml(user.streetAddress || '—')}</span>
      </div>

      <div class="role-badge ${roleBadgeClass}">
        <i data-lucide="${roleIconName(user.role)}"></i>
        ${{ resident: 'Resident', officer: 'Officer', admin: 'Admin' }[user.role] ?? user.role}
      </div>

      <div class="status-dot ${statusClass}">${statusLabel}</div>

      <div class="role-actions">
        ${makeBtn('resident', 'user')}
        ${makeBtn('officer',  'shield')}
        ${makeBtn('admin',    'settings')}
      </div>

      <div style="grid-column:1/-1;padding:.5rem 1.25rem .75rem;border-top:1px solid #f3f4f6;">
        ${user.role === 'resident' ? `
          <details>
            <summary style="cursor:pointer;font-size:.75rem;color:#9ca3af;font-weight:600;
              list-style:none;display:inline-flex;align-items:center;gap:.4rem;
              user-select:none;-webkit-user-select:none;">
              <i data-lucide="sliders-horizontal" style="width:12px;height:12px;"></i>
              Post limit &nbsp;·&nbsp;
              <span style="color:#374151;font-weight:700;">${
                user.postLimitOverride === -1 ? 'Unlimited'
                : user.postLimitOverride != null ? `${user.postLimitOverride}/day`
                : '3/day (default)'
              }</span>
              &nbsp;·&nbsp;
              <span id="plimit-today-${user.uid}" style="color:#6b7280;font-weight:500;">checking…</span>
            </summary>
            <div style="display:flex;align-items:center;gap:.6rem;margin-top:.6rem;flex-wrap:wrap;
              padding:.6rem .75rem;background:#f9fafb;border-radius:8px;border:1px solid #f0f0f0;">
              <label style="font-size:.75rem;color:#6b7280;font-weight:500;">Daily limit:</label>
              <input type="number" min="-1" max="99"
                id="plimit-${user.uid}"
                value="${user.postLimitOverride ?? 3}"
                style="width:60px;padding:4px 8px;border:1.5px solid #e0e0e0;border-radius:7px;
                  font-size:.82rem;text-align:center;outline:none;font-weight:600;" />
              <span style="font-size:.72rem;color:#aaa;">(-1 = unlimited)</span>
              <button onclick="savePostLimit('${user.uid}')"
                style="padding:4px 12px;border-radius:7px;background:#1a3a1a;color:#fff;
                  border:none;font-size:.75rem;font-weight:600;cursor:pointer;
                  transition:background .15s;"
                onmouseover="this.style.background='#14291a'"
                onmouseout="this.style.background='#1a3a1a'">
                Save
              </button>
              <span id="plimit-status-${user.uid}"
                style="font-size:.72rem;color:#22c55e;font-weight:600;"></span>
            </div>
          </details>`
        : `<span style="font-size:.72rem;color:#aaa;">Unlimited Posts (${user.role.toUpperCase()})</span>`}
      </div>

    </div>`;
}


/* ================================================
   TOOLTIPS
   Attaches hover-based tooltip positioning to all
   elements with a data-tooltip attribute. Called
   after each render to reflect the updated DOM.
================================================ */

function initTooltips() {
  const tip = document.getElementById('adminTooltip');

  document.querySelectorAll('[data-tooltip]').forEach(el => {
    el.addEventListener('mouseenter', () => {
      const text = el.getAttribute('data-tooltip');
      if (!text) return;
      tip.textContent = text;
      tip.classList.add('visible');
      positionTooltip(tip, el);
    });

    el.addEventListener('mousemove', () => positionTooltip(tip, el));

    el.addEventListener('mouseleave', () => {
      tip.classList.remove('visible');
    });
  });
}

/* Centers the tooltip above the anchor, clamping to viewport edges */
function positionTooltip(tip, anchor) {
  const rect   = anchor.getBoundingClientRect();
  const tipW   = tip.offsetWidth;
  const tipH   = tip.offsetHeight;
  const margin = 8;

  let left = rect.left + rect.width / 2 - tipW / 2;
  let top  = rect.top - tipH - margin;

  const vw = window.innerWidth;
  if (left < margin)            left = margin;
  if (left + tipW > vw - margin) left = vw - margin - tipW;

  /* Flip below anchor if tooltip would clip above the viewport */
  if (top < margin) top = rect.bottom + margin;

  tip.style.left = `${left}px`;
  tip.style.top  = `${top}px`;
}


/* ================================================
   STATUS
   Resolves a user's online status based on the
   elapsed time since their lastSeen timestamp.
================================================ */

function getStatusInfo(lastSeen) {
  return { statusClass: 'status-dot--offline', statusLabel: '' };

  const seenDate   = lastSeen?.toDate?.() ?? new Date(lastSeen);
  const minutesAgo = (Date.now() - seenDate.getTime()) / 60000;

  if (minutesAgo <= 5)  return { statusClass: 'status-dot--online',  statusLabel: 'Online' };
  if (minutesAgo <= 60) return { statusClass: 'status-dot--recent',  statusLabel: 'Recently active' };
                        return { statusClass: 'status-dot--offline', statusLabel: '' };
}


/* ================================================
   FILTER + SEARCH
================================================ */

window.setRoleFilter = function (role, btn) {
  currentFilter = role;
  document.querySelectorAll('.role-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderUsers();
};

window.filterUsers = function () {
  currentSearch = document.getElementById('rolesSearch').value.trim();
  renderUsers();
};


/* ================================================
   ROLE MODAL
   Opens the role assignment confirmation modal.
   Adds an extra typed confirmation step when
   promoting a user to admin.
================================================ */

window.openRoleModal = function (uid, name, currentRole, newRole, isSuperAdmin, isMe) {
  if (currentRole === newRole || isSuperAdmin || isMe) return;

  pendingChange = { uid, name, currentRole, newRole };

  const icon       = document.getElementById('modalIcon');
  const iconInner  = document.getElementById('modalIconInner');
  const confirmBtn = document.getElementById('modalConfirmBtn');
  const adminWrap  = document.getElementById('adminConfirmWrap');
  const adminInput = document.getElementById('adminConfirmInput');

  icon.className = `modal__icon modal__icon--${newRole}`;
  iconInner.setAttribute('data-lucide', roleIconName(newRole));
  lucide.createIcons({ el: icon });

  document.getElementById('modalTitle').textContent = `Assign as ${roleDisplayName(newRole)}`;

  document.getElementById('modalBody').innerHTML =
    `You are about to change <strong>${escapeHtml(name)}</strong>'s role
     from <strong>${roleDisplayName(currentRole)}</strong>
     to <strong>${roleDisplayName(newRole)}</strong>.
     ${newRole === 'admin'
       ? `<br><br>⚠️ <strong>Administrator access grants full control</strong> over this barangay panel.
          Only assign this to someone you fully trust.`
       : 'This takes effect immediately.'
     }`;

  if (newRole === 'admin') {
    adminWrap.classList.add('visible');
    adminInput.value = '';
    adminInput.classList.remove('error');
    confirmBtn.disabled = true;
    confirmBtn.classList.add('admin-confirm');
    confirmBtn.textContent = 'Assign as Admin';
  } else {
    adminWrap.classList.remove('visible');
    confirmBtn.disabled = false;
    confirmBtn.classList.remove('admin-confirm');
    confirmBtn.textContent = `Assign as ${roleDisplayName(newRole)}`;
  }

  document.getElementById('roleModal').classList.add('visible');
};

window.closeModal = function () {
  document.getElementById('roleModal').classList.remove('visible');
  pendingChange = null;
};

/* Validates the typed admin confirmation and enables the confirm button */
window.onAdminConfirmInput = function () {
  const input = document.getElementById('adminConfirmInput');
  const btn   = document.getElementById('modalConfirmBtn');
  const valid = input.value.trim() === 'CONFIRM ADMIN';
  btn.disabled = !valid;
  input.classList.toggle('error', input.value.length > 0 && !valid);
};

/* Close modal on backdrop click */
document.getElementById('roleModal').addEventListener('click', function (e) {
  if (e.target === this) closeModal();
});


/* ================================================
   CONFIRM ROLE CHANGE
   Writes the new role to both the barangay user
   doc and the user index doc, then shows a toast.
================================================ */

window.confirmRoleChange = async function () {
  if (!pendingChange) return;

  const { uid, name, newRole } = pendingChange;
  const btn = document.getElementById('modalConfirmBtn');
  btn.disabled    = true;
  btn.textContent = 'Saving…';

  try {
    await updateDoc(userDoc(adminBarangay, uid), {
      role:          newRole,
      roleUpdatedAt: serverTimestamp(),
    });
    await updateDoc(userIndexDoc(uid), { role: newRole });

    closeModal();
    showToast(`${name} is now a ${roleDisplayName(newRole)}.`, 'success');
  } catch (err) {
    console.error('Role update failed:', err);
    closeModal();
    showToast('Failed to update role. Try again.', 'error');
  }
};


/* ================================================
   TOAST
   Renders a dismissing toast notification in the
   designated container, auto-removed after 3.5s.
================================================ */

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast     = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <i data-lucide="${type === 'success' ? 'check-circle' : 'alert-circle'}"></i>
    ${escapeHtml(message)}
  `;
  container.appendChild(toast);
  lucide.createIcons({ el: toast });

  setTimeout(() => {
    toast.style.opacity   = '0';
    toast.style.transform = 'translateY(12px)';
    toast.style.transition = 'opacity 0.3s, transform 0.3s';
    setTimeout(() => toast.remove(), 350);
  }, 3500);
}


/* ================================================
   HOUSEHOLD
   Builds the household filter bar from users who
   share a householdId. Hides the bar when empty.
================================================ */

window.toggleHouseholdPanel = function () {
  const panel   = document.getElementById('householdPanel');
  const chevron = document.getElementById('householdChevron');
  const isOpen  = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'flex';
  panel.style.flexWrap = 'wrap';
  panel.style.gap = 'var(--space-sm)';
  if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
};

window.setHouseholdFilter = function (id) {
  currentHousehold = id;
  renderUsers();
};

function buildHouseholdBar() {
  const bar = document.getElementById('householdBar');
  if (!bar) return;

  /* Count members per household */
  const counts = {};
  allUsers.forEach(u => {
    if (u.householdId) counts[u.householdId] = (counts[u.householdId] || 0) + 1;
  });

  /* Only show households with 2+ members */
  const grouped = Object.keys(counts).filter(id => counts[id] >= 2);

  const section = bar.closest('div[style]') ?? bar.parentElement;

  const householdSection = document.getElementById('householdSection');
  const householdCount   = document.getElementById('householdCount');

  if (grouped.length === 0 && !currentHousehold) {
    if (householdSection) householdSection.style.display = 'none';
    bar.innerHTML = '';
    return;
  }

  if (householdSection) householdSection.style.display = '';
  if (householdCount)   householdCount.textContent = `(${grouped.length})`;

  bar.innerHTML = grouped.map(hid => {
    const count   = counts[hid];
    const address = allUsers.find(u => u.householdId === hid)?.streetAddress || hid;
    const active  = currentHousehold === hid
      ? 'style="background:#1a3a1a;color:white;border-color:#1a3a1a"'
      : '';
    return `<button class="role-filter-btn" onclick="setHouseholdFilter('${hid}')" ${active}>
      <i data-lucide="home"></i> ${escapeHtml(address)}&nbsp;<strong>(${count})</strong>
    </button>`;
  }).join('') + (currentHousehold
    ? `<button class="role-filter-btn" onclick="setHouseholdFilter('')">
         <i data-lucide="x"></i> Clear
       </button>`
    : '');

  lucide.createIcons({ el: bar });
}


/* ================================================
   POST LIMIT
   Saves a per-resident daily post limit override
   to Firestore. Accepts -1 for unlimited.
================================================ */

window.savePostLimit = async function (uid) {
  const input = document.getElementById(`plimit-${uid}`);
  if (!input) return;

  const val = parseInt(input.value, 10);
  if (isNaN(val) || val < -1 || val > 99) {
    input.style.borderColor = '#dc2626';
    setTimeout(() => input.style.borderColor = '#e0e0e0', 1500);
    return;
  }

  try {
    const { updateDoc: _up, doc: _d } =
      await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

    await _up(_d(db, 'barangays', adminBarangay, 'users', uid), {
      postLimitOverride: val,
    });

    input.style.borderColor = '#22c55e';

    const statusEl = document.getElementById(`plimit-status-${uid}`);
    if (statusEl) {
      statusEl.textContent = 'Saved ✓';
      setTimeout(() => statusEl.textContent = '', 2000);
    }

    setTimeout(() => input.style.borderColor = '#e0e0e0', 1500);
  } catch (err) {
    console.error('[roles] post limit save:', err);
  }
};


/* ================================================
   TODAY'S POST COUNT
   Fetches how many community posts a resident has
   made today and displays the remaining allowance
   below the post limit control.
================================================ */

async function loadTodayPostCount(uid, barangay) {
  const label = document.getElementById(`plimit-today-${uid}`);
  if (!label) return;

  try {
    const { collection: _col, query: _q, where: _w, getDocs, limit: _lim } =
      await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

    const today = new Date().toISOString().slice(0, 10);
    const start = new Date(today + 'T00:00:00');
    const end   = new Date(today + 'T23:59:59');

    const snap  = await getDocs(_q(
      _col(db, 'barangays', barangay, 'communityPosts'),
      _w('authorId', '==', uid),
      _lim(20),
    ));

    const count = snap.docs.filter(d => {
      const t = d.data().createdAt?.toDate?.() ?? new Date(0);
      return t >= start && t <= end;
    }).length;

    /* Resolve effective limit — check barangay settings for default */
    const user       = allUsers.find(u => u.uid === uid);
    let defaultLim   = 3;

    try {
      const { getDoc: _gd2, doc: _d2 } =
        await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
      const sSnap = await _gd2(_d2(db, 'barangays', barangay, 'meta', 'settings'));
      if (sSnap.exists()) defaultLim = sSnap.data().defaultPostLimit ?? 3;
    } catch { /* fall back to 3 */ }

    const lim = user?.postLimitOverride === -1    ? Infinity
      : user?.postLimitOverride != null ? user.postLimitOverride
      : defaultLim;

    const remaining = lim === Infinity ? '∞' : Math.max(0, lim - count);

    label.textContent = remaining === 0
      ? 'No posts remaining today'
      : `${remaining} post${remaining === 1 ? '' : 's'} left today`;

    label.style.color = remaining === 0   ? '#dc2626'
      : remaining === 1 ? '#f59e0b'
      : '#6b7280';
  } catch {
    label.textContent = '';
  }
}


/* ================================================
   UTILITIES
================================================ */

/* Returns up to two uppercase initials from a full name */
function getInitials(name) {
  return name.split(' ').slice(0, 2).map(n => n[0] ?? '').join('').toUpperCase();
}

/* Maps a role key to its display label */
function roleDisplayName(role) {
  return { resident: 'Resident', officer: 'Barangay Officer', admin: 'Administrator' }[role] ?? role;
}

/* Maps a role key to its Lucide icon name */
function roleIconName(role) {
  return { resident: 'user', officer: 'shield', admin: 'settings' }[role] ?? 'user';
}

/* Escapes a value for safe inline HTML use */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

/* Escapes single quotes for use inside HTML attribute values */
function escapeAttr(str) {
  return String(str).replace(/'/g, "\\'");
}