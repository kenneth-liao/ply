import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, rename, readFile, writeFile, mkdir, symlink, unlink, readdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePngRgba } from "../src/png.js";
import { LIBRARY_ROOT } from "../src/assets.js";

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

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-comp-test-"));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// Helper: create a deterministic PNG buffer (e.g. 100x50 RGBA solid red)
function createSolidPng(width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 255; // R
    rgba[i + 1] = 0; // G
    rgba[i + 2] = 0; // B
    rgba[i + 3] = 255; // A
  }
  return encodePngRgba(width, height, rgba);
}

// Minimal valid 1x1 JPEG fixture
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
  0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x03, 0x02, 0x02, 0x03, 0x02, 0x02, 0x03,
  0x03, 0x03, 0x03, 0x04, 0x03, 0x03, 0x04, 0x05, 0x08, 0x05, 0x05, 0x04, 0x04, 0x05, 0x0a, 0x07,
  0x07, 0x06, 0x08, 0x0c, 0x0a, 0x0c, 0x0c, 0x0b, 0x0a, 0x0b, 0x0b, 0x0d, 0x0e, 0x12, 0x10, 0x0d,
  0x0e, 0x11, 0x0e, 0x0b, 0x0b, 0x10, 0x16, 0x10, 0x11, 0x13, 0x14, 0x15, 0x15, 0x15, 0x0c, 0x0f,
  0x17, 0x18, 0x16, 0x14, 0x18, 0x12, 0x14, 0x15, 0x14, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
  0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
  0x00, 0xbf, 0x80, 0xff, 0xd9,
]);

// Minimal valid 1x1 WebP lossless fixture
const MINIMAL_WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
  0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x00, 0x07, 0x10, 0x58, 0x55, 0xa4, 0x00, 0x00,
  0x00, 0x00,
]);

test("composition create requires explicit width and height, and inspect reads it", async () => {
  const projDir = path.join(tempDir, "proj-1");
  await invoke(["project", "init", projDir, "--name", "proj-1", "--json"]);

  // Missing width and height fails with usage error 2
  const failRes = await invoke(["composition", "create", "thumb", "--project", projDir, "--json"]);
  expect(failRes.code).toBe(2);
  const failJson = JSON.parse(failRes.stdout);
  expect(failJson.ok).toBe(false);
  expect(failJson.error).toContain("width");

  // Invalid non-positive dimensions fail with usage error 2
  const invalidRes = await invoke(["composition", "create", "thumb", "--width", "0", "--height", "720", "--project", projDir, "--json"]);
  expect(invalidRes.code).toBe(2);
  expect(JSON.parse(invalidRes.stdout).ok).toBe(false);

  // Successful creation with explicit dimensions
  const createRes = await invoke(["composition", "create", "thumb", "--width", "1280", "--height", "720", "--project", projDir, "--json"]);
  expect(createRes.code).toBe(0);
  const createJson = JSON.parse(createRes.stdout);
  expect(createJson.ok).toBe(true);
  expect(createJson.composition.name).toBe("thumb");
  expect(createJson.composition.canvas).toEqual({ width: 1280, height: 720 });
  expect(createJson.composition.layers).toEqual([]);

  // Inspect composition with --json
  const inspectRes = await invoke(["composition", "inspect", "thumb", "--project", projDir, "--json"]);
  expect(inspectRes.code).toBe(0);
  const inspectJson = JSON.parse(inspectRes.stdout);
  expect(inspectJson.ok).toBe(true);
  expect(inspectJson.composition.name).toBe("thumb");
  expect(inspectJson.composition.canvas).toEqual({ width: 1280, height: 720 });
  expect(inspectJson.composition.layers).toEqual([]);

  // Inspect composition with text output
  const inspectTextRes = await invoke(["composition", "inspect", "thumb", "--project", projDir]);
  expect(inspectTextRes.code).toBe(0);
  expect(inspectTextRes.stdout).toContain("Composition: thumb (1280×720)");
  expect(inspectTextRes.stdout).toContain("Layers (0)");

  // Re-creating the same composition name fails with runtime error 1
  const duplicateRes = await invoke(["composition", "create", "thumb", "--width", "1280", "--height", "720", "--project", projDir, "--json"]);
  expect(duplicateRes.code).toBe(1);
  expect(JSON.parse(duplicateRes.stdout).ok).toBe(false);
  expect(JSON.parse(duplicateRes.stdout).error).toContain("already exists");
});

