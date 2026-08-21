# Draft: comment on brave/brave-browser#54231

**Post at:** <https://github.com/brave/brave-browser/issues/54231>
("High CPU usage on soundcloud.com when playing and tab is active" — open since
April 2026, no diagnosis yet)

---

Diagnosed this on Chrome 149 / Linux. It isn't a Brave or Chromium regression,
and it isn't the audio — it happens with the player **paused** and no audio
stream at all.

**Root cause:** every play button on a SoundCloud page carries a buffering
throbber — an SVG `<path>` driven by `<animateTransform dur="1s">`. SoundCloud
never stops them; it only hides them, with `visibility: hidden` and `opacity: 0`
on `.playableTile__playButton`. SMIL animations keep being sampled while hidden,
and each sample mutates an attribute, which invalidates style *and* layout. So
Blink runs a full style → layout → paint → composite cycle **on every vsync**
for ~10 animations nobody can see.

A DevTools trace with invalidation tracking, on the idle, paused discover page
(6 s):

```
   231 frames/s
  layout     1384x   532ms
  style      1383x   666ms
  composite  1384x   615ms
  => main thread ~31% of a core

  13835x LayoutInvalidationTracking      reason=Style changed  node=path
  13830x StyleRecalcInvalidationTracking reason=Attribute      node=path
```

Two things make it worse than it sounds:

- **It scales with your monitor's refresh rate.** On a 240 Hz panel that's 230+
  full render cycles per second — 4× the cost of the same page on a 60 Hz
  monitor. Moving the window to a 60 Hz display is an immediate 4× win.
- **There is no JS in the hot path.** `FunctionCall` is ~50 ms per 6 s, which is
  why a JS CPU profile shows ~59 % `(program)` and tells you nothing. You need a
  timeline trace with invalidation tracking to see it.

Confirmation: running `document.querySelectorAll('svg').forEach(s =>
s.pauseAnimations())` in the console takes the page from 226 fps to **0 fps** and
the main thread to ~0 %. That's a one-liner you can paste right now to check it
on your own machine.

**Workaround.** I published the fix as a small content script — it pauses every
SMIL-bearing SVG timeline and steps it itself at 30 fps, but only for spinners
that are on screen *and* actually visible, so the hidden ones stay frozen and a
genuinely buffering spinner still spins:
https://github.com/<user>/soundcloud-cpu-fix
(MV3 extension or Tampermonkey userscript). On the idle discover page it takes
the tab's main thread from ~34 % of a core to ~4 %.

**Upstream.** The site bug is SoundCloud's — they should stop the animations
instead of hiding them; I've reported it. But the engines are complicit, and
that part is fixable in Chromium: in a standalone repro, Blink throttles a
*visible* SMIL spinner to ~22 fps (~4 % of a core) while running the same
spinner at the full 240 fps refresh when it's hidden (~20–29 %). Hiding it makes
it 5–7× *more* expensive than showing it, and `RasterTask` count is zero — the
whole lifecycle runs to produce no pixels. `display: none` is correctly skipped,
so the machinery exists. Filed against `Blink>SVG` with the repro; Firefox 152
has a related problem (it charges the same for hidden as for visible) and I've
filed that too.
