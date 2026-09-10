/**
 * Integrated qualification: the connected generated/matted Layer workflow,
 * offline after source deletion and Project relocation (#111, spec #102,
 * US-003 / US-005, DEC-002/003, TEST-001/004/005).
 *
 * This suite qualifies the interaction between the independently delivered
 * capabilities (#104–#109) — it owns interactions only, not each
 * predecessor's command or retention contract:
 *
 * 1. Kernel network denial negative control: a local listener is reachable
 *    outside the sandbox and denied inside (sandbox-exec '(deny network*)'),
 *    inherited by CLI child processes. Darwin-only; off Darwin the suite
 *    skips rather than claiming weaker isolation is proof.
 * 2. TEST-004's connected workflow as one coherent lifecycle:
 *    - Phase A (injected-generation preparation, in-process, no network, no
 *      weights): a counting fake provider publishes a full-canvas background
 *      and a text-bearing panel (glyph-like marks painted into the
 *      deterministic pixels); an injected MatteEngine mattes an opaque local
 *      image. The provider and engine call counts are the injected-work
 *      baseline every later phase is checked against.
 *    - Phase B (network-denied local continuation, public CLI subprocess):
 *      ingest the outputs as ordinary Layers (--from-generation,
 *      --from-matte), render, reuse the Composition via same-Project import
 *      (shared identities), refuse an ambiguous edit, choose an explicit
 *      in-place propagation and an isolated fork, inspect provenance/evidence
 *      (generate show/list/review + layer review), and assert changed pixels
 *      where expected, byte-identical re-renders of unaffected Compositions,
 *      unchanged unrelated Layer storage, and no additional model calls.
 *    - Phase C (deletion, relocation, offline continuation): verify the
 *      retained provenance is byte-identical to the published records, delete
 *      every external input/output, relocate the Project, and continue
 *      inspection (including retained layer review), editing, rendering, and
 *      byte-identical historical replay — all under kernel network denial.
 * 3. Whole-introduced-local-surface coverage under denial: every introduced
 *    non-generation command/help surface, plus the distinguishing control —
 *    a real generation attempt under denial fails with nothing published
 *    while the local commands succeed (TEST-005).
 *
 * Per TEST-001, the provider and MatteEngine are injected at the existing
 * seams (no billed generation, no network, no real engine weights in this
 * suite; the live qualifications are #112/#113).
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { lstat, mkdtemp, rm, readFile, writeFile, mkdir, rename, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { closeBrowser } from "../src/browser.js";
import { encodePngRgba, readPngHeader, decodePng } from "../src/png.js";
import { runUniformGeneration, type UniformProvider } from "../src/generation.js";
import { runMatting } from "../src/matting.js";
import { composeMatte, type MatteEngine } from "../src/matte.js";
import { encodePng } from "./png.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const outEvidenceDir = path.resolve(import.meta.dir, "../out/issue-111");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgba[0]!;
    buf[i + 1] = rgba[1]!;
    buf[i + 2] = rgba[2]!;
    buf[i + 3] = rgba[3]!;
  }
  return encodePngRgba(width, height, buf);
}

const BG_GREEN: Rgba = [0, 180, 0, 255];
const SUBJECT_RED: Rgba = [200, 30, 40, 255];
const FORK_MAGENTA: Rgba = [220, 0, 220, 255];
const ALT_ORANGE: Rgba = [240, 150, 110, 255];
const PANEL_BLUE: Rgba = [30, 60, 220, 255];

type Rgba = [number, number, number, number];

/** A panel whose deterministic "generated" pixels carry text-like glyph bars. */
const PANEL_PNG = encodePng(64, 64, (x, y): Rgba =>
  y >= 8 && y < 20 && x % 10 < 6 ? [18, 18, 22, 255] : [PANEL_BLUE[0], PANEL_BLUE[1], PANEL_BLUE[2], 255],
);

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): Rgba {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

function hasPixel(png: ReturnType<typeof decodePng>, match: (p: Rgba) => boolean): boolean {
  for (let i = 0; i < png.rgba.length; i += 4) {
    if (match([png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!])) return true;
  }
  return false;
}

const closeTo = (a: number, b: number, tol = 3) => Math.abs(a - b) <= tol;
const isGreenPixel = (p: Rgba) => p[1]! > 150 && p[0]! < 60 && p[2]! < 60;
const isRedPixel = (p: Rgba) => p[0]! > 160 && p[1]! < 80 && p[2]! < 90;

/** Provider that hands out the given PNGs in order and counts every call. */
function countingProvider(images: Buffer[]): { provider: UniformProvider; calls: () => number } {
  let n = 0;
  const provider: UniformProvider = {
    image: async () => {
      n++;
      return { images: [{ base64: images[(n - 1) % images.length]!.toString("base64") }], warnings: [] };
    },
    text: async () => {
      throw new Error("TRIPWIRE: the multimodal seam is not part of this qualification");
    },
  };
  return { provider, calls: () => n };
}

/** Engine that mattes through a fixed mask and counts every call. */
function countingEngine(mask: Buffer): { engine: MatteEngine; calls: () => number } {
  let n = 0;
  const engine: MatteEngine = async ({ bytes, label }) => {
    n++;
    return { bytes: composeMatte(bytes, mask, label), engine: "test/segmenter" };
  };
  return { engine, calls: () => n };
}

/** Snapshot a Layer's identity document and every revision document. */
async function snapshotLayer(proj: string, layerId: string): Promise<Map<string, Buffer>> {
  const snap = new Map<string, Buffer>();
  const roots = [path.join(proj, "layers", `${layerId}.json`), path.join(proj, "layers", `${layerId}.revisions`)];
  for (const root of roots) {
    const stat = await lstat(root).catch(() => null);
    if (!stat) continue;
    if (stat.isFile()) {
      snap.set(path.relative(proj, root), await readFile(root));
    } else {
      for (const entry of (await readdir(root)).sort()) {
        const full = path.join(root, entry);
        snap.set(path.relative(proj, full), await readFile(full));
      }
    }
  }
  return snap;
}

/** Visible record ids in a provenance directory (ignores hidden entries). */
async function jobIds(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((d) => !d.startsWith(".")).sort();
  } catch {
    return [];
  }
}

