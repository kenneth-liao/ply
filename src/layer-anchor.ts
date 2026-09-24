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
 * The ink basis is the PRE-EFFECT painted ink (DEC-002, ADR-0017 amendment
 * #288): the ink-extending effect facts (shadow #139, outline #140) are
 * stripped inside the ONE shared resolution both anchored surfaces call, so
 * re-anchoring an effected Layer never moves it and the two surfaces cannot
 * drift. For legacy text revisions, a text Layer's ink depends on the referring
 * Composition's canvas width (pre-wrap shrink-to-fit; modern revisions use
 * position-independent natural layout per the ADR-0017 amendment). Because
 * placement is one shared fact (DEC-002), resolution measures the Layer in
 * every referring Composition and refuses — naming the affected compositions —
 * when the resolved placements disagree. Unreferenced Layers measure standalone
 * on an unwrapped line (documented); a fork resolves in its target Composition,
 * whose use is about to own the Layer.
 */
import { findLayerReferrers, readLayerInternalFull, type ResolvedLayerRevision } from "./layer.js";
import {
  measureProvisionalLayer,
  STANDALONE_CANVAS_PX,
} from "./composition-measure.js";
import type { SnapshotLayer } from "./composition-paint.js";
import { readCompositionInternalFull } from "./composition.js";
import { resolveProjectRoot } from "./project.js";
import { withProjectLock } from "./project-lock.js";

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
/** The pre-effect ink basis (DEC-002, spec #285 US-002, ADR-0017 amendment
 * #288): the exact revision facts stripped before anchor ink is measured.
 * ADR-0017's consequences named the ink-extending effects — the shadow
 * (#139, ADR-0018) and the outline (#140, ADR-0019) — and left the question
 * of effect-extended ink to their contracts; the amendment resolves it as
 * exactly these two facts. Grade, edge glow, and blend cannot change the
 * ink (they preserve alpha coverage — ADR-0024 DEC-005), and the visible
 * region is paint (ADR-0023), not an effect — both stay part of the basis.
 * One home: both anchored surfaces resolve through the function below, so
 * the basis cannot drift between `composition add` and `layer edit`. */
function preEffectInkBasis(revision: ResolvedLayerRevision): ResolvedLayerRevision {
  const { shadow: _shadow, outline: _outline, ...rest } = revision;
  return rest as ResolvedLayerRevision;
}

/** The result of the shared pre-effect resolution: the resolved placement,
 * the measured ink box the resolution anchored against, and the ink's
 * offset from the placement point. */
interface PreEffectAnchor {
  placement: { x: number; y: number };
  painted: { x: number; y: number; width: number; height: number };
}

/** The ONE pre-effect anchored-ink resolution both anchored surfaces share
 * (DEC-002, TEST-004, ADR-0017 amendment #288): measure the supplied
 * snapshot's painted ink in `canvas` with the ink-extending effect facts
 * stripped (the basis lives here, never as a caller-supplied flag), then
 * resolve the anchored axes against it. The anchored axes' targets are
 * required (validated here, the ONE home); an unanchored axis keeps
 * `fallbackX`/`fallbackY` — the Layer's current placement (edit) or its
 * would-be --x/--y (add). `revision.x`/`.y` are the ink-offset base: the
 * snapshot may be placed at (0, 0) (standalone), where the painted box IS
 * the offset. `name` is the snapshot's paint identity (the use name in a
 * Composition, the layer id provisionally/standalone) — the name refusals
 * and reports carry. Read-only: nothing is staged or stored. */
