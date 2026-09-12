/**
 * US-002 geometry contract lock (spec #159 ticket #162).
 *
 * Pure dimension arithmetic for BiRefNet Dynamic preprocessing: an
 * aspect-preserving downscale ONLY when max(width,height) > 2048, then a
 * right/bottom pad to multiples of 32 (the Swin patch grid). This module
 * performs NO pixel work and the production engine NEVER calls it —
 * production preprocessing lives ONLY in
 * `scripts/matte-birefnet-dynamic.py`, which mirrors this arithmetic
 * (`preprocess_with_gpad`: `int()` truncation, `(-n) % 32` pad, replicate
 * border, crop-then-bilinear-resize-back). This module exists so
 * `test/segment-geometry.test.ts` can lock the contract WITHOUT weights and
 * WITHOUT launching Python. It is not a second preprocess path: there is
 * nothing here that touches an image.
 */
export interface DynamicGeometry {
  /** Working dims after the aspect-preserving cap (== input when unscaled). */
  workW: number;
  workH: number;
  /** Replicate pad appended right / bottom to reach multiples of 32. */
  padRight: number;
  padBottom: number;
  /** Padded dims the model sees (always multiples of 32). */
  paddedW: number;
  paddedH: number;
  /** Whether the cap downscaled the input. */
  scaled: boolean;
}

/** Long-side cap: the model never sees more than this on either working side. */
export const DYNAMIC_MAX_SIDE = 2048;

/** Model patch-grid divisibility: padded dims are multiples of this. */
export const DYNAMIC_PAD_MULTIPLE = 32;

/**
 * Compute the US-002 working geometry for an input of the given size.
 * Mirrors the production script exactly: `scale = min(1, maxSide / max(w,h))`,
 * truncation toward zero (Python `int()` on positives), pad `(-n) % 32`.
 */
export function dynamicGeometry(
  width: number,
  height: number,
  maxSide: number = DYNAMIC_MAX_SIDE,
): DynamicGeometry {
  if (!Number.isInteger(width) || width <= 0)
    throw new Error(`Dynamic geometry needs a positive integer width (got ${JSON.stringify(width)})`);
  if (!Number.isInteger(height) || height <= 0)
    throw new Error(`Dynamic geometry needs a positive integer height (got ${JSON.stringify(height)})`);
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const scaled = scale !== 1;
  // Truncation, matching Python int(w * scale) on positive values.
  const workW = scaled ? Math.max(1, Math.trunc(width * scale)) : width;
  const workH = scaled ? Math.max(1, Math.trunc(height * scale)) : height;
  // ((-n) % 32 + 32) % 32 — the same non-negative remainder Python's % yields.
  const pr = (((-workW) % DYNAMIC_PAD_MULTIPLE) + DYNAMIC_PAD_MULTIPLE) % DYNAMIC_PAD_MULTIPLE;
  const pb = (((-workH) % DYNAMIC_PAD_MULTIPLE) + DYNAMIC_PAD_MULTIPLE) % DYNAMIC_PAD_MULTIPLE;
  return {
    workW, workH,
    padRight: pr, padBottom: pb,
    paddedW: workW + pr, paddedH: workH + pb,
    scaled,
  };
}
