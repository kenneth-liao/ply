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

## Vector images (SVG)

An `.svg` source (`--image`, #213) is image-kind content with a vector
format, and obeys the same resource bounds as a raster: the file itself is
capped at 64 MB (`MAX_ENCODED_BYTES`), and its **intrinsic size** — parsed
from the file's own `width`/`height` attributes, or its `viewBox` when those
are missing or percent-based — is subject to the same 8192 px per-axis and
16,777,216 px budgets. A `viewBox` of a million units is refused like an
oversized PNG header.

The intrinsic size is a **refusal, never a guess**: a file that declares
neither usable `width`/`height` nor a `viewBox` is refused before anything
is published, naming the fix —

```
Error: "logo.svg" declares no usable intrinsic size — add width and height
attributes in px to the root <svg> element (or a viewBox) so Ply can place
it, and import again.
```

So are malformed or non-SVG bytes with an `.svg` name (not an SVG document,
or a file the browser's image decode refuses as malformed XML). The parse
mirrors the browser's own intrinsic-size computation exactly — both declared
sizes win; one declared size borrows the missing axis from the viewBox's
aspect ratio; neither falls back to the viewBox — so what `inspect`,
`measure`, and the render agree on is one set of numbers.

Rendering rasterizes the vector at the painted size and the supersample
factor (never from a fixed bitmap), so one file is crisp at 60 px and at
600 px; painting it at a large scale costs paint time proportional to the
painted device area, like any Layer at that scale. The retained bytes are
never rewritten; only the render rasterizes.

The vector colour (`--vector-color`, #215) is a paint-time property, not a
file edit: every pixel the vector covers with alpha renders exactly the
requested colour (out = colour × alpha — full replacement, so a
multi-colour vector becomes a single-colour silhouette), and alpha edges
are preserved. The setter refuses on a raster image Layer, a text Layer
(which takes its colour through `--color`), and a shape Layer (whose colour
is its fill, through `--fill`), before anything is published; when the same
edit replaces content, the refusal reads the new content's format. The
colour grammar is the ONE fill-colour grammar (hex `#RGB`/`#RRGGBB`/
`#RRGGBBAA`, alpha allowed) — a gradient is refused naming `--fill`.

**Fix:** a size refusal is an edit to the SVG file (add the attributes), not
a Ply setting — a refused import publishes nothing, so fixing the file and
retrying is safe.

### External references (inertness)

An imported vector is a trust boundary (#214, spec #207 US-006): the same
ingestion point scans the file for references to anything outside itself
and refuses the import, naming each reference and its line —

```
Error: "logo.svg" references resources outside itself — import refused. Found:
  - href on <image> "https://cdn.example/pic.png" (line 3)
  - stylesheet @import "theme.css" (line 7)
The fix: embed each referenced resource as a data URI inside the SVG file,
then import again.
```

The message lists the first 20 distinct references and reports how many
more were found; a pathological file whose distinct references pass the
scan's collection bound reports that bound instead of an unbounded message.
The fix is the same for every reference: embed it as a data URI. One named
target is shown up to 200 characters, long enough to identify the resource.

What is refused, and where it hides:

- **Images** — `href` and `xlink:href` (either spelling, any case, any
  whitespace around `=`), including local paths (`photo.png`, `/etc/motd`,
  `file://…`) and foreignObject HTML (`<img src>`, `<iframe src>`,
  `<object data>`). Every attribute value is judged: a `url(…)` occurrence
  anywhere — paint servers on `fill`, `stroke`, `filter`, `mask`,
  `clip-path` — is a reference, on any element; `srcset` is judged
  candidate by candidate, so a fragment- or data:-first list cannot
  smuggle a remote candidate.
- **Fonts** — `url(…)` inside an `@font-face` block.
- **Stylesheets** — `<?xml-stylesheet …?>` (a missing href refuses on
  doubt), `<link … href=…>`, `@import`, and any CSS `url()` in a `<style>`
  body or a style-bearing attribute.
- **`use` targets outside the file** — `<use href="icons.svg#dot">`; a
  same-document fragment (`#dot`) is fine.
- **DOCTYPE entity declarations — internal or external.** A conformant XML
  parser expands internal entities, so `<!ENTITY x "<image href='…'/>">`
  used as `&x;` injects markup no text-level scan can judge. The fix:
  remove the entities and write their values inline. The DOCTYPE's own DTD
  identifier is not an entity and does not block import.
- **Malformed structure** — an unterminated comment, CDATA section,
  `<script>`, `<style>`, processing instruction, DOCTYPE, or tag refuses as
  `not a valid SVG document`.

Normalization closes the encoding evasions: values are judged after XML
entity decoding (once, as the parser applies it), CDATA is joined into the
text it represents, and CSS backslash escapes are unescaped — so
`&#104;ttps://…`, `@\69 mport …`, `u\72 l(…)`, and
`@imp<![CDATA[ort …]]>` are all matched as what the CSS tokenizer would
see. A nested `data:image/svg+xml` payload is re-scanned once, so the
inner document's external references refuse by name.

Accepted: embedded `data:` URIs (the fix), same-document `#id` fragments,
and the DOCTYPE's own DTD identifier (the boilerplate design tools emit —
not a rendered resource, never fetched in the browser's image path). Plain
text content mentioning a URL is text, not a reference. A script — a
`<script>` element (inline or `src`), an `on*` handler, a `javascript:`
href — never blocks import and never runs: the vector paints through the
image path, where scripts are disabled by construction. Inertness is proven
at every operation: render, measure, review, and replay of a script-only
SVG issue zero network requests, observed through the render page's request
log.

The scan refuses on doubt: any reference value that is not a fragment,
`data:`, or `javascript:` (mailto, unknown schemes, protocol-relative) is
refused, and an unresolvable custom entity (`&name;` — a malformed document
without a DOCTYPE) is refused because its replacement text is unknowable.

**Fix:** the refusal is an edit to the SVG file — embed each named resource
as a data URI (or remove the DOCTYPE's entity declarations) inside the SVG
— never a Ply setting. A refused import publishes nothing (no Layer, no
retained bytes), so fixing the file and retrying is safe. The gate runs at
import only: retained SVG bytes from before the gate stay in the Project
unchanged and remain inert through the same browser image path.

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

## Caller fonts — limits and refusals

A caller-supplied font file (`--font-file`, #232) follows the same rules
as bundled faces, against the file's own facts:

- **Formats.** TrueType (`.ttf`) and CFF-based OpenType (`.otf`) faces are
  accepted; WOFF, WOFF2, and TrueType collections (`.ttc`) are refused.
- **Axes.** Weight and width validate against the axes the file really
  contains — a variable font's real fvar ranges (a file without a `wdth`
  axis accepts only the implicit width 100), or a static face's own weight
  (its OS/2 `usWeightClass`) and implicit width. An out-of-range value is
  refused naming the file's allowed range, and the file's bytes are
  retained with the Layer — rendering, measure, replay, relocation, and
  cross-Project import never need the original file.
- **Publication gate.** A file that is not a usable font, and a file the
  rendering browser cannot resolve, are refused before anything is
  published — no Layer, no use, no content. The render-time
  family-resolution probe re-verifies every caller font.
- **Exit codes.** An axis error against a caller file is semantic (exit 1):
  the file's real ranges are only known where its bytes are read, like the
  other retained-state refusals. Axis errors against a bundled family
  named with `--font` are usage errors (exit 2), validated at the command
  boundary — the split is deliberate; a refused command never mutates live
  state on either path.
- **No synthesis.** The emitted `@font-face` declares the face's real
  weight/stretch and the text element disables font synthesis, so the
  browser never paints a look the bytes do not contain.

## Comparison sheets — size and input limits

`ply composition sheet` (#233) writes one PNG through the same paint path
renders use, so the render pixel limits bind the **whole sheet**, not each
cell:

- **Sheet size.** A sheet is `columns` square `--cell`-px boxes wide
  (default 2 × 512 px) with a label strip under each row, plus padding and
  gutters. The finished sheet must stay within 8192 px per axis and
  16,777,216 pixels; an over-limit grid is refused naming the computed size
  and the fix (a smaller `--cell`, fewer `--columns`, or fewer inputs).
  `--pair` is always two columns, so a long pair list grows only in height:
  at the default cell nine pairs are 1048×4940.
- **Inputs.** A local image input is capped at 64 MB encoded and at the
  same per-axis and pixel limits as image ingestion; an SVG input passes
  the same inertness gate as an imported vector (above). A Composition
  input is painted at the render default (supersample 2), so a Composition
  that `render` would refuse at 2× is refused here too.
- **Resolution order.** An existing local file wins over a Composition of
  the same name. An input that is neither is refused naming both readings,
  and nothing is written.
- **Exit codes.** A malformed option — a non-integer `--cell`, `--pair`
  with an odd input count or with `--columns`, a `--label` index outside
  the input list — is a usage error (exit 2); a missing, undecodable, or
  over-limit input — or an over-limit sheet — is exit 1.

## Layer grading (brightness, contrast, saturation, warmth)

`ply layer edit` and `ply composition add` accept four tonal and colour grade
controls for image (raster and vector), text, and shape Layers (#219, spec #218 US-001):

- **`--brightness <num>`**: `0` to `5` (neutral `1`). Values `< 1` darken; values `> 1` brighten.
- **`--contrast <num>`**: `0` to `5` (neutral `1`). Values `< 1` reduce contrast; values `> 1` increase contrast.
- **`--saturation <num>`**: `0` to `5` (neutral `1`). Values `< 1` desaturate (`0` is greyscale); values `> 1` oversaturate.
- **`--warmth <num>`**: `-1` to `1` (neutral `0`). Positive values shift toward orange/red; negative values shift toward blue.

Every control is an **absolute setter**: passing the control replaces any
previously set value. Passing the documented neutral value (`1` for brightness,
contrast, saturation; `0` for warmth) removes the stored fact. An omitted
control preserves its current value across edits. A Layer with all controls at
neutral values renders byte-identically to an ungraded Layer.

**Paint order & filter pipeline:** Grade applies offline via the rendering
browser's deterministic CSS filter chain:
`brightness` → `contrast` → `saturate` → `warmth` (via an SVG `feColorMatrix`
with `color-interpolation-filters="sRGB"`).
Grading applies to the Layer's **content only**: outline and shadow keep their
own exact colours, and alpha is untouched everywhere (painted extents, anchored
placement, and clipping remain identical to the ungraded Layer).

## Layer blend modes

`ply layer edit` and `ply composition add` accept `--blend <mode>` for image
(raster and vector), text, and shape Layers (#220, spec #218 US-003):

- **Allowed modes**: `normal`, `multiply`, `screen`, `overlay`, `soft-light`,
  `darken`, `lighten`, `color-dodge` (accepts both `color-dodge` and
  `colour-dodge` spelling; stored canonically as `color-dodge`).
- **Absolute setter & removal**: Passing `--blend <mode>` replaces any existing
  mode. Passing `normal` removes the stored fact (`undefined`), returning the
  Layer to default standard compositing. An omitted `--blend` preserves the
  current mode across edits.
- **Unit of blend**: The whole Layer — content, visible region, grade, edge
  glow, outline, shadow, and opacity — blends as ONE unit against everything
  beneath it (ADR-0024) via CSS `mix-blend-mode` on the Layer's outer wrapper
  element.
- **Transparent-canvas behaviour (DEC-007)**: When blending over transparent
  canvas areas (where no underlying pixels exist), compositing follows the
  browser's standard CSS compositing specification without special-casing:
  the blend mode operates against a transparent backdrop ($rgba(0,0,0,0)$),
  preserving the Layer's content and alpha into the canvas output.
- **Refusals**: Supplying an unknown blend mode is refused before publication
  with exit code 2, listing the allowed set.

## Layer edge glow

`ply layer edit` and `ply composition add` accept `--glow` for image (raster
and vector), text, and shape Layers (#221, spec #218 US-002):

- **Value form**: `"<width>,<softness>,<color>[,<angle>,<strength>]"`, e.g.
  `"14,6,#ff9900"` or `"14,6,#ff990080,45,0.8"`; `none` removes the stored
  fact. An omitted `--glow` preserves the current glow across edits.
- **Width and softness**: each a finite number of px between `0` and `256`.
  Width is how far the glow reaches inward from the alpha edge; softness is
  the feather between the band and the untouched interior.
- **Colour**: the same hex forms the shadow and outline accept (`#RGB`,
  `#RRGGBB`, `#RRGGBBAA`), canonicalized the same way.
- **Direction**: an optional pair — `<angle>` in degrees clockwise from top
  (`-360` to `360`) with `<strength>` between `0` and `1`, always supplied
  together. Without the pair the glow is even all round; strength `0` is the
  even glow and drops the pair. The angle is stored canonically in `[0, 360)`,
  so equivalent spellings (`-360`, `0`, `360` ≡ light from top) publish one
  fact.
- **Not relighting**: the edge glow is a two-dimensional edge effect on the
  Layer's own alpha — a coloured band painted just inside the alpha edge,
  over the graded content, following the visible region's edge (including
  its rounded corners) and transforming with the Layer. It never changes the
  direction or shape of light on the subject; that is generation.
- **Alpha coverage (DEC-005)**: the glow is composited atop the content with
  exactly the content's alpha, so painted extents, anchored placement, and
  `clipped` are unchanged by it.
- **Refusals**: a malformed value — wrong part count, out-of-range width,
  softness, angle, or strength, a non-hex colour, or a lone angle or
  strength — is refused before publication with exit code 2, naming the part
  and its range.

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
font size and resize/scale factor up to 8192
([Layer resize](../../README.md#layer-resize-new-surface)), text
content up to 2000 characters (`MAX_TEXT_LENGTH`), and shape parameters —
size per axis 0–8192 px, corner radius 0 to half the shorter side of the
rectangle, and the solid fill's hex colour grammar
([Shape Layers](../../README.md#shape-layers-new-surface)) — are refused
before anything publishes; their option details live in the README feature
sections and `ply layer edit --help`.
