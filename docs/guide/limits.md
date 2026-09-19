# Limits and render quality

Every size, quality, and refusal limit a caller can hit on the composer
surface, in one place. The README's feature sections describe each option's
shape; this page gives the concrete rule, an example, and the fix. Every
number below is a constant in `src/` at the time of writing.

## Canvas size vs supersample factor

`ply composition render` paints at **canvas × factor** device pixels per
axis, then averages the paint back to exactly the canvas size (default
factor 2; `--supersample <n>` takes any integer ≥ 1, and 1 paints
directly). The supersampled paint must fit the PNG reader's safety bounds
(`src/png.ts`):

- **8192 px per axis** (`MAX_DIMENSION`)
- **16,777,216 px total** (`MAX_PIXELS`)

These are Ply's own decoder bounds — enforced on every raster Ply parses,
including the screenshots of its own paint — not a Chromium limit.
`composition create` accepts any positive-integer canvas; the caps bind
when a render or replay paints:

| Canvas    | 1× | 2× (default) | 4× |
|-----------|----|--------------|----|
| 1280×720  | ✓  | ✓            | ✓  |
| 1920×1080 | ✓  | ✓            | —  |
| 2560×1440 | ✓  | ✓            | —  |
| 3840×2160 | ✓  | —            | —  |
| 5120×2880 | ✓  | —            | —  |

The general rule for any factor f: a w×h canvas renders iff
**w·f ≤ 8192**, **h·f ≤ 8192**, and **w·h·f² ≤ 16,777,216**.

**Rule of thumb for the default 2×:** each canvas side ≤ 4096 px and the
canvas area ≤ 4,194,304 px.

**Example.** A 5120×2880 canvas at the default factor paints 10240×5760
device pixels — over the per-axis bound, so the command exits 1:

```
$ ply composition render big -p proj
Error: Composition "big" is 5120×2880 canvas pixels; supersample 2 paints
10240×5760 device pixels — over the 8192px per-axis render limit.
Render with --supersample 1 or a smaller factor.
```

**Fix:** render with `--supersample 1` or a smaller factor. An over-limit
factor is always refused — never silently painted at a lower factor.

The same decoder bounds apply to source images at ingestion (`--image`):
a PNG over 8192 px per axis or 16,777,216 px is refused with the budget
named, and an encoded file over 64 MB (`MAX_ENCODED_BYTES`) is never
parsed.

## Outlines

`--outline "<width>,<color>"` sets an absolute outline (`--outline none`
removes it). `width` is a px thickness **between 0 and 256 in the Layer's
own local px** (`MAX_OUTLINE_WIDTH_PX`) — the one input bound, checked at
the command boundary (exit 2).

The outline paints in the Layer's local space, before the transform, so
the visible ring on canvas is **width × the Layer's scale** — an outline
of 4 on a Layer scaled 2× reads 8 px wide. Rotation and flip do not
change it.

