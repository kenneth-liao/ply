#!/usr/bin/env bun
/**
 * The ONE shared option definition for the Layer-editing option surface
 * (spec #226 DEC-001): every option that `ply layer edit` accepts — and
 * that `ply composition add` accepts today or gains with one-command
 * creation (#229) — is declared here once and validated here once.
 *
 * Each option has exactly one declaration and one validation path:
 *
 * - **Declaration** — `LAYER_OPTION_DEFS` states the option's key, its
 *   option group, the Layer kinds it applies to, whether it alone
 *   qualifies as an `layer edit` edit option, and whether its value may
 *   begin with "-" (a negative number). `LAYER_OPTION_PARSE_ARGS` states
 *   the parseArgs entry; `satisfies Record<LayerOptionKey, …>` makes a
 *   definition without a parseArgs entry (or vice versa) a compile error,
 *   and a test pins the two key sets equal.
 * - **Validation** — one `parse…`/`validate…` function per option below,
 *   wrapping the same domain validators the ingestion paths use
 *   (`parseShadowSpec`, `parseOutlineSpec`, `resolveTextAxes`,
 *   `resolveTextTypographyControls`, `resolveFace`), so the CLI boundary
 *   and the publish path can never disagree. Both command boundaries call
 *   these functions; the refusal wording lives here too. The coordinate and
 *   font-size refusals carry ONE wording on every surface (the `layer edit`
 *   wording is canonical — the decision recorded on #226); the content-kind
 *   exclusivity refusals keep each surface's established wording, in this
 *   one place, selected by surface — they are content-kind combination
 *   rules, not shared-option value validation.
 *
 * What deliberately stays per-command: each surface's established check
 * and application *orders* (held as order lists, not per-option code),
 * command-level policy (edit intents like --fork/--in-place, add's
 * defaults and required-content rules), and the help text (each surface's
 * manual describes its own contract). Adding a post-content option means
 * adding it here — to the table with its parse and apply, the parseArgs
 * entry, and the order-list membership — and both surfaces inherit it.
 *
 * Both command surfaces consume this table directly (#263): the option's
 * ONE boundary parse and ONE application case are carried on the table
 * itself (`parse` / `apply`), and both surfaces dispatch through them over
 * their established check and application orders (`EDIT_CHECK_ORDER`,
 * `EDIT_APPLICATION_ORDER`, `ADD_PARSE_ORDER`,
 * `oneCommandApplicationOrder`) — no per-option parse block, options
 * member, presence check, name mapping, or application case names an
 * option on either surface. Per-kind
 * applicability is NOT a second enforcement surface here: the two
 * surfaces' kind parity rests on the shared domain validators (the
 * content-kind exclusivity rule above the resize path's text-Layer
 * refusal), each with its established
 * wording — see `layerOptionsApplicableTo`. The canvas `--width` note from
 * #237 is resolved by decision on #229: on the add surface `--width` IS
 * the text width axis — the same spelling `layer edit` uses, validated
 * through the same shared validator (`parseLayerWidth`) and range check
 * (`validateTextFaceAxes`); the canvas dimension meaning belongs to
 * `composition create` alone. The two subcommands share one parsed flag;
 * no rename and no alias.
 */
import { parseAnchorSpec, type AnchorResolution, type ParsedAnchor, resolveAnchoredPlacement, resolveProvisionalAnchoredPlacement } from "./layer-anchor.js";
import {
  parseShadowSpec,
  parseOutlineSpec,
  parseInnerShadowSpec,
  parseGlowSpec,
  parseVisibleRegionSpec,
  parseVisibleRegionRadiusSpec,
  parseVectorColorSpec,
  resolveTextTypographyControls,
  resolveTextWrapWidthControl,
  resolveTextFitBoxControl,
  vectorColorKindRefusal,
  validateRectangleCornerRadius,
  validateVisibleRegionAgainstContent,
  resolveEditScale,
  coverKindGate,
  resolveEditRotation,
  resolveEditFlip,
  resolveEditSkew,
  resolveEditPerspective,
  resolveEditBlur,
  resolveEditChoke,
  resolveEditFeather,
  MAX_BLUR_RADIUS_PX,
  MAX_EDGE_RADIUS_PX,
  type LayerRevision,
  type ResolvedLayerRevision,
  type LayerRunStyleEdit,
  type SnapshotRunFont,
  type LayerShadow,
  type LayerOutline,
  type LayerInnerShadow,
  type LayerVisibleRegion,
  type LayerGrade,
  type LayerGlow,
  LAYER_BLEND_MODES,
  type LayerBlendMode,
  type StoredLayerBlendMode,
  isValidUseName,
} from "./layer.js";
import { resolveFace, resolveTextAxes } from "./fonts.js";
import { measureStandaloneSnapshot } from "./composition-measure.js";
import { parseFillSpec, type LayerFill as LayerFillSpec } from "./fill.js";

/** Blank supplied values are invalid, never implicit zero (#128). */
export function parseNumericArgument(value: string | undefined): number {
  return value?.trim() ? Number(value) : NaN;
}

/** The presence-only identity parse (DEC-001, #263): for the options whose
 *  value carries no boundary shape — the content markers --image/--text,
 *  --font, and --color, whose validation is the content-kind exclusivity
 *  rule and the semantic ingestion gates — the ONE registration in the
 *  shared option table. Registered so a table key with no registration
 *  fails loudly at runtime on both surfaces instead of being silently
 *  dropped; it never refuses. */
function parseRawOptionValue(raw: string | undefined): OptionParse<string | undefined> {
  return { ok: true, value: raw };
}

/** The unit reference's boundary parse (ADR-0026, #307): the value must be
 *  a valid Composition name under the ONE name rule — the same grammar
 *  `sanitizeName` enforces at publication, so a malformed name refuses at
 *  the parse boundary with the SAME text on `composition add` and
 *  `layer edit` (the refusal-parity contract; on edit the well-formed form
 *  then reaches the add-only refusal). */
export function parseLayerUnitTarget(raw: string | undefined): OptionParse<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, error: "--unit takes a Composition name: the name cannot be empty." };
  }
  if (!isValidUseName(trimmed)) {
    return {
      ok: false,
      error: `--unit takes a Composition name: "${raw}" contains invalid characters (use alphanumeric, dash, or underscore).`,
    };
  }
  return { ok: true, value: raw };
}

/** The command surfaces that share this option surface. */
export type LayerOptionSurface = "edit" | "add";

/** The Layer kinds an option can apply to. */
export type LayerOptionKind = "image" | "text" | "shape" | "unit";

export type LayerOptionGroup = "content" | "paint" | "text" | "placement" | "transform" | "region" | "mask" | "look" | "effect";

export interface LayerOptionDef {
  /** parseArgs key: the flag is `--<key>`. */
  key: LayerOptionKey;
  group: LayerOptionGroup;
  /** For content options: which content kind the option belongs to. */
  contentKind?: "image" | "text" | "shape" | "unit";
  /** The Layer kinds the option applies to. Read by the guard test's
   *  per-kind enumeration (TEST-003); production per-kind refusals stay
   *  with the domain validators (see `layerOptionsApplicableTo`). */
  appliesTo: readonly LayerOptionKind[];
  /** Whether the option alone qualifies as an `layer edit` edit option.
   *  `--output` is an output selector for --from-generation, not an edit
   *  option by itself. */
  editOption: boolean;
  /** The option's value may legitimately begin with "-" (a negative
   *  number), so each command boundary joins it before parsing. */
  dashNumeric?: boolean;
  /** The ONE boundary parse for the option (DEC-001, #263): the shared
   *  validator both command boundaries dispatch through, keyed by the
   *  option's own key — no per-option parse block exists on either
   *  surface. The resize family's five forms are the one cross-option
   *  exclusivity parse (`parseResizeOptions`), dispatched as one step by
   *  each surface's order list. An option whose value carries no boundary
   *  shape (the content markers --image/--text, --font, and --color, whose
   *  validation is semantic in the ingestion paths) registers the
   *  presence-only identity parse, so a table key with NO registration
   *  fails loudly at runtime on both surfaces (#263) instead of being
   *  silently dropped. */
  parse?: (raw: never) => OptionParse<unknown>;
  /** The ONE application case for the option (DEC-001, #263): the shared
   *  application both command surfaces dispatch through, keyed by the
   *  option's own key. Registered for the post-content options — the ones
   *  whose application differs only by the context it resolves against
   *  (the stored revision under lock on edit; a provisional fresh
   *  revision on add). Options whose application differs by more than
   *  context (content replacement, text and shape style merging, add's
   *  placement defaults) stay per-surface by design. A post-content
   *  option with no application case fails loudly at dispatch (#263). */
  apply?: LayerOptionApply;
}

export type LayerOptionKey =
  | "image"
  | "from-generation"
  | "from-matte"
  | "output"
  | "text"
  | "font"
  | "font-file"
  | "font-size"
  | "color"
  | "weight"
  | "width"
  | "tracking"
  | "line-height"
  | "wrap-width"
  | "fit-box"
  | "run"
  | "run-text"
  | "runs"
  | "run-color"
  | "run-font"
  | "run-font-file"
  | "run-weight"
  | "run-width"
  | "shape"
  | "size"
  | "corner-radius"
  | "fill"
  | "unit"
  | "x"
  | "y"
  | "opacity"
  | "anchor"
  | "resize"
  | "resize-to"
  | "cover-to"
  | "scale"
  | "scale-to"
  | "rotate"
  | "flip"
  | "skew"
  | "perspective"
  | "shadow"
  | "outline"
  | "inner-shadow"
  | "vector-color"
  | "visible-region"
  | "visible-region-radius"
  | "mask"
  | "brightness"
  | "contrast"
  | "saturation"
  | "warmth"
  | "blend"
  | "glow"
  | "blur"
  | "choke"
  | "feather";

/**
 * The one option table (DEC-001), in the order the edit surface's
 * enumeration and refusals state the options. Every `layer edit` option
 * and every `composition add` Layer option is declared exactly once here.
 *
 * The FULL registration checklist for one option (DEC-001, #263) — the
 * entry below is the first item; the rest live beside the table:
 *
 * 1. the table entry: key, group, kind applicability, `editOption`, and
 *    `dashNumeric`; `parse` — the ONE boundary parse (the identity parse
 *    for a shapeless marker) — and, for a post-content option, `apply` —
 *    the ONE application case;
 * 2. a `LAYER_OPTION_PARSE_ARGS` entry (the `satisfies` makes a missing
 *    or misspelled entry a compile error);
 * 3. order-list membership: `EDIT_CHECK_ORDER` and `EDIT_APPLICATION_ORDER`
 *    on the edit surface (application only for a post-content option — the
 *    anchor's edit application is the CLI boundary's live-context
 *    resolution through the same shared case), and `ADD_PARSE_ORDER` for a
 *    post-content option (add's application order derives from the
 *    group fact and needs no entry).
 *
 * Every gap in the checklist fails loudly: a missing parse or an order-list
 * omission throws at runtime when the option is supplied on either surface,
 * a missing application case throws at the dispatch, and a missing
 * parseArgs entry is a compile error. The order lists are deliberately
 * per-surface — they hold each surface's established check and application
 * sequences (#257), not per-option code.
 */
