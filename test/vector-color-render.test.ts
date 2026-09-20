/**
 * The vector colour parameter at the rendered-pixel seam (#215, spec #207
 * US-005, DEC-008, TEST-004): a recoloured vector renders the requested
 * colour exactly at an interior pixel, preserves the alpha edges, flattens a
 * multi-colour vector to a silhouette, removes byte-identically, replays
 * byte-identically, and stays inert through the browser image path the mask
 * rides. Paint order: the colour is content paint — the region crops it and
 * the outline/shadow hug the cropped, coloured edge (ADR-0023).
 *
 * TEST-004/005/006/007: CLI and in-process seams, per-file `bun test
 * --isolate`, offline — no network, no weights.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { decodePng } from "../src/png.js";
import { renderComposition, replayRender } from "../src/composition-render.js";
import {
  withRenderPage,
  renderPageNetworkRequests,
  clearRenderPageRequests,
} from "../src/browser.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

async function invoke(args: string[]) {
  const result = Bun.spawn([process.execPath, cli, ...args], {
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

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-vector-colour-render-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "colour-render"]);
  await invoke([
    "composition", "create", "poster", "--width", "200", "--height", "120", "--project", projDir,
  ]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

const close = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

const expectPixel = (
  png: ReturnType<typeof decodePng>,
  x: number,
  y: number,
  rgba: readonly [number, number, number, number],
  tol = 2,
) => {
  const p = pixel(png, x, y);
  expect(p.every((v, i) => close(v, rgba[i]!, tol))).toBe(true);
};

/**
 * A multi-colour SVG with every alpha shape the colour contract needs: an
 * opaque field (left half), an opaque inner rect (a second authored colour),
 * and a semi-transparent circle over TRANSPARENCY (right half — the alpha
 * edge). Declared intrinsic size.
 */
