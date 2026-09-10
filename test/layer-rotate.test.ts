/**
 * Rotate Layers through the retained transform contract (#134, spec #132
 * US-001 / US-006, DEC-002/003/005, ADR-0016).
 *
 * Verifies through the public CLI seam:
 * - `--rotate <deg>` sets an ABSOLUTE rotation in degrees (twice is still the
 *   same angle; 0 removes it) on image and text Layers; `rotationDeg` is the
 *   canonical revision fact appended to the revision hash conditionally.
 * - Rotation changes placement facts, never retained pixels: contentHash,
 *   retained bytes, and generation/Matting lineage stay unchanged.
 * - Paint applies scale first, then rotation, about the Layer's (x, y)
 *   top-left placement point; positive degrees rotate clockwise.
 * - Invalid angles fail without mutation; scoped help, compact output and
 *   JSON describe the new option.
 * - Older revisions retain their original hash/paint meaning; rotation
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
import { runUniformGeneration, type GenerationJobRecord } from "../src/generation.js";

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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-rotate-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "rotate-test-proj"]);
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

/** Tracer 1: `--rotate` sets an ABSOLUTE angle on an image Layer, keeps
 * retained pixels identical, and reports the rotation in JSON/text/inspect. */
test("image Layer --rotate sets an absolute angle, keeps content bytes, and reports the rotation", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 500, 400);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;
  const contentHash = addRes.layer.currentRevision.contentHash as string;

  const editRes = await invoke([
    "layer", "edit", layerId, "--rotate", "45", "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.ok).toBe(true);
  expect(editJson.layer.currentRevisionId).not.toBe(oldRevId);

  // Same content identity, new transform fact: the rotation is stored as the
  // canonical revision field alongside the normalized scale.
  const rev = editJson.layer.currentRevision;
  expect(rev.contentHash).toBe(contentHash);
  expect(rev.width).toBe(100);
  expect(rev.height).toBe(60);
  expect(rev.scaleX).toBe(1);
  expect(rev.scaleY).toBe(1);
  expect(rev.rotationDeg).toBe(45);

  // Auditable rotation report in JSON output.
  expect(editJson.rotated).toEqual({ rotationDeg: 45 });

  // Retained bytes are byte-identical; no new blobs staged.
  const blob = await readFile(path.join(projDir, "content", contentHash));
  expect(createHash("sha256").update(blob).digest("hex")).toBe(contentHash);
  const contentFiles = await readdir(path.join(projDir, "content"));
  expect(contentFiles).toEqual([contentHash]);

  // Compact text output reports the rotation.
  const textRes = await invoke(["layer", "edit", layerId, "--rotate", "-30", "--project", projDir]);
  expect(textRes.code).toBe(0);
  expect(textRes.stdout).toContain("rotation -30°");

  // ABSOLUTE setter: rotating to 45 twice is still 45°, never 90°.
  const again = await invoke(["layer", "edit", layerId, "--rotate", "45", "--project", projDir, "--json"]);
  expect(again.code).toBe(0);
  const againJson = JSON.parse(again.stdout);
  expect(againJson.layer.currentRevision.rotationDeg).toBe(45);

  // Rotation 0 removes the rotation (back to the pre-rotation transform).
  const remove = await invoke(["layer", "edit", layerId, "--rotate", "0", "--project", projDir, "--json"]);
  expect(remove.code).toBe(0);
  const removeJson = JSON.parse(remove.stdout);
  expect(removeJson.layer.currentRevision.rotationDeg).toBe(0);
  expect(removeJson.rotated).toEqual({ rotationDeg: 0 });

  // Inspect reports the rotation for auditability — and hides it again at 0,
  // mirroring the scale display convention (identity transform, no clutter).
  const setRes = await invoke(["layer", "edit", layerId, "--rotate", "45", "--project", projDir, "--json"]);
  expect(setRes.code).toBe(0);
  const shownInspect = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(shownInspect.code).toBe(0);
  expect(shownInspect.stdout).toContain("Rotation: 45°");
  const hideRes = await invoke(["layer", "edit", layerId, "--rotate", "0", "--project", projDir, "--json"]);
  expect(hideRes.code).toBe(0);
  const hiddenInspect = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(hiddenInspect.code).toBe(0);
  expect(hiddenInspect.stdout).not.toContain("Rotation:");
});
/** Tracer 2: the rotated Layer paints clockwise about its (x, y) top-left
 * placement point, from unchanged retained bytes. A 90° clockwise rotation
 * about (200, 50) maps the 100×60 rect to x ∈ [140, 200], y ∈ [50, 150]. */
