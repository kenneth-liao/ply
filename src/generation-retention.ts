/**
 * Generated-content retention for Projects (spec #102 ticket #107, US-003/US-005).
 *
 * One source-image Generation Job's provenance is retained inside a Project
 * as the record's verbatim bytes under `generation/<jobId>/job.json` — the
 * one canonical retained representation of the request/output/Reference
 * provenance; nothing is embedded in Layer revisions, Composition documents,
 * or Render manifests (see docs/project-storage-contract.md). The generated
 * pixels themselves are retained through the existing content store
 * (`content/<sha256>`), and the linkage between a Layer revision and its
 * provenance is *derived*: the revision's `contentHash` is the one content
 * identity, and the retained record pins its outputs by the same sha-256.
 *
 * This module owns three boundaries:
 * - `selectGenerationOutput` — external source resolution: the record is read
 *   through the one published-record parser (`parseGenerationJobRecord`),
 *   one output is selected explicitly (never implicitly), its file is read
 *   and hash-verified against the recorded identity. Missing, corrupt, or
 *   mismatched sources are refused here, before any Project state is touched.
 * - `retainGenerationRecord` — under the Project lock: stage the retained
 *   record atomically; an existing retained record must be byte-identical or
 *   the ingestion is refused (retained provenance is immutable).
 * - `resolveRetainedProvenance` — the one canonical resolution reader: a
 *   revision contentHash resolves to the retained job/output that produced
 *   it; ambiguity (two retained jobs claiming identical bytes) fails closed
 *   rather than reporting wrong provenance.
 *
 * No function here generates, calls a provider, or touches the network.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { JOB_ID_PATTERN, parseGenerationJobRecord, loadGenerationJob, type GenerationJobRecord, type UniformOutput } from "./generation.js";
import { atomicCreate } from "./project-lock.js";
import { outsideDir, escapesDirReal } from "./paths.js";
import { MAX_ENCODED_BYTES } from "./png.js";

/** The Project subdirectory holding retained Generation Job records. Created on first retention; Projects without it have no retained provenance. */
export const RETAINED_GENERATION_DIR = "generation";

/** Selection of one generated output: a 1-based index, a sha-256 prefix of at least 12 hex characters, or the full sha-256, resolved against the record (DEC-004). */
export interface GenerationOutputSelection {
  output?: string;
}

/**
 * The default label for one Generation Job output (#292): the Job id and the
 * output's 1-based record index — the index/short-hash vocabulary #291
 * established, spoken through this one shared function so no surface invents
 * a second spelling. The 64-character content hash stays a file fact, never
 * a caller-facing label.
 */
export function generationOutputLabel(jobId: string, outputIndex: number): string {
  return `${jobId} #${outputIndex}`;
}

export interface SelectedGenerationOutput {
  job: GenerationJobRecord;
  output: UniformOutput;
  /** The verified raw bytes of the selected output file. */
  bytes: Buffer;
  /** The verbatim record bytes — what retention stores. */
  recordBytes: Buffer;
}

/**
 * Read one recorded output's file and verify its bytes against the recorded
 * sha-256 identity — the one verification home shared by ingestion (one
 * selected output) and review (every output), so the two boundaries can never
 * drift. Everything that can refuse the source runs before the full read,
 * like the file-ingestion bound: lexical containment (the path's shape),
 * size on the open handle, then realpath containment (the file exists, so an
 * alias that resolves outside the job directory cannot dodge the gate).
 */
