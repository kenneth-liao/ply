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
