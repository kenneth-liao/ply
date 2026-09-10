/**
 * Layer outlines with correct painted bounds (#140, spec #132 US-003 /
 * US-002 / US-006, DEC-002/003/004/005, DEC-006, ADR-0019).
 *
 * Verifies through the public CLI seam:
 * - `--outline "<width>,<color>"` sets an ABSOLUTE outline (a later edit
 *   replaces it; `--outline none` removes it) on image and text Layers
 *   uniformly; `outline` is the canonical revision fact appended to the
 *   revision hash conditionally, and retained source bytes never change.
 * - The outline hugs the content in the Layer's LOCAL coordinate space
 *   (before the rotate∘flip∘scale transform), the shadow — when both exist
 *   — is cast from the outlined composite, opacity fades everything, and
 *   measurement's painted extents and clipping include the outline extent.
 * - Invalid settings fail before mutation; scoped help, compact output and
 *   JSON expose the effective outline settings.
 * - Outline facts survive in-place propagation, forks, cross-Project import,
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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-outline-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "outline-test-proj"]);
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

/** Tracer 1: `--outline` sets an absolute outline on an image Layer, paints
 * outline pixels hugging the content footprint, keeps retained bytes
 * identical, and `--outline none` removes it. */
test("image Layer --outline paints outline pixels and keeps content bytes", async () => {
  // Red content on transparent surround: its outline must be visible as
  // blue alpha outside the content footprint.
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;
  const contentHash = addRes.layer.currentRevision.contentHash as string;

  // Baseline: no ink left of the content.
  const baseOut = path.join(tempDir, "base.png");
  expect((await invoke(["composition", "render", "poster", "--project", projDir, "--out", baseOut, "--json"])).code).toBe(0);
  const base = decodePng(await readFile(baseOut));
  expect(pixel(base, 45, 70)[3]).toBe(0);

  const editRes = await invoke([
    "layer", "edit", layerId, "--outline", "4,#0000ff", "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.ok).toBe(true);
  expect(editJson.layer.currentRevisionId).not.toBe(oldRevId);

  // Same content identity, new effect fact: the outline is stored as the
  // canonical revision field.
  const rev = editJson.layer.currentRevision;
  expect(rev.contentHash).toBe(contentHash);
  expect(rev.outline).toEqual({ width: 4, color: "#0000ff" });

  // Auditable outline report in JSON output.
  expect(editJson.outlined).toEqual({ outline: { width: 4, color: "#0000ff" } });

  // Retained bytes are byte-identical; no new blobs staged.
  const blob = await readFile(path.join(projDir, "content", contentHash));
  expect(createHash("sha256").update(blob).digest("hex")).toBe(contentHash);
  const contentFiles = await readdir(path.join(projDir, "content"));
  expect(contentFiles).toEqual([contentHash]);

  // The outline hugs the content footprint: blue ink 4px out on every side
  // (the ink extends to [46, 154) × [46, 114)); the content stays red
  // where it covers the outline.
  const out = path.join(tempDir, "render.png");
  expect((await invoke(["composition", "render", "poster", "--project", projDir, "--out", out, "--json"])).code).toBe(0);
  const png = decodePng(await readFile(out));
  // Outline ring, left of the content edge:
  expect(pixel(png, 48, 70)).toEqual([0, 0, 255, 255]);
  // Outline ring, above the content edge:
  expect(pixel(png, 100, 48)).toEqual([0, 0, 255, 255]);
  // Outline ring, right of the content edge:
  expect(pixel(png, 151, 70)).toEqual([0, 0, 255, 255]);
  // Inside the content footprint: content wins over the outline.
  expect(pixel(png, 100, 80)).toEqual([255, 0, 0, 255]);
  // Just past the outline: no ink.
  expect(pixel(png, 45, 70)[3]).toBe(0);
  expect(pixel(png, 155, 70)[3]).toBe(0);

  // ABSOLUTE setter: a later edit replaces the previous outline.
  const again = await invoke(["layer", "edit", layerId, "--outline", "2,#00ff00", "--project", projDir, "--json"]);
  expect(again.code).toBe(0);
  const againJson = JSON.parse(again.stdout);
  expect(againJson.layer.currentRevision.outline).toEqual({ width: 2, color: "#00ff00" });

  // --outline none removes the outline (field drops from the revision).
  const remove = await invoke(["layer", "edit", layerId, "--outline", "none", "--project", projDir, "--json"]);
  expect(remove.code).toBe(0);
  const removeJson = JSON.parse(remove.stdout);
  expect(removeJson.layer.currentRevision.outline).toBeUndefined();
  expect(removeJson.outlined).toEqual({ outline: null });

  // Removal restores the baseline paint: no ink left of the content.
  const afterOut = path.join(tempDir, "after.png");
  expect((await invoke(["composition", "render", "poster", "--project", projDir, "--out", afterOut, "--json"])).code).toBe(0);
  const after = decodePng(await readFile(afterOut));
  expect(pixel(after, 48, 70)[3]).toBe(0);

  // Inspect hides the removed outline and shows a set one.
  const setRes = await invoke(["layer", "edit", layerId, "--outline", "2,#00ff00", "--project", projDir, "--json"]);
  expect(setRes.code).toBe(0);
  const shownInspect = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(shownInspect.code).toBe(0);
  expect(shownInspect.stdout).toContain("Outline: 2 #00ff00");
  const rmRes = await invoke(["layer", "edit", layerId, "--outline", "none", "--project", projDir, "--json"]);
  expect(rmRes.code).toBe(0);
  const hiddenInspect = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(hiddenInspect.code).toBe(0);
  expect(hiddenInspect.stdout).not.toContain("Outline:");
});
/** Tracer 2: the outline applies to text glyph ink exactly as to image
 * alpha — a uniform bounded effect (DEC-006) — and the retained font bytes
 * are untouched. */
test("text Layer --outline paints at the glyph ink and keeps font bytes", async () => {
  await makeComp("doc", 400, 300);
  const addRes = await addTextLayer("doc", "heading", "Hi", { font: "Anton", fontSize: 60, x: 40, y: 60 });
  const layerId = addRes.use.layerId as string;
  const fontHash = addRes.layer.currentRevision.contentHash as string;

  const baseOut = path.join(tempDir, "text-base.png");
  expect((await invoke(["composition", "render", "doc", "--project", projDir, "--out", baseOut, "--json"])).code).toBe(0);
  const base = decodePng(await readFile(baseOut));

  const editRes = await invoke(["layer", "edit", layerId, "--outline", "4,#00ff00", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(0);
  const rev = JSON.parse(editRes.stdout).layer.currentRevision;
  expect(rev.contentHash).toBe(fontHash);
  expect(rev.outline).toEqual({ width: 4, color: "#00ff00" });
  const out = path.join(tempDir, "text-outline.png");
  expect((await invoke(["composition", "render", "doc", "--project", projDir, "--out", out, "--json"])).code).toBe(0);
  const png = decodePng(await readFile(out));
  let foundGreen = false;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const p = pixel(png, x, y);
      const b = pixel(base, x, y);
      if (p[3] > 0 && b[3] === 0 && p[1] === 255 && p[0] === 0 && p[2] === 0) {
        foundGreen = true;
      } else if (p[3] > 0 && b[3] === 0) {
        // Outline-only ink must be exactly the outline color — no stray ink.
        expect(p).toEqual([0, 255, 0, 255]);
      }
    }
  }
  expect(foundGreen).toBe(true);
});

/** Tracer 3: the documented ordering contract (ADR-0019) — the outline
 * paints BEFORE the shadow, so the shadow is cast from the outlined
 * composite; both map through the transform together and fade with
 * opacity. Outline 6 + shadow (12,12,0) on a 100×60 content at (100,100):
 * outline ink x ∈ [94,206), y ∈ [94,166) (content red on top); the shadow
 * is that composite shifted (12,12), painted BEHIND it. */
test("outline paints before the shadow; the shadow is cast from the outlined composite", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 100, y: 100 });
  const layerId = addRes.use.layerId as string;

  const editRes = await invoke([
    "layer", "edit", layerId, "--outline", "6,#00ff00", "--shadow", "12,12,0,#000000",
    "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);
  const rev = JSON.parse(editRes.stdout).layer.currentRevision;
  expect(rev.outline).toEqual({ width: 6, color: "#00ff00" });
  expect(rev.shadow).toEqual({ dx: 12, dy: 12, blur: 0, color: "#000000" });

  const out = path.join(tempDir, "combined.png");
  expect((await invoke(["composition", "render", "poster", "--project", projDir, "--out", out, "--json"])).code).toBe(0);
  const png = decodePng(await readFile(out));
  // Inside the content footprint: content wins over the outline.
  expect(pixel(png, 150, 130)).toEqual([255, 0, 0, 255]);
  // The outline ring: green, exactly 6px out (x = 205 is the last ring
  // pixel — the dilate reach is exact, no scallop; the shadow, shifted
  // (12,12), covers x ∈ [106,218) BEHIND the ring).
  expect(pixel(png, 205, 130)).toEqual([0, 255, 0, 255]);
  // Past the ring the shadow shows through: black.
  expect(pixel(png, 206, 130)).toEqual([0, 0, 0, 255]);
  expect(pixel(png, 100, 95)).toEqual([0, 255, 0, 255]);
  // Beyond the ring, the shadow shows: the outlined composite shifted
  // (12,12) covers x ∈ [106,218) — pixel (210,130) is shadow-only black.
  expect(pixel(png, 210, 130)).toEqual([0, 0, 0, 255]);
  // Above/left of the outlined composite the shadow (shifted down-right)
  // never reaches: outline ring at x ≤ 205 and y ≥ 94, so (100,93) and
  // (92,120) are past the ring with no shadow there.
  expect(pixel(png, 100, 93)[3]).toBe(0);
  expect(pixel(png, 92, 120)[3]).toBe(0);

  // Opacity fades outline AND shadow together.
  const op = await invoke(["layer", "edit", layerId, "--opacity", "0.5", "--project", projDir, "--json"]);
  expect(op.code).toBe(0);
  const fadedOut = path.join(tempDir, "faded.png");
  expect((await invoke(["composition", "render", "poster", "--project", projDir, "--out", fadedOut, "--json"])).code).toBe(0);
  const faded = decodePng(await readFile(fadedOut));
  expect(pixel(faded, 210, 130)[3]).toBeGreaterThan(0);
  expect(pixel(faded, 210, 130)[3]).toBeLessThan(255);

  // Rotate 90° clockwise: the local (12,12) shadow offset maps to (-12,+12)
  // — the shadow moves to the LEFT of and BELOW the rotated outlined
  // composite; the outline still hugs it exactly.
  const unrotOut = path.join(tempDir, "combined-unrot.png");
  expect((await invoke(["layer", "edit", layerId, "--opacity", "1", "--rotate", "0", "--project", projDir, "--json"])).code).toBe(0);
  expect((await invoke(["composition", "render", "poster", "--project", projDir, "--out", unrotOut, "--json"])).code).toBe(0);
  const rot = await invoke(["layer", "edit", layerId, "--rotate", "90", "--project", projDir, "--json"]);
  expect(rot.code).toBe(0);
  const rotOut = path.join(tempDir, "combined-rot.png");
  expect((await invoke(["composition", "render", "poster", "--project", projDir, "--out", rotOut, "--json"])).code).toBe(0);
  const rotated = decodePng(await readFile(rotOut));
  // Rotated composite paints x ∈ [34,106), y ∈ [94,206) (ink [94,206)×[94,166)
  // rotated 90° CW about (100,100)). The shadow is the composite offset
  // (-12,+12) in canvas space: x ∈ [22,94), y ∈ [106,218).
  expect(pixel(rotated, 30, 140)).toEqual([0, 0, 0, 255]); // shadow-only, left of composite
  expect(pixel(rotated, 35, 140)).toEqual([0, 255, 0, 255]); // outline ring
  expect(pixel(rotated, 110, 140)[3]).toBe(0); // right of composite: nothing
  expect(pixel(rotated, 60, 210)).toEqual([0, 0, 0, 255]); // below composite: shadow
});

/** Tracer 4: measurement's painted extents, canvas clipping, and the report
 * include the outline extent; the effects facts gain `outline` beside
 * `shadow`; compact text exposes the effective outline settings. */
test("measure includes the outline extent in painted bounds and clipping", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  // Fully on-canvas: outline 10 — ink is content ⊕ square(10):
  // x ∈ [40,160), y ∈ [40,120) → 120×80.
  const editRes = await invoke(["layer", "edit", layerId, "--outline", "10,#0000ff", "--project", projDir, "--json"]);
  expect(editRes.code).toBe(0);

  const measureRes = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  expect(measureRes.code).toBe(0);
  const layer = JSON.parse(measureRes.stdout).layers[0];
  expect(layer.effects).toEqual({ shadow: null, outline: { width: 10, color: "#0000ff" } });
  expect(layer.box).toEqual({ x: 50, y: 50, width: 100, height: 60 });
  expect(layer.painted).toEqual({ x: 40, y: 40, width: 120, height: 80 });
  expect(layer.paintedOnCanvas).toEqual({ x: 40, y: 40, width: 120, height: 80 });
  expect(layer.clipped).toBe(false);

  // Compact text exposes the effective outline settings.
  const textMeasure = await invoke(["composition", "measure", "poster", "--project", projDir]);
  expect(textMeasure.code).toBe(0);
  expect(textMeasure.stdout).toContain("outline 10 #0000ff");

  // An outlined Layer near the canvas edge: the ink is clipped and the
  // on-canvas footprint is judged against the PAINTED extent. Layer at
  // (330, 250), 100×60, outline 10: ink x ∈ [320,440), y ∈ [240,320);
  // canvas 400×300.
  const add2 = await addImageLayer("poster", "edge", redImg, { x: 330, y: 250 });
  const edgeId = add2.use.layerId as string;
  const edit2 = await invoke(["layer", "edit", edgeId, "--outline", "10,#0000ff", "--project", projDir, "--json"]);
  expect(edit2.code).toBe(0);
  const measure2 = await invoke(["composition", "measure", "poster", "edge", "--project", projDir, "--json"]);
  expect(measure2.code).toBe(0);
  const edge = JSON.parse(measure2.stdout).layers[0];
  expect(edge.painted).toEqual({ x: 320, y: 240, width: 120, height: 80 });
  expect(edge.paintedOnCanvas).toEqual({ x: 320, y: 240, width: 80, height: 60 });
  expect(edge.clipped).toBe(true);

  // A Layer without effects reports no outline either.
  const add3 = await addImageLayer("poster", "plain", redImg, { x: 0, y: 0 });
  expect(add3.use.layerId).toBeTruthy();
  const measure3 = await invoke(["composition", "measure", "poster", "plain", "--project", projDir, "--json"]);
  const plain = JSON.parse(measure3.stdout).layers[0];
  expect(plain.effects).toEqual({ shadow: null, outline: null });
  expect(plain.painted).toEqual({ x: 0, y: 0, width: 100, height: 60 });
});