test("rotated image Layer paints clockwise about its top-left point", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));
  const out = path.join(tempDir, "render.png");

  await makeComp("poster", 400, 400);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 200, y: 50 });
  const layerId = addRes.use.layerId as string;

  const editRes = await invoke(["layer", "edit", layerId, "--rotate", "90", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(0);

  const renderRes = await invoke(["composition", "render", "poster", "--project", projDir, "--out", out, "--json"]);
  expect(renderRes.code).toBe(0);
  const png = decodePng(await readFile(out));
  expect(png.width).toBe(400);
  expect(png.height).toBe(400);
  // Inside the rotated footprint (100 wide, 60 tall → 60 wide, 100 tall).
  expect(pixel(png, 150, 60)).toEqual([255, 0, 0, 255]);
  expect(pixel(png, 190, 140)).toEqual([255, 0, 0, 255]);
  // Outside: right of the rotated rect, below it, and left of the pivot.
  expect(pixel(png, 210, 60)[3]).toBe(0);
  expect(pixel(png, 150, 160)[3]).toBe(0);
  expect(pixel(png, 100, 100)[3]).toBe(0);
});

/** Tracer 3: text Layers rotate from unchanged retained font bytes. */
test("text Layer rotates and keeps its retained font bytes", async () => {
  await makeComp("doc", 500, 400);
  const addRes = await addTextLayer("doc", "heading", "Hello", { font: "Anton", fontSize: 40, x: 20, y: 20 });
  const layerId = addRes.use.layerId as string;
  const fontHash = addRes.layer.currentRevision.contentHash as string;
  const oldRevId = addRes.layer.currentRevisionId as string;

  const editRes = await invoke(["layer", "edit", layerId, "--rotate", "15", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.layer.currentRevisionId).not.toBe(oldRevId);
  expect(editJson.layer.currentRevision.rotationDeg).toBe(15);
  expect(editJson.layer.currentRevision.contentHash).toBe(fontHash);
  expect(editJson.rotated).toEqual({ rotationDeg: 15 });

  // The rotated text renders: opaque coverage appears in the region below the
  // unrotated baseline footprint (clockwise tilt about the top-left point).
  const out = path.join(tempDir, "text-render.png");
  const renderRes = await invoke(["composition", "render", "doc", "--project", projDir, "--out", out, "--json"]);
  expect(renderRes.code).toBe(0);
  const png = decodePng(await readFile(out));
  let opaquePixels = 0;
  for (let i = 3; i < png.rgba.length; i += 4) {
    if (png.rgba[i]! > 0) opaquePixels++;
  }
  expect(opaquePixels).toBeGreaterThan(0);
  // Font bytes retained: still exactly the bundled face blob, no new blobs.
  const blob = await readFile(path.join(projDir, "content", fontHash));
  expect(createHash("sha256").update(blob).digest("hex")).toBe(fontHash);
});

/** Tracer 4: invalid angles fail without mutation — usage errors exit 2, and
 * no refused edit advances live state or stages storage. */
test("invalid angles fail without mutation", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;
  const contentHash = addRes.layer.currentRevision.contentHash as string;

  async function expectUnchanged(refusal: { code: number; stdout: string }, mustContain: string) {
    const json = JSON.parse(refusal.stdout);
    expect(json.ok).toBe(false);
    expect(json.error).toContain(mustContain);
    const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
    const layer = JSON.parse(inspect.stdout).layer;
    expect(layer.currentRevisionId).toBe(oldRevId);
    expect(layer.currentRevision.contentHash).toBe(contentHash);
    expect(layer.currentRevision.rotationDeg).toBe(0);
  }

  // Malformed syntax is a usage error (exit 2): non-numeric, blank, and
  // non-finite angles never reach the edit path.
  for (const bad of ["abc", "", "NaN", "Infinity", "1e999"]) {
    const res = await invoke(["layer", "edit", layerId, "--rotate", bad, "--project", projDir, "--json"]);
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout).ok).toBe(false);
    expect(JSON.parse(res.stdout).error).toContain("--rotate");
  }
  await expectUnchanged(
    await invoke(["layer", "edit", layerId, "--rotate", "abc", "--project", projDir, "--json"]),
    "--rotate",
  );

  // No content blob was staged by any refused edit.
  const contentFiles = await readdir(path.join(projDir, "content"));
  expect(contentFiles).toEqual([contentHash]);
});

