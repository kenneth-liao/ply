import { isStoredTimestamp } from "./stored-schema.js";
import {
  parseFillSpec,
  parseFillColorSpec,
  normalizeStoredFill,
  normalizeStoredTextFill,
  canonicalizeTextFillForStorage,
  textFillIdentityString,
  fillsEqual,
  fillIdentityString,
  FILL_TYPES,
  FILL_COLOR_PATTERN,
  type LayerFill,
} from "./fill.js";
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
import { measureStandaloneSnapshot, measureTextFit, transformBlowupRefusal } from "./composition-measure.js";
import { parseCompositionDocument, readMutableComposition, readCompositionInternalFull, type Composition } from "./composition.js";
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
import {
  EDIT_APPLICATION_ORDER,
  applyLayerOption,
  type SharedOptionApplyContext,
  type SharedOptionDraft,
  type SharedOptionValues,
} from "./layer-options.js";

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
   * Canonical transform skew (#298, spec #285 US-008, ADR-0016 amendment):
   * the Layer's skew angles in degrees about its `(x, y)` top-left placement
   * point — `skewXDeg` shears along the content's own x axis, `skewYDeg`
   * along its own y axis — applied AFTER rotation and BEFORE perspective
   * (the documented order: flip, scale, rotation, skew, perspective). The
   * command sets ABSOLUTE angles (`--skew <Xdeg>x<Ydeg>`); the removal value
   * is `0x0`, and a stored document never carries the identity form —
   * stored only when set, so an unskewed revision keeps its exact pre-#298
   * id and shape. Both fields are recorded together, like flip.
   *
   * Optional in the stored shape only for revisions written before #298 —
   * absent means 0 and is normalized by the one revision reader. The hash
   * appends the pair only when present, so pre-#298 revisions keep their
   * exact ids.
   */
  skewXDeg?: number;
  skewYDeg?: number;
  /**
   * Canonical transform perspective (#298, spec #285 US-008, ADR-0016
   * amendment): the Layer's perspective tilt in degrees about the X and Y
   * axes — `perspectiveTiltXDeg` tips the top edge away from the viewer,
   * `perspectiveTiltYDeg` the right edge — pivoting about the Layer's own
   * untransformed content centre (layout px before transforms), applied
   * AFTER skew as the outermost transform, followed by the fixed documented
   * 1000px perspective distance. The command sets ABSOLUTE tilts
   * (`--perspective <tiltXdeg>x<tiltYdeg>`); the removal value is `0x0`,
   * and a stored document never carries the identity form — stored only
   * when set. Both fields are recorded together, like flip.
   *
   * Optional in the stored shape only for revisions written before #298 —
   * absent means 0 and is normalized by the one revision reader. The hash
   * appends the pair only when present, so pre-#298 revisions keep their
   * exact ids.
   */
  perspectiveTiltXDeg?: number;
  perspectiveTiltYDeg?: number;
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
   *
   * Stacked effects (#302, spec #285 US-011, ISC-50, DEC-005, ADR-0027):
   * the field is the ONE home for the Layer's shadows — one shadow stores
   * today's single object; two or more store a list in the SAME field, in
   * paint order (command order). A one-element list is never stored (the
   * object form IS the one-shadow shape) and a stored one is a malformed
   * document. The one stored-shape fold; resolved revisions carry the
   * normalized list. A single shadow's document shape, id, and paint are
   * byte-identical to the pre-#302 form.
   */
  shadow?: LayerShadow | LayerShadow[];
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
   *
   * Stacked effects (#302, spec #285 US-011, ISC-50, DEC-005, ADR-0027):
   * the same ONE-home fold as the shadow — one outline stores today's
   * single object, two or more a list in the SAME field, in paint order;
   * a one-element list is never stored.
   */
  outline?: LayerOutline | LayerOutline[];
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
  /**
   * Canonical Layer grade (#219, spec #218 US-001, ADR-0024): paint-time
   * colour and light adjustments (brightness, contrast, saturation, warmth)
   * applied to the Layer's content element only — never to outline, shadow,
   * or alpha. Stored only when set and non-neutral; neutral values remove the
   * stored fact and an omitted control keeps its value.
   *
   * Present ⟺ at least one non-neutral grade control exists: absence IS the
   * canonical no-grade form, so removal drops the field and every reader
   * treats absence as none. The revision hash appends it only when present, so
   * revisions written before #219 keep their exact ids.
   */
  grade?: LayerGrade;
  /**
   * Canonical edge glow (#221, spec #218 US-002, ADR-0024): a coloured light
   * painted just inside the Layer's alpha edge, over the graded content,
   * without extending painted extents or altering alpha coverage (DEC-005).
   * Stored only when set; 'none' removes the stored fact.
   *
   * Present ⟺ an edge glow exists: absence IS the canonical no-glow form,
   * so removal drops the field and every reader treats absence as none.
   * The revision hash appends it only when present, so revisions written
   * before #221 keep their exact ids.
   */
  glow?: LayerGlow;
  /**
   * Canonical blend mode (#220, spec #218 US-003, ADR-0024): controls how the
   * whole Layer combines with everything painted beneath it on the canvas
   * via CSS mix-blend-mode. An absolute setter; 'normal' removes the stored
   * fact.
   *
   * Present ⟺ a non-normal blend mode exists: absence IS the canonical
   * normal/no-blend form, so removal drops the field and every reader
   * treats absence as normal. The revision hash appends it only when
   * present, so revisions written before #220 keep their exact ids.
   */
  blend?: StoredLayerBlendMode;
  /**
   * Canonical Layer blur (#299, spec #285 US-010, DEC-005, ADR-0024
   * amendment): a Gaussian defocus radius in px, applied as the LAST
   * function of the outer element's effects filter chain — the whole Layer
   * look (content, edge glow, outline, shadow) reads out of focus, inside
   * the blend unit and before the transform and opacity. The px are
   * Layer-LOCAL: the canonical transform maps content+effects together, so
   * the defocus scales with the Layer's scale like the other effects.
   *
   * The blur grows painted extents (unlike grade or glow, DEC-005) and its
   * reach reader lives beside the outline/shadow terms it composes with
   * (#300's choke and feather extend the same reader). An effect, never
   * placement: anchored placement resolves against the pre-effect ink
   * (#288, ADR-0025).
   *
   * Present ⟺ a positive radius exists: absence IS the canonical no-blur
   * form, so `--blur 0` drops the field and every reader treats absence as
   * none. The revision hash appends it only when present, so revisions
   * written before #299 keep their exact ids.
   */
  blur?: number;
  /**
   * Canonical Layer edge choke (#300, spec #285 US-013, DEC-005, ADR-0024
   * amendment): an inward alpha-erode radius in px, applied as the FIRST
   * function of the outer element's effects filter chain — the alpha edge
   * is shaped BEFORE the effects that read it (edge glow, outline, shadow;
   * blur stays LAST), so a cutout's halo disappears on saturated backdrops
   * and the glow band hugs the choked edge. The px are Layer-LOCAL: the
   * canonical transform maps content+effects together, so the choke scales
   * with the Layer's scale like the other effects.
   *
   * The choke SHRINKS painted extents (the shaped alpha is composited `in`
   * the source graphic, so the ink never exceeds the unchoked ink — the
   * edge step adds no effect reach, the ADR-0024 amendment). An effect,
   * never placement: anchored placement resolves against the pre-effect
   * ink (#288, ADR-0025).
   *
   * Present ⟺ a positive radius exists: absence IS the canonical no-choke
   * form, so `--choke 0` drops the field and every reader treats absence
   * as none. The revision hash appends it only when present, so revisions
   * written before #300 keep their exact ids.
   */
  choke?: number;
  /**
   * Canonical Layer edge feather (#300, spec #285 US-013, DEC-005, ADR-0024
   * amendment): a Gaussian alpha-edge softening radius (σ) in px, applied
   * immediately after the choke in the SAME first filter function of the
   * outer element's effects chain (erode, then blur, then `in` the source
   * graphic). The px are Layer-LOCAL like the choke's.
   *
   * The feather softens the edge INWARD only: the `in` composite bounds the
   * painted alpha by the source's, so the painted ink never exceeds the
   * unfeathered ink and the edge step adds no effect reach (the ADR-0024
   * amendment). An effect, never placement: anchored placement resolves
   * against the pre-effect ink (#288, ADR-0025).
   *
   * Present ⟺ a positive radius exists: absence IS the canonical
   * no-feather form, so `--feather 0` drops the field and every reader
   * treats absence as none. The revision hash appends it only when
   * present, so revisions written before #300 keep their exact ids.
   */
  feather?: number;
}

/** The documented blend modes (#220, spec #218 US-003, ADR-0024). */
export const LAYER_BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "soft-light",
  "darken",
  "lighten",
  "color-dodge",
] as const;

export type LayerBlendMode = (typeof LAYER_BLEND_MODES)[number];
export type StoredLayerBlendMode = Exclude<LayerBlendMode, "normal">;

/**
 * Canonical edge-glow parameters (#221, spec #218 US-002, ADR-0024). The
 * optional `direction` (#301, ISC-53, DEC-008, ADR-0024 third amendment) is
 * the one-sided direction model — light FROM `angle` degrees clockwise from
 * top dimming the far side to `1 − strength` of the even band, fading
 * linearly across the Layer's untransformed box. It is mutually exclusive
 * with the legacy `angle`/`strength` pair (the offset model), whose meaning
 * never changes: stored facts keep today's semantics.
 */
export interface LayerGlow {
  width: number;
  softness: number;
  color: string;
  angle?: number;
  strength?: number;
  direction?: { angle: number; strength: number };
}

/** Canonical grade parameters (#219, spec #218 US-001, ADR-0024). */
export interface LayerGrade {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  warmth?: number;
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
  color: string | LayerFill;
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
   * Selected wrap width in layout px (#294, spec #285 US-015, ISC-55,
   * DEC-001/DEC-005, ADR-0017 amendment): present ONLY when set — an omitted
   * field paints exactly as before (natural one-line layout), which is the
   * only no-width form. Font-independent. With a width set, the text
   * soft-wraps at spaces within it (`white-space: pre-wrap; width: <W>px`);
   * written line breaks still break. The width is a LAYOUT-pixel measure,
   * applied before the canonical transform. A natural-layout fact: a legacy
   * revision never carries one, and setting one on a legacy revision is an
   * edit that writes `layoutRule: "natural"`. Appended to the revision hash
   * only when present, so pre-#294 revision ids are byte-identical.
   */
  wrapWidth?: number;
  /**
   * The caller-set fit box in layout px (#295, spec #285 US-016, ISC-56,
   * DEC-010/DEC-005): present ONLY when set — both fields together, and
   * absence IS the no-box form. With a box set, the ONE in-page fit
   * derivation (shared by paint, measure, and anchor) shrinks the font size
   * until the laid-out text block fits the box — shrinking only: it never
   * grows the size and never changes weight or width (DEC-010). The EFFECTIVE
   * font size is never stored: it re-derives from the revision's own facts at
   * every read, so edits to the text, font, tracking, or wrap width stay
   * correct, and removing the box restores the render byte-for-byte. The box
   * is a LAYOUT-pixel measure, applied before the canonical transform. A
   * natural-layout fact: a legacy revision never carries one, and setting one
   * on a legacy revision is an edit that writes `layoutRule: "natural"`.
   * Appended to the revision hash only when present, so pre-#295 revision ids
   * are byte-identical.
   */
  fitWidth?: number;
  fitHeight?: number;
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
  /**
   * Text layout rule (#287, spec #285 DEC-001, ADR-0017 amendment):
   * "natural" lays out text at its natural width, wrapping only at written
   * line breaks. Omitted for revisions written before #287, which normalize
   * to "legacy" (canvas-bounded wrapping).
   */
  layoutRule?: StoredTextLayoutRule;
  /**
   * Text runs (#297, spec #285 US-017, ISC-54, ADR-0021 amendment): present
   * if and only if the Layer carries TWO OR MORE runs — the ONE ingestion
   * point normalizes fewer away, so a single-run revision is field-for-field
   * today's text revision and keeps its exact id. Each entry is an override
   * of the Layer-level defaults, never a second copy of a Layer fact:
   * `text` stays the only home of the characters; an entry stores the run's
   * boundary (its first character's 0-based index — entry 1 begins at 0 and
   * stores no field) plus only the facts that run overrides: colour, font
   * identity (its own retained bytes), caller font facts, and axes. Run
   * size, tracking, and line height are Layer facts only (they apply across
   * runs). A run with no override stores an empty entry — the boundary is
   * the fact. Appended to the revision hash only when present, so pre-#297
   * revision ids are byte-identical.
   */
  runs?: LayerTextRun[];
}

/** One stored text run (#297, ADR-0021 amendment): a boundary plus the
 *  overrides that run carries against the Layer-level defaults. Stored
 *  fields are present only when set — absence IS the layer-default form,
 *  so no reader can see two answers for one fact. The entries are ordered;
 *  entry 1 begins at character 0 and stores no `start`. */
export interface LayerTextRun {
  /** 0-based character index where this run begins. Entry 1 begins at 0
   *  (never stored); every later entry stores its strictly increasing,
   *  in-bounds, nonempty-slice start. */
  start?: number;
  /** The run's colour override: canonical solid hex string or canonical
   *  LayerFill — the ONE colour grammar the layer colour uses. Absent: the
   *  run paints the Layer's colour. */
  color?: string | LayerFill;
  /** The run's own retained font bytes, when the run overrides the Layer's
   *  font — a sha-256 identity into the same content store, deduped when
   *  equal to the Layer font's bytes (then this field is absent again). */
  contentHash?: string;
  /** The run font's caller-supplied file facts (#232, DEC-006), present iff
   *  the run's bytes came from a caller font file. */
  callerFont?: CallerFontFacts;
  /** The run's resolved axes (#179, ADR-0021): stored iff the run carries a
   *  font override whose face is variable (the resolved instance, omitted
   *  controls at the face's default) or explicitly overrides an axis on the
   *  Layer's own variable face (the resolved pair). A static face stores
   *  neither — its bytes fix the look — and a run sharing the Layer's face
   *  without explicit axes inherits the Layer's axes. */
  weight?: number;
  width?: number;
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

/** The transform angles' domain (#298): tangent diverges at ±90°, and a ±90°
 *  perspective tilt is edge-on, so both facts' angles are bounded away from
 *  it. One home for the bound: the parser, the resolver, and the stored
 *  reader all enforce it. */
export const TRANSFORM_ANGLE_BOUND = 89;

/** Canonical normalized transform skew: the one shape every consumer reads. */
export interface LayerTransformSkew {
  skewXDeg: number;
  skewYDeg: number;
}

/**
 * Canonical stored-skew validation and normalization (#298, ADR-0016
 * amendment). The one normalization boundary for transform skew: documents
 * written before #298 lack the fields (only a missing field is absent — a
 * present `null` or any other non-number is a malformed document, never a
 * silent default) and normalize to 0 here; every downstream reader projects
 * through this function and never re-derives a default. A present pair must
 * be two finite angles within the ±89° bound, recorded together like flip.
 * The identity form is never stored (stored only when set), but a present
 * `0x0` document still reads as the identity it is.
 */
export function normalizeStoredSkew(revision: {
  skewXDeg?: unknown;
  skewYDeg?: unknown;
}): LayerTransformSkew {
  const hasX = revision.skewXDeg !== undefined;
  const hasY = revision.skewYDeg !== undefined;
  if (hasX !== hasY) {
    throw new Error(
      `Malformed revision document: skewXDeg and skewYDeg must be present together (got skewXDeg ${JSON.stringify(revision.skewXDeg)}, skewYDeg ${JSON.stringify(revision.skewYDeg)}).`,
    );
  }
  if (!hasX) {
    return { skewXDeg: 0, skewYDeg: 0 };
  }
  const skewXDeg = revision.skewXDeg;
  const skewYDeg = revision.skewYDeg;
  if (
    typeof skewXDeg !== "number" || !Number.isFinite(skewXDeg) || Math.abs(skewXDeg) > TRANSFORM_ANGLE_BOUND ||
    typeof skewYDeg !== "number" || !Number.isFinite(skewYDeg) || Math.abs(skewYDeg) > TRANSFORM_ANGLE_BOUND
  ) {
    throw new Error(
      `Malformed revision document: skewXDeg and skewYDeg must be finite angles between -${TRANSFORM_ANGLE_BOUND} and ${TRANSFORM_ANGLE_BOUND} degrees when present (got ${JSON.stringify(revision.skewXDeg)}, ${JSON.stringify(revision.skewYDeg)}).`,
    );
  }
  return { skewXDeg, skewYDeg };
}

/** Canonical normalized transform perspective: the one shape every consumer reads. */
export interface LayerTransformPerspective {
  perspectiveTiltXDeg: number;
  perspectiveTiltYDeg: number;
}

/** The one perspective distance (#298): a fixed documented constant, never
 *  a stored fact — the projection is `perspective(1000px)` applied
 *  outermost, after the tilt about the content centre. */
export const PERSPECTIVE_DISTANCE_PX = 1000;

/**
 * Canonical stored-perspective validation and normalization (#298, ADR-0016
 * amendment). The one normalization boundary for the perspective tilt: the
 * same rules as skew — absent normalizes to 0, a present pair must be two
 * finite angles within the ±89° bound, recorded together.
 */
export function normalizeStoredPerspective(revision: {
  perspectiveTiltXDeg?: unknown;
  perspectiveTiltYDeg?: unknown;
}): LayerTransformPerspective {
  const hasX = revision.perspectiveTiltXDeg !== undefined;
  const hasY = revision.perspectiveTiltYDeg !== undefined;
  if (hasX !== hasY) {
    throw new Error(
      `Malformed revision document: perspectiveTiltXDeg and perspectiveTiltYDeg must be present together (got perspectiveTiltXDeg ${JSON.stringify(revision.perspectiveTiltXDeg)}, perspectiveTiltYDeg ${JSON.stringify(revision.perspectiveTiltYDeg)}).`,
    );
  }
  if (!hasX) {
    return { perspectiveTiltXDeg: 0, perspectiveTiltYDeg: 0 };
  }
  const perspectiveTiltXDeg = revision.perspectiveTiltXDeg;
  const perspectiveTiltYDeg = revision.perspectiveTiltYDeg;
  if (
    typeof perspectiveTiltXDeg !== "number" || !Number.isFinite(perspectiveTiltXDeg) || Math.abs(perspectiveTiltXDeg) > TRANSFORM_ANGLE_BOUND ||
    typeof perspectiveTiltYDeg !== "number" || !Number.isFinite(perspectiveTiltYDeg) || Math.abs(perspectiveTiltYDeg) > TRANSFORM_ANGLE_BOUND
  ) {
    throw new Error(
      `Malformed revision document: perspectiveTiltXDeg and perspectiveTiltYDeg must be finite angles between -${TRANSFORM_ANGLE_BOUND} and ${TRANSFORM_ANGLE_BOUND} degrees when present (got ${JSON.stringify(revision.perspectiveTiltXDeg)}, ${JSON.stringify(revision.perspectiveTiltYDeg)}).`,
    );
  }
  return { perspectiveTiltXDeg, perspectiveTiltYDeg };
}

/** Effect parameter bounds (#139/#140, ADR-0018/0019): a bounded effect
 * footprint, so painted-extent capture stays bounded (DEC-006). Shadow
 * offsets may be negative. */
const MAX_SHADOW_OFFSET_PX = 256;
const MAX_SHADOW_BLUR_PX = 256;
const MAX_OUTLINE_WIDTH_PX = 256;
/** The blur radius bound (#299, ADR-0024 amendment): the same bounded-effect
 *  footprint the other effects keep, so painted-extent capture stays bounded
 *  (DEC-006). Exported for the option-table boundary parse — the ONE grammar
 *  both command surfaces run. */
export const MAX_BLUR_RADIUS_PX = 256;
/** The edge choke and feather radius bound (#300, ADR-0024 amendment): the
 *  same bounded-effect footprint the other effects keep, so painted-extent
 *  capture stays bounded (DEC-006); the choke's erode also chains under the
 *  raster morphology cap the outline/glow share. Exported for the
 *  option-table boundary parse — the ONE grammar both command surfaces run. */
export const MAX_EDGE_RADIUS_PX = 256;

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
 * The stored stack fold for a repeatable effect field (#302, spec #285
 * US-011, ISC-50, DEC-005, ADR-0027): ONE canonical home per fact — one
 * effect stores today's single object; two or more store a list in the
 * SAME field, in paint order. A stored length-1 list would be a second
 * answer for the same fact (the object form IS the one-effect shape), so
 * it is a malformed document, refused loudly (the #297 text-runs
 * precedent). Absence IS the no-effect form. Both stored normalizers fold
 * through this one helper; the hash and the reach reader work on the same
 * shapes.
 */
function foldStoredEffectStack<T>(
  raw: unknown,
  label: string,
  validate: (entry: unknown, label: string) => T,
): T[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (Array.isArray(raw)) {
    if (raw.length < 2) {
      throw new Error(
        `Malformed revision document: ${label} must be the single object form when one effect is stored — a one-element list is a second answer for the same fact (got ${JSON.stringify(raw)}).`,
      );
    }
    return raw.map((entry, i) => validate(entry, `${label}[${i + 1}]`));
  }
  return [validate(raw, label)];
}

/**
 * Canonical stored-shadow validation and normalization (#139, ADR-0018;
 * stacking #302, ADR-0027). The one normalization boundary for the shadow
 * effect: documents written before #139 lack the field, and absence IS the
 * canonical no-shadow form — every downstream reader projects through this
 * function and never re-derives a default. A present field is the stored
 * stack fold: a valid shadow object (finite `dx`/`dy` within the offset
 * cap, finite `blur` ≥ 0 within the blur cap, and a hex `color`
 * (#RGB/#RRGGBB/#RRGGBBAA)) or a list of two or more of them in paint
 * order — anything else is a malformed document, refused loudly before the
 * revision hash is consulted. Returns the normalized LIST a stack reader
 * consumes (one shadow folds to a one-element list).
 */
export function normalizeStoredShadow(revision: { shadow?: unknown }): LayerShadow[] | undefined {
  return foldStoredEffectStack(revision.shadow, "shadow", validateStoredShadowObject);
}

/** One stored shadow object's validation, label-parameterized so a stack
 *  entry's failure names its position (`shadow[2].dx`). */
function validateStoredShadowObject(raw: unknown, label: string): LayerShadow {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Malformed revision document: ${label} must be a shadow object when present (got ${JSON.stringify(raw)}).`,
    );
  }
  const { dx, dy, blur, color } = raw as Record<string, unknown>;
  for (const [name, value] of [["dx", dx], ["dy", dy]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_SHADOW_OFFSET_PX) {
      throw new Error(
        `Malformed revision document: ${label}.${name} must be a finite number of px within ±${MAX_SHADOW_OFFSET_PX} (got ${JSON.stringify(value)}).`,
      );
    }
  }
  if (typeof blur !== "number" || !Number.isFinite(blur) || blur < 0 || blur > MAX_SHADOW_BLUR_PX) {
    throw new Error(
      `Malformed revision document: ${label}.blur must be a finite number of px between 0 and ${MAX_SHADOW_BLUR_PX} (got ${JSON.stringify(blur)}).`,
    );
  }
  if (typeof color !== "string" || !EFFECT_COLOR_PATTERN.test(color)) {
    throw new Error(
      `Malformed revision document: ${label}.color must be a hex color like #000000, #000, or #00000080 (got ${JSON.stringify(color)}).`,
    );
  }
  return { dx, dy, blur, color } as LayerShadow;
}

