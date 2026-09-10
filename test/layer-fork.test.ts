/**
 * Explicit fork editing (#85, spec #77 US-004 / US-008 / US-006, DEC-001–006).
 *
 * Verifies through the public CLI:
 * - Fork-editing a Layer shared by Compositions A and B from B publishes a new
 *   Layer identity with the edited revision and retargets only B's use under
 *   one Project mutation.
 * - A's rendered output stays byte-identical across the fork while B's render
 *   shows the edited pixels; original revisions/content remain unchanged.
 * - Image and text forks follow the same identity/intent rules, including
 *   placement/opacity edits and font-preserving retained-byte reuse offline.
 * - Explicit fork always creates a new identity, even with unchanged content.
 * - Invalid edit intent (flag misuse) is a usage error (exit 2); target/use
 *   mismatches and publication failures are runtime errors (exit 1) that
 *   leave live references and current revisions unchanged, with staged
 *   fork artifacts cleaned up and a documented retry path.
 * - Competing public CLI reader/edit processes cannot observe a half-published
 *   fork (deterministic lock handshake, no sleeps or production hooks).
 * - Accurate help and Project relocation support.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { encodePngRgba, decodePng } from "../src/png.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
// Preloaded spawns must target the submodule entry directly: the delegating
// cli.ts re-spawns the submodule without forwarding --preload (CRAFT-1 pattern).
const layerCli = path.resolve(import.meta.dir, "../src/layer-cli.ts");
const compositionCli = path.resolve(import.meta.dir, "../src/composition-cli.ts");
const lockModule = path.resolve(import.meta.dir, "../src/project-lock.ts");

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
const BLUE: [number, number, number, number] = [0, 0, 255, 255];

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-fork-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "fork-test-proj"]);
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

/** Import a composition's uses into a destination composition (public CLI). */
async function importComp(target: string, source: string) {
  const res = await invoke(["composition", "import", target, source, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

async function inspectComp(name: string, project = projDir) {
  const res = await invoke(["composition", "inspect", name, "--project", project, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).composition;
}

async function inspectLayerJson(layerId: string) {
  const res = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

async function renderComp(name: string, out: string) {
  const res = await invoke(["composition", "render", name, "--out", out, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(true);
  return json.render.output as string;
}

/** Snapshot every file under dir (relative name → bytes) for byte-identity comparisons. */
async function snapshotDir(dir: string): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = {};
  async function walk(d: string, prefix: string) {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(p, `${prefix}${entry.name}/`);
      } else {
        files[`${prefix}${entry.name}`] = await readFile(p);
      }
    }
  }
  await walk(dir, "");
  return files;
}

/** Every file in `before` must still exist under `dir` with identical bytes (new files allowed). */
async function expectFilesPreserved(before: Record<string, Buffer>, dir: string) {
  const after = await snapshotDir(dir);
  for (const [name, bytes] of Object.entries(before)) {
    expect(after[name]).toEqual(bytes);
  }
}

/** Create distinct noncurrent history for a shared Layer through the public CLI. */
async function createHistoryInPlace(layerId: string, imgFile: string) {
  const h1 = await invoke(["layer", "edit", layerId, "--in-place", "--x", "15", "--project", projDir, "--json"]);
  expect(h1.code).toBe(0);
  const h2 = await invoke(["layer", "edit", layerId, "--in-place", "--image", imgFile, "--project", projDir, "--json"]);
  expect(h2.code).toBe(0);
  const inspect = await inspectLayerJson(layerId);
  return inspect.layer.currentRevisionId as string;
}

test("fork-editing a shared image Layer from B publishes a new identity and retargets only B", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 100, RED));
  const blueImg = path.join(tempDir, "blue.png");
  await writeFile(blueImg, solidPng(120, 80, BLUE));

  await makeComp("comp-a");
  await makeComp("comp-b");
  const addRes = await addImageLayer("comp-a", "hero", redImg, { x: 10, y: 20, opacity: 0.9 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;
  const oldContentHash = addRes.layer.currentRevision.contentHash as string;
  await importComp("comp-b", "comp-a");

  const bBefore = await inspectComp("comp-b");
  expect(bBefore.layers).toHaveLength(1);
  expect(bBefore.layers[0].layerId).toBe(layerId);

  // Distinct NONCURRENT history via the public CLI (local review SPEC-1/
  // CRAFT-2 gap): two shared in-place edits leave the initial revision and
  // its blob as retained history beside the current revision.
  const greenImg = path.join(tempDir, "green.png");
  await writeFile(greenImg, solidPng(90, 70, [0, 200, 0, 255]));
  const preForkRevId = await createHistoryInPlace(layerId, greenImg);
  expect(preForkRevId).not.toBe(oldRevId);

  // Snapshot the original Layer's full retained state BEFORE the fork:
  // identity document + ALL revision documents + ALL retained content.
  const identityBefore = await readFile(path.join(projDir, "layers", `${layerId}.json`));
  const origRevisionsBefore = await snapshotDir(path.join(projDir, "layers", `${layerId}.revisions`));
  expect(Object.keys(origRevisionsBefore).length).toBe(3); // 1 initial + 2 history revisions
  const contentBefore = await snapshotDir(path.join(projDir, "content"));

  // Render A and B before the fork
  const aOutBefore = path.join(tempDir, "a-before.png");
  const bOutBefore = path.join(tempDir, "b-before.png");
  await renderComp("comp-a", aOutBefore);
  await renderComp("comp-b", bOutBefore);
  const aBytesBefore = await readFile(aOutBefore);

  // Fork B's use with new image content and placement
  const forkRes = await invoke([
    "layer", "edit", layerId,
    "--fork", "--composition", "comp-b", "--use", "hero",
    "--image", blueImg, "--x", "60", "--opacity", "1",
    "--project", projDir, "--json",
  ]);
  expect(forkRes.code).toBe(0);
  const forkJson = JSON.parse(forkRes.stdout);
  expect(forkJson.ok).toBe(true);
  const newLayerId = forkJson.layer.id as string;
  expect(newLayerId).not.toBe(layerId);
  expect(forkJson.fork.previousLayerId).toBe(layerId);
  expect(forkJson.fork.composition).toBe("comp-b");
  expect(forkJson.fork.use).toBe("hero");
  expect(forkJson.layer.currentRevisionId).not.toBe(oldRevId);
  expect(forkJson.layer.currentRevision.kind).toBe("image");
  expect(forkJson.layer.currentRevision.x).toBe(60);
  expect(forkJson.layer.currentRevision.opacity).toBe(1);
  expect(forkJson.layer.currentRevision.contentHash).not.toBe(oldContentHash);
  // Blast radius of the original Layer before the fork
  expect(forkJson.referrersCount).toBe(2);
  expect(forkJson.referringCompositions.sort()).toEqual(["comp-a", "comp-b"]);

  // New identity resolves independently with the edited revision
  const newInspect = await inspectLayerJson(newLayerId);
  expect(newInspect.layer.id).toBe(newLayerId);
  expect(newInspect.layer.currentRevision.contentHash).not.toBe(oldContentHash);

  // Only B's use was retargeted
  const aAfter = await inspectComp("comp-a");
  expect(aAfter.layers[0].layerId).toBe(layerId);
  const bAfter = await inspectComp("comp-b");
  expect(bAfter.layers[0].layerId).toBe(newLayerId);
  expect(bAfter.layers[0].name).toBe("hero");

  // Original identity, ALL revision documents (current AND noncurrent), and
  // all retained content are byte-identical after the fork; only the fork's
  // own new identity/revision/blob files may appear.
  expect(await readFile(path.join(projDir, "layers", `${layerId}.json`))).toEqual(identityBefore);
  expect(await snapshotDir(path.join(projDir, "layers", `${layerId}.revisions`))).toEqual(origRevisionsBefore);
  await expectFilesPreserved(contentBefore, path.join(projDir, "content"));
  const oldInspect = await inspectLayerJson(layerId);
  expect(oldInspect.layer.currentRevisionId).toBe(preForkRevId);

  // A renders byte-identically across the fork; B renders the edited pixels
  const aOutAfter = path.join(tempDir, "a-after.png");
  const bOutAfter = path.join(tempDir, "b-after.png");
  await renderComp("comp-a", aOutAfter);
  await renderComp("comp-b", bOutAfter);
  expect(await readFile(aOutAfter)).toEqual(aBytesBefore);

  const bDecoded = decodePng(await readFile(bOutAfter));
  // Blue image now painted at x=60,y=0 (120x80); red content gone
  expect(pixel(bDecoded, 100, 40)).toEqual([0, 0, 255, 255]);
  expect(pixel(bDecoded, 30, 40)).toEqual([0, 0, 0, 0]);

  // Visual inspection of the forked render (required by repository policy)
  console.log(`\n[FORK VISUAL] forked B render for inspection: ${bOutAfter}\n`);
});

test("text fork follows the same identity rules, preserves retained font bytes offline, and edits placement", async () => {
  await makeComp("text-a");
  await makeComp("text-b");
  const addRes = await addTextLayer("text-a", "heading", "Original", {
    font: "Anton", fontSize: 40, color: "#ffffff", x: 10, y: 10,
  });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;
  const fontHash = addRes.layer.currentRevision.contentHash as string;
  await importComp("text-b", "text-a");

  // Preload that throws whenever the original font bundle is accessed: the
  // fork must reuse retained bytes, never re-read assets/fonts.
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

  const forkProc = Bun.spawn(
    [
      process.execPath, "--preload", blockFontsPreload, layerCli,
      "edit", layerId,
      "--fork", "--composition", "text-b", "--use", "heading",
      "--text", "Forked", "--color", "#00ff00", "--y", "30",
      "--project", projDir, "--json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await forkProc.exited).toBe(0);
  const forkJson = JSON.parse(await new Response(forkProc.stdout).text());
  expect(forkJson.ok).toBe(true);
  const newLayerId = forkJson.layer.id as string;
  expect(newLayerId).not.toBe(layerId);
  expect(forkJson.layer.currentRevision.text).toBe("Forked");
  expect(forkJson.layer.currentRevision.color).toBe("#00ff00");
  expect(forkJson.layer.currentRevision.y).toBe(30);
  expect(forkJson.layer.currentRevision.x).toBe(10); // preserved
  expect(forkJson.layer.currentRevision.fontSize).toBe(40); // preserved
  // Font-preserving fork reuses the retained face bytes
  expect(forkJson.layer.currentRevision.contentHash).toBe(fontHash);

  // Original layer history untouched; text-b retargeted; text-a unchanged
  const oldInspect = await inspectLayerJson(layerId);
  expect(oldInspect.layer.currentRevisionId).toBe(oldRevId);
  expect(oldInspect.layer.currentRevision.text).toBe("Original");
  const aAfter = await inspectComp("text-a");
  expect(aAfter.layers[0].layerId).toBe(layerId);
  const bAfter = await inspectComp("text-b");
  expect(bAfter.layers[0].layerId).toBe(newLayerId);

  // Renders work offline with retained bytes: green "Forked" pixels in text-b,
  // original white pixels unchanged in text-a
  const bRender = path.join(tempDir, "text-b.png");
  await renderComp("text-b", bRender);
  const decoded = decodePng(await readFile(bRender));
  let greenPixels = 0;
  for (let y = 0; y < decoded.height; y++) {
    for (let x = 0; x < decoded.width; x++) {
      const p = pixel(decoded, x, y);
      if (p[0] < 50 && p[1] > 200 && p[2] < 50 && p[3] === 255) greenPixels++;
    }
  }
  expect(greenPixels).toBeGreaterThan(50);

  const aRender = path.join(tempDir, "text-a.png");
  await renderComp("text-a", aRender);
  const aDecoded = decodePng(await readFile(aRender));
  let whitePixels = 0;
  let greenInA = 0;
  for (let y = 0; y < aDecoded.height; y++) {
    for (let x = 0; x < aDecoded.width; x++) {
      const p = pixel(aDecoded, x, y);
      if (p[0] > 200 && p[1] > 200 && p[2] > 200 && p[3] === 255) whitePixels++;
      if (p[0] < 50 && p[1] > 200 && p[2] < 50 && p[3] === 255) greenInA++;
    }
  }
  expect(whitePixels).toBeGreaterThan(50);
  expect(greenInA).toBe(0);
});

test("explicit fork with unchanged content still creates a new Layer identity", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  await makeComp("same-a");
  await makeComp("same-b");
  const addRes = await addImageLayer("same-a", "hero", redImg, { x: 10, y: 20, opacity: 0.8 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;
  const oldContentHash = addRes.layer.currentRevision.contentHash as string;
  await importComp("same-b", "same-a");

  const forkRes = await invoke([
    "layer", "edit", layerId,
    "--fork", "--composition", "same-b", "--use", "hero",
    "--project", projDir, "--json",
  ]);
  expect(forkRes.code).toBe(0);
  const forkJson = JSON.parse(forkRes.stdout);
  expect(forkJson.ok).toBe(true);
  const newLayerId = forkJson.layer.id as string;
  expect(newLayerId).not.toBe(layerId);
  expect(forkJson.layer.currentRevision.x).toBe(10);
  expect(forkJson.layer.currentRevision.y).toBe(20);
  expect(forkJson.layer.currentRevision.opacity).toBe(0.8);
  expect(forkJson.layer.currentRevision.contentHash).toBe(oldContentHash);

  const bAfter = await inspectComp("same-b");
  expect(bAfter.layers[0].layerId).toBe(newLayerId);
  const aAfter = await inspectComp("same-a");
  expect(aAfter.layers[0].layerId).toBe(layerId);
});

test("two uses of the same Layer in the forking Composition: only the selected use is retargeted", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  await makeComp("dup-a");
  await makeComp("dup-b");
  const addRes = await addImageLayer("dup-a", "hero", redImg, { x: 5, y: 5 });
  const layerId = addRes.use.layerId as string;
  await importComp("dup-b", "dup-a");

  // Reachable only through combined live operations: alias the shared use in
  // dup-b by importing again after renaming the first use in the document
  // (test setup mirrors the CRAFT-1 storage-mutation prior art; the operation
  // under test below is exercised exclusively through the public CLI).
  const compBFile = path.join(projDir, "compositions", "dup-b.json");
  const compB = JSON.parse(await readFile(compBFile, "utf8"));
  compB.layers.push({ name: "hero-alias", layerId });
  await writeFile(compBFile, JSON.stringify(compB, null, 2) + "\n");

  const blueImg = path.join(tempDir, "blue.png");
  await writeFile(blueImg, solidPng(40, 40, BLUE));
  const forkRes = await invoke([
    "layer", "edit", layerId,
    "--fork", "--composition", "dup-b", "--use", "hero",
    "--image", blueImg,
    "--project", projDir, "--json",
  ]);
  expect(forkRes.code).toBe(0);
  const forkJson = JSON.parse(forkRes.stdout);
  const newLayerId = forkJson.layer.id as string;

  const bAfter = await inspectComp("dup-b");
  expect(bAfter.layers).toHaveLength(2);
  const hero = bAfter.layers.find((l: { name: string }) => l.name === "hero");
  const alias = bAfter.layers.find((l: { name: string }) => l.name === "hero-alias");
  expect(hero.layerId).toBe(newLayerId);
  expect(alias.layerId).toBe(layerId);
  const aAfter = await inspectComp("dup-a");
  expect(aAfter.layers[0].layerId).toBe(layerId);
});

test("invalid fork intent is a usage error with exit 2 and actionable diagnostics", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  await makeComp("usage-a");
  const addRes = await addImageLayer("usage-a", "hero", redImg);
  const layerId = addRes.use.layerId as string;

  // --fork together with --in-place
  const bothRes = await invoke([
    "layer", "edit", layerId, "--fork", "--in-place",
    "--composition", "usage-a", "--use", "hero", "--x", "5", "--project", projDir, "--json",
  ]);
  expect(bothRes.code).toBe(2);
  expect(JSON.parse(bothRes.stdout).ok).toBe(false);

  // --fork without --composition
  const noComp = await invoke([
    "layer", "edit", layerId, "--fork", "--use", "hero", "--x", "5", "--project", projDir, "--json",
  ]);
  expect(noComp.code).toBe(2);
  expect(JSON.parse(noComp.stdout).error).toContain("--composition");

  // --fork without --use
  const noUse = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "usage-a", "--x", "5", "--project", projDir, "--json",
  ]);
  expect(noUse.code).toBe(2);
  expect(JSON.parse(noUse.stdout).error).toContain("--use");

  // --composition/--use without --fork
  const noFork = await invoke([
    "layer", "edit", layerId, "--composition", "usage-a", "--use", "hero", "--x", "5", "--project", projDir, "--json",
  ]);
  expect(noFork.code).toBe(2);
  expect(JSON.parse(noFork.stdout).ok).toBe(false);

  // Live state unchanged by every refusal
  const after = await inspectLayerJson(layerId);
  expect(after.layer.currentRevision.x).toBe(0);
});

test("fork target mismatch fails closed with exit 1 leaving live references unchanged", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  await makeComp("mismatch-a");
  await makeComp("mismatch-b");
  const addRes = await addImageLayer("mismatch-a", "hero", redImg);
  const layerId = addRes.use.layerId as string;
  await importComp("mismatch-b", "mismatch-a");

  // Use in the target composition references a different Layer
  const blueImg = path.join(tempDir, "blue.png");
  await writeFile(blueImg, solidPng(30, 30, BLUE));
  const otherAdd = await addImageLayer("mismatch-b", "other", blueImg);
  const otherId = otherAdd.use.layerId as string;

  const compAFile = path.join(projDir, "compositions", "mismatch-a.json");
  const compBFile = path.join(projDir, "compositions", "mismatch-b.json");
  const compABefore = await readFile(compAFile);
  const compBBefore = await readFile(compBFile);
  const layerBefore = await readFile(path.join(projDir, "layers", `${layerId}.json`));

  // Nonexistent composition
  const missingComp = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "no-such-comp", "--use", "hero",
    "--x", "5", "--project", projDir, "--json",
  ]);
  expect(missingComp.code).toBe(1);
  expect(JSON.parse(missingComp.stdout).ok).toBe(false);

  // Use name not present in the target composition
  const missingUse = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "mismatch-b", "--use", "no-such-use",
    "--x", "5", "--project", projDir, "--json",
  ]);
  expect(missingUse.code).toBe(1);
  expect(JSON.parse(missingUse.stdout).error).toContain("no-such-use");

  const wrongLayer = await invoke([
    "layer", "edit", otherId, "--fork", "--composition", "mismatch-b", "--use", "hero",
    "--x", "5", "--project", projDir, "--json",
  ]);
  expect(wrongLayer.code).toBe(1);
  expect(JSON.parse(wrongLayer.stdout).error).toContain(layerId);

  // Live state unchanged by all three refusals
  expect(await readFile(compAFile)).toEqual(compABefore);
  expect(await readFile(compBFile)).toEqual(compBBefore);
  expect(await readFile(path.join(projDir, "layers", `${layerId}.json`))).toEqual(layerBefore);
  const oldInspect = await inspectLayerJson(layerId);
  expect(oldInspect.layer.currentRevision.x).toBe(0);
});