export const LAYER_OPTION_DEFS: readonly LayerOptionDef[] = [
  // Content options: what the Layer is made of. Mutually exclusive kinds.
  // --image/--text carry no boundary shape (their validation is the
  // content-kind exclusivity rule and the semantic ingestion gates), so
  // their parse is the presence-only identity.
  { key: "image", group: "content", contentKind: "image", appliesTo: ["image"], editOption: true, parse: parseRawOptionValue },
  { key: "from-generation", group: "content", contentKind: "image", appliesTo: ["image"], editOption: true, parse: parseGenerationJobId },
  { key: "from-matte", group: "content", contentKind: "image", appliesTo: ["image"], editOption: true, parse: parseMatteId },
  { key: "output", group: "content", contentKind: "image", appliesTo: ["image"], editOption: false, parse: (raw) => parseGenerationOutputValue(raw as string) },
  { key: "text", group: "content", contentKind: "text", appliesTo: ["text"], editOption: true, parse: parseRawOptionValue },
  // Shape content options (#208): only meaningful with a shape content kind.
  { key: "shape", group: "content", contentKind: "shape", appliesTo: ["shape"], editOption: true, parse: parseShapeGeometry },
  { key: "size", group: "content", contentKind: "shape", appliesTo: ["shape"], editOption: true, dashNumeric: true, parse: parseShapeSize },
  { key: "corner-radius", group: "content", contentKind: "shape", appliesTo: ["shape"], editOption: true, dashNumeric: true, parse: parseShapeCornerRadius },
  { key: "fill", group: "content", contentKind: "shape", appliesTo: ["shape"], editOption: true, parse: parseLayerFill },
  // The unit Layer (ADR-0026, spec #285 US-018/ISC-36, #307): a Layer whose
  // content is a live reference to another Composition in the same Project.
  // ADD-ONLY: the reference is set at creation and changed only by the unit
  // fork (#341) — `layer edit --unit` is refused, as is --fork on a unit
  // Layer in #307. The value is the inner Composition's name, validated in
  // the publication path through the one name rule.
  { key: "unit", group: "content", contentKind: "unit", appliesTo: ["unit"], editOption: false, parse: parseLayerUnitTarget },
  // The vector colour (#215, spec #207 US-005, DEC-008/009): ONE paint-time
  // colour over a vector image Layer's alpha. Its own group BEFORE the
  // transform group — the colour is content-level paint (it replaces the
  // content's colours; ADR-0023's order paints it with the content, before
  // the region, outline, and shadow) — so one-command add applies it right
  // after the content, before everything post-content. Defined for vector
  // (format svg) image Layers only: the kind/format refusals live with the
  // domain paths (the raster gate reads the would-be content's format, which
  // only ingestion knows).
  { key: "vector-color", group: "paint", appliesTo: ["image"], editOption: true, parse: parseLayerVectorColor, apply: applyVectorColor },
  // Text style options: only meaningful with a text content kind.
  { key: "font", group: "text", appliesTo: ["text"], editOption: true, parse: parseRawOptionValue },
  { key: "font-file", group: "text", appliesTo: ["text"], editOption: true, parse: parseLayerFontFile },
  { key: "font-size", group: "text", appliesTo: ["text"], editOption: true, parse: parseLayerFontSize },
  { key: "color", group: "text", appliesTo: ["text"], editOption: true, parse: parseRawOptionValue },
  { key: "weight", group: "text", appliesTo: ["text"], editOption: true, parse: parseLayerWeight },
  { key: "width", group: "text", appliesTo: ["text"], editOption: true, parse: parseLayerWidth },
  { key: "tracking", group: "text", appliesTo: ["text"], editOption: true, dashNumeric: true, parse: parseLayerTracking },
  { key: "line-height", group: "text", appliesTo: ["text"], editOption: true, dashNumeric: true, parse: parseLayerLineHeight },
  // The wrap width (#294, spec #285 US-015, DEC-001/DEC-005, ADR-0017
  // amendment): an ABSOLUTE setter in layout px — a positive finite number
  // or the removal value "none". A text style option: text-only, and it
  // joins every text content-kind refusal through TEXT_CONTENT_KEYS.
  { key: "wrap-width", group: "text", appliesTo: ["text"], editOption: true, dashNumeric: true, parse: parseLayerWrapWidth },
  // The fit box (#295, spec #285 US-016, DEC-010/DEC-005): an ABSOLUTE
  // setter — a "<W>x<H>" pair of layout px or the removal value "none". A
  // text style option: text-only, and it joins every text content-kind
  // refusal through TEXT_CONTENT_KEYS.
  { key: "fit-box", group: "text", appliesTo: ["text"], editOption: true, dashNumeric: true, parse: parseLayerFitBox },
  // Text runs (#297, spec #285 US-017, ISC-54, ADR-0021 amendment): --run is
  // the repeatable run-text authoring option (each occurrence one run, in
  // command order); the per-run style options are encoded absolute setters
  // ("<1-based run index>=<value>"); --run-text rewrites one run's slice;
  // --runs "none" collapses to the single-run shape. All are text-only and
  // join the text content-kind exclusivity sets through their contentKind.
  { key: "run", group: "text", contentKind: "text", appliesTo: ["text"], editOption: true, parse: parseLayerRun },
  { key: "run-text", group: "text", contentKind: "text", appliesTo: ["text"], editOption: true, parse: parseLayerRunText },
  { key: "runs", group: "text", contentKind: "text", appliesTo: ["text"], editOption: true, parse: parseLayerRuns },
  { key: "run-color", group: "text", contentKind: "text", appliesTo: ["text"], editOption: true, parse: parseLayerRunColor },
  { key: "run-font", group: "text", contentKind: "text", appliesTo: ["text"], editOption: true, parse: parseLayerRunFont },
  { key: "run-font-file", group: "text", contentKind: "text", appliesTo: ["text"], editOption: true, parse: parseLayerRunFontFile },
  { key: "run-weight", group: "text", contentKind: "text", appliesTo: ["text"], editOption: true, parse: parseLayerRunWeight },
  { key: "run-width", group: "text", contentKind: "text", appliesTo: ["text"], editOption: true, parse: parseLayerRunWidth },
  // Placement, transform, and effect options: kind-shared across image,
  // text, and shape Layers (#259) — the shared validators and the paint
  // markup treat a shape's box exactly like an image's content box. Only
  // the vector colour stays image-only (a shape's colour is its fill).
  { key: "x", group: "placement", appliesTo: ["image", "text", "shape"], editOption: true, dashNumeric: true, parse: (raw) => parseLayerCoordinate("x", raw) },
  { key: "y", group: "placement", appliesTo: ["image", "text", "shape"], editOption: true, dashNumeric: true, parse: (raw) => parseLayerCoordinate("y", raw) },
  { key: "opacity", group: "placement", appliesTo: ["image", "text", "shape"], editOption: true, parse: parseLayerOpacity },
  { key: "anchor", group: "placement", appliesTo: ["image", "text", "shape"], editOption: true, parse: parseLayerAnchor, apply: applyAnchor },
  // The resize family: five mutually exclusive forms through the ONE
  // cross-option exclusivity parse (`parseResizeOptions`) — each surface's
  // order list dispatches it as one step at the family's established check
  // position, and each form has its own ONE application case.
  { key: "resize", group: "transform", appliesTo: ["image", "text", "shape"], editOption: true, apply: applyResizeFactor },
  // --resize-to needs an intrinsic pixel size: an image's or a shape's
  // stored width/height, never a text Layer's (the shared scale resolution
  // refuses it on text, identical wording on both surfaces).
  { key: "resize-to", group: "transform", appliesTo: ["image", "shape"], editOption: true, apply: applyResizeTo },
  // Cover fit (#293, spec #285 US-007, DEC-011): a sizing option beside
  // --resize-to on image Layers — the target is covered with the aspect
  // preserved, the overflow staying outside the canvas. Like --resize-to
  // it is an input form, never a stored fact: the ONE shared scale
  // resolution publishes canonical scaleX/scaleY. The "canvas" target
  // keyword resolves at the command boundary (add: the target
  // Composition's canvas; edit: the referring Composition's canvas,
  // agreeing referrers only).
  { key: "cover-to", group: "transform", appliesTo: ["image"], editOption: true, apply: applyCoverTo },
  { key: "scale", group: "transform", appliesTo: ["image", "text", "shape"], editOption: true, apply: applyScale },
  // The absolute per-axis scale setter (#296, spec #285 US-030, DEC-005,
  // ADR-0016 amendment): the two factors ARE the canonical scaleX/scaleY,
  // shared by every kind — including text, whose per-axis scale was
  // previously unreachable (--resize-to needs an intrinsic pixel size).
  // The uniform --scale and this setter are ONE stored fact, so either
  // wholly replaces the other; --scale-to 1x1 is the removal form.
  { key: "scale-to", group: "transform", appliesTo: ["image", "text", "shape"], editOption: true, apply: applyScaleTo },
  { key: "rotate", group: "transform", appliesTo: ["image", "text", "shape"], editOption: true, dashNumeric: true, parse: parseLayerRotation, apply: applyRotation },
  { key: "flip", group: "transform", appliesTo: ["image", "text", "shape"], editOption: true, parse: parseLayerFlip, apply: applyFlip },
  // Skew and perspective (#298, spec #285 US-008, DEC-005, ADR-0016
  // amendment): absolute revision-fact setters on every kind, independent
  // of the retained content's size (like rotation) — combinable with the
  // resize family and content replacement. --skew sets the shear angles,
  // --perspective the tilts about the X/Y axes (the fixed documented
  // 1000px perspective distance is a paint constant, never a stored fact);
  // 0x0 is each fact's removal form and the identity is never stored.
  { key: "skew", group: "transform", appliesTo: ["image", "text", "shape"], editOption: true, parse: parseLayerSkew, apply: applySkew },
  { key: "perspective", group: "transform", appliesTo: ["image", "text", "shape"], editOption: true, parse: parseLayerPerspective, apply: applyPerspective },
  { key: "shadow", group: "effect", appliesTo: ["image", "text", "shape"], editOption: true, dashNumeric: true, parse: parseLayerShadow, apply: applyShadow },
  { key: "outline", group: "effect", appliesTo: ["image", "text", "shape"], editOption: true, dashNumeric: true, parse: parseLayerOutline, apply: applyOutline },
  // The inner shadow (#303, spec #285 US-011, ISC-64, ADR-0027): a
  // repeatable effect option like the shadow's — the SAME absolute-setter
  // grammar (N occurrences set the whole stack, "none" alone removes),
  // the same hex colour and bounds, validated through the same shadow
  // validators. It joins the anchor conflict rule and one-command add
  // through the table and its group, like every effect option.
  { key: "inner-shadow", group: "effect", appliesTo: ["image", "text", "shape"], editOption: true, dashNumeric: true, parse: parseLayerInnerShadow, apply: applyInnerShadow },
  // The rectangular visible region (#211, spec #207 US-003, ADR-0023): a
  // Layer revision fact about what part of the content is ink — its own
  // group between the transform and effect groups, because one-command add
  // applies it after the transforms and BEFORE anchored placement (the
  // anchor resolves against the region-clipped visible ink, DEC-005) and
  // before the effects (which hug the region's edge, DEC-004).
  { key: "visible-region", group: "region", appliesTo: ["image", "text", "shape"], editOption: true, dashNumeric: true, parse: parseLayerVisibleRegion, apply: applyVisibleRegion },
  // The visible region's corner radius (#212): the same revision fact's
  // second axis — the same region group, because the radius rounds the
  // region's corners (one-command add applies it right after the rectangle,
  // still before the anchor and the effects).
  { key: "visible-region-radius", group: "region", appliesTo: ["image", "text", "shape"], editOption: true, dashNumeric: true, parse: parseLayerVisibleRegionRadius, apply: applyVisibleRegionRadius },
  // The Layer mask (ADR-0025, spec #285 US-009, DEC-007, #305): an ABSOLUTE
  // setter over the Composition-LOCAL use name of the Layer use whose alpha
  // clips this Layer. Its own group AFTER the region group and BEFORE the
  // look/effect groups — the clip is the outermost paint step (ADR-0025 §4,
  // after the effects, before blend), and one-command add applies it after
  // the effects. The removal value is MASK_REMOVAL_VALUE (":none"), the
  // colon-keyword form that can never name a use (the one name rule
  // refuses the colon), so a removal can never be read as naming a use.
  { key: "mask", group: "mask", appliesTo: ["image", "text", "shape"], editOption: true, parse: parseLayerMask, apply: applyMask },
  // The grade controls (#219, spec #218 US-001, ADR-0024): brightness,
  // contrast, saturation, warmth. Their own group "look" applied to content
  // only.
  { key: "brightness", group: "look", appliesTo: ["image", "text", "shape"], editOption: true, parse: parseLayerBrightness, apply: applyBrightness },
  { key: "contrast", group: "look", appliesTo: ["image", "text", "shape"], editOption: true, parse: parseLayerContrast, apply: applyContrast },
  { key: "saturation", group: "look", appliesTo: ["image", "text", "shape"], editOption: true, parse: parseLayerSaturation, apply: applySaturation },
  { key: "warmth", group: "look", appliesTo: ["image", "text", "shape"], editOption: true, dashNumeric: true, parse: parseLayerWarmth, apply: applyWarmth },
  // Blend mode (#220, spec #218 US-003, ADR-0024): an absolute setter over
  // the documented set of mix-blend-mode values. Part of the "look" group,
  // applying to image, text, and shape Layers.
  { key: "blend", group: "look", appliesTo: ["image", "text", "shape"], editOption: true, parse: parseLayerBlend, apply: applyBlend },
  // Edge glow (#221, spec #218 US-002, ADR-0024): an absolute setter whose
  // compact value carries colour with alpha, width and softness in px, and
  // an optional direction pair (angle in degrees clockwise from top plus
  // strength). Part of the "look" group — the glow paints over the graded
  // content and under outline and shadow (ADR-0024's step 5) — applying to
  // image, text, and shape Layers. Removal value "none".
  { key: "glow", group: "look", appliesTo: ["image", "text", "shape"], editOption: true, parse: parseLayerGlow, apply: applyGlow },
  // The blur radius (#299, spec #285 US-010, DEC-005, ADR-0024 amendment):
  // an absolute revision-fact setter on every kind — a Gaussian defocus
  // painted as the LAST function of the outer effects filter chain (after
  // shadow), so the whole Layer look reads out of focus. The px are
  // Layer-local (the transform maps content+effects together); the blur
  // grows painted extents and never moves anchored placement (the #288
  // pre-effect-ink rule). 0 is the removal form; the identity is never
  // stored.
  { key: "blur", group: "effect", appliesTo: ["image", "text", "shape"], editOption: true, dashNumeric: true, parse: parseLayerBlur, apply: applyBlur },
  // The edge choke (#300, spec #285 US-013, DEC-005, ADR-0024 amendment):
  // an absolute revision-fact setter on every kind — an inward alpha-erode
  // painted as the FIRST function of the outer effects filter chain, before
  // the glow/outline/shadow that read the shaped edge (blur stays LAST).
  // Layer-local px; the shaped alpha is composited `in` the source graphic,
  // so the ink never exceeds the unchoked ink and the edge step adds no
  // reach. 0 is the removal form; the identity is never stored.
  { key: "choke", group: "effect", appliesTo: ["image", "text", "shape"], editOption: true, dashNumeric: true, parse: parseLayerChoke, apply: applyChoke },
  // The edge feather (#300, spec #285 US-013, DEC-005, ADR-0024 amendment):
  // an absolute revision-fact setter on every kind — a Gaussian alpha-edge
  // softening applied immediately after the choke in the SAME first filter
  // function. Layer-local px; the `in` composite bounds the painted alpha
  // by the source's, so the edge softens inward only and adds no reach.
  // 0 is the removal form; the identity is never stored.
  { key: "feather", group: "effect", appliesTo: ["image", "text", "shape"], editOption: true, dashNumeric: true, parse: parseLayerFeather, apply: applyFeather },
];

/** The one parseArgs declaration per option: `satisfies` makes a missing
 *  (or misspelled) entry a compile error whenever the table changes. */
/**
 * The Layer kinds each resize form works on, as the help texts word them.
 * One home (DEC-001, #234 review INT-1): 'composition add --help' and
 * 'layer edit --help' both interpolate these, so the two surfaces cannot
 * name different kinds for the same option.
 */
export const RESIZE_TO_HELP_KINDS = "image and shape Layers only";
export const SCALE_HELP_KINDS = "image, text, and shape Layers";
export const COVER_TO_HELP_KINDS = "image Layers only";

export const LAYER_OPTION_PARSE_ARGS = {
  image: { type: "string" },
  "from-generation": { type: "string" },
  "from-matte": { type: "string" },
  output: { type: "string" },
  text: { type: "string" },
  shape: { type: "string" },
  size: { type: "string" },
  "corner-radius": { type: "string" },
  fill: { type: "string" },
  unit: { type: "string" },
  font: { type: "string" },
  "font-file": { type: "string" },
  "font-size": { type: "string" },
  color: { type: "string" },
  weight: { type: "string" },
  width: { type: "string" },
  tracking: { type: "string" },
  "line-height": { type: "string" },
  "wrap-width": { type: "string" },
  "fit-box": { type: "string" },
  run: { type: "string", multiple: true },
  // The per-run setters are repeatable: several runs restyle in one edit
  // (`--run-color 2=... --run-weight 3=...`), so occurrences collect.
  "run-text": { type: "string", multiple: true },
  runs: { type: "string" },
  "run-color": { type: "string", multiple: true },
  "run-font": { type: "string", multiple: true },
  "run-font-file": { type: "string", multiple: true },
  "run-weight": { type: "string", multiple: true },
  "run-width": { type: "string", multiple: true },
  x: { type: "string" },
  y: { type: "string" },
  opacity: { type: "string" },
  anchor: { type: "string" },
  resize: { type: "string" },
  "resize-to": { type: "string" },
  "cover-to": { type: "string" },
  scale: { type: "string" },
  rotate: { type: "string" },
  flip: { type: "string" },
  shadow: { type: "string", multiple: true },
  outline: { type: "string", multiple: true },
  "inner-shadow": { type: "string", multiple: true },
  "vector-color": { type: "string" },
  "visible-region": { type: "string" },
  "visible-region-radius": { type: "string" },
  mask: { type: "string" },
  brightness: { type: "string" },
  contrast: { type: "string" },
  saturation: { type: "string" },
  warmth: { type: "string" },
  blend: { type: "string" },
  glow: { type: "string" },
  blur: { type: "string" },
  choke: { type: "string" },
  feather: { type: "string" },
  "scale-to": { type: "string" },
  skew: { type: "string" },
  perspective: { type: "string" },
} as const satisfies Record<LayerOptionKey, { type: "string"; multiple?: boolean }>;

/** The parsed-CLI shape of this option surface: every key is a raw string
 *  (or `undefined` when not supplied) — except the repeatable options
 *  (#297 --run; #302 --shadow/--outline), whose occurrences collect as an
 *  ordered string array. Command-specific flags are intersected per
 *  surface; see each entry point's `values` type. */
export type LayerOptionArgs = {
  [K in Exclude<LayerOptionKey, "run" | "shadow" | "outline" | "inner-shadow">]?: string;
} & { run?: string[]; shadow?: string[]; outline?: string[]; "inner-shadow"?: string[] };

/** The `--text` content marker plus the text style options: the option set
 *  the content-kind exclusivity rules treat as "the text content kind". */
export const TEXT_CONTENT_KEYS: readonly LayerOptionKey[] = [
  "text", "font", "font-file", "font-size", "color", "weight", "width", "tracking", "line-height", "wrap-width", "fit-box",
  "run", "run-text", "runs", "run-color", "run-font", "run-font-file", "run-weight", "run-width",
];

/** The runs options (#297): --run and the per-run setters. Distinct from the
 *  layer-level text style options, whose add-boundary "require --text" check
 *  must exempt them (runs author their own text content). */
export const RUN_OPTION_KEYS: readonly LayerOptionKey[] = [
  "run", "run-text", "runs", "run-color", "run-font", "run-font-file", "run-weight", "run-width",
];

/** The `--shape` content marker plus the shape's parameter options: the
 *  option set the content-kind exclusivity rules treat as "the shape content
 *  kind" (#208). Derived from the table's shape contentKind, like the text
 *  set, so a new shape option joins every refusal automatically. */
export const SHAPE_CONTENT_KEYS: readonly LayerOptionKey[] = LAYER_OPTION_DEFS
  .filter((def) => def.contentKind === "shape")
  .map((def) => def.key);

/** The keys of every option that qualifies as an `layer edit` edit option,
 *  in the table's order — the enumeration the "no edit options" refusal
 *  and any consumer (such as one-command add) state options by. */
