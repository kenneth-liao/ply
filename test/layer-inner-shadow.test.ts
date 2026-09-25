/**
 * Layer inner shadows (#303, spec #285 US-011, ISC-64, DEC-005, ADR-0027).
 *
 * Verifies through the public CLI seam:
 * - `--inner-shadow "<dx>,<dy>,<blur>,<color>"` sets an ABSOLUTE inner
 *   shadow (a later edit replaces it; `--inner-shadow none` removes it) on
 *   image Layers; `innerShadow` is the canonical revision fact appended to
 *   the revision hash conditionally, and retained source bytes never
 *   change. The field stacks per ADR-0027: several occurrences store a
 *   list in the SAME field in command order; a stored length-1 list is a
 *   malformed document.
 * - The shadow darkens pixels JUST INSIDE the alpha edge and never paints
 *   outside it: dy +4 darkens the TOP inside edge (the edge the offset
 *   moves away from — the CSS inset box-shadow convention), dx +4 the left
 *   inside edge, and 0,0,blur rings all inside edges. The painted extent
 *   is unchanged (no reach term), and removing the fact restores the
 *   render byte-for-byte.
 * - Chain position: the inner shadow sits after the edge glow and before
 *   the outlines — the outline dilate and drop-shadow casting geometry are
 *   unchanged by an alpha-preserving effect.
 * - Invalid settings fail before mutation; compact output, JSON, inspect,
 *   measure, and review expose the effective inner shadow.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { decodePng, encodePngRgba } from "../src/png.js";
import { computeRevisionHash, normalizeStoredInnerShadow, type LayerImageRevision } from "../src/layer.js";

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

/** The axis-aligned bounding box of nonzero alpha, or null when empty. */
function alphaBBox(png: ReturnType<typeof decodePng>): [number, number, number, number] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (png.rgba[(y * png.width + x) * 4 + 3]! > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return minX === Infinity ? null : [minX, minY, maxX, maxY];
}

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-inner-shadow-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "inner-shadow-test-proj"]);
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

async function render(comp: string, out: string): Promise<ReturnType<typeof decodePng>> {
  const res = await invoke(["composition", "render", comp, "--project", projDir, "--out", out, "--json"]);
  expect(res.code).toBe(0);
  return decodePng(await readFile(out));
}

/** Tracer 1 (ISC-64): `--inner-shadow 0,4,0,#000000` darkens the TOP inside
 *  edge of an image Layer and never paints outside the alpha edge — the
 *  bottom inside edge is untouched, and the painted extent equals the
 *  no-shadow extent. Removal restores the render byte-for-byte. */
