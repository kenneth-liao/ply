/**
 * Skew and perspective as Layer revision facts (#298, spec #285 US-008,
 * ISC-47, DEC-005/DEC-006, ADR-0016 amendment), verified at the CLI and
 * measure seams (TEST-001/TEST-002, offline):
 *
 * - `--skew <XxY>` (degrees) and `--perspective <tiltX>x<tiltY>` (degrees
 *   about the X and Y axes, fixed documented 1000px perspective distance)
 *   are ABSOLUTE revision-fact setters on every Layer kind, on
 *   `composition add` and `layer edit` alike.
 * - The full transform order (innermost → outermost): flip, scale,
 *   rotation, skew, perspective — the perspective tilt pivoting about the
 *   Layer's own untransformed content centre, everything else about the
 *   (x, y) placement point. measure's projected corners pin the order
 *   against an analytically composed matrix.
 * - The acceptance probe: a tile tilted about Y renders differently from
 *   the untilted tile, and measure shows the far edge shorter than the
 *   near edge with the tile centre (the projected quad's diagonal
 *   intersection) exactly unmoved.
 * - Painted extents and anchored placement follow the transformed ink.
 * - Removal values `--skew 0x0` / `--perspective 0x0` restore the render
 *   byte-for-byte, and the document stores nothing (absence IS the
 *   identity form).
 * - A Render retained before the edit replays byte-identically (pinned
 *   history stays pinned).
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePngRgba, decodePng } from "../src/png.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

interface Result {
  stdout: string;
  stderr: string;
  code: number;
}

async function invoke(args: string[]): Promise<Result> {
  const proc = Bun.spawn([process.execPath, cli, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, code };
}

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    const [r, g, b, a] = rgba;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  }
  return encodePngRgba(width, height, buf);
}

const RED: [number, number, number, number] = [255, 0, 0, 255];

let tempDir: string;
let projDir: string;
let imagePath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-skew-perspective-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir]);
  await invoke(["composition", "create", "poster", "--width", "600", "--height", "400", "--project", projDir]);
  imagePath = path.join(tempDir, "red.png");
  await writeFile(imagePath, solidPng(200, 100, RED));
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function addLayer(use: string, args: string[]): Promise<{ layerId: string; revisionId: string }> {
  const res = await invoke([
    "composition", "add", "poster", use, ...args, "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const parsed = JSON.parse(res.stdout);
  return { layerId: parsed.use.layerId as string, revisionId: parsed.layer.currentRevisionId as string };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function editJson(layerId: string, args: string[]): Promise<{ code: number; parsed: any; stderr: string; stdout: string }> {
  const res = await invoke(["layer", "edit", layerId, ...args, "--project", projDir, "--json"]);
  const parsed: any = res.code === 0 ? JSON.parse(res.stdout) : undefined;
  return { code: res.code, parsed, stderr: res.stderr, stdout: res.stdout };
}

/** One Layer's measured geometry, transform facts, and painted extents. */
async function measureUse(use: string): Promise<any> {
  const res = await invoke(["composition", "measure", "poster", use, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).layers[0];
}

async function render(comp: string, out: string): Promise<ReturnType<typeof decodePng>> {
  const res = await invoke(["composition", "render", comp, "--out", path.join(tempDir, out), "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return decodePng(await readFile(path.join(tempDir, out)));
}

async function revisionIdOf(layerId: string): Promise<string> {
  const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  return JSON.parse(inspect.stdout).layer.currentRevisionId as string;
}

// ---------------------------------------------------------------------------
// Analytic transform composition: the documented order, pinned as a 4x4.
// Innermost → outermost: flip, scale, rotation, skew, perspective (the
// perspective tilt pivoting about the untransformed content centre).
// ---------------------------------------------------------------------------

type Mat4 = number[]; // row-major 4x4

const ident4 = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul4(a: Mat4, b: Mat4): Mat4 {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      for (let k = 0; k < 4; k++) out[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
    }
  }
  return out;
}

function translate4(x: number, y: number, z = 0): Mat4 {
  return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
}

function scale4(sx: number, sy: number): Mat4 {
  return [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function rotateZ4(deg: number): Mat4 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  // CSS rotate(a): clockwise positive in y-down screen coordinates.
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function rotateX4(deg: number): Mat4 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  // CSS rotateX: y' = c·y − s·z, z' = s·y + c·z (positive tips the top edge
  // away from the viewer).
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
}

function rotateY4(deg: number): Mat4 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  // CSS rotateY: x' = c·x + s·z, z' = −s·x + c·z (positive tips the right
  // edge away from the viewer).
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
}

function skewX4(deg: number): Mat4 {
  const t = Math.tan((deg * Math.PI) / 180);
  return [1, t, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function skewY4(deg: number): Mat4 {
  const t = Math.tan((deg * Math.PI) / 180);
  return [1, 0, 0, 0, t, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function perspective4(d: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1 / d, 1];
}

/** Map a content-plane point (u, v) through the composed transform, with the
 *  perspective w-divide, and return the canvas-space (x, y). */
function apply4(m: Mat4, u: number, v: number): { x: number; y: number } {
  const x = m[0]! * u + m[1]! * v + m[3]!;
  const y = m[4]! * u + m[5]! * v + m[7]!;
  const w = m[12]! * u + m[13]! * v + m[15]!;
  return { x: x / w, y: y / w };
}

/** The expected transform for the documented order (ADR-0016 amendment):
 *  flip and scale innermost about the placement point, then rotation, then
 *  skew, then the perspective tilt pivoting about the content centre, then
 *  the 1000px perspective divide. */
function expectedTransform(opts: {
  content: { width: number; height: number };
  scaleX?: number; scaleY?: number;
  flipX?: boolean;
  rotateDeg?: number;
  skewXDeg?: number; skewYDeg?: number;
  perspectiveTiltXDeg?: number; perspectiveTiltYDeg?: number;
}): Mat4 {
  const { width, height } = opts.content;
  const cx = width / 2, cy = height / 2;
  let m = ident4();
  // Innermost: flip joins scale (both diagonal, order immaterial).
  m = mul4(scale4(opts.scaleX ?? 1, opts.scaleY ?? 1), m);
  if (opts.flipX) m = mul4(scale4(-1, 1), m);
  // Then rotation about the placement point.
  if (opts.rotateDeg) m = mul4(rotateZ4(opts.rotateDeg), m);
  // Then skew. The emitted string is `skewX(ax) skewY(ay)` — CSS composes
  // left-to-right as function composition, so the point shears along y
  // FIRST, then along x: the matrix is skewX·skewY·(inner). The two do not
  // commute (the products differ by t1·t2 on the diagonal), so this order
  // is load-bearing and pinned by the two-axis case below.
  if (opts.skewYDeg) m = mul4(skewY4(opts.skewYDeg), m);
  if (opts.skewXDeg) m = mul4(skewX4(opts.skewXDeg), m);
  // Then the perspective tilt, pivoted about the content centre, and the
  // perspective divide outermost. The CSS string
  // `perspective(d) translate(50%,50%) rotateX rotateY translate(-50%,-50%)`
  // applies, to the affine-mapped point, the rightmost function first:
  // −centre, then the tilts, then +centre, then the perspective divide —
  // so the tilt rotates about the fixed layout-space centre (w/2, h/2).
  if (opts.perspectiveTiltXDeg || opts.perspectiveTiltYDeg) {
    m = mul4(translate4(-cx, -cy), m);
    if (opts.perspectiveTiltYDeg) m = mul4(rotateY4(opts.perspectiveTiltYDeg), m);
    if (opts.perspectiveTiltXDeg) m = mul4(rotateX4(opts.perspectiveTiltXDeg), m);
    m = mul4(translate4(cx, cy), m);
    m = mul4(perspective4(1000), m);
  }
  return m;
}

function expectCornersNear(actual: { x: number; y: number }[], expected: { x: number; y: number }[], tol = 0.05): void {
  for (let i = 0; i < 4; i++) {
    expect(Math.abs(actual[i]!.x - expected[i]!.x)).toBeLessThan(tol);
    expect(Math.abs(actual[i]!.y - expected[i]!.y)).toBeLessThan(tol);
  }
}

/** The projected quad's diagonal intersection — the image of the content
 *  centre under the projective map (projective maps preserve incidence). */
function quadCentre(c: { x: number; y: number }[]): { x: number; y: number } {
  // Diagonal A: c0 → c2; diagonal B: c1 → c3. Solve A(s) = B(t).
  const ax = c[2]!.x - c[0]!.x, ay = c[2]!.y - c[0]!.y;
  const bx = c[3]!.x - c[1]!.x, by = c[3]!.y - c[1]!.y;
  const det = ax * -by - -bx * ay;
  const s = ((c[1]!.x - c[0]!.x) * -by - -bx * (c[1]!.y - c[0]!.y)) / det;
  return { x: c[0]!.x + ax * s, y: c[0]!.y + ay * s };
}

function edgeLength(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// ---------------------------------------------------------------------------
// The acceptance probe (US-008, ISC-47): a tile tilted about Y renders
// differently, and measure shows the far edge shorter than the near edge
// with the tile centre exactly unmoved.
// ---------------------------------------------------------------------------

test("a tile tilted in perspective renders differently and measure shows the far edge shorter with the centre unmoved", async () => {
  const { layerId } = await addLayer("tile", ["--image", imagePath, "--x", "100", "--y", "100"]);
  const before = await render("poster", "tilt-before.png");

  const base = await measureUse("tile");
  expect(base.transform.perspectiveTiltXDeg).toBe(0);
  expect(base.transform.perspectiveTiltYDeg).toBe(0);
  const baseEdges = {
    left: edgeLength(base.corners[0], base.corners[3]),
    right: edgeLength(base.corners[1], base.corners[2]),
  };
  expect(baseEdges.left).toBeCloseTo(100, 1);
  expect(baseEdges.right).toBeCloseTo(100, 1);

  const edit = await editJson(layerId, ["--perspective", "0x20"]);
  expect(edit.code).toBe(0);
  expect(edit.parsed.layer.currentRevision.perspectiveTiltXDeg).toBe(0);
  expect(edit.parsed.layer.currentRevision.perspectiveTiltYDeg).toBe(20);

  const after = await render("poster", "tilt-after.png");
  expect(after.rgba.equals(before.rgba)).toBe(false);

  // measure reports the facts and the projected quad: positive Y tilt moves
  // the right edge away (the far edge), so it projects shorter than the
  // near (left) edge, and the content centre (the diagonal intersection of
  // the projected quad — the image of the centre under the projective map)
  // stays at the untilted content centre.
  const m = await measureUse("tile");
  expect(m.transform.perspectiveTiltYDeg).toBe(20);
  const expected = expectedTransform({ content: { width: 200, height: 100 }, perspectiveTiltYDeg: 20 });
  expectCornersNear(
    m.corners,
    [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }].map((p) => {
      const q = apply4(expected, p.x, p.y);
      return { x: q.x + 100, y: q.y + 100 };
    }),
  );
  const far = edgeLength(m.corners[1], m.corners[2]);
  const near = edgeLength(m.corners[0], m.corners[3]);
  expect(far).toBeLessThan(near);
  const centre = quadCentre(m.corners);
  expect(Math.abs(centre.x - 200)).toBeLessThan(0.2);
  expect(Math.abs(centre.y - 150)).toBeLessThan(0.2);

  // The painted extents follow the transformed ink: the tilted tile's
  // painted AABB differs from the untilted one.
  expect(m.painted).not.toBeNull();
  const baseBox = base.painted;
  expect(
    Math.abs(m.painted.width - baseBox.width) > 0.5 || Math.abs(m.painted.height - baseBox.height) > 0.5,
  ).toBe(true);
}, 30_000);

// ---------------------------------------------------------------------------
// Skew: a shear about the placement point, measured as the sheared quad.
// ---------------------------------------------------------------------------

test("skew shears the tile about the placement point and measure reports the sheared quad", async () => {
  const { layerId } = await addLayer("tile", ["--image", imagePath, "--x", "100", "--y", "100"]);
  const before = await render("poster", "skew-before.png");

  const edit = await editJson(layerId, ["--skew", "15x0"]);
  expect(edit.code).toBe(0);
  expect(edit.parsed.layer.currentRevision.skewXDeg).toBe(15);
  expect(edit.parsed.layer.currentRevision.skewYDeg).toBe(0);

  const after = await render("poster", "skew-after.png");
  expect(after.rgba.equals(before.rgba)).toBe(false);

  const m = await measureUse("tile");
  expect(m.transform.skewXDeg).toBe(15);
  expect(m.transform.skewYDeg).toBe(0);
  const expected = expectedTransform({ content: { width: 200, height: 100 }, skewXDeg: 15 });
  expectCornersNear(
    m.corners,
    [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }].map((p) => {
      const q = apply4(expected, p.x, p.y);
      return { x: q.x + 100, y: q.y + 100 };
    }),
  );
  // The sheared footprint is wider than the content: x reaches tan(15°)·100.
  expect(m.box.width).toBeGreaterThan(200);
}, 30_000);

// ---------------------------------------------------------------------------
// The documented order: flip, scale, rotation, skew, perspective — pinned
// by measure's projected corners against the analytic composition.
// ---------------------------------------------------------------------------

test("skew and perspective compose with flip, scale, and rotation in the documented order", async () => {
  const { layerId } = await addLayer("tile", ["--image", imagePath, "--x", "150", "--y", "120"]);

  const edit = await editJson(layerId, [
    "--flip", "horizontal", "--scale-to", "1.5x1", "--rotate", "10", "--skew", "12x7", "--perspective", "0x18",
  ]);
  expect(edit.code).toBe(0);

  const m = await measureUse("tile");
  const expected = expectedTransform({
    content: { width: 200, height: 100 },
    scaleX: 1.5, scaleY: 1,
    flipX: true,
    rotateDeg: 10,
    // TWO axes: the point shears along y first, then along x (the emitted
    // `skewX(12deg) skewY(7deg)` applies right-to-left) — the order regression
    // a single-axis case cannot catch (INT-1).
    skewXDeg: 12, skewYDeg: 7,
    perspectiveTiltYDeg: 18,
  });
  expectCornersNear(
    m.corners,
    [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }].map((p) => {
      const q = apply4(expected, p.x, p.y);
      return { x: q.x + 150, y: q.y + 120 };
    }),
    0.06,
  );
}, 30_000);

// ---------------------------------------------------------------------------
// Every Layer kind takes both facts, on add and edit.
// ---------------------------------------------------------------------------

test("skew and perspective work on text and shape Layers through add and edit", async () => {
  const { layerId: textId } = await addLayer("headline", [
    "--text", "Tilt", "--font", "Archivo", "--font-size", "40", "--x", "20", "--y", "40",
  ]);
  const textEdit = await editJson(textId, ["--skew", "10x0", "--perspective", "0x15"]);
  expect(textEdit.code).toBe(0);
  expect(textEdit.parsed.layer.currentRevision.skewXDeg).toBe(10);
  expect(textEdit.parsed.layer.currentRevision.perspectiveTiltYDeg).toBe(15);
  const textM = await measureUse("headline");
  expect(textM.transform.skewXDeg).toBe(10);
  expect(textM.transform.perspectiveTiltYDeg).toBe(15);

  const shape = await addLayer("badge", [
    "--shape", "rectangle", "--size", "60x30", "--fill", "#ff0000", "--x", "10", "--y", "200",
    "--skew", "0x10", "--perspective", "12x0",
  ]);
  expect(shape.revisionId).toBeTruthy();
  const shapeM = await measureUse("badge");
  expect(shapeM.transform.skewYDeg).toBe(10);
  expect(shapeM.transform.perspectiveTiltXDeg).toBe(12);
}, 30_000);

// ---------------------------------------------------------------------------
// Absolute setters: idempotent, one-axis forms keep the other axis.
// ---------------------------------------------------------------------------

test("the setters are absolute and idempotent; one-axis forms keep the other axis", async () => {
  const { layerId } = await addLayer("tile", ["--image", imagePath, "--x", "10", "--y", "10"]);

  const first = await editJson(layerId, ["--skew", "15x0", "--perspective", "0x20"]);
  expect(first.code).toBe(0);
  const measuredFirst = await measureUse("tile");

  const second = await editJson(layerId, ["--skew", "15x0", "--perspective", "0x20"]);
  expect(second.code).toBe(0);
  expect(await measureUse("tile")).toEqual(measuredFirst);

  // One-axis forms: the omitted axis keeps its current angle.
  const skewXOnly = await editJson(layerId, ["--skew", "25x"]);
  expect(skewXOnly.code).toBe(0);
  expect(skewXOnly.parsed.layer.currentRevision.skewXDeg).toBe(25);
  expect(skewXOnly.parsed.layer.currentRevision.skewYDeg).toBe(0);

  const skewYOnly = await editJson(layerId, ["--skew", "x5"]);
  expect(skewYOnly.code).toBe(0);
  expect(skewYOnly.parsed.layer.currentRevision.skewXDeg).toBe(25);
  expect(skewYOnly.parsed.layer.currentRevision.skewYDeg).toBe(5);

  const tiltXOnly = await editJson(layerId, ["--perspective", "30x"]);
  expect(tiltXOnly.code).toBe(0);
  expect(tiltXOnly.parsed.layer.currentRevision.perspectiveTiltXDeg).toBe(30);
  expect(tiltXOnly.parsed.layer.currentRevision.perspectiveTiltYDeg).toBe(20);

  const tiltYOnly = await editJson(layerId, ["--perspective", "x40"]);
  expect(tiltYOnly.code).toBe(0);
  expect(tiltYOnly.parsed.layer.currentRevision.perspectiveTiltXDeg).toBe(30);
  expect(tiltYOnly.parsed.layer.currentRevision.perspectiveTiltYDeg).toBe(40);
}, 30_000);

// ---------------------------------------------------------------------------
// Removal: the documented removal values restore the render byte-for-byte,
// and the document stores nothing (absence IS the identity form).
// ---------------------------------------------------------------------------

test("removing skew and perspective restores the render byte-for-byte and stores nothing", async () => {
  const { layerId } = await addLayer("tile", ["--image", imagePath, "--x", "10", "--y", "10"]);
  const original = await render("poster", "removal-before.png");

  const skewed = await editJson(layerId, ["--skew", "15x0", "--perspective", "0x20"]);
  expect(skewed.code).toBe(0);
  const altered = await render("poster", "removal-skewed.png");
  expect(altered.rgba.equals(original.rgba)).toBe(false);

  const removed = await editJson(layerId, ["--skew", "0x0", "--perspective", "0x0"]);
  expect(removed.code).toBe(0);
  const restored = await render("poster", "removal-after.png");
  expect(restored.rgba.equals(original.rgba)).toBe(true);

  // Stored only when set: the removal normalizes the resolved facts back to
  // identity, and the revision id returns to the unskewed identity's exact
  // hash — which proves the stored document dropped the pair (the hash
  // appends the pair only when present, so an explicit stored 0x0 would be
  // a different id).
  // Stored only when set: the removal normalizes the resolved facts back to
  // identity, and the STORED revision document drops the pair entirely —
  // the file on disk carries no skew/perspective keys (the hash appends the
  // pair only when present, so this is the pre-#298 document shape too).
  const rev = removed.parsed.layer.currentRevision;
  expect(rev.skewXDeg).toBe(0);
  expect(rev.skewYDeg).toBe(0);
  expect(rev.perspectiveTiltXDeg).toBe(0);
  expect(rev.perspectiveTiltYDeg).toBe(0);
  const removedId = await revisionIdOf(layerId);
  const stored = JSON.parse(
    await readFile(path.join(projDir, "layers", `${layerId}.revisions`, `${removedId}.json`), "utf8"),
  );
  expect(stored.skewXDeg).toBeUndefined();
  expect(stored.skewYDeg).toBeUndefined();
  expect(stored.perspectiveTiltXDeg).toBeUndefined();
  expect(stored.perspectiveTiltYDeg).toBeUndefined();
}, 30_000);

// ---------------------------------------------------------------------------
// Bounds and grammar, refused identically on both surfaces.
// ---------------------------------------------------------------------------

test("--skew and --perspective bounds refusals match on both surfaces", async () => {
  const { layerId } = await addLayer("tile", ["--image", imagePath, "--x", "10", "--y", "10"]);

  for (const [flag, value] of [
    ["--skew", "90x0"], ["--skew", "0x-90.5"], ["--perspective", "89.5x0"], ["--perspective", "0xbanana"],
  ] as const) {
    const edit = await invoke(["layer", "edit", layerId, flag, value, "--project", projDir, "--json"]);
    const add = await invoke([
      "composition", "add", "poster", "nope", "--image", imagePath, flag, value, "--project", projDir, "--json",
    ]);
    expect(edit.code).toBe(add.code);
    expect(edit.code === 1 || edit.code === 2).toBe(true);
    const editError = JSON.parse(edit.stdout).error as string;
    const addError = JSON.parse(add.stdout).error as string;
    expect(editError).toBe(addError);
    if (edit.code === 1) {
      expect(editError).toContain("between -89 and 89");
    } else {
      expect(editError).toContain(`${flag} takes`);
    }
  }
  expect(await revisionIdOf(layerId)).toBeTruthy();
}, 30_000);

test("malformed --skew and --perspective values are usage errors naming the flag", async () => {
  const { layerId } = await addLayer("tile", ["--image", imagePath, "--x", "10", "--y", "10"]);
  for (const [flag, value] of [
    ["--skew", "banana"], ["--skew", "15"], ["--perspective", "banana"], ["--perspective", "0x20x30"],
  ] as const) {
    const edit = await invoke(["layer", "edit", layerId, flag, value, "--project", projDir, "--json"]);
    expect(edit.code).toBe(2);
    expect(JSON.parse(edit.stdout).error).toContain(`${flag} takes`);
    const add = await invoke([
      "composition", "add", "poster", "nope", "--image", imagePath, flag, value, "--project", projDir, "--json",
    ]);
    expect(add.code).toBe(2);
    expect(JSON.parse(add.stdout).error).toContain(`${flag} takes`);
  }
}, 30_000);

// ---------------------------------------------------------------------------
// Skew and perspective are content-size independent (like rotation): they
// combine freely with the resize family and content replacement.
// ---------------------------------------------------------------------------

test("skew and perspective combine freely with resize and content replacement", async () => {
  const { layerId } = await addLayer("tile", ["--image", imagePath, "--x", "10", "--y", "10"]);
  const other = path.join(tempDir, "other.png");
  await writeFile(other, solidPng(32, 32, [0, 0, 255, 255]));

  const combined = await editJson(layerId, ["--resize", "2", "--skew", "10x0"]);
  expect(combined.code).toBe(0);
  expect(combined.parsed.layer.currentRevision.scaleX).toBe(2);
  expect(combined.parsed.layer.currentRevision.skewXDeg).toBe(10);

  const replaced = await editJson(layerId, ["--image", other, "--perspective", "0x10"]);
  expect(replaced.code).toBe(0);
  expect(replaced.parsed.layer.currentRevision.perspectiveTiltYDeg).toBe(10);
}, 30_000);

// ---------------------------------------------------------------------------
// A Render retained before the edit replays byte-identically (pinned).
// ---------------------------------------------------------------------------

test("a Render retained before the skew/perspective edit replays byte-identically", async () => {
  const { layerId } = await addLayer("tile", ["--image", imagePath, "--x", "10", "--y", "10"]);
  const renderRes = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(renderRes.code).toBe(0);
  const renderJson = JSON.parse(renderRes.stdout).render;
  const originalPng = await readFile(renderJson.output);
  const manifestPath = renderJson.manifest;

  const edit = await editJson(layerId, ["--skew", "15x0", "--perspective", "0x20"]);
  expect(edit.code).toBe(0);

  const replay = await invoke(["composition", "replay", manifestPath, "--project", projDir, "--json"]);
  expect(replay.code).toBe(0);
  const replayOutput = JSON.parse(replay.stdout).replay.output as string;
  expect(readFile(replayOutput)).resolves.toEqual(originalPng);
}, 30_000);

// ---------------------------------------------------------------------------
// The divergent-projection publication gate (PROD-1, #298 review): the same
// refusal measure applies runs at the add and edit publication boundary, so
// a Layer that measure would refuse can never be stored. The discriminating
// case is scale-magnified depth: a 500x100 source at scale 4 and tilt 45°
// about Y projects its affine-mapped corner ~1237px deep — the raw layout extents
// alone reach only ~212px, so only the post-affine depth (INT-2) catches it.
// ---------------------------------------------------------------------------

test("a divergent projection is refused at the add and edit boundary before anything publishes", async () => {
  const wide = path.join(tempDir, "wide.png");
  await writeFile(wide, solidPng(500, 100, RED));

  // Add path: one command, refused before anything is published.
  const add = await invoke([
    "composition", "add", "poster", "nope", "--image", wide, "--x", "10", "--y", "10",
    "--scale-to", "4x1", "--perspective", "0x45", "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(1);
  const addError = JSON.parse(add.stdout).error as string;
  expect(addError).toContain("projects that extent deeper than the fixed 1000px perspective distance");

  // Edit path: same facts, refused before publish — the same refusal the
  // measure seam carries (one shared computation), and the live state never
  // advances.
  const { layerId, revisionId } = await addLayer("tile", ["--image", wide, "--x", "10", "--y", "10"]);
  const scaled = await editJson(layerId, ["--scale-to", "4x1"]);
  expect(scaled.code).toBe(0);

  const tiltOnly = await editJson(layerId, ["--perspective", "0x45"]);
  expect(tiltOnly.code).toBe(1);
  // The same refusal the measure seam carries (one shared computation);
  // each names its own Layer id, so the parity check strips it.
  const withoutId = (s: string) => s.replace(/^Layer "[^"]+" is /, "Layer is ");
  expect(withoutId(JSON.parse(tiltOnly.stdout).error)).toBe(withoutId(addError));
  expect(await revisionIdOf(layerId)).not.toBe(revisionId); // the scale edit published
  const scaledRevisionId = await revisionIdOf(layerId);

  // A tilt that measure accepts stores, and content replacement under it is
  // gated by the NEW content's extent: a wide replacement diverges and is
  // refused; a small one stays storable.
  const tilted = await editJson(layerId, ["--perspective", "0x20"]);
  expect(tilted.code).toBe(0);
  const tiltedRevisionId = await revisionIdOf(layerId);
  const wide2 = path.join(tempDir, "wide2.png");
  await writeFile(wide2, solidPng(2000, 100, [0, 0, 255, 255]));
  const replaced = await editJson(layerId, ["--image", wide2]);
  expect(replaced.code).toBe(1);
  expect(withoutId(JSON.parse(replaced.stdout).error)).toContain(
    "projects that extent deeper than the fixed 1000px perspective distance",
  );
  expect(await revisionIdOf(layerId)).toBe(tiltedRevisionId);
  const small = path.join(tempDir, "small.png");
  await writeFile(small, solidPng(100, 100, [0, 0, 255, 255]));
  const smallOk = await editJson(layerId, ["--image", small]);
  expect(smallOk.code).toBe(0);

  // The boundary is exact, not conservative: the same source at a shallower
  // tilt stores, and measure agrees the projection is bounded.
  const ok = await invoke([
    "composition", "add", "poster", "fine", "--image", wide, "--x", "10", "--y", "10",
    "--scale-to", "4x1", "--perspective", "0x20", "--project", projDir, "--json",
  ]);
  expect(ok.code).toBe(0);
  const fineId = JSON.parse(ok.stdout).use.layerId as string;
  const tiltEdit = await editJson(fineId, ["--perspective", "0x20"]);
  expect(tiltEdit.code).toBe(0);
  const measure = await invoke(["composition", "measure", "poster", "fine", "--project", projDir, "--json"]);
  expect(measure.code).toBe(0);
  expect(JSON.parse(measure.stdout).layers[0].refused).toBeNull();
}, 30_000);

// ---------------------------------------------------------------------------
// Anchored placement follows the transformed ink: anchoring a skewed tile
// resolves against the sheared quad's extents, not the unsheared box.
// ---------------------------------------------------------------------------

test("anchored placement on a skewed Layer resolves against the transformed ink", async () => {
  const { layerId } = await addLayer("tile", ["--image", imagePath, "--x", "10", "--y", "10"]);
  await editJson(layerId, ["--skew", "30x0"]);
  const m = await measureUse("tile");
  // The sheared quad's painted ink reaches further right than the
  // unsheared 200px content would.
  expect(m.box.x + m.box.width).toBeGreaterThan(10 + 200 + 1);

  const anchored = await editJson(layerId, ["--anchor", "right", "--x", "590"]);
  expect(anchored.code).toBe(0);
  const after = await measureUse("tile");
  // The transformed ink's right edge lands at the requested target.
  expect(Math.abs(after.box.x + after.box.width - 590)).toBeLessThan(1.5);
}, 30_000);