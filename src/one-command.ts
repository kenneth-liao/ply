#!/usr/bin/env bun
/**
 * The ONE shared normalization and application plumbing for one-command
 * `composition add` (spec #226 DEC-001, US-001 bullet 3; finding A226-002,
 * ticket #258). The option table (`LAYER_OPTION_DEFS` in layer-options.ts)
 * declares every option once; this module carries the two registries the
 * add surface consumes wholesale, so a new option joins parse, validation,
 * and application on `composition add` by declaring itself in the shared
 * definition alone — no add-side parse block, options member, presence
 * check, name mapping, or application case (the poka-yoke DEC-001 asks
 * for: adding an option to one surface adds it to the other).
 *
 * - **Normalization** — `parseOneCommandOptionValues` runs the ONE shared
 *   parse per option (the same `parse…` functions `layer edit` runs, so the
 *   two boundaries never disagree) and returns the parsed values keyed by
 *   the option's own key — there is no per-option member to name.
 * - **Application** — `ONE_COMMAND_OPTION_APPLY` is the one application
 *   case per option (moved verbatim from the former add-side switch);
 *   the publication path dispatches through the table-derived
 *   application order (`oneCommandApplicationOrder`), and an option with
 *   no application case fails loudly, never silently dropped.
 *
 * What stays per-command: the add boundary's check sequence (the order the
 * refusals are reached in, preserved exactly by the parse entries' order),
 * the add path's placement defaults, and the help text. The edit surface's
 * wiring is untouched by this module.
 */
import {
  parseLayerRotation,
  parseLayerFlip,
  parseLayerShadow,
  parseLayerOutline,
  parseLayerVisibleRegion,
  parseLayerVisibleRegionRadius,
  parseLayerVectorColor,
  parseLayerAnchor,
  parseResizeOptions,
  anyOneCommandOptionProvided,
  type LayerOptionArgs,
  type LayerOptionKey,
  type OptionParse,
} from "./layer-options.js";
import {
  parseShadowSpec,
  parseOutlineSpec,
  parseVisibleRegionSpec,
  parseVisibleRegionRadiusSpec,
  parseVectorColorSpec,
  vectorColorKindRefusal,
  validateRectangleCornerRadius,
  validateVisibleRegionAgainstContent,
  resolveEditScale,
  resolveEditRotation,
  resolveEditFlip,
  type LayerTransformFlip,
  type LayerRevision,
  type ResolvedLayerRevision,
} from "./layer.js";
import { measureStandaloneSnapshot } from "./composition-measure.js";
import { resolveProvisionalAnchoredPlacement, type ParsedAnchor } from "./layer-anchor.js";

/**
 * The parsed post-content options of one-command `composition add`,
 * keyed by the option table's own keys (DEC-001): the normalized values
 * the shared parse produced. The semantic resolutions (scale bounds and
 * aspect rules, kind applicability, anchored-placement ink resolution,
 * effect canonicalization) run in the documented application order inside
 * the publication path — the same paths `layer edit` uses, so the two
 * surfaces' results and refusals agree by construction. The values are
 * typed loosely so a newly registered option flows through without a
 * per-option member; the parse registry guarantees each value's shape, and
 * a supplied post-content key without an application case is rejected at
 * the dispatch — a fail-closed refusal, never a silently dropped value
 * (a key outside the post-content groups is never reached by the
 * application order, exactly as the former per-option interface ignored
 * it).
 */
export type OneCommandOptionValues = Partial<Record<LayerOptionKey, unknown>>;

/**
 * The context one application case runs in: the target Composition (its
 * name for refusal wording, its canvas as the measurement context), the
 * verified content bytes (the provisional paint's input), and the fresh
 * content's format and intrinsic facts (the vector-colour raster gate,
 * the region's content box, the scale resolution, the provisional paint).
 */
export interface OneCommandApplyContext {
  /** The target Composition's name (refusal wording, anchor context). */
  composition: string;
  /** The target Composition's canvas: the measurement context. */
  canvas: { width: number; height: number };
  /** The verified content bytes (the measurement's paint input). */
  contentBytes: Buffer;
  /** The image content's format fact, for the provisional paint markup. */
  format?: "png" | "jpeg" | "webp" | "svg";
  /** The image content's intrinsic size, for the scale resolution. */
  intrinsic?: { width: number; height: number };
}

