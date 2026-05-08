/* ================================================
   settings-admin.js — BarangayConnect
   Admin panel module for managing barangay-wide
   settings. Renders and persists configuration
   options for post moderation, content filtering,
   post limits, and report thresholds.

   Firestore path:
     barangays/{barangayId}/meta/settings

   WHAT IS IN HERE:
     · Auth-gated initialization with role check
     · Real-time settings subscription and renderer
     · Post approval toggle (requirePostApproval)
     · Default daily post limit control
     · Block links toggle (blockedLinksEnabled)
     · Blocked words list editor
     · Community guidelines notice editor
     · Daily post report limit control
     · Daily comment report limit control
     · Toast notification system

   WHAT IS NOT IN HERE:
     · Post approval enforcement         → community-posts.js
     · Per-user post limit overrides     → roles-admin.js
     · Admin panel layout and styles     → admin.css
     · Firebase config                   → firebase-config.js
     · Firestore path helpers            → db-paths.js

   REQUIRED IMPORTS:
     · ../../core/firebase-config.js           (auth, db)
     · ../../core/db-paths.js                  (userIndexDoc, barangayId)
     · firebase-firestore.js@10.12.0  (doc, getDoc, setDoc, onSnapshot)
     · firebase-auth.js@10.12.0       (onAuthStateChanged)
     · Lucide Icons                   — loaded before this script

   QUICK REFERENCE:
     Init                      → onAuthStateChanged (auto-runs on import)
     Render                    → renderSettings(data)
     Post approval toggle      → window.handleRequireApprovalToggle(checkbox)
     Block links toggle        → window.handleBlockLinksToggle(checkbox)
     Save blocked words        → window.saveBlockedWords()
     Save post warning         → window.savePostWarning()
     Save default post limit   → window.saveDefaultPostLimit()
     Save post report limit    → window.saveReportLimit()
     Save comment report limit → window.saveCommentReportLimit()
     Settings container        → #settingsContainer
================================================ */


/* ================================================
   IMPORTS
================================================ */

import { auth, db } from '../../core/firebase-config.js';
import { userIndexDoc, barangayId as toBid } from '../../core/db-paths.js';

import {
  doc, getDoc, setDoc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";


/* ================================================
   MODULE STATE
================================================ */

let _barangayId  = null;
let _settingsRef = null;


/* ================================================
   INIT — auth-gated, role-restricted
   Resolves the barangay ID and settings document
   reference, then subscribes to real-time updates.
   Admin and officer roles only.
================================================ */

onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  const snap = await getDoc(userIndexDoc(user.uid));
  if (!snap.exists()) return;

  const { barangay, role } = snap.data();
  if (role !== 'admin' && role !== 'officer') return;

  _barangayId  = toBid(barangay);
  _settingsRef = doc(db, 'barangays', _barangayId, 'meta', 'settings');

  onSnapshot(_settingsRef, (settingsSnap) => {
    const data = settingsSnap.exists() ? settingsSnap.data() : {};
    renderSettings(data);
  });
});


/* ================================================
   RENDER
   Builds and injects the full settings UI from
   the current Firestore settings document. Called
   on every real-time snapshot update.
================================================ */

