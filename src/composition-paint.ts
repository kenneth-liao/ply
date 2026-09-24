/**
 * Composition painting — paint a resolved Layer snapshot to PNG bytes through
 * the shared render page (ADR-0013, DEC-001–006, #77 US-006; extracted by #87).
 *
 * This module is the one paint path for both current-state rendering
 * (`composition render`, #80) and historical replay (`composition replay`,
 * #87): given a canvas and a resolved Layer snapshot — exact verified bytes
 * plus discriminated revision metadata — it produces PNG bytes at exactly the
 * canvas dimensions. It never reads Project state; callers own resolution.
 *
 * Paint contract: Layers paint in reference-list order — later Layers paint
 * over earlier ones — at each revision's stored position (x, y) and opacity in
 * [0, 1], at the retained content's intrinsic size, clipped to the canvas.
 * A revision's shadow (#139, ADR-0018) applies to the content in its LOCAL
 * coordinate space (image alpha or text glyphs alike) before the canonical
 * transform, which maps content+shadow together, and the Layer's opacity
 * fades both. A revision's outline (#140, ADR-0019) hugs the content in the
 * same LOCAL space, painted BEFORE the shadow — the shadow is therefore cast
 * from the outlined composite — and both map and fade together. A revision's
 * visible region (#211, ADR-0023) crops the content BEFORE the effects —
 * content, visible region, outline, shadow, then transform and opacity —
 * so the effects hug the region's edge instead of the full content edge;
 * the clip lives on an inner content element under the Layer's wrapper
 * element, so `#canvas` keeps exactly one child per Layer and Layers
 * without a region paint exactly the pre-#211 markup.
 * A revision's grade (#219, ADR-0024) and edge glow (#221, ADR-0024) paint
 * in the same local space between the region and the outline: the grade's
 * CSS filter chain rides the inner content element (content only, alpha
 * untouched), and the glow is the first function of the outer element's
 * effect chain — an inner-alpha band over the graded content, under
 * outline and shadow, never extending painted extents (DEC-005). The
 * blend mode (#220, ADR-0024) then composites the whole Layer — content,
 * visible region, grade, glow, outline, shadow, transform, opacity — as
 * ONE unit against everything beneath it.
 * A revision's vector colour (#215, DEC-008) is content paint: a recoloured
 * Layer paints as ONE solid-colour element masked by the retained bytes
 * themselves (ADR-0012's machinery, through the browser image path), placed
 * in the content stage of that same order — the region crops it, the
 * effects hug it; Layers without the colour paint exactly the pre-#215
 * markup.
 * Areas no Layer covers stay transparent. Text Layers (#81) paint as DOM text
 * with their retained font bytes declared under an internal @font-face
 * family (never re-consulting assets/fonts/), and every text layer's family
 * is probed for actual load/resolution after page load — an unresolved face
 * or unavailable font fails the render before any output is produced.
 *
 * The same paint callback also captures the rendering-environment identity
 * (#87): the tool, runtime, platform, and the actual browser used to paint.
 * Replay requires an exact match on this identity, checked after the paint
 * pass and before any output is published.
 */
import { withRenderPage } from "./browser.js";
import { familyResolved, internalFontFamily, callerFontFaceCss } from "./fonts.js";
import type { CallerFontFacts } from "./fonts.js";
import { decodePng, encodePngRgba } from "./png.js";
import type { Page } from "playwright";
import { toolIdentity } from "./manifest.js";
import { createHash } from "node:crypto";
import {
  normalizeStoredTextAxes,
  normalizeStoredTextTypography,
  normalizeStoredTextWrapWidth,
  normalizeStoredTextFitBox,
  MIN_FIT_FONT_SIZE,
  type LayerOutline,
  type LayerVisibleRegion,
  type ResolvedLayerRevision,
  type LayerGrade,
  type LayerGlow,
} from "./layer.js";
import { fillCssBackground, normalizeStoredTextFill } from "./fill.js";

const MIME: Record<"png" | "jpeg" | "webp" | "svg", string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/**
 * Explicit intrinsic sizing for a vector image element (#213, DEC-007): an
 * SVG `<img>` paints at the parsed intrinsic size as an inline style, so the
 * painted box is exactly the width/height or viewBox facts the ingestion
 * parse recorded — measure and inspect read the same numbers — and the
 * browser rasterizes the vector at that painted size and the supersample
 * factor (never from a fixed bitmap). Raster images keep their exact
 * pre-#213 markup — the intrinsic box is the decode's natural size — so
 * pinned history paints byte-identically.
 */
function imageSize(rev: { format: "png" | "jpeg" | "webp" | "svg"; width: number; height: number }): string {
  return rev.format === "svg" ? ` width="${rev.width}" height="${rev.height}"` : "";
}

/**
 * A resolved snapshot layer: the exact verified bytes plus discriminated
 * revision metadata. Resolution is the caller's concern (current state: #80;
 * pinned history: #87) — this module only paints.
 */
export type SnapshotLayer = {
  name: string;
  layerId: string;
  revision: ResolvedLayerRevision;
  contentBytes: Buffer;
};

/**
 * The rendering environment that produced a paint: identity fields only.
 * Byte-identical replay is guaranteed within this environment, never claimed
 * universally across machines that merely report equal version strings
 * (#87, US-007).
 */
export interface PaintEnvironment {
  tool: { name: string; version: string };
  runtime: string;
  browser: string;
  platform: string;
}

/**
 * Capture the environment identity of the page that actually painted, inside
 * the same paint callback — the identity must describe the browser that
 * produced the pixels, not a separately consulted one (#87).
 */
function captureEnvironment(page: Page): PaintEnvironment {
  const browser = page.context().browser();
  if (!browser) {
    throw new Error("Cannot capture the render environment: the render page has no browser.");
  }
  return {
    tool: toolIdentity(),
    runtime: `bun ${Bun.version}`,
    browser: `${browser.browserType().name()} ${browser.version()}`,
    platform: `${process.platform}-${process.arch}`,
  };
}

/**
 * Chromium's per-step raster cap on the `feMorphology` dilate kernel:
 * 256 px in the filter's raster space (verified empirically). Outline
 * width is in the Layer's LOCAL px (ADR-0019), painted before the
 * transform, so the raster dilation is
 * `outline.width × max(|scaleX|, |scaleY|) × supersample` (#193, ADR-0022).
 * `outlineDilateSteps` reads this cap to set the chained-step count so no
 * single dilate step exceeds it (#194).
 *
 * One home for the number: `outlineDilateSteps` and every test of the cap
 * read this constant, never a second copy of the number.
 */
export const MAX_OUTLINE_DILATE_PX = 256;

/**
 * The largest absolute scale factor a Layer's canonical transform applies
 * (#193, ADR-0016, ADR-0019, ADR-0022).
 *
 * Reads the exact `scaleX` and `scaleY` revision fields the paint transform
 * applies. Effects (outline feMorphology dilate, drop-shadow blur) paint in
 * the Layer's local coordinate space before the transform, so their maximum
 * raster extent scales by max(|scaleX|, |scaleY|). Rotation and flip preserve
 * lengths and do not change this factor.
 */
export function layerMaxScale(rev: { scaleX: number; scaleY: number }): number {
  return Math.max(Math.abs(rev.scaleX), Math.abs(rev.scaleY));
}

/**
 * Compute the raster dilation in device pixels for an outline (#193, ADR-0019, ADR-0022).
 * Outline width is in Layer local px (ADR-0019), painted before the transform.
 * The raster dilation in device pixels is:
 *   outline.width × max(|scaleX|, |scaleY|) × supersample.
 * Rotation and flip do not change it.
 */
