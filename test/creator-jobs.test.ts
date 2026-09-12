import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadJob, listJobs, resolveIsolationEvidence } from "../src/jobs.js";
import { composeMatte } from "../src/matte.js";
import { encodePng } from "./png.js";
import { writeLegacyJob, type LegacyJobSpec } from "./legacy-jobs.js";

let root: string;
let jobRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-creator-jobs-"));
  jobRoot = path.join(root, "jobs");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * What the tested recipe actually returned: an opaque RGB figure on a plain
 * background (measured provider behavior). The fixtures model the records the
 * retired run lifecycle wrote: raw opaque candidates plus the matte the local
 * pass produced and recorded.
 */
const OPAQUE_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [200, 30, 40, 255] : [20, 90, 200, 255]),
  { colorType: 2 },
);

/** The segmentation mask the matting engine predicted for it. */
const MASK_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]),
  { colorType: 2 },
);

/** A candidate that already carries a real matte — the native-alpha route. */
const ALPHA_PNG = encodePng(16, 16, (x, y) =>
  x < 8 && y < 8 ? [255, 0, 0, 255] : [0, 0, 0, 0],
);

/** The matte the local pass composed for the opaque candidate. */
const MATTED_PNG = composeMatte(OPAQUE_PNG, MASK_PNG, "fixture");

/** An identity anchor file — writeLegacyJob writes it and records its derived identity. */
const anchorRef = () => ({ role: "identity", path: "fixture-anchor.png", bytes: Buffer.from("anchor-a-bytes") });

/** A creator record as a pre-retirement binary wrote it: opaque candidate + recorded matte. */
const creatorJob = (jobId: string, extra?: Partial<LegacyJobSpec>): LegacyJobSpec => ({
  jobId,
  kind: "creator",
  subject: "arms crossed, explaining to camera",
  refs: [anchorRef()],
  runs: [{
    model: "google/gemini-3.1-flash-image",
    fullPrompt: "CREATOR<arms crossed, explaining to camera>",
    candidates: [
      {
        bytes: Buffer.concat([OPAQUE_PNG, Buffer.from(`-${jobId}-one`)]),
        matteBytes: MATTED_PNG,
        matteEngine: "test/segmentation",
      },
      {
        bytes: Buffer.concat([OPAQUE_PNG, Buffer.from(`-${jobId}-two`)]),
        matteBytes: MATTED_PNG,
        matteEngine: "test/segmentation",
      },
    ],
  }],
  ...extra,
});

/** A creator record whose run recorded no matte — the pass failed before retirement. */
const noMatteCreatorJob = (jobId: string, extra?: Partial<LegacyJobSpec>): LegacyJobSpec => ({
  jobId,
  kind: "creator",
  subject: "arms crossed, explaining to camera",
  refs: [anchorRef()],
  runs: [{
    model: "google/gemini-3.1-flash-image",
    candidates: [{ bytes: Buffer.concat([OPAQUE_PNG, Buffer.from(`-${jobId}`)]) }],
    warnings: ["matte: candidate could not be isolated — mask model returned no image"],
  }],
  ...extra,
});

describe("loadJob record integrity for creator jobs", () => {
  test("rejects a v2 record claiming kind creator — the rollback boundary", async () => {
    await writeLegacyJob(jobRoot, creatorJob("creator-forged-v2", { schemaVersion: 2 }));
    // Without the refusal, a 0.16.1 binary would have run a creator job
    // through the plate path — bypassing the alpha gate entirely.
    await expect(loadJob(jobRoot, "creator-forged-v2")).rejects.toThrow(
      /schemaVersion 2|creator/i,
    );
  });

  test("rejects a v4 record claiming kind creator — v4 belongs to Plate/Object Jobs", async () => {
    // v4 is the role-aware-Reference prompt contract for Plate and Object
    // Jobs (#56, PROD-1); a Creator record under it has no contract.
    await writeLegacyJob(jobRoot, creatorJob("creator-forged-v4", { schemaVersion: 4 }));
    await expect(loadJob(jobRoot, "creator-forged-v4")).rejects.toThrow(/schemaVersion 4|creator/i);
  });
});

