/**
 * Legacy Generation Job records (REQ-013/REQ-014) — the read-only record
 * surface and immutable Asset adoption for the retired plate/object/creator
 * lifecycle (#114, spec #102).
 *
 * A job is one directory under the jobs root (`out/jobs/<jobId>/`):
 *   job.json                 — the record: request, typed references, run lineage
 *   candidates/<sha-256>.png — content-addressed candidate bytes
 *
 * The category-specific entry points (`jobs plates`, `jobs objects`,
 * `jobs creators`) and kind-dispatched `jobs rerun` generation are retired:
 * this module no longer starts or extends jobs. What remains is the one
 * canonical reader shared by inspection (`jobs show/list/review`), review
 * evidence, and adoption — `adoptCandidate` copies a recorded candidate into
 * the asset library through the normal contract and can never overwrite an
 * existing asset (see `writePlateAsset` in assets.ts). Adoption never edits a
 * Scene or unrelated assets. New generation goes through the uniform
 * operation (src/generation.ts, `ply generate`).
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { TextZone } from "./generate.js";
import { writePlateAsset, writeObjectAsset, writeCreatorAsset } from "./assets.js";
import { verifyTrueAlpha } from "./alpha.js";

/**
 * Job record schema versions. v1 is the legacy plate-only record; v2 the
 * legacy object record; v3 the legacy creator contract that attached identity
 * references first and pose last; v4 is the role-aware Plate/Object contract;
 * and v5 is the Creator contract that preserves caller order. Prompt-contract
 * changes bump the record even when its JSON shape is unchanged, so older
 * binaries fail closed rather than silently rerunning with different
 * semantics.
 */
const LEGACY_PLATE_JOB_SCHEMA_VERSION = 1 as const;
const LEGACY_OBJECT_JOB_SCHEMA_VERSION = 2 as const;
const LEGACY_CREATOR_JOB_SCHEMA_VERSION = 3 as const;
export const PLATE_JOB_SCHEMA_VERSION = 4 as const;
export const OBJECT_JOB_SCHEMA_VERSION = 4 as const;
export const CREATOR_JOB_SCHEMA_VERSION = 5 as const;

/** The three Generation Job kinds. */
export type JobKind = "plate" | "object" | "creator";

/** A generation reference with an explicit role and exact content identity. */
export interface TypedRef {
  role: string;
  path: string;
  /** sha-256 of the reference bytes, derived when the request was made. */
  contentHash: string;
}

export interface PlateJobRequest {
  kind: "plate";
  subject: string;
  zone: TextZone;
  model: string;
  count: number;
  temperature?: number;
  refs: TypedRef[];
}

/**
 * An isolated non-text object request (REQ-015): one standalone object, no
 * scene, no composite. Official logos and final text were rejected as targets
 * at the retired request boundary — the caller's own policy now governs what
 * they generate (ADR-0014).
 */
export interface ObjectJobRequest {
  kind: "object";
  subject: string;
  model: string;
  count: number;
  temperature?: number;
  refs: TypedRef[];
}

/**
 * A creator candidate request (REQ-017): an isolated creator figure. The
 * retired request boundary restricted roles to the creator set and required
 * ≥1 identity anchor; the uniform surface carries no such policy (ADR-0014) —
 * the consuming workflow's own instructions own the identity-anchor rule.
 */
export interface CreatorJobRequest {
  kind: "creator";
  subject: string;
  model: string;
  count: number;
  temperature?: number;
  refs: TypedRef[];
}

export type JobRequest = PlateJobRequest | ObjectJobRequest | CreatorJobRequest;

/**
 * The isolated form of a candidate (REQ-017): the true-alpha bytes the
 * matting pass produced, content-addressed beside the candidate that
 * generated them. This is the *only* home for a creator candidate's
 * adoptable bytes — adoption reads the matte, never the raw candidate, so
 * there is no second path by which opaque bytes could reach the library.
 */
export interface JobCandidateMatte {
  contentHash: string;
  /** Path relative to the job directory. */
  file: string;
  /** Which engine produced it — "native-alpha" when the model returned a real matte. */
  engine: string;
}

