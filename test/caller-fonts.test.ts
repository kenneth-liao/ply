/**
 * Caller-supplied fonts (#232, spec #226 US-005, TEST-007): a text Layer
 * takes a local font file in place of a bundled family, at add and at edit.
 * The bytes are retained by content identity through the same path bundled
 * faces use (ADR-0021), the file's own facts are read ONCE at ingestion and
 * stored with the revision, and Ply never synthesizes a weight or width.
 * Every assertion runs through the public CLI, the measure seam, and
 * rendered pixels against temporary Projects — offline, with committed OFL
 * fixture fonts (test/fixtures/fonts: Silkscreen static, Handjet variable).
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, readdir, writeFile, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { decodePng, encodePngRgba } from "../src/png.js";
import type { LayerTextRevision } from "../src/layer.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const FIXTURES = path.resolve(import.meta.dir, "fixtures/fonts");
const SILKSCREEN = path.join(FIXTURES, "Silkscreen-Regular.ttf");
const SILKSCREEN_OTF = path.join(FIXTURES, "Silkscreen-Regular.otf");
const HANDJET = path.join(FIXTURES, "Handjet.ttf");

async function invoke(args: string[], project?: string) {
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
let otherProjDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-caller-fonts-"));
  projDir = path.join(tempDir, "proj");
  otherProjDir = path.join(tempDir, "other");
  await invoke(["project", "init", projDir, "--name", "fonts-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComposition(name: string, width = 500, height = 200, project = projDir) {
  const res = await invoke([
    "composition", "create", name, "--width", String(width), "--height", String(height), "--project", project,
  ]);
  expect(res.code).toBe(0);
}

async function addCallerFont(comp: string, local: string, fontPath: string, extra: string[] = [], project = projDir) {
  return invoke([
    "composition", "add", comp, local, "--text", "Spectral ink 41", "--font-file", fontPath,
    "--font-size", "40", "--color", "#ffcc00", "--project", project, "--json", ...extra,
  ]);
}

async function addBundled(comp: string, local: string, font: string, extra: string[] = []) {
  return invoke([
    "composition", "add", comp, local, "--text", "Spectral ink 41", "--font", font,
    "--font-size", "40", "--color", "#ffcc00", "--project", projDir, "--json", ...extra,
  ]);
}

async function layerIdOf(comp: string, local: string, project = projDir): Promise<string> {
  const inspect = json((await invoke(["composition", "inspect", comp, "--project", project, "--json"])).stdout) as {
    composition: { layers: { name: string; layerId: string }[] };
  };
  const use = inspect.composition.layers.find((l) => l.name === local);
  if (!use) throw new Error(`use "${local}" not found in ${comp}`);
  return use.layerId;
}

/** The stored text revision document for a Layer, re-read from Project storage. */
async function readStoredTextRevision(layerId: string, project = projDir): Promise<LayerTextRevision> {
  const identity = JSON.parse(
    await readFile(path.join(project, "layers", `${layerId}.json`), "utf8"),
  ) as { currentRevision: string };
  const revision = JSON.parse(
    await readFile(path.join(project, "layers", `${layerId}.revisions`, `${identity.currentRevision}.json`), "utf8"),
  ) as LayerTextRevision;
  expect(revision.kind).toBe("text");
  return revision;
}

/** Render a composition to a PNG buffer via the public CLI. */
async function renderPng(comp: string, outPath: string, project = projDir): Promise<Buffer> {
  const res = await invoke(["composition", "render", comp, "--out", outPath, "--project", project, "--json"]);
  expect(res.code).toBe(0);
  return readFile(outPath);
}

function inkPixels(png: ReturnType<typeof decodePng>): number {
  let ink = 0;
  for (let i = 3; i < png.rgba.length; i += 4) {
    if (png.rgba[i]! > 40) ink++;
  }
  return ink;
}

/** A solid test image, encoded by the renderer's own PNG encoder. */
function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgba[0]!;
    buf[i + 1] = rgba[1]!;
    buf[i + 2] = rgba[2]!;
    buf[i + 3] = rgba[3]!;
  }
  return encodePngRgba(width, height, buf);
}

async function compositionLayers(comp: string, project = projDir): Promise<unknown[]> {
  const inspect = json((await invoke(["composition", "inspect", comp, "--project", project, "--json"])).stdout) as {
    composition: { layers: unknown[] };
  };
  return inspect.composition.layers;
}

