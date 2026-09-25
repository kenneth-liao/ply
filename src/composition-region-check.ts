/**
 * Caller-parameterized region checking for Compositions (#173, spec #172
 * US-001/US-004, DEC-002, DEC-004, ADR-0015 with ADR-0005's warning-only
 * disposition).
 *
 * An agent points Ply at a Composition and a caller-owned region file and
 * gets back one finding per (layer, region) intersection — the same
 * actionable shape the legacy `safe-area:` warnings have, but with the
 * regions supplied by path instead of hardcoded YouTube geometry (no
 * platform geometry anywhere in the check path).
 *
 * Two authorities, both reused, never re-modeled:
 * - **Regions** are ingested through src/composition-regions.ts — the
 *   single ingestion point (`readRegionFile` → `ingestRegionCanvas`, or
 *   the one-call `loadCompositionRegions`) that turns raw caller JSON
 *   into trusted rectangle data and enforces the canvas contract.
 * - **Footprints** are the ink that renders: `measureCompositionLayers`
 *   (src/composition-measure.ts) reports painted extents, and since
 *   ADR-0025 (#305) a masked Layer's `painted` is PRE-clip by documented
 *   meaning — so the check tests the POST-clip extents (`maskedPainted`)
 *   for a masked Layer and treats null (nothing survives the clip) as no
 *   ink, never falling back to pre-clip painted; an unmasked Layer tests
 *   its `painted` extents. Effect reach and its conservative
 *   over-approximation are unchanged. A Layer whose tested ink is null
 *   paints nothing and is skipped — the legacy leaf rule, already
 *   enforced by the measurement authority. Nothing here reslices,
 *   inflates, or recomputes geometry: the check is pure intersection over
 *   the measured report.
 *
 * Findings are information, never render bans (ADR-0005): a full-bleed
 * background intersecting every supplied region is accepted noise, and a
 * finding never changes what renders or what a render exits with. The
 * check is a read-only query — it writes nothing to the Project. The
 * whole operation is local: no network, no inference weights.
 */
import { measureCompositionLayers } from "./composition-measure.js";
import { ingestRegionCanvas, readRegionFile, type Region } from "./composition-regions.js";
import type { Page } from "playwright";

/** One (layer, region) intersection: the layer, its footprint, the region. */
export interface RegionFinding {
  /** The Composition use name of the intersecting Layer. */
  layer: string;
  /** The Layer identity the use refers to. */
  layerId: string;
  /** The Layer's tested ink footprint — the POST-clip extents for a masked Layer, the painted extents otherwise (the measured authority's ink-that-renders) — in Composition coordinates. */
  footprint: { x: number; y: number; width: number; height: number };
  /** The intersected caller region (trusted data from the ingestion point). */
  region: Region;
}

/** One Layer whose measurement was refused (e.g. capture window exceeded, #206). */
export interface RegionRefusal {
  /** The Composition use name of the refused Layer. */
  layer: string;
  /** The Layer identity the use refers to. */
  layerId: string;
  /** The actionable refusal message from the measurement authority. */
  message: string;
}

export interface RegionCheckResult {
  composition: string;
  canvas: { width: number; height: number };
  /** The region file path, resolved to an absolute path by the CLI. */
  regionFile: string;
  /** How many regions the file supplied. */
  regionCount: number;
  /** One entry per (layer, region) strict intersection. */
  findings: RegionFinding[];
  /** One entry per Layer whose measurement was refused. */
  refused: RegionRefusal[];
}

/** Strict rectangle overlap — edges touching exactly is not an intersection. */
const intersects = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/**
 * Check a Composition's painted extents against caller-supplied regions,
 * read-only. `options.page` is the existing measurement injection seam —
 * a caller-provided render page keeps the operation deterministic and
 * testable (and provably offline); without one, the shared render page is
 * used, exactly as in `composition measure`.
 *
 * Ordering is cheap-before-expensive: the region file is parsed and
 * structurally validated first (a malformed file fails before the browser
 * pass — review INT-2/PROD-1), then the Composition is measured, then the
 * canvas contract is checked against the measured canvas.
 */
export async function checkCompositionRegions(
  projectPath: string,
  compName: string,
  regionFilePath: string,
  options: { page?: Page } = {},
): Promise<RegionCheckResult> {
  const file = await readRegionFile(regionFilePath);
  const measured = await measureCompositionLayers(projectPath, compName, undefined, options);
  const regions = ingestRegionCanvas(file, measured.canvas, regionFilePath);

  const findings: RegionFinding[] = [];
  const refused: RegionRefusal[] = [];
  for (const layer of measured.layers) {
    // Refused Layers must not be dropped silently (#206): report the refusal
    // as its own finding kind so footprints are never quietly unverified.
    if (layer.refused) {
      refused.push({ layer: layer.name, layerId: layer.layerId, message: layer.refused });
      continue;
    }
    // The ink that RENDERS (review PROD-U3-3): a masked Layer's painted
    // extents are pre-clip by documented meaning (ADR-0025 §5), so the
    // check tests the POST-clip extents (`maskedPainted`) — null means
    // nothing survives the clip, never a fallback to pre-clip ink. An
    // unmasked Layer tests its painted extents. Either way, null paints
    // nothing (hidden at opacity 0, fully transparent content, or an
    // empty post-clip remainder) and there is no footprint to test.
    const ink = layer.mask !== null ? layer.maskedPainted : layer.painted;
    if (!ink) continue;
    for (const region of regions) {
      if (intersects(ink, region.box)) {
        findings.push({ layer: layer.name, layerId: layer.layerId, footprint: ink, region });
      }
    }
  }

  return {
    composition: measured.composition,
    canvas: measured.canvas,
    regionFile: regionFilePath,
    regionCount: regions.length,
    findings,
    refused,
  };
}
