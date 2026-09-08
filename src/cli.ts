#!/usr/bin/env bun
/** Ply's entry point delegates to the existing command surfaces unchanged. */
import { fileURLToPath } from "node:url";
const commands = {
  project: "project-cli.ts",
  scene: "scene-cli.ts",
  library: "library-cli.ts",
  jobs: "job-cli.ts",
} as const;

const [command, ...args] = process.argv.slice(2);
if (!command || command === "--help" || command === "-h") {
  console.log(`Ply — local image composition

Usage: ply <project|scene|library|jobs> <command> [options]

  project    Create, select, and inspect self-contained Projects
  scene      Author, inspect, and render Scenes locally
  library    Inspect and maintain the current asset library
  jobs       Generate and review source images

Run ply <module> --help for module commands.
The general-purpose edit/compose/generate surface is not implemented yet.`);
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
