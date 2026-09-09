import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanLibrary } from "../src/assets.js";
import { run as cliRun } from "../src/job-cli.js";
import { writeLegacyJob, type LegacyJobSpec } from "./legacy-jobs.js";
import { encodePng } from "./png.js";

let root: string;
let jobsRoot: string;
let libraryRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-job-cli-"));
  jobsRoot = path.join(root, "jobs");
  libraryRoot = path.join(root, "library");
  await mkdir(libraryRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Invoke the CLI with test roots. No generation deps exist any more. */
function run(args: string[]) {
  return cliRun(args, { jobsRoot, libraryRoot });
}

describe("retired generation entry points (#114)", () => {
  test("plates, objects, and creators are usage errors that direct to the replacement workflow", async () => {
    for (const cmd of ["plates", "objects", "creators"]) {
      const res = await run([cmd, "a subject"]);
      expect(res.exitCode).toBe(2);
      const out = res.output as Record<string, any>;
      expect(out.ok).toBe(false);
      const message = out.errors[0].message as string;
      expect(message).toMatch(/retired/);
      // Help and diagnostics direct callers to the new workflow, with no
      // hidden path back into the superseded lifecycle.
      expect(message).toMatch(/bun run generate/);
      expect(message).toMatch(/bun run matte/);
    }
  });

  test("kind-dispatched rerun is retired — a usage error, never generation", async () => {
    await writeLegacyJob(jobsRoot, {
      jobId: "lineage-job",
      kind: "plate",
      runs: [{ candidates: [{ bytes: Buffer.from("candidate-bytes") }] }],
    });
    const res = await run(["rerun", "lineage-job"]);
    expect(res.exitCode).toBe(2);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(false);
    const message = out.errors[0].message as string;
    expect(message).toMatch(/retired/);
    expect(message).toMatch(/bun run generate/);
    // The refusal must not have touched the record — the lineage stands.
    const shown = (await run(["show", "lineage-job"])) as Record<string, any>;
    expect((shown.output as Record<string, any>).job.runs).toHaveLength(1);
  });

  test("help documents the retained commands and the replacement workflow", async () => {
    const res = await run([]);
    expect(res.exitCode).toBe(2);
    const message = ((res.output as Record<string, any>).errors[0].message as string);
    for (const expected of ["show", "list", "review", "adopt", "bun run generate", "bun run matte", "retired"])
      expect(message).toContain(expected);
  });

  test("an unknown command is a usage error naming only the retained commands", async () => {
    const res = await run(["adopt-all"]);
    expect(res.exitCode).toBe(2);
    const message = ((res.output as Record<string, any>).errors[0].message as string);
    expect(message).toMatch(/unknown command "adopt-all"/);
    expect(message).not.toMatch(/plates, objects, creators/);
  });
});

describe("jobs show and list", () => {
  test("show returns the full record; list summarizes", async () => {
    await writeLegacyJob(jobsRoot, {
      jobId: "job-a",
      kind: "plate",
      subject: "subject one",
      runs: [{ candidates: [{ bytes: Buffer.from("a") }] }],
    });
    await writeLegacyJob(jobsRoot, {
      jobId: "job-b",
      kind: "object",
      subject: "subject two",
      runs: [{ candidates: [{ bytes: Buffer.from("b") }] }],
    });

    const show = await run(["show", "job-a"]);
    expect(show.exitCode).toBe(0);
    const shown = show.output as Record<string, any>;
    expect(shown.ok).toBe(true);
    expect(shown.job.jobId).toBe("job-a");
    expect(shown.job.request.subject).toBe("subject one");

    const list = await run(["list"]);
    const out = list.output as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(out.jobs).toHaveLength(2);
    expect(out.jobs.map((j: any) => j.jobId).sort()).toEqual(["job-a", "job-b"]);
  });

  test("show of an unknown job is a structured failure, exit code 1", async () => {
    const res = await run(["show", "missing-job"]);
    expect(res.exitCode).toBe(1);
    expect((res.output as Record<string, any>).ok).toBe(false);
  });

  test("extra positionals are usage errors, not silently ignored", async () => {
    expect((await run(["show", "job-a", "extra"])).exitCode).toBe(2);
    expect((await run(["list", "extra"])).exitCode).toBe(2);
    expect((await run(["review", "job-a", "extra"])).exitCode).toBe(2);
  });
});

describe("jobs adopt", () => {
  test("adopts a candidate into the library as an immutable Plate Asset", async () => {
    await writeLegacyJob(jobsRoot, {
      jobId: "adopt-job",
      kind: "plate",
      subject: "neon server room",
      runs: [{
        candidates: [
          { bytes: Buffer.from("candidate-one") },
          { bytes: Buffer.from("candidate-two") },
        ],
      }],
    });
    const shown = ((await run(["show", "adopt-job"])).output as Record<string, any>).job;
    const hash: string = shown.runs[0].candidates[0].contentHash;

    const res = await run(["adopt", "adopt-job", hash.slice(0, 12), "--id", "neon-room", "--tags", "neon,tech"]);
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(out.assetId).toBe("neon-room");
    expect(out.contentHash).toBe(hash);

    const lib = await scanLibrary(libraryRoot);
    const plate = lib.plates.find((p) => p.meta.id === "neon-room")!;
    expect(plate.hash).toBe(hash);
    expect(plate.meta.subject).toBe("neon server room");
    expect(plate.meta.adoptedFrom).toBe(`job:adopt-job#${hash}`);
  });

  test("refuses to overwrite an adopted asset — structured failure, exit 1", async () => {
    await writeLegacyJob(jobsRoot, {
      jobId: "dup-job",
      kind: "plate",
      runs: [{
        candidates: [
          { bytes: Buffer.from("first-candidate") },
          { bytes: Buffer.from("second-candidate") },
        ],
      }],
    });
    const shown = ((await run(["show", "dup-job"])).output as Record<string, any>).job;
    const [a, b] = shown.runs[0].candidates;

    expect((await run(["adopt", "dup-job", a.contentHash, "--id", "taken"])).exitCode).toBe(0);
    const res = await run(["adopt", "dup-job", b.contentHash, "--id", "taken"]);
    expect(res.exitCode).toBe(1);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(false);
    expect(out.errors[0].message).toMatch(/already exists/);

    const lib = await scanLibrary(libraryRoot);
    expect(lib.plates.find((p) => p.meta.id === "taken")!.hash).toBe(a.contentHash);
  });

  test("adopt without --id is a usage error", async () => {
    await writeLegacyJob(jobsRoot, {
      jobId: "need-id",
      kind: "plate",
      runs: [{ candidates: [{ bytes: Buffer.from("bytes") }] }],
    });
    const res = await run(["adopt", "need-id", "0123456789abcdef"]);
    expect(res.exitCode).toBe(2);
  });
});

/** True-alpha PNG: a 4×4 opaque red subject in a 16×16 transparent frame. */
const ALPHA_PNG = encodePng(16, 16, (x, y) =>
  x < 4 && y < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0],
);

