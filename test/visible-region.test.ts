/**
 * The rectangular visible region on any Layer (#211, spec #207 US-003,
 * DEC-004/005/006/009/010, ADR-0023).
 *
 * Verifies through the public CLI seam and the rendered-pixel seam:
 * - `--visible-region "<x>,<y>,<width>,<height>"` sets an ABSOLUTE region
 *   rectangle in the Layer's own content pixels; `--visible-region none`
 *   removes it; the same command twice keeps the same region. The region is
 *   the canonical revision fact appended to the revision hash only when
 *   present, so revisions written before #211 keep their exact ids.
 * - A region outside the content, a zero-area region, or a malformed spec
 *   is refused before publication — live state unchanged.
 * - Content outside the region is not ink: painted extents, anchored
 *   placement, the on-canvas footprint, and `clipped` follow the region.
 * - Shadow and outline hug the region's edge (painted between content and
 *   effects — content, visible region, outline, shadow, transform, opacity).
 * - Retained content bytes and lineage are unchanged; set-then-remove
 *   renders byte-identically to never-set (ISC-38); a Render with a region
 *   replays byte-identically.
 * - The capture window is judged against the region: a large padded source
 *   refused uncropped at a given scale measures once cropped.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePngRgba, decodePng } from "../src/png.js";
import { computeRevisionHash } from "../src/layer.js";

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

const RED: [number, number, number, number] = [255, 0, 0, 255];

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-visible-region-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "region-test-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComp(name: string, width = 400, height = 300) {
  const res = await invoke([
    "composition", "create", name, "--width", String(width), "--height", String(height), "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
}

async function addImageLayer(comp: string, localName: string, imgFile: string, opts: { x?: number; y?: number } = {}) {
  const args = ["composition", "add", comp, localName, "--image", imgFile, "--project", projDir, "--json"];
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

async function render(comp: string, out: string) {
  const res = await invoke(["composition", "render", comp, "--out", out, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return readFile(out);
}

/** Tracer 1: the region sets on an image Layer, crops the paint to the
 * region rectangle, and `--visible-region none` removes it — set-then-remove
 * renders byte-identically to never-set (ISC-38) with content bytes
 * unchanged. */
