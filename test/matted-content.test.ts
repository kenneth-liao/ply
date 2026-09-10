/**
 * Matting-content ingestion into Project Layers (#108, spec #102 US-003/US-005).
 *
 * Verifies through the public CLI, mirroring the #107 generated-content
 * retention contract:
 * - `composition add --from-matte <matteId>` ingests the published matte's
 *   verified output as an ordinary image Layer through the canonical Layer
 *   publication protocol — no category/approval fields, no matted-Layer
 *   identity, no alternate lifecycle.
 * - `layer edit <id> --from-matte <matteId>` explicitly replaces an image
 *   Layer's content through the existing editing contract.
 * - The matte record is retained verbatim under the Project's `matting/`
 *   directory — the one retained representation of the Matting facts (source
 *   identity, output identity, engine, operation provenance) — and pixels
 *   are retained in the content store. Resolution works offline after the
 *   external Matting files are removed and the Project is relocated.
 * - When the matte's source is a generated output (derived linkage: the
 *   matte's source content identity matches a published Generation Job's
 *   output), that job's record is retained verbatim through the existing
 *   #107 machinery — the request facts keep their one home.
 * - Missing, corrupt, or mismatched matte lineage is refused with no live
 *   incomplete Layer; retained lineage is preserved across replacement.
 * - Ingestion never invokes the MatteEngine or generation (tripwire), and
 *   the introduced options follow the compact/JSON/help/error CLI contract.
 *
 * Deterministic mattes are produced through the independent Matting
 * operation with an injected fake MatteEngine (never real weights); the
 * subprocess CLI resolves them through the default `<cwd>/out/matting` root.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng, decodePng } from "./png.js";
import { initProject } from "../src/project.js";
import { runMatting, type MattingRecord } from "../src/matting.js";
import type { MatteEngine } from "../src/matte.js";
import { composeMatte } from "../src/matte.js";
import { runUniformGeneration, type GenerationJobRecord } from "../src/generation.js";
import { resolveRetainedProvenance } from "../src/generation-retention.js";
import {
  resolveRetainedMattingProvenance,
  resolveRetainedMatteGenerationLineage,
} from "../src/matting-retention.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

let root: string;
let projDir: string;
let matteRoot: string;
let jobsRoot: string;
let jobSeq = 0;
let matteSeq = 0;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-matted-content-"));
  projDir = path.join(root, "proj");
  await initProject(projDir, { name: "matte-project" });
  matteRoot = path.join(root, "out", "matting");
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
  return encodePng(32, 32, () => rgba);
}

const RED: [number, number, number, number] = [220, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 230, 255];

/** An opaque source PNG (the ordinary Matting input that needs a matte). */
const OPAQUE_SUBJECT = encodePng(
  16,
  16,
  () => [200, 30, 40, 255],
  { colorType: 2 },
);

/** Its segmentation mask: white subject, black background. */
const MASK = encodePng(
  16,
  16,
  (x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? [255, 255, 255, 255] : [0, 0, 0, 255]),
  { colorType: 2 },
);

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): number[] {
  return png.px(x, y);
}

const closeTo = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

/** An engine that mattes through MASK — the deterministic injected seam. */
const fakeEngine: MatteEngine = async ({ bytes, label }) => ({
  bytes: composeMatte(bytes, MASK, label),
  engine: "test/segmenter",
});

/** Create a deterministic matte of the given source file through the public operation. */
async function createMatte(sourcePath: string, engine: MatteEngine = fakeEngine): Promise<MattingRecord> {
  const matteId = `matte-test-${String(++matteSeq).padStart(3, "0")}`;
  return runMatting(matteRoot, matteId, sourcePath, { engine });
}

