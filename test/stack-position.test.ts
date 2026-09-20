/**
 * Stack position on add and import (#230, spec #226 US-002, DEC-004, TEST-004).
 *
 * Verifies at the CLI seam, offline, per-file isolate:
 * - `composition add --position` places the new use before or after a named
 *   use, or at bottom or top; the default stays top.
 * - Paint order follows the position on rendered pixels (a layer placed
 *   before a named use paints beneath it).
 * - An unknown use name is refused BEFORE publication, listing the
 *   Composition's use names — no Layer, no use, no content (fail-closed).
 * - `composition import` takes the same control for the imported set, which
 *   stays contiguous and in source order at every position (same-Project
 *   and cross-Project import).
 * - Grammar refusals are usage errors (exit 2) through the ONE shared
 *   reader (`parseStackPosition`).
 * - No Layer revision stores a position (DEC-004): the published revision
 *   carries no position fact.
 * - `inspect` shows the resulting order.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
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
    buf[i] = rgba[0]!;
    buf[i + 1] = rgba[1]!;
    buf[i + 2] = rgba[2]!;
    buf[i + 3] = rgba[3]!;
  }
  return encodePngRgba(width, height, buf);
}

const RED: [number, number, number, number] = [255, 0, 0, 255];
const GREEN: [number, number, number, number] = [0, 255, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];
const YELLOW: [number, number, number, number] = [255, 255, 0, 255];

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

const close = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-stack-position-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "stack-position-test-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComp(name: string, width = 100, height = 100) {
  const res = await invoke([
    "composition", "create", name, "--width", String(width), "--height", String(height), "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
}

async function addImage(
  comp: string,
  localName: string,
  imgFile: string,
  extra: string[] = [],
  json = true,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const res = await invoke([
    "composition", "add", comp, localName, "--image", imgFile, ...extra, "--project", projDir, ...(json ? ["--json"] : []),
  ]);
  return res;
}

async function addOk(comp: string, localName: string, imgFile: string, extra: string[] = []): Promise<Record<string, unknown>> {
  const res = await addImage(comp, localName, imgFile, extra);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

async function useNames(comp: string): Promise<string[]> {
  const res = await invoke(["composition", "inspect", comp, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const parsed = JSON.parse(res.stdout);
  return parsed.composition.layers.map((l: { name: string }) => l.name);
}

/** Fail-closed snapshot: uses, staged Layer identities, and content store. */
async function stateSnapshot(comp: string): Promise<{ uses: string[]; layerFiles: number; contentFiles: number }> {
  const compDoc = JSON.parse(await readFile(path.join(projDir, "compositions", `${comp}.json`), "utf8"));
  const layers = (await readdir(path.join(projDir, "layers"))).filter((f) => f.endsWith(".json"));
  const content = await readdir(path.join(projDir, "content"));
  return {
    uses: compDoc.layers.map((l: { name: string }) => l.name),
    layerFiles: layers.length,
    contentFiles: content.length,
  };
}

// ---------------------------------------------------------------------------
// add: before / after / bottom / top / default top, via inspect order.
// ---------------------------------------------------------------------------

test("add --position before and after a named use places the use in paint order; inspect shows the order", async () => {
  const img = path.join(tempDir, "img.png");
  await writeFile(img, solidPng(10, 10, RED));
  await makeComp("poster");

  await addOk("poster", "a", img);
  await addOk("poster", "b", img);
  await addOk("poster", "under-a", img, ["--position", "before:a"]);
  expect(await useNames("poster")).toEqual(["under-a", "a", "b"]);

  await addOk("poster", "over-b", img, ["--position", "after:b"]);
  expect(await useNames("poster")).toEqual(["under-a", "a", "b", "over-b"]);

  await addOk("poster", "between", img, ["--position", "after:a"]);
  expect(await useNames("poster")).toEqual(["under-a", "a", "between", "b", "over-b"]);

  // The compact text names the position; JSON output stays valid.
  const compact = await addImage("poster", "named", img, ["--position", "before:b"], false);
  expect(compact.code).toBe(0);
  expect(compact.stdout).toContain("(position: before:b)");
  const json = await addOk("poster", "jsoned", img, ["--position", "after:a"]);
  expect(json.ok).toBe(true);
  expect(json.use).toEqual({ name: "jsoned", layerId: expect.any(String) });
});

