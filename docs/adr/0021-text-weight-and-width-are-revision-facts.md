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
- **Static font** (every face bundled before #179, and IBM Plex Mono 500): the
  bytes already fix the look. `weight` accepts only the face's own weight,
  `width` is refused, and the revision stores neither.

So each look has exactly one representation: the stored fields are present if
and only if the retained font is variable. The revision hash includes the
fields only when present, so revisions written before #179 keep their ids and
paint meaning (the ADR-0016/0019 compatibility pattern). Paint and measurement
both read the stored axes from the revision alone, so they cannot disagree.

Changing `--font` on an edit keeps the current weight and width when the new
font supports them. Otherwise the edit is refused and names what the new font
allows. Nothing changes silently.

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

## Consequences

- Bundled variable fonts ship as the exact upstream bytes, not latin subsets,
  so Ply renders byte-identical type to the brand source.
- Tracking and line height are not part of this decision. They are separate
  text Layer controls.
