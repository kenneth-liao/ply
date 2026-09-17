/**
 * Integrated qualification: Prove the complete foundation workflow after relocation offline
 * (#88, spec #77 US-001 / US-006, DEC-001–006, TEST-001–005).
 *
 * This test suite qualifies the whole introduced foundation surface in one coherent
 * integrated workflow:
 * 1. Network isolation negative control: Prove process-level network denial using a local
 *    listener reachable outside sandbox but blocked inside, inherited by child processes.
 * 2. Integrated A -> B -> C lifecycle under process-level network denial:
 *    - Create Project A, mixed image + text Composition A, initial render and manifest capture.
 *    - Same-project reuse in Composition B: subset (remove image use), add local text, interleave uses (reorder).
 *    - Transitive A -> B -> C reuse in Composition C.
 *    - Blast-radius guard: Unflagged edit on 3-referrer shared Layer fails closed with exit 1.
 *    - In-place edit propagation: advances revision across referrers; re-renders reflect changes.
 *    - Isolated fork: publishes a new Layer identity for C's use; C's pixels change while B's and A's remain unchanged.
 *    - Historical replay: replay A's captured manifest from pinned history; output is 100% byte-identical to original.
 * 3. Cross-Project copy, complete source deletion, relocation, and offline usability:
 *    - Cross-Project import from a source Project into a destination Project as independent
 *      identities with retained font/image bytes.
 *    - Render in the destination Project and capture a manifest.
 *    - Delete the original source input image and the source Project completely from disk.
 *    - Relocate the destination Project to a new path.
 *    - Exercise full lifecycle in the relocated destination offline: inspect, edit
 *      (font-preserving in-place & fork), add a text Layer, render the new state, and replay
 *      the historical manifest (100% byte-identical).
 * 4. Full introduced command and help coverage under network denial.
 *
 * The suite runs only on Darwin, where kernel-level process denial
 * (sandbox-exec) is available and proven by the negative control; off
 * Darwin it skips rather than claiming a weaker isolation is enough.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { encodePngRgba, readPngHeader, decodePng } from "../src/png.js";
import { closeBrowser } from "../src/browser.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const outEvidenceDir = path.resolve(import.meta.dir, "../out/issue-88");

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

/** Pixel (x, y) of a decoded RGBA PNG as [r, g, b, a] — the predecessor test idiom. */
function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

/** Whether any pixel satisfies the predicate — finds visible rendered content without sampling guesses. */
function hasPixel(png: ReturnType<typeof decodePng>, match: (p: [number, number, number, number]) => boolean): boolean {
  for (let i = 0; i < png.rgba.length; i += 4) {
    if (match([png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!])) {
      return true;
    }
  }
  return false;
}

const isRedPixel = (p: [number, number, number, number]) => p[0]! > 230 && p[1]! < 40 && p[2]! < 40;
const isBluePixel = (p: [number, number, number, number]) => p[2]! > 230 && p[0]! < 40 && p[1]! < 40;

/**
 * Offline execution parameters enforcing process-level network denial:
 * kernel-level sandbox-exec '(deny network*)'. Darwin-only — off Darwin the
 * suite skips instead of claiming weaker (proxy-env) isolation is proof.
 */
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