export function outlineRasterDilation(
  outlineWidth: number,
  rev: { scaleX: number; scaleY: number },
  supersample: number = 1,
): number {
  return outlineWidth * layerMaxScale(rev) * supersample;
}

/**
 * Compute the number of chained `feMorphology` dilate steps needed so that
 * no single step exceeds Chromium's MAX_OUTLINE_DILATE_PX cap in device raster
 * space (#194, ADR-0019, ADR-0022).
 *
 *   n = ceil(rasterDilation / MAX_OUTLINE_DILATE_PX), minimum 1.
 */
export function outlineDilateSteps(
  outlineWidth: number,
  rev: { scaleX: number; scaleY: number },
  supersample: number = 1,
): number {
  const dilation = outlineRasterDilation(outlineWidth, rev, supersample);
  return Math.max(1, Math.ceil(dilation / MAX_OUTLINE_DILATE_PX));
}

/**
 * Split an outline width into `n` local radii that sum to exactly `width`
 * (#194, ADR-0019).
 *
 * Box structuring elements add up exactly (square(a) ⊕ square(b) = square(a+b)),
 * preserving the ring geometry and measurement reach. When n = 1, returns [width].
 */
export function outlineDilateRadii(width: number, n: number): number[] {
  if (n <= 1) return [width];
  const step = width / n;
  const radii = Array.from({ length: n - 1 }, () => step);
  radii.push(width - step * (n - 1));
  return radii;
}

/**
 * Area-average a supersampled RGBA image back to its canvas size (#184,
 * ADR-0022): every factor×factor block of device pixels averages into one
 * canvas pixel. The average is taken in PREMULTIPLIED alpha — each sample's
 * channels are weighted by its alpha before summing, and the color is
 * unpremultiplied afterwards — so transparent edges keep their hue with no
 * dark fringes; for fully opaque blocks it is exactly a plain box average.
 * Rounding is deterministic: integer sums, every division rounded half-up,
 * and the unpremultiply rounds once from the rounded premultiplied average.
 *
 * Pure pixel math: no PNG decode, no browser — tested directly on known
 * blocks including semi-transparent edges.
 */
export function averageSupersampled(rgba: Buffer, width: number, height: number, factor: number): Buffer {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`averageSupersampled: factor ${factor} must be an integer of at least 1.`);
  }
  if (width % factor !== 0 || height % factor !== 0) {
    throw new Error(
      `averageSupersampled: image size ${width}×${height} does not divide evenly by factor ${factor}.`,
    );
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`averageSupersampled: ${rgba.length} bytes is not ${width}×${height} RGBA`);
  }
  const outWidth = width / factor;
  const outHeight = height / factor;
  const out = Buffer.alloc(outWidth * outHeight * 4);
  const count = factor * factor;
  // Loop-invariant helper (PROD-PAINT-1): one function, no per-pixel closure
  // allocation. Premultiplied 8-bit average: Rp = round(Σ(r·a)/(255·count));
  // the unpremultiply rounds once more from that average. Opaque blocks
  // (a = 255) skip the premultiplied round-trip losslessly, so they are
  // exactly the plain box average.
  const unpremultiply = (sumP: number, a: number, count: number): number => {
    if (a === 0) return 0;
    const rp = Math.round(sumP / (255 * count));
    return Math.min(255, Math.round((rp * 255) / a));
  };
  for (let by = 0; by < outHeight; by++) {
    for (let bx = 0; bx < outWidth; bx++) {
      let sumRp = 0, sumGp = 0, sumBp = 0, sumA = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((by * factor + dy) * width + bx * factor + dx) * 4;
          const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!, a = rgba[i + 3]!;
          sumRp += r * a;
          sumGp += g * a;
          sumBp += b * a;
          sumA += a;
        }
      }
      const a = Math.round(sumA / count);
      const o = (by * outWidth + bx) * 4;
      out[o] = unpremultiply(sumRp, a, count);
      out[o + 1] = unpremultiply(sumGp, a, count);
      out[o + 2] = unpremultiply(sumBp, a, count);
      out[o + 3] = a;
    }
  }
  return out;
}

/**
 * Paint the snapshot's exact bytes through the render page: one
 * absolutely-positioned element per Layer at its stored position and opacity,
 * in reference-list order, over a transparent canvas sized to the
 * Composition. Images paint at intrinsic size; text layers paint as DOM text
 * with their retained font bytes declared under an internal @font-face
 * family (#81). The screenshot is taken only after every image has fully
 * decoded AND every text family has actually loaded — an unresolved face
 * fails the render instead of falling back silently.
 *
 * Returns the PNG bytes plus the environment identity captured from the same
 * page pass. A caller-owned `page` (tests: route-aborted offline evidence)
 * is used directly and never closed; otherwise the shared render page runs
 * the paint, serialized against every other browser-backed render.
 */
export async function paintComposition(
  canvas: { width: number; height: number },
  layers: SnapshotLayer[],
  options: { page?: Page; supersample?: number } = {},
): Promise<{ png: Buffer; environment: PaintEnvironment }> {
  return paintCompositionHtml(canvas, buildCompositionHtml(canvas, layers, options.supersample ?? 1), layers, options);
}

/**
 * Paint an already-built page for one Composition: the shared screenshot
 * recipe (awaited decode, outline-filter region sizing, font-resolution
 * gate, clipped PNG, environment capture) over caller-built markup.
 *
 * This is the guideline-view seam (#174): the guideline page is the shared
 * `buildCompositionHtml` markup wrapped with the region overlay by
 * composition-guidelines.ts — the overlay markup exists only on that
 * guideline code path. The render path never calls this with wrapped
 * markup: `paintComposition` builds its page from `buildCompositionHtml`
 * alone, with no parameter, flag, or branch that could emit the overlay
 * (ADR-0005's structural exclusion, carried forward by ADR-0015).
 *
 * `options.beforeScreenshot` is a page hook for the guideline path's
 * in-page placement pass (measured text placement needs the live page, the
 * same pattern as `sizeEffectFilterRegions`); the render path never passes
 * one, so no render-page flow runs guideline code.
 */
