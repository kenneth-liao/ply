/**
 * The evidence sheet is inspected as an actual artifact in a real browser
 * (#109, spec #102 US-005, TEST-005/006): the full-size view is true 1:1
 * (natural width inside a scrollable container, never downscaled), the row
 * view is exactly 168px — the size that decides legibility — matte evidence
 * shows through a checkerboard, and the sheet is self-contained: every remote
 * request aborts loudly, so only embedded data URLs can render.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { getBrowser } from "../src/browser.js";
import { encodePng } from "./png.js";
import { runUniformGeneration } from "../src/generation.js";
import { runMatting } from "../src/matting.js";
import { composeMatte, type MatteEngine } from "../src/matte.js";
import { reviewPublishedGeneration } from "../src/evidence-review.js";

let root: string;
let page: Page;
let sheetPath: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-evidence-browser-"));
  const jobsRoot = path.join(root, "out", "generation");
  const matteRoot = path.join(root, "out", "matting");

  // A wide candidate so the 1:1 assertion is meaningful at a 1000px viewport.
  let n = 0;
  const provider = {
    image: async () => {
      const b = encodePng(2000, 500, (x, y) => [(x % 256) as number, (y % 256) as number, 90, 255]);
      return { images: [{ base64: b.toString("base64") }], warnings: [] };
    },
    text: async () => ({ files: [], text: "", warnings: [] }),
  };
  const ref = path.join(root, "anchor.png");
  await writeFile(ref, encodePng(400, 400, () => [180, 40, 40, 255]));
  const job = await runUniformGeneration(
    jobsRoot,
    "gen-browser-review",
    { prompt: "wide candidate", intent: "full-canvas", model: "gpt-image", count: 1, references: [ref] },
    { provider },
  );

  const mask = encodePng(2000, 500, (x) => (x < 1000 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  const engine: MatteEngine = async ({ bytes, label }) => ({
    bytes: composeMatte(bytes, mask, label),
    engine: "test/segmenter",
  });
  const outputFile = path.join(jobsRoot, "gen-browser-review", job.run.outputs[0]!.file);
  await runMatting(matteRoot, "matte-browser-review", outputFile, { engine });

  const review = await reviewPublishedGeneration(jobsRoot, matteRoot, "gen-browser-review");
  sheetPath = review.reviewPath;

  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
  // Every remote request aborts loudly — the sheet must need nothing but its
  // own embedded bytes; only the local document itself may load.
  await ctx.route("**/*", (route) =>
    /^https?:/i.test(route.request().url()) ? route.abort() : route.continue(),
  );
  page = await ctx.newPage();
}, 30_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await page?.context().close();
});

describe("evidence sheet geometry", () => {
  test("the full-size view renders at natural width — truly 1:1 in a scrollable container", async () => {
    await page.goto(`file://${sheetPath}`);
    const full = page.locator("img.full").first();
    const { rectWidth, naturalWidth } = await full.evaluate((el) => ({
      rectWidth: el.getBoundingClientRect().width,
      naturalWidth: (el as HTMLImageElement).naturalWidth,
    }));
    expect(naturalWidth).toBe(2000);
    expect(rectWidth).toBe(naturalWidth);
  });

  test("the row view is exactly 168px wide", async () => {
    await page.goto(`file://${sheetPath}`);
    const thumb = page.locator("img.thumb").first();
    const { rectWidth, naturalWidth } = await thumb.evaluate((el) => ({
      rectWidth: el.getBoundingClientRect().width,
      naturalWidth: (el as HTMLImageElement).naturalWidth,
    }));
    expect(naturalWidth).toBe(2000);
    expect(rectWidth).toBe(168);
  });

  test("the Reference, candidate, and matte all render from embedded bytes", async () => {
    await page.goto(`file://${sheetPath}`);
    const refs = page.locator("img.ref");
    expect(await refs.count()).toBe(1);
    const refNatural = await refs.first().evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(refNatural).toBe(400);

    const mattes = page.locator("img.matte");
    expect(await mattes.count()).toBe(1);
    const matteNatural = await mattes.first().evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(matteNatural).toBe(2000);
  });
});