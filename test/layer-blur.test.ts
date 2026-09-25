/**
 * Layer blur (#299, spec #285 US-010, DEC-005, DEC-006, TEST-001/002/003,
 * ADR-0024 amendment).
 *
 * Verifies through the public CLI and rendered-pixel seams:
 * - `--blur <px>` is an absolute Layer revision fact on raster, vector, text,
 *   and shape Layers: a Gaussian defocus painted as the LAST function of the
 *   outer element's effects filter chain (glow → outline → shadow → blur), so
 *   the whole Layer look reads out of focus.
 * - Stored only when > 0; `--blur 0` is the documented removal form. Removing
 *   the blur restores the render byte-for-byte.
 * - Refusal before publication for non-numeric or out-of-range values (0..256
 *   px), naming the flag and its range.
 * - `measure` reports the blur and the grown painted extent. The blur px are
 *   Layer-local: they map through the canonical transform like the other
 *   effects, so a scaled Layer's blur grows with the scale.
 * - Capture-window soundness (the reach margin): Chrome's Gaussian kernel
 *   reaches ~3σ with σ = the blur radius, so the painted extent of a blurred
 *   Layer measured through the reach-sized capture window must equal the
 *   extent measured from an independent full-canvas render (an unbounded
 *   margin) — a too-small margin would clip the visible tail.
 * - Anchored placement resolves against the pre-effect ink (#288, ADR-0025):
 *   the blur never moves a stored placement, on add or on edit.
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

/** The alpha>0 ink box of a rendered PNG, in canvas coordinates. */
function inkBox(png: Png): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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
  return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-blur-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "blur-test-proj"]);
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

async function renderComp(comp: string, filename: string): Promise<Png> {
  const outPath = path.join(tempDir, filename);
  const res = await invoke(["composition", "render", comp, "--project", projDir, "--out", outPath, "--supersample", "1"]);
  expect(res.code).toBe(0);
  return decodePng(await readFile(outPath));
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

test("blur refuses non-numeric and out-of-range values before publication, naming the flag and range", async () => {
  await makeComp("refuse");
  const { layerId } = await addLayer("refuse", "r", "shape", ["--x", "40", "--y", "40"]);

  for (const bad of ["banana", "-5", "257"]) {
    const res = await invoke(["layer", "edit", layerId, "--blur", bad, "--project", projDir, "--json"]);
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout).error).toContain("--blur");
    expect(JSON.parse(res.stdout).error).toContain("0");
    expect(JSON.parse(res.stdout).error).toContain("256");
    // Nothing published.
    const rev = await revisionOf(layerId);
    expect(rev.blur).toBeUndefined();
  }

  // The same refusal grammar through the one-command add surface.
  const addRes = await invoke(["composition", "add", "refuse", "bad", "--shape", "rectangle", "--size", "40x40", "--fill", "#123456", "--blur", "banana", "--project", projDir, "--json"]);
  expect(addRes.code).toBe(2);
  expect(JSON.parse(addRes.stdout).error).toContain("--blur");
});

// ---------------------------------------------------------------------------
// Render change + byte-identical removal on every kind
// ---------------------------------------------------------------------------

test("blur changes the render on raster, vector, text, and shape Layers and --blur 0 restores each byte-for-byte", async () => {
  await makeComp("kinds");
  await addLayer("kinds", "raster", "raster", ["--x", "20", "--y", "20"]);
  await addLayer("kinds", "vector", "vector", ["--x", "140", "--y", "20"]);
  await addLayer("kinds", "text", "text", ["--x", "20", "--y", "140"]);
  await addLayer("kinds", "shape", "shape", ["--x", "140", "--y", "140"]);

  const base = await renderBytes("kinds", "kinds-base.png");

  const inspect = JSON.parse((await invoke(["composition", "inspect", "kinds", "--project", projDir, "--json"])).stdout) as { composition: { layers: Array<{ name: string; layerId: string }> } };
  const ids: string[] = [];
  for (const name of ["raster", "vector", "text", "shape"]) {
    const entry = inspect.composition.layers.find((l) => l.name === name)!;
    ids.push(entry.layerId);
  }

  for (const layerId of ids) {
    const edit = await invoke(["layer", "edit", layerId, "--blur", "8", "--project", projDir, "--json"]);
    expect(edit.code).toBe(0);
    const rev = await revisionOf(layerId);
    expect(rev.blur).toBe(8);
  }

  const blurred = await renderBytes("kinds", "kinds-blurred.png");
  expect(blurred.equals(base)).toBe(false);

  for (const layerId of ids) {
    const remove = await invoke(["layer", "edit", layerId, "--blur", "0", "--project", projDir, "--json"]);
    expect(remove.code).toBe(0);
    const rev = await revisionOf(layerId);
    expect(rev.blur).toBeUndefined();
  }

  const restored = await renderBytes("kinds", "kinds-restored.png");
  expect(restored.equals(base)).toBe(true);

  // The blurred render genuinely softens: the ink edge pixel of the shape
  // (solid #c8a232 hard edge before) loses alpha at the boundary.
  const basePng = decodePng(base);
  const blurredPng = decodePng(blurred);
  // Just outside the shape's right edge (shape at x 140..200, y 140..200).
  expect(pixel(basePng, 202, 170)[3]).toBe(0);
  expect(pixel(blurredPng, 202, 170)[3]).toBeGreaterThan(0);
  // And the interior stays opaque.
  expect(pixel(blurredPng, 170, 170)[3]).toBe(255);
}, 60000);