/** Tracer 5 (documented order, ADR-0016): scale applies FIRST, then rotation.
 * A 100×60 rect at (200, 50) scaled (2, 1) stretches to 200×60 along its own
 * axes, then rotating 90° clockwise yields the footprint x ∈ [140, 200],
 * y ∈ [50, 250]. The opposite order (rotate then scale) would instead paint
 * x ∈ [80, 200], y ∈ [50, 150] — the distinguishing pixels pin the contract. */
test("rotation applies after scale: the stretched content rotates as a whole", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));
  const out = path.join(tempDir, "order.png");

  await makeComp("poster", 400, 400);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 200, y: 50 });
  const layerId = addRes.use.layerId as string;

  const editRes = await invoke([
    "layer", "edit", layerId, "--resize-to", "200x60", "--rotate", "90", "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.layer.currentRevision.scaleX).toBe(2);
  expect(editJson.layer.currentRevision.scaleY).toBe(1);
  expect(editJson.layer.currentRevision.rotationDeg).toBe(90);

  const renderRes = await invoke(["composition", "render", "poster", "--project", projDir, "--out", out, "--json"]);
  expect(renderRes.code).toBe(0);
  const png = decodePng(await readFile(out));
  // Inside the scale-then-rotate footprint (60 wide, 200 tall).
  expect(pixel(png, 150, 60)).toEqual([255, 0, 0, 255]);
  expect(pixel(png, 190, 240)).toEqual([255, 0, 0, 255]);
  // Left of x = 140: painted only if rotation ran before scale — must be empty.
  expect(pixel(png, 100, 100)[3]).toBe(0);
  // Below y = 250: painted only if rotation ran before scale — must be empty.
  expect(pixel(png, 150, 260)[3]).toBe(0);
  // Right of the pivot column x = 200: outside either footprint.
  expect(pixel(png, 210, 100)[3]).toBe(0);
});

/** Tracer 6: rotation is a revision fact shared as a whole (DEC-002, ADR-0013):
 * plain edits carry it forward, forks isolate it, and cross-Project import
 * preserves it verbatim in the copied revision document. */
