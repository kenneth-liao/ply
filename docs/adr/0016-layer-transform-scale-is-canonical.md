# ADR-0016: Layer transform scale is the canonical resize representation

- Status: Accepted — the resize command and its revision fact shipped in
  [spec #132](https://github.com/kenneth-liao/ply/issues/132) ticket #133.
  Amended by #296 (spec #285 US-030): the absolute per-axis scale setter
  (`--scale-to <XxY>`) joins the family, and per-axis scale is explicit in
  the transform order.

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

## Reflection extension (#135)

Reflection joins the same canonical representation as a `flipX`/`flipY`
boolean revision pair — two axes of the one reflection operation, one shared
representation, no separate lifecycle. `flipX` mirrors the content along its
own vertical axis (left–right), `flipY` along its own horizontal axis
(top–bottom). The command `--flip <horizontal|vertical|both|none>` sets an
**absolute** reflection state that replaces any previous flip (`--flip
horizontal` twice is still horizontal, never a toggle; `--flip none` removes
the reflection), so flip states are distinct deliberate edits.

Reflection is deliberately NOT a negative scale factor: scale fields are
finite positive numbers with resize-factor semantics and effective-size
meaning, and overloading them would break both. The pair is recorded
together (like scale) as a revision fact shared as a whole (DEC-002).

Order relative to scale and rotation: **flip joins scale at the innermost
position** — the content reflects along its own axes, then scale stretches,
then rotation rotates the reflected result. Flip and scale are both diagonal
transforms and commute, so their emitted order among themselves is
immaterial; rotation-outermost is the contract. Paint emits `rotate(a)
scaleX(-1) scaleY(-1) scale(sx, sy)` with `transform-origin: 0 0`, each
factor emitted only when non-identity, so revisions written before
#133/#134/#135 and identity-transform revisions paint exactly as before
(pinned Render history stays byte-identical). The footprint mirrors to the
other side of the placement point's axis line (a 100px-wide Layer at `x=100`
flipped horizontally paints `x ∈ [0, 100]`), exactly as rotation moves its
footprint about the same origin.

Flip is independent of the retained content's size, so like rotation it
combines freely with other edit options, including content replacement and
`--resize`.

Compatibility follows the scale and rotation pattern exactly: the hash
appends the flip fields only when present, so revisions written before #135
— including rotation-era ones — hash to their exact pre-#135 ids. Documents
written before #135 lack the fields and normalize to false at the one
revision-reader boundary (a present `null`/non-boolean, or a partial pair,
is malformed and refused loudly); every newly written revision records both
fields explicitly. Cross-Project copies preserve them verbatim.

## Per-axis scale setter extension (#296)

Every Layer kind takes independent horizontal and vertical scale through the
SAME canonical `scaleX`/`scaleY` revision fields — no text-only field, no
second scale home. The command `--scale-to <XxY>` is an **absolute** setter
for the two factors (`--scale-to 1.3x0.8` stretches 1.3× horizontally, 0.8×
vertically; repeating the command is idempotent, never compounding), so
every kind can reach a deliberate non-uniform scale: text Layers, whose
per-axis scale was previously unreachable because `--resize-to` needs an
intrinsic pixel size text does not have, take it through the same one
resolution, the same bounds, and the same effective-size cap as image and
shape Layers. One omitted axis (`"1.3x"`, `"x0.8"`) keeps the Layer's
current scale on that axis — the `--resize-to` one-axis rule at factor
semantics.

Uniform and per-axis are ONE stored fact: `--scale <f>` and `--scale-to
<XxY>` write the same two canonical fields, so either setter wholly
replaces the current scale (setting one never multiplies into the other),
and `--scale-to 1x1` is the removal form — identity normalizes like the
absent-field default, so the paint emits no transform and the render
returns to the scale-1 output byte-for-byte (the removal is still a new
deliberate revision; the stored `1`/`1` fields round-trip exactly like any
explicitly written scale).

Order relative to the other transforms is unchanged: non-uniform scale is
the same innermost stretch along the content's own axes — flip reflects,
scale (now per-axis) stretches the reflected result, rotation rotates it.
Paint emits `scale(sx, sy)` exactly as before — the per-axis setter only
changes which two values the caller can set, never the transform path —
so revisions written before #296 paint byte-identically and pinned Render
history stays pinned.

