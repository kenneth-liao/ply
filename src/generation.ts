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
  referenceIncompatibilityError,
  validateQualitySupport,
  isImageQuality,
  type ImageQuality,
  type ModelSpec,
} from "./models.js";
import { extensionFor } from "./assets.js";
import { buildImageRequestArgs, describeWarning, loadVerifiedReference } from "./generate.js";

/** Output intent — a generation request parameter, not a content category. */
export type GenerationIntent = "full-canvas" | "isolated";

/** Caller-selected sizing. Never defaulted to any platform geometry. */
export type UniformSizing =
  | { kind: "size"; width: number; height: number }
  | { kind: "aspectRatio"; ratio: string };

/** A Reference after ingestion: caller path and the identity derived once at Job creation. */
export interface UniformReference {
  path: string;
  contentHash: string;
}

export interface UniformGenerationRequest {
  /** The caller's prompt, normalized (trimmed) at this one boundary. */
  prompt: string;
  intent: GenerationIntent;
  /** Registry key or raw gateway id, as the caller wrote it. */
  model: string;
  /**
   * The caller-selected sizing selection. Omitted sizing is filled with the
   * model-neutral default (1024x1024 / 1:1); a mismatch with the model's
   * provider call shape is refused. See validateUniformRequest.
   */
  sizing?: UniformSizing;
  /**
   * An explicit GPT Image 2 quality selection (spec #132 #142): low, medium,
   * or high. Only models with qualified quality tiers accept one; unsupported
   * model/quality combinations are refused before any provider call. An
   * omitted selection is NOT defaulted — the provider's own default applies,
   * and the record gains no quality key (no fabricated historical choice).
   */
  quality?: ImageQuality;
  count: number;
  /** Multimodal models only. */
  temperature?: number;
  /** Caller-supplied local Reference paths, in caller order (no roles, no mandatory identity — ADR-0014). */
  references?: string[];
}

/** A request after validateUniformRequest: sizing is normalized and always present. */
export type NormalizedUniformRequest = Omit<UniformGenerationRequest, "references"> & {
  sizing: UniformSizing;
  /** References after ingestion: ordered identities derived once at Job creation. */
  references?: UniformReference[];
};

/** One generated output: content identity and its job-relative file. */
export interface UniformOutput {
  contentHash: string;
  /** Path relative to the job directory. */
  file: string;
  mediaType: string;
}

/**
 * How a published run's recorded cost was obtained (#126). One home for the
 * vocabulary, so no reader has to guess whether a number is a charge or an
 * estimate:
 *
 * - `actual-charge` — the per-request billing the provider response itself
 *   reported for every request in the run (the Gateway's
 *   `providerMetadata.gateway.cost`).
 * - `registry-estimate` — the registry's per-image rate × outputs: an
 *   estimate. The rate's own provenance (measured or published) is a registry
 *   fact, never a charge on this request.
 * - `account-window-delta` — an observed account-window delta across the run:
 *   a cross-check basis, not a per-request receipt. Ply has no balance-reading
 *   path (out of scope, #126), so no run records this basis; the value exists
 *   so a delta-derived figure can be stated as what it is and never misread as
 *   a receipt.
 * - `unknown` — no honest number. The basis is stated in `run.warnings`.
 */
export type CostBasis = "actual-charge" | "registry-estimate" | "account-window-delta" | "unknown";

/**
 * A run's recorded cost. The union makes the dishonest pairings
 * unrepresentable: an amount always carries the basis that says where it came
 * from, and `unknown` carries no amount to misread.
 */
export type RunCost =
  | { basis: "actual-charge"; usd: number }
  | { basis: "registry-estimate"; usd: number }
  | { basis: "account-window-delta"; usd: number }
  | { basis: "unknown" };

