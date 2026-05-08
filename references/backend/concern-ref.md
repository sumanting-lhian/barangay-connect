# Report a Concern

Open `services.html` in your browser and click the "Report a Concern" tab. Click through all four steps — the Next/Back/Continue buttons already work. You're not touching that. You're adding the cards section on top of it.

Two new files to create:

```
css/features/services/concerns.css
js/features/services/concerns.js
```

---

## Part 1 — Link Your Files

Create both files (blank for now), then open `services.html`.

**In `<head>`**, find:

```html
<link rel="stylesheet" href="../../css/features/services/services.css" />
```

Add your CSS link directly after it:

```html
<link rel="stylesheet" href="../../css/features/services/services.css" />
<link rel="stylesheet" href="../../css/features/services/concerns.css" />
```

Order matters — when two CSS rules conflict, the one that loads last wins. Shared styles go first, your styles go after so you can override them if needed.

**Find `</body>`** at the very bottom. Add your script tag right before it:

```html
  <script src="../../js/features/services/concerns.js"></script>
</body>
```

Don't add `type="module"` here even though some other scripts on the page have it. You'll later write a function called `resolveConcern()` that gets called directly from a button like `onclick="resolveConcern(3)"`. Module scripts are isolated from the page, so that direct call wouldn't reach them. Regular scripts don't have that restriction.

**Checkpoint:** Reload the page. It should look exactly the same as before — no red errors in DevTools (F12 → Console tab). (I think may error parin dito dun sa sounds but ignore that for now)

---

## Part 2 — Edit services.html

JavaScript finds elements on the page using their `id`. Without an id, `document.getElementById` has nothing to grab. These edits add ids to four elements your JS will need.

**The description textarea (Step 2)**

Find:
```html
<textarea class="form-input report-step__textarea" rows="7" ...></textarea>
```

Add `id="concernDescription"`:
```html
<textarea id="concernDescription" class="form-input report-step__textarea" rows="7" ...></textarea>
```

**The submit button (Step 4)**

Find:
```html
<button class="btn btn--orange">
  Submit Concern <i data-lucide="upload"></i>
</button>
```

Add `id="concernSubmitBtn"`:
```html
<button class="btn btn--orange" id="concernSubmitBtn">
  Submit Concern <i data-lucide="upload"></i>
</button>
```

**The review table values (Step 4)**

The review table has hardcoded placeholder text right now. Find the three `.review-table__value` spans and replace them with these:

```html
<span class="review-table__value" id="reviewCategory">—</span>
<span class="review-table__value" id="reviewDescription">—</span>
<span class="review-table__value" id="reviewPhotos">No photos attached</span>
```

The `—` is just a placeholder. Your JS will overwrite it with what the user actually typed.

**The Continue button on Step 3**

Find the Continue button going from step 3 to step 4. Change it so it calls `populateReview()` before switching steps:

```html
<button class="btn btn--orange" onclick="populateReview(); goToStep(4);">
  Continue <i data-lucide="chevron-right"></i>
</button>
```

`populateReview()` is a function you'll write later. It reads what the user selected and typed and puts it into the review table so step 4 shows real data instead of dashes.

**Checkpoint:** Click through all four steps again. Nothing should be broken.

---

## Part 3 — The Cards Container

Inside `services-panel-inner`, scroll to the bottom. Right before the red bullying notice banner, add:

```html
<div class="concerns-list-section">
  <h2 class="concerns-list__title">Submitted Concerns</h2>
  <div id="concernsGrid" class="concerns-grid">
    <!-- cards appear here -->
  </div>
</div>
```

**Checkpoint:** Save and reload. You should see a "Submitted Concerns" heading below the form. The area under it is empty — that's correct. JS will inject cards into `concernsGrid` when the form is submitted.

---

## Part 4 — CSS

Open `concerns.css` and paste this in. The stepper and form step styles are already handled in `services.css` — you're only writing styles for the cards section.

