# ADR-0021: Text weight and width are revision facts, chosen by control

- Status: Accepted — decided in triage of
  [#179](https://github.com/kenneth-liao/ply/issues/179).

## Decision

A text Layer selects its look with **controls**, as in a design app: a bundled
family plus an optional `weight` and `width`. Ply validates each value against
the axis ranges the bundled font actually contains and refuses anything else,
naming the allowed range. It never synthesizes a weight or width.

- **Variable font** (for example Archivo, `wght` 100–900, `wdth` 62–125): the
  revision always stores the resolved `weight` and `width`. An omitted control
  resolves to the font's default instance (Archivo: 400 / 100).
  - That default is the resolution this decision pins for omitted controls
    (per the #179 ticket), not the shipped bytes' fvar default instance:
    `Archivo[wdth,wght].ttf` declares fvar default `wght` 600. Ply never
    relies on the fvar default — Composition paint emits the stored axes
    explicitly, and the legacy Scene surface maps `font-weight` 400 onto the
    axis — so an omitted control renders as 400 / 100 everywhere.
  - The axis RANGES are the font's own bytes (fvar), the no-synthesis
    boundary, verified by test in #179.
- **Static font** (every face bundled before #179, and IBM Plex Mono 500): the
  bytes already fix the look. `weight` accepts only the face's own weight,
  `width` accepts only the face's implicit width (100) or omission (#196),
  and the revision stores neither.

So each look has exactly one representation: the stored fields are present if
and only if the retained font is variable. The revision hash includes the
fields only when present, so revisions written before #179 keep their ids and
paint meaning (the ADR-0016/0019 compatibility pattern). Paint and measurement
both read the stored axes from the revision alone, so they cannot disagree.

Changing `--font` on an edit keeps the current weight and width when the new
font supports them. Explicit `weight`/`width` controls on the same edit
replace the carried values before validation (#196); otherwise a carried
value the new font cannot express is refused, naming the one-command fix.
Nothing changes silently.

## Why the axes are stored when the family is not

A text revision identifies its font by the retained bytes alone (#81). That is
enough for a static font, where one file is one look. A variable font is one
file with many looks: Groundline display (`wdth` 122, `wght` 800) and text
(`wdth` 100, `wght` 400) share the same bytes. Without stored axes, a Render
could not be reproduced from its manifest.

## Considered options

- **Named faces** (registry entries such as `Archivo Display` = 122 / 800):
  rejected. Every new look would need a Ply change, and Groundline alone
  needs three Archivo looks. The revision would still have to store the axes,
  so the presets remove no storage work.

## Amendment — runs carry the same rule per run (#297, spec #285 US-017, ISC-54)

One text Layer can carry **runs** of different colour, weight, or font
("5 HERDR PLUGINS" as one editable Layer). The control model above extends
from the Layer to the run unchanged:

- The Layer-level controls (`--color`, `--weight`, `--width`, `--font`,
  `--font-file`) are the **defaults** every run resolves against. A run
  stores an **override** only for a fact it actually overrides — colour (the
  same solid/gradient grammar), font identity (the run's own retained bytes,
  deduped when equal to the Layer font's), caller font facts, and axes.
  `text` stays the only home of the characters; a run is a boundary plus
  overrides, never a second copy of a Layer fact, and a single-run Layer is
  byte-identical to today's stored revision.
- A run's axes validate against the **run's effective face** — the run's own
  face under a font override, the Layer face otherwise — through the same
  `resolveTextAxes` rules: a variable face stores the resolved pair, a static
  face stores neither (its bytes fix the look), and a run sharing the Layer
  face without explicit axes inherits the Layer axes. No synthesis anywhere:
  `font-synthesis: none` on caller-font runs, and an inherited variation
  setting is cancelled on a static-face run so no axis can reach bytes with
  no such axis.
- **No style is synthesized at run level either.** An italic look comes from
  choosing an italic face (for example an italic caller font file) or from a
  Layer-level transform; there is no italic control and no `font-style`
  synthesis. Per-run size, tracking, and line height are not run facts —
  they are Layer facts that apply across runs.
- Outline and shadow are Layer effects on the composited glyph alpha, so
  they hug every run (including a gradient run) with no new mechanism; wrap
  width, the fit box, and the canonical transform are Layer facts applied
  across runs.

The revision hash appends the runs field only when present (two or more
runs), so revisions written before this amendment keep their exact ids.

## Consequences

- A variable-font Layer switches to a static face in one `layer edit`
  (#196): a static face accepts its implicit width (100) as well as its own
  weight, explicit `--weight`/`--width` on a `--font` edit replace the
  carried axes before validation, and a carried-axis refusal names the
  one-command fix. The revision still stores no axis fields for a static
  face — storage, hashing, revision ids, and pinned replays are unchanged.
- Bundled variable fonts ship as the exact upstream bytes, not latin subsets,
  so Ply renders byte-identical type to the brand source.
- Tracking and line height are not part of this decision. They are separate
  text Layer controls (#187). Unlike a variable font's axes, they are stored only
  when set: an omitted value paints as normal spacing and the font's own line
  height, which has no numeric form.