test("add --position bottom prepends; --position top and the default stay appended last (top)", async () => {
  const img = path.join(tempDir, "img.png");
  await writeFile(img, solidPng(10, 10, GREEN));
  await makeComp("poster");

  await addOk("poster", "first", img);
  await addOk("poster", "second", img);

  // Default stays top: appended last, and the compact output is unchanged
  // (no position note).
  const defaultAdd = await addImage("poster", "defaulted", img, [], false);
  expect(defaultAdd.code).toBe(0);
  expect(defaultAdd.stdout).not.toContain("(position:");
  expect(await useNames("poster")).toEqual(["first", "second", "defaulted"]);

  // Explicit top is the same placement.
  await addOk("poster", "explicit-top", img, ["--position", "top"]);
  expect(await useNames("poster")).toEqual(["first", "second", "defaulted", "explicit-top"]);

  // Bottom paints beneath everything.
  await addOk("poster", "floor", img, ["--position", "bottom"]);
  expect(await useNames("poster")).toEqual(["floor", "first", "second", "defaulted", "explicit-top"]);
});

test("paint order follows the position on rendered pixels: a use placed before a named use paints beneath it", async () => {
  await makeComp("stacked", 64, 64);
  const full = (name: string, rgba: [number, number, number, number]) => {
    const p = path.join(tempDir, `${name}.png`);
    return writeFile(p, solidPng(64, 64, rgba)).then(() => p);
  };

  const greenBase = await full("green", GREEN);
  const redCover = await full("red", RED);
  const blueCap = await full("blue", BLUE);
  const yellowTop = await full("yellow", YELLOW);

  await addOk("stacked", "base", greenBase);
  await addOk("stacked", "cover", redCover); // default: top — red wins the pixel
  expect(await useNames("stacked")).toEqual(["base", "cover"]);
  let res = await invoke(["composition", "render", "stacked", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  let png = decodePng(await readFile(JSON.parse(res.stdout).render.output));
  expect(pixel(png, 32, 32).every((v, i) => close(v, RED[i]!))).toBe(true);

  // Blue placed BEFORE cover paints beneath it: red still wins the pixel.
  await addOk("stacked", "cap", blueCap, ["--position", "before:cover"]);
  expect(await useNames("stacked")).toEqual(["base", "cap", "cover"]);
  res = await invoke(["composition", "render", "stacked", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  png = decodePng(await readFile(JSON.parse(res.stdout).render.output));
  expect(pixel(png, 32, 32).every((v, i) => close(v, RED[i]!))).toBe(true);

  // Yellow placed AFTER cover paints above everything: yellow wins the pixel.
  await addOk("stacked", "top", yellowTop, ["--position", "after:cover"]);
  expect(await useNames("stacked")).toEqual(["base", "cap", "cover", "top"]);
  res = await invoke(["composition", "render", "stacked", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  png = decodePng(await readFile(JSON.parse(res.stdout).render.output));
  expect(pixel(png, 32, 32).every((v, i) => close(v, YELLOW[i]!))).toBe(true);
});

// ---------------------------------------------------------------------------
// The unknown-use refusal publishes nothing (fail-closed, #229's ordering).
// ---------------------------------------------------------------------------

test("an unknown use name is refused before publication, listing the Composition's use names", async () => {
  const img = path.join(tempDir, "img.png");
  await writeFile(img, solidPng(10, 10, BLUE));
  // A FRESH image for the refused attempt, so the fail-closed snapshot's
  // content-store leg has teeth: a regression that retained content before
  // the position resolves would orphan a blob and change the count.
  const fresh = path.join(tempDir, "fresh.png");
  await writeFile(fresh, solidPng(12, 12, YELLOW));
  await makeComp("poster");
  await addOk("poster", "a", img);
  await addOk("poster", "b", img);

  const before = await stateSnapshot("poster");
  const res = await addImage("poster", "stray", fresh, ["--position", "after:nope"], false);
  expect(res.code).toBe(1);
  expect(res.stderr).toContain('Unknown use "nope" for --position after:nope');
  expect(res.stderr).toContain('"a"');
  expect(res.stderr).toContain('"b"');
  const after = await stateSnapshot("poster");
  expect(after).toEqual(before);

  // The same refusal on an empty Composition, with its empty use list named.
  await makeComp("empty-comp");
  const emptyBefore = await stateSnapshot("empty-comp");
  const emptyRes = await addImage("empty-comp", "x", img, ["--position", "before:somewhere"], false);
  expect(emptyRes.code).toBe(1);
  expect(emptyRes.stderr).toContain("the Composition has no uses");
  const emptyAfter = await stateSnapshot("empty-comp");
  expect(emptyAfter).toEqual(emptyBefore);
});

test("a malformed position spec is a usage error (exit 2) through the one shared reader", async () => {
  const img = path.join(tempDir, "img.png");
  await writeFile(img, solidPng(10, 10, RED));
  await makeComp("poster");
  await addOk("poster", "a", img);
  const before = await stateSnapshot("poster");

  for (const spec of ["middle", "before:", "after:", "TOP"]) {
    const res = await addImage("poster", "x", img, ["--position", spec], false);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("Invalid --position");
    expect(await stateSnapshot("poster")).toEqual(before);
  }
  // A use name that fails the one name rule (sanitizeName) is also refused
  // at the same boundary, naming the offending name.
  const badName = await addImage("poster", "x", img, ["--position", "before:a,b"], false);
  expect(badName.code).toBe(2);
  expect(badName.stderr).toContain('Name "a,b" contains invalid characters');
  expect(await stateSnapshot("poster")).toEqual(before);
});

test("no Layer revision stores a position (DEC-004): the published revision carries no position fact", async () => {
  const img = path.join(tempDir, "img.png");
  await writeFile(img, solidPng(10, 10, RED));
  await makeComp("poster");
  await addOk("poster", "a", img);
  const res = await addOk("poster", "positioned", img, ["--position", "before:a"]);
  const rev = (res.layer as { currentRevision: Record<string, unknown> }).currentRevision;
  expect(rev).not.toHaveProperty("position");
  expect(await useNames("poster")).toEqual(["positioned", "a"]);
});

// ---------------------------------------------------------------------------
// import: the imported set stays contiguous and in source order at each
// position.
// ---------------------------------------------------------------------------

async function seedSource(source: string, projectDir: string = projDir): Promise<void> {
  const red = path.join(tempDir, `${source}-red.png`);
  const green = path.join(tempDir, `${source}-green.png`);
  await writeFile(red, solidPng(10, 10, RED));
  await writeFile(green, solidPng(10, 10, GREEN));
  await invoke([
    "composition", "create", source, "--width", "100", "--height", "100", "--project", projectDir, "--json",
  ]);
  const add = async (name: string, img: string) => {
    const res = await invoke(["composition", "add", source, name, "--image", img, "--project", projectDir, "--json"]);
    expect(res.code).toBe(0);
  };
  await add("s1", red);
  await add("s2", green);
  await add("s3", red);
}

test("import places the imported set before or after a named use; the set stays contiguous and in source order", async () => {
  const img = path.join(tempDir, "img.png");
  await writeFile(img, solidPng(10, 10, BLUE));
  await seedSource("src");
  await makeComp("target");
  await addOk("target", "t1", img);
  await addOk("target", "t2", img);

  // before t1: the block at the bottom, source order preserved.
  let res = await invoke(["composition", "import", "target", "src", "--position", "before:t1", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  expect(JSON.parse(res.stdout).layers.map((l: { name: string }) => l.name)).toEqual(["s1", "s2", "s3", "t1", "t2"]);

  // A second import of a differently named source set, mid-position: the
  // block stays contiguous and in source order between t1 and t2.
  await seedSource("src2");
  await invoke(["composition", "remove", "target", "s1", "--project", projDir, "--json"]);
  await invoke(["composition", "remove", "target", "s2", "--project", projDir, "--json"]);
  await invoke(["composition", "remove", "target", "s3", "--project", projDir, "--json"]);
  res = await invoke(["composition", "import", "target", "src2", "--position", "after:t1", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  expect(JSON.parse(res.stdout).layers.map((l: { name: string }) => l.name)).toEqual(["t1", "s1", "s2", "s3", "t2"]);

  // after the last use and explicit top are the same placement as default.
  await invoke(["composition", "remove", "target", "s1", "--project", projDir, "--json"]);
  await invoke(["composition", "remove", "target", "s2", "--project", projDir, "--json"]);
  await invoke(["composition", "remove", "target", "s3", "--project", projDir, "--json"]);
  res = await invoke(["composition", "import", "target", "src2", "--position", "after:t2", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  expect(JSON.parse(res.stdout).layers.map((l: { name: string }) => l.name)).toEqual(["t1", "t2", "s1", "s2", "s3"]);

  await invoke(["composition", "remove", "target", "s1", "--project", projDir, "--json"]);
  await invoke(["composition", "remove", "target", "s2", "--project", projDir, "--json"]);
  await invoke(["composition", "remove", "target", "s3", "--project", projDir, "--json"]);
  const compact = await invoke(["composition", "import", "target", "src2", "--position", "top", "--project", projDir]);
  expect(compact.code).toBe(0);
  expect(compact.stdout).toContain("(position: top)");
  expect(await useNames("target")).toEqual(["t1", "t2", "s1", "s2", "s3"]);
});

test("import --position bottom prepends the imported set", async () => {
  const img = path.join(tempDir, "img.png");
  await writeFile(img, solidPng(10, 10, BLUE));
  await seedSource("src");
  await makeComp("target");
  await addOk("target", "t1", img);
  await addOk("target", "t2", img);

  const res = await invoke(["composition", "import", "target", "src", "--position", "bottom", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  expect(JSON.parse(res.stdout).layers.map((l: { name: string }) => l.name)).toEqual(["s1", "s2", "s3", "t1", "t2"]);
});

test("import refuses an unknown use name before publication, naming the target's uses, and changes nothing", async () => {
  const img = path.join(tempDir, "img.png");
  await writeFile(img, solidPng(10, 10, BLUE));
  await seedSource("src");
  await makeComp("target");
  await addOk("target", "t1", img);

  const before = await stateSnapshot("target");
  const res = await invoke(["composition", "import", "target", "src", "--position", "after:missing", "--project", projDir]);
  expect(res.code).toBe(1);
  expect(res.stderr).toContain('Unknown use "missing" for --position after:missing');
  expect(res.stderr).toContain('"t1"');
  expect(await stateSnapshot("target")).toEqual(before);
});

test("cross-Project import takes the same --position control", async () => {
  const img = path.join(tempDir, "img.png");
  await writeFile(img, solidPng(10, 10, BLUE));
  const otherProj = path.join(tempDir, "other-proj");
  await invoke(["project", "init", otherProj, "--name", "other-proj"]);
  // The source lives in the OTHER Project; the target in the destination.
  await seedSource("src", otherProj);
  await makeComp("target");
  await addOk("target", "t1", img);

  const res = await invoke([
    "composition", "import", "target", "src", "--position", "after:t1", "--from-project", otherProj,
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  expect(JSON.parse(res.stdout).layers.map((l: { name: string }) => l.name)).toEqual(["t1", "s1", "s2", "s3"]);
  const inspect = await invoke(["composition", "inspect", "target", "--project", projDir, "--json"]);
  expect(inspect.code).toBe(0);
  expect(JSON.parse(inspect.stdout).composition.layers.map((l: { name: string }) => l.name)).toEqual(["t1", "s1", "s2", "s3"]);
});