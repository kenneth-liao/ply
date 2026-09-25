/**
 * Read-only Composition geometry measurement (#136/#137, spec #132 US-002 /
 * US-006, DEC-001, DEC-003–004).
 *
 * One measuring authority: measurement renders the EXACT markup the paint
 * path builds (`buildCompositionHtml` — same retained font bytes under the
 * same internal @font-face families, same emitted rotate∘flip∘scale
 * transforms about (x, y), same canvas and text wrapping) into the shared
 * render page, applies the paint path's content-decode and font-resolution
 * rejection contract, and then reads each Layer element's geometry with the
 * browser's own measurement — never a second transform model, font source,
 * or markup builder. Because Layers are absolutely positioned, one Layer's
 * geometry never depends on the others; the full Composition is always
 * measured and a requested use merely filters the report.
 *
 * What each reported box means (documented, DEC-004 — layout ≠ painted):
 * - `content` — the Layer's untransformed content box along its own axes.
 *   Image Layers: the retained content's intrinsic size (the canonical
 *   revision facts verified at ingestion). Text Layers: the DOM line-box
 *   layout extent of the retained face at the revision's font size under
 *   the Composition's text wrapping — includes line-box leading; there is
 *   no stored intrinsic text size to consult.
 * - `corners` — the transformed content rectangle's four corners (top-left,
 *   top-right, bottom-right, bottom-left) in Composition coordinates,
 *   browser-measured through the revision's canonical transform.
 * - `box` — the axis-aligned bounding box of those corners: the layout
 *   footprint in Composition coordinates, UNCLIPPED (a Layer extending past
 *   the canvas reports its full geometry).
 * - `painted` — the axis-aligned bounding box of the Layer's VISIBLE ink
 *   (alpha > 0) in Composition coordinates, UNCLIPPED: image alpha trimming
 *   excludes transparent padding from painted but not from content, text
 *   painted bounds are tight glyph ink rather than the line-box extent, and
 *   a Layer's visible region (#211, ADR-0023) narrows the ink the same way —
 *   content outside the region is not ink, so painted extents report the
 *   region-clipped ink while the layout `box` stays the full transformed
 *   content box (DEC-005).
 *   The ink pass renders the same paint-identical page, hides the other
 *   Layers (no reflow — they are absolutely positioned), screenshots the
 *   Layer alone through a bounded per-Layer capture window (shifted, never
 *   grown with the Layer's off-canvas distance), and reads its alpha
 *   support — so the numbers are the browser's own paint, never a second
 *   rasterizer. Values are reported through round2 (fractional): the ink
 *   support is quantized to the screenshot's pixel grid, but the canvas
 *   offsets are layout-derived and may be fractional. Layers without visible
 *   ink (fully transparent content, or opacity 0) report `painted: null`;
 *   opacity scaling changes alpha values, never the ink support (and a
 *   Layer's footprint is its own ink — occlusion by later Layers is
 *   stacking, not footprint). Painted extents are the alpha support of the
 *   browser's actual paint, so resampling (scale/rotation interpolation)
 *   may bleed ink roughly a pixel past the geometric ink boundary — that
 *   bleed is genuinely painted and the render shows it too. A Layer whose
 *   layout box exceeds the bounded capture window is refused loudly rather
 *   than measured with unbounded memory. Effects (#139/#140, ADR-0018/0019)
 *   extend the ink beyond the layout box: the ink pass captures the same
 *   paint markup (so the effects' ink IS part of `painted`), and the
 *   capture window is widened by the revision's canvas-space effect reach
 *   (the combined local reach — outline width plus the shadow reach
 *   |dx| + |dy| + 2·blur, additive — scaled by the transform's largest
 *   factor; the effects paint before the transform), from the facts
 *   alone — an effected Layer's full extent is captured or
 *   the measurement is refused loudly, never silently clipped. The window
 *   is judged against the VISIBLE ink (#211, ADR-0023): a region-carrying
 *   Layer is windowed around its region's transformed box, so a large
 *   padded source refused uncropped at a given scale measures once
 *   cropped to its subject (DEC-006).
 * - `paintedOnCanvas` — `painted` ∩ the canvas rectangle: the footprint that
 *   actually shows in a render; `null` when empty (no visible ink, or ink
 *   entirely outside the canvas).
 * - `clipped` — whether painted ink falls outside the canvas, computed
 *   against the PAINTED extents, never the layout box (a mostly transparent
 *   image may have a layout box past the canvas while all of its ink stays
 *   visible).
 *
 * These remain LAYOUT-vs-PAINTED distinct by construction (DEC-004): `box`
 * is layout geometry, `painted` is ink geometry, both in Composition
 * coordinates through the same retained font bytes and the same emitted
 * transforms. The shadow effect is reflected in painted extents and in the
 * reported `effects` facts (#139, ADR-0018); outline (#140) and any wider
 * effect surface extend the same contract, and the visible region (#211,
 * ADR-0023) narrows it — reported in the `visibleRegion` facts.
 *
 * The query writes no Project state: the Composition, its current revisions,
 * and verified retained bytes are resolved exactly once through the
 * canonical full resolver under the Project lock (corrupt, missing, or
 * malformed retained state fails loudly there), then measured from that
 * in-memory snapshot. Resolution is fully local — no network, no billing.
 */
import { withRenderPage } from "./browser.js";
import { readCompositionInternalFull } from "./composition.js";
import { readLayerInternalFull } from "./layer.js";
import { resolveProjectRoot } from "./project.js";
import { withProjectLock } from "./project-lock.js";
import { MAX_DIMENSION, MAX_PIXELS, decodePng } from "./png.js";
import {
  applyTextFit,
  buildCompositionHtml,
  rejectUnresolvedFonts,
  sizeEffectFilterRegions,
  type SnapshotLayer,
  type TextFitProbe,
} from "./composition-paint.js";
import {
  normalizeStoredTextAxes,
  normalizeStoredTextTypography,
  normalizeStoredTextWrapWidth,
  normalizeStoredTextFitBox,
  normalizeStoredTextRuns,
  normalizeStoredScale,
  normalizeStoredFlip,
  normalizeStoredRotation,
  normalizeStoredSkew,
  normalizeStoredPerspective,
  normalizeStoredBlur,
  storedTextRunSlices,
  type LayerTextRun,
  type SnapshotRunFont,
  type LayerRevision,
  type LayerOutline,
  type LayerShadow,
  type LayerTextTypography,
  type ResolvedLayerRevision,
  type LayerGrade,
  type LayerGlow,
  type StoredLayerBlendMode,
  PERSPECTIVE_DISTANCE_PX,
} from "./layer.js";
import type { Page } from "playwright";
import { type LayerFill, normalizeStoredTextFill } from "./fill.js";

