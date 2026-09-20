/**
 * Shape parameters as absolute setters on `layer edit` (#209, spec #207
 * US-002, DEC-009): each shape parameter — geometry (--shape), size
 * (--size), corner radius (--corner-radius), and fill (--fill) — is an
 * ABSOLUTE setter; an omitted parameter keeps its value; an invalid value is
 * refused without advancing live state. Kind stability holds both ways: a
 * shape Layer cannot become image or text by edit, and the reverse. Shared
 * Layers obey the in-place/fork intent rules. Placement, opacity, scale,
 * rotation, flip, anchored placement, shadow, and outline are verified on a
 * shape Layer by render and measure. A property that needs an intrinsic
 * pixel size (--resize-to) keeps its current restriction, stated in help.
 *
 * TEST-001/002: external behaviour at the CLI and rendered-pixel seams the
 * layer-edit / layer-shadow / layer-outline / composition-measure /
 * composition-render tests already use. Every test file stays runnable
 * under the per-file `bun test --isolate` topology and offline.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePngRgba, decodePng } from "../src/png.js";

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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-shape-edit-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "shape-edit-proj"]);
  await invoke([
    "composition", "create", "poster", "--width", "200", "--height", "120", "--project", projDir,
  ]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function pixel(
  png: ReturnType<typeof decodePng>,
  x: number,
  y: number,
): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

const close = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

const expectPixel = (
  png: ReturnType<typeof decodePng>,
  x: number,
  y: number,
  rgba: readonly [number, number, number, number],
  tol = 2,
) => {
  const p = pixel(png, x, y);
  expect(p.every((v, i) => close(v, rgba[i]!, tol))).toBe(true);
};

async function addBar(options: string[] = []): Promise<string> {
  const add = await invoke([
    "composition", "add", "poster", "bar",
    "--shape", "rectangle", "--size", "100x50", "--corner-radius", "8",
    "--fill", "#1d4ed8", "--x", "50", "--y", "25",
    ...options, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  return JSON.parse(add.stdout).use.layerId as string;
}

async function inspectRevision(layerId: string): Promise<Record<string, unknown>> {
  const res = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).layer.currentRevision as Record<string, unknown>;
}

async function renderPng(comp = "poster"): Promise<ReturnType<typeof decodePng>> {
  const res = await invoke(["composition", "render", comp, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const out = JSON.parse(res.stdout).render.output as string;
  return decodePng(await readFile(out));
}

async function measureLayer(comp = "poster", layerId?: string): Promise<Record<string, unknown>> {
  const res = await invoke(["composition", "measure", comp, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const layers = JSON.parse(res.stdout).layers as Record<string, unknown>[];
  if (layerId === undefined) return layers[0] as Record<string, unknown>;
  const found = layers.find((l) => l.layerId === layerId);
  expect(found).toBeDefined();
  return found as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Absolute setters; omitted keeps value (US-002 bullet 1)
// ---------------------------------------------------------------------------

test("each shape parameter is an absolute setter; an omitted parameter keeps its value", async () => {
  const layerId = await addBar();
  const originalHash = (await inspectRevision(layerId)).contentHash as string;

  // --size: absolute size setter; geometry, radius, and fill carry.
  const sizeEdit = await invoke(["layer", "edit", layerId, "--size", "60x30", "--project", projDir, "--json"]);
  expect(sizeEdit.code).toBe(0);
  let rev = JSON.parse(sizeEdit.stdout).layer.currentRevision;
  expect(rev.kind).toBe("shape");
  expect(rev.shape).toBe("rectangle");
  expect(rev.width).toBe(60);
  expect(rev.height).toBe(30);
  expect(rev.cornerRadius).toBe(8);
  expect(rev.fill).toEqual({ type: "solid", color: "#1d4ed8" });
  // The content identity is the canonical parameter form: the size change
  // rehashes it.
  expect(rev.contentHash).not.toBe(originalHash);

  // --corner-radius: absolute radius setter; size, geometry, and fill keep.
  const radiusEdit = await invoke(["layer", "edit", layerId, "--corner-radius", "12", "--project", projDir, "--json"]);
  expect(radiusEdit.code).toBe(0);
  rev = JSON.parse(radiusEdit.stdout).layer.currentRevision;
  expect(rev.width).toBe(60);
  expect(rev.height).toBe(30);
  expect(rev.cornerRadius).toBe(12);
  expect(rev.fill).toEqual({ type: "solid", color: "#1d4ed8" });

  // --fill: absolute fill setter; size, geometry, and radius keep.
  const fillEdit = await invoke(["layer", "edit", layerId, "--fill", "#ff0000", "--project", projDir, "--json"]);
  expect(fillEdit.code).toBe(0);
  rev = JSON.parse(fillEdit.stdout).layer.currentRevision;
  expect(rev.fill).toEqual({ type: "solid", color: "#ff0000" });
  expect(rev.width).toBe(60);
  expect(rev.height).toBe(30);
  expect(rev.cornerRadius).toBe(12);
  expect(rev.shape).toBe("rectangle");

  // --shape: absolute geometry setter. Switching rectangle -> ellipse drops
  // the carried corner radius (a rectangle fact with no ellipse meaning);
  // size and fill keep.
  const geometryEdit = await invoke(["layer", "edit", layerId, "--shape", "ellipse", "--project", projDir, "--json"]);
  expect(geometryEdit.code).toBe(0);
  rev = JSON.parse(geometryEdit.stdout).layer.currentRevision;
  expect(rev.shape).toBe("ellipse");
  expect("cornerRadius" in rev).toBe(false);
  expect(rev.width).toBe(60);
  expect(rev.height).toBe(30);
  expect(rev.fill).toEqual({ type: "solid", color: "#ff0000" });

  // An edit that supplies no shape parameter keeps every parameter verbatim.
  const moveEdit = await invoke(["layer", "edit", layerId, "--x", "5", "--project", projDir, "--json"]);
  expect(moveEdit.code).toBe(0);
  rev = JSON.parse(moveEdit.stdout).layer.currentRevision;
  expect(rev.shape).toBe("ellipse");
  expect(rev.width).toBe(60);
  expect(rev.height).toBe(30);
  expect(rev.fill).toEqual({ type: "solid", color: "#ff0000" });
});

test("re-setting the same parameter values is an idempotent absolute setter (no new revision)", async () => {
  const layerId = await addBar();
  const inspectBefore = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  const before = JSON.parse(inspectBefore.stdout).layer;
  const edit = await invoke([
    "layer", "edit", layerId,
    "--shape", "rectangle", "--size", "100x50", "--corner-radius", "8", "--fill", "#1d4ed8",
    "--project", projDir, "--json",
  ]);
  expect(edit.code).toBe(0);
  const after = JSON.parse(
    (await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout,
  ).layer;
  // The canonical merged form equals the stored one: the same current
  // revision pointer, no storage churn (the established absolute-setter rule).
  expect(after.currentRevisionId).toBe(before.currentRevisionId);
  const revisions = await readdir(path.join(projDir, "layers", `${layerId}.revisions`));
  expect(revisions).toHaveLength(1);
});

test("an invalid shape parameter is refused without advancing live state", async () => {
  const layerId = await addBar(["--corner-radius", "20"]);
  const beforeJson = JSON.stringify(await inspectRevision(layerId));

  const cases: [string[], number, string][] = [
    [["--size", "0x30"], 1, "width"],
    [["--size", "60x-30"], 1, "height"],
    [["--size", "40x20"], 1, "corner radius"], // carried radius 20 > new max 10
    [["--fill", "blue"], 2, "fill"],
    [["--corner-radius", "-2"], 1, "corner radius"],
    [["--corner-radius", "30"], 1, "corner radius"], // over 100x50's max 25
    [["--shape", "ellipse", "--corner-radius", "5"], 1, "corner radius"],
    [["--size", "60x"], 2, "--size takes"],
  ];
  for (const [flags, code, errorMustName] of cases) {
    const res = await invoke(["layer", "edit", layerId, ...flags, "--project", projDir, "--json"]);
    expect(res.code).toBe(code);
    const json = JSON.parse(res.stdout);
    expect(json.ok).toBe(false);
    expect(json.error).toContain(errorMustName);
  }

  // Every refusal left live state unchanged.
  expect(JSON.stringify(await inspectRevision(layerId))).toBe(beforeJson);

  // The one-edit fix for the carried-radius conflict works.
  const fix = await invoke([
    "layer", "edit", layerId, "--size", "40x20", "--corner-radius", "10", "--project", projDir, "--json",
  ]);
  expect(fix.code).toBe(0);
  const rev = JSON.parse(fix.stdout).layer.currentRevision;
  expect(rev.width).toBe(40);
  expect(rev.height).toBe(20);
  expect(rev.cornerRadius).toBe(10);
});

// ---------------------------------------------------------------------------
// Kind stability, both directions (US-002 bullet 2)
// ---------------------------------------------------------------------------

test("a shape Layer cannot become image or text by edit, and the refusal names kind stability", async () => {
  const layerId = await addBar();
  const before = JSON.stringify(await inspectRevision(layerId));

  const img = path.join(tempDir, "red.png");
  const buf = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255;
  }
  await Bun.write(img, encodePngRgba(4, 4, buf));

  // shape -> image / text: the established refusals.
  const toImage = await invoke(["layer", "edit", layerId, "--image", img, "--project", projDir, "--json"]);
  expect(toImage.code).toBe(1);
  expect(JSON.parse(toImage.stdout).error).toContain("is a shape Layer");
  const toText = await invoke(["layer", "edit", layerId, "--text", "hi", "--font", "Anton", "--project", projDir, "--json"]);
  expect(toText.code).toBe(1);
  expect(JSON.parse(toText.stdout).error).toContain("is a shape Layer");
  expect(JSON.stringify(await inspectRevision(layerId))).toBe(before);
});

test("an image or text Layer cannot become a shape by edit; the refusal names kind stability", async () => {
  const img = path.join(tempDir, "red.png");
  const buf = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255;
  }
  await Bun.write(img, encodePngRgba(4, 4, buf));
  const imageAdd = await invoke([
    "composition", "add", "poster", "pic", "--image", img, "--project", projDir, "--json",
  ]);
  expect(imageAdd.code).toBe(0);
  const imageId = JSON.parse(imageAdd.stdout).use.layerId as string;
  const textAdd = await invoke([
    "composition", "add", "poster", "word", "--text", "Hello", "--font", "Anton", "--font-size", "24",
    "--project", projDir, "--json",
  ]);
  expect(textAdd.code).toBe(0);
  const textId = JSON.parse(textAdd.stdout).use.layerId as string;
  const beforeImage = JSON.stringify(await inspectRevision(imageId));
  const beforeText = JSON.stringify(await inspectRevision(textId));

  for (const flags of [
    ["--shape", "rectangle"],
    ["--size", "60x30"],
    ["--corner-radius", "5"],
    ["--fill", "#00ff00"],
  ]) {
    const onImage = await invoke(["layer", "edit", imageId, ...flags, "--project", projDir, "--json"]);
    expect(onImage.code).toBe(1);
    const imageError = JSON.parse(onImage.stdout).error as string;
    expect(imageError).toContain("Cannot edit shape parameters on an image Layer");
    expect(imageError).toContain("kind is stable");

    const onText = await invoke(["layer", "edit", textId, ...flags, "--project", projDir, "--json"]);
    expect(onText.code).toBe(1);
    const textError = JSON.parse(onText.stdout).error as string;
    expect(textError).toContain("Cannot edit shape parameters on a text Layer");
    expect(textError).toContain("kind is stable");
  }

  expect(JSON.stringify(await inspectRevision(imageId))).toBe(beforeImage);
  expect(JSON.stringify(await inspectRevision(textId))).toBe(beforeText);
});

// ---------------------------------------------------------------------------
// Shared Layers: bare edit refused, --in-place and --fork obeyed
// ---------------------------------------------------------------------------

test("a shared shape Layer refuses a bare edit and obeys --in-place / --fork", async () => {
  const layerId = await addBar();
  await invoke([
    "composition", "create", "flyer", "--width", "200", "--height", "120", "--project", projDir,
  ]);
  const imp = await invoke([
    "composition", "import", "flyer", "poster", "--project", projDir, "--json",
  ]);
  expect(imp.code).toBe(0);

  // Bare edit (no --in-place) on a Layer shared by two Compositions: refused.
  const bare = await invoke(["layer", "edit", layerId, "--fill", "#00ff00", "--project", projDir, "--json"]);
  expect(bare.code).toBe(1);
  const bareJson = JSON.parse(bare.stdout);
  expect(bareJson.error).toContain("--in-place");
  expect(bareJson.referrersCount).toBe(2);
  expect(bareJson.referringCompositions).toEqual(["flyer", "poster"].sort());

  // --in-place: advances the ONE identity; both Compositions see the edit.
  const inPlace = await invoke([
    "layer", "edit", layerId, "--fill", "#00ff00", "--in-place", "--project", projDir, "--json",
  ]);
  expect(inPlace.code).toBe(0);
  for (const comp of ["poster", "flyer"]) {
    const inspect = await invoke(["composition", "inspect", comp, "--project", projDir, "--json"]);
    const use = JSON.parse(inspect.stdout).composition.layers.find(
      (l: { name: string }) => l.name === "bar",
    );
    expect(use.layerId).toBe(layerId);
    expect(use.revision.fill).toEqual({ type: "solid", color: "#00ff00" });
  }

  // --fork: publishes a new identity and retargets only the selected use.
  const fork = await invoke([
    "layer", "edit", layerId, "--fill", "#0000ff", "--fork",
    "--composition", "flyer", "--use", "bar", "--project", projDir, "--json",
  ]);
  expect(fork.code).toBe(0);
  const forkedId = JSON.parse(fork.stdout).layer.id as string;
  expect(forkedId).not.toBe(layerId);
  const flyerInspect = await invoke(["composition", "inspect", "flyer", "--project", projDir, "--json"]);
  const flyerUse = JSON.parse(flyerInspect.stdout).composition.layers.find(
    (l: { name: string }) => l.name === "bar",
  );
  expect(flyerUse.layerId).toBe(forkedId);
  expect(flyerUse.revision.fill).toEqual({ type: "solid", color: "#0000ff" });
  const posterInspect = await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"]);
  const posterUse = JSON.parse(posterInspect.stdout).composition.layers.find(
    (l: { name: string }) => l.name === "bar",
  );
  expect(posterUse.layerId).toBe(layerId);
  expect(posterUse.revision.fill).toEqual({ type: "solid", color: "#00ff00" });
});

// ---------------------------------------------------------------------------
// Placement, transforms, and effects verified on a shape by render and
// measure (US-002 bullet 4; TEST-002)
// ---------------------------------------------------------------------------

test("position and opacity are verified on a shape by render and measure", async () => {
  await invoke([
    "composition", "add", "poster", "bg",
    "--shape", "rectangle", "--size", "200x120", "--fill", "#ffffff",
    "--project", projDir, "--json",
  ]);
  const layerId = await addBar(["--fill", "#ff0000"]);

  // Position: an absolute placement edit moves the painted shape.
  const move = await invoke(["layer", "edit", layerId, "--x", "10", "--y", "20", "--project", projDir, "--json"]);
  expect(move.code).toBe(0);
  const png = await renderPng();
  expectPixel(png, 60, 45, [255, 0, 0, 255]); // new interior
  expectPixel(png, 130, 50, [255, 255, 255, 255]); // old-interior-only region: background now
  const m = await measureLayer("poster", layerId);
  expect(m.box).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  expect(m.paintedOnCanvas).toEqual({ x: 10, y: 20, width: 100, height: 50 });

  // Opacity: 50% red over the white background blends to the expected colour.
  const veil = await invoke(["layer", "edit", layerId, "--opacity", "0.5", "--project", projDir, "--json"]);
  expect(veil.code).toBe(0);
  expect(JSON.parse(veil.stdout).layer.currentRevision.opacity).toBe(0.5);
  const veiled = await renderPng();
  expectPixel(veiled, 60, 45, [255, 128, 128, 255], 3);
  const mv = await measureLayer("poster", layerId);
  expect((mv.placement as { opacity: number }).opacity).toBe(0.5);
});

test("scale and rotation are verified on a shape by render and measure", async () => {
  await invoke([
    "composition", "create", "spin", "--width", "300", "--height", "200", "--project", projDir,
  ]);
  const add = await invoke([
    "composition", "add", "spin", "bar",
    "--shape", "rectangle", "--size", "100x50", "--fill", "#1d4ed8", "--x", "100", "--y", "50",
    "--project", projDir, "--json",
  ]);
  const layerId = JSON.parse(add.stdout).use.layerId as string;

  // Scale 2 about the top-left corner: covers (100,50)-(300,150).
  const scale = await invoke(["layer", "edit", layerId, "--scale", "2", "--project", projDir, "--json"]);
  expect(scale.code).toBe(0);
  const scaledPng = await renderPng("spin");
  expectPixel(scaledPng, 150, 75, [0x1d, 0x4e, 0xd8, 255]);
  expectPixel(scaledPng, 95, 75, [0, 0, 0, 0]);
  const ms = await measureLayer("spin");
  expect(ms.content).toEqual({ width: 100, height: 50 });
  expect(ms.box).toEqual({ x: 100, y: 50, width: 200, height: 100 });
  expect((ms.transform as { scaleX: number }).scaleX).toBe(2);

  // Rotation 90 about the top-left corner applies to the SCALED shape
  // (200x100): CSS rotate(90deg) maps (x,y) -> (-y, x), so the corners span
  // x 0..100, y 50..250 (clipped at the canvas).
  const rotate = await invoke(["layer", "edit", layerId, "--rotate", "90", "--project", projDir, "--json"]);
  expect(rotate.code).toBe(0);
  const rotatedPng = await renderPng("spin");
  expectPixel(rotatedPng, 75, 100, [0x1d, 0x4e, 0xd8, 255]);
  expectPixel(rotatedPng, 150, 75, [0, 0, 0, 0]);
  const mr = await measureLayer("spin");
  expect(mr.box).toEqual({ x: 0, y: 50, width: 100, height: 200 });
  expect((mr.transform as { rotationDeg: number }).rotationDeg).toBe(90);
  // A plain rectangle fills its rotated box exactly: painted == box.
  expect(mr.painted).toEqual(mr.box);
});

test("flip on a shape mirrors the painted geometry and records the fact", async () => {
  await invoke([
    "composition", "create", "spin", "--width", "300", "--height", "200", "--project", projDir,
  ]);
  const add = await invoke([
    "composition", "add", "spin", "bar",
    "--shape", "rectangle", "--size", "100x50", "--fill", "#1d4ed8", "--x", "100", "--y", "50",
    "--project", projDir, "--json",
  ]);
  const layerId = JSON.parse(add.stdout).use.layerId as string;

  const rotate = await invoke(["layer", "edit", layerId, "--rotate", "30", "--project", projDir, "--json"]);
  expect(rotate.code).toBe(0);
  // Rotated-only: the rect leans right of the placement corner; the local
  // center (50,25) maps to (100 + 30.8, 50 + 46.7) = (131, 97).
  const before = await renderPng("spin");
  expectPixel(before, 131, 97, [0x1d, 0x4e, 0xd8, 255]);
  expectPixel(before, 44, 47, [0, 0, 0, 0]);

  // Flip applies (about the content origin) BEFORE rotation: the local
  // center maps to (100 - 55.8, 50 - 3.3) = (44, 47) — the paint mirrored
  // across the placement corner, and the old paint is gone.
  const flip = await invoke(["layer", "edit", layerId, "--flip", "horizontal", "--project", projDir, "--json"]);
  expect(flip.code).toBe(0);
  const rev = JSON.parse(flip.stdout).layer.currentRevision;
  expect(rev.flipX).toBe(true);
  expect(rev.rotationDeg).toBe(30);
  const after = await renderPng("spin");
  expectPixel(after, 44, 47, [0x1d, 0x4e, 0xd8, 255]);
  expectPixel(after, 131, 97, [0, 0, 0, 0]);
  const m = await measureLayer("spin");
  expect(m.transform).toEqual({ scaleX: 1, scaleY: 1, rotationDeg: 30, flipX: true, flipY: false });
  // The mirrored rotated rect's bounding box: corners (100,50), (13,0),
  // (75,93), (-12,43) — flipped past the placement corner to the left.
  expect((m.box as { x: number }).x).toBeCloseTo(-11.6, 0);
  expect((m.box as { y: number }).y).toBeCloseTo(0, 0);
  expect((m.box as { width: number }).width).toBeCloseTo(111.6, 0);
  expect((m.box as { height: number }).height).toBeCloseTo(93.3, 0);
});

test("anchored placement on a shape lands the painted ink at the target", async () => {
  const layerId = await addBar();
  const edit = await invoke([
    "layer", "edit", layerId, "--anchor", "center,center", "--x", "150", "--y", "80",
    "--project", projDir, "--json",
  ]);
  expect(edit.code).toBe(0);
  const editJson = JSON.parse(edit.stdout);
  // Ink center (placement + half the 100x50 ink) lands at (150, 80).
  expect(editJson.anchored.placement).toEqual({ x: 100, y: 55 });
  const m = await measureLayer();
  const painted = m.painted as { x: number; y: number; width: number; height: number };
  expect(painted.x + painted.width / 2).toBeCloseTo(150, 0);
  expect(painted.y + painted.height / 2).toBeCloseTo(80, 0);
  const png = await renderPng();
  expectPixel(png, 150, 80, [0x1d, 0x4e, 0xd8, 255]);
  expectPixel(png, 60, 30, [0, 0, 0, 0]);
});

test("shadow and outline paint on a shape and show in measure's painted extents", async () => {
  const layerId = await addBar();

  // Shadow offset 6px right, no blur: a crisp 6px band right of the shape.
  const shadow = await invoke([
    "layer", "edit", layerId, "--shadow", "6,0,0,#000000", "--project", projDir, "--json",
  ]);
  expect(shadow.code).toBe(0);
  expect(JSON.parse(shadow.stdout).layer.currentRevision.shadow).toEqual({
    dx: 6, dy: 0, blur: 0, color: "#000000",
  });
  const shadowPng = await renderPng();
  expectPixel(shadowPng, 100, 50, [0x1d, 0x4e, 0xd8, 255]); // fill unchanged
  expectPixel(shadowPng, 153, 50, [0, 0, 0, 255]); // shadow band (150..156)
  expectPixel(shadowPng, 160, 50, [0, 0, 0, 0]); // past the shadow
  const ms = await measureLayer();
  expect((ms.effects as { shadow: unknown }).shadow).toEqual({ dx: 6, dy: 0, blur: 0, color: "#000000" });
  expect(ms.painted).toEqual({ x: 50, y: 25, width: 106, height: 50 });

  // Outline 5px wide: hugs the content edge outward; the fill shows inside.
  const outline = await invoke([
    "layer", "edit", layerId, "--outline", "5,#00ff00", "--shadow", "none", "--project", projDir, "--json",
  ]);
  expect(outline.code).toBe(0);
  const outlinePng = await renderPng();
  expectPixel(outlinePng, 47, 50, [0, 255, 0, 255]); // outline band left of the edge
  expectPixel(outlinePng, 100, 50, [0x1d, 0x4e, 0xd8, 255]); // interior keeps the fill
  expectPixel(outlinePng, 43, 50, [0, 0, 0, 0]); // outside the outline
  const mo = await measureLayer();
  expect((mo.effects as { outline: unknown }).outline).toEqual({ width: 5, color: "#00ff00" });
  expect(mo.painted).toEqual({ x: 45, y: 20, width: 110, height: 60 });
});

test("--corner-radius 0 removes a stored radius (never stored, squared paint)", async () => {
  const layerId = await addBar(); // rectangle 100x50, radius 8
  const edit = await invoke(["layer", "edit", layerId, "--corner-radius", "0", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);
  const rev = JSON.parse(edit.stdout).layer.currentRevision;
  // The same look as absent: the stored revision carries no radius field.
  expect("cornerRadius" in rev).toBe(false);
  // The paint squares: the corner pixels of the box are filled now.
  const png = await renderPng();
  expectPixel(png, 50, 25, [0x1d, 0x4e, 0xd8, 255]);
  expectPixel(png, 149, 74, [0x1d, 0x4e, 0xd8, 255]);
  // Re-setting the removal is idempotent (the radius is already absent).
  const again = await invoke(["layer", "edit", layerId, "--corner-radius", "0", "--project", projDir, "--json"]);
  expect(again.code).toBe(0);
  const revisions = await readdir(path.join(projDir, "layers", `${layerId}.revisions`));
  expect(revisions).toHaveLength(2); // creation + the one removal edit
});

test("switching the geometry to ellipse reports the dropped carried radius", async () => {
  const layerId = await addBar(); // rectangle 100x50, radius 8
  const edit = await invoke(["layer", "edit", layerId, "--shape", "ellipse", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);
  const json = JSON.parse(edit.stdout);
  // Operator visibility (review PROD-5): the edit reports exactly what it
  // dropped — a merely carried radius with no ellipse meaning.
  expect(json.shapeEdited).toEqual({ droppedCornerRadius: 8 });
  expect(json.layer.currentRevision.cornerRadius).toBeUndefined();
  // Compact text names the drop too.
  const textEdit = await invoke(["layer", "edit", json.layer.id, "--shape", "rectangle", "--corner-radius", "4", "--project", projDir, "--json"]);
  expect(textEdit.code).toBe(0);
  expect(JSON.parse(textEdit.stdout).shapeEdited).toBeUndefined();
  const next = await invoke(["layer", "edit", json.layer.id, "--shape", "ellipse", "--project", projDir, "--json"]);
  expect(next.code).toBe(0);
  expect(JSON.parse(next.stdout).shapeEdited).toEqual({ droppedCornerRadius: 4 });
  // Compact text names the drop too.
  const textSwitch = await invoke(["layer", "edit", json.layer.id, "--shape", "rectangle", "--corner-radius", "6", "--project", projDir]);
  expect(textSwitch.code).toBe(0);
  const final = await invoke(["layer", "edit", json.layer.id, "--shape", "ellipse", "--project", projDir]);
  expect(final.code).toBe(0);
  expect(final.stdout).toContain("dropped carried corner radius 6px");
});

// ---------------------------------------------------------------------------
// Intrinsic-pixel-size restriction (US-002 bullet 5)
// ---------------------------------------------------------------------------

test("--resize-to resolves against a shape's intrinsic size and stays refused on text", async () => {
  const layerId = await addBar(["--corner-radius", "0"]);
  const resize = await invoke(["layer", "edit", layerId, "--resize-to", "50x", "--project", projDir, "--json"]);
  expect(resize.code).toBe(0);
  const resized = JSON.parse(resize.stdout).resized;
  expect(resized.width).toBe(50);
  expect(resized.height).toBe(25);
  expect(resized.scaleX).toBe(0.5);

  const textAdd = await invoke([
    "composition", "add", "poster", "word", "--text", "Hello", "--font", "Anton", "--font-size", "24",
    "--project", projDir, "--json",
  ]);
  const textId = JSON.parse(textAdd.stdout).use.layerId as string;
  const refused = await invoke(["layer", "edit", textId, "--resize-to", "50x", "--project", projDir, "--json"]);
  expect(refused.code).toBe(1);
  expect(JSON.parse(refused.stdout).error).toContain("needs an intrinsic pixel size");

  // Help states the restriction (and the shape's own intrinsic size rule).
  const help = await invoke(["layer", "--help"]);
  const flatHelp = help.stdout.replace(/\s+/g, " ");
  expect(flatHelp).toContain("text has no intrinsic pixel size");
  expect(flatHelp).toContain("a shape's intrinsic size is its --size geometry");
});

test("layer edit help documents the shape parameter setters", async () => {
  const help = await invoke(["layer", "--help"]);
  expect(help.stdout).toContain("--shape");
  expect(help.stdout).toContain("--size");
  expect(help.stdout).toContain("--corner-radius");
  expect(help.stdout).toContain("--fill");
  expect(help.stdout).toContain("ABSOLUTE");
});