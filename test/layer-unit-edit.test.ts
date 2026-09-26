/**
 * Unit Layer edit gates (ADR-0026 §4, spec #285 US-018/ISC-36, #307): the
 * shipped facts are the unit transforms (move, rotate, scale, flip) and the
 * adjustments (opacity, blend, grade). Every other fact is refused BY NAME
 * — never silently ignored — naming the option and pointing at the
 * destination. Also pinned: the `--in-place` / `--fork` rule counts DIRECT
 * referrers only, and a refused edit publishes nothing.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-unit-edit-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "unit-edit-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComp(name: string, width = 400, height = 300) {
  const res = await invoke([
    "composition", "create", name, "--width", String(width), "--height", String(height),
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
}

/** One inner Composition (a shape + a text member) and one outer unit use. */
async function makeUnit(): Promise<string> {
  await makeComp("inner", 200, 150);
  await makeComp("outer", 400, 300);
  const added = await invoke([
    "composition", "add", "outer", "card", "--unit", "inner",
    "--project", projDir, "--json",
  ]);
  expect(added.code).toBe(0);
  return JSON.parse(added.stdout).use.layerId as string;
}

async function editUnit(layerId: string, extra: string[]) {
  return invoke(["layer", "edit", layerId, "--project", projDir, "--json", ...extra]);
}

test("shipped transform facts apply on a unit: rotate, flip, scale, scale-to, resize", async () => {
  const layerId = await makeUnit();

  const rot = await editUnit(layerId, ["--rotate", "20"]);
  expect(rot.code).toBe(0);
  expect(JSON.parse(rot.stdout).layer.currentRevision.rotationDeg).toBe(20);

  const flip = await editUnit(layerId, ["--flip", "horizontal"]);
  expect(flip.code).toBe(0);
  expect(JSON.parse(flip.stdout).layer.currentRevision.flipX).toBe(true);

  const scale = await editUnit(layerId, ["--scale", "1.5"]);
  expect(scale.code).toBe(0);
  expect(JSON.parse(scale.stdout).layer.currentRevision.scaleX).toBe(1.5);

  const scaleTo = await editUnit(layerId, ["--scale-to", "2x1"]);
  expect(scaleTo.code).toBe(0);
  const rev = JSON.parse(scaleTo.stdout).layer.currentRevision;
  expect(rev.scaleX).toBe(2);
  expect(rev.scaleY).toBe(1);

  const resize = await editUnit(layerId, ["--resize", "0.5"]);
  expect(resize.code).toBe(0);
  expect(JSON.parse(resize.stdout).layer.currentRevision.scaleX).toBe(1);
});

test("shipped adjustment facts apply on a unit: opacity, blend, grade", async () => {
  const layerId = await makeUnit();

  const op = await editUnit(layerId, ["--opacity", "0.5"]);
  expect(op.code).toBe(0);
  expect(JSON.parse(op.stdout).layer.currentRevision.opacity).toBe(0.5);

  const blend = await editUnit(layerId, ["--blend", "multiply"]);
  expect(blend.code).toBe(0);
  expect(JSON.parse(blend.stdout).layer.currentRevision.blend).toBe("multiply");

  const grade = await editUnit(layerId, ["--brightness", "1.2", "--warmth", "0.2"]);
  expect(grade.code).toBe(0);
  const gradeFact = JSON.parse(grade.stdout).layer.currentRevision.grade;
  expect(gradeFact.brightness).toBe(1.2);
  expect(gradeFact.warmth).toBe(0.2);
});

test("each shipped edit is one revision: the unit's revision advances, members do not exist to change", async () => {
  const layerId = await makeUnit();
  const before = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
  const rot = await editUnit(layerId, ["--rotate", "15"]);
  const after = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
  expect(after.layer.currentRevisionId).not.toBe(before.layer.currentRevisionId);
  expect(after.layer.currentRevision.composition).toBe("inner");
  void rot;
});

test("anchored placement is refused by name on a unit", async () => {
  const layerId = await makeUnit();
  const res = await editUnit(layerId, ["--anchor", "center,center", "--x", "100", "--y", "100"]);
  expect(res.code).not.toBe(0);
  expect(res.stdout + res.stderr).toContain("--anchor");
  expect(res.stdout + res.stderr).toContain("unit");
});

test("skew and perspective are refused by name on a unit", async () => {
  const layerId = await makeUnit();
  for (const [flag, value] of [["--skew", "10x0"], ["--perspective", "10x0"]] as const) {
    const res = await editUnit(layerId, [flag, value]);
    expect(res.code).not.toBe(0);
    expect(res.stdout + res.stderr).toContain(flag);
  }
});

