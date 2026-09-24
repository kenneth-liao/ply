/**
 * Text weight/width as revision facts (#179, ADR-0021): a text Layer selects
 * its look with an optional `weight` and `width` control next to `--font`,
 * validated against the axis ranges the bundled face actually contains.
 * Variable faces (Archivo) always store the resolved axes; static faces
 * (IBM Plex Mono, and every pre-#179 face) store neither field. Every
 * assertion runs through the public CLI against temporary Projects and
 * produced PNGs, not private mutation.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { decodePng, encodePngRgba } from "../src/png.js";
import { computeRevisionHash, LAYER_SCHEMA_VERSION, type LayerTextRevision } from "../src/layer.js";

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

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgba[0];
    buf[i + 1] = rgba[1];
    buf[i + 2] = rgba[2];
    buf[i + 3] = rgba[3];
  }
  // Simple truecolor PNG via the renderer's own encoder.
  return encodePngRgba(width, height, buf);
}

const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

/** Count pixels within tolerance of an RGBA color. */
function countNear(png: ReturnType<typeof decodePng>, rgba: [number, number, number, number], tol = 12): number {
  let n = 0;
  for (let i = 0; i < png.rgba.length; i += 4) {
    if (
      Math.abs(png.rgba[i]! - rgba[0]) <= tol &&
      Math.abs(png.rgba[i + 1]! - rgba[1]) <= tol &&
      Math.abs(png.rgba[i + 2]! - rgba[2]) <= tol &&
      Math.abs(png.rgba[i + 3]! - rgba[3]) <= tol
    ) {
      n++;
    }
  }
  return n;
}

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-text-axes-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "axes-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComposition(name: string, width: number, height: number) {
  const res = await invoke([
    "composition", "create", name, "--width", String(width), "--height", String(height), "--project", projDir,
  ]);
  expect(res.code).toBe(0);
}

async function addText(name: string, local: string, opts: {
  text: string;
  font?: string;
  fontSize?: number;
  color?: string;
  weight?: number;
  width?: number;
  x?: number;
  y?: number;
}) {
  const args = ["composition", "add", name, local, "--text", opts.text, "--font", opts.font ?? "Archivo", "--project", projDir, "--json"];
  if (opts.fontSize !== undefined) args.push("--font-size", String(opts.fontSize));
  if (opts.color !== undefined) args.push("--color", opts.color);
  if (opts.weight !== undefined) args.push("--weight", String(opts.weight));
  if (opts.width !== undefined) args.push("--width", String(opts.width));
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  return invoke(args);
}

async function layerIdOf(comp: string, local: string): Promise<string> {
  const inspect = JSON.parse(
    (await invoke(["composition", "inspect", comp, "--project", projDir, "--json"])).stdout,
  );
  return inspect.composition.layers.find((l: { name: string }) => l.name === local).layerId as string;
}

/** The stored text revision document for a Layer, re-read from Project storage. */
async function readStoredTextRevision(layerId: string): Promise<{ revision: LayerTextRevision; revHash: string }> {
  const identity = JSON.parse(await readFile(path.join(projDir, "layers", `${layerId}.json`), "utf8"));
  const revHash = identity.currentRevision as string;
  const revision = JSON.parse(
    await readFile(path.join(projDir, "layers", `${layerId}.revisions`, `${revHash}.json`), "utf8"),
  );
  return { revision, revHash };
}

// ---------------------------------------------------------------------------
// Add semantics: variable faces store resolved axes; static faces store none.
// ---------------------------------------------------------------------------

