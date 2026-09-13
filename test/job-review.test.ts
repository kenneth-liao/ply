import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadJob } from "../src/jobs.js";
import { reviewJob } from "../src/review.js";
import { run as cliRun } from "../src/job-cli.js";
import { composeMatte } from "../src/matte.js";
import { encodePng } from "./png.js";
import { writeLegacyJob, type LegacyJobSpec } from "./legacy-jobs.js";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let root: string;
let jobRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-job-review-"));
  jobRoot = path.join(root, "jobs");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** True-alpha PNG: a 4×4 opaque red subject in a 16×16 transparent frame. */
const ALPHA_PNG = encodePng(16, 16, (x, y) =>
  x < 4 && y < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0],
);

/** The measured reality: an opaque candidate whose backdrop is painted pixels. */
const OPAQUE_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [230, 120, 80, 255] : [20, 90, 200, 255]),
  { colorType: 2 },
);

/** The segmentation mask the matting engine predicted for it. */
const MASK_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]),
  { colorType: 2 },
);

/** The matte the local pass composed — the recorded isolation evidence. */
const MATTED_PNG = composeMatte(OPAQUE_PNG, MASK_PNG, "fixture");

/** A plate record with distinct candidates, as a pre-retirement run wrote it. */
const plateJob = (jobId: string, count = 2): LegacyJobSpec => ({
  jobId,
  kind: "plate",
  subject: "neon server room",
  runs: [{
    candidates: Array.from({ length: count }, (_, i) => ({
      bytes: Buffer.concat([OPAQUE_PNG, Buffer.from(`-${jobId}-${i}`)]),
    })),
  }],
});

/** An object record with its recorded matte. */
const mattedObjectJob = (jobId: string): LegacyJobSpec => ({
  jobId,
  kind: "object",
  subject: "a retro desk lamp",
  runs: [{
    candidates: [{
      bytes: OPAQUE_PNG,
      matteBytes: MATTED_PNG,
      matteEngine: "test/segmentation",
    }],
  }],
});

/** An object record whose run recorded no matte (the pass failed). */
const noMatteObjectJob = (jobId: string): LegacyJobSpec => ({
  jobId,
  kind: "object",
  subject: "a retro desk lamp",
  runs: [{
    candidates: [{ bytes: OPAQUE_PNG }],
    warnings: ["matte: candidate could not be isolated — mask model returned no image"],
  }],
});