/** One Layer's measured layout geometry (module doc documents each box). */
export interface MeasuredLayerBounds {
  name: string;
  layerId: string;
  kind: "image" | "text" | "shape";
  /** Untransformed content box along the content's own axes (px). */
  content: { width: number; height: number };
  /** Axis-aligned bounding box of the transformed content rectangle in Composition coordinates (px, unclipped). */
  box: { x: number; y: number; width: number; height: number };
  /** Transformed content rectangle corners, clockwise from top-left, in Composition coordinates (px). */
  corners: { x: number; y: number }[];
  /** Axis-aligned bounding box of the Layer's visible ink (alpha > 0) in Composition coordinates (px, unclipped, quantized to the screenshot's pixel grid; offsets are layout-derived and may be fractional); null when nothing is visible or when capture is refused. */
  painted: { x: number; y: number; width: number; height: number } | null;
  /** The painted extent's intersection with the canvas rectangle — the footprint that shows in a render; null when empty or when capture is refused. */
  paintedOnCanvas: { x: number; y: number; width: number; height: number } | null;
  /** Whether painted ink falls outside the canvas, judged against the painted extents (never the layout box); false when unpainted or when capture is refused. */
  clipped: boolean;
  /** Actionable refusal message when the Layer's own capture window exceeds the bound (max 8192px per axis or 16,777,216px total); null when within bounds. Distinguishes uncaptured from empty ink (painted: null). */
  refused: string | null;
  /** The revision's placement facts, verbatim. */
  placement: { x: number; y: number; opacity: number };
  /** The revision's normalized canonical transform facts, verbatim. */
  transform: { scaleX: number; scaleY: number; rotationDeg: number; flipX: boolean; flipY: boolean; skewXDeg: number; skewYDeg: number; perspectiveTiltXDeg: number; perspectiveTiltYDeg: number };
  /** The revision's effective effect facts (#139/#140): `shadow` and
   * `outline` are the stored effect parameters (or null when the Layer has
   * none of that effect) — the same facts painting applies, reported for
   * auditability. */
  effects: { shadow: LayerShadow | null; outline: LayerOutline | null };
  /** The revision's effective grade controls (#219, spec #218 US-001, ADR-0024):
   * the stored grade parameters (or null when the Layer has no grade) — the
   * same facts painting applies, reported for auditability. */
  grade: LayerGrade | null;
  /** The revision's effective edge glow (#221, spec #218 US-002, ADR-0024):
   * the stored glow parameters (or null when the Layer has no glow) — the
   * same fact painting applies, reported for auditability. The glow never
   * extends painted extents (DEC-005), so this fact rides beside them. */
  glow: LayerGlow | null;
  /** The revision's effective blur radius in px (#299, spec #285 US-010,
   * DEC-005, ADR-0024 amendment): the stored radius (or null when the Layer
   * has no blur) — the same fact painting applies as the last function of
   * the effects chain, reported for auditability. The blur GROWS painted
   * extents (by the Gaussian kernel's ~3σ visible reach, ceiled), which
   * `painted`/`paintedOnCanvas`/`clipped` already reflect. */
  blur: number | null;
  /** The revision's effective blend mode (#220, spec #218 US-003, ADR-0024):
   * the stored mix-blend-mode (or null when normal/unblended) — the same fact
   * painting applies, reported for auditability. */
  blend: StoredLayerBlendMode | null;
  /** The revision's visible region (#211, ADR-0023): the stored
   * region facts painting clips to (or null when the Layer has none —
   * absence IS the no-region form), including the optional corner radius
   * (#212) when set. Content outside the region is not ink:
   * `painted`, `paintedOnCanvas`, and `clipped` already follow it (the
   * painted extents stay the rectangle's — the rounded corners never
   * shrink the ink's bounding box). */
  visibleRegion: { x: number; y: number; width: number; height: number; cornerRadius?: number } | null;
  /** The revision's vector colour (#215, spec #207 US-005, DEC-008): the
   * stored canonical hex colour painting replaces the vector's colours
   * with (or null — absence IS the no-colour form). Image Layers only: the
   * setter refuses the fact on every other kind, so other kinds report
   * null. */
  vectorColor: string | null;
  /** The revision's ONE fill (DEC-003), for shape Layers (#208/#210) and text
   *  Layers (#222): the canonical fill object painting applies — a solid colour,
   *  or a linear or radial gradient with its stops. Image Layers report null. */
  fill: LayerFill | null;
  /** The revision's selected text axes (#179, ADR-0021): the stored weight
   * and width a variable-font text Layer paints with (or null when the
   * retained font is static — a static revision stores no axis fields). */
  axes: { weight: number; width: number } | null;
  /** The retained font's identity (#232): a caller-supplied font reports
   * the family name its own file declares and `caller: true`; bundled and
   * legacy faces have no stored family — the retained bytes are their only
   * identity — and report null. */
  font: { family: string; caller: true } | null;
  /** The revision's selected text typography (#187, ADR-0021): the stored
   * tracking and line height a text Layer paints with — each field present
   * only when set (an omitted control paints as normal spacing / the font's
   * own line height), `{}` when neither is stored. */
  typography: LayerTextTypography;
  /** The revision's selected wrap width in layout px (#294, spec #285
   * US-015, DEC-001/DEC-005, ADR-0017 amendment): the stored width the text
   * soft-wraps within (written line breaks still break), or null when the
   * text Layer carries none (natural one-line layout). Text Layers only;
   * every other kind reports null. The measured `content` box already IS
   * the wrapped box: measurement renders the exact paint markup, which lays
   * the text out at this width before the canonical transform applies. */
  wrapWidth: number | null;
  /** The stored fit box (#295), reported like the wrap width for
   *  auditability — the box the ONE fit derivation shrinks the font size
   *  against (layout px, before the transform), or null when the text Layer
   *  carries none. Text Layers only; every other kind reports null. */
  fit: { width: number; height: number } | null;
  /** The EFFECTIVE font size (#295): the size the ONE in-page fit
   *  derivation paints and measures at — the stored font size when no fit
   *  box is stored or the block already fits, a smaller size when the box
   *  shrank it (DEC-010: shrink-only). Derived at read time, never stored.
   *  Text Layers only; every other kind reports null. */
  effectiveFontSize: number | null;
  /** The revision's text runs (#297, spec #285 US-017, ISC-54, ADR-0021
   *  amendment), reported for auditability beside the layer-level facts:
   *  each run's 1-based index, its text slice, its resolved colour (the
   *  canonical fill object painting it — the layer colour for a run
   *  without an override), its font identity (the caller font's family and
   *  caller flag, null for bundled and legacy faces — the retained bytes
   *  are their identity), and its effective axes (the run's resolved
   *  weight/width, null when the run paints the layer axes or a static
   *  face). Present if and only if the revision carries runs — a single-run
   *  Layer's report is today's report, field for field. */
  runs?: Array<{
    index: number;
    text: string;
    color: LayerFill;
    font: { family: string; caller: true } | null;
    axes: { weight: number; width: number } | null;
  }>;
}

export interface MeasureCompositionResult {
  composition: string;
  canvas: { width: number; height: number };
  layers: MeasuredLayerBounds[];
}

