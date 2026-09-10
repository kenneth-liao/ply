/**
 * Resize Layers without replacing source content (#133, spec #132 US-001 /
 * US-006, DEC-002/003/005, ADR-0016).
 *
 * Verifies through the public CLI seam:
 * - Image and text Layers resize locally; `--resize` is a relative factor and
 *   every result reports the absolute effective size and scale.
 * - Resizing changes placement, never retained pixels: contentHash, retained
 *   bytes, and generation/Matting lineage stay unchanged across repeated
 *   resizes.
 * - Documented aspect-ratio behavior: `--resize-to <WxH>` (deliberate aspect
 *   change), `--resize-to <W>x` / `<x>H` (aspect preserved from intrinsic
 *   size); `--resize-to` is refused on text Layers.
 * - Invalid or conflicting resize inputs leave live state unchanged.
 * - Resize metadata survives sharing, forks, and cross-Project import.
 * - Older revisions retain their original hash/paint meaning; resize
 *   revisions participate in pinned Render history with same-environment
 *   replay.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { encodePngRgba, decodePng } from "../src/png.js";
import { computeRevisionHash, type LayerImageRevision } from "../src/layer.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

async function invoke(args: string[], cwd?: string) {
  const result = Bun.spawn([process.execPath, cli, ...args], {
    cwd: cwd ?? path.resolve(import.meta.dir, ".."),
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

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgba[0]!;
    buf[i + 1] = rgba[1]!;
    buf[i + 2] = rgba[2]!;
    buf[i + 3] = rgba[3]!;
  }
  return encodePngRgba(width, height, buf);
}

const RED: [number, number, number, number] = [255, 0, 0, 255];
const GREEN: [number, number, number, number] = [0, 255, 0, 255];

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-resize-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "resize-test-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComp(name: string, width = 400, height = 300) {
  const res = await invoke([
    "composition", "create", name, "--width", String(width), "--height", String(height), "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
}

async function addImageLayer(comp: string, localName: string, imgFile: string, opts: { x?: number; y?: number; opacity?: number } = {}) {
  const args = ["composition", "add", comp, localName, "--image", imgFile, "--project", projDir, "--json"];
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  if (opts.opacity !== undefined) args.push("--opacity", String(opts.opacity));
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

/** Tracer 1: image resize by relative factor keeps retained pixels identical. */
test("image Layer --resize advances revision, keeps content bytes, and reports absolute effective size", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 500, 400);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;
  const contentHash = addRes.layer.currentRevision.contentHash as string;

  const editRes = await invoke([
    "layer", "edit", layerId, "--resize", "2", "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.ok).toBe(true);
  expect(editJson.layer.currentRevisionId).not.toBe(oldRevId);

  // Same content identity, new placement fact: scale, normalized.
  const rev = editJson.layer.currentRevision;
  expect(rev.contentHash).toBe(contentHash);
  expect(rev.width).toBe(100);
  expect(rev.height).toBe(60);
  expect(rev.scaleX).toBe(2);
  expect(rev.scaleY).toBe(2);

  // Auditable absolute effective size and scale in JSON output.
  expect(editJson.resized).toEqual({ scaleX: 2, scaleY: 2, width: 200, height: 120 });

  // Relative factor: a second identical resize doubles again.
  const edit2Res = await invoke([
    "layer", "edit", layerId, "--resize", "2", "--project", projDir, "--json",
  ]);
  expect(edit2Res.code).toBe(0);
  const edit2 = JSON.parse(edit2Res.stdout);
  expect(edit2.layer.currentRevision.scaleX).toBe(4);
  expect(edit2.resized).toEqual({ scaleX: 4, scaleY: 4, width: 400, height: 240 });

  // Retained bytes are byte-identical after repeated resizes; no new blobs.
  const blob = await readFile(path.join(projDir, "content", contentHash));
  expect(createHash("sha256").update(blob).digest("hex")).toBe(contentHash);
  const contentFiles = await readdir(path.join(projDir, "content"));
  expect(contentFiles.filter((f) => f !== contentHash)).toEqual([]);

  // Compact text output reports the absolute effective size and scale.
  // Relative semantics: 4 × 0.125 = 0.5 absolute.
  const textRes = await invoke(["layer", "edit", layerId, "--resize", "0.125", "--project", projDir]);
  expect(textRes.code).toBe(0);
  expect(textRes.stdout).toContain("scale 0.5×");
  expect(textRes.stdout).toContain("50×30");
});

