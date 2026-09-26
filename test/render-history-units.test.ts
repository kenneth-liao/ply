/**
 * Unit render pinning and replay (ADR-0026 §4, spec #285 US-018/ISC-36,
 * TEST-003): a Render manifest pins everything the unit painted from — the
 * unit Layer's revision AND the inner Composition's resolved state at
 * render time (canvas, use order and names, every member's revision),
 * nested units recursively. Replay paints from those pins and NEVER reads
 * current Composition documents, so a Render with a unit replays
 * byte-identically after the inner Composition, a member, or the unit
 * Layer changes. A render with NO unit writes a byte-identical v1 manifest
 * — no unit pins — so an older binary still replays it.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, rename } from "node:fs/promises";
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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-unit-replay-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "unit-replay-proj"]);
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

/** inner (200×120: red card + text member) used as a unit in outer (400×300). */
async function makeCardUnit(withNestedUnit = false): Promise<void> {
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
  if (withNestedUnit) {
    await makeComp("deepest", 60, 60);
    res = await invoke([
      "composition", "add", "deepest", "dot", "--shape", "ellipse", "--size", "40x40",
      "--fill", "#00cc44", "--x", "10", "--y", "10", "--project", projDir, "--json",
    ]);
    expect(res.code).toBe(0);
    res = await invoke([
      "composition", "add", "inner", "nested", "--unit", "deepest",
      "--x", "130", "--y", "50", "--project", projDir, "--json",
    ]);
    expect(res.code).toBe(0);
  }
  await makeComp("outer", 400, 300);
  res = await invoke([
    "composition", "add", "outer", "tile", "--unit", "inner",
    "--x", "50", "--y", "40", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
}

async function render(comp: string): Promise<{ png: string; manifest: string; doc: Record<string, unknown> }> {
  const res = await invoke(["composition", "render", comp, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const out = JSON.parse(res.stdout).render;
  const doc = JSON.parse(await readFile(out.manifest, "utf8"));
  return { png: out.output, manifest: out.manifest, doc };
}

test("a render with a unit pins the nested state and writes schemaVersion 2", async () => {
  await makeCardUnit();
  const { doc } = await render("outer");
  expect(doc.schemaVersion).toBe(2);
  const tile = (doc.layers as Record<string, unknown>[]).find((l) => l.name === "tile")!;
  expect(tile.unit).toBeDefined();
  const unit = tile.unit as Record<string, unknown>;
  expect(unit.composition).toBe("inner");
  expect(unit.canvas).toEqual({ width: 200, height: 120 });
  const members = unit.layers as Record<string, unknown>[];
  // The inner use order and names, and each member's pinned revision.
  expect(members.map((m) => m.name)).toEqual(["card", "mark"]);
  expect(members.every((m) => typeof m.revisionId === "string" && (m.revisionId as string).startsWith("rev_"))).toBe(true);
  expect(members.every((m) => (m as { unit?: unknown }).unit === undefined)).toBe(true);
});

test("a nested unit pins recursively", async () => {
  await makeCardUnit(true);
  const { doc } = await render("outer");
  expect(doc.schemaVersion).toBe(2);
  const tile = (doc.layers as Record<string, unknown>[]).find((l) => l.name === "tile")!;
  const members = (tile.unit as Record<string, unknown>).layers as Record<string, unknown>[];
  const nested = members.find((m) => m.name === "nested")!;
  expect(nested.unit).toBeDefined();
  const innermost = nested.unit as Record<string, unknown>;
  expect(innermost.composition).toBe("deepest");
  expect((innermost.layers as Record<string, unknown>[]).map((m) => m.name)).toEqual(["dot"]);
});

test("a render with NO unit writes a v1 manifest with no unit pins (old binaries replay it)", async () => {
  await makeComp("plain", 100, 100);
  const res = await invoke([
    "composition", "add", "plain", "bg", "--shape", "rectangle", "--size", "100x100",
    "--fill", "#202020", "--x", "0", "--y", "0", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const { doc } = await render("plain");
  // Exactly the pre-unit manifest: schemaVersion 1, no unit field anywhere.
  expect(doc.schemaVersion).toBe(1);
  for (const layer of doc.layers as Record<string, unknown>[]) {
    expect(layer.unit).toBeUndefined();
  }
  expect(JSON.stringify(doc)).not.toContain('"unit"');
});

test("TEST-003: replay is byte-identical after a member edit, an inner use-list edit, and a unit edit", async () => {
  await makeCardUnit();
  const { png, manifest } = await render("outer");
  const original = await readFile(png);

  // 1. A member edit (a new revision of the card) must not move the render.
  let res = await invoke(["layer", "edit", "inner/card", "--fill", "#123456", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  res = await invoke(["composition", "replay", manifest, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  expect(await readFile(JSON.parse(res.stdout).replay.output)).toEqual(original);

  // 2. An inner use-list edit (a member added inside the unit) must not.
  res = await invoke([
    "composition", "add", "inner", "extra", "--shape", "ellipse", "--size", "30x30",
    "--fill", "#eeee00", "--x", "150", "--y", "80", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  res = await invoke(["composition", "replay", manifest, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  expect(await readFile(JSON.parse(res.stdout).replay.output)).toEqual(original);

  // 3. A unit Layer edit must not.
  res = await invoke(["layer", "edit", "outer/tile", "--rotate", "15", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  res = await invoke(["composition", "replay", manifest, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  expect(await readFile(JSON.parse(res.stdout).replay.output)).toEqual(original);
});

test("TEST-003: replay is byte-identical after a unit fork", async () => {
  await makeCardUnit();
  const { png, manifest } = await render("outer");
  const original = await readFile(png);

  // Forking the unit (which copies the inner Composition and retargets the
  // outer use) must not move the retained Render: replay paints from the
  // pins, never from the current documents.
  const res = await invoke([
    "layer", "edit", "outer/tile", "--fork", "--fork-unit", "inner-copy",
    "--rotate", "90", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const replay = await invoke(["composition", "replay", manifest, "--project", projDir, "--json"]);
  expect(replay.code).toBe(0);
  expect(await readFile(JSON.parse(replay.stdout).replay.output)).toEqual(original);
});

test("a replayed render's own manifest carries the same nested pins (replay chains)", async () => {
  await makeCardUnit(true);
  const { manifest } = await render("outer");
  const res = await invoke(["composition", "replay", manifest, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const replayedDoc = JSON.parse(await readFile(JSON.parse(res.stdout).replay.manifest, "utf8"));
  expect(replayedDoc.schemaVersion).toBe(2);
  const replayedTile = (replayedDoc.layers as Record<string, unknown>[]).find((l) => l.name === "tile")!;
  expect((replayedTile.unit as Record<string, unknown>).composition).toBe("inner");
});

test("replay survives Project relocation", async () => {
  await makeCardUnit();
  const { png, manifest } = await render("outer");
  const original = await readFile(png);
  const moved = path.join(tempDir, "moved");
  await rename(projDir, moved);
  const res = await invoke(["composition", "replay", path.join(moved, path.relative(projDir, manifest)), "--project", moved, "--json"]);
  expect(res.code).toBe(0);
  expect(await readFile(JSON.parse(res.stdout).replay.output)).toEqual(original);
});

test("a hand-edited manifest pinning a unit cycle is refused at replay", async () => {
  await makeCardUnit();
  const { manifest, doc } = await render("outer");
  // Hand-edit the manifest to close the cycle the add surface can never
  // create: the unit's nested pin gains a member that is itself a unit of
  // "outer" (inner → outer → inner). The pin for that member carries its
  // OWN nested unit pin, so replay's pinned-history cycle guard — seeded
  // with the manifest composition — fires on the closing edge, before any
  // paint.
  // Hand-edit the manifest to close the cycle the add surface can never
  // create: the unit's nested pin gains a member that is a unit of "inner"
  // itself (the one-step case, inner → inner), carrying its OWN nested unit
  // pin so the pinned data is self-consistent. Replay's pinned-history
  // cycle guard — seeded with the manifest composition — fires on the
  // closing edge, before any paint.
  const tile = (doc.layers as Record<string, unknown>[]).find((l) => l.name === "tile")!;
  const unit = tile.unit as Record<string, unknown>;
  const unitLayerId = tile.layerId as string;
  const unitRevisionId = tile.revisionId as string;
  (unit.layers as Record<string, unknown>[]).push({
    name: "cycle",
    layerId: unitLayerId,
    revisionId: unitRevisionId,
    unit: {
      composition: "inner",
      canvas: { width: 200, height: 120 },
      layers: [],
    },
  });
  await writeFile(manifest, JSON.stringify(doc, null, 2) + "\n");
  const res = await invoke(["composition", "replay", manifest, "--project", projDir, "--json"]);
  expect(res.code).not.toBe(0);
  // The pinned-history cycle guard's own refusal — not a downstream paint
  // failure — names the chain.
  expect(res.stdout + res.stderr).toContain("Unit cycle in pinned history");
  expect(res.stdout + res.stderr).toContain("outer → inner → inner");
});