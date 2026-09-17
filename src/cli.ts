#!/usr/bin/env bun
/** Ply's entry point delegates to the command surfaces. */
import { fileURLToPath } from "node:url";
import { helpResult, wantsJson, usageMessage } from "./cli-present.js";

const commands = {
  project: "project-cli.ts",
  composition: "composition-cli.ts",
  layer: "layer-cli.ts",
  generate: "generation-cli.ts",
  matte: "matting-cli.ts",
  scene: "scene-cli.ts",
  library: "library-cli.ts",
  jobs: "job-cli.ts",
} as const;

const HELP = `Ply — the local image composer

New work goes through the current composer workflow:

  project        Create, select, and inspect self-contained Projects
  composition    Author Compositions: create, add Layers, import, remove,
                 reorder, inspect, measure, check, render, replay, and list
  layer          Inspect and edit Layers within a Project
  generate       Generate source images as Generation Jobs — one uniform
                 operation, full-canvas or isolated intent, no content policy
  matte          Matte a local image independently — one local true-alpha
                 operation, no Generation Job, no network

Retained legacy surfaces (preserved for existing work, not the entry path):

  scene          Author, inspect, and render Scenes locally (legacy)
  library        Inspect and maintain the asset library (legacy)
  jobs           Inspect the legacy Generation Job records — read-only;
                 generation and adoption are retired

Every command prints compact text by default and one valid JSON result under
--json. Run ply <module> --help for module commands and options.`;

const [command, ...args] = process.argv.slice(2);
const isJson = wantsJson(args) || command === "--json";
const routedModule = command === "--json" && args.length > 0 ? args[0]! : command;
// `ply --json <module> ...` routes with the presentation flag preserved for
// the module's own scan: the module position is consumed here.
const routedArgs = command === "--json" && args.length > 0 ? ["--json", ...args.slice(1)] : args;
const usageExit = (message: string): never => {
  const actionable = `${message}\nRun "ply --help" for the module list.`;
  // The same actionable message (correction + pointer) in both presentations.
  if (isJson) console.log(JSON.stringify({ ok: false, error: actionable }, null, 2));
  else console.error(actionable);
  process.exitCode = 2;
  process.exit(2);
};

if (!routedModule || routedModule === "--help" || routedModule === "-h") {
  // --help / -h (with or without --json) succeed with the routing help (#128).
  if (isJson) console.log(JSON.stringify(helpResult(HELP), null, 2));
  else console.log(HELP);
} else if (!Object.hasOwn(commands, routedModule)) {
  usageExit(`Unknown module: ${routedModule}.`);
} else {
  const script = new URL(commands[routedModule as keyof typeof commands], import.meta.url);
  const child = Bun.spawn([process.execPath, fileURLToPath(script), ...routedArgs], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
}
