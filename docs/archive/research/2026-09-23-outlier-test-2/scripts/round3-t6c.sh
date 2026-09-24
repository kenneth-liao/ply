#!/usr/bin/env bash
# Round 3: the t6 (iPhone 18 Pro) redo, in the order it was run on 2026-09-23.
# Run from $WORKSPACE (a directory holding project/, ref/, src/, and out/).
# The later `layer edit` steps are kept rather than folded into the adds: an
# anchor on `add` and on `edit` resolves differently when effects exist
# (spec #285 US-002), so folding them would change the result.
set -u
P=project
F=$WORKSPACE/src/anchor-1505-face.png        # tight crop of identity photo IMG_1505
PH=$WORKSPACE/src/sourced/iphone-colors.jpg  # Apple Newsroom iPhone 18 Pro colour lineup
R=$WORKSPACE/ref/ref6.jpg                    # the reference thumbnail, pose and framing only

PROMPT="A photo of the man in attached image 1 sitting behind a large plain white table. Copy the pose and framing of attached image 3: he sits on the right half of the frame, his lower body hidden behind the table, his left forearm and hand resting on the white tabletop, and with his right arm he holds the light blue phone from attached image 2 very close to the camera on the left side, so the phone appears huge in the foreground, tilted slightly, showing its back and large camera plateau. Keep the face in attached image 1 exactly, including his age; do not widen, round, age, average, or blend it. Attached image 2 supplies only the phone's exact design and colour. Attached image 3 supplies only pose, framing and camera angle, never its person's face, glasses, or hair. He wears a plain black t-shirt and no glasses. The white tabletop fills the bottom quarter of the frame. Plain uniform light grey wall behind him, soft even lighting, a soft natural shadow of his arm on the table."
ply generate "$PROMPT" --ref "$F" --ref "$PH" --ref "$R" --model gpt-image-flare --quality low --count 2 --size 1536x1024 --job g6-kenny-v2
ply generate "$PROMPT" --ref "$F" --ref "$PH" --ref "$R" --model gpt-image-flare --quality medium --count 1 --size 1536x1024 --job g6-kenny-v3
# Selected: g6-kenny-v2 output 2 (54f59481…). Matte it.
ply matte out/generation/g6-kenny-v2/outputs/54f59481*.png --id m-g6-kenny-v2

ply composition create t6c --width 1280 --height 720 -p $P
ply composition add t6c bg --from-generation g6-maze --resize-to 1280x --anchor center,top --x 640 --y -40 --brightness 0.32 --saturation 0.6 --contrast 1.2 -p $P
ply composition add t6c glow --shape ellipse --size 900x620 --fill "radial:#2f86ffaa,#2f86ff00" --blend screen --anchor center,center --x 860 --y 380 -p $P
ply composition add t6c title --text "iPhone 18 Pro" --font-file /System/Library/Fonts/SFNS.ttf --weight 800 --font-size 150 --tracking -0.035 --color "linear:180deg,#eaf5ff,#9cc8f5:45,#4f8fd6" --outline "4,#dcefffdd" --shadow "0,0,26,#4aa3ffcc" --anchor center,top --x 640 --y 22 -p $P
ply composition add t6c gloss --text "iPhone 18 Pro" --font-file /System/Library/Fonts/SFNS.ttf --weight 800 --font-size 150 --tracking -0.035 --color "linear:180deg,#ffffffcc,#ffffff00:48" --anchor center,top --x 640 --y 22 -p $P
# Occlusion without a mask: the matted subject over the wall, then the
# UNMATTED generation cropped to the table band on top. Both copies are placed
# by content origin (plain --x/--y), never by --anchor, so they register.
ply composition add t6c kenny --from-matte m-g6-kenny-v2 --scale 0.8333 --anchor left,top --x 0 --y -40 --contrast 1.05 -p $P
ply composition add t6c table --from-generation g6-kenny-v2 --output 2 --visible-region "0,822,1536,202" --scale 0.8333 --anchor left,bottom --x 0 --y 813 -p $P
for n in kenny table; do ply layer edit t6c/$n --scale 0.62 -p $P; ply layer edit t6c/$n --x 0 --y 130 -p $P; done
ply composition add t6c tableext --shape rectangle --size 360x110 --fill "linear:180deg,#e5e4e2,#ebebeb" --x 920 --y 640 --position before:table -p $P
# The title wrapped when centred (text layout width = canvas width - x;
# spec #285 US-001). Workaround: a left anchor at a hand-computed x.
for n in title gloss; do ply layer edit t6c/$n --font-size 160 -p $P; done
ply layer edit t6c/title --anchor left,top --x 109 --y 12 -p $P
ply layer edit t6c/gloss --x 168 --y 40 -p $P   # box origin of the title; anchoring a fade-to-transparent Layer uses only its opaque half
ply layer edit t6c/glow --anchor center,center --x 720 --y 400 -p $P
ply layer edit t6c/bg --resize-to x1000 -p $P
ply layer edit t6c/bg --anchor center,top --x 640 --y -120 -p $P   # overscan hides the maze plate's own tabletop
# Contact shadow under the forearm: soft radial circles between the table band
# and a third copy of the subject cropped to the band, so the hand sits on top.
# (A radial ellipse with --resize-to WxH would also work; found in review.)
i=0; for p in "700:688" "770:694" "840:690" "900:680"; do IFS=: read x y <<<"$p"; i=$((i+1)); ply composition add t6c sh$i --shape ellipse --size 110x110 --fill "radial:#00000048,#00000000" --anchor center,center --x $x --y $y -p $P; done
ply composition add t6c front --from-matte m-g6-kenny-v2 --visible-region "0,822,1536,202" --scale 0.62 --x 0 --y 130 --contrast 1.05 -p $P
ply composition render t6c -p $P --out final/t6c.png
