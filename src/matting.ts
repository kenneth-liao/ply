/**
 * Independent local Matting (spec #102 ticket #106, US-002, DEC-004,
 * ADR-0015): one caller-invoked operation on a caller-selected local PNG with
 * no Generation Job, no library adoption, and no network. Generation is never
 * a prerequisite; the operation imports no generation module and creates no
 * billed hop.
 *
 * Responsibilities that live here, deliberately kept apart from the matting
 * pass itself (`src/matte.ts`):
 *
 *   - ingestion — the source is read once and its sha-256 identity derived
 *     once at the operation boundary (DEC-003 idiom); PNG-only, refused with
 *     an actionable convert-locally diagnostic otherwise;
 *   - the matte — delegated to `matteCandidate`, the one reader of the
 *     native-alpha-first policy and of the true-alpha gate: preflight runs
 *     inside that seam before any inference, and an unusable matte carries
 *     this operation's recovery, attached here by type (the gate states
 *     only the why);
 *   - publication — content-addressed output bytes first, `matte.json` last
 *     as the commit point; any caught failure removes exactly the freshly
 *     created directory, so the source is never replaced and nothing is left
 *     that reports success.
 *
 * Provenance contract: `docs/matting-publication-contract.md` (consumed by
 * #108's Project ingestion).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { readPngHeader, PngParseError } from "./png.js";
import { matteCandidate, UnusableMatteError, NATIVE_ALPHA, type MatteEngine, type MatteTiming } from "./matte.js";
import type { AlphaReport } from "./alpha.js";

export const MATTING_SCHEMA_VERSION = 2;

/** Every schema version this tool reads: 1 (no source copy, backend, or timing) and 2 (all three on inference records). */
export const MATTING_SCHEMA_VERSIONS = [1, 2] as const;

/** A schema version this tool reads. */
export type MattingSchemaVersion = (typeof MATTING_SCHEMA_VERSIONS)[number];

/** Matte ids follow the same shape as Generation Job ids. */
export const MATTE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface MattingSource {
  /** The caller-supplied path, as written. */
  path: string;
  /** sha-256 of the exact source bytes, derived once at the operation boundary. */
  contentHash: string;
  /**
   * The retained source copy, present if and only if a distinct copy was
   * stored (`sources/<contentHash>.png`). Absent on version 1 records and on
   * native-alpha records, which store one blob.
   */
  file?: string;
}

export interface MattingOutput {
  contentHash: string;
  file: string;
  mediaType: "image/png";
}

export interface MattingResult {
  /** `native-alpha`, or the engine that produced the matte. */
  engine: string;
  /**
   * The backend that ran inference, as declared by the engine itself — a
   * non-empty string, never a product enum. Required on version 2 inference
   * records; absent on native-alpha records (no inference ran) and on
   * version 1 records.
   */
  backend?: string;
  /**
   * A timing figure with a stated boundary. Required on version 2 inference
   * records; absent on native-alpha records and on version 1 records.
   */
  timing?: MatteTiming;
  alpha: AlphaReport;
  warnings: string[];
  outputs: MattingOutput[];
}

