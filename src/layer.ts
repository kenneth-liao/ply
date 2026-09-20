import { isStoredTimestamp } from "./stored-schema.js";
import { parseFillSpec, parseFillColorSpec, normalizeStoredFill, fillsEqual, fillIdentityString, FILL_TYPES, FILL_COLOR_PATTERN, type LayerFill } from "./fill.js";
/**
 * Layer identity, immutable revisions, and content-addressed image/text
 * ingestion (ADR-0013, ADR-0014, DEC-001–006, #81).
 */
import { createHash } from "node:crypto";
import { open as fsOpen, readFile, readdir, lstat, mkdir, unlink, rmdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { MAX_DIMENSION, MAX_ENCODED_BYTES, MAX_PIXELS, decodePng } from "./png.js";
import { readRasterMeta, type RasterMeta } from "./raster-meta.js";
import { readSvgMeta, type SvgMeta } from "./svg-meta.js";
import { scanSvgExternalReferences } from "./svg-inertness.js";
import { escapesDirReal, outsideDir } from "./paths.js";
import { atomicCreate, atomicReplace, withProjectLock } from "./project-lock.js";
import { resolveProjectRoot } from "./project.js";
import { withRenderPage } from "./browser.js";
import { measureStandaloneSnapshot } from "./composition-measure.js";
import { parseCompositionDocument, readMutableComposition, type Composition } from "./composition.js";
import { staticFaceAcceptedAxes, faceByContentHash, callerFontFace, verifyCallerFontResolves, resolveFace, resolveTextAxes, fontAssetBytes, type CallerFontFacts, type FontFace, type TextAxes } from "./fonts.js";
import { readCallerFontFile } from "./font-file.js";
import {
  selectGenerationOutput,
  retainGenerationRecord,
  type GenerationOutputSelection,
  type RetainedProvenance as RetainedGenerationProvenance,
} from "./generation-retention.js";
import {
  selectMatteOutput,
  retainMattingRecord,
  retainMattingSourceBytes,
  findGenerationPredecessor,
} from "./matting-retention.js";

export const LAYER_SCHEMA_VERSION = 1;

/**
 * Maximum stored text content length for a text Layer revision (#81). A
 * bound, not a typographic feature: pathological inputs are rejected at the
 * ingestion boundary instead of reaching the renderer.
 */
export const MAX_TEXT_LENGTH = 2000;

export interface LayerIdentity {
  schemaVersion: number;
  id: string;
  createdAt: string;
  currentRevision: string;
}

/** Shared revision header: identity, immutability facts, and placement. */
interface LayerRevisionBase {
  schemaVersion: number;
  layerId: string;
  createdAt: string;
  x: number;
  y: number;
  opacity: number;
  /**
   * Canonical transform scale (#133, ADR-0016): the Layer's effective painted
   * size is its content size multiplied by these factors, applied about the
   * Layer's (x, y) top-left placement point. These are revision facts shared
   * as a whole (DEC-002); width/height conveniences normalize to them at the
   * command boundary and are never stored.
   *
   * Optional in the stored shape only for revisions written before #133 —
   * absent fields mean scale 1 and are normalized by the one revision reader,
   * so no downstream reader needs a fallback. Every newly written revision
   * records both fields explicitly, keeping the revision hash covering the
   * full canonical transform (a resize-only edit is a new revision).
   */
  scaleX?: number;
  scaleY?: number;
  /**
   * Canonical transform rotation (#134, ADR-0016): the Layer's rotation in
   * degrees about its (x, y) top-left placement point, applied AFTER scale
   * (the content stretches along its own axes, then the stretched result
   * rotates). Positive degrees rotate clockwise (CSS convention). This is a
   * revision fact shared as a whole (DEC-002) and stored verbatim — the
   * command sets an absolute angle, so equivalent angles are distinct
   * deliberate edits.
   *
   * Optional in the stored shape only for revisions written before #134 —
   * absent means 0 and is normalized by the one revision reader, so no
   * downstream reader needs a fallback. Every newly written revision records
   * it explicitly, and the hash appends it only when present, so revisions
   * written before #134 (with or without scale fields) keep their exact ids.
   */
  rotationDeg?: number;
  /**
   * Canonical transform reflection (#135, ADR-0016): whether the Layer's
   * content is mirrored along its own horizontal axis (`flipX`, left–right)
   * and/or vertical axis (`flipY`, top–bottom), about its `(x, y)` top-left
   * placement point. Two axes of the one reflection operation — one shared
   * representation, no separate lifecycle. The command sets an ABSOLUTE
   * reflection state that replaces any previous one.
   *
   * Optional in the stored shape only for revisions written before #135 —
   * absent means false and is normalized by the one revision reader, so no
   * downstream reader needs a fallback. Every newly written revision records
   * both fields explicitly (always together, like scale), and the hash
   * appends them only when present, so revisions written before #135 keep
   * their exact ids.
   */
  flipX?: boolean;
  flipY?: boolean;
  /**
   * Canonical Layer shadow (#139, ADR-0018): a drop shadow applied to the
   * Layer's content in its LOCAL coordinate space — before the canonical
   * transform, which maps content+shadow together — then faded by the
   * Layer's opacity. `dx`/`dy` are the shadow offset in px (negative
   * allowed), `blur` the softening radius in px (≥ 0), `color` a hex color
   * (#RGB/#RRGGBB/#RRGGBBAA — alpha softens the shadow). The fact applies
   * uniformly to image alpha and text glyphs (DEC-006: a bounded effect,
   * never a general filter framework), and is a revision fact shared as a
   * whole (DEC-002).
   *
   * Present ⟺ a shadow exists: absence IS the canonical no-shadow form, so
   * removal drops the field and every reader treats absence as none — no
   * second "no shadow" representation. The revision hash appends it only
   * when present, so revisions written before #139 keep their exact ids.
   */
  shadow?: LayerShadow;
  /**
   * Canonical Layer outline (#140, ADR-0019): a solid outline hugging the
   * Layer's content in its LOCAL coordinate space — painted BEFORE the
   * shadow, which is therefore cast from the outlined composite — then
   * mapped by the canonical transform and faded by the Layer's opacity.
   * `width` is the outline thickness in px (≥ 0), `color` a hex color
   * (#RGB/#RRGGBB/#RRGGBBAA). The fact applies uniformly to image alpha and
   * text glyphs (DEC-006: a bounded effect, never a general filter
   * framework), and is a revision fact shared as a whole (DEC-002).
   *
   * Present ⟺ an outline exists: absence IS the canonical no-outline form,
   * so removal drops the field and every reader treats absence as none — no
   * second "no outline" representation. The revision hash appends it only
   * when present, so revisions written before #140 keep their exact ids.
   */
  outline?: LayerOutline;
  /**
   * Canonical rectangular visible region (#211, spec #207 US-003, ADR-0023):
   * the part of the Layer's content that is ink, as a rectangle in the
   * Layer's OWN content pixels relative to the content box's top-left.
   * Content outside the rectangle is not ink — it never paints, never
   * counts as painted extent, and effects hug the region's edge instead of
   * the full content edge. The fact is paint-time like the effects (the
   * retained bytes and lineage are never touched) and is a revision fact
   * shared as a whole (DEC-002).
   *
   * Present ⟺ a region exists: absence IS the canonical no-region form, so
   * removal drops the field and every reader treats absence as none — no
   * second "no region" representation. The revision hash appends it only
   * when present, so revisions written before #211 keep their exact ids.
   * The region is left-anchored (defined from the content box's top-left),
   * so setting or removing it never moves the remaining pixels: the
   * placement point and transform origin stay defined against the FULL
   * content box (DEC-005), and the representation can gain an optional
   * corner radius additively (#212) without reshaping this fact.
   */
  visibleRegion?: LayerVisibleRegion;
}

/** Canonical shadow parameters (#139, ADR-0018): offset, softening, color. */
export interface LayerShadow {
  dx: number;
  dy: number;
  blur: number;
  color: string;
}

/** Canonical outline parameters (#140, ADR-0019): thickness, color. */
export interface LayerOutline {
  width: number;
  color: string;
}

/** Canonical visible-region parameters (#211, spec #207 US-003, ADR-0023):
 * the visible rectangle in the Layer's own content pixels, relative to the
 * content box's top-left. Additively extensible (#212): an optional corner
 * radius joins this object as another stored-only-when-set field without
 * reshaping the rectangle facts. */
export interface LayerVisibleRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Corner radius in px (#212): present ONLY when set and > 0 — a radius
   * of 0 is the same look as absent, so it is never stored (the
   * store-only-when-it-differs rule, like the shape's cornerRadius).
   * Validated against 0..min(width,height)/2 of the REGION rectangle — the
   * shape Layer's one corner-radius rule, through the same validator — and
   * the revision hash appends it only when present, so revisions written
   * before #212 keep their exact ids. */
  cornerRadius?: number;
}

/**
 * Discriminated Layer revision content (#81, DEC-003): `kind` selects the
 * content contract. Both kinds share the identity/revision/use lifecycle,
 * publication protocol, and storage layout — there is no second lifecycle
 * for text.
 *
 * Content identity semantics: `contentHash` pins the revision's retained
 * bytes in `content/<sha256>` — decoded raster bytes for `"image"`, the
 * exact bundled font face bytes for `"text"`. For a text revision the
 * rendered string, size, and color are immutable revision facts covered by
 * the revision hash; the face's family/weight are add-time bundled-face
 * selection facts (via `resolveFace`) and are deliberately NOT persisted —
 * the retained bytes are the only font identity, so the renderer declares
 * them under an internal family name and never needs `assets/fonts/`.
 */
export interface LayerImageRevision extends LayerRevisionBase {
  kind: "image";
  contentHash: string;
  /**
   * The vector colour (#215, spec #207 US-005, DEC-008/010): one paint-time
   * colour that replaces the content's colours over its own alpha — the
   * retained bytes are the silhouette (the mask), never rewritten. Defined
   * for vector (format "svg") image Layers: the setter refuses on raster
   * image, text, and shape Layers before publication, naming each kind's
   * own colour control. An ABSOLUTE setter: an omitted option preserves the
   * current value, and the documented value "none" removes it — absence IS
   * the canonical no-colour form (no second representation), and the
   * authored colours paint byte-identically to never-set. The revision hash
   * appends the field only when present, so revisions written before #215
   * keep their exact ids (DEC-010).
   */
  vectorColor?: string;
}

export interface LayerTextRevision extends LayerRevisionBase {
  kind: "text";
  contentHash: string;
  text: string;
  fontSize: number;
  color: string;
  /**
   * Selected text axes (#179, ADR-0021): present if and only if the retained
   * font is a variable face — the resolved weight and width the look is, so
   * a Render reproduces from the retained bytes plus these facts alone. A
   * static face's bytes already fix the look, and the revision stores
   * neither field. Validated against the face's axis ranges at ingestion;
   * the stored fields are the only thing paint and measurement read.
   */
  weight?: number;
  width?: number;
  /**
   * Selected text typography (#187, ADR-0021): each present ONLY when set —
   * an omitted control paints exactly as before (normal letter spacing, the
   * font's own line height), which has no numeric form, and a stored
   * `tracking` of 0 is the same look as absent, so it is never stored.
   * Font-independent: neither field depends on the retained font, and both
   * carry across a `--font` edit. Validated against their allowed ranges at
   * ingestion; the stored fields are the only thing paint and measurement
   * read.
   */
  tracking?: number;
  lineHeight?: number;
  /**
   * Caller font facts (#232, spec #226 US-005, DEC-006): present if and only
   * if the retained bytes came from a caller-supplied font file. Read ONCE
   * from the file's own tables at ingestion (`parseCallerFont` in
   * src/font-file.ts) — the family name the file declares, its glyph format,
   * and the axis facts weight/width controls validate against on every later
   * edit (via `callerFontFace`, the same FontFace shape bundled faces use).
   * For a caller font these facts are the ONE home of the font's axis facts:
   * the bundled-face registry is never consulted beside them. Bundled-face
   * revisions store no such field, and renders retained before #232 — which
   * have none — keep their ids and paint unchanged (the field is appended
   * to the revision hash only when present).
   */
  callerFont?: CallerFontFacts;
}

/**
 * A shape Layer revision (#208, spec #207 US-001, DEC-001/002): a filled
 * geometric region created from parameters alone — a geometry (rectangle or
 * ellipse), a width and height in canvas px, an optional corner radius
 * (rectangle only), and ONE fill (DEC-003, src/fill.ts). It shares the
 * identity/revision/use lifecycle, publication protocol, and storage layout
 * with the other kinds; only the content contract differs:
 *
 * - Its content IS its parameters. The canonical parameter form hashes to
 *   `contentHash` (`shapeContentIdentity`) — there is no retained byte blob
 *   in `content/` for a shape (DEC-001), so the revision reader verifies the
 *   parameter hash but reads no bytes, and every consumer sees the same
 *   content-identity field the other kinds pin bytes with.
 * - A `cornerRadius` is stored only when set and > 0 — a radius of 0 is the
 *   same look as absent, so it is never stored (the established
 *   store-only-when-it-differs rule, like tracking 0). It is a rectangle
 *   fact: an ellipse revision stores no radius field, and supplying one is
 *   refused at ingestion.
 * - `width`/`height` are the geometry's size in canvas px: the shape's
 *   intrinsic pixel facts. The canonical transform maps them exactly like an
 *   image's intrinsic size, so `--resize-to` resolves against them.
 */
export interface LayerShapeRevision extends LayerRevisionBase {
  kind: "shape";
  contentHash: string;
  /** The geometry: rectangle (optional corner radius) or ellipse (DEC-002). */
  shape: "rectangle" | "ellipse";
  /** The geometry's size in canvas px — the shape's intrinsic pixel facts. */
  width: number;
  height: number;
  /**
   * Corner radius in px (rectangle only): present ONLY when set and > 0.
   * Validated at ingestion against 0..min(width,height)/2 — a larger radius
   * would be silently clamped by CSS, so it is refused instead of pinned
   * with parameters its paint does not obey.
   */
  cornerRadius?: number;
  /** The ONE fill value (DEC-003): solid here; gradients join the union. */
  fill: LayerFill;
}

export type LayerRevision = LayerImageRevision | LayerTextRevision | LayerShapeRevision;

/** The shape geometries (#208, DEC-002): arbitrary shapes arrive as vector
 *  files (US-004); Ply gains no path or drawing language. */
export const SHAPE_GEOMETRIES = ["rectangle", "ellipse"] as const;
export type LayerShapeGeometry = (typeof SHAPE_GEOMETRIES)[number];

/**
 * The ONE corner-radius range rule (#208 shapes, #212 visible regions): a
 * corner radius is a finite number of px between 0 and half the rectangle's
 * SHORTER side — a larger radius would be silently clamped by the paint, so
 * it is refused instead of pinned with parameters the paint would not obey.
 * One rule, one wording: the shape Layer's ingestion validator and the
 * visible region's radius gate both call this, so the two surfaces can never
 * disagree (US-003/#212: refuse, never clamp).
 */
export function validateRectangleCornerRadius(radius: number, width: number, height: number): void {
  if (!Number.isFinite(radius) || radius < 0) {
    throw new Error(
      `Invalid corner radius ${JSON.stringify(radius)}: must be a finite number between 0 and ${Math.min(width, height) / 2}.`,
    );
  }
  const max = Math.min(width, height) / 2;
  if (radius > max) {
    throw new Error(
      `Invalid corner radius ${radius}: must be a finite number between 0 and ${max} for a ${width}×${height} rectangle (a larger radius would be silently clamped, so the stored parameters would not describe the paint).`,
    );
  }
}

/**
 * The canonical shape-content identity (DEC-001): the shape's parameters in
 * their canonical form, hashed. The one string every shape revision's
 * `contentHash` derives from — the stored parameters are hash-covered by the
 * revision document itself, and this identity pins the content form the same
 * way a byte hash pins retained bytes for image and text.
 */
export function shapeContentIdentity(rev: {
  shape: string;
  width: number;
  height: number;
  cornerRadius?: number;
  fill: LayerFill;
}): string {
  return [
    "shape:v1",
    rev.shape,
    `${rev.width}x${rev.height}`,
    rev.cornerRadius !== undefined ? `r${rev.cornerRadius}` : "r0",
    `fill(${fillIdentityString(rev.fill)})`,
  ].join(":");
}

/**
 * The ONE shape-content validator (#208): geometry, size, corner radius, and
 * fill, in their canonical ranges. Refused values name the parameter and its
 * allowed range (US-001); the stored-revision reader reuses this validator,
 * so a malformed stored document fails the same way a refused command does.
 */
export function validateShapeContent(
  shape: unknown,
  width: unknown,
  height: unknown,
  cornerRadius: unknown,
  fill: unknown,
): { shape: LayerShapeGeometry; width: number; height: number; cornerRadius?: number; fill: LayerFill } {
  if (typeof shape !== "string" || !SHAPE_GEOMETRIES.includes(shape as LayerShapeGeometry)) {
    throw new Error(
      `Invalid shape "${String(shape)}": --shape takes rectangle or ellipse.`,
    );
  }
  for (const [label, value] of [["width", width], ["height", height]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_DIMENSION) {
      throw new Error(
        `Invalid shape ${label} ${JSON.stringify(value)}: must be a finite number greater than 0 and at most ${MAX_DIMENSION}.`,
      );
    }
  }
  let resolvedRadius: number | undefined;
  if (cornerRadius !== undefined) {
    if (typeof cornerRadius !== "number") {
      throw new Error(
        `Invalid corner radius ${JSON.stringify(cornerRadius)}: must be a finite number between 0 and ${Math.min(width as number, height as number) / 2}.`,
      );
    }
    if (shape === "ellipse") {
      throw new Error(
        `Invalid corner radius ${cornerRadius}: a corner radius is a rectangle fact — an ellipse has no straight corners. Remove --corner-radius.`,
      );
    }
    // The one corner-radius range rule (#208), shared with the visible
    // region's radius gate (#212): refuse, never clamp.
    validateRectangleCornerRadius(cornerRadius, width as number, height as number);
    resolvedRadius = cornerRadius;
  }
  let resolvedFill: LayerFill;
  if (fill === undefined) {
    throw new Error(
      'A shape Layer needs a fill: pass --fill <spec> (a solid color like "#22c55e" or a gradient like "linear:45deg,#ff0000,#00ff00").',
    );
  }
  if (
    typeof fill === "object" && fill !== null && !Array.isArray(fill) &&
    FILL_TYPES.includes((fill as LayerFill).type as (typeof FILL_TYPES)[number])
  ) {
    // Already a canonical LayerFill (the ingestion path's parsed value) —
    // the stored-fill normalizer re-projects it through the one canonical
    // form (a parsed gradient object carries every field the normalizer
    // re-validates, so a bad one is refused loudly either way).
    resolvedFill = normalizeStoredFill(fill);
  } else if (typeof fill === "string") {
    resolvedFill = parseFillSpec(fill);
  } else {
    throw new Error(
      `Invalid fill ${JSON.stringify(fill)}: a fill takes a solid color like "#22c55e", "solid:#22c55e", or a gradient like "linear:45deg,#ff0000,#00ff00".`,
    );
  }
  return {
    shape: shape as LayerShapeGeometry,
    width: width as number,
    height: height as number,
    ...(resolvedRadius !== undefined && resolvedRadius > 0 ? { cornerRadius: resolvedRadius } : {}),
    fill: resolvedFill,
  };
}

/**
 * Canonical stored-shape validation and normalization (#208): the one
 * boundary every stored shape revision's kind-specific fields project
 * through. A shape revision's fill is required; a malformed geometry, size,
 * radius, or fill is a malformed document, refused loudly before the revision
 * hash is consulted. A cornerRadius is stored only when set and > 0.
 */
export function normalizeStoredShape(revision: {
  shape?: unknown;
  width?: unknown;
  height?: unknown;
  cornerRadius?: unknown;
  fill?: unknown;
}): { shape: LayerShapeGeometry; width: number; height: number; cornerRadius?: number; fill: LayerFill } {
  if (revision.shape === undefined && revision.width === undefined && revision.height === undefined && revision.fill === undefined) {
    throw new Error("Malformed revision document: a shape revision needs its geometry, size, and fill.");
  }
  if (revision.fill === undefined) {
    throw new Error("Malformed revision document: a shape revision needs a fill.");
  }
  return validateShapeContent(revision.shape, revision.width, revision.height, revision.cornerRadius, revision.fill);
}

/** Allowed `tracking` range in em, inclusive (#187, ADR-0021). */
export const TRACKING_RANGE = { min: -0.5, max: 1 } as const;
/** Allowed `lineHeight` range as a unitless multiplier, inclusive (#187, ADR-0021). */
export const LINE_HEIGHT_RANGE = { min: 0.5, max: 3 } as const;

/** Canonical normalized transform scale: the one shape every consumer reads. */
export interface LayerTransformScale {
  scaleX: number;
  scaleY: number;
}

/**
 * Canonical stored-scale validation and normalization (#133, ADR-0016). This
 * is the one normalization boundary for transform scale: stored documents
 * written before #133 lack the fields (only a missing field is absent — a
 * present `null` or any other non-number is a malformed document, never a
 * silent default) and normalize to scale 1 here; every downstream reader
 * projects through this function and never re-derives a default. Stored
 * fields must be present together and be finite positive numbers — a partial
 * or invalid pair is a malformed document, refused loudly before the revision
 * hash is consulted.
 */
export function normalizeStoredScale(revision: {
  scaleX?: unknown;
  scaleY?: unknown;
}): LayerTransformScale {
  const hasX = revision.scaleX !== undefined;
  const hasY = revision.scaleY !== undefined;
  if (hasX !== hasY) {
    throw new Error(
      `Malformed revision document: scaleX and scaleY must be present together (got scaleX ${JSON.stringify(revision.scaleX)}, scaleY ${JSON.stringify(revision.scaleY)}).`,
    );
  }
  if (!hasX) {
    return { scaleX: 1, scaleY: 1 };
  }
  const scaleX = revision.scaleX;
  const scaleY = revision.scaleY;
  if (
    typeof scaleX !== "number" || !Number.isFinite(scaleX) || scaleX <= 0 ||
    typeof scaleY !== "number" || !Number.isFinite(scaleY) || scaleY <= 0
  ) {
    throw new Error(
      `Malformed revision document: scaleX and scaleY must be finite numbers greater than 0 (got ${JSON.stringify(scaleX)}, ${JSON.stringify(scaleY)}).`,
    );
  }
  return { scaleX, scaleY };
}

/**
 * Canonical stored-rotation validation and normalization (#134, ADR-0016).
 * The one normalization boundary for transform rotation: documents written
 * before #134 lack the field (only a missing field is absent — a present
 * `null` or any other non-number is a malformed document, never a silent
 * default) and normalize to 0 here; every downstream reader projects through
 * this function and never re-derives a default. A present field must be a
 * finite number (degrees, clockwise positive, stored verbatim).
 */
export function normalizeStoredRotation(revision: { rotationDeg?: unknown }): number {
  const rotation = revision.rotationDeg;
  if (rotation === undefined) {
    return 0;
  }
  if (typeof rotation !== "number" || !Number.isFinite(rotation)) {
    throw new Error(
      `Malformed revision document: rotationDeg must be a finite number of degrees when present (got ${JSON.stringify(rotation)}).`,
    );
  }
  return rotation;
}

/** Canonical normalized transform reflection: the one shape every consumer reads. */
export interface LayerTransformFlip {
  flipX: boolean;
  flipY: boolean;
}

/**
 * Canonical stored-reflection validation and normalization (#135, ADR-0016).
 * The one normalization boundary for transform reflection: documents written
 * before #135 lack the fields (only a missing field is absent — a present
 * `null` or any other non-boolean is a malformed document, never a silent
 * default) and normalize to false here; every downstream reader projects
 * through this function and never re-derives a default. A present pair must
 * be two booleans, recorded together like scale.
 */
export function normalizeStoredFlip(revision: {
  flipX?: unknown;
  flipY?: unknown;
}): LayerTransformFlip {
  const hasX = revision.flipX !== undefined;
  const hasY = revision.flipY !== undefined;
  if (hasX !== hasY) {
    throw new Error(
      `Malformed revision document: flipX and flipY must be present together (got flipX ${JSON.stringify(revision.flipX)}, flipY ${JSON.stringify(revision.flipY)}).`,
    );
  }
  if (!hasX) {
    return { flipX: false, flipY: false };
  }
  const flipX = revision.flipX;
  const flipY = revision.flipY;
  if (typeof flipX !== "boolean" || typeof flipY !== "boolean") {
    throw new Error(
      `Malformed revision document: flipX and flipY must be booleans when present (got flipX ${JSON.stringify(flipX)}, flipY ${JSON.stringify(flipY)}).`,
    );
  }
  return { flipX, flipY };
}

/** Effect parameter bounds (#139/#140, ADR-0018/0019): a bounded effect
 * footprint, so painted-extent capture stays bounded (DEC-006). Shadow
 * offsets may be negative. */
const MAX_SHADOW_OFFSET_PX = 256;
const MAX_SHADOW_BLUR_PX = 256;
const MAX_OUTLINE_WIDTH_PX = 256;

/** Effect hex color: #RGB, #RRGGBB, or #RRGGBBAA. */
const EFFECT_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Canonical effect-color form (INT-2 from the #139 review, decided for both
 * effects in #140): lowercase hex with `#RGB` expanded to `#RRGGBB`, applied
 * at the ONE ingestion boundary (the spec parsers). Case/shorthand variants
 * of the same paint can no longer hash into redundant revisions going
 * forward; documents stored before this decision stay verbatim (the stored
 * normalizers accept every conformant form, so old revision ids and pinned
 * paint are untouched).
 */
function canonicalizeEffectColor(color: string): string {
  const lower = color.toLowerCase();
  if (lower.length === 4) {
    // #RGB → #RRGGBB: duplicate each digit.
    const [, r, g, b] = lower;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return lower;
}

/**
 * Canonical stored-shadow validation and normalization (#139, ADR-0018).
 * The one normalization boundary for the shadow effect: documents written
 * before #139 lack the field, and absence IS the canonical no-shadow form —
 * every downstream reader projects through this function and never re-derives
 * a default. A present field must be a valid shadow object: finite `dx`/`dy`
 * within the offset cap, finite `blur` ≥ 0 within the blur cap, and a hex
 * `color` (#RGB/#RRGGBB/#RRGGBBAA) — anything else is a malformed document,
 * refused loudly before the revision hash is consulted.
 */
export function normalizeStoredShadow(revision: { shadow?: unknown }): LayerShadow | undefined {
  if (revision.shadow === undefined) {
    return undefined;
  }
  const raw = revision.shadow;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Malformed revision document: shadow must be a shadow object when present (got ${JSON.stringify(raw)}).`,
    );
  }
  const { dx, dy, blur, color } = raw as Record<string, unknown>;
  for (const [label, value] of [["dx", dx], ["dy", dy]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_SHADOW_OFFSET_PX) {
      throw new Error(
        `Malformed revision document: shadow.${label} must be a finite number of px within ±${MAX_SHADOW_OFFSET_PX} (got ${JSON.stringify(value)}).`,
      );
    }
  }
  if (typeof blur !== "number" || !Number.isFinite(blur) || blur < 0 || blur > MAX_SHADOW_BLUR_PX) {
    throw new Error(
      `Malformed revision document: shadow.blur must be a finite number of px between 0 and ${MAX_SHADOW_BLUR_PX} (got ${JSON.stringify(blur)}).`,
    );
  }
  if (typeof color !== "string" || !EFFECT_COLOR_PATTERN.test(color)) {
    throw new Error(
      `Malformed revision document: shadow.color must be a hex color like #000000, #000, or #00000080 (got ${JSON.stringify(color)}).`,
    );
  }
  return { dx, dy, blur, color } as LayerShadow;
}

/**
 * Canonical stored-outline validation and normalization (#140, ADR-0019).
 * The one normalization boundary for the outline effect: documents written
 * before #140 lack the field, and absence IS the canonical no-outline form —
 * every downstream reader projects through this function and never re-derives
 * a default. A present field must be a valid outline object: finite `width`
 * ≥ 0 within the width cap and a hex `color` — anything else is a malformed
 * document, refused loudly before the revision hash is consulted.
 */
export function normalizeStoredOutline(revision: { outline?: unknown }): LayerOutline | undefined {
  if (revision.outline === undefined) {
    return undefined;
  }
  const raw = revision.outline;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Malformed revision document: outline must be an outline object when present (got ${JSON.stringify(raw)}).`,
    );
  }
  const { width, color } = raw as Record<string, unknown>;
  if (typeof width !== "number" || !Number.isFinite(width) || width < 0 || width > MAX_OUTLINE_WIDTH_PX) {
    throw new Error(
      `Malformed revision document: outline.width must be a finite number of px between 0 and ${MAX_OUTLINE_WIDTH_PX} (got ${JSON.stringify(width)}).`,
    );
  }
  if (typeof color !== "string" || !EFFECT_COLOR_PATTERN.test(color)) {
    throw new Error(
      `Malformed revision document: outline.color must be a hex color like #000000, #000, or #00000080 (got ${JSON.stringify(color)}).`,
    );
  }
  return { width, color } as LayerOutline;
}

