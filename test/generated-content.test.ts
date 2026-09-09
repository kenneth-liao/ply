/**
 * Generated-content ingestion into Project Layers (#107, spec #102 US-003/US-005).
 *
 * Verifies through the public CLI:
 * - `composition add --from-generation <jobId>` adds the selected generated
 *   output as an ordinary image Layer through the canonical Layer publication
 *   protocol — no category/approval fields, no generated-Layer identity, no
 *   implicit library publication.
 * - `layer edit <id> --from-generation <jobId>` explicitly replaces an image
 *   Layer's content through the existing editing contract (in-place blast-radius
 *   guard and fork intent preserved), without generating again.
 * - The Generation Job record is retained verbatim under the Project's
 *   `generation/` directory — the one retained representation of
 *   request/output/Reference provenance — and pixels are retained in the
 *   content store. Resolution works offline after the external generation
 *   files are removed and the Project is relocated.
 * - Retained provenance is immutable across subsequent replacements; earlier
 *   revisions keep resolving to their retained provenance.
 * - Missing, corrupt, or mismatched source/provenance is refused with no live
 *   incomplete reference; injected publication failures leave live state
 *   unchanged (retained blobs/records may remain as documented orphans) and a
 *   retry succeeds.
 * - Compact text, --json, help, usage errors (exit 2) and runtime failures
 *   (exit 1) follow the CLI contract; nothing here generates or touches the
 *   network.
 *
 * Deterministic Generation Jobs are created through the uniform generation
 * domain with a recording fake provider (never billed); the subprocess CLI
 * resolves them through the default `<cwd>/out/generation` root.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, readdir, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePngRgba, decodePng } from "../src/png.js";
import { initProject } from "../src/project.js";
import { runUniformGeneration, loadGenerationJob, type GenerationJobRecord } from "../src/generation.js";
import { resolveRetainedProvenance } from "../src/generation-retention.js";
import { DEFAULT_MODEL } from "../src/models.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

let root: string;
let projDir: string;
let jobsRoot: string;
let jobSeq = 0;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-generated-content-"));
  projDir = path.join(root, "proj");
  await initProject(projDir, { name: "gen-project" });
  jobsRoot = path.join(root, "out", "generation");
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function invoke(args: string[], cwd = root): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const result = Bun.spawn([process.execPath, cli, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
    result.exited,
  ]);
  return { stdout, stderr, code };
}

function solidPng(rgba: [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgba[0]!;
    buf[i + 1] = rgba[1]!;
    buf[i + 2] = rgba[2]!;
    buf[i + 3] = rgba[3]!;
  }
  return encodePngRgba(32, 32, buf);
}

const RED: [number, number, number, number] = [220, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 230, 255];
const GREEN: [number, number, number, number] = [0, 190, 0, 255];

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

const closeTo = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

/** Create a deterministic Generation Job whose outputs are the given PNGs, in order. */
async function createJob(colors: [number, number, number, number][]): Promise<GenerationJobRecord> {
  const pngs = colors.map(solidPng);
  let i = 0;
  const jobId = `gen-test-${String(++jobSeq).padStart(3, "0")}`;
  const job = await runUniformGeneration(
    jobsRoot,
    jobId,
    {
      prompt: "deterministic test content",
      intent: "full-canvas",
      model: DEFAULT_MODEL,
      sizing: { kind: "size", width: 32, height: 32 },
      count: colors.length,
    },
    {
      provider: {
        image: async () => ({ images: [{ base64: pngs[i++ % pngs.length]!.toString("base64") }], warnings: [] }),
        text: async () => {
          throw new Error("TRIPWIRE: ingestion must never generate");
        },
      },
    },
  );
  return job;
}

async function snapshotDir(dir: string): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  async function walk(current: string, prefix: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const full = path.join(current, entry);
      const key = prefix ? `${prefix}/${entry}` : entry;
      const stat = await (await import("node:fs/promises")).lstat(full);
      if (stat.isDirectory()) {
        Object.assign(out, await snapshotDir(full));
      } else if (stat.isFile()) {
        out[key] = await readFile(full);
      }
    }
  }
  await walk(dir, "");
  return out;
}

