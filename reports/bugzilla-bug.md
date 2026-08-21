# Draft: Mozilla Bugzilla report

**File at:** <https://bugzilla.mozilla.org/enter_bug.cgi?product=Core&component=SVG>
Product: `Core` · Component: `SVG` · Type: defect
**See also:** bug 1754810 (SMIL kept ticking after animated nodes were removed),
bug 1737881 (animations in `display:none` subtrees)

---

**Title:** SMIL animations in `visibility:hidden` / `opacity:0` subtrees are
still sampled every tick, costing as much as visible ones

**Firefox version:** 152.0.4 (Linux, snap, 240 Hz panel)

## What happens

A SMIL animation inside a subtree hidden with `visibility: hidden` and/or
`opacity: 0` continues to be sampled and to drive the refresh driver, at the
same cost as the identical animation left visible. Nothing on screen changes.

This is the same family as bug 1754810 (controller kept a refresh observer after
the animated nodes were gone) and bug 1737881 (`display:none` subtrees), but for
subtrees that are laid out yet cannot paint anything visible. `display: none`
here is *mostly* skipped, but not entirely — it still costs ~5 points of a core
over the control, which may itself be worth a look.

## Repro

Attached: `repro-invisible-smil.html`. 10 SVG spinners with
`<animateTransform attributeName="transform" type="rotate" dur="1s"
repeatCount="indefinite">`, each inside a wrapper; **no other script runs**.
URL flags choose the wrapper style: default `visibility: hidden; opacity: 0`,
plus `?visible`, `?vishidden`, `?opacity0`, `?dnone`, `?off` (SMIL removed).

1. Launch a clean profile on the page: `firefox --no-remote --new-instance --profile <dir> <file-url>`
2. Let it settle ~15 s, then sample the CPU of the Firefox process tree for 6 s.
3. Repeat for each URL flag.

## Measurements (whole-instance CPU over 6 s, clean profile, nothing else loaded)

| wrapper | CPU |
| --- | --- |
| fully visible | 48 % of a core |
| `visibility: hidden; opacity: 0` | 47 % of a core |
| `display: none` | 11 % of a core |
| no SMIL (control) | 6 % of a core |

So ~41 points of a core are spent on animations that cannot be seen — the same
as spending them on animations that can.

For contrast, Chrome 149 on the same page throttles the *visible* animation to
~22 fps (~4 % of a core, main thread) but runs the *hidden* one at the full
240 fps refresh (~20–29 %). Different bug shape, same underlying omission: neither
engine skips SMIL for content that cannot be seen.

## Expected

Sampling should be skipped, and the refresh driver left alone, for SMIL in
subtrees that cannot produce visible output — extending what bug 1737881 did for
`display: none`.

## Why this matters in the wild

soundcloud.com leaves a buffering throbber running inside every play button,
hidden with `visibility: hidden; opacity: 0`. Long-standing user reports of
SoundCloud CPU burn: bug 1057085, brave/brave-browser#54231,
salomvary/soundcleod#118.
