#!/usr/bin/env bun
/**
 * The ONE shared normalization and application plumbing for one-command
 * `composition add` (spec #226 DEC-001, US-001 bullet 3; finding A226-002,
 * ticket #258; parse convergence #263). The option table
 * (`LAYER_OPTION_DEFS` in layer-options.ts) declares every option once and
 * carries its parse registration and its application case; this module
 * carries the add surface's boundary parse (`parseOneCommandOptionValues`,
 * driven by the table's registrations through `ADD_PARSE_ORDER`'s
 * established check order) and the provisional scale context the add
 * dispatcher supplies, so a new option joins parse, validation, and
 * application on `composition add` by declaring itself in the shared
 * definition alone — no add-side parse
 * block, options member, presence check, name mapping, or application case
 * (the poka-yoke DEC-001 asks for: adding an option to one surface adds it
 * to the other).
 *
 * - **Normalization** — `parseOneCommandOptionValues` dispatches every
 *   supplied option through its table-carried parse (the same `parse…`
 *   functions `layer edit` dispatches, so the two boundaries never
 *   disagree) and returns the parsed values keyed by the option's own key
 *   — there is no per-option member to name.
 * - **Application** — each option's ONE application case is carried on
 *   the shared option table; the publication path dispatches through the
 *   table-derived application order (`oneCommandApplicationOrder`), and an
 *   option with no application case fails loudly, never silently dropped.
 *
 * What stays per-command: the add boundary's check sequence (the order the
 * refusals are reached in, preserved exactly by `ADD_PARSE_ORDER`), the
 * add path's placement defaults, and the help text. The edit surface's
 * application wiring is untouched by this module.
 */
import {
  ADD_PARSE_ORDER,
  LAYER_OPTION_DEFS,
  anyOneCommandOptionProvided,
  oneCommandAddOptionKeys,
  parseLayerOptionSteps,
  type LayerOptionArgs,
  type LayerOptionKey,
  type OptionParse,
  type SharedOptionApplyContext,
  type SharedOptionValues,
} from "./layer-options.js";
import { type ResolvedLayerRevision } from "./layer.js";
import { type ParsedAnchor } from "./layer-anchor.js";

/** The add surface's name for the shared parsed option values (DEC-001):
 *  the same keyed record `layer edit` dispatches. */
export type OneCommandOptionValues = SharedOptionValues;

/**
 * The ONE shared boundary parse for one-command `composition add`'s
 * post-content options (DEC-001, #263): presence derives from the option
 * table (`anyOneCommandOptionProvided` — no per-option presence check
 * exists), and every supplied option normalizes through its parse
 * registration on the shared option table (`ADD_PARSE_ORDER`'s established
 * check order through the ONE runner `parseLayerOptionSteps` — the same
 * validators `layer edit` dispatches, so the two boundaries never
 * disagree). Returns the normalized values keyed by the option keys, or
 * `undefined` when no post-content option is supplied — the established
 * plain-add behavior, unchanged. A supplied post-content key with no parse
 * registration throws, never silently dropped (#263).
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
  const parsed = parseLayerOptionSteps(values, ADD_PARSE_ORDER, oneCommandAddOptionKeys());
  if (!parsed.ok) return parsed;
  const anchor = parsed.value?.anchor as ParsedAnchor | undefined;
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
  return { ok: true, value: parsed.value };
}

/**
 * The scale resolution's provisional context (DEC-001): the fresh content's
 * intrinsic facts at scale 1 — the same rules, caps, and refusal texts the
 * edit surface's resize path produces. Text Layers have no intrinsic facts;
 * their pseudo-previous state carries the text kind (the --resize-to
 * refusal names the would-be Layer id from it).
 */
export function provisionalScaleContext(context: SharedOptionApplyContext): ResolvedLayerRevision {
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
    : ({ kind: "text", scaleX: 1, scaleY: 1, rotationDeg: 0, flipX: false, flipY: false, layoutRule: "natural" } as unknown as ResolvedLayerRevision);
}
