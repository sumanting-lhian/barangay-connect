# Project Structure

This project is organized by feature and responsibility to keep navigation clear and scaling predictable.

## Directory Layout

```text
/
|- admin.html
|- index.html
|- register.html
|- firebase.json
|- assets/
|- css/
|  |- shared/
|  |  |- main.css
|  |  |- buttons.css
|  |  |- components.css
|  |  \- frames.css
|  \- features/
|     |- auth/
|     |  \- auth.css
|     |- community/
|     |  \- community.css
|     |- home/
|     |  \- home.css
|     |- profile/
|     |  |- id-card.css
|     |  \- profile.css
|     \- services/
|        \- services.css
|- js/
|  |- core/
|  |  |- firebase-config.js
|  |  |- db-paths.js
|  |  \- storage.js
|  |- shared/
|  |  |- comments.js
|  |  |- image-viewer.js
|  |  |- lastSeen.js
|  |  |- location.js
|  |  |- nav-auth.js
|  |  |- notifications.js
|  |  |- stat-counter.js
|  |  \- weather.js
|  \- features/
|     |- admin/
|     |  |- admin.js
|     |  |- alerts-admin.js
|     |  |- bulletin-admin.js
|     |  |- comment-manager-admin.js
|     |  |- community-posts-admin.js
|     |  |- curfew-admin.js
|     |  |- reported-comments-admin.js
|     |  |- reported-posts-admin.js
|     |  |- roles-admin.js
|     |  \- settings-admin.js
|     |- auth/
|     |  |- auth.js
|     |  \- register.js
|     |- community/
|     |  |- bulletin.js
|     |  |- community-animations.js
|     |  \- community-posts.js
|     |- home/
|     |  \- home-animations.js
|     \- profile/
|        |- alerts.js
|        \- profile.js
|- pages/
|  |- features/
|  |  |- community.html
|  |  |- home.html
|  |  |- profile.html
|  |  \- services.html
|- ui-library/
|  |- button-library.html
|  |- components-library.html
|  |- frames-library.html
|  \- main-library.html
|- public/
\- functions/
```

## JS Module Responsibilities

- `js/core`: shared infrastructure used across all features.
  - Firebase app/auth/db/storage bootstrap.
  - DB path builders and storage helpers.
- `js/shared`: reusable cross-feature client behavior.
  - Navigation auth wiring, notifications, image viewing, comments, etc.
- `js/features/*`: feature-specific modules only.
  - Admin, auth, community, home, profile.

## Naming Rules

- Keep explicit, context-rich names.
- Admin scripts must remain `*-admin.js`.
- Feature-specific files should keep feature prefixes where applicable:
  - `home-*`, `community-*`, `profile-*`, etc.
- Avoid ambiguous/generic names such as:
  - `script.js`
  - `animations.js`
  - `main.js` (unless truly global)

## Path Conventions

- HTML pages under `pages/features/` should reference shared assets with `../../`.
- JS imports follow module placement:
  - Feature module → core/shared uses `../../core/...` or `../../shared/...`
  - Shared module → core/shared uses `../core/...` or `./...`
  - Core module → core uses `./...`

## Expansion Guidelines

- Add new domain logic under `js/features/<feature>/`.
- Add reusable logic only when used by multiple features, then place in `js/shared/`.
- Keep Firebase primitives centralized in `js/core/`.
- Add feature styles in `css/features/<feature>/`, not in shared styles, unless reused globally.

---

## JS Module Commenting Conventions

All JS modules follow a consistent commenting structure. The goal is that any developer can open a file cold and immediately understand what it does, what it depends on, and how its pieces fit together — without reading the implementation.

### 1. File Header Block

Every module opens with a top-level block comment that covers:

```js
/* ================================================
   filename.js — ProjectName
   One-line description of what this module does and where it is attached.

   WHAT IS IN HERE:
     · Bullet list of responsibilities this file owns

   WHAT IS NOT IN HERE:
     · Explicit callouts for related concerns intentionally excluded,
       with a pointer to where those live instead

   REQUIRED IMPORTS:
     · List each non-obvious dependency with its source path and
       the specific exports consumed

   QUICK REFERENCE:
     FunctionName    → one-line plain-English description
     anotherFn(arg)  → what it does and when it runs
================================================ */
```

