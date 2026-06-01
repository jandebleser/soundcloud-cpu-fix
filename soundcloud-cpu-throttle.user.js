// ==UserScript==
// @name         SoundCloud rAF Throttle (CPU fix)
// @namespace    https://github.com/local/sc-cpu
// @version      1.0
// @description  Caps requestAnimationFrame to ~30fps on soundcloud.com. SoundCloud runs an uncapped foreground render loop that forces a full style/layout/paint/composite every frame (~120+/s), pegging a CPU core even while paused. This defers rAF callbacks so they fire at most every 1000/TARGET_FPS ms.
// @author       you
// @match        *://*.soundcloud.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function () {
  'use strict';
  var TARGET_FPS = 30;            // lower = less CPU, slightly choppier UI
  var minGap = 1000 / TARGET_FPS;
  if (!window.requestAnimationFrame) return;
  var origRAF = window.requestAnimationFrame.bind(window);
  var lastRun = -Infinity;
  window.requestAnimationFrame = function (cb) {
    return origRAF(function run(ts) {
      if (ts - lastRun >= minGap) { lastRun = ts; cb(ts); }
      else { origRAF(run); }
    });
  };
  try { console.log('[sc-throttle] rAF capped to ~' + TARGET_FPS + 'fps'); } catch (e) {}
})();
