# Draft: Chromium bug report

**File at:** <https://issues.chromium.org/issues/new> · Component: `Blink>SVG`
(secondary: `Blink>Animation`) · Type: Bug · Priority suggestion: P2

---

**Title:** SMIL animations in `visibility:hidden` / `opacity:0` subtrees run the
full rendering lifecycle at display refresh rate while producing zero raster
work

**Chrome version:** 151.0.7922.173 (Linux, X11, 240 Hz panel) — current stable.
First measured on 149.0.7827.53; reproduces unchanged on 151.
**Also affects:** every display tested. The hidden animation follows the fastest
*attached* display, not the one the window is on — see the cross-screen tables

## What happens

A SMIL animation (`<animateTransform>` on an SVG `<path>`) that is inside a
subtree hidden with `visibility: hidden` or `opacity: 0` keeps being sampled
every frame. Each sample mutates an attribute, which invalidates style *and*
layout, so Blink runs a full style → layout → paint → composite cycle on **every
vsync** — 240×/s on a 240 Hz display — for content that provably cannot produce
a pixel. `RasterTask` count over these traces is **zero**.

Hiding the animation saves only the raster work — about a third of the total.
The other two thirds, the whole main-thread lifecycle, is charged in full for
output that cannot exist.

`display: none` is handled correctly (the animation is skipped entirely), so the
mechanism to skip non-rendered SMIL already exists — it just doesn't cover
`visibility: hidden` or `opacity: 0`.

## Repro

