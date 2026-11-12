// Pasal Stock: small progressive enhancements. The app works without this file.
(function () {
  "use strict";
  var root = document.documentElement;
  root.classList.add("js-ready");

  // Gauges: the server writes the fill as data-fill; the width is applied here.
  document.querySelectorAll("[data-fill]").forEach(function (el) {
    var pct = Math.max(0, Math.min(100, parseInt(el.getAttribute("data-fill"), 10) || 0));
    // Start from empty, then grow to the stock level on the next frame (the bar animates).
    window.requestAnimationFrame(function () { el.style.width = pct + "%"; });
  });

  // Confirm before destructive or irreversible form posts.
  document.querySelectorAll("form[data-confirm]").forEach(function (form) {
    form.addEventListener("submit", function (event) {
      if (!window.confirm(form.getAttribute("data-confirm"))) event.preventDefault();
    });
  });

  // Reveal sections as they enter the viewport and reverse them when scrolled back out.
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var items = document.querySelectorAll("[data-reveal]");
  if (!("IntersectionObserver" in window) || reduce) {
    items.forEach(function (el) { el.classList.add("is-in"); });
    return;
  }
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      entry.target.classList.toggle("is-in", entry.isIntersecting);
    });
  }, { threshold: 0.15 });
  items.forEach(function (el) { observer.observe(el); });
})();
