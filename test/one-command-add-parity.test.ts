/**
 * One-command parity (spec #226 US-001, TEST-002): for each Layer kind, a
 * Layer created with a full option set by ONE `composition add` —
 * content, transforms, anchored placement, effects in the documented order
 * (DEC-002) — renders and measures IDENTICALLY to the same Layer built by
 * the multi-command sequence (content, then transforms, then anchored
 * placement, then effects), and publishes exactly ONE Layer revision. The
 * one-command Layer's Render replays byte-identically, and a pre-existing
 * manifest replays byte-identically after later edits.
 *
 * All pixel work is local (no network, no weights), offline, per the
 * repo's per-file `--isolate` test topology.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePngRgba } from "../src/png.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

interface Result {
  stdout: string;
  stderr: string;
  code: number;
}

async function spawn(args: string[]): Promise<Result> {
  const proc = Bun.spawn([process.execPath, cli, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, code };
}

/** A solid image whose visible (alpha > 0) pixels occupy only `region` — transparent padding elsewhere, so --anchor exercises the ink box, not the layout box. */
function regionPng(width: number, height: number, rgba: [number, number, number, number], region: { x: number; y: number; width: number; height: number }): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;
      const i = (y * width + x) * 4;
      buf[i] = rgba[0]!; buf[i + 1] = rgba[1]!; buf[i + 2] = rgba[2]!; buf[i + 3] = inside ? rgba[3]! : 0;
    }
  }
  return encodePngRgba(width, height, buf);
}

const RED: [number, number, number, number] = [255, 0, 0, 255];