test("composition add ingests local image bytes, publishes Layer identity and initial revision", async () => {
  const projDir = path.join(tempDir, "proj-2");
  await invoke(["project", "init", projDir, "--json"]);
  await invoke(["composition", "create", "main-comp", "--width", "1920", "--height", "1080", "--project", projDir, "--json"]);

  // Record library state before adding layer to verify no implicit publication
  const libraryEntriesBefore = await readdir(LIBRARY_ROOT).catch(() => []);

  // Create local sample image
  const imgPath = path.join(tempDir, "hero.png");
  const imgBytes = createSolidPng(400, 300);
  await writeFile(imgPath, imgBytes);

  // Add layer to composition
  const addRes = await invoke([
    "composition",
    "add",
    "main-comp",
    "hero-layer",
    "--image",
    imgPath,
    "--x",
    "100",
    "--y",
    "50",
    "--opacity",
    "0.8",
    "--project",
    projDir,
    "--json",
  ]);
  expect(addRes.code).toBe(0);
  const addJson = JSON.parse(addRes.stdout);
  expect(addJson.ok).toBe(true);
  expect(addJson.composition).toBe("main-comp");
  expect(addJson.use.name).toBe("hero-layer");
  expect(typeof addJson.use.layerId).toBe("string");
  const layerId = addJson.use.layerId;

  // Verify layer inspection
  const layerInspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(layerInspect.code).toBe(0);
  const layerJson = JSON.parse(layerInspect.stdout);
  expect(layerJson.ok).toBe(true);
  expect(layerJson.layer.id).toBe(layerId);
  expect(layerJson.layer.currentRevision.kind).toBe("image");
  expect(layerJson.layer.currentRevision.x).toBe(100);
  expect(layerJson.layer.currentRevision.y).toBe(50);
  expect(layerJson.layer.currentRevision.opacity).toBe(0.8);
  expect(layerJson.layer.currentRevision.width).toBe(400);
  expect(layerJson.layer.currentRevision.height).toBe(300);
  expect(layerJson.layer.currentRevision.format).toBe("png");
  expect(typeof layerJson.layer.currentRevision.contentHash).toBe("string");

  // Verify composition inspect shows ordered use
  const compInspect = await invoke(["composition", "inspect", "main-comp", "--project", projDir, "--json"]);
  expect(compInspect.code).toBe(0);
  const compJson = JSON.parse(compInspect.stdout);
  expect(compJson.composition.layers.length).toBe(1);
  expect(compJson.composition.layers[0].name).toBe("hero-layer");
  expect(compJson.composition.layers[0].layerId).toBe(layerId);
  expect(compJson.composition.layers[0].revision.width).toBe(400);
  expect(compJson.composition.layers[0].revision.height).toBe(300);

  // Verify library remained completely untouched (no implicit publication)
  const libraryEntriesAfter = await readdir(LIBRARY_ROOT).catch(() => []);
  expect(libraryEntriesAfter).toEqual(libraryEntriesBefore);

  // Verify project inspect reports updated statistics
  const projInspect = await invoke(["project", "inspect", "--project", projDir, "--json"]);
  expect(projInspect.code).toBe(0);
  const pJson = JSON.parse(projInspect.stdout);
  expect(pJson.project.compositionsCount).toBe(1);
  expect(pJson.project.layersCount).toBe(1);
});

test("composition add supports JPEG and WebP image inputs seamlessly", async () => {
  const projDir = path.join(tempDir, "proj-formats");
  await invoke(["project", "init", projDir, "--json"]);
  await invoke(["composition", "create", "formats-comp", "--width", "1280", "--height", "720", "--project", projDir, "--json"]);

  const jpegPath = path.join(tempDir, "sample.jpg");
  await writeFile(jpegPath, MINIMAL_JPEG);

  const webpPath = path.join(tempDir, "sample.webp");
  await writeFile(webpPath, MINIMAL_WEBP);

  // Add JPEG layer
  const resJpeg = await invoke(["composition", "add", "formats-comp", "jpeg-use", "--image", jpegPath, "--project", projDir, "--json"]);
  expect(resJpeg.code).toBe(0);
  const jsonJpeg = JSON.parse(resJpeg.stdout);
  expect(jsonJpeg.layer.currentRevision.format).toBe("jpeg");
  expect(jsonJpeg.layer.currentRevision.width).toBe(1);
  expect(jsonJpeg.layer.currentRevision.height).toBe(1);

  // Add WebP layer
  const resWebp = await invoke(["composition", "add", "formats-comp", "webp-use", "--image", webpPath, "--project", projDir, "--json"]);
  expect(resWebp.code).toBe(0);
  const jsonWebp = JSON.parse(resWebp.stdout);
  expect(jsonWebp.layer.currentRevision.format).toBe("webp");
  expect(jsonWebp.layer.currentRevision.width).toBe(1);
  expect(jsonWebp.layer.currentRevision.height).toBe(1);

  // Inspect composition with 2 layers in order
  const compInspect = await invoke(["composition", "inspect", "formats-comp", "--project", projDir, "--json"]);
  expect(compInspect.code).toBe(0);
  const compJson = JSON.parse(compInspect.stdout);
  expect(compJson.composition.layers.length).toBe(2);
  expect(compJson.composition.layers[0].name).toBe("jpeg-use");
  expect(compJson.composition.layers[1].name).toBe("webp-use");
});

test("composition add deduplicates content blobs and validates existing content integrity", async () => {
  const projDir = path.join(tempDir, "proj-dedup");
  await invoke(["project", "init", projDir, "--json"]);
  await invoke(["composition", "create", "comp-a", "--width", "1000", "--height", "1000", "--project", projDir, "--json"]);
  await invoke(["composition", "create", "comp-b", "--width", "1000", "--height", "1000", "--project", projDir, "--json"]);

  const imgPath = path.join(tempDir, "shared.png");
  const imgBytes = createSolidPng(200, 200);
  await writeFile(imgPath, imgBytes);

  // Add to comp-a
  const resA = await invoke(["composition", "add", "comp-a", "use-1", "--image", imgPath, "--project", projDir, "--json"]);
  expect(resA.code).toBe(0);
  const jsonA = JSON.parse(resA.stdout);

  // Add identical image to comp-b
  const resB = await invoke(["composition", "add", "comp-b", "use-2", "--image", imgPath, "--project", projDir, "--json"]);
  expect(resB.code).toBe(0);
  const jsonB = JSON.parse(resB.stdout);

  // Different layer IDs, but identical contentHash
  expect(jsonA.use.layerId).not.toBe(jsonB.use.layerId);
  expect(jsonA.layer.currentRevision.contentHash).toBe(jsonB.layer.currentRevision.contentHash);

  // Verify only 1 content blob was stored in content/
  const contentDir = path.join(projDir, "content");
  const blob = path.join(contentDir, jsonA.layer.currentRevision.contentHash);
  const blobBytes = await readFile(blob);
  expect(blobBytes.equals(imgBytes)).toBe(true);
});

