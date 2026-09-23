#!/usr/bin/env bash
# Rebuild the "The Difference Is Insane" (t3) and "HOLY SHIT" (t8) reference
# thumbnails from the first-run workspace (spec #218 US-006, ticket #224).
#
# Qualification contract:
#   - only ply is invoked — no other image tool, no image manipulation library;
#   - the SAME approved cutouts inside ply are graded and rim-lit:
#     - t3: subtle neon edge glow with light direction from the right (angle 90) + tonal grading;
#     - t8: warm studio grading (--brightness, --contrast, --saturation, --warmth) +
#       subtle warm amber edge glow directed from the scene's light on the right (angle 75);
#   - t8 tile preserves vibrant first-run matted orange appearance;
#   - --blend multiply demonstrated on t8's pill card;
#   - side-by-side comparison sheet built via 'ply composition sheet --pair'.
#
# The first-run workspace is READ-ONLY input: this script never writes into it.
# The rebuild Project, renders, measure output, and comparison sheet are written to OUT.
#
# Usage: rebuild-thumbnails.sh [workspace] [outdir]
#   workspace  first-run workspace root
#              (default: ~/Pictures/youtube/ply-outlier-recreations)
#   outdir     output root (default: a fresh temp directory); receives
#              project/, renders/t3.png, renders/t8.png, measure/t3.txt, measure/t8.txt,
#              comparison-sheet.png
#
# Everything runs offline; ply is only ever invoked for local operations.

set -euo pipefail

WS="${1:-$HOME/Pictures/youtube/ply-outlier-recreations}"
OUT="${2:-"$(mktemp -d)/ply-qualification-218"}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

if [ -n "${PLY_BIN:-}" ]; then
  PLY="$PLY_BIN"
elif command -v ply >/dev/null 2>&1; then
  PLY="ply"
else
  PLY="bun run $REPO/src/cli.ts"
fi

# Locate t3 background image
BG3="$WS/out/generation/g3-split/outputs/f0788d1ee0ed80be53fce25d1c1eb943634e64005cf4428c7af5e962af2d5a07.png"
[ -f "$BG3" ] || BG3="$WS/project/content/f0/78/f0788d1ee0ed80be53fce25d1c1eb943634e64005cf4428c7af5e962af2d5a07.png"

# Locate t8 icon image (matted output from first run preserves the vibrant terracotta tile)
TILE_IMG="$WS/out/matting/m-icon/outputs/2bee231bfc7d8368d9d1ddea3e7038d3f0b8e018b37bb7bdf20dc065d086e541.png"
[ -f "$TILE_IMG" ] || TILE_IMG="$WS/project/content/2b/ee/2bee231bfc7d8368d9d1ddea3e7038d3f0b8e018b37bb7bdf20dc065d086e541.png"

for f in "$BG3" "$TILE_IMG" "$WS/src/bg-brown.png" "$WS/src/pill-dark.png" "$WS/src/claude-white.png" \
         "$WS/src/k-skeptical-three-quarter-1523.png" "$WS/src/k-skeptical-frontal-1520.png" \
         "$WS/final/ref3.jpg" "$WS/final/ref8.jpg" "$WS/final/t3.png" "$WS/final/t8.png"; do
  [ -f "$f" ] || { echo "missing workspace input: $f" >&2; exit 1; }
done

mkdir -p "$OUT/renders" "$OUT/measure"
P="$OUT/project"
rm -rf "$P"
$PLY project init "$P" >/dev/null

# --- t3 — "The Difference Is Insane" (neon split scene) ----------------------
# Approved cutout graded for contrast/saturation, rim-lit with subtle neon cyan
# edge glow pointing towards the neon side (angle 90).
$PLY composition create t3 --width 1280 --height 720 -p "$P" >/dev/null

$PLY composition add t3 bg --image "$BG3" --resize-to 1280x720 -p "$P" >/dev/null

$PLY composition add t3 kenny \
  --image "$WS/src/k-skeptical-three-quarter-1523.png" \
  --resize-to x900 --anchor center,bottom --x 640 --y 960 \
  --contrast 1.15 --saturation 1.1 \
  --glow "5,4,#00e5ff66,90,0.6" \
  --shadow "0,0,40,#000000cc" \
  -p "$P" >/dev/null

# Add text at (0, 0) so the Anton 104 headline spans 985px without wrapping,
# then anchor center,bottom at (640, 700), matching the first run exactly (DEC-005).
$PLY composition add t3 head \
  --text "THE DIFFERENCE IS INSANE" \
  --font Anton --font-size 104 --color "#ffffff" \
  -p "$P" >/dev/null

