#!/usr/bin/env bun
/**
 * The independent local Matting CLI (spec #102 ticket #106, US-002/US-005,
 * DEC-004, ADR-0015) — one caller-invoked local operation with no Generation
 * Job, no library adoption, and no network:
 *
 *   ply matte <image> [--id <id>]   Isolate the image's subject with a
 *                                    true-alpha matte and publish the result
 *                                    with its Matting provenance
 *
 * Contract: compact default text, valid JSON under --json ({ok: true, ...} /
 * {ok: false, error}), exit codes 0 ok / 1 failure / 2 usage error. The
 * source bytes are never modified; failures publish nothing. This surface
 * imports no generation module: a natively isolated source is kept as-is with
 * no inference, and everything else runs through the pinned local segmenter
 * on this machine. Richer evidence inspection is #109's ownership; Project
 * ingestion of the published record is #108's.
 */
import { parseArgs } from "node:util";
import path from "node:path";
import { runMatting, MATTE_ID_PATTERN } from "./matting.js";
import { localSegmentationMatteEngine, ENGINE_ID } from "./segment.js";
import type { MatteEngine } from "./matte.js";

const HELP = `
ply matte — one independent local Matting operation (no Generation Job, no adoption)

  bun run matte <image> [options]   Isolate the image's subject with a true-alpha
                                    matte and publish the result and provenance
                                    under out/matting/<matteId>/

options
  --id <id>             Explicit matte id (default: auto matte-<date>-<suffix>).
                        An existing id is refused — a matte's lineage is never
                        overwritten.
  --json                Emit machine-readable JSON on stdout
  --help, -h            Show this help

The input is a caller-selected local PNG — convert other formats locally with
an offline tool first. A source that already carries a real matte is kept
as-is with no inference (engine "native-alpha"); anything else runs through
the pinned BiRefNet Dynamic segmenter (${ENGINE_ID}) on PyTorch/MPS on this
machine — no network, no generation. Engine preflight runs before inference:
missing or mismatched weights, or a machine without MPS, are refused with
the fix, before anything is published. An unusable result (everything opaque, everything transparent) is
refused at the pass that produced it.

The source bytes are never modified: the result is published content-addressed
beside matte.json — the provenance record tracing the source identity and the
engine (docs/matting-publication-contract.md). Inference records also retain
a content-addressed copy of the exact source bytes (sources/<sha256>.png) so
rematting never depends on the original path: run "ply matte" on that
retained path to publish a new matte id. Failures publish nothing and
exit nonzero.
`;

export interface MattingCliDeps {
  /** The matting seam (production: the local segmenter; tests: fakes). */
  engine: MatteEngine;
  /** Where matte records live (default: <cwd>/out/matting). */
  matteRoot: string;
}

export interface CliResult {
  exitCode: 0 | 1 | 2;
  /** Compact human text — printed to stdout on success, stderr on failure. */
  text: string;
  /** The structured JSON payload emitted under --json. */
  json: unknown;
}

type Parsed =
  | { kind: "usage"; message: string; error: string }
  | { kind: "help" }
  | { kind: "matte"; source: string; matteId?: string; json: boolean };

/** Parse the CLI surface. Syntax problems are usage errors (exit 2). */
function parse(args: string[]): Parsed {
  let parsed: ReturnType<typeof doParse>;
  function doParse(rawArgs: string[]) {
    return parseArgs({
      args: rawArgs,
      allowPositionals: true,
      options: {
        id: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  }
  try {
    parsed = doParse(args);
  } catch (err) {
    return usage((err as Error).message);
  }
  if (parsed.values.help) return { kind: "help" };
  const positionals = parsed.positionals;
  if (positionals.length === 0)
    return usage('"ply matte" needs the path to a local PNG image to matte');
  if (positionals.length > 1)
    return usage('"ply matte" takes exactly one <image> path');
  if (parsed.values.id !== undefined && !MATTE_ID_PATTERN.test(parsed.values.id))
    return usage(`--id takes a matte id of lowercase letters/digits/hyphens (got "${parsed.values.id}")`);
  return {
    kind: "matte",
    source: positionals[0]!,
    matteId: parsed.values.id,
    json: parsed.values.json,
  };
}

function usage(message: string): { kind: "usage"; message: string; error: string } {
  return { kind: "usage", message: `${message}\n${HELP.trim()}`, error: message };
}

/** Build the compact default text for a published/loaded matte. */
function matteText(matte: {
  matteId: string;
  request: { source: { path: string; contentHash: string; file?: string } };
  result: {
    engine: string;
    backend?: string;
    timing?: { millis: number; scope: string };
    alpha: { width: number; height: number; transparentPx: number; opaquePx: number };
    outputs: { file: string; contentHash: string }[];
    warnings: string[];
  };
}): string {
  const lines = [
    `Matte ${matte.matteId}`,
    `  source: ${matte.request.source.path} (${matte.request.source.contentHash.slice(0, 12)})`,
    `  engine: ${matte.result.engine}`,
  ];
  if (matte.request.source.file !== undefined)
    lines.push(`  source-copy: ${matte.request.source.file}`);
  if (matte.result.backend !== undefined) lines.push(`  backend: ${matte.result.backend}`);
  if (matte.result.timing !== undefined)
    lines.push(`  timing: ${matte.result.timing.millis} ms (${matte.result.timing.scope})`);
  for (const o of matte.result.outputs)
    lines.push(`  output: ${o.file} (${o.contentHash.slice(0, 12)}) · ${matte.result.alpha.width}×${matte.result.alpha.height}`);
  for (const w of matte.result.warnings) lines.push(`  warning: ${w}`);
  return lines.join("\n");
}

/** The in-process entry — deps injected for deterministic tests. */
export async function run(
  args: string[],
  deps?: Partial<MattingCliDeps>,
): Promise<CliResult> {
  const parsed = parse(args);

  if (parsed.kind === "usage")
    return { exitCode: 2, text: parsed.message, json: { ok: false, error: parsed.error } };

  const resolved: MattingCliDeps = {
    engine: deps?.engine ?? localSegmentationMatteEngine(),
    matteRoot: deps?.matteRoot ?? path.resolve("out", "matting"),
  };

  if (parsed.kind === "help")
    return { exitCode: 0, text: HELP.trim(), json: { ok: true, help: HELP.trim() } };

  const matteId =
    parsed.matteId ??
    `matte-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const matte = await runMatting(resolved.matteRoot, matteId, parsed.source, {
      engine: resolved.engine,
    });
    return {
      exitCode: 0,
      text: matteText(matte),
      json: {
        ok: true,
        matteId: matte.matteId,
        matteDir: path.join(resolved.matteRoot, matte.matteId),
        matte,
      },
    };
  } catch (err) {
    const message = (err as Error).message || String(err);
    return { exitCode: 1, text: message, json: { ok: false, error: message } };
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const isJson = argv.includes("--json");
  const { exitCode, text, json } = await run(argv);
  if (isJson) console.log(JSON.stringify(json, null, 2));
  else if (exitCode === 0) console.log(text);
  else console.error(text);
  process.exit(exitCode);
}