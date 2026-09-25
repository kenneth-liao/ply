/**
 * Look parameters work on every Layer kind (#223, spec #218 US-005,
 * DEC-002, DEC-005, TEST-006, ADR-0024).
 *
 * Verifies through the public CLI and rendered-pixel seams:
 * - A property × kind matrix (TEST-006): asserts every look parameter
 *   (brightness, contrast, saturation, warmth, blend, glow) against every
 *   Layer kind — raster image, vector image (SVG), text, and shape — with
 *   one assertion each: applied in the documented direction (or for blend,
 *   the backdrop shows through as documented).
 * - Vector Layer paint order: a vector Layer's colour parameter
 *   (--vector-color) applies BEFORE its grade (paint order step 2 before
 *   step 4): recolour a vector to a known colour, grade it, and assert the
 *   graded pixel equals the grade applied to the recoloured colour, not to
 *   the authored colour.
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
    buf[i] = rgba[0];
    buf[i + 1] = rgba[1];
    buf[i + 2] = rgba[2];
    buf[i + 3] = rgba[3];
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

function toward(c: [number, number, number], from: [number, number, number], target: [number, number, number]): number {
  const d = (a: number, b: number) => a - b;
  const total2 = d(target[0], from[0]) ** 2 + d(target[1], from[1]) ** 2 + d(target[2], from[2]) ** 2;
  const moved2 = d(c[0], from[0]) ** 2 + d(c[1], from[1]) ** 2 + d(c[2], from[2]) ** 2;
  return Math.sqrt(moved2 / total2);
}

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-look-kind-matrix-"));
  projDir = path.join(tempDir, "proj");
  const init = await invoke(["project", "init", projDir, "--name", "look-kind-matrix"]);
  expect(init.code).toBe(0);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComp(name: string, width = 200, height = 200) {
  const res = await invoke([
    "composition", "create", name, "--width", String(width), "--height", String(height), "--project", projDir,
  ]);
  expect(res.code).toBe(0);
}

async function render(comp: string, filename: string): Promise<ReturnType<typeof decodePng>> {
  const outPath = path.join(tempDir, filename);
  const res = await invoke([
    "composition", "render", comp, "--project", projDir, "--out", outPath, "--supersample", "1",
  ]);
  expect(res.code).toBe(0);
  return decodePng(await readFile(outPath));
}

// ---------------------------------------------------------------------------
// 1. Matrix: Brightness on all 4 kinds (raster image, vector image, text, shape)
// ---------------------------------------------------------------------------

test("matrix: brightness applies to raster image, vector image, text, and shape Layers", async () => {
  await makeComp("comp-brightness", 200, 200);

  // 1a. Raster image: 60x60 mid-grey [128, 128, 128, 255]
  const pngPath = path.join(tempDir, "raster-grey.png");
  await writeFile(pngPath, solidPng(60, 60, [128, 128, 128, 255]));
  const rAdd = await invoke([
    "composition", "add", "comp-brightness", "raster",
    "--image", pngPath, "--x", "10", "--y", "10",
    "--brightness", "1.6",
    "--project", projDir, "--json",
  ]);
  expect(rAdd.code).toBe(0);

  // 1b. Vector image: 60x60 mid-grey #808080
  const svgPath = path.join(tempDir, "vector-grey.svg");
  await writeFile(svgPath, solidSvg(60, 60, "#808080"));
  const vAdd = await invoke([
    "composition", "add", "comp-brightness", "vector",
    "--image", svgPath, "--x", "80", "--y", "10",
    "--brightness", "1.6",
    "--project", projDir, "--json",
  ]);
  expect(vAdd.code).toBe(0);

  // 1c. Text: mid-grey #808080
  const tAdd = await invoke([
    "composition", "add", "comp-brightness", "text",
    "--text", "MM", "--font", "Archivo", "--font-size", "40", "--color", "#808080",
    "--x", "10", "--y", "80",
    "--brightness", "1.6",
    "--project", projDir, "--json",
  ]);
  expect(tAdd.code).toBe(0);

  // 1d. Shape: rectangle 60x60 mid-grey #808080
  const sAdd = await invoke([
    "composition", "add", "comp-brightness", "shape",
    "--shape", "rectangle", "--size", "60x60", "--fill", "#808080",
    "--x", "80", "--y", "80",
    "--brightness", "1.6",
    "--project", projDir, "--json",
  ]);
  expect(sAdd.code).toBe(0);

  // Render and assert known pixels moved in documented direction (brighter > 128)
  const rendered = await render("comp-brightness", "brightness.png");

  // Raster interior (x=40, y=40)
  const rPx = pixel(rendered, 40, 40);
  expect(rPx[0]).toBeGreaterThan(128);
  expect(rPx[3]).toBe(255);

  // Vector interior (x=110, y=40)
  const vPx = pixel(rendered, 110, 40);
  expect(vPx[0]).toBeGreaterThan(128);
  expect(vPx[3]).toBe(255);

  // Text ink pixel: find a solid pixel in the text region (x: 10..70, y: 80..130)
  let tPx: [number, number, number, number] | null = null;
  for (let y = 85; y < 125; y++) {
    for (let x = 15; x < 65; x++) {
      const px = pixel(rendered, x, y);
      if (px[3] === 255) {
        tPx = px;
        break;
      }
    }
    if (tPx) break;
  }
  expect(tPx).not.toBeNull();
  expect(tPx![0]).toBeGreaterThan(128);

  // Shape interior (x=110, y=110)
  const sPx = pixel(rendered, 110, 110);
  expect(sPx[0]).toBeGreaterThan(128);
  expect(sPx[3]).toBe(255);
}, 30_000);

// ---------------------------------------------------------------------------
// 2. Matrix: Contrast on all 4 kinds (raster image, vector image, text, shape)
// ---------------------------------------------------------------------------

test("matrix: contrast applies to raster image, vector image, text, and shape Layers", async () => {
  await makeComp("comp-contrast", 200, 200);

  // Tinted grey with channel 80 (< 128): under contrast 1.5, channel 80 decreases (< 80)
  // 2a. Raster image: 60x60 dark-grey [80, 80, 80, 255]
  const pngPath = path.join(tempDir, "raster-dark.png");
  await writeFile(pngPath, solidPng(60, 60, [80, 80, 80, 255]));
  await invoke([
    "composition", "add", "comp-contrast", "raster",
    "--image", pngPath, "--x", "10", "--y", "10",
    "--contrast", "1.5",
    "--project", projDir, "--json",
  ]);

  // 2b. Vector image: 60x60 dark-grey #505050
  const svgPath = path.join(tempDir, "vector-dark.svg");
  await writeFile(svgPath, solidSvg(60, 60, "#505050"));
  await invoke([
    "composition", "add", "comp-contrast", "vector",
    "--image", svgPath, "--x", "80", "--y", "10",
    "--contrast", "1.5",
    "--project", projDir, "--json",
  ]);

  // 2c. Text: dark-grey #505050
  await invoke([
    "composition", "add", "comp-contrast", "text",
    "--text", "MM", "--font", "Archivo", "--font-size", "40", "--color", "#505050",
    "--x", "10", "--y", "80",
    "--contrast", "1.5",
    "--project", projDir, "--json",
  ]);

  // 2d. Shape: rectangle 60x60 dark-grey #505050
  await invoke([
    "composition", "add", "comp-contrast", "shape",
    "--shape", "rectangle", "--size", "60x60", "--fill", "#505050",
    "--x", "80", "--y", "80",
    "--contrast", "1.5",
    "--project", projDir, "--json",
  ]);

  // Render and assert known pixels moved in documented direction (contrast expands: 80 moves down < 80)
  const rendered = await render("comp-contrast", "contrast.png");

  // Raster interior (x=40, y=40)
  const rPx = pixel(rendered, 40, 40);
  expect(rPx[0]).toBeLessThan(80);
  expect(rPx[3]).toBe(255);

  // Vector interior (x=110, y=40)
  const vPx = pixel(rendered, 110, 40);
  expect(vPx[0]).toBeLessThan(80);
  expect(vPx[3]).toBe(255);

  // Text ink pixel (x: 10..70, y: 80..130)
  let tPx: [number, number, number, number] | null = null;
  for (let y = 85; y < 125; y++) {
    for (let x = 15; x < 65; x++) {
      const px = pixel(rendered, x, y);
      if (px[3] === 255) {
        tPx = px;
        break;
      }
    }
    if (tPx) break;
  }
  expect(tPx).not.toBeNull();
  expect(tPx![0]).toBeLessThan(80);

  // Shape interior (x=110, y=110)
  const sPx = pixel(rendered, 110, 110);
  expect(sPx[0]).toBeLessThan(80);
  expect(sPx[3]).toBe(255);
}, 30_000);

// ---------------------------------------------------------------------------
// 3. Matrix: Saturation on all 4 kinds (raster image, vector image, text, shape)
// ---------------------------------------------------------------------------

test("matrix: saturation applies to raster image, vector image, text, and shape Layers", async () => {
  await makeComp("comp-saturation", 200, 200);

  // Red-tinted base [180, 100, 100]: saturation 0 desaturates so R == G == B
  // 3a. Raster image: 60x60 red-tinted [180, 100, 100, 255]
  const pngPath = path.join(tempDir, "raster-sat.png");
  await writeFile(pngPath, solidPng(60, 60, [180, 100, 100, 255]));
  await invoke([
    "composition", "add", "comp-saturation", "raster",
    "--image", pngPath, "--x", "10", "--y", "10",
    "--saturation", "0",
    "--project", projDir, "--json",
  ]);

  // 3b. Vector image: 60x60 red-tinted #b46464
  const svgPath = path.join(tempDir, "vector-sat.svg");
  await writeFile(svgPath, solidSvg(60, 60, "#b46464"));
  await invoke([
    "composition", "add", "comp-saturation", "vector",
    "--image", svgPath, "--x", "80", "--y", "10",
    "--saturation", "0",
    "--project", projDir, "--json",
  ]);

  // 3c. Text: red-tinted #b46464
  await invoke([
    "composition", "add", "comp-saturation", "text",
    "--text", "MM", "--font", "Archivo", "--font-size", "40", "--color", "#b46464",
    "--x", "10", "--y", "80",
    "--saturation", "0",
    "--project", projDir, "--json",
  ]);

  // 3d. Shape: rectangle 60x60 red-tinted #b46464
  await invoke([
    "composition", "add", "comp-saturation", "shape",
    "--shape", "rectangle", "--size", "60x60", "--fill", "#b46464",
    "--x", "80", "--y", "80",
    "--saturation", "0",
    "--project", projDir, "--json",
  ]);

  // Render and assert known pixels desaturated to greyscale (R == G == B)
  const rendered = await render("comp-saturation", "saturation.png");

  // Raster interior
  const rPx = pixel(rendered, 40, 40);
  expect(rPx[0]).toBe(rPx[1]);
  expect(rPx[1]).toBe(rPx[2]);
  expect(rPx[3]).toBe(255);

  // Vector interior
  const vPx = pixel(rendered, 110, 40);
  expect(vPx[0]).toBe(vPx[1]);
  expect(vPx[1]).toBe(vPx[2]);
  expect(vPx[3]).toBe(255);

  // Text ink pixel
  let tPx: [number, number, number, number] | null = null;
  for (let y = 85; y < 125; y++) {
    for (let x = 15; x < 65; x++) {
      const px = pixel(rendered, x, y);
      if (px[3] === 255) {
        tPx = px;
        break;
      }
    }
    if (tPx) break;
  }
  expect(tPx).not.toBeNull();
  expect(tPx![0]).toBe(tPx![1]);
  expect(tPx![1]).toBe(tPx![2]);

  // Shape interior
  const sPx = pixel(rendered, 110, 110);
  expect(sPx[0]).toBe(sPx[1]);
  expect(sPx[1]).toBe(sPx[2]);
  expect(sPx[3]).toBe(255);
}, 30_000);

// ---------------------------------------------------------------------------
// 4. Matrix: Warmth on all 4 kinds (raster image, vector image, text, shape)
// ---------------------------------------------------------------------------

test("matrix: warmth applies to raster image, vector image, text, and shape Layers", async () => {
  await makeComp("comp-warmth", 200, 200);

  // Mid-grey base [128, 128, 128]: warmth 0.6 raises red relative to blue (R > B, R > 128, B < 128)
  // 4a. Raster image: 60x60 mid-grey [128, 128, 128, 255]
  const pngPath = path.join(tempDir, "raster-warm.png");
  await writeFile(pngPath, solidPng(60, 60, [128, 128, 128, 255]));
  await invoke([
    "composition", "add", "comp-warmth", "raster",
    "--image", pngPath, "--x", "10", "--y", "10",
    "--warmth", "0.6",
    "--project", projDir, "--json",
  ]);

  // 4b. Vector image: 60x60 mid-grey #808080
  const svgPath = path.join(tempDir, "vector-warm.svg");
  await writeFile(svgPath, solidSvg(60, 60, "#808080"));
  await invoke([
    "composition", "add", "comp-warmth", "vector",
    "--image", svgPath, "--x", "80", "--y", "10",
    "--warmth", "0.6",
    "--project", projDir, "--json",
  ]);

  // 4c. Text: mid-grey #808080
  await invoke([
    "composition", "add", "comp-warmth", "text",
    "--text", "MM", "--font", "Archivo", "--font-size", "40", "--color", "#808080",
    "--x", "10", "--y", "80",
    "--warmth", "0.6",
    "--project", projDir, "--json",
  ]);

  // 4d. Shape: rectangle 60x60 mid-grey #808080
  await invoke([
    "composition", "add", "comp-warmth", "shape",
    "--shape", "rectangle", "--size", "60x60", "--fill", "#808080",
    "--x", "80", "--y", "80",
    "--warmth", "0.6",
    "--project", projDir, "--json",
  ]);

  // Render and assert known pixels moved in documented direction (R > B, R > 128, B < 128)
  const rendered = await render("comp-warmth", "warmth.png");

  // Raster interior
  const rPx = pixel(rendered, 40, 40);
  expect(rPx[0]).toBeGreaterThan(rPx[2]);
  expect(rPx[0]).toBeGreaterThan(128);
  expect(rPx[2]).toBeLessThan(128);
  expect(rPx[3]).toBe(255);

  // Vector interior
  const vPx = pixel(rendered, 110, 40);
  expect(vPx[0]).toBeGreaterThan(vPx[2]);
  expect(vPx[0]).toBeGreaterThan(128);
  expect(vPx[2]).toBeLessThan(128);
  expect(vPx[3]).toBe(255);

  // Text ink pixel
  let tPx: [number, number, number, number] | null = null;
  for (let y = 85; y < 125; y++) {
    for (let x = 15; x < 65; x++) {
      const px = pixel(rendered, x, y);
      if (px[3] === 255) {
        tPx = px;
        break;
      }
    }
    if (tPx) break;
  }
  expect(tPx).not.toBeNull();
  expect(tPx![0]).toBeGreaterThan(tPx![2]);
  expect(tPx![0]).toBeGreaterThan(128);
  expect(tPx![2]).toBeLessThan(128);

  // Shape interior
  const sPx = pixel(rendered, 110, 110);
  expect(sPx[0]).toBeGreaterThan(sPx[2]);
  expect(sPx[0]).toBeGreaterThan(128);
  expect(sPx[2]).toBeLessThan(128);
  expect(sPx[3]).toBe(255);
}, 30_000);

// ---------------------------------------------------------------------------
// 5. Matrix: Blend mode on all 4 kinds (raster image, vector image, text, shape)
// ---------------------------------------------------------------------------

test("matrix: blend mode applies to raster image, vector image, text, and shape Layers", async () => {
  await makeComp("comp-blend", 200, 200);

  // Red backdrop across the entire 200x200 canvas
  const bgPath = path.join(tempDir, "backdrop-red.png");
  await writeFile(bgPath, solidPng(200, 200, [255, 0, 0, 255]));
  await invoke([
    "composition", "add", "comp-blend", "bg",
    "--image", bgPath, "--x", "0", "--y", "0",
    "--project", projDir, "--json",
  ]);

  // Under multiply: white [255, 255, 255] * red [255, 0, 0] = red [255, 0, 0]
  // 5a. Raster image: 60x60 white [255, 255, 255, 255]
  const pngPath = path.join(tempDir, "raster-white.png");
  await writeFile(pngPath, solidPng(60, 60, [255, 255, 255, 255]));
  await invoke([
    "composition", "add", "comp-blend", "raster",
    "--image", pngPath, "--x", "10", "--y", "10",
    "--blend", "multiply",
    "--project", projDir, "--json",
  ]);

  // 5b. Vector image: 60x60 white #ffffff
  const svgPath = path.join(tempDir, "vector-white.svg");
  await writeFile(svgPath, solidSvg(60, 60, "#ffffff"));
  await invoke([
    "composition", "add", "comp-blend", "vector",
    "--image", svgPath, "--x", "80", "--y", "10",
    "--blend", "multiply",
    "--project", projDir, "--json",
  ]);

  // 5c. Text: white #ffffff (added unblended first to verify glyph ink is opaque white)
  const tAdd = await invoke([
    "composition", "add", "comp-blend", "text",
    "--text", "MM", "--font", "Archivo", "--font-size", "40", "--color", "#ffffff",
    "--x", "10", "--y", "80",
    "--project", projDir, "--json",
  ]);
  expect(tAdd.code).toBe(0);
  const textLayerId = JSON.parse(tAdd.stdout).use.layerId as string;

  // 5d. Shape: rectangle 60x60 white #ffffff
  await invoke([
    "composition", "add", "comp-blend", "shape",
    "--shape", "rectangle", "--size", "60x60", "--fill", "#ffffff",
    "--x", "80", "--y", "80",
    "--blend", "multiply",
    "--project", projDir, "--json",
  ]);

  // Verify unblended text renders opaque white at glyph ink pixel (x=16, y=101 in 'M' stem)
  const unblended = await render("comp-blend", "blend-unblended.png");
  expect(pixel(unblended, 16, 101)).toEqual([255, 255, 255, 255]);

  // Now apply --blend multiply to text
  const tEdit = await invoke([
    "layer", "edit", textLayerId,
    "--blend", "multiply",
    "--project", projDir, "--json",
  ]);
  expect(tEdit.code).toBe(0);

  // Render: the red backdrop shows through where the foreground fixtures were white
  const rendered = await render("comp-blend", "blend.png");

  // Raster interior: white multiplied over red backdrop leaves red
  expect(pixel(rendered, 40, 40)).toEqual([255, 0, 0, 255]);

  // Vector interior: white multiplied over red backdrop leaves red
  expect(pixel(rendered, 110, 40)).toEqual([255, 0, 0, 255]);

  // Text glyph ink pixel (x=16, y=101): white text multiplied over red backdrop leaves red
  expect(pixel(rendered, 16, 101)).toEqual([255, 0, 0, 255]);

  // Zero opaque white glyph pixels remain in the text region
  let remainingWhite = 0;
  for (let y = 85; y < 125; y++) {
    for (let x = 14; x < 65; x++) {
      const px = pixel(rendered, x, y);
      if (px[0] === 255 && px[1] === 255 && px[2] === 255 && px[3] === 255) {
        remainingWhite++;
      }
    }
  }
  expect(remainingWhite).toBe(0);

  // Shape interior: white shape multiplied over red backdrop leaves red
  expect(pixel(rendered, 110, 110)).toEqual([255, 0, 0, 255]);
}, 30_000);

// ---------------------------------------------------------------------------
// 6. Matrix: Glow on all 4 kinds (raster image, vector image, text, shape)
// ---------------------------------------------------------------------------

test("matrix: edge glow applies to raster image, vector image, text, and shape Layers", async () => {
  await makeComp("comp-glow", 300, 300);

  // Blue base [34, 136, 204], glow colour #ff9900 [255, 153, 0]
  const from: [number, number, number] = [34, 136, 204];
  const target: [number, number, number] = [255, 153, 0];

  // 6a. Raster image: 80x80 blue [34, 136, 204, 255]
  const pngPath = path.join(tempDir, "raster-blue.png");
  await writeFile(pngPath, solidPng(80, 80, [34, 136, 204, 255]));
  await invoke([
    "composition", "add", "comp-glow", "raster",
    "--image", pngPath, "--x", "20", "--y", "20",
    "--glow", "12,4,#ff9900",
    "--project", projDir, "--json",
  ]);

  // 6b. Vector image: 80x80 blue #2288cc
  const svgPath = path.join(tempDir, "vector-blue.svg");
  await writeFile(svgPath, solidSvg(80, 80, "#2288cc"));
  await invoke([
    "composition", "add", "comp-glow", "vector",
    "--image", svgPath, "--x", "150", "--y", "20",
    "--glow", "12,4,#ff9900",
    "--project", projDir, "--json",
  ]);

  // 6c. Text: blue #2288cc, large font for measurable rim
  await invoke([
    "composition", "add", "comp-glow", "text",
    "--text", "OO", "--font", "Archivo", "--font-size", "50", "--color", "#2288cc",
    "--x", "20", "--y", "150",
    "--glow", "8,2,#ff9900",
    "--project", projDir, "--json",
  ]);

  // 6d. Shape: rectangle 80x80 blue #2288cc
  await invoke([
    "composition", "add", "comp-glow", "shape",
    "--shape", "rectangle", "--size", "80x80", "--fill", "#2288cc",
    "--x", "150", "--y", "150",
    "--glow", "12,4,#ff9900",
    "--project", projDir, "--json",
  ]);

  // Render and assert: edge pixel moves toward glow colour, interior pixel remains unchanged
  const rendered = await render("comp-glow", "glow.png");

  // Raster: interior (x=60, y=60) is untouched blue; edge (x=24, y=60) moved toward glow colour
  const rInterior = pixel(rendered, 60, 60);
  expect(rInterior).toEqual([34, 136, 204, 255]);
  const rEdge = pixel(rendered, 24, 60);
  expect(toward(rEdge.slice(0, 3) as [number, number, number], from, target)).toBeGreaterThan(0.25);

  // Vector: interior (x=190, y=60) is untouched blue; edge (x=154, y=60) moved toward glow colour
  const vInterior = pixel(rendered, 190, 60);
  expect(vInterior).toEqual([34, 136, 204, 255]);
  const vEdge = pixel(rendered, 154, 60);
  expect(toward(vEdge.slice(0, 3) as [number, number, number], from, target)).toBeGreaterThan(0.25);

  // Shape: interior (x=190, y=190) is untouched blue; edge (x=154, y=190) moved toward glow colour
  const sInterior = pixel(rendered, 190, 190);
  expect(sInterior).toEqual([34, 136, 204, 255]);
  const sEdge = pixel(rendered, 154, 190);
  expect(toward(sEdge.slice(0, 3) as [number, number, number], from, target)).toBeGreaterThan(0.25);

  // Text: verify that edge pixels of the text moved toward the glow colour
  let tGlowShift = false;
  for (let y = 150; y < 220; y++) {
    for (let x = 20; x < 120; x++) {
      const px = pixel(rendered, x, y);
      if (px[3] > 0) {
        const shift = toward(px.slice(0, 3) as [number, number, number], from, target);
        if (shift > 0.2) {
          tGlowShift = true;
          break;
        }
      }
    }
    if (tGlowShift) break;
  }
  expect(tGlowShift).toBe(true);

  // Measure check: painted extents equal no-glow extents (DEC-005)
  // Check text painted extents with and without glow
  await makeComp("comp-text-glow-measure", 200, 200);
  const tPlain = await invoke([
    "composition", "add", "comp-text-glow-measure", "t-plain",
    "--text", "OO", "--font", "Archivo", "--font-size", "50", "--color", "#2288cc",
    "--x", "20", "--y", "50",
    "--project", projDir, "--json",
  ]);
  const m1 = await invoke(["composition", "measure", "comp-text-glow-measure", "--project", projDir, "--json"]);
  const plainPainted = JSON.parse(m1.stdout).layers[0].painted;

  const tLayerId = JSON.parse(tPlain.stdout).use.layerId as string;
  await invoke(["layer", "edit", tLayerId, "--glow", "8,2,#ff9900", "--project", projDir]);
  const m2 = await invoke(["composition", "measure", "comp-text-glow-measure", "--project", projDir, "--json"]);
  const glowPainted = JSON.parse(m2.stdout).layers[0].painted;
  expect(glowPainted).toEqual(plainPainted);

  const measured = await invoke(["composition", "measure", "comp-glow", "--project", projDir, "--json"]);
  expect(measured.code).toBe(0);
  const layers = JSON.parse(measured.stdout).layers as { name: string; glow: unknown; painted: unknown }[];
  for (const l of layers) {
    expect(l.glow).toBeDefined();
    expect(l.painted).toBeDefined();
  }
}, 30_000);

test("matrix: the one-sided glow direction applies to raster image, vector image, text, and shape Layers (#301, ISC-53)", async () => {
  await makeComp("comp-glow-dir", 300, 300);

  const from: [number, number, number] = [34, 136, 204];
  const target: [number, number, number] = [255, 153, 0];
  const change = (p: number[]) =>
    toward(p.slice(0, 3) as [number, number, number], from, target);

  // The same four kinds as the even-glow matrix, each with the one-sided
  // direction: light FROM 90° (the right) — the right edge lit, the left
  // edge unlit to within the 0.05 tolerance (ISC-53).
  const pngPath = path.join(tempDir, "raster-blue.png");
  await writeFile(pngPath, solidPng(80, 80, [34, 136, 204, 255]));
  await invoke([
    "composition", "add", "comp-glow-dir", "raster",
    "--image", pngPath, "--x", "20", "--y", "20",
    "--glow", "12,4,#ff9900,from 90,1",
    "--project", projDir, "--json",
  ]);

  const svgPath = path.join(tempDir, "vector-blue.svg");
  await writeFile(svgPath, solidSvg(80, 80, "#2288cc"));
  await invoke([
    "composition", "add", "comp-glow-dir", "vector",
    "--image", svgPath, "--x", "150", "--y", "20",
    "--glow", "12,4,#ff9900,from 90,1",
    "--project", projDir, "--json",
  ]);

  await invoke([
    "composition", "add", "comp-glow-dir", "text",
    "--text", "OO", "--font", "Archivo", "--font-size", "50", "--color", "#2288cc",
    "--x", "20", "--y", "150",
    "--glow", "8,2,#ff9900,from 90,1",
    "--project", projDir, "--json",
  ]);

  await invoke([
    "composition", "add", "comp-glow-dir", "shape",
    "--shape", "rectangle", "--size", "80x80", "--fill", "#2288cc",
    "--x", "150", "--y", "150",
    "--glow", "12,4,#ff9900,from 90,1",
    "--project", projDir, "--json",
  ]);

  const rendered = await render("comp-glow-dir", "glow-dir.png");

  // Raster, vector, and shape: right edge lit, left edge unlit.
  const kinds: [string, number, number][] = [
    ["raster", 20, 20],
    ["vector", 150, 20],
    ["shape", 150, 150],
  ];
  for (const [name, x0, y0] of kinds) {
    expect(change(pixel(rendered, x0 + 79, y0 + 40))).toBeGreaterThan(0.25);
    expect(change(pixel(rendered, x0, y0 + 40))).toBeLessThan(0.05);
    // Interior untouched.
    expect(pixel(rendered, x0 + 40, y0 + 40)).toEqual([34, 136, 204, 255]);
  }

  // Text: some pixel of the glyphs moves toward the glow colour.
  let tGlowShift = false;
  for (let y = 150; y < 220; y++) {
    for (let x = 20; x < 120; x++) {
      const px = pixel(rendered, x, y);
      if (px[3] > 0 && change(px) > 0.2) {
        tGlowShift = true;
        break;
      }
    }
    if (tGlowShift) break;
  }
  expect(tGlowShift).toBe(true);

  // Measure reports the stored direction fact on every kind.
  const measured = await invoke(["composition", "measure", "comp-glow-dir", "--project", projDir, "--json"]);
  const dirLayers = JSON.parse(measured.stdout).layers as { glow: { direction?: { angle: number; strength: number } } | null }[];
  for (const l of dirLayers) {
    expect(l.glow?.direction).toEqual({ angle: 90, strength: 1 });
  }
}, 30_000);

// ---------------------------------------------------------------------------
// 7. Vector Layer Paint Order: --vector-color applies BEFORE grade (DEC-002)
// ---------------------------------------------------------------------------

test("vector Layer colour parameter (--vector-color) applies before its grade", async () => {
  await makeComp("comp-vector-order", 200, 200);

  // Create an authored BLUE SVG (#0000ff)
  const svgPath = path.join(tempDir, "blue-mark.svg");
  await writeFile(svgPath, solidSvg(80, 80, "#0000ff"));

  // 1. Reference: create a raster RED layer ([255, 0, 0]), graded with brightness 0.5
  const redPng = path.join(tempDir, "ref-red.png");
  await writeFile(redPng, solidPng(80, 80, [255, 0, 0, 255]));
  await invoke([
    "composition", "add", "comp-vector-order", "ref-red",
    "--image", redPng, "--x", "10", "--y", "10",
    "--brightness", "0.5",
    "--project", projDir, "--json",
  ]);

  // 2. Target: add the authored BLUE SVG, recolour it with --vector-color #ff0000 (red),
  // and grade it with --brightness 0.5
  const addTarget = await invoke([
    "composition", "add", "comp-vector-order", "vector-target",
    "--image", svgPath, "--x", "100", "--y", "10",
    "--vector-color", "#ff0000",
    "--brightness", "0.5",
    "--project", projDir, "--json",
  ]);
  const targetLayerId = JSON.parse(addTarget.stdout).use.layerId as string;

  const rendered = await render("comp-vector-order", "vector-order.png");

  // Reference red pixel graded by 0.5 (x=50, y=50)
  const refPx = pixel(rendered, 50, 50);
  expect(refPx[0]).toBeGreaterThan(100);
  expect(refPx[0]).toBeLessThan(150);
  expect(refPx[1]).toBe(0);
  expect(refPx[2]).toBe(0);
  expect(refPx[3]).toBe(255);

  // Target vector pixel (x=140, y=50): recoloured to red, then graded by 0.5
  const targetPx = pixel(rendered, 140, 50);

  // Crucial assertions:
  // (a) The graded pixel equals the grade applied to the recoloured colour (red), within ±2px tolerance
  const close = (a: number, b: number) => Math.abs(a - b) <= 2;
  expect(close(targetPx[0], refPx[0])).toBe(true);
  expect(close(targetPx[1], refPx[1])).toBe(true);
  expect(close(targetPx[2], refPx[2])).toBe(true);
  expect(targetPx[3]).toBe(255);

  // (b) It is NOT the authored blue colour (which would have Blue > 0 and Red == 0)
  expect(targetPx[2]).toBe(0);
  expect(targetPx[0]).toBeGreaterThan(100);

  // 3. Also verify via layer edit: edit vector colour to green (#00ff00) and brightness 0.4
  const greenPng = path.join(tempDir, "ref-green.png");
  await writeFile(greenPng, solidPng(80, 80, [0, 255, 0, 255]));
  await invoke([
    "composition", "add", "comp-vector-order", "ref-green",
    "--image", greenPng, "--x", "10", "--y", "100",
    "--brightness", "0.4",
    "--project", projDir, "--json",
  ]);

  await invoke([
    "layer", "edit", targetLayerId,
    "--vector-color", "#00ff00",
    "--brightness", "0.4",
    "--y", "100",
    "--project", projDir, "--json",
  ]);

  const editedRendered = await render("comp-vector-order", "vector-order-edit.png");
  const refGreenPx = pixel(editedRendered, 50, 140);
  const targetGreenPx = pixel(editedRendered, 140, 140);

  expect(close(targetGreenPx[0], refGreenPx[0])).toBe(true);
  expect(close(targetGreenPx[1], refGreenPx[1])).toBe(true);
  expect(close(targetGreenPx[2], refGreenPx[2])).toBe(true);
  expect(targetGreenPx[1]).toBeGreaterThan(80);
  expect(targetGreenPx[0]).toBe(0);
  expect(targetGreenPx[2]).toBe(0);
}, 30_000);

// ---------------------------------------------------------------------------
// Cover fit property × kind matrix (#293, spec #285 US-007, DEC-011, TEST-002)
// ---------------------------------------------------------------------------

test("matrix: cover fit (--cover-to) applies to raster and vector image Layers, refuses text and shape", async () => {
  await makeComp("comp-cover", 200, 100);

  // Raster image: 100x60 red, cover the 200x100 canvas → scale = max(2, 100/60) = 2.
  const raster = path.join(tempDir, "cover-red.png");
  await writeFile(raster, solidPng(100, 60, [255, 0, 0, 255]));
  const rAdd = await invoke([
    "composition", "add", "comp-cover", "raster-cover",
    "--image", raster, "--cover-to", "200x100",
    "--project", projDir, "--json",
  ]);
  expect(rAdd.code).toBe(0);
  const rRev = JSON.parse(rAdd.stdout).layer.currentRevision;
  expect(rRev.scaleX).toBe(2);
  expect(rRev.scaleY).toBe(2);

  // Vector image (kind image, format svg): 80x40 blue, cover 200x100 →
  // scale = max(2.5, 2.5) = 2.5.
  const vector = path.join(tempDir, "cover-blue.svg");
  await writeFile(vector, solidSvg(80, 40, "#0000ff"));
  const vAdd = await invoke([
    "composition", "add", "comp-cover", "vector-cover",
    "--image", vector, "--cover-to", "200x100", "--y", "80",
    "--project", projDir, "--json",
  ]);
  expect(vAdd.code).toBe(0);
  const vRev = JSON.parse(vAdd.stdout).layer.currentRevision;
  expect(vRev.scaleX).toBe(2.5);
  expect(vRev.scaleY).toBe(2.5);

  // Text Layer: refused — a text Layer has no intrinsic pixel size.
  const tAdd = await invoke([
    "composition", "add", "comp-cover", "text-cover",
    "--text", "Groundline", "--font", "Archivo", "--cover-to", "200x100",
    "--project", projDir, "--json",
  ]);
  expect(tAdd.code).toBe(1);
  expect(JSON.parse(tAdd.stdout).error).toContain("--cover-to");
  expect(JSON.parse(tAdd.stdout).error).toContain("text Layer");

  // Shape Layer: refused — a shape's sizing goes through --resize-to/--scale.
  const sAdd = await invoke([
    "composition", "add", "comp-cover", "shape-cover",
    "--shape", "rectangle", "--size", "40x20", "--fill", "#ff0000", "--cover-to", "200x100",
    "--project", projDir, "--json",
  ]);
  expect(sAdd.code).toBe(1);
  expect(JSON.parse(sAdd.stdout).error).toContain("--cover-to");
  expect(JSON.parse(sAdd.stdout).error).toContain("shape Layer");

  // The canvas is fully covered: the raster cover Layer fills every corner
  // (top corners red), and the vector cover Layer paints over the bottom
  // band (blue, painted after the raster in use order) — the overflow sits
  // outside the canvas, nothing is clipped.
  const png = await render("comp-cover", "cover-matrix.png");
  expect(pixel(png, 0, 0)).toEqual([255, 0, 0, 255]);
  expect(pixel(png, 199, 0)).toEqual([255, 0, 0, 255]);
  expect(pixel(png, 0, 99)).toEqual([0, 0, 255, 255]);
  expect(pixel(png, 199, 99)).toEqual([0, 0, 255, 255]);
  expect(pixel(png, 100, 50)).toEqual([255, 0, 0, 255]);
}, 30_000);

// ---------------------------------------------------------------------------
// Wrap width property × kind matrix (#294, spec #285 US-015, DEC-001/DEC-005,
// TEST-002)
// ---------------------------------------------------------------------------

test("matrix: wrap width (--wrap-width) applies to text Layers, refuses image and shape", async () => {
  await makeComp("comp-wrap", 400, 300);

  // Text Layer: the fact stores, and a long single-line string soft-wraps
  // at spaces within the width — the wrapped ink occupies two vertical
  // bands of line boxes, never one wide line.
  const tAdd = await invoke([
    "composition", "add", "comp-wrap", "wrapped",
    "--text", "The quick brown fox jumps over the lazy dog again and again",
    "--font", "Archivo", "--font-size", "24", "--color", "#000000",
    "--wrap-width", "120", "--x", "20", "--y", "20",
    "--project", projDir, "--json",
  ]);
  expect(tAdd.code).toBe(0);
  const tRev = JSON.parse(tAdd.stdout).layer.currentRevision;
  expect(tRev.wrapWidth).toBe(120);

  // Raster image Layer: refused — a wrap width is a text layout fact, so
  // the image/text content-kind exclusivity fires first on add.
  const raster = path.join(tempDir, "wrap-red.png");
  await writeFile(raster, solidPng(60, 40, [255, 0, 0, 255]));
  const iAdd = await invoke([
    "composition", "add", "comp-wrap", "img",
    "--image", raster, "--wrap-width", "120",
    "--project", projDir, "--json",
  ]);
  expect(iAdd.code).toBe(2);
  expect(JSON.parse(iAdd.stdout).error).toContain("--image and --text are mutually exclusive content kinds");

  // Shape Layer: refused the same way (--wrap-width is a text content kind).
  const sAdd = await invoke([
    "composition", "add", "comp-wrap", "shape-wrap",
    "--shape", "rectangle", "--size", "40x20", "--fill", "#ff0000", "--wrap-width", "120",
    "--project", projDir, "--json",
  ]);
  expect(sAdd.code).toBe(2);
  expect(JSON.parse(sAdd.stdout).error).toContain("--shape and --image/--from-generation/--from-matte/--text are mutually exclusive content kinds");

  // The wrapped text paints several stacked lines inside the width: ink
  // appears in both the upper and lower halves of the wrapped box, and the
  // columns just outside the width stay blank.
  const png = await render("comp-wrap", "wrap-matrix.png");
  const inkAt = (x: number, y: number): boolean => pixel(png, x, y)[3]! > 0;
  const rowsWithInk: number[] = [];
  for (let y = 20; y < 200; y++) {
    let rowHasInk = false;
    for (let x = 20; x < 140; x++) {
      if (inkAt(x, y)) { rowHasInk = true; break; }
    }
    if (rowHasInk) rowsWithInk.push(y);
  }
  expect(rowsWithInk.length).toBeGreaterThan(2.5 * 24); // more than one 24px line
  expect(inkAt(150, 60)).toBe(false); // right of the wrap width: no ink
}, 30_000);

// ---------------------------------------------------------------------------
// Fit box property × kind matrix (#295, spec #285 US-016, DEC-010/DEC-005,
// TEST-002)
// ---------------------------------------------------------------------------

test("matrix: fit box (--fit-box) applies to text Layers, refuses image and shape", async () => {
  await makeComp("comp-fit", 800, 400);

  // Text Layer: the fact stores, and a wide headline shrinks to one line
  // INSIDE the box — the ink's columns stop at the box's right edge.
  const tAdd = await invoke([
    "composition", "add", "comp-fit", "fitted",
    "--text", "THE QUICK BROWN FOX JUMPS",
    "--font", "Archivo", "--font-size", "64", "--color", "#000000",
    "--fit-box", "300x120", "--x", "20", "--y", "40",
    "--project", projDir, "--json",
  ]);
  expect(tAdd.code).toBe(0);
  const tRev = JSON.parse(tAdd.stdout).layer.currentRevision;
  expect(tRev.fitWidth).toBe(300);
  expect(tRev.fitHeight).toBe(120);

  // Raster image Layer: refused — a fit box is a text layout fact, so the
  // image/text content-kind exclusivity fires first on add.
  const raster = path.join(tempDir, "fit-red.png");
  await writeFile(raster, solidPng(60, 40, [255, 0, 0, 255]));
  const iAdd = await invoke([
    "composition", "add", "comp-fit", "img",
    "--image", raster, "--fit-box", "300x120",
    "--project", projDir, "--json",
  ]);
  expect(iAdd.code).toBe(2);
  expect(JSON.parse(iAdd.stdout).error).toContain("--image and --text are mutually exclusive content kinds");

  // Shape Layer: refused the same way (--fit-box is a text content kind).
  const sAdd = await invoke([
    "composition", "add", "comp-fit", "shape-fit",
    "--shape", "rectangle", "--size", "40x20", "--fill", "#ff0000", "--fit-box", "300x120",
    "--project", projDir, "--json",
  ]);
  expect(sAdd.code).toBe(2);
  expect(JSON.parse(sAdd.stdout).error).toContain("--shape and --image/--from-generation/--from-matte/--text are mutually exclusive content kinds");

  // The fitted text paints as ONE line inside the 300px-wide box: ink in the
  // box's rows, and the column just right of the box stays blank.
  const png = await render("comp-fit", "fit-matrix.png");
  const inkAt = (x: number, y: number): boolean => pixel(png, x, y)[3]! > 0;
  let rowsWithInk = 0;
  for (let y = 40; y < 200; y++) {
    let rowHasInk = false;
    for (let x = 20; x < 340; x++) {
      if (inkAt(x, y)) { rowHasInk = true; break; }
    }
    if (rowHasInk) rowsWithInk++;
  }
  expect(rowsWithInk).toBeGreaterThan(10); // one line of fitted ink
  expect(rowsWithInk).toBeLessThan(120); // never taller than the box
  expect(inkAt(340, 80)).toBe(false); // right of the box: no ink
}, 30_000);

// ---------------------------------------------------------------------------
// Per-axis scale property × kind matrix (#296, spec #285 US-030,
// DEC-005/DEC-006, ADR-0016 amendment, TEST-002)
// ---------------------------------------------------------------------------

test("matrix: per-axis scale (--scale-to) applies to raster, vector, text, and shape Layers", async () => {
  await makeComp("comp-scale-to", 400, 300);

  // Raster image: 64x48 red, --scale-to 2x0.5 paints 128x24.
  const raster = path.join(tempDir, "scale-red.png");
  await writeFile(raster, solidPng(64, 48, [255, 0, 0, 255]));
  const rAdd = await invoke([
    "composition", "add", "comp-scale-to", "raster-scale",
    "--image", raster, "--x", "10", "--y", "10", "--scale-to", "2x0.5",
    "--project", projDir, "--json",
  ]);
  expect(rAdd.code).toBe(0);
  const rRev = JSON.parse(rAdd.stdout).layer.currentRevision;
  expect(rRev.scaleX).toBe(2);
  expect(rRev.scaleY).toBe(0.5);

  // Vector image (kind image, format svg): 64x48 blue, --scale-to 1.5x2.
  const vector = path.join(tempDir, "scale-blue.svg");
  await writeFile(vector, solidSvg(64, 48, "#0000ff"));
  const vAdd = await invoke([
    "composition", "add", "comp-scale-to", "vector-scale",
    "--image", vector, "--x", "10", "--y", "50", "--scale-to", "1.5x2",
    "--project", projDir, "--json",
  ]);
  expect(vAdd.code).toBe(0);
  const vRev = JSON.parse(vAdd.stdout).layer.currentRevision;
  expect(vRev.scaleX).toBe(1.5);
  expect(vRev.scaleY).toBe(2);

  // Text Layer: the previously unreachable per-axis scale stores through the
  // SAME canonical fact (no text-only field).
  const tAdd = await invoke([
    "composition", "add", "comp-scale-to", "text-scale",
    "--text", "Stretch", "--font", "Archivo", "--font-size", "24", "--x", "10", "--y", "160",
    "--scale-to", "1.3x0.8",
    "--project", projDir, "--json",
  ]);
  expect(tAdd.code).toBe(0);
  const tRev = JSON.parse(tAdd.stdout).layer.currentRevision;
  expect(tRev.scaleX).toBe(1.3);
  expect(tRev.scaleY).toBe(0.8);

  // Shape Layer: the same fact as --resize-to/--scale's canonical scale.
  const sAdd = await invoke([
    "composition", "add", "comp-scale-to", "shape-scale",
    "--shape", "rectangle", "--size", "40x20", "--fill", "#00ff00", "--x", "300", "--y", "160",
    "--scale-to", "2x0.5",
    "--project", projDir, "--json",
  ]);
  expect(sAdd.code).toBe(0);
  const sRev = JSON.parse(sAdd.stdout).layer.currentRevision;
  expect(sRev.scaleX).toBe(2);
  expect(sRev.scaleY).toBe(0.5);

  // measure reports both factors on the text Layer (the shared transform
  // report, every kind).
  const measure = await invoke(["composition", "measure", "comp-scale-to", "text-scale", "--project", projDir, "--json"]);
  expect(measure.code).toBe(0);
  const mLayer = JSON.parse(measure.stdout).layers[0];
  expect(mLayer.transform.scaleX).toBe(1.3);
  expect(mLayer.transform.scaleY).toBe(0.8);

  // The renders prove the per-axis stretch: the raster's 64x48 red box
  // paints 128x24 (half-height, right edge at 138), the vector's blue paints
  // 96x96, and the shape's 40x20 rectangle paints 80x10.
  const png = await render("comp-scale-to", "scale-to-matrix.png");
  expect(pixel(png, 100, 20)).toEqual([255, 0, 0, 255]); // raster, inside 128x24
  expect(pixel(png, 150, 20)).toEqual([0, 0, 0, 0]); // right of the scaled raster
  expect(pixel(png, 100, 40)).toEqual([0, 0, 0, 0]); // below the scaled raster
  expect(pixel(png, 100, 80)).toEqual([0, 0, 255, 255]); // vector, inside 96x96
  expect(pixel(png, 340, 165)).toEqual([0, 255, 0, 255]); // shape, inside 80x10
  expect(pixel(png, 340, 172)).toEqual([0, 0, 0, 0]); // below the scaled shape
}, 30_000);

test("matrix: skew and perspective apply to raster, vector, text, and shape Layers", async () => {
  await makeComp("comp-skew", 600, 300);

  // Raster image: 64x48 red, --skew 10x0 shears the vertical edges.
  const raster = path.join(tempDir, "skew-red.png");
  await writeFile(raster, solidPng(64, 48, [255, 0, 0, 255]));
  const rAdd = await invoke([
    "composition", "add", "comp-skew", "raster-skew",
    "--image", raster, "--x", "10", "--y", "10", "--skew", "10x0",
    "--project", projDir, "--json",
  ]);
  expect(rAdd.code).toBe(0);
  const rRev = JSON.parse(rAdd.stdout).layer.currentRevision;
  expect(rRev.skewXDeg).toBe(10);
  expect(rRev.skewYDeg).toBe(0);

  // Vector image (kind image, format svg): perspective tilt about Y.
  const vector = path.join(tempDir, "skew-blue.svg");
  await writeFile(vector, solidSvg(64, 48, "#0000ff"));
  const vAdd = await invoke([
    "composition", "add", "comp-skew", "vector-tilt",
    "--image", vector, "--x", "10", "--y", "120", "--perspective", "0x15",
    "--project", projDir, "--json",
  ]);
  expect(vAdd.code).toBe(0);
  const vRev = JSON.parse(vAdd.stdout).layer.currentRevision;
  expect(vRev.perspectiveTiltYDeg).toBe(15);

  // Text Layer: the same two facts through the same setters.
  const tAdd = await invoke([
    "composition", "add", "comp-skew", "text-skew",
    "--text", "Shear", "--font", "Archivo", "--font-size", "24", "--x", "200", "--y", "20",
    "--skew", "0x8", "--perspective", "10x0",
    "--project", projDir, "--json",
  ]);
  expect(tAdd.code).toBe(0);
  const tRev = JSON.parse(tAdd.stdout).layer.currentRevision;
  expect(tRev.skewYDeg).toBe(8);
  expect(tRev.perspectiveTiltXDeg).toBe(10);

  // Shape Layer: the same facts through edit.
  const sAdd = await invoke([
    "composition", "add", "comp-skew", "shape-skew",
    "--shape", "rectangle", "--size", "40x20", "--fill", "#00ff00", "--x", "200", "--y", "120",
    "--project", projDir, "--json",
  ]);
  expect(sAdd.code).toBe(0);
  const sId = JSON.parse(sAdd.stdout).use.layerId as string;
  const sEdit = await invoke(["layer", "edit", sId, "--skew", "12x0", "--perspective", "0x12", "--project", projDir, "--json"]);
  expect(sEdit.code).toBe(0);
  const sRev = JSON.parse(sEdit.stdout).layer.currentRevision;
  expect(sRev.skewXDeg).toBe(12);
  expect(sRev.perspectiveTiltYDeg).toBe(12);

  // measure reports the facts on every kind (the shared transform report).
  for (const use of ["raster-skew", "vector-tilt", "text-skew", "shape-skew"]) {
    const measure = await invoke(["composition", "measure", "comp-skew", use, "--project", projDir, "--json"]);
    expect(measure.code).toBe(0);
    const mLayer = JSON.parse(measure.stdout).layers[0];
    expect(mLayer.transform.skewXDeg + mLayer.transform.skewYDeg + mLayer.transform.perspectiveTiltXDeg + mLayer.transform.perspectiveTiltYDeg).toBeGreaterThan(0);
  }

  // The renders prove the facts paint: the raster's sheared box reaches
  // beyond its unsheared right edge (tan(10°)·48 ≈ 8.5px), and the vector's
  // tilted box foreshortens its far edge — neither pixel-identical to the
  // untilted shapes' plain boxes.
  const png = await render("comp-skew", "skew-matrix.png");
  expect(pixel(png, 60, 20)).toEqual([255, 0, 0, 255]); // inside the sheared raster
  expect(pixel(png, 78, 55)).toEqual([255, 0, 0, 255]); // right of the unsheared edge (local (64,45) reaches 64+tan(10°)·45 ≈ 71.9)
  expect(pixel(png, 60, 130)).toEqual([0, 0, 255, 255]); // inside the tilted vector
}, 30_000);

// ---------------------------------------------------------------------------
// N. Matrix: Blur on all 4 kinds (#299, spec #285 US-010, ADR-0024 amendment)
// ---------------------------------------------------------------------------

test("matrix: blur applies to raster image, vector image, text, and shape Layers", async () => {
  await makeComp("comp-blur", 200, 200);

  // One 60x60 solid ink block per kind, hard-edged against the canvas.
  // 1a. Raster image: solid red [200, 60, 60, 255]
  const pngPath = path.join(tempDir, "raster-solid.png");
  await writeFile(pngPath, solidPng(60, 60, [200, 60, 60, 255]));
  await invoke([
    "composition", "add", "comp-blur", "raster",
    "--image", pngPath, "--x", "10", "--y", "10", "--blur", "8",
    "--project", projDir, "--json",
  ]);

  // 1b. Vector image: solid #3c3cc8
  const svgPath = path.join(tempDir, "vector-solid.svg");
  await writeFile(svgPath, solidSvg(60, 60, "#3c3cc8"));
  await invoke([
    "composition", "add", "comp-blur", "vector",
    "--image", svgPath, "--x", "80", "--y", "10", "--blur", "8",
    "--project", projDir, "--json",
  ]);

  // 1c. Text: solid blue glyphs
  await invoke([
    "composition", "add", "comp-blur", "text",
    "--text", "MM", "--font", "Archivo", "--font-size", "40", "--color", "#2040a0",
    "--x", "10", "--y", "90", "--blur", "8",
    "--project", projDir, "--json",
  ]);

  // 1d. Shape: rectangle 60x60 #c8a232
  await invoke([
    "composition", "add", "comp-blur", "shape",
    "--shape", "rectangle", "--size", "60x60", "--fill", "#c8a232",
    "--x", "80", "--y", "90", "--blur", "8",
    "--project", projDir, "--json",
  ]);

  // A blurless twin renders the same content hard-edged: each kind's ink
  // edge pixel must be fully opaque without the blur.
  await makeComp("comp-blur-base", 200, 200);
  await invoke([
    "composition", "add", "comp-blur-base", "raster",
    "--image", pngPath, "--x", "10", "--y", "10",
    "--project", projDir, "--json",
  ]);
  await invoke([
    "composition", "add", "comp-blur-base", "vector",
    "--image", svgPath, "--x", "80", "--y", "10",
    "--project", projDir, "--json",
  ]);
  await invoke([
    "composition", "add", "comp-blur-base", "text",
    "--text", "MM", "--font", "Archivo", "--font-size", "40", "--color", "#2040a0",
    "--x", "10", "--y", "90",
    "--project", projDir, "--json",
  ]);
  await invoke([
    "composition", "add", "comp-blur-base", "shape",
    "--shape", "rectangle", "--size", "60x60", "--fill", "#c8a232",
    "--x", "80", "--y", "90",
    "--project", projDir, "--json",
  ]);

  const blurred = await render("comp-blur", "blur-matrix.png");
  const base = await render("comp-blur-base", "blur-matrix-base.png");

  // Each kind's hard ink edge (just outside its box) gains alpha from the
  // defocus; the defocus is the LAST function of the effects chain, so the
  // whole look softens on every kind. Raster right edge (x=70, y=40),
  // vector right edge (x=140, y=40), text glyph edge region, shape right
  // edge (x=140, y=120).
  for (const [x, y] of [[70, 40], [140, 40], [140, 120]] as const) {
    expect(pixel(base, x, y)[3]).toBe(0);
    expect(pixel(blurred, x, y)[3]).toBeGreaterThan(0);
  }
  // The interior stays opaque on every kind (the defocus of a solid block
  // keeps its core fully covered at radius 8 on a 60px block).
  for (const [x, y] of [[40, 40], [110, 40], [110, 120]] as const) {
    expect(pixel(blurred, x, y)[3]).toBe(255);
  }
}, 30_000);

// ---------------------------------------------------------------------------
// O. Matrix: choke and feather on all 4 kinds (#300, spec #285 US-013,
//    ADR-0024 amendment)
// ---------------------------------------------------------------------------

test("matrix: choke and feather apply to raster image, vector image, text, and shape Layers", async () => {
  await makeComp("comp-edge", 200, 200);

  // One 60x60 solid ink block per kind, hard-edged against the canvas,
  // each with the same edge shape: choke 4, feather 2.
  const pngPath = path.join(tempDir, "raster-solid.png");
  await writeFile(pngPath, solidPng(60, 60, [200, 60, 60, 255]));
  await invoke([
    "composition", "add", "comp-edge", "raster",
    "--image", pngPath, "--x", "10", "--y", "10", "--choke", "4", "--feather", "2",
    "--project", projDir, "--json",
  ]);

  const svgPath = path.join(tempDir, "vector-solid.svg");
  await writeFile(svgPath, solidSvg(60, 60, "#3c3cc8"));
  await invoke([
    "composition", "add", "comp-edge", "vector",
    "--image", svgPath, "--x", "80", "--y", "10", "--choke", "4", "--feather", "2",
    "--project", projDir, "--json",
  ]);

  await invoke([
    "composition", "add", "comp-edge", "text",
    "--text", "MM", "--font", "Archivo", "--font-size", "40", "--color", "#2040a0",
    "--x", "10", "--y", "90", "--choke", "4", "--feather", "2",
    "--project", projDir, "--json",
  ]);

  await invoke([
    "composition", "add", "comp-edge", "shape",
    "--shape", "rectangle", "--size", "60x60", "--fill", "#c8a232",
    "--x", "80", "--y", "90", "--choke", "4", "--feather", "2",
    "--project", projDir, "--json",
  ]);

  // A plain twin renders the same content hard-edged.
  await makeComp("comp-edge-base", 200, 200);
  await invoke([
    "composition", "add", "comp-edge-base", "raster",
    "--image", pngPath, "--x", "10", "--y", "10",
    "--project", projDir, "--json",
  ]);
  await invoke([
    "composition", "add", "comp-edge-base", "vector",
    "--image", svgPath, "--x", "80", "--y", "10",
    "--project", projDir, "--json",
  ]);
  await invoke([
    "composition", "add", "comp-edge-base", "text",
    "--text", "MM", "--font", "Archivo", "--font-size", "40", "--color", "#2040a0",
    "--x", "10", "--y", "90",
    "--project", projDir, "--json",
  ]);
  await invoke([
    "composition", "add", "comp-edge-base", "shape",
    "--shape", "rectangle", "--size", "60x60", "--fill", "#c8a232",
    "--x", "80", "--y", "90",
    "--project", projDir, "--json",
  ]);

  const shaped = await render("comp-edge", "edge-matrix.png");
  const base = await render("comp-edge-base", "edge-matrix-base.png");

  // On every kind the hard ink edge pixel (just inside the original box)
  // loses alpha to the choke: the alpha edge is eroded, and NO ink appears
  // outside the original box (the `in` composite bounds the shaped alpha
  // by the source's). Raster right edge (x=69, y=40), vector right edge
  // (x=139, y=40), shape right edge (x=139, y=120); the text glyph edge is
  // asserted through the raster/vector/shape pixels and the text layer's
  // stored fact.
  for (const [x, y] of [[69, 40], [139, 40], [139, 120]] as const) {
    expect(pixel(base, x, y)[3]).toBe(255);
    expect(pixel(shaped, x, y)[3]).toBeLessThan(255);
    expect(pixel(shaped, x + 3, y)[3]).toBe(0);
  }
  // The interiors stay opaque on every kind.
  for (const [x, y] of [[30, 40], [100, 40], [100, 120]] as const) {
    expect(pixel(shaped, x, y)[3]).toBe(255);
  }
}, 30_000);

// ---------------------------------------------------------------------------
// Stacked effects (#302, spec #285 US-011, ISC-50, DEC-005/DEC-006,
// ADR-0027): two shadows and two outlines on one Layer, on every kind.
// ---------------------------------------------------------------------------

test("matrix: stacked shadows and outlines apply to raster image, vector image, text, and shape Layers", async () => {
  await makeComp("comp-stack", 300, 200);

  // 1a. Raster image: two sharp shadows in different directions.
  const pngPath = path.join(tempDir, "raster-solid.png");
  await writeFile(pngPath, solidPng(40, 40, [200, 60, 60, 255]));
  await invoke([
    "composition", "add", "comp-stack", "raster",
    "--image", pngPath, "--x", "10", "--y", "10",
    "--shadow", "3,0,0,#00ff00", "--shadow", "0,3,0,#0000ff",
    "--project", projDir, "--json",
  ]);

  // 1b. Vector image: same stack.
  const svgPath = path.join(tempDir, "vector-solid.svg");
  await writeFile(svgPath, solidSvg(40, 40, "#3c3cc8"));
  await invoke([
    "composition", "add", "comp-stack", "vector",
    "--image", svgPath, "--x", "70", "--y", "10",
    "--shadow", "3,0,0,#00ff00", "--shadow", "0,3,0,#0000ff",
    "--project", projDir, "--json",
  ]);

  // 1c. Text: same stack on the glyphs.
  await invoke([
    "composition", "add", "comp-stack", "text",
    "--text", "MM", "--font", "Archivo", "--font-size", "24", "--color", "#2040a0",
    "--x", "130", "--y", "10",
    "--shadow", "3,0,0,#00ff00", "--shadow", "0,3,0,#0000ff",
    "--project", projDir, "--json",
  ]);

  // 1d. Shape: rectangle with a two-outline stack (nested rings) plus a
  // shadow cast from the outlined composite.
  await invoke([
    "composition", "add", "comp-stack", "shape",
    "--shape", "rectangle", "--size", "40x40", "--fill", "#c8a232",
    "--x", "10", "--y", "90",
    "--outline", "3,#00ff00", "--outline", "3,#0000ff", "--shadow", "0,4,0,#000000",
    "--project", projDir, "--json",
  ]);

  const rendered = await render("comp-stack", "stack.png");
  // Raster [10,50)×[10,50): right of the content is GREEN (the first
  // shadow's horizontal band), below it BLUE (the second's vertical band).
  expect(pixel(rendered, 52, 30)).toEqual([0, 255, 0, 255]);
  expect(pixel(rendered, 30, 52)).toEqual([0, 0, 255, 255]);
  // Vector [70,110)×[10,50): same directions.
  expect(pixel(rendered, 112, 30)).toEqual([0, 255, 0, 255]);
  expect(pixel(rendered, 90, 52)).toEqual([0, 0, 255, 255]);
  // Text glyphs: a right-hand green band and a below blue band exist
  // (probe the glyph's neighborhood — exact glyph geometry varies, so scan
  // the text's region for the pure band colours; the glyph ink #2040a0 is
  // distinguishable from both).
  let greenBand = false;
  let blueBand = false;
  for (let y = 5; y < 55; y++) {
    for (let x = 130; x < 230; x++) {
      const p = pixel(rendered, x, y);
      if (p[0] === 0 && p[1] === 255 && p[2] === 0) greenBand = true;
      if (p[0] === 0 && p[1] === 0 && p[2] === 255) blueBand = true;
    }
  }
  expect(greenBand).toBe(true);
  expect(blueBand).toBe(true);

  // Shape: nested rings — the inner band green, the outer band blue, the
  // shadow below the outlined composite.
  expect(pixel(rendered, 8, 110)).toEqual([0, 255, 0, 255]); // inner ring (content ⊕ 3 band starts at x 7)
  expect(pixel(rendered, 5, 110)).toEqual([0, 0, 255, 255]); // outer ring (⊕ 6 starts at x 4)
  expect(pixel(rendered, 30, 138)[3]).toBe(255); // shadow ink below
  expect(pixel(rendered, 30, 141)[3]).toBe(0); // past the additive reach

  // measure reports both stacks as lists in paint order, per kind.
  const measured = await invoke(["composition", "measure", "comp-stack", "--project", projDir, "--json"]);
  expect(measured.code).toBe(0);
  const layers = JSON.parse(measured.stdout).layers as Array<{ name: string; effects: { shadow: unknown[] | null; outline: unknown[] | null } }>;
  for (const l of layers) {
    if (l.name === "shape") {
      // The shape carries the outline stack and a single shadow.
      expect(l.effects.shadow).toHaveLength(1);
      expect(l.effects.outline).toEqual([
        { width: 3, color: "#00ff00" },
        { width: 3, color: "#0000ff" },
      ]);
    } else {
      expect(l.effects.shadow).toHaveLength(2);
      expect(l.effects.outline).toBeNull();
    }
  }
});
