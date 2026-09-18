/**
 * Supersampled rendering (#184, ADR-0022): `composition render` paints the
 * Composition at an integer supersample factor of device pixels per canvas
 * pixel, then area-averages each N×N block back to exactly the canvas size
 * in premultiplied alpha, and records the factor in the Render manifest.
 * The factor is a render-quality setting, never Composition geometry.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { averageSupersampled, buildCompositionHtml, MAX_OUTLINE_DILATE_PX } from "../src/composition-paint.js";
import { encodePngRgba, readPngHeader, decodePng } from "../src/png.js";

/** Build an RGBA buffer from a per-pixel callback. */
function rgba(width: number, height: number, at: (x: number, y: number) => [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = at(x, y);
      const i = (y * width + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
    }
  }
  return buf;
}

function pixel(out: Buffer, width: number, x: number, y: number): [number, number, number, number] {
  const i = (y * width + x) * 4;
  return [out[i]!, out[i + 1]!, out[i + 2]!, out[i + 3]!];
}

test("averageSupersampled box-averages each N×N block of opaque pixels", () => {
  // A 4×4 image, factor 2: each 2×2 block of distinct grays averages to one pixel.
  const input = rgba(4, 4, (x, y) => {
    const v = 100 + x * 2 + y * 3;
    return [v, v, v, 255];
  });
  const out = averageSupersampled(input, 4, 4, 2);
  expect(out.length).toBe(2 * 2 * 4);
  // Block (0,0): values 100,102,103,105 → 410/4 = 102.5 → 103 (half up).
  expect(pixel(out, 2, 0, 0)).toEqual([103, 103, 103, 255]);
  // Block (1,0): values 104,106,107,109 → 426/4 = 106.5 → 107.
  expect(pixel(out, 2, 1, 0)).toEqual([107, 107, 107, 255]);
  // Block (0,1): values 106,108,109,111 → 434/4 = 108.5 → 109.
  expect(pixel(out, 2, 0, 1)).toEqual([109, 109, 109, 255]);
});

test("averageSupersampled averages in premultiplied alpha: transparent edges get no dark fringes", () => {
  // A 2×2 block: two opaque red pixels and two fully transparent ones.
  // A naive non-premultiplied average would halve the red channel (dark
  // fringe); the premultiplied average keeps the color pure red at the
  // averaged coverage.
  const input = rgba(2, 2, (x, y) => (x === 0 && y === 0) || (x === 1 && y === 0) ? [255, 0, 0, 255] : [0, 0, 0, 0]);
  const out = averageSupersampled(input, 2, 2, 2);
  expect(pixel(out, 1, 0, 0)).toEqual([255, 0, 0, 128]);
});

test("averageSupersampled handles a partially covered block's rounding deterministically", () => {
  // 2×2 block, three opaque white pixels and one transparent: alpha
  // (255*3)/4 = 191.25 → 191, color unpremultiplies back to pure white.
  const input = rgba(2, 2, (x, y) => (y === 0 || x === 0) ? [255, 255, 255, 255] : [0, 0, 0, 0]);
  const out = averageSupersampled(input, 2, 2, 2);
  expect(pixel(out, 1, 0, 0)).toEqual([255, 255, 255, 191]);
});

test("averageSupersampled at factor 1 is the identity for opaque pixels", () => {
  // Opaque pixels skip the premultiplied round-trip entirely (a = 255 is
  // lossless), so factor 1 reproduces the input exactly. The paint path
  // never reduces at factor 1 anyway: it returns the untouched screenshot.
  const input = rgba(3, 2, (x, y) => [x * 80, y * 100, 7, 255]);
  const out = averageSupersampled(input, 3, 2, 1);
  expect(out.equals(input)).toBe(true);
});

test("averageSupersampled refuses sizes that do not divide by the factor", () => {
  expect(() => averageSupersampled(Buffer.alloc(3 * 2 * 4), 3, 2, 2)).toThrow(/divide/);
});

test("averageSupersampled refuses a buffer that does not match the declared size", () => {
  expect(() => averageSupersampled(Buffer.alloc(3 * 3), 2, 2, 2)).toThrow(/RGBA/);
});

// ---------------------------------------------------------------------------
// Paint integration: paintComposition at a supersample factor returns
// canvas-size PNG bytes; factor 1 is byte-identical to the unscaled paint.
// ---------------------------------------------------------------------------

