#!/usr/bin/env bash
# Rebuild the "Claude Skills" (t2) reference thumbnail from the first-run
# workspace (spec #226 US-007, ticket #234) — the ISC-41 and ISC-45 probes.
#
# Qualification contract:
#   - only ply is invoked — no other image tool, no wrapper that parses output;
#   - exactly ONE ply command per Layer: every Layer is created in its final
#     state by a single 'composition add' (content, transforms, visible
#     region, anchored placement, effects, and stack position together);
#   - no Layer id is captured, stored, or looked up — nothing reads ply's
#     output, and the one later reference to a Layer is a name address;
#   - the pixel wordmark is an editable text Layer from a caller-supplied
#     OFL pixel font (fonts/PressStart2P-Regular.ttf, licence beside it).
#
# The first-run workspace is READ-ONLY input: this script never writes into
# it. The rebuild Project, render, and measure output are written to OUT.
#
# Usage: rebuild-claude-skills.sh [workspace] [outdir]
#   workspace  first-run workspace root
#              (default: ~/Pictures/youtube/ply-outlier-recreations)
#   outdir     output root (default: a fresh temp directory); receives
#              project/, renders/t2.png, measure/t2.txt,
#              nine-pair-sheet.png
#
# Everything runs offline; ply is only ever invoked for local operations.

set -euo pipefail

WS="${1:-$HOME/Pictures/youtube/ply-outlier-recreations}"
OUT="${2:-"$(mktemp -d)/ply-qualification-226"}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
FONT="$HERE/fonts/PressStart2P-Regular.ttf"

if [ -n "${PLY_BIN:-}" ]; then
  PLY="$PLY_BIN"
elif command -v ply >/dev/null 2>&1; then
  PLY="ply"
else
  PLY="bun run $REPO/src/cli.ts"
fi

for f in "$WS/src/bg-grid.png" "$WS/src/k-teeth-smile-frontal-1511.png" "$FONT"; do
  [ -f "$f" ] || { echo "missing input: $f" >&2; exit 1; }
done

mkdir -p "$OUT/renders" "$OUT/measure"
P="$OUT/project"
rm -rf "$P"   # the script owns the rebuild Project; rebuild it from scratch
$PLY project init "$P" >/dev/null
$PLY composition create t2 --width 1280 --height 720 -p "$P" >/dev/null

# --- one ply command per Layer ------------------------------------------------
# Background: the first run's perspective grid, imported as-is (the gap
# recorded in docs/qualification/207 stands — ply ships no drawing language).
$PLY composition add t2 bg --image "$WS/src/bg-grid.png" -p "$P" >/dev/null

# Cutout: framed, sized, and placed in the one command that creates it.
$PLY composition add t2 kenny --image "$WS/src/k-teeth-smile-frontal-1511.png" \
  --visible-region "1,8,965,1233" --resize-to x1000 --x 510 --y -100 \
  -p "$P" >/dev/null

# Pixel wordmark: editable text from the caller-supplied OFL pixel font —
# the first run had to generate and matte this as an image. The hard
# (blur 0) shadow is the reference's dark drop edge. The anchor resolves the
# glyph ink before the effects apply, so the 4 px outline ring lands the
# painted left/top edge at (85, 62).
$PLY composition add t2 wm --text "CLAUDE" --font-file "$FONT" \
  --font-size 102 --color "#d97757" --outline "4,#d97757" \
  --anchor left,top --x 89 --y 66 --shadow "8,8,0,#5a2a1c" -p "$P" >/dev/null

# Headline words first, then each bar slipped BEHIND its word with
# --position — no reorder, and the bar is sized against a word that exists.
$PLY composition add t2 skills --text "Skills" --font Archivo --weight 700 \
  --font-size 120 --color "#ffffff" --x 105 --y 253 -p "$P" >/dev/null
$PLY composition add t2 barS --shape rectangle --size 344x130 \
  --fill "#d97757" --x 90 --y 250 --position before:skills -p "$P" >/dev/null
$PLY composition add t2 insane --text "Is Insane" --font Archivo --weight 700 \
  --font-size 120 --color "#000000" --x 92 --y 418 -p "$P" >/dev/null
$PLY composition add t2 barY --shape rectangle --size 542x130 \
  --fill "#fff200" --x 80 --y 420 --position before:insane -p "$P" >/dev/null

# --- render and measure -------------------------------------------------------
$PLY composition render t2 -p "$P" --out "$OUT/renders/t2.png" >/dev/null
$PLY composition measure t2 -p "$P" > "$OUT/measure/t2.txt"
# The ISC-45 probe: a Layer is addressed by Composition and use name.
$PLY layer inspect t2/wm -p "$P" > "$OUT/measure/wm-inspect.txt"

# --- the nine-pair reference-versus-result sheet -------------------------------
# Built inside ply (the first run used ImageMagick montage). Pair 2's result
# is this rebuild's render; the other eight are the first run's finals.
SHEET_ARGS=()
i=1
for n in 1 2 3 4 5 6 7 8 9; do
  result="$WS/final/t$n.png"
  [ "$n" = 2 ] && result="$OUT/renders/t2.png"
  SHEET_ARGS+=("$WS/final/ref$n.jpg" "$result" --label "$i=ref $n" --label "$((i + 1))=ply $n")
  i=$((i + 2))
done
$PLY composition sheet "${SHEET_ARGS[@]}" --pair \
  --out "$OUT/nine-pair-sheet.png" -p "$P" >/dev/null

echo "wrote $OUT/renders/t2.png and $OUT/nine-pair-sheet.png"
echo "measure: $OUT/measure/t2.txt (wordmark facts: $OUT/measure/wm-inspect.txt)"
