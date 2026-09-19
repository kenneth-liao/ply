/**
 * Tests for issues #193 and #194: outline raster dilation incorporates
 * Layer scale and supersample, and an outline over Chromium's per-step cap
 * renders via chained dilate steps.
 *
 * Chromium caps each feMorphology dilate step's kernel at 256 px in device
 * raster space (MAX_OUTLINE_DILATE_PX). Outline width is in the Layer's
 * LOCAL px (ADR-0019), painted before the transform, so raster dilation is:
 *   outline.width × max(|scaleX|, |scaleY|) × supersample.
 * outlineDilateSteps chains enough steps to keep each at or under the cap,
 * so the full ring renders at any scale or factor — never a silently
 * clipped ring (ADR-0022).
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  MAX_OUTLINE_DILATE_PX,
  buildCompositionHtml,
  layerMaxScale,
  outlineDilateRadii,
  outlineDilateSteps,
  outlineRasterDilation,
  type SnapshotLayer,
} from "../src/composition-paint.js";
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

test("outlineDilateSteps computes n = ceil(rasterDilation / MAX_OUTLINE_DILATE_PX), minimum 1", () => {
  expect(outlineDilateSteps(100, { scaleX: 1, scaleY: 1 }, 1)).toBe(1);
  expect(outlineDilateSteps(128, { scaleX: 2, scaleY: 1 }, 1)).toBe(1);
  expect(outlineDilateSteps(129, { scaleX: 2, scaleY: 1 }, 1)).toBe(2);
  expect(outlineDilateSteps(200, { scaleX: 2, scaleY: 2 }, 1)).toBe(2); // 400 / 256 = 1.56 -> 2
  expect(outlineDilateSteps(200, { scaleX: 1, scaleY: 1 }, 2)).toBe(2); // 400 / 256 -> 2
  expect(outlineDilateSteps(200, { scaleX: 1, scaleY: 1 }, 4)).toBe(4); // 800 / 256 -> 4
  expect(outlineDilateSteps(256, { scaleX: 2, scaleY: 2 }, 2)).toBe(4); // 1024 / 256 -> 4
});

test("outlineDilateRadii splits width into n steps whose local radii sum to exactly width", () => {
  expect(outlineDilateRadii(100, 1)).toEqual([100]);
  expect(outlineDilateRadii(200, 2)).toEqual([100, 100]);
  expect(outlineDilateRadii(129, 2)).toEqual([64.5, 64.5]);
  expect(outlineDilateRadii(200, 4)).toEqual([50, 50, 50, 50]);

  // Sum is always exactly width
  const radii3 = outlineDilateRadii(200, 3);
  expect(radii3).toHaveLength(3);
  expect(radii3.reduce((a, b) => a + b, 0)).toBe(200);
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

test("probe case 2: scale 2, outline 200, factor 1 renders a 400 ± 1 px ring via chained dilate", async () => {
  // 1200×1200 canvas, 50×50 square at (500, 500), scale 2 -> content box 100×100 [500, 600).
  // Outline 200 local px × scale 2 × factor 1 = 400 raster px > 256.
  // Chained dilate (#194) splits into n = ceil(400/256) = 2 steps [100, 100], rendering a 400 ± 1 px ring.
  const img = path.join(tempDir, "black50.png");
  await writeFile(img, solidPng(50, 50, [0, 0, 0, 255]));
  await invoke(["composition", "create", "comp2", "--width", "1200", "--height", "1200", "--project", projDir]);
  await invoke(["composition", "add", "comp2", "hero", "--image", img, "--x", "500", "--y", "500", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "comp2", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;
  await invoke(["layer", "edit", layerId, "--resize", "2", "--outline", "200,#ff0000", "--project", projDir, "--json"]);

  const out = path.join(tempDir, "probe2.png");
  const renderRes = await invoke(["composition", "render", "comp2", "--project", projDir, "--supersample", "1", "--out", out, "--json"]);
  expect(renderRes.code).toBe(0);

  const png = decodePng(await readFile(out));
  const cy = 550;
  let ringLeft = 0;
  for (let x = 0; x < 500; x++) {
    const i = (cy * png.width + x) * 4;
    if (png.rgba[i]! > 200 && png.rgba[i + 1]! < 50 && png.rgba[i + 2]! < 50 && png.rgba[i + 3]! > 200) {
      ringLeft++;
    }
  }
  expect(ringLeft).toBeGreaterThanOrEqual(399);
  expect(ringLeft).toBeLessThanOrEqual(401);
}, 30000);

test("probe case 3: scale 0.25, outline 200, factor 2 renders a ring of 50 ± 1 px", async () => {
  // 400×400 canvas, 100×100 square at (150, 150), scale 0.25 -> content box 25×25 [150, 175).
  // Outline 200 local px × scale 0.25 × factor 2 = 100 raster px <= 256.
  // Must render and produce a 50 ± 1 px ring.
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
}, 30000);

test("acceptance criterion: outline 200 at scale 1 renders a 200 ± 1 px ring at factors 1, 2, and 4", async () => {
  // 600×600 canvas fits at 4× (2400×2400 <= 4096).
  // 50×50 square at (250, 250), scale 1 -> content box [250, 300).
  // Outline 200 local px -> 200 canvas px ring to left [50, 250).
  const img = path.join(tempDir, "black50-scale1.png");
  await writeFile(img, solidPng(50, 50, [0, 0, 0, 255]));
  await invoke(["composition", "create", "factors", "--width", "600", "--height", "600", "--project", projDir]);
  await invoke(["composition", "add", "factors", "box", "--image", img, "--x", "250", "--y", "250", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "factors", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;
  await invoke(["layer", "edit", layerId, "--outline", "200,#ff0000", "--project", projDir, "--json"]);

  for (const factor of [1, 2, 4]) {
    const out = path.join(tempDir, `factors-${factor}.png`);
    const t0 = performance.now();
    const res = await invoke(["composition", "render", "factors", "--project", projDir, "--supersample", String(factor), "--out", out, "--json"]);
    const elapsed = performance.now() - t0;
    console.log(`[FACTOR-TIMING] factor ${factor}: ${elapsed.toFixed(1)}ms`);
    if (res.code !== 0) console.error("FACTOR", factor, "FAILED:", res.stdout, res.stderr);
    expect(res.code).toBe(0);

    const png = decodePng(await readFile(out));
    expect(png.width).toBe(600);
    expect(png.height).toBe(600);
    const cy = 275;
    let ringLeft = 0;
    for (let x = 0; x < 250; x++) {
      const i = (cy * png.width + x) * 4;
      if (png.rgba[i]! > 200 && png.rgba[i + 1]! < 50 && png.rgba[i + 2]! < 50 && png.rgba[i + 3]! > 200) {
        ringLeft++;
      }
    }
    expect(ringLeft).toBeGreaterThanOrEqual(199);
    expect(ringLeft).toBeLessThanOrEqual(201);
  }
}, 90000);

// ---------------------------------------------------------------------------
// Boundary pinned from MAX_OUTLINE_DILATE_PX constant (including non-uniform scale)
// ---------------------------------------------------------------------------

test("boundary from constant: 256 uses 1 step; 257 and 258 use 2 chained steps and render successfully", async () => {
  // Direct seam check: 256 is 1 step, true edges 257 and 258 are 2 steps
  expect(outlineDilateSteps(MAX_OUTLINE_DILATE_PX, { scaleX: 1, scaleY: 1 }, 1)).toBe(1);
  expect(outlineDilateSteps(MAX_OUTLINE_DILATE_PX + 1, { scaleX: 1, scaleY: 1 }, 1)).toBe(2);
  expect(outlineDilateSteps(MAX_OUTLINE_DILATE_PX + 2, { scaleX: 1, scaleY: 1 }, 1)).toBe(2);

  // Render check: exactly 256, 257, and 258 all render successfully
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

  // Over cap (129 × scale 2 × factor 1 = 258 > 256): renders via chained dilate (#194)
  await invoke(["layer", "edit", layerId, "--outline", `${overCapOutline},#0000ff`, "--project", projDir, "--json"]);
  const overRes = await invoke(["composition", "render", "bnd", "--project", projDir, "--supersample", "1", "--json"]);
  expect(overRes.code).toBe(0);

  // True edge 257 in render pass: 100px outline at scale 2.57 = 257 raster pixels (#194)
  const img257 = path.join(tempDir, "sq257.png");
  await writeFile(img257, solidPng(64, 64, [0, 0, 0, 255]));
  await invoke(["composition", "create", "bnd257", "--width", "400", "--height", "400", "--project", projDir]);
  await invoke(["composition", "add", "bnd257", "item", "--image", img257, "--x", "150", "--y", "150", "--project", projDir]);
  const layerId257 = JSON.parse(
    (await invoke(["composition", "inspect", "bnd257", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;
  await invoke(["layer", "edit", layerId257, "--resize", "2.57", "--outline", "100,#0000ff", "--project", projDir, "--json"]);
  const edge257Res = await invoke(["composition", "render", "bnd257", "--project", projDir, "--supersample", "1", "--json"]);
  expect(edge257Res.code).toBe(0);
}, 30000);

test("rotation and flip do not change outline raster dilation (both at-cap and over-cap render successfully)", async () => {
  const atCapOutline = Math.floor(MAX_OUTLINE_DILATE_PX / 2); // 128
  const overCapOutline = atCapOutline + 1; // 129

  const img = path.join(tempDir, "rot-flip.png");
  await writeFile(img, solidPng(80, 80, [0, 0, 0, 255]));
  await invoke(["composition", "create", "rot-flip", "--width", "500", "--height", "500", "--project", projDir]);
  await invoke(["composition", "add", "rot-flip", "hero", "--image", img, "--x", "200", "--y", "200", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "rot-flip", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;

  // Apply scale 2 with 45° rotation and both horizontal and vertical flips (INT-1)
  await invoke([
    "layer", "edit", layerId,
    "--resize", "2",
    "--rotate", "45",
    "--flip", "both",
    "--project", projDir,
    "--json",
  ]);

  // At-cap (128 × scale 2 × factor 1 = 256): renders successfully
  await invoke(["layer", "edit", layerId, "--outline", `${atCapOutline},#0000ff`, "--project", projDir, "--json"]);
  const atCapRes = await invoke(["composition", "render", "rot-flip", "--project", projDir, "--supersample", "1", "--json"]);
  expect(atCapRes.code).toBe(0);

  // Over-cap (129 × scale 2 × factor 1 = 258): renders successfully via chained dilate (#194)
  await invoke(["layer", "edit", layerId, "--outline", `${overCapOutline},#0000ff`, "--project", projDir, "--json"]);
  const overRes = await invoke(["composition", "render", "rot-flip", "--project", projDir, "--supersample", "1", "--json"]);
  expect(overRes.code).toBe(0);
}, 30000);

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

  // over cap: 129 * max(2, 1) = 258 -> renders successfully via chained dilate
  await invoke(["layer", "edit", layerId, "--outline", `${overCapOutline},#0000ff`, "--project", projDir, "--json"]);
  const res1Over = await invoke(["composition", "render", "nonuniform", "--project", projDir, "--supersample", "1", "--json"]);
  expect(res1Over.code).toBe(0);

  // Case 2: scaleX = 1, scaleY = 2 (--resize-to 100x200)
  await invoke(["layer", "edit", layerId, "--resize-to", "100x200", "--outline", `${atCapOutline},#0000ff`, "--project", projDir, "--json"]);
  const res2At = await invoke(["composition", "render", "nonuniform", "--project", projDir, "--supersample", "1", "--json"]);
  expect(res2At.code).toBe(0);

  await invoke(["layer", "edit", layerId, "--outline", `${overCapOutline},#0000ff`, "--project", projDir, "--json"]);
  const res2Over = await invoke(["composition", "render", "nonuniform", "--project", projDir, "--supersample", "1", "--json"]);
  expect(res2Over.code).toBe(0);
}, 30000);

test("fractional radii geometry: outline 129 at scale 2 renders a 258 ± 1 px ring via chained dilate", async () => {
  // 800×800 canvas, 50×50 square at (350, 350), scale 2 -> content box 100×100 [350, 450).
  // Outline 129 local px × scale 2 × factor 1 = 258 raster px > 256.
  // n = ceil(258/256) = 2 steps, emitting fractional local radii [64.5, 64.5].
  // Rendered ring extends exactly 129 × 2 = 258 canvas px to the left: [350 - 258, 350) = [92, 350).
  const img = path.join(tempDir, "fractional-sq.png");
  await writeFile(img, solidPng(50, 50, [0, 0, 0, 255]));
  await invoke(["composition", "create", "frac-comp", "--width", "800", "--height", "800", "--project", projDir]);
  await invoke(["composition", "add", "frac-comp", "hero", "--image", img, "--x", "350", "--y", "350", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "frac-comp", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;
  await invoke(["layer", "edit", layerId, "--resize", "2", "--outline", "129,#ff0000", "--project", projDir, "--json"]);

  const out = path.join(tempDir, "fractional-render.png");
  const renderRes = await invoke(["composition", "render", "frac-comp", "--project", projDir, "--supersample", "1", "--out", out, "--json"]);
  expect(renderRes.code).toBe(0);

  const png = decodePng(await readFile(out));
  const cy = 400;
  let ringLeft = 0;
  for (let x = 0; x < 350; x++) {
    const i = (cy * png.width + x) * 4;
    if (png.rgba[i]! > 200 && png.rgba[i + 1]! < 50 && png.rgba[i + 2]! < 50 && png.rgba[i + 3]! > 200) {
      ringLeft++;
    }
  }
  // Expected ring: 258 ± 1 px
  expect(ringLeft).toBeGreaterThanOrEqual(257);
  expect(ringLeft).toBeLessThanOrEqual(259);
}, 30000);

// ---------------------------------------------------------------------------
// Replay with chained dilate
// ---------------------------------------------------------------------------

test("replay succeeds with chained dilate when recorded manifest factor increases raster dilation past cap", async () => {
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
  // Chained dilate renders successfully at factor 2 (#194).
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.supersample = 2;
  const tamperedPath = path.join(projDir, "renders", "tampered-scale.manifest.json");
  await writeFile(tamperedPath, JSON.stringify(manifest, null, 2) + "\n");

  const replayRes = await invoke(["composition", "replay", tamperedPath, "--project", projDir, "--json"]);
  expect(replayRes.code).toBe(0);
}, 30000);

// ---------------------------------------------------------------------------
// Measurement path with chained dilate
// ---------------------------------------------------------------------------

test("measurement path measures chained outline dilation without clipping, agreeing with rendered ink", async () => {
  const img = path.join(tempDir, "measure.png");
  await writeFile(img, solidPng(50, 50, [50, 50, 50, 255]));
  await invoke(["composition", "create", "measure-clip", "--width", "800", "--height", "800", "--project", projDir]);
  await invoke(["composition", "add", "measure-clip", "hero", "--image", img, "--x", "300", "--y", "300", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "measure-clip", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;
  // Scale 2, outline 200 -> raster dilation at 1x is 400 > 256.
  // Measurement now measures the full unclipped ring via chained dilate (#194).
  await invoke(["layer", "edit", layerId, "--resize", "2", "--outline", "200,#0000ff", "--project", projDir, "--json"]);

  const measureRes = await invoke(["composition", "measure", "measure-clip", "--project", projDir, "--json"]);
  expect(measureRes.code).toBe(0);
  const layer = JSON.parse(measureRes.stdout).layers[0];
  // Content: 50×50 at scale 2 -> box 100×100 at (300, 300).
  // Outline: 200 local px × scale 2 = 400 canvas px dilation in every direction.
  // Painted ink: [300 - 400, 300 - 400, 100 + 800, 100 + 800] = [-100, -100, 900, 900].
  expect(layer.box).toEqual({ x: 300, y: 300, width: 100, height: 100 });
  expect(layer.painted.x).toBeCloseTo(-100, 0);
  expect(layer.painted.y).toBeCloseTo(-100, 0);
  expect(layer.painted.width).toBeCloseTo(900, 0);
  expect(layer.painted.height).toBeCloseTo(900, 0);

  // Render check: unclipped rendered ink footprint agrees with measurement
  const out = path.join(tempDir, "measure-render.png");
  const renderRes = await invoke(["composition", "render", "measure-clip", "--project", projDir, "--supersample", "1", "--out", out, "--json"]);
  expect(renderRes.code).toBe(0);
  const png = decodePng(await readFile(out));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (y * png.width + x) * 4;
      if (png.rgba[idx + 3]! > 0) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  // Render is on 800×800 canvas, so [-100..900) clips to [0..800)
  expect(layer.paintedOnCanvas).toEqual({ x: 0, y: 0, width: 800, height: 800 });
  expect(minX).toBe(0);
  expect(minY).toBe(0);
  expect(maxX - minX + 1).toBe(800);
  expect(maxY - minY + 1).toBe(800);

  // Differing-n agreement (INT-6): at factor 2, raster dilation is 200 × 2 × 2 = 800 px -> n_render = 4
  // Measurement measured at 1x with n_measure = 2. Footprints still agree exactly.
  const outF2 = path.join(tempDir, "measure-render-f2.png");
  const renderResF2 = await invoke(["composition", "render", "measure-clip", "--project", projDir, "--supersample", "2", "--out", outF2, "--json"]);
  expect(renderResF2.code).toBe(0);
  const pngF2 = decodePng(await readFile(outF2));
  expect(pngF2.width).toBe(800);
  expect(pngF2.height).toBe(800);
  let minX2 = Infinity, minY2 = Infinity, maxX2 = -Infinity, maxY2 = -Infinity;
  for (let y = 0; y < pngF2.height; y++) {
    for (let x = 0; x < pngF2.width; x++) {
      const idx = (y * pngF2.width + x) * 4;
      if (pngF2.rgba[idx + 3]! > 0) {
        minX2 = Math.min(minX2, x); maxX2 = Math.max(maxX2, x);
        minY2 = Math.min(minY2, y); maxY2 = Math.max(maxY2, y);
      }
    }
  }
  expect(minX2).toBe(0);
  expect(minY2).toBe(0);
  expect(maxX2 - minX2 + 1).toBe(800);
  expect(maxY2 - minY2 + 1).toBe(800);
}, 30000);

test("measurement agrees with rendered ink when supersample factor causes differing n (n=1 at 1x vs n=2 at 2x)", async () => {
  // Unclipped differing-n geometry (INT-6):
  // 600×600 canvas, 60×60 square at (270, 270), scale 1, outline 150 local px.
  // Measurement at 1x: 150 raster px <= 256 -> n_measure = 1.
  // Painted extents: [270 - 150, 270 - 150, 60 + 300, 60 + 300] = [120, 120, 360, 360].
  // Render at factor 2: 150 × 2 = 300 raster px > 256 -> n_render = 2 (chained dilate).
  // Rendered ink bounds after downsampling must agree with measurement within <= 1 px tolerance.
  const img = path.join(tempDir, "agree-diff-n.png");
  await writeFile(img, solidPng(60, 60, [0, 0, 255, 255]));
  await invoke(["composition", "create", "agree-comp", "--width", "600", "--height", "600", "--project", projDir]);
  await invoke(["composition", "add", "agree-comp", "hero", "--image", img, "--x", "270", "--y", "270", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "agree-comp", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;
  await invoke(["layer", "edit", layerId, "--outline", "150,#ff0000", "--project", projDir, "--json"]);

  const measureRes = await invoke(["composition", "measure", "agree-comp", "--project", projDir, "--json"]);
  expect(measureRes.code).toBe(0);
  const layer = JSON.parse(measureRes.stdout).layers[0];
  expect(layer.painted).toEqual({ x: 120, y: 120, width: 360, height: 360 });
  expect(layer.clipped).toBe(false);

  const out = path.join(tempDir, "agree-diff-n-render.png");
  const renderRes = await invoke(["composition", "render", "agree-comp", "--project", projDir, "--supersample", "2", "--out", out, "--json"]);
  expect(renderRes.code).toBe(0);
  const png = decodePng(await readFile(out));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (y * png.width + x) * 4;
      if (png.rgba[idx + 3]! > 0) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  // Agreement within <= 1 px tolerance
  expect(minX).toBeGreaterThanOrEqual(119);
  expect(minX).toBeLessThanOrEqual(121);
  expect(minY).toBeGreaterThanOrEqual(119);
  expect(minY).toBeLessThanOrEqual(121);
  expect(maxX - minX + 1).toBeGreaterThanOrEqual(359);
  expect(maxX - minX + 1).toBeLessThanOrEqual(361);
  expect(maxY - minY + 1).toBeGreaterThanOrEqual(359);
  expect(maxY - minY + 1).toBeLessThanOrEqual(361);
}, 30000);

// ---------------------------------------------------------------------------
// Byte-identity and markup pin for n = 1
// ---------------------------------------------------------------------------

test("outlines with n = 1 produce byte-identical markup to single-dilate filter def, and replays are byte-identical", async () => {
  const img = path.join(tempDir, "byte-id.png");
  await writeFile(img, solidPng(50, 50, [100, 150, 200, 255]));
  await invoke(["composition", "create", "byte-comp", "--width", "400", "--height", "400", "--project", projDir]);
  await invoke(["composition", "add", "byte-comp", "hero", "--image", img, "--x", "150", "--y", "150", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "byte-comp", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;
  await invoke(["layer", "edit", layerId, "--outline", "50,#ff0000", "--project", projDir, "--json"]);

  const out1 = path.join(tempDir, "render-n1.png");
  const renderRes = await invoke(["composition", "render", "byte-comp", "--project", projDir, "--supersample", "1", "--out", out1, "--json"]);
  expect(renderRes.code).toBe(0);
  const manifestPath = JSON.parse(renderRes.stdout).render.manifest;

  const replayOut = path.join(tempDir, "replay-n1.png");
  const replayRes = await invoke(["composition", "replay", manifestPath, "--project", projDir, "--out", replayOut, "--json"]);
  expect(replayRes.code).toBe(0);

  const bytes1 = await readFile(out1);
  const bytesReplay = await readFile(replayOut);
  expect(bytesReplay.equals(bytes1)).toBe(true);
}, 30000);

test("n = 1 outlined layer markup matches the canonical single-dilate filter def exactly", () => {
  // INT-4: Pin the exact n = 1 markup string from buildCompositionHtml against the legacy single-node shape
  const layer: SnapshotLayer = {
    name: "hero",
    layerId: "layer-1",
    revision: {
      revisionId: "rev-1",
      kind: "image",
      contentHash: "hash1",
      x: 50,
      y: 50,
      opacity: 1,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      flipX: false,
      flipY: false,
      outline: { width: 42, color: "#00ff00" },
    } as any,
    contentBytes: Buffer.from([]),
  };
  const html = buildCompositionHtml({ width: 200, height: 200 }, [layer], 1);
  // Pinned n = 1 markup: single feMorphology with in="SourceAlpha" and result="dil", no chained dil_N nodes
  expect(html).toContain('<feMorphology in="SourceAlpha" operator="dilate" radius="42" result="dil"/>');
  expect(html).toContain('<feFlood flood-color="#00ff00" result="flood"/>');
  expect(html).toContain('<feComposite in="flood" in2="dil" operator="in" result="ring"/>');
  expect(html).toContain('<feMerge><feMergeNode in="ring"/><feMergeNode in="SourceGraphic"/></feMerge>');
  expect(html).not.toContain("dil_1");
  expect(html).not.toContain("dil_2");
});