export async function paintCompositionHtml(
  canvas: { width: number; height: number },
  html: string,
  layers: SnapshotLayer[],
  options: { page?: Page; beforeScreenshot?: (page: Page) => Promise<void>; supersample?: number } = {},
): Promise<{ png: Buffer; environment: PaintEnvironment }> {
  // The supersample factor is paint-time device-pixel density (#184,
  // ADR-0022): the page paints at factor× the canvas size and the screenshot
  // is area-averaged back to exactly the canvas size. Default 1 paints
  // exactly as before — same markup, same viewport, same clip, no resample.
  const supersample = options.supersample ?? 1;
  if (!Number.isInteger(supersample) || supersample < 1) {
    throw new Error(`Invalid supersample factor ${supersample}: must be an integer of at least 1.`);
  }
  const paint = async (page: Page) => {
    await page.setViewportSize({ width: canvas.width * supersample, height: canvas.height * supersample });
    await page.setContent(html, { waitUntil: "load" });
    // Awaited decode: a partially painted canvas is never screenshotted.
    await page.evaluate(() => Promise.all(Array.from(document.images, (img) => img.decode())));
    // Per-Layer outline-filter region sizing (#140, ADR-0019): before any
    // pixel leaves this page — see sizeEffectFilterRegions.
    await sizeEffectFilterRegions(page, layers);
    await rejectUnresolvedFonts(page, layers);
    // Text fit-to-box derivation (#295, spec #285 US-016, DEC-010): the ONE
    // derivation pass, applied before any pixel leaves this page — see
    // applyTextFit. Runs after the font gate so the derivation measures the
    // retained faces, never a fallback.
    await applyTextFit(page, layers);
    if (options.beforeScreenshot) await options.beforeScreenshot(page);
    const png = await page.screenshot({
      type: "png",
      omitBackground: true,
      clip: { x: 0, y: 0, width: canvas.width * supersample, height: canvas.height * supersample },
      // 60s timeout: 4× chained dilate paints on large rasters take ~30s (#194).
      timeout: 60000,
    });
    if (supersample === 1) {
      return { png, environment: captureEnvironment(page) };
    }
    // Area-average each N×N block of device pixels back to one canvas pixel,
    // in premultiplied alpha, and re-encode at exactly the canvas size. The
    // screenshot is this tool's own bounded output, never untrusted bytes.
    const painted = decodePng(png);
    // The raster must be exactly canvas × factor before anything is averaged
    // (PROD-PAINT-2): a dimension drift would otherwise surface as an opaque
    // byte-length error instead of naming the supersample cause.
    if (painted.width !== canvas.width * supersample || painted.height !== canvas.height * supersample) {
      throw new Error(
        `Supersampled paint captured ${painted.width}×${painted.height} instead of ` +
          `${canvas.width * supersample}×${canvas.height * supersample} device pixels at supersample ` +
          `${supersample} — refusing to average a mismatched raster.`,
      );
    }
    const averaged = averageSupersampled(painted.rgba, painted.width, painted.height, supersample);
    const reduced = encodePngRgba(canvas.width, canvas.height, averaged);
    return { png: reduced, environment: captureEnvironment(page) };
  };
  return options.page ? paint(options.page) : withRenderPage(paint);
}

/**
 * Verify each text layer's font actually loaded and resolved in the page via
 * the shared family-resolution probe. Garbage bytes, undecodable faces, or a
 * failed load fall through to a fallback font — detected here and rejected
 * before any output is published.
 *
 * Shared with layout measurement (#136, DEC-004): measurement applies the
 * exact same retained-font resolution gate as painting, so an unresolved
 * face can never yield measured numbers. Caller fonts additionally run the
 * same gate at ingestion, before anything publishes (#232,
 * `verifyCallerFontResolves` in src/fonts.ts).
 */
export async function rejectUnresolvedFonts(page: Page, layers: SnapshotLayer[]): Promise<void> {
  const byFamily = new Map<string, string[]>();
  for (const l of layers) {
    if (l.revision.kind !== "text") continue;
    const family = internalFontFamily(l.revision.contentHash);
    byFamily.set(family, [...(byFamily.get(family) ?? []), l.name]);
  }
  const unresolved: string[] = [];
  for (const [family, names] of byFamily) {
    if (!(await page.evaluate(familyResolved, family))) {
      unresolved.push(`Layer "${names.join('", "')}"`);
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      `Font face failed to load from retained bytes for ${unresolved.join(", ")} — ` +
        `silent fallback is not allowed; the retained font content may be invalid or corrupted.`,
    );
  }
}

/**
 * The outline's SVG-filter id and def (#140, ADR-0019): one `feMorphology`
 * dilate over `SourceAlpha` (radius = outline width, in the element's LOCAL
 * px), flooded with the outline color and composited back under the source
 * graphic — a solid ring hugging the content's alpha/glyph ink, extended
 * exactly `width` px in every direction (a box structuring element: painted
 * ink ⊆ content ⊕ square(width), the bound the measurement reach relies
 * on).
 *
 * One filter per OUTLINED LAYER, not per distinct (width, color) pair: the
 * filter's declared region must cover the element's untransformed box
 * expanded by `width` px on every side, and that box differs per Layer —
 * a shared def would clip one Layer's ring or content to another's box
 * (verified empirically: Chromium DOES clip both the dilate ring and the
 * source graphic to the declared region, contrary to the pre-review
 * comment's claim). The region is therefore declared as a placeholder here
 * and sized in-page from the element's real untransformed border box by
 * `sizeEffectFilterRegions` — the SAME sizing pass in the paint and
 * measurement flows, so render and painted extents agree exactly. The id
 * is a deterministic hash of the pair plus the Layer's snapshot index, so
 * the same facts always emit the same markup.
 */
function outlineFilterId(outline: LayerOutline, layerIndex: number): string {
  return `ply-o-${createHash("sha256").update(`${outline.width}:${outline.color}:${layerIndex}`).digest("hex").slice(0, 16)}`;
}

function outlineFilterDef(
  outline: LayerOutline,
  layerIndex: number,
  rev: { scaleX: number; scaleY: number },
  supersample = 1,
): string {
  const id = outlineFilterId(outline, layerIndex);
  const n = outlineDilateSteps(outline.width, rev, supersample);
  let morphNodes: string;
  if (n <= 1) {
    morphNodes = `<feMorphology in="SourceAlpha" operator="dilate" radius="${outline.width}" result="dil"/>`;
  } else {
    const radii = outlineDilateRadii(outline.width, n);
    morphNodes = radii
      .map((r, i) => {
        const inName = i === 0 ? "SourceAlpha" : `dil_${i}`;
        const outName = i === radii.length - 1 ? "dil" : `dil_${i + 1}`;
        return `<feMorphology in="${inName}" operator="dilate" radius="${r}" result="${outName}"/>`;
      })
      .join("");
  }
  return (
    `<filter id="${id}" x="-300%" y="-300%" width="700%" height="700%">` +
    morphNodes +
    `<feFlood flood-color="${outline.color}" result="flood"/>` +
    `<feComposite in="flood" in2="dil" operator="in" result="ring"/>` +
    `<feMerge><feMergeNode in="ring"/><feMergeNode in="SourceGraphic"/></feMerge>` +
    `</filter>`
  );
}

/**
 * The edge glow's SVG-filter id and def (#221, spec #218 US-002, ADR-0024):
 * an inner-alpha edge light — a coloured band painted just INSIDE the
 * Layer's alpha edge, over the graded content. The chain operates on the
 * filter input's alpha — for the outer element's filter chain that input is
 * the region-clipped, graded composite, so the glow follows the visible
 * region's edge (including its rounded corners, ADR-0023) and paints over
 * the graded content, in ADR-0024's order:
 *
 * 1. `feMorphology erode` the source alpha by `width` px (LOCAL px, before
 *    the transform; chained under the same MAX_OUTLINE_DILATE_PX raster cap
 *    the outline dilate obeys — sequential box erosions compose exactly,
 *    the mirror of the chained dilate's argument).
 * 2. When a direction pair is stored, `feOffset` the eroded mask AWAY from
 *    the light direction — angle `a` degrees clockwise from top has its
 *    source at direction `(sin a, -cos a)` in screen coordinates (y down),
 *    so the mask moves the opposite way, thickening the band on the lit
 *    side — by `strength × width` px (strength 0 is the even glow).
 * 3. `feGaussianBlur` the mask by `softness` px — the feather between the
 *    band and the untouched interior.
 * 4. `feComposite operator="out"` against `SourceAlpha`: the band is the
 *    source alpha minus the blurred interior, so it never reaches beyond
 *    the source's alpha (zero where the source is transparent).
 * 5. `feFlood` the glow colour and `feComposite operator="in"` the band,
 *    then composite the coloured band ATOP the source graphic — Porter-Duff
 *    atop keeps the composite's alpha EXACTLY the source's alpha everywhere
 *    (the glow colours the edge pixels without raising their alpha), so
 *    alpha coverage is never altered (DEC-005) and painted extents equal
 *    the no-glow extents at every transform. The glow paints over the
 *    content, under outline and shadow, which the outer chain applies
 *    after this filter.
 *
 * One filter per GLOW Layer, the same recipe as the outline's def (its
 * region must be sized in-page from the element's real untransformed
 * box — the glow's output never leaves the box, so the sizing pass pads
 * it by the antialiasing 1px only), with a deterministic id hashed from
 * the glow facts plus the Layer's snapshot index. Emitted only when a
 * glow fact exists, so pre-#221 revisions paint exactly as before.
 */