test("image region sets, crops the paint, and none restores the never-set render byte-identically", async () => {
  // 200×100 red image at (30,40): full content, then region 20,10,80,40.
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(200, 100, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 30, y: 40 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;

  const neverSet = await render("poster", path.join(tempDir, "never-set.png"));

  const setRes = await invoke([
    "layer", "edit", layerId, "--visible-region", "20,10,80,40", "--project", projDir, "--json",
  ]);
  expect(setRes.code).toBe(0);
  const setJson = JSON.parse(setRes.stdout);
  expect(setJson.regionSet).toEqual({ visibleRegion: { x: 20, y: 10, width: 80, height: 40 } });
  expect(setJson.layer.currentRevisionId).not.toBe(oldRevId);

  const cropped = await render("poster", path.join(tempDir, "cropped.png"));
  const png = decodePng(cropped);
  // Inside the region: red ink at the region's interior and corners.
  // Region on canvas: x 30+20=50..130, y 40+10=50..90.
  expect(pixel(png, 50, 50)).toEqual([255, 0, 0, 255]);
  expect(pixel(png, 129, 89)).toEqual([255, 0, 0, 255]);
  expect(pixel(png, 90, 70)).toEqual([255, 0, 0, 255]);
  // Just outside the region (still inside the full content box): no ink.
  expect(pixel(png, 49, 70)[3]).toBe(0);
  expect(pixel(png, 131, 70)[3]).toBe(0);
  expect(pixel(png, 90, 49)[3]).toBe(0);
  expect(pixel(png, 90, 91)[3]).toBe(0);
  // Far outside the content box entirely: no ink.
  expect(pixel(png, 300, 200)[3]).toBe(0);

  const measureRes = await invoke([
    "composition", "measure", "poster", "hero", "--project", projDir, "--json",
  ]);
  expect(measureRes.code).toBe(0);
  const hero = JSON.parse(measureRes.stdout).layers[0];
  expect(hero.visibleRegion).toEqual({ x: 20, y: 10, width: 80, height: 40 });
  // The painted extent follows the region, not the 200×100 content box.
  expect(hero.painted).toEqual({ x: 50, y: 50, width: 80, height: 40 });
  expect(hero.paintedOnCanvas).toEqual({ x: 50, y: 50, width: 80, height: 40 });
  // The layout box stays the full transformed content box (DEC-005: the
  // placement point and transform origin stay defined against the full box).
  expect(hero.box).toEqual({ x: 30, y: 40, width: 200, height: 100 });
  expect(hero.clipped).toBe(false);

  const bytesAfterSet = await readFile(redImg);
  expect(bytesAfterSet).toEqual(await readFile(path.join(tempDir, "red.png")));

  const removeRes = await invoke([
    "layer", "edit", layerId, "--visible-region", "none", "--project", projDir, "--json",
  ]);
  expect(removeRes.code).toBe(0);
  const removeJson = JSON.parse(removeRes.stdout);
  expect(removeJson.regionSet).toEqual({ visibleRegion: null });
  expect(removeJson.layer.currentRevision.contentHash).toBe(addRes.layer.currentRevision.contentHash);

  const afterRemove = await render("poster", path.join(tempDir, "after-remove.png"));
  expect(afterRemove.equals(neverSet)).toBe(true);
});
/** Tracer 2: the refusal matrix — a region outside the content, a zero-area
 * region, negative coordinates, and malformed grammar are refused before
 * publication with live state unchanged; re-issuing an identical region is
 * a detected no-op. */
test("region refusals leave live state unchanged and identical re-sets are no-ops", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(200, 100, RED));
  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 30, y: 40 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;

  // Semantic refusals (content bounds): exit 1, revision unchanged.
  const semanticCases: [string, RegExp][] = [
    ["0,0,201,100", /must lie inside the Layer's 200×100px content box/],
    ["0,0,200,101", /must lie inside the Layer's 200×100px content box/],
    ["201,0,10,10", /must lie inside the Layer's 200×100px content box/],
  ];
  for (const [spec, pattern] of semanticCases) {
    const res = await invoke(["layer", "edit", layerId, "--visible-region", spec, "--project", projDir, "--json"]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).error).toMatch(pattern);
    const inspect = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
    expect(inspect.layer.currentRevisionId).toBe(oldRevId);
  }

  // Grammar/numeric refusals (the shared spec parser): exit 2 at the CLI
  // boundary — the same parser the edit path re-runs, so the two boundaries
  // never disagree (the --shadow range convention).
  const grammarCases: [string, RegExp][] = [
    ["0,0,0,40", /zero-area region shows nothing/],
    ["0,0,80,0", /zero-area region shows nothing/],
    ["-5,0,80,40", /must be a finite number of px >= 0/],
    ["0,-5,80,40", /must be a finite number of px >= 0/],
    ["0,0,-80,40", /must be a finite number of px greater than 0/],
    ["20,10,80", /--visible-region takes/],
    ["20,10,80,40,50", /--visible-region takes/],
    ["abc", /--visible-region takes/],
    ["", /--visible-region takes/],
    ["none,0,1,1", /must be a finite number of px >= 0/],
  ];
  for (const [spec, pattern] of grammarCases) {
    const res = await invoke(["layer", "edit", layerId, "--visible-region", spec, "--project", projDir, "--json"]);
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout).error).toMatch(pattern);
  }
  // Live state is still untouched after every refusal.
  const inspect = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
  expect(inspect.layer.currentRevisionId).toBe(oldRevId);

  // Idempotence: the same command twice keeps the same revision.
  const set1 = await invoke(["layer", "edit", layerId, "--visible-region", "20,10,80,40", "--project", projDir, "--json"]);
  expect(set1.code).toBe(0);
  const rev1 = JSON.parse(set1.stdout).layer.currentRevisionId;
  const set2 = await invoke(["layer", "edit", layerId, "--visible-region", "20,10,80,40", "--project", projDir, "--json"]);
  expect(set2.code).toBe(0);
  expect(JSON.parse(set2.stdout).layer.currentRevisionId).toBe(rev1);
  expect(JSON.parse(set2.stdout).regionSet).toEqual({ visibleRegion: { x: 20, y: 10, width: 80, height: 40 } });

  // Removing an absent region is a no-op too.
  const rm = await invoke(["layer", "edit", layerId, "--visible-region", "none", "--project", projDir, "--json"]);
  expect(rm.code).toBe(0);
  expect(JSON.parse(rm.stdout).layer.currentRevisionId).not.toBe(rev1);
  const rm2 = await invoke(["layer", "edit", layerId, "--visible-region", "none", "--project", projDir, "--json"]);
  expect(rm2.code).toBe(0);
  expect(JSON.parse(rm2.stdout).layer.currentRevisionId).toBe(JSON.parse(rm.stdout).layer.currentRevisionId);
}, 30000);

