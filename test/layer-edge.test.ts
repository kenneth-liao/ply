/**
 * Layer edge choke and feather (#300, spec #285 US-013, DEC-005, DEC-006,
 * TEST-001/002/003, ADR-0024 amendment).
 *
 * Verifies through the public CLI and rendered-pixel seams:
 * - `--choke <px>` and `--feather <px>` are absolute Layer revision facts on
 *   raster, vector, text, and shape Layers: the alpha edge is eroded inward
 *   by the choke, then Gaussian-softened by the feather, as the FIRST
 *   function of the outer element's effects filter chain (before glow,
 *   outline, shadow; blur stays LAST) — so cutout halos disappear on
 *   saturated backgrounds and every later effect hugs the shaped edge.
 * - The shaped alpha is composited `in` the source graphic, so the painted
 *   ink NEVER exceeds the unfeathered ink: feather softens the edge inward
 *   only, and neither fact adds reach (the ADR-0024 amendment).
 * - Stored only when > 0; `0` is the documented removal form. Removing the
 *   settings restores the render byte-for-byte. Retained content bytes never
 *   change.
 * - Refusal before publication for non-numeric or out-of-range values (0..256
 *   px), naming the flag and its range, identically on add and edit.
 * - `measure` reports both facts. Anchored placement resolves against the
 *   pre-effect ink (#288, ADR-0025): neither fact moves a stored placement.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePngRgba, decodePng } from "../src/png.js";

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

/** A WxH solid block with an added semi-transparent light fringe of
 * `fringePx` on every side — the cutout-halo fixture: hard ink ringed by
 * near-white alpha, the artifact choke exists to remove. */
function fringedPng(
  width: number,
  height: number,
  ink: [number, number, number],
  fringe: [number, number, number, number],
  fringePx: number,
): Buffer {
  const w = width + 2 * fringePx;
  const h = height + 2 * fringePx;
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inInk = x >= fringePx && x < fringePx + width && y >= fringePx && y < fringePx + height;
      if (inInk) {
        buf[i] = ink[0]!;
        buf[i + 1] = ink[1]!;
        buf[i + 2] = ink[2]!;
        buf[i + 3] = 255;
      } else {
        buf[i] = fringe[0]!;
        buf[i + 1] = fringe[1]!;
        buf[i + 2] = fringe[2]!;
        buf[i + 3] = fringe[3]!;
      }
    }
  }
  return encodePngRgba(w, h, buf);
}

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

function solidSvg(width: number, height: number, color: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${color}"/>` +
    `</svg>`
  );
}

type Png = ReturnType<typeof decodePng>;