/**
 * Browser-side geometry probe, evaluated in the render page. Must stay
 * self-contained — Playwright serializes it. For each Layer element (DOM
 * order = reference-list order) it reads the untransformed content box by
 * temporarily clearing the inline transform (the measure page is throwaway
 * and never paints), then maps the content rectangle's corners through the
 * restored transform and reports its axis-aligned bounding box — all in
 * coordinates relative to the canvas origin, i.e. Composition coordinates.
 *
 * The visible region (#211, ADR-0023) rides along as `regions`: for each
 * Layer with a region, the transformed axis-aligned bounding box of the
 * REGION rectangle — the same matrix authority maps the region's local
 * corners (the region is defined in the Layer's own content px, relative
 * to the content box's top-left, which is the element's layout corner) —
 * so the bounded ink-capture window and its centering judge the ink the
 * region leaves visible, never the full layout box. Layers without a
 * region report null and keep the full layout box exactly as before.
 *
 * The transform authority is the COMPUTED transform (#298): the browser's
 * own resolved matrix — percentages in the perspective pivot's translate()
 * resolved against the element's border box, the perspective distance and
 * every 3D factor folded into one matrix3d — so the corners map through
 * exactly the matrix the render paints with, projective divide included.
 * The inline style is still what gets cleared and restored; the computed
 * matrix is read before clearing.
 */
const MEASURE_PROBE = (regions: ({ x: number; y: number; width: number; height: number } | null)[]) => {
  const canvasEl = document.getElementById("canvas");
  if (!canvasEl) {
    throw new Error("measure probe: #canvas element missing");
  }
  const origin = canvasEl.getBoundingClientRect();
  return Array.from(canvasEl.children, (el, i) => {
    const saved = (el as HTMLElement).style.transform;
    const computed = getComputedStyle(el).transform;
    let matrix: DOMMatrixReadOnly;
    try {
      matrix = computed !== "none" && computed !== "" ? new DOMMatrixReadOnly(computed) : new DOMMatrixReadOnly();
    } catch (err) {
      throw new Error(`measure probe: unparseable computed transform "${computed}": ${err}`);
    }
    // Untransformed content box: transform removal never reflows other
    // Layers (they are absolutely positioned), so one element's measurement
    // cannot disturb another's.
    (el as HTMLElement).style.transform = "none";
    const plain = el.getBoundingClientRect();
    const content = { width: plain.width, height: plain.height };
    const lx = plain.left - origin.left;
    const ly = plain.top - origin.top;
    (el as HTMLElement).style.transform = saved;
    // The markup always sets transform-origin: 0 0, so the transform maps
    // local coordinates about the element's own top-left layout corner.
    const corner = (u: number, v: number) => {
      const p = matrix.transformPoint(new DOMPoint(u, v));
      // The projective divide (#298): transformPoint applies the full 4x4
      // without dividing by w — a perspective transform reports the
      // pre-divide point — so the projected corner divides by w here. For a
      // 2D matrix w is 1 and the divide is a no-op.
      const w = p.w === 0 ? 1 : p.w;
      return { x: lx + p.x / w, y: ly + p.y / w };
    };
    const corners = [
      corner(0, 0),
      corner(content.width, 0),
      corner(content.width, content.height),
      corner(0, content.height),
    ];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    // The region box (#211, ADR-0023): the region rectangle's local corners
    // mapped through the same matrix as the content corners — one shared
    // geometry authority, never a second transform model.
    const region = regions[i] ?? null;
    let regionBox: Box | null = null;
    if (region) {
      const rCorners = [
        corner(region.x, region.y),
        corner(region.x + region.width, region.y),
        corner(region.x + region.width, region.y + region.height),
        corner(region.x, region.y + region.height),
      ];
      const rxs = rCorners.map((c) => c.x);
      const rys = rCorners.map((c) => c.y);
      const rMinX = Math.min(...rxs);
      const rMinY = Math.min(...rys);
      regionBox = {
        x: rMinX,
        y: rMinY,
        width: Math.max(...rxs) - rMinX,
        height: Math.max(...rys) - rMinY,
      };
    }
    return {
      content,
      corners,
      regionBox,
      box: {
        x: minX,
        y: minY,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
      },
    };
  });
};

/** Report precision: CSS matrix arithmetic produces sub-0.01px noise; two decimals keep reports stable without hiding real geometry. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Safety pad (px) added around each Layer box when sizing its ink-capture
 * window: glyph ink may overhang its line box by a pixel or two (italic
 * faces), so the captured region must not end exactly at the box.
 */
const INK_PAD_PX = 16;

/**
 * Per-axis cap (px) for the per-Layer ink-capture window (review
 * INT-1/PROD-1): a layout box needing more is refused loudly instead of
 * growing a viewport without bound. One home for the number: the window
 * screenshot is decoded by `decodePng`, so the cap IS the PNG reader's
 * per-axis parse limit (`MAX_DIMENSION`) — a window the refusal check
 * accepts can always be decoded (#185). The decoder's total-pixel budget
 * (`MAX_PIXELS`) is enforced in the same refusal check below.
 */
const MAX_INK_VIEWPORT_PX = MAX_DIMENSION;

/** Standalone measurement canvas edge (px): large enough that a legacy
 * text revision's pre-wrap shrink-to-fit line cannot wrap inside it (the
 * containing block width caps the line), while staying inside the bounded
 * ink-capture window with its pad. Natural-layout revisions are never
 * constrained by the canvas width (ADR-0017 amendment): without a stored
 * wrap width they never wrap; with one (#294) they wrap intrinsically at
 * that width, never at the canvas. Used by `measureStandaloneLayer` (#138)
 * and the anchored-placement resolver's standalone context, which measures
 * through the same canvas. */
export const STANDALONE_CANVAS_PX = MAX_INK_VIEWPORT_PX - 2 * INK_PAD_PX;

type Box = { x: number; y: number; width: number; height: number };

/**
 * The px a Layer's effects may extend its ink beyond the layout box, in
 * every canvas direction (#139/#140, ADR-0018/0019). The effects paint in
 * the Layer's LOCAL space — before the canonical transform — so the LOCAL
 * reach maps through the transform: the canvas-space reach is the local
 * reach × the transform's worst-case magnification, derived from the
 * revision facts and the measured content extent alone (deterministic,
 * never rendering-consulted).
 *
 * The combined local reach is ADDITIVE (DEC-006/ADR-0019 ordering): the
 * outline dilates the content by `width` px in every direction, the
 * shadow is cast from the outlined composite, extending a further |dx| +
 * |dy| + 2·blur (the margin over the CSS blur radius's ~1.5× visible
 * extent), and the blur (#299, ADR-0024 amendment) blurs the whole
 * composite, extending a further ceil(3 × blur) px — its own kernel reach
 * (see the term below) — so a blurred Layer's total local reach is the SUM
 * of the three, never the max of any two.
 */
