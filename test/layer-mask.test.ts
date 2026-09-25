/**
 * Layer masks (ADR-0025, spec #285 US-009, ISC-48, DEC-007, ticket #305).
 *
 * A masked Layer is clipped to the alpha of another Layer use in the same
 * Composition, named by use name, stored as a revision fact (`mask`) with
 * the removal spelling `:none` (never a possible use name). Decided facts:
 *
 * - The clip uses the mask's alpha after ITS OWN transforms and visible
 *   region, in canvas space (ADR-0025 §1). Strict whitelist: only content
 *   alpha, visible region, placement, and transform shape the clip; the
 *   mask's opacity, grade, effects, blend, and its own mask do not.
 * - A mask use does not paint (§2); its place in the use order has no
 *   effect on the image.
 * - The clip applies AFTER the masked Layer's effects (outline, shadow,
 *   transform & opacity) and BEFORE blend (§4): the clipped Layer blends
 *   as one unit.
 * - Removing the clip restores the render byte-for-byte; the fact is
 *   stored only when set, so pre-mask revisions keep their exact ids.
 * - The mask alpha raster paints at the delivery device scale and canvas
 *   geometry (ADR-0022 supersampling) — a masked hard edge is as sharp as
 *   the same edge painted directly — and replay re-derives the raster
 *   byte-identically (ISC-14).
 *
 * All pixel work is local, offline, per the repo's per-file --isolate
 * test topology.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePngRgba, decodePng } from "../src/png.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

interface Result {
  stdout: string;
  stderr: string;
  code: number;
}

async function invoke(args: string[]): Promise<Result> {
  const proc = Bun.spawn([process.execPath, cli, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
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

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const idx = (y * png.width + x) * 4;
  return [png.rgba[idx]!, png.rgba[idx + 1]!, png.rgba[idx + 2]!, png.rgba[idx + 3]!];
}

const BG: [number, number, number, number] = [51, 51, 51, 255]; // #333333
const RED: [number, number, number, number] = [255, 0, 0, 255];

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-mask-"));
  projDir = path.join(tempDir, "proj");
  const init = await invoke(["project", "init", projDir]);
  expect(init.code).toBe(0);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComp(name: string, width = 200, height = 160) {
  const res = await invoke([
    "composition", "create", name,
    "--width", String(width), "--height", String(height),
    "--project", projDir,
  ]);
  expect(res.code).toBe(0);
}

async function addShape(
  comp: string,
  localName: string,
  opts: { size: string; fill: string; x?: number; y?: number },
) {
  const args = [
    "composition", "add", comp, localName,
    "--shape", "rectangle", "--size", opts.size, "--fill", opts.fill,
    "--project", projDir, "--json",
  ];
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

async function addImageLayer(
  comp: string,
  localName: string,
  imgPath: string,
  opts: { x?: number; y?: number } = {},
) {
  const args = [
    "composition", "add", comp, localName,
    "--image", imgPath, "--project", projDir, "--json",
  ];
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

/** Mask the `subject` use's Layer with the use named `maskUse` (or remove with `:none`). */
async function setMask(
  address: string,
  maskUse: string,
): Promise<{ code: number; stdout: string; stderr: string; json: any }> {
  const res = await invoke([
    "layer", "edit", address, "--mask", maskUse,
    "--project", projDir, "--json",
  ]);
  let json: any = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    // refusal responses carry the message on stderr
  }
  return { ...res, json };
}

async function render(
  comp: string,
  out: string,
  opts: { supersample?: number } = {},
): Promise<Buffer> {
  const args = ["composition", "render", comp, "--project", projDir, "--out", out];
  if (opts.supersample !== undefined) args.push("--supersample", String(opts.supersample));
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return await readFile(out);
}