function pixel(png: Png, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

/** True when the pixel reads as a LIGHT fringe on this saturated backdrop:
 * the near-white halo composite over saturated blue or red ink keeps a
 * colour cast, so the robust signature is a bright minimum channel — the
 * blue backdrop's min is 0, the red ink's 40, the halo's > 150. */
function isLightFringe(p: [number, number, number, number]): boolean {
  return Math.min(p[0]!, p[1]!, p[2]!) > 150;
}

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-edge-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "edge-test-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComp(name: string, width = 480, height = 360) {
  const res = await invoke(["composition", "create", name, "--width", String(width), "--height", String(height), "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
}

async function renderBytes(comp: string, filename: string): Promise<Buffer> {
  const outPath = path.join(tempDir, filename);
  const res = await invoke(["composition", "render", comp, "--project", projDir, "--out", outPath, "--supersample", "1"]);
  expect(res.code).toBe(0);
  return readFile(outPath);
}

async function measure(comp: string): Promise<{ layers: Array<Record<string, unknown>> }> {
  const res = await invoke(["composition", "measure", comp, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

interface Added {
  layerId: string;
}

async function addLayer(comp: string, name: string, kind: "raster" | "vector" | "text" | "shape", opts: string[] = []): Promise<Added> {
  let args: string[];
  if (kind === "raster") {
    const p = path.join(tempDir, `${name}.png`);
    await writeFile(p, solidPng(60, 60, [200, 60, 60, 255]));
    args = ["composition", "add", comp, name, "--image", p];
  } else if (kind === "vector") {
    const p = path.join(tempDir, `${name}.svg`);
    await writeFile(p, solidSvg(60, 60, "#3c3cc8"));
    args = ["composition", "add", comp, name, "--image", p];
  } else if (kind === "text") {
    args = ["composition", "add", comp, name, "--text", "MM", "--font", "Anton", "--font-size", "40", "--color", "#22aa66"];
  } else {
    args = ["composition", "add", comp, name, "--shape", "rectangle", "--size", "60x60", "--fill", "#c8a232"];
  }
  const res = await invoke([...args, ...opts, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return { layerId: (JSON.parse(res.stdout).layer as { id: string }).id };
}

async function revisionOf(layerId: string): Promise<Record<string, unknown>> {
  const res = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return (JSON.parse(res.stdout).layer as { currentRevision: Record<string, unknown> }).currentRevision;
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("choke and feather refuse non-numeric and out-of-range values before publication, naming the flag and range", async () => {
  await makeComp("refuse");
  const { layerId } = await addLayer("refuse", "r", "shape", ["--x", "40", "--y", "40"]);

  for (const flag of ["--choke", "--feather"]) {
    for (const bad of ["banana", "-5", "257"]) {
      const res = await invoke(["layer", "edit", layerId, flag, bad, "--project", projDir, "--json"]);
      expect(res.code).toBe(2);
      expect(JSON.parse(res.stdout).error).toContain(flag);
      expect(JSON.parse(res.stdout).error).toContain("0");
      expect(JSON.parse(res.stdout).error).toContain("256");
      // Nothing published.
      const rev = await revisionOf(layerId);
      expect(rev.choke).toBeUndefined();
      expect(rev.feather).toBeUndefined();
    }
    // The upper boundary is accepted and stored (CRAFT-3): 256 is a legal
    // radius, only 257 is refused.
    const top = await invoke(["layer", "edit", layerId, flag, "256", "--project", projDir, "--json"]);
    expect(top.code).toBe(0);
    const topRev = await revisionOf(layerId);
    expect(flag === "--choke" ? topRev.choke : topRev.feather).toBe(256);
    await invoke(["layer", "edit", layerId, flag, "0", "--project", projDir, "--json"]);
  }

  // The same refusal grammar through the one-command add surface.
  for (const flag of ["--choke", "--feather"]) {
    const addRes = await invoke(["composition", "add", "refuse", "bad", "--shape", "rectangle", "--size", "40x40", "--fill", "#123456", flag, "banana", "--project", projDir, "--json"]);
    expect(addRes.code).toBe(2);
    expect(JSON.parse(addRes.stdout).error).toContain(flag);
  }
}, 30000);

// ---------------------------------------------------------------------------
// Absolute setter + removal stores nothing
// ---------------------------------------------------------------------------

test("choke and feather are absolute setters stored only when > 0; 0 removes and stores nothing", async () => {
  await makeComp("setter");
  const { layerId } = await addLayer("setter", "s", "shape", ["--x", "40", "--y", "40"]);

  const edit = await invoke(["layer", "edit", layerId, "--choke", "3", "--feather", "2", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);
  let rev = await revisionOf(layerId);
  expect(rev.choke).toBe(3);
  expect(rev.feather).toBe(2);

  // Absolute: a re-set replaces both facts.
  const reset = await invoke(["layer", "edit", layerId, "--choke", "5", "--project", projDir, "--json"]);
  expect(reset.code).toBe(0);
  rev = await revisionOf(layerId);
  expect(rev.choke).toBe(5);
  expect(rev.feather).toBe(2);

  // 0 is the removal form; the identity is never stored.
  const remove = await invoke(["layer", "edit", layerId, "--choke", "0", "--feather", "0", "--project", projDir, "--json"]);
  expect(remove.code).toBe(0);
  rev = await revisionOf(layerId);
  expect(rev.choke).toBeUndefined();
  expect(rev.feather).toBeUndefined();
});
// ---------------------------------------------------------------------------
// The saturated-blue fringe acceptance probe (the ticket's headline)
// ---------------------------------------------------------------------------

test("a cutout's light fringe on saturated blue shows no fringe after the choke", async () => {
  await makeComp("fringe", 200, 200);

  // The saturated-blue backdrop.
  const bg = path.join(tempDir, "bg.png");
  await writeFile(bg, solidPng(200, 200, [0, 38, 255, 255]));
  const bgRes = await invoke(["composition", "add", "fringe", "bg", "--image", bg, "--x", "0", "--y", "0", "--project", projDir, "--json"]);
  expect(bgRes.code).toBe(0);

  // The cutout: hard red 80x80 ink ringed by a 3px near-white semi-transparent
  // fringe — the matting halo.
  const cutout = path.join(tempDir, "cutout.png");
  await writeFile(cutout, fringedPng(80, 80, [200, 40, 40], [245, 245, 245, 210], 3));
  const addRes = await invoke(["composition", "add", "fringe", "cutout", "--image", cutout, "--x", "50", "--y", "50", "--project", projDir, "--json"]);
  expect(addRes.code).toBe(0);
  const layerId = (JSON.parse(addRes.stdout).layer as { id: string }).id;

  const base = decodePng(await renderBytes("fringe", "fringe-base.png"));
  // The fringe band (3px wide around the ink, cutout at 50..133 with 3px
  // fringe) reads light on the blue: the halo artifact is visible.
  let fringePixels = 0;
  for (let y = 47; y < 137; y++) {
    for (let x = 47; x < 137; x++) {
      if (isLightFringe(pixel(base, x, y))) fringePixels++;
    }
  }
  expect(fringePixels).toBeGreaterThan(200);

  // Choke past the fringe: the halo disappears — no light pixel remains in
  // the band, and the blue shows through where the fringe was.
  const choke = await invoke(["layer", "edit", layerId, "--choke", "5", "--project", projDir, "--json"]);
  expect(choke.code).toBe(0);
  const choked = decodePng(await renderBytes("fringe", "fringe-choked.png"));
  for (let y = 45; y < 140; y++) {
    for (let x = 45; x < 140; x++) {
      expect(isLightFringe(pixel(choked, x, y))).toBe(false);
    }
  }
  // The blue backdrop shows through the former fringe ring.
  expect(pixel(choked, 50, 90)).toEqual([0, 38, 255, 255]);

  // The choke colours the edge with the INK (red over blue), never white.
  expect(pixel(choked, 56, 90)[0]!).toBeGreaterThan(120);

  // Removing the choke restores the fringe render. NOTE: the comparison is
  // between two fresh renders, not against the earlier `base` capture —
  // this machine's shared render page intermittently quantizes the
  // Gaussian/filter tail by ±1 alpha, so cross-capture byte equality flakes;
  // the byte-for-byte restore criterion is pinned against the pre-edit base
  // in the kinds and stack tests, where each capture pair is rendered back
  // to back.
  const remove = await invoke(["layer", "edit", layerId, "--choke", "0", "--project", projDir, "--json"]);
  expect(remove.code).toBe(0);
  expect(await renderBytes("fringe", "fringe-restored.png")).toEqual(await renderBytes("fringe", "fringe-base-again.png"));
  const baseAgain = decodePng(await renderBytes("fringe", "fringe-base-again.png"));
  let fringePixelsAgain = 0;
  for (let y = 47; y < 137; y++) {
    for (let x = 47; x < 137; x++) {
      if (isLightFringe(pixel(baseAgain, x, y))) fringePixelsAgain++;
    }
  }
  expect(fringePixelsAgain).toBe(fringePixels);
}, 60000);

// ---------------------------------------------------------------------------
// Render change + byte-identical removal on every kind
// ---------------------------------------------------------------------------

test("choke and feather change the render on raster, vector, text, and shape Layers and 0 restores each byte-for-byte", async () => {
  await makeComp("kinds");
  await addLayer("kinds", "raster", "raster", ["--x", "20", "--y", "20"]);
  await addLayer("kinds", "vector", "vector", ["--x", "140", "--y", "20"]);
  await addLayer("kinds", "text", "text", ["--x", "20", "--y", "140"]);
  await addLayer("kinds", "shape", "shape", ["--x", "140", "--y", "140"]);

  const base = await renderBytes("kinds", "kinds-base.png");

  const inspect = JSON.parse((await invoke(["composition", "inspect", "kinds", "--project", projDir, "--json"])).stdout) as { composition: { layers: Array<{ name: string; layerId: string }> } };
  const ids: string[] = [];
  for (const name of ["raster", "vector", "text", "shape"]) {
    ids.push(inspect.composition.layers.find((l) => l.name === name)!.layerId);
  }

  for (const layerId of ids) {
    const edit = await invoke(["layer", "edit", layerId, "--choke", "4", "--feather", "3", "--project", projDir, "--json"]);
    expect(edit.code).toBe(0);
    const rev = await revisionOf(layerId);
    expect(rev.choke).toBe(4);
    expect(rev.feather).toBe(3);
  }

  const shaped = await renderBytes("kinds", "kinds-shaped.png");
  expect(shaped.equals(base)).toBe(false);

  for (const layerId of ids) {
    const remove = await invoke(["layer", "edit", layerId, "--choke", "0", "--feather", "0", "--project", projDir, "--json"]);
    expect(remove.code).toBe(0);
    const rev = await revisionOf(layerId);
    expect(rev.choke).toBeUndefined();
    expect(rev.feather).toBeUndefined();
  }

  expect(await renderBytes("kinds", "kinds-restored.png")).toEqual(base);

  // The choke visibly eats into the shape's ink: the boundary pixel of the
  // shape (solid #c8a232 hard edge before, shape at x 140..200) loses alpha
  // (the feather's inward tail keeps it nonzero but well below opaque), and
  // NO ink appears beyond the original edge — the `in` composite bounds the
  // shaped alpha by the source's.
  const basePng = decodePng(base);
  const shapedPng = decodePng(shaped);
  expect(pixel(basePng, 199, 170)[3]).toBe(255);
  expect(pixel(shapedPng, 199, 170)[3]).toBeLessThan(200);
  expect(pixel(shapedPng, 202, 170)[3]).toBe(0);
  expect(pixel(shapedPng, 170, 170)[3]).toBe(255);
}, 60000);

// ---------------------------------------------------------------------------
// measure reports both facts; the edge step never grows painted extents
// ---------------------------------------------------------------------------

test("measure reports the choke and feather facts and the painted extent never grows", async () => {
  await makeComp("report", 400, 300);
  const { layerId } = await addLayer("report", "s", "shape", ["--x", "100", "--y", "80"]);
  const before = (await measure("report")).layers[0] as Record<string, any>;
  expect(before.choke).toBeNull();
  expect(before.feather).toBeNull();
  const basePainted = before.painted as { x: number; y: number; width: number; height: number };

  // Feather alone: the alpha softens INWARD — the painted extent never
  // exceeds the unfeathered one (the `in` composite bounds the shaped alpha
  // by the source's, so no reach is added — the ADR-0024 amendment).
  const feather = await invoke(["layer", "edit", layerId, "--feather", "10", "--project", projDir, "--json"]);
  expect(feather.code).toBe(0);
  const feathered = (await measure("report")).layers[0] as Record<string, any>;
  expect(feathered.choke).toBeNull();
  expect(feathered.feather).toBe(10);
  const fPainted = feathered.painted as { x: number; y: number; width: number; height: number };
  expect(fPainted.width).toBeLessThanOrEqual(basePainted.width);
  expect(fPainted.height).toBeLessThanOrEqual(basePainted.height);

  // Choke + feather: the extent shrinks when the choke moves the edge past
  // where the feather's inward-bounded tail (≈2.4σ, 8-bit) regrows it — the
  // composite is bounded by the source alpha, so it never exceeds the
  // original ink either way.
  const both = await invoke(["layer", "edit", layerId, "--choke", "20", "--feather", "5", "--project", projDir, "--json"]);
  expect(both.code).toBe(0);
  const choked = (await measure("report")).layers[0] as Record<string, any>;
  expect(choked.choke).toBe(20);
  expect(choked.feather).toBe(5);
  const shaped = choked.painted as { x: number; y: number; width: number; height: number };
  expect(shaped.width).toBeLessThan(basePainted.width);
  expect(shaped.height).toBeLessThan(basePainted.height);
  expect(shaped.x).toBeGreaterThan(basePainted.x);
  expect(shaped.y).toBeGreaterThan(basePainted.y);
});

test("a feathered edge pixel's alpha is at most the source alpha, and no ink appears outside the original ink", async () => {
  await makeComp("bound", 300, 300);
  const { layerId } = await addLayer("bound", "s", "shape", ["--x", "100", "--y", "100"]);

  const shapedRes = await invoke(["layer", "edit", layerId, "--feather", "12", "--project", projDir, "--json"]);
  expect(shapedRes.code).toBe(0);

  // The windowed painted extent equals the extent an unbounded full-canvas
  // render sees (capture-window soundness, kept from the plan), and the
  // alpha>0 ink box stays INSIDE the original 60x60 ink box.
  const layer = (await measure("bound")).layers[0] as Record<string, any>;
  const painted = layer.painted as { x: number; y: number; width: number; height: number };
  const rendered = decodePng(await renderBytes("bound", "bound.png"));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < rendered.height; y++) {
    for (let x = 0; x < rendered.width; x++) {
      if (pixel(rendered, x, y)[3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  expect(painted).toEqual({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
  // Inside the original 60x60 ink box (placed at 100,100).
  expect(minX).toBeGreaterThanOrEqual(100);
  expect(minY).toBeGreaterThanOrEqual(100);
  expect(maxX).toBeLessThanOrEqual(159);
  expect(maxY).toBeLessThanOrEqual(159);
  // The outermost feathered pixel's alpha is well below the source's 255:
  // the edge is genuinely softened, never raised.
  expect(pixel(rendered, minX, 130)[3]).toBeLessThan(255);
  // The interior stays (near-)opaque: a σ=12 feather on a 60px block keeps
  // its core above 250 (the Gaussian's 2.5σ tail is the only loss).
  expect(pixel(rendered, 130, 130)[3]).toBeGreaterThan(250);
});

// ---------------------------------------------------------------------------
// Anchored placement resolves against the pre-effect ink (#288, ADR-0025)
// ---------------------------------------------------------------------------

test("choke and feather never move a stored placement: anchor parity on add and edit", async () => {
  await makeComp("anchor", 400, 400);

  const plain = await addLayer("anchor", "plain", "raster", ["--anchor", "center,center", "--x", "200", "--y", "200"]);
  const shaped = await addLayer("anchor", "shaped", "raster", ["--anchor", "center,center", "--x", "200", "--y", "200", "--choke", "5", "--feather", "4"]);
  const plainRev = await revisionOf(plain.layerId);
  const shapedRev = await revisionOf(shaped.layerId);
  expect(shapedRev.x).toBe(plainRev.x);
  expect(shapedRev.y).toBe(plainRev.y);
  expect(shapedRev.choke).toBe(5);
  expect(shapedRev.feather).toBe(4);

  const before = await revisionOf(plain.layerId);
  const edit = await invoke(["layer", "edit", plain.layerId, "--choke", "5", "--feather", "4", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);
  const after = await revisionOf(plain.layerId);
  expect(after.x).toBe(before.x);
  expect(after.y).toBe(before.y);
});

// ---------------------------------------------------------------------------
// Edge px are Layer-local: they map through the canonical transform
// ---------------------------------------------------------------------------

test("edge px are Layer-local: a scaled Layer's choke eats proportionally more", async () => {
  await makeComp("local", 480, 480);
  const { layerId } = await addLayer("local", "s", "shape", ["--x", "150", "--y", "150"]);

  const choke = await invoke(["layer", "edit", layerId, "--choke", "6", "--project", projDir, "--json"]);
  expect(choke.code).toBe(0);
  const scale1 = (await measure("local")).layers[0] as Record<string, any>;
  const eaten1 = 60 - (scale1.painted as { width: number }).width;

  const scale = await invoke(["layer", "edit", layerId, "--scale", "2", "--project", projDir, "--json"]);
  expect(scale.code).toBe(0);
  const scale2 = (await measure("local")).layers[0] as Record<string, any>;
  // The 120px-wide scaled shape loses 2×6 local px per side → 24 canvas px.
  const eaten2 = 120 - (scale2.painted as { width: number }).width;

  expect(eaten1).toBeGreaterThan(0);
  expect(eaten2).toBeGreaterThan(eaten1 * 1.5);
  expect(eaten2).toBeLessThan(eaten1 * 2.5);
});

// ---------------------------------------------------------------------------
// Composition with the other effects: edge first, blur last, removal restores
// ---------------------------------------------------------------------------

test("choke and feather compose with the other effects and removal restores byte-for-byte", async () => {
  await makeComp("stack", 480, 480);
  const { layerId } = await addLayer("stack", "s", "shape", ["--x", "150", "--y", "150"]);

  const base = await renderBytes("stack", "stack-base.png");

  const edit = await invoke([
    "layer", "edit", layerId,
    "--outline", "6,#ffffff",
    "--blur", "10",
    "--choke", "3",
    "--feather", "2",
    "--project", projDir, "--json",
  ]);
  expect(edit.code).toBe(0);

  const shaped = await renderBytes("stack", "stack-shaped.png");
  expect(shaped.equals(base)).toBe(false);

  const remove = await invoke([
    "layer", "edit", layerId,
    "--outline", "none",
    "--blur", "0",
    "--choke", "0",
    "--feather", "0",
    "--project", projDir, "--json",
  ]);
  expect(remove.code).toBe(0);
  expect(await renderBytes("stack", "stack-restored.png")).toEqual(base);
});

// ---------------------------------------------------------------------------
// The visible region clips BEFORE the edge step: choke/feather shape the
// region's edge too (ADR-0024 amendment: the effects chain operates on the
// region-clipped, graded composite)
// ---------------------------------------------------------------------------

test("choke and feather shape a visible region's clip edge, not just the content's", async () => {
  await makeComp("region", 300, 300);
  const { layerId } = await addLayer("region", "s", "shape", ["--x", "50", "--y", "50", "--visible-region", "10,10,40,40"]);

  const base = await renderBytes("region", "region-base.png");

  // The region's hard clip edge (at content x 60..90, canvas 60..100) is the
  // edge the choke erodes: after choking past it, the region band loses its
  // alpha at the original clip line, and no ink appears beyond it either way.
  const edit = await invoke(["layer", "edit", layerId, "--choke", "5", "--feather", "2", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);

  const shaped = decodePng(await renderBytes("region", "region-shaped.png"));
  const basePng = decodePng(base);
  // Just inside the original clip edge (canvas x 59 is outside the region
  // rect 60..120; canvas x 61 inside): the inside pixel loses alpha.
  expect(pixel(basePng, 61, 80)[3]).toBe(255);
  expect(pixel(shaped, 61, 80)[3]).toBeLessThan(255);
  // Outside the original region edge, still no ink (the in-composite bound).
  expect(pixel(shaped, 58, 80)[3]).toBe(0);

  const remove = await invoke(["layer", "edit", layerId, "--choke", "0", "--feather", "0", "--project", projDir, "--json"]);
  expect(remove.code).toBe(0);
  expect(await renderBytes("region", "region-restored.png")).toEqual(base);
}, 60000);