export interface JobCandidate {
  contentHash: string;
  /** Path relative to the job directory. */
  file: string;
  mediaType: string;
  /**
   * Present when the matting pass ran and succeeded for this candidate.
   * Absent means the pass failed (the run records why) — the candidate is
   * still reviewable evidence, but it cannot be adopted.
   */
  matte?: JobCandidateMatte;
}

export interface JobRun {
  ranAt: string;
  /** The resolved gateway model id actually called. */
  model: string;
  /** The full text sent to the model, composition suffix included. */
  fullPrompt: string;
  /**
   * Generation cost in USD, or null when the recorded basis cannot state one:
   * an unmeasured rate records its estimate here, but a call shape the rate
   * does not describe — a reference call on a text-only rate — records null
   * with a basis warning, never the wrong rate claimed as measured.
   */
  costUsd: number | null;
  costMeasured: boolean;
  warnings: string[];
  candidates: JobCandidate[];
}

export interface GenerationJob {
  schemaVersion:
    | typeof LEGACY_PLATE_JOB_SCHEMA_VERSION
    | typeof LEGACY_OBJECT_JOB_SCHEMA_VERSION
    | typeof LEGACY_CREATOR_JOB_SCHEMA_VERSION
    | typeof PLATE_JOB_SCHEMA_VERSION
    | typeof CREATOR_JOB_SCHEMA_VERSION;
  jobId: string;
  kind: JobKind;
  createdAt: string;
  request: JobRequest;
  runs: JobRun[];
}

export interface JobSummary {
  jobId: string;
  kind: JobKind;
  subject: string;
  createdAt: string;
  runs: number;
  candidates: number;
}

/**
 * Load a job record; missing, corrupt, or contradictory records fail loudly.
 * The record's `kind` mirrors `request.kind`, but a hand-edited or tampered
 * file could disagree — adoption and review dispatch on the record while the
 * request types describe the recorded contract, so an unvalidated
 * contradiction would let one job adopt under a different contract than it
 * recorded (bypassing the object alpha gate). Both are validated equal here,
 * the single ingestion point, and v1 records are pinned to plate jobs (v2
 * introduced object jobs).
 */
