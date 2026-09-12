/**
 * Project retention of matte source bytes (spec #159 ticket #161, US-003).
 *
 * Ingesting a published version 2 matte via `--from-matte` retains the
 * published source copy (`sources/<sha256>.png`) beside the verbatim record
 * inside the Project, so a relocated Project can rematte without the
 * original path. Remat is ordinary Matting on the retained path (no new
 * command). Native-alpha ingest stores no second blob; schemaVersion 1
 * records gain no source copy (no backfill); existing Layer bytes and
 * Renders are not rewritten.
 *
 * Deterministic mattes are produced through the independent Matting
 * operation with an injected fake MatteEngine (never real weights); the
 * subprocess CLI resolves them through the default `<cwd>/out/matting`
 * root. Remat runs the same operation with the same injected seam on the
 * retained path.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng } from "./png.js";
import { initProject } from "../src/project.js";
import { runMatting, type MattingRecord } from "../src/matting.js";
import { run as runMatteCli } from "../src/matting-cli.js";
import type { MatteEngine } from "../src/matte.js";
import { composeMatte } from "../src/matte.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

let root: string;
let projDir: string;
let matteRoot: string;
let matteSeq = 0;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-matte-source-retention-"));
  projDir = path.join(root, "proj");
  await initProject(projDir, { name: "matte-source-project" });
  matteRoot = path.join(root, "out", "matting");
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

/** An opaque source PNG (the ordinary Matting input that needs inference). */
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

/** A source that already carries a real matte — the native-alpha route. */
const NATIVE_ALPHA_PNG = encodePng(16, 16, (x, y) =>
  x < 8 && y < 8 ? [255, 0, 0, 255] : [0, 0, 0, 0],
);