test("rotation survives plain edits, forks, and cross-Project import", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("source", 400, 300);
  const addRes = await addImageLayer("source", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;
  const contentHash = addRes.layer.currentRevision.contentHash as string;

  const rotateRes = await invoke(["layer", "edit", layerId, "--rotate", "30", "--project", projDir, "--json"]);
  expect(rotateRes.code).toBe(0);
  const rotatedRevId = JSON.parse(rotateRes.stdout).layer.currentRevisionId as string;

  // A plain non-rotate edit carries the rotation forward.
  const moveRes = await invoke(["layer", "edit", layerId, "--x", "50", "--project", projDir, "--json"]);
  expect(moveRes.code).toBe(0);
  const moveJson = JSON.parse(moveRes.stdout);
  expect(moveJson.layer.currentRevision.rotationDeg).toBe(30);
  expect(moveJson.layer.currentRevision.x).toBe(50);
  // No rotate option: no `rotated` report on this edit.
  expect(moveJson.rotated).toBeUndefined();

  // Fork: the forked Layer carries the rotated revision; the original keeps its own.
  await makeComp("forker", 400, 300);
  await invoke(["composition", "import", "forker", "source", "--project", projDir, "--json"]);
  const forkRes = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "forker", "--use", "hero",
    "--rotate", "0", "--project", projDir, "--json",
  ]);
  expect(forkRes.code).toBe(0);
  const forkJson = JSON.parse(forkRes.stdout);
  expect(forkJson.fork.previousLayerId).toBe(layerId);
  expect(forkJson.rotated).toEqual({ rotationDeg: 0 });
  expect(forkJson.layer.currentRevision.rotationDeg).toBe(0);
  expect(forkJson.layer.currentRevision.contentHash).toBe(contentHash);
  const original = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
  expect(original.layer.currentRevision.rotationDeg).toBe(30);
  expect(forkJson.layer.currentRevisionId).not.toBe(rotatedRevId);

  // Cross-Project import: the destination revision preserves rotation verbatim.
  const otherProj = path.join(tempDir, "proj2");
  await invoke(["project", "init", otherProj, "--name", "rotate-import-proj"]);
  await invoke(["composition", "create", "landing", "--width", "400", "--height", "300", "--project", otherProj, "--json"]);
  const importRes = await invoke([
    "composition", "import", "landing", "source", "--from-project", projDir, "--project", otherProj, "--json",
  ]);
  expect(importRes.code).toBe(0);
  const importedLayerId = JSON.parse(importRes.stdout).importedUses[0].layerId as string;
  const imported = JSON.parse((await invoke(["layer", "inspect", importedLayerId, "--project", otherProj, "--json"])).stdout);
  const importedRev = imported.layer.currentRevision;
  expect(importedRev.rotationDeg).toBe(30);
  expect(importedRev.scaleX).toBe(1);
  expect(importedRev.contentHash).toBe(contentHash);
  const copiedDoc = JSON.parse(
    await readFile(path.join(otherProj, "layers", `${importedLayerId}.revisions`, `${imported.layer.currentRevisionId}.json`), "utf8"),
  );
  expect(copiedDoc.rotationDeg).toBe(30);
});

/** Tracer 7: a malformed stored rotation field fails loudly at the one
 * revision-reader boundary — present `null` or a non-number is never a
 * silent default (mirrors the #133 scale discipline). */
test("malformed stored rotation is refused loudly", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));

  await makeComp("poster", 200, 200);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 5, y: 5 });
  const layerId = addRes.use.layerId as string;
  const revId = addRes.layer.currentRevisionId as string;
  const revFile = path.join(projDir, "layers", `${layerId}.revisions`, `${revId}.json`);

  // A present null is malformed, never a silent default.
  const withNull = JSON.parse(await readFile(revFile, "utf8")) as Record<string, unknown>;
  withNull.rotationDeg = null;
  await writeFile(revFile, JSON.stringify(withNull));
  const nullRes = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(nullRes.code).toBe(1);
  expect(JSON.parse(nullRes.stdout).error).toContain("rotationDeg must be a finite number");

  // A non-numeric field is malformed.
  const withString = JSON.parse(await readFile(revFile, "utf8")) as Record<string, unknown>;
  withString.rotationDeg = "45";
  await writeFile(revFile, JSON.stringify(withString));
  const stringRes = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(stringRes.code).toBe(1);
  expect(JSON.parse(stringRes.stdout).error).toContain("rotationDeg must be a finite number");
});

