/**
 * Flip Layers without baking their content (#135, spec #132 US-001 / US-006,
 * DEC-002/003/005, ADR-0016).
 *
 * Verifies through the public CLI seam:
 * - `--flip <horizontal|vertical|both|none>` sets an ABSOLUTE reflection
 *   state (replaces the current flip state; `none` removes it) on image and
 *   text Layers; `flipX`/`flipY` are the canonical revision facts appended to
 *   the revision hash conditionally.
 * - Flip changes placement facts, never retained pixels: contentHash,
 *   retained bytes, and generation/Matting lineage stay unchanged.
 * - Paint applies flip with scale at the innermost position (content reflects
 *   along its own axes, then scale stretches, then rotation rotates), about
 *   the Layer's (x, y) top-left placement point.
 * - Invalid inputs fail without mutation; scoped help, compact output and
 *   JSON describe the new option.
 * - Older revisions retain their original hash/paint meaning; flip revisions
 *   participate in pinned Render history with same-environment replay.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { encodePngRgba, decodePng } from "../src/png.js";
import { computeRevisionHash } from "../src/layer.js";
import { runUniformGeneration, type GenerationJobRecord } from "../src/generation.js";
import { DEFAULT_MODEL } from "../src/models.js";

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

const RED: [number, number, number, number] = [255, 0, 0, 255];
const GREEN: [number, number, number, number] = [0, 255, 0, 255];

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

/** An asymmetric image: solid left half RED, solid right half GREEN — its
 * horizontal reflection swaps the halves; its vertical reflection is
 * pixel-identical to the original (deliberately, so horizontal probes can
 * distinguish reflection from a no-op repaint). */
function leftRedRightGreenPng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const c = x < width / 2 ? RED : GREEN;
      buf[i] = c[0]!;
      buf[i + 1] = c[1]!;
      buf[i + 2] = c[2]!;
      buf[i + 3] = c[3]!;
    }
  }
  return encodePngRgba(width, height, buf);
}

/** An asymmetric image: solid top half RED, solid bottom half GREEN — its
 * vertical reflection swaps the halves. */
function topRedBottomGreenPng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const c = y < height / 2 ? RED : GREEN;
      buf[i] = c[0]!;
      buf[i + 1] = c[1]!;
      buf[i + 2] = c[2]!;
      buf[i + 3] = c[3]!;
    }
  }
  return encodePngRgba(width, height, buf);
}

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-flip-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "flip-test-proj"]);
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

/** Tracer 1: `--flip horizontal` sets an ABSOLUTE reflection state on an
 * image Layer, mirrors the painted pixels about the Layer's own vertical
 * axis, keeps retained bytes identical, and reports the reflection in
 * JSON/text/inspect. `--flip none` removes the reflection; `--flip vertical`
 * replaces a horizontal one. */
