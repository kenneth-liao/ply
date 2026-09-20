/**
 * Gradient fills for shape Layers (#210, spec #207 US-001 gradient part,
 * DEC-003/009/010): the fill union's `linear` and `radial` variants join the
 * ONE fill representation at the ONE ingestion point (src/fill.ts) — a fill
 * is one discriminated value gradient text can reuse later, never a
 * shape-specific second form.
 *
 * Grammar (DEC-009, settled in src/fill.ts): `--fill` takes a solid hex
 * color (as in #208), `linear:<angle>deg,<stop>,<stop>[,...]`, or
 * `radial:<stop>,<stop>[,...]`; a stop is `<color>` or `<color>:<position>`
 * (0–100 percent, the % optional). Fewer than two stops, an out-of-range
 * position, a decreasing stop list, or a malformed colour is refused before
 * anything is published, naming the fault; live state is unchanged.
 *
 * TEST-001/002/006/007: external behaviour at the CLI and rendered-pixel
 * seams the shape-layer / composition-measure / render-history tests already
 * use — run the command, assert the JSON result and refusal text, render,
 * and assert pixels. Per-file `bun test --isolate`, offline.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { decodePng, encodePngRgba } from "../src/png.js";

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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-gradient-fill-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "gradient-proj"]);
  await invoke([
    "composition", "create", "poster", "--width", "200", "--height", "120", "--project", projDir,
  ]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function pixel(
  png: ReturnType<typeof decodePng>,
  x: number,
  y: number,
): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

const close = (a: number, b: number, tol = 3) => Math.abs(a - b) <= tol;

const expectPixel = (
  png: ReturnType<typeof decodePng>,
  x: number,
  y: number,
  rgba: readonly number[],
  tol = 3,
) => {
  const p = pixel(png, x, y);
  expect(p.every((v, i) => close(v, rgba[i]!, tol))).toBe(true);
};

/** The channel value CSS sRGB interpolation predicts at fraction `f` of the
 *  gradient line between two opaque hex colours (the rendered-pixel seam's
 *  expectation, computed — never eyeballed). */
function lerp(a: number, b: number, f: number): number {
  return Math.round(a + (b - a) * f);
}

/** The unpremultiplied RGBA a browser shows at interpolation fraction `t`
 *  between two colour stops: CSS gradients interpolate premultiplied, so a
 *  semi-transparent stop's colour contribution is weighted by its alpha. */
function lerpStops(
  c1: readonly [number, number, number, number],
  c2: readonly [number, number, number, number],
  t: number,
): [number, number, number, number] {
  const p = (c: readonly number[], i: number) => (c[i]! * c[3]!) / 255;
  const alpha = Math.round(c1[3]! + (c2[3]! - c1[3]!) * t);
  if (alpha <= 0) return [0, 0, 0, 0];
  const rgb = [0, 1, 2].map((i) =>
    Math.round(((p(c1, i) + (p(c2, i) - p(c1, i)) * t) / alpha) * 255),
  );
  return [rgb[0]!, rgb[1]!, rgb[2]!, alpha];
}

/** A colour stop's channels plus its position (0–100) on the gradient line. */
interface RadialStop {
  rgba: [number, number, number, number];
  position: number;
}

/** The RGBA a `circle farthest-side at center` radial gradient shows at a
 *  pixel (its centre is sampled): the premultiplied stop interpolation at
 *  the pixel's distance from the box centre over the radius — computed, not
 *  eyeballed. */
function radialExpectation(
  x: number,
  y: number,
  cx: number,
  cy: number,
  radius: number,
  stops: RadialStop[],
): [number, number, number, number] {
  const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  const percent = Math.min(100, (d / radius) * 100);
  let lo = stops[0]!;
  let hi = stops[stops.length - 1]!;
  for (let i = 0; i < stops.length - 1; i++) {
    if (percent >= stops[i]!.position && percent <= stops[i + 1]!.position) {
      lo = stops[i]!;
      hi = stops[i + 1]!;
      break;
    }
  }
  const span = hi.position - lo.position;
  return lerpStops(lo.rgba, hi.rgba, span === 0 ? 0 : (percent - lo.position) / span);
}

async function renderPng(comp: string): Promise<ReturnType<typeof decodePng>> {
  const render = await invoke(["composition", "render", comp, "--project", projDir, "--json"]);
  expect(render.code).toBe(0);
  const out = JSON.parse(render.stdout).render.output as string;
  return decodePng(await readFile(out));
}

