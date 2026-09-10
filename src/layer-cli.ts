#!/usr/bin/env bun
// Layer management CLI: edit, inspect, and list Layers within a Project.
import { parseArgs } from "node:util";
import path from "node:path";
import { inspectLayer, listLayers, editLayer, roundEffective, type ResolvedLayer } from "./layer.js";
import { parseAnchorSpec, resolveAnchoredPlacement, type AnchorResolution, type ParsedAnchor } from "./layer-anchor.js";
import { parseShadowSpec, parseOutlineSpec } from "./layer.js";
import { reviewRetainedLayer } from "./evidence-review.js";
import { closeCliBrowser } from "./cli-browser.js";

const HELP = `
layer — Layer management and inspection within a Project

  bun run ply layer edit <layer-id> [options]
      Edit a Layer's content or placement, advancing its current revision.
      Requires --in-place when referenced by multiple Compositions.
      With --fork, publish a new Layer identity and retarget only the
      selected use in --composition; other Compositions are unaffected.
      Resize changes placement, never retained pixels: --resize <factor>
      multiplies the current scale (relative), --resize-to <WxH> sets an
      absolute effective size (image Layers only; one omitted axis preserves
      the aspect ratio). --rotate sets an ABSOLUTE rotation in degrees: the
      same command twice is still the same angle (unlike the relative resize
      factor), and 0 removes the rotation. --flip sets an ABSOLUTE reflection
      state (horizontal, vertical, both, or none): it replaces the current
      flip state, and none removes the reflection. --anchor places the
      Layer's visible painted ink at a target position (see below).

  bun run ply layer inspect <layer-id> [options]
      Inspect a Layer's identity, current revision, and content details

  bun run ply layer review <layer-id> --out <path> [options]
      Build the offline evidence review sheet for a generated or matted
      Layer from retained Project evidence — References (shown only when
      their recorded paths still verify; unavailable ones are labeled, never
      substituted), the candidate, and the associated matte. Evidence only:
      no approval or promotion is implied.

  bun run ply layer list [options]
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
                        combined with --resize, --rotate, --flip, or content
                        replacement (the reference ink would be ambiguous);
                        make the transform/content edit first, then anchor.
                        --opacity combines freely. A subsequent content edit
                        keeps the resolved x/y literally.
  --resize <factor>     Scale the Layer by a RELATIVE factor: the new scale
                        is the current scale multiplied by <factor>, so the
                        same command twice keeps enlarging (e.g. 2 then 2
                        gives 4×). Works on image and text Layers; the aspect
                        ratio is always preserved. Resizing changes placement
                        only: retained source bytes and lineage never change.
  --resize-to <WxH>     Set the effective painted size in px (image Layers
                        only — text has no intrinsic pixel size; use
                        --resize). "800x600" deliberately changes the aspect
                        ratio; "800x" or "x600" preserves the Layer's current
                        aspect ratio (a deliberate aspect change survives).
                        Mutually exclusive with --resize and with
                        content-replacement options. The Layer's (x, y) stays
                        its top-left corner: it grows/shrinks right and down.
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

/** Blank supplied values are invalid, never implicit zero. */
function parseNumericArgument(value: string | undefined): number {
  return value?.trim() ? Number(value) : NaN;
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

/** A negative number is a valid `--rotate` (#134) and `--shadow` dx/dy
 * (#139) value, but parseArgs refuses a dash-leading option value ("--rotate
 * -30" reads as an ambiguous flag), so join a following dash-leading numeric
 * token into "--<flag>=<value>" before parsing. Scoped to these introduced
 * options; retained numeric options keep their existing surface untouched
 * (OOS-003). */
function joinDashLeadingNumericValues(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (
      (arg === "--rotate" || arg === "--shadow" || arg === "--outline") &&
      args[i + 1] !== undefined &&
      /^-(?:\.?\d)/.test(args[i + 1]!)
    ) {
      out.push(`${arg}=${args[i + 1]!}`);
      i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

const rawArgs = process.argv.slice(2);
const isJson = rawArgs.includes("--json");

let values: {
  project?: string;
  json?: boolean;
  help?: boolean;
  "in-place"?: boolean;
  fork?: boolean;
  composition?: string;
  use?: string;
  image?: string;
  "from-generation"?: string;
  "from-matte"?: string;
  output?: string;
  out?: string;
  text?: string;
  font?: string;
  "font-size"?: string;
  color?: string;
  x?: string;
  y?: string;
  opacity?: string;
  anchor?: string;
  resize?: string;
  "resize-to"?: string;
  rotate?: string;
  flip?: string;
  shadow?: string;
  outline?: string;
};
let positionals: string[];

try {
  const parsed = parseArgs({
    args: joinDashLeadingNumericValues(rawArgs),
    allowPositionals: true,
    options: {
      project: { type: "string", short: "p" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      "in-place": { type: "boolean", default: false },
      fork: { type: "boolean", default: false },
      composition: { type: "string" },
      use: { type: "string" },
      image: { type: "string" },
      "from-generation": { type: "string" },
      "from-matte": { type: "string" },
      output: { type: "string" },
      out: { type: "string" },
      text: { type: "string" },
      font: { type: "string" },
      "font-size": { type: "string" },
      color: { type: "string" },
      x: { type: "string" },
      y: { type: "string" },
      opacity: { type: "string" },
      anchor: { type: "string" },
      resize: { type: "string" },
      "resize-to": { type: "string" },
      rotate: { type: "string" },
      flip: { type: "string" },
      shadow: { type: "string" },
      outline: { type: "string" },
    },
  });
  values = parsed.values;
  positionals = parsed.positionals;
} catch (err) {
  output({ ok: false, error: (err as Error).message }, isJson);
  process.exit(2);
}

if (values.help || positionals.length === 0) {
  console.log(HELP);
  process.exit(0);
}

const command = positionals[0]!;
const targetProj = values.project ?? process.cwd();

async function run() {
  try {
    if (command === "edit") {
      const layerId = positionals[1];
      if (!layerId) {
        output({ ok: false, error: "Usage: ply layer edit <layer-id> [options]" }, isJson);
        process.exitCode = 2;
        return;
      }

      const hasEditOption =
        values.image !== undefined ||
        values["from-generation"] !== undefined ||
        values["from-matte"] !== undefined ||
        values.text !== undefined ||
        values.font !== undefined ||
        values["font-size"] !== undefined ||
        values.color !== undefined ||
        values.x !== undefined ||
        values.y !== undefined ||
        values.opacity !== undefined ||
        values.anchor !== undefined ||
        values.resize !== undefined ||
        values["resize-to"] !== undefined ||
        values.rotate !== undefined ||
        values.flip !== undefined ||
        values.shadow !== undefined ||
        values.outline !== undefined;

      if (!hasEditOption && !values.fork) {
        output(
          {
            ok: false,
            error:
              "No edit options provided: specify at least one of --image, --from-generation, --from-matte, --text, --font, --font-size, --color, --x, --y, --opacity, --anchor, --resize, --resize-to, --rotate, --flip, --shadow, --outline, or --fork.",
          },
          isJson,
        );
        process.exitCode = 2;
        return;
      }

      // Fork intent usage contract (#85): --fork and --in-place are mutually
      // exclusive; fork requires an explicit --composition/--use target;
      // those flags are meaningless without --fork.
      if (values.fork && values["in-place"]) {
        output(
          { ok: false, error: "--fork and --in-place are mutually exclusive edit intents." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }
      if (values.fork) {
        if (!values.composition || values.composition.trim() === "") {
          output(
            { ok: false, error: "--composition <comp> is required with --fork: name the Composition whose use is retargeted." },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
        if (!values.use || values.use.trim() === "") {
          output(
            { ok: false, error: "--use <local-name> is required with --fork: name the use in the target Composition to retarget." },
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

      if (
        values.image !== undefined &&
        (values.text !== undefined ||
          values.font !== undefined ||
          values["font-size"] !== undefined ||
          values.color !== undefined)
      ) {
        output(
          {
            ok: false,
            error: "--image and text options (--text, --font, --font-size, --color) are mutually exclusive.",
          },
          isJson,
        );
        process.exitCode = 2;
        return;
      }

      // Generated-content ingestion (#107): --from-generation is an image
      // content option, mutually exclusive with --image and the text options;
      // --output selects one output of the job and is meaningless without it.
      if (values["from-generation"] !== undefined && !values["from-generation"].trim()) {
        output(
          { ok: false, error: "--from-generation takes a Generation Job id (see ply generate list)." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }
      if (
        values["from-generation"] !== undefined &&
        (values.image !== undefined || values.text !== undefined || values.font !== undefined ||
          values["font-size"] !== undefined || values.color !== undefined)
      ) {
        output(
          { ok: false, error: "--from-generation and --image/--text options are mutually exclusive content options." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }
      // Matting-content ingestion (#108): --from-matte is an image content
      // option, mutually exclusive with --image, --from-generation, and the
      // text options.
      if (values["from-matte"] !== undefined && !values["from-matte"].trim()) {
        output({ ok: false, error: "--from-matte takes a matte id (see ply matte)." }, isJson);
        process.exitCode = 2;
        return;
      }
      if (
        values["from-matte"] !== undefined &&
        (values.image !== undefined || values.text !== undefined || values.font !== undefined ||
          values["font-size"] !== undefined || values.color !== undefined || values["from-generation"] !== undefined)
      ) {
        output(
          { ok: false, error: "--from-matte and --image/--text/--from-generation options are mutually exclusive content options." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }
      if (values.output !== undefined && values["from-generation"] === undefined) {
        output(
          { ok: false, error: "--output is only valid together with --from-generation <jobId>." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }
      if (values.output !== undefined && !/^([1-9]\d*|[0-9a-f]{64})$/.test(values.output)) {
        output(
          { ok: false, error: `--output takes a 1-based output index or the full sha-256 output identity (got "${values.output}")` },
          isJson,
        );
        process.exitCode = 2;
        return;
      }

      const x = values.x !== undefined ? parseNumericArgument(values.x) : undefined;
      const y = values.y !== undefined ? parseNumericArgument(values.y) : undefined;
      const opacity = values.opacity !== undefined ? parseNumericArgument(values.opacity) : undefined;
      const fontSize = values["font-size"] !== undefined ? parseNumericArgument(values["font-size"]) : undefined;

      if (x !== undefined && !Number.isFinite(x)) {
        output({ ok: false, error: "Placement coordinate (--x) must be a finite number." }, isJson);
        process.exitCode = 2;
        return;
      }
      if (y !== undefined && !Number.isFinite(y)) {
        output({ ok: false, error: "Placement coordinate (--y) must be a finite number." }, isJson);
        process.exitCode = 2;
        return;
      }
      if (opacity !== undefined && (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)) {
        output({ ok: false, error: "Opacity (--opacity) must be a finite number between 0 and 1." }, isJson);
        process.exitCode = 2;
        return;
      }
      if (fontSize !== undefined && (!Number.isFinite(fontSize) || fontSize <= 0)) {
        output({ ok: false, error: "Font size (--font-size) must be a positive finite number." }, isJson);
        process.exitCode = 2;
        return;
      }

      // Resize flags (#133): syntax and well-formedness at the command
      // boundary; scale semantics, caps, and kind conflicts are enforced by
      // the edit path before any staging, so invalid resize inputs never
      // advance live state.
      if (values.resize !== undefined && values["resize-to"] !== undefined) {
        output(
          { ok: false, error: "--resize and --resize-to are mutually exclusive resize forms: use one per edit." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }
      let resizeFactor: number | undefined;
      if (values.resize !== undefined) {
        resizeFactor = parseNumericArgument(values.resize);
        if (!Number.isFinite(resizeFactor) || resizeFactor <= 0) {
          output(
            { ok: false, error: `Resize factor (--resize) must be a finite number greater than 0 (got "${values.resize}").` },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
      }
      let resizeTo: { width?: number; height?: number } | undefined;
      if (values["resize-to"] !== undefined) {
        const raw = values["resize-to"].trim();
        const m = raw.match(/^(\d+(?:\.\d+)?)?x(\d+(?:\.\d+)?)?$/);
        if (!m || (m[1] === undefined && m[2] === undefined)) {
          output(
            {
              ok: false,
              error:
                `--resize-to takes "<W>x<H>" (both axes: deliberate aspect change) or "<W>x" / "x<H>" ` +
                `(one axis: aspect preserved), e.g. "800x600", "800x", "x600" — got "${values["resize-to"]}".`,
            },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
        resizeTo = {
          ...(m[1] !== undefined ? { width: Number(m[1]) } : {}),
          ...(m[2] !== undefined ? { height: Number(m[2]) } : {}),
        };
      }

      // Rotate flag (#134): syntax and well-formedness at the command
      // boundary; the finite-number semantic check is enforced again by the
      // edit path before any staging, so an invalid angle never advances
      // live state.
      let rotateDeg: number | undefined;
      if (values.rotate !== undefined) {
        rotateDeg = parseNumericArgument(values.rotate);
        if (!Number.isFinite(rotateDeg)) {
          output(
            { ok: false, error: `Rotation (--rotate) must be a finite number of degrees, clockwise positive (got "${values.rotate}").` },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
      }

      // Flip flag (#135): the reflection mode is validated at the command
      // boundary as a usage error (exit 2), so an invalid mode never reaches
      // the edit path; the absolute-setter semantics are enforced again by
      // the edit path before any staging.
      let flip: "horizontal" | "vertical" | "both" | "none" | undefined;
      if (values.flip !== undefined) {
        const raw = values.flip.trim().toLowerCase();
        if (raw !== "horizontal" && raw !== "vertical" && raw !== "both" && raw !== "none") {
          output(
            { ok: false, error: `Flip (--flip) takes horizontal, vertical, both, or none (got "${values.flip}").` },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
        flip = raw;
      }

      // Shadow flag (#139, ADR-0018): syntax and well-formedness at the
      // command boundary as a usage error (exit 2) through the SAME parser
      // the edit path uses, so the two boundaries never disagree; the
      // absolute-setter semantics are enforced again by the edit path before
      // any staging.
      let shadowSpec: string | undefined;
      if (values.shadow !== undefined) {
        try {
          parseShadowSpec(values.shadow);
        } catch (err) {
          output({ ok: false, error: (err as Error).message }, isJson);
          process.exitCode = 2;
          return;
        }
        shadowSpec = values.shadow;
      }

      // Outline flag (#140, ADR-0019): syntax and well-formedness at the
      // command boundary as a usage error (exit 2) through the SAME parser
      // the edit path uses, so the two boundaries never disagree; the
      // absolute-setter semantics are enforced again by the edit path before
      // any staging.
      let outlineSpec: string | undefined;
      if (values.outline !== undefined) {
        try {
          parseOutlineSpec(values.outline);
        } catch (err) {
          output({ ok: false, error: (err as Error).message }, isJson);
          process.exitCode = 2;
          return;
        }
        outlineSpec = values.outline;
      }

      // Anchor flag (#138, ADR-0017): syntax and well-formedness at the
      // command boundary (exit 2); semantic refusals (no visible ink,
      // divergent multi-Composition geometry) happen in the read-only
      // resolution BEFORE the edit is invoked (exit 1) — so no anchored
      // input ever mutates live state.
      let parsedAnchor: ParsedAnchor | undefined;
      if (values.anchor !== undefined) {
        try {
          parsedAnchor = parseAnchorSpec(values.anchor);
        } catch (err) {
          output({ ok: false, error: (err as Error).message }, isJson);
          process.exitCode = 2;
          return;
        }
        // Anchored placement is its own edit: transform and content edits
        // change the reference ink, so combining them in one edit is a
        // conflicting request (the same precedent as resize + content
        // replacement). --opacity combines freely: opacity scales alpha
        // values, never the ink support.
        const conflicting =
          values.resize !== undefined ||
          values["resize-to"] !== undefined ||
          values.rotate !== undefined ||
          values.flip !== undefined ||
          values.shadow !== undefined ||
          values.outline !== undefined ||
          values.image !== undefined ||
          values["from-generation"] !== undefined ||
          values["from-matte"] !== undefined ||
          values.text !== undefined ||
          values.font !== undefined ||
          values["font-size"] !== undefined ||
          values.color !== undefined;
        if (conflicting) {
          output(
            {
              ok: false,
              error:
                "--anchor is its own edit: it cannot be combined with --resize, --resize-to, --rotate, --flip, --shadow, --outline, or content replacement in one edit, because the reference ink would be ambiguous. Make the transform or effect edit first, then anchor.",
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
              contextComposition: values.fork ? values.composition : undefined,
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
          composition: values.composition,
          use: values.use,
          image: values.image,
          fromGeneration:
            values["from-generation"] !== undefined
              ? { jobRoot: path.resolve("out", "generation"), jobId: values["from-generation"].trim(), output: values.output }
              : undefined,
          fromMatte:
            values["from-matte"] !== undefined
              ? {
                  matteRoot: path.resolve("out", "matting"),
                  matteId: values["from-matte"].trim(),
                  generationRoot: path.resolve("out", "generation"),
                }
              : undefined,
          text: values.text,
          font: values.font,
          fontSize,
          color: values.color,
          x: editX,
          y: editY,
          opacity,
          resizeFactor,
          resizeTo,
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
      const layerId = positionals[1];
      if (!layerId) {
        output({ ok: false, error: "Usage: ply layer inspect <layer-id>" }, isJson);
        process.exitCode = 2;
        return;
      }

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
      const layerId = positionals[1];
      if (!layerId) {
        output({ ok: false, error: "Usage: ply layer review <layer-id> --out <path>" }, isJson);
        process.exitCode = 2;
        return;
      }
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