Attached: `repro-invisible-smil.html` (also at
https://github.com/jandebleser/soundcloud-cpu-fix/blob/main/tools/repro-invisible-smil.html).
It builds 10 SVG spinners with `<animateTransform attributeName="transform"
type="rotate" dur="1s" repeatCount="indefinite">`, each inside a wrapper, and
runs **no other script**. URL flags choose the wrapper style.

1. Open `repro-invisible-smil.html?n=200` (default wrapper:
   `visibility: hidden; opacity: 0`). Watch the tab in Chrome's Task Manager
   (Shift+Esc) — no DevTools needed.
2. Open `repro-invisible-smil.html?n=200&off` — the same page with the SMIL
   elements removed — and compare. Then `?n=200&dnone`.
3. For the breakdown, record a 6 s Performance trace of each and count
   `RecalcStyle` / `Layout` on the renderer main thread against `RasterTask`.
4. `tools/measure-repro.cjs` in the same repo walks every variant over CDP and
   prints the tables below in one run.

## Measurements (6 s trace, renderer main thread, per second)

10 spinners, the number soundcloud.com ships:

| wrapper | frames/s | style/s | layout/s | composite/s | **raster/s** | main thread |
| --- | --- | --- | --- | --- | --- | --- |
| `visibility: hidden` | 240 | 240 | 240 | 240 | **0** | ~16 % of a core |
| `opacity: 0` | 241 | 241 | 241 | 241 | **0** | ~18 % of a core |
| both (what SoundCloud ships) | 240 | 240 | 240 | 240 | **0** | ~20 % of a core |
| fully visible | 234 | 234 | 234 | 234 | 369 | ~30 % of a core |
| `display: none` | 1 | 0 | 0 | 0 | 0 | ~0 % |
| no SMIL (control) | 0 | 0 | 0 | 0 | 0 | ~0 % |

`?n=200` scales the page past the noise floor on a 60 Hz display, where it stops
being vsync-bound and the contrast no longer depends on refresh rate at all:

| wrapper | frames/s | style/s | **raster/s** | main thread |
| --- | --- | --- | --- | --- |
| `visibility: hidden; opacity: 0` | 151 | 151 | **0** | ~67 % of a core |
| `visibility: hidden` | 156 | 156 | **0** | ~65 % of a core |
| `opacity: 0` | 147 | 147 | **0** | ~68 % of a core |
| fully visible | 158 | 158 | 721 | ~70 % of a core |
| `display: none` | 5 | 0 | 0 | ~0 % |
| no SMIL (control) | 0 | 0 | 0 | ~0 % |

The decisive comparison is a hidden row against `display: none` / no-SMIL, not
against the visible row — the visible and hidden cases run the same number of
lifecycle updates, and only the hidden ones produce no pixels for them. DevTools'
FPS meter cannot show this: it counts compositor frames, which are the same
either way.

Invalidation tracking attributes every one of these to the animation. Over the
same 6 s, 10 hidden spinners on a 240 Hz panel — i.e. 10 x 240 x 6 = 14 400
samples, one per animation per vsync:

```
visibility:hidden; opacity:0    14410x StyleRecalcInvalidationTracking reason=Attribute     node=path
                                14410x LayoutInvalidationTracking      reason=Style changed node=path
visibility: hidden              14390x / 14390x   (same two)
opacity: 0                      14450x / 14450x
fully visible                   14030x / 14020x
display: none                       0x /     0x
no SMIL (control)                   0x /     0x
```

Add `INVALIDATIONS=1` to the `measure-repro.cjs` command line to print this.


## The hidden animation follows the fastest attached display, not its own

Same window (700x450 DIP), same Chrome 151 session, moved between monitors.
`WINDOW_POSITION` in `measure-repro.cjs` places it, and every run reports the
screen it actually landed on.

**Mixed refresh rates** — a 240 Hz laptop panel plus two 60 Hz 4K screens:

| window is on | that screen's refresh | **visible** frames/s | **hidden** frames/s | visible CPU | hidden CPU |
| --- | --- | --- | --- | --- | --- |
| DP-1 3840x2160 | 60 Hz | 60 | **241** | ~7 % | ~14 % |
| DP-1-0 3840x2160 | 60 Hz | 59 | **241** | ~7 % | ~15 % |
| eDP-1 1920x1080 | 240 Hz | 76 | **241** | ~8 % | ~15 % |

The visible animation is paced to the monitor the window is on — 60 fps on a
60 Hz panel. The hidden one runs at ~240/s on **every** screen, including the
60 Hz ones. On a 60 Hz monitor that is 4x the lifecycle updates and about twice
the main-thread time of the *same animation left visible*.

**Every panel set to 60 Hz** (`xrandr --output eDP-1 --rate 60`), nothing else
changed:

| window is on | that screen's refresh | **visible** frames/s | **hidden** frames/s | visible CPU | hidden CPU |
| --- | --- | --- | --- | --- | --- |
| DP-1 3840x2160 | 60 Hz | 60 | **60** | ~7 % | ~4 % |
| eDP-1 1920x1080 | 60 Hz | 59 | **60** | ~6 % | ~4 % |

Dropping the *unused* 240 Hz panel to 60 Hz takes the hidden animation from
241/s to 60/s on a monitor whose refresh rate never changed. So the invisible
animation is driven at the maximum refresh rate of any attached display, rather
than the rate of the display presenting it.

`RasterTask` is 0 for every hidden row in both tables.

Two defects, then, and the first stands on its own:

1. SMIL in a `visibility:hidden` / `opacity:0` subtree is sampled at all, running
   a full style -> layout -> paint -> composite cycle that provably cannot
   produce a pixel. Reproduces on any setup — 60 cycles/s and ~4 % of a core even
   with every display at 60 Hz, against 0 for `display: none`.
2. That sampling is additionally paced by the fastest attached display instead of
   the presenting one, which multiplies the cost by up to 4x here and is what
   makes hiding a spinner more expensive than showing it.

## Expected

SMIL sampling — or at least the style/layout/paint invalidation it causes —
should be skipped for subtrees that cannot paint anything visible, as it already
is for `display: none`.

Failing that, an invisible animation should at minimum be paced no faster than a
visible one on the same display. Today it is paced faster — 241/s against 60/s on
a 60 Hz monitor — because it follows the fastest attached display rather than the
one presenting it.

## Why this matters in the wild

soundcloud.com leaves a buffering throbber running inside every play button and
hides it with `visibility: hidden; opacity: 0` on `.playableTile__playButton`.
Fifteen of them on an idle, paused page keep a 240 Hz display's renderer main
thread at ~51 % of a core doing nothing visible. Users have reported the resulting CPU burn for
years without a diagnosis:
brave/brave-browser#54231, Mozilla bug 1057085, salomvary/soundcleod#118.

Firefox 152 has the same omission, measured separately.