Chromium caps one `feMorphology` dilate kernel at **256 raster px**
(`MAX_OUTLINE_DILATE_PX`). The raster dilation is
`width × max(|scaleX|, |scaleY|) × supersample`; when it exceeds the cap,
Ply draws the ring as `n = ceil(dilation / 256)` chained dilate steps
whose local radii sum to exactly `width` (ADR-0019, #194). There is no
outline or factor refusal — the full ring draws at any renderable scale
and factor, and `measure`'s painted extents agree with it.

**Cost.** Chained steps paint one full morphology pass each over the
device raster, so paint time grows with steps × raster size. On one
machine (#194), a 600×600 canvas with a 200 px outline at scale 1 took
about 0.4 s at n = 1, about 1.8 s at n = 2, and about 30 s at n = 4 —
treat the figures as order-of-magnitude, not a guarantee. The screenshot
pass has a 60 s timeout, so a very wide outline on a large canvas at a
high factor can hit it.

**Fix:** if a chained outline paints too slowly or times out, use a
thinner outline, a smaller Layer scale, or `--supersample 1` — a refused
or timed-out render publishes nothing and never mutates live state, so
retrying is safe (see [Exit codes](#exit-codes)).

## What `measure` reports

`ply composition measure` reports each Layer's untransformed content box,
transformed box and corners, painted-ink extents (the alpha > 0 bounding
box, effects included), on-canvas footprint, and `clipped` — in
Composition coordinates, measured on the same markup and font bytes
rendering uses. The full contract is in the README's
[Layer measurement](../../README.md#layer-measurement-new-surface)
section.

Its painted-ink capture is bounded by the same PNG limits — 8192 px per
axis, 16,777,216 px total — with each Layer's window sized from that
Layer's own layout box plus its effect reach. A Layer that cannot fit
(huge scale, huge effects, or both) is refused with an actionable error,
never silently clipped. **Fix:** reduce the transform scale or the effect
extent.

## Small differences of ≤ 1 px

Rendered ink and `measure`'s reported extents can differ by about a
canvas pixel. Only pixel-exact checks — diffing a render against a
reported painted box, or machine-comparing two renders — need to care:

- **Text ink** can sit up to 1 px inside the painted extents `measure`
  reports, on each edge. `measure` never under-reports ink.
- **Image Layers** can show a faint, partly transparent edge up to
  1 canvas px beyond their reported footprint: resampling interpolation
  bleeds alpha past the geometric ink boundary, and that bleed is
  genuinely painted (a `--supersample 1` render is exact).

## Font switches — weight and width

A `--font` edit keeps the Layer's current weight and width when the new
font supports them. A **variable** face (bundled: Archivo, `wght` 100–900
default 400, `wdth` 62–125 default 100) accepts any value inside its real
axis ranges, and the revision stores the resolved pair. A **static** face
accepts only its own weight and its implicit width 100
(`STATIC_FACE_WIDTH`) — or omission — and the revision stores no axis
fields.

Ply refuses an unsupported value instead of faking it because it never
synthesizes a look the font's bytes do not contain (ADR-0021): a
simulated weight or a stretched width would paint glyphs no stored
revision could reproduce, so the edit is refused loudly, naming the
family and what it allows.

**The one-edit route.** A variable-font Layer at non-default axes
switches to a static face in a single edit — explicit `--weight`/`--width`
on the same `--font` edit replace the carried values before validation:

```bash
ply layer edit <layerId> --font "IBM Plex Mono" --weight 500 --width 100
```

Without them, a carried axis the face cannot express is refused (exit 1),
naming that fix:

```
Error: Font "IBM Plex Mono" is a static face at weight 500 — the current
weight 800 and width 122 cannot be kept; add --weight 500 --width 100.
```

## Exit codes

Every composer command reports its outcome through its exit code:

- **0 — success.** The result is on stdout (text, or `--json` output).
- **1 — the command was valid, but it conflicts with what is already
  stored or failed mid-operation.** Read the message — it names the
  conflict and usually the fix. Examples: an over-limit render (above),
  a carried-axis font refusal, an edit on a Layer referenced by several
  Compositions without `--in-place` or `--fork`.
- **2 — usage error: the command itself is invalid.** Fix the command.
  Examples: `ply composition render poster --supersample 1.5` ("must be
  an integer of at least 1"), `ply layer edit <id> --outline
  "300,#000000"` ("must be a finite number of px between 0 and 256"), an
  unknown command, a missing argument.

A refused command never mutates live state — correcting the input and
retrying is always safe.

---

Other bounded inputs — shadow offsets ±256 px and blur 0–256 px
([Layer shadows](../../README.md#layer-shadows-new-surface)), tracking
−0.5–1 em and line-height 0.5–3
([Text tracking and line height](../../README.md#text-tracking-and-line-height-new-surface)),
font size and resize factor up to 8192
([Layer resize](../../README.md#layer-resize-new-surface)), and text
content up to 2000 characters (`MAX_TEXT_LENGTH`) — are refused before
anything publishes; their option details live in the README feature
sections and `ply layer edit --help`.