test("Archivo stores its resolved axes; omitted controls resolve to the default instance", async () => {
  await makeComposition("poster", 600, 400);
  const res = await addText("poster", "display", { text: "Groundline", fontSize: 72, weight: 800, width: 122, color: "#ff0000" });
  expect(res.code).toBe(0);
  const displayId = JSON.parse(res.stdout).use.layerId as string;
  const display = await readStoredTextRevision(displayId);
  expect(display.revision.weight).toBe(800);
  expect(display.revision.width).toBe(122);

  // Omitted controls resolve to the variable face's default instance 400/100.
  const res2 = await addText("poster", "body", { text: "text", fontSize: 48, color: "#00ff00" });
  expect(res2.code).toBe(0);
  const bodyId = JSON.parse(res2.stdout).use.layerId as string;
  const body = await readStoredTextRevision(bodyId);
  expect(body.revision.weight).toBe(400);
  expect(body.revision.width).toBe(100);

  // Both looks share one retained font blob — the bytes are the only font
  // identity; the axes are the only difference.
  expect(display.revision.contentHash).toBe(body.revision.contentHash);
  const blobs = await readdir(path.join(projDir, "content"));
  expect(blobs).toContain(display.revision.contentHash);
  expect(blobs.filter((b) => b !== ".gitkeep").length).toBe(1);
});