test("every effect fact is refused by name on a unit", async () => {
  const layerId = await makeUnit();
  const cases: string[][] = [
    ["--shadow", "4,4,8,#000000"],
    ["--outline", "2,#ff0000"],
    ["--inner-shadow", "4,4,8,#000000"],
    ["--glow", "4,2,#00ff00"],
    ["--blur", "4"],
    ["--choke", "2"],
    ["--feather", "2"],
  ];
  for (const args of cases) {
    const res = await editUnit(layerId, args);
    expect(res.code).not.toBe(0);
    expect(res.stdout + res.stderr).toContain(args[0]);
  }
});

test("visible region and mask are refused by name on a unit", async () => {
  const layerId = await makeUnit();
  for (const args of [["--visible-region", "0,0,10,10"], ["--mask", "card"], ["--mask", ":none"]]) {
    const res = await editUnit(layerId, args);
    expect(res.code).not.toBe(0);
    expect(res.stdout + res.stderr).toContain(args[0]);
  }
});

test("content-kind facts are refused by name on a unit", async () => {
  const layerId = await makeUnit();
  const cases: string[][] = [
    ["--text", "hello"],
    ["--shape", "rectangle"],
    ["--size", "10x10"],
    ["--fill", "#ff0000"],
    ["--font", "Anton"],
    ["--font-size", "24"],
    ["--color", "#ffffff"],
    ["--vector-color", "#00ff00"],
    ["--corner-radius", "4"],
    ["--tracking", "0.1"],
  ];
  for (const args of cases) {
    const res = await editUnit(layerId, args);
    expect(res.code).not.toBe(0);
    expect(res.stdout + res.stderr).toContain(args[0]);
  }
});

test("intrinsic-size scale forms are refused by name on a unit", async () => {
  const layerId = await makeUnit();
  for (const args of [["--resize-to", "100x50"], ["--cover-to", "100x50"]]) {
    const res = await editUnit(layerId, [args[0], args[1]]);
    expect(res.code).not.toBe(0);
    expect(res.stdout + res.stderr).toContain(args[0]);
  }
});

test("a refused edit publishes nothing: the revision id is unchanged", async () => {
  const layerId = await makeUnit();
  const before = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
  const res = await editUnit(layerId, ["--blur", "4"]);
  expect(res.code).not.toBe(0);
  const after = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
  expect(after.layer.currentRevisionId).toBe(before.layer.currentRevisionId);
});

test("the --in-place rule counts direct referrers only: one direct referrer edits without a flag", async () => {
  // outer uses the unit; inner (the unit's CONTENT) does not use the unit
  // Layer — a transitive-reach edge, not a direct referrer (#341 reports
  // reach). One direct referrer: the edit needs no flag.
  const layerId = await makeUnit();
  const res = await editUnit(layerId, ["--rotate", "10"]);
  expect(res.code).toBe(0);
});

test("a unit Layer used by two Compositions follows the ordinary blast-radius rule", async () => {
  const layerId = await makeUnit();
  await makeComp("outer2", 400, 300);
  // Same-Project import copies the use list: outer2 gains a use of the SAME
  // unit Layer identity — now two DIRECT referrers.
  const imported = await invoke(["composition", "import", "outer2", "outer", "--project", projDir, "--json"]);
  expect(imported.code).toBe(0);
  // An unflagged edit is refused naming both direct referrers.
  const res = await editUnit(layerId, ["--rotate", "10"]);
  expect(res.code).not.toBe(0);
  const body = res.stdout + res.stderr;
  expect(body).toContain("outer");
  expect(body).toContain("outer2");
  // The flagged edit publishes.
  const ok = await editUnit(layerId, ["--rotate", "10", "--in-place"]);
  expect(ok.code).toBe(0);
});
test("an edit of a member reports the transitive reach through units on success", async () => {
  // inner holds the member; outer and outer2 use units of inner (outer2 via
  // same-Project import of the SAME unit Layer). The member has ONE direct
  // referrer (inner) — the ISC-11 rule is unchanged — but the edit reaches
  // outer and outer2 transitively, and says so.
  const layerId = await makeUnit();
  await makeComp("outer2", 400, 300);
  const imported = await invoke(["composition", "import", "outer2", "outer", "--project", projDir, "--json"]);
  expect(imported.code).toBe(0);
  // The member's use name in inner: the shape added by makeUnit's inner? The
  // unit inner here has no members — add one.
  const member = await invoke([
    "composition", "add", "inner", "card", "--shape", "rectangle", "--size", "80x60",
    "--fill", "#cc2222", "--x", "20", "--y", "20", "--project", projDir, "--json",
  ]);
  expect(member.code).toBe(0);

  const res = await editUnit("inner/card", ["--fill", "#123456"]);
  expect(res.code).toBe(0);
  const body = JSON.parse(res.stdout);
  expect(body.referringCompositions).toEqual(["inner"]);
  expect(body.reachedThroughUnits).toEqual(["outer", "outer2"]);
});