function effectReachPx(
  revision: ResolvedLayerRevision,
  content: { width: number; height: number },
): number {
  const outline = revision.outline?.width ?? 0;
  const shadow = revision.shadow
    ? Math.abs(revision.shadow.dx) + Math.abs(revision.shadow.dy) + 2 * revision.shadow.blur
    : 0;
  // The blur (#299, ADR-0024 amendment): the last function of the effects
  // chain blurs the composite with CSS blur(r) — r IS the Gaussian standard
  // deviation, and Chrome's kernel reaches ~3σ — so the visible tail
  // extends ceil(3 × blur) px beyond the ink in every local direction. The
  // exact ceiled kernel reach, additive after outline+shadow (the chain is
  // additive, DEC-006/ADR-0019 ordering) and mapped through the transform
  // like the rest of the local reach. The ONE home for effect reach:
  // #300's choke (negative) and feather (additive) extend this term list.
  const blur = normalizeStoredBlur(revision) ?? 0;
  const blurReach = blur > 0 ? Math.ceil(3 * blur) : 0;
  const localReach = outline + shadow + blurReach;
  if (localReach === 0) return 0;
  return localReach * transformedStretch(revision, content, localReach);
}

type Mat2 = [number, number, number, number]; // row-major [a, b; c, d], column vectors

/** The transform facts the depth/stretch helpers read — the stored OR
 *  resolved revision shape, since the publication boundary (PROD-1) gates
 *  the stored-shape document before it is ever resolved. */
interface TransformFactsSource {
  scaleX?: unknown;
  scaleY?: unknown;
  rotationDeg?: unknown;
  flipX?: unknown;
  flipY?: unknown;
  skewXDeg?: unknown;
  skewYDeg?: unknown;
  perspectiveTiltXDeg?: unknown;
  perspectiveTiltYDeg?: unknown;
  outline?: LayerOutline | undefined;
  shadow?: LayerShadow | undefined;
}

/** Compose two linear maps: (m·n)·p applies n first. */
function mul2(m: Mat2, n: Mat2): Mat2 {
  return [
    m[0]! * n[0]! + m[1]! * n[2]!, m[0]! * n[1]! + m[1]! * n[3]!,
    m[2]! * n[0]! + m[3]! * n[2]!, m[2]! * n[1]! + m[3]! * n[3]!,
  ];
}

/**
 * The pre-tilt affine's linear part (row-major 2x2, column vectors), exact:
 * the content maps through scale (flip folded in — both diagonal), then
 * rotation, then the skews, before the perspective tilt (#298) — the linear
 * map the paint applies first. Both facts read through the ONE stored-field
 * readers: a fresh provisional revision (the one-command add path) may
 * carry absent fields, which normalize to identity here.
 */
function preTiltLinear(revision: TransformFactsSource): Mat2 {
  const scale = normalizeStoredScale(revision);
  const flip = normalizeStoredFlip(revision);
  const rotation = normalizeStoredRotation(revision);
  const skew = normalizeStoredSkew(revision);
  const sx = flip.flipX ? -scale.scaleX : scale.scaleX;
  const sy = flip.flipY ? -scale.scaleY : scale.scaleY;
  const r = (rotation * Math.PI) / 180;
  const rc = Math.cos(r), rs = Math.sin(r);
  const tx = Math.tan((skew.skewXDeg * Math.PI) / 180);
  const ty = Math.tan((skew.skewYDeg * Math.PI) / 180);
  let m: Mat2 = [sx, 0, 0, sy];
  m = mul2([rc, -rs, rs, rc], m); // rotation
  m = mul2([1, 0, ty, 1], m);     // skewY (applied before skewX, per the emitted order)
  m = mul2([1, tx, 0, 1], m);     // skewX
  return m;
}

/**
 * The pre-tilt affine's worst-case stretch: the largest singular value of
 * the linear part, exact (closed form for the 2x2 MᵀM eigenvalue). This is
 * the canvas-space magnification of a local length — a reach ball of
 * radius r maps to an ellipse with semi-axes up to this factor.
 */
function affineMagnification(m: Mat2): number {
  const s11 = m[0]! * m[0]! + m[2]! * m[2]!;
  const s12 = m[0]! * m[1]! + m[2]! * m[3]!;
  const s22 = m[1]! * m[1]! + m[3]! * m[3]!;
  const lambda = (s11 + s22 + Math.sqrt((s11 - s22) ** 2 + 4 * s12 * s12)) / 2;
  return Math.sqrt(Math.max(lambda, 0));
}

/**
 * The ONE perspective-depth reader (INT-3, #298): the greatest depth the
 * Layer's content — plus `extraLocalReach` px of local effect extent
 * around it — can reach toward the viewer under the perspective tilt.
 *
 * The tilt applies to points ALREADY mapped by the pre-tilt affine (flip,
 * scale, rotation, skew), so the depth is derived from the post-affine
 * extents, never the raw layout box: with L the affine linear part, c the
 * fixed layout-space content centre the tilt pivots about, and the emitted
 * order applying rotateY then rotateX, the depth of a content point is
 * exactly the linear functional `z(p) = −sin(tiltY)·cos(tiltX)·qx +
 * sin(tiltX)·qy` on q = L·p − c. A linear functional over a box maximizes
 * at a corner, and the extra local reach adds `‖Lᵀk‖·r` (k the
 * functional's gradient) — so the bound is exact, never estimated.
 *
 * Used by BOTH the canvas-space effect-reach sizing and the divergent-
 * projection refusal (and, through the exported refusal, the add/edit
 * publication boundary) — one reader, never a second copy of the formula.
 */
function perspectiveDepth(
  revision: TransformFactsSource,
  content: { width: number; height: number },
  extraLocalReach = 0,
): number {
  const perspective = normalizeStoredPerspective(revision);
  if (perspective.perspectiveTiltXDeg === 0 && perspective.perspectiveTiltYDeg === 0) {
    // No perspective function is emitted at identity tilt: there is no
    // divide and no depth.
    return 0;
  }
  const L = preTiltLinear(revision);
  const cx = content.width / 2, cy = content.height / 2;
  const kx = -Math.sin((perspective.perspectiveTiltYDeg * Math.PI) / 180) *
    Math.cos((perspective.perspectiveTiltXDeg * Math.PI) / 180);
  const ky = Math.sin((perspective.perspectiveTiltXDeg * Math.PI) / 180);
  let maxDepth = 0;
  for (const [u, v] of [[0, 0], [content.width, 0], [content.width, content.height], [0, content.height]] as const) {
    const qx = L[0]! * u + L[1]! * v - cx;
    const qy = L[2]! * u + L[3]! * v - cy;
    maxDepth = Math.max(maxDepth, Math.abs(kx * qx + ky * qy));
  }
  // The reach extends the local extent around every content point; its
  // depth contribution is the functional's operator norm over the affine
  // map, exact for the linear functional.
  const reachDepth =
    extraLocalReach *
    Math.hypot(kx * L[0]! + ky * L[2]!, kx * L[1]! + ky * L[3]!);
  return maxDepth + reachDepth;
}

/**
 * The stretch a Layer's transform applies to the canvas-space effect reach
 * (#298): the pre-tilt affine's exact worst-case stretch (the largest
 * singular value of the flip/scale/rotation/skew linear part — for
 * scale-only Layers this is exactly max(scaleX, scaleY)) times the
 * perspective divide's near-side magnification `d / (d − depth)`, with the
 * depth derived from the post-affine extents (perspectiveDepth) so a
 * scaled-then-tilted Layer's magnification is never underestimated. When
 * the depth reaches the fixed perspective distance the projection diverges
 * and the factor is infinite — `transformBlowupRefusal` refuses the Layer
 * loudly before any capture, so callers never see the divide taken.
 */