let tempDir: string;
let projDir: string;
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

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-supersample-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "ss-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function solidPng(width: number, height: number, rgba_: [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgba_[0]; buf[i + 1] = rgba_[1]; buf[i + 2] = rgba_[2]; buf[i + 3] = rgba_[3];
  }
  return encodePngRgba(width, height, buf);
}

test("a default render writes the canvas-size PNG and records factor 2 in the manifest", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(320, 180, [255, 0, 0, 255]));
  await invoke(["composition", "create", "thumb", "--width", "320", "--height", "180", "--project", projDir]);
  await invoke(["composition", "add", "thumb", "bg", "--image", img, "--project", projDir]);

  const res = await invoke(["composition", "render", "thumb", "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  const pngBytes = await readFile(json.render.output);
  const header = readPngHeader(pngBytes);
  expect(header.width).toBe(320);
  expect(header.height).toBe(180);
  // Interior pixels stay exactly the layer's color through the round trip.
  const decoded = decodePng(pngBytes);
  expect(Array.from(decoded.rgba.subarray(0, 4))).toEqual([255, 0, 0, 255]);

  const manifest = JSON.parse(await readFile(json.render.manifest, "utf8"));
  expect(manifest.supersample).toBe(2);
});

test("a scaled Layer paints identical geometry at every factor", async () => {
  // Regression (#184): the transform scale multiplies the painted content
  // size, so at paint factor n it must emit the composed device scale —
  // otherwise a scaled Layer shifts and shrinks when supersampling.
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(100, 60, [255, 0, 0, 255]));
  await invoke(["composition", "create", "scaled", "--width", "400", "--height", "400", "--project", projDir]);
  await invoke(["composition", "add", "scaled", "hero", "--image", img, "--x", "10", "--y", "10", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "scaled", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;
  await invoke(["layer", "edit", layerId, "--resize", "2", "--project", projDir, "--json"]);

  const one = await invoke(["composition", "render", "scaled", "--project", projDir, "--out", path.join(tempDir, "s1.png"), "--supersample", "1", "--json"]);
  const two = await invoke(["composition", "render", "scaled", "--project", projDir, "--out", path.join(tempDir, "s2.png"), "--json"]);
  expect(one.code).toBe(0);
  expect(two.code).toBe(0);

  const d1 = decodePng(await readFile(path.join(tempDir, "s1.png")));
  const d2 = decodePng(await readFile(path.join(tempDir, "s2.png")));
  expect(d1.width).toBe(400);
  expect(d2.width).toBe(400);
  const px = (d: ReturnType<typeof decodePng>, x: number, y: number) => {
    const i = (y * d.width + x) * 4;
    return [d.rgba[i]!, d.rgba[i + 1]!, d.rgba[i + 2]!, d.rgba[i + 3]!];
  };
  // The scaled Layer spans (10,10)–(210,130) canvas pixels at every factor:
  // interior stays exactly red, the outside stays transparent.
  for (const [x, y] of [[100, 60], [200, 120], [209, 129], [12, 12]]) {
    expect(px(d2, x, y)).toEqual(px(d1, x, y));
    expect(px(d2, x, y)![3]).toBe(255);
  }
  expect(px(d2, 215, 135)![3]).toBe(0);
  expect(px(d2, 5, 5)![3]).toBe(0);
});

test("a --supersample 1 render is pinned markup-identically to the pre-#184 paint", async () => {
  // Byte identity for --supersample 1 rests on the paint path being untouched:
  // the default factor (1) and the explicit 1 emit the exact same markup, the
  // same viewport and clip, and no resample. The cross-checkout comparison
  // against a pre-change render is retained as delivery evidence for #184.
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(64, 64, [0, 128, 255, 255]));
  await invoke(["composition", "create", "one", "--width", "64", "--height", "64", "--project", projDir]);
  await invoke(["composition", "add", "one", "bg", "--image", img, "--project", projDir]);

  const forced = await invoke(["composition", "render", "one", "--project", projDir, "--out", path.join(tempDir, "forced.png"), "--supersample", "1", "--json"]);
  expect(forced.code).toBe(0);
  const manifest = JSON.parse(await readFile(JSON.parse(forced.stdout).render.manifest, "utf8"));
  expect(manifest.supersample).toBe(1);
  // A factor-1 manifest replays byte-identically: the recorded factor alone
  // reproduces the pre-#184 pixels.
  const replay = await invoke(["composition", "replay", JSON.parse(forced.stdout).render.manifest, "--project", projDir, "--out", path.join(tempDir, "replayed.png"), "--json"]);
  expect(replay.code).toBe(0);
  expect((await readFile(path.join(tempDir, "replayed.png"))).equals(await readFile(path.join(tempDir, "forced.png")))).toBe(true);
});

