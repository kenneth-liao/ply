/**
 * The unit fork (ADR-0026 §3/§4, spec #285 US-018/ISC-36, #341): `layer edit
 * --fork` on a unit Layer needs a caller-supplied inner Composition name
 * (`--fork-unit <name>`), copies the inner Composition (same canvas, the
 * same use list — the member Layers stay SHARED), and publishes the forked
 * unit Layer's revision against the new inner name — all in ONE publication:
 * a name clash or a cycle refuses before anything stages. Members edited in
 * place still reach both inner Compositions (ADR-0013), with two direct
 * referrers after the fork, so the ordinary `--in-place` / `--fork` rule
 * applies to them.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePngRgba } from "../src/png.js";

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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-unit-fork-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "unit-fork-proj"]);
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
    "composition", "add", "outer", "tile", "--unit", "inner",
    "--project", projDir, "--json",
  ]);
  expect(added.code).toBe(0);
  return JSON.parse(added.stdout).use.layerId as string;
}

async function compDoc(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(projDir, "compositions", `${name}.json`), "utf8")) as Record<string, unknown>;
}

async function layerIds(): Promise<string[]> {
  const entries = await readdir(path.join(projDir, "layers"));
  return entries.filter((f) => f.endsWith(".json") && !f.includes(".revisions")).sort();
}

test("the unit fork copies the inner use list, keeps members shared, and reports the fork", async () => {
  const layerId = await makeUnit();
  const innerBefore = await compDoc("inner");
  const innerUses = innerBefore.layers as Array<{ name: string; layerId: string }>;

  const res = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "outer", "--use", "tile",
    "--fork-unit", "inner-copy", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const body = JSON.parse(res.stdout);
  // The fork report: the forked Layer plus the inner Composition copy.
  expect(body.fork).toEqual({ previousLayerId: layerId, composition: "outer", use: "tile" });
  expect(body.forkedUnit).toEqual({ from: "inner", to: "inner-copy" });

  // The new inner Composition exists with the ORIGINAL's canvas and the same
  // use list — the same use names referring to the SAME member Layers.
  const copy = await compDoc("inner-copy");
  expect(copy.name).toBe("inner-copy");
  expect(copy.canvas).toEqual(innerBefore.canvas);
  expect(copy.layers).toEqual(innerUses);

  // The forked unit Layer is a new identity whose revision references the
  // NEW inner name; the original Layer keeps referencing the original.
  expect(body.layer.id).not.toBe(layerId);
  expect(body.layer.currentRevision.composition).toBe("inner-copy");
  const original = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
  expect(original.layer.currentRevision.composition).toBe("inner");

  // The selected use in the target Composition is retargeted to the forked
  // identity; nothing else in outer changed.
  const outer = JSON.parse((await invoke(["composition", "inspect", "outer", "--project", projDir, "--json"])).stdout);
  expect(outer.composition.layers).toHaveLength(1);
  expect(outer.composition.layers[0].layerId).toBe(body.layer.id);
});

test("a member edited in place reaches both inner Compositions after a fork", async () => {
  const layerId = await makeUnit();
  // The member exists BEFORE the fork, so the inner copy inherits the use.
  const member = await invoke([
    "composition", "add", "inner", "card", "--shape", "rectangle", "--size", "80x60",
    "--fill", "#cc2222", "--x", "20", "--y", "20", "--project", projDir, "--json",
  ]);
  expect(member.code).toBe(0);
  const res = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "outer", "--use", "tile",
    "--fork-unit", "inner-copy", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);

  // The member now has TWO direct referrers (inner and inner-copy): the
  // ordinary unflagged edit is refused, naming both, and the refusal
  // reports the transitive reach (outer uses the forked unit → inner-copy).
  const refused = await invoke(["layer", "edit", "inner/card", "--fill", "#123456", "--project", projDir, "--json"]);
  expect(refused.code).not.toBe(0);
  const refusedBody = JSON.parse(refused.stdout);
  // (The referrer list follows the composition-file sort order:
  // "inner-copy.json" sorts before "inner.json".)
  expect(refusedBody.referringCompositions).toEqual(["inner-copy", "inner"]);
  expect(refusedBody.reachedThroughUnits).toEqual(["outer"]);
  expect(refusedBody.error).toContain("through units");

  // The flagged edit publishes and reports the same reach on success.
  const ok = await invoke(["layer", "edit", "inner/card", "--fill", "#123456", "--in-place", "--project", projDir, "--json"]);
  expect(ok.code).toBe(0);
  const okBody = JSON.parse(ok.stdout);
  expect(okBody.reachedThroughUnits).toEqual(["outer"]);
});

test("a name clash refuses before anything is published", async () => {
  const layerId = await makeUnit();
  await makeComp("taken", 100, 100);
  const layersBefore = await layerIds();
  const compsBefore = await readdir(path.join(projDir, "compositions"));
  const outerBefore = await compDoc("outer");

  const res = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "outer", "--use", "tile",
    "--fork-unit", "taken", "--project", projDir, "--json",
  ]);
  expect(res.code).not.toBe(0);
  const body = JSON.parse(res.stdout);
  expect(body.ok).toBe(false);
  expect(body.error).toContain("taken");
  expect(body.error).toContain("already exists");
  // Nothing staged: no new Composition, no new Layer identity, the use
  // unchanged.
  expect(await layerIds()).toEqual(layersBefore);
  expect(await readdir(path.join(projDir, "compositions"))).toEqual(compsBefore);
  expect(await compDoc("outer")).toEqual(outerBefore);
});

test("a cycle refuses before anything is published, naming the chain", async () => {
  // A unit Layer of outer (created in scratch, then its use removed — the
  // Layer stays) is hand-referenced inside inner: a state the add surface
  // can never create (it refuses the closing edge outer → inner → outer).
  // The fork's inner copy would inherit that use, so
  // outer → inner-copy → outer would close a cycle.
  const layerId = await makeUnit();
  await makeComp("scratch", 100, 100);
  let res = await invoke([
    "composition", "add", "scratch", "v", "--unit", "outer", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const unitOfOuterId = JSON.parse(res.stdout).use.layerId as string;
  res = await invoke(["composition", "remove", "scratch", "v", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const doc = await compDoc("inner");
  (doc.layers as Array<{ name: string; layerId: string }>).push({ name: "back", layerId: unitOfOuterId });
  await writeFile(path.join(projDir, "compositions", "inner.json"), JSON.stringify(doc, null, 2) + "\n");

  const layersBefore = await layerIds();
  const compsBefore = await readdir(path.join(projDir, "compositions"));
  const outerBefore = await compDoc("outer");

  res = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "outer", "--use", "tile",
    "--fork-unit", "inner-copy", "--project", projDir, "--json",
  ]);
  expect(res.code).not.toBe(0);
  const body = JSON.parse(res.stdout);
  expect(body.ok).toBe(false);
  expect(body.error).toContain("cycle");
  expect(body.error).toContain("outer → inner-copy → outer");
  // Nothing published: no inner copy, no new Layer identity, the use
  // unchanged.
  expect(await layerIds()).toEqual(layersBefore);
  expect(await readdir(path.join(projDir, "compositions"))).toEqual(compsBefore);
  expect(await compDoc("outer")).toEqual(outerBefore);
});

test("a forked unit used inside the copied inner stays live (not forked)", async () => {
  // inner contains a unit of deepest; forking inner's unit in outer copies
  // the use of the SAME unit Layer — the nested unit stays live against
  // deepest (ADR-0026 §3: a unit inside the original inner is not forked).
  await makeComp("inner", 200, 150);
  await makeComp("deepest", 60, 60);
  let res = await invoke([
    "composition", "add", "deepest", "dot", "--shape", "ellipse", "--size", "40x40",
    "--fill", "#00cc44", "--x", "10", "--y", "10", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  res = await invoke([
    "composition", "add", "inner", "nested", "--unit", "deepest",
    "--x", "130", "--y", "50", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const nestedLayerId = JSON.parse(res.stdout).use.layerId as string;
  await makeComp("outer", 400, 300);
  res = await invoke([
    "composition", "add", "outer", "tile", "--unit", "inner",
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const layerId = JSON.parse(res.stdout).use.layerId as string;

  const fork = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "outer", "--use", "tile",
    "--fork-unit", "inner-copy", "--project", projDir, "--json",
  ]);
  expect(fork.code).toBe(0);
  // The copy's nested use references the SAME unit Layer identity.
  const copy = await compDoc("inner-copy");
  const nested = (copy.layers as Array<{ name: string; layerId: string }>).find((u) => u.name === "nested");
  expect(nested).toBeDefined();
  expect(nested!.layerId).toBe(nestedLayerId);
});

test("forking a unit never changes the original inner or other referrers", async () => {
  const layerId = await makeUnit();
  // A second Composition uses the SAME unit Layer: the fork retargets only
  // the selected use.
  await makeComp("outer2", 400, 300);
  const imported = await invoke(["composition", "import", "outer2", "outer", "--project", projDir, "--json"]);
  expect(imported.code).toBe(0);
  const innerBefore = await readFile(path.join(projDir, "compositions", "inner.json"), "utf8");

  const res = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "outer", "--use", "tile",
    "--fork-unit", "inner-copy", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);

  // The original inner document is byte-identical.
  expect(await readFile(path.join(projDir, "compositions", "inner.json"), "utf8")).toBe(innerBefore);
  // outer2's use still references the ORIGINAL unit Layer.
  const outer2 = JSON.parse((await invoke(["composition", "inspect", "outer2", "--project", projDir, "--json"])).stdout);
  expect(outer2.composition.layers[0].layerId).toBe(layerId);
});

test("--fork on a unit without --fork-unit is refused before anything is published", async () => {
  const layerId = await makeUnit();
  const layersBefore = await layerIds();
  const res = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "outer", "--use", "tile",
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(2);
  const body = JSON.parse(res.stdout);
  expect(body.ok).toBe(false);
  expect(body.error).toContain("--fork-unit");
  expect(await layerIds()).toEqual(layersBefore);
});

test("--fork-unit without --fork is refused", async () => {
  const layerId = await makeUnit();
  const res = await invoke([
    "layer", "edit", layerId, "--fork-unit", "inner-copy", "--rotate", "10",
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(2);
  const body = JSON.parse(res.stdout);
  expect(body.ok).toBe(false);
  expect(body.error).toContain("--fork-unit is only valid together with --fork");
});

test("--fork-unit on a non-unit fork is refused", async () => {
  await makeComp("poster", 400, 300);
  const imgPath = path.join(tempDir, "dot.png");
  await writeFile(imgPath, encodePngRgba(4, 4, Buffer.alloc(4 * 4 * 4, 200)));
  const added = await invoke([
    "composition", "add", "poster", "img", "--image", imgPath, "--project", projDir, "--json",
  ]);
  expect(added.code).toBe(0);
  const imageId = JSON.parse(added.stdout).use.layerId as string;

  const res = await invoke([
    "layer", "edit", imageId, "--fork", "--composition", "poster", "--use", "img",
    "--fork-unit", "nope", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(2);
  const body = JSON.parse(res.stdout);
  expect(body.ok).toBe(false);
  expect(body.error).toContain("--fork-unit");
  expect(body.error).toContain("unit");
});

test("--fork-unit with an invalid Composition name is refused at the boundary", async () => {
  const layerId = await makeUnit();
  const res = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "outer", "--use", "tile",
    "--fork-unit", "bad name!", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(2);
  const body = JSON.parse(res.stdout);
  expect(body.ok).toBe(false);
  expect(body.error).toContain("--fork-unit takes a Composition name");
});