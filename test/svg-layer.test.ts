/**
 * Vector image import (#213, spec #207 US-004, DEC-007/009/010/011): `--image`
 * accepts a local SVG at add and at edit. The result is an image Layer whose
 * format is recorded as SVG and whose bytes are retained unchanged, painted
 * through the browser's `<img>` path — which disables scripts and external
 * loads by construction — and rasterized at the painted size and supersample
 * factor, never from a fixed bitmap, so one file is crisp at any scale.
 *
 * TEST-004/006/007: external behaviour at the CLI and rendered-pixel seams
 * the composition-render / layer-edit / composition-measure / render-history
 * tests already use — run the command, assert the JSON result and refusal
 * text, render, and assert pixels and measured extents. Every test file
 * stays runnable under the per-file `bun test --isolate` topology and
 * offline (no weights, no network, nothing that fetches or executes).
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { decodePng } from "../src/png.js";

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

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-svg-layer-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "svg-proj"]);
  await invoke([
    "composition", "create", "poster", "--width", "200", "--height", "120", "--project", projDir,
  ]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

/** A minimal red-mark SVG with a declared intrinsic size. */
function markSvg(width: number, height: number, extraAttrs = ""): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ${extraAttrs}` +
    `viewBox="0 0 ${width} ${height}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ff0000"/>` +
    `<rect x="${Math.round(width / 4)}" y="${Math.round(height / 4)}" width="${Math.round(width / 2)}" height="${Math.round(height / 2)}" fill="#0000ff"/>` +
    `</svg>`
  );
}

function pixel(
  png: ReturnType<typeof decodePng>,
  x: number,
  y: number,
): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

const close = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

const expectPixel = (
  png: ReturnType<typeof decodePng>,
  x: number,
  y: number,
  rgba: readonly [number, number, number, number],
  tol = 2,
) => {
  const p = pixel(png, x, y);
  expect(p.every((v, i) => close(v, rgba[i]!, tol))).toBe(true);
};

// ---------------------------------------------------------------------------
// Ingestion: add, inspect, retained bytes, rendered pixels (TEST-004)
// ---------------------------------------------------------------------------

test("an SVG imports at add as an image Layer with a recorded vector format, unchanged bytes, and declared intrinsic size", async () => {
  const svgPath = path.join(tempDir, "mark.svg");
  const svg = markSvg(80, 40);
  await writeFile(svgPath, svg);

  const add = await invoke([
    "composition", "add", "poster", "logo",
    "--image", svgPath, "--x", "50", "--y", "30",
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const addJson = JSON.parse(add.stdout);
  expect(addJson.ok).toBe(true);
  const layerId = addJson.use.layerId as string;

  // Image-kind content with the vector format recorded (DEC-007): the
  // revision kind stays "image", the intrinsic facts come from the file's
  // own width/height attributes.
  const rev = addJson.layer.currentRevision;
  expect(rev.kind).toBe("image");
  expect(rev.format).toBe("svg");
  expect(rev.width).toBe(80);
  expect(rev.height).toBe(40);
  expect(rev.x).toBe(50);
  expect(rev.y).toBe(30);

  // The retained bytes equal the source bytes, never rewritten.
  const contentHash = rev.contentHash as string;
  const blob = await readFile(path.join(projDir, "content", contentHash));
  expect(blob.equals(Buffer.from(svg))).toBe(true);

  // inspect reports the vector format.
  const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(inspect.code).toBe(0);
  const inspectJson = JSON.parse(inspect.stdout);
  expect(inspectJson.layer.currentRevision.format).toBe("svg");
  expect(inspectJson.layer.currentRevision.width).toBe(80);
  expect(inspectJson.layer.currentRevision.height).toBe(40);

  // The render paints the vector at the intrinsic size: full-bleed red with
  // the blue inner mark at its declared position, transparent margins.
  const render = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(render.code).toBe(0);
  const png = decodePng(await readFile(JSON.parse(render.stdout).render.output));
  expect(png.width).toBe(200);
  expect(png.height).toBe(120);
  expectPixel(png, 50, 30, [255, 0, 0, 255]);
  expectPixel(png, 70, 40, [0, 0, 255, 255]);
  expectPixel(png, 129, 69, [255, 0, 0, 255]);
  expectPixel(png, 45, 25, [0, 0, 0, 0]);
  expectPixel(png, 135, 75, [0, 0, 0, 0]);
});

test("intrinsic size comes from the viewBox when the file declares no usable width/height", async () => {
  const svgPath = path.join(tempDir, "vb.svg");
  await writeFile(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 16"><rect width="64" height="16" fill="#00aa00"/></svg>`);

  const add = await invoke([
    "composition", "add", "poster", "logo", "--image", svgPath, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const rev = JSON.parse(add.stdout).layer.currentRevision;
  expect(rev.format).toBe("svg");
  expect(rev.width).toBe(64);
  expect(rev.height).toBe(16);
});

