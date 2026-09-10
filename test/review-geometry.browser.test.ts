/**
 * Review-sheet pixel geometry, asserted in a real browser — one home for the
 * full/thumbnail contract shared by the uniform evidence sheet
 * (`reviewPublishedGeneration`, spec #102 US-005) and the legacy job sheet
 * (`reviewJob`, US-022/DEC-017): the full-size view is true 1:1 (natural
 * width inside a scrollable container, never downscaled), the row/thumbnail
 * view is exactly 168px — the size that decides legibility — and every sheet
 * is self-contained (every remote request aborts loudly, so only embedded
 * data URLs can render). One browser-backed suite per process (the
 * repository test contract): both sheets build in one `beforeAll` under one
 * shared context.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { getBrowser } from "../src/browser.js";
import { encodePng } from "./png.js";
import { runUniformGeneration } from "../src/generation.js";
import { runMatting } from "../src/matting.js";
import { composeMatte, type MatteEngine } from "../src/matte.js";
import { reviewPublishedGeneration } from "../src/evidence-review.js";
import { reviewJob } from "../src/review.js";
import { writeLegacyJob } from "./legacy-jobs.js";

let root: string;
let ctx: BrowserContext;
let page: Page;
let evidenceSheet: string;
let legacySheet: string;

async function geometry(locator: string) {
  const el = page.locator(locator).first();
  return el.evaluate((node) => ({
    rectWidth: node.getBoundingClientRect().width,
    naturalWidth: (node as HTMLImageElement).naturalWidth,
  }));
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-review-geometry-"));

  // Uniform evidence sheet: a wide candidate so the 1:1 assertion is
  // meaningful at a 1000px viewport.
  const jobsRoot = path.join(root, "out", "generation");
  const matteRoot = path.join(root, "out", "matting");
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
  evidenceSheet = (await reviewPublishedGeneration(jobsRoot, matteRoot, "gen-browser-review")).reviewPath;

  // Legacy job sheet: the same wide candidate through the retained reader.
  const legacyRoot = path.join(root, "jobs");
  const wide = encodePng(2000, 500, (x, y) => [(x % 256) as number, (y % 256) as number, 90, 255]);
  await writeLegacyJob(legacyRoot, {
    jobId: "browser-plate",
    kind: "plate",
    subject: "wide plate",
    runs: [{ candidates: [{ bytes: wide }] }],
  });
  legacySheet = (await reviewJob(legacyRoot, "browser-plate")).reviewPath;

  const browser = await getBrowser();
  ctx = await browser.newContext({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
  // Every remote request aborts loudly — each sheet must need nothing but its
  // own embedded bytes; only the local document itself may load.
  await ctx.route("**/*", (route) =>
    /^https?:/i.test(route.request().url()) ? route.abort() : route.continue(),
  );
  page = await ctx.newPage();
}, 30_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await ctx?.close();
});

describe("uniform evidence sheet geometry", () => {
  test("the full-size view renders at natural width — truly 1:1 in a scrollable container", async () => {
    await page.goto(`file://${evidenceSheet}`);
    const { rectWidth, naturalWidth } = await geometry("img.full");
    expect(naturalWidth).toBe(2000);
    expect(rectWidth).toBe(naturalWidth);
  });

  test("the row view is exactly 168px wide", async () => {
    await page.goto(`file://${evidenceSheet}`);
    const { rectWidth, naturalWidth } = await geometry("img.thumb");
    expect(naturalWidth).toBe(2000);
    expect(rectWidth).toBe(168);
  });

  test("the Reference, candidate, and matte all render from embedded bytes", async () => {
    await page.goto(`file://${evidenceSheet}`);
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

describe("legacy job sheet geometry", () => {
  test("the full-size view renders at natural width — truly 1:1 in a scrollable container", async () => {
    await page.goto(`file://${legacySheet}`);
    const { rectWidth, naturalWidth } = await geometry("img.full");
    expect(naturalWidth).toBe(2000);
    expect(rectWidth).toBe(naturalWidth);
  });

  test("the thumbnail view is exactly 168px wide", async () => {
    await page.goto(`file://${legacySheet}`);
    const { rectWidth, naturalWidth } = await geometry("img.thumb");
    expect(naturalWidth).toBe(2000);
    expect(rectWidth).toBe(168);
  });
});
