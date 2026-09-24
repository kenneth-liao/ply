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

## Amendment: Text layout is position-independent (spec #285 / #287)

- **Position-independent layout (DEC-001):** The premise above that "a text
  Layer's ink depends on the referring Composition's canvas width (pre-wrap
  shrink-to-fit)" was amended in spec #285 ticket #287. Unwrapped text now lays
  out at its natural width (`white-space: pre`, `width: max-content`) and wraps
  only at explicit line breaks (`\n`). Text layout no longer depends on where
  the Layer is placed or on the canvas boundaries.
- **Stored layout rule & pre-change retention (DEC-001, DEC-006):** Pre-change
  text Layer revisions keep their legacy canvas-bounded layout
  (`white-space: pre-wrap`) so every retained Render replays byte-identically
  (TEST-003). This is achieved via an optional `layoutRule?: "natural"` fact on
  `LayerTextRevision`.
  - Stored revisions lacking `layoutRule` are normalized at the single ingestion
    boundary (`readLayerInternalFull`) to `layoutRule: "legacy"`.
  - New text revisions created via `ply composition add` or `ply layer edit`
    explicitly write `layoutRule: "natural"`.
  - A fork is an edit (it publishes a new Layer identity and a new revision
    through `buildEditedRevision`), so forked text revisions write
    `layoutRule: "natural"` like any other `layer edit`, migrating pre-change
    revisions to natural layout. Only cross-Composition and cross-Project import
    copies (`buildCopiedRevision`) carry the source revision's `layoutRule`
    unchanged (absent stays absent) so copies of pre-change revisions render
    identically to their source.
  - An edit or fork of a pre-change text revision moves it to the `"natural"`
    rule, while retained Renders continue replaying their pinned revisions
    byte-identically.
  - The revision hash includes `:layoutrule(natural)` only when `layoutRule` is
    `"natural"`, preserving byte-identical revision IDs for pre-change revisions.
  - Rollback behavior is fail-closed: pre-change code encountering a revision
    with `layoutRule` refuses it via revision hash verification rather than
    misrendering.
## Amendment: Anchored placement resolves before effects on both surfaces (spec #285 / #288)

- **The ink basis is the pre-effect painted ink (DEC-002).** The Consequences
  section above left "whether anchored resolution should account for
  effect-extended ink" to the #139/#140 contracts. Spec #285 ticket #288
  resolves it: anchored placement resolves against the Layer's painted ink
  **before the effects** on both surfaces it exists on — one-command
  `composition add` and `layer edit` — so re-anchoring a Layer that carries a
  shadow or an outline never moves it, and an effect edit never moves a
  stored placement (the intent of this ADR's one-shot shape, now explicit).
- **The exact stripped facts.** The resolution strips exactly the two
  ink-extending effect revision facts this ADR's Consequences named:
  `shadow` (#139, ADR-0018) and `outline` (#140, ADR-0019) — the outline's
  dilate ring is effect ink, not part of the anchor ink. No other facts are
  stripped, and none need to be: grade, edge glow, and blend cannot change
  the ink (they preserve alpha coverage — ADR-0024 DEC-005, "painted extents
  are unchanged by grade" and "alpha coverage is never altered" for glow),
  and the visible region is paint (ADR-0023), not an effect — the anchor
  still resolves against the region-clipped ink. The effect facts never
  reach the measurement, so the capture window is sized from the bare ink
  and an oversized effect can no longer refuse an anchor resolution.
- **One shared resolution, not two (TEST-004).** The strip lives inside the
  ONE shared pre-effect ink resolution in `src/layer-anchor.ts`
  (`resolvePreEffectAnchor`); both surfaces call it — the provisional add
  path through `resolveProvisionalAnchoredPlacement`, the edit path through
  `resolveAnchoredPlacement` — so parity holds by construction and no caller
  can forget or misuse a stripping flag. Parity is pinned at the CLI seam:
  the same `--anchor` with an effect present publishes the same stored
  placement through `composition add` and through a later re-anchoring
  `layer edit` (test/one-command-add-parity.test.ts), and shadow- and
  outline-carrying re-anchors land where an effect-less twin would
  (test/layer-anchor.test.ts; the pre-effect report evidence is the bare
  ink box).
- **The audit report's `painted` evidence changes basis.** The edit report's
  `anchored.painted` box is now the pre-effect ink (previously the
  effect-extended ink). `composition measure`'s `painted` extents are
  unchanged: effects' ink stays part of the measured painted contract
  (#139/#140) — only the anchor's basis strips it.
- **Existing retained state replays unchanged.** Anchored resolution is a
  read-only command-boundary query: no paint markup, revision schema,
  revision hash, or replay machinery changes, so every retained Render and
  revision — including ones whose placements were resolved under the
  effect-extended basis — replays byte-identically (TEST-003). A placement
  is a plain x/y fact; this amendment changes how a *future* anchor edit
  computes x/y, never how a stored one renders.
- **The exclusivity rule is unchanged.** `--anchor` still cannot combine
  with `--shadow`/`--outline` (or any non-placement option) in one edit: the
  measured basis must be the live state's ink, and the edit's new effect
  facts publish in a separate revision.

## Amendment: Wrap width is a text revision fact (spec #285 / #294)

- **The wrap width (DEC-001, DEC-005, US-015/ISC-55).** A text Layer takes an
  optional `wrapWidth?: number` revision fact — an ABSOLUTE setter in layout
  pixels, applied before the canonical transform (scale and rotation map the
  wrapped box afterwards). With a width set, a natural-layout text Layer
  soft-wraps at spaces within it (`width: <W>px; white-space: pre-wrap`):
  written line breaks still break and preserved spaces still hold, and
  `pre-wrap` is required because `pre` never wraps at spaces (a width with
  `pre` would overflow on one line, not wrap). With no width, the exact
  pre-#294 natural markup applies (`width: max-content; white-space: pre`) —
  natural one-line layout.
- **Stored only when set; removal restores byte-for-byte (DEC-005).** The
  fact is stored only when set (absence IS the no-width form), so revisions
  written before #294 keep their exact revision ids: the hash appends
  `:wrapwidth(<W>)` only when present, the same pattern as
  `:layoutrule(natural)`. The documented removal value at the command
  boundary is `"none"` (`--wrap-width none`); removing the width restores
  the unwrapped render byte-for-byte, and an omitted option carries the
  current width across any edit.
- **Line-level typography spans the wrap.** Line height and tracking apply
  across the wrapped lines (they paint through the same shared markup the
  unwrapped layout uses), and `measure`/anchor report the wrapped box —
  measurement renders the exact paint markup, so the measured `content` box
  is the wrapped box by construction. The standalone measure context now
  wraps at the stored width too (the width is intrinsic to the element, not
  the canvas).
- **Legacy interaction.** A legacy-rule revision never carries a wrap width,
  and setting one is an edit — so the revision publishes
  `layoutRule: "natural"` with it, exactly like any other text edit
  (ADR-0017's #287 amendment). Retained Renders keep replaying their pinned
  revisions byte-identically.
- **One shared validation.** The width validates as a positive finite number
  at the ONE domain boundary (`resolveTextWrapWidthControl`) the add path,
  the edit path, and both CLI boundaries share, and normalizes at the single
  ingestion point (`normalizeStoredTextWrapWidth`) beside the typography and
  layout-rule readers. Refusals are identical on both surfaces, and every
  refusal fires before anything is published.