test("a supersampled render's manifest replays byte-identically at the recorded factor", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(64, 64, [200, 40, 90, 255]));
  await invoke(["composition", "create", "replayable", "--width", "64", "--height", "64", "--project", projDir]);
  await invoke(["composition", "add", "replayable", "bg", "--image", img, "--project", projDir]);

  const render = await invoke(["composition", "render", "replayable", "--project", projDir, "--json"]);
  expect(render.code).toBe(0);
  const rendered = JSON.parse(render.stdout);
  const original = await readFile(rendered.render.output);

  const replay = await invoke(["composition", "replay", rendered.render.manifest, "--project", projDir, "--json"]);
  expect(replay.code).toBe(0);
  const replayed = JSON.parse(replay.stdout);
  expect((await readFile(replayed.replay.output)).equals(original)).toBe(true);

  // The replayed render is itself retained history at the same factor.
  const replayManifest = JSON.parse(await readFile(replayed.replay.manifest, "utf8"));
  expect(replayManifest.supersample).toBe(2);
});

test("a manifest without a recorded factor parses as factor 1 and replays byte-identically", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(64, 64, [10, 200, 30, 255]));
  await invoke(["composition", "create", "legacy", "--width", "64", "--height", "64", "--project", projDir]);
  await invoke(["composition", "add", "legacy", "bg", "--image", img, "--project", projDir]);

  const render = await invoke(["composition", "render", "legacy", "--project", projDir, "--supersample", "1", "--json"]);
  expect(render.code).toBe(0);
  const rendered = JSON.parse(render.stdout);
  const original = await readFile(rendered.render.output);

  // Simulate a manifest written before #184: no supersample field. Replay
  // requires the manifest inside the Project, so stage it under renders/.
  const manifestPath = path.join(projDir, "renders", "legacy.manifest.json");
  const manifest = JSON.parse(await readFile(rendered.render.manifest, "utf8"));
  delete manifest.supersample;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const replay = await invoke(["composition", "replay", manifestPath, "--project", projDir, "--json"]);
  expect(replay.code).toBe(0);
  const replayed = JSON.parse(replay.stdout);
  expect((await readFile(replayed.replay.output)).equals(original)).toBe(true);
  const replayManifest = JSON.parse(await readFile(replayed.replay.manifest, "utf8"));
  expect(replayManifest.supersample).toBe(1);
});

test.each(["0", "1.5", "-2"])("--supersample %s is refused as a usage error with exit 2", async (value) => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(32, 32, [255, 0, 0, 255]));
  await invoke(["composition", "create", "bad", "--width", "32", "--height", "32", "--project", projDir]);
  await invoke(["composition", "add", "bad", "bg", "--image", img, "--project", projDir]);

  const res = await invoke(["composition", "render", "bad", "--project", projDir, "--supersample", value, "--json"]);
  expect(res.code).toBe(2);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(false);
  expect(json.error).toContain("--supersample");
  expect((await readdir(path.join(projDir, "renders"))).filter((f) => f.endsWith(".png"))).toHaveLength(0);
});

test("a canvas that fits at 1× but exceeds the paint limit at 2× is refused by default, naming the fix", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(64, 64, [255, 0, 0, 255]));
  // 4096×2048 = 8.4M pixels: within the limits at 1×, over them at 2×.
  await invoke(["composition", "create", "huge", "--width", "4096", "--height", "2048", "--project", projDir]);
  await invoke(["composition", "add", "huge", "bg", "--image", img, "--project", projDir]);

  const res = await invoke(["composition", "render", "huge", "--project", projDir, "--json"]);
  expect(res.code).toBe(1);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(false);
  expect(json.error).toContain("supersample");
  expect(json.error).toContain("8192");
  expect((await readdir(path.join(projDir, "renders"))).filter((f) => f.endsWith(".png"))).toHaveLength(0);

  // The same canvas renders at 1× when asked explicitly.
  const ok = await invoke(["composition", "render", "huge", "--project", projDir, "--supersample", "1", "--json"]);
  expect(ok.code).toBe(0);
});

