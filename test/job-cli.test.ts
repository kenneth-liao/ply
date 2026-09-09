import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run as cliRun } from "../src/job-cli.js";
import { writeLegacyJob, type LegacyJobSpec } from "./legacy-jobs.js";

let root: string;
let jobsRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-job-cli-"));
  jobsRoot = path.join(root, "jobs");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Invoke the CLI with the test jobs root. Adoption is retired — no library dep. */
function run(args: string[]) {
  return cliRun(args, { jobsRoot });
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
    for (const expected of ["show", "list", "review", "bun run generate", "bun run matte", "retired"])
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

describe("retired adoption entry points (#115)", () => {
  test("jobs adopt is a usage error directing to the replacement workflow — no library publication", async () => {
    await writeLegacyJob(jobsRoot, {
      jobId: "adopt-job",
      kind: "plate",
      subject: "neon server room",
      runs: [{ candidates: [{ bytes: Buffer.from("candidate-bytes") }] }],
    });

    const res = await run(["adopt", "adopt-job", "0123456789abcdef", "--id", "neon-room"]);
    expect(res.exitCode).toBe(2);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(false);
    const message = out.errors[0].message as string;
    expect(message).toMatch(/retired/);
    // Accurate replacement guidance: uniform generation, explicit matting,
    // ordinary Project Layer ingestion — not the retired adoption path.
    expect(message).toMatch(/bun run generate/);
    expect(message).toMatch(/bun run matte/);
    expect(message).toMatch(/--from-generation|--from-matte/);
    // The retained commands are named; the retired command is not offered.
    expect(message).toMatch(/show, list, or review/);
  });

  test("an unknown command is a usage error naming only the retained read-only commands", async () => {
    const res = await run(["adopt-all"]);
    expect(res.exitCode).toBe(2);
    const message = ((res.output as Record<string, any>).errors[0].message as string);
    expect(message).toMatch(/unknown command "adopt-all"/);
    expect(message).toMatch(/show, list, or review/);
  });
});
