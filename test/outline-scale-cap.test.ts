/**
 * Tests for issue #193: outline-cap check incorporates Layer scale.
 *
 * Chromium caps the feMorphology dilate kernel at 256 px in device raster space
 * (MAX_OUTLINE_DILATE_PX). Outline width is in the Layer's LOCAL px (ADR-0019),
 * painted before the transform, so raster dilation is:
 *   outline.width × max(|scaleX|, |scaleY|) × supersample.
 *
 * Neither silent clipping (scaled-up Layer) nor false refusal (scaled-down Layer)
 * is permitted (ADR-0022).
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MAX_OUTLINE_DILATE_PX, layerMaxScale, outlineRasterDilation } from "../src/composition-paint.js";
import { encodePngRgba, decodePng } from "../src/png.js";

let tempDir: string;
let projDir: string;
const cli = path.resolve(import.meta.dir, "../src/cli.ts");

async function invoke(args: string[]) {
  const result = Bun.spawn([process.execPath, cli, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
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

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-outline-scale-cap-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "scale-cap-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function solidPng(width: number, height: number, rgba_: [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgba_[0]; buf[i + 1] = rgba_[1]; buf[i + 2] = rgba_[2]; buf[i + 3] = rgba_[3];
  }
  return encodePngRgba(width, height, buf);
}

// ---------------------------------------------------------------------------
// Unit seam: layerMaxScale and outlineRasterDilation
// ---------------------------------------------------------------------------

test("layerMaxScale returns max(|scaleX|, |scaleY|) from revision facts", () => {
  expect(layerMaxScale({ scaleX: 1, scaleY: 1 })).toBe(1);
  expect(layerMaxScale({ scaleX: 2, scaleY: 1 })).toBe(2);
  expect(layerMaxScale({ scaleX: 1, scaleY: 3 })).toBe(3);
  expect(layerMaxScale({ scaleX: 0.25, scaleY: 0.5 })).toBe(0.5);
  expect(layerMaxScale({ scaleX: -2, scaleY: 1 })).toBe(2);
  expect(layerMaxScale({ scaleX: 1, scaleY: -3 })).toBe(3);
});

test("outlineRasterDilation computes width × max(|scaleX|, |scaleY|) × supersample", () => {
  expect(outlineRasterDilation(100, { scaleX: 0.5, scaleY: 0.5 }, 1)).toBe(50);
  expect(outlineRasterDilation(200, { scaleX: 2, scaleY: 2 }, 1)).toBe(400);
  expect(outlineRasterDilation(200, { scaleX: 0.25, scaleY: 0.25 }, 2)).toBe(100);
  expect(outlineRasterDilation(128, { scaleX: 2, scaleY: 1 }, 1)).toBe(256);
  expect(outlineRasterDilation(128, { scaleX: 1, scaleY: 2 }, 1)).toBe(256);
});

// ---------------------------------------------------------------------------
// Pinned probe cases from issue #193
// ---------------------------------------------------------------------------

test("probe case 1: scale 0.5, outline 100, factor 1 renders a ring of 50 ± 1 px", async () => {
  // 400×400 canvas, 100×100 square at (150, 150), scale 0.5 -> content box 50×50 [150, 200).
  // Outline 100 local px -> 50 canvas px. Factor 1.
  const img = path.join(tempDir, "black100.png");
  await writeFile(img, solidPng(100, 100, [0, 0, 0, 255]));
  await invoke(["composition", "create", "comp1", "--width", "400", "--height", "400", "--project", projDir]);
  await invoke(["composition", "add", "comp1", "square", "--image", img, "--x", "150", "--y", "150", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "comp1", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;
  await invoke(["layer", "edit", layerId, "--resize", "0.5", "--outline", "100,#ff0000", "--project", projDir, "--json"]);

  const out = path.join(tempDir, "probe1.png");
  const renderRes = await invoke(["composition", "render", "comp1", "--project", projDir, "--supersample", "1", "--out", out, "--json"]);
  expect(renderRes.code).toBe(0);

  const png = decodePng(await readFile(out));
  // Measure ring on center row y = 175
  const cy = 175;
  let ringLeft = 0;
  for (let x = 0; x < 150; x++) {
    const i = (cy * png.width + x) * 4;
    // Check if pixel is red outline (r > 200, g < 50, b < 50, a > 200)
    if (png.rgba[i]! > 200 && png.rgba[i + 1]! < 50 && png.rgba[i + 2]! < 50 && png.rgba[i + 3]! > 200) {
      ringLeft++;
    }
  }
  // Expected ring: 50 ± 1 px
  expect(ringLeft).toBeGreaterThanOrEqual(49);
  expect(ringLeft).toBeLessThanOrEqual(51);
});

test("probe case 2: scale 2, outline 200, factor 1 is refused loudly, naming all facts", async () => {
  // 400×400 canvas, 100×100 square at (150, 150), scale 2.
  // Outline 200 local px × scale 2 × factor 1 = 400 raster px > 256.
  // Must NOT silently clip to 256; must refuse before painting.
  const img = path.join(tempDir, "black100.png");
  await writeFile(img, solidPng(100, 100, [0, 0, 0, 255]));
  await invoke(["composition", "create", "comp2", "--width", "400", "--height", "400", "--project", projDir]);
  await invoke(["composition", "add", "comp2", "hero", "--image", img, "--x", "150", "--y", "150", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "comp2", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;
  await invoke(["layer", "edit", layerId, "--resize", "2", "--outline", "200,#ff0000", "--project", projDir, "--json"]);

  const renderRes = await invoke(["composition", "render", "comp2", "--project", projDir, "--supersample", "1", "--json"]);
  expect(renderRes.code).toBe(1);
  const err = JSON.parse(renderRes.stdout).error;
  expect(err).toContain("hero");
  expect(err).toContain("200px outline");
  expect(err).toContain("scale 2");
  expect(err).toContain("supersample 1");
  expect(err).toContain("400 raster pixels");
  expect(err).toContain(`${MAX_OUTLINE_DILATE_PX}px`);
  expect(err).toContain("smaller factor");
  expect(err).toContain("thinner outline");
  expect(err).toContain("smaller Layer scale");

  // No output published
  expect((await readdir(path.join(projDir, "renders"))).filter((f) => f.endsWith(".png"))).toHaveLength(0);
});

test("probe case 3: scale 0.25, outline 200, factor 2 renders a ring of 50 ± 1 px", async () => {
  // 400×400 canvas, 100×100 square at (150, 150), scale 0.25 -> content box 25×25 [150, 175).
  // Outline 200 local px × scale 0.25 × factor 2 = 100 raster px <= 256.
  // Must render (not falsely refused) and produce a 50 ± 1 px ring.
  const img = path.join(tempDir, "black100.png");
  await writeFile(img, solidPng(100, 100, [0, 0, 0, 255]));
  await invoke(["composition", "create", "comp3", "--width", "400", "--height", "400", "--project", projDir]);
  await invoke(["composition", "add", "comp3", "square", "--image", img, "--x", "150", "--y", "150", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "comp3", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;
  await invoke(["layer", "edit", layerId, "--resize", "0.25", "--outline", "200,#ff0000", "--project", projDir, "--json"]);

  const out = path.join(tempDir, "probe3.png");
  const renderRes = await invoke(["composition", "render", "comp3", "--project", projDir, "--out", out, "--json"]);
  expect(renderRes.code).toBe(0);

  const png = decodePng(await readFile(out));
  // Square is [150, 175), center row cy = 162
  const cy = 162;
  let ringLeft = 0;
  for (let x = 0; x < 150; x++) {
    const i = (cy * png.width + x) * 4;
    if (png.rgba[i]! > 200 && png.rgba[i + 1]! < 50 && png.rgba[i + 2]! < 50 && png.rgba[i + 3]! > 200) {
      ringLeft++;
    }
  }
  // In canvas pixels: 200 local px × 0.25 = 50 canvas px.
  expect(ringLeft).toBeGreaterThanOrEqual(49);
  expect(ringLeft).toBeLessThanOrEqual(51);
});

// ---------------------------------------------------------------------------
// Boundary pinned from MAX_OUTLINE_DILATE_PX constant (including non-uniform scale)
// ---------------------------------------------------------------------------

test("boundary from constant: exactly 256 raster dilation renders; 258 is refused", async () => {
  const atCapOutline = Math.floor(MAX_OUTLINE_DILATE_PX / 2); // 128
  const overCapOutline = atCapOutline + 1; // 129 -> 129 * 2 = 258

  const img = path.join(tempDir, "sq.png");
  await writeFile(img, solidPng(64, 64, [0, 0, 0, 255]));
  await invoke(["composition", "create", "bnd", "--width", "400", "--height", "400", "--project", projDir]);
  await invoke(["composition", "add", "bnd", "item", "--image", img, "--x", "150", "--y", "150", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "bnd", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;
  await invoke(["layer", "edit", layerId, "--resize", "2", "--project", projDir, "--json"]);

  // Exactly at cap (128 × scale 2 × factor 1 = 256)
  await invoke(["layer", "edit", layerId, "--outline", `${atCapOutline},#0000ff`, "--project", projDir, "--json"]);
  const atCapRes = await invoke(["composition", "render", "bnd", "--project", projDir, "--supersample", "1", "--json"]);
  expect(atCapRes.code).toBe(0);

  // Over cap (129 × scale 2 × factor 1 = 258 > 256)
  await invoke(["layer", "edit", layerId, "--outline", `${overCapOutline},#0000ff`, "--project", projDir, "--json"]);
  const overRes = await invoke(["composition", "render", "bnd", "--project", projDir, "--supersample", "1", "--json"]);
  expect(overRes.code).toBe(1);
  expect(JSON.parse(overRes.stdout).error).toContain("258 raster pixels");
});

test("boundary covers non-uniform scale (scaleX != scaleY takes the larger)", async () => {
  const atCapOutline = Math.floor(MAX_OUTLINE_DILATE_PX / 2); // 128
  const overCapOutline = atCapOutline + 1; // 129

  const img = path.join(tempDir, "sq100.png");
  await writeFile(img, solidPng(100, 100, [0, 0, 0, 255]));
  await invoke(["composition", "create", "nonuniform", "--width", "600", "--height", "600", "--project", projDir]);
  await invoke(["composition", "add", "nonuniform", "item", "--image", img, "--x", "200", "--y", "200", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "nonuniform", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;

  // Case 1: scaleX = 2, scaleY = 1 (--resize-to 200x100)
  await invoke(["layer", "edit", layerId, "--resize-to", "200x100", "--project", projDir, "--json"]);
  // at cap: 128 * max(2, 1) = 256
  await invoke(["layer", "edit", layerId, "--outline", `${atCapOutline},#0000ff`, "--project", projDir, "--json"]);
  const res1At = await invoke(["composition", "render", "nonuniform", "--project", projDir, "--supersample", "1", "--json"]);
  expect(res1At.code).toBe(0);

  // over cap: 129 * max(2, 1) = 258
  await invoke(["layer", "edit", layerId, "--outline", `${overCapOutline},#0000ff`, "--project", projDir, "--json"]);
  const res1Over = await invoke(["composition", "render", "nonuniform", "--project", projDir, "--supersample", "1", "--json"]);
  expect(res1Over.code).toBe(1);
  const err1 = JSON.parse(res1Over.stdout).error;
  expect(err1).toContain("258 raster pixels");
  expect(err1).toContain("scale 2×1");

  // Case 2: scaleX = 1, scaleY = 2 (--resize-to 100x200)
  await invoke(["layer", "edit", layerId, "--resize-to", "100x200", "--outline", `${atCapOutline},#0000ff`, "--project", projDir, "--json"]);
  const res2At = await invoke(["composition", "render", "nonuniform", "--project", projDir, "--supersample", "1", "--json"]);
  expect(res2At.code).toBe(0);

  await invoke(["layer", "edit", layerId, "--outline", `${overCapOutline},#0000ff`, "--project", projDir, "--json"]);
  const res2Over = await invoke(["composition", "render", "nonuniform", "--project", projDir, "--supersample", "1", "--json"]);
  expect(res2Over.code).toBe(1);
  const err2 = JSON.parse(res2Over.stdout).error;
  expect(err2).toContain("258 raster pixels");
  expect(err2).toContain("scale 1×2");
});

// ---------------------------------------------------------------------------
// Replay refusal
// ---------------------------------------------------------------------------

test("replay refuses a manifest whose recorded Composition would clip, publishing nothing", async () => {
  const img = path.join(tempDir, "sq.png");
  await writeFile(img, solidPng(50, 50, [10, 20, 30, 255]));
  await invoke(["composition", "create", "replay-clip", "--width", "400", "--height", "400", "--project", projDir]);
  await invoke(["composition", "add", "replay-clip", "hero", "--image", img, "--x", "100", "--y", "100", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "replay-clip", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;
  // Legal at factor 1: scale 2, outline 100 -> 100 × 2 × 1 = 200 raster px <= 256
  await invoke(["layer", "edit", layerId, "--resize", "2", "--outline", "100,#0000ff", "--project", projDir, "--json"]);
  const renderRes = await invoke(["composition", "render", "replay-clip", "--project", projDir, "--supersample", "1", "--json"]);
  expect(renderRes.code).toBe(0);
  const manifestPath = JSON.parse(renderRes.stdout).render.manifest;

  // Tamper the manifest supersample to 2: scale 2, outline 100, supersample 2 -> 400 raster px > 256
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.supersample = 2;
  const tamperedPath = path.join(projDir, "renders", "tampered-scale.manifest.json");
  await writeFile(tamperedPath, JSON.stringify(manifest, null, 2) + "\n");

  const beforePngs = (await readdir(path.join(projDir, "renders"))).filter((f) => f.endsWith(".png")).length;
  const replayRes = await invoke(["composition", "replay", tamperedPath, "--project", projDir, "--json"]);
  expect(replayRes.code).toBe(1);
  expect(JSON.parse(replayRes.stdout).error).toContain("400 raster pixels");
  expect(JSON.parse(replayRes.stdout).error).toContain("scale 2");
  expect(JSON.parse(replayRes.stdout).error).toContain("dilate cap");

  // Nothing was published
  const afterPngs = (await readdir(path.join(projDir, "renders"))).filter((f) => f.endsWith(".png")).length;
  expect(afterPngs).toBe(beforePngs);
});

// ---------------------------------------------------------------------------
// Measurement path refusal
// ---------------------------------------------------------------------------

test("measurement path refuses when outline dilation exceeds cap, never reporting a clipped ring", async () => {
  const img = path.join(tempDir, "measure.png");
  await writeFile(img, solidPng(50, 50, [50, 50, 50, 255]));
  await invoke(["composition", "create", "measure-clip", "--width", "400", "--height", "400", "--project", projDir]);
  await invoke(["composition", "add", "measure-clip", "hero", "--image", img, "--x", "100", "--y", "100", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "measure-clip", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;
  // Scale 2, outline 200 -> raster dilation at 1x is 400 > 256
  await invoke(["layer", "edit", layerId, "--resize", "2", "--outline", "200,#0000ff", "--project", projDir, "--json"]);

  const measureRes = await invoke(["composition", "measure", "measure-clip", "--project", projDir, "--json"]);
  expect(measureRes.code).toBe(1);
  const err = JSON.parse(measureRes.stdout).error;
  expect(err).toContain("hero");
  expect(err).toContain("400 raster pixels");
  expect(err).toContain("dilate cap");
});
