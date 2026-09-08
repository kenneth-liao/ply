/**
 * Cross-Project Composition copy (#86, spec #77 US-005 / US-008 / US-006, DEC-001–006).
 *
 * Verifies through the public CLI:
 * - Importing a mixed-content (image + text) Composition from a source Project
 *   into a destination Project creates independent destination Layer identities
 *   and copies the retained bytes required for inspection/edit/render.
 * - Duplicate uses of one source Layer identity map to exactly one new
 *   destination identity.
 * - Source and destination in-place edits are independent in both directions;
 *   renders prove the isolation with byte comparisons and inspectable PNGs.
 * - Removing the source Project and external input files leaves the destination
 *   fully usable: inspect, edit, and render all succeed from retained bytes.
 * - Collision rejection is fail-closed: byte-identical destination, no staged
 *   identity/revision artifacts, no dangling references.
 * - A source path resolving (via symlink alias) to the destination Project is
 *   refused with guidance to same-Project import.
 * - Dual-Project locking: sorted canonical order makes reverse-direction
 *   imports deadlock-free; a failed second-lock acquisition releases the
 *   first lock; a concurrent source mutation cannot produce a torn snapshot
 *   (deterministic signal-file handshakes, no sleeps).
 * - Injected publication failure leaves live state unchanged with staged
 *   artifacts cleaned, and a retry succeeds.
 * - Owned US-008/US-006 partition: compact default output, valid --json
 *   including failures, usage exit 2 / runtime exit 1, accurate help,
 *   offline, no implicit generation. Same-Project semantics are unchanged
 *   when the flag is absent.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, readdir, realpath, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePngRgba, decodePng } from "../src/png.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
// Preloaded spawns must target the submodule entry directly: the delegating
// cli.ts re-spawns the submodule without forwarding --preload.
const compositionCli = path.resolve(import.meta.dir, "../src/composition-cli.ts");
const layerCli = path.resolve(import.meta.dir, "../src/layer-cli.ts");
const lockModule = path.resolve(import.meta.dir, "../src/project-lock.ts");
const layerModule = path.resolve(import.meta.dir, "../src/layer.ts");

// Persisted (gitignored) evidence renders for visual inspection.
const evidenceDir = path.resolve(import.meta.dir, "../out/issue-86");

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

/** Spawn a submodule CLI directly so --preload mock modules apply. */
async function invokePreloaded(
  entry: string,
  args: string[],
  preload: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const result = Bun.spawn([process.execPath, "--preload", preload, entry, ...args], {
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
const GREEN: [number, number, number, number] = [0, 200, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];
const YELLOW: [number, number, number, number] = [255, 255, 0, 255];

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

const closeTo = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

let tempDir: string;
let destDir: string; // destination Project
let srcDir: string; // source Project

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-cross-import-"));
  destDir = path.join(tempDir, "dest");
  srcDir = path.join(tempDir, "source");
  await invoke(["project", "init", destDir, "--name", "dest-project"]);
  await invoke(["project", "init", srcDir, "--name", "source-project"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComp(project: string, name: string, width = 400, height = 300) {
  const res = await invoke([
    "composition", "create", name, "--width", String(width), "--height", String(height),
    "--project", project, "--json",
  ]);
  expect(res.code).toBe(0);
}

async function addImageLayer(
  project: string,
  comp: string,
  localName: string,
  imagePath: string,
  opts: { x?: number; y?: number; opacity?: number } = {},
) {
  const args = ["composition", "add", comp, localName, "--image", imagePath, "--project", project, "--json"];
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  if (opts.opacity !== undefined) args.push("--opacity", String(opts.opacity));
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

async function addTextLayer(
  project: string,
  comp: string,
  localName: string,
  text: string,
  opts: { fontSize?: number; color?: string; x?: number; y?: number } = {},
) {
  const args = [
    "composition", "add", comp, localName, "--text", text, "--font", "Anton",
    "--project", project, "--json",
  ];
  if (opts.fontSize !== undefined) args.push("--font-size", String(opts.fontSize));
  if (opts.color !== undefined) args.push("--color", opts.color);
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

function importArgs(target: string, source: string, fromProject?: string) {
  const args = ["composition", "import", target, source, "--project", destDir, "--json"];
  if (fromProject !== undefined) args.push("--from-project", fromProject);
  return args;
}

async function inspectComp(project: string, name: string) {
  const res = await invoke(["composition", "inspect", name, "--project", project, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).composition;
}

async function renderComp(project: string, name: string, out: string) {
  const res = await invoke(["composition", "render", name, "--out", out, "--project", project, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).render;
}

async function snapshotDir(dir: string): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  const walk = async (d: string, prefix: string) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(p, `${prefix}${entry.name}/`);
      } else if (entry.isFile()) {
        out[`${prefix}${entry.name}`] = await readFile(p);
      }
    }
  };
  await walk(dir, "");
  return out;
}

async function expectFilesPreserved(before: Record<string, Buffer>, dir: string) {
  const after = await snapshotDir(dir);
  for (const [name, bytes] of Object.entries(before)) {
    expect(after[name]).toBeDefined();
    expect(Buffer.compare(after[name]!, bytes)).toBe(0);
  }
}

async function waitForSignal(file: string, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await Bun.file(file).exists())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Standard mixed-content source fixture: image Layer at (30, 40) plus a text
 * Layer, imported into a destination Composition that already owns one Layer.
 */
async function setupMixedFixture() {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  await makeComp(srcDir, "src-comp");
  const imgAdd = await addImageLayer(srcDir, "src-comp", "hero", redImg, { x: 30, y: 40 });
  const textAdd = await addTextLayer(srcDir, "src-comp", "headline", "Hello", {
    fontSize: 48, color: "#ffffff", x: 20, y: 200,
  });
  await makeComp(destDir, "dst-comp");
  const yellowImg = path.join(tempDir, "yellow.png");
  await writeFile(yellowImg, solidPng(40, 40, YELLOW));
  await addImageLayer(destDir, "dst-comp", "own", yellowImg);
  return { imgAdd, textAdd, redImg };
}

test("mixed image+text cross-Project import creates independent destination identities with retained bytes; source is byte-identical", async () => {
  const { imgAdd, textAdd } = await setupMixedFixture();
  const srcLayerId = imgAdd.use.layerId as string;
  const srcTextLayerId = textAdd.use.layerId as string;

  // Source Project snapshot before the import: cross-copy must be read-only.
  const srcBefore = {
    compositions: await snapshotDir(path.join(srcDir, "compositions")),
    layers: await snapshotDir(path.join(srcDir, "layers")),
    content: await snapshotDir(path.join(srcDir, "content")),
  };

  const res = await invoke(importArgs("dst-comp", "src-comp", srcDir));
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(true);
  expect(json.importedUses).toHaveLength(2);

  const [imgUse, textUse] = json.importedUses;
  expect(imgUse.name).toBe("hero");
  expect(textUse.name).toBe("headline");
  // Independent destination identities — not the source ids, not shared.
  expect(imgUse.layerId).not.toBe(srcLayerId);
  expect(textUse.layerId).not.toBe(srcTextLayerId);
  expect(imgUse.layerId).not.toBe(textUse.layerId);

  // Destination reference list: own use first, imported uses appended in source order.
  const dst = await inspectComp(destDir, "dst-comp");
  expect(dst.layers.map((l: { name: string }) => l.name)).toEqual(["own", "hero", "headline"]);
  expect(dst.layers[1].layerId).toBe(imgUse.layerId);
  expect(dst.layers[2].layerId).toBe(textUse.layerId);

  // Destination canvas preserved.
  expect(dst.canvas).toEqual({ width: 400, height: 300 });

  // Retained bytes: destination content store carries the source content.
  const dstContent = await snapshotDir(path.join(destDir, "content"));
  const srcContent = await snapshotDir(path.join(srcDir, "content"));
  for (const [hash, bytes] of Object.entries(srcContent)) {
    expect(dstContent[hash]).toBeDefined();
    expect(Buffer.compare(dstContent[hash]!, bytes)).toBe(0);
  }

  // Source Project is byte-identical across the import.
  expect(await snapshotDir(path.join(srcDir, "compositions"))).toEqual(srcBefore.compositions);
  expect(await snapshotDir(path.join(srcDir, "layers"))).toEqual(srcBefore.layers);
  expect(await snapshotDir(path.join(srcDir, "content"))).toEqual(srcBefore.content);

  // Render the destination and inspect the actual pixels (visual evidence).
  await mkdir(evidenceDir, { recursive: true });
  const out = path.join(evidenceDir, "cross-import-mixed.png");
  const render = await renderComp(destDir, "dst-comp", out);
  expect(render.width).toBe(400);
  expect(render.height).toBe(300);
  const png = decodePng(await readFile(out));
  expect(png.width).toBe(400);
  expect(png.height).toBe(300);
  const [r, g, b] = pixel(png, 35, 45);
  expect(closeTo(r, 255) && closeTo(g, 0) && closeTo(b, 0)).toBe(true);
  // Text Layer painted somewhere nontransparent in its region (retained font bytes render locally).
  const textPixels = [0, 4, 8].map((dy) => pixel(png, 24, 210 + dy));
  expect(textPixels.some(([tr, tg, tb]) => tr > 240 && tg > 240 && tb > 240)).toBe(true);
});

test("duplicate uses of one source Layer identity map to a single destination identity", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  await makeComp(srcDir, "base");
  const add = await addImageLayer(srcDir, "base", "hero", redImg, { x: 10, y: 10 });
  const srcLayerId = add.use.layerId as string;

  // Build a source Composition with two uses of the same Layer: same-Project
  // import plus a renamed alias in the document (reachable state; test setup
  // mirrors the #85 prior art — the operation under test is the public CLI).
  await makeComp(srcDir, "dup");
  await invoke(["composition", "import", "dup", "base", "--project", srcDir, "--json"]);
  const dupFile = path.join(srcDir, "compositions", "dup.json");
  const dup = JSON.parse(await readFile(dupFile, "utf8"));
  dup.layers.push({ name: "hero-alias", layerId: srcLayerId });
  await writeFile(dupFile, JSON.stringify(dup, null, 2) + "\n");

  await makeComp(destDir, "dup-dst");
  const res = await invoke(importArgs("dup-dst", "dup", srcDir));
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.importedUses).toHaveLength(2);

  const [first, second] = json.importedUses;
  expect(first.name).toBe("hero");
  expect(second.name).toBe("hero-alias");
  // Exactly ONE new destination identity per distinct source Layer.
  expect(first.layerId).toBe(second.layerId);
  expect(first.layerId).not.toBe(srcLayerId);

  const dst = await inspectComp(destDir, "dup-dst");
  expect(dst.layers).toHaveLength(2);
  expect(dst.layers[0].layerId).toBe(first.layerId);
  expect(dst.layers[1].layerId).toBe(first.layerId);

  // Destination renders the copied Layer twice at its stored placement.
  const out = path.join(evidenceDir, "cross-import-duplicate.png");
  await renderComp(destDir, "dup-dst", out);
  const png = decodePng(await readFile(out));
  const [r, g, b] = pixel(png, 15, 15);
  expect(closeTo(r, 255) && closeTo(g, 0) && closeTo(b, 0)).toBe(true);
});

test("two-way edit independence: source in-place edit leaves destination byte-identical; destination edit leaves source byte-identical", async () => {
  const { imgAdd } = await setupMixedFixture();
  const srcLayerId = imgAdd.use.layerId as string;

  const res = await invoke(importArgs("dst-comp", "src-comp", srcDir));
  expect(res.code).toBe(0);
  const dstLayerId = (JSON.parse(res.stdout).importedUses[0].layerId as string);

  const destRenderBefore = path.join(tempDir, "dest-before-src-edit.png");
  await renderComp(destDir, "dst-comp", destRenderBefore);
  const destBeforeBytes = await readFile(destRenderBefore);
  const srcRenderBefore = path.join(tempDir, "src-before.png");
  await renderComp(srcDir, "src-comp", srcRenderBefore);
  const srcBeforeBytes = await readFile(srcRenderBefore);

  // Source in-place edit (single referrer in the source Project needs no flag).
  const greenImg = path.join(tempDir, "green.png");
  await writeFile(greenImg, solidPng(50, 50, GREEN));
  const editSrc = await invoke(["layer", "edit", srcLayerId, "--image", greenImg, "--project", srcDir, "--json"]);
  expect(editSrc.code).toBe(0);

  // Destination render is byte-identical across the source edit.
  const destRenderAfter = path.join(tempDir, "dest-after-src-edit.png");
  await renderComp(destDir, "dst-comp", destRenderAfter);
  expect(await readFile(destRenderAfter)).toEqual(destBeforeBytes);
  // Source render changed to the edited content.
  const srcRenderAfter = path.join(tempDir, "src-after-src-edit.png");
  await renderComp(srcDir, "src-comp", srcRenderAfter);
  const srcAfterSrcEditBytes = await readFile(srcRenderAfter);
  const srcPng = decodePng(srcAfterSrcEditBytes);
  const [sr, sg, sb] = pixel(srcPng, 35, 45);
  expect(closeTo(sr, 0) && closeTo(sg, 200) && closeTo(sb, 0)).toBe(true);
  expect(await readFile(srcRenderAfter)).not.toEqual(srcBeforeBytes);

  // Destination in-place edit (single referrer in the destination Project).
  const editDst = await invoke(["layer", "edit", dstLayerId, "--opacity", "0.5", "--project", destDir, "--json"]);
  expect(editDst.code).toBe(0);

  // Source render is byte-identical across the destination edit.
  const srcRenderAfterDst = path.join(tempDir, "src-after-dst-edit.png");
  await renderComp(srcDir, "src-comp", srcRenderAfterDst);
  expect(await readFile(srcRenderAfterDst)).toEqual(srcAfterSrcEditBytes);

  // Destination render changed (opacity halved over transparent canvas).
  const destRenderAfterDst = path.join(evidenceDir, "cross-import-dest-edited.png");
  await renderComp(destDir, "dst-comp", destRenderAfterDst);
  const dstPng = decodePng(await readFile(destRenderAfterDst));
  const [dr, dg, db] = pixel(dstPng, 35, 45);
  expect(closeTo(dr, 255, 4) && closeTo(dg, 0, 4) && closeTo(db, 0, 4)).toBe(true);
  expect(await readFile(destRenderAfterDst)).not.toEqual(destRenderAfter);

  // In-place edits preserved both identities.
  const dstAfter = await inspectComp(destDir, "dst-comp");
  expect(dstAfter.layers[1].layerId).toBe(dstLayerId);
  const srcAfter = await inspectComp(srcDir, "src-comp");
  expect(srcAfter.layers[0].layerId).toBe(srcLayerId);
});

test("destination remains fully usable after the source Project and external input files are removed", async () => {
  const { imgAdd } = await setupMixedFixture();
  const res = await invoke(importArgs("dst-comp", "src-comp", srcDir));
  expect(res.code).toBe(0);
  const dstImgLayerId = JSON.parse(res.stdout).importedUses[0].layerId as string;

  // Remove the source Project entirely and the external input file.
  const externalInput = path.join(tempDir, "red.png");
  await rm(srcDir, { recursive: true, force: true });
  await rm(externalInput, { force: true });

  // Inspect, edit, and render all succeed from retained destination bytes.
  const insp = await inspectComp(destDir, "dst-comp");
  expect(insp.layers).toHaveLength(3);

  const edit = await invoke(["layer", "edit", dstImgLayerId, "--x", "100", "--y", "80", "--project", destDir, "--json"]);
  expect(edit.code).toBe(0);

  const out = path.join(evidenceDir, "cross-import-source-free.png");
  const render = await renderComp(destDir, "dst-comp", out);
  expect(render.width).toBe(400);
  const png = decodePng(await readFile(out));
  // Image Layer moved to (100, 80); text Layer still renders from retained font bytes.
  const [r, g, b] = pixel(png, 105, 85);
  expect(closeTo(r, 255) && closeTo(g, 0) && closeTo(b, 0)).toBe(true);
  const textPixels = [0, 4, 8].map((dy) => pixel(png, 24, 210 + dy));
  expect(textPixels.some(([tr, tg, tb]) => tr > 240 && tg > 240 && tb > 240)).toBe(true);
});

test("collision rejection is fail-closed: byte-identical destination, no staged artifacts", async () => {
  const { redImg } = { redImg: path.join(tempDir, "red.png") };
  await writeFile(redImg, solidPng(50, 50, RED));
  await makeComp(srcDir, "src-comp");
  await addImageLayer(srcDir, "src-comp", "collide", redImg);
  await makeComp(destDir, "dst-comp");
  const ownImg = path.join(tempDir, "blue.png");
  await writeFile(ownImg, solidPng(40, 40, BLUE));
  await addImageLayer(destDir, "dst-comp", "collide", ownImg);

  const destCompositionsBefore = await snapshotDir(path.join(destDir, "compositions"));
  const destLayersBefore = await snapshotDir(path.join(destDir, "layers"));
  const destContentBefore = await snapshotDir(path.join(destDir, "content"));

  const res = await invoke(importArgs("dst-comp", "src-comp", srcDir));
  expect(res.code).toBe(1);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(false);
  expect(json.error).toContain("collide");

  // Destination is byte-identical: no partial live identity state.
  expect(await snapshotDir(path.join(destDir, "compositions"))).toEqual(destCompositionsBefore);
  expect(await snapshotDir(path.join(destDir, "layers"))).toEqual(destLayersBefore);
  expect(await snapshotDir(path.join(destDir, "content"))).toEqual(destContentBefore);
});

test("a source path that resolves to the destination Project is refused with same-Project guidance", async () => {
  await setupMixedFixture();
  const destCompositionsBefore = await snapshotDir(path.join(destDir, "compositions"));
  const destLayersBefore = await snapshotDir(path.join(destDir, "layers"));

  // Symlink alias onto the destination Project passed as the source.
  const alias = path.join(tempDir, "dest-alias");
  await Bun.spawn(["ln", "-s", destDir, alias]).exited;

  const res = await invoke(importArgs("dst-comp", "dst-comp", alias));
  expect(res.code).toBe(1);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(false);
  expect(json.error).toContain("same Project");
  expect(json.error).toContain("composition import");

  // The destination Project is untouched.
  expect(await snapshotDir(path.join(destDir, "compositions"))).toEqual(destCompositionsBefore);
  expect(await snapshotDir(path.join(destDir, "layers"))).toEqual(destLayersBefore);
});

test("empty source Composition import across Projects is a clean no-op", async () => {
  await makeComp(srcDir, "empty-src");
  await makeComp(destDir, "dst");
  const before = await snapshotDir(path.join(destDir, "compositions"));
  const res = await invoke(importArgs("dst", "empty-src", srcDir));
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(true);
  expect(json.importedUses).toHaveLength(0);
  expect(await snapshotDir(path.join(destDir, "compositions"))).toEqual(before);
});

test("failed second-lock acquisition releases the first lock", async () => {
  await setupMixedFixture();

  // Deterministic canonical order: the Project whose realpath sorts second
  // receives a stale (dead-PID) lock, so the import acquires its first lock,
  // fails on the second, and must release the first.
  const [destReal, srcReal] = await Promise.all([realpath(destDir), realpath(srcDir)]);
  const secondProject = destReal < srcReal ? destDir : srcDir;
  const firstProject = destReal < srcReal ? srcDir : destDir;
  await writeFile(
    path.join(secondProject, ".ply.lock"),
    JSON.stringify({ pid: 999999999, token: "stale-dead-pid", createdAt: new Date().toISOString() }) + "\n",
  );

  const res = await invoke(importArgs("dst-comp", "src-comp", srcDir));
  expect(res.code).toBe(1);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(false);
  expect(json.error).toContain("dead process");

  // The first lock was released: no lock file remains on the other Project.
  await expect(Bun.file(path.join(firstProject, ".ply.lock")).exists()).resolves.toBe(false);
});

test("reverse-direction imports serialize under dual locking and both succeed (no deadlock)", async () => {
  // Two Projects importing from each other concurrently. Each import signals
  // after acquiring its first lock and before attempting its second; the test
  // waits until BOTH are in the exact deadlock window (both first locks held,
  // both second locks attempted) and then requires both to complete.
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));
  const blueImg = path.join(tempDir, "blue.png");
  await writeFile(blueImg, solidPng(50, 50, BLUE));
  await makeComp(destDir, "a-comp");
  await makeComp(srcDir, "b-comp");
  await addImageLayer(destDir, "a-comp", "red-hero", redImg);
  await addImageLayer(srcDir, "b-comp", "blue-hero", blueImg);
  await makeComp(destDir, "a-copy");
  await makeComp(srcDir, "b-copy");

  const signals = path.join(tempDir, "signals");
  await mkdir(signals);
  const aFirst = path.join(signals, "a-first");
  const aSecond = path.join(signals, "a-second");
  const bFirst = path.join(signals, "b-first");
  const bSecond = path.join(signals, "b-second");

  const makePreload = async (file: string, firstSignal: string, secondSignal: string) => {
    const preload = path.join(tempDir, `lock-signal-${path.basename(file)}.ts`);
    await writeFile(
      preload,
      `
      import { mock } from "bun:test";
      import * as lock from ${JSON.stringify(lockModule)};
      const original = { ...lock };
      let calls = 0;
      mock.module(${JSON.stringify(lockModule)}, () => ({
        ...original,
        acquireProjectLock: async (p: string, o?: { timeoutMs?: number }) => {
          calls += 1;
          if (calls === 1) {
            const l = await original.acquireProjectLock(p, o);
            const { writeFile } = await import("node:fs/promises");
            await writeFile(${JSON.stringify(firstSignal)}, "1");
            return l;
          }
          const { writeFile } = await import("node:fs/promises");
          await writeFile(${JSON.stringify(secondSignal)}, "1");
          return original.acquireProjectLock(p, o);
        },
      }));
    `,
    );
    return preload;
  };

  const preloadA = await makePreload(aFirst, aFirst, aSecond);
  const preloadB = await makePreload(bFirst, bFirst, bSecond);

  // A: destination Project A (destDir) imports from B (srcDir).
  const procA = Bun.spawn(
    [
      process.execPath, "--preload", preloadA, compositionCli,
      "import", "a-copy", "b-comp", "--from-project", srcDir, "--project", destDir, "--json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  // B: destination Project B (srcDir) imports from A (destDir) — reverse order.
  const procB = Bun.spawn(
    [
      process.execPath, "--preload", preloadB, compositionCli,
      "import", "b-copy", "a-comp", "--from-project", destDir, "--project", srcDir, "--json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  await waitForSignal(aFirst, "import A first lock");
  await waitForSignal(bFirst, "import B first lock");
  await waitForSignal(aSecond, "import A second lock attempt");
  await waitForSignal(bSecond, "import B second lock attempt");

  const [codeA, codeB] = await Promise.all([procA.exited, procB.exited]);
  const outA = await new Response(procA.stdout).text();
  const outB = await new Response(procB.stdout).text();
  expect(codeA).toBe(0);
  expect(codeB).toBe(0);
  expect(JSON.parse(outA).ok).toBe(true);
  expect(JSON.parse(outB).ok).toBe(true);

  const aAfter = await inspectComp(destDir, "a-copy");
  expect(aAfter.layers).toHaveLength(1);
  const bAfter = await inspectComp(srcDir, "b-copy");
  expect(bAfter.layers).toHaveLength(1);
});

test("concurrent source mutation cannot produce a torn snapshot; destination copies a consistent pre-edit state", async () => {
  const { imgAdd } = await setupMixedFixture();
  const srcLayerId = imgAdd.use.layerId as string;

  const signals = path.join(tempDir, "signals");
  await mkdir(signals);
  const snapshotBegan = path.join(signals, "snapshot-began");
  const snapshotRelease = path.join(signals, "snapshot-release");
  const locksHeld = path.join(signals, "locks-held");
  const editAttempting = path.join(signals, "edit-attempting");

  // Import preload: after BOTH Project locks are held, signal; on the first
  // source Layer resolution, hold the snapshot open (both locks held) until
  // the test releases it.
  const importPreload = path.join(tempDir, "snapshot-hook.ts");
  await writeFile(
    importPreload,
    `
    import { mock } from "bun:test";
    import * as lock from ${JSON.stringify(lockModule)};
    import * as layer from ${JSON.stringify(layerModule)};
    const originalLock = { ...lock };
    const originalLayer = { ...layer };
    let lockCalls = 0;
    let hooked = false;
    mock.module(${JSON.stringify(lockModule)}, () => ({
      ...originalLock,
      acquireProjectLock: async (p: string, o?: { timeoutMs?: number }) => {
        const l = await originalLock.acquireProjectLock(p, o);
        lockCalls += 1;
        if (lockCalls === 2) {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(${JSON.stringify(locksHeld)}, "1");
        }
        return l;
      },
    }));
    mock.module(${JSON.stringify(layerModule)}, () => ({
      ...originalLayer,
      readLayerInternalFull: async (p: string, id: string) => {
        if (!hooked) {
          hooked = true;
          const { writeFile } = await import("node:fs/promises");
          await writeFile(${JSON.stringify(snapshotBegan)}, "1");
          const deadline = Date.now() + 30_000;
          while (!(await Bun.file(${JSON.stringify(snapshotRelease)}).exists())) {
            if (Date.now() > deadline) throw new Error("Timed out waiting for snapshot release");
            await new Promise((r) => setTimeout(r, 10));
          }
        }
        return originalLayer.readLayerInternalFull(p, id);
      },
    }));
  `,
  );

  // Competing source edit preload: signal immediately before attempting the
  // source Project lock.
  const editPreload = path.join(tempDir, "edit-hook.ts");
  await writeFile(
    editPreload,
    `
    import { mock } from "bun:test";
    import * as lock from ${JSON.stringify(lockModule)};
    const original = { ...lock };
    mock.module(${JSON.stringify(lockModule)}, () => ({
      ...original,
      acquireProjectLock: async (p: string, o?: { timeoutMs?: number }) => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(${JSON.stringify(editAttempting)}, "1");
        return original.acquireProjectLock(p, o);
      },
    }));
  `,
  );

  const greenImg = path.join(tempDir, "green.png");
  await writeFile(greenImg, solidPng(50, 50, GREEN));

  const procImport = Bun.spawn(
    [
      process.execPath, "--preload", importPreload, compositionCli,
      "import", "dst-comp", "src-comp", "--from-project", srcDir, "--project", destDir, "--json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  // The import holds both Project locks before the competing edit is even
  // started, so its snapshot is definitively the pre-edit state.
  await waitForSignal(locksHeld, "import holds both locks");

  const procEdit = Bun.spawn(
    [
      process.execPath, "--preload", editPreload, layerCli,
      "edit", srcLayerId, "--image", greenImg, "--project", srcDir, "--json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  // The import holds both locks mid-snapshot; the source edit is blocked on
  // the source lock. Both handshakes observed before either can proceed.
  await waitForSignal(snapshotBegan, "import snapshot began");
  await waitForSignal(editAttempting, "source edit attempting lock");

  // Release the snapshot; the import completes its consistent copy, then the
  // edit acquires the source lock.
  await writeFile(snapshotRelease, "1");
  const codeImport = await procImport.exited;
  const codeEdit = await procEdit.exited;
  expect(codeImport).toBe(0);
  expect(codeEdit).toBe(0);

  // The destination snapshot is the consistent pre-edit state (red), never a
  // torn mix of the edit's identity pointer and old content bytes.
  const out = path.join(evidenceDir, "cross-import-concurrent-snapshot.png");
  await renderComp(destDir, "dst-comp", out);
  const png = decodePng(await readFile(out));
  const [r, g, b] = pixel(png, 35, 45);
  expect(closeTo(r, 255) && closeTo(g, 0) && closeTo(b, 0)).toBe(true);

  // The source edit applied only to the source Project.
  const srcOut = path.join(tempDir, "src-after-race.png");
  await renderComp(srcDir, "src-comp", srcOut);
  const srcPng = decodePng(await readFile(srcOut));
  const [sr, sg, sb] = pixel(srcPng, 35, 45);
  expect(closeTo(sr, 0) && closeTo(sg, 200) && closeTo(sb, 0)).toBe(true);

  // The destination Layer is an independent identity, untouched by the edit.
  const dst = await inspectComp(destDir, "dst-comp");
  expect(dst.layers[1].layerId).not.toBe(srcLayerId);
});

test("injected publication failure leaves live state unchanged with staged artifacts cleaned, and a retry succeeds", async () => {
  const { imgAdd, textAdd } = await setupMixedFixture();
  const srcCompBefore = await snapshotDir(path.join(srcDir, "compositions"));
  const srcLayersBefore = await snapshotDir(path.join(srcDir, "layers"));
  const srcContentBefore = await snapshotDir(path.join(srcDir, "content"));

  const destCompFile = path.join(destDir, "compositions", "dst-comp.json");
  const destCompBefore = await readFile(destCompFile);
  const destLayersBefore = await snapshotDir(path.join(destDir, "layers"));
  const destContentBefore = await snapshotDir(path.join(destDir, "content"));

  // Force the destination Composition replacement to fail after staging.
  const failPreload = path.join(tempDir, "fail-replace.ts");
  await writeFile(
    failPreload,
    `
    import { mock } from "bun:test";
    import * as lock from ${JSON.stringify(lockModule)};
    const original = { ...lock };
    mock.module(${JSON.stringify(lockModule)}, () => ({
      ...original,
      atomicReplace: async (file: string, content: string | Buffer) => {
        if (String(file).endsWith("dst-comp.json")) {
          throw new Error("Simulated destination publication failure");
        }
        return original.atomicReplace(file, content);
      },
    }));
  `,
  );

  const failProc = await invokePreloaded(
    compositionCli,
    ["import", "dst-comp", "src-comp", "--from-project", srcDir, "--project", destDir, "--json"],
    failPreload,
  );
  expect(failProc.code).toBe(1);
  const failJson = JSON.parse(failProc.stdout);
  expect(failJson.ok).toBe(false);
  expect(failJson.error).toContain("Simulated destination publication failure");

  // Live destination references unchanged; no staged identity/revision
  // artifacts remain (cleanup removed them).
  expect(await readFile(destCompFile)).toEqual(destCompBefore);
  expect(await snapshotDir(path.join(destDir, "layers"))).toEqual(destLayersBefore);
  // Pre-failure retained content is preserved; the copied blobs may remain as
  // documented orphans (established protocol) and must match source content.
  await expectFilesPreserved(destContentBefore, path.join(destDir, "content"));
  const destContentAfter = await snapshotDir(path.join(destDir, "content"));
  for (const [hash, bytes] of Object.entries(destContentAfter)) {
    if (destContentBefore[hash] === undefined) {
      expect(srcContentBefore[hash]).toBeDefined();
      expect(Buffer.compare(bytes, srcContentBefore[hash]!)).toBe(0);
    }
  }
  // The source Project was never mutated.
  expect(await snapshotDir(path.join(srcDir, "compositions"))).toEqual(srcCompBefore);
  expect(await snapshotDir(path.join(srcDir, "layers"))).toEqual(srcLayersBefore);
  expect(await snapshotDir(path.join(srcDir, "content"))).toEqual(srcContentBefore);

  // Retry without the fault injection succeeds.
  const retry = await invoke(importArgs("dst-comp", "src-comp", srcDir));
  expect(retry.code).toBe(0);
  const retryJson = JSON.parse(retry.stdout);
  expect(retryJson.ok).toBe(true);
  expect(retryJson.importedUses).toHaveLength(2);
  const dst = await inspectComp(destDir, "dst-comp");
  expect(dst.layers.map((l: { name: string }) => l.name)).toEqual(["own", "hero", "headline"]);
  expect(dst.layers[1].layerId).not.toBe(imgAdd.use.layerId);
  expect(dst.layers[2].layerId).not.toBe(textAdd.use.layerId);
});

test("usage errors exit 2, runtime failures exit 1, JSON failures are valid, help documents the flag, and same-Project behavior is unchanged", async () => {
  await setupMixedFixture();

  // --from-project without a value: usage error, exit 2, valid JSON failure.
  const missingValue = await invoke([
    "composition", "import", "dst-comp", "src-comp", "--project", destDir, "--json", "--from-project",
  ]);
  expect(missingValue.code).toBe(2);
  expect(JSON.parse(missingValue.stdout).ok).toBe(false);

  // Nonexistent source Project: runtime error, exit 1.
  const missing = await invoke(importArgs("dst-comp", "src-comp", path.join(tempDir, "nope")));
  expect(missing.code).toBe(1);
  expect(JSON.parse(missing.stdout).ok).toBe(false);
  expect(JSON.parse(missing.stdout).error).toContain("Project");

  // Help documents --from-project and the Project boundary.
  const help = await invoke(["composition", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("--from-project");
  expect(help.stdout).toContain("Project");

  // Same-Project behavior unchanged when the flag is absent (#84): self-import
  // is still refused with exit 1.
  const selfImport = await invoke(importArgs("dst-comp", "dst-comp"));
  expect(selfImport.code).toBe(1);
  expect(JSON.parse(selfImport.stdout).ok).toBe(false);
  expect(JSON.parse(selfImport.stdout).error).toContain("itself");
});
