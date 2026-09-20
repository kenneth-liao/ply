/**
 * The comparison sheet (spec #226 US-006, DEC-007/008/009, TEST-008): one
 * command lays out an ordered list of inputs — Composition names (rendered
 * current), retained Render manifests, and local image files — as one
 * labelled PNG grid, with a pairing mode for reference-beside-result rows.
 *
 * Verified through the CLI and output-image seams (TEST-008, prior art:
 * composition-guidelines):
 * - Cell count, order, and label presence asserted from the output image's
 *   known cell geometry (the sheet module's exported geometry constants —
 *   one place, shared with the builder).
 * - Mixed aspect ratios fit inside cells without distortion.
 * - No Render manifest or history entry is written; export-target refusals
 *   match the guideline view's boundary.
 * - A missing or undecodable input is refused naming it, and nothing is
 *   written.
 * - Offline evidence: the whole sheet completes with every browser network
 *   route aborted.
 * - Compact text by default, valid JSON under --json, usage errors exit 2,
 *   failures exit 1.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, writeFile, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePngRgba, decodePng } from "../src/png.js";
import {
  SHEET_PAD,
  SHEET_GUTTER,
  SHEET_LABEL_STRIP,
  SHEET_LABEL_GAP,
  DEFAULT_SHEET_COLUMNS,
  DEFAULT_SHEET_CELL,
  sheetGeometry,
  sheetCellRect,
  sheetLabelRect,
  buildSheetPageHtml,
  renderComparisonSheet,
} from "../src/composition-sheet.js";
import { getBrowser, closeBrowser } from "../src/browser.js";

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

type Rgba = [number, number, number, number];

function solidPng(width: number, height: number, rgba: Rgba): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgba[0]!;
    buf[i + 1] = rgba[1]!;
    buf[i + 2] = rgba[2]!;
    buf[i + 3] = rgba[3]!;
  }
  return encodePngRgba(width, height, buf);
}

const RED: Rgba = [255, 0, 0, 255];
const GREEN: Rgba = [0, 200, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-comp-sheet-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "sheet-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

/** A full-canvas solid shape Composition: renders as one flat colour. */
async function makeSolidComposition(name: string, color: string, width = 400, height = 300) {
  const res = await invoke([
    "composition", "create", name, "--width", String(width), "--height", String(height),
    "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const add = await invoke([
    "composition", "add", name, "bg", "--shape", "rectangle", "--size", `${width}x${height}`,
    "--fill", color, "--x", "0", "--y", "0", "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
}

async function renderComposition(name: string, extra: string[] = []) {
  const res = await invoke(["composition", "render", name, "--project", projDir, "--json", ...extra]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).render as { output: string; manifest: string };
}

/** Walk the Project tree into a path → base64 byte map. */
async function walk(dir: string, into: Map<string, string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, into);
    else into.set(p, (await readFile(p)).toString("base64"));
  }
}

async function sheet(args: string[]) {
  const res = await invoke(["composition", "sheet", ...args, "--project", projDir, "--json"]);
  return { res, json: res.code === 0 ? JSON.parse(res.stdout) : undefined };
}

const PIXEL_AT = (png: Buffer, x: number, y: number, width: number): Rgba => {
  const decoded = decodePng(png);
  const i = (y * width + x) * 4;
  return [decoded.rgba[i]!, decoded.rgba[i + 1]!, decoded.rgba[i + 2]!, decoded.rgba[i + 3]!];
};

const INK_IN = (png: Buffer, rect: { x: number; y: number; width: number; height: number }): number => {
  const decoded = decodePng(png);
  let n = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const i = (y * decoded.width + x) * 4;
      if (decoded.rgba[i + 3]! > 128 && decoded.rgba[i]! < 100 && decoded.rgba[i + 1]! < 100 && decoded.rgba[i + 2]! < 100) n++;
    }
  }
  return n;
};

