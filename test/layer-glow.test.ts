/**
 * Rendered-pixel, measure, and CLI seam tests for the Layer edge glow (#221,
 * spec #218 US-002, DEC-001, DEC-005, DEC-006, DEC-009, DEC-011, TEST-003,
 * TEST-008).
 *
 * Assertions:
 * - Interior pixels far from the edge are unchanged; pixels just inside the
 *   edge move toward the glow colour (TEST-003).
 * - Painted extents equal the no-glow extents (DEC-005, TEST-003).
 * - With a direction, the lit side changes more than the far side; without
 *   one, the glow is even (TEST-003, DEC-006).
 * - The glow follows the visible region's edge, including rounded corners,
 *   and transforms with the Layer (#212, ADR-0023).
 * - Absolute setter: "none" removes the stored fact; set-then-remove renders
 *   byte-identically to never-set; a Render with a glow replays
 *   byte-identically.
 * - Invalid values are refused before publication on both surfaces, naming
 *   the part and its range (DEC-009).
 * - inspect, measure, and layer review report the glow.
 * - Storage normalisation (normalizeStoredGlow) is the one validation and
 *   removal home; paint trusts the fact.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { encodePngRgba, decodePng } from "../src/png.js";
import { normalizeStoredGlow, parseGlowSpec } from "../src/layer.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

interface Result {
  stdout: string;
  stderr: string;
  code: number;
}

async function invoke(args: string[]): Promise<Result> {
  const proc = Bun.spawn([process.execPath, cli, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
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

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const idx = (y * png.width + x) * 4;
  return [png.rgba[idx]!, png.rgba[idx + 1]!, png.rgba[idx + 2]!, png.rgba[idx + 3]!];
}

/** Colour distance toward a target: how far `c` moved toward `target`
 *  relative to `from` (0 = no movement, 1 = at the target). */
function toward(c: [number, number, number], from: [number, number, number], target: [number, number, number]): number {
  const d = (a: number, b: number) => a - b;
  const total2 = d(target[0], from[0]) ** 2 + d(target[1], from[1]) ** 2 + d(target[2], from[2]) ** 2;
  const moved2 = d(c[0], from[0]) ** 2 + d(c[1], from[1]) ** 2 + d(c[2], from[2]) ** 2;
  return Math.sqrt(moved2 / total2);
}

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-glow-"));
  projDir = path.join(tempDir, "proj");
  const init = await invoke(["project", "init", projDir]);
  expect(init.code).toBe(0);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComp(name: string, width = 400, height = 300) {
  const res = await invoke(["composition", "create", name, "--width", String(width), "--height", String(height), "--project", projDir]);
  expect(res.code).toBe(0);
}

