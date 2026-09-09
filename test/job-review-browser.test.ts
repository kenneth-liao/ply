import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { getBrowser } from "../src/browser.js";
import { reviewJob } from "../src/review.js";
import { encodePng } from "./png.js";
import { writeLegacyJob } from "./legacy-jobs.js";

/**
 * The full/thumbnail evidence geometry, asserted in a real browser (US-022,
 * DEC-017): the full-size view is true 1:1 — the candidate renders at its
 * natural width inside a scrollable container, never downscaled to fit — and
 * the thumbnail view is exactly 168px, the row size that decides legibility.
 * One browser-backed suite per process (the repository test contract); the
 * context aborts every remote request, so any non-embedded fetch would fail
 * loudly instead of silently loading.
 */

let root: string;
let jobRoot: string;
let page: Page;
let sheetPath: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-job-review-browser-"));
  jobRoot = path.join(root, "jobs");
  // A wide candidate: at a 1000px viewport it overflows its column, so only a
  // natural-width overflow container can keep it 1:1.
  const wide = encodePng(2000, 500, (x, y) => [(x % 256) as number, (y % 256) as number, 90, 255]);
  await writeLegacyJob(jobRoot, {
    jobId: "browser-plate",
    kind: "plate",
    subject: "wide plate",
    runs: [{ candidates: [{ bytes: wide }] }],
  });
  const review = await reviewJob(jobRoot, "browser-plate");
  sheetPath = review.reviewPath;

  const browser = await getBrowser();
  const ctx = await browser.newContext({
    viewport: { width: 1000, height: 800 },
    deviceScaleFactor: 1,
  });
  // Every remote request aborts loudly — the sheet must need nothing but its
  // own embedded bytes; only the local document itself may load.
  await ctx.route("**/*", (route) =>
    /^https?:/i.test(route.request().url()) ? route.abort() : route.continue(),
  );
  page = await ctx.newPage();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await page.context().close();
});

describe("review sheet geometry", () => {
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

  test("the thumbnail view is exactly 168px wide", async () => {
    await page.goto(`file://${sheetPath}`);
    const thumb = page.locator("img.thumb").first();
    const { rectWidth, naturalWidth } = await thumb.evaluate((el) => ({
      rectWidth: el.getBoundingClientRect().width,
      naturalWidth: (el as HTMLImageElement).naturalWidth,
    }));
    expect(naturalWidth).toBe(2000);
    expect(rectWidth).toBe(168);
  });
});