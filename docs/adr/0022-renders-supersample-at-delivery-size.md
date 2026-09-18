# ADR-0022: Renders supersample at delivery size, 2× by default

- Status: Accepted — decided in triage of
  [#184](https://github.com/kenneth-liao/ply/issues/184).

## Decision

`ply composition render` paints the Composition at an integer **supersample
factor** of device pixels per canvas pixel, then area-averages each N×N block
back to exactly the canvas size. The factor is a render-quality setting, not
Composition geometry: canvas, placement, font sizes, measurement, anchors,
guidelines, and region checks all stay in canvas pixels. The default factor is
2. `--supersample <n>` overrides it, and `--supersample 1` paints directly.

The Render manifest records the factor. `replay` repaints at the recorded
factor, so it reproduces the delivered bytes. Manifests written before #184
record no factor and replay at 1.

## Why

Chromium boosts the contrast of text edges when it rasterizes glyphs at their
final size, so the edge coverage ramps unevenly and large display type
stair-steps. Painting at 2× and box-averaging gives even ramps. A test in
`ai-launchpad-content` (`youtube/groundline-ply-demo/`) showed 2× clean and 4×
no better. Lanczos resampling added halos; area averaging did not.

## Considered options

- **Author at 2× the canvas and downscale the output** (the request as filed):
  rejected. Every font size, position, region file, and ground must be
  authored at double size, and 1× and 2× versions of one visual become
  different Compositions.
- **Store the factor on the Composition:** rejected. It makes the setting
  part of the shared document, and a per-render override would give it a
  second home. A default of 2 already stops a forgotten setting from shipping
  jagged type.
- **Default of 1 (opt-in):** rejected. Every caller would have to remember
  the flag to get the better output.

## Consequences

- The render pixel limits apply to the supersampled paint. A canvas that
  fits at 1× but not at the requested factor is refused loudly, never
  silently painted at a lower factor. Outlines whose raster dilation exceeds
  Chromium's 256-raster-px `feMorphology` kernel cap are rendered via chained
  dilate steps (#194, ADR-0019) rather than refused. Note (#193): outline width
  is in the Layer's local pixels (ADR-0019), painted before the transform, so
  the true raster dilation is
  `outline.width × max(|scaleX|, |scaleY|) × supersample`; rotation and flip do
  not change it.
- Default renders differ from renders made before #184, and they take
  longer. Their pinned history replays unchanged.
- Recording the output file's hash in the manifest is a separate question
  and is not part of this decision.
