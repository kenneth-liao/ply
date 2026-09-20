/**
 * The visible region's optional corner radius (#212, spec #207 US-003,
 * ADR-0023).
 *
 * Verifies through the public CLI seam and the rendered-pixel seam:
 * - `--visible-region-radius <px>` rounds the visible region's corners as an
 *   ABSOLUTE setter that edits and removes INDEPENDENTLY of the rectangle
 *   (`none` or `0` removes it; the same command twice is a no-op). It is
 *   stored on the SAME revision fact (`visibleRegion.cornerRadius`, present
 *   only when set and > 0), and the revision hash appends it only when
 *   present, so pre-#212 revision ids do not move.
 * - Corner pixels outside the radius are transparent; the outline and the
 *   shadow follow the rounded edge; painted extents stay the rectangle's.
 * - A negative radius is refused at the command boundary (exit 2); a radius
 *   larger than half the region rectangle's shorter side is REFUSED, never
 *   clamped — the same rule as a shape Layer's --corner-radius, through the
 *   same validator — before publication, live state unchanged. A radius
 *   without a visible region is refused; removing the region removes its
 *   radius.
 * - Set-then-remove renders byte-identically (ISC-38); a Render with a
 *   rounded region replays byte-identically.
 * - One-command `composition add` accepts the radius with the region; the
 *   radius alone on a fresh Layer is refused before anything is published.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { computeRevisionHash, normalizeStoredVisibleRegion } from "../src/layer.js";
import { decodePng, encodePngRgba } from "../src/png.js";

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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-region-radius-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "region-radius-proj"]);
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

async function inspect(layerId: string) {
  const res = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).layer;
}

/** Tracer 1: the radius is an absolute setter on the SAME revision fact,
 * editing and removing independently of the rectangle — a radius-only edit
 * moves the revision, an identical re-set is a no-op, `none` (and `0`)
 * remove it, removing the region removes its radius, and set-then-remove
 * renders byte-identically to the rectangle-only render (ISC-38). */
test("radius sets, edits, and removes independently of the rectangle; set-then-remove is byte-identical", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(200, 100, RED));
  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 30, y: 40 });
  const layerId = addRes.use.layerId as string;

  expect((await invoke(["layer", "edit", layerId, "--visible-region", "20,10,80,40", "--project", projDir])).code).toBe(0);
  const rectOnly = await render("poster", path.join(tempDir, "rect-only.png"));
  const rectRevId = JSON.parse(
    (await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout,
  ).layer.currentRevisionId as string;

  // Set the radius: a new revision on the same fact, rectangle unchanged.
  const setRes = await invoke([
    "layer", "edit", layerId, "--visible-region-radius", "12", "--project", projDir, "--json",
  ]);
  expect(setRes.code).toBe(0);
  const setJson = JSON.parse(setRes.stdout);
  expect(setJson.regionSet).toEqual({
    visibleRegion: { x: 20, y: 10, width: 80, height: 40, cornerRadius: 12 },
  });
  expect(setJson.layer.currentRevisionId).not.toBe(rectRevId);

  // An identical re-set is a detected no-op: the same revision id.
  const noopRes = await invoke([
    "layer", "edit", layerId, "--visible-region-radius", "12", "--project", projDir, "--json",
  ]);
  expect(noopRes.code).toBe(0);
  expect(JSON.parse(noopRes.stdout).layer.currentRevisionId).toBe(setJson.layer.currentRevisionId);

  // Removing the radius (either documented value) restores the rectangle-only
  // fact — and the rectangle-only render, byte-for-byte.
  const removeRes = await invoke([
    "layer", "edit", layerId, "--visible-region-radius", "none", "--project", projDir, "--json",
  ]);
  expect(removeRes.code).toBe(0);
  expect(JSON.parse(removeRes.stdout).regionSet).toEqual({
    visibleRegion: { x: 20, y: 10, width: 80, height: 40 },
  });
  expect((await render("poster", path.join(tempDir, "radius-removed.png"))).equals(rectOnly)).toBe(true);

  // `0` is the same no-rounding form.
  expect((await invoke(["layer", "edit", layerId, "--visible-region-radius", "0", "--project", projDir, "--json"])).code).toBe(0);
  expect(
    JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout).layer.currentRevision.visibleRegion,
  ).toEqual({ x: 20, y: 10, width: 80, height: 40 });

  // The radius edits independently of the rectangle — and the rectangle
  // re-set keeps the radius (an omitted option preserves it).
  expect((await invoke(["layer", "edit", layerId, "--visible-region-radius", "12", "--project", projDir])).code).toBe(0);
  const reRectRes = await invoke([
    "layer", "edit", layerId, "--visible-region", "20,10,80,40", "--project", projDir, "--json",
  ]);
  expect(reRectRes.code).toBe(0);
  expect(
    JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout).layer.currentRevision.visibleRegion,
  ).toEqual({ x: 20, y: 10, width: 80, height: 40, cornerRadius: 12 });

  // Removing the region removes its radius: re-setting a fresh rectangle
  // does not resurrect it.
  expect((await invoke(["layer", "edit", layerId, "--visible-region", "none", "--project", projDir])).code).toBe(0);
  expect(
    JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout).layer.currentRevision.visibleRegion,
  ).toBeUndefined();
  expect((await invoke(["layer", "edit", layerId, "--visible-region", "20,10,80,40", "--project", projDir])).code).toBe(0);
  expect(
    JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout).layer.currentRevision.visibleRegion,
  ).toEqual({ x: 20, y: 10, width: 80, height: 40 });

  // And set-then-remove-region still renders byte-identically to never-set.
  expect((await render("poster", path.join(tempDir, "after-region-remove.png"))).equals(rectOnly)).toBe(true);
}, 30000);

