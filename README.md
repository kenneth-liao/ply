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
[Guideline view](#guideline-view)); a starter YouTube region file ships as a
copy-and-own template ([Starter region file](#starter-region-file)); the
legacy Scene surface still runs as documented under
[Legacy surface](#legacy-surface-preserved), and ADR-0014 records what
remains target for it.

## Current implementation

The composer surface is **Project**, **Composition**, and **Layer**:
caller-selected canvas dimensions, local image and text Layers, generated and
independently matted content ingested as ordinary Layers, shared edits and
forks, independent cross-Project copies, and local deterministic Rendering.
New work starts here — see [Quick start](#quick-start), the sections below, and
the `ply-operating` skill.

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
Architectural decisions are in [docs/adr/](docs/adr/).

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
the default. Explicit GPT Image 2 quality selection (`--quality low|medium|high`)
is qualified for `gpt-image` only — other models acquire no quality tiers, an
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
ply layer edit <layerId> --resize-to 800x  # absolute, aspect preserved
ply layer edit <layerId> --resize-to 800x600   # deliberate aspect change
```

- `--resize <factor>` works on image and text Layers. It is **relative**: the
  new scale is the current scale multiplied by the factor, so the same
  command twice keeps enlarging (2 then 2 gives 4×). The aspect ratio is
  always preserved. Every result (text and JSON) reports the absolute
  effective scale and, for image Layers, the absolute effective size.
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
  set (the `typography` facts #187).
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
  whose layout box plus effect extent exceeds the 8192×8192px
  window is refused with an actionable error instead of growing memory.
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
  `--resize`, `--rotate`, `--flip`, `--shadow`, or content replacement in
  one edit, because the reference ink would be ambiguous. `--opacity`
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
  exactly (ADR-0019). Every successful render draws that full ring;
  an outline whose raster dilate (width × supersample) would exceed
  Chromium's 256-raster-px kernel cap is refused instead of rendering a
  clipped ring (see supersampled rendering, ADR-0022).
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
  `weight` accepts only the face's own weight (or omission) and `width` is
  refused outright — the bytes already fix the look. The revision stores no
  axis fields.
- **Editing `--font`** keeps the current weight and width when the new font
  supports them; otherwise the edit is refused and names what the new font
  allows — nothing changes silently. When the current revision stores no
  axes, the new font's defaults apply.
- **Editing `weight`/`width` without `--font`** validates against the
  Layer's retained font, resolved by its content hash; if the retained bytes
  match no bundled face, the edit requires `--font`.
- The stored axes are revision facts: they participate in the revision hash
  only when present, so pre-#179 revisions keep their exact ids and pinned
  Render history replays byte-identically. Paint and measurement both read
  the stored axes from the revision alone, and `composition measure` and
  `layer inspect` report them.

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
painted at a lower factor on its own. The same discipline covers outlines:
Chromium caps the `feMorphology` outline-dilate kernel at 256 raster pixels,
so an outline whose width × supersample would exceed that cap is refused
before anything is painted — render with `--supersample 1`, a smaller
factor, or a thinner outline. A render is never silently degraded.

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