/**
 * Canonical stored-outline validation and normalization (#140, ADR-0019;
 * stacking #302, ADR-0027). The one normalization boundary for the outline
 * effect: documents written before #140 lack the field, and absence IS the
 * canonical no-outline form — every downstream reader projects through this
 * function and never re-derives a default. A present field is the stored
 * stack fold: a valid outline object (finite `width` ≥ 0 within the width
 * cap and a hex `color`) or a list of two or more of them in paint order —
 * anything else is a malformed document, refused loudly before the revision
 * hash is consulted. Returns the normalized LIST a stack reader consumes.
 */
export function normalizeStoredOutline(revision: { outline?: unknown }): LayerOutline[] | undefined {
  return foldStoredEffectStack(revision.outline, "outline", validateStoredOutlineObject);
}

/** One stored outline object's validation, label-parameterized like the
 *  shadow's (`outline[2].width`). */
function validateStoredOutlineObject(raw: unknown, label: string): LayerOutline {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Malformed revision document: ${label} must be an outline object when present (got ${JSON.stringify(raw)}).`,
    );
  }
  const { width, color } = raw as Record<string, unknown>;
  if (typeof width !== "number" || !Number.isFinite(width) || width < 0 || width > MAX_OUTLINE_WIDTH_PX) {
    throw new Error(
      `Malformed revision document: ${label}.width must be a finite number of px between 0 and ${MAX_OUTLINE_WIDTH_PX} (got ${JSON.stringify(width)}).`,
    );
  }
  if (typeof color !== "string" || !EFFECT_COLOR_PATTERN.test(color)) {
    throw new Error(
      `Malformed revision document: ${label}.color must be a hex color like #000000, #000, or #00000080 (got ${JSON.stringify(color)}).`,
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

/**
 * Canonical stored-grade validation and normalization (#219, spec #218 US-001,
 * ADR-0024). The one normalization boundary for the grade fact: documents
 * written before #219 lack the field, and absence IS the canonical no-grade
 * form — every downstream reader projects through this function and never
 * re-derives a default.
 *
 * Stored controls must be finite numbers in their documented ranges:
 * - brightness: 0..5 (neutral 1)
 * - contrast: 0..5 (neutral 1)
 * - saturation: 0..5 (neutral 1)
 * - warmth: -1..1 (neutral 0)
 *
 * Neutral values are dropped (neutral removes the fact); an object with only
 * neutral values normalizes to undefined. Extra or non-numeric properties are
 * refused loudly as malformed documents before the revision hash is consulted.
 */
export function normalizeStoredGrade(revision: { grade?: unknown }): LayerGrade | undefined {
  if (revision.grade === undefined) {
    return undefined;
  }
  const raw = revision.grade;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Malformed revision document: grade must be an object when present (got ${JSON.stringify(raw)}).`,
    );
  }
  const rawObj = raw as Record<string, unknown>;
  const allowedKeys = new Set(["brightness", "contrast", "saturation", "warmth"]);
  for (const key of Object.keys(rawObj)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `Malformed revision document: unknown grade property ${JSON.stringify(key)}.`,
      );
    }
  }
  const { brightness, contrast, saturation, warmth } = rawObj;
  const normalized: LayerGrade = {};
  if (brightness !== undefined) {
    if (typeof brightness !== "number" || !Number.isFinite(brightness) || brightness < 0 || brightness > 5) {
      throw new Error(
        `Malformed revision document: grade.brightness must be a finite number between 0 and 5 when present (got ${JSON.stringify(brightness)}).`,
      );
    }
    if (brightness !== 1) {
      normalized.brightness = brightness;
    }
  }
  if (contrast !== undefined) {
    if (typeof contrast !== "number" || !Number.isFinite(contrast) || contrast < 0 || contrast > 5) {
      throw new Error(
        `Malformed revision document: grade.contrast must be a finite number between 0 and 5 when present (got ${JSON.stringify(contrast)}).`,
      );
    }
    if (contrast !== 1) {
      normalized.contrast = contrast;
    }
  }
  if (saturation !== undefined) {
    if (typeof saturation !== "number" || !Number.isFinite(saturation) || saturation < 0 || saturation > 5) {
      throw new Error(
        `Malformed revision document: grade.saturation must be a finite number between 0 and 5 when present (got ${JSON.stringify(saturation)}).`,
      );
    }
    if (saturation !== 1) {
      normalized.saturation = saturation;
    }
  }
  if (warmth !== undefined) {
    if (typeof warmth !== "number" || !Number.isFinite(warmth) || warmth < -1 || warmth > 1) {
      throw new Error(
        `Malformed revision document: grade.warmth must be a finite number between -1 and 1 when present (got ${JSON.stringify(warmth)}).`,
      );
    }
    if (warmth !== 0) {
      normalized.warmth = warmth;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function gradeEq(a: LayerGrade | undefined, b: LayerGrade | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.brightness === b.brightness &&
    a.contrast === b.contrast &&
    a.saturation === b.saturation &&
    a.warmth === b.warmth
  );
}

export function formatGrade(grade: LayerGrade): string {
  const parts: string[] = [];
  if (grade.brightness !== undefined) parts.push(`brightness ${grade.brightness}`);
  if (grade.contrast !== undefined) parts.push(`contrast ${grade.contrast}`);
  if (grade.saturation !== undefined) parts.push(`saturation ${grade.saturation}`);
  if (grade.warmth !== undefined) parts.push(`warmth ${grade.warmth}`);
  return parts.join(", ");
}

/**
 * Canonical stored blend-mode validation and normalization (#220, spec #218 US-003,
 * ADR-0024). The one normalization boundary for the blend mode fact: documents
 * written before #220 lack the field, and absence IS the canonical normal/no-blend
 * form — every downstream reader projects through this function and never
 * re-derives a default.
 *
 * 'normal' drops the fact; an unknown or non-string property is refused loudly
 * as a malformed document before the revision hash is consulted.
 */
export function normalizeStoredBlend(revision: { blend?: unknown }): StoredLayerBlendMode | undefined {
  if (revision.blend === undefined) {
    return undefined;
  }
  const raw = revision.blend;
  if (typeof raw !== "string") {
    throw new Error(
      `Malformed revision document: blend must be a string when present (got ${JSON.stringify(raw)}).`,
    );
  }
  if (raw === "normal") {
    return undefined;
  }
  if (!LAYER_BLEND_MODES.includes(raw as LayerBlendMode)) {
    throw new Error(
      `Malformed revision document: unknown blend mode ${JSON.stringify(raw)}.`,
    );
  }
  return raw as StoredLayerBlendMode;
}

/**
 * The largest edge-glow width and softness in px (#221, spec #218 US-002):
 * the same bound the outline width uses (ADR-0019) — the effect footprint
 * stays bounded, and one number reads the same in help, the limits guide,
 * and every refusal.
 */
export const MAX_GLOW_PX = 256;

/**
 * Canonical stored edge-glow validation and normalization (#221, spec #218
 * US-002, ADR-0024). The one normalization boundary for the glow fact:
 * documents written before #221 lack the field, and absence IS the canonical
 * no-glow form — every downstream reader projects through this function and
 * never re-derives a default.
 *
 * Stored parameters must be:
 * - `width` and `softness`: finite numbers between 0 and MAX_GLOW_PX.
 * - `color`: a hex colour (#RGB/#RRGGBB/#RRGGBBAA).
 * - `angle` and `strength`: an optional PAIR — a finite angle within
 *   ±360 degrees (clockwise from top) and a finite strength between 0 and 1.
 *   One without the other is a malformed document; strength 0 (an even
 *   glow) drops the pair, the same neutral-dropping rule the setter applies.
 *   This pair is the LEGACY direction model (the offset model): its stored
 *   meaning never changes (#301, DEC-008).
 * - `direction`: the optional one-sided direction model (#301, ISC-53,
 *   DEC-008) — an object `{ angle, strength }` with the same ranges and the
 *   same strength-0 neutral rule. Mutually exclusive with the legacy pair:
 *   a document carrying both forms is malformed. Canonicalizes its angle
 *   into [0, 360), the same canonical direction form.
 *
 * Extra or non-conformant properties are refused loudly as malformed
 * documents before the revision hash is consulted.
 */
export function normalizeStoredGlow(revision: { glow?: unknown }): LayerGlow | undefined {
  if (revision.glow === undefined) {
    return undefined;
  }
  const raw = revision.glow;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Malformed revision document: glow must be an object when present (got ${JSON.stringify(raw)}).`,
    );
  }
  const rawObj = raw as Record<string, unknown>;
  const allowedKeys = new Set(["width", "softness", "color", "angle", "strength", "direction"]);
  for (const key of Object.keys(rawObj)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `Malformed revision document: unknown glow property ${JSON.stringify(key)}.`,
      );
    }
  }
  const { width, softness, color, angle, strength, direction } = rawObj;
  if (typeof width !== "number" || !Number.isFinite(width) || width < 0 || width > MAX_GLOW_PX) {
    throw new Error(
      `Malformed revision document: glow.width must be a finite number between 0 and ${MAX_GLOW_PX} when present (got ${JSON.stringify(width)}).`,
    );
  }
  if (typeof softness !== "number" || !Number.isFinite(softness) || softness < 0 || softness > MAX_GLOW_PX) {
    throw new Error(
      `Malformed revision document: glow.softness must be a finite number between 0 and ${MAX_GLOW_PX} when present (got ${JSON.stringify(softness)}).`,
    );
  }
  if (typeof color !== "string" || !EFFECT_COLOR_PATTERN.test(color)) {
    throw new Error(
      `Malformed revision document: glow.color must be a hex colour like #000000, #000, or #00000080 when present (got ${JSON.stringify(color)}).`,
    );
  }
  const normalized: LayerGlow = {
    width,
    softness,
    color: canonicalizeEffectColor(color),
  };
  if (angle !== undefined || strength !== undefined) {
    if (direction !== undefined) {
      throw new Error(
        "Malformed revision document: the glow direction is one model — the legacy angle/strength pair and the one-sided direction cannot be combined.",
      );
    }
    if (angle === undefined || strength === undefined) {
      throw new Error(
        "Malformed revision document: glow.angle and glow.strength are one direction pair — both must be present or both absent.",
      );
    }
    if (
      typeof angle !== "number" ||
      !Number.isFinite(angle) ||
      angle < -360 ||
      angle > 360 ||
      typeof strength !== "number" ||
      !Number.isFinite(strength) ||
      strength < 0 ||
      strength > 1
    ) {
      throw new Error(
        `Malformed revision document: glow.angle must be a finite number between -360 and 360 and glow.strength a finite number between 0 and 1 when present (got ${JSON.stringify(angle)}, ${JSON.stringify(strength)}).`,
      );
    }
    if (strength !== 0) {
      // Canonical direction form: the angle in [0, 360) — the same paint as
      // any equivalent spelling, so equivalent directions cannot mint
      // redundant revisions.
      normalized.angle = ((angle % 360) + 360) % 360;
      normalized.strength = strength;
    }
  }
  if (direction !== undefined) {
    if (!direction || typeof direction !== "object" || Array.isArray(direction)) {
      throw new Error(
        `Malformed revision document: glow.direction must be an object when present (got ${JSON.stringify(direction)}).`,
      );
    }
    const directionObj = direction as Record<string, unknown>;
    const directionAllowed = new Set(["angle", "strength"]);
    for (const key of Object.keys(directionObj)) {
      if (!directionAllowed.has(key)) {
        throw new Error(
          `Malformed revision document: unknown glow.direction property ${JSON.stringify(key)}.`,
        );
      }
    }
    const { angle: dAngle, strength: dStrength } = directionObj;
    if (dAngle === undefined || dStrength === undefined) {
      throw new Error(
        "Malformed revision document: glow.direction.angle and glow.direction.strength are one pair — both must be present.",
      );
    }
    if (
      typeof dAngle !== "number" ||
      !Number.isFinite(dAngle) ||
      dAngle < -360 ||
      dAngle > 360 ||
      typeof dStrength !== "number" ||
      !Number.isFinite(dStrength) ||
      dStrength < 0 ||
      dStrength > 1
    ) {
      throw new Error(
        `Malformed revision document: glow.direction.angle must be a finite number between -360 and 360 and glow.direction.strength a finite number between 0 and 1 when present (got ${JSON.stringify(dAngle)}, ${JSON.stringify(dStrength)}).`,
      );
    }
    if (dStrength !== 0) {
      // The same canonical direction form and the same strength-0 neutral
      // rule as the legacy pair.
      normalized.direction = { angle: ((dAngle % 360) + 360) % 360, strength: dStrength };
    }
  }
  return normalized;
}

export function glowEq(a: LayerGlow | undefined, b: LayerGlow | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.width === b.width &&
    a.softness === b.softness &&
    a.color === b.color &&
    a.angle === b.angle &&
    a.strength === b.strength &&
    a.direction?.angle === b.direction?.angle &&
    a.direction?.strength === b.direction?.strength
  );
}

export function formatGlow(glow: LayerGlow): string {
  const direction =
    glow.direction !== undefined
      ? `, one-sided from ${glow.direction.angle}° (strength ${glow.direction.strength})`
      : glow.angle !== undefined
        ? `, from ${glow.angle}° (strength ${glow.strength})`
        : "";
  return `glow width ${glow.width}px, softness ${glow.softness}px, ${glow.color}${direction}`;
}

/**
 * Canonical stored-blur validation and normalization (#299, spec #285
 * US-010, DEC-005, ADR-0024 amendment). The one normalization boundary for
 * the blur fact: documents written before #299 lack the field, and absence
 * IS the canonical no-blur form — a stored `0` normalizes to `undefined`,
 * keeping the identity out of every stored document and hash. A present
 * value must be a finite number of px in (0, MAX_BLUR_RADIUS_PX].
 */
export function normalizeStoredBlur(revision: { blur?: unknown }): number | undefined {
  if (revision.blur === undefined) return undefined;
  const raw = revision.blur;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > MAX_BLUR_RADIUS_PX) {
    throw new Error(
      `Malformed revision document: blur must be a finite number of px between 0 (exclusive, the removal form) and ${MAX_BLUR_RADIUS_PX} when present (got ${JSON.stringify(raw)}).`,
    );
  }
  return raw;
}

/** Canonical stored-choke validation and normalization (#300, spec #285
 * US-013, DEC-005, ADR-0024 amendment). The one normalization boundary for
 * the choke fact, mirror of `normalizeStoredBlur`: documents written before
 * #300 lack the field, and absence IS the canonical no-choke form — a
 * stored `0` normalizes to `undefined`, keeping the identity out of every
 * stored document and hash. A present value must be a finite number of px
 * in (0, MAX_EDGE_RADIUS_PX]. */
export function normalizeStoredChoke(revision: { choke?: unknown }): number | undefined {
  if (revision.choke === undefined) return undefined;
  const raw = revision.choke;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > MAX_EDGE_RADIUS_PX) {
    throw new Error(
      `Malformed revision document: choke must be a finite number of px between 0 (exclusive, the removal form) and ${MAX_EDGE_RADIUS_PX} when present (got ${JSON.stringify(raw)}).`,
    );
  }
  return raw;
}

/** Canonical stored-feather validation and normalization (#300, spec #285
 * US-013, DEC-005, ADR-0024 amendment). The one normalization boundary for
 * the feather fact, mirror of `normalizeStoredChoke`: absence IS the
 * canonical no-feather form — a stored `0` normalizes to `undefined`. A
 * present value must be a finite number of px in (0, MAX_EDGE_RADIUS_PX]. */
export function normalizeStoredFeather(revision: { feather?: unknown }): number | undefined {
  if (revision.feather === undefined) return undefined;
  const raw = revision.feather;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > MAX_EDGE_RADIUS_PX) {
    throw new Error(
      `Malformed revision document: feather must be a finite number of px between 0 (exclusive, the removal form) and ${MAX_EDGE_RADIUS_PX} when present (got ${JSON.stringify(raw)}).`,
    );
  }
  return raw;
}

/** The resolved effect fields (#302, ADR-0027): the stored stack fold is
 *  resolved at the ONE ingestion point into the normalized lists every
 *  reader consumes — a one-effect document resolves to a one-element list.
 *  The stored document keeps its fold; the resolved view never re-folds. */
type ResolvedEffectStacks = {
  shadow?: LayerShadow[];
  outline?: LayerOutline[];
};

