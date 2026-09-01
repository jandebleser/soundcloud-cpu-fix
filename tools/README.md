# tools

Both scripts launch an isolated debug Chrome (throwaway `--user-data-dir`, own
debug port — your real profile is untouched) and drive it over the DevTools
Protocol. Both need a Chrome binary and the `ws` node module on `NODE_PATH`.

## diagnose-render-loop.cjs

The one to reach for. Traces 6 s **with invalidation tracking on**, so every
style/layout invalidation is attributed to a reason and a node — that's what
identified the SMIL spinners. Then it inventories the page's SMIL elements and
A/Bs the page against `../sc-throttle/throttle.js` injected at document start.

```sh
CHROME=/opt/google/chrome/chrome NODE_PATH=$(npm root -g) \
  node tools/diagnose-render-loop.cjs [url]     # default: /discover
```

Expected shape:

```
=== SMIL inventory ===
{ svgs: 75, smil: 10, kinds: [ '10x animateTransform attributeName=transform dur=1s on=path' ] }

--- BASELINE (6s) ---
   191 frames/s
  layout     1145x   826ms
  ...
  => main thread ~51% of a core
  who dirties style/layout:
     17175x LayoutInvalidationTracking reason=Style changed node=path

--- WITH sc-throttle (6s) ---
     0 frames/s
  => main thread ~4% of a core
```

A high, near-constant `frames/s` matching your monitor's refresh rate, with full
`layout` / `style` / `composite` counts every frame, is the runaway
render-loop signature. The `who dirties style/layout` block names the culprit.

## measure-repro.cjs

Runs `repro-invisible-smil.html` through every wrapper variant in one isolated
Chrome and prints the cost of each as a table — the thing to hand a browser
vendor instead of asking them to eyeball an FPS meter.

```sh
CHROME=/opt/google/chrome/chrome NODE_PATH=$(npm root -g) \
  node tools/measure-repro.cjs [seconds]      # SPINNERS=200 to scale the page up
```

`WINDOW_POSITION=x,y` and `WINDOW_SIZE=w,h` (both in **DIP**, not pixels — Chrome
multiplies by the device scale factor) put the window on a chosen monitor. Every
run prints the screen it actually landed on, because the window manager will
shove an overflowing window back on-screen and silently straddle two displays.
Which monitor it lands on matters: a hidden SMIL animation is paced by the
fastest *attached* display, not the one presenting it, so the same window costs
~240 cycles/s on a 60 Hz monitor while a 240 Hz panel is plugged in — and 60
cycles/s once that panel is dropped to 60 Hz.

The FPS meter is the wrong instrument for this bug twice over: it counts
compositor frames rather than main-thread lifecycle work, and both the hidden and
the visible variants produce frames at the refresh rate. What separates them is
the `raster/s` column.

## profile-soundcloud.cjs

The original 2026-06 diagnosis: a plain Blink-lifecycle breakdown plus an
ad/tracker A/B (blocks `cadmus`, `aditude`, `dwt.soundcloud`, comscore … over
CDP and re-traces). Useful for quantifying how much of the JS and compositing
cost comes from ad and analytics scripts.

```sh
CHROME=/opt/google/chrome/chrome NODE_PATH=$(npm root -g) \
  node tools/profile-soundcloud.cjs
```

## repro-invisible-smil.html

A minimal, standalone reduction of the bug for browser-vendor bug reports: 10
SVG spinners driven by `<animateTransform dur="1s">`, each inside a wrapper that
hides them — exactly what SoundCloud does. **No other script runs on the page.**
URL flags pick the wrapper: default is `visibility: hidden; opacity: 0` (what
soundcloud.com ships), plus `?vishidden`, `?opacity0`, `?dnone`, `?visible`, and
`?off` (SMIL elements removed — the control). `?fps` adds a rAF frame counter.

`?n=<count>` scales the spinner count (default 10, what SoundCloud ships) — use
`?n=200` on a 60 Hz display, where 10 spinners cost a quarter of what they cost
on a 240 Hz panel and disappear into the noise.

Chrome 151.0.7922.173, Linux, 240 Hz panel — renderer main-thread events per
second over 6 s, via `measure-repro.cjs`:

| wrapper | frames/s | style=layout=composite /s | **raster/s** | main thread |
| --- | --- | --- | --- | --- |
| `visibility: hidden` | 240 | 240 | **0** | ~16 % of a core |
| `opacity: 0` | 241 | 241 | **0** | ~18 % of a core |
| both (what SoundCloud ships) | 240 | 240 | **0** | ~20 % of a core |
| fully visible | 234 | 234 | 369 | ~30 % of a core |
| `display: none` | 1 | 0 | 0 | ~0 % |
| no SMIL (control) | 0 | 0 | 0 | ~0 % |

The point is the **raster** column, not a comparison against the visible row.
Hidden and visible run the same number of lifecycle updates — roughly one per
vsync — but in the hidden cases `RasterTask` count is **zero**: the full
style → layout → paint → composite lifecycle runs 240x/s and provably produces
no pixels, for ~16–20 % of a core. Hiding the spinner saves only the raster third of
the cost. `display: none` is correctly skipped, so the machinery to skip this
already exists.

At `?n=200` the page stops being vsync-bound, so the result no longer depends on
refresh rate: ~65–68 % of a core with **zero** raster work in every hidden
variant, against 0 % for `?dnone` and `?off`.

An earlier version of this table claimed Blink throttled the *visible* animation
to ~22 fps, making hidden 5–7× more expensive than visible. That does not
reproduce under a controlled same-session A/B and has been withdrawn — see
`../reports/chromium-bug-reply.md`.

Firefox 152, same page — whole-instance CPU over 6 s (not comparable in absolute
terms to the Chrome column above, which counts main-thread lifecycle work only;
compare within a column):

| wrapper | CPU |
| --- | --- |
| fully visible | 48 % of a core |
| `visibility: hidden; opacity: 0` | 47 % of a core |
| `display: none` | 11 % of a core |
| no SMIL (control) | 6 % of a core |

Gecko charges the same for an invisible animation as for a visible one, and
doesn't fully skip `display: none` either. So neither engine skips SMIL sampling
for content that cannot be seen — though the site is what leaves the animations
running.
