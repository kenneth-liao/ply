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

## Documentation, CLI surface, and agent-skill findings (added 2026-09-09)

A separate review of the docs, the help tree, and the skill inventory,
run against the same shipped surface. The run above found what the tool
cannot yet do; this section covers what an agent cannot yet learn or
navigate. Numbering continues the F-series so specs can cite either set
uniformly.

**F10 — No skill teaches an agent to operate Ply.** The only Ply skill is
`.agents/skills/visual-authoring/SKILL.md`, and it covers content practice
(identity-anchor prompting, editorial-versus-decorative text, safe
regions, likeness review). It names no command and describes no workflow.
Nothing documents the generate → matte → layer → render path as a single
sequence — the exact path this run had to discover by reading the whole
surface. Directly related to F7: a headless agent is placing blind partly
because nothing tells it how the pieces connect. F5's "candidate skill
note" would land in this skill if it existed.

**F11 — The skill is invisible to Claude Code.** `visual-authoring` exists
in `.agents/skills/` but is not mirrored into `.claude/skills/`, unlike
the other seventeen skills, which exist in both. A Claude Code session in
this repo never loads it. ISC-24 is checked and its probe passes, because
the probe only tests `.agents/`.

**F12 — Two modules have no working help.** Root help instructs the caller
to run `ply <module> --help`. For `scene` and `jobs` that returns
`{"ok":false,...}` with the message "unknown command --help", and the
entire help text is embedded inside a JSON string field with escaped
newlines. ISC-22 fails on its own probe.

**F13 — An unknown flag crashes with a stack trace.** `ply library list
--json` throws an uncaught `ERR_PARSE_ARGS_UNKNOWN_OPTION` TypeError from
`src/library-cli.ts:94` and prints a Bun stack trace. A usage error is the
expected shape.

**F14 — Three output contracts across eight modules.** `project`,
`composition`, `layer`, `generate`, and `matte` print compact text and
accept `--json`. `scene` and `jobs` always print JSON. `library` always
prints text and rejects `--json` (see F13). This is ISC-20's gap, measured.

**F15 — Three invocation spellings in the help text itself.** Root help
writes `ply project init`. The `project`, `composition`, and `layer` help
write `bun run ply project init`. The `generate`, `matte`, `scene`,
`library`, and `jobs` help write `bun run generate`. An agent copies
whichever form it read most recently. Not covered by any ISC.

**F16 — Help screens carry contract prose.** The `scene` help runs about
150 lines and explains lock-file recovery, byte-comparison before commit,
and the 64 MB encoded input cap. Those facts have a home under `docs/`.
In the help tree they defeat ISC-22's requirement that using one part
never requires reading the whole surface, and they are expensive for an
agent to page through. Root help also labels `scene`, `library`, and
`jobs` legacy without saying which surface a caller should start from.

**F17 — README contradicts the shipped surface.** Line 9 states that
"generation unification and the matting/region-gate migration remain
unimplemented," which spec #102 shipped and the rest of the same file
documents. Line 174 has an orphan heading ("Generate source content and
matte it:") with no code block under it. Structurally the legacy Scene
workflow still holds the largest share of the file, including the full
JSON example and the Quick start, while the composer surface gets a
shorter section. No page walks the end-to-end path this run actually
took. No ISA claim covers documentation accuracy, so nothing catches this
drift.

**F18 — Negative-coordinate parsing (see F4) is one instance of a wider
argument-handling gap.** F4, F13, and F15 are all the same layer: option
parsing and its error presentation are per-module rather than shared.

### ISA coverage of this section

- F12, F16 → ISC-22 (open; its probe is manual).
- F14 → ISC-20 (open).
- F10, F11, F13, F15, F17, F18 → no claim covers them.
- ISC-21 cannot be probed yet: its token budget is still in "Not yet
  specified," pending a measurement of current `inspect` output.

### ISA bookkeeping observed while mapping

- ISC-18 (output shape as a request parameter) and ISC-19 (matting as a
  caller-invoked operation on any image) appear satisfied by this run's
  evidence but remain unchecked.
- ISC-17 still fails, for a different reason than it was written for. The
  probe greps `src/` for `plate`/`object`/`creator`; the hits are now
  concentrated in the retained legacy code, heaviest in `src/assets.ts`
  and `src/library-cli.ts`. It is blocked on retiring the legacy surface,
  not on generation work.
- F4's rationale says the agent operates the tool, but its three claims
  (ISC-20/21/22) are all about output format and help text. Nothing in
  the ISA would be false if no agent could determine the workflow, which
  is the gap F10 names.

### Backlog state at time of writing

No open issues. Everything through #115 is closed, so nothing is
currently scheduled against any finding in this document, from either
section.