/** Tracer 2a: absolute size targets normalize to scale at the command boundary. */
test("image Layer --resize-to normalizes to scale with documented aspect-ratio behavior", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 600, 500);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;

  // One axis: aspect preserved from intrinsic size (100×60).
  const widthOnly = await invoke(["layer", "edit", layerId, "--resize-to", "200x", "--project", projDir, "--json"]);
  expect(widthOnly.code).toBe(0);
  const widthJson = JSON.parse(widthOnly.stdout);
  expect(widthJson.resized).toEqual({ scaleX: 2, scaleY: 2, width: 200, height: 120 });

  // Height axis only: also aspect preserved.
  const heightOnly = await invoke(["layer", "edit", layerId, "--resize-to", "x240", "--project", projDir, "--json"]);
  expect(heightOnly.code).toBe(0);
  expect(JSON.parse(heightOnly.stdout).resized).toEqual({ scaleX: 4, scaleY: 4, width: 400, height: 240 });

  // Both axes: deliberate aspect change (100×60 → 500×150).
  const both = await invoke(["layer", "edit", layerId, "--resize-to", "500x150", "--project", projDir, "--json"]);
  expect(both.code).toBe(0);
  const bothJson = JSON.parse(both.stdout);
  expect(bothJson.resized).toEqual({ scaleX: 5, scaleY: 2.5, width: 500, height: 150 });
  expect(bothJson.layer.currentRevision.scaleX).toBe(5);
  expect(bothJson.layer.currentRevision.scaleY).toBe(2.5);

  // --resize-to sets absolute effective size: repeating it is idempotent.
  const repeat = await invoke(["layer", "edit", layerId, "--resize-to", "500x150", "--project", projDir, "--json"]);
  expect(repeat.code).toBe(0);
  const repeatJson = JSON.parse(repeat.stdout);
  expect(repeatJson.layer.currentRevisionId).toBe(bothJson.layer.currentRevisionId);
  expect(repeatJson.resized).toEqual({ scaleX: 5, scaleY: 2.5, width: 500, height: 150 });

  // Inspect reports the effective scale and size for auditability.
  const inspectRes = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(inspectRes.code).toBe(0);
  expect(inspectRes.stdout).toContain("Scale: 5×/2.5× (effective 500×150)");
});

/** Tracer 2b: the scaled Layer paints at its effective size from unchanged bytes. */
test("resized image Layer paints scaled pixels from unchanged retained bytes", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));
  const out = path.join(tempDir, "render.png");

  await makeComp("poster", 400, 400);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;

  const editRes = await invoke(["layer", "edit", layerId, "--resize", "2", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(0);

  const renderRes = await invoke(["composition", "render", "poster", "--project", projDir, "--out", out, "--json"]);
  expect(renderRes.code).toBe(0);
  const png = decodePng(await readFile(out));
  expect(png.width).toBe(400);
  expect(png.height).toBe(400);
  // 100×60 at (10,10) scaled 2×: red through (209, 129), transparent beyond.
  expect(pixel(png, 200, 120)).toEqual([255, 0, 0, 255]);
  expect(pixel(png, 209, 129)).toEqual([255, 0, 0, 255]);
  expect(pixel(png, 215, 135)[3]).toBe(0);
  expect(pixel(png, 5, 5)[3]).toBe(0);
});