/**
 * Canonical stored visible-region validation and normalization (#211,
 * ADR-0023). The one normalization boundary for the region fact: documents
 * written before #211 lack the field, and absence IS the canonical
 * no-region form — every downstream reader projects through this function
 * and never re-derives a default. A present field must be a valid region
 * object: finite `x`/`y` ≥ 0 and finite positive `width`/`height` — anything
 * else is a malformed document, refused loudly before the revision
 * hash is consulted. The optional `cornerRadius` (#212), when present, must
 * be a finite number of px > 0 within the ONE corner-radius range rule
 * (0..min(width,height)/2 of the region rectangle — the shape Layer's rule,
 * through the same validator): a stored radius of 0 or out of range is a
 * malformed document. Content-bounds conformance is deliberately NOT
 * re-verified here: the set-time validation gates it against the content
 * box of the revision it was set on, and the region keeps clipping
 * deterministically whatever the current content box is (a region kept
 * across a later content edit clips the intersection — documented, never a
 * silent default).
 */
export function normalizeStoredVisibleRegion(revision: { visibleRegion?: unknown }): LayerVisibleRegion | undefined {
  if (revision.visibleRegion === undefined) {
    return undefined;
  }
  const raw = revision.visibleRegion;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Malformed revision document: visibleRegion must be a region object when present (got ${JSON.stringify(raw)}).`,
    );
  }
  const { x, y, width, height } = raw as Record<string, unknown>;
  for (const [label, value] of [["x", x], ["y", y]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(
        `Malformed revision document: visibleRegion.${label} must be a finite number of px >= 0 (got ${JSON.stringify(value)}).`,
      );
    }
  }
  for (const [label, value] of [["width", width], ["height", height]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(
        `Malformed revision document: visibleRegion.${label} must be a finite number of px greater than 0 (got ${JSON.stringify(value)}).`,
      );
    }
  }
  // The optional corner radius (#212): present only when set and > 0, and
  // subject to the ONE corner-radius range rule shared with the shape
  // Layer's validator — a stored radius outside 0..min(w,h)/2 is a malformed
  // document (the stored form must describe the paint).
  const { cornerRadius } = raw as Record<string, unknown>;
  if (cornerRadius !== undefined) {
    if (typeof cornerRadius !== "number" || !Number.isFinite(cornerRadius) || cornerRadius <= 0) {
      throw new Error(
        `Malformed revision document: visibleRegion.cornerRadius must be a finite number of px greater than 0 when present (got ${JSON.stringify(cornerRadius)}).`,
      );
    }
    validateRectangleCornerRadius(cornerRadius, width as number, height as number);
  }
  return { x, y, width, height, ...(cornerRadius !== undefined ? { cornerRadius } : {}) } as LayerVisibleRegion;
}

/**
 * Canonical stored vector-colour validation and normalization (#215, spec
 * #207 US-005, DEC-008/010). The one normalization boundary for the vector
 * colour fact: documents written before #215 lack the field, and absence IS
 * the canonical no-colour form — every downstream reader projects through
 * this function and never re-derives a default. A present field must be a
 * hex colour (#RGB/#RRGGBB/#RRGGBBAA) — anything else is a malformed
 * document, refused loudly before the revision hash is consulted. The
 * canonical colour form (lowercase, #RGB expanded — the ONE fill-colour
 * grammar's recipe, through parseFillColorSpec) is enforced here too, so a
 * stored shorthand and a freshly ingested equivalent colour project to ONE
 * form. The kind/format gates (vector content only) are publication-time
 * refusals; this boundary validates the colour's own form.
 */
export function normalizeStoredVectorColor(revision: { vectorColor?: unknown }): string | undefined {
  const value = revision.vectorColor;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !FILL_COLOR_PATTERN.test(value)) {
    throw new Error(
      `Malformed revision document: vectorColor must be a hex color like #22c55e, #2c5, or #22c55e80 when present (got ${JSON.stringify(value)}).`,
    );
  }
  // The ONE colour ingestion point canonicalizes (lowercase, #RGB expanded),
  // so a stored shorthand and a freshly ingested equivalent colour project
  // to ONE form — the same form the setter stores.
  return parseFillColorSpec(value, "stored vector colour");
}

export type ResolvedLayerRevision =
  | (LayerImageRevision & { revisionId: string; format: "png" | "jpeg" | "webp" | "svg"; width: number; height: number; bytes: number; scaleX: number; scaleY: number; rotationDeg: number; flipX: boolean; flipY: boolean })
  | (LayerTextRevision & { revisionId: string; fontBytes: number; scaleX: number; scaleY: number; rotationDeg: number; flipX: boolean; flipY: boolean })
  | (LayerShapeRevision & { revisionId: string; scaleX: number; scaleY: number; rotationDeg: number; flipX: boolean; flipY: boolean });

export interface ResolvedLayer {
  id: string;
  createdAt: string;
  currentRevisionId: string;
  currentRevision: ResolvedLayerRevision;
}

/** Decode image in headless browser to verify full payload integrity. The
 *  browser's own decode is the gate: malformed or truncated bytes — including
 *  an SVG's XML (via the same `<img>` data-URL path painting uses, which
 *  disables scripts and external loads by construction) — fail here and are
 *  refused at ingestion, never discovered at render time. */
async function decodeInBrowser(bytes: Buffer, mime: string): Promise<{ width: number; height: number }> {
  const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  return withRenderPage(async (page) => {
    return page.evaluate((src) => {
      return new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          if (!img.naturalWidth || !img.naturalHeight) {
            reject(new Error("Decoded image has 0 dimensions"));
          } else {
            resolve({ width: img.naturalWidth, height: img.naturalHeight });
          }
        };
        img.onerror = () => {
          reject(new Error("Image decoding failed"));
        };
        img.src = src;
      });
    }, dataUrl);
  });
}

/**
 * Validate already-read image bytes for Layer ingestion: resource bounds,
 * format sniffing, and full decode verification. The one content-validation
 * home shared by file ingestion (`validateAndIngestImage`) and generated-byte
 * ingestion (#107), so every ingestion path applies identical checks.
 */
export async function validateImageBytes(
  bytes: Buffer,
  sourceName: string,
): Promise<{ bytes: Buffer; contentHash: string; format: "png" | "jpeg" | "webp" | "svg"; width: number; height: number }> {
  if (bytes.length === 0) {
    throw new Error(`"${sourceName}" is empty (0 bytes)`);
  }
  if (bytes.length > MAX_ENCODED_BYTES) {
    throw new Error(
      `"${sourceName}" is ${(bytes.length / 1024 / 1024).toFixed(1)} MB — over the ${MAX_ENCODED_BYTES / 1024 / 1024} MB limit`,
    );
  }

  // The ONE meta reader with one new branch (#213, DEC-007): a `.svg` name
  // parses the vector's intrinsic size from the file's own width/height or
  // viewBox — malformed or non-SVG bytes are refused right here — while every
  // other name takes the established raster-sniff path. The format fact rides
  // the same projection either way: an SVG is image-kind content with a
  // vector format, not a fourth kind. Inertness is the second gate in the
  // same branch (#214, US-006): a file referencing anything outside itself is
  // refused here, naming each reference — after the identity gate (the file
  // must first be an SVG document) so a non-SVG blob keeps its accurate
  // message, and before anything is published.
  let meta: RasterMeta | SvgMeta | string;
  if (/\.svg$/i.test(sourceName)) {
    meta = readSvgMeta(bytes, sourceName);
    if (typeof meta !== "string") {
      const inertnessRefusal = scanSvgExternalReferences(bytes, sourceName);
      if (inertnessRefusal !== undefined) meta = inertnessRefusal;
    }
  } else {
    meta = readRasterMeta(bytes, sourceName);
  }
  if (typeof meta === "string") {
    throw new Error(meta);
  }

  if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) {
    throw new Error(
      `"${sourceName}" declares a ${meta.width}×${meta.height} canvas — over the ${MAX_DIMENSION}px per-axis limit`,
    );
  }
  if (meta.width * meta.height > MAX_PIXELS) {
    throw new Error(
      `"${sourceName}" declares ${meta.width}×${meta.height} — over the ${MAX_PIXELS.toLocaleString("en-US")}-pixel limit`,
    );
  }

  // Full image decompression / decoding verification — every format through
  // the browser's own decode, the same `<img>` path painting uses. For an SVG
  // this is the XML well-formedness gate: the vector is never inlined into
  // the page DOM, so malformed markup can only fail as an image decode, and
  // it fails here at ingestion rather than at render time.
  let decodedWidth = meta.width;
  let decodedHeight = meta.height;

  if (meta.format === "svg") {
    // The parse named the intrinsic size — the browser decode is only the
    // well-formedness gate, so its natural box (which can differ by a unit
    // conversion's rounding) never overrides the parsed facts the revision,
    // inspect, and measure all read.
    try {
      await decodeInBrowser(bytes, "image/svg+xml");
    } catch {
      throw new Error(
        `Malformed SVG file "${sourceName}": the browser's image decode refused the bytes ` +
          `(the XML is likely malformed or truncated).`,
      );
    }
  } else if (meta.format === "png") {
    try {
      const decoded = decodePng(bytes);
      decodedWidth = decoded.width;
      decodedHeight = decoded.height;
    } catch (pngErr) {
      const errMsg = (pngErr as Error).message;
      if (errMsg.includes("not supported")) {
        // Unsupported feature in simple parser (e.g. palette, interlaced) -> verify with browser
        try {
          const browserDecoded = await decodeInBrowser(bytes, "image/png");
          decodedWidth = browserDecoded.width;
          decodedHeight = browserDecoded.height;
        } catch {
          throw new Error(`Corrupted PNG image "${sourceName}": ${errMsg}`);
        }
      } else {
        // Real corruption (bad CRC, truncated IDAT, etc.)
        throw new Error(`Corrupted PNG image "${sourceName}": ${errMsg}`);
      }
    }
  } else {
    try {
      const browserDecoded = await decodeInBrowser(
        bytes,
        meta.format === "jpeg" ? "image/jpeg" : "image/webp",
      );
      decodedWidth = browserDecoded.width;
      decodedHeight = browserDecoded.height;
    } catch (browserErr) {
      throw new Error(`Corrupted ${meta.format.toUpperCase()} image "${sourceName}": ${(browserErr as Error).message}`);
    }
  }

  const contentHash = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    contentHash,
    format: meta.format,
    width: decodedWidth,
    height: decodedHeight,
  };
}

/**
 * Validate and ingest an external image file.
 * Returns the validated raw bytes, SHA-256 hash, and intrinsic dimensions.
 */
