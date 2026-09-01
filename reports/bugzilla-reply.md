# Draft: reply to comment #3 on Mozilla bug 2065454

**Post at:** <https://bugzilla.mozilla.org/show_bug.cgi?id=2065454>, in reply to
Robert Longson's `<use>` objection (comment #3, 2026-08-21).

**Context:** bug is UNCONFIRMED, `Core::SVG`, unassigned, priority and severity
unset. emilio@crisal.io CC'd himself on 2026-08-30. Comment #3 is the only thing
blocking confirmation and has been unanswered since 21 August.

---

You're right, and I should have addressed it — `<use>` breaks the naive version
of what I asked for.

The asymmetry, as I understand it: `<use>` deep-clones the referenced element
into a shadow tree, and the clone's inheritable properties resolve at the `<use>`
site rather than at the original's position in the tree. So hiding that is
imposed by an *ancestor* of the animated element — inherited `visibility:hidden`,
or `opacity: 0` on a wrapper — does not hide the instance, while hiding that sits
*on the element itself* travels with the clone. Which is exactly why
`display: none` was safe for bug 1737881: `display` isn't inherited, so the only
case that matters is `display: none` on the referenced element, and that clones.
`visibility: hidden` on a wrapper is precisely the case that doesn't.

So a "skip SMIL in invisible subtrees" rule written against computed style would
freeze visible instances. That's a correctness bug, not a perf trade-off — point
taken.

What I'd ask for instead is the narrower condition: skip only when the animated
element is not reachable from any `<use>` — neither it nor an ancestor is a
`<use>` target. In that case there is no second rendering of the content, so none
of the visibility semantics above need deciding.

For what this bug is actually about:

- the attached repro contains no `<use>` elements at all;
- soundcloud.com/discover, the real-world case, has zero `<use>` elements in the
  whole document alongside its SMIL spinners (10 in the page I sampled), and the
  animated `<path>` elements carry no `id`, so they cannot be `<use>` targets.

So the conservative gate recovers the whole ~41 points of a core reported here
without touching the case you're describing. Even the crudest form of it — "this
document contains no `<use>`" — would do it, though I'd have guessed the
per-element mapping already exists somewhere, since clones have to be kept in
sync with their source. Is that a shape you'd consider, or does the reference
tracking not reach the animation scheduling?

One correction to comment #0 while I'm here. The sentence about Chrome throttling
the *visible* animation to ~22 fps was wrong — a measurement error in my own
tooling, which picked the busiest thread in the trace and so read raster threads
rather than the main thread whenever the animation was visible. I've retracted it
on the Chromium side (crbug.com/549870892). It doesn't affect anything above: the
Firefox numbers are whole-process CPU on a clean profile, measured a different
way, and they still reproduce on 152.0.4.
