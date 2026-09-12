# ADR-0015: Matting and region checking are caller-invoked local machinery

- Status: Accepted — independent Matting is shipped
  ([spec #102](https://github.com/kenneth-liao/ply/issues/102)). Still target:
  caller-parameterized region checking — the hardcoded YouTube-region scope
  remains in place until that migration.
- Supersedes: ADR-0006; ADR-0005's hardcoded YouTube-region scope

Matting is an explicit local operation on any image, independent of generation
or adoption. Region checking likewise accepts caller-supplied rectangles rather
than embedding YouTube geometry. Removing subject policy must not remove either
correctness mechanism.

Local segmentation remains the isolation mechanism: requesting transparency
from an image model can produce opaque pixels or a painted checkerboard, not
alpha. Keep the pinned BiRefNet Dynamic engine decision (ADR-0020,
which supersedes ADR-0009), local inference,
true-alpha output, and loud failure for missing or mismatched weights. Engine
preflight belongs before the matting operation; generation alone no longer
requires a working matting engine. Existing genuine alpha need not be replaced
by inference. Matting never creates a billed network hop.

Region checking retains the existing conservative painted-footprint geometry,
including transforms, effects, borders, connector strokes, and arrowheads.
As in ADR-0005, intersections are information for the caller, not render bans,
and guideline overlays never enter final output. The caller owns region data
and acceptance decisions. The `visual-authoring` skill records how to use the
current YouTube baseline without treating it as universal platform truth.

This supersedes mandatory generation-stage matting and adoption gates, not the
reason local matting was chosen. Knowledge relocation must land before any gate
is deleted (ISC-27); no runtime gates are removed by this documentation change.
