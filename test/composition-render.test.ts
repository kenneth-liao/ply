/**
 * Composition render acceptance (#80, spec #77 US-006 / US-008): the public CLI
 * renders a resolved local image Composition at exactly the Composition's
 * canvas dimensions, preserving reference-list paint order, position, and
 * opacity, and fails loudly on invalid dimensions and unresolved or invalid
 * image content. Every assertion runs against produced PNGs, not logs.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, readdir, writeFile, symlink, mkdir, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePngRgba, readPngHeader, decodePng } from "../src/png.js";

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

const RED: [number, number, number, number] = [255, 0, 0, 255];
const GREEN: [number, number, number, number] = [0, 255, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];

/** Pixel (x, y) of a decoded RGBA PNG as [r, g, b, a]. */
function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

const close = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-comp-render-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "render-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComposition(name: string, width: number, height: number, layers: {
  local: string;
  file: string;
  x?: number;
  y?: number;
  opacity?: number;
}[]) {
  await invoke(["composition", "create", name, "--width", String(width), "--height", String(height), "--project", projDir]);
  for (const l of layers) {
    const args = ["composition", "add", name, l.local, "--image", l.file, "--project", projDir];
    if (l.x !== undefined) args.push("--x", String(l.x));
    if (l.y !== undefined) args.push("--y", String(l.y));
    if (l.opacity !== undefined) args.push("--opacity", String(l.opacity));
    const res = await invoke(args);
    expect(res.code).toBe(0);
  }
}

test("renders a 1080×1080 composition at exactly 1080×1080 with project-owned default output", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(1080, 1080, RED));
  await makeComposition("poster", 1080, 1080, [{ local: "bg", file: img }]);

  const res = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(true);
  expect(json.render.width).toBe(1080);
  expect(json.render.height).toBe(1080);

  // Default output is Project-owned: a fresh file under renders/.
  const outputs = (await readdir(path.join(projDir, "renders"))).filter((f) => f.endsWith(".png"));
  expect(outputs).toHaveLength(1);
  expect(json.render.output).toBe(path.join(projDir, "renders", outputs[0]!));

  const pngBytes = await readFile(json.render.output);
  const header = readPngHeader(pngBytes);
  expect(header.width).toBe(1080);
  expect(header.height).toBe(1080);
  const decoded = decodePng(pngBytes);
  expect(pixel(decoded, 5, 5).every((v, i) => close(v, RED[i]!))).toBe(true);
});

