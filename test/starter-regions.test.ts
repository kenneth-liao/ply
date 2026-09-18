/**
 * The committed starter YouTube region file (#175, spec #172 US-003).
 *
 * The starter ships as a copy-and-own template at
 * `examples/youtube-regions.json`: the canonical copy for real work lives
 * in the caller's project and is passed by path, so no workflow ever holds
 * two authoritative copies. This test protects the committed template from
 * drift — the file must always load through the single ingestion point
 * (#173's `parseRegionFile`) and must always carry the exact YouTube
 * baseline rectangles it relocated (the numbers the removal ticket #176
 * retires `src/safe-area.ts` against).
 *
 * Pure file + parse: no browser, no network, no weights.
 */
import { expect, test } from "bun:test";
import path from "node:path";
import { readRegionFile, REGION_SCHEMA_VERSION } from "../src/composition-regions.js";

const STARTER = path.resolve(import.meta.dir, "../examples/youtube-regions.json");

test("the starter region file loads through the region ingestion point", async () => {
  const file = await readRegionFile(STARTER);
  expect(file.schemaVersion).toBe(REGION_SCHEMA_VERSION);
  expect(file.canvas).toEqual({ width: 1280, height: 720 });
  expect(file.regions.map((r) => r.id)).toEqual(["duration-badge", "progress-bar"]);
});

test("the starter carries the exact relocated YouTube baseline rectangles", async () => {
  const file = await readRegionFile(STARTER);
  const [badge, bar] = file.regions;
  expect(badge?.label).toBe("duration badge");
  expect(badge?.reason).toBe(
    "YouTube pins the video-length badge to the thumbnail's bottom-right corner at every display size",
  );
  expect(badge?.box).toEqual({ x: 1088, y: 656, width: 192, height: 64 });
  expect(bar?.label).toBe("progress bar");
  expect(bar?.reason).toBe(
    "YouTube draws the watched-progress bar across the thumbnail's full width at the bottom edge",
  );
  expect(bar?.box).toEqual({ x: 0, y: 704, width: 1280, height: 16 });
});