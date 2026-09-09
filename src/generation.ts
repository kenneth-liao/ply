/**
 * The uniform Generation Job domain (spec #102 ticket #104, ADR-0014).
 *
 * One prompt-only source-image operation: a caller prompt, an output intent
 * (full-canvas or isolated — a request parameter, not a subject category),
 * caller-selected sizing, and a count. There is no subject taxonomy, no text
 * or logo ban, no mandatory identity Reference, and no approval gate here
 * (ADR-0014); provider capability remains the provider's own explicit
 * validation — Ply forwards the request as made.
 *
 * Matting is NOT part of this operation (ADR-0015): this module never imports
 * the Matting engine, and isolated intent is a generation request, never
 * verified alpha. The result says so in its warnings.
 *
 * Publication (the contract #105/#107/#108/#109 consume — see
 * docs/generation-publication-contract.md): a record lives at
 * <jobRoot>/<jobId>/job.json beside content-addressed outputs/. The record is
 * written only after every output byte is persisted; a caught failure removes
 * the freshly created job directory and reports nothing successful.
 *
 * This record is deliberately separate from the legacy Plate/Object/Creator
 * job records under out/jobs/ (see the contract doc for why). Old entry
 * points keep working untouched; retirement is separately owned (#114/#115).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  resolveModel,
  type ModelSpec,
} from "./models.js";
import { extensionFor } from "./assets.js";
import { buildImageRequestArgs, describeWarning } from "./generate.js";

/** Output intent — a generation request parameter, not a content category. */
export type GenerationIntent = "full-canvas" | "isolated";

/** Caller-selected sizing. Never defaulted to any platform geometry. */
export type UniformSizing =
  | { kind: "size"; width: number; height: number }
  | { kind: "aspectRatio"; ratio: string };

export interface UniformGenerationRequest {
  /** The caller's prompt, normalized (trimmed) at this one boundary. */
  prompt: string;
  intent: GenerationIntent;
  /** Registry key or raw gateway id, as the caller wrote it. */
  model: string;
  /**
   * The caller's sizing selection. Omitted sizing is filled with the
   * model-neutral default (1024x1024 / 1:1); a mismatch with the model's
   * provider call shape is refused. See validateUniformRequest.
   */
  sizing?: UniformSizing;
  count: number;
  /** Multimodal models only. */
  temperature?: number;
}

/** A request after validateUniformRequest: sizing is normalized and always present. */
export type NormalizedUniformRequest = UniformGenerationRequest & { sizing: UniformSizing };

/** One generated output: content identity and its job-relative file. */
export interface UniformOutput {
  contentHash: string;
  /** Path relative to the job directory. */
  file: string;
  mediaType: string;
}

/** The provenance record of the single run this Job publishes. */
export interface UniformRun {
  ranAt: string;
  /** The resolved provider model id actually called. */
  model: string;
  /** The effective text sent to the model. */
  fullPrompt: string;
  costUsd: number | null;
  costMeasured: boolean;
  warnings: string[];
  outputs: UniformOutput[];
}

export const GENERATION_JOB_SCHEMA_VERSION = 1;

export interface GenerationJobRecord {
  schemaVersion: typeof GENERATION_JOB_SCHEMA_VERSION;
  jobId: string;
  kind: "generation";
  createdAt: string;
  request: NormalizedUniformRequest;
  run: UniformRun;
}

export interface GenerationJobSummary {
  jobId: string;
  createdAt: string;
  intent: GenerationIntent;
  model: string;
  outputs: number;
}

/**
 * The provider seam — the exact outbound request a test can capture. The
 * production adapter wraps the AI SDK; tests inject recording fakes.
 * Prompt-only in this ticket; #105 extends these shapes with References.
 */
export interface ProviderImageRequest {
  model: string;
  prompt: string;
  /** Explicit pixel size — models that take a size. */
  size?: `${number}x${number}`;
  /** Aspect ratio — models that take an aspect ratio. */
  aspectRatio?: `${number}:${number}`;
}

export interface ProviderTextRequest {
  model: string;
  prompt: string;
  /** Multimodal models only. */
  temperature?: number;
}

export interface UniformProvider {
  image(args: ProviderImageRequest): Promise<{
    images: { base64: string }[];
    warnings: unknown[];
  }>;
  text(args: ProviderTextRequest): Promise<{
    files: { mediaType?: string; uint8Array: Uint8Array }[];
    text: string;
    warnings: unknown[];
  }>;
}