// ---------------------------------------------------------------------------
// measure reports the blur and the grown painted extent
// ---------------------------------------------------------------------------

test("measure reports the blur fact and the grown painted extent", async () => {
  await makeComp("report", 400, 300);
  const { layerId } = await addLayer("report", "s", "shape", ["--x", "100", "--y", "80"]);
  const before = (await measure("report")).layers[0] as Record<string, any>;
  expect(before.blur).toBeNull();
  const basePainted = before.painted as { x: number; y: number; width: number; height: number };

  const edit = await invoke(["layer", "edit", layerId, "--blur", "10", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);

  const after = (await measure("report")).layers[0] as Record<string, any>;
  expect(after.blur).toBe(10);
  const painted = after.painted as { x: number; y: number; width: number; height: number };
  expect(painted.width).toBeGreaterThan(basePainted.width);
  expect(painted.height).toBeGreaterThan(basePainted.height);
  // Grown on every side (the defocus spreads in every direction).
  expect(painted.x).toBeLessThan(basePainted.x);
  expect(painted.y).toBeLessThan(basePainted.y);
});

// ---------------------------------------------------------------------------
// Capture-window soundness: the reach margin never clips the visible tail
// ---------------------------------------------------------------------------

test("the painted extent of a blurred Layer equals the extent an unbounded capture margin sees", async () => {
  // The measure capture window is sized from the ONE effect-reach reader.
  // An independent full-canvas render has no per-Layer window at all, so if
  // the reach margin under-sized the window the two would disagree (the
  // windowed extent would clip the Gaussian tail the render shows).
  await makeComp("noclip", 400, 400);
  const { layerId } = await addLayer("noclip", "s", "shape", ["--x", "170", "--y", "170"]);

  const blurPx = 12;
  const edit = await invoke(["layer", "edit", layerId, "--blur", String(blurPx), "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);

  const layer = (await measure("noclip")).layers[0] as Record<string, any>;
  const painted = layer.painted as { x: number; y: number; width: number; height: number };
  const rendered = await renderComp("noclip", "noclip.png");
  const renderInk = inkBox(rendered)!;

  // No clipping: the windowed measure sees exactly what the unbounded
  // render paints.
  expect(painted).toEqual(renderInk);

  // The growth pins the margin relationship: the rendered alpha>0 ink
  // reaches ~2.4σ per side (8-bit alpha rounds the Gaussian tail to 0
  // before 3σ), so a 2× capture margin WOULD clip the visible extent — the
  // ceiled 3× kernel reach does not, which the equality above proves.
  const growthPerSide = (painted.width - 60) / 2;
  expect(growthPerSide).toBeGreaterThan(blurPx * 2);
  expect(growthPerSide).toBeLessThanOrEqual(blurPx * 3 + 1);
});

// ---------------------------------------------------------------------------
// Anchored placement resolves against the pre-effect ink (#288, ADR-0025)
// ---------------------------------------------------------------------------

test("the blur never moves a stored placement: anchor parity on add and edit", async () => {
  await makeComp("anchor", 400, 400);

  // Same anchor through add, with and without the blur: same stored placement.
  const plain = await addLayer("anchor", "plain", "raster", ["--anchor", "center,center", "--x", "200", "--y", "200"]);
  const blurred = await addLayer("anchor", "blurred", "raster", ["--anchor", "center,center", "--x", "200", "--y", "200", "--blur", "12"]);
  const plainRev = await revisionOf(plain.layerId);
  const blurredRev = await revisionOf(blurred.layerId);
  expect(blurredRev.x).toBe(plainRev.x);
  expect(blurredRev.y).toBe(plainRev.y);
  expect(blurredRev.blur).toBe(12);

  // And an edit-time blur never moves an anchored placement.
  const before = await revisionOf(plain.layerId);
  const edit = await invoke(["layer", "edit", plain.layerId, "--blur", "12", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);
  const after = await revisionOf(plain.layerId);
  expect(after.x).toBe(before.x);
  expect(after.y).toBe(before.y);
});

// ---------------------------------------------------------------------------
// Blur px are Layer-local: they map through the canonical transform
// ---------------------------------------------------------------------------

test("blur px are Layer-local: a scaled Layer's defocus grows with the scale", async () => {
  await makeComp("local", 480, 480);
  const { layerId } = await addLayer("local", "s", "shape", ["--x", "150", "--y", "150"]);

  const edit = await invoke(["layer", "edit", layerId, "--blur", "10", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);
  const scale1 = (await measure("local")).layers[0] as Record<string, any>;
  const g1 = ((scale1.painted as { width: number }).width - 60) / 2;

  const scale = await invoke(["layer", "edit", layerId, "--scale", "2", "--project", projDir, "--json"]);
  expect(scale.code).toBe(0);
  const scale2 = (await measure("local")).layers[0] as Record<string, any>;
  const g2 = ((scale2.painted as { width: number }).width - 120) / 2;

  // The blur is painted in the Layer's local space (the effects filter chain
  // sits under the transform), so doubling the scale doubles the defocus
  // reach in canvas px.
  expect(g2).toBeGreaterThan(g1 * 1.8);
  expect(g2).toBeLessThan(g1 * 2.2);
});

// ---------------------------------------------------------------------------
// Composition with the other effects: additive reach, blur last in the chain
// ---------------------------------------------------------------------------

test("blur composes with the other effects: the painted extent grows additively and removal restores", async () => {
  await makeComp("stack", 480, 480);
  const { layerId } = await addLayer("stack", "s", "shape", ["--x", "150", "--y", "150"]);

  const base = await renderBytes("stack", "stack-base.png");

  // Outline dilates exactly `width` px per side; the blur adds its kernel
  // reach on top (the effects chain is additive, ADR-0019 ordering).
  const outlineW = 6;
  const blurPx = 10;
  const edit = await invoke([
    "layer", "edit", layerId,
    "--outline", `${outlineW},#ffffff`,
    "--blur", String(blurPx),
    "--project", projDir, "--json",
  ]);
  expect(edit.code).toBe(0);

  const layer = (await measure("stack")).layers[0] as Record<string, any>;
  const painted = layer.painted as { width: number };
  const growthPerSide = (painted.width - 60) / 2;
  // The outline dilates exactly `width` px; the blur's visible tail adds
  // between 2σ and the 3σ capture margin (see the no-clip test above).
  expect(growthPerSide).toBeGreaterThanOrEqual(outlineW + blurPx * 2);
  expect(growthPerSide).toBeLessThanOrEqual(outlineW + blurPx * 3 + 1);

  // Removal of both restores the render byte-for-byte.
  const remove = await invoke([
    "layer", "edit", layerId,
    "--outline", "none",
    "--blur", "0",
    "--project", projDir, "--json",
  ]);
  expect(remove.code).toBe(0);
  const restored = await renderBytes("stack", "stack-restored.png");
  expect(restored.equals(base)).toBe(true);
});
// ---------------------------------------------------------------------------
// The blur reaches the divergent-perspective publication gate (INT-1)
// ---------------------------------------------------------------------------

test("a tilt that publishes without blur is refused once the blur is added", async () => {
  await makeComp("gate", 400, 400);
  // The gate depth is exact: max |sin(tiltX)·qy| over the content box plus
  // the local reach's depth contribution. A 100x2300 shape tilted 60° about
  // X reaches 0.866·1150 ≈ 995.9px of the 1000px perspective distance — it
  // publishes. The blur's ceiled 3× kernel reach (18px for radius 6) adds
  // ≈15.6px of depth — past 1000, the projection diverges and the edit must
  // refuse before anything stages.
  const p = path.join(tempDir, "gate-shape.png");
  void p;
  const add = await invoke([
    "composition", "add", "gate", "tall",
    "--shape", "rectangle", "--size", "100x2300", "--fill", "#345678",
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const layerId = (JSON.parse(add.stdout).layer as { id: string }).id;

  const tilt = await invoke(["layer", "edit", layerId, "--perspective", "60x0", "--project", projDir, "--json"]);
  expect(tilt.code).toBe(0);
  expect((await revisionOf(layerId)).perspectiveTiltXDeg).toBe(60);

  const blur = await invoke(["layer", "edit", layerId, "--blur", "6", "--project", projDir, "--json"]);
  expect(blur.code).toBe(1);
  const err = JSON.parse(blur.stdout).error as string;
  expect(err).toContain("effect extent");
  expect(err).toContain("perspective distance");
  // Nothing published: the blurred revision never stages.
  const rev = await revisionOf(layerId);
  expect(rev.blur).toBeUndefined();
  expect(rev.perspectiveTiltXDeg).toBe(60);
}, 30000);