```css
/* ── List section ───────────────────────────────── */

/* Spacing above the whole section and the heading style */
.concerns-list-section {
  margin-top: var(--space-xl);
}

.concerns-list__title {
  font-family: var(--font-display);
  font-weight: var(--fw-bold);
  font-size: var(--text-lg);
  color: var(--text-dark);
  margin-bottom: var(--space-md);
}

/* Stacks cards vertically.
   flex-direction: column is what causes the stacking —
   without it, flex defaults to horizontal (side by side). */
.concerns-grid {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}


/* ── Card ───────────────────────────────────────── */

/* The white box. border-left is the colored stripe on the left.
   It starts gray — the two modifier classes below override it. */
.concern-card {
  background: var(--white);
  border-radius: var(--radius-lg);
  border: 1px solid var(--gray-100);
  border-left: 4px solid var(--gray-300);
  padding: var(--space-lg);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  transition: box-shadow 0.2s;
}

.concern-card:hover {
  box-shadow: var(--shadow-md);
}

/* These override the gray border-left color above */
.concern-card--pending  { border-left-color: var(--amber-500); }
.concern-card--resolved { border-left-color: var(--green-dark); opacity: 0.85; }

/* The small gray row holding category, date, and badge.
   flex-wrap: wrap lets it break to a second line on small screens. */
.concern-card__meta {
  font-size: var(--text-sm);
  color: var(--gray-400);
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
}

.concern-card__desc {
  font-size: var(--text-base-sm);
  color: var(--gray-600);
  line-height: 1.6;
}

.concern-card__photo {
  width: 100%;
  max-height: 200px;
  object-fit: cover;
  border-radius: var(--radius-md);
  display: block;
}


/* ── Status badge ───────────────────────────────── */

/* The small pill that says PENDING or RESOLVED.
   text-transform and letter-spacing make it look
   like a badge instead of regular text. */
.concern-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  font-weight: var(--fw-bold);
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.concern-status-badge--pending {
  background: var(--alpha-amber-12);
  color: var(--amber-900);
}

.concern-status-badge--resolved {
  background: var(--alpha-green-10);
  color: var(--green-dark);
}

.concern-resolve-btn {
  align-self: flex-start;
  margin-top: var(--space-xs);
}


/* ── Empty state ────────────────────────────────── */

/* Shown when no concerns have been submitted yet */
.concerns-empty {
  padding: 3rem;
  text-align: center;
  color: var(--gray-400);
}

.concerns-empty__icon {
  display: flex;
  justify-content: center;
  margin-bottom: var(--space-md);
  opacity: 0.4;
}

.concerns-empty__text {
  font-size: var(--text-sm);
  font-family: var(--font-display);
}
```

The `var(--something)` values are CSS variables already defined in `main.css`. They just work — you don't need to define them.

**What a submitted card looks like:**

```
┌────────────────────────────────────────────────────┐
▌ (amber stripe)                                      │
▌  Garbage · May 3, 2026 · 2:45 PM · [PENDING]       │
▌                                                     │
▌  Overflowing bin near the market.                   │
▌                                                     │
▌  [Mark as Resolved]                                 │
└────────────────────────────────────────────────────┘

After clicking Mark as Resolved:

┌────────────────────────────────────────────────────┐
▌ (green stripe, slightly faded)                      │
▌  Garbage · May 3, 2026 · 2:45 PM · [RESOLVED]      │
▌                                                     │
▌  Overflowing bin near the market.                   │
│                                                     │
│  (button is gone)                                   │
└────────────────────────────────────────────────────┘
```

---

## Part 5 — JavaScript Concepts First

Try these in the browser console (F12 → Console tab) before writing the file. Nothing here is saved.

### Objects

An **object** is a container of named values:

```js
let concern = {
  category: "Garbage",
  description: "Overflowing bin near the market",
  status: "pending"
};
```

Read a value out of it with a dot:

```js
concern.category   // "Garbage"
concern.status     // "pending"
```

### Arrays

An **array** is a list. It can hold objects:

```js
let list = [];
list.push(concern);
console.log(list);
```

`push` adds an item to the end. Expand the result in the console — you'll see the concern object sitting inside the array.

### Writing to the page

Try this while the page is open:

```js
document.getElementById('concernsGrid').innerHTML = '<p style="color:red; padding:1rem;">it works</p>';
```

Red text appears in the concerns section. Refresh — it's gone, because it was only in memory. Your JS does the same thing, but driven by the actual array.

### map() and join()

```js
let names = ['Juan', 'Maria', 'Ben'];
let wrapped = names.map(name => '<p>' + name + '</p>');
console.log(wrapped);          // array of three strings
console.log(wrapped.join('')); // one string
```

