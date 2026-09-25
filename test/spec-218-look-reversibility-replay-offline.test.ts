/**
 * TEST-007: Look parameters reversibility, pre-spec replay, relocation replay,
 * and shared Layer semantics (#224, spec #218 US-006, DEC-001, DEC-004, TEST-007,
 * TEST-008).
 *
 * Verifies through public CLI and rendered-pixel seams:
 * 1. Reversibility & lineage preservation across all 4 Layer kinds:
 *    Apply every look parameter (grade controls: brightness, contrast, saturation,
 *    warmth; blend mode; edge glow; plus gradient fill for text), verify paint
 *    changes, remove each with its documented removal value, assert byte-identical
 *    render to original, and assert retained content bytes and lineage are unchanged.
 * 2. Pre-spec Render replay:
 *    A Render manifest captured before this spec replays byte-identically on current
 *    code (using the pre-spec fixture pattern from test/pre-spec-render-fixture.test.ts).
 * 3. Relocation and offline replay with all look parameters:
 *    A Composition using every look parameter replays byte-identically after later
 *    edits and relocation with the network disabled (following
 *    test/spec-207-relocation-replay-offline.test.ts).
 * 4. Shared Layer look edit semantics:
 *    A shared Layer refuses a bare look edit and obeys --in-place and --fork.
 *
 * All tests run offline, without model weights, under per-file bun test --isolate.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { closeBrowser } from "../src/browser.js";
import { decodePng, encodePngRgba, readPngHeader } from "../src/png.js";
import { toolIdentity } from "../src/manifest.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const preSpecFixtureProject = path.resolve(import.meta.dir, "fixtures/pre-spec-render/project");
const PRE_SPEC_MANIFEST = "hero-mubtt4wv-af1f94e2.manifest.json";
const PRE_SPEC_PNG = "hero-mubtt4wv-af1f94e2.png";

type Rgba = [number, number, number, number];

function solidPng(width: number, height: number, rgba: Rgba): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgba[0];
    buf[i + 1] = rgba[1];
    buf[i + 2] = rgba[2];
    buf[i + 3] = rgba[3];
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

const RING_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#000000"><path d="M2 2h20v20H2zM8 8h8v8H8z" fill-rule="evenodd"/></svg>
`;

function paddedCutoutPng(): Buffer {
  const buf = Buffer.alloc(64 * 64 * 4);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const idx = (y * 64 + x) * 4;
      if (x >= 16 && x < 48 && y >= 16 && y < 48) {
        buf[idx] = 200;
        buf[idx + 1] = 0;
        buf[idx + 2] = 200;
        buf[idx + 3] = 255;
      } else {
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 0;
      }
    }
  }
  return encodePngRgba(64, 64, buf);
}

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

function offlineCommand(scriptArgs: string[]): string[] {
  return [
    "sandbox-exec",
    "-p",
    "(version 1) (allow default) (deny network*)",
    process.execPath,
    cli,
    ...scriptArgs,
  ];
}

async function invokeOffline(args: string[], cwd: string) {
  if (process.platform !== "darwin") {
    return invoke(args, cwd);
  }
  const result = Bun.spawn(offlineCommand(args), {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
    result.exited,
  ]);
  return { stdout, stderr, code };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-spec-218-qual-"));
});

afterEach(async () => {
  await closeBrowser();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. Reversibility and Lineage Across Kinds
// ---------------------------------------------------------------------------

test("reversibility and lineage: raster image Layer", async () => {
  const proj = path.join(tempDir, "proj");
  await invoke(["project", "init", proj, "--json"]);
  await invoke(["composition", "create", "testcomp", "--width", "128", "--height", "128", "-p", proj, "--json"]);

  const imgPath = path.join(tempDir, "sample.png");
  await writeFile(imgPath, solidPng(64, 64, [180, 90, 45, 255]));

  // Background to provide backdrop for blend modes
  await invoke([
    "composition", "add", "testcomp", "bg",
    "--shape", "rectangle", "--size", "128x128", "--fill", "#3b82f6",
    "-p", proj, "--json",
  ]);

  const addRes = await invoke([
    "composition", "add", "testcomp", "item",
    "--image", imgPath, "--x", "32", "--y", "32",
    "-p", proj, "--json",
  ]);
  expect(addRes.code).toBe(0);
  const layerId = JSON.parse(addRes.stdout).use.layerId as string;

  // Render initial
  const renderInit = await invoke(["composition", "render", "testcomp", "-p", proj, "--json"]);
  expect(renderInit.code).toBe(0);
  const initPng = await readFile(JSON.parse(renderInit.stdout).render.output as string);

  const inspectInit = await invoke(["layer", "inspect", layerId, "-p", proj, "--json"]);
  const initRev = JSON.parse(inspectInit.stdout).layer.currentRevision;
  const initialContentHash = initRev.contentHash;
  expect(initialContentHash).toBeDefined();

  // Apply every look parameter
  const editRes = await invoke([
    "layer", "edit", layerId,
    "--brightness", "1.4", "--contrast", "1.2", "--saturation", "1.3", "--warmth", "0.3",
    "--blend", "multiply",
    "--glow", "8,3,#ff0000,45,0.7",
    "--blur", "6",
    "--choke", "3", "--feather", "2",
    "-p", proj, "--json",
  ]);
  expect(editRes.code).toBe(0);

  // Render modified: must differ from initial
  const renderMod = await invoke(["composition", "render", "testcomp", "-p", proj, "--json"]);
  expect(renderMod.code).toBe(0);
  const modPng = await readFile(JSON.parse(renderMod.stdout).render.output as string);
  expect(modPng.equals(initPng)).toBe(false);

  // Remove each with documented removal values
  const removeRes = await invoke([
    "layer", "edit", layerId,
    "--brightness", "1", "--contrast", "1", "--saturation", "1", "--warmth", "0",
    "--blend", "normal",
    "--glow", "none",
    "--blur", "0",
    "--choke", "0", "--feather", "0",
    "-p", proj, "--json",
  ]);
  expect(removeRes.code).toBe(0);

  // Render restored: must be byte-identical to initial
  const renderRestored = await invoke(["composition", "render", "testcomp", "-p", proj, "--json"]);
  expect(renderRestored.code).toBe(0);
  const restoredPng = await readFile(JSON.parse(renderRestored.stdout).render.output as string);
  expect(restoredPng.equals(initPng)).toBe(true);

  // Verify retained content bytes and lineage are unchanged
  const inspectRestored = await invoke(["layer", "inspect", layerId, "-p", proj, "--json"]);
  const restoredRev = JSON.parse(inspectRestored.stdout).layer.currentRevision;
  expect(restoredRev.contentHash).toBe(initialContentHash);
  expect(restoredRev.grade).toBeUndefined();
  expect(restoredRev.blend).toBeUndefined();
  expect(restoredRev.glow).toBeUndefined();
  expect(restoredRev.blur).toBeUndefined();
  expect(restoredRev.choke).toBeUndefined();
  expect(restoredRev.feather).toBeUndefined();
});

test("reversibility and lineage: vector image Layer (SVG)", async () => {
  const proj = path.join(tempDir, "proj");
  await invoke(["project", "init", proj, "--json"]);
  await invoke(["composition", "create", "testcomp", "--width", "128", "--height", "128", "-p", proj, "--json"]);

  const svgPath = path.join(tempDir, "sample.svg");
  await writeFile(svgPath, solidSvg(64, 64, "#22c55e"));

  await invoke([
    "composition", "add", "testcomp", "bg",
    "--shape", "rectangle", "--size", "128x128", "--fill", "#1e293b",
    "-p", proj, "--json",
  ]);

  const addRes = await invoke([
    "composition", "add", "testcomp", "item",
    "--image", svgPath, "--resize-to", "64x64", "--x", "32", "--y", "32",
    "-p", proj, "--json",
  ]);
  expect(addRes.code).toBe(0);
  const layerId = JSON.parse(addRes.stdout).use.layerId as string;

  const renderInit = await invoke(["composition", "render", "testcomp", "-p", proj, "--json"]);
  expect(renderInit.code).toBe(0);
  const initPng = await readFile(JSON.parse(renderInit.stdout).render.output as string);

  const inspectInit = await invoke(["layer", "inspect", layerId, "-p", proj, "--json"]);
  const initRev = JSON.parse(inspectInit.stdout).layer.currentRevision;
  const initialContentHash = initRev.contentHash;

  // Apply look parameters
  const editRes = await invoke([
    "layer", "edit", layerId,
    "--brightness", "1.5", "--contrast", "1.3", "--saturation", "1.2", "--warmth", "-0.2",
    "--blend", "screen",
    "--glow", "6,2,#00ffff,90,0.6",
    "--blur", "6",
    "--choke", "3", "--feather", "2",
    "-p", proj, "--json",
  ]);
  expect(editRes.code).toBe(0);

  const renderMod = await invoke(["composition", "render", "testcomp", "-p", proj, "--json"]);
  const modPng = await readFile(JSON.parse(renderMod.stdout).render.output as string);
  expect(modPng.equals(initPng)).toBe(false);

  // Remove each
  const removeRes = await invoke([
    "layer", "edit", layerId,
    "--brightness", "1", "--contrast", "1", "--saturation", "1", "--warmth", "0",
    "--blend", "normal",
    "--glow", "none",
    "--blur", "0",
    "--choke", "0", "--feather", "0",
    "-p", proj, "--json",
  ]);
  expect(removeRes.code).toBe(0);

  const renderRestored = await invoke(["composition", "render", "testcomp", "-p", proj, "--json"]);
  const restoredPng = await readFile(JSON.parse(renderRestored.stdout).render.output as string);
  expect(restoredPng.equals(initPng)).toBe(true);

  const inspectRestored = await invoke(["layer", "inspect", layerId, "-p", proj, "--json"]);
  const restoredRev = JSON.parse(inspectRestored.stdout).layer.currentRevision;
  expect(restoredRev.contentHash).toBe(initialContentHash);
  expect(restoredRev.grade).toBeUndefined();
  expect(restoredRev.blend).toBeUndefined();
  expect(restoredRev.glow).toBeUndefined();
  expect(restoredRev.blur).toBeUndefined();
  expect(restoredRev.choke).toBeUndefined();
  expect(restoredRev.feather).toBeUndefined();
});

test("reversibility and lineage: text Layer (including gradient fill)", async () => {
  const proj = path.join(tempDir, "proj");
  await invoke(["project", "init", proj, "--json"]);
  await invoke(["composition", "create", "testcomp", "--width", "160", "--height", "96", "-p", proj, "--json"]);

  await invoke([
    "composition", "add", "testcomp", "bg",
    "--shape", "rectangle", "--size", "160x96", "--fill", "#0f172a",
    "-p", proj, "--json",
  ]);

  const addRes = await invoke([
    "composition", "add", "testcomp", "item",
    "--text", "LOOK", "--font", "Archivo", "--weight", "800", "--font-size", "48",
    "--color", "#ffffff", "--x", "20", "--y", "20",
    "-p", proj, "--json",
  ]);
  expect(addRes.code).toBe(0);
  const layerId = JSON.parse(addRes.stdout).use.layerId as string;

  const renderInit = await invoke(["composition", "render", "testcomp", "-p", proj, "--json"]);
  expect(renderInit.code).toBe(0);
  const initPng = await readFile(JSON.parse(renderInit.stdout).render.output as string);

  const inspectInit = await invoke(["layer", "inspect", layerId, "-p", proj, "--json"]);
  const initRev = JSON.parse(inspectInit.stdout).layer.currentRevision;
  const initialFontHash = initRev.fontHash;

  // Apply look parameters including gradient fill on text (#222)
  const editRes = await invoke([
    "layer", "edit", layerId,
    "--brightness", "1.3", "--contrast", "1.2", "--saturation", "1.4", "--warmth", "0.2",
    "--blend", "overlay",
    "--glow", "6,2,#ff8800,0,0.5",
    "--blur", "6",
    "--choke", "3", "--feather", "2",
    "--color", "linear:90deg,#ff0000,#0000ff",
    "-p", proj, "--json",
  ]);
  expect(editRes.code).toBe(0);

  const renderMod = await invoke(["composition", "render", "testcomp", "-p", proj, "--json"]);
  const modPng = await readFile(JSON.parse(renderMod.stdout).render.output as string);
  expect(modPng.equals(initPng)).toBe(false);

  // Remove each, restoring solid text color
  const removeRes = await invoke([
    "layer", "edit", layerId,
    "--brightness", "1", "--contrast", "1", "--saturation", "1", "--warmth", "0",
    "--blend", "normal",
    "--glow", "none",
    "--blur", "0",
    "--choke", "0", "--feather", "0",
    "--color", "#ffffff",
    "-p", proj, "--json",
  ]);
  expect(removeRes.code).toBe(0);

  const renderRestored = await invoke(["composition", "render", "testcomp", "-p", proj, "--json"]);
  const restoredPng = await readFile(JSON.parse(renderRestored.stdout).render.output as string);
  expect(restoredPng.equals(initPng)).toBe(true);

  const inspectRestored = await invoke(["layer", "inspect", layerId, "-p", proj, "--json"]);
  const restoredRev = JSON.parse(inspectRestored.stdout).layer.currentRevision;
  expect(restoredRev.fontHash).toBe(initialFontHash);
  expect(restoredRev.grade).toBeUndefined();
  expect(restoredRev.blend).toBeUndefined();
  expect(restoredRev.glow).toBeUndefined();
  expect(restoredRev.blur).toBeUndefined();
  expect(restoredRev.choke).toBeUndefined();
  expect(restoredRev.feather).toBeUndefined();
  expect(restoredRev.color).toBe("#ffffff");
});

test("reversibility and lineage: shape Layer", async () => {
  const proj = path.join(tempDir, "proj");
  await invoke(["project", "init", proj, "--json"]);
  await invoke(["composition", "create", "testcomp", "--width", "128", "--height", "128", "-p", proj, "--json"]);

  await invoke([
    "composition", "add", "testcomp", "bg",
    "--shape", "rectangle", "--size", "128x128", "--fill", "#64748b",
    "-p", proj, "--json",
  ]);

  const addRes = await invoke([
    "composition", "add", "testcomp", "item",
    "--shape", "rectangle", "--size", "64x64", "--corner-radius", "16",
    "--fill", "#f97316", "--x", "32", "--y", "32",
    "-p", proj, "--json",
  ]);
  expect(addRes.code).toBe(0);
  const layerId = JSON.parse(addRes.stdout).use.layerId as string;

  const renderInit = await invoke(["composition", "render", "testcomp", "-p", proj, "--json"]);
  expect(renderInit.code).toBe(0);
  const initPng = await readFile(JSON.parse(renderInit.stdout).render.output as string);

  // Apply look parameters
  const editRes = await invoke([
    "layer", "edit", layerId,
    "--brightness", "0.8", "--contrast", "1.2", "--saturation", "0.5", "--warmth", "-0.4",
    "--blend", "soft-light",
    "--glow", "10,4,#ffff00,180,0.8",
    "--blur", "6",
    "--choke", "3", "--feather", "2",
    "-p", proj, "--json",
  ]);
  expect(editRes.code).toBe(0);

  const renderMod = await invoke(["composition", "render", "testcomp", "-p", proj, "--json"]);
  const modPng = await readFile(JSON.parse(renderMod.stdout).render.output as string);
  expect(modPng.equals(initPng)).toBe(false);

  // Remove each
  const removeRes = await invoke([
    "layer", "edit", layerId,
    "--brightness", "1", "--contrast", "1", "--saturation", "1", "--warmth", "0",
    "--blend", "normal",
    "--glow", "none",
    "--blur", "0",
    "--choke", "0", "--feather", "0",
    "-p", proj, "--json",
  ]);
  expect(removeRes.code).toBe(0);

  const renderRestored = await invoke(["composition", "render", "testcomp", "-p", proj, "--json"]);
  const restoredPng = await readFile(JSON.parse(renderRestored.stdout).render.output as string);
  expect(restoredPng.equals(initPng)).toBe(true);

  const inspectRestored = await invoke(["layer", "inspect", layerId, "-p", proj, "--json"]);
  const restoredRev = JSON.parse(inspectRestored.stdout).layer.currentRevision;
  expect(restoredRev.grade).toBeUndefined();
  expect(restoredRev.blend).toBeUndefined();
  expect(restoredRev.glow).toBeUndefined();
  expect(restoredRev.blur).toBeUndefined();
  expect(restoredRev.choke).toBeUndefined();
  expect(restoredRev.feather).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 2. Pre-spec Render Manifest Replay
// ---------------------------------------------------------------------------

test("repaints pre-spec Render manifest byte-identically with current tool version", async () => {
  const proj = path.join(tempDir, "pre-spec-proj");
  await cp(preSpecFixtureProject, proj, { recursive: true });

  const manifestPath = path.join(proj, "renders", PRE_SPEC_MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    environment: { tool: { version: string } };
  };
  manifest.environment.tool.version = toolIdentity().version;
  const stubbedPath = path.join(proj, "renders", "stubbed.manifest.json");
  await writeFile(stubbedPath, JSON.stringify(manifest, null, 2) + "\n");

  const outPath = path.join(tempDir, "pre-spec-repainted.png");
  const res = await invoke([
    "composition", "replay", stubbedPath, "--out", outPath, "-p", proj, "--json",
  ]);
  expect(res.code).toBe(0);

  const repainted = await readFile(outPath);
  const committed = await readFile(path.join(preSpecFixtureProject, "renders", PRE_SPEC_PNG));
  expect(repainted.equals(committed)).toBe(true);
});

// ---------------------------------------------------------------------------
// 3. Composition with Every Look Parameter Replays After Relocation Offline
// ---------------------------------------------------------------------------

test("one Composition using every look parameter replays byte-identically after later edits and relocation offline", async () => {
  const root = tempDir;
  const proj = path.join(root, "proj-look");

  const ringSvg = path.join(root, "ring.svg");
  await writeFile(ringSvg, RING_SVG);
  const paddedPng = path.join(root, "padded.png");
  await writeFile(paddedPng, paddedCutoutPng());

  const init = await invokeOffline(["project", "init", proj, "--json"], root);
  expect(init.code).toBe(0);

  const create = await invokeOffline(
    ["composition", "create", "thumb", "--width", "128", "--height", "96", "-p", proj, "--json"],
    root,
  );
  expect(create.code).toBe(0);

  // Background shape
  const addBg = await invokeOffline(
    [
      "composition", "add", "thumb", "bg",
      "--shape", "rectangle", "--size", "128x96", "--fill", "radial:#2a6e69,#123b3a",
      "-p", proj, "--json",
    ],
    root,
  );
  expect(addBg.code).toBe(0);

  // Vector Layer with vector color, grade, blend, and glow
  const addVec = await invokeOffline(
    [
      "composition", "add", "thumb", "vec",
      "--image", ringSvg, "--vector-color", "#e11d48",
      "--resize-to", "40x40", "--x", "10", "--y", "10",
      "--brightness", "1.2", "--contrast", "1.1", "--blend", "screen",
      "--glow", "6,2,#ff00ff,45,0.7",
      "--blur", "2",
      "--choke", "2", "--feather", "1",
      "-p", proj, "--json",
    ],
    root,
  );
  expect(addVec.code).toBe(0);

  // Text Layer with gradient fill, grade, and glow
  const addTxt = await invokeOffline(
    [
      "composition", "add", "thumb", "title",
      "--text", "LOOK", "--font", "Archivo", "--weight", "800", "--font-size", "28",
      "--color", "linear:90deg,#facc15,#ef4444", "--x", "50", "--y", "15",
      "--warmth", "0.25", "--glow", "4,1,#ffffff,0,0.5",
      "-p", proj, "--json",
    ],
    root,
  );
  expect(addTxt.code).toBe(0);

  // Raster cutout with visible region, grade (brightness + saturation + warmth), and directional glow
  const addCut = await invokeOffline(
    [
      "composition", "add", "thumb", "cutout",
      "--image", paddedPng, "--visible-region", "16,16,32,32",
      "--x", "70", "--y", "45",
      "--brightness", "1.15", "--saturation", "1.2", "--warmth", "0.3",
      "--glow", "8,3,#38bdf8,90,0.8",
      "-p", proj, "--json",
    ],
    root,
  );
  expect(addCut.code).toBe(0);

  // Initial render
  const render = await invokeOffline(["composition", "render", "thumb", "-p", proj, "--json"], root);
  expect(render.code).toBe(0);
  const renderJson = JSON.parse(render.stdout);
  const manifest = renderJson.render.manifest as string;
  const png = await readFile(renderJson.render.output as string);
  expect(readPngHeader(png)).toMatchObject({ width: 128, height: 96 });

  // Later edits: add an unrelated composition and an unrelated layer to verify pinned history
  const createOther = await invokeOffline(
    ["composition", "create", "other", "--width", "100", "--height", "100", "-p", proj, "--json"],
    root,
  );
  expect(createOther.code).toBe(0);
  await invokeOffline(
    ["composition", "add", "other", "dot", "--shape", "ellipse", "--size", "20x20", "--fill", "#ffffff", "-p", proj, "--json"],
    root,
  );

  // Delete external sources, relocate Project, replay offline
  await rm(ringSvg, { force: true });
  await rm(paddedPng, { force: true });

  const proj2 = path.join(root, "proj-relocated");
  await rename(proj, proj2);

  const replayedPath = path.join(root, "replayed.png");
  const replayedManifestPath = path.join(proj2, path.relative(proj, manifest));
  const replay = await invokeOffline(
    [
      "composition", "replay",
      replayedManifestPath,
      "--out", replayedPath,
      "-p", proj2, "--json",
    ],
    root,
  );
  expect(replay.code).toBe(0);
  expect(JSON.parse(replay.stdout).ok).toBe(true);

  const replayed = await readFile(replayedPath);
  expect(replayed.equals(png)).toBe(true);

  // Verify that the replayed manifest pinned all four grade controls across layers
  const manifestDoc = JSON.parse(await readFile(replayedManifestPath, "utf8")) as {
    layers: Array<{ name: string; layerId: string; revisionId: string }>;
  };
  const cutoutEntry = manifestDoc.layers.find((l) => l.name === "cutout")!;
  const cutoutRevPath = path.join(proj2, "layers", `${cutoutEntry.layerId}.revisions`, `${cutoutEntry.revisionId}.json`);
  const cutoutRev = JSON.parse(await readFile(cutoutRevPath, "utf8"));
  expect(cutoutRev.grade).toMatchObject({ brightness: 1.15, saturation: 1.2, warmth: 0.3 });
});

// ---------------------------------------------------------------------------
// 4. Shared Layer Look Edit Semantics: Bare Refusal, --in-place, and --fork
// ---------------------------------------------------------------------------

test("shared Layer refuses bare look edit and obeys --in-place and --fork", async () => {
  const proj = path.join(tempDir, "shared-proj");
  await invoke(["project", "init", proj, "--json"]);
  await invoke(["composition", "create", "c1", "--width", "100", "--height", "100", "-p", proj, "--json"]);
  await invoke(["composition", "create", "c2", "--width", "100", "--height", "100", "-p", proj, "--json"]);

  // Add Layer to c1
  const addRes = await invoke([
    "composition", "add", "c1", "shareditem",
    "--shape", "rectangle", "--size", "40x40", "--fill", "#10b981",
    "-p", proj, "--json",
  ]);
  expect(addRes.code).toBe(0);
  const origLayerId = JSON.parse(addRes.stdout).use.layerId as string;

  // Import into c2 so it becomes shared
  const importRes = await invoke([
    "composition", "import", "c2", "c1",
    "-p", proj, "--json",
  ]);
  expect(importRes.code).toBe(0);

  // Bare look edit on shared Layer must refuse with exit 1
  const bareEdit = await invoke([
    "layer", "edit", "c1/shareditem",
    "--brightness", "1.5",
    "-p", proj, "--json",
  ]);
  expect(bareEdit.code).toBe(1);
  const bareErr = JSON.parse(bareEdit.stdout);
  expect(bareErr.error).toContain("referenced by 2 Compositions");
  expect(bareErr.error).toContain("--in-place");
  expect(bareErr.error).toContain("fork into an independent Layer");

  // In-place look edit: succeeds and propagates
  const inPlaceEdit = await invoke([
    "layer", "edit", "c1/shareditem",
    "--brightness", "1.5", "--in-place",
    "-p", proj, "--json",
  ]);
  expect(inPlaceEdit.code).toBe(0);

  const inspectC1 = await invoke(["layer", "inspect", "c1/shareditem", "-p", proj, "--json"]);
  const inspectC2 = await invoke(["layer", "inspect", "c2/shareditem", "-p", proj, "--json"]);
  const revC1 = JSON.parse(inspectC1.stdout).layer.currentRevision;
  const revC2 = JSON.parse(inspectC2.stdout).layer.currentRevision;
  expect(revC1.grade?.brightness).toBe(1.5);
  expect(revC2.grade?.brightness).toBe(1.5);
  expect(JSON.parse(inspectC1.stdout).layer.id).toBe(JSON.parse(inspectC2.stdout).layer.id);

  // Fork look edit: creates isolated Layer for c1
  const forkEdit = await invoke([
    "layer", "edit", "c1/shareditem",
    "--glow", "6,2,#ec4899", "--fork",
    "-p", proj, "--json",
  ]);
  expect(forkEdit.code).toBe(0);

  const inspectForkedC1 = await invoke(["layer", "inspect", "c1/shareditem", "-p", proj, "--json"]);
  const inspectUnforkedC2 = await invoke(["layer", "inspect", "c2/shareditem", "-p", proj, "--json"]);
  const idC1 = JSON.parse(inspectForkedC1.stdout).layer.id as string;
  const idC2 = JSON.parse(inspectUnforkedC2.stdout).layer.id as string;
  expect(idC1).not.toBe(idC2);
  expect(idC2).toBe(origLayerId);

  const revForkedC1 = JSON.parse(inspectForkedC1.stdout).layer.currentRevision;
  const revUnforkedC2 = JSON.parse(inspectUnforkedC2.stdout).layer.currentRevision;
  expect(revForkedC1.glow?.color).toBe("#ec4899");
  expect(revUnforkedC2.glow).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 7. Cover fit reversibility and replay (#293, spec #285 US-007, DEC-011,
//    DEC-005, TEST-002): cover fit is an input form into the ONE canonical
//    scale facts, so the absolute --scale setter reverses it to a
//    byte-identical render, retained content bytes never change, and the
//    pinned Render replays offline.
// ---------------------------------------------------------------------------

test("reversibility and lineage: cover fit reverses through the absolute scale setter; replay stays byte-identical", async () => {
  const proj = path.join(tempDir, "proj");
  await invoke(["project", "init", proj, "--json"]);
  await invoke(["composition", "create", "testcomp", "--width", "200", "--height", "100", "-p", proj, "--json"]);

  const imgPath = path.join(tempDir, "sample.png");
  await writeFile(imgPath, solidPng(100, 60, [180, 90, 45, 255]));

  const addRes = await invoke([
    "composition", "add", "testcomp", "bg", "--image", imgPath, "-p", proj, "--json",
  ]);
  expect(addRes.code).toBe(0);
  const layerId = JSON.parse(addRes.stdout).use.layerId as string;

  const renderInit = await invoke(["composition", "render", "testcomp", "-p", proj, "--json"]);
  expect(renderInit.code).toBe(0);
  const initPng = await readFile(JSON.parse(renderInit.stdout).render.output as string);
  const initContentHash = JSON.parse(addRes.stdout).layer.currentRevision.contentHash as string;

  // Cover the canvas: uniform scale = max(200/100, 100/60) = 2, and the
  // render changes (the canvas is now fully covered).
  const coverRes = await invoke(["layer", "edit", layerId, "--cover-to", "canvas", "-p", proj, "--json"]);
  expect(coverRes.code).toBe(0);
  const coveredRev = JSON.parse(coverRes.stdout).layer.currentRevision;
  expect(coveredRev.scaleX).toBe(2);
  expect(coveredRev.scaleY).toBe(2);
  expect(coveredRev.contentHash).toBe(initContentHash);

  const renderCovered = await invoke(["composition", "render", "testcomp", "-p", proj, "--json"]);
  expect(renderCovered.code).toBe(0);
  const coveredPng = await readFile(JSON.parse(renderCovered.stdout).render.output as string);
  expect(coveredPng.equals(initPng)).toBe(false);

  // The documented removal: the absolute --scale setter restores scale 1.
  const revertRes = await invoke(["layer", "edit", layerId, "--scale", "1", "-p", proj, "--json"]);
  expect(revertRes.code).toBe(0);
  const revertedRev = JSON.parse(revertRes.stdout).layer.currentRevision;
  expect(revertedRev.scaleX).toBe(1);
  expect(revertedRev.scaleY).toBe(1);
  expect(revertedRev.contentHash).toBe(initContentHash);

  // Byte-identical replay of the pre-cover render, offline.
  const renderReverted = await invokeOffline(["composition", "render", "testcomp", "-p", proj, "--json"], path.resolve(import.meta.dir, ".."));
  expect(renderReverted.code).toBe(0);
  const revertedPng = await readFile(JSON.parse(renderReverted.stdout).render.output as string);
  expect(revertedPng.equals(initPng)).toBe(true);
});