test("static faces store no axis fields: IBM Plex Mono accepts omission, 500, and its implicit width 100", async () => {
  await makeComposition("poster", 600, 400);
  const ok1 = await addText("poster", "mono", { text: "util", font: "IBM Plex Mono", fontSize: 48 });
  expect(ok1.code).toBe(0);
  const monoId = JSON.parse(ok1.stdout).use.layerId as string;
  const mono = await readStoredTextRevision(monoId);
  expect(mono.revision.weight).toBeUndefined();
  expect(mono.revision.width).toBeUndefined();

  const ok2 = await addText("poster", "mono500", { text: "util", font: "IBM Plex Mono", fontSize: 48, weight: 500 });
  expect(ok2.code).toBe(0);
  const mono500 = await readStoredTextRevision(JSON.parse(ok2.stdout).use.layerId as string);
  expect(mono500.revision.weight).toBeUndefined();
  expect(mono500.revision.width).toBeUndefined();

  // #196: a static face accepts its implicit width (100) as well as its own
  // weight, and still stores no axis fields.
  const ok3 = await addText("poster", "mono100", { text: "util", font: "IBM Plex Mono", fontSize: 48, width: 100 });
  expect(ok3.code).toBe(0);
  const mono100 = await readStoredTextRevision(JSON.parse(ok3.stdout).use.layerId as string);
  expect(mono100.revision.weight).toBeUndefined();
  expect(mono100.revision.width).toBeUndefined();

  const badWeight = await invoke([
    "composition", "add", "poster", "refused", "--text", "util", "--font", "IBM Plex Mono",
    "--weight", "700", "--project", projDir,
  ]);
  expect(badWeight.code).toBe(2);
  expect(badWeight.stderr).toContain("IBM Plex Mono");
  expect(badWeight.stderr).toContain("500");
  // Any width other than the face's implicit 100 is refused, naming it.
  const badWidth = await invoke([
    "composition", "add", "poster", "refused", "--text", "util", "--font", "IBM Plex Mono",
    "--width", "122", "--project", projDir,
  ]);
  expect(badWidth.code).toBe(2);
  expect(badWidth.stderr).toContain("IBM Plex Mono");
  expect(badWidth.stderr).toContain("100");
  // The refusals published nothing: the Composition still has 3 Layers.
  const layers = JSON.parse(
    (await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"])).stdout,
  ).composition.layers;
  expect(layers.length).toBe(3);
});

test("every pre-#179 static face accepts only its own weight and its implicit width (Oswald)", async () => {
  await makeComposition("poster", 600, 400);
  const ok = await addText("poster", "head", { text: "Ply", font: "Oswald", fontSize: 64, weight: 700 });
  expect(ok.code).toBe(0);
  const stored = await readStoredTextRevision(JSON.parse(ok.stdout).use.layerId as string);
  expect(stored.revision.weight).toBeUndefined();
  expect(stored.revision.width).toBeUndefined();

  const badWeight = await invoke([
    "composition", "add", "poster", "w400", "--text", "Ply", "--font", "Oswald", "--weight", "400", "--project", projDir,
  ]);
  expect(badWeight.code).toBe(2);
  expect(badWeight.stderr).toContain("Oswald");
  expect(badWeight.stderr).toContain("700");

  // The implicit width 100 is accepted and stores nothing (#196); any other
  // width is refused, naming the allowed value.
  const okWidth = await invoke([
    "composition", "add", "poster", "w100", "--text", "Ply", "--font", "Oswald", "--width", "100", "--project", projDir, "--json",
  ]);
  expect(okWidth.code).toBe(0);
  const w100 = await readStoredTextRevision(JSON.parse(okWidth.stdout).use.layerId as string);
  expect(w100.revision.weight).toBeUndefined();
  expect(w100.revision.width).toBeUndefined();

  const badWidth = await invoke([
    "composition", "add", "poster", "ww", "--text", "Ply", "--font", "Oswald", "--width", "80", "--project", projDir,
  ]);
  expect(badWidth.code).toBe(2);
  expect(badWidth.stderr).toContain("Oswald");
  expect(badWidth.stderr).toContain("100");
});

test("out-of-range Archivo values are refused naming the allowed ranges, and publish nothing", async () => {
  await makeComposition("poster", 600, 400);
  const before = await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"]);
  for (const [flag, value, range] of [
    ["--weight", "950", "100-900"],
    ["--width", "130", "62-125"],
    ["--weight", "950"],
    ["--width", "130"],
  ] as [string, string, string?][]) {
    const res = await invoke([
      "composition", "add", "poster", "refused", "--text", "Ply", "--font", "Archivo", flag, value, "--project", projDir,
    ]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("Archivo");
    if (range) expect(res.stderr).toContain(range);
  }
  // Nothing was published: the Composition and Project state are untouched.
  const after = await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"]);
  expect(JSON.parse(after.stdout)).toEqual(JSON.parse(before.stdout));
});

// ---------------------------------------------------------------------------
// Two looks, one font file: the axes differentiate the paint.
// ---------------------------------------------------------------------------

test("Archivo 800/122 and Archivo 400/100 render visibly different looks from one font blob", async () => {
  await makeComposition("poster", 700, 300);
  await addText("poster", "display", { text: "PLY", fontSize: 96, weight: 800, width: 122, color: "#ff0000", x: 20, y: 30 });
  await addText("poster", "body", { text: "PLY", fontSize: 96, weight: 400, width: 100, color: "#0000ff", x: 20, y: 170 });

  const rendered = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(rendered.code).toBe(0);
  const pngPath = JSON.parse(rendered.stdout).render.output as string;
  const png = decodePng(await readFile(pngPath));
  const reds = countNear(png, RED);
  const blues = countNear(png, BLUE);
  expect(reds).toBeGreaterThan(100);
  expect(blues).toBeGreaterThan(100);
  // Visibly different looks: the wide 800 cut paints more ink than the
  // regular 400 cut of the same string at the same size.
  expect(reds).not.toBe(blues);

  // Measurement agrees: the width-122 cut measures wider than width-100.
  const measure = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  expect(measure.code).toBe(0);
  const layers = JSON.parse(measure.stdout).layers;
  const display = layers.find((l: { name: string }) => l.name === "display");
  const body = layers.find((l: { name: string }) => l.name === "body");
  expect(display.axes).toEqual({ weight: 800, width: 122 });
  expect(body.axes).toEqual({ weight: 400, width: 100 });
  expect(display.content.width).toBeGreaterThan(body.content.width);
});

test("measure extents equal the rendered ink for an Archivo 800/122 Layer (measure/render parity)", async () => {
  await makeComposition("poster", 500, 300);
  await addText("poster", "headline", { text: "PLY", fontSize: 96, weight: 800, width: 122, color: "#ff0000", x: 40, y: 30 });

  const measure = await invoke(["composition", "measure", "poster", "headline", "--project", projDir, "--json"]);
  expect(measure.code).toBe(0);
  const layer = JSON.parse(measure.stdout).layers[0];
  expect(layer.axes).toEqual({ weight: 800, width: 122 });

  const rendered = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(rendered.code).toBe(0);
  const png = decodePng(await readFile(JSON.parse(rendered.stdout).render.output as string));
  const reds: { x: number; y: number }[] = [];
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const [r, g, b, a] = pixel(png, x, y);
      if (a > 0 && r > 200 && g < 100 && b < 100) reds.push({ x, y });
    }
  }
  expect(reds.length).toBeGreaterThan(100);
  const inkMinX = Math.min(...reds.map((p) => p.x));
  const inkMinY = Math.min(...reds.map((p) => p.y));
  const inkMaxX = Math.max(...reds.map((p) => p.x));
  const inkMaxY = Math.max(...reds.map((p) => p.y));
  // The layout box is a superset of the glyph ink, tight enough to prove it
  // measured this axis-selected face — the same parity contract the other
  // faces already hold in composition-measure.test.ts.
  expect(inkMinX).toBeGreaterThanOrEqual(layer.box.x);
  expect(inkMinY).toBeGreaterThanOrEqual(layer.box.y);
  expect(inkMaxX).toBeLessThanOrEqual(layer.box.x + layer.box.width);
  expect(inkMaxY).toBeLessThanOrEqual(layer.box.y + layer.box.height);
  expect(layer.box.x + layer.box.width - inkMaxX).toBeLessThan(20);
  expect(layer.box.y + layer.box.height - inkMaxY).toBeLessThan(40);
  expect(inkMinX - layer.box.x).toBeLessThan(20);
});

