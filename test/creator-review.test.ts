import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
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

/** sha-256 of every base64 image embedded in an HTML string. */
const embeddedHashes = (html: string): string[] =>
  [...html.matchAll(/data:[^;"]+;base64,([A-Za-z0-9+/=]+)/g)].map((m) =>
    sha256(Buffer.from(m[1]!, "base64")),
  );

let root: string;
let jobRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-creator-review-"));
  jobRoot = path.join(root, "jobs");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ALPHA_PNG = encodePng(16, 16, (x, y) =>
  x < 4 && y < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0],
);

/** What the model actually returned: opaque RGB. The matting pass isolated it. */
const OPAQUE_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [200, 30, 40, 255] : [20, 90, 200, 255]),
  { colorType: 2 },
);
const MASK_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]),
  { colorType: 2 },
);

/** The matte the local pass composed and the run recorded. */
const MATTED_PNG = composeMatte(OPAQUE_PNG, MASK_PNG, "fixture");

/** Anchor files the recorded request points at — review verifies their bytes. */
async function seedAnchors(names: string[]): Promise<void> {
  for (const name of names) {
    await writeFile(path.join(root, name), `anchor-bytes-${name}`);
  }
}

/** A creator record as a pre-retirement binary wrote it: opaque candidates + recorded mattes. */
const creatorJob = (
  jobId: string,
  anchors: string[],
  candidates: { bytes: Uint8Array; matteBytes?: Uint8Array }[],
  extra?: Partial<LegacyJobSpec>,
): LegacyJobSpec => ({
  jobId,
  kind: "creator",
  subject: "arms crossed, explaining to camera",
  refs: anchors.map((a) => ({
    role: "identity",
    path: path.join(root, a),
    bytes: Buffer.from(`anchor-bytes-${a}`),
  })),
  runs: [{
    model: "google/gemini-3.1-flash-image",
    fullPrompt: "CREATOR<arms crossed, explaining to camera>",
    candidates: candidates.map((c) => ({
      bytes: c.bytes,
      ...(c.matteBytes ? { matteBytes: c.matteBytes, matteEngine: "test/segmentation" } : {}),
    })),
  }],
  ...extra,
});

/** Distinct opaque candidates, matted — the default recorded shape. */
const mattedCandidates = (jobId: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    bytes: Buffer.concat([OPAQUE_PNG, Buffer.from(`-${jobId}-${i}`)]),
    matteBytes: MATTED_PNG,
  }));

