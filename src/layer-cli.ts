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
  parseLayerRotation,
  parseLayerShadow,
  parseLayerTracking,
  parseLayerWeight,
  parseLayerWidth,
  parseMatteId,
  parseResizeOptions,
  validateTextFaceAxes,
  validateTextTypographyControls,
  type LayerOptionArgs,
  type OptionParse,
} from "./layer-options.js";
import { reviewRetainedLayer } from "./evidence-review.js";
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
      absolute effective size (image Layers only; one omitted axis preserves
      the aspect ratio), and --scale <factor> sets the absolute scale — the
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
  --image <path>        New source image file for an image Layer
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
  --font-size <num>     Font size in px for a text Layer
  --tracking <num>      Letter spacing in em for a text Layer (#187,
                        ADR-0021): -0.5 to 1 (0 removes stored tracking —
                        the same look as no tracking)
  --line-height <num|normal>
                        Line height as a unitless multiplier of the font
                        size (#187, ADR-0021): 0.5 to 3; "normal" removes
                        stored line height (the font's own line height
                        applies)
  --weight <num>        Text weight for a text Layer (#179): validated
                        against the Layer's font's real weight axis —
                        Archivo 100-900 (default 400); static faces accept
                        only their own weight
  --width <num>         Text width for a text Layer (#179/#196): variable
                        fonts — Archivo 62-125 (default 100); static faces
                        accept only their implicit width 100
  --color <hex>         Text color as #RGB or #RRGGBB
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
                        combined with --resize, --scale, --rotate, --flip, or
                        content replacement (the reference ink would be
                        ambiguous);
                        make the transform/content edit first, then anchor.
                        --opacity combines freely. A subsequent content edit
                        keeps the resolved x/y literally.
  --resize <factor>     Scale the Layer by a RELATIVE factor: the new scale
                        is the current scale multiplied by <factor>, so the
                        same command twice keeps enlarging (e.g. 2 then 2
                        gives 4×). Works on image and text Layers; the aspect
                        ratio is always preserved. Resizing changes placement
                        only: retained source bytes and lineage never change.
                        For an absolute setter use --scale instead.
  --resize-to <WxH>     Set the effective painted size in px (image Layers
                        only — text has no intrinsic pixel size; use
                        --resize). "800x600" deliberately changes the aspect
                        ratio; "800x" or "x600" preserves the Layer's current
                        aspect ratio (a deliberate aspect change survives).
                        Mutually exclusive with --resize and with
                        content-replacement options. The Layer's (x, y) stays
                        its top-left corner: it grows/shrinks right and down.
  --scale <factor>      Set the Layer's scale to an ABSOLUTE factor: replaces
                        the current scale (uniform, both axes), so the same
                        command twice keeps the same scale — never compounding
                        (unlike the relative --resize factor). Works on image
                        and text Layers, writes the one canonical scale (no
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
                "--anchor is its own edit: it cannot be combined with --resize, --resize-to, --scale, --rotate, --flip, --shadow, --outline, --weight, --width, --tracking, --line-height, or content replacement in one edit, because the reference ink would be ambiguous. Make the transform or effect edit first, then anchor.",
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
        if (anchored) {
          resultBody.anchored = anchored;
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
            const anchorSummary = anchored
              ? `; anchored ${formatAnchorSpec(anchored.anchor)}${formatAnchorTarget(anchored)} -> placement (${anchored.placement.x}, ${anchored.placement.y})`
              : "";
            if (res.fork) {
              console.log(
                `Forked Layer "${res.fork.previousLayerId}" -> new Layer "${res.layer.id}" -> revision ${res.layer.currentRevisionId} ` +
                  `(retargeted use "${res.fork.use}" in composition "${res.fork.composition}"; original Layer ${refMsg})${generated}${matted}${resized}${rotated}${flipped}${shadowed}${outlined}${anchorSummary}`,
              );
            } else {
              console.log(`Edited Layer "${res.layer.id}" -> revision ${res.layer.currentRevisionId} (${refMsg})${generated}${matted}${resized}${rotated}${flipped}${shadowed}${outlined}${anchorSummary}`);
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
              console.log(`  Font: retained face (${(rev.fontBytes / 1024).toFixed(1)} KB), ${rev.fontSize}px, color ${rev.color}`);
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
            } else {
              console.log(`  Format: ${rev.format} (${rev.width}×${rev.height}, ${(rev.bytes / 1024).toFixed(1)} KB)`);
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
            console.log(`  Placement: (${rev.x}, ${rev.y}), Opacity: ${rev.opacity}${scale}${rotation}${flip}${shadow}${outline}`);
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