export async function validateAndIngestImage(
  imagePath: string,
): Promise<{ bytes: Buffer; contentHash: string; format: "png" | "jpeg" | "webp" | "svg"; width: number; height: number }> {
  const resolvedPath = path.resolve(imagePath);

  let fh: FileHandle;
  try {
    fh = await fsOpen(resolvedPath, "r");
  } catch (err) {
    throw new Error(`cannot read the input image "${imagePath}": ${(err as Error).message}`);
  }

  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      throw new Error(`"${imagePath}" is not a regular file — supported input is a regular local PNG, JPEG, WebP, or SVG file`);
    }
    if (st.size > MAX_ENCODED_BYTES) {
      throw new Error(
        `"${imagePath}" is ${(st.size / 1024 / 1024).toFixed(1)} MB — over the ${MAX_ENCODED_BYTES / 1024 / 1024} MB limit`,
      );
    }
    if (st.size === 0) {
      throw new Error(`"${imagePath}" is empty (0 bytes)`);
    }

    const bytes = Buffer.alloc(st.size);
    let totalRead = 0;
    while (totalRead < bytes.length) {
      const { bytesRead } = await fh.read(bytes, totalRead, bytes.length - totalRead, totalRead);
      if (bytesRead <= 0) {
        throw new Error(`"${imagePath}" changed while being read`);
      }
      totalRead += bytesRead;
    }

    return await validateImageBytes(bytes, imagePath);
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Canonical text content validation (#81): one home for the text facts every
 * writer and reader must agree on. Ingestion and the stored-revision parser
 * both call this, so no alternate representation can drift.
 */
export function validateTextContent(text: unknown, fontSize: unknown, color: unknown): void {
  if (typeof text !== "string" || text.length === 0 || text.trim().length === 0) {
    throw new Error(`Invalid text content: must be a nonempty string.`);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(`Invalid text content: ${text.length} characters exceeds the ${MAX_TEXT_LENGTH}-character limit.`);
  }
  if (typeof fontSize !== "number" || !Number.isFinite(fontSize) || fontSize <= 0 || fontSize > MAX_DIMENSION) {
    throw new Error(
      `Invalid font size ${fontSize}: must be a finite number between 0 and ${MAX_DIMENSION}.`,
    );
  }
  if (typeof color !== "string" || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
    throw new Error(`Invalid color "${color}": must be a hex color like #ffffff or #fff.`);
  }
}

/** Canonical normalized text axes (#179, ADR-0021): the one shape every
 * consumer reads. Present together or not at all — a variable face's look is
 * weight and width resolved as one instance, so a lone field is a malformed
 * document, never a silent default. */
export interface LayerTextAxes {
  weight: number;
  width: number;
}

/** Canonical normalized text typography (#187, ADR-0021): the one shape every
 * consumer reads. Unlike the axes, the fields are independent — each is
 * present only when set. */
export interface LayerTextTypography {
  tracking?: number;
  lineHeight?: number;
}

/**
 * The ONE validator/normalizer for text tracking and line-height CONTROLS
 * (#187, ADR-0021) — the single home the add path, the edit path, and both
 * CLI boundaries share, so the boundaries never disagree. Tracking and line
 * height are font-independent, so unlike `resolveTextAxes` they validate
 * against fixed Ply ranges, not a face's bytes. `null` clears a control;
 * `undefined` means not given; a `tracking` of 0 is the same look as absent
 * and normalizes to absent, so the resolved fields are always storable
 * values (tracking never 0). Every refusal names the control and its
 * allowed range, and fires before anything is published.
 */
export function resolveTextTypographyControls(controls: {
  tracking?: number | null;
  lineHeight?: number | null;
}): LayerTextTypography {
  const out: LayerTextTypography = {};
  const checks = [
    {
      name: "tracking",
      label: "Tracking (--tracking)",
      value: controls.tracking,
      range: TRACKING_RANGE,
      zeroMeansAbsent: true,
    },
    {
      name: "lineHeight",
      label: "Line height (--line-height)",
      value: controls.lineHeight,
      range: LINE_HEIGHT_RANGE,
      zeroMeansAbsent: false,
    },
  ] as const;
  for (const { name, label, value, range, zeroMeansAbsent } of checks) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${label} must be a finite number.`);
    }
    if (zeroMeansAbsent && value === 0) continue;
    if (value < range.min || value > range.max) {
      throw new Error(
        `${label} must be between ${range.min} and ${range.max} (inclusive) — ${value} is out of range.`,
      );
    }
    out[name as "tracking" | "lineHeight"] = value;
  }
  return out;
}

/**
 * Canonical stored-text-typography validation and normalization (#187,
 * ADR-0021). The ONE normalization boundary AND the one reader for a
 * revision's tracking/line height: documents written before #187 lack the
 * fields (only a missing field is absent — a present `null` or any other
 * non-number is a malformed document, never a silent default); every
 * downstream reader — revision resolution, the revision hash, paint markup,
 * measurement, and the edit carry path — projects through this function and
 * never re-derives the fields. Each field is independent: present only when
 * set, a finite number inside its allowed range, and a stored `tracking` of
 * 0 is a malformed document (0 is stored as absent — one stored form per
 * look).
 */
export function normalizeStoredTextTypography(revision: {
  tracking?: unknown;
  lineHeight?: unknown;
}): LayerTextTypography {
  const out: LayerTextTypography = {};
  const checks = [
    {
      name: "tracking" as const,
      value: revision.tracking,
      range: TRACKING_RANGE,
      zeroIsMalformed: true,
    },
    {
      name: "lineHeight" as const,
      value: revision.lineHeight,
      range: LINE_HEIGHT_RANGE,
      zeroIsMalformed: false,
    },
  ];
  for (const { name, value, range, zeroIsMalformed } of checks) {
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `Malformed revision document: text ${name} must be a finite number when present (got ${JSON.stringify(value)}).`,
      );
    }
    if (zeroIsMalformed && value === 0) {
      throw new Error(
        `Malformed revision document: text tracking 0 is the same look as no tracking and is never stored.`,
      );
    }
    if (value < range.min || value > range.max) {
      throw new Error(
        `Malformed revision document: text ${name} ${value} is outside its allowed range ${range.min} to ${range.max}.`,
      );
    }
    out[name] = value;
  }
  return out;
}

/**
 * Canonical stored-text-axes validation and normalization (#179, ADR-0021).
 * The ONE normalization boundary AND the one reader for a revision's text
 * weight/width: documents written before #179 lack the fields (only a
 * missing field is absent — a present `null` or any other non-number is a
 * malformed document, never a silent default); every downstream reader —
 * revision resolution, the revision hash, paint markup, measurement, and
 * the edit carry path — projects through this function and never re-derives
 * the fields. Fields must be present together and be finite numbers — a
 * partial or invalid pair is a malformed document, refused loudly before
 * the revision hash is consulted.
 */
export function normalizeStoredTextAxes(revision: {
  weight?: unknown;
  width?: unknown;
}): LayerTextAxes | undefined {
  const hasWeight = revision.weight !== undefined;
  const hasWidth = revision.width !== undefined;
  if (hasWeight !== hasWidth) {
    throw new Error(
      `Malformed revision document: text weight and width must be present together (got weight ${JSON.stringify(revision.weight)}, width ${JSON.stringify(revision.width)}).`,
    );
  }
  if (!hasWeight) {
    return undefined;
  }
  const weight = revision.weight;
  const width = revision.width;
  if (
    typeof weight !== "number" || !Number.isFinite(weight) ||
    typeof width !== "number" || !Number.isFinite(width)
  ) {
    throw new Error(
      `Malformed revision document: text weight and width must be finite numbers when present (got weight ${JSON.stringify(revision.weight)}, width ${JSON.stringify(revision.width)}).`,
    );
  }
  return { weight, width };
}

/**
 * Canonical stored-caller-font-facts validation and normalization (#232,
 * spec #226 US-005, DEC-006). The ONE reader for a revision's caller font
 * facts: documents written before #232 lack the field, and absence IS the
 * bundled-or-legacy form — every downstream reader projects through this
 * function and never re-derives the facts. A present field must be a valid
 * facts object — a nonempty string family, a known variant and glyph
 * format, a finite static weight, or a variable face's real fvar ranges
 * (min ≤ default ≤ max, finite) — anything else is a malformed document,
 * refused loudly before the revision hash is consulted. A conformant
 * object with extra unknown keys is tolerated and those keys are dropped
 * from the resolved view (the same reader tolerance the scale/rotation/
 * flip normalizers apply).
 */
export function normalizeStoredCallerFont(revision: { callerFont?: unknown }): CallerFontFacts | undefined {
  const raw = revision.callerFont;
  if (raw === undefined) {
    return undefined;
  }
  const malformed = (what: string, value: unknown): Error =>
    new Error(
      `Malformed revision document: callerFont.${what} is malformed (got ${JSON.stringify(value)}).`,
    );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw malformed("facts", raw);
  }
  const facts = raw as Record<string, unknown>;
  if (typeof facts.family !== "string" || facts.family.trim() === "") {
    throw malformed("family", facts.family);
  }
  if (facts.variant !== "static" && facts.variant !== "variable") {
    throw malformed("variant", facts.variant);
  }
  if (facts.format !== "truetype" && facts.format !== "opentype") {
    throw malformed("format", facts.format);
  }
  const axis = (value: unknown, name: string): { min: number; default: number; max: number } => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw malformed(`axes.${name}`, value);
    }
    const a = value as Record<string, unknown>;
    for (const field of ["min", "default", "max"] as const) {
      if (typeof a[field] !== "number" || !Number.isFinite(a[field] as number)) {
        throw malformed(`axes.${name}.${field}`, a[field]);
      }
    }
    const min = a.min as number;
    const def = a.default as number;
    const max = a.max as number;
    if (min > def || def > max) {
      throw malformed(`axes.${name} range (min ${min}, default ${def}, max ${max})`, value);
    }
    return { min, default: def, max };
  };
  if (facts.variant === "static") {
    if (typeof facts.weight !== "number" || !Number.isFinite(facts.weight)) {
      throw malformed("weight", facts.weight);
    }
    return { family: facts.family, variant: "static", format: facts.format, weight: facts.weight };
  }
  if (!facts.axes || typeof facts.axes !== "object") {
    throw malformed("axes", facts.axes);
  }
  const axes = facts.axes as Record<string, unknown>;
  if (typeof axes.wght === "undefined") {
    throw malformed("axes.wght", axes.wght);
  }
  return {
    family: facts.family,
    variant: "variable",
    format: facts.format,
    axes: {
      wght: axis(axes.wght, "wght"),
      ...(axes.wdth !== undefined ? { wdth: axis(axes.wdth, "wdth") } : {}),
    },
  };
}

/**
 * Compute content-derived revision hash for an immutable revision record.
 * The scale fields are appended only when present, so revisions written
 * before #133 hash to exactly their pre-resize ids: older revisions retain
 * their original hash and paint meaning (#133). The rotation field is
 * likewise appended only when present, so revisions written before #134 —
 * with or without scale fields — keep their exact ids (#134). The flip
 * fields are appended only when present, so revisions written before #135
 * keep their exact ids (#135). The shadow and outline fields are appended
 * only when present, so revisions written before #139/#140 keep their exact
 * ids (#139, #140). The visible-region field is appended only when present,
 * so revisions written before #211 keep their exact ids (#211). The region's
 * corner radius is appended only when present, so revisions written before
 * #212 — and region-carrying revisions without a radius — keep their exact
 * ids (#212). The text
 * weight/width fields are appended only when
 * present (as one resolved pair), so revisions written before #179 keep
 * their exact ids (#179, ADR-0021). The text tracking and line-height
 * fields are appended only when present, so revisions written before #187
 * keep their exact ids (#187, ADR-0021). The caller font facts are
 * appended only when present, so revisions written before #232 — bundled
 * faces and legacy blobs — keep their exact ids (#232). The vector colour
 * is appended only when present (image revisions only), so revisions
 * written before #215 keep their exact ids (#215, DEC-010). */
export function computeRevisionHash(rev: LayerRevision): string {
  const base = `${rev.layerId}:${rev.kind}:${rev.contentHash}:${rev.x}:${rev.y}:${rev.opacity}:${rev.createdAt}`;
  const textFields = rev.kind === "text" ? `:${rev.text}:${rev.fontSize}:${rev.color}` : "";
  const scaleFields =
    rev.scaleX !== undefined || rev.scaleY !== undefined ? `:${rev.scaleX}:${rev.scaleY}` : "";
  const rotationField = rev.rotationDeg !== undefined ? `:${rev.rotationDeg}` : "";
  const flipFields =
    rev.flipX !== undefined || rev.flipY !== undefined ? `:${rev.flipX}:${rev.flipY}` : "";
  const shadowField =
    rev.shadow !== undefined
      ? `:shadow(${rev.shadow.dx},${rev.shadow.dy},${rev.shadow.blur},${rev.shadow.color})`
      : "";
  const outlineField =
    rev.outline !== undefined ? `:outline(${rev.outline.width},${rev.outline.color})` : "";
  const regionField =
    rev.visibleRegion !== undefined
      ? `:region(${rev.visibleRegion.x},${rev.visibleRegion.y},${rev.visibleRegion.width},${rev.visibleRegion.height}` +
        (rev.visibleRegion.cornerRadius !== undefined ? `,r${rev.visibleRegion.cornerRadius}` : "") +
        `)`
      : "";
  const textAxes = rev.kind === "text" ? normalizeStoredTextAxes(rev) : undefined;
  const textAxesFields = textAxes !== undefined ? `:textaxes(${textAxes.weight},${textAxes.width})` : "";
  const typography = rev.kind === "text" ? normalizeStoredTextTypography(rev) : undefined;
  const typographyFields =
    typography !== undefined
      ? (typography.tracking !== undefined ? `:tracking(${typography.tracking})` : "") +
        (typography.lineHeight !== undefined ? `:lineheight(${typography.lineHeight})` : "")
      : "";
  const callerFont = rev.kind === "text" ? normalizeStoredCallerFont(rev) : undefined;
  const callerFontFields =
    callerFont !== undefined
      ? `:callerfont(${callerFont.family},${callerFont.variant},${callerFont.format}` +
        (callerFont.variant === "static"
          ? `,w${callerFont.weight})`
          : `,wght(${callerFont.axes!.wght.min},${callerFont.axes!.wght.default},${callerFont.axes!.wght.max})` +
            (callerFont.axes!.wdth !== undefined
              ? `,wdth(${callerFont.axes!.wdth!.min},${callerFont.axes!.wdth!.default},${callerFont.axes!.wdth!.max})`
              : "") +
            ")")
      : "";
  // The vector colour (#215, DEC-010): appended only when present on an
  // image revision, in its canonical form (the ONE colour grammar's recipe
  // — the same form the stored normalizer projects), so revisions written
  // before #215 keep their exact ids.
  const vectorColor = rev.kind === "image" ? normalizeStoredVectorColor(rev) : undefined;
  const vectorColorFields = vectorColor !== undefined ? `:vectorcolor(${vectorColor})` : "";
  // The shape revision's kind-specific facts (#208): the stored geometry,
  // size, and radius are hash-covered revision fields, and the fill's
  // canonical form rides along. Appended only for shape revisions, so image
  // and text revision ids are untouched.
  const shapeFields =
    rev.kind === "shape"
      ? normalizeStoredShape(rev)
      : undefined;
  const shapeFieldsFields =
    shapeFields !== undefined
      ? `:shape(${shapeFields.shape},${shapeFields.width},${shapeFields.height}` +
        (shapeFields.cornerRadius !== undefined ? `,r${shapeFields.cornerRadius}` : "") +
        `,fill(${fillIdentityString(shapeFields.fill)}))`
      : "";
  return `rev_${createHash("sha256").update(`${base}${textFields}${scaleFields}${rotationField}${flipFields}${shadowField}${outlineField}${regionField}${textAxesFields}${typographyFields}${callerFontFields}${vectorColorFields}${shapeFieldsFields}`).digest("hex").slice(0, 16)}`;
}

/** Generate a unique stable Layer ID. */
export function generateLayerId(): string {
  return `layer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Store content blob into project's content/ directory with deduplication and validation.
 */
export async function storeContentBlob(projectPath: string, contentHash: string, bytes: Buffer): Promise<void> {
  const contentDir = path.join(projectPath, "content");
  const blobPath = path.join(contentDir, contentHash);

  if (outsideDir(projectPath, blobPath)) {
    throw new Error(`Security error: content path escapes project boundary.`);
  }

  try {
    await lstat(blobPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await atomicCreate(blobPath, bytes);
    return;
  }
  if (await escapesDirReal(projectPath, blobPath)) {
    throw new Error("Security error: content blob escapes project boundary.");
  }
  const existing = await readFile(blobPath);
  if (createHash("sha256").update(existing).digest("hex") !== contentHash) {
    throw new Error(`Corrupted content blob "${contentHash}": stored bytes do not match the content hash.`);
  }
}

/**
 * Unlocked internal reader that also returns the verified retained content
 * bytes. Callers must hold the Project lock. This is the one canonical
 * Layer resolution site: identity, current revision, and content are read,
 * validated, and hash-verified here exactly once; metadata-only readers
 * project from it without a second read or a second verification.
 */
export async function readLayerInternalFull(
  projectPath: string,
  layerId: string,
): Promise<ResolvedLayer & { contentBytes: Buffer }> {
  if (!/^layer_[a-zA-Z0-9_]+$/.test(layerId)) {
    throw new Error(`Invalid Layer identity "${layerId}".`);
  }
  const resolvedRoot = path.resolve(projectPath);
  const layerFile = path.join(resolvedRoot, "layers", `${layerId}.json`);

  if (outsideDir(resolvedRoot, layerFile)) {
    throw new Error(`Security error: layer path "${layerId}" escapes project boundary.`);
  }

  if (await escapesDirReal(resolvedRoot, layerFile)) {
    throw new Error(`Security error: layer "${layerId}" escapes project boundary.`);
  }

  let identityRaw: string;
  try {
    identityRaw = await readFile(layerFile, "utf8");
  } catch {
    throw new Error(`Layer "${layerId}" not found in project.`);
  }


  let identity: LayerIdentity;
  try {
    identity = JSON.parse(identityRaw);
  } catch (err) {
    throw new Error(`Malformed Layer manifest for "${layerId}": ${(err as Error).message}`);
  }

  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error(`Malformed Layer manifest for "${layerId}": root must be an object.`);
  }
  if (!isStoredTimestamp(identity.createdAt)) {
    throw new Error(`Malformed Layer manifest for "${layerId}": missing or invalid createdAt.`);
  }
  if (typeof identity.currentRevision !== "string" || !/^rev_[0-9a-f]{16}$/.test(identity.currentRevision)) {
    throw new Error(`Malformed Layer manifest for "${layerId}": invalid currentRevision.`);
  }
  if (identity.schemaVersion !== LAYER_SCHEMA_VERSION) {
    throw new Error(`Unsupported layer schemaVersion ${identity.schemaVersion} for layer "${layerId}"`);
  }
  if (identity.id !== layerId) {
    throw new Error(
      `Malformed Layer manifest for "${layerId}": identity id "${identity.id}" does not match its file.`,
    );
  }

  const revHash = identity.currentRevision;
  const resolved = await readRevisionInternalFull(resolvedRoot, layerId, revHash);
  return {
    id: identity.id,
    createdAt: identity.createdAt,
    currentRevisionId: revHash,
    currentRevision: resolved.revision,
    contentBytes: resolved.contentBytes,
  };
}

/**
 * Resolve a pinned revision of a Layer by identity and revision id, without
 * consulting the Layer identity document (#87). This is the one canonical
 * revision-resolution site: the revision document is validated, hash-verified,
 * and its retained content blob is read and hash-verified here exactly once —
 * the same validation `readLayerInternalFull` performs for current revisions.
 * Historical replay (render manifests, #87) resolves through this reader, so
 * it never depends on current Layer pointers or Composition documents.
 *
 * Both pinned identifiers are strictly validated BEFORE any filesystem path
 * is constructed. Callers must hold the Project lock.
 */
export async function readRevisionInternalFull(
  projectPath: string,
  layerId: string,
  revisionId: string,
): Promise<{ revision: ResolvedLayerRevision; contentBytes: Buffer }> {
  if (!/^layer_[a-zA-Z0-9_]+$/.test(layerId)) {
    throw new Error(`Invalid Layer identity "${layerId}".`);
  }
  if (!/^rev_[0-9a-f]{16}$/.test(revisionId)) {
    throw new Error(`Invalid revision id "${revisionId}" for layer "${layerId}".`);
  }
  const resolvedRoot = path.resolve(projectPath);
  const revDir = path.join(resolvedRoot, "layers", `${layerId}.revisions`);
  const revFile = path.join(revDir, `${revisionId}.json`);

  if (outsideDir(resolvedRoot, revFile)) {
    throw new Error(`Security error: revision path for layer "${layerId}" escapes project boundary.`);
  }

  // Existence first: a missing revision gets its clear actionable failure,
  // never a raw filesystem error. Only an existing file is judged by its
  // resolved location, so an escaping alias is still refused.
  try {
    await lstat(revFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Revision "${revisionId}" for layer "${layerId}" not found in project.`);
    }
    throw err;
  }
  if (await escapesDirReal(resolvedRoot, revFile)) {
    throw new Error(`Security error: revision for layer "${layerId}" escapes project boundary.`);
  }

  const revRaw = await readFile(revFile, "utf8");

  let revision: LayerRevision;
  try {
    revision = JSON.parse(revRaw);
  } catch (err) {
    throw new Error(`Malformed revision document for layer "${layerId}": ${(err as Error).message}`);
  }

  // Canonical revision shape: the document must be a valid, self-consistent
  // revision of this Layer before anything downstream trusts it.
  if (!revision || typeof revision !== "object" || Array.isArray(revision)) {
    throw new Error(`Malformed revision document for "${layerId}": root must be an object.`);
  }
  if (!isStoredTimestamp(revision.createdAt)) {
    throw new Error(`Malformed revision document for "${layerId}": missing or invalid createdAt.`);
  }
  if (revision.schemaVersion !== LAYER_SCHEMA_VERSION) {
    throw new Error(`Unsupported revision schemaVersion ${revision.schemaVersion} for layer "${layerId}"`);
  }
  if (revision.layerId !== layerId) {
    throw new Error(
      `Malformed revision document "${revisionId}" for layer "${layerId}": layerId "${revision.layerId}" does not match.`,
    );
  }
  const storedKind = (revision as { kind?: unknown }).kind;
  if (storedKind !== "image" && storedKind !== "text" && storedKind !== "shape") {
    throw new Error(
      `Malformed revision document "${revisionId}" for layer "${layerId}": unsupported kind "${String(storedKind)}".`,
    );
  }
  if (typeof revision.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(revision.contentHash)) {
    throw new Error(
      `Malformed revision document "${revisionId}" for layer "${layerId}": contentHash is not a sha-256 digest.`,
    );
  }
  if (revision.kind === "text") {
    // Canonical text content: validated here and at ingestion through the
    // same validator — no alternate representation exists.
    validateTextContent(revision.text, revision.fontSize, revision.color);
  }
  // Canonical shape content (#208): validated here and at ingestion through
  // the same validator — geometry, size, radius, and fill in their canonical
  // ranges, before the revision hash is consulted.
  const shapeContent = revision.kind === "shape" ? normalizeStoredShape(revision) : undefined;
  if (!Number.isFinite(revision.x) || !Number.isFinite(revision.y)) {
    throw new Error(
      `Malformed revision document "${revisionId}" for layer "${layerId}": x and y must be finite numbers.`,
    );
  }
  if (!Number.isFinite(revision.opacity) || revision.opacity < 0 || revision.opacity > 1) {
    throw new Error(
      `Malformed revision document "${revisionId}" for layer "${layerId}": opacity must be a finite number between 0 and 1.`,
    );
  }
  // Canonical transform scale: validated and normalized at this one boundary
  // (#133, ADR-0016) — malformed stored pairs are refused loudly before the
  // revision hash is consulted.
  const scale = normalizeStoredScale(revision);
  // Canonical transform rotation: validated and normalized at this same one
  // boundary (#134, ADR-0016) — a malformed stored field is refused loudly
  // before the revision hash is consulted.
  const rotationDeg = normalizeStoredRotation(revision);
  // Canonical transform reflection: validated and normalized at this same one
  // boundary (#135, ADR-0016) — malformed stored fields are refused loudly
  // before the revision hash is consulted.
  const flip = normalizeStoredFlip(revision);
  // Canonical shadow effect: validated and normalized at this same one
  // boundary (#139, ADR-0018) — a malformed stored field is refused loudly
  // before the revision hash is consulted. Absence IS the no-shadow form.
  // A conformant object with extra unknown keys is tolerated and those keys
  // are dropped from the resolved view (the same reader tolerance the
  // scale/rotation/flip normalizers apply); the canonical fields are the
  // only representation any consumer sees.
  const shadow = normalizeStoredShadow(revision);
  // Canonical outline effect: validated and normalized at this same one
  // boundary (#140, ADR-0019) — a malformed stored field is refused loudly
  // before the revision hash is consulted. Absence IS the no-outline form.
  const outline = normalizeStoredOutline(revision);
  // Canonical visible region: validated and normalized at this same one
  // boundary (#211, ADR-0023) — a malformed stored field is refused loudly
  // before the revision hash is consulted. Absence IS the no-region form.
  const visibleRegion = normalizeStoredVisibleRegion(revision);
  // Canonical text axes: validated and normalized at this same one boundary
  // (#179, ADR-0021) — a malformed stored pair is refused loudly before the
  // revision hash is consulted. Absence IS the no-axes form (static fonts).
  const textAxes = revision.kind === "text" ? normalizeStoredTextAxes(revision) : undefined;
  // Canonical text typography: validated and normalized at this same one
  // boundary (#187, ADR-0021) — a malformed stored field is refused loudly
  // before the revision hash is consulted. Absence IS the normal-spacing /
  // normal-line-height form.
  const textTypography =
    revision.kind === "text" ? normalizeStoredTextTypography(revision) : undefined;
  // Canonical caller font facts: validated and normalized at this same one
  // boundary (#232, DEC-006) — a malformed stored facts object is refused
  // loudly before the revision hash is consulted. Absence IS the
  // bundled-or-legacy form.
  const callerFont = revision.kind === "text" ? normalizeStoredCallerFont(revision) : undefined;
  // Canonical vector colour (#215, DEC-008/010): validated and normalized at
  // this same one boundary — a malformed stored colour is refused loudly
  // before the revision hash is consulted. Absence IS the no-colour form.
  const vectorColor = revision.kind === "image" ? normalizeStoredVectorColor(revision) : undefined;

  // The stored document must hash to exactly the pinned revision id
  if (computeRevisionHash(revision) !== revisionId) {
    throw new Error(
      `Corrupted revision document "${revisionId}" for layer "${layerId}": contents do not match the revision hash.`,
    );
  }

  // Read and verify content blob — existence first, then the resolved-location
  // gate, then the bytes (missing stays a clear failure, never raw ENOENT).
  // A shape revision (#208, DEC-001) has no retained bytes: its content IS
  // its parameters, hash-covered by the revision document itself, so there
  // is no content blob to locate, bound, read, or hash-verify.
  let contentBytes: Buffer | undefined;
  const contentBlob = path.join(resolvedRoot, "content", revision.contentHash);
  if (revision.kind !== "shape") {
    if (outsideDir(resolvedRoot, contentBlob)) {
      throw new Error(`Security error: content blob escapes project boundary.`);
    }

    try {
      await lstat(contentBlob);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Content blob "${revision.contentHash}" for layer "${layerId}" missing in project.`);
      }
      throw err;
    }
    if (await escapesDirReal(resolvedRoot, contentBlob)) {
      throw new Error(`Security error: content blob for layer "${layerId}" escapes project boundary.`);
    }

    try {
      contentBytes = await readFile(contentBlob);
    } catch {
      throw new Error(`Content blob "${revision.contentHash}" for layer "${layerId}" missing in project.`);
    }

    // Retained bytes must still hash to the content identity the revision pins
    const actualHash = createHash("sha256").update(contentBytes).digest("hex");
    if (actualHash !== revision.contentHash) {
      throw new Error(
        `Corrupted content blob "${revision.contentHash}" for layer "${layerId}": stored bytes do not match the content hash.`,
      );
    }
  }

  // Discriminated content resolution (#81): one resolver, one verification
  // pass, kind-specific projection. Image revisions derive intrinsic raster
  // facts from the verified bytes; text revisions carry their facts in the
  // hash-covered revision document and pin the retained font bytes; shape
  // revisions (#208) carry their parameter facts in the document with no
  // retained bytes at all (DEC-001).
  const resolved: ResolvedLayerRevision =
    revision.kind === "image"
      ? (() => {
          // The same one-branch dispatch ingestion uses (#213, DEC-007): a
          // raster sniff first, the SVG parse for a text-shaped blob the
          // sniff refuses — the retained bytes decide the format fact, so a
          // vector revision needs no schema change (DEC-010). A binary blob
          // that is neither reports the raster sniff's message; a text-shaped
          // one reports the SVG parse's.
          const rasterMeta = readRasterMeta(contentBytes!, contentBlob);
          const meta =
            typeof rasterMeta === "string" && !contentBytes!.subarray(0, 512).includes(0)
              ? readSvgMeta(contentBytes!, contentBlob)
              : rasterMeta;
          if (typeof meta === "string") {
            throw new Error(`Invalid content blob "${revision.contentHash}" for layer "${layerId}": ${meta}`);
          }
          return {
            schemaVersion: revision.schemaVersion,
            revisionId,
            layerId: revision.layerId,
            createdAt: revision.createdAt,
            kind: revision.kind,
            contentHash: revision.contentHash,
            x: revision.x,
            y: revision.y,
            opacity: revision.opacity,
            scaleX: scale.scaleX,
            scaleY: scale.scaleY,
            rotationDeg,
            flipX: flip.flipX,
            flipY: flip.flipY,
            ...(shadow !== undefined ? { shadow } : {}),
            ...(outline !== undefined ? { outline } : {}),
            ...(visibleRegion !== undefined ? { visibleRegion } : {}),
            ...(vectorColor !== undefined ? { vectorColor } : {}),
            format: meta.format,
            width: meta.width,
            height: meta.height,
            bytes: contentBytes!.length,
          };
        })()
      : revision.kind === "text"
      ? {
          schemaVersion: revision.schemaVersion,
          revisionId,
          layerId: revision.layerId,
          createdAt: revision.createdAt,
          kind: revision.kind,
          contentHash: revision.contentHash,
          x: revision.x,
          y: revision.y,
          opacity: revision.opacity,
          scaleX: scale.scaleX,
          scaleY: scale.scaleY,
          rotationDeg,
          flipX: flip.flipX,
          flipY: flip.flipY,
          ...(shadow !== undefined ? { shadow } : {}),
          ...(outline !== undefined ? { outline } : {}),
          ...(visibleRegion !== undefined ? { visibleRegion } : {}),
          text: revision.text,
          fontSize: revision.fontSize,
          color: revision.color,
          ...(textAxes ?? {}),
          ...(textTypography ?? {}),
          ...(callerFont !== undefined ? { callerFont } : {}),
          fontBytes: contentBytes!.length,
        }
      : {
          // Shape revision (#208): the parameter facts ride in the document;
          // no bytes exist to count or verify.
          schemaVersion: revision.schemaVersion,
          revisionId,
          layerId: revision.layerId,
          createdAt: revision.createdAt,
          kind: revision.kind,
          contentHash: revision.contentHash,
          shape: shapeContent!.shape,
          width: shapeContent!.width,
          height: shapeContent!.height,
          ...(shapeContent!.cornerRadius !== undefined ? { cornerRadius: shapeContent!.cornerRadius } : {}),
          fill: shapeContent!.fill,
          x: revision.x,
          y: revision.y,
          opacity: revision.opacity,
          scaleX: scale.scaleX,
          scaleY: scale.scaleY,
          rotationDeg,
          flipX: flip.flipX,
          flipY: flip.flipY,
          ...(shadow !== undefined ? { shadow } : {}),
          ...(outline !== undefined ? { outline } : {}),
          ...(visibleRegion !== undefined ? { visibleRegion } : {}),
        };

  return { revision: resolved, contentBytes: contentBytes ?? Buffer.alloc(0) };
}

