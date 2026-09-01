# Draft: reply to comment #2 on the Chromium bug

**Post at:** the Chromium issue, in reply to dg...@google.com's reproduction attempt.

**Attachments — all ready in this directory:**
- `about-version.txt` — `chrome://version/?show-variations-cmd`, real profile,
  confirmed 151.0.7922.173 with the `--force-fieldtrials=` block present
- `gpu-internals.txt` — the full `chrome://gpu` dump
- `screenshots/taskmgr-n200-hidden.png` — `?n=200`, Task Manager row at 122 % CPU
- `screenshots/taskmgr-n200-off.png` — `?n=200&off`, same tab, same PID, 0.0 % CPU
- `screenshots/taskmgr-n200-dnone.png` — `?n=200&dnone`, 200 live SMIL
  animations under `display: none`, 0.5 % CPU

---

Thanks for running this — and you're right on the point you tested. I need to
correct part of my own report before answering the rest.

## Correcting one claim

I wrote that Blink throttles the *visible* animation to ~22 fps while running the
*hidden* one at the full refresh rate, making hidden 5–7× more expensive than
visible. **The ~22 fps figure was a measurement error on my side** — my tooling
picked "the busiest thread in the trace" as the renderer main thread, and when
the animation is visible the raster threads outwork it, so the numbers came from
the wrong thread. Apologies; that number should never have been in the report.

The comparison it was pointing at turns out to be real, but for a different
reason and only on a mixed-refresh-rate setup — details in "One more thing"
below. On a single-monitor 60 Hz machine, which I suspect is what you tested,
visible and hidden run at the same rate and **your observation is correct**.

None of that touches the defect itself, which is what the rest of this reply is
about.

## The bug that's left

It is not a frame-rate difference between visible and hidden — it's
that the hidden case does the work **at all**. The comparison that shows it is
hidden vs `?off` / `?dnone`, not hidden vs `?visible`.

**Chrome 151.0.7922.173.** I took the update suggestion and re-ran the entire
matrix on current stable with a fresh profile — every number in this reply is
from 151, and nothing about the behaviour changed from 149. Window on the 240 Hz
panel, 10 spinners, 6 s trace, renderer main thread:

| wrapper | frames/s | style/s | layout/s | composite/s | **raster/s** | main thread |
| --- | --- | --- | --- | --- | --- | --- |
| `visibility:hidden; opacity:0` (what soundcloud.com ships) | 240 | 240 | 240 | 240 | **0** | ~20 % of a core |
| `visibility: hidden` | 240 | 240 | 240 | 240 | **0** | ~16 % of a core |
| `opacity: 0` | 241 | 241 | 241 | 241 | **0** | ~18 % of a core |
| fully visible | 234 | 234 | 234 | 234 | 369 | ~30 % of a core |
| `display: none` | 1 | 0 | 0 | 0 | 0 | ~0 % |
| no SMIL (control) | 0 | 0 | 0 | 0 | 0 | ~0 % |

The hidden rows run a complete style → layout → paint → composite cycle on every
vsync with **`RasterTask` count of zero** — the lifecycle runs to completion and
provably cannot produce a pixel. That is ~16–20 % of a core, permanently, for
output that does not exist.

Invalidation tracking names the source, one sample per animation per vsync
(10 x 240 x 6 s = 14 400):

```
visibility:hidden; opacity:0    14410x StyleRecalcInvalidationTracking reason=Attribute     node=path
                                14410x LayoutInvalidationTracking      reason=Style changed node=path
display: none                       0x /     0x
no SMIL (control)                   0x /     0x
```

`display: none` and the no-SMIL control are flat zero, which is the useful part:
the machinery to skip SMIL sampling for non-rendered content already exists, it
just doesn't cover `visibility: hidden` or `opacity: 0`.

## One more thing — and it may explain your flat result

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

## Why the repro looked flat on your machine

Three things, and I should have written the steps better:

1. **The FPS meter can't show this.** "Frame Rendering Stats" counts compositor
   frames. On a single-refresh-rate machine hidden and visible both produce them
   at that rate, and the meter cannot distinguish 60 frames that rasterised
   something from 60 frames that rasterised nothing. The signal is on the
   renderer main thread: `RecalcStyle` / `Layout` counts, against a `RasterTask`
   count of zero.
2. **Only one state was traced.** Comment #2 records the default wrapper state
   only, so there was nothing to compare it against. The decisive A/B is default
   vs `?off` (identical page, SMIL elements removed) and vs `?dnone`.
3. **Refresh rate, and this is the big one.** If you tested on a single 60 Hz
   display, the visible and hidden cases both run at 60 fps, so the
   frame rates genuinely do not differ and the FPS meter is right. My 240 Hz
   laptop panel is what made them differ here, and it does so even when the
   window is on a 60 Hz monitor (the tables above). What remains on your machine
   is
   60 cycles/s and ~4 % of a core spent on animations with `RasterTask` at zero,
   against 0 for `display: none`. That's the defect; the frame-rate gap is an
   amplifier my hardware happened to expose.