function transformedStretch(
  revision: TransformFactsSource,
  content: { width: number; height: number },
  extraLocalReach = 0,
): number {
  const depth = perspectiveDepth(revision, content, extraLocalReach);
  if (depth >= PERSPECTIVE_DISTANCE_PX) {
    return Infinity;
  }
  return affineMagnification(preTiltLinear(revision)) *
    (PERSPECTIVE_DISTANCE_PX / (PERSPECTIVE_DISTANCE_PX - depth));
}

/**
 * The actionable refusal when a Layer's perspective tilt projects its
 * content — plus its own effect extent — deeper than the fixed 1000px
 * perspective distance: the divide would blow up (infinite or negative
 * magnification). Returns null when the projection stays bounded. This is
 * the ONE refusal computation, shared by the measure seam and — through
 * `refuseDivergentPerspectiveProjection` — the add/edit publication
 * boundary (PROD-1), so a Layer that measure would refuse can never be
 * stored.
 */
export function transformBlowupRefusal(
  revision: TransformFactsSource,
  content: { width: number; height: number },
  name: string,
): string | null {
  const perspective = normalizeStoredPerspective(revision);
  if (perspective.perspectiveTiltXDeg === 0 && perspective.perspectiveTiltYDeg === 0) {
    return null;
  }
  const localReach =
    (revision.outline?.width ?? 0) +
    (revision.shadow
      ? Math.abs(revision.shadow.dx) + Math.abs(revision.shadow.dy) + 2 * revision.shadow.blur
      : 0);
  const depth = perspectiveDepth(revision, content, localReach);
  if (depth < PERSPECTIVE_DISTANCE_PX) return null;
  return (
    `Layer "${name}" is ${Math.ceil(content.width)}×${Math.ceil(content.height)}px` +
    (localReach > 0 ? ` plus up to ${localReach}px of effect extent` : "") +
    `; its perspective tilt (${perspective.perspectiveTiltXDeg}° about X, ${perspective.perspectiveTiltYDeg}° about Y) ` +
    `projects that extent deeper than the fixed ${PERSPECTIVE_DISTANCE_PX}px perspective distance, so the ` +
    `projection diverges. Reduce the tilt (--perspective) or the Layer's effective size.`
  );
}

/** Round every component of an optional box for reporting. */
/**
 * Build a multi-run text Layer's per-run report (#297, ADR-0021 amendment):
 * each run's 1-based index, text slice (boundaries re-derived from the ONE
 * reader — `text` is the only home of the characters), resolved colour, and
 * font/axes facts. A run's font report follows the layer-level rule: a
 * caller font reports the family its own file declares; a bundled face has
 * no stored family — the retained bytes are its identity — and reports null.
 */
function buildRunReports(
  rev: Extract<ResolvedLayerRevision, { kind: "text" }>,
  runs: LayerTextRun[],
): Array<{
  index: number;
  text: string;
  color: LayerFill;
  font: { family: string; caller: true } | null;
  axes: { weight: number; width: number } | null;
}> {
  const slices = storedTextRunSlices(rev);
  return runs.map((run, i) => {
    // A run's axes are its stored overrides — a run without one paints the
    // layer axes, so it reports null (absence IS the layer-default form).
    // The width is the reader's canonical pair fact, present with weight.
    const axes =
      run.weight !== undefined && run.width !== undefined
        ? { weight: run.weight, width: run.width }
        : null;
    const font =
      run.contentHash !== undefined && run.callerFont !== undefined
        ? { family: run.callerFont.family, caller: true as const }
        : null;
    return {
      index: i + 1,
      text: slices[i]!,
      color: normalizeStoredTextFill(run.color ?? rev.color),
      font,
      axes,
    };
  });
}

function roundBox(box: Box | null): Box | null {
  return box ? { x: round2(box.x), y: round2(box.y), width: round2(box.width), height: round2(box.height) } : null;
}

/**
 * The rounded layout/ink projection of one measured Layer, shared by the
 * standalone (#138) and provisional (#229) measurement lines so their
 * rounding can never drift apart (review INT-apply-1 — anchored ink must
 * measure identically whether it resolves an existing or a would-be
 * Layer): the rounded painted box (or null), the rounded layout box, and
 * the rounded measured content extent. A caller that has the revision's
 * own canonical content facts (an image's intrinsic size) overrides the
 * measured extent with them; text has none, so it keeps the measured one.
 * `measured` undefined means the single-Layer measurement produced no
 * geometry — refused loudly with the caller's named error.
 */
function projectMeasuredGeometry(
  measured: { content: { width: number; height: number }; box: Box; painted: Box | null; refused?: string | null; fit?: TextFitProbe | null } | undefined,
  missingError: string,
): { painted: Box | null; box: Box; content: { width: number; height: number }; refused: string | null; fit: TextFitProbe | null } {
  if (!measured) {
    throw new Error(missingError);
  }
  const isRefused = measured.refused !== undefined && measured.refused !== null;
  return {
    painted: isRefused ? null : (measured.painted ? roundBox(measured.painted) : null),
    box: {
      x: round2(measured.box.x),
      y: round2(measured.box.y),
      width: round2(measured.box.width),
      height: round2(measured.box.height),
    },
    content: { width: round2(measured.content.width), height: round2(measured.content.height) },
    refused: measured.refused ?? null,
    fit: measured.fit ?? null,
  };
}