/** An engine that mattes through MASK — the deterministic injected seam. */
const fakeEngine: MatteEngine = async ({ bytes, label }) => ({
  bytes: composeMatte(bytes, MASK, label),
  engine: "test/segmenter",
  backend: "test-backend",
  timing: { millis: 42, scope: "test-engine-call" },
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Create a deterministic matte of the given source file through the public operation. */
async function createMatte(sourcePath: string, engine: MatteEngine = fakeEngine): Promise<MattingRecord> {
  const matteId = `matte-test-${String(++matteSeq).padStart(3, "0")}`;
  return runMatting(matteRoot, matteId, sourcePath, { engine });
}

/** Create a Composition in the Project through the public CLI. */
async function makeComp(name: string, width = 64, height = 64) {
  const res = await invoke(["composition", "create", name, "--width", String(width), "--height", String(height), "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
}

test("composition add --from-matte on a v2 matte retains the source bytes with the verbatim record", async () => {
  const source = path.join(root, "subject.png");
  await writeFile(source, OPAQUE_SUBJECT);
  const matte = await createMatte(source);
  const sourceHash = sha256(OPAQUE_SUBJECT);
  expect(matte.schemaVersion).toBe(2);
  expect(matte.request.source.contentHash).toBe(sourceHash);
  expect(matte.request.source.file).toBe(`sources/${sourceHash}.png`);
  await makeComp("thumb");

  const res = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", matte.matteId,
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  expect(JSON.parse(res.stdout).ok).toBe(true);

  // The record is retained verbatim — the one retained representation.
  const retainedRecord = path.join(projDir, "matting", matte.matteId, "matte.json");
  expect((await readFile(retainedRecord)).toString())
    .toEqual((await readFile(path.join(matteRoot, matte.matteId, "matte.json"))).toString());

  // The published source bytes are retained beside it, at the same relative
  // path the publication contract names — the copy is the source identity.
  const retainedSource = path.join(projDir, "matting", matte.matteId, `sources/${sourceHash}.png`);
  expect(existsSync(retainedSource)).toBe(true);
  expect((await readFile(retainedSource)).equals(await readFile(path.join(matteRoot, matte.matteId, `sources/${sourceHash}.png`)))).toBe(true);
  expect(sha256(await readFile(retainedSource))).toBe(sourceHash);
});

test("layer edit --from-matte retains the source bytes too", async () => {
  const plain = path.join(root, "plain.png");
  await writeFile(plain, NATIVE_ALPHA_PNG);
  await makeComp("thumb");
  const addRes = await invoke([
    "composition", "add", "thumb", "hero", "--image", plain,
    "--project", projDir, "--json",
  ]);
  expect(addRes.code).toBe(0);
  const layerId = JSON.parse(addRes.stdout).use.layerId;

  const source = path.join(root, "subject.png");
  await writeFile(source, OPAQUE_SUBJECT);
  const matte = await createMatte(source);
  const sourceHash = sha256(OPAQUE_SUBJECT);

  const editRes = await invoke([
    "layer", "edit", layerId, "--from-matte", matte.matteId,
    "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);
  expect(JSON.parse(editRes.stdout).ok).toBe(true);
  const retainedSource = path.join(projDir, "matting", matte.matteId, `sources/${sourceHash}.png`);
  expect(existsSync(retainedSource)).toBe(true);
  expect(sha256(await readFile(retainedSource))).toBe(sourceHash);
});

test("after the original path is deleted and the Project is relocated, the retained bytes rematte to a new id and leave the old record unchanged", async () => {
  const source = path.join(root, "subject.png");
  await writeFile(source, OPAQUE_SUBJECT);
  const matte = await createMatte(source);
  const sourceHash = sha256(OPAQUE_SUBJECT);
  await makeComp("thumb");
  const addRes = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", matte.matteId,
    "--project", projDir, "--json",
  ]);
  expect(addRes.code).toBe(0);

  // The original path and the whole published tree are gone; the Project moves.
  await rm(path.join(root, "out"), { recursive: true, force: true });
  await rm(source, { force: true });
  const moved = path.join(root, "moved");
  await Bun.spawn(["mv", projDir, moved]).exited;

  const retainedSource = path.join(moved, "matting", matte.matteId, `sources/${sourceHash}.png`);
  const recordBefore = await readFile(path.join(moved, "matting", matte.matteId, "matte.json"), "utf8");
  const sourceBefore = await readFile(retainedSource);
  const outputBefore = await readFile(path.join(moved, "content", matte.result.outputs[0]!.contentHash));

  // Remat is ordinary `ply matte` on the retained path into a fresh root — it
  // never consults the deleted original or the deleted published tree. The
  // CLI seam runs with the injected fake engine, so no weights load.
  const rematRoot = path.join(root, "remat-out", "matting");
  const rematRes = await runMatteCli([retainedSource, "--id", "matte-remat-001"], {
    engine: fakeEngine,
    matteRoot: rematRoot,
  });
  expect(rematRes.exitCode).toBe(0);
  const rematJson = rematRes.json as Record<string, any>;
  expect(rematJson.matteId).toBe("matte-remat-001");
  expect(rematJson.matte.request.source.contentHash).toBe(sourceHash);
  expect(rematRes.text).toContain("matte-remat-001");

  // The old record and its retained bytes are unchanged.
  expect(await readFile(path.join(moved, "matting", matte.matteId, "matte.json"), "utf8")).toBe(recordBefore);
  expect((await readFile(retainedSource)).equals(sourceBefore)).toBe(true);
  expect((await readFile(path.join(moved, "content", matte.result.outputs[0]!.contentHash))).equals(outputBefore)).toBe(true);
});

test("native-alpha ingest does not store two identical blobs", async () => {
  const source = path.join(root, "native.png");
  await writeFile(source, NATIVE_ALPHA_PNG);
  const matte = await createMatte(source);
  expect(matte.result.engine).toBe("native-alpha");
  expect(matte.request.source.file).toBeUndefined();
  await makeComp("thumb");

  const res = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", matte.matteId,
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  expect(JSON.parse(res.stdout).ok).toBe(true);

  // The record is retained, but no sources/ copy: the output blob in the
  // content store already is the source's own bytes.
  expect(existsSync(path.join(projDir, "matting", matte.matteId, "matte.json"))).toBe(true);
  expect(existsSync(path.join(projDir, "matting", matte.matteId, "sources"))).toBe(false);
  expect(sha256(await readFile(path.join(projDir, "content", matte.result.outputs[0]!.contentHash)))).toBe(
    matte.request.source.contentHash,
  );
});

test("schemaVersion 1 retained records are unchanged — no source copy is backfilled", async () => {
  // Hand-publish a version 1 record: output bytes plus the record, no sources/.
  const outputBytes = Buffer.from(NATIVE_ALPHA_PNG);
  const outputHash = sha256(outputBytes);
  const v1Id = "matte-v1-legacy";
  const v1Dir = path.join(matteRoot, v1Id, "outputs");
  await Bun.spawn(["mkdir", "-p", v1Dir]).exited;
  await writeFile(path.join(v1Dir, `${outputHash}.png`), outputBytes);
  const v1Record = {
    schemaVersion: 1,
    matteId: v1Id,
    kind: "matting",
    createdAt: "2026-09-08T12:00:00.000Z",
    request: { source: { path: "caller.png", contentHash: "a".repeat(64) } },
    result: {
      engine: "test/segmenter",
      alpha: { width: 16, height: 16, transparentPx: 192, opaquePx: 64 },
      warnings: [],
      outputs: [{ contentHash: outputHash, file: `outputs/${outputHash}.png`, mediaType: "image/png" }],
    },
  };
  await writeFile(path.join(matteRoot, v1Id, "matte.json"), JSON.stringify(v1Record, null, 2) + "\n");
  await makeComp("thumb");

  const res = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", v1Id,
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  expect(JSON.parse(res.stdout).ok).toBe(true);

  // Verbatim record retained; no sources/ invented for a record that names none.
  expect((await readFile(path.join(projDir, "matting", v1Id, "matte.json"), "utf8")))
    .toEqual((await readFile(path.join(matteRoot, v1Id, "matte.json"), "utf8")));
  expect(existsSync(path.join(projDir, "matting", v1Id, "sources"))).toBe(false);
});

test("a version 1 record naming a source copy is refused as contradictory with nothing staged", async () => {
  // A v1 record that carries a v2-only `file` field with a present,
  // hash-matching copy: pre-gate code would stage it as a v1 backfill.
  // Fail-closed refusal must happen before any Project write instead.
  const sourceHash = sha256(OPAQUE_SUBJECT);
  const outputBytes = Buffer.from(NATIVE_ALPHA_PNG);
  const outputHash = sha256(outputBytes);
  const v1Id = "matte-v1-with-file";
  await Bun.spawn(["mkdir", "-p", path.join(matteRoot, v1Id, "outputs"), path.join(matteRoot, v1Id, "sources")]).exited;
  await writeFile(path.join(matteRoot, v1Id, `sources/${sourceHash}.png`), OPAQUE_SUBJECT);
  await writeFile(path.join(matteRoot, v1Id, `outputs/${outputHash}.png`), outputBytes);
  await writeFile(path.join(matteRoot, v1Id, "matte.json"), JSON.stringify({
    schemaVersion: 1,
    matteId: v1Id,
    kind: "matting",
    createdAt: "2026-09-08T12:00:00.000Z",
    request: { source: { path: "caller.png", contentHash: sourceHash, file: `sources/${sourceHash}.png` } },
    result: {
      engine: "test/segmenter",
      alpha: { width: 16, height: 16, transparentPx: 192, opaquePx: 64 },
      warnings: [],
      outputs: [{ contentHash: outputHash, file: `outputs/${outputHash}.png`, mediaType: "image/png" }],
    },
  }, null, 2) + "\n");
  await makeComp("thumb");

  const res = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", v1Id,
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error).toMatch(/contradictory|version 1/i);

  // Fail-closed before any Project write: no record, no source copy, no
  // live Layer reference.
  expect(existsSync(path.join(projDir, "matting", v1Id))).toBe(false);
  expect(JSON.parse(await readFile(path.join(projDir, "compositions", "thumb.json"), "utf8")).layers).toEqual([]);
});

test("ingesting a matte does not rewrite existing Layer bytes or Renders", async () => {
  const plain = path.join(root, "plain.png");
  await writeFile(plain, NATIVE_ALPHA_PNG);
  await makeComp("thumb");
  const addRes = await invoke([
    "composition", "add", "thumb", "base", "--image", plain,
    "--project", projDir, "--json",
  ]);
  expect(addRes.code).toBe(0);
  const renderRes = await invoke([
    "composition", "render", "thumb", "--project", projDir, "--json",
  ]);
  expect(renderRes.code).toBe(0);

  // Snapshot every existing content blob and Render artifact.
  const contentBefore = new Map<string, Buffer>();
  for (const name of await readdir(path.join(projDir, "content"))) {
    contentBefore.set(name, await readFile(path.join(projDir, "content", name)));
  }
  expect(contentBefore.size).toBeGreaterThan(0);
  const rendersBefore = new Map<string, Buffer>();
  for (const name of await readdir(path.join(projDir, "renders"))) {
    rendersBefore.set(name, await readFile(path.join(projDir, "renders", name)));
  }
  expect(rendersBefore.size).toBeGreaterThan(0);

  const source = path.join(root, "subject.png");
  await writeFile(source, OPAQUE_SUBJECT);
  const matte = await createMatte(source);
  const ingestRes = await invoke([
    "composition", "add", "thumb", "hero", "--from-matte", matte.matteId,
    "--project", projDir, "--json",
  ]);
  expect(ingestRes.code).toBe(0);

  // Pre-existing blobs and Render artifacts are byte-identical; the ingest
  // only added new files.
  for (const [name, bytes] of contentBefore) {
    expect((await readFile(path.join(projDir, "content", name))).equals(bytes)).toBe(true);
  }
  for (const [name, bytes] of rendersBefore) {
    expect((await readFile(path.join(projDir, "renders", name))).equals(bytes)).toBe(true);
  }
});