/** Unlocked internal reader for Layer identity and its active revision. Callers must hold the Project lock. */
export async function readLayerInternal(projectPath: string, layerId: string): Promise<ResolvedLayer> {
  const full = await readLayerInternalFull(projectPath, layerId);
  return {
    id: full.id,
    createdAt: full.createdAt,
    currentRevisionId: full.currentRevisionId,
    currentRevision: full.currentRevision,
  };
}

/** Inspect a specific Layer in a Project (acquires Project lock for consistent snapshot). */
export async function inspectLayer(projectPath: string, layerId: string): Promise<ResolvedLayer> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, () => readLayerInternal(resolvedRoot, layerId));
}

/** List all Layers in a Project. */
export async function listLayers(projectPath: string): Promise<ResolvedLayer[]> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, async () => {
    const layersDir = path.join(resolvedRoot, "layers");
    const entries = await readdir(layersDir);
    const layerFiles = entries.filter((f) => f.endsWith(".json"));

    const layers: ResolvedLayer[] = [];
    for (const file of layerFiles) {
      const layerId = path.basename(file, ".json");
      const resolved = await readLayerInternal(resolvedRoot, layerId);
      layers.push(resolved);
    }
    return layers;
  });
}

export interface EditLayerOptions {
  inPlace?: boolean;
  /** Explicit fork intent (#85): publish a new Layer identity for one Composition use. */
  fork?: boolean;
  /** Fork target Composition (required with `fork`). */
  composition?: string;
  /** Fork target use local name (required with `fork`). */
  use?: string;
  image?: string;
  text?: string;
  font?: string;
  /**
   * Use a caller-supplied font file (#232, spec #226 US-005, DEC-006): a
   * path to a local TrueType/OpenType font. The bytes are read ONCE here,
   * their facts parsed from the file's own tables, and the file is retained
   * by content identity through the same path bundled faces use. Mutually
   * exclusive with `font` — one font source per edit. A later edit without
   * either option keeps the retained caller font; switching to a bundled
   * family or another file follows the existing carry-or-refuse rules for
   * weight and width.
   */
  fontFile?: string;
  fontSize?: number;
  color?: string;
  /**
   * Select the text look's weight (#179, ADR-0021): an ABSOLUTE setter
   * validated against the target face's real axis range (a `--font` edit's
   * new face, otherwise the Layer's retained font resolved by its content
   * hash — if the retained bytes match no bundled face, `--font` is
   * required). A variable face stores the resolved axes; a static face
   * accepts only its own weight and stores nothing. An omitted option
   * carries the current revision's axes across a font switch when the new
   * font supports them — nothing changes silently.
   */
  weight?: number;
  /**
   * Select the text look's width (#179/#196, ADR-0021): validated against
   * the face's `wdth` range on a variable face; a static face accepts only
   * its implicit width (100) or omission. Carries across a `--font` switch
   * the same way `weight` does.
   */
  width?: number;
  /**
   * Select the text's tracking in em (#187, ADR-0021): an ABSOLUTE setter,
   * font-independent — validated against the fixed allowed range (-0.5..1),
   * never against a face. `0` or `null` clears stored tracking (one stored
   * form per look: tracking 0 is never stored); an omitted option carries
   * the current value across any edit, including a `--font` switch.
   */
  tracking?: number | null;
  /**
   * Select the text's line height as a unitless multiplier (#187, ADR-0021):
   * an ABSOLUTE setter, font-independent — validated against the fixed
   * allowed range (0.5..3). `null` clears stored line height (the font's own
   * line height applies); an omitted option carries the current value across
   * any edit, including a `--font` switch.
   */
  lineHeight?: number | null;
  x?: number;
  y?: number;
  opacity?: number;
  /**
   * Resize by a relative scale factor (#133, ADR-0016): multiplies the
   * Layer's current canonical scale. Mutually exclusive with `resizeTo` and
   * with content-replacement options — resizing changes placement, never
   * retained pixels, and one edit carries one intent.
   */
  resizeFactor?: number;
  /**
   * Resize to an absolute effective size in px (#133, ADR-0016): image Layers
   * only (text has no intrinsic pixel size until measurement exists). One
   * omitted axis preserves the Layer's current aspect ratio (a deliberate
   * both-axes change survives); both axes deliberately change it. Normalized
   * to canonical scale here at the edit boundary; never stored as
   * authoritative fields.
   */
  resizeTo?: { width?: number; height?: number };
  /**
   * Set the Layer's canonical scale to an ABSOLUTE factor (#231, spec #226
   * US-004, DEC-005, ADR-0016): sets the Layer's canonical scale (uniform
   * both axes), replacing any previous scale — repeating the same command
   * keeps the same scale, never compounding (unlike the relative --resize
   * factor). Writes the one canonical scale representation; no second
   * scale field. Mutually exclusive with the other resize forms (--resize,
   * --resize-to) and with content-replacement options — the effective-size
   * cap check reads the retained content's intrinsic facts, so one edit
   * carries one intent.
   */
  scale?: number;
  /**
   * Rotate the Layer to an ABSOLUTE angle in degrees (#134, ADR-0016): sets
   * the Layer's canonical rotation, replacing any previous angle — repeating
   * the same command keeps the same angle, and 0 removes the rotation. Unlike
   * the relative resize factor this is never incremental. Rotation is
   * independent of the retained content's size, so it combines freely with
   * other edit options, including content replacement and resize.
   */
  rotateDeg?: number;
  /**
   * Flip the Layer to an ABSOLUTE reflection state (#135, ADR-0016): sets the
   * Layer's canonical reflection, replacing any previous state — `horizontal`
   * mirrors along the content's own vertical axis (left–right), `vertical`
   * along its horizontal axis (top–bottom), `both` mirrors both axes, and
   * `none` removes the reflection. Like rotation this is never incremental:
   * the same command twice keeps the same state. Flip is independent of the
   * retained content's size, so it combines freely with other edit options,
   * including content replacement and resize.
   */
  flip?: "horizontal" | "vertical" | "both" | "none";
  /**
   * Shape content options (#208, #209): parsed at the command boundary, and
   * on `layer edit` ABSOLUTE setters on a shape Layer (#209, spec #207
   * US-002) — each supplied option replaces that parameter, an omitted
   * parameter keeps its value, and the merged form validates through the
   * ONE shape-content validator. On image and text Layers every shape
   * option is refused naming kind stability. They exist in the option table
   * so `composition add` accepts them for shape content and the guard tests
   * can enumerate the full surface.
   */
  shape?: "rectangle" | "ellipse";
  size?: { width: number; height: number };
  cornerRadius?: number;
  fill?: LayerFill;
  /**
   * Apply a shadow to the Layer's content (#139, ADR-0018): an ABSOLUTE
   * setter that replaces any previous shadow — the same command twice keeps
   * the same shadow — and `"none"` removes it. The spec string is normalized
   * by `resolveEditShadow` against the current revision, so an omitted option
   * preserves the current revision's shadow. Independent of the retained
   * content's size, so it combines freely with other edit options including
   * content replacement and resize; it must not combine with --anchor, whose
   * resolution would see different ink than the edit publishes.
   */
  shadow?: string;
  /**
   * Apply an outline to the Layer's content (#140, ADR-0019): an ABSOLUTE
   * setter that replaces any previous outline — the same command twice keeps
   * the same outline — and `"none"` removes it. The spec string is
   * normalized by `resolveEditOutline` against the current revision, so an
   * omitted option preserves the current revision's outline. Independent of
   * the retained content's size, so it combines freely with other edit
   * options including content replacement and resize; it must not combine
   * with --anchor, whose resolution would see different ink than the edit
   * publishes.
   */
  outline?: string;
  /**
   * Set the Layer's rectangular visible region (#211, spec #207 US-003,
   * ADR-0023): an ABSOLUTE setter "<x>,<y>,<width>,<height>" in the Layer's
   * own content pixels, replacing any previous region — and "none" removes
   * it. The region is validated against the content box before anything is
   * staged: a region outside the content or with zero area is refused, and
   * an omitted option preserves the current revision's region. It must not
   * combine with content edits (content replacement, text content and
   * style, shape parameters) in one edit — the region is validated against
   * the content box, so those are separate edits — and not with --anchor,
   * whose resolution would see different ink than the edit publishes.
   */
  visibleRegion?: string;
  /**
   * Round the visible region's corners (#212, spec #207 US-003, ADR-0023):
   * an ABSOLUTE setter in px that edits and removes INDEPENDENTLY of the
   * rectangle — a positive value sets the radius, `0` or "none" removes it,
   * and an omitted option preserves the current radius (even when the
   * rectangle is re-set in the same edit). The radius rounds the region
   * rectangle it is set on: it obeys the ONE corner-radius rule the shape
   * Layer's --corner-radius ships (`validateRectangleCornerRadius`) — over
   * half the region rectangle's shorter side is REFUSED, never clamped — and
   * it needs a visible region: a radius on a Layer without one, or combined
   * with the region's removal, is refused before anything is staged.
   * Removing the region removes its radius with it (one revision fact).
   */
  visibleRegionRadius?: string;
  /**
   * Paint a vector image Layer's shape in one colour (#215, spec #207 US-005,
   * DEC-008): an ABSOLUTE setter that replaces any previous colour — the
   * same command twice keeps the same colour — and "none" removes it,
   * restoring the authored colours byte-identically (absence IS the
   * no-colour form). The colour takes the ONE fill-colour grammar
   * (parseFillColorSpec — #RGB/#RRGGBB/#RRGGBBAA, alpha allowed). Defined
   * for vector (format svg) image Layers only: refused on raster image,
   * text, and shape Layers before anything is staged, naming each kind's
   * own colour control (--color / --fill). When the same edit replaces
   * content (--image/--from-generation/--from-matte), the refusal reads the
   * NEW content's format. Combines freely with the transform, effect, and
   * region options; the retained bytes never change.
   */
  vectorColor?: string;
  /**
   * Generated-content ingestion (#107): explicitly replace an image Layer's
   * content with one selected output of a Generation Job, retaining the job's
   * provenance with the Project. Mutually exclusive with `image`; only valid
   * on image Layers (kind stability applies unchanged).
   */
  fromGeneration?: GenerationOutputSelection & { jobRoot: string; jobId: string };
  /**
   * Matting-content ingestion (#108): explicitly replace an image Layer's
   * content with the verified output of a published matte, retaining the
   * matte's provenance — and, derived from the source identity, any
   * predecessor generation provenance — with the Project. Mutually exclusive
   * with `image` and `fromGeneration`; only valid on image Layers (kind
   * stability applies unchanged). No engine runs and nothing generates.
   */
  fromMatte?: { matteRoot: string; matteId: string; generationRoot: string };
}