function glowFilterId(glow: LayerGlow, layerIndex: number): string {
  return `ply-g-${createHash("sha256").update(`${glow.width}:${glow.softness}:${glow.color}:${glow.angle ?? ""}:${glow.strength ?? ""}:${layerIndex}`).digest("hex").slice(0, 16)}`;
}

function glowFilterDef(
  glow: LayerGlow,
  layerIndex: number,
  rev: { scaleX: number; scaleY: number },
  supersample = 1,
): string {
  const id = glowFilterId(glow, layerIndex);
  // The erode is split the same way the outline's dilate is (#194): no
  // single feMorphology step exceeds Chromium's 256px device-raster cap,
  // and sequential box erosions compose exactly like the dilate steps do.
  const n = outlineDilateSteps(glow.width, rev, supersample);
  const radii = outlineDilateRadii(glow.width, n);
  const erodeNodes = radii
    .map((r, i) => {
      const inName = i === 0 ? "SourceAlpha" : `ger_${i}`;
      const outName = i === radii.length - 1 ? "ger" : `ger_${i + 1}`;
      return `<feMorphology in="${inName}" operator="erode" radius="${r}" result="${outName}"/>`;
    })
    .join("");
  // The direction pair offsets the eroded mask OPPOSITE the light direction
  // (DEC-006: one angle plus strength, not a light model): angle `a`
  // clockwise from top puts the light source at (sin a, -cos a) in screen
  // coordinates, so the mask moves by strength × width along (-sin a, cos a)
  // and the band thickens on the lit side.
  const offsetNode =
    glow.angle !== undefined
      ? `<feOffset in="ger" dx="${(-glow.strength! * glow.width * Math.sin((glow.angle * Math.PI) / 180)).toFixed(4)}" dy="${(glow.strength! * glow.width * Math.cos((glow.angle * Math.PI) / 180)).toFixed(4)}" result="goff"/>`
      : "";
  const blurredIn = glow.angle !== undefined ? "goff" : "ger";
  return (
    `<filter id="${id}" x="-300%" y="-300%" width="700%" height="700%">` +
    erodeNodes +
    offsetNode +
    `<feGaussianBlur in="${blurredIn}" stdDeviation="${glow.softness}" result="gblur"/>` +
    `<feComposite in="SourceAlpha" in2="gblur" operator="out" result="gband"/>` +
    `<feFlood flood-color="${glow.color}" result="gflood"/>` +
    `<feComposite in="gflood" in2="gband" operator="in" result="gglow"/>` +
    `<feComposite in="gglow" in2="SourceGraphic" operator="atop"/>` +
    `</filter>`
  );
}

/**
 * The visible region's SVG-clipPath id and def (#211, spec #207 US-003,
 * ADR-0023): one `clipPath` (userSpaceOnUse) holding the region rectangle
 * in the Layer's LOCAL px — the same coordinate system the outline filter
 * region is sized in (origin at the element's own top-left). Referenced
 * from the Layer's inner content element with `clip-path:url(#id)`, the
 * clip applies to the CONTENT before the Layer element's filter chain, so
 * the outline dilate and the drop-shadow hug the region's edge — the
 * DEC-004 paint order (content, visible region, outline, shadow, transform
 * and opacity) falls out of the markup shape: the region clip lives on the
 * inner content element and the effects on the outer wrapper.
 *
 * An SVG reference clip (rather than `clip-path:inset(...)`) needs no
 * knowledge of the element's far edges, which only the browser knows for a
 * text Layer's wrapped line box: the region rect is absolute in the
 * element's user space for every kind. One clip per LAYER WITH A REGION,
 * not per distinct region: the id is a deterministic hash of the region
 * facts plus the Layer's snapshot index, so the same facts always emit the
 * same markup (the same recipe as the outline filter ids). A corner radius
 * (#212) joins the facts the id hashes and the rect's `rx` attribute — the
 * same rectangle, corners rounded.
 */
function regionClipPathId(region: LayerVisibleRegion, layerIndex: number): string {
  // The radius rides the id's hash input (#212) — only when present, so
  // pre-#212 region ids are byte-identical to their #211 form.
  const radiusPart = region.cornerRadius !== undefined ? `:r${region.cornerRadius}` : "";
  return `ply-r-${createHash("sha256").update(`${region.x}:${region.y}:${region.width}:${region.height}${radiusPart}:${layerIndex}`).digest("hex").slice(0, 16)}`;
}

function regionClipPathDef(region: LayerVisibleRegion, layerIndex: number): string {
  const id = regionClipPathId(region, layerIndex);
  // The corner radius (#212) is the clip rect's rx: the same rect geometry
  // (painted extents stay the rectangle's), with the corners rounded — the
  // clip crops the content to the rounded shape BEFORE the Layer element's
  // filter chain, so the outline and shadow hug the rounded edge too.
  const radius = region.cornerRadius !== undefined ? ` rx="${region.cornerRadius}"` : "";
  return (
    `<clipPath id="${id}" clipPathUnits="userSpaceOnUse">` +
    `<rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}"${radius}/>` +
    `</clipPath>`
  );
}

/** One mask-* declaration, standard then -webkit- — Chromium supports both,
 *  and the code then says what the help and README say (`mask-image`). The
 *  same recipe scene-render's tint (ADR-0012) emits, so the two paint
 *  paths share one mask spelling. */
function maskCss(prop: string, value: string): string {
  return `${prop}:${value};-webkit-${prop}:${value};`;
}

/** Minimal HTML escaping for caller-owned text (#81; shared with every
 * module that interpolates caller strings into the page — the guideline
 * overlay's region id/label/reason use this exact recipe, #174). */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The warmth control's SVG filter id and def (#219, spec #218 US-001,
 * ADR-0024): an SVG feColorMatrix filter running in sRGB
 * (color-interpolation-filters="sRGB") that scales red by (1 + warmth * 0.3)
 * and blue by (1 - warmth * 0.3), leaving green and alpha completely
 * unchanged. The filter is referenced from the Layer's inner content
 * element's CSS filter chain.
 */
function warmthFilterId(warmth: number, layerIndex: number): string {
  return `ply-w-${createHash("sha256").update(`${warmth}:${layerIndex}`).digest("hex").slice(0, 16)}`;
}

function warmthFilterDef(warmth: number, layerIndex: number): string {
  const id = warmthFilterId(warmth, layerIndex);
  const rScale = (1 + warmth * 0.3).toFixed(4);
  const bScale = (1 - warmth * 0.3).toFixed(4);
  return (
    `<filter id="${id}" color-interpolation-filters="sRGB">` +
    `<feColorMatrix type="matrix" values="${rScale} 0 0 0 0  0 1 0 0 0  0 0 ${bScale} 0 0  0 0 0 1 0"/>` +
    `</filter>`
  );
}

