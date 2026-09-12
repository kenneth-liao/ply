/**
 * US-002 geometry contract (spec #159 ticket #162, TEST-002): non-square
 * inputs are padded, not stretched. Proven WITHOUT weights and WITHOUT
 * Python — these are the numeric cases production must satisfy:
 *
 *   - aspect-preserving downscale ONLY when max(width,height) > 2048;
 *   - replicate pad right/bottom to multiples of 32 (Swin patch grid);
 *   - crop padding from the predicted alpha BEFORE bilinear resize back;
 *   - already-aligned sizes are a pad-free no-op (1024x1024 and 1024x1536
 *     must not be resampled as a side effect).
 *
 * The arithmetic lives in `src/dynamic-geometry.ts`, a pure contract lock:
 * it performs no pixel work and the production engine never calls it —
 * production preprocessing lives ONLY in `scripts/matte-birefnet-dynamic.py`,
 * which mirrors this arithmetic. The crop-before-resize ordering is proven
 * here on synthetic alpha arrays (experiment-style checks promoted into the
 * repo); the live test proves it end to end with weights by asserting output
 * dims equal input dims on a non-square fixture.
 */
import { describe, test, expect } from "bun:test";
import { dynamicGeometry } from "../src/dynamic-geometry.js";

describe("dynamicGeometry — US-002 numeric contract", () => {
  test("square 1024 is a pad-free no-op", () => {
    expect(dynamicGeometry(1024, 1024)).toEqual({
      workW: 1024, workH: 1024,
      padRight: 0, padBottom: 0,
      paddedW: 1024, paddedH: 1024,
      scaled: false,
    });
  });

  test("aligned sizes are pad-free no-ops (800x800, 1024x768)", () => {
    for (const [w, h] of [[800, 800], [1024, 768]] as const) {
      const g = dynamicGeometry(w, h);
      expect(g.padRight).toBe(0);
      expect(g.padBottom).toBe(0);
      expect(g.paddedW).toBe(w);
      expect(g.paddedH).toBe(h);
      expect(g.scaled).toBe(false);
    }
  });

  test("1024x1536 (portrait, aligned) is a pad-free no-op — no resampling side effect", () => {
    const g = dynamicGeometry(1024, 1536);
    expect(g).toEqual({
      workW: 1024, workH: 1536,
      padRight: 0, padBottom: 0,
      paddedW: 1024, paddedH: 1536,
      scaled: false,
    });
  });

  test("1024x683 pads bottom to 1024x704 (right/bottom only, aspect preserved)", () => {
    const g = dynamicGeometry(1024, 683);
    expect(g.workW).toBe(1024);
    expect(g.workH).toBe(683);
    expect(g.padRight).toBe(0);
    expect(g.padBottom).toBe(21);
    expect(g.paddedW).toBe(1024);
    expect(g.paddedH).toBe(704);
    expect(g.scaled).toBe(false);
  });

  test("1024x1535 pads bottom by one to 1024x1536", () => {
    const g = dynamicGeometry(1024, 1535);
    expect(g.padRight).toBe(0);
    expect(g.padBottom).toBe(1);
    expect(g.paddedW).toBe(1024);
    expect(g.paddedH).toBe(1536);
    expect(g.scaled).toBe(false);
  });

  test("padded dims are always multiples of 32", () => {
    for (const [w, h] of [[1024, 683], [1024, 1535], [640, 480], [777, 555], [3000, 2000]] as const) {
      const g = dynamicGeometry(w, h);
      expect(g.paddedW % 32).toBe(0);
      expect(g.paddedH % 32).toBe(0);
    }
  });

  test("downscale path: 3000x2000 caps the long side at 2048, preserves aspect, then pads", () => {
    const g = dynamicGeometry(3000, 2000);
    expect(g.scaled).toBe(true);
    expect(Math.max(g.workW, g.workH)).toBeLessThanOrEqual(2048);
    // Aspect preserved: 3000:2000 == workW:workH within a pixel of rounding.
    expect(Math.abs(g.workW / g.workH - 3000 / 2000)).toBeLessThan(1 / 1000);
    expect(g.workW).toBe(2048);
    expect(g.workH).toBe(1365);
    expect(g.paddedW).toBe(2048);
    expect(g.paddedH).toBe(1376);
    expect(g.padBottom).toBe(11);
  });

  test("at exactly 2048 on the long side there is no downscale", () => {
    const g = dynamicGeometry(2048, 1000);
    expect(g.scaled).toBe(false);
    expect(g.workW).toBe(2048);
    expect(g.workH).toBe(1000);
  });

  test("non-positive or non-integer dims are refused", () => {
    for (const [w, h] of [[0, 100], [100, 0], [-4, 100], [100.5, 100]] as const)
      expect(() => dynamicGeometry(w, h)).toThrow(/width|height|positive|integer/i);
  });
});

