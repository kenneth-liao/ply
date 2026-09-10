/**
 * Layer shadows with correct painted bounds (#139, spec #132 US-003 /
 * US-002 / US-006, DEC-002/003/004/005, DEC-006, ADR-0018).
 *
 * Verifies through the public CLI seam:
 * - `--shadow "<dx>,<dy>,<blur>,<color>"` sets an ABSOLUTE shadow (a later
 *   edit replaces it; `--shadow none` removes it) on image and text Layers
 *   uniformly; `shadow` is the canonical revision fact appended to the
 *   revision hash conditionally, and retained source bytes never change.
 * - Shadow paints in the Layer's LOCAL coordinate space (before the
 *   rotate∘flip∘scale transform, which maps content+shadow together), then
 *   opacity fades content+shadow; measurement's painted extents and clipping
 *   include the shadow extent, and anchored placement resolves against the
 *   shadow-extended painted ink.
 * - Invalid settings fail before mutation; scoped help, compact output and
 *   JSON expose the effective shadow settings.
 * - Shadow facts survive in-place propagation, forks, cross-Project import,
 *   and pinned Render history replay; older revisions keep their exact ids.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { encodePngRgba, decodePng } from "../src/png.js";
import { computeRevisionHash, type LayerImageRevision } from "../src/layer.js";

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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-shadow-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "shadow-test-proj"]);
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

async function addImageLayer(comp: string, localName: string, imgFile: string, opts: { x?: number; y?: number; opacity?: number } = {}) {
  const args = ["composition", "add", comp, localName, "--image", imgFile, "--project", projDir, "--json"];
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  if (opts.opacity !== undefined) args.push("--opacity", String(opts.opacity));
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

async function addTextLayer(comp: string, localName: string, text: string, opts: { font?: string; fontSize?: number; color?: string; x?: number; y?: number; opacity?: number } = {}) {
  const args = ["composition", "add", comp, localName, "--text", text, "--font", opts.font ?? "Anton", "--project", projDir, "--json"];
  if (opts.fontSize !== undefined) args.push("--font-size", String(opts.fontSize));
  if (opts.color !== undefined) args.push("--color", opts.color);
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  if (opts.opacity !== undefined) args.push("--opacity", String(opts.opacity));
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

/** Tracer 1: `--shadow` sets an absolute shadow on an image Layer, paints
 * drop-shadow pixels around the content footprint, keeps retained bytes
 * identical, and `--shadow none` removes it. */