/** Tracer 3: text Layers resize by relative factor only, from unchanged font bytes. */
test("text Layer resizes by factor, refuses --resize-to, and keeps retained font bytes", async () => {
  await makeComp("doc", 500, 400);
  const addRes = await addTextLayer("doc", "heading", "Hello", { font: "Anton", fontSize: 40, x: 20, y: 20 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;
  const fontHash = addRes.layer.currentRevision.contentHash as string;

  // --resize-to is refused on text Layers; live state unchanged.
  const refused = await invoke(["layer", "edit", layerId, "--resize-to", "200x100", "--project", projDir, "--json"]);
  expect(refused.code).toBe(1);
  const refusedJson = JSON.parse(refused.stdout);
  expect(refusedJson.ok).toBe(false);
  expect(refusedJson.error).toContain("text Layer");
  expect(refusedJson.error).toContain("--resize");
  const afterRefused = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(JSON.parse(afterRefused.stdout).layer.currentRevisionId).toBe(oldRevId);

  // The scaled text paints larger from the same retained font bytes: compare
  // opaque coverage against a scale-1 render captured before the resize.
  const baseline = path.join(tempDir, "text-baseline.png");
  const baselineRes = await invoke(["composition", "render", "doc", "--project", projDir, "--out", baseline, "--json"]);
  expect(baselineRes.code).toBe(0);
  const baselinePng = decodePng(await readFile(baseline));
  let baselinePixels = 0;
  for (let i = 3; i < baselinePng.rgba.length; i += 4) {
    if (baselinePng.rgba[i]! > 0) baselinePixels++;
  }

  // Relative factor works on text: scale reported absolutely.
  const editRes = await invoke(["layer", "edit", layerId, "--resize", "2", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.resized).toEqual({ scaleX: 2, scaleY: 2 });
  expect(editJson.layer.currentRevision.scaleX).toBe(2);
  expect(editJson.layer.currentRevision.contentHash).toBe(fontHash);

  // The scaled text paints larger from the same retained font bytes.
  const out = path.join(tempDir, "text-render.png");
  const renderRes = await invoke(["composition", "render", "doc", "--project", projDir, "--out", out, "--json"]);
  expect(renderRes.code).toBe(0);
  const png = decodePng(await readFile(out));
  let opaquePixels = 0;
  for (let i = 3; i < png.rgba.length; i += 4) {
    if (png.rgba[i]! > 0) opaquePixels++;
  }
  expect(opaquePixels).toBeGreaterThan(baselinePixels);
});

/** Tracer 4: invalid or conflicting resize inputs fail before any staging and
 * leave live state — identity pointer, revision, and retained bytes — unchanged. */
test("invalid or conflicting resize inputs leave live state unchanged", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));
  const greenImg = path.join(tempDir, "green.png");
  await writeFile(greenImg, solidPng(70, 70, GREEN));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;
  const contentHash = addRes.layer.currentRevision.contentHash as string;

  async function expectUnchanged(refusal: { code: number; stdout: string }, mustContain: string) {
    expect(refusal.code).toBe(1);
    const json = JSON.parse(refusal.stdout);
    expect(json.ok).toBe(false);
    expect(json.error).toContain(mustContain);
    const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
    const layer = JSON.parse(inspect.stdout).layer;
    expect(layer.currentRevisionId).toBe(oldRevId);
    expect(layer.currentRevision.contentHash).toBe(contentHash);
  }

  // Conflicting resize forms and content replacement are refused (exit 1,
  // before any staging).
  await expectUnchanged(
    await invoke(["layer", "edit", layerId, "--resize", "2", "--image", greenImg, "--project", projDir, "--json"]),
    "separate edits",
  );
  // Over-cap effective size is refused.
  await expectUnchanged(
    await invoke(["layer", "edit", layerId, "--resize-to", "9000x", "--project", projDir, "--json"]),
    "8192",
  );
  await expectUnchanged(
    await invoke(["layer", "edit", layerId, "--resize", "10000", "--project", projDir, "--json"]),
    "8192",
  );

  // Malformed flag syntax is a usage error (exit 2); live state unchanged.
  // "0x"/"x0" are well-formed but semantically invalid — refused by the edit
  // path (exit 1) with live state unchanged, like the other semantic refusals.
  for (const bad of ["0", "-2", "abc", ""]) {
    const res = await invoke(["layer", "edit", layerId, "--resize", bad, "--project", projDir, "--json"]);
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout).ok).toBe(false);
  }
  for (const bad of ["x", "", "200", "axb", "200.5.1x30"]) {
    const res = await invoke(["layer", "edit", layerId, "--resize-to", bad, "--project", projDir, "--json"]);
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout).ok).toBe(false);
  }
  await expectUnchanged(
    await invoke(["layer", "edit", layerId, "--resize-to", "0x", "--project", projDir, "--json"]),
    "Invalid resize target",
  );
  const bothForms = await invoke(["layer", "edit", layerId, "--resize", "2", "--resize-to", "300x", "--project", projDir, "--json"]);
  expect(bothForms.code).toBe(2);

  // No content blob was staged by any refused edit.
  const contentFiles = await readdir(path.join(projDir, "content"));
  expect(contentFiles).toEqual([contentHash]);
});

