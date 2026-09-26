#!/usr/bin/env bash
# Rebuild the eight 2026-09-23 outlier thumbnails with Ply only (#315, spec #285).
#
# Every image operation is a `ply` command: recovering the references from the
# baseline sheets, anchor crops, generation, matting, every Layer, renders and
# sheets. Apart from `ply generate`, the only inputs are unmodified sourced
# files from the content repository. Besides `ply`, the shell runs only builtins
# (integer arithmetic, echo), mkdir, rm -rf of its own builds/ Projects, and
# `perl -e alarm` as a timeout wrapper around ply commands that open the render page.
#
#   CONTENT_ROOT  ai-launchpad-content checkout (identity photos, cutouts,
#                 assets/logos, assets/products, the ply-285 baseline sheets)
#   OUT           where renders and sheets go
#                 (default: $CONTENT_ROOT/assets/creator-cutouts/qualification/ply-285-rebuild)
#   WORKSPACE     working directory (default: $CONTENT_ROOT/assets/creator-cutouts/
#                 qualification/ply-285-rebuild/workspace). Its out/ holds the
#                 Generation Job and matte records the build replays from; they
#                 contain likeness outputs, so they live in the private content
#                 repository, which commits only out/ there. Everything else
#                 written here is transient: project/ (references, crops), refs/,
#                 anchors/, builds/ (one Project per thumbnail), logs/.
#
# Usage: rebuild.sh [refs|anchors|generate|matte|build|render|sheet|all]...
# `generate` needs AI_GATEWAY_API_KEY in the environment and skips any Job
# that is already published. Generation is not deterministic: the renders
# replay from the retained Job records (the selected outputs are pinned by
# short hash below); a fresh workspace generates new candidates that need a
# new review and new pins. Probe commands that open the render page run
# under a 180 s alarm so a hung page cannot stall the script.
set -u
: "${CONTENT_ROOT:?set CONTENT_ROOT}"
OUT=${OUT:-$CONTENT_ROOT/assets/creator-cutouts/qualification/ply-285-rebuild}
WORKSPACE=${WORKSPACE:-$CONTENT_ROOT/assets/creator-cutouts/qualification/ply-285-rebuild/workspace}
BASE=$CONTENT_ROOT/assets/creator-cutouts/qualification/ply-285-baseline
ID=$CONTENT_ROOT/assets/creator-cutouts/identity
CUT=$CONTENT_ROOT/assets/creator-cutouts/approved
LOGO=$CONTENT_ROOT/assets/logos
PROD=$CONTENT_ROOT/assets/products
MARK=$CONTENT_ROOT/brand/marks/mark.svg
cd "$WORKSPACE" || exit 1
mkdir -p refs anchors logs "$OUT/renders"
P=project
[ -f $P/ply.json ] || ply project init $P >/dev/null
LOG=logs/build.log
FAILS=0   # failed ply steps of any kind: refused adds, Jobs, mattes, renders, sheets

run(){ perl -e 'alarm 180; exec @ARGV' ply "$@"; }
# One Layer, one command. A refusal is logged and counted, never fatal. An
# anchored add on a perspective Layer is refused intermittently with "no
# visible painted ink" (about 1 in 12, found here); a refusal mutates nothing,
# so that one refusal is retried once and the retry is logged.
A(){ local out
  out=$(run composition add "$@" -p $P 2>&1) && { echo "add $1/$2 ok" >>$LOG; return; }
  if [[ $out == *"no visible painted ink"* ]]; then
    echo "RETRY $1/$2: $out" >>$LOG
    out=$(run composition add "$@" -p $P 2>&1) && { echo "add $1/$2 ok (retry)" >>$LOG; return; }
  fi
  echo "ADD $1/$2: $out" >>$LOG; echo "ADD $1/$2: $out"; FAILS=$((FAILS+1)); }
mk(){ run composition delete $1 -p $P >/dev/null 2>&1; run composition create $1 --width ${2:-1280} --height ${3:-720} -p $P >/dev/null; }

# ---------------------------------------------------------------------------
# refs: crop each reference cell out of the baseline sheets. The sheets were
# built by `composition sheet` (8 px pad and gutter, 28 px label strip, square
# cells, 16:9 content centred), so every cell's origin is exact.
refs(){
  P=project
  local r y
  for r in 0 1 2 3 4 5 6 7; do
    y=$((148 + 676 * r))                      # round1-all-eight.jpg: 640 px cells, 2 columns
    mk ref$((r+1)) 640 360
    A ref$((r+1)) cell --image $BASE/round1-all-eight.jpg --visible-region "8,$y,640,360" --x -8 --y -$y
  done
  mk ref6 800 450                             # round3-t6.jpg holds ref6 in an 800 px cell: sharper
  A ref6 cell --image $BASE/round3-t6.jpg --visible-region "8,183,800,450" --x -8 --y -183
  for r in 1 2 3 4 5 6 7 8; do run composition render ref$r -p $P --out refs/ref$r.png >/dev/null; done
}

