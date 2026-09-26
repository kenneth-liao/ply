/**
 * Unit lifecycle refusals (ADR-0026 §3/§4, #307): `composition delete`
 * refuses while ANY unit Layer in the Project refers to the Composition —
 * including a unit Layer no Composition uses at the moment, so a later
 * same-name Composition can never be picked up silently — naming each such
 * unit Layer and the Compositions and uses that hold it. Cross-Project
 * import of a Composition that uses a unit is refused, naming the unit
 * uses (#307 does not build cross-Project import of units; a unit Layer is
 * never copied without its inner Composition). Same-Project import copies
 * the unit use as a use of the same shared unit Layer.
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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-unit-delete-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "unit-delete-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComp(project: string, name: string, width = 400, height = 300) {
  const res = await invoke([
    "composition", "create", name, "--width", String(width), "--height", String(height),
    "--project", project, "--json",
  ]);
  expect(res.code).toBe(0);
}

async function makeCardUnit(): Promise<string> {
  await makeComp(projDir, "inner", 200, 120);
  let res = await invoke([
    "composition", "add", "inner", "card", "--shape", "rectangle", "--size", "160x80",
    "--fill", "#cc2222", "--x", "20", "--y", "20", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  await makeComp(projDir, "outer");
  res = await invoke([
    "composition", "add", "outer", "tile", "--unit", "inner",
    "--x", "50", "--y", "40", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).use.layerId as string;
}

test("composition delete refuses while a unit Layer refers to the Composition, naming the unit Layer and the use", async () => {
  const layerId = await makeCardUnit();
  const res = await invoke(["composition", "delete", "inner", "--project", projDir, "--json"]);
  expect(res.code).not.toBe(0);
  const body = res.stdout + res.stderr;
  expect(body).toContain(layerId);
  expect(body).toContain("outer");
  expect(body).toContain("tile");
  // The Composition survives.
  const inspect = await invoke(["composition", "inspect", "inner", "--project", projDir, "--json"]);
  expect(inspect.code).toBe(0);
});

test("a transitive reference blocks the delete too (unit → inner → deepest)", async () => {
  await makeComp(projDir, "deepest", 60, 60);
  await makeComp(projDir, "inner", 200, 120);
  let res = await invoke([
    "composition", "add", "inner", "sub", "--unit", "deepest",
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  await makeComp(projDir, "outer");
  res = await invoke([
    "composition", "add", "outer", "tile", "--unit", "inner",
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  res = await invoke(["composition", "delete", "deepest", "--project", projDir, "--json"]);
  expect(res.code).not.toBe(0);
  expect(res.stdout + res.stderr).toContain("deepest");
});

test("deleting a Composition no unit refers to still works", async () => {
  await makeCardUnit();
  await makeComp(projDir, "plain", 100, 100);
  const res = await invoke(["composition", "delete", "plain", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
});

test("an UNUSED unit Layer still blocks the delete: a later same-name Composition is never picked up silently", async () => {
  const layerId = await makeCardUnit();
  // Remove the unit's use — the Layer stays (no command deletes a Layer).
  const res = await invoke(["composition", "remove", "outer", "tile", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  // The unused unit Layer still refers to "inner": the delete stays refused.
  let del = await invoke(["composition", "delete", "inner", "--project", projDir, "--json"]);
  expect(del.code).not.toBe(0);
  expect(del.stdout + del.stderr).toContain(layerId);
  // A LATER Composition named "inner" (a different canvas — a different
  // Composition) does not lift the block: the stale reference can never be
  // picked up silently.
  del = await invoke(["composition", "delete", "inner", "--project", projDir, "--json"]);
  expect(del.code).not.toBe(0);
});

test("cross-Project import of a Composition that uses a unit is refused, naming the unit uses", async () => {
  const layerId = await makeCardUnit();
  const otherProj = path.join(tempDir, "other");
  await invoke(["project", "init", otherProj, "--name", "other-proj"]);
  await makeComp(otherProj, "destination");
  const res = await invoke([
    "composition", "import", "destination", "outer", "--from-project", projDir,
    "--project", otherProj, "--json",
  ]);
  expect(res.code).not.toBe(0);
  const body = res.stdout + res.stderr;
  expect(body).toContain(layerId);
  expect(body).toContain("tile");
  // Nothing published in the destination.
  const inspect = await invoke(["composition", "inspect", "destination", "--project", otherProj, "--json"]);
  expect(JSON.parse(inspect.stdout).composition.layers).toHaveLength(0);
});

test("same-Project import copies the unit use as a use of the same shared unit Layer", async () => {
  const layerId = await makeCardUnit();
  await makeComp(projDir, "destination");
  const res = await invoke(["composition", "import", "destination", "outer", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const inspect = await invoke(["composition", "inspect", "destination", "--project", projDir, "--json"]);
  const layers = JSON.parse(inspect.stdout).composition.layers;
  expect(layers).toHaveLength(1);
  expect(layers[0].layerId).toBe(layerId);
  expect(layers[0].kind).toBe("unit");
});