test("publication failure during fork cleans staged artifacts, leaves live state unchanged, and a retry succeeds", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  const blueImg = path.join(tempDir, "blue.png");
  await writeFile(blueImg, solidPng(40, 40, BLUE));
  await makeComp("fail-a");
  await makeComp("fail-b");
  const addRes = await addImageLayer("fail-a", "hero", redImg);
  const layerId = addRes.use.layerId as string;
  await importComp("fail-b", "fail-a");

  // Distinct noncurrent history via the public CLI (local review SPEC-1:
  // the untouched guarantee must cover historical revisions, not just the
  // initial one).
  const greenImg = path.join(tempDir, "green.png");
  await writeFile(greenImg, solidPng(60, 60, [0, 200, 0, 255]));
  const preFailureRevId = await createHistoryInPlace(layerId, greenImg);

  const compAFile = path.join(projDir, "compositions", "fail-a.json");
  const compBFile = path.join(projDir, "compositions", "fail-b.json");
  // Pre-failure snapshot: composition documents, the original Layer's
  // identity, ALL of its revision documents, and ALL retained content.
  const compABefore = await readFile(compAFile);
  const compBBefore = await readFile(compBFile);
  const identityBefore = await readFile(path.join(projDir, "layers", `${layerId}.json`));
  const revisionsBefore = await snapshotDir(path.join(projDir, "layers", `${layerId}.revisions`));
  expect(Object.keys(revisionsBefore).length).toBe(3);
  const contentBefore = await snapshotDir(path.join(projDir, "content"));
  const layersDirBefore = (await readdir(path.join(projDir, "layers"))).sort();

  // Force the live composition replacement to fail
  const failPreload = path.join(tempDir, "fail-replace.ts");
  await writeFile(
    failPreload,
    `
    import { mock } from "bun:test";
    import * as lock from ${JSON.stringify(lockModule)};
    const original = { ...lock };
    mock.module(${JSON.stringify(lockModule)}, () => ({
      ...original,
      atomicReplace: async (file, content) => {
        if (String(file).endsWith("fail-b.json")) {
          throw new Error("Simulated composition replacement failure");
        }
        return original.atomicReplace(file, content);
      },
    }));
  `,
  );

  const failProc = Bun.spawn(
    [
      process.execPath, "--preload", failPreload, layerCli,
      "edit", layerId,
      "--fork", "--composition", "fail-b", "--use", "hero",
      "--image", blueImg, "--project", projDir, "--json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const failCode = await failProc.exited;
  const failStdout = await new Response(failProc.stdout).text();
  expect(failCode).toBe(1);
  const failJson = JSON.parse(failStdout);
  expect(failJson.ok).toBe(false);
  expect(failJson.error).toContain("Simulated composition replacement failure");

  // Live references, original identity, ALL revision documents, and all
  // pre-failure retained content are unchanged by the failure (the fork's
  // newly ingested blob is allowed to remain, per the documented contract).
  expect(await readFile(compAFile)).toEqual(compABefore);
  expect(await readFile(compBFile)).toEqual(compBBefore);
  expect(await readFile(path.join(projDir, "layers", `${layerId}.json`))).toEqual(identityBefore);
  expect(await snapshotDir(path.join(projDir, "layers", `${layerId}.revisions`))).toEqual(revisionsBefore);
  await expectFilesPreserved(contentBefore, path.join(projDir, "content"));
  expect((await readdir(path.join(projDir, "layers"))).sort()).toEqual(layersDirBefore);

  // Retry without the fault injection succeeds
  const retryRes = await invoke([
    "layer", "edit", layerId,
    "--fork", "--composition", "fail-b", "--use", "hero",
    "--image", blueImg, "--project", projDir, "--json",
  ]);
  expect(retryRes.code).toBe(0);
  const retryJson = JSON.parse(retryRes.stdout);
  const newLayerId = retryJson.layer.id as string;
  const bAfter = await inspectComp("fail-b");
  expect(bAfter.layers[0].layerId).toBe(newLayerId);
  const aAfter = await inspectComp("fail-a");
  expect(aAfter.layers[0].layerId).toBe(layerId);
  // The retry also leaves the original Layer's full retained state untouched
  expect(await readFile(path.join(projDir, "layers", `${layerId}.json`))).toEqual(identityBefore);
  expect(await snapshotDir(path.join(projDir, "layers", `${layerId}.revisions`))).toEqual(revisionsBefore);
  await expectFilesPreserved(contentBefore, path.join(projDir, "content"));
});

test("competing public CLI reader and edit serialize under the Project lock and cannot observe a half-published fork", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  await makeComp("race-a");
  await makeComp("race-b");
  const addRes = await addImageLayer("race-a", "hero", redImg);
  const layerId = addRes.use.layerId as string;
  await importComp("race-b", "race-a");

  const signalForkCommitting = path.join(tempDir, "race-fork-committing");
  const signalReaderAttempting = path.join(tempDir, "race-reader-attempting");
  const signalEdit2Attempting = path.join(tempDir, "race-edit2-attempting");

  // Fork editor preload: at the live composition commit (identity/revision
  // already staged, lock held), signal, then wait until BOTH competitors have
  // signaled they are blocked attempting the lock before completing.
  const editorPreload = path.join(tempDir, "race-editor.ts");
  await writeFile(
    editorPreload,
    `
    import { mock } from "bun:test";
    import { writeFile } from "node:fs/promises";
    import * as lock from ${JSON.stringify(lockModule)};
    const original = { ...lock };
    mock.module(${JSON.stringify(lockModule)}, () => ({
      ...original,
      atomicReplace: async (file, content) => {
        if (String(file).endsWith("race-b.json")) {
          await writeFile(${JSON.stringify(signalForkCommitting)}, "c");
          for (const sig of [${JSON.stringify(signalReaderAttempting)}, ${JSON.stringify(signalEdit2Attempting)}]) {
            const deadline = Date.now() + 10000;
            while (!(await Bun.file(sig).exists())) {
              if (Date.now() > deadline) throw new Error("Editor timed out waiting for " + sig);
              await Bun.sleep(5);
            }
          }
        }
        return original.atomicReplace(file, content);
      },
    }));
  `,
  );

  // Reader and second-editor preloads: signal immediately before blocking on
  // the Project lock (CRAFT-1 prior-art pattern).
  const makeAttemptPreload = async (file: string, signal: string) => {
    await writeFile(
      file,
      `
      import { mock } from "bun:test";
      import { writeFile } from "node:fs/promises";
      import * as lock from ${JSON.stringify(lockModule)};
      const original = { ...lock };
      mock.module(${JSON.stringify(lockModule)}, () => ({
        ...original,
        acquireProjectLock: async (...args) => {
          await writeFile(${JSON.stringify(signal)}, "a");
          return original.acquireProjectLock(...args);
        },
      }));
    `,
    );
  };
  const readerPreload = path.join(tempDir, "race-reader.ts");
  const edit2Preload = path.join(tempDir, "race-edit2.ts");
  await makeAttemptPreload(readerPreload, signalReaderAttempting);
  await makeAttemptPreload(edit2Preload, signalEdit2Attempting);

  // 1. Fork editor holds the lock mid-publication
  const editor = Bun.spawn(
    [
      process.execPath, "--preload", editorPreload, layerCli,
      "edit", layerId,
      "--fork", "--composition", "race-b", "--use", "hero",
      "--x", "70", "--project", projDir, "--json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const deadline1 = Date.now() + 10000;
  while (!(await Bun.file(signalForkCommitting).exists())) {
    if (Date.now() > deadline1) throw new Error("Editor never signaled fork commit");
    if (editor.exitCode !== null || editor.signalCode !== null) {
      const eOut = await new Response(editor.stdout).text();
      const eErr = await new Response(editor.stderr).text();
      throw new Error(`Editor exited before signaling fork commit: ${eOut} | ${eErr}`);
    }
    await Bun.sleep(5);
  }

  // 2. Reader attempts the lock mid-fork, blocks
  const reader = Bun.spawn(
    [
      process.execPath, "--preload", readerPreload, compositionCli,
      "inspect", "race-b", "--project", projDir, "--json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const deadline2 = Date.now() + 10000;
  while (!(await Bun.file(signalReaderAttempting).exists())) {
    if (Date.now() > deadline2) throw new Error("Reader never attempted the lock");
    await Bun.sleep(5);
  }

  // 3. Competing in-place editor attempts the lock mid-fork, blocks
  const edit2 = Bun.spawn(
    [
      process.execPath, "--preload", edit2Preload, layerCli,
      "edit", layerId, "--x", "33", "--project", projDir, "--json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const deadline3 = Date.now() + 10000;
  while (!(await Bun.file(signalEdit2Attempting).exists())) {
    if (Date.now() > deadline3) throw new Error("Competing editor never attempted the lock");
    await Bun.sleep(5);
  }

  // 4. Fork completes; competitors unblock in turn and observe full post-fork state
  expect(await editor.exited).toBe(0);
  const forkJson = JSON.parse(await new Response(editor.stdout).text());
  expect(forkJson.ok).toBe(true);
  const newLayerId = forkJson.layer.id as string;

  expect(await reader.exited).toBe(0);
  const readerJson = JSON.parse(await new Response(reader.stdout).text());
  expect(readerJson.ok).toBe(true);
  const heroUse = readerJson.composition.layers.find((l: { name: string }) => l.name === "hero");
  expect(heroUse.layerId).toBe(newLayerId);
  expect(heroUse.revision.x).toBe(70);

  // The competing in-place editor acquires the lock only after the fork:
  // its referrer discovery observes the post-fork state (single referrer,
  // race-a) and its edit commits under the original identity.
  expect(await edit2.exited).toBe(0);
  const edit2Json = JSON.parse(await new Response(edit2.stdout).text());
  expect(edit2Json.ok).toBe(true);
  expect(edit2Json.layer.id).toBe(layerId);
  expect(edit2Json.referringCompositions).toEqual(["race-a"]);
  expect(edit2Json.referrersCount).toBe(1);

  const finalB = await inspectComp("race-b");
  expect(finalB.layers[0].layerId).toBe(newLayerId);
  expect(finalB.layers[0].revision.x).toBe(70);
  const finalA = await inspectComp("race-a");
  expect(finalA.layers[0].layerId).toBe(layerId);
  const finalOld = await inspectLayerJson(layerId);
  expect(finalOld.layer.currentRevision.x).toBe(33);
}, 60000);

test("forked Projects keep working after relocation", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  await makeComp("reloc-a");
  await makeComp("reloc-b");
  const addRes = await addImageLayer("reloc-a", "hero", redImg);
  const layerId = addRes.use.layerId as string;
  await importComp("reloc-b", "reloc-a");

  const blueImg = path.join(tempDir, "blue.png");
  await writeFile(blueImg, solidPng(40, 40, BLUE));
  const forkRes = await invoke([
    "layer", "edit", layerId,
    "--fork", "--composition", "reloc-b", "--use", "hero",
    "--image", blueImg, "--project", projDir, "--json",
  ]);
  expect(forkRes.code).toBe(0);
  const newLayerId = (JSON.parse(forkRes.stdout).layer.id as string);

  // Relocate the Project; the forked Layer must still render from retained bytes
  const movedProj = path.join(tempDir, "moved-proj");
  await rename(projDir, movedProj);
  const renderRes = await invoke([
    "composition", "render", "reloc-b", "--project", movedProj, "--json",
  ]);
  expect(renderRes.code).toBe(0);
  expect(JSON.parse(renderRes.stdout).ok).toBe(true);
  const oldRender = await invoke([
    "composition", "render", "reloc-a", "--project", movedProj, "--json",
  ]);
  expect(oldRender.code).toBe(0);
  expect(JSON.parse(oldRender.stdout).ok).toBe(true);
  const aAfterMove = await inspectComp("reloc-a", movedProj);
  expect(aAfterMove.layers[0].layerId).toBe(layerId);

  // The new identity remains editable in place after relocation
  const editRes = await invoke([
    "layer", "edit", newLayerId, "--x", "11", "--project", movedProj, "--json",
  ]);
  expect(editRes.code).toBe(0);
  expect(JSON.parse(editRes.stdout).layer.id).toBe(newLayerId);
});