# anchors: tight identity crops (the face fills the frame) and PNG sources
# for matting. Ply matting reads PNG, so the real photo is rendered, not converted.
crop(){ # name file x y w [h]
  local h=${6:-$5}
  mk $1 $5 $h
  A $1 photo --image $2 --visible-region "$3,$4,$5,$h" --x -$3 --y -$4
  run composition render $1 -p $P --out anchors/$1.png >/dev/null
}
anchors(){
  P=project
  crop face1535 $ID/IMG_1535.jpg 800 300 600
  crop face1505 $ID/IMG_1505.jpg 780 290 600
  crop face1513 $ID/IMG_1513.jpg 800 280 600
  # the Mac Studio panel alone: the full hero also shows a hand-held Mac mini,
  # which l3-v1 copied instead (product drift)
  crop macstudio $PROD/mac-studio/mac-mini-and-mac-studio-hero.jpg 1068 45 846 575
  mk photo1505 2048 1536
  A photo1505 photo --image $ID/IMG_1505.jpg
  run composition render photo1505 -p $P --out anchors/photo1505.png >/dev/null
}

# ---------------------------------------------------------------------------
# generate: elements alone (light on black, isolated objects on white, plates),
# then the three likeness Jobs. Likeness routes to gpt-image-flare low
# (content workflow.md); everything else takes Ply's default model.
g(){ local id=$1; shift
  [ -f out/generation/$id/job.json ] && { echo "skip $id"; return; }
  ply generate "$@" --job $id --json >logs/gen-$id.json 2>logs/gen-$id.err; echo $? >logs/gen-$id.exit; echo "$id exit=$(<logs/gen-$id.exit)"; }
# Jobs run in background subshells, so their exits are counted after `wait`.
gen_check(){ local f; for f in logs/gen-*.exit; do [ -f "$f" ] || continue
  [ "$(<"$f")" = 0 ] || { echo "GENERATE ${f#logs/gen-} failed"; FAILS=$((FAILS+1)); }; done; }