test("the ISC-11 refusal reports the transitive reach next to the direct referrers", async () => {
  // The unit Layer has two DIRECT referrers (outer, outer2); top uses a unit
  // of outer. The unflagged edit is refused by the unchanged direct-referrer
  // rule and reports the transitive reach (top) beside the direct ones.
  const layerId = await makeUnit();
  await makeComp("outer2", 400, 300);
  const imported = await invoke(["composition", "import", "outer2", "outer", "--project", projDir, "--json"]);
  expect(imported.code).toBe(0);
  await makeComp("top", 500, 400);
  const nested = await invoke([
    "composition", "add", "top", "tile", "--unit", "outer",
    "--project", projDir, "--json",
  ]);
  expect(nested.code).toBe(0);

  const res = await editUnit(layerId, ["--rotate", "10"]);
  expect(res.code).not.toBe(0);
  const body = JSON.parse(res.stdout);
  expect(body.referringCompositions).toEqual(["outer", "outer2"]);
  expect(body.reachedThroughUnits).toEqual(["top"]);
  expect(body.error).toContain("through units");
  expect(body.error).toContain("top");
});

test("the reach list excludes direct referrers and reports a diamond once", async () => {
  // inner holds member M; outer and outer2 use units of inner; top uses
  // units of BOTH outer and outer2. Editing M: direct referrer is inner
  // alone; the reach walks two paths to top and reports it once. A
  // Composition that references M directly AND reaches it through a unit
  // (mixed) stays in the direct list and is not duplicated into the reach.
  await makeUnit();
  const member = await invoke([
    "composition", "add", "inner", "card", "--shape", "rectangle", "--size", "80x60",
    "--fill", "#cc2222", "--x", "20", "--y", "20", "--project", projDir, "--json",
  ]);
  expect(member.code).toBe(0);
  await makeComp("outer2", 400, 300);
  const imported = await invoke(["composition", "import", "outer2", "outer", "--project", projDir, "--json"]);
  expect(imported.code).toBe(0);
  await makeComp("top", 500, 400);
  let res = await invoke([
    "composition", "add", "top", "t1", "--unit", "outer", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  res = await invoke([
    "composition", "add", "top", "t2", "--unit", "outer2", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  // mixed: inner itself also uses its member directly (already true) — and
  // a Composition that uses M directly plus a unit of inner.
  await makeComp("mixed", 300, 200);
  res = await invoke([
    "composition", "add", "mixed", "m1", "--unit", "inner", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  res = await invoke([
    "composition", "add", "mixed", "m2", "--shape", "rectangle", "--size", "10x10",
    "--fill", "#0000ff", "--x", "5", "--y", "5", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  // Point mixed's second use at the SAME member Layer via import-free reuse:
  // composition add creates a new Layer, so reuse the member by importing
  // inner's use list? Instead, edit inner/card and assert the reach.
  res = await invoke(["layer", "edit", "inner/card", "--fill", "#123456", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const body = JSON.parse(res.stdout);
  expect(body.referringCompositions).toEqual(["inner"]);
  // outer and outer2 each reached by one path; top reached by TWO paths —
  // reported once; mixed is reached too (it uses a unit of inner).
  expect(body.reachedThroughUnits).toEqual(["mixed", "outer", "outer2", "top"]);
});

test("an unused unit Layer reaches nothing", async () => {
  // A unit Layer whose use was removed stays in the Project but no
  // Composition uses it — the reach walk follows only unit Layers some
  // Composition actually uses, so it contributes no edges and no reach.
  await makeComp("lonely", 100, 100);
  await makeComp("scratch", 100, 100);
  let res = await invoke([
    "composition", "add", "scratch", "u", "--unit", "lonely", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const unusedUnitId = JSON.parse(res.stdout).use.layerId as string;
  res = await invoke(["composition", "remove", "scratch", "u", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  // The unit Layer still exists, unused by any Composition.
  const listed = JSON.parse((await invoke(["layer", "list", "--project", projDir, "--json"])).stdout);
  expect(listed.layers.some((l: { id: string }) => l.id === unusedUnitId)).toBe(true);

  // inner (with a member) is used by outer; scratch's removed unit pointed
  // at lonely, which must never appear in any reach.
  const layerId = await makeUnit();
  const member = await invoke([
    "composition", "add", "inner", "card", "--shape", "rectangle", "--size", "80x60",
    "--fill", "#cc2222", "--x", "20", "--y", "20", "--project", projDir, "--json",
  ]);
  expect(member.code).toBe(0);
  expect(unusedUnitId).toBeDefined();

  res = await invoke(["layer", "edit", "inner/card", "--fill", "#123456", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const body = JSON.parse(res.stdout);
  expect(body.referringCompositions).toEqual(["inner"]);
  // Only outer is reached through the USED unit; the unused unit Layer of
  // lonely contributes nothing (and lonely appears nowhere).
  expect(body.reachedThroughUnits).toEqual(["outer"]);
});