/**
 * Isolation framing for isolated intent: the format the later local matting
 * pass needs — margins, a plain flat background, crisp edges — and never a
 * request for transparency, a painted checkerboard, or true alpha (ADR-0015:
 * image models asked for transparency return opaque pixels or fake one).
 */
const ISOLATED_FORMAT_LINE =
  "Format: exactly one single isolated subject, fully inside the frame with clear margins on all sides, on a plain, uniform, evenly lit background with crisp, well-defined edges — suitable for later local isolation.";

/** The warning every isolated-intent run records: intent is not a matte. */
export const ISOLATED_INTENT_WARNING =
  "isolated: isolated intent is a generation request, not a matte — the output is not verified alpha; invoke Matting explicitly (ADR-0015) for verified true alpha";

const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function jobDir(jobRoot: string, jobId: string): string {
  return path.join(jobRoot, jobId);
}

/** Model-neutral defaults, applied when the caller gives no sizing flag. */
const DEFAULT_SIZE = { kind: "size", width: 1024, height: 1024 } as const;
const DEFAULT_ASPECT = { kind: "aspectRatio", ratio: "1:1" } as const;

export interface ValidatedUniformRequest {
  request: NormalizedUniformRequest;
  spec: ReturnType<typeof resolveModel>;
}

/**
 * The one ingestion point for uniform generation requests: external input
 * becomes the canonical normalized shape here, so every downstream reader can
 * assume it. All semantic validation happens before any provider call — a
 * refused request costs nothing. The returned request carries the effective
 * (default-filled, normalized) sizing the record will publish.
 */
export function validateUniformRequest(input: UniformGenerationRequest): ValidatedUniformRequest {
  if (!input.prompt.trim())
    throw new Error("A generation request needs a non-empty prompt describing the image to produce");
  if (input.intent !== "full-canvas" && input.intent !== "isolated")
    throw new Error(
      `Unknown intent "${String(input.intent)}" — use --intent full-canvas or --intent isolated`,
    );
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 8)
    throw new Error("--count must be an integer between 1 and 8");

  const spec = resolveModel(input.model);

  const sizing = normalizeSizing(input.sizing, spec);
  // Sizing must match the model's provider call shape — a mismatch is refused
  // here, before any provider call (provider capability stays explicit).
  if (sizing.kind === "size" && spec.sizing !== "size")
    throw new Error(
      `Model "${spec.id}" takes an aspect ratio, not explicit pixel dimensions — pass --aspect W:H (e.g. --aspect 1:1), not --size`,
    );
  if (sizing.kind === "aspectRatio" && spec.sizing === "size")
    throw new Error(
      `Model "${spec.id}" takes explicit pixel dimensions — pass --size WxH (e.g. --size 1024x1024), not --aspect`,
    );
  if (input.temperature != null && spec.kind !== "multimodal")
    throw new Error(
      `--temperature only applies to multimodal models (Gemini); "${spec.id}" is an image model`,
    );

  const request: NormalizedUniformRequest = {
    prompt: input.prompt.trim(),
    intent: input.intent,
    model: input.model,
    sizing,
    count: input.count,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  };
  return { request, spec };
}

/**
 * Normalize the caller's sizing into the canonical shape. An omitted sizing
 * fills with the model-neutral default for the resolved model kind; an
 * explicit value is format-checked and re-serialized from its parsed numbers.
 */
function normalizeSizing(
  sizing: UniformSizing | undefined,
  spec: ReturnType<typeof resolveModel>,
): UniformSizing {
  if (!sizing) return spec.sizing === "size" ? { ...DEFAULT_SIZE } : { ...DEFAULT_ASPECT };
  if (sizing.kind === "size") {
    if (!Number.isInteger(sizing.width) || !Number.isInteger(sizing.height) || sizing.width < 1 || sizing.height < 1)
      throw new Error(
        `Invalid sizing ${JSON.stringify(`${sizing.width}x${sizing.height}`)} — --size takes positive integers, e.g. --size 1024x1024`,
      );
    return { kind: "size", width: sizing.width, height: sizing.height };
  }
  const m = /^(\d+):(\d+)$/.exec(sizing.ratio);
  if (!m || m[1] === "0" || m[2] === "0")
    throw new Error(
      `Malformed aspect ratio "${sizing.ratio}" — use W:H with positive integers, e.g. --aspect 16:9`,
    );
  return { kind: "aspectRatio", ratio: `${m[1]}:${m[2]}` };
}

