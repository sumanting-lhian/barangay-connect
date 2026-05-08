/* ================================================
   community-polls.js — BarangayConnect
   Resident-facing community poll system. Renders
   active and closed polls in the Community Polls
   tab, handles vote submission with confirmation,
   and auto-closes polls past their endDate.

   Firestore path:
     barangays/{barangayId}/polls/{pollId}
     barangays/{barangayId}/polls/{pollId}/votes/{userId}
     barangays/{barangayId}/polls/{pollId}/poll_actions/{actionId}

   Poll document shape:
     title, description, createdBy, createdByRole,
     status (draft|active|closed), category, priority,
     isPinned, allowLiveResults, isDeleted,
     startDate, endDate, totalVotes, createdAt, updatedAt,
     options: {
       [optionId]: { optionText, voteCount, order }
     }

   Vote document shape (votes/{userId}):
     pollId, optionId, createdAt
     (userId as doc ID enforces one-vote-per-poll)

   WHAT IS IN HERE:
     · Module state initialization (initCommunityPolls)
     · Real-time polls subscription — active + closed, pinned first
     · Auto-close check — expires active polls past their endDate
     · Vote prefetch — checks which polls the user has voted on
     · Poll card renderer with per-role result visibility
     · Vote confirmation overlay (inline, no modal dependency)
     · Vote transaction — atomic increment + duplicate guard
     · Poll action logger (vote events)
     · Toast helper and XSS escape utility

   WHAT IS NOT IN HERE:
     · Admin/official create, edit, close, delete    → polls-admin.js
     · Poll tab HTML and CSS link injection           → community.html
     · Firebase config and db/auth instances         → firebase-config.js
     · Firestore poll path helpers                   → db-paths.js

   REQUIRED IMPORTS:
     · ../../core/firebase-config.js          (db)
     · ../../core/db-paths.js                 (pollsCol, pollDoc,
                                               voteDoc, pollActionsCol)
     · firebase-firestore.js@10.12.0 (onSnapshot, query, where, orderBy,
                                      getDoc, runTransaction, updateDoc,
                                      addDoc, serverTimestamp, increment)

   QUICK REFERENCE:
     Init module     → initCommunityPolls(barangayId, uid, userName, role, containerId?)
     Vote confirm    → window._bcVote(pollId, optionId, optionText) [onclick]
     Confirm submit  → window._bcConfirmVote() [onclick]
     Cancel confirm  → window._bcCancelVote()  [onclick]
================================================ */


// ================================================
// IMPORTS
// ================================================

import { db, auth } from '../../core/firebase-config.js';

import {
  pollsCol, pollDoc, voteDoc, pollActionsCol, userIndexDoc, barangayId as toBid,
} from '../../core/db-paths.js';