test("renders a 2560×1440 composition at exactly 2560×1440", async () => {
  const img = path.join(tempDir, "red-wide.png");
  await writeFile(img, solidPng(2560, 1440, RED));
  await makeComposition("wide", 2560, 1440, [{ local: "bg", file: img }]);

  const res = await invoke(["composition", "render", "wide", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  const pngBytes = await readFile(json.render.output);
  const header = readPngHeader(pngBytes);
  expect(header.width).toBe(2560);
  expect(header.height).toBe(1440);
  const decoded = decodePng(pngBytes);
  expect(pixel(decoded, 1280, 720).every((v, i) => close(v, RED[i]!))).toBe(true);
});

test("paint order, position, opacity, intrinsic size, and clipping follow the reference list", async () => {
  // Canvas 400×300. Later layers paint over earlier ones.
  const back = path.join(tempDir, "green.png");
  await writeFile(back, solidPng(200, 200, GREEN));
  const front = path.join(tempDir, "blue.png");
  await writeFile(front, solidPng(200, 200, BLUE));
  const ghost = path.join(tempDir, "red.png");
  await writeFile(ghost, solidPng(100, 100, RED));
  const clipped = path.join(tempDir, "green2.png");
  await writeFile(clipped, solidPng(100, 100, GREEN));

  await makeComposition("stack", 400, 300, [
    { local: "back", file: back, x: 0, y: 0 },
    { local: "front", file: front, x: 100, y: 50, opacity: 0.5 },
    { local: "ghost", file: ghost, x: 300, y: 0, opacity: 0 },
    { local: "corner", file: clipped, x: 350, y: 250 },
  ]);

  const res = await invoke(["composition", "render", "stack", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  const pngBytes = await readFile(json.render.output);
  const header = readPngHeader(pngBytes);
  expect(header.width).toBe(400);
  expect(header.height).toBe(300);
  const d = decodePng(pngBytes);

  // Only the back layer covers (50, 25): green, fully opaque.
  expect(pixel(d, 50, 25).every((v, i) => close(v, [0, 255, 0, 255][i]!))).toBe(true);
  // Overlap of back and front at (150, 100): 50% blue over green.
  const overlap = pixel(d, 150, 100);
  expect(close(overlap[0]!, 0)).toBe(true);
  expect(close(overlap[1]!, 128)).toBe(true);
  expect(close(overlap[2]!, 127)).toBe(true);
  // Front only at (250, 75): 50% blue over the transparent canvas.
  const frontOnly = pixel(d, 250, 75);
  expect(close(frontOnly[0]!, 0)).toBe(true);
  expect(close(frontOnly[1]!, 0)).toBe(true);
  expect(close(frontOnly[2]!, 255)).toBe(true);
  expect(close(frontOnly[3]!, 128)).toBe(true);
  // Opacity 0 paints nothing: (350, 50) stays transparent.
  expect(pixel(d, 350, 50).every((v) => close(v, 0))).toBe(true);
  // Position + intrinsic size + clipping: the 100×100 layer at (350, 250)
  // only reaches the 50×50 bottom-right corner of the canvas.
  expect(pixel(d, 399, 299).every((v, i) => close(v, [0, 255, 0, 255][i]!))).toBe(true);
  expect(pixel(d, 399, 299)![3]!).toBe(255);
  expect(close(pixel(d, 340, 240)![3]!, 0)).toBe(true);
});

test("default compact text output is one actionable line, not JSON", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(64, 64, RED));
  await makeComposition("tiny", 64, 64, [{ local: "bg", file: img }]);
  const res = await invoke(["composition", "render", "tiny", "--project", projDir]);
  expect(res.code).toBe(0);
  const lines = res.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("tiny");
  expect(lines[0]).toContain("64×64");
  expect(lines[0]).toContain(".png");
});

test("--out exports the PNG to a caller-chosen location and leaves renders/ empty", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(64, 64, RED));
  await makeComposition("exported", 64, 64, [{ local: "bg", file: img }]);
  const out = path.join(tempDir, "export", "out.png");
  await mkdir(path.dirname(out), { recursive: true });
  const res = await invoke(["composition", "render", "exported", "--project", projDir, "--out", out, "--json"]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.render.output).toBe(out);
  const pngBytes = await readFile(out);
  expect(readPngHeader(pngBytes).width).toBe(64);
  expect((await readdir(path.join(projDir, "renders"))).filter((f) => f.endsWith(".png"))).toHaveLength(0);
});

test("rejects invalid canvas dimensions before rendering", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(10, 10, RED));
  // create accepts positive integers; the render boundary enforces resource limits.
  await invoke(["composition", "create", "toowide", "--width", "9000", "--height", "100", "--project", projDir]);
  await invoke(["composition", "add", "toowide", "bg", "--image", img, "--project", projDir]);
  const res = await invoke(["composition", "render", "toowide", "--project", projDir, "--json"]);
  expect(res.code).toBe(1);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(false);
  expect(json.error).toContain("9000");
  // No output was published.
  expect((await readdir(path.join(projDir, "renders"))).filter((f) => f.endsWith(".png"))).toHaveLength(0);

  await invoke(["composition", "create", "toomanypx", "--width", "8192", "--height", "8192", "--project", projDir]);
  await invoke(["composition", "add", "toomanypx", "bg", "--image", img, "--project", projDir]);
  const res2 = await invoke(["composition", "render", "toomanypx", "--project", projDir, "--json"]);
  expect(res2.code).toBe(1);
  expect(JSON.parse(res2.stdout).ok).toBe(false);
});

