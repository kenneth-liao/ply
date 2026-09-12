#!/usr/bin/env bun
// Project management CLI: create, select, and inspect self-contained Projects.
import { parseArgs } from "node:util";
import path from "node:path";
import { initProject, inspectProject, type ProjectInfo } from "./project.js";
import { helpResult, usageMessage, wantsJson } from "./cli-present.js";

const HELP = `
project — self-contained Project management

  ply project init [dir] [options]       Initialize a new Project at [dir] (defaults to current directory)
  ply project inspect [options]         Inspect a Project's state and statistics

Options:
  --project, -p <dir>   Path to the Project root directory (default: current working directory)
  --name <str>          Display name for the Project (defaults to directory name)
  --json                Emit machine-readable JSON output on stdout
  --help, -h            Show this help message
`;

function output(info: { ok: true; project: ProjectInfo } | { ok: false; error: string }, isJson: boolean, textFormatter?: () => void) {
  if (isJson) {
    console.log(JSON.stringify(info, null, 2));
  } else if (info.ok) {
    if (textFormatter) {
      textFormatter();
    } else {
      console.log(`Project: ${info.project.name} (schema v${info.project.schemaVersion})`);
      console.log(`Path: ${info.project.path}`);
      console.log(`Compositions: ${info.project.compositionsCount}`);
      console.log(`Layers: ${info.project.layersCount}`);
    }
  } else {
    console.error(`Error: ${info.error}`);
  }
}

const rawArgs = process.argv.slice(2);
const isJson = rawArgs.includes("--json");

let values: {
  project?: string;
  name?: string;
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
      name: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  values = parsed.values;
  positionals = parsed.positionals;
} catch (err) {
  output({ ok: false, error: usageMessage((err as Error).message, "project") }, isJson);
  process.exit(2);
}

if (values.help || positionals.length === 0) {
  if (isJson) console.log(JSON.stringify(helpResult(HELP.trim()), null, 2));
  else console.log(HELP);
  process.exit(0);
}

const command = positionals[0]!;

async function run() {
  if (command === "init") {
    const targetDir = positionals[1] ?? values.project ?? process.cwd();
    try {
      const project = await initProject(targetDir, { name: values.name });
      output(
        { ok: true, project },
        isJson,
        () => {
          console.log(`Initialized Project "${project.name}" (schema v${project.schemaVersion}) at ${project.path}`);
        },
      );
    } catch (err) {
      output({ ok: false, error: (err as Error).message }, isJson);
      process.exitCode = 1;
    }
  } else if (command === "inspect") {
    const targetDir = positionals[1] ?? values.project ?? process.cwd();
    try {
      const project = await inspectProject(targetDir);
      output({ ok: true, project }, isJson);
    } catch (err) {
      output({ ok: false, error: (err as Error).message }, isJson);
      process.exitCode = 1;
    }
  } else {
    const msg = `Unknown command "${command}". Available commands: init, inspect. See ply project --help.`;
    output({ ok: false, error: msg }, isJson);
    process.exitCode = 2;
  }
}

await run();