function renderSettings(data) {
  const container = document.getElementById('settingsContainer');
  if (!container) return;

  const requireApproval = data.requirePostApproval ?? false;

  container.innerHTML = `

    <!-- Community Posts -->
    <div style="background:#fff;border-radius:12px;padding:1.5rem;
      box-shadow:0 1px 4px rgba(0,0,0,.07);max-width:600px;">

      <h2 style="font-size:1rem;font-weight:700;margin:0 0 1.25rem;
        display:flex;align-items:center;gap:.5rem;">
        <i data-lucide="message-square" style="width:17px;height:17px;color:#1a3a1a;"></i>
        Community Posts
      </h2>

      <!-- Require post approval toggle -->
      <div style="display:flex;align-items:flex-start;justify-content:space-between;
        gap:1rem;padding:1rem;border:1.5px solid #e5e7eb;border-radius:10px;">
        <div>
          <p style="font-weight:600;font-size:.9rem;margin:0 0 4px;">Require post approval</p>
          <p style="font-size:.78rem;color:#6b7280;margin:0;line-height:1.5;">
            When enabled, resident community posts are saved as
            <strong>pending</strong> and won't appear in the bulletin
            until an admin publishes them.
          </p>
        </div>
        <label style="flex-shrink:0;cursor:pointer;position:relative;
          width:44px;height:24px;display:inline-block;">
          <input type="checkbox" id="requireApprovalToggle"
            ${requireApproval ? 'checked' : ''}
            onchange="handleRequireApprovalToggle(this)"
            style="opacity:0;width:0;height:0;position:absolute;" />
          <span id="toggleTrack" style="
            position:absolute;inset:0;border-radius:999px;
            background:${requireApproval ? '#1a3a1a' : '#d1d5db'};
            transition:background .2s;cursor:pointer;">
            <span style="
              position:absolute;top:3px;
              left:${requireApproval ? '23px' : '3px'};
              width:18px;height:18px;border-radius:50%;
              background:#fff;transition:left .2s;
              box-shadow:0 1px 3px rgba(0,0,0,.2);">
            </span>
          </span>
        </label>
      </div>

    </div>

    <!-- Post Limits -->
    <div style="background:#fff;border-radius:12px;padding:1.5rem;
      box-shadow:0 1px 4px rgba(0,0,0,.07);max-width:600px;margin-top:1rem;">

      <h2 style="font-size:1rem;font-weight:700;margin:0 0 1.25rem;
        display:flex;align-items:center;gap:.5rem;">
        <i data-lucide="edit-3" style="width:17px;height:17px;color:#1a3a1a;"></i>
        Post Limits
      </h2>

      <!-- Default daily post limit -->
      <div style="padding:1rem;border:1.5px solid #e5e7eb;border-radius:10px;">
        <p style="font-weight:600;font-size:.9rem;margin:0 0 4px;">Default daily post limit</p>
        <p style="font-size:.78rem;color:#6b7280;margin:0 0 .75rem;line-height:1.5;">
          How many posts a resident can make per day by default.
          Individual overrides in Users &amp; Roles take priority.
        </p>
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
          <input type="number" id="defaultPostLimitInput" min="1" max="99"
            value="${data.defaultPostLimit ?? 3}"
            style="width:60px;padding:.4rem .6rem;border:1.5px solid #e0e0e0;border-radius:8px;
              font-size:.88rem;text-align:center;outline:none;font-weight:600;" />
          <span style="font-size:.78rem;color:#6b7280;">posts per day</span>
          <button onclick="saveDefaultPostLimit()"
            style="padding:.4rem .9rem;border-radius:8px;background:#1a3a1a;
              color:#fff;border:none;font-size:.78rem;font-weight:600;cursor:pointer;">
            Save
          </button>
        </div>
      </div>

    </div>

    <!-- Content Moderation -->
    <div style="background:#fff;border-radius:12px;padding:1.5rem;
      box-shadow:0 1px 4px rgba(0,0,0,.07);max-width:600px;margin-top:1rem;">

      <h2 style="font-size:1rem;font-weight:700;margin:0 0 1.25rem;
        display:flex;align-items:center;gap:.5rem;">
        <i data-lucide="shield" style="width:17px;height:17px;color:#1a3a1a;"></i>
        Content Moderation
      </h2>

      <!-- Block links toggle -->
      <div style="display:flex;align-items:flex-start;justify-content:space-between;
        gap:1rem;padding:1rem;border:1.5px solid #e5e7eb;border-radius:10px;margin-bottom:.75rem;">
        <div>
          <p style="font-weight:600;font-size:.9rem;margin:0 0 4px;">Block links in posts</p>
          <p style="font-size:.78rem;color:#6b7280;margin:0;line-height:1.5;">
            Posts containing URLs will be automatically flagged for review.
          </p>
        </div>
        <label style="flex-shrink:0;cursor:pointer;position:relative;
          width:44px;height:24px;display:inline-block;">
          <input type="checkbox" id="blockLinksToggle"
            ${data.blockedLinksEnabled ?? true ? 'checked' : ''}
            onchange="handleBlockLinksToggle(this)"
            style="opacity:0;width:0;height:0;position:absolute;" />
          <span id="blockLinksTrack" style="
            position:absolute;inset:0;border-radius:999px;
            background:${data.blockedLinksEnabled ?? true ? '#1a3a1a' : '#d1d5db'};
            transition:background .2s;cursor:pointer;">
            <span style="
              position:absolute;top:3px;
              left:${data.blockedLinksEnabled ?? true ? '23px' : '3px'};
              width:18px;height:18px;border-radius:50%;background:#fff;
              transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.2);">
            </span>
          </span>
        </label>
      </div>

      <!-- Blocked words list -->
      <div style="padding:1rem;border:1.5px solid #e5e7eb;border-radius:10px;margin-bottom:.75rem;">
        <p style="font-weight:600;font-size:.9rem;margin:0 0 4px;">Blocked words</p>
        <p style="font-size:.78rem;color:#6b7280;margin:0 0 .75rem;line-height:1.5;">
          Posts containing these words will be flagged for review. One word or phrase per line.
        </p>
        <textarea id="blockedWordsInput" rows="5"
          style="width:100%;padding:.55rem .75rem;border:1.5px solid #e0e0e0;border-radius:8px;
            font-size:.82rem;outline:none;resize:vertical;box-sizing:border-box;"
          placeholder="e.g.&#10;badword&#10;offensive phrase&#10;spam link">${(data.blockedWords ?? []).join('\n')}</textarea>
        <div style="display:flex;gap:.5rem;margin-top:.5rem;flex-wrap:wrap;">
          <button onclick="loadDefaultBlockedWords()"
            style="padding:.4rem .9rem;border-radius:8px;border:1.5px solid #e0e0e0;
              background:#fff;color:#555;font-size:.78rem;font-weight:600;cursor:pointer;">
            What's this?
          </button>
          <button onclick="saveBlockedWords()"
            style="padding:.4rem .9rem;border-radius:8px;background:#1a3a1a;
              color:#fff;border:none;font-size:.78rem;font-weight:600;cursor:pointer;">
            Save Words
          </button>
        </div>
      </div>

      <!-- Community guidelines notice -->
      <div style="padding:1rem;border:1.5px solid #e5e7eb;border-radius:10px;margin-bottom:.75rem;">
        <p style="font-weight:600;font-size:.9rem;margin:0 0 4px;">Community guidelines notice</p>
        <p style="font-size:.78rem;color:#6b7280;margin:0 0 .75rem;line-height:1.5;">
          Shown to residents in the new post modal as a reminder.
        </p>
        <textarea id="postWarningInput" rows="2"
          style="width:100%;padding:.55rem .75rem;border:1.5px solid #e0e0e0;border-radius:8px;
            font-size:.82rem;outline:none;resize:vertical;box-sizing:border-box;"
          placeholder="e.g. Offensive, hateful, or spam posts will be removed.">${data.postWarningText ?? ''}</textarea>
        <button onclick="savePostWarning()"
          style="margin-top:.5rem;padding:.4rem .9rem;border-radius:8px;background:#1a3a1a;
            color:#fff;border:none;font-size:.78rem;font-weight:600;cursor:pointer;">
          Save Notice
        </button>
      </div>

      <!-- Poll archive delay -->
      <div style="padding:1rem;border:1.5px solid #e5e7eb;border-radius:10px;margin-bottom:.75rem;">
        <p style="font-weight:600;font-size:.9rem;margin:0 0 4px;">Auto-archive closed polls after</p>
        <p style="font-size:.78rem;color:#6b7280;margin:0 0 .75rem;line-height:1.5;">
          Closed polls will automatically move to Archived after this many days. Default is 1.
        </p>
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
          <input type="number" id="pollArchiveDaysInput" min="0" max="365"
            value="${data.pollArchiveDays ?? 1}"
            style="width:60px;padding:.4rem .6rem;border:1.5px solid #e0e0e0;border-radius:8px;
              font-size:.88rem;text-align:center;outline:none;font-weight:600;" />
          <span style="font-size:.78rem;color:#6b7280;">days after closing</span>
          <button onclick="savePollArchiveDays()"
            style="padding:.4rem .9rem;border-radius:8px;background:#1a3a1a;
              color:#fff;border:none;font-size:.78rem;font-weight:600;cursor:pointer;">
            Save
          </button>
        </div>
      </div>

      <!-- Daily post report limit -->
      <div style="padding:1rem;border:1.5px solid #e5e7eb;border-radius:10px;margin-bottom:.75rem;">
        <p style="font-weight:600;font-size:.9rem;margin:0 0 4px;">Daily post report limit per resident</p>
        <p style="font-size:.78rem;color:#6b7280;margin:0 0 .75rem;line-height:1.5;">
          Maximum number of post reports a resident can submit per day. Prevents spam abuse.
        </p>
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
          <input type="number" id="reportLimitInput" min="1" max="99"
            value="${data.dailyReportLimit ?? 3}"
            style="width:60px;padding:.4rem .6rem;border:1.5px solid #e0e0e0;border-radius:8px;
              font-size:.88rem;text-align:center;outline:none;font-weight:600;" />
          <span style="font-size:.78rem;color:#6b7280;">reports per day</span>
          <button onclick="saveReportLimit()"
            style="padding:.4rem .9rem;border-radius:8px;background:#1a3a1a;
              color:#fff;border:none;font-size:.78rem;font-weight:600;cursor:pointer;">
            Save
          </button>
        </div>
      </div>

      <!-- Daily comment report limit -->
      <div style="padding:1rem;border:1.5px solid #e5e7eb;border-radius:10px;">
        <p style="font-weight:600;font-size:.9rem;margin:0 0 4px;">Daily comment report limit per resident</p>
        <p style="font-size:.78rem;color:#6b7280;margin:0 0 .75rem;line-height:1.5;">
          Maximum number of comment reports a resident can submit per day. Defaults to 5 if not set.
        </p>
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
          <input type="number" id="commentReportLimitInput" min="1" max="99"
            value="${data.dailyCommentReportLimit ?? 5}"
            style="width:60px;padding:.4rem .6rem;border:1.5px solid #e0e0e0;border-radius:8px;
              font-size:.88rem;text-align:center;outline:none;font-weight:600;" />
          <span style="font-size:.78rem;color:#6b7280;">reports per day</span>
          <button onclick="saveCommentReportLimit()"
            style="padding:.4rem .9rem;border-radius:8px;background:#1a3a1a;
              color:#fff;border:none;font-size:.78rem;font-weight:600;cursor:pointer;">
            Save
          </button>
        </div>
      </div>

    </div>

    <!-- Gallery Settings -->
    <div style="background:#fff;border-radius:12px;padding:1.5rem;
      box-shadow:0 1px 4px rgba(0,0,0,.07);max-width:600px;margin-top:1rem;">

      <h2 style="font-size:1rem;font-weight:700;margin:0 0 1.25rem;
        display:flex;align-items:center;gap:.5rem;">
        <i data-lucide="image" style="width:17px;height:17px;color:#1a3a1a;"></i>
        Featured Gallery
      </h2>

      <!-- Require approval to feature toggle -->
      <div style="display:flex;align-items:flex-start;justify-content:space-between;
        gap:1rem;padding:1rem;border:1.5px solid #e5e7eb;border-radius:10px;margin-bottom:.75rem;">
        <div>
          <p style="font-weight:600;font-size:.9rem;margin:0 0 4px;">Require approval to feature</p>
          <p style="font-size:.78rem;color:#6b7280;margin:0;line-height:1.5;">
            When enabled, officers cannot directly add posts to the gallery.
            Their requests create a pending queue that only admins can approve.
            Admins always bypass this check.
          </p>
        </div>
        <label style="flex-shrink:0;cursor:pointer;position:relative;
          width:44px;height:24px;display:inline-block;">
          <input type="checkbox" id="requireFeatureApprovalToggle"
            ${data.requireApprovalToFeature ? 'checked' : ''}
            onchange="handleRequireFeatureApprovalToggle(this)"
            style="opacity:0;width:0;height:0;position:absolute;" />
          <span id="featureApprovalTrack" style="
            position:absolute;inset:0;border-radius:999px;
            background:${data.requireApprovalToFeature ? '#1a3a1a' : '#d1d5db'};
            transition:background .2s;cursor:pointer;">
            <span style="
              position:absolute;top:3px;
              left:${data.requireApprovalToFeature ? '23px' : '3px'};
              width:18px;height:18px;border-radius:50%;
              background:#fff;transition:left .2s;
              box-shadow:0 1px 3px rgba(0,0,0,.2);">
            </span>
          </span>
        </label>
      </div>

      <!-- Featured post cap -->
      <div style="padding:1rem;border:1.5px solid #e5e7eb;border-radius:10px;">
        <p style="font-weight:600;font-size:.9rem;margin:0 0 4px;">Featured post cap</p>
        <p style="font-size:.78rem;color:#6b7280;margin:0 0 .75rem;line-height:1.5;">
          Maximum number of posts that can be featured in the gallery at once.
          Admins and officers will see an error if this limit is reached.
        </p>
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
          <input type="number" id="featuredPostLimitInput" min="1" max="100"
            value="${data.featuredPostLimit ?? 20}"
            style="width:60px;padding:.4rem .6rem;border:1.5px solid #e0e0e0;border-radius:8px;
              font-size:.88rem;text-align:center;outline:none;font-weight:600;" />
          <span style="font-size:.78rem;color:#6b7280;">posts max</span>
          <button onclick="saveFeaturedPostLimit()"
            style="padding:.4rem .9rem;border-radius:8px;background:#1a3a1a;
              color:#fff;border:none;font-size:.78rem;font-weight:600;cursor:pointer;">
            Save
          </button>
        </div>

      </div>
    </div>

    <!-- Pet Board Settings -->
    <div style="background:#fff;border-radius:12px;padding:1.5rem;
      box-shadow:0 1px 4px rgba(0,0,0,.07);max-width:600px;margin-top:1rem;">

      <h2 style="font-size:1rem;font-weight:700;margin:0 0 1.25rem;
        display:flex;align-items:center;gap:.5rem;">
        <i data-lucide="paw-print" style="width:17px;height:17px;color:#1a3a1a;"></i>
        Pet Board
      </h2>

      <!-- Require photo approval -->
      <div style="display:flex;align-items:flex-start;justify-content:space-between;
        gap:1rem;padding:1rem;border:1.5px solid #e5e7eb;border-radius:10px;margin-bottom:.75rem;">
        <div>
          <p style="font-weight:600;font-size:.9rem;margin:0 0 4px;">Require approval for pet reports</p>
          <p style="font-size:.78rem;color:#6b7280;margin:0;line-height:1.5;">
            When enabled, all submitted pet reports go to a pending queue before appearing publicly.
            When off, reports go live immediately after submission.
          </p>
        </div>
        <label style="flex-shrink:0;cursor:pointer;position:relative;
          width:44px;height:24px;display:inline-block;">
          <input type="checkbox" id="requirePetApprovalToggle"
            ${data.requirePetApproval ?? true ? 'checked' : ''}
            onchange="handleRequirePetApprovalToggle(this)"
            style="opacity:0;width:0;height:0;position:absolute;" />
          <span id="petApprovalTrack" style="
            position:absolute;inset:0;border-radius:999px;
            background:${data.requirePetApproval ?? true ? '#1a3a1a' : '#d1d5db'};
            transition:background .2s;cursor:pointer;">
            <span style="
              position:absolute;top:3px;
              left:${data.requirePetApproval ?? true ? '23px' : '3px'};
              width:18px;height:18px;border-radius:50%;
              background:#fff;transition:left .2s;
              box-shadow:0 1px 3px rgba(0,0,0,.2);">
            </span>
          </span>
        </label>
      </div>

      <!-- Auto-delete resolved/found reports -->
      <div style="padding:1rem;border:1.5px solid #e5e7eb;border-radius:10px;margin-bottom:.75rem;">
        <p style="font-weight:600;font-size:.9rem;margin:0 0 4px;">Auto-delete resolved reports after</p>
        <p style="font-size:.78rem;color:#6b7280;margin:0 0 .75rem;line-height:1.5;">
          Resolved and expired pet reports will be automatically deleted after this many days. Default is 3. Set to 0 to disable.
        </p>
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
          <input type="number" id="petResolvedDeleteDaysInput" min="0" max="30"
            value="${data.petResolvedDeleteDays ?? 3}"
            style="width:60px;padding:.4rem .6rem;border:1.5px solid #e0e0e0;border-radius:8px;
              font-size:.88rem;text-align:center;outline:none;font-weight:600;" />
          <span style="font-size:.78rem;color:#6b7280;">days after resolving</span>
          <button onclick="savePetResolvedDeleteDays()"
            style="padding:.4rem .9rem;border-radius:8px;background:#1a3a1a;
              color:#fff;border:none;font-size:.78rem;font-weight:600;cursor:pointer;">
            Save
          </button>
        </div>
      </div>

      <!-- Max contact messages per sender per report -->
      <div style="padding:1rem;border:1.5px solid #e5e7eb;border-radius:10px;margin-bottom:.75rem;">
        <p style="font-weight:600;font-size:.9rem;margin:0 0 4px;">Max messages per sender per report</p>
        <p style="font-size:.78rem;color:#6b7280;margin:0 0 .75rem;line-height:1.5;">
          How many contact messages one person can send to a single pet report. Default is 3.
        </p>
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
          <input type="number" id="petContactLimitInput" min="1" max="20"
            value="${data.maxPetContactsPerSender ?? 3}"
            style="width:60px;padding:.4rem .6rem;border:1.5px solid #e0e0e0;border-radius:8px;
              font-size:.88rem;text-align:center;outline:none;font-weight:600;" />
          <span style="font-size:.78rem;color:#6b7280;">messages per report</span>
          <button onclick="savePetContactLimit()"
            style="padding:.4rem .9rem;border-radius:8px;background:#1a3a1a;
              color:#fff;border:none;font-size:.78rem;font-weight:600;cursor:pointer;">
            Save
          </button>
        </div>
      </div>

      <!-- Daily pet report limit -->
      <div style="padding:1rem;border:1.5px solid #e5e7eb;border-radius:10px;">
        <p style="font-weight:600;font-size:.9rem;margin:0 0 4px;">Daily pet report limit per resident</p>
        <p style="font-size:.78rem;color:#6b7280;margin:0 0 .75rem;line-height:1.5;">
          Maximum pet reports a resident can submit per day. Default is 3.
        </p>
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
          <input type="number" id="petReportDailyLimitInput" min="1" max="20"
            value="${data.petReportDailyLimit ?? 3}"
            style="width:60px;padding:.4rem .6rem;border:1.5px solid #e0e0e0;border-radius:8px;
              font-size:.88rem;text-align:center;outline:none;font-weight:600;" />
          <span style="font-size:.78rem;color:#6b7280;">reports per day</span>
          <button onclick="savePetReportDailyLimit()"
            style="padding:.4rem .9rem;border-radius:8px;background:#1a3a1a;
              color:#fff;border:none;font-size:.78rem;font-weight:600;cursor:pointer;">
            Save
          </button>
        </div>
      </div>

    </div>

    <!-- Events Settings -->
    <div style="background:#fff;border-radius:12px;padding:1.5rem;
      box-shadow:0 1px 4px rgba(0,0,0,.07);max-width:600px;margin-top:1rem;">

      <h2 style="font-size:1rem;font-weight:700;margin:0 0 1.25rem;
        display:flex;align-items:center;gap:.5rem;">
        <i data-lucide="calendar-days" style="width:17px;height:17px;color:#1a3a1a;"></i>
        Events
      </h2>

      <!-- Require event approval toggle -->
      <div style="display:flex;align-items:flex-start;justify-content:space-between;
        gap:1rem;padding:1rem;border:1.5px solid #e5e7eb;border-radius:10px;margin-bottom:.75rem;">
        <div>
          <p style="font-weight:600;font-size:.9rem;margin:0 0 4px;">Require event approval</p>
          <p style="font-size:.78rem;color:#6b7280;margin:0;line-height:1.5;">
            When enabled, community-submitted events are held as
            <strong>pending</strong> until an admin or officer approves them.
            When off, submissions go live immediately.
          </p>
        </div>
        <label style="flex-shrink:0;cursor:pointer;position:relative;
          width:44px;height:24px;display:inline-block;">
          <input type="checkbox" id="requireEventApprovalToggle"
            ${data.requireEventApproval ?? true ? 'checked' : ''}
            onchange="handleRequireEventApprovalToggle(this)"
            style="opacity:0;width:0;height:0;position:absolute;" />
          <span id="eventApprovalTrack" style="
            position:absolute;inset:0;border-radius:999px;
            background:${data.requireEventApproval ?? true ? '#1a3a1a' : '#d1d5db'};
            transition:background .2s;cursor:pointer;">
            <span style="
              position:absolute;top:3px;
              left:${data.requireEventApproval ?? true ? '23px' : '3px'};
              width:18px;height:18px;border-radius:50%;
              background:#fff;transition:left .2s;
              box-shadow:0 1px 3px rgba(0,0,0,.2);">
            </span>
          </span>
        </label>
      </div>

      <!-- Auto-delete completed events -->
      <div style="padding:1rem;border:1.5px solid #e5e7eb;border-radius:10px;">
        <p style="font-weight:600;font-size:.9rem;margin:0 0 4px;">Auto-delete completed events after</p>
        <p style="font-size:.78rem;color:#6b7280;margin:0 0 .75rem;line-height:1.5;">
          Events marked as completed will be automatically deleted after this many days. Default is 1.
        </p>
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
          <input type="number" id="completedEventDeleteDaysInput" min="0" max="365"
            value="${data.completedEventDeleteDays ?? 1}"
            style="width:60px;padding:.4rem .6rem;border:1.5px solid #e0e0e0;border-radius:8px;
              font-size:.88rem;text-align:center;outline:none;font-weight:600;" />
          <span style="font-size:.78rem;color:#6b7280;">days after completing</span>
          <button onclick="saveCompletedEventDeleteDays()"
            style="padding:.4rem .9rem;border-radius:8px;background:#1a3a1a;
              color:#fff;border:none;font-size:.78rem;font-weight:600;cursor:pointer;">
            Save
          </button>
        </div>
      </div>

    </div>

      </div>

    </div>`;

  lucide.createIcons({ el: container });
}


