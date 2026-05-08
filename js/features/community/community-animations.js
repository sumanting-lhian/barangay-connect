/* ================================================
   community-animations.js — BarangayConnect
   GSAP entrance and interaction animations for
   the Community page.

      the Community page. Mirrors the spirit of
   home-animations.js.

   WHAT IS IN HERE:
     · Hero staggered entrance timeline on load
     · Hero border-radius scroll curve (ScrollTrigger)
     · Tab-switch panel reveal and card stagger
     · Card hover springs (pet, program, post-row)
     · Filter pill hover springs
     · FAB bouncy entrance and hover pulse
     · Bulletin MutationObserver for injected post rows
     · Modal open/close elastic patch (wraps openModal / closeModal)

   WHAT IS NOT IN HERE:
     · Tab switching logic               → community.js
     · Modal open/close base functions   → community.js
     · Animation for the home page       → home-animations.js
     · Page styles                       → community.css

   REQUIRED IMPORTS:
     · GSAP 3.12.5        (gsap.min.js via CDN)
     · ScrollTrigger 3.12.5 (ScrollTrigger.min.js via CDN)

   QUICK REFERENCE:
     Entry point      → init() (called on DOMContentLoaded or immediately)
     Panel animation  → animatePanelCards(panelId, delay?)
     Hover wiring     → wireCardHovers(root)
     Card selectors   → PANEL_CARDS map (keyed by tab panel ID)
================================================ */