/** Tracer 3: the region works on text and shape Layers alike, and anchored
 * placement resolves against the region-clipped visible ink (DEC-005). */
test("text and shape regions crop, and anchored placement resolves the region's ink", async () => {
  await makeComp("poster", 400, 300);

  // Text: region on a text Layer measures and paints the region's box.
  const addText = JSON.parse(
    (await invoke(["composition", "add", "poster", "head", "--text", "Groundline", "--font", "Anton", "--font-size", "60", "--color", "#ffcc00", "--x", "20", "--y", "40", "--project", projDir, "--json"]).then(r => { expect(r.code).toBe(0); return r.stdout; })),
  );
  const textId = addText.use.layerId as string;
  const textSet = await invoke(["layer", "edit", textId, "--visible-region", "10,5,120,40", "--project", projDir, "--json"]);
  expect(textSet.code).toBe(0);
  expect(JSON.parse(textSet.stdout).regionSet.visibleRegion).toEqual({ x: 10, y: 5, width: 120, height: 40 });
  const textMeasure = JSON.parse(
    (await invoke(["composition", "measure", "poster", "head", "--project", projDir, "--json"]).then(r => { expect(r.code).toBe(0); return r.stdout; })),
  ).layers[0];
  expect(textMeasure.visibleRegion).toEqual({ x: 10, y: 5, width: 120, height: 40 });
  // The painted extent is the region ∩ glyph ink, anchored at the region.
  expect(textMeasure.painted.x).toBe(30);
  expect(textMeasure.painted.width).toBeLessThanOrEqual(120);

  // Shape: region on a shape Layer crops the fill.
  const addShape = JSON.parse(
    (await invoke(["composition", "add", "poster", "bar", "--shape", "rectangle", "--size", "200x100", "--fill", "#22c55e", "--x", "100", "--y", "150", "--project", projDir, "--json"]).then(r => { expect(r.code).toBe(0); return r.stdout; })),
  );
  const shapeId = addShape.use.layerId as string;
  const shapeSet = await invoke(["layer", "edit", shapeId, "--visible-region", "0,0,50,50", "--project", projDir, "--json"]);
  expect(shapeSet.code).toBe(0);
  const shapeMeasure = JSON.parse(
    (await invoke(["composition", "measure", "poster", "bar", "--project", projDir, "--json"]).then(r => { expect(r.code).toBe(0); return r.stdout; })),
  ).layers[0];
  expect(shapeMeasure.painted).toEqual({ x: 100, y: 150, width: 50, height: 50 });
  expect(shapeMeasure.box).toEqual({ x: 100, y: 150, width: 200, height: 100 });

  // Anchored placement resolves the region-clipped ink: an opaque 100×100
  // image with region "25,25,50,50" anchored center,center at (100,100)
  // lands the region's center there — x = 100 - 25 - 25 = 50.
  const opaque = path.join(tempDir, "opaque.png");
  await writeFile(opaque, solidPng(100, 100, RED));
  await makeComp("anchor-comp", 400, 300);
  const addImg = JSON.parse(
    (await invoke(["composition", "add", "anchor-comp", "hero", "--image", opaque, "--x", "0", "--y", "0", "--project", projDir, "--json"]).then(r => { expect(r.code).toBe(0); return r.stdout; })),
  );
  const imgId = addImg.use.layerId as string;
  await invoke(["layer", "edit", imgId, "--visible-region", "25,25,50,50", "--project", projDir, "--json"]);
  const anchorRes = await invoke(["layer", "edit", imgId, "--anchor", "center,center", "--x", "100", "--y", "100", "--project", projDir, "--json"]);
  expect(anchorRes.code).toBe(0);
  const anchored = JSON.parse(anchorRes.stdout).anchored;
  expect(anchored.placement.x).toBe(50);
  expect(anchored.placement.y).toBe(50);
  // The ink the anchor resolved against: the region-clipped painted box of
  // the pre-edit placement (0,0) — the region ∩ ink, never the layout box.
  expect(anchored.painted).toEqual({ x: 25, y: 25, width: 50, height: 50 });
}, 30000);

/** Tracer 4: shadow and outline hug the REGION's edge (DEC-004 paint order:
 * content, visible region, outline, shadow, transform and opacity) — the
 * ring and the shadow extend only past the cropped edge, never the full
 * content edge, and the capture window still captures the effect ink. */