/* ================================================
   TOGGLES
   Handle binary setting changes with immediate
   optimistic UI updates and Firestore persistence.
================================================ */

/* Updates the post approval toggle and persists the new value */
window.handleRequireApprovalToggle = async function (checkbox) {
  if (!_settingsRef) return;

  const track = document.getElementById('toggleTrack');
  if (track) {
    track.style.background              = checkbox.checked ? '#1a3a1a' : '#d1d5db';
    track.querySelector('span').style.left = checkbox.checked ? '23px' : '3px';
  }

  showSettingsToast('Saving…');

  try {
    await setDoc(_settingsRef, {
      requirePostApproval: checkbox.checked,
    }, { merge: true });
    showSettingsToast('Saved ✓', 'success');
  } catch (err) {
    console.error('[settings] save error:', err);
    checkbox.checked = !checkbox.checked;
  }
};

/* Updates the block links toggle and persists the new value */
window.handleBlockLinksToggle = async function (checkbox) {
  if (!_settingsRef) return;

  const track = document.getElementById('blockLinksTrack');
  if (track) {
    track.style.background              = checkbox.checked ? '#1a3a1a' : '#d1d5db';
    track.querySelector('span').style.left = checkbox.checked ? '23px' : '3px';
  }

  try {
    await setDoc(_settingsRef, { blockedLinksEnabled: checkbox.checked }, { merge: true });
  } catch (err) {
    checkbox.checked = !checkbox.checked;
  }
};