export interface MattingRecord {
  schemaVersion: MattingSchemaVersion;
  matteId: string;
  kind: "matting";
  createdAt: string;
  request: { source: MattingSource };
  result: MattingResult;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function matteDir(matteRoot: string, matteId: string): string {
  return path.join(matteRoot, matteId);
}

/**
 * Run one independent local Matting operation and publish its result and
 * provenance. The source bytes are only ever read; every failure leaves the
 * source byte-identical and publishes nothing.
 */
export async function runMatting(
  matteRoot: string,
  matteId: string,
  sourcePath: string,
  deps: { engine: MatteEngine },
): Promise<MattingRecord> {
  if (!MATTE_ID_PATTERN.test(matteId))
    throw new Error(`Invalid matte id "${matteId}" — use lowercase letters/digits/hyphens`);
  if (existsSync(path.join(matteDir(matteRoot, matteId), "matte.json")))
    throw new Error(
      `Matte "${matteId}" already exists — pick a new id to matte a new image (a matte's lineage is never overwritten)`,
    );

  // Ingestion boundary: read the source exactly once, derive its identity
  // once, and parse the PNG here so every later stage trusts one shape.
  let sourceBytes: Buffer;
  try {
    sourceBytes = await readFile(sourcePath);
  } catch (err) {
    throw new Error(
      `Source image "${sourcePath}" cannot be read: ${(err as Error & { code?: string }).code === "ENOENT" ? "no such file" : (err as Error).message}`,
      { cause: err },
    );
  }
  try {
    readPngHeader(sourceBytes);
  } catch (err) {
    if (err instanceof PngParseError)
      throw new Error(
        `Source image "${sourcePath}" is not a matting-usable PNG: ${err.message}\n` +
          `Matting accepts PNG only — convert the image locally with an offline tool ` +
          `(e.g. "sips -s format png in.jpg --out in.png") and matte the PNG.`,
        { cause: err },
      );
    throw err;
  }

  const source: MattingSource = { path: sourcePath, contentHash: sha256(sourceBytes) };
  // The one reader of the native-alpha-first policy and of the true-alpha
  // gate; its engine path prefights before any inference.
  let outcome: Awaited<ReturnType<typeof matteCandidate>>;
  try {
    outcome = await matteCandidate(sourceBytes, sourcePath, deps.engine);
  } catch (err) {
    // The gate states the why; this operation states the recovery. There is
    // no Job to rerun and nothing to adopt — the next step is this command.
    // Other failures (preflight, engine errors) already carry their own fix.
    if (err instanceof UnusableMatteError)
      throw new Error(
        `${err.message} Nothing was published and the source is unchanged — check the input (it must contain an isolable subject) and the engine, then run "ply matte" again.`,
        { cause: err },
      );
    throw err;
  }
  const contentHash = sha256(outcome.bytes);
  const isNativeAlpha = outcome.engine === NATIVE_ALPHA;
  // Version 2 inference records require the engine-declared backend and
  // timing: without them there is no publishable record, so refuse before
  // anything is written — the source stays byte-identical and nothing is
  // left that reports success. Pre-contract engines surface here with the fix.
  if (!isNativeAlpha && (typeof outcome.backend !== "string" || outcome.backend === ""))
    throw new Error(
      `The matting engine ("${outcome.engine}") declared no backend — version 2 inference records ` +
        `must name the backend that ran inference. Nothing was published and the source is unchanged.`,
    );
  if (!isNativeAlpha && !isWellFormedTiming(outcome.timing))
    throw new Error(
      `The matting engine ("${outcome.engine}") declared no timing figure with a stated boundary — ` +
        `version 2 inference records must carry one. Nothing was published and the source is unchanged.`,
    );
  // One blob is enough when the output is the source's own bytes: the copy
  // decision is the hash equality, not the engine name.
  const distinctSource = contentHash !== source.contentHash;
  const sourceFile = distinctSource ? path.join("sources", `${source.contentHash}.png`) : undefined;
  const result: MattingResult = {
    engine: outcome.engine,
    ...(isNativeAlpha ? {} : { backend: outcome.backend!, timing: outcome.timing! }),
    alpha: outcome.alpha,
    warnings: outcome.warnings,
    outputs: [{ contentHash, file: path.join("outputs", `${contentHash}.png`), mediaType: "image/png" }],
  };
  const record: MattingRecord = {
    schemaVersion: MATTING_SCHEMA_VERSION,
    matteId,
    kind: "matting",
    createdAt: new Date().toISOString(),
    request: { source: sourceFile ? { ...source, file: sourceFile } : source },
    result,
  };

  const dir = matteDir(matteRoot, matteId);
  try {
    // Output bytes and the retained source copy first; the record is the
    // commit point, written last.
    await mkdir(path.join(dir, "outputs"), { recursive: true });
    if (sourceFile) {
      await mkdir(path.join(dir, "sources"), { recursive: true });
      await writeFile(path.join(dir, sourceFile), sourceBytes);
    }
    await writeFile(path.join(dir, result.outputs[0]!.file), outcome.bytes);
    await writeFile(path.join(dir, "matte.json"), JSON.stringify(record, null, 2) + "\n");
    return record;
  } catch (err) {
    // Remove exactly what this operation created — never the source, never
    // the root. A matte without its record does not exist.
    await rm(dir, { recursive: true, force: true });
    throw new Error(
      `Matting "${matteId}" could not be published: ${(err as Error).message} — the source is unchanged and nothing was published`,
      { cause: err },
    );
  }
}

/** Whether a timing value is a well-formed figure with a stated boundary. */
function isWellFormedTiming(timing: unknown): timing is MatteTiming {
  if (timing === null || typeof timing !== "object") return false;
  const { millis, scope } = timing as { millis?: unknown; scope?: unknown };
  return (
    typeof millis === "number" && Number.isFinite(millis) && millis >= 0 &&
    typeof scope === "string" && scope !== ""
  );
}

/**
 * Parse and validate one published matte record's text. The single
 * validation home for matte-record readers (#108's Project ingestion and
 * resolution): a missing, corrupt, or contradictory record fails loudly
 * here. The record is the single authoritative home for the Matting facts —
 * source path and identity, engine, alpha report, warnings, and output —
 * so an unreadable record is lineage that cannot be trusted.
 *
 * Versions 1 and 2 both read. Version 1 has no source copy, backend, or
 * timing, and their absence is not an error. Version 2 inference records
 * require all three new facts; version 2 native-alpha records store one
 * blob and omit the source copy, backend, and timing (no inference ran).
 */
export function parseMattingRecord(raw: string, matteId: string): MattingRecord {
  if (!MATTE_ID_PATTERN.test(matteId))
    throw new Error(`Invalid matte id "${matteId}" — use lowercase letters/digits/hyphens`);
  let record: MattingRecord;
  try {
    record = JSON.parse(raw) as MattingRecord;
  } catch (err) {
    throw new Error(`Matte "${matteId}" has an unreadable record: ${(err as Error).message}`);
  }
  if (!(MATTING_SCHEMA_VERSIONS as readonly number[]).includes(record.schemaVersion))
    throw new Error(
      `Matte "${matteId}" has unsupported schemaVersion ${JSON.stringify(record.schemaVersion)} — this tool reads versions ${MATTING_SCHEMA_VERSIONS.join(" and ")}`,
    );
  if (record.kind !== "matting")
    throw new Error(
      `Matte "${matteId}" is contradictory: kind ${JSON.stringify(record.kind)} is not a Matting record — it cannot be trusted`,
    );
  if (record.matteId !== matteId)
    throw new Error(`Matte "${matteId}" is contradictory: the record names matte ${JSON.stringify(record.matteId)}`);
  if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt)))
    throw new Error(`Matte "${matteId}" is unreadable: its creation timestamp is not a valid UTC ISO date`);
  const source = record.request?.source;
  if (
    source === null || typeof source !== "object" ||
    typeof source.path !== "string" || source.path === "" ||
    typeof source.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(source.contentHash)
  )
    throw new Error(`Matte "${matteId}" is unreadable: its request source is not a valid content-identified source record`);
  const result = record.result;
  if (result === null || typeof result !== "object" || typeof result.engine !== "string" || result.engine === "")
    throw new Error(`Matte "${matteId}" is unreadable: its result does not record the engine that produced the matte`);
  if (!Array.isArray(result.outputs) || result.outputs.length !== 1)
    throw new Error(
      `Matte "${matteId}" is unreadable: a Matting record publishes exactly one verified output`,
    );
  const output = result.outputs[0]!;
  if (
    output === null || typeof output !== "object" ||
    typeof output.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(output.contentHash) ||
    typeof output.file !== "string" || output.file === "" ||
    output.mediaType !== "image/png"
  )
    throw new Error(`Matte "${matteId}" is unreadable: its output is not a valid content-addressed PNG record`);
  validatePublicationContract(record, matteId);
  return record;
}