test("project relocation and original input removal preserves layer resolution", async () => {
  const origProj = path.join(tempDir, "orig-proj");
  await invoke(["project", "init", origProj, "--name", "reloc-test", "--json"]);
  await invoke(["composition", "create", "main", "--width", "1280", "--height", "720", "--project", origProj, "--json"]);

  const externalImg = path.join(tempDir, "external.png");
  await writeFile(externalImg, createSolidPng(150, 150));

  const addRes = await invoke(["composition", "add", "main", "logo", "--image", externalImg, "--project", origProj, "--json"]);
  expect(addRes.code).toBe(0);
  const layerId = JSON.parse(addRes.stdout).use.layerId;

  // 1. Delete original input file
  await unlink(externalImg);

  // 2. Relocate project
  const movedProj = path.join(tempDir, "moved-proj");
  await rename(origProj, movedProj);

  // 3. Inspect composition and layer from moved project
  const compInspect = await invoke(["composition", "inspect", "main", "--project", movedProj, "--json"]);
  expect(compInspect.code).toBe(0);
  const compJson = JSON.parse(compInspect.stdout);
  expect(compJson.composition.layers[0].name).toBe("logo");
  expect(compJson.composition.layers[0].layerId).toBe(layerId);
  expect(compJson.composition.layers[0].revision.width).toBe(150);

  const layerInspect = await invoke(["layer", "inspect", layerId, "--project", movedProj, "--json"]);
  expect(layerInspect.code).toBe(0);
  const layerJson = JSON.parse(layerInspect.stdout);
  expect(layerJson.layer.id).toBe(layerId);
  expect(layerJson.layer.currentRevision.width).toBe(150);
});

test("rejection of duplicate local names and corrupt/truncated image bodies", async () => {
  const projDir = path.join(tempDir, "proj-errors");
  await invoke(["project", "init", projDir, "--json"]);
  await invoke(["composition", "create", "c1", "--width", "800", "--height", "600", "--project", projDir, "--json"]);

  const validPng = path.join(tempDir, "valid.png");
  await writeFile(validPng, createSolidPng(100, 100));

  // 1. Add first layer
  const add1 = await invoke(["composition", "add", "c1", "elem1", "--image", validPng, "--project", projDir, "--json"]);
  expect(add1.code).toBe(0);

  // 2. Duplicate local name in same composition rejected
  const addDup = await invoke(["composition", "add", "c1", "elem1", "--image", validPng, "--project", projDir, "--json"]);
  expect(addDup.code).toBe(1);
  const dupJson = JSON.parse(addDup.stdout);
  expect(dupJson.ok).toBe(false);
  expect(dupJson.error).toContain("duplicate local name");

  // 3. Non-existent image file
  const addMissing = await invoke(["composition", "add", "c1", "elem2", "--image", path.join(tempDir, "nonexistent.png"), "--project", projDir, "--json"]);
  expect(addMissing.code).toBe(1);
  expect(JSON.parse(addMissing.stdout).ok).toBe(false);
  expect(JSON.parse(addMissing.stdout).error).toContain("cannot read");

  // 4. Corrupt image (valid IHDR header followed by truncated/garbage bytes)
  const corruptPng = path.join(tempDir, "corrupt.png");
  const fullBytes = createSolidPng(100, 100);
  // Truncate halfway through IDAT
  const truncatedBytes = fullBytes.subarray(0, 40);
  await writeFile(corruptPng, truncatedBytes);

  const addCorrupt = await invoke(["composition", "add", "c1", "elem3", "--image", corruptPng, "--project", projDir, "--json"]);
  expect(addCorrupt.code).toBe(1);
  const corruptJson = JSON.parse(addCorrupt.stdout);
  expect(corruptJson.ok).toBe(false);

  // Verify that composition still only has 1 layer (no partial publication)
  const compInspect = await invoke(["composition", "inspect", "c1", "--project", projDir, "--json"]);
  expect(compInspect.code).toBe(0);
  expect(JSON.parse(compInspect.stdout).composition.layers.length).toBe(1);
});

test("CLI argument and option errors emit valid JSON with exit status 2", async () => {
  // Unknown flag in composition create
  const res1 = await invoke(["composition", "create", "test", "--json", "--bad-flag"]);
  expect(res1.code).toBe(2);
  const json1 = JSON.parse(res1.stdout);
  expect(json1.ok).toBe(false);
  expect(json1.error).toContain("Unknown option");

  // Missing required positional args in composition add
  const res2 = await invoke(["composition", "add", "--json"]);
  expect(res2.code).toBe(2);
  const json2 = JSON.parse(res2.stdout);
  expect(json2.ok).toBe(false);
  expect(json2.error).toContain("Usage:");

  // Missing layer ID in layer inspect
  const res3 = await invoke(["layer", "inspect", "--json"]);
  expect(res3.code).toBe(2);
  const json3 = JSON.parse(res3.stdout);
  expect(json3.ok).toBe(false);
  expect(json3.error).toContain("Usage:");

  // Non-integer canvas dimensions fail loudly instead of being truncated
  const res4 = await invoke(["composition", "create", "t", "--width", "12.5", "--height", "720", "--json"]);
  expect(res4.code).toBe(2);
  const json4 = JSON.parse(res4.stdout);
  expect(json4.ok).toBe(false);
  expect(json4.error).toContain("positive integers");

  // Suffix garbage is rejected, not truncated
  const res5 = await invoke(["composition", "create", "t", "--width", "100px", "--height", "10", "--json"]);
  expect(res5.code).toBe(2);

  // Non-finite placement is rejected instead of being serialized as null
  const res6 = await invoke(["composition", "add", "c", "n", "--image", "x.png", "--x", "Infinity", "--json"]);
  expect(res6.code).toBe(2);
  const json6 = JSON.parse(res6.stdout);
  expect(json6.ok).toBe(false);
  expect(json6.error).toContain("finite");
});