/* ================================================
   SAVE ACTIONS
   Each handler reads from its corresponding input,
   validates if needed, and merges the value into
   the settings document.
================================================ */

/* Clears the blocked words input and shows a usage reminder */
window.loadDefaultBlockedWords = function () {
  const el = document.getElementById('blockedWordsInput');
  if (el) el.value = '';
  alert('Automatic profanity filtering is enabled. Use this list for custom local words only.');
};

/* Saves the blocked words list — one entry per non-empty line */
window.saveBlockedWords = async function () {
  if (!_settingsRef) return;
  const words = (document.getElementById('blockedWordsInput')?.value ?? '')
    .split('\n').map(w => w.trim().toLowerCase()).filter(Boolean);
  showSettingsToast('Saving…');
  try {
    await setDoc(_settingsRef, { blockedWords: words }, { merge: true });
    showSettingsToast('Saved ✓', 'success');
  } catch (err) {
    showSettingsToast('Failed to save. Try again.', 'error');
  }
};

/* Saves the community guidelines notice text */
window.savePostWarning = async function () {
  if (!_settingsRef) return;
  const text = document.getElementById('postWarningInput')?.value.trim() ?? '';
  showSettingsToast('Saving…');
  try {
    await setDoc(_settingsRef, { postWarningText: text }, { merge: true });
    showSettingsToast('Saved ✓', 'success');
  } catch (err) {
    showSettingsToast('Failed to save. Try again.', 'error');
  }
};

