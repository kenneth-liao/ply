/**
 * Text Layers shrink to fit a caller-set box (#295, spec #285 US-016,
 * ISC-56, DEC-010, DEC-005): `--fit-box <WxH|none>` is an ABSOLUTE setter
 * measured in layout pixels (before the canonical transform), stored only
 * when set, with the documented removal value "none".
 *
 * DEC-010: fit-to-box shrinks the font size only — it never grows the
 * size, and it never changes weight or width. `measure` reports the
 * effective font size. Text that cannot fit at the minimum size (the
 * documented fixed 8px floor) is refused on add and edit before anything
 * publishes, naming the box and the size needed. With a wrap width set,
 * the box bounds the WRAPPED block: the wrap width stays the wrapping
 * width and the box height bounds the wrapped block's height (a fit box
 * narrower than the wrap width is refused — a wrapped block can be up to
 * its wrap width wide, so a narrower box could never be satisfied).
 *
 * The effective font size is never stored: it is derived at read time by
 * the ONE in-page derivation pass shared by paint, measure, and anchor,
 * so it stays correct when text, font, tracking, or wrap width later
 * change, and removing the box restores the render byte-for-byte.
 *
 * TEST-001/TEST-002: offline CLI-seam behaviour, reversibility, and
 * replay — every pixel, measure, and hash assertion runs locally against
 * temporary Projects (no network, no weights), under the per-file
 * `bun test --isolate` topology.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

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

/** A headline far wider than 600px at 120px (TEST-001's probe string). */
const HEADLINE = "THE QUICK BROWN FOX JUMPS";
/** A long single-line string used for the below-minimum refusal. */
const LONG_LINE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-text-fit-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "fit-proj"]);
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
    "--text", HEADLINE, "--font", "Archivo", "--font-size", "120", "--color", "#000000",
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
 * The revision-hash oracle for this ticket: the pre-#295 formula (the
 * current hash) plus `:fitbox(<W>x<H>)` appended ONLY when a fit box is
 * stored. A stored document without the fields must hash exactly as
 * today — pre-#295 revision ids stay byte-identical.
 */
