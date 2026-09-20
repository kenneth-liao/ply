/**
 * The absolute scale setter (--scale, spec #226 US-004, DEC-005/DEC-009,
 * ADR-0016), verified at the CLI and measure seams (TEST-006, offline):
 *
 * - Idempotence: running `--scale <factor>` twice gives the same measured
 *   result on image and text Layers — the value IS the canonical scale
 *   (ADR-0016), so repeating the command never compounds (unlike the
 *   relative --resize factor).
 * - The value it sets is what `measure` and `layer inspect` report.
 * - Mutual exclusion with --resize and --resize-to is refused before
 *   publication, on both the edit and the add surface.
 * - It works on one-command `composition add` as well as `layer edit`,
 *   through the ONE shared option definition and ONE scale resolution.
 * - A Render retained before the change replays byte-identically: the
 *   scale edit advances the revision; pinned history stays pinned.
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

const RED: [number, number, number, number] = [255, 0, 0, 255];

let tempDir: string;
let projDir: string;
let imagePath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-absolute-scale-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir]);
  await invoke(["composition", "create", "poster", "--width", "400", "--height", "300", "--project", projDir]);
  imagePath = path.join(tempDir, "red.png");
  await writeFile(imagePath, solidPng(64, 48, RED));
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function addImage(use: string): Promise<{ layerId: string; revisionId: string }> {
  const res = await invoke([
    "composition", "add", "poster", use, "--image", imagePath, "--x", "10", "--y", "10",
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const parsed = JSON.parse(res.stdout);
  return { layerId: parsed.use.layerId as string, revisionId: parsed.layer.currentRevisionId as string };
}

async function addText(use: string): Promise<{ layerId: string; revisionId: string }> {
  const res = await invoke([
    "composition", "add", "poster", use, "--text", "Headline", "--font", "Archivo", "--font-size", "48",
    "--x", "10", "--y", "10", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const parsed = JSON.parse(res.stdout);
  return { layerId: parsed.use.layerId as string, revisionId: parsed.layer.currentRevisionId as string };
}

/** The measured transform and box of a use (the read-only measure seam). */
async function measureUse(use: string): Promise<{ scaleX: number; scaleY: number; box: Record<string, number> }> {
  const res = await invoke(["composition", "measure", "poster", use, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const layer = JSON.parse(res.stdout).layers[0];
  return { scaleX: layer.transform.scaleX, scaleY: layer.transform.scaleY, box: layer.box };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function editJson(layerId: string, args: string[]): Promise<{ code: number; parsed: any; stderr: string; stdout: string }> {
  const res = await invoke(["layer", "edit", layerId, ...args, "--project", projDir, "--json"]);
  const parsed: any = res.code === 0 ? JSON.parse(res.stdout) : undefined;
  return { code: res.code, parsed, stderr: res.stderr, stdout: res.stdout };
}

// ---------------------------------------------------------------------------
// Idempotence (TEST-006): the same command twice gives the same result.
// ---------------------------------------------------------------------------

test("image --scale is idempotent: repeating the edit keeps the same measured result", async () => {
  const { layerId } = await addImage("hero");

  const first = await editJson(layerId, ["--scale", "2"]);
  expect(first.code).toBe(0);
  const rev = first.parsed!.layer.currentRevision;
  expect(rev.scaleX).toBe(2);
  expect(rev.scaleY).toBe(2);
  // The resized report states the effective size the scale produces.
  expect(first.parsed!.resized).toEqual({ scaleX: 2, scaleY: 2, width: 128, height: 96 });
  const measuredFirst = await measureUse("hero");
  expect(measuredFirst.scaleX).toBe(2);
  expect(measuredFirst.scaleY).toBe(2);
  expect(measuredFirst.box.width).toBe(128);
  expect(measuredFirst.box.height).toBe(96);

  // A compounding neighbor first: a relative resize between the two absolute
  // edits must be REPLACED, not accumulated, by the next --scale.
  const bump = await editJson(layerId, ["--resize", "2"]);
  expect(bump.code).toBe(0);
  const measuredAfterResize = await measureUse("hero");
  expect(measuredAfterResize.scaleX).toBe(4);

  const second = await editJson(layerId, ["--scale", "2"]);
  expect(second.code).toBe(0);
  expect(second.parsed!.layer.currentRevision.scaleX).toBe(2);
  expect(second.parsed!.layer.currentRevision.scaleY).toBe(2);
  const measuredSecond = await measureUse("hero");
  expect(measuredSecond).toEqual(measuredFirst);
});

test("text --scale is idempotent: repeating the edit keeps the same measured result", async () => {
  const { layerId } = await addText("headline");

  const first = await editJson(layerId, ["--scale", "0.5"]);
  expect(first.code).toBe(0);
  const rev = first.parsed!.layer.currentRevision;
  expect(rev.scaleX).toBe(0.5);
  expect(rev.scaleY).toBe(0.5);
  const measuredFirst = await measureUse("headline");
  expect(measuredFirst.scaleX).toBe(0.5);
  expect(measuredFirst.scaleY).toBe(0.5);

  const second = await editJson(layerId, ["--scale", "0.5"]);
  expect(second.code).toBe(0);
  const measuredSecond = await measureUse("headline");
  expect(measuredSecond).toEqual(measuredFirst);
});

// ---------------------------------------------------------------------------
// The value it sets is what measure and inspect report.
// ---------------------------------------------------------------------------

test("the set scale is what measure and layer inspect report", async () => {
  const { layerId } = await addImage("hero");
  const edit = await editJson(layerId, ["--scale", "1.5"]);
  expect(edit.code).toBe(0);

  const measured = await measureUse("hero");
  expect(measured.scaleX).toBe(1.5);
  expect(measured.scaleY).toBe(1.5);

  const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(inspect.code).toBe(0);
  const rev = JSON.parse(inspect.stdout).layer.currentRevision;
  expect(rev.scaleX).toBe(1.5);
  expect(rev.scaleY).toBe(1.5);
});

// ---------------------------------------------------------------------------
// Mutual exclusion: refused before publication (TEST-006).
// ---------------------------------------------------------------------------

async function revisionIdOf(layerId: string): Promise<string> {
  const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  return JSON.parse(inspect.stdout).layer.currentRevisionId as string;
}

test("--scale is refused with --resize, and nothing publishes", async () => {
  const { layerId, revisionId } = await addImage("hero");
  const res = await editJson(layerId, ["--scale", "2", "--resize", "2"]);
  expect(res.code).toBe(2);
  expect(JSON.parse(res.stdout).error).toContain(
    "--resize and --scale are mutually exclusive: use one resize form per edit (--resize is relative, --scale sets the absolute scale).",
  );
  expect(await revisionIdOf(layerId)).toBe(revisionId);
});

test("--scale is refused with --resize-to, and nothing publishes", async () => {
  const { layerId, revisionId } = await addImage("hero");
  const res = await editJson(layerId, ["--scale", "2", "--resize-to", "96x"]);
  expect(res.code).toBe(2);
  expect(JSON.parse(res.stdout).error).toContain(
    "--resize-to and --scale are mutually exclusive: use one resize form per edit (--resize-to sets an absolute size, --scale sets the absolute scale).",
  );
  expect(await revisionIdOf(layerId)).toBe(revisionId);
});

test("the same refusals hold on the add surface, and publish nothing", async () => {
  async function stateSnapshot(): Promise<{ uses: string[]; layerFiles: number; contentFiles: number }> {
    const compDoc = JSON.parse(await readFile(path.join(projDir, "compositions", "poster.json"), "utf8"));
    const layers = (await readdir(path.join(projDir, "layers"))).filter((f) => f.endsWith(".json"));
    const content = await readdir(path.join(projDir, "content"));
    return { uses: compDoc.layers.map((l: { name: string }) => l.name), layerFiles: layers.length, contentFiles: content.length };
  }
  const before = await stateSnapshot();
  for (const extra of [["--resize", "2"], ["--resize-to", "96x"]]) {
    const res = await invoke([
      "composition", "add", "poster", "nope", "--image", imagePath, "--scale", "2", ...extra,
      "--project", projDir, "--json",
    ]);
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout).ok).toBe(false);
    expect(await stateSnapshot()).toEqual(before);
  }
});

// ---------------------------------------------------------------------------
// It works on add as well as edit (DEC-001: one shared definition).
// ---------------------------------------------------------------------------

test("one-command add accepts --scale on image and text Layers", async () => {
  const img = await invoke([
    "composition", "add", "poster", "hero", "--image", imagePath, "--scale", "2",
    "--project", projDir, "--json",
  ]);
  expect(img.code).toBe(0);
  const imgRev = JSON.parse(img.stdout).layer.currentRevision;
  expect(imgRev.scaleX).toBe(2);
  expect(imgRev.scaleY).toBe(2);

  const text = await invoke([
    "composition", "add", "poster", "headline", "--text", "Headline", "--font", "Archivo", "--scale", "0.5",
    "--project", projDir, "--json",
  ]);
  expect(text.code).toBe(0);
  const textRev = JSON.parse(text.stdout).layer.currentRevision;
  expect(textRev.scaleX).toBe(0.5);
  expect(textRev.scaleY).toBe(0.5);

  const measured = await measureUse("hero");
  expect(measured.scaleX).toBe(2);
  expect(measured.scaleY).toBe(2);
});

test("--scale shape refusals are usage errors on both surfaces", async () => {
  const { layerId } = await addImage("hero");
  // A leading-dash value is parseArgs' established unknown-flag usage error
  // (the same limitation --resize has; the shape text is unit-pinned in
  // test/layer-options.test.ts), so the CLI cases here are "0" and "abc".
  for (const value of ["0", "abc"]) {
    const edit = await invoke(["layer", "edit", layerId, "--scale", value, "--project", projDir, "--json"]);
    expect(edit.code).toBe(2);
    expect(JSON.parse(edit.stdout).error).toBe(`Scale (--scale) must be a finite number greater than 0 (got "${value}").`);
    const add = await invoke([
      "composition", "add", "poster", "nope", "--image", imagePath, "--scale", value, "--project", projDir, "--json",
    ]);
    expect(add.code).toBe(2);
    expect(JSON.parse(add.stdout).error).toBe(`Scale (--scale) must be a finite number greater than 0 (got "${value}").`);
  }
});

test("--scale with content replacement is refused, and nothing publishes (INT-1)", async () => {
  const { layerId, revisionId } = await addImage("hero");
  const other = path.join(tempDir, "other.png");
  await writeFile(other, solidPng(32, 32, [0, 0, 255, 255]));
  const res = await editJson(layerId, ["--image", other, "--scale", "2"]);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error).toBe(
    `Scale and content replacement are separate edits: Layer "${layerId}" cannot replace its source and set --scale in one edit, because the effective-size cap reads the retained content's intrinsic size.`,
  );
  // Refused before any staging: the revision is unchanged.
  expect(await revisionIdOf(layerId)).toBe(revisionId);
  // The retained content still resolves to the original file's identity.
  const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(JSON.parse(inspect.stdout).layer.currentRevision.width).toBe(64);
});

