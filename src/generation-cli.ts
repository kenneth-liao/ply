#!/usr/bin/env bun
/**
 * The uniform generation CLI (spec #102 ticket #104) — one source-image
 * generation operation with no subject category (ADR-0014):
 *
 *   ply generate <prompt> [options]   Start a Generation Job and publish its
 *                                     request, outputs, and provenance
 *   ply generate show <jobId>         Print one published record (offline)
 *   ply generate list                 Summarize published jobs (offline)
 *
 * Contract: compact default text, valid JSON under --json ({ok: true, ...} /
 * {ok: false, error}), exit codes 0 ok / 1 failure / 2 usage error. Failures
 * are actionable and publish nothing. No command here touches a Project or a
 * Layer, and none of them runs Matting: generation does not require Matting
 * weights (ADR-0015) and isolated intent is a generation request, not a matte.
 *
 * Records live under <cwd>/out/generation/<jobId>/ (see
 * docs/generation-publication-contract.md); the legacy out/jobs/ surface is
 * untouched. show and list are pure local reads — they never invoke
 * generation and work offline.
 */
import { parseArgs } from "node:util";
import path from "node:path";
import { generateImage, generateText } from "ai";
import {
  listGenerationJobs,
  loadGenerationJob,
  runUniformGeneration,
  type UniformGenerationRequest,
  type UniformProvider,
  type UniformSizing,
} from "./generation.js";
import { MODELS, DEFAULT_MODEL } from "./models.js";

const HELP = `
ply generate — one uniform source-image generation operation (Generation Jobs)

  bun run generate <prompt> [options]   Generate source images and publish a
                                        Generation Job record with the effective
                                        request, outputs, and provenance
  bun run generate show <jobId>         Print one published record (offline)
  bun run generate list                 Summarize published jobs (offline)

options
  --intent <i>          full-canvas (default) | isolated — the output shape as a
                        request parameter. Isolated is a generation request, NOT
                        verified alpha: invoke Matting explicitly (ADR-0015) for
                        a true-alpha matte. No content policy applies to the
                        prompt — text, logos, and likenesses are the caller's
                        decision (ADR-0014).
  --size <WxH>          Explicit pixel size for models that take a size
                        (e.g. --size 1080x1080). Default 1024x1024.
  --aspect <W:H>        Aspect ratio for models that take one (e.g. --aspect 4:5).
                        Default 1:1. Exactly one of --size / --aspect, matching
                        the model's call shape; a mismatch is refused before any
                        provider call.
  --model <name>        Registry key or raw gateway id. Keys:
                        ${Object.keys(MODELS).join(" | ")} (default: ${DEFAULT_MODEL})
  --count <n>           How many outputs to generate (default 1, max 8)
  --temperature <t>     Multimodal models only
  --job <id>            Explicit job id (default: auto gen-<date>-<suffix>)
  --json                Emit machine-readable JSON on stdout
  --help, -h            Show this help

Every output is content-addressed under <jobDir>/outputs/ with its sha-256 in
the record; a duplicate --job id is refused. Malformed requests, provider
errors, missing-image responses, and publication failures exit nonzero and
leave nothing published. This command never touches Projects or Layers, and it
never runs Matting — the independent matting operation is separate.
`;

export interface GenerationCliDeps {
  /** The provider seam (production: the AI SDK; tests: recording fakes). */
  provider: UniformProvider;
  /** Where job records live (default: <cwd>/out/generation). */
  jobsRoot: string;
}

/** The real provider paths: the AI SDK call shapes the seam forwards to. */
export const PRODUCTION_UNIFORM_PROVIDER: UniformProvider = {
  async image(args) {
    const result = await generateImage({
      model: args.model,
      prompt: args.prompt,
      ...(args.size ? { size: args.size } : {}),
      ...(args.aspectRatio ? { aspectRatio: args.aspectRatio } : {}),
    });
    return { images: result.images, warnings: result.warnings };
  },
  async text(args) {
    const result = await generateText({
      model: args.model,
      prompt: args.prompt,
      ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
    });
    return { files: result.files, text: result.text, warnings: result.warnings ?? [] };
  },
};

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
  | { kind: "show"; jobId?: string }
  | { kind: "list" }
  | {
      kind: "generate";
      prompt: string;
      intent?: string;
      sizingFlag?: { kind: "size"; raw: string } | { kind: "aspect"; raw: string };
      model?: string;
      count?: number;
      temperature?: number;
      jobId?: string;
      json: boolean;
    };