/** The provenance record of the single run this Job publishes. */
export interface UniformRun {
  ranAt: string;
  /** The resolved provider model id actually called. */
  model: string;
  /**
   * The effective quality sent to the provider (#142) — present only when
   * the request selected one; records from unselected requests omit the key
   * entirely rather than record a fabricated historical choice.
   */
  quality?: ImageQuality;
  /** The effective text sent to the model. */
  fullPrompt: string;
  /** The run's cost and the basis it is claimed on (#126). */
  cost: RunCost;
  warnings: string[];
  outputs: UniformOutput[];
}

/**
 * Record schema versions. Version 1 is the pre-#126 cost shape: a
 * `costUsd`/`costMeasured` pair whose amount was always the registry rate ×
 * outputs, and whose measured flag described the rate's provenance — never a
 * charge measured on the request. Version 2 records the cost basis
 * (`run.cost`, #126). Parsing accepts both and interprets a v1 record as an
 * estimate or unknown, so a historical record can never read as an actual
 * charge (docs/generation-publication-contract.md §2).
 */
export const GENERATION_JOB_SCHEMA_VERSION = 2;
export const LEGACY_GENERATION_JOB_SCHEMA_VERSION = 1;

/** Every record version this reader accepts. */
export type GenerationSchemaVersion =
  | typeof LEGACY_GENERATION_JOB_SCHEMA_VERSION
  | typeof GENERATION_JOB_SCHEMA_VERSION;

/** The pre-#126 run cost fields — read and reinterpreted only, never written. */
interface LegacyRunCost {
  costUsd: number | null;
  costMeasured: boolean;
}

/** The pre-#126 run wire shape: the same run facts, with the cost pair instead of a basis. */
type LegacyUniformRun = Omit<UniformRun, "cost"> & LegacyRunCost;

/**
 * A published record as it is written on disk: one cost shape per version.
 * The union is what lets the parse boundary read each version against its own
 * contract — the record bytes are still validated field by field below, since
 * a cast proves nothing at runtime.
 */
type WireGenerationJob = Omit<GenerationJobRecord, "schemaVersion" | "run"> &
  (
    | { schemaVersion: typeof LEGACY_GENERATION_JOB_SCHEMA_VERSION; run: LegacyUniformRun }
    | { schemaVersion: typeof GENERATION_JOB_SCHEMA_VERSION; run: UniformRun }
  );

/**
 * Every cost basis a record may state, keyed by the union itself: adding a
 * basis to `CostBasis` without listing it here fails compilation, so the
 * vocabulary cannot drift between the type, the validator, and the message.
 */
const COST_BASES = {
  "actual-charge": true,
  "registry-estimate": true,
  "account-window-delta": true,
  unknown: true,
} satisfies Record<CostBasis, true>;

export interface GenerationJobRecord {
  /**
   * The version recorded in the file, preserved as written. A v1 record is
   * returned in the canonical shape — its pre-#126 cost pair is interpreted
   * at the parse boundary — so `run.cost` is always the record's cost.
   */
  schemaVersion: GenerationSchemaVersion;
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
  /** The selected quality (#142) — omitted when the request selected none. */
  quality?: ImageQuality;
  outputs: number;
}

/**
 * The provider seam — the exact outbound request a test can capture. The
 * production adapter wraps the AI SDK; tests inject recording fakes.
 * Prompt-only in this ticket; #105 extends these shapes with References.
 */
export interface ProviderImageRequest {
  model: string;
  /** Plain string when no References are attached; verified bytes in caller order otherwise. */
  prompt: string | { text: string; images: Uint8Array[] };
  /** Explicit pixel size — models that take a size. */
  size?: `${number}x${number}`;
  /** Aspect ratio — models that take an aspect ratio. */
  aspectRatio?: `${number}:${number}`;
  /**
   * The caller-selected GPT Image 2 quality tier (#142) — present only when
   * the request selected one; never fabricated for other models.
   */
  quality?: ImageQuality;
}

export interface ProviderTextRequest {
  model: string;
  prompt: string;
  /** Verified Reference bytes in caller order (message parts on the production path). */
  images?: Uint8Array[];
  /** Multimodal models only. */
  temperature?: number;
}