`.map()` runs a function on every item and returns a new array. `.join('')` glues it into one string. That string goes into `.innerHTML`. The whole pipeline:

```
array of concerns → .map() turns each into card HTML → .join('') stitches them → .innerHTML puts them on the page
```

### Template literals

Backtick strings let you embed variables with `${}` and break across multiple lines:

```js
let category = 'Garbage';
let date = 'May 3';

let result = `<p>${category} — ${date}</p>`;
// result: <p>Garbage — May 3</p>
```

### Ternaries

Shorthand for if/else: `condition ? valueIfTrue : valueIfFalse`

```js
let status = 'pending';
let label = status === 'resolved' ? 'Resolved' : 'Pending';
// label: "Pending"
```

Change `status` to `'resolved'` and run it again — label becomes `"Resolved"`. You'll use ternaries constantly in the card builder.

---

## Part 6 — Writing concerns.js

Go through each section in order.

### 6.1 — sanitize (goes at the very top)

What happens if someone types this into the description field:

```
<img src="x" onerror="alert('hacked')" />
```

Try it — paste that into step 2, submit. The browser treats anything inside `.innerHTML` as real HTML, so it renders the tag and fires `onerror`. That's a real security problem.

The fix — add this at the very top of `concerns.js`, before everything else:

```js
// ── UTILS ─────────────────────────────────────────

function sanitize(str) {
  const el = document.createElement('div');
  el.textContent = String(str ?? '');
  return el.innerHTML;
}
```

What each line does:
- `createElement('div')` makes a hidden element in memory (not on the page)
- Setting `.textContent` stores the string as plain text, so `<` and `>` get stored as literal characters instead of HTML
- Reading `.innerHTML` back out gives the escaped version — `<b>` becomes `&lt;b&gt;`, which shows as visible text instead of a real tag
- `?? ''` means: if `str` is null or undefined, use an empty string instead of crashing

### 6.2 — Data

```js
// ── DATA ──────────────────────────────────────────
let concerns = [];
let nextId = 1;
```

`nextId` is a counter. Every new concern gets a unique number — 1, 2, 3 — so you can find a specific one later. When you connect this to a database, the database handles this automatically. This is the local version.

### 6.3 — addConcern

```js
// ── CORE ──────────────────────────────────────────

function addConcern(category, description, photoUrl) {

  const newConcern = {
    id: nextId,
    category: category,
    description: description,
    photoUrl: photoUrl,
    status: 'pending',
    submittedAt: new Date()
  };

  concerns.push(newConcern);
  nextId++;
}
```

`new Date()` captures the exact time this runs. You'll use it to show a readable date on the card.

`nextId++` is shorthand for `nextId = nextId + 1`.

### 6.4 — renderConcerns

```js
// ── RENDER ────────────────────────────────────────

function renderConcerns() {
  const grid = document.getElementById('concernsGrid');

  if (concerns.length === 0) {
    grid.innerHTML = `
      <div class="concerns-empty">
        <div class="concerns-empty__icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 11l3 3L22 4"/>
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
          </svg>
        </div>
        <p class="concerns-empty__text">No concerns submitted yet.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = concerns.map(concern => buildConcernCard(concern)).join('');
}
```

If the array is empty, it shows the empty state and exits early with `return` so the rest of the function doesn't run. If there are concerns, the last line builds a card for each one, joins them into one string, and puts them in the grid.

### 6.5 — buildConcernCard

This takes one concern object and returns the HTML string for its card. Try filling in the `???` blanks yourself before reading the answers — each one is a ternary:

```js
function buildConcernCard(concern) {

  const dateString = concern.submittedAt.toLocaleDateString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric'
  });

  const timeString = concern.submittedAt.toLocaleTimeString('en-PH', {
    hour: '2-digit', minute: '2-digit'
  });

  // pending → 'concern-card concern-card--pending'
  // resolved → 'concern-card concern-card--resolved'
  const cardClass = ???;

  // pending → 'concern-status-badge concern-status-badge--pending'
  // resolved → 'concern-status-badge concern-status-badge--resolved'
  const badgeClass = ???;

  // The text inside the badge
  const badgeLabel = ???;

  // If concern.photoUrl exists: an <img> tag with class concern-card__photo
  // If null: empty string
  const photoSection = ???;

  // If pending: a <button> calling resolveConcern(concern.id) onclick,
  //   classes: btn btn--outline btn--sm concern-resolve-btn
  // If resolved: empty string
  const resolveButton = ???;

  return `
    <div class="${cardClass}">
      <div class="concern-card__meta">
        <span>${sanitize(concern.category)}</span>
        <span>·</span>
        <span>${dateString} · ${timeString}</span>
        <span>·</span>
        <span class="${badgeClass}">${badgeLabel}</span>
      </div>
      <p class="concern-card__desc">${sanitize(concern.description)}</p>
      ${photoSection}
      ${resolveButton}
    </div>
  `;
}
```

**Answers:**

```js
const cardClass = concern.status === 'resolved'
  ? 'concern-card concern-card--resolved'
  : 'concern-card concern-card--pending';