async function readVerifiedJobOutput(jobDir: string, jobId: string, output: UniformOutput): Promise<Buffer> {
  const outputFile = path.join(jobDir, output.file);
  if (outsideDir(jobDir, outputFile)) {
    throw new Error(
      `Generation Job "${jobId}" output path "${output.file}" escapes the job directory — the record cannot be trusted`,
    );
  }
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(outputFile);
  } catch {
    throw new Error(
      `Generation Job "${jobId}" output "${output.file}" is missing — the job's outputs are incomplete; refusing to ingest from an unavailable source`,
    );
  }
  if (!st.isFile()) {
    throw new Error(
      `Generation Job "${jobId}" output "${output.file}" is not a regular file; refusing to ingest`,
    );
  }
  if (st.size > MAX_ENCODED_BYTES) {
    throw new Error(
      `Generation Job "${jobId}" output "${output.file}" is ${(st.size / 1024 / 1024).toFixed(1)} MB — over the ${MAX_ENCODED_BYTES / 1024 / 1024} MB limit`,
    );
  }
  if (await escapesDirReal(jobDir, outputFile)) {
    throw new Error(
      `Generation Job "${jobId}" output path "${output.file}" escapes the job directory — the record cannot be trusted`,
    );
  }
  const bytes = await readFile(outputFile);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== output.contentHash) {
    throw new Error(
      `Generation Job "${jobId}" output "${output.file}" does not match its recorded content identity ${output.contentHash.slice(0, 12)} (actual ${actualHash.slice(0, 12)}) — the source is corrupted or mismatched; refusing to ingest`,
    );
  }
  return bytes;
}

/**
 * Every recorded output of one published Generation Job, each read and
 * verified against its recorded content identity — the review boundary's
 * evidence read (#109): a missing or corrupt output fails the whole review
 * instead of displaying unverified bytes. No Project state is touched.
 */
export async function loadVerifiedGenerationOutputs(
  jobRoot: string,
  jobId: string,
): Promise<{ job: GenerationJobRecord; outputs: { output: UniformOutput; bytes: Buffer }[] }> {
  if (!JOB_ID_PATTERN.test(jobId))
    throw new Error(`Invalid job id "${jobId}" — use lowercase letters/digits/hyphens`);
  const job = await loadGenerationJob(jobRoot, jobId);
  const jobDir = path.join(jobRoot, jobId);
  const outputs: { output: UniformOutput; bytes: Buffer }[] = [];
  for (const output of job.run.outputs) {
    outputs.push({ output, bytes: await readVerifiedJobOutput(jobDir, jobId, output) });
  }
  return { job, outputs };
}

/**
 * Resolve the external source of one generated output: load the published
 * record, select one output explicitly, read its file, and verify its bytes
 * against the recorded sha-256 identity. A record with more than one output
 * is refused without an explicit selection — no output is ever picked
 * implicitly. No Project state is read or written here.
 */
export async function selectGenerationOutput(
  jobRoot: string,
  jobId: string,
  selection: GenerationOutputSelection = {},
): Promise<SelectedGenerationOutput> {
  // Validate the id before any path is constructed from it — an invalid id
  // must not name a read outside the job root.
  if (!JOB_ID_PATTERN.test(jobId))
    throw new Error(`Invalid job id "${jobId}" — use lowercase letters/digits/hyphens`);
  const recordFile = path.join(jobRoot, jobId, "job.json");
  let recordBytes: Buffer;
  try {
    recordBytes = await readFile(recordFile);
  } catch {
    throw new Error(`No generation job "${jobId}" under ${jobRoot}`);
  }
  const job = parseGenerationJobRecord(recordBytes.toString("utf8"), jobId);
  const outputs = job.run.outputs;

  const output = chooseOutput(jobId, outputs, selection.output);
  const jobDir = path.join(jobRoot, jobId);
  const bytes = await readVerifiedJobOutput(jobDir, jobId, output);
  return { job, output, bytes, recordBytes };
}

/**
 * Resolve one output from a record. With no selection, a single-output
 * record resolves directly and a multi-output record is refused, naming every
 * choice. The selector grammar is unambiguous by construction (DEC-004):
 * fewer than 12 characters and all digits means a 1-based index; 12–64
 * lowercase hex characters means a sha-256 prefix (the full 64-character
 * hash is the degenerate exact-match prefix). An all-digit selector of 12+
 * characters is therefore always a prefix, never an index — no selector can
 * mean both. The option grammar normalizes uppercase hex at the boundary and
 * every surface forwards that normalized value; the resolver's own
 * lowercase is defense in depth, so no future wiring can make case matter.
 * A prefix must match exactly one output: zero
 * matches is unknown and more than one is ambiguous, both refused naming the
 * candidates.
 */
