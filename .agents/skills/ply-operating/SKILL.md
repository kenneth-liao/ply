---
name: ply-operating
description: Operate the Ply composer end to end — import or generate content, matte, ingest Layers, measure and edit placement/transforms/effects, render, and review pixels. Use whenever a task creates or edits a visual with ply (thumbnails, posters, compositions) and needs the current Project/Composition/Layer workflow, not the legacy Scene surface.
---

# Ply operating workflow

This skill is the operating route for Ply's current composer surface. It owns
the workflow and the chosen defaults; it does not own content policy — for
what to generate, likeness prompting, local-vs-generated text, official marks,
or safe-region review, follow the `visual-authoring` skill and the consuming
project's own instructions. Ply's tool correctness and the caller's content
choices are separate authorities (ADR-0014); this skill links them, never
copies them.

Run `bun link` once (or use `bun run ply -- ...`) so the examples below run as
`ply ...`. Run them from a directory that owns the inputs you pass; `-p <dir>`
selects the Project. Generated and matted records publish under `out/` in the
working directory — generation is the only network operation and needs a
Vercel AI Gateway key in `.env.local`; everything else is local and offline.

## 1. Create the Project

```bash
ply project init ~/projects/my-poster
```

A Project is self-contained: Layers, retained content bytes, and Render
history live inside it and survive relocation.

## 2. Bring content in — import or generate

Import an existing local image, or generate one. Both become ordinary Layers.

```bash
ply composition create poster --width 1280 --height 720 -p ~/projects/my-poster
ply composition add poster background --image source.png -p ~/projects/my-poster
```

Generation is one uniform operation — no subject category, no content gate
(ADR-0014). Full-canvas vs isolated output shape is `--intent`; References
(`--ref`, repeatable) are local files in caller order.

```bash
ply generate "a red barn at noon"                      # no --model: nano-2 (tool default)
ply generate "a presenter portrait" --intent isolated  # shape of output, not a matte
ply generate "restyle this room" --ref room.png --ref palette.png
ply generate show <jobId>    # offline inspection of the published record
ply generate list
ply generate review <jobId>  # offline evidence sheet: References, outputs
```

