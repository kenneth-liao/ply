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
  transform: { scaleX: number; scaleY: number; rotationDeg: number; flipX: boolean; flipY: boolean };
  effects: { shadow: unknown; outline: unknown };
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
  "--anchor", "center,center",
  "--shadow", "3,4,5,#000000", "--outline", "2,#00ff00",
];
const IMAGE_CONTENT = ["--image", "<pad>", "--x", "120", "--y", "90", "--opacity", "0.85"];
const IMAGE_TRANSFORMS = ["--resize", "1.5", "--rotate", "15", "--flip", "horizontal"];
const IMAGE_ANCHOR = ["--anchor", "center,center", "--x", "120", "--y", "90"];
const IMAGE_EFFECTS = ["--shadow", "3,4,5,#000000", "--outline", "2,#00ff00"];

const TEXT_ONE_COMMAND = [
  "--text", "Groundline", "--font", "Archivo", "--font-size", "48", "--color", "#ffcc00",
  "--x", "200", "--y", "150",
  "--resize", "1.25", "--rotate", "-12",
  "--anchor", "center,center",
  "--shadow", "3,3,5,#000000",
];
const TEXT_CONTENT = [
  "--text", "Groundline", "--font", "Archivo", "--font-size", "48", "--color", "#ffcc00",
  "--x", "200", "--y", "150",
];
const TEXT_TRANSFORMS = ["--resize", "1.25", "--rotate", "-12"];
const TEXT_ANCHOR = ["--anchor", "center,center", "--x", "200", "--y", "150"];
const TEXT_EFFECTS = ["--shadow", "3,3,5,#000000"];

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