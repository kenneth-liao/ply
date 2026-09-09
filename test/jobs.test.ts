import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  loadJob,
  listJobs,
  adoptCandidate,
  PLATE_JOB_SCHEMA_VERSION,
  OBJECT_JOB_SCHEMA_VERSION,
  CREATOR_JOB_SCHEMA_VERSION,
} from "../src/jobs.js";
import { scanLibrary } from "../src/assets.js";
import { writeLegacyJob, type LegacyJobSpec } from "./legacy-jobs.js";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let root: string;
let jobRoot: string;
let libraryRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-jobs-"));
  jobRoot = path.join(root, "jobs");
  libraryRoot = path.join(root, "library");
  await mkdir(libraryRoot, { recursive: true });
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

describe("adoptCandidate", () => {
  test("adopts a candidate as a new immutable Plate Asset with job provenance", async () => {
    const job = await writeLegacyJob(jobRoot, plateJob("plate-adopt"));
    const cand = job.runs[0]!.candidates[0]!;

    const result = await adoptCandidate(jobRoot, "plate-adopt", cand.contentHash, "neon-room", {
      libraryRoot,
      name: "Neon Room",
      tags: ["neon", "tech"],
    });

    const lib = await scanLibrary(libraryRoot);
    const plate = lib.plates.find((p) => p.meta.id === "neon-room")!;
    expect(plate).toBeDefined();
    expect(plate.hash).toBe(cand.contentHash);
    expect(plate.meta.kind).toBe("plate");
    expect(plate.meta.subject).toBe("neon server room");
    expect(plate.meta.fullPrompt).toBe(job.runs[0]!.fullPrompt);
    expect(plate.meta.model).toBe(job.runs[0]!.model);
    expect(plate.meta.adoptedFrom).toBe(`job:plate-adopt#${cand.contentHash}`);
    expect(result.imagePath).toBe(plate.imagePath);
  });

  test("never overwrites an existing adopted asset", async () => {
    const job = await writeLegacyJob(jobRoot, plateJob("plate-overwrite"));
    const cand = job.runs[0]!.candidates[0]!;
    await adoptCandidate(jobRoot, "plate-overwrite", cand.contentHash, "taken-id", { libraryRoot });

    const other = job.runs[0]!.candidates[1]!;
    await expect(
      adoptCandidate(jobRoot, "plate-overwrite", other.contentHash, "taken-id", { libraryRoot }),
    ).rejects.toThrow(/already exists/i);

    // The first adoption's bytes are unchanged — the refused adoption wrote nothing.
    const lib = await scanLibrary(libraryRoot);
    const plate = lib.plates.find((p) => p.meta.id === "taken-id")!;
    expect(plate.hash).toBe(cand.contentHash);
  });

  test("resolves a unique hash prefix and rejects ambiguous or unknown ones", async () => {
    const job = await writeLegacyJob(jobRoot, plateJob("plate-prefix"));
    const [a, b] = job.runs[0]!.candidates;
    const common = longestCommonPrefix(a!.contentHash, b!.contentHash);

    await adoptCandidate(jobRoot, "plate-prefix", a!.contentHash.slice(0, 12), "prefix-ok", { libraryRoot });
    const lib = await scanLibrary(libraryRoot);
    expect(lib.plates.find((p) => p.meta.id === "prefix-ok")!.hash).toBe(a!.contentHash);

    // A shared prefix matching two candidates is ambiguous.
    expect(common.length).toBeLessThan(12);
    await expect(
      adoptCandidate(jobRoot, "plate-prefix", common, "prefix-bad", { libraryRoot }),
    ).rejects.toThrow(/ambiguous|match/i);
    await expect(
      adoptCandidate(jobRoot, "plate-prefix", "ffffffff", "prefix-bad", { libraryRoot }),
    ).rejects.toThrow(/no candidate/i);
  });

  test("adopts a content identity that recurs across runs — ambiguity is about distinct hashes", async () => {
    // The same bytes recorded in two runs (as a pre-retirement rerun could):
    // one distinct identity, adoptable even by a short prefix, with its
    // provenance resolved to the earliest run that produced it.
    await writeLegacyJob(jobRoot, {
      jobId: "plate-recur",
      kind: "plate",
      runs: [
        { candidates: [{ bytes: Buffer.from("same-bytes-every-run") }], fullPrompt: "identical output" },
        { candidates: [{ bytes: Buffer.from("same-bytes-every-run") }], fullPrompt: "identical output" },
      ],
    });

    const record = await loadJob(jobRoot, "plate-recur");
    expect(record.runs).toHaveLength(2);
    expect(record.runs[1]!.candidates[0]!.contentHash).toBe(record.runs[0]!.candidates[0]!.contentHash);

    const hash = record.runs[1]!.candidates[0]!.contentHash;
    const result = await adoptCandidate(jobRoot, "plate-recur", hash.slice(0, 10), "recur-id", { libraryRoot });
    expect(result.contentHash).toBe(hash);
    const lib = await scanLibrary(libraryRoot);
    expect(lib.plates.find((p) => p.meta.id === "recur-id")!.meta.fullPrompt).toBe("identical output");
  });

  test("fails loudly when the candidate file no longer matches its recorded identity", async () => {
    const job = await writeLegacyJob(jobRoot, plateJob("plate-tamper"));
    const cand = job.runs[0]!.candidates[0]!;
    await writeFile(path.join(jobRoot, "plate-tamper", cand.file), "tampered");
    await expect(
      adoptCandidate(jobRoot, "plate-tamper", cand.contentHash, "tamper-id", { libraryRoot }),
    ).rejects.toThrow(/identity/i);
  });

  test("adopts a non-PNG candidate under its real media type", async () => {
    await writeLegacyJob(jobRoot, {
      jobId: "plate-jpeg",
      kind: "plate",
      runs: [{ candidates: [{ bytes: Buffer.from("jpeg-candidate-bytes"), mediaType: "image/jpeg" }] }],
    });
    const job = await loadJob(jobRoot, "plate-jpeg");
    const hash = job.runs[0]!.candidates[0]!.contentHash;

    await adoptCandidate(jobRoot, "plate-jpeg", hash, "jpeg-id", { libraryRoot });
    const stored = await readFile(path.join(libraryRoot, "plates", "jpeg-id", "plate.jpg"));
    expect(sha256(stored)).toBe(hash);
    // A duplicate-id adoption of the other media type still cannot overwrite.
    await writeLegacyJob(jobRoot, plateJob("plate-png"));
    const pngJob = await loadJob(jobRoot, "plate-png");
    await expect(
      adoptCandidate(jobRoot, "plate-png", pngJob.runs[0]!.candidates[0]!.contentHash, "jpeg-id", { libraryRoot }),
    ).rejects.toThrow(/already exists/i);
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

  test("a legacy v1 plate record stays readable as v1 — and adoptable unchanged", async () => {
    await writeLegacyJob(jobRoot, plateJob("plate-legacy-v1", { schemaVersion: 1 }));

    // Pure legacy read: the record loads as v1, with no rewrite on read.
    expect((await loadJob(jobRoot, "plate-legacy-v1")).schemaVersion).toBe(1);

    const record = JSON.parse(await readFile(path.join(jobRoot, "plate-legacy-v1", "job.json"), "utf8"));
    expect(record.schemaVersion).toBe(1);
    expect(record.runs).toHaveLength(1);

    // The legacy record adopts unchanged — inspection and adoption never
    // re-persist or re-version a record they only read.
    const hash = record.runs[0]!.candidates[0]!.contentHash;
    const out = await adoptCandidate(jobRoot, "plate-legacy-v1", hash, "legacy-plate", { libraryRoot });
    expect(out.adoptedFrom).toBe(`job:plate-legacy-v1#${hash}`);
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

function longestCommonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}