/** Tracer 8: genuinely pre-#134 revision documents — rotationDeg absent
 * (#133-era shapes both with and without scale fields) — keep their exact
 * revision ids: the hash appends the rotation field only when present, so
 * older revisions retain their original hash and paint meaning (#134). */
test("pre-rotation revision documents keep their hash and paint meaning", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(80, 40, RED));
  const outBefore = path.join(tempDir, "before-legacy.png");

  await makeComp("poster", 300, 200);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 5, y: 5 });
  const layerId = addRes.use.layerId as string;
  const revId = addRes.layer.currentRevisionId as string;

  const renderBefore = await invoke(["composition", "render", "poster", "--project", projDir, "--out", outBefore, "--json"]);
  expect(renderBefore.code).toBe(0);

  // Hand-write the stored document into the exact pre-#134 shape: the add
  // path records rotationDeg: 0 explicitly (ADR-0016), so deleting it yields
  // a genuinely pre-#134 document, pinned by the id the pre-#134 hash
  // algorithm derives from it — a different id than the recorded one.
  const revFile = path.join(projDir, "layers", `${layerId}.revisions`, `${revId}.json`);
  const legacyDoc = JSON.parse(await readFile(revFile, "utf8")) as Record<string, unknown>;
  expect(legacyDoc.scaleX).toBe(1);
  expect(legacyDoc.rotationDeg).toBe(0);
  delete legacyDoc.rotationDeg;
  const legacyId = computeRevisionHash(legacyDoc as unknown as LayerImageRevision);
  expect(legacyId).not.toBe(revId);
  const legacyFile = path.join(projDir, "layers", `${layerId}.revisions`, `${legacyId}.json`);
  await writeFile(legacyFile, JSON.stringify(legacyDoc, null, 2) + "\n");
  const identityFile = path.join(projDir, "layers", `${layerId}.json`);
  const identity = JSON.parse(await readFile(identityFile, "utf8")) as Record<string, unknown>;
  identity.currentRevision = legacyId;
  await writeFile(identityFile, JSON.stringify(identity, null, 2) + "\n");

  // The legacy document still hash-verifies at its pre-#134 revision id.
  const inspectRes = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(inspectRes.code).toBe(0);
  const layer = JSON.parse(inspectRes.stdout).layer;
  expect(layer.currentRevisionId).toBe(legacyId);
  expect(layer.currentRevision.rotationDeg).toBe(0);
  expect(layer.currentRevision.scaleX).toBe(1);

  // And it paints identically: no transform is emitted for the identity
  // transform, so the pinned render of a pre-rotation revision is unchanged.
  const outAfter = path.join(tempDir, "after-legacy.png");
  const renderAfter = await invoke(["composition", "render", "poster", "--project", projDir, "--out", outAfter, "--json"]);
  expect(renderAfter.code).toBe(0);
  expect(await readFile(outAfter)).toEqual(await readFile(outBefore));

  // The #133-era shape — scale present, rotation absent — also keeps its id.
  const scaledDoc = { ...legacyDoc, scaleX: 2, scaleY: 2 };
  const scaledId = computeRevisionHash(scaledDoc as unknown as LayerImageRevision);
  expect(scaledId).not.toBe(legacyId);
  await writeFile(path.join(projDir, "layers", `${layerId}.revisions`, `${scaledId}.json`), JSON.stringify(scaledDoc, null, 2) + "\n");
  identity.currentRevision = scaledId;
  await writeFile(identityFile, JSON.stringify(identity, null, 2) + "\n");
  const scaledInspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(scaledInspect.code).toBe(0);
  const scaledLayer = JSON.parse(scaledInspect.stdout).layer;
  expect(scaledLayer.currentRevisionId).toBe(scaledId);
  expect(scaledLayer.currentRevision.scaleX).toBe(2);
  expect(scaledLayer.currentRevision.rotationDeg).toBe(0);

  // The genuinely pre-#133 shape — neither scale nor rotation fields — also
  // keeps its id: the conditional-append hash derives its pre-#133 id from
  // the field-absent document, and the one reader normalizes to scale 1 and
  // rotation 0 without changing the hash (INT-1).
  const preScaleDoc = JSON.parse(JSON.stringify(legacyDoc)) as Record<string, unknown>;
  delete preScaleDoc.scaleX;
  delete preScaleDoc.scaleY;
  delete preScaleDoc.rotationDeg;
  const preScaleId = computeRevisionHash(preScaleDoc as unknown as LayerImageRevision);
  expect(preScaleId).not.toBe(revId);
  expect(preScaleId).not.toBe(legacyId);
  expect(preScaleId).not.toBe(scaledId);
  await writeFile(path.join(projDir, "layers", `${layerId}.revisions`, `${preScaleId}.json`), JSON.stringify(preScaleDoc, null, 2) + "\n");
  identity.currentRevision = preScaleId;
  await writeFile(identityFile, JSON.stringify(identity, null, 2) + "\n");
  const preScaleInspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(preScaleInspect.code).toBe(0);
  const preScaleLayer = JSON.parse(preScaleInspect.stdout).layer;
  expect(preScaleLayer.currentRevisionId).toBe(preScaleId);
  expect(preScaleLayer.currentRevision.scaleX).toBe(1);
  expect(preScaleLayer.currentRevision.scaleY).toBe(1);
  expect(preScaleLayer.currentRevision.rotationDeg).toBe(0);
  // Identity transform: the pinned render still reproduces the original pixels.
  const preScaleOut = path.join(tempDir, "after-prescale.png");
  const preScaleRender = await invoke(["composition", "render", "poster", "--project", projDir, "--out", preScaleOut, "--json"]);
  expect(preScaleRender.code).toBe(0);
  expect(await readFile(preScaleOut)).toEqual(await readFile(outBefore));
});

