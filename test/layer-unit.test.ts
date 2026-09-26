/**
 * The unit Layer kind (ADR-0026, spec #285 US-018/ISC-36, #307): a Layer
 * whose content is a live reference to another Composition in the same
 * Project.
 *
 * This file owns the storage and add-surface cells:
 * - `composition add <comp> <name> --unit <inner>` publishes a unit Layer
 *   through the ordinary publication protocol: identity + immutable
 *   revision whose content fact is the inner Composition's NAME (live
 *   reference — no copied contents, no pinned inner revision, no
 *   contentHash, there are no retained bytes).
 * - Placement options apply on add like any kind.
 * - The cycle check refuses before anything is published: a Composition
 *   can never contain itself, directly (--unit self) or transitively,
 *   naming the chain of Compositions (a → b → a).
 * - A missing inner Composition is refused, listing what exists.
 * - `--unit` is add-only: `layer edit --unit` is refused.
 * - `--fork` on a unit Layer is no longer refused by name: the unit fork
 *   ships (#341) and needs `--fork-unit <name>` — pinned here against a
 *   target use in a second Composition.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-unit-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "unit-test-proj"]);
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

async function addUnit(comp: string, localName: string, inner: string, extra: string[] = []) {
  return invoke([
    "composition", "add", comp, localName, "--unit", inner,
    "--project", projDir, "--json", ...extra,
  ]);
}

async function readRevisionDoc(layerId: string, revisionId: string): Promise<Record<string, unknown>> {
  const file = path.join(projDir, "layers", `${layerId}.revisions`, `${revisionId}.json`);
  return JSON.parse(await readFile(file, "utf8"));
}

test("composition add --unit publishes a unit Layer whose revision stores the inner Composition's name", async () => {
  await makeComp("inner", 200, 150);
  await makeComp("outer", 400, 300);

  const res = await addUnit("outer", "card", "inner", ["--x", "10", "--y", "20"]);
  expect(res.code).toBe(0);
  const out = JSON.parse(res.stdout);
  expect(out.composition).toBe("outer");
  expect(out.use.name).toBe("card");

  const layerId = out.use.layerId as string;
  const revision = out.layer.currentRevision as Record<string, unknown>;
  expect(revision.kind).toBe("unit");
  expect(revision.composition).toBe("inner");
  expect(revision.x).toBe(10);
  expect(revision.y).toBe(20);
  expect(revision.opacity).toBe(1);
  // Live reference: the name is the fact. No copied contents, no pinned
  // inner revision, no retained bytes — so no contentHash.
  expect(revision.contentHash).toBeUndefined();

  // The on-disk revision document matches the resolved view.
  const doc = await readRevisionDoc(layerId, String(out.layer.currentRevisionId));
  expect(doc.kind).toBe("unit");
  expect(doc.composition).toBe("inner");
  expect(doc.contentHash).toBeUndefined();

  // The identity was staged and the revision file exists under its
  // content-derived hash (the ordinary publication protocol).
  const revDir = path.join(projDir, "layers", `${layerId}.revisions`);
  const revFiles = await readdir(revDir);
  expect(revFiles).toEqual([`${out.layer.currentRevisionId}.json`]);
});

test("the unit use inspects with kind unit", async () => {
  await makeComp("inner", 200, 150);
  await makeComp("outer", 400, 300);
  const res = await addUnit("outer", "card", "inner");
  expect(res.code).toBe(0);

  const inspect = await invoke(["composition", "inspect", "outer", "--project", projDir, "--json"]);
  expect(inspect.code).toBe(0);
  const comp = JSON.parse(inspect.stdout).composition;
  expect(comp.layers).toHaveLength(1);
  expect(comp.layers[0].kind).toBe("unit");
  expect(comp.layers[0].name).toBe("card");
});

test("adding a unit of a missing Composition is refused, listing what exists", async () => {
  await makeComp("inner", 200, 150);
  await makeComp("outer", 400, 300);

  const res = await addUnit("outer", "card", "nosuch");
  expect(res.code).not.toBe(0);
  const body = res.stdout + res.stderr;
  expect(body).toContain("nosuch");
  expect(body).toContain("inner");
  // Nothing published.
  const inspect = await invoke(["composition", "inspect", "outer", "--project", projDir, "--json"]);
  expect(JSON.parse(inspect.stdout).composition.layers).toHaveLength(0);
});

test("a Composition cannot contain itself: --unit self is refused naming the chain", async () => {
  await makeComp("outer", 400, 300);

  const res = await addUnit("outer", "card", "outer");
  expect(res.code).not.toBe(0);
  const body = res.stdout + res.stderr;
  expect(body).toContain("outer → outer");
  const inspect = await invoke(["composition", "inspect", "outer", "--project", projDir, "--json"]);
  expect(JSON.parse(inspect.stdout).composition.layers).toHaveLength(0);
});

test("a transitive cycle is refused before anything is published, naming the chain", async () => {
  // a uses a unit of b; then adding a unit of a inside b would close
  // b → a → b. The new use is refused with the chain a → b → a.
  await makeComp("a", 400, 300);
  await makeComp("b", 400, 300);
  const first = await addUnit("a", "ua", "b");
  expect(first.code).toBe(0);

  const res = await addUnit("b", "ub", "a");
  expect(res.code).not.toBe(0);
  const body = res.stdout + res.stderr;
  expect(body).toContain("a → b → a");
  // The refusal publishes nothing: b's use list is unchanged.
  const inspect = await invoke(["composition", "inspect", "b", "--project", projDir, "--json"]);
  expect(JSON.parse(inspect.stdout).composition.layers).toHaveLength(0);
});

test("the same inner Composition used as a unit several times is not a cycle", async () => {
  await makeComp("inner", 200, 150);
  await makeComp("outer1", 400, 300);
  await makeComp("outer2", 400, 300);

  expect((await addUnit("outer1", "card", "inner")).code).toBe(0);
  expect((await addUnit("outer2", "card", "inner")).code).toBe(0);
  expect((await addUnit("outer1", "card2", "inner")).code).toBe(0);

  const inspect = await invoke(["composition", "inspect", "outer1", "--project", projDir, "--json"]);
  expect(JSON.parse(inspect.stdout).composition.layers).toHaveLength(2);
});

test("--unit is add-only: layer edit --unit is refused", async () => {
  await makeComp("inner", 200, 150);
  await makeComp("outer", 400, 300);
  const added = await addUnit("outer", "card", "inner");
  expect(added.code).toBe(0);
  const layerId = (JSON.parse(added.stdout).use.layerId as string);

  const res = await invoke([
    "layer", "edit", layerId, "--unit", "inner",
    "--project", projDir, "--json",
  ]);
  expect(res.code).not.toBe(0);
  const body = res.stdout + res.stderr;
  expect(body).toContain("--unit");
  // Nothing published: the current revision is unchanged.
  const after = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(after.code).toBe(0);
  expect(JSON.parse(after.stdout).layer.currentRevision.composition).toBe("inner");
});

test("--fork on a unit Layer is no longer refused by name: the unit fork ships (#341)", async () => {
  await makeComp("inner", 200, 150);
  await makeComp("outer", 400, 300);
  await makeComp("outer2", 400, 300);
  const added = await addUnit("outer", "card", "inner");
  expect(added.code).toBe(0);
  const layerId = (JSON.parse(added.stdout).use.layerId as string);
  // outer2 gains a use of the SAME unit Layer (same-Project import copies
  // the use list), so it has an existing use to retarget.
  const imported = await invoke(["composition", "import", "outer2", "outer", "--project", projDir, "--json"]);
  expect(imported.code).toBe(0);

  const res = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "outer2", "--use", "card",
    "--fork-unit", "inner-copy",
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const body = JSON.parse(res.stdout);
  // The fork published: a new unit Layer identity referencing the copied
  // inner Composition, and outer2's use retargeted to it.
  expect(body.forkedUnit).toEqual({ from: "inner", to: "inner-copy" });
  expect(body.layer.currentRevision.composition).toBe("inner-copy");
  const inspect = await invoke(["composition", "inspect", "outer2", "--project", projDir, "--json"]);
  expect(JSON.parse(inspect.stdout).composition.layers[0].layerId).toBe(body.layer.id);
  // The original inner Composition is untouched and the original Layer
  // keeps referencing it; outer still uses the original identity too.
  const original = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(JSON.parse(original.stdout).layer.currentRevision.composition).toBe("inner");
  const outer = await invoke(["composition", "inspect", "outer", "--project", projDir, "--json"]);
  expect(JSON.parse(outer.stdout).composition.layers[0].layerId).toBe(layerId);
});