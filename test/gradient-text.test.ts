/**
 * Gradient fill on text Layers (#222, spec #218 US-004, DEC-008/009/010, TEST-005):
 * Text colour and text gradient are ONE fact read through one reader (DEC-008):
 * - Stored under `color` on `LayerTextRevision` (`color: string | LayerFill`).
 * - No second field (`fill` or `gradient`) on text revisions.
 * - Solid colours remain stored as canonical lowercase hex strings, keeping existing
 *   documents byte-identical and revision IDs unmoved (DEC-010).
 * - Gradients use `background-clip: text` in a two-element DOM structure so outline
 *   and shadow hug glyph alpha while the gradient spans the text ink box.
 * - Solid text continues to paint through the exact pre-existing CSS.
 * - Editing text, font, size, tracking, or line height automatically re-spans the gradient.
 * - Offline, per-file `bun test --isolate`.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { decodePng } from "../src/png.js";
import { normalizeStoredTextFill } from "../src/fill.js";
import { computeRevisionHash, type LayerTextRevision } from "../src/layer.js";

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

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-gradient-text-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "gradient-text-proj"]);
  await invoke([
    "composition", "create", "poster", "--width", "300", "--height", "200", "--project", projDir,
  ]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function getInkPixels(png: ReturnType<typeof decodePng>, minAlpha = 200) {
  const ink: { x: number; y: number; rgba: [number, number, number, number] }[] = [];
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const a = png.rgba[i + 3]!;
      if (a >= minAlpha) {
        ink.push({ x, y, rgba: [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, a] });
      }
    }
  }
  return ink;
}

async function renderPng(comp: string, extraArgs: string[] = []): Promise<{ png: ReturnType<typeof decodePng>; output: string; manifest: string }> {
  const render = await invoke(["composition", "render", comp, "--project", projDir, "--supersample", "1", "--json", ...extraArgs]);
  expect(render.code).toBe(0);
  const parsed = JSON.parse(render.stdout);
  const output = parsed.render.output as string;
  const manifest = parsed.render.manifest as string;
  return { png: decodePng(await readFile(output)), output, manifest };
}

async function addText(
  name: string,
  text: string,
  color: string,
  extraArgs: string[] = [],
) {
  const res = await invoke([
    "composition", "add", "poster", name,
    "--text", text,
    "--font", "Anton",
    "--font-size", "48",
    "--color", color,
    "--x", "20",
    "--y", "30",
    "--project", projDir,
    "--json",
    ...extraArgs,
  ]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

// ---------------------------------------------------------------------------
// TEST-005: Linear and radial gradients render expected endpoint colours
// ---------------------------------------------------------------------------

test("a linear gradient renders its first stop on the left and last on the right of text ink", async () => {
  const added = await addText("title", "MMMM", "linear:90deg,#ff0000,#00ff00");
  const rev = added.layer.currentRevision;

  // Stored in `color` as canonical LayerFill object (DEC-008)
  expect(rev.color).toEqual({
    type: "linear",
    angleDeg: 90,
    stops: [
      { color: "#ff0000", position: 0 },
      { color: "#00ff00", position: 100 },
    ],
  });

  // Text revisions have no `fill` field (DEC-008 single fact)
  expect(rev.fill).toBeUndefined();

  // Measure reports fill for text
  const measureRes = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  expect(measureRes.code).toBe(0);
  const measure = JSON.parse(measureRes.stdout);
  expect(measure.layers[0].fill).toEqual(rev.color);

  const { png } = await renderPng("poster");
  const ink = getInkPixels(png);
  expect(ink.length).toBeGreaterThan(500);

  const minX = Math.min(...ink.map((p) => p.x));
  const maxX = Math.max(...ink.map((p) => p.x));

  // Leftmost ink: red dominant (first stop #ff0000)
  const leftInk = ink.filter((p) => p.x <= minX + 5);
  expect(leftInk.length).toBeGreaterThan(0);
  for (const p of leftInk) {
    expect(p.rgba[0]).toBeGreaterThan(180);
    expect(p.rgba[1]).toBeLessThan(70);
  }

  // Rightmost ink: green dominant (last stop #00ff00)
  const rightInk = ink.filter((p) => p.x >= maxX - 5);
  expect(rightInk.length).toBeGreaterThan(0);
  for (const p of rightInk) {
    expect(p.rgba[1]).toBeGreaterThan(180);
    expect(p.rgba[0]).toBeLessThan(70);
  }
});

test("a vertical linear gradient (180deg) renders top to bottom across text ink", async () => {
  await addText("vert", "MMMM", "linear:180deg,#ff0000,#0000ff");

  const { png } = await renderPng("poster");
  const ink = getInkPixels(png);
  expect(ink.length).toBeGreaterThan(500);

  const minY = Math.min(...ink.map((p) => p.y));
  const maxY = Math.max(...ink.map((p) => p.y));

  // Topmost ink: red dominant (first stop #ff0000)
  const topInk = ink.filter((p) => p.y <= minY + 4);
  expect(topInk.length).toBeGreaterThan(0);
  for (const p of topInk) {
    expect(p.rgba[0]).toBeGreaterThan(180);
    expect(p.rgba[2]).toBeLessThan(70);
  }

  // Bottommost ink: blue dominant (last stop #0000ff)
  const bottomInk = ink.filter((p) => p.y >= maxY - 4);
  expect(bottomInk.length).toBeGreaterThan(0);
  for (const p of bottomInk) {
    expect(p.rgba[2]).toBeGreaterThan(180);
    expect(p.rgba[0]).toBeLessThan(80);
  }
});

test("a radial gradient renders its center stop at the center and outer stop at edges", async () => {
  await addText("rad", "MMMM", "radial:#ff0000,#0000ff");

  const { png } = await renderPng("poster");
  const ink = getInkPixels(png);
  expect(ink.length).toBeGreaterThan(500);

  const minX = Math.min(...ink.map((p) => p.x));
  const maxX = Math.max(...ink.map((p) => p.x));
  const minY = Math.min(...ink.map((p) => p.y));
  const maxY = Math.max(...ink.map((p) => p.y));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  ink.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));

  // Ink closest to center: red dominant (first stop #ff0000)
  const centerSample = ink[0]!;
  expect(centerSample.rgba[0]).toBeGreaterThan(180);
  expect(centerSample.rgba[2]).toBeLessThan(70);

  // Ink furthest from center: blue dominant (last stop #0000ff)
  const outerSample = ink[ink.length - 1]!;
  expect(outerSample.rgba[2]).toBeGreaterThan(180);
  expect(outerSample.rgba[0]).toBeLessThan(70);
});

// ---------------------------------------------------------------------------
// Re-spanning: changing text, font, size, weight, width, tracking, line height
// ---------------------------------------------------------------------------

test("changing text re-spans the gradient automatically", async () => {
  const added = await addText("spanText", "MM", "linear:90deg,#ff0000,#00ff00");
  const layerId = added.layer.id;

  const { png: png1 } = await renderPng("poster");
  const ink1 = getInkPixels(png1);
  const maxX1 = Math.max(...ink1.map((p) => p.x));

  // Right edge of "MM" is green
  const rightInk1 = ink1.filter((p) => p.x >= maxX1 - 4);
  expect(rightInk1.length).toBeGreaterThan(0);
  for (const p of rightInk1) {
    expect(p.rgba[1]).toBeGreaterThan(180);
    expect(p.rgba[0]).toBeLessThan(70);
  }

  // Edit text to be wider: "MM MMMM MMMM"
  const editRes = await invoke([
    "layer", "edit", layerId, "--text", "MM MMMM MMMM", "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);

  const { png: png2 } = await renderPng("poster");
  const ink2 = getInkPixels(png2);
  const maxX2 = Math.max(...ink2.map((p) => p.x));
  expect(maxX2).toBeGreaterThan(maxX1 * 1.5);

  // At the old maxX1 position, the text is now in the first third of the gradient
  // where red dominates over green
  const oldPosInk = ink2.filter((p) => Math.abs(p.x - maxX1) <= 3);
  expect(oldPosInk.length).toBeGreaterThan(0);
  for (const p of oldPosInk) {
    expect(p.rgba[0]).toBeGreaterThan(p.rgba[1]);
  }

  // At the new right end, green dominates
  const rightInk2 = ink2.filter((p) => p.x >= maxX2 - 4);
  expect(rightInk2.length).toBeGreaterThan(0);
  for (const p of rightInk2) {
    expect(p.rgba[1]).toBeGreaterThan(180);
    expect(p.rgba[0]).toBeLessThan(70);
  }
});

test("changing font size, tracking, or line height re-spans the gradient", async () => {
  const added = await addText("resizeText", "MMMM", "linear:180deg,#ff0000,#00ff00");
  const layerId = added.layer.id;

  // Edit font-size to 24px and tracking to 0.1em
  await invoke([
    "layer", "edit", layerId,
    "--font-size", "24",
    "--tracking", "0.1",
    "--line-height", "1.5",
    "--project", projDir,
    "--json",
  ]);

  const { png } = await renderPng("poster");
  const ink = getInkPixels(png);
  expect(ink.length).toBeGreaterThan(200);

  const minY = Math.min(...ink.map((p) => p.y));
  const maxY = Math.max(...ink.map((p) => p.y));

  // Top of new bounds is red, bottom is green
  const topInk = ink.filter((p) => p.y <= minY + 3);
  expect(topInk.length).toBeGreaterThan(0);
  for (const p of topInk) {
    expect(p.rgba[0]).toBeGreaterThan(150);
    expect(p.rgba[1]).toBeLessThan(100);
  }

  const botInk = ink.filter((p) => p.y >= maxY - 3);
  expect(botInk.length).toBeGreaterThan(0);
  for (const p of botInk) {
    expect(p.rgba[1]).toBeGreaterThan(150);
    expect(p.rgba[0]).toBeLessThan(100);
  }
});

test("re-spanning across font, weight, and width edits (INT-3)", async () => {
  // Start with variable font Archivo with width 100, weight 400
  const added = await addText("respanAxes", "MMMM", "linear:90deg,#ff0000,#00ff00", [
    "--font", "Archivo",
    "--weight", "400",
    "--width", "100",
  ]);
  const layerId = added.layer.id;

  const { png: png1 } = await renderPng("poster");
  const ink1 = getInkPixels(png1);
  const minX1 = Math.min(...ink1.map((p) => p.x));
  const maxX1 = Math.max(...ink1.map((p) => p.x));
  const width1 = maxX1 - minX1;

  // Edit 1: width 125 (expanded) -> text gets wider, right edge re-spans to green
  const e1 = await invoke([
    "layer", "edit", layerId,
    "--width", "125",
    "--project", projDir,
    "--json",
  ]);
  expect(e1.code).toBe(0);

  const { png: png2 } = await renderPng("poster");
  const ink2 = getInkPixels(png2);
  const minX2 = Math.min(...ink2.map((p) => p.x));
  const maxX2 = Math.max(...ink2.map((p) => p.x));
  const width2 = maxX2 - minX2;
  expect(width2).toBeGreaterThan(width1);

  // Left ink red, right ink green
  const rightInk2 = ink2.filter((p) => p.x >= maxX2 - 4);
  expect(rightInk2.length).toBeGreaterThan(0);
  for (const p of rightInk2) {
    expect(p.rgba[1]).toBeGreaterThan(160);
    expect(p.rgba[0]).toBeLessThan(90);
  }

  // Edit 2: weight 900 (black/heavy) -> ink density/thickness grows, endpoints still red left / green right
  const e2 = await invoke([
    "layer", "edit", layerId,
    "--weight", "900",
    "--project", projDir,
    "--json",
  ]);
  expect(e2.code).toBe(0);

  const { png: png3 } = await renderPng("poster");
  const ink3 = getInkPixels(png3);
  expect(ink3.length).toBeGreaterThan(ink2.length);

  const minX3 = Math.min(...ink3.map((p) => p.x));
  const maxX3 = Math.max(...ink3.map((p) => p.x));
  const leftInk3 = ink3.filter((p) => p.x <= minX3 + 4);
  const rightInk3 = ink3.filter((p) => p.x >= maxX3 - 4);
  for (const p of leftInk3) {
    expect(p.rgba[0]).toBeGreaterThan(160);
    expect(p.rgba[1]).toBeLessThan(90);
  }
  for (const p of rightInk3) {
    expect(p.rgba[1]).toBeGreaterThan(160);
    expect(p.rgba[0]).toBeLessThan(90);
  }

  // Edit 3: font Anton (static font, reset axes to weight 400, width 100) -> re-spans across Anton bounds
  const e3 = await invoke([
    "layer", "edit", layerId,
    "--font", "Anton",
    "--weight", "400",
    "--width", "100",
    "--project", projDir,
    "--json",
  ]);
  expect(e3.code).toBe(0);

  const { png: png4 } = await renderPng("poster");
  const ink4 = getInkPixels(png4);
  const minX4 = Math.min(...ink4.map((p) => p.x));
  const maxX4 = Math.max(...ink4.map((p) => p.x));
  const leftInk4 = ink4.filter((p) => p.x <= minX4 + 4);
  const rightInk4 = ink4.filter((p) => p.x >= maxX4 - 4);
  for (const p of leftInk4) {
    expect(p.rgba[0]).toBeGreaterThan(160);
    expect(p.rgba[1]).toBeLessThan(90);
  }
  for (const p of rightInk4) {
    expect(p.rgba[1]).toBeGreaterThan(160);
    expect(p.rgba[0]).toBeLessThan(90);
  }
});


// ---------------------------------------------------------------------------
// Outline and shadow work on gradient text as on solid text
// ---------------------------------------------------------------------------

test("outline and shadow work on gradient text", async () => {
  await addText("styled", "MMMM", "linear:90deg,#ff0000,#00ff00", [
    "--outline", "4,#ffffff",
    "--shadow", "0,6,0,#0000ff",
  ]);

  const { png } = await renderPng("poster");

  let whiteOutlinePx = 0;
  let blueShadowPx = 0;
  let gradientTextPx = 0;

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const [r, g, b, a] = [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
      if (a > 200) {
        if (r > 240 && g > 240 && b > 240) {
          whiteOutlinePx++;
        } else if (b > 200 && r < 50 && g < 50) {
          blueShadowPx++;
        } else if ((r > 150 || g > 150) && b < 100) {
          gradientTextPx++;
        }
      }
    }
  }

  // All three components are rendered distinctly
  expect(whiteOutlinePx).toBeGreaterThan(500);
  expect(blueShadowPx).toBeGreaterThan(200);
  expect(gradientTextPx).toBeGreaterThan(1000);
});

// ---------------------------------------------------------------------------
// Solid-colour text renders byte-identically to before this change (DEC-010, INT-2)
// Provenance: test/fixtures/solid-text-baseline.png was captured from main at commit e19d0ca
// using a detached worktree with Bun v1.4.0 and Playwright Chromium 151.0.7922.34 at supersample 1.
// ---------------------------------------------------------------------------

test("an existing solid-colour text Layer renders byte-identically to before this change", async () => {
  // Re-create the baseline composition
  const bProj = path.join(tempDir, "baseline-proj");
  await invoke(["project", "init", bProj, "--name", "b-proj"]);
  await invoke(["composition", "create", "comp", "--width", "300", "--height", "200", "--project", bProj]);
  await invoke([
    "composition", "add", "comp", "t1",
    "--text", "SOLID BASELINE", "--font", "Anton", "--color", "#ff0000",
    "--x", "20", "--y", "30", "--font-size", "36",
    "--project", bProj,
  ]);
  await invoke([
    "composition", "add", "comp", "t2",
    "--text", "SHADOW OUTLINE", "--font", "Anton", "--color", "#00ff00",
    "--x", "20", "--y", "90", "--font-size", "32",
    "--project", bProj,
  ]);

  const renderRes = await invoke(["composition", "render", "comp", "--project", bProj, "--supersample", "1", "--json"]);
  expect(renderRes.code).toBe(0);
  const actualPng = await readFile(JSON.parse(renderRes.stdout).render.output);
  const baselinePng = await readFile(path.resolve(import.meta.dir, "fixtures/solid-text-baseline.png"));

  expect(actualPng.equals(baselinePng)).toBe(true);
});

test("solid colour text revision stores a plain hex string and revision id is unmoved", async () => {
  const added = await addText("solidText", "Hello", "#ff4400");
  const rev = added.layer.currentRevision;

  // Stored as canonical lowercase string
  expect(rev.color).toBe("#ff4400");
  expect(typeof rev.color).toBe("string");
  expect(rev.fill).toBeUndefined();

  // Normalize helper reads it as solid LayerFill
  expect(normalizeStoredTextFill(rev.color)).toEqual({
    type: "solid",
    color: "#ff4400",
  });
});

test("legacy string-color text revision hash is unchanged (INT-4, DEC-010)", () => {
  const legacyRev: LayerTextRevision = {
    schemaVersion: 1,
    layerId: "layer_test123",
    revisionId: "rev_placeholder",
    parentRevisionId: null,
    committedAt: "2026-01-01T00:00:00.000Z",
    kind: "text",
    x: 10,
    y: 20,
    opacity: 1,
    text: "Hello World",
    font: "font_hash_abc",
    fontSize: 32,
    color: "#ff0000",
  };
  const hash = computeRevisionHash(legacyRev);
  expect(hash).toBe("rev_775299c96a23683b");
});



// ---------------------------------------------------------------------------
// Single Source of Truth: inspect and measure report one fill for text
// ---------------------------------------------------------------------------

test("inspect reports one fill and stored revision documents carry no second field", async () => {
  await addText("tGrad", "Sample", "linear:45deg,#112233,#445566");

  // Inspect composition JSON
  const compInspect = await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"]);
  expect(compInspect.code).toBe(0);
  const compJson = JSON.parse(compInspect.stdout);
  const rev = compJson.composition.layers[0].revision;

  expect(rev.color).toEqual({
    type: "linear",
    angleDeg: 45,
    stops: [
      { color: "#112233", position: 0 },
      { color: "#445566", position: 100 },
    ],
  });
  // No second storage field
  expect(rev.fill).toBeUndefined();
  expect(rev.gradient).toBeUndefined();

  // Layer inspect CLI output prints Fill
  const layerInspect = await invoke(["layer", "inspect", rev.layerId, "--project", projDir]);
  expect(layerInspect.code).toBe(0);
  expect(layerInspect.stdout).toContain("Fill: linear 45deg #112233 0%, #445566 100%");
});

// ---------------------------------------------------------------------------
// Render replay: gradient text replays byte-identically
// ---------------------------------------------------------------------------

test("a Render with gradient text replays byte-identically", async () => {
  await addText("grad1", "LINEAR", "linear:90deg,#ff0000,#00ff00");
  await addText("grad2", "RADIAL", "radial:#0000ff,#ffff00", ["--y", "100"]);

  const { output, manifest } = await renderPng("poster");
  const originalPng = await readFile(output);

  const replayRes = await invoke(["composition", "replay", manifest, "--project", projDir, "--json"]);
  expect(replayRes.code).toBe(0);
  const replayOutput = JSON.parse(replayRes.stdout).replay.output;
  const replayPng = await readFile(replayOutput);

  expect(replayPng.equals(originalPng)).toBe(true);
});

// ---------------------------------------------------------------------------
// Idempotence and refusal parity
// ---------------------------------------------------------------------------

test("editing with an identical gradient creates no new revision", async () => {
  const added = await addText("idem", "Title", "linear:90deg,#ff0000,#00ff00");
  const rev1 = added.layer.currentRevision;

  // Edit with identical gradient spec
  const edit1 = await invoke([
    "layer", "edit", added.layer.id, "--color", "linear:90deg,#ff0000,#00ff00", "--project", projDir, "--json",
  ]);
  expect(edit1.code).toBe(0);
  expect(JSON.parse(edit1.stdout).layer.currentRevisionId).toBe(rev1.revisionId);

  // Edit with equivalent angle and case spelling
  const edit2 = await invoke([
    "layer", "edit", added.layer.id, "--color", "linear:90DEG,#FF0000,#00FF00", "--project", projDir, "--json",
  ]);
  expect(edit2.code).toBe(0);
  expect(JSON.parse(edit2.stdout).layer.currentRevisionId).toBe(rev1.revisionId);
});

test("malformed gradient fill specs are refused before publication", async () => {
  const added = await addText("safe", "Text", "#ff0000");
  const origRevId = added.layer.currentRevision.revisionId;

  // Fewer than 2 stops
  const r1 = await invoke([
    "layer", "edit", added.layer.id, "--color", "linear:90deg,#ff0000", "--project", projDir, "--json",
  ]);
  expect(r1.code).not.toBe(0);
  expect(JSON.parse(r1.stdout).error).toContain("two colour stops");

  // Invalid stop color
  const r2 = await invoke([
    "layer", "edit", added.layer.id, "--color", "linear:90deg,#ff0000,banana", "--project", projDir, "--json",
  ]);
  expect(r2.code).not.toBe(0);
  expect(JSON.parse(r2.stdout).error).toContain('Invalid linear gradient stop colour "banana"');

  // Malformed radial
  const r3 = await invoke([
    "layer", "edit", added.layer.id, "--color", "radial:", "--project", projDir, "--json",
  ]);
  expect(r3.code).not.toBe(0);

  // Layer remains on original revision
  const inspect = await invoke(["layer", "inspect", added.layer.id, "--project", projDir, "--json"]);
  expect(JSON.parse(inspect.stdout).layer.currentRevisionId).toBe(origRevId);
});

test("CLI text output formats gradient without interpolating [object Object] (INT-6)", async () => {
  const addRes = await invoke([
    "composition", "add", "poster", "heading",
    "--text", "Gradient Heading",
    "--font", "Anton",
    "--font-size", "48",
    "--color", "linear:90deg,#ff0000,#00ff00",
    "--x", "20",
    "--y", "30",
    "--project", projDir,
  ]);
  expect(addRes.code).toBe(0);
  expect(addRes.stdout).not.toContain("[object Object]");
  expect(addRes.stdout).toContain("linear 90deg #ff0000 0%, #00ff00 100%");

  const inspectRes = await invoke(["composition", "inspect", "poster", "--project", projDir]);
  expect(inspectRes.code).toBe(0);
  expect(inspectRes.stdout).not.toContain("[object Object]");
  expect(inspectRes.stdout).toContain("linear 90deg #ff0000 0%, #00ff00 100%");
});

test("invalid solid color option names --color on refusal (PROD-2)", async () => {
  const rAdd = await invoke([
    "composition", "add", "poster", "bad1",
    "--text", "Bad",
    "--font", "Anton",
    "--color", "banana",
    "--project", projDir,
    "--json",
  ]);
  expect(rAdd.code).not.toBe(0);
  expect(JSON.parse(rAdd.stdout).error).toContain('Invalid --color "banana"');

  const added = await addText("good", "Good", "#ff0000");
  const rEdit = await invoke([
    "layer", "edit", added.layer.id,
    "--color", "banana",
    "--project", projDir,
    "--json",
  ]);
  expect(rEdit.code).not.toBe(0);
  expect(JSON.parse(rEdit.stdout).error).toContain('Invalid --color "banana"');
});


