/**
 * Text runs on one Layer (#297, spec #285 US-017, ISC-54, DEC-005/DEC-006,
 * ADR-0021 amendment): "5 HERDR PLUGINS" is ONE editable text Layer whose
 * runs carry different colour, weight, or font.
 *
 * The storage contract (one home per fact):
 * - `text` stays the ONLY home of the characters, for single- and multi-run
 *   revisions alike; `runs` (present iff ≥2 runs) stores per-run boundaries
 *   plus OVERRIDES of the Layer-level defaults only — never a second copy
 *   of a fact the Layer already stores.
 * - A single-run Layer is stored exactly as today's text revision: no
 *   `runs` field, same stored shape.
 * - Each run accepts the solid and gradient colour grammar and today's
 *   weight, width, and font rules (including caller fonts), validated
 *   against the run's effective face — no style is ever synthesized.
 *
 * Offline, per-file `bun test --isolate`.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePngRgba } from "../src/png.js";
import { computeRevisionHash, type LayerTextRevision } from "../src/layer.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const FIXTURES = path.resolve(import.meta.dir, "fixtures/fonts");
const SILKSCREEN = path.join(FIXTURES, "Silkscreen-Regular.ttf");
const HANDJET = path.join(FIXTURES, "Handjet.ttf");

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

function json(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-text-runs-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "text-runs-proj"]);
  await invoke(["composition", "create", "poster", "--width", "600", "--height", "240", "--project", projDir]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function addLayer(name: string, args: string[]): Promise<Record<string, unknown>> {
  const res = await invoke(["composition", "add", "poster", name, ...args, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return json(res.stdout);
}

async function addRunsLayer(
  name: string,
  runs: string[],
  args: string[] = [],
): Promise<Record<string, unknown>> {
  const runArgs = runs.flatMap((r) => ["--run", r]);
  return addLayer(name, [...runArgs, ...args]);
}

type RunsRev = LayerTextRevision & { runs?: Array<Record<string, unknown>> };

function revOf(body: Record<string, unknown>): RunsRev {
  return (body as { layer: { currentRevision: RunsRev } }).layer.currentRevision;
}

function layerIdOf(body: Record<string, unknown>): string {
  return (body as { layer: { id: string } }).layer.id;
}

async function editLayer(layerId: string, args: string[]): Promise<{ code: number; body: Record<string, unknown>; stderr: string }> {
  const res = await invoke(["layer", "edit", layerId, ...args, "--project", projDir, "--json"]);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(res.stdout || res.stderr) as Record<string, unknown>;
  } catch {
    body = { error: res.stderr };
  }
  return { code: res.code, body, stderr: res.stderr };
}

async function measureLayer(use?: string): Promise<Record<string, unknown>> {
  const res = await invoke([
    "composition", "measure", "poster", ...(use ? [use] : []), "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const layers = (json(res.stdout) as { layers: Record<string, unknown>[] }).layers;
  return layers[0]!;
}

// ---------------------------------------------------------------------------
// Storage: one home per fact
// ---------------------------------------------------------------------------

test("runs authored on composition add store boundaries and overrides with text as the one character home", async () => {
  const added = await addRunsLayer("headline", ["5 ", "HERDR ", "PLUGINS"], [
    "--font", "Archivo", "--font-size", "64",
    "--run-color", "2=linear:90deg,#ffb347,#c0182b",
    "--run-weight", "2=800",
    "--run-font", "3=Archivo Black",
    "--run-color", "3=#3b82f6",
    "--x", "40", "--y", "60",
  ]);
  expect(added.ok).toBe(true);
  const rev = revOf(added) as LayerTextRevision;

  // The one character home: the full string in `text`, never duplicated in runs.
  expect(rev.text).toBe("5 HERDR PLUGINS");
  // runs present (3 runs), overrides only — entry 1 carries no fields.
  const runs = rev.runs!;
  expect(runs).toHaveLength(3);
  expect(runs[0]).toEqual({});
  // 0-based stored start; entry 1 begins at 0 and stores no field.
  expect(runs[1]!.start).toBe(2);
  // Run 2: gradient colour override (canonical LayerFill) + resolved axes pair.
  expect(runs[1]!.color).toEqual({
    type: "linear", angleDeg: 90,
    stops: [{ color: "#ffb347", position: 0 }, { color: "#c0182b", position: 100 }],
  });
  expect(runs[1]!.weight).toBe(800);
  expect(runs[1]!.width).toBe(100); // the resolved width of the layer's face (Archivo default width)
  expect(runs[1]!.contentHash).toBeUndefined(); // run 2 shares the layer font
  // Run 3: font override pins its own retained bytes (Archivo Black's sha-256).
  expect(typeof runs[2]!.contentHash).toBe("string");
  expect(runs[2]!.start).toBe(8);
  expect(runs[2]!.color).toBe("#3b82f6");
  expect(runs[2]!.callerFont).toBeUndefined();
  // A solid run colour stays the canonical hex string.
  expect(typeof runs[2]!.color).toBe("string");
});

test("a single-run Layer is stored exactly as today's text revision — no runs field, same shape", async () => {
  // The same facts authored through --text and through one --run occurrence
  // produce the same stored revision shape: one --run occurrence normalizes
  // to today's single-run form at the one ingestion point.
  const viaText = await addLayer("viaText", ["--text", "5 HERDR PLUGINS", "--font", "Archivo", "--font-size", "64", "--color", "#111827"]);
  const viaRun = await addRunsLayer("viaRun", ["5 HERDR PLUGINS"], ["--font", "Archivo", "--font-size", "64", "--color", "#111827"]);
  const a = revOf(viaText) as unknown as Record<string, unknown>;
  const b = revOf(viaRun) as unknown as Record<string, unknown>;
  for (const rev of [a, b]) {
    delete rev.layerId;
    delete rev.createdAt;
    delete rev.revisionId; // the per-Layer identity fields the hash pins
  }
  expect(b).toEqual(a);
});

test("a single run with a style override folds into the layer-level facts", async () => {
  // One --run occurrence with a per-run style IS the layer style: the one
  // ingestion point folds it, so no runs field and no second home.
  const added = await addRunsLayer("headline", ["5 HERDR PLUGINS"], [
    "--font", "Archivo", "--font-size", "64", "--run-color", "1=#111827", "--run-weight", "1=800",
  ]);
  expect(added.ok).toBe(true);
  const rev = revOf(added);
  expect(rev.runs).toBeUndefined();
  expect(rev.color).toBe("#111827");
  expect(rev.weight).toBe(800);
});

test("multi-run style overrides hash into the revision id; removing the override restores the boundaries-only facts", async () => {
  const added = await addRunsLayer("headline", ["A ", "B"], ["--font", "Archivo", "--font-size", "64"]);
  const before = revOf(added);

  const setRes = await editLayer(layerIdOf(added), ["--run-color", "2=#ef4444"]);
  expect(setRes.code).toBe(0);
  const after = revOf(setRes.body);
  expect(computeRevisionHash(after as never)).not.toBe(computeRevisionHash(before as never));

  // The "none" form removes the run's colour override; the boundary stays.
  const unsetRes = await editLayer(layerIdOf(added), ["--run-color", "2=none"]);
  expect(unsetRes.code).toBe(0);
  const cleared = revOf(unsetRes.body);
  expect(cleared.runs).toHaveLength(2);
  expect(cleared.runs![0]).toEqual({});
  expect(cleared.runs![1]).toEqual({ start: 2 });
});

// ---------------------------------------------------------------------------
// Editing runs
// ---------------------------------------------------------------------------

async function seededRunsLayer(): Promise<string> {
  const added = await addRunsLayer("headline", ["5 ", "HERDR ", "PLUGINS"], ["--font", "Archivo", "--font-size", "64"]);
  return layerIdOf(added);
}

test("layer edit --run-text replaces a run's slice and shifts later boundaries", async () => {
  const layerId = await seededRunsLayer();
  const res = await editLayer(layerId, ["--run-text", "2=HERDR"]);
  expect(res.code).toBe(0);
  const rev = revOf(res.body) as RunsRev;
  expect(rev.text).toBe("5 HERDRPLUGINS"); // the run's trailing space is replaced too
  expect(rev.runs![1]!.start).toBe(2);
  expect(rev.runs![2]!.start).toBe(7);
});

test("repeated --run-text occurrences rewrite several runs in one edit", async () => {
  const layerId = await seededRunsLayer();
  const res = await editLayer(layerId, ["--run-text", "1=7 ", "--run-text", "3=PLUGINS!"]);
  expect(res.code).toBe(0);
  const rev = revOf(res.body) as RunsRev;
  expect(rev.text).toBe("7 HERDR PLUGINS!");
});

test("layer edit --run appends a run; --runs none collapses to the single-run shape", async () => {
  const layerId = await seededRunsLayer();
  const appendRes = await editLayer(layerId, ["--run", "!"]);
  expect(appendRes.code).toBe(0);
  const appended = revOf(appendRes.body) as RunsRev;
  expect(appended.text).toBe("5 HERDR PLUGINS!");
  expect(appended.runs).toHaveLength(4);
  expect(appended.runs![3]).toEqual({ start: 15 });

  const collapseRes = await editLayer(layerId, ["--runs", "none"]);
  expect(collapseRes.code).toBe(0);
  const collapsed = revOf(collapseRes.body) as RunsRev;
  expect(collapsed.text).toBe("5 HERDR PLUGINS!");
  expect(collapsed.runs).toBeUndefined();
});

test("a run style override lands only on its run; other runs keep the layer defaults", async () => {
  const layerId = await seededRunsLayer();
  const res = await editLayer(layerId, ["--run-color", "1=#ef4444", "--run-weight", "3=300"]);
  expect(res.code).toBe(0);
  const rev = revOf(res.body) as RunsRev;
  const runs = rev.runs!;
  expect(runs[0]).toEqual({ color: "#ef4444" });
  expect(runs[1]).toEqual({ start: 2 });
  expect(runs[2]).toEqual({ start: 8, weight: 300, width: 100 });
});

test("editing the layer's default colour keeps run overrides; runs without one follow the new default", async () => {
  const layerId = await seededRunsLayer();
  const res = await editLayer(layerId, ["--run-color", "2=#22c55e", "--color", "#111827"]);
  expect(res.code).toBe(0);
  const rev = revOf(res.body) as RunsRev;
  expect(rev.color).toBe("#111827");
  const runs = rev.runs!;
  expect(runs[1]!.color).toBe("#22c55e"); // run 2 keeps its own override
  expect(runs[0]).toEqual({}); // run 1 follows the new layer default
});

test("removing a run's font override falls back to the layer font", async () => {
  const layerId = await seededRunsLayer();
  const setRes = await editLayer(layerId, ["--run-font", "2=Anton"]);
  expect(setRes.code).toBe(0);
  const withFont = revOf(setRes.body) as RunsRev;
  expect(typeof withFont.runs![1]!.contentHash).toBe("string");
  const unsetRes = await editLayer(layerId, ["--run-font", "2=none"]);
  expect(unsetRes.code).toBe(0);
  const cleared = revOf(unsetRes.body) as RunsRev;
  expect(cleared.runs![1]).toEqual({ start: 2 });
});

test("a caller font file works as a run font; measure reports the run's family", async () => {
  const added = await addRunsLayer("headline", ["5 ", "HERDR ", "PLUGINS"], ["--font", "Archivo", "--font-size", "64"]);
  const layerId = layerIdOf(added);
  const res = await editLayer(layerId, ["--run-font-file", `2=${HANDJET}`]);
  expect(res.code).toBe(0);
  const rev = revOf(res.body) as RunsRev;
  expect(rev.runs![1]!.callerFont!.family).toBe("Handjet");
  expect(typeof rev.runs![1]!.weight).toBe("number");

  const layer = await measureLayer();
  const runs = layer.runs as Array<Record<string, unknown>>;
  expect(runs).toHaveLength(3);
  expect(runs[1]!.index).toBe(2);
  expect(runs[1]!.text).toBe("HERDR ");
  expect(runs[1]!.font).toEqual({ family: "Handjet", caller: true });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("bare --text on a multi-run Layer is refused, naming the scoped forms", async () => {
  const layerId = await seededRunsLayer();
  const res = await editLayer(layerId, ["--text", "new text"]);
  expect(res.code).toBe(1);
  expect((res.body as { error?: string }).error).toContain("--run-text");
  expect((res.body as { error?: string }).error).toContain("--runs none");
});

test("per-run setters on a single-run Layer are refused, naming the layer-level spelling", async () => {
  const added = await addLayer("solo", ["--text", "solo", "--font", "Archivo"]);
  const res = await editLayer(layerIdOf(added), ["--run-color", "1=#ef4444"]);
  expect(res.code).toBe(1);
  expect((res.body as { error?: string }).error).toContain("--color");
});

test("a run index past the run count is refused on edit, naming the existing runs", async () => {
  const layerId = await seededRunsLayer();
  const res = await editLayer(layerId, ["--run-color", "4=#ef4444"]);
  expect(res.code).toBe(1);
  expect((res.body as { error?: string }).error).toContain("3 runs");
});

test("per-run style setters need a multi-run Layer on edit", async () => {
  const added = await addLayer("solo", ["--text", "solo", "--font", "Archivo"]);
  const res = await editLayer(layerIdOf(added), ["--run-weight", "2=800"]);
  expect(res.code).toBe(1);
  expect((res.body as { error?: string }).error).toContain("one run");
});

test("--text and --run are mutually exclusive content options", async () => {
  const res = await invoke([
    "composition", "add", "poster", "both", "--text", "hi", "--run", "there",
    "--font", "Archivo", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(2);
  expect(res.stderr + res.stdout).toContain("--text and --run");
});

test("the boundary shape of the per-run setters is shared by add and edit", async () => {
  const badArgs = ["--run-color", "banana"];
  const addRes = await invoke(["composition", "add", "poster", "x1", "--text", "hi", "--font", "Archivo", ...badArgs, "--project", projDir, "--json"]);
  const editRes = await invoke(["layer", "edit", "layer_nope", ...badArgs, "--project", projDir, "--json"]);
  // Both surfaces refuse the malformed boundary shape with the same text.
  expect(addRes.code).toBe(2);
  expect(addRes.stderr + addRes.stdout).toContain("1-based run index>=");
  expect(editRes.code).toBe(2);
  expect(editRes.stderr + editRes.stdout).toContain("1-based run index>=");
});

test("two font sources for one run are refused like the layer-level rule", async () => {
  const added = await addRunsLayer("headline", ["a", "b"], ["--font", "Archivo"]);
  const res = await editLayer(layerIdOf(added), ["--run-font", "1=Anton", "--run-font-file", `1=${SILKSCREEN}`]);
  expect(res.code).toBe(1);
  expect((res.body as { error?: string }).error).toContain("one font per");
});

test("run axes are validated against the run's effective face", async () => {
  const added = await addRunsLayer("headline", ["a ", "b"], ["--font", "Anton"]);
  const res = await editLayer(layerIdOf(added), ["--run-weight", "1=800"]);
  expect(res.code).toBe(1);
  expect((res.body as { error?: string }).error).toContain("Anton");
});

test("run options on non-text Layers are refused by kind stability", async () => {
  const pngPath = path.join(tempDir, "red.png");
  const buf = Buffer.alloc(8 * 8 * 4);
  buf.fill(255);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(pngPath, encodePngRgba(8, 8, buf));
  const added = await invoke(["composition", "add", "poster", "img", "--image", pngPath, "--project", projDir, "--json"]);
  expect(added.code).toBe(0);
  const res = await editLayer(layerIdOf(json(added.stdout)), ["--run-color", "1=#ef4444"]);
  expect(res.code).toBe(1);
  expect((res.body as { error?: string }).error).toContain("image Layer");
});

test("--runs and --run-text are edit-only options", async () => {
  const res = await invoke(["composition", "add", "poster", "x2", "--text", "hi", "--font", "Archivo", "--runs", "none", "--project", projDir, "--json"]);
  expect(res.code).toBe(2);
  expect(res.stderr + res.stdout).toContain("--runs");
  const res2 = await invoke(["composition", "add", "poster", "y1", "--text", "hi", "--font", "Archivo", "--run-text", "1=nope", "--project", projDir, "--json"]);
  expect(res2.code).toBe(2);
  expect(res2.stderr + res2.stdout).toContain("--run-text");
});

test("--runs takes only the literal none", async () => {
  const added = await addLayer("solo2", ["--text", "solo", "--font", "Archivo"]);
  const res = await invoke(["layer", "edit", layerIdOf(added), "--runs", "banana", "--project", projDir, "--json"]);
  expect(res.code).toBe(2);
  expect(res.stderr + res.stdout).toContain("the form that collapses a multi-run Layer");
});

test("an empty run text is refused", async () => {
  const res = await invoke(["composition", "add", "poster", "empty", "--run", "a", "--run", "", "--font", "Archivo", "--project", projDir, "--json"]);
  expect(res.code).toBe(2);
  expect(res.stderr + res.stdout).toContain("--run");
});

// ---------------------------------------------------------------------------
// measure
// ---------------------------------------------------------------------------

test("measure reports each run's weight and font beside the layer-level facts", async () => {
  await addRunsLayer("headline", ["5 ", "HERDR ", "PLUGINS"], [
    "--font", "Archivo", "--font-size", "64",
    "--run-weight", "1=200",
  ]);
  const layer = await measureLayer("headline");
  const runs = layer.runs as Array<Record<string, unknown>>;
  expect(runs).toHaveLength(3);
  expect(runs[0]).toEqual({
    index: 1, text: "5 ", color: { type: "solid", color: "#ffffff" }, font: null, axes: { weight: 200, width: 100 },
  });
  expect(runs[1]).toEqual({
    index: 2, text: "HERDR ", color: { type: "solid", color: "#ffffff" }, font: null, axes: null,
  });
  // (run 2 has no overrides: it paints the layer axes and reports null)
  expect(runs[2]).toEqual({
    index: 3, text: "PLUGINS", color: { type: "solid", color: "#ffffff" }, font: null, axes: null,
  });
});

test("a single-run Layer's measure report carries no runs field", async () => {
  await addLayer("solo", ["--text", "solo", "--font", "Archivo", "--weight", "800"]);
  const layer = await measureLayer("solo");
  expect(layer.runs).toBeUndefined();
  expect(layer.axes).toEqual({ weight: 800, width: 100 });
});

// ---------------------------------------------------------------------------
// Wrap width and fit across runs
// ---------------------------------------------------------------------------

test("wrap width applies across runs: the one element wraps, runs flow inside it", async () => {
  await addRunsLayer("headline", ["a short ", "headline"], [
    "--font", "Archivo", "--font-size", "48",
    "--run-font", "2=Archivo Black",
    "--wrap-width", "160",
  ]);
  const layer = await measureLayer("headline");
  const content = layer.content as { width: number; height: number };
  expect(content.width).toBeLessThanOrEqual(161);
  expect(layer.wrapWidth).toBe(160);
});

test("a fit box applies across runs: measure reports the effective font size", async () => {
  await addRunsLayer("fitted", ["big ", "words"], [
    "--font", "Archivo", "--font-size", "96", "--fit-box", "150x50",
  ]);
  const layer = await measureLayer("fitted");
  expect(layer.fit).toEqual({ width: 150, height: 50 });
  expect(layer.effectiveFontSize).toBeLessThan(96);
});

// ---------------------------------------------------------------------------
// TEST-002: offline reversibility and replay
// ---------------------------------------------------------------------------

async function renderPng(comp = "poster"): Promise<{ bytes: Buffer; manifest: string }> {
  const render = await invoke(["composition", "render", comp, "--project", projDir, "--supersample", "1", "--json"]);
  expect(render.code).toBe(0);
  const parsed = JSON.parse(render.stdout) as { render: { output: string; manifest: string } };
  return { bytes: await readFile(parsed.render.output), manifest: parsed.render.manifest };
}

test("collapsing runs restores the single-run render byte-for-byte (offline reversibility, TEST-002)", async () => {
  // The reference: the same look as a plain single-run Layer.
  await addLayer("reference", ["--text", "5 HERDR PLUGINS", "--font", "Archivo", "--font-size", "64", "--color", "#111827", "--x", "40", "--y", "60"]);
  await addRunsLayer("runs", ["5 ", "HERDR ", "PLUGINS"], ["--font", "Archivo", "--font-size", "64", "--color", "#111827", "--x", "40", "--y", "60"]);
  // The runs Layer starts differently (run colour overrides), so its render
  // provably differs from the reference before the collapse.
  const listed = JSON.parse((await invoke(["composition", "measure", "poster", "--project", projDir, "--json"])).stdout) as { layers: Array<{ layerId: string; name: string }> };
  const runsId = listed.layers.find((l) => l.name === "runs")!.layerId;
  // The reference render, BEFORE the override edit.
  const referenceRender = await renderPng();
  const override = await editLayer(runsId, ["--run-color", "2=#ef4444"]);
  expect(override.code).toBe(0);
  const overriddenRender = await renderPng();
  expect(Buffer.compare(overriddenRender.bytes, referenceRender.bytes)).not.toBe(0);

  // Collapse the runs Layer to a single run at its Layer defaults: every
  // boundary and override is removed at once, and the render returns to the
  // reference's pixels byte-for-byte.
  const collapse = await editLayer(runsId, ["--runs", "none"]);
  expect(collapse.code).toBe(0);
  const collapsedRender = await renderPng();
  expect<Buffer>(collapsedRender.bytes).toEqual(referenceRender.bytes);
});

test("a Layer with run font overrides renders and replays byte-identically (TEST-002/TEST-003)", async () => {
  // Bundled and caller run fonts: both faces are declared from the run's
  // own retained bytes, and the pinned Render replays from them alone.
  const added = await addRunsLayer("headline", ["5 ", "HERDR ", "PLUGINS"], [
    "--font", "Archivo", "--font-size", "64",
    "--run-font", "2=Archivo Black",
    "--run-font-file", `3=${HANDJET}`,
    "--x", "40", "--y", "60",
  ]);
  expect(added.ok).toBe(true);
  const first = await renderPng();
  const replay = await invoke(["composition", "replay", first.manifest, "--project", projDir, "--json"]);
  expect(replay.code).toBe(0);
  const parsed = JSON.parse(replay.stdout) as { ok: boolean; replay: { output: string } };
  expect(parsed.ok).toBe(true);
  expect<Buffer>(await readFile(parsed.replay.output)).toEqual(first.bytes);
});

test("a retained Render of a multi-run Layer replays byte-identically (TEST-003)", async () => {
  await addRunsLayer("headline", ["5 ", "HERDR ", "PLUGINS"], [
    "--font", "Archivo", "--font-size", "64",
    "--run-color", "2=linear:90deg,#ffb347,#c0182b",
    "--run-weight", "2=800",
    "--x", "40", "--y", "60",
  ]);
  const first = await renderPng();

  // A later edit (the Layer's placement) publishes a new revision; the
  // pinned Render history must still replay the ORIGINAL pixels.
  const listed = JSON.parse((await invoke(["composition", "measure", "poster", "--project", projDir, "--json"])).stdout) as { layers: Array<{ layerId: string }> };
  const editRes = await editLayer(listed.layers[0]!.layerId, ["--y", "80"]);
  expect(editRes.code).toBe(0);
  const replay = await invoke(["composition", "replay", first.manifest, "--project", projDir, "--json"]);
  expect(replay.code).toBe(0);
  const parsed = JSON.parse(replay.stdout) as { ok: boolean; replay: { output: string } };
  expect(parsed.ok).toBe(true);
  expect<Buffer>(await readFile(parsed.replay.output)).toEqual(first.bytes);
});