/** Tracer 5: invalid outline settings fail before mutation — malformed
 * specs and out-of-range values are usage errors (exit 2) at the command
 * boundary, live state never advances, and scoped help documents
 * --outline. */
test("invalid outline settings fail before mutation", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));
  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;
  const inspect = async () => JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
  const revBefore = (await inspect()).layer.currentRevisionId;

  // Malformed specs: usage errors (exit 2).
  for (const bad of ["4", "4,#0000ff,2", "a,#000000", "-4,#000000", "4,#12345", "4,red", "256.5,#000000", ""]) {
    const res = await invoke(["layer", "edit", layerId, "--outline", bad, "--project", projDir, "--json"]);
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout).ok).toBe(false);
  }

  // Out-of-bounds width is refused at the command boundary through the
  // SAME parser the edit path uses.
  for (const bad of ["300,#000000"]) {
    const res = await invoke(["layer", "edit", layerId, "--outline", bad, "--project", projDir, "--json"]);
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout).ok).toBe(false);
  }

  // Live state unchanged after every refusal.
  const after = await inspect();
  expect(after.layer.currentRevisionId).toBe(revBefore);
  expect(after.layer.currentRevision.outline).toBeUndefined();

  // Scoped help documents --outline.
  const help = await invoke(["layer", "edit", "--help", "--project", projDir]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("--outline <spec>");
  expect(help.stdout).toContain('"none"');
});