/**
 * Per-request billing the provider response itself reported (#126): the
 * Gateway returns its charge for the request alongside the generated bytes.
 * Absent when the response carried no billing — Ply never looks a charge up
 * after the fact, so a missing receipt is never re-requested.
 */
export interface ProviderBilling {
  /** The charge the provider reported for this one request, in USD. */
  costUsd: number;
}

export interface UniformProvider {
  image(args: ProviderImageRequest): Promise<{
    images: { base64: string }[];
    warnings: unknown[];
    /** The provider response's own billing for this request; absent when it reported none. */
    billing?: ProviderBilling;
  }>;
  text(args: ProviderTextRequest): Promise<{
    files: { mediaType?: string; uint8Array: Uint8Array }[];
    text: string;
    warnings: unknown[];
    /** The provider response's own billing for this request; absent when it reported none. */
    billing?: ProviderBilling;
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

export const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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
 * Compile-time brand: only ingestUniformRequest produces an
 * IngestedUniformRequest. executeUniformGeneration therefore cannot accept
 * validateUniformRequest() output — a validated request carries no Reference
 * identities, so executing it would silently generate with zero attachments
 * (INT-1). The brand is a runtime symbol, so it never serializes into
 * records (JSON.stringify skips symbol keys) and never reaches a provider.
 */
const ingestedBrand = Symbol("ingestedUniformRequest");

/** A request after ingestion (validateUniformRequest + Reference identity derivation) — the only shape Generation executes. */
export interface IngestedUniformRequest {
  request: NormalizedUniformRequest;
  spec: ReturnType<typeof resolveModel>;
  [ingestedBrand]: true;
}

/**
 * The pure semantic/capability gate for uniform generation requests: external
 * input is checked here before any provider call and before any Reference
 * byte is read — a refused request costs nothing. It performs no IO and
 * derives no identities; the returned request carries the effective
 * (default-filled, normalized) sizing. Reference identity derivation is
 * ingestUniformRequest's job — that is the ingestion boundary, and only its
 * output may be executed.
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

  // Capability gate, ahead of every other shape check and ahead of any
  // Reference byte being read: a model without a qualified reference claim is
  // refused here, naming the qualified alternatives (DEC-018/DEC-020).
  if (input.references?.length && !spec.supportsRef)
    throw new Error(referenceIncompatibilityError(spec));

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
  if (input.quality !== undefined) {
    if (!isImageQuality(input.quality))
      throw new Error(
        `Unknown quality ${JSON.stringify(String(input.quality))} — --quality takes low, medium, or high`,
      );
    // Unsupported model/quality combinations are refused here, before any
    // provider call — no invented tiers for other models (US-005, #142).
    validateQualitySupport(spec, input.quality);
  }

  const request: NormalizedUniformRequest = {
    prompt: input.prompt.trim(),
    intent: input.intent,
    model: input.model,
    sizing,
    count: input.count,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.quality !== undefined ? { quality: input.quality } : {}),
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
 * Ingest a caller request into the canonical shape Generation executes against:
 * semantic validation plus Reference identity derivation (DEC-003) — each
 * Reference file is read exactly once here, at Job creation, and its sha-256
 * becomes the recorded identity in caller order. Missing files and
 * unsupported model capability are refused before any provider call. This is
 * the one ingestion point and the only producer of IngestedUniformRequest;
 * validateUniformRequest's output cannot be executed.
 */
export async function ingestUniformRequest(input: UniformGenerationRequest): Promise<IngestedUniformRequest> {
  const { request, spec } = validateUniformRequest(input);
  if (!input.references?.length) return { request, spec, [ingestedBrand]: true };
  const references: UniformReference[] = [];
  for (const p of input.references) {
    if (typeof p !== "string" || !p.trim())
      throw new Error("Reference paths must be non-empty strings (--ref <path>)");
    // One read per Reference here: its bytes become the recorded identity.
    const loaded = await loadVerifiedReference({ path: p });
    references.push({ path: p, contentHash: sha256(loaded.bytes) });
  }
  return { request: { ...request, references }, spec, [ingestedBrand]: true };
}

/**
 * Parse and validate one published record's text. The single validation home
 * for record readers (show, list, and the dependent tickets' consumers):
 * missing, corrupt, or contradictory records fail loudly here.
 */
export function parseGenerationJobRecord(raw: string, jobId: string): GenerationJobRecord {
  if (!JOB_ID_PATTERN.test(jobId))
    throw new Error(`Invalid job id "${jobId}" — use lowercase letters/digits/hyphens`);
  try {
    const job = JSON.parse(raw) as WireGenerationJob;
    // The recorded version, read before any narrowing: a version this reader
    // does not know fails closed rather than being read under another
    // version's contract.
    const recordedVersion = job.schemaVersion;
    if (recordedVersion !== GENERATION_JOB_SCHEMA_VERSION && recordedVersion !== LEGACY_GENERATION_JOB_SCHEMA_VERSION)
      throw new Error(
        `unsupported job schemaVersion ${JSON.stringify(recordedVersion)} — this tool reads version ${LEGACY_GENERATION_JOB_SCHEMA_VERSION} (the pre-#126 cost shape) and ${GENERATION_JOB_SCHEMA_VERSION} (the cost basis) only`,
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
    if (!isImageQuality(job.request.quality) && job.request.quality !== undefined)
      throw new Error(
        `Job "${jobId}" is unreadable: its request quality ${JSON.stringify(String(job.request.quality))} is not a valid quality tier (low/medium/high)`,
      );
    if (!isImageQuality(job.run?.quality) && job.run?.quality !== undefined)
      throw new Error(
        `Job "${jobId}" is unreadable: its run quality ${JSON.stringify(String(job.run?.quality))} is not a valid quality tier (low/medium/high)`,
      );
    // The writer records request and run quality together, with the same
    // value, or neither (CRAFT-2, #142 review): any other pairing — one key
    // alone, or a divergent pair — is a shape this writer cannot produce, so
    // the record is contradictory and fails closed (SPEC-2).
    const requestQuality: ImageQuality | undefined = job.request.quality;
    const runQuality: ImageQuality | undefined = job.run?.quality;
    if (
      (requestQuality !== undefined || runQuality !== undefined) &&
      (requestQuality === undefined || runQuality === undefined || requestQuality !== runQuality)
    )
      throw new Error(
        `Job "${jobId}" is contradictory: its request and run quality values ${JSON.stringify(requestQuality)}/${JSON.stringify(runQuality)} must be the same tier or both absent`,
      );
    if (job.request.references !== undefined) {
      const refs = job.request.references;
      const valid =
        Array.isArray(refs) &&
        refs.every(
          (r) =>
            r !== null && typeof r === "object" && typeof (r as UniformReference).path === "string" &&
            typeof (r as UniformReference).contentHash === "string" &&
            /^[a-f0-9]{64}$/.test((r as UniformReference).contentHash),
        );
      if (!valid)
        throw new Error(
          `Job "${jobId}" is unreadable: its request references are not a valid ordered Reference record`,
        );
    }
    if (!Array.isArray(job.run?.outputs))
      throw new Error(`Job "${jobId}" is unreadable: its run has no outputs record`);
    const outputsValid =
      Array.isArray(job.run.outputs) &&
      job.run.outputs.every(
        (o) =>
          o !== null && typeof o === "object" &&
          typeof (o as UniformOutput).contentHash === "string" && /^[a-f0-9]{64}$/.test((o as UniformOutput).contentHash) &&
          typeof (o as UniformOutput).file === "string" && (o as UniformOutput).file !== "" &&
          typeof (o as UniformOutput).mediaType === "string" && (o as UniformOutput).mediaType.startsWith("image/"),
      );
    if (!outputsValid)
      throw new Error(`Job "${jobId}" is unreadable: its run outputs are not a valid content-addressed output record`);
    // Cost basis (#126): exactly one cost shape per recorded version. A v2
    // record carries `run.cost`; a v1 record carries the pre-#126
    // `costUsd`/`costMeasured` pair. Mixing them is a shape no writer
    // produced, so the record is contradictory and fails closed (SPEC-2
    // discipline, as for the quality pair).
    if (job.schemaVersion === LEGACY_GENERATION_JOB_SCHEMA_VERSION) {
      const { costUsd, costMeasured, ...rest } = job.run;
      if ("cost" in job.run)
        throw new Error(
          `Job "${jobId}" is contradictory: a schemaVersion ${LEGACY_GENERATION_JOB_SCHEMA_VERSION} record carries the pre-#126 costUsd/costMeasured pair, not a cost basis (${JSON.stringify((job.run as { cost?: unknown }).cost)}) — it cannot be trusted`,
        );
      if (costUsd !== null && !isRecordedAmount(costUsd))
        throw new Error(
          `Job "${jobId}" is unreadable: its run costUsd ${JSON.stringify(costUsd)} is not a recorded amount or an explicit unknown (null)`,
        );
      if (typeof costMeasured !== "boolean")
        throw new Error(
          `Job "${jobId}" is unreadable: its run costMeasured ${JSON.stringify(costMeasured)} is not a recorded flag`,
        );
      // A pre-#126 record's amount was the registry rate × outputs, and its
      // costMeasured flag described the *rate's* provenance — never a charge
      // measured on that request. A non-zero amount therefore reads as an
      // estimate; the placeholder 0 an unregistered raw gateway id recorded
      // reads as unknown, exactly as the current writer refuses to call that
      // 0 a rate (#126). No charge is invented for either, and the misleading
      // flag is not propagated.
      const cost: RunCost =
        costUsd === null || costUsd === 0 ? { basis: "unknown" } : { basis: "registry-estimate", usd: costUsd };
      return { ...job, run: { ...rest, cost } } as GenerationJobRecord;
    }
    if (!isRunCost(job.run.cost))
      throw new Error(
        `Job "${jobId}" is unreadable: its run cost ${JSON.stringify(job.run.cost)} is not a valid cost record — expected one of ${Object.keys(COST_BASES).join("/")}, each carrying a non-negative amount except unknown`,
      );
    if ("costUsd" in job.run || "costMeasured" in job.run)
      throw new Error(
        `Job "${jobId}" is contradictory: a schemaVersion ${GENERATION_JOB_SCHEMA_VERSION} record carries the pre-#126 costUsd/costMeasured fields beside its cost basis — it cannot be trusted`,
      );
    return job;
  } catch (err) {
    // JSON.parse failure is the one case this catch wraps; the shape checks
    // above throw their own actionable messages and are not re-wrapped.
    if (err instanceof SyntaxError)
      throw new Error(`Job "${jobId}" has an unreadable record: ${(err as Error).message}`);
    throw err;
  }
}

/** Read one published record from disk. */
export async function loadGenerationJob(jobRoot: string, jobId: string): Promise<GenerationJobRecord> {
  let raw: string;
  try {
    raw = await readFile(path.join(jobDir(jobRoot, jobId), "job.json"), "utf8");
  } catch {
    throw new Error(`No generation job "${jobId}" under ${jobRoot}`);
  }
  return parseGenerationJobRecord(raw, jobId);
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
        ...(job.request.quality !== undefined ? { quality: job.request.quality } : {}),
        outputs: job.run.outputs.length,
      });
    } catch {
      // Unreadable directories are not jobs (temp files, partial writes) — skip.
    }
  }
  return jobs;
}