// ---------------------------------------------------------------------------
// Edit semantics.
// ---------------------------------------------------------------------------

test("editing weight/width without --font validates against the Layer's retained font", async () => {
  await makeComposition("poster", 600, 400);
  const res = await addText("poster", "display", { text: "Ply", fontSize: 72, weight: 800, width: 122 });
  const layerId = JSON.parse(res.stdout).use.layerId as string;

  // In range: a new revision storing the new axes.
  const ok = await invoke(["layer", "edit", layerId, "--weight", "600", "--width", "100", "--in-place", "--project", projDir, "--json"]);
  expect(ok.code).toBe(0);
  const edited = await readStoredTextRevision(layerId);
  expect(edited.revision.weight).toBe(600);
  expect(edited.revision.width).toBe(100);

  // Out of range: refused naming the family and range; nothing published.
  const before = await readStoredTextRevision(layerId);
  const bad = await invoke(["layer", "edit", layerId, "--weight", "950", "--in-place", "--project", projDir]);
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("Archivo");
  expect(bad.stderr).toContain("100-900");
  const badWidth = await invoke(["layer", "edit", layerId, "--width", "130", "--in-place", "--project", projDir]);
  expect(badWidth.code).toBe(1);
  expect(badWidth.stderr).toContain("62-125");
  const after = await readStoredTextRevision(layerId);
  expect(after.revHash).toBe(before.revHash);

  // A static retained face accepts its implicit width 100 as a no-op and
  // its own weight; any other width or weight is refused, naming what it
  // allows (#196).
  const staticRes = await addText("poster", "mono", { text: "util", font: "IBM Plex Mono", fontSize: 32 });
  const staticId = JSON.parse(staticRes.stdout).use.layerId as string;
  const revBefore = (await readStoredTextRevision(staticId)).revHash;
  const staticWidthOk = await invoke(["layer", "edit", staticId, "--width", "100", "--in-place", "--project", projDir, "--json"]);
  expect(staticWidthOk.code).toBe(0);
  expect((await readStoredTextRevision(staticId)).revHash).toBe(revBefore);
  const staticWidth = await invoke(["layer", "edit", staticId, "--width", "122", "--in-place", "--project", projDir]);
  expect(staticWidth.code).toBe(1);
  expect(staticWidth.stderr).toContain("IBM Plex Mono");
  expect(staticWidth.stderr).toContain("100");
  const staticWeight = await invoke(["layer", "edit", staticId, "--weight", "700", "--in-place", "--project", projDir]);
  expect(staticWeight.code).toBe(1);
  expect(staticWeight.stderr).toContain("500");
  // Its own weight is accepted (and is a no-op on the revision).
  const staticOk = await invoke(["layer", "edit", staticId, "--weight", "500", "--in-place", "--project", projDir, "--json"]);
  expect(staticOk.code).toBe(0);
  expect((await readStoredTextRevision(staticId)).revHash).toBe(revBefore);
});