describe("jobs adopt — object alpha gate through the CLI", () => {
  test("an object candidate with a recorded matte adopts that matte", async () => {
    // The measured reality the run recorded before retirement: the model
    // returned opaque pixels and the matting pass produced the adoptable
    // matte. Adoption writes the matte — the asset's hash is the matte's.
    const candidate = Buffer.concat([ALPHA_PNG, Buffer.from("-opaque-candidate")]);
    const matte = Buffer.concat([ALPHA_PNG, Buffer.from("-recorded-matte")]);
    await writeLegacyJob(jobsRoot, {
      jobId: "obj-matte-adopt",
      kind: "object",
      runs: [{
        candidates: [{ bytes: candidate, matteBytes: matte, matteEngine: "test/segmentation" }],
      }],
    });
    const shown = ((await run(["show", "obj-matte-adopt"])).output as Record<string, any>).job;
    const cand = shown.runs[0].candidates[0];

    const res = await run(["adopt", "obj-matte-adopt", cand.contentHash.slice(0, 12), "--id", "hook-tile"]);
    expect(res.exitCode).toBe(0);
    const lib = await scanLibrary(libraryRoot);
    const asset = lib.objects.find((o) => o.meta.id === "hook-tile")!;
    expect(asset.hash).toBe(cand.matte.contentHash);
    expect(asset.meta.matting).toBe("true-alpha");
    expect(asset.meta.matteEngine).toBe("test/segmentation");
  });
});