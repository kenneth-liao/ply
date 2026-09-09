import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadJob,
  listJobs,
  resolveIsolationEvidence,
  PLATE_JOB_SCHEMA_VERSION,
  OBJECT_JOB_SCHEMA_VERSION,
  CREATOR_JOB_SCHEMA_VERSION,
} from "../src/jobs.js";
import { writeLegacyJob, type LegacyJobSpec } from "./legacy-jobs.js";

let root: string;
let jobRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-jobs-"));
  jobRoot = path.join(root, "jobs");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A two-candidate plate record, as a pre-retirement binary would have written it. */
const plateJob = (jobId: string, extra?: Partial<LegacyJobSpec>): LegacyJobSpec => ({
  jobId,
  kind: "plate",
  subject: "neon server room",
  runs: [{
    candidates: [
      { bytes: Buffer.from(`${jobId}-candidate-one`) },
      { bytes: Buffer.from(`${jobId}-candidate-two`) },
    ],
    warnings: ["gpt-image: unsupported setting"],
  }],
  ...extra,
});

describe("resolveIsolationEvidence — the canonical reader", () => {
  test("returns a plate candidate's own verified bytes as its evidence", async () => {
    const job = await writeLegacyJob(jobRoot, plateJob("plate-read"));
    const cand = job.runs[0]!.candidates[0]!;

    const { candidate, evidence } = await resolveIsolationEvidence(jobRoot, "plate-read", "plate", cand);
    expect(candidate.contentHash).toBe(cand.contentHash);
    // A plate carries no isolation evidence — its recorded bytes are the
    // review evidence as-is (opaque by contract, ADR-0011).
    expect(evidence).toMatchObject({ from: "candidate", contentHash: cand.contentHash });
  });

  test("fails loudly when the candidate file no longer matches its recorded identity", async () => {
    const job = await writeLegacyJob(jobRoot, plateJob("plate-tamper"));
    const cand = job.runs[0]!.candidates[0]!;
    await writeFile(path.join(jobRoot, "plate-tamper", cand.file), "tampered");
    await expect(
      resolveIsolationEvidence(jobRoot, "plate-tamper", "plate", cand),
    ).rejects.toThrow(/identity/i);
  });
});

describe("loadJob and listJobs", () => {
  test("loadJob fails loudly on a missing or corrupt record", async () => {
    await expect(loadJob(jobRoot, "nope")).rejects.toThrow(/nope/);
    await mkdir(path.join(jobRoot, "bad-job"), { recursive: true });
    await writeFile(path.join(jobRoot, "bad-job", "job.json"), "{not json");
    await expect(loadJob(jobRoot, "bad-job")).rejects.toThrow(/bad-job/);
  });

  test("listJobs summarizes every recorded job", async () => {
    await writeLegacyJob(jobRoot, {
      jobId: "plate-a",
      kind: "plate",
      subject: "neon server room",
      runs: [
        { candidates: [{ bytes: Buffer.from("a1") }, { bytes: Buffer.from("a2") }] },
        { candidates: [{ bytes: Buffer.from("a3") }, { bytes: Buffer.from("a4") }] },
      ],
    });
    await writeLegacyJob(jobRoot, {
      jobId: "plate-b",
      kind: "plate",
      runs: [{ candidates: [{ bytes: Buffer.from("b1") }] }],
    });

    const jobs = await listJobs(jobRoot);
    expect(jobs).toHaveLength(2);
    const a = jobs.find((j) => j.jobId === "plate-a")!;
    expect(a).toMatchObject({ kind: "plate", subject: "neon server room", runs: 2, candidates: 4 });
    const b = jobs.find((j) => j.jobId === "plate-b")!;
    expect(b).toMatchObject({ runs: 1, candidates: 1 });
  });
});

/** Rewrite a recorded job file at a chosen schemaVersion — a record as another binary would have written it. */
async function reversion(jobId: string, schemaVersion: number): Promise<void> {
  const file = path.join(jobRoot, jobId, "job.json");
  const rec = JSON.parse(await readFile(file, "utf8"));
  rec.schemaVersion = schemaVersion;
  await writeFile(file, JSON.stringify(rec, null, 2) + "\n");
}

describe("the job schema-version matrix is the rollback boundary (PROD-1, #56)", () => {
  test("the reader's known prompt contracts have rollback-safe schema versions", () => {
    // Released binaries (≤ 0.29.2) accept any of {1,2,3} with a plate or
    // object kind — reusing those numbers would let an older binary silently
    // misread a role-aware job with path-only prompt behavior. The role-aware
    // Plate/Object role semantics ride v4 and caller-ordered Creator
    // references ride v5. Older binaries reject both versions they do not
    // understand; this binary still reads legacy v1/v2/v3 records.
    expect(PLATE_JOB_SCHEMA_VERSION).toBe(4);
    expect(OBJECT_JOB_SCHEMA_VERSION).toBe(4);
    expect(CREATOR_JOB_SCHEMA_VERSION).toBe(5);
  });

  test("a legacy v1 plate record stays readable as v1 — never re-versioned on read", async () => {
    await writeLegacyJob(jobRoot, plateJob("plate-legacy-v1", { schemaVersion: 1 }));

    // Pure legacy read: the record loads as v1, with no rewrite on read.
    expect((await loadJob(jobRoot, "plate-legacy-v1")).schemaVersion).toBe(1);
    const record = JSON.parse(await readFile(path.join(jobRoot, "plate-legacy-v1", "job.json"), "utf8"));
    expect(record.schemaVersion).toBe(1);
    expect(record.runs).toHaveLength(1);
  });

  test("refuses a v2 record claiming kind plate — an older binary would misread it", async () => {
    await writeLegacyJob(jobRoot, plateJob("plate-forged-v2", { schemaVersion: 2 }));
    await expect(loadJob(jobRoot, "plate-forged-v2")).rejects.toThrow(/schemaVersion 2/);
  });

  test("refuses a v3 record claiming kind plate — creator is v3 alone", async () => {
    await writeLegacyJob(jobRoot, plateJob("plate-forged-v3", { schemaVersion: 3 }));
    await expect(loadJob(jobRoot, "plate-forged-v3")).rejects.toThrow(/schemaVersion 3/);
  });

  test("refuses an unknown schemaVersion outright — the fail-closed default", async () => {
    await writeLegacyJob(jobRoot, plateJob("plate-forged-v9", { schemaVersion: 9 }));
    await expect(loadJob(jobRoot, "plate-forged-v9")).rejects.toThrow(/unsupported job schemaVersion/);
  });
});