test("image Layer --flip sets an absolute reflection state, keeps content bytes, and reports it", async () => {
  const img = path.join(tempDir, "asym.png");
  await writeFile(img, leftRedRightGreenPng(100, 60));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", img, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;
  const contentHash = addRes.layer.currentRevision.contentHash as string;

  const editRes = await invoke([
    "layer", "edit", layerId, "--flip", "horizontal", "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.ok).toBe(true);
  expect(editJson.layer.currentRevisionId).not.toBe(oldRevId);

  // Same content identity, new transform fact: the flip is stored as the
  // canonical revision fields alongside the normalized scale and rotation.
  const rev = editJson.layer.currentRevision;
  expect(rev.contentHash).toBe(contentHash);
  expect(rev.width).toBe(100);
  expect(rev.height).toBe(60);
  expect(rev.scaleX).toBe(1);
  expect(rev.scaleY).toBe(1);
  expect(rev.rotationDeg).toBe(0);
  expect(rev.flipX).toBe(true);
  expect(rev.flipY).toBe(false);

  // Auditable reflection report in JSON output.
  expect(editJson.flipped).toEqual({ flip: "horizontal" });

  // Retained bytes are byte-identical; no new blobs staged.
  const blob = await readFile(path.join(projDir, "content", contentHash));
  expect(createHash("sha256").update(blob).digest("hex")).toBe(contentHash);
  const contentFiles = await readdir(path.join(projDir, "content"));
  expect(contentFiles).toEqual([contentHash]);

  // ABSOLUTE setter: flipping horizontally twice is still horizontal, never
  // a toggle back to unflipped.
  const again = await invoke(["layer", "edit", layerId, "--flip", "horizontal", "--project", projDir, "--json"]);
  expect(again.code).toBe(0);
  const againJson = JSON.parse(again.stdout);
  expect(againJson.layer.currentRevision.flipX).toBe(true);
  expect(againJson.layer.currentRevision.flipY).toBe(false);

  // Compact text output reports the reflection.
  const textRes = await invoke(["layer", "edit", layerId, "--flip", "vertical", "--project", projDir]);
  expect(textRes.code).toBe(0);
  expect(textRes.stdout).toContain("flip vertical");

  // Vertical REPLACES horizontal (absolute setter, one flip state).
  const replaced = JSON.parse(
    (await invoke(["layer", "edit", layerId, "--flip", "vertical", "--project", projDir, "--json"])).stdout,
  );
  expect(replaced.layer.currentRevision.flipX).toBe(false);
  expect(replaced.layer.currentRevision.flipY).toBe(true);
  expect(replaced.flipped).toEqual({ flip: "vertical" });

  // Inspect reports the reflection for auditability — and hides it again at
  // none, mirroring the scale/rotation display convention.
  const shownInspect = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(shownInspect.code).toBe(0);
  expect(shownInspect.stdout).toContain("Flip: vertical");

  // --flip none removes the reflection entirely.
  const remove = await invoke(["layer", "edit", layerId, "--flip", "none", "--project", projDir, "--json"]);
  expect(remove.code).toBe(0);
  const removeJson = JSON.parse(remove.stdout);
  expect(removeJson.layer.currentRevision.flipX).toBe(false);
  expect(removeJson.layer.currentRevision.flipY).toBe(false);
  expect(removeJson.flipped).toEqual({ flip: "none" });
  const hiddenInspect = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(hiddenInspect.code).toBe(0);
  expect(hiddenInspect.stdout).not.toContain("Flip:");
});
/** Tracer 2: horizontal flip mirrors the painted pixels about the vertical
 * line through the Layer's (x, y) placement point — the footprint reflects to
 * the other side of that line (a 100-wide Layer at x=100 paints x ∈ [0, 100]),
 * exactly as rotation moves its footprint about the same origin. Vertical
 * flip mirrors about the horizontal line through (x, y). Both paint from
 * unchanged retained bytes. */
test("flipped image Layers paint mirrored about the placement point from unchanged bytes", async () => {
  const lrImg = path.join(tempDir, "lr.png");
  await writeFile(lrImg, leftRedRightGreenPng(100, 60));
  const tbImg = path.join(tempDir, "tb.png");
  await writeFile(tbImg, topRedBottomGreenPng(100, 60));
  const outH = path.join(tempDir, "flip-h.png");
  const outV = path.join(tempDir, "flip-v.png");

  await makeComp("poster", 400, 300);
  const addH = await addImageLayer("poster", "hero", lrImg, { x: 100, y: 50 });
  const layerH = addH.use.layerId as string;
  const hashH = addH.layer.currentRevision.contentHash as string;

  const flipH = await invoke(["layer", "edit", layerH, "--flip", "horizontal", "--project", projDir, "--json"]);
  expect(flipH.code).toBe(0);
  const renderH = await invoke(["composition", "render", "poster", "--project", projDir, "--out", outH, "--json"]);
  expect(renderH.code).toBe(0);
  const pngH = decodePng(await readFile(outH));
  // The footprint mirrored to x ∈ [0, 100]: painted x shows original content
  // u = 100 − x, so the left of the footprint shows the original right half.
  expect(pixel(pngH, 20, 80)).toEqual([0, 255, 0, 255]);
  expect(pixel(pngH, 80, 80)).toEqual([255, 0, 0, 255]);
  // Nothing paints right of the mirror line x = 100 anymore, nor outside the
  // vertical extent.
  expect(pixel(pngH, 120, 80)[3]).toBe(0);
  expect(pixel(pngH, 50, 40)[3]).toBe(0);
  expect(pixel(pngH, 50, 120)[3]).toBe(0);

  // Vertical flip on a separate Layer at (100, 150): footprint mirrors to
  // y ∈ [90, 150]; painted y shows original content v = 150 − y.
  const addV = await addImageLayer("poster", "other", tbImg, { x: 100, y: 150 });
  const layerV = addV.use.layerId as string;
  expect(addV.layer.currentRevision.contentHash).not.toBe(hashH);
  const flipV = await invoke(["layer", "edit", layerV, "--flip", "vertical", "--project", projDir, "--json"]);
  expect(flipV.code).toBe(0);
  const renderV = await invoke(["composition", "render", "poster", "--project", projDir, "--out", outV, "--json"]);
  expect(renderV.code).toBe(0);
  const pngV = decodePng(await readFile(outV));
  expect(pixel(pngV, 120, 100)).toEqual([0, 255, 0, 255]);
  expect(pixel(pngV, 180, 140)).toEqual([255, 0, 0, 255]);
  expect(pixel(pngV, 120, 160)[3]).toBe(0);
  expect(pixel(pngV, 120, 80)[3]).toBe(0);

  // Retained bytes unchanged for both Layers.
  for (const [hash, img] of [[hashH, lrImg], [addV.layer.currentRevision.contentHash as string, tbImg]] as const) {
    const blob = await readFile(path.join(projDir, "content", hash));
    expect(createHash("sha256").update(blob).digest("hex")).toBe(hash);
    expect(blob.equals(await readFile(img))).toBe(true);
  }
});

/** Tracer 3: text Layers flip from unchanged retained font bytes. Glyph
 * rasterization under a negative scale has subpixel phase asymmetry (a ~1-row
 * shift at glyph edges), so instead of a byte-exact mirror this pins the
 * structural contract: all ink mirrors to strictly above the horizontal line
 * through the Layer's y placement (its bottom edge lands within 2 rows of the
 * exact mirror of the original's top ink row), the column extent is unchanged
 * (no horizontal drift), and ink coverage stays comparable (no resample). */
test("text Layer flips vertically: ink mirrors above the placement line", async () => {
  await makeComp("doc", 300, 200);
  const addRes = await addTextLayer("doc", "heading", "Hello", { font: "Anton", fontSize: 40, x: 40, y: 40 });
  const layerId = addRes.use.layerId as string;
  const fontHash = addRes.layer.currentRevision.contentHash as string;

  const beforeOut = path.join(tempDir, "text-before.png");
  const beforeRes = await invoke(["composition", "render", "doc", "--project", projDir, "--out", beforeOut, "--json"]);
  expect(beforeRes.code).toBe(0);
  const before = decodePng(await readFile(beforeOut));

  const editRes = await invoke(["layer", "edit", layerId, "--flip", "vertical", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.layer.currentRevision.contentHash).toBe(fontHash);
  expect(editJson.layer.currentRevision.flipY).toBe(true);
  expect(editJson.flipped).toEqual({ flip: "vertical" });

  const afterOut = path.join(tempDir, "text-after.png");
  const afterRes = await invoke(["composition", "render", "doc", "--project", projDir, "--out", afterOut, "--json"]);
  expect(afterRes.code).toBe(0);
  const after = decodePng(await readFile(afterOut));
  expect(after.width).toBe(before.width);
  expect(after.height).toBe(before.height);

  const extent = (png: ReturnType<typeof decodePng>) => {
    let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity, ink = 0;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        if (png.rgba[((y * png.width) + x) * 4 + 3]! > 0) {
          ink++;
          if (y < minRow) minRow = y;
          if (y > maxRow) maxRow = y;
          if (x < minCol) minCol = x;
          if (x > maxCol) maxCol = x;
        }
      }
    }
    return { minRow, maxRow, minCol, maxCol, ink };
  };
  const b = extent(before);
  const a = extent(after);

  // Sanity: the unflipped text paints below the placement line y = 40.
  expect(b.minRow).toBeGreaterThanOrEqual(40);
  expect(b.ink).toBeGreaterThan(0);
  // The flip mirrors ALL ink strictly above y = 40, and its bottom edge lands
  // within 2 rows of the exact mirror of the original's top ink row
  // (80 − b.minRow; the residual is glyph-hinting phase, not geometry).
  expect(a.maxRow).toBeLessThanOrEqual(40);
  expect(Math.abs(a.maxRow - (80 - b.minRow))).toBeLessThanOrEqual(2);
  // The column extent is unchanged: a vertical flip never drifts horizontally.
  expect(Math.abs(a.minCol - b.minCol)).toBeLessThanOrEqual(2);
  expect(Math.abs(a.maxCol - b.maxCol)).toBeLessThanOrEqual(2);
  // Ink still exists and stays a text-sized band, not a resample or smear:
  // the mirrored band spans at least half the original's row extent (the
  // negative-scale rasterization cuts faint AA rows sharper, so it is
  // somewhat narrower — it can never approach the full canvas height).
  expect(a.ink).toBeGreaterThan(0);
  expect(a.maxRow - a.minRow).toBeGreaterThanOrEqual(Math.floor((b.maxRow - b.minRow) / 2));

  // Font bytes retained: still exactly the bundled face blob, no new blobs.
  const blob = await readFile(path.join(projDir, "content", fontHash));
  expect(createHash("sha256").update(blob).digest("hex")).toBe(fontHash);
  const contentFiles = await readdir(path.join(projDir, "content"));
  expect(contentFiles).toEqual([fontHash]);
});

/** Tracer 4 (documented order, ADR-0016): flip joins scale at the innermost
 * position — the content reflects along its own axes FIRST, then the flipped
 * result rotates. A 100×60 left-red/right-green rect at (200, 150) flipped
 * horizontally then rotated 90° clockwise paints x ∈ [140, 200], y ∈ [50, 150]
 * with GREEN on top (the flipped content's far half) and RED on bottom. The
 * opposite order (rotate, then flip) would instead paint x ∈ [200, 260] — the
 * distinguishing pixels pin the contract. */
test("flip applies before rotation: the reflected content rotates as a whole", async () => {
  const img = path.join(tempDir, "asym.png");
  await writeFile(img, leftRedRightGreenPng(100, 60));
  const out = path.join(tempDir, "flip-order.png");

  await makeComp("poster", 400, 400);
  const addRes = await addImageLayer("poster", "hero", img, { x: 200, y: 150 });
  const layerId = addRes.use.layerId as string;

  const editRes = await invoke([
    "layer", "edit", layerId, "--flip", "horizontal", "--rotate", "90", "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.layer.currentRevision.flipX).toBe(true);
  expect(editJson.layer.currentRevision.rotationDeg).toBe(90);
  expect(editJson.flipped).toEqual({ flip: "horizontal" });
  expect(editJson.rotated).toEqual({ rotationDeg: 90 });

  const renderRes = await invoke(["composition", "render", "poster", "--project", projDir, "--out", out, "--json"]);
  expect(renderRes.code).toBe(0);
  const png = decodePng(await readFile(out));
  // Inside the flip-then-rotate footprint (60 wide, 100 tall): the flipped
  // content's far half (GREEN) rotates to the top, near half (RED) to the
  // bottom.
  expect(pixel(png, 150, 60)).toEqual([0, 255, 0, 255]);
  expect(pixel(png, 190, 60)).toEqual([0, 255, 0, 255]);
  expect(pixel(png, 150, 140)).toEqual([255, 0, 0, 255]);
  expect(pixel(png, 190, 140)).toEqual([255, 0, 0, 255]);
  // Right of the pivot column x = 200: painted only if rotation ran BEFORE
  // the flip (flip-outermost) — must be empty.
  expect(pixel(png, 210, 160)[3]).toBe(0);
  expect(pixel(png, 210, 240)[3]).toBe(0);
  // Left of the footprint: outside either order's footprint.
  expect(pixel(png, 100, 100)[3]).toBe(0);
});

/** Tracer 5: flip is a revision fact shared as a whole (DEC-002, ADR-0013):
 * plain edits carry it forward, forks isolate it, and cross-Project import
 * preserves it verbatim in the copied revision document. */
test("flip survives plain edits, forks, and cross-Project import", async () => {
  const img = path.join(tempDir, "asym.png");
  await writeFile(img, leftRedRightGreenPng(100, 60));

  await makeComp("source", 400, 300);
  const addRes2 = await addImageLayer("source", "hero", img, { x: 10, y: 10 });
  const layerId = addRes2.use.layerId as string;
  const contentHash = addRes2.layer.currentRevision.contentHash as string;

  const flipRes = await invoke(["layer", "edit", layerId, "--flip", "both", "--project", projDir, "--json"]);
  expect(flipRes.code).toBe(0);
  const flippedRevId = JSON.parse(flipRes.stdout).layer.currentRevisionId as string;

  // A plain non-flip edit carries the flip forward.
  const moveRes = await invoke(["layer", "edit", layerId, "--x", "50", "--project", projDir, "--json"]);
  expect(moveRes.code).toBe(0);
  const moveJson = JSON.parse(moveRes.stdout);
  expect(moveJson.layer.currentRevision.flipX).toBe(true);
  expect(moveJson.layer.currentRevision.flipY).toBe(true);
  expect(moveJson.layer.currentRevision.x).toBe(50);
  // No flip option: no `flipped` report on this edit.
  expect(moveJson.flipped).toBeUndefined();

  // Fork: the forked Layer carries the flipped revision; the original keeps
  // its own (fork with --flip none isolates the removal to the new identity).
  await makeComp("forker", 400, 300);
  await invoke(["composition", "import", "forker", "source", "--project", projDir, "--json"]);
  const forkRes = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "forker", "--use", "hero",
    "--flip", "none", "--project", projDir, "--json",
  ]);
  expect(forkRes.code).toBe(0);
  const forkJson = JSON.parse(forkRes.stdout);
  expect(forkJson.fork.previousLayerId).toBe(layerId);
  expect(forkJson.flipped).toEqual({ flip: "none" });
  expect(forkJson.layer.currentRevision.flipX).toBe(false);
  expect(forkJson.layer.currentRevision.flipY).toBe(false);
  expect(forkJson.layer.currentRevision.contentHash).toBe(contentHash);
  const original = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
  expect(original.layer.currentRevision.flipX).toBe(true);
  expect(original.layer.currentRevision.flipY).toBe(true);
  expect(forkJson.layer.currentRevisionId).not.toBe(flippedRevId);

  // Cross-Project import: the destination revision preserves the flip verbatim.
  const otherProj = path.join(tempDir, "proj2");
  await invoke(["project", "init", otherProj, "--name", "flip-import-proj"]);
  await invoke(["composition", "create", "landing", "--width", "400", "--height", "300", "--project", otherProj, "--json"]);
  const importRes = await invoke([
    "composition", "import", "landing", "source", "--from-project", projDir, "--project", otherProj, "--json",
  ]);
  expect(importRes.code).toBe(0);
  const importedLayerId = JSON.parse(importRes.stdout).importedUses[0].layerId as string;
  const imported = JSON.parse((await invoke(["layer", "inspect", importedLayerId, "--project", otherProj, "--json"])).stdout);
  const importedRev = imported.layer.currentRevision;
  expect(importedRev.flipX).toBe(true);
  expect(importedRev.flipY).toBe(true);
  expect(importedRev.scaleX).toBe(1);
  expect(importedRev.rotationDeg).toBe(0);
  expect(importedRev.contentHash).toBe(contentHash);
  const copiedDoc = JSON.parse(
    await readFile(path.join(otherProj, "layers", `${importedLayerId}.revisions`, `${imported.layer.currentRevisionId}.json`), "utf8"),
  );
  expect(copiedDoc.flipX).toBe(true);
  expect(copiedDoc.flipY).toBe(true);
});

/** Tracer 6: older revisions keep their original hash/paint meaning and flip
 * revisions participate in pinned Render history with same-environment
 * replay (US-006, TEST-003). */
test("render history stays pinned across flips: pre-flip replay is byte-identical", async () => {
  const img = path.join(tempDir, "asym.png");
  await writeFile(img, leftRedRightGreenPng(100, 60));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", img, { x: 150, y: 100 });
  const layerId = addRes.use.layerId as string;

  const firstOut = path.join(tempDir, "first.png");
  const firstRender = await invoke(["composition", "render", "poster", "--project", projDir, "--out", firstOut, "--json"]);
  expect(firstRender.code).toBe(0);
  const firstManifest = JSON.parse(firstRender.stdout).render.manifest as string;

  // Flip in place AFTER the render: the pinned history must not change.
  const editRes = await invoke(["layer", "edit", layerId, "--flip", "horizontal", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(0);

  const replayOut = path.join(tempDir, "replay.png");
  const replayRes = await invoke([
    "composition", "replay", firstManifest, "--project", projDir, "--out", replayOut, "--json",
  ]);
  expect(replayRes.code).toBe(0);
  expect(await readFile(replayOut)).toEqual(await readFile(firstOut));

  // A fresh render pins the flipped revision; replaying it from the pinned
  // revision document is byte-identical within the same environment, and
  // differs from the pre-flip render (the image is horizontally asymmetric).
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

/** Tracer 7: genuinely pre-#135 revision documents — flip fields absent
 * (rotation-era shapes) — keep their exact revision ids: the hash appends the
 * flip fields only when present, so older revisions retain their original
 * hash and paint meaning (#135). A malformed stored flip field (null,
 * non-boolean, or a partial pair) is refused loudly at the one revision
 * reader boundary — never a silent default. */
test("pre-flip revision documents keep their hash; malformed stored flips are refused", async () => {
  const img = path.join(tempDir, "asym.png");
  await writeFile(img, leftRedRightGreenPng(100, 60));
  const outBefore = path.join(tempDir, "before-legacy.png");

  await makeComp("poster", 300, 200);
  const addRes = await addImageLayer("poster", "hero", img, { x: 100, y: 50 });
  const layerId = addRes.use.layerId as string;
  const revId = addRes.layer.currentRevisionId as string;

  const renderBefore = await invoke(["composition", "render", "poster", "--project", projDir, "--out", outBefore, "--json"]);
  expect(renderBefore.code).toBe(0);

  // Hand-write the stored document into the exact pre-#135 shape: the add
  // path records flipX/flipY: false explicitly (ADR-0016), so deleting them
  // yields a genuinely pre-#135 document, pinned by the id the pre-#135 hash
  // algorithm derives from it.
  const revFile = path.join(projDir, "layers", `${layerId}.revisions`, `${revId}.json`);
  const identityFile = path.join(projDir, "layers", `${layerId}.json`);
  const legacyDoc = JSON.parse(await readFile(revFile, "utf8")) as Record<string, unknown>;
  expect(legacyDoc.flipX).toBe(false);
  expect(legacyDoc.flipY).toBe(false);
  delete legacyDoc.flipX;
  delete legacyDoc.flipY;
  const legacyId = computeRevisionHash(legacyDoc as never);
  expect(legacyId).not.toBe(revId);
  await writeFile(path.join(projDir, "layers", `${layerId}.revisions`, `${legacyId}.json`), JSON.stringify(legacyDoc, null, 2) + "\n");
  const identity = JSON.parse(await readFile(identityFile, "utf8")) as Record<string, unknown>;
  identity.currentRevision = legacyId;
  await writeFile(identityFile, JSON.stringify(identity, null, 2) + "\n");

  // The legacy document still hash-verifies at its pre-#135 revision id.
  const inspectRes = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(inspectRes.code).toBe(0);
  const layer = JSON.parse(inspectRes.stdout).layer;
  expect(layer.currentRevisionId).toBe(legacyId);
  expect(layer.currentRevision.flipX).toBe(false);
  expect(layer.currentRevision.flipY).toBe(false);
  expect(layer.currentRevision.rotationDeg).toBe(0);

  // And it paints identically: no transform is emitted for the identity
  // transform, so the pinned render of a pre-flip revision is unchanged.
  const outAfter = path.join(tempDir, "after-legacy.png");
  const renderAfter = await invoke(["composition", "render", "poster", "--project", projDir, "--out", outAfter, "--json"]);
  expect(renderAfter.code).toBe(0);
  expect(await readFile(outAfter)).toEqual(await readFile(outBefore));

  // A partial pair is malformed, never half a flip.
  const partialDoc = { ...legacyDoc, flipX: true };
  const partialId = computeRevisionHash(partialDoc as never);
  await writeFile(path.join(projDir, "layers", `${layerId}.revisions`, `${partialId}.json`), JSON.stringify(partialDoc, null, 2) + "\n");
  identity.currentRevision = partialId;
  await writeFile(identityFile, JSON.stringify(identity, null, 2) + "\n");
  const partialRes = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(partialRes.code).toBe(1);
  expect(JSON.parse(partialRes.stdout).error).toContain("flipX and flipY must be present together");

  // A present null is malformed, never a silent default.
  const nullDoc = { ...legacyDoc, flipX: null, flipY: null };
  const nullId = computeRevisionHash(nullDoc as never);
  await writeFile(path.join(projDir, "layers", `${layerId}.revisions`, `${nullId}.json`), JSON.stringify(nullDoc, null, 2) + "\n");
  identity.currentRevision = nullId;
  await writeFile(identityFile, JSON.stringify(identity, null, 2) + "\n");
  const nullRes = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(nullRes.code).toBe(1);
  expect(JSON.parse(nullRes.stdout).error).toContain("flipX and flipY must be booleans");

  // A non-boolean field is malformed.
  const stringDoc = { ...legacyDoc, flipX: "yes", flipY: false };
  const stringId = computeRevisionHash(stringDoc as never);
  await writeFile(path.join(projDir, "layers", `${layerId}.revisions`, `${stringId}.json`), JSON.stringify(stringDoc, null, 2) + "\n");
  identity.currentRevision = stringId;
  await writeFile(identityFile, JSON.stringify(identity, null, 2) + "\n");
  const stringRes = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(stringRes.code).toBe(1);
  expect(JSON.parse(stringRes.stdout).error).toContain("flipX and flipY must be booleans");
});

/** Tracer 8: invalid flip modes fail without mutation — usage errors exit 2
 * before any staging — and the scoped help names the new option. */
test("invalid flip modes fail without mutation; scoped help exposes the option", async () => {
  const img = path.join(tempDir, "asym.png");
  await writeFile(img, leftRedRightGreenPng(100, 60));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", img, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;
  const contentHash = addRes.layer.currentRevision.contentHash as string;

  for (const bad of ["sideways", "HORIZONTAL-", "", "mirror"]) {
    const res = await invoke(["layer", "edit", layerId, "--flip", bad, "--project", projDir, "--json"]);
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout).ok).toBe(false);
    expect(JSON.parse(res.stdout).error).toContain("--flip");
  }

  // No refused edit advanced live state or staged storage.
  const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  const layer = JSON.parse(inspect.stdout).layer;
  expect(layer.currentRevisionId).toBe(oldRevId);
  expect(layer.currentRevision.contentHash).toBe(contentHash);
  expect(layer.currentRevision.flipX).toBe(false);
  expect(layer.currentRevision.flipY).toBe(false);
  const contentFiles = await readdir(path.join(projDir, "content"));
  expect(contentFiles).toEqual([contentHash]);

  // Scoped help names --flip and states the absolute-setter semantics.
  const help = await invoke(["layer", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("--flip <mode>");
  expect(help.stdout).toContain("ABSOLUTE reflection state");
  expect(help.stdout).toContain("none removes the reflection");
});

/** Tracer 9: flip is independent of content size — it combines freely with
 * --resize and content replacement in one edit, with both facts reported. */
test("flip combines with resize and content replacement in one edit", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, leftRedRightGreenPng(100, 60));
  const greenImg = path.join(tempDir, "green.png");
  await writeFile(greenImg, topRedBottomGreenPng(70, 70));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;

  // Flip + resize: both revision facts land, both reports present.
  const combo = await invoke([
    "layer", "edit", layerId, "--resize", "2", "--flip", "horizontal", "--project", projDir, "--json",
  ]);
  expect(combo.code).toBe(0);
  const comboJson = JSON.parse(combo.stdout);
  expect(comboJson.layer.currentRevision.scaleX).toBe(2);
  expect(comboJson.layer.currentRevision.flipX).toBe(true);
  expect(comboJson.resized).toEqual({ scaleX: 2, scaleY: 2, width: 200, height: 120 });
  expect(comboJson.flipped).toEqual({ flip: "horizontal" });

  // Flip + content replacement: the source is replaced and the flip set —
  // the flip is an absolute state on the new content, not a toggle.
  const replace = await invoke([
    "layer", "edit", layerId, "--image", greenImg, "--flip", "vertical", "--project", projDir, "--json",
  ]);
  expect(replace.code).toBe(0);
  const replaceJson = JSON.parse(replace.stdout);
  expect(replaceJson.layer.currentRevision.width).toBe(70);
  expect(replaceJson.layer.currentRevision.flipX).toBe(false);
  expect(replaceJson.layer.currentRevision.flipY).toBe(true);
  expect(replaceJson.flipped).toEqual({ flip: "vertical" });
});

/** Tracer 10 (US-001, DEC-005): a Layer carrying real Generation Job lineage
 * keeps that lineage — retained record and its reporting — through flips,
 * with source bytes untouched (fake provider; never billed). */
test("flip never touches retained generation lineage or source bytes", async () => {
  const jobId = "gen-flip-lineage";
  const jobsRoot = path.join(tempDir, "out", "generation");
  const generatedPng = solidPng(32, 32, GREEN);
  const job: GenerationJobRecord = await runUniformGeneration(
    jobsRoot,
    jobId,
    {
      prompt: "deterministic lineage content",
      intent: "full-canvas",
      model: DEFAULT_MODEL,
      sizing: { kind: "size", width: 32, height: 32 },
      count: 1,
    },
    {
      provider: {
        image: async () => ({ images: [{ base64: generatedPng.toString("base64") }], warnings: [] }),
        text: async () => {
          throw new Error("TRIPWIRE: flip must never generate");
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

  // Flip twice: content identity and retained bytes never change...
  const flip1 = await invoke(["layer", "edit", layerId, "--flip", "horizontal", "--project", projDir, "--json"]);
  expect(flip1.code).toBe(0);
  const flip2 = await invoke(["layer", "edit", layerId, "--flip", "both", "--project", projDir, "--json"]);
  expect(flip2.code).toBe(0);
  const flip2Json = JSON.parse(flip2.stdout);
  expect(flip2Json.layer.currentRevision.contentHash).toBe(output.contentHash);
  expect(flip2Json.layer.currentRevision.flipX).toBe(true);
  expect(flip2Json.layer.currentRevision.flipY).toBe(true);
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

/** Tracer 11 (TEST-002 matrix): horizontal flip on a text Layer mirrors the
 * ink about the vertical line through the Layer's x placement (x = 100, far
 * enough from the canvas edge that nothing clips) — all ink strictly left of
 * x = 100, both edges near the exact mirror columns, row extent unchanged. */
test("text Layer flips horizontally: ink mirrors left of the placement line", async () => {
  await makeComp("doc", 300, 200);
  const addRes = await addTextLayer("doc", "heading", "Hello", { font: "Anton", fontSize: 40, x: 100, y: 40 });
  const layerId = addRes.use.layerId as string;
  const fontHash = addRes.layer.currentRevision.contentHash as string;

  const beforeOut = path.join(tempDir, "text-h-before.png");
  const beforeRes = await invoke(["composition", "render", "doc", "--project", projDir, "--out", beforeOut, "--json"]);
  expect(beforeRes.code).toBe(0);
  const before = decodePng(await readFile(beforeOut));

  const editRes = await invoke(["layer", "edit", layerId, "--flip", "horizontal", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.layer.currentRevision.contentHash).toBe(fontHash);
  expect(editJson.layer.currentRevision.flipX).toBe(true);
  expect(editJson.flipped).toEqual({ flip: "horizontal" });

  const afterOut = path.join(tempDir, "text-h-after.png");
  const afterRes = await invoke(["composition", "render", "doc", "--project", projDir, "--out", afterOut, "--json"]);
  expect(afterRes.code).toBe(0);
  const after = decodePng(await readFile(afterOut));

  const extent = (png: ReturnType<typeof decodePng>) => {
    let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity, ink = 0;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        if (png.rgba[((y * png.width) + x) * 4 + 3]! > 0) {
          ink++;
          if (y < minRow) minRow = y;
          if (y > maxRow) maxRow = y;
          if (x < minCol) minCol = x;
          if (x > maxCol) maxCol = x;
        }
      }
    }
    return { minRow, maxRow, minCol, maxCol, ink };
  };
  const b = extent(before);
  const a = extent(after);

  // Sanity: the unflipped text paints right of the placement line x = 100.
  expect(b.minCol).toBeGreaterThanOrEqual(100);
  expect(b.ink).toBeGreaterThan(0);
  // The flip mirrors ALL ink strictly left of x = 100, and both edges land
  // within 2 columns of the exact mirror columns (200 − col; the residual is
  // glyph-hinting phase, not geometry).
  expect(a.maxCol).toBeLessThanOrEqual(100);
  expect(Math.abs(a.minCol - (200 - b.maxCol))).toBeLessThanOrEqual(2);
  expect(Math.abs(a.maxCol - (200 - b.minCol))).toBeLessThanOrEqual(2);
  // The row extent is unchanged: a horizontal flip never drifts vertically.
  expect(Math.abs(a.minRow - b.minRow)).toBeLessThanOrEqual(2);
  expect(Math.abs(a.maxRow - b.maxRow)).toBeLessThanOrEqual(2);
  // Ink still exists and stays a text-sized band, not a resample or smear.
  expect(a.ink).toBeGreaterThan(0);
  expect(a.maxCol - a.minCol).toBeGreaterThanOrEqual(Math.floor((b.maxCol - b.minCol) / 2));
});

/** Tracer 12 (acceptance criterion 3): removing the reflection restores the
 * original pixels exactly — render, flip, flip none, render again. */
test("--flip none restores the pre-flip painted pixels exactly", async () => {
  const img = path.join(tempDir, "asym.png");
  await writeFile(img, leftRedRightGreenPng(100, 60));
  const before = path.join(tempDir, "pre-flip.png");
  const after = path.join(tempDir, "post-none.png");

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", img, { x: 150, y: 100 });
  const layerId = addRes.use.layerId as string;

  const render1 = await invoke(["composition", "render", "poster", "--project", projDir, "--out", before, "--json"]);
  expect(render1.code).toBe(0);

  const flip = await invoke(["layer", "edit", layerId, "--flip", "horizontal", "--project", projDir, "--json"]);
  expect(flip.code).toBe(0);
  const flippedRev = JSON.parse(flip.stdout).layer.currentRevisionId as string;

  const remove = await invoke(["layer", "edit", layerId, "--flip", "none", "--project", projDir, "--json"]);
  expect(remove.code).toBe(0);
  const removedRev = JSON.parse(remove.stdout).layer.currentRevisionId as string;
  expect(removedRev).not.toBe(flippedRev);
  expect(JSON.parse(remove.stdout).layer.currentRevision.flipX).toBe(false);

  const render2 = await invoke(["composition", "render", "poster", "--project", projDir, "--out", after, "--json"]);
  expect(render2.code).toBe(0);
  // Identity-transform emission: no flip parts, byte-identical to pre-flip.
  expect(await readFile(after)).toEqual(await readFile(before));
});