generate_elements(){
  g e1-desk "A dark moody wooden desk at night, photographed straight on at eye level. A modern open silver laptop sits centred, its screen showing a dark minimal app window with a left sidebar menu and, in the middle, a large white line-art ram head logo above the word 'Herdr.' in a monospace font, plus a green 'Plugins connected' status dot at the bottom. Warm orange bokeh lights in the dark background, a few plants in shadow. The left and right thirds of the frame are dark and uncluttered. Cinematic, high contrast, no people, no other text." --size 1536x1024 &
  g e1-wire "A single glowing neon orange light cable, a thin luminous wire that enters at the left edge and curves smoothly in a gentle S-shape to the right edge, bright hot-white core with an orange glow, on a pure black background. Nothing else in the frame." --size 1536x1024 &
  g e1-frame "A thin glowing neon orange rectangular outline frame with rounded corners, empty and hollow inside, bright hot-white core with orange glow, plus three short neon emphasis tick marks radiating from outside its top-right corner, on a pure black background. Nothing else, no text." --size 1536x1024 &
  g e2-studio "A dark modern podcast studio at night, no people. Deep navy and black tones with magenta and violet neon accent lights, a dark shelf with a small plant on the right, a softly lit wall sign on the far left reading BUILD SHIP LEARN REPEAT in stacked white capitals. Shallow depth of field, cinematic. The centre and right of the frame are dark and uncluttered." --size 1536x1024 &
  g e2-panel "A flat, straight-on screenshot of a dark web app user interface, filling the entire frame edge to edge. A narrow left navigation column with icons and the items Chat, Docs, Code, Deploy, Agents, Integrations; a small app wordmark 'Jev' at the top of the column. The main area has the heading 'Build what's next.' in large white text, a wide rounded input box reading 'Turn my idea into a working app...' with a violet send button, and a row of four small rounded cards: Generate code, Create docs, Build full apps, Automate workflows. Dark charcoal background, violet accents, crisp UI, no device frame." --size 1536x1024 &
  g e2-mic "A black broadcast podcast microphone with a foam windscreen on a short black boom arm, three-quarter view, product shot, isolated on a plain uniform white background with clear margins, soft even studio lighting." --intent isolated --size 1024x1024 &
  g e2-mark "A glowing violet app logo mark: a bold geometric letter S built from two interlocking angular strokes inside a rounded hexagon outline, neon violet light with a white-hot core, centred, on a pure black background. Nothing else, no text." --size 1024x1024 &
  g e3-beams "Brilliant light beams exploding upward in a wide fan from a single point at the bottom centre, neon blue, violet, cyan and white rays with small sparkles and a few thin electric violet squiggles, on a pure black background. Nothing else in the frame." --size 1024x1024 &
  g e4-contours "Thin glowing orange topographic contour lines, like a terrain map, flowing in smooth nested curves across the frame, on a pure black background. Line art only, nothing else." --size 1024x1024 &
  g e5-office "A wide blue-toned modern open-plan tech office at night, seen from the back of the room: dark silhouettes of a few people working at desks with glowing monitors, soft bokeh, deep navy and electric blue palette. Cinematic, no text." --size 1536x1024 &
  g e5-holo "A glowing holographic profile of a human head made of fine blue light particles and circuit lines, facing left, with a small square microchip glowing beside it, electric blue light on a pure black background. Nothing else, no text." --size 1024x1024 &
  g e6-maze "A flat graphic background: thick glowing light-blue maze-like circuit lines with round end nodes on a very dark navy-black background, clean vector look, even coverage across the whole frame. No text, no objects, no table." --size 1536x1024 &
  g e7-vial "A single small clear glass medicine vial with a dark red crimped cap and a white label printed with the word 'PEPTIDES' in bold black sans-serif capitals, product shot, isolated on a plain uniform white background with clear margins, soft even lighting." --intent isolated --size 1024x1536 &
  wait
}
# Reference roles are declared by ordinal in every likeness prompt.
KEEP="Keep the face in attached image 1 exactly, including his apparent age; do not widen, round, age, average, or blend it."
# l3-v1 (kept for the record, replayable): the full Apple hero as the product
# Reference. Both outputs held the hand-held Mac mini from the hero's left panel.
likeness_t3_v1(){
  local id=$1; shift
  g $id "A presenter photo of the man in attached image 1. $KEEP Attached image 2 supplies only pose, framing and camera angle, never its person's face, beard, or hair. Attached image 3 supplies only the product: the silver Mac Studio shown in its top-right panel. Copy the pose and framing of attached image 2: he leans toward the camera, head and shoulders on the left-centre of the frame, wide eyes and raised eyebrows, looking straight into the lens with a surprised expression, his mouth closed; with his left hand he holds the Mac Studio from attached image 3 up on his open palm on the right side of the frame, close to the camera. He wears a plain charcoal t-shirt. Dark moody home studio with purple and blue RGB lights, a keyboard and a mug on the desk. Cinematic lighting." \
    --ref anchors/face1535.png --ref refs/ref3.png --ref $PROD/mac-studio/mac-mini-and-mac-studio-hero.jpg --model gpt-image-flare "$@" --size 1536x1024
}
# From l3-v2: attached image 3 is the Mac Studio panel alone, and the prompt
# names its features and forbids the Mac mini. l3-v3 changes only the framing
# clause (the v2 plate was framed far tighter than ref3).
T3_FRAME_V2="on the right side of the frame, close to the camera, seen slightly from above."
T3_FRAME_V3="on the right side of the frame, seen slightly from above. WIDE framing with generous headroom: his head is small, its width about one sixth of the frame width, centred at about 40 percent from the left; the Mac Studio is about one quarter of the frame width, its top at the vertical middle of the frame, with empty dark space above it for effects."
likeness_t3(){ # job framing-clause extra-args...
  local id=$1 frame=$2; shift 2
  g $id "A presenter photo of the man in attached image 1. $KEEP Attached image 2 supplies only pose, framing and camera angle, never its person's face, beard, or hair. Attached image 3 supplies only the product: the Apple Mac Studio, a tall square silver aluminium box, about as tall as half its width, with two small ports and a wide SD card slot low on its front and a perforated base; it is not a flat Mac mini. Copy the pose and framing of attached image 2: he leans toward the camera, head and shoulders on the left-centre of the frame, wide eyes and raised eyebrows, looking straight into the lens with a surprised expression, his mouth closed; with his left hand he holds the Mac Studio from attached image 3 up on his open palm $frame He wears a plain charcoal t-shirt. Dark moody home studio with purple and blue RGB lights, a keyboard and a mug on the desk. Cinematic lighting." \
    --ref anchors/face1535.png --ref refs/ref3.png --ref anchors/macstudio.png --model gpt-image-flare "$@" --size 1536x1024
}
likeness_t6(){
  local id=$1; shift
  g $id "A photo of the man in attached image 1 sitting behind a large plain white table. $KEEP Attached image 2 supplies only the phone's exact design and colour: the sky blue iPhone 18 Pro, third from the left. Attached image 3 supplies only pose, framing and camera angle, never its person's face, glasses, or hair. Copy the pose and framing of attached image 3: he sits on the right half of the frame, his lower body hidden behind the table, his left forearm and hand resting on the white tabletop, and with his right arm he holds the sky blue phone from attached image 2 very close to the camera on the left side, so the phone appears huge in the foreground, tilted slightly, showing its back and large camera plateau. He wears a plain black t-shirt and no glasses, calm neutral expression. The white tabletop fills the bottom fifth of the frame. Plain uniform light grey wall behind him, soft even lighting, clear margins." \
    --ref anchors/face1505.png --ref $PROD/iphone-18-pro/colour-lineup.jpg --ref refs/ref6.png --model gpt-image-flare "$@" --size 1536x1024
}
likeness_t7(){
  local id=$1; shift
  g $id "An extreme close-up portrait of the man in attached image 1, his face filling the frame from forehead to chin, looking straight into the camera with a sad, intense stare, eyes slightly red and watery, one single tear rolling down his cheek. $KEEP Keep his smooth skin; do not add wrinkles or lines. Dramatic low-key lighting, dark red and black background at the edges, realistic skin texture, cinematic." \
    --ref anchors/face1513.png --model gpt-image-flare "$@" --size 1536x1024
}
generate_likeness(){
  # l3-v1 and l3-v2 are the recorded failed attempts, kept so the record replays;
  # in a fresh workspace they are spent again (about $0.11) unless removed here.
  likeness_t3_v1 l3-v1 --quality low --count 2 &
  likeness_t3 l3-v2 "$T3_FRAME_V2" --quality low --count 2 &   # retry 1: product crop + product wording
  likeness_t3 l3-v3 "$T3_FRAME_V3" --quality low --count 2 &   # retry 2: prompt, wider framing to match ref3
  likeness_t6 l6-v1 --quality low --count 2 &
  likeness_t7 l7-v1 --quality low --count 2 &
  wait
}
generate(){ generate_elements; generate_likeness; gen_check; }