test("image Layer --shadow paints drop-shadow pixels and keeps content bytes", async () => {
  // Red content on transparent surround: its shadow must be visible as
  // alpha outside the content footprint.
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;
  const contentHash = addRes.layer.currentRevision.contentHash as string;

  // Baseline: no ink below the content.
  const baseOut = path.join(tempDir, "base.png");
  expect((await invoke(["composition", "render", "poster", "--project", projDir, "--out", baseOut, "--json"])).code).toBe(0);
  const base = decodePng(await readFile(baseOut));
  expect(pixel(base, 155, 50)[3]).toBe(0);

  const editRes = await invoke([
    "layer", "edit", layerId, "--shadow", "10,10,4,#000000", "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.ok).toBe(true);
  expect(editJson.layer.currentRevisionId).not.toBe(oldRevId);

  // Same content identity, new effect fact: the shadow is stored as the
  // canonical revision field.
  const rev = editJson.layer.currentRevision;
  expect(rev.contentHash).toBe(contentHash);
  expect(rev.shadow).toEqual({ dx: 10, dy: 10, blur: 4, color: "#000000" });

  // Auditable shadow report in JSON output.
  expect(editJson.shadowed).toEqual({ shadow: { dx: 10, dy: 10, blur: 4, color: "#000000" } });

  // Retained bytes are byte-identical; no new blobs staged.
  const blob = await readFile(path.join(projDir, "content", contentHash));
  expect(createHash("sha256").update(blob).digest("hex")).toBe(contentHash);
  const contentFiles = await readdir(path.join(projDir, "content"));
  expect(contentFiles).toEqual([contentHash]);

  // The shadow paints below/right of the content footprint (offset +10,+10,
  // soft 4px blur over a black shadow): opaque shadow alpha outside content,
  // and the shadow is fully opaque where content also covers it.
  const out = path.join(tempDir, "render.png");
  expect((await invoke(["composition", "render", "poster", "--project", projDir, "--out", out, "--json"])).code).toBe(0);
  const png = decodePng(await readFile(out));
  // Inside the content footprint: content + shadow composite (shadow is
  // behind the opaque content — content color wins).
  expect(pixel(png, 100, 80)).toEqual([255, 0, 0, 255]);
  // Shadow-only region: below the content's bottom edge (offset +10).
  expect(pixel(png, 100, 115)[3]).toBeGreaterThan(0);
  expect(pixel(png, 100, 115)[0]).toBeLessThan(255);
  expect(pixel(png, 100, 140)[3]).toBe(0);

  // Compact text output reports the shadow.
  const textRes = await invoke(["layer", "edit", layerId, "--shadow", "2,0,0,#ff0000", "--project", projDir]);
  expect(textRes.code).toBe(0);
  expect(textRes.stdout).toContain("shadow 2 0 0 #ff0000");

  // ABSOLUTE setter: a later edit replaces the previous shadow.
  const again = await invoke(["layer", "edit", layerId, "--shadow", "2,0,0,#ff0000", "--project", projDir, "--json"]);
  expect(again.code).toBe(0);
  const againJson = JSON.parse(again.stdout);
  expect(againJson.layer.currentRevision.shadow).toEqual({ dx: 2, dy: 0, blur: 0, color: "#ff0000" });

  // --shadow none removes the shadow (field drops from the revision).
  const remove = await invoke(["layer", "edit", layerId, "--shadow", "none", "--project", projDir, "--json"]);
  expect(remove.code).toBe(0);
  const removeJson = JSON.parse(remove.stdout);
  expect(removeJson.layer.currentRevision.shadow).toBeUndefined();
  expect(removeJson.shadowed).toEqual({ shadow: null });

  // Removal restores the baseline paint: no ink below the content.
  const afterOut = path.join(tempDir, "after.png");
  expect((await invoke(["composition", "render", "poster", "--project", projDir, "--out", afterOut, "--json"])).code).toBe(0);
  const after = decodePng(await readFile(afterOut));
  expect(pixel(after, 100, 115)[3]).toBe(0);

  // Inspect hides the removed shadow and shows a set one.
  const setRes = await invoke(["layer", "edit", layerId, "--shadow", "2,0,0,#ff0000", "--project", projDir, "--json"]);
  expect(setRes.code).toBe(0);
  const shownInspect = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(shownInspect.code).toBe(0);
  expect(shownInspect.stdout).toContain("Shadow: 2 0 0 #ff0000");
  const rmRes = await invoke(["layer", "edit", layerId, "--shadow", "none", "--project", projDir, "--json"]);
  expect(rmRes.code).toBe(0);
  const hiddenInspect = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(hiddenInspect.code).toBe(0);
  expect(hiddenInspect.stdout).not.toContain("Shadow:");
});

/** Tracer 2: a text Layer's shadow paints at its GLYPH ink (uniform effect,
 * no text-specific lifecycle) from unchanged retained font bytes. */
test("text Layer --shadow paints at the glyph ink and keeps font bytes", async () => {
  await makeComp("doc", 400, 300);
  const addRes = await addTextLayer("doc", "heading", "Hi", { font: "Anton", fontSize: 60, x: 40, y: 60 });
  const layerId = addRes.use.layerId as string;
  const fontHash = addRes.layer.currentRevision.contentHash as string;

  // The shadow paints 8px below the glyphs: render the unshadowed baseline
  // FIRST, then apply the shadow and render again — green-only ink appears
  // where no glyph ink was.
  const baseOut = path.join(tempDir, "text-base.png");
  expect((await invoke(["composition", "render", "doc", "--project", projDir, "--out", baseOut, "--json"])).code).toBe(0);
  const base = decodePng(await readFile(baseOut));

  const editRes = await invoke(["layer", "edit", layerId, "--shadow", "0,8,0,#00ff00", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(0);
  const rev = JSON.parse(editRes.stdout).layer.currentRevision;
  expect(rev.contentHash).toBe(fontHash);
  expect(rev.shadow).toEqual({ dx: 0, dy: 8, blur: 0, color: "#00ff00" });
  const out = path.join(tempDir, "text-shadow.png");
  expect((await invoke(["composition", "render", "doc", "--project", projDir, "--out", out, "--json"])).code).toBe(0);
  const png = decodePng(await readFile(out));
  let foundGreen = false;
  let diffCount = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const p = pixel(png, x, y);
      const b = pixel(base, x, y);
      if (p[3] > 0 && b[3] === 0 && p[1] === 255 && p[0] === 0 && p[2] === 0) {
        foundGreen = true;
      } else if (p[3] > 0 && b[3] === 0) {
        diffCount++;
      }
    }
  }
  console.log("DIFFS", diffCount);
  expect(foundGreen).toBe(true);
});
/** Tracer 3: measurement's painted extents, canvas clipping, and the report
 * include the shadow extent (the #137 ink pass is the seam; the shadow is
 * part of the Layer's visible painted ink). */
test("measure includes the shadow extent in painted bounds and clipping", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  // Fully on-canvas: dx/dy 10/10, blur 0 — the ink is content ∪ shadow
  // exactly: content x ∈ [50, 149] ∪ shadow x ∈ [60, 159] → width 110;
  // content y ∈ [50, 109] ∪ shadow y ∈ [60, 119] → height 70.
  const editRes = await invoke(["layer", "edit", layerId, "--shadow", "10,10,0,#000000", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(0);

  const measureRes = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  expect(measureRes.code).toBe(0);
  const layer = JSON.parse(measureRes.stdout).layers[0];
  expect(layer.effects).toEqual({ shadow: { dx: 10, dy: 10, blur: 0, color: "#000000" } });
  expect(layer.box).toEqual({ x: 50, y: 50, width: 100, height: 60 });
  expect(layer.painted).toEqual({ x: 50, y: 50, width: 110, height: 70 });
  expect(layer.paintedOnCanvas).toEqual({ x: 50, y: 50, width: 110, height: 70 });
  expect(layer.clipped).toBe(false);

  // Compact text exposes the effective shadow settings.
  const textMeasure = await invoke(["composition", "measure", "poster", "--project", projDir]);
  expect(textMeasure.code).toBe(0);
  expect(textMeasure.stdout).toContain("shadow 10 10 0 #000000");

  // A shadowed Layer near the canvas edge: ink (content ∪ shadow) is
  // clipped and the on-canvas footprint is judged against the PAINTED
  // extent. Layer at (330, 250), 100×60, shadow (-10,-10,0):
  // ink x ∈ [320, 430), y ∈ [240, 310); canvas 400×300.
  const add2 = await addImageLayer("poster", "edge", redImg, { x: 330, y: 250 });
  const edgeId = add2.use.layerId as string;
  const edit2 = await invoke(["layer", "edit", edgeId, "--shadow", "-10,-10,0,#000000", "--project", projDir, "--json"]);
  expect(edit2.code).toBe(0);
  const measure2 = await invoke(["composition", "measure", "poster", "edge", "--project", projDir, "--json"]);
  expect(measure2.code).toBe(0);
  const edge = JSON.parse(measure2.stdout).layers[0];
  expect(edge.painted).toEqual({ x: 320, y: 240, width: 110, height: 70 });
  expect(edge.paintedOnCanvas).toEqual({ x: 320, y: 240, width: 80, height: 60 });
  expect(edge.clipped).toBe(true);

  // A Layer without a shadow reports no effect facts.
  const add3 = await addImageLayer("poster", "plain", redImg, { x: 0, y: 0 });
  const plainId = add3.use.layerId as string;
  expect(plainId).toBeTruthy();
  const measure3 = await invoke(["composition", "measure", "poster", "plain", "--project", projDir, "--json"]);
  expect(JSON.parse(measure3.stdout).layers[0].effects).toEqual({ shadow: null });
  expect(JSON.parse(measure3.stdout).layers[0].painted).toEqual({ x: 0, y: 0, width: 100, height: 60 });
});

/** Tracer 4: the documented ordering contract (ADR-0018) — the shadow paints
 * in the Layer's LOCAL space, the transform maps content+shadow together,
 * and opacity fades both. A 90° clockwise rotation about the top-left point
 * maps the local (+10,+10) shadow offset to (-10,+10). */
test("the shadow transforms with the Layer and fades with its opacity", async () => {
  // A small square ink in the corner of a transparent canvas, so the
  // shadow offset direction is observable in pixels.
  const cornerPng = Buffer.alloc(100 * 100 * 4);
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const i = (y * 100 + x) * 4;
      cornerPng[i] = 255;
      cornerPng[i + 3] = 255;
    }
  }
  const img = path.join(tempDir, "corner.png");
  await writeFile(img, encodePngRgba(100, 100, cornerPng));

  await makeComp("poster", 400, 400);
  const addRes = await addImageLayer("poster", "hero", img, { x: 100, y: 100 });
  const layerId = addRes.use.layerId as string;

  // Unrotated: shadow appears right (+10) and below (+10) of the ink.
  const setShadow = await invoke(["layer", "edit", layerId, "--shadow", "10,10,0,#000000", "--project", projDir, "--json"]);
  expect(setShadow.code).toBe(0);
  const out1 = path.join(tempDir, "unrotated.png");
  expect((await invoke(["composition", "render", "poster", "--project", projDir, "--out", out1, "--json"])).code).toBe(0);
  const unrot = decodePng(await readFile(out1));
  // Ink is x ∈ [100, 119], y ∈ [100, 119]; shadow x ∈ [110, 129], y ∈ [110, 129].
  expect(pixel(unrot, 125, 115)[3]).toBeGreaterThan(0); // right of ink, inside shadow
  expect(pixel(unrot, 115, 125)[3]).toBeGreaterThan(0); // below ink, inside shadow
  expect(pixel(unrot, 95, 115)[3]).toBe(0); // left of ink: no ink
  expect(pixel(unrot, 115, 95)[3]).toBe(0); // above ink: no ink

  // Rotate 90° clockwise: the local (+10,+10) offset maps to (-10,+10) —
  // the shadow now appears LEFT of and BELOW the ink, never right.
  const rot = await invoke(["layer", "edit", layerId, "--rotate", "90", "--project", projDir, "--json"]);
  expect(rot.code).toBe(0);
  const out2 = path.join(tempDir, "rotated.png");
  expect((await invoke(["composition", "render", "poster", "--project", projDir, "--out", out2, "--json"])).code).toBe(0);
  const rotated = decodePng(await readFile(out2));
  // The rotated ink paints y ∈ [100, 119], x ∈ [80, 99]; its shadow is
  // offset (-10, +10) in canvas space: x ∈ [70, 89], y ∈ [110, 129].
  expect(pixel(rotated, 75, 115)[3]).toBeGreaterThan(0); // left of the rotated ink: shadow
  expect(pixel(rotated, 115, 125)[3]).toBe(0); // right of the rotated ink: nothing
  expect(pixel(rotated, 85, 125)[3]).toBeGreaterThan(0); // below the ink: shadow

  // Opacity fades content AND shadow: at opacity 0.5 the shadow-only
  // pixel's alpha halves.
  const op = await invoke(["layer", "edit", layerId, "--opacity", "0.5", "--project", projDir, "--json"]);
  expect(op.code).toBe(0);
  const out3 = path.join(tempDir, "faded.png");
  expect((await invoke(["composition", "render", "poster", "--project", projDir, "--out", out3, "--json"])).code).toBe(0);
  const faded = decodePng(await readFile(out3));
  const before = pixel(rotated, 75, 115);
  const after = pixel(faded, 75, 115);
  expect(after[3]).toBeGreaterThan(0);
  expect(after[3]).toBeLessThan(before[3]!);
});

/** Tracer 5: anchored placement resolves against the SHADOW-EXTENDED painted
 * ink (one definition of painted ink — the shadow is part of what is
 * visible), and --shadow cannot combine with --anchor in one edit because
 * the reference ink would be ambiguous. A shadow edit never moves an
 * already-resolved placement. */
test("anchored placement uses the shadow-extended ink; --anchor and --shadow are separate edits", async () => {
  // Transparent surround with a 40×40 subject at the layer's local origin:
  // ink box = [30, 130) x [30, 130) at placement (30, 30).
  const paddedPng = Buffer.alloc(100 * 100 * 4);
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      const i = (y * 100 + x) * 4;
      paddedPng[i] = 0;
      paddedPng[i + 1] = 0;
      paddedPng[i + 2] = 255;
      paddedPng[i + 3] = 255;
    }
  }
  const img = path.join(tempDir, "padded.png");
  await writeFile(img, encodePngRgba(100, 100, paddedPng));

  await makeComp("poster", 400, 400);
  const addRes = await addImageLayer("poster", "hero", img, { x: 30, y: 30 });
  const layerId = addRes.use.layerId as string;

  // Shadow dx 10, dy 0, blur 0: subject ink [30,70), shadow ink [40,80) x
  // [30,70). Shadow-extended ink = [30, 80) wide 50.
  const setShadow = await invoke(["layer", "edit", layerId, "--shadow", "10,0,0,#000000", "--project", projDir, "--json"]);
  expect(setShadow.code).toBe(0);

  // Anchor left edge of the painted ink at x=100: resolves to placement 100.
  const anchorRes = await invoke([
    "layer", "edit", layerId, "--anchor", "left", "--x", "100", "--project", projDir, "--json",
  ]);
  expect(anchorRes.code).toBe(0);
  const anchored = JSON.parse(anchorRes.stdout);
  // The ink starts at the placement point (ink offset 0), so left-edge
  // anchoring publishes x = 100. The resolution's measured painted box is
  // the SHADOW-EXTENDED ink [30, 80) — width 50, not the bare 40-wide
  // subject ink — measured at the pre-edit placement.
  expect(anchored.anchored.painted.width).toBe(50);
  expect(anchored.anchored.painted.x).toBe(30);
  expect(anchored.anchored.placement.x).toBe(100);

  // After the edit, the shadow-extended ink's left edge sits at x = 100.
  const measure = await invoke(["composition", "measure", "poster", "hero", "--project", projDir, "--json"]);
  expect(measure.code).toBe(0);
  const measured = JSON.parse(measure.stdout).layers[0];
  expect(measured.painted).toEqual({ x: 100, y: 30, width: 50, height: 40 });

  // --anchor + --shadow in one edit refuses (exit 2, live state unchanged).
  const conflict = await invoke([
    "layer", "edit", layerId, "--anchor", "left", "--x", "50", "--shadow", "5,0,0,#000000", "--project", projDir, "--json",
  ]);
  expect(conflict.code).toBe(2);
  expect(JSON.parse(conflict.stdout).ok).toBe(false);
  const state = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
  expect(state.layer.currentRevision.x).toBe(100);
  expect(state.layer.currentRevision.shadow).toEqual({ dx: 10, dy: 0, blur: 0, color: "#000000" });
});