test("along a diagonal edge, the 2× coverage ramp steps more evenly than the 1× ramp", async () => {
  // The ADR-0022 evidence: Chromium shapes glyphs at their final size, so a
  // 1× diagonal edge's coverage steps unevenly; painting at 2× and
  // area-averaging evens the ramp. Metric: for every column ramp crossing a
  // diagonal edge (≥4 intermediate alpha values between 255 above and 0
  // below), the spread (max − min) of its interior steps; the median spread
  // across ramps measures the evenness of the typical edge.
  await invoke(["composition", "create", "diag", "--width", "800", "--height", "300", "--project", projDir]);
  await invoke([
    "composition", "add", "diag", "bigw", "--text", "WW", "--font", "Archivo Black",
    "--font-size", "150", "--color", "#ffffff", "--x", "40", "--y", "60", "--project", projDir,
  ]);
  const one = await invoke(["composition", "render", "diag", "--project", projDir, "--out", path.join(tempDir, "w1.png"), "--supersample", "1", "--json"]);
  const two = await invoke(["composition", "render", "diag", "--project", projDir, "--out", path.join(tempDir, "w2.png"), "--json"]);
  expect(one.code).toBe(0);
  expect(two.code).toBe(0);

  const medianSpread = async (file: string) => {
    const d = decodePng(await readFile(file));
    const spreads: number[] = [];
    for (let x = 20; x < d.width - 20; x++) {
      for (let y = 20; y < d.height - 20; y++) {
        if (d.rgba[(y * d.width + x) * 4 + 3]! > 0 && d.rgba[(y * d.width + x) * 4 + 3]! < 255) {
          let j = y;
          while (
            j < d.height - 1 &&
            d.rgba[(j * d.width + x) * 4 + 3]! > 0 && d.rgba[(j * d.width + x) * 4 + 3]! < 255
          ) j++;
          const run: number[] = [];
          for (let m = y; m < j; m++) run.push(d.rgba[(m * d.width + x) * 4 + 3]!);
          const above = y === 0 ? 255 : d.rgba[((y - 1) * d.width + x) * 4 + 3]!;
          const below = j === d.height ? 0 : d.rgba[(j * d.width + x) * 4 + 3]!;
          if (run.length >= 4 && above === 255 && below === 0) {
            const deltas = run.slice(1).map((v, i) => Math.abs(v - run[i]!));
            spreads.push(Math.max(...deltas) - Math.min(...deltas));
          }
          y = j;
        }
      }
    }
    expect(spreads.length).toBeGreaterThan(20);
    spreads.sort((a, b) => a - b);
    return spreads[Math.floor(spreads.length / 2)]!;
  };

  const oneMedian = await medianSpread(path.join(tempDir, "w1.png"));
  const twoMedian = await medianSpread(path.join(tempDir, "w2.png"));
  expect(twoMedian).toBeLessThan(oneMedian / 2);
});

test("replay refuses --supersample: the factor comes from the manifest alone", async () => {
  const res = await invoke(["composition", "replay", "nope.manifest.json", "--project", projDir, "--supersample", "2", "--json"]);
  expect(res.code).toBe(2);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(false);
  expect(json.error).toContain("--supersample");
});

