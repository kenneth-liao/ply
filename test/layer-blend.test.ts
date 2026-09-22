/**
 * Rendered-pixel and CLI seam tests for Layer blend modes (#220, spec #218 US-003,
 * DEC-001, DEC-002, DEC-004, DEC-007, DEC-009..011, TEST-004, TEST-008).
 *
 * Assertions:
 * - Multiply of a white-background fixture over a coloured backdrop leaves the backdrop
 *   colour where the fixture was white (TEST-004).
 * - Screen of a black-background fixture over a coloured backdrop leaves the backdrop
 *   where the fixture was black (TEST-004).
 * - Unknown mode is refused before publication listing the allowed set (TEST-004).
 * - A Layer with outline, shadow, and opacity blends as ONE unit against everything
 *   beneath it (DEC-002).
 * - Behaviour over a transparent canvas region is asserted (DEC-007).
 * - A Layer imported from another Composition keeps its mode and blends against the
 *   importing Composition's backdrop.
 * - inspect, measure, and layer review report the mode; a Render with a blend mode
 *   replays byte-identically.
 * - Absolute setter: normal removes the stored fact.
 * - Shape and text Layers support blend mode uniformly.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { encodePngRgba, decodePng } from "../src/png.js";
import { normalizeStoredBlend } from "../src/layer.js";

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
    buf[i] = rgba[0];
    buf[i + 1] = rgba[1];
    buf[i + 2] = rgba[2];
    buf[i + 3] = rgba[3];
  }
  return encodePngRgba(width, height, buf);
}

function splitFixturePng(
  width: number,
  height: number,
  leftRgba: [number, number, number, number],
  rightRgba: [number, number, number, number],
): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  const midX = Math.floor(width / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const col = x < midX ? leftRgba : rightRgba;
      buf[idx] = col[0];
      buf[idx + 1] = col[1];
      buf[idx + 2] = col[2];
      buf[idx + 3] = col[3];
    }
  }
  return encodePngRgba(width, height, buf);
}

function pixel(png: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number, number] {
  const idx = (y * png.width + x) * 4;
  return [png.rgba[idx]!, png.rgba[idx + 1]!, png.rgba[idx + 2]!, png.rgba[idx + 3]!];
}

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-blend-"));
  projDir = path.join(tempDir, "proj");
  const init = await invoke(["project", "init", projDir]);
  expect(init.code).toBe(0);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComp(name: string, width = 400, height = 300) {
  const res = await invoke([
    "composition",
    "create",
    name,
    "--width",
    String(width),
    "--height",
    String(height),
    "--project",
    projDir,
  ]);
  expect(res.code).toBe(0);
}

async function addImageLayer(
  comp: string,
  localName: string,
  imgPath: string,
  opts: { x?: number; y?: number; opacity?: number; blend?: string } = {},
) {
  const args = ["composition", "add", comp, localName, "--image", imgPath, "--project", projDir, "--json"];
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  if (opts.opacity !== undefined) args.push("--opacity", String(opts.opacity));
  if (opts.blend !== undefined) args.push("--blend", opts.blend);
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

async function addShapeLayer(
  comp: string,
  localName: string,
  shape: string,
  opts: { size?: string; fill?: string; x?: number; y?: number; blend?: string } = {},
) {
  const args = ["composition", "add", comp, localName, "--shape", shape, "--project", projDir, "--json"];
  if (opts.size !== undefined) args.push("--size", opts.size);
  if (opts.fill !== undefined) args.push("--fill", opts.fill);
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  if (opts.blend !== undefined) args.push("--blend", opts.blend);
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

async function addTextLayer(
  comp: string,
  localName: string,
  text: string,
  opts: { fontSize?: number; color?: string; x?: number; y?: number; blend?: string } = {},
) {
  const args = ["composition", "add", comp, localName, "--text", text, "--font", "Archivo", "--project", projDir, "--json"];
  if (opts.fontSize !== undefined) args.push("--font-size", String(opts.fontSize));
  if (opts.color !== undefined) args.push("--color", opts.color);
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  if (opts.blend !== undefined) args.push("--blend", opts.blend);
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

test("normalizeStoredBlend validates modes and drops neutral normal", () => {
  expect(normalizeStoredBlend({})).toBeUndefined();
  expect(normalizeStoredBlend({ blend: undefined })).toBeUndefined();
  expect(normalizeStoredBlend({ blend: "normal" })).toBeUndefined();
  expect(normalizeStoredBlend({ blend: "multiply" })).toBe("multiply");
  expect(normalizeStoredBlend({ blend: "screen" })).toBe("screen");
  expect(normalizeStoredBlend({ blend: "overlay" })).toBe("overlay");
  expect(normalizeStoredBlend({ blend: "soft-light" })).toBe("soft-light");
  expect(normalizeStoredBlend({ blend: "darken" })).toBe("darken");
  expect(normalizeStoredBlend({ blend: "lighten" })).toBe("lighten");
  expect(normalizeStoredBlend({ blend: "color-dodge" })).toBe("color-dodge");

  expect(() => normalizeStoredBlend({ blend: 123 })).toThrow(/Malformed revision document: blend must be a string/);
  expect(() => normalizeStoredBlend({ blend: "banana" })).toThrow(/Malformed revision document: unknown blend mode "banana"/);
});

test("blend mode setter validates allowed set and refuses unknown mode listing the set", async () => {
  const imgFile = path.join(tempDir, "sample.png");
  await writeFile(imgFile, solidPng(100, 100, [128, 128, 128, 255]));
  await makeComp("poster", 400, 300);
  const addRes = await addImageLayer("poster", "hero", imgFile, { x: 50, y: 50 });
  const layerId = addRes.use.layerId as string;

  const badRes = await invoke(["layer", "edit", layerId, "--blend", "banana", "--project", projDir]);
  expect(badRes.code).toBe(2);
  expect(badRes.stderr).toContain("Blend mode (--blend) takes normal, multiply, screen, overlay, soft-light, darken, lighten, or color-dodge (got \"banana\").");

  // Also refused on composition add
  const badAdd = await invoke(["composition", "add", "poster", "bad", "--image", imgFile, "--blend", "bogus", "--project", projDir]);
  expect(badAdd.code).toBe(2);
  expect(badAdd.stderr).toContain("Blend mode (--blend) takes normal, multiply, screen, overlay, soft-light, darken, lighten, or color-dodge (got \"bogus\").");
});

test("multiply of a white-background fixture over a coloured backdrop leaves the backdrop colour where the fixture was white (TEST-004)", async () => {
  await makeComp("comp", 200, 200);

  // Red backdrop: (255, 0, 0, 255) across 200x200
  const bgFile = path.join(tempDir, "red-bg.png");
  await writeFile(bgFile, solidPng(200, 200, [255, 0, 0, 255]));
  await addImageLayer("comp", "bg", bgFile, { x: 0, y: 0 });

  // Foreground: split 100x100 fixture (left half black [0,0,0,255], right half white [255,255,255,255])
  const fgFile = path.join(tempDir, "split-fg.png");
  await writeFile(fgFile, splitFixturePng(100, 100, [0, 0, 0, 255], [255, 255, 255, 255]));

  // Add with --blend multiply
  await addImageLayer("comp", "fg", fgFile, { x: 50, y: 50, blend: "multiply" });

  const renderOut = path.join(tempDir, "multiply.png");
  const res = await invoke(["composition", "render", "comp", "--project", projDir, "--out", renderOut, "--supersample", "1"]);
  expect(res.code).toBe(0);

  const rendered = decodePng(await readFile(renderOut));

  // Pixel on the right half of the foreground (x=120, y=100) was white in fixture:
  // white (1,1,1) * red (1,0,0) = red (255, 0, 0)
  const whiteMultiplied = pixel(rendered, 120, 100);
  expect(whiteMultiplied).toEqual([255, 0, 0, 255]);

  // Pixel on the left half of the foreground (x=70, y=100) was black in fixture:
  // black (0,0,0) * red (1,0,0) = black (0, 0, 0)
  const blackMultiplied = pixel(rendered, 70, 100);
  expect(blackMultiplied).toEqual([0, 0, 0, 255]);

  // Pixel outside the foreground (x=10, y=10) remains untouched backdrop red
  const backdropPx = pixel(rendered, 10, 10);
  expect(backdropPx).toEqual([255, 0, 0, 255]);
});

test("screen of a black-background fixture leaves the backdrop where it was black (TEST-004)", async () => {
  await makeComp("comp", 200, 200);

  // Blue backdrop: (0, 0, 255, 255)
  const bgFile = path.join(tempDir, "blue-bg.png");
  await writeFile(bgFile, solidPng(200, 200, [0, 0, 255, 255]));
  await addImageLayer("comp", "bg", bgFile, { x: 0, y: 0 });

  // Foreground: split 100x100 fixture (left half black [0,0,0,255], right half white [255,255,255,255])
  const fgFile = path.join(tempDir, "split-fg.png");
  await writeFile(fgFile, splitFixturePng(100, 100, [0, 0, 0, 255], [255, 255, 255, 255]));

  // Add with --blend screen
  await addImageLayer("comp", "fg", fgFile, { x: 50, y: 50, blend: "screen" });

  const renderOut = path.join(tempDir, "screen.png");
  const res = await invoke(["composition", "render", "comp", "--project", projDir, "--out", renderOut, "--supersample", "1"]);
  expect(res.code).toBe(0);

  const rendered = decodePng(await readFile(renderOut));

  // Pixel on left half (x=70, y=100) was black:
  // screen(black, blue) = blue (0, 0, 255)
  const blackScreened = pixel(rendered, 70, 100);
  expect(blackScreened).toEqual([0, 0, 255, 255]);

  // Pixel on right half (x=120, y=100) was white:
  // screen(white, blue) = white (255, 255, 255)
  const whiteScreened = pixel(rendered, 120, 100);
  expect(whiteScreened).toEqual([255, 255, 255, 255]);
});

test("a Layer with outline, shadow, and opacity blends as ONE unit (DEC-002)", async () => {
  await makeComp("comp", 300, 300);

  // Red backdrop
  const bgFile = path.join(tempDir, "red-bg.png");
  await writeFile(bgFile, solidPng(300, 300, [255, 0, 0, 255]));
  await addImageLayer("comp", "bg", bgFile, { x: 0, y: 0 });

  // Foreground: 60x60 white box with white outline, white shadow, opacity 0.8, and blend multiply
  // Under multiply: white content + white outline + white shadow all multiply with red backdrop to produce pure red backdrop pixels!
  const whiteBox = path.join(tempDir, "white-box.png");
  await writeFile(whiteBox, solidPng(60, 60, [255, 255, 255, 255]));

  const addFg = await invoke([
    "composition", "add", "comp", "fg",
    "--image", whiteBox,
    "--x", "100", "--y", "100",
    "--opacity", "0.8",
    "--outline", "10,#ffffff",
    "--shadow", "10,10,0,#ffffff",
    "--blend", "multiply",
    "--project", projDir,
    "--json",
  ]);
  expect(addFg.code).toBe(0);

  const renderOut = path.join(tempDir, "effects-unit.png");
  const res = await invoke(["composition", "render", "comp", "--project", projDir, "--out", renderOut, "--supersample", "1"]);
  expect(res.code).toBe(0);

  const rendered = decodePng(await readFile(renderOut));

  // The white box interior (x=130, y=130): white blended over red backdrop -> red
  const interior = pixel(rendered, 130, 130);
  expect(interior).toEqual([255, 0, 0, 255]);

  // The outline area (x=95, y=130): white outline multiplied over red backdrop -> red
  const outlinePx = pixel(rendered, 95, 130);
  expect(outlinePx).toEqual([255, 0, 0, 255]);

  // The shadow area (x=165, y=165): white shadow multiplied over red backdrop -> red
  const shadowPx = pixel(rendered, 165, 165);
  expect(shadowPx).toEqual([255, 0, 0, 255]);
});

test("transparent-canvas behaviour follows browser compositing without special casing (DEC-007)", async () => {
  await makeComp("transparent-comp", 200, 200);

  // No backdrop Layer added: canvas is transparent.
  // Add a green square with blend multiply
  const greenSquare = path.join(tempDir, "green.png");
  await writeFile(greenSquare, solidPng(50, 50, [0, 255, 0, 255]));

  await addImageLayer("transparent-comp", "box", greenSquare, { x: 50, y: 50, blend: "multiply" });

  const renderOut = path.join(tempDir, "transparent-canvas.png");
  const res = await invoke(["composition", "render", "transparent-comp", "--project", projDir, "--out", renderOut, "--supersample", "1"]);
  expect(res.code).toBe(0);

  const rendered = decodePng(await readFile(renderOut));

  // Where there is no backdrop, the Layer composites against transparency:
  // Inside the square: green with full alpha
  const boxPx = pixel(rendered, 75, 75);
  expect(boxPx).toEqual([0, 255, 0, 255]);

  // Outside the square: transparent
  const outsidePx = pixel(rendered, 10, 10);
  expect(outsidePx).toEqual([0, 0, 0, 0]);
});

test("setting blend to normal removes the stored fact; omitted keeps existing mode", async () => {
  await makeComp("comp", 200, 200);
  const imgFile = path.join(tempDir, "img.png");
  await writeFile(imgFile, solidPng(50, 50, [100, 100, 100, 255]));

  const addRes = await addImageLayer("comp", "box", imgFile, { blend: "overlay" });
  const layerId = addRes.use.layerId as string;
  expect(addRes.layer.currentRevision.blend).toBe("overlay");

  // An edit without --blend keeps the mode
  const editKeep = await invoke(["layer", "edit", layerId, "--x", "10", "--project", projDir, "--json"]);
  expect(editKeep.code).toBe(0);
  expect(JSON.parse(editKeep.stdout).layer.currentRevision.blend).toBe("overlay");

  // Setting --blend normal removes the stored fact
  const editRemove = await invoke(["layer", "edit", layerId, "--blend", "normal", "--project", projDir, "--json"]);
  expect(editRemove.code).toBe(0);
  expect(JSON.parse(editRemove.stdout).layer.currentRevision.blend).toBeUndefined();

  // Accept colour-dodge spelling and normalize to color-dodge
  const editDodge = await invoke(["layer", "edit", layerId, "--blend", "colour-dodge", "--project", projDir, "--json"]);
  expect(editDodge.code).toBe(0);
  expect(JSON.parse(editDodge.stdout).layer.currentRevision.blend).toBe("color-dodge");
});

test("shape and text Layers support blend mode uniformly", async () => {
  await makeComp("comp", 300, 200);

  // Shape layer with blend
  const sRes = await addShapeLayer("comp", "badge", "rectangle", {
    size: "60x60",
    fill: "#ffffff",
    x: 20,
    y: 20,
    blend: "multiply",
  });
  expect(sRes.layer.currentRevision.blend).toBe("multiply");

  // Text layer with blend
  const tRes = await addTextLayer("comp", "headline", "TEXT", {
    fontSize: 30,
    color: "#ffffff",
    x: 100,
    y: 20,
    blend: "screen",
  });
  expect(tRes.layer.currentRevision.blend).toBe("screen");
});

test("inspect, measure, and layer review report blend mode; render replays byte-identically", async () => {
  await makeComp("comp", 200, 200);
  const imgFile = path.join(tempDir, "img.png");
  await writeFile(imgFile, solidPng(50, 50, [100, 100, 100, 255]));

  const imgBytes = await readFile(imgFile);
  const contentHash = createHash("sha256").update(imgBytes).digest("hex");
  const jobRecord = {
    schemaVersion: 2,
    jobId: "gen-1",
    kind: "generation",
    createdAt: new Date().toISOString(),
    request: {
      prompt: "a test box",
      intent: "isolated",
      model: "mock-model",
      sizing: { kind: "size", width: 50, height: 50 },
      count: 1,
      references: [],
    },
    run: {
      ranAt: new Date().toISOString(),
      model: "mock-model",
      fullPrompt: "a test box",
      cost: { basis: "unknown" },
      warnings: [],
      outputs: [
        {
          contentHash,
          file: "outputs/output-1.png",
          mediaType: "image/png",
        },
      ],
    },
  };
  await mkdir(path.join(projDir, "generation", "gen-1", "outputs"), { recursive: true });
  await writeFile(path.join(projDir, "generation", "gen-1", "outputs", "output-1.png"), imgBytes);
  await writeFile(path.join(projDir, "generation", "gen-1", "job.json"), JSON.stringify(jobRecord));

  const addRes = await addImageLayer("comp", "box", imgFile, { blend: "soft-light", x: 20, y: 20 });
  const layerId = addRes.use.layerId as string;

  // inspect reports the mode
  const insp = await invoke(["layer", "inspect", layerId, "--project", projDir]);
  expect(insp.code).toBe(0);
  expect(insp.stdout).toContain("Blend: soft-light");

  // measure reports the mode
  const meas = await invoke(["composition", "measure", "comp", "--project", projDir, "--json"]);
  expect(meas.code).toBe(0);
  const measJson = JSON.parse(meas.stdout);
  expect(measJson.layers[0].blend).toBe("soft-light");

  // layer review reports the mode for image layer
  const reviewOut = path.join(tempDir, "review.html");
  const revRes = await invoke(["layer", "review", layerId, "--out", reviewOut, "--project", projDir]);
  expect(revRes.code).toBe(0);
  const reviewHtml = await readFile(reviewOut, "utf-8");
  expect(reviewHtml).toContain("blend mode");
  expect(reviewHtml).toContain("soft-light (paint-time)");

  // layer review also reports the mode for a shape layer
  const shRes = await invoke([
    "composition", "add", "comp", "sh",
    "--shape", "rectangle", "--size", "60x40", "--fill", "#ff0000",
    "--blend", "multiply",
    "--project", projDir, "--json",
  ]);
  expect(shRes.code).toBe(0);
  const shLayerId = JSON.parse(shRes.stdout).use.layerId as string;
  const shReviewOut = path.join(tempDir, "sh-review.html");
  const shRevRes = await invoke(["layer", "review", shLayerId, "--out", shReviewOut, "--project", projDir]);
  expect(shRevRes.code).toBe(0);
  const shHtml = await readFile(shReviewOut, "utf-8");
  expect(shHtml).toContain("blend mode");
  expect(shHtml).toContain("multiply (paint-time)");

  // Render and verify byte-identical replay
  const render1 = path.join(tempDir, "r1.png");
  const r1 = await invoke(["composition", "render", "comp", "--project", projDir, "--out", render1, "--supersample", "1", "--json"]);
  expect(r1.code).toBe(0);
  const r1Json = JSON.parse(r1.stdout);
  const manifestPath = r1Json.render.manifest as string;

  const replayOut = path.join(tempDir, "replay.png");
  const rep = await invoke(["composition", "replay", manifestPath, "--project", projDir, "--out", replayOut]);
  expect(rep.code).toBe(0);

  const b1 = await readFile(render1);
  const b2 = await readFile(replayOut);
  expect(b1.equals(b2)).toBe(true);
});

test("a Layer imported from another Composition keeps its mode and blends against the importing Composition's backdrop", async () => {
  await makeComp("source-comp", 200, 200);
  await makeComp("target-comp", 200, 200);

  // Target composition has a red backdrop
  const bgFile = path.join(tempDir, "red.png");
  await writeFile(bgFile, solidPng(200, 200, [255, 0, 0, 255]));
  await addImageLayer("target-comp", "bg", bgFile, { x: 0, y: 0 });

  // Source composition has a white square with blend multiply
  const whiteFile = path.join(tempDir, "white.png");
  await writeFile(whiteFile, solidPng(60, 60, [255, 255, 255, 255]));
  await addImageLayer("source-comp", "badge", whiteFile, { x: 50, y: 50, blend: "multiply" });

  // Import source into target
  const imp = await invoke(["composition", "import", "target-comp", "source-comp", "--project", projDir]);
  expect(imp.code).toBe(0);

  // Render target: imported white square multiplies against red backdrop leaving red
  const renderOut = path.join(tempDir, "imported-render.png");
  const res = await invoke(["composition", "render", "target-comp", "--project", projDir, "--out", renderOut, "--supersample", "1"]);
  expect(res.code).toBe(0);

  const rendered = decodePng(await readFile(renderOut));
  const px = pixel(rendered, 75, 75);
  expect(px).toEqual([255, 0, 0, 255]);
});