test("outline and shadow hug the region's edge and painted extents follow", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(200, 100, RED));
  await makeComp("poster", 400, 300);
  // Image at (50,50); region 20,10,80,40 → ink on canvas x 70..150, y 60..100.
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;
  expect((await invoke(["layer", "edit", layerId, "--visible-region", "20,10,80,40", "--project", projDir])).code).toBe(0);
  expect((await invoke(["layer", "edit", layerId, "--outline", "4,#00ff00", "--shadow", "10,5,0,#0000ff", "--project", projDir])).code).toBe(0);

  const pngBytes = await render("poster", path.join(tempDir, "effected.png"));
  const png = decodePng(pngBytes);
  // Region interior: red content.
  expect(pixel(png, 100, 80)).toEqual([255, 0, 0, 255]);
  // The outline ring hugs the region's edge: green 2px left of the region's
  // left edge (x=70) and 2px above the top edge (y=60) — and NOT at the full
  // content box's edge (the content box extends to x=250, y=150).
  expect(pixel(png, 68, 80)).toEqual([0, 255, 0, 255]);
  expect(pixel(png, 100, 58)).toEqual([0, 255, 0, 255]);
  expect(pixel(png, 152, 80)).toEqual([0, 255, 0, 255]);
  expect(pixel(png, 100, 102)).toEqual([0, 255, 0, 255]);
  // The shadow extends past the region's edge (offset 10,5 from the outlined
  // composite): blue below-right of the region, where there is no ring.
  expect(pixel(png, 160, 105)).toEqual([0, 0, 255, 255]);
  // Beyond the content box's far edge: nothing — the effects follow the
  // region, not the full content box.
  expect(pixel(png, 255, 152)[3]).toBe(0);
  expect(pixel(png, 200, 80)[3]).toBe(0);

  const measureRes = JSON.parse(
    (await invoke(["composition", "measure", "poster", "hero", "--project", projDir, "--json"]).then(r => { expect(r.code).toBe(0); return r.stdout; })),
  ).layers[0];
  // The painted extent covers content + ring + shadow around the region
  // box: outline 4px every side, shadow reaching 10+4=14px right and 5+4=9px
  // down from the region edge.
  expect(measureRes.painted.x).toBe(66); // 70 - 4 (ring)
  expect(measureRes.painted.y).toBe(56); // 60 - 4
  // The outlined composite spans region ⊕ 4px (x 66..154, y 56..104); the
  // shadow offsets it by (10,5) (x 76..164, y 61..109). Union: 98 wide.
  expect(measureRes.painted.width).toBe(98);
  expect(measureRes.painted.x + measureRes.painted.width).toBe(164);
  expect(measureRes.painted.y + measureRes.painted.height).toBe(109);
}, 30000);

/** Tracer 5: one-command add accepts --visible-region, applies it in the
 * documented order (content, transforms, region, anchor, effects), refuses
 * before publication naming the fault, and --anchor resolves the
 * region-clipped ink on add (the framing use case). */