/** Tracer 6: outline facts are Layer revision facts shared as a whole
 * (DEC-002): in-place edits carry them forward, forks isolate them,
 * cross-Project copies preserve them verbatim, and retained source bytes
 * never move. */
test("outline facts survive edits, forks, and cross-Project import", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("source", 400, 300);
  const addRes = await addImageLayer("source", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;
  const contentHash = addRes.layer.currentRevision.contentHash as string;

  const setRes = await invoke(["layer", "edit", layerId, "--outline", "5,#ff8800", "--project", projDir, "--json"]);
  expect(setRes.code).toBe(0);

  // A plain non-outline edit carries the outline forward.
  const moveRes = await invoke(["layer", "edit", layerId, "--x", "50", "--project", projDir, "--json"]);
  expect(moveRes.code).toBe(0);
  const moveJson = JSON.parse(moveRes.stdout);
  const outlinedRevId = moveJson.layer.currentRevisionId as string;
  expect(moveJson.layer.currentRevision.outline).toEqual({ width: 5, color: "#ff8800" });
  expect(moveJson.layer.currentRevision.contentHash).toBe(contentHash);
  // No outline option: no `outlined` report on this edit.
  expect(moveJson.outlined).toBeUndefined();

  // Fork: the forked Layer carries the outlined revision; the original keeps its own.
  await makeComp("forker", 400, 300);
  await invoke(["composition", "import", "forker", "source", "--project", projDir, "--json"]);
  const forkRes = await invoke([
    "layer", "edit", layerId, "--fork", "--composition", "forker", "--use", "hero",
    "--outline", "none", "--project", projDir, "--json",
  ]);
  expect(forkRes.code).toBe(0);
  const forkJson = JSON.parse(forkRes.stdout);
  expect(forkJson.fork.previousLayerId).toBe(layerId);
  expect(forkJson.layer.currentRevision.outline).toBeUndefined();
  expect(forkJson.layer.currentRevision.contentHash).toBe(contentHash);
  expect(forkJson.outlined).toEqual({ outline: null });
  const original = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
  expect(original.layer.currentRevisionId).toBe(outlinedRevId);
  expect(original.layer.currentRevision.outline).toEqual({ width: 5, color: "#ff8800" });

  // Cross-Project import: the destination revision preserves the outline verbatim.
  const otherProj = path.join(tempDir, "proj2");
  await invoke(["project", "init", otherProj, "--name", "outline-import-proj"]);
  await invoke(["composition", "create", "landing", "--width", "400", "--height", "300", "--project", otherProj, "--json"]);
  const importRes = await invoke([
    "composition", "import", "landing", "source", "--from-project", projDir, "--project", otherProj, "--json",
  ]);
  expect(importRes.code).toBe(0);
  const importedLayerId = JSON.parse(importRes.stdout).importedUses[0].layerId as string;
  const imported = JSON.parse((await invoke(["layer", "inspect", importedLayerId, "--project", otherProj, "--json"])).stdout);
  expect(imported.layer.currentRevision.outline).toEqual({ width: 5, color: "#ff8800" });
  expect(imported.layer.currentRevision.contentHash).toBe(contentHash);
  const copiedDoc = JSON.parse(
    await readFile(path.join(otherProj, "layers", `${importedLayerId}.revisions`, `${imported.layer.currentRevisionId}.json`), "utf8"),
  );
  expect(copiedDoc.outline).toEqual({ width: 5, color: "#ff8800" });
});

