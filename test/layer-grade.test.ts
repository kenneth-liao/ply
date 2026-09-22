/**
 * Layer grade: brightness, contrast, saturation, warmth (#219, spec #218
 * US-001, DEC-001..005, DEC-009..011, TEST-001/002/008, ADR-0024).
 *
 * Verifies through the public CLI and rendered-pixel seams:
 * - Four absolute setters: --brightness, --contrast, --saturation (each [0, 5],
 *   neutral 1), and --warmth ([-1, 1], neutral 0).
 * - Revision facts stored only when set; neutral value removes the stored fact;
 *   omitted keeps across edits. A neutral-only Layer renders byte-identically
 *   to an ungraded one.
 * - Refusal before publication for out-of-range or non-numeric values, naming
 *   the control and its range.
 * - On flat-colour fixtures, each control moves a known pixel in the documented
 *   direction: brighter is brighter, darker is darker, contrast expands/contracts,
 *   warmth raises red relative to blue for positive and the reverse for negative.
 * - Alpha is unchanged everywhere; painted extents, anchored placement, and
 *   clipped equal the ungraded values.
 * - Outline and shadow colours are unaffected by the grade (applied to content only).
 * - inspect, measure, and layer review report effective controls; shared Layers
 *   obey in-place/fork intent.
 * - Retained Render replays byte-identically after later edits.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { encodePngRgba, decodePng } from "../src/png.js";
import { normalizeStoredGrade } from "../src/layer.js";

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

function dualGreyPng(width: number, height: number, leftGrey: number, rightGrey: number): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  const midX = Math.floor(width / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const g = x < midX ? leftGrey : rightGrey;
      buf[i] = g;
      buf[i + 1] = g;
      buf[i + 2] = g;
      buf[i + 3] = 255;
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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-grade-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "grade-test-proj"]);
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

async function addTextLayer(comp: string, localName: string, text: string, opts: { font?: string; fontSize?: number; color?: string; x?: number; y?: number } = {}) {
  const args = ["composition", "add", comp, localName, "--text", text, "--font", opts.font ?? "Anton", "--project", projDir, "--json"];
  if (opts.fontSize !== undefined) args.push("--font-size", String(opts.fontSize));
  if (opts.color !== undefined) args.push("--color", opts.color);
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

async function addShapeLayer(comp: string, localName: string, shape: string, opts: { size?: string; fill?: string; x?: number; y?: number } = {}) {
  const args = ["composition", "add", comp, localName, "--shape", shape, "--project", projDir, "--json"];
  if (opts.size !== undefined) args.push("--size", opts.size);
  if (opts.fill !== undefined) args.push("--fill", opts.fill);
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

test("normalizeStoredGrade rejects unknown properties loudly (INT-1)", () => {
  expect(() => normalizeStoredGrade({ grade: { brightness: 1.5, bogus: 1 } })).toThrow(
    /Malformed revision document: unknown grade property "bogus"/,
  );
});

test("grade controls validate ranges and refuse out-of-range or non-numeric before publication", async () => {
  const imgFile = path.join(tempDir, "grey.png");
  await writeFile(imgFile, solidPng(100, 100, [128, 128, 128, 255]));
  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", imgFile, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  // Brightness: 0..5
  const bLow = await invoke(["layer", "edit", layerId, "--brightness=-0.1", "--project", projDir]);
  expect(bLow.code).toBe(2);
  expect(bLow.stderr).toContain("Brightness (--brightness) must be a finite number between 0 and 5");

  const bHigh = await invoke(["layer", "edit", layerId, "--brightness", "5.1", "--project", projDir]);
  expect(bHigh.code).toBe(2);
  expect(bHigh.stderr).toContain("Brightness (--brightness) must be a finite number between 0 and 5");

  const bNaN = await invoke(["layer", "edit", layerId, "--brightness", "abc", "--project", projDir]);
  expect(bNaN.code).toBe(2);
  expect(bNaN.stderr).toContain("Brightness (--brightness) must be a finite number between 0 and 5");

  // Contrast: 0..5
  const cLow = await invoke(["layer", "edit", layerId, "--contrast=-0.01", "--project", projDir]);
  expect(cLow.code).toBe(2);
  expect(cLow.stderr).toContain("Contrast (--contrast) must be a finite number between 0 and 5");

  const cHigh = await invoke(["layer", "edit", layerId, "--contrast", "5.01", "--project", projDir]);
  expect(cHigh.code).toBe(2);
  expect(cHigh.stderr).toContain("Contrast (--contrast) must be a finite number between 0 and 5");

  const cNaN = await invoke(["layer", "edit", layerId, "--contrast", "xyz", "--project", projDir]);
  expect(cNaN.code).toBe(2);
  expect(cNaN.stderr).toContain("Contrast (--contrast) must be a finite number between 0 and 5");

  // Saturation: 0..5
  const sLow = await invoke(["layer", "edit", layerId, "--saturation=-0.5", "--project", projDir]);
  expect(sLow.code).toBe(2);
  expect(sLow.stderr).toContain("Saturation (--saturation) must be a finite number between 0 and 5");

  const sHigh = await invoke(["layer", "edit", layerId, "--saturation", "6", "--project", projDir]);
  expect(sHigh.code).toBe(2);
  expect(sHigh.stderr).toContain("Saturation (--saturation) must be a finite number between 0 and 5");

  const sNaN = await invoke(["layer", "edit", layerId, "--saturation", "foo", "--project", projDir]);
  expect(sNaN.code).toBe(2);
  expect(sNaN.stderr).toContain("Saturation (--saturation) must be a finite number between 0 and 5");

  // Warmth: -1..1 (dashNumeric join supports negative without equals)
  const wLow = await invoke(["layer", "edit", layerId, "--warmth", "-1.1", "--project", projDir]);
  expect(wLow.code).toBe(2);
  expect(wLow.stderr).toContain("Warmth (--warmth) must be a finite number between -1 and 1");

  const wHigh = await invoke(["layer", "edit", layerId, "--warmth", "1.1", "--project", projDir]);
  expect(wHigh.code).toBe(2);
  expect(wHigh.stderr).toContain("Warmth (--warmth) must be a finite number between -1 and 1");

  const wNaN = await invoke(["layer", "edit", layerId, "--warmth", "bar", "--project", projDir]);
  expect(wNaN.code).toBe(2);
  expect(wNaN.stderr).toContain("Warmth (--warmth) must be a finite number between -1 and 1");

  // Same validation on composition add
  const addErr = await invoke([
    "composition", "add", "poster", "invalid", "--image", imgFile, "--brightness", "10", "--project", projDir,
  ]);
  expect(addErr.code).toBe(2);
  expect(addErr.stderr).toContain("Brightness (--brightness) must be a finite number between 0 and 5");
});

test("grade controls store facts only when set, keep omitted, remove when neutral, and neutral renders byte-identically", async () => {
  const imgFile = path.join(tempDir, "midgrey.png");
  await writeFile(imgFile, solidPng(100, 100, [128, 128, 128, 255]));
  await makeComp("poster", 400, 300);

  const baselineOut = path.join(tempDir, "baseline.png");
  const addRes = await addImageLayer("poster", "hero", imgFile, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  // Baseline render before any grading
  expect((await invoke(["composition", "render", "poster", "--project", projDir, "--out", baselineOut, "--json"])).code).toBe(0);
  const baselineBytes = await readFile(baselineOut);

  // Set all four controls
  const edit1 = await invoke([
    "layer", "edit", layerId,
    "--brightness", "1.4",
    "--contrast", "1.2",
    "--saturation", "1.5",
    "--warmth", "0.3",
    "--project", projDir,
    "--json",
  ]);
  expect(edit1.code).toBe(0);
  const edit1Json = JSON.parse(edit1.stdout);
  expect(edit1Json.layer.currentRevision.grade).toEqual({
    brightness: 1.4,
    contrast: 1.2,
    saturation: 1.5,
    warmth: 0.3,
  });
  expect(edit1Json.gradeSet).toEqual({
    grade: { brightness: 1.4, contrast: 1.2, saturation: 1.5, warmth: 0.3 },
  });

  // Omitted controls are kept; only specified control updates
  const edit2 = await invoke([
    "layer", "edit", layerId,
    "--brightness", "1.8",
    "--project", projDir,
    "--json",
  ]);
  expect(edit2.code).toBe(0);
  const edit2Json = JSON.parse(edit2.stdout);
  expect(edit2Json.layer.currentRevision.grade).toEqual({
    brightness: 1.8,
    contrast: 1.2,
    saturation: 1.5,
    warmth: 0.3,
  });

  // Neutral value removes that control from stored grade
  const edit3 = await invoke([
    "layer", "edit", layerId,
    "--contrast", "1",
    "--project", projDir,
    "--json",
  ]);
  expect(edit3.code).toBe(0);
  const edit3Json = JSON.parse(edit3.stdout);
  expect(edit3Json.layer.currentRevision.grade).toEqual({
    brightness: 1.8,
    saturation: 1.5,
    warmth: 0.3,
  });

  // Removing all remaining controls by setting them to neutral removes grade completely
  const edit4 = await invoke([
    "layer", "edit", layerId,
    "--brightness", "1",
    "--saturation", "1",
    "--warmth", "0",
    "--project", projDir,
  ]);
  expect(edit4.code).toBe(0);
  expect(edit4.stdout).toContain("grade removed");

  const inspRes = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(inspRes.code).toBe(0);
  const inspJson = JSON.parse(inspRes.stdout);
  expect(inspJson.layer.currentRevision.grade).toBeUndefined();

  // Neutral-only Layer renders byte-identically to ungraded baseline!
  const neutralOut = path.join(tempDir, "neutral.png");
  expect((await invoke(["composition", "render", "poster", "--project", projDir, "--out", neutralOut, "--json"])).code).toBe(0);
  const neutralBytes = await readFile(neutralOut);
  expect(neutralBytes.equals(baselineBytes)).toBe(true);
});

test("flat-colour fixtures: brightness, contrast, saturation, and warmth move pixels in documented direction (TEST-002)", async () => {
  await makeComp("poster", 400, 300);

  // 1. Brightness on flat midgrey
  const greyFile = path.join(tempDir, "grey.png");
  await writeFile(greyFile, solidPng(100, 100, [128, 128, 128, 255]));
  const l1 = await addImageLayer("poster", "bLayer", greyFile, { x: 50, y: 50 });
  const l1Id = l1.use.layerId as string;

  // Brighter
  await invoke(["layer", "edit", l1Id, "--brightness", "1.6", "--project", projDir]);
  const brightOut = path.join(tempDir, "bright.png");
  await invoke(["composition", "render", "poster", "--project", projDir, "--out", brightOut, "--supersample", "1"]);
  const brightPng = decodePng(await readFile(brightOut));
  const brightPx = pixel(brightPng, 100, 100);
  expect(brightPx[0]).toBeGreaterThan(128);
  expect(brightPx[3]).toBe(255); // Alpha preserved

  // Darker
  await invoke(["layer", "edit", l1Id, "--brightness", "0.4", "--project", projDir]);
  const darkOut = path.join(tempDir, "dark.png");
  await invoke(["composition", "render", "poster", "--project", projDir, "--out", darkOut, "--supersample", "1"]);
  const darkPng = decodePng(await readFile(darkOut));
  const darkPx = pixel(darkPng, 100, 100);
  expect(darkPx[0]).toBeLessThan(128);
  expect(darkPx[3]).toBe(255); // Alpha preserved

  // 2. Warmth on flat midgrey: positive raises red relative to blue; negative does reverse
  await invoke(["layer", "edit", l1Id, "--brightness", "1", "--warmth", "0.6", "--project", projDir]);
  const warmOut = path.join(tempDir, "warm.png");
  await invoke(["composition", "render", "poster", "--project", projDir, "--out", warmOut, "--supersample", "1"]);
  const warmPng = decodePng(await readFile(warmOut));
  const warmPx = pixel(warmPng, 100, 100);
  expect(warmPx[0]).toBeGreaterThan(warmPx[2]); // Red > Blue
  expect(warmPx[0]).toBeGreaterThan(128);
  expect(warmPx[2]).toBeLessThan(128);
  expect(warmPx[3]).toBe(255); // Alpha unchanged

  // Negative warmth (dashNumeric option)
  await invoke(["layer", "edit", l1Id, "--warmth", "-0.6", "--project", projDir]);
  const coolOut = path.join(tempDir, "cool.png");
  await invoke(["composition", "render", "poster", "--project", projDir, "--out", coolOut, "--supersample", "1"]);
  const coolPng = decodePng(await readFile(coolOut));
  const coolPx = pixel(coolPng, 100, 100);
  expect(coolPx[2]).toBeGreaterThan(coolPx[0]); // Blue > Red
  expect(coolPx[2]).toBeGreaterThan(128);
  expect(coolPx[0]).toBeLessThan(128);
  expect(coolPx[3]).toBe(255); // Alpha unchanged

  // 3. Contrast on dual-grey fixture (80 and 180)
  const dualFile = path.join(tempDir, "dual.png");
  await writeFile(dualFile, dualGreyPng(100, 100, 80, 180));
  await makeComp("comp-contrast", 400, 300);
  const l2 = await addImageLayer("comp-contrast", "cLayer", dualFile, { x: 50, y: 50 });
  const l2Id = l2.use.layerId as string;

  // Higher contrast spreads dark and bright apart
  await invoke(["layer", "edit", l2Id, "--contrast", "1.5", "--project", projDir]);
  const highContrastOut = path.join(tempDir, "contrast-high.png");
  await invoke(["composition", "render", "comp-contrast", "--project", projDir, "--out", highContrastOut, "--supersample", "1"]);
  const hcPng = decodePng(await readFile(highContrastOut));
  const hcDark = pixel(hcPng, 70, 100);
  const hcBright = pixel(hcPng, 120, 100);
  expect(hcDark[0]).toBeLessThan(80);
  expect(hcBright[0]).toBeGreaterThan(180);

  // Lower contrast brings them closer together
  await invoke(["layer", "edit", l2Id, "--contrast", "0.5", "--project", projDir]);
  const lowContrastOut = path.join(tempDir, "contrast-low.png");
  await invoke(["composition", "render", "comp-contrast", "--project", projDir, "--out", lowContrastOut, "--supersample", "1"]);
  const lcPng = decodePng(await readFile(lowContrastOut));
  const lcDark = pixel(lcPng, 70, 100);
  const lcBright = pixel(lcPng, 120, 100);
  expect(lcDark[0]).toBeGreaterThan(80);
  expect(lcBright[0]).toBeLessThan(180);

  // 4. Saturation on red-tinted fixture [180, 100, 100, 255]
  const satFile = path.join(tempDir, "sat.png");
  await writeFile(satFile, solidPng(100, 100, [180, 100, 100, 255]));
  await makeComp("comp-sat", 400, 300);
  const l3 = await addImageLayer("comp-sat", "sLayer", satFile, { x: 50, y: 50 });
  const l3Id = l3.use.layerId as string;

  // Desaturate to greyscale (saturation 0)
  await invoke(["layer", "edit", l3Id, "--saturation", "0", "--project", projDir]);
  const greyOut = path.join(tempDir, "desat.png");
  await invoke(["composition", "render", "comp-sat", "--project", projDir, "--out", greyOut, "--supersample", "1"]);
  const greyPng = decodePng(await readFile(greyOut));
  const greyPx = pixel(greyPng, 100, 100);
  expect(greyPx[0]).toBe(greyPx[1]);
  expect(greyPx[1]).toBe(greyPx[2]);

  // Oversaturate (saturation 2) increases separation
  await invoke(["layer", "edit", l3Id, "--saturation", "2", "--project", projDir]);
  const overSatOut = path.join(tempDir, "oversat.png");
  await invoke(["composition", "render", "comp-sat", "--project", projDir, "--out", overSatOut, "--supersample", "1"]);
  const overSatPng = decodePng(await readFile(overSatOut));
  const overSatPx = pixel(overSatPng, 100, 100);
  expect(overSatPx[0] - overSatPx[1]).toBeGreaterThan(180 - 100);
}, 30_000);

test("alpha is unchanged everywhere: painted extents, anchored placement, and clipping equal ungraded values", async () => {
  const imgFile = path.join(tempDir, "padded.png");
  // 100x100 canvas with a 60x60 centered opaque block, surrounded by transparent padding
  const buf = Buffer.alloc(100 * 100 * 4);
  for (let y = 20; y < 80; y++) {
    for (let x = 20; x < 80; x++) {
      const i = (y * 100 + x) * 4;
      buf[i] = 200;
      buf[i + 1] = 100;
      buf[i + 2] = 50;
      buf[i + 3] = 255;
    }
  }
  await writeFile(imgFile, encodePngRgba(100, 100, buf));
  await makeComp("poster", 400, 300);

  const addRes = await addImageLayer("poster", "hero", imgFile, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  // Ungraded measure
  const m1Res = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  expect(m1Res.code).toBe(0);
  const m1Json = JSON.parse(m1Res.stdout);
  const m1Layer = m1Json.layers[0];
  expect(m1Layer.painted).toEqual({ x: 70, y: 70, width: 60, height: 60 });
  expect(m1Layer.clipped).toBe(false);

  // Grade the layer heavily
  await invoke([
    "layer", "edit", layerId,
    "--brightness", "2.5",
    "--contrast", "2.0",
    "--saturation", "3.0",
    "--warmth", "0.8",
    "--project", projDir,
  ]);

  // Graded measure
  const m2Res = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  expect(m2Res.code).toBe(0);
  const m2Json = JSON.parse(m2Res.stdout);
  const m2Layer = m2Json.layers[0];
  expect(m2Layer.painted).toEqual(m1Layer.painted);
  expect(m2Layer.clipped).toBe(m1Layer.clipped);
  expect(m2Layer.grade).toEqual({
    brightness: 2.5,
    contrast: 2.0,
    saturation: 3.0,
    warmth: 0.8,
  });

  // Anchored placement resolves against painted ink identically
  await makeComp("poster-anchored", 400, 300);
  const a1 = await invoke([
    "composition", "add", "poster-anchored", "a1", "--image", imgFile, "--anchor", "center,center", "--x", "200", "--y", "150", "--project", projDir, "--json",
  ]);
  const a2 = await invoke([
    "composition", "add", "poster-anchored", "a2", "--image", imgFile, "--anchor", "center,center", "--x", "200", "--y", "150", "--brightness", "1.5", "--warmth", "0.5", "--project", projDir, "--json",
  ]);
  expect(a1.code).toBe(0);
  expect(a2.code).toBe(0);
  const a1Json = JSON.parse(a1.stdout);
  const a2Json = JSON.parse(a2.stdout);
  expect(a1Json.layer.currentRevision.x).toBe(a2Json.layer.currentRevision.x);
  expect(a1Json.layer.currentRevision.y).toBe(a2Json.layer.currentRevision.y);
});

test("outline and shadow colours are unaffected by grade", async () => {
  const imgFile = path.join(tempDir, "block.png");
  await writeFile(imgFile, solidPng(60, 60, [255, 0, 0, 255])); // Red box
  await makeComp("poster", 400, 300);

  const addRes = await addImageLayer("poster", "hero", imgFile, { x: 100, y: 100 });
  const layerId = addRes.use.layerId as string;

  // Add sharp green outline and sharp blue shadow
  await invoke([
    "layer", "edit", layerId,
    "--outline", "4,#00ff00",
    "--shadow", "10,10,0,#0000ff",
    "--project", projDir,
  ]);

  // Apply heavy grade (darken, warm shift, saturate)
  await invoke([
    "layer", "edit", layerId,
    "--brightness", "0.3",
    "--warmth", "0.9",
    "--saturation", "3.0",
    "--project", projDir,
  ]);

  const out = path.join(tempDir, "effects.png");
  await invoke(["composition", "render", "poster", "--project", projDir, "--out", out, "--supersample", "1"]);
  const png = decodePng(await readFile(out));

  // 1. Content pixel (inside 100,100..160,160): darkened red
  const contentPx = pixel(png, 130, 130);
  expect(contentPx[0]).toBeLessThan(255); // Darkened by brightness 0.3
  expect(contentPx[1]).toBe(0);
  expect(contentPx[2]).toBe(0);

  // 2. Outline pixel: at x=98, y=130 (2px left of content) -> pure green #00ff00
  const outlinePx = pixel(png, 98, 130);
  expect(outlinePx).toEqual([0, 255, 0, 255]);

  // 3. Shadow pixel: at x=168, y=168 (offset by shadow +10,+10 outside content/outline) -> pure blue #0000ff
  const shadowPx = pixel(png, 168, 168);
  expect(shadowPx).toEqual([0, 0, 255, 255]);
});

test("text Layer grading alters text appearance while keeping text properties (INT-4, US-005)", async () => {
  await makeComp("poster", 400, 300);
  const tRes = await addTextLayer("poster", "headline", "HELLO", { fontSize: 40, color: "#ffffff", x: 50, y: 50 });
  const layerId = tRes.use.layerId as string;

  // Render baseline text and locate a solid ink pixel
  const baseOut = path.join(tempDir, "text-base.png");
  await invoke(["composition", "render", "poster", "--project", projDir, "--out", baseOut, "--supersample", "1"]);
  const basePng = decodePng(await readFile(baseOut));
  let inkX = -1;
  let inkY = -1;
  for (let y = 50; y < 100; y++) {
    for (let x = 50; x < 150; x++) {
      const px = pixel(basePng, x, y);
      if (px[3] === 255 && px[0] > 200) {
        inkX = x;
        inkY = y;
        break;
      }
    }
    if (inkX !== -1) break;
  }
  expect(inkX).toBeGreaterThanOrEqual(0);
  const baseInk = pixel(basePng, inkX, inkY);

  // Edit with warmth shift and brightness
  const editRes = await invoke([
    "layer", "edit", layerId,
    "--warmth", "0.5",
    "--brightness", "0.5",
    "--project", projDir,
    "--json",
  ]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.layer.currentRevision.grade).toEqual({
    brightness: 0.5,
    warmth: 0.5,
  });

  // Render graded text: brightness moves known ink pixel in documented direction (INT-4)
  const gradedOut = path.join(tempDir, "text-graded.png");
  await invoke(["composition", "render", "poster", "--project", projDir, "--out", gradedOut, "--supersample", "1"]);
  const gradedPng = decodePng(await readFile(gradedOut));
  const gradedInk = pixel(gradedPng, inkX, inkY);

  expect(gradedInk[0]).toBeLessThan(baseInk[0]); // Darkened by brightness 0.5
  expect(gradedInk[3]).toBe(baseInk[3]); // Alpha unchanged

  // Verify inspect reports the grade
  const insp = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(insp.code).toBe(0);
  expect(insp.stdout).toContain("Grade: brightness 0.5, warmth 0.5");
});

test("shape Layer grading shifts rendered ink pixels in documented direction (INT-4, US-005)", async () => {
  await makeComp("poster", 400, 300);
  const sRes = await addShapeLayer("poster", "box", "rectangle", {
    size: "100x100",
    fill: "#808080",
    x: 50,
    y: 50,
  });
  const layerId = sRes.use.layerId as string;

  // Render baseline
  const baseOut = path.join(tempDir, "shape-base.png");
  await invoke(["composition", "render", "poster", "--project", projDir, "--out", baseOut, "--supersample", "1"]);
  const basePng = decodePng(await readFile(baseOut));
  const basePx = pixel(basePng, 100, 100);
  expect(basePx[0]).toBe(128);
  expect(basePx[3]).toBe(255);

  // Edit shape with brightness 1.8
  await invoke(["layer", "edit", layerId, "--brightness", "1.8", "--project", projDir]);
  const brightOut = path.join(tempDir, "shape-bright.png");
  await invoke(["composition", "render", "poster", "--project", projDir, "--out", brightOut, "--supersample", "1"]);
  const brightPng = decodePng(await readFile(brightOut));
  const brightPx = pixel(brightPng, 100, 100);

  expect(brightPx[0]).toBeGreaterThan(128); // Brightened by brightness 1.8
  expect(brightPx[3]).toBe(255); // Alpha unchanged
});

test("inspect, measure, and layer review report effective controls; shared Layers obey in-place/fork intent", async () => {
  const imgFile = path.join(tempDir, "subject.png");
  await writeFile(imgFile, solidPng(80, 80, [150, 150, 150, 255]));

  await makeComp("comp1", 400, 300);
  await makeComp("comp2", 400, 300);

  const addRes = await addImageLayer("comp1", "subj", imgFile, { x: 20, y: 20 });
  const layerId = addRes.use.layerId as string;

  // Import into comp2 so layer is shared across 2 compositions
  await invoke(["composition", "import", "comp2", "comp1", "--project", projDir]);

  // Editing without --in-place or --fork fails with exit 1
  const failEdit = await invoke([
    "layer", "edit", layerId, "--brightness", "1.5", "--project", projDir,
  ]);
  expect(failEdit.code).toBe(1);
  expect(failEdit.stderr).toContain("referenced by 2 Compositions");

  // In-place edit propagates across both Compositions
  const inPlace = await invoke([
    "layer", "edit", layerId, "--brightness", "1.5", "--warmth", "0.4", "--in-place", "--project", projDir, "--json",
  ]);
  expect(inPlace.code).toBe(0);

  // Inspect reports grade
  const insp = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(insp.code).toBe(0);
  expect(insp.stdout).toContain("Grade: brightness 1.5, warmth 0.4");

  // Measure on comp1 and comp2 both show the grade fact
  const m1 = await invoke(["composition", "measure", "comp1", "--project", projDir]);
  expect(m1.code).toBe(0);
  expect(m1.stdout).toContain("grade brightness 1.5, warmth 0.4");

  const m2 = await invoke(["composition", "measure", "comp2", "--project", projDir]);
  expect(m2.code).toBe(0);
  expect(m2.stdout).toContain("grade brightness 1.5, warmth 0.4");

  // Register retained generation provenance so layer review treats this as a reviewed generated Layer
  const imgBytes = await readFile(imgFile);
  const contentHash = createHash("sha256").update(imgBytes).digest("hex");
  const jobRecord = {
    schemaVersion: 2,
    jobId: "gen-1",
    kind: "generation",
    createdAt: new Date().toISOString(),
    request: {
      prompt: "a presenter portrait",
      intent: "isolated",
      model: "mock-model",
      sizing: { kind: "size", width: 80, height: 80 },
      count: 1,
      references: [],
    },
    run: {
      ranAt: new Date().toISOString(),
      model: "mock-model",
      fullPrompt: "a presenter portrait",
      cost: { basis: "unknown" },
      warnings: [],
      outputs: [
        {
          contentHash,
          file: "outputs/output-1.png",
          mediaType: "image/png",
        },
      ],
    },
  };
  await mkdir(path.join(projDir, "generation", "gen-1", "outputs"), { recursive: true });
  await writeFile(path.join(projDir, "generation", "gen-1", "outputs", "output-1.png"), imgBytes);
  await writeFile(path.join(projDir, "generation", "gen-1", "job.json"), JSON.stringify(jobRecord));

  // Layer review includes grade in facts
  const reviewOut = path.join(tempDir, "review.html");
  const revRes = await invoke(["layer", "review", layerId, "--out", reviewOut, "--project", projDir]);
  expect(revRes.code).toBe(0);
  const reviewHtml = await readFile(reviewOut, "utf8");
  expect(reviewHtml).toContain("brightness 1.5, warmth 0.4 (paint-time)");

  // Fork isolates the edit to comp2
  const forkRes = await invoke([
    "layer", "edit", layerId,
    "--fork", "--composition", "comp2", "--use", "subj",
    "--brightness", "0.6",
    "--project", projDir,
    "--json",
  ]);
  expect(forkRes.code).toBe(0);
  const forkJson = JSON.parse(forkRes.stdout);
  const forkedLayerId = forkJson.layer.id;
  expect(forkedLayerId).not.toBe(layerId);
  expect(forkJson.layer.currentRevision.grade.brightness).toBe(0.6);

  // Original layer in comp1 still has brightness 1.5
  const origInsp = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(JSON.parse(origInsp.stdout).layer.currentRevision.grade.brightness).toBe(1.5);
}, 30_000);

test("retained Render replays byte-identically after later edits", async () => {
  const imgFile = path.join(tempDir, "photo.png");
  await writeFile(imgFile, solidPng(100, 100, [140, 120, 100, 255]));
  await makeComp("scene", 400, 300);

  const addRes = await addImageLayer("scene", "photo", imgFile, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  // Grade the layer
  await invoke([
    "layer", "edit", layerId,
    "--brightness", "1.3",
    "--contrast", "1.1",
    "--warmth", "0.4",
    "--project", projDir,
  ]);

  // Initial render
  const renderOut = path.join(projDir, "renders", "first.png");
  const renderRes = await invoke([
    "composition", "render", "scene", "--project", projDir, "--out", renderOut, "--json",
  ]);
  expect(renderRes.code).toBe(0);
  const renderJson = JSON.parse(renderRes.stdout);
  const manifestPath = renderJson.render.manifest as string;
  const initialBytes = await readFile(renderOut);

  // Later edit that changes the grade drastically
  await invoke([
    "layer", "edit", layerId,
    "--brightness", "0.2",
    "--warmth", "-0.8",
    "--project", projDir,
  ]);

  // Replay the first render from its manifest
  const replayOut = path.join(tempDir, "replayed.png");
  const replayRes = await invoke([
    "composition", "replay", manifestPath, "--project", projDir, "--out", replayOut, "--json",
  ]);
  expect(replayRes.code).toBe(0);
  const replayedBytes = await readFile(replayOut);

  // Replay must be byte-for-byte identical to the original render!
  expect(replayedBytes.equals(initialBytes)).toBe(true);
}, 30_000);
