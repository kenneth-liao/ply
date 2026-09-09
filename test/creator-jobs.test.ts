import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadJob, listJobs, adoptCandidate } from "../src/jobs.js";
import { composeMatte } from "../src/matte.js";
import { scanLibrary, writePlateAsset } from "../src/assets.js";
import { encodePng } from "./png.js";
import { writeLegacyJob, type LegacyJobSpec } from "./legacy-jobs.js";

let root: string;
let jobRoot: string;
let libraryRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-creator-jobs-"));
  jobRoot = path.join(root, "jobs");
  libraryRoot = path.join(root, "library");
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
    // Without the refusal, a 0.16.1 binary would adopt a creator job through
    // the plate path — bypassing the alpha gate entirely.
    await expect(loadJob(jobRoot, "creator-forged-v2")).rejects.toThrow(
      /schemaVersion 2|creator/i,
    );
    await expect(
      adoptCandidate(jobRoot, "creator-forged-v2", "0", "no-gate", { libraryRoot }),
    ).rejects.toThrow(/schemaVersion 2|creator/i);
  });

  test("rejects a v4 record claiming kind creator — v4 belongs to Plate/Object Jobs", async () => {
    // v4 is the role-aware-Reference prompt contract for Plate and Object
    // Jobs (#56, PROD-1); a Creator record under it has no contract.
    await writeLegacyJob(jobRoot, creatorJob("creator-forged-v4", { schemaVersion: 4 }));
    await expect(loadJob(jobRoot, "creator-forged-v4")).rejects.toThrow(/schemaVersion 4|creator/i);
    await expect(
      adoptCandidate(jobRoot, "creator-forged-v4", "0", "no-gate", { libraryRoot }),
    ).rejects.toThrow(/schemaVersion 4|creator/i);
  });
});