The `WHAT IS NOT IN HERE` section is particularly important — it prevents scope creep and doubles as cross-file navigation for future contributors.

### 2. Section Dividers

Logical sections within a file are separated by a named banner:

```js
// ================================================
// SECTION NAME — Optional subtitle
// ================================================
```

Standard section names used across modules:

| Section | Purpose |
|---|---|
| `IMPORTS` | All import statements grouped together |
| `CONSTANTS — <topic>` | Related constant groups, named by concern |
| `MODULE STATE` | Mutable top-level variables (listeners, timers, cache) |
| `<FEATURE NAME>` | A named subsystem (e.g. `USGS EARTHQUAKE POLLING`) |
| `UTILITIES` | Pure helper functions with no side effects |
| `BOOTSTRAP` | The entry point — auth state listener or top-level init |
| `DEV HELPER — <label>` | Console/debug utilities, clearly separated from production code |

### 3. Function-Level Comments

Functions with non-obvious behavior get a prose block comment directly above them. The comment explains *why* the function exists and any important behavioral nuances — not a re-statement of what the code already says.

```js
/*
   Opens a real-time onSnapshot listener scoped to the user's barangay.
   Instantly reflects admin create / edit / deactivate actions across all
   open tabs. Re-subscribing replaces the previous listener.
*/
function listenAlerts(barangay) { ... }
```

Simple getters, setters, and one-liners do not need function comments. The section banner and variable names provide sufficient context.

### 4. Inline Comments

Used for two purposes only:

**Clarifying non-obvious values or decisions:**
```js
const USGS_POLL_MS  = 5 * 60 * 1000;      // re-poll every 5 minutes
const USGS_LOOKBACK = 6 * 60 * 60 * 1000; // ignore quakes older than 6 hours
```

**Marking intentional omissions or future extension points:**
```js
audio.play().catch(() => {}); // Browsers block autoplay until user interaction — fail silently

/*
   Optional extension: OpenWeatherMap weather alerts via the One Call API.
   Add 'alerts' to the exclude param, parse res.alerts[], and call renderBanner.
   Requires a free API key from openweathermap.org.
*/
```

Avoid comments that just restate the code (`// loop through items`, `// return result`).

### 5. Dev/Debug Code

Any function intended only for development or console use is placed in a clearly marked `DEV HELPER` section at the bottom of the file, before `BOOTSTRAP`. It must include a usage example:

```js
// ================================================
// DEV HELPER — Test Alert (Admin Console Only)
// ================================================

/*
   Writes a temporary test alert to Firestore for the given barangay.
   Usage from the browser console: createTestAlert()
*/
window.createTestAlert = async function (barangayName = 'Bancod') { ... };
```

### 6. Bootstrap Section

The `BOOTSTRAP` section is always last. It contains the module's top-level entry point (typically an `onAuthStateChanged` or `DOMContentLoaded` listener) and a short comment explaining what starts unconditionally vs. what requires authentication:

```js
// ================================================
// BOOTSTRAP
// ================================================

/*
   USGS polling starts unconditionally — no login required.
   Firestore listeners are scoped to the authenticated user's barangay,
   resolved from their userIndex document.
*/
onAuthStateChanged(auth, async (user) => { ... });
```

### Summary

| Element | Rule |
|---|---|
| File header | Required on every module |
| `WHAT IS NOT IN HERE` | Required — prevents scope creep, aids navigation |
| Section dividers | Required for every logical group |
| Function comments | Required for non-trivial functions; omit for simple helpers |
| Inline comments | Clarify non-obvious values and intentional omissions only |
| Dev helpers | Always in their own section, always with usage example |
| Bootstrap | Always last section in the file |

---

## CSS File Commenting Conventions