export type ResolvedLayerRevision =
  | (Omit<LayerImageRevision, "shadow" | "outline"> & ResolvedEffectStacks & { revisionId: string; format: "png" | "jpeg" | "webp" | "svg"; width: number; height: number; bytes: number; scaleX: number; scaleY: number; rotationDeg: number; flipX: boolean; flipY: boolean; skewXDeg: number; skewYDeg: number; perspectiveTiltXDeg: number; perspectiveTiltYDeg: number })
  | (Omit<LayerTextRevision, "shadow" | "outline"> & ResolvedEffectStacks & { revisionId: string; fontBytes: number; scaleX: number; scaleY: number; rotationDeg: number; flipX: boolean; flipY: boolean; skewXDeg: number; skewYDeg: number; perspectiveTiltXDeg: number; perspectiveTiltYDeg: number; layoutRule: NormalizedTextLayoutRule })
  | (Omit<LayerShapeRevision, "shadow" | "outline"> & ResolvedEffectStacks & { revisionId: string; scaleX: number; scaleY: number; rotationDeg: number; flipX: boolean; flipY: boolean; skewXDeg: number; skewYDeg: number; perspectiveTiltXDeg: number; perspectiveTiltYDeg: number });

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
 * Canonical text content validation (#81, #222): one home for the text facts every
 * writer and reader must agree on. Ingestion and the stored-revision parser
 * both call this, so no alternate representation can drift. Text colour and gradient
 * are one fact (DEC-008): a solid colour string or gradient object resolves through
 * the single fill normalizer (normalizeStoredTextFill), returning the canonical LayerFill.
 */
export function validateTextContent(text: unknown, fontSize: unknown, color: unknown): LayerFill {
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
  if (color === undefined || color === null) {
    throw new Error(`Invalid --color: must be a hex color like #ffffff or #fff, or a gradient fill.`);
  }
  if (typeof color !== "string" && (typeof color !== "object" || Array.isArray(color))) {
    throw new Error(`Invalid --color "${String(color)}": must be a hex color like #ffffff or #fff, or a gradient fill.`);
  }
  return normalizeStoredTextFill(color);
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
 * The ONE validator/normalizer for the text WRAP WIDTH control (#294, spec
 * #285 US-015, ISC-55, DEC-001/DEC-005, ADR-0017 amendment) — the single
 * home the add path, the edit path, and both CLI boundaries share, so the
 * boundaries never disagree. The width is an ABSOLUTE setter in layout px,
 * font-independent: a positive finite number up to the shared 8192px
 * per-axis bound (`MAX_DIMENSION` — the same cap as font-size and the
 * resize/scale forms; a larger value is refused before anything is
 * published, because the width interpolates into the paint markup and an
 * over-cap box can only hang or OOM the render). `null` clears the stored
 * width (the documented removal value "none" at the command boundary);
 * `undefined` means not given (an omitted option carries the current
 * value). The resolved form is always storable: the width is stored only
 * when set — absence IS the no-wrap-width form, so the resolved fields are
 * never 0 or negative. Every refusal names the control, and fires before
 * anything is published.
 */
export function resolveTextWrapWidthControl(value: number | null | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error('Wrap width (--wrap-width) must be a finite number of layout px or "none".');
  }
  if (value <= 0 || value > MAX_DIMENSION) {
    throw new Error(
      `Wrap width (--wrap-width) must be a finite number between 1 and ${MAX_DIMENSION} layout px — ${value} is out of range.`,
    );
  }
  return value;
}

/**
 * Canonical stored-wrap-width validation and normalization (#294, spec
 * #285 US-015, ISC-55, DEC-001/DEC-005). The ONE normalization boundary AND
 * the one reader for a revision's wrap width: documents written before
 * #294 lack the field (only a missing field is absent — a present `null`
 * or any other non-number is a malformed document, never a silent
 * default); every downstream reader — revision resolution, the revision
 * hash, paint markup, measurement, and the edit carry path — projects
 * through this function and never re-derives the fact. Present only when
 * set, a positive finite number inside the shared 8192px per-axis bound —
 * an over-cap field is a malformed document, refused loudly before the
 * render can hang on it.
 */
export function normalizeStoredTextWrapWidth(revision: {
  wrapWidth?: unknown;
}): number | undefined {
  const value = revision.wrapWidth;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_DIMENSION) {
    throw new Error(
      `Malformed revision document: text wrap width must be a finite number between 1 and ${MAX_DIMENSION} when present (got ${JSON.stringify(value)}).`,
    );
  }
  return value;
}

/**
 * The fit box's minimum font size (#295, spec #285 US-016, DEC-010): a
 * documented fixed floor. Fit-to-box shrinks the stored font size only, and
 * never below this floor — text that would need a smaller size to fit is
 * refused on add and edit, naming the box and the size needed. One home for
 * the number: the derivation pass, the refusal builder, and the docs all
 * read it from here.
 */
export const MIN_FIT_FONT_SIZE = 8;

/** The stored/normalized shape of a fit box. */
export interface TextFitBox {
  width: number;
  height: number;
}

/**
 * The fit box control resolver (#295, spec #285 US-016, DEC-010/DEC-005).
 * The ONE domain-boundary validation for the `--fit-box <WxH|none>` control:
 * a set value is a pair of finite numbers in (0, MAX_DIMENSION] layout px —
 * refused before anything is published, because the box feeds the one
 * in-page fit derivation that every read runs. `null` clears the stored box
 * (the documented removal value "none" at the command boundary);
 * `undefined` means not given (an omitted option carries the current
 * value). The resolved form is always storable: the box is stored only when
 * set — absence IS the no-box form. Every refusal names the control, and
 * fires before anything is published.
 */
export function resolveTextFitBoxControl(value: TextFitBox | null | undefined): TextFitBox | undefined {
  if (value === undefined || value === null) return undefined;
  const { width, height } = value;
  if (
    typeof width !== "number" || !Number.isFinite(width) || width <= 0 || width > MAX_DIMENSION ||
    typeof height !== "number" || !Number.isFinite(height) || height <= 0 || height > MAX_DIMENSION
  ) {
    throw new Error(
      `Fit box (--fit-box) must be two finite numbers between 1 and ${MAX_DIMENSION} layout px — ${JSON.stringify(value)} is out of range.`,
    );
  }
  return { width, height };
}

/**
 * Canonical stored-fit-box validation and normalization (#295, spec #285
 * US-016, DEC-010/DEC-005). The ONE normalization boundary AND the one
 * reader for a revision's fit box: documents written before #295 lack the
 * fields (only a missing field is absent — a present non-number, a partial
 * pair, or any other shape is a malformed document, never a silent
 * default); every downstream reader — revision resolution, the revision
 * hash, paint markup, measurement, and the edit carry path — projects
 * through this function and never re-derives the fact. Both fields present
 * together, positive finite numbers inside the shared 8192px per-axis
 * bound.
 */
export function normalizeStoredTextFitBox(revision: {
  fitWidth?: unknown;
  fitHeight?: unknown;
}): TextFitBox | undefined {
  const { fitWidth, fitHeight } = revision;
  if (fitWidth === undefined && fitHeight === undefined) return undefined;
  if (
    typeof fitWidth !== "number" || !Number.isFinite(fitWidth) || fitWidth <= 0 || fitWidth > MAX_DIMENSION ||
    typeof fitHeight !== "number" || !Number.isFinite(fitHeight) || fitHeight <= 0 || fitHeight > MAX_DIMENSION
  ) {
    throw new Error(
      `Malformed revision document: text fit box must be a pair of finite numbers between 1 and ${MAX_DIMENSION} when present (got ${JSON.stringify({ fitWidth, fitHeight })}).`,
    );
  }
  return { width: fitWidth, height: fitHeight };
}

/**
 * The fit/wrap combination rule (#295, spec #285 US-016): when both a wrap
 * width and a fit box are set, the box bounds the WRAPPED block — the wrap
 * width stays the wrapping width and the box height bounds the wrapped
 * block's height. A fit box NARROWER than the wrap width can therefore
 * never be satisfied (a wrapped block can be up to its wrap width wide),
 * so it is refused at the set-time boundary, naming both values and the
 * fix. One shared wording for both surfaces; the effective values are
 * compared (an omitted option carries its current value across an edit).
 */
export function textFitBoxNarrowerThanWrapRefusal(fitWidth: number, wrapWidth: number): string {
  return (
    `Fit box (--fit-box) width ${fitWidth}px is narrower than the wrap width ${wrapWidth}px: a wrapped block can be up to its wrap width wide, so it could never fit — widen the fit box to at least the wrap width.`
  );
}

/**
 * The one below-minimum fit refusal builder (#295, spec #285 US-016):
 * text that cannot fit its box at the documented minimum font size is
 * refused on add and edit, naming the box and the size needed. One shared
 * wording for both surfaces — the add path and the edit path call this
 * with the same derived facts, so their refusals never disagree.
 */
export function textFitRefusal(text: string, fitWidth: number, fitHeight: number, neededFontSize: number): string {
  const cause =
    neededFontSize < MIN_FIT_FONT_SIZE
      ? `fitting needs a ${neededFontSize}px font size, below the ${MIN_FIT_FONT_SIZE}px fit minimum`
      : `even at the ${MIN_FIT_FONT_SIZE}px fit minimum the block overflows the box`;
  return (
    `Text ${JSON.stringify(text)} cannot fit its ${fitWidth}×${fitHeight}px box: ${cause}. ` +
    `Shorten the text or enlarge the box (--fit-box).`
  );
}

/**
 * The one run-boundary guard (#297): a boundary is a character index into
 * `text` that must not split a surrogate pair — a boundary between the two
 * code units of one astral character would store a corrupt slice (half a
 * glyph). Shared by the stored-document reader and the edit application, so
 * both ingestion paths refuse identically.
 */
export function assertRunBoundary(text: string, start: number, what: string): void {
  if (start < 1 || start > text.length) return; // range rules own these cases
  const prev = text.charCodeAt(start - 1);
  const next = start < text.length ? text.charCodeAt(start) : 0;
  if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    throw new Error(
      `${what} ${start} would split a surrogate pair — a run boundary cannot fall between the two code units of one character.`,
    );
  }
}

/**
 * Canonical stored-text-run validation and normalization (#297, spec #285
 * US-017, ISC-54, ADR-0021 amendment). The ONE reader for a revision's
 * `runs`: documents written before #297 lack the field, and absence IS the
 * single-run form — every downstream reader (paint, measure, hashing, the
 * edit paths) projects through this function and never re-derives a
 * boundary. A present field must be an ordered array of TWO OR MORE entries
 * (fewer normalizes away at the ingestion point, so it can never be stored):
 * entry 1 stores no `start` (it begins at character 0); every later entry
 * stores a finite integer `start`, strictly increasing and within the text
 * (every run nonempty, the last run reaching the end). Each entry's colour
 * validates through the ONE text-colour reader, its caller font facts
 * through the ONE caller-font reader, and its axes through the ONE stored
 * axes reader — anything else is a malformed document, refused loudly
 * before the revision hash is consulted.
 */
export function normalizeStoredTextRuns(revision: {
  text: unknown;
  runs?: unknown;
}): LayerTextRun[] | undefined {
  const raw = revision.runs;
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error(
      `Malformed revision document: text runs must be an array of two or more run entries (got ${JSON.stringify(raw)}).`,
    );
  }
  if (typeof revision.text !== "string") {
    throw new Error("Malformed revision document: text runs require stored text content.");
  }
  const text = revision.text;
  const runs: LayerTextRun[] = [];
  let prevStart = 0;
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Malformed revision document: text run ${i + 1} must be an object (got ${JSON.stringify(entry)}).`);
    }
    const e = entry as Record<string, unknown>;
    let start: number | undefined;
    if (i === 0) {
      // Entry 1 begins at character 0: a stored start would be a second
      // answer for the same fact.
      if (e.start !== undefined) {
        throw new Error("Malformed revision document: text run 1 begins at character 0 and stores no start.");
      }
    } else {
      const value = e.start;
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(
          `Malformed revision document: text run ${i + 1} start must be an integer character index (got ${JSON.stringify(value)}).`,
        );
      }
      if (value <= prevStart || value >= text.length) {
        throw new Error(
          `Malformed revision document: text run ${i + 1} start ${value} is out of order or would make a run empty (text is ${text.length} characters).`,
        );
      }
      assertRunBoundary(text, value, `Malformed revision document: text run ${i + 1} start`);
      start = value;
      prevStart = value;
    }
    if (e.contentHash !== undefined && (typeof e.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(e.contentHash))) {
      throw new Error(
        `Malformed revision document: text run ${i + 1} contentHash is not a sha-256 digest (got ${JSON.stringify(e.contentHash)}).`,
      );
    }
    // The stored colour is validated through the ONE reader but kept
    // verbatim: a solid stays the canonical hex string it was stored as
    // (one form per look — the stored form IS the paint), a gradient its
    // canonical object.
    if (e.color !== undefined) normalizeStoredTextFill(e.color);
    runs.push({
      ...(start !== undefined ? { start } : {}),
      ...(e.color !== undefined ? { color: e.color as string | LayerFill } : {}),
      ...(e.contentHash !== undefined ? { contentHash: e.contentHash as string } : {}),
      ...(e.callerFont !== undefined ? { callerFont: normalizeStoredCallerFont({ callerFont: e.callerFont }) } : {}),
      ...(normalizeStoredTextAxes(e) ?? {}),
    });
  }
  return runs;
}

/**
 * The one boundary/slice projection (#297): a revision's run text slices in
 * stored order. `text` is the only home of the characters; the boundaries
 * are positions into it. Single-run revisions yield the whole text as one
 * slice, so every consumer can treat runs uniformly without consulting the
 * presence of the field twice.
 */
export function storedTextRunSlices(
  revision: Pick<LayerTextRevision, "text"> & { runs?: unknown },
): string[] {
  const runs = normalizeStoredTextRuns(revision);
  if (runs === undefined) return [revision.text as string];
  const text = revision.text as string;
  const slices: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const start = i === 0 ? 0 : runs[i]!.start!;
    const end = i + 1 < runs.length ? runs[i + 1]!.start! : text.length;
    slices.push(text.slice(start, end));
  }
  return slices;
}

/** One resolved run font: the run's own retained bytes and, for a caller
 *  font, its facts — the snapshot-side payload paint and measurement declare
 *  @font-face rules from (the same bytes/identity the layer font uses). */
export interface SnapshotRunFont {
  contentHash: string;
  bytes: Buffer;
  caller?: CallerFontFacts;
}

/**
 * Load a text revision's run font bytes (#297): every distinct run font
 * override's retained bytes from the Project content store, the same
 * hash-verified path the layer font's bytes go through. Runs sharing the
 * layer's font need no entry (the layer's own bytes serve). Empty when the
 * revision carries no run font overrides. Callers must hold the Project
 * lock; the resolved bytes are verified by identity, never trusted.
 */
export async function loadSnapshotRunFonts(
  resolvedRoot: string,
  revision: ResolvedLayerRevision,
): Promise<SnapshotRunFont[]> {
  if (revision.kind !== "text" || revision.runs === undefined) return [];
  const out: SnapshotRunFont[] = [];
  for (const run of revision.runs) {
    if (run.contentHash === undefined || run.contentHash === revision.contentHash) continue;
    if (out.some((f) => f.contentHash === run.contentHash)) continue;
    const blob = path.join(resolvedRoot, "content", run.contentHash);
    if (outsideDir(resolvedRoot, blob)) {
      throw new Error(`Security error: content blob escapes project boundary.`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(blob);
    } catch {
      throw new Error(
        `Content blob "${run.contentHash}" for layer "${revision.layerId}" missing in project.`,
      );
    }
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== run.contentHash) {
      throw new Error(
        `Corrupted content blob "${run.contentHash}" for layer "${revision.layerId}": stored bytes do not match the content hash.`,
      );
    }
    out.push({
      contentHash: run.contentHash,
      bytes,
      ...(run.callerFont !== undefined ? { caller: run.callerFont } : {}),
    });
  }
  return out;
}

/** One per-run style edit, in the CLI's merged per-index shape (#297): each
 *  present field is an ABSOLUTE setter for that run (or, with the `null`
 *  removal form, removes the run's override so the Layer default applies
 *  again). A run colour spec is the ONE `--color` grammar's raw text; the
 *  font source is a bundled family or a caller font file path — one source
 *  per run. */
export interface LayerRunStyleEdit {
  /** 1-based run index. */
  index: number;
  /** The run's colour spec (raw `--color` grammar) or null (removal). */
  colorSpec?: string | null;
  /** A bundled font family, or null (remove the font override). */
  font?: string | null;
  /** A caller font file path, or null (remove the font override). */
  fontFile?: string | null;
  weight?: number | null;
  width?: number | null;
}

/** The runs-side input of a text add (#297): the run texts whose
 *  concatenation IS the Layer text (one occurrence normalizes to the
 *  single-run form at the ONE ingestion point), plus per-run style edits by
 *  1-based index. */
export interface TextInputRuns {
  runTexts: string[];
  styles?: LayerRunStyleEdit[];
}

/**
 * The resolved runs facts of a text ingestion (#297): the canonical stored
 * entries (absent for a single run), the Layer font resolved AFTER the
 * single-run fold, the fold facts when one applies, and every run font's
 * retained bytes (retained by the caller once everything else has
 * resolved).
 */
export interface ResolvedTextInputRuns {
  /** The Layer font resolved through the ONE ingestion path, AFTER the
   *  single-run fold — a run-1 font override IS the Layer font. */
  layerFont: {
    face: FontFace;
    bytes: Buffer;
    callerFont?: CallerFontFacts;
    contentHash: string;
  };
  /** The effective Layer font input after the single-run fold. */
  layerFontInput: { font?: string; fontFile?: string };
  /** Single-run fold facts (#297): per-run style edits that leave a single
   *  run ARE the Layer's own style, folded here at the ONE ingestion point —
   *  never dropped, never pre-handled by the CLI. The colour is CANONICAL
   *  (exactly the Layer colour path's stored form); the axes are the raw
   *  explicit controls for the caller's ONE axes resolution against the
   *  folded face. */
  folded?: { color?: string | LayerFill; weight?: number; width?: number };
  /** The stored run entries — absent for a single run (today's revision
   *  shape). */
  runs?: LayerTextRun[];
  /** Run font bytes to retain (hash → bytes), resolved but NOT retained:
   *  the caller retains after every validation has passed. */
  runFonts: SnapshotRunFont[];
}

/**
 * Resolve authored text runs into their canonical stored form (#297, spec
 * #285 US-017, ISC-54, ADR-0021 amendment) — the ONE ingestion point for
 * run facts, including the single-run fold: per-run style edits that leave
 * a single run fold into the Layer-level facts here (a single-run Layer IS
 * today's text Layer — the fold is storage's fact, never the CLI's). All
 * validations and resolutions run BEFORE any retention, so a refused run
 * publishes nothing:
 * - the run texts' concatenation must equal the Layer text, and each run
 *   must be nonempty (an empty run would collapse boundaries);
 * - a style edit names an existing 1-based run (validated before the fold,
 *   so a single-run input with a run-2 setter refuses, never drops);
 * - a run colour parses through the ONE colour grammar and canonicalizes
 *   exactly like the Layer colour path's stored form;
 * - a run font resolves once (bundled face or caller file read and parsed
 *   once), one font source per run, and a caller font must pass the same
 *   browser-resolution gate the layer font passes;
 * - run axes validate against the RUN's effective face (the run's own face
 *   under a font override, the layer face otherwise) through the ONE axes
 *   resolver — a variable face stores the resolved pair, a static face
 *   stores neither (its bytes fix the look), and a run sharing the layer's
 *   face without explicit axes inherits the layer axes;
 * - a run font whose bytes equal the Layer font's is deduped: the override
 *   disappears and the run keeps the layer font (one home per fact).
 */
export async function resolveTextInputRuns(params: {
  text: string;
  runs?: TextInputRuns;
  /** The raw Layer-level font source (before any single-run fold). */
  layerFontInput: { font?: string; fontFile?: string };
  /** The raw Layer-level colour/axes controls (before any fold). */
  layerColorSpec?: string;
  layerWeight?: number;
  layerWidth?: number;
  /** The Layer font resolver — the one path the caller's publication uses,
   *  so the fold's font override resolves through the same flow. */
  resolveLayerFont: (fontInput: { font?: string; fontFile?: string }) => Promise<{
    face: FontFace;
    bytes: Buffer;
    callerFont?: CallerFontFacts;
    contentHash: string;
  }>;
}): Promise<ResolvedTextInputRuns> {
  const runs = params.runs;
  if (runs === undefined) {
    const layerFont = await params.resolveLayerFont(params.layerFontInput);
    return { layerFont, layerFontInput: params.layerFontInput, runFonts: [] };
  }
  if (runs.runTexts.length === 0) {
    throw new Error("--run takes the run's text (a nonempty string).");
  }
  for (const slice of runs.runTexts) {
    if (slice.length === 0) {
      throw new Error("--run takes the run's text (a nonempty string); a run cannot be empty.");
    }
  }
  if (runs.runTexts.join("") !== params.text) {
    throw new Error("The --run occurrences' concatenation must equal the Layer text.");
  }
  // Per-run style edits, merged per index in command order (a later
  // occurrence wins, like a repeated layer-level setter). Index range
  // validates BEFORE the single-run fold: a setter naming a run that does
  // not exist is refused, never dropped.
  const styles = new Map<number, LayerRunStyleEdit>();
  for (const edit of runs.styles ?? []) {
    if (edit.index < 1 || edit.index > runs.runTexts.length) {
      throw new Error(runIndexOutOfRangeRefusal(edit.index, runs.runTexts.length));
    }
    const merged = { ...styles.get(edit.index), ...edit };
    styles.set(edit.index, merged);
  }
  const validateStyleExclusivity = (style: LayerRunStyleEdit): void => {
    if (style.font !== undefined && style.fontFile !== undefined) {
      throw new Error(
        "--run-font and --run-font-file name one font per run — pass a bundled family (--run-font <i>=<family>) or a local font file (--run-font-file <i>=<path>), not both.",
      );
    }
  };

  // THE SINGLE-RUN FOLD (one home: this ingestion point). One occurrence
  // with per-run style edits folds them into the Layer-level facts — the
  // stored revision keeps today's exact single-run shape.
  if (runs.runTexts.length === 1) {
    const style = styles.get(1);
    if (style === undefined) {
      const layerFont = await params.resolveLayerFont(params.layerFontInput);
      return { layerFont, layerFontInput: params.layerFontInput, runFonts: [] };
    }
    validateStyleExclusivity(style);
    let foldedColor: string | LayerFill | undefined;
    if (style.colorSpec !== undefined) {
      if (style.colorSpec === null) {
        throw new Error(runRemovalOnAddRefusal("--run-color"));
      }
      // Canonicalized exactly like the Layer colour path's stored form.
      foldedColor = canonicalizeTextFillForStorage(normalizeStoredTextFill(style.colorSpec.trim()));
    }
    let fontFile: string | undefined;
    let font: string | undefined;
    if (style.fontFile !== undefined) {
      if (style.fontFile === null) {
        throw new Error(runRemovalOnAddRefusal("--run-font-file"));
      }
      fontFile = style.fontFile;
    } else if (style.font !== undefined) {
      if (style.font === null) {
        throw new Error(runRemovalOnAddRefusal("--run-font"));
      }
      font = style.font;
    }
    const layerFontInput =
      font !== undefined || fontFile !== undefined
        ? {
            ...(font !== undefined ? { font } : {}),
            ...(fontFile !== undefined ? { fontFile } : {}),
          }
        : params.layerFontInput;
    const layerFont = await params.resolveLayerFont(layerFontInput);
    // Folded axes are the raw explicit controls: the caller's ONE axes
    // resolution validates them against the folded face.
    const folded: { color?: string | LayerFill; weight?: number; width?: number } = {
      ...(foldedColor !== undefined ? { color: foldedColor } : {}),
      ...(style.weight !== undefined && style.weight !== null ? { weight: style.weight } : {}),
      ...(style.width !== undefined && style.width !== null ? { width: style.width } : {}),
    };
    return {
      layerFont,
      layerFontInput,
      ...(Object.keys(folded).length > 0 ? { folded } : {}),
      runFonts: [],
    };
  }

  // Multi-run: resolve the Layer font first (the runs' dedupe and inherited
  // axes basis), then every run's overrides.
  const layerFont = await params.resolveLayerFont(params.layerFontInput);
  const out: ResolvedTextInputRuns = {
    layerFont,
    layerFontInput: params.layerFontInput,
    runFonts: [],
  };
  const entries: LayerTextRun[] = [];
  const runCallerFontFacts = new Map<number, CallerFontFacts>();
  const runCallerFontBytes = new Map<number, Buffer>();
  for (let i = 1; i <= runs.runTexts.length; i++) {
    const style = styles.get(i);
    const entry: LayerTextRun = {};
    if (i > 1) entry.start = runs.runTexts.slice(0, i - 1).join("").length;
    if (style !== undefined) {
      // Colour: the ONE grammar, canonicalized exactly like the Layer
      // colour path's stored form.
      if (style.colorSpec !== undefined) {
        if (style.colorSpec === null) {
          throw new Error(runRemovalOnAddRefusal("--run-color"));
        }
        entry.color = canonicalizeTextFillForStorage(normalizeStoredTextFill(style.colorSpec.trim()));
      }
      validateStyleExclusivity(style);
      let runFace: FontFace | undefined;
      let runCallerFont: CallerFontFacts | undefined;
      if (style.fontFile !== undefined) {
        if (style.fontFile === null) {
          throw new Error(runRemovalOnAddRefusal("--run-font-file"));
        }
        const ingested = await readCallerFontFile(style.fontFile);
        runFace = callerFontFace(ingested.facts);
        runCallerFontFacts.set(i, ingested.facts);
        runCallerFontBytes.set(i, ingested.bytes);
      } else if (style.font !== undefined) {
        if (style.font === null) {
          throw new Error(runRemovalOnAddRefusal("--run-font"));
        }
        runFace = resolveFace(style.font);
      }
      // The run's axes resolve against the run's EFFECTIVE face (the one
      // ADR-0021 rule, applied per run): an explicit axis is validated; a
      // variable-face font override stores its resolved instance; a static
      // face stores nothing (its bytes fix the look); a run sharing the
      // layer face inherits the layer axes unless an axis is explicit.
      const face = runFace ?? layerFont.face;
      const explicitWeight = style.weight !== undefined && style.weight !== null ? style.weight : undefined;
      const explicitWidth = style.width !== undefined && style.width !== null ? style.width : undefined;
      if (runFace !== undefined) {
        const axes = resolveTextAxes(face, {
          ...(explicitWeight !== undefined ? { weight: explicitWeight } : {}),
          ...(explicitWidth !== undefined ? { width: explicitWidth } : {}),
        });
        if (face.variant === "variable") {
          entry.weight = axes.weight;
          entry.width = axes.width;
        }
      } else if (explicitWeight !== undefined || explicitWidth !== undefined) {
        const axes = resolveTextAxes(face, {
          ...(explicitWeight !== undefined
            ? { weight: explicitWeight }
            : (params.layerWeight !== undefined ? { weight: params.layerWeight } : {})),
          ...(explicitWidth !== undefined
            ? { width: explicitWidth }
            : (params.layerWidth !== undefined ? { width: params.layerWidth } : {})),
        });
        entry.weight = axes.weight;
        entry.width = axes.width;
      } else if (style.weight === null || style.width === null) {
        // Removal of a run axis override on add: nothing to remove.
        throw new Error(runRemovalOnAddRefusal("--run-weight/--run-width"));
      }
      // Retain the run font (deduped against the layer font) AFTER every
      // resolution above — a refused run publishes no content blob.
      if (runFace !== undefined) {
        let bytes: Buffer;
        let hash: string;
        let callerFont: CallerFontFacts | undefined;
        if (runCallerFontBytes.has(i)) {
          bytes = runCallerFontBytes.get(i)!;
          callerFont = runCallerFontFacts.get(i);
        } else {
          bytes = fontAssetBytes(runFace);
        }
        hash = createHash("sha256").update(bytes).digest("hex");
        if (hash !== layerFont.contentHash) {
          if (callerFont !== undefined) {
            await verifyCallerFontResolves(hash, bytes, callerFont);
          }
          if (!out.runFonts.some((f) => f.contentHash === hash)) {
            out.runFonts.push({ contentHash: hash, bytes, ...(callerFont !== undefined ? { caller: callerFont } : {}) });
          }
          entry.contentHash = hash;
          if (callerFont !== undefined) entry.callerFont = callerFont;
        }
      }
    }
    entries.push(entry);
  }
  out.runs = entries;
  return out;
}

/** The out-of-range run-index refusal (#297), one wording shared by every
 *  per-run option on both surfaces: 1-based indices, naming the run count. */
export function runIndexOutOfRangeRefusal(index: number, count: number): string {
  const runs = count === 1 ? "1 run" : `${count} runs`;
  return `Run index ${index} is out of range: the Layer carries ${runs} (run indices 1–${count}).`;
}

/** The removal-form-on-add refusal (#297): a new Layer has no run overrides
 *  to remove — the removal forms are edit-only. */
export function runRemovalOnAddRefusal(option: string): string {
  return `${option} "none" removes a run's override — a new Layer has none to remove; set the run's style instead.`;
}

/** The per-run-options-on-a-single-run refusal (#297): one wording for every
 *  per-run option, naming the layer-level spellings and the append form. */
export function singleRunPerRunOptionRefusal(layerId: string): string {
  return (
    `Layer "${layerId}" carries one run: per-run options (--run-color, --run-weight, --run-width, --run-font, --run-font-file, --run-text) name runs of a multi-run Layer. ` +
    `Set the Layer's own style options (--color, --weight, --width, --font), replace the text with --text, or append a run with --run <text>.`
  );
}