async function storedContentNames(project = projDir): Promise<string[]> {
  return (await readdir(path.join(project, "content"))).sort();
}

test("a caller font renders the file's glyphs — measured ink differs from the fallback face", async () => {
  await makeComposition("poster");
  const caller = await addCallerFont("poster", "pix", SILKSCREEN);
  expect(caller.code).toBe(0);
  const callerPng = decodePng(await renderPng("poster", path.join(tempDir, "caller.png")));
  expect(inkPixels(callerPng)).toBeGreaterThan(0);

  // The same text at the same size with a bundled face paints different
  // ink: the render uses the caller file's glyphs, never a fallback's.
  // Silkscreen is a blocky pixel face; Archivo is a text face.
  await makeComposition("solo");
  await addBundled("solo", "face", "Archivo");
  const bundledPng = decodePng(await renderPng("solo", path.join(tempDir, "bundled.png")));
  expect(inkPixels(bundledPng)).toBeGreaterThan(0);
  expect(callerPng.rgba.equals(bundledPng.rgba)).toBe(false);

  // The measure seam agrees: the layout extents differ between the faces.
  const m1 = json((await invoke(["composition", "measure", "poster", "pix", "--project", projDir, "--json"])).stdout) as {
    layers: { content: { width: number } }[];
  };
  const m2 = json((await invoke(["composition", "measure", "solo", "face", "--project", projDir, "--json"])).stdout) as {
    layers: { content: { width: number } }[];
  };
  expect(m1.layers[0]!.content.width).not.toBe(m2.layers[0]!.content.width);
}, 30000);

test("a CFF OpenType (.otf) caller font parses and renders the file's glyphs (INT-parser-1)", async () => {
  await makeComposition("poster");
  const added = await addCallerFont("poster", "otf", SILKSCREEN_OTF);
  expect(added.code).toBe(0);

  // The revision records the file's own facts, including its glyph format.
  const revision = await readStoredTextRevision(await layerIdOf("poster", "otf"));
  expect(revision.callerFont?.family).toBe("Silkscreen");
  expect(revision.callerFont?.format).toBe("opentype");

  // The browser paints the file's glyphs: ink exists, and the same text
  // with the bundled Archivo face renders differently.
  const otfPng = decodePng(await renderPng("poster", path.join(tempDir, "otf.png")));
  expect(inkPixels(otfPng)).toBeGreaterThan(0);
  await makeComposition("solo-otf");
  await addBundled("solo-otf", "face", "Archivo");
  const bundledPng = decodePng(await renderPng("solo-otf", path.join(tempDir, "otf-bundled.png")));
  expect(otfPng.rgba.equals(bundledPng.rgba)).toBe(false);
}, 30000);

test("a --font-file edit re-fonts the Layer and renders the file's glyphs", async () => {
  await makeComposition("poster");
  const added = await addBundled("poster", "head", "Archivo");
  expect(added.code).toBe(0);
  const before = decodePng(await renderPng("poster", path.join(tempDir, "before.png")));
  expect(inkPixels(before)).toBeGreaterThan(0);

  const layerId = await layerIdOf("poster", "head");
  const edited = await invoke(["layer", "edit", layerId, "--font-file", SILKSCREEN, "--project", projDir, "--json"]);
  expect(edited.code).toBe(0);
  const after = decodePng(await renderPng("poster", path.join(tempDir, "after.png")));
  expect(inkPixels(after)).toBeGreaterThan(0);
  // Different glyphs after the edit: the file's face, not the bundled one.
  expect(before.rgba.equals(after.rgba)).toBe(false);

  const revision = await readStoredTextRevision(layerId);
  expect(revision.callerFont?.family).toBe("Silkscreen");
  expect(revision.callerFont?.variant).toBe("static");
}, 30000);

test("out-of-range weight and width are refused naming the file's real range (variable and static); nothing publishes", async () => {
  await makeComposition("poster");
  const contentBefore = await storedContentNames();

  // Handjet is variable with a real fvar wght range of 100-900.
  const heavy = await addCallerFont("poster", "w1", HANDJET, ["--weight", "950"]);
  expect(heavy.code).toBe(1);
  expect(heavy.stdout).toContain("supports weight 100-900");
  expect(heavy.stdout).toContain("950");

  // A static face accepts only its own weight (Silkscreen: OS/2 weight 400).
  const staticRefusal = await addCallerFont("poster", "w2", SILKSCREEN, ["--weight", "700"]);
  expect(staticRefusal.code).toBe(1);
  expect(staticRefusal.stdout).toContain("static face at weight 400");

  // A file without a wdth axis accepts only the implicit width 100.
  const widthRefusal = await addCallerFont("poster", "w3", HANDJET, ["--width", "122"]);
  expect(widthRefusal.code).toBe(1);
  expect(widthRefusal.stdout).toContain("no width axis");
  expect(widthRefusal.stdout).toContain("implicit width is 100");

  expect(await compositionLayers("poster")).toHaveLength(0);
  // No stray content blob from any refused attempt.
  expect(await storedContentNames()).toEqual(contentBefore);
}, 30000);