function markSvg(width = 80, height = 40): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<rect x="0" y="0" width="${width / 2}" height="${height}" fill="#ff0000"/>` +
    `<rect x="20" y="10" width="20" height="20" fill="#0000ff"/>` +
    `<circle cx="60" cy="20" r="8" fill="#00ff00" fill-opacity="0.5"/>` +
    `</svg>`
  );
}

async function addSvgLayer(args: string[]): Promise<string> {
  const svgPath = path.join(tempDir, `mark-${Math.random().toString(36).slice(2, 8)}.svg`);
  await writeFile(svgPath, markSvg());
  const add = await invoke([
    "composition", "add", "poster", `use-${Math.random().toString(36).slice(2, 8)}`,
    "--image", svgPath, "--x", "60", "--y", "40", ...args,
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  return JSON.parse(add.stdout).use.layerId as string;
}

// ---------------------------------------------------------------------------
// Exact colour, preserved alpha edges, whole-Layer silhouette (TEST-004)
// ---------------------------------------------------------------------------

test("an interior pixel of a recoloured vector equals the requested colour exactly; alpha edges are preserved; a multi-colour vector becomes a silhouette", async () => {
  const layerId = await addSvgLayer(["--vector-color", "#22c55e"]);
  const rendered = await renderComposition(projDir, "poster", { supersample: 1 });
  const png = decodePng(await readFile(rendered.output));

  // Opaque interior (the red field away from the inner rect): exactly the
  // requested colour, full alpha.
  expectPixel(png, 65, 45, [0x22, 0xc5, 0x5e, 255]);
  // The inner rect's authored blue is gone — whole-Layer replacement
  // (DEC-008): a multi-colour vector becomes a single-colour silhouette.
  expectPixel(png, 85, 55, [0x22, 0xc5, 0x5e, 255]);
  // Outside the vector — and the transparent right half of it: untouched.
  expectPixel(png, 30, 20, [0, 0, 0, 0]);
  expectPixel(png, 145, 100, [0, 0, 0, 0]);
  expectPixel(png, 135, 45, [0, 0, 0, 0]);

  // The semi-transparent circle's alpha edge is preserved: the requested
  // colour at the authored alpha (0.5 × 255), not flattened to opaque.
  expectPixel(png, 120, 60, [0x22, 0xc5, 0x5e, 127]);

  // Colour does not move ink: the painted box is the vector's own box
  // (60,40)-(140,80) — an uncoloured twin measures the same painted box.
  const svgPath = path.join(tempDir, "twin.svg");
  await writeFile(svgPath, markSvg());
  await invoke(["composition", "add", "poster", "twin", "--image", svgPath, "--x", "60", "--y", "40", "--project", projDir, "--json"]);
  const measured = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  const layers = JSON.parse(measured.stdout).layers as { painted: { x: number; y: number; width: number; height: number } | null }[];
  expect(layers[0]!.painted).toEqual(layers[1]!.painted);
});

// ---------------------------------------------------------------------------
// Paint order: colour is content paint; the region crops it and the effects
// hug the cropped, coloured edge (ADR-0023)
// ---------------------------------------------------------------------------

test("with a visible region, outline, and shadow, the colour stays content paint: the region crops it and the outline hugs the region's edge", async () => {
  const layerId = await addSvgLayer(["--vector-color", "#e11d48"]);
  const setRegion = await invoke([
    "layer", "edit", layerId, "--visible-region", "20,10,40,20",
    "--outline", "4,#00ff00", "--shadow", "2,2,0,#000000",
    "--project", projDir, "--json",
  ]);
  expect(setRegion.code).toBe(0);
  const rendered = await renderComposition(projDir, "poster", { supersample: 1 });
  const png = decodePng(await readFile(rendered.output));

  // The placement point stays (60,40) (left-anchored, DEC-005): the region
  // rect (20,10)-(60,30) in content pixels lands at (80,50)-(100,70) on the
  // canvas. Interior of the region: exactly the requested colour.
  expectPixel(png, 90, 60, [0xe1, 0x1d, 0x48, 255]);
  // Content outside the region is not ink — even where the authored vector
  // was opaque.
  expectPixel(png, 70, 55, [0, 0, 0, 0]);
  // The outline hugs the region's edge: 4px left of the region's left edge,
  // over formerly-opaque content — ring green, not authored red.
  expectPixel(png, 77, 60, [0, 255, 0, 255]);
  expectPixel(png, 90, 47, [0, 255, 0, 255]);
  // Beyond the outline's reach: untouched.
  expectPixel(png, 70, 47, [0, 0, 0, 0]);
});

// ---------------------------------------------------------------------------
// Removal restores the authored colours byte-identically; replay (TEST-006)
// ---------------------------------------------------------------------------

test("set-then-remove renders byte-identically to never-set", async () => {
  const layerId = await addSvgLayer([]);
  const before = await renderComposition(projDir, "poster", { supersample: 1 });
  const beforeBytes = await readFile(before.output);

  const set = await invoke(["layer", "edit", layerId, "--vector-color", "#22c55e", "--project", projDir, "--json"]);
  expect(set.code).toBe(0);
  const coloured = await renderComposition(projDir, "poster", { supersample: 1 });
  const colouredBytes = await readFile(coloured.output);
  expect(colouredBytes.equals(beforeBytes)).toBe(false);

  const remove = await invoke(["layer", "edit", layerId, "--vector-color", "none", "--project", projDir, "--json"]);
  expect(remove.code).toBe(0);
  const after = await renderComposition(projDir, "poster", { supersample: 1 });
  expect((await readFile(after.output)).equals(beforeBytes)).toBe(true);
});

test("a Render with a recoloured vector replays byte-identically, and a manifest captured before a colour edit replays unchanged after it", async () => {
  const layerId = await addSvgLayer([]);
  // Capture history BEFORE the colour exists.
  const pre = await invoke(["composition", "render", "poster", "--supersample", "1", "--project", projDir, "--json"]);
  expect(pre.code).toBe(0);
  const preManifest = JSON.parse(pre.stdout).render.manifest as string;
  const preOutput = JSON.parse(pre.stdout).render.output as string;
  const preBytes = await readFile(preOutput);

  // Colour the vector; the new render differs and replays byte-identically.
  const set = await invoke(["layer", "edit", layerId, "--vector-color", "#22c55e", "--project", projDir, "--json"]);
  expect(set.code).toBe(0);
  const post = await renderComposition(projDir, "poster", { supersample: 1 });
  const postBytes = await readFile(post.output);
  expect(postBytes.equals(preBytes)).toBe(false);
  const postManifest = post.manifest;
  const replayedPost = await replayRender(projDir, postManifest);
  expect((await readFile(replayedPost.output)).equals(postBytes)).toBe(true);

  // The pre-colour manifest still replays byte-identically from the pinned
  // revision — the colour edit advanced the Layer, never history.
  const replayedPre = await replayRender(projDir, preManifest);
  expect((await readFile(replayedPre.output)).equals(preBytes)).toBe(true);
});

// ---------------------------------------------------------------------------
// Inertness through the colour path (TEST-005)
// ---------------------------------------------------------------------------

test("a recoloured script-only SVG renders with zero network requests and no script side effect", async () => {
  const svgPath = path.join(tempDir, "script-only.svg");
  await writeFile(
    svgPath,
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" viewBox="0 0 80 40">` +
      `<script>window.__plyVectorScriptRan = true;</script>` +
      `<rect x="0" y="0" width="80" height="40" fill="#ff0000"/>` +
      `</svg>`,
  );
  const add = await invoke([
    "composition", "add", "poster", "logo",
    "--image", svgPath, "--vector-color", "#22c55e", "--x", "60", "--y", "40",
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);

  // In-process render — the exact library entry point `composition render`
  // calls — on the shared render page whose request log this test reads.
  clearRenderPageRequests();
  const rendered = await renderComposition(projDir, "poster", { supersample: 1 });
  expect(renderPageNetworkRequests()).toEqual([]);
  const png = decodePng(await readFile(rendered.output));
  expectPixel(png, 65, 45, [0x22, 0xc5, 0x5e, 255]);

  // No script side effect on the page that painted the masked vector.
  await withRenderPage(async (page) => {
    const marker = await page.evaluate(() => (window as unknown as Record<string, unknown>).__plyVectorScriptRan ?? null);
    expect(marker).toBeNull();
  });
});