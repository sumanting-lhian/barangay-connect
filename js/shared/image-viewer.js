/* ================================================
   image-viewer.js — BarangayConnect
   Shared fullscreen image viewer modal. Renders a
   scrollable strip of images with navigation arrows,
   dot indicators, keyboard and scroll wheel support.
   Injected into the DOM on first use and reused
   across all pages that call openImageViewer.

   WHAT IS IN HERE:
     · Lazy DOM injection of the viewer modal
     · Viewer open / close with body scroll lock
     · Slide navigation (arrows, dots, keyboard, wheel)
     · Counter and title rendering
     · Dot indicator sync on slide change

   WHAT IS NOT IN HERE:
     · Viewer CSS styles                → image-viewer.css
     · Post image thumbnail rendering  → community-posts.js
     · Profile photo viewer            → profile.js

   REQUIRED IMPORTS:
     · Lucide Icons (lucide.createIcons) — loaded before this script

   QUICK REFERENCE:
     Open viewer   → openImageViewer(images, index, title)
                      window.openImageViewer(images, index, title)
     Inject modal  → _injectImageViewer()   (called automatically)
================================================ */


/* ================================================
   MODULE STATE
================================================ */

let _viewerImages    = [];
let _viewerIndex     = 0;
let _viewerTitle     = '';
let _viewerWheelLock  = false;
let _stripScrolling   = false;
let _stripScrollTimer = null;


/* ================================================
   DOM INJECTION
   Builds and appends the viewer overlay once;
   subsequent calls are no-ops.
================================================ */

function _injectImageViewer() {
  if (document.getElementById('imgViewerOverlay')) return;

  const el     = document.createElement('div');
  el.id        = 'imgViewerOverlay';
  el.className = 'img-viewer-overlay';
  el.style.zIndex = '9999';

  el.innerHTML = `
    <div class="img-viewer" id="imgViewer">

      <button class="img-viewer__close" id="imgViewerClose" aria-label="Close">
        <i data-lucide="x"></i>
      </button>
      <span class="img-viewer__counter" id="imgViewerCounter"></span>
      <!-- Hidden title kept for JS compat -->
      <span class="img-viewer__title" id="imgViewerTitle" style="display:none;"></span>

      <div class="img-viewer__stage">
        <button class="img-viewer__arrow img-viewer__arrow--prev" id="imgViewerPrev" aria-label="Previous">
          <i data-lucide="chevron-left"></i>
        </button>
        <div class="img-viewer__strip" id="imgViewerStrip"></div>
        <button class="img-viewer__arrow img-viewer__arrow--next" id="imgViewerNext" aria-label="Next">
          <i data-lucide="chevron-right"></i>
        </button>
      </div>

      <div class="img-viewer__panel" id="imgViewerPanel">
        <div class="img-viewer__dots" id="imgViewerDots"></div>
        <div class="img-viewer__accent"></div>
      </div>

    </div>`;

  document.body.appendChild(el);
  lucide.createIcons({ el });

  /* ── Event listeners ── */

  /* Close on backdrop click */
  el.addEventListener('click', e => { if (e.target === el) _closeViewer(); });

  document.getElementById('imgViewerClose').addEventListener('click', _closeViewer);
  document.getElementById('imgViewerPrev').addEventListener('click', () => _viewerNav(-1));
  document.getElementById('imgViewerNext').addEventListener('click', () => _viewerNav(1));

  /* Keyboard navigation */
  document.addEventListener('keydown', e => {
    if (!document.getElementById('imgViewerOverlay')?.classList.contains('is-open')) return;
    if (e.key === 'ArrowLeft')  _viewerNav(-1);
    if (e.key === 'ArrowRight') _viewerNav(1);
    if (e.key === 'Escape')     _closeViewer();
  });

  /* Scroll wheel navigation with debounce lock */
  document.getElementById('imgViewerStrip').addEventListener('wheel', e => {
    if (!document.getElementById('imgViewerOverlay')?.classList.contains('is-open')) return;
    if (_viewerImages.length <= 1) return;
    e.preventDefault();
    if (_viewerWheelLock) return;
    _viewerWheelLock = true;
    _viewerNav(e.deltaY > 0 ? 1 : -1);
    setTimeout(() => { _viewerWheelLock = false; }, 600);
  }, { passive: false });

  /* Close when clicking the dark slide area outside the actual image */
  document.getElementById('imgViewerStrip').addEventListener('click', e => {
    if (!e.target.closest('img')) _closeViewer();
  });

  /* Swipe/scroll → sync counter + dots */
  document.getElementById('imgViewerStrip').addEventListener('scroll', () => {
    if (_stripScrolling) return;
    clearTimeout(_stripScrollTimer);
    _stripScrollTimer = setTimeout(() => {
      const strip = document.getElementById('imgViewerStrip');
      const w     = strip?.offsetWidth;
      if (!w) return;
      const idx = Math.round(strip.scrollLeft / w);
      if (idx === _viewerIndex || idx < 0 || idx >= _viewerImages.length) return;
      _viewerIndex = idx;
      const counter = document.getElementById('imgViewerCounter');
      const dots    = document.getElementById('imgViewerDots');
      if (counter) counter.textContent = _viewerImages.length > 1 ? `${idx + 1} / ${_viewerImages.length}` : '';
      dots?.querySelectorAll('.img-viewer__dot')
        .forEach((d, i) => d.classList.toggle('is-active', i === idx));
    }, 80);
  });
}


