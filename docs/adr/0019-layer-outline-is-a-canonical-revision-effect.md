# ADR-0019: Layer outline is a canonical revision effect painted before the shadow

- Status: Accepted — the outline command and its revision fact ship in
  [spec #132](https://github.com/kenneth-liao/ply/issues/132) ticket #140.

## Decision

A Layer revision's outline — an optional `outline` object `{ width, color
}` — is the one canonical outline representation (DEC-002, DEC-006). The
command `ply layer edit --outline "<width>,<color>"` sets an **absolute**
outline that replaces any previous one (`--outline none` removes it, the
#135 flip style), and an omitted option preserves the current revision's
outline. Parameter bounds: `width` a px thickness between 0 and 256,
`color` a hex color `#RGB`/`#RRGGBB`/`#RRGGBBAA`. The bound keeps the
effect footprint bounded so painted-extent capture stays bounded; DEC-006
forbids a general filter framework — the outline is a bounded sibling of
the #139 shadow (`#140`), not the first entry of one.

**Present ⟺ an outline exists.** Absence IS the canonical no-outline
form: removal drops the field, and every reader treats absence as none —
there is no second "no outline" representation. The revision hash appends
the field only when present, so revisions written before #140 keep their
exact ids and paint meaning (the #133/#134/#135/#139 compat pattern).

## Paint ordering — feMorphology dilate, before the shadow

The outline applies to the Layer's content in its **LOCAL coordinate
space**, BEFORE the shadow: paint emits a CSS `filter` chain on the Layer
element whose first function is a referenced SVG `feMorphology` `dilate`
filter (one `feMorphology in="SourceAlpha" operator="dilate"
radius="width"`, flooded with the outline color and composited back under
the source graphic), and whose last function is the shadow's single
`drop-shadow`. CSS filter-list chaining feeds each function's output to
the next, so the shadow is cast from the outlined composite; the
transform then maps content + outline + shadow together, and the Layer's
opacity fades all of it. A rotated Layer's outline rotates with it, and
its shadow follows the outlined composite.

The dilate filter was chosen over chained blur-0 `drop-shadow` compass
stamps: chained drop-shadows compound (each stamp shadows the
accumulated ink of the previous ones), so a stamped ring overshoots
`width` by up to several widths — geometry no longer derivable from the
facts alone. The dilate extends the content's alpha (image and text
glyphs alike) by exactly `width` px in every direction (a box
structuring element: painted ink ⊆ content ⊕ square(width)), so painted
ink and measurement reach agree exactly.

**Filter regions are sized per Layer, in-page.** Chromium clips BOTH the
dilate result AND the source graphic to the filter's declared region
(verified empirically), and a region expressed in objectBoundingBox
percentages clips whenever `width` exceeds its 3× margins — a small
element with a large width silently loses its ring. The region must
cover the element's real untransformed box expanded by `width` px, and
that box is only knowable in the browser (text Layers wrap), so the
markup declares one filter per outlined Layer (deterministic id: hash of
width, color, and the Layer's snapshot index) with a placeholder region,
and both page flows — paint and measurement — size every region in-page
from the element's untransformed border box (`sizeOutlineFilterRegions`)
before any screenshot. The same adjustment in both flows keeps render
and painted extents identical, and being a deterministic function of the
same DOM it preserves pinned-replay byte-identity. The defs SVG is
emitted once per Composition OUTSIDE the `#canvas` element, so
`#canvas`'s children remain exactly one element per Layer (the
measurement probe and painted-ink pass index them by position). Effects
are emitted only when they exist, so pre-#139/#140 revisions and their
pinned Render history paint exactly as before.

## Painted bounds and anchored placement

The #137 ink pass screenshots the paint-identical markup, so the
outline's ink is part of the measured `painted` extents by construction.
The capture window is widened by the Layer's **canvas-space effect
reach** — the COMBINED local reach, additive because the shadow is cast
from the outlined composite: `width + |dx| + |dy| + 2·blur` scaled by the
revision transform's largest factor — derived from the revision facts
alone, so an effected Layer's full extent is captured or the measurement
is refused loudly, never silently clipped. The `effects` facts report
both `shadow` and `outline`.

**Anchored placement resolves against the effect-extended painted ink**
(one definition of painted ink, DEC-004): the outline is part of what is
visible, so `--anchor` places the outlined composite. A later outline
edit never moves an already-resolved placement (anchoring is one-shot,
ADR-0017). `--anchor` and `--outline` refuse to combine in one edit —
the anchor would resolve different ink than the edit publishes.

## Consequences

- Outline facts are revision facts shared as a whole (DEC-002): in-place
  edits propagate them, forks isolate them, cross-Project copies preserve
  them verbatim, and pinned Render history replays byte-identically.
- Retained source bytes, hashes, and lineage never change (DEC-005): the
  outline is paint-time, never baked into content.
- Validation uses one parser (`parseOutlineSpec`) at both boundaries, so
  the CLI's usage-error classification (exit 2, the `--opacity`/`--resize`
  value-range convention) and the edit path's pre-staging refusal can
  never disagree — nothing invalid reaches the edit path.
- Effect colors canonicalize at the one ingestion boundary (INT-2 from
  the #139 review, applied to both effects in #140): the spec parsers
  lowercase hex and expand `#RGB` to `#RRGGBB`, so case/shorthand
  variants of the same paint can no longer mint redundant revisions.
  Documents stored before this decision stay verbatim — the stored
  normalizers accept every conformant form, so old revision ids and
  pinned paint are untouched.
