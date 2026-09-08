---
thing: Ply — general-purpose layered image composer
phase: active
progress: 16/28
principal_stated_goal: "A Photoshop-like image composer where the layer is the only primitive: anything can be a layer, any number of layers, and any composition can be used inside another composition without being flattened — its layers stay separately editable. Every layer can be generated, refined, and reused independently, so changing one never means regenerating the rest. Built so an AI agent composes by deciding which layers to use and where to put them on the canvas. YouTube thumbnails become one thing it can make, not what it is."
started: 2026-09-07
updated: 2026-09-08
---

# Ideal State — Ply

## Problem

Ply began as thumby, built for one job: YouTube thumbnails. That specialization became
the ceiling. Generation is split into three fixed kinds (`plate`, `object`,
`creator`), storage into five fixed kinds (`logo`, `plate`, `cutout`,
`object`, `mask`), and neither taxonomy matches the thing being composed — a
UI panel has to file itself as an `object` to get an alpha guarantee, and a
person's cutout inherits an approval gate from its directory. The canvas is
welded to 1280×720. Rules refuse work the tool cannot actually judge: a
generated fictional logo is rejected as a real one, decorative text is
rejected as editorial.

Worse, the reuse the tool exists for does not exist. Rendering produces a flat
PNG, and there is no path from a finished composition back to reusable parts.
A background and a UI panel that took an hour to get right cannot become the
base for six variations without redoing the work.

## Vision

You compose an image out of layers, the way you would in Photoshop, and every
layer is a thing you can keep. A cutout of you with the right expression, a
terminal panel, a headline treatment — each gets made once and dropped into
anything afterward. Compositions are made of the same stuff, so a finished
base flows into the next piece without being flattened first. The tool holds no
opinion about what you are making; an agent drives it and the opinions live in
the skills that agent reads.

## Out of Scope

- Deciding what the caller may generate or import. No content bans, no subject
  validation, no likeness gates, no approval workflow.
- Owning an asset catalog. The caller organizes their own library; Ply
  resolves references to it.
- Publishing, uploading, or anything downstream of a finished image.
- Fetching remote references. Callers pass local files.
- A human-facing visual editor as the primary surface. Agents operate the tool.
- Named variant sets as a schema concept. Variation is a filesystem concern.
- YouTube-specific enforcement in the tool. It becomes caller-supplied data
  and skill knowledge.

## Principles

- **The tool is blind to its use case.** Ply provides primitives. Whether
  the output is a thumbnail, a slide, or a banner is not its business, and it
  cannot reliably infer intent from a prompt or a filename. A rule that guesses
  intent refuses valid work.
- **One primitive, uniform features.** If a capability makes sense for one
  layer, it exists on every layer. When two things need to vary independently,
  they are two layers — that is the answer, not a per-type feature matrix.
- **Enforcement is policy; machinery is correctness.** A gate that refuses
  based on intent is policy and leaves. Geometry, matting, and rendering are
  correctness and stay — parameterized by the caller instead of hardcoded.
- **Modules over a shared primitive.** Edit, compose, and generate grow
  independently because each one only has to speak Layer.

## Constraints

- Rendering is local and deterministic. Generation is the only network
  operation; everything else works offline.
- Content-addressed immutable storage underlies sharing and forking (ADR-0002).
  It stops being agent-facing vocabulary but it does not stop being true.
- Bundled OFL fonts ship with the tool and load from local bytes. Unresolved
  families fail loudly rather than falling back.
- A shipped render stays exactly reproducible from its manifest after its
  source layers have changed.
- Migration is a clean break except for `assets/logos/`. Nothing else needs to
  survive: no scenes, renders, job records, cutouts, plates, or masks exist on
  disk. Creator cutouts and identity photos already live in
  `ai-launchpad-content`, not here.

## Goal

Ply is three modules — edit, compose, generate — over one uniform layer
primitive. A composition is an ordered list of layers; any layer is reusable in
any composition; editing a shared layer propagates or forks by explicit choice;
and the tool enforces nothing about what a layer contains.

## Features

### F0 · Cross-cutting

Why: the tool is a set of primitives, not a thumbnail machine.

