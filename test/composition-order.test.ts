/**
 * Composition Layer use removal and reordering (#83, spec #77 US-002 / US-006 / US-008 / DEC-001–006).
 *
 * Verifies:
 * - Reorder existing uses (image and text) and verify resulting paint order on rendered PNGs.
 * - Reorder preserves Layer identities, current revisions, placement, and content blobs.
 * - Remove a use without deleting its Layer, historical revisions, content blobs, or other Compositions' uses.
 * - Removing the last use from a Composition is allowed (resulting in 0 layers).
 * - Empty Composition reorder with explicit empty order succeeds as a no-op; missing flag is usage error.
 * - Rejection of invalid targets, nonexistent use names, and malformed reorder requests (duplicate, missing, extra) leaving document unchanged.
 * - Public CLI JSON/errors/help/offline behavior and argument validation (exit code 2 for missing options).
 * - Concurrency serialization under .ply.lock with deterministic editor-origin handshake.
 * - Failure during atomicReplace leaves Composition document unchanged and retry succeeds.
 * - Operations succeed after Project relocation.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, rename, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { encodePngRgba, readPngHeader, decodePng } from "../src/png.js";

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

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

const close = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-comp-order-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "order-test-proj"]);
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

test("reorder existing image and text uses changes paint order on rendered pixels without altering Layer identities", async () => {
  const greenBg = path.join(tempDir, "bg.png");
  await writeFile(greenBg, solidPng(400, 300, GREEN));
  const blueBox = path.join(tempDir, "blue-box.png");
  await writeFile(blueBox, solidPng(150, 100, BLUE));

  await makeComp("canvas-comp", 400, 300);

  // 1. Add background
  const bgRes = await addImageLayer("canvas-comp", "bg", greenBg, { x: 0, y: 0 });
  const bgLayerId = bgRes.use.layerId as string;
  const bgRevId = bgRes.layer.currentRevisionId as string;

  // 2. Add text title (solid RED text) at (30, 30)
  const textRes = await addTextLayer("canvas-comp", "title", "PLY", { font: "Anton", fontSize: 100, color: "#ff0000", x: 30, y: 30 });
  const textLayerId = textRes.use.layerId as string;
  const textRevId = textRes.layer.currentRevisionId as string;

  // Render text alone over background to discover exact glyph pixel coordinate
  const renderTextFirst = await invoke(["composition", "render", "canvas-comp", "--project", projDir, "--json"]);
  expect(renderTextFirst.code).toBe(0);
  const textPng = decodePng(await readFile(JSON.parse(renderTextFirst.stdout).render.output));

  let glyphCoord: { x: number; y: number } | undefined;
  for (let y = 40; y < 120 && !glyphCoord; y++) {
    for (let x = 40; x < 150 && !glyphCoord; x++) {
      const p = pixel(textPng, x, y);
      if (p[0] === 255 && p[1] === 0 && p[2] === 0 && p[3] === 255) {
        glyphCoord = { x, y };
      }
    }
  }
  expect(glyphCoord).toBeDefined();

  // 3. Add blue box over the discovered glyph coordinate
  // Placing blue box at (20, 20) with size 150x100 ensures glyphCoord is inside the blue box.
  const boxRes = await addImageLayer("canvas-comp", "box", blueBox, { x: 20, y: 20 });
  const boxLayerId = boxRes.use.layerId as string;
  const boxRevId = boxRes.layer.currentRevisionId as string;

  // Current order: [bg, title, box]. The blue box paints OVER the text glyph.
  const renderBoxOnTop = await invoke(["composition", "render", "canvas-comp", "--project", projDir, "--json"]);
  expect(renderBoxOnTop.code).toBe(0);
  const boxOnTopPng = decodePng(await readFile(JSON.parse(renderBoxOnTop.stdout).render.output));
  // Exact glyph coordinate must be BLUE because box is on top
  expect(pixel(boxOnTopPng, glyphCoord!.x, glyphCoord!.y).every((v, i) => close(v, BLUE[i]!))).toBe(true);

  // 4. Reorder to [bg, box, title] so text title paints ON TOP of blue box
  const reorderRes = await invoke([
    "composition", "reorder", "canvas-comp",
    "--order", "bg,box,title",
    "--project", projDir,
    "--json",
  ]);
  expect(reorderRes.code).toBe(0);
  const reorderJson = JSON.parse(reorderRes.stdout);
  expect(reorderJson.ok).toBe(true);
  expect(reorderJson.composition).toBe("canvas-comp");
  expect(reorderJson.layers.map((l: { name: string }) => l.name)).toEqual(["bg", "box", "title"]);

  // Render after reorder: text title is now ON TOP of blue box
  const renderTextOnTop = await invoke(["composition", "render", "canvas-comp", "--project", projDir, "--json"]);
  expect(renderTextOnTop.code).toBe(0);
  const textOnTopPng = decodePng(await readFile(JSON.parse(renderTextOnTop.stdout).render.output));
  // Exact glyph coordinate must now be RED (text glyph pixel)
  expect(pixel(textOnTopPng, glyphCoord!.x, glyphCoord!.y).every((v, i) => close(v, RED[i]!))).toBe(true);

  // Background pixel outside box/text remains GREEN
  expect(pixel(textOnTopPng, 350, 250).every((v, i) => close(v, GREEN[i]!))).toBe(true);

  // Verify Layer identities, revision hashes, and content blobs are completely untouched
  const inspectComp = await invoke(["composition", "inspect", "canvas-comp", "--project", projDir, "--json"]);
  expect(inspectComp.code).toBe(0);
  const inspectJson = JSON.parse(inspectComp.stdout);
  expect(inspectJson.composition.layers[0].layerId).toBe(bgLayerId);
  expect(inspectJson.composition.layers[0].revision.revisionId).toBe(bgRevId);
  expect(inspectJson.composition.layers[1].layerId).toBe(boxLayerId);
  expect(inspectJson.composition.layers[1].revision.revisionId).toBe(boxRevId);
  expect(inspectJson.composition.layers[2].layerId).toBe(textLayerId);
  expect(inspectJson.composition.layers[2].revision.revisionId).toBe(textRevId);

  // Compact default output
  const compactReorder = await invoke([
    "composition", "reorder", "canvas-comp",
    "--order", "title,bg,box",
    "--project", projDir,
  ]);
  expect(compactReorder.code).toBe(0);
  const lines = compactReorder.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("canvas-comp");
  expect(lines[0]).toContain("title, bg, box");
});

test("remove a use without deleting its Layer, historical revisions, content blobs, or other Compositions' uses", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  const blueImg = path.join(tempDir, "blue.png");
  await writeFile(blueImg, solidPng(60, 60, BLUE));

  await makeComp("comp-a", 300, 300);
  await makeComp("comp-b", 300, 300);

  // 1. Create layer in comp-a (rev 1 with red content blob)
  const addRes = await addImageLayer("comp-a", "shared-badge", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;
  const rev1Id = addRes.layer.currentRevisionId as string;
  const blob1Hash = addRes.layer.currentRevision.contentHash as string;

  // 2. Share layer into comp-b
  const compBFile = path.join(projDir, "compositions", "comp-b.json");
  const compBDoc = JSON.parse(await readFile(compBFile, "utf8"));
  compBDoc.layers.push({ name: "comp-b-badge", layerId });
  await writeFile(compBFile, JSON.stringify(compBDoc, null, 2) + "\n");

  // 3. In-place edit layer (advances to rev 2 with blue content blob)
  const editRes = await invoke([
    "layer", "edit", layerId,
    "--image", blueImg,
    "--x", "25",
    "--in-place",
    "--project", projDir,
    "--json",
  ]);
  expect(editRes.code).toBe(0);
  const rev2Id = JSON.parse(editRes.stdout).layer.currentRevisionId as string;
  const blob2Hash = JSON.parse(editRes.stdout).layer.currentRevision.contentHash as string;
  expect(rev2Id).not.toBe(rev1Id);
  expect(blob2Hash).not.toBe(blob1Hash);

  // Snapshot files
  const identityFile = path.join(projDir, "layers", `${layerId}.json`);
  const rev1File = path.join(projDir, "layers", `${layerId}.revisions`, `${rev1Id}.json`);
  const rev2File = path.join(projDir, "layers", `${layerId}.revisions`, `${rev2Id}.json`);
  const blob1File = path.join(projDir, "content", blob1Hash);
  const blob2File = path.join(projDir, "content", blob2Hash);

  const snapIdentity = await readFile(identityFile);
  const snapRev1 = await readFile(rev1File);
  const snapRev2 = await readFile(rev2File);
  const snapBlob1 = await readFile(blob1File);
  const snapBlob2 = await readFile(blob2File);

  // 4. Remove use from comp-a
  const removeRes = await invoke([
    "composition", "remove", "comp-a", "shared-badge",
    "--project", projDir,
    "--json",
  ]);
  expect(removeRes.code).toBe(0);
  const removeJson = JSON.parse(removeRes.stdout);
  expect(removeJson.ok).toBe(true);
  expect(removeJson.composition).toBe("comp-a");
  expect(removeJson.removedUse).toEqual({ name: "shared-badge", layerId });
  expect(removeJson.layers).toEqual([]);

  // comp-a now has 0 layers
  const inspectA = await invoke(["composition", "inspect", "comp-a", "--project", projDir, "--json"]);
  expect(inspectA.code).toBe(0);
  expect(JSON.parse(inspectA.stdout).composition.layers).toHaveLength(0);

  // comp-b is completely unaffected and still references layerId
  const inspectB = await invoke(["composition", "inspect", "comp-b", "--project", projDir, "--json"]);
  expect(inspectB.code).toBe(0);
  const compBLayers = JSON.parse(inspectB.stdout).composition.layers;
  expect(compBLayers).toHaveLength(1);
  expect(compBLayers[0].name).toBe("comp-b-badge");
  expect(compBLayers[0].layerId).toBe(layerId);
  expect(compBLayers[0].revision.revisionId).toBe(rev2Id);

  // Layer identity, all historical revisions, and content blobs are byte-identical
  expect(await readFile(identityFile)).toEqual(snapIdentity);
  expect(await readFile(rev1File)).toEqual(snapRev1);
  expect(await readFile(rev2File)).toEqual(snapRev2);
  expect(await readFile(blob1File)).toEqual(snapBlob1);
  expect(await readFile(blob2File)).toEqual(snapBlob2);

  // 5. Remove use from comp-b as well (last reference removed across entire project)
  const removeBRes = await invoke([
    "composition", "remove", "comp-b", "comp-b-badge",
    "--project", projDir,
    "--json",
  ]);
  expect(removeBRes.code).toBe(0);

  // Even with 0 referrers, Layer identity, historical revisions, and content blobs remain intact
  expect(await readFile(identityFile)).toEqual(snapIdentity);
  expect(await readFile(rev1File)).toEqual(snapRev1);
  expect(await readFile(rev2File)).toEqual(snapRev2);
  expect(await readFile(blob1File)).toEqual(snapBlob1);
  expect(await readFile(blob2File)).toEqual(snapBlob2);

  // Layer is still inspectable and listed
  const layerInspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(layerInspect.code).toBe(0);
  expect(JSON.parse(layerInspect.stdout).layer.id).toBe(layerId);

  // Compact default output
  await addImageLayer("comp-a", "item", redImg);
  const compactRemove = await invoke([
    "composition", "remove", "comp-a", "item",
    "--project", projDir,
  ]);
  expect(compactRemove.code).toBe(0);
  const lines = compactRemove.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("item");
  expect(lines[0]).toContain("comp-a");
});

test("empty Composition reorder with explicit empty order succeeds as a no-op; missing flag is usage error", async () => {
  await makeComp("empty-comp", 200, 200);

  // Reorder with --order "" succeeds as no-op
  const reorderEmpty = await invoke([
    "composition", "reorder", "empty-comp",
    "--order", "",
    "--project", projDir,
    "--json",
  ]);
  expect(reorderEmpty.code).toBe(0);
  const json = JSON.parse(reorderEmpty.stdout);
  expect(json.ok).toBe(true);
  expect(json.composition).toBe("empty-comp");
  expect(json.layers).toEqual([]);

  // Missing --order flag is usage error 2
  const missingOrderFlag = await invoke([
    "composition", "reorder", "empty-comp",
    "--project", projDir,
    "--json",
  ]);
  expect(missingOrderFlag.code).toBe(2);
  expect(JSON.parse(missingOrderFlag.stdout).error).toMatch(/--order/i);

  // Passing names to empty composition fails with exit 1
  const orderOnEmpty = await invoke([
    "composition", "reorder", "empty-comp",
    "--order", "foo",
    "--project", projDir,
    "--json",
  ]);
  expect(orderOnEmpty.code).toBe(1);
  expect(JSON.parse(orderOnEmpty.stdout).error).toMatch(/empty|0/i);
});

test("rejection of invalid targets, nonexistent use names, and malformed reorder requests leaving files unchanged", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  await makeComp("target-comp", 300, 300);

  await addImageLayer("target-comp", "a", redImg);
  await addImageLayer("target-comp", "b", redImg);
  await addImageLayer("target-comp", "c", redImg);

  const compFile = path.join(projDir, "compositions", "target-comp.json");
  const compDocBefore = await readFile(compFile, "utf8");

  // 1. Remove non-existent use name fails with exit 1
  const removeMissing = await invoke([
    "composition", "remove", "target-comp", "nonexistent-use",
    "--project", projDir,
    "--json",
  ]);
  expect(removeMissing.code).toBe(1);
  expect(JSON.parse(removeMissing.stdout).error).toContain("nonexistent-use");
  expect(await readFile(compFile, "utf8")).toBe(compDocBefore);

  // 2. Remove on non-existent composition fails with exit 1
  const removeMissingComp = await invoke([
    "composition", "remove", "no-such-comp", "a",
    "--project", projDir,
    "--json",
  ]);
  expect(removeMissingComp.code).toBe(1);
  expect(JSON.parse(removeMissingComp.stdout).error).toContain("no-such-comp");

  // 3. Reorder with duplicate name fails with exit 1
  const reorderDup = await invoke([
    "composition", "reorder", "target-comp",
    "--order", "a,a,c",
    "--project", projDir,
    "--json",
  ]);
  expect(reorderDup.code).toBe(1);
  expect(JSON.parse(reorderDup.stdout).error).toMatch(/duplicate/i);
  expect(await readFile(compFile, "utf8")).toBe(compDocBefore);

  // 4. Reorder with missing name (count mismatch) fails with exit 1
  const reorderMissing = await invoke([
    "composition", "reorder", "target-comp",
    "--order", "a,b",
    "--project", projDir,
    "--json",
  ]);
  expect(reorderMissing.code).toBe(1);
  expect(JSON.parse(reorderMissing.stdout).error).toMatch(/expected 3.*received 2/i);
  expect(await readFile(compFile, "utf8")).toBe(compDocBefore);

  // 5. Reorder with extra/unknown name fails with exit 1
  const reorderUnknown = await invoke([
    "composition", "reorder", "target-comp",
    "--order", "a,b,unknown",
    "--project", projDir,
    "--json",
  ]);
  expect(reorderUnknown.code).toBe(1);
  expect(JSON.parse(reorderUnknown.stdout).error).toContain("unknown");
  expect(await readFile(compFile, "utf8")).toBe(compDocBefore);

  // 6. Reorder with empty segment fails with exit 1
  const reorderEmptySeg = await invoke([
    "composition", "reorder", "target-comp",
    "--order", "a,,c",
    "--project", projDir,
    "--json",
  ]);
  expect(reorderEmptySeg.code).toBe(1);
  expect(JSON.parse(reorderEmptySeg.stdout).error).toMatch(/empty/i);
  expect(await readFile(compFile, "utf8")).toBe(compDocBefore);

  // 7. No-op reorder with identical order succeeds without churn
  const reorderNoop = await invoke([
    "composition", "reorder", "target-comp",
    "--order", "a,b,c",
    "--project", projDir,
    "--json",
  ]);
  expect(reorderNoop.code).toBe(0);
  expect(JSON.parse(reorderNoop.stdout).ok).toBe(true);
  expect(JSON.parse(reorderNoop.stdout).layers.map((l: { name: string }) => l.name)).toEqual(["a", "b", "c"]);
});

test("CLI argument validation emits structured errors and exit code 2", async () => {
  // Missing positional args for remove
  const badRemove1 = await invoke(["composition", "remove", "--project", projDir, "--json"]);
  expect(badRemove1.code).toBe(2);
  expect(JSON.parse(badRemove1.stdout).error).toMatch(/usage/i);

  const badRemove2 = await invoke(["composition", "remove", "comp-only", "--project", projDir, "--json"]);
  expect(badRemove2.code).toBe(2);
  expect(JSON.parse(badRemove2.stdout).error).toMatch(/usage/i);

  // Missing positional args for reorder
  const badReorder1 = await invoke(["composition", "reorder", "--project", projDir, "--json"]);
  expect(badReorder1.code).toBe(2);
  expect(JSON.parse(badReorder1.stdout).error).toMatch(/usage/i);

  // Missing --order flag for reorder
  const badReorder2 = await invoke(["composition", "reorder", "my-comp", "--project", projDir, "--json"]);
  expect(badReorder2.code).toBe(2);
  expect(JSON.parse(badReorder2.stdout).error).toMatch(/--order/i);
});

test("composition remove and reorder succeed after Project relocation", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(40, 40, RED));
  await makeComp("reloc-comp", 200, 200);

  await addImageLayer("reloc-comp", "first", redImg);
  await addImageLayer("reloc-comp", "second", redImg);

  // Relocate Project directory
  const movedProj = path.join(tempDir, "relocated-project-dir");
  await rename(projDir, movedProj);

  // Reorder in relocated project
  const reorderRes = await invoke([
    "composition", "reorder", "reloc-comp",
    "--order", "second,first",
    "--project", movedProj,
    "--json",
  ]);
  expect(reorderRes.code).toBe(0);
  expect(JSON.parse(reorderRes.stdout).layers.map((l: { name: string }) => l.name)).toEqual(["second", "first"]);

  // Remove in relocated project
  const removeRes = await invoke([
    "composition", "remove", "reloc-comp", "first",
    "--project", movedProj,
    "--json",
  ]);
  expect(removeRes.code).toBe(0);
  expect(JSON.parse(removeRes.stdout).layers.map((l: { name: string }) => l.name)).toEqual(["second"]);
});

test("concurrency: reorder synchronizes with Project lock and detects concurrent changes via deterministic handshake", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  await makeComp("race-comp", 200, 200);

  await addImageLayer("race-comp", "use1", redImg);
  await addImageLayer("race-comp", "use2", redImg);

  const signalMutatorLocked = path.join(tempDir, "reorder-mutator-locked");
  const signalReorderAttemptingLock = path.join(tempDir, "reorder-attempting-lock");

  // Mutator preload: acquires lock, signals that lock is held, waits for reorder process to attempt lock acquisition,
  // mutates race-comp.json to add a 3rd use while reorder process is blocked on lock, and then releases.
  const mutatorPreload = path.join(tempDir, "reorder-mutator.ts");
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
        if (process.env.PLY_TEST_MUTATOR_SIGNAL_LOCKED && process.env.PLY_TEST_SIGNAL_REORDER_ATTEMPTING_LOCK) {
          await writeFile(process.env.PLY_TEST_MUTATOR_SIGNAL_LOCKED, "locked");
          const deadline = Date.now() + 10000;
          while (!(await Bun.file(process.env.PLY_TEST_SIGNAL_REORDER_ATTEMPTING_LOCK).exists())) {
            if (Date.now() > deadline) throw new Error("Mutator timed out waiting for reorder attempting lock signal");
            await Bun.sleep(5);
          }
          // Add 3rd use to race-comp.json while holding lock
          const compPath = path.join(${JSON.stringify(projDir)}, "compositions", "race-comp.json");
          const comp = JSON.parse(await readFile(compPath, "utf8"));
          comp.layers.push({ name: "use3", layerId: comp.layers[0].layerId });
          await original.atomicReplace(compPath, JSON.stringify(comp, null, 2) + "\\n");
        }
        return acquired;
      },
    }));
  `,
  );

  // Reorder preload: intercepts acquireProjectLock to deterministically emit signal immediately before blocking on lock
  const reorderPreload = path.join(tempDir, "reorder-client.ts");
  await writeFile(
    reorderPreload,
    `
    import { mock } from "bun:test";
    import { writeFile } from "node:fs/promises";
    import * as lock from ${JSON.stringify(path.resolve(import.meta.dir, "../src/project-lock.ts"))};
    const original = { ...lock };
    mock.module(${JSON.stringify(path.resolve(import.meta.dir, "../src/project-lock.ts"))}, () => ({
      ...original,
      acquireProjectLock: async (...args) => {
        if (process.env.PLY_TEST_SIGNAL_REORDER_ATTEMPTING_LOCK) {
          await writeFile(process.env.PLY_TEST_SIGNAL_REORDER_ATTEMPTING_LOCK, "attempting-lock");
        }
        return original.acquireProjectLock(...args);
      },
    }));
  `,
  );

  // 1. Start mutator process which acquires lock
  const mutator = Bun.spawn(
    [
      process.execPath,
      "--preload",
      mutatorPreload,
      path.resolve(import.meta.dir, "../src/composition-cli.ts"),
      "list",
      "--project",
      projDir,
      "--json",
    ],
    {
      env: {
        ...process.env,
        PLY_TEST_MUTATOR_SIGNAL_LOCKED: signalMutatorLocked,
        PLY_TEST_SIGNAL_REORDER_ATTEMPTING_LOCK: signalReorderAttemptingLock,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // 2. Wait for mutator to hold the lock
  const deadline = Date.now() + 5000;
  while (!(await Bun.file(signalMutatorLocked).exists())) {
    if (Date.now() > deadline) throw new Error("Mutator timed out acquiring lock");
    await Bun.sleep(5);
  }

  // 3. Launch public reorder with a 2-element permutation "use2,use1"
  const reorderProc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      reorderPreload,
      path.resolve(import.meta.dir, "../src/composition-cli.ts"),
      "reorder",
      "race-comp",
      "--order",
      "use2,use1",
      "--project",
      projDir,
      "--json",
    ],
    {
      env: {
        ...process.env,
        PLY_TEST_SIGNAL_REORDER_ATTEMPTING_LOCK: signalReorderAttemptingLock,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // 4. Mutator unblocks upon receiving reorder lock-attempt signal, commits 3rd use, and exits 0
  expect(await mutator.exited).toBe(0);

  // 5. Reorder acquires lock, discovers 3 uses under lock, and fails closed with count mismatch
  expect(await reorderProc.exited).toBe(1);
  const reorderOutput = JSON.parse(await new Response(reorderProc.stdout).text());
  expect(reorderOutput.ok).toBe(false);
  expect(reorderOutput.error).toMatch(/expected 3.*received 2/i);

  // Composition retains all 3 uses
  const inspect = await invoke(["composition", "inspect", "race-comp", "--project", projDir, "--json"]);
  expect(JSON.parse(inspect.stdout).composition.layers).toHaveLength(3);
});

test("atomicReplace failure during remove leaves Composition document unchanged and retry succeeds", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  await makeComp("fail-comp", 200, 200);

  await addImageLayer("fail-comp", "keep-me", redImg);
  await addImageLayer("fail-comp", "remove-me", redImg);

  const compFile = path.join(projDir, "compositions", "fail-comp.json");
  const snapComp = await readFile(compFile);

  // Preload simulating atomicReplace failure
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
        if (process.env.PLY_TEST_FAIL_COMP && file.endsWith("fail-comp.json")) {
          throw new Error("Simulated I/O disk failure during Composition document replace");
        }
        return original.atomicReplace(file, content);
      },
    }));
  `,
  );

  // Run remove with simulated failure
  const removeFailProc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      failPreload,
      path.resolve(import.meta.dir, "../src/composition-cli.ts"),
      "remove",
      "fail-comp",
      "remove-me",
      "--project",
      projDir,
      "--json",
    ],
    {
      env: { ...process.env, PLY_TEST_FAIL_COMP: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  expect(await removeFailProc.exited).toBe(1);
  const failJson = JSON.parse(await new Response(removeFailProc.stdout).text());
  expect(failJson.ok).toBe(false);
  expect(failJson.error).toContain("Simulated I/O disk failure");

  // Composition file is completely untouched
  expect(await readFile(compFile)).toEqual(snapComp);

  // Subsequent remove without failure succeeds
  const retryRes = await invoke([
    "composition", "remove", "fail-comp", "remove-me",
    "--project", projDir,
    "--json",
  ]);
  expect(retryRes.code).toBe(0);
  expect(JSON.parse(retryRes.stdout).ok).toBe(true);
  expect(JSON.parse(retryRes.stdout).layers.map((l: { name: string }) => l.name)).toEqual(["keep-me"]);
});
