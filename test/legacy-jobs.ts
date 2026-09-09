/**
 * Legacy plate/object/creator Generation Job record fixtures.
 *
 * The record writers were retired with the category-specific generation entry
 * points (#114). The retained read-only surfaces — `loadJob`/`listJobs`,
 * `jobs review`, and candidate adoption — still serve records written before
 * the retirement, and these fixtures are exactly such records: they write the
 * same on-disk shape the retired writers produced (schemaVersion 4/5,
 * content-addressed candidates and mattes, typed references with derived
 * identities) directly under a jobs root.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { extensionFor } from "../src/assets.js";
import type {
  GenerationJob,
  JobKind,
  PlateJobRequest,
  ObjectJobRequest,
  CreatorJobRequest,
  JobRun,
} from "../src/jobs.js";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** One recorded candidate: its bytes and, optionally, the matte the run recorded for it. */
export interface LegacyCandidateSpec {
  bytes: Uint8Array;
  mediaType?: string;
  /** When set, the run recorded this matte (content-addressed under mattes/). */
  matteBytes?: Uint8Array;
  matteEngine?: string;
}

export interface LegacyRunSpec {
  candidates: LegacyCandidateSpec[];
  model?: string;
  fullPrompt?: string;
  ranAt?: string;
  warnings?: string[];
  costUsd?: number | null;
  costMeasured?: boolean;
}

/** A typed reference: the helper writes the bytes (when given) and derives the recorded identity. */
export interface LegacyRefSpec {
  role: string;
  path: string;
  bytes?: Uint8Array;
}

export interface LegacyJobSpec {
  jobId: string;
  kind: JobKind;
  /** Defaults to the last version the retired writers produced: 5 for creator, 4 otherwise. */
  schemaVersion?: number;
  subject?: string;
  refs?: LegacyRefSpec[];
  runs: LegacyRunSpec[];
  createdAt?: string;
}

/**
 * Write one legacy Generation Job record plus its candidate/matte/reference
 * files, exactly as the retired writers laid them out. Returns the parsed
 * record that `loadJob` will read back.
 */
export async function writeLegacyJob(jobRoot: string, spec: LegacyJobSpec): Promise<GenerationJob> {
  const dir = path.join(jobRoot, spec.jobId);
  // Relative reference paths resolve against the temp root (the jobs root's
  // parent) — never the test process's cwd.
  const base = path.dirname(jobRoot);
  const refs: { role: string; path: string; contentHash: string }[] = [];
  for (const ref of spec.refs ?? []) {
    const refPath = path.isAbsolute(ref.path) ? ref.path : path.resolve(base, ref.path);
    if (ref.bytes !== undefined) {
      await mkdir(path.dirname(refPath), { recursive: true });
      await writeFile(refPath, ref.bytes);
    }
    refs.push({ role: ref.role, path: refPath, contentHash: sha256(await readFile(refPath)) });
  }

  const request: PlateJobRequest | ObjectJobRequest | CreatorJobRequest =
    spec.kind === "plate"
      ? { kind: "plate", subject: spec.subject ?? "a plate subject", zone: "left", model: "gpt-image", count: 1, refs }
      : spec.kind === "object"
        ? { kind: "object", subject: spec.subject ?? "an object subject", model: "gpt-image", count: 1, refs }
        : { kind: "creator", subject: spec.subject ?? "a creator subject", model: "nano-2", count: 1, refs };

  const candidatesDir = path.join(dir, "candidates");
  await mkdir(candidatesDir, { recursive: true });

  const runs: JobRun[] = [];
  for (const [i, run] of spec.runs.entries()) {
    const candidates: GenerationJob["runs"][number]["candidates"] = [];
    for (const cand of run.candidates) {
      const mediaType = cand.mediaType ?? "image/png";
      const contentHash = sha256(cand.bytes);
      const file = path.join("candidates", `${contentHash}.${extensionFor(mediaType)}`);
      await writeFile(path.join(dir, file), cand.bytes);
      const record: GenerationJob["runs"][number]["candidates"][number] = {
        contentHash,
        file,
        mediaType,
      };
      if (cand.matteBytes !== undefined) {
        const matteHash = sha256(cand.matteBytes);
        const matteFile = path.join("mattes", `${matteHash}.png`);
        await mkdir(path.join(dir, "mattes"), { recursive: true });
        await writeFile(path.join(dir, matteFile), cand.matteBytes);
        record.matte = { contentHash: matteHash, file: matteFile, engine: cand.matteEngine ?? "fake-engine" };
      }
      candidates.push(record);
    }
    // The retired writers recorded the RESOLVED gateway id in run.model
    // (resolveModel(request.model).id), not the caller's registry key.
    const resolvedModel =
      run.model ?? (spec.kind === "creator" ? "google/gemini-3.1-flash-image" : "openai/gpt-image-2");
    runs.push({
      ranAt: run.ranAt ?? `2026-09-0${(i % 9) + 1}T12:00:00.000Z`,
      model: resolvedModel,
      fullPrompt: run.fullPrompt ?? `effective prompt for ${spec.subject ?? spec.jobId}`,
      costUsd: run.costUsd ?? null,
      costMeasured: run.costMeasured ?? false,
      warnings: run.warnings ?? [],
      candidates,
    });
  }

  const job: GenerationJob = {
    // The union member the retired writers wrote for this kind; the reader
    // validates the (schemaVersion, kind) pairing.
    schemaVersion: (spec.schemaVersion ??
      (spec.kind === "creator" ? 5 : 4)) as GenerationJob["schemaVersion"],
    jobId: spec.jobId,
    kind: spec.kind,
    createdAt: spec.createdAt ?? "2026-09-01T00:00:00.000Z",
    request,
    runs,
  };
  await writeFile(path.join(dir, "job.json"), JSON.stringify(job, null, 2) + "\n");
  return job;
}