/** Tracer 7: outline revisions participate in pinned Render history — a
 * render made with an outline replays byte-identically from its pinned
 * revision after the outline is removed, and the unoutlined render replays
 * unchanged too (US-006, TEST-003). */
test("render history stays pinned across outline edits: replay is byte-identical", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;

  const firstOut = path.join(tempDir, "first.png");
  const firstRender = await invoke(["composition", "render", "poster", "--project", projDir, "--out", firstOut, "--json"]);
  expect(firstRender.code).toBe(0);
  const firstManifest = JSON.parse(firstRender.stdout).render.manifest as string;

  // Add an outline, render, then remove it: the outlined render's pinned
  // history must replay byte-identically after the removal.
  const setRes = await invoke(["layer", "edit", layerId, "--outline", "8,#000000", "--project", projDir, "--json"]);
  expect(setRes.code).toBe(0);
  const secondOut = path.join(tempDir, "second.png");
  const secondRender = await invoke(["composition", "render", "poster", "--project", projDir, "--out", secondOut, "--json"]);
  expect(secondRender.code).toBe(0);
  const secondManifest = JSON.parse(secondRender.stdout).render.manifest as string;

  const rmRes = await invoke(["layer", "edit", layerId, "--outline", "none", "--project", projDir, "--json"]);
  expect(rmRes.code).toBe(0);

  const secondReplay = path.join(tempDir, "replay2.png");
  const secondReplayRes = await invoke(["composition", "replay", secondManifest, "--project", projDir, "--out", secondReplay, "--json"]);
  expect(secondReplayRes.code).toBe(0);
  expect(await readFile(secondReplay)).toEqual(await readFile(secondOut));

  // The pre-outline render replays unchanged too, and the outlined render
  // genuinely differs from it.
  const firstReplay = path.join(tempDir, "replay1.png");
  const firstReplayRes = await invoke(["composition", "replay", firstManifest, "--project", projDir, "--out", firstReplay, "--json"]);
  expect(firstReplayRes.code).toBe(0);
  expect(await readFile(firstReplay)).toEqual(await readFile(firstOut));
  expect(await readFile(secondOut)).not.toEqual(await readFile(firstOut));

  // And removal restored the original paint: a fresh render matches the
  // pre-outline pixels.
  const afterOut = path.join(tempDir, "after.png");
  const afterRender = await invoke(["composition", "render", "poster", "--project", projDir, "--out", afterOut, "--json"]);
  expect(afterRender.code).toBe(0);
  expect(await readFile(afterOut)).toEqual(await readFile(firstOut));
});