describe("resolveIsolationEvidence for creator records", () => {
  test("the recorded matte is the evidence — verified bytes, engine, and identity", async () => {
    const job = await writeLegacyJob(jobRoot, creatorJob("creator-matte"));
    const cand = job.runs[0]!.candidates[0]!;

    const { evidence } = await resolveIsolationEvidence(jobRoot, "creator-matte", "creator", cand);
    if (evidence.from !== "matte") throw new Error("expected the recorded matte");
    // The isolated form is the evidence — never the opaque candidate — and
    // the matte's identity is the one the run recorded.
    expect(evidence.contentHash).toBe(cand.matte!.contentHash);
    expect(evidence.contentHash).not.toBe(cand.contentHash);
    expect(evidence.engine).toBe("test/segmentation");
    expect(evidence.file).toBe(cand.matte!.file);
  });

  test("refuses a candidate the matting pass could not isolate — with replacement guidance, never the opaque bytes", async () => {
    await writeLegacyJob(jobRoot, noMatteCreatorJob("creator-opaque"));
    const job = await loadJob(jobRoot, "creator-opaque");
    const hash = job.runs[0]!.candidates[0]!.contentHash;

    const { evidence } = await resolveIsolationEvidence(jobRoot, "creator-opaque", "creator", {
      ...job.runs[0]!.candidates[0]!,
    });
    expect(evidence.from).toBe("none");
    if (evidence.from !== "none") throw new Error("unreachable");
    expect(evidence.cause).toBe("no-matte");
    expect(evidence.reason).toMatch(/no matte/i);
    // The refusal directs callers at the replacement workflow, not the
    // retired commands.
    expect(evidence.reason).toMatch(/ply generate/);
    expect(evidence.reason).toMatch(/ply matte/);
    expect(evidence.reason).toMatch(/--from-matte/);
    expect(evidence.reason).not.toMatch(/jobs rerun/);
    expect(evidence.reason).not.toMatch(/jobs adopt|library adopt/);
  });

  test("refuses a tampered matte — the evidence must match the record", async () => {
    await writeLegacyJob(jobRoot, creatorJob("creator-tamper"));
    const job = await loadJob(jobRoot, "creator-tamper");
    const cand = job.runs[0]!.candidates[0]!;
    await writeFile(path.join(jobRoot, "creator-tamper", cand.matte!.file), ALPHA_PNG);

    await expect(
      resolveIsolationEvidence(jobRoot, "creator-tamper", "creator", cand),
    ).rejects.toThrow(/no longer matches its recorded identity/i);
  });

  test("refuses a matte that does not carry true alpha — the gate holds independently", async () => {
    // A hand-edited record pointing the matte at opaque bytes: the pass's own
    // verification is bypassed, and the gate must still refuse.
    await writeLegacyJob(jobRoot, creatorJob("creator-forged-matte"));
    const file = path.join(jobRoot, "creator-forged-matte", "job.json");
    const rec = JSON.parse(await readFile(file, "utf8"));
    const cand = rec.runs[0].candidates[0];
    rec.runs[0].candidates[0].matte = {
      file: cand.file,
      contentHash: cand.contentHash,
      engine: "forged",
    };
    await writeFile(file, JSON.stringify(rec, null, 2));

    // Read the record as it now stands — the resolver must gate on the
    // recorded matte, not on anything the pass verified earlier.
    const job = await loadJob(jobRoot, "creator-forged-matte");
    const { evidence } = await resolveIsolationEvidence(jobRoot, "creator-forged-matte", "creator", job.runs[0]!.candidates[0]!);
    expect(evidence.from).toBe("none");
    if (evidence.from !== "none") throw new Error("unreachable");
    expect(evidence.cause).toBe("invalid-matte");
    expect(evidence.reason).toMatch(/chroma-key|alpha/i);
  });
});

describe("listJobs with creator jobs", () => {
  test("summarizes creator jobs from one jobs root", async () => {
    await writeLegacyJob(jobRoot, creatorJob("creator-a"));
    const jobs = await listJobs(jobRoot);
    const a = jobs.find((j) => j.jobId === "creator-a")!;
    expect(a.kind).toBe("creator");
    expect(a.subject).toBe("arms crossed, explaining to camera");
    expect(a.candidates).toBe(2);
  });
});