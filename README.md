# Ply

Ply is becoming a general-purpose layered image composer.
[ISA.md](ISA.md) defines the destination; [CONTEXT.md](CONTEXT.md) defines its
accepted vocabulary. The composer foundation ([spec #77](https://github.com/kenneth-liao/ply/issues/77))
is shipped and acceptance-audited: self-contained Projects, independently
editable and reusable Layers, arbitrary-size Compositions, and replayable
Render history, including integrated relocation/offline qualification.
Generation unification and the matting/region-gate migration remain unimplemented.

## Current implementation

The new Project workflow below supports caller-selected canvas dimensions,
local image and text Layers, shared edits and forks, and independent cross-Project
copies. Rendering is local and deterministic.

The preserved legacy workflow uses a versioned **Scene** for 1280×720 images:
an ordered list of image, text, shape, connector, and group Layers.

Models are optional source-asset producers. **Generation** is one uniform
operation (`ply generate`) with no subject category (ADR-0014): full-canvas or
isolated output intent is a request parameter, and no content policy is imposed
on the prompt. Final text and final composition stay local. The legacy
category-specific generation commands (`jobs plates|objects|creators|rerun`)
are retired; their records remain inspectable (see below).

The legacy workflow is:

1. Supply existing image files or candidate Assets.
2. Author a Scene.
3. Validate and render locally.
4. Iterate with Scene edits or Variants, without another model call.

The legacy terms and commands below describe what runs today, not the target
glossary. Architectural decisions are in [docs/adr/](docs/adr/).

## Projects and Compositions (new surface)

The composer workflow runs through `ply project`, `ply composition`, and
`ply layer` — see `ply <module> --help` and
[docs/project-storage-contract.md](docs/project-storage-contract.md) for the
full contracts. In brief:

```bash
ply project init ~/projects/my-poster
ply composition create poster --width 1080 --height 1080 -p ~/projects/my-poster
ply composition add poster headline --text "Hello" --font Anton -p ~/projects/my-poster
ply composition render poster -p ~/projects/my-poster
# Every successful render retains a manifest under the Project's renders/:
ply composition replay <project>/renders/<render-id>.manifest.json -p ~/projects/my-poster
```

A render manifest pins the exact ordered Layer revisions, canvas, and
rendering-environment identity used for that paint. Replay regenerates the
pixels byte-identically from those pinned inputs — after source Layers are
edited, uses are removed or reordered, the Project is relocated, or the
original source files and the rendered PNG are gone — and refuses missing,
corrupted, or malformed history, or a different rendering environment,
instead of silently substituting content.

## Uniform generation (new surface)

`ply generate` is one source-image generation operation with no subject
category: full-canvas or isolated output intent is a request parameter, and
no content policy is imposed on the prompt (ADR-0014). It publishes a
Generation Job record with the effective request, content-addressed outputs,
and provenance under `out/generation/` — see
[docs/generation-publication-contract.md](docs/generation-publication-contract.md)
for the record schema and publication contract.

```bash
ply generate "a red barn at noon" --size 1080x1080
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
pinned local BiRefNet segmenter with engine preflight — missing or mismatched
weights are refused before anything is published. The source bytes are never
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
  transformed rectangle's **corners**.
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
  off-canvas distance; a Layer whose layout box exceeds the 8192×8192px
  window is refused with an actionable error instead of growing memory.
  Effects beyond opacity are not reflected (they are separate
  functionality).
- Text dimensions are measured with the same retained font bytes painting
  uses — never a second measuring authority. Corrupt content or an
  unresolved font fails instead of producing misleading numbers.
- The query writes nothing to the Project, works offline, and never
  requires a billed operation.

## Setup

```bash
bun install
bunx playwright install chromium
cp .env.local.example .env.local
```

Run `bun run ply --help`, or use `bun link` to install the `ply` executable.
For example, `ply scene schema` delegates to the existing Scene command.
The existing `bun run scene`, `bun run library`, and `bun run jobs` scripts
remain supported. The repository is `kenneth-liao/ply`; the local checkout is
`/Users/kennethliao/projects/tools/ply`.

`PLY_LIBRARY_ROOT` relocates the current asset library; `PLY_MODEL_DIR`
relocates cached matting weights. Update existing environment configuration
to these names. No global Project database or new Project directory layout
is introduced by the rename.

Add a Vercel AI Gateway key to `.env.local` only if you use generation.
Scene, library, review, Matting, and render operations work offline.

Matting needs the local BiRefNet HR model:

```bash
mkdir -p models
uv run --locked --script scripts/export-birefnet-hr.py \
  --out models/birefnet-hr-fp16.onnx
```

The weights are gitignored and pinned by sha-256 in `src/segment.ts`.

## Quick start

Generate source content and matte it:

Create and render a Scene:

```bash
bun run scene init headline-card --out thumbnail.scene.json
# Edit thumbnail.scene.json to reference studio-desk and set the text.
bun run scene validate thumbnail.scene.json
bun run scene render thumbnail.scene.json
```

Scene and `jobs` commands write machine-readable JSON to stdout;
`generate` and `matte` print compact text by default and emit
machine-readable JSON only under `--json`. Successful renders are exactly
1280×720 and include a portable manifest.

## Scenes

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
bun run scene --help
bun run scene schema
bun run scene themes
bun run scene templates
```

Important commands:

```bash
bun run scene init <template> --out <scene.json>
bun run scene inspect <scene.json>
bun run scene validate <scene.json>
bun run scene render <scene.json>
bun run scene guidelines <scene.json>
bun run scene author <scene.json>
bun run scene rerender <manifest.json>
```

### Variants

A Scene can hold named sparse changes against stable Layer IDs. Render one or
more without starting generation:

```bash
bun run scene render thumbnail.scene.json --variant headline-b
bun run scene render thumbnail.scene.json --variant headline-a,headline-b
```

A multi-Variant render also creates a contact sheet.

### Reference Thumbnails

A Reference Thumbnail is review metadata, not a Render input. Import normalizes
a local PNG, JPEG, or WebP to the exact 1280×720 PNG profile. Non-16:9 images
are refused rather than cropped or distorted without explicit intent.

```bash
bun run scene reference import thumbnail.scene.json ./reference.webp \
  --source "optional provenance"
bun run scene compare thumbnail.scene.json
bun run scene author thumbnail.scene.json
```

`compare` and `author` provide side-by-side and alpha-overlay review. They do
not alter final Render pixels.

### Fonts and output

Bundled OFL fonts live under `assets/fonts/` and load from local bytes. Unknown
or unresolved font families fail instead of silently falling back.

Rendering keeps the 1280×720 dimensions and enforces the 2 MB output limit.
Oversized PNGs are optimized locally. Each final Render gets a manifest with
the exact Scene and Asset identities needed for offline rerendering.

## Generation Jobs (legacy records)

Category-specific generation is retired (spec #102, #114): the one generation
operation is `ply generate` (see above), and isolation is `ply matte`. The
`jobs` module now only inspects the Generation Job records written
under `out/jobs/<jobId>/` before the retirement — by the pre-retirement
`jobs plates|objects|creators|rerun` commands or other writer binaries:

```bash
bun run jobs show <jobId>                 # full record: request, references, runs
bun run jobs list                         # summarize recorded jobs
bun run jobs review <jobId>               # offline evidence sheet (see below)
```

No command here starts or extends a job, and none publishes anything:
generation and candidate adoption are retired (spec #102, #115). Generated
and matted content enters Projects as ordinary Layers
(`ply composition add --from-generation` / `--from-matte`), and the records
below stay reviewable evidence only.

### Arbitrary reference files

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

### Legacy records and the library

Existing plate/object/creator records stay reviewable:

```bash
bun run jobs review <jobId>
bun run library approve presenter-pointing
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

## Asset library

The shared library is the `assets/` directory. The filesystem is the registry;
there is no catalog for generation references.

```bash
bun run library --help
bun run library list [query]
bun run library list --sheet
bun run library resolve <asset-ref>
```

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
bun run library add-logo ./logo.svg --id product-logo --source "source URL + date"
bun run library add-cutout ./person.png --id presenter --source "source URL + date"
bun run library add-mask ./shirt-mask.png --id presenter-shirt
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