All CSS files follow a consistent structure that mirrors the JS conventions. The goal is the same: any developer opening a stylesheet cold should immediately understand its scope, dependencies, and how its sections map to the DOM.

### 1. File Header Block

Every stylesheet opens with a top-level block comment:

```css
/* ================================================================
   filename.css — ProjectName
   One-line description of what this stylesheet covers and which
   page or component it belongs to.

   WHAT IS IN HERE:
     · Bullet list of every visual concern this file owns

   WHAT IS NOT IN HERE:
     · Explicit callouts for styles intentionally excluded,
       with a pointer to where those live instead

   REQUIRED IMPORTS:
     CSS files that must be loaded before this one, in order.
     Include the <link> tags so they can be copy-pasted directly.

   QUICK REFERENCE:
     .ClassName        → one-line description of the element
     .AnotherClass     → what it styles and when it applies
================================================================ */
```

The `WHAT IS NOT IN HERE` section is essential for shared-vs-feature boundary clarity. It stops contributors from adding base component styles into a feature file, or page-specific overrides into a shared file.

### 2. Section Dividers

Logical groups of rules are separated by a named banner. The double-line style matches the JS section dividers so the visual rhythm is the same across both file types:

```css
/* ================================================================
   SECTION NAME
   Optional one-line description of what this section covers.
================================================================ */
```

Standard section names used across stylesheets:

| Section | Purpose |
|---|---|
| `GLOBAL RESETS — <scope>` | Page-scoped resets that should not live in main.css |
| `SHARED SECTION HELPERS` | Eyebrow labels, headings, or layout helpers reused across sections on the same page |
| `<COMPONENT NAME>` | Named block of styles for one element (e.g. `HERO`, `NAVBAR TRANSPARENT`) |
| `<COMPONENT> — <sub-concern>` | Sub-section inside a larger block (e.g. `HERO — Right Column`) |
| `<COMPONENT NAME> OVERRIDES` | Adjustments to a shared component scoped to this page only |
| `Z-INDEX OVERRIDES` | Stacking context fixes collected in one place |
| `RESPONSIVE` | All `@media` queries, always at the bottom of the file |

Sub-sections within a large block use a lighter single-line divider with a leading `──` to visually indicate nesting:

```css
/* ── Sub-section label ───────────────────────────────────────── */
```

### 3. Section-Level Comments

Each section banner is followed by a short prose comment when the intent is not self-evident from the name alone. Common cases include explaining why an override exists, documenting third-party animation ownership, or calling out rendering quirks:

```css
/* ================================================================
   NAVBAR TRANSPARENT — home page override
   Applied while the hero is in view; JS removes it on scroll.
================================================================ */

/* ================================================================
   HERO
   Full-bleed sticky section on load. GSAP morphs the
   border-radius to 0 0 64px 64px as the user scrolls down.
================================================================ */
```

Short, self-explanatory sections (like `RESPONSIVE` or `GLOBAL RESETS`) do not need a prose description.

### 4. Inline Comments

Used for three purposes only:

**Documenting third-party ownership of a property** — whenever GSAP, JS, or another system controls a CSS property at runtime, call that out so no one tries to "fix" the value in CSS:

```css
.hero__left {
  animation: none !important; /* GSAP owns entrance transforms — CSS animation is disabled */
}

.hero__content {
  border-radius: 0; /* GSAP animates this on scroll */
}

.section-updates .post-row--accented:hover {
  transform: none; /* GSAP owns the transform */
}
```

**Explaining non-obvious values:**
```css
.hero__scroll-line {
  width: 1.5px;      /* intentionally sub-pixel for a hairline feel */
  height: 52px;
}
```

**Marking optional extension points:**
```css
/* Remove .navbar__logo-img rule if the logo is already colored. */
.navbar:not(.navbar--transparent) .navbar__logo-img {
  filter: brightness(0) saturate(100%) invert(21%) ...;
}
```

Avoid comments that just restate the selector (`/* hero heading */`, `/* button styles */`).

### 5. Responsive Section