/** Canonical normalized edit intent (#85, DEC-003): the only shape the edit
 * lifecycle branches on. Normalized once at the entry of the edit path. */
type EditIntent =
  | { mode: "in-place" }
  | { mode: "fork"; composition: string; use: string };

/** Normalize and validate external edit intent into the canonical shape.
 * Flag misuse reaches here as a fail-fast guard; the CLI classifies the same
 * misuse as a usage error (exit 2) before invoking the edit. */
function normalizeEditIntent(options: EditLayerOptions): EditIntent {
  if (options.fork) {
    if (options.inPlace) {
      throw new Error("--fork and --in-place are mutually exclusive edit intents.");
    }
    if (!options.composition || options.composition.trim() === "") {
      throw new Error("Fork editing requires --composition <comp>: the Composition whose use is retargeted.");
    }
    if (!options.use || options.use.trim() === "") {
      throw new Error("Fork editing requires --use <local-name>: the use in the target Composition to retarget.");
    }
    return { mode: "fork", composition: options.composition, use: options.use };
  }
  if (options.composition !== undefined || options.use !== undefined) {
    throw new Error("--composition and --use are only valid together with --fork.");
  }
  return { mode: "in-place" };
}

export interface ForkInfo {
  previousLayerId: string;
  composition: string;
  use: string;
}

export interface EditLayerResult {
  layer: ResolvedLayer;
  referringCompositions: string[];
  referrersCount: number;
  /** Present only when the edit published a fork. */
  fork?: ForkInfo;
  /**
   * Present when the edit resized the Layer (#133): the absolute effective
   * scale (auditable across repeated relative resizes) and, for image Layers,
   * the absolute effective size in px. The scale is always reported; the
   * effective pixel size for text Layers awaits read-only measurement.
   */
  resized?: { scaleX: number; scaleY: number; width?: number; height?: number };
  /** Present when the edit rotated the Layer (#134): the absolute rotation in
   * degrees now recorded on the revision. */
  rotated?: { rotationDeg: number };
  /** Present when the edit flipped the Layer (#135): the absolute reflection
   * state now recorded on the revision. */
  flipped?: { flip: "horizontal" | "vertical" | "both" | "none" };
  /** Present when the edit set or removed the shadow (#139): the absolute
   * shadow state now recorded on the revision (null when removed). */
  shadowed?: { shadow: LayerShadow | null };
  /** Present when the edit set or removed the outline (#140): the absolute
   * outline state now recorded on the revision (null when removed). */
  outlined?: { outline: LayerOutline | null };
  /** Present when the edit set or removed the visible region (#211): the
   * absolute region state now recorded on the revision (null when removed). */
  regionSet?: { visibleRegion: LayerVisibleRegion | null };
  /** Present when a content edit KEPT the previous revision's visible
   * region and it still lies inside the new content box (#211, review
   * PROD-1): the kept region now frames the replaced content — a compact
   * stderr note reports it, and a region that no longer fits is refused
   * before publication instead. */
  regionCarried?: { visibleRegion: LayerVisibleRegion };
  /** Present when the edit set or removed the vector colour (#215): the
   * absolute colour state now recorded on the revision (null when removed). */
  vectorColorSet?: { vectorColor: string | null };
  /** Present only when the edit ingested generated content (#107). */
  generatedFrom?: { jobId: string; contentHash: string };
  /** Present only when the edit ingested matted content (#108). */
  mattedFrom?: { matteId: string; engine: string; contentHash: string };
  /** Present only when a shape edit dropped a carried corner radius: a
   * geometry switch to ellipse has no place for the rectangle fact, so the
   * edit reports exactly what it dropped for operator visibility (#209,
   * review PROD-5). */
  shapeEdited?: { droppedCornerRadius: number };
}

/**
 * Unlocked internal scanner that discovers all Compositions in the Project
 * referencing a given Layer identity. Callers must hold the Project lock.
 *
 * Scans every composition JSON file in compositions/ using the canonical
 * parseCompositionDocument. Fails closed immediately if any Composition
 * document in the Project is unreadable or malformed, ensuring sharing is
 * never falsely assumed absent. Returns a sorted list of unique Composition
 * names.
 */
export async function findLayerReferrersInternal(
  projectPath: string,
  layerId: string,
): Promise<string[]> {
  const resolvedRoot = path.resolve(projectPath);
  const compDir = path.join(resolvedRoot, "compositions");

  if (outsideDir(resolvedRoot, compDir) || (await escapesDirReal(resolvedRoot, compDir))) {
    throw new Error("Security error: compositions directory escapes project boundary.");
  }

  let entries: string[];
  try {
    entries = await readdir(compDir);
  } catch (err) {
    throw new Error(`Cannot read compositions directory: ${(err as Error).message}`);
  }

  const compFiles = entries.filter((f) => f.endsWith(".json")).sort();
  const referringCompositions: string[] = [];

  for (const file of compFiles) {
    const compName = path.basename(file, ".json");
    const compFile = path.join(compDir, file);

    if (outsideDir(resolvedRoot, compFile) || (await escapesDirReal(resolvedRoot, compFile))) {
      throw new Error(`Security error: composition "${compName}" escapes project boundary.`);
    }

    let raw: string;
    try {
      raw = await readFile(compFile, "utf8");
    } catch (err) {
      throw new Error(`Cannot read composition document "${compName}": ${(err as Error).message}`);
    }

    // Fail closed: if ANY composition is malformed, reject immediately
    const comp = parseCompositionDocument(raw, compName);

    if (comp.layers.some((use) => use.layerId === layerId)) {
      referringCompositions.push(compName);
    }
  }

  return referringCompositions;
}

/**
 * Discover all Compositions referencing a Layer (acquires Project lock for consistent snapshot).
 */
export async function findLayerReferrers(projectPath: string, layerId: string): Promise<string[]> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, () => findLayerReferrersInternal(resolvedRoot, layerId));
}

/** Placement values for an edited revision: explicit options win, omitted values preserve the current revision. */
function resolveEditPlacement(options: EditLayerOptions, prevRev: LayerRevision): { x: number; y: number; opacity: number } {
  const x = options.x !== undefined ? options.x : prevRev.x;
  const y = options.y !== undefined ? options.y : prevRev.y;
  const opacity = options.opacity !== undefined ? options.opacity : prevRev.opacity;

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Invalid placement (${options.x}, ${options.y}): x and y must be finite numbers.`);
  }
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new Error(`Invalid opacity ${options.opacity}: must be a finite number between 0 and 1.`);
  }
  return { x, y, opacity };
}

/**
 * Canonical rotation normalization (#134, ADR-0016): `--rotate` sets an
 * ABSOLUTE angle in degrees, replacing any previous rotation. Omitted option
 * preserves the current revision's rotation. The refusal runs before any
 * staging, so an invalid angle never advances live state. Exported as the
 * ONE rotation path for one-command `composition add` too (#229, DEC-001).
 */
export function resolveEditRotation(options: EditLayerOptions, prevRev: ResolvedLayerRevision): number {
  if (options.rotateDeg === undefined) {
    return prevRev.rotationDeg;
  }
  const deg = options.rotateDeg;
  if (!Number.isFinite(deg)) {
    throw new Error(`Invalid rotation ${deg}: --rotate takes a finite number of degrees (clockwise positive).`);
  }
  return deg;
}

/**
 * Canonical reflection normalization (#135, ADR-0016): `--flip` sets an
 * ABSOLUTE reflection state, replacing any previous one. Omitted option
 * preserves the current revision's reflection. The refusal runs before any
 * staging, so an invalid mode never advances live state. Exported as the
 * ONE reflection path for one-command `composition add` too (#229, DEC-001).
 */
export function resolveEditFlip(options: EditLayerOptions, prevRev: ResolvedLayerRevision): LayerTransformFlip {
  if (options.flip === undefined) {
    return { flipX: prevRev.flipX, flipY: prevRev.flipY };
  }
  switch (options.flip) {
    case "horizontal":
      return { flipX: true, flipY: false };
    case "vertical":
      return { flipX: false, flipY: true };
    case "both":
      return { flipX: true, flipY: true };
    case "none":
      return { flipX: false, flipY: false };
    default:
      throw new Error(
        `Invalid flip "${String(options.flip)}": --flip takes horizontal, vertical, both, or none.`,
      );
  }
}

/**
 * Canonical shadow normalization (#139, ADR-0018): `--shadow` sets an ABSOLUTE
 * shadow, replacing any previous one; `"none"` removes it. Omitted option
 * preserves the current revision's shadow. Every refusal runs before any
 * staging, so an invalid shadow never advances live state. Exported for the
 * CLI boundary: the command classifies malformed specs as usage errors
 * (exit 2) with this same parser, so the two never disagree.
 */
export function parseShadowSpec(spec: string): LayerShadow | undefined {
  const raw = spec.trim();
  if (raw.toLowerCase() === "none") {
    return undefined;
  }
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== 4) {
    throw new Error(
      `Invalid shadow "${raw}": --shadow takes "<dx>,<dy>,<blur>,<color>" (e.g. "10,10,4,#000000") or "none".`,
    );
  }
  const [dxRaw, dyRaw, blurRaw, colorRaw] = parts;
  const dx = Number(dxRaw);
  const dy = Number(dyRaw);
  const blur = Number(blurRaw);
  const color = colorRaw ?? "";
  if (dxRaw === "" || dyRaw === "" || blurRaw === "" || color === "") {
    throw new Error(
      `Invalid shadow "${raw}": --shadow takes "<dx>,<dy>,<blur>,<color>" (e.g. "10,10,4,#000000") or "none".`,
    );
  }
  for (const [label, value] of [["dx", dx], ["dy", dy]] as const) {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_SHADOW_OFFSET_PX) {
      throw new Error(
        `Invalid shadow offset ${label} ${dxRaw}: must be a finite number of px within ±${MAX_SHADOW_OFFSET_PX}.`,
      );
    }
  }
  if (!Number.isFinite(blur) || blur < 0 || blur > MAX_SHADOW_BLUR_PX) {
    throw new Error(
      `Invalid shadow blur ${blurRaw}: must be a finite number of px between 0 and ${MAX_SHADOW_BLUR_PX}.`,
    );
  }
  if (!EFFECT_COLOR_PATTERN.test(color)) {
    throw new Error(
      `Invalid shadow color "${color}": must be a hex color like #000000, #000, or #00000080.`,
    );
  }
  return { dx, dy, blur, color: canonicalizeEffectColor(color) };
}

/**
 * Canonical outline normalization (#140, ADR-0019): `--outline` sets an
 * ABSOLUTE outline, replacing any previous one; `"none"` removes it. The
 * spec is "<width>,<color>" with width in px (0..256) and the same hex
 * color forms as the shadow, canonicalized by the same INT-2 rule. Exported
 * for the CLI boundary: the command classifies malformed specs as usage
 * errors (exit 2) with this same parser, so the two never disagree.
 */
export function parseOutlineSpec(spec: string): LayerOutline | undefined {
  const raw = spec.trim();
  if (raw.toLowerCase() === "none") {
    return undefined;
  }
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== 2) {
    throw new Error(
      `Invalid outline "${raw}": --outline takes "<width>,<color>" (e.g. "4,#000000") or "none".`,
    );
  }
  const [widthRaw, colorRaw] = parts;
  const width = Number(widthRaw);
  const color = colorRaw ?? "";
  if (widthRaw === "" || color === "") {
    throw new Error(
      `Invalid outline "${raw}": --outline takes "<width>,<color>" (e.g. "4,#000000") or "none".`,
    );
  }
  if (!Number.isFinite(width) || width < 0 || width > MAX_OUTLINE_WIDTH_PX) {
    throw new Error(
      `Invalid outline width ${widthRaw}: must be a finite number of px between 0 and ${MAX_OUTLINE_WIDTH_PX}.`,
    );
  }
  if (!EFFECT_COLOR_PATTERN.test(color)) {
    throw new Error(
      `Invalid outline color "${color}": must be a hex color like #000000, #000, or #00000080.`,
    );
  }
  return { width, color: canonicalizeEffectColor(color) };
}

/**
 * Canonical vector-colour normalization (#215, spec #207 US-005, DEC-008/009):
 * `--vector-color` sets an ABSOLUTE colour, replacing any previous one;
 * `"none"` removes it. Omitted option preserves the current revision's
 * colour. The colour grammar is the ONE fill-colour ingestion point
 * (`parseFillColorSpec` over `parseFillSpec` in src/fill.ts — #RGB/#RRGGBB/
 * #RRGGBBAA, alpha first-class, canonicalized once); no second colour
 * parser exists. Exported for the CLI boundary: the command classifies
 * malformed specs as usage errors (exit 2) with this same parser, so the
 * two never disagree. The kind/format refusals (raster image, text, shape)
 * are semantic — they read live state — and live in
 * `resolveEditVectorColor` / the one-command application path.
 */
export function parseVectorColorSpec(spec: string): string | undefined {
  const raw = spec.trim();
  if (raw.toLowerCase() === "none") {
    return undefined;
  }
  return parseFillColorSpec(raw, "vector colour");
}

/**
 * The one kind/format refusal wording for the vector colour (#215): the
 * setter is refused on every non-vector Layer, naming the kind's own colour
 * control — text Layers take their colour through `--color`, shape Layers
 * through `--fill`, and a raster image Layer's colours are its retained
 * pixels (the vector colour paints a vector's shape over its alpha).
 * Shared by the edit path and the one-command add path, so the two surfaces
 * can never disagree.
 */
export function vectorColorKindRefusal(
  kind: "text" | "shape" | "raster",
  layerId: string,
  format?: string,
): string {
  if (kind === "text") {
    return `Cannot set a vector colour on a text Layer. Layer "${layerId}" is a text Layer — text takes its colour through --color.`;
  }
  if (kind === "shape") {
    return `Cannot set a vector colour on a shape Layer. Layer "${layerId}" is a shape Layer — a shape's colour is its fill, set through --fill.`;
  }
  return (
    `Cannot set a vector colour on a raster image Layer. Layer "${layerId}" is a raster image Layer` +
    (format !== undefined ? ` (format ${format})` : "") +
    ` — a vector colour paints a vector (format svg) over its alpha; a raster's colours are its retained pixels.`
  );
}

/** Field-wise shadow equality for the no-op check (#139): the flip
 * precedent — re-issuing an identical shadow is a detected no-op, never a
 * redundant revision. */
function shadowEq(a: LayerShadow | undefined, b: LayerShadow | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.dx === b.dx && a.dy === b.dy && a.blur === b.blur && a.color === b.color;
}

/** Caller font facts equality (#232): both sides are normalized facts
 *  objects (fixed key order from their constructors), so a structural
 *  comparison is a serialized comparison. */
function callerFontEq(a: CallerFontFacts | undefined, b: CallerFontFacts | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Canonical shadow edit resolution (#139, ADR-0018): an omitted option
 * preserves the current revision's shadow; a spec sets or removes it
 * absolutely. The refusal runs before any staging, so an invalid shadow
 * never advances live state.
 */
function resolveEditShadow(options: EditLayerOptions, prevRev: ResolvedLayerRevision): LayerShadow | undefined {
  if (options.shadow === undefined) {
    return prevRev.shadow;
  }
  return parseShadowSpec(options.shadow);
}

/** Field-wise outline equality for the no-op check (#140): the flip
 * precedent — re-issuing an identical outline is a detected no-op, never a
 * redundant revision. */
function outlineEq(a: LayerOutline | undefined, b: LayerOutline | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.width === b.width && a.color === b.color;
}

/**
 * Canonical outline edit resolution (#140, ADR-0019): an omitted option
 * preserves the current revision's outline; a spec sets or removes it
 * absolutely. The refusal runs before any staging, so an invalid outline
 * never advances live state.
 */
function resolveEditOutline(options: EditLayerOptions, prevRev: ResolvedLayerRevision): LayerOutline | undefined {
  if (options.outline === undefined) {
    return prevRev.outline;
  }
  return parseOutlineSpec(options.outline);
}

/**
 * Canonical visible-region normalization (#211, spec #207 US-003, ADR-0023):
 * `--visible-region` sets an ABSOLUTE region rectangle —
 * "<x>,<y>,<width>,<height>" in the Layer's own content pixels, relative to
 * the content box's top-left — replacing any previous one; "none" removes
 * it. Every refusal runs before any staging, so an invalid region never
 * advances live state. Exported for the CLI boundary: the command
 * classifies malformed specs as usage errors (exit 2) with this same
 * parser, so the two never disagree. Content-bounds conformance (a region
 * outside the content is refused) is the edit path's job, against the
 * content box the region is set on — this parser only judges the spec's own
 * shape: finite `x`/`y` ≥ 0 and finite positive `width`/`height` (a
 * zero-area region is refused here, before any content box is consulted).
 */
export function parseVisibleRegionSpec(spec: string): LayerVisibleRegion | undefined {
  const raw = spec.trim();
  if (raw.toLowerCase() === "none") {
    return undefined;
  }
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== 4) {
    throw new Error(
      `Invalid visible region "${raw}": --visible-region takes "<x>,<y>,<width>,<height>" in the Layer's own content px (e.g. "120,80,640,360") or "none".`,
    );
  }
  const [xRaw, yRaw, widthRaw, heightRaw] = parts;
  const x = Number(xRaw);
  const y = Number(yRaw);
  const width = Number(widthRaw);
  const height = Number(heightRaw);
  if (xRaw === "" || yRaw === "" || widthRaw === "" || heightRaw === "") {
    throw new Error(
      `Invalid visible region "${raw}": --visible-region takes "<x>,<y>,<width>,<height>" in the Layer's own content px (e.g. "120,80,640,360") or "none".`,
    );
  }
  for (const [label, value, rawValue] of [["x", x, xRaw], ["y", y, yRaw]] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `Invalid visible region ${label} ${rawValue}: must be a finite number of px >= 0.`,
      );
    }
  }
  for (const [label, value, rawValue] of [["width", width, widthRaw], ["height", height, heightRaw]] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `Invalid visible region ${label} ${rawValue}: must be a finite number of px greater than 0 — a zero-area region shows nothing.`,
      );
    }
  }
  return { x, y, width, height };
}

