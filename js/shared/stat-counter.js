/* ================================================
   stat-counter.js — BarangayConnect
   Animated number counter triggered by viewport
   visibility. Uses IntersectionObserver to start
   each counter when its element scrolls into view.

   Activated by any element with [data-target]:
     data-target="2436"     — target number to count to
     data-suffix="%"        — optional suffix after number
     data-prefix="₱"       — optional prefix before number
     data-duration="1500"   — animation duration in ms (default: 1500)
     data-separator=","     — thousands separator (default: ",")

   Elements without data-target are ignored.
   Each counter animates once and will not repeat.

   WHAT IS IN HERE:
     · IntersectionObserver-based viewport detection
     · Ease-out cubic animation loop via requestAnimationFrame
     · Number formatting with configurable separator
     · Graceful fallback for unsupported browsers

   WHAT IS NOT IN HERE:
     · Counter element styles        → admin.css / main.css
     · Dashboard layout or data      → dashboard.js

   REQUIRED IMPORTS:
     · None — standalone IIFE, no dependencies

   QUICK REFERENCE:
     Entry point     → initCounters() (auto-runs on DOMContentLoaded)
     Animate one     → animateCounter(el)
     Selector        → [data-target]
     Trigger         → 25% visibility threshold
================================================ */

(function () {
  'use strict';


  /* ================================================
     CONFIG
  ================================================ */

  const SELECTOR = '[data-target]';


  /* ================================================
     UTILITIES
  ================================================ */

  /* Ease-out cubic — decelerates toward the end of the animation */
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  /* Formats a floored number with a configurable thousands separator */
  function formatNumber(value, separator) {
    if (!separator && separator !== '') separator = ',';
    return Math.floor(value).toLocaleString('en-US').replace(/,/g, separator);
  }


  /* ================================================
     ANIMATE COUNTER
     Runs a single requestAnimationFrame loop for
     one counter element. Guarded by data-animated
     to ensure it only runs once per element.
  ================================================ */

  function animateCounter(el) {
    if (el.dataset.animated === 'true') return;
    el.dataset.animated = 'true';

    const target    = parseFloat(el.dataset.target)    || 0;
    const duration  = parseFloat(el.dataset.duration)  || 1500;
    const suffix    = el.dataset.suffix    ?? '';
    const prefix    = el.dataset.prefix    ?? '';
    const separator = el.dataset.separator ?? ',';

    let startTime = null;

    function step(timestamp) {
      if (!startTime) startTime = timestamp;

      const elapsed  = timestamp - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased    = easeOutCubic(progress);
      const current  = target * eased;

      el.textContent = prefix + formatNumber(current, separator) + suffix;

      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        /* Snap to exact target value on completion */
        el.textContent = prefix + formatNumber(target, separator) + suffix;
      }
    }

    requestAnimationFrame(step);
  }


  /* ================================================
     INIT
     Observes all counter elements and triggers
     animation when each enters the viewport.
     Falls back to immediate animation if
     IntersectionObserver is unavailable.
  ================================================ */

  function initCounters() {
    const elements = document.querySelectorAll(SELECTOR);
    if (!elements.length) return;

    /* Fallback: animate all immediately if observer not supported */
    if (!('IntersectionObserver' in window)) {
      elements.forEach(animateCounter);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            animateCounter(entry.target);
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.25 },
    );

    elements.forEach((el) => observer.observe(el));
  }


  /* ================================================
     BOOT
     Defers init until the DOM is fully parsed.
  ================================================ */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCounters);
  } else {
    initCounters();
  }

})();