async function resolvePreEffectAnchor(options: {
  canvas: { width: number; height: number };
  layerId: string;
  name?: string;
  revision: ResolvedLayerRevision;
  contentBytes: Buffer;
  anchor: ParsedAnchor;
  targetX?: number;
  targetY?: number;
  fallbackX: number;
  fallbackY: number;
  context: string;
}): Promise<PreEffectAnchor> {
  const { canvas, layerId, anchor, targetX, targetY, fallbackX, fallbackY, context } = options;
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
  // The pre-effect ink basis: the effect facts never reach the measurement.
  const revision = preEffectInkBasis(options.revision);
  const snapshot: SnapshotLayer = { name: options.name ?? layerId, layerId, revision, contentBytes: options.contentBytes };
  const measured = await measureProvisionalLayer(canvas, snapshot);
  if (measured.refused) {
    throw new Error(measured.refused);
  }
  if (!measured.painted) {
    throw noInkRefusal(layerId, context);
  }
  const painted = measured.painted;

  // Per-axis resolution: the ink offset anchors the requested edge/center to
  // the target; an unanchored axis keeps the fallback placement.
  const placement = {
    x:
      anchor.horizontal !== undefined
        ? round2(resolveAxis(anchor.horizontal, targetX!, painted.x, painted.width, revision.x))
        : fallbackX,
    y:
      anchor.vertical !== undefined
        ? round2(resolveAxis(anchor.vertical, targetY!, painted.y, painted.height, revision.y))
        : fallbackY,
  };
  return { placement, painted };
}

/** Resolve an anchored placement for `layerId` into plain canonical (x, y).
 * Read-only: it measures the live state and mutates nothing; the caller
 * publishes the resolved placement through the ordinary edit lifecycle.
 *
 * The reference ink is the PRE-EFFECT painted ink through the ONE shared
 * resolution `composition add` also resolves through (DEC-002, ADR-0017
 * amendment #288): a stored shadow or outline never shifts a re-anchoring
 * edit, and an effect edit never moves a stored placement.
 *
 * `contextComposition` (fork intent) resolves in that one Composition;
 * otherwise every referring Composition is measured (an unreferenced Layer
 * measures standalone). Multiple contexts must agree — a shared Layer has
 * one placement fact (DEC-002) — and disagreement refuses with the affected
 * compositions named and counted, following the blast-radius convention. */
