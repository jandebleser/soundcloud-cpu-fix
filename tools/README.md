# tools

## profile-soundcloud.cjs

Reproduces the diagnosis: launches an isolated debug Chrome (throwaway
`--user-data-dir`, own debug port — your real profile is untouched), opens
SoundCloud, and prints the Blink rendering-lifecycle breakdown over a 5s
timeline trace. It then blocks ad/tracker scripts via the DevTools Protocol and
re-traces, so you can see how much render churn they drive.

```sh
# needs a Chrome binary and the `ws` node module reachable on NODE_PATH
CHROME=/opt/google/chrome/chrome \
NODE_PATH=$(npm root -g) \
  node tools/profile-soundcloud.cjs
```

Expected shape of output (numbers vary with page content):

```
--- BASELINE (all scripts) (5s) ---
  639x    347ms  LocalFrameView::performLayout
  ...
   rAF fps = 128
--- AD/TRACKERS BLOCKED (5s) ---
  275x    285ms  LocalFrameView::performLayout
  ...
   rAF fps = 55
```

A high, near-constant `rAF fps` with full `performLayout` / `recalcStyle` /
`PaintArtifactCompositor::Update` counts each frame is the uncapped
render-loop signature described in the top-level README.
