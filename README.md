# Ply

Ply is becoming a general-purpose layered image composer.
[ISA.md](ISA.md) defines the destination; [CONTEXT.md](CONTEXT.md) defines its
accepted vocabulary. Two shipments are acceptance-audited against `main`:

- the composer foundation ([spec #77](https://github.com/kenneth-liao/ply/issues/77))
  — self-contained Projects, independently editable and reusable Layers,
  arbitrary-size Compositions, and replayable Render history, including
  integrated relocation/offline qualification;
- uniform source-image generation with caller-owned content policy, and
  independent local Matting ([spec #102](https://github.com/kenneth-liao/ply/issues/102))
  — including the retirement of the category-specific generation entry points.

Caller-parameterized region checking has shipped for Compositions
(`ply composition check`, [Region checking](#region-checking-new-surface))
along with the guideline overlay view (`ply composition guidelines`,
[Guideline view](#guideline-view)) and the comparison sheet
(`ply composition sheet`, [Comparison sheet](#comparison-sheet)); a starter
YouTube region file ships as a
copy-and-own template ([Starter region file](#starter-region-file)); the
legacy Scene surface still runs as documented under
[Legacy surface](#legacy-surface-preserved), and ADR-0014 records what
remains target for it.

## Current implementation

The composer surface is **Project**, **Composition**, and **Layer**:
caller-selected canvas dimensions, local image, text, and shape Layers,
generated and independently matted content ingested as ordinary Layers,
shared edits and forks, independent cross-Project copies, and local
deterministic Rendering. New work starts here — see
[Quick start](#quick-start), the sections below, and the `ply-operating` skill.

Models are optional source-asset producers. **Generation** is one uniform
operation (`ply generate`) with no subject category (ADR-0014): full-canvas or
isolated output intent is a request parameter, and no content policy is imposed
on the prompt. **Matting** is a separate caller-invoked local operation
(`ply matte`, ADR-0015). Final text and final composition stay local.
Category-specific generation and adoption are retired: the legacy
`jobs plates|objects|creators|rerun|adopt` and `library adopt` commands no
longer run, and their existing records remain inspectable (see below).

The preserved legacy workflow uses a versioned **Scene** for 1280×720 images
and is documented under [Legacy surface](#legacy-surface-preserved). It is not
the entry path for new work, and its terms are not the target glossary.
Architectural decisions are in [docs/adr/](docs/adr/); the user guide's
[Limits and render quality](docs/guide/limits.md) page collects the size,
quality, and refusal limits a caller can hit (index: [docs/guide/](docs/guide/)).

## Projects and Compositions (new surface)

The end-to-end operating route — import or generate, optional Matting, Layer
ingestion, measurement and edits, Render and pixel review, with the chosen
defaults — is taught in [.agents/skills/ply-operating/SKILL.md](.agents/skills/ply-operating/SKILL.md)
(the `ply-operating` skill). Content-policy practice is a separate
authority: see [.agents/skills/visual-authoring/SKILL.md](.agents/skills/visual-authoring/SKILL.md).

The composer workflow runs through `ply project`, `ply composition`, and
`ply layer` — see [Quick start](#quick-start) for the commands,
`ply <module> --help` for each module's operations, and
[docs/project-storage-contract.md](docs/project-storage-contract.md) for the
full contracts.

Placement coordinates accept two equivalent syntaxes — a separate dash-leading
number and the equals form — so negative and fractional placement can be
written either way (`--x -40` or `--x=-40`, `--y -.5` or `--y=-.5`); a
following option is never consumed as a number, and Layer effects' numeric
values (`--rotate`, `--shadow`, `--outline`) accept both forms too.

**One-command Layers (#229):** `composition add` accepts every placement,
transform, effect, and text option `ply layer edit` accepts for that Layer
kind, with identical spelling, validation, and refusal texts — so a Layer is
created in its final state with one command. The options apply in the
documented order — content, then content-level paint (`--vector-color`),
then transforms (`--resize`, `--scale`, `--rotate`, `--flip`), then the
visible region, then anchored placement (`--anchor`), then effects
(`--shadow`, `--outline`) — and publish exactly one Layer revision; any
refused option publishes nothing (no Layer, no use, no content). The
one-command Layer renders and measures identically to the same Layer built by
the multi-command sequence, and its Render replays byte-identically. On
`layer edit`, `--anchor` cannot combine with `--shadow`/`--outline`,
`--vector-color`, or `--visible-region` (the
reference ink would be ambiguous); on `add` the combination is defined by the order —
the anchor resolves the content, colour, transform, and region ink in the
target Composition's
canvas, and the effects are then applied to the same single revision. On
`add`, `--width` is the text width axis (the same spelling `layer edit`
uses); the canvas dimension meaning of `--width` belongs to `composition
create` alone.

**Stack position (#230):** a new Layer lands on top by default; `--position`
says where it goes in paint order instead — `--position bottom` (painted
beneath everything), `--position before:<use-name>` / `--position
after:<use-name>` (before or after an existing use), or `--position top`
(explicit default). `composition import` takes the same `--position` for
the imported set, which stays contiguous and in source order. Paint order
stays owned by the Composition's ordered use list: the position is a
creation-time argument, never a Layer revision fact, so no Layer revision
stores one and `layer edit` has no position option. An unknown use name is
refused before anything is published — no Layer, no use, no content —
naming the Composition's use names.

Layers are addressable by name wherever a Layer id is accepted (`layer edit`,
`layer inspect`, `layer review`): a Composition-plus-use form
`<composition>/<use>` — for example `poster/headline` — resolves to the
referenced Layer's id at the command boundary, so ids never need capturing or
storing. A slash always means an address (a Layer id can never contain one),
so the form is unambiguous and needs no shell quoting. Unknown Compositions
and uses are refused listing what exists; nothing is published. Layer ids
continue to work everywhere. Sharing rules are unchanged: a name address to a
shared Layer still requires `--in-place` or `--fork`, and with `--fork` the
address supplies the target Composition and use, so `--composition`/`--use`
need not be repeated (repeating them must match the address).

## Uniform generation (new surface)

`ply generate` is one source-image generation operation with no subject
category: full-canvas or isolated output intent is a request parameter, and
no content policy is imposed on the prompt (ADR-0014). It publishes a
Generation Job record with the effective request, content-addressed outputs,
and provenance under `out/generation/` — see
[docs/generation-publication-contract.md](docs/generation-publication-contract.md)
for the record schema and publication contract.

Omitting `--model` selects **nano-2** (effective
`google/gemini-3.1-flash-image`) — the tool-wide default for general
generation. An explicit `--model` selection always takes precedence over
the default. Explicit quality selection (`--quality low|medium|high`) is
qualified only for the GPT Image models whose tiers were proven through the
Gateway — `ply generate --help` lists them — other models acquire no quality tiers, an
unsupported model/quality combination is refused before any provider call, and
omitting `--quality` leaves the provider's own default with no quality recorded
in the Job.

```bash
ply generate "a red barn at noon" --model gpt-image --size 1080x1080 --quality low
ply generate "a presenter portrait" --intent isolated --model nano-2
ply generate "restyle this room" --ref room.png --ref palette.png
ply generate show <jobId>   # offline inspection of the published record
ply generate list
ply generate review <jobId>   # offline evidence sheet: References, outputs, matte
```

Isolated intent is a generation request, not a matte: it never runs Matting
and never reports verified alpha — the independent Matting operation stays
caller-invoked (ADR-0015). References (`--ref <path>`, repeatable) are local
files attached in caller order: identities are derived at Job creation, bytes
are verified against them at generation, and missing or changed files fail
before any provider call — no remote fetching, no mandatory identity
Reference, no roles. The retired `jobs plates|objects|creators` pipeline no
longer exist; `jobs` now only inspects its existing records.

## Independent Matting (new surface)

`ply matte` is one independent local Matting operation on a caller-selected
local PNG: no Generation Job, no library adoption, no network, no billed hop
(DEC-004, ADR-0015). A source that already carries a real matte is kept as-is
with no inference (engine `native-alpha`); anything else runs through the
pinned BiRefNet Dynamic segmenter on PyTorch/MPS — engine preflight verifies the
weights before inference, and the single inference process asserts MPS before
writing any mask. Missing or mismatched weights, or a machine without MPS,
are refused before anything is published. The source bytes are never
modified; the verified true-alpha result and its provenance are published
under `out/matting/` — see
[docs/matting-publication-contract.md](docs/matting-publication-contract.md)
for the record schema and publication contract.

```bash
ply matte photo.png
ply matte out/generation/<jobId>/outputs/<sha256>.png --id my-cutout
```

The input is PNG only — convert other formats locally with an offline tool
first. Matting never generates content and never touches Projects or Layers.

## Evidence review (new surface)

`ply generate review <jobId>` writes a self-contained HTML sheet beside the
published record — `<jobDir>/review.html` — showing the exact ordered
References, every generated output, and the associated matte where one
exists, each verified against its recorded sha-256 identity before display.
After ingestion, `ply layer review <layerId> --out <path>` builds the same
kind of sheet from retained Project evidence, so review keeps working
offline after the external `out/` files are gone and the Project has moved:

```bash
ply generate review <jobId>
ply layer review <layerId> --out review.html
```

Unavailable Reference files are labeled with their recorded identity — never
substituted, never invented. The sheets are evidence for your own
likeness/matte review; nothing in them implies approval or promotion
(ADR-0014).

Both new results become ordinary Project Layers through the composer surface:
`ply composition add --from-matte <matteId>` and
`ply layer edit <layerId> --from-matte <matteId>` ingest a published matte's
verified output (and `--from-generation <jobId>` a generated output, #107).
The matte's provenance — and, when the matte's source was a generated output,
that job's provenance — is retained verbatim inside the Project and resolves
offline after the external `out/` files are removed and the Project is
relocated; see
[docs/project-storage-contract.md](docs/project-storage-contract.md).

## Layer resize (new surface)

`ply layer edit` resizes Layers locally without ever replacing source
content (ADR-0016) — resizing changes placement, never retained pixels:

```bash
ply layer edit <layerId> --resize 2        # relative: current scale × 2
ply layer edit <layerId> --scale 2         # absolute: the scale IS 2
ply layer edit <layerId> --resize-to 800x  # absolute size, aspect preserved
ply layer edit <layerId> --resize-to 800x600   # deliberate aspect change
```

- `--resize <factor>` works on image and text Layers. It is **relative**: the
  new scale is the current scale multiplied by the factor, so the same
  command twice keeps enlarging (2 then 2 gives 4×). The aspect ratio is
  always preserved. Every result (text and JSON) reports the absolute
  effective scale and, for image Layers, the absolute effective size.
- `--scale <factor>` (#231) is the **absolute** alternative: it sets the
  Layer's canonical scale (uniform, both axes), replacing any previous
  scale, so repeating the command never compounds — `--scale 2` twice is
  still 2×, and it is safe to repeat during iteration. Works on image and
  text Layers, writes the one canonical scale representation (no second
  scale field), and never changes retained pixels. Mutually exclusive with
  `--resize` and `--resize-to` (and with content replacement, like the
  other resize forms); refused before anything publishes.
- `--resize-to <WxH>` is image-only (text has no intrinsic pixel size).
  Supplying one axis (`800x`, `x600`) preserves the Layer's current aspect
  ratio — a deliberate aspect change survives later one-axis resizes;
  supplying both deliberately changes it. Repeating an absolute target is
  idempotent.
- The Layer's `(x, y)` stays its top-left corner: it grows/shrinks right and
  down. Scale is a Layer revision fact shared as a whole (in-place edits
  propagate, forks isolate), survives sharing and cross-Project import, and
  participates in pinned Render history — replaying a pre-resize Render
  still reproduces its original pixels exactly.

## Layer rotation (new surface)

`ply layer edit` rotates Layers about their `(x, y)` top-left placement
point without ever replacing source content (ADR-0016) — rotation changes
placement, never retained pixels:

```bash
ply layer edit <layerId> --rotate 45    # set rotation to 45°
ply layer edit <layerId> --rotate -30   # negative = counter-clockwise
ply layer edit <layerId> --rotate 0     # remove the rotation
```

- `--rotate <deg>` takes an **absolute** angle in degrees: it replaces any
  previous rotation, so the same command twice is still the same angle
  (`--rotate 45` twice is 45° — unlike the relative `--resize` factor, it is
  never incremental), and `--rotate 0` removes the rotation. Positive degrees
  rotate clockwise. Works on image and text Layers and combines with other
  edit options, including `--resize` and content replacement.
- Rotation applies **after scale**: the content stretches along its own axes
  and the stretched result then rotates. Rotation is a Layer revision fact
  shared as a whole (in-place edits propagate, forks isolate), survives
  sharing and cross-Project import, and participates in pinned Render
  history — replaying a pre-rotation Render still reproduces its original
  pixels exactly.

## Layer flip (new surface)

`ply layer edit` flips Layers about their `(x, y)` placement point without
ever replacing source content (ADR-0016) — flipping changes placement, never
retained pixels:

```bash
ply layer edit <layerId> --flip horizontal   # mirror left–right
ply layer edit <layerId> --flip vertical     # mirror top–bottom
ply layer edit <layerId> --flip both         # mirror both axes
ply layer edit <layerId> --flip none         # remove the reflection
```

- `--flip <mode>` takes an **absolute** reflection state: it replaces any
  previous flip, so the same command twice keeps the same state (it is never
  a toggle), and `none` removes the reflection. Horizontal mirrors along the
  content's own vertical axis, vertical along its horizontal axis. Works on
  image and text Layers and combines with other edit options, including
  `--resize`, `--rotate`, and content replacement.
- Flip applies **with scale, before rotation**: the content reflects along
  its own axes, then scale stretches and rotation rotates the reflected
  result. The footprint mirrors to the other side of the placement point's
  axis line (a 100px-wide Layer at `x=100` flipped horizontally paints
  `x ∈ [0, 100]`), exactly as rotation moves its footprint about the same
  origin. Flip is a Layer revision fact shared as a whole (in-place edits
  propagate, forks isolate), survives sharing and cross-Project import, and
  participates in pinned Render history — replaying a pre-flip Render still
  reproduces its original pixels exactly.

## Layer measurement (new surface)

`ply composition measure` reports read-only Layer layout boxes and painted
extents in Composition coordinates, including the current scale, rotation,
and reflection (DEC-004 — measurement and painting share one geometry and
font authority):

```bash
ply composition measure poster                       # every Layer
ply composition measure poster headline              # one use
ply composition measure poster --json                # machine-readable
```

- For each Layer it reports the untransformed **content box** (image:
  intrinsic retained size; text: the line-box layout extent of the Layer's
  retained font bytes at its font size), the **box** (axis-aligned bounding
  box of the transformed content rectangle, unclipped), and the
  transformed rectangle's **corners**. A variable-font text Layer's report
  includes its stored weight and width (the `axes` facts #179) — the same
  values painting applies — and its stored tracking and line height when
  set (the `typography` facts #187). A caller font's report names the
  font's own family and marks it caller-supplied (the `font` fact #232).
- It also reports the **painted extents**: the visible-ink (alpha > 0)
  bounding box in the same coordinates — image transparent padding is
  excluded from painted but kept in content, and text painted bounds are
  tight glyph ink rather than the line-box extent — plus
  **paintedOnCanvas** (the painted extent's intersection with the canvas,
  the footprint that actually shows in a render) and **clipped** (whether
  painted ink falls outside the canvas, judged against painted extents,
  never the layout box). Content with no visible ink (fully transparent
  content or opacity 0) reports `painted: null`. Painted values are
  two-decimal rounded: ink is quantized to the capture window's pixel
  grid, while canvas offsets are layout-derived and may be fractional.
  Capture is bounded — one windowed screenshot per Layer, never scaled by
  off-canvas distance and widened by each Layer's effect extent; a Layer
  too large to capture is refused with an actionable error instead of
  growing memory (the bound and the ≤1 px tolerances:
  [Limits and render quality](docs/guide/limits.md)).
  Painted bounds are the
  browser's own paint of the exact markup rendering uses, so
  measurement and rendering agree; opacity scaling
  changes alpha values, never the ink footprint. A Layer's effects extend
  its painted ink: painted bounds, the on-canvas intersection, `clipped`,
  and the `effects` facts include the effect extent (#139, #140).
- Text dimensions are measured with the same retained font bytes painting
  uses — never a second measuring authority. Corrupt content or an
  unresolved font fails instead of producing misleading numbers.
- The query writes nothing to the Project, works offline, and never
  requires a billed operation.

## Layer anchors (new surface)

`ply layer edit --anchor` places a Layer's **visible painted ink** at a
requested target position, instead of targeting the top-left corner of its
content box (ADR-0017):

```bash
ply layer edit <layerId> --anchor center,center --x 960 --y 540
ply layer edit <layerId> --anchor center,bottom --x 960 --y 1070
ply layer edit <layerId> --anchor right --x 300  # horizontal only: --x is the target
ply layer edit <layerId> --anchor center,top --x 100 --y 200
```

- Horizontal values are `left|center|right` (anchoring `--x`), vertical
  values `top|center|bottom` (anchoring `--y`); a pair like
  `center,center` anchors both, in that order. A single value anchors one
  axis only (`left`/`right` are horizontal, `top`/`bottom` vertical); a
  coordinate supplied for the unanchored axis still applies as a plain
  placement edit, and the report states exactly what publishes. A
  bare `center` is ambiguous and refused — name both, e.g. `center,center`.
- **The anchor box is the painted ink box** (alpha > 0 for images, tight
  glyph ink for text — exactly the `painted` extents `ply composition
  measure` reports, unclipped), never the layout content box: transparent
  padding does not count. A padded image's visible subject lands at the
  target while its layout box extends into the padding side; a centered
  headline centers its glyph ink. A Layer with no visible ink (fully
  transparent content, opacity 0) refuses instead of falling back to the
  layout box.
- **Transform interaction:** resolution runs against the Layer's CURRENT
  scale/rotation/reflection (the rotated ink box is what gets anchored),
  and anchored placement is its own edit — it cannot be combined with
  `--resize`, `--scale`, `--rotate`, `--flip`, shape parameters
  (`--shape`, `--size`, `--corner-radius`, `--fill`), `--vector-color`,
  `--visible-region`, `--shadow`, or content
  replacement in one edit, because the reference ink would be ambiguous. `--opacity`
  combines freely. A later transform or content edit keeps the resolved
  x/y literally; re-anchor explicitly after changing the geometry.
- **Resolution contexts:** a text Layer's ink depends on the referring
  Composition's canvas width (text wraps), and placement is one shared
  fact, so the resolution measures the Layer in every referring
  Composition and refuses — naming the affected compositions — when the
  resolved placements disagree. Unreferenced Layers resolve standalone on
  an unwrapped line. A fork resolves in its target Composition.
- **One-shot representation (ADR-0017):** anchored placement is resolved
  once through the paint-identical ink measurement (accurate to its pixel
  grid, ~1px) and written into plain canonical placement (x, y). No anchor
  facts are stored, so sharing, forks, cross-Project import, and pinned
  Render history preserve anchored placement verbatim with no alternate
  per-Composition placement state, and pinned replay stays deterministic.
  `ply composition measure` verifies where the ink landed; invalid inputs
  (exit 2) and semantic refusals (exit 1) never mutate live state.

## Layer shadows (new surface)

`ply layer edit --shadow` applies a drop shadow to a Layer's content —
image alpha and text glyphs alike, one uniform effect with no
kind-specific lifecycle (ADR-0018):

```bash
ply layer edit <layerId> --shadow "10,10,4,#000000"    # soft black shadow
ply layer edit <layerId> --shadow "0,2,6,#00000080"    # alpha-softened
ply layer edit <layerId> --shadow none                 # remove (its own edit)
```

- The spec is an ABSOLUTE setter `"<dx>,<dy>,<blur>,<color>"` that replaces
  any previous shadow (the same command twice keeps the same shadow);
  `"none"` removes it. Offsets are px within ±256 (negative is valid),
  blur is a px radius between 0 and 256, and the color is hex —
  `#RGB`, `#RRGGBB`, or `#RRGGBBAA` (alpha softens the shadow).
- **Ordering contract:** the shadow paints in the Layer's LOCAL coordinate
  space — the canonical transform (scale/rotation/flip about `(x, y)`)
  then maps content and shadow together, the Layer's opacity fades both,
  and canvas clipping applies to the shadow-extended result. A rotated
  Layer's shadow rotates with it.
- **Painted bounds include the shadow:** `ply composition measure` reports
  the shadow-extended ink in `painted`/`paintedOnCanvas`/`clipped` and the
  effective shadow settings in the `effects` facts; anchored placement
  (`--anchor`) resolves against the same shadow-extended painted ink — one
  definition of painted ink. Because anchoring is one-shot, a shadow edit
  never moves an already-resolved placement; anchoring with a shadow
  centers the composite (content + shadow). `--anchor` and `--shadow`
  cannot combine in one edit — make the effect edit first, then anchor.
- **Revision fact (DEC-002):** the shadow is shared as a whole like
  placement and transform — in-place edits propagate it, forks isolate it,
  cross-Project copies preserve it verbatim, and it participates in the
  revision hash (a shadow edit is a new revision). Retained source bytes
  never change. A shadow edit is its own revision field, appended to the
  hash only when present, so pre-#139 revisions keep their exact ids and
  pinned Render history replays byte-identically.
- Invalid settings fail at the command boundary (exit 2) through the same
  parser the edit path uses — nothing invalid ever mutates live state.

## Layer outlines (new surface)

`ply layer edit --outline` applies a solid outline to a Layer's content —
image alpha and text glyphs alike, one uniform effect with no
kind-specific lifecycle (ADR-0019):

```bash
ply layer edit <layerId> --outline "4,#000000"     # 4px black outline
ply layer edit <layerId> --outline "2,#ff8800"     # replaces any previous outline
ply layer edit <layerId> --outline none            # remove (its own edit)
```

- The spec is an ABSOLUTE setter `"<width>,<color>"` that replaces any
  previous outline (the same command twice keeps the same outline);
  `"none"` removes it. Width is a px thickness between 0 and 256 and the
  color is hex — `#RGB`, `#RRGGBB`, or `#RRGGBBAA`. Color forms
  canonicalize at the command boundary: `#4C4C4C` and `#4c4c4c` are the
  same outline, so case/shorthand variants of the same paint cannot mint
  redundant revisions.
- **Ordering contract:** the outline hugs the content in the Layer's
  LOCAL coordinate space, painted BEFORE the shadow — a shadow on the
  same Layer is cast from the outlined composite — and the canonical
  transform then maps content, outline, and shadow together, with the
  Layer's opacity fading all of it and canvas clipping applied to the
  effect-extended result. The ring is an exact geometry: an
  `feMorphology` dilate extends the content's alpha by exactly `width`
  px in every direction, so painted ink and measurement reach agree
  exactly (ADR-0019). Every successful render draws that full ring —
  over Chromium's raster cap it is drawn as chained dilate steps, never
  refused; [Limits and render quality](docs/guide/limits.md) states the
  width bound, the visible-width rule, and the measured cost (ADR-0019,
  ADR-0022).
- **Painted bounds include the outline:** `ply composition measure`
  reports the outlined (and shadowed) ink in
  `painted`/`paintedOnCanvas`/`clipped` and the effective outline
  settings in the `effects` facts; anchored placement (`--anchor`)
  resolves against the same effect-extended painted ink — one definition
  of painted ink. A later outline edit never moves an already-resolved
  placement; anchoring first then adding the outline keeps the resolved
  x/y literally. `--anchor` and `--outline` cannot combine in one edit —
  make the effect edit first, then anchor.
- **Revision fact (DEC-002):** the outline is shared as a whole like
  placement and transform — in-place edits propagate it, forks isolate
  it, cross-Project copies preserve it verbatim, and it participates in
  the revision hash (an outline edit is a new revision). Retained source
  bytes never change. The outline is its own revision field, appended to
  the hash only when present, so pre-#140 revisions keep their exact ids
  and pinned Render history replays byte-identically.
- Invalid settings fail at the command boundary (exit 2) through the same
  parser the edit path uses — nothing invalid ever mutates live state.

## Visible region (new surface)

`ply layer edit --visible-region` shows only a rectangular part of a
Layer's content — on image, text, and shape Layers alike — without touching
the file (spec #207 US-003, ADR-0023):

```bash
ply layer edit <layerId> --visible-region "120,80,640,360"   # frame the subject
ply layer edit <layerId> --visible-region "0,0,200,100"      # replaces any previous region
ply layer edit <layerId> --visible-region none               # remove (its own edit)
```

The region's corners take an optional radius (`--visible-region-radius`,
#212) — a screenshot gets rounded corners inside Ply:

```bash
ply layer edit <layerId> --visible-region-radius 12   # round the region's corners
ply layer edit <layerId> --visible-region-radius none # remove the radius (0 works too)
```

- The spec is an ABSOLUTE setter `"<x>,<y>,<width>,<height>"` in the
  Layer's OWN content pixels, relative to the content box's top-left, that
  replaces any previous region (the same command twice keeps the same
  region); `"none"` removes it. A region outside the content, or one with
  zero area, is refused before publication — live state unchanged. A text
  Layer's content box is its measured line-box extent (the unwrapped
  standalone line); image and shape Layers validate against their stored
  intrinsic facts.
- **Ordering contract (DEC-004):** the region crops the content FIRST —
  content, visible region, outline, shadow, then transform and opacity —
  so shadow and outline hug the region's edge instead of the full content
  edge. Content outside the region is not ink.
- **Geometry follows the region (DEC-005/DEC-006):** painted extents, the
  on-canvas footprint, and `clipped` follow the region (`ply composition
  measure` reports the region in the `visibleRegion` facts), anchored
  placement resolves against the region-clipped visible ink, and the
  measurement capture window is judged against the region — a large
  padded source refused uncropped at a given scale measures once cropped
  to its subject. The placement point and transform origin stay defined
  against the FULL content box, so setting or removing a region never
  moves the remaining pixels on the canvas.
- **Revision fact (DEC-002):** the region is shared as a whole like
  placement and effects — in-place edits propagate it, forks isolate it,
  cross-Project copies preserve it verbatim, and it participates in the
  revision hash (a region edit is a new revision). Removing it restores
  the prior render byte-for-byte (ISC-38): set-then-remove renders
  byte-identically to never-set. Retained content bytes, Generation Job
  lineage, and Matting lineage never change. The region is appended to
  the hash only when present, so pre-#211 revisions keep their exact ids
  and pinned Render history replays byte-identically (DEC-010).
- One-command `composition add` accepts `--visible-region` in the
  documented order — content, content-level paint, transforms, region,
  anchored placement, effects — so `--anchor` resolves the region-clipped
  ink on add (the
  framing use case: add, crop, and center in one command). On `layer
  edit`, `--anchor` and `--visible-region` cannot combine in one edit —
  make the region edit first, then anchor — and the region cannot combine
  with content edits (content replacement, text content and style, shape
  parameters), because it is validated against the content box. It
  combines freely with placement, transforms, shadow, and outline.
- **Content edits re-validate a kept region:** replacing or reshaping the
  content in a later edit (a new `--image`, `--text`, or shape geometry)
  re-validates the kept region against the NEW content box before anything
  is published — a region that no longer lies inside is refused naming the
  fix (adjust or remove it first); one that still fits publishes with a
  stderr note that the kept region now frames the replaced content. The
  region is left-anchored and additive by design: the optional corner
  radius joins the same fact (#212) without reshaping stored
  revisions.
- **Corner radius (`--visible-region-radius`, #212):** an absolute setter in
  px that edits and removes INDEPENDENTLY of the rectangle — `none` or `0`
  removes it, an omitted option preserves it (even when the rectangle is
  re-set, provided it still fits: a preserved radius that no longer fits
  the new rectangle is refused, never clamped). It obeys the SAME rule as a
  shape Layer's `--corner-radius` — a radius over half the region
  rectangle's shorter side is refused, never clamped, through the same
  validator — and a negative radius is refused at the command boundary. It
  needs a visible region (a positive radius without one, or combined with
  the region's removal, is refused; the removal forms are idempotent), and
  removing the region removes its
  radius. Corner pixels outside the radius are transparent, the outline and
  shadow follow the rounded edge, and painted extents stay the rectangle's.
  The radius rides the same revision hash field when present, so pre-#212
  revision ids do not move, and a Render with a rounded region replays
  byte-identically. One-command `composition add` accepts the radius beside
  `--visible-region`.

## Text weight and width (new surface)

Text Layers select their look with an optional `weight` and `width`, next to
`--font` and `--font-size`, on both `composition add` and `layer edit`
(ADR-0021). Ply renders only weights and widths the bundled font actually
contains — it never synthesizes one:

```bash
ply composition add poster display --text "Groundline" --font Archivo \
  --weight 800 --width 122 -p ~/projects/my-poster
ply composition add poster body --text "Hello" --font "IBM Plex Mono" \
  --weight 500 -p ~/projects/my-poster
ply layer edit <layerId> --weight 600 --width 100 --in-place
```

- **Variable fonts** (bundled: Archivo, `wght` 100–900, `wdth` 62–125): each
  value must fall inside the font's axis range — an out-of-range value is
  refused, naming the family and its allowed values. An omitted control
  resolves to the font's default instance (Archivo: 400 / 100), and the
  revision always stores the resolved pair.
- **Static fonts** (IBM Plex Mono 500 and every other pre-existing face):
  `weight` accepts only the face's own weight and `width` only the face's
  implicit width (100) — or omission — since the bytes already fix the
  look. The revision stores no axis fields.
- **Editing `--font`** keeps the current weight and width when the new font
  supports them; otherwise the edit is refused and names the one-command
  fix — nothing changes silently. Explicit `--weight`/`--width` on the same
  edit replace the carried values before validation, so a variable-font
  Layer switches to a static face in one edit — the refusal and the route
  are in [Limits and render quality](docs/guide/limits.md). When the
  current revision stores no axes, the new font's defaults apply.
- **Editing `weight`/`width` without `--font`** validates against the
  Layer's retained font: a caller font by its revision's stored facts, a
  bundled face by its content hash; if the retained bytes match no bundled
  face and no caller font is recorded, the edit requires `--font`.
- The stored axes are revision facts: they participate in the revision hash
  only when present, so pre-#179 revisions keep their exact ids and pinned
  Render history replays byte-identically. Paint and measurement both read
  the stored axes from the revision alone, and `composition measure` and
  `layer inspect` report them.

## Caller-supplied fonts

A text Layer can use any local TrueType or OpenType font file in place of a
bundled family, at add and at edit (#232): pass `--font-file <path>` where
`--font <family>` would go, on both `composition add` and `layer edit`.
The two are mutually exclusive — one font source per edit.

```bash
ply composition add poster wordmark --text "Groundline" \
  --font-file ~/fonts/PixelDisplay.ttf --weight 700 -p ~/projects/my-poster
ply layer edit <layerId> --font-file ~/fonts/OtherFace.otf --weight 400
```

- **Same retention path as bundled faces.** The file's bytes are retained
  in the Project by content identity exactly like a bundled face's, and
  the file's own facts — the family name its tables declare and its real
  weight/width ranges — are read once at ingestion and stored with the
  revision. Rendering, `measure`, replay, relocation, and cross-Project
  import never need the original file; the import carries the font bytes.
- **No synthesis, ever.** Weight and width validate against the axes the
  file really contains — a variable font's real fvar ranges, or a static
  face's own weight (and the implicit width 100 when the file has no
  `wdth` axis). Out-of-range values are refused naming the file's allowed
  range. The emitted CSS declares the face's real weight/stretch and
  disables font synthesis, so the browser can never paint a look the bytes
  do not contain.
- **Refused before publication.** A file that is not a usable font, and a
  file the rendering browser cannot resolve, are refused before anything
  is published — no Layer, no use, no content. The same family-resolution
  probe that guards every render re-verifies caller fonts at render time.
- **Later edits keep it.** An edit without a font option keeps the
  retained caller font; switching to a bundled family (`--font`) or to
  another file (`--font-file`) follows the existing carry-or-refuse rules
  for weight and width.
- **Reported honestly.** `layer inspect` and `composition measure` report
  the font's own family name and that it is caller-supplied. Licensing of
  a caller's font is the caller's concern; Ply records no opinion.
- Out of scope: font discovery, system fonts, remote fetching, subsetting,
  and a font library — callers pass a local file.

## Text tracking and line height (new surface)

Text Layers also select their typography with an optional `tracking`
(letter spacing, in em) and `lineHeight` (a unitless multiplier of the font
size), next to `--font-size`, on both `composition add` and `layer edit`
(ADR-0021). Both are font-independent:

```bash
ply composition add poster display --text "Groundline" --font Archivo \
  --tracking -0.032 --line-height 0.88 -p ~/projects/my-poster
ply composition add poster utility --text "Hello" --font Archivo \
  --tracking 0.16 -p ~/projects/my-poster
ply layer edit <layerId> --tracking -0.032 --line-height 0.88 --in-place
```

- **Ranges**: `--tracking` accepts −0.5 to 1 (em, inclusive);
  `--line-height` accepts 0.5 to 3 (inclusive). An out-of-range or
  non-numeric value is refused before anything is published, naming the
  control and its allowed range — a usage error (exit 2).
- **Omitted means normal.** A control that is not set stores nothing, and
  the text paints exactly as it would without the control: normal letter
  spacing and the font's own line height.
- **One stored form per look.** `tracking` 0 is the same look as no
  tracking, so it is stored as absent — the stored field is never 0.
- **Clearing on edit:** `--tracking 0` removes stored tracking and
  `--line-height normal` removes stored line height. A control that is not
  given on an edit keeps its current value — including edits that change
  `--font`, because tracking and line height do not depend on the font.
- The stored fields are revision facts: each participates in the revision
  hash only when present, so pre-#187 revisions keep their exact ids and
  pinned Render history replays byte-identically. Paint and measurement
  both read the stored values from the revision alone and emit the same
  markup (`letter-spacing:<n>em`, `line-height:<n>`), so measured and
  rendered text agree, including the line-box height line height changes.
  `layer inspect` and `composition measure` show both values when they are
  set.

## Shape Layers (new surface)

A shape Layer (#208) is a filled geometric region created from parameters
alone — no image file is read and no image bytes are stored. Its content IS
its parameters: a geometry (rectangle with an optional corner radius, or
ellipse), a width and height in canvas px, and ONE fill. The fill is one
discriminated value (#210, DEC-003): a solid colour — a hex value like
`#22c55e`, `#2c5`, or `#22c55e80` (alpha allowed), optionally with the
explicit `solid:` prefix — or a gradient:

- `linear:<angle>deg,<stop>,<stop>[,...]` — a linear gradient over the
  shape's box at the given angle (degrees clockwise from bottom-to-top,
  the CSS convention; `-45deg` and `315deg` are the same fill).
- `radial:<stop>,<stop>[,...]` — a radial gradient radiating from the box's
  centre, a circle whose radius reaches the box's farthest side (the last
  stop's colour lands exactly on the box's farthest edge midpoints — only
  those on the farthest side).

A stop is `<color>` or `<color>:<position>` — position 0–100 percent (the
`%` suffix is optional); omitted positions interpolate evenly between the
surrounding explicit positions (0 at the start, 100 at the end), and a
stop colour takes the same hex forms as a solid (alpha allowed).

```bash
# A highlight bar and a pill — parameters only, nothing to draw in advance:
ply composition add poster bar --shape rectangle --size 420x90 \
  --fill "#1d4ed8" --x 60 --y 300 -p ~/projects/my-poster
ply composition add poster pill --shape rectangle --size 220x44 \
  --corner-radius 22 --fill "#22c55ecc" -p ~/projects/my-poster
# An ellipse and a full-canvas background (an ordinary shape Layer):
ply composition add poster dot --shape ellipse --size 80x60 --fill "#ff000080" -p ~/projects/my-poster
ply composition add poster bg --shape rectangle --size 1280x720 --fill "#101828" -p ~/projects/my-poster
# Gradients (#210): a left-to-right linear ramp and a centred radial glow —
# stops accept alpha and explicit positions (0–100 percent, % optional):
ply composition add poster ramp --shape rectangle --size 420x90 \
  --fill "linear:90deg,#1d4ed8,#22c55e" -p ~/projects/my-poster
ply composition add poster glow --shape ellipse --size 220x160 \
  --fill "radial:#ff000080,#ffcc0000:70,#00000000" -p ~/projects/my-poster
ply composition add poster banded --shape rectangle --size 300x80 \
  --fill "linear:45deg,#1d4ed8:20%,#e11d48:80%" -p ~/projects/my-poster
# One-command add and the shared transform/effect options work as for any
# other Layer kind; --resize-to resolves against the shape's --size geometry:
ply composition add poster hero --shape rectangle --size 100x50 --fill "#1d4ed8" \
  --anchor center,center --rotate 12 --shadow "2,3,4,#000000" -p ~/projects/my-poster
# Gradient text (#222): a text Layer's --color accepts the same fill grammar,
# spanning the text ink box and automatically re-spanning across text or typography edits:
ply composition add poster title --text "HEADLINE" --font "Anton" --font-size 64 \
  --color "linear:90deg,#ff0000,#00ff00" --x 40 --y 50 -p ~/projects/my-poster
ply layer edit <layerId> --color "radial:#ff0000,#0000ff" -p ~/projects/my-poster
```

Non-positive size, a negative or oversized corner radius (0 to half the
shorter side — a larger radius would be silently clamped, so it is refused
instead of pinned with parameters its paint would not obey), a radius on an
ellipse, and a malformed fill — a malformed colour, fewer than two stops,
an out-of-range position, or a decreasing stop list (#210) — are refused
before anything is published, naming the fault and live state stays
unchanged. On `layer edit` each shape parameter
(`--shape`, `--size`, `--corner-radius`, `--fill`) is an absolute setter
(#209): an omitted parameter keeps its value, an invalid value is refused
without advancing live state, and a Layer's kind is stable — a shape cannot
become image or text by edit, and the reverse. `--size` is the shape's
intrinsic pixel size, so `--resize-to` resolves against it like an image's
dimensions (text has no intrinsic pixel size and keeps that restriction);
`--size` and the resize forms are separate edits. Position, opacity, scale,
rotation, flip, anchored placement, shadow, and outline work on shape
Layers as on any other kind. `inspect`, `measure`, and `layer review`
report a shape Layer's parameters; `measure` reports its content box,
transformed box, and painted extents like any other Layer. Cross-Project
import and fork give the shape an independent identity with equal
parameters, and a Render containing a shape replays byte-identically after
later edits and Project relocation — a shape's content identity is derived
from the canonical parameter form, so there is nothing to retain and
nothing to lose.

Refitting a shape is an edit, not a remake (#209) — each parameter is an
absolute setter, an omitted parameter keeps its value, and kind is stable:

```bash
# Refit the bar to a new headline: absolute size and fill, geometry kept:
ply layer edit <layerId> --size 560x110 --fill "#e11d48" -p ~/projects/my-poster
# The fill setter takes gradients through the same grammar:
ply layer edit <layerId> --fill "radial:#22c55e,#101828" -p ~/projects/my-poster
# Round the corners (0 removes the radius); switch the geometry:
ply layer edit <layerId> --corner-radius 24 -p ~/projects/my-poster
ply layer edit <layerId> --shape ellipse -p ~/projects/my-poster
# Placement, transforms, and effects work as on any other Layer:
ply layer edit <layerId> --anchor center,center --x 640 --y 360 -p ~/projects/my-poster
ply layer edit <layerId> --shadow "0,4,8,#00000066" -p ~/projects/my-poster
```

## Vector images (new surface)

`--image` accepts a local SVG file (#213, spec #207 US-004) at add and at
edit. An SVG is image-kind content with a recorded vector format — not a
fourth Layer kind: `inspect` and `measure` report it like any other image
Layer, with `format: "svg"` and the intrinsic size parsed from the file's
own `width`/`height` attributes (or, when those are missing or percent-based,
its `viewBox`). The file's bytes are retained in the Project unchanged —
never rewritten, never rasterized into stored pixels.

Rendering paints the vector through the browser's image path (an `<img>`
data URL, which disables scripts and external loads by construction — the
vector is never inlined into the page DOM) and rasterizes it at the painted
size and supersample factor, so the same file is crisp at 60 px and at 600
px — one import serves every size, with no `rsvg-convert` step.

```bash
# The official mark, crisp at any size — no rasterizing step first:
ply composition add poster logo --image ~/brand/logo.svg --x 60 --y 300 -p ~/projects/my-poster
# Scale it up; the render re-rasterizes the vector at the painted size:
ply layer edit <layerId> --scale 4 -p ~/projects/my-poster
# An SVG replaces a raster by edit and vice versa — the content option is
# --image either way; the format fact follows the new bytes:
ply layer edit <layerId> --image ~/brand/logo.svg -p ~/projects/my-poster
```

Transforms, anchored placement, shadow, outline, the visible region,
`measure`, replay, relocation, and cross-Project import all work exactly as
for a raster image Layer; a Render containing a vector replays
byte-identically from the retained bytes. A file that declares neither
usable width/height nor a viewBox is refused naming the fix, and malformed
or non-SVG bytes with an `.svg` name are refused at the ingestion point.

### Vector colour

One single-colour logo file serves dark, light, and brand-coloured uses
(#215, spec #207 US-005): `--vector-color` paints the vector's shape in one
colour at paint time, over the vector's own alpha. The colour is a Layer
revision fact — an absolute setter on add and `layer edit`, and `none`
removes it, restoring the authored colours byte-identically. The retained
SVG bytes are never rewritten: the render draws the colour through the
vector's own alpha (a solid-colour element masked by the retained bytes —
the same machinery the legacy uniform tint uses), so every pixel the vector
covers with alpha renders exactly the requested colour, a multi-colour
vector becomes a single-colour silhouette, alpha edges are preserved, and
the `<img>`-path inertness (no scripts, no external loads) is untouched.
The colour takes the ONE fill-colour grammar (#22c55e, #2c5, #22c55e80 —
alpha allowed); a gradient is refused naming `--fill`.

```bash
# The mark in brand colours — one file, three Layers, three revisions:
ply composition add poster logo-dark --image ~/brand/logo.svg --vector-color "#101828" -p ~/projects/my-poster
ply composition add poster logo-brand --image ~/brand/logo.svg --vector-color "#e11d48" -p ~/projects/my-poster
ply layer edit <layerId> --vector-color none -p ~/projects/my-poster   # back to the authored colours
```

The parameter is defined for vector (format svg) image Layers only: it is
refused on a raster image Layer (a raster's colours are its retained
pixels), on a text Layer (which takes its colour through `--color`), and on
a shape Layer (whose colour is its fill, through `--fill`), before anything
is published; when the same edit replaces content, the refusal reads the
new content's format. On `layer edit`, `--vector-color` cannot combine
with `--anchor` — anchor first, then set the colour (the anchor resolves
the ink the edit publishes, and a colour's alpha can change it).
Paint order within the Layer (ADR-0023): the colour
IS content paint — the visible region crops it, and the outline and shadow
hug the cropped, coloured edge. `inspect`, `measure`, and `layer review`
report the colour; a Render with a recoloured vector replays
byte-identically from the pinned revision.

## Imported vectors are inert

An imported vector can never break offline operation or reproducible replay
(#214, spec #207 US-006). The same ingestion point refuses a file that
references anything outside itself. The scan is generic, not a per-element
allowlist: EVERY attribute value on EVERY element is judged — any `url(…)`
occurrence anywhere (paint servers on `fill`/`stroke`/`filter`/`mask`/
`clip-path` included), any `href`/`src`/`data`/`base`/`poster` value, and
each `srcset` candidate separately — plus `<style>` bodies,
`<?xml-stylesheet?>`, and the DOCTYPE. Values are normalized in the order
the consuming parsers apply them — XML entities decoded once, CDATA joined
into the text it represents, CSS backslash escapes unescaped — so an
encoding cannot hide a reference: a remote or local image, a font
(`@font-face src: url(…)`), a stylesheet (`@import` or CSS `url()`), an
out-of-file `use` target, or a resource reference inside `foreignObject` is
named with its kind and line (the message lists the first 20 and reports
any beyond that bound), with the fix: embed the resource as a data URI.
Same-document fragment references (`#id`) and embedded data URIs are
accepted; a nested `data:image/svg+xml` payload is re-scanned once, so its
own external references refuse too.

A script in the file — a `<script>` element (inline or `src`), an `on*`
handler, a `javascript:` href — does not block import and is never
executed: the vector paints through the browser's image path, where
scripts are disabled by construction. Inertness is proven, not assumed:
rendering, measuring, reviewing, and replaying a script-only SVG issue
zero network requests, observed through the render page's request log.

The refusal applies at import (add, edit, and every byte-ingestion path); a
refused import publishes nothing. Retained SVG bytes from before this gate
stay inert through the same browser image path. The DOCTYPE's own DTD
identifier — the boilerplate design tools emit — is not a reference and
does not block import; any DOCTYPE entity declaration (internal or
external) does, because a conformant XML parser expands internal entities
and entity expansion to markup cannot be judged at text level — the fix
removes the entities. An unterminated comment, CDATA section, `<script>`,
`<style>`, processing instruction, or tag refuses as malformed. Plain text
content mentioning a URL is text, not a reference, and never blocks
import.

## Layer grading (new surface)

`ply layer edit` and `ply composition add` accept four tonal and colour grade
controls on image (raster and vector), text, and shape Layers (#219, spec #218 US-001):

- `--brightness <num>`: `0` to `5` (neutral `1`). Values `< 1` darken; `> 1` brighten.
- `--contrast <num>`: `0` to `5` (neutral `1`). Values `< 1` reduce contrast; `> 1` increase it.
- `--saturation <num>`: `0` to `5` (neutral `1`). Values `< 1` desaturate (`0` is greyscale); `> 1` oversaturate.
- `--warmth <num>`: `-1` to `1` (neutral `0`). Positive values shift toward orange/red; negative toward blue.

```bash
ply composition add poster photo --image portrait.png --brightness 1.15 --contrast 1.1 \
  --saturation 1.1 --warmth 0.25 -p ~/projects/my-poster
ply layer edit <layerId> --warmth 0 -p ~/projects/my-poster     # neutral removes warmth
ply layer edit <layerId> --brightness 1 --contrast 1 --saturation 1 -p ~/projects/my-poster # fully removes grade
```

Every control is an absolute setter applied at paint time to the Layer's content
only (ADR-0024). Outline, shadow, and alpha coverage are strictly preserved;
`measure` painted extents and anchored placement are unchanged. Neutral values
remove the stored facts. Refusals run before publication.

## Layer blend modes (new surface)

`ply layer edit` and `ply composition add` accept `--blend <mode>` on image
(raster and vector), text, and shape Layers (#220, spec #218 US-003):

- **Allowed modes**: `normal`, `multiply`, `screen`, `overlay`, `soft-light`,
  `darken`, `lighten`, `color-dodge` (and `colour-dodge`).
- Passing `normal` removes the stored fact.

```bash
# Multiply blend drops white backgrounds without a matting pass:
ply composition add poster mark --image logo-on-white.png --blend multiply \
  --resize-to 200x -p ~/projects/my-poster
ply layer edit <layerId> --blend normal -p ~/projects/my-poster  # restore standard compositing
```

At paint time, the whole Layer — content, visible region, grade, edge glow,
outline, shadow, and opacity — blends as ONE unit against the canvas backdrop
(ADR-0024).

## Layer edge glow (new surface)

`ply layer edit` and `ply composition add` accept `--glow` on image (raster and
vector), text, and shape Layers (#221, spec #218 US-002):

```bash
# Directional amber rim light from the right:
ply layer edit <layerId> --glow "16,8,#ffaa33,75,0.75" -p ~/projects/my-poster
# Even neon cyan rim light (no direction pair):
ply layer edit <layerId> --glow "14,6,#00e5ff" -p ~/projects/my-poster
ply layer edit <layerId> --glow none -p ~/projects/my-poster  # removes glow
```

- Value form: `"<width>,<softness>,<color>[,<angle>,<strength>]"`; `none` removes it.
- `width` and `softness`: px between `0` and `256`.
- `color`: hex colour (`#RGB`, `#RRGGBB`, `#RRGGBBAA`).
- `angle` and `strength`: optional direction pair — angle in degrees clockwise
  from top (`-360` to `360`) and strength `0` to `1` (strength `0` drops the pair).
- **Not relighting:** Edge glow is a 2D edge effect on the Layer's own alpha edge,
  painted just inside the alpha edge over graded content. It transforms with the
  Layer and never alters alpha coverage or painted extents (DEC-005). Changing
  the direction or shape of light on a subject is generation (ISC-39).

## Gradient text (new surface)

Text Layers accept gradients through `--color` (#222, spec #218 US-004), sharing
the same fill grammar as shape Layers:

```bash
ply composition add poster headline --text "GRADIENT" --font Archivo --weight 800 \
  --font-size 120 --color "linear:90deg,#ff5500,#ffaa00" -p ~/projects/my-poster
ply layer edit <layerId> --color "#ffffff" -p ~/projects/my-poster  # restore solid colour
```

Text colour and text gradient are one fact read through one reader (DEC-008):
solid colour is stored as a hex string and gradient as a fill object. The gradient
automatically spans the glyph ink box and clips to glyph alpha via
`background-clip: text`, while outlines and shadows continue to hug the glyphs.

## Region checking (new surface)

`ply composition check <comp> --regions <file>` tests a Composition's painted
Layer extents against caller-supplied regions — rectangles of platform UI
that overlays your visual (badge, progress strip, captions), supplied by
path, with no platform geometry hardcoded in Ply (ADR-0015). Every visible
Layer's painted footprint is tested against every region, one finding per
(layer, region) intersection naming the layer, its footprint, and the region
— the same actionable shape the legacy `safe-area:` warnings have.

```bash
ply composition check poster --regions my-platform-regions.json -p ~/projects/my-poster
ply composition check poster --regions my-platform-regions.json --json -p ~/projects/my-poster
```

Findings are information, never render failures: the check exits 0 with
findings, a full-bleed background intersecting every region is accepted
noise, and the check writes nothing to the Project. Layers that paint
nothing (opacity 0, fully transparent) produce no findings.

The region file is caller-owned data (schema version 1):

```json
{
  "schemaVersion": 1,
  "canvas": { "width": 1280, "height": 720 },
  "regions": [
    {
      "id": "bottom-banner",
      "label": "bottom banner",
      "reason": "the platform overlays a banner across the bottom edge",
      "box": { "x": 140, "y": 640, "width": 1000, "height": 64 }
    }
  ]
}
```

- Regions are axis-aligned rectangles in **canvas pixels** — any canvas size,
  any platform; there is no 1280×720 assumption in the code.
- `canvas` must match the Composition's canvas (the canvas contract).
- Each region needs a non-empty unique `id`, a human-readable `label`, a
  `reason`, and a `box` within the file's canvas. This one ingestion point
  is the schema contract for every region consumer, including the guideline
  overlay view.

Exit codes: 0 when the check completes (findings included), 1 for an
operational failure (malformed region file, out-of-canvas region, canvas
mismatch, missing Composition), 2 for usage errors. Default output is
compact text; `--json` emits one valid JSON result with the findings.

### Starter region file

A committed starter for YouTube's 1280×720 thumbnail canvas ships at
`examples/youtube-regions.json` — the bottom-right duration badge and the
full-width watched-progress strip, usable directly with `composition
check`:

```bash
ply composition check thumb --regions examples/youtube-regions.json -p ~/projects/my-thumb
```

The starter is a **copy-and-own template**, not a second authority: copy
it into your project and own it — the canonical copy for real work lives
in the caller's own project and is passed by path at use time, so no
workflow ever holds more than one authoritative copy. For another canvas
size or surface, explicitly choose appropriate regions of your own
(caller-owned policy, per ADR-0015 — Ply validates shape and the canvas
contract, never content).

### Supersampled rendering

`ply composition render` supersamples by default (ADR-0022): the Composition
is painted at 2 device pixels per canvas pixel, then every 2×2 block is
area-averaged back to one output pixel — so the output PNG is always exactly
the canvas size, but large display type gets even edge-coverage ramps instead
of stair-stepping. The average is taken in premultiplied alpha, so
transparent edges get no dark fringes.

The factor is a render-quality setting, never Composition geometry: canvas,
placement, font sizes, `measure`, `--anchor`, `guidelines` and `check` all
stay in canvas pixels. Override it with `--supersample <n>` (integer ≥ 1);
`--supersample 1` paints directly at the canvas size, byte-identically to
renders made before supersampling. The render pixel limits apply to the
supersampled paint (canvas × factor per axis): a canvas that fits at 1× but
not at the requested factor is refused with the fix named — it is never
painted at a lower factor on its own. Outlines over Chromium's
`feMorphology` raster cap render as chained dilate steps at any factor and
Layer scale (#194). [Limits and render quality](docs/guide/limits.md) gives
the bounds, the canvas/factor table, and the measured outline cost
(ADR-0019, ADR-0022).

```bash
ply composition render poster -p ~/projects/my-poster                    # supersample 2 (default)
ply composition render poster --supersample 4 -p ~/projects/my-poster    # smoother, larger paint
ply composition render poster --supersample 1 -p ~/projects/my-poster    # direct paint
```

The Render manifest records the factor. `replay` repaints at the recorded
factor — it has no `--supersample` flag — so it reproduces the delivered
bytes; manifests written before supersampling record no factor and replay at
1 (the parser defaults it at that one ingestion boundary).

### Guideline view

`ply composition guidelines <comp> --regions <file>` renders the guideline
view: the Composition exactly as `composition render` would draw it, with
the caller's regions drawn over the canvas as inspectable overlay markup —
each region's label and reason visible — so a human reviewer can judge
placement visually before accepting a render. Only the overlay shows a
near-miss that does not intersect but still looks wrong, and whether an
intersection actually matters (a background touching the badge is fine; a
headline grazing it is not).

```bash
ply composition guidelines thumb --regions my-platform-regions.json -p ~/projects/my-poster
ply composition guidelines thumb --regions examples/youtube-regions.json --out /tmp/view.png -p ~/projects/my-thumb
```

The view is a **review artifact, not a Render**: it writes no Render
manifest and adds nothing to retained Render history, and the overlay is
structurally excluded from final renders — the guideline markup exists only
on the guideline code path, and the render path has no parameter, flag, or
branch that can emit it (ADR-0005's disposition, carried forward by
ADR-0015). The view refuses to overwrite any output a Render manifest or
the Project's `renders/` history records, and every destination — default
or `--out` — resolves through the same export-target boundary the render
path uses: existing Project state (`ply.json`, compositions/, layers/,
content/, retained inputs) and reserved storage are refused, and writes are
atomic.

The default output is a fresh, never-colliding file under the Project's
`guidelines/` directory (`guidelines/<comp>-<id>.guidelines.png`), so
re-running the view never overwrites the artifact you may still be
reviewing. That directory is **review output, not Project state**: no
Project scan, validation, sharing, or history code reads or requires it
(render history lives only in `renders/`), and whole-tree enumerators —
share, export, backup tooling — should treat it (like any non-canonical
directory) as ignorable review output. `--out` accepts any fresh,
non-reserved path the render export boundary accepts — inside the Project
(outside reserved storage) or outside it — while existing Project state
(`ply.json`, compositions/, layers/, content/, retained inputs) is never
written over.

It reads the same region file `check` accepts, through the same single
ingestion point — one region format, one parser, the same canvas contract.
Malformed region files, out-of-canvas regions, canvas mismatches, and
missing Compositions fail loudly (exit 1, actionable error); usage errors
exit 2. Default output is compact text; `--json` emits one valid JSON
result. Local only: no network, no inference weights.

### Comparison sheet

`ply composition sheet <input...>` lays an ordered list of inputs out as one
labelled PNG grid — the review contact sheet and the reference-versus-result
comparison that previously needed an external `montage` call:

```bash
ply composition sheet thumb renders/thumb-*.manifest.json reference.png --pair --cell 300
ply composition sheet candidateA candidateB ref.png --label 3="reference" --out /tmp/compare.png
```

Each input is, in one list:

- a **Composition name** — rendered current through the existing render path
  (no second rendering authority);
- a **retained Render manifest** path (the Project's
  `renders/*.manifest.json`) — painted from its pinned historical inputs
  exactly as `replay` repaints them, with the same environment gate;
- a **local image file** — PNG, JPEG, WebP, or SVG (an SVG rides the same
  inertness gate `composition add --image` applies: it may not reference
  anything outside itself).

An existing local file wins over a Composition name of the same token. Labels
default to the input's name (the Composition name, the file's base name, or
the manifest's Composition) and can be overridden per cell with
`--label <1-based index>=<text>`. `--columns` (default 2) and `--cell`
(default 512, square) size the grid; mixed aspect ratios are fitted inside
their cells without distortion. `--pair` lays the inputs out as
reference-beside-result rows — an even number of inputs, each reference
immediately followed by its result; it conflicts with `--columns`.

The sheet is a **review artifact, not a Render**: it writes no Render
manifest and adds nothing to retained Render history, and it publishes
through the same export-target boundary as render and the guideline view —
existing Project state and reserved storage are never written over, and a
recorded Render output is never overwritten. The default output is a fresh,
never-colliding file under the Project's `guidelines/` review-output
directory. A missing or undecodable input is refused naming it, and nothing
is written; an input that is neither an existing local file nor a
Composition is refused saying so (size and input limits:
`docs/guide/limits.md`). Local only: no network, no inference weights, no model calls.
Compact text by default; `--json` emits one valid JSON result; usage errors
exit 2, failures exit 1.

## Setup

```bash
bun install
bunx playwright install chromium
cp .env.local.example .env.local
```

Run `ply --help` (or `bun run ply --help` from a checkout without `bun link`),
or use `bun link` to install the `ply` executable.
The composer modules are `ply project`, `ply composition`, `ply layer`,
`ply generate`, and `ply matte`; the existing `bun run scene`, `bun run library`,
and `bun run jobs` legacy scripts remain supported. The repository is
`kenneth-liao/ply`; the local checkout is
`/Users/kennethliao/projects/tools/ply`.

`PLY_LIBRARY_ROOT` relocates the current asset library; `PLY_MODEL_DIR`
relocates cached matting weights. Update existing environment configuration
to these names. No global Project database or new Project directory layout
is introduced by the rename.

Add a Vercel AI Gateway key to `.env.local` only if you use generation.
Scene, library, review, Matting, and render operations work offline.

Matting needs the local BiRefNet Dynamic weights (MIT, ~444 MB):

```bash
mkdir -p models
curl -L --fail -o models/birefnet-dynamic.safetensors \
  https://huggingface.co/ZhengPeng7/BiRefNet_dynamic/resolve/280306042f57b7a33854319da62fd86aaa89ec4c/model.safetensors
# Warm the pinned architecture cache once (small, needs network once):
uv run --locked --script scripts/matte-birefnet-dynamic.py --warm-cache
```

The weights are gitignored and pinned by sha-256 in `src/segment.ts`.

## Quick start

Create a Project, build a Composition, render it locally, and replay the result:

```bash
ply project init ~/projects/my-poster
ply composition create poster --width 1080 --height 1080 -p ~/projects/my-poster
ply composition add poster headline --text "Hello" --font Anton -p ~/projects/my-poster
# Variable fonts take weight/width (ADR-0021); omitted controls use the
# face's default instance (Archivo: 400/100):
ply composition add poster display --text "Groundline" --font Archivo --weight 800 --width 122 -p ~/projects/my-poster
# Typography is font-independent (ADR-0021); omitted means normal spacing
# and the font's own line height:
ply composition add poster utility --text "Hello" --font Archivo --tracking 0.16 -p ~/projects/my-poster
# One-command Layers (#229): every placement/transform/effect option 'layer
# edit' accepts applies in the documented order and publishes one revision:
ply composition add poster headline --text "Hello" --font Anton --x 540 --y 160 \
  --anchor center,center --rotate -6 --shadow "0,6,12,#00000080" -p ~/projects/my-poster
# Caller fonts (#232): any local TrueType/OpenType file works like a bundled
# family — its bytes are retained with the Layer, its own facts stored:
ply composition add poster wordmark --text "Hello" --font-file ~/fonts/PixelDisplay.ttf -p ~/projects/my-poster
# Stack position (#230): put a bar behind existing text without a reorder:
ply composition add poster bar --image bar.png --position before:headline -p ~/projects/my-poster
# Shape Layers (#208): bars, pills, cards, and backgrounds from parameters
# alone — no drawing tool, no image bytes:
ply composition add poster highlight --shape rectangle --size 420x90 \
  --corner-radius 16 --fill "#1d4ed8" -p ~/projects/my-poster
ply composition render poster -p ~/projects/my-poster
# Every successful render retains a manifest under the Project's renders/:
ply composition replay <project>/renders/<render-id>.manifest.json -p ~/projects/my-poster
```

A render manifest pins the exact ordered Layer revisions, canvas,
supersample factor, and rendering-environment identity used for that paint.
Replay regenerates the
pixels byte-identically from those pinned inputs — after source Layers are
edited, uses are removed or reordered, the Project is relocated, or the
original source files and the rendered PNG are gone — and refuses missing,
corrupted, or malformed history, or a different rendering environment,
instead of silently substituting content.

Content enters a Composition as ordinary Layers: import a local image, or
generate one and matte it first when true alpha is needed (the generation and
Matting sections above document both operations). The `ply-operating` skill
teaches that route and its chosen defaults. The legacy Scene workflow is
preserved under [Legacy surface](#legacy-surface-preserved).

## Legacy surface (preserved)

The legacy workflow is:

1. Supply existing image files or candidate Assets.
2. Author a Scene.
3. Validate and render locally.
4. Iterate with Scene edits or Variants, without another model call.

It keeps a versioned **Scene** for 1280×720 images: an ordered list of image,
text, shape, connector, and group Layers. It is preserved for existing work and
works offline; it is not the entry path for new callers, and the terms below
describe what runs today, not the target glossary. Retired generation and
adoption commands stay documented as inspect/review-only records: none of them
starts a generation run, and new generated content enters only through the
composer surface.

Scene, `jobs`, and `library` commands print compact text by default and emit
one valid JSON result on stdout under `--json` (with structured errors and
their exit codes preserved); `generate` and `matte` have the same contract.

**Migration for machine consumers (#128).** Before #128, `scene` and `jobs`
printed machine-readable JSON by default and `library` rejected `--json`;
now every module prints compact text by default and `--json` carries the
structured form:

```bash
# Before — JSON was the default and scripts parsed stdout directly:
ply scene inspect thumbnail.scene.json | jq '.layers'
# After — add --json for the machine-readable result:
ply scene inspect thumbnail.scene.json --json | jq '.layers'
# Library joins the same contract (before, this crashed with a stack trace):
ply library list --json
```

Exit codes keep their module-wide meanings — 0 ok, 1 operational failure, 2
usage error — and the structured shape under `--json` is unchanged, but two
exit-code contracts moved for `library` and help: `library` usage-shaped
argument failures (unknown command, missing/invalid `--id`, invalid file,
missing ref) now exit 2 where they exited 1, and every module's `--help`/`-h`
now exits 0 where Scene/Job help exited 2. A wrapper treating "any nonzero
exit as operational failure" must distinguish 2 (usage) from 1 (operational).

### Scene quick start

```bash
ply scene init headline-card --out thumbnail.scene.json
# Edit thumbnail.scene.json to reference studio-desk and set the text.
ply scene validate thumbnail.scene.json
ply scene render thumbnail.scene.json
```

Successful Scene renders are exactly 1280×720 and include a portable manifest.

### Scenes

A Scene is plain JSON. Layer order is paint order; later Layers appear on top.

```json
{
  "schemaVersion": 1,
  "canvas": { "width": 1280, "height": 720 },
  "layers": [
    {
      "id": "background",
      "type": "image",
      "asset": "studio-desk",
      "position": { "x": 0, "y": 0 },
      "size": { "width": 1280, "height": 720 }
    },
    {
      "id": "headline",
      "type": "text",
      "spans": [
        { "text": "BUILD " },
        { "text": "FASTER", "color": "#ffd400" }
      ],
      "font": "Anton",
      "fontSize": 120,
      "position": { "x": 80, "y": 470 },
      "size": { "width": 900, "height": 170 }
    }
  ]
}
```

Use the CLI as the canonical interface reference:

```bash
ply scene --help
ply scene schema
ply scene themes
ply scene templates
```

Important commands:

```bash
ply scene init <template> --out <scene.json>
ply scene inspect <scene.json>
ply scene validate <scene.json>
ply scene render <scene.json>
ply scene guidelines <scene.json>
ply scene author <scene.json>
ply scene rerender <manifest.json>
```

#### Variants

A Scene can hold named sparse changes against stable Layer IDs. Render one or
more without starting generation:

```bash
ply scene render thumbnail.scene.json --variant headline-b
ply scene render thumbnail.scene.json --variant headline-a,headline-b
```

A multi-Variant render also creates a contact sheet.

#### Reference Thumbnails

A Reference Thumbnail is review metadata, not a Render input. Import normalizes
a local PNG, JPEG, or WebP to the exact 1280×720 PNG profile. Non-16:9 images
are refused rather than cropped or distorted without explicit intent.

```bash
ply scene reference import thumbnail.scene.json ./reference.webp \
  --source "optional provenance"
ply scene compare thumbnail.scene.json
ply scene author thumbnail.scene.json
```

`compare` and `author` provide side-by-side and alpha-overlay review. They do
not alter final Render pixels.

#### Fonts and output

Bundled OFL fonts live under `assets/fonts/` and load from local bytes. Unknown
or unresolved font families fail instead of silently falling back. The set
includes the Archivo variable face (`wght` 100–900, `wdth` 62–125, default
instance 400/100) and IBM Plex Mono 500 (ADR-0021) alongside the other
bundled faces; the legacy Scene surface resolves them at their default
instance and gains no new controls.

Rendering keeps the 1280×720 dimensions and enforces the 2 MB output limit.
Oversized PNGs are optimized locally. Each final Render gets a manifest with
the exact Scene and Asset identities needed for offline rerendering.

### Generation Jobs (legacy records)

Category-specific generation is retired (spec #102, #114): the one generation
operation is `ply generate` (see above), and isolation is `ply matte`. The
`jobs` module now only inspects the Generation Job records written
under `out/jobs/<jobId>/` before the retirement — by the pre-retirement
`jobs plates|objects|creators|rerun` commands or other writer binaries:

```bash
ply jobs show <jobId>                 # full record: request, references, runs
ply jobs list                         # summarize recorded jobs
ply jobs review <jobId>               # offline evidence sheet (see below)
```

No command here starts or extends a job, and none publishes anything:
generation and candidate adoption are retired (spec #102, #115). Generated
and matted content enters Projects as ordinary Layers
(`ply composition add --from-generation` / `--from-matte`), and the records
below stay reviewable evidence only.

#### Arbitrary reference files

The uniform surface replaces the old typed-reference syntax. Callers pass
references directly with `ply generate --ref <path>`, repeatable, in caller
order: identities are derived at Job creation, bytes are verified against
them at generation, and those exact bytes go to every candidate call. There
are no roles — declare each image's purpose in the prompt text. A
reference-capable model is required when references are present; an
incompatible model is rejected before spend.

Reference URLs are not fetched by Ply. Download or authenticate outside the
tool, then pass a local file. This keeps fetching, credentials, caching, and
mutable remote content outside the composition boundary.

#### Legacy records and the library

Existing plate/object/creator records stay reviewable:

```bash
ply jobs review <jobId>
ply library approve presenter-pointing
```

Only explicit human approval promotes a trial Creator Asset. Normal Scene
rendering rejects trial assets. `scene render --experimental` is the explicit
non-final override and marks its output accordingly.

Placement, size, mirror, visibility, and effects are local Layer edits. A named
Mask can recolor a fixed region locally. For new content, generate a
replacement with the uniform surface, matte it, and swap the Layer's content
through the explicit edit contract; caller workflow guidance (real-photo
selection, identity anchors, approval practice) lives in the consuming
repositories' own instructions.

### Asset library

The shared library is the `assets/` directory. The filesystem is the registry;
there is no catalog for generation references.

```bash
ply library --help
ply library list [query]
ply library list --sheet
ply library list --json
ply library resolve <asset-ref>
```

Every library command prints compact text by default and one valid JSON
result on stdout under `--json` (#128).

Library kinds:

| Kind | Directory | Content |
|---|---|---|
| Logo | `assets/logos/<id>/` | `logo.svg` or `logo.png` + `meta.json` |
| Plate | `assets/plates/<id>/` | `plate.png` + `meta.json` |
| Object | `assets/objects/<id>/` | true-alpha `object.png` + `meta.json` |
| Cutout | `assets/cutouts/<id>/` | true-alpha `cutout.png` + `meta.json` |
| Mask | `assets/masks/<id>/` | `mask.png` + `meta.json` |

Add externally sourced Assets:

```bash
ply library add-logo ./logo.svg --id product-logo --source "source URL + date"
ply library add-cutout ./person.png --id presenter --source "source URL + date"
ply library add-mask ./shirt-mask.png --id presenter-shirt
```

Existing library plates and objects keep their recorded generation
provenance. New generated and matted content enters through the composer
surface (`ply composition add --from-generation` / `--from-matte`), not the
library.

A Scene Asset reference can be:

- `<id>` or `library:<id>` for a library Asset;
- a project-relative path for a local Asset; or
- either form with `@<sha-256-or-prefix>` to pin exact bytes.

## Project map

| Path | Responsibility |
|---|---|
| `src/scene.ts`, `src/scene-schema.ts` | Scene loading, validation, and schema |
| `src/scene-render.ts` | Local Chromium renderer |
| `src/scene-cli.ts`, `src/scene-author.ts` | Scene commands and live authoring |
| `src/jobs.ts`, `src/job-cli.ts` | Legacy Generation Job records: read-only inspection and review |
| `src/generate.ts`, `src/models.ts` | Shared provider call shape, Reference verification, and model registry |
| `src/assets.ts`, `src/library-cli.ts` | Immutable Asset library and approval |
| `src/matte.ts`, `src/segment.ts` | Local subject isolation |
| `src/matting.ts`, `src/matting-cli.ts` | Independent local Matting operation and command |
| `src/manifest.ts`, `src/finalize.ts` | Render provenance and output limits |
| `src/fonts.ts` | Bundled font registry and fallback rejection |
| `src/themes.ts`, `src/templates.ts`, `src/variants.ts` | Reusable local composition primitives |

## Development

```bash
bun run test
bun x tsc --noEmit
```
