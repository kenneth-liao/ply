#!/usr/bin/env bash
# Spec-surface rebuild of 8 outlier thumbnails. One `composition add` per Layer, name addressing only.
cd "$(dirname "$0")"
P=project
FAIL=logs/fail.log; : > $FAIL
A(){ out=$(ply composition add "$@" -p $P 2>&1) || echo "ADD $1/$2: $out" | tee -a $FAIL; }
E(){ out=$(ply layer edit "$@" -p $P 2>&1) || echo "EDIT $1: $out" | tee -a $FAIL; }
mk(){ ply composition create $1 --width 1280 --height 720 -p $P >/dev/null 2>&1 || true; }
G(){ echo $1; }   # generation job id → --from-generation
K=src/k-
L=src/logos

# ---------- t1: 5 HERDR PLUGINS ----------
mk t1
A t1 bg --from-generation g1-desk --resize-to 1280x --anchor center,center --x 640 --y 420
A t1 frame --shape rectangle --size 1264x704 --fill "#00000000" --outline "6,#39ff5a" --x 8 --y 8
A t1 n5 --text "5" --font Anton --font-size 118 --color "#ffffff" --anchor left,top --x 150 --y 22 --shadow "0,6,12,#000000cc"
A t1 herdr --text "HERDR" --font Anton --font-size 118 --color "linear:180deg,#b6ff4a,#22d36b" --anchor left,top --x 240 --y 22 --shadow "0,6,12,#000000cc"
A t1 plugins --text "PLUGINS" --font Anton --font-size 118 --color "#ffffff" --anchor left,top --x 555 --y 22 --shadow "0,6,12,#000000cc"
A t1 tagbg --shape rectangle --size 230x62 --corner-radius 10 --fill "#ffb21a" --outline "3,#1a1200" --rotate -14 --anchor center,center --x 960 --y 190
A t1 tag --text "MUST TRY" --font Anton --font-size 44 --color "#1a1200" --rotate -14 --anchor center,center --x 960 --y 190
i=0
for spec in "claude:130:190" "openai:120:350" "codex:170:520" "opencode:1120:330" "obsidian:1090:520"; do
  IFS=: read -r name x y <<<"$spec"; i=$((i+1))
  A t1 tile$i --shape rectangle --size 116x116 --corner-radius 22 --fill "#140d08" --outline "3,#ff8a1f" --shadow "0,0,22,#ff7a00cc" --anchor center,center --x $x --y $y
  A t1 logo$i --image $L/$name.svg --vector-color "#ffffff" --resize-to 56x --anchor center,center --x $x --y $((y-10))
  A t1 cap$i --text "$name" --font Archivo --weight 600 --font-size 15 --color "#ffffff" --anchor center,center --x $x --y $((y+38))
done

# ---------- t2: INSIDE JEV ----------
mk t2
A t2 bg --from-generation g2-studio --resize-to 1280x --anchor center,center --x 640 --y 360 --brightness 0.9
A t2 kenny --image ${K}thinking-chin-rest-1596.png --scale 0.62 --anchor center,bottom --x 390 --y 730 --saturation 1.1 --warmth -0.05 --glow "10,10,#ff2bd6aa,90,0.8"
A t2 inside --text "INSIDE" --font Archivo --weight 900 --width 100 --font-size 112 --color "#ffffff" --anchor center,top --x 960 --y 40 --shadow "0,6,16,#000000aa"
A t2 jevbar --shape rectangle --size 330x120 --fill "#ff2d2d" --rotate -3 --anchor center,center --x 960 --y 225
A t2 jev --text "JEV" --font Archivo --weight 900 --width 125 --font-size 124 --color "#ffffff" --rotate -3 --anchor center,center --x 960 --y 225
A t2 sub --text "with the founder" --font "IBM Plex Mono" --font-size 30 --tracking 0.18 --color "#ffffff" --anchor center,top --x 960 --y 310
A t2 mark --image $L/claude.svg --vector-color "#c77dff" --resize-to 70x --anchor right,top --x 1250 --y 30 --glow "6,6,#ffffff99"