/**
 * The CSS filter chain for a graded Layer (#219, spec #218 US-001, ADR-0024):
 * applied to the INNER content element in the fixed deterministic sequence
 * (DEC-003): brightness -> contrast -> saturate -> warmth.
 */
function gradeFilterCss(grade: LayerGrade | undefined, layerIndex: number): string {
  if (!grade) return "";
  const parts: string[] = [];
  // Trust the normalized fact (storage normalisation at normalizeStoredGrade /
  // updateDraftGrade is the ONE home for neutral-value dropping): emit whatever
  // controls are present on the grade fact.
  if (grade.brightness !== undefined) {
    parts.push(`brightness(${grade.brightness})`);
  }
  if (grade.contrast !== undefined) {
    parts.push(`contrast(${grade.contrast})`);
  }
  if (grade.saturation !== undefined) {
    parts.push(`saturate(${grade.saturation})`);
  }
  if (grade.warmth !== undefined) {
    parts.push(`url(#${warmthFilterId(grade.warmth, layerIndex)})`);
  }
  return parts.length > 0 ? `filter:${parts.join(" ")};` : "";
}

/**
 * The per-Layer `<defs>` markup for every outlined Layer's filter (#140,
 * ADR-0019), every region-clipped Layer's clipPath (#211, ADR-0023), and
 * every warmth-filtered Layer's feColorMatrix filter (#219, ADR-0024) in
 * the snapshot. Emitted once per Composition as an inline SVG OUTSIDE
 * the `#canvas` element — zero-size, so it paints nothing itself, and
 * outside so `#canvas`'s children remain exactly one element per Layer
 * (the measurement probe and the painted-ink pass index them by
 * position). The outline filters are referenced from the Layer elements'
 * CSS `filter` chains by id; the region clipPaths from the inner content
 * elements' `clip-path`; the warmth filters from the inner content
 * elements' `filter` chain. The outline regions' placeholder is sized
 * in-page before any screenshot by `sizeEffectFilterRegions`.
 */
function paintDefs(layers: SnapshotLayer[], supersample = 1): string {
  const defs = layers
    .map((l, i) => {
      const outline =
        l.revision.outline !== undefined
          ? outlineFilterDef(l.revision.outline, i, l.revision, supersample)
          : "";
      const glow =
        l.revision.glow !== undefined
          ? glowFilterDef(l.revision.glow, i, l.revision, supersample)
          : "";
      const region =
        l.revision.visibleRegion !== undefined
          ? regionClipPathDef(l.revision.visibleRegion, i)
          : "";
      const warmth =
        l.revision.grade?.warmth !== undefined
          ? warmthFilterDef(l.revision.grade.warmth, i)
          : "";
      return outline + glow + region + warmth;
    })
    .join("");
  if (defs === "") return "";
  return `<svg width="0" height="0" style="position:absolute"><defs>${defs}</defs></svg>`;
}

/**
 * The per-Layer filter specs handed to `sizeEffectFilterRegions` (#140,
 * ADR-0019, extended by the glow #221): the outline's spec pads the region
 * by the outline width plus the antialiasing 1px; the glow's spec pads by
 * the 1px only — the glow's band is a subset of the source's alpha (it
 * never leaves the element's box), so its filter region needs no effect
 * reach. Both defs are sized in-page from the same element box.
 */
function outlineFilterSpecs(
  layers: SnapshotLayer[],
): { id: string; pad: number; name: string; index: number }[] {
  const specs: { id: string; pad: number; name: string; index: number }[] = [];
  layers.forEach((l, i) => {
    if (l.revision.outline !== undefined) {
      specs.push({ id: outlineFilterId(l.revision.outline, i), pad: l.revision.outline.width + 1, name: l.name, index: i });
    }
    if (l.revision.glow !== undefined) {
      specs.push({ id: glowFilterId(l.revision.glow, i), pad: 1, name: l.name, index: i });
    }
  });
  return specs;
}

/**
 * Size every outlined Layer's filter region in-page from the element's
 * real untransformed border box (#140, ADR-0019). The filter region is the
 * one clip Chromium applies to the dilate result AND the source graphic,
 * and the box is only knowable in the browser (text Layers wrap), so the
 * markup carries a placeholder and both page flows — paint and
 * measurement — call this before any screenshot: the region is set to the
 * untransformed box expanded by `width` px plus a 1px antialiasing pad on
 * every side, in the element's LOCAL user space (origin at the element's
 * own top-left, verified empirically). The same adjustment in both flows
 * keeps render and painted extents identical, and it is a deterministic
 * function of the same DOM, so pinned Render history replays
 * byte-identically.
 *
 * Fails loudly (PROD-1, review): a skipped sizing would leave Chromium
 * clipping the ring and the source graphic to the placeholder region —
 * the exact silent-clip failure the bounded-capture contract forbids — so
 * a missing #canvas, Layer element, or filter def rejects the paint and
 * measurement flows naming the Layer, instead of silently succeeding.
 * The guards are reachable only if the page is not the markup the builder
 * emitted (the same `buildCompositionHtml` call emits the elements and
 * their defs), i.e. a markup-contract violation — fail fast at the seam.
 */
export async function sizeEffectFilterRegions(page: Page, layers: SnapshotLayer[]): Promise<void> {
  const specs = outlineFilterSpecs(layers);
  if (specs.length === 0) return;
  const failure = await page.evaluate((input) => {
    const canvas = document.getElementById("canvas");
    if (!canvas) return "#canvas element missing";
    const problems: string[] = [];
    input.forEach((spec) => {
      const el = canvas.children[spec.index] as HTMLElement | undefined;
      const filter = document.getElementById(spec.id);
      if (!el) {
        problems.push(`Layer "${spec.name}": element ${spec.index} not found in #canvas`);
      } else if (!filter) {
        problems.push(`Layer "${spec.name}": effect filter ${spec.id} not found`);
      } else {
        const saved = el.style.transform;
        el.style.transform = "none";
        const box = el.getBoundingClientRect();
        el.style.transform = saved;
        const pad = spec.pad;
        filter.setAttribute("filterUnits", "userSpaceOnUse");
        filter.setAttribute("x", String(-pad));
        filter.setAttribute("y", String(-pad));
        filter.setAttribute("width", String(box.width + 2 * pad));
        filter.setAttribute("height", String(box.height + 2 * pad));
      }
    });
    return problems.length > 0 ? problems.join("; ") : null;
  }, specs);
  if (failure !== null) {
    throw new Error(
      `Outline filter region sizing failed: ${failure}. ` +
        `The page is not the markup the composition builder emitted, so the effect would be clipped to its ` +
        `placeholder region — refusing to paint or measure clipped ink.`,
    );
  }
}

/**
 * The result of the fit-to-box derivation for one Layer (#295): the effective
 * font size the derivation applied, whether the block fits its box at that
 * size, and — when the block initially overflowed — the first-ratio estimate
 * of the size that would fit (the number the below-minimum refusal names).
 * `neededFontSize` is null when the block never overflowed (the effective
 * size IS the stored size).
 */
export interface TextFitProbe {
  effectiveFontSize: number;
  fits: boolean;
  neededFontSize: number | null;
}