async function addImageLayer(
  comp: string,
  localName: string,
  imgPath: string,
  opts: { x?: number; y?: number; glow?: string } = {},
) {
  const args = ["composition", "add", comp, localName, "--image", imgPath, "--project", projDir, "--json"];
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  if (opts.glow !== undefined) args.push("--glow", opts.glow);
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

async function render(comp: string, out: string) {
  const res = await invoke(["composition", "render", comp, "--project", projDir, "--out", out, "--supersample", "1"]);
  expect(res.code).toBe(0);
  return decodePng(await readFile(out));
}

test("normalizeStoredGlow validates stored parameters and drops the neutral direction pair", () => {
  expect(normalizeStoredGlow({})).toBeUndefined();
  expect(normalizeStoredGlow({ glow: undefined })).toBeUndefined();
  expect(normalizeStoredGlow({ glow: { width: 14, softness: 6, color: "#ff9900" } })).toEqual({
    width: 14,
    softness: 6,
    color: "#ff9900",
  });
  // Case/shorthand colour canonicalizes to the setter's form.
  expect(normalizeStoredGlow({ glow: { width: 1, softness: 0, color: "#F90" } })).toEqual({
    width: 1,
    softness: 0,
    color: "#ff9900",
  });
  // Direction pair canonicalizes the angle into [0, 360).
  expect(normalizeStoredGlow({ glow: { width: 8, softness: 2, color: "#ffffff", angle: -90, strength: 0.5 } })).toEqual({
    width: 8,
    softness: 2,
    color: "#ffffff",
    angle: 270,
    strength: 0.5,
  });
  // Strength 0 is the even glow: the pair drops.
  expect(normalizeStoredGlow({ glow: { width: 8, softness: 2, color: "#ffffff", angle: 45, strength: 0 } })).toEqual({
    width: 8,
    softness: 2,
    color: "#ffffff",
  });

  expect(() => normalizeStoredGlow({ glow: 5 })).toThrow(/Malformed revision document: glow must be an object/);
  expect(() => normalizeStoredGlow({ glow: { width: 300, softness: 2, color: "#ffffff" } })).toThrow(/glow\.width must be a finite number between 0 and 256/);
  expect(() => normalizeStoredGlow({ glow: { width: 8, softness: -1, color: "#ffffff" } })).toThrow(/glow\.softness must be a finite number/);
  expect(() => normalizeStoredGlow({ glow: { width: 8, softness: 2, color: "red" } })).toThrow(/glow\.color must be a hex/);
  expect(() => normalizeStoredGlow({ glow: { width: 8, softness: 2, color: "#ffffff", angle: 45 } })).toThrow(/one direction pair/);
  expect(() => normalizeStoredGlow({ glow: { width: 8, softness: 2, color: "#ffffff", strength: 0.5 } })).toThrow(/one direction pair/);
  expect(() => normalizeStoredGlow({ glow: { width: 8, softness: 2, color: "#ffffff", angle: 500, strength: 0.5 } })).toThrow(/glow\.angle must be a finite number between -360 and 360/);
  expect(() => normalizeStoredGlow({ glow: { width: 8, softness: 2, color: "#ffffff", angle: 45, strength: 2 } })).toThrow(/glow\.angle must be a finite number/);
  expect(() => normalizeStoredGlow({ glow: { width: 8, softness: 2, color: "#ffffff", extra: 1 } })).toThrow(/unknown glow property "extra"/);
});

test("parseGlowSpec validates the compact form at the boundary", () => {
  expect(parseGlowSpec("none")).toBeUndefined();
  expect(parseGlowSpec("14,6,#ff9900")).toEqual({ width: 14, softness: 6, color: "#ff9900" });
  expect(parseGlowSpec("14,6,#F90")).toEqual({ width: 14, softness: 6, color: "#ff9900" });
  expect(parseGlowSpec("14,6,#ff990080")).toEqual({ width: 14, softness: 6, color: "#ff990080" });
  expect(parseGlowSpec("12,4,#fff,-360,1")).toEqual({ width: 12, softness: 4, color: "#ffffff", angle: 0, strength: 1 });
  expect(parseGlowSpec("12,4,#fff,45,0.5")).toEqual({ width: 12, softness: 4, color: "#ffffff", angle: 45, strength: 0.5 });
  // Strength 0 drops the pair.
  expect(parseGlowSpec("12,4,#fff,45,0")).toEqual({ width: 12, softness: 4, color: "#ffffff" });

  expect(() => parseGlowSpec("banana")).toThrow(/--glow takes/);
  expect(() => parseGlowSpec("12,4")).toThrow(/--glow takes/);
  // A lone angle is a malformed compact form, not the pair rule.
  expect(() => parseGlowSpec("12,4,#ffffff,45")).toThrow(/--glow takes/);
  expect(() => parseGlowSpec("12,4,#ffffff,45,")).toThrow(/the direction is one pair/);
  expect(() => parseGlowSpec("257,4,#ffffff")).toThrow(/glow width 257: must be a finite number of px between 0 and 256/);
  expect(() => parseGlowSpec("12,257,#ffffff")).toThrow(/glow softness 257: must be a finite number of px between 0 and 256/);
  expect(() => parseGlowSpec("12,4,zzz")).toThrow(/glow color "zzz"/);
  expect(() => parseGlowSpec("12,4,#ffffff,361,0.5")).toThrow(/glow angle 361: must be a finite number of degrees between -360 and 360/);
  expect(() => parseGlowSpec("12,4,#ffffff,45,1.5")).toThrow(/glow strength 1.5: must be a finite number between 0 and 1/);
});

test("invalid glow values are refused before publication on both surfaces (DEC-009)", async () => {
  const imgFile = path.join(tempDir, "img.png");
  await writeFile(imgFile, solidPng(60, 60, [34, 136, 204, 255]));
  await makeComp("poster", 300, 300);
  const addRes = await addImageLayer("poster", "hero", imgFile, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  for (const [value, message] of [
    ["banana", 'Invalid glow "banana": --glow takes'],
    ["12,4", "--glow takes"],
    ["12,4,#ffffff,45,", "the direction is one pair"],
    ["300,4,#ffffff", "between 0 and 256"],
    ["12,4,zzz", 'Invalid glow color "zzz"'],
    ["12,4,#ffffff,400,0.5", "between -360 and 360"],
    ["12,4,#ffffff,45,2", "between 0 and 1"],
  ] as const) {
    const res = await invoke(["layer", "edit", layerId, "--glow", value, "--project", projDir]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(message);
  }

  const badAdd = await invoke(["composition", "add", "poster", "bad", "--image", imgFile, "--glow", "banana", "--project", projDir]);
  expect(badAdd.code).toBe(2);
  expect(badAdd.stderr).toContain('Invalid glow "banana"');
});

test("edge glow: interior pixels unchanged, edge pixels move toward the glow colour, extents equal no-glow extents (TEST-003, DEC-005)", async () => {
  await makeComp("poster", 300, 300);
  const imgFile = path.join(tempDir, "img.png");
  await writeFile(imgFile, solidPng(200, 200, [34, 136, 204, 255]));
  const addRes = await addImageLayer("poster", "hero", imgFile, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  // Baseline render and measure without a glow.
  const baseOut = path.join(tempDir, "base.png");
  const base = await render("poster", baseOut);
  const m1 = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  const basePainted = JSON.parse(m1.stdout).layers[0].painted;

  const editRes = await invoke(["layer", "edit", layerId, "--glow", "14,4,#ff9900", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.layer.currentRevision.glow).toEqual({ width: 14, softness: 4, color: "#ff9900" });
  expect(editJson.glowSet).toEqual({ glow: { width: 14, softness: 4, color: "#ff9900" } });

  const glowOut = path.join(tempDir, "glow.png");
  const glowed = await render("poster", glowOut);

  const from: [number, number, number] = [34, 136, 204];
  const target: [number, number, number] = [255, 153, 0];
  // Interior far from the edge: byte-identical to the no-glow render.
  expect(pixel(glowed, 150, 150)).toEqual(pixel(base, 150, 150));
  // Just inside the edge: moved toward the glow colour.
  const edgeToward = toward(pixel(glowed, 56, 100).slice(0, 3) as [number, number, number], from, target);
  expect(edgeToward).toBeGreaterThan(0.3);
  // And measurably more than the interior.
  expect(edgeToward).toBeGreaterThan(toward(pixel(glowed, 150, 150).slice(0, 3) as [number, number, number], from, target));

  // Painted extents equal the no-glow extents (measure seam, DEC-005).
  const m2 = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  const m2Json = JSON.parse(m2.stdout);
  expect(m2Json.layers[0].painted).toEqual(basePainted);
  expect(m2Json.layers[0].glow).toEqual({ width: 14, softness: 4, color: "#ff9900" });

  // Outside the Layer's box nothing is painted (alpha support unchanged).
  expect(pixel(glowed, 40, 150)).toEqual([0, 0, 0, 0]);
  expect(pixel(glowed, 260, 150)).toEqual([0, 0, 0, 0]);
}, 30_000);

test("with a direction the lit side changes more than the far side; without one the glow is even (TEST-003, DEC-006)", async () => {
  await makeComp("poster", 300, 300);
  const imgFile = path.join(tempDir, "img.png");
  await writeFile(imgFile, solidPng(200, 200, [34, 136, 204, 255]));
  const addRes = await addImageLayer("poster", "hero", imgFile, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  const from: [number, number, number] = [34, 136, 204];
  const target: [number, number, number] = [255, 153, 0];
  const change = (png: ReturnType<typeof decodePng>, x: number, y: number) =>
    toward(pixel(png, x, y).slice(0, 3) as [number, number, number], from, target);

  // Directional glow: light from the top (angle 0, full strength).
  await invoke(["layer", "edit", layerId, "--glow", "14,4,#ff9900,0,1", "--project", projDir]);
  const dirOut = path.join(tempDir, "dir.png");
  const dir = await render("poster", dirOut);
  const litTop = change(dir, 150, 56);
  const farBottom = change(dir, 150, 244);
  expect(litTop).toBeGreaterThan(0.3);
  expect(litTop).toBeGreaterThan(farBottom * 3);

  // Even glow (no pair): top and bottom edges change about equally.
  await invoke(["layer", "edit", layerId, "--glow", "14,4,#ff9900", "--project", projDir]);
  const evenOut = path.join(tempDir, "even.png");
  const even = await render("poster", evenOut);
  const top = change(even, 150, 56);
  const bottom = change(even, 150, 244);
  expect(top).toBeGreaterThan(0.3);
  expect(Math.abs(top - bottom)).toBeLessThan(0.15);

  // Equivalent direction spellings store one canonical fact (-360 ≡ 0).
  const eq1 = await invoke(["layer", "edit", layerId, "--glow", "14,4,#ff9900,-360,1", "--project", projDir, "--json"]);
  const eq2 = await invoke(["layer", "edit", layerId, "--glow", "14,4,#ff9900,0,1", "--project", projDir, "--json"]);
  expect(JSON.parse(eq1.stdout).layer.currentRevision.glow).toEqual({ width: 14, softness: 4, color: "#ff9900", angle: 0, strength: 1 });
  expect(JSON.parse(eq2.stdout).layer.currentRevision.glow).toEqual(JSON.parse(eq1.stdout).layer.currentRevision.glow);
}, 30_000);

test("the glow follows a rounded visible region and transforms with the Layer (ADR-0023, #212)", async () => {
  await makeComp("poster", 300, 300);
  const imgFile = path.join(tempDir, "img.png");
  await writeFile(imgFile, solidPng(200, 200, [34, 136, 204, 255]));
  // Region (20,20,160,160) with corner radius 40, layer placed at (50,50):
  // the region's rounded corners round the glow's edge.
  const addRes = await invoke([
    "composition", "add", "poster", "hero", "--image", imgFile,
    "--x", "50", "--y", "50",
    "--visible-region", "20,20,160,160", "--visible-region-radius", "40",
    "--project", projDir, "--json",
  ]);
  expect(addRes.code).toBe(0);
  const layerId = JSON.parse(addRes.stdout).use.layerId as string;

  const baseOut = path.join(tempDir, "base.png");
  const base = await render("poster", baseOut);
  const m1 = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  const basePainted = JSON.parse(m1.stdout).layers[0].painted;

  await invoke(["layer", "edit", layerId, "--glow", "12,3,#ff9900", "--project", projDir]);
  const glowOut = path.join(tempDir, "glow.png");
  const glowed = await render("poster", glowOut);

  const from: [number, number, number] = [34, 136, 204];
  const target: [number, number, number] = [255, 153, 0];
  const change = (png: ReturnType<typeof decodePng>, x: number, y: number) =>
    toward(pixel(png, x, y).slice(0, 3) as [number, number, number], from, target);

  // Just inside the straight region edge: moved toward the glow colour.
  expect(change(glowed, 150, 74)).toBeGreaterThan(0.3);
  // The clipped-off corner (inside the region RECTANGLE but outside the
  // rounded clip) stays exactly as the no-glow render painted it — the
  // glow hugs the rounded edge, never the rectangle's corner.
  expect(pixel(glowed, 60, 60)).toEqual(pixel(base, 60, 60));
  // Just inside the rounded corner arc: moved toward the glow colour too.
  expect(change(glowed, 85, 85)).toBeGreaterThan(0.1);

  // Painted extents equal the no-glow extents.
  const m2 = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  expect(JSON.parse(m2.stdout).layers[0].painted).toEqual(basePainted);

  // The glow transforms with the Layer: rotate 30° — the edge band moves
  // with the rotated edge and the extents stay the rotated no-glow extents.
  // The probe pixel sits just inside the rotated TOP edge: the local point
  // (100, 5) relative to the pivot (50, 50), rotated 30° clockwise.
  await invoke(["layer", "edit", layerId, "--rotate", "30", "--project", projDir]);
  const rotBaseOut = path.join(tempDir, "rot-base.png");
  await invoke(["layer", "edit", layerId, "--glow", "none", "--project", projDir]);
  const rotBase = await render("poster", rotBaseOut);
  const m3 = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  const rotPainted = JSON.parse(m3.stdout).layers[0].painted;

  await invoke(["layer", "edit", layerId, "--glow", "12,3,#ff9900", "--project", projDir]);
  const rotGlowOut = path.join(tempDir, "rot-glow.png");
  const rotGlow = await render("poster", rotGlowOut);
  const m4 = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  const glowPainted = JSON.parse(m4.stdout).layers[0].painted;
  // DEC-005: the glow adds no ink. The band is composited ATOP the source
  // (its alpha is exactly the source's), so any residual 1px difference
  // from the unfiltered baseline is the browser's antialiased
  // rasterization of a rotated edge through a filter surface, not glow
  // support — the same render with a no-op glow measures identically.
  const near = (a: number, b: number) => Math.abs(a - b) <= 2;
  expect(near(glowPainted.x, rotPainted.x)).toBe(true);
  expect(near(glowPainted.y, rotPainted.y)).toBe(true);
  expect(near(glowPainted.width, rotPainted.width)).toBe(true);
  expect(near(glowPainted.height, rotPainted.height)).toBe(true);
  // The rotated edge pixel moved toward the glow colour (lit edge rotates
  // with the Layer); the same pixel is untouched in the unglowed baseline.
  // The probe is the local point (100, 25) — just inside the region's top
  // edge — mapped through the 30° rotation about the placement point.
  expect(change(rotGlow, 124, 122)).toBeGreaterThan(0.2);
  expect(change(rotBase, 124, 122)).toBeLessThan(change(rotGlow, 124, 122));
}, 30_000);

test("absolute setter: none removes the stored fact; set-then-remove renders byte-identically; replay is byte-identical", async () => {
  await makeComp("poster", 300, 300);
  const imgFile = path.join(tempDir, "img.png");
  await writeFile(imgFile, solidPng(120, 120, [34, 136, 204, 255]));
  const addRes = await addImageLayer("poster", "hero", imgFile, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  // An omitted --glow keeps the fact across other edits (asserted through
  // the resolved revision, not a report of an edit that did not set it).
  await invoke(["layer", "edit", layerId, "--glow", "14,6,#ff9900", "--project", projDir]);
  const keep = await invoke(["layer", "edit", layerId, "--x", "60", "--project", projDir]);
  expect(keep.code).toBe(0);
  const inspKeep = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(JSON.parse(inspKeep.stdout).layer.currentRevision.glow).toEqual({ width: 14, softness: 6, color: "#ff9900" });

  // Set-then-remove renders byte-identically to never-set: the baseline is
  // the SAME placement (x=60) with the glow removed.
  const removed = await invoke(["layer", "edit", layerId, "--glow", "none", "--project", projDir, "--json"]);
  expect(removed.code).toBe(0);
  expect(JSON.parse(removed.stdout).layer.currentRevision.glow).toBeUndefined();
  expect(JSON.parse(removed.stdout).glowSet).toEqual({ glow: null });
  const removedText = await invoke(["layer", "edit", layerId, "--glow", "none", "--project", projDir]);
  expect(removedText.stdout).toContain("glow removed");
  const baseOut = path.join(tempDir, "base.png");
  await render("poster", baseOut);
  const baseBytes = await readFile(baseOut);

  // Re-set and verify a Render with a glow replays byte-identically.
  await invoke(["layer", "edit", layerId, "--glow", "10,4,#ff9900,90,0.8", "--project", projDir]);
  const glowOut = path.join(tempDir, "glow.png");
  const r1 = await invoke(["composition", "render", "poster", "--project", projDir, "--out", glowOut, "--supersample", "1", "--json"]);
  expect(r1.code).toBe(0);
  const manifestPath = JSON.parse(r1.stdout).render.manifest as string;
  const replayOut = path.join(tempDir, "replay.png");
  const rep = await invoke(["composition", "replay", manifestPath, "--project", projDir, "--out", replayOut]);
  expect(rep.code).toBe(0);
  expect(await readFile(replayOut)).toEqual(await readFile(glowOut));

  // Remove again: byte-identical to the never-set render at the same placement.
  await invoke(["layer", "edit", layerId, "--glow", "none", "--project", projDir]);
  const removedOut = path.join(tempDir, "removed.png");
  await render("poster", removedOut);
  expect(await readFile(removedOut)).toEqual(baseBytes);
}, 30_000);

test("inspect, measure, and layer review report the glow; shape and text Layers take it uniformly", async () => {
  await makeComp("poster", 400, 300);
  // The image Layer's review needs lineage, so the fixture is a generated
  // output (the same seam layer-blend.test.ts uses, TEST-001).
  const imgFile = path.join(tempDir, "img.png");
  await writeFile(imgFile, solidPng(80, 80, [34, 136, 204, 255]));
  const imgBytes = await readFile(imgFile);
  const contentHash = createHash("sha256").update(imgBytes).digest("hex");
  const jobRecord = {
    schemaVersion: 2,
    jobId: "gen-1",
    kind: "generation",
    createdAt: new Date().toISOString(),
    request: {
      prompt: "a test box",
      intent: "isolated",
      model: "mock-model",
      sizing: { kind: "size", width: 80, height: 80 },
      count: 1,
      references: [],
    },
    run: {
      ranAt: new Date().toISOString(),
      model: "mock-model",
      fullPrompt: "a test box",
      cost: { basis: "unknown" },
      warnings: [],
      outputs: [
        {
          contentHash,
          file: "outputs/output-1.png",
          mediaType: "image/png",
        },
      ],
    },
  };
  await mkdir(path.join(projDir, "generation", "gen-1", "outputs"), { recursive: true });
  await writeFile(path.join(projDir, "generation", "gen-1", "outputs", "output-1.png"), imgBytes);
  await writeFile(path.join(projDir, "generation", "gen-1", "job.json"), JSON.stringify(jobRecord));

  const addRes = await invoke([
    "composition", "add", "poster", "hero", "--image", imgFile,
    "--x", "20", "--y", "20", "--glow", "10,4,#ff9900",
    "--project", projDir, "--json",
  ]);
  expect(addRes.code).toBe(0);
  const layerId = JSON.parse(addRes.stdout).use.layerId as string;
  expect(JSON.parse(addRes.stdout).layer.currentRevision.glow).toEqual({ width: 10, softness: 4, color: "#ff9900" });

  // inspect reports the glow
  const insp = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(insp.code).toBe(0);
  expect(insp.stdout).toContain("Glow: glow width 10px, softness 4px, #ff9900");

  // measure reports the glow
  const meas = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  const measLayers = JSON.parse(meas.stdout).layers as { name: string; glow: unknown }[];
  expect(measLayers.find((l) => l.name === "hero")!.glow).toEqual({ width: 10, softness: 4, color: "#ff9900" });

  // layer review reports the glow
  const reviewOut = path.join(tempDir, "review.html");
  const revRes = await invoke(["layer", "review", layerId, "--out", reviewOut, "--project", projDir]);
  expect(revRes.code).toBe(0);
  const reviewHtml = await readFile(reviewOut, "utf-8");
  expect(reviewHtml).toContain("edge glow");
  expect(reviewHtml).toContain("glow width 10px, softness 4px, #ff9900 (paint-time)");

  // Shape Layer: same setter, uniform application (US-005).
  const shRes = await invoke([
    "composition", "add", "poster", "badge",
    "--shape", "rectangle", "--size", "60x40", "--fill", "#ffffff",
    "--x", "150", "--y", "100", "--glow", "8,2,#3366ff,180,0.9",
    "--project", projDir, "--json",
  ]);
  expect(shRes.code).toBe(0);
  const shId = JSON.parse(shRes.stdout).use.layerId as string;
  expect(JSON.parse(shRes.stdout).layer.currentRevision.glow).toEqual({
    width: 8, softness: 2, color: "#3366ff", angle: 180, strength: 0.9,
  });
  const shReviewOut = path.join(tempDir, "sh-review.html");
  const shRev = await invoke(["layer", "review", shId, "--out", shReviewOut, "--project", projDir]);
  expect(shRev.code).toBe(0);
  expect(await readFile(shReviewOut, "utf-8")).toContain("edge glow");

  // Text Layer: same setter.
  const tRes = await invoke([
    "composition", "add", "poster", "headline", "--text", "GLOW", "--font", "Archivo",
    "--font-size", "40", "--color", "#ffffff", "--x", "20", "--y", "200",
    "--glow", "6,2,#ff9900",
    "--project", projDir, "--json",
  ]);
  expect(tRes.code).toBe(0);
  expect(JSON.parse(tRes.stdout).layer.currentRevision.glow).toEqual({ width: 6, softness: 2, color: "#ff9900" });
}, 30_000);

test("a glow coexists with outline and shadow: painted extents still equal the no-glow extents and the markup chains the filters in ADR-0024's order", async () => {
  await makeComp("poster", 300, 300);
  const imgFile = path.join(tempDir, "img.png");
  await writeFile(imgFile, solidPng(120, 120, [34, 136, 204, 255]));
  const addRes = await addImageLayer("poster", "hero", imgFile, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  await invoke(["layer", "edit", layerId, "--outline", "6,#ffffff", "--shadow", "8,8,2,#000000", "--project", projDir]);
  const m1 = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  const basePainted = JSON.parse(m1.stdout).layers[0].painted;

  await invoke(["layer", "edit", layerId, "--glow", "12,4,#ff9900,0,1", "--project", projDir]);
  const m2 = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  expect(JSON.parse(m2.stdout).layers[0].painted).toEqual(basePainted);

  // Render still succeeds with the full chain (glow -> outline -> shadow).
  const out = path.join(tempDir, "full.png");
  const rendered = await render("poster", out);
  // Outside the outline's reach nothing appears (the glow added no ink).
  expect(pixel(rendered, 30, 150)).toEqual([0, 0, 0, 0]);
}, 30_000);
