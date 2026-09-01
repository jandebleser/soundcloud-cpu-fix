# Draft: comment on brave/brave-browser#54231

**Post at:** <https://github.com/brave/brave-browser/issues/54231>
("High CPU usage on soundcloud.com when playing and tab is active" — open since
April 2026, no diagnosis yet)

---

Diagnosed this on Chrome 151.0.7922.173 / Linux (first measured on 149; it
reproduces unchanged on current stable). It isn't a Brave or Chromium regression,
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
   191 frames/s
  layout     1145x   826ms
  style      1145x  1065ms
  composite  1144x   949ms
  => main thread ~51% of a core

  17175x StyleRecalcInvalidationTracking reason=Attribute      node=path
  17175x LayoutInvalidationTracking      reason=Style changed  node=path
```

Two things make it worse than it sounds:

- **Your fastest attached monitor sets the cost, on every monitor.** Same window
  on a 240 Hz laptop panel and on two 60 Hz 4K screens: ~240 render cycles per
  second on all three, with SoundCloud at ~51 % of a core on the fast panel
  against ~46 % on a 60 Hz one. Moving the window buys nothing, because the
  hidden animations follow the fastest *attached* display rather than the one
  showing them. A visible animation is paced correctly (60 fps there), so hiding
  the spinner costs ~4× the frames of showing it. Dropping the fast panel to
  60 Hz — `xrandr --output eDP-1 --rate 60`, even with the lid shut — is a
  genuine 4× win: in a standalone repro it took the hidden animation from
  241 cycles/s to 60.
- **There is no JS in the hot path.** `FunctionCall` is ~50 ms per 6 s, which is
  why a JS CPU profile shows ~59 % `(program)` and tells you nothing. You need a
  timeline trace with invalidation tracking to see it.

Confirmation: running `document.querySelectorAll('svg').forEach(s =>
s.pauseAnimations())` in the console takes the page from 191 fps to **0 fps** and
the main thread to ~0 %. That's a one-liner you can paste right now to check it
on your own machine.

**Workaround.** I published the fix as a small content script — it pauses every
SMIL-bearing SVG timeline and steps it itself at 30 fps, but only for spinners
that are on screen *and* actually visible, so the hidden ones stay frozen and a
genuinely buffering spinner still spins:
https://github.com/jandebleser/soundcloud-cpu-fix
(MV3 extension or Tampermonkey userscript). On the idle discover page it takes
the tab's main thread from ~51 % of a core to ~5 %.

**Upstream.** The site bug is SoundCloud's — they should stop the animations
instead of hiding them; I've reported it. But the engines are complicit, and
that part is fixable in Chromium: in a standalone repro, 10 SMIL spinners hidden
with `visibility: hidden` / `opacity: 0` run the full style → layout → paint →
composite lifecycle once per vsync — 240×/s here — with a `RasterTask` count of
**zero**. ~16–20 % of a core to produce no pixels. `display: none` is correctly
skipped, so the machinery exists; it just doesn't cover `visibility: hidden` or
`opacity: 0`. Filed against `Blink>SVG` with the repro; Firefox 152 has the same
omission and I've filed that too.