/** sha-256 of every base64 image embedded in an HTML string. */
const embeddedHashes = (html: string): string[] =>
  [...html.matchAll(/data:[^;"]+;base64,([A-Za-z0-9+/=]+)/g)].map((m) =>
    sha256(Buffer.from(m[1]!, "base64")),
  );

describe("reviewJob — plate", () => {
  test("shows every distinct candidate at full size and 168px, with nothing creator-specific", async () => {
    await writeLegacyJob(jobRoot, plateJob("plate-rev"));
    const result = await reviewJob(jobRoot, "plate-rev");

    expect(result.kind).toBe("plate");
    expect(result.candidates).toHaveLength(2);
    expect(result.anchors).toEqual([]);

    const html = await readFile(result.reviewPath, "utf8");
    for (const cand of result.candidates) expect(html).toContain(cand.contentHash.slice(0, 12));
    // Full size: one natural-width figure per candidate in a scrollable
    // container — true 1:1, never downscaled to fit.
    expect(html.match(/class="fullwrap"/g)).toHaveLength(2);
    // Thumbnail size: exactly one 168px figure per distinct candidate.
    expect(html.match(/class="thumb"/g)).toHaveLength(2);
    expect(html).toContain("168px");
    // The displayed bytes are the verified bytes: every embedded image decodes
    // to a recorded candidate identity.
    const embedded = embeddedHashes(html);
    for (const cand of result.candidates) expect(embedded).toContain(cand.contentHash);
    // Nothing creator-specific: plates have no anchors, mattes, or face views.
    expect(html).not.toMatch(/face detail/i);
    expect(html).not.toMatch(/isolation/i);
  });

  test("the artifact stays static and offline: embedded evidence only, and no Scene, Asset, or job record is touched", async () => {
    await writeLegacyJob(jobRoot, plateJob("plate-static"));
    const recordBefore = await readFile(path.join(jobRoot, "plate-static", "job.json"));

    const result = await reviewJob(jobRoot, "plate-static");
    const html = await readFile(result.reviewPath, "utf8");
    // The CSP allows embedded evidence only — no file:, no remote.
    expect(html).toContain("img-src data:");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("file:");
    expect(html).not.toContain("<script");
    // Review writes one file — the sheet beside the record — and nothing else.
    expect(await readFile(path.join(jobRoot, "plate-static", "job.json"))).toEqual(recordBefore);
  });

  test("the saved sheet is self-contained: later mutation or deletion of source files cannot alter or break it", async () => {
    await writeLegacyJob(jobRoot, plateJob("plate-frozen", 1));
    const result = await reviewJob(jobRoot, "plate-frozen");
    const sheetBefore = await readFile(result.reviewPath);

    const cand = result.candidates[0]!;
    await rm(path.join(jobRoot, "plate-frozen", cand.file));

    const sheetAfter = await readFile(result.reviewPath);
    expect(Buffer.compare(sheetBefore, sheetAfter)).toBe(0);
    // The evidence it displays is still the verified bytes, decodable from the
    // sheet alone.
    expect(embeddedHashes(sheetAfter.toString("utf8"))).toContain(cand.contentHash);
  });

  test("a failed later review produces no new output — the prior sheet stands as its point-in-time evidence", async () => {
    await writeLegacyJob(jobRoot, plateJob("plate-stale", 1));
    const result = await reviewJob(jobRoot, "plate-stale");
    const sheetBefore = await readFile(result.reviewPath);
    // The sheet stamps when its evidence was verified.
    expect(sheetBefore.toString("utf8")).toMatch(/reviewed \d{4}-\d{2}-\d{2}/);

    const cand = result.candidates[0]!;
    await writeFile(path.join(jobRoot, "plate-stale", cand.file), "tampered-after-review");
    await expect(reviewJob(jobRoot, "plate-stale")).rejects.toThrow(/identity|matches/i);
    // Nothing new was written; the earlier verified sheet is left untouched.
    expect(Buffer.compare(sheetBefore, await readFile(result.reviewPath))).toBe(0);
  });

  test("a failed sheet replacement leaves the prior sheet intact and no temp files behind", async () => {
    await writeLegacyJob(jobRoot, plateJob("plate-atomic", 1));
    const first = await reviewJob(jobRoot, "plate-atomic");
    const sheetBefore = await readFile(first.reviewPath);

    // The fault-injection seam (the reference-import writeScene precedent):
    // production always performs the real atomic replace; a rejecting seam is
    // the deterministic way to prove the failure branch.
    await expect(
      reviewJob(jobRoot, "plate-atomic", {
        replaceArtifact: () => Promise.reject(new Error("injected replacement failure")),
      }),
    ).rejects.toThrow(/injected replacement failure/);
    // The prior sheet is byte-identical — never truncated or partially replaced.
    expect(Buffer.compare(sheetBefore, await readFile(first.reviewPath))).toBe(0);
    // The replacement left no temp files in the job directory.
    const entries = await readdir(path.join(jobRoot, "plate-atomic"));
    expect(entries.some((e) => e.includes(".tmp-"))).toBe(false);
    expect(entries).toContain("review.html");
  });

  test("fails loudly on a tampered candidate and writes no partial review", async () => {
    await writeLegacyJob(jobRoot, plateJob("plate-tampered", 1));
    const job = await loadJob(jobRoot, "plate-tampered");
    const cand = job.runs[0]!.candidates[0]!;
    await writeFile(path.join(jobRoot, "plate-tampered", cand.file), "tampered-candidate-bytes");

    await expect(reviewJob(jobRoot, "plate-tampered")).rejects.toThrow(
      /candidate.*(identity|matches)/i,
    );
    expect(existsSync(path.join(jobRoot, "plate-tampered", "review.html"))).toBe(false);
  });

  test("fails loudly on a missing candidate file", async () => {
    await writeLegacyJob(jobRoot, plateJob("plate-missing", 1));
    const job = await loadJob(jobRoot, "plate-missing");
    await rm(path.join(jobRoot, "plate-missing", job.runs[0]!.candidates[0]!.file));

    await expect(reviewJob(jobRoot, "plate-missing")).rejects.toThrow(/missing/i);
    expect(existsSync(path.join(jobRoot, "plate-missing", "review.html"))).toBe(false);
  });
});

describe("reviewJob — object", () => {
  test("shows the recorded matte as isolation evidence, per candidate, and names the engine", async () => {
    await writeLegacyJob(jobRoot, mattedObjectJob("obj-matted"));
    const job = await loadJob(jobRoot, "obj-matted");
    const cand = job.runs[0]!.candidates[0]!;

    const result = await reviewJob(jobRoot, "obj-matted");
    expect(result.kind).toBe("object");
    const isolation = result.candidates[0]!.isolation;
    if (isolation.from !== "matte") throw new Error("expected the recorded matte");
    expect(isolation.file).toBe(cand.matte!.file);
    expect(isolation.engine).toBe("test/segmentation");

    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toMatch(/isolation/i);
    // The displayed matte is the verified matte: its embedded bytes decode to
    // the recorded content identity — not merely some file reference.
    expect(embeddedHashes(html)).toContain(cand.matte!.contentHash);
    expect(html).toContain("matte via test/segmentation");
    // Candidates appear in both evidence sizes as well.
    expect(html.match(/class="thumb"/g)).toHaveLength(1);
  });

  test("clearly marks an object candidate without a recorded matte", async () => {
    await writeLegacyJob(jobRoot, noMatteObjectJob("obj-opaque-rev"));
    const result = await reviewJob(jobRoot, "obj-opaque-rev");
    const isolation = result.candidates[0]!.isolation;
    expect(isolation.from).toBe("none");
    if (isolation.from !== "none") throw new Error("unreachable");
    expect(isolation.cause).toBe("no-matte");

    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toContain("no matte recorded");
  });

  test("labels a matching-hash recorded matte that fails the true-alpha gate as invalid — with its refusal reason — never as missing", async () => {
    await writeLegacyJob(jobRoot, mattedObjectJob("obj-invalid-matte"));
    const cand = (await loadJob(jobRoot, "obj-invalid-matte")).runs[0]!.candidates[0]!;
    // Point the recorded matte at the candidate's own opaque bytes: the hash
    // matches the record, so this is not tampering — the matte is present but
    // invalid, and the sheet must say precisely that.
    const file = path.join(jobRoot, "obj-invalid-matte", "job.json");
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.runs[0].candidates[0].matte = { file: cand.file, contentHash: cand.contentHash, engine: "forged" };
    await writeFile(file, JSON.stringify(rec, null, 2));

    const result = await reviewJob(jobRoot, "obj-invalid-matte");
    const isolation = result.candidates[0]!.isolation;
    expect(isolation.from).toBe("none");
    if (isolation.from !== "none") throw new Error("unreachable");
    expect(isolation.cause).toBe("invalid-matte");
    expect(isolation.reason).toMatch(/cannot qualify/);

    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toContain("invalid matte — refused by the true-alpha gate");
    expect(html).not.toContain("no matte recorded");
    expect(html).toContain("cannot qualify");
    // The refusal's guidance points at the replacement workflow, never the
    // retired adoption path.
    expect(html).toMatch(/ply matte/);
    expect(html).not.toMatch(/jobs adopt|library adopt/);
  });

  test("a hostile matte path inside the invalid-matte refusal renders as inert escaped HTML", async () => {
    await writeLegacyJob(jobRoot, mattedObjectJob("obj-hostile-matte"));
    const cand = (await loadJob(jobRoot, "obj-hostile-matte")).runs[0]!.candidates[0]!;
    const evil = `mattes/evil"\u003cimg src=x onerror=alert(1)\u003e.png`;
    await writeFile(path.join(jobRoot, "obj-hostile-matte", evil), OPAQUE_PNG);
    const file = path.join(jobRoot, "obj-hostile-matte", "job.json");
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.runs[0].candidates[0].matte = { file: evil, contentHash: sha256(OPAQUE_PNG), engine: "forged" };
    await writeFile(file, JSON.stringify(rec, null, 2));

    const result = await reviewJob(jobRoot, "obj-hostile-matte");
    const isolation = result.candidates[0]!.isolation;
    expect(isolation.from).toBe("none");
    if (isolation.from !== "none") throw new Error("unreachable");
    expect(isolation.cause).toBe("invalid-matte");

    const html = await readFile(result.reviewPath, "utf8");
    // The refusal reason (which names the hostile path) is text, not markup:
    // nothing executable survives, and the escaped form is what renders.
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("invalid matte — refused by the true-alpha gate");
  });

  test("marks a natively isolated object candidate — its own bytes are the evidence", async () => {
    // The defensive native route through a hand-built record: one object
    // candidate, no recorded matte, true-alpha bytes on disk. Review resolves
    // it through the same canonical reader as every other candidate.
    const bytes = ALPHA_PNG;
    const hash = sha256(bytes);
    const file = path.join("candidates", `${hash}.png`);
    const dir = path.join(jobRoot, "obj-native-rev");
    await mkdir(path.join(dir, "candidates"), { recursive: true });
    await writeFile(path.join(dir, file), bytes);
    const record = {
      schemaVersion: 4,
      jobId: "obj-native-rev",
      kind: "object",
      createdAt: "2026-09-02T00:00:00.000Z",
      request: { kind: "object", subject: "a retro desk lamp", model: "gpt-image", count: 1, refs: [] },
      runs: [
        {
          ranAt: "2026-09-02T00:00:00.000Z",
          model: "openai/gpt-image-2",
          fullPrompt: "p",
          costUsd: null,
          costMeasured: false,
          warnings: [],
          candidates: [{ contentHash: hash, file, mediaType: "image/png" }],
        },
      ],
    };
    await writeFile(path.join(dir, "job.json"), JSON.stringify(record, null, 2) + "\n");

    const result = await reviewJob(jobRoot, "obj-native-rev");
    const isolation = result.candidates[0]!.isolation;
    if (isolation.from !== "candidate") throw new Error("expected the native-alpha route");
    expect(isolation.file).toBe(file);

    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toContain("natively isolated — the candidate's own true-alpha bytes");
    // The displayed bytes are the candidate's own verified bytes.
    expect(embeddedHashes(html)).toContain(hash);
  });

  test("fails loudly when a recorded matte file no longer matches its identity", async () => {
    await writeLegacyJob(jobRoot, mattedObjectJob("obj-matte-tampered"));
    const cand = (await loadJob(jobRoot, "obj-matte-tampered")).runs[0]!.candidates[0]!;
    await writeFile(path.join(jobRoot, "obj-matte-tampered", cand.matte!.file), ALPHA_PNG);

    await expect(reviewJob(jobRoot, "obj-matte-tampered")).rejects.toThrow(
      /matte.*(identity|matches)/i,
    );
    expect(existsSync(path.join(jobRoot, "obj-matte-tampered", "review.html"))).toBe(false);
  });
});

describe("jobs review — CLI", () => {
  test("reviews a plate job: kind, review path, and isolation evidence per candidate", async () => {
    await writeLegacyJob(jobRoot, plateJob("plate-cli", 1));
    const res = await cliRun(["review", "plate-cli"], { jobsRoot: jobRoot });
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("plate");
    expect(out.review).toBe(path.join(jobRoot, "plate-cli", "review.html"));
    // A plate's own verified bytes are its evidence; there is no adoptable
    // cue — adoption is retired (#115).
    expect(out.candidates[0]!.isolation).toBe("candidate");
    expect(out.anchors).toEqual([]);
  });

  test("reports an object candidate without a recorded matte as having none", async () => {
    await writeLegacyJob(jobRoot, noMatteObjectJob("obj-cli-opaque"));
    const res = await cliRun(["review", "obj-cli-opaque"], { jobsRoot: jobRoot });
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(out.kind).toBe("object");
    expect(out.candidates[0]!.isolation).toBe("none");
  });
});