test("in-range controls resolve against the file's own axes and are stored", async () => {
  await makeComposition("poster");
  const ok = await addCallerFont("poster", "v", HANDJET, ["--weight", "800"]);
  expect(ok.code).toBe(0);
  const revision = await readStoredTextRevision(await layerIdOf("poster", "v"));
  // Handjet has no wdth axis: the resolved pair stores the implicit 100.
  expect(revision.weight).toBe(800);
  expect(revision.width).toBe(100);
  expect(revision.callerFont?.variant).toBe("variable");
  expect(revision.callerFont?.axes?.wght).toEqual({ min: 100, default: 400, max: 900 });
  expect(revision.callerFont?.axes?.wdth).toBeUndefined();

  // A static caller face stores no axes — the bytes fix the look; its own
  // weight is accepted as a no-op control.
  const acceptedStatic = await addCallerFont("poster", "s", SILKSCREEN, ["--weight", "400"]);
  expect(acceptedStatic.code).toBe(0);
  const staticRevision = await readStoredTextRevision(await layerIdOf("poster", "s"));
  expect(staticRevision.weight).toBeUndefined();
  expect(staticRevision.width).toBeUndefined();
  expect(staticRevision.callerFont?.family).toBe("Silkscreen");
  expect(staticRevision.callerFont?.weight).toBe(400);
}, 30000);

test("a non-font file is refused before publication — nothing published", async () => {
  await makeComposition("poster");
  const notAFont = path.join(tempDir, "not-a-font.ttf");
  await writeFile(notAFont, "this is a text file pretending to be a font");
  const contentBefore = await storedContentNames();

  const res = await addCallerFont("poster", "bad", notAFont);
  expect(res.code).toBe(1);
  expect(res.stdout).toContain("not a usable font");

  expect(await compositionLayers("poster")).toHaveLength(0);
  expect(await storedContentNames()).toEqual(contentBefore);
});

test("a missing font file is refused naming the path", async () => {
  await makeComposition("poster");
  const res = await addCallerFont("poster", "gone", path.join(tempDir, "missing.ttf"));
  expect(res.code).toBe(1);
  expect(res.stdout).toContain("does not exist");
});

test("--font-file is refused on an image Layer, like every text option", async () => {
  await makeComposition("poster");
  const png = path.join(tempDir, "solid.png");
  await writeFile(png, solidPng(8, 8, [255, 0, 0, 255]));
  const added = await invoke([
    "composition", "add", "poster", "img", "--image", png, "--project", projDir, "--json",
  ]);
  expect(added.code).toBe(0);
  const layerId = await layerIdOf("poster", "img");
  const res = await invoke(["layer", "edit", layerId, "--font-file", SILKSCREEN, "--project", projDir, "--json"]);
  expect(res.code).toBe(1);
  expect(res.stdout).toContain("Cannot edit text attributes on an image Layer");
});

test("a parseable font the rendering browser cannot resolve is refused before publication", async () => {
  await makeComposition("poster");
  // The sfnt facts parse (name/OS/2/fvar tables intact) but the glyph data
  // is garbage, so the browser's font sanitizer rejects the face — the
  // same family-resolution gate the render probe applies must refuse the
  // file BEFORE anything publishes.
  const bytes = Buffer.from(await readFile(HANDJET));
  const numTables = bytes.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (bytes.toString("latin1", rec, rec + 4) === "glyf") {
      const off = bytes.readUInt32BE(rec + 8);
      const len = bytes.readUInt32BE(rec + 12);
      bytes.fill(0xff, off + 100, off + Math.min(len, 5000));
    }
  }
  const corrupt = path.join(tempDir, "corrupt-glyphs.ttf");
  await writeFile(corrupt, bytes);
  const contentBefore = await storedContentNames();

  const res = await addCallerFont("poster", "bad-glyphs", corrupt);
  expect(res.code).toBe(1);
  expect(res.stdout).toContain("failed to load in the rendering browser");
  expect(await compositionLayers("poster")).toHaveLength(0);
  expect(await storedContentNames()).toEqual(contentBefore);
}, 30000);