/** Tracer 7: the outline field is appended to the revision hash only when
 * present — pre-#140 revision documents keep their exact ids, a malformed
 * stored outline is refused loudly at the one revision-reader boundary. */
test("hash compatibility: outline appended only when present; malformed stored outline refused", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(50, 50, RED));

  await makeComp("poster", 200, 200);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 5, y: 5 });
  const layerId = addRes.use.layerId as string;
  const revId = addRes.layer.currentRevisionId as string;
  const revFile = path.join(projDir, "layers", `${layerId}.revisions`, `${revId}.json`);

  // A #139-era document has scale/rotation/flip written explicitly and no
  // outline — that IS the pre-#140 shape. Its id is derived without it.
  const legacyDoc = JSON.parse(await readFile(revFile, "utf8")) as Record<string, unknown>;
  expect(legacyDoc.outline).toBeUndefined();
  expect(computeRevisionHash(legacyDoc as unknown as LayerImageRevision)).toBe(revId);

  // A malformed stored outline: present null is never a silent default.
  const withNull = JSON.parse(await readFile(revFile, "utf8")) as Record<string, unknown>;
  withNull.outline = null;
  await writeFile(revFile, JSON.stringify(withNull));
  const nullRes = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(nullRes.code).toBe(1);
  expect(JSON.parse(nullRes.stdout).error).toContain("outline must be an outline object");

  // A non-conformant object is malformed.
  const withBad = JSON.parse(await readFile(revFile, "utf8")) as Record<string, unknown>;
  withBad.outline = { width: 1 };
  await writeFile(revFile, JSON.stringify(withBad));
  const badRes = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(badRes.code).toBe(1);
  expect(JSON.parse(badRes.stdout).error).toContain("outline.");

  // And a valid outline fact changes the hash (an outline edit is a new revision).
  const withOutline = JSON.parse(await readFile(revFile, "utf8")) as Record<string, unknown>;
  withOutline.outline = { width: 4, color: "#000000" };
  expect(computeRevisionHash(withOutline as unknown as LayerImageRevision)).not.toBe(revId);
});