/**
 * The one visible-region corner-radius spec parser (#212, spec #207 US-003,
 * ADR-0023): the spec's own shape only — "none" resolves to undefined (the
 * removal value, the #211 region convention), 0 is the no-rounding form that
 * stores nothing, and anything else must be a finite number of px >= 0 (a
 * negative radius is refused here, before publication). Range conformance —
 * a radius over half the region rectangle's shorter side is REFUSED, never
 * clamped (the shape Layer's one rule) — is the edit path's job, against the
 * region rectangle the radius rounds. Exported for the CLI boundary: the
 * command classifies malformed specs as usage errors (exit 2) with this same
 * parser, so the two never disagree.
 */
export function parseVisibleRegionRadiusSpec(spec: string): number | undefined {
  const raw = spec.trim();
  if (raw.toLowerCase() === "none") {
    return undefined;
  }
  const value = Number(raw);
  if (raw === "" || !Number.isFinite(value)) {
    throw new Error(
      `Invalid visible-region corner radius "${raw}": --visible-region-radius takes a radius in px (e.g. "12"), 0 to remove, or "none" — ` +
        `the radius rounds the visible region's corners.`,
    );
  }
  if (value < 0) {
    throw new Error(
      `Invalid visible-region corner radius ${raw}: must be a finite number of px >= 0 — a negative radius has no meaning.`,
    );
  }
  return value;
}

/** Field-wise visible-region equality for the no-op check (#211): the flip
 * precedent — re-issuing an identical region is a detected no-op, never a
 * redundant revision. */
function visibleRegionEq(a: LayerVisibleRegion | undefined, b: LayerVisibleRegion | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height &&
    a.cornerRadius === b.cornerRadius;
}

/**
 * The one content-bounds check for a set visible region (#211, ADR-0023):
 * a region must lie inside the content box of the Layer it is set on —
 * outside content or past the box's far edge is refused, naming the fault
 * and the content box. The region is in the Layer's own content pixels;
 * for image and shape Layers that box is the revision's intrinsic facts,
 * and for a text Layer the measured line-box extent of the SAME content
 * the edit would publish (the edit path refuses combining the region with
 * content edits, so that is always the live revision's box).
 */
export function validateVisibleRegionAgainstContent(
  region: LayerVisibleRegion,
  content: { width: number; height: number },
  layerId: string,
): void {
  if (region.x + region.width > content.width || region.y + region.height > content.height) {
    throw new Error(
      `Invalid visible region (${region.x}, ${region.y}, ${region.width}, ${region.height}) on Layer "${layerId}": ` +
        `the region must lie inside the Layer's ${content.width}×${content.height}px content box — a region outside the content shows nothing and is refused before publication.`,
    );
  }
}

/**
 * The content-edit re-validation for a region KEPT across a content edit
 * (#211 review PROD-1): the region is validated against the content box, so
 * an edit that replaces or reshapes the content re-validates the kept
 * region against the NEW box before anything is published — a region that
 * no longer lies inside is refused (US-003: a region outside the content is
 * refused), naming the fix; one that still fits publishes with the
 * `regionCarried` report, so the operator hears that the kept region now
 * frames the replaced content.
 */
function validateKeptVisibleRegion(
  region: LayerVisibleRegion,
  content: { width: number; height: number },
  layerId: string,
): void {
  if (region.x + region.width > content.width || region.y + region.height > content.height) {
    throw new Error(
      `Invalid kept visible region (${region.x}, ${region.y}, ${region.width}, ${region.height}) on Layer "${layerId}": ` +
        `this edit changes the Layer's content box to ${content.width}×${content.height}px and the region no longer lies inside it. ` +
        `Adjust (--visible-region "<x>,<y>,<width>,<height>") or remove (--visible-region none) the region in its own edit, then replace the content.`,
    );
  }
}

/**
 * The options --visible-region cannot combine with in one edit (#211): the
 * region is validated against the content box, so anything that replaces
 * or reshapes the content — content replacement, the text content and its
 * style options, and the shape parameters — is a separate edit (the same
 * one-intent-per-edit precedent as --size with the resize forms). It
 * combines freely with placement, the canonical transform, and the effects.
 */
const REGION_CONFLICTING_OPTION_PRESENT = (options: EditLayerOptions): boolean =>
  options.image !== undefined ||
  options.fromGeneration !== undefined ||
  options.fromMatte !== undefined ||
  options.text !== undefined ||
  options.font !== undefined ||
  options.fontFile !== undefined ||
  options.fontSize !== undefined ||
  options.color !== undefined ||
  options.weight !== undefined ||
  options.width !== undefined ||
  options.tracking !== undefined ||
  options.lineHeight !== undefined ||
  options.shape !== undefined ||
  options.size !== undefined ||
  options.cornerRadius !== undefined ||
  options.fill !== undefined;

/**
 * Canonical vector-colour edit resolution (#215, spec #207 US-005, DEC-008):
 * an omitted option preserves the current revision's colour; a spec sets or
 * removes it absolutely. The removal form ("none") is the established
 * idempotent no-op on EVERY kind (the same removal precedents --shadow none
 * and --flip none have: removing nothing needs no kind gate), so the kind
 * and raster refusals fire only for a SET — before anything is staged,
 * before any content ingestion. The raster gate reads the format of the
 * content the edit would publish: the live revision's when no content is
 * replaced, the ingested replacement's otherwise (checked in
 * buildEditedRevision, still before anything is stored).
 */
function resolveEditVectorColor(
  options: EditLayerOptions,
  prevRev: ResolvedLayerRevision,
  layerId: string,
): { given: boolean; value: string | undefined } {
  if (options.vectorColor === undefined) {
    return { given: false, value: prevRev.kind === "image" ? prevRev.vectorColor : undefined };
  }
  const value = parseVectorColorSpec(options.vectorColor);
  // The removal form is the idempotent no-op every other absolute setter's
  // "none" is: it removes nothing on a Layer without the fact and never
  // hits a kind gate — the parameter's refusals are about SETTING a colour.
  if (value === undefined) {
    return { given: true, value: undefined };
  }
  if (prevRev.kind === "text") {
    throw new Error(vectorColorKindRefusal("text", layerId));
  }
  if (prevRev.kind === "shape") {
    throw new Error(vectorColorKindRefusal("shape", layerId));
  }
  const contentReplaced =
    options.image !== undefined || options.fromGeneration !== undefined || options.fromMatte !== undefined;
  if (!contentReplaced && prevRev.format !== "svg") {
    throw new Error(vectorColorKindRefusal("raster", layerId, prevRev.format));
  }
  return { given: true, value };
}

/**
 * The one vector-colour raster gate for a content replacement (#215): the
 * published content's format decides. A colour SET alongside the
 * replacement refuses naming the raster contract; a colour CARRIED across
 * a replacement to raster content refuses naming the fix (remove it first,
 * or keep the vector) — the fact has no meaning on raster pixels, and
 * silently painting the replacement solid would defeat the setter's own
 * refusal. The removal form (value undefined) passes everywhere.
 */
function vectorColorRasterGate(
  vectorColor: { given: boolean; value: string | undefined },
  format: "png" | "jpeg" | "webp" | "svg",
  layerId: string,
): void {
  if (format === "svg" || vectorColor.value === undefined) {
    return;
  }
  if (vectorColor.given) {
    throw new Error(vectorColorKindRefusal("raster", layerId, format));
  }
  throw new Error(
    `Cannot replace the content of Layer "${layerId}" with raster pixels (format ${format}) while it carries ` +
      `a vector colour (${vectorColor.value}): the vector colour paints a vector (format svg) over its alpha. ` +
      `Remove the colour first (--vector-color none), or keep the content a vector file.`,
  );
}

/**
 * Canonical visible-region edit resolution (#211, ADR-0023; #212 radius):
 * an omitted option preserves the current revision's region; a spec sets or
 * removes it absolutely. A set region validates against the content box of
 * the Layer it is set on — the revision's intrinsic facts for image and
 * shape, and the measured line-box extent for text (the unwrapped standalone
 * line, measured from the in-memory snapshot — never a second Project read).
 * The optional corner radius (#212) resolves on the SAME fact, independently
 * of the rectangle: a radius-only edit keeps the rectangle and re-validates
 * the radius against it; a rectangle re-set keeps the current radius (an
 * omitted radius option preserves it, re-validated against the NEW
 * rectangle); `none`/`0` remove the radius. Every refusal runs before any
 * staging, so an invalid region or radius never advances live state.
 */
async function resolveEditVisibleRegion(
  resolvedRoot: string,
  options: EditLayerOptions,
  prevRev: ResolvedLayerRevision,
  contentBytes: Buffer,
  layerId: string,
): Promise<LayerVisibleRegion | undefined> {
  const rectGiven = options.visibleRegion !== undefined;
  const radiusGiven = options.visibleRegionRadius !== undefined;
  if (!rectGiven && !radiusGiven) {
    return prevRev.visibleRegion;
  }
  const radius = radiusGiven ? parseVisibleRegionRadiusSpec(options.visibleRegionRadius!) : undefined;
  const rect = rectGiven ? parseVisibleRegionSpec(options.visibleRegion!) : prevRev.visibleRegion;
  // A radius needs a region to round: a positive radius on a Layer without
  // one, or combined with the region's removal, is refused before anything
  // is staged. `none` — and 0, the no-rounding form — remove nothing: the
  // same idempotent removal the rectangle's `none` has, so the two removal
  // spellings agree even without a region.
  if (rect === undefined) {
    if (radius !== undefined && radius > 0) {
      throw new Error(
        rectGiven
          ? `Invalid visible-region corner radius ${options.visibleRegionRadius}: Layer "${layerId}" cannot set a corner radius while removing the visible region — a radius rounds a region's corners, so it needs a visible region. Remove the radius (--visible-region-radius none) or keep the region.`
          : `Invalid visible-region corner radius ${options.visibleRegionRadius}: Layer "${layerId}" has no visible region to round — set one first (--visible-region "<x>,<y>,<width>,<height>"), then round its corners.`,
      );
    }
    return undefined;
  }
  // The rectangle's content-bounds check runs only when the rectangle is
  // explicitly (re-)set, against the content box of the SAME content the
  // edit would publish — content edits are refused in one edit with the
  // region, so that is always the live revision's box; a text Layer's box is
  // its measured line-box extent (the unwrapped standalone line, the same
  // measurement authority anchored placement resolves an unreferenced Layer
  // against).
  if (rectGiven) {
    if (prevRev.kind === "text") {
      // A text Layer has no stored intrinsic size: its content box is the
      // DOM line-box extent of the retained face at this revision's settings,
      // measured through the one measurement authority (DEC-006) on the
      // already-resolved snapshot — the edit path holds the Project lock, so
      // the lock-free snapshot variant is the only safe way to measure here.
      const standalone = await measureStandaloneSnapshot({ ...prevRev, x: 0, y: 0 }, contentBytes);
      validateVisibleRegionAgainstContent(rect, standalone.content, layerId);
    } else {
      validateVisibleRegionAgainstContent(rect, { width: prevRev.width, height: prevRev.height }, layerId);
    }
  }
  // The radius (#212): an explicit value sets or removes it; an omitted
  // radius option preserves the current one — and a PRESERVED radius must
  // still fit the (possibly new) rectangle, the same refusal a re-issued
  // radius would get. 0 stores nothing (the same look as absent).
  const effectiveRadius = radiusGiven
    ? radius
    : rectGiven
      ? prevRev.visibleRegion?.cornerRadius
      : rect.cornerRadius;
  if (effectiveRadius !== undefined && effectiveRadius > 0) {
    validateRectangleCornerRadius(effectiveRadius, rect.width, rect.height);
  }
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    ...(effectiveRadius !== undefined && effectiveRadius > 0 ? { cornerRadius: effectiveRadius } : {}),
  };
}

/** Rendered effective size rounds to hundredths of a px: auditable display of the scale's effect. */
export function roundEffective(px: number): number {
  return Math.round(px * 100) / 100;
}

/**
 * Canonical resize normalization (#133, ADR-0016): scale factors are the one
 * authoritative transform representation; width/height conveniences become
 * scale here at the edit boundary, against the retained content's intrinsic
 * size. Every refusal runs before any staging, so an invalid or conflicting
 * resize never advances live state.
 *
 * Omitted resize options preserve the current revision's scale. Aspect-ratio
 * rules: a relative factor preserves the current ratio by definition; an
 * absolute target with one omitted axis preserves the Layer's current aspect
 * ratio (a deliberate both-axes change survives, never reset to intrinsic);
 * both axes supplied deliberately change it.
 *
 * Exported as the ONE scale-resolution path for one-command `composition
 * add` too (#229, DEC-001/DEC-002): the add path calls it with the fresh
 * content's intrinsic facts at scale 1, so add's resize refusals, caps, and
 * aspect rules are byte-identical to the edit surface's by construction —
 * including the text-Layer refusal for --resize-to (identical wording).
 */
export function resolveEditScale(
  options: EditLayerOptions,
  prevRev: ResolvedLayerRevision,
  layerId: string,
): LayerTransformScale {
  const hasFactor = options.resizeFactor !== undefined;
  const hasTarget = options.resizeTo !== undefined;
  const hasScale = options.scale !== undefined;
  if (!hasFactor && !hasTarget && !hasScale) {
    return { scaleX: prevRev.scaleX, scaleY: prevRev.scaleY };
  }

  // The ONE resize-form exclusivity rule (#133, extended by #231 to the
  // absolute --scale setter): at most one of the three forms per edit. The
  // refusal runs before any staging, so a conflicting request never
  // advances live state.
  const formCount = [hasFactor, hasTarget, hasScale].filter(Boolean).length;
  if (formCount > 1) {
    if (hasFactor && hasTarget) {
      throw new Error("--resize and --resize-to are mutually exclusive resize forms: use one per edit.");
    }
    throw new Error(
      hasFactor && hasScale
        ? "--resize and --scale are mutually exclusive: use one resize form per edit (--resize is relative, --scale sets the absolute scale)."
        : "--resize-to and --scale are mutually exclusive: use one resize form per edit (--resize-to sets an absolute size, --scale sets the absolute scale).",
    );
  }
  const replacesContent =
    options.image !== undefined || options.fromGeneration !== undefined || options.fromMatte !== undefined;
  if (replacesContent) {
    throw new Error(
      hasScale
        ? `Scale and content replacement are separate edits: Layer "${layerId}" cannot replace its source and set --scale in one edit, because the effective-size cap reads the retained content's intrinsic size.`
        : `Resize and content replacement are separate edits: Layer "${layerId}" cannot replace its source and resize in one edit, because the resize reference size would be ambiguous.`,
    );
  }

  if (hasScale) {
    // Absolute scale setter (#231): the value IS the canonical scale, so
    // repeating the command is idempotent by construction. The same bounds
    // and effective-size cap the resize paths publish apply here.
    const scale = options.scale!;
    if (!Number.isFinite(scale) || scale <= 0 || scale > MAX_DIMENSION) {
      throw new Error(
        `Invalid scale ${scale}: must be a finite number between 0 and ${MAX_DIMENSION}.`,
      );
    }
    return boundedScale({ scaleX: scale, scaleY: scale }, prevRev, layerId);
  }

  if (hasFactor) {
    const factor = options.resizeFactor!;
    if (!Number.isFinite(factor) || factor <= 0 || factor > MAX_DIMENSION) {
      throw new Error(
        `Invalid resize factor ${factor}: must be a finite number between 0 and ${MAX_DIMENSION}.`,
      );
    }
    return boundedScale({ scaleX: prevRev.scaleX * factor, scaleY: prevRev.scaleY * factor }, prevRev, layerId);
  }

  if (prevRev.kind === "text") {
    throw new Error(
      `--resize-to needs an intrinsic pixel size: Layer "${layerId}" is a text Layer — use --resize <factor>.`,
    );
  }
  const { width, height } = options.resizeTo!;
  for (const [label, value] of [["width", width], ["height", height]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > MAX_DIMENSION)) {
      throw new Error(
        `Invalid resize target ${label} ${value}: must be a finite number between 0 and ${MAX_DIMENSION}.`,
      );
    }
  }
  if (width === undefined && height === undefined) {
    throw new Error("Invalid resize target: --resize-to needs at least one of width or height.");
  }
  let scaleX: number;
  let scaleY: number;
  if (width !== undefined && height !== undefined) {
    // Both axes supplied: the aspect change is deliberate, not accidental.
    scaleX = width / prevRev.width;
    scaleY = height / prevRev.height;
  } else if (width !== undefined) {
    // One axis supplied: preserve the Layer's CURRENT aspect ratio — a
    // deliberate both-axes change is explicitly kept, never silently reset
    // to the intrinsic ratio (#133, ADR-0016). For a uniform prior this is
    // exactly intrinsic-ratio preservation.
    scaleX = width / prevRev.width;
    scaleY = (scaleX * prevRev.scaleY) / prevRev.scaleX;
  } else {
    scaleY = height! / prevRev.height;
    scaleX = (scaleY * prevRev.scaleX) / prevRev.scaleY;
  }
  return boundedScale({ scaleX, scaleY }, prevRev, layerId);
}

/** Shared effective-size bound (#133): the scaled result shares the existing
 * content-dimension cap so no second constant exists. Refuses before staging.
 * A shape Layer's (#208) stored width/height are intrinsic pixel facts like
 * an image's, so the same effective-size bound applies. */
function boundedScale(
  scale: LayerTransformScale,
  prevRev: ResolvedLayerRevision,
  layerId: string,
): LayerTransformScale {
  if (prevRev.kind === "image" || prevRev.kind === "shape") {
    const width = roundEffective(prevRev.width * scale.scaleX);
    const height = roundEffective(prevRev.height * scale.scaleY);
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw new Error(
        `Resize result ${width}×${height}px is over the ${MAX_DIMENSION}px per-axis limit for Layer "${layerId}".`,
      );
    }
  } else if (scale.scaleX > MAX_DIMENSION || scale.scaleY > MAX_DIMENSION) {
    throw new Error(`Resize scale over the ${MAX_DIMENSION} limit for Layer "${layerId}".`);
  }
  return scale;
}

/**
 * Resolve the text axes an edit publishes (#179/#196, ADR-0021): the one
 * home for the edit semantics, layered on `resolveTextAxes`'s face
 * validation.
 *
 * - A variable target: the explicit control wins, otherwise the current
 *   revision's axes carry across the font switch, otherwise the face's
 *   default instance — then the pair validates against the face's real
 *   ranges.
 * - A static target: explicit controls replace the carried values before
 *   validation and validate through the same one validator — weight accepts
 *   only the face's own weight, width only its implicit width — so a
 *   variable-to-static switch works in one edit (#196). A still-carried
 *   axis the face cannot express (a different weight, or a width other
 *   than the implicit 100) conflicts with retained state and is refused
 *   naming the one-command fix: the explicit flags that resolve every
 *   remaining conflict in this same edit, built from the same accepted
 *   pair (`staticFaceAcceptedAxes`, the one home for that rule). A carried
 *   width-100 look carries as nothing-to-store. Either way the revision
 *   stores no axis fields.
 */