/**
 * Text fit-to-box derivation (#295, spec #285 US-016, ISC-56, DEC-010,
 * DEC-005): the ONE derivation point shared by paint, measurement, and
 * anchored placement. For every text Layer with a stored fit box, this pass
 * measures the laid-out text block at the stored font size in the live page
 * (the same markup painting uses — buildCompositionHtml is the one markup for
 * paint AND measurement, so the derived size can never drift between
 * painting and measuring) and shrinks the element's font size until the
 * block fits the box — shrinking only: it never grows the size and never
 * touches weight or width (DEC-010). The derived size is applied to the
 * element that carries the font size, marked `data-ply-fit` in the markup
 * (emitted only when a box is stored, so pre-#295 markup is byte-identical).
 *
 * The derivation is deterministic: unwrapped text scales linearly with the
 * font size (em tracking, unitless line height), so it converges in one
 * step; a wrapped block iterates (measure → scale → re-measure, a bounded
 * fixed-point loop) because the wrapped line count changes with the size.
 * The effective size is never stored anywhere — it re-derives from the
 * revision's own facts at every read, so edits to the text, font, tracking,
 * or wrap width stay correct, and revisions without a box are untouched.
 *
 * The minimum is the documented fixed floor MIN_FIT_FONT_SIZE: a block that
 * still overflows at the floor reports `fits: false` with the needed-size
 * estimate, which the add/edit paths turn into the shared below-minimum
 * refusal (textFitRefusal). Must run after the font-resolution gate, so the
 * derivation measures the retained faces, never a fallback.
 */
export async function applyTextFit(page: Page, layers: SnapshotLayer[]): Promise<(TextFitProbe | null)[]> {
  const specs = layers.map((l, index) => {
    if (l.revision.kind !== "text") return null;
    const fit = normalizeStoredTextFitBox(l.revision);
    if (fit === undefined) return null;
    return {
      index,
      fontSize: l.revision.fontSize,
      fitWidth: fit.width,
      fitHeight: fit.height,
      minSize: MIN_FIT_FONT_SIZE,
    };
  });
  if (specs.every((spec) => spec === null)) return specs.map(() => null);
  return page.evaluate((input) => {
    const canvasEl = document.getElementById("canvas");
    if (!canvasEl) throw new Error("text fit pass: #canvas element missing");
    return input.map((spec): { effectiveFontSize: number; fits: boolean; neededFontSize: number | null } | null => {
      if (!spec) return null;
      const outer = canvasEl.children[spec.index] as HTMLElement | undefined;
      if (!outer) throw new Error(`text fit pass: element ${spec.index} not found in #canvas`);
      // The derivation sets the font size on the element that CARRIES it —
      // the text element marked `data-ply-fit` (the outer element itself for
      // the single-div markup, the inner text div for the region/grade and
      // gradient structures).
      const holder = outer.matches("[data-ply-fit]") ? outer : outer.querySelector("[data-ply-fit]");
      if (!(holder instanceof HTMLElement)) {
        return { effectiveFontSize: spec.fontSize, fits: true, neededFontSize: null };
      }
      const W = spec.fitWidth;
      const H = spec.fitHeight;
      const MIN = spec.minSize;
      const overflow = (r: DOMRect): boolean => r.width > W + 0.01 || r.height > H + 0.01;
      let size = spec.fontSize;
      holder.style.fontSize = `${size}px`;
      let rect = holder.getBoundingClientRect();
      // Already fits (or exactly fills) the box: shrink-only — the effective
      // size IS the stored size.
      if (!overflow(rect)) {
        return { effectiveFontSize: size, fits: true, neededFontSize: null };
      }
      let needed: number | null = null;
      for (let i = 0; i < 24; i++) {
        const s = Math.min(W / rect.width, H / rect.height);
        const candidate = Math.floor(size * s * 100) / 100;
        if (i === 0) needed = candidate;
        const next = Math.max(MIN, candidate);
        if (next >= size) break;
        size = next;
        holder.style.fontSize = `${size}px`;
        rect = holder.getBoundingClientRect();
        if (!overflow(rect)) {
          return { effectiveFontSize: size, fits: true, neededFontSize: needed };
        }
      }
      return { effectiveFontSize: size, fits: false, neededFontSize: needed };
    });
  }, specs);
}

/**
 * The page HTML for one Composition. Layer names never reach the markup;
 * every interpolated value is a validated finite number, a whitelisted MIME
 * type, a hash-derived internal family, or the strict-hex validated color —
 * except text content, which is HTML-escaped.
 *
 * This builder is the ONE geometry-and-font authority for Composition
 * layout (DEC-004): current-state painting (#80), historical replay (#87),
 * and read-only layout measurement (#136) all render and measure through
 * the exact markup it produces — the same retained font bytes under the
 * same internal @font-face families, the same emitted rotate∘flip∘scale
 * transforms about (x, y) with transform-origin 0 0, the same canvas and
 * text wrapping. There is no second markup builder to drift from.
 */
