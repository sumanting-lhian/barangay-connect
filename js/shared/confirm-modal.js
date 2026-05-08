/* ================================================
   confirm-modal.js — BarangayConnect
   Reusable programmatic confirm modal. Uses the
   existing .modal--confirm system from frames.css.
   Works for sign-out, delete, vote, close-poll,
   or any confirm/cancel/ok flow.

   WHAT IS IN HERE:
     · Single injected modal instance (reused)
     · showConfirm(options) — main entry point
     · Three theme variants: danger / warning / confirm
     · Promise-based: resolves true (confirmed) or false

   WHAT IS NOT IN HERE:
     · Modal styles          → frames.css (.modal--confirm)
     · Button styles         → buttons.css
     · Notification bell     → notifications.js
     · Auth                  → nav-auth.js

   QUICK REFERENCE:
     Show modal  → showConfirm({ title, body, confirm, cancel, variant })
     Variants    → 'danger' (red) | 'warning' (orange) | 'confirm' (green)
     Returns     → Promise<boolean>

   USAGE EXAMPLE:
     import { showConfirm } from '/js/shared/confirm-modal.js';

     const ok = await showConfirm({
       title:   'Delete this post?',
       body:    'This cannot be undone.',
       confirm: 'Yes, delete',
       cancel:  'Go back',
       variant: 'danger',
     });
     if (!ok) return;
================================================ */

const _ICONS = {
  danger:  { icon: 'triangle-alert', iconBg: '#fff3f3', iconBorder: '#fecaca', iconColor: '#dc2626', btnClass: 'btn--red'    },
  warning: { icon: 'alert-circle',   iconBg: '#fff8ed', iconBorder: '#fed7aa', iconColor: '#d97706', btnClass: 'btn--orange'  },
  confirm: { icon: 'check-circle',   iconBg: '#f0fdf4', iconBorder: '#bbf7d0', iconColor: '#15803d', btnClass: 'btn--green'   },
};

function _ensureModal() {
  if (document.getElementById('_bcConfirmOverlay')) return;

  const overlay = document.createElement('div');
  overlay.id = '_bcConfirmOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal modal--confirm" id="_bcConfirmBox" onclick="event.stopPropagation()">
      <div class="modal-confirm__icon" id="_bcConfirmIcon">
        <i id="_bcConfirmIconInner" style="width:28px;height:28px;stroke-width:2;pointer-events:none;"></i>
      </div>
      <h2 class="modal-confirm__title" id="_bcConfirmTitle"></h2>
      <p  class="modal-confirm__body"  id="_bcConfirmBody"></p>
      <div class="modal-confirm__footer">
        <button class="btn btn--outline" id="_bcConfirmCancel"></button>
        <button class="btn btn--full"    id="_bcConfirmOk"></button>
      </div>
    </div>`;

  /* Close on backdrop click */
  overlay.addEventListener('click', () => _resolve(false));
  document.body.appendChild(overlay);
}

let _resolve = () => {};

/*
  showConfirm(options) → Promise<boolean>
  options: {
    title    string  — heading text
    body     string  — description (HTML allowed)
    confirm  string  — confirm button label  (default: 'Confirm')
    cancel   string  — cancel button label   (default: 'Cancel')
    variant  string  — 'danger' | 'warning' | 'confirm'  (default: 'danger')
  }
*/
export function showConfirm({
  title   = 'Are you sure?',
  body    = '',
  confirm = 'Confirm',
  cancel  = 'Cancel',
  variant = 'danger',
} = {}) {
  _ensureModal();

  const v       = _ICONS[variant] ?? _ICONS.danger;
  const overlay = document.getElementById('_bcConfirmOverlay');
  const iconWrap = document.getElementById('_bcConfirmIcon');
  const iconEl   = document.getElementById('_bcConfirmIconInner');

  document.getElementById('_bcConfirmTitle').textContent  = title;
  document.getElementById('_bcConfirmBody').innerHTML     = body;
  document.getElementById('_bcConfirmOk').textContent     = confirm;
  document.getElementById('_bcConfirmCancel').textContent = cancel;

  /* Apply variant theme */
  iconWrap.style.background   = v.iconBg;
  iconWrap.style.borderColor  = v.iconBorder;
  iconEl.style.color          = v.iconColor;
  iconEl.setAttribute('data-lucide', v.icon);

  /* Re-apply btn color class */
  const okBtn = document.getElementById('_bcConfirmOk');
  okBtn.className = `btn btn--full ${v.btnClass}`;

  /* Re-render lucide icon */
  if (window.lucide) lucide.createIcons({ el: overlay });

  overlay.classList.add('is-open');

  return new Promise(res => {
    _resolve = (result) => {
      overlay.classList.remove('is-open');
      /* Clone buttons to wipe old listeners */
      const ok  = document.getElementById('_bcConfirmOk');
      const can = document.getElementById('_bcConfirmCancel');
      ok.replaceWith(ok.cloneNode(true));
      can.replaceWith(can.cloneNode(true));
      res(result);
    };

    document.getElementById('_bcConfirmOk').addEventListener('click',     () => _resolve(true),  { once: true });
    document.getElementById('_bcConfirmCancel').addEventListener('click',  () => _resolve(false), { once: true });
  });
}