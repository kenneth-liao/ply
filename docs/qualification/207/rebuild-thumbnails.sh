#!/usr/bin/env bash
# Rebuild the "Claude Skills" (t1) and "Master Opencode" (t7) reference
# thumbnails from the first-run workspace (spec #207 US-007, ticket #216).
#
# Qualification contract: every bar, background, the card, and the logo is
# built INSIDE ply — shape Layers for the bars/backgrounds/card (no baked
# ImageMagick r-*.png / bg-*.png / card-dark.png), an imported SVG with
# --vector-color for the opencode mark (no rsvg-convert), and the visible
# region for cutout framing. No image tool other than ply is invoked. The
# reused image files (the pixel-art watermark, the approved cutouts) are
# imported as ordinary Layers, unmodified, exactly as in the first run.
#
# The first-run workspace is READ-ONLY input: this script never writes into
# it. The rebuild Project, renders, and measure output are written to OUT
# (default: a fresh temp directory).
#
# Usage: rebuild-thumbnails.sh [workspace] [outdir]
#   workspace  first-run workspace root
#              (default: ~/Pictures/youtube/ply-outlier-recreations)
#   outdir     output root (default: a fresh temp directory); receives
#              project/, renders/t1.png, renders/t7.png, measure/*.txt
#
# Everything runs offline; ply is only ever invoked for local operations.

set -euo pipefail

WS="${1:-$HOME/Pictures/youtube/ply-outlier-recreations}"
OUT="${2:-"$(mktemp -d)/ply-qualification-207"}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"

if [ -n "${PLY_BIN:-}" ]; then
  PLY="$PLY_BIN"
elif command -v ply >/dev/null 2>&1; then
  PLY="ply"
else
  PLY="bun run $REPO/src/cli.ts"
fi

for f in src/wm-cc.png src/k-skeptical-shrug-1580.png \
         src/k-teeth-smile-point-side-1559.png; do
  [ -f "$WS/$f" ] || { echo "missing workspace input: $WS/$f" >&2; exit 1; }
done
LOGO="${PLY_QUAL_LOGO:-$HOME/projects/business/theailaunchpad/ai-launchpad-content/assets/logos/opencode/opencode.svg}"
[ -f "$LOGO" ] || LOGO="$REPO/assets/logos/opencode/opencode.svg"
[ -f "$LOGO" ] || { echo "missing opencode SVG logo (set PLY_QUAL_LOGO): $LOGO" >&2; exit 1; }

mkdir -p "$OUT/ids" "$OUT/renders" "$OUT/measure"
P="$OUT/project"
rm -rf "$P"   # the script owns the rebuild Project; rebuild it from scratch
$PLY project init "$P" >/dev/null

add() { # add <comp> <use> <add-args...> — records the Layer id like lib.sh
  local c="$1" n="$2"; shift 2
  local r
  r=$($PLY composition add "$c" "$n" "$@" -p "$P" --json) \
    || { echo "ADD FAIL $c/$n: $r" >&2; return 1; }
  printf '%s' "$r" | grep -m1 '"layerId"' | sed 's/.*"layerId": *"\([^"]*\)".*/\1/' | tr -d ',' > "$OUT/ids/$c.$n"
}
ed() { # ed <comp> <use> <edit-args...>
  local c="$1" n="$2"; shift 2
  $PLY layer edit "$(cat "$OUT/ids/$c.$n")" "$@" -p "$P" --json >/dev/null \
    || { echo "EDIT FAIL $c/$n $*" >&2; return 1; }
}
t() { # t <comp> <use> <text> <text-args...>
  local c="$1" n="$2" s="$3"; shift 3
  add "$c" "$n" --text "$s" "$@"
}