export function buildCompositionHtml(
  canvas: { width: number; height: number },
  layers: SnapshotLayer[],
  supersample = 1,
): string {
  if (!Number.isInteger(supersample) || supersample < 1) {
    throw new Error(`Invalid supersample factor ${supersample}: must be an integer of at least 1.`);
  }
  const faces = new Map<string, { bytes: Buffer; caller?: CallerFontFacts }>();
  for (const l of layers) {
    if (l.revision.kind === "text" && !faces.has(l.revision.contentHash)) {
      faces.set(l.revision.contentHash, {
        bytes: l.contentBytes,
        ...(l.revision.callerFont !== undefined ? { caller: l.revision.callerFont } : {}),
      });
    }
  }
  const fontCss = [...faces]
    .map(([hash, face]) =>
      // Caller fonts (#232, DEC-006) declare their real weight/stretch and
      // their own glyph format — the same facts the ingestion probe declared
      // — so the browser never synthesizes a weight or width. Bundled and
      // legacy faces keep the exact pre-#232 rule, so pinned history paints
      // byte-identically.
      face.caller !== undefined
        ? callerFontFaceCss(internalFontFamily(hash), face.bytes, face.caller)
        : `@font-face { font-family: "${internalFontFamily(hash)}"; ` +
          `src: url(data:font/ttf;base64,${face.bytes.toString("base64")}) format("truetype"); }`,
    )
    .join("\n");
  const els = layers
    .map((l, layerIndex) => {
      const rev = l.revision;
      const base = `position:absolute;left:${rev.x}px;top:${rev.y}px;opacity:${rev.opacity};`;
      // Canonical transform (#133/#134/#135, ADR-0016): applied about the
      // Layer's (x, y) top-left placement point. Flip and scale act on the
      // content along its own axes first (both are diagonal transforms and
      // commute, so their emitted order among themselves is immaterial), then
      // rotation rotates the transformed result — CSS composes left-to-right
      // as rotate∘flip∘scale. Each factor is emitted only when non-identity,
      // so revisions written before #133/#134/#135 and identity-transform
      // revisions paint exactly as before (pinned history stays
      // byte-identical).
      const transformParts: string[] = [];
      if (rev.rotationDeg !== 0) {
        transformParts.push(`rotate(${rev.rotationDeg}deg)`);
      }
      if (rev.flipX) {
        transformParts.push("scaleX(-1)");
      }
      if (rev.flipY) {
        transformParts.push("scaleY(-1)");
      }
      if (rev.scaleX !== 1 || rev.scaleY !== 1) {
        transformParts.push(`scale(${rev.scaleX},${rev.scaleY})`);
      }
      const transformed =
        transformParts.length > 0
          ? `transform:${transformParts.join(" ")};transform-origin:0 0;`
          : "";
      // Canonical effects (#139/#140, ADR-0018/0019; edge glow #221, ADR-0024):
      // one `filter` chain on the Layer element. The edge glow comes FIRST —
      // its inner-alpha band operates on the region-clipped, graded composite
      // (see glowFilterDef) — then the outline's feMorphology dilate filter
      // hugs the composite's alpha/glyph ink and composites the ring under
      // the source graphic (def above, referenced by id), and the shadow's
      // single drop-shadow comes LAST, so it is cast from the outlined
      // composite. CSS filter-list chaining feeds each function's output to
      // the next, so the chain builds the union exactly once per primitive —
      // dilate extends exactly `width` px in every direction with no scallop
      // and no compounding. The transform above then maps
      // content+glow+outline+shadow together, and the element's opacity
      // fades all of it. Emitted only when an effect exists, so pre-#139/#140
      // revisions and their pinned Render history paint exactly as before
      // (the shadow-only markup is byte-identical to the #139 form).
      const outlineFn =
        rev.outline !== undefined
          ? `url(#${outlineFilterId(rev.outline, layerIndex)})`
          : "";
      // The edge glow (#221, spec #218 US-002, ADR-0024): the FIRST function
      // of the outer element's filter chain — ahead of outline and shadow —
      // so it operates on the region-clipped, graded composite the inner
      // element renders, paints over the graded content, and stays inside
      // the blend unit (the whole Layer still blends as one against the
      // backdrop). CSS filter-list chaining then feeds the glow composite
      // to the outline's dilate — the glow's band is a subset of the
      // source's alpha, so the outline's geometry is unchanged — and the
      // shadow is cast from the outlined composite. Emitted only when a
      // glow fact exists, so pre-#221 revisions paint exactly as before.
      const glowFn =
        rev.glow !== undefined
          ? `url(#${glowFilterId(rev.glow, layerIndex)})`
          : "";
      const shadowFn =
        rev.shadow !== undefined
          ? `drop-shadow(${rev.shadow.dx}px ${rev.shadow.dy}px ${rev.shadow.blur}px ${rev.shadow.color})`
          : "";
      const effectsFns = [glowFn, outlineFn, shadowFn].filter(Boolean).join(" ");
      const effectsFilter = effectsFns !== "" ? `filter:${effectsFns};` : "";
      // The blend mode (#220, spec #218 US-003, ADR-0024): applied to the
      // OUTER element via CSS mix-blend-mode in the DEC-002 paint order,
      // so the whole Layer — content, visible region, grade, outline,
      // shadow, transform, and opacity — blends as ONE unit against everything
      // beneath it. Emitted only when set, so pre-#220 revisions and their
      // pinned Render history paint byte-identically.
      const blendCss = rev.blend !== undefined ? `mix-blend-mode:${rev.blend};` : "";
      // The visible region's clip reference (#211, ADR-0023): applied to the
      // INNER content element, so the clip crops the content BEFORE the
      // Layer element's filter chain — the outline dilate and the drop-shadow
      // hug the region's edge, and the transform then maps content+region+
      // effects together (the DEC-004 paint order: content, visible region,
      // outline, shadow, transform and opacity). The markup shape delivers
      // the order without a second mechanism: a region-wearing Layer paints
      // as an outer wrapper (placement, opacity, transform, effects) around
      // the clipped content element. Emitted only when a region exists, so
      // pre-#211 revisions and their pinned Render history paint exactly as
      // before.
      const regionClip =
        rev.visibleRegion !== undefined ? `clip-path:url(#${regionClipPathId(rev.visibleRegion, layerIndex)});` : "";
      // The grade controls (#219, spec #218 US-001, ADR-0024): applied to the
      // INNER content element in the DEC-003 fixed deterministic sequence
      // (brightness -> contrast -> saturate -> warmth) so outline and shadow
      // colors and alpha are never affected. Emitted only when a non-neutral
      // grade fact exists.
      const gradeFilter = gradeFilterCss(rev.grade, layerIndex);
      if (rev.kind === "text") {
        // Selected text axes (#179, ADR-0021): read from the revision alone
        // through the one stored-axes reader — this builder is the one
        // markup for paint AND measurement, so measured and rendered text
        // agree on the axis-selected look. Emitted only when stored, so
        // pre-#179 revisions paint exactly as before (pinned history stays
        // byte-identical).
        const axes = normalizeStoredTextAxes(rev);
        const axesCss =
          axes !== undefined
            ? `font-variation-settings:'wght' ${axes.weight}, 'wdth' ${axes.width};`
            : "";
        // Selected text typography (#187, ADR-0021): read from the revision
        // alone through the one stored-typography reader — the same markup
        // paint and measurement share, so measured and rendered text agree
        // on spacing and the line-box height. Emitted only when stored, so
        // pre-#187 revisions paint exactly as before (pinned history stays
        // byte-identical).
        const typography = normalizeStoredTextTypography(rev);
        const typographyCss =
          (typography.tracking !== undefined ? `letter-spacing:${typography.tracking}em;` : "") +
          (typography.lineHeight !== undefined ? `line-height:${typography.lineHeight};` : "");
        // Caller fonts (#232, ADR-0021): font-synthesis is disabled on the
        // element so the browser can never faux-bold or faux-extend a look
        // the file's bytes do not contain (the @font-face rule already
        // declares the face's real weight/stretch). Emitted only for caller
        // fonts — bundled and legacy text elements keep their exact markup,
        // so pinned history paints byte-identically.
        const synthesisCss = rev.callerFont !== undefined ? "font-synthesis:none;" : "";
        const fill = normalizeStoredTextFill(rev.color);
        // Text layout rule (#287, spec #285 DEC-001, ADR-0017 amendment):
        // "natural" lays out text at its natural width, wrapping only at written
        // line breaks. "legacy" keeps the pre-#287 canvas-bounded pre-wrap behavior
        // so retained Renders replay byte-identically.
        //
        // The wrap width (#294, spec #285 US-015, DEC-001/DEC-005, ADR-0017
        // amendment) is a natural-layout fact: when stored, the text
        // soft-wraps at spaces within it — `width: <W>px; white-space:
        // pre-wrap` (written line breaks still break; preserved spaces
        // still hold; `pre` never wraps at spaces, so the width form needs
        // pre-wrap). With no width, the exact pre-#294 natural markup
        // applies (`white-space: pre; width: max-content`), so removing the
        // width restores the unwrapped render byte-for-byte and revisions
        // without the fact paint exactly as before. A legacy revision never
        // carries a wrap width.
        const naturalLayout = rev.layoutRule === "natural";
        // The wrap width projects through the ONE stored-field reader, like
        // the axes and typography above — a malformed stored field refuses
        // loudly at the paint boundary instead of interpolating into the
        // markup (#294 review PROD-2).
        const wrapWidth = naturalLayout ? normalizeStoredTextWrapWidth(rev) : undefined;
        // The fit box (#295): the one stored-field reader again — a malformed
        // stored pair refuses loudly at the paint boundary. When stored, the
        // text element is marked `data-ply-fit` so the one in-page fit
        // derivation can find the element that carries the font size (the
        // marker is emitted only when a box is stored, so pre-#295 markup is
        // byte-identical).
        const fitBox = normalizeStoredTextFitBox(rev);
        const fitAttr = fitBox !== undefined ? " data-ply-fit" : "";
        const layoutCss = naturalLayout
          ? wrapWidth !== undefined
            ? `width:${wrapWidth}px;white-space:pre-wrap;`
            : "width:max-content;white-space:pre;"
          : "white-space:pre-wrap;";
        const outerLayoutCss = naturalLayout
          ? wrapWidth !== undefined
            ? `width:${wrapWidth}px;`
            : "width:max-content;"
          : "";
        if (fill.type === "solid") {
          const textStyle =
            `font-family:'${internalFontFamily(rev.contentHash)}';` +
            `font-size:${rev.fontSize}px;color:${fill.color};${synthesisCss}${axesCss}${typographyCss}${layoutCss}`;
          if (rev.visibleRegion === undefined && gradeFilter === "") {
            return `<div style="${base}${outerLayoutCss}${transformed}${effectsFilter}${blendCss}${textStyle}"${fitAttr}>${escapeHtml(rev.text)}</div>`;
          }
          return (
            `<div style="${base}${outerLayoutCss}${transformed}${effectsFilter}${blendCss}">` +
            `<div style="${textStyle}${regionClip}${gradeFilter}"${fitAttr}>${escapeHtml(rev.text)}</div></div>`
          );
        }

        // Gradient text (#222, spec #218 US-004, DEC-008):
        // The gradient spans the text's painted ink box via background-clip: text.
        // Two-element structure carries the effectsFilter (outline, shadow, glow)
        // on the outer wrapper hugging the glyph alpha, while the inner element
        // clips the background gradient.
        const gradientCss =
          `background:${fillCssBackground(fill)};` +
          `-webkit-background-clip:text;background-clip:text;` +
          `-webkit-text-fill-color:transparent;color:transparent;`;
        const textStyle =
          `font-family:'${internalFontFamily(rev.contentHash)}';` +
          `font-size:${rev.fontSize}px;${synthesisCss}${axesCss}${typographyCss}${layoutCss}` +
          gradientCss;

        return (
          `<div style="${base}${outerLayoutCss}${transformed}${effectsFilter}${blendCss}">` +
          `<div style="${textStyle}${regionClip}${gradeFilter}"${fitAttr}>${escapeHtml(rev.text)}</div></div>`
        );
      }
      if (rev.kind === "shape") {
        // A shape Layer (#208) paints as a filled div: the geometry is the
        // element's box (width/height in canvas px), the fill is the
        // validated canonical fill (#210 gradients paint their CSS
        // projection — `fillCssBackground`, the one paint projection of the
        // one fill form), and the geometry variation is
        // pure CSS — a corner radius becomes border-radius in px; an ellipse
        // is the same box with a 50% border radius. No image bytes are
        // involved (DEC-001): the element paints from the revision's
        // validated parameters alone. The same element geometry feeds the
        // shared effects chain and the measurement probe, so a shape measures
        // exactly what it paints.
        const radiusCss =
          rev.shape === "ellipse"
            ? "border-radius:50%;"
            : rev.cornerRadius !== undefined
              ? `border-radius:${rev.cornerRadius}px;`
              : "";
        const shapeStyle =
          `width:${rev.width}px;height:${rev.height}px;` +
          `background:${fillCssBackground(rev.fill)};${radiusCss}`;
        if (rev.visibleRegion === undefined && gradeFilter === "") {
          return `<div style="${base}${transformed}${effectsFilter}${blendCss}${shapeStyle}"></div>`;
        }
        return (
          `<div style="${base}${transformed}${effectsFilter}${blendCss}">` +
          `<div style="${shapeStyle}${regionClip}${gradeFilter}"></div></div>`
        );
      }
      // The vector colour (#215, spec #207 US-005, DEC-008): a recoloured
      // Layer paints as ONE solid-colour element masked by the retained
      // bytes themselves (ADR-0012's tint machinery — mask-image +
      // mask-size 100% 100%, the mask IS the content, pixel-for-pixel), so
      // every pixel the vector covers with alpha renders exactly the
      // requested colour (out = colour × alpha — full replacement, no
      // luminance carry-over: a multi-colour vector becomes a single-colour
      // silhouette) and every transparent pixel stays untouched — alpha
      // edges preserved. The retained bytes ride to the browser unchanged
      // as a data URL through the browser image path, which disables
      // scripts and external loads by construction — the same inertness the
      // <img> path has (the vector is never inlined into the page DOM), and
      // the bytes are never rewritten. The element's box is the intrinsic
      // size (the same box the <img> form paints), so measure and inspect
      // read the same numbers. Standard mask-* first, -webkit- alongside —
      // the scene-render maskCss recipe. Emitted only when the colour is
      // set, so pre-#215 revisions and their pinned Render history paint
      // exactly as before.
      const vectorColorCss =
        rev.vectorColor !== undefined
          ? `width:${rev.width}px;height:${rev.height}px;background:${rev.vectorColor};` +
            maskCss("mask-image", `url('data:${MIME[rev.format]};base64,${l.contentBytes.toString("base64")}')`) +
            maskCss("mask-size", "100% 100%") +
            maskCss("mask-position", "center") +
            maskCss("mask-repeat", "no-repeat") +
            `display:block;`
          : "";
      if (rev.vectorColor !== undefined) {
        // ONE two-element structure for every recoloured Layer, region or
        // not (INT-1): the effect chain lives on the OUTER element and the
        // mask (and the region clip, when set) on the INNER one. CSS applies
        // an element's own mask AFTER its filters — a single element carrying
        // both would clip the outline ring and the shadow to the silhouette,
        // exactly the same-element failure that moved the region clip onto
        // the inner element in #211. The DEC-004 paint order falls out of
        // the markup shape: the colour IS content paint — the masked element
        // is the inner content element, the region clip crops it, and the
        // wrapper's effect chain hugs the cropped, coloured edge. Layers
        // without a region emit the same wrapper shape the region path
        // already used, with an empty clip.
        return (
          `<div style="${base}${transformed}${effectsFilter}${blendCss}">` +
          `<div style="${vectorColorCss}${regionClip}${gradeFilter}"></div></div>`
        );
      }
      if (rev.visibleRegion !== undefined || gradeFilter !== "") {
        return (
          `<div style="${base}${transformed}${effectsFilter}${blendCss}">` +
          `<img src="data:${MIME[rev.format]};base64,${l.contentBytes.toString("base64")}"${imageSize(rev)} style="display:block;${regionClip}${gradeFilter}">` +
          `</div>`
        );
      }
      return `<img src="data:${MIME[rev.format]};base64,${l.contentBytes.toString("base64")}"${imageSize(rev)} style="${base}${transformed}${effectsFilter}${blendCss}">`;
    })
    .join("");
  return (
    `<!doctype html><html><head><style>` +
    fontCss +
    `html,body{margin:0;padding:0;background:transparent}` +
    // Supersampled paint (#184, ADR-0022): the markup keeps its exact
    // canvas-pixel geometry — positions, font sizes, intrinsic image sizes,
    // transforms, shadow and outline lengths all stay in canvas px — and one
    // device transform maps the whole canvas to factor× device pixels, so
    // every length (including values the builder does not scale: intrinsic
    // sizes, em/unitless values, filter pixels) composes correctly with no
    // per-site scaling to drift. Factor 1 emits exactly the pre-#184 markup.
    `#canvas{position:relative;width:${canvas.width}px;height:${canvas.height}px;overflow:hidden` +
    (supersample > 1 ? `;transform:scale(${supersample});transform-origin:0 0` : "") +
    `}` +
    `</style></head>` +
    `<body>${paintDefs(layers, supersample)}<div id="canvas">${els}</div></body></html>`
  );
}