/** Tracer 4b: malformed stored scale fields fail loudly at the revision reader. */
test("malformed stored transform scale is refused loudly", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));

  await makeComp("poster", 200, 200);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 5, y: 5 });
  const layerId = addRes.use.layerId as string;
  const revId = addRes.layer.currentRevisionId as string;
  const revFile = path.join(projDir, "layers", `${layerId}.revisions`, `${revId}.json`);

  const original = JSON.parse(await readFile(revFile, "utf8"));
  expect(original.scaleX).toBe(1);
  expect(original.scaleY).toBe(1);

  // Partial presence is malformed.
  delete original.scaleY;
  await writeFile(revFile, JSON.stringify(original));
  const partial = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(partial.code).toBe(1);
  expect(JSON.parse(partial.stdout).error).toContain("scaleX and scaleY must be present together");

  // A non-positive scale is malformed.
  const withScale = JSON.parse(await readFile(revFile, "utf8")) as Record<string, unknown>;
  withScale.scaleY = 1;
  withScale.scaleX = 0;
  await writeFile(revFile, JSON.stringify(withScale));
  const nonPositive = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(nonPositive.code).toBe(1);
  expect(JSON.parse(nonPositive.stdout).error).toContain("finite numbers greater than 0");

  // A present null is malformed, never a silent default (CRAFT-1).
  const withNull = JSON.parse(await readFile(revFile, "utf8")) as Record<string, unknown>;
  withNull.scaleX = 1;
  withNull.scaleY = null;
  await writeFile(revFile, JSON.stringify(withNull));
  const nullScale = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(nullScale.code).toBe(1);
  expect(JSON.parse(nullScale.stdout).error).toContain("finite numbers greater than 0");
});

/** Tracer 4c: a genuinely pre-#133 revision document — both scale fields
 * absent — keeps its original hash meaning: it still hash-verifies, resolves
 * at scale 1, and paints identically (#133 criterion 4). */
test("pre-resize revision documents without scale fields keep their hash and paint meaning", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(80, 40, RED));
  const outBefore = path.join(tempDir, "before-legacy.png");

  await makeComp("poster", 300, 200);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 5, y: 5 });
  const layerId = addRes.use.layerId as string;
  const revId = addRes.layer.currentRevisionId as string;

  const renderBefore = await invoke(["composition", "render", "poster", "--project", projDir, "--out", outBefore, "--json"]);
  expect(renderBefore.code).toBe(0);

  // Hand-write the stored document into the exact pre-#133 shape: no scale
  // fields, pinned by the id the pre-#133 hash algorithm derives from it
  // (computeRevisionHash appends nothing for field-absent docs).
  const revFile = path.join(projDir, "layers", `${layerId}.revisions`, `${revId}.json`);
  const legacyDoc = JSON.parse(await readFile(revFile, "utf8")) as Record<string, unknown>;
  delete legacyDoc.scaleX;
  delete legacyDoc.scaleY;
  const legacyId = computeRevisionHash(legacyDoc as unknown as LayerImageRevision);
  const legacyFile = path.join(projDir, "layers", `${layerId}.revisions`, `${legacyId}.json`);
  await writeFile(legacyFile, JSON.stringify(legacyDoc, null, 2) + "\n");
  const identityFile = path.join(projDir, "layers", `${layerId}.json`);
  const identity = JSON.parse(await readFile(identityFile, "utf8")) as Record<string, unknown>;
  identity.currentRevision = legacyId;
  await writeFile(identityFile, JSON.stringify(identity, null, 2) + "\n");

  // The legacy document still hash-verifies at its pre-#133 revision id.
  const inspectRes = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(inspectRes.code).toBe(0);
  const layer = JSON.parse(inspectRes.stdout).layer;
  expect(layer.currentRevisionId).toBe(legacyId);
  expect(layer.currentRevisionId).not.toBe(revId);
  expect(layer.currentRevision.scaleX).toBe(1);
  expect(layer.currentRevision.scaleY).toBe(1);

  // And it paints identically: no transform is emitted for scale 1.
  const outAfter = path.join(tempDir, "after-legacy.png");
  const renderAfter = await invoke(["composition", "render", "poster", "--project", projDir, "--out", outAfter, "--json"]);
  expect(renderAfter.code).toBe(0);
  expect(await readFile(outAfter)).toEqual(await readFile(outBefore));
});

