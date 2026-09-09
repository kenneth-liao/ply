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
import { matteCandidate, UnusableMatteError, type MatteEngine } from "./matte.js";
import type { AlphaReport } from "./alpha.js";

export const MATTING_SCHEMA_VERSION = 1;

/** Matte ids follow the same shape as Generation Job ids. */
export const MATTE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface MattingSource {
  /** The caller-supplied path, as written. */
  path: string;
  /** sha-256 of the exact source bytes, derived once at the operation boundary. */
  contentHash: string;
}

export interface MattingOutput {
  contentHash: string;
  file: string;
  mediaType: "image/png";
}

export interface MattingResult {
  /** `native-alpha`, or the engine that produced the matte. */
  engine: string;
  alpha: AlphaReport;
  warnings: string[];
  outputs: MattingOutput[];
}

export interface MattingRecord {
  schemaVersion: typeof MATTING_SCHEMA_VERSION;
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
  const result: MattingResult = {
    engine: outcome.engine,
    alpha: outcome.alpha,
    warnings: outcome.warnings,
    outputs: [{ contentHash, file: path.join("outputs", `${contentHash}.png`), mediaType: "image/png" }],
  };
  const record: MattingRecord = {
    schemaVersion: MATTING_SCHEMA_VERSION,
    matteId,
    kind: "matting",
    createdAt: new Date().toISOString(),
    request: { source },
    result,
  };

  const dir = matteDir(matteRoot, matteId);
  try {
    // Output bytes first; the record is the commit point, written last.
    await mkdir(path.join(dir, "outputs"), { recursive: true });
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

/**
 * Parse and validate one published matte record's text. The single
 * validation home for matte-record readers (#108's Project ingestion and
 * resolution): a missing, corrupt, or contradictory record fails loudly
 * here. The record is the single authoritative home for the Matting facts —
 * source path and identity, engine, alpha report, warnings, and output —
 * so an unreadable record is lineage that cannot be trusted.
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
  if (record.schemaVersion !== MATTING_SCHEMA_VERSION)
    throw new Error(
      `Matte "${matteId}" has unsupported schemaVersion ${JSON.stringify(record.schemaVersion)} — this tool reads version ${MATTING_SCHEMA_VERSION} only`,
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
  return record;
}
