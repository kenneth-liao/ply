/**
 * Wrap width as a text revision fact (#294, spec #285 US-015, ISC-55,
 * DEC-001/DEC-005, ADR-0017 amendment): `--wrap-width <num|none>` is an
 * ABSOLUTE setter measured in layout pixels (before the canonical transform
 * — scale and rotation apply to the wrapped box afterwards), stored only
 * when set, with the documented removal value "none".
 *
 * With a width set, a natural-layout text Layer soft-wraps at spaces within
 * the width (written line breaks still break; preserved spaces still hold);
 * with none, it stays on one line (`white-space: pre; width: max-content`).
 * Line height and tracking apply across the wrapped lines, measure reports
 * the wrapped box, and removing the width restores the unwrapped render
 * byte-for-byte. Setting the width is an edit, so a legacy-rule revision
 * migrates to natural layout (ADR-0017 amendment) — a legacy revision never
 * carries a wrap width.
 *
 * TEST-002: offline reversibility and replay at the CLI seam — every pixel,
 * measure, and hash assertion runs locally against temporary Projects (no
 * network, no weights), under the per-file `bun test --isolate` topology.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, rm as rmFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { computeRevisionHash } from "../src/layer.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

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

const close = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

/** A long single-line string: far wider than the wrap width at 32px, with
 *  spaces to soft-wrap at and no written line breaks. */
