# Qualification — GPT Image 2.5 Flare and Sunburst (#270)

Real AI Gateway requests, run 2026-09-23 through the production
`ply generate` path, that qualify `openai/gpt-image-2.5-flare` and
`openai/gpt-image-2.5-sunburst`, plus the comparison set for the model
choice in #278. Every cost below is the Gateway's own per-request receipt
(`providerMetadata.gateway.cost`, recorded as `actual-charge`), not a price
table.

- `probe.sh <anchor.jpg> [model...]`: one call per model and call shape.
- `compare.sh <identity-dir>`: the comparison set. Six cases on
  `gpt-image`, `gpt-image-flare`, and `gpt-image-sunburst`, at `low` and
  `high`, with `--count 2`. The prompts, sizes, intents, and References are
  in the script.
- `sheets.sh <identity-dir> <generation-root> <out-dir>`: builds the three
  sheets with `ply composition sheet`. There is one row per case and tier.
  Each row shows the anchor (when the case has one), then two candidates per
  model.
- `general-sheet.png`: the plate and isolated-object sheet.

## Where the likeness evidence lives

This repository is public. The likeness and edit-preservation sheets contain
the identity photos and generated likenesses, so they are committed to the
private `kenneth-liao/ai-launchpad-content` repository at
`assets/creator-cutouts/qualification/ply-270/`. Nothing likeness-related is
committed here. The identity anchors are caller-owned files from that
repository's `assets/creator-cutouts/identity/`:

| Case | Anchor | What changes |
| --- | --- | --- |
| `l1` likeness | `IMG_1536` (shocked) | hands raised, tight framing, low angle |
| `l2` likeness | `IMG_1591` (thinking) | eyes up, three-quarter turn |
| `l3` likeness | `IMG_1509` (smile) | excited grin, pointing right |
| `e1` edit | `IMG_1572` (arms crossed) | only the outfit and background |
| `p1` plate | none | 1536x1024 tech-studio plate |
| `o1` object | none | isolated robot mascot head |

The likeness prompts follow the `visual-authoring` identity-anchor practice.
They name the attachment by ordinal and state its role, and they say: "Keep the face in
attached image 1 exactly; do not widen, round, age, average, or blend it".

Job ids, under the operator's `out/generation/` (not committed):

- Probes: `p270-20260923-153203-<flare|sunburst>-<shape>` and
  `p270-20260923-153320-gpt-image-<shape>`.
- Comparison: `c270-20260923-153550-<case>-<g2|flare|sunburst>-<tier>`, plus
  the rerun `c270-20260923-160000-l3-flare-low`.

## Capability probes (one image per call, 1024x1024; `ref` at 1024x1536)

| Model | Call shape | Outcome | Time (s) | Billed $ |
|---|---|---|---|---|
| `gpt-image` | text | success | 14.3 | 0.005975 |
| `gpt-image` | q-low | success | 12.1 | 0.005975 |
| `gpt-image` | q-medium | success | 39.1 | 0.052775 |
| `gpt-image` | q-high | success | 117.4 | 0.210815 |
| `gpt-image` | ref | success | 16.3 | 0.016611 |
| `gpt-image` | isolated | success | 14.6 | 0.006180 |
| `gpt-image-flare` | text | success | 11.8 | 0.005975 |
| `gpt-image-flare` | q-low | success | 11.1 | 0.005975 |
| `gpt-image-flare` | q-medium | success | 12.1 | 0.013265 |
| `gpt-image-flare` | q-high | success | 22.9 | 0.052775 |
| `gpt-image-flare` | ref | success | 12.8 | 0.016661 |
| `gpt-image-flare` | isolated | success | 12.4 | 0.006180 |
| `gpt-image-sunburst` | text | success | 25.4 | 0.005975 |
| `gpt-image-sunburst` | q-low | success | 13.4 | 0.005975 |
| `gpt-image-sunburst` | q-medium | success | 18.9 | 0.013265 |
| `gpt-image-sunburst` | q-high | success | 40.9 | 0.052775 |
| `gpt-image-sunburst` | ref | success | 17.0 | 0.016661 |
| `gpt-image-sunburst` | isolated | success | 16.0 | 0.006180 |