const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function jobDir(jobRoot: string, jobId: string): string {
  return path.join(jobRoot, jobId);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function loadJob(jobRoot: string, jobId: string): Promise<GenerationJob> {
  if (!JOB_ID_PATTERN.test(jobId))
    throw new Error(`Invalid job id "${jobId}" — use lowercase letters/digits/hyphens`);
  let raw: string;
  try {
    raw = await readFile(path.join(jobRoot, jobId, "job.json"), "utf8");
  } catch {
    throw new Error(`No generation job "${jobId}" under ${jobRoot}`);
  }
  try {
    const job = JSON.parse(raw) as GenerationJob;
    // The (schemaVersion, kind) matrix is the rollback boundary (PROD-1):
    // legacy records keep their versions and kinds on read, so an old record
    // never silently gains new semantics on inspection or adoption. Newer
    // contracts (v4 role-aware-Reference Plate/Object, v5 caller-ordered
    // Creator) were written by the retired generation entry points; this
    // binary no longer writes any legacy record, but records written before
    // the retirement remain readable. No record may claim a
    // version/kind pairing the retired writers
    // would never have written — a reader would misread such a pairing
    // (e.g. run a role-aware plate job with path-only prompt behavior under
    // its v1/v2 contract).
    const knownSchemaVersions = [
      LEGACY_PLATE_JOB_SCHEMA_VERSION,
      LEGACY_OBJECT_JOB_SCHEMA_VERSION,
      LEGACY_CREATOR_JOB_SCHEMA_VERSION,
      PLATE_JOB_SCHEMA_VERSION,
      CREATOR_JOB_SCHEMA_VERSION,
    ];
    if (!knownSchemaVersions.includes(job.schemaVersion))
      throw new Error(
        `unsupported job schemaVersion ${JSON.stringify(job.schemaVersion)} — this tool reads versions ${LEGACY_PLATE_JOB_SCHEMA_VERSION} (legacy plate), ${LEGACY_OBJECT_JOB_SCHEMA_VERSION} (legacy object), ${LEGACY_CREATOR_JOB_SCHEMA_VERSION} (legacy creator), ${PLATE_JOB_SCHEMA_VERSION} (role-aware-Reference plate/object), and ${CREATOR_JOB_SCHEMA_VERSION} (caller-ordered creator) only`,
      );
    if (job.kind !== job.request.kind)
      throw new Error(
        `Job "${jobId}" is contradictory: record kind ${JSON.stringify(job.kind)} does not match request kind ${JSON.stringify(job.request?.kind)} — it cannot be trusted and will not run`,
      );
    if (job.schemaVersion === LEGACY_PLATE_JOB_SCHEMA_VERSION && job.kind !== "plate")
      throw new Error(
        `Job "${jobId}" claims schemaVersion ${LEGACY_PLATE_JOB_SCHEMA_VERSION}, which is plate-only (a legacy record cannot carry kind ${JSON.stringify(job.kind)}) — it cannot be trusted and will not run`,
      );
    if (job.schemaVersion === LEGACY_OBJECT_JOB_SCHEMA_VERSION && job.kind !== "object")
      throw new Error(
        `Job "${jobId}" claims schemaVersion ${LEGACY_OBJECT_JOB_SCHEMA_VERSION}, which is the legacy object-job version, but its kind is ${JSON.stringify(job.kind)} — creator jobs require schemaVersion ${CREATOR_JOB_SCHEMA_VERSION} and role-aware plate jobs require schemaVersion ${PLATE_JOB_SCHEMA_VERSION}`,
      );
    if (job.schemaVersion === LEGACY_CREATOR_JOB_SCHEMA_VERSION && job.kind !== "creator")
      throw new Error(
        `Job "${jobId}" claims schemaVersion ${LEGACY_CREATOR_JOB_SCHEMA_VERSION}, which is the legacy creator-job version, but its kind is ${JSON.stringify(job.kind)} — plate and object jobs require schemaVersion ${PLATE_JOB_SCHEMA_VERSION}`,
      );
    if (job.schemaVersion === CREATOR_JOB_SCHEMA_VERSION && job.kind !== "creator")
      throw new Error(
        `Job "${jobId}" claims schemaVersion ${CREATOR_JOB_SCHEMA_VERSION}, which is the caller-ordered creator-job version, but its kind is ${JSON.stringify(job.kind)} — plate and object jobs require schemaVersion ${PLATE_JOB_SCHEMA_VERSION}`,
      );
    if (job.schemaVersion === PLATE_JOB_SCHEMA_VERSION && job.kind !== "plate" && job.kind !== "object")
      throw new Error(
        `Job "${jobId}" claims schemaVersion ${PLATE_JOB_SCHEMA_VERSION}, the role-aware-Reference prompt contract for plate and object jobs, but its kind is ${JSON.stringify(job.kind)} — creator jobs require schemaVersion ${CREATOR_JOB_SCHEMA_VERSION}`,
      );
    return job;
  } catch (err) {
    throw new Error(`Job "${jobId}" has an unreadable record: ${(err as Error).message}`);
  }
}

export async function listJobs(jobRoot: string): Promise<JobSummary[]> {
  let entries: string[];
  try {
    entries = (await stat(jobRoot)).isDirectory() ? await readdir(jobRoot) : [];
  } catch {
    return [];
  }
  const jobs: JobSummary[] = [];
  for (const entry of entries.sort()) {
    try {
      const job = await loadJob(jobRoot, entry);
      jobs.push({
        jobId: job.jobId,
        kind: job.kind,
        subject: job.request.subject,
        createdAt: job.createdAt,
        runs: job.runs.length,
        candidates: job.runs.reduce((n, r) => n + r.candidates.length, 0),
      });
    } catch {
      // Unreadable directories are not jobs (temp files, partial writes) — skip.
    }
  }
  return jobs;
}

/** What adoption wrote, and where it came from. */
export interface AdoptionResult {
  assetId: string;
  /**
   * The content identity of the bytes actually written — the Asset's own
   * identity (ADR-0002), which for a creator adoption is the matte's, not the
   * candidate's. The candidate this came from is named by `adoptedFrom`;
   * nothing stores either hash in the Asset's meta.
   */
  contentHash: string;
  imagePath: string;
  /** `job:<jobId>#<candidateHash>` — the lineage, the only home for it. */
  adoptedFrom: string;
}

/**
 * The candidate's own bytes, verified against the record. Review displays
 * these directly; adoption writes them when the evidence says so.
 */
export interface VerifiedCandidateBytes {
  file: string;
  bytes: Buffer;
  contentHash: string;
}

/**
 * What adoption would write for one recorded candidate — or why it cannot:
 *
 * - `"matte"` — the isolated form the matting pass produced; the bytes
 *   adoption writes for a creator candidate, and for an object candidate
 *   whose run recorded one (the identity reported is the matte's).
 * - `"candidate"` — the candidate's own verified bytes, adopted as-is: every
 *   plate (ADR-0011), and an object candidate with no recorded matte whose
 *   bytes pass the true-alpha gate (the defensive native-alpha route).
 * - `"none"` — recorded, legitimate non-adoptability, with the reason
 *   adoption raises and its precise cause: `"no-matte"` when no matte was
 *   recorded (a creator without one, or an object whose own bytes fail the
 *   gate), `"invalid-matte"` when a hash-matching recorded matte fails the
 *   true-alpha gate — present, but not an adoptable matte.
 */
export type AdoptionEvidence =
  | { from: "matte"; file: string; bytes: Buffer; contentHash: string; engine: string }
  | { from: "candidate"; file: string; bytes: Buffer; contentHash: string }
  | { from: "none"; cause: "no-matte" | "invalid-matte"; reason: string };

export interface ResolvedCandidateEvidence {
  /** The candidate's own bytes — read once, verified, never re-read. */
  candidate: VerifiedCandidateBytes;
  /** What adoption would write for it — or why it cannot. */
  evidence: AdoptionEvidence;
}

/**
 * The one canonical reader shared by adoption and review (REQ-015, REQ-017,
 * US-022), so the two can never drift. Read-only: it only reads and verifies
 * recorded bytes, and hands back the verified buffers for both the candidate
 * and — when one is what adoption writes — its evidence, so callers never
 * re-read the same bytes. A tampered or missing recorded file is not
 * evidence of non-adoptability: reading and identity verification happen
 * here first, and throw — a loud failure for both callers, never a silent
 * downgrade or a partial render.
 */
/**
 * The adoption surface's recovery for a candidate that failed the true-alpha
 * gate. One home: the gate (src/alpha.ts) states only the why, so every
 * adoption call site attaches the same next step through this helper.
 */
function adoptionRecovery(jobId: string): string {
  return (
    `Adoption requires true alpha (a transparent-background PNG with a real matte) — ` +
    `RGB chroma-key color distance alone cannot qualify an output (REQ-015, REQ-017). ` +
    `Category-specific generation is retired: record a new uniform Generation Job with "bun run generate" ` +
    `(use --intent isolated for isolated output), matte it explicitly with "bun run matte", and ingest it as a Layer — ` +
    `or adopt a candidate of job "${jobId}" that has a recorded matte.`
  );
}

export async function resolveAdoptionEvidence(
  jobRoot: string,
  jobId: string,
  kind: JobKind,
  cand: JobCandidate,
): Promise<ResolvedCandidateEvidence> {
  const dir = jobDir(jobRoot, jobId);
  const bytes = await readFile(path.join(dir, cand.file)).catch(() => {
    throw new Error(
      `Candidate file "${cand.file}" is missing — the job record cannot be adopted or rendered as review evidence`,
    );
  });
  const actual = sha256(bytes);
  if (actual !== cand.contentHash)
    throw new Error(
      `Candidate file "${cand.file}" no longer matches its recorded identity (sha-256 ${cand.contentHash}, actual ${actual}) — it cannot be adopted or rendered as review evidence`,
    );
  const candidate: VerifiedCandidateBytes = { file: cand.file, bytes, contentHash: cand.contentHash };

  // A plate is adopted as-is, opaque by contract (ADR-0011).
  if (kind === "plate")
    return {
      candidate,
      evidence: { from: "candidate", file: cand.file, bytes, contentHash: cand.contentHash },
    };

  // Creators and objects are adopted as their matte when one was recorded —
  // re-verified against the identity the run recorded, then the true-alpha
  // gate on the exact bytes that would enter the library.
  if (cand.matte) {
    const record = cand.matte;
    const matteBytes = await readFile(path.join(dir, record.file)).catch(() => {
      throw new Error(
        `Matte file "${record.file}" is missing — the job record cannot be adopted or rendered as review evidence`,
      );
    });
    const matteActual = sha256(matteBytes);
    if (matteActual !== record.contentHash)
      throw new Error(
        `Matte file "${record.file}" no longer matches its recorded identity (sha-256 ${record.contentHash}, actual ${matteActual}) — it cannot be adopted or rendered as review evidence`,
      );
    try {
      verifyTrueAlpha(matteBytes, record.file);
    } catch (err) {
      return {
        candidate,
        evidence: {
          from: "none",
          cause: "invalid-matte",
          reason: `${(err as Error).message} ${adoptionRecovery(jobId)}`,
        },
      };
    }
    return {
      candidate,
      evidence: {
        from: "matte",
        file: record.file,
        bytes: matteBytes,
        contentHash: record.contentHash,
        engine: record.engine,
      },
    };
  }

  if (kind === "creator")
    // A creator candidate is adopted as its matte — the raw candidate is
    // opaque by measurement, so there is no branch that could adopt it.
    return {
      candidate,
      evidence: {
        from: "none",
        cause: "no-matte",
        reason:
          `Candidate "${cand.file}" carries no matte — the matting pass did not produce one for it (see the run's warnings). ` +
          `Category-specific generation is retired: record a new uniform Generation Job with "bun run generate" ` +
          `(use --intent isolated for isolated output) and matte it explicitly with "bun run matte", ` +
          `or adopt a candidate of job "${jobId}" that has a recorded matte.`,
      },
    };

  // An object without a matte qualifies only through its own bytes: the same
  // true-alpha gate, so an opaque candidate is refused by name.
  try {
    verifyTrueAlpha(bytes, cand.file);
  } catch (err) {
    return {
      candidate,
      evidence: {
        from: "none",
        cause: "no-matte",
        reason: `${(err as Error).message} ${adoptionRecovery(jobId)}`,
      },
    };
  }
  return {
    candidate,
    evidence: { from: "candidate", file: cand.file, bytes, contentHash: cand.contentHash },
  };
}

/**
 * Adopt a recorded candidate as a new immutable Asset — the kind follows the
 * job: a plate job adopts a Plate Asset; a creator job adopts the candidate's
 * verified matte as a trial Cutout Asset (REQ-017); an object job adopts the
 * candidate's verified matte when its run produced one, or the candidate's
 * own natively isolated bytes otherwise, as an Object Asset (REQ-015). Every
 * route reads through resolveAdoptionEvidence — the one canonical reader
 * shared with review — so the identity gates cannot drift apart.
 *
 * The candidate is addressed by exact content hash (a unique prefix is
 * accepted); its bytes are re-derived and verified before adoption, so a
 * tampered or missing file cannot enter the library under a stale identity.
 * Overwriting an existing asset is unrepresentable — the write path refuses
 * existing ids.
 */
export async function adoptCandidate(
  jobRoot: string,
  jobId: string,
  candidateRef: string,
  assetId: string,
  opts: { libraryRoot: string; name?: string; tags?: string[] },
): Promise<AdoptionResult> {
  const job = await loadJob(jobRoot, jobId);
  // Uniqueness is on content identity: the same bytes recurring across runs
  // collapse to one candidate, so ambiguity only means two distinct hashes.
  const byHash = new Map<string, { cand: JobCandidate; run: JobRun }>();
  for (const { cand, run } of job.runs.flatMap((run) =>
    run.candidates.map((cand) => ({ cand, run })),
  )) {
    if (cand.contentHash.startsWith(candidateRef) && !byHash.has(cand.contentHash))
      byHash.set(cand.contentHash, { cand, run });
  }
  if (byHash.size === 0)
    throw new Error(`Job "${jobId}" has no candidate matching "${candidateRef}"`);
  if (byHash.size > 1)
    throw new Error(
      `Candidate reference "${candidateRef}" is ambiguous — it matches ${byHash.size} distinct candidates; use a longer hash prefix`,
    );
  // A recurring hash resolves to its first recorded run — the earliest lineage.
  const { cand, run } = byHash.values().next().value!;

  // The one canonical read: the candidate's verified bytes plus the evidence
  // of what adoption would write — or the recorded reason it cannot. Tampered
  // or missing recorded evidence throws here, before anything is written.
  const { evidence } = await resolveAdoptionEvidence(jobRoot, jobId, job.kind, cand);
  if (evidence.from === "none") throw new Error(evidence.reason);

  const adoptedFrom = `job:${jobId}#${cand.contentHash}`;
  const provenance = {
    ...(job.request.subject ? { subject: job.request.subject } : {}),
    ...(run.fullPrompt ? { fullPrompt: run.fullPrompt } : {}),
    model: run.model,
    adoptedFrom,
  };

  if (job.kind === "creator") {
    // A creator candidate is adopted as its matte — the isolated form the
    // matting pass produced (REQ-017). The resolver never hands back the raw
    // bytes for this kind, so the opaque candidate is unrepresentable here.
    if (evidence.from !== "matte")
      throw new Error("a creator candidate is only adoptable as its matte");
    // Trial is forced — adoption is never an approval (REQ-017, DEC-004):
    // only an explicit human decision promotes a Creator Asset through the library CLI.
    const imagePath = await writeCreatorAsset(opts.libraryRoot, assetId, evidence.bytes, {
      kind: "cutout",
      id: assetId,
      name: opts.name ?? assetId,
      tags: opts.tags ?? [],
      approval: "trial",
      ...provenance,
      matting: "true-alpha",
      matteEngine: evidence.engine,
    });
    // The identity of what was written is the matte's, not the candidate's —
    // the candidate lineage lives in `adoptedFrom` and nowhere else.
    return { assetId, contentHash: evidence.contentHash, imagePath, adoptedFrom };
  }

  if (job.kind === "object") {
    // An object candidate is adopted as its matte when the run's matting pass
    // produced one (REQ-015's segmentation route) — the raw candidate is
    // opaque by measurement. Without a matte the candidate's own verified
    // bytes qualify only through the true-alpha gate, which the resolver has
    // already applied — an opaque candidate is refused before any write.
    const imagePath = await writeObjectAsset(opts.libraryRoot, assetId, evidence.bytes, {
      kind: "object",
      id: assetId,
      name: opts.name ?? assetId,
      tags: opts.tags ?? [],
      ...provenance,
      matting: "true-alpha",
      ...(evidence.from === "matte" ? { matteEngine: evidence.engine } : {}),
    });
    // The identity of what was written is the matte's, not the candidate's —
    // the candidate lineage lives in `adoptedFrom` and nowhere else.
    return { assetId, contentHash: evidence.contentHash, imagePath, adoptedFrom };
  }

  const imagePath = await writePlateAsset(opts.libraryRoot, assetId, evidence.bytes, {
    kind: "plate",
    id: assetId,
    name: opts.name ?? assetId,
    tags: opts.tags ?? [],
    ...provenance,
  }, cand.mediaType);
  return { assetId, contentHash: evidence.contentHash, imagePath, adoptedFrom };
}
