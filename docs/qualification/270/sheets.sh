#!/usr/bin/env bash
# Build the #270 comparison sheets from the compare.sh Jobs. One row per
# case x tier: [anchor,] then two candidates each for g2 (gpt-image), flare,
# and sunburst. Uses the newest successful Job per case/model/tier.
# Run inside a Ply project (composition sheet needs one). PLY overrides the
# command, e.g. PLY="bun run /path/to/ply/src/cli.ts".
# Usage: sheets.sh <identity-dir> <generation-root> <out-dir>
set -euo pipefail
ID="$1"; GEN="$2"; OUT="$3"; mkdir -p "$OUT"
anchor() { case "$1" in l1) echo IMG_1536.jpg;; l2) echo IMG_1591.jpg;; l3) echo IMG_1509.jpg;; e1) echo IMG_1572.jpg;; esac; }
sheet() { # name cols cases...
  local name="$1" cols="$2"; shift 2
  local inputs=() labels=() n=0
  for c in "$@"; do for t in low high; do
    local a; a=$(anchor "$c")
    if [ -n "$a" ]; then
      inputs+=("$ID/$a"); n=$((n+1)); labels+=(--label "$n=$c anchor ${a%.jpg}")
    fi
    for m in g2 flare sunburst; do
      local job; job=$({ ls -dt "$GEN"/c270-*-"$c"-"$m"-"$t" 2>/dev/null || true; } | while read -r d; do [ -f "$d/job.json" ] && { echo "$d"; break; }; done)
      [ -n "$job" ] || { echo "missing Job for $c $m $t" >&2; exit 1; }
      local i=0
      for f in $(python3 -c "import json,sys;[print(o['file']) for o in json.load(open(sys.argv[1]))['run']['outputs']]" "$job/job.json"); do
        i=$((i+1)); inputs+=("$job/$f"); n=$((n+1)); labels+=(--label "$n=$c $m $t #$i")
      done
    done
  done; done
  ${PLY:-ply} composition sheet "${inputs[@]}" "${labels[@]}" --columns "$cols" --cell 384 --out "$OUT/$name.png"
}
sheet likeness 7 l1 l2 l3
sheet edit-preservation 7 e1
sheet general 6 p1 o1
