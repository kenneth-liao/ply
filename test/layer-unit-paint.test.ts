/**
 * Unit paint (ADR-0026 §4, spec #285 US-018/ISC-36, #307): the inner
 * Composition is composited at paint time — members in its use order with
 * their own facts — and that composite is the unit Layer's content (step 1
 * of the ADR-0024 order). The unit's own transform, opacity, grade, and
 * blend then apply to the composite as ONE Layer, which blends against the
 * outer backdrop. Painted at the size it appears and the Render's
 * supersample factor (ADR-0022) — never rasterized at the inner canvas size
 * and resampled. The composite is never stored.
 *
 * Cells: the ISC-36 probe (one edit rotates every member; each member stays
 * individually editable and the reference is live), scaled-up sharpness,
 * isolated blending inside vs against the outer backdrop, unit grade and
 * opacity over the composite, the mask boundary in both directions, and the
 * loud missing-inner and paint-time cycle refusals.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
    buf[i] = rgba[0]; buf[i + 1] = rgba[1]; buf[i + 2] = rgba[2]; buf[i + 3] = rgba[3];
  }
  return encodePngRgba(width, height, buf);
}

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const close = (a: number, b: number, tol = 6) => Math.abs(a - b) <= tol;

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-unit-paint-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "unit-paint-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComp(name: string, width: number, height: number) {
  const res = await invoke([
    "composition", "create", name, "--width", String(width), "--height", String(height),
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
}

/** The card+wordmark unit: inner has a red card (shape) and a white
 *  wordmark (text); outer places a unit of inner at (50, 40). */