const LONG_LINE =
  "The quick brown fox jumps over the lazy dog and keeps running through the meadow beyond the western hill";

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-text-wrap-width-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "wrap-proj"]);
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function makeComp(name: string, width = 900, height = 600): Promise<void> {
  const res = await invoke(["composition", "create", name, "--width", String(width), "--height", String(height), "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
}

async function addText(comp: string, name: string, extra: string[]): Promise<{ layerId: string; revision: Record<string, unknown> }> {
  const res = await invoke([
    "composition", "add", comp, name,
    "--text", LONG_LINE, "--font", "Archivo", "--font-size", "32", "--color", "#000000",
    ...extra, "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  return { layerId: json.use.layerId as string, revision: json.layer.currentRevision as Record<string, unknown> };
}

/** The measured report for one use: layout content box + painted extents. */
async function measure(comp: string, use: string): Promise<Record<string, any>> {
  const res = await invoke(["composition", "measure", comp, use, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.layers).toHaveLength(1);
  return json.layers[0] as Record<string, any>;
}

async function render(comp: string): Promise<Buffer> {
  const res = await invoke(["composition", "render", comp, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return await readFile(JSON.parse(res.stdout).render.output as string);
}

async function inspect(layerId: string): Promise<Record<string, any>> {
  const res = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).layer as Record<string, any>;
}

/** The stored revision document on disk, read through its pinned id. */
async function readStoredRevision(layerId: string, revId: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(projDir, "layers", `${layerId}.revisions`, `${revId}.json`), "utf8"));
}

/**
 * The revision-hash oracle for this ticket: the pre-#294 formula (the
 * current hash) plus `:wrapwidth(<W>)` appended ONLY when a wrap width is
 * stored. A stored document without the field must hash exactly as today —
 * pre-#294 revision ids stay byte-identical.
 */
function wrapHashOracle(rev: Record<string, any>): string {
  const base = `${rev.layerId}:${rev.kind}:${rev.contentHash}:${rev.x}:${rev.y}:${rev.opacity}:${rev.createdAt}`;
  const textFields = `:${rev.text}:${rev.fontSize}:${rev.color}`;
  const scaleFields =
    rev.scaleX !== undefined || rev.scaleY !== undefined ? `:${rev.scaleX}:${rev.scaleY}` : "";
  const rotationField = rev.rotationDeg !== undefined ? `:${rev.rotationDeg}` : "";
  const flipFields =
    rev.flipX !== undefined || rev.flipY !== undefined ? `:${rev.flipX}:${rev.flipY}` : "";
  const textAxes =
    rev.weight !== undefined || rev.width !== undefined ? `:textaxes(${rev.weight},${rev.width})` : "";
  const typographyFields =
    (rev.tracking !== undefined ? `:tracking(${rev.tracking})` : "") +
    (rev.lineHeight !== undefined ? `:lineheight(${rev.lineHeight})` : "");
  const layoutRuleField = rev.layoutRule === "natural" ? ":layoutrule(natural)" : "";
  const wrapWidthField = rev.wrapWidth !== undefined ? `:wrapwidth(${rev.wrapWidth})` : "";
  return `rev_${new Bun.CryptoHasher("sha256").update(`${base}${textFields}${scaleFields}${rotationField}${flipFields}${textAxes}${typographyFields}${layoutRuleField}${wrapWidthField}`).digest("hex").slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Wrapping behavior and measurement (US-015 acceptance 1-3)
// ---------------------------------------------------------------------------

test("a wrap width soft-wraps a single-line string at spaces; measure reports the wrapped box", async () => {
  await makeComp("poster");
  const plain = await addText("poster", "plain", []);
  const wrapped = await addText("poster", "wrapped", ["--wrap-width", "220"]);

  // Absent: natural one-line layout — the content box is one wide line.
  const plainBox = await measure("poster", "plain");
  expect(plainBox.content.width).toBeGreaterThan(400);
  expect(plainBox.content.height).toBeLessThan(60); // one 32px line
  expect(plain.revision.wrapWidth).toBeUndefined();

  // Set: the line soft-wraps at spaces (no written breaks in LONG_LINE) —
  // the wrapped box is the width's own width and several lines tall.
  const wrappedBox = await measure("poster", "wrapped");
  expect(wrappedBox.content.width).toBeLessThan(240);
  expect(wrappedBox.content.height).toBeGreaterThan(2 * plainBox.content.height);
  expect(wrapped.revision.wrapWidth).toBe(220);

  // The wrapped width lands in the element's own box (layout px, before the
  // transform — scale/rotation map the wrapped box afterwards, proven by
  // the transform tests below).
  expect(close(wrappedBox.content.width, 220, 1)).toBe(true);
}, 30_000);

test("the wrap width is a LAYOUT-px fact: scale maps the wrapped box, rotation swaps its AABB", async () => {
  await makeComp("poster", 1200, 900);
  const scaled = await addText("poster", "scaled", ["--wrap-width", "220", "--scale", "2", "--y", "20"]);
  const rotated = await addText("poster", "rotated", ["--wrap-width", "220", "--rotate", "90", "--y", "500"]);
  void scaled;
  void rotated;

  const scaledBox = (await measure("poster", "scaled"));
  const rotatedBox = (await measure("poster", "rotated"));

  // Scale 2: the untransformed content box is STILL the 220px wrapped box
  // (W is a layout-px fact, never painted px); the transformed box is its
  // 2× projection.
  expect(close(scaledBox.content.width, 220, 1)).toBe(true);
  expect(close(scaledBox.box.width, 2 * scaledBox.content.width, 2)).toBe(true);
  expect(close(scaledBox.box.height, 2 * scaledBox.content.height, 2)).toBe(true);

  // Rotate 90°: the wrapped box's AABB swaps — box width ≈ content height,
  // box height ≈ content width — proving the wrap happened in layout space
  // and the transform mapped it afterwards.
  expect(close(rotatedBox.box.width, rotatedBox.content.height, 2)).toBe(true);
  expect(close(rotatedBox.box.height, rotatedBox.content.width, 2)).toBe(true);
  expect(close(rotatedBox.content.width, 220, 1)).toBe(true);
}, 30_000);

test("written line breaks still break under a wrap width, matching the unwrapped multi-line layout", async () => {
  await makeComp("poster");
  const text = "First written line\nSecond written line\nThird written line";
  const mk = (name: string, extra: string[]) =>
    invoke([
      "composition", "add", "poster", name,
      "--text", text, "--font", "Archivo", "--font-size", "32", "--color", "#000000",
      ...extra, "--project", projDir, "--json",
    ]);
  const plainRes = await mk("plain", []);
  expect(plainRes.code).toBe(0);
  const wideRes = await mk("wide", ["--wrap-width", "600", "--y", "300"]);
  expect(wideRes.code).toBe(0);

  // The width is wide enough that each written line fits: the wrapped box
  // matches the unwrapped written-breaks box line for line.
  const plainBox = (await measure("poster", "plain")).content;
  const wideBox = (await measure("poster", "wide")).content;
  expect(close(wideBox.height, plainBox.height, 2)).toBe(true);
  expect(plainBox.height).toBeGreaterThan(2.5 * 32); // three lines, not one
}, 30_000);

test("line height and tracking apply across the wrapped lines", async () => {
  await makeComp("poster");
  await addText("poster", "base", ["--wrap-width", "220"]);
  await addText("poster", "spaced", ["--wrap-width", "220", "--line-height", "2"]);
  await addText("poster", "tracked", ["--wrap-width", "220", "--tracking", "0.4"]);

  const base = (await measure("poster", "base")).content;
  const spaced = (await measure("poster", "spaced")).content;
  const tracked = (await measure("poster", "tracked")).content;

  // Line height multiplies across every wrapped line, not just the first.
  expect(spaced.height).toBeGreaterThan(1.7 * base.height);
  // Tracking widens the ink, shifting the soft-wrap points: the wrapped
  // line count grows (or, at minimum, the wrapped layout changes measurably).
  expect(tracked.height).toBeGreaterThan(base.height);
}, 30_000);

// ---------------------------------------------------------------------------
// Removal restores the unwrapped render byte-for-byte (DEC-005)
// ---------------------------------------------------------------------------

test("removing the width with 'none' restores the unwrapped render byte-for-byte and unstores the fact", async () => {
  await makeComp("poster");
  const { layerId } = await addText("poster", "rev", []);

  const unwrapped = await render("poster");
  await invoke(["layer", "edit", layerId, "--wrap-width", "220", "--project", projDir, "--json"]);
  const wrapped = await render("poster");
  expect(wrapped.equals(unwrapped)).toBe(false);

  const edit = await invoke(["layer", "edit", layerId, "--wrap-width", "none", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);
  const restored = await render("poster");
  expect(restored.equals(unwrapped)).toBe(true);

  // The fact is gone from the revision, not zeroed.
  const layer = await inspect(layerId);
  expect(layer.currentRevision.wrapWidth).toBeUndefined();
  const stored = await readStoredRevision(layerId, layer.currentRevisionId as string);
  expect(stored.wrapWidth).toBeUndefined();
}, 60_000);

test("a retained Render replays byte-identically after the width round-trips", async () => {
  await makeComp("poster");
  const { layerId } = await addText("poster", "rev", ["--wrap-width", "220"]);
  const renderRes = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(renderRes.code).toBe(0);
  const pinned = await readFile(JSON.parse(renderRes.stdout).render.output as string);
  const manifest = JSON.parse(renderRes.stdout).render.manifest as string;

  // Later edits change the current revision; the pinned Render keeps
  // replaying from its pinned wrapped revision.
  await invoke(["layer", "edit", layerId, "--wrap-width", "none", "--project", projDir, "--json"]);
  const replayRes = await invoke(["composition", "replay", manifest, "--project", projDir, "--json"]);
  expect(replayRes.code).toBe(0);
  const replayed = await readFile(JSON.parse(replayRes.stdout).replay.output as string);
  expect(replayed.equals(pinned)).toBe(true);
}, 60_000);

// ---------------------------------------------------------------------------
// Stored form and revision hash: present only when set, old ids stable
// ---------------------------------------------------------------------------

test("the stored document carries wrapWidth only when set, and the hash oracle pins both forms", async () => {
  await makeComp("poster");
  const plain = await addText("poster", "plain", []);
  const wrapped = await addText("poster", "wrapped", ["--wrap-width", "220"]);

  // Absent: the stored document has no wrapWidth field at all, and the
  // revision id is exactly the pre-#294 formula's output (no width field).
  const plainStored = await readStoredRevision(plain.layerId, plain.revision.revisionId as string);
  expect(plainStored).not.toHaveProperty("wrapWidth");
  expect(plain.revision.revisionId).toBe(wrapHashOracle(plainStored));

  // Set: the field is stored, and the oracle's :wrapwidth(...) matches.
  const wrappedStored = await readStoredRevision(wrapped.layerId, wrapped.revision.revisionId as string);
  expect(wrappedStored.wrapWidth).toBe(220);
  expect(wrapped.revision.revisionId).toBe(wrapHashOracle(wrappedStored));

  // Removing the width returns the document to the pre-#294 shape and the
  // oracle without the width field (a fresh createdAt makes the id differ,
  // but the FORM is the pre-#294 one).
  await invoke(["layer", "edit", wrapped.layerId, "--wrap-width", "none", "--project", projDir, "--json"]);
  const layer = await inspect(wrapped.layerId);
  const removed = await readStoredRevision(wrapped.layerId, layer.currentRevisionId as string);
  expect(removed).not.toHaveProperty("wrapWidth");
  expect(layer.currentRevisionId).toBe(wrapHashOracle(removed));
}, 30_000);

// ---------------------------------------------------------------------------
// Legacy-rule interaction: setting a width is an edit, so the revision
// becomes natural (ADR-0017 amendment) — legacy revisions never carry a width
// ---------------------------------------------------------------------------

test("editing a legacy-rule revision to set a width migrates it to natural layout", async () => {
  await makeComp("poster");
  const { layerId } = await addText("poster", "legacy", ["--x", "10", "--y", "10"]);

  // Simulate a pre-#287 legacy revision (lacking layoutRule) with the
  // established re-hash pattern.
  const inspectBefore = await inspect(layerId);
  const revId = inspectBefore.currentRevisionId as string;
  const revPath = path.join(projDir, "layers", `${layerId}.revisions`, `${revId}.json`);
  const revJson = await readStoredRevision(layerId, revId);
  delete revJson.layoutRule;
  const legacyRevId = computeRevisionHash(revJson as never);
  await rmFile(revPath);
  await writeFile(path.join(projDir, "layers", `${layerId}.revisions`, `${legacyRevId}.json`), JSON.stringify(revJson, null, 2) + "\n");
  const idPath = path.join(projDir, "layers", `${layerId}.json`);
  const idJson = JSON.parse(await readFile(idPath, "utf8"));
  idJson.currentRevision = legacyRevId;
  await writeFile(idPath, JSON.stringify(idJson, null, 2) + "\n");

  // The legacy revision renders on one (canvas-bounded) line here.
  const legacyRender = await render("poster");

  // Setting a wrap width IS an edit: the revision publishes natural layout
  // with the width, and the text soft-wraps within it.
  const edit = await invoke(["layer", "edit", layerId, "--wrap-width", "220", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);
  const layer = await inspect(layerId);
  expect(layer.currentRevision.layoutRule).toBe("natural");
  expect(layer.currentRevision.wrapWidth).toBe(220);
  const wrappedRender = await render("poster");
  expect(wrappedRender.equals(legacyRender)).toBe(false);
  const box = (await measure("poster", "legacy")).content;
  expect(close(box.width, 220, 1)).toBe(true);
  expect(box.height).toBeGreaterThan(60);
}, 60_000);

// ---------------------------------------------------------------------------
// Refusals beyond the shared parity rows (semantics, not boundary shape)
// ---------------------------------------------------------------------------

test("wrap width refuses zero, negatives, and non-text kinds with the established wordings", async () => {
  await makeComp("poster");
  const { layerId } = await addText("poster", "txt", []);
  const imgPath = path.join(tempDir, "red.png");
  await writeFile(imgPath, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ));
  const imgRes = await invoke(["composition", "add", "poster", "img", "--image", imgPath, "--project", projDir, "--json"]);
  expect(imgRes.code).toBe(0);
  const imgId = JSON.parse(imgRes.stdout).use.layerId as string;

  // Zero, negative, and over-cap: the absolute setter's range refusal (the
  // parser accepts the shape; the shared validator refuses the value, the
  // 8192px cap matching font-size and the resize forms). JSON mode reports
  // the refusal in the result body, so assert on both streams.
  for (const bad of ["0", "-5", "8193"]) {
    const res = await invoke(["layer", "edit", layerId, "--wrap-width", bad, "--project", projDir, "--json"]);
    expect(res.code).toBe(2);
    expect(res.stderr + res.stdout).toContain(
      "Wrap width (--wrap-width) must be a finite number between 1 and 8192 layout px",
    );
  }

  // The same over-cap refusal fires on add, with the identical wording —
  // the shared cap wording on both surfaces (#294 review PROD-1).
  const overAdd = await invoke([
    "composition", "add", "poster", "over", "--text", "hi", "--font", "Archivo",
    "--wrap-width", "8193", "--project", projDir, "--json",
  ]);
  expect(overAdd.code).toBe(2);
  expect(overAdd.stderr + overAdd.stdout).toContain(
    "Wrap width (--wrap-width) must be a finite number between 1 and 8192 layout px",
  );

  // Kind stability: refused on an image Layer, naming the kind (JSON mode
  // reports the refusal in the result body).
  const res = await invoke(["layer", "edit", imgId, "--wrap-width", "220", "--project", projDir, "--json"]);
  expect(res.code).toBe(1);
  expect(res.stderr + res.stdout).toContain("image Layer");

  // On add: the text style options require --text (JSON mode reports the
  // refusal in the result body).
  const addRes = await invoke(["composition", "add", "poster", "nope", "--wrap-width", "220", "--project", projDir, "--json"]);
  expect(addRes.code).toBe(2);
  expect(addRes.stderr + addRes.stdout).toContain("require --text");
}, 60_000);