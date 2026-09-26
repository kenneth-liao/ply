# picture-it benchmark on outlier test 2 (2026-09-24)

Frozen research. It reruns the eight thumbnails of
`2026-09-23-outlier-test-2` with
[geongeorge/picture-it](https://github.com/geongeorge/picture-it) and compares
the results with Ply's best renders. Nothing here is maintained. Its remaining
gaps were checked against spec #285 and tickets #289–#316 and are now tracked:
gap 1 is #343, gaps 2–4 are #344, and gap 5 is #345 (`wontfix`). The bounds
question for #306 was later settled by ADR-0026.

- `scripts/`: the FAL calls as run from the local bench workspace, which
  calls picture-it through `./bin/picture-it`. `$CONTENT_ROOT` is
  `ai-launchpad-content`.
- `overlays/`: the `compose` JSON for the local thumbnails. In
  `t3-logo-fix.json` the embedded logo data URIs are replaced by a placeholder.
- `t1-picture-it.png`: the one render with no person in it.
- The full report (`report.html`, images embedded) and the comparison sheet
  contain Kenny's likeness and third-party reference thumbnails. They live in
  the private content repository at
  `assets/creator-cutouts/qualification/picture-it-benchmark/`.

---

picture-it `5a3247d` (v0.2.2), run from source with Bun. Ply figures are from
outlier test 2 (Ply `36a1c96`, rounds 1–3). Both runs used the same
references, cutouts, logos and identity anchors. picture-it was driven the way
its own agent skill teaches.

| | |
|---|---|
| Spend | $1.16 on the FAL dashboard (picture-it's hardcoded table said ≈ $1.12). Ply: $0.38 for three rounds, from Gateway billing |
| FAL calls | 14 paid: 5 generate, 8 edit, 1 matte. 9 refused (empty balance, then a stale lock) at no cost |
| Call time | flux 3–7 s, banana-pro 22–37 s, banana2 22 s, seedream 57 s, Bria matte 7 s |
| Local compose | 0.4–0.9 s per thumbnail |
| Credentials | `FAL_KEY` only. Matting and upscaling are cloud calls too |

## Verdict

A different bet, not a better Ply. picture-it has the model do the
composition and uses Satori and Sharp only for small text and overlays. It
beat Ply only where one AI pass could design the whole frame: t1 and the t2
title. Ply won on likeness (t3, t7; Kenny's review), product fidelity (t6),
typography, precise placement, provenance, offline work, and keeping approved
cutouts exact. The
tool is about 5.6k lines of TypeScript, built over one weekend (2026-04-04 to
2026-04-06), with no tests, no licence file, and no commits since.

| Thumb | picture-it method | Cost (table) | Closer to reference |
|---|---|---|---|
| t1 | flux-dev plate + one banana2 edit with 5 logos (title, tiles, wires, tag, frame) | $0.26 (incl. one mis-cropped banana-pro try) | picture-it |
| t2 | flux-dev plate + approved cutout + seedream title edit | $0.07 | picture-it (title only; face drifted) |
| t3 | one banana-pro edit, then real logos composed over the altered AI tiles | $0.15 | Ply (likeness) |
| t4 | flux-schnell plate + compose | $0.003 | tie (Ply type better) |
| t5 | flux-dev plate + compose, `skewX` faux italic | $0.03 | tie |
| t6 | one banana-pro edit incl. title, one retry | $0.30 | Ply (older iPhone design both times) |
| t7 | banana-pro edit, retry for 16:9 | $0.30 | Ply (likeness) |
| t8 | compose only | $0.003 | tie |

## Where picture-it is better
- **Text layout (Satori flexbox):** mixed-style runs, `skewX`, rotated padded
  boxes, underline, borders and padding, nested groups. This covers outlier
  test 2 gaps 3 and 4 and part of 5.
- **Image masks:** preset shapes or any SVG path.
- **Stroke-only shapes; `line` and `arrow` shapes with from/to points** (gaps 1 and 6).
- **Edit-the-frame as the main verb:** multi-image edits handled marks and
  layout (t1) and integrated lighting (t3) in one call.
- **Model range:** 15 FAL models behind one key, $0.003 drafts.
- **Finishing:** six named grades, grain, vignette, reflection, watermark,
  platform presets, `info`, and JSON `pipeline`/`batch`.
- **Skill:** plan first, estimate cost, offer 2–3 directions; a prompt
  library; the text-behind-subject pattern.

## Where Ply is better
- **State:** named, editable Layers and re-renders. picture-it goes file to
  file, and AI edits bake everything in.
- **Provenance:** Ply keeps Generation Jobs with sha-256. picture-it records
  nothing and discards the raw model output after cropping.
- **Offline and privacy:** Ply mattes locally. picture-it uploads every input,
  including identity photos, to FAL.
- **Fonts:** 15 bundled files plus `--font-file` in Ply. picture-it has 6
  hardcoded files; the skill's drop-in `.ttf` advice doesn't work (verified
  with Anton).
- **Precision:** `measure`, ink anchors, visible-region crop, flip,
  `--vector-color`, per-Layer blend modes, off-canvas bleed. picture-it has
  none of these; blend works only on full-canvas gradients.
- **Fidelity:** gpt-image-flare reproduced the iPhone 18 Pro camera plateau;
  banana-pro didn't, even with an explicit retry. Ply's likenesses (t3, t7)
  were better on Kenny's review.
- **Engineering:** clear refusals and tests. picture-it prints raw stack traces
  and has schema fields that are never implemented (`deviceFrame`, line `curve`).

## Detail checks
- **Approved-cutout drift:** a seedream edit told to change only the title
  re-rendered the composed approved cutout (sharper, warmer skin, more spots).
  Mean absolute difference in the face crop: 20.9 per pixel on a 0–765 scale.
- **Matting, same source (`m-g6-kenny-v2`):** Bria gives a cleaner hair edge
  with no light fringe but drops fine strands. Ply's local BiRefNet keeps more
  strands and has the known fringe. Arm and phone edges are about equal.

## Friction
1. An empty FAL balance produced a 20-line client stack trace; one call still
   failed after the top-up.
2. The Anton font dropped into `~/.picture-it/fonts/` silently fell back to Inter.
3. The skill says Satori has no transforms; `rotate` and `skewX` work, but
   rotated content clips at its box edge.
4. Every upload is sent as `image/png`, so SVGs must be rasterized first. `crop`
   works as a converter but cover-crops non-square marks.
5. banana-pro edits get no aspect ratio: the output copies the first input's
   shape and is then cover-cropped (t1 lost tiles, t7 came back 560×560).
   Workaround: pass a 16:9 layout reference first.
6. The raw model output is thrown away after cropping.
7. Zone coordinates from 0 to 100 are percentages; others are pixels. `x: 70`
   meant 896 px. I placed 7 elements wrong this way.
8. Negative positions clamp to 0, so there's no bleed off the left or top edge.
9. An overlay larger than the canvas crashes Sharp with a stack trace.
10. There's no trim, region crop, flip, recolour or measure. Four trims, one
    flip and three recolours were done in Sharp outside the tool.
11. Anchors are center plus four corners only; there's no bottom-center.
12. Overlay asset paths resolve from the current directory.
13. Costs come from a hardcoded table; there's no billing read ($1.12 by the
    table, $1.16 billed).

## Overlap with planned work

Checked on 2026-09-24 against spec #285, tickets #289–#316, the ISA, and
`main` at `0053ceb`.

| picture-it finding | Status in Ply |
|---|---|
| Mixed-style text runs | Planned: #297 |
| Skew / faux italic, perspective | Planned: #298 |
| Grouping | Planned: #306 ADR, then #307 |
| Wrap width, shrink to fit | Planned: #294, #295 |
| Image masks, including shape and SVG-path masks | Planned: #304 ADR, then #305 |
| Blur / depth of field | Planned: #299 |
| Cutout halo | Planned: #300 |
| One-sided rim light, stacked effects, inner shadow | Planned: #301, #302, #303 |
| Cover fit, 16:9 sheets, delete, short hashes, refusals | Planned: #293, #292, #290, #291, #289 |
| Layout independent of placement, anchor parity | Shipped: #287, #288 |
| Line / arrow shape | Ruled out by the ISA (2026-09-23 dead end) |
| Model range | Exists: `nano-2`, `nano-pro`, `seedream`, `flux`, `recraft` via Gateway |

## Deferred in fog, with new evidence

picture-it lays out text with Satori, a CSS flexbox subset: boxes with
padding, background and border, holding children in rows or columns with gap
and alignment. Runs, skew, wrap, fit and moving as a unit are planned (#297,
#298, #294, #295, #307). What is not planned is **content-driven layout**:

- **Hug:** a pill, badge or name plate that resizes when its text changes. In
  Ply that is a shape Layer plus a text Layer, re-measured by hand after each
  text edit.
- **Flow:** a logo + "Launchpad" + "Tutorials" row, bullets, or labels under
  bars that keep their spacing when a member changes size. With #307 members
  move together, but their positions inside the unit stay absolute.

Spec #285 OOS-005 keeps "relative layout between separate Layers" in ISA fog.
This test adds evidence: t4, t5 and t8 each took one block with no `measure`,
where outlier test 2 logged a colliding first guess (t4), no helper for
placing between two points, and hand-computed coordinates.

picture-it's form doesn't fit Ply. Its children are not Layers, so they can't
be shared, forked, given effects or addressed by name, and a text box with its
own background is the ISA's 2026-09-19 dead end ("a bar is its own Layer").
A Ply-shaped form keeps every element a Layer and puts layout rules on the
unit that #306 is deciding, a nested Composition: flow its members in a row
or column with a gap and alignment, and let a member hug another with padding.
It depends on whether the nested Composition's bounds are a fixed canvas or
derived from its content. #306 can settle that, keeping these rules possible
later, without building them now.

## Remaining gaps (#343, #344, #345)
1. **A stroke-only shape paints nothing and gives no error.** On `0053ceb`,
   `--fill "#00000000" --outline "6,#39ff5a"` rendered a blank canvas and
   reported success. Outlier test 2 follow-up 3; not in #285. Either the
   outline stops depending on the fill, or Ply refuses it and points to the
   SVG route.
2. **The skills don't teach "edit the whole frame":** render the Composition,
   generate with the render as Reference 1, bring the result back as a new
   Layer or fork. It gave the best t1. Teach it with the t2 drift rule: never
   AI-edit over an approved cutout; put approved cutouts back on top. #309 and
   #310 don't cover it.
3. **The skills have no model-choice guidance.** The Nano Banana family was
   strong at multi-logo layout with faithful marks but weaker on product
   fidelity and likeness than `gpt-image-flare`. Measure `nano-2` and
   `nano-pro` on the same jobs through Gateway, then teach the choice.
4. **The skills don't plan with a cost estimate** or offer 2–3 directions
   before spending. A small addition to #308/#309.
5. **Minor:** no deterministic grain or noise option; underline could be a
   per-run decoration in #297's run model.

Don't copy: stateless chains, overloaded percent/pixel coordinates, silent
clamping, hardcoded prices, or discarded raw outputs. The repository has no
licence, so its code can't be reused; only its ideas can.