/** Intersection of a box with the canvas rectangle; null when empty. */
function clipToCanvas(box: Box, canvas: { width: number; height: number }): Box | null {
  const x1 = Math.max(box.x, 0);
  const y1 = Math.max(box.y, 0);
  const x2 = Math.min(box.x + box.width, canvas.width);
  const y2 = Math.min(box.y + box.height, canvas.height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null;
}

/** Bounding box of every alpha > 0 pixel, mapped from page coordinates into Composition coordinates. */
function inkBounds(png: { width: number; height: number; rgba: Uint8Array }, offsetX: number, offsetY: number): Box | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (png.rgba[(y * png.width + x) * 4 + 3]! > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return minX === Infinity ? null : { x: minX - offsetX, y: minY - offsetY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Measure the snapshot's exact bytes through the render page using the
 * paint path's markup and rejection contract. Mirrors `paintComposition`'s
 * page flow: viewport = canvas, same content, awaited image decode (a
 * corrupt image fails loudly instead of measuring a broken layout), the
 * same retained-font resolution gate, then the geometry probe.
 */
async function measureSnapshot(
  canvas: { width: number; height: number },
  layers: SnapshotLayer[],
  options: { page?: Page; captureUseName?: string; layoutOnly?: boolean } = {},
): Promise<{ content: { width: number; height: number }; corners: { x: number; y: number }[]; box: Box; painted: Box | null; refused: string | null; fit: TextFitProbe | null }[]> {
  const run = async (page: Page) => {
    await page.setViewportSize({ width: canvas.width, height: canvas.height });
    await page.setContent(buildCompositionHtml(canvas, layers), { waitUntil: "load" });
    // Awaited decode: a partially painted or broken image is never measured.
    await page.evaluate(() => Promise.all(Array.from(document.images, (img) => img.decode())));
    // Per-Layer outline-filter region sizing (#140, ADR-0019): the paint
    // path's exact adjustment, so painted extents agree with the render.
    await sizeEffectFilterRegions(page, layers);
    // The same retained-font gate as painting: an unresolved face is a
    // loud failure, never a fallback measurement.
    await rejectUnresolvedFonts(page, layers);
    // Text fit-to-box derivation (#295): the paint path's exact pass, after
    // the same font gate — the ONE derivation point shared with painting, so
    // measured and rendered text agree on the effective font size and the
    // fitted box. Runs BEFORE the geometry probe, so every reported box is
    // the fitted one.
    const fitProbes = await applyTextFit(page, layers);
    const measured = await page.evaluate(
      MEASURE_PROBE,
      layers.map((l) => (l.revision.visibleRegion !== undefined ? { ...l.revision.visibleRegion } : null)),
    );

    // Painted-ink pass (#137): the same page that just measured layout —
    // the paint path's exact markup, the same decode and font gates — is
    // screenshotted once per Layer with the others hidden (they are
    // absolutely positioned, so hiding changes no geometry, and the page
    // is throwaway). The canvas overflow is released, so ink beyond the
    // canvas can be captured and the canvas intersection reported against
    // the PAINTED extents, never the layout box.
    //
    // Bounded capture (review INT-1/PROD-1, #185, #206): each Layer gets its
    // OWN capture window, sized from that Layer's box plus its own effect reach
    // plus the pad — never the combination of other Layers' extremes — and
    // the canvas is SHIFTED so the box sits inside it. A placement far
    // off-canvas costs a window shift, not viewport growth; a Layer whose
    // own window exceeds the decoder's bounds (per-axis or total pixels,
    // read from the PNG reader) is refused per-Layer, because a read-only
    // query must fail safely, never grow memory without bound or abort
    // measurement of unrelated Layers. Cost ceiling: O(Layers × capture-window area)
    // — one screenshot plus one pixel scan per Layer.
    //
    // Effect reach (#139/#140, ADR-0018/0019): a Layer's effects extend
    // its ink beyond the layout box by up to the COMBINED local reach
    // (outline width + |dx| + |dy| + 2·blur px — additive, the shadow is
    // cast from the outlined composite) MAPPED THROUGH the canonical
    // transform — the effects paint before the transform, so the
    // canvas-space reach is the local reach × the transform's worst-case
    // magnification (the scale's largest factor, widened by the skew's
    // transvection bound and the perspective tilt's near-side
    // magnification, #298). The reach is derived from the revision facts —
    // deterministic, no rendering consulted — and widened into the window
    // sizing and the loud-refusal cap, so an effected Layer's full painted
    // extent is captured or refused, never clipped into a smaller report.
    const painted: (Box | null)[] = new Array(measured.length).fill(null);
    const refused: (string | null)[] = new Array(measured.length).fill(null);
    if (measured.length > 0) {
      // Per-Layer capture window (#185): sized from THAT Layer's own box,
      // its own effect reach, and the pad — never the union of other
      // Layers' extremes, so a Layer's measured numbers stay the same
      // whatever other Layers are in the Composition, and two Layers that
      // each fit alone can no longer combine into a window that does not.
      const reaches = layers.map((l, i) => effectReachPx(l.revision, measured[i]!.content));
      // Perspective blowup (#298): a tilt whose content depth reaches the
      // fixed perspective distance is refused per-Layer, before the window
      // math can divide by a non-positive magnification.
      for (let i = 0; i < measured.length; i++) {
        if (options.captureUseName !== undefined && layers[i]!.name !== options.captureUseName) {
          continue;
        }
        const blowup = transformBlowupRefusal(layers[i]!.revision, measured[i]!.content, layers[i]!.name);
        if (blowup !== null) {
          refused[i] = blowup;
        }
      }
      // The capture window judges the VISIBLE ink (#211, ADR-0023, DEC-006):
      // a Layer with a region is windowed around its region box (the
      // transformed region rectangle), never its full layout box — so a
      // large padded source refused uncropped measures once cropped to its
      // subject. The region clips ink, never extends it, so the effect
      // reach widens the window around the region box exactly as it does
      // around the layout box when no region is set.
      const windowBoxes = measured.map((m) => m.regionBox ?? m.box);
      const windowFor = (i: number) => ({
        w: Math.max(1, Math.ceil(windowBoxes[i]!.width + 2 * reaches[i]! + 2 * INK_PAD_PX)),
        h: Math.max(1, Math.ceil(windowBoxes[i]!.height + 2 * reaches[i]! + 2 * INK_PAD_PX)),
      });
      // Per-Layer refusal (#206): the same bounds the decoder enforces on the
      // window screenshot — MAX_PIXELS total in addition to the per-axis cap.
      // A Layer whose OWN window is over either bound is recorded with its
      // actionable refusal message naming the Layer, its box and effect
      // extent, and the fix; the call does not throw. When options.captureUseName
      // is given, only that use is checked and captured.
      for (let i = 0; i < measured.length; i++) {
        if (options.captureUseName !== undefined && layers[i]!.name !== options.captureUseName) {
          continue;
        }
        const { w, h } = windowFor(i);
        if (w > MAX_INK_VIEWPORT_PX || h > MAX_INK_VIEWPORT_PX || w * h > MAX_PIXELS) {
          const reach = reaches[i]!;
          const wb = windowBoxes[i]!;
          const boxKind = layers[i]!.revision.visibleRegion !== undefined ? "visible (region-clipped) box" : "layout box";
          refused[i] =
            `Layer "${layers[i]!.name}" has a ${boxKind} ${Math.ceil(wb.width)}×${Math.ceil(wb.height)}px` +
            (reach > 0 ? ` plus up to ${reach}px of effect extent` : "") +
            `, beyond the painted-extent capture window (max ${MAX_INK_VIEWPORT_PX}px per axis, ` +
            `${MAX_PIXELS.toLocaleString("en-US")}px total). Painted extents are refused ` +
            `instead of growing measurement memory without bound — reduce the transform scale or the effect extent.`;
        }
      }
      for (let i = 0; i < measured.length; i++) {
        if (options.captureUseName !== undefined && layers[i]!.name !== options.captureUseName) {
          continue;
        }
        if (refused[i] !== null) {
          continue;
        }
        const b = windowBoxes[i]!;
        // Per-Layer capture window and shift: position the canvas (and its
        // absolutely positioned children, so this Layer's box) inside ITS
        // OWN fixed capture window, centered with the pad on every side
        // (rounded to whole pixels — a fractional shift would re-render the
        // Layer at a subpixel offset and bleed its raster). Feasible
        // because the per-Layer cap check above bounds every window.
        const { w: captureW, h: captureH } = windowFor(i);
        await page.setViewportSize({ width: captureW, height: captureH });
        const left = Math.round(captureW / 2 - (b.x + b.width / 2));
        const top = Math.round(captureH / 2 - (b.y + b.height / 2));
        await page.evaluate(
          ({ left, top }) => {
            const canvasEl = document.getElementById("canvas") as HTMLElement;
            canvasEl.style.overflow = "visible";
            canvasEl.style.left = `${left}px`;
            canvasEl.style.top = `${top}px`;
          },
          { left, top },
        );
        await page.evaluate((idx) => {
          const kids = Array.from((document.getElementById("canvas") as HTMLElement).children) as HTMLElement[];
          kids.forEach((el, j) => {
            el.style.visibility = j === idx ? "" : "hidden";
          });
        }, i);
        const shot = await page.screenshot({ type: "png", omitBackground: true });
        painted[i] = inkBounds(decodePng(Buffer.from(shot)), left, top);
      }
    }

    // The painted-ink pass is skippable (#295): the fit-refusal probe needs
    // only the layout derivation, never the per-Layer ink screenshots.
    if (options.layoutOnly === true) {
      return measured.map((m, i) => ({ ...m, painted: null, refused: null, fit: fitProbes[i] ?? null }));
    }
    return measured.map((m, i) => ({ ...m, painted: painted[i] ?? null, refused: refused[i] ?? null, fit: fitProbes[i] ?? null }));
  };
  return options.page ? run(options.page) : withRenderPage(run);
}

/**
 * Measure Layer layout bounds in Composition coordinates, read-only. See
 * the module contract for the reported boxes and their meaning. When
 * `useName` is given, only that use is reported — the full Composition is
 * still what gets measured, so a Layer's numbers are identical whether it
 * is reported alone or with its neighbors.
 */
export async function measureCompositionLayers(
  projectPath: string,
  compName: string,
  useName?: string,
  options: { page?: Page } = {},
): Promise<MeasureCompositionResult> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  // The snapshot is resolved under the Project lock exactly once, then the
  // lock is released before the browser measurement — the documented
  // read-snapshot pattern (`renderComposition`): measuring reads only the
  // in-memory snapshot and writes nothing, so no Project state is held
  // during the browser pass.
  const { comp, layers } = await withProjectLock(resolvedRoot, async () => {
    const comp = await readCompositionInternalFull(resolvedRoot, compName);
    const layers: SnapshotLayer[] = comp.layers.map((use) => ({
      name: use.name,
      layerId: use.layerId,
      revision: use.revision,
      contentBytes: use.contentBytes,
      ...(use.runFonts !== undefined && use.runFonts.length > 0 ? { runFonts: use.runFonts } : {}),
    }));
    return { comp, layers };
  });

  const measured = await measureSnapshot(comp.canvas, layers, {
    ...options,
    captureUseName: useName,
  });

  const bounds: MeasuredLayerBounds[] = layers.map((l, i) => {
      const m = measured[i]!;
      const rev = l.revision;
      const isRefused = m.refused !== null;
      // One home for the reported painted box: clipping and the canvas
      // intersection are derived from the same rounded values the report
      // carries, so a consumer recomputing them from the JSON can never
      // disagree with the reported `clipped`.
      const painted = isRefused ? null : (m.painted ? roundBox(m.painted) : null);
      const paintedOnCanvas = painted ? roundBox(clipToCanvas(painted, comp.canvas)) : null;
      const clipped =
        painted !== null &&
        (painted.x < 0 ||
          painted.y < 0 ||
          painted.x + painted.width > comp.canvas.width ||
          painted.y + painted.height > comp.canvas.height);
      return {
        name: l.name,
        layerId: l.layerId,
        kind: rev.kind,
        // Image content size is the canonical verified revision fact; shape
        // content size (#208) is the same kind of fact — the geometry's
        // stored parameters; text has no stored size — its measured line-box
        // layout extent is the only source, from the same face bytes
        // painting uses.
        content:
          rev.kind === "text"
            ? { width: round2(m.content.width), height: round2(m.content.height) }
            : { width: rev.width, height: rev.height },
        box: {
          x: round2(m.box.x),
          y: round2(m.box.y),
          width: round2(m.box.width),
          height: round2(m.box.height),
        },
        painted,
        paintedOnCanvas,
        clipped,
        refused: m.refused,
        corners: m.corners.map((c) => ({ x: round2(c.x), y: round2(c.y) })),
        placement: { x: rev.x, y: rev.y, opacity: rev.opacity },
        transform: {
          scaleX: rev.scaleX,
          scaleY: rev.scaleY,
          rotationDeg: rev.rotationDeg,
          flipX: rev.flipX,
          flipY: rev.flipY,
          skewXDeg: rev.skewXDeg,
          skewYDeg: rev.skewYDeg,
          perspectiveTiltXDeg: rev.perspectiveTiltXDeg,
          perspectiveTiltYDeg: rev.perspectiveTiltYDeg,
        },
        effects: { shadow: rev.shadow ?? null, outline: rev.outline ?? null },
        grade: rev.grade ?? null,
        glow: rev.glow ?? null,
        blur: normalizeStoredBlur(rev) ?? null,
        blend: rev.blend ?? null,
        visibleRegion: rev.visibleRegion ?? null,
        // The vector colour (#215): the stored canonical hex (or null —
        // absence IS the no-colour form), reported like the effects and
        // the fill for auditability.
        vectorColor: rev.kind === "image" ? rev.vectorColor ?? null : null,
        // The revision's ONE fill (DEC-003), reported for shape Layers
        // (#208/#210) and text Layers (#222): the canonical fill object —
        // solid, linear, or radial — the same facts painting applies, reported
        // for auditability. Image Layers have no fill and report null.
        fill: rev.kind === "shape" ? rev.fill : rev.kind === "text" ? normalizeStoredTextFill(rev.color) : null,
        axes:
          rev.kind === "text" ? normalizeStoredTextAxes(rev) ?? null : null,
        font:
          rev.kind === "text" && rev.callerFont !== undefined
            ? { family: rev.callerFont.family, caller: true }
            : null,
        typography:
          rev.kind === "text"
            ? normalizeStoredTextTypography(rev)
            : ({} as LayerTextTypography),
        // The stored wrap width (#294), reported like the typography for
        // auditability — the same fact paint lays the wrapped box out at.
        wrapWidth:
          rev.kind === "text" ? normalizeStoredTextWrapWidth(rev) ?? null : null,
        // The stored fit box (#295) and the EFFECTIVE font size the ONE
        // derivation derived for this very measurement — measure reports the
        // size painting applies.
        fit:
          rev.kind === "text" ? normalizeStoredTextFitBox(rev) ?? null : null,
        effectiveFontSize:
          rev.kind === "text"
            ? m.fit?.effectiveFontSize ?? rev.fontSize
            : null,
        // The per-run facts (#297): boundaries re-derived from the ONE
        // reader, overrides resolved per run — the same facts painting
        // applies, reported for auditability.
        ...(rev.kind === "text" && normalizeStoredTextRuns(rev) !== undefined
          ? {
              runs: buildRunReports(rev, normalizeStoredTextRuns(rev)!),
            }
          : {}),
      };
    });

  const selected = useName
    ? bounds.filter((b) => b.name === useName)
    : bounds;
  if (useName && selected.length === 0) {
    const names = bounds.map((b) => `"${b.name}"`).join(", ");
    throw new Error(
      `Use "${useName}" not found in composition "${comp.name}".` +
        (bounds.length > 0 ? ` Available uses: ${names}.` : " The Composition has no Layers."),
    );
  }

  return { composition: comp.name, canvas: comp.canvas, layers: selected };
}

/**
 * Measure one Layer standalone — outside any Composition, at placement
 * (0, 0) on a canvas too wide to constrain the line (#138). The
 * read-snapshot pattern is unchanged: the Layer's current revision and
 * verified bytes are resolved once under the Project lock, then measured
 * from that snapshot; nothing is written. The painted box of the (0, 0)
 * copy IS the ink's offset from the placement point, which is what
 * anchored placement (#138) needs for a Layer with no referring
 * Composition.
 *
 * Documented semantics: the standalone line is never constrained by the
 * measurement canvas, so a text Layer without a stored wrap width resolves
 * against its unwrapped ink; a text Layer WITH a stored wrap width (#294,
 * ADR-0017 amendment) wraps intrinsically at that width — the width is an
 * element fact, not a canvas fact — so the standalone measure reports the
 * wrapped box. Either way, once the Layer is added to a Composition,
 * anchoring there re-resolves in that Composition's context. A Layer whose
 * layout box exceeds the bounded capture window reports `refused` with the
 * actionable refusal message and `painted: null`, exactly as in
 * Composition measurement (#206).
 */
export async function measureStandaloneLayer(
  projectPath: string,
  layerId: string,
  options: { page?: Page } = {},
): Promise<{ painted: Box | null; box: Box; content: { width: number; height: number }; refused: string | null }> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  const { currentRevision, contentBytes } = await withProjectLock(resolvedRoot, () =>
    readLayerInternalFull(resolvedRoot, layerId),
  );
  return measureStandaloneSnapshot(currentRevision, contentBytes, options);
}

/**
 * Measure one Layer standalone from an ALREADY-RESOLVED snapshot — no
 * Project state is consulted and no lock is taken (#211): the caller owns
 * resolution (the standalone command line resolves under the Project lock;
 * the Layer edit path resolves its snapshot under the lock it already
 * holds, so a lock-taking measurement there would deadlock the file lock).
 * The measured content box IS the text Layer's line-box extent — the
 * unwrapped one-line box when no wrap width is stored, the wrapped box at
 * the stored width when one is (#294, ADR-0017 amendment) — the fact the
 * visible region validates against when it is set on a text Layer.
 */
export async function measureStandaloneSnapshot(
  currentRevision: ResolvedLayerRevision,
  contentBytes: Buffer,
  options: { page?: Page; runFonts?: SnapshotRunFont[] } = {},
): Promise<{ painted: Box | null; box: Box; content: { width: number; height: number }; refused: string | null; fit: TextFitProbe | null }> {
  const standalone: SnapshotLayer = {
    name: currentRevision.layerId,
    layerId: currentRevision.layerId,
    revision: { ...currentRevision, x: 0, y: 0 },
    contentBytes,
    ...(options.runFonts !== undefined && options.runFonts.length > 0 ? { runFonts: options.runFonts } : {}),
  };
  const canvas = { width: STANDALONE_CANVAS_PX, height: STANDALONE_CANVAS_PX };
  const [measured] = await measureSnapshot(canvas, [standalone], options);
  // The shared rounding projection keeps the standalone line rounding-
  // identical to the provisional line (review INT-apply-1); the image
  // content extent is overridden with the canonical verified revision
  // facts, exactly as before.
  const projected = projectMeasuredGeometry(
    measured,
    `Standalone measurement of Layer "${currentRevision.layerId}" produced no geometry.`,
  );
  return {
    ...projected,
    fit: projected.fit,
    content: {
      width:
        currentRevision.kind === "text"
          ? projected.content.width
          : currentRevision.width,
      height:
        currentRevision.kind === "text"
          ? projected.content.height
          : currentRevision.height,
    },
  };
}

/**
 * Derive ONE text Layer's fit result standalone — the fit-refusal probe
 * (#295, spec #285 US-016, DEC-010): the add and edit paths call this with
 * the would-be revision and its (possibly not-yet-retained) font bytes
 * before anything is published. The read-snapshot pattern applies: no
 * Project state is consulted, no lock is taken, and nothing is written —
 * the caller owns resolution (and holds the Project lock). The derivation
 * is the paint path's exact in-page pass over the paint path's exact
 * markup, so the derived size is the size every later read re-derives.
 * Layout-only: the geometry derivation needs no painted-ink screenshots.
 * Returns null when the revision is not text or carries no fit box.
 */
export async function measureTextFit(
  currentRevision: ResolvedLayerRevision,
  contentBytes: Buffer,
  options: { page?: Page; runFonts?: SnapshotRunFont[] } = {},
): Promise<TextFitProbe | null> {
  if (currentRevision.kind !== "text") return null;
  if (normalizeStoredTextFitBox(currentRevision) === undefined) return null;
  const standalone: SnapshotLayer = {
    name: currentRevision.layerId,
    layerId: currentRevision.layerId,
    revision: { ...currentRevision, x: 0, y: 0 },
    contentBytes,
    ...(options.runFonts !== undefined && options.runFonts.length > 0 ? { runFonts: options.runFonts } : {}),
  };
  const canvas = { width: STANDALONE_CANVAS_PX, height: STANDALONE_CANVAS_PX };
  const [measured] = await measureSnapshot(canvas, [standalone], { ...options, layoutOnly: true });
  return measured.fit;
}

/**
 * Measure a PROVISIONAL revision — a Layer that does not exist yet
 * (one-command `composition add`, #229, DEC-002): its would-be revision
 * and verified content bytes are supplied directly, so no Project state is
 * consulted and nothing is written. The same paint-identical authority as
 * every other measurement: the paint path's exact markup for the supplied
 * revision in `canvas` (the Composition the Layer is about to join, so a
 * text Layer's wrapping is the wrapping it will obey), the same decode and
 * font gates, and the same per-Layer bounded ink-capture contract.
 *
 * One-command add's anchored placement resolves against this measurement:
 * the provisional revision carries the transforms (the documented order
 * applies transforms BEFORE the anchor resolves) and NO effects yet
 * (effects are applied after the anchor, so the resolved placement anchors
 * the content+transform ink — exactly the ink the multi-command sequence's
 * anchor edit would resolve too).
 */
export async function measureProvisionalLayer(
  canvas: { width: number; height: number },
  provisional: SnapshotLayer,
): Promise<{ painted: Box | null; box: Box; content: { width: number; height: number }; refused: string | null; fit: TextFitProbe | null }> {
  const [measured] = await measureSnapshot(canvas, [provisional]);
  // The same shared rounding projection the standalone line uses
  // (review INT-apply-1): the two lines' rounded output can never drift.
  return projectMeasuredGeometry(
    measured,
    `Provisional measurement of Layer "${provisional.layerId}" produced no geometry.`,
  );
}
