/**
 * Integrated qualification: the connected editing workflow, offline after
 * external-source deletion and Project relocation (#145, spec #132, US-006,
 * DEC-001/002/004/005, TEST-001/003/004). Qualifies the interaction of the
 * capabilities delivered by #133–#144 — combined outcomes only; the
 * operation × Layer-kind matrix is audited against predecessor evidence in
 * test/connected-editing-matrix-audit.test.ts.
 *
 * 1. Kernel network denial negative control (the #111/#88 helpers, verbatim):
 *    a local listener is reachable outside the sandbox and denied inside
 *    sandbox-exec '(deny network*)', inherited by CLI child processes.
 * 2. The connected Luigi reconstruction (TEST-004), all CLI under denial:
 *    - Phase A (in-process, no network/weights): the committed example
 *      Project's RETAINED evidence (examples/thumbnail-luigi-go) is
 *      published to external out/generation + out/matting records — job and
 *      matte records, output bytes materialized from the content store by
 *      recorded sha-256. The example Project must stay byte-identical.
 *    - Phase B: a fresh Project rebuilds the example — background from its
 *      Generation Job, hero from the ORIGINAL RETAINED matte `luigi-jump`
 *      (derived generation predecessor retained), headline as a local text
 *      Layer. The trial's external workarounds happen in-tool:
 *      `--resize-to 450x` (F1's sips retired), `--anchor center,top` (F3's
 *      render-look-adjust loop retired), the requested drop shadow (F2).
 *      Pixels are asserted numerically against the retained matte's own
 *      alpha and glyph ink; actual PNGs are retained under out/issue-145/.
 *      A non-thumbnail Composition (1600×900) shares the Layers, refuses an
 *      ambiguous edit, propagates in-place, and forks both Layer kinds.
 *    - Phase C: retained provenance byte-compared to the published records,
 *      every external source deleted, the Project relocated, and
 *      measurement/edit/render/review continue under denial.
 * 3. Replay after later edits (TEST-003): the pre-deletion pinned manifests
 *    replay byte-identically in the recorded environment AFTER the Phase C
 *    edits — exit 0 plus byte equality; an environment refusal cannot pass.
 *    The distinguishing control: a real generation attempt under denial
 *    fails at the denied socket layer and publishes nothing.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { closeBrowser } from "../src/browser.js";
import { readPngHeader, decodePng } from "../src/png.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const exampleProject = path.resolve(import.meta.dir, "../examples/thumbnail-luigi-go");
const outEvidenceDir = path.resolve(import.meta.dir, "../out/issue-145");
// The committed example's recorded content identities (its retained matte
// output, generated background, and banner text document).
const BG_HASH = "26f14e9fe3cf9a9941a9494f2d6d6fe7d96e3e55574dda144ae49884f7869fc6";
const LUIGI_HASH = "328c9f6fdf0e57bd866e1c7bbba9ba957b86ea4f3445a2717af28385024287df";
const BANNER_HASH = "3de40176cd8f890e6c8895028335f54b23272d91304e461d7dbd6bc6ff997bab";
const LUIGI_SOURCE_HASH = "69ad419d2b21b924e5040e115f37945f608b94bfdab084623bfa751a62a3650b";
const BG_JOB = "gen-20260910-5a5ce6fd";
const HERO_JOB = "gen-20260910-2432e2ef";
const MATTE_ID = "luigi-jump";
const MATTE_ENGINE = "local-segmentation:birefnet-hr-fp16.onnx";
const RESIZE_450 = 450 / 1024; // exact binary fraction: 0.439453125

// Denial helpers (verbatim from the #111 qualification).
const offlineCommand = (args: string[]): string[] =>
  ["sandbox-exec", "-p", "(version 1) (allow default) (deny network*)", process.execPath, cli, ...args];

async function invokeOffline(args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(offlineCommand(args), { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...extraEnv } });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

const darwinOnly = test.skipIf(process.platform !== "darwin");
const LONG = 300_000;
const json = (r: { stdout: string }) => JSON.parse(r.stdout);
const ok = async (args: string[], cwd: string, env?: Record<string, string>) => {
  const r = await invokeOffline(args, cwd, env ?? {});
  expect(r.code).toBe(0);
  return json(r);
};

const pixel = (png: ReturnType<typeof decodePng>, x: number, y: number): Rgba => {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
};
type Rgba = [number, number, number, number];

/** Tight bbox of strongly opaque orange glyph ink (#FF8C00-ish) in a window. */
function orangeBBox(png: ReturnType<typeof decodePng>, x0: number, x1: number, y0: number, y1: number) {
  let minX = x1, maxX = x0, minY = y1, maxY = y0, count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const [r, g, b, a] = pixel(png, x, y);
      if (a > 200 && r > 200 && g > 90 && g < 190 && b < 90) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY, count };
}