/** Tracer 2: corner pixels outside the radius are transparent, edge midpoints
 * stay ink, and the painted extents stay the RECTANGLE's (measure reports the
 * radius in the region facts). */
test("rounded corners are transparent and painted extents stay the rectangle's", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(200, 100, RED));
  await makeComp("poster", 400, 300);
  // Image at (30,40); region 20,10,80,40 → ink rect on canvas x 50..130, y 50..90.
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 30, y: 40 });
  const layerId = addRes.use.layerId as string;
  expect((await invoke(["layer", "edit", layerId, "--visible-region", "20,10,80,40", "--visible-region-radius", "12", "--project", projDir])).code).toBe(0);

  const png = decodePng(await render("poster", path.join(tempDir, "rounded.png")));
  // The top-left corner arc centers at (62,62) with radius 12: the sharp
  // rect corner and its surroundings are transparent...
  expect(pixel(png, 50, 50)[3]).toBe(0);
  expect(pixel(png, 51, 51)[3]).toBe(0);
  // ...while points inside the arc and the edge midpoints are ink.
  expect(pixel(png, 56, 56)).toEqual([255, 0, 0, 255]);
  expect(pixel(png, 90, 50)).toEqual([255, 0, 0, 255]);
  expect(pixel(png, 90, 89)).toEqual([255, 0, 0, 255]);
  expect(pixel(png, 129, 70)).toEqual([255, 0, 0, 255]);
  // Just outside the rectangle (straight edges): still no ink.
  expect(pixel(png, 49, 70)[3]).toBe(0);
  expect(pixel(png, 90, 49)[3]).toBe(0);

  const measureRes = JSON.parse(
    (await invoke(["composition", "measure", "poster", "hero", "--project", projDir, "--json"]).then(r => { expect(r.code).toBe(0); return r.stdout; })),
  ).layers[0];
  // The radius rides the reported region facts...
  expect(measureRes.visibleRegion).toEqual({ x: 20, y: 10, width: 80, height: 40, cornerRadius: 12 });
  // ...but the painted extents stay the rectangle's (the rounded corners
  // never shrink the ink's bounding box).
  expect(measureRes.painted).toEqual({ x: 50, y: 50, width: 80, height: 40 });
  expect(measureRes.paintedOnCanvas).toEqual({ x: 50, y: 50, width: 80, height: 40 });
  expect(measureRes.clipped).toBe(false);
}, 30000);

/** Tracer 3: the outline and the shadow each follow the ROUNDED edge — the
 * ring bends around the corner arc, and neither paints where the square
 * corner would have put it. Outline-only and shadow-only renders keep the
 * pixel assertions unambiguous. */