test("composition add sets the region, anchors its ink, and refuses outside content", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(200, 100, RED));
  await makeComp("poster", 400, 300);

  // Plain add with a region.
  const addRes = JSON.parse(
    (await invoke(["composition", "add", "poster", "hero", "--image", redImg, "--x", "30", "--y", "40", "--visible-region", "20,10,80,40", "--project", projDir, "--json"]).then(r => { expect(r.code).toBe(0); return r.stdout; })),
  );
  expect(addRes.layer.currentRevision.visibleRegion).toEqual({ x: 20, y: 10, width: 80, height: 40 });

  // Anchor on add resolves the region-clipped ink: an opaque 100×100 image,
  // region "25,25,50,50", anchored right at --x 300 → x = 300 - 75 = 225
  // (ink spans placement+25..placement+75).
  const opaque = path.join(tempDir, "opaque.png");
  await writeFile(opaque, solidPng(100, 100, RED));
  const anchoredAdd = JSON.parse(
    (await invoke(["composition", "add", "poster", "framed", "--image", opaque, "--visible-region", "25,25,50,50", "--anchor", "right", "--x", "300", "--project", projDir, "--json"]).then(r => { expect(r.code).toBe(0); return r.stdout; })),
  );
  expect(anchoredAdd.layer.currentRevision.x).toBe(225);

  // Refusal: a region outside the fresh content publishes nothing.
  const before = JSON.parse(
    (await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"]).then(r => { expect(r.code).toBe(0); return r.stdout; })),
  );
  const refused = await invoke(["composition", "add", "poster", "bad", "--image", redImg, "--visible-region", "150,0,100,50", "--project", projDir, "--json"]);
  expect(refused.code).toBe(1);
  expect(JSON.parse(refused.stdout).error).toMatch(/must lie inside the Layer's 200×100px content box/);
  const after = JSON.parse(
    (await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"]).then(r => { expect(r.code).toBe(0); return r.stdout; })),
  );
  expect(after.composition.layers.map((l: { name: string }) => l.name)).toEqual(before.composition.layers.map((l: { name: string }) => l.name));
}, 30000);

/** Tracer 6 (TEST-003): the measurement capture window is judged against
 * the visible region, not the full content box — a wide padded source whose
 * layout box at a given scale exceeds the bounded capture window is refused
 * uncropped, and measures once cropped to its subject. */
test("a wide padded source refused uncropped at scale measures once region-cropped", async () => {
  // 4096×64 mostly transparent with a 200×64 opaque subject at the left.
  const wide = Buffer.alloc(4096 * 64 * 4);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 4096; x++) {
      const o = (y * 4096 + x) * 4;
      const subject = x < 200;
      wide[o] = 255;
      wide[o + 1] = subject ? 0 : 0;
      wide[o + 2] = 0;
      wide[o + 3] = subject ? 255 : 0;
    }
  }
  const wideImg = path.join(tempDir, "wide.png");
  await writeFile(wideImg, encodePngRgba(4096, 64, wide));
  await makeComp("poster", 400, 300);
  const addRes = JSON.parse(
    (await invoke(["composition", "add", "poster", "hero", "--image", wideImg, "--x", "0", "--y", "0", "--project", projDir, "--json"]).then(r => { expect(r.code).toBe(0); return r.stdout; })),
  );
  const layerId = addRes.use.layerId as string;
  expect((await invoke(["layer", "edit", layerId, "--scale", "2", "--project", projDir])).code).toBe(0);

  // Uncropped: the layout box 8192×128 plus the pad exceeds the 8192px
  // per-axis capture window — refused loudly, naming the Layer.
  const refused = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  expect(refused.code).toBe(1);
  expect(JSON.parse(refused.stdout).error).toMatch(/beyond the painted-extent capture window/);

  // Cropped to the subject: the region box is 400×128, well inside the
  // window — the measurement succeeds and reports the subject's ink.
  expect((await invoke(["layer", "edit", layerId, "--visible-region", "0,0,200,64", "--project", projDir])).code).toBe(0);
  const measured = JSON.parse(
    (await invoke(["composition", "measure", "poster", "hero", "--project", projDir, "--json"]).then(r => { expect(r.code).toBe(0); return r.stdout; })),
  ).layers[0];
  expect(measured.visibleRegion).toEqual({ x: 0, y: 0, width: 200, height: 64 });
  expect(measured.painted).toEqual({ x: 0, y: 0, width: 400, height: 128 });
  expect(measured.box.width).toBe(8192);
}, 30000);

/** Tracer 7 (TEST-006): a Render with a region replays byte-identically
 * after later edits — the manifest pins the region-carrying revision — and
 * a region edit touches no retained bytes: the only changed files are the
 * Layer's revision document and identity pointer (content and lineage
 * storage is untouched). */