/** Tracer 6: invalid shadow settings never advance live state. One parser
 * (`parseShadowSpec`) serves BOTH boundaries, so malformed specs and
 * out-of-range values are all usage errors (exit 2) at the command
 * boundary — nothing invalid reaches the edit path, and the refusal runs
 * before any staging. */
test("invalid shadow settings fail before mutation", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));
  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;
  const revBefore = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout).layer.currentRevisionId;

  // Malformed specs: usage errors (exit 2).
  for (const bad of ["10,10", "10,10,4", "a,b,4,#000000", "10,10,-4,#000000", "10,10,4,#12345", "10,10,4,red", "none,extra", ""]) {
    const res = await invoke(["layer", "edit", layerId, "--shadow", bad, "--project", projDir, "--json"]);
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout).ok).toBe(false);
  }

  // Out-of-bounds values are refused at the command boundary through the
  // SAME parser the edit path uses (the --opacity/--resize convention:
  // scalar value-range checks are exit-2 usage errors), so nothing invalid
  // ever reaches the edit path — fail-fast, before any staging.
  for (const bad of ["300,0,0,#000000", "0,-300,0,#000000", "0,0,300,#000000"]) {
    const res = await invoke(["layer", "edit", layerId, "--shadow", bad, "--project", projDir, "--json"]);
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout).ok).toBe(false);
  }

  // Live state unchanged after every refusal.
  const revAfter = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout).layer.currentRevisionId;
  expect(revAfter).toBe(revBefore);
  expect(JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout).layer.currentRevision.shadow).toBeUndefined();

  // Scoped help documents --shadow.
  const help = await invoke(["layer", "edit", "--help", "--project", projDir]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("--shadow <spec>");
  expect(help.stdout).toContain('"none"');
});

