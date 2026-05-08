/* ================================================
   polls-admin.js — BarangayConnect
   Official and admin management for community polls.
   Handles create, edit, publish, close, soft-delete,
   pin/unpin, deadline extension, and analytics.

   Firestore path:
     barangays/{barangayId}/polls/{pollId}
     barangays/{barangayId}/polls/{pollId}/poll_actions/{id}

   WHAT IS IN HERE:
     · onAuthStateChanged bootstrap — resolves barangay, role
     · Real-time polls listener (all non-deleted polls)
     · Poll list renderer with role-gated action buttons
     · Create / edit form — dynamic options, date pickers
     · Integrity guard — question + options locked once votes exist
     · Publish — draft → active
     · Extend deadline — reason required, logged to poll_actions
     · Close early — admin only, confirmation required
     · Soft delete — admin only, isDeleted flag, warns if has votes
     · Pin / unpin — admin only
     · Inline analytics — per-option breakdown (anonymous)
     · Poll action logger (logPollAction)
     · Toast and esc utilities

   WHAT IS NOT IN HERE:
     · Resident vote submission UI       → community-polls.js
     · Poll styles                       → polls.css
     · Firebase config                   → firebase-config.js
     · Firestore poll path helpers       → db-paths.js

   REQUIRED IMPORTS:
     · ../../core/firebase-config.js     (auth, db)
     · ../../core/db-paths.js            (userIndexDoc, barangayId as toBid,
                                          pollsCol, pollDoc, pollActionsCol)
     · firebase-firestore.js@10.12.0
     · firebase-auth.js@10.12.0

   QUICK REFERENCE:
     Open create form  → window.openPollForm()
     Edit poll         → window.editPoll(pollId)
     Publish poll      → window.publishPoll(pollId)
     Extend deadline   → window.extendDeadline(pollId)
     Close poll        → window.closePoll(pollId)
     Delete poll       → window.deletePoll(pollId, hasVotes)
     Toggle pin        → window.togglePinPoll(pollId, isPinned)
     View analytics    → window.viewPollAnalytics(pollId)
================================================ */


// ================================================
// IMPORTS
// ================================================

import { auth, db }                          from '../../core/firebase-config.js';
import {
  userIndexDoc, barangayId as toBid,
  pollsCol, pollDoc, pollActionsCol,
} from '../../core/db-paths.js';