function chooseOutput(jobId: string, outputs: UniformOutput[], selector: string | undefined): UniformOutput {
  const choices = outputs
    .map((o, i) => `  ${i + 1}: ${o.contentHash.slice(0, 12)} (${path.basename(o.file)})`)
    .join("\n");
  if (selector === undefined) {
    if (outputs.length === 1) return outputs[0]!;
    throw new Error(
      `Generation Job "${jobId}" has ${outputs.length} outputs — select one with --output <n|sha256|prefix>:\n${choices}`,
    );
  }
  if (/^[1-9][0-9]{0,10}$/.test(selector)) {
    const index = Number(selector);
    if (index <= outputs.length) return outputs[index - 1]!;
  } else if (/^[0-9a-fA-F]{12,64}$/.test(selector)) {
    const hash = selector.toLowerCase();
    const matches = outputs.filter((o) => o.contentHash.startsWith(hash));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      // Name the candidates the prefix actually matched, with their original
      // 1-based indexes — the unknown refusal lists every output, but here
      // the selector already narrowed the set.
      const candidates = matches
        .map((m) => `  ${outputs.indexOf(m) + 1}: ${m.contentHash.slice(0, 12)} (${path.basename(m.file)})`)
        .join("\n");
      throw new Error(
        `Generation Job "${jobId}" --output "${selector}" is ambiguous — ${matches.length} outputs share this prefix — select one with --output <n|sha256|prefix>:\n${candidates}`,
      );
    }
  }
  throw new Error(
    `Generation Job "${jobId}" has no output "${selector}" — select one with --output <n|sha256|prefix>:\n${choices}`,
  );
}

/** One existing file resolved as a Generation Job output (#292). */
export interface ResolvedGenerationOutputFile {
  jobId: string;
  /** The output's 1-based index in the record's outputs. */
  outputIndex: number;
  output: UniformOutput;
}

/**
 * Resolve one existing file as a Generation Job output, purely by shape: the
 * file's parent directory is named `outputs` and its grandparent is a
 * job-id-shaped directory holding `job.json`. Anything else returns
 * `undefined` — the caller treats it as a plain local file, no refusal. A
 * job-id-shaped directory is a commitment, though: a missing or unreadable
 * record there is a broken Generation Job input, refused clearly naming the
 * job (#292), never silently degraded to a bare file-name label. And the
 * label is provenance: the caller's bytes are verified against the record's
 * sha-256 identity, and the recorded path is checked for job-directory
 * containment before matching — the same discipline readVerifiedJobOutput
 * applies at ingestion and review, so replaced or arbitrary bytes can never
 * ride under a Job's label (review CRAFT-1).
 */