Every shape succeeded on both new models. The Reference was used: the probe
outputs show the anchor's person. The requested 1024x1536 size was returned.
The tiers are real because their charges differ. So each new key claims
`supportsRef`, `supportedQualities: low/medium/high`, and `sizing: "size"`.
Its rate is the text-only 1024x1024 charge at the provider default
($0.005975, the same as `low`), with `costMeasured: true`. A reference call
bills the Reference as extra input tokens ($0.0167), so `costCoversRefs` is
`false`.

## Comparison set

| Model | Tier | Category | Jobs | Avg s per Job (2 images) | Avg billed $ per image |
|---|---|---|---|---|---|
| `gpt-image` | low | likeness (ref) | 3 | 26.2 | 0.0169 |
| `gpt-image` | low | edit (ref) | 1 | 29.0 | 0.0168 |
| `gpt-image` | low | plate | 1 | 29.1 | 0.0050 |
| `gpt-image` | low | isolated object | 1 | 26.3 | 0.0062 |
| `gpt-image` | high | likeness (ref) | 3 | 154.9 | 0.1768 |
| `gpt-image` | high | edit (ref) | 1 | 163.7 | 0.1767 |
| `gpt-image` | high | plate | 1 | 178.7 | 0.1649 |
| `gpt-image` | high | isolated object | 1 | 207.5 | 0.2110 |
| `gpt-image-flare` | low | likeness (ref) | 3 | 24.6 | 0.0169 |
| `gpt-image-flare` | low | edit (ref) | 1 | 24.1 | 0.0169 |
| `gpt-image-flare` | low | plate | 1 | 23.0 | 0.0050 |
| `gpt-image-flare` | low | isolated object | 1 | 20.5 | 0.0062 |
| `gpt-image-flare` | high | likeness (ref) | 3 | 38.0 | 0.0533 |
| `gpt-image-flare` | high | edit (ref) | 1 | 38.3 | 0.0533 |
| `gpt-image-flare` | high | plate | 1 | 35.3 | 0.0414 |
| `gpt-image-flare` | high | isolated object | 1 | 43.3 | 0.0530 |
| `gpt-image-sunburst` | low | likeness (ref) | 3 | 30.3 | 0.0169 |
| `gpt-image-sunburst` | low | edit (ref) | 1 | 29.3 | 0.0169 |
| `gpt-image-sunburst` | low | plate | 1 | 29.5 | 0.0050 |
| `gpt-image-sunburst` | low | isolated object | 1 | 29.8 | 0.0062 |
| `gpt-image-sunburst` | high | likeness (ref) | 3 | 57.8 | 0.0533 |
| `gpt-image-sunburst` | high | edit (ref) | 1 | 58.0 | 0.0533 |
| `gpt-image-sunburst` | high | plate | 1 | 61.0 | 0.0414 |
| `gpt-image-sunburst` | high | isolated object | 1 | 66.3 | 0.0530 |


Totals: probes $0.50, comparison $3.87. One comparison Job (`l3`, Flare,
`low`) failed locally before any provider call, because the source was edited
during the run. It spent nothing and was rerun with the identical prompt.

## Findings

- Flare and Sunburst bill identically at every tier and call shape.
  Sunburst is slower (about 1.5x at `high`).
- At `low`, all three models bill the same. At `medium` and `high`, both 2.5
  models bill about 4x less than GPT Image 2 ($0.053 against $0.211 at `high`,
  1024x1024). They are also 3-5x faster at `high`.
- GPT Image 2's text-only charge at the default tier is now $0.005975. The
  registry's older measured rate is $0.0045. That rate is outside this
  ticket's scope and is recorded here only.
- Neither model needed a new parameter or call shape.

Judging likeness and output quality belongs to #278.
