/**
 * The vector colour parameter (#215, spec #207 US-005, DEC-008/009/010):
 * `--vector-color` paints a vector image Layer's shape in one colour at
 * paint time, over the vector's alpha — a Layer revision fact whose
 * retained SVG bytes never change. This file pins the CLI seam: the
 * absolute setter on add and edit (through the shared option definition),
 * the documented `none` removal, the refusals on raster image, text, and
 * shape Layers (naming each kind's own colour control) before anything is
 * published, the canonical colour grammar (the ONE fill colour ingestion
 * point), and the inspect/measure reporting.
 *
 * The rendered-pixel seam (interior colour, alpha edges, silhouette,
 * byte-identical removal and replay, inertness) lives in
 * test/vector-color-render.test.ts. TEST-004/007: per-file `bun test
 * --isolate`, offline.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePng } from "./png.js";

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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-vector-color-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "colour-proj"]);
  await invoke([
    "composition", "create", "poster", "--width", "200", "--height", "120", "--project", projDir,
  ]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

/** A two-rect SVG (multi-colour — the silhouette case is proven at the
 *  pixel seam) with a declared intrinsic size. */
function markSvg(width = 80, height = 40): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ff0000"/>` +
    `<rect x="${Math.round(width / 4)}" y="${Math.round(height / 4)}" width="${Math.round(width / 2)}" height="${Math.round(height / 2)}" fill="#0000ff"/>` +
    `</svg>`
  );
}

async function writeSvg(name = "mark.svg"): Promise<string> {
  const p = path.join(tempDir, name);
  await writeFile(p, markSvg());
  return p;
}

async function writePng(name = "photo.png"): Promise<string> {
  const p = path.join(tempDir, name);
  await writeFile(p, encodePng(32, 24, () => [10, 200, 30, 255]));
  return p;
}

