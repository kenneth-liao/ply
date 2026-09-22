#!/usr/bin/env bun
// Composition management CLI: create, add layers, inspect, and list Compositions.
import { parseArgs } from "node:util";
import path from "node:path";
import {
  createComposition,
  addLayerToComposition,
  addTextLayerToComposition,
  addGeneratedLayerToComposition,
  addMattedLayerToComposition,
  importComposition,
  importCompositionCrossProject,
  removeLayerFromComposition,
  reorderCompositionLayers,
  inspectComposition,
  listCompositions,
  parseStackPosition,
  stackPositionSpec,
  type ResolvedComposition,
  type ResolvedCompositionLayer,
  type StackPosition,
} from "./composition.js";
import { renderComposition, replayRender } from "./composition-render.js";
import {
  COMPOSITION_ADD_OPTION_KEYS,
  COMPOSITION_ADD_OPTION_PARSE_ARGS,
  layerContentKindConflict,
  layerDashNumericFlags,
  parseGenerationJobId,
  parseGenerationOutputSelector,
  parseGenerationOutputValue,
  parseLayerCoordinate,
  parseLayerFontSize,
  parseLayerFontFile,
  parseLayerFill,
  parseLayerLineHeight,
  parseLayerOpacity,
  parseLayerTracking,
  parseLayerWeight,
  parseLayerWidth,
  parseMatteId,
  parseNumericArgument,
  parseShapeCornerRadius,
  parseShapeGeometry,
  parseShapeSize,
  someLayerOptionProvided,
  validateTextFaceAxes,
  validateTextFontSource,
  validateTextTypographyControls,
  SHAPE_CONTENT_KEYS,
  TEXT_CONTENT_KEYS,
  type LayerOptionArgs,
  RESIZE_TO_HELP_KINDS,
  SCALE_HELP_KINDS,
} from "./layer-options.js";
import { parseOneCommandOptionValues } from "./one-command.js";
import { addShapeLayerToComposition } from "./composition.js";
import { formatFill } from "./fill.js";
import { measureCompositionLayers, type MeasuredLayerBounds } from "./composition-measure.js";
import { checkCompositionRegions, type RegionFinding, type RegionRefusal } from "./composition-region-check.js";
import { renderCompositionGuidelines } from "./composition-guidelines.js";
import { renderComparisonSheet, parseLabelOverrides } from "./composition-sheet.js";
import { DEFAULT_SHEET_CELL, DEFAULT_SHEET_COLUMNS } from "./composition-sheet.js";
import { closeCliBrowser } from "./cli-browser.js";
import { helpResult, usageMessage, joinDashLeadingNumericValues } from "./cli-present.js";