export function layerEditOptionKeys(): LayerOptionKey[] {
  return LAYER_OPTION_DEFS.filter((def) => def.editOption).map((def) => def.key);
}

/** The Layer options one-command `composition add` accepts (#229): EVERY
 *  option the table declares — content, text style, placement, transform,
 *  region, and effect — derived from the table, never re-declared (DEC-001).
 *  A future option joins one-command add and `layer edit` with one table
 *  entry (the guard test pins the two surfaces' key sets agree), and the
 *  add path's group reader below drives its application order. Per-kind
 *  applicability is deliberately NOT enforced from `appliesTo` here: the
 *  shared domain validators refuse every current asymmetry with their
 *  established wording (see `layerOptionsApplicableTo`). On this surface
 *  `--width` IS the text width axis — the same spelling `layer edit` uses,
 *  validated through the same shared validator — and the canvas dimension
 *  meaning belongs to `composition create` alone (the decision recorded on
 *  #229). */
export const COMPOSITION_ADD_OPTION_KEYS: readonly LayerOptionKey[] =
  LAYER_OPTION_DEFS.map((def) => def.key);

/** The parseArgs entries for the add surface's accepted Layer options: a
 *  static spread of the ONE parseArgs declaration per option — never a
 *  re-declaration (DEC-001). The exhaustiveness stays a compile-time fact
 *  (review INT-plumb-3): a `LayerOptionKey` without a
 *  `LAYER_OPTION_PARSE_ARGS` entry is a compile error at that declaration's
 *  `satisfies` — never a silently unparsed add flag — and the key-set tests
 *  pin the table's keys to this declaration's, so the spread is exactly
 *  the add surface's options. */
export const COMPOSITION_ADD_OPTION_PARSE_ARGS: Record<LayerOptionKey, { type: "string"; multiple?: boolean }> = {
  ...LAYER_OPTION_PARSE_ARGS,
};

/** The post-content option keys of one-command `composition add` (#229,
 *  DEC-002, #215 paint): the table's paint, transform, region, and effect
 *  groups plus anchored placement, derived from the group fact — a new
 *  option added to one of these groups joins one-command add (and the
 *  documented application order) automatically, and the guard test
 *  (TEST-003) pins that every edit option is accepted here. */
export function oneCommandAddOptionKeys(): LayerOptionKey[] {
  return LAYER_OPTION_DEFS
    .filter(
      (def) =>
        def.group === "paint" ||
        def.group === "transform" ||
        def.group === "region" ||
        def.group === "mask" ||
        def.group === "look" ||
        def.group === "effect" ||
        def.key === "anchor",
    )
    .map((def) => def.key);
}

/** Whether any post-content one-command option is supplied in `args`. */
export function anyOneCommandOptionProvided(args: LayerOptionPresence): boolean {
  return oneCommandAddOptionKeys().some((key) => args[key] !== undefined);
}

/** The supplied one-command options in the documented application order
 *  (spec #226 DEC-002, extended by #211 and #215): the table's paint group
 *  first (the vector colour — content-level paint), then the transform
 *  group, then the visible region (whose clipped ink the anchor and the
 *  effects must both see), then anchored placement, then the look group,
 *  then the effect group
 *  — the stages derived from the group fact, in table order within a
 *  stage. Content and plain placement
 *  (--x/--y/--opacity) are applied by the ingestion itself before this
 *  order runs. One-command add's publication path consumes this order, so
 *  the documented sequence lives in the shared table, not in a second
 *  hardcoded list. */
export function oneCommandApplicationOrder(args: LayerOptionPresence): LayerOptionKey[] {
  const stage = new Map<LayerOptionKey, number>([
    ...LAYER_OPTION_DEFS.filter((def) => def.group === "paint").map((def) => [def.key, 0] as const),
    ...LAYER_OPTION_DEFS.filter((def) => def.group === "transform").map((def) => [def.key, 1] as const),
    ...LAYER_OPTION_DEFS.filter((def) => def.group === "region").map((def) => [def.key, 2] as const),
    ["anchor" as LayerOptionKey, 3],
    ...LAYER_OPTION_DEFS.filter((def) => def.group === "look").map((def) => [def.key, 4] as const),
    ...LAYER_OPTION_DEFS.filter((def) => def.group === "effect").map((def) => [def.key, 5] as const),
    ...LAYER_OPTION_DEFS.filter((def) => def.group === "mask").map((def) => [def.key, 6] as const),
  ]);
  // Fail fast (review INT-plumb-3): a supplied key with no stage would
  // otherwise sort as NaN — an unpredictable order — instead of naming
  // the missing mapping here.
  const stageOf = (key: LayerOptionKey): number => {
    const s = stage.get(key);
    if (s === undefined) {
      throw new Error(
        `One-command add: option "${key}" has no application stage — ` +
          "the option table's post-content groups (paint, transform, region, look, effect, mask, anchor) moved?",
      );
    }
    return s;
  };
  return oneCommandAddOptionKeys()
    .filter((key) => args[key] !== undefined)
    .sort((a, b) => stageOf(a) - stageOf(b));
}

/** The presence shape of the option surface: every key is either supplied
 *  or not. The table-driven readers (anyOneCommandOptionProvided,
 *  oneCommandApplicationOrder, anyLayerEditOptionProvided) only test
 *  presence, so the CLI values shape and any structured options object
 *  satisfy it. */
export type LayerOptionPresence = { [K in LayerOptionKey]?: unknown };

/** The `--<key>` spellings of `keys` that take dash-leading numeric values,
 *  for the shared dash-join at each command boundary (cli-present.ts). */
export function layerDashNumericFlags(keys: readonly LayerOptionKey[]): string[] {
  const dashNumeric = new Set(LAYER_OPTION_DEFS.filter((def) => def.dashNumeric).map((def) => def.key));
  return keys.filter((key) => dashNumeric.has(key)).map((key) => `--${key}`);
}

/** The Layer options of the option table that apply to `kind` — the
 *  table's `appliesTo` enumeration (US-001: add accepts every option
 *  `layer edit` accepts *for that Layer kind*). Read by the guard test
 *  (TEST-003) to exercise each kind's options; production kind parity is
 *  deliberately NOT enforced from this enumeration: every current
 *  `appliesTo` asymmetry is already refused with its established wording
 *  by the shared domain validators — the content-kind options by
 *  `layerContentKindConflict` at the boundary, `--resize-to` on text
 *  Layers by the shared scale resolution in the publication path
 *  (`resolveEditScale`, identical wording on both surfaces) — so a
 *  table-driven applicability refusal on the add path would only shadow
 *  those established texts as a second wording home (review INT-plumb-2;
 *  the comments, not the refusal behavior, carry this fact). */
export function layerOptionsApplicableTo(
  kind: "image" | "text" | "shape",
  keys: readonly LayerOptionKey[] = layerEditOptionKeys(),
): LayerOptionKey[] {
  const kindDefs = LAYER_OPTION_DEFS.filter((def) => def.editOption && def.appliesTo.includes(kind));
  return keys.filter((key) => kindDefs.some((def) => def.key === key));
}

/** Whether any option in `keys` is supplied in `args`. */
export function someLayerOptionProvided(args: LayerOptionArgs, keys: readonly LayerOptionKey[]): boolean {
  return keys.some((key) => args[key] !== undefined);
}

/** Whether any option that alone qualifies as an `layer edit` edit option
 *  is supplied. */
export function anyLayerEditOptionProvided(args: LayerOptionPresence): boolean {
  return LAYER_OPTION_DEFS.some((def) => def.editOption && args[def.key] !== undefined);
}

/**
 * The one content-kind exclusivity rule (DEC-001): an image content kind
 * (--image, --from-generation, --from-matte), a text content (--text), and
 * the text style options are mutually exclusive. Membership comes from the
 * option table, so an option added to the text group automatically joins
 * every content-kind refusal on every surface. Returns the surface's
 * established refusal text for the offending pair, or undefined.
 */
export function layerContentKindConflict(
  args: LayerOptionArgs,
  kind: "image" | "from-generation" | "from-matte" | "shape" | "unit",
  surface: LayerOptionSurface,
): string | undefined {
  const textSide =
    args.text !== undefined ||
    someLayerOptionProvided(args, TEXT_CONTENT_KEYS.filter((key) => key !== "text"));
  const generationSide = args["from-generation"] !== undefined;
  const matteSide = args["from-matte"] !== undefined;
  const shapeSide = someLayerOptionProvided(args, SHAPE_CONTENT_KEYS);
  // The unit Layer (ADR-0026, #307): the fifth content kind. One reference
  // per Layer, like every other content kind.
  const unitSide = args.unit !== undefined;
  switch (kind) {
    case "unit": {
      if (unitSide && (args.image !== undefined || textSide || generationSide || matteSide || shapeSide)) {
        return "--unit and --image/--from-generation/--from-matte/--text/--shape are mutually exclusive content kinds; use one per Layer.";
      }
      return undefined;
    }
    case "shape": {
      if (shapeSide && (textSide || generationSide || matteSide || args.image !== undefined || unitSide)) {
        return surface === "edit"
          ? "--shape and --image/--from-generation/--from-matte/--text/--unit options are mutually exclusive content options."
          : "--shape and --image/--from-generation/--from-matte/--text/--unit are mutually exclusive content kinds; use one per Layer.";
      }
      return undefined;
    }
    case "image": {
      // Presence, except for the add surface's established check, which
      // reads truthiness: a blank --image is not a supplied content kind
      // there, so the command falls past this refusal to the add path's
      // later refusals (missing content, or the text branch).
      const imageTrigger = surface === "edit" ? args.image !== undefined : !!args.image;
      if (imageTrigger && (textSide || shapeSide || unitSide)) {
        if (shapeSide) {
          return surface === "edit"
            ? "--image and --shape options are mutually exclusive content options."
            : "--image and --shape are mutually exclusive content kinds; use one per Layer.";
        }
        if (unitSide) {
          return "--image and --unit are mutually exclusive content kinds; use one per Layer.";
        }
        return surface === "edit"
          ? "--image and text options (--text, --font, --font-file, --font-size, --color, --weight, --width, --tracking, --line-height, --wrap-width, --fit-box, --run, --run-text, --runs, --run-color, --run-font, --run-font-file, --run-weight, --run-width) are mutually exclusive."
          : "--image and --text are mutually exclusive content kinds; use one per Layer.";
      }
      return undefined;
    }
    case "from-generation":
      if (generationSide && (args.image !== undefined || textSide || shapeSide || unitSide)) {
        return surface === "edit"
          ? "--from-generation and --image/--text/--shape/--unit options are mutually exclusive content options."
          : "--from-generation and --image/--text/--shape/--unit options are mutually exclusive content kinds; use one per Layer.";
      }
      return undefined;
    case "from-matte":
      if (matteSide && (args.image !== undefined || textSide || shapeSide || generationSide || unitSide)) {
        return surface === "edit"
          ? "--from-matte and --image/--text/--from-generation/--shape/--unit options are mutually exclusive content options."
          : "--from-matte and --image/--text/--from-generation/--shape/--unit options are mutually exclusive content kinds; use one per Layer.";
      }
      return undefined;
  }
}

export type OptionParse<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Placement coordinate (--x / --y): the ONE shape validation, ONE wording
 * on every surface (#257): blank and non-finite values are refused; the
 * refusal names the single axis.
 */
export function parseLayerCoordinate(
  key: "x" | "y",
  raw: string | undefined,
): OptionParse<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value)) {
    return {
      ok: false,
      error: `Placement coordinate (--${key}) must be a finite number.`,
    };
  }
  return { ok: true, value };
}

/** Layer opacity (--opacity): 0..1, identical wording on every surface. */
export function parseLayerOpacity(raw: string | undefined): OptionParse<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return { ok: false, error: "Opacity (--opacity) must be a finite number between 0 and 1." };
  }
  return { ok: true, value };
}

/**
 * Font size (--font-size): the ONE shape-and-range validation, ONE wording
 * on every surface (#257): a positive finite number. The ingestion paths'
 * range validator (`validateTextContent`) keeps its role for callers that
 * reach it without this boundary parse; the canonical refusal for the
 * option at both command boundaries is this one.
 */
export function parseLayerFontSize(
  raw: string | undefined,
): OptionParse<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: "Font size (--font-size) must be a positive finite number." };
  }
  return { ok: true, value };
}

/** Text weight (--weight): a finite number, identical wording everywhere. */
export function parseLayerWeight(raw: string | undefined): OptionParse<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value)) {
    return { ok: false, error: "Weight (--weight) must be a finite number." };
  }
  return { ok: true, value };
}

/** Text width (--width): a finite number, identical wording everywhere. */
export function parseLayerWidth(raw: string | undefined): OptionParse<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value)) {
    return { ok: false, error: "Width (--width) must be a finite number." };
  }
  return { ok: true, value };
}

/** Tracking (--tracking): a finite number, identical wording everywhere.
 *  Range validation is `validateTextTypographyControls`'s job. */
export function parseLayerTracking(raw: string | undefined): OptionParse<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value)) {
    return { ok: false, error: "Tracking (--tracking) must be a finite number." };
  }
  return { ok: true, value };
}

/**
 * Line height (--line-height): a finite number or the literal "normal"
 * (resolved to `null` — the clear-stored-value form), identical wording
 * everywhere. Range validation is `validateTextTypographyControls`'s job.
 */
export function parseLayerLineHeight(raw: string | undefined): OptionParse<number | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === "normal") return { ok: true, value: null };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value)) {
    return { ok: false, error: 'Line height (--line-height) must be a finite number or "normal".' };
  }
  return { ok: true, value };
}

/**
 * Wrap width (--wrap-width, #294, spec #285 US-015, DEC-001/DEC-005):
 * a finite number (layout px) or the literal "none" (resolved to `null` —
 * the documented removal form), identical wording everywhere. Range
 * validation (positive, finite) is `validateTextWrapWidth`'s job.
 */
export function parseLayerWrapWidth(raw: string | undefined): OptionParse<number | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === "none") return { ok: true, value: null };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value)) {
    return { ok: false, error: 'Wrap width (--wrap-width) must be a finite number of layout px or "none".' };
  }
  return { ok: true, value };
}

/**
 * Fit box (--fit-box, #295, spec #285 US-016, DEC-010/DEC-005): a
 * "<W>x<H>" pair of layout px or the literal "none" (resolved to `null` —
 * the documented removal form), identical wording everywhere. Range
 * validation (positive, finite, ≤ the shared per-axis cap) is
 * `resolveTextFitBoxControl`'s job.
 */
export function parseLayerFitBox(raw: string | undefined): OptionParse<{ width: number; height: number } | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === "none") return { ok: true, value: null };
  const m = raw.trim().match(/^(-?\d+(?:\.\d+)?)x(-?\d+(?:\.\d+)?)$/);
  if (!m) {
    return {
      ok: false,
      error: 'Fit box (--fit-box) must be "<W>x<H>" in layout px or "none".',
    };
  }
  return { ok: true, value: { width: Number(m[1]), height: Number(m[2]) } };
}

/** A repeatable option's raw value arrives as an array (parseArgs
 *  `multiple`) or a single string; the identity parse normalizes both to the
 *  ordered occurrence list (#297). A blank occurrence is refused at the
 *  boundary — an empty run would collapse boundaries. */
export function parseLayerRun(raw: string | string[] | undefined): OptionParse<string[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const occurrences = Array.isArray(raw) ? raw : [raw];
  if (occurrences.length === 0) return { ok: true, value: undefined };
  if (occurrences.some((o) => o.length === 0)) {
    return { ok: false, error: "--run takes the run's text (a nonempty string); a run cannot be empty." };
  }
  return { ok: true, value: occurrences };
}

/** The shared indexed-setter boundary parse (#297): "<1-based run
 *  index>=<value>", split on the FIRST "=" (a value may itself contain one).
 *  The index is a positive integer; the value passes through raw (its
 *  grammar is semantic, the same split every layer-level option uses).
 *  `valuePattern` states the expected value shape in the refusal. */