test("sheetGeometry: deterministic layout with pad, gutter, and label strips; over-limit sheets refused", () => {
  const g = sheetGeometry(2, 512, 3);
  expect(g.columns).toBe(2);
  expect(g.rows).toBe(2);
  expect(g.width).toBe(SHEET_PAD * 2 + 2 * 512 + SHEET_GUTTER);
  expect(g.height).toBe(SHEET_PAD * 2 + 2 * (512 + SHEET_LABEL_STRIP) + SHEET_GUTTER);
  const c0 = sheetCellRect(g, 0);
  const c1 = sheetCellRect(g, 1);
  const c2 = sheetCellRect(g, 2);
  expect(c0).toEqual({ x: SHEET_PAD, y: SHEET_PAD, width: 512, height: 512 });
  expect(c1.x).toBe(SHEET_PAD + 512 + SHEET_GUTTER);
  expect(c2.y).toBe(SHEET_PAD + 512 + SHEET_LABEL_STRIP + SHEET_GUTTER);
  const label = sheetLabelRect(g, 0);
  expect(label.y).toBe(SHEET_PAD + 512 + SHEET_LABEL_GAP);
  expect(label.height).toBeGreaterThan(0);

  expect(() => sheetGeometry(2, 8193, 1)).toThrow(/per-axis/);
  expect(() => sheetGeometry(10, 2000, 100)).toThrow(/render limit|pixels/i);
});

test("buildSheetPageHtml embeds each cell's image and the escaped labels", () => {
  const g = sheetGeometry(2, 100, 2);
  const html = buildSheetPageHtml(g, [
    { src: "data:image/png;base64,AAA", label: 'a "quoted" <label>' },
    { src: "data:image/png;base64,BBB", label: "b" },
  ]);
  expect(html).toContain('data:image/png;base64,AAA');
  expect(html).toContain('data:image/png;base64,BBB');
  expect(html).toContain('a &quot;quoted&quot; &lt;label&gt;');
  expect(html).toContain(`width:${g.width}px`);
  // No raw unescaped quote soup in the label nodes.
  expect(html).not.toContain('<div class="ply-sheet-label">a "quoted"');
});

test("a mixed sheet of all three input kinds: count, order, default labels, and label ink", async () => {
  await makeSolidComposition("redplate", "#ff0000");
  const greenFile = path.join(tempDir, "green-tile.png");
  await writeFile(greenFile, solidPng(300, 200, GREEN));
  await makeSolidComposition("blueplate", "#0000ff");
  const rendered = await renderComposition("blueplate");
  expect(rendered.manifest.endsWith(".manifest.json")).toBe(true);

  const { res, json } = await sheet(["redplate", greenFile, rendered.manifest]);
  expect(res.code).toBe(0);
  expect(json.ok).toBe(true);
  expect(json.output).toMatch(/\.png$/);
  expect(path.dirname(json.output)).toBe(path.join(projDir, "guidelines"));
  expect(path.basename(json.output)).toMatch(/^sheet-[a-z0-9]+-[a-f0-9]{8}\.png$/);
  // Default labels: the input's name — the Composition name, the file's
  // basename, and the manifest's Composition.
  expect(json.inputs.map((i: { label: string }) => i.label)).toEqual([
    "redplate", "green-tile", "blueplate",
  ]);
  expect(json.inputs.map((i: { kind: string }) => i.kind)).toEqual([
    "composition", "file", "manifest",
  ]);

  const png = await readFile(json.output);
  const g = sheetGeometry(DEFAULT_SHEET_COLUMNS, DEFAULT_SHEET_CELL, 3);
  expect(decodePng(png).width).toBe(g.width);
  expect(decodePng(png).height).toBe(g.height);
  // Order: cell 0 = red composition, cell 1 = green file, cell 2 = blue
  // manifest render — each sampled at its cell centre.
  expect(PIXEL_AT(png, sheetCellRect(g, 0).x + 256, sheetCellRect(g, 0).y + 256, g.width)).toEqual([255, 0, 0, 255]);
  expect(PIXEL_AT(png, sheetCellRect(g, 1).x + 256, sheetCellRect(g, 1).y + 256, g.width)).toEqual([0, 200, 0, 255]);
  expect(PIXEL_AT(png, sheetCellRect(g, 2).x + 256, sheetCellRect(g, 2).y + 256, g.width)).toEqual([0, 0, 255, 255]);
  // Every cell carries label ink in its strip.
  for (let i = 0; i < 3; i++) {
    expect(INK_IN(png, sheetLabelRect(g, i))).toBeGreaterThan(20);
  }
});

