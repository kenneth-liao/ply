/**
 * Anchored Layer placement (#138, spec #132 US-002 / US-006, DEC-002/003/004,
 * ADR-0017).
 *
 * Anchored placement is a ONE-SHOT command-boundary normalization (DEC-003,
 * the same shape as `--resize-to` under ADR-0016): a target position and an
 * anchor spec are resolved once against the Layer's measured painted ink and
 * published as plain canonical placement (x, y) through the ordinary edit
 * lifecycle. Nothing about the anchor is persisted — x/y is the one
 * placement fact (DEC-002), so sharing, forks, cross-Project import, and
 * pinned Render history preserve anchored placement verbatim with no
 * alternate per-Composition placement state, and pinned replay stays
 * deterministic.
 *
 * The anchor box is the VISIBLE PAINTED INK (alpha > 0 / tight glyph ink,
 * unclipped) from the paint-identical measurement authority (#136/#137,
 * DEC-004) — never the layout content box. Transparent padding does not
 * count: a padded image's visible subject lands at the requested target
 * while its layout box extends into the padding side, and a centered
 * headline centers its glyph ink. A Layer with no visible ink refuses
 * instead of silently falling back to the layout box. Resolution runs
 * against the Layer's current transform; transform and content edits are
 * separate edits, because the reference ink would otherwise be ambiguous.
 *
 * A text Layer's ink depends on the referring Composition's canvas width
 * (pre-wrap shrink-to-fit), and placement is one shared fact (DEC-002), so
 * resolution measures the Layer in every referring Composition and refuses —
 * naming the affected compositions — when the resolved placements disagree.
 * Unreferenced Layers measure standalone on an unwrapped line (documented);
 * a fork resolves in its target Composition, whose use is about to own the
 * Layer.
 */
import { findLayerReferrers, inspectLayer } from "./layer.js";
import { measureCompositionLayers, measureStandaloneLayer } from "./composition-measure.js";

/** The axes of one anchored placement: each present component anchors the
 * corresponding coordinate as the target for that ink edge/center. */
export interface ParsedAnchor {
  horizontal?: "left" | "center" | "right";
  vertical?: "top" | "center" | "bottom";
}

const HORIZONTAL: ReadonlySet<string> = new Set(["left", "center", "right"]);
const VERTICAL: ReadonlySet<string> = new Set(["top", "center", "bottom"]);

/** Usage message shared by every invalid `--anchor` value (US-004). */
function anchorUsage(): string {
  return `--anchor takes left|center|right (horizontal), top|center|bottom (vertical), or a "<horizontal>,<vertical>" pair like "center,center".`;
}

/**
 * Parse and validate an `--anchor` specification into the canonical two-axis
 * shape. Single-component forms anchor one axis only and are accepted only
 * when unambiguous (`left`/`right` are horizontal, `top`/`bottom` vertical);
 * a bare `center` is refused because it could be either axis — a poka-yoke
 * refusal, never a silent guess. Pair form is always `<horizontal>,<vertical>`
 * in that order.
 */
export function parseAnchorSpec(spec: string): ParsedAnchor {
  const raw = spec.trim().toLowerCase();
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length === 1) {
    const only = parts[0]!;
    if (only === "center") {
      throw new Error(
        `Ambiguous anchor "${spec.trim()}": a bare "center" could be either axis — name both, e.g. "center,center". ${anchorUsage()}`,
      );
    }
    if (HORIZONTAL.has(only)) return { horizontal: only as ParsedAnchor["horizontal"] };
    if (VERTICAL.has(only)) return { vertical: only as ParsedAnchor["vertical"] };
    throw new Error(`Invalid anchor "${spec.trim()}". ${anchorUsage()}`);
  }
  if (parts.length === 2) {
    const [h, v] = parts;
    const hBad = !HORIZONTAL.has(h!);
    const vBad = !VERTICAL.has(v!);
    if (hBad || vBad) {
      throw new Error(
        `Invalid anchor "${spec.trim()}": the first component must be horizontal (left|center|right) and the second vertical (top|center|bottom). ${anchorUsage()}`,
      );
    }
    return { horizontal: h as ParsedAnchor["horizontal"], vertical: v as ParsedAnchor["vertical"] };
  }
  throw new Error(`Invalid anchor "${spec.trim()}". ${anchorUsage()}`);
}

/** Report precision: placement deltas inherit the measure authority's two-decimal reporting. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** One resolution result: the resolved placement plus the measured ink
 * evidence and the rendering contexts it was measured in (audit trail). */
export interface AnchorResolution {
  anchor: ParsedAnchor;
  /** The requested target, restricted to the anchored axes. */
  target: { x?: number; y?: number };
  /** The resolved canonical placement (x, y) to publish. An unanchored axis
   * keeps the Layer's current placement unless that axis's coordinate is
   * explicitly supplied (a plain placement edit); the command report
   * reflects exactly the placement the edit publishes. */
  placement: { x: number; y: number };
  /** The measured painted ink box the resolution anchored against (from the
   * first resolution context; identical across agreeing contexts). */
  painted: { x: number; y: number; width: number; height: number };
  /** The rendering contexts the resolution agrees over: the referring
   * Compositions, or ["standalone"] for an unreferenced Layer. */
  contexts: string[];
}

/** Resolved placement coordinate for one anchored axis: the target minus the
 * ink's offset from the placement point (edge) minus half/whole ink extent
 * (center/edge-opposite). */