All `@media` queries live in a single `RESPONSIVE` section at the very bottom of the file. They are never scattered inline next to the rules they modify. Breakpoints are ordered from widest to narrowest:

```css
/* ================================================================
   RESPONSIVE
================================================================ */

@media (max-width: 1024px) { ... }
@media (max-width: 900px)  { ... }
@media (max-width: 768px)  { ... }
@media (max-width: 640px)  { ... }
@media (max-width: 480px)  { ... }
```

### Summary

| Element | Rule |
|---|---|
| File header | Required on every stylesheet |
| `WHAT IS NOT IN HERE` | Required — enforces the shared/feature boundary |
| Section dividers | Required for every logical group of rules |
| Sub-section dividers | Use the `── label ───` style for nested concerns |
| Section prose comments | Required when intent is not obvious from the name |
| Inline comments | GSAP/JS ownership, non-obvious values, extension points only |
| Responsive | Always a single section at the bottom, widest breakpoint first |

---

## HTML File Commenting Conventions

HTML files use a consistent comment structure to make large templates navigable without an IDE outline. Every major block of markup is labelled and scoped so a developer can scan the file like a table of contents.

### 1. File Header Block

Every HTML file opens with a block comment inside `<html>` and before `<head>`. This is the same four-field pattern used in JS and CSS:

```html
<!--
  ================================================
  filename.html — ProjectName
  One-line description of the page and its audience.

  WHAT IS IN HERE:
    · Bullet list of every major section and modal this file owns

  WHAT IS NOT IN HERE:
    · Explicit callouts for concerns handled elsewhere,
      with a pointer to the responsible file

  REQUIRED IMPORTS:
    · CSS files (in load order)
    · JS modules and CDN scripts

  QUICK REFERENCE:
    · Key IDs and their purpose
      e.g. Tab panels: #tab-bulletin, #tab-polls
      e.g. Modals:     #petReportModal, #signoutModal
================================================
-->
```

### 2. Major Section Dividers

Every top-level structural block — navbar, hero, main content, each modal, the footer, and the script blocks — is wrapped in a double-line banner comment. The visual weight matches the CSS section dividers:

```html
<!-- ═══════════════════════════════════════════════════════════════
     SECTION LABEL
     ─────────────────────────────────────────────────────────────
     Optional one-line or two-line description of what this block
     contains and any non-obvious behavior to be aware of.
══════════════════════════════════════════════════════════════════ -->
```

Every major section also gets a closing label comment so the boundary is visible when the block is collapsed or when scrolling past the closing tag:

```html
</nav><!-- /navbar -->
</main><!-- /community-main -->
</section><!-- /tab-panel--bulletin -->
```

### 3. Sub-section Dividers

Panels, columns, or nested groups within a major section use a lighter single-line divider — the same `──` style used in CSS:

```html
<!-- ─────────────────────────────────────────────────────────────
     SUB-SECTION LABEL
     ─────────────────────────────────────────────────────────────
     Description of what this sub-block contains and which CSS
     class or JS behavior drives it.
──────────────────────────────────────────────────────────────── -->
```

### 4. Section-Level Prose Comments

Each major section banner is followed by a prose comment when it documents CSS class origins, JS behavior, or non-obvious rendering decisions. This is the primary mechanism for cross-referencing the HTML with its corresponding CSS and JS files:

```html
<!-- ═══════════════════════════════════════════════════════════════
     MODAL — Pet Report
     ───────────────────────────────────────────────────────────────
     .modal-overlay > .modal from frames.css.
     Header:      .modal__header .modal__header--green
     Report type: .report-type-toggle + .report-type-toggle__btn--*
     Close:       .btn .btn--close .btn--sm .modal__close from buttons.css.
══════════════════════════════════════════════════════════════════ -->
```

Sub-section prose comments follow the same pattern but document the specific component classes, state modifiers, and the stylesheet each one comes from:

