/**
 * Matting-content retention for Projects (spec #102 ticket #108, US-003/US-005).
 *
 * One published Matting operation's provenance is retained inside a Project
 * as the record's verbatim bytes under `matting/<matteId>/matte.json` — the
 * one canonical retained representation of the Matting facts (source
 * identity, output identity, engine, alpha report, warnings; see
 * docs/matting-publication-contract.md and docs/project-storage-contract.md).
 * The matted pixels themselves are retained through the existing content
 * store (`content/<sha256>`), and the linkage between a Layer revision and
 * its Matting provenance is *derived*: the revision's `contentHash` is the
 * one content identity, and the retained matte record pins its output by the
 * same sha-256. Nothing from the record is embedded in Layer revisions,
 * Composition documents, or Render manifests.
 *
 * This module owns three boundaries:
 * - `selectMatteOutput` — external source resolution: the record is read
 *   through the one published-record parser, its single output's file is
 *   read and hash-verified against the recorded identity, and — when the
 *   record names a distinct retained source copy (`request.source.file`,
 *   version 2 inference records) — that copy is read and hash-verified
 *   against the recorded source identity too. Missing, corrupt, or
 *   mismatched lineage is refused here, before any Project state is touched.
 * - `retainMattingRecord` — under the Project lock: stage the retained
 *   record atomically; an existing retained record must be byte-identical or
 *   the ingestion is refused (retained provenance is immutable).
 * - `retainMattingSourceBytes` — under the Project lock: stage the published
 *   source copy beside the verbatim record (`matting/<matteId>/sources/`,
 *   the same relative path the publication contract names), so a relocated
 *   Project can rematte without the original path. Native-alpha and version 1
 *   records name no copy and stage nothing.
 * - `retainGenerationLineage` — derived predecessor linkage (#108): when the
 *   matte's source content identity matches exactly one published Generation
 *   Job's output, that job's record is retained verbatim through the existing
 *   generation-retention machinery, so a matted generated result keeps its
 *   predecessor provenance without a second copy of the request facts.
 * - `resolveRetainedMattingProvenance` — the one canonical resolution reader:
 *   a revision contentHash resolves to the retained matte that produced it;
 *   ambiguity or unreadable retained records fail closed.
 *
 * No function here mattes, runs an engine, generates, calls a provider, or
 * touches the network: ingestion reads an existing published result.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  MATTE_ID_PATTERN,
  parseMattingRecord,
  type MattingOutput,
  type MattingRecord,
} from "./matting.js";
import {
  JOB_ID_PATTERN,
  parseGenerationJobRecord,
  type GenerationJobRecord,
} from "./generation.js";
import { atomicCreate } from "./project-lock.js";
import { outsideDir, escapesDirReal } from "./paths.js";
import { MAX_ENCODED_BYTES } from "./png.js";
import {
  resolveRetainedProvenance,
  type RetainedProvenance,
} from "./generation-retention.js";

/** The Project subdirectory holding retained Matting records. Created on first retention; Projects without it have no retained Matting provenance. */
export const RETAINED_MATTING_DIR = "matting";

export interface SelectedMatteOutput {
  matte: MattingRecord;
  output: MattingOutput;
  /** The verified raw bytes of the matte output file. */
  bytes: Buffer;
  /** The verbatim record bytes — what retention stores. */
  recordBytes: Buffer;
  /**
   * The verified raw bytes of the published source copy, when the record
   * names a distinct one (`request.source.file`, version 2 inference
   * records). Null on native-alpha records (the output already is the
   * source's bytes) and on version 1 records (no copy was published).
   */
  sourceBytes: Buffer | null;
}

/**
 * Resolve the external source of one published matte: load the record, read
 * its single output file, and verify its bytes against the recorded sha-256
 * identity. A record is published with exactly one verified output, so a
 * multi-output or zero-output record is corrupt lineage and is refused. No
 * Project state is read or written here.
 */
