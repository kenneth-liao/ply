/**
 * Anchored Layer placement (#138, spec #132 US-002 / US-006, DEC-002/003/004,
 * ADR-0017).
 *
 * Verifies through the public CLI seam:
 * - `ply layer edit --anchor <h>[,<v>] --x <tx> --y <ty>` places image and
 *   text Layers so their VISIBLE PAINTED INK lands at the requested target:
 *   the anchor box is the painted ink box (#137), never the layout content
 *   box — transparent padding does not count.
 * - Anchored placement is a ONE-SHOT resolution into plain canonical
 *   placement (x, y) at the command boundary (ADR-0017): no anchor facts are
 *   persisted, no revision schema changes, and the edit flows through the
 *   ordinary in-place/fork lifecycle — sharing, forks, cross-Project import,
 *   and pinned Render history preserve the resolved placement verbatim.
 * - Resolution runs against the Layer's current transform and each referring
 *   Composition's rendering geometry; divergent geometry across referring
 *   Compositions refuses with the affected compositions named, and no-ink
 *   Layers refuse — both without mutating live state.
 * - Invalid or conflicting inputs are usage errors (exit 2) that leave live
 *   state unchanged; help, compact text, and valid --json follow US-004.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePngRgba, decodePng } from "../src/png.js";
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

const RED: [number, number, number, number] = [255, 0, 0, 255];

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

/** A solid image whose visible (alpha > 0) pixels occupy only `region` — transparent padding elsewhere. */
function regionPng(
  width: number,
  height: number,
  rgba: [number, number, number, number],
  region: { x: number; y: number; width: number; height: number },
): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;
      const i = (y * width + x) * 4;
      buf[i] = rgba[0]!;
      buf[i + 1] = rgba[1]!;
      buf[i + 2] = rgba[2]!;
      buf[i + 3] = inside ? rgba[3]! : 0;
    }
  }
  return encodePngRgba(width, height, buf);
}

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-anchor-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "anchor-test-proj"]);
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