function parseRunIndexedOption(
  option: string,
  valuePattern: string,
  raw: string | string[] | undefined,
): OptionParse<Array<{ index: number; value: string }> | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const occurrences = Array.isArray(raw) ? raw : [raw];
  if (occurrences.length === 0) return { ok: true, value: undefined };
  const out: Array<{ index: number; value: string }> = [];
  for (const occurrence of occurrences) {
    const eq = occurrence.indexOf("=");
    if (eq <= 0) {
      return { ok: false, error: `${option} must be "<1-based run index>=${valuePattern}" (got ${JSON.stringify(occurrence)}).` };
    }
    const indexPart = occurrence.slice(0, eq);
    if (!/^[1-9][0-9]*$/.test(indexPart)) {
      return { ok: false, error: `${option} must be "<1-based run index>=${valuePattern}" (got run index ${JSON.stringify(indexPart)}).` };
    }
    out.push({ index: Number(indexPart), value: occurrence.slice(eq + 1) });
  }
  return { ok: true, value: out };
}

/** --run-text: "<1-based run index>=<text>" — the run's replacement text is
 *  taken verbatim; emptiness is a boundary refusal (a run cannot be empty). */
export function parseLayerRunText(raw: string | string[] | undefined): OptionParse<Array<{ index: number; text: string }> | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = parseRunIndexedOption("--run-text", "<text>", raw);
  if (!parsed.ok) return parsed;
  if (parsed.value!.some((entry) => entry.value.length === 0)) {
    return { ok: false, error: "--run-text takes the run's text (a nonempty string); a run cannot be empty." };
  }
  return { ok: true, value: parsed.value!.map((entry) => ({ index: entry.index, text: entry.value })) };
}

/** --runs: the collapse form — the literal "none" only (#297). */
export function parseLayerRuns(raw: string | undefined): OptionParse<null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === "none") return { ok: true, value: null };
  return { ok: false, error: '--runs takes "none" — the form that collapses a multi-run Layer to a single run.' };
}

/** --run-color: "<1-based run index>=<color spec>" — the spec is the ONE
 *  `--color` grammar's raw text; its grammar parses at the semantic
 *  ingestion boundary exactly like the layer-level --color. The removal
 *  form is the literal "none". */
export function parseLayerRunColor(raw: string | string[] | undefined): OptionParse<Array<{ index: number; value: string }> | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  return parseRunIndexedOption("--run-color", "<color spec>", raw);
}

/** --run-font: "<1-based run index>=<family>" (or "none" — the removal
 *  form); the family is taken verbatim, resolved semantically like --font. */
export function parseLayerRunFont(raw: string | string[] | undefined): OptionParse<Array<{ index: number; value: string }> | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  return parseRunIndexedOption("--run-font", "<family>|none", raw);
}

/** --run-font-file: "<1-based run index>=<path>" (or "none"); a blank path
 *  is a boundary refusal, the same shape rule --font-file enforces. */
export function parseLayerRunFontFile(raw: string | string[] | undefined): OptionParse<Array<{ index: number; value: string }> | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = parseRunIndexedOption("--run-font-file", "<path>|none", raw);
  if (!parsed.ok) return parsed;
  if (parsed.value!.some((entry) => entry.value !== "none" && !entry.value.trim())) {
    return { ok: false, error: "--run-font-file takes a path to a local TrueType or OpenType font file." };
  }
  return parsed;
}

/** --run-weight: "<1-based run index>=<finite number>" (or "none" — the
 *  removal form), the same shape-and-finiteness split --weight uses. */
export function parseLayerRunWeight(raw: string | string[] | undefined): OptionParse<Array<{ index: number; value: number | null }> | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = parseRunIndexedOption("--run-weight", "<finite number>|none", raw);
  if (!parsed.ok) return parsed;
  const out: Array<{ index: number; value: number | null }> = [];
  for (const entry of parsed.value!) {
    if (entry.value === "none") {
      out.push({ index: entry.index, value: null });
      continue;
    }
    const weight = parseNumericArgument(entry.value);
    if (!Number.isFinite(weight)) {
      return { ok: false, error: "Weight (--run-weight) must be a finite number." };
    }
    out.push({ index: entry.index, value: weight });
  }
  return { ok: true, value: out };
}

/** --run-width: "<1-based run index>=<finite number>" (or "none"), the same
 *  shape-and-finiteness split --width uses. */
export function parseLayerRunWidth(raw: string | string[] | undefined): OptionParse<Array<{ index: number; value: number | null }> | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = parseRunIndexedOption("--run-width", "<finite number>|none", raw);
  if (!parsed.ok) return parsed;
  const out: Array<{ index: number; value: number | null }> = [];
  for (const entry of parsed.value!) {
    if (entry.value === "none") {
      out.push({ index: entry.index, value: null });
      continue;
    }
    const width = parseNumericArgument(entry.value);
    if (!Number.isFinite(width)) {
      return { ok: false, error: "Width (--run-width) must be a finite number." };
    }
    out.push({ index: entry.index, value: width });
  }
  return { ok: true, value: out };
}

/**
 * The one range validation for tracking and line height at a command
 * boundary: the same validator the ingestion paths use, so the boundaries
 * never disagree. Returns the refusal text, or undefined when valid.
 */
export function validateTextTypographyControls(
  tracking: number | null | undefined,
  lineHeight: number | null | undefined,
): string | undefined {
  try {
    resolveTextTypographyControls({ tracking, lineHeight });
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * The one range validation for the wrap width (#294) at a command boundary:
 * the same validator the ingestion paths use, so the boundaries never
 * disagree. Returns the refusal text, or undefined when valid.
 */
export function validateTextWrapWidth(value: number | null | undefined): string | undefined {
  try {
    resolveTextWrapWidthControl(value);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * The one range validation for the fit box (#295) at a command boundary:
 * the same validator the ingestion paths use, so the boundaries never
 * disagree. Returns the refusal text, or undefined when valid.
 */
export function validateTextFitBox(value: { width: number; height: number } | null | undefined): string | undefined {
  try {
    resolveTextFitBoxControl(value);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * The one boundary validation for --font together with explicit --weight/
 * --width: resolves the bundled face — throwing the established semantic
 * refusal, which each surface's established error envelope classifies —
 * and range-checks the explicit axes. Returns the range refusal text, or
 * undefined when valid.
 */
export function validateTextFaceAxes(
  font: string,
  weight: number | undefined,
  width: number | undefined,
): string | undefined {
  const face = resolveFace(font);
  try {
    resolveTextAxes(face, { weight, width });
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/** --font-file takes a path to a local font file; blank is invalid. The
 *  path's existence and font validity are semantic (the ingestion path
 *  reads the bytes once and parses them), never boundary shape. */
export function parseLayerFontFile(raw: string | undefined): OptionParse<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!raw.trim()) {
    return { ok: false, error: "--font-file takes a path to a local TrueType or OpenType font file." };
  }
  return { ok: true, value: raw };
}

/** --shape: the geometry (#208, DEC-002) — rectangle or ellipse, identical
 *  wording everywhere. The radius's rectangle-only rule and the size/fill
 *  ranges are semantic (the ingestion validator names the parameter and its
 *  range); only the geometry's literal set is boundary shape. */
export function parseShapeGeometry(
  raw: string | undefined,
): OptionParse<"rectangle" | "ellipse" | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = raw.trim().toLowerCase();
  if (value !== "rectangle" && value !== "ellipse") {
    return { ok: false, error: `Shape (--shape) takes rectangle or ellipse (got "${raw}").` };
  }
  return { ok: true, value };
}

/** --size takes "<W>x<H>": the geometry's size in canvas px, the same
 *  grammar --resize-to established. Both axes are required (a shape with a
 *  one-axis size is not a rectangle or an ellipse). Signed values parse here
 *  and their range is enforced semantically by the ingestion validator
 *  (which names the parameter and its range), the established split the
 *  font-size option uses. */
export function parseShapeSize(raw: string | undefined): OptionParse<{ width: number; height: number } | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const m = raw.trim().match(/^(-?\d+(?:\.\d+)?)x(-?\d+(?:\.\d+)?)$/);
  if (!m) {
    return {
      ok: false,
      error:
        `--size takes "<W>x<H>" — the geometry's width and height in canvas px, e.g. "400x80" ` +
        `(got "${raw}").`,
    };
  }
  return { ok: true, value: { width: Number(m[1]), height: Number(m[2]) } };
}

/** --corner-radius: a finite number of px; range validation (rectangle-only,
 *  0..min(w,h)/2) is the ingestion validator's job. */
export function parseShapeCornerRadius(raw: string | undefined): OptionParse<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value)) {
    return { ok: false, error: `Corner radius (--corner-radius) must be a finite number of px (got "${raw}").` };
  }
  return { ok: true, value };
}

/** --fill: syntax and well-formedness through the SAME parser the ingestion
 *  path uses (DEC-003), so the boundaries never disagree. */
export function parseLayerFill(raw: string | undefined): OptionParse<LayerFillSpec | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  try {
    return { ok: true, value: parseFillSpec(raw) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * The one font-source exclusivity rule (#232): a text Layer names ONE font
 * per edit — a bundled family (--font) or a local font file (--font-file).
 * Shared by both surfaces (DEC-001). Returns the refusal text, or undefined
 * when at most one source is named.
 */
export function validateTextFontSource(
  font: string | undefined,
  fontFile: string | undefined,
): string | undefined {
  if (font !== undefined && fontFile !== undefined) {
    return "--font and --font-file name one font per edit — pass a bundled family (--font) or a local font file (--font-file), not both.";
  }
  return undefined;
}

/** --from-generation takes a Generation Job id; blank is invalid. Returns
 *  the trimmed id. */
export function parseGenerationJobId(raw: string | undefined): OptionParse<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!raw.trim()) {
    return { ok: false, error: "--from-generation takes a Generation Job id (see ply generate list)." };
  }
  return { ok: true, value: raw.trim() };
}

/** --from-matte takes a matte id; blank is invalid. Returns the trimmed id. */
export function parseMatteId(raw: string | undefined): OptionParse<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!raw.trim()) {
    return { ok: false, error: "--from-matte takes a matte id (see ply matte)." };
  }
  return { ok: true, value: raw.trim() };
}

/** --output is only meaningful together with --from-generation. */
export function parseGenerationOutputSelector(
  raw: string | undefined,
  hasFromGeneration: boolean,
): OptionParse<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!hasFromGeneration) {
    return { ok: false, error: "--output is only valid together with --from-generation <jobId>." };
  }
  return { ok: true, value: raw };
}

/** --output selects one output: a 1-based index (all digits, fewer than 12
 *  characters), a sha-256 prefix of at least 12 hex characters, or the full
 *  sha-256 identity. The two shapes cannot collide: an all-digit selector of
 *  12+ characters is a prefix, never an index, so no selector is ambiguous
 *  by construction (DEC-004). Uppercase hex is normalized to lowercase here,
 *  so a selector copied in any case resolves identically. */
export function parseGenerationOutputValue(raw: string): OptionParse<string> {
  if (!/^([1-9]\d{0,10}|[0-9a-fA-F]{12,64})$/.test(raw)) {
    return {
      ok: false,
      error: `--output takes a 1-based output index, a sha-256 prefix of at least 12 hex characters, or the full sha-256 output identity (got "${raw}")`,
    };
  }
  return { ok: true, value: raw.toLowerCase() };
}

/**
 * The one validation path for the resize/scale family (--resize,
 * --resize-to, --cover-to, --scale, --scale-to): the five forms are mutually
 * exclusive — one
 * intent per edit — then each form's shape. Scale semantics, caps, and
 * kind conflicts stay in the ingestion paths (`resolveEditScale`, whose
 * exclusivity rule this mirrors).
 */
export function parseResizeOptions(
  resize: string | undefined,
  resizeTo: string | undefined,
  scale?: string,
  coverTo?: string,
  scaleTo?: string,
): OptionParse<{ resizeFactor?: number; resizeTo?: { width?: number; height?: number }; scale?: number; coverTo?: CoverTarget; scaleTo?: { scaleX?: number; scaleY?: number } }> {
  const supplied = [resize !== undefined, resizeTo !== undefined, coverTo !== undefined, scale !== undefined, scaleTo !== undefined].filter(Boolean).length;
  if (supplied > 1) {
    // Pair-specific wording, shared with resolveEditScale's ONE exclusivity
    // rule — the boundary and the publication path refuse with the same
    // text. With three or more forms supplied the first pair names itself.
    if (resize !== undefined && resizeTo !== undefined) {
      return {
        ok: false,
        error: "--resize and --resize-to are mutually exclusive resize forms: use one per edit.",
      };
    }
    if (resize !== undefined && coverTo !== undefined) {
      return {
        ok: false,
        error: "--cover-to and --resize are mutually exclusive resize forms: use one per edit.",
      };
    }
    if (resizeTo !== undefined && coverTo !== undefined) {
      return {
        ok: false,
        error: "--cover-to and --resize-to are mutually exclusive resize forms: use one per edit.",
      };
    }
    if (coverTo !== undefined && scale !== undefined) {
      return {
        ok: false,
        error: "--cover-to and --scale are mutually exclusive: use one resize form per edit (--cover-to sets a cover-fit size, --scale sets the absolute scale).",
      };
    }
    if (resize !== undefined && scale !== undefined) {
      return {
        ok: false,
        error: "--resize and --scale are mutually exclusive: use one resize form per edit (--resize is relative, --scale sets the absolute scale).",
      };
    }
    if (scaleTo !== undefined && resize !== undefined) {
      return {
        ok: false,
        error: "--resize and --scale-to are mutually exclusive: use one resize form per edit (--resize is relative, --scale-to sets the absolute per-axis scale).",
      };
    }
    if (scaleTo !== undefined && resizeTo !== undefined) {
      return {
        ok: false,
        error: "--resize-to and --scale-to are mutually exclusive: use one resize form per edit (--resize-to sets an absolute size, --scale-to sets the absolute per-axis scale).",
      };
    }
    if (scaleTo !== undefined && coverTo !== undefined) {
      return {
        ok: false,
        error: "--cover-to and --scale-to are mutually exclusive: use one resize form per edit (--cover-to sets a cover-fit size, --scale-to sets the absolute per-axis scale).",
      };
    }
    if (scaleTo !== undefined && scale !== undefined) {
      return {
        ok: false,
        error: "--scale and --scale-to are mutually exclusive: use one resize form per edit (--scale sets a uniform absolute scale, --scale-to sets the absolute per-axis scale).",
      };
    }
    return {
      ok: false,
      error: "--resize-to and --scale are mutually exclusive: use one resize form per edit (--resize-to sets an absolute size, --scale sets the absolute scale).",
    };
  }
  let resizeFactor: number | undefined;
  if (resize !== undefined) {
    resizeFactor = parseNumericArgument(resize);
    if (!Number.isFinite(resizeFactor) || resizeFactor <= 0) {
      return {
        ok: false,
        error: `Resize factor (--resize) must be a finite number greater than 0 (got "${resize}").`,
      };
    }
  }
  let target: { width?: number; height?: number } | undefined;
  if (resizeTo !== undefined) {
    const raw = resizeTo.trim();
    const m = raw.match(/^(\d+(?:\.\d+)?)?x(\d+(?:\.\d+)?)?$/);
    if (!m || (m[1] === undefined && m[2] === undefined)) {
      return {
        ok: false,
        error:
          `--resize-to takes "<W>x<H>" (both axes: deliberate aspect change) or "<W>x" / "x<H>" ` +
          `(one axis: aspect preserved), e.g. "800x600", "800x", "x600" — got "${resizeTo}".`,
      };
    }
    target = {
      ...(m[1] !== undefined ? { width: Number(m[1]) } : {}),
      ...(m[2] !== undefined ? { height: Number(m[2]) } : {}),
    };
  }
  let cover: CoverTarget | undefined;
  if (coverTo !== undefined) {
    if (coverTo.trim() === "canvas") {
      cover = "canvas";
    } else {
      const raw = coverTo.trim();
      const m = raw.match(/^(\d+(?:\.\d+)?)?x(\d+(?:\.\d+)?)?$/);
      if (!m || (m[1] === undefined && m[2] === undefined)) {
        return {
          ok: false,
          error:
            `--cover-to takes "canvas", "<W>x<H>" (cover both axes, aspect preserved) or "<W>x" / "x<H>" ` +
            `(cover one axis), e.g. "800x600", "800x", "x600", "canvas" — got "${coverTo}".`,
        };
      }
      cover = {
        ...(m[1] !== undefined ? { width: Number(m[1]) } : {}),
        ...(m[2] !== undefined ? { height: Number(m[2]) } : {}),
      };
    }
  }
  let scaleValue: number | undefined;
  if (scale !== undefined) {
    scaleValue = parseNumericArgument(scale);
    if (!Number.isFinite(scaleValue) || scaleValue <= 0) {
      return {
        ok: false,
        error: `Scale (--scale) must be a finite number greater than 0 (got "${scale}").`,
      };
    }
  }
  let scaleToFactors: { scaleX?: number; scaleY?: number } | undefined;
  if (scaleTo !== undefined) {
    const raw = scaleTo.trim();
    const m = raw.match(/^(\d+(?:\.\d+)?)?x(\d+(?:\.\d+)?)?$/);
    if (!m || (m[1] === undefined && m[2] === undefined)) {
      return {
        ok: false,
        error:
          `--scale-to takes "<X>x<Y>" (both axes: independent absolute factors) or "<X>x" / "x<Y>" ` +
          `(one axis: the omitted axis keeps the Layer's current scale), e.g. "1.3x0.8" — got "${scaleTo}".`,
      };
    }
    scaleToFactors = {
      ...(m[1] !== undefined ? { scaleX: Number(m[1]) } : {}),
      ...(m[2] !== undefined ? { scaleY: Number(m[2]) } : {}),
    };
  }
  return { ok: true, value: { ...(resizeFactor !== undefined ? { resizeFactor } : {}), ...(target !== undefined ? { resizeTo: target } : {}), ...(cover !== undefined ? { coverTo: cover } : {}), ...(scaleValue !== undefined ? { scale: scaleValue } : {}), ...(scaleToFactors !== undefined ? { scaleTo: scaleToFactors } : {}) } };
}