type Alpha = number[][];

/** Synthetic padded alpha: value = (x + y) % 256 — any squeeze changes it. */
function fakePaddedAlpha(paddedW: number, paddedH: number): Alpha {
  return Array.from({ length: paddedH }, (_, y) =>
    Array.from({ length: paddedW }, (_, x) => (x + y) % 256),
  );
}

/** Bilinear sample on a plain number grid (test-only kernel, not production). */
function bilinear(grid: Alpha, fx: number, fy: number): number {
  const h = grid.length;
  const w = grid[0]!.length;
  const x0 = Math.min(w - 1, Math.max(0, Math.floor(fx)));
  const y0 = Math.min(h - 1, Math.max(0, Math.floor(fy)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = Math.min(1, Math.max(0, fx - x0));
  const ty = Math.min(1, Math.max(0, fy - y0));
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(grid[y0]![x0]!, grid[y0]![x1]!, tx),
    lerp(grid[y1]![x0]!, grid[y1]![x1]!, tx),
    ty,
  );
}

/** Crop-then-resize (the US-002 order) on a synthetic grid. */
function cropThenResizeBack(padded: Alpha, w: number, h: number, workW: number, workH: number): Alpha {
  const cropped = padded.slice(0, workH).map((row) => row.slice(0, workW));
  if (workW === w && workH === h) return cropped;
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) =>
      bilinear(cropped, ((x + 0.5) * workW) / w - 0.5, ((y + 0.5) * workH) / h - 0.5),
    ),
  );
}

/** Stretch-the-padded-frame (the round-1 bug): resize without cropping first. */
function stretchPadded(padded: Alpha, w: number, h: number): Alpha {
  const ph = padded.length;
  const pw = padded[0]!.length;
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) =>
      bilinear(padded, ((x + 0.5) * pw) / w - 0.5, ((y + 0.5) * ph) / h - 0.5),
    ),
  );
}

describe("crop padding BEFORE resize back (ordering proof on synthetic alpha)", () => {
  test("already-aligned 1024x1024: pad-free passthrough is pixel-exact", () => {
    const g = dynamicGeometry(1024, 1024);
    const padded = fakePaddedAlpha(g.paddedW, g.paddedH);
    const out = cropThenResizeBack(padded, 1024, 1024, g.workW, g.workH);
    expect(out).toEqual(padded);
  });

  test("1024x683: crop-then-resize preserves the content region exactly; stretching would not", () => {
    const g = dynamicGeometry(1024, 683);
    const padded = fakePaddedAlpha(g.paddedW, g.paddedH);
    const out = cropThenResizeBack(padded, 1024, 683, g.workW, g.workH);
    expect(out.length).toBe(683);
    expect(out[0]!.length).toBe(1024);
    // workW == w here, so the crop is the expectation row for row.
    expect(out).toEqual(padded.slice(0, 683).map((row) => row.slice(0, 1024)));
    // The old stretch bug produces different pixels on this gradient —
    // the ordering is load-bearing, not cosmetic.
    expect(stretchPadded(padded, 1024, 683)).not.toEqual(out);
  });

  test("downscale path 3000x2000: output is size-correct", () => {
    const g = dynamicGeometry(3000, 2000);
    const padded = fakePaddedAlpha(g.paddedW, g.paddedH);
    const out = cropThenResizeBack(padded, 3000, 2000, g.workW, g.workH);
    expect(out.length).toBe(2000);
    expect(out[0]!.length).toBe(3000);
  });
});