const badgeClass = concern.status === 'resolved'
  ? 'concern-status-badge concern-status-badge--resolved'
  : 'concern-status-badge concern-status-badge--pending';

const badgeLabel = concern.status === 'resolved' ? 'Resolved' : 'Pending';

const photoSection = concern.photoUrl
  ? `<img src="${concern.photoUrl}" alt="Concern photo" class="concern-card__photo" />`
  : '';

const resolveButton = concern.status === 'pending'
  ? `<button class="btn btn--outline btn--sm concern-resolve-btn"
       onclick="resolveConcern(${concern.id})">
       Mark as Resolved
     </button>`
  : '';
```

### 6.6 — resolveConcern

When "Mark as Resolved" is clicked, find the right concern in the array, flip its status, and redraw.

Try this in the console first:

```js
let arr = [
  { id: 1, name: 'Juan' },
  { id: 2, name: 'Maria' },
  { id: 3, name: 'Ben' }
];

let found = arr.find(item => item.id === 2);
console.log(found);
```

`.find()` goes through the array and returns the first item where the condition is true. It gives you the actual object from inside the array — not a copy. So changing a property on `found` changes the real thing in `arr`.

Try writing `resolveConcern` yourself before reading the answer. Steps: find the concern by id, return early if not found, set status to `'resolved'`, call `renderConcerns()`.

**Answer:**

```js
function resolveConcern(id) {
  const concern = concerns.find(c => c.id === id);
  if (!concern) return;

  concern.status = 'resolved';
  renderConcerns();
}
```

### 6.7 — populateReview

Runs when the user clicks Continue from step 3. Reads what they selected and typed, then updates the review table before step 4 loads.

`document.querySelector` is like `getElementById` but takes any CSS selector. To find whichever category button is currently selected:

```js
document.querySelector('.concern-grid .btn--selector.is-selected')
```

That reads: inside `.concern-grid`, find a `.btn--selector` that also has the class `is-selected`. The clicked button already gets that class — you're just reading which one it is.

Try writing it yourself. Steps: find the selected category button (fall back to `'—'` if none), read description from `#concernDescription` with `.value.trim()`, check photo count from `#photoInput` with `.files.length`, set `.textContent` on the three review spans.

Use `.textContent =` to set the spans, not `.innerHTML` — these are plain text labels.

**Answer:**

```js
// ── REVIEW ────────────────────────────────────────

function populateReview() {
  const selectedBtn = document.querySelector('.concern-grid .btn--selector.is-selected');
  const category    = selectedBtn ? selectedBtn.textContent.trim() : '—';
  const description = document.getElementById('concernDescription').value.trim();
  const photoInput  = document.getElementById('photoInput');
  const photoCount  = photoInput.files.length;

  document.getElementById('reviewCategory').textContent    = category;
  document.getElementById('reviewDescription').textContent = description || '—';
  document.getElementById('reviewPhotos').textContent      =
    photoCount > 0 ? photoCount + ' photo(s) attached' : 'No photos attached';
}
```

`description || '—'`: if description is an empty string (falsy), use `'—'` instead.

### 6.8 — setupForm

Wires up the character counter and the submit button.

