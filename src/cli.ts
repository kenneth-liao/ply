#!/usr/bin/env bun
/** Ply's entry point delegates to the command surfaces. */
import { fileURLToPath } from "node:url";
const commands = {
  project: "project-cli.ts",
  composition: "composition-cli.ts",
  layer: "layer-cli.ts",
  scene: "scene-cli.ts",
  library: "library-cli.ts",
  jobs: "job-cli.ts",
} as const;

const [command, ...args] = process.argv.slice(2);
if (!command || command === "--help" || command === "-h") {
  console.log(`Ply — local image composition

Usage: ply <project|composition|layer|scene|library|jobs> <command> [options]

  project        Create, select, and inspect self-contained Projects
  composition    Create, add layers, import, remove, reorder, inspect, and list Compositions
  layer          Inspect and list Layers within a Project
  scene          Author, inspect, and render Scenes locally (legacy)
  library        Inspect and maintain the current asset library (legacy)
  jobs           Generate and review source images (legacy)

Run ply <module> --help for module commands.`);
} else if (!Object.hasOwn(commands, command)) {
  console.error(`Unknown module: ${command}. Use ply --help.`);
  process.exitCode = 2;
} else {
  const script = new URL(commands[command as keyof typeof commands], import.meta.url);
  const child = Bun.spawn([process.execPath, fileURLToPath(script), ...args], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
}
