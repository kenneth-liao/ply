# Qualification — rebuilding the eight outliers with Ply only (#315)

Spec #285, TEST-008 (ISC-59). An agent rebuilt the eight 2026-09-23 outlier
thumbnails on Ply 7.4.0 (`main` @ `0fce6e0`). Every image operation was a `ply` command; the only
other inputs were unmodified sourced files and `ply generate`. It built each
thumbnail from parts, following the installed `visual-authoring` and
`ply-operating` skills. The baseline is the three rounds archived at
`docs/archive/research/2026-09-23-outlier-test-2/`.

This is agent preparation. **Kenny's visual acceptance is #316. Nothing
here is approved:** not the renders, not the likeness candidates, not any
cutout.

## What is here

- `rebuild.sh`: the whole rebuild, one phase at a time: `refs`, `anchors`,
  `generate`, `matte`, `build`, `render`, and `sheet`. Besides `ply`, it runs
  only shell builtins, `mkdir`, `rm -rf` of its own `builds/` Projects, and
  `perl -e alarm` as a 180 s timeout around ply commands that open the render
  page. It ends with a count of failed ply steps of any kind.
- `costs.md`: every Gateway charge, from the receipts.
- `logs/jobs/`: the 18 published Generation Job records (prompts, Reference
  identities, receipts). `logs/mattes/`: the 4 matte records.
  `logs/build.log`: the final build, one line per Layer.
  `logs/measure/`: `composition measure` for each final Composition.
  Local paths are rewritten to `$CONTENT_ROOT` and `$WORKSPACE`.

The renders, the comparison sheet, and the likeness sheets show Kenny's
likeness and third-party thumbnails. They are in the private
`kenneth-liao/ai-launchpad-content` repository at
`assets/creator-cutouts/qualification/ply-285-rebuild/`.

## Run it

```bash
export CONTENT_ROOT=/path/to/ai-launchpad-content WORKSPACE=/path/to/empty-dir
docs/qualification/285/rebuild.sh all        # generate needs AI_GATEWAY_API_KEY
```

Generation is not deterministic. The build pins each selected output by its
short hash, so it replays from the retained Job records. A fresh
workspace generates new candidates, which need a new review.

**Replay check.** A fresh workspace was given only the retained `out/`
(Jobs and mattes), with no Gateway key. Running `all` reproduced all eight
renders, the recovered references, and the anchor crops byte-for-byte.

| | |
|---|---|
| Compositions | 8 thumbnails (plus one inner unit Composition, t8 `folder`) |
| Layers | 112, each one `composition add` in its final state; no follow-up edits |
| Build + render, all eight | 62 s |
| Generation | 18 Jobs, 23 images, **$0.385518** (see `costs.md`) |
| Matting | 4 local passes |
| Failed ply steps in the final run | 0 (an intermittent anchor refusal is retried once and logged when it happens; see Findings) |

## Recovering the references

The original workspace (`ref/`) is gone. The references come from the
private baseline sheets and were cropped out with ply alone. Those sheets
were built by `composition sheet`, with an 8 px pad and gutter, a 28 px
label strip, and square cells with the 16:9 content centred, so every cell's
position is exact. A Composition the size of the cell holds the sheet as an
image Layer with `--visible-region` and a negative `--x/--y`, and `render`
writes the cell. t1–t8 come from `round1-all-eight.jpg` at 640×360. ref6
comes from `round3-t6.jpg` at 800×450, which is sharper. The crops are
JPEG-soft at that size; they are fine for review and as pose References.

## Inputs and substitutions

The asset order was local library, then sourced, then generated.