const HELP = `
composition — Composition authoring and inspection

  ply composition create <name> --width <w> --height <h> [options]
      Create a new Composition with explicit canvas dimensions

  ply composition add <comp> <name> --image <path> [options]
      Add a local image Layer to a Composition in its final state with one
      command: every placement, transform, effect, and text option 'layer
      edit' accepts for the Layer kind (see the one-command option notes
      below), applied in the documented order and published as exactly one
      Layer revision — or nothing, if any option is refused. The new use
      lands on top by default; --position places it before or after a
      named use, or at the bottom or top of the paint order.

  ply composition add <comp> <name> --text <str> (--font <family> | --font-file <path>) [options]
      Add a locally rendered text Layer. The font's bytes — a bundled
      family's, or a caller-supplied local font file's (#232) — are retained
      into the Project, so rendering never needs the original font files.
      Mutually exclusive with --image.

  ply composition add <comp> <name> --shape rectangle|ellipse --size <W>x<H> --fill <spec> [options]
      Add a shape Layer from parameters alone (#208): a filled rectangle
      (optional --corner-radius) or ellipse, sized in canvas px, painted
      with ONE fill — a solid color (#RGB/#RRGGBB/#RRGGBBAA, alpha
      allowed) or a gradient (#210): "linear:45deg,<stop>,<stop>" or
      "radial:<stop>,<stop>"; a stop is "<color>" or "<color>:<position>"
      (0–100 percent, the % optional; omitted positions interpolate evenly
      between the surrounding explicit positions). No image file is read and
      no image bytes are stored: the
      Layer's content IS its parameters. A full-canvas background is an
      ordinary shape Layer sized to the canvas. Non-positive size, a
      negative or oversized radius, and a malformed fill (a malformed
      colour, fewer than two stops, an out-of-range position) are refused
      before anything is published. On 'layer edit' each shape parameter
      (--shape, --size, --corner-radius, --fill) is an absolute setter
      (#209). Mutually exclusive with --image, --text, --from-generation,
      and --from-matte.

  ply composition import <target> <source> [options]
      Import a Composition's Layer references into another Composition
      within the same Project as individually editable uses. The imported
      set stays contiguous and in source order; --position places it
      before or after a named use of the target, or at the bottom or top
      of the paint order (default: top)

  ply composition import <target> <source> --from-project <dir>
      Copy a Composition's Layers from another Project into the target
      Composition as independent destination Layer identities with retained
      content bytes (source edits never propagate; no live links)

  ply composition remove <comp> <name> [options]
      Remove a Layer use from a Composition without deleting the Layer,
      retained revisions, or other Compositions' uses

  ply composition reorder <comp> --order <name1,name2,...> [options]
      Reorder Layer uses within a Composition to change painting order
      (exact full-order permutation of all existing local use names)

  ply composition inspect <name> [options]
      Inspect a Composition's canvas and ordered Layers

  ply composition measure <comp> [use-name] [options]
      Measure Layer geometry read-only in Composition coordinates, including
      the current scale, rotation, and reflection. Reports each Layer's
      LAYOUT boxes (untransformed content box, the axis-aligned bounding box
      of its transformed content rectangle, and that rectangle's corners)
      and its PAINTED extents: the visible-ink (alpha > 0) bounding box —
      image transparent padding is excluded from painted but kept in
      content, text painted bounds are tight glyph ink rather than the
      line-box extent — plus the painted extent's intersection with the
      canvas and whether painted ink is clipped, judged against painted
      extents, never the layout box (no visible ink reports painted: null).
      A Layer's effects extend its painted ink: painted bounds, the on-canvas
      intersection, and clipped include the effect extent, and the effective
      shadow and outline settings are reported in the effects facts and in
      compact text.
      Painted values are two-decimal rounded: ink is quantized to the
      capture window's pixel grid, while canvas offsets are layout-derived
      and may be fractional. Capture is bounded — one windowed screenshot
      per Layer (never scaled by off-canvas distance), widened by each
      Layer's effect extent, and a Layer whose window — its layout box plus
      effect extent plus pad — exceeds the capture bounds (8192px per axis,
      16,777,216px total) is refused with an actionable error instead of
      growing memory. A refused Layer keeps ok true in --json and sets exit
      status 1. Painted bounds are the browser's own paint of the exact
      markup rendering uses, so
      measurement and rendering agree; opacity scaling
      changes alpha values, never the ink footprint. Text dimensions are measured with
      the Layer's retained font bytes — the same face painting uses, never
      a second measuring authority; corrupt content or an unresolved font
      fails instead of producing misleading numbers. Writes nothing to the
      Project.

  ply composition check <comp> --regions <file> [options]
      Check a Composition's painted Layer extents against caller-supplied
      regions (a caller-owned region file passed by path: rectangles in
      canvas pixels, each with an id, label, and reason — schema documented
      in README). Findings are information, never render failures: every
      visible Layer's painted extent is tested against every region, one
      finding per (layer, region) intersection naming the layer, its
      footprint, and the region. A full-bleed background intersecting
      every region is reported, not a failure; hidden or fully transparent
      Layers paint nothing and report nothing. Footprints are the same
      shared painted extents 'composition measure' reports — never a
      second geometry model — with their conservative over-approximation
      retained. The file's schemaVersion, per-region shape, and its canvas
      (which must match the Composition's canvas) are validated at one
      ingestion point; a malformed file, an out-of-canvas region, a canvas
      mismatch, or a missing Composition fails loudly with a nonzero exit
      status, never a successful-looking empty result. The check is local:
      no network, no inference weights. Writes nothing to the Project.

  ply composition guidelines <comp> --regions <file> [options]
      Render a guideline view: the Composition exactly as 'render' would
      draw it, with the caller-supplied regions (the same caller-owned
      region file 'check' accepts) drawn over the canvas as inspectable
      overlay markup, each region's label and reason visible. A review
      artifact for human acceptance, not a reproducible Render: it writes
      no Render manifest, adds nothing to Render history, and refuses to
      overwrite any output a Render manifest or the Project's renders/
      history records. Destinations resolve through the same export-target
      boundary as render: existing Project state and reserved storage are
      refused. Default output: a fresh, never-colliding file under the
      Project's guidelines/ (review output, not Project state); --out
      accepts any fresh, non-reserved path the render export boundary
      accepts — in-Project or outside — while existing Project state and
      reserved storage are never written over. The overlay is structurally
      excluded from final renders — it exists only on this code path.
      Local only: no network, no inference weights.

  ply composition sheet <input...> [options]
      Build a comparison sheet (#233, spec #226 US-006): lay an ordered list
      of inputs out as ONE labelled PNG grid — a review artifact like the
      guideline view, not a Render: no Render manifest, nothing added to
      Render history, destinations resolved through the same export-target
      boundary (default: a fresh file under the Project's guidelines/).
      Each input is, in one list:
      - a Composition name — rendered current through the existing render
        path (no second rendering authority);
      - a retained Render manifest path (the Project's renders/*.manifest.json)
        — painted from its pinned historical inputs exactly as 'replay'
        repaints them, with the same environment gate;
      - a local image file path — PNG, JPEG, WebP, or SVG.
      An existing local file wins over a Composition name of the same token.
      Labels default to the input's name (the Composition name, the file's
      base name, or the manifest's Composition) and can be overridden with
      --label <1-based index>=<text>. --columns (default 2) and --cell
      (default 512, square) size the grid; mixed aspect ratios are fitted
      inside their cells without distortion. --pair lays the inputs out as
      reference-beside-result rows (an even number of inputs, in
      reference-then-result order). A missing or undecodable input is
      refused naming it, and nothing is written. Local only: no network,
      no inference weights, no model calls.

  ply composition render <name> [options]
      Render a Composition to a PNG at exactly its canvas dimensions,
      supersampled by default (#184, ADR-0022): painted at 2 device pixels
      per canvas pixel, then area-averaged in premultiplied alpha back to
      the canvas size (--supersample <n> overrides; 1 paints directly).
      Composition geometry stays in canvas pixels. A retained Render
      manifest recording the factor is captured under the Project's
      renders/ (default: a fresh file under renders/; --out exports the PNG
      elsewhere, history is always kept in renders/)

  ply composition replay <manifest-path> [options]
      Replay a retained Render manifest: regenerate the Render's pixels
      byte-identically from its pinned historical inputs, independent of
      current Layer revisions and Composition documents. Requires the exact
      rendering environment that captured the manifest (tool, runtime,
      platform, browser); an unsupported environment fails before any output.
      Works after Project relocation, without the original source files, and
      without the original PNG

  ply composition list [options]
      List all Compositions in the Project

Options:
  --project, -p <dir>   Path to Project root (default: current working directory)
  --width <int>         Canvas width in pixels (required for create)
  --height <int>        Canvas height in pixels (required for create)
  --image <path>        Path to a local source image file (required for add
                        unless --text, --shape, or --from-generation is used):
                        a regular local PNG, JPEG, WebP, or SVG file. An SVG
                        is image content with a recorded vector format
                        (#213): its intrinsic size comes from its own
                        width/height attributes or viewBox, its bytes are
                        retained unchanged, and it renders crisply at any
                        size through the browser's image path — scripts
                        never block import and never run, and a file that
                        references anything outside itself (a remote or
                        local image, font, or stylesheet, or an out-of-file
                        use target) is refused naming each reference and
                        the fix (embed the resource as a data URI).
  --from-generation <jobId>
                        Add the selected output of a published Generation Job
                        (see ply generate) as an ordinary image Layer. The
                        job's provenance is retained inside the Project and
                        resolvable offline. Mutually exclusive with --image
                        and --text. The output is selected explicitly with
                        --output; a multi-output job without it is refused.
  --from-matte <matteId>
                        Add the verified output of a published matte (see ply
                        matte) as an ordinary image Layer. The matte's
                        provenance is retained inside the Project and
                        resolvable offline; when the matte's source was a
                        generated output, that job's provenance is retained
                        too. Mutually exclusive with --image, --text, and
                        --from-generation.
  --output <n|sha256>   Which output of the --from-generation job to ingest:
                        a 1-based index or the full sha-256 content identity.
  --text <str>          Text content for a text Layer (mutually exclusive
                        with --image; requires a font — see --font/--font-file)
  --font <family>       Bundled font family name (one font source with --text;
                        e.g. Anton, "Source Sans 3", "Archivo Black")
  --font-file <path>    Path to a local TrueType/OpenType font file for the
                        text Layer (#232): the file's bytes are retained and
                        its own facts (family name, real axis ranges) are
                        stored with the revision, so rendering, measure,
                        replay, and cross-Project import never need the
                        original file. Mutually exclusive with --font. A
                        non-font or unresolvable file is refused before
                        anything publishes.
  --font-size <num>     Font size in px for text Layers (default: 48)
  --tracking <num>      Letter spacing in em for a text Layer (#187,
                        ADR-0021): -0.5 to 1 (0 is stored as absent — the
                        same look as no tracking)
  --line-height <num|normal>
                        Line height as a unitless multiplier of the font
                        size (#187, ADR-0021): 0.5 to 3; "normal" (or
                        omission) uses the font's own line height
  --weight <num>        Text weight for a text Layer (#179, #232):
                        validated against the font's real weight axis —
                        bundled Archivo 100-900 (default 400); static faces
                        accept only their own weight; a caller font file
                        validates against the file's own fvar ranges
  --width <num>         Text width for a text Layer (#179/#196, #232):
                        variable fonts — bundled Archivo 62-125 (default
                        100); static faces and files without a wdth axis
                        accept only the implicit width 100
  --color <hex>         Text color as #RGB or #RRGGBB (default: #ffffff)
  --shape <geometry>    Shape geometry for a shape Layer (#208): rectangle
                        or ellipse. Requires --size and --fill.
  --size <W>x<H>        The shape geometry's width and height in canvas px,
                        e.g. "400x80" — required with --shape
  --corner-radius <px>  Corner radius in px for a rectangle shape (#208):
                        0 to half the shorter side (a larger radius would
                        be silently clamped, so it is refused instead);
                        0 is the same look as absent and is never stored.
                        Not valid on an ellipse.
  --fill <spec>         The shape's ONE fill (#208, #210): a solid color — a
                        hex color like #22c55e, #2c5, or #22c55e80 (alpha
                        allowed), optionally with the explicit "solid:"
                        discriminator prefix — or a gradient: a linear
                        gradient "linear:<angle>deg,<stop>,<stop>" (angle in
                        degrees clockwise from bottom-to-top) or a radial
                        gradient "radial:<stop>,<stop>". A stop is "<color>"
                        or "<color>:<position>" — position 0–100, the %
                        suffix optional, omitted positions interpolating
                        evenly between the surrounding explicit positions.
                        Fewer than two stops, an out-of-range
                        position, or a malformed colour is refused before
                        anything is published. Required with --shape.
  --order <names>       Comma-separated permutation of use names (required for reorder)
  --columns <int>       Sheet grid width in cells (default: 2)
  --cell <px>           Sheet cell size in px — a square content box per cell
                        (default: 512); content is fitted inside without
                        distortion
  --pair                Pairing mode: inputs are reference,result pairs, one
                        pair per row (an even number of inputs, reference
                        immediately before its result); conflicts with
                        --columns
  --label <i>=<text>    Override a sheet cell's label (1-based input index;
                        repeatable), e.g. --label 2="result v2"
  --position <spec>     Where the new use goes in paint order (add, or the
                        imported set for import; #230): "top" (default —
                        appended last, painted on top), "bottom" (painted
                        beneath everything), "before:<use-name>", or
                        "after:<use-name>" naming an existing use of the
                        target Composition. Paint order stays owned by the
                        Composition's ordered use list — the position is a
                        creation-time argument, never a Layer revision
                        fact. An unknown use name is refused before
                        anything is published, listing the Composition's
                        use names.
  --out <path>          Export path for a render or replay; fresh in-Project
                        paths with an existing parent (except reserved storage)
                        or any path outside the Project (existing Project
                        state is never exported over). Render history always
                        stays under the Project's renders/
  --supersample <n>     Render-time supersample factor for render (#184,
                        ADR-0022): integer ≥ 1, default 2 — paint at n device
                        pixels per canvas pixel, area-average back to the
                        canvas size. 1 paints directly (the pre-#184 pixels).
                        The pixel limits apply to the supersampled paint; an
                        over-limit render is refused, never downgraded. Outlines
                        whose raster dilation exceeds Chromium's 256-raster-px
                        cap render via chained dilate steps (#194)
  --x <num>             X position on canvas (default: 0)
  --y <num>             Y position on canvas (default: 0)
  --opacity <num>       Layer opacity between 0 and 1 (default: 1)

One-command creation (#229, US-001): 'composition add' accepts every
placement, transform, region, effect, and text option 'layer edit' accepts
for that Layer kind, with identical spelling, validation, and refusal
texts. The options apply in the documented order — content (and its vector
colour), then transforms, then the visible region, then anchored placement,
then effects — and publish exactly one Layer revision; any refused option
publishes nothing (no Layer, no use, no content). On 'add' the anchor
combination is defined by that order: the anchor resolves the
content+transform+region ink in the target Composition's canvas, and the
effects are then applied to the same single revision. On 'layer edit',
--anchor cannot combine with --shadow/--outline/--vector-color/
--visible-region; --anchor on add still requires explicit --x/--y targets
for the anchored axes, exactly as on 'edit'. The transform, paint, region,
and effect facts are revision facts like on edit: shared, forked, replayed,
and reported by 'measure' exactly as a multi-command Layer's are.

  --anchor <h>[,<v>]    Anchored placement (one-command add): resolve the
                        Layer's visible painted ink against the target
                        position — horizontal left|center|right (anchors
                        --x), vertical top|center|bottom (anchors --y), a
                        pair like "center,center"; a bare "center" is
                        refused. The anchor box is the painted ink box
                        (alpha > 0 / tight glyph ink), never the layout box;
                        a Layer with no visible ink refuses. Resolved
                        against the content+transform ink before the effects
                        apply; an unanchored axis keeps its --x/--y value.
  --resize <factor>     Scale the Layer by a RELATIVE factor (multiplies
                        scale 1 at creation); aspect ratio preserved. For an
                        absolute setter use --scale instead.
  --resize-to <WxH>     Set the effective painted size in px
                        (${RESIZE_TO_HELP_KINDS} — text has no
                        intrinsic pixel size; use --resize).
                        "800x600" changes the aspect ratio;
                        "800x" or "x600" preserves it. Mutually exclusive
                        with --resize.
  --scale <factor>      Set the Layer's scale to an ABSOLUTE factor (uniform,
                        both axes): the same command keeps the same scale,
                        never compounding. Works on
                        ${SCALE_HELP_KINDS}; mutually exclusive
                        with --resize and --resize-to.
  --rotate <deg>        Rotate to an ABSOLUTE angle in degrees, clockwise
                        positive, about the Layer's (x, y) corner.
  --flip <mode>         Flip to an ABSOLUTE reflection state: horizontal,
                        vertical, both, or none.
  --shadow <spec>       Apply a shadow to the Layer's content: an absolute
                        setter "<dx>,<dy>,<blur>,<color>" (e.g.
                        "10,10,4,#000000") or "none". Offsets and blur are
                        px; negative offsets are valid. Paints in the
                        Layer's LOCAL space, mapped by the transform and
                        faded by opacity.
  --outline <spec>      Apply an outline to the Layer's content: an absolute
                        setter "<width>,<color>" (e.g. "4,#000000") or
                        "none". Width is px (0..256). Painted before the
                        shadow, which is cast from the outlined composite.
  --vector-color <hex|none>
                        Paint a vector image Layer's shape in one colour
                        (#215, spec #207 US-005): an absolute setter taking
                        a hex color like #22c55e, #2c5, or #22c55e80 (alpha
                        allowed), or "none". Applied at paint time over the
                        vector's own alpha — every pixel the vector covers
                        with alpha renders exactly the requested colour (a
                        multi-colour vector becomes a single-colour
                        silhouette); alpha edges are preserved and the
                        retained bytes are never rewritten. Defined for
                        vector (format svg) image content only: refused on
                        raster image, text (--color), and shape (--fill)
                        content before anything is published. Applied FIRST
                        in the documented order — content-level paint, before
                        the transforms, the region, and the effects.
  --visible-region <spec>
                        Show only a rectangular part of the Layer's content
                        (#211): an absolute setter "<x>,<y>,<width>,<height>"
                        in the Layer's OWN content pixels, relative to the
                        content box's top-left, or "none". Content outside
                        the region is not ink — painted extents, the
                        anchored placement's ink, and the effects' edge all
                        follow it; a region outside the content or with
                        zero area is refused. Never changes retained
                        pixels. Applied before the anchor resolves, so
                        --anchor centers the region-clipped ink.
  --visible-region-radius <px>
                        Round the visible region's corners (#212): an
                        absolute setter in px — "12" rounds, "0" or "none"
                        removes — obeying the SAME rule as a shape Layer's
                        --corner-radius: over half the region rectangle's
                        shorter side is REFUSED, never clamped, through the
                        same validator; a negative radius is refused. Needs
                        --visible-region in the same add (a fresh Layer has
                        no region to round; 0 and none remove nothing).
                        Corner pixels outside the
                        radius are transparent, and the outline and shadow
                        follow the rounded edge. Applied right after the
                        rectangle, before the anchor resolves.
  --from-project <dir>  Import source: copy Layers from a Composition in
                        another Project (default: same-Project import)
  --json                Emit machine-readable JSON output on stdout
  --help, -h            Show this help message
`;