## Simplest way to see it — no tracing, no DevTools

I've added an `?n=` parameter to the repro so it can be scaled past the noise
floor on any display. Open these two URLs in turn and watch the tab's row in
Chrome's Task Manager (Shift+Esc):

- `repro-invisible-smil.html?n=200` — 200 spinners, all invisible
- `repro-invisible-smil.html?n=200&off` — the same page, SMIL elements removed
- `repro-invisible-smil.html?n=200&dnone` — the same 200 animations, but under
  `display: none`

The page names its own state in the document title, so the Task Manager row
identifies which variant it is measuring. Attached, all three from the same
renderer process (PID 864043), window on a 60 Hz monitor:

| Task Manager row | CPU | memory footprint |
| --- | --- | --- |
| `Tab: SMIL repro: 200 x hidden` | **122.0** | 1,743,684K |
| `Tab: SMIL repro: 200 x dnone` | 0.5 | 37,172K |
| `Tab: SMIL repro: 200 x no SMIL` | 0.0 | 32,532K |

The `dnone` row is the one I would point at: the same 200 SMIL animations, still
in the DOM, still running, cost 0.5 % of a core when the subtree is
`display: none` and 122 % when it is `visibility: hidden; opacity: 0`. Nothing
is on screen in either case.

(The memory column moves with it — but it plateaus around 1.8 GB within ten
seconds and stays flat over two minutes, so it reads as a fixed per-element cost
of keeping 200 animated subtrees laid out, not a leak. Noting it only because it
is visible in the screenshots; the CPU column is the report.)

Same machine, Chrome 151, 6 s trace, 200 spinners:

| wrapper | frames/s | style/s | layout/s | composite/s | **raster/s** | main thread |
| --- | --- | --- | --- | --- | --- | --- |
| `visibility:hidden; opacity:0` | 151 | 151 | 151 | 151 | **0** | ~67 % of a core |
| `visibility: hidden` | 156 | 156 | 156 | 156 | **0** | ~65 % of a core |
| `opacity: 0` | 147 | 147 | 147 | 147 | **0** | ~68 % of a core |
| fully visible | 158 | 158 | 158 | 158 | 721 | ~70 % of a core |
| `display: none` | 5 | 0 | 0 | 0 | 0 | ~0 % |
| no SMIL (control) | 0 | 0 | 0 | 0 | 0 | ~0 % |

At this size it is no longer vsync-bound, so it doesn't depend on your refresh
rate: ~67 % of a core, zero raster work, nothing on screen. `?dnone` and `?off`
sit at 0 %.

## Scripted version

If it's easier to run than to click, `tools/measure-repro.cjs` in the repo
launches an isolated Chrome over CDP, walks every variant, and prints the table
above:

```sh
CHROME=/opt/google/chrome/chrome NODE_PATH=$(npm root -g) \
  node tools/measure-repro.cjs 6     # SPINNERS=200 to scale up, INVALIDATIONS=1 for the tally
```

Repro and script: https://github.com/jandebleser/soundcloud-cpu-fix/tree/main/tools

## Real-world impact

soundcloud.com leaves a buffering throbber running inside every play button and
hides it with `visibility: hidden; opacity: 0` on `.playableTile__playButton` —
15 per page as of today, never stopped. On an idle, paused discover page with
the player stopped, Chrome 151 runs 191 full lifecycle updates per second for
~51 % of a core; freezing just those 15 SMIL timelines takes it to 0 updates and
~5 %. Users have reported the CPU burn without a
diagnosis for years: brave/brave-browser#54231, Mozilla bug 1057085,
salomvary/soundcleod#118.

## Environment

Chrome 151.0.7922.173 (current stable — I updated from 149.0.7827.53, the build
you tested on, and the behaviour is identical). Linux, X11, Ubuntu 24.04.
`chrome://version/?show-variations-cmd` and the full `chrome://gpu` dump are
attached, plus Task Manager screenshots of `?n=200`, `?n=200&off` and
`?n=200&dnone`.

The attached GPU report shows the mixed-refresh setup the pacing tables above
depend on — three displays, all at `scale=2`:

```
Display[21691973337919809] bounds=[3840,0 960x540]   internal   Refresh Rate in Hz: 240
Display[8564274688388418]  bounds=[1920,0 1920x1080] external   Refresh Rate in Hz: 59.99662399291992
Display[4]                 bounds=[0,0 1920x1080]    external   Refresh Rate in Hz: 59.99662399291992
```

So Chrome's own view agrees: the window sits on a 60 Hz display while the hidden
animation runs at the 240 Hz internal panel's rate. Unless a table says
otherwise, measurements are with that set attached and the window on the 240 Hz
panel.

Also from the report, in case it's relevant: dual-GPU Optimus laptop, Mesa
25.2.8, `VENDOR=0x8086 DEVICE=0x3e9b` active with `VENDOR=0x10de DEVICE=0x1f10`
present, and `Direct Rendering Display Compositor: Disabled`.
