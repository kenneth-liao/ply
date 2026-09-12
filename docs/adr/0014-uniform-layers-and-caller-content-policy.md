# ADR-0014: Uniform Layers with caller-owned content policy

- Status: Accepted — uniform generation with caller-owned content policy is
  shipped ([spec #102](https://github.com/kenneth-liao/ply/issues/102)), including
  the #114 retirement of the category-specific generation entry points. Still
  target: named Variant sets and the legacy approval/trial-output markers leave
  the schema, and caller-parameterized region checking replaces the hardcoded
  region scope (ADR-0015).
- Supersedes: ADR-0001, ADR-0004, ADR-0008, ADR-0011

Ply is a general-purpose image composer over one Layer primitive, not a
thumbnail-specific asset pipeline. Generation produces source image content
through one command, with full-canvas or isolated output requested as a
parameter rather than a subject taxonomy. Final composition remains local and
deterministic; where text pixels come from is the caller's decision.

## Trade-off

The previous policies protected useful practices: exact locally rendered copy,
sourced official marks, and reviewed likenesses. But intent inference rejects
valid requests, such as fictional logos or decorative text. Those judgments
belong to caller skills, not generation validation. The tool will no longer
require identity references, approval states, or bans on text and logo subjects.
Local text rendering, fonts, transforms, and effects remain available.

Independent control requires separate Layers. Reusing a Composition must
preserve its individually editable Layers (ADR-0013); this does not imply that
the contents of a generated raster image are themselves editable Layers.
There is no owned asset catalog or subject taxonomy. Reusable libraries are
caller-organized; promotion is explicit. Named variant sets leave the schema:
separate Composition files express variation.

## Preserved knowledge and rollout

A color blend cannot change garment geometry, pose, or expression. Such changes
need new image content, but no creator-specific generation or approval pipeline
is prescribed. Masks are deferred, not declared invalid compositing machinery.
The local matting boundary is recorded separately in ADR-0015.

The `visual-authoring` skill owns the relocated identity-anchor prompting,
editorial-versus-decorative text guidance, safe-region authoring guidance, and
likeness review practice. It must land in an earlier commit than gate deletion
(ISC-27). This decision changes the destination, not today's runtime behavior.

Removing enforced approval also removes its trial-output markers and experimental
render flags when that gate is migrated. If unattended publishing is introduced,
its authorization and review policy must be decided by that publishing workflow;
Ply does not acquire a publishing responsibility.
