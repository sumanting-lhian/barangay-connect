/* ================================================
   events-calendar.js — BarangayConnect
   Standalone injectable calendar widget.
   No Firebase deps — receives events array externally.
   Reusable outside Events tab.

   Public API:
     initEventsCalendar(events, containerId, sidebarListId, sidebarTitleId)
     updateEventsCalendar(events)

   Global handlers (inline onclick):
     window._evCalNav(dir)
     window._evCalSelectDay(dateStr)
================================================ */


// ================================================
// STATE
// ================================================

let _events   = [];
let _year     = new Date().getFullYear();
let _month    = new Date().getMonth();   // 0-indexed
let _selected = null;                    // 'YYYY-MM-DD'
let _cid      = 'eventsCalContainer';
let _sid      = 'eventsCalSidebarList';
let _stid     = 'eventsCalSidebarTitle';

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const CAT_COLORS = {
  health:     'var(--green-dark)',
  sports:     'var(--orange)',
  youth:      '#7c3aed',
  livelihood: '#2563eb',
  culture:    '#0f766e',
  seniors:    '#dc2626',
};


// ================================================
// PUBLIC API
// ================================================

export function initEventsCalendar(events, containerId, sidebarListId, sidebarTitleId) {
  _events   = events ?? [];
  _cid      = containerId   ?? 'eventsCalContainer';
  _sid      = sidebarListId ?? 'eventsCalSidebarList';
  _stid     = sidebarTitleId ?? 'eventsCalSidebarTitle';
  _year     = new Date().getFullYear();
  _month    = new Date().getMonth();
  _selected = null;
  _renderCalendar();
}

export function updateEventsCalendar(events) {
  _events = events ?? [];
  _renderCalendar();
  if (_selected) _renderSidebar(_selected);
}

/* Expose globally so events.js can call without importing */
window.initEventsCalendar   = initEventsCalendar;
window.updateEventsCalendar = updateEventsCalendar;


// ================================================
// RENDER — CALENDAR GRID
// ================================================