describe("adoptCandidate for creator jobs", () => {
  test("adopts the candidate's matte as a trial Cutout Asset with job and matte provenance", async () => {
    const job = await writeLegacyJob(jobRoot, creatorJob("creator-adopt"));
    const cand = job.runs[0]!.candidates[0]!;

    const result = await adoptCandidate(jobRoot, "creator-adopt", cand.contentHash, "creator-crossed", {
      libraryRoot,
      name: "Arms Crossed",
      tags: ["arms-crossed", "explaining"],
    });

    expect(result.adoptedFrom).toBe(`job:creator-adopt#${cand.contentHash}`);
    const lib = await scanLibrary(libraryRoot);
    const asset = lib.cutouts.find((c) => c.meta.id === "creator-crossed")!;
    expect(asset).toBeDefined();
    // The Asset's bytes are the matte — the isolated form, not the opaque
    // candidate — and the candidate it came from stays in the provenance.
    expect(asset.hash).toBe(cand.matte!.contentHash);
    expect(asset.meta.kind).toBe("cutout");
    if (asset.meta.kind === "cutout") {
      // Trial is forced: adoption is never an approval (REQ-017, DEC-004).
      expect(asset.meta.approval).toBe("trial");
      expect(asset.meta.model).toBe("google/gemini-3.1-flash-image");
      expect(asset.meta.subject).toBe("arms crossed, explaining to camera");
      expect(asset.meta.fullPrompt).toBe("CREATOR<arms crossed, explaining to camera>");
      expect(asset.meta.adoptedFrom).toBe(`job:creator-adopt#${cand.contentHash}`);
      expect(asset.meta.matting).toBe("true-alpha");
      expect(asset.meta.matteEngine).toBe("test/segmentation");
      // No content identity is stored in meta — it is derived from the bytes
      // at scan time (ADR-0002); the lineage lives in adoptedFrom alone.
      expect(JSON.stringify(asset.meta)).not.toContain(cand.matte!.contentHash);
      expect(Object.keys(asset.meta)).not.toContain("matteHash");
    }
    // The reported identity is the Asset's own — the bytes that were written,
    // which for a creator adoption are the matte's, not the candidate's (RE-1).
    expect(result.contentHash).toBe(cand.matte!.contentHash);
    expect(result.contentHash).toBe(asset.hash);
    expect(result.contentHash).not.toBe(cand.contentHash);
    expect(result.imagePath.endsWith(path.join("creator-crossed", "cutout.png"))).toBe(true);
  });

  test("refuses a candidate the matting pass could not isolate — never the opaque bytes", async () => {
    await writeLegacyJob(jobRoot, noMatteCreatorJob("creator-opaque"));
    const job = await loadJob(jobRoot, "creator-opaque");
    const hash = job.runs[0]!.candidates[0]!.contentHash;

    await expect(
      adoptCandidate(jobRoot, "creator-opaque", hash, "opaque-creator", { libraryRoot }),
    ).rejects.toThrow(/no matte/i);
    // The refusal directs callers at the replacement workflow, not the
    // retired commands.
    try {
      await adoptCandidate(jobRoot, "creator-opaque", hash, "opaque-creator-2", { libraryRoot });
      throw new Error("adoption should have been refused");
    } catch (err) {
      expect((err as Error).message).toMatch(/bun run generate/);
      expect((err as Error).message).not.toMatch(/jobs rerun/);
    }
    const lib = await scanLibrary(libraryRoot);
    expect(lib.cutouts).toHaveLength(0);
  });

  test("refuses a tampered matte — the adopted bytes must match the record", async () => {
    await writeLegacyJob(jobRoot, creatorJob("creator-tamper"));
    const job = await loadJob(jobRoot, "creator-tamper");
    const cand = job.runs[0]!.candidates[0]!;
    await writeFile(path.join(jobRoot, "creator-tamper", cand.matte!.file), ALPHA_PNG);

    await expect(
      adoptCandidate(jobRoot, "creator-tamper", cand.contentHash, "tampered", { libraryRoot }),
    ).rejects.toThrow(/no longer matches its recorded identity/i);
    expect((await scanLibrary(libraryRoot)).cutouts).toHaveLength(0);
  });

  test("refuses a matte that does not carry true alpha — the gate holds independently", async () => {
    // A hand-edited record pointing the matte at opaque bytes: the pass's own
    // verification is bypassed, and the adoption gate must still refuse.
    await writeLegacyJob(jobRoot, creatorJob("creator-forged-matte"));
    const job = await loadJob(jobRoot, "creator-forged-matte");
    const cand = job.runs[0]!.candidates[0]!;
    const file = path.join(jobRoot, "creator-forged-matte", "job.json");
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.runs[0].candidates[0].matte = {
      file: cand.file,
      contentHash: cand.contentHash,
      engine: "forged",
    };
    await writeFile(file, JSON.stringify(rec, null, 2));

    await expect(
      adoptCandidate(jobRoot, "creator-forged-matte", cand.contentHash, "forged", { libraryRoot }),
    ).rejects.toThrow(/chroma-key|alpha/i);
    expect((await scanLibrary(libraryRoot)).cutouts).toHaveLength(0);
  });

  test("never overwrites an existing asset of any kind", async () => {
    await writeLegacyJob(jobRoot, creatorJob("creator-overwrite"));
    const job = await loadJob(jobRoot, "creator-overwrite");
    const [a, b] = job.runs[0]!.candidates;
    await adoptCandidate(jobRoot, "creator-overwrite", a!.contentHash, "taken", { libraryRoot });
    await expect(
      adoptCandidate(jobRoot, "creator-overwrite", b!.contentHash, "taken", { libraryRoot }),
    ).rejects.toThrow(/already exists/i);
  });

  test("adoption never writes or edits a Scene", async () => {
    await writePlateAsset(libraryRoot, "plate-a", new TextEncoder().encode("PLATE"), {
      kind: "plate", id: "plate-a", name: "Plate A", tags: [],
    });
    await writeLegacyJob(jobRoot, creatorJob("creator-scene"));
    const job = await loadJob(jobRoot, "creator-scene");
    const scenePath = path.join(root, "scene.json");
    await writeFile(scenePath, JSON.stringify({ schemaVersion: 1, layers: [] }));
    await adoptCandidate(jobRoot, "creator-scene", job.runs[0]!.candidates[0]!.contentHash, "creator-trial", {
      libraryRoot,
    });
    // The scene file is byte-identical: adoption enters the library only.
    expect(await readFile(scenePath, "utf8")).toBe(
      JSON.stringify({ schemaVersion: 1, layers: [] }),
    );
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