/** Tracer 4d (SPEC-2): a plain non-resize edit after a resize carries the
 * scale forward into the new revision — resize metadata survives ordinary
 * edits instead of being dropped by revision reconstruction. */
test("non-resize edits after a resize preserve the transform scale", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;

  const resizeRes = await invoke(["layer", "edit", layerId, "--resize", "2", "--project", projDir, "--json"]);
  expect(resizeRes.code).toBe(0);

  const moveRes = await invoke(["layer", "edit", layerId, "--x", "50", "--project", projDir, "--json"]);
  expect(moveRes.code).toBe(0);
  const moveJson = JSON.parse(moveRes.stdout);
  expect(moveJson.layer.currentRevision.scaleX).toBe(2);
  expect(moveJson.layer.currentRevision.scaleY).toBe(2);
  expect(moveJson.layer.currentRevision.x).toBe(50);
  // No resize option: no `resized` report on this edit.
  expect(moveJson.resized).toBeUndefined();
});

/** Tracer 5: a no-op resize (factor 1) is no storage churn, and still reports
 * the absolute effective scale and size for auditability. */
test("no-op resize keeps the current revision and still reports effective facts", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;
  const revId = addRes.layer.currentRevisionId as string;

  const res = await invoke(["layer", "edit", layerId, "--resize", "1", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.layer.currentRevisionId).toBe(revId);
  expect(json.resized).toEqual({ scaleX: 1, scaleY: 1, width: 100, height: 60 });
});