export async function selectMatteOutput(matteRoot: string, matteId: string): Promise<SelectedMatteOutput> {
  // Validate the id before any path is constructed from it — an invalid id
  // must not name a read outside the matte root.
  if (!MATTE_ID_PATTERN.test(matteId))
    throw new Error(`Invalid matte id "${matteId}" — use lowercase letters/digits/hyphens`);
  const matteDir = path.join(matteRoot, matteId);
  const recordFile = path.join(matteDir, "matte.json");
  let recordBytes: Buffer;
  try {
    recordBytes = await readFile(recordFile);
  } catch {
    throw new Error(`No matte "${matteId}" under ${matteRoot}`);
  }
  const matte = parseMattingRecord(recordBytes.toString("utf8"), matteId);
  const output = matte.result.outputs[0]!;
  const outputFile = path.join(matteDir, output.file);
  // Everything that can refuse the source runs before the full read, like
  // the generation source gate: lexical containment (the path's shape), size
  // on the open handle, then realpath containment (the file exists, so an
  // alias that resolves outside the matte directory cannot dodge the gate).
  if (outsideDir(matteDir, outputFile)) {
    throw new Error(
      `Matte "${matteId}" output path "${output.file}" escapes the matte directory — the record cannot be trusted`,
    );
  }
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(outputFile);
  } catch {
    throw new Error(
      `Matte "${matteId}" output "${output.file}" is missing — the matte's lineage is incomplete; refusing to ingest`,
    );
  }
  if (!st.isFile()) {
    throw new Error(`Matte "${matteId}" output "${output.file}" is not a regular file; refusing to ingest`);
  }
  if (st.size > MAX_ENCODED_BYTES) {
    throw new Error(
      `Matte "${matteId}" output "${output.file}" is ${(st.size / 1024 / 1024).toFixed(1)} MB — over the ${MAX_ENCODED_BYTES / 1024 / 1024} MB limit`,
    );
  }
  if (await escapesDirReal(matteDir, outputFile)) {
    throw new Error(
      `Matte "${matteId}" output path "${output.file}" escapes the matte directory — the record cannot be trusted`,
    );
  }
  const bytes = await readFile(outputFile);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== output.contentHash) {
    throw new Error(
      `Matte "${matteId}" output "${output.file}" does not match its recorded content identity ${output.contentHash.slice(0, 12)} (actual ${actualHash.slice(0, 12)}) — the source and result are mismatched or the lineage is corrupted; refusing to ingest`,
    );
  }
  // A version 2 inference record names its retained source copy; read and
  // verify it under the same gates so Project retention never copies
  // untrusted bytes. Native-alpha and version 1 records name no copy.
  let sourceBytes: Buffer | null = null;
  const sourceFile = matte.request.source.file;
  if (sourceFile !== undefined) {
    // Shape refusal happens here, before any Project write — a record
    // naming a non-`sources/<hash>.png` copy never stages anything.
    if (!/^sources\/[a-f0-9]{64}\.png$/.test(sourceFile)) {
      throw new Error(
        `Matte "${matteId}" names an unrecognized source copy "${sourceFile}" — the record cannot be trusted`,
      );
    }
    const sourcePath = path.join(matteDir, sourceFile);
    if (outsideDir(matteDir, sourcePath)) {
      throw new Error(
        `Matte "${matteId}" source path "${sourceFile}" escapes the matte directory — the record cannot be trusted`,
      );
    }
    let sourceStat: Awaited<ReturnType<typeof stat>>;
    try {
      sourceStat = await stat(sourcePath);
    } catch {
      throw new Error(
        `Matte "${matteId}" source "${sourceFile}" is missing — the matte's lineage is incomplete; refusing to ingest`,
      );
    }
    if (!sourceStat.isFile()) {
      throw new Error(`Matte "${matteId}" source "${sourceFile}" is not a regular file; refusing to ingest`);
    }
    if (sourceStat.size > MAX_ENCODED_BYTES) {
      throw new Error(
        `Matte "${matteId}" source "${sourceFile}" is ${(sourceStat.size / 1024 / 1024).toFixed(1)} MB — over the ${MAX_ENCODED_BYTES / 1024 / 1024} MB limit`,
      );
    }
    if (await escapesDirReal(matteDir, sourcePath)) {
      throw new Error(
        `Matte "${matteId}" source path "${sourceFile}" escapes the matte directory — the record cannot be trusted`,
      );
    }
    const rawSource = await readFile(sourcePath);
    const rawSourceHash = createHash("sha256").update(rawSource).digest("hex");
    if (rawSourceHash !== matte.request.source.contentHash) {
      throw new Error(
        `Matte "${matteId}" source "${sourceFile}" does not match its recorded source identity ${matte.request.source.contentHash.slice(0, 12)} (actual ${rawSourceHash.slice(0, 12)}) — the source and result are mismatched or the lineage is corrupted; refusing to ingest`,
      );
    }
    sourceBytes = rawSource;
  }
  return { matte, output, bytes, recordBytes, sourceBytes };
}

/**
 * Retain a Matting record verbatim inside the Project under
 * `matting/<matteId>/matte.json`. Caller must hold the Project lock and must
 * have verified the source already. An existing retained record must be
 * byte-identical to the source record — retained provenance is never
 * rewritten, so a mismatch means corrupted or tampered retention and the
 * ingestion is refused.
 */