test("rejects a dangling Layer reference before reporting success", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(32, 32, RED));
  await makeComposition("dangling", 64, 64, [{ local: "bg", file: img }]);
  const compFile = path.join(projDir, "compositions", "dangling.json");
  const comp = JSON.parse(await readFile(compFile, "utf8"));
  comp.layers[0]!.layerId = "layer_missing00";
  await writeFile(compFile, JSON.stringify(comp, null, 2) + "\n");

  const res = await invoke(["composition", "render", "dangling", "--project", projDir, "--json"]);
  expect(res.code).toBe(1);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(false);
  expect(json.error).toContain("layer_missing00");
  expect((await readdir(path.join(projDir, "renders"))).filter((f) => f.endsWith(".png"))).toHaveLength(0);
});

test("rejects corrupted and missing retained content instead of substituting", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(32, 32, RED));
  await makeComposition("corrupt", 64, 64, [{ local: "bg", file: img }]);
  const comp = JSON.parse(await readFile(path.join(projDir, "compositions", "corrupt.json"), "utf8"));
  const layerId = comp.layers[0]!.layerId;
  const identity = JSON.parse(await readFile(path.join(projDir, "layers", `${layerId}.json`), "utf8"));

  // Find the content hash from the revision document.
  const revDir = path.join(projDir, "layers", `${layerId}.revisions`);
  const revFile = path.join(revDir, `${identity.currentRevision}.json`);
  const rev = JSON.parse(await readFile(revFile, "utf8"));
  const contentPath = path.join(projDir, "content", rev.contentHash);

  // Corrupt the retained bytes.
  const bytes = await readFile(contentPath);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
  await writeFile(contentPath, bytes);
  const res = await invoke(["composition", "render", "corrupt", "--project", projDir, "--json"]);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error).toContain("Corrupted content blob");
  expect((await readdir(path.join(projDir, "renders"))).filter((f) => f.endsWith(".png"))).toHaveLength(0);

  // Missing retained bytes.
  await rm(contentPath);
  const missing = await invoke(["composition", "render", "corrupt", "--project", projDir, "--json"]);
  expect(missing.code).toBe(1);
  expect(JSON.parse(missing.stdout).ok).toBe(false);
});

test("rendering a missing Composition fails with an actionable diagnostic", async () => {
  const res = await invoke(["composition", "render", "nope", "--project", projDir, "--json"]);
  expect(res.code).toBe(1);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(false);
  expect(json.error).toContain("nope");
});

test("--out refuses to overwrite protected Project storage, resolving symlinks", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(32, 32, RED));
  await makeComposition("guarded", 32, 32, [{ local: "bg", file: img }]);

  // A real retained input.
  const manifestBefore = await readFile(path.join(projDir, "ply.json"), "utf8");
  const res = await invoke([
    "composition", "render", "guarded", "--project", projDir, "--out", path.join(projDir, "ply.json"), "--json",
  ]);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).ok).toBe(false);
  expect(await readFile(path.join(projDir, "ply.json"), "utf8")).toBe(manifestBefore);

  // Inside the content store (nonexistent leaf, protected directory).
  const res2 = await invoke([
    "composition", "render", "guarded", "--project", projDir,
    "--out", path.join(projDir, "content", "evil"), "--json",
  ]);
  expect(res2.code).toBe(1);

  // A symlink planted in the Project that resolves onto a retained input.
  await symlink(path.join(projDir, "ply.json"), path.join(projDir, "alias.json"));
  const res3 = await invoke([
    "composition", "render", "guarded", "--project", projDir, "--out", path.join(projDir, "alias.json"), "--json",
  ]);
  expect(res3.code).toBe(1);
  expect(await readFile(path.join(projDir, "ply.json"), "utf8")).toBe(manifestBefore);
});