(function () {

  if (typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') return;

  gsap.registerPlugin(ScrollTrigger);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return;

  /* Flag: hero only plays once per browser session */
  const HERO_FLAG = 'bc_community_hero_seen';
  const heroSeen  = sessionStorage.getItem(HERO_FLAG);


  // ================================================
  // CONFIGURATION
  // ================================================

  const PANEL_CARDS = {
    'tab-bulletin':  'article.post-row',
    'tab-polls':     '.poll-card',
    'tab-calendar':  '.event-item, .cal',
    'tab-gallery':   '.gallery-item',
    'tab-youth':     '.program-card, .notice-banner',
    'tab-pets':      '.pet-card',
  };

  /* Track which panels have already played their entrance */
  const _animatedPanels = new Set();


  // ================================================
  // PANEL ANIMATION
  // ================================================

  /*
     First visit to a panel: subtle fade + slight lift.
     Subsequent visits: instant, no animation (not annoying).
  */
  function animatePanelCards(panelId, isFirstLoad = false) {
    const panel = document.getElementById(panelId);
    if (!panel) return;

    /* Only animate once per panel per session */
    if (_animatedPanels.has(panelId)) {
      return;
    }

    _animatedPanels.add(panelId);

    const sel   = PANEL_CARDS[panelId] ?? '';
    const cards = sel ? panel.querySelectorAll(sel) : [];
    const delay = isFirstLoad ? 0.28 : 0.05;

    gsap.fromTo(panel,
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.28, ease: 'power3.out', clearProps: 'opacity,y' }
    );

    if (!cards.length) return;

    gsap.fromTo(cards,
      { y: 18, opacity: 0 },
      {
        y: 0, opacity: 1,
        duration: 0.38, ease: 'power3.out',
        stagger: 0.045,
        delay,
        clearProps: 'opacity,y',
      }
    );
  }


  // ================================================
  // HOVER SPRINGS — lighter, snappier
  // ================================================

  function wireCardHovers(root) {
    root.querySelectorAll('.pet-card:not([data-hover])')
      .forEach(c => {
        c.dataset.hover = '1';
        c.addEventListener('mouseenter', () =>
          gsap.to(c, { y: -4, scale: 1.015, duration: 0.22, ease: 'power2.out' }));
        c.addEventListener('mouseleave', () =>
          gsap.to(c, { y: 0,  scale: 1,     duration: 0.35, ease: 'power3.out' }));
      });

    root.querySelectorAll('.program-card:not([data-hover])')
      .forEach(c => {
        c.dataset.hover = '1';
        c.addEventListener('mouseenter', () =>
          gsap.to(c, { y: -5, duration: 0.22, ease: 'power2.out' }));
        c.addEventListener('mouseleave', () =>
          gsap.to(c, { y: 0,  duration: 0.35, ease: 'power3.out' }));
      });

    root.querySelectorAll('.post-row:not([data-hover])')
      .forEach(row => {
        row.dataset.hover = '1';
        row.addEventListener('mouseenter', () =>
          gsap.to(row, { y: -3, duration: 0.18, ease: 'power2.out' }));
        row.addEventListener('mouseleave', () =>
          gsap.to(row, { y: 0,  duration: 0.30, ease: 'power3.out' }));
      });
  }


  // ================================================
  // INIT
  // ================================================

  function init() {

    /* ── Hero: only play if not seen this session ──────────────── */
    if (!heroSeen) {
      sessionStorage.setItem(HERO_FLAG, '1');

      const heroTl = gsap.timeline({ delay: 0.05 });
      heroTl
        .from('.community-hero__eyebrow', {
          y: 14, opacity: 0, duration: 0.40, ease: 'power3.out',
        })
        .from('.community-hero__title', {
          y: 28, opacity: 0, duration: 0.55, ease: 'power3.out',
        }, '-=0.28')
        .from('.community-tabs .btn--category', {
          y: 16, opacity: 0, scale: 0.92,
          duration: 0.38, ease: 'back.out(1.8)',
          stagger: 0.035,           /* was 0.07 — 2× faster */
          clearProps: 'opacity,y,scale',
        }, '-=0.38');
    }


    /* ── Hero: border-radius scroll curve ──────────────────────── */
    gsap.to('.community-hero', {
      borderRadius: '0 0 80px 80px',
      ease: 'none',
      scrollTrigger: {
        trigger: '.community-main',
        start:   'top 95%',
        end:     'top 60%',
        scrub:   1.2,
      }
    });


    /* ── Initial active panel ──────────────────────────────────── */
    const activePanel = document.querySelector('.tab-panel.is-active');
    if (activePanel) {
      animatePanelCards(activePanel.id, true);
      wireCardHovers(activePanel);
    }


    /* ── Tab buttons: lighter hover (no big lift) ──────────────── */
    document.querySelectorAll('.community-tabs .btn--category').forEach(btn => {
      btn.addEventListener('mouseenter', () =>
        gsap.to(btn, { y: -2, scale: 1.03, duration: 0.18, ease: 'power2.out' }));
      btn.addEventListener('mouseleave', () =>
        gsap.to(btn, { y: 0,  scale: 1,    duration: 0.28, ease: 'power3.out' }));
    });


    /* ── Tab switch: subtle, fast, non-repeating ───────────────── */
    document.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        requestAnimationFrame(() => {
          const panelId = 'tab-' + btn.dataset.tab;
          animatePanelCards(panelId);

          const panel = document.getElementById(panelId);
          if (panel) {
            wireCardHovers(panel);

            /* Filter pills: only animate on first visit to the panel */
            if (!_animatedPanels.has(panelId + '_pills')) {
              _animatedPanels.add(panelId + '_pills');
              const pills = panel.querySelectorAll('.btn--filter');
              if (pills.length) {
                gsap.fromTo(pills,
                  { x: -10, opacity: 0 },
                  {
                    x: 0, opacity: 1,
                    duration: 0.25, ease: 'power2.out',
                    stagger: 0.025,
                    clearProps: 'opacity,x',
                  }
                );
              }
            }
          }
        });
      });
    });


    /* ── Bulletin: MutationObserver — gentle fade only ─────────── */
    const bulletinList = document.getElementById('bulletinList');
    if (bulletinList) {
      let _animTimer  = null;
      let _firstBatch = true;

      const observer = new MutationObserver(() => {
  clearTimeout(_animTimer);
  _animTimer = setTimeout(() => {
    const rows = bulletinList.querySelectorAll('article.post-row');
    if (!rows.length) return;

    gsap.set(rows, { opacity: 0 });

    gsap.fromTo(rows,
      { opacity: 0, y: _firstBatch ? 14 : 0 },
      {
        opacity: 1, y: 0,
        duration: _firstBatch ? 0.38 : 0.22,
        ease: 'power3.out',
        stagger: _firstBatch ? 0.04 : 0,
        clearProps: 'opacity,y',
      }
    );

    _firstBatch = false;
    wireCardHovers(bulletinList);
  }, 80);
});

      observer.observe(bulletinList, { childList: true, subtree: false });
    }


    /* ── Filter pills: subtle hover only ───────────────────────── */
    document.querySelectorAll('.community-main .btn--filter').forEach(btn => {
      btn.addEventListener('mouseenter', () =>
        gsap.to(btn, { scale: 1.04, duration: 0.15, ease: 'power2.out' }));
      btn.addEventListener('mouseleave', () =>
        gsap.to(btn, { scale: 1,    duration: 0.22, ease: 'power2.out' }));
    });


    /* ── FAB: quick entrance + subtle hover ────────────────────── */
    gsap.from('.btn--fab', {
      scale: 0, rotation: -30, opacity: 0,
      duration: 0.40, ease: 'back.out(2.5)',
      delay: heroSeen ? 0.1 : 0.7,
      clearProps: 'opacity,scale,rotation',
    });

    const fab = document.querySelector('.btn--fab');
    if (fab) {
      fab.addEventListener('mouseenter', () =>
        gsap.to(fab, { scale: 1.08, duration: 0.18, ease: 'back.out(2.5)' }));
      fab.addEventListener('mouseleave', () =>
        gsap.to(fab, { scale: 1,    duration: 0.28, ease: 'power3.out' }));
    }


    /* ── Modal: tighter, faster ────────────────────────────────── */
    setTimeout(function patchModals() {
      const _origOpen  = window.openModal;
      const _origClose = window.closeModal;

      window.openModal = function (id) {
        const overlay = document.getElementById(id);
        if (overlay) {
          overlay.classList.add('is-open');

          const modal = overlay.querySelector('.modal');
          if (modal) {
            gsap.fromTo(modal,
              { y: 20, scale: 0.97, opacity: 0 },
              { y: 0,  scale: 1,    opacity: 1,
                duration: 0.30, ease: 'back.out(1.8)', clearProps: 'all' }
            );
          }

          gsap.fromTo(overlay,
            { opacity: 0 },
            { opacity: 1, duration: 0.20, ease: 'power2.out', clearProps: 'opacity' }
          );
        }
        if (typeof _origOpen === 'function') _origOpen(id);
      };

      window.closeModal = function (id) {
        const overlay = document.getElementById(id);
        if (!overlay) {
          if (typeof _origClose === 'function') _origClose(id);
          return;
        }

        const modal  = overlay.querySelector('.modal');
        const finish = () => {
          overlay.classList.remove('is-open');
          if (modal) gsap.set(modal, { clearProps: 'all' });
        };

        if (modal) {
          gsap.to(modal, { y: 12, scale: 0.97, opacity: 0, duration: 0.16, ease: 'power2.in' });
        }
        gsap.to(overlay, { opacity: 0, duration: 0.18, ease: 'power2.in', onComplete: finish });

        if (typeof _origClose === 'function') _origClose(id);
      };
    }, 0);

  } // end init()


  // ================================================
  // ENTRY POINT
  // ================================================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