test("outline and shadow follow the rounded edge", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(200, 100, RED));
  await makeComp("poster", 400, 300);
  // Ink rect on canvas x 50..130, y 50..90; corner arc center (62,62), r 12.
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 30, y: 40 });
  const layerId = addRes.use.layerId as string;
  expect((await invoke(["layer", "edit", layerId, "--visible-region", "20,10,80,40", "--visible-region-radius", "12", "--project", projDir])).code).toBe(0);

  // The outline alone: the ring hugs the straight edges exactly as without
  // the radius...
  expect((await invoke(["layer", "edit", layerId, "--outline", "4,#00ff00", "--project", projDir])).code).toBe(0);
  const outlinePng = decodePng(await render("poster", path.join(tempDir, "outlined.png")));
  expect(pixel(outlinePng, 90, 48)).toEqual([0, 255, 0, 255]);
  expect(pixel(outlinePng, 48, 70)).toEqual([0, 255, 0, 255]);
  // ...and BENDS around the corner: a point on the diagonal 2px inside the
  // arc band (distance 14 from the arc center; the 4px dilate spans
  // 12..16) is ring, while the square corner's diagonal (distance 19.8,
  // beyond the dilated arc and its antialiasing) is transparent.
  expect(pixel(outlinePng, 52, 52)).toEqual([0, 255, 0, 255]);
  expect(pixel(outlinePng, 48, 48)[3]).toBe(0);

  // The shadow alone (offset -6,-6 toward the corner, blur 0): a point whose
  // shadow source (offset +6,+6 back) lies inside the arc is blue shadow;
  // one whose source lies in the square corner's notch is empty — the
  // shadow follows the rounded edge, not the square corner.
  expect((await invoke(["layer", "edit", layerId, "--outline", "none", "--shadow", "-6,-6,0,#0000ff", "--project", projDir])).code).toBe(0);
  const shadowPng = decodePng(await render("poster", path.join(tempDir, "shadowed.png")));
  expect(pixel(shadowPng, 49, 49)).toEqual([0, 0, 255, 255]);
  expect(pixel(shadowPng, 46, 46)[3]).toBe(0);
  expect(pixel(shadowPng, 44, 70)).toEqual([0, 0, 255, 255]);
}, 30000);

/** Tracer 4: the refusal matrix — a negative radius is refused at the
 * command boundary (exit 2); a radius over half the shorter side is REFUSED,
 * never clamped (the shape Layer's one rule, exit 1); a radius without a
 * visible region, and a radius combined with the region's removal, are
 * refused before publication — live state unchanged in every case. */
test("radius refusals leave live state unchanged", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(200, 100, RED));
  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 30, y: 40 });
  const layerId = addRes.use.layerId as string;
  const baseRevId = addRes.layer.currentRevisionId as string;
  expect((await invoke(["layer", "edit", layerId, "--visible-region", "20,10,80,40", "--project", projDir])).code).toBe(0);
  const revId = JSON.parse(
    (await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout,
  ).layer.currentRevisionId as string;

  // Negative radius: refused at the boundary as a usage error.
  const negRes = await invoke(["layer", "edit", layerId, "--visible-region-radius", "-4", "--project", projDir, "--json"]);
  expect(negRes.code).toBe(2);
  expect(JSON.parse(negRes.stdout).error).toMatch(/must be a finite number of px >= 0/);

  // Over half the shorter side (min(80,40)/2 = 20): refused, never clamped,
  // naming the range — the shape Layer's corner-radius rule.
  const bigRes = await invoke(["layer", "edit", layerId, "--visible-region-radius", "20.5", "--project", projDir, "--json"]);
  expect(bigRes.code).toBe(1);
  expect(JSON.parse(bigRes.stdout).error).toContain("between 0 and 20");

  // A radius without a visible region: refused, naming the fix.
  const noRegionRes = await invoke([
    "layer", "edit", layerId, "--visible-region", "none", "--project", projDir,
    "--json",
  ]);
  expect(noRegionRes.code).toBe(0);
  const orphanRes = await invoke(["layer", "edit", layerId, "--visible-region-radius", "8", "--project", projDir, "--json"]);
  expect(orphanRes.code).toBe(1);
  expect(JSON.parse(orphanRes.stdout).error).toMatch(/no visible region/);

  // A radius combined with removing the region: refused — the radius has no
  // region to round.
  expect((await invoke(["layer", "edit", layerId, "--visible-region", "20,10,80,40", "--project", projDir])).code).toBe(0);
  const removeWithRadius = await invoke([
    "layer", "edit", layerId, "--visible-region", "none", "--visible-region-radius", "8", "--project", projDir, "--json",
  ]);
  expect(removeWithRadius.code).toBe(1);

  // Every refusal left the live revision exactly where the last accepted
  // edit put it — and the radius never published.
  const after = JSON.parse(
    (await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout,
  ).layer;
  expect(after.currentRevisionId).not.toBe(baseRevId);
  expect(after.currentRevision.visibleRegion).toEqual({ x: 20, y: 10, width: 80, height: 40 });
}, 30000);