/**
 * Read one published record. Missing, corrupt, or contradictory records fail
 * loudly here — the single ingestion point for record readers (show, list,
 * and the dependent tickets' consumers).
 */
export async function loadGenerationJob(jobRoot: string, jobId: string): Promise<GenerationJobRecord> {
  if (!JOB_ID_PATTERN.test(jobId))
    throw new Error(`Invalid job id "${jobId}" — use lowercase letters/digits/hyphens`);
  let raw: string;
  try {
    raw = await readFile(path.join(jobDir(jobRoot, jobId), "job.json"), "utf8");
  } catch {
    throw new Error(`No generation job "${jobId}" under ${jobRoot}`);
  }
  try {
    const job = JSON.parse(raw) as GenerationJobRecord;
    if (job.schemaVersion !== GENERATION_JOB_SCHEMA_VERSION)
      throw new Error(
        `unsupported job schemaVersion ${JSON.stringify(job.schemaVersion)} — this tool reads version ${GENERATION_JOB_SCHEMA_VERSION} only`,
      );
    if (job.kind !== "generation")
      throw new Error(
        `Job "${jobId}" is contradictory: kind ${JSON.stringify(job.kind)} is not a uniform generation record — it cannot be trusted and will not run`,
      );
    if (typeof job.request?.prompt !== "string" || (job.request.intent !== "full-canvas" && job.request.intent !== "isolated"))
      throw new Error(
        `Job "${jobId}" is unreadable: its request is not a valid uniform generation request`,
      );
    if (job.request.sizing?.kind !== "size" && job.request.sizing?.kind !== "aspectRatio")
      throw new Error(
        `Job "${jobId}" is unreadable: its request sizing is not a valid uniform sizing`,
      );
    if (!Array.isArray(job.run?.outputs))
      throw new Error(`Job "${jobId}" is unreadable: its run has no outputs record`);
    return job;
  } catch (err) {
    // JSON.parse failure is the one case this catch wraps; the shape checks
    // above throw their own actionable messages and are not re-wrapped.
    if (err instanceof SyntaxError)
      throw new Error(`Job "${jobId}" has an unreadable record: ${(err as Error).message}`);
    throw err;
  }
}

/** Summaries of every readable published job, sorted by id. */
export async function listGenerationJobs(jobRoot: string): Promise<GenerationJobSummary[]> {
  let entries: string[];
  try {
    entries = (await stat(jobRoot)).isDirectory() ? await readdir(jobRoot) : [];
  } catch {
    return [];
  }
  const jobs: GenerationJobSummary[] = [];
  for (const entry of entries.sort()) {
    try {
      const job = await loadGenerationJob(jobRoot, entry);
      jobs.push({
        jobId: job.jobId,
        createdAt: job.createdAt,
        intent: job.request.intent,
        model: job.run.model,
        outputs: job.run.outputs.length,
      });
    } catch {
      // Unreadable directories are not jobs (temp files, partial writes) — skip.
    }
  }
  return jobs;
}

/**
 * The effective prompt for a validated request. The caller's prompt is
 * authoritative and passes through verbatim. Isolated intent adds the one
 * isolation-format line (never a transparency request — ADR-0015). Multimodal
 * models carry their selected aspect ratio in the prompt, because their text
 * call shape has no sizing parameter. Nothing else is added: no zone, no
 * subject bans, no identity recipe (ADR-0014).
 */
export function buildUniformPrompt(request: NormalizedUniformRequest, spec: ModelSpec): string {
  const lines = [request.prompt];
  if (request.intent === "isolated") lines.push("", ISOLATED_FORMAT_LINE);
  if (spec.kind === "multimodal" && request.sizing.kind === "aspectRatio")
    lines.push(`Output aspect ratio: ${request.sizing.ratio}.`);
  return lines.join("\n");
}

/** The provider request for one candidate of a validated request. Image-kind
 * requests are built through buildImageRequestArgs — the one home of the
 * image-kind provider request shape — so the uniform surface can never drift
 * from the legacy call shape.
 */
