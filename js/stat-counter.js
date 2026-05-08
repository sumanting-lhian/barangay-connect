// js/stat-counter.js
// =====================================================
// Animated number counter — runs when element enters
// the viewport (IntersectionObserver).
//
// Works on any element with:
//   data-target="2436"        — target number
//   data-suffix="%"           — optional suffix appended after number
//   data-prefix="₱"          — optional prefix prepended before number
//   data-duration="1500"      — animation duration in ms (default: 1500)
//   data-separator=","        — number format separator (default: ",")
//
// Elements with a data-suffix that has no data-target
// are treated as static and skipped.
//
// Usage:
//   <span class="stat-grid__number" data-target="2436" data-separator=",">0</span>
//   <span class="stat-grid__number" data-target="98"   data-suffix="%">0</span>
//   <script src="js/stat-counter.js"></script>
// =====================================================

(function () {
  'use strict';

  // Selects all counter elements on the page
  const SELECTOR = '[data-target]';

  /**
   * Easing function — ease out cubic
   */
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  /**
   * Format a number with commas (or custom separator)
   */
  function formatNumber(value, separator) {
    if (!separator && separator !== '') separator = ',';
    return Math.floor(value).toLocaleString('en-US').replace(/,/g, separator);
  }

  /**
   * Animate a single counter element
   */
  function animateCounter(el) {
    // Already animated? Skip
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
        // Ensure we land exactly on target
        el.textContent = prefix + formatNumber(target, separator) + suffix;
      }
    }

    requestAnimationFrame(step);
  }

  /**
   * Set up IntersectionObserver to trigger counters when in view
   */
  function initCounters() {
    const elements = document.querySelectorAll(SELECTOR);
    if (!elements.length) return;

    // If IntersectionObserver not supported, animate immediately
    if (!('IntersectionObserver' in window)) {
      elements.forEach(animateCounter);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            animateCounter(entry.target);
            observer.unobserve(entry.target); // run once
          }
        });
      },
      { threshold: 0.25 } // trigger when 25% visible
    );

    elements.forEach((el) => observer.observe(el));
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCounters);
  } else {
    initCounters();
  }
})();