function output(
  result: { ok: true; [key: string]: unknown } | { ok: false; error: string },
  isJson: boolean,
  textFormatter?: () => void,
) {
  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    if (textFormatter) {
      textFormatter();
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } else {
    console.error(`Error: ${result.error}`);
  }
}

/**
 * Compact one-command facts segment (#229, US-004): the applied transform
 * and effect facts of a one-command add, reported in the same words the
 * edit surface reports them, followed by the resolved anchored placement
 * when an --anchor was supplied. Empty for a plain add, so existing
 * invocations' output is unchanged.
 */
function oneCommandFacts(
  rev: {
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
    rotationDeg: number;
    flipX: boolean;
    flipY: boolean;
    shadow?: { dx: number; dy: number; blur: number; color: string };
    outline?: { width: number; color: string };
    vectorColor?: string;
    visibleRegion?: { x: number; y: number; width: number; height: number; cornerRadius?: number };
  },
  anchorSpec?: string,
): string {
  const facts: string[] = [];
  if (rev.scaleX !== 1 || rev.scaleY !== 1) {
    facts.push(`scale ${rev.scaleX === rev.scaleY ? `${rev.scaleX}×` : `${rev.scaleX}×/${rev.scaleY}×`}`);
  }
  if (rev.rotationDeg !== 0) facts.push(`rotation ${rev.rotationDeg}°`);
  if (rev.flipX || rev.flipY) {
    facts.push(`flip ${rev.flipX && rev.flipY ? "both" : rev.flipX ? "horizontal" : "vertical"}`);
  }
  if (rev.shadow) facts.push(`shadow ${rev.shadow.dx} ${rev.shadow.dy} ${rev.shadow.blur} ${rev.shadow.color}`);
  if (rev.outline) facts.push(`outline ${rev.outline.width} ${rev.outline.color}`);
  if (rev.vectorColor) facts.push(`vector colour ${rev.vectorColor}`);
  if (rev.visibleRegion) {
    facts.push(
      `visible region (${rev.visibleRegion.x}, ${rev.visibleRegion.y}, ${rev.visibleRegion.width}, ${rev.visibleRegion.height})` +
        (rev.visibleRegion.cornerRadius !== undefined ? ` with corner radius ${rev.visibleRegion.cornerRadius}px` : ""),
    );
  }
  if (anchorSpec !== undefined) {
    facts.push(`anchored ${anchorSpec} -> placement (${rev.x}, ${rev.y})`);
  }
  return facts.length > 0 ? `; ${facts.join(", ")}` : "";
}

