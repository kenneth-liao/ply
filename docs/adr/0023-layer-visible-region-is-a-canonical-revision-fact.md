# ADR-0023: The visible region is a canonical Layer revision fact painted between content and effects

- Status: Accepted — the visible-region command and its revision fact ship
  in [spec #207](https://github.com/kenneth-liao/ply/issues/207) ticket #211
  (US-003, DEC-004/005/006/009/010); the fact's optional corner radius ships
  in ticket #212 (US-003, DEC-009) on the same revision fact.

## Decision

A Layer revision's visible region — an optional `visibleRegion` object
`{ x, y, width, height }` — is the one canonical representation of "which
part of this Layer's content is ink" (DEC-004). The rectangle is defined in
the Layer's OWN content pixels, relative to the content box's top-left, and
is LEFT-ANCHORED: the placement point and the transform origin stay defined
against the FULL content box (DEC-005), so setting or removing a region
never moves the remaining pixels on the canvas. The command
`ply layer edit --visible-region "<x>,<y>,<width>,<height>"` sets an
**absolute** region that replaces any previous one (`--visible-region none`
removes it, the #135/#139/#140 flip-and-effect style), and an omitted option
preserves the current revision's region. A region outside the content box,
or one with zero area, is refused before publication naming the fault and
the content box; a text Layer's box is its measured line-box extent (the
unwrapped standalone line, measured through the one measurement authority —
both boundaries resolve it the same way, the edit path from the snapshot it
already holds and the add path from its provisional snapshot, never a
second Project read). The bounds gate also runs at the carry boundary: a
content edit that KEEPS the previous revision's region (content
replacement, text content and style, shape geometry/size) re-validates the
kept region against the NEW content box before anything is published — a
region that no longer fits is refused naming the fix, and one that still
fits publishes with a `regionCarried` report and a compact stderr note
that the kept region now frames the replaced content (#211 review
PROD-1). The stored normalizer checks the numbers' self-consistency only —
the publication-time gates are the enforcement points — so no valid
Project ever becomes malformed.

**Present ⟺ a region exists.** Absence IS the canonical no-region form:
removal drops the field, and every reader treats absence as none — there is
no second "no region" representation. The revision hash appends the field
only when present, so revisions written before #211 keep their exact ids
and paint meaning (the #133–#140 compat pattern), and the representation
gains an optional corner radius additively (#212) without reshaping the
rectangle facts.

**The optional corner radius (#212).** The fact's second axis is an optional
`cornerRadius` in px on the SAME `visibleRegion` object, stored only when
set and > 0 — a radius of 0 is the same look as absent, so it is never
stored (the shape `cornerRadius` rule). It obeys the ONE corner-radius range
rule the shape Layer's `--corner-radius` ships (`validateRectangleCornerRadius`,
shared — one rule, one wording): over half the REGION rectangle's shorter
side is REFUSED, never clamped, because the paint would silently clamp it
and the stored parameters would not describe the paint; a negative radius is
refused at the command boundary. The command
`ply layer edit --visible-region-radius <px>` is an absolute setter that
edits and removes INDEPENDENTLY of the rectangle (`none` or `0` removes the
radius; an omitted option preserves it, even when the rectangle is re-set —
a preserved radius that no longer fits the new rectangle is refused, the
same refusal a re-issued radius would get); a positive radius needs a
region — a positive radius on a Layer without one, or combined with the
region's removal, is refused before publication (the removal forms are
idempotent) — and removing the region removes its radius (one
fact, one removal). One-command `composition add` accepts the radius in the
documented order, applied right after the rectangle, still before the anchor
resolves. The paint is the clip rect's `rx`: the same rectangle (painted
extents stay the rectangle's — the rounded corners never shrink the ink's
bounding box), with the corners rounded — and because the clip crops the
content BEFORE the effect chain, the outline and shadow hug the rounded edge
with no second mechanism. The revision hash appends `,r<r>` inside the
`:region(...)` field only when the radius is present, so revisions written
before #212 — and region-carrying revisions without a radius — keep their
exact ids, and the stored normalizer re-validates a stored radius through
the same range rule (fail-closed, review INT-4).

## Paint order — the region crops before the effects

