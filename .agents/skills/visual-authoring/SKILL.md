---
name: visual-authoring
description: Compose visual Layers with caller-owned content policy. Use for likeness prompting and review, choosing local versus generated text, official marks, or YouTube safe-region review. These are authoring practices, not Ply content gates.
---

# Visual authoring

Read the consuming project's brand and publishing instructions first. Ply owns
composition machinery; the caller owns content choices and acceptance. These
practices are relocated before the old runtime gates are removed (ISC-24/27).
The current CLI still enforces its legacy gates; this skill does not bypass them.

The tool's operating route — import/generate, optional Matting, Layer
ingestion, measurement and edits, Render and pixel review — lives in the
`ply-operating` skill; use it for how to run the composer and follow this
skill for what the content and its acceptance require.

## Identity-anchor prompting

When likeness matters, prefer an appropriate real source photo before generation.
Choose caller-supplied local identity images and preserve their supplied order.
Describe each attachment by ordinal and intended role, not by machine-local path.

Use explicit instructions: copy the identity anchor's face; do not widen, round,
age, average, or blend it with another reference. Pose references supply gesture
and framing, expression references supply expression, outfit references supply
clothing, and style references supply lighting and visual treatment—not another
person's face. An edit reference is the source to change, with identity preserved.
Do not invent these restrictions for work where the caller does not want likeness.

For a later matte, request a plain, uniform, evenly lit background, clear margins,
and a clean silhouette. Do not request a painted checkerboard: apparent
transparency is not alpha. Invoke local matting and inspect the actual result.

## Editorial versus decorative text and marks

Prefer local text Layers for copy that must be exact, readable, or independently
editable: headlines, labels, numbers, and calls to action. Bundled fonts and local
rendering give deterministic spelling and cheap iteration. Inspect at the final
viewing size, not only at full resolution.

Generated decorative lettering or text-bearing panels are legitimate when the
caller accepts rasterized copy. Explain that changing a word may require new
pixels. If separate control matters, split it into Layers. For dense UI panels,
keep major regions and proportions; remove incidental controls and tiny labels
that do not survive the intended viewing size.

Use authentic source files when an exact official mark is needed, preserving its
provenance and the consuming project's usage requirements. Fictional marks and
decorative logo-like content are not automatically requests for official logos.

## YouTube safe regions

The current implementation's canonical baseline rectangles live in
`src/safe-area.ts` as `PROTECTED_REGIONS`; do not maintain a competing numeric
copy here while they are still authoritative there. During parameterization,
move that data to a caller-owned region file and update this pointer in the same
change. This relocation is separate from removing any policy gate.

The baseline covers the bottom-right duration badge and the full-width watched
progress strip on a 1280×720 canvas. Treat it as conservative authoring guidance,
not a guaranteed platform specification or a preset for arbitrary canvas sizes.
For another size or surface, explicitly choose appropriate caller-supplied regions.

Check painted extents, not merely nominal boxes: rotation, nested transforms,
shadows, blur, borders, strokes, and arrowheads can cross a region. Review which
intersections matter. A background intersection is usually harmless; a covered
headline or face may not be. Inspect a guideline view, but never export its
overlays into the final Render.

## Likeness review

Compare the candidate against the exact identity anchors used for generation,
not substituted or later-edited files. Inspect full images and consistent face
crops, then inspect at the intended small display size. Check face shape,
apparent age, eyes, mouth, expression, and unintended identity blending.

Inspect both the source candidate and the isolated result. Check hair, ears,
fingers, clothing edges, missing regions, halos, and painted background remnants
on contrasting backgrounds. A successful matte does not establish likeness.
A color blend cannot produce new clothing geometry, pose, or expression.

Follow the caller's approval practice before publishing. For AI Launchpad work,
the consuming repository's creator-cutout workflow owns Kenny's approval and
provenance requirements. Do not infer approval from a successful tool operation
or silently promote an unreviewed likeness. Ply itself does not own publishing.