export async function resolveGenerationOutputFile(
  filePath: string,
  bytes: Buffer,
): Promise<ResolvedGenerationOutputFile | undefined> {
  const outputsDir = path.dirname(filePath);
  if (path.basename(outputsDir) !== "outputs") return undefined;
  const jobDir = path.dirname(outputsDir);
  const jobId = path.basename(jobDir);
  if (!JOB_ID_PATTERN.test(jobId)) return undefined;
  let raw: string;
  try {
    raw = await readFile(path.join(jobDir, "job.json"), "utf8");
  } catch {
    throw new Error(
      `Generation Job output "${filePath}" sits in job directory "${jobId}", but its job record ` +
        `${path.join(jobDir, "job.json")} is missing or unreadable — a Generation Job output is labelled from ` +
        `its record, so a broken one is refused. Move the file out of outputs/ (or restore the record) to use it as a plain image.`,
    );
  }
  const job = parseGenerationJobRecord(raw, jobId);
  // Containment before matching — lexical (where the path would land) AND
  // real (where an in-job symlink points, review PROD-2), the same pair
  // readVerifiedJobOutput applies at ingestion and review. A recorded path
  // that no longer exists cannot be matched anyway, so its ENOENT is
  // tolerated here — matching and the byte check still gate the label.
  for (const o of job.run.outputs) {
    const recordedFile = path.join(jobDir, o.file);
    if (outsideDir(jobDir, recordedFile)) {
      throw new Error(
        `Generation Job "${jobId}" output path "${o.file}" escapes the job directory — the record cannot be trusted`,
      );
    }
    try {
      if (await escapesDirReal(jobDir, recordedFile)) {
        throw new Error(
          `Generation Job "${jobId}" output path "${o.file}" escapes the job directory (through a symlink) — the record cannot be trusted`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  const resolved = path.resolve(filePath);
  const index = job.run.outputs.findIndex((o) => path.resolve(path.join(jobDir, o.file)) === resolved);
  if (index < 0) {
    const choices = job.run.outputs
      .map((o, i) => `  ${i + 1}: ${o.contentHash.slice(0, 12)} (${path.basename(o.file)})`)
      .join("\n");
    throw new Error(
      `"${filePath}" is not a recorded output of Generation Job "${jobId}" — the record lists:\n${choices}`,
    );
  }
  const output = job.run.outputs[index]!;
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== output.contentHash) {
    throw new Error(
      `Generation Job output "${filePath}" does not match Generation Job "${jobId}" output ${index + 1} — ` +
        `its bytes hash to ${actualHash.slice(0, 12)}, but the record's identity is ${output.contentHash.slice(0, 12)} — ` +
        `the file was replaced or corrupted, and it will not be labelled with the Job's provenance`,
    );
  }
  return { jobId, outputIndex: index + 1, output };
}

/**
 * Retain a Generation Job record verbatim inside the Project under
 * `generation/<jobId>/job.json`. Caller must hold the Project lock and must
 * have verified the source already. An existing retained record must be
 * byte-identical to the source record — retained provenance is never
 * rewritten, so a mismatch means corrupted or tampered retention and the
 * ingestion is refused.
 */
export async function retainGenerationRecord(
  resolvedProjectRoot: string,
  jobId: string,
  recordBytes: Buffer,
): Promise<void> {
  const recordDir = path.join(resolvedProjectRoot, RETAINED_GENERATION_DIR, jobId);
  const recordPath = path.join(recordDir, "job.json");
  if (outsideDir(resolvedProjectRoot, recordPath)) {
    throw new Error(`Security error: retained record for "${jobId}" escapes project boundary.`);
  }
  let existing: Buffer | null = null;
  try {
    existing = await readFile(recordPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing) {
    if (await escapesDirReal(resolvedProjectRoot, recordPath)) {
      throw new Error(`Security error: retained record for "${jobId}" escapes project boundary.`);
    }
    if (!existing.equals(recordBytes)) {
      throw new Error(
        `Retained provenance for Generation Job "${jobId}" already exists in this Project and does not match the source record — retained provenance is immutable, so refusing to ingest`,
      );
    }
    return;
  }
  await mkdir(recordDir, { recursive: true });
  await atomicCreate(recordPath, recordBytes);
}

export interface RetainedProvenance {
  jobId: string;
  job: GenerationJobRecord;
  output: UniformOutput;
}

/**
 * The one canonical resolution reader: resolve a Project content identity
 * (a Layer revision's `contentHash`) to its retained generation provenance.
 * Zero matches mean the bytes are not generated content (an ordinary image).
 * More than one match means two retained Jobs claim the same bytes — the
 * provenance would be ambiguous, so this fails closed rather than report a
 * possibly wrong source. A malformed retained record also fails closed:
 * unreadable retained provenance is never silently skipped.
 *
 * Callers that read Project state should hold the Project lock, like every
 * other reader.
 */
export async function resolveRetainedProvenance(
  resolvedProjectRoot: string,
  contentHash: string,
): Promise<RetainedProvenance | null> {
  const genDir = path.join(resolvedProjectRoot, RETAINED_GENERATION_DIR);
  let entries: string[];
  try {
    entries = await readdir(genDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const matches: RetainedProvenance[] = [];
  for (const entry of entries.sort()) {
    const recordPath = path.join(genDir, entry, "job.json");
    let raw: string;
    try {
      raw = await readFile(recordPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // not a retained job (no record)
      throw err;
    }
    const job = parseGenerationJobRecord(raw, entry);
    const output = job.run.outputs.find((o) => o.contentHash === contentHash);
    if (output) matches.push({ jobId: job.jobId, job, output });
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `Retained provenance for content ${contentHash.slice(0, 12)} is ambiguous: Generation Jobs ${matches
        .map((m) => `"${m.jobId}"`)
        .join(", ")} all claim these bytes — refusing to report wrong provenance`,
    );
  }
  return matches[0]!;
}