/** --rotate: a finite number of degrees, clockwise positive. */
export function parseLayerRotation(raw: string | undefined): OptionParse<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value)) {
    return {
      ok: false,
      error: `Rotation (--rotate) must be a finite number of degrees, clockwise positive (got "${raw}").`,
    };
  }
  return { ok: true, value };
}

/** --flip: an absolute reflection mode. */
export function parseLayerFlip(
  raw: string | undefined,
): OptionParse<"horizontal" | "vertical" | "both" | "none" | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const mode = raw.trim().toLowerCase();
  if (mode !== "horizontal" && mode !== "vertical" && mode !== "both" && mode !== "none") {
    return { ok: false, error: `Flip (--flip) takes horizontal, vertical, both, or none (got "${raw}").` };
  }
  return { ok: true, value: mode };
}

/** The XxY angle grammar shared by --skew and --perspective (#298): both
 *  axes ("<X>x<Y>"), or one axis ("<X>x" / "x<Y>") keeping the Layer's
 *  current angle on the omitted axis — the --scale-to one-axis rule at
 *  angle semantics. Each component must parse as a finite number. */
function parseXYAngles(
  flag: string,
  raw: string | undefined,
  axes: { x: string; y: string },
): OptionParse<{ x?: number; y?: number } | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const trimmed = raw.trim();
  const match = /^([^x]*)x([^x]*)$/.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      error:
        `${flag} takes "<${axes.x}>x<${axes.y}>" (both axes: absolute angles in degrees) or ` +
        `"<${axes.x}>x" / "x<${axes.y}>" (one axis: the omitted axis keeps the Layer's current angle), ` +
        `e.g. "15x0" — got "${raw}".`,
    };
  }
  const xRaw = match[1]!.trim();
  const yRaw = match[2]!.trim();
  if (xRaw === "" && yRaw === "") {
    return {
      ok: false,
      error:
        `${flag} takes "<${axes.x}>x<${axes.y}>" (both axes: absolute angles in degrees) or ` +
        `"<${axes.x}>x" / "x<${axes.y}>" (one axis: the omitted axis keeps the Layer's current angle), ` +
        `e.g. "15x0" — got "${raw}".`,
    };
  }
  const x = xRaw === "" ? undefined : parseNumericArgument(xRaw);
  const y = yRaw === "" ? undefined : parseNumericArgument(yRaw);
  if ((xRaw !== "" && !Number.isFinite(x)) || (yRaw !== "" && !Number.isFinite(y))) {
    return {
      ok: false,
      error:
        `${flag} takes "<${axes.x}>x<${axes.y}>" (both axes: absolute angles in degrees) or ` +
        `"<${axes.x}>x" / "x<${axes.y}>" (one axis: the omitted axis keeps the Layer's current angle), ` +
        `e.g. "15x0" — got "${raw}".`,
    };
  }
  return { ok: true, value: { ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) } };
}

/** --skew: absolute shear angles in degrees, one or both axes. */
export function parseLayerSkew(raw: string | undefined): OptionParse<{ skewXDeg?: number; skewYDeg?: number } | undefined> {
  const parsed = parseXYAngles("--skew", raw, { x: "Xdeg", y: "Ydeg" });
  if (!parsed.ok || parsed.value === undefined) return parsed as OptionParse<{ skewXDeg?: number; skewYDeg?: number } | undefined>;
  return { ok: true, value: { skewXDeg: parsed.value.x, skewYDeg: parsed.value.y } };
}

/** --perspective: absolute tilts in degrees about the X and Y axes. */
export function parseLayerPerspective(
  raw: string | undefined,
): OptionParse<{ perspectiveTiltXDeg?: number; perspectiveTiltYDeg?: number } | undefined> {
  const parsed = parseXYAngles("--perspective", raw, { x: "tiltXdeg", y: "tiltYdeg" });
  if (!parsed.ok || parsed.value === undefined) {
    return parsed as OptionParse<{ perspectiveTiltXDeg?: number; perspectiveTiltYDeg?: number } | undefined>;
  }
  return { ok: true, value: { perspectiveTiltXDeg: parsed.value.x, perspectiveTiltYDeg: parsed.value.y } };
}

/**
 * --shadow: syntax and well-formedness through the SAME parser the edit
 * path uses, so the two boundaries never disagree. Repeatable (#302,
 * ADR-0027): each occurrence is one shadow spec, in command order; the
 * collected occurrence list is the stack the application case stores.
 * Returns the raw occurrences (the ingestion path re-resolves them).
 */
export function parseLayerShadow(raw: string | string[] | undefined): OptionParse<string[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const occurrences = Array.isArray(raw) ? raw : [raw];
  if (occurrences.length === 0) return { ok: true, value: undefined };
  const hasNone = occurrences.some((o) => o.trim().toLowerCase() === "none");
  if (hasNone && occurrences.length > 1) {
    return {
      ok: false,
      error: '--shadow "none" removes the whole shadow stack and cannot combine with shadow values: one edit either removes the stack or replaces it.',
    };
  }
  for (const occurrence of occurrences) {
    try {
      parseShadowSpec(occurrence);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  return { ok: true, value: occurrences };
}

/**
 * --outline: syntax and well-formedness through the SAME parser the edit
 * path uses, so the two boundaries never disagree. Repeatable (#302,
 * ADR-0027) like --shadow; the collected occurrence list is the stack the
 * application case stores. Returns the raw occurrences (the ingestion path
 * re-resolves them).
 */
export function parseLayerOutline(raw: string | string[] | undefined): OptionParse<string[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const occurrences = Array.isArray(raw) ? raw : [raw];
  if (occurrences.length === 0) return { ok: true, value: undefined };
  const hasNone = occurrences.some((o) => o.trim().toLowerCase() === "none");
  if (hasNone && occurrences.length > 1) {
    return {
      ok: false,
      error: '--outline "none" removes the whole outline stack and cannot combine with outline values: one edit either removes the stack or replaces it.',
    };
  }
  for (const occurrence of occurrences) {
    try {
      parseOutlineSpec(occurrence);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  return { ok: true, value: occurrences };
}

/**
 * --inner-shadow: syntax and well-formedness through the SAME parser the
 * edit path uses (#303, ADR-0027). Repeatable like --shadow; the collected
 * occurrence list is the stack the application case stores. Returns the
 * raw occurrences (the ingestion path re-resolves them).
 */
export function parseLayerInnerShadow(raw: string | string[] | undefined): OptionParse<string[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const occurrences = Array.isArray(raw) ? raw : [raw];
  if (occurrences.length === 0) return { ok: true, value: undefined };
  const hasNone = occurrences.some((o) => o.trim().toLowerCase() === "none");
  if (hasNone && occurrences.length > 1) {
    return {
      ok: false,
      error: '--inner-shadow "none" removes the whole inner-shadow stack and cannot combine with inner shadow values: one edit either removes the stack or replaces it.',
    };
  }
  for (const occurrence of occurrences) {
    try {
      parseInnerShadowSpec(occurrence);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  return { ok: true, value: occurrences };
}

/**
 * --visible-region: syntax and well-formedness through the SAME parser the
 * edit path uses (#211, DEC-001), so the two boundaries never disagree.
 * Returns the raw spec (the ingestion path re-resolves it against the
 * content box and live state).
 */
export function parseLayerVisibleRegion(raw: string | undefined): OptionParse<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  try {
    parseVisibleRegionSpec(raw);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true, value: raw };
}

/**
 * --visible-region-radius: syntax and well-formedness through the SAME
 * parser the edit path uses (#212, DEC-001), so the two boundaries never
 * disagree. Returns the raw spec (the ingestion path re-resolves it against
 * the region rectangle and live state; the range refusal — over half the
 * rectangle's shorter side is refused, never clamped — is semantic).
 */
export function parseLayerVisibleRegionRadius(raw: string | undefined): OptionParse<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  try {
    parseVisibleRegionRadiusSpec(raw);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true, value: raw };
}

/**
 * --vector-color (#215, spec #207 US-005, DEC-009): syntax and well-formedness
 * through the SAME parser the edit path uses — the ONE fill-colour grammar
 * (parseFillColorSpec over parseFillSpec), so the two boundaries never
 * disagree and no second colour parser exists. Returns the raw spec (the
 * ingestion path re-resolves it against live state: the kind gates and the
 * raster gate read the Layer's — or a same-edit content replacement's —
 * format).
 */
export function parseLayerVectorColor(raw: string | undefined): OptionParse<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  try {
    parseVectorColorSpec(raw);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true, value: raw };
}

/**
 * --brightness (#219, spec #218 US-001): 0..5, neutral 1.
 */
export function parseLayerBrightness(raw: string | undefined): OptionParse<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value) || value < 0 || value > 5) {
    return {
      ok: false,
      error: `Brightness (--brightness) must be a finite number between 0 and 5 (got "${raw}").`,
    };
  }
  return { ok: true, value };
}

/**
 * --contrast (#219, spec #218 US-001): 0..5, neutral 1.
 */
export function parseLayerContrast(raw: string | undefined): OptionParse<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value) || value < 0 || value > 5) {
    return {
      ok: false,
      error: `Contrast (--contrast) must be a finite number between 0 and 5 (got "${raw}").`,
    };
  }
  return { ok: true, value };
}

/**
 * --saturation (#219, spec #218 US-001): 0..5, neutral 1.
 */
export function parseLayerSaturation(raw: string | undefined): OptionParse<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value) || value < 0 || value > 5) {
    return {
      ok: false,
      error: `Saturation (--saturation) must be a finite number between 0 and 5 (got "${raw}").`,
    };
  }
  return { ok: true, value };
}

/**
 * --warmth (#219, spec #218 US-001): -1..1, neutral 0.
 */
export function parseLayerWarmth(raw: string | undefined): OptionParse<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    return {
      ok: false,
      error: `Warmth (--warmth) must be a finite number between -1 and 1 (got "${raw}").`,
    };
  }
  return { ok: true, value };
}

/**
 * --blend (#220, spec #218 US-003, ADR-0024): normal, multiply, screen, overlay,
 * soft-light, darken, lighten, color-dodge. Accepts 'color-dodge' and 'colour-dodge'
 * (stored canonically as 'color-dodge').
 */
export function parseLayerBlend(raw: string | undefined): OptionParse<LayerBlendMode | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  let value = raw.trim().toLowerCase();
  if (value === "colour-dodge") {
    value = "color-dodge";
  }
  if (!LAYER_BLEND_MODES.includes(value as LayerBlendMode)) {
    return {
      ok: false,
      error: `Blend mode (--blend) takes normal, multiply, screen, overlay, soft-light, darken, lighten, or color-dodge (got "${raw}").`,
    };
  }
  return { ok: true, value: value as LayerBlendMode };
}

/** The documented removal value of the `--mask` setter (ADR-0025, #305):
 * the colon-keyword form (the `--position before:<use>` family) that can
 * NEVER name a use — use names admit only `[a-zA-Z0-9_-]` (the one name
 * rule), so removing a mask can never be read as naming a use. */
export const MASK_REMOVAL_VALUE = ":none";

/**
 * --mask (ADR-0025, #305): syntax and well-formedness through the ONE
 * boundary parse both surfaces dispatch. The value is either the removal
 * value (`:none`) or a Composition-local use name under the one use-name
 * grammar (`USE_NAME_PATTERN`, the exported home both surfaces and the
 * stored-fact reader share — review INT-U1-4). The grammar check IS the
 * removal-spelling guard: a value that fails it can never be stored, so
 * `:none` is the only non-use-name value the setter accepts.
 */
export function parseLayerMask(raw: string | undefined): OptionParse<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = raw.trim();
  if (value === MASK_REMOVAL_VALUE) {
    return { ok: true, value: MASK_REMOVAL_VALUE };
  }
  if (!isValidUseName(value)) {
    return {
      ok: false,
      error:
        `Mask (--mask) takes a use name in the same Composition (alphanumeric, dash, or underscore) ` +
        `or "${MASK_REMOVAL_VALUE}" to remove the clip (got "${raw}").`,
    };
  }
  return { ok: true, value };
}

/**
 * --glow (#221, spec #218 US-002, ADR-0024): syntax and well-formedness
 * through the SAME parser the edit path uses, so the two boundaries never
 * disagree. Returns the raw spec (the application case re-resolves it).
 */
export function parseLayerGlow(raw: string | undefined): OptionParse<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  try {
    parseGlowSpec(raw);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true, value: raw };
}

/**
 * --blur: the absolute defocus radius in px (#299, ADR-0024 amendment).
 * The boundary parse of the ONE grammar both command surfaces run, so the
 * add and edit refusals can never disagree: a finite number of px in
 * 0..256, where 0 is the documented removal form.
 */
export function parseLayerBlur(raw: string | undefined): OptionParse<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value) || value < 0 || value > MAX_BLUR_RADIUS_PX) {
    return {
      ok: false,
      error: `Blur (--blur) takes a finite radius of px between 0 and ${MAX_BLUR_RADIUS_PX} — 0 removes the blur — got "${raw}".`,
    };
  }
  return { ok: true, value };
}

/**
 * --choke: the absolute inward alpha-erode radius in px (#300, ADR-0024
 * amendment). The boundary parse of the ONE grammar both command surfaces
 * run, so the add and edit refusals can never disagree: a finite number of
 * px in 0..256, where 0 is the documented removal form.
 */
export function parseLayerChoke(raw: string | undefined): OptionParse<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value) || value < 0 || value > MAX_EDGE_RADIUS_PX) {
    return {
      ok: false,
      error: `Choke (--choke) takes a finite radius of px between 0 and ${MAX_EDGE_RADIUS_PX} — 0 removes the choke — got "${raw}".`,
    };
  }
  return { ok: true, value };
}