/** Create a deterministic Generation Job whose outputs are the given PNGs, in order. */
async function createJob(colors: [number, number, number, number][]): Promise<GenerationJobRecord> {
  const pngs = colors.map(solidPng);
  let i = 0;
  const jobId = `gen-test-${String(++jobSeq).padStart(3, "0")}`;
  return runUniformGeneration(
    jobsRoot,
    jobId,
    {
      prompt: "deterministic test content",
      intent: "full-canvas",
      model: "gpt-image",
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
}

/** Create a Composition in the Project through the public CLI. */
async function makeComp(name: string, width = 64, height = 64) {
  const res = await invoke(["composition", "create", name, "--width", String(width), "--height", String(height), "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
}

test("adds a matte's verified output as an ordinary image Layer with verbatim retained Matting provenance", async () => {
  const source = path.join(root, "subject.png");
  await writeFile(source, OPAQUE_SUBJECT);
  const matte = await createMatte(source);
  const output = matte.result.outputs[0]!;
  await makeComp("thumb");

  const res = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", matte.matteId,
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(true);
  expect(json.mattedFrom).toEqual({ matteId: matte.matteId, engine: matte.result.engine, contentHash: output.contentHash });
  expect(json.layer.currentRevision.kind).toBe("image");
  expect(json.layer.currentRevision.contentHash).toBe(output.contentHash);

  // The matted bytes are retained in the content store, byte-identical.
  const blob = await readFile(path.join(projDir, "content", output.contentHash));
  expect(blob.equals(await readFile(path.join(matteRoot, matte.matteId, output.file)))).toBe(true);

  // The record is retained verbatim under the Project — the one retained
  // representation of the Matting provenance.
  const retained = path.join(projDir, "matting", matte.matteId, "matte.json");
  expect(existsSync(retained)).toBe(true);
  expect((await readFile(retained)).toString()).toEqual((await readFile(path.join(matteRoot, matte.matteId, "matte.json"))).toString());

  // No new identity/category/approval fields on the stored documents: the
  // revision is an ordinary image revision with the canonical placement and
  // transform facts (scale 1, rotation 0, no flip at add time, #133/#134/#135).
  const revisionRaw = JSON.parse(
    await readFile(path.join(projDir, "layers", `${json.use.layerId}.revisions`, `${json.layer.currentRevisionId}.json`), "utf8"),
  );
  expect(Object.keys(revisionRaw).sort()).toEqual(
    ["contentHash", "createdAt", "flipX", "flipY", "kind", "layerId", "opacity", "rotationDeg", "scaleX", "scaleY", "schemaVersion", "x", "y"].sort(),
  );
  expect(revisionRaw.scaleX).toBe(1);
  expect(revisionRaw.scaleY).toBe(1);
  expect(revisionRaw.rotationDeg).toBe(0);
  expect(revisionRaw.flipX).toBe(false);
  expect(revisionRaw.flipY).toBe(false);
  expect(revisionRaw.kind).toBe("image");

  // The Layer renders the matted pixels: opaque red subject, transparent cut.
  const render = await invoke([
    "composition", "render", "thumb", "--out", path.join(projDir, "renders", "check.png"),
    "--project", projDir, "--json",
  ]);
  expect(render.code).toBe(0);
  const png = decodePng(await readFile(path.join(projDir, "renders", "check.png")));
  expect([png.width, png.height]).toEqual([64, 64]);
  const [r, g, b, a] = pixel(png, 0, 0);
  expect(a).toBe(0);
  const [r2, g2, b2, a2] = pixel(png, 8, 8);
  expect(closeTo(r2, 200) && closeTo(g2, 30) && closeTo(b2, 40) && a2 === 255).toBe(true);
});

test("resolves retained source identity, output identity, engine, and operation provenance offline after external Matting files are removed and the Project is relocated", async () => {
  const source = path.join(root, "subject.png");
  await writeFile(source, OPAQUE_SUBJECT);
  const matte = await createMatte(source);
  const output = matte.result.outputs[0]!;
  await makeComp("thumb");

  const res = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", matte.matteId,
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const layerId = JSON.parse(res.stdout).use.layerId;
  const revisionHash = JSON.parse(res.stdout).layer.currentRevisionId;

  // External Matting files and the original source are gone; the Project is
  // relocated. The retained provenance must still resolve.
  await rm(path.join(root, "out"), { recursive: true, force: true });
  await rm(source, { force: true });
  const moved = path.join(root, "moved");
  await Bun.spawn(["mv", projDir, moved]).exited;

  const resolved = await resolveRetainedMattingProvenance(moved, output.contentHash);
  expect(resolved).not.toBeNull();
  expect(resolved!.matteId).toBe(matte.matteId);
  expect(resolved!.matte.result.engine).toBe(matte.result.engine);
  expect(resolved!.output.contentHash).toBe(output.contentHash);
  expect(resolved!.matte.request.source.contentHash).toBe(matte.request.source.contentHash);
  expect(resolved!.matte.request.source.path).toBe(matte.request.source.path);
  expect(resolved!.matte.createdAt).toBe(matte.createdAt);
  expect(resolved!.matte.result.alpha).toEqual(matte.result.alpha);
  expect(resolved!.matte.result.warnings).toEqual(matte.result.warnings);

  // The Layer's current revision still carries the same content identity.
  const revisionRaw = JSON.parse(
    await readFile(path.join(moved, "layers", `${layerId}.revisions`, `${revisionHash}.json`), "utf8"),
  );
  expect(revisionRaw.contentHash).toBe(output.contentHash);

  // Non-matted content resolves to no Matting provenance.
  expect(await resolveRetainedMattingProvenance(moved, "f".repeat(64))).toBeNull();

  // The chained full-lineage reader composes Matting + generation provenance;
  // a local-source matte has no generation predecessor.
  const lineage = await resolveRetainedMatteGenerationLineage(moved, output.contentHash);
  expect(lineage).not.toBeNull();
  expect(lineage!.matting.matteId).toBe(matte.matteId);
  expect(lineage!.generation).toBeNull();
});

test("a matte of a generated result retains both Matting lineage and the predecessor generation provenance, with request facts in their one home", async () => {
  const job = await createJob([RED]);
  const jobOutput = job.run.outputs[0]!;

  // The generated output is matted through the independent operation.
  const matte = await createMatte(path.join(jobsRoot, job.jobId, jobOutput.file));
  const output = matte.result.outputs[0]!;
  await makeComp("thumb");

  const res = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", matte.matteId,
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.mattedFrom).toEqual({ matteId: matte.matteId, engine: matte.result.engine, contentHash: output.contentHash });
  expect(json.generatedFrom).toEqual({ jobId: job.jobId, contentHash: output.contentHash });

  // Both records are retained verbatim — the matte's, and the predecessor
  // generation job's through the existing #107 machinery.
  const retainedMatte = path.join(projDir, "matting", matte.matteId, "matte.json");
  const retainedJob = path.join(projDir, "generation", job.jobId, "job.json");
  expect((await readFile(retainedMatte)).toString()).toEqual((await readFile(path.join(matteRoot, matte.matteId, "matte.json"))).toString());
  expect((await readFile(retainedJob))).toEqual(await readFile(path.join(jobsRoot, job.jobId, "job.json")));

  // The request facts keep their one home: the matte record carries no
  // request facts of the generation (no prompt/model), only the source
  // identity that derives the linkage.
  const retainedMatteJson = JSON.parse((await readFile(retainedMatte)).toString());
  expect(JSON.stringify(retainedMatteJson)).not.toContain(job.request.prompt);
  expect(Object.keys(retainedMatteJson.request).sort()).toEqual(["source"]);

  // The full lineage chain resolves offline after the external files are
  // removed and the Project is relocated: revision hash → matte → generation.
  await rm(path.join(root, "out"), { recursive: true, force: true });
  const moved = path.join(root, "moved");
  await Bun.spawn(["mv", projDir, moved]).exited;
  const lineage = await resolveRetainedMatteGenerationLineage(moved, output.contentHash);
  expect(lineage).not.toBeNull();
  expect(lineage!.matting.matteId).toBe(matte.matteId);
  expect(lineage!.generation).not.toBeNull();
  expect(lineage!.generation!.jobId).toBe(job.jobId);
  expect(lineage!.generation!.job.request.prompt).toBe(job.request.prompt);
  expect(lineage!.generation!.output.contentHash).toBe(matte.request.source.contentHash);

  // The direct generation reader still resolves the predecessor by the matte
  // record's source identity alone.
  const direct = await resolveRetainedProvenance(moved, matte.request.source.contentHash);
  expect(direct).not.toBeNull();
  expect(direct!.jobId).toBe(job.jobId);
});

test("refuses corrupt or mismatched matte lineage before publishing a live incomplete Layer, and a retry after repair succeeds", async () => {
  const source = path.join(root, "subject.png");
  await writeFile(source, OPAQUE_SUBJECT);
  await makeComp("thumb");

  // Mismatched source/result association: the output bytes were tampered
  // after publication — the record's content identity no longer matches.
  const tampered = await createMatte(source);
  const tamperedOutput = path.join(matteRoot, tampered.matteId, tampered.result.outputs[0]!.file);
  await writeFile(tamperedOutput, solidPng(BLUE));

  const res = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", tampered.matteId,
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(1);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(false);
  expect(json.error).toMatch(/mismatched|corrupted/i);

  // No live incomplete Layer: the Composition is unchanged, no Layer exists,
  // and no lineage was retained.
  const compRaw = JSON.parse(await readFile(path.join(projDir, "compositions", "thumb.json"), "utf8"));
  expect(compRaw.layers).toEqual([]);
  expect(existsSync(path.join(projDir, "matting", tampered.matteId, "matte.json"))).toBe(false);

  // A corrupt record is refused the same way.
  const corrupt = await createMatte(source);
  await writeFile(path.join(matteRoot, corrupt.matteId, "matte.json"), "{ not json");
  const corruptRes = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", corrupt.matteId,
    "--project", projDir, "--json",
  ]);
  expect(corruptRes.code).toBe(1);
  expect(JSON.parse(corruptRes.stdout).error).toMatch(/unreadable/i);
  expect(existsSync(path.join(projDir, "matting", corrupt.matteId, "matte.json"))).toBe(false);
  expect(JSON.parse(await readFile(path.join(projDir, "compositions", "thumb.json"), "utf8")).layers).toEqual([]);

  // A missing record is refused.
  const missingRes = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", "matte-absent",
    "--project", projDir, "--json",
  ]);
  expect(missingRes.code).toBe(1);
  expect(JSON.parse(missingRes.stdout).error).toMatch(/No matte/);

  // After repairing the tampered matte directory... it was never published
  // correctly, so a fresh matte of the same source ingests cleanly.
  const repaired = await createMatte(source);
  const retry = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", repaired.matteId,
    "--project", projDir, "--json",
  ]);
  expect(retry.code).toBe(0);
  expect(JSON.parse(retry.stdout).ok).toBe(true);
  expect(JSON.parse(await readFile(path.join(projDir, "compositions", "thumb.json"), "utf8")).layers).toHaveLength(1);
});

