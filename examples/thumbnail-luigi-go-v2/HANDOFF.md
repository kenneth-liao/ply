# Handoff — thumbnail re-test with spec #132 surface (2026-09-10)

Re-run of `examples/thumbnail-luigi-go/` (HANDOFF.md, 2026-09-09) against the
shipped spec #132 surface: in-tool resize, placement anchors,
renderer-consistent measurement, and uniform shadow/outline effects. Saved as
a self-contained sibling Project so the two renders can be compared
side-by-side. No new generation, no new matting, no external image editing —
all source bytes are the original retained outputs.

## The artifact

`examples/thumbnail-luigi-go-v2/` is a self-contained Ply Project:

- Composition `thumb`, 1280×720, three layers in paint order:
  1. `bg` — full-canvas platformer level, from Generation Job
     `gen-20260910-5a5ce6fd` (gpt-image, full-canvas intent), ingested with
     `--from-generation` (provenance retained).
  2. `luigi` — jumping hero, from matte `luigi-jump` (local BiRefNet HR
     segmentation of Generation Job `gen-20260910-2432e2ef`, isolated
     intent, nano-2), ingested with `--from-matte` at its native 1024px,
     then resized **inside Ply** to an effective 450×450
     (`--resize-to 450x`, scale 0.439453125×). Content hash stays
     `328c9f6f…` (the 1024 matte) — v1's revision replaced the bytes with
     a `/tmp` sips downscale (`58c78e7a…`, lineage lost).
  3. `banner` — local text Layer, `LUIGI GO`, Anton 110 px, `#FF8C00`,
     anchored `center,top` at (640, 36) in two placements (no
     render-look-adjust loops), with the previously-dropped treatments
     applied: shadow `0,6,18,#000000aa` + outline `2,#101014`.
- Final output: `renders/thumb-mtvun7ts-88f58480.png` + its retained
  manifest. Replay from the manifest reproduces the PNG byte-identically
  (`cmp` clean).
- Generation job records and matte provenance are retained inside the
  Project (`generation/`, `matting/`, `content/`) and resolve offline.

Reproduce / inspect:

```bash
bun run ply composition inspect thumb -p examples/thumbnail-luigi-go-v2
bun run ply composition measure thumb -p examples/thumbnail-luigi-go-v2
bun run ply composition render thumb -p examples/thumbnail-luigi-go-v2
bun run ply layer review layer_mtvumf4f_x7go1m --out /tmp/luigi-v2-review.html -p examples/thumbnail-luigi-go-v2
```

Measured geometry (final):

```text
1. "bg" (image content 1280×720) box (0, 0) 1280×720 painted (0, 0) 1280×720
2. "luigi" (image content 1024×1024) box (70, -22) 450×450 painted (183, 29) 235×348 [scale 0.439453125×]
3. "banner" (text 331.63×165) box (474, 41) 331.63×165 painted (432, 36) 416×185 [shadow 0 6 18 #000000aa, outline 2 #101014]
```

Luigi's painted footprint `(183, 29) 235×348` matches v1 exactly — same
pixels on canvas, but the source bytes and matte/generation lineage are
intact.

Costs: $0. No generation or matting ran; everything reused retained
`out/` records on this machine (gitignored). The committed Project does
not need them.

## Findings mapped to v1 (F1–F18)

- **F1 (no per-layer resize) — fixed.** `--resize-to 450x` reproduced the
  external sips step in-tool, non-destructively. `layer inspect` still
  reports the 1024 source; only placement carries the scale.
- **F9 (scratch-file provenance gap) — fixed by construction.** No scratch
  file exists; there is nothing to record a derivation flag for. The v1
  workaround path is simply not taken.
- **F3 (no text anchoring) — fixed.** Banner centered in one anchored
  placement (`center,top` → 640, 36). v1 took three render-look-adjust
  loops (x 355 → 440 → 470 with a size change).
- **F2 (no text effects) — fixed.** The dropped drop-shadow is now a
  uniform Layer effect, plus an outline. Both apply to text glyphs; shadow
  also applies to image alpha (uniform, per US-003) though this run leaves
  Luigi clean for a faithful comparison.
- **F7 (placement loop) — reduced, not eliminated.** Anchors + `measure`
  landed both layers with one render total. Visual review is still
  necessary (and still done — both PNGs eyeballed), per the operating
  skill's stated contract. Four renders → one.
- **F4 (negative-coordinate CLI gotcha) — unchanged, worked as documented.**
  `--y=-22` applied cleanly; `--y -22` still parses as a flag (expected
  option-parser behavior, separate follow-up #128).
- **F5 (provider as policy surface) — not re-probed.** No prompts were sent;
  nothing to refuse. Nano-2 default + explicit-model override remain
  unexercised in this run by design (no spend).
- **F6 (matting latency) — not re-probed.** No matting ran; the retained
  matte was reused. Investigation #130 owns the measurement.
- **F8 (no composition safe-area view) — still open.** Banner kept
  top-center by judgment, same as v1. Follow-up #131.
- **F10/F11 (operating skill) — fixed.** This entire run followed
  `.agents/skills/ply-operating/SKILL.md` end-to-end (generate → matte →
  ingest → measure/edit → render) without reading the legacy surface.
- **F12–F18 (help/output/docs coherence) — out of scope for this run.**
  Open follow-ups #126–#129.

## New observations (current version)

1. **Effect-then-anchor ordering matters and is learnable but sharp.**
   Anchoring the banner pre-effects placed ink at (477, 36); adding
   shadow+outline grew painted bounds to (432, -2), clipping the canvas
   top. Re-anchoring post-effects seated the effect-inclusive ink at
   (432, 36), clean. The skill documents "anchor, then effects last" plus
   "re-anchor when geometry changes" — both halves were needed in that
   order, in this run. A single combined anchor+effect edit is refused by
   design; the two-step is the workflow.
2. **Blur expansion is larger than the blur radius suggests.** Blur 18 +
   outline 2 moved the banner's painted top 38 px (36 → -2). Not a bug —
   paint-accurate measurement reported it before the render — but callers
   should expect generous effect padding and always re-measure after
   applying effects.
3. **`composition inspect` shows intrinsic, not effective, image size.**
   Luigi reads as `1024×1024 png` at `(70, -22)`; the 450 effective size
   lives in `layer inspect` (scale factor) and `measure` (box). Correct
   per the non-destructive contract, but a reader comparing v1 (`450×450`)
   against v2 side-by-side could misread it as unresized. `measure` is the
   source of truth for on-canvas footprint.
4. **Replay writes a fresh manifest into `renders/`.** The byte-identity
   check passed, then the replay-generated manifest was removed to keep
   the example at one render + one manifest, mirroring v1. Tool behavior
   is fine; example hygiene just needs the prune step.

## Cleanup notes

- Nothing outside `examples/thumbnail-luigi-go-v2/` was touched; `git
  status` shows only that untracked folder. No `src/`, docs, or ISA
  changes.
- Scratch left: `/tmp/replay-v2-check.png` (replay output, outside the
  repo). No `/tmp` image inputs — there were none this time.
- `out/generation/gen-20260910-5a5ce6fd/`,
  `out/generation/gen-20260910-2432e2ef/`, and `out/matting/luigi-jump/`
  remain on this machine only (gitignored) and were read, never written.