- [x] ISC-1: A composition of any width and height renders correctly.
  Probe: render a 1080×1080 and a 2560×1440 composition; both come out at the
  requested size. bash
- [ ] ISC-2: Every command except generation completes with no network access.
  Probe: run the full non-generate surface with networking disabled. bash
- [ ] ISC-3: Every composition operation — reorder, opacity, position, delete,
  import, fork — works identically on every layer type.
  Probe: the operation × layer-type matrix, every cell exercised. bash
- [ ] ISC-4: Anti: no command refuses a request based on what the caller is
  trying to make.
  Probe: generate a logo, a text-bearing panel, and a likeness with no identity
  reference — all succeed; `rg` finds no subject-content validation in `src/`. bash
- [x] ISC-5: Anti: no composition is ever flattened in order to be reused.
  Probe: `rg` finds no bake/flatten path; a composition used inside another
  exposes its layers individually. bash

### F1 · Composition

Why: reuse without regeneration is the premise the whole tool rests on.

- [x] ISC-6: A composition is an ordered list of layers and nothing else.
  Probe: the schema admits no other top-level structure. bash
- [x] ISC-7: Importing composition A into B brings A's layers in individually,
  and B can drop any of them.
  Probe: build B from a subset of A's layers. bash
- [x] ISC-8: B can place its own layers at any position relative to imported
  layers, including between two of them.
  Probe: render B with a B-owned layer between two A-owned layers. bash
- [x] ISC-9: A layer shared by A and B, edited in place, changes in both.
  Probe: edit in place, re-render both, both differ from their prior output. bash
- [x] ISC-10: A layer edited with `--fork` changes only the forking
  composition.
  Probe: after the fork edit, A's render is byte-identical to before. bash
- [x] ISC-11: Editing a layer with more than one referrer without an explicit
  `--fork` or `--in-place` fails and names how many compositions are affected.
  Probe: the error text carries the referrer count. bash
- [x] ISC-12: Editing a layer with exactly one referrer succeeds with no
  ceremony.
  Probe: the edit needs no flag and emits no warning. bash
- [x] ISC-13: A composition built from a composition that was itself built from
  another renders correctly.
  Probe: an A→B→C chain renders. bash
- [x] ISC-14: A shipped render is exactly reproducible from its manifest after
  its source layers have since changed.
  Probe: render, edit a source layer in place, rerender from the manifest;
  output matches the original. bash

### F2 · Layer

Why: one primitive, or the modularity claim collapses.

- [x] ISC-15: A new layer is local to its composition and creates no library
  entry.
  Probe: add a layer; the shared library is unchanged. bash
- [ ] ISC-16: Promoting a layer to the shared library is an explicit
  operation.
  Probe: no implicit path writes a library entry. bash

### F3 · Generation

Why: a module that produces content and holds no opinions about it.

- [ ] ISC-17: One generation command exists; `plate`, `object`, and `creator`
  are not kinds anywhere in `src/`.
  Probe: `rg` over `src/`. bash
- [ ] ISC-18: Output shape — full-canvas or isolated — is a request parameter.
  Probe: both shapes from the same command. bash
- [ ] ISC-19: Matting is an operation the caller invokes on any image, not a
  pass welded to generation.
  Probe: matte a local file with no generation involved. bash

### F4 · Agent surface

Why: the agent operates the tool; the human only asks for outputs.

- [ ] ISC-20: Every command prints compact text by default and valid JSON under
  `--json`.
  Probe: every command's default output, and `--json` parsed by a strict
  parser. bash
- [ ] ISC-21: Inspecting a fifteen-layer composition costs under the agreed
  token budget in default output.
  Probe: token count of `inspect` output. bash
- [ ] ISC-22: Top-level help names the three modules; module help names its
  commands. Using one part never requires reading the whole surface.
  Probe: read the help tree. manual

### F5 · Relocation discipline

Why: cutting enforcement must not cut correctness or lose hard-won knowledge.

- [ ] ISC-23: Region checking survives as a caller-parameterized command;
  YouTube's rectangles live in caller-supplied data, not in `src/`.
  Probe: run the check with a supplied region file; `rg` finds no hardcoded
  YouTube geometry. bash