```js
// ── SETUP ─────────────────────────────────────────

function setupForm() {
  const submitBtn = document.getElementById('concernSubmitBtn');
  const descInput = document.getElementById('concernDescription');
  const charCount = descInput.closest('.form-group').querySelector('.char-count');

  descInput.addEventListener('input', function() {
    charCount.textContent = this.value.length + '/500 characters';
  });

  submitBtn.addEventListener('click', function() {
    const selectedBtn = document.querySelector('.concern-grid .btn--selector.is-selected');
    const category    = selectedBtn ? selectedBtn.textContent.trim() : '';
    const description = descInput.value.trim();
    const photoInput  = document.getElementById('photoInput');

    if (!category) {
      alert('Please select a category in step 1.');
      return;
    }
    if (!description) {
      alert('Please describe the concern in step 2.');
      return;
    }

    let photoUrl = null;
    if (photoInput.files.length > 0) {
      photoUrl = URL.createObjectURL(photoInput.files[0]);
    }

    addConcern(category, description, photoUrl);
    renderConcerns();

    descInput.value       = '';
    photoInput.value      = '';
    charCount.textContent = '0/500 characters';
    document.querySelectorAll('.concern-grid .btn--selector')
            .forEach(b => b.classList.remove('is-selected'));
    goToStep(1);
  });
}
```

A few things to notice:

- `addEventListener('input', ...)` fires every time the textarea value changes
- `.closest('.form-group')` walks up the DOM from `descInput` until it finds a parent matching that selector, then `.querySelector('.char-count')` searches inside it — gets you the counter without needing another ID
- `querySelectorAll` (with All) returns every matching element. `.forEach` runs a function on each — here it removes `is-selected` from every category button so the selection clears
- `return` inside the validation checks exits early so `addConcern` only runs if both fields pass
- `URL.createObjectURL` makes a temporary local URL so the photo can display. Gets replaced with a real Firebase Storage upload later

### 6.9 — Start everything on page load

At the very bottom of `concerns.js`:

```js
document.addEventListener('DOMContentLoaded', function() {
  setupForm();
  renderConcerns();
});
```

`DOMContentLoaded` fires after all the HTML is fully parsed and every element exists on the page. Without this, the script runs before the form elements exist and `getElementById` returns `null` — which crashes on the next line when you try to call `.addEventListener` on nothing.

---

## Part 7 — Test It

Go through this in order:

1. Load the page. The concerns section shows the empty state SVG and "No concerns submitted yet."
2. Click Submit without filling anything in. Alert about the category.
3. Select a category, write a description, Continue to step 4. The review table shows what you actually typed — not dashes.
4. Click Submit. A card with an amber left stripe appears below.
5. Submit a second one. Two cards stacked.
6. Click "Mark as Resolved." Stripe turns green, badge changes, button disappears.
7. Attach a photo before submitting. Image appears on the card.
8. After submitting, form resets to step 1 with all fields cleared.

F12 → Console if something goes wrong. The error tells you which file and line.

---

## Checklist

- [ ] `concerns.css` linked in `<head>` after `services.css`
- [ ] `concerns.js` linked before `</body>`, no `type="module"`
- [ ] `id="concernDescription"` on the Step 2 textarea
- [ ] `id="concernSubmitBtn"` on the Step 4 submit button
- [ ] Review spans have `id="reviewCategory"`, `id="reviewDescription"`, `id="reviewPhotos"`
- [ ] Step 3 Continue button calls `populateReview()` before `goToStep(4)`
- [ ] Cards container with `id="concernsGrid"` in the HTML before the bullying banner
- [ ] `sanitize()` at the top of `concerns.js`, wrapping category + description in the card builder
- [ ] Submitting with no category shows alert and stops
- [ ] Submitting with no description shows alert and stops
- [ ] Review table shows actual user input
- [ ] Submitting creates a card below the form
- [ ] "Mark as Resolved" changes the card and removes the button
- [ ] Photo shows on the card if attached
- [ ] Form resets to step 1 after submission
- [ ] No red errors in F12 → Console

---

## What gets added later

- `addConcern` connected to Firestore so submissions save to the database
- `URL.createObjectURL()` replaced with real Firebase Storage uploads
- `renderConcerns` pulling live from the database instead of the local array
- Auth so each concern is tied to who submitted it
- Resolve button updating the actual database record

---

| File | What it does |
|---|---|
| `services.html` | Existing page — you add IDs and the cards container |
| `concerns.css` | Card and list styles only |
| `concerns.js` | Everything: data, rendering, form logic |
