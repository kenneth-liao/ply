# Ply

Canonical vocabulary and cross-cutting invariants for the accepted general-purpose
composer destination. Project-scoped sharing and retained Render history have
shipped, as have uniform source-image generation with caller-owned content policy
and independently invoked local Matting; caller-parameterized region checking
has shipped for Compositions (`ply composition check`), as have its guideline
overlay view (`ply composition guidelines`) and the starter region-file
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

**Fill**:
How a shape Layer's region is painted: one discriminated value — a solid
colour, a linear gradient, or a radial gradient. The fill is normalized once
at ingestion and stored as part of the Layer's revision, so the same
representation can paint other content kinds later. Colours accept alpha.
_Avoid_: baked backgrounds, drawn-in-advance helper images

**Visible region**:
The rectangular part of a Layer's own content that is ink, set and removed
as a Layer revision fact without touching the retained file, with an
optional corner radius on the same fact. Content outside
the region is not ink: painting, measurement, anchored placement, and the
effects' edge all follow it, while the placement point and transform origin
stay defined against the full content box.
_Avoid_: cropping the file, baking the crop

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