/* Saves the default daily post limit for residents */
window.saveDefaultPostLimit = async function () {
  if (!_settingsRef) return;
  const val = parseInt(document.getElementById('defaultPostLimitInput')?.value, 10);
  if (isNaN(val) || val < 1 || val > 99) return;
  showSettingsToast('Saving…');
  try {
    await setDoc(_settingsRef, { defaultPostLimit: val }, { merge: true });
    showSettingsToast('Saved ✓', 'success');
  } catch {
    showSettingsToast('Failed to save. Try again.', 'error');
  }
};

/* Saves the daily post report limit per resident */
window.saveReportLimit = async function () {
  if (!_settingsRef) return;
  const val = parseInt(document.getElementById('reportLimitInput')?.value, 10);
  if (isNaN(val) || val < 1 || val > 99) return;
  showSettingsToast('Saving…');
  try {
    await setDoc(_settingsRef, { dailyReportLimit: val }, { merge: true });
    showSettingsToast('Saved ✓', 'success');
  } catch {
    showSettingsToast('Failed to save. Try again.', 'error');
  }
};

/* Saves the daily comment report limit per resident */
window.saveCommentReportLimit = async function () {
  if (!_settingsRef) return;
  const val = parseInt(document.getElementById('commentReportLimitInput')?.value, 10);
  if (isNaN(val) || val < 1 || val > 99) return;
  showSettingsToast('Saving…');
  try {
    await setDoc(_settingsRef, { dailyCommentReportLimit: val }, { merge: true });
    showSettingsToast('Saved ✓', 'success');
  } catch {
    showSettingsToast('Failed to save. Try again.', 'error');
  }
};