- [x] ISC-24: Every removed gate's knowledge exists in a named skill — identity-
  anchor prompting, editorial-versus-decorative text, YouTube safe regions,
  likeness review.
  Probe: `.agents/skills/visual-authoring/SKILL.md` exists and covers all four. bash
- [x] ISC-25: Superseding ADRs exist for ADR-0001, -0004, -0006, -0008, and
  -0011.
  Probe: each superseding file exists and each superseded ADR is marked. bash
- [x] ISC-26: `CONTEXT.md` contains no term the tool no longer implements.
  Probe: `rg` for Plate, Object Asset, Creator Asset, Variant, Reference
  Thumbnail. bash
- [ ] ISC-27: Anti: no gate is deleted in the same change that relocates its
  knowledge.
  Probe: commit order — the skill lands before the deletion. bash
- [x] ISC-28: The ten SVGs in `assets/logos/` exist outside Ply before
  Ply's asset library is removed.
  Probe: all ten resolve in `ai-launchpad-content`; `deepseek`, `kimi`,
  `obsidian`, `opencode`, `qwen`, and `zai` previously existed nowhere else. bash

## Not yet specified

- **The ISC-21 token budget.** Needs a measurement of today's `scene inspect`
  output before a number means anything.
- **Stateful sessions.** agent-browser keeps state across invocations. Whether
  Ply's operations run long enough to need it is unknown.
- **Text-dense panels.** The generation ban is going, but the friction stands:
  recreating a UI panel like the reference thumbnail means many precise text
  layers. The edit module may want first-class help for this.
- **Generating into an existing layer** (img2img over a layer's current
  content). Plausibly valuable, not discussed.
- **Masks.** Deferred; a genuine compositing primitive that returns when the
  edit module grows.
- **The contact sheet.** Kept as a comparison command, but its shape after
  Variants are gone is undecided.

## Decisions

**Rename — Ply.** The accepted project name is Ply and the executable is `ply`.
The checkout is `projects/tools/ply` and the repository is `kenneth-liao/ply`.

**Layer addressing resolved — project-scoped sharing.** Accepted target design
is recorded in [ADR-0013](docs/adr/0013-project-scoped-layer-sharing.md): a
caller-selected Project is the live-sharing boundary, stable layer IDs survive
in-place edits, local names address uses, and immutable revisions pin renders.
Cross-project imports are independent copies. This resolved the addressing
blocker for ISC-9 through ISC-12; subsequent implementation evidence is recorded
under Verification.

**2026-09-07 — refined: the destination is a general composer, not a thumbnail
tool.** The canvas becomes arbitrary and YouTube becomes one thing Ply can
make. Safe-area checking survives as caller-supplied region data.

**2026-09-07 — Composition reuse is nesting, not flattening.** A composition
is an ordered list of layers; importing one brings its layers in individually,
and the importer may drop, reorder, and interleave them freely. *Dead end
considered and rejected:* adopting a render as a flat asset with a provenance
link. It is cheaper and keeps the render graph shallow, but it makes the A/B
case impossible — you cannot vary one layer of a base that has been flattened.

**2026-09-07 — Editing a shared layer carries explicit intent.** `--in-place`
propagates to every referrer; `--fork` copies for the current composition
only. There is no default when a layer has multiple referrers: the tool refuses
and reports the blast radius. A single-referrer layer edits with no ceremony.

**2026-09-07 — Variants are removed.** Named sparse change-sets inside a scene
are a second home for variation that the filesystem already handles: a base
composition plus separately-named compositions expresses the same thing with
no schema. Deletes `src/variants.ts`, the `variants` schema block, and the
multi-variant render path.

**2026-09-07 — No asset taxonomy.** *Dead end considered and rejected:* one
Asset type with orthogonal facets (`hasAlpha`, `isLikeness`, `approval`,
`provenance`). Correct as far as it went, but it kept a classification the tool
has no use for. With one uniform layer primitive there is nothing to classify:
if a property should vary independently, that is two layers. "Asset" survives
only as a descriptive word for external content a layer references.