async function makeCardUnit(): Promise<string> {
  await makeComp("inner", 200, 120);
  let res = await invoke([
    "composition", "add", "inner", "card", "--shape", "rectangle", "--size", "160x80",
    "--fill", "#ff0000", "--x", "20", "--y", "20", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  res = await invoke([
    "composition", "add", "inner", "mark", "--text", "PLY", "--font", "Anton",
    "--font-size", "40", "--color", "#ffffff", "--x", "60", "--y", "35",
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  await makeComp("outer", 400, 300);
  res = await invoke([
    "composition", "add", "outer", "tile", "--unit", "inner",
    "--x", "50", "--y", "40", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).use.layerId as string;
}

async function render(comp: string, out: string, extra: string[] = []) {
  const res = await invoke(["composition", "render", comp, "--out", out, "--project", projDir, "--json", ...extra]);
  expect(res.code).toBe(0);
  return decodePng(await readFile(out));
}

test("the ISC-36 probe: one --rotate edit turns the card and its wordmark together", async () => {
  const layerId = await makeCardUnit();
  const out0 = path.join(tempDir, "r0.png");
  const png0 = await render("outer", out0);
  // Unrotated: the unit paints at (50, 40); the card (20..180, 20..100 inner)
  // lands at (70..230, 60..140) on the outer canvas.
  expect(pixel(png0, 75, 65)[0]).toBeGreaterThan(200); // red card interior
  expect(pixel(png0, 75, 65)[1]).toBeLessThan(80);

  const rot = await invoke(["layer", "edit", `outer/tile`, "--rotate", "20", "--project", projDir, "--json"]);
  expect(rot.code).toBe(0);

  const out1 = path.join(tempDir, "r1.png");
  const png1 = await render("outer", out1);
  // The rotation about the placement point moves the card's far corners: the
  // old top-right interior (near 225, 65) leaves; ink appears below the old
  // bottom edge (the rotated card sweeps down-left). Both members moved
  // together — the SAME single edit.
  expect(pixel(png1, 225, 65)[3]).toBeLessThan(200);
  expect(pixel(png1, 75, 145)[3]).toBeGreaterThan(120);

  // Visual evidence retained for the probe review.
  await writeFile(path.join(tempDir, "probe-unrotated.png"), await readFile(out0));
  await writeFile(path.join(tempDir, "probe-rotated.png"), await readFile(out1));
});

test("each member stays individually editable and the unit is a live reference", async () => {
  await makeCardUnit();
  // Edit a member IN the inner Composition: recolour the card to blue.
  const res = await invoke([
    "layer", "edit", "inner/card", "--fill", "#0000ff", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);

  const png = await render("outer", path.join(tempDir, "live.png"));
  // The unit's pixels updated WITHOUT touching the unit Layer's revision.
  expect(pixel(png, 75, 65)[2]).toBeGreaterThan(200);
  expect(pixel(png, 75, 65)[0]).toBeLessThan(80);
});

test("members composite in the inner use order inside the unit", async () => {
  await makeCardUnit();
  // The white wordmark paints OVER the red card (later use): the glyph
  // interior is white where the text sits on the card.
  const png = await render("outer", path.join(tempDir, "order.png"));
  // The text baseline area: a white glyph pixel inside the card region.
  let whiteFound = false;
  for (let y = 60; y < 140 && !whiteFound; y++) {
    for (let x = 70; x < 230 && !whiteFound; x++) {
      const [r, g, b, a] = pixel(png, x, y);
      if (a === 255 && r > 240 && g > 240 && b > 240) whiteFound = true;
    }
  }
  expect(whiteFound).toBe(true);
});

test("a scaled-up unit stays as sharp as directly placed members (ADR-0022)", async () => {
  const layerId = await makeCardUnit();
  // Unit at scale 2: painted at inner canvas × 2 × supersample device px.
  const res = await invoke(["layer", "edit", `outer/tile`, "--scale", "2", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const unitPng = await render("outer", path.join(tempDir, "scaled-unit.png"), ["--supersample", "1"]);

  // A direct composition: the same members at 2x size — the sharpness
  // reference. The wordmark glyph edge's intermediate-alpha band must not
  // widen beyond the direct render's by more than a pixel (a resampled
  // 1x raster would blur the stroke edges visibly).
  await makeComp("direct", 400, 300);
  let res2 = await invoke([
    "composition", "add", "direct", "mark", "--text", "PLY", "--font", "Anton",
    "--font-size", "80", "--color", "#ffffff", "--x", "120", "--y", "70",
    "--project", projDir, "--json",
  ]);
  expect(res2.code).toBe(0);
  const directPng = await render("direct", path.join(tempDir, "direct.png"), ["--supersample", "1"]);

  // Scan a horizontal line through the first glyph's vertical stroke and
  // measure the widest run of intermediate alpha (0 < a < 255) — the
  // anti-aliasing band. A blurrier path paints a wider band.
  const bandWidth = (png: ReturnType<typeof decodePng>, y: number, x0: number, x1: number): number => {
    let widest = 0;
    let run = 0;
    for (let x = x0; x < x1; x++) {
      const a = pixel(png, x, y)[3];
      if (a > 0 && a < 255) {
        run++;
        widest = Math.max(widest, run);
      } else {
        run = 0;
      }
    }
    return widest;
  };
  // The unit's wordmark at 2x occupies roughly x 170..310, y 110..230; the
  // direct wordmark x 120..320, y 70..230. Scan several lines through the
  // glyphs and compare the MAXIMUM band each side.
  let unitMax = 0;
  let directMax = 0;
  for (let y = 130; y < 210; y += 6) {
    unitMax = Math.max(unitMax, bandWidth(unitPng, y, 160, 330));
    directMax = Math.max(directMax, bandWidth(directPng, y, 110, 330));
  }
  expect(unitMax).toBeLessThanOrEqual(directMax + 1);
});

test("the unit's opacity and grade apply to the composite as one Layer", async () => {
  const layerId = await makeCardUnit();
  // Half opacity over a blue backdrop: the card interior becomes a red/blue
  // mix, and the wordmark fades identically.
  let res = await invoke([
    "composition", "add", "outer", "bg", "--shape", "rectangle", "--size", "400x300",
    "--fill", "#0000ff", "--x", "0", "--y", "0", "--position", "bottom",
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  res = await invoke(["layer", "edit", `outer/tile`, "--opacity", "0.5", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const png = await render("outer", path.join(tempDir, "opacity.png"));
  const [r, g, b, a] = pixel(png, 75, 65);
  expect(a).toBe(255);
  expect(close(r, 128, 20)).toBe(true);
  expect(close(b, 128, 20)).toBe(true);
  expect(g).toBeLessThan(40);

  // Grade the unit: back to full opacity, recolour the member card to a
  // mid tone, then brightness 2 doubles the COMPOSITE's channels while the
  // blue backdrop stays untouched (the grade is the unit's).
  res = await invoke(["layer", "edit", `outer/tile`, "--opacity", "1", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  res = await invoke(["layer", "edit", "inner/card", "--fill", "#804000", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const ungraded = await render("outer", path.join(tempDir, "ungraded.png"));
  const [ur, ug] = pixel(ungraded, 75, 65);
  expect(close(ur, 128)).toBe(true);
  res = await invoke(["layer", "edit", `outer/tile`, "--brightness", "2", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const png2 = await render("outer", path.join(tempDir, "grade.png"));
  const [r2, g2, b2] = pixel(png2, 75, 65);
  expect(r2).toBeGreaterThan(230);
  expect(g2).toBeGreaterThan(110);
  expect(b2).toBeLessThan(30);
  // The backdrop is not the unit's content: untouched by the grade.
  expect(pixel(png2, 320, 200)[2]).toBeGreaterThan(200);
  void ur; void ug;
});

test("members blend against each other inside the unit; the unit blends as one against the outer backdrop", async () => {
  // Inner: red card, then a multiply white square over it — multiply over
  // red gives red (white multiply is identity), so the interior stays red
  // INSIDE the unit. Outer: blue backdrop, unit on top with multiply —
  // red × blue = black: the unit blends as ONE against the backdrop.
  await makeComp("inner", 200, 120);
  let res = await invoke([
    "composition", "add", "inner", "card", "--shape", "rectangle", "--size", "160x80",
    "--fill", "#ff0000", "--x", "20", "--y", "20", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  res = await invoke([
    "composition", "add", "inner", "veil", "--shape", "rectangle", "--size", "100x60",
    "--fill", "#ffffff", "--x", "50", "--y", "30", "--blend", "multiply",
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  await makeComp("outer", 400, 300);
  res = await invoke([
    "composition", "add", "outer", "bg", "--shape", "rectangle", "--size", "400x300",
    "--fill", "#0000ff", "--x", "0", "--y", "0", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  res = await invoke([
    "composition", "add", "outer", "tile", "--unit", "inner",
    "--x", "50", "--y", "40", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  // The unit's blend is an edit fact (placement only on add, ADR-0026 §4).
  res = await invoke(["layer", "edit", "outer/tile", "--blend", "multiply", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);

  const png = await render("outer", path.join(tempDir, "isolation.png"));
  // Inside the unit (over the card, under the veil): the veil's white
  // multiply over red stayed red INSIDE the unit (isolation) — then the
  // unit's red multiplied with the blue backdrop gives near-black.
  const [r, g, b] = pixel(png, 75, 65);
  expect(r).toBeLessThan(60);
  expect(g).toBeLessThan(60);
  expect(b).toBeLessThan(60);
  // A pixel the veil does not cover (card-only area): still red inside the
  // unit, so unit × backdrop = red × blue = near-black too — but the
  // ISOLATION evidence is the veil area: had the veil blended against the
  // BLUE backdrop directly (pass-through), white × blue = blue, then blue ×
  // blue = blue — a blue pixel there would prove leakage.
  const leak = pixel(png, 190, 75); // veil area, right side (inner x 140)
  expect(leak[2]).toBeLessThan(60);
});

test("the mask boundary: a member's mask resolves inside the unit", async () => {
  // Inside: the veil masks the card (the card is clipped to the veil's
  // alpha). The clip must appear in the unit's composite — a mask never
  // reaches across the unit boundary, but a member's own mask resolves
  // among its sibling members (ADR-0026 §4). (The unit as a masked use or
  // as a mask from outside takes the mask fact on a unit — a later ticket;
  // #307 refuses it by name, pinned in test/layer-unit-edit.test.ts.)
  await makeComp("inner", 200, 120);
  let res = await invoke([
    "composition", "add", "inner", "veil", "--shape", "rectangle", "--size", "100x60",
    "--fill", "#ffffff", "--x", "50", "--y", "30", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  res = await invoke([
    "composition", "add", "inner", "card", "--shape", "rectangle", "--size", "160x80",
    "--fill", "#ff0000", "--x", "20", "--y", "20", "--mask", "veil",
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  await makeComp("outer", 400, 300);
  res = await invoke([
    "composition", "add", "outer", "bg", "--shape", "rectangle", "--size", "400x300",
    "--fill", "#0000ff", "--x", "0", "--y", "0", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  res = await invoke([
    "composition", "add", "outer", "tile", "--unit", "inner",
    "--x", "50", "--y", "40", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const png = await render("outer", path.join(tempDir, "mask-inner.png"));
  // Inside the veil's rectangle: red (the masked card survived there).
  expect(pixel(png, 120, 80)[0]).toBeGreaterThan(200);
  // Outside the veil but inside the card: clipped INSIDE the unit — blue
  // backdrop shows through.
  expect(pixel(png, 90, 60)[2]).toBeGreaterThan(200);
});

test("a missing inner Composition refuses to paint, naming it — never an empty unit", async () => {
  await makeCardUnit();
  // Simulate the missing document directly in Project storage (the delete
  // command refuses while a unit refers; a hand edit can still lose it).
  await unlink(path.join(projDir, "compositions", "inner.json"));
  const res = await invoke([
    "composition", "render", "outer", "--out", path.join(tempDir, "missing.png"),
    "--project", projDir, "--json",
  ]);
  expect(res.code).not.toBe(0);
  expect(res.stdout + res.stderr).toContain("inner");
  expect(res.stdout + res.stderr).not.toBe("");
});

test("a paint-time cycle is refused, naming the chain", async () => {
  await makeCardUnit();
  // Hand-edit the documents to close a cycle the add surface can never
  // create: make a SECOND unit use inside inner that references outer
  // (inner → outer → inner).
  const innerDoc = JSON.parse(await readFile(path.join(projDir, "compositions", "inner.json"), "utf8"));
  const outerDoc = JSON.parse(await readFile(path.join(projDir, "compositions", "outer.json"), "utf8"));
  const unitLayerId = outerDoc.layers[0].layerId as string;
  innerDoc.layers.push({ name: "cycle", layerId: unitLayerId });
  await writeFile(
    path.join(projDir, "compositions", "inner.json"),
    JSON.stringify(innerDoc, null, 2) + "\n",
  );
  const res = await invoke([
    "composition", "render", "outer", "--out", path.join(tempDir, "cycle.png"),
    "--project", projDir, "--json",
  ]);
  expect(res.code).not.toBe(0);
  const body = res.stdout + res.stderr;
  expect(body).toContain("outer");
  expect(body).toContain("inner");
});