test("layer edit --from-matte replaces content through the existing edit contract, preserving earlier retained lineage; a failed replacement leaves live state and retained provenance untouched", async () => {
  // Start from a generated Layer (retained generation provenance), then
  // replace its content with a matte of a local image.
  const job = await createJob([RED]);
  await makeComp("thumb");
  const addRes = await invoke([
    "composition", "add", "thumb", "hero", "--from-generation", job.jobId,
    "--project", projDir, "--json",
  ]);
  expect(addRes.code).toBe(0);
  const layerId = JSON.parse(addRes.stdout).use.layerId;
  const oldHash = JSON.parse(addRes.stdout).layer.currentRevision.contentHash;
  const genRecordBefore = await readFile(path.join(projDir, "generation", job.jobId, "job.json"));

  const source = path.join(root, "subject.png");
  await writeFile(source, OPAQUE_SUBJECT);
  const matte = await createMatte(source);
  const output = matte.result.outputs[0]!;

  // A corrupt source fails the replacement and changes nothing live: the
  // earlier revision, its retained provenance, and the composition reference
  // are all preserved byte-identically.
  const broken = await createMatte(source);
  const brokenOutput = path.join(matteRoot, broken.matteId, broken.result.outputs[0]!.file);
  await writeFile(brokenOutput, solidPng(BLUE));
  const failRes = await invoke([
    "layer", "edit", layerId, "--from-matte", broken.matteId,
    "--project", projDir, "--json",
  ]);
  expect(failRes.code).toBe(1);
  expect(JSON.parse(failRes.stdout).error).toMatch(/mismatched|corrupted/i);
  const identityRaw = JSON.parse(await readFile(path.join(projDir, "layers", `${layerId}.json`), "utf8"));
  expect(identityRaw.currentRevision).toBe(JSON.parse(addRes.stdout).layer.currentRevisionId);
  expect(await readFile(path.join(projDir, "generation", job.jobId, "job.json"))).toEqual(genRecordBefore);
  expect(existsSync(path.join(projDir, "matting", broken.matteId, "matte.json"))).toBe(false);

  // The successful replacement publishes the matte's pixels and retains its
  // provenance verbatim; the earlier generation provenance stays byte-identical.
  const editRes = await invoke([
    "layer", "edit", layerId, "--from-matte", matte.matteId,
    "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.mattedFrom).toEqual({ matteId: matte.matteId, engine: matte.result.engine, contentHash: output.contentHash });
  expect(editJson.layer.currentRevision.contentHash).toBe(output.contentHash);
  expect((await readFile(path.join(projDir, "matting", matte.matteId, "matte.json"))).toString())
    .toEqual((await readFile(path.join(matteRoot, matte.matteId, "matte.json"))).toString());
  expect(await readFile(path.join(projDir, "generation", job.jobId, "job.json"))).toEqual(genRecordBefore);

  // The earlier revision's provenance still resolves through the derived
  // readers — retention is never rewritten.
  expect((await resolveRetainedProvenance(projDir, oldHash))?.jobId).toBe(job.jobId);
  expect((await resolveRetainedMattingProvenance(projDir, output.contentHash))?.matteId).toBe(matte.matteId);

  // Kind stability: a text Layer refuses --from-matte.
  const textRes = await invoke([
    "composition", "add", "thumb", "label", "--text", "hi", "--font", "Anton",
    "--project", projDir, "--json",
  ]);
  expect(textRes.code).toBe(0);
  const textLayerId = JSON.parse(textRes.stdout).use.layerId;
  const textEdit = await invoke([
    "layer", "edit", textLayerId, "--from-matte", matte.matteId,
    "--project", projDir, "--json",
  ]);
  expect(textEdit.code).toBe(1);
  expect(JSON.parse(textEdit.stdout).error).toMatch(/text Layer/i);
});

test("the introduced options follow the CLI contract: help, usage errors, and compact text", async () => {
  const source = path.join(root, "subject.png");
  await writeFile(source, OPAQUE_SUBJECT);
  const matte = await createMatte(source);
  await makeComp("thumb");

  // Help names the introduced option.
  const help = await invoke(["composition", "add", "--help"]);
  expect(help.stdout).toContain("--from-matte");
  const layerHelp = await invoke(["layer", "edit", "--help"]);
  expect(layerHelp.stdout).toContain("--from-matte");

  // Usage errors exit 2 with actionable messages.
  const mixed = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", matte.matteId, "--image", "x.png",
    "--project", projDir, "--json",
  ]);
  expect(mixed.code).toBe(2);
  expect(JSON.parse(mixed.stdout).error).toMatch(/mutually exclusive/i);

  const withOutput = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", matte.matteId, "--output", "1",
    "--project", projDir, "--json",
  ]);
  expect(withOutput.code).toBe(2);
  expect(JSON.parse(withOutput.stdout).error).toMatch(/--output/);

  const blank = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", " ",
    "--project", projDir, "--json",
  ]);
  expect(blank.code).toBe(2);
  expect(JSON.parse(blank.stdout).error).toMatch(/takes a matte id/);

  // Compact text names the matte, its engine, and the retained provenance.
  const addRes = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", matte.matteId,
    "--project", projDir, "--json",
  ]);
  expect(addRes.code).toBe(0);
  const textRes = await invoke([
    "composition", "add", "thumb", "second", "--from-matte", matte.matteId,
    "--project", projDir,
  ]);
  expect(textRes.code).toBe(0);
  expect(textRes.stdout).toContain(`from matte ${matte.matteId}`);
  expect(textRes.stdout).toContain("test/segmenter");
  expect(textRes.stdout).toContain("provenance retained");
});