/**
 * Enforce the version 2 publication facts (spec #159 ticket #160, US-003/US-004).
 * Version 1 records predate the contract and are exempt: missing source copy,
 * backend, and timing on v1 is not an error. Native-alpha records store one
 * blob and ran no inference, so the source copy, backend, and timing stay absent.
 */
function validatePublicationContract(record: MattingRecord, matteId: string): void {
  if (record.schemaVersion === 1) return;
  const source = record.request.source;
  const result = record.result;
  const nativeAlpha = result.engine === NATIVE_ALPHA;
  if (nativeAlpha) {
    if (source.file !== undefined)
      throw new Error(
        `Matte "${matteId}" is contradictory: a native-alpha record stores one blob, so it must not name a source copy`,
      );
    if (result.outputs[0]!.contentHash !== source.contentHash)
      throw new Error(
        `Matte "${matteId}" is contradictory: a native-alpha record's output is the source's own bytes, so the identities must match`,
      );
    if (result.backend !== undefined || result.timing !== undefined)
      throw new Error(
        `Matte "${matteId}" is contradictory: a native-alpha record ran no inference, so it must not name a backend or timing`,
      );
    return;
  }
  // Inference records: the retained copy is the source identity, not a second hash.
  if (typeof source.file !== "string" || !/^sources\/[a-f0-9]{64}\.png$/.test(source.file))
    throw new Error(
      `Matte "${matteId}" is unreadable: a version 2 inference record must name its retained source copy at sources/<sha256>.png`,
    );
  if (source.file !== `sources/${source.contentHash}.png`)
    throw new Error(
      `Matte "${matteId}" is contradictory: its retained source copy ${JSON.stringify(source.file)} is not its source identity — the copy is that identity, not a second hash`,
    );
  if (result.outputs[0]!.contentHash === source.contentHash)
    throw new Error(
      `Matte "${matteId}" is contradictory: a version 2 inference record stores distinct source and output bytes`,
    );
  if (typeof result.backend !== "string" || result.backend === "")
    throw new Error(
      `Matte "${matteId}" is unreadable: a version 2 inference record must name the backend that ran inference`,
    );
  if (!isWellFormedTiming(result.timing))
    throw new Error(
      `Matte "${matteId}" is unreadable: a version 2 inference record must carry a timing figure with a stated boundary`,
    );
}