test("a later edit without a font option keeps the retained caller font", async () => {
  await makeComposition("poster");
  const added = await addCallerFont("poster", "head", HANDJET, ["--weight", "700"]);
  expect(added.code).toBe(0);
  const layerId = await layerIdOf("poster", "head");
  const before = await readStoredTextRevision(layerId);
  expect(before.callerFont?.family).toBe("Handjet");

  // An edit that changes neither the font nor the axes keeps everything.
  const edited = await invoke(["layer", "edit", layerId, "--color", "#00ccff", "--project", projDir, "--json"]);
  expect(edited.code).toBe(0);
  const after = await readStoredTextRevision(layerId);
  expect(after.callerFont).toEqual(before.callerFont);
  expect(after.contentHash).toBe(before.contentHash);
  expect(after.weight).toBe(700);

  // An axes edit validates against the file's stored facts — no
  // bundled-face lookup, no original file needed.
  const axesEdit = await invoke(["layer", "edit", layerId, "--weight", "950", "--project", projDir, "--json"]);
  expect(axesEdit.code).toBe(1);
  expect(axesEdit.stdout).toContain("supports weight 100-900");
}, 30000);

test("switching to a bundled family or another file follows the existing carry-or-refuse rules", async () => {
  await makeComposition("poster");
  const added = await addCallerFont("poster", "head", HANDJET, ["--weight", "700"]);
  expect(added.code).toBe(0);
  const layerId = await layerIdOf("poster", "head");

  // Carried weight 700 fits Archivo's real range: the switch keeps it, and
  // the revision is a bundled-face revision again (no callerFont).
  const toBundled = await invoke(["layer", "edit", layerId, "--font", "Archivo", "--project", projDir, "--json"]);
  expect(toBundled.code).toBe(0);
  const bundledRevision = await readStoredTextRevision(layerId);
  expect(bundledRevision.weight).toBe(700);
  expect(bundledRevision.width).toBe(100);
  expect(bundledRevision.callerFont).toBeUndefined();

  // Switching BACK to a caller file carries the axes: explicit controls
  // replace the carried values before validation (#196).
  const backToFile = await invoke([
    "layer", "edit", layerId, "--font-file", HANDJET, "--weight", "800", "--project", projDir, "--json",
  ]);
  expect(backToFile.code).toBe(0);
  const fileRevision = await readStoredTextRevision(layerId);
  expect(fileRevision.callerFont?.family).toBe("Handjet");
  expect(fileRevision.weight).toBe(800);

  // A carried weight a static target cannot express is refused naming the
  // one-command fix (the established ADR-0021 rule, unchanged for caller
  // fonts).
  const toStatic = await invoke(["layer", "edit", layerId, "--font-file", SILKSCREEN, "--project", projDir, "--json"]);
  expect(toStatic.code).toBe(1);
  expect(toStatic.stdout).toContain("static face at weight 400");
  expect(toStatic.stdout).toContain("--weight 400");
}, 30000);