/**
 * --feather: the absolute alpha-edge Gaussian softening radius in px
 * (#300, ADR-0024 amendment). The boundary parse of the ONE grammar both
 * command surfaces run, so the add and edit refusals can never disagree: a
 * finite number of px in 0..256, where 0 is the documented removal form.
 */
export function parseLayerFeather(raw: string | undefined): OptionParse<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = parseNumericArgument(raw);
  if (!Number.isFinite(value) || value < 0 || value > MAX_EDGE_RADIUS_PX) {
    return {
      ok: false,
      error: `Feather (--feather) takes a finite radius of px between 0 and ${MAX_EDGE_RADIUS_PX} — 0 removes the feather — got "${raw}".`,
    };
  }
  return { ok: true, value };
}

/**
 * --anchor: syntax and well-formedness through the SAME parser the edit
 * path uses, so the two boundaries never disagree. Semantic refusals (no
 * visible ink, divergent multi-Composition geometry) happen in the
 * read-only resolution, never here.
 */
export function parseLayerAnchor(raw: string | undefined): OptionParse<ParsedAnchor | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  try {
    return { ok: true, value: parseAnchorSpec(raw) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** The keys --anchor cannot combine with, in the table's order: every
 *  edit option except the anchor's own axes (--x, --y), --opacity, and
 *  --anchor itself. ONE derivation home (review INT-3, INT-U3-2):
 *  `isAnchorConflicting` tests presence against THIS key set and
 *  `anchorConflictOptionList` spells the same set minus the plain content
 *  kinds (which the refusal names as prose) — the two can never disagree,
 *  and a newly added option (the mask group's `--mask` included) joins
 *  both automatically. */
function anchorConflictKeys(): LayerOptionKey[] {
  const anchorFree = new Set<LayerOptionKey>(["x", "y", "opacity", "anchor"]);
  return LAYER_OPTION_DEFS
    .filter((def) => def.editOption && !anchorFree.has(def.key))
    .map((def) => def.key);
}

/** The plain content kinds the anchor refusal names as prose
 *  ("content replacement"), never as flags. */
const ANCHOR_CONFLICT_PROSE_KEYS: readonly LayerOptionKey[] = ["image", "from-generation", "from-matte", "text"];

/** The options --anchor cannot combine with: every edit option except the
 *  anchor's own axes (--x, --y) and --opacity, which combine freely — the
 *  plain content kinds included (the refusal names them as prose).
 *  Derived from the option table through `anchorConflictKeys` — the same
 *  derivation the refusal text reads — so a newly added option
 *  automatically joins the conflict rule. */
export function isAnchorConflicting(args: LayerOptionArgs): boolean {
  return anchorConflictKeys().some((key) => args[key] !== undefined);
}

/** The option-name segment of the edit surface's `--anchor` exclusivity
 *  refusal, derived from the SAME key set `isAnchorConflicting` derives
 *  from (`anchorConflictKeys`, review INT-3, INT-U3-2) minus the plain
 *  content kinds: every non-prose conflicting key appears in the refusal
 *  exactly once, grouped as the table groups them — the paint, transform,
 *  region, mask, look, and effect groups spelled as flags, and the shape
 *  content group named as the "shape parameters" family. A newly added
 *  option in one of these groups joins both the rule and the refusal text
 *  automatically; the anchor-free axes (--x, --y, --opacity) stay outside,
 *  and the plain content kinds (--image, --from-generation, --from-matte,
 *  --text) are named as "content replacement" in the refusal's prose, not
 *  as a flag list. */
export function anchorConflictOptionList(): string {
  const prose = new Set<string>(ANCHOR_CONFLICT_PROSE_KEYS);
  const conflicting = new Set(anchorConflictKeys().filter((key) => !prose.has(key)));
  const flags = (keys: readonly LayerOptionKey[]): string =>
    keys.filter((key) => conflicting.has(key)).map((key) => `--${key}`).join(", ");
  const group = (name: LayerOptionDef["group"]): string =>
    flags(LAYER_OPTION_DEFS.filter((def) => def.editOption && def.group === name).map((def) => def.key));
  const segments = [
    group("paint"),
    group("transform"),
    group("region"),
    group("mask"),
    group("look"),
    group("effect"),
  ].filter(Boolean);
  const shape = flags(SHAPE_CONTENT_KEYS);
  if (shape !== "") segments.push(`shape parameters (${shape})`);
  segments.push(group("text"));
  return segments.filter(Boolean).join(", ");
}

/** The parsed values of the option surface, keyed by the option table's own
 *  keys (DEC-001): the normalized values the shared parse produced — no
 *  per-option member exists to name. */
export type ParsedLayerOptionValues = Partial<Record<LayerOptionKey, unknown>>;

/** The resize family's keys: five mutually exclusive forms through the ONE
 *  cross-option exclusivity parse (`parseResizeOptions`), which each
 *  surface's order list dispatches as one step at the family's established
 *  check position. */
export const RESIZE_FAMILY_KEYS: readonly LayerOptionKey[] = ["resize", "resize-to", "cover-to", "scale", "scale-to"];

/** The parsed `--cover-to` target: a concrete pixel box (the --resize-to
 *  grammar) or the "canvas" keyword, resolved to the concrete Composition
 *  canvas at the command boundary — never inside the stored-state
 *  resolution, which stays Composition-free. */
export type CoverTarget = { width?: number; height?: number } | "canvas";

/**
 * The ONE boundary parse for the shared option surface (DEC-001, #263): a
 * single runner both command boundaries dispatch through, driven by the
 * surface's order list and the option table's parse registrations. Each
 * supplied option's value normalizes through its table-carried parse; the
 * resize family's five forms normalize through the shared exclusivity
 * parse as one step. Returns the parsed values keyed by the option keys, or
 * `undefined` when no listed option is supplied.
 *
 * A supplied option the steps never parsed — a table key with no
 * registration, or one missing from the surface's order list — throws
 * instead of being silently dropped (the #262 review gap, #263): the flag
 * can never be silently absent from a published revision.
 */
/**
 * The ONE single-option boundary parse dispatch (DEC-001, #263): the lookup
 * BOTH check paths run — the option table's parse registration, with the
 * loud runtime throw for a key with no registration. No check loop
 * implements its own find-and-throw; the boundaries cannot disagree on
 * which parse runs or how a missing registration fails.
 */
export function parseSharedOption(
  key: LayerOptionKey,
  values: LayerOptionArgs,
): OptionParse<unknown> {
  const def = LAYER_OPTION_DEFS.find((d) => d.key === key);
  if (def?.parse === undefined) {
    // Fail loudly, never silently (the #262 review gap): the option is
    // declared in the table but registered nowhere it can be parsed.
    throw new Error(
      `Option "--${key}" is declared in the shared option table but has no parse registration.`,
    );
  }
  return def.parse(values[key] as never);
}

/**
 * The resize family's ONE cross-option step (DEC-001): the five mutually
 * exclusive forms through the shared exclusivity parse, mapped into the
 * parsed record by the family's own keys. Both check paths run this one
 * step at the family's first check position.
 */
export function parseResizeFamilyStep(
  values: LayerOptionArgs,
): OptionParse<ParsedLayerOptionValues | undefined> {
  const resize = parseResizeOptions(values.resize, values["resize-to"], values.scale, values["cover-to"], values["scale-to"]);
  if (!resize.ok) return resize;
  if (resize.value.resizeFactor === undefined && resize.value.resizeTo === undefined && resize.value.scale === undefined && resize.value.coverTo === undefined && resize.value.scaleTo === undefined) {
    return { ok: true, value: undefined };
  }
  const mapped: ParsedLayerOptionValues = {};
  if (resize.value.resizeFactor !== undefined) mapped.resize = resize.value.resizeFactor;
  if (resize.value.resizeTo !== undefined) mapped["resize-to"] = resize.value.resizeTo;
  if (resize.value.coverTo !== undefined) mapped["cover-to"] = resize.value.coverTo;
  if (resize.value.scale !== undefined) mapped.scale = resize.value.scale;
  if (resize.value.scaleTo !== undefined) mapped["scale-to"] = resize.value.scaleTo;
  return { ok: true, value: mapped };
}

export function parseLayerOptionSteps(
  values: LayerOptionArgs,
  steps: readonly LayerOptionKey[],
  coveredKeys: readonly LayerOptionKey[],
): OptionParse<ParsedLayerOptionValues | undefined> {
  const parsed: ParsedLayerOptionValues = {};
  let supplied = false;
  let familyRan = false;
  for (const key of steps) {
    if (values[key] === undefined) continue;
    supplied = true;
    if (RESIZE_FAMILY_KEYS.includes(key)) {
      // The resize family's cross-option exclusivity rule: one parse for the
      // five forms, run once at the family's first check position.
      if (familyRan) continue;
      familyRan = true;
      const family = parseResizeFamilyStep(values);
      if (!family.ok) return family;
      if (family.value !== undefined) Object.assign(parsed, family.value);
      continue;
    }
    const result = parseSharedOption(key, values);
    if (!result.ok) return result;
    if (result.value !== undefined) parsed[key] = result.value;
  }
  // The order list must cover every key the surface accepts: a supplied key
  // the steps never reached is a registration gap — loud, never silent.
  for (const key of coveredKeys) {
    if (values[key] !== undefined && !(key in parsed)) {
      throw new Error(
        `Option "--${key}" is declared in the shared option table but is missing from this surface's check order.`,
      );
    }
  }
  return { ok: true, value: supplied ? parsed : undefined };
}

/**
 * The edit boundary's established check order (#257, DEC-001, #263) as ONE
 * order list: the option keys dispatch through the shared option table's
 * parse registrations, and the surface's cross-option policy rules hold
 * their established positions between them. The sequence is byte-identical
 * to the former per-option parse blocks' order — same validators, same
 * refusals, same exit statuses; only the per-option code is gone.
 */
export type LayerEditCheckStep =
  | { option: LayerOptionKey }
  | {
      policy:
        | "content-image"
        | "content-generation"
        | "content-matte"
        | "output-selector"
        | "text-typography"
        | "text-font-source"
        | "text-font-axes"
        | "run-text-source"
        | "anchor-conflict"
        | "anchor-targets";
    };

export const EDIT_CHECK_ORDER: readonly LayerEditCheckStep[] = [
  { policy: "content-image" },
  { option: "from-generation" },
  { policy: "content-generation" },
  { option: "from-matte" },
  { policy: "content-matte" },
  { policy: "output-selector" },
  { option: "output" },
  { option: "unit" },
  { option: "image" },
  { option: "text" },
  { option: "x" },
  { option: "y" },
  { option: "opacity" },
  { option: "font-size" },
  { option: "color" },
  { option: "font" },
  { option: "weight" },
  { option: "width" },
  { option: "tracking" },
  { option: "line-height" },
  { option: "wrap-width" },
  { option: "fit-box" },
  { option: "run-color" },
  { option: "run-font" },
  { option: "run-weight" },
  { option: "run-width" },
  { option: "run-font-file" },
  { option: "run-text" },
  { option: "runs" },
  { option: "run" },
  { policy: "run-text-source" },
  { policy: "text-typography" },
  { policy: "text-font-source" },
  { option: "font-file" },
  { policy: "text-font-axes" },
  { option: "resize" },
  { option: "resize-to" },
  { option: "cover-to" },
  { option: "scale" },
  { option: "scale-to" },
  { option: "rotate" },
  { option: "flip" },
  { option: "skew" },
  { option: "perspective" },
  { option: "shape" },
  { option: "size" },
  { option: "corner-radius" },
  { option: "fill" },
  { option: "shadow" },
  { option: "outline" },
  { option: "inner-shadow" },
  { option: "visible-region" },
  { option: "visible-region-radius" },
  { option: "mask" },
  { option: "vector-color" },
  { option: "brightness" },
  { option: "contrast" },
  { option: "saturation" },
  { option: "warmth" },
  { option: "blend" },
  { option: "glow" },
  { option: "blur" },
  { option: "choke" },
  { option: "feather" },
  { option: "anchor" },
  { policy: "anchor-conflict" },
  { policy: "anchor-targets" },
];

/** The add boundary's established check order for the post-content options
 *  (#229, DEC-001, #263): the resize family's exclusivity parse first, then
 *  the shared parse per option in the order the refusals are reached in —
 *  the same sequence the former parse entries carried, now driven from the
 *  option table's parse registrations through the ONE runner. The anchor's
 *  explicit-target rule stays the add boundary's policy after the loop. */
export const ADD_PARSE_ORDER: readonly LayerOptionKey[] = [
  "resize",
  "resize-to",
  "cover-to",
  "scale",
  "scale-to",
  "rotate",
  "flip",
  "skew",
  "perspective",
  "shadow",
  "outline",
  "inner-shadow",
  "visible-region",
  "visible-region-radius",
  "mask",
  "vector-color",
  "brightness",
  "contrast",
  "saturation",
  "warmth",
  "blend",
  "glow",
  "blur",
  "choke",
  "feather",
  "anchor",
];

/** The edit surface's `--anchor` exclusivity refusal (established wording,
 *  #257): the conflict set is derived from the shared option table
 *  (`isAnchorConflicting`), so the policy step and the refusal text come
 *  from the same derivation. */
function anchorConflictRefusal(): string {
  return (
    `--anchor is its own edit: it cannot be combined with ${anchorConflictOptionList()}, or content replacement in one edit, because the reference ink would be ambiguous. ` +
    "Make the transform, content, or effect edit first, then anchor."
  );
}

/** The edit boundary's check phase (DEC-001, #263): the established check
 *  order (#257) runs from ONE order list — every option's shape validation
 *  dispatches through the shared option table's parse registration (the
 *  same function `composition add` runs, so the two boundaries can never
 *  disagree), and the policy steps are the edit surface's cross-option
 *  rules at their established positions. Returns the parsed values keyed
 *  by the option keys, or the established refusal with its exit status —
 *  byte-identical to the former per-option parse blocks. */
export function checkEditLayerOptions(values: LayerOptionArgs): EditLayerCheck | EditLayerRefusal {
  const refuse = (error: string, exitCode: 1 | 2 = 2): EditLayerRefusal => ({ ok: false, error, exitCode });
  const parsed: ParsedLayerOptionValues = {};
  let familyRan = false;
  for (const step of EDIT_CHECK_ORDER) {
    if ("policy" in step) {
      switch (step.policy) {
        case "content-image": {
          const conflict = layerContentKindConflict(values, "image", "edit");
          if (conflict !== undefined) return refuse(conflict);
          break;
        }
        case "content-generation": {
          const conflict = layerContentKindConflict(values, "from-generation", "edit");
          if (conflict !== undefined) return refuse(conflict);
          break;
        }
        case "content-matte": {
          const conflict = layerContentKindConflict(values, "from-matte", "edit");
          if (conflict !== undefined) return refuse(conflict);
          break;
        }
        case "output-selector": {
          const selector = parseGenerationOutputSelector(values.output, values["from-generation"] !== undefined);
          if (!selector.ok) return refuse(selector.error);
          break;
        }
        case "text-typography": {
          const typographyError = validateTextTypographyControls(
            parsed.tracking as number | null | undefined,
            parsed["line-height"] as number | null | undefined,
          );
          if (typographyError !== undefined) return refuse(typographyError);
          // The wrap width's range check rides in the same typography policy
          // step (#294): the parser accepts the boundary shape (finite number
          // or "none"); the shared domain validator refuses non-positive
          // values, identical wording on both surfaces.
          const wrapWidthError = validateTextWrapWidth(
            parsed["wrap-width"] as number | null | undefined,
          );
          if (wrapWidthError !== undefined) return refuse(wrapWidthError);
          // The fit box's range check rides in the same typography policy
          // step (#295): the parser accepts the boundary shape ("<W>x<H>" or
          // "none"); the shared domain validator refuses out-of-range values,
          // identical wording on both surfaces.
          const fitBoxError = validateTextFitBox(
            parsed["fit-box"] as { width: number; height: number } | null | undefined,
          );
          if (fitBoxError !== undefined) return refuse(fitBoxError);
          break;
        }
        case "text-font-source": {
          // One font source per edit (#232): --font and --font-file are
          // mutually exclusive — a usage error (exit 2) at the boundary.
          if (values.font !== undefined || values["font-file"] !== undefined) {
            const fontSourceError = validateTextFontSource(values.font, values["font-file"]);
            if (fontSourceError !== undefined) return refuse(fontSourceError);
          }
          break;
        }
        case "text-font-axes": {
          // An unknown family keeps its established semantic refusal (exit 1,
          // resolveFace's throw), reported through the same refusal envelope
          // the add surface reports it with — identical refusal text and exit
          // status on both surfaces (#257); only weight/width range errors are
          // usage errors here (exit 2).
          if (values.font !== undefined) {
            try {
              const axesError = validateTextFaceAxes(
                values.font,
                parsed.weight as number | undefined,
                parsed.width as number | undefined,
              );
              if (axesError !== undefined) return refuse(axesError);
            } catch (err) {
              return refuse(err instanceof Error ? err.message : String(err), 1);
            }
          }
          break;
        }
        case "run-text-source": {
          // The runs forms and the whole-text form are one content (#297):
          // --run appends runs, --run-text rewrites one run's slice, --runs
          // "none" collapses, and the per-run setters style one run — never
          // beside a --text replacement, which would make the reference
          // text ambiguous (the domain refuses bare --text on a multi-run
          // Layer too; this boundary rule covers every run option).
          if (values.text !== undefined && someLayerOptionProvided(values, RUN_OPTION_KEYS)) {
            return refuse(
              "--text and the runs options (--run, --run-text, --runs, --run-color, --run-font, --run-font-file, --run-weight, --run-width) are mutually exclusive content options: --text is the single-run form; author runs with one or more --run occurrences.",
            );
          }
          break;
        }
        case "anchor-conflict": {
          // Anchored placement is its own edit: transform and content edits
          // change the reference ink, so combining them in one edit is a
          // conflicting request (the same precedent as resize + content
          // replacement). --opacity combines freely: opacity scales alpha
          // values, never the ink support. The conflict set is derived from
          // the shared option table (DEC-001), so a newly added option
          // automatically joins it.
          if (parsed.anchor !== undefined && isAnchorConflicting(values)) {
            return refuse(anchorConflictRefusal());
          }
          break;
        }
        case "anchor-targets": {
          const anchor = parsed.anchor as ParsedAnchor | undefined;
          if (anchor?.horizontal !== undefined && parsed.x === undefined) {
            return refuse(
              `--x <target> is required to anchor horizontally: the ${anchor.horizontal} ink edge/center lands at the requested x.`,
            );
          }
          if (anchor?.vertical !== undefined && parsed.y === undefined) {
            return refuse(
              `--y <target> is required to anchor vertically: the ${anchor.vertical} ink edge/center lands at the requested y.`,
            );
          }
          break;
        }
      }
      continue;
    }
    const key = step.option;
    if (values[key] === undefined) continue;
    if (RESIZE_FAMILY_KEYS.includes(key)) {
      if (familyRan) continue;
      familyRan = true;
      const family = parseResizeFamilyStep(values);
      if (!family.ok) return refuse(family.error);
      if (family.value !== undefined) Object.assign(parsed, family.value);
      continue;
    }
    const result = parseSharedOption(key, values);
    if (!result.ok) return refuse(result.error);
    if (result.value !== undefined) parsed[key] = result.value;
  }
  // Loud runtime failure (the #262 review gap, #263): a supplied option the
  // check order never parsed is declared without a registration — throw,
  // never silently absent from the edit.
  for (const def of LAYER_OPTION_DEFS) {
    if (values[def.key] !== undefined && !(def.key in parsed)) {
      throw new Error(
        `Option "--${def.key}" is declared in the shared option table but is missing from the edit check order.`,
      );
    }
  }
  return { ok: true, parsed };
}

/** The edit boundary check's outcomes: the parsed values, or the surface's
 *  established refusal with its exit status. */
export interface EditLayerCheck {
  ok: true;
  parsed: ParsedLayerOptionValues;
}

export interface EditLayerRefusal {
  ok: false;
  error: string;
  exitCode: 1 | 2;
}
/**
 * The draft revision one application case mutates (DEC-001, #263): the
 * revision the option's application publishes its fact into — the stored
 * revision (plus the resolved placement) on edit, the provisional fresh
 * revision on add. A case mutates it in place, in the surface's
 * established application order, before anything is retained or staged.
 */
export interface SharedOptionDraft {
  layerId: string;
  kind: "image" | "text" | "shape";
  x: number;
  y: number;
  opacity: number;
  scaleX: number;
  scaleY: number;
  rotationDeg: number;
  flipX: boolean;
  flipY: boolean;
  /** Canonical transform skew (#298, ADR-0016 amendment): the resolved pair
   *  when the fact is set — the identity form deletes the keys (stored only
   *  when set). */
  skewXDeg?: number;
  skewYDeg?: number;
  /** Canonical transform perspective (#298, ADR-0016 amendment): the
   *  resolved tilt pair when the fact is set — same stored-only-when-set
   *  rule as the skew pair. */
  perspectiveTiltXDeg?: number;
  perspectiveTiltYDeg?: number;
  /** The stored stack fold (#302, ADR-0027): one effect the single object,
   *  two or more the list in the same field. */
  shadow?: LayerShadow | LayerShadow[];
  outline?: LayerOutline | LayerOutline[];
  /** The stored stack fold (#303, ADR-0027): the same one-home rule as the
   *  shadow's — one effect the single object, several the list in the same
   *  field. */
  innerShadow?: LayerInnerShadow | LayerInnerShadow[];
  visibleRegion?: LayerVisibleRegion;
  vectorColor?: string;
  grade?: LayerGrade;
  blend?: StoredLayerBlendMode;
  glow?: LayerGlow;
  /** Canonical blur radius in px (#299, ADR-0024 amendment): the resolved
   *  absolute setter when the fact is set — 0 (the removal form) deletes
   *  the key, so the identity is never stored. */
  blur?: number;
  /** Canonical edge choke radius in px (#300, ADR-0024 amendment): the
   *  resolved absolute setter when the fact is set — 0 (the removal form)
   *  deletes the key, so the identity is never stored. */
  choke?: number;
  /** Canonical edge feather radius in px (#300, ADR-0024 amendment): the
   *  resolved absolute setter when the fact is set — 0 (the removal form)
   *  deletes the key, so the identity is never stored. */
  feather?: number;
  /** Anything else the application cases set — including a shared option's
   *  own revision fact (the probe's stamp) — flows into the published
   *  revision through the applied-fact carry (DEC-001). */
  [key: string]: unknown;
}
/**
 * The context one application case runs in (DEC-001, #263): WHAT the case
 * resolves against is the context's input, not the case's business. The
 * stored revision under the Project lock on edit; a provisional fresh
 * revision's facts on add. Each dispatcher supplies what its surface has;
 * the cases read only what their application needs.
 */
export interface SharedOptionApplyContext {
  /** The revision the option resolves against: the stored revision under
   *  lock on edit, the fresh content's provisional facts at scale 1 on add
   *  (`provisionalScaleContext`). Every dispatcher of the scale, rotation,
   *  flip, and region cases supplies it. */
  base?: ResolvedLayerRevision;
  /** The Layer id the draft publishes as (refusal wording) — set by the
   *  dispatcher from the draft when it builds the context. */
  layerId?: string;
  /** The verified content bytes the option's measurements paint: the fresh
   *  content's on add, the retained content's on edit. */
  contentBytes?: Buffer;
  /** Run font bytes (#297) beside the content bytes: the fresh runs' font
   *  bytes on add, the stored revision's on edit — the @font-face inputs
   *  the anchor and region measurements declare. */
  runFonts?: SnapshotRunFont[];
  /** Add surface: the target Composition's name (anchor context) and its
   *  canvas (the measurement context). */
  composition?: string;
  canvas?: { width: number; height: number };
  /** The format fact of the content the option resolves against: the fresh
   *  image content's format on add; the stored revision's on edit — absent
   *  when a same-edit content replacement defers the vector-colour raster
   *  gate to the ingested format (still before anything is stored). */
  format?: "png" | "jpeg" | "webp" | "svg";
  /** Add surface: the fresh image content's intrinsic size (the region's
   *  content box, the provisional paint markup). */
  intrinsic?: { width: number; height: number };
  /** Edit surface: the anchored placement's live-resolution inputs — the
   *  CLI boundary resolves the anchor against the live state (read-only),
   *  never under the edit's own lock. */
  live?: { projectPath: string; x?: number; y?: number; contextComposition?: string; contextUse?: string };
  /** Which surface the dispatch runs on: selects the per-surface wording
   *  where the surfaces' established refusals differ (the region radius's
   *  needs-a-region rule) and the region's measurement source. */
  surface?: LayerOptionSurface;
  /** The surface's parsed values: sibling presence for the region pair's
   *  interlocked rules (a radius in the same edit as the rectangle). */
  parsed?: ParsedLayerOptionValues;
}

/** One application case: mutates the draft in place, in the surface's
 *  established application order, before anything is retained or staged.
 *  The anchor's case returns its resolution for the command report. */
export type LayerOptionApply = (
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
) => AnchorResolution | void | Promise<AnchorResolution | void>;

/** The parsed values of the option surface, keyed by the option table's own
 *  keys (DEC-001): the normalized values the shared parse produced — no
 *  per-option member exists to name. */
export type SharedOptionValues = ParsedLayerOptionValues;

/**
 * The edit surface's runs-side style merge (#297): the parsed per-run
 * setters, merged per 1-based run index in command order (a later
 * occurrence wins, like a repeated layer-level setter). The `--color`
 * grammar's "none" removal form maps to the null colour spec; the font
 * sources' "none" maps to the null font; the axes' null carries through.
 */
export function buildRunStyleEdits(parsed: ParsedLayerOptionValues): LayerRunStyleEdit[] {
  const byIndex = new Map<number, LayerRunStyleEdit>();
  const editFor = (index: number): LayerRunStyleEdit => {
    let edit = byIndex.get(index);
    if (edit === undefined) {
      edit = { index };
      byIndex.set(index, edit);
    }
    return edit;
  };
  const runColor = parsed["run-color"] as Array<{ index: number; value: string }> | undefined;
  for (const entry of runColor ?? []) editFor(entry.index).colorSpec = entry.value === "none" ? null : entry.value;
  const runFont = parsed["run-font"] as Array<{ index: number; value: string }> | undefined;
  for (const entry of runFont ?? []) editFor(entry.index).font = entry.value === "none" ? null : entry.value;
  const runFontFile = parsed["run-font-file"] as Array<{ index: number; value: string }> | undefined;
  for (const entry of runFontFile ?? []) editFor(entry.index).fontFile = entry.value === "none" ? null : entry.value;
  const runWeight = parsed["run-weight"] as Array<{ index: number; value: number | null }> | undefined;
  for (const entry of runWeight ?? []) editFor(entry.index).weight = entry.value;
  const runWidth = parsed["run-width"] as Array<{ index: number; value: number | null }> | undefined;
  for (const entry of runWidth ?? []) editFor(entry.index).width = entry.value;
  return [...byIndex.values()];
}

/** Dispatch one option's ONE application case (DEC-001, #263): the lookup
 *  the edit surface's dispatch loop and the CLI's anchored boundary use. A
 *  post-content option with no application case fails loudly here. */
export async function applyLayerOption(
  key: LayerOptionKey,
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): Promise<unknown> {
  const def = LAYER_OPTION_DEFS.find((d) => d.key === key);
  if (def?.apply === undefined) {
    throw new Error(
      `Option "--${key}" is declared in the shared option table but has no application case.`,
    );
  }
  return def.apply(draft, value, context);
}

/**
 * The ONE application case per post-content option (DEC-001, #263), keyed
 * by the shared option table: each case below is the ONE application its
 * option has on either surface, taking the context it resolves against as
 * its input. On edit the context carries the stored revision (under the
 * Project lock) and its verified bytes; on add the provisional fresh
 * revision's facts. The bodies preserve each surface's established
 * semantics verbatim; where a wording is per-surface (the region radius's
 * needs-a-region refusals), the case selects it by context — the same
 * convention the content-kind exclusivity refusals use.
 *
 * The semantic resolutions run before any content retention or revision
 * staging, so a refused option publishes nothing.
 */
function applyVectorColor(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  const colour = parseVectorColorSpec(value as string);
  if (colour === undefined) {
    // "none" removes nothing on a fresh Layer (absence IS the no-colour
    // form) and removes the stored colour on edit — the removal form never
    // hits a kind gate, the same idempotent removal every absolute
    // setter's "none" has.
    draft.vectorColor = undefined;
    return;
  }
  // The kind/format refusals run here, before any content retention: the
  // colour is defined for vector (format svg) image content only, and the
  // refusal names each kind's own colour control. The raster gate reads
  // the format of the content the edit/add would publish: the stored
  // revision's on edit (a same-edit content replacement defers the gate to
  // the ingested format, still before anything is stored), the fresh
  // content's on add.
  if (draft.kind === "text") {
    throw new Error(vectorColorKindRefusal("text", draft.layerId));
  }
  if (draft.kind === "shape") {
    throw new Error(vectorColorKindRefusal("shape", draft.layerId));
  }
  if (context.format !== undefined && context.format !== "svg") {
    throw new Error(vectorColorKindRefusal("raster", draft.layerId, context.format));
  }
  draft.vectorColor = colour;
}

function applyResizeFactor(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  const scale = resolveEditScale({ resizeFactor: value as number }, context.base as ResolvedLayerRevision, draft.layerId);
  draft.scaleX = scale.scaleX;
  draft.scaleY = scale.scaleY;
}

function applyResizeTo(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  const scale = resolveEditScale(
    { resizeTo: value as { width?: number; height?: number } },
    context.base as ResolvedLayerRevision,
    draft.layerId,
  );
  draft.scaleX = scale.scaleX;
  draft.scaleY = scale.scaleY;
}

function applyCoverTo(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  let target = value as CoverTarget;
  if (target === "canvas") {
    // The "canvas" keyword resolves against the surface's command-boundary
    // context: add resolves against the target Composition's canvas (every
    // add dispatcher supplies it); the edit boundary resolves it before
    // the edit lifecycle runs, so a "canvas" marker never reaches this
    // case on edit.
    if (context.canvas === undefined) {
      throw new Error(
        `--cover-to canvas needs a Composition whose canvas defines the target: Layer "${draft.layerId}" has none on this surface. Pass an explicit "<W>x<H>" target.`,
      );
    }
    target = { width: context.canvas.width, height: context.canvas.height };
  }
  // The kind gate is the ONE shared cover gate (INT-3): the published
  // draft's kind — the add surface's provisional base carries an image kind
  // even for a shape/text add, so the gate must read the draft, never the
  // base — with the same wording the shared scale resolution publishes on
  // the edit surface, now from one home.
  coverKindGate(draft.kind, draft.layerId);
  const scale = resolveEditScale(
    { coverTo: target },
    context.base as ResolvedLayerRevision,
    draft.layerId,
  );
  draft.scaleX = scale.scaleX;
  draft.scaleY = scale.scaleY;
}

function applyScale(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  // Absolute scale setter (#231, DEC-005): the value IS the canonical scale
  // (ADR-0016), resolved through the edit path's ONE scale resolution — so
  // the surfaces' refusals, bounds, and idempotence are identical by
  // construction.
  const scale = resolveEditScale({ scale: value as number }, context.base as ResolvedLayerRevision, draft.layerId);
  draft.scaleX = scale.scaleX;
  draft.scaleY = scale.scaleY;
}

function applyScaleTo(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  // Absolute per-axis scale setter (#296, spec #285 US-030, DEC-005,
  // ADR-0016 amendment): the two factors ARE the canonical scale, resolved
  // through the edit path's ONE scale resolution — so the surfaces'
  // refusals, bounds, and idempotence are identical by construction. The
  // uniform --scale and this setter share the ONE stored scale fact: either
  // wholly replaces the other; 1x1 is the removal form.
  const scale = resolveEditScale(
    { scaleTo: value as { scaleX?: number; scaleY?: number } },
    context.base as ResolvedLayerRevision,
    draft.layerId,
  );
  draft.scaleX = scale.scaleX;
  draft.scaleY = scale.scaleY;
}

function applyRotation(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  draft.rotationDeg = resolveEditRotation({ rotateDeg: value as number }, context.base as ResolvedLayerRevision);
}

function applyFlip(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  const flip = resolveEditFlip(
    { flip: value as "horizontal" | "vertical" | "both" | "none" },
    context.base as ResolvedLayerRevision,
  );
  draft.flipX = flip.flipX;
  draft.flipY = flip.flipY;
}

function applySkew(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  // Absolute skew setter (#298, ADR-0016 amendment): the resolved pair IS
  // the canonical skew fact. The identity form deletes the keys — stored
  // only when set — so `--skew 0x0` is the removal form and an unskewed
  // revision keeps its exact document shape.
  const skew = resolveEditSkew({ skewTo: value as { skewXDeg?: number; skewYDeg?: number } }, context.base as ResolvedLayerRevision);
  if (skew.skewXDeg === 0 && skew.skewYDeg === 0) {
    delete draft.skewXDeg;
    delete draft.skewYDeg;
    return;
  }
  draft.skewXDeg = skew.skewXDeg;
  draft.skewYDeg = skew.skewYDeg;
}

function applyPerspective(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  // Absolute perspective setter (#298, ADR-0016 amendment): the resolved
  // tilt pair IS the canonical perspective fact — same stored-only-when-set
  // rule as the skew pair.
  const perspective = resolveEditPerspective(
    { perspectiveTo: value as { perspectiveTiltXDeg?: number; perspectiveTiltYDeg?: number } },
    context.base as ResolvedLayerRevision,
  );
  if (perspective.perspectiveTiltXDeg === 0 && perspective.perspectiveTiltYDeg === 0) {
    delete draft.perspectiveTiltXDeg;
    delete draft.perspectiveTiltYDeg;
    return;
  }
  draft.perspectiveTiltXDeg = perspective.perspectiveTiltXDeg;
  draft.perspectiveTiltYDeg = perspective.perspectiveTiltYDeg;
}

function applyShadow(draft: SharedOptionDraft, value: unknown): void {
  // Stacked shadows (#302, ADR-0027): the occurrences are the whole stack —
  // an ABSOLUTE setter that replaces any previous one. One occurrence is
  // today's single-object form (the canonical one-shadow shape); several
  // store the list in the same field; the removal value "none" (a single
  // occurrence) drops the whole stack. An omitted option preserves the
  // current revision's shadows by construction (the draft starts there).
  // The mixed "none"+values refusal is the boundary parse's (exit 2), so
  // both surfaces and the pre-staging path can never disagree.
  const parsed = (value as string[]).map((spec) => parseShadowSpec(spec));
  if (parsed.length === 0 || parsed[0] === undefined) {
    delete draft.shadow;
    return;
  }
  draft.shadow = parsed.length === 1 ? parsed[0] : (parsed as LayerShadow[]);
}

function applyOutline(draft: SharedOptionDraft, value: unknown): void {
  // Stacked outlines (#302, ADR-0027): the occurrences are the whole stack —
  // the same absolute-setter fold as the shadow's, through parseOutlineSpec.
  const parsed = (value as string[]).map((spec) => parseOutlineSpec(spec));
  if (parsed.length === 0 || parsed[0] === undefined) {
    delete draft.outline;
    return;
  }
  draft.outline = parsed.length === 1 ? parsed[0] : (parsed as LayerOutline[]);
}

function applyInnerShadow(draft: SharedOptionDraft, value: unknown): void {
  // Stacked inner shadows (#303, ADR-0027): the occurrences are the whole
  // stack — the same absolute-setter fold as the shadow's, through
  // parseInnerShadowSpec. An omitted option preserves the current
  // revision's inner shadows by construction (the draft starts there).
  const parsed = (value as string[]).map((spec) => parseInnerShadowSpec(spec));
  if (parsed.length === 0 || parsed[0] === undefined) {
    delete draft.innerShadow;
    return;
  }
  draft.innerShadow = parsed.length === 1 ? parsed[0] : (parsed as LayerInnerShadow[]);
}

function applyMask(draft: SharedOptionDraft, value: unknown): void {
  // The Layer mask (ADR-0025, #305): an ABSOLUTE setter. The parsed value is
  // the removal value or a use name (parseLayerMask); an omitted option
  // preserves the current revision's mask by construction (the draft starts
  // there). The SEMANTIC resolution — that the name resolves as a use in
  // the Composition(s) that use this Layer, that it never names this Layer
  // itself, and that it never completes a cycle — runs at each command
  // boundary before anything is published (the edit boundary's live
  // resolution, the add boundary's pre-staging check in publishLayerUse);
  // this case stores the fact alone, like every other stored-only-when-set
  // fact's application case.
  if (value === MASK_REMOVAL_VALUE) {
    delete draft.mask;
    return;
  }
  if (typeof value === "string" && isValidUseName(value)) {
    draft.mask = value;
    return;
  }
  throw new Error(
    `Mask (--mask) takes a use name in the same Composition or "${MASK_REMOVAL_VALUE}" to remove the clip ` +
      `(got ${JSON.stringify(value)}).`,
  );
}

async function applyAnchor(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): Promise<AnchorResolution | void> {
  if (context.live !== undefined) {
    // Edit: the anchored placement resolves ONCE against the live state's
    // PRE-EFFECT painted ink (read-only, outside the edit's own lock)
    // through the ONE shared resolution the add path also uses (DEC-002,
    // ADR-0017 amendment #288) — a stored shadow or outline never shifts a
    // re-anchoring edit; the caller publishes plain x/y through the
    // ordinary edit lifecycle — the edit path never sees an anchor, so no
    // alternate placement representation can exist.
    return resolveAnchoredPlacement(context.live.projectPath, draft.layerId, {
      anchor: value as ParsedAnchor,
      targetX: context.live.x,
      targetY: context.live.y,
      contextComposition: context.live.contextComposition,
      contextUse: context.live.contextUse,
    });
  }
  // Add: anchored placement (ADR-0017) resolves against the content+
  // transform ink BEFORE the effects apply (the documented order),
  // through the ONE shared pre-effect ink resolution (DEC-002, ADR-0017
  // amendment #288) whose basis strips the ink-extending effect facts, so
  // the two surfaces cannot drift — measuring the provisional revision in
  // the target Composition's canvas;
  // the resolved placement publishes as plain canonical (x, y) in the SAME
  // single revision.
  const resolved = await resolveProvisionalAnchoredPlacement(
    context.canvas!,
    {
      layerId: draft.layerId,
      revision: {
        ...draft,
        ...(context.format !== undefined
          ? { format: context.format, width: context.intrinsic!.width, height: context.intrinsic!.height }
          : {}),
      } as ResolvedLayerRevision,
      contentBytes: context.contentBytes!,
      ...(context.runFonts !== undefined && context.runFonts.length > 0 ? { runFonts: context.runFonts } : {}),
    },
    { anchor: value as ParsedAnchor, contextComposition: context.composition! },
  );
  draft.x = resolved.placement.x;
  draft.y = resolved.placement.y;
  return resolved;
}

async function applyVisibleRegion(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): Promise<void> {
  const region = parseVisibleRegionSpec(value as string);
  if (region === undefined) {
    // "none" removes nothing on a fresh Layer (absence IS the no-region
    // form) and removes the stored region on edit; the radius's interlock
    // with a same-edit removal is the radius step's own rule.
    draft.visibleRegion = undefined;
    return;
  }
  // An explicit region validates against the content box of the revision
  // it is set on: a text Layer's measured line-box extent (the unwrapped
  // one-line box, or the wrapped box at the stored width when a wrap width
  // is set (#294) — the same box the edit surface validates against),
  // otherwise the intrinsic facts — the fresh content's on add, the stored
  // revision's on edit (a content replacement cannot combine with the
  // region on edit, so the stored box is always the published one). The
  // refusal runs before any content retention or revision staging.
  if (draft.kind === "text") {
    // The edit surface validates against the STORED revision's line box
    // (its resolution runs before this edit's transforms publish); add
    // validates against the provisional revision's.
    const measured = await measureStandaloneSnapshot(
      { ...(context.surface === "edit" ? context.base : draft), x: 0, y: 0 } as ResolvedLayerRevision,
      context.contentBytes!,
      { ...(context.runFonts !== undefined && context.runFonts.length > 0 ? { runFonts: context.runFonts } : {}) },
    );
    validateVisibleRegionAgainstContent(region, measured.content, draft.layerId);
  } else {
    const box = context.intrinsic ?? {
      width: (draft as unknown as { width: number }).width,
      height: (draft as unknown as { height: number }).height,
    };
    validateVisibleRegionAgainstContent(region, box, draft.layerId);
  }
  draft.visibleRegion = { ...region };
  // An omitted radius option preserves the current radius on the edit
  // surface — re-validated against the NEW rectangle, the same refusal a
  // re-issued radius would get (0 stores nothing, the same look as
  // absent). An explicit radius is the radius step's own validation, which
  // runs right after the rectangle in region order.
  if (context.parsed?.["visible-region-radius"] === undefined) {
    const preserved = context.base?.visibleRegion?.cornerRadius;
    if (preserved !== undefined && preserved > 0) {
      validateRectangleCornerRadius(preserved, region.width, region.height);
      draft.visibleRegion = { ...region, cornerRadius: preserved };
    }
  }
}

function applyVisibleRegionRadius(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  const radius = parseVisibleRegionRadiusSpec(value as string);
  if (radius === undefined || radius === 0) {
    // The removal forms — "none" and 0 — remove the radius from the region
    // the step resolves against (the same idempotent removal the edit
    // surface gives them); a fresh Layer has nothing to remove.
    if (draft.visibleRegion !== undefined) {
      const { cornerRadius: _removed, ...rect } = draft.visibleRegion;
      draft.visibleRegion = rect;
    }
    return;
  }
  const region = draft.visibleRegion;
  if (region === undefined) {
    if (context.surface === "edit") {
      // The edit surface's established wordings: a radius together with the
      // region's removal in one edit, and a radius on a Layer without one.
      if (context.parsed?.["visible-region"] !== undefined) {
        throw new Error(
          `Invalid visible-region corner radius ${value}: Layer "${draft.layerId}" cannot set a corner radius while removing the visible region — a radius rounds a region's corners, so it needs a visible region. Remove the radius (--visible-region-radius none) or keep the region.`,
        );
      }
      throw new Error(
        `Invalid visible-region corner radius ${value}: Layer "${draft.layerId}" has no visible region to round — set one first (--visible-region "<x>,<y>,<width>,<height>"), then round its corners.`,
      );
    }
    // Add: a positive radius without a region is refused before anything is
    // retained.
    throw new Error(
      `--visible-region-radius needs a visible region: Layer "${draft.layerId}" is fresh and has none. ` +
        `Pass --visible-region "<x>,<y>,<width>,<height>" in the same add, then round its corners.`,
    );
  }
  // The range rule is the ONE shared corner-radius validator (refuse, never
  // clamp) against the region rectangle the radius rounds.
  validateRectangleCornerRadius(radius, region.width, region.height);
  draft.visibleRegion = { ...region, cornerRadius: radius };
}

function updateDraftGrade(
  draft: SharedOptionDraft,
  context: SharedOptionApplyContext,
  key: "brightness" | "contrast" | "saturation" | "warmth",
  value: number,
  neutral: number,
): void {
  if (value === neutral) {
    if (draft.grade !== undefined) {
      const updated = { ...draft.grade };
      delete updated[key];
      draft.grade = Object.keys(updated).length > 0 ? updated : undefined;
    }
    return;
  }
  draft.grade = {
    ...draft.grade,
    [key]: value,
  };
}

function applyBrightness(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  updateDraftGrade(draft, context, "brightness", value as number, 1);
}

function applyContrast(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  updateDraftGrade(draft, context, "contrast", value as number, 1);
}

function applySaturation(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  updateDraftGrade(draft, context, "saturation", value as number, 1);
}

function applyWarmth(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  updateDraftGrade(draft, context, "warmth", value as number, 0);
}

function applyBlend(
  draft: SharedOptionDraft,
  value: unknown,
  _context: SharedOptionApplyContext,
): void {
  const mode = value as LayerBlendMode;
  if (mode === "normal") {
    delete draft.blend;
  } else {
    draft.blend = mode;
  }
}

function applyGlow(
  draft: SharedOptionDraft,
  value: unknown,
  _context: SharedOptionApplyContext,
): void {
  // "none" resolves to undefined — absence IS the no-glow form, the same
  // canonical shape the edit path publishes (ADR-0024); an omitted option
  // preserves the current revision's glow by construction (the draft
  // starts there).
  draft.glow = parseGlowSpec(value as string);
}

function applyBlur(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  // Absolute blur setter (#299, ADR-0024 amendment): the resolved radius IS
  // the canonical blur fact. The removal form (0) deletes the key — stored
  // only when set — so an unblurred revision keeps its exact document shape.
  const blur = resolveEditBlur({ blurTo: value as number }, context.base as ResolvedLayerRevision);
  if (blur === undefined) {
    delete draft.blur;
    return;
  }
  draft.blur = blur;
}

function applyChoke(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  // Absolute choke setter (#300, ADR-0024 amendment): the resolved radius IS
  // the canonical choke fact. The removal form (0) deletes the key — stored
  // only when set — so an unchoked revision keeps its exact document shape.
  const choke = resolveEditChoke({ chokeTo: value as number }, context.base as ResolvedLayerRevision);
  if (choke === undefined) {
    delete draft.choke;
    return;
  }
  draft.choke = choke;
}

function applyFeather(
  draft: SharedOptionDraft,
  value: unknown,
  context: SharedOptionApplyContext,
): void {
  // Absolute feather setter (#300, ADR-0024 amendment): the resolved radius
  // IS the canonical feather fact. The removal form (0) deletes the key —
  // stored only when set — so an unfeathered revision keeps its exact
  // document shape.
  const feather = resolveEditFeather({ featherTo: value as number }, context.base as ResolvedLayerRevision);
  if (feather === undefined) {
    delete draft.feather;
    return;
  }
  draft.feather = feather;
}

/**
 * The edit surface's established application order (spec #226 DEC-002 as
 * the edit path resolves it, #263): the resize family's domain re-checks,
 * then the canonical transform, then the effects, then the region pair's
 * content-edit rule and its application, then the vector colour — the
 * resolver sequence of the former edit path, held as ONE order list the
 * edit path dispatches through. Not the add surface's stage order: each
 * surface keeps its established order (#257), including the refusal order
 * of combined refusals.
 */
export type LayerApplyStep =
  | { option: LayerOptionKey }
  | { policy: "resize-forms" | "region-content" };

export const EDIT_APPLICATION_ORDER: readonly LayerApplyStep[] = [
  { policy: "resize-forms" },
  { option: "resize" },
  { option: "resize-to" },
  { option: "cover-to" },
  { option: "scale" },
  { option: "scale-to" },
  { option: "rotate" },
  { option: "flip" },
  { option: "skew" },
  { option: "perspective" },
  { option: "shadow" },
  { option: "outline" },
  { option: "inner-shadow" },
  { policy: "region-content" },
  { option: "visible-region" },
  { option: "visible-region-radius" },
  { option: "mask" },
  { option: "vector-color" },
  { option: "brightness" },
  { option: "contrast" },
  { option: "saturation" },
  { option: "warmth" },
  { option: "blend" },
  { option: "glow" },
  { option: "blur" },
  { option: "choke" },
  { option: "feather" },
];

export type { LayerRunStyleEdit } from "./layer.js";