test("--columns and --cell are honoured; overridden labels appear in the result and the strips", async () => {
  const files: string[] = [];
  const colors: Rgba[] = [RED, GREEN, BLUE, [255, 255, 0, 255]];
  for (let i = 0; i < 4; i++) {
    const p = path.join(tempDir, `img${i}.png`);
    await writeFile(p, solidPng(64, 64, colors[i]!));
    files.push(p);
  }
  const { res, json } = await sheet([
    ...files, "--columns", "3", "--cell", "100",
    "--label", "4=custom label",
  ]);
  expect(res.code).toBe(0);
  const g = sheetGeometry(3, 100, 4);
  expect(decodePng(await readFile(json.output)).width).toBe(g.width);
  expect(json.columns).toBe(3);
  expect(json.cell).toBe(100);
  expect(json.inputs[3]!.label).toBe("custom label");
  expect(json.inputs[0]!.label).toBe("img0");
  const png = await readFile(json.output);
  for (let i = 0; i < 4; i++) {
    const c = sheetCellRect(g, i);
    expect(PIXEL_AT(png, c.x + 50, c.y + 50, g.width)).toEqual(colors[i]);
  }
});

test("mixed aspect ratios fit inside cells without distortion", async () => {
  // A 2:1 image in a square 100px cell: content must be 100×50, centred —
  // white bands above and below, colour across the full fitted width.
  const wide = path.join(tempDir, "wide.png");
  await writeFile(wide, solidPng(200, 100, RED));
  const { res, json } = await sheet([wide, "--cell", "100", "--columns", "1"]);
  expect(res.code).toBe(0);
  const g = sheetGeometry(1, 100, 1);
  const png = await readFile(json.output);
  const decoded = decodePng(png);
  const fittedW = 100, fittedH = 50;
  const top = SHEET_PAD;
  const yMid = top + (100 - fittedH) / 2; // 29
  // White bands above and below the fitted content (no stretch).
  expect(PIXEL_AT(png, SHEET_PAD + 50, top + 5, decoded.width)).toEqual([255, 255, 255, 255]);
  expect(PIXEL_AT(png, SHEET_PAD + 50, top + 100 - 5, decoded.width)).toEqual([255, 255, 255, 255]);
  // The content band spans exactly the fitted rectangle.
  expect(PIXEL_AT(png, SHEET_PAD + 2, Math.round(yMid), decoded.width)).toEqual(RED);
  expect(PIXEL_AT(png, SHEET_PAD + fittedW - 2, Math.round(yMid), decoded.width)).toEqual(RED);
  expect(PIXEL_AT(png, SHEET_PAD + fittedW + 2, Math.round(yMid), decoded.width)).toEqual([255, 255, 255, 255]);
  // A portrait 1:2 image likewise: 50 wide, 100 tall, white side bands.
  const tall = path.join(tempDir, "tall.png");
  await writeFile(tall, solidPng(100, 200, GREEN));
  const second = await sheet([tall, "--cell", "100", "--columns", "1"]);
  expect(second.res.code).toBe(0);
  const png2 = await readFile(second.json.output);
  expect(PIXEL_AT(png2, SHEET_PAD + 5, top + 50, decoded.width)).toEqual([255, 255, 255, 255]);
  expect(PIXEL_AT(png2, SHEET_PAD + 50, top + 2, decoded.width)).toEqual(GREEN);
});

test("pairing mode lays reference-beside-result rows; an odd count and --columns conflict are refused", async () => {
  const refFile = path.join(tempDir, "ref.png");
  await writeFile(refFile, solidPng(320, 180, GREEN));
  await makeSolidComposition("result", "#0000ff");
  const { res, json } = await sheet([refFile, "result", "--pair", "--cell", "100"]);
  expect(res.code).toBe(0);
  expect(json.paired).toBe(true);
  expect(json.columns).toBe(2);
  const g = sheetGeometry(2, 100, 2);
  const png = await readFile(json.output);
  expect(decodePng(png).width).toBe(g.width);
  expect(PIXEL_AT(png, sheetCellRect(g, 0).x + 50, sheetCellRect(g, 0).y + 50, g.width)).toEqual(GREEN);
  expect(PIXEL_AT(png, sheetCellRect(g, 1).x + 50, sheetCellRect(g, 1).y + 50, g.width)).toEqual([0, 0, 255, 255]);

  const odd = await invoke(["composition", "sheet", refFile, "result", "ref.png", "--pair", "--cell", "100", "--project", projDir, "--json"]);
  expect(odd.code).toBe(1);
  expect(JSON.parse(odd.stdout).error).toMatch(/pairing|even/);

  const conflict = await invoke(["composition", "sheet", refFile, "result", "--pair", "--columns", "3", "--project", projDir, "--json"]);
  expect(conflict.code).toBe(2);
  expect(JSON.parse(conflict.stdout).error).toMatch(/--columns/);
});