/** The freshly built revision an application case mutates, widened to the
 *  transform facts every post-content option writes. */
export type OneCommandRevision = LayerRevision & {
  scaleX: number;
  scaleY: number;
  rotationDeg: number;
  flipX: boolean;
  flipY: boolean;
};

/** One application case: mutates the provisional revision in place, in the
 *  documented application order, before anything is retained or staged. */
export type OneCommandOptionApply = (
  rev: OneCommandRevision,
  value: unknown,
  context: OneCommandApplyContext,
) => void | Promise<void>;

/**
 * The one parse entry per option: the option's key and its boundary parse
 * — the SAME shared validator `layer edit` runs, so the two boundaries
 * never disagree. The entries are in the add surface's established check
 * order (each surface keeps its established check sequence, DEC-001); the
 * resize family is NOT here — its three forms are mutually exclusive, one
 * cross-option rule (`parseResizeOptions`), parsed as one step.
 */
export interface OneCommandOptionParseEntry {
  key: LayerOptionKey;
  parse: (raw: string | undefined) => OptionParse<unknown>;
}

/**
 * The shared parse entries, in the add boundary's established check order
 * — the order the refusals are reached in today, preserved exactly. A new
 * option registers its parse here; the entries are the ONLY per-option
 * parse code the add surface needs.
 */
export const ONE_COMMAND_PARSE_ENTRIES: readonly OneCommandOptionParseEntry[] = [
  { key: "rotate", parse: parseLayerRotation },
  { key: "flip", parse: parseLayerFlip },
  { key: "shadow", parse: parseLayerShadow },
  { key: "outline", parse: parseLayerOutline },
  { key: "visible-region", parse: parseLayerVisibleRegion },
  { key: "visible-region-radius", parse: parseLayerVisibleRegionRadius },
  { key: "vector-color", parse: parseLayerVectorColor },
  { key: "anchor", parse: parseLayerAnchor },
];

/**
 * The ONE shared boundary parse for one-command `composition add`'s
 * post-content options (DEC-001): presence derives from the option table
 * (`anyOneCommandOptionProvided` — no per-option presence check exists),
 * the resize family goes through its shared exclusivity parse, and every
 * other supplied option goes through its parse entry, in the established
 * check order. Returns the normalized values keyed by the option keys, or
 * `undefined` when no post-content option is supplied — the established
 * plain-add behavior, unchanged.
 *
 * The `--anchor` explicit-target rule is part of the anchor's shared
 * validation: an anchored axis needs its explicit `--x`/`--y` target, the
 * same requirement `layer edit` states (add's placement defaults are plain
 * placement, never an implicit anchor target).
 */
export function parseOneCommandOptionValues(
  values: LayerOptionArgs,
): OptionParse<OneCommandOptionValues | undefined> {
  if (!anyOneCommandOptionProvided(values)) {
    return { ok: true, value: undefined };
  }
  const parsed: OneCommandOptionValues = {};
  // The resize family's cross-option exclusivity rule runs first, as the
  // boundary's established sequence has it: one intent per add.
  const resize = parseResizeOptions(values.resize, values["resize-to"], values.scale);
  if (!resize.ok) return resize;
  if (resize.value.resizeFactor !== undefined) parsed.resize = resize.value.resizeFactor;
  if (resize.value.resizeTo !== undefined) parsed["resize-to"] = resize.value.resizeTo;
  if (resize.value.scale !== undefined) parsed.scale = resize.value.scale;
  for (const entry of ONE_COMMAND_PARSE_ENTRIES) {
    const result = entry.parse(values[entry.key]);
    if (!result.ok) return result;
    if (result.value !== undefined) parsed[entry.key] = result.value;
  }
  const anchor = parsed.anchor as ParsedAnchor | undefined;
  if (anchor !== undefined) {
    if (anchor.horizontal !== undefined && values.x === undefined) {
      return {
        ok: false,
        error: `--x <target> is required to anchor horizontally: the ${anchor.horizontal} ink edge/center lands at the requested x.`,
      };
    }
    if (anchor.vertical !== undefined && values.y === undefined) {
      return {
        ok: false,
        error: `--y <target> is required to anchor vertically: the ${anchor.vertical} ink edge/center lands at the requested y.`,
      };
    }
  }
  return { ok: true, value: parsed };
}

