/* ================================================
   home-animations.js — BarangayConnect
   GSAP-powered entrance animations, scroll reveals,
   parallax effects, and hover interactions for the
   home page. Runs on page load and responds to scroll
   and pointer events throughout the page lifecycle.

   WHAT IS IN HERE:
     · Reduced-motion bail-out guard
     · Cursor parallax on hero background
     · Hero background zoom on scroll (Ken Burns)
     · Scroll indicator fade-out
     · Hero content entrance timeline
     · Reusable scroll-reveal helper (reveal)
     · Section transition border-radius morphs
     · Quick Actions staggered bounce + hover springs
     · Recent Updates slide-in + hover springs
     · Stats spatial reveal
     · CTA section entrance
     · Global eyebrow label catch-all reveal

   WHAT IS NOT IN HERE:
     · Counter/count-up logic          → home.html (inline script)
     · Image viewer                    → window.openImageViewer (external)
     · Firebase data binding           → home.js
     · Component-level CSS             → home.css

   REQUIRED IMPORTS:
     · GSAP 3 (gsap, ScrollTrigger)    — loaded before this script

   QUICK REFERENCE:
     reveal(targets, vars, triggerEl, start) → ScrollTrigger-backed gsap.from()
================================================ */


gsap.registerPlugin(ScrollTrigger);


/* ================================================
   REDUCED MOTION
================================================ */

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;


/* ================================================
   CURSOR PARALLAX — hero background follows mouse lazily
================================================ */

(function () {
  const hero = document.querySelector(".hero");
  if (!hero || reduced) return;

  let tx = 50, ty = 50, cx = 50, cy = 50;

  window.addEventListener("mousemove", e => {
    tx = 50 + (e.clientX / window.innerWidth  - 0.5) * 10;
    ty = 50 + (e.clientY / window.innerHeight - 0.5) *  7;
  });

  gsap.ticker.add(() => {
    cx += (tx - cx) * 0.055;
    cy += (ty - cy) * 0.055;
    hero.style.backgroundPosition = `${cx}% ${cy}%`;
  });
})();


/* ================================================
   HERO BACKGROUND — zoom on scroll (Ken Burns)
================================================ */

gsap.fromTo(".hero",
  { backgroundSize: "100%" },
  {
    backgroundSize: "115%",
    ease: "none",
    scrollTrigger: {
      trigger: ".hero",
      start:   "top top",
      end:     "bottom top",
      scrub:   2.5,
    },
  }
);


/* ================================================
   SCROLL INDICATOR — fades as user leaves hero
================================================ */

gsap.to(".hero__scroll-indicator", {
  opacity: 0,
  y:       14,
  ease:    "none",
  scrollTrigger: {
    trigger: ".hero",
    start:   "top 85%",
    end:     "32% top",
    scrub:   true,
  },
});


/* ================================================
   HERO CONTENT — entrance timeline on load
================================================ */

const heroTl = gsap.timeline({ delay: 0.1 });

heroTl
  .from(".hero .location-pill",         { y: 24, opacity: 0, duration: 0.7,  ease: "power3.out" })
  .from(".hero__headline",              { y: 36, opacity: 0, duration: 0.85, ease: "power3.out" },         "-=0.45")
  .from(".hero__desc",                  { y: 24, opacity: 0, duration: 0.7,  ease: "power3.out" },         "-=0.5")
  .from(".hero__cta .btn--outline-hero",{ y: 20, opacity: 0, duration: 0.55, ease: "back.out(1.8)", stagger: 0.1 }, "-=0.4")
  .from(".hero__right > *",             { y: 28, opacity: 0, duration: 0.6,  ease: "power3.out", stagger: 0.12 }, "-=0.55");


/* ================================================
   HELPER — reusable scroll reveal
   toggleActions replays the animation every time the
   trigger enters and leaves the viewport.
================================================ */

function reveal(targets, vars, triggerEl, start = "top 82%") {
  return gsap.from(targets, {
    ...vars,
    scrollTrigger: {
      trigger:       triggerEl || targets,
      start,
      toggleActions: "play reverse play reverse",
    },
  });
}


/* ================================================
   SECTION TRANSITIONS — border-radius morphs
   Hero bottom curves away as the next section scrolls in;
   footer top curves up as it enters the viewport.
================================================ */