test("the sheet writes no Render manifest and adds nothing to retained Render history; recorded render outputs are never overwritten", async () => {
  await makeSolidComposition("kept", "#ff0000");
  const rendered = await renderComposition("kept");
  const historyPng = rendered.output;

  const rendersBefore = new Map<string, string>();
  await walk(path.join(projDir, "renders"), rendersBefore);
  const before = new Map<string, string>();
  await walk(projDir, before);

  const { res, json } = await sheet(["kept", rendered.manifest]);
  expect(res.code).toBe(0);

  const after = new Map<string, string>();
  await walk(projDir, after);
  const added = [...after.keys()].filter((p) => !before.has(p));
  expect(added).toHaveLength(1);
  expect(added[0]!).toBe(json.output);
  const rendersAfter = new Map<string, string>();
  await walk(path.join(projDir, "renders"), rendersAfter);
  expect(rendersAfter.size).toBe(rendersBefore.size);
  for (const [p, bytes] of rendersBefore) {
    expect(rendersAfter.get(p)).toBe(bytes);
  }

  // The export-target boundary: existing Project state and recorded render
  // outputs are refused, exactly like the guideline view.
  const overwrite = await invoke(["composition", "sheet", "kept", "--out", historyPng, "--project", projDir, "--json"]);
  expect(overwrite.code).toBe(1);
  expect(JSON.parse(overwrite.stdout).error).toMatch(/Render output|manifest|export|Project/);
  const state = await invoke(["composition", "sheet", "kept", "--out", path.join(projDir, "ply.json"), "--project", projDir, "--json"]);
  expect(state.code).toBe(1);
});

test("a missing or undecodable input is refused naming it, and nothing is written", async () => {
  await makeSolidComposition("exists", "#ff0000");
  const garbage = path.join(tempDir, "garbage.png");
  await writeFile(garbage, "definitely not an image");
  const before = new Map<string, string>();
  await walk(projDir, before);

  const missing = await sheet(["exists", "no-such-input"]);
  expect(missing.res.code).toBe(1);
  expect(JSON.parse(missing.res.stdout).error).toContain("no-such-input");

  const undecodable = await sheet(["exists", garbage]);
  expect(undecodable.res.code).toBe(1);
  expect(JSON.parse(undecodable.res.stdout).error).toContain("garbage.png");

  // A manifest-shaped file that is not a real manifest is refused too, and
  // an SVG-shaped file that is neither keeps its real reason (both attempts
  // are reported, never a misleading manifest-only message).
  const fakeManifest = path.join(tempDir, "fake.manifest.json");
  await writeFile(fakeManifest, "{ not a manifest");
  const fake = await sheet(["exists", fakeManifest]);
  expect(fake.res.code).toBe(1);
  expect(JSON.parse(fake.res.stdout).error).toContain("fake.manifest.json");
  const svgShaped = path.join(tempDir, "broken.svg");
  await writeFile(svgShaped, "<svg>no size facts</svg>");
  const svgShapedRes = await sheet(["exists", svgShaped]);
  expect(svgShapedRes.res.code).toBe(1);
  const svgOut = JSON.parse(svgShapedRes.res.stdout);
  expect(svgOut.error).toContain("broken.svg");
  expect(svgOut.error).toContain("Render manifest");

  const after = new Map<string, string>();
  await walk(projDir, after);
  expect([...after.keys()].filter((p) => !before.has(p))).toEqual([]);
});

test("an SVG input referencing content outside itself is refused (the #214 inertness gate)", async () => {
  const leaky = path.join(tempDir, "leaky.svg");
  await writeFile(
    leaky,
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      '<image href="https://example.com/pixel.png"/></svg>',
  );
  const before = new Map<string, string>();
  await walk(projDir, before);
  const { res } = await sheet([leaky]);
  expect(res.code).toBe(1);
  const out = JSON.parse(res.stdout);
  expect(out.error).toContain("leaky.svg");
  expect(out.error).toContain("example.com");
  const after = new Map<string, string>();
  await walk(projDir, after);
  expect([...after.keys()].filter((p) => !before.has(p))).toEqual([]);
});

