/**
 * Local text Layers through the uniform Layer contract (#81, spec #77
 * US-002 / US-006 / US-008): add and inspect text beside image content with
 * the same identity/revision/use lifecycle, render mixed Compositions from
 * Project-retained bundled font bytes with real fallback rejection, and stay
 * usable after Project relocation. Every assertion runs through the public
 * CLI against temporary Projects and produced PNGs, not private mutation.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, readdir, writeFile, rename, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { encodePngRgba, readPngHeader, decodePng } from "../src/png.js";
import { computeRevisionHash, LAYER_SCHEMA_VERSION } from "../src/layer.js";
import type { LayerTextRevision } from "../src/layer.js";

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

const GREEN: [number, number, number, number] = [0, 255, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];

/** Pixel (x, y) of a decoded RGBA PNG as [r, g, b, a]. */
function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

const close = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

/** Count pixels in a region within tolerance of an RGBA color. */
function countNear(png: ReturnType<typeof decodePng>, rgba: [number, number, number, number], tol = 12): number {
  let n = 0;
  for (let i = 0; i < png.rgba.length; i += 4) {
    if (
      Math.abs(png.rgba[i]! - rgba[0]) <= tol &&
      Math.abs(png.rgba[i + 1]! - rgba[1]) <= tol &&
      Math.abs(png.rgba[i + 2]! - rgba[2]) <= tol &&
      Math.abs(png.rgba[i + 3]! - rgba[3]) <= tol
    ) {
      n++;
    }
  }
  return n;
}

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-comp-text-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "text-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComposition(name: string, width: number, height: number) {
  const res = await invoke([
    "composition", "create", name, "--width", String(width), "--height", String(height), "--project", projDir,
  ]);
  expect(res.code).toBe(0);
}

async function addText(name: string, local: string, opts: {
  text: string;
  font?: string;
  fontSize?: number;
  color?: string;
  x?: number;
  y?: number;
  opacity?: number;
}) {
  const args = ["composition", "add", name, local, "--text", opts.text, "--font", opts.font ?? "Anton", "--project", projDir, "--json"];
  if (opts.fontSize !== undefined) args.push("--font-size", String(opts.fontSize));
  if (opts.color !== undefined) args.push("--color", opts.color);
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  if (opts.opacity !== undefined) args.push("--opacity", String(opts.opacity));
  return invoke(args);
}

async function addImage(name: string, local: string, file: string, opts: { x?: number; y?: number; opacity?: number } = {}) {
  const args = ["composition", "add", name, local, "--image", file, "--project", projDir, "--json"];
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  if (opts.opacity !== undefined) args.push("--opacity", String(opts.opacity));
  return invoke(args);
}

/** The text revision document for a Layer, re-read from Project storage. */
async function readStoredTextRevision(layerId: string): Promise<{ revision: LayerTextRevision; revHash: string; identity: unknown }> {
  const identity = JSON.parse(await readFile(path.join(projDir, "layers", `${layerId}.json`), "utf8"));
  const revHash = identity.currentRevision as string;
  const revision = JSON.parse(
    await readFile(path.join(projDir, "layers", `${layerId}.revisions`, `${revHash}.json`), "utf8"),
  );
  return { revision, revHash, identity };
}

