#!/usr/bin/env bun
// Layer management CLI: edit, inspect, and list Layers within a Project.
import { parseArgs } from "node:util";
import path from "node:path";
import { inspectLayer, listLayers, editLayer, roundEffective, type ResolvedLayer } from "./layer.js";
import { resolveAnchoredPlacement, type AnchorResolution, type ParsedAnchor } from "./layer-anchor.js";
import {
  LAYER_OPTION_PARSE_ARGS,
  anyLayerEditOptionProvided,
  isAnchorConflicting,
  anchorConflictOptionList,
  layerContentKindConflict,
  layerDashNumericFlags,
  layerEditOptionKeys,
  parseGenerationJobId,
  parseGenerationOutputSelector,
  parseGenerationOutputValue,
  parseLayerAnchor,
  parseLayerCoordinate,
  parseLayerFlip,
  parseLayerFontSize,
  parseLayerLineHeight,
  parseLayerOpacity,
  parseLayerOutline,
  parseLayerVisibleRegion,
  parseLayerVisibleRegionRadius,
  parseLayerRotation,
  parseLayerShadow,
  parseLayerTracking,
  parseLayerVectorColor,
  parseLayerWeight,
  parseLayerWidth,
  parseMatteId,
  parseResizeOptions,
  validateTextFaceAxes,
  validateTextFontSource,
  parseLayerFontFile,
  parseLayerFill,
  parseShapeCornerRadius,
  parseShapeGeometry,
  parseShapeSize,
  validateTextTypographyControls,
  type LayerOptionArgs,
  type OptionParse,
} from "./layer-options.js";
import { reviewRetainedLayer } from "./evidence-review.js";
import { formatFill } from "./fill.js";
import { parseLayerAddress, resolveLayerToken, LayerAddressSyntaxError, type ResolvedLayerToken } from "./layer-address.js";
import { closeCliBrowser } from "./cli-browser.js";
import { helpResult, usageMessage, joinDashLeadingNumericValues } from "./cli-present.js";