/** INT-2: effect colors canonicalize at the ONE ingestion boundary —
 * uppercase and 3-digit forms of the same paint collapse to the canonical
 * lowercase #RRGGBB, so case/shorthand variants cannot mint redundant
 * revisions; re-issuing an identical (post-canonicalization) outline is a
 * no-op too. */
test("outline colors canonicalize; an identical outline edit is a no-op", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));
  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;

  const setRes = await invoke(["layer", "edit", layerId, "--outline", "4,#0000FF", "--project", projDir, "--json"]);
  expect(setRes.code).toBe(0);
  const revId = JSON.parse(setRes.stdout).layer.currentRevisionId as string;
  expect(JSON.parse(setRes.stdout).layer.currentRevision.outline).toEqual({ width: 4, color: "#0000ff" });

  // The stored document holds the canonical form verbatim.
  const doc = JSON.parse(
    await readFile(path.join(projDir, "layers", `${layerId}.revisions`, `${revId}.json`), "utf8"),
  );
  expect(doc.outline).toEqual({ width: 4, color: "#0000ff" });

  // The 3-digit form of the same paint is the SAME outline: a no-op.
  const shorthand = await invoke(["layer", "edit", layerId, "--outline", "4,#0af".replace("0af", "00f"), "--project", projDir, "--json"]);
  expect(shorthand.code).toBe(0);
  expect(JSON.parse(shorthand.stdout).layer.currentRevisionId).toBe(revId);

  // Re-issuing the identical canonical outline is a no-op too.
  const again = await invoke(["layer", "edit", layerId, "--outline", "4,#0000ff", "--project", projDir, "--json"]);
  expect(again.code).toBe(0);
  expect(JSON.parse(again.stdout).layer.currentRevisionId).toBe(revId);

  // --outline none on an outlineless Layer is a no-op as well.
  const rm = await invoke(["layer", "edit", layerId, "--outline", "none", "--project", projDir, "--json"]);
  expect(rm.code).toBe(0);
  const removedId = JSON.parse(rm.stdout).layer.currentRevisionId as string;
  const rmAgain = await invoke(["layer", "edit", layerId, "--outline", "none", "--project", projDir, "--json"]);
  expect(rmAgain.code).toBe(0);
  expect(JSON.parse(rmAgain.stdout).layer.currentRevisionId).toBe(removedId);
});

