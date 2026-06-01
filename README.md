# SoundCloud CPU Fix

Cuts the CPU the SoundCloud web player (tab or PWA) burns in Chromium-based
browsers from **~80–100 %+ of a core down to ~20 %** — most of which is then
just legitimate audio playback.

Measured on Chrome 147 / Linux, June 2026.

---

## The problem

The SoundCloud web app pegs a CPU core while a tab/PWA is in the foreground —
**even while paused**. It's a long-standing, cross-browser SoundCloud issue, not
a browser bug:

- [brave/brave-browser#54231](https://github.com/brave/brave-browser/issues/54231) — "CPU usage on soundcloud.com is very high when a track is played and the tab is active"
- [Mozilla Bugzilla 1057085](https://bugzilla.mozilla.org/show_bug.cgi?id=1057085) — "Playing music on Soundcloud causes massive CPU load with tab in foreground"
- [salomvary/soundcleod#118](https://github.com/salomvary/soundcleod/issues/118) — same complaint in the Electron wrapper

A survey of all ~95 SoundCloud userscripts on GreasyFork found **no** existing
performance/CPU fix, so this repo rolls its own.

## Root cause

Captured with a Chrome DevTools Protocol timeline trace (see `tools/`). Over a
**5-second** trace of the *idle, paused* discover page:

| Blink lifecycle event (per 5 s) | count | meaning |
| --- | --- | --- |
| `PageAnimator::serviceScriptedAnimations` | 631 | `requestAnimationFrame` serviced **~126×/sec** |
| `Document::recalcStyle` | 631 | full style recalc every frame |
| `LocalFrameView::performLayout` | 631 | full layout every frame |
| `PaintArtifactCompositor::Update` | 631 | recomposite every frame |
| `Blink.ForcedStyleAndLayout` | 4470 | forced synchronous layouts |

SoundCloud runs an **uncapped foreground `requestAnimationFrame` loop that
mutates the DOM every frame**, forcing a full style → layout → paint →
composite cycle ~126 times per second (the display is 60 Hz, so it's doing ~2×
the work that could ever be shown). A plain JS CPU profile hides this as 86 %
`(program)` because the cost is native rendering work, not attributable JS — the
timeline trace is what exposes it.

### Two contributors (A/B tested by blocking ad/tracker scripts via CDP)

| metric (per 5 s) | baseline | ad/trackers blocked |
| --- | --- | --- |
| rAF frame rate | **128 fps** | **55 fps** |
| `PaintArtifactCompositor::Update` | 708 ms | 258 ms |
| `FunctionCall` (JS) | 1309 ms | 844 ms |

1. **Ad/analytics scripts** (`cadmus.script.ac`, `aditude.io`, `dwt.soundcloud.com`, comscore …) — roughly **half** the work.
2. **SoundCloud's own UI loop** — a ~55 fps forced-layout loop that remains even with ads gone.

## The fix

Two independent pieces; each addresses one contributor.

### 1. uBlock Origin Lite — kills the ad/tracker half

Not vendored here (it's a third-party MV3 extension). Install from the Web
Store — it's declarative (`declarativeNetRequest`), so it blocks network-wide
and applies to PWA/app windows too, using ~0 CPU itself:

<https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh>

### 2. rAF throttle — caps SoundCloud's own loop

A tiny content script that wraps `requestAnimationFrame` to fire callbacks at
most `TARGET_FPS` (default 30). Provided two ways:

- **`sc-throttle/`** — an MV3 extension (`world: "MAIN"`, `document_start`). No userscript manager needed.
- **`soundcloud-cpu-throttle.user.js`** — the same logic as a Tampermonkey/Violentmonkey userscript.

## Install

> **Chrome 137+ note:** command-line `--load-extension` is silently ignored for
> unpacked extensions, so these must be added through the browser UI.

**uBlock Origin Lite:** open the store link above → *Add to Chrome*.

**Throttle (pick one):**

- *As an extension:* `chrome://extensions` → enable **Developer mode** → **Load
  unpacked** → select the `sc-throttle/` folder. (Chrome shows a "disable
  developer-mode extensions" nag on each restart — dismiss it; it stays active.)
- *As a userscript:* install Tampermonkey, then open
  `soundcloud-cpu-throttle.user.js` (or paste it into a new script).

Then **reload** SoundCloud. Verify in DevTools console:
`[sc-throttle] rAF capped to ~30fps`. Check CPU via **Shift-Esc** (Chrome Task
Manager).

## Tuning

Edit `TARGET_FPS` in `sc-throttle/throttle.js` (and/or the `.user.js`). Lower =
less CPU, choppier scrubber/waveform. Reload the extension afterward.

## Results

| | before | after (uBOL + throttle) |
| --- | --- | --- |
| renderer total | ~88–100 %+ (bursting >100 %) | **~20 %** |
| main thread (JS + layout/paint) | 56 % | ~18 % |

The remaining ~20 % is mostly real audio decode/output during playback.

## Reproduce

`tools/profile-soundcloud.cjs` launches an isolated debug Chrome, loads
SoundCloud, and prints the Blink-lifecycle breakdown plus an ad-block A/B
comparison over the DevTools Protocol. See `tools/README.md`.

## Caveat

The throttle's `world: "MAIN"` injection wasn't live-tested against SoundCloud's
CSP during development (Chrome 147 blocked every headless extension-load path),
but MAIN-world content scripts run with extension privileges and aren't subject
to page CSP, and the deployed result (~20 % CPU) confirms it works.