/** Stack position note (#230, US-002): present only when --position was
 *  supplied, so existing invocations' output is unchanged. */
function stackPositionNote(position?: StackPosition): string {
  return position ? ` (position: ${stackPositionSpec(position)})` : "";
}

// Dash-numeric join (#128): the Layer options this surface accepts (the
// shared definition's dash-numeric subset, DEC-001 — now the full option
// table's keys, #229) plus --supersample (#184).
const rawArgs = joinDashLeadingNumericValues(
  process.argv.slice(2),
  [...layerDashNumericFlags(COMPOSITION_ADD_OPTION_KEYS), "--supersample"],
);
const isJson = rawArgs.includes("--json");
let values: LayerOptionArgs & {
  project?: string;
  height?: string;
  order?: string;
  out?: string;
  "from-project"?: string;
  supersample?: string;
  regions?: string;
  position?: string;
  columns?: string;
  cell?: string;
  pair?: boolean;
  label?: string[] | string;
  json?: boolean;
  help?: boolean;
};
let positionals: string[];

try {
  const parsed = parseArgs({
    args: rawArgs,
    allowPositionals: true,
    options: {
      project: { type: "string", short: "p" },
      height: { type: "string" },
      order: { type: "string" },
      out: { type: "string" },
      "from-project": { type: "string" },
      supersample: { type: "string" },
      regions: { type: "string" },
      // Stack position (#230, US-002, DEC-004): a Composition-level
      // creation-time argument, NOT a Layer option — deliberately outside
      // the shared Layer option table (DEC-001). One grammar reader shared
      // by add and import (composition.parseStackPosition).
      position: { type: "string" },
      // Comparison sheet options (#233, spec #226 US-006): a Composition
      // surface concern, outside the shared Layer option table (DEC-001).
      columns: { type: "string" },
      cell: { type: "string" },
      pair: { type: "boolean", default: false },
      label: { type: "string", multiple: true },
      // The one declaration of the add surface's Layer options (DEC-001):
      // every Layer option this surface accepts, derived from the shared
      // option table (#229) — the same parseArgs entries layer edit spreads
      // for these keys. --width is parsed once for the whole module: on
      // create it is the canvas dimension, on add it is the text width
      // axis (the same spelling layer edit uses, DEC-001) — the shared
      // declaration covers both subcommands, and that is the documented
      // conflation resolved on #229 (no rename, no alias).
      ...COMPOSITION_ADD_OPTION_PARSE_ARGS,
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  values = parsed.values;
  positionals = parsed.positionals;
} catch (err) {
  output({ ok: false, error: usageMessage((err as Error).message, "composition") }, isJson);
  process.exit(2);
}

if (values.help || positionals.length === 0) {
  if (isJson) console.log(JSON.stringify(helpResult(HELP.trim()), null, 2));
  else console.log(HELP);
  process.exit(0);
}

const command = positionals[0]!;
const targetProj = values.project ?? process.cwd();

async function run() {
  let mutationCommitted = false;
  // Exact published outcome for teardown-failure reporting (render only).
  let teardownOutcome: string | undefined;
  try {
    if (command === "create") {
      const name = positionals[1];
      if (!name) {
        output({ ok: false, error: "Usage: ply composition create <name> --width <w> --height <h>" }, isJson);
        process.exitCode = 2;
        return;
      }
      if (!values.width || !values.height) {
        output(
          { ok: false, error: "Explicit canvas dimensions (--width and --height) are required to create a Composition." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }
      const width = parseNumericArgument(values.width);
      const height = parseNumericArgument(values.height);
      if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
        output({ ok: false, error: "Canvas width and height must be positive integers." }, isJson);
        process.exitCode = 2;
        return;
      }

      try {
        const composition = await createComposition(targetProj, name, { width, height });
        mutationCommitted = true;
        output(
          { ok: true, composition },
          isJson,
          () => {
            console.log(`Created Composition "${composition.name}" (${composition.canvas.width}×${composition.canvas.height})`);
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "add") {
      const compName = positionals[1];
      const localName = positionals[2];
      if (!compName || !localName) {
        output({ ok: false, error: "Usage: ply composition add <composition> <local-name> (--image <path> | --text <str> --font <family> | --text <str> --font-file <path> | --shape rectangle|ellipse --size <W>x<H> --fill <spec> | --from-generation <jobId> | --from-matte <matteId>)" }, isJson);
        process.exitCode = 2;
        return;
      }
      // Content-kind exclusivity (#107, #108): one rule from the shared
      // option table (DEC-001), with this surface's established wording.
      const imageConflict = layerContentKindConflict(values, "image", "add");
      if (imageConflict) {
        output({ ok: false, error: imageConflict }, isJson);
        process.exitCode = 2;
        return;
      }
      const generationConflict = layerContentKindConflict(values, "from-generation", "add");
      if (generationConflict) {
        output({ ok: false, error: generationConflict }, isJson);
        process.exitCode = 2;
        return;
      }
      const matteConflict = layerContentKindConflict(values, "from-matte", "add");
      if (matteConflict) {
        output({ ok: false, error: matteConflict }, isJson);
        process.exitCode = 2;
        return;
      }
      const shapeConflict = layerContentKindConflict(values, "shape", "add");
      if (shapeConflict) {
        output({ ok: false, error: shapeConflict }, isJson);
        process.exitCode = 2;
        return;
      }
      const matteId = parseMatteId(values["from-matte"]);
      if (!matteId.ok) {
        output({ ok: false, error: matteId.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const outputSelector = parseGenerationOutputSelector(values.output, values["from-generation"] !== undefined);
      if (!outputSelector.ok) {
        output({ ok: false, error: outputSelector.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const generationJobId = parseGenerationJobId(values["from-generation"]);
      if (!generationJobId.ok) {
        output({ ok: false, error: generationJobId.error }, isJson);
        process.exitCode = 2;
        return;
      }
      if (values.output !== undefined) {
        const outputValue = parseGenerationOutputValue(values.output);
        if (!outputValue.ok) {
          output({ ok: false, error: outputValue.error }, isJson);
          process.exitCode = 2;
          return;
        }
      }
      // The text style options (and the canvas --width value this surface's
      // established checks read as the text width axis) require --text.
      if (values.text === undefined && someLayerOptionProvided(values, TEXT_CONTENT_KEYS.filter((key) => key !== "text"))) {
        output({ ok: false, error: "--font, --font-file, --font-size, --color, --weight, --width, --tracking, and --line-height require --text <str>." }, isJson);
        process.exitCode = 2;
        return;
      }
      // The shape's parameter options require --shape (#208).
      if (values.shape === undefined && someLayerOptionProvided(values, SHAPE_CONTENT_KEYS.filter((key) => key !== "shape"))) {
        output({ ok: false, error: "--size, --corner-radius, and --fill require --shape rectangle or --shape ellipse." }, isJson);
        process.exitCode = 2;
        return;
      }
      if (!values.image && values.text === undefined && values["from-generation"] === undefined && values["from-matte"] === undefined && values.shape === undefined) {
        output({ ok: false, error: "Missing required content: --image <path>, --text <str> (with --font <family> or --font-file <path>), --shape rectangle|ellipse (with --size and --fill), --from-generation <jobId>, or --from-matte <matteId>" }, isJson);
        process.exitCode = 2;
        return;
      }

      // Stack position (#230, spec #226 US-002, DEC-004): grammar is parsed
      // once here through the ONE shared reader; a malformed spec is a usage
      // error (exit 2). The unknown-use refusal is semantic and runs inside
      // the publication path (resolveStackPositionIndex) before anything is
      // published — no Layer, no use, no content.
      let stackPosition: StackPosition | undefined;
      if (values.position !== undefined) {
        try {
          stackPosition = parseStackPosition(values.position);
        } catch (err) {
          output({ ok: false, error: (err as Error).message }, isJson);
          process.exitCode = 2;
          return;
        }
      }

      // Placement shape validation through the shared validators (DEC-001);
      // this surface's established defaults apply when absent.
      const placementX = parseLayerCoordinate("x", values.x);
      if (!placementX.ok) {
        output({ ok: false, error: placementX.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const x = placementX.value ?? 0;
      const placementY = parseLayerCoordinate("y", values.y);
      if (!placementY.ok) {
        output({ ok: false, error: placementY.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const y = placementY.value ?? 0;
      const parsedOpacity = parseLayerOpacity(values.opacity);
      if (!parsedOpacity.ok) {
        output({ ok: false, error: parsedOpacity.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const opacity = parsedOpacity.value ?? 1.0;

      // The post-content options (one-command creation, spec #226
      // US-001/DEC-002): normalized at this boundary through the ONE shared
      // parse (DEC-001) — the SAME shared validators layer edit runs, the
      // resize family's exclusivity rule, and the anchor's explicit-target
      // rule, in this surface's established check order. There is no
      // per-option parse block, presence check, or name mapping here: an
      // option added to the shared definition reaches this surface without
      // any add-side code naming it (A226-002, the probe test pins it). The
      // semantic resolutions — scale bounds and aspect rules, the text-Layer
      // --resize-to refusal, anchored-placement ink resolution, effect
      // canonicalization — apply in the documented order (content, then
      // transforms, then anchored placement, then effects) inside the
      // publication path, before anything is stored, so a refused option
      // publishes nothing.
      // A loud runtime throw (a table option with no parse registration,
      // #263) must still reach the refusal envelope: the boundary parse
      // sits inside the same catch as the publication paths — an internal
      // invariant failure reports {ok:false} and exits 1, never an
      // unhandled rejection.
      let oneCommandParsed: ReturnType<typeof parseOneCommandOptionValues>;
      try {
        oneCommandParsed = parseOneCommandOptionValues(values);
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
        return;
      }
      if (!oneCommandParsed.ok) {
        output({ ok: false, error: oneCommandParsed.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const oneCommand = oneCommandParsed.value;

      try {
        if (values["from-generation"] !== undefined) {
          const res = await addGeneratedLayerToComposition(
            targetProj, compName, localName,
            { jobRoot: path.resolve("out", "generation"), jobId: generationJobId.value!, output: values.output },
            { x, y, opacity, oneCommand, position: stackPosition },
          );
          mutationCommitted = true;
          output(
            { ok: true, composition: res.composition, use: res.use, layer: res.layer, generatedFrom: res.generatedFrom },
            isJson,
            () => {
              const rev = res.layer.currentRevision;
              const detail =
                rev.kind === "text"
                  ? `${JSON.stringify(rev.text)} ${rev.fontSize}px ${rev.color}`
                  : rev.kind === "image"
                    ? `${rev.width}×${rev.height} ${rev.format}`
                    : ""; // unreachable: generation ingestion publishes image or text content only
              console.log(
                `Added Layer "${res.use.name}" (${res.use.layerId}) to Composition "${res.composition}" ` +
                  `[${detail}] from Generation Job ${res.generatedFrom.jobId} ` +
                  `(${res.generatedFrom.contentHash.slice(0, 12)}; provenance retained)${oneCommandFacts(rev, values.anchor)}${stackPositionNote(stackPosition)}`,
              );
            },
          );
          return;
        }
        if (values["from-matte"] !== undefined) {
          const res = await addMattedLayerToComposition(
            targetProj, compName, localName,
            {
              matteRoot: path.resolve("out", "matting"),
              matteId: matteId.value!,
              generationRoot: path.resolve("out", "generation"),
            },
            { x, y, opacity, oneCommand, position: stackPosition },
          );
          mutationCommitted = true;
          output(
            {
              ok: true,
              composition: res.composition,
              use: res.use,
              layer: res.layer,
              mattedFrom: res.mattedFrom,
              ...(res.generatedFrom ? { generatedFrom: res.generatedFrom } : {}),
            },
            isJson,
            () => {
              const rev = res.layer.currentRevision;
              const detail =
                rev.kind === "text"
                  ? `${JSON.stringify(rev.text)} ${rev.fontSize}px ${rev.color}`
                  : rev.kind === "image"
                    ? `${rev.width}×${rev.height} ${rev.format}`
                    : ""; // unreachable: matte ingestion publishes image or text content only
              const generated = res.generatedFrom
                ? `; generation lineage from Generation Job ${res.generatedFrom.jobId} retained`
                : "";
              console.log(
                `Added Layer "${res.use.name}" (${res.use.layerId}) to Composition "${res.composition}" ` +
                  `[${detail}] from matte ${res.mattedFrom.matteId} ` +
                  `(engine ${res.mattedFrom.engine}, ${res.mattedFrom.contentHash.slice(0, 12)}; provenance retained${generated})${oneCommandFacts(rev, values.anchor)}${stackPositionNote(stackPosition)}`,
              );
            },
          );
          return;
        }
        if (values.text !== undefined) {
          if (!values.font && !values["font-file"]) {
            output({ ok: false, error: "Missing required option: a font — --font <family> (bundled) or --font-file <path> (caller-supplied) — is required with --text" }, isJson);
            process.exitCode = 2;
            return;
          }
          // One font source per Layer (#232): --font and --font-file are
          // mutually exclusive — a usage error (exit 2) at the boundary.
          const fontSourceError = validateTextFontSource(values.font, values["font-file"]);
          if (fontSourceError !== undefined) {
            output({ ok: false, error: fontSourceError }, isJson);
            process.exitCode = 2;
            return;
          }
          if (values["font-file"] !== undefined) {
            // A font file's existence and validity are semantic (the
            // ingestion path reads the bytes once and parses them —
            // DEC-006); only the blank-path shape is a usage error here.
            const parsedFontFile = parseLayerFontFile(values["font-file"]);
            if (!parsedFontFile.ok) {
              output({ ok: false, error: parsedFontFile.error }, isJson);
              process.exitCode = 2;
              return;
            }
          }
          // Font size, text axes (#179, ADR-0021), and text typography
          // (#187, ADR-0021): shape and range at the command boundary as a
          // usage error (exit 2) through the SAME shared validators the edit
          // boundary runs (DEC-001), so the two boundaries never disagree;
          // the add path re-resolves against the face before anything
          // publishes. This surface's established font-size default (48)
          // applies when absent.
          const parsedFontSize = parseLayerFontSize(values["font-size"]);
          if (!parsedFontSize.ok) {
            output({ ok: false, error: parsedFontSize.error }, isJson);
            process.exitCode = 2;
            return;
          }
          const fontSize = parsedFontSize.value ?? 48;
          const parsedWeight = parseLayerWeight(values.weight);
          if (!parsedWeight.ok) {
            output({ ok: false, error: parsedWeight.error }, isJson);
            process.exitCode = 2;
            return;
          }
          const weight = parsedWeight.value;
          // The canvas --width value is the established text width axis on
          // this surface (the flag is shared with --width <canvas>).
          const parsedWidth = parseLayerWidth(values.width);
          if (!parsedWidth.ok) {
            output({ ok: false, error: parsedWidth.error }, isJson);
            process.exitCode = 2;
            return;
          }
          const width = parsedWidth.value;
          // An unknown family keeps its established semantic refusal (exit
          // 1, from the add path's resolveFace); only weight/width range
          // errors are usage errors here (exit 2). A caller font file
          // (--font-file, #232) validates its axes semantically in the
          // ingestion path — the file's real axes are only known there.
          const axesError =
            values.font !== undefined
              ? validateTextFaceAxes(values.font!, weight, width)
              : undefined;
          if (axesError !== undefined) {
            output({ ok: false, error: axesError }, isJson);
            process.exitCode = 2;
            return;
          }
          const parsedTracking = parseLayerTracking(values.tracking);
          if (!parsedTracking.ok) {
            output({ ok: false, error: parsedTracking.error }, isJson);
            process.exitCode = 2;
            return;
          }
          const tracking = parsedTracking.value;
          const parsedLineHeight = parseLayerLineHeight(values["line-height"]);
          if (!parsedLineHeight.ok) {
            output({ ok: false, error: parsedLineHeight.error }, isJson);
            process.exitCode = 2;
            return;
          }
          const lineHeight = parsedLineHeight.value;
          const typographyError = validateTextTypographyControls(tracking, lineHeight);
          if (typographyError !== undefined) {
            output({ ok: false, error: typographyError }, isJson);
            process.exitCode = 2;
            return;
          }
          const res = await addTextLayerToComposition(
            targetProj, compName, localName,
            {
              text: values.text,
              ...(values.font !== undefined ? { font: values.font } : {}),
              ...(values["font-file"] !== undefined ? { fontFile: values["font-file"] } : {}),
              color: values.color, weight, width, tracking, lineHeight,
            },
            { x, y, opacity, fontSize, oneCommand, position: stackPosition },
          );
          mutationCommitted = true;
          output(
            { ok: true, composition: res.composition, use: res.use, layer: res.layer },
            isJson,
            () => {
              const rev = res.layer.currentRevision;
              if (rev.kind !== "text") return; // unreachable: text ingestion returns a text revision
              console.log(
                `Added text Layer "${res.use.name}" (${res.use.layerId}) to Composition "${res.composition}" ` +
                  `[${JSON.stringify(rev.text)} ${rev.fontSize}px ${rev.color}]${oneCommandFacts(rev, values.anchor)}${stackPositionNote(stackPosition)}`,
              );
            },
          );
          return;
        }
        if (values.shape !== undefined) {
          // Shape content kind (#208, DEC-009): the geometry's literal set is
          // boundary shape (exit 2); the semantic ranges — positive size, the
          // radius's rectangle rule and range, the fill's color grammar —
          // resolve in the ingestion path BEFORE anything is published (exit
          // 1 on refusal, live state unchanged).
          const parsedShape = parseShapeGeometry(values.shape);
          if (!parsedShape.ok) {
            output({ ok: false, error: parsedShape.error }, isJson);
            process.exitCode = 2;
            return;
          }
          const parsedSize = parseShapeSize(values.size);
          if (!parsedSize.ok) {
            output({ ok: false, error: parsedSize.error }, isJson);
            process.exitCode = 2;
            return;
          }
          if (parsedSize.value === undefined) {
            output({ ok: false, error: "Missing required option: --size <W>x<H> (the geometry's width and height in canvas px) is required with --shape" }, isJson);
            process.exitCode = 2;
            return;
          }
          const parsedRadius = parseShapeCornerRadius(values["corner-radius"]);
          if (!parsedRadius.ok) {
            output({ ok: false, error: parsedRadius.error }, isJson);
            process.exitCode = 2;
            return;
          }
          const parsedFill = parseLayerFill(values.fill);
          if (!parsedFill.ok) {
            output({ ok: false, error: parsedFill.error }, isJson);
            process.exitCode = 2;
            return;
          }
          if (parsedFill.value === undefined) {
            output({ ok: false, error: 'Missing required option: --fill <spec> (a solid color like "#22c55e" or a gradient like "linear:45deg,#ff0000,#00ff00") is required with --shape' }, isJson);
            process.exitCode = 2;
            return;
          }
          const res = await addShapeLayerToComposition(
            targetProj, compName, localName,
            {
              shape: parsedShape.value!,
              width: parsedSize.value.width,
              height: parsedSize.value.height,
              ...(parsedRadius.value !== undefined ? { cornerRadius: parsedRadius.value } : {}),
              fill: parsedFill.value,
            },
            { x, y, opacity, oneCommand, position: stackPosition },
          );
          mutationCommitted = true;
          output(
            { ok: true, composition: res.composition, use: res.use, layer: res.layer },
            isJson,
            () => {
              const rev = res.layer.currentRevision;
              if (rev.kind !== "shape") return; // unreachable: shape ingestion returns a shape revision
              const radius = rev.cornerRadius !== undefined ? `, corner radius ${rev.cornerRadius}px` : "";
              console.log(
                `Added shape Layer "${res.use.name}" (${res.use.layerId}) to Composition "${res.composition}" ` +
                  `[${rev.shape} ${rev.width}×${rev.height}${radius}, ${formatFill(rev.fill)}]${oneCommandFacts(rev, values.anchor)}${stackPositionNote(stackPosition)}`,
              );
            },
          );
          return;
        }

        const res = await addLayerToComposition(targetProj, compName, localName, values.image!, { x, y, opacity, oneCommand, position: stackPosition });
        mutationCommitted = true;
        output(
          { ok: true, composition: res.composition, use: res.use, layer: res.layer },
          isJson,
          () => {
            const rev = res.layer.currentRevision;
            const detail =
              rev.kind === "image"
                ? `${rev.width}×${rev.height} ${rev.format}`
                : ""; // unreachable: the image branch publishes image content only
            console.log(
              `Added Layer "${res.use.name}" (${res.use.layerId}) to Composition "${res.composition}" [${detail}]${oneCommandFacts(rev, values.anchor)}${stackPositionNote(stackPosition)}`,
            );
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "import") {
      const targetComp = positionals[1];
      const sourceComp = positionals[2];
      if (!targetComp || !sourceComp) {
        output({ ok: false, error: "Usage: ply composition import <target> <source>" }, isJson);
        process.exitCode = 2;
        return;
      }

      try {
        // Stack position (#230, spec #226 US-002, DEC-004): the same ONE
        // grammar reader the add boundary runs; the unknown-use refusal is
        // semantic, inside the import path before anything is published.
        let stackPosition: StackPosition | undefined;
        if (values.position !== undefined) {
          try {
            stackPosition = parseStackPosition(values.position);
          } catch (err) {
            output({ ok: false, error: (err as Error).message }, isJson);
            process.exitCode = 2;
            return;
          }
        }
        const fromProject = values["from-project"];
        const res =
          fromProject !== undefined
            ? await importCompositionCrossProject(targetProj, targetComp, sourceComp, fromProject, stackPosition)
            : await importComposition(targetProj, targetComp, sourceComp, stackPosition);
        mutationCommitted = true;
        output(
          {
            ok: true,
            composition: res.composition,
            sourceComposition: res.sourceComposition,
            importedUses: res.importedUses,
            layers: res.layers,
          },
          isJson,
          () => {
            const count = res.importedUses.length;
            const noun = count === 1 ? "Layer" : "Layers";
            console.log(
              `Imported ${count} ${noun} from "${res.sourceComposition}" into Composition "${res.composition}" (total: ${res.layers.length} layers)${stackPositionNote(stackPosition)}`,
            );
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "remove") {
      const compName = positionals[1];
      const localName = positionals[2];
      if (!compName || !localName) {
        output({ ok: false, error: "Usage: ply composition remove <composition> <use-name>" }, isJson);
        process.exitCode = 2;
        return;
      }

      try {
        const res = await removeLayerFromComposition(targetProj, compName, localName);
        mutationCommitted = true;
        output(
          { ok: true, composition: res.composition, removedUse: res.removedUse, layers: res.layers },
          isJson,
          () => {
            console.log(
              `Removed Layer use "${res.removedUse.name}" (${res.removedUse.layerId}) from Composition "${res.composition}" (remaining: ${res.layers.length})`,
            );
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "reorder") {
      const compName = positionals[1];
      if (!compName) {
        output({ ok: false, error: "Usage: ply composition reorder <composition> --order <name1,name2,...>" }, isJson);
        process.exitCode = 2;
        return;
      }
      if (values.order === undefined) {
        output({ ok: false, error: "Missing required option: --order <name1,name2,...>" }, isJson);
        process.exitCode = 2;
        return;
      }

      try {
        const res = await reorderCompositionLayers(targetProj, compName, values.order);
        mutationCommitted = true;
        output(
          { ok: true, composition: res.composition, layers: res.layers },
          isJson,
          () => {
            const names = res.layers.length === 0 ? "(empty)" : res.layers.map((l) => l.name).join(", ");
            console.log(`Reordered Composition "${res.composition}" (order: ${names})`);
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "inspect") {
      const name = positionals[1];
      if (!name) {
        output({ ok: false, error: "Usage: ply composition inspect <name>" }, isJson);
        process.exitCode = 2;
        return;
      }

      try {
        const composition = await inspectComposition(targetProj, name);
        output(
          { ok: true, composition },
          isJson,
          () => {
            console.log(`Composition: ${composition.name} (${composition.canvas.width}×${composition.canvas.height})`);
            console.log(`Layers (${composition.layers.length}):`);
            composition.layers.forEach((layer, idx) => {
              const rev = layer.revision;
              const detail =
                rev.kind === "text"
                  ? `${JSON.stringify(rev.text)} ${rev.fontSize}px ${rev.color}`
                  : rev.kind === "shape"
                    ? `${rev.shape} ${rev.width}×${rev.height} ${formatFill(rev.fill)}`
                    : `${rev.width}×${rev.height} ${rev.format}`;
              console.log(
                `  ${idx + 1}. "${layer.name}" [${layer.layerId}] (${rev.kind}, ${detail}) ` +
                  `@ (${rev.x}, ${rev.y}) opacity: ${rev.opacity}`,
              );
            });
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "measure") {
      const compName = positionals[1];
      const useName = positionals[2];
      if (!compName) {
        output({ ok: false, error: "Usage: ply composition measure <composition> [use-name]" }, isJson);
        process.exitCode = 2;
        return;
      }

      try {
        const result = await measureCompositionLayers(targetProj, compName, useName);
        if (result.layers.some((l) => l.refused !== null)) {
          process.exitCode = 1;
        }
        output(
          { ok: true, composition: result.composition, canvas: result.canvas, layers: result.layers },
          isJson,
          () => {
            console.log(`Measured Composition "${result.composition}" (${result.canvas.width}×${result.canvas.height}), ${result.layers.length} Layer${result.layers.length === 1 ? "" : "s"} (layout boxes + painted extents):`);
            result.layers.forEach((layer, idx) => {
              const t = layer.transform;
              const facts: string[] = [];
              if (layer.effects.shadow) {
                const s = layer.effects.shadow;
                facts.push(`shadow ${s.dx} ${s.dy} ${s.blur} ${s.color}`);
              }
              if (layer.effects.outline) {
                const o = layer.effects.outline;
                facts.push(`outline ${o.width} ${o.color}`);
              }
              // The shape's ONE fill (#208/#210): the canonical fill facts
              // painting applies, reported for auditability.
              if (layer.fill) {
                facts.push(`fill ${formatFill(layer.fill)}`);
              }
              if (layer.axes) {
                facts.push(`weight ${layer.axes.weight}, width ${layer.axes.width}`);
              }
              // Caller font (#232): the font's own family name and that it
              // is caller-supplied — the same facts `layer inspect` reports.
              if (layer.font) {
                facts.push(`font "${layer.font.family}" (caller-supplied)`);
              }
              // Stored text typography (#187, ADR-0021), reported only when
              // set — the facts painting applies.
              if (layer.typography.tracking !== undefined) {
                facts.push(`tracking ${layer.typography.tracking}em`);
              }
              if (layer.typography.lineHeight !== undefined) {
                facts.push(`line height ${layer.typography.lineHeight}`);
              }
              if (t.scaleX !== 1 || t.scaleY !== 1) {
                facts.push(`scale ${t.scaleX === t.scaleY ? `${t.scaleX}×` : `${t.scaleX}×/${t.scaleY}×`}`);
              }
              if (t.rotationDeg !== 0) facts.push(`rot ${t.rotationDeg}°`);
              if (t.flipX || t.flipY) {
                facts.push(`flip ${t.flipX && t.flipY ? "both" : t.flipX ? "horizontal" : "vertical"}`);
              }
              console.log(
                `  ${idx + 1}. "${layer.name}" (${contentLabel(layer)}) box (${layer.box.x}, ${layer.box.y}) ${layer.box.width}×${layer.box.height} ${paintedText(layer)}` +
                  (facts.length > 0 ? ` [${facts.join(", ")}]` : ""),
              );
            });
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "check") {
      const compName = positionals[1];
      if (!compName) {
        output({ ok: false, error: "Usage: ply composition check <composition> --regions <region-file.json>" }, isJson);
        process.exitCode = 2;
        return;
      }
      if (values.regions === undefined || !values.regions.trim()) {
        output({ ok: false, error: "Missing required option: --regions <region-file.json> (a caller-owned region file passed by path)" }, isJson);
        process.exitCode = 2;
        return;
      }

      try {
        const result = await checkCompositionRegions(targetProj, compName, path.resolve(values.regions.trim()));
        // Findings are information, never render failures (ADR-0005): the
        // check completes with exit 0 regardless of findings, unless a Layer
        // was refused measurement (#206).
        if (result.refused.length > 0) {
          process.exitCode = 1;
        }
        output(
          {
            ok: true,
            composition: result.composition,
            canvas: result.canvas,
            regionFile: result.regionFile,
            regionCount: result.regionCount,
            findings: result.findings,
            refused: result.refused,
          },
          isJson,
          () => {
            const n = result.findings.length;
            const regions = result.regionCount === 1 ? "1 caller-supplied region" : `${result.regionCount} caller-supplied regions`;
            console.log(
              `Checked Composition "${result.composition}" (${result.canvas.width}×${result.canvas.height}) against ${regions} — ` +
                (n === 0 ? "no findings." : `${n} finding(s) (information, never render failures):`),
            );
            result.findings.forEach((f: RegionFinding, i: number) => {
              const r = f.region.box;
              console.log(
                `  ${i + 1}. layer "${f.layer}" (painted (${f.footprint.x}, ${f.footprint.y}) ${f.footprint.width}×${f.footprint.height}) ` +
                  `intersects region "${f.region.id}" (x ${r.x}–${r.x + r.width}, y ${r.y}–${r.y + r.height}) — ` +
                  `${f.region.label}: ${f.region.reason} — move, resize, or accept the overlap`,
              );
            });
            if (result.refused.length > 0) {
              const refCount = result.refused.length;
              console.log(
                `\n${refCount} Layer${refCount === 1 ? "" : "s"} refused measurement (footprint unverified):`,
              );
              result.refused.forEach((rf: RegionRefusal, i: number) => {
                console.log(`  ${i + 1}. Layer "${rf.layer}" (${rf.layerId}): ${rf.message}`);
              });
            }
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "guidelines") {
      const compName = positionals[1];
      if (!compName) {
        emitRender({ ok: false, error: "Usage: ply composition guidelines <comp> --regions <region-file.json> [--out <path>]" }, isJson);
        process.exitCode = 2;
        return;
      }
      if (values.regions === undefined || !values.regions.trim()) {
        emitRender({ ok: false, error: "Missing required option: --regions <region-file.json> (a caller-owned region file passed by path)" }, isJson);
        process.exitCode = 2;
        return;
      }
      try {
        const view = await renderCompositionGuidelines(targetProj, compName, path.resolve(values.regions.trim()), { out: values.out });
        // The output is on disk before the browser teardown runs; if teardown
        // fails, the caller must hear exactly that.
        teardownOutcome = `The guideline PNG was already written to ${view.output}. Do not re-render to recover it.`;
        emitRender(
          { ok: true, ...view },
          isJson,
          () => {
            const n = view.regionCount === 1 ? "1 caller-supplied region" : `${view.regionCount} caller-supplied regions`;
            console.log(
              `Guideline view for Composition "${view.composition}" (${view.canvas.width}×${view.canvas.height}) with ${n} → ${view.output} ` +
                `(review artifact; no Render manifest)`,
            );
          },
        );
      } catch (err) {
        teardownOutcome = "No guideline PNG was written.";
        emitRender({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "sheet") {
      const inputs = positionals.slice(1);
      if (inputs.length === 0) {
        output(
          { ok: false, error: "Usage: ply composition sheet <input...> [--columns <n>] [--cell <px>] [--pair] [--label <i>=<text>] [--out <path>] — each input is a Composition name, a retained Render manifest path, or a local image file path" },
          isJson,
        );
        process.exitCode = 2;
        return;
      }
      // Value-shaped sheet options (#233): usage errors, like every
      // value-range option. --label syntax and --pair's input-count
      // contract are shaped here too, so a malformed caller argument
      // exits 2; the module re-runs the same parses as its API fail-fast.
      let columns: number | undefined;
      let cellSize: number | undefined;
      if (values.columns !== undefined) {
        columns = parseNumericArgument(values.columns);
        if (!Number.isInteger(columns) || columns < 1) {
          output({ ok: false, error: "--columns must be an integer of at least 1." }, isJson);
          process.exitCode = 2;
          return;
        }
      }
      if (values.cell !== undefined) {
        cellSize = parseNumericArgument(values.cell);
        if (!Number.isInteger(cellSize) || cellSize < 1) {
          output({ ok: false, error: "--cell must be an integer of at least 1." }, isJson);
          process.exitCode = 2;
          return;
        }
      }
      if (values.pair && values.columns !== undefined) {
        output(
          { ok: false, error: "--pair defines the layout itself (one reference beside one result per row); it cannot be combined with --columns." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }
      const labelSpecs = values.label === undefined ? [] : Array.isArray(values.label) ? values.label : [values.label];
      try {
        parseLabelOverrides(labelSpecs, inputs.length);
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 2;
        return;
      }
      // Pairing's input-count contract is shaped here too (review INT-2/
      // PROD-2, PR #255): both --pair refusals are caller-shape errors and
      // exit 2 at the CLI; the module keeps the same check as its API
      // fail-fast.
      if (values.pair && inputs.length % 2 !== 0) {
        output(
          {
            ok: false,
            error: `Pairing mode needs an even number of inputs laid as reference-beside-result rows, but ${inputs.length} inputs were given. Reorder the list so each reference is immediately followed by its result, and drop or add one input.`,
          },
          isJson,
        );
        process.exitCode = 2;
        return;
      }
      try {
        const sheet = await renderComparisonSheet(targetProj, inputs, {
          out: values.out,
          columns,
          cell: cellSize,
          pair: values.pair,
          labels: labelSpecs,
        });
        teardownOutcome = `The comparison sheet PNG was already written to ${sheet.output}. Do not re-render to recover it.`;
        emitRender(
          { ok: true, ...sheet },
          isJson,
          () => {
            const rows = Math.ceil(inputs.length / sheet.columns);
            console.log(
              `Comparison sheet: ${inputs.length} input(s), ${sheet.columns}×${rows} grid of ${sheet.cell}px cells → ${sheet.output} ` +
                `(${sheet.width}×${sheet.height} PNG; review artifact; no Render manifest)`,
            );
          },
        );
      } catch (err) {
        teardownOutcome = "No comparison sheet PNG was written.";
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "render") {
      const name = positionals[1];
      if (!name) {
        emitRender({ ok: false, error: "Usage: ply composition render <name> [--out <path>] [--supersample <n>]" }, isJson);
        process.exitCode = 2;
        return;
      }
      // Supersample factor (#184, ADR-0022): shaped at the command boundary
      // as a usage error, like every other value-range option.
      const supersample = values.supersample !== undefined ? parseNumericArgument(values.supersample) : 2;
      if (!Number.isInteger(supersample) || supersample < 1) {
        output(
          { ok: false, error: `Supersample factor (--supersample) must be an integer of at least 1.` },
          isJson,
        );
        process.exitCode = 2;
        return;
      }
      try {
        const render = await renderComposition(targetProj, name, { out: values.out, supersample });
        // The output is on disk before the browser teardown runs; if teardown
        // fails, the caller must hear exactly that.
        teardownOutcome = `The rendered PNG was already written to ${render.output}. Do not re-render to recover it.`;
        emitRender(
          { ok: true, render },
          isJson,
          () => {
            console.log(`Rendered Composition "${render.name}" at ${render.width}\u00d7${render.height} \u2192 ${render.output} (manifest: ${render.manifest})`);
          },
        );
      } catch (err) {
        teardownOutcome = "No rendered PNG was written; no output was published.";
        emitRender({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "replay") {
      const manifestPath = positionals[1];
      if (!manifestPath) {
        emitRender({ ok: false, error: "Usage: ply composition replay <manifest-path> [--out <path>]" }, isJson);
        process.exitCode = 2;
        return;
      }
      if (values.supersample !== undefined) {
        // replay has no --supersample (#184): the factor comes from the
        // manifest alone, so replay reproduces the recorded pixels.
        output(
          { ok: false, error: "replay does not accept --supersample; the factor comes from the render manifest." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }
      try {
        const replay = await replayRender(targetProj, manifestPath, { out: values.out });
        // The output is on disk before the browser teardown runs; if teardown
        // fails, the caller must hear exactly that.
        teardownOutcome = `The replayed PNG was already written to ${replay.output}. Do not re-replay to recover it.`;
        emitRender(
          { ok: true, replay },
          isJson,
          () => {
            console.log(
              `Replayed Composition "${replay.name}" from its retained history \u2192 ${replay.output} (manifest: ${replay.manifest})`,
            );
          },
        );
      } catch (err) {
        teardownOutcome = "No replayed PNG was written; no output was published.";
        emitRender({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "list") {
      try {
        const compositions = await listCompositions(targetProj);
        output(
          { ok: true, compositions },
          isJson,
          () => {
            console.log(`Compositions (${compositions.length}):`);
            compositions.forEach((c) => {
              console.log(`  - ${c.name} (${c.canvas.width}×${c.canvas.height}, ${c.layers.length} layers)`);
            });
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else {
      const msg = `Unknown command "${command}". Available commands: create, add, import, remove, reorder, inspect, measure, check, guidelines, render, replay, list. See ply composition --help.`;
      output({ ok: false, error: msg }, isJson);
      process.exitCode = 2;
    }
  } finally {
    await closeCliBrowser(mutationCommitted, teardownOutcome);
  }
}

await run();

/**
 * Render output emission: JSON (success and failure) always goes to stdout
 * so callers can parse it regardless of exit status; the compact default
 * prints one actionable success line on stdout and failures on stderr.
 */
function emitRender(
  result: { ok: true; [key: string]: unknown } | { ok: false; error: string },
  isJson: boolean,
  textFormatter?: () => void,
): void {
  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    textFormatter?.();
  } else {
    console.error(`Error: ${result.error}`);
  }
}

/** Compact content description for a measured Layer. */
function contentLabel(layer: { kind: string; content: { width: number; height: number } }): string {
  return layer.kind === "text" ? `text ${layer.content.width}×${layer.content.height}` : `image content ${layer.content.width}×${layer.content.height}`;
}

/**
 * Compact painted-extent segment for a measured Layer: the unclipped ink
 * box, plus the on-canvas intersection only when ink is clipped, or the
 * explicit no-visible-ink wording when there is nothing painted.
 */
function paintedText(layer: Pick<MeasuredLayerBounds, "painted" | "paintedOnCanvas" | "clipped" | "refused">): string {
  if (layer.refused) return `refused (${layer.refused})`;
  if (!layer.painted) return "painted: none (no visible ink)";
  const p = layer.painted;
  let segment = `painted (${p.x}, ${p.y}) ${p.width}×${p.height}`;
  if (layer.clipped) {
    // Ink can be clipped with an empty on-canvas footprint — entirely
    // outside the canvas — so the intersection may be null.
    const v = layer.paintedOnCanvas;
    segment += v
      ? `, on-canvas (${v.x}, ${v.y}) ${v.width}×${v.height} — clipped`
      : " — clipped (entirely off-canvas)";
  }
  return segment;
}