function fitHashOracle(rev: Record<string, any>): string {
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
  const fitBoxField = rev.fitWidth !== undefined ? `:fitbox(${rev.fitWidth}x${rev.fitHeight})` : "";
  return `rev_${new Bun.CryptoHasher("sha256").update(`${base}${textFields}${scaleFields}${rotationField}${flipFields}${textAxes}${typographyFields}${layoutRuleField}${wrapWidthField}${fitBoxField}`).digest("hex").slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// The 600px headline probe (US-016 acceptance 1): one line inside the box,
// nothing clipped, measure reports the effective font size
// ---------------------------------------------------------------------------

test("a headline wider than a 600px box measures as one line inside the box at a reduced size, with nothing clipped", async () => {
  await makeComp("poster");
  const { revision } = await addText("poster", "fit", ["--fit-box", "600x200", "--x", "20", "--y", "100"]);

  // The fact stores as the caller set it.
  expect(revision.fitWidth).toBe(600);
  expect(revision.fitHeight).toBe(200);
  expect(revision.fontSize).toBe(120);

  const m = await measure("poster", "fit");

  // measure reports the effective font size — smaller than the stored 120px,
  // above the 8px minimum, and the stored font size is untouched.
  const effective = m.effectiveFontSize as number;
  expect(effective).toBeGreaterThan(8);
  expect(effective).toBeLessThan(120);

  // One line INSIDE the box: the content box fits 600×200 in layout px.
  expect(m.fit).toEqual({ width: 600, height: 200 });
  expect((m.content.width as number)).toBeLessThanOrEqual(602);
  expect((m.content.height as number)).toBeLessThanOrEqual(202);
  // One line, not wrapped: the box height is close to a single line at the
  // effective size (natural layout wraps only at written breaks).
  expect((m.content.height as number)).toBeLessThan(effective * 2.2);

  // Nothing clipped: the rendered ink ends inside the box's right edge
  // (x = 20 + 600) and bottom (y = 100 + 200).
  const res = await invoke(["composition", "render", "poster", "--project", projDir, "--out", path.join(tempDir, "fit.png"), "--supersample", "1"]);
  expect(res.code).toBe(0);
  const { decodePng } = await import("../src/png.js");
  const png = decodePng(await readFile(path.join(tempDir, "fit.png")));
  const inkAt = (x: number, y: number): boolean => {
    const i = (y * png.width + x) * 4;
    return png.rgba[i + 3]! > 0;
  };
  let maxInkX = 0;
  let maxInkY = 0;
  for (let y = 90; y < 320; y++) {
    for (let x = 10; x < 700; x++) {
      if (inkAt(x, y)) {
        if (x > maxInkX) maxInkX = x;
        if (y > maxInkY) maxInkY = y;
      }
    }
  }
  expect(maxInkX).toBeGreaterThan(20); // sanity: there IS ink
  expect(maxInkX).toBeLessThanOrEqual(620);
  expect(maxInkY).toBeLessThanOrEqual(300);
}, 60_000);

// ---------------------------------------------------------------------------
// DEC-010: fit only shrinks — never grows, never changes weight or width
// ---------------------------------------------------------------------------

test("fit only shrinks: text that already fits keeps its stored size and renders byte-identically to no box", async () => {
  await makeComp("poster");
  const mk = (comp: string, name: string, extra: string[]) =>
    invoke([
      "composition", "add", comp, name,
      "--text", "Hello", "--font", "Archivo", "--font-size", "32", "--color", "#000000",
      ...extra, "--project", projDir, "--json",
    ]);
  const boxedAdd = await mk("poster", "boxed", ["--fit-box", "600x400"]);
  expect(boxedAdd.code).toBe(0);

  // The box is larger than the ink in both axes: no shrink — the effective
  // size IS the stored size.
  const boxed = await measure("poster", "boxed");
  expect(boxed.effectiveFontSize).toBe(32);

  // And the render is byte-identical to the same text without a box (same
  // canvas size, same text, same placement).
  await makeComp("poster2");
  const plainAdd = await mk("poster2", "plain", []);
  expect(plainAdd.code).toBe(0);
  const fittedRes = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(fittedRes.code).toBe(0);
  const plainRenderRes = await invoke(["composition", "render", "poster2", "--project", projDir, "--json"]);
  expect(plainRenderRes.code).toBe(0);
  const fitted = await readFile(JSON.parse(fittedRes.stdout).render.output as string);
  const plainPng = await readFile(JSON.parse(plainRenderRes.stdout).render.output as string);
  expect(fitted.equals(plainPng)).toBe(true);
}, 60_000);

test("fit derives through the nested gradient markup too: a gradient headline shrinks inside its box", async () => {
  await makeComp("poster");
  const res = await invoke([
    "composition", "add", "poster", "grad",
    "--text", HEADLINE, "--font", "Archivo", "--font-size", "120",
    "--color", "linear:90deg,#ff0000,#0000ff",
    "--fit-box", "600x200", "--x", "20", "--y", "100",
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);

  // The gradient structure nests the text element inside an effect wrapper;
  // the derivation finds the font-size-carrying element either way, and the
  // fitted block stays inside the box.
  const m = await measure("poster", "grad");
  expect(m.effectiveFontSize as number).toBeLessThan(120);
  expect(m.effectiveFontSize as number).toBeGreaterThan(8);
  expect(m.content.width as number).toBeLessThanOrEqual(602);
  expect(m.content.height as number).toBeLessThanOrEqual(202);
}, 60_000);

test("fit never changes weight or width: a bold variable-face headline shrinks with its axes stored intact", async () => {
  await makeComp("poster");
  await addText("poster", "bold", ["--weight", "700", "--fit-box", "400x200", "--x", "20", "--y", "50"]);

  const m = await measure("poster", "bold");
  // DEC-010: the axes are exactly the stored ones — shrink touches the font
  // size alone.
  expect((m.axes as { weight: number }).weight).toBe(700);
  expect(m.effectiveFontSize).toBeLessThan(120);
  expect(m.effectiveFontSize).toBeGreaterThan(8);
  expect((m.content.width as number)).toBeLessThanOrEqual(402);
}, 60_000);

// ---------------------------------------------------------------------------
// Removal restores the render byte-for-byte; pinned Renders replay (DEC-005)
// ---------------------------------------------------------------------------

test("removing the box with 'none' restores the unfitted render byte-for-byte and unstores the fact", async () => {
  await makeComp("poster");
  const { layerId } = await addText("poster", "rev", ["--y", "0"]);

  const unfitted = await render("poster");
  await invoke(["layer", "edit", layerId, "--fit-box", "600x200", "--project", projDir, "--json"]);
  const fitted = await render("poster");
  expect(fitted.equals(unfitted)).toBe(false);

  const edit = await invoke(["layer", "edit", layerId, "--fit-box", "none", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);
  const restored = await render("poster");
  expect(restored.equals(unfitted)).toBe(true);

  // The fact is gone from the revision, not zeroed.
  const layer = await inspect(layerId);
  expect(layer.currentRevision.fitWidth).toBeUndefined();
  expect(layer.currentRevision.fitHeight).toBeUndefined();
  const stored = await readStoredRevision(layerId, layer.currentRevisionId as string);
  expect(stored).not.toHaveProperty("fitWidth");
  expect(stored).not.toHaveProperty("fitHeight");
}, 60_000);

test("a retained Render replays byte-identically after the fit box round-trips", async () => {
  await makeComp("poster");
  const { layerId } = await addText("poster", "rev", ["--fit-box", "600x200"]);
  const renderRes = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(renderRes.code).toBe(0);
  const pinned = await readFile(JSON.parse(renderRes.stdout).render.output as string);
  const manifest = JSON.parse(renderRes.stdout).render.manifest as string;

  // Later edits change the current revision; the pinned Render keeps
  // replaying from its pinned revision, re-deriving the same effective size.
  await invoke(["layer", "edit", layerId, "--fit-box", "none", "--project", projDir, "--json"]);
  const replayRes = await invoke(["composition", "replay", manifest, "--project", projDir, "--json"]);
  expect(replayRes.code).toBe(0);
  const replayed = await readFile(JSON.parse(replayRes.stdout).replay.output as string);
  expect(replayed.equals(pinned)).toBe(true);
}, 60_000);

// ---------------------------------------------------------------------------
// How fit and wrap width combine: the box bounds the WRAPPED block
// ---------------------------------------------------------------------------

test("with a wrap width set, the box height bounds the wrapped block and the wrap width stays the wrapping width", async () => {
  await makeComp("poster");
  const text =
    "The quick brown fox jumps over the lazy dog and keeps running through the meadow beyond the western hill";
  const res = await invoke([
    "composition", "add", "poster", "wrapped",
    "--text", text, "--font", "Archivo", "--font-size", "32", "--color", "#000000",
    "--wrap-width", "400", "--fit-box", "500x120",
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);

  const m = await measure("poster", "wrapped");
  // The wrap width still wraps the text (the element lays out at 400px);
  // the box shrank the font until the wrapped block fit the height.
  expect(close(m.content.width as number, 400, 1)).toBe(true);
  expect(m.content.height as number).toBeLessThanOrEqual(122);
  expect(m.effectiveFontSize as number).toBeLessThan(32);
  expect(m.effectiveFontSize as number).toBeGreaterThan(8);
  const rev = JSON.parse(res.stdout).layer.currentRevision;
  expect(rev.wrapWidth).toBe(400);
  expect(rev.fitWidth).toBe(500);
  expect(rev.fitHeight).toBe(120);
}, 60_000);

test("a fit box narrower than the wrap width is refused on add and edit with the same wording", async () => {
  await makeComp("poster");

  // Add: refused before anything publishes.
  const addRes = await invoke([
    "composition", "add", "poster", "narrow",
    "--text", HEADLINE, "--font", "Archivo", "--font-size", "32",
    "--wrap-width", "400", "--fit-box", "300x200",
    "--project", projDir, "--json",
  ]);
  expect(addRes.code).toBe(1);
  const addMsg = JSON.parse(addRes.stdout).error as string;
  expect(addMsg).toContain("narrower than the wrap width 400px");
  expect(addMsg).toContain("300px");

  // Edit: the same refusal, naming the carried wrap width.
  const { layerId } = await addText("poster", "ed", ["--wrap-width", "400", "--font-size", "32"]);
  const editRes = await invoke(["layer", "edit", layerId, "--fit-box", "300x200", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(1);
  const editMsg = JSON.parse(editRes.stdout).error as string;
  expect(editMsg).toContain("narrower than the wrap width 400px");
  expect(editMsg).toContain("300px");
}, 60_000);

// ---------------------------------------------------------------------------
// The below-minimum refusal: names the box and the size needed, parity on
// add and edit, publishes nothing (US-016 acceptance 4)
// ---------------------------------------------------------------------------

test("text that cannot fit at the 8px minimum is refused on add and edit, naming the box and the size needed", async () => {
  await makeComp("poster");

  // Add: LONG_LINE at 120px is far wider than 100px — fitting would need a
  // size below the 8px minimum. Refused, naming the box and the size.
  const addRes = await invoke([
    "composition", "add", "poster", "toobig",
    "--text", LONG_LINE, "--font", "Archivo", "--font-size", "48",
    "--fit-box", "100x50",
    "--project", projDir, "--json",
  ]);
  expect(addRes.code).toBe(1);
  const addMsg = JSON.parse(addRes.stdout).error as string;
  expect(addMsg).toContain("cannot fit its 100×50px box");
  expect(addMsg).toContain("below the 8px fit minimum");
  expect(/needs a [0-9.]+px font size/.test(addMsg)).toBe(true);

  // Nothing published: the Composition has no such use.
  const listRes = await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"]);
  expect(listRes.code).toBe(0);
  const uses = JSON.parse(listRes.stdout).composition.layers as { name: string }[];
  expect(uses.some((u) => u.name === "toobig")).toBe(false);

  // Edit: the same refusal fires before publish (add the SAME text without a
  // box, then set one that cannot fit).
  const mkRes = await invoke([
    "composition", "add", "poster", "later",
    "--text", LONG_LINE, "--font", "Archivo", "--font-size", "48",
    "--project", projDir, "--json",
  ]);
  expect(mkRes.code).toBe(0);
  const laterId = JSON.parse(mkRes.stdout).use.layerId as string;
  const editRes = await invoke(["layer", "edit", laterId, "--fit-box", "100x50", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(1);
  const editMsg = JSON.parse(editRes.stdout).error as string;
  expect(editMsg).toContain("cannot fit its 100×50px box");
  expect(editMsg).toContain("below the 8px fit minimum");

  // Parity: both surfaces name the same needed size.
  const addNeeded = addMsg.match(/needs a ([0-9.]+)px/)?.[1];
  const editNeeded = editMsg.match(/needs a ([0-9.]+)px/)?.[1];
  expect(editNeeded).toBe(addNeeded);
}, 60_000);

test("a later edit that would break the fit is refused, and one that fits re-derives the size", async () => {
  await makeComp("poster");
  const { layerId } = await addText("poster", "fit", ["--fit-box", "600x200"]);

  // A box the 120px headline can never fit above the minimum (the headline
  // is ~1400px wide at 120px, so fitting 60x50 needs ~5px — refused,
  // naming the box).
  const res = await invoke(["layer", "edit", layerId, "--fit-box", "60x50", "--project", projDir, "--json"]);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error as string).toContain("cannot fit its 60×50px box");

  // A box the text can fit (by shrinking): the edit publishes and the
  // effective size re-derives from the box alone.
  const ok = await invoke(["layer", "edit", layerId, "--fit-box", "700x300", "--project", projDir, "--json"]);
  expect(ok.code).toBe(0);
  const m = await measure("poster", "fit");
  expect(m.effectiveFontSize as number).toBeLessThanOrEqual(120);
  expect(m.effectiveFontSize as number).toBeGreaterThan(8);
}, 60_000);

// ---------------------------------------------------------------------------
// Stored form and revision hash: present only when set, old ids stable
// ---------------------------------------------------------------------------

test("the stored document carries the fit box only when set, and the hash oracle pins both forms", async () => {
  await makeComp("poster");
  const plain = await addText("poster", "plain", []);
  const boxed = await addText("poster", "boxed", ["--fit-box", "600x200"]);

  // Absent: the stored document has no fit fields at all, and the revision
  // id is exactly the pre-#295 formula's output.
  const plainStored = await readStoredRevision(plain.layerId, plain.revision.revisionId as string);
  expect(plainStored).not.toHaveProperty("fitWidth");
  expect(plainStored).not.toHaveProperty("fitHeight");
  expect(plain.revision.revisionId).toBe(fitHashOracle(plainStored));

  // Set: both fields are stored together, and the oracle's :fitbox(...) matches.
  const boxedStored = await readStoredRevision(boxed.layerId, boxed.revision.revisionId as string);
  expect(boxedStored.fitWidth).toBe(600);
  expect(boxedStored.fitHeight).toBe(200);
  expect(boxed.revision.revisionId).toBe(fitHashOracle(boxedStored));

  // Removing the box returns the document to the pre-#295 shape.
  await invoke(["layer", "edit", boxed.layerId, "--fit-box", "none", "--project", projDir, "--json"]);
  const layer = await inspect(boxed.layerId);
  const removed = await readStoredRevision(boxed.layerId, layer.currentRevisionId as string);
  expect(removed).not.toHaveProperty("fitWidth");
  expect(layer.currentRevisionId).toBe(fitHashOracle(removed));
}, 60_000);

// ---------------------------------------------------------------------------
// Refusals beyond the shared parity rows (semantics, not boundary shape)
// ---------------------------------------------------------------------------

test("fit box refuses malformed, zero, negative, and over-cap values with the established wording", async () => {
  await makeComp("poster");
  const { layerId } = await addText("poster", "txt", ["--font-size", "32"]);

  // Boundary shape (exit 2): malformed WxH forms. JSON mode reports the
  // refusal in the result body.
  for (const bad of ["banana", "600", "600x", "x200", "600x200x50"]) {
    const res = await invoke(["layer", "edit", layerId, "--fit-box", bad, "--project", projDir, "--json"]);
    expect(res.code).toBe(2);
    const msg = (JSON.parse(res.stdout).error ?? res.stderr) as string;
    expect(msg).toContain('Fit box (--fit-box) must be "<W>x<H>" in layout px or "none".');
  }

  // Range (exit 2): zero, negative, and over-cap axes — the shared 8192px
  // per-axis cap, identical wording on both surfaces.
  for (const bad of ["0x200", "600x0", "-5x200", "600x-5", "8193x200", "600x8193"]) {
    const addRes = await invoke([
      "composition", "add", "poster", "bad-add", "--text", "hi", "--font", "Archivo",
      "--fit-box", bad, "--project", projDir, "--json",
    ]);
    expect(addRes.code).toBe(2);
    expect(addRes.stderr + addRes.stdout).toContain(
      "Fit box (--fit-box) must be two finite numbers between 1 and 8192 layout px",
    );
    const editRes = await invoke(["layer", "edit", layerId, "--fit-box", bad, "--project", projDir, "--json"]);
    expect(editRes.code).toBe(2);
    expect(editRes.stderr + editRes.stdout).toContain(
      "Fit box (--fit-box) must be two finite numbers between 1 and 8192 layout px",
    );
  }

  // On add: the text style options require --text.
  const addRes = await invoke(["composition", "add", "poster", "nope", "--fit-box", "600x200", "--project", projDir, "--json"]);
  expect(addRes.code).toBe(2);
  expect(addRes.stderr + addRes.stdout).toContain("require --text");

}, 60_000);