/**
 * The absolute per-axis scale setter (--scale-to <XxY>, #296, spec #285
 * US-030, DEC-005/DEC-006, ADR-0016 amendment), verified at the CLI and
 * measure seams (TEST-002, offline):
 *
 * - Every Layer kind — raster image, text, shape — takes independent
 *   horizontal and vertical scale as an ABSOLUTE setter through the ONE
 *   canonical scale fact (scaleX/scaleY, ADR-0016): no text-only field, no
 *   second scale home. The acceptance probe: a text Layer scaled 1.3 by 0.8
 *   renders stretched and `measure` reports both factors.
 * - The uniform `--scale` keeps its meaning. Uniform and per-axis are ONE
 *   stored fact, so setting either wholly replaces the other — never
 *   compounding; repeating either command is idempotent.
 * - `--scale-to 1x1` is the removal form: the scale normalizes back to
 *   identity, the paint emits no transform, and the render is restored
 *   byte-for-byte.
 * - Wrap width and fit box are layout px BEFORE transforms (#294/#295):
 *   the per-axis scale maps the wrapped layout box into canvas space.
 * - Mutual exclusion with the other resize forms is refused before
 *   publication, with mirrored wording on `composition add` and
 *   `layer edit`, and per-axis factors share the uniform `--scale` bounds
 *   wording.
 * - A Render retained before the edit replays byte-identically (pinned
 *   history stays pinned).
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePngRgba, decodePng } from "../src/png.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

interface Result {
  stdout: string;
  stderr: string;
  code: number;
}

async function invoke(args: string[]): Promise<Result> {
  const proc = Bun.spawn([process.execPath, cli, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, code };
}

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    const [r, g, b, a] = rgba;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
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

const RED: [number, number, number, number] = [255, 0, 0, 255];

let tempDir: string;
let projDir: string;
let imagePath: string;
let svgPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-scale-to-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir]);
  await invoke(["composition", "create", "poster", "--width", "600", "--height", "400", "--project", projDir]);
  imagePath = path.join(tempDir, "red.png");
  await writeFile(imagePath, solidPng(64, 48, RED));
  svgPath = path.join(tempDir, "blue.svg");
  await writeFile(svgPath, solidSvg(64, 48, "#0000ff"));
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function addLayer(use: string, args: string[]): Promise<{ layerId: string; revisionId: string }> {
  const res = await invoke([
    "composition", "add", "poster", use, ...args, "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const parsed = JSON.parse(res.stdout);
  return { layerId: parsed.use.layerId as string, revisionId: parsed.layer.currentRevisionId as string };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function editJson(layerId: string, args: string[]): Promise<{ code: number; parsed: any; stderr: string; stdout: string }> {
  const res = await invoke(["layer", "edit", layerId, ...args, "--project", projDir, "--json"]);
  const parsed: any = res.code === 0 ? JSON.parse(res.stdout) : undefined;
  return { code: res.code, parsed, stderr: res.stderr, stdout: res.stdout };
}

/** The measured transform and box of a use (the read-only measure seam). */
async function measureUse(use: string): Promise<{
  scaleX: number; scaleY: number; content: { width: number; height: number }; box: Record<string, number>;
}> {
  const res = await invoke(["composition", "measure", "poster", use, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const layer = JSON.parse(res.stdout).layers[0];
  return { scaleX: layer.transform.scaleX, scaleY: layer.transform.scaleY, content: layer.content, box: layer.box };
}

async function render(comp: string, out: string): Promise<ReturnType<typeof decodePng>> {
  const res = await invoke(["composition", "render", comp, "--out", path.join(tempDir, out), "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return decodePng(await readFile(path.join(tempDir, out)));
}

async function revisionIdOf(layerId: string): Promise<string> {
  const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  return JSON.parse(inspect.stdout).layer.currentRevisionId as string;
}

// ---------------------------------------------------------------------------
// The acceptance probe (US-030 criterion 2–3): text scales 1.3 by 0.8,
// renders stretched, and measure reports both factors.
// ---------------------------------------------------------------------------

test("a text Layer scaled 1.3 by 0.8 renders stretched and measure reports both factors", async () => {
  const { layerId } = await addLayer("headline", [
    "--text", "Scale me", "--font", "Archivo", "--font-size", "40", "--color", "#ff0000", "--x", "20", "--y", "40",
  ]);

  const pngBefore = await render("poster", "text-before.png");

  const before = await measureUse("headline");
  expect(before.scaleX).toBe(1);
  expect(before.scaleY).toBe(1);
  const baseW = before.box.width;
  const baseH = before.box.height;

  const edit = await editJson(layerId, ["--scale-to", "1.3x0.8"]);
  expect(edit.code).toBe(0);
  expect(edit.parsed.layer.currentRevision.scaleX).toBe(1.3);
  expect(edit.parsed.layer.currentRevision.scaleY).toBe(0.8);

  // measure reports both factors and the transformed box.
  const after = await measureUse("headline");
  expect(after.scaleX).toBe(1.3);
  expect(after.scaleY).toBe(0.8);
  // measure rounds to hundredths of a px.
  expect(Math.abs(after.box.width - baseW * 1.3)).toBeLessThan(0.05);
  expect(Math.abs(after.box.height - baseH * 0.8)).toBeLessThan(0.05);

  // The render is genuinely stretched along each axis: the red glyph ink's
  // extents grow 1.3× horizontally and 0.8× vertically (the after render
  // happens after the edit; the before render was captured above).
  const pngAfter = await render("poster", "text-after.png");
  const inkExtent = (png: ReturnType<typeof decodePng>): { minX: number; maxX: number; minY: number; maxY: number } => {
    let minX = png.width, maxX = -1, minY = png.height, maxY = -1;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const i = (y * png.width + x) * 4;
        if (png.rgba[i]! > 200 && png.rgba[i + 1]! < 80 && png.rgba[i + 2]! < 80) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return { minX, maxX, minY, maxY };
  };
  const eBefore = inkExtent(pngBefore);
  const eAfter = inkExtent(pngAfter);
  expect(eBefore.maxX).toBeGreaterThan(eBefore.minX);
  expect((eAfter.maxX - eAfter.minX) / (eBefore.maxX - eBefore.minX)).toBeCloseTo(1.3, 1);
  expect((eAfter.maxY - eAfter.minY) / (eBefore.maxY - eBefore.minY)).toBeCloseTo(0.8, 1);
}, 30_000);

// ---------------------------------------------------------------------------
// Idempotence and the image/shape path: the value IS the canonical scale.
// ---------------------------------------------------------------------------

test("--scale-to sets absolute per-axis factors on image Layers; repeating it is idempotent", async () => {
  const { layerId } = await addLayer("hero", ["--image", imagePath, "--x", "10", "--y", "10"]);

  const first = await editJson(layerId, ["--scale-to", "1.3x0.8"]);
  expect(first.code).toBe(0);
  const rev = first.parsed.layer.currentRevision;
  expect(rev.scaleX).toBe(1.3);
  expect(rev.scaleY).toBe(0.8);
  expect(first.parsed.resized).toEqual({ scaleX: 1.3, scaleY: 0.8, width: 83.2, height: 38.4 });
  const measuredFirst = await measureUse("hero");
  expect(measuredFirst.scaleX).toBe(1.3);
  expect(measuredFirst.scaleY).toBe(0.8);
  expect(measuredFirst.box.width).toBeCloseTo(83.2, 6);
  expect(measuredFirst.box.height).toBeCloseTo(38.4, 6);

  // The pixel probe: the 64x48 red box paints 83.2x38.4.
  const png = await render("poster", "image-scaled.png");
  expect(pixel(png, 30, 20)).toEqual(RED);
  expect(pixel(png, 90, 45)).toEqual(RED);
  expect(pixel(png, 95, 50)).toEqual([0, 0, 0, 0]);

  // Absolute: a second identical edit keeps the same scale, never compounding.
  const second = await editJson(layerId, ["--scale-to", "1.3x0.8"]);
  expect(second.code).toBe(0);
  const measuredSecond = await measureUse("hero");
  expect(measuredSecond).toEqual(measuredFirst);
});

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

test("shape Layers take --scale-to through the same canonical scale fact", async () => {
  const { layerId } = await addLayer("badge", [
    "--shape", "rectangle", "--size", "40x20", "--fill", "#ff0000", "--x", "10", "--y", "10",
  ]);
  const edit = await editJson(layerId, ["--scale-to", "2x0.5"]);
  expect(edit.code).toBe(0);
  const rev = edit.parsed.layer.currentRevision;
  expect(rev.scaleX).toBe(2);
  expect(rev.scaleY).toBe(0.5);
  // The shape's effective size reports the per-axis result.
  expect(edit.parsed.resized).toEqual({ scaleX: 2, scaleY: 0.5, width: 80, height: 10 });
  const measured = await measureUse("badge");
  expect(measured.scaleX).toBe(2);
  expect(measured.scaleY).toBe(0.5);
});

// ---------------------------------------------------------------------------
// One-axis forms: the omitted axis keeps the Layer's current scale.
// ---------------------------------------------------------------------------

test("one-axis --scale-to preserves the current scale on the omitted axis", async () => {
  const { layerId } = await addLayer("hero", ["--image", imagePath, "--x", "10", "--y", "10"]);

  const widthOnly = await editJson(layerId, ["--scale-to", "2x"]);
  expect(widthOnly.code).toBe(0);
  expect(widthOnly.parsed.layer.currentRevision.scaleX).toBe(2);
  expect(widthOnly.parsed.layer.currentRevision.scaleY).toBe(1);

  const heightOnly = await editJson(layerId, ["--scale-to", "x3"]);
  expect(heightOnly.code).toBe(0);
  expect(heightOnly.parsed.layer.currentRevision.scaleX).toBe(2);
  expect(heightOnly.parsed.layer.currentRevision.scaleY).toBe(3);
});

// ---------------------------------------------------------------------------
// Uniform and per-axis are ONE fact: either setter wholly replaces it.
// ---------------------------------------------------------------------------

test("the uniform --scale keeps its meaning and either setter replaces the whole fact", async () => {
  const { layerId } = await addLayer("hero", ["--image", imagePath, "--x", "10", "--y", "10"]);

  // Uniform first: still a uniform absolute setter.
  const uniform = await editJson(layerId, ["--scale", "2"]);
  expect(uniform.code).toBe(0);
  expect(uniform.parsed.layer.currentRevision.scaleX).toBe(2);
  expect(uniform.parsed.layer.currentRevision.scaleY).toBe(2);

  // Per-axis replaces the whole fact: not multiplied into the uniform 2.
  const perAxis = await editJson(layerId, ["--scale-to", "1.3x0.8"]);
  expect(perAxis.code).toBe(0);
  expect(perAxis.parsed.layer.currentRevision.scaleX).toBe(1.3);
  expect(perAxis.parsed.layer.currentRevision.scaleY).toBe(0.8);

  // And the uniform setter replaces the per-axis scale wholly: back to 2x2.
  const uniformAgain = await editJson(layerId, ["--scale", "2"]);
  expect(uniformAgain.code).toBe(0);
  expect(uniformAgain.parsed.layer.currentRevision.scaleX).toBe(2);
  expect(uniformAgain.parsed.layer.currentRevision.scaleY).toBe(2);
  const measured = await measureUse("hero");
  expect(measured.scaleX).toBe(2);
  expect(measured.scaleY).toBe(2);
});

// ---------------------------------------------------------------------------
// Removal: --scale-to 1x1 normalizes to identity and restores the render.
// ---------------------------------------------------------------------------

test("removing the per-axis scale with --scale-to 1x1 restores the render byte-for-byte", async () => {
  const { layerId } = await addLayer("hero", ["--image", imagePath, "--x", "10", "--y", "10"]);
  const original = await render("poster", "removal-before.png");

  const scaled = await editJson(layerId, ["--scale-to", "1.3x0.8"]);
  expect(scaled.code).toBe(0);
  const stretched = await render("poster", "removal-scaled.png");
  expect(stretched.rgba.equals(original.rgba)).toBe(false);

  const removed = await editJson(layerId, ["--scale-to", "1x1"]);
  expect(removed.code).toBe(0);
  // Identity scale normalizes: the revision carries scale 1 again.
  expect(removed.parsed.layer.currentRevision.scaleX).toBe(1);
  expect(removed.parsed.layer.currentRevision.scaleY).toBe(1);
  const restored = await render("poster", "removal-after.png");
  expect(restored.rgba.equals(original.rgba)).toBe(true);

  // A uniform removal is the same fact's identity form.
  const { layerId: textId } = await addLayer("txt", [
    "--text", "Removal", "--font", "Archivo", "--font-size", "40", "--x", "20", "--y", "20",
  ]);
  await editJson(textId, ["--scale-to", "1.3x0.8"]);
  const textRemoved = await editJson(textId, ["--scale-to", "1x1"]);
  expect(textRemoved.code).toBe(0);
  expect(textRemoved.parsed.layer.currentRevision.scaleX).toBe(1);
  expect(textRemoved.parsed.layer.currentRevision.scaleY).toBe(1);
});

// ---------------------------------------------------------------------------
// Wrap width is layout px BEFORE transforms (#294): scale maps it into
// canvas space, it does not re-wrap.
// ---------------------------------------------------------------------------

test("wrap width is layout px: the per-axis scale maps the wrapped box into canvas space", async () => {
  const { layerId } = await addLayer("wrapped", [
    "--text", "the quick brown fox jumps", "--font", "Archivo", "--font-size", "40",
    "--wrap-width", "220", "--x", "20", "--y", "20",
  ]);
  const base = await measureUse("wrapped");

  const edit = await editJson(layerId, ["--scale-to", "2x1"]);
  expect(edit.code).toBe(0);
  const scaled = await measureUse("wrapped");
  expect(scaled.scaleX).toBe(2);
  expect(scaled.scaleY).toBe(1);
  // The wrap itself is unchanged (the same layout rule at scale 1): the
  // layout content is identical and only the canvas-space box doubles.
  expect(scaled.content).toEqual(base.content);
  expect(scaled.box.width).toBeCloseTo(base.box.width * 2, 6);
  expect(scaled.box.height).toBeCloseTo(base.box.height * 1, 6);
});

// ---------------------------------------------------------------------------
// Mutual exclusion: one resize form per edit, on both surfaces (exit 2).
// ---------------------------------------------------------------------------

test("--scale-to is mutually exclusive with every other resize form, on both surfaces", async () => {
  const { layerId, revisionId } = await addLayer("hero", ["--image", imagePath, "--x", "10", "--y", "10"]);

  const pairs: Array<{ args: string[]; error: string }> = [
    {
      args: ["--scale-to", "2x1", "--resize", "2"],
      error: "--resize and --scale-to are mutually exclusive: use one resize form per edit (--resize is relative, --scale-to sets the absolute per-axis scale).",
    },
    {
      args: ["--scale-to", "2x", "--resize-to", "96x"],
      error: "--resize-to and --scale-to are mutually exclusive: use one resize form per edit (--resize-to sets an absolute size, --scale-to sets the absolute per-axis scale).",
    },
    {
      args: ["--scale-to", "x2", "--cover-to", "96x96"],
      error: "--cover-to and --scale-to are mutually exclusive: use one resize form per edit (--cover-to sets a cover-fit size, --scale-to sets the absolute per-axis scale).",
    },
    {
      args: ["--scale-to", "2x2", "--scale", "3"],
      error: "--scale and --scale-to are mutually exclusive: use one resize form per edit (--scale sets a uniform absolute scale, --scale-to sets the absolute per-axis scale).",
    },
  ];
  for (const pair of pairs) {
    const res = await editJson(layerId, pair.args);
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout).error).toBe(pair.error);
    expect(await revisionIdOf(layerId)).toBe(revisionId);

    const add = await invoke([
      "composition", "add", "poster", "nope", "--image", imagePath, ...pair.args, "--project", projDir, "--json",
    ]);
    expect(add.code).toBe(2);
    expect(JSON.parse(add.stdout).ok).toBe(false);
    expect(JSON.parse(add.stdout).error).toBe(pair.error);
  }
});

// ---------------------------------------------------------------------------
// Bounds: per-axis factors share the uniform --scale bounds wording.
// ---------------------------------------------------------------------------

test("--scale-to bounds refusals use the same wording as uniform --scale, on both surfaces", async () => {
  const { layerId } = await addLayer("hero", ["--image", imagePath, "--x", "10", "--y", "10"]);

  for (const [value, factor] of [["0x2", "0"], ["2x0", "0"], ["8193x2", "8193"], ["2x8193", "8193"]] as const) {
    const edit = await invoke(["layer", "edit", layerId, "--scale-to", value, "--project", projDir, "--json"]);
    expect(edit.code).toBe(1);
    expect(JSON.parse(edit.stdout).error).toBe(
      `Invalid scale ${factor}: must be a finite number between 0 and 8192.`,
    );
    const add = await invoke([
      "composition", "add", "poster", "nope", "--image", imagePath, "--scale-to", value, "--project", projDir, "--json",
    ]);
    expect(add.code).toBe(1);
    expect(JSON.parse(add.stdout).error).toBe(
      `Invalid scale ${factor}: must be a finite number between 0 and 8192.`,
    );
  }

  // Malformed shapes are usage errors with the family's grammar wording.
  for (const value of ["banana", "1.3", "x", "abcx2"]) {
    const edit = await invoke(["layer", "edit", layerId, "--scale-to", value, "--project", projDir, "--json"]);
    expect(edit.code).toBe(2);
    expect(JSON.parse(edit.stdout).error).toContain("--scale-to takes");
  }
});

// ---------------------------------------------------------------------------
// Content replacement stays a separate edit.
// ---------------------------------------------------------------------------

test("--scale-to with content replacement is refused, and nothing publishes", async () => {
  const { layerId, revisionId } = await addLayer("hero", ["--image", imagePath, "--x", "10", "--y", "10"]);
  const other = path.join(tempDir, "other.png");
  await writeFile(other, solidPng(32, 32, [0, 0, 255, 255]));
  const res = await editJson(layerId, ["--image", other, "--scale-to", "2x1"]);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error).toBe(
    `Scale and content replacement are separate edits: Layer "${layerId}" cannot replace its source and set --scale-to in one edit, because the effective-size cap reads the retained content's intrinsic size.`,
  );
  expect(await revisionIdOf(layerId)).toBe(revisionId);
});

// ---------------------------------------------------------------------------
// One-command add accepts --scale-to on every kind.
// ---------------------------------------------------------------------------

test("one-command add accepts --scale-to on image, vector, text, and shape Layers", async () => {
  const img = await invoke([
    "composition", "add", "poster", "p-img", "--image", imagePath, "--scale-to", "2x0.5", "--project", projDir, "--json",
  ]);
  expect(img.code).toBe(0);
  const imgRev = JSON.parse(img.stdout).layer.currentRevision;
  expect(imgRev.scaleX).toBe(2);
  expect(imgRev.scaleY).toBe(0.5);

  const vec = await invoke([
    "composition", "add", "poster", "p-vec", "--image", svgPath, "--scale-to", "1.5x2", "--y", "60", "--project", projDir, "--json",
  ]);
  expect(vec.code).toBe(0);
  const vecRev = JSON.parse(vec.stdout).layer.currentRevision;
  expect(vecRev.scaleX).toBe(1.5);
  expect(vecRev.scaleY).toBe(2);

  const text = await invoke([
    "composition", "add", "poster", "p-txt", "--text", "Added", "--font", "Archivo", "--font-size", "40",
    "--scale-to", "1.3x0.8", "--y", "120", "--project", projDir, "--json",
  ]);
  expect(text.code).toBe(0);
  const textRev = JSON.parse(text.stdout).layer.currentRevision;
  expect(textRev.scaleX).toBe(1.3);
  expect(textRev.scaleY).toBe(0.8);

  const shape = await invoke([
    "composition", "add", "poster", "p-shp", "--shape", "rectangle", "--size", "40x20", "--fill", "#ff0000",
    "--scale-to", "2x0.5", "--y", "180", "--project", projDir, "--json",
  ]);
  expect(shape.code).toBe(0);
  const shapeRev = JSON.parse(shape.stdout).layer.currentRevision;
  expect(shapeRev.scaleX).toBe(2);
  expect(shapeRev.scaleY).toBe(0.5);

  const measured = await measureUse("p-txt");
  expect(measured.scaleX).toBe(1.3);
  expect(measured.scaleY).toBe(0.8);
});

// ---------------------------------------------------------------------------
// A Render retained before the edit replays byte-identically (pinned).
// ---------------------------------------------------------------------------

test("a Render retained before the --scale-to edit replays byte-identically", async () => {
  const { layerId } = await addLayer("hero", ["--image", imagePath, "--x", "10", "--y", "10"]);
  const renderRes = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(renderRes.code).toBe(0);
  const renderJson = JSON.parse(renderRes.stdout).render;
  const originalPng = await readFile(renderJson.output);
  const manifestPath = renderJson.manifest;

  const edit = await editJson(layerId, ["--scale-to", "1.3x0.8"]);
  expect(edit.code).toBe(0);

  const replay = await invoke(["composition", "replay", manifestPath, "--project", projDir, "--json"]);
  expect(replay.code).toBe(0);
  const replayOutput = JSON.parse(replay.stdout).replay.output as string;
  expect(readFile(replayOutput)).resolves.toEqual(originalPng);
});