let tempDir: string;
let projDir: string;
let padImagePath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-one-command-parity-"));
  projDir = path.join(tempDir, "proj");
  await spawn(["project", "init", projDir]);
  padImagePath = path.join(tempDir, "padded.png");
  await writeFile(padImagePath, regionPng(64, 48, RED, { x: 20, y: 10, width: 24, height: 28 }));
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function json(args: string[]): Promise<Record<string, unknown>> {
  const res = await spawn([...args, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout) as Record<string, unknown>;
}

async function createComposition(name: string): Promise<void> {
  const res = await spawn([
    "composition", "create", name, "--width", "400", "--height", "300", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
}

/** Render a Composition; returns the PNG bytes of the default output. */
async function renderBytes(name: string): Promise<Buffer> {
  const rendered = await json(["composition", "render", name]);
  const output = (rendered.render as { output: string }).output;
  return readFile(output);
}

interface MeasuredEntry {
  layerId: string;
  kind: string;
  content: { width: number; height: number };
  box: { x: number; y: number; width: number; height: number };
  painted: { x: number; y: number; width: number; height: number } | null;
  placement: { x: number; y: number; opacity: number };
  transform: { scaleX: number; scaleY: number; rotationDeg: number; flipX: boolean; flipY: boolean; skewXDeg: number; skewYDeg: number; perspectiveTiltXDeg: number; perspectiveTiltYDeg: number };
  effects: { shadow: unknown; outline: unknown; innerShadow: unknown };
  typography: Record<string, unknown>;
  axes: { weight: number; width: number } | null;
}

async function measure(name: string, useName: string): Promise<MeasuredEntry> {
  const measured = await json(["composition", "measure", name, useName]);
  const layers = (measured.layers as MeasuredEntry[]);
  expect(layers).toHaveLength(1);
  return layers[0]!;
}

/** The Layer's revision count: one-command creation publishes exactly one. */
async function revisionCount(layerId: string): Promise<number> {
  const files = await readdir(path.join(projDir, "layers", `${layerId}.revisions`));
  return files.length;
}

/** Geometry-and-facts projection of a measured entry: everything the two
 *  routes must agree on, minus identity fields (layer ids and revision ids
 *  differ by construction). */
function geometry(entry: MeasuredEntry): unknown {
  return {
    kind: entry.kind,
    content: entry.content,
    box: entry.box,
    painted: entry.painted,
    placement: entry.placement,
    transform: entry.transform,
    effects: entry.effects,
    typography: entry.typography,
    axes: entry.axes,
  };
}

/** One revision per multi-command edit, applied in the documented order. */
async function multiCommandBuild(
  comp: string,
  name: string,
  contentArgs: string[],
  transformArgs: string[],
  anchorArgs: string[],
  effectArgs: string[],
): Promise<string> {
  const added = await json(["composition", "add", comp, name, ...contentArgs]);
  const layerId = (added.layer as { id: string }).id;
  const transforms = await json(["layer", "edit", layerId, ...transformArgs]);
  expect((transforms.layer as { currentRevision: { x: number } }).currentRevision).toBeDefined();  if (anchorArgs.length > 0) {
    await json(["layer", "edit", layerId, ...anchorArgs]);
  }
  if (effectArgs.length > 0) {
    await json(["layer", "edit", layerId, ...effectArgs]);
  }
  return layerId;
}

const IMAGE_ONE_COMMAND = [
  "--image", "<pad>",
  "--x", "120", "--y", "90", "--opacity", "0.85",
  "--resize", "1.5", "--rotate", "15", "--flip", "horizontal",
  "--skew", "10x0", "--perspective", "0x12",
  "--anchor", "center,center",
  "--shadow", "3,4,5,#000000", "--shadow", "-2,0,0,#00ffcc",
  "--outline", "2,#00ff00", "--outline", "1,#0000cc", "--blur", "6", "--choke", "2", "--feather", "2",
  "--inner-shadow", "0,6,4,#000000", "--inner-shadow", "-3,0,0,#00000080",
];
const IMAGE_CONTENT = ["--image", "<pad>", "--x", "120", "--y", "90", "--opacity", "0.85"];
const IMAGE_TRANSFORMS = ["--resize", "1.5", "--rotate", "15", "--flip", "horizontal", "--skew", "10x0", "--perspective", "0x12"];
const IMAGE_ANCHOR = ["--anchor", "center,center", "--x", "120", "--y", "90"];
const IMAGE_EFFECTS = [
  "--shadow", "3,4,5,#000000", "--shadow", "-2,0,0,#00ffcc",
  "--outline", "2,#00ff00", "--outline", "1,#0000cc", "--blur", "6", "--choke", "2", "--feather", "2",
  "--inner-shadow", "0,6,4,#000000", "--inner-shadow", "-3,0,0,#00000080",
];

const TEXT_ONE_COMMAND = [
  "--text", "Groundline", "--font", "Archivo", "--font-size", "48", "--color", "#ffcc00",
  "--x", "200", "--y", "150",
  "--resize", "1.25", "--rotate", "-12",
  "--anchor", "center,center",
  "--shadow", "3,3,5,#000000", "--shadow", "-2,0,0,#00ffcc",
  "--inner-shadow", "0,5,3,#000000",
];
const TEXT_CONTENT = [
  "--text", "Groundline", "--font", "Archivo", "--font-size", "48", "--color", "#ffcc00",
  "--x", "200", "--y", "150",
];
const TEXT_TRANSFORMS = ["--resize", "1.25", "--rotate", "-12"];
const TEXT_ANCHOR = ["--anchor", "center,center", "--x", "200", "--y", "150"];
const TEXT_EFFECTS = ["--shadow", "3,3,5,#000000", "--shadow", "-2,0,0,#00ffcc", "--inner-shadow", "0,5,3,#000000"];

// Shape (#259, finding A226-004): the same full-option parity for a shape
// Layer — the kind-shared controls production supports on shapes (absolute
// scale, rotation, flip, anchored placement, effects) in the documented
// order. No rendering change: the shape paints through the same markup the
// multi-command route always produced.
const SHAPE_ONE_COMMAND = [
  "--shape", "rectangle", "--size", "120x60", "--corner-radius", "12", "--fill", "#1d4ed8",
  "--x", "160", "--y", "120", "--opacity", "0.9",
  "--scale", "1.5", "--rotate", "20", "--flip", "horizontal",
  "--anchor", "center,center",
  "--shadow", "3,4,5,#000000", "--shadow", "-2,0,0,#00ffcc",
  "--outline", "2,#00ff00", "--outline", "1,#0000cc", "--blur", "6", "--choke", "2", "--feather", "2",
  "--inner-shadow", "0,6,4,#000000", "--inner-shadow", "-3,0,0,#00000080",
];
const SHAPE_CONTENT = [
  "--shape", "rectangle", "--size", "120x60", "--corner-radius", "12", "--fill", "#1d4ed8",
  "--x", "160", "--y", "120", "--opacity", "0.9",
];
const SHAPE_TRANSFORMS = ["--scale", "1.5", "--rotate", "20", "--flip", "horizontal"];
const SHAPE_ANCHOR = ["--anchor", "center,center", "--x", "160", "--y", "120"];
const SHAPE_EFFECTS = [
  "--shadow", "3,4,5,#000000", "--shadow", "-2,0,0,#00ffcc",
  "--outline", "2,#00ff00", "--outline", "1,#0000cc", "--blur", "6", "--choke", "2", "--feather", "2",
  "--inner-shadow", "0,6,4,#000000", "--inner-shadow", "-3,0,0,#00000080",
];

test("image Layer: one-command add equals the multi-command sequence (render, measure, one revision)", async () => {
  await createComposition("one");
  await createComposition("multi");

  const one = await json([
    "composition", "add", "one", "hero",
    ...IMAGE_ONE_COMMAND.map((a) => (a === "<pad>" ? padImagePath : a)),
  ]);
  const oneLayerId = (one.layer as { id: string }).id;
  const multiLayerId = await multiCommandBuild(
    "multi", "hero",
    IMAGE_CONTENT.map((a) => (a === "<pad>" ? padImagePath : a)),
    IMAGE_TRANSFORMS, IMAGE_ANCHOR, IMAGE_EFFECTS,
  );

  // One command publishes exactly ONE Layer revision.
  expect(await revisionCount(oneLayerId)).toBe(1);
  // The multi-command route publishes one revision per edit step.
  expect(await revisionCount(multiLayerId)).toBe(4);

  // Rendered pixels: byte-identical.
  expect(await renderBytes("one")).toEqual(await renderBytes("multi"));

  // Measure: identical geometry, placement, transform, and effects.
  const oneMeasure = await measure("one", "hero");
  const multiMeasure = await measure("multi", "hero");
  expect(geometry(oneMeasure)).toEqual(geometry(multiMeasure));

  // The one-command Layer's Render replays byte-identically from its
  // manifest.
  const rendered = await json(["composition", "render", "one"]);
  const manifest = (rendered.render as { manifest: string }).manifest;
  const renderedOutput = (rendered.render as { output: string }).output;
  const replay = await json(["composition", "replay", manifest]);
  const replayed = (replay.replay as { output: string }).output;
  expect(await readFile(replayed)).toEqual(await readFile(renderedOutput));
});

test("cover fit parity (#293, DEC-011): the one-command --cover-to add equals the multi-command sequence", async () => {
  await createComposition("one-c");
  await createComposition("multi-c");

  // One command: cover fit in the transform stage of a single add.
  const one = await json([
    "composition", "add", "one-c", "bg",
    "--image", padImagePath, "--cover-to", "300x",
  ]);
  const oneLayerId = (one.layer as { id: string }).id;
  // Multi-command: content add, then the cover fit as its own transform edit.
  const multiLayerId = await multiCommandBuild(
    "multi-c", "bg", ["--image", padImagePath], ["--cover-to", "300x"], [], [],
  );

  expect(await revisionCount(oneLayerId)).toBe(1);
  expect(await revisionCount(multiLayerId)).toBe(2);

  // The uniform cover scale = 300/64 — identical on both routes, aspect
  // preserved from the intrinsic size.
  const oneMeasure = await measure("one-c", "bg");
  const multiMeasure = await measure("multi-c", "bg");
  expect(oneMeasure.transform.scaleX).toBe(300 / 64);
  expect(oneMeasure.transform.scaleY).toBe(300 / 64);
  expect(geometry(oneMeasure)).toEqual(geometry(multiMeasure));

  expect(await renderBytes("one-c")).toEqual(await renderBytes("multi-c"));
});

test("wrap width parity (#294, DEC-001/DEC-005): the one-command --wrap-width add equals the multi-command sequence", async () => {
  await createComposition("one-w");
  await createComposition("multi-w");

  const longLine = "The quick brown fox jumps over the lazy dog and keeps running on";
  // One command: the wrap width in the text-content stage of a single add.
  const one = await json([
    "composition", "add", "one-w", "banner",
    "--text", longLine, "--font", "Archivo", "--font-size", "32", "--color", "#ffcc00",
    "--wrap-width", "220",
  ]);
  const oneLayerId = (one.layer as { id: string }).id;
  // Multi-command: content add, then the wrap width as its own text-style edit.
  const multiLayerId = await multiCommandBuild(
    "multi-w", "banner",
    ["--text", longLine, "--font", "Archivo", "--font-size", "32", "--color", "#ffcc00"],
    ["--wrap-width", "220"], [], [],
  );

  expect(await revisionCount(oneLayerId)).toBe(1);
  expect(await revisionCount(multiLayerId)).toBe(2);

  // The fact is stored on both routes, and the wrapped box agrees.
  const oneMeasure = await measure("one-w", "banner");
  const multiMeasure = await measure("multi-w", "banner");
  expect((oneMeasure as unknown as { wrapWidth: number }).wrapWidth).toBe(220);
  expect((multiMeasure as unknown as { wrapWidth: number }).wrapWidth).toBe(220);
  expect(oneMeasure.content.height).toBeGreaterThan(2.5 * 32); // soft-wrapped at spaces
  expect(geometry(oneMeasure)).toEqual(geometry(multiMeasure));

  expect(await renderBytes("one-w")).toEqual(await renderBytes("multi-w"));
});

test("fit box parity (#295, DEC-010/DEC-005): the one-command --fit-box add equals the multi-command sequence", async () => {
  await createComposition("one-f");
  await createComposition("multi-f");

  const headline = "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG";
  // One command: the fit box in the text-content stage of a single add.
  const one = await json([
    "composition", "add", "one-f", "headline",
    "--text", headline, "--font", "Archivo", "--font-size", "120", "--color", "#ffcc00",
    "--fit-box", "600x200",
  ]);
  const oneLayerId = (one.layer as { id: string }).id;
  // Multi-command: content add, then the fit box as its own text-style edit.
  const multiLayerId = await multiCommandBuild(
    "multi-f", "headline",
    ["--text", headline, "--font", "Archivo", "--font-size", "120", "--color", "#ffcc00"],
    ["--fit-box", "600x200"], [], [],
  );

  expect(await revisionCount(oneLayerId)).toBe(1);
  expect(await revisionCount(multiLayerId)).toBe(2);

  // The fact is stored on both routes, the effective size re-derives to the
  // same fitted look, and the fitted boxes agree.
  const oneMeasure = await measure("one-f", "headline");
  const multiMeasure = await measure("multi-f", "headline");
  expect((oneMeasure as unknown as { fit: { width: number; height: number } }).fit).toEqual({ width: 600, height: 200 });
  expect((multiMeasure as unknown as { fit: { width: number; height: number } }).fit).toEqual({ width: 600, height: 200 });
  expect(oneMeasure.content.width).toBeLessThanOrEqual(602);
  expect(multiMeasure.content.width).toBeLessThanOrEqual(602);
  expect((oneMeasure as unknown as { effectiveFontSize: number }).effectiveFontSize)
    .toBe((multiMeasure as unknown as { effectiveFontSize: number }).effectiveFontSize);
  expect(geometry(oneMeasure)).toEqual(geometry(multiMeasure));

  expect(await renderBytes("one-f")).toEqual(await renderBytes("multi-f"));
});

test("text Layer: one-command add equals the multi-command sequence (render, measure, one revision)", async () => {
  await createComposition("one-t");
  await createComposition("multi-t");

  const one = await json(["composition", "add", "one-t", "headline", ...TEXT_ONE_COMMAND]);
  const oneLayerId = (one.layer as { id: string }).id;
  const multiLayerId = await multiCommandBuild(
    "multi-t", "headline", TEXT_CONTENT, TEXT_TRANSFORMS, TEXT_ANCHOR, TEXT_EFFECTS,
  );

  expect(await revisionCount(oneLayerId)).toBe(1);
  expect(await revisionCount(multiLayerId)).toBe(4);

  expect(await renderBytes("one-t")).toEqual(await renderBytes("multi-t"));

  const oneMeasure = await measure("one-t", "headline");
  const multiMeasure = await measure("multi-t", "headline");
  expect(geometry(oneMeasure)).toEqual(geometry(multiMeasure));
});

test("shape Layer: one-command add equals the multi-command sequence (render, measure, one revision)", async () => {
  await createComposition("one-s");
  await createComposition("multi-s");

  const one = await json(["composition", "add", "one-s", "panel", ...SHAPE_ONE_COMMAND]);
  const oneLayerId = (one.layer as { id: string }).id;
  const multiLayerId = await multiCommandBuild(
    "multi-s", "panel", SHAPE_CONTENT, SHAPE_TRANSFORMS, SHAPE_ANCHOR, SHAPE_EFFECTS,
  );

  expect(await revisionCount(oneLayerId)).toBe(1);
  expect(await revisionCount(multiLayerId)).toBe(4);

  expect(await renderBytes("one-s")).toEqual(await renderBytes("multi-s"));

  const oneMeasure = await measure("one-s", "panel");
  const multiMeasure = await measure("multi-s", "panel");
  expect(oneMeasure.kind).toBe("shape");
  expect(multiMeasure.kind).toBe("shape");
  expect(geometry(oneMeasure)).toEqual(geometry(multiMeasure));

  // The one-command shape's Render replays byte-identically from its
  // manifest (the shape-kind replay leg of TEST-002).
  const rendered = await json(["composition", "render", "one-s"]);
  const manifest = (rendered.render as { manifest: string }).manifest;
  const renderedOutput = (rendered.render as { output: string }).output;
  const replay = await json(["composition", "replay", manifest]);
  const replayed = (replay.replay as { output: string }).output;
  expect(await readFile(replayed)).toEqual(await readFile(renderedOutput));
});

// ---------------------------------------------------------------------------
// A refused option publishes nothing, for a shape too (TEST-002): the
// one-command resolutions run before any staging, so a refused scale on a
// shape add leaves no Layer, no use, and no Project state change.
// ---------------------------------------------------------------------------

async function stateSnapshot(comp: string): Promise<{ uses: string[]; layerFiles: number }> {
  const compDoc = JSON.parse(await readFile(path.join(projDir, "compositions", `${comp}.json`), "utf8"));
  const layerFiles = (await readdir(path.join(projDir, "layers"))).filter((f) => f.endsWith(".revisions")).length;
  return { uses: compDoc.layers.map((l: { name: string }) => l.name), layerFiles };
}

test("a refused option on a shape add publishes nothing: no Layer, no use, no state change", async () => {
  await createComposition("shapeless");
  const before = await stateSnapshot("shapeless");
  // Over the per-axis effective-size cap: the scale resolution refuses
  // inside the publication path, before any staging (120px × 200 = 24000).
  const res = await spawn([
    "composition", "add", "shapeless", "too-big",
    "--shape", "rectangle", "--size", "120x60", "--fill", "#1d4ed8", "--scale", "200",
    "--project", projDir,
  ]);
  expect(res.code).toBe(1);
  expect(res.stderr).toContain("Resize result 24000×12000px is over the 8192px per-axis limit");
  const after = await stateSnapshot("shapeless");
  expect(after).toEqual(before);
});

test("a pre-existing manifest replays byte-identically after later edits", async () => {
  await createComposition("persist");
  const added = await json(["composition", "add", "persist", "bar", "--image", padImagePath, "--x", "50", "--y", "40"]);
  const layerId = (added.layer as { id: string }).id;
  const rendered = await json(["composition", "render", "persist"]);
  const manifest = (rendered.render as { manifest: string }).manifest;

  // Later edits change the CURRENT state, never the pinned manifest.
  await json(["layer", "edit", layerId, "--rotate", "45"]);
  const replay = await json(["composition", "replay", manifest]);
  const replayed = (replay.replay as { output: string }).output;
  expect(await readFile(replayed)).toEqual(await readFile((rendered.render as { output: string }).output));
});
/** TEST-004 (spec #285 US-002, DEC-002, ADR-0017 amendment #288): the same
 * --anchor with an effect present publishes the SAME stored placement
 * through one-command `composition add` and through a later re-anchoring
 * `layer edit` — both surfaces resolve through the ONE shared pre-effect
 * ink resolution, so re-anchoring a shadowed (or outlined) Layer never
 * moves it. */
test("anchor parity: the same --anchor with an effect lands the same stored placement through add and through edit", async () => {
  await createComposition("parity-shadow-one");
  await createComposition("parity-shadow-multi");

  // One-command route: content + anchored placement + effect in ONE add.
  // The anchor resolves the pre-effect ink (subject ink offset (20, 10) from
  // the placement point), so left,top at (100, 100) publishes (80, 90).
  const oneShadow = await json([
    "composition", "add", "parity-shadow-one", "hero",
    "--image", padImagePath,
    "--anchor", "left,top", "--x", "100", "--y", "100",
    "--shadow", "-10,0,0,#000000",
  ]);
  const oneShadowId = (oneShadow.layer as { id: string }).id;
  expect(await revisionCount(oneShadowId)).toBe(1);
  const oneShadowState = (oneShadow.layer as { currentRevision: { x: number; y: number } }).currentRevision;
  expect(oneShadowState.x).toBe(80);
  expect(oneShadowState.y).toBe(90);

  // Multi-command route: content placed plainly, then the shadow (the
  // rendered ink grows), then the SAME anchor — the re-anchoring scenario.
  // The anchor edit resolves the SAME pre-effect ink basis, so the stored
  // placement equals the one-command route's: the shadow never moves it.
  const added = await json([
    "composition", "add", "parity-shadow-multi", "hero", "--image", padImagePath, "--x", "100", "--y", "100",
  ]);
  const multiShadowId = (added.layer as { id: string }).id;
  await json(["layer", "edit", multiShadowId, "--shadow", "-10,0,0,#000000"]);
  await json(["layer", "edit", multiShadowId, "--anchor", "left,top", "--x", "100", "--y", "100"]);
  const multiShadowState = (await json(["layer", "inspect", multiShadowId])) as {
    layer: { currentRevision: { x: number; y: number } };
  };
  expect(multiShadowState.layer.currentRevision.x).toBe(80);
  expect(multiShadowState.layer.currentRevision.y).toBe(90);
  expect(await revisionCount(multiShadowId)).toBe(3);

  // Both routes publish the same measured geometry: the effect-ink extents
  // around the same placement.
  const oneMeasure = await measure("parity-shadow-one", "hero");
  const multiMeasure = await measure("parity-shadow-multi", "hero");
  expect(geometry(oneMeasure)).toEqual(geometry(multiMeasure));
  expect(oneMeasure.painted).toEqual({ x: 90, y: 100, width: 34, height: 28 });

  // The outline variant (DEC-002: outline is an effect, not anchor ink):
  // the same parity through both surfaces.
  await createComposition("parity-outline-one");
  await createComposition("parity-outline-multi");
  const oneOutline = await json([
    "composition", "add", "parity-outline-one", "hero",
    "--image", padImagePath,
    "--anchor", "left,top", "--x", "100", "--y", "100",
    "--outline", "6,#000000",
  ]);
  const oneOutlineId = (oneOutline.layer as { id: string }).id;
  expect(await revisionCount(oneOutlineId)).toBe(1);
  const oneOutlineState = (oneOutline.layer as { currentRevision: { x: number; y: number } }).currentRevision;
  expect(oneOutlineState.x).toBe(80);
  expect(oneOutlineState.y).toBe(90);

  const addedOutline = await json([
    "composition", "add", "parity-outline-multi", "hero", "--image", padImagePath, "--x", "100", "--y", "100",
  ]);
  const multiOutlineId = (addedOutline.layer as { id: string }).id;
  await json(["layer", "edit", multiOutlineId, "--outline", "6,#000000"]);
  await json(["layer", "edit", multiOutlineId, "--anchor", "left,top", "--x", "100", "--y", "100"]);
  const multiOutlineState = (await json(["layer", "inspect", multiOutlineId])) as {
    layer: { currentRevision: { x: number; y: number } };
  };
  expect(multiOutlineState.layer.currentRevision.x).toBe(80);
  expect(multiOutlineState.layer.currentRevision.y).toBe(90);
  const oneOutlineMeasure = await measure("parity-outline-one", "hero");
  const multiOutlineMeasure = await measure("parity-outline-multi", "hero");
  expect(geometry(oneOutlineMeasure)).toEqual(geometry(multiOutlineMeasure));
  expect(oneOutlineMeasure.painted).toEqual({ x: 94, y: 94, width: 36, height: 40 });
}, 120_000);
