#!/usr/bin/env bun
// Layer management CLI: edit, inspect, and list Layers within a Project.
import { parseArgs } from "node:util";
import path from "node:path";
import { inspectLayer, listLayers, editLayer, roundEffective, type ResolvedLayer } from "./layer.js";
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
      the aspect ratio).

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
  resize?: string;
  "resize-to"?: string;
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
      resize: { type: "string" },
      "resize-to": { type: "string" },
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
        values.resize !== undefined ||
        values["resize-to"] !== undefined;

      if (!hasEditOption && !values.fork) {
        output(
          {
            ok: false,
            error:
              "No edit options provided: specify at least one of --image, --from-generation, --from-matte, --text, --font, --font-size, --color, --x, --y, --opacity, --resize, --resize-to, or --fork.",
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

      try {
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
          x,
          y,
          opacity,
          resizeFactor,
          resizeTo,
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
            if (res.fork) {
              console.log(
                `Forked Layer "${res.fork.previousLayerId}" -> new Layer "${res.layer.id}" -> revision ${res.layer.currentRevisionId} ` +
                  `(retargeted use "${res.fork.use}" in composition "${res.fork.composition}"; original Layer ${refMsg})${generated}${matted}${resized}`,
              );
            } else {
              console.log(`Edited Layer "${res.layer.id}" -> revision ${res.layer.currentRevisionId} (${refMsg})${generated}${matted}${resized}`);
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
            console.log(`  Placement: (${rev.x}, ${rev.y}), Opacity: ${rev.opacity}${scale}`);
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