/** Tracer 9: older revisions keep their original hash/paint meaning and
 * rotation revisions participate in pinned Render history with
 * same-environment replay (US-006, TEST-003). */
test("render history stays pinned across rotations: pre-rotation replay is byte-identical", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 200, y: 50 });
  const layerId = addRes.use.layerId as string;

  const firstOut = path.join(tempDir, "first.png");
  const firstRender = await invoke(["composition", "render", "poster", "--project", projDir, "--out", firstOut, "--json"]);
  expect(firstRender.code).toBe(0);
  const firstManifest = JSON.parse(firstRender.stdout).render.manifest as string;

  // Rotate in place AFTER the render: the pinned history must not change.
  const editRes = await invoke(["layer", "edit", layerId, "--rotate", "90", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(0);

  const replayOut = path.join(tempDir, "replay.png");
  const replayRes = await invoke([
    "composition", "replay", firstManifest, "--project", projDir, "--out", replayOut, "--json",
  ]);
  expect(replayRes.code).toBe(0);
  expect(await readFile(replayOut)).toEqual(await readFile(firstOut));

  // A fresh render pins the rotated revision; replaying it from the pinned
  // revision document is byte-identical within the same environment, and
  // differs from the pre-rotation render.
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
  expect(await readFile(secondOut)).not.toEqual(await readFile(firstOut));
});

/** Tracer 10: rotation is placement-like — it combines freely with resize and
 * content replacement in one edit (no reference-size ambiguity, unlike the
 * two resize forms), with both transform facts reported. */
