# Qualification — spec #207 US-007, ticket #216

Rebuild of the "Claude Skills" (t2) and "Master Opencode" (t7) reference
thumbnails — plus "Skills That LEARN" (t1, kept as an extra) — from the
first-run workspace (`~/Pictures/youtube/ply-outlier-recreations`, READ-ONLY
input), using ONLY ply for bars, backgrounds, the marks, and cutout framing —
no ImageMagick, no `rsvg-convert`, no other image tool.

- `rebuild-thumbnails.sh` — the committed rebuild script. Usage:
  `rebuild-thumbnails.sh [workspace] [outdir]`. Builds a fresh Project in
  the output directory, renders the three Compositions, and writes `measure`
  output. Runs offline; the only image operations are ply's.
- `renders/t2.png`, `renders/t7.png` (and the extra `renders/t1.png`) — the
  committed rebuild renders, byte-identical to what the script produces.
- `measure/t2.txt`, `measure/t7.txt` (and `measure/t1.txt`) — `ply
  composition measure` output, matching the first run's retained Project
  layer-for-layer (same painted extents, within the documented ≤1 px
  tolerances; where a cutout's transparent margin is framed away by the
  visible region, its painted box is shorter at that edge by exactly the
  margin, with identical ink).

## What replaced what

**t2 — "Claude Skills"**

| First run (outside ply) | This rebuild (inside ply) |
| --- | --- |
| `r-salmon.png` / `r-yellow.png` — ImageMagick bars | shape Layers, `--fill "#d97757"` / `"#fff200"` |
| cutout margins trimmed outside ply (in the first run: none) | `--visible-region "1,8,965,1233"` frames the smiling cutout in ply |
| the wordmark matte kept its huge transparent margins | `--visible-region "67,237,1253,295"` frames the pixel-CLAUDE wordmark's matte to its ink in ply |

**t2's remaining gap, recorded honestly:** the first run's
`bg-grid.png` background is a *perspective* grid — its lines sit at uneven,
radiating spacings (x = 80 and 1200 on one scanline, y = 40 and 680 on one
scanline column) with a brightness falloff — which ply's shape vocabulary
(rectangle/ellipse + gradient fills, no drawing language, spec #207
OOS-005/DEC-002) cannot draw. Uniform thin shape lines would paint a
*different* background, not a rebuild, so the baked grid PNG is imported
as-is and the gap stands: **t2's background is still an imported bitmap;
ply-only grid replacement waits for a drawing capability ply does not
ship.**

**t2's Claude mark:** the pixel-CLAUDE wordmark is the first run's own
generated asset (job `g2-pixelclaude`) matted to true alpha (matte
`m-claude`), reused unmodified — a raster, so `--vector-color` has no t2
element (it is defined for SVG Layers only); the salmon already lives in
the retained pixels. The SVG-logos + `--vector-color` route is exercised by
t7's opencode mark below, where it applies.

**t7 — "Master Opencode"**

| First run (outside ply) | This rebuild (inside ply) |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `bg-grey.png` — ImageMagick radial gradient    | shape Layer, `--fill "radial:#f4f4f4,#cfcfcf"`               |
| `r-yellow.png` — ImageMagick bar               | shape Layer, `--fill "#fff200"`                               |
| `opencode.png` — rasterized with `rsvg-convert` at a guessed size | the official SVG imported via `--image`, painted with `--vector-color "#1f1f1f"` |
| cutout margins (none were trimmed in the first run) | the t7 cutout is placed whole; its margin is 1 px |

**t1 (extra)** — `bg-teal.png` → shape Layer `--fill "radial:#2a6e69,#123b3a"`;
`r-cream.png` bar → shape Layer `--fill "#ffe27a"`; `card-dark.png` → shape
Layer `--corner-radius 48 --fill "#1d1d1f"`; the shrug cutout's 1–23 px
transparent margin framed by `--visible-region "0,23,1934,1321"`.

The reused image files (the baked grid, the pixel-art wordmarks, the
approved cutouts) are imported as ordinary Layers, unmodified, exactly as in
the first run. No matting or generation was run.

## Parity

Per-pixel mean absolute difference against the first run's final renders:
**t2 0.00/255 (pixel-identical), t7 0.15/255, t1 0.15/255** (99.98% of
pixels within noise; the remainder is text antialiasing ramp).