/** Tracer 7: shadow facts are Layer revision facts shared as a whole
 * (DEC-002): in-place edits propagate them, forks isolate them, cross-Project
 * copies preserve them verbatim, and retained source bytes never move. */
test("shadow facts survive edits, forks, and cross-Project import", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("source", 400, 300);
  const addRes = await addImageLayer("source", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;
  const contentHash = addRes.layer.currentRevision.contentHash as string;

  const setRes = await invoke(["layer", "edit", layerId, "--shadow", "4,4,2,#000000", "--project", projDir, "--json"]);
  expect(setRes.code).toBe(0);

  // A plain non-shadow edit carries the shadow forward.
  const moveRes = await invoke(["layer", "edit", layerId, "--x", "50", "--project", projDir, "--json"]);
  expect(moveRes.code).toBe(0);
  const moveJson = JSON.parse(moveRes.stdout);
  const shadowedRevId = moveJson.layer.currentRevisionId as string;
  expect(moveJson.layer.currentRevision.shadow).toEqual({ dx: 4, dy: 4, blur: 2, color: "#000000" });
  expect(moveJson.layer.currentRevision.contentHash).toBe(contentHash);
  // No shadow option: no `shadowed` report on this edit.
  expect(moveJson.shadowed).toBeUndefined();

  // Fork: the forked Layer carries the shadowed revision; the original keeps its own.
  await makeComp("forker", 400, 300);
  await invoke(["composition", "import", "forker", "source", "--project", projDir, "--json"]);
  const forkRes = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "forker", "--use", "hero",
    "--shadow", "none", "--project", projDir, "--json",
  ]);
  expect(forkRes.code).toBe(0);
  const forkJson = JSON.parse(forkRes.stdout);
  expect(forkJson.fork.previousLayerId).toBe(layerId);
  expect(forkJson.layer.currentRevision.shadow).toBeUndefined();
  expect(forkJson.layer.currentRevision.contentHash).toBe(contentHash);
  expect(forkJson.shadowed).toEqual({ shadow: null });
  const original = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
  expect(original.layer.currentRevisionId).toBe(shadowedRevId);
  expect(original.layer.currentRevision.shadow).toEqual({ dx: 4, dy: 4, blur: 2, color: "#000000" });

  // Cross-Project import: the destination revision preserves the shadow verbatim.
  const otherProj = path.join(tempDir, "proj2");
  await invoke(["project", "init", otherProj, "--name", "shadow-import-proj"]);
  await invoke(["composition", "create", "landing", "--width", "400", "--height", "300", "--project", otherProj, "--json"]);
  const importRes = await invoke([
    "composition", "import", "landing", "source", "--from-project", projDir, "--project", otherProj, "--json",
  ]);
  expect(importRes.code).toBe(0);
  const importedLayerId = JSON.parse(importRes.stdout).importedUses[0].layerId as string;
  const imported = JSON.parse((await invoke(["layer", "inspect", importedLayerId, "--project", otherProj, "--json"])).stdout);
  expect(imported.layer.currentRevision.shadow).toEqual({ dx: 4, dy: 4, blur: 2, color: "#000000" });
  expect(imported.layer.currentRevision.contentHash).toBe(contentHash);
  const copiedDoc = JSON.parse(
    await readFile(path.join(otherProj, "layers", `${importedLayerId}.revisions`, `${imported.layer.currentRevisionId}.json`), "utf8"),
  );
  expect(copiedDoc.shadow).toEqual({ dx: 4, dy: 4, blur: 2, color: "#000000" });
});