test("a Render with a region replays byte-identically and a region edit touches no retained bytes", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(200, 100, RED));
  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;
  expect((await invoke(["layer", "edit", layerId, "--visible-region", "20,10,80,40", "--project", projDir])).code).toBe(0);

  const original = await render("poster", path.join(tempDir, "original.png"));
  // The render's manifest path comes from its own JSON (the manifest lives
  // in the Project's renders/ record).
  const manifestPath = JSON.parse(
    (await invoke(["composition", "render", "poster", "--out", path.join(tempDir, "manifest-probe.png"), "--project", projDir, "--json"]).then(r => { expect(r.code).toBe(0); return r.stdout; })),
  ).render.manifest as string;

  // Later edits advance the live Layer...
  expect((await invoke(["layer", "edit", layerId, "--shadow", "4,4,2,#000000", "--project", projDir])).code).toBe(0);
  const afterEdits = await render("poster", path.join(tempDir, "after-edits.png"));
  expect(afterEdits.equals(original)).toBe(false);

  // ...and replay regenerates the pinned region render byte-identically.
  const replayRes = await invoke([
    "composition", "replay", manifestPath, "--out", path.join(tempDir, "replayed.png"), "--project", projDir, "--json",
  ]);
  expect(replayRes.code).toBe(0);
  expect((await readFile(path.join(tempDir, "replayed.png"))).equals(original)).toBe(true);

  // Lineage/bytes: another region edit changes only the revision document
  // and the identity pointer — every other Project file is untouched.
  const snapshotBefore = new Map<string, string>();
  for (const dir of ["layers", "content", "generation", "matting"]) {
    try {
      for (const entry of Array.from(new Bun.Glob("**/*").scanSync({ cwd: path.join(projDir, dir) }))) {
        const p = path.join(projDir, dir, entry);
        const f = Bun.file(p);
        snapshotBefore.set(p, `${f.size}`);
      }
    } catch { /* absent dirs stay absent */ }
  }
  expect((await invoke(["layer", "edit", layerId, "--visible-region", "none", "--project", projDir])).code).toBe(0);
  const snapshotAfter = new Map<string, string>();
  for (const dir of ["layers", "content", "generation", "matting"]) {
    try {
      for (const entry of Array.from(new Bun.Glob("**/*").scanSync({ cwd: path.join(projDir, dir) }))) {
        const p = path.join(projDir, dir, entry);
        const f = Bun.file(p);
        snapshotAfter.set(p, `${f.size}`);
      }
    } catch { /* absent dirs stay absent */ }
  }
  // The content blob and any lineage records are byte-stable; only the
  // revision doc (new file) and the identity pointer differ.
  const changed = [...snapshotAfter.keys()].filter((k) => snapshotBefore.get(k) !== snapshotAfter.get(k));
  expect(changed.every((k) => k.endsWith(".revisions/") === false)).toBe(true);
  expect(changed.filter((k) => k.includes("content/")).length).toBe(0);
  expect(changed.filter((k) => k.includes("generation/") || k.includes("matting/")).length).toBe(0);
}, 30000);

/** Tracer 8: edit-surface exclusivity and revision-hash conditionality —
 * --anchor and content edits refuse to combine with --visible-region; the
 * revision hash appends the region only when present, so pre-#211 revision
 * ids and paint meaning are untouched (DEC-010); forks carry the region. */
test("region edit exclusivity, hash conditionality, and fork propagation", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(200, 100, RED));
  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  // --anchor is its own edit: the anchor would resolve different ink than a
  // region-setting edit publishes.
  const anchorRes = await invoke([
    "layer", "edit", layerId, "--anchor", "center,center", "--x", "100", "--y", "100", "--visible-region", "20,10,80,40", "--project", projDir, "--json",
  ]);
  expect(anchorRes.code).toBe(2);
  expect(JSON.parse(anchorRes.stdout).error).toMatch(/--anchor is its own edit/);
  expect(JSON.parse(anchorRes.stdout).error).toContain("--visible-region");

  // The region is validated against the content box, so content edits are
  // separate edits (the one-intent-per-edit precedent).
  const contentRes = await invoke([
    "layer", "edit", layerId, "--visible-region", "20,10,80,40", "--opacity", "0.5", "--project", projDir, "--json",
  ]);
  expect(contentRes.code).toBe(0); // placement options combine freely
  const withContent = await invoke([
    "layer", "edit", layerId, "--visible-region", "10,5,40,20", "--image", redImg, "--project", projDir, "--json",
  ]);
  expect(withContent.code).toBe(1);
  expect(JSON.parse(withContent.stdout).error).toMatch(/Visible region and content edits are separate edits/);

  // The revision hash appends the region only when present: a region-less
  // revision hashes as before, and adding the region moves the id.
  const before = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout).layer;
  const regionless = { ...before.currentRevision } as Record<string, unknown>;
  delete regionless.visibleRegion;
  delete regionless.revisionId;
  const baseHash = computeRevisionHash(regionless as never);
  const withRegion = { ...regionless, visibleRegion: { x: 1, y: 2, width: 3, height: 4 } };
  expect(computeRevisionHash(withRegion as never)).not.toBe(baseHash);
  delete (withRegion as Record<string, unknown>).visibleRegion;
  expect(computeRevisionHash(withRegion as never)).toBe(baseHash);

  // Forks carry the region (a revision fact shared as a whole, DEC-002).
  const forkRes = await invoke([
    "layer", "edit", layerId, "--visible-region", "20,10,80,40", "--fork", "--composition", "poster", "--use", "hero", "--project", projDir, "--json",
  ]);
  expect(forkRes.code).toBe(0);
  const forked = JSON.parse(forkRes.stdout).layer.currentRevision.visibleRegion;
  expect(forked).toEqual({ x: 20, y: 10, width: 80, height: 40 });
}, 30000);