/**
 * The scale resolution's provisional context (DEC-001): the fresh content's
 * intrinsic facts at scale 1 — the same rules, caps, and refusal texts the
 * edit surface's resize path produces. Text Layers have no intrinsic facts;
 * their pseudo-previous state carries the text kind (the --resize-to
 * refusal names the would-be Layer id from it).
 */
function provisionalScaleContext(context: OneCommandApplyContext): ResolvedLayerRevision {
  return context.intrinsic
    ? ({
        kind: "image",
        width: context.intrinsic.width,
        height: context.intrinsic.height,
        scaleX: 1,
        scaleY: 1,
        rotationDeg: 0,
        flipX: false,
        flipY: false,
      } as unknown as ResolvedLayerRevision)
    : ({ kind: "text", scaleX: 1, scaleY: 1, rotationDeg: 0, flipX: false, flipY: false } as unknown as ResolvedLayerRevision);
}

/**
 * The ONE application case per post-content option (DEC-001) — the bodies
 * moved verbatim from the former add-side switch in the publication path,
 * so each option's application is part of its shared definition. The
 * semantic resolutions run here, before any content retention or revision
 * staging, so a refused option publishes nothing: no Layer, no use, no
 * content. The dispatch order comes from the table's group fact
 * (`oneCommandApplicationOrder`), never from this record.
 */
