# ADR-0017: Anchored placement resolves once into canonical placement facts

- Status: Accepted — the anchored placement command shipped in
  [spec #132](https://github.com/kenneth-liao/ply/issues/132) ticket #138.

## Decision

Anchored placement is a **one-shot command-boundary normalization** with the
same shape as `--resize-to` under ADR-0016: `ply layer edit --anchor <h>[,<v>]
--x <tx> --y <ty>` resolves once against the Layer's measured painted ink and
publishes **plain canonical placement (x, y)** through the ordinary edit
lifecycle. Nothing about the anchor is persisted. Placement keeps exactly one
canonical home (DEC-002, DEC-003) — there are no anchor revision facts, no
schema change, and no alternate per-Composition placement state.

The alternative — persisting anchor+target as canonical revision facts that
paint and inspect re-resolve — was rejected for two reasons:

1. It creates a second representation of placement (x/y derived from
   anchor+target), a second home for the same fact that every reader
   (paint, measure, inspect, replay) would have to re-resolve identically.
2. The anchor box chosen below is the **painted ink**, which is quantized to
   the rendering environment's pixel grid and font rendering. Resolving it at
   paint time would make placement environment-dependent, breaking
   deterministic local composition and pinned replay reproducibility
   (ADR-0013). Resolving once and writing x/y bakes the result into the
   immutable revision, so history stays deterministic by construction.

Consequences of the one-shot shape, documented in help and README:

- A subsequent content or transform edit keeps the resolved x/y literally —
  it never silently re-resolves. Re-anchoring after a geometry change is an
  explicit second edit.
- The audit trail is the edit report (`anchored: {anchor, target, placement,
  painted, contexts}`), not the stored revision, which stays a plain
  placement revision indistinguishable from any other.
- Sharing, forks, cross-Project import, and pinned Render history preserve
  anchored placement verbatim because it IS an ordinary placement fact.

## The anchor box is the painted ink box

Anchored placement resolves against the Layer's **visible painted ink**
(alpha > 0 for image content, tight glyph ink for text — the unclipped
`painted` extents of the #137 measure authority, DEC-004), never the layout
content box:

- **Transparent padding does not count.** A padded image's visible subject
  lands at the requested target while its layout box extends into the padding
  side; a centered headline centers its glyph ink. This is the caller-visible
  meaning of "center this" — the alternative (layout box) would silently
  offset visible content by its own padding, exactly the confusion US-002
  forbids treating as subject content.
- A Layer with **no visible ink** refuses (exit 1, live state unchanged)
  instead of silently falling back to the layout box — no second anchor-box
  definition.
- Resolution runs against the Layer's **current** transform: the rotated/
  scaled/reflected ink box is what gets anchored. Anchor cannot combine with
  `--resize`, `--rotate`, `--flip`, or content replacement in one edit — the
  reference ink would be ambiguous (same precedent as resize + content
  replacement). `--opacity` combines freely: opacity scales alpha values,
  never the ink support.
- Resolution is accurate to the ink capture's pixel grid (~1px); the written
  x/y is then canonical and environment-independent.

## Resolution contexts and divergence

Placement is one shared revision fact (DEC-002, ADR-0013), but a text Layer's
ink depends on the referring Composition's canvas width (pre-wrap
shrink-to-fit). Resolution therefore measures the Layer in **every referring
Composition** and refuses — naming the affected compositions and their count,
following the blast-radius convention — when the resolved placements disagree.
Unreferenced Layers resolve **standalone on an unwrapped line** (the
standalone measurement places the Layer at (0, 0) on a canvas bounded by the
ink-capture window, so the painted box IS the ink's offset from the placement
point); a fork resolves in its target Composition, whose use is about to own
the Layer.

## Consequences

- The paint path, revision schema, revision hash, and replay machinery are
  untouched: anchored placement introduces no new stored representation, so
  #139/#140 (effects) cannot retroactively move a placement — they own only
  the painted-extents-with-effects measurement contract.
- Multi-Composition text divergence is a refusal, never a silent pick: an
  agent hitting it forks per Composition or gives explicit x/y.
- Effects that extend painted bounds (shadow, outline) do not affect already
  resolved placements; whether anchored resolution should account for
  effect-extended ink remains #139/#140's contract to define.