/* Saves the require-approval-to-feature setting for the gallery */
window.handleRequireFeatureApprovalToggle = async function (checkbox) {
  if (!_settingsRef) return;

  const track = document.getElementById('featureApprovalTrack');
  if (track) {
    track.style.background                 = checkbox.checked ? '#1a3a1a' : '#d1d5db';
    track.querySelector('span').style.left = checkbox.checked ? '23px' : '3px';
  }

  showSettingsToast('Saving…');
  try {
    await setDoc(_settingsRef, { requireApprovalToFeature: checkbox.checked }, { merge: true });
    showSettingsToast('Saved ✓', 'success');
  } catch (err) {
    console.error('[settings] save error:', err);
    checkbox.checked = !checkbox.checked;
  }
};

/* Saves the featured post cap for the gallery */
window.saveFeaturedPostLimit = async function () {
  if (!_settingsRef) return;
  const val = parseInt(document.getElementById('featuredPostLimitInput')?.value, 10);
  if (isNaN(val) || val < 1 || val > 100) return;
  showSettingsToast('Saving…');
  try {
    await setDoc(_settingsRef, { featuredPostLimit: val }, { merge: true });
    showSettingsToast('Saved ✓', 'success');
  } catch {
    showSettingsToast('Failed to save. Try again.', 'error');
  }
};