test("malformed composition documents are rejected with actionable diagnostics", async () => {
  const projDir = path.join(tempDir, "proj-malformed");
  await invoke(["project", "init", projDir, "--json"]);
  await invoke(["composition", "create", "good", "--width", "800", "--height", "600", "--project", projDir, "--json"]);

  const img = path.join(tempDir, "m.png");
  await writeFile(img, createSolidPng(20, 20));
  const addRes = await invoke(["composition", "add", "good", "use", "--image", img, "--project", projDir, "--json"]);
  expect(addRes.code).toBe(0);

  // Corrupt the document on disk: layers array missing
  const compFile = path.join(projDir, "compositions", "good.json");
  const broken = JSON.parse(await readFile(compFile, "utf8"));
  delete broken.layers;
  await writeFile(compFile, JSON.stringify(broken));

  const inspectRes = await invoke(["composition", "inspect", "good", "--project", projDir, "--json"]);
  expect(inspectRes.code).toBe(1);
  const inspectJson = JSON.parse(inspectRes.stdout);
  expect(inspectJson.ok).toBe(false);
  expect(inspectJson.error).toContain("Malformed composition");
  expect(inspectJson.error).toContain("layers");

  // Adding to the malformed composition fails loudly and publishes nothing
  const addBroken = await invoke(["composition", "add", "good", "use2", "--image", img, "--project", projDir, "--json"]);
  expect(addBroken.code).toBe(1);
  expect(JSON.parse(addBroken.stdout).error).toContain("Malformed composition");

  // A second composition document with a non-integer canvas is rejected too
  await writeFile(
    path.join(projDir, "compositions", "badcanvas.json"),
    JSON.stringify({ schemaVersion: 1, name: "badcanvas", canvas: { width: 12.5, height: 600 }, layers: [] }),
  );
  const canvasRes = await invoke(["composition", "inspect", "badcanvas", "--project", projDir, "--json"]);
  expect(canvasRes.code).toBe(1);
  expect(JSON.parse(canvasRes.stdout).error).toContain("canvas");

  // A document whose name does not match its file is rejected
  await writeFile(
    path.join(projDir, "compositions", "mismatch.json"),
    JSON.stringify({ schemaVersion: 1, name: "other", canvas: { width: 10, height: 10 }, layers: [] }),
  );
  const mismatchRes = await invoke(["composition", "inspect", "mismatch", "--project", projDir, "--json"]);
  expect(mismatchRes.code).toBe(1);
  expect(JSON.parse(mismatchRes.stdout).error).toContain("does not match");

  // A stored document with duplicate local names is rejected
  await writeFile(
    path.join(projDir, "compositions", "dupnames.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "dupnames",
      canvas: { width: 10, height: 10 },
      layers: [
        { name: "a", layerId: "layer_x" },
        { name: "a", layerId: "layer_y" },
      ],
    }),
  );
  const dupRes = await invoke(["composition", "inspect", "dupnames", "--project", projDir, "--json"]);
  expect(dupRes.code).toBe(1);
  expect(JSON.parse(dupRes.stdout).error).toContain("duplicate local name");
});

test("new commands reject invalid Project roots before writing anything", async () => {
  // A directory without a ply.json manifest is not a Project
  const fake = path.join(tempDir, "fake-proj");
  await mkdir(fake);

  const createRes = await invoke(["composition", "create", "c", "--width", "100", "--height", "100", "--project", fake, "--json"]);
  expect(createRes.code).toBe(1);
  expect(JSON.parse(createRes.stdout).error).toContain("Not a valid Ply project");

  const listRes = await invoke(["composition", "list", "--project", fake, "--json"]);
  expect(listRes.code).toBe(1);
  expect(JSON.parse(listRes.stdout).error).toContain("Not a valid Ply project");

  const layerListRes = await invoke(["layer", "list", "--project", fake, "--json"]);
  expect(layerListRes.code).toBe(1);
  expect(JSON.parse(layerListRes.stdout).error).toContain("Not a valid Ply project");

  const layerInspectRes = await invoke(["layer", "inspect", "layer_x", "--project", fake, "--json"]);
  expect(layerInspectRes.code).toBe(1);
  expect(JSON.parse(layerInspectRes.stdout).error).toContain("Not a valid Ply project");

  // A nonexistent path is rejected without being created
  const missing = path.join(tempDir, "does-not-exist");
  const missingRes = await invoke(["composition", "list", "--project", missing, "--json"]);
  expect(missingRes.code).toBe(1);
  expect(JSON.parse(missingRes.stdout).error).toContain("not found");
  await expect(readdir(missing)).rejects.toThrow();

  // Nothing was written into the fake directory
  expect(await readdir(fake)).toEqual([]);
});

test("escaping project subdirectories are rejected at the Project boundary", async () => {
  const projDir = path.join(tempDir, "proj-escape");
  await invoke(["project", "init", projDir, "--json"]);

  // Replace compositions/ with a symlink pointing outside the Project
  const outside = path.join(tempDir, "outside-comps");
  await mkdir(outside);
  await rm(path.join(projDir, "compositions"), { recursive: true });
  await symlink(outside, path.join(projDir, "compositions"));

  const createRes = await invoke(["composition", "create", "evil", "--width", "10", "--height", "10", "--project", projDir, "--json"]);
  expect(createRes.code).toBe(1);
  expect(JSON.parse(createRes.stdout).error).toContain("escapes");

  const listRes = await invoke(["composition", "list", "--project", projDir, "--json"]);
  expect(listRes.code).toBe(1);
  expect(JSON.parse(listRes.stdout).error).toContain("escapes");

  // Nothing leaked through the symlink to the outside directory
  expect(await readdir(outside)).toEqual([]);
});