const SIZE_PATTERN = /^(\d+)[xX](\d+)$/;
const ASPECT_PATTERN = /^(\d+):(\d+)$/;

/**
 * Parse the CLI surface. Syntax problems are usage errors (exit 2); semantic
 * validation happens once in the domain (exit 1) at its ingestion boundary.
 */
function parse(args: string[]): Parsed {
  const json = args.includes("--json");
  let parsed: ReturnType<typeof doParse>;
  function doParse(rawArgs: string[]) {
    return parseArgs({
      args: rawArgs,
      allowPositionals: true,
      options: {
        intent: { type: "string" },
        size: { type: "string" },
        aspect: { type: "string" },
        model: { type: "string" },
        count: { type: "string" },
        temperature: { type: "string" },
        job: { type: "string" },
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

  const [first, ...restPositionals] = parsed.positionals;

  // Inspection subcommands: pure local reads, no generation flags.
  if (first === "show" || first === "list") {
    for (const flag of ["intent", "size", "aspect", "model", "count", "temperature", "job"] as const) {
      if (parsed.values[flag] !== undefined)
        return usage(`"generate ${first}" is an offline inspection command — it takes no generation flags (--${flag})`);
    }
    if (first === "list" && restPositionals.length > 0)
      return usage('"generate list" takes no arguments');
    if (first === "show" && restPositionals.length > 1)
      return usage('"generate show" takes exactly one <jobId>');
    return first === "show" ? { kind: "show", jobId: restPositionals[0] } : { kind: "list" };
  }

  const prompt = parsed.positionals.join(" ").trim();
  if (!prompt)
    return usage('"ply generate" needs a prompt describing the image to produce');

  let count: number | undefined;
  if (parsed.values.count !== undefined) {
    count = Number(parsed.values.count);
    if (!Number.isInteger(count) || count < 1 || count > 8)
      return usage("--count must be an integer between 1 and 8");
  }

  let temperature: number | undefined;
  if (parsed.values.temperature !== undefined) {
    temperature = Number(parsed.values.temperature);
    if (!Number.isFinite(temperature)) return usage("--temperature must be a number");
  }

  if (parsed.values.size !== undefined && parsed.values.aspect !== undefined)
    return usage("Pass either --size WxH or --aspect W:H, not both");
  if (parsed.values.size !== undefined && !SIZE_PATTERN.test(parsed.values.size))
    return usage(`--size takes WxH with positive integers, e.g. --size 1024x1024 (got "${parsed.values.size}")`);
  if (parsed.values.size !== undefined) {
    const [, w, h] = SIZE_PATTERN.exec(parsed.values.size)!;
    if (w === "0" || h === "0")
      return usage(`--size takes positive integers, e.g. --size 1024x1024 (got "${parsed.values.size}")`);
  }
  if (parsed.values.aspect !== undefined && !ASPECT_PATTERN.test(parsed.values.aspect))
    return usage(`--aspect takes W:H with positive integers, e.g. --aspect 16:9 (got "${parsed.values.aspect}")`);
  if (parsed.values.aspect !== undefined) {
    const [, w, h] = ASPECT_PATTERN.exec(parsed.values.aspect)!;
    if (w === "0" || h === "0")
      return usage(`--aspect takes W:H with positive integers, e.g. --aspect 16:9 (got "${parsed.values.aspect}")`);
  }
  if (parsed.values.intent !== undefined && parsed.values.intent !== "full-canvas" && parsed.values.intent !== "isolated")
    return usage(`--intent must be full-canvas or isolated (got "${parsed.values.intent}")`);

  return {
    kind: "generate",
    prompt,
    intent: parsed.values.intent,
    ...(parsed.values.size !== undefined
      ? { sizingFlag: { kind: "size", raw: parsed.values.size } as const }
      : {}),
    ...(parsed.values.aspect !== undefined
      ? { sizingFlag: { kind: "aspect", raw: parsed.values.aspect } as const }
      : {}),
    model: parsed.values.model,
    count,
    temperature,
    jobId: parsed.values.job,
    json,
  };
}

function usage(message: string): { kind: "usage"; message: string; error: string } {
  return { kind: "usage", message: `${message}\n${HELP.trim()}`, error: message };
}

/** Build the compact default text for a published/loaded job. */
function jobText(job: {
  jobId: string;
  request: { intent: string; prompt: string };
  run: { model: string; outputs: { file: string; contentHash: string }[]; warnings: string[] };
}): string {
  const lines = [
    `Generation Job ${job.jobId}`,
    `  prompt: ${job.request.prompt}`,
    `  intent: ${job.request.intent} · model: ${job.run.model} · outputs: ${job.run.outputs.length}`,
  ];
  for (const o of job.run.outputs) lines.push(`  output: ${o.file} (${o.contentHash.slice(0, 12)})`);
  for (const w of job.run.warnings) lines.push(`  warning: ${w}`);
  return lines.join("\n");
}

/** The caller sizing flag, normalized into the domain's sizing shape. */
function sizingFromFlag(flag: { kind: "size"; raw: string } | { kind: "aspect"; raw: string } | undefined): UniformSizing | undefined {
  if (!flag) return undefined;
  if (flag.kind === "size") {
    const [, w, h] = SIZE_PATTERN.exec(flag.raw)!;
    return { kind: "size", width: Number(w), height: Number(h) };
  }
  const [, w, h] = ASPECT_PATTERN.exec(flag.raw)!;
  return { kind: "aspectRatio", ratio: `${w}:${h}` };
}

/** The in-process entry — deps injected for deterministic tests. */
export async function run(
  args: string[],
  deps?: Partial<GenerationCliDeps>,
): Promise<CliResult> {
  const parsed = parse(args);

  if (parsed.kind === "usage")
    return { exitCode: 2, text: parsed.message, json: { ok: false, error: parsed.error } };

  const resolved: GenerationCliDeps = {
    provider: deps?.provider ?? PRODUCTION_UNIFORM_PROVIDER,
    jobsRoot: deps?.jobsRoot ?? path.resolve("out", "generation"),
  };

  try {
    if (parsed.kind === "help")
      return { exitCode: 0, text: HELP.trim(), json: { ok: true, help: HELP.trim() } };

    if (parsed.kind === "show") {
      if (!parsed.jobId) return usageResult('"generate show" takes exactly one <jobId>');
      const job = await loadGenerationJob(resolved.jobsRoot, parsed.jobId);
      return {
        exitCode: 0,
        text: jobText(job),
        json: { ok: true, jobId: job.jobId, jobDir: path.join(resolved.jobsRoot, job.jobId), job },
      };
    }

    if (parsed.kind === "list") {
      const jobs = await listGenerationJobs(resolved.jobsRoot);
      const text = jobs.length
        ? jobs.map((j) => `${j.jobId}  ${j.intent}  ${j.model}  ${j.outputs} output(s)`).join("\n")
        : "no Generation Jobs";
      return { exitCode: 0, text, json: { ok: true, jobs } };
    }

    const jobId = parsed.jobId || autoJobId();
    // No sizing flag: omitted — the domain fills the model-neutral default
    // (1024x1024 for size-kind models, 1:1 for everything else).
    const sizing = sizingFromFlag(parsed.sizingFlag);
    const job = await runUniformGeneration(
      resolved.jobsRoot,
      jobId,
      {
        prompt: parsed.prompt,
        intent: (parsed.intent as UniformGenerationRequest["intent"] | undefined) ?? "full-canvas",
        model: parsed.model ?? DEFAULT_MODEL,
        ...(sizing ? { sizing } : {}),
        count: parsed.count ?? 1,
        ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
      },
      { provider: resolved.provider },
    );
    return {
      exitCode: 0,
      text: jobText(job),
      json: { ok: true, jobId: job.jobId, jobDir: path.join(resolved.jobsRoot, job.jobId), job },
    };
  } catch (err) {
    const message = (err as Error).message || String(err);
    return { exitCode: 1, text: message, json: { ok: false, error: message } };
  }
}

function usageResult(message: string): CliResult {
  return { exitCode: 2, text: `${message}\n${HELP.trim()}`, json: { ok: false, error: message } };
}

function autoJobId(): string {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().slice(0, 8);
  return `gen-${day}-${suffix}`;
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