| Element | Source |
|---|---|
| GitHub, Notion, Slack, Google Drive, PostgreSQL, Qwen, DeepSeek, OpenAI marks | content library `assets/logos/` (unmodified; #314) |
| Ollama mark (t3) | **sourced here** from Simple Icons (the source #314 used for other vendor marks; Ollama publishes no brand guidelines), byte-unmodified, with `meta.json` (source, fetch date, usage terms) |
| Mac Studio (t3 product Reference) | **sourced here**: Apple Newsroom press image, byte-unmodified, `assets/products/mac-studio/`; the same editorial terms as the #314 iPhone and M5 images. It is used only as a generation Reference, never composited. |
| iPhone 18 Pro lineup (t6), M5 Ultra chip (t3) | content library `assets/products/` |
| Creator (t2, t4, t5) | approved real-photo cutouts `thinking-chin-rest-1596`, `teeth-smile-frontal-1511`, `neutral-three-quarter-1530` |
| Creator (t8) | real identity photo `IMG_1505`, matted locally |
| Creator (t3, t6, t7) | likeness generation from identity crops (below) |
| Channel mark | `brand/marks/mark.svg` |
| t6 title font | `/System/Library/Fonts/SFNS.ttf`, a caller font imported unmodified. SF Pro's licence limits use outside Apple platforms; this test does not publish, but a published thumbnail needs a licence check. |

The requests to Simple Icons, Apple and LM Studio carried a generic
User-Agent and no identity.

**Substitutions.** Each is recorded because the original mark could not be
identified, is not an official mark, or is another channel's brand:

- t1 FRU DEV badge → the channel mark (another channel's brand).
- t2 Jev "S" mark → a generated decorative fictional mark (`e2-mark`). Jev's
  mark is not an official mark we can source.
- t3 anime-girl app tile → the Qwen mark from the library. The original app
  could not be identified.
- t3 LM Studio tile → the DeepSeek mark from the library. LM Studio was
  identified, but its published brand guidelines (lmstudio.ai/brand) forbid
  rotating or skewing the logo, adding shadows or other effects, and placing
  it on busy backgrounds. The reference's treatment needs all three, so the
  mark was not used and no LM Studio file was added.
- t3 Ollama tile → the real Ollama mark. The file stays unaltered; the
  perspective and shadows are applied at composition, and Ollama publishes no
  brand guidelines that forbid them.
- t4 Voiceflow Tutorials → the channel mark + "Launchpad Tutorials" (another
  channel's brand).
- The creator in every reference → Kenny.

## Per thumbnail

Each row lists the capabilities exercised by that build. Items in **bold**
are #285 capabilities.

| | Parts | Capabilities | Remaining differences from the reference |
|---|---|---|---|
| t1 5 HERDR PLUGINS | desk plate; 5 library marks on tiles with captions; one wire used 5×; neon frame and text; stroke frame from 4 bars; mono side copy | **text runs** (the headline is one Layer: white / gradient / white); **perspective** on each tile, mark, and caption; **stacked shadows** on tiles and frame bars; **wrap width** + runs on the side copy | the laptop screen is simpler than the ref's UI; the wires are placed by hand, not routed |
| t2 INSIDE JEV | studio plate; approved cutout; generated flat UI screenshot; matted mic; fictional mark | **perspective** turns the flat screenshot; **one-sided glow** (magenta rim from the right); **choke/feather** on the cutout; **blur** on the foreground mic; **cover** fit on the plate; **wrap width** on the scrawl | the ref person's pink coat and mic-mug branding are not reproduced |
| t3 M5 ULTRA | likeness plate holding the real Mac Studio; beams on black; 3 tiles (Qwen, DeepSeek, Ollama); real M5 Ultra chip crop | **perspective** on tiles and marks; **stacked shadows** on tiles and chip; screen blend | the ref's beams rise from inside the box; ours rise from its top |
| t4 No code AI Agents | flat backdrop; contour lines on black; approved cutout; pill; brand line | **mask** (a soft radial mask fades the contours; the mask does not paint); **text runs** on the brand line; **choke/feather** | none significant at viewing size |
| t5 AI Jobs Are Changing | backdrop; office plate; holo head; wall screen; approved cutout; name card | **skew** as italic (no synthesized face); **stacked shadow + glow** and an **inner shadow** on the headline; **mask** (a gradient fades the office plate); **one-sided glow** (cool rim) | the ref speaker gestures; the approved cutout has arms down |
| t6 iPhone 18 Pro | maze plate; likeness plate with the real iPhone; table | **mask**: the body sits behind the table, and the unmatted plate is clipped to the table band by a soft-edged mask over the matted subject, so the arms and phone come from the photo; **cover** fit; **stacked** outline + glow + drop shadow + **inner shadow** on the title; the **soft elliptical shadow** (a radial ellipse stretched with `--resize-to 760x46`) | the phone is a little smaller than in the ref |
| t7 peptides | close-up likeness plate; one matted vial used 6×; vignette | **blur** as depth of field (0–16 px by depth); **feather** melts the plate edge into a dark base; stacked shadows | the ref vials are more varied (several labels) |
| t8 $10.72 vs $1.33 | real-photo matte; shapes; text; the OpenAI mark (the reference's own) | **unit Layer**: tab, slot, and body are one live `folder` Composition placed as one Layer; the **soft elliptical shadow** under it; **choke/feather** on the photo edge | none significant at viewing size |

Not exercised: `--fit-box` (see Findings) and a unit with skew or
perspective (refused by design; see Findings).

## Likeness

All likeness Jobs used `gpt-image-flare --quality low` (the content
repository's routing). Each prompt names every Reference by ordinal and role.
Reference 1 is always a tight identity crop. The crop is rendered by ply from
a real identity photo, so the face fills the frame. The budget was two
retries per step and six per likeness (#310).

| Likeness | Anchor | Other References | Attempts | Retries used | Selected |
|---|---|---|---|---|---|
| t3 surprised, holding a Mac Studio | `IMG_1535` crop | ref3 (pose and framing only); Mac Studio (product) | `l3-v1`: both outputs held the hand-held **Mac mini** from the hero's other panel (product drift). `l3-v2`: product Reference cropped by ply to the Mac Studio panel, features named, Mac mini forbidden → correct product, but framed far tighter than ref3. `l3-v3`: only the framing clause changed → matches ref3. | 2 of 6: retry 1 changed the product Reference and its wording (a product fix, outside the face ladder), retry 2 the prompt (framing) | `l3-v3` `8366d6ef0145` |
| t6 behind a table, holding the phone | `IMG_1505` crop | iPhone 18 Pro lineup (product); ref6 (pose and framing only) | `l6-v1`: pose, product, and table match on the first try | 0 | `l6-v1` `39ee28fa46c2` |
| t7 extreme close-up, one tear | `IMG_1513` crop | none | `l7-v1`: face keeps the anchor's apparent age | 0 | `l7-v1` `13bd0f1d2774` |

Both t3 retries fixed the product or the framing, not the face. The candidate
faces read as the anchor at viewing size. `l3-v3` shows forehead lines from
the surprised expression; the anchor also has them. Kenny should check this
at #316. The likeness sheets (anchor, References, every candidate) are in the
content repository. Selection is the agent's, for the build only; it is not
approval.

## Findings

### Bugs (not fixed here; this ticket is qualification only)

1. **`composition add` with `--fit-box` plus `--shadow` or `--outline`
   crashes with a raw TypeError**:
   `rev.shadow.map is not a function` or `rev.outline.map is not a function`.
   The same facts through `layer edit`, or `--wrap-width` in place of
   `--fit-box`, work. Minimal repro:
   `ply composition add c t --text "5 HERDR" --font Archivo --font-size 60 --color "#ffffff" --fit-box 300x100 --outline "3,#0a0a0a" --x 10 --y 150`.
   Nothing is published, but the error is not a clean refusal.
2. **A `--fit-box` text Layer renders at about half the size that `measure`
   reports.** This holds even when the text already fits. Example: "Founder
   of The AI Launchpad", Archivo 500 at 28 px, `--fit-box 410x44`.
   `measure` reports an effective size of 28 px and 367×26 painted, the
   same as without the box, but the render paints it at about 15 px. Render
   and measure disagree, so `--fit-box` was dropped from t5.
3. **An anchored `composition add` of a perspective Layer is refused
   intermittently** with "no visible painted ink". The repro was 1 in 12
   identical adds of `--text "PostgreSQL" … --perspective 0x-20 --anchor center,center`.
   Without perspective, 12 of 12 succeed. It hit a different t1 caption on
   different runs. The refusal mutates nothing, so `rebuild.sh` retries that
   one refusal once and logs it. Full builds during this run hit it on `t1/cap3`,
   `t1/cap5` and `t1/cap1`; the final build needed no retry.

### Gaps and friction

- **Unit Layers refuse `--skew` and `--perspective`** (ADR-0026 §4, by
  design). A tile with its mark and caption cannot turn as one plane. Each
  member takes the same perspective about its own centre. That is close
  enough for a Y tilt on members that share a centre line.
- **A unit Layer that no Composition uses still blocks deleting its inner
  Composition** "for as long as the Project exists". Rebuilding in place
  therefore cannot delete and recreate the inner Composition. `rebuild.sh`
  builds each thumbnail in a fresh Project.
- **A stroke-only shape still paints nothing** (transparent `--fill` plus
  `--outline`). t1's frame is 4 bars, as in round 1.
- Options whose value starts with a dash need `=`: `--skew=-12x0`. The
  refusal says so clearly.
- Bundled Montserrat, Nunito Sans, and Source Sans 3 are single static
  weights. The refusal names the available weight; Archivo, which is
  variable, covered every heavy headline.
- The same `--anchor left,top --x 100 --y 100` on shadowed text lands at the
  same placement through `add` and `edit` ((99, 89) both ways): the round-3
  64 px gap is gone.

### What worked

- **Building from parts**, with the skills as the only guidance: every
  element is its own Layer, and light is generated on black and
  screen-blended.
- **The mask** solved t6 cleanly. No hand-registered band crop was needed.
- **Pose References** (the recovered reference thumbnail, "pose and framing
  only, never its person's face") gave each likeness the reference's
  composition on the first try.
- **One-command adds.** Iteration was edit-free: the script was changed and
  rebuilt, and each rebuild of all eight took about a minute.
