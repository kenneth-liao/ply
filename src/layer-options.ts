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
 * What deliberately stays per-command: check *sequencing* (each surface
 * keeps its established check order), command-level policy (edit intents
 * like --fork/--in-place, add's defaults and required-content rules), and
 * the help text (each surface's manual describes its own contract). Adding
 * an option means adding it here — to the table, the parseArgs entries,
 * and one validator — and both surfaces inherit it.
 *
 * One-command `composition add` (#229, DEC-002; #258, A226-002) consumes
 * this table directly: its accepted keys are the table's keys, its ONE
 * boundary parse and ONE application case per option are the shared
 * registries of `one-command.ts` (`parseOneCommandOptionValues`,
 * `ONE_COMMAND_OPTION_APPLY`), and its post-content application order
 * (transforms, then anchored placement, then effects) is derived from the
 * table's group fact — no add-side parse block, options member, presence
 * check, name mapping, or application case names an option. Per-kind
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
import { parseAnchorSpec, type ParsedAnchor } from "./layer-anchor.js";
import { parseShadowSpec, parseOutlineSpec, parseVisibleRegionSpec, parseVisibleRegionRadiusSpec, parseVectorColorSpec, resolveTextTypographyControls } from "./layer.js";
import { resolveFace, resolveTextAxes } from "./fonts.js";
import { parseFillSpec, type LayerFill as LayerFillSpec } from "./fill.js";

/** Blank supplied values are invalid, never implicit zero (#128). */
export function parseNumericArgument(value: string | undefined): number {
  return value?.trim() ? Number(value) : NaN;
}

/** The command surfaces that share this option surface. */
export type LayerOptionSurface = "edit" | "add";

/** The Layer kinds an option can apply to. */
export type LayerOptionKind = "image" | "text" | "shape";

export type LayerOptionGroup = "content" | "paint" | "text" | "placement" | "transform" | "region" | "effect";

export interface LayerOptionDef {
  /** parseArgs key: the flag is `--<key>`. */
  key: LayerOptionKey;
  group: LayerOptionGroup;
  /** For content options: which content kind the option belongs to. */
  contentKind?: "image" | "text" | "shape";
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
  | "shape"
  | "size"
  | "corner-radius"
  | "fill"
  | "x"
  | "y"
  | "opacity"
  | "anchor"
  | "resize"
  | "resize-to"
  | "scale"
  | "rotate"
  | "flip"
  | "shadow"
  | "outline"
  | "vector-color"
  | "visible-region"
  | "visible-region-radius";

/**
 * The one option table (DEC-001), in the order the edit surface's
 * enumeration and refusals state the options. Every `layer edit` option
 * and every `composition add` Layer option is declared exactly once here.
 */
export const LAYER_OPTION_DEFS: readonly LayerOptionDef[] = [
  // Content options: what the Layer is made of. Mutually exclusive kinds.
  { key: "image", group: "content", contentKind: "image", appliesTo: ["image"], editOption: true },
  { key: "from-generation", group: "content", contentKind: "image", appliesTo: ["image"], editOption: true },
  { key: "from-matte", group: "content", contentKind: "image", appliesTo: ["image"], editOption: true },
  { key: "output", group: "content", contentKind: "image", appliesTo: ["image"], editOption: false },
  { key: "text", group: "content", contentKind: "text", appliesTo: ["text"], editOption: true },
  // Shape content options (#208): only meaningful with a shape content kind.
  { key: "shape", group: "content", contentKind: "shape", appliesTo: ["shape"], editOption: true },
  { key: "size", group: "content", contentKind: "shape", appliesTo: ["shape"], editOption: true, dashNumeric: true },
  { key: "corner-radius", group: "content", contentKind: "shape", appliesTo: ["shape"], editOption: true, dashNumeric: true },
  { key: "fill", group: "content", contentKind: "shape", appliesTo: ["shape"], editOption: true },
  // The vector colour (#215, spec #207 US-005, DEC-008/009): ONE paint-time
  // colour over a vector image Layer's alpha. Its own group BEFORE the
  // transform group — the colour is content-level paint (it replaces the
  // content's colours; ADR-0023's order paints it with the content, before
  // the region, outline, and shadow) — so one-command add applies it right
  // after the content, before everything post-content. Defined for vector
  // (format svg) image Layers only: the kind/format refusals live with the
  // domain paths (the raster gate reads the would-be content's format, which
  // only ingestion knows).
  { key: "vector-color", group: "paint", appliesTo: ["image"], editOption: true },
  // Text style options: only meaningful with a text content kind.
  { key: "font", group: "text", appliesTo: ["text"], editOption: true },
  { key: "font-file", group: "text", appliesTo: ["text"], editOption: true },
  { key: "font-size", group: "text", appliesTo: ["text"], editOption: true },
  { key: "color", group: "text", appliesTo: ["text"], editOption: true },
  { key: "weight", group: "text", appliesTo: ["text"], editOption: true },
  { key: "width", group: "text", appliesTo: ["text"], editOption: true },
  { key: "tracking", group: "text", appliesTo: ["text"], editOption: true, dashNumeric: true },
  { key: "line-height", group: "text", appliesTo: ["text"], editOption: true, dashNumeric: true },
  // Placement, transform, and effect options.
  { key: "x", group: "placement", appliesTo: ["image", "text"], editOption: true, dashNumeric: true },
  { key: "y", group: "placement", appliesTo: ["image", "text"], editOption: true, dashNumeric: true },
  { key: "opacity", group: "placement", appliesTo: ["image", "text"], editOption: true },
  { key: "anchor", group: "placement", appliesTo: ["image", "text"], editOption: true },
  { key: "resize", group: "transform", appliesTo: ["image", "text"], editOption: true },
  { key: "resize-to", group: "transform", appliesTo: ["image"], editOption: true },
  { key: "scale", group: "transform", appliesTo: ["image", "text"], editOption: true },
  { key: "rotate", group: "transform", appliesTo: ["image", "text"], editOption: true, dashNumeric: true },
  { key: "flip", group: "transform", appliesTo: ["image", "text"], editOption: true },
  { key: "shadow", group: "effect", appliesTo: ["image", "text"], editOption: true, dashNumeric: true },
  { key: "outline", group: "effect", appliesTo: ["image", "text"], editOption: true, dashNumeric: true },
  // The rectangular visible region (#211, spec #207 US-003, ADR-0023): a
  // Layer revision fact about what part of the content is ink — its own
  // group between the transform and effect groups, because one-command add
  // applies it after the transforms and BEFORE anchored placement (the
  // anchor resolves against the region-clipped visible ink, DEC-005) and
  // before the effects (which hug the region's edge, DEC-004).
  { key: "visible-region", group: "region", appliesTo: ["image", "text", "shape"], editOption: true, dashNumeric: true },
  // The visible region's corner radius (#212): the same revision fact's
  // second axis — the same region group, because the radius rounds the
  // region's corners (one-command add applies it right after the rectangle,
  // still before the anchor and the effects).
  { key: "visible-region-radius", group: "region", appliesTo: ["image", "text", "shape"], editOption: true, dashNumeric: true },
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
  font: { type: "string" },
  "font-file": { type: "string" },
  "font-size": { type: "string" },
  color: { type: "string" },
  weight: { type: "string" },
  width: { type: "string" },
  tracking: { type: "string" },
  "line-height": { type: "string" },
  x: { type: "string" },
  y: { type: "string" },
  opacity: { type: "string" },
  anchor: { type: "string" },
  resize: { type: "string" },
  "resize-to": { type: "string" },
  scale: { type: "string" },
  rotate: { type: "string" },
  flip: { type: "string" },
  shadow: { type: "string" },
  outline: { type: "string" },
  "vector-color": { type: "string" },
  "visible-region": { type: "string" },
  "visible-region-radius": { type: "string" },
} as const satisfies Record<LayerOptionKey, { type: "string" }>;

/** The parsed-CLI shape of this option surface: every key is a raw string
 *  (or `undefined` when not supplied). Command-specific flags are
 *  intersected per surface; see each entry point's `values` type. */
export type LayerOptionArgs = { [K in LayerOptionKey]?: string };

/** The `--text` content marker plus the text style options: the option set
 *  the content-kind exclusivity rules treat as "the text content kind". */
export const TEXT_CONTENT_KEYS: readonly LayerOptionKey[] = [
  "text", "font", "font-file", "font-size", "color", "weight", "width", "tracking", "line-height",
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
export const COMPOSITION_ADD_OPTION_PARSE_ARGS: Record<LayerOptionKey, { type: "string" }> = {
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
 *  effects must both see), then anchored placement, then the effect group
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
    ...LAYER_OPTION_DEFS.filter((def) => def.group === "effect").map((def) => [def.key, 4] as const),
  ]);
  // Fail fast (review INT-plumb-3): a supplied key with no stage would
  // otherwise sort as NaN — an unpredictable order — instead of naming
  // the missing mapping here.
  const stageOf = (key: LayerOptionKey): number => {
    const s = stage.get(key);
    if (s === undefined) {
      throw new Error(
        `One-command add: option "${key}" has no application stage — ` +
          "the option table's post-content groups (paint, transform, region, effect, anchor) moved?",
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
  kind: "image" | "from-generation" | "from-matte" | "shape",
  surface: LayerOptionSurface,
): string | undefined {
  const textSide =
    args.text !== undefined ||
    someLayerOptionProvided(args, TEXT_CONTENT_KEYS.filter((key) => key !== "text"));
  const generationSide = args["from-generation"] !== undefined;
  const matteSide = args["from-matte"] !== undefined;
  const shapeSide = someLayerOptionProvided(args, SHAPE_CONTENT_KEYS);
  switch (kind) {
    case "shape": {
      if (shapeSide && (textSide || generationSide || matteSide || args.image !== undefined)) {
        return surface === "edit"
          ? "--shape and --image/--from-generation/--from-matte/--text options are mutually exclusive content options."
          : "--shape and --image/--from-generation/--from-matte/--text are mutually exclusive content kinds; use one per Layer.";
      }
      return undefined;
    }
    case "image": {
      // Presence, except for the add surface's established check, which
      // reads truthiness: a blank --image is not a supplied content kind
      // there, so the command falls past this refusal to the add path's
      // later refusals (missing content, or the text branch).
      const imageTrigger = surface === "edit" ? args.image !== undefined : !!args.image;
      if (imageTrigger && (textSide || shapeSide)) {
        if (shapeSide) {
          return surface === "edit"
            ? "--image and --shape options are mutually exclusive content options."
            : "--image and --shape are mutually exclusive content kinds; use one per Layer.";
        }
        return surface === "edit"
          ? "--image and text options (--text, --font, --font-file, --font-size, --color, --weight, --width, --tracking, --line-height) are mutually exclusive."
          : "--image and --text are mutually exclusive content kinds; use one per Layer.";
      }
      return undefined;
    }
    case "from-generation":
      if (generationSide && (args.image !== undefined || textSide || shapeSide)) {
        return surface === "edit"
          ? "--from-generation and --image/--text/--shape options are mutually exclusive content options."
          : "--from-generation and --image/--text/--shape options are mutually exclusive content kinds; use one per Layer.";
      }
      return undefined;
    case "from-matte":
      if (matteSide && (args.image !== undefined || textSide || shapeSide || generationSide)) {
        return surface === "edit"
          ? "--from-matte and --image/--text/--from-generation/--shape options are mutually exclusive content options."
          : "--from-matte and --image/--text/--from-generation/--shape options are mutually exclusive content kinds; use one per Layer.";
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

/** --output selects one output: a 1-based index or the full sha-256
 *  content identity. */
export function parseGenerationOutputValue(raw: string): OptionParse<string> {
  if (!/^([1-9]\d*|[0-9a-f]{64})$/.test(raw)) {
    return {
      ok: false,
      error: `--output takes a 1-based output index or the full sha-256 output identity (got "${raw}")`,
    };
  }
  return { ok: true, value: raw };
}

/**
 * The one validation path for the resize/scale family (--resize,
 * --resize-to, --scale): the three forms are mutually exclusive — one
 * intent per edit — then each form's shape. Scale semantics, caps, and
 * kind conflicts stay in the ingestion paths (`resolveEditScale`, whose
 * exclusivity rule this mirrors).
 */
export function parseResizeOptions(
  resize: string | undefined,
  resizeTo: string | undefined,
  scale?: string,
): OptionParse<{ resizeFactor?: number; resizeTo?: { width?: number; height?: number }; scale?: number }> {
  const supplied = [resize !== undefined, resizeTo !== undefined, scale !== undefined].filter(Boolean).length;
  if (supplied > 1) {
    // Pair-specific wording, shared with resolveEditScale's ONE exclusivity
    // rule — the boundary and the publication path refuse with the same
    // text. With all three forms supplied the first pair names itself.
    if (resize !== undefined && resizeTo !== undefined) {
      return {
        ok: false,
        error: "--resize and --resize-to are mutually exclusive resize forms: use one per edit.",
      };
    }
    if (resize !== undefined && scale !== undefined) {
      return {
        ok: false,
        error: "--resize and --scale are mutually exclusive: use one resize form per edit (--resize is relative, --scale sets the absolute scale).",
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
  return { ok: true, value: { ...(resizeFactor !== undefined ? { resizeFactor } : {}), ...(target !== undefined ? { resizeTo: target } : {}), ...(scaleValue !== undefined ? { scale: scaleValue } : {}) } };
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

/**
 * --shadow: syntax and well-formedness through the SAME parser the edit
 * path uses, so the two boundaries never disagree. Returns the raw spec
 * (the ingestion path re-resolves it against live state).
 */
export function parseLayerShadow(raw: string | undefined): OptionParse<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  try {
    parseShadowSpec(raw);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true, value: raw };
}

/**
 * --outline: syntax and well-formedness through the SAME parser the edit
 * path uses, so the two boundaries never disagree. Returns the raw spec
 * (the ingestion path re-resolves it against live state).
 */
export function parseLayerOutline(raw: string | undefined): OptionParse<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  try {
    parseOutlineSpec(raw);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true, value: raw };
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

/** The options --anchor cannot combine with: every edit option except the
 *  anchor's own axes (--x, --y) and --opacity, which combine freely.
 *  Derived from the option table, so a newly added option automatically
 *  joins the conflict rule. */
export function isAnchorConflicting(args: LayerOptionArgs): boolean {
  const anchorFree = new Set<LayerOptionKey>(["x", "y", "opacity", "anchor"]);
  return LAYER_OPTION_DEFS.some(
    (def) => def.editOption && !anchorFree.has(def.key) && args[def.key] !== undefined,
  );
}

/** The option-name segment of the edit surface's `--anchor` exclusivity
 *  refusal, derived from the SAME table and grouping `isAnchorConflicting`
 *  derives the conflict rule from (review INT-3): the transform, effect, and
 *  text groups spelled as flags, and the shape content group named as the
 *  "shape parameters" family. A newly added option in one of these groups
 *  joins both the rule and the refusal text automatically; the anchor-free
 *  axes (--x, --y, --opacity) stay outside, and the plain content kinds
 *  (--image, --from-generation, --from-matte, --text) are named as
 *  "content replacement" in the refusal's prose, not as a flag list. */
export function anchorConflictOptionList(): string {
  const editKeysOfGroup = (group: LayerOptionDef["group"]): LayerOptionKey[] =>
    LAYER_OPTION_DEFS.filter((def) => def.editOption && def.group === group).map((def) => def.key);
  const flags = (keys: readonly LayerOptionKey[]): string => keys.map((key) => `--${key}`).join(", ");
  const shape = `shape parameters (${SHAPE_CONTENT_KEYS.map((key) => `--${key}`).join(", ")})`;
  return [flags(editKeysOfGroup("paint")), flags(editKeysOfGroup("transform")), flags(editKeysOfGroup("region")), flags(editKeysOfGroup("effect")), shape, flags(editKeysOfGroup("text"))]
    .join(", ");
}