async function measure(comp: string): Promise<any> {
  const res = await invoke(["composition", "measure", comp, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

async function inspect(address: string): Promise<any> {
  const res = await invoke(["layer", "inspect", address, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

/** Stage: bg shape, red subject image (20,10,160x140), green mask-only shape. */
async function makeStage() {
  await makeComp("stage");
  await addShape("stage", "bg", { size: "200x160", fill: "#333333", x: 0, y: 0 });
  const img = path.join(tempDir, "subject.png");
  await writeFile(img, solidPng(160, 140, RED));
  await addImageLayer("stage", "subject", img, { x: 20, y: 10 });
  // The mask's fill is pure green: if the mask use ever painted, green would
  // appear in the render — the pixel assertions would catch it.
  await addShape("stage", "cut", { size: "200x40", fill: "#00ff00", x: 0, y: 100 });
}

test("layer edit --mask stores a revision fact; :none removes it; set-then-remove renders byte-for-byte like never-set", async () => {
  await makeStage();
  const before = await inspect("stage/subject");
  const revisionBefore = before.layer.currentRevisionId;

  const render0 = await render("stage", path.join(tempDir, "r0.png"));

  // Set the mask: the revision advances and the result reports the resolution.
  const set = await setMask("stage/subject", "cut");
  expect(set.code).toBe(0);
  expect(set.json.masked).toEqual({
    mask: "cut",
    resolved: [{ composition: "stage", layerId: expect.any(String), use: "cut" }],
  });
  const after = await inspect("stage/subject");
  expect(after.layer.currentRevisionId).not.toBe(revisionBefore);
  expect(after.layer.currentRevision.mask).toBe("cut");

  const render1 = await render("stage", path.join(tempDir, "r1.png"));
  expect(Buffer.compare(render0, render1)).not.toBe(0);

  // Remove with :none: the render is byte-for-byte the never-set one (the
  // fact is stored only when set, so the mask-less revision is the same
  // content — a fresh createdAt makes it a new revision id, like every
  // absolute-setter fact), and the mask field is gone.
  const removed = await setMask("stage/subject", ":none");
  expect(removed.code).toBe(0);
  const restored = await inspect("stage/subject");
  expect(restored.layer.currentRevisionId).not.toBe(after.layer.currentRevisionId);
  expect(restored.layer.currentRevision.mask).toBeUndefined();
  const render2 = await render("stage", path.join(tempDir, "r2.png"));
  expect(Buffer.compare(render0, render2)).toBe(0);
  const removedId = restored.layer.currentRevisionId;

  // Removing again is a no-op: no revision churn.
  const again = await setMask("stage/subject", ":none");
  expect(again.code).toBe(0);
  expect((await inspect("stage/subject")).layer.currentRevisionId).toBe(removedId);

  // An unknown use name is refused loudly; nothing publishes.
  const refused = await setMask("stage/subject", "nosuchuse");
  expect(refused.code).toBe(1);
  expect(refused.json?.error ?? refused.stderr).toContain("nosuchuse");
  expect((await inspect("stage/subject")).layer.currentRevisionId).toBe(removedId);
});

test("the clip follows the mask: a cutout clipped to a shape at a table edge; moving the shape moves the clip (acceptance)", async () => {
  await makeStage();
  await setMask("stage/subject", "cut");

  // Band at y in [100,140): subject red inside, background above.
  const r1 = decodePng(await render("stage", path.join(tempDir, "band-low.png")));
  expect(pixel(r1, 100, 120)).toEqual(RED); // inside band ∩ subject
  expect(pixel(r1, 100, 80)).toEqual(BG); // subject cut above the band
  // The mask use does not paint: no green anywhere in the render.
  for (let y = 0; y < r1.height; y += 3) {
    for (let x = 0; x < r1.width; x += 3) {
      const p = pixel(r1, x, y);
      expect(p[1] > p[0] && p[1] > p[2]).toBe(false);
    }
  }

  // measure: painted stays PRE-clip; the post-clip extents are separate facts.
  const m1 = await measure("stage");
  const subject1 = m1.layers.find((l: any) => l.name === "subject");
  expect(subject1.mask).toBe("cut");
  expect(subject1.painted).toEqual({ x: 20, y: 10, width: 160, height: 140 });
  expect(subject1.maskedPainted).toEqual({ x: 20, y: 100, width: 160, height: 40 });
  const cut1 = m1.layers.find((l: any) => l.name === "cut");
  expect(cut1.masks).toEqual(["subject"]);
  expect(cut1.painted).toEqual({ x: 0, y: 100, width: 200, height: 40 });

  // Move the mask shape (the mask stays an ordinary editable Layer):
  // the clip follows it and the masked Layer's placement and pre-clip
  // painted extents never move.
  const move = await invoke(["layer", "edit", "stage/cut", "--y", "40", "--project", projDir, "--json"]);
  expect(move.code).toBe(0);
  const r2 = decodePng(await render("stage", path.join(tempDir, "band-moved.png")));
  expect(pixel(r2, 100, 60)).toEqual(RED); // the band moved with the shape
  expect(pixel(r2, 100, 120)).toEqual(BG);

  const m2 = await measure("stage");
  const subject2 = m2.layers.find((l: any) => l.name === "subject");
  expect(subject2.painted).toEqual(subject1.painted); // pre-clip, unchanged
  expect(subject2.maskedPainted).toEqual({ x: 20, y: 40, width: 160, height: 40 });
});

test("the mask's own transforms and visible region shape the clip", async () => {
  await makeStage();
  // Make the mask a full-canvas shape, then crop it to a top band.
  await invoke(["layer", "edit", "stage/cut", "--size", "200x160", "--y", "0", "--project", projDir]);
  await invoke(["layer", "edit", "stage/cut", "--visible-region", "0,0,200,40", "--project", projDir]);
  await setMask("stage/subject", "cut");

  const r1 = decodePng(await render("stage", path.join(tempDir, "region.png")));
  expect(pixel(r1, 100, 20)).toEqual(RED);
  expect(pixel(r1, 100, 60)).toEqual(BG);

  // Scaling the mask Layer scales its clip (transform shapes the clip).
  const scale = await invoke(["layer", "edit", "stage/cut", "--scale", "2", "--project", projDir, "--json"]);
  expect(scale.code).toBe(0);
  const r2 = decodePng(await render("stage", path.join(tempDir, "scaled.png")));
  expect(pixel(r2, 100, 60)).toEqual(RED);
  expect(pixel(r2, 100, 100)).toEqual(BG);
});

test("the clip cuts the masked Layer's final pixels: outline and shadow fall where the mask has no alpha (ADR-0025 §4)", async () => {
  await makeStage();
  // Right-half mask: alpha covers x in [100,200).
  await invoke(["layer", "edit", "stage/cut", "--size", "100x160", "--x", "100", "--y", "0", "--project", projDir]);
  // Outline and shadow on the subject, then mask it.
  await invoke(["layer", "edit", "stage/subject", "--outline", "4,#0000ff", "--project", projDir]);
  await invoke(["layer", "edit", "stage/subject", "--shadow", "12,12,0,#000000", "--project", projDir]);
  await setMask("stage/subject", "cut");

  const r = decodePng(await render("stage", path.join(tempDir, "effects.png")));
  // Content: kept inside the mask, cut outside.
  expect(pixel(r, 150, 80)).toEqual(RED);
  expect(pixel(r, 50, 80)).toEqual(BG);
  // The subject's right outline ring (x in [180,184)) is inside the mask: kept.
  expect(pixel(r, 182, 80)[2]).toBeGreaterThan(200); // blue channel
  // The subject's left outline ring (x in [16,20)) is outside the mask: cut.
  expect(pixel(r, 18, 80)).toEqual(BG);
  // The shadow below the subject (y in [150,162) from the +12 dy): kept at
  // x=150 (inside the mask), cut at x=50.
  expect(pixel(r, 150, 155)[0]).toBeLessThan(60);
  expect(pixel(r, 50, 155)).toEqual(BG);
});

test("the mask alpha raster paints at the delivery device scale: a masked hard edge is as sharp as the same edge painted directly (ADR-0022)", async () => {
  // Fractional edge x=99.5 (device x=399 at supersample 2): a half-covered
  // device column, so the transition width is non-trivial and comparable.
  const build = async (name: string, masked: boolean) => {
    await makeComp(name);
    await addShape(name, "bg", { size: "200x160", fill: "#333333", x: 0, y: 0 });
    const img = path.join(tempDir, `${name}-subject.png`);
    await writeFile(img, solidPng(200, 160, RED));
    await addImageLayer(name, "subject", img, { x: 0, y: 0 });
    await addShape(name, "edge", { size: "99.5x160", fill: "#00ff00", x: 0, y: 0 });
    if (masked) await setMask(`${name}/subject`, "edge");
    return name;
  };
  await build("sharpPlain", false);
  await build("sharpMasked", true);

  const plain = decodePng(await render("sharpPlain", path.join(tempDir, "plain.png")));
  const masked = decodePng(await render("sharpMasked", path.join(tempDir, "masked.png")));

  // Transition width at the shape's vertical edge in row y=80: the number of
  // canvas pixels strictly between the background and subject colours.
  const transitionWidth = (png: ReturnType<typeof decodePng>, edgeX: number): number => {
    let width = 0;
    for (let x = Math.floor(edgeX) - 3; x <= Math.ceil(edgeX) + 3; x++) {
      const p = pixel(png, x, 80);
      const t = (p[0] - BG[0]) / (RED[0] - BG[0]); // redness 0..1
      if (t > 0.05 && t < 0.95) width++;
    }
    return width;
  };
  const wPlain = transitionWidth(plain, 99.5);
  const wMasked = transitionWidth(masked, 99.5);
  expect(Math.abs(wMasked - wPlain)).toBeLessThanOrEqual(1);
  expect(wMasked).toBeLessThanOrEqual(1);
});

test("a Render with a mask replays byte-identically from its pinned inputs, even after later edits", async () => {
  await makeStage();
  await setMask("stage/subject", "cut");

  const out = path.join(tempDir, "original.png");
  const renderRes = await invoke([
    "composition", "render", "stage", "--project", projDir, "--out", path.join(tempDir, "render-target.png"), "--json",
  ]);
  expect(renderRes.code).toBe(0);
  const original = await readFile(path.join(tempDir, "render-target.png"));
  const manifest = JSON.parse(renderRes.stdout).render.manifest as string;

  const replay = await invoke([
    "composition", "replay", manifest, "--out", out, "--project", projDir,
  ]);
  expect(replay.code, replay.stderr).toBe(0);
  expect(Buffer.compare(await readFile(out), original)).toBe(0);

  // Later edits move current state; the pinned replay is unaffected.
  await invoke(["layer", "edit", "stage/cut", "--y", "40", "--project", projDir]);
  const replay2 = await invoke([
    "composition", "replay", manifest, "--out", `${out}.2`, "--project", projDir,
  ]);
  expect(replay2.code, replay2.stderr).toBe(0);
  expect(Buffer.compare(await readFile(`${out}.2`), original)).toBe(0);
});

test("the removal spelling :none can never name a use; it is refused as a use name", async () => {
  await makeStage();
  // A use named ":none" is refused at ingestion (invalid characters).
  const res = await invoke([
    "composition", "add", "stage", ":none",
    "--shape", "rectangle", "--size", "10x10", "--fill", "#000000",
    "--project", projDir,
  ]);
  expect(res.code).toBe(1);
  expect(res.stderr).toContain("invalid characters");

  // --mask :none on a Layer with no mask is an idempotent no-op.
  const noop = await setMask("stage/subject", ":none");
  expect(noop.code).toBe(0);
  expect((await inspect("stage/subject")).layer.currentRevision.mask).toBeUndefined();
});
// --- Suite 2: refusals, lifecycle, chains (ADR-0025 §2/§3/§5) -------------

test("a use cannot mask itself", async () => {
  await makeStage();
  const res = await setMask("stage/cut", "cut");
  expect(res.code).toBe(1);
  expect(res.json?.error ?? res.stderr).toContain("cannot mask itself");
  expect(res.json?.error ?? res.stderr).toContain("cut");
});

test("a mask cycle is refused before publication, naming the uses in it", async () => {
  await makeComp("loop");
  await addShape("loop", "a", { size: "50x50", fill: "#ff0000", x: 0, y: 0 });
  await addShape("loop", "b", { size: "50x50", fill: "#0000ff", x: 60, y: 0 });
  const first = await setMask("loop/a", "b");
  expect(first.code).toBe(0);
  const cycle = await setMask("loop/b", "a");
  expect(cycle.code).toBe(1);
  const message = cycle.json?.error ?? cycle.stderr;
  expect(message).toContain("Mask cycle");
  expect(message).toContain('"a"');
  expect(message).toContain('"b"');
});

test("composition remove refuses to remove a use another use still names as its mask; removing the masked use is fine", async () => {
  await makeStage();
  await setMask("stage/subject", "cut");
  const refused = await invoke(["composition", "remove", "stage", "cut", "--project", projDir]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("still name");
  expect(refused.stderr).toContain('"subject"');
  const allowed = await invoke(["composition", "remove", "stage", "subject", "--project", projDir]);
  expect(allowed.code).toBe(0);
});

test("an in-place mask edit must resolve in every referring Composition; the refusal names each where it does not", async () => {
  await makeStage();
  // A same-Project import shares the Layer identities: subject and cut are
  // now referenced from two Compositions.
  await invoke(["composition", "create", "two", "--width", "200", "--height", "160", "--project", projDir]);
  const imported = await invoke(["composition", "import", "two", "stage", "--project", projDir, "--json"]);
  expect(imported.code, imported.stderr).toBe(0);
  // Remove the mask use from "two" only (nothing is masked yet, so the
  // removal is allowed) — the mask name will resolve in "stage" but not "two".
  const removed = await invoke(["composition", "remove", "two", "cut", "--project", projDir]);
  expect(removed.code).toBe(0);

  const bare = await setMask("stage/subject", "cut");
  expect(bare.code).toBe(1);
  const inPlace = await invoke([
    "layer", "edit", "stage/subject", "--mask", "cut", "--in-place", "--project", projDir, "--json",
  ]);
  expect(inPlace.code).toBe(1);
  const message = JSON.parse(inPlace.stdout).error as string;
  expect(message).toContain('"two"');
  expect(message).toContain("cut");

  // A Composition where the name resolves everywhere succeeds and reports
  // the blast radius: one resolution per referring Composition. "two" gets
  // a use named cut back (a different Layer — resolution is by use name).
  await invoke(["composition", "create", "three", "--width", "200", "--height", "160", "--project", projDir]);
  await invoke(["composition", "import", "three", "stage", "--project", projDir]);
  await invoke(["composition", "add", "two", "cut", "--shape", "rectangle", "--size", "10x10", "--fill", "#000000", "--project", projDir]);
  const ok = await invoke(["layer", "edit", "stage/subject", "--mask", "cut", "--in-place", "--project", projDir, "--json"]);
  expect(ok.code, ok.stderr).toBe(0);
  const report = JSON.parse(ok.stdout).masked;
  expect(report.mask).toBe("cut");
  expect(report.resolved.map((r: any) => r.composition).sort()).toEqual(["stage", "three", "two"].sort());
});

test("a --fork mask edit resolves against the fork target Composition", async () => {
  await makeStage();
  await invoke(["composition", "import", "two", "stage", "--project", projDir, "--json"]);
  await invoke(["composition", "remove", "two", "cut", "--project", projDir]);

  // The fork target Composition lacks the mask use: refused. A fork edit is
  // addressed by its target use, so the address IS the fork target.
  const refused = await invoke([
    "layer", "edit", "two/subject", "--fork",
    "--composition", "two", "--use", "subject",
    "--mask", "cut", "--project", projDir, "--json",
  ]);
  expect(refused.code).toBe(1);
  expect((JSON.parse(refused.stdout).error as string)).toContain('"two"');

  // The fork target has the mask use: the fork publishes the masked
  // revision for that one use and reports the single resolution.
  const ok = await invoke([
    "layer", "edit", "stage/subject", "--fork",
    "--composition", "stage", "--use", "subject",
    "--mask", "cut", "--project", projDir, "--json",
  ]);
  expect(ok.code, ok.stderr).toBe(0);
  const report = JSON.parse(ok.stdout);
  expect(report.masked).toEqual({
    mask: "cut",
    resolved: [{ composition: "stage", layerId: expect.any(String), use: "cut" }],
  });
});

test("composition add --mask resolves an existing use, refuses an unknown one, and never names itself", async () => {
  await makeStage();
  const ok = await invoke([
    "composition", "add", "stage", "second",
    "--shape", "rectangle", "--size", "20x20", "--fill", "#0000ff",
    "--mask", "cut", "--project", projDir, "--json",
  ]);
  expect(ok.code, ok.stderr).toBe(0);
  expect(JSON.parse(ok.stdout).masked).toEqual({
    mask: "cut",
    resolved: [{ composition: "stage", layerId: expect.any(String), use: "cut" }],
  });

  const missing = await invoke([
    "composition", "add", "stage", "third",
    "--shape", "rectangle", "--size", "20x20", "--fill", "#0000ff",
    "--mask", "nosuch", "--project", projDir, "--json",
  ]);
  expect(missing.code).toBe(1);
  expect((JSON.parse(missing.stdout).error as string)).toContain("nosuch");

  const self = await invoke([
    "composition", "add", "stage", "fourth",
    "--shape", "rectangle", "--size", "20x20", "--fill", "#0000ff",
    "--mask", "fourth", "--project", projDir, "--json",
  ]);
  expect(self.code).toBe(1);
  expect((JSON.parse(self.stdout).error as string)).toContain("cannot mask itself");
});

test("masks survive import: same-Project import keeps the clip, cross-Project import relinks to the destination copy, and a mask-use-name clash is refused", async () => {
  await makeStage();
  await setMask("stage/subject", "cut");
  const original = await render("stage", path.join(tempDir, "orig.png"));

  // Same-Project import: the whole use list copies under unchanged names,
  // so the stored name resolves in the copy.
  await invoke(["composition", "create", "two", "--width", "200", "--height", "160", "--project", projDir]);
  const same = await invoke(["composition", "import", "two", "stage", "--project", projDir, "--json"]);
  expect(same.code).toBe(0);
  const two = await render("two", path.join(tempDir, "two.png"));
  expect(Buffer.compare(two, original)).toBe(0);

  // Cross-Project import: every copied Layer gets an independent identity,
  // and the mask name resolves to the DESTINATION copy of the mask (the
  // relink) — the pixels are identical.
  const otherProj = path.join(tempDir, "other");
  const init = await invoke(["project", "init", otherProj]);
  expect(init.code).toBe(0);
  await invoke(["composition", "create", "copy", "--width", "200", "--height", "160", "--project", otherProj]);
  const cross = await invoke([
    "composition", "import", "copy", "stage", "--from-project", projDir, "--project", otherProj, "--json",
  ]);
  expect(cross.code, cross.stderr).toBe(0);
  const crossRender = await invoke(["composition", "render", "copy", "--project", otherProj, "--out", path.join(tempDir, "cross.png")]);
  expect(crossRender.code, crossRender.stderr).toBe(0);
  expect(Buffer.compare(await readFile(path.join(tempDir, "cross.png")), original)).toBe(0);
  const crossInspect = await invoke(["layer", "inspect", "copy/subject", "--project", otherProj, "--json"]);
  expect(JSON.parse(crossInspect.stdout).layer.currentRevision.mask).toBe("cut");

  // A use-name clash on the mask use's name is refused — the established
  // collision refusal needs no new code; nothing is renamed silently.
  const clashComp = await invoke(["composition", "create", "clash", "--width", "200", "--height", "160", "--project", otherProj]);
  expect(clashComp.code).toBe(0);
  const clash = await invoke([
    "composition", "add", "clash", "cut", "--shape", "rectangle", "--size", "10x10", "--fill", "#000000",
    "--project", otherProj,
  ]);
  expect(clash.code).toBe(0);
  const refused = await invoke([
    "composition", "import", "clash", "stage", "--from-project", projDir, "--project", otherProj,
  ]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("cut");
});

test("fork keeps the clip: the forked masked Layer renders identically, and forking the mask use is followed", async () => {
  await makeStage();
  await setMask("stage/subject", "cut");
  const before = await render("stage", path.join(tempDir, "pre-fork.png"));

  // Fork the masked Layer: the forked revision keeps the mask fact and the
  // name still resolves in this Composition — identical pixels.
  const fork = await invoke([
    "layer", "edit", "stage/subject", "--fork",
    "--composition", "stage", "--use", "subject", "--project", projDir, "--json",
  ]);
  expect(fork.code, fork.stderr).toBe(0);
  const forked = JSON.parse(fork.stdout);
  expect(forked.layer.currentRevision.mask).toBe("cut");
  expect(forked.layer.id).not.toBe(forked.fork.previousLayerId);
  expect(Buffer.compare(await render("stage", path.join(tempDir, "post-fork.png")), before)).toBe(0);

  // Fork the MASK use: the masked Layer's stored name resolves to the use,
  // which now references the forked copy — the clip follows unchanged.
  const forkMask = await invoke([
    "layer", "edit", "stage/cut", "--fork",
    "--composition", "stage", "--use", "cut", "--project", projDir, "--json",
  ]);
  expect(forkMask.code, forkMask.stderr).toBe(0);
  expect(Buffer.compare(await render("stage", path.join(tempDir, "post-fork-mask.png")), before)).toBe(0);
});

test("relocation: a masked Composition replays byte-identically after the Project moves", async () => {
  await makeStage();
  await setMask("stage/subject", "cut");
  const renderRes = await invoke([
    "composition", "render", "stage", "--project", projDir, "--out", path.join(tempDir, "pre-move.png"), "--json",
  ]);
  expect(renderRes.code, renderRes.stderr).toBe(0);
  const original = await readFile(path.join(tempDir, "pre-move.png"));
  const manifest = JSON.parse(renderRes.stdout).render.manifest as string;

  const movedProj = path.join(tempDir, "moved");
  const { rename } = await import("node:fs/promises");
  await rename(projDir, movedProj);

  // The manifest rides inside the Project (renders/); the recorded path was
  // absolute to the old location, so replay addresses it under the new root.
  const manifestName = path.basename(manifest);
  const replay = await invoke([
    "composition", "replay", path.join(movedProj, "renders", manifestName),
    "--out", path.join(tempDir, "relocated.png"), "--project", movedProj,
  ]);
  expect(replay.code, replay.stderr).toBe(0);
  expect(Buffer.compare(await readFile(path.join(tempDir, "relocated.png")), original)).toBe(0);
});

test("one painted use and one mask use of the same Layer: the mask does not paint, and one edit moves both (ADR-0025 §2)", async () => {
  await makeComp("duo");
  const table = await addShape("duo", "table", { size: "200x60", fill: "#8b5a2b", x: 0, y: 100 });
  const img = path.join(tempDir, "duo-subject.png");
  await writeFile(img, solidPng(160, 140, RED));
  await addImageLayer("duo", "subject", img, { x: 20, y: 10 });
  // The second use of the same Layer: the document shape allows several
  // uses of one Layer (ADR-0013); no CLI path constructs one yet (the ADR
  // reserves that for a future use-copy operation), so the use list is
  // edited directly at the Project-format seam.
  const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
  const compFile = path.join(projDir, "compositions", "duo.json");
  const doc = JSON.parse(await rf(compFile, "utf8"));
  doc.layers.push({ name: "tableMask", layerId: table.use.layerId });
  await wf(compFile, JSON.stringify(doc, null, 2) + "\n");
  await setMask("duo/subject", "tableMask");

  const BROWN: [number, number, number, number] = [139, 90, 43, 255];
  const CLEAR: [number, number, number, number] = [0, 0, 0, 0];
  const r1 = decodePng(await render("duo", path.join(tempDir, "duo-1.png")));
  // The painted table use shows (outside the subject's x range); the mask
  // use paints only through the clip, never as itself.
  expect(pixel(r1, 10, 130)).toEqual(BROWN);
  expect(pixel(r1, 190, 130)).toEqual(BROWN);
  // The subject is kept only where the mask use's alpha (the shared table
  // Layer's band) is, and paints OVER the table there.
  expect(pixel(r1, 100, 130)).toEqual(RED);
  expect(pixel(r1, 100, 60)).toEqual(CLEAR); // cut above the band (no backdrop here)

  // One edit moves both: the shared Layer's placement edit moves the
  // painted use and the clip together.
  const move = await invoke(["layer", "edit", "duo/table", "--y", "20", "--project", projDir, "--json"]);
  expect(move.code, move.stderr).toBe(0);
  const r2 = decodePng(await render("duo", path.join(tempDir, "duo-2.png")));
  expect(pixel(r2, 100, 60)).toEqual(RED); // the band moved up with the Layer
  expect(pixel(r2, 10, 60)).toEqual(BROWN); // the painted table moved with it
  expect(pixel(r2, 100, 130)).toEqual(CLEAR); // cut below the moved band
});


test("a chain is allowed: a masked Layer that serves as a mask gives its own unclipped alpha (ADR-0025 §5)", async () => {
  await makeComp("chain");
  // a: full-canvas red (bottom of the paint order)
  const img = path.join(tempDir, "chain-a.png");
  await writeFile(img, solidPng(200, 160, RED));
  await addImageLayer("chain", "a", img, { x: 0, y: 0 });
  // b: full canvas green, masked by c — paints only the right half
  await addShape("chain", "b", { size: "200x160", fill: "#00ff00", x: 0, y: 0 });
  // c: right half (the clip that cuts b's paint but not b's given alpha);
  // added last but never painted — it is b's mask use.
  await addShape("chain", "c", { size: "100x160", fill: "#0000ff", x: 100, y: 0 });
  // a: masked by b; b itself masked by c.
  await setMask("chain/b", "c");
  await setMask("chain/a", "b");

  const r = decodePng(await render("chain", path.join(tempDir, "chain.png")));
  // b serves as a's mask, so b does NOT paint (ADR-0025 §2) — the image
  // shows a's red everywhere b has alpha (b's full canvas), and nothing
  // else: c (b's mask use) never paints either.
  expect(pixel(r, 150, 80)).toEqual(RED);
  // a's clip is b's FULL content alpha (b's own clip plays no part in the
  // alpha it gives), so a shows through everywhere b has alpha — including
  // the right half, which c's clip would have cut from b's own paint.
  expect(pixel(r, 50, 80)).toEqual(RED);
  // c is b's mask use, so c never paints (blue appears nowhere).
  for (let y = 0; y < r.height; y += 7) {
    for (let x = 0; x < r.width; x += 7) {
      const p = pixel(r, x, y);
      expect(p[2] > p[0] && p[2] > p[1]).toBe(false);
    }
  }
});

test("a stale mask fact fails loudly: render, measure, and replay refuse naming the missing use", async () => {
  await makeStage();
  await setMask("stage/subject", "cut");
  // Simulate a document that lost its mask use (a state the CLI refusals
  // prevent): drop the cut use directly at the document seam.
  const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
  const compFile = path.join(projDir, "compositions", "stage.json");
  const doc = JSON.parse(await rf(compFile, "utf8"));
  doc.layers = doc.layers.filter((l: any) => l.name !== "cut");
  await wf(compFile, JSON.stringify(doc, null, 2) + "\n");

  const renderRes = await invoke(["composition", "render", "stage", "--project", projDir]);
  expect(renderRes.code).toBe(1);
  expect(renderRes.stderr).toContain("cut");
  expect(renderRes.stderr).toContain("subject");

  const measureRes = await invoke(["composition", "measure", "stage", "--project", projDir]);
  expect(measureRes.code).toBe(1);
  expect(measureRes.stderr).toContain("cut");
});