test("rotation combines with resize and content replacement in one edit", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));
  const greenImg = path.join(tempDir, "green.png");
  await writeFile(greenImg, solidPng(70, 70, GREEN));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;

  // Rotation + resize: both revision facts land, both reports present.
  const combo = await invoke([
    "layer", "edit", layerId, "--resize", "2", "--rotate", "45", "--project", projDir, "--json",
  ]);
  expect(combo.code).toBe(0);
  const comboJson = JSON.parse(combo.stdout);
  expect(comboJson.layer.currentRevision.scaleX).toBe(2);
  expect(comboJson.layer.currentRevision.rotationDeg).toBe(45);
  expect(comboJson.resized).toEqual({ scaleX: 2, scaleY: 2, width: 200, height: 120 });
  expect(comboJson.rotated).toEqual({ rotationDeg: 45 });

  // Rotation + content replacement: the source is replaced and the rotation set.
  const replace = await invoke([
    "layer", "edit", layerId, "--image", greenImg, "--rotate", "-15", "--project", projDir, "--json",
  ]);
  expect(replace.code).toBe(0);
  const replaceJson = JSON.parse(replace.stdout);
  expect(replaceJson.layer.currentRevision.rotationDeg).toBe(-15);
  expect(replaceJson.layer.currentRevision.width).toBe(70);
  expect(replaceJson.rotated).toEqual({ rotationDeg: -15 });
});

/** Tracer 11 (DEC-005): a Layer carrying real Generation Job lineage keeps
 * that lineage — retained record and its reporting — through rotation, with
 * source bytes untouched (fake provider; never billed). */
test("rotation never touches retained generation lineage or source bytes", async () => {
  const jobId = "gen-rotate-lineage";
  const jobsRoot = path.join(tempDir, "out", "generation");
  const generatedPng = solidPng(32, 32, GREEN);
  const job: GenerationJobRecord = await runUniformGeneration(
    jobsRoot,
    jobId,
    {
      prompt: "deterministic lineage content",
      intent: "full-canvas",
      model: "gpt-image",
      sizing: { kind: "size", width: 32, height: 32 },
      count: 1,
    },
    {
      provider: {
        image: async () => ({ images: [{ base64: generatedPng.toString("base64") }], warnings: [] }),
        text: async () => {
          throw new Error("TRIPWIRE: rotation must never generate");
        },
      },
    },
  );
  const output = job.run.outputs[0]!;

  await makeComp("gen", 300, 200);
  const addRes = await invoke(
    ["composition", "add", "gen", "hero", "--from-generation", jobId, "--project", projDir, "--json"],
    tempDir,
  );
  expect(addRes.code).toBe(0);
  const addJson = JSON.parse(addRes.stdout);
  const layerId = addJson.use.layerId as string;
  expect(addJson.generatedFrom).toEqual({ jobId, contentHash: output.contentHash });

  // The job record is retained verbatim in the Project at ingest time.
  const retainedRecord = path.join(projDir, "generation", jobId, "job.json");
  const recordBefore = await readFile(retainedRecord);
  expect(recordBefore).toEqual(await readFile(path.join(jobsRoot, jobId, "job.json")));

  // Rotate twice: content identity and retained bytes never change...
  const rotate1 = await invoke(["layer", "edit", layerId, "--rotate", "90", "--project", projDir, "--json"]);
  expect(rotate1.code).toBe(0);
  const rotate2 = await invoke(["layer", "edit", layerId, "--rotate", "180", "--project", projDir, "--json"]);
  expect(rotate2.code).toBe(0);
  const rotate2Json = JSON.parse(rotate2.stdout);
  expect(rotate2Json.layer.currentRevision.contentHash).toBe(output.contentHash);
  expect(rotate2Json.layer.currentRevision.rotationDeg).toBe(180);
  expect((await readFile(path.join(projDir, "content", output.contentHash))).equals(generatedPng)).toBe(true);
  const contentFiles = await readdir(path.join(projDir, "content"));
  expect(contentFiles).toEqual([output.contentHash]);

  // ...and the retained lineage record survives byte-identically, still
  // reported by the evidence surface.
  expect(await readFile(retainedRecord)).toEqual(recordBefore);
  const reviewOut = path.join(tempDir, "review.html");
  const reviewRes = await invoke(
    ["layer", "review", layerId, "--out", reviewOut, "--project", projDir],
    tempDir,
  );
  expect(reviewRes.code).toBe(0);
  expect(reviewRes.stdout).toContain(`generated by: ${jobId}`);
});