# --- t1 — "Claude Skills" ----------------------------------------------------
# Background: was bg-teal.png (ImageMagick radial gradient); now a shape
# Layer whose fill IS the gradient — centre #2a6e69 out to #123b3a at the
# farthest side. Bar: was r-cream.png; now a shape Layer filled #ffe27a.
# Card: was card-dark.png (baked rounded rectangle); now a shape Layer with
# --corner-radius. The pixel-art watermark and the approved cutout are the
# first run's own files, reused unmodified.
$PLY composition create t1 --width 1280 --height 720 -p "$P" >/dev/null
add t1 bg  --shape rectangle --size 1280x720 --fill "radial:#2a6e69,#123b3a"
add t1 bar --shape rectangle --size 830x110 --fill "#ffe27a"
ed t1 bar --x 140 --y 20
t t1 learn "Skills That LEARN!" --font Archivo --weight 600 --font-size 84 \
  --color '#111111'
ed t1 learn --anchor center,center --x 555 --y 75
add t1 card --shape rectangle --size 820x477 --corner-radius 48 \
  --fill "#1d1d1f"
ed t1 card --rotate -9
ed t1 card --x -93 --y 228
add t1 wm --image "$WS/src/wm-cc.png"
ed t1 wm --resize-to 620x
ed t1 wm --rotate -9
ed t1 wm --x 33.5 --y 330
add t1 kenny --image "$WS/src/k-skeptical-shrug-1580.png"
# Cutout framing in ply: the approved cutout carries a thin transparent
# margin (1 px left/right, 23 px top); the visible region frames it to the
# subject's own box without touching the file. Placement is defined against
# the full content box, so the remaining pixels stay put.
ed t1 kenny --visible-region "0,23,1934,1321"
ed t1 kenny --resize-to x640
ed t1 kenny --x 539 --y 120
$PLY composition render t1 -p "$P" --out "$OUT/renders/t1.png" >/dev/null
$PLY composition measure t1 -p "$P" > "$OUT/measure/t1.txt"

# --- t7 — "Master Opencode" --------------------------------------------------
# Background: was bg-grey.png (baked radial gradient); now a shape Layer —
# centre #f4f4f4 out to #cfcfcf. Bar: was r-yellow.png; now a shape Layer
# filled #fff200. Logo: was src/opencode.png (rasterized with rsvg-convert
# at a guessed size); now the official SVG imported directly and painted
# with --vector-color — retained bytes, crisp at any size, no rasterizing
# step. The approved cutout is reused unmodified.
$PLY composition create t7 --width 1280 --height 720 -p "$P" >/dev/null
add t7 bg --shape rectangle --size 1280x720 --fill "radial:#f4f4f4,#cfcfcf"
add t7 glyph --image "$LOGO" --vector-color "#1f1f1f"
ed t7 glyph --resize-to 36x
# The SVG's ink starts 2/24 into its box; nudge left so the painted ink
# lands where the first run's rasterized glyph did (x=130).
ed t7 glyph --x 127 --y 162
t t7 oc "opencode" --font "IBM Plex Mono" --font-size 30 --color '#333333'
ed t7 oc --anchor left,center --x 170 --y 180
t t7 mins "28 minutes" --font Archivo --weight 700 --font-size 36 \
  --color '#111111'
ed t7 mins --anchor left,center --x 340 --y 180
t t7 master "MASTER" --font Archivo --weight 800 --font-size 84 \
  --tracking -0.02 --color '#000000'
ed t7 master --anchor left,top --x 130 --y 270
add t7 bar --shape rectangle --size 500x90 --fill "#fff200"
ed t7 bar --x 125 --y 368
t t7 open "OPENCODE" --font Archivo --weight 800 --font-size 84 \
  --tracking -0.02 --color '#000000'
ed t7 open --anchor left,center --x 130 --y 413
add t7 kenny --image "$WS/src/k-teeth-smile-point-side-1559.png"
ed t7 kenny --resize-to x780
ed t7 kenny --anchor right,bottom --x 1270 --y 730
$PLY composition render t7 -p "$P" --out "$OUT/renders/t7.png" >/dev/null
$PLY composition measure t7 -p "$P" > "$OUT/measure/t7.txt"

echo "wrote $OUT/renders/t1.png, $OUT/renders/t7.png"
echo "measure: $OUT/measure/t1.txt, $OUT/measure/t7.txt"