/** Add a Layer to the poster Composition, returning its Layer id. */
async function addLayer(args: string[]): Promise<string> {
  const res = await invoke(["composition", "add", "poster", `use-${Math.random().toString(36).slice(2, 8)}`, ...args, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).use.layerId as string;
}

async function inspectRevision(layerId: string): Promise<Record<string, unknown>> {
  const res = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).layer.currentRevision as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The absolute setter on add and edit
// ---------------------------------------------------------------------------

test("one-command add sets the vector colour on an SVG image Layer, canonicalized, with the retained bytes unchanged", async () => {
  const svgPath = await writeSvg();
  const source = await readFile(svgPath);
  const add = await invoke([
    "composition", "add", "poster", "logo",
    "--image", svgPath, "--vector-color", "#22C55E", "--x", "50", "--y", "30",
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const rev = JSON.parse(add.stdout).layer.currentRevision as Record<string, unknown>;
  expect(rev.kind).toBe("image");
  expect(rev.format).toBe("svg");
  // The canonical colour form (the ONE fill colour ingestion point): #RGB
  // expanded, lowercase.
  expect(rev.vectorColor).toBe("#22c55e");

  // The retained bytes equal the source bytes, never rewritten (DEC-008).
  const contentBytes = await readFile(path.join(projDir, "content", rev.contentHash as string));
  expect(contentBytes.equals(source)).toBe(true);
});

test("layer edit sets the vector colour absolutely; an omitted option preserves it", async () => {
  const svgPath = await writeSvg();
  const layerId = await addLayer(["--image", svgPath, "--project", projDir]);
  expect((await inspectRevision(layerId)).vectorColor).toBeUndefined();

  const set = await invoke(["layer", "edit", layerId, "--vector-color", "#2c5", "--project", projDir, "--json"]);
  expect(set.code).toBe(0);
  expect((await inspectRevision(layerId)).vectorColor).toBe("#22cc55");

  // An omitted option preserves the current value — a plain placement edit
  // carries the colour fact verbatim.
  const move = await invoke(["layer", "edit", layerId, "--x", "10", "--project", projDir, "--json"]);
  expect(move.code).toBe(0);
  expect((await inspectRevision(layerId)).vectorColor).toBe("#22cc55");

  // Re-setting replaces absolutely: the same command twice keeps the same
  // colour (no compounding, no second representation).
  const reset = await invoke(["layer", "edit", layerId, "--vector-color", "#ff000080", "--project", projDir, "--json"]);
  expect(reset.code).toBe(0);
  expect((await inspectRevision(layerId)).vectorColor).toBe("#ff000080");

  // A no-op colour edit publishes no new revision (the established
  // unchanged-edit rule).
  const again = await invoke(["layer", "edit", layerId, "--vector-color", "#ff000080", "--project", projDir, "--json"]);
  expect(again.code).toBe(0);
  expect(JSON.parse(again.stdout).layer.currentRevisionId).toBe(JSON.parse(reset.stdout).layer.currentRevisionId);
});

test("the documented removal value 'none' drops the fact, restoring the authored colours", async () => {
  const svgPath = await writeSvg();
  const layerId = await addLayer(["--image", svgPath, "--vector-color", "#22c55e", "--project", projDir]);
  const coloured = await inspectRevision(layerId);

  const remove = await invoke(["layer", "edit", layerId, "--vector-color", "none", "--project", projDir, "--json"]);
  expect(remove.code).toBe(0);
  const removed = await inspectRevision(layerId);
  expect(removed.vectorColor).toBeUndefined();
  // Removal drops the field — absence IS the no-colour form (no second
  // representation); everything else about the revision is untouched.
  expect(removed.contentHash).toBe(coloured.contentHash);

  // Removal is idempotent, and 'none' on a Layer without a colour removes
  // nothing.
  const again = await invoke(["layer", "edit", layerId, "--vector-color", "none", "--project", projDir, "--json"]);
  expect(again.code).toBe(0);
  expect(JSON.parse(again.stdout).layer.currentRevisionId).toBe(JSON.parse(remove.stdout).layer.currentRevisionId);
});

// ---------------------------------------------------------------------------
// Refusals before publication, naming each kind's own colour control
// ---------------------------------------------------------------------------

test("the setter is refused on a raster image Layer, before publication", async () => {
  const pngPath = await writePng();
  const layerId = await addLayer(["--image", pngPath, "--project", projDir]);
  const before = await inspectRevision(layerId);

  const edit = await invoke(["layer", "edit", layerId, "--vector-color", "#22c55e", "--project", projDir, "--json"]);
  expect(edit.code).toBe(1);
  const err = JSON.parse(edit.stdout).error as string;
  expect(err).toContain("raster image Layer");
  expect(err).toContain(layerId);
  expect(err).toContain("format png");

  expect(await inspectRevision(layerId)).toEqual(before);
});

test("the setter is refused on a text Layer, naming --color", async () => {
  const layerId = await addLayer(["--text", "Groundline", "--font", "Anton", "--project", projDir]);
  const before = await inspectRevision(layerId);

  const edit = await invoke(["layer", "edit", layerId, "--vector-color", "#22c55e", "--project", projDir, "--json"]);
  expect(edit.code).toBe(1);
  const err = JSON.parse(edit.stdout).error as string;
  expect(err).toContain("text Layer");
  expect(err).toContain("--color");

  expect(await inspectRevision(layerId)).toEqual(before);
});

test("the setter is refused on a shape Layer, naming --fill", async () => {
  const layerId = await addLayer([
    "--shape", "rectangle", "--size", "60x30", "--fill", "#1d4ed8", "--project", projDir,
  ]);
  const before = await inspectRevision(layerId);

  const edit = await invoke(["layer", "edit", layerId, "--vector-color", "#22c55e", "--project", projDir, "--json"]);
  expect(edit.code).toBe(1);
  const err = JSON.parse(edit.stdout).error as string;
  expect(err).toContain("shape Layer");
  expect(err).toContain("--fill");

  expect(await inspectRevision(layerId)).toEqual(before);
});

test("the add surface refuses the colour on raster, text, and shape content, publishing nothing", async () => {
  const pngPath = await writePng();
  const raster = await invoke([
    "composition", "add", "poster", "photo", "--image", pngPath, "--vector-color", "#22c55e",
    "--project", projDir, "--json",
  ]);
  expect(raster.code).toBe(1);
  expect(JSON.parse(raster.stdout).error).toContain("raster image Layer");

  const text = await invoke([
    "composition", "add", "poster", "headline", "--text", "Groundline", "--font", "Anton",
    "--vector-color", "#22c55e", "--project", projDir, "--json",
  ]);
  expect(text.code).toBe(1);
  expect(JSON.parse(text.stdout).error).toContain("--color");

  const shape = await invoke([
    "composition", "add", "poster", "bar", "--shape", "rectangle", "--size", "60x30",
    "--fill", "#1d4ed8", "--vector-color", "#22c55e", "--project", projDir, "--json",
  ]);
  expect(shape.code).toBe(1);
  expect(JSON.parse(shape.stdout).error).toContain("--fill");

  // Nothing was published: the Composition has no uses.
  const inspect = await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"]);
  expect(JSON.parse(inspect.stdout).composition.layers).toEqual([]);
});

// ---------------------------------------------------------------------------
// The one colour grammar: refusals, no second parser
// ---------------------------------------------------------------------------

test("a malformed colour is a usage error naming the grammar; a gradient is refused — a vector colour takes one hex colour", async () => {
  const svgPath = await writeSvg();
  const layerId = await addLayer(["--image", svgPath, "--project", projDir]);

  const bad = await invoke(["layer", "edit", layerId, "--vector-color", "red", "--project", projDir, "--json"]);
  expect(bad.code).toBe(2);
  expect(JSON.parse(bad.stdout).error).toContain("hex color");

  const gradient = await invoke([
    "layer", "edit", layerId, "--vector-color", "linear:45deg,#ff0000,#00ff00", "--project", projDir, "--json",
  ]);
  expect(gradient.code).toBe(2);
  const err = JSON.parse(gradient.stdout).error as string;
  expect(err).toContain("one hex color");
  expect(err).toContain("--fill");
});

// ---------------------------------------------------------------------------
// Colour combines with content replacement: the gate reads the NEW content
// ---------------------------------------------------------------------------

test("a colour edit may replace content in the same edit: SVG onto a raster Layer takes the colour, raster onto an SVG Layer refuses", async () => {
  const svgPath = await writeSvg();
  const pngPath = await writePng();

  // Raster Layer, replaced with the SVG in the same edit that sets the colour.
  const rasterLayer = await addLayer(["--image", pngPath, "--project", projDir]);
  const replace = await invoke([
    "layer", "edit", rasterLayer, "--image", svgPath, "--vector-color", "#22c55e", "--project", projDir, "--json",
  ]);
  expect(replace.code).toBe(0);
  const replaced = await inspectRevision(rasterLayer);
  expect(replaced.format).toBe("svg");
  expect(replaced.vectorColor).toBe("#22c55e");

  // SVG Layer, replaced with the raster in the same edit that sets a colour:
  // refused — the resulting content is a raster image Layer.
  const svgLayer = await addLayer(["--image", svgPath, "--vector-color", "#22c55e", "--project", projDir]);
  const before = await inspectRevision(svgLayer);
  const refuse = await invoke([
    "layer", "edit", svgLayer, "--image", pngPath, "--vector-color", "#ffcc00", "--project", projDir, "--json",
  ]);
  expect(refuse.code).toBe(1);
  expect(JSON.parse(refuse.stdout).error).toContain("raster image Layer");
  expect(await inspectRevision(svgLayer)).toEqual(before);
});

// ---------------------------------------------------------------------------
// Reporting: inspect and measure
// ---------------------------------------------------------------------------

test("inspect and measure report the vector colour", async () => {
  const svgPath = await writeSvg();
  const layerId = await addLayer(["--image", svgPath, "--vector-color", "#22c55e", "--project", projDir]);

  const inspectText = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(inspectText.code).toBe(0);
  expect(inspectText.stdout).toContain("Vector colour: #22c55e");

  const measure = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  expect(measure.code).toBe(0);
  const layer = (JSON.parse(measure.stdout).layers as Record<string, unknown>[])[0]!;
  expect(layer.vectorColor).toBe("#22c55e");

  // A Layer without the colour reports null (and the text reports nothing).
  const svg2 = await writeSvg("plain.svg");
  const plainId = await addLayer(["--image", svg2, "--project", projDir]);
  const measure2 = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  const layers = JSON.parse(measure2.stdout).layers as Record<string, unknown>[];
  expect(layers.find((l) => l.layerId === plainId)!.vectorColor).toBeNull();
});

test("the edit report names the set and removed colour", async () => {
  const svgPath = await writeSvg();
  const layerId = await addLayer(["--image", svgPath, "--project", projDir]);

  const set = await invoke(["layer", "edit", layerId, "--vector-color", "#22c55e", "--project", projDir]);
  expect(set.code).toBe(0);
  expect(set.stdout).toContain("vector colour #22c55e");

  const remove = await invoke(["layer", "edit", layerId, "--vector-color", "none", "--project", projDir]);
  expect(remove.code).toBe(0);
  expect(remove.stdout).toContain("vector colour removed");
});
// ---------------------------------------------------------------------------
// Revision-fact mechanics: append-only hash (DEC-010), stored-form gate,
// idempotent removal on every kind, carried-colour refusal, cross-Project
// import
// ---------------------------------------------------------------------------

test("the revision hash appends the colour only when present (DEC-010: existing ids unmoved)", async () => {
  const { computeRevisionHash, normalizeStoredVectorColor } = await import("../src/layer.js");
  const svgPath = await writeSvg();
  const layerId = await addLayer(["--image", svgPath, "--project", projDir]);
  const before = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout).layer;

  // A revision document without the field hashes exactly as its pre-#215
  // form: deleting the field from the live revision and recomputing yields
  // the pinned id, and only a PRESENT colour moves it.
  const colourless = { ...before.currentRevision } as Record<string, unknown>;
  delete colourless.vectorColor;
  delete colourless.revisionId;
  const baseHash = computeRevisionHash(colourless as never);
  const withColour = { ...colourless, vectorColor: "#22c55e" };
  expect(computeRevisionHash(withColour as never)).not.toBe(baseHash);
  delete (withColour as Record<string, unknown>).vectorColor;
  expect(computeRevisionHash(withColour as never)).toBe(baseHash);
});

test("a malformed stored vector colour is a malformed document, refused loudly", async () => {
  const { normalizeStoredVectorColor } = await import("../src/layer.js");
  expect(normalizeStoredVectorColor({})).toBeUndefined();
  expect(normalizeStoredVectorColor({ vectorColor: "#22c55e" })).toBe("#22c55e");
  expect(() => normalizeStoredVectorColor({ vectorColor: "red" })).toThrow(/Malformed revision document: vectorColor/);
  expect(() => normalizeStoredVectorColor({ vectorColor: 7 })).toThrow(/Malformed revision document: vectorColor/);
});

test("the removal form is an idempotent no-op on every kind, on both surfaces", async () => {
  const svgPath = await writeSvg();
  const svgLayer = await addLayer(["--image", svgPath, "--vector-color", "#22c55e", "--project", projDir]);
  const pngPath = await writePng();
  const rasterLayer = await addLayer(["--image", pngPath, "--project", projDir]);
  const textLayer = await addLayer(["--text", "Groundline", "--font", "Anton", "--project", projDir]);
  const shapeLayer = await addLayer(["--shape", "rectangle", "--size", "60x30", "--fill", "#1d4ed8", "--project", projDir]);

  for (const id of [svgLayer, rasterLayer, textLayer, shapeLayer]) {
    const before = await inspectRevision(id);
    const none = await invoke(["layer", "edit", id, "--vector-color", "none", "--project", projDir, "--json"]);
    expect(none.code).toBe(0);
    expect((await inspectRevision(id)).vectorColor).toBeUndefined();
    // Idempotent: repeating it publishes no new revision.
    const again = await invoke(["layer", "edit", id, "--vector-color", "none", "--project", projDir, "--json"]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout).layer.currentRevisionId).toBe(JSON.parse(none.stdout).layer.currentRevisionId);
  }
  // A removal on the coloured Layer removed the fact; the others had none
  // to remove.
  expect((await inspectRevision(svgLayer)).vectorColor).toBeUndefined();

  // The add surface behaves identically: "none" on any content is a no-op,
  // never a refusal.
  const addNone = await invoke([
    "composition", "add", "poster", "none-raster", "--image", pngPath, "--vector-color", "none",
    "--project", projDir, "--json",
  ]);
  expect(addNone.code).toBe(0);
  expect(JSON.parse(addNone.stdout).layer.currentRevision.vectorColor).toBeUndefined();
  const addNoneShape = await invoke([
    "composition", "add", "poster", "none-shape", "--shape", "rectangle", "--size", "60x30",
    "--fill", "#1d4ed8", "--vector-color", "none", "--project", projDir, "--json",
  ]);
  expect(addNoneShape.code).toBe(0);
});

test("a colour carried across a content replacement to raster content is refused naming the fix", async () => {
  const svgPath = await writeSvg();
  const pngPath = await writePng();
  const layerId = await addLayer(["--image", svgPath, "--vector-color", "#22c55e", "--project", projDir]);
  const before = await inspectRevision(layerId);

  // The colour is NOT supplied: the carried fact must not silently paint
  // the raster replacement solid.
  const replace = await invoke(["layer", "edit", layerId, "--image", pngPath, "--project", projDir, "--json"]);
  expect(replace.code).toBe(1);
  const err = JSON.parse(replace.stdout).error as string;
  expect(err).toContain("raster pixels");
  expect(err).toContain("--vector-color none");
  expect(await inspectRevision(layerId)).toEqual(before);

  // The removal form rides the same edit: removing the colour while
  // replacing the content publishes the raster replacement colour-free.
  const remove = await invoke([
    "layer", "edit", layerId, "--image", pngPath, "--vector-color", "none", "--project", projDir, "--json",
  ]);
  expect(remove.code).toBe(0);
  const replaced = await inspectRevision(layerId);
  expect(replaced.format).toBe("png");
  expect(replaced.vectorColor).toBeUndefined();
});

test("cross-Project import copies the colour with the Layer", async () => {
  const svgPath = await writeSvg();
  const layerId = await addLayer(["--image", svgPath, "--vector-color", "#22c55e", "--project", projDir]);

  const otherDir = path.join(tempDir, "other");
  expect((await invoke(["project", "init", otherDir, "--name", "other-proj"])).code).toBe(0);
  expect((await invoke(["composition", "create", "copy", "--width", "200", "--height", "120", "--project", otherDir])).code).toBe(0);
  const importRes = await invoke([
    "composition", "import", "copy", "poster", "--from-project", projDir, "--project", otherDir, "--json",
  ]);
  expect(importRes.code).toBe(0);
  const copy = JSON.parse(
    (await invoke(["composition", "inspect", "copy", "--project", otherDir, "--json"])).stdout,
  ).composition;
  const copyLayerId = copy.layers[0].layerId as string;
  expect(copyLayerId).not.toBe(layerId); // an independent identity, not a live link
  const inspect = JSON.parse((await invoke(["layer", "inspect", copyLayerId, "--project", otherDir, "--json"])).stdout);
  expect(inspect.layer.currentRevision.vectorColor).toBe("#22c55e");
  expect(inspect.layer.currentRevision.format).toBe("svg");
});