/** The bare --text on a multi-run refusal (#297): replacing the whole text
 *  would silently discard the runs; the scoped forms are the explicit edits. */
export function multiRunTextReplacementRefusal(layerId: string): string {
  return (
    `Layer "${layerId}" carries text runs: replacing the whole text with --text would discard them. ` +
    `Edit one run with --run-text <i>=<text>, or collapse to a single run with --runs none.`
  );
}

/**
 * Apply one edit's runs-side intent (#297) to a text revision under
 * construction — the edit surface's runs application, beside the other text
 * branches. Returns the new text, the canonical stored entries (absent when
 * collapsed or single-run), and the resolved per-run font facts for the
 * caller to retain. Validations run before anything is retained:
 * - bare `--text` on a multi-run Layer is refused (the scoped forms are the
 *   explicit edits);
 * - per-run options need a multi-run Layer (one wording for every option);
 * - a run index must name an existing run (1-based, one wording for every
 *   per-run option).
 *
 * Application order within one edit (documented, deterministic): appends
 * first (`--run`), then `--run-text`, then the per-run style setters, then
 * `--runs none` — so a setter naming a run that a collapse in the same edit
 * would remove is refused by the index check, never silently dropped.
 */
export async function applyTextInputRunEdits(params: {
  layerId: string;
  prevText: string;
  prevRuns?: LayerTextRun[];
  runAppend?: string[];
  runText?: Array<{ index: number; text: string }>;
  runStyles?: LayerRunStyleEdit[];
  runsNone?: boolean;
  /** The layer's effective face RESOLVER (the resolution basis for runs
   *  without a font override) — undefined when the retained bytes match no
   *  bundled face and no caller facts are stored, in which case only colour
   *  and run-font edits can resolve (an axis resolution needs --font).
   *  Lazy: only a run-intent edit that needs the face resolves it. */
  layerFace: () => FontFace | undefined;
  layerAxes?: TextAxes;
  layerContentHash: string;
  /** The previous revision's verified run-font bytes (carried overrides'
   *  bytes for the would-be revision's @font-face set). */
  prevRunFonts?: SnapshotRunFont[];
}): Promise<{
  text: string;
  runs?: LayerTextRun[];
  /** The would-be revision's complete run-font set (fit/region probes). */
  runFonts: SnapshotRunFont[];
  /** This edit's own run fonts: verified and retained by the caller. */
  newRunFonts: SnapshotRunFont[];
}> {
  const { prevText, prevRuns } = params;
  const hasRunIntent =
    (params.runAppend !== undefined && params.runAppend.length > 0) ||
    params.runText !== undefined ||
    (params.runStyles !== undefined && params.runStyles.length > 0) ||
    params.runsNone === true;
  if (!hasRunIntent) {
    return { text: prevText, ...(prevRuns !== undefined ? { runs: prevRuns } : {}), runFonts: params.prevRunFonts ?? [], newRunFonts: [] };
  }
  if (params.runsNone === true) {
    // Collapse first-class: every boundary and override is removed at once —
    // the Layer returns to the single-run shape at its own defaults.
    return { text: prevText, runFonts: [], newRunFonts: [] };
  }
  // Canonical previous entries with derived starts (entry 1 at 0).
  const entries: Array<LayerTextRun & { start: number }> = (prevRuns ?? [{ start: 0 }]).map((run, i) => ({
    start: i === 0 ? 0 : run.start!,
    ...(run.color !== undefined ? { color: run.color } : {}),
    ...(run.contentHash !== undefined ? { contentHash: run.contentHash } : {}),
    ...(run.callerFont !== undefined ? { callerFont: run.callerFont } : {}),
    ...(run.weight !== undefined ? { weight: run.weight } : {}),
    ...(run.width !== undefined ? { width: run.width } : {}),
  }));
  const newRunFonts: SnapshotRunFont[] = [];
  let text = prevText;
  const sliceAt = (index: number): { start: number; end: number } => {
    if (index < 1 || index > entries.length) {
      throw new Error(runIndexOutOfRangeRefusal(index, entries.length));
    }
    const start = entries[index - 1]!.start;
    const end = index < entries.length ? entries[index]!.start : text.length;
    return { start, end };
  };
  // 1. Appends: each occurrence adds one run at the layer defaults.
  if (params.runAppend !== undefined) {
    for (const slice of params.runAppend) {
      if (slice.length === 0) {
        throw new Error("--run takes the run's text (a nonempty string); a run cannot be empty.");
      }
      entries.push({ start: text.length });
      text += slice;
    }
  }
  // 2. One run's characters are replaced in place per occurrence (applied
  // in command order); later boundaries shift. The gate reads the
  // POST-APPEND shape: an append in the same edit creates the runs the
  // setters name (the documented order — appends, then --run-text, then
  // setters), so a single-run Layer that just gained a run is multi-run
  // here.
  if (params.runText !== undefined && params.runText.length > 0) {
    if (entries.length < 2) {
      throw new Error(singleRunPerRunOptionRefusal(params.layerId));
    }
    for (const { index, text: replacement } of params.runText) {
      if (replacement.length === 0) {
        throw new Error("--run-text takes the run's text (a nonempty string); a run cannot be empty.");
      }
      const { start, end } = sliceAt(index);
      text = text.slice(0, start) + replacement + text.slice(end);
      const delta = replacement.length - (end - start);
      for (let i = index; i < entries.length; i++) {
        entries[i]!.start += delta;
        assertRunBoundary(text, entries[i]!.start, "--run-text shifted run boundary");
      }
    }
  }
  // 3. Per-run style setters, merged per index in command order — gated on
  // the post-append shape like the run-text step above.
  if (params.runStyles !== undefined && params.runStyles.length > 0) {
    if (entries.length < 2) {
      throw new Error(singleRunPerRunOptionRefusal(params.layerId));
    }
    const merged = new Map<number, LayerRunStyleEdit>();
    for (const edit of params.runStyles) {
      if (edit.index < 1 || edit.index > entries.length) {
        throw new Error(runIndexOutOfRangeRefusal(edit.index, entries.length));
      }
      merged.set(edit.index, { ...merged.get(edit.index), ...edit });
    }
    for (const [index, style] of merged) {
      const entry = entries[index - 1]!;
      if (style.colorSpec !== undefined) {
        if (style.colorSpec === null) delete entry.color;
        else {
          const fill = normalizeStoredTextFill(style.colorSpec.trim());
          entry.color = canonicalizeTextFillForStorage(fill);
        }
      }
      const wantsFont = style.font !== undefined || style.fontFile !== undefined;
      if (style.font !== undefined && style.fontFile !== undefined) {
        throw new Error(
          "--run-font and --run-font-file name one font per run — pass a bundled family (--run-font <i>=<family>) or a local font file (--run-font-file <i>=<path>), not both.",
        );
      }
      let runFace: FontFace | undefined;
      let runCallerFont: CallerFontFacts | undefined;
      let runBytes: Buffer | undefined;
      if (style.fontFile !== undefined) {
        if (style.fontFile === null) {
          delete entry.contentHash;
          delete entry.callerFont;
          // The axes overrides belong to the overridden face: removing the
          // font override removes them with it (one home per fact).
          delete entry.weight;
          delete entry.width;
        } else {
          const ingested = await readCallerFontFile(style.fontFile);
          runFace = callerFontFace(ingested.facts);
          runCallerFont = ingested.facts;
          runBytes = ingested.bytes;
        }
      } else if (style.font !== undefined) {
        if (style.font === null) {
          delete entry.contentHash;
          delete entry.callerFont;
          delete entry.weight;
          delete entry.width;
        } else {
          runFace = resolveFace(style.font);
          runBytes = fontAssetBytes(runFace);
        }
      }
      const face = runFace ?? params.layerFace();
      // An axis resolution against the layer face needs the face: retained
      // bytes matching no bundled face refuse with the established wording,
      // naming --font (the same refusal the layer-level axes edit gives).
      if (
        face === undefined &&
        ((style.weight !== undefined && style.weight !== null) ||
          (style.width !== undefined && style.width !== null))
      ) {
        throw new Error(
          `The retained font of Layer "${params.layerId}" (content hash ${params.layerContentHash}) matches no bundled face — pass --font to choose a bundled family.`,
        );
      }
      const explicitWeight = style.weight !== undefined && style.weight !== null ? style.weight : undefined;
      const explicitWidth = style.width !== undefined && style.width !== null ? style.width : undefined;
      if (runFace !== undefined) {
        const axes = resolveTextAxes(face!, {
          ...(explicitWeight !== undefined ? { weight: explicitWeight } : {}),
          ...(explicitWidth !== undefined ? { width: explicitWidth } : {}),
        });
        if (face!.variant === "variable") {
          entry.weight = axes.weight;
          entry.width = axes.width;
        } else {
          delete entry.weight;
          delete entry.width;
        }
        const hash = createHash("sha256").update(runBytes!).digest("hex");
        if (hash !== params.layerContentHash) {
          entry.contentHash = hash;
          if (runCallerFont !== undefined) entry.callerFont = runCallerFont;
          if (!newRunFonts.some((f) => f.contentHash === hash)) {
            newRunFonts.push({ contentHash: hash, bytes: runBytes!, ...(runCallerFont !== undefined ? { caller: runCallerFont } : {}) });
          }
        } else {
          // The run's font bytes equal the layer font's: the override is
          // deduped away and the run keeps the layer font (one home).
          delete entry.contentHash;
          delete entry.callerFont;
        }
      } else if (wantsFont) {
        // A removal: nothing further to resolve.
      } else if (explicitWeight !== undefined || explicitWidth !== undefined) {
        const axes = resolveTextAxes(face!, {
          ...(explicitWeight !== undefined
            ? { weight: explicitWeight }
            : entry.weight !== undefined
              ? { weight: entry.weight }
              : params.layerAxes?.weight !== undefined
                ? { weight: params.layerAxes.weight }
                : {}),
          ...(explicitWidth !== undefined
            ? { width: explicitWidth }
            : entry.width !== undefined
              ? { width: entry.width }
              : params.layerAxes?.width !== undefined
                ? { width: params.layerAxes.width }
                : {}),
        });
        entry.weight = axes.weight;
        entry.width = axes.width;
      } else if (style.weight === null || style.width === null) {
        // Removal of a run axis override: the run falls back to the layer
        // axes (no stored pair — absence IS the layer-default form).
        delete entry.weight;
        delete entry.width;
      }
    }
  }
  // Renormalize: a single run is today's stored form — no runs field. A
  // collapse above returns early; this covers an append-less edit that
  // cannot reduce the count (boundaries are never removed except by the
  // collapse), so this is a shape invariant, not a silent correction.
  if (entries.length < 2) {
    return { text, runFonts: [], newRunFonts: [] };
  }
  const runs: LayerTextRun[] = entries.map((entry) => ({
    ...(entry.start > 0 ? { start: entry.start } : {}),
    ...(entry.color !== undefined ? { color: entry.color } : {}),
    ...(entry.contentHash !== undefined ? { contentHash: entry.contentHash } : {}),
    ...(entry.callerFont !== undefined ? { callerFont: entry.callerFont } : {}),
    ...(entry.weight !== undefined ? { weight: entry.weight } : {}),
    ...(entry.width !== undefined ? { width: entry.width } : {}),
  }));
  // The would-be revision's complete run-font set (the fit probe's and the
  // region revalidation's @font-face inputs): new bytes from this edit,
  // carried overrides' bytes from the caller's verified read.
  const runFonts: SnapshotRunFont[] = [];
  for (const entry of runs) {
    if (entry.contentHash === undefined || entry.contentHash === params.layerContentHash) continue;
    if (runFonts.some((f) => f.contentHash === entry.contentHash)) continue;
    const carried = params.prevRunFonts?.find((f) => f.contentHash === entry.contentHash);
    const fresh = newRunFonts.find((f) => f.contentHash === entry.contentHash);
    const bytes = fresh?.bytes ?? carried?.bytes;
    if (bytes === undefined) {
      throw new Error(
        `Run font "${entry.contentHash}" for layer "${params.layerId}" missing bytes — the run font must be retained before the revision is validated.`,
      );
    }
    runFonts.push({
      contentHash: entry.contentHash,
      bytes,
      ...(entry.callerFont !== undefined ? { caller: entry.callerFont } : {}),
    });
  }
  return { text, runs, runFonts, newRunFonts };
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

/** Allowed stored text layout rule values (#287, spec #285 DEC-001, ADR-0017 amendment). */
export const TEXT_LAYOUT_RULES = ["natural"] as const;
export type StoredTextLayoutRule = (typeof TEXT_LAYOUT_RULES)[number];
export type NormalizedTextLayoutRule = StoredTextLayoutRule | "legacy";

/**
 * Canonical stored text layout rule validation and normalization (#287,
 * spec #285 DEC-001, ADR-0017 amendment). The ONE normalization boundary
 * for the text layout rule: documents written before #287 lack the field
 * and normalize to "legacy" (canvas-bounded shrink-to-fit wrapping) here;
 * every downstream reader projects through this function and never
 * re-derives a default. A present field must be "natural" — anything else
 * is a malformed document, refused loudly before the revision hash is
 * consulted.
 */
export function normalizeStoredTextLayoutRule(revision: { layoutRule?: unknown }): NormalizedTextLayoutRule {
  if (revision.layoutRule === undefined) {
    return "legacy";
  }
  if (revision.layoutRule === "natural") {
    return "natural";
  }
  throw new Error(
    `Malformed revision document: layoutRule must be "natural" when present (got ${JSON.stringify(revision.layoutRule)}).`,
  );
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
 * written before #215 keep their exact ids (#215, DEC-010). The text layout
 * rule is appended only when "natural", so revisions written before #287
 * keep their exact ids (#287, ADR-0017 amendment). The text wrap width is
 * appended only when present, so revisions written before #294 keep their
 * exact ids (#294, spec #285 DEC-005, ADR-0017 amendment). */
export function computeRevisionHash(rev: LayerRevision): string {
  const base = `${rev.layerId}:${rev.kind}:${rev.contentHash}:${rev.x}:${rev.y}:${rev.opacity}:${rev.createdAt}`;
  const textFields = rev.kind === "text" ? `:${rev.text}:${rev.fontSize}:${textFillIdentityString(rev.color)}` : "";
  const scaleFields =
    rev.scaleX !== undefined || rev.scaleY !== undefined ? `:${rev.scaleX}:${rev.scaleY}` : "";
  const rotationField = rev.rotationDeg !== undefined ? `:${rev.rotationDeg}` : "";
  const flipFields =
    rev.flipX !== undefined || rev.flipY !== undefined ? `:${rev.flipX}:${rev.flipY}` : "";
  // Skew and perspective (#298, spec #285 US-008): appended only when the
  // pair is present, so revisions written before #298 — and identity forms,
  // which are never stored — keep their exact ids.
  const skewFields =
    rev.skewXDeg !== undefined || rev.skewYDeg !== undefined ? `:skew(${rev.skewXDeg},${rev.skewYDeg})` : "";
  const perspectiveFields =
    rev.perspectiveTiltXDeg !== undefined || rev.perspectiveTiltYDeg !== undefined
      ? `:perspective(${rev.perspectiveTiltXDeg},${rev.perspectiveTiltYDeg})`
      : "";
  // The stored stack fold (#302, ADR-0027): one effect keeps today's exact
  // field string; a stack appends its entries joined with `;` inside the
  // same `:shadow(...)` / `:outline(...)` field, in paint order — so single-
  // effect revisions keep their exact ids and a stack's id derives from its
  // ordered facts alone.
  const shadowField =
    rev.shadow === undefined
      ? ""
      : `:shadow(${shadowStackOf(rev.shadow)!.map((s) => `${s.dx},${s.dy},${s.blur},${s.color}`).join(";")})`;
  const outlineField =
    rev.outline === undefined
      ? ""
      : `:outline(${outlineStackOf(rev.outline)!.map((o) => `${o.width},${o.color}`).join(";")})`;
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
  // The grade controls (#219, spec #218 US-001, ADR-0024): appended only
  // when at least one non-neutral control is present, in fixed order
  // (b, c, s, w), so revisions written before #219 keep their exact ids.
  const grade = normalizeStoredGrade(rev);
  const gradeParts: string[] = [];
  if (grade?.brightness !== undefined) gradeParts.push(`b${grade.brightness}`);
  if (grade?.contrast !== undefined) gradeParts.push(`c${grade.contrast}`);
  if (grade?.saturation !== undefined) gradeParts.push(`s${grade.saturation}`);
  if (grade?.warmth !== undefined) gradeParts.push(`w${grade.warmth}`);
  const gradeField = gradeParts.length > 0 ? `:grade(${gradeParts.join(",")})` : "";
  // The blend mode (#220, spec #218 US-003, ADR-0024): appended only when
  // present and non-normal, so revisions written before #220 keep their exact ids.
  const blend = normalizeStoredBlend(rev);
  const blendField = blend !== undefined ? `:blend(${blend})` : "";
  // The edge glow (#221, spec #218 US-002, ADR-0024): appended only when
  // present, in fixed order (width, softness, color, then the one direction
  // model — the legacy pair or the one-sided direction (#301, DEC-008),
  // never both), so revisions written before #221 keep their exact ids and
  // legacy direction revisions keep theirs across #301.
  const glow = normalizeStoredGlow(rev);
  const glowField =
    glow !== undefined
      ? `:glow(${glow.width},${glow.softness},${glow.color}` +
        (glow.angle !== undefined ? `,a${glow.angle},s${glow.strength}` : "") +
        (glow.direction !== undefined ? `,from${glow.direction.angle},s${glow.direction.strength}` : "") +
        `)`
      : "";
  // The blur radius (#299, spec #285 US-010, ADR-0024 amendment): appended
  // only when present, so revisions written before #299 keep their exact ids.
  const blur = normalizeStoredBlur(rev);
  const blurField = blur !== undefined ? `:blur(${blur})` : "";
  // The edge choke and feather radii (#300, spec #285 US-013, ADR-0024
  // amendment): appended only when present, so revisions written before
  // #300 keep their exact ids.
  const choke = normalizeStoredChoke(rev);
  const chokeField = choke !== undefined ? `:choke(${choke})` : "";
  const feather = normalizeStoredFeather(rev);
  const featherField = feather !== undefined ? `:feather(${feather})` : "";
  // The text layout rule (#287, spec #285 DEC-001, ADR-0017 amendment):
  // appended only when "natural", so revisions written before #287 keep their
  // exact ids.
  const layoutRule = rev.kind === "text" ? normalizeStoredTextLayoutRule(rev) : undefined;
  const layoutRuleField = layoutRule === "natural" ? `:layoutrule(${layoutRule})` : "";
  // The text wrap width (#294, spec #285 US-015, DEC-001/DEC-005, ADR-0017
  // amendment): appended only when present, so revisions written before
  // #294 keep their exact ids.
  const wrapWidth = rev.kind === "text" ? normalizeStoredTextWrapWidth(rev) : undefined;
  const wrapWidthField = wrapWidth !== undefined ? `:wrapwidth(${wrapWidth})` : "";
  // The fit box (#295) joins the hash only when stored — pre-#295 revision
  // ids are byte-identical.
  const fitBox = rev.kind === "text" ? normalizeStoredTextFitBox(rev) : undefined;
  const fitBoxField = fitBox !== undefined ? `:fitbox(${fitBox.width}x${fitBox.height})` : "";
  // The text runs (#297, spec #285 US-017, ADR-0021 amendment): appended
  // only when present, in stored order — entry 1's implicit start 0, each
  // later entry's boundary, then the entry's overrides in fixed order
  // (colour, font bytes, caller font facts, weight, width) — so revisions
  // written before #297 keep their exact ids.
  const runs = rev.kind === "text" ? normalizeStoredTextRuns(rev) : undefined;
  const runsField =
    runs !== undefined
      ? `:runs(${runs
          .map((run, i) => {
            const callerFont =
              run.callerFont !== undefined ? normalizeStoredCallerFont({ callerFont: run.callerFont }) : undefined;
            const callerFontPart = callerFont
              ? callerFont.variant === "static"
                ? `callerfont(${callerFont.family},${callerFont.variant},${callerFont.format},w${callerFont.weight})`
                : `callerfont(${callerFont.family},${callerFont.variant},${callerFont.format},wght(${callerFont.axes!.wght.min},${callerFont.axes!.wght.default},${callerFont.axes!.wght.max})${
                    callerFont.axes!.wdth !== undefined
                      ? `,wdth(${callerFont.axes!.wdth.min},${callerFont.axes!.wdth.default},${callerFont.axes!.wdth.max})`
                      : ""
                  })`
              : "";
            return [
              i === 0 ? "0" : String(run.start),
              run.color !== undefined ? textFillIdentityString(run.color) : "",
              run.contentHash ?? "",
              callerFontPart,
              run.weight !== undefined ? String(run.weight) : "",
              run.width !== undefined ? String(run.width) : "",
            ].join("|");
          })
          .join(";")})`
      : "";
  return `rev_${createHash("sha256").update(`${base}${textFields}${scaleFields}${rotationField}${flipFields}${skewFields}${perspectiveFields}${shadowField}${outlineField}${regionField}${textAxesFields}${typographyFields}${callerFontFields}${vectorColorFields}${shapeFieldsFields}${gradeField}${blendField}${glowField}${blurField}${chokeField}${featherField}${layoutRuleField}${wrapWidthField}${fitBoxField}${runsField}`).digest("hex").slice(0, 16)}`;
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
): Promise<ResolvedLayer & { contentBytes: Buffer; runFonts?: SnapshotRunFont[] }> {
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
    ...(resolved.runFonts !== undefined ? { runFonts: resolved.runFonts } : {}),
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
): Promise<{ revision: ResolvedLayerRevision; contentBytes: Buffer; runFonts?: SnapshotRunFont[] }> {
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
  // Canonical transform skew: validated and normalized at this same one
  // boundary (#298, ADR-0016 amendment) — malformed stored pairs are
  // refused loudly before the revision hash is consulted. Absence IS the
  // no-skew form.
  const skew = normalizeStoredSkew(revision);
  // Canonical transform perspective: validated and normalized at this same
  // one boundary (#298, ADR-0016 amendment) — malformed stored pairs are
  // refused loudly before the revision hash is consulted. Absence IS the
  // no-perspective form.
  const perspective = normalizeStoredPerspective(revision);
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
  // Canonical text layout rule: validated and normalized at this same one
  // boundary (#287, spec #285 DEC-001, ADR-0017 amendment) — pre-#287
  // revisions normalize to "legacy", new revisions store "natural".
  const layoutRule = revision.kind === "text" ? normalizeStoredTextLayoutRule(revision) : undefined;
  // Canonical text wrap width: validated and normalized at this same one
  // boundary (#294, spec #285 US-015, DEC-001/DEC-005, ADR-0017 amendment)
  // — a malformed stored field is refused loudly before the revision hash is
  // consulted. Absence IS the no-wrap-width form (natural one-line layout).
  const textWrapWidth =
    revision.kind === "text" ? normalizeStoredTextWrapWidth(revision) : undefined;
  // Canonical text fit box: validated and normalized at this same one
  // boundary (#295, spec #285 US-016, DEC-010/DEC-005) — a malformed stored
  // pair is refused loudly before the revision hash is consulted. Absence IS
  // the no-box form. The fit/wrap combination rule is a stored-document
  // invariant too: a box narrower than the stored wrap width could never be
  // satisfied, so it is a malformed document.
  const textFitBox = revision.kind === "text" ? normalizeStoredTextFitBox(revision) : undefined;
  if (textFitBox !== undefined && textWrapWidth !== undefined && textFitBox.width < textWrapWidth) {
    throw new Error(textFitBoxNarrowerThanWrapRefusal(textFitBox.width, textWrapWidth));
  }
  // Canonical text runs (#297, spec #285 US-017, ADR-0021 amendment):
  // validated and normalized at this same one boundary — a malformed stored
  // field is refused loudly before the revision hash is consulted. Absence
  // IS the single-run form.
  const textRuns = revision.kind === "text" ? normalizeStoredTextRuns(revision) : undefined;
  // Canonical vector colour (#215, DEC-008/010): validated and normalized at
  // this same one boundary — a malformed stored colour is refused loudly
  // before the revision hash is consulted. Absence IS the no-colour form.
  const vectorColor = revision.kind === "image" ? normalizeStoredVectorColor(revision) : undefined;
  // Canonical grade controls (#219, spec #218 US-001, ADR-0024): validated
  // and normalized at this same one boundary — malformed controls are refused
  // loudly before the revision hash is consulted. Absence IS the no-grade form.
  const grade = normalizeStoredGrade(revision);
  // Canonical blend mode (#220, spec #218 US-003, ADR-0024): validated
  // and normalized at this same one boundary — malformed modes are refused
  // loudly before the revision hash is consulted. Absence IS the normal/no-blend form.
  const blend = normalizeStoredBlend(revision);
  // Canonical edge glow (#221, spec #218 US-002, ADR-0024): validated and
  // normalized at this same one boundary — malformed parameters are refused
  // loudly before the revision hash is consulted. Absence IS the no-glow form.
  const glow = normalizeStoredGlow(revision);
  // Canonical blur radius (#299, spec #285 US-010, ADR-0024 amendment):
  // validated and normalized at this same one boundary — a malformed stored
  // radius is refused loudly before the revision hash is consulted. Absence
  // IS the no-blur form.
  const blur = normalizeStoredBlur(revision);
  // Canonical edge choke and feather (#300, spec #285 US-013, ADR-0024
  // amendment): validated and normalized at this same one boundary — a
  // malformed stored radius is refused loudly before the revision hash is
  // consulted. Absence IS the no-fact form for both.
  const choke = normalizeStoredChoke(revision);
  const feather = normalizeStoredFeather(revision);

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
            skewXDeg: skew.skewXDeg,
            skewYDeg: skew.skewYDeg,
            perspectiveTiltXDeg: perspective.perspectiveTiltXDeg,
            perspectiveTiltYDeg: perspective.perspectiveTiltYDeg,
            ...(shadow !== undefined ? { shadow } : {}),
            ...(outline !== undefined ? { outline } : {}),
            ...(visibleRegion !== undefined ? { visibleRegion } : {}),
            ...(vectorColor !== undefined ? { vectorColor } : {}),
            ...(grade !== undefined ? { grade } : {}),
            ...(blend !== undefined ? { blend } : {}) as { blend?: StoredLayerBlendMode },
            ...(glow !== undefined ? { glow } : {}),
            ...(blur !== undefined ? { blur } : {}),
            ...(choke !== undefined ? { choke } : {}),
            ...(feather !== undefined ? { feather } : {}),
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
          skewXDeg: skew.skewXDeg,
          skewYDeg: skew.skewYDeg,
          perspectiveTiltXDeg: perspective.perspectiveTiltXDeg,
          perspectiveTiltYDeg: perspective.perspectiveTiltYDeg,
          ...(shadow !== undefined ? { shadow } : {}),
          ...(outline !== undefined ? { outline } : {}),
          ...(visibleRegion !== undefined ? { visibleRegion } : {}),
          ...(grade !== undefined ? { grade } : {}),
          ...(blend !== undefined ? { blend } : {}) as { blend?: StoredLayerBlendMode },
          ...(glow !== undefined ? { glow } : {}),
          ...(blur !== undefined ? { blur } : {}),
          ...(choke !== undefined ? { choke } : {}),
          ...(feather !== undefined ? { feather } : {}),
          text: revision.text,
          fontSize: revision.fontSize,
          color: revision.color,
          ...(textAxes ?? {}),
          ...(textTypography ?? {}),
          ...(textWrapWidth !== undefined ? { wrapWidth: textWrapWidth } : {}),
          ...(textFitBox !== undefined ? { fitWidth: textFitBox.width, fitHeight: textFitBox.height } : {}),
          ...(callerFont !== undefined ? { callerFont } : {}),
          ...(textRuns !== undefined ? { runs: textRuns } : {}),
          fontBytes: contentBytes!.length,
          layoutRule: layoutRule!,
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
          skewXDeg: skew.skewXDeg,
          skewYDeg: skew.skewYDeg,
          perspectiveTiltXDeg: perspective.perspectiveTiltXDeg,
          perspectiveTiltYDeg: perspective.perspectiveTiltYDeg,
          ...(shadow !== undefined ? { shadow } : {}),
          ...(outline !== undefined ? { outline } : {}),
          ...(visibleRegion !== undefined ? { visibleRegion } : {}),
          ...(grade !== undefined ? { grade } : {}),
          ...(blend !== undefined ? { blend } : {}) as { blend?: StoredLayerBlendMode },
          ...(glow !== undefined ? { glow } : {}),
          ...(blur !== undefined ? { blur } : {}),
          ...(choke !== undefined ? { choke } : {}),
          ...(feather !== undefined ? { feather } : {}),
        };

  // Run font bytes (#297): every distinct run font override's retained
  // bytes, verified by identity at this one boundary, so paint and
  // measurement never consult the store again.
  const runFonts = await loadSnapshotRunFonts(resolvedRoot, resolved);
  return { revision: resolved, contentBytes: contentBytes ?? Buffer.alloc(0), ...(runFonts.length > 0 ? { runFonts } : {}) };
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
  color?: string | LayerFill;
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
  /**
   * Select the text's wrap width in layout px (#294, spec #285 US-015,
   * ISC-55, DEC-001/DEC-005, ADR-0017 amendment): an ABSOLUTE setter,
   * font-independent — a positive finite number of LAYOUT pixels, applied
   * before the canonical transform (scale and rotation map the wrapped box
   * afterwards). With a width set, a natural-layout text Layer soft-wraps
   * at spaces within the width (`white-space: pre-wrap; width: <W>px`);
   * written line breaks still break and preserved spaces still hold. With
   * no width, the text stays on one line (natural one-line layout).
   * `null` clears the stored width (the documented removal value "none" at
   * the command boundary — removing it restores the unwrapped render
   * byte-for-byte); an omitted option carries the current value across any
   * edit. The fact is stored ONLY when set (one stored form per look:
   * absence IS the no-wrap-width form), so revisions written before #294
   * keep their exact revision ids. The fact is a natural-layout fact: a
   * legacy-rule revision never carries one, and any edit setting it is an
   * edit that writes `layoutRule: "natural"` (ADR-0017 amendment).
   */
  wrapWidth?: number | null;
  /**
   * The caller-set fit box (#295, spec #285 US-016, ISC-56, DEC-010/
   * DEC-005): an ABSOLUTE setter — a `{ width, height }` pair in layout px,
   * validated by `resolveTextFitBoxControl` at the ONE domain boundary.
   * With a box set, the one in-page fit derivation shrinks the font size —
   * only shrinking, never the weight or width (DEC-010) — until the laid-out
   * block fits; `measure` reports the effective font size. Text that cannot
   * fit at the documented 8px minimum is refused before anything is
   * published, naming the box and the size needed. `null` clears the stored
   * box (the documented removal value "none" at the command boundary —
   * removing it restores the render byte-for-byte); an omitted option
   * carries the current value across any edit. The fact is stored ONLY when
   * set (absence IS the no-box form), so revisions written before #295 keep
   * their exact revision ids.
   */
  fitBox?: { width: number; height: number } | null;
  /**
   * Runs-side edits (#297, spec #285 US-017, ISC-54, ADR-0021 amendment):
   * appends (`--run` occurrences), one run's text (`--run-text <i>=<text>`),
   * per-run style setters merged per 1-based index, and the collapse form
   * (`--runs none`). Each is an ABSOLUTE edit; the application order within
   * one edit is documented on `applyTextInputRunEdits`.
   */
  runAppend?: string[];
  runText?: Array<{ index: number; text: string }>;
  runStyles?: LayerRunStyleEdit[];
  runsNone?: boolean;
  x?: number;
  y?: number;
  opacity?: number;
  /**
   * Shape content options (#208, #209): parsed at the command boundary, and
   * on `layer edit` ABSOLUTE setters on a shape Layer (#209, spec #207
   * US-002) — each supplied option replaces that parameter, an omitted
   * parameter keeps its value, and the merged form validates through the
   * ONE shape-content validator. On image and text Layers every shape
   * option is refused naming kind stability. They exist in the option table
   * so `composition add` accepts them for shape content and the guard tests
   * can enumerate the full surface. Their application is per-surface by
   * design (creation vs the kind-stable parameter merge — not a
   * stored-vs-provisional context difference), so they are not shared
   * application cases (#263).
   */
  shape?: "rectangle" | "ellipse";
  size?: { width: number; height: number };
  cornerRadius?: number;
  fill?: LayerFill;
  /**
   * The shared option values (DEC-001, #263): the parsed post-content
   * options — the resize forms, the canonical transform, the effects, the
   * visible region, and the vector colour — keyed by the option table's
   * own keys, normalized by the table's parse registrations at the command
   * boundary. The edit path dispatches each supplied key through its ONE
   * shared application case (`EDIT_APPLICATION_ORDER`) against a draft of
   * the stored revision under the Project lock; there is no per-option
   * member or application call for these options left.
   */
  shared?: SharedOptionValues;
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
  /** Present when the edit set or removed the shadow (#139; stacks #302,
   * ADR-0027): the absolute shadow-stack state now recorded on the revision
   * — the normalized list, in paint order (null when removed). */
  shadowed?: { shadow: LayerShadow[] | null };
  /** Present when the edit set or removed the outline (#140; stacks #302,
   * ADR-0027): the normalized outline list, in paint order (null when
   * removed). */
  outlined?: { outline: LayerOutline[] | null };
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
  /** Present when the edit set or removed any grade control (#219): the
   * absolute grade state now recorded on the revision (null when removed). */
  gradeSet?: { grade: LayerGrade | null };
  /** Present when the edit set or removed the blend mode (#220): the
   * absolute blend state now recorded on the revision (null when removed). */
  blendSet?: { blend: StoredLayerBlendMode | null };
  /** Present when the edit set or removed the edge glow (#221): the
   * absolute glow state now recorded on the revision (null when removed). */
  glowSet?: { glow: LayerGlow | null };
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

/** Refusal for `--cover-to canvas` with no unambiguous canvas target: the
 *  situation is named, and the explicit form is offered. A fork edit names
 *  its target Composition's canvas as the context instead. */
function coverCanvasRefusal(layerId: string, detail: string): Error & { referringCompositions?: string[]; referrersCount?: number } {
  const err = new Error(
    `--cover-to canvas needs one Composition whose canvas defines the target for Layer "${layerId}": ${detail} ` +
      `Pass an explicit "<W>x<H>" target, or use --cover-to canvas from a command that names a single Composition.`,
  ) as Error & { referringCompositions?: string[]; referrersCount?: number };
  return err;
}

/** Divergent-canvas refusal for `--cover-to canvas`: the disagreeing
 *  compositions are named and counted, following the blast-radius
 *  convention (the anchor's multi-context refusal, #285's shared-fact
 *  rule). */
function coverCanvasDivergenceRefusal(layerId: string, contexts: string[]): Error & { referringCompositions: string[]; referrersCount: number } {
  const names = contexts.map((n) => `"${n}"`).join(", ");
  const err = new Error(
    `--cover-to canvas for Layer "${layerId}" resolves to different target canvases across ${contexts.length} Compositions (${names}) — ` +
      "a shared Layer has one scale fact, and the canvas target differs between them. " +
      'Pass an explicit "<W>x<H>" target, or fork into one Composition with --fork/--composition/--use.',
  ) as Error & { referringCompositions: string[]; referrersCount: number };
  err.referringCompositions = contexts;
  err.referrersCount = contexts.length;
  return err;
}

/**
 * Resolve the `--cover-to canvas` target for the edit boundary (#293,
 * spec #285 US-007, DEC-011): the target is the canvas of the Layer's
 * referring Composition(s) — all referrers must agree on the canvas, a
 * Layer with no referrer is refused, and a --fork edit resolves against
 * its target Composition instead. Read-only; the caller substitutes the
 * concrete target for the "canvas" marker before the edit lifecycle runs,
 * so the stored-state scale resolution stays Composition-free.
 */
export async function resolveCoverCanvasTarget(
  projectPath: string,
  layerId: string,
  options: { contextComposition?: string } = {},
): Promise<{ width: number; height: number }> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  if (options.contextComposition !== undefined) {
    const comp = await withProjectLock(resolvedRoot, () => readCompositionInternalFull(projectPath, options.contextComposition!));
    return { width: comp.canvas.width, height: comp.canvas.height };
  }
  const contexts = await withProjectLock(resolvedRoot, async () => {
    const referrers = await findLayerReferrersInternal(resolvedRoot, layerId);
    return Promise.all(referrers.map(async (name) => {
      const full = await readCompositionInternalFull(projectPath, name);
      return { name, canvas: full.canvas };
    }));
  });
  if (contexts.length === 0) {
    // An unknown Layer id keeps the established unknown-Layer refusal (the
    // edit path's own validation, which runs after this boundary
    // resolution) — the cover target is not the story for a missing id.
    await withProjectLock(resolvedRoot, () => readLayerInternalFull(projectPath, layerId));
    throw coverCanvasRefusal(layerId, "the Layer is not used by any Composition.");
  }
  const first = contexts[0]!.canvas;
  const diverged = contexts.some((c) => c.canvas.width !== first.width || c.canvas.height !== first.height);
  if (diverged) {
    throw coverCanvasDivergenceRefusal(layerId, contexts.map((c) => c.name));
  }
  return { width: first.width, height: first.height };
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

/** The ONE cover-fit kind gate (#293, DEC-011): cover fit works on image
 *  Layers only — a text Layer has no intrinsic pixel size, and a shape's
 *  sizing goes through --resize-to/--scale. One home for both refusals:
 *  the shared scale resolution's cover branch calls it, and the shared
 *  application case calls it with the PUBLISHED draft's kind (the add
 *  surface's provisional base carries an image kind even for a shape add,
 *  so the gate reads the draft, never the provisional base) — the two
 *  call sites cannot drift, and the wording stays byte-identical across
 *  the surfaces by construction. */
export function coverKindGate(
  kind: "image" | "text" | "shape",
  layerId: string,
): asserts kind is "image" {
  if (kind === "text") {
    throw new Error(
      `--cover-to needs an intrinsic pixel size: Layer "${layerId}" is a text Layer — use --resize <factor>.`,
    );
  }
  if (kind === "shape") {
    throw new Error(
      `--cover-to works on image Layers only: Layer "${layerId}" is a shape Layer — use --resize-to or --scale.`,
    );
  }
}

/**
 * Canonical rotation normalization (#134, ADR-0016): `--rotate` sets an
 * ABSOLUTE angle in degrees, replacing any previous rotation. Omitted option
 * preserves the current revision's rotation. The refusal runs before any
 * staging, so an invalid angle never advances live state. Exported as the
 * ONE rotation path for one-command `composition add` too (#229, DEC-001).
 */
export function resolveEditRotation(
  options: { rotateDeg?: number },
  prevRev: ResolvedLayerRevision,
): number {
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
export function resolveEditFlip(
  options: { flip?: "horizontal" | "vertical" | "both" | "none" },
  prevRev: ResolvedLayerRevision,
): LayerTransformFlip {
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
 * Canonical skew normalization (#298, ADR-0016 amendment): `--skew` sets
 * ABSOLUTE angles in degrees, replacing any previous skew — `0x0` is the
 * removal form. One axis may be omitted (`{skewXDeg?}` / `{skewYDeg?}`
 * exactly one defined): the omitted axis keeps the Layer's current skew.
 * Angles are bounded away from the tangent's ±90° divergence. Omitted
 * option preserves the current revision's skew. The refusal runs before
 * any staging, so an invalid angle never advances live state. Exported as
 * the ONE skew path for one-command `composition add` too.
 */
export function resolveEditSkew(
  options: { skewTo?: { skewXDeg?: number; skewYDeg?: number } },
  prevRev: ResolvedLayerRevision,
): LayerTransformSkew {
  const skewTo = options.skewTo;
  if (skewTo === undefined) {
    return { skewXDeg: prevRev.skewXDeg, skewYDeg: prevRev.skewYDeg };
  }
  const hasX = skewTo.skewXDeg !== undefined;
  const hasY = skewTo.skewYDeg !== undefined;
  if (!hasX && !hasY) {
    return { skewXDeg: prevRev.skewXDeg, skewYDeg: prevRev.skewYDeg };
  }
  const skewXDeg = hasX ? (skewTo.skewXDeg as number) : prevRev.skewXDeg;
  const skewYDeg = hasY ? (skewTo.skewYDeg as number) : prevRev.skewYDeg;
  for (const angle of [skewXDeg, skewYDeg]) {
    if (!Number.isFinite(angle) || Math.abs(angle) > TRANSFORM_ANGLE_BOUND) {
      throw new Error(
        `Invalid skew angle ${angle}: skew angles must be finite numbers between -${TRANSFORM_ANGLE_BOUND} and ${TRANSFORM_ANGLE_BOUND} degrees.`,
      );
    }
  }
  return { skewXDeg, skewYDeg };
}

/**
 * Canonical blur resolution (#299, spec #285 US-010, DEC-005, ADR-0024
 * amendment): `--blur <px>` is an ABSOLUTE radius setter in px, replacing
 * any previous blur — `0` is the removal form and the identity is never
 * stored. An omitted option preserves the Layer's current blur. The refusal
 * runs before any staging. Exported as the ONE blur path for one-command
 * `composition add` too, like every effect application case.
 */
export function resolveEditBlur(
  options: { blurTo?: number },
  prevRev: ResolvedLayerRevision,
): number | undefined {
  const blurTo = options.blurTo;
  if (blurTo === undefined) {
    return normalizeStoredBlur(prevRev);
  }
  if (typeof blurTo !== "number" || !Number.isFinite(blurTo) || blurTo < 0 || blurTo > MAX_BLUR_RADIUS_PX) {
    throw new Error(
      `Blur (--blur) takes a finite radius of px between 0 and ${MAX_BLUR_RADIUS_PX} — 0 removes the blur — got ${JSON.stringify(blurTo)}.`,
    );
  }
  return blurTo > 0 ? blurTo : undefined;
}

/**
 * Canonical edge-choke resolution (#300, spec #285 US-013, DEC-005, ADR-0024
 * amendment): `--choke <px>` is an ABSOLUTE radius setter in px, replacing
 * any previous choke — `0` is the removal form and the identity is never
 * stored. An omitted option preserves the Layer's current choke. The refusal
 * runs before any staging. Exported as the ONE choke path for one-command
 * `composition add` too, like every effect application case.
 */
export function resolveEditChoke(
  options: { chokeTo?: number },
  prevRev: ResolvedLayerRevision,
): number | undefined {
  const chokeTo = options.chokeTo;
  if (chokeTo === undefined) {
    return normalizeStoredChoke(prevRev);
  }
  if (typeof chokeTo !== "number" || !Number.isFinite(chokeTo) || chokeTo < 0 || chokeTo > MAX_EDGE_RADIUS_PX) {
    throw new Error(
      `Choke (--choke) takes a finite radius of px between 0 and ${MAX_EDGE_RADIUS_PX} — 0 removes the choke — got ${JSON.stringify(chokeTo)}.`,
    );
  }
  return chokeTo > 0 ? chokeTo : undefined;
}

/**
 * Canonical edge-feather resolution (#300, spec #285 US-013, DEC-005,
 * ADR-0024 amendment): `--feather <px>` is an ABSOLUTE radius setter in px,
 * replacing any previous feather — `0` is the removal form and the identity
 * is never stored. An omitted option preserves the Layer's current feather.
 * The refusal runs before any staging. Exported as the ONE feather path for
 * one-command `composition add` too, like every effect application case.
 */
export function resolveEditFeather(
  options: { featherTo?: number },
  prevRev: ResolvedLayerRevision,
): number | undefined {
  const featherTo = options.featherTo;
  if (featherTo === undefined) {
    return normalizeStoredFeather(prevRev);
  }
  if (typeof featherTo !== "number" || !Number.isFinite(featherTo) || featherTo < 0 || featherTo > MAX_EDGE_RADIUS_PX) {
    throw new Error(
      `Feather (--feather) takes a finite radius of px between 0 and ${MAX_EDGE_RADIUS_PX} — 0 removes the feather — got ${JSON.stringify(featherTo)}.`,
    );
  }
  return featherTo > 0 ? featherTo : undefined;
}

/**
 * Canonical perspective normalization (#298, ADR-0016 amendment):
 * `--perspective` sets ABSOLUTE tilts in degrees, replacing any previous
 * perspective — `0x0` is the removal form. One axis may be omitted: the
 * omitted tilt keeps the Layer's current perspective. Tilts are bounded
 * away from the ±90° edge-on degeneracy. Omitted option preserves the
 * current revision's perspective. The refusal runs before any staging.
 * Exported as the ONE perspective path for one-command `composition add` too.
 */
export function resolveEditPerspective(
  options: { perspectiveTo?: { perspectiveTiltXDeg?: number; perspectiveTiltYDeg?: number } },
  prevRev: ResolvedLayerRevision,
): LayerTransformPerspective {
  const perspectiveTo = options.perspectiveTo;
  if (perspectiveTo === undefined) {
    return {
      perspectiveTiltXDeg: prevRev.perspectiveTiltXDeg,
      perspectiveTiltYDeg: prevRev.perspectiveTiltYDeg,
    };
  }
  const hasX = perspectiveTo.perspectiveTiltXDeg !== undefined;
  const hasY = perspectiveTo.perspectiveTiltYDeg !== undefined;
  if (!hasX && !hasY) {
    return {
      perspectiveTiltXDeg: prevRev.perspectiveTiltXDeg,
      perspectiveTiltYDeg: prevRev.perspectiveTiltYDeg,
    };
  }
  const perspectiveTiltXDeg = hasX
    ? (perspectiveTo.perspectiveTiltXDeg as number)
    : prevRev.perspectiveTiltXDeg;
  const perspectiveTiltYDeg = hasY
    ? (perspectiveTo.perspectiveTiltYDeg as number)
    : prevRev.perspectiveTiltYDeg;
  for (const tilt of [perspectiveTiltXDeg, perspectiveTiltYDeg]) {
    if (!Number.isFinite(tilt) || Math.abs(tilt) > TRANSFORM_ANGLE_BOUND) {
      throw new Error(
        `Invalid perspective tilt ${tilt}: perspective tilts must be finite numbers between -${TRANSFORM_ANGLE_BOUND} and ${TRANSFORM_ANGLE_BOUND} degrees.`,
      );
    }
  }
  return { perspectiveTiltXDeg, perspectiveTiltYDeg };
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
 * Canonical edge-glow normalization (#221, spec #218 US-002, ADR-0024,
 * DEC-006): `--glow` sets an ABSOLUTE glow, replacing any previous one;
 * `"none"` removes it. Omitted option preserves the current revision's
 * glow. The spec is "<width>,<softness>,<color>[,<angle>,<strength>]" with
 * width and softness in px (0..MAX_GLOW_PX), the same hex colour forms as
 * the shadow and outline (canonicalized by `canonicalizeEffectColor`), and an
 * optional direction pair — angle in degrees clockwise from top within
 * ±360, strength between 0 and 1, supplied together; strength 0 (an even
 * glow) drops the pair. The angle is stored canonically in [0, 360), so
 * equivalent spellings of the same direction cannot mint redundant
 * revisions. The one-sided direction model (#301, ISC-53, DEC-008, ADR-0024
 * third amendment) spells its pair "from <angle>,<strength>" — light FROM
 * that angle, the far side dimmed to 1 − strength; strength 0 drops it the
 * same way, and the two direction forms are mutually exclusive (passing
 * both is one error, not two facts). Exported for the CLI boundary: the
 * command classifies malformed specs as usage errors (exit 2) with this
 * same parser, so the two never disagree.
 */
export function parseGlowSpec(spec: string): LayerGlow | undefined {
  const raw = spec.trim();
  if (raw.toLowerCase() === "none") {
    return undefined;
  }
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== 3 && parts.length !== 5) {
    throw new Error(
      `Invalid glow "${raw}": --glow takes "<width>,<softness>,<color>" or ` +
        `"<width>,<softness>,<color>,<angle>,<strength>" (e.g. "12,4,#ff9900,45,0.8"), ` +
        `"<width>,<softness>,<color>,from <angle>,<strength>" (e.g. "12,4,#ff9900,from 90,1"), or "none".`,
    );
  }
  const [widthRaw, softnessRaw, colorRaw, angleRaw, strengthRaw] = parts;
  const width = Number(widthRaw);
  const softness = Number(softnessRaw);
  const color = colorRaw ?? "";
  if (widthRaw === "" || softnessRaw === "" || color === "") {
    throw new Error(
      `Invalid glow "${raw}": --glow takes "<width>,<softness>,<color>" or ` +
        `"<width>,<softness>,<color>,<angle>,<strength>" (e.g. "12,4,#ff9900"), or "none".`,
    );
  }
  if (!Number.isFinite(width) || width < 0 || width > MAX_GLOW_PX) {
    throw new Error(
      `Invalid glow width ${widthRaw}: must be a finite number of px between 0 and ${MAX_GLOW_PX}.`,
    );
  }
  if (!Number.isFinite(softness) || softness < 0 || softness > MAX_GLOW_PX) {
    throw new Error(
      `Invalid glow softness ${softnessRaw}: must be a finite number of px between 0 and ${MAX_GLOW_PX}.`,
    );
  }
  if (!EFFECT_COLOR_PATTERN.test(color)) {
    throw new Error(
      `Invalid glow color "${color}": must be a hex color like #000000, #000, or #00000080.`,
    );
  }
  const glow: LayerGlow = { width, softness, color: canonicalizeEffectColor(color) };
  if (angleRaw !== undefined || strengthRaw !== undefined) {
    if (angleRaw === undefined || strengthRaw === undefined || angleRaw === "" || strengthRaw === "") {
      throw new Error(
        `Invalid glow "${raw}": the direction is one pair — pass both <angle> (degrees clockwise from top, -360 to 360) and <strength> (0 to 1), or neither.`,
      );
    }
    const fromMatch = /^from\s+(\S+)$/i.exec(angleRaw);
    if (fromMatch !== null) {
      // The one-sided direction model (#301, DEC-008): "from <angle>,<strength>"
      // — light FROM the angle, the far side dimmed to 1 − strength. Same
      // ranges and the same strength-0 neutral rule as the legacy pair; the
      // two direction forms are mutually exclusive.
      const angle = Number(fromMatch[1]);
      const strength = Number(strengthRaw);
      if (!Number.isFinite(angle) || angle < -360 || angle > 360) {
        throw new Error(
          `Invalid glow angle ${fromMatch[1]}: must be a finite number of degrees between -360 and 360 (clockwise from top; the light comes FROM that direction).`,
        );
      }
      if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
        throw new Error(
          `Invalid glow strength ${strengthRaw}: must be a finite number between 0 and 1.`,
        );
      }
      if (strength !== 0) {
        glow.direction = { angle: ((angle % 360) + 360) % 360, strength };
      }
      return glow;
    }
    const angle = Number(angleRaw);
    const strength = Number(strengthRaw);
    if (!Number.isFinite(angle) || angle < -360 || angle > 360) {
      throw new Error(
        `Invalid glow angle ${angleRaw}: must be a finite number of degrees between -360 and 360 (clockwise from top).`,
      );
    }
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
      throw new Error(
        `Invalid glow strength ${strengthRaw}: must be a finite number between 0 and 1.`,
      );
    }
    if (strength !== 0) {
      glow.angle = ((angle % 360) + 360) % 360;
      glow.strength = strength;
    }
  }
  return glow;
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
 * are semantic — they read the revision the option resolves against — and
 * live in the shared application case (`applyVectorColor`).
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

/**
 * The fit box equality for the edit path's unchanged check (#295): the
 * resolved control equals the previous revision's stored pair — both set
 * with the same values, or both absent.
 */

/** The runs equality for the edit no-op check (#297): canonical entries in
 *  order, field by field, compared by CANONICAL VALUE, never reference —
 *  the colour through the ONE fill equality (`fillsEqual`, the same
 *  deep comparison the Layer colour's no-op check uses) and caller font
 *  facts through the same facts equality the Layer font's no-op check
 *  uses — so two runs fact sets describing the same look are equal even
 *  when their fill objects are distinct references. */
function textRunsEq(
  a: LayerTextRun[] | undefined,
  b: LayerTextRun[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  return a.every((run, i) => {
    const other = b[i]!;
    return run.start === other.start &&
      fillsEqual(
        normalizeStoredTextFill(run.color ?? EMPTY_RUN_COLOR),
        normalizeStoredTextFill(other.color ?? EMPTY_RUN_COLOR),
      ) &&
      (run.color === undefined) === (other.color === undefined) &&
      run.contentHash === other.contentHash &&
      callerFontEq(run.callerFont, other.callerFont) &&
      run.weight === other.weight &&
      run.width === other.width;
  });
}

/** The absent-run-colour stand-in for the equality's fill comparison: the
 *  runs equality compares overrides, so both-absent is the same look
 *  regardless of the Layer colour — the sentinel never leaks to storage. */
const EMPTY_RUN_COLOR = "#000000";

function fitBoxEq(
  fitBox: TextFitBox | undefined,
  prevRev: { fitWidth?: number; fitHeight?: number },
): boolean {
  if (fitBox === undefined) return prevRev.fitWidth === undefined && prevRev.fitHeight === undefined;
  return fitBox.width === prevRev.fitWidth && fitBox.height === prevRev.fitHeight;
}

/** The one shape fold for a stack value at hand (#302, ADR-0027): a single
 *  object folds to a one-element list; a list passes through. Callers hold
 *  already-validated values (the edit draft starts from the resolved
 *  revision or a fresh parse), so this carries no validation — the stored
 *  normalizers own that. */
/** The one storage fold for a stack value (#302, ADR-0027): a one-element
 *  list collapses to the single object — the canonical one-effect shape, a
 *  stored length-1 list is a second answer for the same fact — and longer
 *  lists store as lists. This is the fold between the resolved view (and
 *  the edit draft, which starts from it) and every stored document; the
 *  stored normalizers own the reverse (read) direction. Exported for the
 *  cross-Project copy's verbatim carry. */
export function storedEffectStack<T>(value: T | T[] | undefined): T | T[] | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.length === 1 ? list[0]! : list;
}

function shadowStackOf(value: LayerShadow | LayerShadow[] | undefined): LayerShadow[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

function outlineStackOf(value: LayerOutline | LayerOutline[] | undefined): LayerOutline[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/** Field-wise shadow-stack equality for the no-op check (#139; stacking
 *  #302, ADR-0027): the flip precedent — re-issuing an identical shadow or
 *  stack is a detected no-op, never a redundant revision. Both sides fold
 *  through the one shape fold, so a single object and its one-element
 *  resolved list describe the same fact. */
function shadowEq(a: LayerShadow | LayerShadow[] | undefined, b: LayerShadow | LayerShadow[] | undefined): boolean {
  const as = shadowStackOf(a);
  const bs = shadowStackOf(b);
  if (as === undefined || bs === undefined) return as === bs;
  if (as.length !== bs.length) return false;
  return as.every((s, i) => {
    const o = bs[i]!;
    return s.dx === o.dx && s.dy === o.dy && s.blur === o.blur && s.color === o.color;
  });
}

/** Caller font facts equality (#232): both sides are normalized facts
 *  objects (fixed key order from their constructors), so a structural
 *  comparison is a serialized comparison. */
function callerFontEq(a: CallerFontFacts | undefined, b: CallerFontFacts | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Field-wise outline-stack equality for the no-op check (#140; stacking
 *  #302, ADR-0027): the flip precedent, folded like the shadow's. */
function outlineEq(a: LayerOutline | LayerOutline[] | undefined, b: LayerOutline | LayerOutline[] | undefined): boolean {
  const as = outlineStackOf(a);
  const bs = outlineStackOf(b);
  if (as === undefined || bs === undefined) return as === bs;
  if (as.length !== bs.length) return false;
  return as.every((o, i) => o.width === bs[i]!.width && o.color === bs[i]!.color);
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
  options.wrapWidth !== undefined ||
  options.fitBox !== undefined ||
  options.runAppend !== undefined ||
  options.runText !== undefined ||
  options.runStyles !== undefined ||
  options.runsNone !== undefined ||
  options.shape !== undefined ||
  options.size !== undefined ||
  options.cornerRadius !== undefined ||
  options.fill !== undefined;

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
/** The resize/scale intent a scale resolution reads: the five mutually
 *  exclusive forms plus the content-replacement presence the domain
 *  re-check reads (the shared application cases pass one form; the edit
 *  path's domain re-check passes the content flags too). */
export interface LayerResizeIntent {
  resizeFactor?: number;
  resizeTo?: { width?: number; height?: number };
  coverTo?: { width?: number; height?: number } | "canvas";
  scale?: number;
  scaleTo?: { scaleX?: number; scaleY?: number };
  image?: string;
  fromGeneration?: unknown;
  fromMatte?: unknown;
}

export function resolveEditScale(
  options: LayerResizeIntent,
  prevRev: ResolvedLayerRevision,
  layerId: string,
): LayerTransformScale {
  const hasFactor = options.resizeFactor !== undefined;
  const hasTarget = options.resizeTo !== undefined;
  const hasCover = options.coverTo !== undefined;
  const hasScale = options.scale !== undefined;
  const hasScaleTo = options.scaleTo !== undefined;
  if (!hasFactor && !hasTarget && !hasCover && !hasScale && !hasScaleTo) {
    return { scaleX: prevRev.scaleX, scaleY: prevRev.scaleY };
  }

  // The ONE resize-form exclusivity rule (#133, extended by #231 to the
  // absolute --scale setter, by #293 to --cover-to, and by #296 to the
  // absolute per-axis --scale-to): at most one of the
  // five forms per edit. The refusal runs before any staging, so a
  // conflicting request never advances live state.
  const formCount = [hasFactor, hasTarget, hasCover, hasScale, hasScaleTo].filter(Boolean).length;
  if (formCount > 1) {
    if (hasFactor && hasTarget) {
      throw new Error("--resize and --resize-to are mutually exclusive resize forms: use one per edit.");
    }
    if (hasCover && hasFactor) {
      throw new Error("--cover-to and --resize are mutually exclusive resize forms: use one per edit.");
    }
    if (hasCover && hasTarget) {
      throw new Error("--cover-to and --resize-to are mutually exclusive resize forms: use one per edit.");
    }
    if (hasCover && hasScale) {
      throw new Error(
        "--cover-to and --scale are mutually exclusive: use one resize form per edit (--cover-to sets a cover-fit size, --scale sets the absolute scale).",
      );
    }
    if (hasFactor && hasScale) {
      throw new Error(
        "--resize and --scale are mutually exclusive: use one resize form per edit (--resize is relative, --scale sets the absolute scale).",
      );
    }
    if (hasScaleTo && hasFactor) {
      throw new Error(
        "--resize and --scale-to are mutually exclusive: use one resize form per edit (--resize is relative, --scale-to sets the absolute per-axis scale).",
      );
    }
    if (hasScaleTo && hasTarget) {
      throw new Error(
        "--resize-to and --scale-to are mutually exclusive: use one resize form per edit (--resize-to sets an absolute size, --scale-to sets the absolute per-axis scale).",
      );
    }
    if (hasScaleTo && hasCover) {
      throw new Error(
        "--cover-to and --scale-to are mutually exclusive: use one resize form per edit (--cover-to sets a cover-fit size, --scale-to sets the absolute per-axis scale).",
      );
    }
    if (hasScaleTo && hasScale) {
      throw new Error(
        "--scale and --scale-to are mutually exclusive: use one resize form per edit (--scale sets a uniform absolute scale, --scale-to sets the absolute per-axis scale).",
      );
    }
    throw new Error(
      "--resize-to and --scale are mutually exclusive: use one resize form per edit (--resize-to sets an absolute size, --scale sets the absolute scale).",
    );
  }
  const replacesContent =
    options.image !== undefined || options.fromGeneration !== undefined || options.fromMatte !== undefined;
  if (replacesContent) {
    throw new Error(
      hasScale || hasScaleTo
        ? `Scale and content replacement are separate edits: Layer "${layerId}" cannot replace its source and set ${hasScale ? "--scale" : "--scale-to"} in one edit, because the effective-size cap reads the retained content's intrinsic size.`
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

  if (hasScaleTo) {
    // Absolute per-axis scale setter (#296, spec #285 US-030, DEC-005,
    // ADR-0016 amendment): the two factors ARE the canonical scale, so
    // repeating the command is idempotent by construction and the uniform
    // --scale's whole-fact replacement holds in reverse (one fact, never
    // two). One omitted axis keeps the Layer's current scale on that axis —
    // the --resize-to one-axis rule at factor semantics. The per-axis
    // factors share the uniform setter's bounds wording verbatim, on every
    // kind (text included: its per-axis scale was previously unreachable).
    const { scaleX, scaleY } = options.scaleTo!;
    for (const factor of [scaleX, scaleY]) {
      if (factor !== undefined && (!Number.isFinite(factor) || factor <= 0 || factor > MAX_DIMENSION)) {
        throw new Error(
          `Invalid scale ${factor}: must be a finite number between 0 and ${MAX_DIMENSION}.`,
        );
      }
    }
    return boundedScale(
      { scaleX: scaleX ?? prevRev.scaleX, scaleY: scaleY ?? prevRev.scaleY },
      prevRev,
      layerId,
    );
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

  if (hasCover) {
    // Cover fit (#293, spec #285 US-007, DEC-011): a uniform scale — the
    // max of the cover ratios over the intrinsic size — fills the target
    // with the aspect preserved, so the overflow stays outside the canvas
    // and nothing is clipped. An input form, never a stored fact: the ONE
    // canonical scale facts carry the result, exactly like --resize-to.
    const target = options.coverTo;
    if (target === "canvas") {
      // The "canvas" keyword resolves at the command boundary (add: the
      // target Composition's canvas; edit: the agreeing referrers'), so it
      // never reaches the Composition-free stored-state resolution.
      throw new Error(
        `Internal error: --cover-to "canvas" must resolve to a concrete target before scale resolution (Layer "${layerId}").`,
      );
    }
    if (target === undefined || typeof target !== "object") {
      throw new Error(`Invalid cover target: --cover-to needs a "<W>x<H>" box or "canvas" (Layer "${layerId}").`);
    }
    coverKindGate(prevRev.kind, layerId);
    const { width, height } = target;
    for (const [label, value] of [["width", width], ["height", height]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > MAX_DIMENSION)) {
        throw new Error(
          `Invalid cover target ${label} ${value}: must be a finite number between 0 and ${MAX_DIMENSION}.`,
        );
      }
    }
    if (width === undefined && height === undefined) {
      throw new Error('Invalid cover target: --cover-to needs at least one of width or height, or "canvas".');
    }
    const coverScale = Math.max(
      ...(width !== undefined ? [width / prevRev.width] : []),
      ...(height !== undefined ? [height / prevRev.height] : []),
    );
    return boundedScale({ scaleX: coverScale, scaleY: coverScale }, prevRev, layerId);
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
/** The applied shared-option facts an edit publishes (DEC-001, #263):
 *  derived, not enumerated — an application case's fact carries when the
 *  stored revision's own key set has no such key, i.e. when the case ADDED
 *  it. Every stored-revision field (canonical or resolved-only) is in
 *  prevRev, so the carry is empty for every existing edit and no stored
 *  field can flow into it: no-op edits stay no-ops, and a new option's
 *  fact publishes on both surfaces from one registration. */
function carryAppliedSharedFacts(
  draft: SharedOptionDraft,
  prevRev: ResolvedLayerRevision,
): Record<string, unknown> {
  const carried: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft)) {
    if (!(key in prevRev) && value !== undefined) {
      carried[key] = value;
    }
  }
  return carried;
}

/** The skew pair's stored shape (#298): recorded together, stored only when
 *  set — the identity form is never stored, so an unskewed revision keeps
 *  its exact pre-#298 document shape and id. */
function skewStored(d: { skewXDeg?: number; skewYDeg?: number }): boolean {
  return (d.skewXDeg ?? 0) !== 0 || (d.skewYDeg ?? 0) !== 0;
}

/** The perspective pair's stored shape (#298): recorded together, stored
 *  only when set — the same rule as the skew pair. */
function perspectiveStored(d: { perspectiveTiltXDeg?: number; perspectiveTiltYDeg?: number }): boolean {
  return (d.perspectiveTiltXDeg ?? 0) !== 0 || (d.perspectiveTiltYDeg ?? 0) !== 0;
}

/**
 * The divergent-perspective publication gate (PROD-1, #298 review): the
 * ONE refusal the add and edit publication paths share, run on the
 * would-be revision BEFORE anything is staged — so a Layer that measure
 * would refuse (its content, plus its own effect extent, projects deeper
 * than the fixed 1000px perspective distance) can never be stored. The
 * render path emits the perspective CSS unconditionally, so storage is the
 * only place the loud refusal can live.
 *
 * The content extent is the revision's own for image and shape kinds; a
 * text Layer's extent is its measured line box (the same fact the visible
 * region validates against), measured only when the resulting tilt is
 * nonzero — the only case where a refusal is possible.
 */
export async function refuseDivergentPerspectiveProjection(
  revision: LayerRevision,
  extent: { width: number; height: number } | undefined,
  contentBytes?: Buffer,
  runFonts?: SnapshotRunFont[],
): Promise<void> {
  const tilt = normalizeStoredPerspective(revision);
  if (tilt.perspectiveTiltXDeg === 0 && tilt.perspectiveTiltYDeg === 0) {
    return;
  }
  let content: { width: number; height: number };
  if (revision.kind === "text") {
    if (contentBytes === undefined) {
      throw new Error(
        `Layer "${revision.layerId}" carries a perspective tilt but its content bytes are unavailable — refusing to validate the projection.`,
      );
    }
    // The text extent is the measured line box, from the bytes the new
    // revision pins (the same standalone measure the region and fit
    // validations run).
    const standalone = await measureStandaloneSnapshot(
      { ...revision, x: 0, y: 0 } as unknown as ResolvedLayerRevision,
      contentBytes,
      { ...(runFonts !== undefined && runFonts.length > 0 ? { runFonts } : {}) },
    );
    content = standalone.content;
  } else {
    if (extent === undefined) {
      throw new Error(
        `Layer "${revision.layerId}" carries a perspective tilt but its content extent is unavailable — refusing to validate the projection.`,
      );
    }
    content = extent;
  }
  const refusal = transformBlowupRefusal(revision, content, revision.layerId);
  if (refusal !== null) {
    throw new Error(refusal);
  }
}

async function buildEditedRevision(
  resolvedRoot: string,
  prevRev: ResolvedLayerRevision,
  layerId: string,
  createdAt: string,
  options: EditLayerOptions,
  /** The parsed shared option values (DEC-001, #263): the vector colour's
   * presence feeds the raster gate's given/value pair. */
  shared: SharedOptionValues,
  /** The application draft (#263): the stored revision plus the resolved
   * placement, mutated by the shared application cases in the edit
   * surface's established application order. The branches read its
   * canonical facts and carry its applied shared-option facts. */
  draft: SharedOptionDraft,
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
  const { x, y, opacity } = draft;

  // The storage fold for the carried/applied stacks (#302, ADR-0027): the
  // draft starts from the RESOLVED revision, whose effect fields are the
  // normalized lists — a one-effect list collapses back to the single
  // object (the canonical one-effect shape, never a stored length-1 list)
  // and a stack stores its list. This is the ONE fold between the draft
  // and every stored document below.
  const storedShadow = storedEffectStack(draft.shadow);
  const storedOutline = storedEffectStack(draft.outline);

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
      options.lineHeight !== undefined ||
      options.wrapWidth !== undefined ||
      options.fitBox !== undefined ||
      options.runAppend !== undefined ||
      options.runText !== undefined ||
      options.runStyles !== undefined ||
      options.runsNone !== undefined
    ) {
      throw new Error(`Cannot edit text attributes on an image Layer. Layer "${layerId}" is an image Layer.`);
    }

    let contentHash = prevRev.contentHash;
    // The content extent the gate validates the projection against (PROD-1):
    // the retained content's intrinsic box, updated by every replacement.
    let contentExtent: { width: number; height: number } = { width: prevRev.width, height: prevRev.height };
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
      if (draft.visibleRegion !== undefined) {
        validateKeptVisibleRegion(draft.visibleRegion, box, layerId);
        regionCarried = { visibleRegion: draft.visibleRegion };
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
      vectorColorRasterGate({ given: shared["vector-color"] !== undefined, value: draft.vectorColor }, validated.format, layerId);
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
      vectorColorRasterGate({ given: shared["vector-color"] !== undefined, value: draft.vectorColor }, validated.format, layerId);
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
      vectorColorRasterGate({ given: shared["vector-color"] !== undefined, value: draft.vectorColor }, ingested.format, layerId);
      await storeContentBlob(resolvedRoot, ingested.contentHash, ingested.bytes);
      contentHash = ingested.contentHash;
      contentExtent = { width: ingested.width, height: ingested.height };
    }

    const carried = carryAppliedSharedFacts(draft, prevRev);
    const revision: LayerRevision = {
      schemaVersion: LAYER_SCHEMA_VERSION,
      layerId,
      createdAt,
      kind: "image",
      contentHash,
      x,
      y,
      opacity,
      scaleX: draft.scaleX,
      scaleY: draft.scaleY,
      rotationDeg: draft.rotationDeg,
      flipX: draft.flipX,
      flipY: draft.flipY,
      ...(skewStored(draft) ? { skewXDeg: draft.skewXDeg, skewYDeg: draft.skewYDeg } : {}),
      ...(perspectiveStored(draft)
        ? { perspectiveTiltXDeg: draft.perspectiveTiltXDeg, perspectiveTiltYDeg: draft.perspectiveTiltYDeg }
        : {}),
      ...(storedShadow !== undefined ? { shadow: storedShadow } : {}),
      ...(storedOutline !== undefined ? { outline: storedOutline } : {}),
      ...(draft.visibleRegion !== undefined ? { visibleRegion: draft.visibleRegion } : {}),
      ...(draft.vectorColor !== undefined ? { vectorColor: draft.vectorColor } : {}),
      ...(draft.grade !== undefined ? { grade: draft.grade } : {}),
      ...(draft.blend !== undefined ? { blend: draft.blend } : {}),
      ...(draft.glow !== undefined ? { glow: draft.glow } : {}),
      ...(draft.blur !== undefined ? { blur: draft.blur } : {}),
      ...(draft.choke !== undefined ? { choke: draft.choke } : {}),
      ...(draft.feather !== undefined ? { feather: draft.feather } : {}),
      ...carried,
    };
    const unchanged =
      contentHash === prevRev.contentHash && x === prevRev.x && y === prevRev.y && opacity === prevRev.opacity &&
      draft.scaleX === prevRev.scaleX && draft.scaleY === prevRev.scaleY &&
      draft.rotationDeg === prevRev.rotationDeg &&
      draft.flipX === prevRev.flipX && draft.flipY === prevRev.flipY &&
      (draft.skewXDeg ?? 0) === (prevRev.skewXDeg ?? 0) && (draft.skewYDeg ?? 0) === (prevRev.skewYDeg ?? 0) &&
      (draft.perspectiveTiltXDeg ?? 0) === (prevRev.perspectiveTiltXDeg ?? 0) &&
      (draft.perspectiveTiltYDeg ?? 0) === (prevRev.perspectiveTiltYDeg ?? 0) &&
      shadowEq(draft.shadow, prevRev.shadow) &&
      outlineEq(draft.outline, prevRev.outline) &&
      visibleRegionEq(draft.visibleRegion, prevRev.visibleRegion) &&
      draft.vectorColor === prevRev.vectorColor &&
      gradeEq(draft.grade, prevRev.grade) &&
      draft.blend === prevRev.blend &&
      glowEq(draft.glow, prevRev.glow) &&
      normalizeStoredBlur(draft) === normalizeStoredBlur(prevRev) &&
      normalizeStoredChoke(draft) === normalizeStoredChoke(prevRev) &&
      normalizeStoredFeather(draft) === normalizeStoredFeather(prevRev) &&
      Object.keys(carried).length === 0;
    // The divergent-perspective publication gate (PROD-1, #298 review):
    // the image extent is the retained content's intrinsic box — run before
    // anything stages.
    await refuseDivergentPerspectiveProjection(revision, contentExtent, prevContentBytes);
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
      options.lineHeight !== undefined ||
      options.wrapWidth !== undefined ||
      options.fitBox !== undefined ||
      options.runAppend !== undefined ||
      options.runText !== undefined ||
      options.runStyles !== undefined ||
      options.runsNone !== undefined
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
      (shared.resize !== undefined || shared["resize-to"] !== undefined || shared["cover-to"] !== undefined || shared.scale !== undefined || shared["scale-to"] !== undefined)
    ) {
      throw new Error(
        `--size and the resize forms (--resize, --resize-to, --cover-to, --scale, --scale-to) are separate edits: Layer "${layerId}" cannot set the geometry's intrinsic size and resize in one edit, because the effective-size cap and the resize reference read the geometry's intrinsic size.`,
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

    const carried = carryAppliedSharedFacts(draft, prevRev);
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
      scaleX: draft.scaleX,
      scaleY: draft.scaleY,
      rotationDeg: draft.rotationDeg,
      flipX: draft.flipX,
      flipY: draft.flipY,
      ...(skewStored(draft) ? { skewXDeg: draft.skewXDeg, skewYDeg: draft.skewYDeg } : {}),
      ...(perspectiveStored(draft)
        ? { perspectiveTiltXDeg: draft.perspectiveTiltXDeg, perspectiveTiltYDeg: draft.perspectiveTiltYDeg }
        : {}),
      ...(storedShadow !== undefined ? { shadow: storedShadow } : {}),
      ...(storedOutline !== undefined ? { outline: storedOutline } : {}),
      ...(draft.visibleRegion !== undefined ? { visibleRegion: draft.visibleRegion } : {}),
      ...(draft.grade !== undefined ? { grade: draft.grade } : {}),
      ...(draft.blend !== undefined ? { blend: draft.blend } : {}),
      ...(draft.glow !== undefined ? { glow: draft.glow } : {}),
      ...(draft.blur !== undefined ? { blur: draft.blur } : {}),
      ...(draft.choke !== undefined ? { choke: draft.choke } : {}),
      ...(draft.feather !== undefined ? { feather: draft.feather } : {}),
      ...carried,
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
      draft.scaleX === prevRev.scaleX &&
      draft.scaleY === prevRev.scaleY &&
      draft.rotationDeg === prevRev.rotationDeg &&
      draft.flipX === prevRev.flipX &&
      draft.flipY === prevRev.flipY &&
      (draft.skewXDeg ?? 0) === (prevRev.skewXDeg ?? 0) && (draft.skewYDeg ?? 0) === (prevRev.skewYDeg ?? 0) &&
      (draft.perspectiveTiltXDeg ?? 0) === (prevRev.perspectiveTiltXDeg ?? 0) &&
      (draft.perspectiveTiltYDeg ?? 0) === (prevRev.perspectiveTiltYDeg ?? 0) &&
      shadowEq(draft.shadow, prevRev.shadow) &&
      outlineEq(draft.outline, prevRev.outline) &&
      visibleRegionEq(draft.visibleRegion, prevRev.visibleRegion) &&
      gradeEq(draft.grade, prevRev.grade) &&
      draft.blend === prevRev.blend &&
      glowEq(draft.glow, prevRev.glow) &&
      normalizeStoredBlur(draft) === normalizeStoredBlur(prevRev) &&
      normalizeStoredChoke(draft) === normalizeStoredChoke(prevRev) &&
      normalizeStoredFeather(draft) === normalizeStoredFeather(prevRev) &&
      Object.keys(carried).length === 0;
    // A region KEPT across a geometry edit (#211 review PROD-1): --shape and
    // --size change the content box, so the kept region re-validates against
    // the merged geometry before anything is published — outside is refused
    // (US-003); fitting publishes with the `regionCarried` report. A radius
    // or fill edit does not change the box.
    let regionCarried: EditLayerResult["regionCarried"];
    if (draft.visibleRegion !== undefined && (options.shape !== undefined || options.size !== undefined)) {
      validateKeptVisibleRegion(
        draft.visibleRegion,
        { width: shapeContent.width, height: shapeContent.height },
        layerId,
      );
      regionCarried = { visibleRegion: draft.visibleRegion };
    }
    // The divergent-perspective publication gate (PROD-1, #298 review):
    // the shape extent is its own geometry — run before anything stages.
    await refuseDivergentPerspectiveProjection(revision, { width: revision.width, height: revision.height });
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
    const rawColor = options.color !== undefined ? options.color : prevRev.color;

    // Canonical text validation
    const fill = validateTextContent(text, fontSize, rawColor);
    const color = canonicalizeTextFillForStorage(fill);

    // The wrap width control (#294, spec #285 US-015, DEC-001/DEC-005,
    // ADR-0017 amendment) resolves at the same one domain boundary as the
    // typography controls — a refused width publishes nothing, `null` clears
    // the stored width (removing it restores the unwrapped render
    // byte-for-byte), and an omitted option carries the current value. The
    // width is stored only when set; setting it is an edit, so a legacy-rule
    // revision below publishes `layoutRule: "natural"` with it.
    const wrapWidth = resolveTextWrapWidthControl(
      options.wrapWidth !== undefined ? options.wrapWidth : prevRev.wrapWidth,
    );

    // The fit box control (#295, spec #285 US-016, DEC-010/DEC-005) resolves
    // at the same one domain boundary — a refused box publishes nothing,
    // `null` clears the stored box (removing it restores the render
    // byte-for-byte), and an omitted option carries the current value. The
    // box is stored only when set; setting one is an edit, so a legacy-rule
    // revision below publishes `layoutRule: "natural"` with it. The
    // fit/wrap combination rule compares the EFFECTIVE values: a box
    // narrower than the (possibly carried) wrap width could never be
    // satisfied by shrinking, so it is refused here, naming both.
    const fitBox = resolveTextFitBoxControl(
      options.fitBox !== undefined
        ? options.fitBox
        : prevRev.fitWidth !== undefined
          ? { width: prevRev.fitWidth, height: prevRev.fitHeight! }
          : undefined,
    );
    if (fitBox !== undefined && wrapWidth !== undefined && fitBox.width < wrapWidth) {
      throw new Error(textFitBoxNarrowerThanWrapRefusal(fitBox.width, wrapWidth));
    }

    // The revision's caller font facts (#232, DEC-006): a --font-file edit
    // stores the file's facts; a later edit without a font option keeps the
    // retained caller font verbatim; switching to a bundled family (--font)
    // drops them — the revision is a bundled-face revision again.
    const resolvedCallerFont =
      callerFont ?? (options.font !== undefined ? undefined : prevRev.callerFont);

    // Text runs (#297, spec #285 US-017, ISC-54, ADR-0021 amendment): the
    // runs-side edits apply through the ONE edit application — boundaries
    // derived, overrides resolved per run, every validation before anything
    // is retained. Bare --text on a multi-run Layer is refused here (the
    // domain boundary no caller can bypass).
    const prevRuns = normalizeStoredTextRuns(prevRev);
    if (options.text !== undefined && prevRuns !== undefined) {
      throw new Error(multiRunTextReplacementRefusal(layerId));
    }
    const prevRunFonts = await loadSnapshotRunFonts(resolvedRoot, prevRev);
    const runEdits = await applyTextInputRunEdits({
      layerId,
      // The runs application starts from the would-be text (a bare --text
      // replacement on a single-run Layer; on a multi-run Layer the bare
      // form is refused above, so runs edits start from the stored text).
      prevText: text,
      ...(prevRuns !== undefined ? { prevRuns } : {}),
      ...(options.runAppend !== undefined ? { runAppend: options.runAppend } : {}),
      ...(options.runText !== undefined ? { runText: options.runText } : {}),
      ...(options.runStyles !== undefined ? { runStyles: options.runStyles } : {}),
      ...(options.runsNone !== undefined ? { runsNone: options.runsNone } : {}),
      layerFace: () =>
        face ?? (prevRev.callerFont !== undefined ? callerFontFace(prevRev.callerFont) : faceByContentHash(prevRev.contentHash)),
      layerAxes: axes.weight !== undefined ? axes : undefined,
      layerContentHash: contentHash,
      ...(prevRunFonts.length > 0 ? { prevRunFonts } : {}),
    });
    // Run font retention (#297): the SAME content-store path and the SAME
    // browser-resolution gate the layer font goes through — both before
    // anything publishes.
    for (const runFont of runEdits.newRunFonts) {
      if (runFont.caller !== undefined) {
        await verifyCallerFontResolves(runFont.contentHash, runFont.bytes, runFont.caller);
      }
      await storeContentBlob(resolvedRoot, runFont.contentHash, runFont.bytes);
    }

    const carried = carryAppliedSharedFacts(draft, prevRev);
    const revision: LayerRevision = {
      schemaVersion: LAYER_SCHEMA_VERSION,
      layerId,
      createdAt,
      kind: "text",
      contentHash,
      text: runEdits.text,
      fontSize,
      color,
      layoutRule: "natural",
      ...(axes.weight !== undefined ? { weight: axes.weight, width: axes.width } : {}),
      ...(typography.tracking !== undefined ? { tracking: typography.tracking } : {}),
      ...(typography.lineHeight !== undefined ? { lineHeight: typography.lineHeight } : {}),
      ...(wrapWidth !== undefined ? { wrapWidth } : {}),
      ...(fitBox !== undefined ? { fitWidth: fitBox.width, fitHeight: fitBox.height } : {}),
      ...(resolvedCallerFont !== undefined ? { callerFont: resolvedCallerFont } : {}),
      ...(runEdits.runs !== undefined ? { runs: runEdits.runs } : {}),
      x,
      y,
      opacity,
      scaleX: draft.scaleX,
      scaleY: draft.scaleY,
      rotationDeg: draft.rotationDeg,
      flipX: draft.flipX,
      flipY: draft.flipY,
      ...(skewStored(draft) ? { skewXDeg: draft.skewXDeg, skewYDeg: draft.skewYDeg } : {}),
      ...(perspectiveStored(draft)
        ? { perspectiveTiltXDeg: draft.perspectiveTiltXDeg, perspectiveTiltYDeg: draft.perspectiveTiltYDeg }
        : {}),
      ...(storedShadow !== undefined ? { shadow: storedShadow } : {}),
      ...(storedOutline !== undefined ? { outline: storedOutline } : {}),
      ...(draft.visibleRegion !== undefined ? { visibleRegion: draft.visibleRegion } : {}),
      ...(draft.grade !== undefined ? { grade: draft.grade } : {}),
      ...(draft.blend !== undefined ? { blend: draft.blend } : {}),
      ...(draft.glow !== undefined ? { glow: draft.glow } : {}),
      ...(draft.blur !== undefined ? { blur: draft.blur } : {}),
      ...(draft.choke !== undefined ? { choke: draft.choke } : {}),
      ...(draft.feather !== undefined ? { feather: draft.feather } : {}),
      ...carried,
    };
    // The runs edits replace the whole-text fact: the stored text is the
    // runs application's text (appends and --run-text rewrite it), so the
    // resulting revision validates through the ONE text validator.
    if (runEdits.text !== text) {
      validateTextContent(runEdits.text, fontSize, rawColor);
    }
    const unchanged =
      prevRev.layoutRule === "natural" &&
      contentHash === prevRev.contentHash &&
      runEdits.text === prevRev.text &&
      textRunsEq(prevRuns, runEdits.runs) &&
      fontSize === prevRev.fontSize &&
      fillsEqual(fill, normalizeStoredTextFill(prevRev.color)) &&
      axes.weight === prevRev.weight &&
      axes.width === prevRev.width &&
      typography.tracking === prevRev.tracking &&
      typography.lineHeight === prevRev.lineHeight &&
      wrapWidth === prevRev.wrapWidth &&
      fitBoxEq(fitBox, prevRev) &&
      callerFontEq(resolvedCallerFont, prevRev.callerFont) &&
      x === prevRev.x &&
      y === prevRev.y &&
      opacity === prevRev.opacity &&
      draft.scaleX === prevRev.scaleX &&
      draft.scaleY === prevRev.scaleY &&
      draft.rotationDeg === prevRev.rotationDeg &&
      draft.flipX === prevRev.flipX &&
      draft.flipY === prevRev.flipY &&
      (draft.skewXDeg ?? 0) === (prevRev.skewXDeg ?? 0) && (draft.skewYDeg ?? 0) === (prevRev.skewYDeg ?? 0) &&
      (draft.perspectiveTiltXDeg ?? 0) === (prevRev.perspectiveTiltXDeg ?? 0) &&
      (draft.perspectiveTiltYDeg ?? 0) === (prevRev.perspectiveTiltYDeg ?? 0) &&
      shadowEq(draft.shadow, prevRev.shadow) &&
      outlineEq(draft.outline, prevRev.outline) &&
      visibleRegionEq(draft.visibleRegion, prevRev.visibleRegion) &&
      gradeEq(draft.grade, prevRev.grade) &&
      draft.blend === prevRev.blend &&
      glowEq(draft.glow, prevRev.glow) &&
      normalizeStoredBlur(draft) === normalizeStoredBlur(prevRev) &&
      normalizeStoredChoke(draft) === normalizeStoredChoke(prevRev) &&
      normalizeStoredFeather(draft) === normalizeStoredFeather(prevRev) &&
      Object.keys(carried).length === 0;
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
      draft.visibleRegion !== undefined &&
      (options.text !== undefined || options.font !== undefined || options.fontFile !== undefined ||
        options.fontSize !== undefined || options.weight !== undefined || options.width !== undefined ||
        options.tracking !== undefined || options.lineHeight !== undefined ||
        options.wrapWidth !== undefined || options.fitBox !== undefined ||
        options.runAppend !== undefined || options.runText !== undefined ||
        options.runStyles !== undefined || options.runsNone !== undefined)
    ) {
      const standalone = await measureStandaloneSnapshot(
        { ...revision, x: 0, y: 0 } as ResolvedLayerRevision,
        newTextBytes ?? prevContentBytes,
        { ...(runEdits.runFonts.length > 0 ? { runFonts: runEdits.runFonts } : {}) },
      );
      validateKeptVisibleRegion(draft.visibleRegion, standalone.content, layerId);
      regionCarried = { visibleRegion: draft.visibleRegion };
    }
    // Fit-to-box validation (#295, spec #285 US-016, DEC-010): the fit box
    // is validated against the RESULTING revision whenever this edit can
    // change the fit — the text, font, size, axes, typography, wrap width,
    // or the box itself — before anything is published. The ONE in-page fit
    // derivation (the same pass paint, measure, and anchor run) derives the
    // effective size; text that cannot fit at the minimum size is refused,
    // naming the box and the size needed. Edits that cannot change the fit
    // (placement, opacity, effects) skip the probe: the published state was
    // already validated at its own write time.
    if (revision.fitWidth !== undefined) {
      const fitRelevant =
        options.text !== undefined || options.font !== undefined || options.fontFile !== undefined ||
        options.fontSize !== undefined || options.weight !== undefined || options.width !== undefined ||
        options.tracking !== undefined || options.lineHeight !== undefined ||
        options.wrapWidth !== undefined || options.fitBox !== undefined ||
        options.runAppend !== undefined || options.runText !== undefined ||
        options.runStyles !== undefined || options.runsNone !== undefined;
      if (fitRelevant) {
        const fit = await measureTextFit(
          { ...revision, x: 0, y: 0 } as ResolvedLayerRevision,
          newTextBytes ?? prevContentBytes,
          { ...(runEdits.runFonts.length > 0 ? { runFonts: runEdits.runFonts } : {}) },
        );
        if (fit !== null && !fit.fits) {
          throw new Error(
            textFitRefusal(revision.text, revision.fitWidth, revision.fitHeight!, fit.neededFontSize ?? revision.fontSize),
          );
        }
      }
    }
    // The divergent-perspective publication gate (PROD-1, #298 review):
    // the text extent is the measured line box, from the bytes the new
    // revision pins — run before anything stages.
    await refuseDivergentPerspectiveProjection(
      revision,
      undefined,
      newTextBytes ?? prevContentBytes,
      runEdits.runFonts,
    );
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

  // 3. Placement options: preserve existing values if omitted (placement's
  //    application is the edit lifecycle's preserve-or-replace on the stored
  //    revision and add's creation defaults — not a shared application
  //    case). The converged post-content options (#263) dispatch through
  //    their ONE shared application cases against a draft of the STORED
  //    revision (under the Project lock), in the edit surface's established
  //    application order — omitted options preserve the current revision by
  //    construction (the draft starts there). The dispatch context carries
  //    what the shared cases resolve against: the stored revision, its
  //    verified bytes, and the vector-colour raster gate's format input
  //    (deferred to the ingested content when this edit replaces it).
  const placement = resolveEditPlacement(options, prevRev);
  const shared = options.shared ?? {};
  const draft = { ...prevRev, ...placement } as SharedOptionDraft;
  // The stored revision's run font bytes (#297, verified by the revision
  // reader): the region application's standalone measurement paints the run
  // spans, so a run font override's bytes ride beside the content bytes.
  const sharedContext: SharedOptionApplyContext = {
    surface: "edit",
    base: prevRev,
    layerId,
    contentBytes: current.contentBytes,
    ...(current.runFonts !== undefined && current.runFonts.length > 0 ? { runFonts: current.runFonts } : {}),
    format:
      options.image === undefined && options.fromGeneration === undefined && options.fromMatte === undefined && prevRev.kind === "image"
        ? prevRev.format
        : undefined,
    parsed: shared,
  };
  for (const step of EDIT_APPLICATION_ORDER) {
    if ("policy" in step) {
      if (step.policy === "resize-forms") {
        // The domain re-checks of the ONE resize-form rule (#133/#231), at
        // the resolver's established position: at most one form per edit,
        // and never together with content replacement — the same
        // exclusivity rule the boundary parse refuses (exit 2), re-checked
        // at the domain boundary so no caller of the edit functions can
        // bypass it.
        resolveEditScale(
          {
            ...(shared.resize !== undefined ? { resizeFactor: shared.resize as number } : {}),
            ...(shared["resize-to"] !== undefined
              ? { resizeTo: shared["resize-to"] as { width?: number; height?: number } }
              : {}),
            ...(shared["cover-to"] !== undefined
              ? { coverTo: shared["cover-to"] as { width?: number; height?: number } | "canvas" }
              : {}),
            ...(shared.scale !== undefined ? { scale: shared.scale as number } : {}),
            ...(shared["scale-to"] !== undefined
              ? { scaleTo: shared["scale-to"] as { scaleX?: number; scaleY?: number } }
              : {}),
            image: options.image,
            fromGeneration: options.fromGeneration,
            fromMatte: options.fromMatte,
          },
          prevRev,
          layerId,
        );
        continue;
      }
      // "region-content": the region is validated against the content box,
      // so content edits are refused in one edit with it — the established
      // position between the effects and the region's application.
      if (
        (shared["visible-region"] !== undefined || shared["visible-region-radius"] !== undefined) &&
        REGION_CONFLICTING_OPTION_PRESENT(options)
      ) {
        throw new Error(
          `Visible region and content edits are separate edits: Layer "${layerId}" cannot set --visible-region/--visible-region-radius and replace or reshape its content in one edit, because the region is validated against the content box. ` +
            `Set the region in its own edit.`,
        );
      }
      continue;
    }
    const value = shared[step.option];
    if (value === undefined) continue;
    // The ONE single-option dispatch (DEC-001, #263): the same lookup the
    // add path runs — an option that parses at the command boundary but has
    // no application case fails loudly here, never silently dropped.
    await applyLayerOption(step.option, draft, value, sharedContext);
  }
  const hasShadow = shared.shadow !== undefined;
  const shadowedReport = { shadow: shadowStackOf(draft.shadow) ?? null };
  const hasOutline = shared.outline !== undefined;
  const outlinedReport = { outline: outlineStackOf(draft.outline) ?? null };
  const hasRegion = shared["visible-region"] !== undefined || shared["visible-region-radius"] !== undefined;
  const regionSetReport = { visibleRegion: draft.visibleRegion ?? null };
  const vectorColorSetReport = { vectorColor: draft.vectorColor ?? null };
  const hasGrade =
    shared.brightness !== undefined ||
    shared.contrast !== undefined ||
    shared.saturation !== undefined ||
    shared.warmth !== undefined;
  const gradeSetReport = { grade: draft.grade ?? null };
  const hasBlend = shared.blend !== undefined;
  const blendSetReport = { blend: draft.blend ?? null };
  const hasGlow = shared.glow !== undefined;
  const glowSetReport = { glow: draft.glow ?? null };
  // Absolute effective facts for the result (#133): the scale is authoritative
  // and always reported; image Layers additionally report the effective size
  // the scale produces from the retained content's intrinsic dimensions.
  const resizedReport =
    prevRev.kind === "image" || prevRev.kind === "shape"
      ? {
          scaleX: draft.scaleX,
          scaleY: draft.scaleY,
          width: roundEffective(prevRev.width * draft.scaleX),
          height: roundEffective(prevRev.height * draft.scaleY),
        }
      : { scaleX: draft.scaleX, scaleY: draft.scaleY };
  const hasResize =
    shared.resize !== undefined || shared["resize-to"] !== undefined || shared["cover-to"] !== undefined || shared.scale !== undefined || shared["scale-to"] !== undefined;
  const hasRotate = shared.rotate !== undefined;
  const rotatedReport = { rotationDeg: draft.rotationDeg };
  // Narrowed once: a defined flip is always a validated literal mode, so the
  // report never needs a cast (and absence means no --flip option was given).
  const flippedReport =
    shared.flip !== undefined ? { flip: shared.flip as "horizontal" | "vertical" | "both" | "none" } : undefined;

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
      shared,
      draft,
      current.contentBytes,
    );
    // An explicit fork always publishes the new identity, even when the
    // edited revision has no other changes (documented no-content-change
    // fork). Because fork is an edit that publishes a new identity,
    // forked text revisions write layoutRule: "natural" through
    // buildEditedRevision, migrating legacy revisions to natural layout
    // (ADR-0017 amendment); only import copies (buildCopiedRevision)
    // preserve the source revision's layout rule.
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
    const withColour = shared["vector-color"] !== undefined ? { ...withRegion, vectorColorSet: vectorColorSetReport } : withRegion;
    const withGrade = hasGrade ? { ...withColour, gradeSet: gradeSetReport } : withColour;
    const withBlend = hasBlend ? { ...withGrade, blendSet: blendSetReport } : withGrade;
    const withGlow = hasGlow ? { ...withBlend, glowSet: glowSetReport } : withBlend;
    const withCarried = regionCarried ? { ...withGlow, regionCarried } : withGlow;
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
    shared,
    draft,
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
      ...(shared["vector-color"] !== undefined ? { vectorColorSet: vectorColorSetReport } : {}),
      ...(hasGrade ? { gradeSet: gradeSetReport } : {}),
      ...(hasBlend ? { blendSet: blendSetReport } : {}),
      ...(hasGlow ? { glowSet: glowSetReport } : {}),
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
    ...(shared["vector-color"] !== undefined ? { vectorColorSet: vectorColorSetReport } : {}),
    ...(hasGrade ? { gradeSet: gradeSetReport } : {}),
    ...(hasBlend ? { blendSet: blendSetReport } : {}),
    ...(hasGlow ? { glowSet: glowSetReport } : {}),
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