**Defaults as shipped** (the exact contract lives in `ply generate --help` and
README's generation section): omitting `--model` selects **nano-2** — the
tool's general default, and an explicit `--model` always overrides it.
GPT Image 2 quality selection (`--quality low|medium|high`) is qualified for
`gpt-image` only; omitting `--quality` leaves the provider's own default.
A caller-owned workflow may set a different route (for example, the AI
Launchpad workflow selects `--model gpt-image --quality low` for Kenny
headshot/likeness edits using real identity References — that rule lives in
`assets/creator-cutouts/workflow.md` of `kenneth-liao/ai-launchpad-content`,
not here). Never infer a subject to pick a model; the caller names the route.

## 3. Optionally matte — a separate local pass

`--intent isolated` is a generation request, **not** a matte. When true alpha
is needed, invoke Matting explicitly on any local PNG (never a generated
checkerboard — apparent transparency is not alpha; see visual-authoring):

```bash
ply matte out/generation/<jobId>/outputs/<sha256>.png --id my-cutout
```

Local inference (BiRefNet, weights under `models/`) runs offline with no
billed hop; a source that already carries true alpha is kept as-is with no
inference. The source bytes are never modified. **Inspect the matte result**
on contrasting backgrounds — a successful pass is not automatic acceptance.

## 4. Ingest as Layers — provenance retained

```bash
ply composition add poster cutout --from-matte <matteId> -p ~/projects/my-poster
ply composition add poster background --from-generation <jobId> -p ~/projects/my-poster
ply layer edit <layerId> --from-matte <matteId> -p ~/projects/my-poster
```

Ingested Layers keep the matte's — and a generated source's job — provenance
inside the Project, resolving offline after the external `out/` files are
gone and the Project has moved. `ply generate`/`ply matte` are the only
adoption routes; the legacy library never receives generated content.

## 5. Measure, then edit — geometry first, deliberately

`measure` is read-only, free, and uses the exact font bytes and geometry
rendering uses:

```bash
ply composition measure poster -p ~/projects/my-poster
ply composition measure poster headline --json -p ~/projects/my-poster
```

It reports the layout **content box**, the transformed **box**, and the
**painted** extents (visible ink — transparent image padding and loose text
line-boxes are excluded), plus the on-canvas footprint and `clipped`. Effects
and transforms are included: painted bounds grow with the shadow/outline and
follow the rotation. Use it to place and align against numbers, and to check
what a transform will do to the footprint before running it.

Edits are non-destructive — placement changes, never retained pixels — and
are absolute setters unless noted (relative `--resize` aside):

```bash
ply layer edit <layerId> --resize 1.5            # relative: scale × 1.5
ply layer edit <layerId> --resize-to 800x        # image-only, aspect preserved
ply layer edit <layerId> --rotate -8             # absolute angle; 0 removes
ply layer edit <layerId> --flip horizontal       # absolute; none removes
ply layer edit <layerId> --anchor center,center --x 640 --y 360
ply layer edit <layerId> --shadow "0,6,18,#000000aa"   # dx,dy,blur,color
ply layer edit <layerId> --outline "2,#101014"         # width,color
ply layer edit <layerId> --opacity 0.9
```

Route rules worth internalizing — a working summary only: the exact setters,
combination restrictions, and exit-code semantics are owned by `ply layer
--help` and README's Layer sections, not restated normatively here.

- **Transform order** is fixed: flip, then scale, then rotation, applied
  about the `(x, y)` placement point; effects paint in the Layer's local
  space and transform with it (an outline is painted before the shadow cast
  from it).
- **`--anchor` targets painted ink, not the top-left corner** — transparent
  padding does not count and glyph ink centers, so the resolution runs
  against the Layer's current transforms and effects. Sequence effect and
  transform edits first, anchor after, and re-anchor when the geometry
  later changes.
- **Sharing is explicit:** a Layer referenced by several Compositions
  refuses a bare edit and names the blast radius — choose `--in-place`
  (propagates everywhere) or `--fork` (isolates the named use) deliberately;
  single-referrer edits just apply.
- Failures never mutate live state, so a wrong edit is always cheap to retry.

## 6. Render and review pixels

```bash
ply composition render poster -p ~/projects/my-poster
```

Every render writes a manifest under the Project's `renders/`; open the PNG
and look at it. Then replay any retained render byte-identically, even after
later edits or relocation:

```bash
ply composition replay <project>/renders/<render-id>.manifest.json -p ~/projects/my-poster
ply layer review <layerId> --out review.html -p ~/projects/my-poster  # offline evidence sheet
```

## Why visual review remains necessary

Measurement is geometry, and geometry is not layout taste. `measure` tells
you where ink is, whether it clips, and what a transform will do — it does
not tell you whether the composition looks right. It cannot judge balance,
contrast, overlapping legibility, or whether a subject's edge survived the
matte, and it deliberately promises no automatic aesthetic layout: placement
anchors center ink, not attention. Likewise, generation and Matting are
operations, not verdicts — a successful Job is not a good image and a
successful matte is not an approved likeness. Inspect rendered output at the
intended viewing size, compare candidates against their References via
`generate review`/`layer review`, and follow the consuming project's approval
practice (see visual-authoring) before anything is used.

## Contract boundaries

- Command contracts and their full semantics are documented in `README.md`
  (one section per surface) and `docs/project-storage-contract.md`,
  `docs/generation-publication-contract.md`, and
  `docs/matting-publication-contract.md`. This skill teaches the route and
  the defaults; those documents own the exact contracts — do not duplicate
  them here.
- Retained history, sharing/fork semantics, relocation, and offline replay
  are governed by ADR-0013; Layer transform/effect canonicalization by
  ADR-0016–0019. The legacy Scene/library/jobs surface still works unchanged
  and is documented in `README.md`; prefer the composer surface for new work.
- The complete YouTube package workflow (safe regions, channel packaging) is
  a separate caller workflow — the `visual-authoring` skill covers its
  authoring practices; caller instructions own the rest.
