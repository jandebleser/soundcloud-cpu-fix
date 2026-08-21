# SoundCloud CPU Fix

Stops the SoundCloud web player (tab or PWA) from pegging a CPU core in
Chromium-based browsers, **even while paused**. On the current site the tab's
main thread drops from **~34 % of a core to ~4 %** on an idle page; the renderer
process as a whole drops from ~90–200 % to roughly what audio playback actually
costs.

Measured on Chrome 149 / Linux, August 2026.

---

## The problem

The SoundCloud web app pegs a CPU core while a tab/PWA is in the foreground —
even while paused. It's long-standing and cross-browser:

- [brave/brave-browser#54231](https://github.com/brave/brave-browser/issues/54231) — "CPU usage on soundcloud.com is very high when a track is played and the tab is active"
- [Mozilla Bugzilla 1057085](https://bugzilla.mozilla.org/show_bug.cgi?id=1057085) — "Playing music on Soundcloud causes massive CPU load with tab in foreground"
- [salomvary/soundcleod#118](https://github.com/salomvary/soundcleod/issues/118) — same complaint in the Electron wrapper

## Root cause (2026-08): invisible SMIL spinners

Captured with a Chrome DevTools Protocol timeline trace with invalidation
tracking on (`tools/diagnose-render-loop.cjs`). Over **6 s** of the *idle,
paused* discover page:

```
   231 frames/s
  layout     1384x   532ms
  style      1383x   666ms
  composite  1384x   615ms
  => main thread ~31% of a core
  who dirties style/layout:
     13835x LayoutInvalidationTracking reason=Style changed node=path
     13830x StyleRecalcInvalidationTracking reason=Attribute node=path
```

Every play button on the page carries a buffering throbber: an SVG `<path>`
driven by `<animateTransform attributeName="transform" dur="1s">`. SoundCloud
never stops them — it just hides them, with `visibility: hidden` and
`opacity: 0` on the wrapper (`.playableTile__playButton`). So ~10 SMIL
animations run permanently while **completely invisible**, each mutating an
attribute every frame. Attribute mutations on an SVG path invalidate style
*and* layout, so Blink runs a full style → layout → paint → composite cycle on
**every vsync**.

Two multipliers make this worse than it sounds:

- It is tied to **display refresh rate**, not to 60 Hz. On a 240 Hz laptop panel
  that's 230+ full render cycles per second — 4× the cost of the same page on a
  60 Hz monitor. Moving the window to a 60 Hz display is itself a 4× win.
- It happens with the player **paused** and the page idle. There is no JS in the
  hot path at all (`FunctionCall` is ~50 ms per 6 s), which is why a plain JS CPU
  profile shows only 59 % `(program)` and tells you nothing.

Confirmation: `svg.pauseAnimations()` on every SVG root, or deleting the 10
`<animateTransform>` elements, takes the page from 226 fps to **0 fps** and the
main thread to ~0 %.

`tools/repro-invisible-smil.html` reduces this to a standalone page with no
script of its own: 10 SMIL spinners behind `visibility: hidden; opacity: 0`
cost 237 render cycles/s and ~16 % of a core in Chrome 149 (0 % with the SMIL
removed), and ~23 % vs ~6 % in Firefox 152. Both engines sample SMIL and run the
full rendering lifecycle for animations that cannot be seen, so the waste is not
Chrome-specific — though the site is what leaves them running.

### Why the 2026-06 fix stopped working

v1 of this repo throttled `requestAnimationFrame`, which was the hot path in
June. SMIL animations are not serviced through rAF — the idle page now registers
**zero** rAF callbacks — so the v1 throttle had no effect on the current cause
(measured: 227 fps → 233 fps, i.e. nothing). It's kept in v2 anyway; it costs
nothing and still covers scripted loops during playback.

### Earlier contributor: ad/analytics scripts

A/B-tested by blocking ad/tracker scripts over CDP, they roughly doubled the JS
and compositing cost. Still worth blocking (see below), but they are not what
drives the per-frame render loop.

## The fix

### 1. `sc-throttle` — the throttle (this repo)

A content script that:

- finds every SVG root containing SMIL (`animate`, `animateTransform`, …),
  calls `pauseAnimations()` on it, and drives the timeline itself with
  `setCurrentTime()` at `TARGET_FPS` (default 30);
- only steps roots that are **on screen** (`IntersectionObserver`) **and
  actually visible** (`checkVisibility({visibilityProperty, opacityProperty})`,
  re-tested ~2×/s). The hidden buffering spinners therefore stay frozen at zero
  cost, while a spinner that really is buffering still spins, at 30fps;
- keeps new SVGs covered as the SPA navigates, via a `MutationObserver`;
- also caps `requestAnimationFrame` callbacks to `TARGET_FPS`.

Two ways to install it:

- **`sc-throttle/`** — an MV3 extension (`world: "MAIN"`, `document_start`). No userscript manager needed.
- **`soundcloud-cpu-throttle.user.js`** — the same logic as a Tampermonkey/Violentmonkey userscript.

### 2. uBlock Origin Lite — kills the ad/tracker load

Not vendored here. Install from the Web Store — it's declarative
(`declarativeNetRequest`), so it blocks network-wide and applies to PWA/app
windows too, using ~0 CPU itself:

<https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh>

## Install

> **Chrome 137+ note:** command-line `--load-extension` is silently ignored for
> unpacked extensions, so these must be added through the browser UI.

**Throttle (pick one):**

- *As an extension:* `chrome://extensions` → enable **Developer mode** → **Load
  unpacked** → select the `sc-throttle/` folder. (Chrome shows a "disable
  developer-mode extensions" nag on each restart — dismiss it; it stays active.)
  After editing `throttle.js`, hit **Reload** on the extension card, then restart
  the SoundCloud tab/PWA window — a running page keeps the old script.
- *As a userscript:* install Tampermonkey, then open
  `soundcloud-cpu-throttle.user.js` (or paste it into a new script).

Then **reload** SoundCloud. Verify in the DevTools console:
`[sc-throttle] SMIL + rAF capped to ~30fps`, or check
`document.documentElement.dataset.scThrottle === 'injected'`. Check CPU via
**Shift-Esc** (Chrome Task Manager).

## Tuning

`TARGET_FPS` in `sc-throttle/throttle.js` (and/or the `.user.js`). Lower = less
CPU, choppier visible spinners and scrubber. Reload the extension afterwards.

## Results

Idle, paused discover page, 240 Hz panel, 6 s trace:

| | before | after |
| --- | --- | --- |
| render cycles | 230/s | 0/s (all spinners hidden → frozen) |
| layout + style + composite | 1382x, 1.9 s | 0 |
| main thread | ~34 % of a core | **~4 %** |

A spinner that is genuinely visible keeps animating — its SMIL timeline still
advances 1.00 s per second, just sampled 30×/s instead of 230×/s.

## Reproduce

```sh
CHROME=/opt/google/chrome/chrome NODE_PATH=$(npm root -g) \
  node tools/diagnose-render-loop.cjs [url]
```

Launches an isolated debug Chrome (throwaway profile), traces with invalidation
tracking so every style/layout invalidation is attributed to a reason and a node,
inventories the page's SMIL elements, and A/Bs the page against
`sc-throttle/throttle.js`. See `tools/README.md`.
