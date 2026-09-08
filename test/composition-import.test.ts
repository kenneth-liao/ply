/**
 * Composition Layer import within a Project (#84, spec #77 US-003 / US-006 / US-008 / DEC-001–006).
 *
 * Verifies:
 * - Import A into B as individual references to the same Project Layer identities (image and text).
 * - No Render or baked image substitutes for the imported Composition.
 * - Use predecessor membership operations to drop an imported use and interleave a B-owned Layer between imported Layers without changing A's list.
 * - Exercise A → B → C import through the CLI and verify C renders with its imported Layers still individually addressable.
 * - Collision handling: existing local names must not be silently overwritten or confused with shared identity; rejection leaves destination live references unchanged.
 * - Self-import rejection: attempting to import a Composition into itself fails with exit 1 and leaves state unchanged.
 * - Empty source import: importing an empty Composition succeeds as a no-op with 0 imported uses.
 * - Canvas dimension independence: importing between Compositions with different canvas dimensions preserves target dimensions and Layer placement without rescaling.
 * - Non-subscription vs shared in-place edit propagation: later additions/removals/reorders in A do not update B, while in-place edits of a shared Layer reflect across all referring Compositions.
 * - Multi-referrer guard: unflagged edit on a shared Layer is refused with referrersCount: 2 naming both Compositions.
 * - Concurrency serialization under .ply.lock: deterministic preload lock handshake proves unflagged editor reaches lock and discovers newly imported reference, failing closed.
 * - Failure during atomicReplace leaves Composition document unchanged and retry succeeds.
 * - Operations succeed after Project relocation.
 * - Public CLI JSON/errors/help/offline behavior and argument validation (exit code 2 for missing options).
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, rename, mkdir, readdir } from "node:fs/promises";
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
const YELLOW: [number, number, number, number] = [255, 255, 0, 255];

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

const close = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-comp-import-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "import-test-proj"]);
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

async function addImageLayer(comp: string, localName: string, imgFile: string, opts: { x?: number; y?: number; opacity?: number } = {}) {
  const args = ["composition", "add", comp, localName, "--image", imgFile, "--project", projDir, "--json"];
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  if (opts.opacity !== undefined) args.push("--opacity", String(opts.opacity));
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

async function addTextLayer(comp: string, localName: string, text: string, opts: { font?: string; fontSize?: number; color?: string; x?: number; y?: number; opacity?: number } = {}) {
  const args = ["composition", "add", comp, localName, "--text", text, "--font", opts.font ?? "Anton", "--project", projDir, "--json"];
  if (opts.fontSize !== undefined) args.push("--font-size", String(opts.fontSize));
  if (opts.color !== undefined) args.push("--color", opts.color);
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  if (opts.opacity !== undefined) args.push("--opacity", String(opts.opacity));
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

test("import A into B creates individual references to the same Layer IDs without baking images", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(60, 60, RED));

  await makeComp("comp-a", 400, 300);
  await makeComp("comp-b", 400, 300);

  // Add an image Layer and a text Layer to comp-a
  const imgRes = await addImageLayer("comp-a", "badge", redImg, { x: 10, y: 10 });
  const textRes = await addTextLayer("comp-a", "headline", "Hello", { font: "Anton", fontSize: 48, color: "#ffffff", x: 20, y: 80 });

  const imgLayerId = imgRes.use.layerId as string;
  const textLayerId = textRes.use.layerId as string;

  // Initial renders directory count in project
  const initialRenders = await readdir(path.join(projDir, "renders"));

  // Import comp-a into comp-b
  const importRes = await invoke([
    "composition", "import", "comp-b", "comp-a",
    "--project", projDir,
    "--json",
  ]);
  expect(importRes.code).toBe(0);
  const importJson = JSON.parse(importRes.stdout);
  expect(importJson.ok).toBe(true);
  expect(importJson.composition).toBe("comp-b");
  expect(importJson.sourceComposition).toBe("comp-a");
  expect(importJson.importedUses).toEqual([
    { name: "badge", layerId: imgLayerId },
    { name: "headline", layerId: textLayerId },
  ]);
  expect(importJson.layers).toEqual([
    { name: "badge", layerId: imgLayerId },
    { name: "headline", layerId: textLayerId },
  ]);

  // Verify no baked render or image was added to renders/
  const currentRenders = await readdir(path.join(projDir, "renders"));
  expect(currentRenders).toEqual(initialRenders);

  // Inspect comp-b to verify both Layers are individually inspectable with identical identities and revisions
  const inspectB = await invoke(["composition", "inspect", "comp-b", "--project", projDir, "--json"]);
  expect(inspectB.code).toBe(0);
  const bLayers = JSON.parse(inspectB.stdout).composition.layers;
  expect(bLayers).toHaveLength(2);
  expect(bLayers[0].name).toBe("badge");
  expect(bLayers[0].layerId).toBe(imgLayerId);
  expect(bLayers[0].kind).toBe("image");
  expect(bLayers[1].name).toBe("headline");
  expect(bLayers[1].layerId).toBe(textLayerId);
  expect(bLayers[1].kind).toBe("text");

  // Compact default output formatting
  await makeComp("comp-c", 400, 300);
  const compactImport = await invoke([
    "composition", "import", "comp-c", "comp-a",
    "--project", projDir,
  ]);
  expect(compactImport.code).toBe(0);
  const lines = compactImport.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("Imported 2 Layers");
  expect(lines[0]).toContain("comp-a");
  expect(lines[0]).toContain("comp-c");
});

test("predecessor remove and reorder allow subsetting and interleaving in B without altering A", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  const blueImg = path.join(tempDir, "blue.png");
  await writeFile(blueImg, solidPng(50, 50, BLUE));

  await makeComp("comp-a", 400, 300);
  await makeComp("comp-b", 400, 300);

  const l1 = await addImageLayer("comp-a", "l1", redImg);
  const l2 = await addImageLayer("comp-a", "l2", redImg);
  const l3 = await addImageLayer("comp-a", "l3", redImg);

  const compAFile = path.join(projDir, "compositions", "comp-a.json");
  const compASnap = await readFile(compAFile, "utf8");

  // Import comp-a into comp-b
  const importRes = await invoke(["composition", "import", "comp-b", "comp-a", "--project", projDir, "--json"]);
  expect(importRes.code).toBe(0);

  // 1. Drop imported use "l2" from comp-b
  const removeRes = await invoke(["composition", "remove", "comp-b", "l2", "--project", projDir, "--json"]);
  expect(removeRes.code).toBe(0);

  // 2. Add a B-owned Layer "b-extra"
  const extraRes = await addImageLayer("comp-b", "b-extra", blueImg);
  const extraLayerId = extraRes.use.layerId as string;

  // 3. Interleave "b-extra" between "l1" and "l3" via reorder: [l1, b-extra, l3]
  const reorderRes = await invoke([
    "composition", "reorder", "comp-b",
    "--order", "l1,b-extra,l3",
    "--project", projDir,
    "--json",
  ]);
  expect(reorderRes.code).toBe(0);

  // Verify comp-b layers
  const inspectB = await invoke(["composition", "inspect", "comp-b", "--project", projDir, "--json"]);
  expect(inspectB.code).toBe(0);
  const bNames = JSON.parse(inspectB.stdout).composition.layers.map((l: { name: string }) => l.name);
  expect(bNames).toEqual(["l1", "b-extra", "l3"]);

  // Verify comp-a is completely unchanged (byte-identical)
  expect(await readFile(compAFile, "utf8")).toBe(compASnap);
});

test("A -> B -> C transitive import renders correctly and retains individual Layer addressability", async () => {
  const greenBg = path.join(tempDir, "bg.png");
  await writeFile(greenBg, solidPng(400, 300, GREEN));
  const blueBox = path.join(tempDir, "blue-box.png");
  await writeFile(blueBox, solidPng(150, 100, BLUE));

  await makeComp("comp-a", 400, 300);
  await makeComp("comp-b", 400, 300);
  await makeComp("comp-c", 400, 300);

  // A has background (Layer 1)
  const aBg = await addImageLayer("comp-a", "bg", greenBg, { x: 0, y: 0 });

  // B imports A, then B adds blue box (Layer 2)
  const importB = await invoke(["composition", "import", "comp-b", "comp-a", "--project", projDir, "--json"]);
  expect(importB.code).toBe(0);
  const bBox = await addImageLayer("comp-b", "box", blueBox, { x: 20, y: 20 });

  // C imports B, then C adds red text (Layer 3)
  const importC = await invoke(["composition", "import", "comp-c", "comp-b", "--project", projDir, "--json"]);
  expect(importC.code).toBe(0);
  const cTitle = await addTextLayer("comp-c", "title", "PLY", { font: "Anton", fontSize: 100, color: "#ff0000", x: 30, y: 30 });

  // Verify C's layers: [bg, box, title]
  const inspectC = await invoke(["composition", "inspect", "comp-c", "--project", projDir, "--json"]);
  expect(inspectC.code).toBe(0);
  const cLayers = JSON.parse(inspectC.stdout).composition.layers;
  expect(cLayers).toHaveLength(3);
  expect(cLayers[0].name).toBe("bg");
  expect(cLayers[0].layerId).toBe(aBg.use.layerId);
  expect(cLayers[1].name).toBe("box");
  expect(cLayers[1].layerId).toBe(bBox.use.layerId);
  expect(cLayers[2].name).toBe("title");
  expect(cLayers[2].layerId).toBe(cTitle.use.layerId);

  // Render C to verify all three layers paint in order
  const renderC = await invoke(["composition", "render", "comp-c", "--project", projDir, "--json"]);
  expect(renderC.code).toBe(0);
  const cPng = decodePng(await readFile(JSON.parse(renderC.stdout).render.output));

  // Background is green at (350, 250)
  expect(pixel(cPng, 350, 250).every((v, i) => close(v, GREEN[i]!))).toBe(true);

  // Blue box covers (25, 25)
  expect(pixel(cPng, 25, 25).every((v, i) => close(v, BLUE[i]!))).toBe(true);

  // Text title glyph coordinate is RED
  let hasRed = false;
  for (let y = 40; y < 120 && !hasRed; y++) {
    for (let x = 40; x < 150 && !hasRed; x++) {
      const p = pixel(cPng, x, y);
      if (p[0] === 255 && p[1] === 0 && p[2] === 0 && p[3] === 255) {
        hasRed = true;
      }
    }
  }
  expect(hasRed).toBe(true);
});

test("collision handling: local name collision explicitly rejects and leaves destination live references unchanged", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(40, 40, RED));
  const blueImg = path.join(tempDir, "blue.png");
  await writeFile(blueImg, solidPng(40, 40, BLUE));

  await makeComp("dest-comp", 300, 300);
  await makeComp("src-comp", 300, 300);

  // Destination has "hero" and "footer"
  await addImageLayer("dest-comp", "hero", redImg);
  await addImageLayer("dest-comp", "footer", redImg);

  // Source has "hero" and "sidebar"
  await addImageLayer("src-comp", "hero", blueImg);
  await addImageLayer("src-comp", "sidebar", blueImg);

  const destFile = path.join(projDir, "compositions", "dest-comp.json");
  const destSnap = await readFile(destFile, "utf8");

  // Attempt import: should fail due to "hero" collision
  const importRes = await invoke([
    "composition", "import", "dest-comp", "src-comp",
    "--project", projDir,
    "--json",
  ]);
  expect(importRes.code).toBe(1);
  const errorJson = JSON.parse(importRes.stdout);
  expect(errorJson.ok).toBe(false);
  expect(errorJson.error).toMatch(/collision/i);
  expect(errorJson.error).toContain("hero");

  // Destination file remains completely unchanged
  expect(await readFile(destFile, "utf8")).toBe(destSnap);
});

test("self-import is explicitly rejected with exit 1 leaving composition unchanged", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(40, 40, RED));

  await makeComp("self-comp", 300, 300);
  await addImageLayer("self-comp", "layer1", redImg);

  const compFile = path.join(projDir, "compositions", "self-comp.json");
  const compSnap = await readFile(compFile, "utf8");

  const selfImport = await invoke([
    "composition", "import", "self-comp", "self-comp",
    "--project", projDir,
    "--json",
  ]);
  expect(selfImport.code).toBe(1);
  const errJson = JSON.parse(selfImport.stdout);
  expect(errJson.ok).toBe(false);
  expect(errJson.error).toMatch(/itself/i);

  expect(await readFile(compFile, "utf8")).toBe(compSnap);
});

test("empty source import succeeds as a no-op with 0 imported uses", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(40, 40, RED));

  await makeComp("target-comp", 300, 300);
  await makeComp("empty-source", 300, 300);
  await addImageLayer("target-comp", "existing", redImg);

  const compFile = path.join(projDir, "compositions", "target-comp.json");
  const compSnap = await readFile(compFile, "utf8");

  const importEmpty = await invoke([
    "composition", "import", "target-comp", "empty-source",
    "--project", projDir,
    "--json",
  ]);
  expect(importEmpty.code).toBe(0);
  const json = JSON.parse(importEmpty.stdout);
  expect(json.ok).toBe(true);
  expect(json.composition).toBe("target-comp");
  expect(json.sourceComposition).toBe("empty-source");
  expect(json.importedUses).toEqual([]);
  expect(json.layers).toHaveLength(1);
  expect(json.layers[0].name).toBe("existing");

  expect(await readFile(compFile, "utf8")).toBe(compSnap);
});

test("different canvas dimensions do not rescale Layer content or placement", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 100, RED));

  await makeComp("small-source", 400, 300);
  await makeComp("large-target", 1920, 1080);

  const addRes = await addImageLayer("small-source", "graphic", redImg, { x: 50, y: 75, opacity: 0.8 });
  const layerId = addRes.use.layerId as string;

  const importRes = await invoke([
    "composition", "import", "large-target", "small-source",
    "--project", projDir,
    "--json",
  ]);
  expect(importRes.code).toBe(0);

  const inspectTarget = await invoke(["composition", "inspect", "large-target", "--project", projDir, "--json"]);
  expect(inspectTarget.code).toBe(0);
  const targetComp = JSON.parse(inspectTarget.stdout).composition;

  // Target canvas remains 1920x1080
  expect(targetComp.canvas.width).toBe(1920);
  expect(targetComp.canvas.height).toBe(1080);

  // Layer placement is exactly (50, 75) and opacity 0.8
  const layer = targetComp.layers[0];
  expect(layer.layerId).toBe(layerId);
  expect(layer.revision.x).toBe(50);
  expect(layer.revision.y).toBe(75);
  expect(layer.revision.opacity).toBe(0.8);
});

test("non-subscription membership vs in-place edit propagation and multi-referrer refusal", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  const greenImg = path.join(tempDir, "green.png");
  await writeFile(greenImg, solidPng(50, 50, GREEN));
  const blueImg = path.join(tempDir, "blue.png");
  await writeFile(blueImg, solidPng(60, 60, BLUE));
  const yellowImg = path.join(tempDir, "yellow.png");
  await writeFile(yellowImg, solidPng(40, 40, YELLOW));

  await makeComp("comp-a", 400, 300);
  await makeComp("comp-b", 400, 300);

  // Initial setup in comp-a: shared-layer (RED at 10,10) and a-extra1 (BLUE at 100,100)
  const l1 = await addImageLayer("comp-a", "shared-layer", redImg, { x: 10, y: 10 });
  const layerId = l1.use.layerId as string;
  await addImageLayer("comp-a", "a-extra1", blueImg, { x: 100, y: 100 });

  // Import comp-a into comp-b: comp-b now has [shared-layer, a-extra1]
  const importRes = await invoke(["composition", "import", "comp-b", "comp-a", "--project", projDir, "--json"]);
  expect(importRes.code).toBe(0);

  const compBFile = path.join(projDir, "compositions", "comp-b.json");
  const compBSnap = await readFile(compBFile, "utf8");

  // 1. Source additions do NOT update B
  await addImageLayer("comp-a", "a-extra2", yellowImg, { x: 200, y: 200 });
  // comp-a now has 3 uses: [shared-layer, a-extra1, a-extra2]
  // comp-b remains unchanged with 2 uses
  expect(await readFile(compBFile, "utf8")).toBe(compBSnap);
  const inspectB1 = await invoke(["composition", "inspect", "comp-b", "--project", projDir, "--json"]);
  expect(JSON.parse(inspectB1.stdout).composition.layers.map((l: { name: string }) => l.name)).toEqual([
    "shared-layer",
    "a-extra1",
  ]);

  // 2. Source removal does NOT update B
  const removeA = await invoke(["composition", "remove", "comp-a", "a-extra1", "--project", projDir, "--json"]);
  expect(removeA.code).toBe(0);
  // comp-a now has 2 remaining uses: [shared-layer, a-extra2]
  // comp-b remains unchanged with [shared-layer, a-extra1]
  expect(await readFile(compBFile, "utf8")).toBe(compBSnap);
  const inspectB2 = await invoke(["composition", "inspect", "comp-b", "--project", projDir, "--json"]);
  expect(JSON.parse(inspectB2.stdout).composition.layers.map((l: { name: string }) => l.name)).toEqual([
    "shared-layer",
    "a-extra1",
  ]);

  // 3. Source reordering (with at least 2 remaining uses) does NOT update B
  const reorderA = await invoke([
    "composition", "reorder", "comp-a",
    "--order", "a-extra2,shared-layer",
    "--project", projDir,
    "--json",
  ]);
  expect(reorderA.code).toBe(0);
  const inspectA1 = await invoke(["composition", "inspect", "comp-a", "--project", projDir, "--json"]);
  expect(JSON.parse(inspectA1.stdout).composition.layers.map((l: { name: string }) => l.name)).toEqual([
    "a-extra2",
    "shared-layer",
  ]);
  // comp-b remains unchanged with [shared-layer, a-extra1]
  expect(await readFile(compBFile, "utf8")).toBe(compBSnap);

  // 4. Unflagged edit on shared Layer is refused with referrersCount: 2 naming both A and B
  const unflaggedEdit = await invoke([
    "layer", "edit", layerId,
    "--x", "99",
    "--project", projDir,
    "--json",
  ]);
  expect(unflaggedEdit.code).toBe(1);
  const unflaggedJson = JSON.parse(unflaggedEdit.stdout);
  expect(unflaggedJson.ok).toBe(false);
  expect(unflaggedJson.referrersCount).toBe(2);
  expect(unflaggedJson.referringCompositions).toEqual(["comp-a", "comp-b"]);

  // 5. Render A and B BEFORE in-place shared edit: pixel at (15, 15) is RED in both
  const renderA1 = await invoke(["composition", "render", "comp-a", "--project", projDir, "--json"]);
  expect(renderA1.code).toBe(0);
  const pngA1 = decodePng(await readFile(JSON.parse(renderA1.stdout).render.output));
  expect(pixel(pngA1, 15, 15).every((v, i) => close(v, RED[i]!))).toBe(true);

  const renderB1 = await invoke(["composition", "render", "comp-b", "--project", projDir, "--json"]);
  expect(renderB1.code).toBe(0);
  const pngB1 = decodePng(await readFile(JSON.parse(renderB1.stdout).render.output));
  expect(pixel(pngB1, 15, 15).every((v, i) => close(v, RED[i]!))).toBe(true);

  // 6. Explicit in-place edit updates the shared Layer image from RED to GREEN
  const inPlaceEdit = await invoke([
    "layer", "edit", layerId,
    "--image", greenImg,
    "--in-place",
    "--project", projDir,
    "--json",
  ]);
  expect(inPlaceEdit.code).toBe(0);
  const updatedRevId = JSON.parse(inPlaceEdit.stdout).layer.currentRevisionId;

  // 7. Render A and B AFTER in-place shared edit: actual pixel at (15, 15) changes to GREEN in both
  const renderA2 = await invoke(["composition", "render", "comp-a", "--project", projDir, "--json"]);
  expect(renderA2.code).toBe(0);
  const pngA2 = decodePng(await readFile(JSON.parse(renderA2.stdout).render.output));
  expect(pixel(pngA2, 15, 15).every((v, i) => close(v, GREEN[i]!))).toBe(true);

  const renderB2 = await invoke(["composition", "render", "comp-b", "--project", projDir, "--json"]);
  expect(renderB2.code).toBe(0);
  const pngB2 = decodePng(await readFile(JSON.parse(renderB2.stdout).render.output));
  expect(pixel(pngB2, 15, 15).every((v, i) => close(v, GREEN[i]!))).toBe(true);

  // Verify shared Layer identity and revision ID are retained across both A and B
  const inspectA2 = await invoke(["composition", "inspect", "comp-a", "--project", projDir, "--json"]);
  const inspectB3 = await invoke(["composition", "inspect", "comp-b", "--project", projDir, "--json"]);

  const aSharedUse = JSON.parse(inspectA2.stdout).composition.layers.find((l: { name: string }) => l.name === "shared-layer");
  const bSharedUse = JSON.parse(inspectB3.stdout).composition.layers.find((l: { name: string }) => l.name === "shared-layer");

  expect(aSharedUse.layerId).toBe(layerId);
  expect(bSharedUse.layerId).toBe(layerId);
  expect(aSharedUse.revision.revisionId).toBe(updatedRevId);
  expect(bSharedUse.revision.revisionId).toBe(updatedRevId);
});

test("concurrency: import synchronizes under .ply.lock and causes unflagged editor reaching lock to fail closed with 2 referrers", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));

  await makeComp("src-comp", 300, 300);
  await makeComp("target-comp", 300, 300);

  // Source has 1 layer (referrers count = 1 initially)
  const addRes = await addImageLayer("src-comp", "badge", redImg);
  const layerId = addRes.use.layerId as string;

  const signalImportLocked = path.join(tempDir, "import-locked");
  const signalEditorAttemptingLock = path.join(tempDir, "editor-attempting-lock");

  // Preload for import: acquires lock, signals that lock is held, waits for editor to attempt lock acquisition,
  // then proceeds with import publication under lock.
  const importPreload = path.join(tempDir, "import-preload.ts");
  await writeFile(
    importPreload,
    `
    import { mock } from "bun:test";
    import { writeFile } from "node:fs/promises";
    import * as lock from ${JSON.stringify(path.resolve(import.meta.dir, "../src/project-lock.ts"))};
    const original = { ...lock };
    mock.module(${JSON.stringify(path.resolve(import.meta.dir, "../src/project-lock.ts"))}, () => ({
      ...original,
      acquireProjectLock: async (...args) => {
        const acquired = await original.acquireProjectLock(...args);
        if (process.env.PLY_TEST_SIGNAL_IMPORT_LOCKED && process.env.PLY_TEST_SIGNAL_EDITOR_ATTEMPTING_LOCK) {
          await writeFile(process.env.PLY_TEST_SIGNAL_IMPORT_LOCKED, "locked");
          const deadline = Date.now() + 10000;
          while (!(await Bun.file(process.env.PLY_TEST_SIGNAL_EDITOR_ATTEMPTING_LOCK).exists())) {
            if (Date.now() > deadline) throw new Error("Import timed out waiting for editor attempting lock signal");
            await Bun.sleep(5);
          }
        }
        return acquired;
      },
    }));
  `,
  );

  // Preload for editor: intercepts acquireProjectLock to signal immediately before blocking on lock
  const editorPreload = path.join(tempDir, "editor-preload.ts");
  await writeFile(
    editorPreload,
    `
    import { mock } from "bun:test";
    import { writeFile } from "node:fs/promises";
    import * as lock from ${JSON.stringify(path.resolve(import.meta.dir, "../src/project-lock.ts"))};
    const original = { ...lock };
    mock.module(${JSON.stringify(path.resolve(import.meta.dir, "../src/project-lock.ts"))}, () => ({
      ...original,
      acquireProjectLock: async (...args) => {
        if (process.env.PLY_TEST_SIGNAL_EDITOR_ATTEMPTING_LOCK) {
          await writeFile(process.env.PLY_TEST_SIGNAL_EDITOR_ATTEMPTING_LOCK, "attempting-lock");
        }
        return original.acquireProjectLock(...args);
      },
    }));
  `,
  );

  // 1. Start import process which acquires lock
  const importProc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      importPreload,
      path.resolve(import.meta.dir, "../src/composition-cli.ts"),
      "import",
      "target-comp",
      "src-comp",
      "--project",
      projDir,
      "--json",
    ],
    {
      env: {
        ...process.env,
        PLY_TEST_SIGNAL_IMPORT_LOCKED: signalImportLocked,
        PLY_TEST_SIGNAL_EDITOR_ATTEMPTING_LOCK: signalEditorAttemptingLock,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // 2. Wait for import to hold the lock
  const deadline = Date.now() + 5000;
  while (!(await Bun.file(signalImportLocked).exists())) {
    if (Date.now() > deadline) throw new Error("Import process timed out acquiring lock");
    await Bun.sleep(5);
  }

  // 3. Launch unflagged editor (without --in-place). It signals editor-attempting-lock and blocks on lock.
  const editProc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      editorPreload,
      path.resolve(import.meta.dir, "../src/layer-cli.ts"),
      "edit",
      layerId,
      "--x",
      "50",
      "--project",
      projDir,
      "--json",
    ],
    {
      env: {
        ...process.env,
        PLY_TEST_SIGNAL_EDITOR_ATTEMPTING_LOCK: signalEditorAttemptingLock,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // 4. Import commits and completes successfully
  expect(await importProc.exited).toBe(0);
  const importOut = JSON.parse(await new Response(importProc.stdout).text());
  expect(importOut.ok).toBe(true);

  // 5. Editor unblocks, acquires lock, discovers 2 referrers, and fails closed with blast-radius refusal
  expect(await editProc.exited).toBe(1);
  const editOut = JSON.parse(await new Response(editProc.stdout).text());
  expect(editOut.ok).toBe(false);
  expect(editOut.referrersCount).toBe(2);
  expect(editOut.referringCompositions).toEqual(["src-comp", "target-comp"]);
});

test("atomicReplace failure during import leaves target Composition document unchanged and retry succeeds", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(40, 40, RED));

  await makeComp("fail-target", 300, 300);
  await makeComp("fail-src", 300, 300);
  await addImageLayer("fail-target", "keep", redImg);
  await addImageLayer("fail-src", "to-import", redImg);

  const targetFile = path.join(projDir, "compositions", "fail-target.json");
  const snapTarget = await readFile(targetFile, "utf8");

  // Preload simulating atomicReplace failure on fail-target.json
  const failPreload = path.join(tempDir, "fail-replace.ts");
  await writeFile(
    failPreload,
    `
    import { mock } from "bun:test";
    import * as lock from ${JSON.stringify(path.resolve(import.meta.dir, "../src/project-lock.ts"))};
    const original = { ...lock };
    mock.module(${JSON.stringify(path.resolve(import.meta.dir, "../src/project-lock.ts"))}, () => ({
      ...original,
      atomicReplace: async (file, content) => {
        if (process.env.PLY_TEST_FAIL_IMPORT && file.endsWith("fail-target.json")) {
          throw new Error("Simulated I/O failure during Composition import replace");
        }
        return original.atomicReplace(file, content);
      },
    }));
  `,
  );

  const importFailProc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      failPreload,
      path.resolve(import.meta.dir, "../src/composition-cli.ts"),
      "import",
      "fail-target",
      "fail-src",
      "--project",
      projDir,
      "--json",
    ],
    {
      env: { ...process.env, PLY_TEST_FAIL_IMPORT: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  expect(await importFailProc.exited).toBe(1);
  const failJson = JSON.parse(await new Response(importFailProc.stdout).text());
  expect(failJson.ok).toBe(false);
  expect(failJson.error).toContain("Simulated I/O failure");

  // Target file is unchanged
  expect(await readFile(targetFile, "utf8")).toBe(snapTarget);

  // Subsequent import without failure succeeds
  const retryRes = await invoke([
    "composition", "import", "fail-target", "fail-src",
    "--project", projDir,
    "--json",
  ]);
  expect(retryRes.code).toBe(0);
  expect(JSON.parse(retryRes.stdout).ok).toBe(true);
  expect(JSON.parse(retryRes.stdout).layers.map((l: { name: string }) => l.name)).toEqual(["keep", "to-import"]);
});

test("composition import succeeds after Project relocation", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(40, 40, RED));

  await makeComp("reloc-target", 300, 300);
  await makeComp("reloc-source", 300, 300);
  await addImageLayer("reloc-source", "imported-layer", redImg);

  // Relocate Project directory
  const movedProj = path.join(tempDir, "relocated-proj");
  await rename(projDir, movedProj);

  const importRes = await invoke([
    "composition", "import", "reloc-target", "reloc-source",
    "--project", movedProj,
    "--json",
  ]);
  expect(importRes.code).toBe(0);
  expect(JSON.parse(importRes.stdout).layers.map((l: { name: string }) => l.name)).toEqual(["imported-layer"]);
});

test("CLI argument validation and help for composition import", async () => {
  // Missing args
  const missingArgs = await invoke(["composition", "import", "--project", projDir, "--json"]);
  expect(missingArgs.code).toBe(2);
  expect(JSON.parse(missingArgs.stdout).error).toMatch(/usage/i);

  const missingSource = await invoke(["composition", "import", "target-only", "--project", projDir, "--json"]);
  expect(missingSource.code).toBe(2);
  expect(JSON.parse(missingSource.stdout).error).toMatch(/usage/i);

  // Help documents import
  const help = await invoke(["composition", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("ply composition import <target> <source>");
});