test("the conventional SVG prolog — declaration, comment, DOCTYPE with an internal subset — parses", async () => {
  const svgPath = path.join(tempDir, "prolog.svg");
  await writeFile(
    svgPath,
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n` +
      `<!-- generated by a design tool -->\n` +
      `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n` +
      `  <!-- a local subset with no entity declarations (entities are refused at ingestion, #214) -->\n` +
      `]>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="8"><rect width="32" height="8" fill="#ff0000"/></svg>`,
  );
  const add = await invoke([
    "composition", "add", "poster", "logo", "--image", svgPath, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const rev = JSON.parse(add.stdout).layer.currentRevision;
  expect(rev.format).toBe("svg");
  expect(rev.width).toBe(32);
  expect(rev.height).toBe(8);
});

test("a file declaring neither width/height nor a viewBox is refused, naming the fix", async () => {
  const svgPath = path.join(tempDir, "nosize.svg");
  await writeFile(svgPath, `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="#ff0000"/></svg>`);

  const add = await invoke([
    "composition", "add", "poster", "logo", "--image", svgPath, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(1);
  const json = JSON.parse(add.stdout);
  expect(json.ok).toBe(false);
  expect(json.error).toContain("no usable intrinsic size");
  expect(json.error).toContain("width and height");
  expect(json.error).toContain("viewBox");
  // Nothing published: no Layer, no use, no content.
  const list = await invoke(["composition", "list", "--project", projDir, "--json"]);
  expect(JSON.parse(list.stdout).compositions[0].layers).toEqual([]);
});

// ---------------------------------------------------------------------------
// Ingestion refusals at the one image ingestion point (TEST-007)
// ---------------------------------------------------------------------------

test("malformed or non-SVG bytes with an .svg name are refused at the ingestion point", async () => {
  const cases: Array<[string, string, string]> = [
    ["garbage.svg", "this is not markup at all", "root element"],
    ["wrong-root.svg", `<html><body>hello</body></html>`, "root element"],
    ["truncated.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect fill="#f00">`, ""],
  ];
  for (const [name, content, _hint] of cases) {
    const svgPath = path.join(tempDir, name);
    await writeFile(svgPath, content);
    const add = await invoke([
      "composition", "add", "poster", "logo", "--image", svgPath, "--project", projDir, "--json",
    ]);
    expect(add.code).toBe(1);
    const json = JSON.parse(add.stdout);
    expect(json.ok).toBe(false);
    // The refusal is at the ingestion point — malformed bytes, not an
    // over-limit or missing-file problem.
    expect(json.error).toMatch(/not an SVG document|truncated|Malformed SVG/);
    const list = await invoke(["composition", "list", "--project", projDir, "--json"]);
    expect(JSON.parse(list.stdout).compositions[0].layers).toEqual([]);
  }
});

// ---------------------------------------------------------------------------
// Edit: content replacement by --image, format and intrinsic facts update
// ---------------------------------------------------------------------------

test("layer edit replaces an image Layer's content with an SVG and with a raster", async () => {
  const svgPath = path.join(tempDir, "mark.svg");
  await writeFile(svgPath, markSvg(80, 40));
  const svg2Path = path.join(tempDir, "mark2.svg");
  await writeFile(svg2Path, markSvg(120, 60));

  const add = await invoke([
    "composition", "add", "poster", "logo", "--image", svgPath, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const layerId = JSON.parse(add.stdout).use.layerId as string;

  // A raster Layer becomes a vector Layer by edit — the content option is
  // --image either way; the format fact follows the new bytes.
  const editToSvg = await invoke([
    "layer", "edit", layerId, "--image", svg2Path, "--project", projDir, "--json",
  ]);
  expect(editToSvg.code).toBe(0);
  const edited = JSON.parse(editToSvg.stdout).layer.currentRevision;
  expect(edited.format).toBe("svg");
  expect(edited.width).toBe(120);
  expect(edited.height).toBe(60);

  // And back: a vector Layer becomes a raster Layer by edit.
  const { encodePngRgba } = await import("../src/png.js");
  const pngPath = path.join(tempDir, "solid.png");
  const buf = Buffer.alloc(8 * 8 * 4);
  buf.fill(255);
  buf[2] = 0;
  buf[3 + 2] = 0;
  await writeFile(pngPath, encodePngRgba(8, 8, buf));
  const editToPng = await invoke([
    "layer", "edit", layerId, "--image", pngPath, "--project", projDir, "--json",
  ]);
  expect(editToPng.code).toBe(0);
  expect(JSON.parse(editToPng.stdout).layer.currentRevision.format).toBe("png");
});

// ---------------------------------------------------------------------------
// TEST-004: crisp at any scale — the same fixture rendered large is sharper
// than an upscaled raster of the small render
// ---------------------------------------------------------------------------

/** Count partially-transparent pixels (the anti-aliasing band) in a decoded
 *  PNG. A vector re-rasterized at a larger size keeps its ~1px band; an
 *  upscaled raster's band grows proportionally to the upscale factor. */
function antiAliasedPixels(png: ReturnType<typeof decodePng>): number {
  let count = 0;
  for (let i = 0; i < png.width * png.height; i++) {
    const a = png.rgba[i * 4 + 3]!;
    if (a > 0 && a < 255) count++;
  }
  return count;
}

/** Bilinear upscale of a decoded RGBA PNG — the fixed-bitmap baseline an SVG
 *  render must beat. */
function upscale(src: ReturnType<typeof decodePng>, factor: number): { width: number; height: number; rgba: Buffer } {
  const rgba = Buffer.alloc(src.width * factor * src.height * factor * 4);
  for (let y = 0; y < src.height * factor; y++) {
    for (let x = 0; x < src.width * factor; x++) {
      const sx = x / factor;
      const sy = y / factor;
      const x0 = Math.min(Math.floor(sx), src.width - 1);
      const y0 = Math.min(Math.floor(sy), src.height - 1);
      const x1 = Math.min(x0 + 1, src.width - 1);
      const y1 = Math.min(y0 + 1, src.height - 1);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let c = 0; c < 4; c++) {
        const v =
          src.rgba[(y0 * src.width + x0) * 4 + c]! * (1 - fx) * (1 - fy) +
          src.rgba[(y0 * src.width + x1) * 4 + c]! * fx * (1 - fy) +
          src.rgba[(y1 * src.width + x0) * 4 + c]! * (1 - fx) * fy +
          src.rgba[(y1 * src.width + x1) * 4 + c]! * fx * fy;
        rgba[(y * src.width * factor + x) * 4 + c] = v;
      }
    }
  }
  return { width: src.width * factor, height: src.height * factor, rgba };
}

test("the same SVG rendered small and large is sharper at the large size than an upscaled raster of the small render", async () => {
  const factor = 10;
  const svgPath = path.join(tempDir, "crisp.svg");
  // Rounded corners give the fixture a curved edge whose anti-aliasing band
  // distinguishes re-rasterization from bitmap upscaling.
  await writeFile(
    svgPath,
    `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60">` +
      `<rect x="5" y="5" width="50" height="50" fill="#ff0000" rx="6"/></svg>`,
  );

  const small = await invoke(["project", "init", path.join(tempDir, "small"), "--name", "small-proj"]);
  expect(small.code).toBe(0);
  await invoke(["composition", "create", "small", "--width", "60", "--height", "60", "--project", path.join(tempDir, "small")]);
  const addSmall = await invoke([
    "composition", "add", "small", "logo", "--image", svgPath, "--project", path.join(tempDir, "small"), "--json",
  ]);
  expect(addSmall.code).toBe(0);
  const layerId = JSON.parse(addSmall.stdout).use.layerId as string;
  const renderSmall = await invoke(["composition", "render", "small", "--project", path.join(tempDir, "small"), "--json"]);
  expect(renderSmall.code).toBe(0);
  const smallPng = decodePng(await readFile(JSON.parse(renderSmall.stdout).render.output));
  expect(smallPng.width).toBe(60);

  // The same file at a 10× scale in a 10× canvas: the vector re-rasterizes
  // at the painted size rather than upscaling a fixed bitmap.
  await invoke(["composition", "create", "large", "--width", "600", "--height", "600", "--project", projDir]);
  const addLarge = await invoke([
    "composition", "add", "large", "logo", "--image", svgPath,
    "--scale", "10", "--project", projDir, "--json",
  ]);
  expect(addLarge.code).toBe(0);
  // A second Project's use is an independent Layer identity sharing the file.
  const largeLayerId = JSON.parse(addLarge.stdout).use.layerId as string;
  expect(largeLayerId).not.toBe(layerId);
  const renderLarge = await invoke(["composition", "render", "large", "--project", projDir, "--json"]);
  expect(renderLarge.code).toBe(0);
  const largePng = decodePng(await readFile(JSON.parse(renderLarge.stdout).render.output));
  expect(largePng.width).toBe(600);

  const vectorLarge = antiAliasedPixels(largePng);
  const upscaledSmall = antiAliasedPixels(upscale(smallPng, factor) as never);
  // A re-rasterized band is ~1 device px wide at any scale; a bilinear
  // upscale of the small render's band grows ~factor×. A clear gap between
  // the two proves the vector was rasterized at the painted size (TEST-004).
  expect(vectorLarge).toBeGreaterThan(100); // the curve is present and smooth
  expect(vectorLarge).toBeLessThan(upscaledSmall / 4);
});

// ---------------------------------------------------------------------------
// Transform, anchored placement, shadow, outline, visible region, measure
// ---------------------------------------------------------------------------

test("transform, shadow, outline, and measure work on a vector Layer as on a raster", async () => {
  const svgPath = path.join(tempDir, "mark.svg");
  await writeFile(svgPath, markSvg(40, 40));
  const add = await invoke([
    "composition", "add", "poster", "logo",
    "--image", svgPath, "--x", "40", "--y", "40",
    "--shadow", "4,4,0,#000000", "--outline", "2,#ffffff",
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const layerId = JSON.parse(add.stdout).use.layerId as string;

  // A scaled vector renders with its effects hugging the vector ink: the
  // 2× content box (40,40)..(120,120), the white outline ring hugging its
  // edge, and the black shadow cast 8 canvas px past the ring (the 4px local
  // offset × the 2× scale).
  await invoke(["layer", "edit", layerId, "--scale", "2", "--project", projDir, "--json"]);
  const render = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(render.code).toBe(0);
  const png = decodePng(await readFile(JSON.parse(render.stdout).render.output));
  expectPixel(png, 70, 60, [0, 0, 255, 255]); // interior of the inner mark
  expectPixel(png, 50, 60, [255, 0, 0, 255]); // the outer fill
  expectPixel(png, 37, 60, [255, 255, 255, 255]); // outline ring, left edge
  expectPixel(png, 126, 60, [0, 0, 0, 255]); // shadow-only strip right of the ring
  expectPixel(png, 128, 60, [0, 0, 0, 255]); // the strip is 4 canvas px wide (2px ring + 8px shadow reach − 2px pad)

  // measure reports the transformed content box like any other image Layer.
  const measure = await invoke([
    "composition", "measure", "poster", "--project", projDir, "--json",
  ]);
  expect(measure.code).toBe(0);
  const m = JSON.parse(measure.stdout).layers[0];
  expect(m.content).toEqual({ width: 40, height: 40 }); // untransformed content
  expect(m.box).toEqual({ x: 40, y: 40, width: 80, height: 80 }); // transformed box

  // Rotation maps the canonical transform exactly as for a raster: the
  // content box's corners rotate about the placement point.
  await invoke(["layer", "edit", layerId, "--rotate", "90", "--project", projDir, "--json"]);
  const rotated = await invoke([
    "composition", "measure", "poster", "--project", projDir, "--json",
  ]);
  expect(rotated.code).toBe(0);
  const rm2 = JSON.parse(rotated.stdout).layers[0];
  expect(rm2.corners).toEqual([
    { x: 40, y: 40 },
    { x: 40, y: 120 },
    { x: -40, y: 120 },
    { x: -40, y: 40 },
  ]);
});

test("anchored placement and the visible region resolve against vector ink", async () => {
  const svgPath = path.join(tempDir, "mark.svg");
  // 60×20 red bar.
  await writeFile(
    svgPath,
    `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="20" viewBox="0 0 60 20"><rect width="60" height="20" fill="#ff0000"/></svg>`,
  );
  const add = await invoke([
    "composition", "add", "poster", "logo", "--image", svgPath, "--x", "10", "--y", "10", "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const layerId = JSON.parse(add.stdout).use.layerId as string;

  // Anchored placement resolves against the vector's intrinsic ink exactly
  // as for a raster: the 60×20 bar's right ink edge lands on the target x.
  const anchored = await invoke([
    "layer", "edit", layerId, "--anchor", "right", "--x", "200", "--project", projDir, "--json",
  ]);
  expect(anchored.code).toBe(0);
  expect(JSON.parse(anchored.stdout).layer.currentRevision.x).toBe(200 - 60);

  // The visible region crops the vector without touching the retained bytes:
  // the left half of the content is ink, the right half is not.
  const regionEdit = await invoke([
    "layer", "edit", layerId,
    "--visible-region", "0,0,30,20", "--project", projDir, "--json",
  ]);
  expect(regionEdit.code).toBe(0);
  const render = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(render.code).toBe(0);
  const png = decodePng(await readFile(JSON.parse(render.stdout).render.output));
  expectPixel(png, 141, 15, [255, 0, 0, 255]);
  expectPixel(png, 160, 15, [255, 0, 0, 255]);
  expectPixel(png, 169, 15, [255, 0, 0, 255]);
  // The uncropped right half: not ink.
  expectPixel(png, 171, 15, [0, 0, 0, 0]);
  expectPixel(png, 199, 15, [0, 0, 0, 0]);

  // The retained bytes are unchanged by the region edit.
  const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  const rev = JSON.parse(inspect.stdout).layer.currentRevision;
  const blob = await readFile(path.join(projDir, "content", rev.contentHash));
  expect(blob.equals(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="20" viewBox="0 0 60 20"><rect width="60" height="20" fill="#ff0000"/></svg>`,
  ))).toBe(true);
});

// ---------------------------------------------------------------------------
// TEST-006: replay after edits and relocation; cross-Project import
// ---------------------------------------------------------------------------

test("replay is byte-identical after edits and relocation; cross-Project import carries the vector bytes", async () => {
  const svgPath = path.join(tempDir, "mark.svg");
  await writeFile(svgPath, markSvg(80, 40));
  const add = await invoke([
    "composition", "add", "poster", "logo", "--image", svgPath, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const layerId = JSON.parse(add.stdout).use.layerId as string;

  const render = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(render.code).toBe(0);
  const renderJson = JSON.parse(render.stdout);
  const manifestPath = renderJson.render.manifest as string;
  const originalPng = await readFile(renderJson.render.output);

  // Later current-state edits do not change the pinned Render.
  await invoke(["layer", "edit", layerId, "--scale", "2", "--project", projDir, "--json"]);
  const replay = await invoke(["composition", "replay", manifestPath, "--project", projDir, "--json"]);
  expect(replay.code).toBe(0);
  expect(await readFile(JSON.parse(replay.stdout).replay.output)).toEqual(originalPng);

  // Relocation: a copy of the Project moves; replay still reproduces from
  // retained bytes.
  const { cp } = await import("node:fs/promises");
  const movedDir = path.join(tempDir, "relocated");
  await cp(projDir, movedDir, { recursive: true });
  const replayMoved = await invoke(
    ["composition", "replay", path.join(movedDir, path.relative(projDir, manifestPath)), "--project", movedDir, "--json"],
  );
  expect(replayMoved.code).toBe(0);
  expect(await readFile(JSON.parse(replayMoved.stdout).replay.output)).toEqual(originalPng);

  // Cross-Project import: the destination Layer's retained bytes are the
  // source bytes, and its render matches the source's.
  const otherDir = path.join(tempDir, "other");
  await invoke(["project", "init", otherDir, "--name", "other-proj"]);
  await invoke(["composition", "create", "poster", "--width", "200", "--height", "120", "--project", otherDir]);
  const imp = await invoke([
    "composition", "import", "poster", "poster", "--from-project", projDir, "--project", otherDir, "--json",
  ]);
  expect(imp.code).toBe(0);
  const importedLayerId = JSON.parse(imp.stdout).importedUses[0].layerId as string;
  expect(importedLayerId).not.toBe(layerId);
  const inspect = await invoke(["layer", "inspect", importedLayerId, "--project", otherDir, "--json"]);
  const rev = JSON.parse(inspect.stdout).layer.currentRevision;
  expect(rev.format).toBe("svg");
  const blob = await readFile(path.join(otherDir, "content", rev.contentHash));
  expect(blob.equals(Buffer.from(markSvg(80, 40)))).toBe(true);
});