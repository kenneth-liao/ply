/**
 * Cover fit sizes an image Layer to fill a target (#293, spec #285 US-007,
 * DEC-011).
 *
 * Verifies through the public CLI seam (TEST-001 prior art: layer-resize,
 * layer-glow):
 * - `--cover-to <WxH|Wx|xH|canvas>` joins the resize family as a fourth
 *   mutually exclusive form beside --resize/--resize-to/--scale, with the
 *   same refusal on add and edit.
 * - Cover fit resolves into the ONE canonical scale facts (scaleX/scaleY,
 *   ADR-0016) — no new stored fact: the uniform scale = max of the cover
 *   ratios over the intrinsic size, aspect always preserved.
 * - `--cover-to canvas` resolves the target Composition's canvas — on add
 *   the composition being added to; on edit the referring Composition's
 *   canvas (all referrers must agree; disagreement is refused naming them,
 *   an unreferenced Layer is refused).
 * - The overflow sits outside the canvas, nothing is clipped, and the
 *   covered Layer stays editable.
 * - Kind gates: image Layers only (raster and vector) — text and shape
 *   Layers are refused.
 * - Offline reversibility and replay (TEST-002): the absolute --scale
 *   setter reverses a cover fit to a byte-identical render; retained
 *   content bytes never change.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePngRgba, decodePng } from "../src/png.js";

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

function solidSvg(width: number, height: number, color: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${color}"/>` +
    `</svg>`
  );
}

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-cover-"));
  projDir = path.join(tempDir, "proj");
  const init = await invoke(["project", "init", projDir, "--name", "cover-test-proj"]);
  expect(init.code).toBe(0);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComp(name: string, width: number, height: number) {
  const res = await invoke([
    "composition", "create", name, "--width", String(width), "--height", String(height), "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
}

async function addJson(comp: string, localName: string, imgFile: string, args: string[] = []) {
  const res = await invoke([
    "composition", "add", comp, localName, "--image", imgFile, ...args, "--project", projDir, "--json",
  ]);
  return res;
}

async function renderPng(comp: string, filename: string): Promise<ReturnType<typeof decodePng>> {
  const outPath = path.join(tempDir, filename);
  const res = await invoke([
    "composition", "render", comp, "--project", projDir, "--out", outPath, "--supersample", "1",
  ]);
  expect(res.code).toBe(0);
  return decodePng(await readFile(outPath));
}

// ---------------------------------------------------------------------------
// 1. Cover fit on add: uniform scale = max of the cover ratios, overflow
//    outside the canvas, Layer stays editable.
// ---------------------------------------------------------------------------

test("--cover-to <WxH> on add scales the Layer to cover the target, preserving aspect", async () => {
  await makeComp("poster", 200, 100);
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(100, 60, RED));

  // Cover 200x100 with a 100x60 image: scale = max(200/100, 100/60) = 2 →
  // effective 200x120 — the width axis exactly, the height axis overflowing.
  const res = await addJson("poster", "bg", img, ["--cover-to", "200x100"]);
  expect(res.code).toBe(0);
  const body = JSON.parse(res.stdout);
  expect(body.layer.currentRevision.scaleX).toBe(2);
  expect(body.layer.currentRevision.scaleY).toBe(2);

  // The canvas is fully covered (all corners painted), nothing clipped.
  const png = await renderPng("poster", "cover-add.png");
  expect(png.width).toBe(200);
  expect(png.height).toBe(100);
  for (const [x, y] of [[0, 0], [199, 0], [0, 99], [199, 99], [100, 50]]) {
    expect(pixel(png, x, y)).toEqual(RED);
  }

  // The covered Layer stays editable: an ordinary edit still applies.
  const edit = await invoke(["layer", "edit", body.use.layerId, "--opacity", "0.5", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);
  const png2 = await renderPng("poster", "cover-add-edit.png");
  // Background shows through at half opacity: the covered pixel's alpha
  // drops from 255 to ~127 over the transparent canvas.
  const px = pixel(png2, 100, 50);
  expect(px[3]).toBeGreaterThan(0);
  expect(px[3]).toBeLessThan(255);
  expect(pixel(png, 100, 50)[3]).toBe(255);
});

test("--cover-to with one axis covers that axis, aspect preserved", async () => {
  await makeComp("poster", 400, 300);
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(100, 60, RED));

  // Cover width 200 only: scale = 2 → 200x120 (the height may underfill the
  // target box — the caller asked to cover one axis).
  const res = await addJson("poster", "bg", img, ["--cover-to", "200x"]);
  expect(res.code).toBe(0);
  const body = JSON.parse(res.stdout);
  expect(body.layer.currentRevision.scaleX).toBe(2);
  expect(body.layer.currentRevision.scaleY).toBe(2);
});

test("--cover-to canvas on add resolves the target Composition's canvas", async () => {
  await makeComp("poster", 200, 100);
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(100, 60, RED));

  // Cover the canvas 200x100: scale = max(200/100, 100/60) = 2.
  const res = await addJson("poster", "bg", img, ["--cover-to", "canvas"]);
  expect(res.code).toBe(0);
  const body = JSON.parse(res.stdout);
  expect(body.layer.currentRevision.scaleX).toBe(2);
  expect(body.layer.currentRevision.scaleY).toBe(2);
});

test("cover fit on a vector image Layer resolves the same way", async () => {
  await makeComp("poster", 200, 200);
  const svg = path.join(tempDir, "blue.svg");
  await writeFile(svg, solidSvg(80, 40, "#0000ff"));

  // Cover 200x200 with an 80x40 vector: scale = max(200/80, 200/40) = 5.
  const res = await addJson("poster", "bg", svg, ["--cover-to", "200x200"]);
  expect(res.code).toBe(0);
  const body = JSON.parse(res.stdout);
  expect(body.layer.currentRevision.scaleX).toBe(5);
  expect(body.layer.currentRevision.scaleY).toBe(5);
});

// ---------------------------------------------------------------------------
// 2. Edit surface: cover fit through `layer edit`, including --cover-to
//    canvas via the referring Composition's canvas.
// ---------------------------------------------------------------------------

test("layer edit --cover-to <WxH> sets the absolute cover scale; repeating is idempotent", async () => {
  await makeComp("poster", 400, 300);
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(100, 60, RED));
  const added = await addJson("poster", "bg", img);
  expect(added.code).toBe(0);
  const layerId = JSON.parse(added.stdout).use.layerId as string;

  // Cover 300 wide: scale = 3, absolute — idempotent on repeat.
  const edit = await invoke(["layer", "edit", layerId, "--cover-to", "300x", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);
  const body = JSON.parse(edit.stdout);
  expect(body.layer.currentRevision.scaleX).toBe(3);
  expect(body.layer.currentRevision.scaleY).toBe(3);
  expect(body.resized.scaleX).toBe(3);
  expect(body.resized.width).toBe(300);
  expect(body.resized.height).toBe(180);

  const repeat = await invoke(["layer", "edit", layerId, "--cover-to", "300x", "--project", projDir, "--json"]);
  expect(repeat.code).toBe(0);
  expect(JSON.parse(repeat.stdout).layer.currentRevision.scaleX).toBe(3);
});

test("layer edit --cover-to canvas resolves the single referring Composition's canvas", async () => {
  await makeComp("poster", 240, 120);
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(100, 60, RED));
  const added = await addJson("poster", "bg", img);
  expect(added.code).toBe(0);
  const layerId = JSON.parse(added.stdout).use.layerId as string;

  // Cover the canvas 240x120: scale = max(240/100, 120/60) = 2.4.
  const edit = await invoke(["layer", "edit", layerId, "--cover-to", "canvas", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);
  expect(JSON.parse(edit.stdout).layer.currentRevision.scaleX).toBe(2.4);
});

test("layer edit --cover-to canvas with agreeing referrers resolves; disagreeing canvases are refused naming them", async () => {
  await makeComp("comp-a", 200, 100);
  await makeComp("comp-b", 200, 100);
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(100, 60, RED));
  const added = await addJson("comp-a", "bg", img);
  expect(added.code).toBe(0);
  const layerId = JSON.parse(added.stdout).use.layerId as string;

  // Share the Layer into comp-b by importing comp-a into comp-b (same
  // layerId in both Compositions, same canvas size): the canvas target
  // resolves against the agreeing referrers.
  const imported = await invoke(["composition", "import", "comp-b", "comp-a", "--project", projDir, "--json"]);
  expect(imported.code).toBe(0);

  const agree = await invoke(["layer", "edit", layerId, "--cover-to", "canvas", "--in-place", "--project", projDir, "--json"]);
  expect(agree.code).toBe(0);
  expect(JSON.parse(agree.stdout).layer.currentRevision.scaleX).toBe(2);

  // A third referrer with a different canvas makes the target ambiguous.
  await makeComp("comp-c", 400, 200);
  const imported2 = await invoke(["composition", "import", "comp-c", "comp-a", "--project", projDir, "--json"]);
  expect(imported2.code).toBe(0);
  const diverged = await invoke(["layer", "edit", layerId, "--cover-to", "canvas", "--project", projDir, "--json"]);
  expect(diverged.code).toBe(1);
  const body = JSON.parse(diverged.stdout);
  expect(body.ok).toBe(false);
  expect(body.error).toContain("comp-a");
  expect(body.error).toContain("comp-b");
  expect(body.error).toContain("comp-c");
  expect(body.referringCompositions).toEqual(["comp-a", "comp-b", "comp-c"]);
  expect(body.referrersCount).toBe(3);
});

test("layer edit --cover-to canvas on an unreferenced Layer is refused, naming the need for an explicit target", async () => {
  await makeComp("poster", 200, 100);
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(100, 60, RED));
  const added = await addJson("poster", "bg", img);
  expect(added.code).toBe(0);
  const body = JSON.parse(added.stdout);
  const layerId = body.use.layerId as string;

  // Removing the use leaves the Layer document with no referrer.
  const removed = await invoke(["composition", "remove", "poster", "bg", "--project", projDir, "--json"]);
  expect(removed.code).toBe(0);

  const edit = await invoke(["layer", "edit", layerId, "--cover-to", "canvas", "--project", projDir, "--json"]);
  expect(edit.code).toBe(1);
  const refused = JSON.parse(edit.stdout);
  expect(refused.ok).toBe(false);
  expect(refused.error).toContain("--cover-to canvas");
  expect(refused.error).toContain(layerId);
});

// ---------------------------------------------------------------------------
// 3. Mutual exclusion: cover joins the resize family's ONE exclusivity rule,
//    identical refusal on add and edit.
// ---------------------------------------------------------------------------

const EXCLUSIVITY_CASES: [string, string[], string][] = [
  ["--cover-to with --resize", ["--cover-to", "200x100", "--resize", "2"], "--cover-to and --resize are mutually exclusive"],
  ["--cover-to with --resize-to", ["--cover-to", "200x100", "--resize-to", "300x"], "--cover-to and --resize-to are mutually exclusive"],
  ["--cover-to with --scale", ["--cover-to", "200x100", "--scale", "2"], "--cover-to and --scale are mutually exclusive"],
];

test("cover fit is mutually exclusive with the other resize forms on add, with the same refusal as edit", async () => {
  await makeComp("poster", 200, 100);
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(100, 60, RED));

  for (const [name, badArgs, expected] of EXCLUSIVITY_CASES) {
    const add = await addJson("poster", `x-${name.replace(/\W+/g, "-")}`, img, badArgs);
    expect(add.code, name).toBe(2);
    const addBody = JSON.parse(add.stdout);
    expect(addBody.ok, name).toBe(false);
    expect(addBody.error, name).toContain(expected);

    // The same refusal text on the edit surface: the two boundaries share
    // the ONE exclusivity parse and the ONE domain re-check.
    const edit = await invoke(["layer", "edit", "no-such-layer", ...badArgs, "--project", projDir, "--json"]);
    // The edit boundary refuses the family conflict before addressing, so
    // the unknown id never matters here — the family parse runs first.
    expect(edit.code, name).toBe(2);
    const editBody = JSON.parse(edit.stdout);
    expect(editBody.ok, name).toBe(false);
    expect(editBody.error, name).toBe(addBody.error);
  }
});

// ---------------------------------------------------------------------------
// 4. Kind gates: image Layers only (raster and vector); text and shape
//    Layers are refused.
// ---------------------------------------------------------------------------

test("cover fit is refused on text and shape Layers, naming the kinds", async () => {
  await makeComp("poster", 400, 300);
  const textAdd = await invoke([
    "composition", "add", "poster", "headline", "--text", "Groundline", "--font", "Archivo",
    "--project", projDir, "--json",
  ]);
  expect(textAdd.code).toBe(0);
  const textId = JSON.parse(textAdd.stdout).use.layerId as string;
  const textEdit = await invoke(["layer", "edit", textId, "--cover-to", "200x100", "--project", projDir, "--json"]);
  expect(textEdit.code).toBe(1);
  const textBody = JSON.parse(textEdit.stdout);
  expect(textBody.ok).toBe(false);
  expect(textBody.error).toContain("--cover-to");
  expect(textBody.error).toContain("text Layer");

  const shapeAdd = await invoke([
    "composition", "add", "poster", "panel", "--shape", "rectangle", "--size", "40x20", "--fill", "#ff0000",
    "--project", projDir, "--json",
  ]);
  expect(shapeAdd.code).toBe(0);
  const shapeId = JSON.parse(shapeAdd.stdout).use.layerId as string;
  const shapeEdit = await invoke(["layer", "edit", shapeId, "--cover-to", "200x100", "--project", projDir, "--json"]);
  expect(shapeEdit.code).toBe(1);
  const shapeBody = JSON.parse(shapeEdit.stdout);
  expect(shapeBody.ok).toBe(false);
  expect(shapeBody.error).toContain("--cover-to");
  expect(shapeBody.error).toContain("shape Layer");
});

test("layer edit --cover-to canvas with a --fork edit resolves against the destination Composition, overriding divergent referrers", async () => {
  await makeComp("comp-a", 200, 100);
  await makeComp("comp-b", 300, 150);
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(100, 60, RED));
  const added = await addJson("comp-a", "bg", img);
  expect(added.code).toBe(0);
  const layerId = JSON.parse(added.stdout).use.layerId as string;

  // Share the Layer into comp-b: the two referrers' canvases DIVERGE, so a
  // bare edit's --cover-to canvas is refused...
  const imported = await invoke(["composition", "import", "comp-b", "comp-a", "--project", projDir, "--json"]);
  expect(imported.code).toBe(0);
  const bare = await invoke(["layer", "edit", layerId, "--cover-to", "canvas", "--project", projDir, "--json"]);
  expect(bare.code).toBe(1);
  expect(JSON.parse(bare.stdout).referrersCount).toBe(2);

  // ...but a --fork edit names its destination Composition (comp-b, whose
  // use is retargeted): the target canvas is comp-b's 300x150, so the cover
  // scale = max(300/100, 150/60) = 3 — resolved against the destination,
  // never against the divergent referrer set.
  const fork = await invoke([
    "layer", "edit", layerId, "--cover-to", "canvas",
    "--fork", "--composition", "comp-b", "--use", "bg",
    "--project", projDir, "--json",
  ]);
  expect(fork.code).toBe(0);
  const forkBody = JSON.parse(fork.stdout);
  expect(forkBody.fork).toBeDefined();
  expect(forkBody.layer.currentRevision.scaleX).toBe(3);
  expect(forkBody.layer.currentRevision.scaleY).toBe(3);
  // The original Layer's revision is untouched by the fork.
  const original = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(JSON.parse(original.stdout).layer.currentRevision.scaleX).toBe(1);
});

// ---------------------------------------------------------------------------
// 5. Boundary grammar: --cover-to takes "canvas", "<W>x<H>", "<W>x", "x<H>".
// ---------------------------------------------------------------------------

test("invalid --cover-to values are refused with the family's usage wording", async () => {
  await makeComp("poster", 200, 100);
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(100, 60, RED));

  for (const bad of ["banana", "canvasx", "200", ""]) {
    const res = await addJson("poster", `bad-${bad || "empty"}`, img, ["--cover-to", bad]);
    expect(res.code, `--cover-to ${JSON.stringify(bad)}`).toBe(2);
    const body = JSON.parse(res.stdout);
    expect(body.ok).toBe(false);
    expect(body.error, `--cover-to ${JSON.stringify(bad)}`).toContain("--cover-to takes");
  }

  // "0x"/"x0" are well-formed but semantically invalid — refused by the
  // publication path (exit 1), the same split the --resize-to grammar has.
  for (const bad of ["0x", "x0"]) {
    const res = await addJson("poster", `zero-${bad.replace("x", "")}`, img, ["--cover-to", bad]);
    expect(res.code, `--cover-to ${JSON.stringify(bad)}`).toBe(1);
    const body = JSON.parse(res.stdout);
    expect(body.ok).toBe(false);
    expect(body.error, `--cover-to ${JSON.stringify(bad)}`).toContain("Invalid cover target");
  }
});

// ---------------------------------------------------------------------------
// 6. Offline reversibility and replay (TEST-002): the absolute --scale
//    setter reverses a cover fit to a byte-identical render; retained
//    content bytes never change.
// ---------------------------------------------------------------------------

test("a cover fit is reversible: scaling back renders byte-identically and content bytes never change", async () => {
  await makeComp("poster", 200, 100);
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(100, 60, RED));
  const before = await addJson("poster", "bg", img);
  expect(before.code).toBe(0);
  const layerId = JSON.parse(before.stdout).use.layerId as string;

  const baseline = await renderPng("poster", "cover-baseline.png");

  // Cover the canvas: the render changes (the background is now covered).
  const covered = await invoke(["layer", "edit", layerId, "--cover-to", "canvas", "--project", projDir, "--json"]);
  expect(covered.code).toBe(0);
  const coveredBody = JSON.parse(covered.stdout);
  expect(coveredBody.layer.currentRevision.scaleX).toBe(2);
  const afterCover = await renderPng("poster", "cover-after.png");
  expect(Buffer.from(encodePngRgba(afterCover.width, afterCover.height, afterCover.rgba))).not.toEqual(
    Buffer.from(encodePngRgba(baseline.width, baseline.height, baseline.rgba)),
  );

  // Retained content bytes never change across the cover fit.
  const contentHash = JSON.parse(covered.stdout).layer.currentRevision.contentHash;
  expect(contentHash).toBe(JSON.parse(before.stdout).layer.currentRevision.contentHash);

  // The absolute --scale setter reverses the cover: byte-identical replay
  // of the pre-cover render, offline.
  const reverted = await invoke(["layer", "edit", layerId, "--scale", "1", "--project", projDir, "--json"]);
  expect(reverted.code).toBe(0);
  const restored = await renderPng("poster", "cover-restored.png");
  expect(Buffer.from(encodePngRgba(restored.width, restored.height, restored.rgba))).toEqual(
    Buffer.from(encodePngRgba(baseline.width, baseline.height, baseline.rgba)),
  );
});