export async function retainMattingRecord(
  resolvedProjectRoot: string,
  matteId: string,
  recordBytes: Buffer,
): Promise<void> {
  const recordDir = path.join(resolvedProjectRoot, RETAINED_MATTING_DIR, matteId);
  const recordPath = path.join(recordDir, "matte.json");
  if (outsideDir(resolvedProjectRoot, recordPath)) {
    throw new Error(`Security error: retained record for "${matteId}" escapes project boundary.`);
  }
  let existing: Buffer | null = null;
  try {
    existing = await readFile(recordPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing) {
    if (await escapesDirReal(resolvedProjectRoot, recordPath)) {
      throw new Error(`Security error: retained record for "${matteId}" escapes project boundary.`);
    }
    if (!existing.equals(recordBytes)) {
      throw new Error(
        `Retained Matting provenance for "${matteId}" already exists in this Project and does not match the source record — retained provenance is immutable, so refusing to ingest`,
      );
    }
    return;
  }
  await mkdir(recordDir, { recursive: true });
  await atomicCreate(recordPath, recordBytes);
}

/**
 * Retain a published matte's source copy beside its verbatim record under
 * `matting/<matteId>/sources/<sha256>.png` — the same relative path the
 * publication contract names, so rematting is ordinary `ply matte` on the
 * retained path after the original is gone and the Project has moved.
 * Caller must hold the Project lock and must have verified the bytes
 * already (via `selectMatteOutput`). Records that name no distinct copy
 * (native-alpha — the output already is the source's bytes — and version 1,
 * which predates the copy) stage nothing: no second blob, no backfill.
 * An existing retained copy must be byte-identical or the ingestion is
 * refused, like the verbatim record itself.
 */
export async function retainMattingSourceBytes(
  resolvedProjectRoot: string,
  matte: MattingRecord,
  sourceBytes: Buffer,
): Promise<void> {
  const sourceFile = matte.request.source.file;
  if (sourceFile === undefined) return;
  if (!/^sources\/[a-f0-9]{64}\.png$/.test(sourceFile)) {
    throw new Error(
      `Matte "${matte.matteId}" names an unrecognized source copy "${sourceFile}" — the record cannot be trusted`,
    );
  }
  const actualHash = createHash("sha256").update(sourceBytes).digest("hex");
  if (actualHash !== matte.request.source.contentHash) {
    throw new Error(
      `Matte "${matte.matteId}" source copy does not match its recorded source identity ${matte.request.source.contentHash.slice(0, 12)} (actual ${actualHash.slice(0, 12)}) — refusing to ingest`,
    );
  }
  const destPath = path.join(resolvedProjectRoot, RETAINED_MATTING_DIR, matte.matteId, sourceFile);
  if (outsideDir(resolvedProjectRoot, destPath)) {
    throw new Error(`Security error: retained source for "${matte.matteId}" escapes project boundary.`);
  }
  let existing: Buffer | null = null;
  try {
    existing = await readFile(destPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing) {
    if (await escapesDirReal(resolvedProjectRoot, destPath)) {
      throw new Error(`Security error: retained source for "${matte.matteId}" escapes project boundary.`);
    }
    if (!existing.equals(sourceBytes)) {
      throw new Error(
        `Retained Matting source for "${matte.matteId}" already exists in this Project and does not match the source copy — retained provenance is immutable, so refusing to ingest`,
      );
    }
    return;
  }
  await mkdir(path.dirname(destPath), { recursive: true });
  await atomicCreate(destPath, sourceBytes);
}

export interface RetainedMattingProvenance {
  matteId: string;
  matte: MattingRecord;
  output: MattingOutput;
}

/**
 * The one canonical resolution reader for retained Matting provenance:
 * resolve a Project content identity (a Layer revision's `contentHash`) to
 * the retained matte that produced it. Zero matches mean the bytes are not
 * matted content (an ordinary image Layer). More than one match means two
 * retained mattes claim the same bytes — the provenance would be ambiguous,
 * so this fails closed rather than report a possibly wrong source. A
 * malformed retained record also fails closed: unreadable retained
 * provenance is never silently skipped.
 *
 * Callers that read Project state should hold the Project lock, like every
 * other reader.
 */
export async function resolveRetainedMattingProvenance(
  resolvedProjectRoot: string,
  contentHash: string,
): Promise<RetainedMattingProvenance | null> {
  const mattingDir = path.join(resolvedProjectRoot, RETAINED_MATTING_DIR);
  let entries: string[];
  try {
    entries = await readdir(mattingDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const matches: RetainedMattingProvenance[] = [];
  for (const entry of entries.sort()) {
    const recordPath = path.join(mattingDir, entry, "matte.json");
    let raw: string;
    try {
      raw = await readFile(recordPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // not a retained matte (no record)
      throw err;
    }
    const matte = parseMattingRecord(raw, entry);
    const output = matte.result.outputs.find((o) => o.contentHash === contentHash);
    if (output) matches.push({ matteId: matte.matteId, matte, output });
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `Retained Matting provenance for content ${contentHash.slice(0, 12)} is ambiguous: mattes ${matches
        .map((m) => `"${m.matteId}"`)
        .join(", ")} all claim these bytes — refusing to report wrong provenance`,
    );
  }
  return matches[0]!;
}

/**
 * Derived predecessor linkage for a matted generated result (#108): scan the
 * published Generation Job records for a job whose output content identity
 * matches the matte's source identity. Zero matches means the matte's source
 * was not a published generation output (an ordinary local image): null.
 * More than one match is ambiguous lineage and fails closed rather than
 * retain a possibly wrong predecessor. This is a pure read over the external
 * generation root — no Project state is touched, so callers can refuse the
 * source before retaining anything.
 */
export async function findGenerationPredecessor(
  generationRoot: string,
  sourceContentHash: string,
): Promise<{ job: GenerationJobRecord; recordBytes: Buffer } | null> {
  let entries: string[];
  try {
    entries = await readdir(generationRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const predecessors: { job: GenerationJobRecord; recordBytes: Buffer }[] = [];
  for (const entry of entries.sort()) {
    if (!JOB_ID_PATTERN.test(entry)) continue; // not a job directory (temp files, partial writes)
    const recordPath = path.join(generationRoot, entry, "job.json");
    let raw: Buffer;
    try {
      raw = await readFile(recordPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // not a published job (no record)
      throw err;
    }
    const job = parseGenerationJobRecord(raw.toString("utf8"), entry);
    if (job.run.outputs.some((o) => o.contentHash === sourceContentHash)) {
      predecessors.push({ job, recordBytes: raw });
    }
  }
  if (predecessors.length === 0) return null;
  if (predecessors.length > 1) {
    throw new Error(
      `The matte's source (${sourceContentHash.slice(0, 12)}) matches the outputs of Generation Jobs ${predecessors
        .map((p) => `"${p.job.jobId}"`)
        .join(", ")} — the predecessor provenance is ambiguous; refusing to ingest`,
    );
  }
  return predecessors[0]!;
}

/**
 * Find the published matte(s) whose source matches one content identity — the
 * inverse of `findGenerationPredecessor`: a generated candidate's associated
 * matte is found by the same derived sha-256 linkage, never by a stored
 * pointer (#109). Zero matches means no matte is associated with these bytes;
 * more than one match is ambiguous lineage and fails closed rather than
 * display a possibly wrong matte. An unreadable record also fails closed.
 */
export async function findMatteForSource(
  matteRoot: string,
  sourceContentHash: string,
): Promise<{ matte: MattingRecord; recordBytes: Buffer } | null> {
  let entries: string[];
  try {
    entries = await readdir(matteRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const matches: { matte: MattingRecord; recordBytes: Buffer }[] = [];
  for (const entry of entries.sort()) {
    if (!MATTE_ID_PATTERN.test(entry)) continue; // not a matte directory (temp files, partial writes)
    const recordPath = path.join(matteRoot, entry, "matte.json");
    let raw: Buffer;
    try {
      raw = await readFile(recordPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // not a published matte (no record)
      throw err;
    }
    const matte = parseMattingRecord(raw.toString("utf8"), entry);
    if (matte.request.source.contentHash === sourceContentHash) {
      matches.push({ matte, recordBytes: raw });
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `The candidate (${sourceContentHash.slice(0, 12)}) is the source of mattes ${matches
        .map((m) => `"${m.matte.matteId}"`)
        .join(", ")} — the associated matte is ambiguous; refusing to display possibly wrong evidence`,
    );
  }
  return matches[0]!;
}

export interface RetainedMatteGenerationLineage {
  matting: RetainedMattingProvenance;
  /** The retained predecessor Generation Job, when the matte's source was generated. */
  generation: RetainedProvenance | null;
}

/**
 * Resolve one Project content identity's full derived lineage: the retained
 * matte that produced the bytes (fail-closed on ambiguity or unreadable
 * records), plus — when that matte's source was itself a retained generation
 * output — the predecessor Generation Job. Zero matting matches mean the
 * bytes are not matted content. Callers that read Project state should hold
 * the Project lock, like every other reader.
 */
export async function resolveRetainedMatteGenerationLineage(
  resolvedProjectRoot: string,
  contentHash: string,
): Promise<RetainedMatteGenerationLineage | null> {
  const matting = await resolveRetainedMattingProvenance(resolvedProjectRoot, contentHash);
  if (!matting) return null;
  const generation = await resolveRetainedProvenance(resolvedProjectRoot, matting.matte.request.source.contentHash);
  return { matting, generation };
}