import {
  onSnapshot, query, where, orderBy,
  getDoc, runTransaction, updateDoc, addDoc,
  serverTimestamp, increment,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import { notifyAllInBarangay } from '../../shared/notifications.js';

import { showConfirm } from '/js/shared/confirm-modal.js';

// ================================================
// CATEGORY MAP
// ================================================
const _CAT = {
  announcements:  { label: 'Announcement',   cls: 'tag--blue'   },
  health:         { label: 'Health',          cls: 'tag--green'  },
  infrastructure: { label: 'Infrastructure',  cls: 'tag--amber'  },
  safety:         { label: 'Safety',          cls: 'tag--red'    },
  events:         { label: 'Events',          cls: 'tag--purple' },
  general:        { label: 'General',         cls: 'tag--teal'   },
};
const _BORDER = {
  announcements: '#3b82f6', health: '#1B4B27', infrastructure: '#FFA135',
  safety: '#dc2626', events: '#7c3aed', general: '#0f766e',
};

// ================================================
// MODULE STATE
// ================================================

let _barangayId    = null;
let _uid           = null;
let _role          = 'resident';
let _userName      = 'Resident';
let _container     = null;
let _unsub         = null;

/*
   Maps pollId → optionId for polls the user has already voted on.
   Populated lazily via _prefetchVotes on each snapshot.
   Value is the chosen optionId string (or true if optionId unknown).
*/
let _votedMap      = new Map();

/*
   Cached eligibility fields from the full user doc.
   Populated in bootstrap after auth resolves.
*/
let _userProfile = {
  role: 'resident',
  dob:  null,   // "YYYY-MM-DD"
};

/* Holds the pending vote data between confirm-show and confirm-submit */
let _pendingConfirm  = null;
let _unsubArchived   = null;
let _archivedPolls   = [];
let _activeTab       = 'active';


// ================================================
// INIT
// ================================================

/*
   Must be called once after onAuthStateChanged resolves.
   containerId defaults to 'pollsList' — the element that will
   receive rendered poll cards. Attach this to a DOMContentLoaded
   listener in the community.html module script after auth resolves.
*/
export function initCommunityPolls(barangayId, uid, userName, role, containerId = 'pollsList') {
  _barangayId = barangayId;
  _uid        = uid;
  _role       = role ?? 'resident';
  _userName   = userName;
  _container  = document.getElementById(containerId);

  if (!_container || !_barangayId) return;
  _subscribe();
  _subscribeArchived();
}

// ================================================
// ELIGIBILITY
// ================================================

function _isEligible(poll) {
  /* ── Role check ── */
  const targetRoles = poll.targetRoles ?? 'all';
  if (targetRoles !== 'all') {
    const role = _userProfile.role;
    const isOfficial = role === 'admin' || role === 'officer';
    if (targetRoles === 'officials' && !isOfficial) return false;
    if (targetRoles === 'residents' &&  isOfficial) return false;
  }

  /* ── Group / age check ── */
  const targetGroups = poll.targetGroups ?? 'all';
  if (targetGroups === 'all') return true;

  const age = (() => {
    if (!_userProfile.dob) return null;
    const today = new Date();
    const born  = new Date(_userProfile.dob + 'T00:00:00');
    let a = today.getFullYear() - born.getFullYear();
    if (today < new Date(today.getFullYear(), born.getMonth(), born.getDate())) a--;
    return a;
  })();

  if (age === null) return false;

  if (targetGroups === 'youth')  return age >= 15 && age <= 30;
  if (targetGroups === 'adult')  return age >= 31 && age <= 59;
  if (targetGroups === 'senior') return age >= 60;
  if (targetGroups === 'custom_age') {
    const ok_min = poll.minAge == null || age >= poll.minAge;
    const ok_max = poll.maxAge == null || age <= poll.maxAge;
    return ok_min && ok_max;
  }

  return true;
}

function _eligibilityLabel(poll) {
  const rolePart = {
    residents: 'residents',
    officials: 'officials',
  }[poll.targetRoles ?? 'all'];

  const groupPart = {
    youth:      'youth (15–30)',
    adult:      'adults (31–59)',
    senior:     'seniors (60+)',
    custom_age: poll.minAge != null || poll.maxAge != null
      ? `ages ${poll.minAge ?? 0}–${poll.maxAge ?? '∞'}` : 'custom age range',
  }[poll.targetGroups ?? 'all'];

  const parts = [rolePart, groupPart].filter(Boolean);
  return parts.length ? `For ${parts.join(' · ')} only` : '';
}



// ================================================
// SUBSCRIPTION
// ================================================

/*
   Listens to all non-deleted active and closed polls in the barangay,
   pinned polls first, then newest first.
   Draft polls are excluded from the resident view.
*/
function _subscribe() {
  if (_unsub) _unsub();

  const q = query(
    pollsCol(_barangayId),
    where('isDeleted', '==', false),
    where('status',    'in', ['active', 'closed']),
    orderBy('isPinned',   'desc'),
    orderBy('createdAt',  'desc'),
  );

  _unsub = onSnapshot(q, async snap => {
    const polls = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    _autoCloseExpired(polls);       // closes polls past their endDate
    _autoPublishScheduled(polls);   // publishes scheduled polls past their startDate
    _autoArchiveClosedPolls(polls); // archives old closed polls
    _checkNearDeadline(polls);
    if (_uid) await _prefetchVotes(polls.map(p => p.id));
    _render(polls);
  });
}

// ================================================
// ARCHIVED SUBSCRIPTION
// ================================================

function _subscribeArchived() {
  if (_unsubArchived) _unsubArchived();

  const q = query(
    pollsCol(_barangayId),
    where('isDeleted', '==', true),
    orderBy('createdAt', 'desc'),
  );

  _unsubArchived = onSnapshot(q, async snap => {
    _archivedPolls = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _render(null); // re-render with current tab state
  });
}

// ================================================
// AUTO-CLOSE
// ================================================

/*
   Compares each active poll's endDate to the current time.
   If expired, writes status: 'closed'. This is idempotent —
   the next snapshot will reflect the update and re-render.
   Any authenticated user can close an expired poll since
   the outcome is deterministic and the write is non-destructive.

   Auto-archives closed polls after N days (default: 1).
   archiveDays is read from barangay settings.
   Sets isDeleted: true — same as admin soft-delete.
*/
async function _autoArchiveClosedPolls(polls) {
  // Fetch archiveDays from settings
  let archiveDays = 1;
  try {
    const { getDoc: _gd, doc: _d } = await import(
      "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js"
    );
    const settingsSnap = await _gd(_d(db, 'barangays', _barangayId, 'meta', 'settings'));
    if (settingsSnap.exists()) {
      archiveDays = settingsSnap.data().pollArchiveDays ?? 1;
    }
  } catch { /* use default */ }

  const threshold = Date.now() - archiveDays * 86_400_000;

  for (const poll of polls) {
    if (poll.status !== 'closed') continue;
    const closedAt = poll.updatedAt?.toMillis?.() ?? poll.endDate?.toMillis?.();
    if (!closedAt || closedAt > threshold) continue;
    try {
      await updateDoc(pollDoc(_barangayId, poll.id), {
        isDeleted: true,
        updatedAt: serverTimestamp(),
      });
    } catch { /* non-fatal */ }
  }
}

/*
   Flips scheduled → active when the poll's startDate has arrived.
   Idempotent — safe to call on every snapshot.
*/
async function _autoPublishScheduled(polls) {
  const now = Date.now();
  for (const poll of polls) {
    if (poll.status !== 'scheduled') continue;
    const start = poll.startDate?.toMillis?.();
    if (!start || start > now) continue;
    try {
      await updateDoc(pollDoc(_barangayId, poll.id), {
        status:    'active',
        updatedAt: serverTimestamp(),
      });
      try {
        await addDoc(pollActionsCol(_barangayId, poll.id), {
          actionType:  'auto_publish',
          performedBy: _uid ?? 'system',
          role:        _role,
          reason:      'Poll reached its scheduled start date',
          timestamp:   serverTimestamp(),
        });
      } catch { /* non-fatal */ }
    } catch { /* non-fatal */ }
  }
}

async function _autoCloseExpired(polls) {
  const now = Date.now();
  for (const poll of polls) {
    const end = poll.endDate?.toMillis?.();
    if (poll.status !== 'active') continue;
    if (!end || end >= now) continue;
    try {
      await updateDoc(pollDoc(_barangayId, poll.id), {
        status:    'closed',
        updatedAt: serverTimestamp(),
      });
      try {
        await addDoc(pollActionsCol(_barangayId, poll.id), {
          actionType:  'auto_close',
          performedBy: _uid ?? 'system',
          role:        _role,
          reason:      'Poll reached its end date',
          timestamp:   serverTimestamp(),
        });
      } catch { /* non-fatal */ }
    } catch { /* non-fatal — another tab may have already closed it */ }
  }
}

/*
   Sends a one-time deadline alert for active polls ending within 24 hours.
   Sets nearDeadlineNotified: true on the poll doc to prevent repeat sends.
*/
async function _checkNearDeadline(polls) {
  const now   = Date.now();
  const in24h = now + 86_400_000;
  const in72h = now + 3 * 86_400_000;

  for (const poll of polls) {
    if (poll.status !== 'active') continue;
    const end = poll.endDate?.toMillis?.();
    if (!end || end < now) continue;

    /* 72h reminder — fires independently of the 24h alert */
    if (!poll.reminder72hSent && end <= in72h && end > in24h) {
      try {
        await updateDoc(pollDoc(_barangayId, poll.id), {
          reminder72hSent: true,
          updatedAt: serverTimestamp(),
        });
        if (_role === 'admin' || _role === 'officer') {
          notifyAllInBarangay(_barangayId, {
            type:        'poll_deadline',
            actorId:     _uid ?? 'system',
            postId:      poll.id,
            postTitle:   poll.title,
            description: `Closes in 3 days — ${poll.description ?? ''}`,
          }, { targetRoles: poll.targetRoles });
        }
      } catch { /* non-fatal */ }
    }

    if (poll.nearDeadlineNotified) continue;
    if (end > in24h) continue;
    try {
      await updateDoc(pollDoc(_barangayId, poll.id), {
        nearDeadlineNotified: true,
        updatedAt: serverTimestamp(),
      });
      if (_role === 'admin' || _role === 'officer') {
        notifyAllInBarangay(_barangayId, {
            type:        'poll_deadline',
            actorId:     _uid ?? 'system',
            postId:      poll.id,
            postTitle:   poll.title,
            description: poll.description ?? null,
        }, { targetRoles: poll.targetRoles });
        }
    } catch { /* non-fatal */ }
  }
}


// ================================================
// VOTE PREFETCH
// ================================================

/*
   Fetches each poll's votes/{uid} doc in parallel to determine
   which polls this user has already voted on. Only checks polls
   not already present in _votedMap (avoids redundant reads).
*/
async function _prefetchVotes(pollIds) {
  const checks = pollIds
    .filter(id => !_votedMap.has(id))
    .map(async id => {
      try {
        const snap = await getDoc(voteDoc(_barangayId, id, _uid));
        if (snap.exists()) {
          _votedMap.set(id, snap.data().optionId ?? true);
        }
      } catch { /* non-fatal */ }
    });
  await Promise.all(checks);
}


// ================================================
// RENDER
// ================================================

function _render(polls) {
  if (!_container) return;

  // If called from archived sub, polls param is null — use last active polls from closure
  // We cache them on the wrapper element to survive cross-sub calls
  if (polls !== null) _container._activePolls = polls;
  /* Cache all polls for the vote-guard lookup */
  const allKnown = [...(_container._activePolls ?? []), ..._archivedPolls];
  document._bcPollCache = Object.fromEntries(allKnown.map(p => [p.id, p]));

  const activePolls   = _container._activePolls ?? [];
  const archivedPolls = _archivedPolls;

  const tabBar = `
    <div style="display:flex;gap:.5rem;margin-bottom:1.25rem;border-bottom:2px solid #e5e7eb;padding-bottom:0;">
      <button onclick="window._bcTab('active')"
        style="padding:.45rem 1rem;border:none;background:none;cursor:pointer;
          font-size:.85rem;font-weight:700;border-bottom:${_activeTab==='active'?'2px solid #1a3a1a':'2px solid transparent'};
          color:${_activeTab==='active'?'#1a3a1a':'#9ca3af'};margin-bottom:-2px;">
        Active &amp; Closed
      </button>
      <button onclick="window._bcTab('archived')"
        style="padding:.45rem 1rem;border:none;background:none;cursor:pointer;
          font-size:.85rem;font-weight:700;border-bottom:${_activeTab==='archived'?'2px solid #1a3a1a':'2px solid transparent'};
          color:${_activeTab==='archived'?'#1a3a1a':'#9ca3af'};margin-bottom:-2px;">
        Archived${archivedPolls.length ? ` (${archivedPolls.length})` : ''}
      </button>
    </div>`;

  const shown = (_activeTab === 'archived' ? archivedPolls : activePolls)
    .filter(p => _activeTab === 'archived' || _isEligible(p));

  let body;
  if (_activeTab === 'archived' && !shown.length) {
    body = `<div class="poll-empty">
      <i data-lucide="archive"></i>
      <p>No archived polls.</p>
      <span>Deleted polls with votes will appear here for transparency.</span>
    </div>`;
  } else if (!shown.length) {
    body = _buildEmptyState();
  } else {
    body = shown.map(p => _buildPollCard(p, _activeTab === 'archived')).join('');
  }

  _container.innerHTML = tabBar + body;
  if (typeof lucide !== 'undefined') lucide.createIcons({ el: _container });
}

window._bcTab = function (tab) {
  _activeTab = tab;
  _render(null);
};


// ================================================
// BUILD — Poll Card
// ================================================

function _buildPollCard(poll, isArchived = false) {
  const votedOptionId = _votedMap.get(poll.id) ?? null;
  const closed = poll.status === 'closed' || isArchived;
  const voted         = votedOptionId !== null;

  /*
     Results (bars + percentages) are shown when:
       · User has voted on this poll, OR
       · Poll is closed, OR
       · Admin set allowLiveResults = true
  */
  const showResults = voted || closed || poll.allowLiveResults || isArchived;
  const total       = poll.totalVotes ?? 0;

  // ── Options ──────────────────────────────────────────────────
  const options = Object.entries(poll.options ?? {})
    .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0));

    const eligible = _isEligible(poll);
    const optionsHtml = options.map(([optId, opt]) => {
    const count   = opt.voteCount ?? 0;
    const pct     = total > 0 ? Math.round(count / total * 100) : 0;
    const isSel   = optId === votedOptionId;
    const classes = ['poll-option',
      showResults && 'is-voted',
      isSel && 'is-selected',
    ].filter(Boolean).join(' ');

    /* Click handler only attached when vote is still possible */
    const canVote  = !voted && !closed && _uid && eligible && !isArchived;
    const onClickA = canVote
        ? `data-pid="${esc(poll.id)}" data-oid="${esc(optId)}" data-otxt="${esc(opt.optionText)}" onclick="window._bcVote(this.dataset.pid,this.dataset.oid,this.dataset.otxt)"`
        : 'data-disabled="true"';

    return `
      <label class="${classes}" ${onClickA}>
        <input type="radio" name="poll_${esc(poll.id)}" style="display:none" />
        <div class="poll-option__bar" style="--pct:${showResults ? pct : 0}%"></div>
        <span class="poll-option__label">${esc(opt.optionText)}</span>
        ${showResults ? `<span class="poll-option__pct">${pct}%</span>` : ''}
      </label>`;
  }).join('');

  // ── Meta row (chips + deadline) ───────────────────────────────
  const _cm    = _CAT[poll.category] ?? _CAT.general;
  const catChip = `<span class="tag ${_cm.cls}">${_cm.label}</span>`;

  const _roleLabel = { residents: 'Residents', officials: 'Officials' }[poll.targetRoles ?? 'all'];
  const _groupLabel = {
    youth:      'Youth 15–30',
    adult:      'Adults 31–59',
    senior:     'Seniors 60+',
    custom_age: poll.minAge != null || poll.maxAge != null
      ? `Ages ${poll.minAge ?? 0}–${poll.maxAge ?? '∞'}` : 'Custom Age',
  }[poll.targetGroups ?? 'all'] ?? null;

  const _cRolePill = _roleLabel ? (() => {
  const s = poll.targetRoles === 'residents'
    ? 'background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;'
    : 'background:#fff8ed;color:#92400e;border:1px solid #fed7aa;';
  return `<span class="tag" style="${s}"><i data-lucide="users" style="width:10px;height:10px;display:inline;vertical-align:middle;margin-right:2px;"></i>${_roleLabel}</span>`;
})() : '';
const _grpStylesC = {
  youth:      'background:#faf5ff;color:#7c3aed;border:1px solid #e9d5ff;',
  adult:      'background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;',
  senior:     'background:#fef3c7;color:#854d0e;border:1px solid #fed7aa;',
  custom_age: 'background:#f3f4f6;color:#6b7280;border:1px solid #e5e7eb;',
};
const _cGroupPill = _groupLabel ? (() => {
  const s = _grpStylesC[poll.targetGroups] || 'background:#f3f4f6;color:#6b7280;border:1px solid #e5e7eb;';
  return `<span class="tag" style="${s}"><i data-lucide="users" style="width:10px;height:10px;display:inline;vertical-align:middle;margin-right:2px;"></i>${_groupLabel}</span>`;
})() : '';
const audienceChip = _cRolePill + _cGroupPill;

  const priChip = poll.priority && poll.priority !== 'normal'
  ? `<span class="tag ${poll.priority === 'urgent' ? 'tag--red' : 'tag--amber'}">${poll.priority.charAt(0).toUpperCase() + poll.priority.slice(1)}</span>`
  : '';

  const deadline  = poll.endDate?.toDate?.();
  const now       = new Date();
  const daysLeft  = deadline ? Math.ceil((deadline - now) / 86400000) : null;
  const dlLabel   = daysLeft !== null && daysLeft > 0
    ? `${daysLeft}d left` : 'Ends today';
  const dlUrgent  = daysLeft !== null && daysLeft <= 2 ? 'poll-deadline--urgent' : '';
  const dlChip    = deadline && !closed
    ? `<span class="poll-deadline ${dlUrgent}">
         <i data-lucide="clock"></i> ${dlLabel}
       </span>` : '';

  // ── Header badges ────────────────────────────────────────────
  const pinnedBar = poll.isPinned
    ? `<div class="post-pin-bar"><i data-lucide="pin"></i> Pinned</div>` : '';

  const archivedBanner = isArchived
    ? `<div style="background:#fef2f2;border-bottom:1px solid #fecaca;padding:.4rem .85rem;
        font-size:.75rem;color:#b91c1c;font-weight:600;display:flex;align-items:center;gap:.4rem;">
        <i data-lucide="archive" style="width:13px;height:13px;"></i>
        Archived
      </div>` : '';

  const extensionNotice = poll.extensionReason
    ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;
        padding:.45rem .75rem;margin-top:.6rem;font-size:.76rem;color:#92400e;
        display:flex;align-items:flex-start;gap:.4rem;">
        <i data-lucide="calendar-clock" style="width:13px;height:13px;flex-shrink:0;margin-top:2px;"></i>
        <span><strong>Deadline extended</strong> — ${esc(poll.extensionReason)}</span>
      </div>` : '';

  const closedBadge = closed
    ? `<span class="status-pill status-pill--closed">Closed</span>` : '';

  const votedBadge  = voted && !closed
    ? `<span class="poll-voted-chip"><i data-lucide="check-circle"></i> Voted</span>` : '';

  // ── Footer ───────────────────────────────────────────────────
  let footerMsg;
  if (isArchived)      footerMsg = 'Archived · Final results';
  else if (!_uid)      footerMsg = 'Sign in to vote.';
  else if (closed)     footerMsg = 'Final results';
  else if (voted)      footerMsg = 'Results shown · Thank you for voting';
  else if (!eligible)  footerMsg = _eligibilityLabel(poll);
  else                 footerMsg = 'Tap an option to cast your vote';

  const footerHtml = `
    <p class="poll-card__meta">
      ${total.toLocaleString()} vote${total !== 1 ? 's' : ''} · ${footerMsg}
    </p>`;

  return `<div class="card poll-card ${poll.isPinned ? 'poll-card--pinned' : ''}"
  style="border-left:4px solid ${_BORDER[poll.category] ?? _BORDER.general};overflow:hidden;">
      ${archivedBanner}${pinnedBar}
      <div class="poll-card__header">
        <div style="flex:1;min-width:0;">
          <div class="poll-meta-row">${catChip}${priChip}${audienceChip}${dlChip}</div>
          <h3 class="poll-card__question">${esc(poll.title)}</h3>
          ${poll.description
            ? `<p class="poll-card__desc">${esc(poll.description)}</p>` : ''}
          ${extensionNotice}
        </div>
        <div style="display:flex;align-items:center;gap:.4rem;flex-shrink:0;">
          ${closedBadge}${votedBadge}
        </div>
      </div>
      <div class="poll-options" id="opts_${esc(poll.id)}">${optionsHtml}</div>
      ${footerHtml}
    </div>`;
}

function _buildEmptyState() {
  return `
    <div class="poll-empty">
      <i data-lucide="bar-chart-2"></i>
      <p>No active consultations at the moment.</p>
      <span>Check back later for new community polls.</span>
    </div>`;
}


// ================================================
// VOTE CONFIRM OVERLAY
// ================================================

/*
   Shows a bottom-anchored confirmation panel before the vote
   is committed. Uses a lazily-created fixed overlay so the
   community.html does not need any extra markup.
*/
window._bcVote = async function (pollId, optionId, optionText) {
  const ok = await showConfirm({
    title:   'Confirm Vote?',
    body:    `You are about to vote for <strong>${esc(optionText)}</strong>. This cannot be undone.`,
    confirm: 'Confirm Vote',
    cancel:  'Cancel',
    variant: 'warning',
  });
  if (!ok) return;
  _pendingConfirm = { pollId, optionId, optionText };
  await window._bcConfirmVote();
};

// ================================================
// VOTE TRANSACTION
// ================================================

/*
   Executes a Firestore transaction that:
     1. Guards against a second vote (reads votes/{uid})
     2. Guards against voting on a non-active poll
     3. Writes votes/{uid} with the chosen optionId
     4. Atomically increments options.{optionId}.voteCount
        and totalVotes on the poll document
   After commit, updates _votedMap and re-triggers a re-render
   on the next snapshot from the subscription.
*/
window._bcConfirmVote = async function () {
  if (!_pendingConfirm) return;
  const { pollId, optionId, optionText } = _pendingConfirm;
  _pendingConfirm = null;
  document.getElementById('_bcConfirmOverlay')?.classList.remove('is-open');

  if (!_uid) {
    _showToast('Please sign in to vote.', 'error');
    return;
  }

  const poll = (document._bcPollCache ?? {})[pollId];
  if (poll && !_isEligible(poll)) {
    _showToast('You are not eligible to vote on this poll.', 'error');
    return;
  }

  try {
    const voteRef = voteDoc(_barangayId, pollId, _uid);
    const pollRef = pollDoc(_barangayId, pollId);

    await runTransaction(db, async tx => {
      const existing = await tx.get(voteRef);
      if (existing.exists()) throw new Error('already_voted');

      const pollSnap = await tx.get(pollRef);
      if (!pollSnap.exists())                  throw new Error('not_found');
      if (pollSnap.data().status !== 'active') throw new Error('not_active');

      /* Write vote — userId as doc ID is the uniqueness constraint */
      tx.set(voteRef, {
        pollId,
        optionId,
        createdAt: serverTimestamp(),
      });

      /* Compute age group for demographic analytics */
      const _ageGroup = (() => {
        if (!_userProfile.dob) return 'unknown';
        const today = new Date();
        const born  = new Date(_userProfile.dob + 'T00:00:00');
        let a = today.getFullYear() - born.getFullYear();
        if (today < new Date(today.getFullYear(), born.getMonth(), born.getDate())) a--;
        if (a < 15)  return 'child';
        if (a <= 30) return 'youth';
        if (a <= 59) return 'adult';
        return 'senior';
      })();

      tx.update(pollRef, {
        [`options.${optionId}.voteCount`]:                 increment(1),
        totalVotes:                                        increment(1),
        [`demographics.${_userProfile.role}.${optionId}`]: increment(1),
        [`demographics.${_ageGroup}.${optionId}`]:         increment(1),
        updatedAt:                                         serverTimestamp(),
      });
    });

    _votedMap.set(pollId, optionId);
    _showToast('Your vote has been recorded.', 'success');

    /* Log the action — non-fatal if it fails */
    try {
      await addDoc(pollActionsCol(_barangayId, pollId), {
        actionType:  'vote',
        performedBy: _uid,
        role:        _role,
        reason:      null,
        timestamp:   serverTimestamp(),
      });
    } catch { /* non-fatal */ }

  } catch (err) {
    const messages = {
      already_voted: 'You have already voted on this poll.',
      not_active:    'This poll is no longer accepting votes.',
      not_found:     'Poll not found.',
    };
    _showToast(messages[err.message] ?? 'Failed to record vote. Please try again.', 'error');
  }
};


// ================================================
// UTILITIES
// ================================================

function _showToast(msg, type = 'success') {
  let container = document.getElementById('_pollToasts');
  if (!container) {
    container = document.createElement('div');
    container.id = '_pollToasts';
    container.style.cssText =
      'position:fixed;bottom:1.5rem;right:1.5rem;' +
      'display:flex;flex-direction:column;gap:.5rem;z-index:2100;pointer-events:none;';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = `toast toast--${type}`;
  t.style.pointerEvents = 'all';
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

// ================================================
// BOOTSTRAP
// ================================================

/*
   Resolves the authenticated user's barangay from userIndex
   then calls initCommunityPolls. Guest users see a sign-in
   prompt since barangay is unknown without auth.
*/
onAuthStateChanged(auth, async user => {
  const container = document.getElementById('pollsList');
  if (!container) return; // module loaded outside community page

  if (!user) {
    container.innerHTML = `
      <div class="poll-empty">
        <i data-lucide="lock"></i>
        <p>Sign in to view community polls.</p>
      </div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons({ el: container });
    return;
  }

  try {
    const snap = await getDoc(userIndexDoc(user.uid));
    if (!snap.exists()) return;
    const { barangay, role } = snap.data();

    /* Fetch full user doc for dob */
    try {
      const { userDoc } = await import('../../core/db-paths.js');
      const fullSnap = await getDoc(userDoc(barangay, user.uid));
      if (fullSnap.exists()) {
        const d = fullSnap.data();
        _userProfile = {
          role: role ?? 'resident',
          dob:  d.dob ?? null,
        };
      }
    } catch { /* non-fatal — defaults remain */ }

    initCommunityPolls(
      toBid(barangay),
      user.uid,
      user.displayName ?? 'Resident',
      role ?? 'resident',
    );
    const _qp2     = new URLSearchParams(window.location.search);
    const _scrollTo = _qp2.get('scrollTo');
    const _tabParam = _qp2.get('tab');

    // If the URL explicitly targets the bulletin tab, let bulletin.js handle it
    if (_scrollTo && _tabParam !== 'bulletin') {

    // Ensure the polls tab is active
    const pollsTabBtn = document.querySelector('[data-tab="polls"]');
    if (pollsTabBtn) {
        const active =
        pollsTabBtn.classList.contains('is-active') ||
        pollsTabBtn.getAttribute('aria-selected') === 'true';
        if (!active) pollsTabBtn.click();
    }

    let _attempts = 0;
    const _MAX    = 14;

    (function tryScroll() {
        const el =
        document.getElementById(`opts_${_scrollTo}`)?.closest('.poll-card') ??
        document.getElementById(`comment-thread-${_scrollTo}`)?.closest('article');

        if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.transition = 'box-shadow .35s';
        el.style.boxShadow  = '0 0 0 3px #f97316, 0 0 0 7px rgba(249,115,22,.18)';
        setTimeout(() => { el.style.boxShadow = ''; }, 2200);
        } else if (_attempts++ < _MAX) {
        setTimeout(tryScroll, 250);
        } else {
        _showToast('This poll is no longer available.', 'error');
        }
    })();
    }

  } catch (err) {
    console.error('[polls] bootstrap error', err);
  }
});