test("image Layer --inner-shadow darkens the top inside edge and leaves the painted extent unchanged", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;
  const oldRevId = addRes.layer.currentRevisionId as string;
  const contentHash = addRes.layer.currentRevision.contentHash as string;

  const baseOut = path.join(tempDir, "base.png");
  const base = await render("poster", baseOut);
  const baseBBox = alphaBBox(base);
  const baseBytes = await readFile(baseOut);

  const editRes = await invoke([
    "layer", "edit", layerId, "--inner-shadow", "0,4,0,#000000", "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);
  const editJson = JSON.parse(editRes.stdout);
  expect(editJson.ok).toBe(true);
  expect(editJson.layer.currentRevisionId).not.toBe(oldRevId);

  // Same content identity, new effect fact: the inner shadow is stored as
  // the canonical revision field, reported as the normalized list.
  const rev = editJson.layer.currentRevision;
  expect(rev.contentHash).toBe(contentHash);
  expect(rev.innerShadow).toEqual([{ dx: 0, dy: 4, blur: 0, color: "#000000" }]);

  // Auditable report in JSON output.
  expect(editJson.innerShadowed).toEqual({ innerShadow: [{ dx: 0, dy: 4, blur: 0, color: "#000000" }] });

  // Retained bytes are byte-identical; no new blobs staged.
  const blob = await readFile(path.join(projDir, "content", contentHash));
  expect(createHash("sha256").update(blob).digest("hex")).toBe(contentHash);

  // The TOP inside edge darkens: the offset moves the alpha DOWN, so the
  // band appears along the edge the offset moves away from (the CSS inset
  // box-shadow convention). Rows 50..53 are the band; row 57 is untouched.
  // (Exact-equality probes on pure primaries are safe: #ff0000 round-trips
  // the filter's linearRGB conversion exactly — review CRAFT-5.)
  const out = path.join(tempDir, "render.png");
  const png = await render("poster", out);
  expect(pixel(png, 100, 52)[0]).toBeLessThan(250); // darkened, not pure red
  expect(pixel(png, 100, 52)[3]).toBe(255);
  expect(pixel(png, 100, 57)).toEqual(RED); // below the band: untouched
  expect(pixel(png, 100, 107)).toEqual(RED); // bottom inside edge: untouched
  // No ink outside the content footprint: the band is inside the alpha.
  expect(pixel(png, 100, 49)[3]).toBe(0);

  // The painted extent is unchanged (the atop composite keeps the alpha
  // exactly the source's — zero reach).
  expect(alphaBBox(png)).toEqual(baseBBox);

  // Measure agrees: painted extents equal the no-shadow extents, and the
  // effects facts report the inner shadow list.
  const measured = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  expect(measured.code).toBe(0);
  const layer = JSON.parse(measured.stdout).layers[0] as { effects: { innerShadow: unknown }; painted: unknown };
  expect(layer.effects.innerShadow).toEqual([{ dx: 0, dy: 4, blur: 0, color: "#000000" }]);
  // Tracer 4 rename note (review CRAFT-4): this edit is the removal, not a
  // measure.
  const removalEdit = await invoke(["layer", "edit", layerId, "--inner-shadow", "none", "--project", projDir, "--json"]);
  expect(removalEdit.code).toBe(0);
  const m2 = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  expect((JSON.parse(m2.stdout).layers[0] as { effects: { innerShadow: unknown } }).effects.innerShadow).toBeNull();
  expect((JSON.parse(m2.stdout).layers[0] as { painted: unknown }).painted).toEqual(
    (JSON.parse(measured.stdout).layers[0] as { painted: unknown }).painted,
  );

  // Removal restores the baseline render byte-for-byte (ISC-64).
  const afterOut = path.join(tempDir, "after.png");
  await render("poster", afterOut);
  expect(await readFile(afterOut)).toEqual(baseBytes);
});

/** Tracer 2: the dx convention — dx +4 darkens the LEFT inside edge (the
 *  edge the offset moves away from), never the right inside edge. */
test("--inner-shadow dx +4 darkens the left inside edge only", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  const editRes = await invoke([
    "layer", "edit", layerId, "--inner-shadow", "4,0,0,#000000", "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);

  const out = path.join(tempDir, "render.png");
  const png = await render("poster", out);
  expect(pixel(png, 52, 80)[0]).toBeLessThan(250); // left band darkened
  expect(pixel(png, 57, 80)).toEqual(RED); // right of the band: untouched
  expect(pixel(png, 147, 80)).toEqual(RED); // right inside edge: untouched
  expect(pixel(png, 151, 80)[3]).toBe(0); // nothing outside the content
});

/** Tracer 3: with 0,0,blur the darkening rings ALL inside edges, the
 *  centre stays untouched, and no ink appears outside. */
test("--inner-shadow 0,0,blur rings all inside edges", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  const editRes = await invoke([
    "layer", "edit", layerId, "--inner-shadow", "0,0,6,#000000", "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);

  const out = path.join(tempDir, "render.png");
  const png = await render("poster", out);
  const center = pixel(png, 100, 80);
  expect(center).toEqual(RED); // the centre is untouched
  // Every inside edge is darker than the centre; every just-outside probe
  // is transparent.
  for (const [x, y, ox, oy] of [
    [100, 52, 100, 47], // top
    [100, 107, 100, 113], // bottom
    [52, 80, 47, 80], // left
    [147, 80, 153, 80], // right
  ] as const) {
    const edge = pixel(png, x, y);
    expect(edge[3]).toBe(255);
    expect(edge[0]).toBeLessThan(center[0]!);
    expect(pixel(png, ox, oy)[3]).toBe(0);
  }
});

/** Tracer 4: the stack — several occurrences store a list in the SAME
 *  field, in command order, each later entry painting over the earlier
 *  one's band (both read the same source alpha, so the bands coincide);
 *  the edit report and the hash carry the ordered stack; a stored
 *  length-1 list is a malformed document. */
test("inner shadows stack in command order; a stored length-1 list is refused", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  const editRes = await invoke([
    "layer", "edit", layerId,
    "--inner-shadow", "0,4,0,#000000",
    "--inner-shadow", "0,4,0,#0000ff",
    "--project", projDir, "--json",
  ]);
  expect(editRes.code).toBe(0);
  const rev = JSON.parse(editRes.stdout).layer.currentRevision;
  expect(rev.innerShadow).toEqual([
    { dx: 0, dy: 4, blur: 0, color: "#000000" },
    { dx: 0, dy: 4, blur: 0, color: "#0000ff" },
  ]);

  // Paint order: the second entry paints OVER the first's band — the top
  // band reads the second entry's colour.
  const out = path.join(tempDir, "render.png");
  const png = await render("poster", out);
  const band = pixel(png, 100, 52);
  expect(band[2]!).toBeGreaterThan(band[0]!); // blue over black

  // The hash field: the ordered stack is covered by the revision id — a
  // stack's id differs from its single-entry prefix's and from the
  // reversed stack's (paint order is part of the fact).
  const stackId = computeRevisionHash(rev as LayerImageRevision);
  const singleId = computeRevisionHash({ ...rev, innerShadow: [rev.innerShadow![0]!] } as LayerImageRevision);
  expect(stackId).not.toBe(singleId);
  const reversedId = computeRevisionHash(
    { ...rev, innerShadow: [rev.innerShadow![1]!, rev.innerShadow![0]!] } as LayerImageRevision,
  );
  expect(reversedId).not.toBe(stackId);

  // The stored-shape refusal: a length-1 list is a second answer for the
  // same fact — refused loudly through the ONE fold.
  expect(() =>
    normalizeStoredInnerShadow({ innerShadow: [{ dx: 0, dy: 4, blur: 0, color: "#000000" }] }),
  ).toThrow(/must be the single object form/);

  // The field-wise no-op: re-issuing the identical stack is a detected
  // no-op, never a redundant revision.
  const before = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
  const noop = await invoke([
    "layer", "edit", layerId,
    "--inner-shadow", "0,4,0,#000000",
    "--inner-shadow", "0,4,0,#0000ff",
    "--project", projDir, "--json",
  ]);
  expect(noop.code).toBe(0);
  expect(JSON.parse(noop.stdout).layer.currentRevisionId).toBe(before.layer.currentRevisionId);
});

/** Tracer 5: invalid specs are refused before mutation with the parser's
 *  wording, on both surfaces; "none" combined with values is the boundary
 *  parse's refusal (exit 2). */
test("invalid --inner-shadow specs refuse identically and never mutate", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  const bad = await invoke(["layer", "edit", layerId, "--inner-shadow", "banana", "--project", projDir]);
  expect(bad.code).toBe(2);
  expect(bad.stderr).toContain('Invalid inner shadow "banana"');

  const mixed = await invoke([
    "layer", "edit", layerId, "--inner-shadow", "none", "--inner-shadow", "0,4,0,#000000", "--project", projDir,
  ]);
  expect(mixed.code).toBe(2);
  expect(mixed.stderr).toContain("cannot combine with inner shadow values");

  const addBad = await invoke([
    "composition", "add", "poster", "x1", "--image", redImg, "--inner-shadow", "banana", "--project", projDir,
  ]);
  expect(addBad.code).toBe(2);
  expect(addBad.stderr).toContain('Invalid inner shadow "banana"');
});

/** Tracer 7 (review CRAFT-2): the inner shadow's chain position is
 *  provably inert for the ink-extending effects — a Layer carrying outline
 *  + shadow + inner shadow paints the SAME outline ring and drop shadow as
 *  its no-inner-shadow twin (the atop composite preserves the input's
 *  alpha, so the outline dilate and drop-shadow casting geometry are
 *  unchanged), and the painted extent is unchanged. */
test("the inner shadow leaves outline and drop-shadow paint geometry unchanged", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("with", 400, 300);
  await makeComp("without", 400, 300);
  const addWith = await addImageLayer("with", "hero", redImg, { x: 50, y: 50 });
  const addWithout = await addImageLayer("without", "hero", redImg, { x: 50, y: 50 });

  const editWith = await invoke([
    "layer", "edit", addWith.use.layerId as string,
    "--outline", "4,#00ff00", "--shadow", "8,8,4,#000000", "--inner-shadow", "0,6,4,#000000",
    "--project", projDir, "--json",
  ]);
  expect(editWith.code).toBe(0);
  const editWithout = await invoke([
    "layer", "edit", addWithout.use.layerId as string,
    "--outline", "4,#00ff00", "--shadow", "8,8,4,#000000",
    "--project", projDir, "--json",
  ]);
  expect(editWithout.code).toBe(0);

  const outWith = path.join(tempDir, "with.png");
  const outWithout = path.join(tempDir, "without.png");
  const withPng = await render("with", outWith);
  const withoutPng = await render("without", outWithout);

  // The outline ring and the drop-shadow region read identically with and
  // without the inner shadow (the band sits inside the content alpha and
  // does not touch the ring or the cast ink).
  expect(pixel(withPng, 46, 80)).toEqual(pixel(withoutPng, 46, 80)); // outline ring (left)
  expect(pixel(withPng, 110, 115)).toEqual(pixel(withoutPng, 110, 115)); // drop-shadow ink
  // The painted extent is the outlined+shadowed extent in both.
  expect(alphaBBox(withPng)).toEqual(alphaBBox(withoutPng));
}, 30_000);