test("--out refuses when the parent directory does not exist", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(32, 32, RED));
  await makeComposition("nofdir", 32, 32, [{ local: "bg", file: img }]);
  const res = await invoke([
    "composition", "render", "nofdir", "--project", projDir,
    "--out", path.join(tempDir, "missing-dir", "out.png"), "--json",
  ]);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).ok).toBe(false);
});

test("help documents the render command and its options", async () => {
  const res = await invoke(["composition", "--help"]);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("render");
  expect(res.stdout).toContain("--out");

  const usage = await invoke(["composition", "render", "--project", projDir, "--json"]);
  expect(usage.code).toBe(2);
  expect(JSON.parse(usage.stdout).ok).toBe(false);
});

test("the default render output never collides across repeated renders", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(32, 32, RED));
  await makeComposition("repeat", 32, 32, [{ local: "bg", file: img }]);
  const first = await invoke(["composition", "render", "repeat", "--project", projDir, "--json"]);
  const second = await invoke(["composition", "render", "repeat", "--project", projDir, "--json"]);
  expect(first.code).toBe(0);
  expect(second.code).toBe(0);
  const outputs = (await readdir(path.join(projDir, "renders"))).filter((f) => f.endsWith(".png"));
  expect(outputs).toHaveLength(2);
  expect(JSON.parse(first.stdout).render.output).not.toBe(JSON.parse(second.stdout).render.output);
});

test("--out may export a brand-new file directly under the Project's renders/", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(32, 32, RED));
  await makeComposition("inproj", 32, 32, [{ local: "bg", file: img }]);
  const out = path.join(projDir, "renders", "poster.png");
  const res = await invoke(["composition", "render", "inproj", "--project", projDir, "--out", out, "--json"]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.render.output).toBe(out);
  expect(readPngHeader(await readFile(out)).width).toBe(32);
  // An in-Project export must never overwrite an existing render.
  const again = await invoke(["composition", "render", "inproj", "--project", projDir, "--out", out, "--json"]);
  expect(again.code).toBe(1);
  expect(JSON.parse(again.stdout).ok).toBe(false);
});

test("--out protects reserved Project storage and permits fresh exports elsewhere in the Project", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(32, 32, RED));
  await makeComposition("guarded2", 32, 32, [{ local: "bg", file: img }]);
  const manifestBefore = await readFile(path.join(projDir, "ply.json"), "utf8");

  // Fresh paths under reserved storage are refused: manifest, lock, and the
  // canonical compositions/layers/content directories.
  for (const out of [
    path.join(projDir, "compositions", "guarded2.json"),
    path.join(projDir, "layers", "evil.json"),
    path.join(projDir, "content", "evil"),
  ]) {
    const res = await invoke(["composition", "render", "guarded2", "--project", projDir, "--out", out, "--json"]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).ok).toBe(false);
  }
  // An --out naming an existing path (the renders/ directory itself) is refused.
  const dirRes = await invoke([
    "composition", "render", "guarded2", "--project", projDir, "--out", path.join(projDir, "renders"), "--json",
  ]);
  expect(dirRes.code).toBe(1);
  expect(await readFile(path.join(projDir, "ply.json"), "utf8")).toBe(manifestBefore);

  // Fresh paths with existing parents elsewhere in the Project are safe:
  // the root and non-reserved directories are not protected storage.
  const rootOut = path.join(projDir, "poster.png");
  const rootRes = await invoke(["composition", "render", "guarded2", "--project", projDir, "--out", rootOut, "--json"]);
  expect(rootRes.code).toBe(0);
  expect(readPngHeader(await readFile(rootOut)).width).toBe(32);
});