function assertSnapshotUnchanged(before: Map<string, Buffer>, after: Map<string, Buffer>, what: string) {
  for (const [rel, bytes] of before) {
    const now = after.get(rel);
    expect(now).toBeDefined();
    expect(now!.equals(bytes), `${what}: ${rel} must stay byte-identical`).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// Kernel network denial (same isolation as the #88 foundation qualification)
// ---------------------------------------------------------------------------

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

async function invokeOffline(args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  const result = Bun.spawn(offlineCommand(args), {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
    result.exited,
  ]);
  return { stdout, stderr, code };
}

const darwinOnly = test.skipIf(process.platform !== "darwin");

/**
 * The integrated lifecycle spawns many renders and subprocesses; Bun's
 * default 5s per-test timeout is far below its real cost (the #88
 * predecessor's long test demonstrably hits that default on this machine).
 * The long phases get explicit generous timeouts; a genuine hang still
 * fails loudly at the timeout instead of being retried.
 */
const LONG = 240_000;

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-connected-qual-"));
  await mkdir(outEvidenceDir, { recursive: true });
});

afterEach(async () => {
  await closeBrowser();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. Negative control: reachable outside the sandbox, denied inside
// ---------------------------------------------------------------------------

darwinOnly(
  "network isolation negative control: local listener is reachable outside sandbox but denied inside",
  async () => {
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

      // 1. Unsandboxed request succeeds.
      const onlineRes = await fetch(targetUrl);
      expect(onlineRes.status).toBe(200);
      expect(await onlineRes.text()).toBe("online-ok");

      // 2. Sandboxed child fails at the OS socket layer.
      const probeProc = Bun.spawn(
        [
          "sandbox-exec",
          "-p",
          "(version 1) (allow default) (deny network*)",
          process.execPath,
          "-e",
          `fetch("${targetUrl}").then(() => process.exit(0)).catch(() => process.exit(42))`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const probeCode = await probeProc.exited;
      expect(probeCode).toBe(42);
    } finally {
      if (server) {
        await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
      }
    }
  },
);

// ---------------------------------------------------------------------------
// 2. TEST-004: the connected workflow, deletion, relocation, offline continuity
// ---------------------------------------------------------------------------

darwinOnly(
  "connected generated/matted workflow: compose, reuse, ambiguous-edit refusal, fork/propagation, then deletion, relocation, and byte-identical replay offline",
  async () => {
    const root = tempDir;
    const jobsRoot = path.join(root, "out", "generation");
    const matteRoot = path.join(root, "out", "matting");
    const proj = path.join(root, "proj");

    // -----------------------------------------------------------------------
    // Phase A — injected-generation preparation (in-process; no network, no
    // weights). Every later phase is checked against these call counts: the
    // counters pin the injected baseline; the subprocess-side proof that no
    // local continuation ever generated is kernel network denial (a model
    // call cannot succeed) plus the no-new-published/retained-record checks
    // below — not the counters themselves.
    // -----------------------------------------------------------------------
    const { provider, calls: providerCalls } = countingProvider([
      solidPng(64, 64, BG_GREEN),
      PANEL_PNG,
      solidPng(64, 64, ALT_ORANGE),
    ]);
    const bgJob = await runUniformGeneration(
      jobsRoot,
      "gen-111-bg",
      {
        prompt: "a calm green studio background",
        intent: "full-canvas",
        model: "gpt-image",
        sizing: { kind: "size", width: 64, height: 64 },
        count: 1,
      },
      { provider },
    );
    const panelJob = await runUniformGeneration(
      jobsRoot,
      "gen-111-panel",
      {
        prompt: "a bold title panel with text",
        intent: "full-canvas",
        model: "gpt-image",
        sizing: { kind: "size", width: 64, height: 64 },
        count: 1,
      },
      { provider },
    );
    // A third published output the edit-replacement contract consumes later
    // (an explicit --from-generation / --from-matte replacement never
    // generates again).
    const altJob = await runUniformGeneration(
      jobsRoot,
      "gen-111-alt",
      {
        prompt: "an alternate accent panel",
        intent: "full-canvas",
        model: "gpt-image",
        sizing: { kind: "size", width: 64, height: 64 },
        count: 1,
      },
      { provider },
    );
    expect(providerCalls()).toBe(3);
    expect(bgJob.jobId).toBe("gen-111-bg");
    expect(bgJob.run.outputs).toHaveLength(1);
    expect(panelJob.run.outputs).toHaveLength(1);
    expect(altJob.run.outputs).toHaveLength(1);

    // Independently matte an ordinary local image through the injected engine.
    const subjectSource = path.join(root, "subject.png");
    const subjectBytes = encodePng(
      16,
      16,
      (x, y): Rgba => (x >= 4 && x < 12 && y >= 4 && y < 12 ? SUBJECT_RED : [10, 20, 30, 255]),
      { colorType: 2 },
    );
    await writeFile(subjectSource, subjectBytes);
    const mask = encodePng(
      16,
      16,
      (x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? [255, 255, 255, 255] : [0, 0, 0, 255]),
      { colorType: 2 },
    );
    const { engine, calls: engineCalls } = countingEngine(mask);
    const matte = await runMatting(matteRoot, "matte-111-subject", subjectSource, { engine });
    expect(engineCalls()).toBe(1);
    expect(matte.result.engine).toBe("test/segmenter");

    // Matte evidence: the published output is a true-alpha PNG whose measured
    // alpha counts match the record, and the source bytes are untouched.
    const matteOutFile = path.join(matteRoot, matte.matteId, matte.result.outputs[0]!.file);
    const matteDecoded = decodePng(await readFile(matteOutFile));
    expect([matteDecoded.width, matteDecoded.height]).toEqual([16, 16]);
    let opaque = 0;
    let transparent = 0;
    for (let i = 3; i < matteDecoded.rgba.length; i += 4) {
      if (matteDecoded.rgba[i] === 0) transparent++;
      else if (matteDecoded.rgba[i] === 255) opaque++;
    }
    expect(transparent).toBeGreaterThan(0);
    expect(opaque).toBeGreaterThan(0);
    expect(matte.result.alpha).toEqual({ width: 16, height: 16, transparentPx: transparent, opaquePx: opaque });
    expect(hasPixel(matteDecoded, isRedPixel)).toBe(true);
    expect((await readFile(subjectSource)).equals(subjectBytes)).toBe(true);

    // A second matte whose source is the published alternate job's output —
    // matting a generated output independently, so the edit-replacement
    // below exercises the derived generation lineage retention (#108).
    const altOutputPath = path.join(jobsRoot, altJob.jobId, altJob.run.outputs[0]!.file);
    const altMatte = await runMatting(matteRoot, "matte-111-alt", altOutputPath, { engine });
    expect(engineCalls()).toBe(2);
    expect(altMatte.result.engine).toBe("test/segmenter");
    expect(altMatte.result.outputs[0]!.contentHash).toBeTruthy();

    // -----------------------------------------------------------------------
    // Phase B — network-denied local continuation through the public CLI.
    // -----------------------------------------------------------------------
    const init = await invokeOffline(["project", "init", proj, "--name", "Connected", "--json"], root);
    expect(init.code).toBe(0);
    expect(JSON.parse(init.stdout).ok).toBe(true);

    const create = await invokeOffline(
      ["composition", "create", "thumb", "--width", "128", "--height", "96", "--project", proj, "--json"],
      root,
    );
    expect(create.code).toBe(0);

    const addBg = await invokeOffline(
      ["composition", "add", "thumb", "bg", "--from-generation", "gen-111-bg", "--x", "0", "--y", "0", "--project", proj, "--json"],
      root,
    );
    expect(addBg.code).toBe(0);
    const addBgJson = JSON.parse(addBg.stdout);
    expect(addBgJson.ok).toBe(true);
    expect(addBgJson.generatedFrom).toEqual({ jobId: "gen-111-bg", contentHash: bgJob.run.outputs[0]!.contentHash });
    const bgLayerId = addBgJson.use.layerId as string;
    const bgContentHash = addBgJson.layer.currentRevision.contentHash as string;

    const addPanel = await invokeOffline(
      ["composition", "add", "thumb", "panel", "--from-generation", "gen-111-panel", "--x", "48", "--y", "8", "--project", proj, "--json"],
      root,
    );
    expect(addPanel.code).toBe(0);
    const panelLayerId = JSON.parse(addPanel.stdout).use.layerId as string;

    const addHero = await invokeOffline(
      ["composition", "add", "thumb", "hero", "--from-matte", "matte-111-subject", "--x", "72", "--y", "40", "--project", proj, "--json"],
      root,
    );
    expect(addHero.code).toBe(0);
    const addHeroJson = JSON.parse(addHero.stdout);
    expect(addHeroJson.ok).toBe(true);
    expect(addHeroJson.mattedFrom).toEqual({
      matteId: "matte-111-subject",
      engine: "test/segmenter",
      contentHash: matte.result.outputs[0]!.contentHash,
    });
    expect(addHeroJson.generatedFrom).toBeUndefined();
    const heroLayerId = addHeroJson.use.layerId as string;
    const heroContentHash = addHeroJson.layer.currentRevision.contentHash as string;

    // Ordinary Layers: every stored revision is a plain image revision.
    for (const id of [bgLayerId, panelLayerId, heroLayerId]) {
      const inspect = await invokeOffline(["layer", "inspect", id, "--project", proj, "--json"], root);
      expect(inspect.code).toBe(0);
      expect(JSON.parse(inspect.stdout).layer.currentRevision.kind).toBe("image");
    }

    // Initial render: canvas exactly as declared; generated + matted pixels painted.
    const renderA1 = await invokeOffline(["composition", "render", "thumb", "--project", proj, "--json"], root);
    expect(renderA1.code).toBe(0);
    const renderA1Json = JSON.parse(renderA1.stdout);
    expect(renderA1Json.ok).toBe(true);
    const manifestA1 = renderA1Json.render.manifest as string;
    const pngA1 = await readFile(renderA1Json.render.output as string);
    expect(readPngHeader(pngA1)).toMatchObject({ width: 128, height: 96 });
    const decodedA1 = decodePng(pngA1);
    expect(hasPixel(decodedA1, isGreenPixel)).toBe(true);
    // Panel-only region (beyond the background's right edge): blue with dark glyph bars.
    expect(closeTo(pixel(decodedA1, 100, 30)[0], PANEL_BLUE[0]) && closeTo(pixel(decodedA1, 100, 30)[2], PANEL_BLUE[2])).toBe(true);
    expect(hasPixel(decodedA1, (p) => p[0]! < 40 && p[1]! < 40 && p[2]! < 40)).toBe(true);
    // Matted hero: opaque center is red over the panel; a transparent corner
    // lets the panel underneath show through (alpha evidence in composition).
    expect(
      closeTo(pixel(decodedA1, 79, 47)[0], SUBJECT_RED[0]) &&
        closeTo(pixel(decodedA1, 79, 47)[1], SUBJECT_RED[1]) &&
        closeTo(pixel(decodedA1, 79, 47)[2], SUBJECT_RED[2]),
    ).toBe(true);
    expect(closeTo(pixel(decodedA1, 73, 41)[2], PANEL_BLUE[2])).toBe(true);
    await writeFile(path.join(outEvidenceDir, "thumb_initial.png"), pngA1);

    // Same-Project reuse: shared identities, no re-ingestion, no new records.
    const createB = await invokeOffline(
      ["composition", "create", "thumbB", "--width", "128", "--height", "96", "--project", proj, "--json"],
      root,
    );
    expect(createB.code).toBe(0);
    const importB = await invokeOffline(["composition", "import", "thumbB", "thumb", "--project", proj, "--json"], root);
    expect(importB.code).toBe(0);
    expect(JSON.parse(importB.stdout).importedUses).toHaveLength(3);

    const renderB0 = await invokeOffline(["composition", "render", "thumbB", "--project", proj, "--json"], root);
    expect(renderB0.code).toBe(0);
    const pngB0 = await readFile(JSON.parse(renderB0.stdout).render.output as string);
    // Shared identities render identical pixels.
    expect(decodePng(pngB0).rgba.equals(decodedA1.rgba)).toBe(true);

    // Published provenance is inspectable offline (show / list / review).
    const showBg = await invokeOffline(["generate", "show", "gen-111-bg", "--json"], root);
    expect(showBg.code).toBe(0);
    expect(JSON.parse(showBg.stdout).job.request.prompt).toBe("a calm green studio background");
    const listJobs = await invokeOffline(["generate", "list", "--json"], root);
    expect(listJobs.code).toBe(0);
    expect(JSON.parse(listJobs.stdout).jobs.map((j: { jobId: string }) => j.jobId).sort()).toEqual([
      "gen-111-alt",
      "gen-111-bg",
      "gen-111-panel",
    ]);
    const reviewPanel = await invokeOffline(["generate", "review", "gen-111-panel", "--json"], root);
    expect(reviewPanel.code).toBe(0);
    const reviewPanelJson = JSON.parse(reviewPanel.stdout);
    expect(reviewPanelJson.ok).toBe(true);
    const panelReviewHtml = await readFile(path.join(jobsRoot, "gen-111-panel", "review.html"), "utf8");
    expect(panelReviewHtml).toContain("gen-111-panel");
    expect(panelReviewHtml).toContain("nothing here implies likeness approval");

    // Retained evidence review through the public CLI.
    const reviewsDir = path.join(root, "reviews");
    await mkdir(reviewsDir, { recursive: true });
    const reviewBg1 = await invokeOffline(
      ["layer", "review", bgLayerId, "--out", path.join(reviewsDir, "bg1.html"), "--project", proj, "--json"],
      root,
    );
    expect(reviewBg1.code).toBe(0);
    const reviewBg1Json = JSON.parse(reviewBg1.stdout);
    expect(reviewBg1Json.generation.jobId).toBe("gen-111-bg");
    const reviewHero1 = await invokeOffline(
      ["layer", "review", heroLayerId, "--out", path.join(reviewsDir, "hero1.html"), "--project", proj, "--json"],
      root,
    );
    expect(reviewHero1.code).toBe(0);
    const reviewHero1Json = JSON.parse(reviewHero1.stdout);
    expect(reviewHero1Json.generation).toBeNull();
    expect(reviewHero1Json.matting.matteId).toBe("matte-111-subject");
    expect(reviewHero1Json.matting.engine).toBe("test/segmenter");

    // Snapshots for the unchanged-unrelated-Layer assertions. bg and hero are
    // never edited in Phase B; their identity, revision, and content state
    // must stay byte-identical across every other Layer's edits.
    const snapBg = await snapshotLayer(proj, bgLayerId);
    const snapHero = await snapshotLayer(proj, heroLayerId);
    const bgBlob = await readFile(path.join(proj, "content", bgContentHash));
    const heroBlob = await readFile(path.join(proj, "content", heroContentHash));

    // Ambiguous edit refusal: bg is shared by thumb and thumbB.
    const ambiguous = await invokeOffline(
      ["layer", "edit", bgLayerId, "--opacity", "0.9", "--project", proj, "--json"],
      root,
    );
    expect(ambiguous.code).toBe(1);
    const ambJson = JSON.parse(ambiguous.stdout);
    expect(ambJson.ok).toBe(false);
    expect(ambJson.referrersCount).toBe(2);
    expect(ambJson.referringCompositions).toEqual(expect.arrayContaining(["thumb", "thumbB"]));

    // Explicit propagation: in-place opacity edit advances the shared Layer.
    const inPlace = await invokeOffline(
      ["layer", "edit", panelLayerId, "--in-place", "--opacity", "0.5", "--project", proj, "--json"],
      root,
    );
    expect(inPlace.code).toBe(0);
    expect(JSON.parse(inPlace.stdout).ok).toBe(true);

    const renderA2 = await invokeOffline(["composition", "render", "thumb", "--project", proj, "--json"], root);
    expect(renderA2.code).toBe(0);
    const pngA2 = await readFile(JSON.parse(renderA2.stdout).render.output as string);
    const decodedA2 = decodePng(pngA2);
    // Propagation is visible in thumb: the panel now blends over the bg.
    expect(pngA2.equals(pngA1)).toBe(false);
    expect(
      closeTo(pixel(decodedA2, 56, 20)[0], 15) && closeTo(pixel(decodedA2, 56, 20)[1], 120) && closeTo(pixel(decodedA2, 56, 20)[2], 110),
    ).toBe(true);
    // Panel-only region over the transparent canvas: ~50% alpha.
    expect(closeTo(pixel(decodedA2, 100, 20)[3], 127, 2)).toBe(true);

    const renderB1 = await invokeOffline(["composition", "render", "thumbB", "--project", proj, "--json"], root);
    expect(renderB1.code).toBe(0);
    const manifestB1 = JSON.parse(renderB1.stdout).render.manifest as string;
    const pngB1 = await readFile(JSON.parse(renderB1.stdout).render.output as string);
    // Propagation reached the reused Composition through the shared identity.
    expect(decodePng(pngB1).rgba.equals(decodedA2.rgba)).toBe(true);

    // Explicit fork: retarget exactly one use; thumb's pixels are unaffected.
    const forkPng = path.join(root, "fork-panel.png");
    await writeFile(forkPng, solidPng(64, 64, FORK_MAGENTA));
    const fork = await invokeOffline(
      [
        "layer", "edit", panelLayerId,
        "--fork", "--composition", "thumbB", "--use", "panel",
        "--image", forkPng,
        "--project", proj, "--json",
      ],
      root,
    );
    expect(fork.code).toBe(0);
    const forkJson = JSON.parse(fork.stdout);
    const forkedLayerId = forkJson.layer.id as string;
    expect(forkedLayerId).not.toBe(panelLayerId);

    const renderB2 = await invokeOffline(["composition", "render", "thumbB", "--project", proj, "--json"], root);
    expect(renderB2.code).toBe(0);
    const pngB2 = await readFile(JSON.parse(renderB2.stdout).render.output as string);
    const decodedB2 = decodePng(pngB2);
    // The forked use paints magenta at the preserved 50% opacity over the bg.
    expect(
      closeTo(pixel(decodedB2, 56, 20)[0], 110) && closeTo(pixel(decodedB2, 56, 20)[1], 90) && closeTo(pixel(decodedB2, 56, 20)[2], 110),
    ).toBe(true);

    // Unchanged across the fork: thumb re-renders byte-identically.
    const renderA3 = await invokeOffline(["composition", "render", "thumb", "--project", proj, "--json"], root);
    expect(renderA3.code).toBe(0);
    const pngA3 = await readFile(JSON.parse(renderA3.stdout).render.output as string);
    expect(pngA3.equals(pngA2)).toBe(true);

    // Unchanged unrelated Layers: bg and hero stayed byte-identical through
    // every Phase B edit so far; the retained blobs are the same bytes.
    assertSnapshotUnchanged(snapBg, await snapshotLayer(proj, bgLayerId), "bg through Phase B");
    assertSnapshotUnchanged(snapHero, await snapshotLayer(proj, heroLayerId), "hero through Phase B");
    expect((await readFile(path.join(proj, "content", heroContentHash))).equals(heroBlob)).toBe(true);
    expect((await readFile(path.join(proj, "content", bgContentHash))).equals(bgBlob)).toBe(true);

    // Explicit content replacement through the edit contract — the generated
    // Layer participates in the exact same explicit edit-intent contract as
    // every other Layer (#107/#108 on #82's editing surface):
    // --from-generation replaces the panel's content with another published
    // output without generating again, and --from-matte replaces it with a
    // published matte of that output (retaining the matte record and, by the
    // derived sha-256 lineage, the predecessor job record too).
    const editPanelGen = await invokeOffline(
      ["layer", "edit", panelLayerId, "--in-place", "--from-generation", "gen-111-alt", "--project", proj, "--json"],
      root,
    );
    expect(editPanelGen.code).toBe(0);
    const editPanelGenJson = JSON.parse(editPanelGen.stdout);
    expect(editPanelGenJson.ok).toBe(true);
    expect(editPanelGenJson.generatedFrom).toEqual({
      jobId: "gen-111-alt",
      contentHash: altJob.run.outputs[0]!.contentHash,
    });
    expect(editPanelGenJson.layer.currentRevision.contentHash).toBe(altJob.run.outputs[0]!.contentHash);

    const renderA4 = await invokeOffline(["composition", "render", "thumb", "--project", proj, "--json"], root);
    expect(renderA4.code).toBe(0);
    const pngA4 = await readFile(JSON.parse(renderA4.stdout).render.output as string);
    const decodedA4 = decodePng(pngA4);
    // Replacement is visible: orange now blends over the bg at 50% opacity.
    expect(pngA4.equals(pngA3)).toBe(false);
    expect(
      closeTo(pixel(decodedA4, 56, 20)[0], 120) && closeTo(pixel(decodedA4, 56, 20)[1], 165) && closeTo(pixel(decodedA4, 56, 20)[2], 55),
    ).toBe(true);

    const editPanelMatte = await invokeOffline(
      ["layer", "edit", panelLayerId, "--in-place", "--from-matte", "matte-111-alt", "--project", proj, "--json"],
      root,
    );
    expect(editPanelMatte.code).toBe(0);
    const editPanelMatteJson = JSON.parse(editPanelMatte.stdout);
    expect(editPanelMatteJson.mattedFrom).toEqual({
      matteId: "matte-111-alt",
      engine: "test/segmenter",
      contentHash: altMatte.result.outputs[0]!.contentHash,
    });
    // The matte's source was a published generation output: the predecessor
    // job record is retained with it (derived lineage, one home per fact).
    // generatedFrom's contentHash is the Layer's new content identity — the
    // matte output bytes this revision now pins.
    expect(editPanelMatteJson.generatedFrom).toEqual({
      jobId: "gen-111-alt",
      contentHash: altMatte.result.outputs[0]!.contentHash,
    });

    const renderA5 = await invokeOffline(["composition", "render", "thumb", "--project", proj, "--json"], root);
    expect(renderA5.code).toBe(0);
    const pngA5 = await readFile(JSON.parse(renderA5.stdout).render.output as string);
    const decodedA5 = decodePng(pngA5);
    expect(pngA5.equals(pngA4)).toBe(false);
    // The matted panel now carries true alpha: an opaque mask center (the
    // 16×16 mask's [4..12)² window rescaled to 64×64) paints orange over the
    // canvas, a mask corner is fully transparent, and the hero's opaque
    // center (an unrelated Layer) is visually unchanged.
    // Over the transparent canvas, the renderer's un-premultiplied PNG
    // export keeps the panel's color ≈ full and halves the alpha.
    expect(closeTo(pixel(decodedA5, 80, 30)[0], ALT_ORANGE[0])).toBe(true);
    expect(closeTo(pixel(decodedA5, 80, 30)[1], ALT_ORANGE[1])).toBe(true);
    expect(closeTo(pixel(decodedA5, 80, 30)[2], ALT_ORANGE[2])).toBe(true);
    expect(closeTo(pixel(decodedA5, 80, 30)[3], 127, 2)).toBe(true);
    expect(pixel(decodedA5, 100, 30)[3]).toBe(0);
    expect(isRedPixel(pixel(decodedA5, 79, 47))).toBe(true);
    await writeFile(path.join(outEvidenceDir, "thumb_replaced.png"), pngA5);

    // Unchanged unrelated Layers through the replacement edits too.
    assertSnapshotUnchanged(snapBg, await snapshotLayer(proj, bgLayerId), "bg after replacements");
    assertSnapshotUnchanged(snapHero, await snapshotLayer(proj, heroLayerId), "hero after replacements");

    // No additional model calls for local continuation: the injected
    // provider/engine counters still sit exactly at the Phase A baseline;
    // no new Job was published and the only newly retained provenance came
    // from the explicit replacement ingests above.
    expect(providerCalls()).toBe(3);
    expect(engineCalls()).toBe(2);
    const listAfterB = await invokeOffline(["generate", "list", "--json"], root);
    expect(JSON.parse(listAfterB.stdout).jobs).toHaveLength(3);
    expect(await jobIds(path.join(proj, "generation"))).toEqual(["gen-111-alt", "gen-111-bg", "gen-111-panel"]);
    expect(await jobIds(path.join(proj, "matting"))).toEqual(["matte-111-alt", "matte-111-subject"]);

    // Historical replay before deletion: byte-identical.
    const replayA1 = await invokeOffline(
      ["composition", "replay", manifestA1, "--out", path.join(outEvidenceDir, "thumb_replayed_a1.png"), "--project", proj, "--json"],
      root,
    );
    expect(replayA1.code).toBe(0);
    expect((await readFile(path.join(outEvidenceDir, "thumb_replayed_a1.png"))).equals(pngA1)).toBe(true);

    // -----------------------------------------------------------------------
    // Phase C — delete every external input/output, relocate, continue offline.
    // -----------------------------------------------------------------------
    // Retained provenance is byte-identical to the published records —
    // including gen-111-alt, retained once by the --from-generation
    // replacement and again (byte-identically, never rewritten) by the
    // --from-matte replacement's derived lineage.
    for (const jobId of ["gen-111-alt", "gen-111-bg", "gen-111-panel"]) {
      const published = await readFile(path.join(jobsRoot, jobId, "job.json"));
      const retained = await readFile(path.join(proj, "generation", jobId, "job.json"));
      expect(retained.equals(published), `${jobId} retained record must be byte-identical`).toBe(true);
    }
    for (const matteId of ["matte-111-alt", "matte-111-subject"]) {
      const publishedMatte = await readFile(path.join(matteRoot, matteId, "matte.json"));
      const retainedMatte = await readFile(path.join(proj, "matting", matteId, "matte.json"));
      expect(retainedMatte.equals(publishedMatte), `${matteId} retained record must be byte-identical`).toBe(true);
    }

    // Delete external inputs and outputs: the published Job/Matte stores, the
    // matte's source image, and the fork's caller-supplied image.
    await rm(path.join(root, "out"), { recursive: true, force: true });
    await rm(subjectSource, { force: true });
    await rm(forkPng, { force: true });

    // Relocate the Project.
    const proj2 = path.join(root, "proj-relocated");
    await rename(proj, proj2);

    // Continued inspection offline.
    const inspectProj = await invokeOffline(["project", "inspect", "--project", proj2, "--json"], root);
    expect(inspectProj.code).toBe(0);
    expect(JSON.parse(inspectProj.stdout).project.name).toBe("Connected");

    const listComps = await invokeOffline(["composition", "list", "--project", proj2, "--json"], root);
    expect(listComps.code).toBe(0);
    expect(JSON.parse(listComps.stdout).compositions).toHaveLength(2);

    const inspectComp = await invokeOffline(["composition", "inspect", "thumb", "--project", proj2, "--json"], root);
    expect(inspectComp.code).toBe(0);
    expect(JSON.parse(inspectComp.stdout).composition.layers).toHaveLength(3);

    const listLayers = await invokeOffline(["layer", "list", "--project", proj2, "--json"], root);
    expect(listLayers.code).toBe(0);
    expect(JSON.parse(listLayers.stdout).layers).toHaveLength(4);

    // Retained provenance/evidence review works offline after relocation.
    const reviewBg2 = await invokeOffline(
      ["layer", "review", bgLayerId, "--out", path.join(reviewsDir, "bg2.html"), "--project", proj2, "--json"],
      root,
    );
    expect(reviewBg2.code).toBe(0);
    const reviewBg2Json = JSON.parse(reviewBg2.stdout);
    expect(reviewBg2Json.generation.jobId).toBe("gen-111-bg");
    const bg2Html = await readFile(path.join(reviewsDir, "bg2.html"), "utf8");
    expect(bg2Html).toContain("gen-111-bg");
    expect(bg2Html).toContain("nothing here implies likeness approval");

    const reviewHero2 = await invokeOffline(
      ["layer", "review", heroLayerId, "--out", path.join(reviewsDir, "hero2.html"), "--project", proj2, "--json"],
      root,
    );
    expect(reviewHero2.code).toBe(0);
    const reviewHero2Json = JSON.parse(reviewHero2.stdout);
    expect(reviewHero2Json.matting.matteId).toBe("matte-111-subject");
    expect(reviewHero2Json.matting.alpha.opaquePx).toBe(opaque);
    const hero2Html = await readFile(path.join(reviewsDir, "hero2.html"), "utf8");
    expect(hero2Html).toContain("matte-111-subject");

    // The published surface is honestly gone: its records were external.
    const showAfterDeletion = await invokeOffline(["generate", "show", "gen-111-panel", "--json"], root);
    expect(showAfterDeletion.code).toBe(1);
    expect(JSON.parse(showAfterDeletion.stdout).ok).toBe(false);

    // Continue editing offline.
    const editHero = await invokeOffline(
      ["layer", "edit", heroLayerId, "--in-place", "--opacity", "0.8", "--project", proj2, "--json"],
      root,
    );
    expect(editHero.code).toBe(0);
    // Historical hero revisions and the retained content blob stay identical;
    // only the identity's current-revision pointer advanced.
    const heroAfterEdit = await snapshotLayer(proj2, heroLayerId);
    for (const [rel, bytes] of snapHero) {
      if (rel.endsWith(".json") && rel.includes(".revisions/")) {
        const now = heroAfterEdit.get(rel);
        expect(now).toBeDefined();
        expect(now!.equals(bytes), `hero historical revision ${rel} must stay byte-identical`).toBe(true);
      }
    }
    expect((await readFile(path.join(proj2, "content", heroContentHash))).equals(heroBlob)).toBe(true);

    const editBgFork = await invokeOffline(
      ["layer", "edit", bgLayerId, "--fork", "--composition", "thumbB", "--use", "bg", "--x", "12", "--project", proj2, "--json"],
      root,
    );
    expect(editBgFork.code).toBe(0);
    // Forking bg leaves the original bg Layer byte-identical.
    assertSnapshotUnchanged(snapBg, await snapshotLayer(proj2, bgLayerId), "bg through Phase C");
    expect((await readFile(path.join(proj2, "content", bgContentHash))).equals(bgBlob)).toBe(true);

    // Render the edited state offline: changed pixels where expected.
    const renderRel = await invokeOffline(["composition", "render", "thumb", "--project", proj2, "--json"], root);
    expect(renderRel.code).toBe(0);
    const pngRel = await readFile(JSON.parse(renderRel.stdout).render.output as string);
    expect(readPngHeader(pngRel)).toMatchObject({ width: 128, height: 96 });
    expect(pngRel.equals(pngA5)).toBe(false);
    await writeFile(path.join(outEvidenceDir, "thumb_relocated_edited.png"), pngRel);

    // Byte-identical historical replay within the recorded environment: the
    // pre-deletion, pre-relocation manifests still resolve exactly.
    const replayRelA1 = await invokeOffline(
      ["composition", "replay", path.join(proj2, path.relative(proj, manifestA1)), "--out", path.join(outEvidenceDir, "thumb_replayed_relocated.png"), "--project", proj2, "--json"],
      root,
    );
    expect(replayRelA1.code).toBe(0);
    expect((await readFile(path.join(outEvidenceDir, "thumb_replayed_relocated.png"))).equals(pngA1)).toBe(true);

    const replayRelB1 = await invokeOffline(
      ["composition", "replay", path.join(proj2, path.relative(proj, manifestB1)), "--out", path.join(outEvidenceDir, "thumbB_replayed_relocated.png"), "--project", proj2, "--json"],
      root,
    );
    expect(replayRelB1.code).toBe(0);
    expect((await readFile(path.join(outEvidenceDir, "thumbB_replayed_relocated.png"))).equals(pngB1)).toBe(true);

    // Final counts: still exactly the three injected generation calls and
    // two engine calls. The published store was deleted in this phase (its
    // list is honestly empty); the retained Project records remain — three
    // Generation Jobs and two mattes, including the replacement lineage.
    expect(providerCalls()).toBe(3);
    expect(engineCalls()).toBe(2);
    const listEnd = await invokeOffline(["generate", "list", "--json"], root);
    expect(listEnd.code).toBe(0);
    expect(JSON.parse(listEnd.stdout).jobs).toHaveLength(0);
    expect(await jobIds(path.join(proj2, "generation"))).toEqual(["gen-111-alt", "gen-111-bg", "gen-111-panel"]);
    expect(await jobIds(path.join(proj2, "matting"))).toEqual(["matte-111-alt", "matte-111-subject"]);
  },
  LONG,
);

// ---------------------------------------------------------------------------
// 3. Whole-introduced local surface under kernel network denial (TEST-005)
// ---------------------------------------------------------------------------

darwinOnly(
  "every introduced non-generation command works under kernel network denial; generation itself is the distinguished control",
  async () => {
    const root = tempDir;
    const jobsRoot = path.join(root, "out", "generation");

    // Injected-generation preparation (in-process): one published Job whose
    // evidence the denial coverage then reads offline.
    const { provider, calls: providerCalls } = countingProvider([solidPng(32, 32, BG_GREEN)]);
    const job = await runUniformGeneration(
      jobsRoot,
      "gen-denial-1",
      {
        prompt: "offline evidence source",
        intent: "full-canvas",
        model: "gpt-image",
        sizing: { kind: "size", width: 32, height: 32 },
        count: 1,
      },
      { provider },
    );
    expect(providerCalls()).toBe(1);

    // A natively isolated source: the public matte CLI runs it with no
    // inference, no weights, and no network.
    const alphaSource = path.join(root, "alpha-subject.png");
    const alphaSourceBytes = encodePng(16, 16, (x, y) => (x < 8 && y < 8 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    await writeFile(alphaSource, alphaSourceBytes);

    // Introduced module help surfaces (the preserved legacy modules' help
    // coverage belongs to the #88 foundation qualification, not this slice).
    const topHelp = await invokeOffline(["--help"], root);
    expect(topHelp.code).toBe(0);
    expect(topHelp.stdout).toContain("Ply — local image composition");
    for (const mod of ["project", "composition", "layer", "generate", "matte"] as const) {
      const help = await invokeOffline([mod, "--help"], root);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain(mod);
    }

    // Generation inspection commands are pure local reads.
    const show = await invokeOffline(["generate", "show", job.jobId, "--json"], root);
    expect(show.code).toBe(0);
    expect(JSON.parse(show.stdout).job.jobId).toBe("gen-denial-1");
    const list = await invokeOffline(["generate", "list", "--json"], root);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout).jobs).toHaveLength(1);
    const review = await invokeOffline(["generate", "review", job.jobId, "--json"], root);
    expect(review.code).toBe(0);
    const reviewJson = JSON.parse(review.stdout);
    expect(reviewJson.ok).toBe(true);
    expect(reviewJson.outputs[0].matte).toBeNull();
    const reviewHtml = await readFile(path.join(jobsRoot, "gen-denial-1", "review.html"), "utf8");
    expect(reviewHtml).toContain("gen-denial-1");

    // The matte CLI's native-alpha route: no inference, no weights, offline.
    const matteRes = await invokeOffline(["matte", alphaSource, "--id", "matte-denial-1", "--json"], root);
    expect(matteRes.code).toBe(0);
    const matteJson = JSON.parse(matteRes.stdout);
    expect(matteJson.ok).toBe(true);
    // The published bytes are the exact source bytes (native alpha).
    const matteOutBytes = await readFile(
      path.join(root, "out", "matting", "matte-denial-1", matteJson.matte.result.outputs[0].file),
    );
    expect(matteOutBytes.equals(alphaSourceBytes)).toBe(true);
    expect(providerCalls()).toBe(1);

    // The distinguishing control: generation is the one operation that
    // needs the network. A dummy credential makes the SDK attempt a real
    // outbound call, so under kernel denial the production CLI fails at the
    // denied socket layer (DNS resolution for the gateway host) with a
    // nonzero exit and publishes nothing — while every local command above
    // succeeded under the same denial. (The exact error text is provider- /
    // OS-dependent; the socket-level denial proof itself is the negative
    // control at the top of this suite.)
    const genAttempt = await invokeOffline(
      ["generate", "network-only prompt", "--json"],
      root,
      { AI_GATEWAY_API_KEY: "dummy-key-for-denial-control" },
    );
    expect(genAttempt.code).toBe(1);
    const genAttemptJson = JSON.parse(genAttempt.stdout);
    expect(genAttemptJson.ok).toBe(false);
    expect(genAttemptJson.error).toMatch(/ENOTFOUND|getaddrinfo|fetch failed|network/i);
    const listAfterAttempt = await invokeOffline(["generate", "list", "--json"], root);
    expect(JSON.parse(listAfterAttempt.stdout).jobs).toHaveLength(1);
    expect(providerCalls()).toBe(1);
  },
  LONG,
);