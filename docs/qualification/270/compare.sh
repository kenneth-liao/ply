#!/usr/bin/env bash
# #270 comparison set: every prompt on gpt-image, gpt-image-flare, and
# gpt-image-sunburst with the same References, size, and tier (low and high),
# two candidates each. Prints one JSON line per Job.
# Usage: compare.sh <identity-dir> [lane-filter]
#   <identity-dir> = ai-launchpad-content/assets/creator-cutouts/identity
set -uo pipefail
ID="$1"; FILTER="${2:-}"
STAMP=$(date -u +%Y%m%d-%H%M%S)
KEEP="Keep the face in attached image 1 exactly; do not widen, round, age, average, or blend it with any other reference."
BG="Plain, uniform, evenly lit light-grey studio background with clear margins and a clean silhouette."

# name | size | intent | ref | prompt
CASES=(
"l1|1024x1536|full-canvas|IMG_1536.jpg|YouTube thumbnail creator shot of the person in attached image 1 (the identity anchor, also the expression reference): shocked reaction, wide eyes, open mouth, both hands raised beside the face, tight head-and-shoulders framing, slightly low camera angle. $KEEP $BG"
"l2|1024x1536|full-canvas|IMG_1591.jpg|YouTube thumbnail creator shot of the person in attached image 1 (the identity anchor, also the pose reference): thinking, index finger on chin, eyes looking up and to his left, three-quarter turn, waist-up framing. $KEEP $BG"
"l3|1024x1536|full-canvas|IMG_1509.jpg|YouTube thumbnail creator shot of the person in attached image 1 (the identity anchor): big excited grin, pointing to the right side of the frame with his right hand, leaning slightly toward the camera, waist-up framing. $KEEP $BG"
"e1|1024x1536|full-canvas|IMG_1572.jpg|Attached image 1 is the edit source. Change only the clothing and the background: dress him in a navy denim jacket over a plain white T-shirt, and replace the white wall with a dark studio lit by a teal rim light. Keep his face, hair, expression, arms-crossed pose, and framing exactly as in attached image 1; do not widen, round, age, or otherwise alter the face."
"p1|1536x1024|full-canvas|-|A moody tech-studio background plate for a YouTube thumbnail: a dark desk with two glowing monitors, teal and orange lighting, shallow depth of field. Leave the left third calm and empty for a headline. No people and no text."
"o1|1024x1024|isolated|-|A glossy 3D robot mascot head, friendly, orange and white, front view."
)
MODELS=(gpt-image gpt-image-flare gpt-image-sunburst)
TIERS=(low high)

job() { # model tier case
  local model="$1" tier="$2" name size intent ref prompt
  IFS='|' read -r name size intent ref prompt <<<"$3"
  local short="${model#gpt-image-}"; [ "$short" = "$model" ] && short=g2
  local id="c270-${STAMP}-${name}-${short}-${tier}"
  local args=("$prompt" --model "$model" --quality "$tier" --size "$size" --intent "$intent" --count 2 --job "$id" --json)
  [ "$ref" != "-" ] && args+=(--ref "$ID/$ref")
  local t0 t1 out code
  t0=$(python3 -c 'import time;print(time.time())')
  out=$(bun run ply generate "${args[@]}" 2>/dev/null); code=$?
  t1=$(python3 -c 'import time;print(time.time())')
  OUT="$out" python3 - "$model" "$tier" "$name" "$code" "$t0" "$t1" "$id" <<'PY'
import json, os, sys
model, tier, name, code, t0, t1, jid = sys.argv[1:]
try: j = json.loads(os.environ["OUT"])
except Exception: j = {"error": os.environ["OUT"][:400]}
run = (j.get("job") or {}).get("run") or {}
print(json.dumps({"case": name, "model": model, "tier": tier, "exit": int(code), "job": jid,
  "seconds_for_2": round(float(t1) - float(t0), 1), "cost": run.get("cost"), "error": j.get("error")}), flush=True)
PY
}
# One lane per model x tier; each lane runs its cases in order.
for m in "${MODELS[@]}"; do for t in "${TIERS[@]}"; do
  [ -n "$FILTER" ] && [[ "$m-$t" != *"$FILTER"* ]] && continue
  ( for c in "${CASES[@]}"; do job "$m" "$t" "$c"; done ) &
done; done
wait
