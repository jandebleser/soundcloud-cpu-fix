// Caps the page's requestAnimationFrame callbacks to ~TARGET_FPS.
// SoundCloud runs an uncapped foreground rAF loop that forces a full
// style/layout/paint/composite every frame (~120+/s in testing), which pegs
// a CPU core even while paused. We defer callbacks so they fire at most every
// (1000/TARGET_FPS) ms. Lower TARGET_FPS = less CPU, slightly choppier UI.
(function () {
  try { document.documentElement.setAttribute('data-sc-throttle', 'injected'); } catch (e) {}
  var TARGET_FPS = 30;
  var minGap = 1000 / TARGET_FPS;
  if (!window.requestAnimationFrame) return;
  var origRAF = window.requestAnimationFrame.bind(window);
  var lastRun = -Infinity;
  window.requestAnimationFrame = function (cb) {
    return origRAF(function run(ts) {
      if (ts - lastRun >= minGap) {
        lastRun = ts;
        cb(ts);
      } else {
        origRAF(run); // too soon — wait for a later frame
      }
    });
  };
  try { console.log('[sc-throttle] rAF capped to ~' + TARGET_FPS + 'fps'); } catch (e) {}
})();