test("add and inspect a text Layer with the same identity/revision/use contracts as an image Layer", async () => {
  await makeComposition("poster", 400, 300);
  const res = await addText("poster", "title", { text: "Ply", fontSize: 96, color: "#ff0000" });
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(true);
  const layerId = json.use.layerId as string;
  expect(layerId).toMatch(/^layer_[a-zA-Z0-9_]+$/);

  // Layer inspect: same identity/currentRevision shape as image Layers, with
  // text content facts and no font-buffer exposure.
  const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(inspect.code).toBe(0);
  const layerJson = JSON.parse(inspect.stdout);
  expect(layerJson.ok).toBe(true);
  expect(layerJson.layer.id).toBe(layerId);
  expect(layerJson.layer.currentRevisionId).toBe(layerJson.layer.currentRevision.revisionId);
  const rev = layerJson.layer.currentRevision;
  expect(rev.kind).toBe("text");
  expect(rev.text).toBe("Ply");
  expect(rev.fontSize).toBe(96);
  expect(rev.color).toBe("#ff0000");
  expect(rev.x).toBe(0);
  expect(rev.y).toBe(0);
  expect(rev.opacity).toBe(1);
  expect(Object.values(rev).join(" ")).not.toMatch(/base64|font\/ttf/);
  expect(JSON.stringify(layerJson)).not.toContain("data:font");

  // Same Composition use contract: { name, layerId }.
  const comp = await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"]);
  const compJson = JSON.parse(comp.stdout);
  expect(compJson.composition.layers).toEqual([
    { name: "title", layerId, kind: "text", revision: expect.objectContaining({ kind: "text" }) },
  ]);

  // Defaults: fontSize 48, color #ffffff when omitted.
  await addText("poster", "subtitle", { text: "sub" });
  const inspect2 = JSON.parse(
    (await invoke(["layer", "inspect", (JSON.parse((await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"])).stdout)).composition.layers[1].layerId, "--project", projDir, "--json"])).stdout,
  );
  expect(inspect2.layer.currentRevision.fontSize).toBe(48);
  expect(inspect2.layer.currentRevision.color).toBe("#ffffff");

  // Compact default output is one actionable line.
  const compact = await invoke(["composition", "add", "poster", "third", "--text", "t", "--font", "Anton", "--project", projDir]);
  expect(compact.code).toBe(0);
  expect(compact.stdout.trim().split("\n")).toHaveLength(1);
});

test("text revision pins the retained font bytes in Project content storage", async () => {
  await makeComposition("pinned", 200, 200);
  const res = await addText("pinned", "t", { text: "pinned" });
  const layerId = JSON.parse(res.stdout).use.layerId as string;
  const { revision, revHash } = await readStoredTextRevision(layerId);
  expect(revision.kind).toBe("text");
  expect(revision.contentHash).toMatch(/^[0-9a-f]{64}$/);
  // The revision document re-hashes to the identity's current pointer.
  expect(computeRevisionHash({ ...revision, schemaVersion: LAYER_SCHEMA_VERSION, layerId, createdAt: revision.createdAt })).toBe(revHash);
  // The retained blob exists in the Project and hashes to contentHash.
  const blob = await readFile(path.join(projDir, "content", revision.contentHash));
  expect(createHash("sha256").update(blob).digest("hex")).toBe(revision.contentHash);
  // The blob is real TrueType data retained under the Project (movable).
  expect(blob.length).toBeGreaterThan(1000);
});

test("renders a mixed image/text Composition with order, position, and opacity", async () => {
  const back = path.join(tempDir, "green.png");
  await writeFile(back, solidPng(400, 150, GREEN));
  const front = path.join(tempDir, "blue.png");
  await writeFile(front, solidPng(200, 100, BLUE));

  await makeComposition("mixed", 400, 300);
  expect((await addImage("mixed", "bg", back, { x: 0, y: 0 })).code).toBe(0);
  expect((await addText("mixed", "title", { text: "Ply", fontSize: 120, color: "#ff0000", x: 20, y: 20 })).code).toBe(0);
  expect((await addText("mixed", "ghost", { text: "ghost", fontSize: 80, color: "#0000ff", x: 0, y: 220, opacity: 0 })).code).toBe(0);

  // Prove the title actually painted a solid glyph pixel before the overlay:
  // a text-only twin of the same layers must show exact #ff0000 at some
  // coordinate, which the later image is then placed over.
  await makeComposition("under", 400, 300);
  expect((await addImage("under", "bg", back, { x: 0, y: 0 })).code).toBe(0);
  expect((await addText("under", "title", { text: "Ply", fontSize: 120, color: "#ff0000", x: 20, y: 20 })).code).toBe(0);
  const under = JSON.parse((await invoke(["composition", "render", "under", "--project", projDir, "--json"])).stdout);
  const underPng = decodePng(await readFile(under.render.output));
  let glyph: { x: number; y: number } | undefined;
  for (let y = 20; y < 140 && !glyph; y++) {
    for (let x = 20; x < 300 && !glyph; x++) {
      const p = pixel(underPng, x, y)!;
      if (p[0] === 255 && p[1] === 0 && p[2] === 0 && p[3] === 255) {
        glyph = { x, y };
      }
    }
  }
  expect(glyph).toBeDefined();

  // A later image Layer paints over actual glyph pixels: position it so it
  // covers the proven glyph coordinate, then verify the covered pixel is
  // image color, not text color.
  const frontX = Math.max(0, glyph!.x - 80);
  const frontY = Math.max(0, glyph!.y - 50);
  expect((await addImage("mixed", "front", front, { x: frontX, y: frontY })).code).toBe(0);

  const res = await invoke(["composition", "render", "mixed", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  const pngBytes = await readFile(json.render.output);
  const header = readPngHeader(pngBytes);
  expect(header.width).toBe(400);
  expect(header.height).toBe(300);
  const d = decodePng(pngBytes);

  // Image under text: green where nothing else painted.
  expect(pixel(d, 380, 140).every((v, i) => close(v, GREEN[i]!))).toBe(true);

  // Text glyphs painted at position in the text color: enough near-pure
  // #ff0000 pixels exist in the title area (font actually loaded and drew).
  let redInTitle = 0;
  for (let y = 20; y < 140; y++) {
    for (let x = 20; x < 300; x++) {
      const p = pixel(d, x, y)!;
      if (close(p[0]!, 255, 40) && p[1]! < 40 && p[2]! < 40 && p[3]! === 255) redInTitle++;
    }
  }
  expect(redInTitle).toBeGreaterThan(200);

  // Later image paints over the proven glyph pixel: exact image color, not
  // text color (same title layout as "under", so the coordinate matches).
  expect(pixel(d, glyph!.x, glyph!.y)!.every((v, i) => close(v, BLUE[i]!))).toBe(true);
  // The image also covers canvas where no text ever was.
  expect(pixel(d, Math.min(frontX + 190, 399), Math.min(frontY + 90, 299))!.every((v, i) => close(v, BLUE[i]!))).toBe(true);

  // Opacity 0 text paints nothing: the ghost area stays transparent.
  expect(pixel(d, 30, 250)![3]!).toBe(0);
});

test("default compact add output for text is compact, and JSON success carries the use", async () => {
  await makeComposition("surface", 200, 200);
  const res = await invoke(["composition", "add", "surface", "t", "--text", "hi", "--font", "Anton", "--project", projDir]);
  expect(res.code).toBe(0);
  const lines = res.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("t");
  expect(lines[0]).toContain("surface");

  const jsonRes = await addText("surface", "t2", { text: "hi", color: "#123456", fontSize: 24 });
  const json = JSON.parse(jsonRes.stdout);
  expect(json.ok).toBe(true);
  expect(json.layer.currentRevision.fontSize).toBe(24);
  expect(json.layer.currentRevision.color).toBe("#123456");
});

test("rejects an unknown font family at add, naming bundled families, leaving state unchanged", async () => {
  await makeComposition("fontfail", 200, 200);
  const res = await addText("fontfail", "t", { text: "hi", font: "Comic Sans MS" });
  expect(res.code).toBe(1);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(false);
  expect(json.error).toContain("Comic Sans MS");
  expect(json.error).toContain("Anton");

  const comp = JSON.parse((await invoke(["composition", "inspect", "fontfail", "--project", projDir, "--json"])).stdout);
  expect(comp.composition.layers).toHaveLength(0);
  const layers = JSON.parse((await invoke(["layer", "list", "--project", projDir, "--json"])).stdout);
  expect(layers.layers).toHaveLength(0);
});

test("rejects missing/invalid text arguments through the CLI with JSON errors", async () => {
  await makeComposition("args", 200, 200);
  // --font missing with --text: usage error.
  const noFont = await invoke(["composition", "add", "args", "t", "--text", "hi", "--project", projDir, "--json"]);
  expect(noFont.code).toBe(2);
  expect(JSON.parse(noFont.stdout).ok).toBe(false);
  // --image and --text together: usage error.
  const both = await invoke(["composition", "add", "args", "t", "--image", "x.png", "--text", "hi", "--font", "Anton", "--project", projDir]);
  expect(both.code).toBe(2);
  // Empty text: runtime rejection.
  const empty = await addText("args", "t", { text: "   " });
  expect(empty.code).toBe(1);
  expect(JSON.parse(empty.stdout).ok).toBe(false);
  // Invalid color: runtime rejection.
  const badColor = await addText("args", "t", { text: "hi", color: "red" });
  expect(badColor.code).toBe(1);
  // Invalid font size: runtime rejection.
  const badSize = await addText("args", "t", { text: "hi", fontSize: 0 });
  expect(badSize.code).toBe(1);
  // Nothing was published.
  const comp = JSON.parse((await invoke(["composition", "inspect", "args", "--project", projDir, "--json"])).stdout);
  expect(comp.composition.layers).toHaveLength(0);
});

test("render rejects an unresolved bundled face at the actual font-load boundary, publishing nothing", async () => {
  // Add a valid text Layer through the CLI, then craft a storage-state
  // fixture whose revision is self-consistent (schema + hashes) but whose
  // retained bytes are not a decodable font. The render must fail at the
  // real font-load/resolution boundary — not at schema or hash validation —
  // and publish no output.
  await makeComposition("fallback", 200, 200);
  const res = await addText("fallback", "t", { text: "hi", fontSize: 64 });
  const layerId = JSON.parse(res.stdout).use.layerId as string;
  const { revision } = await readStoredTextRevision(layerId);

  const garbage = Buffer.from("this is not font data, but it is retained content");
  const garbageHash = createHash("sha256").update(garbage).digest("hex");
  await writeFile(path.join(projDir, "content", garbageHash), garbage);

  const crafted: LayerTextRevision = {
    schemaVersion: LAYER_SCHEMA_VERSION,
    layerId,
    createdAt: revision.createdAt,
    kind: "text",
    contentHash: garbageHash,
    text: revision.text,
    fontSize: revision.fontSize,
    color: revision.color,
    x: revision.x,
    y: revision.y,
    opacity: revision.opacity,
  };
  const craftedHash = computeRevisionHash(crafted);
  await writeFile(
    path.join(projDir, "layers", `${layerId}.revisions`, `${craftedHash}.json`),
    JSON.stringify(crafted, null, 2) + "\n",
  );
  const identityFile = path.join(projDir, "layers", `${layerId}.json`);
  const identity = JSON.parse(await readFile(identityFile, "utf8"));
  await writeFile(identityFile, JSON.stringify({ ...identity, currentRevision: craftedHash }, null, 2) + "\n");

  // The crafted state resolves cleanly through inspection (schema and hashes
  // are valid) — only the actual font load can reject it.
  const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(inspect.code).toBe(0);

  const render = await invoke(["composition", "render", "fallback", "--project", projDir, "--json"]);
  expect(render.code).toBe(1);
  const renderJson = JSON.parse(render.stdout);
  expect(renderJson.ok).toBe(false);
  expect(renderJson.error).toMatch(/font/i);
  const outputs = await readdir(path.join(projDir, "renders")).catch(() => []);
  expect(outputs.filter((f) => f.endsWith(".png"))).toHaveLength(0);
});

test("render rejects corrupted or missing retained font bytes loudly", async () => {
  await makeComposition("corrupt", 200, 200);
  const res = await addText("corrupt", "t", { text: "hi" });
  const layerId = JSON.parse(res.stdout).use.layerId as string;
  const { revision } = await readStoredTextRevision(layerId);
  const blobPath = path.join(projDir, "content", revision.contentHash);
  await writeFile(blobPath, Buffer.from("corrupted bytes that no longer hash to the content identity"));

  const render = await invoke(["composition", "render", "corrupt", "--project", projDir, "--json"]);
  expect(render.code).toBe(1);
  expect(JSON.parse(render.stdout).ok).toBe(false);
  expect(JSON.parse(render.stdout).error).toMatch(/corrupt|hash/i);

  await rm(blobPath);
  const missing = await invoke(["composition", "render", "corrupt", "--project", projDir, "--json"]);
  expect(missing.code).toBe(1);
  expect(JSON.parse(missing.stdout).ok).toBe(false);
});

test("text Layers inspect, list, and render after Project relocation", async () => {
  const back = path.join(tempDir, "green.png");
  await writeFile(back, solidPng(200, 200, GREEN));
  await makeComposition("moved", 200, 200);
  expect((await addImage("moved", "bg", back)).code).toBe(0);
  expect((await addText("moved", "title", { text: "Ply", fontSize: 72, color: "#ffffff" })).code).toBe(0);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "moved", "--project", projDir, "--json"])).stdout,
  ).composition.layers[1].layerId;

  const movedDir = path.join(tempDir, "relocated", "moved-project");
  await mkdir(path.dirname(movedDir), { recursive: true });
  await rename(projDir, movedDir);

  const inspect = await invoke(["layer", "inspect", layerId, "--project", movedDir, "--json"]);
  expect(inspect.code).toBe(0);
  expect(JSON.parse(inspect.stdout).layer.currentRevision.kind).toBe("text");

  const render = await invoke(["composition", "render", "moved", "--project", movedDir, "--json"]);
  expect(render.code).toBe(0);
  const pngBytes = await readFile(JSON.parse(render.stdout).render.output);
  const d = decodePng(pngBytes);
  expect(pixel(d, 5, 5).every((v, i) => close(v, GREEN[i]!))).toBe(true);
  // The text drew from Project-retained bytes, not the original install:
  // near-white glyph pixels appear over the green image.
  expect(countNear(d, WHITE, 40)).toBeGreaterThan(100);
});

test("help documents the text surface and --json failures stay valid JSON", async () => {
  const help = await invoke(["composition", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("--text");
  expect(help.stdout).toContain("--font");
  expect(help.stdout).toContain("--font-size");
  expect(help.stdout).toContain("--color");

  const missingComp = await invoke(["composition", "add", "nope", "t", "--text", "hi", "--font", "Anton", "--project", projDir, "--json"]);
  expect(missingComp.code).toBe(1);
  const parsed = JSON.parse(missingComp.stdout);
  expect(parsed.ok).toBe(false);
  expect(typeof parsed.error).toBe("string");
});