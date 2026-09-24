# Outlier test 2 — eight recent outliers, three rounds (2026-09-23)

Frozen research. It informed the ISA refinement (ISC-47 to ISC-64, PR #284)
and spec #285, which now own every conclusion. Nothing here is maintained.

- `scripts/`: the generation and build scripts as run. `$WORKSPACE` is the
  local test workspace, `$CONTENT_ROOT` is `ai-launchpad-content`. The report's
  `build.sh`, `gen.sh`, `build2.sh`, and `gen2.sh` are
  `build-round1.sh`, `generate-round1.sh`, `build-round2.sh`, and
  `generate-round2.sh`; round 3 is `round3-t6c.sh`.
- The renders, comparison sheets, and likeness candidates contain Kenny's
  likeness and third-party reference thumbnails. They live in the private
  content repository at
  `assets/creator-cutouts/qualification/ply-285-baseline/`.
- The report below was written during the test. Its `final/…` and `logs/…`
  paths are relative to the local workspace.

---


Ply `main` @ `36a1c96`. Every image operation ran through Ply: generate, matte, composition add/edit, measure, render, sheet.
The references are in `ref/`, the renders in `final/t1..t8.png`, and the side-by-side sheet is `final/comparison.png`. The build script is `build.sh`; the pass-2/3 edits were run by hand with `ply layer edit <comp>/<use>`.

| | |
|---|---|
| Compositions / Layers | 8 / 90 (t1 alone has 25) |
| Generation | 9 Jobs, 13 images, **$0.145** total; every Job took 10–22 s |
| Likeness | 2 Jobs, Flare `low` + identity anchor (caller route): g3 (IMG_1535) and g7 (IMG_1505) |
| Matting | 2 local passes (phone, vial), 5–9 s |
| Build time | ~49 s for all 8 (add + render) |
| Refusals hit | 6 (all clear, none mutated state) |

## Worked well
- **One-command add + name addressing.** 90 Layers were built with no id capture and no follow-up placement edits. Pass-2/3 iteration by `t4/kenny` worked well.
- **Shapes replaced every pre-drawn asset** from test 1: bars, pills, tiles, the folder chart (t8 is 100% shapes + text + one cutout), badges and gradient backgrounds.
- **SVG import + `--vector-color`**: one logo file each, crisp at 46–70 px, recoloured per use.
- **Screen blend**: the generated light burst on black dropped onto the t3 scene with no matte. It was the best single effect in the test.
- **Gradient text**: HERDR, "Are Changing" and "iPhone 18 Pro" match the refs' treatment and stay editable.
- **Grade on backgrounds**: `--brightness 0.55` on the t6 maze fixed title contrast in one edit.
- **Generation**: Flare default + explicit `--size`, fast and cheap. g3 likeness (surprised, holding the box) is strong. Generated vials and phone matted cleanly.
- **`--from-generation` refusal** listed the outputs when a Job had 2. **`composition sheet`** with `--pair` served all visual review.
- **`measure`** gave exact painted boxes for placing adjacent text runs.

## Did not work well / gaps
1. **No stroke-only shape.** A transparent `--fill` + `--outline` paints nothing, because the outline follows fill alpha. t1's green frame needed 4 bar Layers.
2. **Directional glow is weak.** The direction is only an offset of `strength × width` px (`composition-paint.ts:526`). Edges at 90° to the light stay fully lit, and a wider glow reads as an all-round outline (t2 pass 3). A one-sided rim is not reachable.
3. **No mixed-style text runs.** "5 / HERDR / PLUGINS" and "Launchpad / Tutorials" had to be separate Layers placed by `measure`. My first guess collided (t4).
4. **No italic/oblique or skew.** t5's italic headline can't be matched; Archivo has no italic and there is no skew transform.
5. **No grouping.** The rotated tag, tile + logo + caption, and badge + text each need the same rotate/anchor on 2–3 Layers. Moving t2's text block took 4 edits.
6. **No line/path shape.** t1's plugin connector curves were dropped.
7. **No blur / depth of field.** t7's out-of-focus foreground vials can't be matched.
8. **Matte edge fringe** on the approved cutouts shows as a light halo on saturated backgrounds (t5 blue). Ply has no choke/defringe control.
9. **Baked content in generated plates can't move.** t2's generated UI panel sits under the headline; the fix is a new plate or a visible-region crop.

## Friction
- `--from-generation` refusal lists 12-character short hashes, but `--output` rejects them (it wants an index or the full sha).
- `composition sheet` of plain files still needs a Project (`missing ply.json`).
- `sheet` cells are always square: 16:9 cells waste ~45% of the sheet, which gets long quickly (8 pairs = 1304×5416).
- `sheet` labels generated outputs with the 64-character hash; I needed `--label` for every input.
- `--pair` refuses `--columns` (the rule is clear, but only discovered by trying).
- Cutouts are 2048×1536 with a lot of padding, so `--resize-to` sizes the padding. `--scale` + ink anchor works, but needs a `measure` first.
- No `composition delete`: a probe Composition stays in the Project.

## Broken
- **`composition remove` / `composition inspect` on an unknown Composition** print a raw `ENOENT … compositions/<name>.json`. `layer edit` gives a clear "not found, existing: …" message.
- **Stale `ply-operating` skill:** it says omitting `--model` selects **nano-2**, but `ply generate --help` (since #281) says **gpt-image-flare**.

## Likeness (needs your review; nothing is approved)
- g3 (IMG_1535 → surprised holding the box): close match.
- g7 (IMG_1505 → extreme close-up with tear): recognisable, but looks **older and harsher** (deeper lines). The anchor face is small in a wide frame, so the close-up invents detail. A tighter anchor crop or `medium` quality is the next thing to try.

## Suggested follow-ups (ranked)
1. Fix the `ENOENT` messages + the stale skill default (small).
2. Accept short hashes in `--output`.
3. Stroke-only shapes (outline independent of fill).
4. Sheet: `--cell WxH` (16:9 cells), hash-free default labels, no Project needed for file inputs.
5. Design topics: text runs (mixed colour/weight in one Layer), Layer groups/shared transforms, skew/oblique, a one-sided rim model, a blur effect, a line/path shape, matte edge choke.

---

# Round 2: same tool, better practice (t1b, t3b, t6b, t7b)

No Ply changes. The goal was to find how many round-1 misses came from practice (skills, docs, my choices) and how many from real tool gaps.
Order used: **local library → source common assets → generate** (Kenny's rule).
Added cost: **$0.13** (5 Jobs, 8 images). Total for both rounds: **~$0.27**. Refusals: 0.

| Thumbnail | Round-1 miss | Round-2 approach | Result |
|---|---|---|---|
| t1 | White, substituted logos | Sourced full-colour GitHub/Notion/Slack/Drive/Postgres SVGs (Wikimedia, Simple Icons), no `--vector-color` | Fixed |
| t1 | No light wires | ONE generated wire on black ($0.005), reused 5× via visible-region crop + scale + rotate + `--blend screen` | Fixed (endpoints placed by hand) |
| t1 | MUST TRY: solid box, black border, no ticks | Generated neon frame with ticks on black + screen blend; glowing text | Fixed |
| t1 | Tiles flat, not angled inward | No perspective/skew transform | **Still open (tool gap)** |
| t3 | M5 badge drawn from boxes | Apple Newsroom M5 Ultra chip, cropped with `--visible-region` | Fixed |
| t6 | Wrong pose (headshot) | Likeness generation: anchor + Apple's iPhone 18 Pro colour-lineup photo as Reference 2 → matte → Layer | Fixed |
| t6 | Fictional phone | The same Reference gave the real iPhone 18 Pro design | Fixed |
| t7 | Aged face | Tighter anchor crop (face fills the frame); `low` was enough, `medium` added nothing | Fixed |

The biggest lever was **one element, one Layer**. Each generated element on black (wire, frame, beams) cost about half a cent and dropped in with screen blend. That covers most of what a "line/path shape" feature would have given, for these looks.

The t7 likeness fix was **the anchor crop, not the model tier**.

Import and fork worked: `composition import` copied t3/t6/t7 into the `b` variants, and `layer edit t7b/bg --fork --from-generation … --output 1` left t7 untouched.

## Where the problems came from

| Cause | Items |
|---|---|
| **Skills/docs: no decomposition model** | Nothing in README, `ply-operating`, `visual-authoring` or `brand/` says "each element is its own Layer; generate, source or draw it separately and place it freely". This caused the M5 badge, missing wires and the MUST TRY box. |
| **Skills/docs: no sourcing order** | No local → source → generate rule, and no rule that real products and marks must be real. This caused the substituted logos and the fictional phone. |
| **Caller rules: too rigid for pose** | `workflow.md` "real photo first, generation is fallback" + `youtube/AGENTS.md` "only approved cutouts" steered t6 to a headshot. |
| **No likeness iteration guidance** | No retry ladder (tighter crop → prompt → tier/model) or budget. g7 was shipped aged. |
| **Stale docs** | `brand/README.md`: "Ply does not import SVG", "renders only at canvas size", edit-then-anchor flow. The installed skills lag Workspace source (`apkit update` pending). |
| **Brand policy** | Groundline is enforced for thumbnails via `youtube/AGENTS.md`, the `brand/README.md` Ply procedure + `build.py --validate`, ADR-0002, `creator-contracts.md` and the `video-package-experiments` skill. It forbids glow/soft shadow on the creator edge, etc. |
| **My choices** | White logos, not flagging substitutions, not retrying g7. |
| **Real Ply gaps** | Perspective/skew, outline-only shape, text runs, italic, groups, blur, matte edge choke, one-sided glow, text fit/wrap in a box. Plus the bugs and friction above. |

## New friction (round 2)
- The `--output` index follows the Job record order. Glob/sheet order differs, and no command shows index ↔ image side by side.
- No helper for placing an element between two points (a wire from tile to laptop). I computed the midpoint, length and angle outside Ply.
- The `sheet` / `composition add` name rule rejects file-like names (`slack.svg`). Fine, but `sheet` then labels with the full filename anyway.

## Library candidates (sourced this run, with provenance)
- `src/sourced/{github,notion,slack,gdrive,postgres}.svg`: Simple Icons (GitHub) and Wikimedia Commons (others).
- `src/sourced/m5-hero.jpg`: apple.com/newsroom, 2026-08 M6/M5 Ultra release.
- `src/sourced/iphone-colors.jpg`, `iphone-2up.jpg`: apple.com/newsroom, 2026-09 iPhone 18 Pro release.

---

# Round 3: t6 redo (`final/t6c.png`, `final/t6-rounds.png`)

Added cost **$0.11** (2 Jobs, 3 images). Total for all rounds: **~$0.38**.

**What got it closer**
- **The reference thumbnail as a pose/framing Reference** (Reference 3, "only pose, framing and camera angle, never its person's face"), with the face anchor crop (Reference 1) and Apple's lineup photo (Reference 2). This gave the large foreground phone, the tilt, and the person on the right behind the table on the first try.
- **Occlusion from one Job used twice** (with no mask feature): the matted person above the maze, then the *unmatted* generation cropped to the table band (`--visible-region`) on top. The table, the arms over it, and the phone over the table come straight from the photo.
- **Contact shadow**: soft radial circles between the table band and a third copy of the cutout, cropped to the table band, so the hand sits on top of its shadow.
- **Title**: SF Pro via `--font-file`, a 3-stop gradient, a light outline + blue outer glow, and a second text Layer with a white→transparent gradient as gloss.

**New findings**
- **BUG: text wraps based on x position.** The layout width is `canvas width − x`. The same 150 px title is 954 px wide at `x=0` but wraps onto 2 lines at `x=400`/`640`. `--anchor center` on a wide title therefore wraps it. Workaround: a left anchor with hand-computed x.
- **BUG/inconsistency: anchor semantics differ between `add` and `edit`.** The same `--anchor left,top --x 100 --y 100` aligns glyph ink on `composition add`, but aligns painted extents *including the shadow* on `layer edit` (64 px apart in the probe). Re-anchoring a Layer that has effects moves it.
- **Anchor on gradient-to-transparent content** uses only the opaque part as ink, so the gloss Layer aligned to its top half. Fix: place by box origin with `--x/--y`.
- **Anchor vs content origin for Layers from the same source.** Registering two copies of one image needs the content origin (plain `--x/--y`). `--anchor` shifted the cutout copy by its transparent padding (~45 px). Not a bug, but it isn't taught, and it caused the "body cut on top of the table" look in round 2.
- **GAP: no Layer mask** (non-rectangular clip, erase, or clip-to-Layer). Splitting one subject across two depths (body behind the table, arms in front) only worked because the generation already contained the table.
- **GAP: no elliptical gradient / non-uniform scale.** A radial fill is a circle to the farthest side (as documented), so a flat ellipse shadow gets hard edges. Worked around with overlapping circles.
- **GAP: one shadow per Layer, no inner shadow/bevel/extrude.** The glossy 3D title took two stacked text Layers.
- **Friction:** a Composition's canvas has no "cover" fit for a background (`--resize-to` + anchor + manual overscan to hide the maze's own table).
- **Licensing note:** SF Pro's licence limits use outside Apple platforms. It's fine for this test, but the skills should say to check a caller font's licence (the skill already says licensing is the caller's concern).