export async function resolveAnchoredPlacement(
  projectPath: string,
  layerId: string,
  options: { anchor: ParsedAnchor; targetX?: number; targetY?: number; contextComposition?: string; contextUse?: string },
): Promise<AnchorResolution> {
  const { anchor, targetX, targetY, contextComposition } = options;
  const contexts =
    contextComposition !== undefined ? [contextComposition] : await findLayerReferrers(projectPath, layerId);
  const resolvedRoot = await resolveProjectRoot(projectPath);

  // The read-snapshot pattern (renderComposition, measureCompositionLayers):
  // every context's canvas plus the target use's verified revision and
  // content bytes, resolved exactly once under the Project lock, then
  // measured outside the lock — resolution writes nothing.
  const snapshots = await withProjectLock(resolvedRoot, async () => {
    const contextSnapshots: { name: string; canvas: { width: number; height: number }; revision: ResolvedLayerRevision; contentBytes: Buffer }[] = [];
    for (const comp of contexts) {
      const full = await readCompositionInternalFull(projectPath, comp);
      const use =
        (options.contextUse !== undefined
          ? full.layers.find((l) => l.name === options.contextUse && l.layerId === layerId)
          : undefined) ?? full.layers.find((l) => l.layerId === layerId);
      if (!use) {
        throw new Error(`Layer "${layerId}" is not part of composition "${comp}".`);
      }
      contextSnapshots.push({ name: use.name, canvas: full.canvas, revision: use.revision, contentBytes: use.contentBytes });
    }
    // The Layer's current revision and verified bytes: the unanchored axes'
    // fallback placement, and the standalone snapshot when no context reads.
    const layer = await readLayerInternalFull(resolvedRoot, layerId);
    return { contextSnapshots, current: layer.currentRevision, contentBytes: layer.contentBytes };
  });

  if (snapshots.contextSnapshots.length === 0) {
    // No referring Composition: the Layer is measured standalone at
    // placement (0, 0) on the unwrapped standalone canvas, so the painted
    // box IS the ink offset — the same measurement the pre-change edit path
    // used, now through the shared pre-effect resolution.
    const resolved = await resolvePreEffectAnchor({
      canvas: { width: STANDALONE_CANVAS_PX, height: STANDALONE_CANVAS_PX },
      layerId,
      revision: { ...snapshots.current, x: 0, y: 0 },
      contentBytes: snapshots.contentBytes,
      anchor,
      targetX,
      targetY,
      fallbackX: snapshots.current.x,
      fallbackY: snapshots.current.y,
      context: "standalone",
    });
    return {
      anchor,
      target: {
        ...(anchor.horizontal !== undefined ? { x: targetX } : {}),
        ...(anchor.vertical !== undefined ? { y: targetY } : {}),
      },
      placement: resolved.placement,
      painted: resolved.painted,
      contexts: ["standalone"],
    };
  }

  // Measure each context through the shared pre-effect resolution. Placement
  // is one shared revision fact, so every context measures the same ink
  // offsets when they agree.
  let resolution: PreEffectAnchor | undefined;
  for (const snap of snapshots.contextSnapshots) {
    const resolved = await resolvePreEffectAnchor({
      canvas: snap.canvas,
      layerId,
      name: snap.name,
      revision: snap.revision,
      contentBytes: snap.contentBytes,
      anchor,
      targetX,
      targetY,
      fallbackX: snapshots.current.x,
      fallbackY: snapshots.current.y,
      context: snap.name,
    });
    if (resolution === undefined) {
      resolution = resolved;
    } else if (
      resolution.painted.x !== resolved.painted.x || resolution.painted.y !== resolved.painted.y ||
      resolution.painted.width !== resolved.painted.width || resolution.painted.height !== resolved.painted.height
    ) {
      throw divergentRefusal(layerId, contexts);
    }
  }
  const first = resolution!;

  return {
    anchor,
    target: {
      ...(anchor.horizontal !== undefined ? { x: targetX } : {}),
      ...(anchor.vertical !== undefined ? { y: targetY } : {}),
    },
    placement: first.placement,
    painted: first.painted,
    contexts,
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

/**
 * Resolve an anchored placement for a PROVISIONAL revision (one-command
 * `composition add`, spec #226 US-001/DEC-002): the Layer does not exist
 * yet, so the reference ink is measured from the supplied would-be
 * revision and verified content bytes alone, in the target Composition's
 * canvas — the rendering context the Layer is about to join, whose text
 * wrapping and canvas are what the ink obeys.
 *
 * The provisional revision carries the transforms (the documented
 * one-command order applies transforms BEFORE the anchor resolves) and, by
 * that order, no effect facts yet — but parity with `layer edit` does not
 * rely on that ordering alone: the resolution flows through the ONE shared
 * pre-effect ink resolution (DEC-002, ADR-0017 amendment #288), whose basis
 * strips the ink-extending effect facts, so the two surfaces cannot drift.
 * Read-only: it mutates nothing; the caller publishes the resolved
 * placement inside the SAME single revision. The anchored axes' targets are
 * the would-be placement coordinates, which the add boundary requires to be
 * explicit (the same requirement `layer edit` states, so a missing target
 * refuses there, before anything is measured).
 */
export async function resolveProvisionalAnchoredPlacement(
  canvas: { width: number; height: number },
  provisional: { layerId: string; revision: ResolvedLayerRevision; contentBytes: Buffer },
  options: { anchor: ParsedAnchor; contextComposition: string },
): Promise<AnchorResolution> {
  const { anchor } = options;
  const { layerId, contentBytes } = provisional;
  const targetX = provisional.revision.x;
  const targetY = provisional.revision.y;

  const resolved = await resolvePreEffectAnchor({
    canvas,
    layerId,
    revision: provisional.revision,
    contentBytes,
    anchor,
    targetX,
    targetY,
    fallbackX: targetX,
    fallbackY: targetY,
    context: options.contextComposition,
  });

  return {
    anchor,
    target: {
      ...(anchor.horizontal !== undefined ? { x: targetX } : {}),
      ...(anchor.vertical !== undefined ? { y: targetY } : {}),
    },
    placement: resolved.placement,
    painted: resolved.painted,
    contexts: [options.contextComposition],
  };
}