test("an outline whose raster dilate exceeds Chromium's cap is refused before painting", async () => {
  // Width 200 is legal --outline input (0–256), but at the default factor 2
  // the dilate rasterizes at 400 raster pixels — over the 256 px kernel cap.
  // The render refuses loudly instead of silently clipping the ring
  // (INT-EDGE-1 / PROD-EDGE-1 / BND-1, ADR-0022: a render never degrades on
  // its own). Boundary widths come from the one constant, never a second copy.
  const atCap = Math.floor(MAX_OUTLINE_DILATE_PX / 2); // 128 × 2 = 256: exactly at the cap
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(64, 64, [255, 0, 0, 255]));
  await invoke(["composition", "create", "ringy", "--width", "400", "--height", "400", "--project", projDir]);
  await invoke(["composition", "add", "ringy", "hero", "--image", img, "--x", "150", "--y", "150", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "ringy", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;
  await invoke(["layer", "edit", layerId, "--outline", `200,#0000ff`, "--project", projDir, "--json"]);

  const refused = await invoke(["composition", "render", "ringy", "--project", projDir, "--json"]);
  expect(refused.code).toBe(1);
  const err = JSON.parse(refused.stdout).error;
  expect(err).toContain("hero");
  expect(err).toContain("200px outline");
  expect(err).toContain("supersample 2");
  expect(err).toContain("400 raster pixels");
  expect(err).toContain("--supersample 1");
  expect(err).toContain("thinner outline");
  // No output was published.
  expect((await readdir(path.join(projDir, "renders"))).filter((f) => f.endsWith(".png"))).toHaveLength(0);

  // Exactly at the cap (width 128 × factor 2 = 256) renders the full ring.
  await invoke(["layer", "edit", layerId, "--outline", `${atCap},#0000ff`, "--project", projDir, "--json"]);
  const atCapRes = await invoke(["composition", "render", "ringy", "--project", projDir, "--out", path.join(tempDir, "atcap.png"), "--json"]);
  expect(atCapRes.code).toBe(0);
  // One past the cap is refused.
  await invoke(["layer", "edit", layerId, "--outline", `${atCap + 1},#0000ff`, "--project", projDir, "--json"]);
  const over = await invoke(["composition", "render", "ringy", "--project", projDir, "--json"]);
  expect(over.code).toBe(1);
  expect(JSON.parse(over.stdout).error).toContain("dilate cap");

  // The same outline paints in full at --supersample 1 (width × 1 ≤ cap).
  await invoke(["layer", "edit", layerId, "--outline", `200,#0000ff`, "--project", projDir, "--json"]);
  const direct = await invoke(["composition", "render", "ringy", "--project", projDir, "--supersample", "1", "--out", path.join(tempDir, "direct.png"), "--json"]);
  expect(direct.code).toBe(0);
});

test("replay refuses a manifest whose recorded factor would clip an outline", async () => {
  // A render never writes such a manifest (the render boundary refuses), so
  // the only way to reach one is stored history: a factor-1 render whose
  // manifest is later recorded with a clipping factor must be refused at
  // replay, not silently clipped.
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(64, 64, [200, 40, 90, 255]));
  await invoke(["composition", "create", "legacy-ring", "--width", "400", "--height", "400", "--project", projDir]);
  await invoke(["composition", "add", "legacy-ring", "hero", "--image", img, "--x", "150", "--y", "150", "--project", projDir]);
  const layerId = JSON.parse(
    (await invoke(["composition", "inspect", "legacy-ring", "--project", projDir, "--json"])).stdout,
  ).composition.layers[0]!.layerId;
  await invoke(["layer", "edit", layerId, "--outline", `200,#0000ff`, "--project", projDir, "--json"]);

  const render = await invoke(["composition", "render", "legacy-ring", "--project", projDir, "--supersample", "1", "--json"]);
  expect(render.code).toBe(0);
  const rendered = JSON.parse(render.stdout);

  // Tamper the stored manifest's factor up to one that would clip.
  const tampered = path.join(projDir, "renders", "tampered.manifest.json");
  const manifest = JSON.parse(await readFile(rendered.render.manifest, "utf8"));
  manifest.supersample = 2;
  await writeFile(tampered, JSON.stringify(manifest, null, 2) + "\n");

  const before = (await readdir(path.join(projDir, "renders"))).filter((f) => f.endsWith(".png")).length;
  const replay = await invoke(["composition", "replay", tampered, "--project", projDir, "--json"]);
  expect(replay.code).toBe(1);
  expect(JSON.parse(replay.stdout).error).toContain("hero");
  expect(JSON.parse(replay.stdout).error).toContain("dilate cap");
  expect((await readdir(path.join(projDir, "renders"))).filter((f) => f.endsWith(".png")).length).toBe(before);
});

test("the unsupersampled markup is emitted identically at the default and explicit factor 1", () => {
  // The default buildCompositionHtml call (guidelines, measurement) and an
  // explicit factor 1 produce the exact same markup string — the byte-identity
  // foundation for --supersample 1 and for unchanged review views. A factor
  // above 1 adds only the one device transform on #canvas; the canvas-px
  // geometry inside the markup never changes (#184, ADR-0022).
  const canvas = { width: 128, height: 64 };
  expect(buildCompositionHtml(canvas, [])).toBe(buildCompositionHtml(canvas, [], 1));
  expect(buildCompositionHtml(canvas, [])).toContain("width:128px");
  const supersampled = buildCompositionHtml(canvas, [], 2);
  expect(supersampled).toContain("width:128px");
  expect(supersampled).toContain("transform:scale(2);transform-origin:0 0");
});