/** INT-1 regression: outline AND shadow both paint BEFORE the canonical
 * transform, so the canvas-space effect extent is the COMBINED local reach
 * (outline width + |dx| + |dy| + 2·blur) scaled by the transform — the
 * reaches are additive, not max — or measurement's capture window silently
 * clips and painted extents disagree with the render. */
test("measure includes the scale-amplified combined outline+shadow extent: painted agrees with the render", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 500, 500);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 100, y: 100 });
  const layerId = addRes.use.layerId as string;

  // Scale 3× (effective 300×180) then outline 10 + shadow (10,0,0):
  // Scale 3× (effective 300×180) then outline 10 + shadow (10,0,0):
  // combined local reach is 10 + 10 = 20 → canvas reach 60 (additive).
  // Content ink [100,400)×[100,280); local ink = [-10,120)×[-10,70)
  // (outline ⊕ square(10); the shadow (10,0) shifts it in x only);
  // canvas x ∈ [70,460), y ∈ [70,310).
  const scaleRes = await invoke(["layer", "edit", layerId, "--resize", "3", "--project", projDir, "--json"]);
  expect(scaleRes.code).toBe(0);
  const effectRes = await invoke([
    "layer", "edit", layerId, "--outline", "10,#000000", "--shadow", "10,0,0,#000000", "--project", projDir, "--json",
  ]);
  expect(effectRes.code).toBe(0);

  const measureRes = await invoke(["composition", "measure", "poster", "hero", "--project", projDir, "--json"]);
  expect(measureRes.code).toBe(0);
  const layer = JSON.parse(measureRes.stdout).layers[0];
  expect(layer.box).toEqual({ x: 100, y: 100, width: 300, height: 180 });
  expect(layer.painted).toEqual({ x: 70, y: 70, width: 390, height: 240 });
  expect(layer.paintedOnCanvas).toEqual({ x: 70, y: 70, width: 390, height: 240 });
  expect(layer.clipped).toBe(false);

  // Measurement/render agreement: the rendered PNG's actual ink support is
  // exactly the reported painted extent (blur 0 — sharp edges).
  const out = path.join(tempDir, "scaled-effects.png");
  expect((await invoke(["composition", "render", "poster", "--project", projDir, "--out", out, "--json"])).code).toBe(0);
  const png = decodePng(await readFile(out));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (pixel(png, x, y)[3] > 0) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  expect({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }).toEqual(layer.painted);
});