// ---------------------------------------------------------------------------
// The over-cap path: the boundary accepts any finite positive number; the
// MAX_DIMENSION cap is the publication path's refusal (INT-2).
// ---------------------------------------------------------------------------

for (const overCap of ["8193", "99999"]) {
  test(`--scale ${overCap} is over the cap: refused on edit, nothing publishes (INT-2)`, async () => {
    const { layerId, revisionId } = await addImage("hero");
    const res = await editJson(layerId, ["--scale", overCap]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).error).toBe(
      `Invalid scale ${overCap}: must be a finite number between 0 and 8192.`,
    );
    expect(await revisionIdOf(layerId)).toBe(revisionId);
  });

  test(`--scale ${overCap} is over the cap: refused on add, nothing publishes (INT-2)`, async () => {
    const compDoc = JSON.parse(await readFile(path.join(projDir, "compositions", "poster.json"), "utf8"));
    const layersBefore = (await readdir(path.join(projDir, "layers"))).filter((f) => f.endsWith(".json"));
    const contentBefore = await readdir(path.join(projDir, "content"));
    const res = await invoke([
      "composition", "add", "poster", "too-big", "--image", imagePath, "--scale", overCap,
      "--project", projDir, "--json",
    ]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).error).toBe(
      `Invalid scale ${overCap}: must be a finite number between 0 and 8192.`,
    );
    const compAfter = JSON.parse(await readFile(path.join(projDir, "compositions", "poster.json"), "utf8"));
    expect(compAfter.layers.map((l: { name: string }) => l.name)).toEqual(
      compDoc.layers.map((l: { name: string }) => l.name),
    );
    expect((await readdir(path.join(projDir, "layers"))).filter((f) => f.endsWith(".json"))).toEqual(layersBefore);
    expect(await readdir(path.join(projDir, "content"))).toEqual(contentBefore);
  });
}

// ---------------------------------------------------------------------------
// A Render retained before the change replays byte-identically.
// ---------------------------------------------------------------------------

test("a Render retained before the --scale edit replays byte-identically", async () => {
  const { layerId } = await addImage("hero");
  const render = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(render.code).toBe(0);
  const renderJson = JSON.parse(render.stdout).render;
  const originalPng = await readFile(renderJson.output);
  const manifestPath = renderJson.manifest;

  const edit = await editJson(layerId, ["--scale", "2"]);
  expect(edit.code).toBe(0);

  const replay = await invoke(["composition", "replay", manifestPath, "--project", projDir, "--json"]);
  expect(replay.code).toBe(0);
  const replayOutput = JSON.parse(replay.stdout).replay.output as string;
  expect(readFile(replayOutput)).resolves.toEqual(originalPng);
});