/** Tracer 8: shadow revisions participate in pinned Render history — a render
 * made with a shadow replays byte-identically from its pinned revision after
 * the shadow is removed, and the unshadowed pre-shadow render replays
 * unchanged too (US-006, TEST-003). */
test("render history stays pinned across shadow edits: replay is byte-identical", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;

  const firstOut = path.join(tempDir, "first.png");
  const firstRender = await invoke(["composition", "render", "poster", "--project", projDir, "--out", firstOut, "--json"]);
  expect(firstRender.code).toBe(0);
  const firstManifest = JSON.parse(firstRender.stdout).render.manifest as string;

  // Add a shadow, render, then remove it: the shadowed render's pinned
  // history must replay byte-identically after the removal.
  const setRes = await invoke(["layer", "edit", layerId, "--shadow", "6,6,3,#000000", "--project", projDir, "--json"]);
  expect(setRes.code).toBe(0);
  const secondOut = path.join(tempDir, "second.png");
  const secondRender = await invoke(["composition", "render", "poster", "--project", projDir, "--out", secondOut, "--json"]);
  expect(secondRender.code).toBe(0);
  const secondManifest = JSON.parse(secondRender.stdout).render.manifest as string;

  const rmRes = await invoke(["layer", "edit", layerId, "--shadow", "none", "--project", projDir, "--json"]);
  expect(rmRes.code).toBe(0);

  const secondReplay = path.join(tempDir, "replay2.png");
  const secondReplayRes = await invoke(["composition", "replay", secondManifest, "--project", projDir, "--out", secondReplay, "--json"]);
  expect(secondReplayRes.code).toBe(0);
  expect(await readFile(secondReplay)).toEqual(await readFile(secondOut));

  // The pre-shadow render replays unchanged too, and the shadowed render
  // genuinely differs from it.
  const firstReplay = path.join(tempDir, "replay1.png");
  const firstReplayRes = await invoke(["composition", "replay", firstManifest, "--project", projDir, "--out", firstReplay, "--json"]);
  expect(firstReplayRes.code).toBe(0);
  expect(await readFile(firstReplay)).toEqual(await readFile(firstOut));
  expect(await readFile(secondOut)).not.toEqual(await readFile(firstOut));

  // And removal restored the original paint: a fresh render matches the
  // pre-shadow pixels.
  const afterOut = path.join(tempDir, "after.png");
  const afterRender = await invoke(["composition", "render", "poster", "--project", projDir, "--out", afterOut, "--json"]);
  expect(afterRender.code).toBe(0);
  expect(await readFile(afterOut)).toEqual(await readFile(firstOut));
});

