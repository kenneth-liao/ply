/**
 * Layer editing through immutable revisions and explicit in-place propagation
 * (#82, spec #77 US-004 / US-002 / US-008 / US-006 / DEC-001–006).
 *
 * Verifies:
 * - In-place revision advancement for image and text Layers preserving history and stable identity.
 * - Single-referrer edit succeeds without --in-place flag or warning.
 * - Zero-referrer edit succeeds under same identity with count 0.
 * - Multi-referrer edit without --in-place fails with exit 1, naming all referring Compositions and count in text and JSON.
 * - Multi-referrer edit with --in-place updates all referring Compositions in storage and visual rendering.
 * - Fail-closed authoritative referrer discovery under Project lock on malformed or unreadable Compositions.
 * - Competing CLI mutations serialize under .ply.lock, proving referrer discovery cannot become stale before publication.
 * - Retained historical revisions and blobs remain intact and hash-verified.
 * - CLI argument validation, accurate help, and Project relocation support.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, rename, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { encodePngRgba, readPngHeader, decodePng } from "../src/png.js";
import { computeRevisionHash, LAYER_SCHEMA_VERSION, type LayerImageRevision, type LayerTextRevision } from "../src/layer.js";

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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-edit-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "edit-test-proj"]);
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

test("single-referrer image Layer edit advances revision in-place without --in-place flag", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 100, RED));
  const blueImg = path.join(tempDir, "blue.png");
  await writeFile(blueImg, solidPng(120, 80, BLUE));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 20, opacity: 0.9 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;
  const oldContentHash = addRes.layer.currentRevision.contentHash as string;

  // Single referrer edit: update image source, placement and opacity
  const editRes = await invoke([
    "layer", "edit", layerId,
    "--image", blueImg,
    "--x", "30",
    "--y", "40",
    "--opacity", "0.75",
    "--project", projDir,
    "--json",
  ]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.ok).toBe(true);
  expect(editJson.layer.id).toBe(layerId);
  expect(editJson.layer.currentRevisionId).not.toBe(oldRevId);
  expect(editJson.referringCompositions).toEqual(["poster"]);
  expect(editJson.referrersCount).toBe(1);

  const newRev = editJson.layer.currentRevision;
  expect(newRev.kind).toBe("image");
  expect(newRev.x).toBe(30);
  expect(newRev.y).toBe(40);
  expect(newRev.opacity).toBe(0.75);
  expect(newRev.width).toBe(120);
  expect(newRev.height).toBe(80);
  expect(newRev.contentHash).not.toBe(oldContentHash);

  // Historical revision file and content blob remain intact on disk
  const oldRevFile = path.join(projDir, "layers", `${layerId}.revisions`, `${oldRevId}.json`);
  const oldRevDoc = JSON.parse(await readFile(oldRevFile, "utf8")) as LayerImageRevision;
  expect(oldRevDoc.contentHash).toBe(oldContentHash);
  expect(oldRevDoc.x).toBe(10);
  expect(oldRevDoc.y).toBe(20);
  expect(oldRevDoc.opacity).toBe(0.9);

  const oldBlob = await readFile(path.join(projDir, "content", oldContentHash));
  expect(createHash("sha256").update(oldBlob).digest("hex")).toBe(oldContentHash);

  // Compact default output
  const compactRes = await invoke([
    "layer", "edit", layerId,
    "--x", "50",
    "--project", projDir,
  ]);
  expect(compactRes.code).toBe(0);
  const lines = compactRes.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(layerId);
  expect(lines[0]).toContain("poster");
});

test("single-referrer text Layer edit advances revision in-place with font/color/size changes", async () => {
  await makeComp("doc", 400, 300);
  const addRes = await addTextLayer("doc", "heading", "Hello", { font: "Anton", fontSize: 36, color: "#ffffff", x: 5, y: 10 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;
  const oldFontHash = addRes.layer.currentRevision.contentHash as string;

  // Edit text, fontSize, color, placement without changing font
  const edit1 = await invoke([
    "layer", "edit", layerId,
    "--text", "World",
    "--font-size", "48",
    "--color", "#ff0000",
    "--x", "20",
    "--project", projDir,
    "--json",
  ]);
  expect(edit1.code).toBe(0);
  const edit1Json = JSON.parse(edit1.stdout);
  expect(edit1Json.ok).toBe(true);
  expect(edit1Json.layer.currentRevision.text).toBe("World");
  expect(edit1Json.layer.currentRevision.fontSize).toBe(48);
  expect(edit1Json.layer.currentRevision.color).toBe("#ff0000");
  expect(edit1Json.layer.currentRevision.x).toBe(20);
  expect(edit1Json.layer.currentRevision.y).toBe(10); // preserved
  // Font bytes were preserved without re-reading
  expect(edit1Json.layer.currentRevision.contentHash).toBe(oldFontHash);

  // Edit font family explicitly to "Source Sans 3"
  const edit2 = await invoke([
    "layer", "edit", layerId,
    "--font", "Source Sans 3",
    "--project", projDir,
    "--json",
  ]);
  expect(edit2.code).toBe(0);
  const edit2Json = JSON.parse(edit2.stdout);
  expect(edit2Json.ok).toBe(true);
  expect(edit2Json.layer.currentRevision.contentHash).not.toBe(oldFontHash);
  // Text, fontSize, color, placement preserved from previous edit
  expect(edit2Json.layer.currentRevision.text).toBe("World");
  expect(edit2Json.layer.currentRevision.fontSize).toBe(48);
  expect(edit2Json.layer.currentRevision.color).toBe("#ff0000");

  // Old font blob still exists and matches hash
  const oldBlob = await readFile(path.join(projDir, "content", oldFontHash));
  expect(createHash("sha256").update(oldBlob).digest("hex")).toBe(oldFontHash);
});

test("zero-referrer Layer edits under the same identity with count 0", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  await makeComp("temp-comp", 200, 200);
  const addRes = await addImageLayer("temp-comp", "temp-use", redImg);
  const layerId = addRes.use.layerId as string;

  // Remove the composition document to simulate an unreferenced/retained Layer
  await rm(path.join(projDir, "compositions", "temp-comp.json"));

  const editRes = await invoke([
    "layer", "edit", layerId,
    "--x", "100",
    "--project", projDir,
    "--json",
  ]);
  expect(editRes.code).toBe(0);
  const json = JSON.parse(editRes.stdout);
  expect(json.ok).toBe(true);
  expect(json.layer.currentRevision.x).toBe(100);
  expect(json.referringCompositions).toEqual([]);
  expect(json.referrersCount).toBe(0);
});

test("no-op edit returning identical values creates no unnecessary revision churn", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  await makeComp("noop-comp", 200, 200);
  const addRes = await addImageLayer("noop-comp", "red-layer", redImg, { x: 10, y: 20, opacity: 0.8 });
  const layerId = addRes.use.layerId as string;
  const initialRevId = addRes.layer.currentRevisionId as string;

  // Edit with identical values
  const noopRes = await invoke([
    "layer", "edit", layerId,
    "--x", "10",
    "--y", "20",
    "--opacity", "0.8",
    "--project", projDir,
    "--json",
  ]);
  expect(noopRes.code).toBe(0);
  const json = JSON.parse(noopRes.stdout);
  expect(json.ok).toBe(true);
  expect(json.layer.currentRevisionId).toBe(initialRevId);

  // Exactly 1 revision file exists in storage
  const revisions = await readdir(path.join(projDir, "layers", `${layerId}.revisions`));
  expect(revisions).toHaveLength(1);
});

test("multi-referrer Layer edit without --in-place fails with exit 1 and names all referrers", async () => {
  const greenImg = path.join(tempDir, "green.png");
  await writeFile(greenImg, solidPng(80, 80, GREEN));

  await makeComp("comp-a", 300, 300);
  await makeComp("comp-b", 400, 400);

  const addRes = await addImageLayer("comp-a", "logo", greenImg);
  const layerId = addRes.use.layerId as string;

  // Share the Layer with comp-b by adding a use to comp-b's document
  const compBFile = path.join(projDir, "compositions", "comp-b.json");
  const compBDoc = JSON.parse(await readFile(compBFile, "utf8"));
  compBDoc.layers.push({ name: "brand-logo", layerId });
  await writeFile(compBFile, JSON.stringify(compBDoc, null, 2) + "\n");

  // Attempt edit without --in-place: MUST fail with exit 1 and report both referrers
  const editFail = await invoke([
    "layer", "edit", layerId,
    "--opacity", "0.5",
    "--project", projDir,
    "--json",
  ]);
  expect(editFail.code).toBe(1);
  const failJson = JSON.parse(editFail.stdout);
  expect(failJson.ok).toBe(false);
  expect(failJson.error).toContain("2 Compositions");
  expect(failJson.error).toContain("comp-a");
  expect(failJson.error).toContain("comp-b");
  expect(failJson.error).toContain("--in-place");
  expect(failJson.referringCompositions).toEqual(["comp-a", "comp-b"]);
  expect(failJson.referrersCount).toBe(2);

  // State is completely unchanged
  const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(JSON.parse(inspect.stdout).layer.currentRevision.opacity).toBe(1.0);
});

test("multi-referrer Layer edit with --in-place updates all referring Compositions in rendered output", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 100, RED));
  const yellowImg = path.join(tempDir, "yellow.png");
  await writeFile(yellowImg, solidPng(100, 100, YELLOW));

  await makeComp("banner-1", 200, 200);
  await makeComp("banner-2", 200, 200);

  const addRes = await addImageLayer("banner-1", "badge", redImg, { x: 0, y: 0 });
  const layerId = addRes.use.layerId as string;

  // Share layer into banner-2
  const comp2File = path.join(projDir, "compositions", "banner-2.json");
  const comp2Doc = JSON.parse(await readFile(comp2File, "utf8"));
  comp2Doc.layers.push({ name: "shared-badge", layerId });
  await writeFile(comp2File, JSON.stringify(comp2Doc, null, 2) + "\n");

  // Edit in-place with --in-place
  const editRes = await invoke([
    "layer", "edit", layerId,
    "--image", yellowImg,
    "--in-place",
    "--project", projDir,
    "--json",
  ]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.ok).toBe(true);
  expect(editJson.referringCompositions).toEqual(["banner-1", "banner-2"]);
  expect(editJson.referrersCount).toBe(2);

  // Render banner-1 and banner-2: both must show yellow pixels (255, 255, 0)
  const render1 = await invoke(["composition", "render", "banner-1", "--project", projDir, "--json"]);
  expect(render1.code).toBe(0);
  const png1 = decodePng(await readFile(JSON.parse(render1.stdout).render.output));
  expect(pixel(png1, 50, 50).every((v, i) => close(v, YELLOW[i]!))).toBe(true);

  const render2 = await invoke(["composition", "render", "banner-2", "--project", projDir, "--json"]);
  expect(render2.code).toBe(0);
  const png2 = decodePng(await readFile(JSON.parse(render2.stdout).render.output));
  expect(pixel(png2, 50, 50).every((v, i) => close(v, YELLOW[i]!))).toBe(true);
});

test("referrer discovery fails closed under Project lock when any Composition document is malformed", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  await makeComp("valid-comp", 200, 200);
  const addRes = await addImageLayer("valid-comp", "item", redImg);
  const layerId = addRes.use.layerId as string;

  // Introduce an unreadable/malformed composition document in compositions/
  const brokenCompFile = path.join(projDir, "compositions", "broken.json");
  await writeFile(brokenCompFile, "{ this is not valid JSON }");

  // Edit must fail closed: cannot ascertain whether broken.json refers to layerId
  const editRes = await invoke([
    "layer", "edit", layerId,
    "--x", "25",
    "--project", projDir,
    "--json",
  ]);
  expect(editRes.code).toBe(1);
  const json = JSON.parse(editRes.stdout);
  expect(json.ok).toBe(false);
  expect(json.error).toMatch(/malformed|composition/i);

  // No new revision was staged
  const revisions = await readdir(path.join(projDir, "layers", `${layerId}.revisions`));
  expect(revisions).toHaveLength(1);
});

test("rejects kind-incompatible edit options and validates arguments with exit code 2", async () => {
  const img = path.join(tempDir, "img.png");
  await writeFile(img, solidPng(20, 20, BLUE));
  await makeComp("types", 100, 100);

  const imgLayerRes = await addImageLayer("types", "img-layer", img);
  const imgLayerId = imgLayerRes.use.layerId as string;

  const textLayerRes = await addTextLayer("types", "txt-layer", "Text");
  const txtLayerId = textLayerRes.use.layerId as string;

  // Passing text options to image layer: runtime error 1 (incompatible kind)
  const badImageEdit = await invoke([
    "layer", "edit", imgLayerId,
    "--text", "Cannot be text",
    "--project", projDir,
    "--json",
  ]);
  expect(badImageEdit.code).toBe(1);
  expect(JSON.parse(badImageEdit.stdout).error).toMatch(/text.*image|incompatible/i);

  // Passing image option to text layer: runtime error 1 (incompatible kind)
  const badTextEdit = await invoke([
    "layer", "edit", txtLayerId,
    "--image", img,
    "--project", projDir,
    "--json",
  ]);
  expect(badTextEdit.code).toBe(1);
  expect(JSON.parse(badTextEdit.stdout).error).toMatch(/image.*text|incompatible/i);

  // Missing layer ID: usage error 2
  const noId = await invoke(["layer", "edit", "--project", projDir, "--json"]);
  expect(noId.code).toBe(2);

  // No edit options provided: usage error 2
  const noOptions = await invoke(["layer", "edit", imgLayerId, "--project", projDir, "--json"]);
  expect(noOptions.code).toBe(2);
  expect(JSON.parse(noOptions.stdout).error).toMatch(/no edit options/i);

  // Invalid opacity: usage error 2
  const badOpacity = await invoke(["layer", "edit", imgLayerId, "--opacity", "2.5", "--project", projDir, "--json"]);
  expect(badOpacity.code).toBe(2);

  // Invalid hex color: runtime/usage error
  const badColor = await invoke(["layer", "edit", txtLayerId, "--color", "not-a-color", "--project", projDir, "--json"]);
  expect(badColor.code).toBe(1);
});

test("layer edit succeeds after Project relocation", async () => {
  const img = path.join(tempDir, "dot.png");
  await writeFile(img, solidPng(30, 30, RED));
  await makeComp("reloc-comp", 200, 200);
  const addRes = await addImageLayer("reloc-comp", "dot", img);
  const layerId = addRes.use.layerId as string;

  // Relocate Project directory
  const movedProj = path.join(tempDir, "moved-project-dir");
  await rename(projDir, movedProj);

  const editRes = await invoke([
    "layer", "edit", layerId,
    "--x", "75",
    "--y", "85",
    "--project", movedProj,
    "--json",
  ]);
  expect(editRes.code).toBe(0);
  const json = JSON.parse(editRes.stdout);
  expect(json.ok).toBe(true);
  expect(json.layer.currentRevision.x).toBe(75);
  expect(json.layer.currentRevision.y).toBe(85);

  const inspect = await invoke(["layer", "inspect", layerId, "--project", movedProj, "--json"]);
  expect(inspect.code).toBe(0);
  expect(JSON.parse(inspect.stdout).layer.currentRevision.x).toBe(75);
});

test("help documents layer edit options and --json failures stay valid JSON", async () => {
  const help = await invoke(["layer", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("ply layer edit");
  expect(help.stdout).toContain("--in-place");
  expect(help.stdout).toContain("--image");
  expect(help.stdout).toContain("--text");
  expect(help.stdout).toContain("--font");
  expect(help.stdout).toContain("--opacity");

  const missingLayer = await invoke(["layer", "edit", "layer_nonexistent", "--x", "10", "--project", projDir, "--json"]);
  expect(missingLayer.code).toBe(1);
  const parsed = JSON.parse(missingLayer.stdout);
  expect(parsed.ok).toBe(false);
  expect(typeof parsed.error).toBe("string");
});

test("SPEC-1 / CRAFT-2: failure during identity publication rolls back staged revision document and leaves historical state intact", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  const blueImg = path.join(tempDir, "blue.png");
  await writeFile(blueImg, solidPng(70, 70, BLUE));

  await makeComp("main-comp", 200, 200);
  // Initial creation: rev 1 with content blob A
  const addRes = await addImageLayer("main-comp", "badge", redImg, { x: 5, y: 5, opacity: 1.0 });
  const layerId = addRes.use.layerId as string;
  const rev1Id = addRes.layer.currentRevisionId as string;
  const blobA = addRes.layer.currentRevision.contentHash as string;

  // Create a non-current historical revision (rev 2 with content blob B) before the injected failure
  const edit1Res = await invoke([
    "layer",
    "edit",
    layerId,
    "--image",
    blueImg,
    "--x",
    "15",
    "--y",
    "15",
    "--project",
    projDir,
    "--json",
  ]);
  expect(edit1Res.code).toBe(0);
  const edit1Json = JSON.parse(edit1Res.stdout);
  const rev2Id = edit1Json.layer.currentRevisionId as string;
  const blobB = edit1Json.layer.currentRevision.contentHash as string;
  expect(rev2Id).not.toBe(rev1Id);
  expect(blobB).not.toBe(blobA);

  // Snapshot all historical revision documents, content blobs, identity document, and composition document
  const identityFile = path.join(projDir, "layers", `${layerId}.json`);
  const rev1File = path.join(projDir, "layers", `${layerId}.revisions`, `${rev1Id}.json`);
  const rev2File = path.join(projDir, "layers", `${layerId}.revisions`, `${rev2Id}.json`);
  const blobAFile = path.join(projDir, "content", blobA);
  const blobBFile = path.join(projDir, "content", blobB);
  const compFile = path.join(projDir, "compositions", "main-comp.json");

  const snapIdentity = await readFile(identityFile);
  const snapRev1 = await readFile(rev1File);
  const snapRev2 = await readFile(rev2File);
  const snapBlobA = await readFile(blobAFile);
  const snapBlobB = await readFile(blobBFile);
  const snapComp = await readFile(compFile);

  // Preload that simulates an atomicReplace failure when replacing layers/<layerId>.json
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
        if (process.env.PLY_TEST_FAIL_IDENTITY && file.endsWith(${JSON.stringify(path.join("layers", `${layerId}.json`))})) {
          throw new Error("Simulated I/O disk failure during identity document commit point");
        }
        return original.atomicReplace(file, content);
      },
    }));
  `,
  );

  const newImg = path.join(tempDir, "green-blob.png");
  await writeFile(newImg, solidPng(60, 60, GREEN));

  // Run public CLI edit with simulated commit failure attempting to stage rev 3
  const editFailProc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      failPreload,
      path.resolve(import.meta.dir, "../src/layer-cli.ts"),
      "edit",
      layerId,
      "--image",
      newImg,
      "--x",
      "99",
      "--project",
      projDir,
      "--json",
    ],
    {
      env: { ...process.env, PLY_TEST_FAIL_IDENTITY: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const editFailCode = await editFailProc.exited;
  expect(editFailCode).toBe(1);
  const editFailJson = JSON.parse(await new Response(editFailProc.stdout).text());
  expect(editFailJson.ok).toBe(false);
  expect(editFailJson.error).toContain("Simulated I/O disk failure");

  // Verify byte-for-byte identity equality and zero drift across all historical revisions, blobs, and compositions
  expect(await readFile(identityFile)).toEqual(snapIdentity);
  expect(await readFile(rev1File)).toEqual(snapRev1);
  expect(await readFile(rev2File)).toEqual(snapRev2);
  expect(await readFile(blobAFile)).toEqual(snapBlobA);
  expect(await readFile(blobBFile)).toEqual(snapBlobB);
  expect(await readFile(compFile)).toEqual(snapComp);

  // Verify staged revision document was rolled back (only rev 1 and rev 2 exist)
  const revFilesAfterFail = await readdir(path.join(projDir, "layers", `${layerId}.revisions`));
  expect(revFilesAfterFail.sort()).toEqual([`${rev1Id}.json`, `${rev2Id}.json`].sort());

  // Verify composition reference and inspection still resolve cleanly
  const inspectRes = await invoke(["composition", "inspect", "main-comp", "--project", projDir, "--json"]);
  expect(inspectRes.code).toBe(0);
  const compJson = JSON.parse(inspectRes.stdout);
  expect(compJson.composition.layers[0].revision.x).toBe(15);
  expect(compJson.composition.layers[0].revision.contentHash).toBe(blobB);

  // Verify subsequent public edit without failure succeeds normally and preserves historical bytes
  const subsequentEdit = await invoke([
    "layer",
    "edit",
    layerId,
    "--image",
    newImg,
    "--x",
    "42",
    "--project",
    projDir,
    "--json",
  ]);
  expect(subsequentEdit.code).toBe(0);
  const subsequentJson = JSON.parse(subsequentEdit.stdout);
  expect(subsequentJson.ok).toBe(true);
  const rev3Id = subsequentJson.layer.currentRevisionId as string;
  expect(rev3Id).not.toBe(rev1Id);
  expect(rev3Id).not.toBe(rev2Id);
  expect(subsequentJson.layer.currentRevision.x).toBe(42);

  // Verify all historical revisions and blobs remain byte-identical to pre-failure snapshot
  expect(await readFile(rev1File)).toEqual(snapRev1);
  expect(await readFile(rev2File)).toEqual(snapRev2);
  expect(await readFile(blobAFile)).toEqual(snapBlobA);
  expect(await readFile(blobBFile)).toEqual(snapBlobB);

  // Revisions directory now contains rev 1, rev 2, and rev 3
  const revFilesAfterSuccess = await readdir(path.join(projDir, "layers", `${layerId}.revisions`));
  expect(revFilesAfterSuccess.sort()).toEqual([`${rev1Id}.json`, `${rev2Id}.json`, `${rev3Id}.json`].sort());
});

test("CRAFT-1: editor synchronizes before second reference publication to catch stale pre-lock discovery", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  await makeComp("comp-first", 200, 200);
  await makeComp("comp-second", 200, 200);

  const addRes = await addImageLayer("comp-first", "first-use", redImg);
  const layerId = addRes.use.layerId as string;

  const signalMutatorLocked = path.join(tempDir, "craft1-mutator-locked");
  const signalEditorAttemptingLock = path.join(tempDir, "craft1-editor-attempting-lock");

  // Mutator preload: acquires lock, signals that lock is held, waits for editor to attempt lock acquisition,
  // mutates comp-second.json to add 2nd reference while editor is blocked on lock, and then releases.
  const mutatorPreload = path.join(tempDir, "craft1-mutator.ts");
  await writeFile(
    mutatorPreload,
    `
    import { mock } from "bun:test";
    import { writeFile, readFile } from "node:fs/promises";
    import path from "node:path";
    import * as lock from ${JSON.stringify(path.resolve(import.meta.dir, "../src/project-lock.ts"))};
    const original = { ...lock };
    mock.module(${JSON.stringify(path.resolve(import.meta.dir, "../src/project-lock.ts"))}, () => ({
      ...original,
      acquireProjectLock: async (...args) => {
        const acquired = await original.acquireProjectLock(...args);
        if (process.env.PLY_TEST_MUTATOR_SIGNAL_LOCKED && process.env.PLY_TEST_SIGNAL_EDITOR_ATTEMPTING_LOCK) {
          // Signal that lock is held BEFORE second reference is added
          await writeFile(process.env.PLY_TEST_MUTATOR_SIGNAL_LOCKED, "locked");
          // Wait until editor process emits signal that it is attempting to acquire project lock
          const deadline = Date.now() + 10000;
          while (!(await Bun.file(process.env.PLY_TEST_SIGNAL_EDITOR_ATTEMPTING_LOCK).exists())) {
            if (Date.now() > deadline) throw new Error("Mutator timed out waiting for editor attempting lock signal");
            await Bun.sleep(5);
          }
          // Mutate comp-second.json while holding lock and while editor is blocked on lock
          const comp2Path = path.join(${JSON.stringify(projDir)}, "compositions", "comp-second.json");
          const comp2 = JSON.parse(await readFile(comp2Path, "utf8"));
          comp2.layers.push({ name: "shared-use", layerId: ${JSON.stringify(layerId)} });
          await original.atomicReplace(comp2Path, JSON.stringify(comp2, null, 2) + "\\n");
        }
        return acquired;
      },
    }));
  `,
  );

  // Editor preload: intercepts acquireProjectLock to deterministically emit signal immediately before blocking on lock
  const editorPreload = path.join(tempDir, "craft1-editor.ts");
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
          // Deterministically write the signal immediately before blocking on acquireProjectLock
          await writeFile(process.env.PLY_TEST_SIGNAL_EDITOR_ATTEMPTING_LOCK, "attempting-lock");
        }
        return original.acquireProjectLock(...args);
      },
    }));
  `,
  );

  // 1. Start mutator process which acquires lock and waits for editor signal
  const mutator = Bun.spawn(
    [
      process.execPath,
      "--preload",
      mutatorPreload,
      path.resolve(import.meta.dir, "../src/layer-cli.ts"),
      "list",
      "--project",
      projDir,
      "--json",
    ],
    {
      env: {
        ...process.env,
        PLY_TEST_MUTATOR_SIGNAL_LOCKED: signalMutatorLocked,
        PLY_TEST_SIGNAL_EDITOR_ATTEMPTING_LOCK: signalEditorAttemptingLock,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // 2. Wait for mutator to hold the lock (comp-second still has NO reference to layerId)
  const deadline = Date.now() + 5000;
  while (!(await Bun.file(signalMutatorLocked).exists())) {
    if (Date.now() > deadline) throw new Error("Mutator timed out acquiring lock");
    await Bun.sleep(5);
  }

  // 3. Launch public editor without --in-place
  // If editor performed pre-lock scanning, it would scan NOW and only see comp-first
  const editProc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      editorPreload,
      path.resolve(import.meta.dir, "../src/layer-cli.ts"),
      "edit",
      layerId,
      "--x",
      "88",
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

  // 4. Mutator unblocks upon receiving editor lock-attempt signal, writes 2nd ref, and exits 0
  expect(await mutator.exited).toBe(0);

  // 5. Editor acquires lock, discovers both referrers under lock, and fails with multi-referrer refusal
  expect(await editProc.exited).toBe(1);
  const editOutput = JSON.parse(await new Response(editProc.stdout).text());
  expect(editOutput.ok).toBe(false);
  expect(editOutput.error).toContain("2 Compositions");
  expect(editOutput.referringCompositions).toEqual(["comp-first", "comp-second"]);
  expect(editOutput.referrersCount).toBe(2);

  // Layer remains unedited
  const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(JSON.parse(inspect.stdout).layer.currentRevision.x).toBe(0);
});

test("CRAFT-3: public CLI text edit and render work when original font bundle is unavailable", async () => {
  await makeComp("fontless-comp", 300, 200);
  const addRes = await addTextLayer("fontless-comp", "heading", "Initial", { font: "Anton", fontSize: 40, color: "#ffffff", x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;
  const initialFontHash = addRes.layer.currentRevision.contentHash as string;

  // Preload that throws whenever bundled font assets are accessed
  const blockFontsPreload = path.join(tempDir, "block-fonts.ts");
  await writeFile(
    blockFontsPreload,
    `
    import { mock } from "bun:test";
    import * as fonts from ${JSON.stringify(path.resolve(import.meta.dir, "../src/fonts.ts"))};
    const original = { ...fonts };
    mock.module(${JSON.stringify(path.resolve(import.meta.dir, "../src/fonts.ts"))}, () => ({
      ...original,
      fontAssetBytes: () => {
        throw new Error("Simulated missing original font bundle: assets/fonts is unavailable");
      },
      readFontAsset: () => {
        throw new Error("Simulated missing original font bundle: assets/fonts is unavailable");
      },
    }));
  `,
  );

  // 1. Text edit (text string and color change) preserving font works without original font bundle
  const editProc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      blockFontsPreload,
      path.resolve(import.meta.dir, "../src/layer-cli.ts"),
      "edit",
      layerId,
      "--text",
      "Updated",
      "--color",
      "#00ff00",
      "--project",
      projDir,
      "--json",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await editProc.exited).toBe(0);
  const editJson = JSON.parse(await new Response(editProc.stdout).text());
  expect(editJson.ok).toBe(true);
  expect(editJson.layer.currentRevision.text).toBe("Updated");
  expect(editJson.layer.currentRevision.color).toBe("#00ff00");
  expect(editJson.layer.currentRevision.contentHash).toBe(initialFontHash);

  // 2. Render works without original font bundle, using Project-retained font bytes
  const renderProc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      blockFontsPreload,
      path.resolve(import.meta.dir, "../src/composition-cli.ts"),
      "render",
      "fontless-comp",
      "--project",
      projDir,
      "--json",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await renderProc.exited).toBe(0);
  const renderJson = JSON.parse(await new Response(renderProc.stdout).text());
  expect(renderJson.ok).toBe(true);
  const pngBytes = await readFile(renderJson.render.output);
  const decoded = decodePng(pngBytes);
  // Verify green glyph pixels rendered
  let greenPixels = 0;
  for (let y = 10; y < 100; y++) {
    for (let x = 10; x < 200; x++) {
      const p = pixel(decoded, x, y);
      if (p[0] < 50 && p[1] > 200 && p[2] < 50 && p[3] === 255) greenPixels++;
    }
  }
  expect(greenPixels).toBeGreaterThan(50);

  // 3. Proving the blocker was active: requesting a NEW font family fails because bundled fonts are blocked
  const editNewFontProc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      blockFontsPreload,
      path.resolve(import.meta.dir, "../src/layer-cli.ts"),
      "edit",
      layerId,
      "--font",
      "Source Sans 3",
      "--project",
      projDir,
      "--json",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await editNewFontProc.exited).toBe(1);
  const failJson = JSON.parse(await new Response(editNewFontProc.stdout).text());
  expect(failJson.ok).toBe(false);
  expect(failJson.error).toContain("Simulated missing original font bundle");
});