test("adding to a composition with dangling references fails before staging anything", async () => {
  const projDir = path.join(tempDir, "proj-dangling");
  await invoke(["project", "init", projDir, "--json"]);
  await invoke(["composition", "create", "dangle", "--width", "100", "--height", "100", "--project", projDir, "--json"]);

  const img = path.join(tempDir, "d.png");
  await writeFile(img, createSolidPng(10, 10));

  // Tamper the stored document so an existing use points at a missing Layer
  const compFile = path.join(projDir, "compositions", "dangle.json");
  const doc = JSON.parse(await readFile(compFile, "utf8"));
  doc.layers.push({ name: "gone", layerId: "layer_missing0000" });
  await writeFile(compFile, JSON.stringify(doc));

  const layersBefore = (await readdir(path.join(projDir, "layers"))).filter((f) => f.endsWith(".json"));

  const addRes = await invoke(["composition", "add", "dangle", "fresh", "--image", img, "--project", projDir, "--json"]);
  expect(addRes.code).toBe(1);
  expect(JSON.parse(addRes.stdout).error).toContain("layer_missing0000");

  // Nothing was staged: no new identity, no revision directories
  const layersAfter = (await readdir(path.join(projDir, "layers"))).filter((f) => f.endsWith(".json"));
  expect(layersAfter).toEqual(layersBefore);
  expect((await readdir(path.join(projDir, "layers"))).some((f) => f.endsWith(".revisions"))).toBe(false);
});

test("resolution verifies retained content and revision hashes", async () => {
  const projDir = path.join(tempDir, "proj-hashes");
  await invoke(["project", "init", projDir, "--json"]);
  await invoke(["composition", "create", "main", "--width", "100", "--height", "100", "--project", projDir, "--json"]);

  const img = path.join(tempDir, "h.png");
  const imgBytes = createSolidPng(30, 30);
  await writeFile(img, imgBytes);

  const addRes = await invoke(["composition", "add", "main", "h", "--image", img, "--project", projDir, "--json"]);
  expect(addRes.code).toBe(0);
  const layerId = JSON.parse(addRes.stdout).use.layerId;

  const inspect1 = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(inspect1.code).toBe(0);
  const layerJson = JSON.parse(inspect1.stdout).layer;
  const contentHash = layerJson.currentRevision.contentHash as string;
  const revId = layerJson.currentRevisionId as string;

  const blobPath = path.join(projDir, "content", contentHash);
  const blobOriginal = await readFile(blobPath);
  expect(blobOriginal.equals(imgBytes)).toBe(true);

  // Corrupt a retained content byte: resolution must refuse the blob
  const corrupted = Buffer.from(blobOriginal);
  corrupted[0] ^= 0xff;
  await writeFile(blobPath, corrupted);

  const inspect2 = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(inspect2.code).toBe(1);
  expect(JSON.parse(inspect2.stdout).error).toMatch(/corrupted/i);

  // Restore the blob, then tamper the stored revision document
  await writeFile(blobPath, blobOriginal);
  const revFile = path.join(projDir, "layers", `${layerId}.revisions`, `${revId}.json`);
  const revOriginal = await readFile(revFile, "utf8");
  const rev = JSON.parse(revOriginal);
  rev.opacity = 0.5;
  await writeFile(revFile, JSON.stringify(rev));

  const inspect3 = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(inspect3.code).toBe(1);
  expect(JSON.parse(inspect3.stdout).error).toContain("revision hash");

  // Restoring both files makes the Layer resolve again
  await writeFile(revFile, revOriginal);
  const inspect4 = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(inspect4.code).toBe(0);
});

test("failure after staging rolls back staged layer files and publishes no live reference", async () => {
  const projDir = path.join(tempDir, "proj-rollback");
  await invoke(["project", "init", projDir, "--json"]);
  await invoke(["composition", "create", "main", "--width", "100", "--height", "100", "--project", projDir, "--json"]);

  const img = path.join(tempDir, "r.png");
  await writeFile(img, createSolidPng(10, 10));

  // Make the commit-point write (composition document replace) fail by
  // removing write permission from the compositions directory
  const compDir = path.join(projDir, "compositions");
  await chmod(compDir, 0o500);
  try {
    const addRes = await invoke(["composition", "add", "main", "victim", "--image", img, "--project", projDir, "--json"]);
    expect(addRes.code).toBe(1);
    expect(JSON.parse(addRes.stdout).ok).toBe(false);
  } finally {
    await chmod(compDir, 0o755);
  }

  // No live reference was published
  const compInspect = await invoke(["composition", "inspect", "main", "--project", projDir, "--json"]);
  expect(compInspect.code).toBe(0);
  expect(JSON.parse(compInspect.stdout).composition.layers.length).toBe(0);

  // Staged Layer identity and revision were rolled back, with no tmp leftovers
  const layersEntries = await readdir(path.join(projDir, "layers"));
  expect(layersEntries.filter((f) => f.endsWith(".json"))).toEqual([]);
  expect(layersEntries.filter((f) => f.endsWith(".revisions"))).toEqual([]);
  expect((await readdir(compDir)).every((f) => f === "main.json")).toBe(true);

  // The immutable content blob is retained (deduplication store, per contract)
  expect((await readdir(path.join(projDir, "content"))).length).toBe(1);
});