/** Tracer 9: the shadow field is appended to the revision hash only when
 * present — pre-#139 revision documents (with the full transform stack)
 * keep their exact ids, and a malformed stored shadow is refused loudly at
 * the one revision-reader boundary. */
test("hash compatibility: shadow appended only when present; malformed stored shadow refused", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));

  await makeComp("poster", 200, 200);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 5, y: 5 });
  const layerId = addRes.use.layerId as string;
  const revId = addRes.layer.currentRevisionId as string;
  const revFile = path.join(projDir, "layers", `${layerId}.revisions`, `${revId}.json`);
  const identityFile = path.join(projDir, "layers", `${layerId}.json`);

  // Strip the post-#133..#135 default fields? No: a #135-era document has
  // scale/rotation/flip written explicitly and no shadow — that IS the
  // pre-#139 shape. Re-derive its id from the shadow-absent document.
  const legacyDoc = JSON.parse(await readFile(revFile, "utf8")) as Record<string, unknown>;
  expect(legacyDoc.shadow).toBeUndefined();
  const legacyId = computeRevisionHash(legacyDoc as unknown as LayerImageRevision);
  expect(legacyId).toBe(revId);

  // A malformed stored shadow: present null is never a silent default.
  const withNull = JSON.parse(await readFile(revFile, "utf8")) as Record<string, unknown>;
  withNull.shadow = null;
  await writeFile(revFile, JSON.stringify(withNull));
  const nullRes = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(nullRes.code).toBe(1);
  expect(JSON.parse(nullRes.stdout).error).toContain("shadow must be a shadow object");

  // A non-conformant object is malformed.
  const withBad = JSON.parse(await readFile(revFile, "utf8")) as Record<string, unknown>;
  withBad.shadow = { dx: 1, dy: 2 };
  await writeFile(revFile, JSON.stringify(withBad));
  const badRes = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(badRes.code).toBe(1);
  expect(JSON.parse(badRes.stdout).error).toContain("shadow.");

  // And a valid shadow fact changes the hash (a shadow edit is a new revision).
  const withShadow = JSON.parse(await readFile(revFile, "utf8")) as Record<string, unknown>;
  withShadow.shadow = { dx: 1, dy: 2, blur: 3, color: "#000000" };
  const shadowId = computeRevisionHash(withShadow as unknown as LayerImageRevision);
  expect(shadowId).not.toBe(revId);
});