The region is paint-time like the effects (ADR-0018, ADR-0019): retained
bytes, content hashes, and Generation/Matting lineage are never touched.
Within a Layer the paint order is **content, visible region, outline,
shadow, then transform and opacity** (DEC-004) — the region crops the
content BEFORE the effect chain, so the outline's dilate and the shadow
hug the region's edge instead of the full content edge, and one definition
of painted ink (DEC-004/DEC-006) covers all of it.

The markup shape delivers the order with no second mechanism: a
region-wearing Layer paints as an outer wrapper element (placement,
opacity, canonical transform, the outline+shadow `filter` chain) around an
inner content element carrying `clip-path:url(#<clipPath>)`, where the
clipPath is a per-Layer deterministic-id `userSpaceOnUse` rect at the
region's local coordinates. CSS applies an element's own clip-path after
its filters — the same-element form would clip the ring and shadow off at
the region boundary — so the clip must live on the inner element for the
outer element's filter chain to see the cropped composite. The SVG
reference clip (rather than `clip-path:inset(...)`) needs no knowledge of
the element's far edge, which only the browser knows for a wrapped text
line box; the region rect is absolute in the element's local user space for
every kind. Layers without a region emit exactly the pre-#211 markup, so
pinned Render history paints byte-identically, and `#canvas`'s children
remain exactly one element per Layer (the measurement probe and the
painted-ink pass index them by position).

## Geometry — one shared authority (DEC-005, DEC-006)

Measurement and painting keep ONE shared geometry authority: the same
`buildCompositionHtml` markup paints and measures, and the measurement
probe maps the region's local corners through the same transform matrix it
uses for the content corners. `painted`, `paintedOnCanvas`, and `clipped`
are alpha-support measurements of the actual paint, so they follow the
region by construction; the bounded per-Layer capture window (#185) is
sized around the region's transformed box instead of the full layout box,
so a large padded source refused uncropped at a given scale measures once
cropped to its subject — captured or refused loudly, never silently
clipped. Anchored placement resolves against the visible painted ink, as
today — with a region, that ink is the region-clipped ink (DEC-005), which
is why `--anchor` and `--visible-region` refuse to combine in one edit on
`layer edit` (the anchor would resolve different ink than the edit
publishes), while one-command `composition add` applies the region in the
documented order (content, transforms, region, anchor, effects) so the
anchor resolves the region-clipped ink in a single revision. The region
cannot combine with content edits for the mirror reason: it is validated
against the content box, and one edit carries one intent. The whole-
Composition treatment of a refused Layer is untouched (#206, OOS-008).

## Consequences

- Region facts are revision facts shared as a whole (DEC-002): in-place
  edits propagate them, forks isolate them, cross-Project copies preserve
  them verbatim, and pinned Render history replays byte-identically.
- Removing a region restores the prior render byte-for-byte (ISC-38):
  set-then-remove renders byte-identically to never-set.
- The spelling is the delivery choice recorded per DEC-009: the
  `--visible-region "<x>,<y>,<width>,<height>"` / `none` convention follows
  the shadow/outline comma-spec and removal-value style, validated by one
  parser (`parseVisibleRegionSpec`) at both boundaries, so the CLI's
  usage-error classification (exit 2) and the edit path's pre-staging
  refusal can never disagree; content-bounds refusals are semantic
  (exit 1). The radius (#212) follows the same conventions: one px value or
  `none`, validated by one parser (`parseVisibleRegionRadiusSpec`) at both
  boundaries; the range refusal is semantic (exit 1).
- **Rollback to a pre-#211 binary:** as with #140 (ADR-0019), an older
  binary re-derives the revision hash without the `visibleRegion` field, so
  a region-carrying revision fails its pinned-hash check — fail-closed,
  never a silent misread. The remediation runs BEFORE reverting, on the
  #211 binary: remove the region (`ply layer edit <layerId>
  --visible-region none`) on every Layer that has one (`ply layer inspect`
  shows `Visible region: ...`; `ply composition measure` reports it in the
  `visibleRegion` facts), verify a render replays byte-identically, then
  switch binaries. Non-current revisions with regions stay pinned history
  and recover by re-upgrading — downgrade is lossy for history visibility,
  not just pinned renders (review PROD-3): the old binary cannot display
  any region-carrying revision, current or historical, until re-upgraded.
- **Forward compatibility (#212, realized):** the region's optional corner
  radius extended the stored normalizer AND the revision hash together, the
  same way this field joined the shadow/outline pattern — a normalizer
  that silently strips a future field would break the hash check the same
  way a missing field does (review INT-4).