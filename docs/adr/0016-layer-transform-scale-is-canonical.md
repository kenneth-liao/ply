# ADR-0016: Layer transform scale is the canonical resize representation

- Status: Accepted — the resize command and its revision fact shipped in
  [spec #132](https://github.com/kenneth-liao/ply/issues/132) ticket #133.

## Decision

A Layer revision's transform scale — `scaleX`/`scaleY`, finite positive
numbers — is the one canonical transform representation. Public size
conveniences normalize to it at the command boundary and are never stored as
competing authoritative fields:

- `--resize <factor>` is a relative multiplier over the current scale.
- `--resize-to <WxH>` is an absolute effective size, normalized to scale
  against the retained content's intrinsic size; one omitted axis preserves
  the Layer's current aspect ratio (a deliberate both-axes change survives
  later one-axis resizes, never silently reset to intrinsic), both axes
  deliberately change it. It is image-only —
  text Layers have no intrinsic pixel size until read-only measurement
  exists.

Scale is a Layer revision fact, shared as a whole like placement (per
ADR-0013): in-place edits propagate it, forks isolate it, cross-Project
copies preserve it verbatim, and it participates in the content-derived
revision hash — a resize-only edit is a new revision. Resizing changes
placement only; retained content bytes, hashes, and generation/Matting
lineage never change.

## Transform origin

Scale applies about the Layer's `(x, y)` top-left placement point: the Layer
grows/shrinks right and down. Paint applies the scale as a single CSS
transform per Layer, emitted only when scale ≠ 1 so pre-existing revisions
and their pinned Render history stay byte-identical.

The one-axis form of `--resize-to` preserves the Layer's current aspect
ratio, not the intrinsic one: an aspect ratio set deliberately through the
both-axes form is an explicit caller choice and survives later one-axis
resizes. For a uniform prior the two coincide.

## Consequences

Later transform operations (rotation, reflection) extend the same canonical
representation and the same paint path rather than introducing a second
transform home. Older revision documents without scale fields normalize to
scale 1 at the one revision-reader boundary; their hash computation is
unchanged. Every newly written revision records both fields explicitly.

## Rotation extension (#134)

Rotation joins the same canonical representation as a single `rotationDeg`
revision field — degrees about the Layer's `(x, y)` top-left placement point,
positive clockwise (CSS convention), stored verbatim. The command
`--rotate <deg>` sets an **absolute** angle that replaces any previous
rotation (`--rotate 45` twice is still 45°, never incremental like the
relative resize factor; `--rotate 0` removes the rotation), so equivalent
angles are distinct deliberate edits.

Order relative to scale: **scale applies first, then rotation**. Paint emits
`rotate(a) scale(sx, sy)` with `transform-origin: 0 0` — CSS composes
left-to-right as rotate∘scale, so the content stretches along its own axes
and the stretched result rotates. Each factor is emitted only when
non-identity, so revisions written before #133/#134 and identity-transform
revisions paint exactly as before (pinned Render history stays
byte-identical).

Rotation is independent of the retained content's size, so unlike the two
resize forms it combines freely with other edit options, including content
replacement and `--resize`.

Compatibility follows the scale pattern exactly: the hash appends
`rotationDeg` only when present, so revisions written before #134 — with or
without scale fields — hash to their exact pre-#134 ids. Documents written
before #134 lack the field and normalize to 0 at the one revision-reader
boundary (a present `null` or non-number is malformed and refused loudly);
every newly written revision records it explicitly. Cross-Project copies
preserve it verbatim.
