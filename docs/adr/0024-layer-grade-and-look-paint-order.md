# ADR-0024: Layer grade and the look paint order

- Status: Accepted — Layer grade, look paint order, and blend mode ship in
  [spec #218](https://github.com/kenneth-liao/ply/issues/218) tickets #219 and
  #220 (US-001, US-003, DEC-001..005, DEC-007, DEC-009..011); the edge glow
  ships in the same spec's ticket #221 (US-002, DEC-006), filling the order
  step this ADR reserved for it.

## Context

Callers and agents need to adjust a Layer's tonal and colour balance —
brightness, contrast, saturation, and warmth — so that cutouts and imported
imagery match the scene they sit in, without destructive file edits or external
image manipulation passes.

Sibling features in spec #218 (blend mode #220, edge glow #221, gradient text
#222), alongside existing visual operations (#215 vector colour, ADR-0023
visible region, ADR-0018 shadow, ADR-0019 outline), introduce distinct visual
transformations within a Layer. Without a single canonical paint order, the
interaction among these operations (e.g. whether grade affects outline/shadow,
whether visible region clips grade, whether edge glow sits under or over
grading) would be ambiguous or implementation-dependent.

## Decision

### 1. Grade controls are Layer revision facts

Grade controls are revision facts stored on the Layer revision under an
optional `grade?: LayerGrade` object containing `{ brightness?, contrast?,
saturation?, warmth? }`:

- Stored only when set and non-neutral (DEC-001).
- Each control is an **absolute setter** with a documented valid range:
  - `--brightness`: `[0, 5]`, neutral `1`.
  - `--contrast`: `[0, 5]`, neutral `1`.
  - `--saturation`: `[0, 5]`, neutral `1`.
  - `--warmth`: `[-1, 1]`, neutral `0`.
- Passing the neutral value removes that control from the stored fact. If all
  controls are neutral, the `grade` fact is removed completely (`undefined`),
  leaving no trace in the stored revision.
- An omitted control keeps its previous value across subsequent edits.
- A neutral-only Layer renders byte-identically to an ungraded Layer.
- Refusals run before publication: non-numeric or out-of-range inputs exit with
  status 2 naming the control and its range.
- Grade applies to image (raster and vector), text, and shape Layers.
- Grade facts are immutable revision properties: they share across Compositions
  when the Layer is shared, fork when `--fork` is used, and replay
  byte-identically from retained Render manifests.

### 2. The Look Paint Order

Extending ADR-0023's paint order, operations within a Layer's local coordinate
space apply in one fixed, canonical sequence (DEC-002, DEC-003):

