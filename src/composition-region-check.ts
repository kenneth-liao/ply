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
 * - **Regions** are ingested through `loadCompositionRegions`
 *   (src/composition-regions.ts) — the single ingestion point that turns
 *   raw caller JSON into trusted rectangle data and enforces the canvas
 *   contract.
 * - **Footprints** are the painted extents `measureCompositionLayers`
 *   (src/composition-measure.ts) reports — the browser-measured visible
 *   ink that `composition measure` reports, including effect reach and
 *   its conservative over-approximation, unchanged. A Layer whose painted
 *   extents are null (hidden at opacity 0, or fully transparent content)
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
import { loadCompositionRegions, type Region } from "./composition-regions.js";
import type { Page } from "playwright";

/** One (layer, region) intersection: the layer, its footprint, the region. */
export interface RegionFinding {
  /** The Composition use name of the intersecting Layer. */
  layer: string;
  /** The Layer identity the use refers to. */
  layerId: string;
  /** The Layer's painted footprint (the measured authority's extents) in Composition coordinates. */
  footprint: { x: number; y: number; width: number; height: number };
  /** The intersected caller region (trusted data from the ingestion point). */
  region: Region;
}

export interface RegionCheckResult {
  composition: string;
  canvas: { width: number; height: number };
  /** The region file path exactly as the caller supplied it. */
  regionFile: string;
  /** How many regions the file supplied. */
  regionCount: number;
  /** One entry per (layer, region) strict intersection. */
  findings: RegionFinding[];
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
 */
export async function checkCompositionRegions(
  projectPath: string,
  compName: string,
  regionFilePath: string,
  options: { page?: Page } = {},
): Promise<RegionCheckResult> {
  const measured = await measureCompositionLayers(projectPath, compName, undefined, options);
  const { regions } = await loadCompositionRegions(regionFilePath, measured.canvas);

  const findings: RegionFinding[] = [];
  for (const layer of measured.layers) {
    // Hidden (opacity 0) and fully transparent Layers paint nothing —
    // `painted: null` is the measurement authority's documented "nothing
    // is visible" signal — so there is no footprint to test.
    if (!layer.painted) continue;
    for (const region of regions) {
      if (intersects(layer.painted, region.box)) {
        findings.push({ layer: layer.name, layerId: layer.layerId, footprint: layer.painted, region });
      }
    }
  }

  return {
    composition: measured.composition,
    canvas: measured.canvas,
    regionFile: regionFilePath,
    regionCount: regions.length,
    findings,
  };
}