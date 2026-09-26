# Ply

Canonical vocabulary and cross-cutting invariants for the accepted general-purpose
composer destination. Project-scoped sharing and retained Render history have
shipped, as have uniform source-image generation with caller-owned content policy
and independently invoked local Matting; caller-parameterized region checking
has shipped for Compositions (`ply composition check`), as have its guideline
overlay view (`ply composition guidelines`), the comparison sheet
(`ply composition sheet`, spec #226 US-006), and the starter region-file
relocation (`examples/youtube-regions.json`).
`README.md` documents the current command surface;
`ISA.md` owns destination criteria and progress. Decisions live in `docs/adr/`.

## Language

**Project**:
The caller-owned unit of composition work and the boundary of live Layer
sharing. Reuse across Projects creates independent copies, not live links.
_Avoid_: Workspace

**Composition**:
An ordered list of Layer references defining one visual. Each use has a local
name; multiple Compositions within a Project can reference the same Layer.
_Avoid_: Scene

**Layer**:
An independently editable item with a stable identity, shared as a whole,
including its placement and effects. Later Layers paint over earlier Layers.

**Shape Layer**:
A Layer whose content is a filled geometric region — a rectangle (with an
optional corner radius) or an ellipse — defined entirely by parameters. A
shape Layer stores no image bytes; its parameters are its content. It is a
full Layer kind: it renders, measures, shares, forks, imports, and replays
like any other Layer. A full-canvas background is an ordinary shape Layer
sized to the canvas — there is no separate background concept.

**Unit**:
A Layer whose content is a live reference to another Composition in the same
Project (ADR-0026). The unit's revision stores the inner Composition's name —
never a copy of its contents — so editing the inner Composition updates every
place the unit is used, while each member stays individually editable there
with every existing command. The unit's own transform and adjustment facts
apply to the inner composite as one Layer at paint time; the composite is
never stored. A Composition can never contain itself, directly or
transitively.
_Avoid_: a group primitive, flattening for reuse, per-use overrides, baked
composites

**Fill**:
How a shape Layer's region or a text Layer's glyphs are painted: one
discriminated value — a solid colour, a linear gradient, or a radial gradient.
The fill is normalized once at ingestion and stored as part of the Layer's
revision, so the same representation serves both kinds. Colours accept alpha.
_Avoid_: baked backgrounds, drawn-in-advance helper images

**Visible region**:
The rectangular part of a Layer's own content that is ink, set and removed
as a Layer revision fact without touching the retained file, with an
optional corner radius on the same fact. Content outside
the region is not ink: painting, measurement, anchored placement, and the
effects' edge all follow it, while the placement point and transform origin
stay defined against the full content box.
_Avoid_: cropping the file, baking the crop

**Grade**:
A set of colour and tonal adjustments — brightness, contrast, saturation, and
warmth — applied at paint time to a Layer's content only, without editing its
file or changing its alpha. Each control is an absolute setter stored only when
set; a documented neutral value removes the stored fact. Paint order within the
Layer applies the grade after the visible region and before edge glow, outline,
and shadow (ADR-0024).

**Edge glow**:
A coloured rim of light painted just INSIDE a Layer's alpha edge, over the
graded content — the two-dimensional rim light that makes a cutout read as
lit by its scene. One absolute setter (`--glow`) carries the colour (with
alpha), the width and softness in px, and an optional direction in one of
two mutually exclusive forms: the offset pair (one angle clockwise from top
plus a strength) or the one-sided rim light (`from <angle>,<strength>`,
#301 — the far side's band fades to 1 − strength along the light axis, so
at strength 1 the opposite edge is unlit); `none` removes the stored fact.
The glow follows the visible region's edge, including its rounded corners,
and transforms with the Layer, and it never extends painted extents or
changes alpha coverage. It is a two-dimensional edge effect on the Layer's
own alpha, not relighting: changing the direction or shape of light on a
subject is generation, not a Layer parameter.
_Avoid_: relighting, cast shadows, outer glow, a light model

**Blend mode**:
How a Layer's rendered output blends into the composited image beneath it.
Specified via `--blend <mode>` across a documented set of CSS mix-blend-mode
keywords (normal, multiply, screen, overlay, soft-light, darken, lighten,
color-dodge). The mode is an absolute setter stored on the Layer's revision;
`normal` removes the stored fact. At paint time, the whole Layer — content,
visible region, grade, edge glow, outline, shadow, and opacity — blends as ONE
unit against everything beneath it (ADR-0024). It applies uniformly across image,
text, and shape Layers.
_Avoid_: destructive pixel editing, LUTs, adjustment layers

**Vector**:
An SVG file imported as image-kind content with a recorded vector format
(DEC-007) — not a fourth Layer kind. Its intrinsic size is parsed from the
file's own width/height or viewBox at the one image ingestion point; its
bytes are retained unchanged and never rewritten; and it renders crisply at
any size because the browser rasterizes the vector at the painted size and
supersample factor, through the image path that disables scripts and
external loads by construction. The vector is inert (#214): import refuses
a file referencing anything outside itself (images, fonts, stylesheets,
out-of-file use targets), naming each reference (the message lists the
first 20 and reports any beyond that bound) and the fix (embed as a data
URI); a script never blocks import and never runs. A vector's colour is a
Layer revision fact (#215): one paint-time colour over the vector's own
alpha — an absolute setter, `none` restores the authored colours
byte-identically, and a multi-colour vector becomes a single-colour
silhouette.
_Avoid_: a fourth Layer kind, baked rasterization, a fixed-size bitmap,
rewriting the file to recolour it

**Layer revision**:
An immutable version of a Layer. Editing in place advances the same Layer's
current revision; a fork creates a new Layer identity for the forking Composition.

**Name address**:
A Composition-plus-use form (`<composition>/<use>`) accepted wherever a
Layer id is accepted — edit, inspect, review. It resolves to the
referenced Layer's id once, at the command boundary; unknown names are
refused listing what exists. Layer ids remain valid everywhere.
_Avoid_: storing Layer ids in side files, addressing across Projects

**Caller font**:
A local TrueType/OpenType font file a caller passes (`--font-file`) in
place of a bundled family (#232). Its bytes are retained in the Project by
content identity through the same path bundled faces use, and its own
facts — the family name its tables declare and its real weight/width
ranges — are read once at ingestion and stored with the text revision, so
rendering, measure, replay, relocation, and cross-Project import never
need the original file. Ply validates controls against the file's real
axes and never synthesizes a weight or width; licensing of a caller's
font is the caller's concern.
_Avoid_: font discovery, system fonts, remote fetching, subsetting, a
font library

**Render**:
The image produced locally from a resolved Composition. Its manifest preserves
exact Layer revisions and required content so later edits do not change it.
A Render is always delivered at the canvas size; its supersample factor is
render quality, never Composition geometry (ADR-0022).

**Comparison sheet** (DEC-010):
One labelled PNG grid laid out from an ordered list of inputs — Composition
names (rendered current through the existing render path), retained Render
manifests (painted from their pinned historical inputs exactly as replay
repaints them), and local image files. A review artifact like the guideline
view: no Render manifest, nothing added to Render history, the same
export-target boundary and recorded-output refusals. It is assembled
locally (DEC-007); it offers no differencing, overlays, or HTML output, and
the legacy `scene compare` is untouched.
_Avoid_: contact sheet via external tools, a second rendering authority

**Generation Job**:
An online request that produces image content for a Layer and records the
request, supplied References, output, and generation provenance. It does not
render the final Composition.

**Reference**:
A caller-supplied local image used as generation input. References retain caller
order and content identity; the caller owns their discovery and organization.

**Matting**:
A caller-invoked local operation that isolates image content using alpha.
It is independent of generation and applies to any image.

**Cost basis**:
How a Generation Job's recorded cost was obtained: the provider's own
per-request billing receipt for the run, the model registry's per-image
estimate, an observed account-window delta, or unknown. Ply records no delta —
balance reading is out of scope — but the vocabulary keeps a delta from ever
reading as a receipt. A registry rate is never a charge measured on the
request.

**Mask**:
A Layer revision fact (ADR-0025) naming another Layer **use** of the same
Composition whose alpha clips the Layer's final pixels — after its effects,
before its blend. The mask is an ordinary Layer: it is moved, transformed,
and edited like any other, and the clip follows it. A use serving as a mask
does not paint, and only its content alpha, visible region, placement, and
transform shape the clip (never its opacity, grade, effects, blend, or any
mask of its own). The fact's removal spelling is `:none` — a colon-keyword
form that can never name a use.
_Avoid_: masking the file, baking the clip

## Cross-cutting invariants

- A Layer is the only composition primitive. Anything requiring independent
  control must be a separate Layer, not a content-category exception.
- Composition reuse preserves independently editable Layers; it never requires
  flattening a Composition into an image.
- Live sharing is Project-scoped. In-place edits affect every referring
  Composition; a fork changes only the forking Composition's reference
  (ADR-0013).
- Editing a Layer with multiple referring Compositions requires explicit
  in-place or fork intent and reports the blast radius on refusal. A Layer
  with exactly one referrer needs no flag.
- Layer revisions and their content are immutable. A shipped Render remains
  reproducible after its source Layers change (ADR-0013).
- Final composition is local and deterministic. Generation is the only network
  operation; unresolved content and font fallback fail loudly.
- A text Layer's look is its font — a bundled family or a caller-supplied
  file — plus the weight and width it selects. Ply renders only weights and
  widths the font contains; it never synthesizes one.
- The caller decides what content to generate and where text pixels come from.
  Ply does not infer subject policy or impose likeness approval (ADR-0014).
- Generation References come from the caller. Their identities are derived at
  Job creation and their bytes verified and read once at generation.
- A recorded cost states its own basis. Missing billing metadata never turns a
  historical estimate into a measured charge, and a failed generation makes no
  cost claim at all.
- Matting and region geometry remain local correctness machinery, not
  use-case or subject-policy gates (ADR-0015).
