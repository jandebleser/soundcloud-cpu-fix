# Draft: Chromium bug report

**File at:** <https://issues.chromium.org/issues/new> · Component: `Blink>SVG`
(secondary: `Blink>Animation`) · Type: Bug · Priority suggestion: P2

---

**Title:** SMIL animations in `visibility:hidden` / `opacity:0` subtrees run the
full rendering lifecycle at display refresh rate — 5–7× the cost of the same
animation when visible

**Chrome version:** 149.0.7827.53 (Linux, X11, 240 Hz panel)
**Also affects:** any refresh rate — the cost scales with it

## What happens

A SMIL animation (`<animateTransform>` on an SVG `<path>`) that is inside a
subtree hidden with `visibility: hidden` or `opacity: 0` keeps being sampled
every frame. Each sample mutates an attribute, which invalidates style *and*
layout, so Blink runs a full style → layout → paint → composite cycle on **every
vsync** — 240×/s on a 240 Hz display — for content that provably cannot produce
a pixel. `RasterTask` count over these traces is **zero**.

The same animation, left visible, is throttled to ~22 fps and costs a fraction
as much. So hiding the animation makes it 5–7× *more* expensive than showing it,
which is the opposite of what any author would expect.

`display: none` is handled correctly (the animation is skipped entirely), so the
mechanism to skip non-rendered SMIL already exists — it just doesn't cover
`visibility: hidden` or `opacity: 0`.

## Repro

Attached: `repro-invisible-smil.html` (also at
https://github.com/<user>/soundcloud-cpu-fix/blob/main/tools/repro-invisible-smil.html).
It builds 10 SVG spinners with `<animateTransform attributeName="transform"
type="rotate" dur="1s" repeatCount="indefinite">`, each inside a wrapper, and
runs **no other script**. URL flags choose the wrapper style.

1. Open `repro-invisible-smil.html` (default wrapper: `visibility: hidden; opacity: 0`).
2. Record a 5 s Performance trace, or use DevTools' rendering FPS meter.
3. Repeat with `?visible`, `?vishidden`, `?opacity0`, `?dnone`, `?off`.

## Measurements (5 s trace, renderer main thread)

| wrapper | frames/s | layout | style | composite | main thread |
| --- | --- | --- | --- | --- | --- |
| `visibility: hidden` | 236 | 1180x | 1180x | 1180x | ~20 % of a core |
| `opacity: 0` | 239 | 1196x | 1196x | 1196x | ~29 % of a core |
| both | 240 | 1198x | 1198x | 1198x | ~22 % of a core |
| **fully visible** | **22** | **110x** | **110x** | **110x** | **~4 % of a core** |
| `display: none` | 2 | 0x | 0x | 0x | ~0 % |
| no SMIL (control) | 0 | 0x | 0x | 0x | ~0 % |

Invalidation tracking attributes every one of these to the animation:

```
13835x LayoutInvalidationTracking      reason=Style changed  node=path
13830x StyleRecalcInvalidationTracking reason=Attribute      node=path
```

## Expected

SMIL sampling — or at least the style/layout/paint invalidation it causes —
should be skipped for subtrees that are not visible, as it already is for
`display: none`. At minimum, invisible SMIL should not be *less* throttled than
visible SMIL.

## Why this matters in the wild

soundcloud.com leaves a buffering throbber running inside every play button and
hides it with `visibility: hidden; opacity: 0` on `.playableTile__playButton`.
Ten of them on an idle, paused page keep a 240 Hz display's renderer at ~34 % of
a core doing nothing visible. Users have reported the resulting CPU burn for
years without a diagnosis:
brave/brave-browser#54231, Mozilla bug 1057085, salomvary/soundcleod#118.

Firefox 152 has a related but distinct problem: it charges the same for the
hidden animation as for the visible one (it does not have Blink's
visible-animation throttling to make the contrast so stark).
