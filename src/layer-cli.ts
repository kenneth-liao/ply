#!/usr/bin/env bun
// Layer management CLI: edit, inspect, and list Layers within a Project.
import { parseArgs } from "node:util";
import path from "node:path";
import { inspectLayer, listLayers, editLayer, type ResolvedLayer } from "./layer.js";
import { closeCliBrowser } from "./cli-browser.js";

const HELP = `
layer — Layer management and inspection within a Project

  bun run ply layer edit <layer-id> [options]
      Edit a Layer's content or placement, advancing its current revision.
      Requires --in-place when referenced by multiple Compositions.

  bun run ply layer inspect <layer-id> [options]
      Inspect a Layer's identity, current revision, and content details

  bun run ply layer list [options]
      List all Layers in the Project

Options:
  --project, -p <dir>   Path to Project root (default: current working directory)
  --in-place            Explicitly advance Layer revision in-place across all
                        referring Compositions (required when referrers > 1)
  --image <path>        New source image file for an image Layer
  --text <str>          New text content for a text Layer
  --font <family>       Bundled font family name for a text Layer
  --font-size <num>     Font size in px for a text Layer
  --color <hex>         Text color as #RGB or #RRGGBB
  --x <num>             X position on canvas
  --y <num>             Y position on canvas
  --opacity <num>       Layer opacity between 0 and 1
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
  image?: string;
  text?: string;
  font?: string;
  "font-size"?: string;
  color?: string;
  x?: string;
  y?: string;
  opacity?: string;
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
      image: { type: "string" },
      text: { type: "string" },
      font: { type: "string" },
      "font-size": { type: "string" },
      color: { type: "string" },
      x: { type: "string" },
      y: { type: "string" },
      opacity: { type: "string" },
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
        values.text !== undefined ||
        values.font !== undefined ||
        values["font-size"] !== undefined ||
        values.color !== undefined ||
        values.x !== undefined ||
        values.y !== undefined ||
        values.opacity !== undefined;

      if (!hasEditOption) {
        output(
          {
            ok: false,
            error:
              "No edit options provided: specify at least one of --image, --text, --font, --font-size, --color, --x, --y, --opacity.",
          },
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

      try {
        const res = await editLayer(targetProj, layerId, {
          inPlace: values["in-place"],
          image: values.image,
          text: values.text,
          font: values.font,
          fontSize,
          color: values.color,
          x,
          y,
          opacity,
        });

        output(
          {
            ok: true,
            layer: res.layer,
            referringCompositions: res.referringCompositions,
            referrersCount: res.referrersCount,
          },
          isJson,
          () => {
            const refMsg =
              res.referrersCount === 0
                ? "not referenced by any Composition"
                : `referenced by ${res.referrersCount} Composition${res.referrersCount === 1 ? "" : "s"} (${res.referringCompositions.map((n) => `"${n}"`).join(", ")})`;
            console.log(`Edited Layer "${res.layer.id}" -> revision ${res.layer.currentRevisionId} (${refMsg})`);
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
            console.log(`  Placement: (${rev.x}, ${rev.y}), Opacity: ${rev.opacity}`);
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
      const msg = `Unknown command "${command}". Available commands: edit, inspect, list. See ply layer --help.`;
      output({ ok: false, error: msg }, isJson);
      process.exitCode = 2;
    }
  } finally {
    await closeCliBrowser();
  }
}

await run();
