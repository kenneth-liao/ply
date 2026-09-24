#!/usr/bin/env bash
# Round 2: element decomposition + sourced assets + likeness retries.
cd "$(dirname "$0")"
P=project
FAIL=logs/fail-r2.log; : > $FAIL
A(){ out=$(ply composition add "$@" -p $P 2>&1) || echo "ADD $1/$2: $out" | tee -a $FAIL; }
E(){ out=$(ply layer edit "$@" -p $P 2>&1) || echo "EDIT $1: $out" | tee -a $FAIL; }
C(){ out=$(ply composition "$@" -p $P 2>&1) || echo "COMP $*: $out" | tee -a $FAIL; }
mk(){ ply composition create $1 --width 1280 --height 720 -p $P >/dev/null 2>&1 || true; }
S=src/sourced

# ---------- t1b: colour marks, light wires, neon MUST TRY ----------
mk t1b
A t1b bg --from-generation g1-desk --resize-to 1280x --anchor center,center --x 640 --y 420
for s in "ft:1280x10:0:0" "fb:1280x10:0:710" "fl:10x720:0:0" "fr:10x720:1270:0"; do IFS=: read n sz x y <<<"$s"
  A t1b $n --shape rectangle --size $sz --fill "#39ff5a" --shadow "0,0,14,#39ff5acc" --x $x --y $y; done
A t1b n5 --text "5" --font Anton --font-size 118 --color "#ffffff" --anchor left,top --x 150 --y 22 --shadow "0,6,12,#000000cc"
A t1b herdr --text "HERDR" --font Anton --font-size 118 --color "linear:180deg,#b6ff4a,#22d36b" --anchor left,top --x 240 --y 22 --shadow "0,6,12,#000000cc"
A t1b plugins --text "PLUGINS" --font Anton --font-size 118 --color "#ffffff" --anchor left,top --x 555 --y 22 --shadow "0,6,12,#000000cc"
# light wires: ONE generated element, reused per tile (crop, scale, rotate), screen-blended
i=0
for spec in "github:130:190:365:300" "notion:120:360:365:360" "slack:170:530:365:420" "gdrive:1130:330:895:330" "postgres:1100:520:895:420"; do
  IFS=: read -r name x y tx ty <<<"$spec"; i=$((i+1))
  read -r mx my sc rot <<<"$(python3 -c "import math;dx=$tx-$x;dy=$ty-$y;L=math.hypot(dx,dy);print(($x+$tx)/2,($y+$ty)/2,round(L/1536,4),round(math.degrees(math.atan2(dy,dx)),2))")"
  A t1b wire$i --from-generation w1-wire --visible-region "0,296,1536,323" --scale $sc --rotate $rot --blend screen --anchor center,center --x $mx --y $my
done
i=0
for spec in "github:130:190" "notion:120:360" "slack:170:530" "gdrive:1130:330" "postgres:1100:520"; do
  IFS=: read -r name x y <<<"$spec"; i=$((i+1))
  A t1b tile$i --shape rectangle --size 116x116 --corner-radius 22 --fill "#140d08" --outline "2,#ffb04d" --shadow "0,0,28,#ff7a00" --glow "6,8,#ff8a1f99" --anchor center,center --x $x --y $y
  A t1b logo$i --image $S/$name.svg --resize-to x54 --anchor center,center --x $x --y $((y-10))
  A t1b cap$i --text "$name" --font Archivo --weight 600 --font-size 15 --color "#ffffff" --anchor center,center --x $x --y $((y+38))
done
A t1b tagframe --from-generation f1-frame --visible-region "214,125,1200,684" --scale 0.21 --rotate -10 --blend screen --anchor center,center --x 960 --y 190
A t1b tag --text "MUST TRY" --font Anton --font-size 44 --color "#ffc36b" --shadow "0,0,14,#ff7a00" --rotate -10 --anchor center,center --x 956 --y 196

# ---------- t3b: real M5 Ultra chip (sourced) ----------
mk t3b
C import t3b t3
for n in badge m5 ultra; do C remove t3b $n; done
A t3b chip --image $S/m5-hero.jpg --visible-region "1045,222,658,658" --visible-region-radius 6 --scale 0.21 --shadow "0,0,26,#b36bffaa" --anchor left,top --x 28 --y 28

# ---------- t6b: generated pose with the real phone as Reference ----------
mk t6b
C import t6b t6
for n in kenny phone; do C remove t6b $n; done
A t6b kenny --from-matte m-g6-kenny --scale 0.74 --anchor center,bottom --x 660 --y 690 --position after:desk

# ---------- t7b: likeness retry (tight anchor crop) ----------
mk t7b
C import t7b t7
E t7b/bg --fork --from-generation g7-kenny-v2 --output 1

for c in t1b t3b t6b t7b; do
  ply composition render $c -p $P --out final/$c.png >/dev/null 2>logs/render-$c.err && echo "render $c ok" || echo "render $c FAIL: $(cat logs/render-$c.err)"
done
echo "failures: $(wc -l < $FAIL)"