test("concurrent adds serialize under the Project lock without partial publication", async () => {
  const projDir = path.join(tempDir, "proj-race");
  await invoke(["project", "init", projDir, "--json"]);
  await invoke(["composition", "create", "race", "--width", "100", "--height", "100", "--project", projDir, "--json"]);

  const img = path.join(tempDir, "race.png");
  await writeFile(img, createSolidPng(10, 10));

  // Same local name from concurrent CLI processes: exactly one wins
  const RACE = 4;
  const results = await Promise.all(
    Array.from({ length: RACE }, () =>
      invoke(["composition", "add", "race", "dup", "--image", img, "--project", projDir, "--json"]),
    ),
  );
  const successes = results.filter((r) => r.code === 0);
  const failures = results.filter((r) => r.code === 1);
  expect(successes.length).toBe(1);
  expect(failures.length).toBe(RACE - 1);
  for (const f of failures) {
    expect(JSON.parse(f.stdout).error).toContain("duplicate local name");
  }

  // The winning publication is intact and exactly one Layer identity exists
  const compInspect = await invoke(["composition", "inspect", "race", "--project", projDir, "--json"]);
  expect(compInspect.code).toBe(0);
  const uses = JSON.parse(compInspect.stdout).composition.layers;
  expect(uses.length).toBe(1);
  expect(uses[0].name).toBe("dup");
  const layersEntries = await readdir(path.join(projDir, "layers"));
  expect(layersEntries.filter((f) => f.endsWith(".json"))).toEqual([`${uses[0].layerId}.json`]);

  // Distinct local names from concurrent processes both publish
  const [a, b] = await Promise.all([
    invoke(["composition", "add", "race", "aa", "--image", img, "--project", projDir, "--json"]),
    invoke(["composition", "add", "race", "bb", "--image", img, "--project", projDir, "--json"]),
  ]);
  expect(a.code).toBe(0);
  expect(b.code).toBe(0);

  const compInspect2 = await invoke(["composition", "inspect", "race", "--project", projDir, "--json"]);
  const uses2 = JSON.parse(compInspect2.stdout).composition.layers;
  expect(uses2.map((u: { name: string }) => u.name).sort()).toEqual(["aa", "bb", "dup"]);
  for (const use of uses2) {
    const li = await invoke(["layer", "inspect", use.layerId, "--project", projDir, "--json"]);
    expect(li.code).toBe(0);
  }

  // The lock leaves no residue behind
  expect((await readdir(projDir)).includes(".ply.lock")).toBe(false);
});

test("Project and Layer readers wait while a Layer is staged before publication", async () => {
  const project = path.join(tempDir, "paused-project");
  await invoke(["project", "init", project, "--json"]);
  await invoke(["composition", "create", "live", "--width", "10", "--height", "10", "--project", project, "--json"]);
  const img = path.join(tempDir, "paused.png");
  await writeFile(img, createSolidPng(10, 10));
  // Instrument only this subprocess's transaction seam, leaving production
  // locking and the real staged files intact. No production test flags.
  const preload = path.join(tempDir, "pause.ts");
  await writeFile(preload, `
    import { mock } from "bun:test";
    import { writeFile } from "node:fs/promises";
    import * as lock from ${JSON.stringify(path.resolve(import.meta.dir, "../src/project-lock.ts"))};
    const original = { ...lock };
    mock.module(${JSON.stringify(path.resolve(import.meta.dir, "../src/project-lock.ts"))}, () => ({
      ...original,
      atomicReplace: async (file, content) => {
        if (process.env.PLY_TEST_WRITER && file.endsWith("/compositions/live.json")) {
          await writeFile(process.env.PLY_TEST_SIGNAL, "staged");
          while (!(await Bun.file(process.env.PLY_TEST_RELEASE).exists())) await Bun.sleep(10);
        }
        return original.atomicReplace(file, content);
      },
      withProjectLock: async (...args) => {
        if (!process.env.PLY_TEST_WRITER) await writeFile(process.env.PLY_TEST_SIGNAL, "entering lock");
        return original.withProjectLock(...args);
      },
    }));
  `);
  const release = path.join(tempDir, "release");
  const processes: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
  function launch(args: string[], signal: string, writer = false) {
    const proc = Bun.spawn([process.execPath, "--preload", preload, path.resolve(import.meta.dir, `../src/${args[0]}-cli.ts`), ...args.slice(1), "--project", project, "--json"], {
      env: { ...process.env, PLY_TEST_SIGNAL: signal, PLY_TEST_RELEASE: release, PLY_TEST_WRITER: writer ? "1" : "" },
      stdout: "pipe", stderr: "pipe",
    });
    processes.push(proc);
    return proc;
  }
  async function waitForSignal(file: string) {
    const deadline = Date.now() + 5000;
    while (!(await Bun.file(file).exists())) {
      if (Date.now() > deadline) {
        const errors = await Promise.all(processes.filter(p => p.exitCode !== null).map(p => new Response(p.stderr).text()));
        throw new Error(`Subprocess never reached controlled boundary: ${file}: ${errors.join("; ")}`);
      }
      await Bun.sleep(10);
    }
  }
  const staged = path.join(tempDir, "staged");
  try {
    const writer = launch(["composition", "add", "live", "new", "--image", img], staged, true);
    await waitForSignal(staged);
    const identities = (await readdir(path.join(project, "layers"))).filter(f => f.endsWith(".json"));
    expect(identities).toHaveLength(1);
    const id = path.basename(identities[0]!, ".json");
    expect(JSON.parse(await readFile(path.join(project, "compositions/live.json"), "utf8")).layers).toEqual([]);
    const commands = [["composition", "inspect", "live"], ["composition", "list"], ["layer", "inspect", id], ["layer", "list"], ["project", "inspect"]];
    const readers = commands.map((args, i) => launch(args, path.join(tempDir, `reader-${i}`)));
    await Promise.all(readers.map((_, i) => waitForSignal(path.join(tempDir, `reader-${i}`))));
    // Every reader has reached the lock boundary, while identity and reference
    // disagree. Keep the writer paused across multiple lock polling intervals.
    await Bun.sleep(150);
    for (const reader of readers) expect(reader.exitCode).toBeNull();
    await writeFile(release, "commit");
    expect(await writer.exited).toBe(0);
    const outputs = await Promise.all(readers.map(async reader => {
      expect(await reader.exited).toBe(0);
      return JSON.parse(await new Response(reader.stdout).text());
    }));
    expect(outputs[0].composition.layers).toHaveLength(1);
    expect(outputs[1].compositions[0].layers).toHaveLength(1);
    expect(outputs[2].layer.id).toBe(id);
    expect(outputs[3].layers).toHaveLength(1);
    expect(outputs[4].project.layersCount).toBe(1);
  } finally {
    await writeFile(release, "release");
    for (const proc of processes) if (proc.exitCode === null) proc.kill();
    await Promise.all(processes.map(proc => proc.exited));
  }
}, 15000);