`--scale-to` shares the resize family's one-form-per-edit rule (mutually
exclusive with `--resize`, `--resize-to`, `--cover-to`, and `--scale`) and
is refused together with content replacement (the effective-size cap reads
the retained content's intrinsic size). Wrap width and fit box (#294/#295)
remain layout px BEFORE transforms: the per-axis scale maps the wrapped
layout box into canvas space and never re-wraps.

## Skew and perspective extension (#298)

Skew and perspective join the same canonical representation as Layer
revision facts on every Layer kind (spec #285 US-008, ISC-47, DEC-005) —
no per-kind field, no second transform home:

- `--skew <Xdeg>x<Ydeg>` stores `skewXDeg`/`skewYDeg`, absolute shear
  angles in degrees about the Layer's `(x, y)` top-left placement point.
  A one-axis form (`"15x"`, `"x5"`) keeps the Layer's current angle on the
  omitted axis (the `--scale-to` one-axis rule at angle semantics).
  `--skew 0x0` is the removal form.
- `--perspective <tiltXdeg>x<tiltYdeg>` stores
  `perspectiveTiltXDeg`/`perspectiveTiltYDeg`, absolute tilt angles in
  degrees about the X and Y axes — positive X tips the top edge away from
  the viewer, positive Y tips the right edge. The perspective DISTANCE is
  never a stored fact: the projection uses one fixed documented distance
  of 1000px. A one-axis form keeps the other tilt. `--perspective 0x0` is
  the removal form.

Both facts are stored only when set: a stored document never carries the
identity form, so an unskewed revision keeps its exact pre-#298 document
shape, and the removal form drops the pair (the render returns to the
unskewed output byte-for-byte; the edit is still a new deliberate
revision). Both fields of each pair are recorded together, like flip — a
partial pair is malformed and refused loudly at the one revision-reader
boundary. Angles are bounded to `|angle| ≤ 89` degrees: the skew tangent
diverges at ±90°, and a ±90° perspective tilt is edge-on; the same bound
is enforced at the parser (usage error), the resolver (domain refusal),
and the stored reader (malformed document). The divergent-projection
refusal — a tilt projecting the content, plus its own effect extent,
deeper than the fixed 1000px distance — is computed from the POST-AFFINE
extents (the tilt applies to points already mapped by the pre-tilt affine
flip/scale/rotation/skew, so the depth is the exact tilt functional over
the affine-mapped content corners plus the affine-mapped reach, never the
raw layout box) through ONE shared reader, `perspectiveDepth`, that backs
both the capture-window sizing and the refusal. The refusal runs at the
measure seam AND at the add/edit publication boundary — on the would-be
revision, before anything stages — so a Layer that measure would refuse
can never be stored (the render path emits the perspective CSS
unconditionally, so storage is the only place the loud refusal can live).
The effect-reach magnification widens the painted-extent capture window
for skew and perspective so an effected Layer's full extent is captured or
refused, never clipped.

### Full transform order

The complete order, innermost to outermost, is:

**flip, scale, rotation, skew, perspective.**

Paint emits the functions left-to-right outermost-first —
`perspective(1000px) translate(50%,50%) rotateX(a) rotateY(b)
translate(-50%,-50%) skewX(ax) skewY(ay) rotate(a) scaleX(±1) scaleY(±1)
scale(sx, sy)` — with `transform-origin: 0 0`, each factor emitted only
when non-identity. CSS composes left-to-right as function composition, so
the content reflects, stretches along its own axes, then rotates, then
shears, then tilts under the perspective projection.

Every non-perspective transform acts about the Layer's `(x, y) top-left
placement point, exactly as before. The perspective tilt pivots about the
Layer's OWN untransformed content centre — the
`translate(50%,50%) … translate(-50%,-50%)` wrapper resolves against the
element's border box (layout px before transforms), so a tile turns in
place with its centre instead of swinging around the placement corner;
with the vanishing point at the top-left a "turned" tile looked lopsided.
The fixed 1000px perspective distance is a paint constant, never a stored
fact, so it can be documented here once and every read re-derives the
same projection.

measure reads the COMPUTED transform — the browser's resolved matrix,
percentages resolved and all 3D factors folded into one matrix3d — and
maps the content rectangle's corners through it with the projective
divide, so `corners` reports the projected quad and anchors resolve
against the transformed ink's painted extents exactly as they do for the
affine transforms.

Each factor is emitted only when non-identity, so revisions written
before #298 — and identity-transform revisions — paint exactly as before
(pinned Render history stays byte-identical). Compatibility follows the
scale/rotation/flip pattern exactly: the hash appends the skew and
perspective pairs only when present, so revisions written before #298
hash to their exact pre-#298 ids; absent fields normalize to 0 at the one
revision-reader boundary; every newly written revision records a pair
only when set. Skew and perspective are independent of the retained
content's size (like rotation), so they combine freely with other edit
options, including the resize family and content replacement. Cross-
Project copies preserve them verbatim (ADR-0013: shared as a whole,
forks isolate, copies preserve).