export const ONE_COMMAND_OPTION_APPLY: Partial<Record<LayerOptionKey, OneCommandOptionApply>> = {
  "vector-color": (rev, value, context) => {
    // The vector colour (#215, spec #207 US-005, DEC-008): the FIRST
    // stage — content-level paint, before the transforms, the region,
    // and the effects (ADR-0023's order). "none" removes nothing on a
    // fresh Layer (absence IS the no-colour form). The kind/format
    // refusals run here, before any content retention: the colour is
    // defined for vector (format svg) image content only, and the
    // refusal names each kind's own colour control.
    const colour = parseVectorColorSpec(value as string);
    if (colour !== undefined) {
      if (rev.kind === "text") {
        throw new Error(vectorColorKindRefusal("text", rev.layerId));
      }
      if (rev.kind === "shape") {
        throw new Error(vectorColorKindRefusal("shape", rev.layerId));
      }
      if (context.format !== "svg") {
        throw new Error(vectorColorKindRefusal("raster", rev.layerId, context.format));
      }
      rev.vectorColor = colour;
    }
  },
  resize: (rev, value, context) => {
    const scale = resolveEditScale({ resizeFactor: value as number }, provisionalScaleContext(context), rev.layerId);
    rev.scaleX = scale.scaleX;
    rev.scaleY = scale.scaleY;
  },
  "resize-to": (rev, value, context) => {
    const scale = resolveEditScale({ resizeTo: value as { width?: number; height?: number } }, provisionalScaleContext(context), rev.layerId);
    rev.scaleX = scale.scaleX;
    rev.scaleY = scale.scaleY;
  },
  scale: (rev, value, context) => {
    // Absolute scale setter (#231, DEC-005): the value IS the canonical
    // scale (ADR-0016), resolved through the edit path's ONE scale
    // resolution — so the add surface's refusals, bounds, and idempotence
    // are byte-identical to the edit surface's by construction.
    const scale = resolveEditScale({ scale: value as number }, provisionalScaleContext(context), rev.layerId);
    rev.scaleX = scale.scaleX;
    rev.scaleY = scale.scaleY;
  },
  rotate: (rev, value, context) => {
    rev.rotationDeg = resolveEditRotation({ rotateDeg: value as number }, provisionalScaleContext(context));
  },
  flip: (rev, value, context) => {
    const flip: LayerTransformFlip = resolveEditFlip({ flip: value as "horizontal" | "vertical" | "both" | "none" }, provisionalScaleContext(context));
    rev.flipX = flip.flipX;
    rev.flipY = flip.flipY;
  },
  anchor: async (rev, value, context) => {
    // Anchored placement (ADR-0017) resolves against the content+
    // transform ink BEFORE the effects apply (the documented order),
    // measuring the provisional revision in the target Composition's
    // canvas; the resolved placement publishes as plain canonical
    // (x, y) in the SAME single revision.
    const resolved = await resolveProvisionalAnchoredPlacement(
      context.canvas,
      {
        layerId: rev.layerId,
        revision: {
          ...rev,
          ...(context.format !== undefined
            ? { format: context.format, width: context.intrinsic!.width, height: context.intrinsic!.height }
            : {}),
        } as ResolvedLayerRevision,
        contentBytes: context.contentBytes,
      },
      { anchor: value as ParsedAnchor, contextComposition: context.composition },
    );
    rev.x = resolved.placement.x;
    rev.y = resolved.placement.y;
  },
  shadow: (rev, value) => {
    // "none" resolves to undefined — absence IS the no-shadow form,
    // the same canonical shape the edit path publishes (ADR-0018).
    const shadow = parseShadowSpec(value as string);
    if (shadow !== undefined) rev.shadow = shadow;
  },
  outline: (rev, value) => {
    const outline = parseOutlineSpec(value as string);
    if (outline !== undefined) rev.outline = outline;
  },
  "visible-region": async (rev, value, context) => {
    // The visible region (#211, ADR-0023): "none" removes nothing on a
    // fresh Layer (absence IS the no-region form) — an explicit region
    // validates against the FRESH content's box before anything is
    // retained: the image's intrinsic facts, the shape's geometry, or
    // the text's measured line-box extent (the unwrapped standalone
    // line, the same box the edit surface validates against). The refusal
    // runs before any content retention or revision staging.
    const region = parseVisibleRegionSpec(value as string);
    if (region !== undefined) {
      if (rev.kind === "text") {
        // A text Layer's content box is its measured line-box extent —
        // the SAME convention `layer edit` validates against (the
        // unwrapped standalone line, DEC-006's one authority), measured
        // from the in-memory provisional snapshot; no lock is held on
        // this path (nothing is retained yet).
        const measured = await measureStandaloneSnapshot(
          { ...rev, x: 0, y: 0 } as ResolvedLayerRevision,
          context.contentBytes,
        );
        validateVisibleRegionAgainstContent(region, measured.content, rev.layerId);
      } else if (rev.kind === "shape") {
        validateVisibleRegionAgainstContent(region, { width: rev.width, height: rev.height }, rev.layerId);
      } else {
        // An image Layer: the fresh content's intrinsic facts (always
        // supplied on this path — the add boundary resolves them before
        // any option application).
        validateVisibleRegionAgainstContent(
          region,
          { width: context.intrinsic!.width, height: context.intrinsic!.height },
          rev.layerId,
        );
      }
      rev.visibleRegion = region;
    }
  },
  "visible-region-radius": (rev, value) => {
    // The region's corner radius (#212): the rectangle's stage ran first
    // (the table's region order), so the rect is whatever this add has.
    // A positive radius without a region is refused before anything is
    // retained; `none` and 0 — the removal forms — remove nothing, the
    // same idempotent no-op the edit surface gives them. The range rule
    // is the ONE shared corner-radius validator (refuse, never clamp)
    // against the region rectangle; a radius of 0 stores nothing (the
    // same look as absent).
    const radius = parseVisibleRegionRadiusSpec(value as string);
    if (radius !== undefined && radius > 0) {
      const region = rev.visibleRegion;
      if (region === undefined) {
        throw new Error(
          `--visible-region-radius needs a visible region: Layer "${rev.layerId}" is fresh and has none. ` +
            `Pass --visible-region "<x>,<y>,<width>,<height>" in the same add, then round its corners.`,
        );
      }
      validateRectangleCornerRadius(radius, region.width, region.height);
      rev.visibleRegion = { ...region, cornerRadius: radius };
    }
  },
};