test("editing --font keeps the current axes when the new font supports them, and refuses otherwise", async () => {
  await makeComposition("poster", 600, 400);
  const res = await addText("poster", "display", { text: "Ply", fontSize: 72, weight: 800, width: 122 });
  const layerId = JSON.parse(res.stdout).use.layerId as string;

  // Archivo 800/122 -> IBM Plex Mono is refused: the carried axes conflict
  // with the static face, and the refusal names the one-command fix (#196).
  const refused = await invoke(["layer", "edit", layerId, "--font", "IBM Plex Mono", "--in-place", "--project", projDir]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("IBM Plex Mono");
  expect(refused.stderr).toContain("500");
  expect(refused.stderr).toContain("add --weight 500 --width 100");

  // Archivo 500/100 -> IBM Plex Mono succeeds, storing no axis fields.
  await invoke(["layer", "edit", layerId, "--weight", "500", "--width", "100", "--in-place", "--project", projDir, "--json"]);
  const toPlex = await invoke(["layer", "edit", layerId, "--font", "IBM Plex Mono", "--in-place", "--project", projDir, "--json"]);
  expect(toPlex.code).toBe(0);
  const mono = await readStoredTextRevision(layerId);
  expect(mono.revision.weight).toBeUndefined();
  expect(mono.revision.width).toBeUndefined();
  expect(mono.revision.contentHash).toBe(
    createHash("sha256").update(
      await readFile(path.join(projDir, "content", mono.revision.contentHash)),
    ).digest("hex"),
  );

  // A pre-#179 style revision (no axes) -> Archivo applies the default instance.
  const fresh = await addText("poster", "legacy", { text: "Ply", font: "Anton", fontSize: 48 });
  const legacyId = JSON.parse(fresh.stdout).use.layerId as string;
  const toArchivo = await invoke(["layer", "edit", legacyId, "--font", "Archivo", "--in-place", "--project", projDir, "--json"]);
  expect(toArchivo.code).toBe(0);
  const resolved = await readStoredTextRevision(legacyId);
  expect(resolved.revision.weight).toBe(400);
  expect(resolved.revision.width).toBe(100);

  // A carried width with no static equivalent refuses — nothing changes
  // silently (Archivo 500/122 -> IBM Plex Mono has no width-122 cut), and
  // the refusal names the one-command fix (#196).
  const condensed = await addText("poster", "condensed", { text: "Ply", fontSize: 48, weight: 500, width: 122 });
  const condensedId = JSON.parse(condensed.stdout).use.layerId as string;
  const widthRefused = await invoke(["layer", "edit", condensedId, "--font", "IBM Plex Mono", "--in-place", "--project", projDir]);
  expect(widthRefused.code).toBe(1);
  expect(widthRefused.stderr).toContain("IBM Plex Mono");
  expect(widthRefused.stderr).toContain("122");
  expect(widthRefused.stderr).toContain("add --width 100");

  // The explicit flag alone completes the switch when the other carried
  // axis is already the face's own (#196).
  const condensedOk = await invoke(["layer", "edit", condensedId, "--font", "IBM Plex Mono", "--width", "100", "--in-place", "--project", projDir, "--json"]);
  expect(condensedOk.code).toBe(0);
  const condensedMono = await readStoredTextRevision(condensedId);
  expect(condensedMono.revision.weight).toBeUndefined();
  expect(condensedMono.revision.width).toBeUndefined();

  // Variable -> variable via --font (same family): the current axes carry.
  await invoke(["layer", "edit", legacyId, "--weight", "700", "--width", "88", "--in-place", "--project", projDir, "--json"]);
  const sameFamily = await invoke(["layer", "edit", legacyId, "--font", "Archivo", "--in-place", "--project", projDir, "--json"]);
  expect(sameFamily.code).toBe(0);
  const carried = await readStoredTextRevision(legacyId);
  expect(carried.revision.weight).toBe(700);
  expect(carried.revision.width).toBe(88);
});

test("a variable-font Layer switches to a static face in one edit with explicit axes (#196)", async () => {
  await makeComposition("poster", 600, 400);
  const res = await addText("poster", "display", { text: "Ply", fontSize: 72, weight: 800, width: 122 });
  const layerId = JSON.parse(res.stdout).use.layerId as string;

  // One edit: explicit --weight/--width replace the carried axes before
  // validation, and the static face still stores no axis fields — the same
  // stored shape the two-edit route produces.
  const oneEdit = await invoke([
    "layer", "edit", layerId, "--font", "IBM Plex Mono", "--weight", "500", "--width", "100",
    "--in-place", "--project", projDir, "--json",
  ]);
  expect(oneEdit.code).toBe(0);
  const mono = await readStoredTextRevision(layerId);
  expect(mono.revision.weight).toBeUndefined();
  expect(mono.revision.width).toBeUndefined();

  // A command-line width other than the face's implicit 100 is a usage
  // error at the --font boundary (exit 2), naming the allowed value.
  const badWidth = await invoke(["layer", "edit", layerId, "--font", "IBM Plex Mono", "--width", "122", "--in-place", "--project", projDir]);
  expect(badWidth.code).toBe(2);
  expect(badWidth.stderr).toContain("IBM Plex Mono");
  expect(badWidth.stderr).toContain("100");

  // Nothing was published by the refusal.
  expect((await readStoredTextRevision(layerId)).revHash).toBe(mono.revHash);
});

test("a still-conflicting carried axis refuses the --font edit, naming the missing flag (#196)", async () => {
  await makeComposition("poster", 600, 400);
  const res = await addText("poster", "display", { text: "Ply", fontSize: 72, weight: 800, width: 122 });
  const layerId = JSON.parse(res.stdout).use.layerId as string;

  // --width 100 alone: the carried weight 800 still conflicts — a semantic
  // refusal (exit 1) naming the missing flag.
  const widthOnly = await invoke(["layer", "edit", layerId, "--font", "IBM Plex Mono", "--width", "100", "--in-place", "--project", projDir]);
  expect(widthOnly.code).toBe(1);
  expect(widthOnly.stderr).toContain("IBM Plex Mono");
  expect(widthOnly.stderr).toContain("add --weight 500");

  // --weight 500 alone: the carried width 122 still conflicts.
  const weightOnly = await invoke(["layer", "edit", layerId, "--font", "IBM Plex Mono", "--weight", "500", "--in-place", "--project", projDir]);
  expect(weightOnly.code).toBe(1);
  expect(weightOnly.stderr).toContain("IBM Plex Mono");
  expect(weightOnly.stderr).toContain("add --width 100");

  // Nothing was published by the refusals.
  const { revHash } = await readStoredTextRevision(layerId);
  const after = await invoke(["layer", "edit", layerId, "--font", "IBM Plex Mono", "--weight", "500", "--width", "100", "--in-place", "--project", projDir, "--json"]);
  expect(after.code).toBe(0);
  expect((await readStoredTextRevision(layerId)).revHash).not.toBe(revHash);
});

test("editing a Layer whose retained bytes match no bundled face requires --font", async () => {
  await makeComposition("poster", 600, 400);
  const res = await addText("poster", "head", { text: "Ply", font: "Anton", fontSize: 48 });
  const layerId = JSON.parse(res.stdout).use.layerId as string;
  const { revision, revHash } = await readStoredTextRevision(layerId);

  // Hand-craft a legacy Project state whose retained font bytes are not any
  // bundled face: a foreign blob, its hash in the revision, and the matching
  // revision id in the identity file — exactly what a Project written before
  // a face left the registry looks like.
  const foreignBytes = Buffer.from("not any bundled font");
  const foreignHash = createHash("sha256").update(foreignBytes).digest("hex");
  await writeFile(path.join(projDir, "content", foreignHash), foreignBytes);
  const foreignDoc = { ...revision, contentHash: foreignHash };
  const foreignId = computeRevisionHash(foreignDoc as LayerTextRevision);
  await writeFile(
    path.join(projDir, "layers", `${layerId}.revisions`, `${foreignId}.json`),
    JSON.stringify(foreignDoc),
  );
  const identityPath = path.join(projDir, "layers", `${layerId}.json`);
  const identity = JSON.parse(await readFile(identityPath, "utf8"));
  identity.currentRevision = foreignId;
  await writeFile(identityPath, JSON.stringify(identity));

  const refused = await invoke(["layer", "edit", layerId, "--weight", "400", "--in-place", "--project", projDir]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("--font");
});

test("text axes on image Layers and image options on the axes path are refused at the boundary", async () => {
  await makeComposition("poster", 600, 400);
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(32, 32, RED));
  const res = await invoke(["composition", "add", "poster", "bg", "--image", img, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const layerId = JSON.parse(res.stdout).use.layerId as string;

  const editRes = await invoke(["layer", "edit", layerId, "--weight", "400", "--in-place", "--project", projDir]);
  expect(editRes.code).toBe(1);
  expect(editRes.stderr).toContain("image Layer");

  // Usage shape: --weight on an image Layer add is refused at the boundary
  // (the --image + text-options mutual exclusion), never silently ignored.
  const addRes = await invoke(["composition", "add", "poster", "w", "--image", img, "--weight", "400", "--project", projDir]);
  expect(addRes.code).toBe(2);
});

// ---------------------------------------------------------------------------
// Inspect and hash compatibility.
// ---------------------------------------------------------------------------

test("layer inspect shows the weight and width of a variable-font text Layer", async () => {
  await makeComposition("poster", 600, 400);
  const res = await addText("poster", "display", { text: "Ply", fontSize: 72, weight: 800, width: 122 });
  const layerId = JSON.parse(res.stdout).use.layerId as string;

  const json = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
  expect(json.layer.currentRevision.weight).toBe(800);
  expect(json.layer.currentRevision.width).toBe(122);

  const text = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(text.stdout).toContain("weight 800");
  expect(text.stdout).toContain("width 122");

  // A static face shows no axes line.
  const staticRes = await addText("poster", "mono", { text: "util", font: "IBM Plex Mono", fontSize: 32 });
  const staticId = JSON.parse(staticRes.stdout).use.layerId as string;
  const staticText = await invoke(["layer", "inspect", staticId, "--project", projDir]);
  expect(staticText.stdout).not.toContain("Axes");
});

/** The pre-#179 hash formula: identical to the post-#140 formula (scale,
 * rotation, flip, shadow, outline appended only when present), with NO axis
 * fields. Kept inline as the compatibility oracle. */
function pre179RevisionHash(rev: {
  layerId: string; kind: string; contentHash: string; x: number; y: number; opacity: number; createdAt: string;
  text: string; fontSize: number; color: string;
  scaleX?: number; scaleY?: number; rotationDeg?: number; flipX?: boolean; flipY?: boolean;
  shadow?: { dx: number; dy: number; blur: number; color: string };
  outline?: { width: number; color: string };
}): string {
  const base = `${rev.layerId}:${rev.kind}:${rev.contentHash}:${rev.x}:${rev.y}:${rev.opacity}:${rev.createdAt}`;
  const textFields = `:${rev.text}:${rev.fontSize}:${rev.color}`;
  const scaleFields =
    rev.scaleX !== undefined || rev.scaleY !== undefined ? `:${rev.scaleX}:${rev.scaleY}` : "";
  const rotationField = rev.rotationDeg !== undefined ? `:${rev.rotationDeg}` : "";
  const flipFields =
    rev.flipX !== undefined || rev.flipY !== undefined ? `:${rev.flipX}:${rev.flipY}` : "";
  const shadowField =
    rev.shadow !== undefined
      ? `:shadow(${rev.shadow.dx},${rev.shadow.dy},${rev.shadow.blur},${rev.shadow.color})`
      : "";
  const outlineField =
    rev.outline !== undefined ? `:outline(${rev.outline.width},${rev.outline.color})` : "";
  return `rev_${createHash("sha256").update(`${base}${textFields}${scaleFields}${rotationField}${flipFields}${shadowField}${outlineField}`).digest("hex").slice(0, 16)}`;
}

test("hash compatibility: a pre-#179 text revision keeps its id, stores no axes, and its pinned Render replays byte-identically", async () => {
  await makeComposition("poster", 600, 400);
  const res = await addText("poster", "head", { text: "Hello", font: "Anton", fontSize: 96, color: "#ff0000" });
  const layerId = JSON.parse(res.stdout).use.layerId as string;
  const revId = JSON.parse(res.stdout).layer.currentRevisionId as string;

  // A pre-#179 text revision has no axis fields and no layoutRule. Strip
  // layoutRule to simulate an authentic pre-#179 stored revision document.
  const revPath = path.join(projDir, "layers", `${layerId}.revisions`, `${revId}.json`);
  const revJson = JSON.parse(await readFile(revPath, "utf8"));
  delete revJson.layoutRule;
  const legacyRevId = computeRevisionHash(revJson);
  await rm(revPath);
  await writeFile(path.join(projDir, "layers", `${layerId}.revisions`, `${legacyRevId}.json`), JSON.stringify(revJson, null, 2) + "\n");
  const idPath = path.join(projDir, "layers", `${layerId}.json`);
  const idJson = JSON.parse(await readFile(idPath, "utf8"));
  idJson.currentRevision = legacyRevId;
  await writeFile(idPath, JSON.stringify(idJson, null, 2) + "\n");

  const { revision, revHash } = await readStoredTextRevision(layerId);

  // The stored document IS the pre-#179 shape: no axis fields, id derived
  // without them.
  expect(revision.weight).toBeUndefined();
  expect(revision.width).toBeUndefined();
  expect(pre179RevisionHash(revision)).toBe(revHash);
  expect(computeRevisionHash(revision)).toBe(revHash);

  // Its pinned Render replays byte-identically after the current revision
  // advances — the retained-font replay contract is untouched.
  const firstOut = path.join(tempDir, "first.png");
  const first = await invoke(["composition", "render", "poster", "--project", projDir, "--out", firstOut, "--json"]);
  expect(first.code).toBe(0);
  const manifest = JSON.parse(first.stdout).render.manifest as string;

  await invoke(["layer", "edit", layerId, "--text", "Changed", "--in-place", "--project", projDir, "--json"]);
  const replayOut = path.join(tempDir, "replay.png");
  const replay = await invoke(["composition", "replay", manifest, "--project", projDir, "--out", replayOut, "--json"]);
  expect(replay.code).toBe(0);
  expect(await readFile(replayOut)).toEqual(await readFile(firstOut));
});
