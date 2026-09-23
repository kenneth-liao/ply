#!/usr/bin/env bash
# #270 capability probes: one real Gateway call per model and call shape,
# through the production `ply generate` path. Prints one JSON line per call
# (model, shape, exit, seconds, cost, warnings, error).
# Usage: probe.sh <identity-anchor.jpg> [model...]
set -uo pipefail
ANCHOR="$1"; shift
if [ $# -gt 0 ]; then MODELS=("$@"); else MODELS=(gpt-image-flare gpt-image-sunburst); fi
STAMP=$(date -u +%Y%m%d-%H%M%S)
PROMPT="A red barn in a green field at noon, clear sky."
REFPROMPT="A presenter portrait of the person in attached image 1, waist-up, smiling, plain light-grey studio background. Keep the face in attached image 1 exactly; do not widen, round, age, or blend it."
probe() { # model shape args...
  local model="$1" shape="$2"; shift 2
  local job="p270-${STAMP}-${model#gpt-image-}-${shape}" t0 t1 out code
  t0=$(python3 -c 'import time;print(time.time())')
  out=$(bun run ply generate "$@" --model "$model" --job "$job" --json 2>/dev/null); code=$?
  t1=$(python3 -c 'import time;print(time.time())')
  OUT="$out" python3 - "$model" "$shape" "$code" "$t0" "$t1" <<'PY'
import json, os, sys
model, shape, code, t0, t1 = sys.argv[1:]
try: j = json.loads(os.environ["OUT"])
except Exception: j = {"raw": os.environ["OUT"][:400]}
run = (j.get("job") or {}).get("run") or {}
print(json.dumps({"model": model, "shape": shape, "exit": int(code),
  "seconds": round(float(t1) - float(t0), 1), "job": (j.get("job") or {}).get("jobId"),
  "cost": run.get("cost"), "warnings": j.get("warnings") or run.get("warnings"),
  "error": j.get("error")}))
PY
}
for m in "${MODELS[@]}"; do
  probe "$m" text "$PROMPT" --size 1024x1024 &
  for q in low medium high; do probe "$m" "q-$q" "$PROMPT" --size 1024x1024 --quality "$q" & done
  probe "$m" ref "$REFPROMPT" --size 1024x1536 --ref "$ANCHOR" &
  probe "$m" isolated "A glossy 3D orange robot mascot head, front view." --size 1024x1024 --intent isolated &
done
wait
