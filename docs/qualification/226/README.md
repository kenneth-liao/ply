# Qualification — spec #226 US-007, ticket #234

Rebuild of the "Claude Skills" (t2) reference thumbnail from the first-run
workspace (`~/Pictures/youtube/ply-outlier-recreations`, READ-ONLY input),
and the nine-pair reference-versus-result sheet — the ISC-41 (one command
per Layer) and ISC-45 (name addressing) probes, the ISC-35 caller-font
probe, and the ISC-42 comparison-sheet probe.

- `rebuild-claude-skills.sh` — the committed rebuild script. Usage:
  `rebuild-claude-skills.sh [workspace] [outdir]`. It invokes only `ply`,
  creates every Layer in its final state with exactly one
  `ply composition add`, and captures no Layer id: nothing reads ply's
  output, and the one later Layer reference is the name address `t2/wm`.
- `fonts/PressStart2P-Regular.ttf` with its licence `fonts/OFL.txt` — the
  acquired OFL pixel font (Press Start 2P, from `google/fonts`
  `ofl/pressstart2p`), passed with `--font-file`.
- `renders/t2.png`, `measure/t2.txt` — the rebuild render and its
  `ply composition measure` output. The script also writes
  `measure/wm-inspect.txt` from `ply layer inspect t2/wm`; it is not
  committed because `inspect` prints a Layer id and a creation time that
  differ on every run.
- `nine-pair-sheet.png` — the nine reference/result pairs, built by
  `ply composition sheet --pair` (command below).

## Command counts

| | First run (`build.sh` + `lib.sh`) | #207 rebuild | This rebuild |
| --- | --- | --- | --- |
| ply commands for t2's seven Layers | add + follow-up edits per Layer | 17 (7 `add`, 10 `layer edit`) | **7 (7 `add`, 0 `layer edit`)** |
| Layer ids captured | every Layer, into `ids/` side files | every Layer, into `ids/` | **none** |
| Stack placement | add order / full `reorder` | add order | `--position before:<use>` slips each bar behind its word |

Around the seven Layer commands the script runs `project init`,
`composition create`, `render`, `measure`, and one `layer inspect t2/wm`.

## The pixel wordmark is editable text

The first run generated the pixel-CLAUDE wordmark as an image (job
`g2-pixelclaude`) and matted it (`m-claude`), so it could no longer be
retyped. Here it is one text Layer:

```bash
ply composition add t2 wm --text "CLAUDE" --font-file fonts/PressStart2P-Regular.ttf \
  --font-size 102 --color "#d97757" --outline "4,#d97757" \
  --anchor left,top --x 89 --y 66 --shadow "8,8,0,#5a2a1c"
```

`measure` reports it as `font "Press Start 2P" (caller-supplied)`; the
font bytes are retained in the Project, so the render replays without the
file. The same-colour outline thickens the face toward the reference's
heavy strokes and the blur-0 shadow is its dark drop edge. It is a
different face from the reference's bespoke block lettering — shorter, with
no tile seams — which is an authoring difference, not a ply gap: changing
the word is now `ply layer edit t2/wm --text "..."`.

t2's remaining gap is unchanged from `docs/qualification/207`: the
perspective-grid background is still an imported bitmap.

## The nine-pair sheet

Built inside ply by the same script's last step, replacing the first
run's ImageMagick `montage` (`final/comparison.jpg`): one
`ply composition sheet <ref1> <result1> … <ref9> <result9> --pair` with a
`--label` per cell. Pair 2's result is this rebuild's render; the other
eight are the first run's finals.

Output: 18 inputs, a 2×9 grid of 512 px cells, 1048×4940 PNG; no Render
manifest and nothing added to Render history. Reviewing the sheet is
Kenny's step (#235); this ticket does not close ISC-43.

## Command contract verification

Each command spec #226 introduced or changed was run by hand against a
scratch Project at this commit (behaviour is asserted by the sibling
tickets' suites; this is the US-007 surface check):

| Command | Compact text | `--json` valid | Refusal checked (exit) |
| --- | --- | --- | --- |
| `composition add` with the full option set (`--anchor` + `--shadow`, `--font-file`) | one line | yes | — |
| `composition add --position before:<use>` | one line | yes, success and error | unknown use lists the Composition's uses (1) |
| `composition add --font-file` | one line | yes | non-font file (1); static face weight 700 names the file's weight (1) |
| `composition add --scale` with `--resize` | — | — | mutual exclusion names both forms (2) |
| `layer edit <comp>/<use> --scale` | one line; second run gives the same revision | yes | unknown use / unknown Composition list what exists (1); shared Layer still demands `--in-place` or `--fork` (1) |
| `layer edit <comp>/<use> --fork` | one line, no `--composition`/`--use` needed | — | — |
| `layer inspect <comp>/<use>` | compact | yes | — |
| `composition import --position bottom` | one line | — | — |
| `composition sheet` / `--pair` | one line naming the grid and output | yes, success and error | odd `--pair` count, `--pair` + `--columns`, bad `--label` index, non-integer `--cell` (2); missing input (1) |

One defect was found and fixed here: a missing file path given to
`composition sheet` was refused only as a Composition name with invalid
characters. It now says the input is neither an existing local file nor a
Composition (4.37.1).

The rewritten `ply-operating` skill (AP kit Workspace source,
kenneth-liao/agent-profile-workspace#31): all 43 offline examples were
extracted and run as written, in order, in a clean sandbox — 43 pass. The 7
`ply generate` / `--from-generation` examples need the network and were
not run.