test("--font and --font-file are mutually exclusive on both surfaces", async () => {
  await makeComposition("poster");
  const addRes = await invoke([
    "composition", "add", "poster", "x1", "--text", "hi", "--font", "Archivo", "--font-file", SILKSCREEN,
    "--project", projDir, "--json",
  ]);
  expect(addRes.code).toBe(2);
  expect(addRes.stdout).toContain("--font and --font-file");

  const added = await addCallerFont("poster", "head", SILKSCREEN);
  expect(added.code).toBe(0);
  const layerId = await layerIdOf("poster", "head");
  const editRes = await invoke([
    "layer", "edit", layerId, "--font", "Archivo", "--font-file", HANDJET, "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(2);
  expect(editRes.stdout).toContain("--font and --font-file");
});

test("inspect and measure report the file's own family name and caller-supplied", async () => {
  await makeComposition("poster");
  const added = await addCallerFont("poster", "head", HANDJET, ["--weight", "700"]);
  expect(added.code).toBe(0);
  const layerId = await layerIdOf("poster", "head");

  const inspectText = (await invoke(["layer", "inspect", layerId, "--project", projDir])).stdout;
  expect(inspectText).toContain('Font: "Handjet" (caller-supplied');
  const inspectJson = json((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout) as {
    layer: { currentRevision: { callerFont?: { family: string } } };
  };
  expect(inspectJson.layer.currentRevision.callerFont?.family).toBe("Handjet");

  const measure = json((await invoke(["composition", "measure", "poster", "head", "--project", projDir, "--json"])).stdout) as {
    layers: { font: { family: string; caller: boolean } | null }[];
  };
  expect(measure.layers[0]!.font).toEqual({ family: "Handjet", caller: true });
}, 30000);

test("a Render replays byte-identically after the original font file is deleted and the Project relocated", async () => {
  await makeComposition("poster");
  // Add from a disposable COPY of the fixture, so deleting it proves the
  // retained bytes are the only thing replay needs — the committed fixture
  // itself must survive the test run.
  const fontCopy = path.join(tempDir, "handjet-copy.ttf");
  await writeFile(fontCopy, await readFile(HANDJET));
  const added = await addCallerFont("poster", "head", fontCopy, ["--weight", "700"]);
  expect(added.code).toBe(0);

  const originalPng = await renderPng("poster", path.join(tempDir, "render.png"));
  expect(inkPixels(decodePng(originalPng))).toBeGreaterThan(0);

  const rendersDir = path.join(projDir, "renders");
  const manifests = (await readdir(rendersDir)).filter((f) => f.endsWith(".manifest.json"));
  expect(manifests).toHaveLength(1);

  // Delete the original file, then relocate the Project — the manifest is
  // Project-owned, so its path relocates with the Project.
  await unlink(fontCopy);
  const relocated = path.join(tempDir, "relocated");
  await rename(projDir, relocated);

  const replay = await invoke([
    "composition", "replay", path.join(relocated, "renders", manifests[0]!), "--project", relocated, "--json",
  ]);
  expect(replay.code).toBe(0);
  const replayJson = json(replay.stdout) as { replay: { output: string } };
  const replayed = await readFile(replayJson.replay.output);
  expect(replayed.equals(originalPng)).toBe(true);
}, 30000);

test("cross-Project import carries the font bytes", async () => {
  await makeComposition("poster");
  const added = await addCallerFont("poster", "head", HANDJET, ["--weight", "700"]);
  expect(added.code).toBe(0);
  const sourcePng = await renderPng("poster", path.join(tempDir, "source.png"));
  expect(inkPixels(decodePng(sourcePng))).toBeGreaterThan(0);

  await invoke(["project", "init", otherProjDir, "--name", "other-proj"]);
  await makeComposition("gallery", 500, 200, otherProjDir);
  const imported = await invoke([
    "composition", "import", "gallery", "poster", "--from-project", projDir, "--project", otherProjDir, "--json",
  ]);
  expect(imported.code).toBe(0);

  // The destination renders with the copied retained bytes — the original
  // file is never needed.
  const destRender = await invoke([
    "composition", "render", "gallery", "--out", path.join(tempDir, "dest.png"), "--project", otherProjDir, "--json",
  ]);
  expect(destRender.code).toBe(0);
  const destPng = decodePng(await readFile(path.join(tempDir, "dest.png")));
  expect(inkPixels(destPng)).toBeGreaterThan(0);

  // The destination revision carries the caller font's facts and its
  // content blob carries the bytes.
  const destLayerId = await layerIdOf("gallery", "head", otherProjDir);
  const destRev = await readStoredTextRevision(destLayerId, otherProjDir);
  expect(destRev.callerFont?.family).toBe("Handjet");
  expect(destRev.weight).toBe(700);
  await expect(readFile(path.join(otherProjDir, "content", destRev.contentHash))).resolves.toBeInstanceOf(Buffer);
}, 30000);

test("the fixture fonts are committed with their licences and stay small", async () => {
  const files = await readdir(FIXTURES);
  expect(files).toContain("Silkscreen-Regular.ttf");
  expect(files).toContain("Silkscreen-Regular.otf");
  expect(files).toContain("Handjet.ttf");
  expect(files).toContain("Silkscreen-OFL.txt");
  expect(files).toContain("Silkscreen-Otf-OFL.txt");
  expect(files).toContain("Handjet-OFL.txt");
  for (const f of files.filter((f) => f.endsWith(".ttf") || f.endsWith(".otf"))) {
    const bytes = await readFile(path.join(FIXTURES, f));
    expect(bytes.length).toBeLessThan(400 * 1024);
  }
});