/** Tracer 5: one-command add sets rectangle and radius in one command; a
 * radius alone on a fresh Layer is refused before anything is published. */
test("composition add sets the rounded region and refuses a radius without a region", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(200, 100, RED));
  await makeComp("poster", 400, 300);

  const addRes = await invoke([
    "composition", "add", "poster", "hero", "--image", redImg, "--x", "30", "--y", "40",
    "--visible-region", "20,10,80,40", "--visible-region-radius", "12", "--project", projDir, "--json",
  ]);
  expect(addRes.code).toBe(0);
  expect(JSON.parse(addRes.stdout).layer.currentRevision.visibleRegion).toEqual({
    x: 20, y: 10, width: 80, height: 40, cornerRadius: 12,
  });

  // Radius alone on a fresh Layer: refused, nothing published.
  const before = JSON.parse(
    (await invoke(["composition", "measure", "poster", "--project", projDir, "--json"])).stdout,
  ).layers.length;
  const orphanRes = await invoke([
    "composition", "add", "poster", "roundless", "--image", redImg, "--visible-region-radius", "8", "--project", projDir, "--json",
  ]);
  expect(orphanRes.code).toBe(1);
  expect(JSON.parse(orphanRes.stdout).error).toMatch(/--visible-region-radius/);
  const after = JSON.parse(
    (await invoke(["composition", "measure", "poster", "--project", projDir, "--json"])).stdout,
  ).layers.length;
  expect(after).toBe(before);
}, 30000);

/** Tracer 6: the revision hash appends the radius only when present — a
 * region without a radius hashes to exactly its pre-#212 id — and the stored
 * normalizer refuses a malformed or out-of-range stored radius. */
test("hash conditionality and the stored-radius normalizer", () => {
  // The revision hash appends the radius only when present: the radius-less
  // region keeps the exact pre-#212 encoding, and setting the radius moves
  // the id.
  const base = {
    layerId: "lay_1", kind: "image", contentHash: "abc", x: 0, y: 0, opacity: 1, createdAt: "t",
  } as unknown as Parameters<typeof computeRevisionHash>[0];
  const withRect = { ...base, visibleRegion: { x: 1, y: 2, width: 3, height: 4 } };
  const withRounded = { ...base, visibleRegion: { x: 1, y: 2, width: 3, height: 4, cornerRadius: 12 } };
  expect(computeRevisionHash(withRounded)).not.toBe(computeRevisionHash(withRect));
  // Dropping the radius again restores the exact radius-less id.
  const { cornerRadius: _dropped, ...radiusLess } = withRounded.visibleRegion as Record<string, unknown>;
  expect(computeRevisionHash({ ...base, visibleRegion: radiusLess } as unknown as typeof withRect)).toBe(
    computeRevisionHash(withRect),
  );

  // The stored normalizer: a valid radius passes through; malformed or
  // out-of-range stored values are refused loudly.
  expect(normalizeStoredVisibleRegion({ visibleRegion: { x: 0, y: 0, width: 80, height: 40, cornerRadius: 12 } }))
    .toEqual({ x: 0, y: 0, width: 80, height: 40, cornerRadius: 12 });
  expect(normalizeStoredVisibleRegion({ visibleRegion: { x: 0, y: 0, width: 80, height: 40 } }))
    .toEqual({ x: 0, y: 0, width: 80, height: 40 });
  for (const bad of [0, -4, 20.5, "12", Number.NaN]) {
    expect(() =>
      normalizeStoredVisibleRegion({ visibleRegion: { x: 0, y: 0, width: 80, height: 40, cornerRadius: bad } }),
    ).toThrow();
  }
});

