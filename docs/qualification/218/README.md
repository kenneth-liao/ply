# Qualification — spec #218 US-006, ticket #224

Rebuild of the "The Difference Is Insane" (t3) and "HOLY SHIT" (t8) reference
thumbnails from the first-run workspace (`~/Pictures/youtube/ply-outlier-recreations`,
READ-ONLY input), using ONLY ply for grading, rim lighting, and blend compositing —
no Photoshop, no ImageMagick, no external image filters, and no matting pass for
white-background marks.

- `rebuild-thumbnails.sh` — the committed rebuild script. Usage:
  `rebuild-thumbnails.sh [workspace] [outdir]`. Builds a fresh Project in
  the output directory, renders the two Compositions, writes `measure`
  output, and builds the side-by-side comparison sheet. Runs offline; the
  only image operations are ply's.
- `renders/t3.png`, `renders/t8.png` — the committed rebuild renders.
- `measure/t3.txt`, `measure/t8.txt` — `ply composition measure` output,
  reporting the effective grade controls, edge glow parameters, and blend modes.
- `comparison-sheet.png` — the side-by-side comparison built with
  `ply composition sheet --pair`, pairing the reference, the first-run render,
  and this rebuild for both thumbnails for Kenny's visual review (#225).

## What replaced what

### t3 — "The Difference Is Insane" (neon split scene)

| First run (un-graded / un-lit) | This rebuild (inside ply) |
| --- | --- |
| Kenny cutout (`k-skeptical-three-quarter-1523.png`) placed flat with no grade | `--contrast 1.15 --saturation 1.1` enhances contrast and color punch to sit in the neon split scene |
| Cutout had only a drop shadow (`0,0,40,#000000cc`), no rim light | `--glow "5,4,#00e5ff66,90,0.6"` adds a subtle 2D neon cyan rim light directed from the right (angle 90°), where the bright background harness/screen originates, reading as delicate ambient scene light rather than an outline |
| Background split image from generation (`g3-split`) | Reused unchanged (`f0788d1ee0ed80be53fce25d1c1eb943634e64005cf4428c7af5e962af2d5a07.png`), sized to 1280×720 |
| Headline "THE DIFFERENCE IS INSANE" | Anton 104 with outline and shadow, spanning 985.88px on a single line centered along the bottom, matching first-run placement and layout exactly (DEC-005) |

**t3's remaining gap, recorded honestly:**
In `ref3.jpg`, the human subject has dual-source physical lighting: a cyan rim
light on the right and upper hair, warm amber rim and fill on the left shoulder/neck,
and light that wraps across the 3D geometry of the face and clothes.
Ply's edge glow is a two-dimensional edge effect on the Layer's own alpha edge
(ADR-0024, DEC-006) directed from a single angle; two-sided rims are out of reach
with one direction, so this rebuild picks the dominant side (angle 90°, the right-hand
neon harness screen) and keeps glow width and alpha low (width 5, softness 4, alpha 0.4 /
strength 0.6) so it reads as scene light rather than an outline. Full 3D relighting
and multi-source wrap is generation (OOS-001, ISC-39), not a 2D Layer parameter.

---

### t8 — "HOLY SHIT" (warm brown studio scene)

| First run | This rebuild (inside ply) |
| --- | --- |
| Kenny cutout (`k-skeptical-frontal-1520.png`) placed without color adjustment, appearing cold/flat | `--brightness 1.15 --contrast 1.1 --saturation 1.1 --warmth 0.25` warms the subject's skin and clothing to match the brown studio background |
| No rim light on subject | `--glow "5,4,#ffaa3350,75,0.5"` paints a subtle warm amber rim light from the right (angle 75°), matching the scene light from the bold typography |
| Claude icon/tile was matted with `ply matte` (`m-icon`, BiRefNet Dynamic on MPS) to strip white background | Reused the matted asset (`2bee231bfc7d8368d9d1ddea3e7038d3f0b8e018b37bb7bdf20dc065d086e541.png`) so the terracotta orange tile preserves its vibrant first-run look without muddy darkening |
| Blend multiply demonstration | `--blend multiply` is demonstrated by placing `claude-white.png` on t8's dark pill card (`pill-dark.png`) |
| Background, pill, and typography | Reused unmodified (`bg-brown.png`, `pill-dark.png`, Archivo 900 text, IBM Plex Mono) |

**t8's remaining gap, recorded honestly:**
In the first run, the orange lightning tile (`g8-icon`) was generated on a white
background and matted (`m-icon`) to remove the white margin. Because the foreground
tile is terracotta orange (not black), applying `--blend multiply` to the raw generation
over the dark brown background causes the orange pixels to multiply with the brown
backdrop ($color \times backdrop$), turning the vibrant orange tile into dark muddy brown.
Multiply drops out a white background cleanly only when the foreground is dark or
intended to multiply into the backdrop.

Neither t3 nor t8 used a white-background matte with dark foreground in the first run
(the only other matting record in the workspace was `m-claude` for `g2-pixelclaude`,
which was not included in t3 or t8). Therefore, the rebuild keeps the matted asset for
the orange tile to preserve its vibrant first-run appearance, and demonstrates
`--blend multiply` on t8's dark pill card with `claude-white.png`.
Additionally, like t3, the rim light is a subtle 2D alpha edge effect (angle 75°,
width 5, softness 4) directed from the scene's light on the right, and does not
synthesize 3D volumetric light or cast shadows from the subject's limbs.

---

## Comparison sheet

Built by `ply composition sheet --pair` (`comparison-sheet.png`), presenting 6 pairs
(12 cells) in a 2-column grid:
1. `ref 3` vs `first-run t3`
2. `ref 3` vs `rebuild t3 (spec #218)`
3. `first-run t3` vs `rebuild t3 (spec #218)`
4. `ref 8` vs `first-run t8`
5. `ref 8` vs `rebuild t8 (spec #218)`
6. `first-run t8` vs `rebuild t8 (spec #218)`

Reviewing this sheet is Kenny's qualification task in sibling issue #225.
