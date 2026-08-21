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
SVG spinners driven by `<animateTransform>`, each inside a wrapper with
`visibility: hidden; opacity: 0` — exactly what SoundCloud does. No other
script runs on the page. `?off` drops the SMIL elements (control); `?fps` adds a
rAF frame counter.

Measured August 2026 on a 240 Hz panel:

| | Chrome 149 (renderer main thread) | Firefox 152 (whole instance) |
| --- | --- | --- |
| 10 invisible SMIL spinners | 237 render cycles/s, ~16 % of a core | ~23 % of a core |
| same page, SMIL removed | 0/s, ~0 % | ~6 % |

Both engines keep sampling SMIL and running the full rendering lifecycle for
animations that cannot possibly be seen, so this is not a Chrome-only bug.