/** A recorded amount: a finite, non-negative USD figure. */
function isRecordedAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * A record's cost field is exactly one of the four bases: `unknown` carries no
 * amount at all, and every other basis carries the amount that basis
 * describes. Any other shape is a record no writer produces.
 */
function isRunCost(value: unknown): value is RunCost {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { basis?: unknown; usd?: unknown };
  const basis = candidate.basis;
  if (typeof basis !== "string" || !Object.hasOwn(COST_BASES, basis)) return false;
  return basis === "unknown" ? !("usd" in candidate) : isRecordedAmount(candidate.usd);
}

/**
 * A receipt is usable only when it states a finite, non-negative charge: a
 * malformed provider response yields no billing claim rather than a wrong one
 * (each layer of the boundary is independently sufficient).
 */
function isUsableBilling(billing: ProviderBilling | undefined): billing is ProviderBilling {
  return isRecordedAmount(billing?.costUsd);
}

/** The stated basis for a cost the registry's rate cannot describe: a reference call on a text-only rate (TEST-012). */
function referenceCallCostWarning(spec: ModelSpec): string {
  return (
    `cost: reference-call cost recorded as unknown — the measured rate for ${spec.id} covers text-only calls; ` +
    `a reference call bills the image as extra input tokens (basis in the model note)`
  );
}

