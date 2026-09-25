/**
 * Shape Layers with a solid fill (#208, spec #207 US-001 solid part,
 * DEC-001/002/003/009/010/011): a third Layer revision kind beside image and
 * text — a filled geometric region (rectangle with optional corner radius, or
 * ellipse) created from parameters alone. Its content IS its parameters; no
 * image bytes are read or stored (DEC-001). The fill is one discriminated
 * value normalized at one ingestion boundary (DEC-003).
 *
 * TEST-001/002/006/007: external behaviour at the CLI and rendered-pixel
 * seams the layer-edit / layer-shadow / composition-measure /
 * composition-render / render-history tests already use — run the command,
 * assert the JSON result and refusal text, render, and assert pixels and
 * measured extents. Every test file stays runnable under the per-file
 * `bun test --isolate` topology and offline (no weights, no network).
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { decodePng, encodePngRgba } from "../src/png.js";

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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-shape-layer-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "shape-proj"]);
  await invoke([
    "composition", "create", "poster", "--width", "200", "--height", "120", "--project", projDir,
  ]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

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
// Creation and rendered pixels (US-001 bullets 1–3; TEST-002)
// ---------------------------------------------------------------------------

test("a rectangle shape Layer is created from parameters alone, renders its solid fill, and stores no image bytes", async () => {
  // No image file exists to read: the Layer is made of parameters only.
  const add = await invoke([
    "composition", "add", "poster", "bar",
    "--shape", "rectangle", "--size", "120x40",
    "--fill", "#1d4ed8", "--x", "30", "--y", "20",
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const addJson = JSON.parse(add.stdout);
  expect(addJson.ok).toBe(true);
  const layerId = addJson.use.layerId as string;

  const rev = addJson.layer.currentRevision;
  expect(rev.kind).toBe("shape");
  expect(rev.shape).toBe("rectangle");
  expect(rev.width).toBe(120);
  expect(rev.height).toBe(40);
  expect(rev.fill).toEqual({ type: "solid", color: "#1d4ed8" });
  expect(rev.x).toBe(30);
  expect(rev.y).toBe(20);
  // No image bytes are stored for a shape (DEC-001): the revision's content
  // identity is derived from the canonical parameter form, and the Project's
  // content store gains no blob for this Layer.
  const contentDir = path.join(projDir, "content");
  const blobs = await readdir(contentDir);
  expect(blobs).toEqual([]);

  // The shape renders as a full Layer kind: solid fill at the interior, the
  // placement margins stay transparent.
  const render = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(render.code).toBe(0);
  const renderJson = JSON.parse(render.stdout);
  const pngBytes = await readFile(renderJson.render.output);
  const png = decodePng(pngBytes);
  expect(png.width).toBe(200);
  expect(png.height).toBe(120);
  // Interior of the rectangle: the fill, fully opaque.
  expectPixel(png, 90, 40, [0x1d, 0x4e, 0xd8, 255]);
  expectPixel(png, 40, 25, [0x1d, 0x4e, 0xd8, 255]);
  // Outside the rectangle (the placement margins): transparent.
  expectPixel(png, 10, 10, [0, 0, 0, 0]);
  expectPixel(png, 190, 110, [0, 0, 0, 0]);
  // Just past the rectangle's right/bottom edges: transparent.
  expectPixel(png, 151, 40, [0, 0, 0, 0]);
  expectPixel(png, 90, 61, [0, 0, 0, 0]);
  expect(layerId).toMatch(/^layer_/);
});

test("solid fill with alpha renders the exact requested colour blended over transparency", async () => {
  const add = await invoke([
    "composition", "add", "poster", "veil",
    "--shape", "rectangle", "--size", "100x60",
    "--fill", "#ff000080", "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const rev = JSON.parse(add.stdout).layer.currentRevision;
  // The fill is normalized at the one ingestion boundary (DEC-003): the
  // stored colour is the canonical lowercase full form.
  expect(rev.fill).toEqual({ type: "solid", color: "#ff000080" });

  const render = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(render.code).toBe(0);
  const png = decodePng(await readFile(JSON.parse(render.stdout).render.output));
  // 50% red over the transparent canvas: the screenshot stores the colour at
  // half alpha (unpremultiplied RGBA).
  expectPixel(png, 50, 30, [255, 0, 0, 128], 3);
  expectPixel(png, 150, 100, [0, 0, 0, 0]);
});

test("a rounded rectangle keeps its corners transparent and its edges filled", async () => {
  const add = await invoke([
    "composition", "add", "poster", "pill",
    "--shape", "rectangle", "--size", "100x50", "--corner-radius", "25",
    "--fill", "#00ff00", "--x", "50", "--y", "35",
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const rev = JSON.parse(add.stdout).layer.currentRevision;
  expect(rev.kind).toBe("shape");
  expect(rev.cornerRadius).toBe(25);

  const render = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(render.code).toBe(0);
  const png = decodePng(await readFile(JSON.parse(render.stdout).render.output));
  // Interior and edge midpoints: filled.
  expectPixel(png, 100, 60, [0, 255, 0, 255]);
  expectPixel(png, 100, 36, [0, 255, 0, 255]);
  expectPixel(png, 51, 60, [0, 255, 0, 255]);
  // The top-left corner of the rectangle's box (50,35): outside the rounded
  // corner arc — transparent.
  expectPixel(png, 50, 35, [0, 0, 0, 0]);
  expectPixel(png, 52, 37, [0, 0, 0, 0]);
  // The opposite corner, likewise.
  expectPixel(png, 150, 85, [0, 0, 0, 0]);
});

test("an ellipse fills its inscribed area and keeps its box corners transparent", async () => {
  const add = await invoke([
    "composition", "add", "poster", "dot",
    "--shape", "ellipse", "--size", "80x60",
    "--fill", "#0000ff", "--x", "60", "--y", "30",
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const rev = JSON.parse(add.stdout).layer.currentRevision;
  expect(rev.kind).toBe("shape");
  expect(rev.shape).toBe("ellipse");
  expect(rev.width).toBe(80);
  expect(rev.height).toBe(60);

  const render = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(render.code).toBe(0);
  const png = decodePng(await readFile(JSON.parse(render.stdout).render.output));
  // Center and the axis extremes: filled.
  expectPixel(png, 100, 60, [0, 0, 255, 255]);
  expectPixel(png, 100, 31, [0, 0, 255, 255]);
  expectPixel(png, 61, 60, [0, 0, 255, 255]);
  // The bounding box corners: outside the ellipse — transparent.
  expectPixel(png, 60, 30, [0, 0, 0, 0]);
  expectPixel(png, 140, 90, [0, 0, 0, 0]);
  // Just outside the horizontal axis extreme: transparent.
  expectPixel(png, 141, 60, [0, 0, 0, 0]);
});

// ---------------------------------------------------------------------------
// Refusal before publication (US-001 bullet 4; TEST-002)
// ---------------------------------------------------------------------------

/** The composition's inspect JSON — the live state a refusal must not touch. */
async function inspectPosterJson(): Promise<Record<string, unknown>> {
  const res = await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

// Semantic range errors refuse with exit 1 from the ingestion validator,
// naming the parameter and its allowed range (US-001); grammar errors are
// usage errors with exit 2 (the established convention, DEC-009). Every
// refusal leaves live state unchanged.
const BAD_SHAPE_ARGS: [string, number, string[], string][] = [
  ["zero width", 1, ["--shape", "rectangle", "--size", "0x40", "--fill", "#123456"], "width"],
  ["negative height", 1, ["--shape", "rectangle", "--size", "120x-40", "--fill", "#123456"], "height"],
  ["non-positive size", 1, ["--shape", "ellipse", "--size", "-5x-5", "--fill", "#123456"], "width"],
  ["negative radius", 1, ["--shape", "rectangle", "--size", "120x40", "--corner-radius", "-5", "--fill", "#123456"], "corner radius"],
  ["oversized radius", 1, ["--shape", "rectangle", "--size", "120x40", "--corner-radius", "21", "--fill", "#123456"], "corner radius"],
  ["radius on an ellipse", 1, ["--shape", "ellipse", "--size", "80x60", "--corner-radius", "10", "--fill", "#123456"], "corner radius"],
  ["malformed color", 2, ["--shape", "rectangle", "--size", "120x40", "--fill", "blue"], "fill"],
  ["missing fill", 2, ["--shape", "rectangle", "--size", "120x40"], "--fill"],
  ["missing size", 2, ["--shape", "rectangle", "--fill", "#123456"], "--size"],
];

for (const [label, expectedCode, extra, errorMustName] of BAD_SHAPE_ARGS) {
  test(`a malformed shape parameter is refused before publication, naming the parameter and its range: ${label}`, async () => {
    const before = await inspectPosterJson();
    const add = await invoke([
      "composition", "add", "poster", "bad", ...extra, "--project", projDir, "--json",
    ]);
    expect(add.code).toBe(expectedCode);
    const json = JSON.parse(add.stdout);
    expect(json.ok).toBe(false);
    expect(json.error).toContain(errorMustName);
    // Live state is unchanged: the same uses, the same revisions, and no
    // staged Layer identity left behind.
    expect(JSON.parse(JSON.stringify(await inspectPosterJson()))).toEqual(before);
  });
}

test("the boundary shape errors are usage errors (exit 2) naming the fix", async () => {
  const badGeometry = await invoke([
    "composition", "add", "poster", "bad", "--shape", "triangle", "--size", "10x10", "--fill", "#123456", "--project", projDir, "--json",
  ]);
  expect(badGeometry.code).toBe(2);
  expect(JSON.parse(badGeometry.stdout).error).toContain("rectangle or ellipse");

  const badSize = await invoke([
    "composition", "add", "poster", "bad", "--shape", "rectangle", "--size", "10", "--fill", "#123456", "--project", projDir, "--json",
  ]);
  expect(badSize.code).toBe(2);
  expect(JSON.parse(badSize.stdout).error).toContain('--size takes');

  const orphanSize = await invoke([
    "composition", "add", "poster", "bad", "--size", "10x10", "--project", projDir, "--json",
  ]);
  expect(orphanSize.code).toBe(2);
  expect(JSON.parse(orphanSize.stdout).error).toContain("require --shape");

  const shapeWithImage = await invoke([
    "composition", "add", "poster", "bad", "--shape", "rectangle", "--size", "10x10", "--fill", "#123456", "--image", "x.png", "--project", projDir, "--json",
  ]);
  expect(shapeWithImage.code).toBe(2);
  expect(JSON.parse(shapeWithImage.stdout).error).toContain("mutually exclusive");

  const shapeWithText = await invoke([
    "composition", "add", "poster", "bad", "--shape", "rectangle", "--size", "10x10", "--fill", "#123456", "--text", "hi", "--font", "Anton", "--project", projDir, "--json",
  ]);
  expect(shapeWithText.code).toBe(2);
  expect(JSON.parse(shapeWithText.stdout).error).toContain("mutually exclusive");
});

test("a corner radius of 0 is the same look as absent — accepted and never stored", async () => {
  const add = await invoke([
    "composition", "add", "poster", "square",
    "--shape", "rectangle", "--size", "40x40", "--corner-radius", "0", "--fill", "#123456",
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const rev = JSON.parse(add.stdout).layer.currentRevision;
  expect(rev.kind).toBe("shape");
  expect("cornerRadius" in rev).toBe(false);
});

// ---------------------------------------------------------------------------
// inspect / measure / layer review report the shape's parameters (US-001
// bullet 5; TEST-001)
// ---------------------------------------------------------------------------

test("layer inspect reports the shape's parameters in JSON and compact text", async () => {
  const add = await invoke([
    "composition", "add", "poster", "bar",
    "--shape", "rectangle", "--size", "120x40", "--corner-radius", "8", "--fill", "#1d4ed8",
    "--project", projDir, "--json",
  ]);
  const layerId = JSON.parse(add.stdout).use.layerId as string;
  const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(inspect.code).toBe(0);
  const json = JSON.parse(inspect.stdout);
  const rev = json.layer.currentRevision;
  expect(rev.kind).toBe("shape");
  expect(rev.shape).toBe("rectangle");
  expect(rev.width).toBe(120);
  expect(rev.height).toBe(40);
  expect(rev.cornerRadius).toBe(8);
  expect(rev.fill).toEqual({ type: "solid", color: "#1d4ed8" });
  // Compact text names the same parameters (text mode without --json).
  const textInspect = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(textInspect.code).toBe(0);
  expect(textInspect.stdout).toContain("Kind: shape");
  expect(textInspect.stdout).toContain("Geometry: rectangle (120×40)");
  expect(textInspect.stdout).toContain("Corner radius: 8px");
  expect(textInspect.stdout).toContain("Fill: solid #1d4ed8");
});

test("composition measure reports the shape's content box, transformed box, and painted extents", async () => {
  await invoke([
    "composition", "add", "poster", "bar",
    "--shape", "rectangle", "--size", "120x40", "--fill", "#1d4ed8", "--x", "30", "--y", "20",
    "--rotate", "90", "--scale", "0.5",
    "--project", projDir, "--json",
  ]);
  const measure = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  expect(measure.code).toBe(0);
  const json = JSON.parse(measure.stdout);
  const bar = json.layers[0];
  expect(bar.kind).toBe("shape");
  // Content box: the geometry's canonical parameter facts.
  expect(bar.content).toEqual({ width: 120, height: 40 });
  // Transformed box: rotated 90° and scaled 0.5 about (30, 20) — CSS
  // rotate(90deg) maps the local 60×20 rect to (x,y)→(30−y, 20+x) around
  // that origin, so the corners span x 10..30, y 20..80.
  expect(bar.box.x).toBeCloseTo(10, 0);
  expect(bar.box.y).toBeCloseTo(20, 0);
  expect(bar.box.width).toBeCloseTo(20, 0);
  expect(bar.box.height).toBeCloseTo(60, 0);
  expect(bar.corners).toHaveLength(4);
  // Painted extents: the shape's ink is its whole geometry — the painted
  // box matches the transformed box.
  expect(bar.painted).not.toBeNull();
  expect(bar.paintedOnCanvas).not.toBeNull();
  expect(bar.clipped).toBe(false);
  // The transform facts ride along like any other kind.
  expect(bar.transform).toEqual({ scaleX: 0.5, scaleY: 0.5, rotationDeg: 90, flipX: false, flipY: false, skewXDeg: 0, skewYDeg: 0, perspectiveTiltXDeg: 0, perspectiveTiltYDeg: 0 });
});

test("layer review reports the shape's parameters as a parameter sheet", async () => {
  const add = await invoke([
    "composition", "add", "poster", "bar",
    "--shape", "ellipse", "--size", "80x60", "--fill", "#ff000080",
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const layerId = JSON.parse(add.stdout).use.layerId as string;
  const out = path.join(tempDir, "shape-review.html");
  const review = await invoke(["layer", "review", layerId, "--out", out, "--project", projDir, "--json"]);
  expect(review.code).toBe(0);
  const json = JSON.parse(review.stdout);
  expect(json.ok).toBe(true);
  expect(json.generation).toBeNull();
  expect(json.matting).toBeNull();
  // The sheet exists and reports the shape's parameters — geometry, size,
  // and fill — with no candidate image (a shape has no retained bytes).
  const sheet = await readFile(json.review, "utf8");
  expect(sheet).toContain("ellipse");
  expect(sheet).toContain("80×60");
  expect(sheet).toContain("solid");
  expect(sheet).toContain("#ff000080");
});

// ---------------------------------------------------------------------------
// Cross-Project import and fork give the shape an independent identity with
// equal parameters (US-007 via #86/#85; TEST-001)
// ---------------------------------------------------------------------------

const shapeAddArgs = (name: string): string[] => [
  "composition", "add", "poster", name,
  "--shape", "rectangle", "--size", "100x40", "--corner-radius", "6", "--fill", "#1d4ed8",
  "--x", "20", "--y", "30",
];

function expectEqualShapeParams(a: Record<string, unknown>, b: Record<string, unknown>): void {
  for (const key of ["kind", "shape", "width", "height", "cornerRadius", "fill", "x", "y", "opacity", "contentHash"]) {
    expect(b[key]).toEqual(a[key]);
  }
  // Independent identity: a new Layer id, a new revision hash (fresh
  // createdAt), but the same content identity.
  expect(b.layerId).not.toBe(a.layerId);
}

test("cross-Project import gives the shape an independent identity with equal parameters", async () => {
  const add = await invoke([...shapeAddArgs("bar"), "--project", projDir, "--json"]);
  const sourceRev = JSON.parse(add.stdout).layer.currentRevision;
  const sourceLayerId = JSON.parse(add.stdout).use.layerId as string;

  const otherProj = path.join(tempDir, "other");
  await invoke(["project", "init", otherProj, "--name", "other-proj"]);
  await invoke(["composition", "create", "flyer", "--width", "200", "--height", "120", "--project", otherProj]);
  const imp = await invoke([
    "composition", "import", "flyer", "poster", "--from-project", projDir, "--project", otherProj, "--json",
  ]);
  expect(imp.code).toBe(0);
  expect(JSON.parse(imp.stdout).importedUses).toHaveLength(1);

  const inspect = await invoke(["composition", "inspect", "flyer", "--project", otherProj, "--json"]);
  const importedRev = JSON.parse(inspect.stdout).composition.layers[0].revision;
  expectEqualShapeParams({ ...sourceRev, layerId: sourceLayerId }, { ...importedRev, layerId: JSON.parse(inspect.stdout).composition.layers[0].layerId });
  // The destination Project stores no bytes for the shape either.
  expect(await readdir(path.join(otherProj, "content"))).toEqual([]);
  // The imported shape renders identically (same parameters, same paint).
  const renderSrc = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  const renderDst = await invoke(["composition", "render", "flyer", "--project", otherProj, "--json"]);
  expect(renderDst.code).toBe(0);
  const srcPng = await readFile(JSON.parse(renderSrc.stdout).render.output);
  const dstPng = await readFile(JSON.parse(renderDst.stdout).render.output);
  expect(dstPng.equals(srcPng)).toBe(true);
});

test("fork gives the shape a new identity with equal parameters and retargets the use", async () => {
  const add = await invoke([...shapeAddArgs("bar"), "--project", projDir, "--json"]);
  const sourceRev = JSON.parse(add.stdout).layer.currentRevision;
  const sourceLayerId = JSON.parse(add.stdout).use.layerId as string;
  await invoke(["composition", "create", "flyer", "--width", "200", "--height", "120", "--project", projDir]);
  await invoke(["composition", "import", "flyer", "poster", "--project", projDir, "--json"]);

  const fork = await invoke([
    "layer", "edit", sourceLayerId, "--fork", "--composition", "flyer", "--use", "bar",
    "--project", projDir, "--json",
  ]);
  expect(fork.code).toBe(0);
  const forkJson = JSON.parse(fork.stdout);
  expect(forkJson.ok).toBe(true);
  const forkedLayerId = forkJson.layer.id as string;
  expect(forkedLayerId).not.toBe(sourceLayerId);
  expect(forkJson.fork.composition).toBe("flyer");
  expect(forkJson.fork.use).toBe("bar");

  const inspect = await invoke(["composition", "inspect", "flyer", "--project", projDir, "--json"]);
  const forkedRev = JSON.parse(inspect.stdout).composition.layers[0].revision;
  expectEqualShapeParams({ ...sourceRev, layerId: sourceLayerId }, { ...forkedRev, layerId: forkedLayerId });
});

// ---------------------------------------------------------------------------
// Render replay: a Render containing a shape replays byte-identically after
// a later edit and Project relocation; manifests captured before this change
// (image/text revisions — no shape kind, no fill fields) keep their meaning
// and replay byte-identically (US-007; TEST-006, prior art render-history).
// ---------------------------------------------------------------------------

interface RenderResultJson {
  render: { output: string; manifest: string };
}

async function renderJson(comp: string, project: string): Promise<RenderResultJson> {
  const res = await invoke(["composition", "render", comp, "--project", project, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

async function replay(manifestPath: string, project: string): Promise<{ code: number; output?: string; error?: string }> {
  const res = await invoke(["composition", "replay", manifestPath, "--project", project, "--json"]);
  const json = JSON.parse(res.stdout);
  return { code: res.code, output: json.replay?.output, error: json.error };
}

test("a Render containing a shape replays byte-identically after a later edit and relocation", async () => {
  await invoke([
    "composition", "add", "poster", "bg",
    "--shape", "rectangle", "--size", "200x120", "--fill", "#101828",
    "--project", projDir, "--json",
  ]);
  const add = await invoke([
    "composition", "add", "poster", "bar",
    "--shape", "rectangle", "--size", "120x40", "--corner-radius", "10", "--fill", "#1d4ed8", "--x", "40", "--y", "40",
    "--project", projDir, "--json",
  ]);
  const barLayerId = JSON.parse(add.stdout).use.layerId as string;

  const first = await renderJson("poster", projDir);
  const originalPng = await readFile(first.render.output);

  // A later current-state edit (move the bar) does not change the retained
  // Render: the manifest pins the pre-edit revision.
  const edit = await invoke([
    "layer", "edit", barLayerId, "--x", "10", "--y", "60", "--project", projDir, "--json",
  ]);
  expect(edit.code).toBe(0);

  let replayRes = await replay(first.render.manifest, projDir);
  expect(replayRes.code).toBe(0);
  expect((await readFile(replayRes.output!)).equals(originalPng)).toBe(true);

  // Project relocation moves manifest and Project together; replay is
  // relocation-proof by construction (the manifest is addressed at its new
  // home — its recorded paths are project-relative, never absolute).
  const relocated = path.join(tempDir, "moved");
  await Bun.$`mv ${projDir} ${relocated}`.quiet();
  const relocatedManifest = path.join(relocated, path.relative(projDir, first.render.manifest));
  replayRes = await replay(relocatedManifest, relocated);
  expect(replayRes.code).toBe(0);
  expect((await readFile(replayRes.output!)).equals(originalPng)).toBe(true);
});

test("a manifest captured before this change — image and text revisions, no shape kind — replays byte-identically", async () => {
  // The image/text revision documents this test builds are exactly the form
  // revisions had before #208: no shape kind, no fill fields (DEC-010's
  // additive rule — nothing about the existing kinds changed).
  const img = path.join(tempDir, "red.png");
  const buf = Buffer.alloc(64 * 64 * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255;
  }
  await Bun.write(img, encodePngRgba(64, 64, buf));
  await invoke([
    "composition", "add", "poster", "bg", "--image", img, "--project", projDir, "--json",
  ]);
  await invoke([
    "composition", "add", "poster", "word", "--text", "Hello", "--font", "Anton", "--font-size", "32",
    "--x", "10", "--y", "10", "--project", projDir, "--json",
  ]);
  const inspect = await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"]);
  const layers = JSON.parse(inspect.stdout).composition.layers;
  for (const layer of layers) {
    // The stored revision documents carry no shape-specific field.
    expect(layer.revision.kind === "shape").toBe(false);
    expect(layer.revision.fill).toBeUndefined();
    expect(layer.revision.shape).toBeUndefined();
  }

  const first = await renderJson("poster", projDir);
  const originalPng = await readFile(first.render.output);
  const replayRes = await replay(first.render.manifest, projDir);
  expect(replayRes.code).toBe(0);
  expect((await readFile(replayRes.output!)).equals(originalPng)).toBe(true);
});

test("a shape Render replays byte-identically after a sibling text edit (mixed-kind manifest)", async () => {
  await invoke([
    "composition", "add", "poster", "bar",
    "--shape", "rectangle", "--size", "120x40", "--fill", "#1d4ed8", "--x", "40", "--y", "40",
    "--project", projDir, "--json",
  ]);
  const add = await invoke([
    "composition", "add", "poster", "word", "--text", "Hello", "--font", "Anton", "--font-size", "32",
    "--project", projDir, "--json",
  ]);
  const wordLayerId = JSON.parse(add.stdout).use.layerId as string;
  const first = await renderJson("poster", projDir);
  const originalPng = await readFile(first.render.output);
  const edit = await invoke(["layer", "edit", wordLayerId, "--text", "Changed", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);
  const replayRes = await replay(first.render.manifest, projDir);
  expect(replayRes.code).toBe(0);
  expect((await readFile(replayRes.output!)).equals(originalPng)).toBe(true);
});
// ---------------------------------------------------------------------------
// Layer-edit kind stability and shared options (US-001/US-007 boundaries;
// shape parameters themselves are NOT editable — sibling ticket #209)
// ---------------------------------------------------------------------------

async function addBar(): Promise<string> {
  const add = await invoke([
    "composition", "add", "poster", "bar",
    "--shape", "rectangle", "--size", "120x40", "--fill", "#1d4ed8", "--x", "40", "--y", "40",
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  return JSON.parse(add.stdout).use.layerId as string;
}

test("a shape Layer cannot become an image or text Layer by edit", async () => {
  const layerId = await addBar();
  const before = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  const beforeRev = JSON.stringify(JSON.parse(before.stdout).layer.currentRevision);

  const cases: [string[], string][] = [
    [["--image", "nope.png"], "is a shape Layer"],
    [["--text", "hi", "--font", "Anton"], "is a shape Layer"],
  ];
  for (const [flags, expected] of cases) {
    const res = await invoke(["layer", "edit", layerId, ...flags, "--project", projDir, "--json"]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).error).toContain(expected);
  }
  // Every refusal left live state unchanged. The shape parameters themselves
  // became absolute setters in #209 (test/layer-shape-edit.test.ts).
  const after = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(JSON.stringify(JSON.parse(after.stdout).layer.currentRevision)).toBe(beforeRev);
});

test("the kind-shared edit options work on a shape Layer as absolute setters", async () => {
  const layerId = await addBar();
  const edit = await invoke([
    "layer", "edit", layerId,
    "--x", "10", "--y", "20", "--opacity", "0.5", "--rotate", "45", "--scale", "2",
    "--shadow", "2,3,4,#000000", "--outline", "2,#00ff00",
    "--project", projDir, "--json",
  ]);
  expect(edit.code).toBe(0);
  const rev = JSON.parse(edit.stdout).layer.currentRevision;
  expect(rev.kind).toBe("shape");
  expect(rev.x).toBe(10);
  expect(rev.y).toBe(20);
  expect(rev.opacity).toBe(0.5);
  expect(rev.rotationDeg).toBe(45);
  expect(rev.scaleX).toBe(2);
  expect(rev.scaleY).toBe(2);
  expect(rev.shadow).toEqual({ dx: 2, dy: 3, blur: 4, color: "#000000" });
  expect(rev.outline).toEqual({ width: 2, color: "#00ff00" });
  // The shape's parameters carried verbatim.
  expect(rev.shape).toBe("rectangle");
  expect(rev.width).toBe(120);
  expect(rev.height).toBe(40);
  expect(rev.fill).toEqual({ type: "solid", color: "#1d4ed8" });

  // --resize-to resolves against the shape's intrinsic size, like an image.
  const resize = await invoke(["layer", "edit", layerId, "--resize-to", "60x", "--project", projDir, "--json"]);
  expect(resize.code).toBe(0);
  const resized = JSON.parse(resize.stdout);
  expect(resized.resized.width).toBe(60);
  expect(resized.resized.height).toBe(20);
});

test("one-command add applies transforms, anchored placement, and effects to a shape in ONE revision", async () => {
  const add = await invoke([
    "composition", "add", "poster", "hero",
    "--shape", "rectangle", "--size", "100x50", "--fill", "#1d4ed8",
    "--x", "80", "--y", "40", "--anchor", "center,center",
    "--rotate", "12", "--shadow", "2,3,4,#000000",
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const rev = JSON.parse(add.stdout).layer.currentRevision;
  expect(rev.kind).toBe("shape");
  expect(rev.rotationDeg).toBe(12);
  expect(rev.shadow).toEqual({ dx: 2, dy: 3, blur: 4, color: "#000000" });
  // The anchored placement resolved against the transformed ink and
  // published as plain placement in the SAME single revision (the plain
  // target was x=80; a dropped --anchor would leave x at exactly 80).
  expect(rev.x).not.toBe(80);
  // Exactly one revision exists for the new Layer.
  const layerId = JSON.parse(add.stdout).use.layerId as string;
  const revs = await readdir(path.join(projDir, "layers", `${layerId}.revisions`));
  expect(revs).toHaveLength(1);
});

test("the explicit solid: prefix and the #RGB shorthand are the SAME fill as the bare canonical spelling", async () => {
  // The `solid:` discriminator is the grammar gradient fills join later
  // (DEC-003); a bare color is its shorthand, and #RGB expands — every
  // spelling of one paint publishes the SAME content identity and revision.
  const spellings = ["#22cc55", "#2c5", "solid:#22cc55", "SOLID:#2C5"];
  const hashes: string[] = [];
  for (const [i, spec] of spellings.entries()) {
    const add = await invoke([
      "composition", "add", "poster", `fill-${i}`,
      "--shape", "rectangle", "--size", "20x20", "--fill", spec,
      "--project", projDir, "--json",
    ]);
    expect(add.code).toBe(0);
    const rev = JSON.parse(add.stdout).layer.currentRevision;
    expect(rev.fill).toEqual({ type: "solid", color: "#22cc55" });
    hashes.push(rev.contentHash as string);
  }
  expect(new Set(hashes).size).toBe(1);
});

test("the from-generation and from-matte content-kind conflicts name --shape", async () => {
  // Add surface (exit 2, usage error): the conflict fires on arg presence
  // alone, before any job or matte lookup.
  const withGeneration = await invoke([
    "composition", "add", "poster", "bad", "--from-generation", "j1",
    "--shape", "rectangle", "--size", "10x10", "--fill", "#123456",
    "--project", projDir, "--json",
  ]);
  expect(withGeneration.code).toBe(2);
  const generationError = JSON.parse(withGeneration.stdout).error as string;
  expect(generationError).toContain("--from-generation");
  expect(generationError).toContain("--shape");

  const withMatte = await invoke([
    "composition", "add", "poster", "bad", "--from-matte", "m1",
    "--shape", "rectangle", "--size", "10x10", "--fill", "#123456",
    "--project", projDir, "--json",
  ]);
  expect(withMatte.code).toBe(2);
  const matteError = JSON.parse(withMatte.stdout).error as string;
  expect(matteError).toContain("--from-matte");
  expect(matteError).toContain("--shape");

  // Edit surface: the same one rule, the edit wording — needs a real Layer
  // (target resolution precedes the conflict checks there).
  const img = path.join(tempDir, "src.png");
  const buf = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255;
  }
  await Bun.write(img, encodePngRgba(4, 4, buf));
  const add = await invoke([
    "composition", "add", "poster", "img", "--image", img, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const layerId = JSON.parse(add.stdout).use.layerId as string;
  const editConflict = await invoke([
    "layer", "edit", layerId, "--from-generation", "j1", "--shape", "rectangle",
    "--size", "10x10", "--fill", "#123456", "--project", projDir, "--json",
  ]);
  expect(editConflict.code).toBe(2);
  const editError = JSON.parse(editConflict.stdout).error as string;
  expect(editError).toContain("--from-generation");
  expect(editError).toContain("--shape");
});