/** Per-channel mean color of a rectangle (robust to resampling smoothing). */
function meanColor(png: ReturnType<typeof decodePng>, x0: number, y0: number, w: number, h: number): [number, number, number] {
  let r = 0, g = 0, b = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const p = pixel(png, x, y);
      r += p[0]!; g += p[1]!; b += p[2]!;
    }
  }
  const n = w * h;
  return [r / n, g / n, b / n];
}

const meanLuma = (png: ReturnType<typeof decodePng>, x: number, y: number, w: number, h: number) => {
  const [r, g, b] = meanColor(png, x, y, w, h);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Opaque-ink bbox of a decoded true-alpha PNG. */
function opaqueBBox(png: ReturnType<typeof decodePng>) {
  let minX = png.width, maxX = -1, minY = png.height, maxY = -1;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (png.rgba[(y * png.width + x) * 4 + 3]! > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY };
}

/** Byte map of every file under a root (untouched/relocation proof). */
async function snapshotDir(root: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  async function walk(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.set(path.relative(root, full), await readFile(full));
    }
  }
  await walk(root);
  return out;
}

/** A Layer's identity document plus every retained revision document. */
async function snapshotLayer(proj: string, layerId: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  out.set(`${layerId}.json`, await readFile(path.join(proj, "layers", `${layerId}.json`)));
  const revDir = path.join(proj, "layers", `${layerId}.revisions`);
  for (const entry of (await readdir(revDir)).sort()) out.set(`${layerId}.revisions/${entry}`, await readFile(path.join(revDir, entry)));
  return out;
}

function assertMapUnchanged(before: Map<string, Buffer>, after: Map<string, Buffer>, what: string) {
  expect(after.size).toBe(before.size);
  for (const [rel, bytes] of before) expect(after.get(rel)?.equals(bytes), `${what}: ${rel} must stay byte-identical`).toBe(true);
}

const closeTo = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-editing-qual-"));
  await mkdir(outEvidenceDir, { recursive: true });
});