/** Create a Composition in the Project through the public CLI. */
async function makeComp(name: string, width = 64, height = 64) {
  const res = await invoke(["composition", "create", name, "--width", String(width), "--height", String(height), "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
}

test("adds a generated output as an ordinary image Layer with verbatim retained provenance", async () => {
  const job = await createJob([RED]);
  const output = job.run.outputs[0]!;
  await makeComp("thumb");

  const res = await invoke([
    "composition", "add", "thumb", "hero", "--from-generation", job.jobId,
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(true);
  expect(json.generatedFrom).toEqual({ jobId: job.jobId, contentHash: output.contentHash });
  expect(json.layer.currentRevision.kind).toBe("image");
  expect(json.layer.currentRevision.contentHash).toBe(output.contentHash);

  // The generated bytes are retained in the content store, byte-identical.
  const blob = await readFile(path.join(projDir, "content", output.contentHash));
  expect(blob.equals(solidPng(RED))).toBe(true);

  // The record is retained verbatim under the Project — one canonical
  // retained representation of the request/output/Reference provenance.
  const retained = path.join(projDir, "generation", job.jobId, "job.json");
  expect(existsSync(retained)).toBe(true);
  expect(await readFile(retained)).toEqual(await readFile(path.join(jobsRoot, job.jobId, "job.json")));

  // No new identity/category/approval fields on the stored documents: the
  // revision is an ordinary image revision.
  const revisionRaw = JSON.parse(
    await readFile(path.join(projDir, "layers", `${json.use.layerId}.revisions`, `${json.layer.currentRevisionId}.json`), "utf8"),
  );
  expect(Object.keys(revisionRaw).sort()).toEqual(
    ["contentHash", "createdAt", "kind", "layerId", "opacity", "schemaVersion", "x", "y"].sort(),
  );
  expect(revisionRaw.kind).toBe("image");

  // The Layer renders the generated pixels.
  const render = await invoke([
    "composition", "render", "thumb", "--out", path.join(projDir, "renders", "check.png"),
    "--project", projDir, "--json",
  ]);
  expect(render.code).toBe(0);
  const png = decodePng(await readFile(path.join(projDir, "renders", "check.png")));
  expect([png.width, png.height]).toEqual([64, 64]);
  const [r, g, b] = pixel(png, 5, 5);
  expect(closeTo(r, 220) && closeTo(g, 0) && closeTo(b, 0)).toBe(true);
});

test("compact text names the Generation Job and help documents the options", async () => {
  const job = await createJob([RED]);
  await makeComp("thumb");
  const text = await invoke(["composition", "add", "thumb", "hero", "--from-generation", job.jobId, "--project", projDir]);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain(job.jobId);
  expect(text.stdout).toContain("Generation Job");

  const compHelp = await invoke(["composition", "--help"]);
  expect(compHelp.stdout).toContain("--from-generation");
  const layerHelp = await invoke(["layer", "--help"]);
  expect(layerHelp.stdout).toContain("--from-generation");
});

test("usage errors for malformed option combinations exit 2", async () => {
  const job = await createJob([RED]);
  await makeComp("thumb");
  const image = path.join(root, "plain.png");
  await writeFile(image, solidPng(BLUE));

  // Structured-JSON usage errors: every case runs with --json, so the error
  // is a strict JSON object on stdout and stderr stays empty.
  const cases: [string[], string][] = [
    [["composition", "add", "thumb", "hero", "--from-generation", "--project", projDir, "--json"], "--from-generation"],
    [["composition", "add", "thumb", "hero", "--image", image, "--from-generation", job.jobId, "--project", projDir, "--json"], "mutually exclusive"],
    [["composition", "add", "thumb", "hero", "--text", "hi", "--font", "Anton", "--from-generation", job.jobId, "--project", projDir, "--json"], "mutually exclusive"],
    [["composition", "add", "thumb", "hero", "--output", "1", "--project", projDir, "--json"], "--output"],
    [["composition", "add", "thumb", "hero", "--from-generation", job.jobId, "--output", "zz", "--project", projDir, "--json"], "--output"],
    [["composition", "add", "thumb", "hero", "--from-generation", job.jobId, "--output", "0", "--project", projDir, "--json"], "--output"],
  ];
  for (const [args, needle] of cases) {
    const res = await invoke(args);
    expect(res.code).toBe(2);
    expect(res.stderr).toBe("");
    const json = JSON.parse(res.stdout);
    expect(json.ok).toBe(false);
    expect(json.error).toContain(needle);
  }
});

test("multi-output jobs require an explicit selection and resolve it exactly", async () => {
  const job = await createJob([RED, BLUE]);
  await makeComp("thumb");
  const [hashA, hashB] = job.run.outputs.map((o) => o.contentHash);

  // No --output with more than one output: refused with the choices listed.
  const ambiguous = await invoke(["composition", "add", "thumb", "hero", "--from-generation", job.jobId, "--project", projDir, "--json"]);
  expect(ambiguous.code).toBe(1);
  expect(JSON.parse(ambiguous.stdout).error).toContain("--output");
  expect(JSON.parse(ambiguous.stdout).error).toContain(hashA.slice(0, 12));
  expect(JSON.parse(ambiguous.stdout).error).toContain(hashB.slice(0, 12));

  // Selection by 1-based index and by full sha-256 both resolve exactly.
  const byIndex = await invoke([
    "composition", "add", "thumb", "second", "--from-generation", job.jobId, "--output", "2",
    "--project", projDir, "--json",
  ]);
  expect(byIndex.code).toBe(0);
  expect(JSON.parse(byIndex.stdout).layer.currentRevision.contentHash).toBe(hashB);

  const byHash = await invoke([
    "composition", "add", "thumb", "third", "--from-generation", job.jobId, "--output", hashA,
    "--project", projDir, "--json",
  ]);
  expect(byHash.code).toBe(0);
  expect(JSON.parse(byHash.stdout).layer.currentRevision.contentHash).toBe(hashA);

  // Unresolvable selections exit 1 without live mutation.
  const compBefore = await readFile(path.join(projDir, "compositions", "thumb.json"));
  const outOfRange = await invoke([
    "composition", "add", "thumb", "fourth", "--from-generation", job.jobId, "--output", "5",
    "--project", projDir, "--json",
  ]);
  expect(outOfRange.code).toBe(1);
  const unknownHash = await invoke([
    "composition", "add", "thumb", "fourth", "--from-generation", job.jobId, "--output", "a".repeat(64),
    "--project", projDir, "--json",
  ]);
  expect(unknownHash.code).toBe(1);
  expect(await readFile(path.join(projDir, "compositions", "thumb.json"))).toEqual(compBefore);
});

test("explicit replacement through layer edit keeps earlier retained provenance immutable", async () => {
  const jobA = await createJob([RED]);
  const jobB = await createJob([BLUE]);
  const jobC = await createJob([GREEN]);
  await makeComp("thumb");
  const add = await invoke([
    "composition", "add", "thumb", "hero", "--from-generation", jobA.jobId, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const layerId = JSON.parse(add.stdout).use.layerId as string;
  const hashA = jobA.run.outputs[0]!.contentHash;

  // In-place replacement with a different Generation Job.
  const edit = await invoke([
    "layer", "edit", layerId, "--from-generation", jobB.jobId, "--in-place", "--project", projDir, "--json",
  ]);
  expect(edit.code).toBe(0);
  const editJson = JSON.parse(edit.stdout);
  expect(editJson.ok).toBe(true);
  expect(editJson.generatedFrom).toEqual({ jobId: jobB.jobId, contentHash: jobB.run.outputs[0]!.contentHash });
  expect(editJson.layer.currentRevision.contentHash).toBe(jobB.run.outputs[0]!.contentHash);

  // Earlier retained provenance is immutable: record A unchanged on disk, its
  // revision document retained, and its content blob still present.
  expect(await readFile(path.join(projDir, "generation", jobA.jobId, "job.json")))
    .toEqual(await readFile(path.join(jobsRoot, jobA.jobId, "job.json")));
  expect(existsSync(path.join(projDir, "content", hashA))).toBe(true);
  const revisions = await readdir(path.join(projDir, "layers", `${layerId}.revisions`));
  expect(revisions.length).toBe(2);

  // The canonical resolution reader resolves each revision's contentHash to
  // its own retained provenance.
  const resolvedA = await resolveRetainedProvenance(projDir, hashA);
  expect(resolvedA?.jobId).toBe(jobA.jobId);
  const resolvedB = await resolveRetainedProvenance(projDir, jobB.run.outputs[0]!.contentHash);
  expect(resolvedB?.jobId).toBe(jobB.jobId);

  // Fork with generated content publishes a new identity for exactly one use.
  const jobD = await createJob([GREEN]);
  const fork = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "thumb", "--use", "hero",
    "--from-generation", jobD.jobId, "--project", projDir, "--json",
  ]);
  expect(fork.code).toBe(0);
  const forkJson = JSON.parse(fork.stdout);
  expect(forkJson.fork.previousLayerId).toBe(layerId);
  expect(forkJson.layer.id).not.toBe(layerId);
  expect(forkJson.generatedFrom.jobId).toBe(jobD.jobId);

  // Kind stability: generated replacement is refused on a text Layer.
  const textAdd = await invoke([
    "composition", "add", "thumb", "caption", "--text", "hello", "--font", "Anton", "--project", projDir, "--json",
  ]);
  expect(textAdd.code).toBe(0);
  const textId = JSON.parse(textAdd.stdout).use.layerId as string;
  const textEdit = await invoke([
    "layer", "edit", textId, "--from-generation", jobB.jobId, "--project", projDir, "--json",
  ]);
  expect(textEdit.code).toBe(1);
  expect(JSON.parse(textEdit.stdout).error).toContain("text Layer");
});

test("shared generated Layer still enforces the blast-radius guard (regression)", async () => {
  const job = await createJob([RED]);
  await makeComp("a");
  await makeComp("b");
  const add = await invoke(["composition", "add", "a", "hero", "--from-generation", job.jobId, "--project", projDir, "--json"]);
  expect(add.code).toBe(0);
  const layerId = JSON.parse(add.stdout).use.layerId as string;
  await invoke(["composition", "import", "b", "a", "--project", projDir]);

  const edit = await invoke([
    "layer", "edit", layerId, "--from-generation", job.jobId, "--project", projDir, "--json",
  ]);
  expect(edit.code).toBe(1);
  const err = JSON.parse(edit.stdout);
  expect(err.ok).toBe(false);
  expect(err.referrersCount).toBe(2);
});

test("resolves offline after external generation files are removed and the Project is relocated", async () => {
  const job = await createJob([RED]);
  await makeComp("thumb");
  const add = await invoke([
    "composition", "add", "thumb", "hero", "--from-generation", job.jobId, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);

  // Retain a manifest for replay before relocation.
  const render1 = await invoke([
    "composition", "render", "thumb", "--out", path.join(projDir, "renders", "first.png"),
    "--project", projDir, "--json",
  ]);
  expect(render1.code).toBe(0);
  const manifest = (await readdir(path.join(projDir, "renders"))).find((f) => f.endsWith(".manifest.json"))!;

  // Remove the entire external generation surface, then relocate the Project.
  await rm(path.join(root, "out"), { recursive: true, force: true });
  const moved = path.join(root, "relocated");
  await rename(projDir, moved);

  const render2 = await invoke([
    "composition", "render", "thumb", "--out", path.join(moved, "renders", "second.png"),
    "--project", moved,
  ]);
  expect(render2.code).toBe(0);
  const png = decodePng(await readFile(path.join(moved, "renders", "second.png")));
  const [r, g, b] = pixel(png, 5, 5);
  expect(closeTo(r, 220) && closeTo(g, 0) && closeTo(b, 0)).toBe(true);

  const replay = await invoke([
    "composition", "replay", path.join(moved, "renders", manifest),
    "--project", moved, "--json",
  ]);
  expect(replay.code).toBe(0);
  expect(JSON.parse(replay.stdout).ok).toBe(true);

  const resolved = await resolveRetainedProvenance(moved, job.run.outputs[0]!.contentHash);
  expect(resolved?.jobId).toBe(job.jobId);
});

test("refuses missing, corrupt, and mismatched source/provenance without live mutation", async () => {
  await makeComp("thumb");
  const compEmpty = await readFile(path.join(projDir, "compositions", "thumb.json"));
  const layersEmpty = await snapshotDir(path.join(projDir, "layers"));
  const contentEmpty = await snapshotDir(path.join(projDir, "content"));

  // Unknown job id.
  const missing = await invoke([
    "composition", "add", "thumb", "hero", "--from-generation", "gen-no-such-job", "--project", projDir, "--json",
  ]);
  expect(missing.code).toBe(1);
  expect(JSON.parse(missing.stdout).error).toContain("gen-no-such-job");

  // Corrupted output bytes: hash no longer matches the recorded identity.
  const corruptJob = await createJob([RED]);
  const corruptFile = path.join(jobsRoot, corruptJob.jobId, corruptJob.run.outputs[0]!.file);
  const bytes = await readFile(corruptFile);
  // Flip the IHDR chunk length byte (currently 0x00) so the file bytes
  // provably change; the recorded content identity no longer matches.
  expect(bytes[8]).toBe(0x00);
  bytes.write("\xff", 8);
  await writeFile(corruptFile, bytes);
  const corrupt = await invoke([
    "composition", "add", "thumb", "hero", "--from-generation", corruptJob.jobId, "--project", projDir, "--json",
  ]);
  expect(corrupt.code).toBe(1);
  expect(JSON.parse(corrupt.stdout).error).toContain(corruptJob.run.outputs[0]!.contentHash.slice(0, 12));

  // Missing output file.
  const goneJob = await createJob([BLUE]);
  await rm(path.join(jobsRoot, goneJob.jobId, goneJob.run.outputs[0]!.file));
  const gone = await invoke([
    "composition", "add", "thumb", "hero", "--from-generation", goneJob.jobId, "--project", projDir, "--json",
  ]);
  expect(gone.code).toBe(1);
  expect(JSON.parse(gone.stdout).error).toContain("missing");

  // Malformed retained record.
  const badJob = await createJob([GREEN]);
  await writeFile(path.join(jobsRoot, badJob.jobId, "job.json"), "{ not json");
  const bad = await invoke([
    "composition", "add", "thumb", "hero", "--from-generation", badJob.jobId, "--project", projDir, "--json",
  ]);
  expect(bad.code).toBe(1);

  // The refusals so far published nothing live.
  expect(await readFile(path.join(projDir, "compositions", "thumb.json"))).toEqual(compEmpty);
  expect(await snapshotDir(path.join(projDir, "layers"))).toEqual(layersEmpty);
  expect(await snapshotDir(path.join(projDir, "content"))).toEqual(contentEmpty);

  // Retained-record mismatch: tamper the retained copy, then re-ingest the
  // same job — the mismatch is refused; retained provenance is immutable.
  const okJob = await createJob([RED]);
  const first = await invoke([
    "composition", "add", "thumb", "first", "--from-generation", okJob.jobId, "--project", projDir, "--json",
  ]);
  expect(first.code).toBe(0);
  // Baseline after the one successful add — everything after it must refuse.
  const compBefore = await readFile(path.join(projDir, "compositions", "thumb.json"));
  const layersBefore = await snapshotDir(path.join(projDir, "layers"));
  const contentBefore = await snapshotDir(path.join(projDir, "content"));
  const retainedFile = path.join(projDir, "generation", okJob.jobId, "job.json");
  const tampered = JSON.parse(await readFile(retainedFile, "utf8"));
  tampered.request.prompt = "tampered";
  await writeFile(retainedFile, JSON.stringify(tampered, null, 2) + "\n");
  const second = await invoke([
    "composition", "add", "thumb", "second", "--from-generation", okJob.jobId, "--project", projDir, "--json",
  ]);
  expect(second.code).toBe(1);
  expect(JSON.parse(second.stdout).error).toContain("immutable");

  // No live incomplete reference appeared on any failure path: the refused
  // re-ingest left the live Composition, Layers, and content store untouched.
  expect(await readFile(path.join(projDir, "compositions", "thumb.json"))).toEqual(compBefore);
  expect(await snapshotDir(path.join(projDir, "layers"))).toEqual(layersBefore);
  expect(await snapshotDir(path.join(projDir, "content"))).toEqual(contentBefore);

  // The earlier refusals (unknown job, corrupt bytes, missing output,
  // malformed record) also published nothing: the live Composition gained
  // exactly the one use from the successful add, and its content blob is the
  // only new entry in the store.
  const comp = JSON.parse(await readFile(path.join(projDir, "compositions", "thumb.json"), "utf8"));
  expect(comp.layers).toHaveLength(1);
  expect(comp.layers[0].name).toBe("first");
  const contentNow = await snapshotDir(path.join(projDir, "content"));
  const newHashes = Object.keys(contentNow).filter((h) => contentEmpty[h] === undefined);
  expect(newHashes).toEqual([okJob.run.outputs[0]!.contentHash]);
  expect(contentNow[newHashes[0]!]!.equals(solidPng(RED))).toBe(true);
});

test("injected publication failure (add) leaves live state unchanged; a retry succeeds", async () => {
  const job = await createJob([RED]);
  await makeComp("thumb");
  const compBefore = await readFile(path.join(projDir, "compositions", "thumb.json"));
  const layersBefore = await snapshotDir(path.join(projDir, "layers"));

  const lockModule = path.resolve(import.meta.dir, "../src/project-lock.ts");
  const preload = path.join(root, "fail-add.ts");
  await writeFile(
    preload,
    `
    import { mock } from "bun:test";
    import * as lock from ${JSON.stringify(lockModule)};
    const original = { ...lock };
    mock.module(${JSON.stringify(lockModule)}, () => ({
      ...original,
      atomicReplace: async (file: string, content: string | Buffer) => {
        if (String(file).endsWith("thumb.json")) {
          throw new Error("Simulated publication failure");
        }
        return original.atomicReplace(file, content);
      },
    }));
  `,
  );
  // cli.ts re-spawns the submodule without forwarding --preload, so the
  // failure-injection subprocess targets composition-cli.ts directly.
  const fail = Bun.spawn([process.execPath, "--preload", preload, path.resolve(import.meta.dir, "../src/composition-cli.ts"),
    "add", "thumb", "hero", "--from-generation", job.jobId, "--project", projDir, "--json"], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const [failOut, , failCode] = await Promise.all([
    new Response(fail.stdout).text(), new Response(fail.stderr).text(), fail.exited,
  ]);
  expect(failCode).toBe(1);
  expect(JSON.parse(failOut).ok).toBe(false);
  expect(JSON.parse(failOut).error).toContain("Simulated publication failure");

  // Live references and Layer state unchanged; staged identity/revision cleaned.
  expect(await readFile(path.join(projDir, "compositions", "thumb.json"))).toEqual(compBefore);
  expect(await snapshotDir(path.join(projDir, "layers"))).toEqual(layersBefore);

  // Retained provenance and content may remain as documented orphans — and
  // they are valid, verbatim, and resolvable.
  expect(await readFile(path.join(projDir, "generation", job.jobId, "job.json")))
    .toEqual(await readFile(path.join(jobsRoot, job.jobId, "job.json")));
  const resolved = await resolveRetainedProvenance(projDir, job.run.outputs[0]!.contentHash);
  expect(resolved?.jobId).toBe(job.jobId);

  // Retry (same job) succeeds through the byte-identical retained record.
  const retry = await invoke([
    "composition", "add", "thumb", "hero", "--from-generation", job.jobId, "--project", projDir, "--json",
  ]);
  expect(retry.code).toBe(0);
  expect(JSON.parse(retry.stdout).generatedFrom.jobId).toBe(job.jobId);
});

test("injected publication failure (edit) leaves live state unchanged; a retry succeeds", async () => {
  const jobA = await createJob([RED]);
  const jobB = await createJob([BLUE]);
  await makeComp("thumb");
  const add = await invoke([
    "composition", "add", "thumb", "hero", "--from-generation", jobA.jobId, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const layerId = JSON.parse(add.stdout).use.layerId as string;
  const identityBefore = await readFile(path.join(projDir, "layers", `${layerId}.json`));
  const revisionsBefore = await snapshotDir(path.join(projDir, "layers", `${layerId}.revisions`));

  const lockModule = path.resolve(import.meta.dir, "../src/project-lock.ts");
  const preload = path.join(root, "fail-edit.ts");
  await writeFile(
    preload,
    `
    import { mock } from "bun:test";
    import * as lock from ${JSON.stringify(lockModule)};
    const original = { ...lock };
    mock.module(${JSON.stringify(lockModule)}, () => ({
      ...original,
      atomicReplace: async (file: string, content: string | Buffer) => {
        if (String(file).endsWith("${layerId}.json")) {
          throw new Error("Simulated edit publication failure");
        }
        return original.atomicReplace(file, content);
      },
    }));
  `,
  );
  // Same preload boundary: layer-cli.ts directly (cli.ts drops --preload).
  const fail = Bun.spawn([process.execPath, "--preload", preload, path.resolve(import.meta.dir, "../src/layer-cli.ts"),
    "edit", layerId, "--from-generation", jobB.jobId, "--in-place", "--project", projDir, "--json"], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const [failOut, , failCode] = await Promise.all([
    new Response(fail.stdout).text(), new Response(fail.stderr).text(), fail.exited,
  ]);
  expect(failCode).toBe(1);
  expect(JSON.parse(failOut).ok).toBe(false);
  expect(JSON.parse(failOut).error).toContain("Simulated edit publication failure");

  // Live reference unchanged; the staged revision was cleaned up.
  expect(await readFile(path.join(projDir, "layers", `${layerId}.json`))).toEqual(identityBefore);
  expect(await snapshotDir(path.join(projDir, "layers", `${layerId}.revisions`))).toEqual(revisionsBefore);

  // Retry succeeds.
  const retry = await invoke([
    "layer", "edit", layerId, "--from-generation", jobB.jobId, "--in-place", "--project", projDir, "--json",
  ]);
  expect(retry.code).toBe(0);
  expect(JSON.parse(retry.stdout).layer.currentRevision.contentHash).toBe(jobB.run.outputs[0]!.contentHash);
});

test("provenance resolution is fail-closed on ambiguity and unreadable retained records", async () => {
  // Two jobs producing byte-identical outputs: resolution is refused rather
  // than guessed.
  const jobA = await createJob([RED]);
  const jobB = await createJob([RED]);
  await makeComp("thumb");
  const addA = await invoke([
    "composition", "add", "thumb", "first", "--from-generation", jobA.jobId, "--project", projDir, "--json",
  ]);
  expect(addA.code).toBe(0);
  const addB = await invoke([
    "composition", "add", "thumb", "second", "--from-generation", jobB.jobId, "--output", "1",
    "--project", projDir, "--json",
  ]);
  expect(addB.code).toBe(0);
  const hash = jobA.run.outputs[0]!.contentHash;
  expect(jobB.run.outputs[0]!.contentHash).toBe(hash);
  await expect(resolveRetainedProvenance(projDir, hash)).rejects.toThrow(/ambiguous/i);

  // An unreadable retained record fails closed instead of silent absence.
  await mkdir(path.join(projDir, "generation", "zz-corrupt"), { recursive: true });
  await writeFile(path.join(projDir, "generation", "zz-corrupt", "job.json"), "{ broken");
  await expect(resolveRetainedProvenance(projDir, "f".repeat(64))).rejects.toThrow();
});

test("ingesting an already-retained job again reuses the record byte-identically", async () => {
  const job = await createJob([RED]);
  await makeComp("thumb");
  const first = await invoke([
    "composition", "add", "thumb", "first", "--from-generation", job.jobId, "--project", projDir, "--json",
  ]);
  expect(first.code).toBe(0);
  const retainedBefore = await readFile(path.join(projDir, "generation", job.jobId, "job.json"));
  const second = await invoke([
    "composition", "add", "thumb", "second", "--from-generation", job.jobId, "--output", "1",
    "--project", projDir, "--json",
  ]);
  expect(second.code).toBe(0);
  expect(await readFile(path.join(projDir, "generation", job.jobId, "job.json"))).toEqual(retainedBefore);
  const record = await loadGenerationJob(jobsRoot, job.jobId);
  expect(record.request.prompt).toBe("deterministic test content");
});