/** The stated basis for a cost the registry carries no rate for: an unregistered raw gateway id, which gains no cost claim. */
function noRateCostWarning(spec: ModelSpec): string {
  return (
    `cost: cost recorded as unknown — the registry carries no rate for ${spec.id} and the provider response reported no billing; ` +
    `an unregistered raw gateway id gains no cost claim until it is registered with a measured or published rate`
  );
}

/**
 * The stated gap for a run whose responses reported billing for some calls
 * only: a partial sum is not the run's charge, and silently summing it would
 * understate the run while looking whole.
 */
function partialReceiptWarning(received: number, outputCount: number): string {
  return (
    `cost: only ${received} of ${outputCount} provider responses carried a usable billing receipt — a partial receipt is not the run's charge, ` +
    `so no actual charge is recorded for this run`
  );
}

/**
 * Resolve one published run's cost (#126) — the single home of the rule and of
 * the statement that goes with an unknown basis.
 *
 * The provider's own receipts are the only thing that can make a charge:
 * every call in the run must have reported one, because a partial sum is not
 * the run's charge. Without that, the recorded cost falls back to the registry
 * rate × outputs (an estimate, never marked measured) — or to unknown with its
 * basis stated when that rate does not describe the call shape at all.
 */
export function resolveRunCost(input: {
  spec: ModelSpec;
  /** How many outputs the run published — one provider call each. */
  outputCount: number;
  /** How many References the calls carried. */
  referenceCount: number;
  /** The billing each call's provider response reported, in call order. */
  billings: (ProviderBilling | undefined)[];
}): { cost: RunCost; warnings: string[] } {
  const receipts = input.billings.filter(isUsableBilling);
  if (input.outputCount > 0 && receipts.length === input.outputCount)
    return {
      cost: {
        basis: "actual-charge",
        usd: receipts.reduce((total, receipt) => total + receipt.costUsd, 0),
      },
      warnings: [],
    };
  // No receipt for every call. Whatever is recorded instead, a receipt for
  // only some calls is never the run's charge — state the gap rather than
  // letting a partial sum look whole.
  const missingReceipts =
    receipts.length > 0 ? [partialReceiptWarning(receipts.length, input.outputCount)] : [];
  // A rate that does not describe this call shape states no amount at all: the
  // registry carries no rate for the model, or the rate covers text-only calls
  // while the request carried References.
  if (!(input.spec.approxCost > 0))
    return { cost: { basis: "unknown" }, warnings: [noRateCostWarning(input.spec), ...missingReceipts] };
  if (input.referenceCount > 0 && !input.spec.costCoversRefs)
    return {
      cost: { basis: "unknown" },
      warnings: [referenceCallCostWarning(input.spec), ...missingReceipts],
    };
  return {
    cost: { basis: "registry-estimate", usd: input.spec.approxCost * input.outputCount },
    warnings: missingReceipts,
  };
}