async function invokeOffline(args: string[]) {
  const result = Bun.spawn(offlineCommand(args), {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-offline-qual-"));
  await mkdir(outEvidenceDir, { recursive: true });
});

afterEach(async () => {
  await closeBrowser();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. Process-level network denial negative control
// ---------------------------------------------------------------------------

const darwinOnly = test.skipIf(process.platform !== "darwin");

darwinOnly("network isolation negative control: local listener is reachable outside sandbox but denied inside", async () => {
  let server: Server | null = null;
  const port = await new Promise<number>((resolve, reject) => {
    const s = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("online-ok");
    });
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (typeof addr === "object" && addr) {
        server = s;
        resolve(addr.port);
      } else {
        reject(new Error("Failed to obtain server address"));
      }
    });
  });

  try {
    const targetUrl = `http://127.0.0.1:${port}/probe`;

    // 1. Unsandboxed request succeeds
    const onlineRes = await fetch(targetUrl);
    expect(onlineRes.status).toBe(200);
    expect(await onlineRes.text()).toBe("online-ok");

    // 2. Sandboxed request inside child process fails at OS socket layer
    const probeProc = Bun.spawn(
      [
        "sandbox-exec",
        "-p",
        "(version 1) (allow default) (deny network*)",
        process.execPath,
        "-e",
        `fetch("${targetUrl}").then(() => process.exit(0)).catch(() => process.exit(42))`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const probeCode = await probeProc.exited;
    expect(probeCode).toBe(42);
  } finally {
    if (server) {
      await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Integrated A -> B -> C mixed workflow with shared edits, fork, and replay
// ---------------------------------------------------------------------------

/** Explicit per-test timeouts: the multi-render phases cost ~5s+ per test,
 * above Bun's 5s default — without these the long phases are killed by the
 * runner's timeout and reported as failures (observed 2026-09, Bun 1.4.0). */
const LONG = 240_000;

test.skipIf(process.platform !== "darwin")("integrated mixed image/text A -> B -> C workflow with reuse, interleave, propagation, fork, and historical replay offline", async () => {
  const projA = path.join(tempDir, "projA");
  const initA = await invokeOffline(["project", "init", projA, "--name", "Project A", "--json"]);
  expect(initA.code).toBe(0);
  expect(JSON.parse(initA.stdout).ok).toBe(true);

  // Inspect Project A
  const inspectProjA = await invokeOffline(["project", "inspect", "--project", projA, "--json"]);
  expect(inspectProjA.code).toBe(0);
  expect(JSON.parse(inspectProjA.stdout).project.name).toBe("Project A");

  // Create Composition A with mixed Image + Text layers
  const imgA = path.join(tempDir, "bg.png");
  await writeFile(imgA, solidPng(64, 64, RED));

  const createA = await invokeOffline([
    "composition",
    "create",
    "compA",
    "--width",
    "1280",
    "--height",
    "720",
    "--project",
    projA,
    "--json",
  ]);
  expect(createA.code).toBe(0);

  const addImgA = await invokeOffline([
    "composition",
    "add",
    "compA",
    "bg",
    "--image",
    imgA,
    "--x",
    "0",
    "--y",
    "0",
    "--project",
    projA,
    "--json",
  ]);
  expect(addImgA.code).toBe(0);
  const imgLayerId = JSON.parse(addImgA.stdout).use.layerId as string;

  const addTextA = await invokeOffline([
    "composition",
    "add",
    "compA",
    "title",
    "--text",
    "Foundation Base Title",
    "--font",
    "Source Sans 3",
    "--font-size",
    "48",
    "--color",
    "#ffffff",
    "--x",
    "100",
    "--y",
    "100",
    "--project",
    projA,
    "--json",
  ]);
  expect(addTextA.code).toBe(0);
  const textLayerId = JSON.parse(addTextA.stdout).use.layerId as string;

  // Verify Layer inspect and list
  const listLayersA = await invokeOffline(["layer", "list", "--project", projA, "--json"]);
  expect(listLayersA.code).toBe(0);
  expect(JSON.parse(listLayersA.stdout).layers).toHaveLength(2);

  const inspectImgLayer = await invokeOffline(["layer", "inspect", imgLayerId, "--project", projA, "--json"]);
  expect(inspectImgLayer.code).toBe(0);
  expect(JSON.parse(inspectImgLayer.stdout).layer.currentRevision.kind).toBe("image");

  const inspectTextLayer = await invokeOffline(["layer", "inspect", textLayerId, "--project", projA, "--json"]);
  expect(inspectTextLayer.code).toBe(0);
  expect(JSON.parse(inspectTextLayer.stdout).layer.currentRevision.kind).toBe("text");

  // Initial Render of Composition A -> produces P_A and captures manifest M_A
  const renderA = await invokeOffline(["composition", "render", "compA", "--project", projA, "--json"]);
  expect(renderA.code).toBe(0);
  const renderAJson = JSON.parse(renderA.stdout);
  expect(renderAJson.ok).toBe(true);
  const manifestAPath = renderAJson.render.manifest as string;
  const pngAPath = renderAJson.render.output as string;
  const pngABytes = await readFile(pngAPath);
  expect(pngABytes.length).toBeGreaterThan(0);

  // Dimension + pixel evidence for Composition A (TEST-002/TEST-005):
  // exactly the requested canvas, and the solid red image Layer is visibly painted.
  expect(readPngHeader(pngABytes)).toMatchObject({ width: 1280, height: 720 });
  const decodedA = decodePng(pngABytes);
  expect(hasPixel(decodedA, isRedPixel)).toBe(true);

  // Save evidence
  await writeFile(path.join(outEvidenceDir, "compA_initial.png"), pngABytes);

  // -------------------------------------------------------------------------
  // Composition B: Same-Project import, subset (remove bg), add badge, interleave (reorder)
  // -------------------------------------------------------------------------
  const createB = await invokeOffline([
    "composition",
    "create",
    "compB",
    "--width",
    "1280",
    "--height",
    "720",
    "--project",
    projA,
    "--json",
  ]);
  expect(createB.code).toBe(0);

  const importB = await invokeOffline(["composition", "import", "compB", "compA", "--project", projA, "--json"]);
  expect(importB.code).toBe(0);
  expect(JSON.parse(importB.stdout).importedUses).toHaveLength(2);

  // Drop image use from B (subsetting)
  const removeB = await invokeOffline(["composition", "remove", "compB", "bg", "--project", projA, "--json"]);
  expect(removeB.code).toBe(0);

  // Add B-owned text layer
  const addBadgeB = await invokeOffline([
    "composition",
    "add",
    "compB",
    "badge",
    "--text",
    "Interleaved Badge",
    "--font",
    "Montserrat",
    "--font-size",
    "32",
    "--color",
    "#ffcc00",
    "--x",
    "50",
    "--y",
    "200",
    "--project",
    projA,
    "--json",
  ]);
  expect(addBadgeB.code).toBe(0);

  // Interleave uses in B: badge painted before title
  const reorderB = await invokeOffline([
    "composition",
    "reorder",
    "compB",
    "--order",
    "badge,title",
    "--project",
    projA,
    "--json",
  ]);
  expect(reorderB.code).toBe(0);

  // -------------------------------------------------------------------------
  // Composition C: Transitive A -> B -> C import
  // -------------------------------------------------------------------------
  const createC = await invokeOffline([
    "composition",
    "create",
    "compC",
    "--width",
    "1280",
    "--height",
    "720",
    "--project",
    projA,
    "--json",
  ]);
  expect(createC.code).toBe(0);

  const importC = await invokeOffline(["composition", "import", "compC", "compB", "--project", projA, "--json"]);
  expect(importC.code).toBe(0);
  expect(JSON.parse(importC.stdout).importedUses).toHaveLength(2);

  // -------------------------------------------------------------------------
  // Blast-radius guard: Ambiguous edit without --in-place on 3 referrers fails closed
  // -------------------------------------------------------------------------
  const ambiguousEdit = await invokeOffline([
    "layer",
    "edit",
    textLayerId,
    "--text",
    "Ambiguous Title Update",
    "--project",
    projA,
    "--json",
  ]);
  expect(ambiguousEdit.code).toBe(1);
  const ambJson = JSON.parse(ambiguousEdit.stdout);
  expect(ambJson.ok).toBe(false);
  expect(ambJson.referrersCount).toBe(3);
  expect(ambJson.referringCompositions).toEqual(expect.arrayContaining(["compA", "compB", "compC"]));

  // -------------------------------------------------------------------------
  // In-place edit propagation: advances shared Layer revision
  // -------------------------------------------------------------------------
  // Pre-edit render of B: the baseline the propagation must visibly change.
  const renderBBefore = await invokeOffline(["composition", "render", "compB", "--project", projA, "--json"]);
  expect(renderBBefore.code).toBe(0);
  const pngBBeforeBytes = await readFile(JSON.parse(renderBBefore.stdout).render.output);
  const decodedBBefore = decodePng(pngBBeforeBytes);

  const inPlaceEdit = await invokeOffline([
    "layer",
    "edit",
    textLayerId,
    "--in-place",
    "--text",
    "Shared Propagated Title",
    "--project",
    projA,
    "--json",
  ]);
  expect(inPlaceEdit.code).toBe(0);
  expect(JSON.parse(inPlaceEdit.stdout).ok).toBe(true);

  // Render B: reflects updated text
  const renderB = await invokeOffline(["composition", "render", "compB", "--project", projA, "--json"]);
  expect(renderB.code).toBe(0);
  const pngBBytes = await readFile(JSON.parse(renderB.stdout).render.output);
  await writeFile(path.join(outEvidenceDir, "compB_propagated.png"), pngBBytes);

  // In-place propagation is visible in-suite: same canvas, changed pixels.
  expect(readPngHeader(pngBBytes)).toMatchObject({ width: 1280, height: 720 });
  const decodedBAfter = decodePng(pngBBytes);
  expect(decodedBAfter.rgba.equals(decodedBBefore.rgba)).toBe(false);

  // -------------------------------------------------------------------------
  // Isolated fork: changes only Composition C
  // -------------------------------------------------------------------------
  const forkEdit = await invokeOffline([
    "layer",
    "edit",
    textLayerId,
    "--fork",
    "--composition",
    "compC",
    "--use",
    "title",
    "--text",
    "Forked Title in C",
    "--color",
    "#ff0000",
    "--project",
    projA,
    "--json",
  ]);
  expect(forkEdit.code).toBe(0);
  const forkedLayerId = JSON.parse(forkEdit.stdout).layer.id as string;
  expect(forkedLayerId).not.toBe(textLayerId);

  // Render C: reflects forked red text
  const renderC = await invokeOffline(["composition", "render", "compC", "--project", projA, "--json"]);
  expect(renderC.code).toBe(0);
  const pngCBytes = await readFile(JSON.parse(renderC.stdout).render.output);
  await writeFile(path.join(outEvidenceDir, "compC_forked.png"), pngCBytes);

  // Fork is visible in-suite: C keeps the canvas but paints the forked red
  // title pixels B (still sharing the white original) does not have.
  expect(readPngHeader(pngCBytes)).toMatchObject({ width: 1280, height: 720 });
  const decodedC = decodePng(pngCBytes);
  expect(hasPixel(decodedC, isRedPixel)).toBe(true);
  expect(pngCBytes.equals(pngBBytes)).toBe(false);

  // Re-render B: unchanged across C's fork
  const reRenderB = await invokeOffline(["composition", "render", "compB", "--project", projA, "--json"]);
  expect(reRenderB.code).toBe(0);
  const rePngBBytes = await readFile(JSON.parse(reRenderB.stdout).render.output);
  expect(rePngBBytes.equals(pngBBytes)).toBe(true);

  // -------------------------------------------------------------------------
  // Historical replay of Composition A from manifest M_A: byte-identical to initial P_A
  // -------------------------------------------------------------------------
  const replayedAPath = path.join(outEvidenceDir, "compA_replayed.png");
  const replayA = await invokeOffline([
    "composition",
    "replay",
    manifestAPath,
    "--out",
    replayedAPath,
    "--project",
    projA,
    "--json",
  ]);
  expect(replayA.code).toBe(0);
  const replayedABytes = await readFile(replayedAPath);
  expect(replayedABytes.equals(pngABytes)).toBe(true);
}, LONG);

// ---------------------------------------------------------------------------
// 3. Cross-Project copy, complete source deletion, relocation & offline usability
// ---------------------------------------------------------------------------

test.skipIf(process.platform !== "darwin")("cross-Project copy, complete source/input deletion, Project relocation, and offline usability", async () => {
  // Source Project (projSrc)
  const projSrc = path.join(tempDir, "projSrc");
  const initSrc = await invokeOffline(["project", "init", projSrc, "--name", "Source Proj", "--json"]);
  expect(initSrc.code).toBe(0);

  const imgSource = path.join(tempDir, "src_hero.png");
  await writeFile(imgSource, solidPng(48, 48, BLUE));

  const createHero = await invokeOffline([
    "composition",
    "create",
    "heroComp",
    "--width",
    "800",
    "--height",
    "600",
    "--project",
    projSrc,
    "--json",
  ]);
  expect(createHero.code).toBe(0);
  const addHeroImg = await invokeOffline([
    "composition",
    "add",
    "heroComp",
    "heroImg",
    "--image",
    imgSource,
    "--x",
    "10",
    "--y",
    "10",
    "--project",
    projSrc,
    "--json",
  ]);
  expect(addHeroImg.code).toBe(0);
  const addHeroText = await invokeOffline([
    "composition",
    "add",
    "heroComp",
    "heroText",
    "--text",
    "Source Hero Text",
    "--font",
    "Source Sans 3",
    "--font-size",
    "40",
    "--color",
    "#00ffcc",
    "--x",
    "10",
    "--y",
    "100",
    "--project",
    projSrc,
    "--json",
  ]);
  expect(addHeroText.code).toBe(0);

  // Destination Project (projDest)
  const projDest = path.join(tempDir, "projDest");
  const initDest = await invokeOffline(["project", "init", projDest, "--name", "Destination Proj", "--json"]);
  expect(initDest.code).toBe(0);
  const createTarget = await invokeOffline([
    "composition",
    "create",
    "targetComp",
    "--width",
    "800",
    "--height",
    "600",
    "--project",
    projDest,
    "--json",
  ]);
  expect(createTarget.code).toBe(0);

  // Cross-project import: copies Layers as independent identities with retained font & image bytes
  const crossImport = await invokeOffline([
    "composition",
    "import",
    "targetComp",
    "heroComp",
    "--from-project",
    projSrc,
    "--project",
    projDest,
    "--json",
  ]);
  expect(crossImport.code).toBe(0);
  expect(JSON.parse(crossImport.stdout).importedUses).toHaveLength(2);

  // Initial render in destination Project and capture manifest
  const renderDest = await invokeOffline([
    "composition",
    "render",
    "targetComp",
    "--project",
    projDest,
    "--json",
  ]);
  expect(renderDest.code).toBe(0);
  const destRenderJson = JSON.parse(renderDest.stdout);
  const destManifestPathRel = path.relative(projDest, destRenderJson.render.manifest);
  const destPngBytes = await readFile(destRenderJson.render.output);
  expect(destPngBytes.length).toBeGreaterThan(0);
  await writeFile(path.join(outEvidenceDir, "dest_initial.png"), destPngBytes);

  // Dimension + pixel evidence: the copied image Layer is visibly painted.
  expect(readPngHeader(destPngBytes)).toMatchObject({ width: 800, height: 600 });
  expect(hasPixel(decodePng(destPngBytes), isBluePixel)).toBe(true);

  // -------------------------------------------------------------------------
  // Complete source deletion: remove original external inputs and delete projSrc completely
  // -------------------------------------------------------------------------
  await rm(imgSource, { force: true });
  await rm(projSrc, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  // Relocate destination project directory to new location
  // -------------------------------------------------------------------------
  const projRelocated = path.join(tempDir, "projRelocated");
  await rename(projDest, projRelocated);

  // -------------------------------------------------------------------------
  // Demonstrate full continued lifecycle in relocated Project offline
  // -------------------------------------------------------------------------
  // 1. Inspect relocated project
  const inspectRelocated = await invokeOffline(["project", "inspect", "--project", projRelocated, "--json"]);
  expect(inspectRelocated.code).toBe(0);
  expect(JSON.parse(inspectRelocated.stdout).project.name).toBe("Destination Proj");

  // 2. Inspect composition and list compositions
  const inspectComp = await invokeOffline(["composition", "inspect", "targetComp", "--project", projRelocated, "--json"]);
  expect(inspectComp.code).toBe(0);
  const destCompLayers = JSON.parse(inspectComp.stdout).composition.layers;
  expect(destCompLayers).toHaveLength(2);

  const listComps = await invokeOffline(["composition", "list", "--project", projRelocated, "--json"]);
  expect(listComps.code).toBe(0);
  expect(JSON.parse(listComps.stdout).compositions).toHaveLength(1);

  // 3. Inspect and edit layers using retained font bytes (no assets/fonts re-resolution)
  const listLayersRel = await invokeOffline(["layer", "list", "--project", projRelocated, "--json"]);
  expect(listLayersRel.code).toBe(0);
  const destTextLayerId = destCompLayers.find((l: { name: string }) => l.name === "heroText").layerId as string;

  const inspectTextRel = await invokeOffline(["layer", "inspect", destTextLayerId, "--project", projRelocated, "--json"]);
  expect(inspectTextRel.code).toBe(0);

  // In-place edit of text using retained font bytes
  const editInPlaceRel = await invokeOffline([
    "layer",
    "edit",
    destTextLayerId,
    "--in-place",
    "--text",
    "Relocated Edited Text",
    "--project",
    projRelocated,
    "--json",
  ]);
  expect(editInPlaceRel.code).toBe(0);

  // Fork edit of text layer
  const editForkRel = await invokeOffline([
    "layer",
    "edit",
    destTextLayerId,
    "--fork",
    "--composition",
    "targetComp",
    "--use",
    "heroText",
    "--text",
    "Relocated Forked Text",
    "--color",
    "#ffff00",
    "--project",
    projRelocated,
    "--json",
  ]);
  expect(editForkRel.code).toBe(0);

  // 4. Add a new local text layer using local registry
  const addTextRel = await invokeOffline([
    "composition",
    "add",
    "targetComp",
    "footer",
    "--text",
    "Relocated Footer",
    "--font",
    "Montserrat",
    "--font-size",
    "24",
    "--color",
    "#aaaaaa",
    "--x",
    "20",
    "--y",
    "500",
    "--project",
    projRelocated,
    "--json",
  ]);
  expect(addTextRel.code).toBe(0);

  // 5. Render current state in relocated project
  const renderRel = await invokeOffline([
    "composition",
    "render",
    "targetComp",
    "--project",
    projRelocated,
    "--json",
  ]);
  expect(renderRel.code).toBe(0);
  const relPngBytes = await readFile(JSON.parse(renderRel.stdout).render.output);
  expect(relPngBytes.length).toBeGreaterThan(0);
  await writeFile(path.join(outEvidenceDir, "dest_relocated_edited.png"), relPngBytes);

  // Relocation edits are visible in-suite: same canvas, changed pixels.
  expect(readPngHeader(relPngBytes)).toMatchObject({ width: 800, height: 600 });
  expect(relPngBytes.equals(destPngBytes)).toBe(false);

  // 6. Replay historical manifest captured before source deletion and relocation
  const relocatedManifestPath = path.join(projRelocated, destManifestPathRel);
  const replayedDestPath = path.join(outEvidenceDir, "dest_replayed.png");
  const replayDest = await invokeOffline([
    "composition",
    "replay",
    relocatedManifestPath,
    "--out",
    replayedDestPath,
    "--project",
    projRelocated,
    "--json",
  ]);
  expect(replayDest.code).toBe(0);
  const replayedDestBytes = await readFile(replayedDestPath);
  expect(replayedDestBytes.equals(destPngBytes)).toBe(true);
}, LONG);

// ---------------------------------------------------------------------------
// 4. Introduced CLI commands and help surface under network denial
// ---------------------------------------------------------------------------

test.skipIf(process.platform !== "darwin")("every introduced CLI module and help surface operates cleanly under process-level network denial", async () => {
  const topHelp = await invokeOffline(["--help"]);
  expect(topHelp.code).toBe(0);
  expect(topHelp.stdout).toContain("Ply — the local image composer");

  for (const mod of ["project", "composition", "layer"] as const) {
    const modHelp = await invokeOffline([mod, "--help"]);
    expect(modHelp.code).toBe(0);
    expect(modHelp.stdout).toContain(mod);
  }

  // Preserved legacy modules
  for (const legacyMod of ["scene", "library", "jobs"] as const) {
    const legacyHelp = await invokeOffline([legacyMod, "--help"]);
    expect(legacyHelp.stdout).toContain(legacyMod);
  }
});