afterEach(async () => {
  await closeBrowser();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Negative control (same isolation as the #111/#88 qualifications)
// ---------------------------------------------------------------------------

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
        s.close();
        reject(new Error("Failed to obtain server address"));
      }
    });
  });
  try {
    const targetUrl = `http://127.0.0.1:${port}/probe`;
    expect((await fetch(targetUrl)).status).toBe(200);
    const probe = Bun.spawn(
      ["sandbox-exec", "-p", "(version 1) (allow default) (deny network*)", process.execPath, "-e",
        `fetch("${targetUrl}").then(() => process.exit(0)).catch(() => process.exit(42))`],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await probe.exited).toBe(42);
  } finally {
    if (server) await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// 2. The connected lifecycle (TEST-004 + TEST-003)
// ---------------------------------------------------------------------------

darwinOnly(
  "connected editing workflow: Luigi rebuilt from the retained matte with in-tool resize, centered headline, and shadow; poster shares and forks; then deletion, relocation, offline edits, and byte-identical replay",
  async () => {
    const root = tempDir;
    const proj = path.join(root, "proj");
    const P = ["--project", proj, "--json"] as const;

    // Phase A — publish the retained evidence as external records
    // (in-process; no network, no inference, no weights).
    const exampleBefore = await snapshotDir(exampleProject);
    const outGen = path.join(root, "out", "generation");
    const outMatte = path.join(root, "out", "matting");
    for (const jobId of [BG_JOB, HERO_JOB]) {
      await mkdir(path.join(outGen, jobId), { recursive: true });
      await copyFile(path.join(exampleProject, "generation", jobId, "job.json"), path.join(outGen, jobId, "job.json"));
    }
    await mkdir(path.join(outGen, BG_JOB, "outputs"), { recursive: true });
    await copyFile(path.join(exampleProject, "content", BG_HASH), path.join(outGen, BG_JOB, "outputs", `${BG_HASH}.png`));
    await mkdir(path.join(outMatte, MATTE_ID, "outputs"), { recursive: true });
    await copyFile(path.join(exampleProject, "matting", MATTE_ID, "matte.json"), path.join(outMatte, MATTE_ID, "matte.json"));
    await copyFile(path.join(exampleProject, "content", LUIGI_HASH), path.join(outMatte, MATTE_ID, "outputs", `${LUIGI_HASH}.png`));

    // Phase B — rebuild via the public CLI, entirely under kernel denial.
    expect((await ok(["project", "init", proj, "--name", "LuigiRebuilt", "--json"], root)).ok).toBe(true);
    await ok(["composition", "create", "thumb", "--width", "1280", "--height", "720", ...P], root);

    // The background from its retained Generation Job provenance.
    const addBg = await ok(["composition", "add", "thumb", "bg", "--from-generation", BG_JOB, "--output", "1", ...P], root);
    expect(addBg.generatedFrom).toEqual({ jobId: BG_JOB, contentHash: BG_HASH });
    const bgLayerId = addBg.use.layerId as string;

    // The hero from the ORIGINAL RETAINED matte — no live inference, no
    // external resampling; the derived generation predecessor is retained.
    // (--y=-22: the documented single-token form for a negative coordinate.)
    const addLuigi = await ok(
      ["composition", "add", "thumb", "luigi", "--from-matte", MATTE_ID, "--x", "70", "--y=-22", ...P], root);
    expect(addLuigi.mattedFrom).toEqual({ matteId: MATTE_ID, engine: MATTE_ENGINE, contentHash: LUIGI_HASH });
    // generatedFrom's contentHash is the Layer's new content identity — the
    // matte output bytes this revision pins (the #111 documented contract).
    expect(addLuigi.generatedFrom).toEqual({ jobId: HERO_JOB, contentHash: LUIGI_HASH });
    const luigiLayerId = addLuigi.use.layerId as string;

    // The headline: the same text/font/size/color must pin the content
    // identity the committed example retained (retained font bytes included).
    const addBanner = await ok(
      ["composition", "add", "thumb", "banner", "--text", "LUIGI GO", "--font", "Anton", "--font-size", "110",
        "--color", "#FF8C00", "--x", "470", "--y", "36", ...P], root);
    const bannerLayerId = addBanner.use.layerId as string;
    expect(addBanner.layer.currentRevision.contentHash).toBe(BANNER_HASH);

    // F1 in-tool: resize the 1024px retained matte output to the trial's
    // 450px effective size. Placement changes; retained bytes never do.
    const resized = await ok(["layer", "edit", luigiLayerId, "--resize-to", "450x", ...P], root);
    expect(resized.layer.currentRevision.contentHash).toBe(LUIGI_HASH);
    expect(resized.layer.currentRevision.scaleX).toBe(RESIZE_450);
    expect(resized.layer.currentRevision.scaleY).toBe(RESIZE_450);

    // F3 in-tool: glyph ink centered at x=640 without a render-look loop.
    const anchored = await ok(["layer", "edit", bannerLayerId, "--anchor", "center,top", "--x", "640", "--y", "36", ...P], root);
    expect(anchored.anchored.target).toEqual({ x: 640, y: 36 });
    expect(anchored.anchored.contexts).toContain("thumb");

    // Pre-shadow render: the trial's dropped shadow is not there yet.
    const pngT0 = await readFile((await ok(["composition", "render", "thumb", ...P], root)).render.output as string);
    expect(readPngHeader(pngT0)).toMatchObject({ width: 1280, height: 720 });
    const decodedT0 = decodePng(pngT0);

    // F2 in-tool: the requested drop shadow, as an absolute effect fact.
    const shadowed = await ok(["layer", "edit", bannerLayerId, "--shadow", "0,6,10,#00000080", ...P], root);
    expect(shadowed.layer.currentRevision.shadow).toEqual({ dx: 0, dy: 6, blur: 10, color: "#00000080" });
    expect(shadowed.layer.currentRevision.contentHash).toBe(BANNER_HASH);

    const renderT1 = await ok(["composition", "render", "thumb", ...P], root);
    const manifestT1 = renderT1.render.manifest as string;
    const pngT1 = await readFile(renderT1.render.output as string);
    const decodedT1 = decodePng(pngT1);
    await writeFile(path.join(outEvidenceDir, "thumb_rebuilt.png"), pngT1);

    // Pixel evidence, headline: tight orange glyph ink centered on 640.
    const ink0 = orangeBBox(decodedT0, 430, 900, 0, 250);
    expect(ink0.count).toBeGreaterThan(5000);
    expect(closeTo((ink0.minX + ink0.maxX) / 2, 640, 2)).toBe(true);
    const ink1 = orangeBBox(decodedT1, 430, 900, 0, 250);
    expect(closeTo((ink1.minX + ink1.maxX) / 2, 640, 2)).toBe(true);
    // The glyphs are unchanged by the shadow; the band below them darkens.
    expect(Math.abs(ink1.count - ink0.count) / ink0.count).toBeLessThan(0.02);
    const bandY = ink0.maxY + 4;
    expect(meanLuma(decodedT1, ink0.minX, bandY, ink0.maxX - ink0.minX, 26)).toBeLessThan(
      meanLuma(decodedT0, ink0.minX, bandY, ink0.maxX - ink0.minX, 26),
    );

    // Pixel evidence, hero: the rendered Luigi pixels are the retained
    // matte's own pixels, mapped through the in-tool scale.
    const retainedBlob = path.join(proj, "content", LUIGI_HASH);
    expect((await readFile(retainedBlob)).equals(await readFile(path.join(exampleProject, "content", LUIGI_HASH)))).toBe(true);
    const mattePng = decodePng(await readFile(retainedBlob));
    const patch = { x: 482, y: 188, size: 43 }; // smooth opaque cap/shirt green
    const srcMean = meanColor(mattePng, patch.x, patch.y, patch.size, patch.size);
    const rcx = Math.round(70 + (patch.x + patch.size / 2) * RESIZE_450);
    const rcy = Math.round(-22 + (patch.y + patch.size / 2) * RESIZE_450);
    const renderedPatch = meanColor(decodedT1, rcx - 9, rcy - 9, 19, 19);
    for (let i = 0; i < 3; i++) expect(Math.abs(renderedPatch[i]! - srcMean[i]!)).toBeLessThan(8);

    // Measurement evidence: the matte's opaque-ink bbox predicts painted
    // extents; layout ≠ painted (the layout box rises above the canvas).
    const bbox = opaqueBBox(mattePng);
    const s = RESIZE_450;
    const luigiGeom = (await ok(["composition", "measure", "thumb", "luigi", ...P], root)).layers[0];
    expect(luigiGeom.box).toEqual({ x: 70, y: -22, width: 450, height: 450 });
    // Painted ink is quantized to the capture pixel grid: compare within 1px.
    const predicted = {
      x: 70 + bbox.minX * s,
      y: -22 + bbox.minY * s,
      width: (bbox.maxX - bbox.minX + 1) * s,
      height: (bbox.maxY - bbox.minY + 1) * s,
    };
    for (const k of ["x", "y", "width", "height"] as const) {
      expect(closeTo(luigiGeom.painted[k], predicted[k], 1.5)).toBe(true);
    }
    expect(luigiGeom.box.y).toBeLessThan(0);
    expect(luigiGeom.paintedOnCanvas).toEqual(luigiGeom.painted);
    expect(luigiGeom.clipped).toBe(false);

    // Non-thumbnail Composition: shared identities, refusal, propagation,
    // forked variation — both Layer kinds.
    await ok(["composition", "create", "poster", "--width", "1600", "--height", "900", ...P], root);
    const imported = await ok(["composition", "import", "poster", "thumb", ...P], root);
    expect(imported.importedUses).toHaveLength(3);

    const renderP1 = await ok(["composition", "render", "poster", ...P], root);
    const manifestP1 = renderP1.render.manifest as string;
    const pngP1 = await readFile(renderP1.render.output as string);
    expect(readPngHeader(pngP1)).toMatchObject({ width: 1600, height: 900 });
    const posterInk = orangeBBox(decodePng(pngP1), 430, 900, 0, 250);
    expect(closeTo((posterInk.minX + posterInk.maxX) / 2, 640, 2)).toBe(true);
    // The shared fact is 1280×720: the poster's extra canvas stays transparent.
    expect(decodePng(pngP1).rgba[(899 * 1600 + 1590) * 4 + 3]).toBe(0);
    await writeFile(path.join(outEvidenceDir, "poster_initial.png"), pngP1);

    const snapBg = await snapshotLayer(proj, bgLayerId);
    const snapBanner = await snapshotLayer(proj, bannerLayerId);

    // Ambiguous edit refusal: luigi is shared by thumb and poster.
    const ambiguous = await invokeOffline(["layer", "edit", luigiLayerId, "--opacity", "0.9", ...P], root);
    expect(ambiguous.code).toBe(1);
    expect(json(ambiguous).ok).toBe(false);
    expect(json(ambiguous).referrersCount).toBe(2);
    expect(json(ambiguous).referringCompositions).toEqual(expect.arrayContaining(["thumb", "poster"]));

    // Explicit propagation: the rotated hero reaches both Compositions.
    const rotated = await ok(["layer", "edit", luigiLayerId, "--in-place", "--rotate", "-8", ...P], root);
    expect(rotated.layer.currentRevision.rotationDeg).toBe(-8);
    expect(rotated.layer.currentRevision.contentHash).toBe(LUIGI_HASH);
    const pngT2 = await readFile((await ok(["composition", "render", "thumb", ...P], root)).render.output as string);
    expect(pngT2.equals(pngT1)).toBe(false);
    const pngP2 = await readFile((await ok(["composition", "render", "poster", ...P], root)).render.output as string);
    expect(pngP2.equals(pngP1)).toBe(false);
    await writeFile(path.join(outEvidenceDir, "thumb_propagated.png"), pngT2);

    // Forked variation 1 (image kind): a poster-sized background identity.
    const forkBg = await ok(
      ["layer", "edit", bgLayerId, "--fork", "--composition", "poster", "--use", "bg", "--resize-to", "1600x900", ...P], root);
    const bgForkId = forkBg.layer.id as string;
    expect(bgForkId).not.toBe(bgLayerId);
    expect(forkBg.layer.currentRevision.scaleX).toBe(1.25);
    assertMapUnchanged(snapBg, await snapshotLayer(proj, bgLayerId), "original bg through its fork");

    // Forked variation 2 (text kind): the poster's headline gains an outline.
    const forkBanner = await ok(
      ["layer", "edit", bannerLayerId, "--fork", "--composition", "poster", "--use", "banner", "--outline", "3,#101014", ...P], root);
    const bannerForkId = forkBanner.layer.id as string;
    expect(bannerForkId).not.toBe(bannerLayerId);
    expect(forkBanner.layer.currentRevision.outline).toEqual({ width: 3, color: "#101014" });
    assertMapUnchanged(snapBanner, await snapshotLayer(proj, bannerLayerId), "original banner through its fork");

    const pngP3 = await readFile((await ok(["composition", "render", "poster", ...P], root)).render.output as string);
    expect(pngP3.equals(pngP2)).toBe(false);
    // The forks leave thumb byte-identical.
    const pngT3 = await readFile((await ok(["composition", "render", "thumb", ...P], root)).render.output as string);
    expect(pngT3.equals(pngT2)).toBe(true);
    await writeFile(path.join(outEvidenceDir, "poster_variation.png"), pngP3);

    // Retained provenance is offline-readable through the public CLI.
    expect((await ok(["generate", "show", BG_JOB, "--json"], root)).job.jobId).toBe(BG_JOB);
    const heroShow = await ok(["generate", "show", HERO_JOB, "--json"], root);
    expect(heroShow.job.run.outputs[0].contentHash).toBe(LUIGI_SOURCE_HASH);
    // The hero Job's PRE-MATTE output bytes were never part of the retained
    // record set (only the matte output survived in the example Project), so
    // its review honestly fails closed instead of substituting bytes.
    const heroReview = await invokeOffline(["generate", "review", HERO_JOB, "--json"], root);
    expect(heroReview.code).toBe(1);
    expect(json(heroReview).error).toMatch(/missing|incomplete/i);
    const reviewsDir = path.join(root, "reviews");
    await mkdir(reviewsDir, { recursive: true });
    const luigiReview = await ok(
      ["layer", "review", luigiLayerId, "--out", path.join(reviewsDir, "luigi.html"), ...P], root);
    expect(luigiReview.matting.matteId).toBe(MATTE_ID);
    expect(luigiReview.matting.engine).toBe(MATTE_ENGINE);
    expect(luigiReview.matting.alpha).toEqual({ width: 1024, height: 1024, transparentPx: 865229, opaquePx: 163376 });

    // Phase C — retained provenance is byte-identical to the published
    // records; then delete every external source and relocate.
    for (const jobId of [BG_JOB, HERO_JOB]) {
      expect((await readFile(path.join(proj, "generation", jobId, "job.json"))).equals(
        await readFile(path.join(outGen, jobId, "job.json")),
      )).toBe(true);
    }
    expect((await readFile(path.join(proj, "matting", MATTE_ID, "matte.json"))).equals(
      await readFile(path.join(outMatte, MATTE_ID, "matte.json")),
    )).toBe(true);
    await rm(path.join(root, "out"), { recursive: true, force: true });
    const proj2 = path.join(root, "proj-relocated");
    await rename(proj, proj2);
    const P2 = ["--project", proj2, "--json"] as const;

    // Offline inspection under denial.
    expect((await ok(["project", "inspect", ...P2], root)).project.name).toBe("LuigiRebuilt");
    expect((await ok(["composition", "list", ...P2], root)).compositions).toHaveLength(2);
    const posterLayers = (await ok(["composition", "inspect", "poster", ...P2], root)).composition.layers;
    expect(posterLayers.map((l: { name: string }) => l.name)).toEqual(["bg", "luigi", "banner"]);
    expect(posterLayers[2].layerId).toBe(bannerForkId);
    expect((await ok(["layer", "list", ...P2], root)).layers).toHaveLength(5);

    // Offline measurement still resolves retained fonts and matte alpha.
    expect((await ok(["composition", "measure", "poster", "banner", ...P2], root)).layers[0].painted).not.toBeNull();

    // Later edits under denial: the shared hero grows 10% everywhere.
    const grown = await ok(["layer", "edit", luigiLayerId, "--in-place", "--resize", "1.1", ...P2], root);
    expect(Math.abs(grown.layer.currentRevision.scaleX - 495 / 1024)).toBeLessThan(1e-6);
    assertMapUnchanged(snapBg, await snapshotLayer(proj2, bgLayerId), "bg through Phase C");
    assertMapUnchanged(snapBanner, await snapshotLayer(proj2, bannerLayerId), "banner through Phase C");
    expect((await readFile(path.join(proj2, "content", LUIGI_HASH))).equals(
      await readFile(path.join(exampleProject, "content", LUIGI_HASH)),
    )).toBe(true);
    const pngT4 = await readFile((await ok(["composition", "render", "thumb", ...P2], root)).render.output as string);
    expect(pngT4.equals(pngT2)).toBe(false);
    await writeFile(path.join(outEvidenceDir, "thumb_relocated_edited.png"), pngT4);

    // Re-anchor the forked variation (single referrer) at the poster's center.
    const reAnchored = await ok(["layer", "edit", bannerForkId, "--anchor", "center,top", "--x", "800", "--y", "36", ...P2], root);
    expect(reAnchored.anchored.contexts).toEqual(["poster"]);
    const pngP4 = await readFile((await ok(["composition", "render", "poster", ...P2], root)).render.output as string);
    const forkInk = orangeBBox(decodePng(pngP4), 620, 1000, 0, 250);
    expect(closeTo((forkInk.minX + forkInk.maxX) / 2, 800, 2)).toBe(true);
    await writeFile(path.join(outEvidenceDir, "poster_reanchored.png"), pngP4);

    // TEST-003: the pinned combined-workflow outputs replay byte-identically
    // in the recorded environment AFTER the later edits. Exit 0 plus byte
    // equality; an environment refusal is never a successful replay.
    const rebased = (manifest: string) => path.join(proj2, path.relative(proj, manifest));
    const replayT = await invokeOffline(
      ["composition", "replay", rebased(manifestT1), "--out", path.join(outEvidenceDir, "thumb_replayed_after_edits.png"), ...P2], root);
    expect(replayT.code).toBe(0);
    expect((await readFile(path.join(outEvidenceDir, "thumb_replayed_after_edits.png"))).equals(pngT1)).toBe(true);
    const replayP = await invokeOffline(
      ["composition", "replay", rebased(manifestP1), "--out", path.join(outEvidenceDir, "poster_replayed_after_edits.png"), ...P2], root);
    expect(replayP.code).toBe(0);
    expect((await readFile(path.join(outEvidenceDir, "poster_replayed_after_edits.png"))).equals(pngP1)).toBe(true);

    // The published surface is honestly gone; retained records remain.
    expect((await ok(["generate", "list", "--json"], root)).jobs).toHaveLength(0);
    expect((await invokeOffline(["generate", "show", BG_JOB, "--json"], root)).code).toBe(1);
    const retainedGen = await readdir(path.join(proj2, "generation"));
    expect(retainedGen.filter((d) => !d.startsWith(".")).sort()).toEqual([BG_JOB, HERO_JOB].sort());
    expect(await readdir(path.join(proj2, "matting", MATTE_ID))).toContain("matte.json");

    // The committed example Project was never touched.
    assertMapUnchanged(exampleBefore, await snapshotDir(exampleProject), "committed example Project");

    // The distinguishing control: a real generation attempt under denial
    // fails at the denied socket layer and publishes nothing, while every
    // local command above succeeded under the same denial.
    const genAttempt = await invokeOffline(["generate", "offline denial control prompt", "--json"], root, {
      AI_GATEWAY_API_KEY: "dummy-key-for-denial-control",
    });
    expect(genAttempt.code).toBe(1);
    expect(json(genAttempt).ok).toBe(false);
    expect(json(genAttempt).error).toMatch(/ENOTFOUND|getaddrinfo|fetch failed|network/i);
    // Nothing was published: the attempted job store holds no record.
    expect(await readdir(path.join(root, "out", "generation")).catch(() => [])).toEqual([]);
  },
  LONG,
);
