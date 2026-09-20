# Qualification — spec #207 US-007, ticket #216

Rebuild of the "Claude Skills" (t1) and "Master Opencode" (t7) reference
thumbnails from the first-run workspace
(`~/Pictures/youtube/ply-outlier-recreations`, READ-ONLY input), using ONLY
ply for bars, backgrounds, the card, the logo, and cutout framing — no
ImageMagick, no `rsvg-convert`, no other image tool.

- `rebuild-thumbnails.sh` — the committed rebuild script. Usage:
  `rebuild-thumbnails.sh [workspace] [outdir]`. Builds a fresh Project in
  the output directory, renders both Compositions, and writes `measure`
  output. Runs offline; the only image operations are ply's.
- `renders/t1.png`, `renders/t7.png` — the committed rebuild renders
  (byte-identical to what the script produces).
- `measure/t1.txt`, `measure/t7.txt` — `ply composition measure` output for
  both Compositions, matching the first run's retained Project
  layer-for-layer (same painted extents, within the documented ≤1 px
  tolerances; the t1 cutout's painted box is 11 px shorter at the top by
  design — its thin transparent margin is now framed away by the visible
  region, with identical ink).

## What replaced what

| First run (outside ply)                        | This rebuild (inside ply)                                    |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `bg-teal.png` — ImageMagick radial gradient    | shape Layer, `--fill "radial:#2a6e69,#123b3a"`               |
| `bg-grey.png` — ImageMagick radial gradient    | shape Layer, `--fill "radial:#f4f4f4,#cfcfcf"`               |
| `r-cream.png` / `r-yellow.png` — ImageMagick bars | shape Layers, `--fill "#ffe27a"` / `"#fff200"`             |
| `card-dark.png` — baked rounded rectangle      | shape Layer, `--corner-radius 48 --fill "#1d1d1f"`           |
| `opencode.png` — rasterized with `rsvg-convert` at a guessed size | the official SVG imported via `--image`, painted with `--vector-color "#1f1f1f"` |
| cutout margins trimmed outside ply (here: none were) | `--visible-region "0,23,1934,1321"` frames the t1 cutout's transparent margin |

The reused image files (the pixel-art watermark, the approved cutouts) are
imported as ordinary Layers, unmodified, exactly as in the first run. No
matting or generation was run.

## Parity

Per-pixel mean absolute difference against the first run's final renders
(`final/t1.png`, `final/t7.png`): **0.15 / 255** for both thumbnails
(99.98% of pixels within noise; the remainder is text antialiasing ramp).