# ---------- t3: M5 ULTRA ----------
mk t3
A t3 bg --from-generation g3-kenny --output 2 --resize-to 1280x --anchor center,center --x 640 --y 380
A t3 beams --from-generation g3-beams --resize-to 620x --blend screen --anchor center,bottom --x 1000 --y 470
i=0
for spec in "claude:840:110:-12" "openai:1000:60:6" "deepseek:1160:140:14"; do
  IFS=: read -r name x y r <<<"$spec"; i=$((i+1))
  A t3 tile$i --shape rectangle --size 96x96 --corner-radius 18 --fill "#0b0b18" --outline "3,#ffffff" --shadow "0,0,26,#7fd4ffcc" --rotate $r --anchor center,center --x $x --y $y
  A t3 icon$i --image $L/$name.svg --vector-color "#ffffff" --resize-to 52x --rotate $r --anchor center,center --x $x --y $y
done
A t3 badge --shape rectangle --size 170x120 --corner-radius 14 --fill "linear:180deg,#16202a,#070b10" --outline "2,#3fd0ff" --shadow "0,0,24,#3fd0ffaa" --x 30 --y 30
A t3 m5 --text "M5" --font Archivo --weight 800 --font-size 64 --color "#ffffff" --anchor center,top --x 115 --y 42
A t3 ultra --text "ULTRA" --font Archivo --weight 700 --font-size 26 --tracking 0.1 --color "#ffffff" --anchor center,top --x 115 --y 112

# ---------- t4: No code AI Agents ----------
mk t4
A t4 bg --shape rectangle --size 1280x720 --fill "radial:#2a2e36,#131519"
A t4 kenny --image ${K}teeth-smile-frontal-1511.png --scale 0.56 --anchor center,bottom --x 1050 --y 740 --warmth 0.08 --glow "8,10,#ff8a4dcc,270,0.6"
A t4 l1 --text "No code" --font Archivo --weight 800 --font-size 92 --color "#ffffff" --anchor left,top --x 70 --y 120
A t4 hl --shape rectangle --size 470x100 --fill "#ff4a3d" --rotate -2 --anchor left,top --x 60 --y 232
A t4 l2 --text "AI Agents" --font Archivo --weight 800 --font-size 92 --color "#ffffff" --rotate -2 --anchor left,top --x 75 --y 236
A t4 l3 --text "for beginners" --font Archivo --weight 800 --font-size 92 --color "#ffffff" --anchor left,top --x 70 --y 350
A t4 brand --text "Launchpad" --font Archivo --weight 600 --font-size 40 --color "#ffffff" --anchor left,center --x 130 --y 590
A t4 brand2 --text "Tutorials" --font Archivo --weight 600 --font-size 40 --color "#ff7a3d" --anchor left,center --x 322 --y 590
A t4 brandmark --image $L/claude.svg --vector-color "#ffffff" --resize-to 46x --anchor left,center --x 72 --y 590

# ---------- t5: AI Jobs Are Changing ----------
mk t5
A t5 bg --from-generation g5-office --resize-to 1280x --anchor center,center --x 640 --y 360
A t5 panel --shape rectangle --size 480x720 --fill "linear:90deg,#3a78d6,#1d4c9e" --x 0 --y 0
A t5 edge --shape rectangle --size 200x720 --fill "linear:90deg,#1d4c9e,#1d4c9e00" --x 480 --y 0
A t5 side --text "AI
for a
Better
World" --font Archivo --weight 700 --font-size 34 --line-height 0.95 --color "#9cc4ff88" --anchor left,top --x 20 --y 22
A t5 kenny --image ${K}neutral-three-quarter-1530.png --scale 0.58 --anchor center,bottom --x 250 --y 730 --contrast 1.05 --glow "8,10,#9fd0ffaa,90,0.6"
A t5 namebg --shape rectangle --size 390x74 --corner-radius 8 --fill "#0a1020dd" --x 20 --y 606
A t5 name --text "Kenny Liao" --font Archivo --weight 700 --font-size 30 --color "#ffffff" --anchor left,top --x 34 --y 614
A t5 role --text "Founder of The AI Launchpad" --font Archivo --weight 500 --font-size 18 --color "#d7e3ff" --anchor left,top --x 34 --y 652
A t5 ai --text "AI Jobs" --font Archivo --weight 900 --width 75 --font-size 150 --color "#ffffff" --anchor center,top --x 870 --y 150 --shadow "0,8,18,#00000099"
A t5 changing --text "Are Changing" --font Archivo --weight 900 --width 62 --font-size 112 --color "linear:180deg,#8ff3ff,#1aa7ff" --anchor center,top --x 880 --y 320 --shadow "0,8,18,#00000099"
A t5 chip --shape rectangle --size 70x56 --corner-radius 6 --fill "#0a1830cc" --outline "2,#5fc8ff" --x 1110 --y 70
A t5 chiptext --text "AI" --font Archivo --weight 700 --font-size 34 --color "#5fc8ff" --anchor center,center --x 1145 --y 98
A t5 bullets --text "NEW ROLES
NEW SKILLS
NEW OPPORTUNITIES" --font "IBM Plex Mono" --font-size 16 --tracking 0.15 --line-height 1.7 --color "#b9ccff" --anchor left,top --x 880 --y 490

