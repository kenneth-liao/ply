# ADR-0024: Layer grade and the look paint order

- Status: Accepted — Layer grade, look paint order, and blend mode ship in
  [spec #218](https://github.com/kenneth-liao/ply/issues/218) tickets #219 and
  #220 (US-001, US-003, DEC-001..005, DEC-007, DEC-009..011); the edge glow
  ships in the same spec's ticket #221 (US-002, DEC-006), filling the order
  step this ADR reserved for it. Amended by
  [spec #285](https://github.com/kenneth-liao/ply/issues/285) ticket #299
  (US-010, DEC-005/DEC-006): the blur joins the look paint order as the LAST
  function of the effects chain (see the amendment below). Amended again by
  the same spec's ticket #300 (US-013, DEC-005/DEC-006): edge choke and
  feather join the look paint order as the FIRST function of the effects
  chain (see the second amendment below). Amended a third time by the same
  spec's ticket #301 (US-014, DEC-008): the one-sided direction model joins
  the edge glow as a second, mutually exclusive direction form (see the
  third amendment below). Amended a fourth time by the same spec's ticket
  #303 (US-011, ISC-64, DEC-005, ADR-0027): the inner shadow joins the
  look paint order between the edge glow and the outlines (see the fourth
  amendment below).

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
6. **Inner shadow (#303)**: a darkening painted just INSIDE the Layer's
   alpha edge — the inset counterpart of the shadow — after the glow and
   before the outlines. It is an alpha-edge-reading effect, so it sits
   after the edge step; its atop composite preserves the input's alpha
   exactly, so it sits before the first alpha-extending effect (the
   outlines), keeping the outline dilate and drop-shadow casting geometry
   provably unchanged; among the alpha-preserving edge effects, light
   precedes shade — the darkening reads on the lit composite. Stacked
   (ADR-0027): entries paint in stored order. It never extends painted
   extents or alters alpha coverage (DEC-005) — the #300 edge-step
   precedent's zero reach. The offset direction follows the CSS inset
   box-shadow convention: the band appears along the edge the offset
   moves AWAY from (dy +4 darkens the top inside edge, dx +4 the left).
7. **Outline**: local stroke dilation around visible ink (ADR-0019).
8. **Shadow**: local drop-shadow cast from the outlined composite (ADR-0018).
   Within the outline and shadow steps, STACKED effects (#302, ADR-0027)
   paint in stored order — each later function operates on the composite
   the earlier ones accumulated; the steps' positions in this order are
   unchanged.
9. **Blur (#299)**: a Gaussian defocus over the whole Layer look — the LAST
   function of the effects chain (the amendment below).
10. **Transform & Opacity**: scale, flip, rotation, and Layer-level opacity.
11. **Blend against backdrop (#220)**: composite unit against underlying canvas.

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
  A second direction form — `from <angle>,<strength>`, the one-sided model —
  joins the same fact with the third amendment below; the two forms are
  mutually exclusive.
- Storage normalisation (`normalizeStoredGlow`) is the ONE home for
  validation and removal — paint trusts the fact; the compact-value parser
  (`parseGlowSpec`) is the one boundary parse both command surfaces run, so
  refusals (exit 2, naming the part and its range) can never disagree.
- Paint emits one SVG filter per glow Layer (deterministic id, sized in-page
  by the same pass as the outline's region) painted after the edge choke &
  feather (#300, the second amendment below) — the second function of the
  outer element's filter chain — glow → outline → shadow — so the band
  operates on the region-clipped, graded, edge-shaped alpha and stays inside
  the blend unit. The chain: erode the source alpha by `width` (chained under
  the same
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

## Amendment: the blur joins the look paint order (#299)

Blur is a Layer revision fact on every Layer kind (spec #285 US-010, ISC-49,
DEC-005) that makes the whole Layer read out of focus, and it changes this
ADR's accepted paint order (DEC-006) — recorded here, not overridden in
code:

- **Fact shape (DEC-005)**: `rev.blur?: number` — a Gaussian defocus radius
  in px, an absolute setter with a documented range of `0..256` px. `--blur 0`
  is the removal form and the identity is never stored: absence IS the
  canonical no-blur form, so removal drops the field and every reader treats
  absence as none. One normalization boundary (`normalizeStoredBlur`), one
  resolve path (`resolveEditBlur`, shared by the edit and one-command add
  surfaces), the revision hash appends it only when present. It follows
  ADR-0013 sharing and fork rules and replays byte-identically from retained
  Render manifests.
- **Paint order position**: a new step **8. Blur** between Shadow (7) and
  Transform & Opacity (9) — the LAST function of the outer element's effects
  filter chain (`glow → outline → shadow → blur`). The whole Layer look —
  content, edge glow, outline, shadow — reads out of focus together, the
  defocus semantics a viewer expects of an out-of-focus object: a sharp
  outline on blurred content would read wrong. It stays inside the blend
  unit and is mapped by the transform with everything else. Emitted only
  when a blur fact exists, so pre-#299 revisions and their pinned Render
  history paint byte-identically.
- **Layer-local px**: the effects chain paints in the Layer's LOCAL space —
  under the canonical transform — so blur px scale with the Layer's
  scale/scale-to like outline width and shadow offsets. Doubling the scale
  doubles the defocus reach in canvas px (proven by test on the painted
  extents).
- **Painted extents grow (unlike grade or glow, DEC-005)**: CSS `blur(r)`
  sets the Gaussian standard deviation σ = r, and Chrome's kernel reaches
  ~3σ, so the defocus extends the ink by up to ~3r px in every local
  direction. The ONE additive effect-reach reader (`effectReachPx` in
  `src/composition-measure.ts`)
  adds `ceil(3 × blur)` px of local reach, additive after the outline and
  shadow terms, mapped through the transform's worst-case magnification. A
  2× margin would clip the visible tail (the rendered alpha>0 ink reaches
  ~2.4σ at 8-bit alpha); the capture-window test proves the measured painted
  extent equals the extent an unbounded capture margin sees — never clipped.
- **Anchors never move**: the blur is an effect, so anchored placement
  resolves against the pre-effect ink (#288, ADR-0025) — the same anchor
  lands at the same stored placement with and without the blur, on add and
  on edit.
- **Reporting**: `composition measure` reports the effective radius as
  `blur` (px, `null` when absent), beside the grade and glow; `painted`,
  `paintedOnCanvas`, and `clipped` already reflect the growth.
- **Not included**: edge choke and feather (#300) add no term to this reach
  reader — their `in` composite bounds the painted ink by the source alpha
  (see the second amendment below); no second reach home is created here.

## Second amendment: edge choke and feather join the paint order (#300)

Edge choke and feather are Layer revision facts on every Layer kind (spec
#285 US-013, ISC-52, DEC-005) that reshape a Layer's alpha edge at paint
time, so a cutout's halo disappears on saturated backgrounds. They amend this
ADR's accepted paint order (DEC-006) — recorded here, not overridden in code:

- **Fact shapes (DEC-005)**: `rev.choke?: number` — an inward alpha-erode
  radius in Layer-local px — and `rev.feather?: number` — a Gaussian
  alpha-edge softening radius (σ) in Layer-local px. Both are absolute
  setters with a documented range of `0..256` px (the same bounded-effect
  footprint as the blur; the choke's erode also chains under the raster
  morphology cap the outline and glow obey). `0` is each removal form and
  the identities are never stored: absence IS the canonical no-fact form,
  so removal drops the field and every reader treats absence as none. One
  normalization boundary per fact (`normalizeStoredChoke`,
  `normalizeStoredFeather`), one resolve path per fact (`resolveEditChoke`,
  `resolveEditFeather`, shared by the edit and one-command add surfaces);
  the revision hash appends each only when present. They follow ADR-0013
  sharing and fork rules and replay byte-identically from retained Render
  manifests.
- **Paint order position**: a new step **5. Edge choke & feather** between
  Grade (4) and Edge glow (the former 5, now 6; the later steps renumber) —
  the FIRST function of the outer element's effects filter chain
  (`choke/feather → glow → outline → shadow → blur`). The alpha edge must be
  shaped BEFORE the effects that read it: the glow band paints just inside
  the shaped edge, the outline dilates the shaped ink, the shadow is cast
  from the outlined shaped composite, and the blur (#299) stays the LAST
  function. One SVG filter per Layer with either fact: `feMorphology erode`
  the source alpha by the choke (chained under the same raster cap as the
  outline's dilate), `feGaussianBlur` the eroded alpha by the feather (the
  matte rule — the choke moves the edge, the feather rounds it), then
  `feComposite operator="in"` the source graphic through the shaped alpha.
  Emitted only when an edge fact exists, so pre-#300 revisions and their
  pinned Render history paint byte-identically.
- **The ink never grows — the edge step adds NO reach**: the final `in`
  composite bounds the output alpha by the SOURCE's alpha everywhere
  (output α = source α × shaped α), so the painted ink never exceeds the
  unshaped ink: the choke erodes it, the feather softens it INWARD only,
  and even where the feather's Gaussian tail would spread the shaped mask
  outward past the original edge, the source-alpha bound clips it. The
  alpha-edge step therefore adds no term to the ONE local-reach reader
  (`localEffectReachPx` in `src/composition-measure.ts`) — it only reshapes
  (or shrinks) ink the outline, shadow, and blur terms already cover, and
  no second reach home is created. This is the deliberate opposite of the
  blur's growth (#299): choke and feather are matte corrections, not new
  ink, and keeping every painted pixel inside the retained content's own
  alpha is what makes halo removal safe.
- **Painted extents shrink (a DEC-005 exception, like the blur's growth)**:
  alpha coverage IS altered — that is the feature. `painted`,
  `paintedOnCanvas`, and `clipped` follow the rendered ink, so a choke
  shrinks the reported extents. Where the feather's inward tail (≈2.4σ of
  visible alpha at 8-bit) regrows past the choke, the extent returns toward
  the original edge but never past it.
- **Anchors never move**: the edge facts are effects, so anchored placement
  resolves against the pre-effect ink (#288, ADR-0025) — the same anchor
  lands at the same stored placement with and without the choke/feather, on
  add and on edit.
- **Reporting**: `composition measure` reports the effective radii as
  `choke` and `feather` (px, `null` when absent), beside the blur.
- **Not included**: an outward dilate form (grow the alpha edge), a
  per-side choke, or a mask-driven matte — each is fog until specified.

## Third amendment: the one-sided direction model joins the glow (#301)

The one-sided glow is a NEW direction model (spec #285 US-014, ISC-53,
DEC-008) that lets a rim light read as directional: at full strength from one
side, the opposite edge is unlit. It amends this ADR's accepted glow decision
(DEC-006) — recorded here, not overridden in code:

- **Two direction forms, one fact, one home (DEC-008)**: the glow fact gains
  an optional `direction: { angle, strength }` beside the legacy
  `angle`/`strength` pair. The legacy pair keeps today's meaning — the paint
  offsets the eroded interior mask opposite the light (the offset model), and
  its stored values keep it: existing glow revisions and their Renders replay
  byte-unchanged, their markup and revision ids pinned by test. The two forms
  are MUTUALLY EXCLUSIVE: a stored document or a `--glow` value carrying both
  is refused (malformed document / exit 2). Everything else is shared: one
  normalization boundary (`normalizeStoredGlow`), one boundary parse
  (`parseGlowSpec`), one revision-hash site (appending the direction only
  when present, so old ids never change), ADR-0013 sharing and fork rules,
  byte-identical replay. No second home for glow is created.
- **CLI grammar**: `--glow "<width>,<softness>,<color>,from <angle>,<strength>"`
  — the same width, softness, and colour grammar, with the direction pair
  spelled `from`. Setting the glow is an absolute setter as before; `from
  <angle>,0` normalizes to the even glow (the same strength-0 neutral rule
  as the legacy pair), and the stored angle is canonical in `[0, 360)`
  (`from -90,1` stores `270`). Refusals exit 2 naming the part and its
  range, on both command surfaces, through the one parser.
- **Angle convention (the same convention as the legacy pair)**: degrees
  clockwise from top, and the light comes FROM that direction — the source
  sits at direction `(sin a, −cos a)` in screen coordinates (y down). Angle
  `0` is light from above, `90` from the right, `180` from below, `270` from
  the left. The ISC-53 probe reads directly: angle `90`, strength `1` on a
  rectangle lights the right edge and leaves the LEFT edge unlit.
- **Strength between 0 and 1**: strength `s` is how much of the even band
  the far side LOSES, fading linearly along the light axis across the
  Layer's untransformed box — the far extent's band keeps `1 − s` of the
  even band, the lit extent keeps all of it, and edges perpendicular to the
  light fade along the axis with position. Strength `1` is fully one-sided:
  the opposite edge is unlit. Strength `0` drops the direction (the even
  glow). At strength `1` the far-edge band pixel holds at most ~half a
  pixel's worth of the ramp (the gradient's zero stop sits at the box
  extent; the pixel centre samples `~0.5/box-width` of the band) — no
  visible glow; the tests name the tolerance: a toward-glow change below
  `0.05` (~13/255 of the band after the filter's linear-space compositing).
- **Paint method**: the even band (erode → blur → `out` against the source
  alpha → flood → `in`) is unchanged, and the coloured band is weighted by a
  LINEAR ALPHA RAMP before the Porter-Duff atop: an `feImage` referencing an
  inline data-URI SVG whose `linearGradient` runs from the far extent
  (stop-opacity `1 − strength`) to the lit extent (opacity 1) across the
  element's box. The ramp's geometry is sized IN-PAGE by the same pass as
  the filter regions (`sizeEffectFilterRegions`): the `feImage`'s subregion
  is set to the element's real untransformed box and its href to the
  gradient computed for that box's real aspect, so the angle is measured in
  the Layer's local px — the same convention as the legacy pair, scaling
  with the Layer's scale like every effect. The in-page sizing is mandatory:
  objectBoundingBox percentage regions clip silently for large elements
  (ADR-0019's verified finding — proven again by test on a 1600×900 Layer,
  whose lit side must paint like the even glow's, no softening or offset),
  and objectBoundingBox PRIMITIVE units would reinterpret the erode radius
  as a box fraction (verified: it erases the band entirely), so primitive
  units stay the default userSpaceOnUse. The markup's placeholder is inert
  (a 1px transparent subregion — a skipped sizing paints no band, a visible
  defect, never wrong pixels), and the same deterministic rewrite runs in
  both page flows, so render and painted extents stay identical and pinned
  replay stays byte-identical. The weighted band feeds the same atop
  composite, so the composite's alpha is still exactly the source's: alpha
  coverage is never altered (DEC-005), painted extents equal the no-glow
  extents at every transform, and the ONE effect-reach reader
  (`localEffectReachPx` in `src/composition-measure.ts`) gains no term —
  the direction adds no reach. Emitted only when a direction fact exists,
  so pre-#301 markup stays byte-identical.
- **Reporting**: `composition measure`, `layer inspect`, and `layer review`
  report the stored direction inside the glow fact (`direction: { angle,
  strength }`), formatted as `one-sided from <angle>° (strength <s>)`;
  legacy-pair formatting is unchanged.
- **Not included**: a per-edge rim (two directions on one Layer), a ramp
  shaped by the ink rather than the box, or a falloff curve other than
  linear — each is fog until specified.

## Fourth amendment: the inner shadow joins the paint order (#303)

Spec #285's ticket #303 (US-011, ISC-64, DEC-005, ADR-0027) adds the inner
shadow — the inset counterpart of the drop shadow — as a stacked Layer
revision fact (`innerShadow`, one object or a stored list of two or more in
paint order), painting in the chain position between the edge glow and the
outlines:

- **Why there.** The inner shadow reads the alpha edge, so it sits after
  the edge step (its band hugs the shaped edge). Its filter's final
  `feComposite operator="atop"` keeps the composite's alpha EXACTLY the
  input's, so the effect preserves alpha coverage everywhere — placing it
  before the first alpha-extending effect (the outlines) keeps the outline
  dilate and drop-shadow casting geometry provably unchanged by its
  presence. Among the alpha-preserving edge effects, light precedes shade:
  the glow band paints first, and the darkening reads on the lit
  composite.
- **Why no reach term**: the atop composite bounds the output's alpha by
  the input's — the inner-shadowed ink never exceeds the unshadowed ink —
  so `localEffectReachPx` gains no term (the #300 edge-step precedent).
  The ISC-64 probe pins the extent-unchanged proof.
- **Direction convention**: the CSS inset box-shadow's — the band appears
  along the edge the offset moves AWAY from (dy +4 darkens the TOP inside
  edge, dx +4 the left inside edge; 0,0,blur rings all inside edges).
  The band is the input alpha MINUS the shifted, blurred alpha
  (`feComposite in="SourceAlpha" in2=<offset+blurred> operator="out"`);
  the reverse operand order selects pixels outside the shape, which the
  atop composite then erases, so nothing would paint.
- **Reporting**: `composition measure`'s `effects` facts, `layer inspect`,
  and `layer review` carry the normalized list per ADR-0027 (Reports are
  lists).
