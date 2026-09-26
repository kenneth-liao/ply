/**
 * Unit measure and inspect reporting (ADR-0026 §4, #307): measure reports
 * the unit like any Layer AND as a unit naming its inner Composition. The
 * unit's content box is the inner Composition's canvas (§3 bounds); the
 * pre-effect ink (the ADR-0017 anchor basis, as amended by #288) is the
 * composite's alpha — the members' own effects are part of that composite,
 * so they count as the unit's ink. Measuring a member means measuring it in
 * the inner Composition.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-unit-measure-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "unit-measure-proj"]);
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

/** inner: a 160x80 card at (20,20) and a text member; outer: unit at (50,40). */
async function makeCardUnit(withMemberEffect = false): Promise<string> {
  await makeComp("inner", 200, 120);
  let res = await invoke([
    "composition", "add", "inner", "card", "--shape", "rectangle", "--size", "160x80",
    "--fill", "#cc2222", "--x", "20", "--y", "20", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  res = await invoke([
    "composition", "add", "inner", "mark", "--text", "PLY", "--font", "Anton",
    "--font-size", "40", "--color", "#ffffff", "--x", "60", "--y", "35",
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  if (withMemberEffect) {
    res = await invoke(["layer", "edit", "inner/card", "--shadow", "12,12,0,#000000", "--project", projDir, "--json"]);
    expect(res.code).toBe(0);
  }
  await makeComp("outer", 400, 300);
  res = await invoke([
    "composition", "add", "outer", "tile", "--unit", "inner",
    "--x", "50", "--y", "40", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).use.layerId as string;
}

test("measure reports the unit as a unit naming its inner Composition, content box = inner canvas", async () => {
  const layerId = await makeCardUnit();
  const res = await invoke(["composition", "measure", "outer", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const out = JSON.parse(res.stdout);
  expect(out.layers).toHaveLength(1);
  const m = out.layers[0];
  expect(m.kind).toBe("unit");
  expect(m.unit).toEqual({ composition: "inner" });
  // The unit's content box is the inner Composition's canvas (§3 bounds).
  expect(m.content).toEqual({ width: 200, height: 120 });
  // The untransformed content rectangle at (50, 40): the layout box.
  expect(m.box).toEqual({ x: 50, y: 40, width: 200, height: 120 });
  // Placement facts ride the report like any kind.
  expect(m.placement).toEqual({ x: 50, y: 40, opacity: 1 });
  expect(m.transform.scaleX).toBe(1);
  expect(m.transform.rotationDeg).toBe(0);
});

test("measure reports the unit's painted ink: the composite's alpha, including the members' own effects", async () => {
  await makeComp("inner", 200, 120);
  let res = await invoke([
    "composition", "add", "inner", "card", "--shape", "rectangle", "--size", "160x80",
    "--fill", "#cc2222", "--x", "20", "--y", "20", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  await makeComp("outer", 400, 300);
  res = await invoke([
    "composition", "add", "outer", "tile", "--unit", "inner",
    "--x", "50", "--y", "40", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  res = await invoke(["composition", "measure", "outer", "--project", projDir, "--json"]);
  const withoutEffect = JSON.parse(res.stdout).layers[0];
  // The composite is the inner canvas's ink: the card's ink spans inner
  // (20..180, 20..100) → canvas (70..230, 60..140).
  expect(withoutEffect.painted).toEqual({ x: 70, y: 60, width: 160, height: 80 });

  // A member's shadow is part of the composite (ADR-0026 §4): the unit's
  // painted extents grow by the member's shadow reach.
  res = await invoke(["layer", "edit", "inner/card", "--shadow", "12,12,0,#000000", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  res = await invoke(["composition", "measure", "outer", "--project", projDir, "--json"]);
  const withEffect = JSON.parse(res.stdout).layers[0];
  expect(withEffect.painted.width).toBeGreaterThan(withoutEffect.painted.width);
  expect(withEffect.painted.height).toBeGreaterThan(withoutEffect.painted.height);
  // The shadow falls +12,+12: the left/top edges stay, the right/bottom
  // edges reach past the composite's ink.
  expect(withEffect.painted.x).toBe(70);
  expect(withEffect.painted.y).toBe(60);
  expect(withEffect.painted.x + withEffect.painted.width).toBeGreaterThan(230);
  expect(withEffect.painted.y + withEffect.painted.height).toBeGreaterThan(140);
});

test("measure reflects the unit's transform: a rotated unit's box and painted extents move", async () => {
  const layerId = await makeCardUnit();
  const res0 = await invoke(["composition", "measure", "outer", "--project", projDir, "--json"]);
  const before = JSON.parse(res0.stdout).layers[0];
  const rot = await invoke(["layer", "edit", "outer/tile", "--rotate", "20", "--project", projDir, "--json"]);
  expect(rot.code).toBe(0);
  const res1 = await invoke(["composition", "measure", "outer", "--project", projDir, "--json"]);
  const after = JSON.parse(res1.stdout).layers[0];
  expect(after.transform.rotationDeg).toBe(20);
  // The content box is untransformed; the bounding box corners rotate.
  expect(after.content).toEqual(before.content);
  expect(after.box.width).toBeGreaterThan(after.content.width);
  // The painted ink moved with the rotation.
  expect(after.painted.y).toBeGreaterThan(before.painted.y);
});

test("measuring a member means measuring it in the inner Composition", async () => {
  const layerId = await makeCardUnit();
  const res = await invoke(["composition", "measure", "inner", "card", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const out = JSON.parse(res.stdout);
  const card = out.layers[0];
  expect(card.kind).toBe("shape");
  expect(card.box).toEqual({ x: 20, y: 20, width: 160, height: 80 });
  void layerId;
});

test("measure refuses a unit whose inner Composition is missing, naming it", async () => {
  await makeCardUnit();
  await unlink(path.join(projDir, "compositions", "inner.json"));
  const res = await invoke(["composition", "measure", "outer", "--project", projDir, "--json"]);
  expect(res.code).not.toBe(0);
  expect(res.stdout + res.stderr).toContain("inner");
});

test("layer review of a unit publishes its facts sheet (live reference, no retained pixels)", async () => {
  const layerId = await makeCardUnit();
  const out = path.join(tempDir, "review.png");
  const res = await invoke(["layer", "review", layerId, "--out", out, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const body = JSON.parse(res.stdout);
  expect(body.layer).toBe(layerId);
  // The sheet exists as a real PNG (the shape-precedent facts sheet — a
  // unit has no retained bytes to review and none are invented).
  const png = await readFile(out);
  expect(png.length).toBeGreaterThan(100);
});