describe("reviewJob", () => {
  test("writes a review sheet listing every distinct candidate across runs, against the identity anchors", async () => {
    await seedAnchors(["anchor-a.png", "anchor-b.png"]);
    // Two runs of the same job — the sheet must show candidates from every
    // run, with distinct bytes per run so the second run's hashes are genuine
    // second-run evidence.
    await writeLegacyJob(jobRoot, {
      ...creatorJob("creator-review", ["anchor-a.png", "anchor-b.png"], mattedCandidates("creator-review-r0", 2)),
      runs: [
        {
          model: "google/gemini-3.1-flash-image",
          candidates: mattedCandidates("creator-review-r0", 2),
        },
        {
          model: "google/gemini-3.1-flash-image",
          candidates: mattedCandidates("creator-review-r1", 2),
        },
      ],
    });

    const result = await reviewJob(jobRoot, "creator-review");
    expect(result.kind).toBe("creator");
    expect(result.reviewPath).toBe(path.join(jobRoot, "creator-review", "review.html"));

    const html = await readFile(result.reviewPath, "utf8");
    const record = await loadJob(jobRoot, "creator-review");
    const firstRunHashes = new Set(record.runs[0]!.candidates.map((c) => c.contentHash.slice(0, 12)));
    const secondRunHashes = record.runs[1]!.candidates.map((c) => c.contentHash.slice(0, 12));
    expect(secondRunHashes.some((h) => !firstRunHashes.has(h))).toBe(true);
    for (const hash of [...firstRunHashes, ...secondRunHashes]) {
      expect(html).toContain(hash);
    }
    // Anchors are referenced with their ids for the face-detail comparison —
    // their verified bytes are embedded, so no file path appears.
    expect(html).toContain("anchor · anchor-a");
    expect(html).toContain("anchor · anchor-b");
    // The face-detail section exists and the subject/model provenance is shown.
    expect(html).toMatch(/face detail/i);
    expect(html).toContain("arms crossed, explaining to camera");
    // Candidates from both runs are present (run 0 and run 1 captions).
    expect(result.candidates).toHaveLength(4);
    expect(result.candidates.some((c) => c.runIndex === 1)).toBe(true);
    expect(result.anchors.map((a) => a.id)).toEqual(["anchor-a", "anchor-b"]);
    // The thumbnail-size view: exactly one 168px figure per distinct candidate
    // (US-022/DEC-017) — detail that disappears at the row size is rejected here.
    expect(html).toMatch(/168px/);
    expect(html.match(/class="thumb"/g)).toHaveLength(4);
  });

  test("deduplicates a candidate hash recurring across runs to its first run", async () => {
    await seedAnchors(["anchor-a.png"]);
    const recurring = { bytes: OPAQUE_PNG, matteBytes: MATTED_PNG };
    await writeLegacyJob(jobRoot, {
      ...creatorJob("creator-dup", ["anchor-a.png"], [recurring]),
      runs: [
        { model: "google/gemini-3.1-flash-image", candidates: [recurring] },
        { model: "google/gemini-3.1-flash-image", candidates: [recurring] },
      ],
    });
    const result = await reviewJob(jobRoot, "creator-dup");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.runIndex).toBe(0);
    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toContain(`run ${result.candidates[0]!.runIndex}`);
  });

  test("shows the recorded matte as isolation evidence, per candidate, and names the engine", async () => {
    await seedAnchors(["anchor-a.png"]);
    await writeLegacyJob(jobRoot, creatorJob("creator-matte-view", ["anchor-a.png"], mattedCandidates("creator-matte-view", 1)));
    const job = await loadJob(jobRoot, "creator-matte-view");
    const cand = job.runs[0]!.candidates[0]!;
    const result = await reviewJob(jobRoot, "creator-matte-view");
    const isolation = result.candidates[0]!.isolation;
    if (isolation.from !== "matte") throw new Error("expected the recorded matte");
    expect(isolation.engine).toBe("test/segmentation");
    expect(isolation.file).toBe(cand.matte!.file);
    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toMatch(/isolation/i);
    // The displayed matte is the verified matte — its embedded bytes decode to
    // the recorded content identity, not a mutable file reference.
    expect(embeddedHashes(html)).toContain(cand.matte!.contentHash);
    expect(html).toContain("matte via test/segmentation");
  });

  test("says plainly when a candidate has no matte — it is evidence, not a promotion cue", async () => {
    await seedAnchors(["anchor-a.png"]);
    await writeLegacyJob(jobRoot, creatorJob("creator-no-matte", ["anchor-a.png"], [
      { bytes: Buffer.concat([OPAQUE_PNG, Buffer.from("-nomatte")]) },
    ]));
    const result = await reviewJob(jobRoot, "creator-no-matte");
    expect(result.candidates[0]!.isolation.from).toBe("none");
    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toContain("no matte recorded");
  });

  test("fails loudly when a matte file no longer matches its recorded identity", async () => {
    await seedAnchors(["anchor-a.png"]);
    await writeLegacyJob(jobRoot, creatorJob("creator-matte-tampered", ["anchor-a.png"], mattedCandidates("creator-matte-tampered", 1)));
    const cand = (await loadJob(jobRoot, "creator-matte-tampered")).runs[0]!.candidates[0]!;
    await writeFile(path.join(jobRoot, "creator-matte-tampered", cand.matte!.file), ALPHA_PNG);
    await expect(reviewJob(jobRoot, "creator-matte-tampered")).rejects.toThrow(
      /matte.*(changed|identity)/i,
    );
  });

  test("fails loudly when an identity anchor file is missing", async () => {
    await seedAnchors(["anchor-a.png", "gone.png"]);
    await writeLegacyJob(jobRoot, creatorJob("creator-missing", ["anchor-a.png", "gone.png"], mattedCandidates("creator-missing", 1)));
    await rm(path.join(root, "gone.png"));
    await expect(reviewJob(jobRoot, "creator-missing")).rejects.toThrow(/gone\.png/);
  });

  test("fails loudly when an identity anchor's bytes no longer match the recorded identity", async () => {
    await seedAnchors(["anchor-a.png"]);
    await writeLegacyJob(jobRoot, creatorJob("creator-drift", ["anchor-a.png"], mattedCandidates("creator-drift", 1)));
    await writeFile(path.join(root, "anchor-a.png"), "tampered-anchor-bytes");
    await expect(reviewJob(jobRoot, "creator-drift")).rejects.toThrow(
      /anchor-a\.png.*(changed|identity|drift)/i,
    );
  });

  test("fails loudly when a candidate file no longer matches its recorded identity", async () => {
    await seedAnchors(["anchor-a.png"]);
    await writeLegacyJob(jobRoot, creatorJob("creator-tampered", ["anchor-a.png"], mattedCandidates("creator-tampered", 1)));
    const job = await loadJob(jobRoot, "creator-tampered");
    const cand = job.runs[0]!.candidates[0]!;
    await writeFile(path.join(jobRoot, "creator-tampered", cand.file), "tampered-candidate-bytes");
    await expect(reviewJob(jobRoot, "creator-tampered")).rejects.toThrow(
      /candidate.*(changed|identity)/i,
    );
  });

  test("renders hostile subjects and quote-bearing anchor paths as inert escaped HTML", async () => {
    const evilSubject = `nice pose</p><script>alert(\"pwned\")</script><img src=x onerror=alert(1)>`;
    const evilName = `an\"chor<img>.png`;
    await seedAnchors([evilName]);
    await writeLegacyJob(jobRoot, {
      ...creatorJob("creator-hostile", [evilName], mattedCandidates("creator-hostile", 1)),
      subject: evilSubject,
    });
    const review = await reviewJob(jobRoot, "creator-hostile");
    const html = await readFile(review.reviewPath, "utf8");
    // No executable markup survives: the raw payload never appears verbatim.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror=alert(1)>");
    expect(html).toContain("&lt;script&gt;");
    // The subject renders as text, escaped.
    expect(html).toContain(escapeHtml(evilSubject));
    // A restrictive CSP ships with the sheet.
    expect(html).toContain("Content-Security-Policy");
  });

  test("the CLI review command prints structured JSON with the review path", async () => {
    await seedAnchors(["anchor-a.png"]);
    await writeLegacyJob(jobRoot, creatorJob("creator-cli", ["anchor-a.png"], mattedCandidates("creator-cli", 2)));
    const res = await cliRun(["review", "creator-cli"], { jobsRoot: jobRoot });
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(out.review).toBe(path.join(jobRoot, "creator-cli", "review.html"));
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates.every((c: { isolation: string }) => c.isolation === "matte")).toBe(true);
    const job = await loadJob(jobRoot, "creator-cli");
    expect(job.runs[0]!.candidates).toHaveLength(2);
  });
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}