/** Tracer 6: resize metadata survives fork publication and cross-Project import. */
test("forked and imported Layers retain their transform scale", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("source", 400, 300);
  const addRes = await addImageLayer("source", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;
  const contentHash = addRes.layer.currentRevision.contentHash as string;

  const editRes = await invoke(["layer", "edit", layerId, "--resize", "2", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(0);
  const scaledRevId = JSON.parse(editRes.stdout).layer.currentRevisionId as string;

  // Fork: the forked Layer carries the scaled revision; the original is untouched.
  await makeComp("forker", 400, 300);
  await invoke(["composition", "import", "forker", "source", "--project", projDir, "--json"]);
  const forkRes = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "forker", "--use", "hero",
    "--resize", "0.5", "--project", projDir, "--json",
  ]);
  expect(forkRes.code).toBe(0);
  const forkJson = JSON.parse(forkRes.stdout);
  expect(forkJson.fork.previousLayerId).toBe(layerId);
  expect(forkJson.resized).toEqual({ scaleX: 1, scaleY: 1, width: 100, height: 60 });
  const forkedId = forkJson.layer.id as string;
  const forkedRev = forkJson.layer.currentRevision;
  expect(forkedRev.scaleX).toBe(1);
  expect(forkedRev.scaleY).toBe(1);
  expect(forkedRev.contentHash).toBe(contentHash);
  // The original Layer is still scaled; the fork's scale is its own revision fact.
  const original = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
  expect(original.layer.currentRevision.scaleX).toBe(2);
  expect(forkedId).not.toBe(layerId);
  expect(forkJson.layer.currentRevisionId).not.toBe(scaledRevId);

  // Cross-Project import: the destination revision preserves scale verbatim.
  const otherProj = path.join(tempDir, "proj2");
  await invoke(["project", "init", otherProj, "--name", "resize-import-proj"]);
  await invoke(["composition", "create", "landing", "--width", "400", "--height", "300", "--project", otherProj, "--json"]);
  const importRes = await invoke([
    "composition", "import", "landing", "source", "--from-project", projDir, "--project", otherProj, "--json",
  ]);
  expect(importRes.code).toBe(0);
  const importedLayerId = JSON.parse(importRes.stdout).importedUses[0].layerId as string;
  const imported = JSON.parse((await invoke(["layer", "inspect", importedLayerId, "--project", otherProj, "--json"])).stdout);
  const importedRev = imported.layer.currentRevision;
  expect(importedRev.scaleX).toBe(2);
  expect(importedRev.scaleY).toBe(2);
  expect(importedRev.contentHash).toBe(contentHash);
  // The copied revision document on disk carries the same canonical fields.
  const copiedDoc = JSON.parse(
    await readFile(path.join(otherProj, "layers", `${importedLayerId}.revisions`, `${imported.layer.currentRevisionId}.json`), "utf8"),
  );
  expect(copiedDoc.scaleX).toBe(2);
  expect(copiedDoc.scaleY).toBe(2);
});

/** Tracer 7: older revisions keep their original hash/paint meaning; resize
 * revisions participate in pinned Render history with same-environment replay. */
test("render history stays pinned across resizes: pre-resize replay is byte-identical", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;

  const firstOut = path.join(tempDir, "first.png");
  const firstRender = await invoke(["composition", "render", "poster", "--project", projDir, "--out", firstOut, "--json"]);
  expect(firstRender.code).toBe(0);
  const firstManifest = JSON.parse(firstRender.stdout).render.manifest as string;

  // Resize in place AFTER the render: the pinned history must not change.
  const editRes = await invoke(["layer", "edit", layerId, "--resize", "2", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(0);

  const replayOut = path.join(tempDir, "replay.png");
  const replayRes = await invoke([
    "composition", "replay", firstManifest, "--project", projDir, "--out", replayOut, "--json",
  ]);
  expect(replayRes.code).toBe(0);
  expect(await readFile(replayOut)).toEqual(await readFile(firstOut));

  // A fresh render of current state pins the resized revision; replaying it
  // from the pinned revision document is byte-identical within the same
  // environment (resize revisions participate in history like any other).
  const secondOut = path.join(tempDir, "second.png");
  const secondRender = await invoke(["composition", "render", "poster", "--project", projDir, "--out", secondOut, "--json"]);
  expect(secondRender.code).toBe(0);
  const secondManifest = JSON.parse(secondRender.stdout).render.manifest as string;
  const secondReplay = path.join(tempDir, "replay2.png");
  const secondReplayRes = await invoke([
    "composition", "replay", secondManifest, "--project", projDir, "--out", secondReplay, "--json",
  ]);
  expect(secondReplayRes.code).toBe(0);
  expect(await readFile(secondReplay)).toEqual(await readFile(secondOut));
  // The scaled render differs from the pre-resize one (placement changed).
  expect(await readFile(secondOut)).not.toEqual(await readFile(firstOut));
});

async function addTextLayer(comp: string, localName: string, text: string, opts: { font?: string; fontSize?: number; color?: string; x?: number; y?: number; opacity?: number } = {}) {
  const args = ["composition", "add", comp, localName, "--text", text, "--font", opts.font ?? "Anton", "--project", projDir, "--json"];
  if (opts.fontSize !== undefined) args.push("--font-size", String(opts.fontSize));
  if (opts.color !== undefined) args.push("--color", opts.color);
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  if (opts.opacity !== undefined) args.push("--opacity", String(opts.opacity));
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