test("--out permits fresh nested and sibling in-Project exports with existing parents", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(32, 32, RED));
  await makeComposition("sibling", 32, 32, [{ local: "bg", file: img }]);

  await mkdir(path.join(projDir, "renders", "social"), { recursive: true });
  await mkdir(path.join(projDir, "exports"), { recursive: true });

  const nested = path.join(projDir, "renders", "social", "poster.png");
  const nestedRes = await invoke(["composition", "render", "sibling", "--project", projDir, "--out", nested, "--json"]);
  expect(nestedRes.code).toBe(0);
  expect(JSON.parse(nestedRes.stdout).render.output).toBe(nested);
  expect(readPngHeader(await readFile(nested)).width).toBe(32);

  const sibling = path.join(projDir, "exports", "poster.png");
  const sibRes = await invoke(["composition", "render", "sibling", "--project", projDir, "--out", sibling, "--json"]);
  expect(sibRes.code).toBe(0);
  expect(JSON.parse(sibRes.stdout).render.output).toBe(sibling);
  expect(readPngHeader(await readFile(sibling)).width).toBe(32);
});

test("--out replaces the destination entry and never writes through an external hardlink to Project state", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(32, 32, RED));
  await makeComposition("hardlink", 32, 32, [{ local: "bg", file: img }]);
  const manifestBefore = await readFile(path.join(projDir, "ply.json"), "utf8");

  const exportDir = path.join(tempDir, "export-dir");
  await mkdir(exportDir, { recursive: true });
  const linked = path.join(exportDir, "linked.png");
  await link(path.join(projDir, "ply.json"), linked);

  const res = await invoke(["composition", "render", "hardlink", "--project", projDir, "--out", linked, "--json"]);
  expect(res.code).toBe(0);

  // The manifest's other hardlink keeps its exact original bytes: the export
  // replaced the destination entry, it did not write through the shared inode.
  expect(await readFile(path.join(projDir, "ply.json"), "utf8")).toBe(manifestBefore);
  // The caller-chosen entry now holds the rendered PNG.
  const exported = await readFile(linked);
  expect(readPngHeader(exported).width).toBe(32);
});

test.each(["exports", "..exports"])("concurrent renders racing the same fresh in-Project --out under %s publish exactly one output", async (directory) => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(32, 32, RED));
  await makeComposition("race", 32, 32, [{ local: "bg", file: img }]);
  await mkdir(path.join(projDir, directory), { recursive: true });

  const out = path.join(projDir, directory, "race.png");
  const [a, b] = await Promise.all([
    invoke(["composition", "render", "race", "--project", projDir, "--out", out, "--json"]),
    invoke(["composition", "render", "race", "--project", projDir, "--out", out, "--json"]),
  ]);

  // Exactly one wins; the loser refuses to replace the winner's output.
  expect([a.code, b.code].sort()).toEqual([0, 1]);
  expect([JSON.parse(a.stdout).ok, JSON.parse(b.stdout).ok].sort()).toEqual([false, true]);
  // The surviving entry is the winning render, intact.
  expect(readPngHeader(await readFile(out)).width).toBe(32);
});

test("--out protects existing retained files under ..exports including symlink aliases", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(32, 32, RED));
  await makeComposition("retained", 32, 32, [{ local: "bg", file: img }]);
  const directory = path.join(projDir, "..exports");
  await mkdir(directory);
  const retained = path.join(directory, "poster.png");
  const original = solidPng(16, 16, BLUE);
  await writeFile(retained, original);
  const alias = path.join(tempDir, "alias.png");
  await symlink(retained, alias);

  for (const out of [retained, alias]) {
    const result = await invoke(["composition", "render", "retained", "--project", projDir, "--out", out, "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).ok).toBe(false);
    expect(result.stdout).toContain("existing Project state and retained inputs");
    expect<Buffer>(await readFile(retained)).toEqual(original);
    expect<Buffer>(await readFile(alias)).toEqual(original);
  }
  expect(await readdir(directory)).toEqual(["poster.png"]);
});