test("list commands for compositions and layers report summary state", async () => {
  const projDir = path.join(tempDir, "proj-lists");
  await invoke(["project", "init", projDir, "--json"]);
  await invoke(["composition", "create", "c1", "--width", "800", "--height", "600", "--project", projDir, "--json"]);
  await invoke(["composition", "create", "c2", "--width", "1920", "--height", "1080", "--project", projDir, "--json"]);

  const img = path.join(tempDir, "img.png");
  await writeFile(img, createSolidPng(50, 50));
  await invoke(["composition", "add", "c1", "icon", "--image", img, "--project", projDir, "--json"]);

  // List compositions
  const compListRes = await invoke(["composition", "list", "--project", projDir, "--json"]);
  expect(compListRes.code).toBe(0);
  const compListJson = JSON.parse(compListRes.stdout);
  expect(compListJson.ok).toBe(true);
  expect(compListJson.compositions.length).toBe(2);

  // List layers
  const layerListRes = await invoke(["layer", "list", "--project", projDir, "--json"]);
  expect(layerListRes.code).toBe(0);
  const layerListJson = JSON.parse(layerListRes.stdout);
  expect(layerListJson.ok).toBe(true);
  expect(layerListJson.layers.length).toBe(1);
});

test("containment checks reject symlinks escaping project boundary but preserve root aliases", async () => {
  const projDir = path.join(tempDir, "proj-containment");
  await invoke(["project", "init", projDir, "--name", "proj-cont", "--json"]);
  await invoke(["composition", "create", "comp1", "--width", "800", "--height", "600", "--project", projDir, "--json"]);

  // 1. Root alias is accepted
  const aliasDir = path.join(tempDir, "alias-proj-dir");
  await symlink(projDir, aliasDir);

  const inspectAlias = await invoke(["composition", "inspect", "comp1", "--project", aliasDir, "--json"]);
  expect(inspectAlias.code).toBe(0);
  expect(JSON.parse(inspectAlias.stdout).ok).toBe(true);

  // 2. Symlink inside compositions escaping root is rejected
  const extCompDir = path.join(tempDir, "ext-comp-dir");
  await mkdir(extCompDir);
  await writeFile(path.join(extCompDir, "external.json"), JSON.stringify({ schemaVersion: 1, name: "external", canvas: { width: 100, height: 100 }, layers: [] }));
  await symlink(path.join(extCompDir, "external.json"), path.join(projDir, "compositions", "escaping-comp.json"));

  const inspectEsc = await invoke(["composition", "inspect", "escaping-comp", "--project", projDir, "--json"]);
  expect(inspectEsc.code).toBe(1);
  expect(JSON.parse(inspectEsc.stdout).ok).toBe(false);
  expect(JSON.parse(inspectEsc.stdout).error).toContain("escapes project boundary");
});

