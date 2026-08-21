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
   231 frames/s
  layout     1384x   532ms
  ...
  => main thread ~31% of a core
  who dirties style/layout:
     13835x LayoutInvalidationTracking reason=Style changed node=path

--- WITH sc-throttle (6s) ---
     0 frames/s
  => main thread ~4% of a core
```

A high, near-constant `frames/s` matching your monitor's refresh rate, with full
`layout` / `style` / `composite` counts every frame, is the runaway
render-loop signature. The `who dirties style/layout` block names the culprit.

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

Chrome 149, Linux, 240 Hz panel — renderer main-thread lifecycle events over 5 s:

| wrapper | frames/s | layout+style+composite | main thread |
| --- | --- | --- | --- |
| `visibility: hidden` | 236 | 1180x | ~20 % of a core |
| `opacity: 0` | 239 | 1196x | ~29 % of a core |
| both (what SoundCloud ships) | 240 | 1198x | ~22 % of a core |
| **fully visible** | **22** | **110x** | **~4 % of a core** |
| `display: none` | 2 | 0x | ~0 % |
| no SMIL (control) | 0 | 0x | ~0 % |

The perverse part: Blink throttles the animation to ~22 fps when it is
**visible**, but runs it at the full display refresh rate — 240 fps — when it is
invisible, so hiding the spinner makes it **5–7× more expensive** than showing
it. `RasterTask` count in the invisible cases is **zero**: the full
style → layout → paint → composite lifecycle runs 240x/s and provably produces
no pixels. `display: none` is correctly skipped, so the machinery to skip this
already exists.

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