# ---------- t6: iPhone 18 Pro ----------
mk t6
A t6 bg --from-generation g6-maze --resize-to 1280x --anchor center,bottom --x 640 --y 760
A t6 kenny --image ${K}neutral-three-quarter-1530.png --scale 0.5 --flip horizontal --anchor center,bottom --x 900 --y 760
A t6 desk --shape rectangle --size 1280x120 --fill "linear:180deg,#f4f6f8,#dfe3e8" --x 0 --y 600
A t6 title --text "iPhone 18 Pro" --font Archivo --weight 800 --width 90 --font-size 128 --tracking -0.03 --color "linear:180deg,#e8f4ff,#7fb0e0" --outline "2,#ffffff66" --shadow "0,8,20,#00000088" --anchor center,top --x 640 --y 24
A t6 phone --from-matte m-phone --resize-to x560 --rotate -10 --anchor center,center --x 330 --y 420 --contrast 1.05 --shadow "0,20,40,#00000088"

# ---------- t7: peptides ----------
mk t7
A t7 bg --from-generation g7-kenny --output 1 --resize-to 1280x --anchor center,center --x 640 --y 330
A t7 vignette --shape rectangle --size 1280x720 --fill "radial:#ffffff00:50,#5a0a0acc" --blend multiply
for spec in "v1:-26:90:170:0.34" "v2:18:130:540:0.40" "v3:30:1170:140:0.32" "v4:-34:1150:560:0.42"; do
  IFS=: read -r n r x y s <<<"$spec"
  A t7 $n --from-matte m-vial --scale $s --rotate $r --anchor center,center --x $x --y $y --brightness 0.85 --contrast 1.1 --shadow "0,14,30,#000000cc"
done

# ---------- t8: $10.72 vs $1.33 ----------
mk t8
A t8 bg --shape rectangle --size 1280x720 --fill "linear:90deg,#6d8fb6,#4d6f98"
A t8 tab --shape rectangle --size 230x70 --corner-radius 14 --fill "#e9c9a6" --x 400 --y 28
A t8 folder --shape rectangle --size 680x620 --corner-radius 18 --fill "#f3d8b9" --shadow "0,10,30,#00000044" --x 30 --y 60
A t8 bigbar --shape rectangle --size 130x400 --fill "#1f1f1f" --x 120 --y 200
A t8 smallbar --shape rectangle --size 130x24 --fill "#ff2bb8" --x 430 --y 576
A t8 axis --shape rectangle --size 520x3 --fill "#2a2a2a" --x 90 --y 600
A t8 p1 --text '$10.72' --font Archivo --weight 800 --font-size 64 --color "#111111" --anchor left,bottom --x 110 --y 180
A t8 p2 --text '$1.33' --font Archivo --weight 800 --font-size 56 --color "#111111" --anchor center,bottom --x 495 --y 556
A t8 lab1 --text "Claude" --font Archivo --weight 600 --font-size 32 --color "#111111" --anchor center,top --x 185 --y 625
A t8 u1 --shape rectangle --size 100x3 --fill "#111111" --anchor center,top --x 185 --y 666
A t8 lab2 --text "Claude +" --font Archivo --weight 600 --font-size 32 --color "#111111" --anchor right,top --x 520 --y 625
A t8 u2 --shape rectangle --size 125x3 --fill "#111111" --anchor right,top --x 520 --y 666
A t8 labmark --image $L/opencode.svg --vector-color "#111111" --resize-to x42 --anchor left,top --x 530 --y 620
A t8 kenny --image ${K}slight-smile-point-side-1583.png --scale 0.62 --flip horizontal --anchor right,bottom --x 1300 --y 740

for c in t1 t2 t3 t4 t5 t6 t7 t8; do
  ply composition render $c -p $P --out final/$c.png >/dev/null 2>logs/render-$c.err && echo "render $c ok" || { echo "render $c FAIL: $(cat logs/render-$c.err)"; }
done
echo "failures: $(wc -l < $FAIL)"