test("ambiguous lineage fails closed: two published jobs claiming the matte's source, and two retained mattes claiming one content identity", async () => {
  // Two published jobs whose outputs are identical bytes — the matte's
  // source identity matches both, so the predecessor provenance would be
  // ambiguous and ingestion is refused.
  const jobA = await createJob([RED]);
  const jobB = await createJob([RED]);
  expect(jobA.run.outputs[0]!.contentHash).toBe(jobB.run.outputs[0]!.contentHash);
  const matte = await createMatte(path.join(jobsRoot, jobA.jobId, jobA.run.outputs[0]!.file));
  await makeComp("thumb");
  const res = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", matte.matteId,
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error).toMatch(/ambiguous/i);
  expect(existsSync(path.join(projDir, "matting", matte.matteId, "matte.json"))).toBe(false);
  expect(existsSync(path.join(projDir, "generation", jobA.jobId, "job.json"))).toBe(false);

  // Two retained mattes claiming the same output bytes (two mattes of one
  // local source) — resolution fails closed rather than report wrong
  // provenance.
  const source = path.join(root, "subject.png");
  await writeFile(source, OPAQUE_SUBJECT);
  const matteC = await createMatte(source);
  const matteD = await createMatte(source);
  expect(matteC.matteId).not.toBe(matteD.matteId);
  expect(matteD.result.outputs[0]!.contentHash).toBe(matteC.result.outputs[0]!.contentHash);
  const addC = await invoke([
    "composition", "add", "thumb", "first", "--from-matte", matteC.matteId,
    "--project", projDir, "--json",
  ]);
  expect(addC.code).toBe(0);
  const addD = await invoke([
    "composition", "add", "thumb", "second", "--from-matte", matteD.matteId,
    "--project", projDir, "--json",
  ]);
  expect(addD.code).toBe(0);
  await expect(
    resolveRetainedMattingProvenance(projDir, matteC.result.outputs[0]!.contentHash),
  ).rejects.toThrow(/ambiguous/i);
  await expect(resolveRetainedMattingProvenance(projDir, "f".repeat(64))).resolves.toBeNull();
});