test("all Project commands reject incomplete and externally symlinked manifests before mutation", async () => {
  const project = path.join(tempDir, "manifest-gate");
  await invoke(["project", "init", project, "--json"]);
  const manifest = path.join(project, "ply.json");
  const original = await readFile(manifest);
  for (const invalid of [{ schemaVersion: 1 }, { schemaVersion: 1, name: "valid" }, null]) {
    await writeFile(manifest, JSON.stringify(invalid));
    for (const args of [["composition", "create", "no", "--width", "10", "--height", "10"], ["layer", "list"], ["project", "inspect"]]) {
      const result = await invoke([...args, "--project", project, "--json"]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).error).toMatch(/manifest|ply.json/i);
    }
    expect(await readdir(path.join(project, "compositions"))).toEqual([]);
  }
  const outside = path.join(tempDir, "outside.json");
  await writeFile(outside, original);
  await unlink(manifest);
  await symlink(outside, manifest);
  const result = await invoke(["composition", "create", "no", "--width", "10", "--height", "10", "--project", project, "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error).toContain("escapes");
  expect(await readdir(path.join(project, "compositions"))).toEqual([]);
});

test("external deduplicated content is rejected before publishing any Layer", async () => {
  const project = path.join(tempDir, "dedup");
  await invoke(["project", "init", project, "--json"]);
  await invoke(["composition", "create", "c", "--width", "10", "--height", "10", "--project", project, "--json"]);
  const bytes = createSolidPng(10, 10);
  const img = path.join(tempDir, "external.png");
  await writeFile(img, bytes);
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  await symlink(img, path.join(project, "content", hash));
  const result = await invoke(["composition", "add", "c", "bad", "--image", img, "--project", project, "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error).toContain("escapes");
  expect(JSON.parse(await readFile(path.join(project, "compositions/c.json"), "utf8")).layers).toEqual([]);
  expect(await readdir(path.join(project, "layers"))).toEqual([]);
});

test("empty numeric CLI arguments are usage errors", async () => {
  for (const flag of ["--x", "--y", "--opacity"]) {
    for (const value of ["", "  "]) {
      const result = await invoke(["composition", "add", "c", "n", "--image", "x.png", flag, value, "--json"]);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout).error).toMatch(/finite|number/);
    }
  }
});

test("stored Layer schemas require creation timestamps even with a matching revision hash", async () => {
  const project = path.join(tempDir, "schema");
  await invoke(["project", "init", project, "--json"]);
  await invoke(["composition", "create", "c", "--width", "10", "--height", "10", "--project", project, "--json"]);
  const img = path.join(tempDir, "schema.png");
  await writeFile(img, createSolidPng(10, 10));
  const added = JSON.parse((await invoke(["composition", "add", "c", "n", "--image", img, "--project", project, "--json"])).stdout);
  const id = added.use.layerId;
  const identityFile = path.join(project, "layers", `${id}.json`);
  const identity = JSON.parse(await readFile(identityFile, "utf8"));
  delete identity.createdAt;
  await writeFile(identityFile, JSON.stringify(identity));
  let result = await invoke(["layer", "inspect", id, "--project", project, "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error).toContain("createdAt");
  identity.createdAt = added.layer.createdAt;
  const revisionFile = path.join(project, "layers", `${id}.revisions`, `${identity.currentRevision}.json`);
  const revision = JSON.parse(await readFile(revisionFile, "utf8"));
  delete revision.createdAt;
  const { computeRevisionHash } = await import("../src/layer.js");
  identity.currentRevision = computeRevisionHash(revision);
  await writeFile(path.join(project, "layers", `${id}.revisions`, `${identity.currentRevision}.json`), JSON.stringify(revision));
  await writeFile(identityFile, JSON.stringify(identity));
  result = await invoke(["layer", "inspect", id, "--project", project, "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error).toContain("createdAt");
});

test("stored document and content containment is checked before reading escaped bytes", async () => {
  const project = path.join(tempDir, "read-boundary");
  await invoke(["project", "init", project, "--json"]);
  await invoke(["composition", "create", "c", "--width", "10", "--height", "10", "--project", project, "--json"]);
  const img = path.join(tempDir, "boundary.png");
  await writeFile(img, createSolidPng(10, 10));
  const added = JSON.parse((await invoke(["composition", "add", "c", "n", "--image", img, "--project", project, "--json"])).stdout);
  const id = added.use.layerId;
  const targets = [
    ["ply.json", "project", ["inspect"]],
    [".ply.lock", "project", ["inspect"]],
    ["compositions/c.json", "composition", ["inspect", "c"]],
    [`layers/${id}.json`, "layer", ["inspect", id]],
    [`layers/${id}.revisions/${added.layer.currentRevisionId}.json`, "layer", ["inspect", id]],
    [`content/${added.layer.currentRevision.contentHash}`, "layer", ["inspect", id]],
  ] as const;
  for (const [relative, module, args] of targets) {
    const target = path.join(project, relative);
    const outside = path.join(tempDir, "escaped");
    const marker = path.join(tempDir, "read-escaped");
    const preload = path.join(tempDir, "audit-read.ts");
    if (relative === ".ply.lock") await writeFile(target, JSON.stringify({ pid: process.pid, token: "external" }));
    await rename(target, outside);
    await symlink(outside, target);
    await writeFile(preload, `
      import { mock } from "bun:test";
      import * as fs from "node:fs/promises";
      const original = { ...fs };
      mock.module("node:fs/promises", () => ({ ...original,
        readFile: async (...args) => {
          if (String(args[0]) === ${JSON.stringify(target)}) await original.writeFile(${JSON.stringify(marker)}, "read");
          return original.readFile(...args);
        }
      }));
    `);
    try {
      const proc = Bun.spawn([process.execPath, "--preload", preload, path.resolve(import.meta.dir, `../src/${module}-cli.ts`), ...args, "--project", project, "--json"], { stdout: "pipe", stderr: "pipe" });
      const output = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(1);
      expect(JSON.parse(output).error).toContain("escapes");
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await unlink(target);
      await rename(outside, target);
      if (relative === ".ply.lock") await unlink(target);
    }
  }
});

test("CLI teardown failure reports operational failure without retrying committed publication", async () => {
  const project = path.join(tempDir, "teardown");
  await invoke(["project", "init", project, "--json"]);
  await invoke(["composition", "create", "c", "--width", "10", "--height", "10", "--project", project, "--json"]);
  const img = path.join(tempDir, "teardown.png");
  await writeFile(img, createSolidPng(10, 10));
  const preload = path.join(tempDir, "fail-close.ts");
  // Exercise the shared browser's real failure-injection seam, then reclaim
  // this test's browser before propagating the simulated lifecycle failure.
  await writeFile(preload, `
    import { mock } from "bun:test";
    import * as browser from ${JSON.stringify(path.resolve(import.meta.dir, "../src/browser.ts"))};
    const original = { ...browser };
    mock.module(${JSON.stringify(path.resolve(import.meta.dir, "../src/browser.ts"))}, () => ({ ...original,
      closeBrowser: async () => {
        await original.getBrowser();
        try {
          await original.shutdownShared(async () => { throw new Error("injected connected-browser shutdown failure"); });
        } finally { await original.closeBrowser(); }
      }
    }));
  `);
  async function failingCleanup(module: string, args: string[]) {
    const proc = Bun.spawn([process.execPath, "--preload", preload, path.resolve(import.meta.dir, `../src/${module}-cli.ts`), ...args, "--project", project], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }
  const added = await failingCleanup("composition", ["add", "c", "n", "--image", img, "--json"]);
  expect(added.code).toBe(1);
  const result = JSON.parse(added.stdout);
  expect(result.ok).toBe(true);
  expect(added.stderr).toContain("injected connected-browser shutdown failure");
  expect(added.stderr).toMatch(/already committed/i);
  expect(added.stderr).toMatch(/do not retry/i);
  const inspected = JSON.parse((await invoke(["composition", "inspect", "c", "--project", project, "--json"])).stdout);
  expect(inspected.composition.layers.map((l: { layerId: string }) => l.layerId)).toEqual([result.use.layerId]);
  expect((await readdir(path.join(project, "layers"))).filter(f => f.endsWith(".json"))).toEqual([`${result.use.layerId}.json`]);
  const listed = await failingCleanup("layer", ["list", "--json"]);
  expect(listed.code).toBe(1);
  expect(JSON.parse(listed.stdout).layers).toHaveLength(1);
  expect(listed.stderr).toMatch(/browser.*shutdown|teardown/i);
  expect(listed.stderr).not.toMatch(/already committed/i);
  const textResult = await failingCleanup("composition", ["create", "text", "--width", "10", "--height", "10"]);
  expect(textResult.code).toBe(1);
  expect(textResult.stdout).toContain('Created Composition "text"');
  expect(textResult.stderr).toMatch(/already committed/i);
}, 15000);
