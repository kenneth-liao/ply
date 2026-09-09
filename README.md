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

Models are optional source-asset producers. **Generation Jobs** can create
background Plates, isolated Objects, and Creator candidates. Final text and
final composition currently stay local. ADR-0014 supersedes the text/content
policy for the target design; this rename does not remove existing gates.

The legacy workflow is:

1. Supply existing image files or generate candidate Assets.
2. Adopt reusable candidates into the Asset library.
3. Author a Scene.
4. Validate and render locally.
5. Iterate with Scene edits or Variants, without another model call.

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
```

Isolated intent is a generation request, not a matte: it never runs Matting
and never reports verified alpha — the independent Matting operation stays
caller-invoked (ADR-0015). References (`--ref <path>`, repeatable) are local
files attached in caller order: identities are derived at Job creation, bytes
are verified against them at generation, and missing or changed files fail
before any provider call — no remote fetching, no mandatory identity
Reference, no roles. The legacy `jobs plates|objects|creators` pipeline below
keeps working until its separately approved retirement.

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

Add a Vercel AI Gateway key to `.env.local` only if you use Generation Jobs.
Scene, library, review, and render operations work offline.

Object and Creator generation also needs the local BiRefNet HR matting model:

```bash
mkdir -p models
uv run --locked --script scripts/export-birefnet-hr.py \
  --out models/birefnet-hr-fp16.onnx
```

The weights are gitignored and pinned by sha-256 in `src/segment.ts`.

## Quick start

Generate and adopt a Plate:

```bash
bun run jobs plates "a dramatic studio desk with blue rim light" --count 2
bun run jobs review <jobId>
bun run jobs adopt <jobId> <candidateHash> --id studio-desk
```

Create and render a Scene:

```bash
bun run scene init headline-card --out thumbnail.scene.json
# Edit thumbnail.scene.json to reference studio-desk and set the text.
bun run scene validate thumbnail.scene.json
bun run scene render thumbnail.scene.json
```

Every `scene` and `jobs` command writes machine-readable JSON to stdout.
Successful renders are exactly 1280×720 and include a portable manifest.

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

## Generation Jobs

Generation is the only online operation:

```bash
bun run jobs --help
bun run jobs plates <subject> [options]
bun run jobs objects <subject> [options]
bun run jobs creators <subject> [options]
bun run jobs review <jobId>
bun run jobs rerun <jobId>
bun run jobs adopt <jobId> <hash> --id <assetId>
```

Jobs live under `out/jobs/<jobId>/`. Reruns append to lineage; they do not
replace prior candidates. Adoption creates a new immutable Asset and never
overwrites an existing one.

### Arbitrary reference files

Callers pass references directly. Ply does not discover, index, rank, or
choose reference images.

```bash
bun run jobs plates "simplify this interface into a bold background" \
  --ref edit:./references/interface.png \
  --ref style:./references/palette.jpg
```

Each `--ref` value is `<role>:<path>`. Ply:

- preserves command-line order;
- reads and hashes the file when the Job request is created;
- records the role, path, and sha-256 identity;
- verifies and reads the bytes once at generation;
- sends those exact bytes to every candidate call in the same order; and
- role-assigns each image in the effective prompt without sending local paths
  in prompt text.

A reference-capable model is required when references are present. An
incompatible model is rejected before spend.

Reference URLs are not fetched by Ply. Download or authenticate outside the
tool, then pass a local file. This keeps fetching, credentials, caching, and
mutable remote content outside the composition boundary.

### Plates and Objects

A Plate is a flattened full-canvas background. The subject can request UI,
products, devices, or environmental details. The model prompt still forbids
final editorial text and exact logos.

An Object Job requests one isolated non-text object. Generated Object
candidates pass through local matting; adoption requires verified true alpha.
Use a separate Object Asset when movement, resizing, recoloring, replacement,
reuse, provenance, or Variants benefit from independent control.

### Creator candidates

Creator generation requires at least one caller-supplied `identity` reference:

```bash
bun run jobs creators "presenter pointing left, confident expression" \
  --ref identity:./references/person-front.jpg \
  --ref pose:./references/pointing-pose.jpg \
  --count 4
```

Accepted roles are `identity`, `pose`, `expression`, `outfit`, `style`, and
`edit`. References reach the provider in caller order. A likeness is never
generated from text alone.

Candidates pass through the local matting model. Adoption creates a trial
Creator Asset:

```bash
bun run jobs review <jobId>
bun run jobs adopt <jobId> <hash> --id presenter-pointing
bun run library approve presenter-pointing
```

Only explicit human approval promotes a trial Creator Asset. Normal Scene
rendering rejects trial assets. `scene render --experimental` is the explicit
non-final override and marks its output accordingly.

Placement, size, mirror, visibility, and effects are local Layer edits. A named
Mask can recolor a fixed region locally. Pose, expression, outfit shape, and
style are intrinsic changes: generate and approve a new Creator Asset, then
swap the Layer's Asset reference (ADR-0008).

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

Generated Plates, Objects, and Creator candidates should enter through
`jobs adopt` so their generation provenance stays attached.

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
| `src/jobs.ts`, `src/job-cli.ts` | Generation Job lifecycle |
| `src/generate.ts`, `src/models.ts` | Provider prompts, calls, and model registry |
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
