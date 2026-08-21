// Stops SoundCloud from re-rendering the whole page on every display frame.
//
// Two independent loops have to be tamed:
//
//   1. SMIL spinners (the 2026-08 hot path). Every play button carries a
//      buffering throbber — an SVG <path> with <animateTransform dur="1s">
//      — and SoundCloud leaves them running with the SVG only
//      `visibility: hidden`, so they are animated but invisible. SMIL mutates
//      an attribute per frame, which invalidates style AND layout
//      document-wide, so Blink runs a full style -> layout -> paint ->
//      composite cycle on every vsync (240x/s on a 240 Hz panel) even while
//      the player is paused. SMIL does not go through requestAnimationFrame.
//      We pause every SVG timeline that contains SMIL and step it ourselves at
//      TARGET_FPS, and only while it is both on screen and actually visible —
//      the hidden ones stay frozen and cost nothing.
//
//   2. Scripted requestAnimationFrame loops (the 2026-06 hot path): callbacks
//      are deferred so they fire at most every 1000/TARGET_FPS ms.
//
// Lower TARGET_FPS = less CPU, choppier spinners/scrubber.
(function () {
  var TARGET_FPS = 30;
  var minGap = 1000 / TARGET_FPS;
  var step = 1 / TARGET_FPS;
  var RECHECK_TICKS = 15; // re-test visibility ~2x/s, not every tick

  function mark() {
    try { document.documentElement.setAttribute('data-sc-throttle', 'injected'); } catch (e) {}
  }
  mark();

  // ---------- 1. SMIL ----------
  var SMIL = 'animate,animateTransform,animateMotion,animateColor,set';
  var claimed = new Set();  // paused SVG roots we drive ourselves
  var onScreen = new Set(); // ... currently intersecting the viewport
  var visible = new Set();  // ... and not visibility:hidden / opacity:0

  function drop(svg) {
    claimed.delete(svg); onScreen.delete(svg); visible.delete(svg);
    if (io) io.unobserve(svg);
  }

  var io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          if (e.isIntersecting) { onScreen.add(e.target); }
          else { onScreen.delete(e.target); visible.delete(e.target); }
        }
      })
    : null;

  function claim(svg) {
    if (!svg || claimed.has(svg) || !svg.querySelector || !svg.querySelector(SMIL)) return;
    try { svg.pauseAnimations(); } catch (e) { return; }
    claimed.add(svg);
    if (io) io.observe(svg); else onScreen.add(svg);
  }

  function scan(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.nodeName === 'svg') claim(node);
    else if (node.ownerSVGElement && node.matches && node.matches(SMIL)) claim(node.ownerSVGElement);
    if (node.querySelectorAll) {
      var svgs = node.querySelectorAll('svg');
      for (var i = 0; i < svgs.length; i++) claim(svgs[i]);
    }
  }

  function isVisible(svg) {
    try {
      if (typeof svg.checkVisibility === 'function') {
        return svg.checkVisibility({ visibilityProperty: true, opacityProperty: true });
      }
      var cs = getComputedStyle(svg);
      return cs.visibility !== 'hidden' && cs.opacity !== '0';
    } catch (e) { return true; }
  }

  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) scan(added[j]);
    }
  }).observe(document, { childList: true, subtree: true });

  var ticks = 0;
  setInterval(function () {
    if (document.hidden || !onScreen.size) return;
    var recheck = (ticks++ % RECHECK_TICKS) === 0;
    onScreen.forEach(function (svg) {
      if (!svg.isConnected) { drop(svg); return; }
      if (recheck) {
        if (isVisible(svg)) visible.add(svg); else visible.delete(svg);
      }
      if (visible.has(svg)) {
        try { svg.setCurrentTime(svg.getCurrentTime() + step); } catch (e) {}
      }
    });
  }, minGap);

  if (document.documentElement) scan(document.documentElement);
  document.addEventListener('DOMContentLoaded', function () { mark(); scan(document.documentElement); });

  // ---------- 2. requestAnimationFrame ----------
  if (window.requestAnimationFrame) {
    var origRAF = window.requestAnimationFrame.bind(window);
    var lastRun = -Infinity;
    window.requestAnimationFrame = function (cb) {
      return origRAF(function run(ts) {
        if (ts - lastRun >= minGap) { lastRun = ts; cb(ts); }
        else { origRAF(run); } // too soon — wait for a later frame
      });
    };
  }

  window.__scThrottleActive = true;
  try { console.log('[sc-throttle] SMIL + rAF capped to ~' + TARGET_FPS + 'fps'); } catch (e) {}
})();