/* Saves the number of days before closed polls are auto-archived */
window.savePollArchiveDays = async function () {
  if (!_settingsRef) return;
  const val = parseInt(document.getElementById('pollArchiveDaysInput')?.value, 10);
  if (isNaN(val) || val < 0 || val > 365) return;
  showSettingsToast('Saving…');
  try {
    await setDoc(_settingsRef, { pollArchiveDays: val }, { merge: true });
    showSettingsToast('Saved ✓', 'success');
  } catch {
    showSettingsToast('Failed to save. Try again.', 'error');
  }
};

/* Saves the require-event-approval setting */
window.handleRequireEventApprovalToggle = async function (checkbox) {
  if (!_settingsRef) return;
  const track = document.getElementById('eventApprovalTrack');
  if (track) {
    track.style.background                 = checkbox.checked ? '#1a3a1a' : '#d1d5db';
    track.querySelector('span').style.left = checkbox.checked ? '23px' : '3px';
  }
  showSettingsToast('Saving…');
  try {
    await setDoc(_settingsRef, { requireEventApproval: checkbox.checked }, { merge: true });
    showSettingsToast('Saved ✓', 'success');
  } catch (err) {
    console.error('[settings] save error:', err);
    checkbox.checked = !checkbox.checked;
  }
};

/* Saves the number of days before completed events are auto-deleted */
window.saveCompletedEventDeleteDays = async function () {
  if (!_settingsRef) return;
  const val = parseInt(document.getElementById('completedEventDeleteDaysInput')?.value, 10);
  if (isNaN(val) || val < 0 || val > 365) return;
  showSettingsToast('Saving…');
  try {
    await setDoc(_settingsRef, { completedEventDeleteDays: val }, { merge: true });
    showSettingsToast('Saved ✓', 'success');
  } catch {
    showSettingsToast('Failed to save. Try again.', 'error');
  }
};