# Selected likeness outputs (short hash), after review beside their anchors.
# Candidates only: nothing here is an approved Creator cutout.
L3=(l3-v3 8366d6ef0145)   # retry 2; l3-v1 held a Mac mini, l3-v2 was framed too tight
L6=(l6-v1 39ee28fa46c2)
L7=(l7-v1 13bd0f1d2774)
gout(){ echo out/generation/$1/outputs/$2*.png; }     # job short-hash → file
single(){ echo out/generation/$1/outputs/*.png; }    # single-output Job → file

# ---------------------------------------------------------------------------
# matte: true alpha, locally, for isolated objects and subjects.
m(){ [ -f out/matting/$1/matte.json ] && { echo "skip $1"; return; }
  if ply matte $2 --id $1 --json >logs/matte-$1.json 2>logs/matte-$1.err; then echo "$1 ok"
  else echo "MATTE $1 failed: $(<logs/matte-$1.err)"; FAILS=$((FAILS+1)); fi; }
matte(){
  m m-mic $(single e2-mic)
  m m-vial $(single e7-vial)
  m m-l6 $(gout ${L6[@]})
  m m-photo1505 anchors/photo1505.png
}

# ---------------------------------------------------------------------------
# build: one fresh Project per thumbnail under builds/, so a rebuild never
# meets a unit Layer that pins its inner Composition (ADR-0026 §3).
# Every Layer is one `composition add` in its final state; no follow-up edits.
proj(){ rm -rf builds/$1; mkdir -p builds; ply project init builds/$1 >/dev/null; P=builds/$1; mk $1; }
G(){ echo "--from-generation $1 --output $2"; }        # job short-hash → options
SANS="--font Archivo"

build_t1(){ # 5 HERDR PLUGINS — tiles turned inward, wires, neon tag, text runs
  proj t1
  local E=out/generation
  A t1 bg --from-generation e1-desk --scale 1.02 --x -168 --y -71 --brightness 0.9 --contrast 1.08
  A t1 vignette --shape rectangle --size 1280x720 --fill "radial:#00000000:55,#000000b0"
  # the green frame: four bars (a stroke-only shape paints nothing)
  for s in "ft:1280x9:0:0" "fb:1280x9:0:711" "fl:9x720:0:0" "fr:9x720:1271:0"; do IFS=: read -r n sz x y <<<"$s"
    A t1 $n --shape rectangle --size $sz --fill "#3dff6a" --shadow "0,0,10,#3dff6acc" --shadow "0,0,26,#3dff6a66" --x $x --y $y; done
  # light wires: ONE generated wire, cropped, stretched per span, rotated, screen-blended
  for w in "w1:303:252:0.07:47" "w2:275:388:0.08:-7" "w3:327:538:0.062:-36" "w4:970:318:0.05:160" "w5:1002:470:0.066:-162"; do
    IFS=: read -r n x y sx r <<<"$w"
    A t1 $n --from-generation e1-wire --visible-region "0,330,1536,330" --scale-to ${sx}x0.15 --rotate $r --blend screen --anchor center,center --x $x --y $y
  done
  # tiles: tile, mark and caption share one perspective, turned toward the laptop
  local i=0 spec name file x y p cap vc
  for spec in "github:github:205:215:20:GitHub:#ffffff" "notion:notion:150:395:20:Notion:" "slack:slack:228:565:20:Slack:" \
              "gdrive:google-drive:1070:305:-20:Google Drive:" "postgres:postgresql:1115:485:-20:PostgreSQL:"; do
    IFS=: read -r name file x y p cap vc <<<"$spec"; i=$((i+1))
    A t1 tile$i --shape rectangle --size 128x128 --corner-radius 24 --fill "#140d08" --outline "3,#ffb34d" \
      --glow "6,8,#ff8a1f" --shadow "0,0,18,#ff7a00dd" --shadow "0,0,44,#ff5a0077" --perspective 0x$p --anchor center,center --x $x --y $y
    A t1 logo$i --image $LOGO/$file/$file.svg ${vc:+--vector-color $vc} --resize-to x58 --perspective 0x$p --anchor center,center --x $x --y $((y-12))
    A t1 cap$i --text "$cap" $SANS --weight 700 --font-size 15 --color "#ffffff" --perspective 0x$p --anchor center,center --x $x --y $((y+40))
  done
  # neon MUST TRY: generated frame on black + local text, both turned -12°
  A t1 tagframe --from-generation e1-frame --visible-region "200,130,1250,720" --scale 0.2 --rotate -12 --blend screen --anchor center,center --x 1040 --y 168
  A t1 tag --text "MUST TRY" $SANS --weight 900 --font-size 30 --color "linear:180deg,#ffe07a,#ff9a2e" --shadow "0,0,12,#ff7a00" --rotate -12 --anchor center,center --x 1022 --y 170
  # headline: one Layer, three runs, fitted to its box
  A t1 title --run "5 " --run "HERDR" --run " PLUGINS" --run-color "2=linear:180deg,#c8ff5a,#26d96b" \
    $SANS --weight 900 --width 112 --font-size 82 --tracking -0.01 --color "#ffffff" \
    --outline "3,#0a0a0a" --shadow "0,6,14,#000000cc" --anchor center,center --x 640 --y 72
  # the channel's own badge replaces the other channel's
  A t1 badge --shape rectangle --size 74x74 --corner-radius 12 --fill "#0b2a15" --outline "3,#3dff6a" --x 22 --y 22
  A t1 mark --image $MARK --vector-color "#ffffff" --resize-to x44 --anchor center,center --x 59 --y 59
  # side card copy: wrap width, one green run
  A t1 side --run "SMALL PLUGINS " --run "BIG" --run " POSSIBILITIES" --run-color "2=#3dff6a" \
    --font "IBM Plex Mono" --font-size 14 --line-height 1.3 --color "#d8d8d8" --wrap-width 110 --x 1160 --y 215
}

build_t2(){ # INSIDE JEV — studio, cutout with a one-sided rim, UI panel in perspective, blurred mic
  proj t2
  A t2 bg --from-generation e2-studio --cover-to canvas --brightness 0.75 --anchor center,center --x 640 --y 360
  # the app screenshot turned away from the viewer on its left edge
  A t2 panel --from-generation e2-panel --scale 0.5 --brightness 1.35 --perspective 0x-24 --rotate -3 --outline "2,#8b6cff66" \
    --shadow "0,20,40,#000000cc" --anchor left,top --x 770 --y 300
  A t2 panelglow --shape ellipse --size 700x420 --fill "radial:#7a3cff55,#7a3cff00" --blend screen --anchor center,center --x 1040 --y 470 --position before:panel
  # the creator: approved real-photo cutout, halo choked, magenta rim from the right
  A t2 kenny --image $CUT/thinking-chin-rest-1596/creator-cutout.png --scale 0.54 --x -330 --y -110 \
    --choke 1.5 --feather 1 --glow "9,14,#ff4fd8,from 90,1" --contrast 1.05
  # foreground mic, out of focus
  A t2 mic --from-matte m-mic --scale 0.62 --flip horizontal --rotate 20 --blur 3 --brightness 0.75 --anchor center,center --x 95 --y 610
  # decorative fictional product mark (the original is not an official mark we can source)
  A t2 mark --from-generation e2-mark --visible-region "212,212,600,600" --scale 0.2 --blend screen --anchor center,center --x 1205 --y 78
  A t2 inside --text "INSIDE" $SANS --weight 900 --width 110 --font-size 118 --color "#ffffff" --shadow "0,6,16,#000000aa" --anchor center,top --x 770 --y 40
  A t2 jevbar --shape rectangle --size 360x116 --fill "#ff2a2a" --shadow "0,8,20,#00000088" --anchor center,center --x 770 --y 230
  A t2 jev --text "JEV" $SANS --weight 900 --width 112 --font-size 116 --color "#ffffff" --anchor center,center --x 770 --y 230
  A t2 sub --text "with the founder" --font "IBM Plex Mono" --font-size 30 --tracking 0.04 --color "#ffffff" --anchor center,top --x 770 --y 298
  A t2 underline --shape rectangle --size 380x2 --fill "linear:90deg,#ffffff00,#ffffffcc:30,#ffffffcc:70,#ffffff00" --anchor center,center --x 770 --y 345
  A t2 scrawl --text "IDEAS INTO IMPACT" --font "Permanent Marker" --font-size 26 --line-height 1 --wrap-width 200 --color "#ffffff" --rotate -16 --anchor center,center --x 1150 --y 628
}

build_t3(){ # M5 ULTRA — likeness plate, beams on black, tilted tiles, the real chip mark
  proj t3
  A t3 bg $(G ${L3[@]}) --scale 0.9 --x -40 --y -130 --contrast 1.05
  A t3 beams --from-generation e3-beams --scale 0.72 --blend screen --anchor center,bottom --x 941 --y 322
  A t3 boxglow --shape ellipse --size 420x70 --fill "radial:#9fe6ffcc,#6a5cff55:50,#6a5cff00" --blend screen --anchor center,center --x 941 --y 292
  local i=0 spec file x y r
  for spec in "qwen:748:190:-12" "deepseek:940:86:4" "ollama:1135:188:12"; do
    IFS=: read -r file x y r <<<"$spec"; i=$((i+1))
    A t3 tile$i --shape rectangle --size 112x112 --corner-radius 20 --fill "linear:160deg,#1b1640,#0b0a1c" --outline "3,#f2eaff" \
      --shadow "0,0,16,#b98bffee" --shadow "0,0,40,#6a5cff88" --perspective 18x0 --rotate $r --anchor center,center --x $x --y $y
    A t3 icon$i --image $LOGO/$file/$file.svg --vector-color "#ffffff" --resize-to x60 --perspective 18x0 --rotate $r --anchor center,center --x $x --y $y
  done
  # the real M5 Ultra chip mark, cropped from Apple's press image at composition time
  A t3 chip --image $PROD/m5-ultra/m6-and-m5-ultra-chips.jpg --visible-region "1045,222,658,658" --visible-region-radius 10 --scale 0.32 \
    --shadow "0,0,18,#3fd0ffcc" --shadow "0,0,44,#8a5bff77" --x -$((1045*32/100 - 22)) --y -$((222*32/100 - 22))
}

build_t4(){ # No code AI Agents — flat charcoal, masked contour lines, pill highlight, run-styled brand line
  proj t4
  local R=(--font "Nunito Sans" --weight 700 --font-size 120 --color "#ffffff")
  A t4 bg --shape rectangle --size 1280x720 --fill "linear:120deg,#2b2c31,#1f2024"
  # contour lines on black, screen-blended, faded out by a soft radial mask (the mask does not paint)
  A t4 fade --shape ellipse --size 1100x760 --fill "radial:#ffffffff:25,#ffffff00" --anchor center,center --x 1060 --y 90
  A t4 contours --from-generation e4-contours --scale 0.9 --blend screen --saturation 1.2 --mask fade --x 520 --y -170
  A t4 kenny --image $CUT/teeth-smile-frontal-1511/creator-cutout.png --scale 0.8 --x 170 --y -250 --choke 1.5 --feather 1
  A t4 l1 --text "No code" "${R[@]}" --anchor left,top --x 72 --y 128
  A t4 l2 --text "AI Agents" "${R[@]}" --anchor left,top --x 92 --y 268
  A t4 l3 --text "for beginners" "${R[@]}" --anchor left,top --x 72 --y 410
  A t4 pill --shape rectangle --size 606x124 --corner-radius 14 --fill "#f0643c" --anchor left,top --x 66 --y 256 --position before:l2
  A t4 brandmark --image $MARK --vector-color "#ffffff" --resize-to x46 --anchor left,center --x 70 --y 628
  A t4 brand --run "Launchpad" --run " Tutorials" --run-color "2=#f0643c" --font "Nunito Sans" --weight 700 --font-size 44 --color "#ffffff" --anchor left,center --x 128 --y 628
}

build_t5(){ # AI Jobs Are Changing — skewed italic, stacked effects + inner shadow, masked office plate, fitted name card
  proj t5
  A t5 bg --shape rectangle --size 1280x720 --fill "linear:100deg,#0b1a33,#06101f:60,#040a14"
  A t5 officefade --shape rectangle --size 900x520 --fill "linear:180deg,#ffffff00,#ffffffff:45" --x 380 --y 200
  A t5 office --from-generation e5-office --scale 0.62 --brightness 0.55 --saturation 1.1 --mask officefade --x 360 --y 120
  A t5 holo --from-generation e5-holo --scale 0.3 --blend screen --opacity 0.85 --anchor center,center --x 1165 --y 92
  # left wall screen
  A t5 wall --shape rectangle --size 230x470 --fill "linear:180deg,#3f82dc,#2458a8" --shadow "0,0,40,#2f7bff55" --x 0 --y 0
  A t5 wallcopy --text "AI
for a
Better
World" $SANS --weight 600 --font-size 38 --line-height 1.05 --color "#cfe3ffcc" --x 22 --y 36
  A t5 kenny --image $CUT/neutral-three-quarter-1530/creator-cutout.png --scale 0.58 --x -292 --y -157 \
    --choke 1.5 --feather 1 --glow "8,12,#9fd0ff,from 90,0.9" --contrast 1.05
  # headline: the italic is a skew (no synthesized italic face)
  A t5 ai --text "AI Jobs" $SANS --weight 900 --width 100 --font-size 196 --tracking -0.02 --color "#ffffff" --skew=-12x0 \
    --shadow "0,10,18,#000000aa" --shadow "0,0,34,#3a8bff66" --anchor center,top --x 870 --y 150
  A t5 changing --text "Are Changing" $SANS --weight 900 --width 88 --font-size 118 --tracking -0.01 --color "linear:180deg,#8ff6ff,#1c9bff" \
    --skew=-12x0 --inner-shadow "0,-5,6,#0a3b8acc" --shadow "0,8,14,#000000aa" --shadow "0,0,30,#29a8ff88" --anchor center,top --x 874 --y 316
  A t5 rule --shape rectangle --size 3x100 --fill "#8cc4ff" --x 986 --y 508
  A t5 bullets --text "NEW ROLES
NEW SKILLS
NEW OPPORTUNITIES" --font "IBM Plex Mono" --font-size 17 --tracking 0.12 --line-height 1.75 --color "#b8d4ff" --x 1004 --y 506
  # name card (--fit-box is not used: its render paints about half the size measure reports; see README)
  A t5 card --shape rectangle --size 452x96 --corner-radius 10 --fill "#07101fe6" --outline "2,#3f82dc" --x 24 --y 590
  A t5 name --text "Kenny Liao" $SANS --weight 800 --font-size 34 --color "#ffffff" --x 44 --y 600
  A t5 role --text "Founder of The AI Launchpad" $SANS --weight 500 --font-size 24 --color "#d7e3ff" --x 44 --y 644
}

build_t6(){ # iPhone 18 Pro — body behind the table through a mask, cover-fit maze, stacked title effects
  proj t6
  local PCT=55 X=218 Y=160                     # one placement for both copies of the plate (content origin)
  local S=0.$PCT TOP=$((845 * PCT / 100 + Y))  # scale; the plate's table top on the canvas (source y 845)
  A t6 maze --from-generation e6-maze --cover-to canvas --saturation 0.45 --brightness 0.55 --contrast 1.2 --anchor center,center --x 640 --y 360
  A t6 glow --shape ellipse --size 980x640 --fill "radial:#2f86ffbb,#2f86ff00" --blend screen --anchor center,center --x 700 --y 420
  A t6 title --text "iPhone 18 Pro" --font-file /System/Library/Fonts/SFNS.ttf --weight 800 --font-size 168 --tracking -0.035 \
    --color "linear:180deg,#eef7ff,#9cc8f5:45,#4f8fd6" --inner-shadow "0,-6,10,#1e4f9acc" --outline "3,#dcefffdd" \
    --shadow "0,0,26,#4aa3ffcc" --shadow "0,8,16,#00000088" --anchor center,top --x 640 --y 36
  A t6 table --shape rectangle --size 1280x$((720 - TOP)) --fill "linear:180deg,#f3f4f6,#d9dde3" --x 0 --y $TOP
  A t6 kenny --from-matte m-l6 --scale $S --x $X --y $Y --contrast 1.04
  # the table band of the UNMATTED plate over the cutout: arms and phone come from
  # the photo; a soft-edged mask clips it (the mask does not paint)
  A t6 bandmask --shape rectangle --size 845x$((720 - TOP)) --fill "linear:90deg,#ffffff00,#ffffffff:10,#ffffffff:90,#ffffff00" --x $X --y $TOP
  A t6 band $(G ${L6[@]}) --scale $S --x $X --y $Y --contrast 1.04 --mask bandmask
  # soft elliptical contact shadow where the body meets the table: a radial ellipse stretched flat
  A t6 edge --shape ellipse --size 200x200 --fill "radial:#00000066,#00000000" --resize-to 760x46 --blend multiply --anchor center,center --x 660 --y $((TOP + 6)) --position before:band
}

build_t7(){ # peptides — close-up plate, one matted vial used six times with depth-of-field blur
  proj t7
  # the plate is pulled back below cover size to match ref7's framing; its feathered
  # edge melts into a dark base
  A t7 base --shape rectangle --size 1280x720 --fill "radial:#2a0406,#0a0102"
  A t7 face $(G ${L7[@]}) --scale 0.76 --feather 40 --x 56 --y -58 --contrast 1.06 --saturation 0.95
  A t7 vignette --shape rectangle --size 1280x720 --fill "radial:#00000000:48,#3a0508cc:80,#120203f0" --blend multiply
  # name:x:y:scale:rotate:blur:brightness — near vials blur most, the two label vials stay sharp
  local v n x y s r b br
  for v in "v2:150:450:0.22:12:7:0.5" "v4:1150:70:0.36:28:9:0.6" "v5:1215:330:0.40:32:4:0.75" \
           "v3:70:700:0.60:-38:14:0.7" "v1:100:120:0.38:-8:0:0.9" "v6:1170:600:0.52:28:0:0.9"; do
    IFS=: read -r n x y s r b br <<<"$v"
    A t7 $n --from-matte m-vial --scale $s --rotate $r --blur $b --brightness $br --contrast 1.1 --choke 1 \
      --shadow "0,14,28,#000000cc" --anchor center,center --x $x --y $y
  done
}

build_t8(){ # $10.72 vs $1.33 — flat chart on a folder unit, real-photo matte
  proj t8
  # the folder: tab, label slot and body in their own Composition, used as one unit
  mk folder 800 680
  A folder tab --shape rectangle --size 290x80 --corner-radius 16 --fill "#ecd0ad" --x 250 --y 0
  A folder slot --shape rectangle --size 200x14 --corner-radius 7 --fill "#fbf3e8" --x 295 --y 24
  A folder body --shape rectangle --size 770x630 --corner-radius 22 --fill "linear:180deg,#f8dfc2,#f2d4b2" --x 0 --y 44
  A t8 bg --shape rectangle --size 1280x720 --fill "linear:90deg,#6784a8,#56739a"
  A t8 folderfall --shape ellipse --size 200x200 --fill "radial:#1c2a3f88,#1c2a3f00" --resize-to 860x120 --anchor center,center --x 440 --y 688
  A t8 folder --unit folder --x 44 --y 28
  A t8 axis --shape rectangle --size 540x3 --fill "#2a2a2a" --x 160 --y 586
  A t8 bigbar --shape rectangle --size 196x360 --fill "#3a3a3c" --x 190 --y 226
  A t8 smallbar --shape rectangle --size 200x44 --fill "#ff2fc8" --x 470 --y 542
  A t8 p1 --text '$10.72' $SANS --weight 800 --font-size 84 --tracking -0.02 --color "#111111" --anchor center,bottom --x 290 --y 212
  A t8 p2 --text '$1.33' $SANS --weight 800 --font-size 76 --tracking -0.02 --color "#111111" --anchor center,bottom --x 570 --y 528
  A t8 lab1 --text "Claude" $SANS --weight 700 --font-size 34 --color "#111111" --anchor center,top --x 288 --y 612
  A t8 u1 --shape rectangle --size 120x3 --fill "#111111" --anchor center,top --x 288 --y 656
  A t8 lab2 --text "Claude +" $SANS --weight 700 --font-size 34 --color "#111111" --anchor right,top --x 628 --y 612
  A t8 u2 --shape rectangle --size 144x3 --fill "#111111" --anchor right,top --x 628 --y 656
  A t8 labmark --image $LOGO/openai/openai.svg --vector-color "#111111" --resize-to x48 --anchor left,center --x 640 --y 632
  # the creator: a real identity photo, matted locally, edge choked against the flat blue
  A t8 kenny --from-matte m-photo1505 --scale 1.08 --x -135 --y -290 --choke 1.5 --feather 1 --contrast 1.04
}

# ---------------------------------------------------------------------------
# sheet: every reference beside its rebuild (16:9 cells), and one likeness sheet
# per generated likeness — the anchor and References first, then every
# candidate of every attempt, labelled job #index short-hash. Evidence only.
sheet(){
  local args=() labels=() i=0 t
  for t in 1 2 3 4 5 6 7 8; do
    args+=(refs/ref$t.png "$OUT/renders/t$t.png")
    labels+=(--label "$((i+1))=ref$t (reference)" --label "$((i+2))=t$t (Ply rebuild)"); i=$((i+2))
  done
  run composition sheet "${args[@]}" "${labels[@]}" --pair --cell 640x360 --out "$OUT/comparison-sheet.png" >/dev/null \
    || { echo "SHEET comparison failed"; FAILS=$((FAILS+1)); }
  likeness_sheet t3 "anchor IMG_1535 (identity)" anchors/face1535.png "ref3 (pose and framing only)" refs/ref3.png \
    "Mac Studio crop (product, from l3-v2)" anchors/macstudio.png -- l3-v1 l3-v2 l3-v3
  likeness_sheet t6 "anchor IMG_1505 (identity)" anchors/face1505.png "iPhone 18 Pro lineup (product)" $PROD/iphone-18-pro/colour-lineup.jpg \
    "ref6 (pose and framing only)" refs/ref6.png -- l6-v1
  likeness_sheet t7 "anchor IMG_1513 (identity)" anchors/face1513.png -- l7-v1
}
likeness_sheet(){ # name {label file}... -- job...
  local name=$1; shift
  local files=() labels=() n=0 j f k
  while [ "$1" != "--" ]; do n=$((n+1)); files+=("$2"); labels+=(--label "$n=$1"); shift 2; done; shift
  for j in "$@"; do k=0
    for f in out/generation/$j/outputs/*.png; do k=$((k+1)); n=$((n+1))
      local h=${f##*/}; files+=("$f"); labels+=(--label "$n=$j ${h:0:12}"); done
  done
  run composition sheet "${files[@]}" "${labels[@]}" --columns 3 --cell 512x342 --out "$OUT/likeness-$name.png" >/dev/null \
    || { echo "SHEET likeness-$name failed"; FAILS=$((FAILS+1)); }
}

render_one(){ run composition render $1 -p builds/$1 --out "$OUT/renders/$1.png" >logs/render-$1.log 2>&1 && echo "render $1 ok" \
  || { echo "RENDER $1 failed: $(<logs/render-$1.log)"; FAILS=$((FAILS+1)); }; }
build(){ local t; for t in t1 t2 t3 t4 t5 t6 t7 t8; do build_$t; done; }
render(){ local t; for t in t1 t2 t3 t4 t5 t6 t7 t8; do render_one $t; done; }

for phase in "${@:-all}"; do
  case $phase in
    refs) refs ;; anchors) anchors ;; generate) generate ;;
    matte) matte ;; build) build ;; render) render ;; sheet) sheet ;;
    t[1-8]) build_$phase; render_one $phase ;;
    all) refs; anchors; generate; matte; build; render; sheet ;;
    *) if declare -F "$phase" >/dev/null; then "$phase"; else echo "unknown phase $phase"; exit 2; fi ;;
  esac
done
echo "failures: $FAILS"