```html
<!-- ─────────────────────────────────────────────────────────────
     TAB PANEL: BULLETIN
     ─────────────────────────────────────────────────────────────
     Filter pills:  .btn--filter from buttons.css.
     Posts:         .post-row / .post-row--accented from frames.css.
     Reactions:     .reaction-bar / .reaction-count from components.css.
     FAB:           .btn .btn--fab from buttons.css.
──────────────────────────────────────────────────────────────── -->
```

### 5. Inline Comments

Used for three purposes only:

**Explaining non-obvious class modifiers or state rules:**
```html
<!--
  ROLE CLASS on <body> controls which navbar items are visible.
  JS sets this after auth.
  Values: role-resident | role-officer | role-admin
  Default for this page: role-guest
-->
<body class="role-guest" data-role-init="pending">
```

**Documenting conditional or JS-controlled visibility:**
```html
<!-- Bell — remove .navbar__bell-dot when no notifications -->
<button class="navbar__bell" aria-label="Notifications" id="bellBtn">

<!-- Avatar — replace icon with <img> when user has a photo -->
<button class="navbar__avatar" aria-label="Open profile" id="avatarBtn">
```

**Calling out CSS import order constraints:**
```html
<!--
  CSS IMPORT ORDER — DO NOT CHANGE
  main.css        → tokens, reset, navbar, footer, form inputs
  buttons.css     → .btn and all clickable variants
  components.css  → badges, tags, banners, stat components
  frames.css      → post cards, modals, cal, pet cards, drawers
  community.css   → THIS PAGE ONLY — hero layout, tab panels, gallery grid
-->
```

Avoid comments that restate the tag name or class (`<!-- nav -->`, `<!-- button -->`).

### 6. Script Block Comments

Inline `<script>` blocks and `<script type="module">` blocks get a section banner and a numbered list of everything the block handles, so the scope is clear without reading the code:

```html
<!-- ═══════════════════════════════════════════════════════════════
     SCRIPTS
     ───────────────────────────────────────────────────────────────
     1. Lucide icon render
     2. Toast keyframe injection
     3. Tab switching — shows matching panel, updates aria + active states
     4. Navbar scroll transparency
     5. Modal open/close helpers
     6. Generic filter pill toggle
     7. Report type toggle in pet modal
     8. Bullying modal helpers
══════════════════════════════════════════════════════════════════ -->
```

Module script blocks use the same banner with a description of the imports they pull in and the behaviors they own:

```html
<!-- ═══════════════════════════════════════════════════════════════
     MODULE SCRIPT — Bulletin, Post Submission, Profile Drawer
     ───────────────────────────────────────────────────────────────
     Handles: bulletin init, image preview/removal, post submission
     (new and edit), approval-notice display, profile drawer toggle.
══════════════════════════════════════════════════════════════════ -->
```

Deferred CDN scripts and non-module scripts at the bottom of `<body>` get a simple `DEFERRED SCRIPTS` banner with no additional prose unless the load order matters:

```html
<!-- ═══════════════════════════════════════════════════════════════
     DEFERRED SCRIPTS
══════════════════════════════════════════════════════════════════ -->
<script src="https://cdnjs.cloudflare.com/.../gsap.min.js"></script>
```

### Summary

| Element | Rule |
|---|---|
| File header | Required on every HTML file, placed inside `<html>` before `<head>` |
| `WHAT IS NOT IN HERE` | Required — cross-references the JS and CSS responsible for dynamic behavior |
| Major section dividers | Required for every top-level structural block |
| Closing labels | Required on every major closing tag (`</nav><!-- /navbar -->`) |
| Sub-section dividers | Use the `──` style for panels and nested groups |
| Prose comments | Document CSS class origins, JS behavior, and state modifier rules |
| Inline comments | Non-obvious modifiers, JS-controlled visibility, import order only |
| Script block comments | Required — numbered list of responsibilities per block |
```

All three conventions share the same four-field header structure (`WHAT IS IN HERE`, `WHAT IS NOT IN HERE`, `REQUIRED IMPORTS`, `QUICK REFERENCE`) and the same two-tier divider system (double-line for major sections, `──` for sub-sections), so the visual language is immediately recognizable across JS, CSS, and HTML regardless of which file type you're reading.