import {
  onSnapshot, query, where, orderBy,
  getDoc, addDoc, updateDoc, deleteDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import { notifyAllInBarangay } from '../../shared/notifications.js';
import { showConfirm } from '/js/shared/confirm-modal.js';


// ================================================
// MODULE STATE
// ================================================

let _bid   = null; // barangayId string (path-safe)
let _uid   = null;
let _role  = null; // 'officer' | 'admin'
let _polls = [];   // latest snapshot array
let _editId = null; // pollId being edited; null = create mode
let _adminTab      = 'active';   // 'active' | 'archived'
let _adminFilter   = 'all';      // 'all' | 'draft' | 'active' | 'closed' | 'scheduled'
let _archivedPolls = [];

const _ROLE_OPTS = [
  { value: 'all',       label: 'Everyone'        },
  { value: 'residents', label: 'Residents only'  },
  { value: 'officials', label: 'Officials only'  },
];

const _GROUP_OPTS = [
  { value: 'all',        label: 'All ages / groups' },
  { value: 'youth',      label: 'Youth (15–30)'     },
  { value: 'adult',      label: 'Adults (31–59)'    },
  { value: 'senior',     label: 'Seniors (60+)'     },
  { value: 'custom_age', label: 'Custom age range'  },
];

const _CAT_COLORS = {
  announcements:  { bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
  health:         { bg: '#f0fdf4', color: '#166534', border: '#bbf7d0' },
  infrastructure: { bg: '#fffbeb', color: '#92400e', border: '#fde68a' },
  safety:         { bg: '#fef2f2', color: '#991b1b', border: '#fecaca' },
  events:         { bg: '#f5f3ff', color: '#6d28d9', border: '#ddd6fe' },
  livelihood:     { bg: '#fff7ed', color: '#9a3412', border: '#fed7aa' },
  youth:          { bg: '#fdf4ff', color: '#7e22ce', border: '#e9d5ff' },
  environment:    { bg: '#f0fdf4', color: '#065f46', border: '#6ee7b7' },
  general:        { bg: '#f0fdfa', color: '#0f766e', border: '#99f6e4' },
};


// ================================================
// BOOTSTRAP
// ================================================

/*
   Resolves the officer/admin's barangay from userIndex.
   Guards: only officer and admin roles proceed.
   Starts real-time listener and renders the shell on success.
*/
onAuthStateChanged(auth, async user => {
  if (!user) return;

  const snap = await getDoc(userIndexDoc(user.uid));
  if (!snap.exists()) return;

  const { barangay, role } = snap.data();
  if (role !== 'admin' && role !== 'officer') return;

  _uid  = user.uid;
  _role = role;
  _bid  = toBid(barangay);

  _renderShell();
  _listenPolls();
});


// ================================================
// SUBSCRIPTION
// ================================================

/*
   Listens to all non-deleted polls — includes drafts which are
   invisible to residents but visible in the admin panel.
   Ordered newest first.
*/
function _listenPolls() {
  const q = query(
    pollsCol(_bid),
    where('isDeleted', '==', false),
    orderBy('createdAt', 'desc'),
  );

  onSnapshot(q, snap => {
    _polls = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderList();
  });

  onSnapshot(
    query(pollsCol(_bid), where('isDeleted', '==', true), orderBy('createdAt', 'desc')),
    snap => { _archivedPolls = snap.docs.map(d => ({ id: d.id, ...d.data() })); _renderList(); },
  );
}


// ================================================
// RENDER — Shell
// ================================================

/*
   Injects the polls panel structure into #community-sub-polls.
   Called once on bootstrap; the list container is updated
   by every snapshot via _renderList().
*/
function _renderShell() {
  const el = document.getElementById('community-sub-polls');
  if (!el) return;

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;
      margin-bottom:1.25rem;flex-wrap:wrap;gap:.75rem;">
      <h1 style="font-size:var(--text-3xl);font-weight:var(--fw-black);margin:0;letter-spacing:-0.025em;font-family:var(--font-display);line-height:1;">Community Polls</h1>
      <button onclick="window.openPollForm()"
        style="display:inline-flex;align-items:center;gap:.4rem;padding:.5rem 1.1rem;
          border-radius:8px;background:#1a3a1a;color:#fff;border:none;
          font-size:.85rem;font-weight:600;cursor:pointer;">
        <i data-lucide="plus"></i> Create Poll
      </button>
    </div>

    <div class="admin-subtab-row" style="margin-bottom:.75rem;">
      <button class="bulletin-section-btn admin-subtab-btn active" onclick="window._pollAdminTab('active',this)">
        <i data-lucide="bar-chart-2" style="width:14px;height:14px;"></i> Active &amp; Closed
      </button>
      <button class="bulletin-section-btn admin-subtab-btn" onclick="window._pollAdminTab('archived',this)">
        <i data-lucide="archive" style="width:14px;height:14px;"></i> Archived
        <span id="pollArchivedCount" style="display:none;background:rgba(0,0,0,.08);
          border-radius:999px;padding:0 6px;font-size:.68rem;font-weight:700;"></span>
      </button>
    </div>

    <div id="pollFilterRow" style="display:inline-flex;background:var(--alpha-ink-07);
      border-radius:var(--radius-full);padding:3px;gap:2px;margin-bottom:1.25rem;">
      <button class="bulletin-view-btn admin-subtab-btn is-active" onclick="window._pollAdminFilter('all',this)">All</button>
      <button class="bulletin-view-btn admin-subtab-btn" onclick="window._pollAdminFilter('active',this)">
        <i data-lucide="circle-dot" style="width:11px;height:11px;"></i> Active
      </button>
      <button class="bulletin-view-btn admin-subtab-btn" onclick="window._pollAdminFilter('draft',this)">
        <i data-lucide="file" style="width:11px;height:11px;"></i> Draft
      </button>
      <button class="bulletin-view-btn admin-subtab-btn" onclick="window._pollAdminFilter('closed',this)">
        <i data-lucide="square" style="width:11px;height:11px;"></i> Closed
      </button>
      <button class="bulletin-view-btn admin-subtab-btn" onclick="window._pollAdminFilter('scheduled',this)">
        <i data-lucide="calendar-clock" style="width:11px;height:11px;"></i> Scheduled
      </button>
    </div>

    <div id="pollFormWrap" style="margin-bottom:1.5rem;"></div>
    <div id="pollAdminList" style="display:flex;flex-direction:column;gap:1rem;"></div>`;

  lucide.createIcons({ el });
}


// ================================================
// RENDER — Poll List
// ================================================

function _renderList() {
  const el = document.getElementById('pollAdminList');
  if (!el) return;

  /* Update archived badge */
  const archBadge = document.getElementById('pollArchivedCount');
  if (archBadge) {
    archBadge.textContent  = _archivedPolls.length;
    archBadge.style.display = _archivedPolls.length ? 'inline' : 'none';
  }

  /* Hide filter row on archived tab */
  const filterRow = document.getElementById('pollFilterRow');
  if (filterRow) filterRow.style.display = _adminTab === 'archived' ? 'none' : 'inline-flex';

  const source = _adminTab === 'archived' ? _archivedPolls : _polls;
  const shown  = (_adminFilter === 'all' || _adminTab === 'archived')
    ? source
    : source.filter(p => p.status === _adminFilter);

  if (!shown.length) {
    el.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:3rem;text-align:center;
        color:#aaa;box-shadow:0 1px 4px rgba(0,0,0,.07);">
        <i data-lucide="archive" style="width:32px;height:32px;color:#d1d5db;display:block;margin:0 auto .75rem;"></i>
        <p style="margin:0;font-size:.9rem;">${_adminTab === 'archived' ? 'No archived polls.' : 'No polls match this filter.'}</p>
      </div>`;
    lucide.createIcons({ el });
    return;
  }

  el.innerHTML = shown.map(p => _buildPollRow(p, _adminTab === 'archived')).join('');
  lucide.createIcons({ el });
}


// ================================================
// BUILD — Poll Row
// ================================================

function _buildPollRow(p, isArchived = false) {
  const total    = p.totalVotes ?? 0;
  const hasVotes = total > 0;
  const isAdmin  = _role === 'admin';

  const displayStatus = isArchived ? 'closed' : p.status;
  const statusColor = { draft: '#f59e0b', active: '#16a34a', closed: '#6b7280', scheduled: '#6366f1' }[displayStatus] ?? '#6b7280';

  const scheduledFor = p.status === 'scheduled' && p.startDate
    ? p.startDate.toDate?.()?.toLocaleDateString('en-PH', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      }) ?? '—'
    : null;

  const deadline = p.endDate?.toDate?.()?.toLocaleDateString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) ?? '—';

  const canEdit = !isArchived && (p.status === 'draft' || (p.status === 'active' && !hasVotes));

  /* Archived polls are read-only — only analytics is shown */
  const editBtn     = (!isArchived && canEdit) ? _btn('pencil', 'Edit', `window.editPoll('${esc(p.id)}')`, '') : '';
  const publishBtn  = (!isArchived && (p.status === 'draft' || p.status === 'scheduled')) ? _btn('send', 'Publish Now', `window.publishPoll('${esc(p.id)}')`, 'green') : '';
  const extendBtn   = (!isArchived && p.status === 'active' && hasVotes) ? _btn('calendar-plus', 'Extend', `window.extendDeadline('${esc(p.id)}')`, '') : '';
  const pinBtn      = (!isArchived && isAdmin) ? _btn(p.isPinned ? 'pin-off' : 'pin', p.isPinned ? 'Unpin' : 'Pin', `window.togglePinPoll('${esc(p.id)}',${!!p.isPinned})`, p.isPinned ? 'amber' : '') : '';
  const closeBtn    = (!isArchived && isAdmin && p.status === 'active') ? _btn('square', 'Close', `window.closePoll('${esc(p.id)}')`, 'red') : '';
  const analyticsBtn = hasVotes ? _btn('bar-chart-2', 'Analytics', `window.viewPollAnalytics('${esc(p.id)}')`, 'blue') : '';
  const deleteBtn   = (!isArchived && isAdmin) ? _btn('trash-2', hasVotes ? 'Archive' : 'Delete', `window.deletePoll('${esc(p.id)}',${hasVotes})`, 'red') : '';

  const audienceLabel = {
    all: null, residents: 'Residents', officials: 'Officials',
    youth: 'Youth', seniors: 'Seniors',
    household_heads: 'Household Heads', registered_voters: 'Reg. Voters',
    custom_age: p.minAge != null || p.maxAge != null
      ? `Age ${p.minAge ?? 0}–${p.maxAge ?? '∞'}` : 'Custom Age',
  }[p.targetAudience ?? 'all'];

  const roleLabel = { all: null, residents: 'Residents', officials: 'Officials' }[p.targetRoles ?? 'all'];
  const groupLabel = {
    all: null, youth: 'Youth', adult: 'Adults', senior: 'Seniors',
    custom_age: p.minAge != null || p.maxAge != null
      ? `Age ${p.minAge ?? 0}–${p.maxAge ?? '∞'}` : 'Custom Age',
  }[p.targetGroups ?? 'all'];

  const _rolePill = roleLabel ? (() => {
    const s = p.targetRoles === 'residents'
      ? 'background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;'
      : 'background:#fff8ed;color:#92400e;border:1px solid #fed7aa;';
    return `<span class="admin-badge" style="${s}"><i data-lucide="users" style="width:10px;height:10px;"></i>${roleLabel}</span>`;
  })() : '';
  const _grpStylesA = {
    youth:      'background:#faf5ff;color:#7c3aed;border:1px solid #e9d5ff;',
    adult:      'background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;',
    senior:     'background:#fef3c7;color:#854d0e;border:1px solid #fed7aa;',
    custom_age: 'background:#f3f4f6;color:#6b7280;border:1px solid #e5e7eb;',
  };
  const _groupPill = groupLabel ? (() => {
    const s = _grpStylesA[p.targetGroups] || 'background:#f3f4f6;color:#6b7280;border:1px solid #e5e7eb;';
    return `<span class="admin-badge" style="${s}"><i data-lucide="users" style="width:10px;height:10px;"></i>${groupLabel}</span>`;
  })() : '';
  const audienceBadge = _rolePill + _groupPill;

  const optPreview = Object.values(p.options ?? {})
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(o => `<span style="font-size:.75rem;color:#6b7280;">· ${esc(o.optionText)}</span>`)
    .join(' ');

  return `
    <div style="background:#fff;border-radius:12px;padding:1.25rem;
      box-shadow:0 1px 4px rgba(0,0,0,.07);border-left:3px solid ${statusColor};">

      <div style="margin-bottom:.75rem;">
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.25rem;">
          <span style="font-weight:700;font-size:.95rem;">${esc(p.title)}</span>
          <span class="admin-badge admin-badge--${displayStatus}">${displayStatus.toUpperCase()}</span>
          ${scheduledFor ? `<span class="admin-badge" style="background:#eef2ff;color:#4338ca;border:1px solid #c7d2fe;">
            <i data-lucide="calendar-clock" style="width:10px;height:10px;"></i> Goes live ${scheduledFor}
          </span>` : ''}
          ${audienceBadge}${p.isPinned ? `<span class="admin-badge admin-badge--pinned"><i data-lucide="pin"></i> Pinned</span>` : ''}
          ${p.category ? (() => { const c = _CAT_COLORS[p.category] ?? _CAT_COLORS.general;
            return `<span style="background:${c.bg};color:${c.color};border:1px solid ${c.border};padding:2px
            8px;border-radius:999px;font-size:.68rem;font-weight:600;">${p.category.charAt(0).toUpperCase()+p.category.slice(1)}</span>`; })() : ''}
          ${p.priority && p.priority !== 'normal' ? `<span class="admin-badge admin-badge--${p.priority === 'urgent' ? 'urgent' : 'high'}">${esc(p.priority).toUpperCase()}</span>` : ''}
        </div>
        <p style="font-size:.75rem;color:#9ca3af;margin:0 0 .3rem;">
          Deadline: ${deadline} · ${total.toLocaleString()} vote${total !== 1 ? 's' : ''}
        </p>
        <div style="display:flex;gap:.4rem;flex-wrap:wrap;">${optPreview}</div>
      </div>

      <div style="display:flex;gap:.4rem;flex-wrap:wrap;">
        ${editBtn}${publishBtn}${extendBtn}${pinBtn}${closeBtn}${analyticsBtn}${deleteBtn}
      </div>

      <div id="analytics_${esc(p.id)}" style="display:none;margin-top:1rem;"></div>
    </div>`;
}

/*
   Tiny button builder — keeps _buildPollRow readable.
   color: '' = neutral gray, 'green' | 'red' | 'blue' | 'amber'
*/
function _btn(icon, label, onclick, color) {
  const styles = {
    '':      'background:#f3f4f6;color:#374151;border:1.5px solid #e5e7eb;',
    green:   'background:#1a3a1a;color:#fff;border:none;',
    red:     'background:#fff;color:#dc2626;border:1.5px solid #fca5a5;',
    blue:    'background:#eff6ff;color:#1d4ed8;border:1.5px solid #bfdbfe;',
    amber:   'background:#fef3c7;color:#92400e;border:1.5px solid #fde68a;',
  };
  return `
    <button onclick="${onclick}"
      style="display:inline-flex;align-items:center;gap:.35rem;padding:.4rem .85rem;
        border-radius:8px;${styles[color] ?? styles['']}
        font-size:.8rem;font-weight:600;cursor:pointer;">
      <i data-lucide="${icon}" style="width:12px;height:12px;"></i> ${label}
    </button>`;
}


// ================================================
// POLL FORM — Create / Edit
// ================================================

window.openPollForm = function (prefill = null) {
  _editId = prefill?.id ?? null;
  const wrap = document.getElementById('pollFormWrap');
  if (!wrap) return;
  const isAdmin  = _role === 'admin';
  const hasVotes = (prefill?.totalVotes ?? 0) > 0;

  /* Build existing options list for edit pre-fill */
  const existingOpts = prefill
    ? Object.entries(prefill.options ?? {})
        .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0))
        .map(([, o]) => o.optionText)
    : ['', ''];

  const optsHtml = existingOpts.map((t, i) => _buildOptionField(i, t, hasVotes)).join('');

  const fmtDate = ts => {
    if (!ts) return '';
    const d = ts.toDate?.() ?? new Date(ts);
    const offset = d.getTimezoneOffset() * 60000;
    return new Date(d - offset).toISOString().slice(0, 16);
  };

  const cats = ['general','health','infrastructure','safety','events','livelihood','youth','environment'];
  const catOpts = cats.map(c =>
    `<option value="${c}" ${(prefill?.category ?? 'general') === c ? 'selected' : ''}>
      ${c.charAt(0).toUpperCase() + c.slice(1)}</option>`
  ).join('');

  const priOpts = ['normal','high','urgent'].map(v =>
    `<option value="${v}" ${(prefill?.priority ?? 'normal') === v ? 'selected' : ''}>
      ${v.charAt(0).toUpperCase() + v.slice(1)}</option>`
  ).join('');

  const disabled = hasVotes ? 'disabled style="background:#f9fafb;color:#9ca3af;"' : '';

  wrap.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:1.5rem;
      box-shadow:0 1px 6px rgba(0,0,0,.1);border:1.5px solid #e5e7eb;">

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem;">
        <h2 style="font-size:1rem;font-weight:700;margin:0;">${_editId ? 'Edit Poll' : 'Create Poll'}</h2>
        <button onclick="window.closePollForm()"
          style="background:none;border:none;cursor:pointer;color:#9ca3af;font-size:1.1rem;padding:4px;">
          ✕
        </button>
      </div>

      ${hasVotes ? `
        <div style="display:flex;align-items:center;gap:.5rem;background:#fef9c3;
          border:1px solid #fde68a;border-radius:8px;padding:.6rem .85rem;
          font-size:.78rem;color:#92400e;margin-bottom:1rem;">
          <i data-lucide="alert-triangle" style="width:14px;height:14px;flex-shrink:0;"></i>
          Editing is disabled for the question and options because this poll already has
          active participants to ensure data integrity.
        </div>` : ''}

      <div style="display:flex;flex-direction:column;gap:1rem;">

        <div>
          <label style="display:block;font-size:.78rem;font-weight:600;color:#374151;margin-bottom:.3rem;">
            Question / Title *
          </label>
          <input id="pf_title" type="text" value="${esc(prefill?.title ?? '')}" ${disabled}
            placeholder="e.g. What new facility would you like most?"
            style="width:100%;padding:.55rem .8rem;border:1.5px solid #e5e7eb;
              border-radius:8px;font-size:.875rem;outline:none;box-sizing:border-box;" />
        </div>

        <div>
          <label style="display:block;font-size:.78rem;font-weight:600;color:#374151;margin-bottom:.3rem;">
            Description <span style="font-weight:400;color:#9ca3af;">(optional)</span>
          </label>
          <textarea id="pf_desc" rows="2"
            placeholder="Additional context for residents…"
            style="width:100%;padding:.55rem .8rem;border:1.5px solid #e5e7eb;
              border-radius:8px;font-size:.875rem;outline:none;resize:vertical;
              box-sizing:border-box;">${esc(prefill?.description ?? '')}</textarea>
        </div>

        <div style="display:grid;grid-template-columns:1fr ${isAdmin ? '1fr' : ''};gap:1rem;">
          <div>
            <label style="display:block;font-size:.78rem;font-weight:600;color:#374151;margin-bottom:.3rem;">
              Category
            </label>
            <select id="pf_category"
              style="width:100%;padding:.55rem .8rem;border:1.5px solid #e5e7eb;
                border-radius:8px;font-size:.875rem;outline:none;background:#fff;">
              ${catOpts}
            </select>
          </div>
          ${isAdmin ? `
          <div>
            <label style="display:block;font-size:.78rem;font-weight:600;color:#374151;margin-bottom:.3rem;">
              Priority
            </label>
            <select id="pf_priority"
              style="width:100%;padding:.55rem .8rem;border:1.5px solid #e5e7eb;
                border-radius:8px;font-size:.875rem;outline:none;background:#fff;">
              ${priOpts}
            </select>
          </div>` : ''}
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
          <div>
            <label style="display:block;font-size:.78rem;font-weight:600;color:#374151;margin-bottom:.3rem;">
              Target Role
            </label>
            <select id="pf_targetRoles"
              style="width:100%;padding:.55rem .8rem;border:1.5px solid #e5e7eb;
                border-radius:8px;font-size:.875rem;outline:none;background:#fff;">
              ${_ROLE_OPTS.map(o =>
                `<option value="${o.value}" ${(prefill?.targetRoles ?? 'all') === o.value ? 'selected' : ''}>${o.label}</option>`
              ).join('')}
            </select>
          </div>
          <div>
            <label style="display:block;font-size:.78rem;font-weight:600;color:#374151;margin-bottom:.3rem;">
              Target Group
            </label>
            <select id="pf_targetGroups" onchange="window._onGroupChange()"
              style="width:100%;padding:.55rem .8rem;border:1.5px solid #e5e7eb;
                border-radius:8px;font-size:.875rem;outline:none;background:#fff;">
              ${_GROUP_OPTS.map(o =>
                `<option value="${o.value}" ${(prefill?.targetGroups ?? 'all') === o.value ? 'selected' : ''}>${o.label}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div id="pf_ageRangeRow" style="display:${(prefill?.targetGroups === 'custom_age') ? 'grid' : 'none'};
          grid-template-columns:1fr 1fr;gap:1rem;">
          <div>
            <label style="display:block;font-size:.78rem;font-weight:600;color:#374151;margin-bottom:.3rem;">
              Min Age
            </label>
            <input id="pf_minAge" type="number" min="0" max="120"
              value="${prefill?.minAge ?? ''}" placeholder="e.g. 18"
              style="width:100%;padding:.55rem .8rem;border:1.5px solid #e5e7eb;
                border-radius:8px;font-size:.875rem;outline:none;box-sizing:border-box;" />
          </div>
          <div>
            <label style="display:block;font-size:.78rem;font-weight:600;color:#374151;margin-bottom:.3rem;">
              Max Age
            </label>
            <input id="pf_maxAge" type="number" min="0" max="120"
              value="${prefill?.maxAge ?? ''}" placeholder="e.g. 45"
              style="width:100%;padding:.55rem .8rem;border:1.5px solid #e5e7eb;
                border-radius:8px;font-size:.875rem;outline:none;box-sizing:border-box;" />
          </div>
        </div>

        <div>
          <label style="display:block;font-size:.78rem;font-weight:600;color:#374151;margin-bottom:.3rem;">
            Options * <span style="font-weight:400;color:#9ca3af;">(minimum 2)</span>
          </label>
          <div id="pf_options" style="display:flex;flex-direction:column;gap:.4rem;">
            ${optsHtml}
          </div>
          ${!hasVotes ? `
          <button onclick="window._addPollOption()"
            style="margin-top:.5rem;display:inline-flex;align-items:center;gap:.35rem;
              padding:.35rem .75rem;border-radius:8px;background:#f3f4f6;color:#374151;
              border:1.5px solid #e5e7eb;font-size:.8rem;font-weight:600;cursor:pointer;">
            <i data-lucide="plus" style="width:12px;height:12px;"></i> Add Option
          </button>` : ''}
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
          <div>
            <label style="display:block;font-size:.78rem;font-weight:600;color:#374151;margin-bottom:.3rem;">
              Start Date
            </label>
            <input id="pf_start" type="datetime-local" value="${fmtDate(prefill?.startDate)}"
            ${hasVotes ? 'disabled' : ''}
            style="width:100%;padding:.55rem .8rem;border:1.5px solid #e5e7eb;
                border-radius:8px;font-size:.875rem;outline:none;box-sizing:border-box;
                ${hasVotes ? 'background:#f9fafb;color:#9ca3af;' : ''}" />
          </div>
          <div>
            <label style="display:block;font-size:.78rem;font-weight:600;color:#374151;margin-bottom:.3rem;">
              End Date *
            </label>
             <input id="pf_end" type="datetime-local" value="${fmtDate(prefill?.endDate)}"
            ${hasVotes ? 'disabled' : ''}
            style="width:100%;padding:.55rem .8rem;border:1.5px solid #e5e7eb;
                border-radius:8px;font-size:.875rem;outline:none;box-sizing:border-box;
                ${hasVotes ? 'background:#f9fafb;color:#9ca3af;' : ''}" />
          </div>
        </div>

        <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer;
          font-size:.82rem;font-weight:600;color:#374151;">
          <input id="pf_live" type="checkbox" ${prefill?.allowLiveResults ? 'checked' : ''}
            style="width:15px;height:15px;" />
          Show live results to residents before they vote
        </label>

        <div style="display:flex;gap:.5rem;justify-content:flex-end;
          padding-top:.75rem;border-top:1.5px solid #f0f0f0;flex-wrap:wrap;">
          <button onclick="window.closePollForm()"
            style="padding:.5rem 1rem;border-radius:8px;background:#f3f4f6;
              color:#374151;border:1.5px solid #e5e7eb;font-size:.85rem;font-weight:600;cursor:pointer;">
            Cancel
          </button>
          <button onclick="window.savePoll('draft')"
            style="padding:.5rem 1rem;border-radius:8px;background:#f3f4f6;
              color:#374151;border:1.5px solid #e5e7eb;font-size:.85rem;font-weight:600;cursor:pointer;">
            Save as Draft
          </button>
          <button onclick="window.savePoll('active')"
            style="padding:.5rem 1rem;border-radius:8px;background:#1a3a1a;
              color:#fff;border:none;font-size:.85rem;font-weight:600;cursor:pointer;">
            ${_editId ? 'Save Changes' : 'Create & Publish'}
          </button>
        </div>

      </div>
    </div>`;

  lucide.createIcons({ el: wrap });
  wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.closePollForm = function () {
  _editId = null;
  const wrap = document.getElementById('pollFormWrap');
  if (wrap) wrap.innerHTML = '';
};

function _buildOptionField(idx, value = '', disabled = false) {
  const dis = disabled ? 'disabled style="background:#f9fafb;color:#9ca3af;"' : '';
  return `
    <div class="pf_opt_row" style="display:flex;align-items:center;gap:.4rem;">
      <input type="text" class="pf_opt_input" value="${esc(value)}"
        placeholder="Option ${idx + 1}" ${dis}
        style="flex:1;padding:.5rem .75rem;border:1.5px solid #e5e7eb;
          border-radius:8px;font-size:.875rem;outline:none;" />
      ${!disabled ? `
      <button onclick="this.closest('.pf_opt_row').remove()"
        style="width:28px;height:28px;border-radius:50%;background:#fff;color:#dc2626;
          border:1.5px solid #fca5a5;cursor:pointer;display:flex;align-items:center;
          justify-content:center;flex-shrink:0;font-size:.9rem;line-height:1;">✕</button>` : ''}
    </div>`;
}

window._onAudienceChange = function () {
  const val = document.getElementById('pf_audience')?.value;
  const row = document.getElementById('pf_ageRangeRow');
  if (row) row.style.display = val === 'custom_age' ? 'grid' : 'none';
};

window._onGroupChange = function () {
  const val = document.getElementById('pf_targetGroups')?.value;
  const row = document.getElementById('pf_ageRangeRow');
  if (row) row.style.display = val === 'custom_age' ? 'grid' : 'none';
};

window._addPollOption = function () {
  const container = document.getElementById('pf_options');
  if (!container) return;
  const count = container.querySelectorAll('.pf_opt_row').length;
  container.insertAdjacentHTML('beforeend', _buildOptionField(count));
};


// ================================================
// FORM — Collect, Validate, Save
// ================================================

window.savePoll = async function (status) {
  const title = document.getElementById('pf_title')?.value.trim();
  if (!title) { showToast('Title is required.', 'error'); return; }

  const optInputs = [...document.querySelectorAll('#pf_options .pf_opt_input')]
    .map(i => i.value.trim()).filter(Boolean);
  if (optInputs.length < 2) { showToast('At least 2 options are required.', 'error'); return; }

  const existingPoll = _editId ? _polls.find(p => p.id === _editId) : null;
  const editingWithVotes = !!(_editId && (existingPoll?.totalVotes ?? 0) > 0);
  const startRaw  = document.getElementById('pf_start')?.value;
  const startDate = startRaw ? new Date(startRaw + ':00') : null;
  const endRaw    = document.getElementById('pf_end')?.value;
  const endDate   = endRaw   ? new Date(endRaw   + ':00') : null;
  if (!editingWithVotes) {
    if (!endDate) { showToast('End date is required.', 'error'); return; }
    if (isNaN(endDate)) { showToast('Invalid end date.', 'error'); return; }
    if (startDate && !isNaN(startDate) && endDate <= startDate) { showToast('End date must be after the start date.', 'error'); return; }
  }

  /* Preserve existing optionIds when editing to keep vote counts intact */
  const existingOpts = existingPoll
    ? Object.entries(existingPoll.options ?? {})
        .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0))
    : [];

  const options = {};
  optInputs.forEach((text, i) => {
    const optId  = existingOpts[i]?.[0] ?? `o_${Math.random().toString(36).slice(2, 7)}`;
    options[optId] = {
      optionText: text,
      voteCount:  existingOpts[i]?.[1]?.voteCount ?? 0,
      order:      i,
    };
  });
  const targetGroups = document.getElementById('pf_targetGroups')?.value || 'all';
  const _startForCheck = startDate && !isNaN(startDate) ? startDate : null;
  const _effectiveStatus = (status === 'active' && _startForCheck && _startForCheck > new Date())
    ? 'scheduled' : status;
  const payload = {
    description:      document.getElementById('pf_desc')?.value.trim() || null,
    category:         document.getElementById('pf_category')?.value || 'general',
    priority:         document.getElementById('pf_priority')?.value || 'normal',
    allowLiveResults: document.getElementById('pf_live')?.checked ?? false,
    targetRoles:      document.getElementById('pf_targetRoles')?.value || 'all',
    targetGroups,
    minAge: targetGroups === 'custom_age' ? (v => Number.isFinite(v) ? v : null)(parseInt(document.getElementById('pf_minAge')?.value)) : null,
    maxAge: targetGroups === 'custom_age' ? (v => Number.isFinite(v) ? v : null)(parseInt(document.getElementById('pf_maxAge')?.value)) : null,
    startDate: (!editingWithVotes && startDate) ? startDate : (existingPoll?.startDate ?? null),
    endDate:   !editingWithVotes ? endDate : (existingPoll?.endDate ?? null),
    status: _effectiveStatus,
    updatedAt:        serverTimestamp(),
  };

  if (_editId) {
    /*
       Integrity guard: if votes exist, title and options are disabled
       in the form and we must not overwrite them.
    */
    if (!(existingPoll?.totalVotes > 0)) {
      payload.title   = title;
      payload.options = options;
    }
  } else {
    payload.title        = title;
    payload.options      = options;
    payload.createdBy    = _uid;
    payload.createdByRole = _role;
    payload.isPinned     = false;
    payload.isDeleted    = false;
    payload.totalVotes   = 0;
    payload.createdAt    = serverTimestamp();
  }

  try {
    if (_editId) {
      await updateDoc(pollDoc(_bid, _editId), payload);
      await _logAction(_editId, 'edit', null);
      showToast('Poll updated.', 'success');
    } else {
      const ref = await addDoc(pollsCol(_bid), payload);
      await _logAction(ref.id, status === 'active' ? 'publish' : 'create_draft', null);
      showToast(status === 'active' ? 'Poll published.' : 'Draft saved.', 'success');
      if (status === 'active') {
        notifyAllInBarangay(_bid, { type: 'poll_created', actorId: _uid, postId: ref.id, postTitle: payload.title, description: payload.description ?? null }, { targetRoles: payload.targetRoles });
      }
    }
    window.closePollForm();
  } catch (err) {
    showToast('Failed to save poll.', 'error');
    console.error('[polls-admin] save error', err);
  }
};


// ================================================
// ACTIONS — Edit / Publish
// ================================================

window.editPoll = function (pollId) {
  const poll = _polls.find(p => p.id === pollId);
  if (!poll) return;
  window.openPollForm(poll);
};

window.publishPoll = async function (pollId) {
  const ok = await showConfirm({ title: 'Publish Poll?', body: 'This poll will become visible to all residents.', confirm: 'Publish', cancel: 'Go Back', variant: 'confirm' });
if (!ok) return;
  try {
    await updateDoc(pollDoc(_bid, pollId), { status: 'active', updatedAt: serverTimestamp() });
    await _logAction(pollId, 'publish', null);
    showToast('Poll published.', 'success');
    const _publishedPoll = _polls.find(p=>p.id===pollId);
    notifyAllInBarangay(_bid, { type: 'poll_created', actorId: _uid, postId: pollId,
    postTitle: _publishedPoll?.title ?? 'New Poll',
    description: _publishedPoll?.description ?? null }, { targetRoles: _publishedPoll?.targetRoles });
  } catch { showToast('Failed to publish.', 'error'); }
};


// ================================================
// ACTIONS — Extend Deadline
// ================================================

/*
   Reason is required and logged to poll_actions.
   Uses a dynamically-created overlay to avoid modal dependencies.
*/
window.extendDeadline = function (pollId) {
  document.getElementById('_extendOverlay')?.remove();

  const div = document.createElement('div');
  div.id    = '_extendOverlay';
  div.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.45);
    z-index:1900;display:flex;align-items:center;justify-content:center;`;

  div.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:1.5rem;
      width:min(460px,92vw);box-shadow:0 20px 60px rgba(0,0,0,.2);"
      onclick="event.stopPropagation()">
      <h3 style="font-size:1rem;font-weight:700;margin:0 0 .4rem;">Extend Deadline</h3>
      <p style="font-size:.85rem;color:#6b7280;margin:0 0 1rem;">
        Please provide a reason for this extension.
        This will be displayed on the poll for transparency.
      </p>
      <label style="display:block;font-size:.78rem;font-weight:600;
        color:#374151;margin-bottom:.3rem;">New End Date *</label>
      <input id="_extDate" type="datetime-local"
        value="${(() => { const p = _polls.find(p => p.id === pollId); const d = p?.endDate?.toDate?.(); return d ? d.toISOString().slice(0,16) : ''; })()}"
        style="width:100%;padding:.55rem .8rem;border:1.5px solid #e5e7eb;
          border-radius:8px;font-size:.875rem;outline:none;
          box-sizing:border-box;margin-bottom:.75rem;" />
      <label style="display:block;font-size:.78rem;font-weight:600;
        color:#374151;margin-bottom:.3rem;">Reason *</label>
      <textarea id="_extReason" rows="3"
        placeholder="e.g. Low participation — extended one more week to allow more residents to respond."
        style="width:100%;padding:.55rem .8rem;border:1.5px solid #e5e7eb;
          border-radius:8px;font-size:.875rem;outline:none;resize:vertical;
          box-sizing:border-box;margin-bottom:1rem;"></textarea>
      <div style="display:flex;gap:.5rem;justify-content:flex-end;">
        <button onclick="document.getElementById('_extendOverlay').remove()"
          style="padding:.5rem 1rem;border-radius:8px;background:#f3f4f6;
            color:#374151;border:1.5px solid #e5e7eb;font-size:.85rem;font-weight:600;cursor:pointer;">
          Cancel
        </button>
        <button onclick="window._submitExtend('${esc(pollId)}')"
          style="padding:.5rem 1rem;border-radius:8px;background:#1a3a1a;
            color:#fff;border:none;font-size:.85rem;font-weight:600;cursor:pointer;">
          Confirm Extension
        </button>
      </div>
    </div>`;

  div.addEventListener('click', () => div.remove());
  document.body.appendChild(div);
};

window._submitExtend = async function (pollId) {
  const rawDate = document.getElementById('_extDate')?.value ?? '';
  const newDate = rawDate ? new Date(rawDate + ':00') : new Date('');
  const reason  = document.getElementById('_extReason')?.value.trim();

  if (isNaN(newDate)) { showToast('Please enter a valid date.', 'error'); return; }
  const poll = _polls.find(p => p.id === pollId);
  const startDate = poll?.startDate?.toDate?.();
  if (startDate && newDate <= startDate) { showToast('New end date must be after the poll\'s start date.', 'error'); return; }
  const origEnd = poll?.endDate?.toDate?.();
  if (origEnd && newDate <= origEnd) { showToast('New end date must be after the original deadline.', 'error'); return; }
  if (!reason)         { showToast('A reason is required.', 'error'); return; }

  try {
    await updateDoc(pollDoc(_bid, pollId), { endDate: newDate, extensionReason: reason, deadlineExtendedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    await _logAction(pollId, 'extend_deadline', reason);
    document.getElementById('_extendOverlay')?.remove();
    showToast('Deadline extended and logged.', 'success');
  } catch { showToast('Failed to extend deadline.', 'error'); }
};


// ================================================
// ACTIONS — Close / Delete / Pin (Admin only)
// ================================================

window.closePoll = async function (pollId) {
  const ok = await showConfirm({ title: 'Close Poll Early?', body: 'Residents will no longer be able to vote.', confirm: 'Close Poll', cancel: 'Go Back', variant: 'warning' });
if (!ok) return;
  try {
    await updateDoc(pollDoc(_bid, pollId), { status: 'closed', updatedAt: serverTimestamp() });
    await _logAction(pollId, 'close_early', null);
    showToast('Poll closed.', 'success');
    const _closedPoll = _polls.find(p=>p.id===pollId);
        notifyAllInBarangay(_bid, { type: 'poll_closed', actorId: _uid,
        postId: pollId, postTitle: _closedPoll?.title ?? 'Poll',
        description: _closedPoll?.description ?? null }, { targetRoles: _closedPoll?.targetRoles });
  } catch { showToast('Failed to close poll.', 'error'); }
};

/*
   Deletion policy:
     · Zero votes AND still a draft (or no one has voted yet) → hard delete permanently.
       Officers sometimes create polls by mistake — this gives them a clean escape.
     · Has votes OR was active/closed → soft delete (isDeleted: true) + force status
       to 'closed' so it can never accept votes from the archived state.
       Kept for transparency — residents and admins can still view final results.
*/
window.deletePoll = async function (pollId, hasVotes) {
  const poll      = _polls.find(p => p.id === pollId);
  const canHardDelete = !hasVotes; // zero votes = safe to permanently delete, regardless of status

  const confirmed = canHardDelete
  ? await showConfirm({ title: 'Delete Poll?', body: 'This poll has no votes. It will be permanently deleted.', confirm: 'Delete', cancel: 'Go Back', variant: 'danger' })
  : await showConfirm({ title: 'Archive Poll?', body: 'This poll will be closed and moved to the archive. Results remain visible.', confirm: 'Archive', cancel: 'Go Back', variant: 'warning' });

  if (!confirmed) return;

  try {
    if (canHardDelete) {
      /* Hard delete — no votes, no record needed */
      await deleteDoc(pollDoc(_bid, pollId));
      await _logAction(pollId, 'hard_delete', 'Poll had no votes and was deleted permanently.');
      showToast('Poll permanently deleted.', 'success');
    } else {
      /* Soft delete — force closed so it can never accept votes while archived */
      await updateDoc(pollDoc(_bid, pollId), {
        isDeleted: true,
        status:    'closed',
        updatedAt: serverTimestamp(),
      });
      await _logAction(pollId, 'soft_delete', 'Poll archived and closed.');
      showToast('Poll archived.', 'success');
    }
  } catch {
    showToast('Failed to delete/archive poll.', 'error');
  }
};

window.togglePinPoll = async function (pollId, currentlyPinned) {
  try {
    await updateDoc(pollDoc(_bid, pollId), { isPinned: !currentlyPinned, updatedAt: serverTimestamp() });
    await _logAction(pollId, currentlyPinned ? 'unpin' : 'pin', null);
    showToast(currentlyPinned ? 'Poll unpinned.' : 'Poll pinned.', 'success');
  } catch { showToast('Failed to update pin.', 'error'); }
};


// ================================================
// ANALYTICS
// ================================================

/*
   Toggles an inline analytics breakdown under the poll row.
   Shows only aggregated counts — no user identity is exposed.
*/
window.viewPollAnalytics = function (pollId) {
  const el = document.getElementById(`analytics_${pollId}`);
  if (!el) return;

  if (el.style.display !== 'none') { el.style.display = 'none'; return; }

  const poll  = _polls.find(p => p.id === pollId) ?? _archivedPolls.find(p => p.id === pollId);
  if (!poll)  return;

  const total   = poll.totalVotes ?? 0;
  const options = Object.entries(poll.options ?? {})
    .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0));

  const bars = options.map(([, opt]) => {
    const count = opt.voteCount ?? 0;
    const pct   = total > 0 ? Math.round(count / total * 100) : 0;
    return `
      <div style="margin-bottom:.65rem;">
        <div style="display:flex;justify-content:space-between;
          font-size:.8rem;font-weight:600;color:#374151;margin-bottom:.25rem;">
          <span>${esc(opt.optionText)}</span>
          <span>${count.toLocaleString()} (${pct}%)</span>
        </div>
        <div style="height:8px;background:#f3f4f6;border-radius:999px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:#1a3a1a;border-radius:999px;
            transition:width .5s ease;"></div>
        </div>
      </div>`;
  }).join('');

  const demo = poll.demographics ?? {};
  const demoGroups = [
    { key: 'resident', label: 'Residents' },
    { key: 'officer',  label: 'Officers'  },
    { key: 'admin',    label: 'Admins'    },
    { key: 'child',    label: 'Children'  },
    { key: 'youth',    label: 'Youth'     },
    { key: 'adult',    label: 'Adults'    },
    { key: 'senior',   label: 'Seniors'   },
  ].filter(g => demo[g.key] !== undefined);

  const demoHtml = demoGroups.length ? `
    <p style="font-size:.72rem;font-weight:700;text-transform:uppercase;
      color:#9ca3af;letter-spacing:.06em;margin:.85rem 0 .5rem;">
      By Demographic
    </p>
    ${demoGroups.map(g => {
      const groupTotal = Object.values(demo[g.key] ?? {}).reduce((s, n) => s + n, 0);
      return `<div style="display:flex;justify-content:space-between;font-size:.8rem;
        color:#374151;padding:.2rem 0;">
        <span>${g.label}</span>
        <span style="font-weight:600;">${groupTotal.toLocaleString()} vote${groupTotal !== 1 ? 's' : ''}</span>
      </div>`;
    }).join('')}` : '';

  el.innerHTML = `
    <div style="background:#f9fafb;border-radius:8px;padding:1rem;border:1px solid #e5e7eb;">
      <p style="font-size:.72rem;font-weight:700;text-transform:uppercase;
        color:#9ca3af;letter-spacing:.06em;margin:0 0 .75rem;">
        Analytics · ${total.toLocaleString()} total vote${total !== 1 ? 's' : ''}
      </p>
      ${bars || '<p style="font-size:.82rem;color:#aaa;margin:0;">No votes yet.</p>'}
      ${demoHtml}
    </div>`;
  el.style.display = 'block';
};


// ================================================
// POLL ACTION LOGGER
// ================================================

async function _logAction(pollId, actionType, reason) {
  try {
    await addDoc(pollActionsCol(_bid, pollId), {
      actionType,
      performedBy: _uid,
      role:        _role,
      reason:      reason ?? null,
      timestamp:   serverTimestamp(),
    });
  } catch { /* non-fatal */ }
}

window._pollAdminTab = function (tab, btn) {
  _adminTab    = tab;
  _adminFilter = 'all';
  document.querySelectorAll('.admin-subtab-btn[onclick*="_pollAdminTab"]')
    .forEach(b => b.classList.remove('is-active', 'active'));
  btn.classList.add('active');
  document.querySelectorAll('.bulletin-view-btn[onclick*="_pollAdminFilter"]')
    .forEach(b => b.classList.remove('is-active'));
  document.querySelector('.bulletin-view-btn[onclick*="_pollAdminFilter"]')
    ?.classList.add('is-active');
  _renderList();
};

window._pollAdminFilter = function (filter, btn) {
  _adminFilter = filter;
  document.querySelectorAll('.bulletin-view-btn[onclick*="_pollAdminFilter"]')
    .forEach(b => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  _renderList();
};

// ================================================
// UTILITIES
// ================================================

function showToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const t = document.createElement('div');
  t.className = `toast toast--${type}`;
  t.innerHTML = `<i data-lucide="${type === 'success' ? 'check' : 'x-circle'}"></i>${esc(msg)}`;
  container.appendChild(t);
  lucide.createIcons({ el: t });
  setTimeout(() => t.remove(), 3500);
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}