const HELP = `
layer — Layer management and inspection within a Project

Name addressing: wherever a Layer id is accepted — layer edit, layer
inspect, and layer review — a Composition-plus-use name address
"<composition>/<use>" is also accepted. It resolves to the referenced
Layer's id once, at the command boundary; unknown Compositions and uses
are refused listing what exists, and a Layer id continues to work
everywhere. With --fork, the address supplies the target Composition
and use, so --composition/--use need not be repeated (repeating them
must match the address).

  ply layer edit <layer-id> [options]
  ply layer edit <composition>/<use> [options]
      Edit a Layer's content or placement, advancing its current revision.
      Requires --in-place when referenced by multiple Compositions.
      With --fork, publish a new Layer identity and retarget only the
      selected use in --composition; other Compositions are unaffected.
      Resize changes placement, never retained pixels: --resize <factor>
      multiplies the current scale (relative), --resize-to <WxH> sets an
      absolute effective size (image and shape Layers only; one omitted axis
      preserves the aspect ratio), and --scale <factor> sets the absolute
      scale — the
      same command twice keeps the same scale (never compounding).
      --rotate sets an ABSOLUTE rotation in degrees: the
      same command twice is still the same angle (unlike the relative resize
      factor), and 0 removes the rotation. --flip sets an ABSOLUTE reflection
      state (horizontal, vertical, both, or none): it replaces the current
      flip state, and none removes the reflection. --anchor places the
      Layer's visible painted ink at a target position (see below).

  ply layer inspect <layer-id> [options]
  ply layer inspect <composition>/<use> [options]
      Inspect a Layer's identity, current revision, and content details

  ply layer review <layer-id> --out <path> [options]
  ply layer review <composition>/<use> --out <path> [options]
      Build the offline evidence review sheet for a generated or matted
      Layer from retained Project evidence — References (shown only when
      their recorded paths still verify; unavailable ones are labeled, never
      substituted), the candidate, and the associated matte. Evidence only:
      no approval or promotion is implied.

  ply layer list [options]
      List all Layers in the Project

Options:
  --project, -p <dir>   Path to Project root (default: current working directory)
  --in-place            Explicitly advance Layer revision in-place across all
                        referring Compositions (required when referrers > 1)
  --fork                Fork instead: publish a new Layer identity with the
                        edited revision and retarget only the selected use.
                        Mutually exclusive with --in-place; --composition and
                        --use are required. A fork always creates a new
                        identity, even when no edit option changes content.
  --composition <name>  Target Composition for --fork (required with --fork)
  --use <local-name>    Target use local name for --fork (required with --fork)
  --image <path>        New source image file for an image Layer: a regular
                        local PNG, JPEG, WebP, or SVG file. An SVG keeps its
                        vector format — the intrinsic size comes from the
                        file's own width/height or viewBox, and the bytes
                        are retained unchanged (#213). An SVG referencing
                        anything outside itself is refused naming each
                        reference and the fix (embed the resource as a data
                        URI); scripts never block import and never run.
  --from-generation <jobId>
                        Replace an image Layer's content with the selected
                        output of a published Generation Job (see ply
                        generate) without generating again; the job's
                        provenance is retained with the Project. Mutually
                        exclusive with --image/--text; invalid on text Layers.
  --output <n|sha256>   Which output of the --from-generation job to ingest:
                        a 1-based index or the full sha-256 content identity.
  --from-matte <matteId>
                        Replace an image Layer's content with the verified
                        output of a published matte (see ply matte) without
                        running inference again; the matte's provenance is
                        retained with the Project (and a generated source's
                        job provenance too). Mutually exclusive with
                        --image/--text/--from-generation; invalid on text
                        Layers.
  --text <str>          New text content for a text Layer
  --font <family>       Bundled font family name for a text Layer
  --font-file <path>    Path to a local TrueType/OpenType font file for a
                        text Layer (#232): the file's bytes are retained
                        with the Layer and its own facts are stored, so
                        rendering, measure, replay, and cross-Project
                        import never need the original file. Mutually
                        exclusive with --font — one font source per edit.
                        Weight/width validate against the file's real axes;
                        a non-font or unresolvable file is refused before
                        anything publishes.
  --font-size <num>     Font size in px for a text Layer
  --tracking <num>      Letter spacing in em for a text Layer (#187,
                        ADR-0021): -0.5 to 1 (0 removes stored tracking —
                        the same look as no tracking)
  --line-height <num|normal>
                        Line height as a unitless multiplier of the font
                        size (#187, ADR-0021): 0.5 to 3; "normal" removes
                        stored line height (the font's own line height
                        applies)
  --weight <num>        Text weight for a text Layer (#179, #232):
                        validated against the Layer's font's real weight
                        axis — Archivo 100-900 (default 400); static faces
                        accept only their own weight; a caller font file
                        validates against the file's own fvar ranges
  --width <num>         Text width for a text Layer (#179/#196): variable
                        fonts — Archivo 62-125 (default 100); static faces
                        accept only their implicit width 100
  --color <hex>         Text color as #RGB or #RRGGBB
  --shape <geometry>    Set a shape Layer's geometry to an ABSOLUTE value:
                        rectangle or ellipse (#209). Omitted keeps the
                        current geometry; switching to ellipse drops a
                        carried corner radius (a rectangle fact with no
                        ellipse meaning), and an explicitly supplied radius
                        on an ellipse is refused. Refused on image and text
                        Layers — a Layer's kind is stable across edits.
  --size <WxH>          Set a shape Layer's geometry size to an ABSOLUTE
                        "<W>x<H>" in canvas px (#209): the shape's intrinsic
                        pixel facts. Omitted keeps the current size. A
                        carried corner radius that exceeds the new range is
                        refused (pass --corner-radius in the same edit).
                        Mutually exclusive with --resize, --resize-to, and
                        --scale in one edit (the effective-size cap and the
                        resize reference read the intrinsic size). Refused
                        on image and text Layers (kind stability).
  --corner-radius <px>  Set a shape rectangle's corner radius to an ABSOLUTE
                        value in px, 0 to half the shorter side (#209):
                        omitted keeps the current radius, 0 removes it (the
                        same look as absent, never stored). Refused on an
                        ellipse and on image and text Layers (kind
                        stability).
  --fill <spec>         Set a shape Layer's fill to an ABSOLUTE value
                        (#209): the same fill grammar as composition add
                        --shape — a solid hex color (#RGB, #RRGGBB,
                        #RRGGBBAA — alpha allowed, optional "solid:" prefix)
                        or a gradient — "linear:45deg,<stop>,<stop>" or
                        "radial:<stop>,<stop>"; a stop is "<color>" or
                        "<color>:<position>" (0–100, % optional). Omitted
                        keeps the current fill. Refused on image and text
                        Layers (kind stability).
  --x <num>             X position on canvas
  --y <num>             Y position on canvas
  --opacity <num>       Layer opacity between 0 and 1
  --anchor <h>[,<v>]    Anchored placement: resolve the Layer's VISIBLE
                        PAINTED INK against the target position instead of
                        targeting the top-left corner. Horizontal values are
                        left|center|right (anchoring --x), vertical values
                        are top|center|bottom (anchoring --y); a pair like
                        "center,center" anchors both, in that order. A
                        single value anchors one axis only (left/right are
                        horizontal, top/bottom vertical; a bare "center" is
                        ambiguous and refused — name both, e.g.
                        "center,center"). A coordinate supplied for the
                        unanchored axis still applies as a plain placement
                        edit, and the report states exactly what publishes.

                        The anchor box is the PAINTED INK box (alpha > 0 /
                        tight glyph ink, unclipped), never the layout
                        content box: transparent padding does not count, so
                        a padded image's visible subject lands at the
                        target while its layout box extends into the
                        padding. A Layer with no visible ink refuses instead
                        of falling back to the layout box. Resolution runs
                        against the Layer's CURRENT transform and the
                        rendering geometry of the referring Composition(s) —
                        or standalone on an unwrapped line when the Layer is
                        unreferenced (a text Layer's ink depends on each
                        Composition's canvas width; disagreement across
                        Compositions refuses). Resolved through the
                        paint-identical ink measurement, accurate to its
                        pixel grid (~1px).

                        Anchored placement is a ONE-SHOT resolution written
                        into plain placement (x, y) — no anchor facts are
                        stored, and "ply composition measure" verifies where
                        the ink landed. It is its own edit: it cannot be
                        combined with --resize, --scale, --rotate, --flip,
                        shape parameters (--shape, --size, --corner-radius,
                        --fill), or content replacement (the reference ink
                        would be ambiguous);
                        make the transform/content edit first, then anchor.
                        --opacity combines freely. A subsequent content edit
                        keeps the resolved x/y literally.
  --resize <factor>     Scale the Layer by a RELATIVE factor: the new scale
                        is the current scale multiplied by <factor>, so the
                        same command twice keeps enlarging (e.g. 2 then 2
                        gives 4×). Works on image, text, and shape Layers; the aspect
                        ratio is always preserved. Resizing changes placement
                        only: retained source bytes and lineage never change.
                        For an absolute setter use --scale instead.
  --resize-to <WxH>     Set the effective painted size in px (image and
                        shape Layers only — text has no intrinsic pixel
                        size; use --resize; a shape's intrinsic size is its
                        --size geometry). "800x600" deliberately changes
                        the aspect ratio; "800x" or "x600" preserves the
                        Layer's current aspect ratio (a deliberate aspect
                        change survives). Mutually exclusive with --resize
                        and with content-replacement options. The Layer's
                        (x, y) stays its top-left corner: it grows/shrinks
                        right and down.
  --scale <factor>      Set the Layer's scale to an ABSOLUTE factor: replaces
                        the current scale (uniform, both axes), so the same
                        command twice keeps the same scale — never compounding
                        (unlike the relative --resize factor). Works on image
                        text, and shape Layers, writes the one canonical scale (no
                        second scale field), and never changes retained
                        pixels. Mutually exclusive with --resize and
                        --resize-to.
  --rotate <deg>        Rotate the Layer to an ABSOLUTE angle in degrees,
                        replacing any previous rotation: --rotate 45 twice is
                        still 45° (never 90° — unlike the relative --resize
                        factor), and --rotate 0 removes the rotation. Positive
                        degrees rotate clockwise. Rotation applies after
                        scale, about the Layer's (x, y) top-left corner, and
                        never changes retained pixels. Combines with other
                        edit options, including --resize and content
                        replacement.
  --flip <mode>         Flip the Layer to an ABSOLUTE reflection state,
                        replacing any previous flip: horizontal mirrors
                        left–right along the content's own vertical axis,
                        vertical mirrors top–bottom, both mirrors both axes,
                        and none removes the reflection (the same command
                        twice keeps the same state — unlike a toggle). Flip
                        applies with scale, before rotation, about the
                        Layer's (x, y) top-left corner, and never changes
                        retained pixels. Combines with other edit options,
                        including --resize and content replacement.
  --shadow <spec>       Apply a shadow to the Layer's content (#139), on
                        image alpha and text glyphs alike: an ABSOLUTE setter
                        "<dx>,<dy>,<blur>,<color>" — e.g. "10,10,4,#000000"
                        or "0,2,6,#00000080" (alpha softens the shadow) —
                        that replaces any previous shadow, and "none"
                        removes it (the same command twice keeps the same
                        shadow). Offsets and blur are px (blur 0..256,
                        offsets within ±256); negative offsets are valid.
                        The shadow paints in the Layer's LOCAL coordinate
                        space — the transform (scale/rotation/flip) then
                        maps content and shadow together, and the Layer's
                        opacity fades both. It is a revision fact: sharing
                        propagates it, forks isolate it, and removal is its
                        own edit. Never changes retained pixels. Combines
                        with --resize/--rotate/--flip and content
                        replacement; cannot combine with --anchor (the
                        anchor would resolve different ink than the edit
                        publishes — anchor first, then add the shadow).
  --outline <spec>      Apply an outline to the Layer's content (#140), on
                        image alpha and text glyphs alike: an ABSOLUTE setter
                        "<width>,<color>" — e.g. "4,#000000" — that replaces
                        any previous outline, and "none" removes it (the
                        same command twice keeps the same outline). Width is
                        px (0..256). The outline hugs the content in the
                        Layer's LOCAL coordinate space, painted BEFORE the
                        shadow — a shadow on the same Layer is cast from the
                        outlined composite — and the transform then maps
                        content, outline, and shadow together, with the
                        Layer's opacity fading all of it. It is a revision
                        fact: sharing propagates it, forks isolate it, and
                        removal is its own edit. Never changes retained
                        pixels. Combines with --resize/--rotate/--flip and
                        content replacement; cannot combine with --anchor
                        (anchor first, then add the outline).
  --vector-color <hex|none>
                        Paint a vector image Layer's shape in one colour
                        (#215, spec #207 US-005): an ABSOLUTE setter taking
                        a hex color like #22c55e, #2c5, or #22c55e80 (alpha
                        allowed) — the same grammar --fill's solid arm and
                        the effects take — that replaces any previous
                        colour, and "none" removes it, restoring the
                        authored colours byte-identically (the same command
                        twice keeps the same colour). The colour is applied
                        at paint time over the vector's own alpha: every
                        pixel the vector covers with alpha renders exactly
                        the requested colour — a multi-colour vector
                        becomes a single-colour silhouette — and alpha
                        edges are preserved. Defined for vector (format
                        svg) image Layers only: refused on a raster image
                        Layer (a raster's colours are its retained pixels),
                        on a text Layer (which takes its colour through
                        --color), and on a shape Layer (whose colour is its
                        fill, through --fill), before anything is published.
                        When the same edit replaces content, the refusal
                        reads the NEW content's format, and a colour carried
                        across a replacement to raster content is refused
                        naming the fix. The retained bytes
                        are never rewritten — the colour is a revision
                        fact: sharing propagates it, forks isolate it, and
                        removal is its own edit. Paint order within the
                        Layer: the colour is content paint, then the visible
                        region, outline, and shadow follow (ADR-0023).
                        Combines with --resize/--rotate/--flip and content
                        replacement; cannot combine with --anchor (anchor
                        first, then the colour — the anchor resolves the
                        ink the edit publishes, and a colour's alpha can
                        change it).
  --visible-region <spec>
                        Show only a rectangular part of the Layer's content
                        (#211), on image, text, and shape Layers alike: an
                        ABSOLUTE setter "<x>,<y>,<width>,<height>" in the
                        Layer's OWN content pixels, relative to the content
                        box's top-left — e.g. "120,80,640,360" frames a face
                        from a wide cutout without touching the file — and
                        "none" removes the region (the same command twice
                        keeps the same region). The region is a revision
                        fact: content outside it is not ink — painted
                        extents, anchored placement, the on-canvas
                        footprint, and clipping follow it, and shadow and
                        outline hug the region's edge instead of the full
                        content edge. The placement point and transform
                        origin stay defined against the FULL content box, so
                        setting or removing a region never moves the
                        remaining pixels. A region outside the content or
                        with zero area is refused before publication. Never
                        changes retained pixels or lineage. Combines with
                        --resize/--rotate/--flip/--shadow/--outline; cannot
                        combine with content edits (the region is validated
                        against the content box) or --anchor (anchor first,
                        then set the region). A region kept across a later
                        content edit is re-validated against the new
                        content box: outside is refused, fitting publishes
                        with a note.
  --visible-region-radius <px>
                        Round the visible region's corners (#212): an
                        ABSOLUTE setter in px — e.g. "12" rounds the corners
                        of the region rectangle, "0" or "none" removes the
                        radius — that edits and removes INDEPENDENTLY of the
                        rectangle (an omitted option preserves the current
                        radius, even when the rectangle is re-set). The
                        radius obeys the SAME rule as a shape Layer's
                        --corner-radius: a radius larger than half the
                        region rectangle's shorter side is REFUSED, never
                        clamped (the paint would silently clamp it, so the
                        stored parameters would not describe the paint),
                        through the same validator; a negative radius is
                        refused. Needs a visible region — a positive radius
                        on a Layer without one, or combined with the
                        region's removal, is refused (0 and none remove
                        nothing). Removing the region removes its
                        radius. Corner pixels outside the radius are
                        transparent, the outline and shadow follow the
                        rounded edge, and painted extents stay the
                        rectangle's. Never changes retained pixels. Combines
                        with --visible-region (rectangle and radius in one
                        edit); a radius kept across a rectangle re-set must
                        still fit the new rectangle.
  --out <path>          Destination for the layer review sheet (required;
                        parent directory must exist; outside the Project an
                        existing file is the documented overwrite case —
                        the sheet is derived evidence, regenerable at any
                        time; reserved Project storage and existing
                        in-Project files are never overwritten)
  --json                Emit machine-readable JSON output on stdout
  --help, -h            Show this help message
`;

