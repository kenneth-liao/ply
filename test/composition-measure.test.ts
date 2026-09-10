/**
 * Read-only Layer layout measurement (#136, spec #132 US-002 / US-006,
 * DEC-001, DEC-003–004, DEC-009).
 *
 * Verifies through the public CLI seam:
 * - `ply composition measure <comp> [use-name]` reports content/layout bounds
 *   for image and text Layers in Composition coordinates, including the
 *   current canonical scale/rotation/reflection.
 * - Measurement shares the paint path's one authority (DEC-004): the same
 *   markup, the same retained font bytes, the same transform emission, and
 *   browser-measured geometry — text dimensions agree with painting.
 * - The reported boxes are LAYOUT boxes, not painted extents: image boxes
 *   include transparent padding, text boxes include line-box leading; glyph/
 *   alpha trimming (#137), effects, and canvas clipping are out of scope.
 * - The query writes no Project state, works locally, has compact text by
 *   default, valid JSON under --json, and scoped help.
 * - Missing/corrupt content and unresolved fonts fail loudly and never fall
 *   back.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { encodePngRgba, decodePng } from "../src/png.js";
import { computeRevisionHash, LAYER_SCHEMA_VERSION } from "../src/layer.js";
import type { LayerTextRevision } from "../src/layer.js";
import { measureCompositionLayers } from "../src/composition-measure.js";
import { getBrowser, closeBrowser } from "../src/browser.js";

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

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

const close = (a: number, b: number, tol = 0.51) => Math.abs(a - b) <= tol;

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-comp-measure-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "measure-proj"]);
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

async function addImageLayer(comp: string, localName: string, imgFile: string, opts: { x?: number; y?: number } = {}) {
  const args = ["composition", "add", comp, localName, "--image", imgFile, "--project", projDir, "--json"];
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
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

async function measure(comp: string, useName?: string, extra: string[] = []) {
  const args = ["composition", "measure", comp, "--project", projDir, "--json", ...extra];
  if (useName !== undefined) args.splice(3, 0, useName);
  const res = await invoke(args);
  return { res, json: res.code === 0 ? JSON.parse(res.stdout) : undefined };
}

test("measure reports an identity image Layer's layout box at its intrinsic size and placement", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(120, 80, RED));
  await makeComp("m");
  await addImageLayer("m", "bg", img, { x: 30, y: 20 });

  const { res, json } = await measure("m");
  expect(res.code).toBe(0);
  expect(json.ok).toBe(true);
  expect(json.composition).toBe("m");
  expect(json.canvas).toEqual({ width: 400, height: 300 });
  expect(json.layers).toHaveLength(1);

  const layer = json.layers[0];
  expect(layer.name).toBe("bg");
  expect(layer.kind).toBe("image");
  expect(layer.content).toEqual({ width: 120, height: 80 });
  expect(layer.placement).toEqual({ x: 30, y: 20, opacity: 1 });
  expect(layer.transform).toEqual({ scaleX: 1, scaleY: 1, rotationDeg: 0, flipX: false, flipY: false });
  // Identity transform: the layout box is exactly the placement point plus
  // the intrinsic size — in Composition coordinates, unclipped.
  expect(layer.box).toEqual({ x: 30, y: 20, width: 120, height: 80 });
  // The transformed content rectangle's corners, clockwise from top-left.
  expect(layer.corners).toEqual([
    { x: 30, y: 20 },
    { x: 150, y: 20 },
    { x: 150, y: 100 },
    { x: 30, y: 100 },
  ]);
});

test("measure applies scale, rotation, and reflection to image Layer geometry", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(120, 80, RED));
  await makeComp("geo");
  await addImageLayer("geo", "img", img, { x: 30, y: 20 });
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "geo", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0].layerId as string;

  // Scale 2×: the Layer grows right and down from (x, y).
  expect((await invoke(["layer", "edit", layerId, "--resize-to", "240x160", "--in-place", "--project", projDir, "--json"])).code).toBe(0);
  let { json } = await measure("geo");
  expect(json.layers[0].box).toEqual({ x: 30, y: 20, width: 240, height: 160 });
  expect(json.layers[0].content).toEqual({ width: 120, height: 80 });
  expect(json.layers[0].transform).toMatchObject({ scaleX: 2, scaleY: 2 });

  // Rotation 90° clockwise about (x, y): a 240×160 footprint becomes an
  // 160×240 one extending left and down; content box stays untransformed.
  expect((await invoke(["layer", "edit", layerId, "--rotate", "90", "--in-place", "--project", projDir, "--json"])).code).toBe(0);
  ({ json } = await measure("geo"));
  expect(json.layers[0].box).toEqual({ x: 30 - 160, y: 20, width: 160, height: 240 });
  expect(json.layers[0].corners).toEqual([
    { x: 30, y: 20 },
    { x: 30, y: 20 + 240 },
    { x: 30 - 160, y: 20 + 240 },
    { x: 30 - 160, y: 20 },
  ]);
  expect(json.layers[0].content).toEqual({ width: 120, height: 80 });

  // Back to identity scale, then horizontal flip at x=100: the footprint
  // mirrors to the other side of the placement axis (ADR-0016).
  expect((await invoke(["layer", "edit", layerId, "--rotate", "0", "--resize-to", "100x", "--in-place", "--project", projDir, "--json"])).code).toBe(0);
  expect((await invoke(["layer", "edit", layerId, "--x", "100", "--in-place", "--project", projDir, "--json"])).code).toBe(0);
  expect((await invoke(["layer", "edit", layerId, "--flip", "horizontal", "--in-place", "--project", projDir, "--json"])).code).toBe(0);
  ({ json } = await measure("geo"));
  expect(json.layers[0].transform).toMatchObject({ flipX: true, rotationDeg: 0 });
  expect(json.layers[0].box).toEqual({ x: 0, y: 20, width: 100, height: 66.67 });
  expect(json.layers[0].corners[0]).toEqual({ x: 100, y: 20 });
  expect(json.layers[0].corners[1]).toEqual({ x: 0, y: 20 });

  // Measuring a single use reports exactly that use, unchanged.
  const single = await measure("geo", "img");
  expect(single.json.layers).toHaveLength(1);
  expect(single.json.layers[0].name).toBe("img");
});
test("text measurement uses the retained face and agrees with painted pixels", async () => {
  await makeComp("text", 400, 300);
  await addTextLayer("text", "title", "Ply", { fontSize: 96, color: "#ff0000", x: 40, y: 30 });

  const { json } = await measure("text");
  const layer = json.layers[0];
  expect(layer.kind).toBe("text");
  // The measured content box is a real line-box extent of the retained face.
  expect(layer.content.width).toBeGreaterThan(50);
  expect(layer.content.height).toBeGreaterThan(50);
  expect(layer.box).toEqual({ x: 40, y: 30, width: layer.content.width, height: layer.content.height });

  // Font size doubles the measured line-box extent (same retained bytes).
  await addTextLayer("text", "big", "Ply", { fontSize: 192, color: "#00ff00", x: 0, y: 0 });
  const { json: json2 } = await measure("text");
  const big = json2.layers.find((l: { name: string }) => l.name === "big");
  expect(big.content.width).toBeGreaterThan(layer.content.width * 1.8);
  expect(big.content.height).toBeGreaterThan(layer.content.height * 1.8);

  // The reported text box contains the actually painted glyph ink: render
  // the Composition and compare red-pixel extent to the title's box.
  const rendered = await invoke(["composition", "render", "text", "--project", projDir, "--json"]);
  expect(rendered.code).toBe(0);
  const pngPath = JSON.parse(rendered.stdout).render.output as string;
  const png = decodePng(await readFile(pngPath));
  // Green big Layer paints too; collect red glyph pixels only.
  const reds: { x: number; y: number }[] = [];
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const [r, g, b, a] = pixel(png, x, y);
      if (a > 0 && r > 200 && g < 100 && b < 100) reds.push({ x, y });
    }
  }
  expect(reds.length).toBeGreaterThan(100);
  const inkMinX = Math.min(...reds.map((p) => p.x));
  const inkMinY = Math.min(...reds.map((p) => p.y));
  const inkMaxX = Math.max(...reds.map((p) => p.x));
  const inkMaxY = Math.max(...reds.map((p) => p.y));
  // The layout box is a superset of glyph ink (line-box leading included),
  // tight enough to prove it measured this text, not a default.
  expect(inkMinX).toBeGreaterThanOrEqual(layer.box.x);
  expect(inkMinY).toBeGreaterThanOrEqual(layer.box.y);
  expect(inkMaxX).toBeLessThanOrEqual(layer.box.x + layer.box.width);
  expect(inkMaxY).toBeLessThanOrEqual(layer.box.y + layer.box.height);
  expect(layer.box.x + layer.box.width - inkMaxX).toBeLessThan(20);
  expect(layer.box.y + layer.box.height - inkMaxY).toBeLessThan(40);
  expect(inkMinX - layer.box.x).toBeLessThan(20);

  // Rotation transforms the text box about (x, y) exactly like an image's.
  const titleId = JSON.parse(
    (await invoke(["composition", "inspect", "text", "--project", projDir, "--json"])).stdout,
  ).composition.layers.find((l: { name: string }) => l.name === "title").layerId as string;
  expect((await invoke(["layer", "edit", titleId, "--rotate", "90", "--in-place", "--project", projDir, "--json"])).code).toBe(0);
  const { json: json3 } = await measure("text", "title");
  expect(json3.layers[0].content).toEqual(layer.content);
  expect(json3.layers[0].box).toEqual({
    x: 40 - layer.content.height,
    y: 30,
    width: layer.content.height,
    height: layer.content.width,
  });
});

test("measuring writes no Project state", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(64, 48, RED));
  await makeComp("ro", 200, 200);
  await addImageLayer("ro", "bg", img, { x: 10, y: 10 });
  await addTextLayer("ro", "t", "hello", { fontSize: 32, x: 5, y: 5 });

  // Snapshot every Project file's path + bytes before measuring.
  const walk = async (dir: string, into: Map<string, string>) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p, into);
      else into.set(p, (await readFile(p)).toString("base64"));
    }
  };
  const snapshotBefore = new Map<string, string>();
  await walk(projDir, snapshotBefore);

  expect((await measure("ro")).res.code).toBe(0);
  expect((await measure("ro", "t")).res.code).toBe(0);
  // Also with compact text output.
  const text = await invoke(["composition", "measure", "ro", "--project", projDir]);
  expect(text.code).toBe(0);

  const snapshotAfter = new Map<string, string>();
  await walk(projDir, snapshotAfter);
  expect(snapshotAfter.size).toBe(snapshotBefore.size);
  for (const [p, bytes] of snapshotBefore) {
    expect(snapshotAfter.get(p)).toBe(bytes);
  }
});

async function readStoredTextRevision(layerId: string): Promise<LayerTextRevision> {
  const identity = JSON.parse(await readFile(path.join(projDir, "layers", `${layerId}.json`), "utf8"));
  const revHash = identity.currentRevision as string;
  return JSON.parse(await readFile(path.join(projDir, "layers", `${layerId}.revisions`, `${revHash}.json`), "utf8"));
}

test("measurement fails loudly on missing compositions, unknown uses, and unresolved inputs", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(32, 32, RED));
  await makeComp("fail", 200, 200);
  await addImageLayer("fail", "bg", img);
  await addTextLayer("fail", "t", "hi", { fontSize: 32 });

  // Missing composition: actionable failure, nonzero status.
  const missing = await measure("nope");
  expect(missing.res.code).toBe(1);
  expect(JSON.parse(missing.res.stdout).ok).toBe(false);
  expect(JSON.parse(missing.res.stdout).error).toContain("nope");

  // Unknown use name: names the available uses.
  const unknownUse = await measure("fail", "ghost");
  expect(unknownUse.res.code).toBe(1);
  expect(JSON.parse(unknownUse.res.stdout).error).toContain("ghost");
  expect(JSON.parse(unknownUse.res.stdout).error).toContain("bg");

  // Corrupt retained image bytes: the canonical resolver refuses loudly.
  const comp = JSON.parse((await invoke(["composition", "inspect", "fail", "--project", projDir, "--json"])).stdout).composition;
  const imageLayerId = comp.layers.find((l: { name: string }) => l.name === "bg").layerId as string;
  const identity = JSON.parse(await readFile(path.join(projDir, "layers", `${imageLayerId}.json`), "utf8"));
  const rev = JSON.parse(await readFile(path.join(projDir, "layers", `${imageLayerId}.revisions`, `${identity.currentRevision}.json`), "utf8"));
  const blobPath = path.join(projDir, "content", rev.contentHash);
  const original = await readFile(blobPath);
  const bytes = Buffer.from(original);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
  await writeFile(blobPath, bytes);
  const corrupt = await measure("fail", "bg");
  expect(corrupt.res.code).toBe(1);
  expect(JSON.parse(corrupt.res.stdout).ok).toBe(false);
  expect(JSON.parse(corrupt.res.stdout).error).toContain("Corrupted content blob");
  expect(JSON.parse(corrupt.res.stdout).error).toContain(imageLayerId);
  // Restore: the font-failure step below resolves the whole Composition.
  await writeFile(blobPath, original);

  // Crafted self-consistent revision whose retained bytes are not a font:
  // only the real font-load boundary can reject it, and measurement fails
  // instead of measuring a fallback face.
  const textLayerId = comp.layers.find((l: { name: string }) => l.name === "t").layerId as string;
  const textRev = await readStoredTextRevision(textLayerId);
  const garbage = Buffer.from("this is not font data, but it is retained content");
  const garbageHash = createHash("sha256").update(garbage).digest("hex");
  await writeFile(path.join(projDir, "content", garbageHash), garbage);
  const crafted: LayerTextRevision = {
    schemaVersion: LAYER_SCHEMA_VERSION,
    layerId: textLayerId,
    createdAt: textRev.createdAt,
    kind: "text",
    contentHash: garbageHash,
    text: textRev.text,
    fontSize: textRev.fontSize,
    color: textRev.color,
    x: textRev.x,
    y: textRev.y,
    opacity: textRev.opacity,
  };
  const craftedHash = computeRevisionHash(crafted);
  await writeFile(
    path.join(projDir, "layers", `${textLayerId}.revisions`, `${craftedHash}.json`),
    JSON.stringify(crafted, null, 2) + "\n",
  );
  const textIdentityFile = path.join(projDir, "layers", `${textLayerId}.json`);
  const textIdentity = JSON.parse(await readFile(textIdentityFile, "utf8"));
  await writeFile(textIdentityFile, JSON.stringify({ ...textIdentity, currentRevision: craftedHash }, null, 2) + "\n");

  const unresolved = await measure("fail", "t");
  expect(unresolved.res.code).toBe(1);
  const unresolvedJson = JSON.parse(unresolved.res.stdout);
  expect(unresolvedJson.ok).toBe(false);
  expect(unresolvedJson.error).toMatch(/font/i);
  expect(unresolvedJson.error).toContain("t");
});

test("measure exposes scoped help, compact text output, and usage errors", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(64, 48, RED));
  await makeComp("out", 300, 200);
  await addImageLayer("out", "bg", img, { x: 10, y: 10 });
  await addTextLayer("out", "t", "hi", { fontSize: 32, x: 5, y: 5 });

  // Scoped help documents the command and the layout-vs-painted distinction.
  const help = await invoke(["composition", "measure", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("measure <comp>");
  expect(help.stdout).toContain("LAYOUT boxes");
  expect(help.stdout).toContain("not painted extents");
  expect(help.stdout).toContain("retained font bytes");

  // Compact text: one line per Layer, no raw JSON dump on stdout.
  const text = await invoke(["composition", "measure", "out", "--project", projDir]);
  expect(text.code).toBe(0);
  const lines = text.stdout.trim().split("\n");
  expect(lines[0]).toContain(`Measured Composition "out" (300×200), 2 Layers`);
  expect(lines[1]).toContain(`"bg" (image content 64×48) box (10, 10) 64×48`);
  expect(lines[2]).toMatch(/"t" \(text \d+(\.\d+)?×\d+(\.\d+)?\) box \(5, 5\) \d+(\.\d+)?×\d+(\.\d+)?/);
  expect(text.stdout).not.toContain('"ok"');

  // Usage errors: missing composition argument exits 2 with guidance.
  const usage = await measure("");
  expect(usage.res.code).toBe(2);
  expect(JSON.parse(usage.res.stdout).error).toContain("Usage: ply composition measure");

  // Unknown subcommand lists measure among the available commands.
  const unknown = await invoke(["composition", "frobnicate", "--project", projDir]);
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toContain("measure");
});

test("text measurement follows scale and flip through the canonical transform", async () => {
  await makeComp("textx", 500, 400);
  await addTextLayer("textx", "t", "Ply", { fontSize: 48, x: 100, y: 50 });
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "textx", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0].layerId as string;

  // Identity: the box is the content box at the placement point.
  let { json } = await measure("textx");
  const content = { width: json.layers[0].content.width, height: json.layers[0].content.height };
  expect(json.layers[0].box).toEqual({ x: 100, y: 50, width: content.width, height: content.height });

  // Scale 2×: the text content box is untransformed; the footprint doubles
  // right and down from (x, y). (--resize-to is image-only: text has no
  // intrinsic pixel size, so scaling is relative --resize, per ADR-0016.)
  expect((await invoke(["layer", "edit", layerId, "--resize", "2", "--in-place", "--project", projDir, "--json"])).code).toBe(0);
  ({ json } = await measure("textx"));
  expect(json.layers[0].content).toEqual(content);
  expect(json.layers[0].box.x).toBe(100);
  expect(json.layers[0].box.y).toBe(50);
  expect(json.layers[0].box.width).toBeCloseTo(content.width * 2, 1);
  expect(json.layers[0].box.height).toBeCloseTo(content.height * 2, 1);

  // Halve, then horizontal flip: the footprint mirrors across the placement
  // axis — [100, 100+w/2] becomes [100−w/2, 100].
  expect((await invoke(["layer", "edit", layerId, "--resize", "0.25", "--in-place", "--project", projDir, "--json"])).code).toBe(0);
  expect((await invoke(["layer", "edit", layerId, "--flip", "horizontal", "--in-place", "--project", projDir, "--json"])).code).toBe(0);
  ({ json } = await measure("textx"));
  expect(json.layers[0].transform).toMatchObject({ flipX: true, scaleX: 0.5 });
  expect(json.layers[0].content).toEqual(content);
  expect(json.layers[0].box.x).toBeCloseTo(100 - content.width / 2, 1);
  expect(json.layers[0].box.y).toBe(50);
  expect(json.layers[0].box.width).toBeCloseTo(content.width / 2, 1);
  expect(json.layers[0].box.height).toBeCloseTo(content.height / 2, 1);
});

test("measuring completes with every browser network route aborted (offline evidence)", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(32, 32, RED));
  await makeComp("off", 200, 200);
  await addImageLayer("off", "bg", img, { x: 10, y: 10 });
  await addTextLayer("off", "t", "hi", { fontSize: 32, x: 5, y: 5 });

  const browser = await getBrowser();
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  await ctx.route("**/*", (route) => route.abort());
  const page = await ctx.newPage();
  try {
    const result = await measureCompositionLayers(projDir, "off", undefined, { page });
    expect(result.layers).toHaveLength(2);
    expect(result.layers[0]!.box).toEqual({ x: 10, y: 10, width: 32, height: 32 });
  } finally {
    await ctx.close();
    await closeBrowser();
  }
});
