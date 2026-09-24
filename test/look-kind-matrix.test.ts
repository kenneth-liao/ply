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