/* Toggles whether pet reports require admin/officer approval before going live */
window.handleRequirePetApprovalToggle = async function (checkbox) {
  if (!_settingsRef) return;
  const track = document.getElementById('petApprovalTrack');
  if (track) {
    track.style.background                 = checkbox.checked ? '#1a3a1a' : '#d1d5db';
    track.querySelector('span').style.left = checkbox.checked ? '23px' : '3px';
  }
  showSettingsToast('Saving…');
  try {
    await setDoc(_settingsRef, { requirePetApproval: checkbox.checked }, { merge: true });
    showSettingsToast('Saved ✓', 'success');
  } catch (err) {
    console.error('[settings] save error:', err);
    checkbox.checked = !checkbox.checked;
  }
};

/* Saves the auto-delete delay for resolved/expired pet reports */
window.savePetResolvedDeleteDays = async function () {
  if (!_settingsRef) return;
  const val = parseInt(document.getElementById('petResolvedDeleteDaysInput')?.value, 10);
  if (isNaN(val) || val < 0 || val > 30) return;
  showSettingsToast('Saving…');
  try {
    await setDoc(_settingsRef, { petResolvedDeleteDays: val }, { merge: true });
    showSettingsToast('Saved ✓', 'success');
  } catch {
    showSettingsToast('Failed to save. Try again.', 'error');
  }
};

/* Saves the max contact messages per sender per report */
window.savePetContactLimit = async function () {
  if (!_settingsRef) return;
  const val = parseInt(document.getElementById('petContactLimitInput')?.value, 10);
  if (isNaN(val) || val < 1 || val > 20) return;
  showSettingsToast('Saving…');
  try {
    await setDoc(_settingsRef, { maxPetContactsPerSender: val }, { merge: true });
    showSettingsToast('Saved ✓', 'success');
  } catch {
    showSettingsToast('Failed to save. Try again.', 'error');
  }
};

/* Saves the daily pet report limit per resident */
window.savePetReportDailyLimit = async function () {
  if (!_settingsRef) return;
  const val = parseInt(document.getElementById('petReportDailyLimitInput')?.value, 10);
  if (isNaN(val) || val < 1 || val > 20) return;
  showSettingsToast('Saving…');
  try {
    await setDoc(_settingsRef, { petReportDailyLimit: val }, { merge: true });
    showSettingsToast('Saved ✓', 'success');
  } catch {
    showSettingsToast('Failed to save. Try again.', 'error');
  }
};

/* Saves which roles can see the gallery tab */
window.saveGalleryVisibility = async function () {
  if (!_settingsRef) return;
  const checked = [...document.querySelectorAll('input[type="checkbox"][value]')]
    .filter(cb => ['resident','officer','admin'].includes(cb.value) && cb.checked)
    .map(cb => cb.value);
  try {
    await setDoc(_settingsRef, { galleryVisibleTo: checked }, { merge: true });
    showSettingsToast('Saved ✓', 'success');
  } catch { showSettingsToast('Failed to save. Try again.', 'error'); }
};


/* ================================================
   TOAST
   Renders a brief status notification in the
   designated container, auto-removed after 3.5s.
================================================ */

function showSettingsToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const t     = document.createElement('div');
  t.className = `toast toast--${type}`;
  t.innerHTML = `<i data-lucide="${type === 'success' ? 'check' : 'x-circle'}"></i>${msg}`;

  container.appendChild(t);
  lucide.createIcons({ el: t });
  setTimeout(() => t.remove(), 3500);
}