gsap.to(".hero", {
  borderRadius: "0 0 80px 80px",
  ease: "none",
  scrollTrigger: {
    trigger: ".section-quick-actions",
    start:   "top bottom",
    end:     "top 60%",
    scrub:   1,
  },
});

gsap.to(".dark-footer-wrap", {
  borderRadius: "64px 64px 0 0",
  ease: "none",
  scrollTrigger: {
    trigger: ".dark-footer-wrap",
    start:   "top bottom",
    end:     "top top",
    scrub:   1,
  },
});


/* ================================================
   QUICK ACTIONS — staggered spring bounce + hover
================================================ */

/* Eyebrow and heading wipe */
reveal(
  [".section-quick-actions .section-eyebrow",
   ".section-quick-actions .section-heading"],
  { y: 28, opacity: 0, duration: 0.65, ease: "power3.out", stagger: 0.1 },
  ".section-quick-actions",
  "top 85%"
);

/* Selector button grid bounce-in */
reveal(
  ".quick-actions__grid .btn--selector",
  { y: 44, opacity: 0, scale: 0.86, duration: 0.7, ease: "back.out(2)", stagger: 0.07 },
  ".section-quick-actions"
);

/* Hover spring on each selector button */
document.querySelectorAll(".btn--selector").forEach(btn => {
  btn.addEventListener("mouseenter", () =>
    gsap.to(btn, { y: -7, scale: 1.05, duration: 0.38, ease: "back.out(2.8)" }));
  btn.addEventListener("mouseleave", () =>
    gsap.to(btn, { y: 0,  scale: 1,    duration: 0.5,  ease: "elastic.out(1, 0.45)" }));
});


/* ================================================
   RECENT UPDATES — slide from sides + hover spring
================================================ */

/* Section header wipe */
reveal(
  ".section-updates .section-eyebrow, .section-updates .section-heading",
  { y: 22, opacity: 0, duration: 0.6, ease: "power3.out", stagger: 0.1 },
  ".section-updates"
);

/* Featured post slides in from the left */
reveal(
  ".post-featured",
  { x: -60, opacity: 0, duration: 1.0, ease: "expo.out" },
  ".section-updates",
  "top 75%"
);

/* Accented post rows slide in from the right */
reveal(
  ".post-row--accented",
  { x: 50, opacity: 0, duration: 0.7, ease: "power3.out", stagger: 0.15 },
  ".section-updates__rows",
  "top 80%"
);

/* Hover spring on each post row */
document.querySelectorAll(".post-row--accented").forEach(row => {
  row.addEventListener("mouseenter", () =>
    gsap.to(row, { y: -4, duration: 0.3, ease: "back.out(2.2)" }));
  row.addEventListener("mouseleave", () =>
    gsap.to(row, { y: 0,  duration: 0.5, ease: "elastic.out(1, 0.5)" }));
});


/* ================================================
   STATS — spatial reveal
   Count-up logic lives in the HTML; this handles
   the spatial entrance only.
================================================ */

reveal(
  ".section-stats .section-heading, .section-stats .section-eyebrow",
  { y: 22, opacity: 0, duration: 0.65, ease: "power3.out", stagger: 0.1 },
  ".section-stats"
);

reveal(
  ".stat-grid__item",
  { y: 36, opacity: 0, scale: 0.92, duration: 0.75, ease: "back.out(1.8)", stagger: 0.13 },
  ".stat-grid",
  "top 80%"
);


/* ================================================
   CTA SECTION — staggered entrance
================================================ */

reveal(
  ".section-cta__icon",
  { scale: 0.2, opacity: 0, duration: 0.7, ease: "back.out(2.5)" },
  ".section-cta"
);

reveal(
  [".section-cta__heading", ".section-cta__desc", ".section-cta .btn--orange"],
  { y: 34, opacity: 0, duration: 0.75, ease: "power3.out", stagger: 0.14 },
  ".section-cta",
  "top 78%"
);


/* ================================================
   EYEBROW LABELS — global catch-all
   Applies a default slide-in to any eyebrow element
   not already claimed by a section-specific reveal.
================================================ */

gsap.utils.toArray(".section-eyebrow").forEach(el => {
  if (ScrollTrigger.getById(el)) return;
  reveal(el, { x: -18, opacity: 0, duration: 0.5, ease: "power2.out" }, el, "top 88%");
});