test("a file input over the render limits is refused; a symlink to an image is an image", async () => {
  // A 9000×1 header is over the 8192px per-axis limit.
  const wide = path.join(tempDir, "toowide.png");
  await writeFile(wide, encodePngRgba(9000, 1, Buffer.alloc(9000 * 4)));
  const { res } = await sheet([wide]);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error).toContain("toowide.png");

  // A symlink to an image classifies as the image (stat, not lstat).
  const real = path.join(tempDir, "real.png");
  await writeFile(real, solidPng(64, 64, GREEN));
  const link = path.join(tempDir, "link.png");
  await symlink(real, link);
  const linked = await sheet([link, "--cell", "50", "--columns", "1"]);
  expect(linked.res.code).toBe(0);
  expect(linked.json.inputs[0]!.kind).toBe("file");
  expect(linked.json.inputs[0]!.label).toBe("link");
});

test("a Composition cell is rendered CURRENT — current-state edits show, pinned manifest pixels do not", async () => {
  await makeSolidComposition("mutated", "#ff0000");
  const rendered = await renderComposition("mutated");
  // A current-state edit after the render: the Composition is now green.
  const edit = await invoke([
    "layer", "edit", "mutated/bg", "--fill", "#00aa00", "--project", projDir, "--json",
  ]);
  expect(edit.code).toBe(0);

  const { res, json } = await sheet(["mutated", rendered.manifest, "--cell", "100", "--columns", "2"]);
  expect(res.code).toBe(0);
  const g = sheetGeometry(2, 100, 2);
  const png = await readFile(json.output);
  expect(PIXEL_AT(png, sheetCellRect(g, 0).x + 50, sheetCellRect(g, 0).y + 50, g.width)).toEqual([0, 170, 0, 255]);
  // The manifest cell keeps the pinned pre-edit pixels.
  expect(PIXEL_AT(png, sheetCellRect(g, 1).x + 50, sheetCellRect(g, 1).y + 50, g.width)).toEqual([255, 0, 0, 255]);
});

test("a malformed --label is a usage error (exit 2)", async () => {
  const noEq = await invoke(["composition", "sheet", "x", "--label", "just-text", "--project", projDir, "--json"]);
  expect(noEq.code).toBe(2);
  expect(JSON.parse(noEq.stdout).error).toContain("--label");
  const outOfRange = await invoke(["composition", "sheet", "x", "--label", "5=out", "--project", projDir, "--json"]);
  expect(outOfRange.code).toBe(2);
  expect(JSON.parse(outOfRange.stdout).error).toContain("5");
});

test("usage errors and help: no inputs exits 2; --help documents the sheet command; plain text is compact", async () => {
  const none = await invoke(["composition", "sheet", "--project", projDir, "--json"]);
  expect(none.code).toBe(2);
  expect(JSON.parse(none.stdout).ok).toBe(false);

  const badColumns = await invoke(["composition", "sheet", "x", "--columns", "0", "--project", projDir, "--json"]);
  expect(badColumns.code).toBe(2);

  const help = await invoke(["composition", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("sheet <input");

  const plain = await invoke(["composition", "sheet", "--project", projDir]);
  expect(plain.code).toBe(2);
  expect(plain.stderr + plain.stdout).toContain("Usage:");
});

test("the sheet completes with every browser network route aborted (offline evidence)", async () => {
  await makeSolidComposition("offline", "#ff0000");
  const file = path.join(tempDir, "offline.png");
  await writeFile(file, solidPng(64, 64, GREEN));

  const browser = await getBrowser();
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  await ctx.route("**/*", (route) => route.abort());
  const page = await ctx.newPage();
  try {
    const result = await renderComparisonSheet(projDir, ["offline", file], {
      page,
      out: path.join(tempDir, "offline-sheet.png"),
      cell: 100,
    });
    expect(result.inputs).toHaveLength(2);
    const png = await readFile(result.output);
    const g = sheetGeometry(2, 100, 2);
    expect(decodePng(png).width).toBe(g.width);
  } finally {
    await ctx.close();
    await closeBrowser();
  }
});