/**
 * Qualification for ticket #216 (spec #207 US-007, TEST-006/007): ONE
 * Composition that uses all three capabilities delivered by tickets 1–8 —
 * a shape Layer, a visible region, and a recoloured vector — renders, then
 * replays byte-identically after Project relocation with the source files
 * deleted, under kernel network denial.
 *
 * Owns the interaction only, not each predecessor's contract: shape
 * parameters (#208/#209/#210), the visible region (#211/#212), vector
 * import and inertness (#213/#214), and the vector colour (#215) each have
 * their own suite. Everything here runs offline: every ply invocation is a
 * `sandbox-exec '(deny network*)'` child, so a model call or any fetch
 * cannot succeed — the same isolation the #111 connected qualification
 * negative-controls at the socket layer. Darwin-only; off Darwin the suite
 * skips rather than claiming weaker isolation is proof.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { closeBrowser } from "../src/browser.js";
import { decodePng, readPngHeader } from "../src/png.js";
import { encodePng } from "./png.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Rgba = [number, number, number, number];

/** A single-colour inert SVG mark: a square ring, authored fill #000000. */
const RING_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#000000"><path d="M2 2h20v20H2zM8 8h8v8H8z" fill-rule="evenodd"/></svg>
`;

/** A padded cutout: 64×64 with a 16px transparent border around a 32px core. */
const PADDED_PNG = encodePng(64, 64, (x, y): Rgba =>
  x >= 16 && x < 48 && y >= 16 && y < 48 ? [200, 0, 200, 255] : [0, 0, 0, 0],
);

const closeTo = (a: number, b: number, tol = 12) => Math.abs(a - b) <= tol;
const isMagenta = (p: Rgba) => p[0]! > 150 && p[1]! < 60 && p[2]! > 150;

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): Rgba {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

// ---------------------------------------------------------------------------
// Kernel network denial (same isolation as the #111 connected qualification)
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

async function invokeOffline(args: string[], cwd: string) {
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

const darwinOnly = test.skipIf(process.platform !== "darwin");
const LONG = 240_000;

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-207-qual-"));
});

afterEach(async () => {
  await closeBrowser();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

darwinOnly(
  "one Composition with a shape, a visible region, and a recoloured vector replays byte-identically after relocation, offline",
  async () => {
    const root = tempDir;
    const proj = path.join(root, "proj");

    // The composition's only external sources: the vector file and the
    // padded cutout. Both are deleted before relocation.
    const ringSvg = path.join(root, "ring.svg");
    await writeFile(ringSvg, RING_SVG);
    const paddedPng = path.join(root, "padded.png");
    await writeFile(paddedPng, PADDED_PNG);

    const init = await invokeOffline(["project", "init", proj, "--json"], root);
    expect(init.code).toBe(0);

    const create = await invokeOffline(
      ["composition", "create", "thumb", "--width", "128", "--height", "96", "--project", proj, "--json"],
      root,
    );
    expect(create.code).toBe(0);

    // The shape Layer: a rounded gradient background — parameters only.
    const addBg = await invokeOffline(
      [
        "composition", "add", "thumb", "bg",
        "--shape", "rectangle", "--size", "128x96", "--corner-radius", "12",
        "--fill", "linear:90deg,#1d4ed8,#22c55e",
        "--project", proj, "--json",
      ],
      root,
    );
    expect(addBg.code).toBe(0);
    expect(JSON.parse(addBg.stdout).ok).toBe(true);

    // The recoloured vector: one single-colour file painted #e11d48.
    const addRing = await invokeOffline(
      [
        "composition", "add", "thumb", "ring",
        "--image", ringSvg, "--vector-color", "#e11d48",
        "--resize-to", "48x48", "--x", "48", "--y", "24",
        "--project", proj, "--json",
      ],
      root,
    );
    expect(addRing.code).toBe(0);
    const ringLayerId = JSON.parse(addRing.stdout).use.layerId as string;

    // The framed cutout: the visible region crops the transparent padding
    // in the Layer's own content pixels.
    const addCut = await invokeOffline(
      [
        "composition", "add", "thumb", "cutout",
        "--image", paddedPng, "--visible-region", "16,16,32,32",
        "--x", "70", "--y", "20",
        "--project", proj, "--json",
      ],
      root,
    );
    expect(addCut.code).toBe(0);
    const cutLayerId = JSON.parse(addCut.stdout).use.layerId as string;

    // The facts are revision facts on the right kinds.
    const inspectRing = await invokeOffline(["layer", "inspect", ringLayerId, "--project", proj, "--json"], root);
    const ringRev = JSON.parse(inspectRing.stdout).layer.currentRevision;
    expect(ringRev.format).toBe("svg");
    expect(ringRev.vectorColor).toBe("#e11d48");
    const inspectCut = await invokeOffline(["layer", "inspect", cutLayerId, "--project", proj, "--json"], root);
    const cutRev = JSON.parse(inspectCut.stdout).layer.currentRevision;
    expect(cutRev.visibleRegion).toEqual({ x: 16, y: 16, width: 32, height: 32 });

    // Render offline: all three capabilities paint where they should.
    const render = await invokeOffline(["composition", "render", "thumb", "--project", proj, "--json"], root);
    expect(render.code).toBe(0);
    const renderJson = JSON.parse(render.stdout);
    expect(renderJson.ok).toBe(true);
    const manifest = renderJson.render.manifest as string;
    const png = await readFile(renderJson.render.output as string);
    expect(readPngHeader(png)).toMatchObject({ width: 128, height: 96 });
    const decoded = decodePng(png);
    // Rounded corner: outside the corner radius is transparent.
    expect(pixel(decoded, 0, 0)[3]).toBe(0);
    // Gradient endpoints (90deg: left → right).
    const left = pixel(decoded, 4, 48);
    expect(closeTo(left[0], 30) && closeTo(left[1], 82) && closeTo(left[2], 213)).toBe(true);
    const right = pixel(decoded, 124, 48);
    expect(closeTo(right[0], 34) && closeTo(right[1], 194) && closeTo(right[2], 97)).toBe(true);
    // The recoloured vector: a stroke pixel is exactly the requested colour.
    const stroke = pixel(decoded, 56, 48);
    expect(closeTo(stroke[0], 225, 4) && closeTo(stroke[1], 29, 4) && closeTo(stroke[2], 72, 4)).toBe(true);
    // The ring's hole shows the gradient beneath, not the vector colour.
    const hole = pixel(decoded, 72, 48);
    expect(hole[0] !== 225 || hole[2] !== 72).toBe(true);
    // The visible region: the cutout's core lands at (86..118, 36..52);
    // its former padding area shows the background instead.
    expect(isMagenta(pixel(decoded, 100, 44))).toBe(true);
    expect(isMagenta(pixel(decoded, 75, 44))).toBe(false);

    // -----------------------------------------------------------------------
    // Delete the external sources, relocate the Project, replay offline.
    // -----------------------------------------------------------------------
    await rm(ringSvg, { force: true });
    await rm(paddedPng, { force: true });

    const proj2 = path.join(root, "proj-relocated");
    await rename(proj, proj2);

    // The relocated Project still inspects its retained state.
    const inspectProj = await invokeOffline(["project", "inspect", "--project", proj2, "--json"], root);
    expect(inspectProj.code).toBe(0);
    const listLayers = await invokeOffline(["layer", "list", "--project", proj2, "--json"], root);
    expect(listLayers.code).toBe(0);
    expect(JSON.parse(listLayers.stdout).layers).toHaveLength(3);

    // Replay the retained manifest from the relocated Project, without the
    // original source files, under kernel network denial: byte-identical.
    const replay = await invokeOffline(
      [
        "composition", "replay",
        path.join(proj2, path.relative(proj, manifest)),
        "--out", path.join(root, "replayed.png"),
        "--project", proj2, "--json",
      ],
      root,
    );
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.stdout).ok).toBe(true);
    const replayed = await readFile(path.join(root, "replayed.png"));
    expect(replayed.equals(png)).toBe(true);
  },
  LONG,
);