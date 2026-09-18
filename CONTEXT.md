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

**Layer revision**:
An immutable version of a Layer. Editing in place advances the same Layer's
current revision; a fork creates a new Layer identity for the forking Composition.

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
- A text Layer's look is its bundled font plus the weight and width it
  selects. Ply renders only weights and widths the font contains; it never
  synthesizes one.
- The caller decides what content to generate and where text pixels come from.
  Ply does not infer subject policy or impose likeness approval (ADR-0014).
- Generation References come from the caller. Their identities are derived at
  Job creation and their bytes verified and read once at generation.
- A recorded cost states its own basis. Missing billing metadata never turns a
  historical estimate into a measured charge, and a failed generation makes no
  cost claim at all.
- Matting and region geometry remain local correctness machinery, not
  use-case or subject-policy gates (ADR-0015).