/** Tracer 7: a Render with a rounded region replays byte-identically, and a
 * kept radius rides a content edit's regionCarried report. */
test("a rounded-region Render replays byte-identically and a content edit carries the radius", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(200, 100, RED));
  const greenImg = path.join(tempDir, "green.png");
  await writeFile(greenImg, solidPng(300, 200, [0, 200, 0, 255]));
  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 30, y: 40 });
  const layerId = addRes.use.layerId as string;
  expect((await invoke(["layer", "edit", layerId, "--visible-region", "20,10,80,40", "--visible-region-radius", "12", "--project", projDir])).code).toBe(0);

  const original = await render("poster", path.join(tempDir, "original.png"));
  const manifestPath = JSON.parse(
    (await invoke(["composition", "render", "poster", "--out", path.join(tempDir, "manifest-probe.png"), "--project", projDir, "--json"]).then(r => { expect(r.code).toBe(0); return r.stdout; })),
  ).render.manifest as string;

  // A later edit advances the live Layer; replay regenerates the pinned
  // rounded-region render byte-identically.
  expect((await invoke(["layer", "edit", layerId, "--shadow", "4,4,2,#000000", "--project", projDir])).code).toBe(0);
  expect((await render("poster", path.join(tempDir, "after-edits.png"))).equals(original)).toBe(false);
  const replayRes = await invoke([
    "composition", "replay", manifestPath, "--out", path.join(tempDir, "replayed.png"), "--project", projDir, "--json",
  ]);
  expect(replayRes.code).toBe(0);
  expect((await readFile(path.join(tempDir, "replayed.png"))).equals(original)).toBe(true);

  // A content edit that keeps the region carries the radius with it.
  const replaceRes = await invoke([
    "layer", "edit", layerId, "--image", greenImg, "--project", projDir, "--json",
  ]);
  expect(replaceRes.code).toBe(0);
  const carried = JSON.parse(replaceRes.stdout).regionCarried;
  expect(carried).toEqual({ visibleRegion: { x: 20, y: 10, width: 80, height: 40, cornerRadius: 12 } });
  expect(
    JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout).layer.currentRevision.visibleRegion,
  ).toEqual({ x: 20, y: 10, width: 80, height: 40, cornerRadius: 12 });

  // Re-setting the rectangle smaller than the kept radius fits is refused:
  // min(30,20)/2 = 10 < 12.
  const shrinkRes = await invoke([
    "layer", "edit", layerId, "--visible-region", "20,10,30,20", "--project", projDir, "--json",
  ]);
  expect(shrinkRes.code).toBe(1);
  expect(JSON.parse(shrinkRes.stdout).error).toContain("between 0 and 10");
}, 60000);

/** Tracer 7b: a fork carries the rounded region (the fact is shared as a
 * whole, DEC-002). */
test("forks carry the rounded region", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(200, 100, RED));
  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 30, y: 40 });
  const layerId = addRes.use.layerId as string;
  const forkRes = await invoke([
    "layer", "edit", layerId, "--visible-region", "20,10,80,40", "--visible-region-radius", "12",
    "--fork", "--composition", "poster", "--use", "hero", "--project", projDir, "--json",
  ]);
  expect(forkRes.code).toBe(0);
  expect(JSON.parse(forkRes.stdout).layer.currentRevision.visibleRegion).toEqual({
    x: 20, y: 10, width: 80, height: 40, cornerRadius: 12,
  });
}, 30000);

/** Help documents the radius on both surfaces: the flag, the removal value,
 * and the refuse-never-clamp rule (the shape Layer's one corner-radius
 * rule). */
test("help documents the corner-radius rule", async () => {
  const editHelp = await invoke(["layer", "edit", "--help"]);
  expect(editHelp.stdout).toContain("--visible-region-radius");
  expect(editHelp.stdout).toMatch(/shorter side|half the/);
  expect(editHelp.stdout).toMatch(/clamped/);
  const addHelp = await invoke(["composition", "add", "--help"]);
  expect(addHelp.stdout).toContain("--visible-region-radius");
});