function _renderCalendar() {
  const container = document.getElementById(_cid);
  if (!container) return;

  const firstDay    = new Date(_year, _month, 1).getDay();
  const daysInMonth = new Date(_year, _month + 1, 0).getDate();
  const prevMonthDays = new Date(_year, _month, 0).getDate();
  const today       = _toDateStr(new Date());
  let cells = '';

  /* Prev-month padding — dimmed, non-interactive */
  for (let i = firstDay - 1; i >= 0; i--) {
    cells += `<button class="cal__day cal__day--other" disabled>${prevMonthDays - i}</button>`;
  }

  /* Current month */
  for (let d = 1; d <= daysInMonth; d++) {
    const ds  = `${_year}-${String(_month + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const evs = _eventsOnDate(ds);
    const cls = ['cal__day',
      evs.length   ? 'cal__day--has-event' : '',
      ds === today ? 'cal__day--today'     : '',
      ds === _selected ? 'cal__day--selected' : '',
    ].filter(Boolean).join(' ');

    cells += `<button class="${cls}" data-date="${ds}"
      onclick="window._evCalSelectDay('${ds}')"><span class="cal__day-num">${d}</span>${_buildDots(evs)}</button>`;
  }

  /* Next-month padding — fill remaining grid cells */
  const totalCells = firstDay + daysInMonth;
  const tail       = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let i = 1; i <= tail; i++) {
    cells += `<button class="cal__day cal__day--other" disabled>${i}</button>`;
  }

  const legend = _buildLegend();

  container.innerHTML = `
    <div class="cal events-cal">
      <div class="cal__header">
        <span class="cal__month">${MONTHS[_month]} ${_year}</span>
        <div class="cal__nav">
          <button class="cal__nav-btn" onclick="window._evCalNav(-1)" aria-label="Previous month">
            <i data-lucide="chevron-left"></i>
          </button>
          <button class="cal__nav-btn" onclick="window._evCalNav(1)" aria-label="Next month">
            <i data-lucide="chevron-right"></i>
          </button>
        </div>
      </div>
      <div class="cal__weekdays">${DAYS.map(d => `<span>${d}</span>`).join('')}</div>
      <div class="cal__grid">${cells}</div>
      ${legend ? `<div class="events-cal__legend">${legend}</div>` : ''}
    </div>`;

  if (typeof lucide !== 'undefined') lucide.createIcons({ el: container });
  _renderSidebar(_selected);
}


// ================================================
// DOTS + LEGEND
// ================================================

function _buildDots(evs) {
  if (!evs.length) return '';
  const seen = new Set();
  const dots = evs
    .filter(ev => { if (seen.has(ev.category)) return false; seen.add(ev.category); return true; })
    .slice(0, 3)
    .map(ev => `<span class="events-cal__dot" style="background:${CAT_COLORS[ev.category] ?? '#9ca3af'};"></span>`)
    .join('');
  return `<div class="events-cal__dots">${dots}</div>`;
}

function _buildLegend() {
  /* Only categories that appear in the currently displayed month */
  const seen = new Set();
  _events.forEach(ev => {
    if (!ev.dateStart) return;
    const d = new Date(ev.dateStart + 'T00:00:00');
    if (d.getFullYear() === _year && d.getMonth() === _month) seen.add(ev.category);
  });
  if (!seen.size) return '';
  return [...seen].map(cat => `
    <div class="events-cal__legend-item">
      <span class="events-cal__legend-dot" style="background:${CAT_COLORS[cat] ?? '#9ca3af'};"></span>
      ${cat.charAt(0).toUpperCase() + cat.slice(1)}
    </div>`).join('');
}


// ================================================
// SIDEBAR
// ================================================

function _renderSidebar(dateStr) {
  const titleEl = document.getElementById(_stid);
  const listEl  = document.getElementById(_sid);
  if (!listEl) return;

  if (!dateStr) {
    if (titleEl) titleEl.textContent = 'Select a date';
    listEl.innerHTML = `<p class="events-cal-sidebar-empty">Click a day to see events.</p>`;
    return;
  }

  const evs   = _eventsOnDate(dateStr);
  const label = new Date(dateStr + 'T00:00:00')
    .toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric' });

  if (titleEl) titleEl.textContent = label;

  if (!evs.length) {
    listEl.innerHTML = `<p class="events-cal-sidebar-empty">No events on this day.</p>`;
    return;
  }

  listEl.innerHTML = evs.map(ev => {
    const timeStr = ev.timeStart
      ? `${_fmt12(ev.timeStart)}${ev.timeEnd ? ` – ${_fmt12(ev.timeEnd)}` : ''}`
      : '';
    const accent  = CAT_COLORS[ev.category] ?? '#9ca3af';
    return `
      <div class="event-item">
        <div class="event-item__accent" style="background:${accent};"></div>
        <div class="event-item__body">
          <p class="event-item__title">${_esc(ev.title)}</p>
          ${timeStr
            ? `<p class="event-item__meta"><i data-lucide="clock" style="width:11px;height:11px;"></i> ${timeStr}</p>`
            : ''}
          ${ev.location
            ? `<p class="event-item__meta"><i data-lucide="map-pin" style="width:11px;height:11px;"></i> ${_esc(ev.location)}</p>`
            : ''}
        </div>
        <button class="btn btn--green btn--sm" style="flex-shrink:0;"
          onclick="window.openEventDetail('${_esc(ev.id)}')">
          View
        </button>
      </div>`;
  }).join('');

  if (typeof lucide !== 'undefined') lucide.createIcons({ el: listEl });
}


// ================================================
// NAVIGATION + SELECTION — global handlers
// ================================================

window._evCalNav = function(dir) {
  _month += dir;
  if (_month > 11) { _month = 0; _year++; }
  if (_month < 0)  { _month = 11; _year--; }
  _selected = null;
  _renderCalendar();
};

window._evCalSelectDay = function(dateStr) {
  _selected = dateStr;
  _renderCalendar();
};


// ================================================
// UTILITIES
// ================================================

/* Returns all events that fall on a given dateStr ('YYYY-MM-DD') */
function _eventsOnDate(dateStr) {
  return _events.filter(ev => {
    if (!ev.dateStart) return false;
    if (!ev.dateEnd || ev.dateEnd === ev.dateStart) return ev.dateStart === dateStr;
    return ev.dateStart <= dateStr && ev.dateEnd >= dateStr;
  });
}

function _toDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function _fmt12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}