function resolveAxis(
  edge: "left" | "center" | "right" | "top" | "bottom",
  target: number,
  inkStart: number,
  inkLength: number,
  placement: number,
): number {
  const offset = inkStart - placement; // ink position relative to the placement point
  if (edge === "left" || edge === "top") return target - offset;
  if (edge === "center") return target - offset - inkLength / 2;
  return target - offset - inkLength;
}

/** Resolve an anchored placement for `layerId` into plain canonical (x, y).
 * Read-only: it measures the live state and mutates nothing; the caller
 * publishes the resolved placement through the ordinary edit lifecycle.
 *
 * `contextComposition` (fork intent) resolves in that one Composition;
 * otherwise every referring Composition is measured (an unreferenced Layer
 * measures standalone). Multiple contexts must agree — a shared Layer has
 * one placement fact (DEC-002) — and disagreement refuses with the affected
 * compositions named and counted, following the blast-radius convention. */
export async function resolveAnchoredPlacement(
  projectPath: string,
  layerId: string,
  options: { anchor: ParsedAnchor; targetX?: number; targetY?: number; contextComposition?: string },
): Promise<AnchorResolution> {
  const { anchor, targetX, targetY, contextComposition } = options;
  if (anchor.horizontal !== undefined && targetX === undefined) {
    throw new Error(
      `--x <target> is required to anchor horizontally: the ${anchor.horizontal} ink edge/center lands at the requested x.`,
    );
  }
  if (anchor.vertical !== undefined && targetY === undefined) {
    throw new Error(
      `--y <target> is required to anchor vertically: the ${anchor.vertical} ink edge/center lands at the requested y.`,
    );
  }

  const contexts =
    contextComposition !== undefined ? [contextComposition] : await findLayerReferrers(projectPath, layerId);

  // The painted ink box and its offset from the placement point, measured
  // through the paint-identical authority. Placement is one shared revision
  // fact, so every context measures the same ink offsets when they agree.
  let painted: { x: number; y: number; width: number; height: number } | undefined;
  let inkOffset = { x: 0, y: 0 };
  for (const comp of contexts) {
    const measured = await measureCompositionLayers(projectPath, comp);
    const entry = measured.layers.find((l) => l.layerId === layerId);
    if (!entry) {
      throw new Error(`Layer "${layerId}" is not part of composition "${comp}".`);
    }
    if (!entry.painted) {
      throw noInkRefusal(layerId, comp);
    }
    if (painted === undefined) {
      painted = entry.painted;
      inkOffset = {
        x: entry.painted.x - entry.placement.x,
        y: entry.painted.y - entry.placement.y,
      };
    } else if (
      painted.x !== entry.painted.x || painted.y !== entry.painted.y ||
      painted.width !== entry.painted.width || painted.height !== entry.painted.height
    ) {
      throw divergentRefusal(layerId, contexts);
    }
  }

  if (painted === undefined) {
    // No referring Composition: the Layer is measured standalone at
    // placement (0, 0), so the painted box IS the ink offset.
    const standalone = await measureStandaloneLayer(projectPath, layerId);
    if (!standalone.painted) {
      throw noInkRefusal(layerId, "standalone");
    }
    painted = standalone.painted;
    inkOffset = { x: standalone.painted.x, y: standalone.painted.y };
  }

  // Per-axis resolution: the ink offset anchors the requested edge/center to
  // the target; an unanchored axis keeps the Layer's current placement.
  const current = (await inspectLayer(projectPath, layerId)).currentRevision;
  const placement = {
    x:
      anchor.horizontal !== undefined
        ? round2(
            resolveAxis(anchor.horizontal, targetX!, painted.x, painted.width, painted.x - inkOffset.x),
          )
        : current.x,
    y:
      anchor.vertical !== undefined
        ? round2(
            resolveAxis(anchor.vertical, targetY!, painted.y, painted.height, painted.y - inkOffset.y),
          )
        : current.y,
  };

  return {
    anchor,
    target: {
      ...(anchor.horizontal !== undefined ? { x: targetX } : {}),
      ...(anchor.vertical !== undefined ? { y: targetY } : {}),
    },
    placement,
    painted,
    contexts: contexts.length > 0 ? contexts : ["standalone"],
  };
}

/** Refusal for a Layer with no visible painted ink: anchored placement
 * resolves against visible ink and never falls back to the layout box. */
function noInkRefusal(layerId: string, context: string): Error {
  return new Error(
    `Layer "${layerId}" has no visible painted ink (transparent content or opacity 0` +
      (context === "standalone" ? "" : ` in composition "${context}"`) +
      `) — anchored placement resolves against the painted ink box, not the layout box. Use explicit --x/--y placement instead.`,
  );
}

/** Refusal for agreeing-required multi-context resolution: the affected
 * compositions are named and counted, following the blast-radius convention. */
function divergentRefusal(layerId: string, contexts: string[]): Error & { referringCompositions: string[]; referrersCount: number } {
  const names = contexts.map((n) => `"${n}"`).join(", ");
  const err = new Error(
    `Anchored placement of Layer "${layerId}" resolves to different placements across ${contexts.length} Compositions (${names}) — ` +
      `a shared Layer has one placement fact, and its painted geometry (text wrapping) differs between them. ` +
      `Fork into one Composition with --fork/--composition/--use, or use explicit --x/--y placement.`,
  ) as Error & { referringCompositions: string[]; referrersCount: number };
  err.referringCompositions = contexts;
  err.referrersCount = contexts.length;
  return err;
}