1. **Content**: the base image pixels, vector geometry, shape fill, or text glyphs.
2. **Vector colour**: recolouring of vector alpha (#215, spec #207 US-005).
3. **Visible region**: rectangular crop and optional corner radius (ADR-0023).
4. **Grade**: brightness, contrast, saturation, and warmth.
5. **Edge glow (#221)**: a coloured band painted just INSIDE the Layer's
   alpha edge — the inner-alpha rim light. It operates on the alpha AFTER
   the region clip and the grade (the region's rounded corners shape its
   edge; it paints over the graded content), weights by one angle plus
   strength (DEC-006), and never extends painted extents or alters alpha
   coverage (DEC-005).
6. **Outline**: local stroke dilation around visible ink (ADR-0019).
7. **Shadow**: local drop-shadow cast from the outlined composite (ADR-0018).
8. **Transform & Opacity**: scale, flip, rotation, and Layer-level opacity.
9. **Blend against backdrop (#220)**: composite unit against underlying canvas.

### 3. Deterministic CSS filter chain & DOM structure

All grade transformations are executed entirely offline using the rendering
browser's deterministic CSS filter pipeline (DEC-004):

- Grade applies to the **content only**, never to the outline or shadow, and
  **never changes alpha coverage** (DEC-005).
- The CSS filter string is constructed in a fixed order:
  `brightness(<val>) contrast(<val>) saturate(<val>) url(#<warmthFilterId>)`.
- Warmth is implemented via an SVG `<filter>` containing an `<feColorMatrix>`
  with `color-interpolation-filters="sRGB"`:
  - Positive warmth scales red up and blue down:
    `rScale = 1 + warmth * 0.3`, `bScale = 1 - warmth * 0.3`.
  - Negative warmth scales blue up and red down.
  - Green and alpha remain strictly unchanged (`0 0 0 1 0`).
- To prevent grade filters from altering outline or shadow colours, a
  graded Layer uses a two-element DOM structure:
  - An **inner element** carries the content, `clip-path` (visible region), and
    `filter` (grade).
  - An **outer wrapper element** carries the placement, transform, opacity, and
    effects filter (outline dilation and drop shadow).
  - Ungraded, unclipped Layers preserve the single-element markup for
    byte-identical backward compatibility with existing Renders.

### 4. Geometry and measurement invariants

Because grade filters preserve alpha coverage exactly (DEC-005):
- Painted extents (`painted`) are unchanged by grade.
- Anchored placement (`--anchor`) resolves to the exact same coordinates.
- Canvas clipping checks (`clipped`) report identical boundaries.
- `composition measure`, `layer inspect`, and `layer review` report the
  effective grade controls for auditability.

### 5. Blend mode compositing unit (#220)

- `--blend <mode>` is an absolute setter across the documented set (`normal`,
  `multiply`, `screen`, `overlay`, `soft-light`, `darken`, `lighten`,
  `color-dodge`).
- `normal` removes the stored fact. An unknown mode is refused before publication
  listing the allowed set.
- Storage normalisation (`normalizeStoredBlend`) is the single source of truth
  for allowed modes and neutral dropping; paint trusts the normalized fact.
- At paint time, `mix-blend-mode: <mode>` is placed on the outer element of the
  Layer, after transform and opacity (DEC-002). Thus, the whole Layer — content,
  visible region, grade, edge glow, outline, shadow, and opacity — blends as ONE
  unit against everything beneath it.
- Over a transparent canvas backdrop, blending follows standard browser
  compositing semantics without special-casing (DEC-007).

### 6. The edge glow filter (#221)

- `--glow "<width>,<softness>,<color>[,<angle>,<strength>]"` is an absolute
  setter (`none` removes it) over the documented ranges: width and softness
  `0..256` px, the effects' hex colour grammar, angle `-360..360` degrees
  clockwise from top stored canonically in `[0, 360)`, strength `0..1`, the
  pair supplied together, strength `0` dropping the pair (the even glow).
- Storage normalisation (`normalizeStoredGlow`) is the ONE home for
  validation and removal — paint trusts the fact; the compact-value parser
  (`parseGlowSpec`) is the one boundary parse both command surfaces run, so
  refusals (exit 2, naming the part and its range) can never disagree.
- Paint emits one SVG filter per glow Layer (deterministic id, sized in-page
  by the same pass as the outline's region) as the FIRST function of the
  outer element's filter chain — glow → outline → shadow — so the band
  operates on the region-clipped, graded alpha and stays inside the blend
  unit. The chain: erode the source alpha by `width` (chained under the same
  256px raster cap as the outline's dilate), offset the eroded mask opposite
  the light direction by `strength × width` px when a direction is stored,
  blur by `softness`, subtract from the source alpha, flood the colour,
  composite `in` the band, and composite the band ATOP the source graphic —
  Porter-Duff atop keeps the composite's alpha exactly the source's, so
  alpha coverage is never altered (DEC-005) and painted extents equal the
  no-glow extents at every transform.

## Consequences

- **Poka-yoke & Single Source of Truth**: Grade controls are normalized at the
  one option table boundary (`src/layer-options.ts`) and stored in the one
  canonical location (`rev.grade`).
- **Minimal change & compatibility**: Existing revisions without grade facts
  continue to paint with single-element DOM structures and zero filter overhead.
- **Offline & deterministic**: Rendering relies solely on local browser CSS
  filters and SVG matrix primitives; no network calls or external models are
  involved.