$PLY layer edit t3/head \
  --anchor center,bottom --x 640 --y 700 \
  -p "$P" >/dev/null

$PLY layer edit t3/head \
  --outline "5,#000000" --shadow "0,6,10,#000000" \
  -p "$P" >/dev/null

$PLY composition render t3 -p "$P" --out "$OUT/renders/t3.png" >/dev/null
$PLY composition measure t3 -p "$P" > "$OUT/measure/t3.txt"

# --- t8 — "HOLY SHIT" (warm brown studio scene) ------------------------------
# Approved cutout graded with warmth, brightness, contrast, and saturation,
# rim-lit with subtle warm amber edge glow matching the scene light from the right (angle 75).
# The tile uses the matted asset to preserve the vibrant orange color (multiply on
# un-matted terracotta over dark brown turns into dark mud).
# Blend multiply is demonstrated by placing claude-white.png on t8's pill card.
$PLY composition create t8 --width 1280 --height 720 -p "$P" >/dev/null

$PLY composition add t8 bg --image "$WS/src/bg-brown.png" --anchor left,top --x 0 --y 0 -p "$P" >/dev/null

$PLY composition add t8 kenny \
  --image "$WS/src/k-skeptical-frontal-1520.png" \
  --resize-to x980 --anchor left,bottom --x -60 --y 900 \
  --brightness 1.15 --contrast 1.1 --saturation 1.1 --warmth 0.25 \
  --glow "5,4,#ffaa3350,75,0.5" \
  -p "$P" >/dev/null

$PLY composition add t8 holy \
  --text "HOLY" \
  --font Archivo --weight 900 --width 110 --font-size 250 --color "#f4ede2" \
  --anchor right,top --x 1240 --y 40 \
  -p "$P" >/dev/null

$PLY composition add t8 hit \
  --text "HIT" \
  --font Archivo --weight 900 --width 110 --font-size 250 --color "#f4ede2" \
  --anchor right,top --x 1240 --y 275 \
  -p "$P" >/dev/null

$PLY composition add t8 tile \
  --image "$TILE_IMG" \
  --resize-to 230x \
  --anchor left,top --x 590 --y 270 \
  -p "$P" >/dev/null

$PLY composition add t8 pill \
  --image "$WS/src/pill-dark.png" \
  --resize-to 520x110 \
  --anchor center,top --x 900 --y 520 \
  -p "$P" >/dev/null

$PLY composition add t8 try \
  --text "TRY THESE" \
  --font "IBM Plex Mono" --font-size 64 --color "#d9774f" \
  --anchor center,center --x 900 --y 575 \
  -p "$P" >/dev/null

# Demonstrate --blend multiply on t8's pill card
$PLY composition add t8 star \
  --image "$WS/src/claude-white.png" \
  --resize-to 60x \
  --anchor left,center --x 705 --y 575 \
  --blend multiply \
  -p "$P" >/dev/null

$PLY composition render t8 -p "$P" --out "$OUT/renders/t8.png" >/dev/null
$PLY composition measure t8 -p "$P" > "$OUT/measure/t8.txt"

# --- side-by-side comparison sheet ------------------------------------------
# Built with 'ply composition sheet --pair' pairing reference, first-run render,
# and this rebuild for each of the two thumbnails (Kenny reviews in #225).
$PLY composition sheet \
  "$WS/final/ref3.jpg" "$WS/final/t3.png" \
  --label "1=ref 3" --label "2=first-run t3" \
  "$WS/final/ref3.jpg" "$OUT/renders/t3.png" \
  --label "3=ref 3" --label "4=rebuild t3 (spec #218)" \
  "$WS/final/t3.png" "$OUT/renders/t3.png" \
  --label "5=first-run t3" --label "6=rebuild t3 (spec #218)" \
  "$WS/final/ref8.jpg" "$WS/final/t8.png" \
  --label "7=ref 8" --label "8=first-run t8" \
  "$WS/final/ref8.jpg" "$OUT/renders/t8.png" \
  --label "9=ref 8" --label "10=rebuild t8 (spec #218)" \
  "$WS/final/t8.png" "$OUT/renders/t8.png" \
  --label "11=first-run t8" --label "12=rebuild t8 (spec #218)" \
  --pair \
  --out "$OUT/comparison-sheet.png" \
  -p "$P" >/dev/null

echo "wrote $OUT/renders/t3.png, $OUT/renders/t8.png, and $OUT/comparison-sheet.png"
echo "measure: $OUT/measure/t3.txt, $OUT/measure/t8.txt"