function resolveEditTextAxes(
  face: FontFace,
  options: EditLayerOptions,
  prevRev: LayerTextRevision,
): TextAxes {
  if (face.variant === "variable") {
    return resolveTextAxes(face, {
      weight: options.weight ?? prevRev.weight,
      width: options.width ?? prevRev.width,
    });
  }
  const accepted = staticFaceAcceptedAxes(face);
  const axes = resolveTextAxes(face, {
    ...(options.weight !== undefined ? { weight: options.weight } : {}),
    ...(options.width !== undefined ? { width: options.width } : {}),
  });
  const carriedWeight = options.weight !== undefined ? undefined : prevRev.weight;
  const carriedWidth = options.width !== undefined ? undefined : prevRev.width;
  const conflicts: string[] = [];
  const fix: string[] = [];
  if (carriedWeight !== undefined && carriedWeight !== accepted.weight) {
    conflicts.push(`weight ${carriedWeight}`);
    fix.push(`--weight ${accepted.weight}`);
  }
  if (carriedWidth !== undefined && carriedWidth !== accepted.width) {
    conflicts.push(`width ${carriedWidth}`);
    fix.push(`--width ${accepted.width}`);
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Font "${face.family}" is a static face at weight ${accepted.weight} — the current ${conflicts.join(" and ")} cannot be kept; add ${fix.join(" ")}.`,
    );
  }
  return axes;
}

/**
 * Canonical edited-revision construction shared by in-place and fork editing
 * (#85): one home for kind stability, content ingestion/validation, and
 * field preservation, so no publication path can build a divergent revision.
 *
 * Returns the fully formed revision document for `layerId`/`createdAt` plus
 * whether every field is identical to the current revision. In-place editing
 * uses `unchanged` to skip storage churn; fork ignores it because an explicit
 * fork always publishes a new identity, even with unchanged content.
 */
async function buildEditedRevision(
  resolvedRoot: string,
  prevRev: ResolvedLayerRevision,
  layerId: string,
  createdAt: string,
  options: EditLayerOptions,
  placement: { x: number; y: number; opacity: number },
  scale: LayerTransformScale,
  rotationDeg: number,
  flip: LayerTransformFlip,
  shadow: LayerShadow | undefined,
  outline: LayerOutline | undefined,
  visibleRegion: LayerVisibleRegion | undefined,
  /** The vector-colour resolution (#215): { given, value } — `given` drives
   * the edit report, `value` is the canonical colour to store (undefined
   * when absent or removed). The kind gates already ran in
   * resolveEditVectorColor; the raster gate for a same-edit content
   * replacement runs here against the ingested format, before any store. */
  vectorColor: { given: boolean; value: string | undefined },
  /** The previous revision's verified content bytes (#211 review PROD-1):
   * the text branch measures the resulting revision's standalone line box
   * with the bytes the NEW revision pins (the previous bytes when no font
   * edit runs), re-validating a kept region against the new extent. */
  prevContentBytes: Buffer,
): Promise<{
  revision: LayerRevision;
  unchanged: boolean;
  /** Present when this edit ingested matted content (#108). */
  mattedFrom?: EditLayerResult["mattedFrom"];
  /** Present when the ingested matte's source was a retained generation output (#108). */
  retainedGeneration: RetainedGenerationProvenance | null;
  /** Present only when a shape edit dropped a carried corner radius
   * (review PROD-5): the geometry switch to ellipse has no place for the
   * carried rectangle fact. */
  shapeEdited?: EditLayerResult["shapeEdited"];
  /** Present when a content edit kept the previous revision's visible
   * region and it still lies inside the new content box (#211 review
   * PROD-1): the kept region now frames the replaced content. */
  regionCarried?: EditLayerResult["regionCarried"];
}> {
  const { x, y, opacity } = placement;

  // Shape content options (#209, spec #207 US-002): each parameter is an
  // ABSOLUTE setter on a shape Layer; on image and text Layers every shape
  // option is refused naming kind stability — a Layer's kind is stable
  // across edits (US-002 bullet 2), so a shape cannot become image or text
  // and the reverse. The refusal runs before any kind branch, before
  // anything is staged.
  if (
    options.shape !== undefined ||
    options.size !== undefined ||
    options.cornerRadius !== undefined ||
    options.fill !== undefined
  ) {
    if (prevRev.kind !== "shape") {
      const kindPhrase = prevRev.kind === "image" ? "an image Layer" : "a text Layer";
      throw new Error(
        `Cannot edit shape parameters on ${kindPhrase}. Layer "${layerId}" is ${kindPhrase} — a Layer's kind is stable across edits; add a shape Layer instead.`,
      );
    }
  }

  if (prevRev.kind === "image") {
    // Incompatible text options passed to image layer
    if (
      options.text !== undefined ||
      options.font !== undefined ||
      options.fontFile !== undefined ||
      options.fontSize !== undefined ||
      options.color !== undefined ||
      options.weight !== undefined ||
      options.width !== undefined ||
      options.tracking !== undefined ||
      options.lineHeight !== undefined
    ) {
      throw new Error(`Cannot edit text attributes on an image Layer. Layer "${layerId}" is an image Layer.`);
    }

    let contentHash = prevRev.contentHash;
    let mattedFrom: EditLayerResult["mattedFrom"];
    let retainedGeneration: RetainedGenerationProvenance | null = null;
    // A region KEPT across a content edit (#211 review PROD-1): the region
    // is validated against the content box, so a content replacement
    // re-validates the kept region against the NEW content's intrinsic box
    // BEFORE anything is retained — outside is refused (US-03: a region
    // outside the content is refused); fitting publishes with the
    // `regionCarried` report. An explicitly supplied region cannot reach
    // here (the edit path refuses --visible-region with content options).
    let regionCarried: EditLayerResult["regionCarried"];
    const keptRegionCheck = (box: { width: number; height: number }) => {
      if (visibleRegion !== undefined) {
        validateKeptVisibleRegion(visibleRegion, box, layerId);
        regionCarried = { visibleRegion };
      }
    };
    if (options.fromGeneration !== undefined) {
      // Generated-content ingestion (#107): verify the selected output's bytes
      // against the recorded identity, retain the pixels in the content store,
      // and retain the record verbatim — all before any revision staging, so
      // the bytes, provenance, and revision publish coherently under the same
      // publication protocol and the same rollback discipline.
      const selected = await selectGenerationOutput(
        options.fromGeneration.jobRoot,
        options.fromGeneration.jobId,
        { output: options.fromGeneration.output },
      );
      const validated = await validateImageBytes(
        selected.bytes,
        `Generation Job "${selected.job.jobId}" output "${selected.output.file}"`,
      );
      keptRegionCheck({ width: validated.width, height: validated.height });
      // The vector colour's raster gate (#215): a SET alongside the
      // replacement refuses, a CARRIED colour refuses naming the fix — both
      // before any retention; the removal form passes.
      vectorColorRasterGate(vectorColor, validated.format, layerId);
      await storeContentBlob(resolvedRoot, validated.contentHash, validated.bytes);
      await retainGenerationRecord(resolvedRoot, selected.job.jobId, selected.recordBytes);
      contentHash = validated.contentHash;
    } else if (options.fromMatte !== undefined) {
      // Matted-content ingestion (#108): verify the matte's output bytes
      // against the recorded identity, retain the pixels in the content
      // store, and retain the matte record verbatim — all before any revision
      // staging, under the same publication protocol and rollback discipline
      // as every other content source. When the matte's source was a
      // published generation output, that job's record is retained verbatim
      // too (derived linkage; no second copy of the request facts). No
      // engine runs and nothing generates: this reads an existing result.
      const selected = await selectMatteOutput(options.fromMatte.matteRoot, options.fromMatte.matteId);
      const validated = await validateImageBytes(
        selected.bytes,
        `Matte "${selected.matte.matteId}" output "${selected.output.file}"`,
      );
      // Everything that can refuse the source (record parse, output hash,
      // source-copy shape/hash/size/traversal, decode, predecessor ambiguity)
      // runs before any Project write, so a refusal leaves no partial retention.
      const predecessor = await findGenerationPredecessor(
        options.fromMatte.generationRoot,
        selected.matte.request.source.contentHash,
      );
      keptRegionCheck({ width: validated.width, height: validated.height });
      // The vector colour's raster gate (#215): the matte output is raster
      // pixels — a set or carried colour refuses before any retention; the
      // removal form passes.
      vectorColorRasterGate(vectorColor, validated.format, layerId);
      await storeContentBlob(resolvedRoot, validated.contentHash, validated.bytes);
      await retainMattingRecord(resolvedRoot, selected.matte.matteId, selected.recordBytes);
      if (selected.sourceBytes) {
        await retainMattingSourceBytes(resolvedRoot, selected.matte, selected.sourceBytes);
      }
      if (predecessor) {
        await retainGenerationRecord(resolvedRoot, predecessor.job.jobId, predecessor.recordBytes);
        retainedGeneration = {
          jobId: predecessor.job.jobId,
          job: predecessor.job,
          output: predecessor.job.run.outputs.find(
            (o) => o.contentHash === selected.matte.request.source.contentHash,
          )!,
        };
      }
      contentHash = validated.contentHash;
      mattedFrom = { matteId: selected.matte.matteId, engine: selected.matte.result.engine, contentHash: validated.contentHash };
    } else if (options.image !== undefined) {
      const ingested = await validateAndIngestImage(options.image);
      keptRegionCheck({ width: ingested.width, height: ingested.height });
      // The vector colour's raster gate (#215): a SET alongside the
      // replacement refuses, a CARRIED colour refuses naming the fix — both
      // before the content is stored; the removal form passes.
      vectorColorRasterGate(vectorColor, ingested.format, layerId);
      await storeContentBlob(resolvedRoot, ingested.contentHash, ingested.bytes);
      contentHash = ingested.contentHash;
    }

    const revision: LayerRevision = {
      schemaVersion: LAYER_SCHEMA_VERSION,
      layerId,
      createdAt,
      kind: "image",
      contentHash,
      x,
      y,
      opacity,
      scaleX: scale.scaleX,
      scaleY: scale.scaleY,
      rotationDeg,
      flipX: flip.flipX,
      flipY: flip.flipY,
      ...(shadow !== undefined ? { shadow } : {}),
      ...(outline !== undefined ? { outline } : {}),
      ...(visibleRegion !== undefined ? { visibleRegion } : {}),
      ...(vectorColor.value !== undefined ? { vectorColor: vectorColor.value } : {}),
    };
    const unchanged =
      contentHash === prevRev.contentHash && x === prevRev.x && y === prevRev.y && opacity === prevRev.opacity &&
      scale.scaleX === prevRev.scaleX && scale.scaleY === prevRev.scaleY &&
      rotationDeg === prevRev.rotationDeg &&
      flip.flipX === prevRev.flipX && flip.flipY === prevRev.flipY &&
      shadowEq(shadow, prevRev.shadow) &&
      outlineEq(outline, prevRev.outline) &&
      visibleRegionEq(visibleRegion, prevRev.visibleRegion) &&
      vectorColor.value === prevRev.vectorColor;
    return { revision, unchanged, mattedFrom, retainedGeneration, ...(regionCarried !== undefined ? { regionCarried } : {}) };
  }

  if (prevRev.kind === "shape") {
    // Kind stability (#208, US-002): a shape Layer cannot become an image or
    // text Layer by edit, and image/text Layers cannot become a shape (the
    // refusal above fires first when shape options are supplied). Everything
    // kind-shared — placement, opacity, the canonical transform, the effects
    // — resolves exactly as for the other kinds.
    if (options.fromGeneration !== undefined) {
      throw new Error(
        `Cannot replace content from a Generation Job on a shape Layer. Layer "${layerId}" is a shape Layer.`,
      );
    }
    if (options.fromMatte !== undefined) {
      throw new Error(
        `Cannot replace content from a matte on a shape Layer. Layer "${layerId}" is a shape Layer.`,
      );
    }
    if (options.image !== undefined) {
      throw new Error(`Cannot edit image source on a shape Layer. Layer "${layerId}" is a shape Layer.`);
    }
    if (
      options.text !== undefined ||
      options.font !== undefined ||
      options.fontFile !== undefined ||
      options.fontSize !== undefined ||
      options.color !== undefined ||
      options.weight !== undefined ||
      options.width !== undefined ||
      options.tracking !== undefined ||
      options.lineHeight !== undefined
    ) {
      throw new Error(`Cannot edit text attributes on a shape Layer. Layer "${layerId}" is a shape Layer.`);
    }

    // Shape parameters as ABSOLUTE setters (#209, spec #207 US-002 bullet 1;
    // DEC-009): each supplied option replaces that parameter, every omitted
    // parameter keeps its current value, and the merged form validates
    // through the ONE shape-content validator — the same one ingestion and
    // the stored-revision reader use (no second parser), so a refused value
    // never advances live state.
    if (
      options.size !== undefined &&
      (options.resizeFactor !== undefined || options.resizeTo !== undefined || options.scale !== undefined)
    ) {
      throw new Error(
        `--size and the resize forms (--resize, --resize-to, --scale) are separate edits: Layer "${layerId}" cannot set the geometry's intrinsic size and resize in one edit, because the effective-size cap and the resize reference read the geometry's intrinsic size.`,
      );
    }
    const mergedGeometry = options.shape ?? prevRev.shape;
    const mergedSize = options.size ?? { width: prevRev.width, height: prevRev.height };
    // An explicitly supplied radius always validates (an ellipse refuses it,
    // naming the parameter); a radius merely CARRIED into a geometry switch
    // to ellipse is dropped — a rectangle fact with no ellipse meaning.
    const mergedRadius =
      options.cornerRadius !== undefined
        ? options.cornerRadius
        : mergedGeometry === "ellipse"
          ? undefined
          : prevRev.cornerRadius;
    const mergedFill = options.fill ?? { ...prevRev.fill };
    // A carried radius that the geometry switch makes meaningless is dropped
    // and REPORTED (review PROD-5): the operator sees exactly what the
    // absolute geometry setter removed.
    const droppedCornerRadius =
      mergedGeometry === "ellipse" && options.cornerRadius === undefined && prevRev.cornerRadius !== undefined
        ? prevRev.cornerRadius
        : undefined;
    const shapeContent = validateShapeContent(
      mergedGeometry,
      mergedSize.width,
      mergedSize.height,
      mergedRadius,
      mergedFill,
    );
    // The content identity IS the canonical parameter form (DEC-001): hashed
    // from the merged parameters exactly as creation hashes them.
    const contentHash = createHash("sha256").update(shapeContentIdentity(shapeContent)).digest("hex");

    const revision: LayerRevision = {
      schemaVersion: LAYER_SCHEMA_VERSION,
      layerId,
      createdAt,
      kind: "shape",
      contentHash,
      shape: shapeContent.shape,
      width: shapeContent.width,
      height: shapeContent.height,
      ...(shapeContent.cornerRadius !== undefined ? { cornerRadius: shapeContent.cornerRadius } : {}),
      fill: shapeContent.fill,
      x,
      y,
      opacity,
      scaleX: scale.scaleX,
      scaleY: scale.scaleY,
      rotationDeg,
      flipX: flip.flipX,
      flipY: flip.flipY,
      ...(shadow !== undefined ? { shadow } : {}),
      ...(outline !== undefined ? { outline } : {}),
      ...(visibleRegion !== undefined ? { visibleRegion } : {}),
    };
    const unchanged =
      shapeContent.shape === prevRev.shape &&
      shapeContent.width === prevRev.width &&
      shapeContent.height === prevRev.height &&
      shapeContent.cornerRadius === prevRev.cornerRadius &&
      // The whole fill identity (fillsEqual, #210): a gradient edit compares
      // the angle and every stop, never just the discriminator.
      fillsEqual(shapeContent.fill, prevRev.fill) &&
      x === prevRev.x &&
      y === prevRev.y &&
      opacity === prevRev.opacity &&
      scale.scaleX === prevRev.scaleX &&
      scale.scaleY === prevRev.scaleY &&
      rotationDeg === prevRev.rotationDeg &&
      flip.flipX === prevRev.flipX &&
      flip.flipY === prevRev.flipY &&
      shadowEq(shadow, prevRev.shadow) &&
      outlineEq(outline, prevRev.outline) &&
      visibleRegionEq(visibleRegion, prevRev.visibleRegion);
    // A region KEPT across a geometry edit (#211 review PROD-1): --shape and
    // --size change the content box, so the kept region re-validates against
    // the merged geometry before anything is published — outside is refused
    // (US-003); fitting publishes with the `regionCarried` report. A radius
    // or fill edit does not change the box.
    let regionCarried: EditLayerResult["regionCarried"];
    if (visibleRegion !== undefined && (options.shape !== undefined || options.size !== undefined)) {
      validateKeptVisibleRegion(
        visibleRegion,
        { width: shapeContent.width, height: shapeContent.height },
        layerId,
      );
      regionCarried = { visibleRegion };
    }
    return {
      revision,
      unchanged,
      retainedGeneration: null,
      ...(regionCarried !== undefined ? { regionCarried } : {}),
      ...(droppedCornerRadius !== undefined ? { shapeEdited: { droppedCornerRadius } } : {}),
    };
  }

  if (prevRev.kind === "text") {
    // Incompatible image option passed to text layer
    if (options.fromGeneration !== undefined) {
      throw new Error(
        `Cannot replace content from a Generation Job on a text Layer. Layer "${layerId}" is a text Layer.`,
      );
    }
    if (options.fromMatte !== undefined) {
      throw new Error(
        `Cannot replace content from a matte on a text Layer. Layer "${layerId}" is a text Layer.`,
      );
    }
    if (options.image !== undefined) {
      throw new Error(`Cannot edit image source on a text Layer. Layer "${layerId}" is a text Layer.`);
    }

    // Resolve the target face (#179, ADR-0021; #232, DEC-006): a `--font`
    // edit names a bundled face; a `--font-file` edit reads the caller font
    // ONCE and converts its stored facts to the same FontFace shape; an axes
    // edit resolves the retained font — a caller font by its revision's
    // stored facts (the one home of a caller font's axis facts), anything
    // else by its content hash in the bundled registry. Edits that change
    // neither the font nor the axes never consult either home, so a Project
    // whose retained bytes match no bundled face keeps editing text, size,
    // and color as before.
    let face: FontFace | undefined;
    let callerFont: CallerFontFacts | undefined;
    let ingestedCallerBytes: Buffer | undefined;
    if (options.fontFile !== undefined) {
      // The file is read and parsed ONCE at ingestion (DEC-006); a
      // non-font or unusable file refuses here, before any retention.
      const ingested = await readCallerFontFile(options.fontFile);
      ingestedCallerBytes = ingested.bytes;
      callerFont = ingested.facts;
      face = callerFontFace(callerFont);
    } else if (options.font !== undefined) {
      face = resolveFace(options.font);
    } else if (options.weight !== undefined || options.width !== undefined) {
      if (prevRev.callerFont !== undefined) {
        // One home per fact (DEC-006): a caller font's axes come from its
        // stored facts — never beside a bundled-face lookup.
        face = callerFontFace(prevRev.callerFont);
      } else {
        face = faceByContentHash(prevRev.contentHash);
        if (face === undefined) {
          throw new Error(
            `The retained font of Layer "${layerId}" (content hash ${prevRev.contentHash}) matches no bundled face — pass --font to choose a bundled family.`,
          );
        }
      }
    }

    let contentHash = prevRev.contentHash;
    let axes: TextAxes;
    // The font bytes the NEW revision pins (#211 review PROD-1): set by the
    // font-edit paths, defaulting to the previous revision's retained bytes.
    let newTextBytes: Buffer | undefined;
    if (face !== undefined) {
      // Axes resolve BEFORE any retention, so a refused edit publishes
      // nothing — not even a stray content blob.
      axes = resolveEditTextAxes(face, options, prevRev);
      if (callerFont !== undefined) {
        // Caller font retention (#232, DEC-006): the SAME content-store path
        // bundled bytes go through, and the SAME browser resolution gate the
        // render probe applies — both run before anything publishes, so a
        // file the browser cannot resolve refuses with no revision, no use,
        // and no stray content blob.
        const fontHash = createHash("sha256").update(ingestedCallerBytes!).digest("hex");
        await verifyCallerFontResolves(fontHash, ingestedCallerBytes!, callerFont);
        await storeContentBlob(resolvedRoot, fontHash, ingestedCallerBytes!);
        contentHash = fontHash;
        newTextBytes = ingestedCallerBytes!;
      } else if (options.font !== undefined) {
        const bytes = fontAssetBytes(face);
        const fontHash = createHash("sha256").update(bytes).digest("hex");
        await storeContentBlob(resolvedRoot, fontHash, bytes);
        contentHash = fontHash;
        newTextBytes = bytes;
      }
    } else {
      // No font or axes edit: the current revision's axes carry verbatim
      // (present ⟺ the retained font is variable).
      axes = normalizeStoredTextAxes(prevRev) ?? {};
    }

    // Text typography (#187, ADR-0021): font-independent, so it never
    // consults the face registry and always resolves here — an explicit
    // control sets or clears it (0/"normal" normalize to absent through the
    // one control resolver), an omitted control carries the current value
    // across ANY edit, including a `--font` switch.
    const typography = resolveTextTypographyControls({
      ...(options.tracking !== undefined
        ? { tracking: options.tracking }
        : prevRev.tracking !== undefined
          ? { tracking: prevRev.tracking }
          : {}),
      ...(options.lineHeight !== undefined
        ? { lineHeight: options.lineHeight }
        : prevRev.lineHeight !== undefined
          ? { lineHeight: prevRev.lineHeight }
          : {}),
    });

    const text = options.text !== undefined ? options.text : prevRev.text;
    const fontSize = options.fontSize !== undefined ? options.fontSize : prevRev.fontSize;
    const color = options.color !== undefined ? options.color : prevRev.color;

    // Canonical text validation
    validateTextContent(text, fontSize, color);

    // The revision's caller font facts (#232, DEC-006): a --font-file edit
    // stores the file's facts; a later edit without a font option keeps the
    // retained caller font verbatim; switching to a bundled family (--font)
    // drops them — the revision is a bundled-face revision again.
    const resolvedCallerFont =
      callerFont ?? (options.font !== undefined ? undefined : prevRev.callerFont);

    const revision: LayerRevision = {
      schemaVersion: LAYER_SCHEMA_VERSION,
      layerId,
      createdAt,
      kind: "text",
      contentHash,
      text,
      fontSize,
      color,
      ...(axes.weight !== undefined ? { weight: axes.weight, width: axes.width } : {}),
      ...(typography.tracking !== undefined ? { tracking: typography.tracking } : {}),
      ...(typography.lineHeight !== undefined ? { lineHeight: typography.lineHeight } : {}),
      ...(resolvedCallerFont !== undefined ? { callerFont: resolvedCallerFont } : {}),
      x,
      y,
      opacity,
      scaleX: scale.scaleX,
      scaleY: scale.scaleY,
      rotationDeg,
      flipX: flip.flipX,
      flipY: flip.flipY,
      ...(shadow !== undefined ? { shadow } : {}),
      ...(outline !== undefined ? { outline } : {}),
      ...(visibleRegion !== undefined ? { visibleRegion } : {}),
    };
    const unchanged =
      contentHash === prevRev.contentHash &&
      text === prevRev.text &&
      fontSize === prevRev.fontSize &&
      color === prevRev.color &&
      axes.weight === prevRev.weight &&
      axes.width === prevRev.width &&
      typography.tracking === prevRev.tracking &&
      typography.lineHeight === prevRev.lineHeight &&
      callerFontEq(resolvedCallerFont, prevRev.callerFont) &&
      x === prevRev.x &&
      y === prevRev.y &&
      opacity === prevRev.opacity &&
      scale.scaleX === prevRev.scaleX &&
      scale.scaleY === prevRev.scaleY &&
      rotationDeg === prevRev.rotationDeg &&
      flip.flipX === prevRev.flipX &&
      flip.flipY === prevRev.flipY &&
      shadowEq(shadow, prevRev.shadow) &&
      outlineEq(outline, prevRev.outline) &&
      visibleRegionEq(visibleRegion, prevRev.visibleRegion);
    // A region KEPT across a text edit (#211 review PROD-1): the text
    // content box is the measured line-box extent, so a text edit that can
    // change it re-measures the RESULTING revision's standalone line (the
    // bytes the new revision pins) and re-validates the kept region against
    // it before anything is published — outside is refused (US-003);
    // fitting publishes with the `regionCarried` report. Color does not
    // change the line box. An explicitly supplied region cannot reach here
    // (the edit path refuses --visible-region with content options).
    let regionCarried: EditLayerResult["regionCarried"];
    if (
      visibleRegion !== undefined &&
      (options.text !== undefined || options.font !== undefined || options.fontFile !== undefined ||
        options.fontSize !== undefined || options.weight !== undefined || options.width !== undefined ||
        options.tracking !== undefined || options.lineHeight !== undefined)
    ) {
      const standalone = await measureStandaloneSnapshot(
        { ...revision, x: 0, y: 0 } as ResolvedLayerRevision,
        newTextBytes ?? prevContentBytes,
      );
      validateKeptVisibleRegion(visibleRegion, standalone.content, layerId);
      regionCarried = { visibleRegion };
    }
    return { revision, unchanged, retainedGeneration: null, ...(regionCarried !== undefined ? { regionCarried } : {}) };
  }

  throw new Error(`Unsupported Layer kind on layer "${layerId}".`);
}

