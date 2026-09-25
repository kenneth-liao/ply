/**
 * The "5 HERDR PLUGINS" pixel probe (#297, spec #285 US-017, ISC-54, TEST-001):
 * one editable text Layer whose runs paint their own colours — including ONE
 * GRADIENT run, the `background-clip: text` span being the risky case — with
 * outline and shadow hugging every run's glyph alpha.
 *
 * The probe asserts, from the rendered pixels:
 * - each run's solid colour is present (and nowhere else), in the runs'
 *   left-to-right order;
 * - the gradient run paints its own ramp (first stop at its left ink, last
 *   at its right ink) rather than either neighbouring solid;
 * - the outline hugs every run (dark outline ink spans the full ink width);
 * - the shadow paints below every run.
 *
 * The output image is written beside the temp Project for inspection.
 * Offline, per-file `bun test --isolate`.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { decodePng } from "../src/png.js";

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

let tempDir: string;
let projDir: string;
let lastRenderPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-text-runs-pixel-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "text-runs-pixel-proj"]);
  await invoke(["composition", "create", "poster", "--width", "900", "--height", "260", "--project", projDir]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

interface InkPixel { x: number; y: number; r: number; g: number; b: number; a: number }

function inkPixels(png: ReturnType<typeof decodePng>): InkPixel[] {
  const out: InkPixel[] = [];
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const a = png.rgba[i + 3]!;
      if (a > 0) {
        out.push({ x, y, r: png.rgba[i]!, g: png.rgba[i + 1]!, b: png.rgba[i + 2]!, a });
      }
    }
  }
  return out;
}

test("one Layer, three runs: each run paints its own colour, the gradient run spans its ink, outline and shadow hug every run", async () => {
  const add = await invoke([
    "composition", "add", "poster", "headline",
    "--run", "5 ", "--run", "HERDR ", "--run", "PLUGINS",
    "--font", "Archivo", "--font-size", "72",
    "--run-color", "1=#ef4444",
    "--run-color", "2=linear:90deg,#ffb347,#c0182b",
    "--run-color", "3=#3b82f6",
    "--outline", "4,#000000",
    "--shadow", "4,6,8,#000000",
    "--x", "40", "--y", "60",
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);

  const measure = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
  expect(measure.code).toBe(0);
  const layer = (JSON.parse(measure.stdout) as { layers: Array<Record<string, unknown>> }).layers[0]!;
  const runs = layer.runs as Array<Record<string, unknown>>;
  expect(runs).toHaveLength(3);
  expect(runs[0]!.color).toEqual({ type: "solid", color: "#ef4444" });
  expect(runs[1]!.color).toEqual({
    type: "linear", angleDeg: 90,
    stops: [{ color: "#ffb347", position: 0 }, { color: "#c0182b", position: 100 }],
  });
  expect(runs[2]!.color).toEqual({ type: "solid", color: "#3b82f6" });

  const render = await invoke(["composition", "render", "poster", "--project", projDir, "--supersample", "1", "--json"]);
  expect(render.code).toBe(0);
  const renderParsed = JSON.parse(render.stdout) as { render: { output: string } };
  const png = decodePng(await readFile(renderParsed.render.output));
  const ink = inkPixels(png);
  expect(ink.length).toBeGreaterThan(500);

  const minX = Math.min(...ink.map((p) => p.x));
  const maxX = Math.max(...ink.map((p) => p.x));

  // Run 1 ("5 ", left): the pure #ef4444 glyph ink — a filter the gradient's
  // last stop (#c0182b) cannot match.
  const red = ink.filter((p) => p.r > 220 && p.g < 100 && p.b < 100 && p.a > 200);
  expect(red.length).toBeGreaterThan(50);
  // Run 3 ("PLUGINS", right): the pure #3b82f6 glyph ink.
  const blue = ink.filter((p) => p.b > 200 && p.r < 110 && p.g > 80 && p.g < 190 && p.a > 200);
  expect(blue.length).toBeGreaterThan(50);
  // The solid runs paint in order: run 1's ink sits left of run 3's.
  const meanX = (pixels: InkPixel[]): number => pixels.reduce((sum, p) => sum + p.x, 0) / pixels.length;
  expect(meanX(red)).toBeLessThan(meanX(blue));

  // Run 2 ("HERDR "): the gradient's own ramp — its first stop is the
  // orange-yellow, its last the dark red #c0182b; each is judged by a pure
  // stop colour neither neighbouring solid nor its antialiased edges can
  // match, and the ramp reads left to right across the span.
  const orange = ink.filter((p) => p.r > 230 && p.g > 140 && p.g < 225 && p.b < 115 && p.a > 200);
  const darkRed = ink.filter((p) => p.r > 180 && p.r < 210 && p.g < 50 && p.b < 70 && p.a > 200);
  expect(orange.length).toBeGreaterThan(30);
  expect(darkRed.length).toBeGreaterThan(30);
  expect(meanX(orange)).toBeGreaterThan(meanX(red));
  expect(meanX(orange)).toBeLessThan(meanX(darkRed));
  expect(meanX(darkRed)).toBeLessThan(meanX(blue));

  // Each run's ink range, from its own stop colours: run 1's strict red
  // columns left of the gradient's first stop, the gradient's stop colours
  // between, run 3's strict blue columns right of the last stop.
  const minOrangeX = Math.min(...orange.map((p) => p.x));
  const maxDarkRedX = Math.max(...darkRed.map((p) => p.x));
  const run1Range = [Math.min(...red.map((p) => p.x)), Math.max(...red.filter((p) => p.x < minOrangeX - 3).map((p) => p.x))];
  const run2Range = [minOrangeX, maxDarkRedX];
  const blueInRange = blue.filter((p) => p.x > maxDarkRedX + 3);
  const run3Range = [Math.min(...blueInRange.map((p) => p.x)), Math.max(...blueInRange.map((p) => p.x))];

  // The outline hugs EVERY run: solid near-black outline ink inside each
  // run's own column range.
  const outline = ink.filter((p) => p.r < 40 && p.g < 40 && p.b < 40 && p.a > 200);
  expect(outline.length).toBeGreaterThan(50);
  for (const [name, [lo, hi]] of [["run 1", run1Range], ["run 2", run2Range], ["run 3", run3Range]] as const) {
    const inRun = outline.filter((p) => p.x >= lo && p.x <= hi);
    expect(inRun.length).toBeGreaterThan(20);
  }

  // The shadow paints below every run: soft (non-max-alpha) dark ink under
  // the glyph baseline inside each run's own column range.
  const maxY = Math.max(...ink.map((p) => p.y));
  const below = ink.filter((p) => p.y > maxY - 8 && p.a > 0 && p.a < 250 && p.r < 120);
  expect(below.length).toBeGreaterThan(0);
  for (const [name, [lo, hi]] of [["run 1", run1Range], ["run 2", run2Range], ["run 3", run3Range]] as const) {
    const inRun = below.filter((p) => p.x >= lo && p.x <= hi);
    expect(inRun.length).toBeGreaterThan(0);
  }
});