/**
 * The effective prompt for a validated request. The caller's prompt is
 * authoritative and passes through verbatim. Isolated intent adds the one
 * isolation-format line (never a transparency request — ADR-0015). Multimodal
 * models carry their selected aspect ratio in the prompt, because their text
 * call shape has no sizing parameter. Nothing else is added: no zone, no
 * subject bans, no identity recipe (ADR-0014).
 */
export function buildUniformPrompt(
  request: Omit<UniformGenerationRequest, "references"> & { sizing: UniformSizing },
  spec: ModelSpec,
): string {
  const lines = [request.prompt];
  if (request.intent === "isolated") lines.push("", ISOLATED_FORMAT_LINE);
  if (spec.kind === "multimodal" && request.sizing.kind === "aspectRatio")
    lines.push(`Output aspect ratio: ${request.sizing.ratio}.`);
  return lines.join("\n");
}

/** The provider request for one candidate of a validated request. Image-kind
 * requests are built through buildImageRequestArgs — the one home of the
 * image-kind provider request shape — so the uniform surface can never drift
 * from the legacy call shape. Reference bytes (when present) are the already
 * verified bytes in caller order; there is no alternate attachment path.
 */
function buildProviderRequest(
  request: NormalizedUniformRequest,
  spec: ModelSpec,
  fullPrompt: string,
  refBytes: Uint8Array[],
): ProviderImageRequest | ProviderTextRequest {
  if (spec.kind === "multimodal") {
    return {
      model: spec.id,
      prompt: fullPrompt,
      ...(refBytes.length ? { images: refBytes } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
  }
  return buildImageRequestArgs(
    spec,
    fullPrompt,
    refBytes,
    request.sizing.kind === "size"
      ? { size: `${request.sizing.width}x${request.sizing.height}` }
      : { aspectRatio: `${request.sizing.ratio}` as `${number}:${number}` },
    request.quality,
  ) as ProviderImageRequest;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The single public operation: ingest (validate + derive Reference identities
 * at Job creation) and execute (verify/read those identities, generate,
 * publish). Preflight (job id validity and no-overwrite) precedes ingestion,
 * so a duplicate job id is refused before any Reference byte is read.
 */
export async function runUniformGeneration(
  jobRoot: string,
  jobId: string,
  input: UniformGenerationRequest,
  deps: { provider: UniformProvider },
): Promise<GenerationJobRecord> {
  if (!JOB_ID_PATTERN.test(jobId))
    throw new Error(`Invalid job id "${jobId}" — use lowercase letters/digits/hyphens`);
  if (existsSync(path.join(jobDir(jobRoot, jobId), "job.json")))
    throw new Error(
      `Generation Job "${jobId}" already exists — pick a new id to record a new request (a Job's lineage is never overwritten)`,
    );
  return executeUniformGeneration(jobRoot, jobId, await ingestUniformRequest(input), deps);
}

/**
 * Execute an ingested request and publish the Generation Job. Each Reference
 * is read once more here and hash-verified against the identity recorded at
 * Job creation — the canonical verified representation; missing or changed
 * Reference bytes are refused before any provider call (DEC-003). Outputs are
 * persisted first (content-addressed), the record written last; any caught
 * failure removes the freshly created job directory, so nothing is left that
 * reports success — and no existing Project state is ever touched.
 */
export async function executeUniformGeneration(
  jobRoot: string,
  jobId: string,
  ingested: IngestedUniformRequest,
  deps: { provider: UniformProvider },
): Promise<GenerationJobRecord> {
  if (!JOB_ID_PATTERN.test(jobId))
    throw new Error(`Invalid job id "${jobId}" — use lowercase letters/digits/hyphens`);
  const dir = jobDir(jobRoot, jobId);
  if (existsSync(path.join(dir, "job.json")))
    throw new Error(
      `Generation Job "${jobId}" already exists — pick a new id to record a new request (a Job's lineage is never overwritten)`,
    );

  const { request, spec } = ingested;
  // Defense in depth behind the ingestion boundary: a tampered or hand-built
  // ingested request cannot carry References onto an unqualified model.
  if (request.references?.length && !spec.supportsRef)
    throw new Error(referenceIncompatibilityError(spec));
  // Same parallel re-check for quality (PROD-1, #155 review): a forged pair
  // of quality with an unqualified spec is refused here, before any provider
  // call — combination validation holds behind the ingestion boundary too.
  if (request.quality !== undefined) validateQualitySupport(spec, request.quality);
  // Verify/read every Reference once, in caller order — these exact bytes are
  // what the provider receives for every candidate.
  const refBytes: Uint8Array[] = [];
  for (const r of request.references ?? []) {
    const loaded = await loadVerifiedReference({ path: r.path, contentHash: r.contentHash });
    refBytes.push(loaded.bytes);
  }
  const fullPrompt = buildUniformPrompt(request, spec);
  const providerRequest = buildProviderRequest(request, spec, fullPrompt, refBytes);
  const now = new Date().toISOString();

  try {
    // All candidates first — every byte on disk before anything is recorded.
    await mkdir(path.join(dir, "outputs"), { recursive: true });
    const outputs: UniformOutput[] = [];
    const warnings: string[] = [];
    // Every call's own billing receipt, in call order (#126).
    const billings: (ProviderBilling | undefined)[] = [];
    if (request.intent === "isolated") warnings.push(ISOLATED_INTENT_WARNING);

    for (let i = 0; i < request.count; i++) {
      const { bytes, mediaType, providerWarnings, billing } = await callProvider(spec, providerRequest, deps.provider);
      billings.push(billing);
      const contentHash = sha256(bytes);
      const file = path.join("outputs", `${contentHash}.${extensionFor(mediaType)}`);
      await writeFile(path.join(dir, file), bytes);
      outputs.push({ contentHash, file, mediaType });
      warnings.push(...providerWarnings.map((w) => describeWarning(spec.id, w)));
    }

    // The cost and its basis, resolved once for the whole run (#126).
    const { cost, warnings: costWarnings } = resolveRunCost({
      spec,
      outputCount: outputs.length,
      referenceCount: refBytes.length,
      billings,
    });

    const job: GenerationJobRecord = {
      schemaVersion: GENERATION_JOB_SCHEMA_VERSION,
      jobId,
      kind: "generation",
      createdAt: now,
      request,
      run: {
        ranAt: now,
        model: spec.id,
        ...(request.quality !== undefined ? { quality: request.quality } : {}),
        fullPrompt,
        cost,
        warnings: [...new Set([...warnings, ...costWarnings])],
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
): Promise<{ bytes: Uint8Array; mediaType: string; providerWarnings: unknown[]; billing?: ProviderBilling }> {
  if (spec.kind === "multimodal") {
    const result = await provider.text(providerRequest as ProviderTextRequest);
    const file = result.files.find((f) => f.mediaType?.startsWith("image/"));
    if (!file)
      throw new Error(`${spec.id} returned no image. Text response: ${result.text.slice(0, 300)}`);
    return {
      bytes: file.uint8Array,
      mediaType: file.mediaType ?? "image/png",
      providerWarnings: result.warnings ?? [],
      ...(result.billing ? { billing: result.billing } : {}),
    };
  }
  const result = await provider.image(providerRequest as ProviderImageRequest);
  const image = result.images[0];
  if (!image) throw new Error(`${spec.id} returned no image.`);
  return {
    bytes: Buffer.from(image.base64, "base64"),
    mediaType: "image/png",
    providerWarnings: result.warnings ?? [],
    ...(result.billing ? { billing: result.billing } : {}),
  };
}