/**
 * Validate the fork target against the canonical target/use→original-id rule
 * (#85): the Composition must exist and parse, the selected use must exist in
 * it, and that use must reference the Layer being forked. Composition
 * boundary containment, canonical parsing, and reference-resolution
 * verification are all delegated to the one canonical pre-mutation reader
 * `readMutableComposition` (#85, local review CRAFT-1) — the only fork-"
 * specific checks here are the use lookup and the id match. Callers must
 * hold the Project lock.
 */
async function resolveForkTarget(
  resolvedRoot: string,
  composition: string,
  useName: string,
  originalLayerId: string,
): Promise<{ comp: Composition; compFile: string }> {
  const { comp, compFile } = await readMutableComposition(resolvedRoot, composition);

  const targetUse = comp.layers.find((u) => u.name === useName);
  if (!targetUse) {
    throw new Error(`Use "${useName}" not found in composition "${composition}".`);
  }
  if (targetUse.layerId !== originalLayerId) {
    throw new Error(
      `Use "${useName}" in composition "${composition}" references Layer "${targetUse.layerId}", not "${originalLayerId}".`,
    );
  }

  return { comp, compFile };
}

/**
 * Fork publication (#85): stage the new identity and edited revision, then
 * retarget ONLY the selected use in the target Composition as the live commit
 * point. Other uses keep their raw fields; the original identity, its
 * revisions, and its content are never touched. Caught-error cleanup removes
 * only the newly staged identity/revision — never old content or history.
 * Callers must hold the Project lock.
 */
async function publishForkEdit(
  resolvedRoot: string,
  originalLayerId: string,
  fork: { composition: string; use: string },
  target: { comp: Composition; compFile: string },
  newLayerId: string,
  revision: LayerRevision,
  refs: { referringCompositions: string[]; referrersCount: number },
): Promise<EditLayerResult> {
  const { comp, compFile } = target;
  const revHash = computeRevisionHash(revision);
  const revDir = path.join(resolvedRoot, "layers", `${newLayerId}.revisions`);
  const revFile = path.join(revDir, `${revHash}.json`);
  const identityFile = path.join(resolvedRoot, "layers", `${newLayerId}.json`);

  await mkdir(revDir, { recursive: true });

  let stagedRevision = false;
  let stagedIdentity = false;
  try {
    await atomicCreate(revFile, JSON.stringify(revision, null, 2) + "\n");
    stagedRevision = true;

    const identity: LayerIdentity = {
      schemaVersion: LAYER_SCHEMA_VERSION,
      id: newLayerId,
      createdAt: revision.createdAt,
      currentRevision: revHash,
    };

    await atomicCreate(identityFile, JSON.stringify(identity, null, 2) + "\n");
    stagedIdentity = true;

    // Resolve the staged Layer before the live commit (publication protocol).
    await readLayerInternal(resolvedRoot, newLayerId);

    // Live Commit Point: retarget only the selected use, preserving every
    // other raw document/use field.
    const updatedComp: Composition = {
      ...comp,
      layers: comp.layers.map((use) => (use.name === fork.use ? { name: use.name, layerId: newLayerId } : use)),
    };

    await atomicReplace(compFile, JSON.stringify(updatedComp, null, 2) + "\n");
  } catch (err) {
    if (stagedIdentity) {
      await unlink(identityFile).catch(() => {});
    }
    if (stagedRevision) {
      await unlink(revFile).catch(() => {});
      await rmdir(revDir).catch(() => {}); // remove the now-empty revision directory
    }
    throw err;
  }

  const layer = await readLayerInternal(resolvedRoot, newLayerId);
  return {
    layer,
    referringCompositions: refs.referringCompositions,
    referrersCount: refs.referrersCount,
    fork: { previousLayerId: originalLayerId, composition: fork.composition, use: fork.use },
  };
}

/**
 * Unlocked internal editor for Layer identity and revision advancement.
 * Callers must hold the Project lock.
 */
export async function editLayerInternal(
  projectPath: string,
  layerId: string,
  options: EditLayerOptions,
): Promise<EditLayerResult> {
  const resolvedRoot = path.resolve(projectPath);
  const current = await readLayerInternalFull(resolvedRoot, layerId);
  const prevRev = current.currentRevision;

  // Generated-content (#107) and matted-content (#108) ingestion and file
  // ingestion are mutually exclusive content options — one edit replaces
  // content from one source.
  if (options.image !== undefined && options.fromGeneration !== undefined) {
    throw new Error("--image and --from-generation are mutually exclusive content options.");
  }
  if (options.image !== undefined && options.fromMatte !== undefined) {
    throw new Error("--image and --from-matte are mutually exclusive content options.");
  }
  if (options.fromGeneration !== undefined && options.fromMatte !== undefined) {
    throw new Error("--from-generation and --from-matte are mutually exclusive content options.");
  }
  // One font source per edit (#232): a bundled family (--font) and a caller
  // font file (--font-file) are mutually exclusive — the same exclusivity
  // rule the command boundaries enforce, re-checked at the domain boundary
  // so no caller of the functions can bypass it.
  if (options.font !== undefined && options.fontFile !== undefined) {
    throw new Error(
      "--font and --font-file name one font per edit — pass a bundled family (--font) or a local font file (--font-file), not both.",
    );
  }

  // Normalize intent once into the canonical discriminated shape (#85).
  const intent = normalizeEditIntent(options);

  // 1. Authoritative referrer discovery under the Project lock (fail-closed)
  const referringCompositions = await findLayerReferrersInternal(resolvedRoot, layerId);
  const referrersCount = referringCompositions.length;

  // 2. Blast-radius guard: in-place editing only; a fork changes exactly one
  //    use in one Composition, so it never needs the propagation flag.
  if (intent.mode === "in-place" && referrersCount > 1 && !options.inPlace) {
    const namesList = referringCompositions.map((n) => `"${n}"`).join(", ");
    const err = new Error(
      `Layer "${layerId}" is referenced by ${referrersCount} Compositions (${namesList}). ` +
        `Editing it in-place will affect all of them. Pass --in-place to confirm, or fork into an independent Layer.`,
    );
    (err as unknown as { referringCompositions: string[]; referrersCount: number }).referringCompositions =
      referringCompositions;
    (err as unknown as { referringCompositions: string[]; referrersCount: number }).referrersCount =
      referrersCount;
    throw err;
  }

  // 3. Placement and transform-scale options: preserve existing values if omitted
  const placement = resolveEditPlacement(options, prevRev);
  const scale = resolveEditScale(options, prevRev, layerId);
  const rotationDeg = resolveEditRotation(options, prevRev);
  const flip = resolveEditFlip(options, prevRev);
  // Shadow effect (#139, ADR-0018): absolute setter, refusal before staging.
  const shadow = resolveEditShadow(options, prevRev);
  const hasShadow = options.shadow !== undefined;
  const shadowedReport = { shadow: shadow ?? null };
  // Outline effect (#140, ADR-0019): absolute setter, refusal before staging.
  const outline = resolveEditOutline(options, prevRev);
  const hasOutline = options.outline !== undefined;
  const outlinedReport = { outline: outline ?? null };
  // Visible region (#211, spec #207 US-003, ADR-0023): absolute setter,
  // refusal before staging. The region is validated against the content box
  // of the SAME content the edit would publish — content edits are refused
  // in one edit with the region, so that is always the live revision's box;
  // a text Layer's box is its measured line-box extent (the unwrapped
  // standalone line, the same measurement authority anchored placement
  // resolves an unreferenced Layer against).
  if ((options.visibleRegion !== undefined || options.visibleRegionRadius !== undefined) && REGION_CONFLICTING_OPTION_PRESENT(options)) {
    throw new Error(
      `Visible region and content edits are separate edits: Layer "${layerId}" cannot set --visible-region/--visible-region-radius and replace or reshape its content in one edit, because the region is validated against the content box. ` +
        `Set the region in its own edit.`,
    );
  }
  const visibleRegion = await resolveEditVisibleRegion(resolvedRoot, options, prevRev, current.contentBytes, layerId);
  const hasRegion = options.visibleRegion !== undefined || options.visibleRegionRadius !== undefined;
  const regionSetReport = { visibleRegion: visibleRegion ?? null };
  // Vector colour (#215, spec #207 US-005, DEC-008): absolute setter, refusal
  // before staging — the kind gates run here, before any content ingestion,
  // and the raster gate reads the live revision's format (a same-edit
  // content replacement defers the gate to the ingested format, still
  // before anything is stored).
  const vectorColor = resolveEditVectorColor(options, prevRev, layerId);
  const vectorColorSetReport = { vectorColor: vectorColor.value ?? null };
  // Absolute effective facts for the result (#133): the scale is authoritative
  // and always reported; image Layers additionally report the effective size
  // the scale produces from the retained content's intrinsic dimensions.
  const resizedReport =
    prevRev.kind === "image" || prevRev.kind === "shape"
      ? {
          scaleX: scale.scaleX,
          scaleY: scale.scaleY,
          width: roundEffective(prevRev.width * scale.scaleX),
          height: roundEffective(prevRev.height * scale.scaleY),
        }
      : { scaleX: scale.scaleX, scaleY: scale.scaleY };
  const hasResize = options.resizeFactor !== undefined || options.resizeTo !== undefined || options.scale !== undefined;
  const hasRotate = options.rotateDeg !== undefined;
  const rotatedReport = { rotationDeg };
  // Narrowed once: a defined flip is always a validated literal mode, so the
  // report never needs a cast (and absence means no --flip option was given).
  const flippedReport =
    options.flip !== undefined ? { flip: options.flip } : undefined;

  if (intent.mode === "fork") {
    // Canonical target/use→original-id validation before any content work.
    const target = await resolveForkTarget(resolvedRoot, intent.composition, intent.use, layerId);

    // New identity + edited revision through the shared canonical builder.
    const newLayerId = generateLayerId();
    const createdAt = new Date().toISOString();
    const { revision, mattedFrom, retainedGeneration, shapeEdited, regionCarried } = await buildEditedRevision(
      resolvedRoot,
      prevRev,
      newLayerId,
      createdAt,
      options,
      placement,
      scale,
      rotationDeg,
      flip,
      shadow,
      outline,
      visibleRegion,
      vectorColor,
      current.contentBytes,
    );
    // An explicit fork always publishes the new identity, even when the
    // edited revision is field-identical to the current one (documented
    // no-content-change fork).
    const forkResult = await publishForkEdit(resolvedRoot, layerId, intent, target, newLayerId, revision, {
      referringCompositions,
      referrersCount,
    });
    const withResized = hasResize ? { ...forkResult, resized: resizedReport } : forkResult;
    const withRotated = hasRotate ? { ...withResized, rotated: rotatedReport } : withResized;
    const withFlipped = flippedReport ? { ...withRotated, flipped: flippedReport } : withRotated;
    const withShadow = hasShadow ? { ...withFlipped, shadowed: shadowedReport } : withFlipped;
    const withOutline = hasOutline ? { ...withShadow, outlined: outlinedReport } : withShadow;
    const withRegion = hasRegion ? { ...withOutline, regionSet: regionSetReport } : withOutline;
    const withColour = vectorColor.given ? { ...withRegion, vectorColorSet: vectorColorSetReport } : withRegion;
    const withCarried = regionCarried ? { ...withColour, regionCarried } : withColour;
    const withShape = shapeEdited ? { ...withCarried, shapeEdited } : withCarried;
    return options.fromGeneration !== undefined
      ? { ...withShape, generatedFrom: { jobId: options.fromGeneration.jobId, contentHash: revision.contentHash } }
      : mattedFrom !== undefined
        ? {
            ...withShape,
            mattedFrom,
            ...(retainedGeneration
              ? { generatedFrom: { jobId: retainedGeneration.jobId, contentHash: revision.contentHash } }
              : {}),
          }
        : withShape;
  }

  // 4. Shared canonical edited-revision construction (in-place)
  const { revision, unchanged, mattedFrom, retainedGeneration, shapeEdited, regionCarried } = await buildEditedRevision(
    resolvedRoot,
    prevRev,
    layerId,
    new Date().toISOString(),
    options,
    placement,
    scale,
    rotationDeg,
    flip,
    shadow,
    outline,
    visibleRegion,
    vectorColor,
    current.contentBytes,
  );

  // No-op check: if all fields are identical to previous revision, avoid storage churn
  if (unchanged) {
    const resolved = await readLayerInternal(resolvedRoot, layerId);
    return {
      layer: resolved,
      referringCompositions,
      referrersCount,
      ...(hasResize ? { resized: resizedReport } : {}),
      ...(hasRotate ? { rotated: rotatedReport } : {}),
      ...(flippedReport ? { flipped: flippedReport } : {}),
      ...(hasShadow ? { shadowed: shadowedReport } : {}),
      ...(hasOutline ? { outlined: outlinedReport } : {}),
      ...(hasRegion ? { regionSet: regionSetReport } : {}),
      ...(vectorColor.given ? { vectorColorSet: vectorColorSetReport } : {}),
      ...(regionCarried ? { regionCarried } : {}),
      ...(shapeEdited ? { shapeEdited } : {}),
      ...(options.fromGeneration !== undefined
        ? { generatedFrom: { jobId: options.fromGeneration.jobId, contentHash: revision.contentHash } }
        : {}),
      ...(mattedFrom !== undefined
        ? {
            mattedFrom,
            ...(retainedGeneration
              ? { generatedFrom: { jobId: retainedGeneration.jobId, contentHash: revision.contentHash } }
              : {}),
          }
        : {}),
    };
  }

  // 5. Compute new revision hash and stage revision document
  const revHash = computeRevisionHash(revision);
  const revDir = path.join(resolvedRoot, "layers", `${layerId}.revisions`);
  const revFile = path.join(revDir, `${revHash}.json`);
  const identityFile = path.join(resolvedRoot, "layers", `${layerId}.json`);

  await mkdir(revDir, { recursive: true });

  let stagedRevision = false;
  try {
    await atomicCreate(revFile, JSON.stringify(revision, null, 2) + "\n");
    stagedRevision = true;

    const identity: LayerIdentity = {
      schemaVersion: LAYER_SCHEMA_VERSION,
      id: layerId,
      createdAt: current.createdAt,
      currentRevision: revHash,
    };

    // 6. Live commit point: update Layer identity currentRevision
    await atomicReplace(identityFile, JSON.stringify(identity, null, 2) + "\n");
  } catch (err) {
    if (stagedRevision) {
      await unlink(revFile).catch(() => {});
    }
    throw err;
  }

  const updatedLayer = await readLayerInternal(resolvedRoot, layerId);
  return {
    layer: updatedLayer,
    referringCompositions,
    referrersCount,
    ...(hasResize ? { resized: resizedReport } : {}),
    ...(hasRotate ? { rotated: rotatedReport } : {}),
    ...(flippedReport ? { flipped: flippedReport } : {}),
    ...(hasShadow ? { shadowed: shadowedReport } : {}),
    ...(hasOutline ? { outlined: outlinedReport } : {}),
    ...(hasRegion ? { regionSet: regionSetReport } : {}),
    ...(vectorColor.given ? { vectorColorSet: vectorColorSetReport } : {}),
    ...(regionCarried ? { regionCarried } : {}),
    ...(shapeEdited ? { shapeEdited } : {}),
    ...(options.fromGeneration !== undefined
      ? { generatedFrom: { jobId: options.fromGeneration.jobId, contentHash: revision.contentHash } }
      : {}),
    ...(mattedFrom !== undefined
      ? {
          mattedFrom,
          ...(retainedGeneration
            ? { generatedFrom: { jobId: retainedGeneration.jobId, contentHash: revision.contentHash } }
            : {}),
        }
      : {}),
  };
}

/**
 * Edit a Layer in a Project (acquires Project lock for consistent discovery and atomic publication).
 */
export async function editLayer(
  projectPath: string,
  layerId: string,
  options: EditLayerOptions,
): Promise<EditLayerResult> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, () => editLayerInternal(resolvedRoot, layerId, options));
}