/** Anchored placement resolves against the OUTLINE-EXTENDED painted ink and
 * --anchor cannot combine with --outline in one edit (the reference ink
 * would be ambiguous) — the shadow precedent (ADR-0017). */
test("anchored placement uses the outline-extended ink; --anchor and --outline are separate edits", async () => {
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

  // Outline 10: subject ink [30,70), outlined ink [20,80) x [20,80) —
  // width 60.
  const setOutline = await invoke(["layer", "edit", layerId, "--outline", "10,#000000", "--project", projDir, "--json"]);
  expect(setOutline.code).toBe(0);

  // Anchor left edge of the painted ink at x=100: the outlined ink starts
  // 10px before the placement point, so left-edge anchoring publishes
  // x = 110 against the OUTLINE-EXTENDED ink [20, 80) — width 60, not the
  // bare 40-wide subject ink — measured at the pre-edit placement.
  const anchorRes = await invoke([
    "layer", "edit", layerId, "--anchor", "left", "--x", "100", "--project", projDir, "--json",
  ]);
  expect(anchorRes.code).toBe(0);
  const anchored = JSON.parse(anchorRes.stdout);
  expect(anchored.anchored.painted.width).toBe(60);
  expect(anchored.anchored.painted.x).toBe(20);
  expect(anchored.anchored.placement.x).toBe(110);

  // After the edit, the outline-extended ink's left edge sits at x = 100.
  const measure = await invoke(["composition", "measure", "poster", "hero", "--project", projDir, "--json"]);
  expect(measure.code).toBe(0);
  const measured = JSON.parse(measure.stdout).layers[0];
  expect(measured.painted).toEqual({ x: 100, y: 20, width: 60, height: 60 });

  // --anchor + --outline in one edit refuses (exit 2, live state unchanged).
  const conflict = await invoke([
    "layer", "edit", layerId, "--anchor", "left", "--x", "50", "--outline", "4,#ff0000", "--project", projDir, "--json",
  ]);
  expect(conflict.code).toBe(2);
  expect(JSON.parse(conflict.stdout).ok).toBe(false);
  const state = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
  expect(state.layer.currentRevision.x).toBe(110);
  expect(state.layer.currentRevision.outline).toEqual({ width: 10, color: "#000000" });
});
