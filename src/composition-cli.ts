#!/usr/bin/env bun
// Composition management CLI: create, add layers, inspect, and list Compositions.
import { parseArgs } from "node:util";
import path from "node:path";
import {
  createComposition,
  addLayerToComposition,
  inspectComposition,
  listCompositions,
  type ResolvedComposition,
} from "./composition.js";
import { closeBrowser } from "./browser.js";

const HELP = `
composition — Composition authoring and inspection

  bun run ply composition create <name> --width <w> --height <h> [options]
      Create a new Composition with explicit canvas dimensions

  bun run ply composition add <comp> <name> --image <path> [options]
      Add a local image Layer to a Composition with optional placement

  bun run ply composition inspect <name> [options]
      Inspect a Composition's canvas and ordered Layers

  bun run ply composition list [options]
      List all Compositions in the Project

Options:
  --project, -p <dir>   Path to Project root (default: current working directory)
  --width <int>         Canvas width in pixels (required for create)
  --height <int>        Canvas height in pixels (required for create)
  --image <path>        Path to local source image file (required for add)
  --x <num>             X position on canvas (default: 0)
  --y <num>             Y position on canvas (default: 0)
  --opacity <num>       Layer opacity between 0 and 1 (default: 1)
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

const rawArgs = process.argv.slice(2);
const isJson = rawArgs.includes("--json");

let values: {
  project?: string;
  width?: string;
  height?: string;
  image?: string;
  x?: string;
  y?: string;
  opacity?: string;
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
      width: { type: "string" },
      height: { type: "string" },
      image: { type: "string" },
      x: { type: "string" },
      y: { type: "string" },
      opacity: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
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
        output({ ok: false, error: "Usage: ply composition add <composition> <local-name> --image <path>" }, isJson);
        process.exitCode = 2;
        return;
      }
      if (!values.image) {
        output({ ok: false, error: "Missing required option: --image <path>" }, isJson);
        process.exitCode = 2;
        return;
      }

      const x = values.x !== undefined ? parseNumericArgument(values.x) : 0;
      const y = values.y !== undefined ? parseNumericArgument(values.y) : 0;
      const opacity = values.opacity !== undefined ? parseNumericArgument(values.opacity) : 1.0;

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        output({ ok: false, error: "Placement coordinates (--x, --y) must be finite numbers." }, isJson);
        process.exitCode = 2;
        return;
      }
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
        output({ ok: false, error: "Opacity (--opacity) must be a finite number between 0 and 1." }, isJson);
        process.exitCode = 2;
        return;
      }

      try {
        const res = await addLayerToComposition(targetProj, compName, localName, values.image, { x, y, opacity });
        output(
          { ok: true, composition: res.composition, use: res.use, layer: res.layer },
          isJson,
          () => {
            console.log(
              `Added Layer "${res.use.name}" (${res.use.layerId}) to Composition "${res.composition}" ` +
                `[${res.layer.currentRevision.width}×${res.layer.currentRevision.height} ${res.layer.currentRevision.format}]`,
            );
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
              console.log(
                `  ${idx + 1}. "${layer.name}" [${layer.layerId}] (${rev.kind}, ${rev.width}×${rev.height} ${rev.format}) ` +
                  `@ (${rev.x}, ${rev.y}) opacity: ${rev.opacity}`,
              );
            });
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
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
      const msg = `Unknown command "${command}". Available commands: create, add, inspect, list. See ply composition --help.`;
      output({ ok: false, error: msg }, isJson);
      process.exitCode = 2;
    }
  } finally {
    await closeBrowser().catch(() => {});
  }
}

await run();

/** Blank supplied values are invalid, never implicit zero. */
function parseNumericArgument(value: string | undefined): number {
  return value?.trim() ? Number(value) : NaN;
}
