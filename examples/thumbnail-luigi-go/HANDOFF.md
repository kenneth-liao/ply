# Handoff — thumbnail end-to-end test run (2026-09-09)

First real-world pass over the spec #102 surface: uniform `generate` (both
intents) → independent `matte` → Project/Layer/Composition authoring →
local render. Saved as a runnable example to inform the next spec toward
the ISA destination (general-purpose composer; thumbnails are one thing
Ply can make, not what it is).

## The artifact

`examples/thumbnail-luigi-go/` is a self-contained Ply Project (2.6 MB):

- Composition `thumb`, 1280×720, three layers in paint order:
  1. `bg` — full-canvas platformer level (blue sky, clouds, dirt ground,
     green pipes), from Generation Job `gen-20260910-5a5ce6fd`
     (gpt-image, full-canvas intent).
  2. `luigi` — jumping hero with fist raised, mid-air over the tall pipe,
     from matte `luigi-jump` (local BiRefNet HR segmentation of Generation
     Job `gen-20260910-2432e2ef`, isolated intent, nano-2), downscaled
     locally to 450 px (see F1).
  3. `banner` — local text Layer, `LUIGI GO`, Anton 110 px, dark orange
     `#FF8C00`, top-center.
- Final output: `renders/thumb-mtuup6ub-6526cf90.png` + its retained
  manifest. Superseded iteration renders were pruned; layer revisions keep
  the full edit history.
- Generation job records and matte provenance are retained inside the
  Project (`generation/`, `matting/`, `content/`) and resolve offline.

Reproduce / inspect:

```bash
bun run ply composition inspect thumb -p examples/thumbnail-luigi-go
bun run ply composition render thumb -p examples/thumbnail-luigi-go
bun run ply layer review layer_mtuudjt8_k03vnm --out /tmp/luigi-review.html -p examples/thumbnail-luigi-go
```

Measured costs (real Gateway billing, `✓` figures only): background
$0.0045, character $0.067.

## Verified in this run

- **Relocation holds.** The Project was built under `tmp/` and moved to
  `examples/`; replaying the retained manifest from the new location
  reproduced the PNG byte-identically (`cmp` clean). The move itself was
  the relocation proof.
- **Matte quality is genuinely good.** 865k transparent px, no halo or
  painted-background remnants in the composite, edges clean at 168 px
  eyeball size.
- **Local text is crisp and cheap to iterate.** Two banner adjustments
  (centering, size) were instant offline edits; spelling exact by
  construction, per the visual-authoring skill's editorial-text guidance.
- **Single-referrer edits need no ceremony** (ISC-12 behavior observed:
  plain `layer edit --x` just worked).
- **Ply imposed no content policy.** The one refusal came from the upstream
  provider (see F5); the tool itself never judged the request (ADR-0014
  holds).

## Friction and limitations (spec input)

**F1 — No per-layer resize.** Layers paint at intrinsic size; position and
opacity are the only effects (`composition-paint.ts`). The 1024 px matte
could not be placed airborne at full size without clipping, so it was
downscaled with `sips` outside the tool and ingested via `layer edit
--image`. Consequence: that revision's content links to a `/tmp` scratch
file, not the verified matte output (prior revisions keep their
matte/generation lineage). Spec question: a uniform `scale` (or
width/height) on every layer type — squarely the ISA "one primitive,
uniform features" principle, and the missing cell in the ISC-3 matrix.

**F2 — No text effects.** No shadow, outline, or stroke on text layers.
The requested drop shadow was dropped; the banner is flat fill. Spec
question: text treatment (shadow/outline) as a uniform layer effect, or an
explicit non-goal with a documented bake-elsewhere recipe.

**F3 — No text anchoring.** No center/right anchor and no way to measure
text width before placing, so horizontal centering took two
render-look-adjust loops (x 355 → 440 → 470 with a size change). Spec
question: placement anchors (`center`, `right`) or a measure-text helper
for agents.

**F4 — Negative-coordinate CLI gotcha.** `--y -40` fails with an
"ambiguous option" error; `--y=-40` works. The error message does explain
the fix, so this is polish (examples in help), not a bug.

**F5 — Upstream provider is the new policy surface.** The trademark-heavy
character prompt ("plumber / L emblem / platformer") was refused by
gpt-image's safety system before any spend; genericized wording on nano-2
succeeded at 15× the cost ($0.067 vs $0.0045). Ply correctly imposed
nothing — but callers should know the model behind `generate` has opinions
Ply doesn't. Candidate skill note: steer identity-adjacent prompts toward
generic visual description plus a capable fallback model.

**F6 — Matting takes ~6 minutes per invocation, every time.** 563 MB
weights are read, hashed, and session-compiled (CoreML, partial CPU
fallback) once per process, and each `ply matte` is a fresh process. Fine
for occasional use; punishing in a loop. Data point for the ISA "stateful
sessions" open question: if matting (or multi-step agent flows) get
frequent, a warm long-lived process that loads the session once is the
structural fix.

**F7 — Placement is a render-look-adjust loop.** Four renders (one
initial, three adjustments) to land Luigi and the banner. The agent had eyes on pixels here; a headless agent
run would be placing blind. Related to F3: anchors plus a cheap
measure/overlap query would cut the loop.

**F8 — No composition-level safe-area view.** The banner was kept
top-center by judgment (duration badge bottom-right, progress strip
bottom). `scene guidelines` exists for the legacy surface; compositions
have no equivalent, and ISC-23 (caller-parameterized region check) is
still open. This run is a concrete use case for it.

**F9 — Scratch-file provenance gap.** `/tmp/luigi-small.png` (the resized
asset) and the original `out/generation/` + `out/matting/` records are
local-only and gitignored; only the Project is committed. That is the
designed split, but F1's workaround stretches it: the bytes that actually
shipped have no provenance record pointing at the matte they derive from.
A `layer edit --image` that optionally records `--derived-from-matte`
would close it.

## Suggested next-spec candidates

1. Uniform layer transform: `scale` (F1) — highest leverage, unblocks
   real thumbnails.
2. Text treatment and anchoring (F2, F3) — banner-quality text without
   loops.
3. Caller-parameterized safe-region check for compositions (F8, ISC-23).
4. Derivation provenance on image ingest (F9).
5. Warm-session strategy for local inference (F6) — only if matting
   frequency justifies it.
6. Skill note on provider-side prompt sensitivity + fallback models (F5).

## Cleanup notes

- `tmp/` is empty again (only scratch left: `/tmp/luigi-small.png`,
  `/tmp/replay-check.png`, both outside the repo).
- `out/generation/gen-20260910-5a5ce6fd/`,
  `out/generation/gen-20260910-2432e2ef/`, and `out/matting/luigi-jump/`
  remain on this machine only (gitignored). The committed Project does
  not need them.
- Nothing in this change touches `src/`, docs, or the ISA. Uncommitted:
  `examples/` (this folder). Review and commit as one unit.