/** Tracer 8 (review CRAFT-3): the copy fold — a cross-Project import
 *  carries the inner-shadow stack verbatim: one effect keeps the stored
 *  single-object shape, a stack keeps its list (DEC-002, ADR-0027). */
test("cross-Project copy preserves the inner shadow's stored shape", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;
  await invoke([
    "layer", "edit", layerId,
    "--inner-shadow", "0,4,0,#000000", "--inner-shadow", "4,0,0,#000000",
    "--project", projDir, "--json",
  ]);

  const proj2 = path.join(tempDir, "proj2");
  await invoke(["project", "init", proj2, "--name", "copy-proj"]);
  await invoke(["composition", "create", "copy", "--width", "400", "--height", "300", "--project", proj2, "--json"]);
  const importRes = await invoke([
    "composition", "import", "copy", "poster", "--from-project", projDir, "--project", proj2, "--json",
  ]);
  expect(importRes.code).toBe(0);
  const copyLayerId = (JSON.parse(importRes.stdout) as { layers: { layerId: string }[] }).layers[0]!.layerId;

  // The copied revision's STORED document keeps the two-element list in the
  // same field (a one-effect copy would fold back to the object form).
  const copyRevId = (JSON.parse(
    (await invoke(["layer", "inspect", copyLayerId, "--project", proj2, "--json"])).stdout,
  ) as { layer: { currentRevisionId: string } }).layer.currentRevisionId;
  const doc = JSON.parse(await readFile(path.join(proj2, "layers", `${copyLayerId}.revisions`, `${copyRevId}.json`), "utf8")) as {
    innerShadow?: unknown;
  };
  expect(doc.innerShadow).toEqual([
    { dx: 0, dy: 4, blur: 0, color: "#000000" },
    { dx: 4, dy: 0, blur: 0, color: "#000000" },
  ]);
});
test("inner shadow appears in compact output, inspect, and review facts", async () => {
  const redImg = path.join(tempDir, "red.png");
  await writeFile(redImg, solidPng(100, 60, RED));

  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", redImg, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  const textRes = await invoke([
    "layer", "edit", layerId, "--inner-shadow", "0,4,2,#000000", "--project", projDir,
  ]);
  expect(textRes.code).toBe(0);
  expect(textRes.stdout).toContain("inner shadow 0 4 2 #000000");

  const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(inspect.code).toBe(0);
  expect(inspect.stdout).toContain("Inner shadow: 0 4 2 #000000");

  // Inspect's Placement line emits effects in PAINT order (review INT-1):
  // inner shadow, then outline, then shadow.
  await invoke([
    "layer", "edit", layerId, "--outline", "2,#00ff00", "--shadow", "3,3,0,#000000", "--project", projDir,
  ]);
  const orderedInspect = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(orderedInspect.code).toBe(0);
  const placementLine =
    (orderedInspect.stdout.split("\n").find((l) => l.includes("Placement:")) ?? "") as string;
  expect(placementLine.indexOf("Inner shadow:")).toBeGreaterThan(-1);
  expect(placementLine.indexOf("Outline:")).toBeGreaterThan(-1);
  expect(placementLine.indexOf("Shadow:")).toBeGreaterThan(-1);
  expect(placementLine.indexOf("Inner shadow:")).toBeLessThan(placementLine.indexOf("Outline:"));
  expect(placementLine.indexOf("Outline:")).toBeLessThan(placementLine.indexOf("Shadow:"));

  // The layer review's facts sheet carries one row per effect, in paint
  // order (the ONE effectFactRows builder) — a shape Layer reviews without
  // generation/matting lineage (its content IS its parameters).
  const shAdd = await invoke([
    "composition", "add", "poster", "badge",
    "--shape", "rectangle", "--size", "60x40", "--fill", "#c8a232",
    "--x", "200", "--y", "100", "--inner-shadow", "0,4,2,#000000",
    "--project", projDir, "--json",
  ]);
  expect(shAdd.code).toBe(0);
  const shLayerId = (JSON.parse(shAdd.stdout) as { use: { layerId: string } }).use.layerId;
  const review = await invoke([
    "layer", "review", shLayerId, "--out", path.join(tempDir, "review.html"), "--project", projDir, "--json",
  ]);
  expect(review.code).toBe(0);
  const sheet = await readFile(path.join(tempDir, "review.html"), "utf8");
  expect(sheet).toContain(">inner shadow</th><td>0 4 2 #000000 (paint-time)</td>");
});