**2026-09-07 — The content gates are removed.** The logo ban, the ban on
model-rendered text, the mandatory `identity` reference for likenesses, and the
trial/approved likeness gate all leave the tool. They enforce judgments about
intent that the tool cannot make and the caller can. Their knowledge relocates
to a skill first (ISC-24, ISC-27). *Known trade:* the `.trial.png` marker and
the manifest's `experimental` flag go with the approval gate. If an unattended
agent is ever allowed to publish directly, this decision needs revisiting.
*Supporting evidence:* `ai-launchpad-content` already keeps
`assets/creator-cutouts/approved/` as a directory convention, so the practice
already lives outside the tool.

**2026-09-07 — Contradicts ADR-0001, -0004, -0006, -0008, and -0011.**
Superseding decisions are recorded in ADR-0014 and ADR-0015 (ISC-25).
The narrow reversal: the composite is always local — that is what Ply is,
not a rule being removed —
while *where text pixels come from* becomes a caller decision.

**2026-09-07 — Masks deferred.** A real compositing primitive, but not
minimum functionality. Returns with the edit module.

**2026-09-07 — Clean break on stored work.** No scenes, renders, job records,
cutouts, plates, or masks exist on disk, so migration costs nothing. The single
exception is `assets/logos/` (ISC-28). Bundled fonts stay: they are the
renderer's registry, not content.

## Learning

Preparation evidence: ISC-24's named skill exists; ADR-0014/0015 supersede the five decisions named by ISC-25; the target
glossary no longer defines the retired terms (ISC-26). For ISC-28, all ten SVGs
and their metadata were copied without overwriting differing files to
`ai-launchpad-content/assets/logos/` and verified byte-identical. Originals
remain intact. The export is preserved in the consuming repository's history.
ISC-27 remains unchecked until the required commit ordering can be verified.

```
conjecture: reusing a composition means adopting its render as a flat asset with a provenance link
refuted-by: the A/B case — varying one layer of a reused base is impossible once the base is flattened
learned: reuse must preserve individual layer addressability; a composition is a list of layer references, not a node that gets baked
criterion-now: ISC-5 (anti-flatten), ISC-7 and ISC-8 (import brings layers in individually and they stay movable)
```

## Verification

Foundation probes below passed in separate `bun test --isolate <file>` invocations
on 2026-09-08 at `637cb17`; [spec #77's acceptance audit](https://github.com/kenneth-liao/ply/issues/77)
records the integrated delivery evidence. These closures concern the new
Composition model, not retirement of the legacy Scene surface. Whole-product
ISC-2/3/4/17–23/27 remain open; ISC-16's explicit promotion is not implemented.

- ISC-1: `test/composition-render.test.ts` — exact 1080×1080 and 2560×1440 output.
- ISC-5: `test/composition-import.test.ts` — individual shared IDs without baking; transitive import.
- ISC-6: `test/composition.test.ts`; `src/composition.ts` — ordered named Layer references; canvas/schema metadata adds no visual primitive (#77 US-002).
- ISC-7: `test/composition-import.test.ts` — subsetting imported uses without altering A.
- ISC-8: `test/composition-import.test.ts` — interleaving B's uses between imported Layers.
- ISC-9: `test/layer-edit.test.ts`; `test/composition-import.test.ts` — visible shared in-place propagation.
- ISC-10: `test/layer-fork.test.ts` — selected-use fork leaves other Compositions byte-identical.
- ISC-11: `test/layer-edit.test.ts` — ambiguous edit refusal names referrers and count.
- ISC-12: `test/layer-edit.test.ts` — single-referrer edit needs no intent flag.
- ISC-13: `test/composition-import.test.ts` — A → B → C renders with individual Layer addressability.
- ISC-14: `test/render-history.test.ts` — byte-identical replay after edits and relocation, within the recorded rendering environment.
- ISC-15: `test/composition.test.ts`; #77 acceptance audit US-002 — Project-local publication, no implicit library entry.
- ISC-24/25/26: `693bc03` — authoring skill, superseding ADRs, and target glossary preparation.
- ISC-28: #77 acceptance audit DEC-005 — prior logo export retained in the consuming repository's history.