/* ================================================
   OPEN / CLOSE
================================================ */

function _openViewer(images, index, title) {
  _injectImageViewer();
  _viewerImages = Array.isArray(images) ? images : [images];
  _viewerIndex  = index ?? 0;
  _viewerTitle  = title ?? '';
  _renderViewer();
  /* Clear accent so every caller starts fresh — prevents stale elements across posts */
  const _acc = document.querySelector('#imgViewerOverlay .img-viewer__accent');
  if (_acc) _acc.innerHTML = '';
  document.getElementById('imgViewerOverlay').classList.add('is-open');
  document.body.style.overflow = 'hidden';
  document.documentElement.style.overflow = 'hidden';
}

function _closeViewer() {
  document.getElementById('imgViewerOverlay')?.classList.remove('is-open');
  /* Only unlock scroll if no modal is still open behind the viewer */
  if (!document.querySelector('.modal-overlay.is-open')) {
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
  }
  /* Clear gallery-injected accent elements so they don't bleed to other viewers */
  document.querySelector('#imgViewerOverlay .img-viewer__accent')
    ?.querySelectorAll('.gallery-viewer-link,.gallery-viewer-meta,.gallery-viewer-album,.gallery-viewer-add-album')
    .forEach(el => el.remove());
}


/* ================================================
   NAVIGATION
================================================ */

function _viewerNav(dir) {
  const next = (_viewerIndex + dir + _viewerImages.length) % _viewerImages.length;
  _goToSlide(next);
}

function _goToSlide(index) {
  _viewerIndex = index;

  const strip   = document.getElementById('imgViewerStrip');
  const counter = document.getElementById('imgViewerCounter');
  const dots    = document.getElementById('imgViewerDots');

  if (strip) {
    _stripScrolling = true;
    strip.scrollLeft = strip.offsetWidth * index;
    setTimeout(() => { _stripScrolling = false; }, 400);
  }
  if (counter) counter.textContent = _viewerImages.length > 1 ? `${index + 1} / ${_viewerImages.length}` : '';

  dots?.querySelectorAll('.img-viewer__dot')
    .forEach((d, i) => d.classList.toggle('is-active', i === index));
}


/* ================================================
   RENDER
   Rebuilds the slide strip and dot indicators
   for the current image set and active index.
================================================ */

function _renderViewer() {
  const strip   = document.getElementById('imgViewerStrip');
  const title   = document.getElementById('imgViewerTitle');
  const counter = document.getElementById('imgViewerCounter');
  const dots    = document.getElementById('imgViewerDots');
  const viewer  = document.getElementById('imgViewer');
  if (!strip) return;

  title.textContent   = _viewerTitle;
  counter.textContent = _viewerImages.length > 1 ? `${_viewerIndex + 1} / ${_viewerImages.length}` : '';

  /* Single-image modifier hides arrows and counter */
  viewer.classList.toggle('img-viewer--single', _viewerImages.length === 1);

  /* Build slide strip */
  strip.innerHTML = _viewerImages.map((url, i) => `
    <div class="img-viewer__slide">
      <img class="img-viewer__img"
           src="${url}"
           alt="${_viewerTitle} ${i + 1}"
           loading="eager"
           style="opacity:0;"
           onload="this.style.opacity='1'" />
    </div>`).join('');

  /* Scroll to active index without animation on initial render */
  requestAnimationFrame(() => {
    strip.style.scrollBehavior = 'auto';
    strip.scrollLeft = strip.offsetWidth * _viewerIndex;
    strip.style.scrollBehavior = 'smooth';
  });

  /* Build dot indicators */
  dots.innerHTML = _viewerImages.map((_, i) => `
    <button class="img-viewer__dot${i === _viewerIndex ? ' is-active' : ''}"
            aria-label="Image ${i + 1}"></button>`).join('');

  dots.querySelectorAll('.img-viewer__dot').forEach((dot, i) => {
    dot.addEventListener('click', () => { _viewerIndex = i; _goToSlide(i); });
  });
}


/* ================================================
   EXPORTS
   Exposed globally for inline HTML onclick handlers;
   also exported as an ES module for JS imports.
================================================ */

window.openImageViewer = _openViewer;

export { _openViewer as openImageViewer, _injectImageViewer };