function output(
  result: { ok: true; [key: string]: unknown } | { ok: false; error: string; [key: string]: unknown },
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

/** Compact anchor spec for the edit report: pair form "h,v", single form
 * otherwise. */
function formatAnchorSpec(anchor: ParsedAnchor): string {
  if (anchor.horizontal !== undefined && anchor.vertical !== undefined) {
    return `${anchor.horizontal},${anchor.vertical}`;
  }
  return anchor.horizontal ?? anchor.vertical ?? "";
}

/** Compact target for the edit report, restricted to the anchored axes. */
function formatAnchorTarget(anchored: AnchorResolution): string {
  const { target } = anchored;
  if (target.x !== undefined && target.y !== undefined) return ` at (${target.x}, ${target.y})`;
  if (target.x !== undefined) return ` at x ${target.x}`;
  return ` at y ${target.y}`;
}

// Dash-numeric options (#128): the shared join, driven by the ONE option
// definition (DEC-001) — membership, not order, decides the join.
const rawArgs = joinDashLeadingNumericValues(process.argv.slice(2), layerDashNumericFlags(layerEditOptionKeys()));
const isJson = rawArgs.includes("--json");

let values: LayerOptionArgs & {
  project?: string;
  json?: boolean;
  help?: boolean;
  "in-place"?: boolean;
  fork?: boolean;
  composition?: string;
  use?: string;
  out?: string;
};
let positionals: string[];

try {
  const parsed = parseArgs({
    args: rawArgs,
    allowPositionals: true,
    options: {
      project: { type: "string", short: "p" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      "in-place": { type: "boolean", default: false },
      fork: { type: "boolean", default: false },
      composition: { type: "string" },
      use: { type: "string" },
      out: { type: "string" },
      // The one declaration of the Layer-editing option surface (DEC-001):
      // composition add shares these entries with layer edit.
      ...LAYER_OPTION_PARSE_ARGS,
    },
  });
  values = parsed.values;
  positionals = parsed.positionals;
} catch (err) {
  output({ ok: false, error: usageMessage((err as Error).message, "layer") }, isJson);
  process.exit(2);
}

if (values.help || positionals.length === 0) {
  if (isJson) console.log(JSON.stringify(helpResult(HELP.trim()), null, 2));
  else console.log(HELP);
  process.exit(0);
}

const command = positionals[0]!;
const targetProj = values.project ?? process.cwd();

/**
 * Name addressing (spec #226 US-003, DEC-003): the ONE command-boundary
 * resolution of the id-accepting commands' target token. A plain Layer id
 * passes through unchanged; a `<composition>/<use>` address resolves into
 * the referenced Layer's id, and downstream sees only that id. A malformed
 * address is a usage error (exit 2); an unknown Composition or use is a
 * semantic refusal (exit 1) listing what exists — either way nothing is
 * published. Returns undefined when the refusal has already been reported.
 */
async function resolveTarget(
  targetProj: string,
  token: string,
  isJson: boolean,
): Promise<ResolvedLayerToken | undefined> {
  try {
    return await resolveLayerToken(targetProj, token);
  } catch (err) {
    if (err instanceof LayerAddressSyntaxError) {
      output({ ok: false, error: usageMessage((err as Error).message, "layer") }, isJson);
      process.exitCode = 2;
    } else {
      output({ ok: false, error: (err as Error).message }, isJson);
      process.exitCode = 1;
    }
    return undefined;
  }
}

async function run() {
  try {
    if (command === "edit") {
      const layerToken = positionals[1];
      if (!layerToken) {
        output({ ok: false, error: "Usage: ply layer edit <layer-id> [options]" }, isJson);
        process.exitCode = 2;
        return;
      }

      // Name addressing (spec #226 US-003): resolve the target token ONCE, at
      // this boundary — everything downstream receives only a Layer id.
      const target = await resolveTarget(targetProj, layerToken, isJson);
      if (!target) return;
      const layerId = target.layerId;
      const addressComposition = target.address?.composition;
      const addressUse = target.address?.use;

      // The one edit-option enumeration (DEC-001): "is any edit option
      // supplied" reads the shared option table, and the refusal states
      // exactly the options the table declares — so an option added to the
      // definition is automatically an edit option here and automatically
      // named in this list.
      const hasEditOption = anyLayerEditOptionProvided(values);

      if (!hasEditOption && !values.fork) {
        output(
          {
            ok: false,
            error: `No edit options provided: specify at least one of ${layerEditOptionKeys().map((key) => `--${key}`).join(", ")}, or --fork.`,
          },
          isJson,
        );
        process.exitCode = 2;
        return;
      }

      // Fork intent usage contract (#85): --fork and --in-place are mutually
      // exclusive; fork requires an explicit --composition/--use target;
      // those flags are meaningless without --fork. With an address target
      // (#226), the address supplies the target Composition and use, so they
      // need not be repeated — an explicit repetition must match the address.
      if (values.fork && values["in-place"]) {
        output(
          { ok: false, error: "--fork and --in-place are mutually exclusive edit intents." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }
      if (values.fork) {
        if (addressComposition !== undefined && values.composition !== undefined && values.composition !== addressComposition) {
          output(
            { ok: false, error: `--composition "${values.composition}" conflicts with the address's Composition "${addressComposition}".` },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
        if (addressUse !== undefined && values.use !== undefined && values.use !== addressUse) {
          output(
            { ok: false, error: `--use "${values.use}" conflicts with the address's use "${addressUse}".` },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
      }
      const forkComposition = values.composition ?? addressComposition;
      const forkUse = values.use ?? addressUse;
      if (values.fork) {
        if (!forkComposition || forkComposition.trim() === "") {
          output(
            { ok: false, error: "--composition <comp> is required with --fork: name the Composition whose use is retargeted (or address the Layer as <composition>/<use>)." },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
        if (!forkUse || forkUse.trim() === "") {
          output(
            { ok: false, error: "--use <local-name> is required with --fork: name the use in the target Composition to retarget (or address the Layer as <composition>/<use>)." },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
      } else if (values.composition !== undefined || values.use !== undefined) {
        output(
          { ok: false, error: "--composition and --use are only valid together with --fork." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }

      // Content-kind exclusivity (#107, #108): one rule from the shared
      // option table (DEC-001) — --image, --from-generation, --from-matte,
      // --text, and the text style options are mutually exclusive kinds.
      const imageConflict = layerContentKindConflict(values, "image", "edit");
      if (imageConflict) {
        output({ ok: false, error: imageConflict }, isJson);
        process.exitCode = 2;
        return;
      }

      // Generated-content ingestion (#107): --from-generation is an image
      // content option, mutually exclusive with --image and the text options;
      // --output selects one output of the job and is meaningless without it.
      const generationJobId = parseGenerationJobId(values["from-generation"]);
      if (!generationJobId.ok) {
        output({ ok: false, error: generationJobId.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const generationConflict = layerContentKindConflict(values, "from-generation", "edit");
      if (generationConflict) {
        output({ ok: false, error: generationConflict }, isJson);
        process.exitCode = 2;
        return;
      }
      // Matting-content ingestion (#108): --from-matte is an image content
      // option, mutually exclusive with --image, --from-generation, and the
      // text options.
      const matteId = parseMatteId(values["from-matte"]);
      if (!matteId.ok) {
        output({ ok: false, error: matteId.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const matteConflict = layerContentKindConflict(values, "from-matte", "edit");
      if (matteConflict) {
        output({ ok: false, error: matteConflict }, isJson);
        process.exitCode = 2;
        return;
      }
      const outputSelector = parseGenerationOutputSelector(values.output, values["from-generation"] !== undefined);
      if (!outputSelector.ok) {
        output({ ok: false, error: outputSelector.error }, isJson);
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

      // Each option's shape validation below is the shared validator from
      // the option definition (DEC-001) — the same function composition add
      // runs, so the two boundaries can never disagree.
      const placementX = parseLayerCoordinate("x", values.x, "edit");
      if (!placementX.ok) {
        output({ ok: false, error: placementX.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const x = placementX.value;
      const placementY = parseLayerCoordinate("y", values.y, "edit");
      if (!placementY.ok) {
        output({ ok: false, error: placementY.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const y = placementY.value;
      const parsedOpacity = parseLayerOpacity(values.opacity);
      if (!parsedOpacity.ok) {
        output({ ok: false, error: parsedOpacity.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const opacity = parsedOpacity.value;
      const parsedFontSize = parseLayerFontSize(values["font-size"], "edit");
      if (!parsedFontSize.ok) {
        output({ ok: false, error: parsedFontSize.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const fontSize = parsedFontSize.value;
      // Text axes (#179, ADR-0021): shape at the command boundary (exit 2),
      // and range when --font names the face — the SAME validator the edit
      // path uses, so the boundaries never disagree. Without --font the
      // face is the Layer's retained font, so the range refusal is semantic
      // (exit 1) inside the edit path, like the other retained-state refusals.
      const parsedWeight = parseLayerWeight(values.weight);
      if (!parsedWeight.ok) {
        output({ ok: false, error: parsedWeight.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const weight = parsedWeight.value;
      const parsedWidth = parseLayerWidth(values.width);
      if (!parsedWidth.ok) {
        output({ ok: false, error: parsedWidth.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const width = parsedWidth.value;
      // Text typography (#187, ADR-0021): font-independent, so shape and
      // range are usage errors (exit 2) here unconditionally, through the
      // SAME validator the edit path uses — the edit path re-resolves before
      // anything publishes. `--tracking 0` and `--line-height normal` are
      // the clear syntaxes; the resolver normalizes both to absent (one
      // stored form per look).
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
      if (values.font !== undefined || values["font-file"] !== undefined) {
        // One font source per edit (#232): --font and --font-file are
        // mutually exclusive — a usage error (exit 2) at the boundary.
        const fontSourceError = validateTextFontSource(values.font, values["font-file"]);
        if (fontSourceError !== undefined) {
          output({ ok: false, error: fontSourceError }, isJson);
          process.exitCode = 2;
          return;
        }
      }
      if (values["font-file"] !== undefined) {
        // A font file's existence and validity are semantic (the ingestion
        // path reads the bytes once and parses them — DEC-006), so its
        // refusals stay exit-1 like the other retained-state refusals; only
        // the blank-path shape is a usage error here.
        const parsedFontFile = parseLayerFontFile(values["font-file"]);
        if (!parsedFontFile.ok) {
          output({ ok: false, error: parsedFontFile.error }, isJson);
          process.exitCode = 2;
          return;
        }
      }
      if (values.font !== undefined) {
        // An unknown family keeps its established semantic refusal (exit 1,
        // from the edit path's resolveFace); only weight/width range errors
        // are usage errors here (exit 2).
        const axesError = validateTextFaceAxes(values.font, weight, width);
        if (axesError !== undefined) {
          output({ ok: false, error: axesError }, isJson);
          process.exitCode = 2;
          return;
        }
      }

      // Resize flags (#133): syntax and well-formedness at the command
      // boundary through the shared one-path validator (DEC-001); scale
      // semantics, caps, and kind conflicts are enforced by the edit path
      // before any staging, so invalid resize inputs never advance live state.
      const resize = parseResizeOptions(values.resize, values["resize-to"], values.scale);
      if (!resize.ok) {
        output({ ok: false, error: resize.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const resizeFactor = resize.value.resizeFactor;
      const resizeTo = resize.value.resizeTo;

      // Rotate flag (#134): syntax and well-formedness at the command
      // boundary; the finite-number semantic check is enforced again by the
      // edit path before any staging, so an invalid angle never advances
      // live state.
      const rotation = parseLayerRotation(values.rotate);
      if (!rotation.ok) {
        output({ ok: false, error: rotation.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const rotateDeg = rotation.value;

      // Flip flag (#135): the reflection mode is validated at the command
      // boundary as a usage error (exit 2), so an invalid mode never reaches
      // the edit path; the absolute-setter semantics are enforced again by
      // the edit path before any staging.
      const parsedFlip = parseLayerFlip(values.flip);
      if (!parsedFlip.ok) {
        output({ ok: false, error: parsedFlip.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const flip = parsedFlip.value;

      // Shape content options (#208, #209): grammar at the command boundary
      // through the SAME parsers the add surface runs; semantics are the
      // edit path's absolute setters on a shape Layer and the kind-stability
      // refusal on image and text Layers, both before anything is staged.
      const parsedEditShape = parseShapeGeometry(values.shape);
      if (!parsedEditShape.ok) {
        output({ ok: false, error: parsedEditShape.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const parsedEditSize = parseShapeSize(values.size);
      if (!parsedEditSize.ok) {
        output({ ok: false, error: parsedEditSize.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const parsedEditRadius = parseShapeCornerRadius(values["corner-radius"]);
      if (!parsedEditRadius.ok) {
        output({ ok: false, error: parsedEditRadius.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const parsedEditFill = parseLayerFill(values.fill);
      if (!parsedEditFill.ok) {
        output({ ok: false, error: parsedEditFill.error }, isJson);
        process.exitCode = 2;
        return;
      }

      // Shadow flag (#139, ADR-0018): syntax and well-formedness at the
      // command boundary as a usage error (exit 2) through the SAME parser
      // the edit path uses, so the two boundaries never disagree; the
      // absolute-setter semantics are enforced again by the edit path before
      // any staging.
      const parsedShadow = parseLayerShadow(values.shadow);
      if (!parsedShadow.ok) {
        output({ ok: false, error: parsedShadow.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const shadowSpec = parsedShadow.value;

      // Outline flag (#140, ADR-0019): syntax and well-formedness at the
      // command boundary as a usage error (exit 2) through the SAME parser
      // the edit path uses, so the two boundaries never disagree; the
      // absolute-setter semantics are enforced again by the edit path before
      // any staging.
      const parsedOutline = parseLayerOutline(values.outline);
      if (!parsedOutline.ok) {
        output({ ok: false, error: parsedOutline.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const outlineSpec = parsedOutline.value;

      // Visible-region flag (#211, ADR-0023): syntax and well-formedness at
      // the command boundary as a usage error (exit 2) through the SAME
      // parser the edit path uses, so the two boundaries never disagree;
      // the absolute-setter semantics (including the content-bounds
      // validation and the no-content-edit-in-the-same-edit rule) are
      // enforced again by the edit path before any staging.
      const parsedRegion = parseLayerVisibleRegion(values["visible-region"]);
      if (!parsedRegion.ok) {
        output({ ok: false, error: parsedRegion.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const regionSpec = parsedRegion.value;

      // Visible-region corner radius (#212): syntax and well-formedness at
      // the command boundary as a usage error (exit 2) through the SAME
      // parser the edit path uses; the range rule (over half the region
      // rectangle's shorter side is refused, never clamped) and the
      // needs-a-region rule are semantic, enforced by the edit path before
      // any staging.
      const parsedRegionRadius = parseLayerVisibleRegionRadius(values["visible-region-radius"]);
      if (!parsedRegionRadius.ok) {
        output({ ok: false, error: parsedRegionRadius.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const regionRadiusSpec = parsedRegionRadius.value;

      // Vector-colour flag (#215, DEC-008/009): syntax and well-formedness at
      // the command boundary as a usage error (exit 2) through the SAME
      // parser the edit path uses (the ONE fill-colour grammar); the
      // kind/format refusals (raster image, text, shape — naming each kind's
      // own colour control) are semantic, enforced by the edit path before
      // anything is staged.
      const parsedVectorColor = parseLayerVectorColor(values["vector-color"]);
      if (!parsedVectorColor.ok) {
        output({ ok: false, error: parsedVectorColor.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const vectorColorSpec = parsedVectorColor.value;

      // Anchor flag (#138, ADR-0017): syntax and well-formedness at the
      // command boundary (exit 2); semantic refusals (no visible ink,
      // divergent multi-Composition geometry) happen in the read-only
      // resolution BEFORE the edit is invoked (exit 1) — so no anchored
      // input ever mutates live state.
      const parsedAnchorResult = parseLayerAnchor(values.anchor);
      if (!parsedAnchorResult.ok) {
        output({ ok: false, error: parsedAnchorResult.error }, isJson);
        process.exitCode = 2;
        return;
      }
      const parsedAnchor = parsedAnchorResult.value;
      if (parsedAnchor !== undefined) {
        // Anchored placement is its own edit: transform and content edits
        // change the reference ink, so combining them in one edit is a
        // conflicting request (the same precedent as resize + content
        // replacement). --opacity combines freely: opacity scales alpha
        // values, never the ink support. The conflict set is derived from
        // the shared option table (DEC-001), so a newly added option
        // automatically joins it.
        if (isAnchorConflicting(values)) {
          output(
            {
              ok: false,
              error:
                `--anchor is its own edit: it cannot be combined with ${anchorConflictOptionList()}, or content replacement in one edit, because the reference ink would be ambiguous. ` +
                "Make the transform, content, or effect edit first, then anchor.",
            },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
        if (parsedAnchor.horizontal !== undefined && x === undefined) {
          output(
            { ok: false, error: `--x <target> is required to anchor horizontally: the ${parsedAnchor.horizontal} ink edge/center lands at the requested x.` },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
        if (parsedAnchor.vertical !== undefined && y === undefined) {
          output(
            { ok: false, error: `--y <target> is required to anchor vertically: the ${parsedAnchor.vertical} ink edge/center lands at the requested y.` },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
      }

      try {
        // Anchored placement (#138, ADR-0017): resolve ONCE against the
        // live state's painted ink (read-only), then publish plain x/y
        // through the ordinary edit lifecycle — the edit path never sees an
        // anchor, so no alternate placement representation can exist.
        let anchored: AnchorResolution | undefined;
        let editX = x;
        let editY = y;
        if (parsedAnchor !== undefined) {
          try {
            anchored = await resolveAnchoredPlacement(targetProj, layerId, {
              anchor: parsedAnchor,
              targetX: x,
              targetY: y,
              contextComposition: values.fork ? forkComposition : undefined,
            });
          } catch (err) {
            const errObj = err as Error & { referringCompositions?: string[]; referrersCount?: number };
            const result: { ok: false; error: string; [key: string]: unknown } = { ok: false, error: errObj.message };
            if (errObj.referringCompositions !== undefined) result.referringCompositions = errObj.referringCompositions;
            if (errObj.referrersCount !== undefined) result.referrersCount = errObj.referrersCount;
            output(result, isJson);
            process.exitCode = 1;
            return;
          }
          if (parsedAnchor.horizontal !== undefined) editX = anchored.placement.x;
          if (parsedAnchor.vertical !== undefined) editY = anchored.placement.y;
          // The report states what WILL publish: an unanchored axis with a
          // supplied coordinate publishes as a plain placement edit, so the
          // audit report and the published revision can never disagree.
          anchored = {
            ...anchored,
            placement: {
              x: parsedAnchor.horizontal !== undefined ? anchored.placement.x : (editX ?? anchored.placement.x),
              y: parsedAnchor.vertical !== undefined ? anchored.placement.y : (editY ?? anchored.placement.y),
            },
          };
        }

        const res = await editLayer(targetProj, layerId, {
          inPlace: values["in-place"],
          fork: values.fork,
          // Forwarded only for a fork: the address's Composition/use pair is
          // fork-targeting intent, never a downstream-visible address fact.
          composition: values.fork ? forkComposition : undefined,
          use: values.fork ? forkUse : undefined,
          image: values.image,
          fromGeneration:
            values["from-generation"] !== undefined
              ? { jobRoot: path.resolve("out", "generation"), jobId: generationJobId.value!, output: values.output }
              : undefined,
          fromMatte:
            values["from-matte"] !== undefined
              ? {
                  matteRoot: path.resolve("out", "matting"),
                  matteId: matteId.value!,
                  generationRoot: path.resolve("out", "generation"),
                }
              : undefined,
          text: values.text,
          font: values.font,
          fontFile: values["font-file"],
          fontSize,
          color: values.color,
          weight,
          width,
          tracking,
          lineHeight,
          x: editX,
          y: editY,
          opacity,
          resizeFactor,
          resizeTo,
          scale: resize.value.scale,
          rotateDeg,
          flip,
          shadow: shadowSpec,
          outline: outlineSpec,
          visibleRegion: regionSpec,
          visibleRegionRadius: regionRadiusSpec,
          vectorColor: vectorColorSpec,
          shape: parsedEditShape.value,
          size: parsedEditSize.value,
          cornerRadius: parsedEditRadius.value,
          fill: parsedEditFill.value,
        });

        const resultBody: { ok: true; [key: string]: unknown } = {
          ok: true,
          layer: res.layer,
          referringCompositions: res.referringCompositions,
          referrersCount: res.referrersCount,
        };
        if (res.fork) {
          resultBody.fork = res.fork;
        }
        if (res.generatedFrom) {
          resultBody.generatedFrom = res.generatedFrom;
        }
        if (res.mattedFrom) {
          resultBody.mattedFrom = res.mattedFrom;
        }
        if (res.resized) {
          resultBody.resized = res.resized;
        }
        if (res.rotated) {
          resultBody.rotated = res.rotated;
        }
        if (res.flipped) {
          resultBody.flipped = res.flipped;
        }
        if (res.shadowed) {
          resultBody.shadowed = res.shadowed;
        }
        if (res.outlined) {
          resultBody.outlined = res.outlined;
        }
        if (res.regionSet) {
          resultBody.regionSet = res.regionSet;
        }
        if (res.regionCarried) {
          resultBody.regionCarried = res.regionCarried;
        }
        if (res.shapeEdited) {
          resultBody.shapeEdited = res.shapeEdited;
        }
        if (anchored) {
          resultBody.anchored = anchored;
        }
        // A region kept across this content edit still fits the new content
        // box (#211 review PROD-1): say so on stderr in BOTH output modes —
        // the note is diagnostic, never part of the machine-readable result.
        if (res.regionCarried) {
          const r = res.regionCarried.visibleRegion;
          console.error(`Note: kept visible region (${r.x}, ${r.y}, ${r.width}, ${r.height}) now frames the replaced content.`);
        }

        output(
          resultBody,
          isJson,
          () => {
            const refMsg =
              res.referrersCount === 0
                ? "not referenced by any Composition"
                : `referenced by ${res.referrersCount} Composition${res.referrersCount === 1 ? "" : "s"} (${res.referringCompositions.map((n) => `"${n}"`).join(", ")})`;
            const generated = res.generatedFrom
              ? `; from Generation Job ${res.generatedFrom.jobId} (${res.generatedFrom.contentHash.slice(0, 12)}, provenance retained)`
              : "";
            const matted = res.mattedFrom
              ? `; from matte ${res.mattedFrom.matteId} (engine ${res.mattedFrom.engine}, provenance retained)`
              : "";
            const resized = res.resized
              ? res.resized.width !== undefined
                ? `; scale ${res.resized.scaleX}×, effective ${res.resized.width}×${res.resized.height}px`
                : `; scale ${res.resized.scaleX}×`
              : "";
            const rotated = res.rotated ? `; rotation ${res.rotated.rotationDeg}°` : "";
            const flipped = res.flipped && res.flipped.flip !== "none" ? `; flip ${res.flipped.flip}` : res.flipped ? "; flip none" : "";
            const shadowed = res.shadowed
              ? res.shadowed.shadow
                ? `; shadow ${res.shadowed.shadow.dx} ${res.shadowed.shadow.dy} ${res.shadowed.shadow.blur} ${res.shadowed.shadow.color}`
                : "; shadow none"
              : "";
            const outlined = res.outlined
              ? res.outlined.outline
                ? `; outline ${res.outlined.outline.width} ${res.outlined.outline.color}`
                : "; outline none"
              : "";
            const regionSet = res.regionSet
              ? res.regionSet.visibleRegion
                ? `; visible region (${res.regionSet.visibleRegion.x}, ${res.regionSet.visibleRegion.y}, ${res.regionSet.visibleRegion.width}, ${res.regionSet.visibleRegion.height})` +
                  (res.regionSet.visibleRegion.cornerRadius !== undefined
                    ? `, corner radius ${res.regionSet.visibleRegion.cornerRadius}px`
                    : "")
                : "; visible region none"
              : "";
            const vectorColorSet = res.vectorColorSet
              ? res.vectorColorSet.vectorColor !== null
                ? `; vector colour ${res.vectorColorSet.vectorColor}`
                : "; vector colour removed"
              : "";
            const shapeEdited = res.shapeEdited
              ? `; dropped carried corner radius ${res.shapeEdited.droppedCornerRadius}px (an ellipse has no corners)`
              : "";
            const anchorSummary = anchored
              ? `; anchored ${formatAnchorSpec(anchored.anchor)}${formatAnchorTarget(anchored)} -> placement (${anchored.placement.x}, ${anchored.placement.y})`
              : "";
            if (res.fork) {
              console.log(
                `Forked Layer "${res.fork.previousLayerId}" -> new Layer "${res.layer.id}" -> revision ${res.layer.currentRevisionId} ` +
                  `(retargeted use "${res.fork.use}" in composition "${res.fork.composition}"; original Layer ${refMsg})${generated}${matted}${resized}${rotated}${flipped}${shadowed}${outlined}${regionSet}${vectorColorSet}${shapeEdited}${anchorSummary}`,
              );
            } else {
              console.log(`Edited Layer "${res.layer.id}" -> revision ${res.layer.currentRevisionId} (${refMsg})${generated}${matted}${resized}${rotated}${flipped}${shadowed}${outlined}${regionSet}${vectorColorSet}${shapeEdited}${anchorSummary}`);
            }
          },
        );
      } catch (err) {
        const errObj = err as Error & { referringCompositions?: string[]; referrersCount?: number };
        const result: { ok: false; error: string; [key: string]: unknown } = {
          ok: false,
          error: errObj.message,
        };
        if (errObj.referringCompositions !== undefined) {
          result.referringCompositions = errObj.referringCompositions;
        }
        if (errObj.referrersCount !== undefined) {
          result.referrersCount = errObj.referrersCount;
        }
        output(result, isJson);
        process.exitCode = 1;
      }
    } else if (command === "inspect") {
      const layerToken = positionals[1];
      if (!layerToken) {
        output({ ok: false, error: "Usage: ply layer inspect <layer-id>" }, isJson);
        process.exitCode = 2;
        return;
      }

      // Name addressing (spec #226 US-003): resolve once at this boundary.
      const target = await resolveTarget(targetProj, layerToken, isJson);
      if (!target) return;
      const layerId = target.layerId;

      try {
        const layer = await inspectLayer(targetProj, layerId);
        output(
          { ok: true, layer },
          isJson,
          () => {
            const rev = layer.currentRevision;
            console.log(`Layer: ${layer.id}`);
            console.log(`Created: ${layer.createdAt}`);
            console.log(`Current revision: ${layer.currentRevisionId}`);
            console.log(`  Kind: ${rev.kind}`);
            if (rev.kind === "text") {
              console.log(`  Text: ${JSON.stringify(rev.text)}`);
              // Caller fonts (#232): report the font's OWN family name (the
              // name the file declares) and that it is caller-supplied.
              // Bundled and legacy faces keep the established retained-face
              // form — the retained bytes are their only identity.
              const fontLabel =
                rev.callerFont !== undefined
                  ? `"${rev.callerFont.family}" (caller-supplied, ${(rev.fontBytes / 1024).toFixed(1)} KB)`
                  : `retained face (${(rev.fontBytes / 1024).toFixed(1)} KB)`;
              console.log(`  Font: ${fontLabel}, ${rev.fontSize}px, color ${rev.color}`);
              // Selected text axes (#179, ADR-0021): present ⟺ variable font.
              if (rev.weight !== undefined || rev.width !== undefined) {
                console.log(`  Axes: weight ${rev.weight}, width ${rev.width}`);
              }
              // Selected text typography (#187, ADR-0021): each shown only
              // when set — absence IS the normal-spacing / normal-line-height
              // form.
              if (rev.tracking !== undefined) {
                console.log(`  Tracking: ${rev.tracking}em`);
              }
              if (rev.lineHeight !== undefined) {
                console.log(`  Line height: ${rev.lineHeight}`);
              }
            } else if (rev.kind === "shape") {
              // Shape parameters (#208): the geometry, its size, the corner
              // radius when stored (absent = none), and the one fill.
              console.log(`  Geometry: ${rev.shape} (${rev.width}×${rev.height})`);
              if (rev.cornerRadius !== undefined) {
                console.log(`  Corner radius: ${rev.cornerRadius}px`);
              }
              console.log(`  Fill: ${formatFill(rev.fill)}`);
            } else {
              console.log(`  Format: ${rev.format} (${rev.width}×${rev.height}, ${(rev.bytes / 1024).toFixed(1)} KB)`);
              // The vector colour (#215): reported only when set — absence IS
              // the no-colour form. A raster Layer can never carry the fact
              // (the setter refuses), so the line names the vector contract.
              if (rev.vectorColor !== undefined) {
                console.log(`  Vector colour: ${rev.vectorColor}`);
              }
            }
            console.log(`  Content hash: ${rev.contentHash}`);
            const scalePart =
              rev.scaleX === rev.scaleY ? `${rev.scaleX}×` : `${rev.scaleX}×/${rev.scaleY}×`;
            const scale =
              rev.scaleX === 1 && rev.scaleY === 1
                ? ""
                : rev.kind === "text"
                  ? `, Scale: ${scalePart}`
                  : `, Scale: ${scalePart} (effective ${roundEffective(rev.width * rev.scaleX)}×${roundEffective(rev.height * rev.scaleY)})`;
            const rotation =
              rev.rotationDeg === 0 ? "" : `, Rotation: ${rev.rotationDeg}°`;
            const flip =
              !rev.flipX && !rev.flipY
                ? ""
                : rev.flipX && rev.flipY
                  ? ", Flip: both"
                  : ", Flip: " + (rev.flipX ? "horizontal" : "vertical");
            const shadow =
              rev.shadow === undefined
                ? ""
                : `, Shadow: ${rev.shadow.dx} ${rev.shadow.dy} ${rev.shadow.blur} ${rev.shadow.color}`;
            const outline =
              rev.outline === undefined
                ? ""
                : `, Outline: ${rev.outline.width} ${rev.outline.color}`;
            const region =
              rev.visibleRegion === undefined
                ? ""
                : `, Visible region: (${rev.visibleRegion.x}, ${rev.visibleRegion.y}, ${rev.visibleRegion.width}, ${rev.visibleRegion.height})` +
                  (rev.visibleRegion.cornerRadius !== undefined
                    ? `, corner radius ${rev.visibleRegion.cornerRadius}px`
                    : "");
            console.log(`  Placement: (${rev.x}, ${rev.y}), Opacity: ${rev.opacity}${scale}${rotation}${flip}${shadow}${outline}${region}`);
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "review") {
      const layerToken = positionals[1];
      if (!layerToken) {
        output({ ok: false, error: "Usage: ply layer review <layer-id> --out <path>" }, isJson);
        process.exitCode = 2;
        return;
      }

      // Name addressing (spec #226 US-003): resolve once at this boundary.
      const target = await resolveTarget(targetProj, layerToken, isJson);
      if (!target) return;
      const layerId = target.layerId;

      if (!values.out || !values.out.trim()) {
        output(
          { ok: false, error: "--out <path> is required: name the destination for the review sheet (a self-contained HTML file)." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }

      try {
        const review = await reviewRetainedLayer(targetProj, layerId, path.resolve(values.out));
        output(
          {
            ok: true,
            layer: review.layerId,
            review: review.reviewPath,
            generation: review.generation,
            matting: review.matting,
            associatedMatte: review.associatedMatte ? { matteId: review.associatedMatte.matteId, engine: review.associatedMatte.engine } : null,
            references: review.references.map((r) => ({
              path: r.path,
              contentHash: r.contentHash,
              available: r.bytes !== null,
            })),
          },
          isJson,
          () => {
            console.log(`Evidence review ${review.layerId}`);
            if (review.generation)
              console.log(`  generated by: ${review.generation.jobId} (output ${review.generation.output.contentHash.slice(0, 12)})`);
            if (review.matting) console.log(`  matted by: ${review.matting.matteId} (engine ${review.matting.engine})`);
            for (const r of review.references) {
              const status = r.bytes !== null ? "verified" : `unavailable (${r.unavailable})`;
              console.log(`  ref: ${r.path} (${r.contentHash.slice(0, 12)}) · ${status}`);
            }
            if (review.predecessorCandidateNote) console.log(`  note: ${review.predecessorCandidateNote}`);
            console.log(`  review: ${review.reviewPath}`);
            console.log("  evidence only — no approval or promotion is implied");
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "list") {
      try {
        const layers = await listLayers(targetProj);
        output(
          { ok: true, layers },
          isJson,
          () => {
            console.log(`Layers (${layers.length}):`);
            layers.forEach((l) => {
              const rev = l.currentRevision;
              const detail =
                rev.kind === "text"
                  ? `text ${JSON.stringify(rev.text)}, ${rev.fontSize}px`
                  : rev.kind === "shape"
                    ? `${rev.shape} ${rev.width}×${rev.height}, ${formatFill(rev.fill)}`
                    : `${rev.width}×${rev.height} ${rev.format}`;
              console.log(`  - ${l.id} [${rev.kind}: ${detail}, rev: ${l.currentRevisionId}]`);
            });
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else {
      const msg = `Unknown command "${command}". Available commands: edit, inspect, review, list. See ply layer --help.`;
      output({ ok: false, error: msg }, isJson);
      process.exitCode = 2;
    }
  } finally {
    await closeCliBrowser();
  }
}

await run();