function buildProviderRequest(
  request: NormalizedUniformRequest,
  spec: ModelSpec,
  fullPrompt: string,
): ProviderImageRequest | ProviderTextRequest {
  if (spec.kind === "multimodal") {
    return {
      model: spec.id,
      prompt: fullPrompt,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
  }
  // No References on this surface (prompt-only), so the built prompt is the
  // plain string form by construction.
  return buildImageRequestArgs(
    spec,
    fullPrompt,
    [],
    request.sizing.kind === "size"
      ? { size: `${request.sizing.width}x${request.sizing.height}` }
      : { aspectRatio: `${request.sizing.ratio}` as `${number}:${number}` },
  ) as ProviderImageRequest;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Execute a validated request and publish the Generation Job. Outputs are
 * persisted first (content-addressed), the record written last; any caught
 * failure removes the freshly created job directory, so nothing is left that
 * reports success — and no existing Project state is ever touched.
 */
export async function runUniformGeneration(
  jobRoot: string,
  jobId: string,
  input: UniformGenerationRequest,
  deps: { provider: UniformProvider },
): Promise<GenerationJobRecord> {
  if (!JOB_ID_PATTERN.test(jobId))
    throw new Error(`Invalid job id "${jobId}" — use lowercase letters/digits/hyphens`);
  const dir = jobDir(jobRoot, jobId);
  if (existsSync(path.join(dir, "job.json")))
    throw new Error(
      `Generation Job "${jobId}" already exists — pick a new id to record a new request (a Job's lineage is never overwritten)`,
    );

  const { request, spec } = validateUniformRequest(input);
  const fullPrompt = buildUniformPrompt(request, spec);
  const providerRequest = buildProviderRequest(request, spec, fullPrompt);
  const now = new Date().toISOString();

  try {
    // All candidates first — every byte on disk before anything is recorded.
    await mkdir(path.join(dir, "outputs"), { recursive: true });
    const outputs: UniformOutput[] = [];
    const warnings: string[] = [];
    if (request.intent === "isolated") warnings.push(ISOLATED_INTENT_WARNING);

    for (let i = 0; i < request.count; i++) {
      const { bytes, mediaType, providerWarnings } = await callProvider(spec, providerRequest, deps.provider);
      const contentHash = sha256(bytes);
      const file = path.join("outputs", `${contentHash}.${extensionFor(mediaType)}`);
      await writeFile(path.join(dir, file), bytes);
      outputs.push({ contentHash, file, mediaType });
      warnings.push(...providerWarnings.map((w) => describeWarning(spec.id, w)));
    }

    const job: GenerationJobRecord = {
      schemaVersion: GENERATION_JOB_SCHEMA_VERSION,
      jobId,
      kind: "generation",
      createdAt: now,
      request,
      run: {
        ranAt: now,
        model: spec.id,
        fullPrompt,
        costUsd: spec.approxCost * outputs.length,
        costMeasured: spec.costMeasured,
        warnings: [...new Set(warnings)],
        outputs,
      },
    };
    // The commit point: only now does a successful-looking record exist.
    await writeFile(path.join(dir, "job.json"), JSON.stringify(job, null, 2) + "\n");
    return job;
  } catch (err) {
    // Publication discipline: a caught failure removes only what this run
    // created — the whole directory is fresh by the job.json check above.
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/** One provider call for the request's model kind; missing images are refused here. */
async function callProvider(
  spec: ModelSpec,
  providerRequest: ProviderImageRequest | ProviderTextRequest,
  provider: UniformProvider,
): Promise<{ bytes: Uint8Array; mediaType: string; providerWarnings: unknown[] }> {
  if (spec.kind === "multimodal") {
    const result = await provider.text(providerRequest as ProviderTextRequest);
    const file = result.files.find((f) => f.mediaType?.startsWith("image/"));
    if (!file)
      throw new Error(`${spec.id} returned no image. Text response: ${result.text.slice(0, 300)}`);
    return { bytes: file.uint8Array, mediaType: file.mediaType ?? "image/png", providerWarnings: result.warnings ?? [] };
  }
  const result = await provider.image(providerRequest as ProviderImageRequest);
  const image = result.images[0];
  if (!image) throw new Error(`${spec.id} returned no image.`);
  return {
    bytes: Buffer.from(image.base64, "base64"),
    mediaType: "image/png",
    providerWarnings: result.warnings ?? [],
  };
}