async function measure(comp: string) {
  const res = await invoke(["composition", "measure", comp, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

/** The measured report entry for one Layer use. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function useReport(measured: any, name: string): any {
  const found = measured.layers.find((l: { name: string }) => l.name === name);
  expect(found).toBeDefined();
  return found;
}

/** Tracer 1: centered anchored placement lands a plain image's painted ink at the requested target. */
test("image Layer --anchor center,center resolves placement so the painted ink centers on the target", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;

  const editRes = await invoke([
    "layer", "edit", layerId, "--anchor", "center,center", "--x", "200", "--y", "150", "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.ok).toBe(true);

  // One-shot resolution into plain placement: a new revision whose only
  // change is x/y — no persisted anchor facts, no schema change.
  expect(editJson.layer.currentRevisionId).not.toBe(oldRevId);
  const rev = editJson.layer.currentRevision;
  expect(rev.x).toBe(150); // 200 - 100/2
  expect(rev.y).toBe(120); // 150 - 60/2
  expect(rev.scaleX).toBe(1);
  expect(rev.scaleY).toBe(1);
  expect(rev.rotationDeg).toBe(0);
  expect(Object.keys(rev).sort()).toEqual(
    ["bytes", "contentHash", "createdAt", "flipX", "flipY", "format", "height", "kind", "layerId", "opacity", "revisionId", "rotationDeg", "scaleX", "scaleY", "schemaVersion", "width", "x", "y"],
  );

  // Auditable anchor report: what was asked, what was resolved, and the
  // measured ink evidence from the resolution context.
  expect(editJson.anchored).toEqual({
    anchor: { horizontal: "center", vertical: "center" },
    target: { x: 200, y: 150 },
    placement: { x: 150, y: 120 },
    painted: { x: 10, y: 10, width: 100, height: 60 },
    contexts: ["poster"],
  });

  // The ink demonstrably lands at the requested target: post-edit
  // measurement reports the painted box centered on (200, 150).
  const after = useReport(await measure("poster"), "hero");
  expect(after.painted).toEqual({ x: 150, y: 120, width: 100, height: 60 });
  expect(after.placement).toEqual({ x: 150, y: 120, opacity: 1 });

  // Compact text carries the anchor resolution summary.
  const textRes = await invoke([
    "layer", "edit", layerId, "--anchor", "center,center", "--x", "200", "--y", "150", "--project", projDir,
  ]);
  expect(textRes.code).toBe(0);
  expect(textRes.stdout).toContain("anchored center,center at (200, 150)");
  expect(textRes.stdout).toContain("(150, 120)");
});

/** Tracer 1b: the render agrees with the resolution — the painted ink really
 * shows at the requested target in the rendered pixels. */
test("rendered pixels agree with the anchored resolution", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
  const layerId = addRes.use.layerId as string;

  const editRes = await invoke([
    "layer", "edit", layerId, "--anchor", "center,center", "--x", "200", "--y", "150", "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);

  const renderRes = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(renderRes.code).toBe(0);
  const renderJson = JSON.parse(renderRes.stdout);
  const png = decodePng(await readFile(renderJson.render.output));
  expect(png.width).toBe(400);
  expect(png.height).toBe(300);
  const px = (x: number, y: number): [number, number, number, number] => {
    const i = (y * png.width + x) * 4;
    return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
  };
  // Ink spans (150, 120)-(250, 180): corners red, edges transparent.
  expect(px(150, 120)).toEqual([255, 0, 0, 255]);
  expect(px(249, 179)).toEqual([255, 0, 0, 255]);
  expect(px(149, 150)).toEqual([0, 0, 0, 0]);
  expect(px(250, 150)).toEqual([0, 0, 0, 0]);
});
/** Tracer 2: the full horizontal × vertical anchor matrix on image Layers —
 * every required combination lands the ink edge/center at the target. */
test(
  "the horizontal x vertical anchor matrix lands image ink at each requested target",
  async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(80, 40, RED));

  await makeComp("poster", 400, 300);
  // One Layer per combination, all in one Composition (measurement of one
  // Layer never depends on its neighbors).
  const combos: { anchor: string; tx: number; ty: number; want: { x: number; y: number } }[] = [
    { anchor: "left,top", tx: 100, ty: 100, want: { x: 100, y: 100 } },
    { anchor: "center,top", tx: 200, ty: 100, want: { x: 160, y: 100 } },
    { anchor: "right,top", tx: 300, ty: 100, want: { x: 220, y: 100 } },
    { anchor: "left,center", tx: 100, ty: 150, want: { x: 100, y: 130 } },
    { anchor: "center,center", tx: 200, ty: 150, want: { x: 160, y: 130 } },
    { anchor: "right,center", tx: 300, ty: 150, want: { x: 220, y: 130 } },
    { anchor: "left,bottom", tx: 100, ty: 200, want: { x: 100, y: 160 } },
    { anchor: "center,bottom", tx: 200, ty: 200, want: { x: 160, y: 160 } },
    { anchor: "right,bottom", tx: 300, ty: 200, want: { x: 220, y: 160 } },
  ];
  for (const [i, combo] of combos.entries()) {
    const addRes = await addImageLayer("poster", `m${i}`, redImg, { x: 0, y: 0 });
    const layerId = addRes.use.layerId as string;
    const editRes = await invoke([
      "layer", "edit", layerId, "--anchor", combo.anchor, "--x", String(combo.tx), "--y", String(combo.ty),
      "--project", projDir, "--json",
    ]);
    expect(editRes.code).toBe(0);
    const editJson = JSON.parse(editRes.stdout);
    expect(editJson.anchored.placement).toEqual(combo.want);
    const after = useReport(await measure("poster"), `m${i}`);
    expect(after.painted).toEqual({ x: combo.want.x, y: combo.want.y, width: 80, height: 40 });
  }
  },
  240_000,
);

/** Tracer 3: the anchor box is the PAINTED INK box, never the layout content
 * box — transparent padding does not count, so a padded image's visible
 * subject lands at the target while its layout box extends into the padding. */
test(
  "a padded image's visible ink (not its transparent padding) lands at the target",
  async () => {
    // 100×60 content whose visible ink occupies only (30, 20)-(70, 40):
    // 30px left padding, 20px top, 30px right, 20px bottom.
    const padImg = path.join(tempDir, "padded.png");
    await writeFile(padImg, regionPng(100, 60, RED, { x: 30, y: 20, width: 40, height: 20 }));

    await makeComp("poster", 400, 300);
    const addRes = await addImageLayer("poster", "hero", padImg, { x: 10, y: 10 });
    const layerId = addRes.use.layerId as string;

    const editRes = await invoke([
      "layer", "edit", layerId, "--anchor", "center,center", "--x", "200", "--y", "150", "--project", projDir, "--json",
    ]);
    expect(editRes.code).toBe(0);
    const editJson = JSON.parse(editRes.stdout);

    // Resolved placement: ink center (not content center) at the target.
    // Ink offset from the placement point is (30, 20), ink is 40×20.
    expect(editJson.anchored.placement).toEqual({ x: 150, y: 120 });
    expect(editJson.anchored.painted).toEqual({ x: 40, y: 30, width: 40, height: 20 });

    // Post-edit measurement proves the documented consequence: the visible
    // ink centers on (200, 150) while the layout content box (100×60,
    // padding included) extends into the padding side.
    const after = useReport(await measure("poster"), "hero");
    expect(after.painted).toEqual({ x: 180, y: 140, width: 40, height: 20 });
    expect(after.box).toEqual({ x: 150, y: 120, width: 100, height: 60 });
    expect(after.content).toEqual({ width: 100, height: 60 });
  },
  60_000,
);

/** Tracer 4: a text Layer's headline centers on its tight glyph ink (#137),
 * measured through the same retained font bytes painting uses. */
test(
  "a text headline centers its glyph ink at the requested target",
  async () => {
    await makeComp("poster", 400, 300);
    const addRes = await invoke([
      "composition", "add", "poster", "headline", "--text", "Ply", "--font", "Anton",
      "--font-size", "48", "--x", "10", "--y", "10", "--project", projDir, "--json",
    ]);
    expect(addRes.code).toBe(0);
    const addJson = JSON.parse(addRes.stdout);
    const layerId = addJson.use.layerId as string;
    const before = useReport(await measure("poster"), "headline");
    expect(before.painted).not.toBeNull();

    const editRes = await invoke([
      "layer", "edit", layerId, "--anchor", "center,center", "--x", "200", "--y", "150", "--project", projDir, "--json",
    ]);
    expect(editRes.code).toBe(0);
    const editJson = JSON.parse(editRes.stdout);
    const placed = editJson.anchored.placement as { x: number; y: number };
    const paintedAt = editJson.anchored.painted as { x: number; y: number; width: number; height: number };

    // The placement is auditable from the pre-edit ink evidence: the glyph
    // ink's offset from the placement point centers it on the target.
    const wantX = 200 - (paintedAt.x - before.placement.x) - paintedAt.width / 2;
    const wantY = 150 - (paintedAt.y - before.placement.y) - paintedAt.height / 2;
    expect(placed.x).toBeCloseTo(wantX, 2);
    expect(placed.y).toBeCloseTo(wantY, 2);

    // The post-edit measure is the real contract: glyph ink center at the
    // target, through the same retained font bytes painting uses.
    const after = useReport(await measure("poster"), "headline");
    const p = after.painted as { x: number; y: number; width: number; height: number };
    expect(p.x + p.width / 2).toBeCloseTo(200, 0);
    expect(p.y + p.height / 2).toBeCloseTo(150, 0);
    // The revision records plain placement — no anchor facts.
    expect(editJson.layer.currentRevision.x).toBe(placed.x);
    expect(editJson.layer.currentRevision.y).toBe(placed.y);
  },
  60_000,
);

/** Tracer 5: anchors resolve against the CURRENT transform — a rotated
 * Layer's ink box is the rotated AABB, and the anchored edge/center of THAT
 * box lands at the target. Anchor + rotate in one edit is refused (separate
 * edits), so rotation is already live when the anchor resolves. */
test(
  "a rotated Layer anchors against its rotated painted ink box",
  async () => {
    const redImg = path.join(tempDir, "red.png");
    await writeFile(redImg, solidPng(100, 60, RED));

    await makeComp("poster", 400, 300);
    const addRes = await addImageLayer("poster", "tilt", redImg, { x: 50, y: 50 });
    const layerId = addRes.use.layerId as string;

    // Rotate first: rotate(90deg) about the placement point maps the
    // 100×60 content to a 60×100 AABB extending left of the placement point.
    const rotRes = await invoke(["layer", "edit", layerId, "--rotate", "90", "--project", projDir, "--json"]);
    expect(rotRes.code).toBe(0);
    const before = useReport(await measure("poster"), "tilt");
    expect(before.painted).toEqual({ x: -10, y: 50, width: 60, height: 100 });

    // Anchor the rotated ink's right edge at x=200 and its center at y=150.
    const editRes = await invoke([
      "layer", "edit", layerId, "--anchor", "right,center", "--x", "200", "--y", "150", "--project", projDir, "--json",
    ]);
    expect(editRes.code).toBe(0);
    const editJson = JSON.parse(editRes.stdout);

    // Resolution: ink offset from placement is (-60, 0), ink 60×100.
    // right → 200 - (-60) - 60 = 200; center → 150 - 0 - 50 = 100.
    expect(editJson.anchored.placement).toEqual({ x: 200, y: 100 });
    const target = useReport(await measure("poster"), "tilt");
    expect(target.painted).toEqual({ x: 140, y: 100, width: 60, height: 100 });
    expect(target.painted!.x + target.painted!.width).toBe(200);
    expect(target.painted!.y + target.painted!.height / 2).toBe(150);
  },
  60_000,
);

/** Tracer 6a: the resolved placement is an ordinary canonical revision fact —
 * a fork carries it into the new identity, a shared in-place edit propagates
 * it to every referring Composition, and cross-Project import preserves it
 * verbatim. No alternate per-Composition placement state exists (DEC-002,
 * ADR-0017). */
test(
  "resolved anchor placement survives forks, sharing, and cross-Project import",
  async () => {
    const redImg = path.join(tempDir, "red.png");
    await writeFile(redImg, solidPng(100, 60, RED));

    await makeComp("source", 400, 300);
    const addRes = await addImageLayer("source", "hero", redImg, { x: 10, y: 10 });
    const layerId = addRes.use.layerId as string;

    // Anchor in place, single referrer.
    const editRes = await invoke([
      "layer", "edit", layerId, "--anchor", "center,top", "--x", "200", "--y", "0", "--project", projDir, "--json",
    ]);
    expect(editRes.code).toBe(0);
    const anchoredRev = JSON.parse(editRes.stdout).layer.currentRevision;
    expect(anchoredRev.x).toBe(150);
    expect(anchoredRev.y).toBe(0);

    // Cross-Project import: the destination revision preserves the resolved
    // placement verbatim in the copied revision document.
    const otherProj = path.join(tempDir, "proj2");
    await invoke(["project", "init", otherProj, "--name", "anchor-import-proj"]);
    await invoke(["composition", "create", "landing", "--width", "400", "--height", "300", "--project", otherProj, "--json"]);
    const importRes = await invoke([
      "composition", "import", "landing", "source", "--from-project", projDir, "--project", otherProj, "--json",
    ]);
    expect(importRes.code).toBe(0);
    const importedLayerId = JSON.parse(importRes.stdout).importedUses[0].layerId as string;
    const imported = JSON.parse((await invoke(["layer", "inspect", importedLayerId, "--project", otherProj, "--json"])).stdout);
    expect(imported.layer.currentRevision.x).toBe(150);
    expect(imported.layer.currentRevision.y).toBe(0);
    const copiedDoc = JSON.parse(
      await readFile(path.join(otherProj, "layers", `${importedLayerId}.revisions`, `${imported.layer.currentRevisionId}.json`), "utf8"),
    );
    expect(copiedDoc.x).toBe(150);
    expect(copiedDoc.y).toBe(0);

    // Live sharing: a second Composition in this Project references the same
    // Layer. The anchored edit must resolve identically across both (image
    // ink is composition-independent) and propagate with explicit --in-place.
    await makeComp("mirror", 400, 300);
    await invoke(["composition", "import", "mirror", "source", "--project", projDir, "--json"]);
    const shareRes = await invoke([
      "layer", "edit", layerId, "--anchor", "center,center", "--x", "200", "--y", "150", "--in-place", "--project", projDir, "--json",
    ]);
    expect(shareRes.code).toBe(0);
    const shareJson = JSON.parse(shareRes.stdout);
    expect(shareJson.anchored.contexts).toEqual(["mirror", "source"]);
    expect(shareJson.anchored.placement).toEqual({ x: 150, y: 120 });
    for (const comp of ["source", "mirror"]) {
      const report = useReport(await measure(comp), "hero");
      expect(report.painted).toEqual({ x: 150, y: 120, width: 100, height: 60 });
    }

    // Fork: the forked identity carries the resolved placement; the original
    // keeps its own; only the target use is retargeted.
    const preForkRev = shareJson.layer.currentRevisionId as string;
    const forkRes = await invoke([
      "layer", "edit", layerId, "--fork", "--composition", "mirror", "--use", "hero",
      "--anchor", "left,bottom", "--x", "0", "--y", "300", "--project", projDir, "--json",
    ]);
    expect(forkRes.code).toBe(0);
    const forkJson = JSON.parse(forkRes.stdout);
    expect(forkJson.fork).toBeDefined();
    // Ink offset from placement is (0, 0) for a solid full-ink image.
    expect(forkJson.layer.currentRevision.x).toBe(0);
    expect(forkJson.layer.currentRevision.y).toBe(240); // 300 - 60
    expect(forkJson.anchored.placement).toEqual({ x: 0, y: 240 });
    expect(forkJson.anchored.contexts).toEqual(["mirror"]);
    const forkMeasure = useReport(await measure("mirror"), "hero");
    expect(forkMeasure.painted).toEqual({ x: 0, y: 240, width: 100, height: 60 });
    // The original Layer and the source Composition are untouched.
    const original = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
    expect(original.layer.currentRevisionId).toBe(preForkRev);
    const sourceMeasure = useReport(await measure("source"), "hero");
    expect(sourceReportEqualsOriginalPlacement(sourceMeasure)).toBe(true);
  },
  120_000,
);

/** The source Composition's use keeps referencing the original Layer at its
 * pre-fork placement. */
function sourceReportEqualsOriginalPlacement(report: { layerId: string; placement: { x: number; y: number } }): boolean {
  return report.placement.x === 150 && report.placement.y === 120;
}

/** Tracer 6b: anchored placement participates in pinned Render history — a
 * render made after the anchored edit replays byte-identically from its
 * pinned revision, even after the Layer is re-anchored (US-006, DEC-002). */
test(
  "render history stays pinned across anchored edits: replay is byte-identical",
  async () => {
    const redImg = path.join(tempDir, "red.png");
    await writeFile(redImg, solidPng(100, 60, RED));

    await makeComp("poster", 400, 300);
    const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
    const layerId = addRes.use.layerId as string;

    const editRes = await invoke([
      "layer", "edit", layerId, "--anchor", "center,center", "--x", "200", "--y", "150", "--project", projDir, "--json",
    ]);
    expect(editRes.code).toBe(0);

    const firstOut = path.join(tempDir, "first.png");
    const firstRender = await invoke(["composition", "render", "poster", "--project", projDir, "--out", firstOut, "--json"]);
    expect(firstRender.code).toBe(0);
    const firstManifest = JSON.parse(firstRender.stdout).render.manifest as string;

    // Re-anchor AFTER the render: the pinned history must not change.
    const moveRes = await invoke([
      "layer", "edit", layerId, "--anchor", "left,top", "--x", "0", "--y", "0", "--project", projDir, "--json",
    ]);
    expect(moveRes.code).toBe(0);

    const replayOut = path.join(tempDir, "replay.png");
    const replayRes = await invoke([
      "composition", "replay", firstManifest, "--project", projDir, "--out", replayOut, "--json",
    ]);
    expect(replayRes.code).toBe(0);
    expect(await readFile(replayOut)).toEqual(await readFile(firstOut));

    // A fresh render of current state differs (placement changed) and
    // replays byte-identically from its own pinned revision.
    const secondOut = path.join(tempDir, "second.png");
    const secondRender = await invoke(["composition", "render", "poster", "--project", projDir, "--out", secondOut, "--json"]);
    expect(secondRender.code).toBe(0);
    const secondManifest = JSON.parse(secondRender.stdout).render.manifest as string;
    const secondReplay = path.join(tempDir, "replay2.png");
    const secondReplayRes = await invoke([
      "composition", "replay", secondManifest, "--project", projDir, "--out", secondReplay, "--json",
    ]);
    expect(secondReplayRes.code).toBe(0);
    expect(await readFile(secondReplay)).toEqual(await readFile(secondOut));
    expect(await readFile(secondOut)).not.toEqual(await readFile(firstOut));
  },
  120_000,
);

/** Tracer 7a: anchored placement resolves against visible painted ink and
 * never falls back to the layout box — a Layer with no visible ink refuses
 * (exit 1) and live state is untouched. */
test(
  "a Layer with no visible ink refuses anchored placement without mutating live state",
  async () => {
    // 40×40 content whose every pixel is fully transparent.
    const empty = path.join(tempDir, "empty.png");
    await writeFile(empty, regionPng(40, 40, RED, { x: 0, y: 0, width: 0, height: 0 }));

    await makeComp("poster", 400, 300);
    const addRes = await addImageLayer("poster", "ghost", empty, { x: 10, y: 10 });
    const layerId = addRes.use.layerId as string;
    const revId = addRes.layer.currentRevisionId as string;

    const editRes = await invoke([
      "layer", "edit", layerId, "--anchor", "center,center", "--x", "200", "--y", "150", "--project", projDir, "--json",
    ]);
    expect(editRes.code).toBe(1);
    const editJson = JSON.parse(editRes.stdout);
    expect(editJson.ok).toBe(false);
    expect(editJson.error).toContain("no visible painted ink");
    expect(editJson.error).toContain("--x/--y");

    const inspectRes = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
    const layer = JSON.parse(inspectRes.stdout).layer;
    expect(layer.currentRevisionId).toBe(revId);
    expect(layer.currentRevision.x).toBe(10);
    expect(layer.currentRevision.y).toBe(10);

    // Opacity 0 hides the ink the same way: refusal, not a fallback box.
    const redImg = path.join(tempDir, "red.png");
    await writeFile(redImg, solidPng(40, 40, RED));
    const fadeRes = await invoke([
      "composition", "add", "poster", "faded", "--image", redImg, "--x", "5", "--y", "5", "--opacity", "0",
      "--project", projDir, "--json",
    ]);
    expect(fadeRes.code).toBe(0);
    const fadeId = JSON.parse(fadeRes.stdout).use.layerId as string;
    const fadeEdit = await invoke([
      "layer", "edit", fadeId, "--anchor", "center,center", "--x", "200", "--y", "150", "--project", projDir, "--json",
    ]);
    expect(fadeEdit.code).toBe(1);
    expect(JSON.parse(fadeEdit.stdout).error).toContain("no visible painted ink");
  },
  60_000,
);

/** Tracer 7b: a text Layer shared across Compositions with different canvas
 * widths wraps differently, so the anchored resolution disagrees — the
 * refusal names the affected compositions and their count (blast-radius
 * convention) and live state is untouched. */
test(
  "divergent wrapped-text geometry across Compositions refuses, naming the compositions",
  async () => {
    await makeComp("narrow", 200, 300);
    const addRes = await invoke([
      "composition", "add", "narrow", "banner", "--text",
      "the quick brown fox jumps over the lazy dog again and again", "--font", "Anton",
      "--font-size", "24", "--x", "0", "--y", "0", "--project", projDir, "--json",
    ]);
    expect(addRes.code).toBe(0);
    const layerId = JSON.parse(addRes.stdout).use.layerId as string;
    const revId = JSON.parse(addRes.stdout).layer.currentRevisionId as string;
    const before = useReport(await measure("narrow"), "banner");
    expect(before.painted).not.toBeNull();

    await makeComp("wide", 800, 300);
    await invoke(["composition", "import", "wide", "narrow", "--project", projDir, "--json"]);
    // Sanity: the shared text wraps in the narrow canvas, not in the wide one.
    const wide = useReport(await measure("wide"), "banner");
    expect(wide.painted!.width).toBeGreaterThan(before.painted!.width);

    const editRes = await invoke([
      "layer", "edit", layerId, "--anchor", "center,bottom", "--x", "400", "--y", "280", "--project", projDir, "--json",
    ]);
    expect(editRes.code).toBe(1);
    const editJson = JSON.parse(editRes.stdout);
    expect(editJson.ok).toBe(false);
    expect(editJson.error).toContain("across 2 Compositions");
    expect(editJson.error).toContain('"narrow"');
    expect(editJson.error).toContain('"wide"');
    expect(editJson.referringCompositions).toEqual(["narrow", "wide"]);
    expect(editJson.referrersCount).toBe(2);

    // Live state untouched.
    const inspectRes = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
    const layer = JSON.parse(inspectRes.stdout).layer;
    expect(layer.currentRevisionId).toBe(revId);
    expect(layer.currentRevision.x).toBe(0);
  },
  120_000,
);

/** Tracer 8: invalid or conflicting anchored-placement inputs are usage
 * errors (exit 2) — bad components, ambiguous bare "center", wrong pair
 * order, missing target coordinates, and same-edit combination with
 * transform/content options — and every one leaves live state unchanged. */
test(
  "invalid or conflicting anchor inputs are usage errors that leave live state unchanged",
  async () => {
    const redImg = path.join(tempDir, "red.png");
    await writeFile(redImg, solidPng(100, 60, RED));

    await makeComp("poster", 400, 300);
    const addRes = await addImageLayer("poster", "hero", redImg, { x: 10, y: 10 });
    const layerId = addRes.use.layerId as string;
    const revId = addRes.layer.currentRevisionId as string;

    const badInputs: { args: string[]; errorPart: string }[] = [
      { args: ["--anchor", "middle,center", "--x", "1", "--y", "1"], errorPart: "--anchor takes" },
      { args: ["--anchor", "center", "--x", "1", "--y", "1"], errorPart: "could be either axis" },
      { args: ["--anchor", "top,left", "--x", "1", "--y", "1"], errorPart: "first component must be horizontal" },
      { args: ["--anchor", "left"], errorPart: "--x <target> is required" },
      { args: ["--anchor", "left,top", "--x", "1"], errorPart: "--y <target> is required" },
      { args: ["--anchor", "center,center"], errorPart: "--x <target> is required" },
      { args: ["--anchor", "center,center", "--x", "1", "--y", "1", "--resize", "2"], errorPart: "its own edit" },
      { args: ["--anchor", "center,center", "--x", "1", "--y", "1", "--rotate", "10"], errorPart: "its own edit" },
      { args: ["--anchor", "center,center", "--x", "1", "--y", "1", "--image", redImg], errorPart: "its own edit" },
      { args: ["--anchor", "center,center", "--x", "1", "--y", "1", "--text", "hi"], errorPart: "its own edit" },
    ];
    for (const bad of badInputs) {
      const res = await invoke(["layer", "edit", layerId, ...bad.args, "--project", projDir, "--json"]);
      expect(res.code).toBe(2);
      expect(JSON.parse(res.stdout).ok).toBe(false);
      expect(JSON.parse(res.stdout).error).toContain(bad.errorPart);
    }

    const inspectRes = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
    const layer = JSON.parse(inspectRes.stdout).layer;
    expect(layer.currentRevisionId).toBe(revId);
    expect(layer.currentRevision.x).toBe(10);
    expect(layer.currentRevision.y).toBe(10);

    // Scoped help documents the anchor surface (US-004).
    const helpRes = await invoke(["layer", "edit", "--help"]);
    expect(helpRes.code).toBe(0);
    expect(helpRes.stdout).toContain("--anchor");
    expect(helpRes.stdout).toContain("PAINTED INK");
    expect(helpRes.stdout).toContain("transparent padding does not count");
    expect(helpRes.stdout).toContain("ONE-SHOT resolution");
  },
  180_000,
);