async function addShape(name: string, fill: string, size: string, x: string, y: string) {
  const res = await invoke([
    "composition", "add", "poster", name,
    "--shape", "rectangle", "--size", size, "--fill", fill, "--x", x, "--y", y,
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

// ---------------------------------------------------------------------------
// Linear gradients render their stop colours at their endpoints (TEST-002)
// ---------------------------------------------------------------------------

test("a 90deg linear gradient renders its first stop at the left endpoint and its last at the right", async () => {
  const added = await addShape("bar", "linear:90deg,#ff0000,#00ff00", "120x40", "40", "40");
  const rev = added.layer.currentRevision;
  // The canonical fill form feeds the content hash (DEC-003): angle and
  // every resolved stop position, stored explicitly.
  expect(rev.fill).toEqual({
    type: "linear",
    angleDeg: 90,
    stops: [
      { color: "#ff0000", position: 0 },
      { color: "#00ff00", position: 100 },
    ],
  });

  const png = await renderPng("poster");
  // The box spans x 40..159. Endpoints sampled just inside the edges; the
  // expectation is CSS sRGB interpolation at the sampled fraction, never
  // eyeballed. The placement margins stay transparent.
  const f = (x: number) => (x - 40) / 119;
  expectPixel(png, 41, 60, [lerp(255, 0, f(41)), lerp(0, 255, f(41 - 1)), 0, 255]);
  expectPixel(png, 158, 60, [lerp(255, 0, f(158)), lerp(0, 255, f(158)), 0, 255]);
  // Midpoint: halfway between the stops.
  expectPixel(png, 99, 60, [127, 128, 0, 255]);
  expectPixel(png, 10, 10, [0, 0, 0, 0]);
  expectPixel(png, 190, 110, [0, 0, 0, 0]);
});

test("linear gradients render their endpoints at other angles too (180deg, 0deg)", async () => {
  // 180deg runs top-to-bottom; 0deg runs bottom-to-top (the CSS convention).
  await addShape("down", "linear:180deg,#ff0000,#00ff00", "60x60", "20", "30");
  await addShape("up", "linear:0deg,#ff0000,#00ff00", "60x60", "120", "30");
  const png = await renderPng("poster");
  // "down" box: y 30..89. First stop at the top edge, last at the bottom.
  const fDown = (y: number) => (y - 30) / 59;
  expectPixel(png, 49, 32, [lerp(255, 0, fDown(32)), lerp(0, 255, fDown(32)), 0, 255]);
  expectPixel(png, 49, 87, [lerp(255, 0, fDown(87)), lerp(0, 255, fDown(87)), 0, 255]);
  // "up" box: y 30..89. First stop at the bottom edge, last at the top.
  const fUp = (y: number) => (89 - y) / 59;
  expectPixel(png, 149, 87, [lerp(255, 0, fUp(87)), lerp(0, 255, fUp(87)), 0, 255]);
  expectPixel(png, 149, 32, [lerp(255, 0, fUp(32)), lerp(0, 255, fUp(32)), 0, 255]);
});

test("gradient stops accept alpha and explicit positions", async () => {
  // Stops at 25 and 75 (the % suffix given); the first stop is half-alpha.
  // Beyond the end stops the CSS gradient extends their colours, so the
  // sampled regions read the exact stop colours.
  await addShape("veil", "linear:90deg,#ff000080:25%,#00ff00:75%", "120x40", "40", "40");
  const png = await renderPng("poster");
  // Before the 25% stop: the exact first-stop colour at half alpha.
  expectPixel(png, 69, 60, [255, 0, 0, 128]);
  // After the 75% stop: the exact last-stop colour, opaque.
  expectPixel(png, 130, 60, [0, 255, 0, 255]);
  // Halfway between the stops: interpolated RGB and alpha (CSS interpolates
  // premultiplied). Computed from the stored stops, not eyeballed.
  const t = (100 - 40) / 119; // sample x=100: fraction of the gradient line
  const tStops = (t - 0.25) / 0.5;
  expectPixel(png, 100, 60, lerpStops([255, 0, 0, 128], [0, 255, 0, 255], tStops));
  // The canonical form keeps the parsed positions verbatim (asserted in the
  // edit test below).
});

// ---------------------------------------------------------------------------
// Radial gradient: centre and edge (TEST-002)
// ---------------------------------------------------------------------------

test("a radial gradient renders its first stop at the centre and its last at the edge", async () => {
  await addShape("dot", "radial:#ff0000,#0000ff", "100x100", "50", "10");
  const inspect = await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"]);
  expect(inspect.code).toBe(0);
  const png = await renderPng("poster");
  // The box spans x 50..149, y 10..109; the gradient radiates from the box
  // centre (100,60) with its radius reaching the farthest side. Every
  // expectation is the computed premultiplied interpolation at the sampled
  // pixel — centre pixels are 0.7px off the mathematical centre, edge
  // pixels 0.5px inside the radius — which is what the browser shows.
  const stops: RadialStop[] = [
    { rgba: [255, 0, 0, 255], position: 0 },
    { rgba: [0, 0, 255, 255], position: 100 },
  ];
  expectPixel(png, 99, 59, radialExpectation(99, 59, 100, 60, 50, stops));
  // The edge midpoints sit on the radius: the last stop's colour.
  expectPixel(png, 149, 59, radialExpectation(149, 59, 100, 60, 50, stops));
  expectPixel(png, 50, 59, radialExpectation(50, 59, 100, 60, 50, stops));
  expectPixel(png, 99, 109, radialExpectation(99, 109, 100, 60, 50, stops));
  expectPixel(png, 99, 10, radialExpectation(99, 10, 100, 60, 50, stops));
  // Outside the box: transparent.
  expectPixel(png, 10, 5, [0, 0, 0, 0]);
});

test("radial gradient stops accept alpha and explicit positions", async () => {
  await addShape("glow", "radial:#ff000080,#00ff00:75,#0000ff", "100x100", "50", "10");
  const png = await renderPng("poster");
  const stops: RadialStop[] = [
    { rgba: [255, 0, 0, 128], position: 0 },
    { rgba: [0, 255, 0, 255], position: 75 },
    { rgba: [0, 0, 255, 255], position: 100 },
  ];
  // Centre: the first-stop colour at half alpha (computed at the pixel).
  expectPixel(png, 99, 59, radialExpectation(99, 59, 100, 60, 50, stops));
  // The edge midpoints are past the 75% stop: the exact last-stop colour.
  expectPixel(png, 149, 59, radialExpectation(149, 59, 100, 60, 50, stops));
  // Near the 75% ring along the radius: the middle-stop colour.
  expectPixel(png, 136, 59, radialExpectation(136, 59, 100, 60, 50, stops));
});

// ---------------------------------------------------------------------------
// Canonical form: one ingestion point, canonical colours and angles (DEC-003)
// ---------------------------------------------------------------------------

test("gradient colours and angles canonicalize at the one ingestion boundary", async () => {
  const a = await addShape("a", "linear:-45deg,#FF0000,#0f0", "60x60", "20", "30");
  expect(a.layer.currentRevision.fill).toEqual({
    type: "linear",
    angleDeg: 315,
    stops: [
      { color: "#ff0000", position: 0 },
      { color: "#00ff00", position: 100 },
    ],
  });
  // The equivalent spelling normalizes to the SAME content identity (DEC-003):
  // -45deg and 315deg are one fill; case and #RGB shorthand collapse.
  const b = await addShape("b", "linear:315deg,#ff0000,#0F0", "60x60", "120", "30");
  expect(b.layer.currentRevision.contentHash).toBe(a.layer.currentRevision.contentHash);
});

test("omitted stop positions distribute evenly and feed the content hash", async () => {
  const even = await addShape("even", "linear:90deg,#ff0000,#00ff00", "60x60", "20", "30");
  const explicit = await addShape("explicit", "linear:90deg,#ff0000:0%,#00ff00:100%", "60x60", "120", "30");
  expect(even.layer.currentRevision.fill).toEqual(explicit.layer.currentRevision.fill);
  expect(even.layer.currentRevision.contentHash).toBe(explicit.layer.currentRevision.contentHash);
});

// ---------------------------------------------------------------------------
// Refusals name the fault and leave live state unchanged (US-001; TEST-001)
// ---------------------------------------------------------------------------

const refusals: [string, string, string][] = [
  ["a linear gradient with fewer than two stops", "linear:45deg,#ff0000", "at least two"],
  ["a radial gradient with fewer than two stops", "radial:#ff0000", "at least two"],
  ["an out-of-range linear stop position", "linear:45deg,#ff0000:150,#00ff00", "between 0 and 100"],
  ["a negative radial stop position", "radial:#ff0000:-5,#00ff00", "between 0 and 100"],
  ["a malformed linear stop colour", "linear:45deg,red,#00ff00", 'stop colour "red"'],
  ["a malformed radial stop colour", "radial:#ff0000,notacolor", 'stop colour "notacolor"'],
  ["a linear gradient without an angle", "linear,#ff0000,#00ff00", "discriminator prefix"],
  ["an angle on a radial gradient", "radial:45deg,#ff0000,#00ff00", "no angle"],
  ["a decreasing stop position list", "linear:45deg,#ff0000:75,#00ff00:25", "must not decrease"],
  ["an unknown fill type", "gradient:#ff0000,#00ff00", 'Unknown fill type "gradient"'],
];

test("each malformed gradient is refused before publication, naming the fault, and live state is unchanged", async () => {
  const add = await addShape("bar", "#1d4ed8", "120x40", "30", "20");
  const layerId = add.use.layerId as string;
  const beforeRevisionId = add.layer.currentRevisionId;
  const beforeHash = add.layer.currentRevision.contentHash as string;

  for (const [description, spec, fault] of refusals) {
    const res = await invoke([
      "layer", "edit", layerId, "--fill", spec, "--project", projDir, "--json",
    ]);
    expect(res.code).toBe(2);
    const json = JSON.parse(res.stdout);
    expect(json.ok).toBe(false);
    // The refusal names the fault (US-001).
    expect(json.error).toContain(fault);
    expect(json.error).not.toContain("undefined");
  }

  // Live state unchanged: the same revision, the same solid fill, nothing
  // published by the refused edits.
  const after = JSON.parse(
    (await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout,
  );
  expect(after.layer.currentRevisionId).toBe(beforeRevisionId);
  expect(after.layer.currentRevision.fill).toEqual({ type: "solid", color: "#1d4ed8" });
  expect(after.layer.currentRevision.contentHash).toBe(beforeHash);
});

test("a refused gradient at composition add publishes nothing", async () => {
  const res = await invoke([
    "composition", "add", "poster", "bad",
    "--shape", "rectangle", "--size", "10x10", "--fill", "linear:45deg,#ff0000:150,#00ff00",
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(2);
  expect(JSON.parse(res.stdout).error).toContain("between 0 and 100");
  const inspect = JSON.parse(
    (await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"])).stdout,
  );
  expect(inspect.composition.layers).toEqual([]);
});

// ---------------------------------------------------------------------------
// Add and edit both gain gradients through the ONE ingestion point (DEC-003)
// ---------------------------------------------------------------------------

test("layer edit sets a radial gradient through the same parser, and a repeated edit is idempotent", async () => {
  const add = await addShape("bar", "#1d4ed8", "120x40", "30", "20");
  const layerId = add.use.layerId as string;

  const edit = await invoke([
    "layer", "edit", layerId, "--fill", "radial:#ff000080,#00ff00", "--project", projDir, "--json",
  ]);
  expect(edit.code).toBe(0);
  const edited = JSON.parse(edit.stdout).layer.currentRevision;
  expect(edited.fill).toEqual({
    type: "radial",
    stops: [
      { color: "#ff000080", position: 0 },
      { color: "#00ff00", position: 100 },
    ],
  });
  const radialRevisionId = JSON.parse(edit.stdout).layer.currentRevisionId;

  // A no-change gradient edit is idempotent: the whole fill identity (angle
  // and every stop) compares, so the same fill publishes no new revision.
  const repeat = await invoke([
    "layer", "edit", layerId, "--fill", "radial:#ff000080,#00ff00", "--project", projDir, "--json",
  ]);
  expect(repeat.code).toBe(0);
  expect(JSON.parse(repeat.stdout).layer.currentRevisionId).toBe(radialRevisionId);

  // A different stop list is a different fill: a new revision.
  const changed = await invoke([
    "layer", "edit", layerId, "--fill", "radial:#ff000080,#00ff00:50,#0000ff", "--project", projDir, "--json",
  ]);
  expect(changed.code).toBe(0);
  expect(JSON.parse(changed.stdout).layer.currentRevisionId).not.toBe(radialRevisionId);
  expect(JSON.parse(changed.stdout).layer.currentRevision.fill.stops).toHaveLength(3);
});

test("an edit back to the original solid restores the original content identity (DEC-010)", async () => {
  const add = await addShape("bar", "linear:90deg,#ff0000,#00ff00", "120x40", "30", "20");
  const layerId = add.use.layerId as string;
  const edit = await invoke([
    "layer", "edit", layerId, "--fill", "#1d4ed8", "--project", projDir, "--json",
  ]);
  expect(edit.code).toBe(0);
  // The solid identity is byte-identical to #208's encoding: the same
  // canonical form hashes to the same content hash (no solid revision id
  // moved when the gradient variants joined the union).
  expect(JSON.parse(edit.stdout).layer.currentRevision.contentHash).toBe(
    createHash("sha256").update("shape:v1:rectangle:120x40:r0:fill(solid:#1d4ed8)").digest("hex"),
  );
});

// ---------------------------------------------------------------------------
// inspect and measure report the gradient (TEST-001)
// ---------------------------------------------------------------------------

test("inspect and measure report the gradient fill", async () => {
  const add = await addShape("bar", "linear:90deg,#ff0000:25,#00ff00:75", "120x40", "30", "20");
  const layerId = add.use.layerId as string;

  const layerInspect = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(layerInspect.stdout).toContain("Fill: linear 90deg #ff0000 25%, #00ff00 75%");

  const compositionInspect = await invoke(["composition", "inspect", "poster", "--project", projDir]);
  expect(compositionInspect.stdout).toContain("linear 90deg #ff0000 25%, #00ff00 75%");

  const measureJson = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  expect(measureJson.code).toBe(0);
  const measured = JSON.parse(measureJson.stdout).layers[0];
  expect(measured.fill).toEqual({
    type: "linear",
    angleDeg: 90,
    stops: [
      { color: "#ff0000", position: 25 },
      { color: "#00ff00", position: 75 },
    ],
  });
  const measureText = await invoke(["composition", "measure", "poster", "--project", projDir]);
  expect(measureText.stdout).toContain("fill linear 90deg #ff0000 25%, #00ff00 75%");

  // The layer review sheet reports the same facts.
  const review = await invoke([
    "layer", "review", layerId, "--out", path.join(tempDir, "review.png"), "--project", projDir, "--json",
  ]);
  expect(review.code).toBe(0);
});

test("measure reports null fill for non-shape Layers (additive output, DEC-010)", async () => {
  const img = path.join(tempDir, "red.png");
  const buf = Buffer.alloc(8 * 8 * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255; buf[i + 3] = 255;
  }
  await Bun.write(img, encodePngRgba(8, 8, buf));
  await invoke(["composition", "add", "poster", "pic", "--image", img, "--project", projDir, "--json"]);
  await addShape("bar", "radial:#ff0000,#00ff00", "60x60", "20", "30");
  const measureJson = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  const layers = JSON.parse(measureJson.stdout).layers as { name: string; fill: unknown }[];
  expect(layers.find((l) => l.name === "pic")!.fill).toBeNull();
  expect(layers.find((l) => l.name === "bar")!.fill).toEqual({
    type: "radial",
    stops: [
      { color: "#ff0000", position: 0 },
      { color: "#00ff00", position: 100 },
    ],
  });
});

// ---------------------------------------------------------------------------
// Render replay: a Render with a gradient fill replays byte-identically
// ---------------------------------------------------------------------------

interface RenderResultJson {
  render: { output: string; manifest: string };
}

async function replay(manifestPath: string, project: string): Promise<{ code: number; output?: string }> {
  const res = await invoke(["composition", "replay", manifestPath, "--project", project, "--json"]);
  const json = JSON.parse(res.stdout);
  return { code: res.code, output: json.replay?.output };
}

test("a Render containing a gradient-filled shape replays byte-identically after a later edit", async () => {
  await addShape("bg", "#101828", "200x120", "0", "0");
  const add = await addShape("bar", "linear:45deg,#ff0000,#00ff00", "120x40", "40", "40");
  const barLayerId = add.use.layerId as string;

  const first = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(first.code).toBe(0);
  const originalPng = await readFile(JSON.parse(first.stdout).render.output);

  // A later current-state edit (change the fill) does not change the
  // retained Render: the manifest pins the pre-edit revision, whose gradient
  // markup derives from the stored revision alone.
  const edit = await invoke([
    "layer", "edit", barLayerId, "--fill", "radial:#ff0000,#00ff00", "--project", projDir, "--json",
  ]);
  expect(edit.code).toBe(0);

  const replayRes = await replay(JSON.parse(first.stdout).render.manifest, projDir);
  expect(replayRes.code).toBe(0);
  expect((await readFile(replayRes.output!)).equals(originalPng)).toBe(true);
});