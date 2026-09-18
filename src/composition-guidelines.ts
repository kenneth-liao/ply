/**
 * The Composition guideline view (#174, spec #172 US-002, DEC-002): render a
 * Composition canvas with caller-supplied regions drawn as inspectable
 * overlay markup, so a human reviewer can judge placement visually before
 * accepting a render — the parity F8 in examples/thumbnail-luigi-go/
 * HANDOFF.md names as missing. Only the overlay shows a near-miss that does
 * not intersect but still looks wrong, and whether an intersection actually
 * matters (a background touching the duration badge is fine; a headline
 * grazing it is not).
 *
 * Structural exclusion (ADR-0005's render-excluded overlay disposition,
 * carried forward by ADR-0015): the guideline markup exists only in this
 * module — `guidelineOverlayMarkup` wrapped around the shared page builder
 * by `guidelinePageHtml` — and only `renderCompositionGuidelines` consumes
 * that wrapped page. The render path (`composition render` →
 * paintComposition → buildCompositionHtml) takes no parameter, flag, or
 * branch that could emit the overlay, so a final Render structurally cannot
 * contain it; the byte-equal render → guidelines → render sequence in
 * test/composition-guidelines.test.ts is the behavioral proof.
 *
 * This is a review artifact, not a reproducible Render: it writes no Render
 * manifest and adds nothing to retained Render history, and it refuses to
 * overwrite any output a Render manifest or the Project's Render history
 * records (projectRenderOutputConflict over the Project's renders/, plus the
 * legacy manifest directory reader for outputs recorded elsewhere) —
 * overwriting a recorded Render would leave its manifest presenting
 * guideline pixels as an accepted Render.
 *
 * Two authorities are reused, never re-modeled:
 * - **Regions** are ingested through src/composition-regions.ts — the same
 *   single ingestion point `composition check` uses (#173), so there is one
 *   region format and one parser; the canvas contract is enforced there.
 * - **The snapshot** (canvas + exact verified Layer bytes) is resolved
 *   through src/composition-render.ts's `resolveCompositionSnapshot` — the
 *   exact pass a Render paints — so the view shows precisely what would
 *   render, plus the overlay.
 *
 * The whole operation is local: no network, no inference weights. The extra
 * `guidelines/` directory under the Project is review output, not Project
 * state: no Project scan, validation, sharing, or history code reads it
 * (project.ts validates only its canonical subdirectories), and render
 * history lives only in renders/.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { paintCompositionHtml, buildCompositionHtml, escapeHtml, type SnapshotLayer } from "./composition-paint.js";
import { resolveCompositionSnapshot } from "./composition-render.js";
import { ingestRegionCanvas, readRegionFile, type Region } from "./composition-regions.js";
import { renderOutputConflict } from "./manifest.js";
import { resolveProjectRoot } from "./project.js";
import { projectRenderOutputConflict } from "./render-history.js";

/**
 * The region overlay (the legacy REQ-012 shape, caller-parameterized): one
 * labeled div per region in a <style> block (nested quotes inside a style
 * attribute truncate silently), with the region's label and reason visible.
 * Scoped to .ply-region-guide so the selectors can never touch #canvas or
 * its Layer elements. Only the guideline page ever includes this markup —
 * buildCompositionHtml cannot, so the overlay structurally cannot enter a
 * final render's output. Region text is escaped with the paint builder's
 * shared escapeHtml.
 */
function guidelineOverlayMarkup(regions: Region[]): string {
  const boxes = regions.map(
    (r) =>
      `<div class="ply-region-guide" data-region-id="${escapeHtml(r.id)}" data-region-label="${escapeHtml(r.label)}" ` +
      `data-region-reason="${escapeHtml(r.reason)}" ` +
      `style="left:${r.box.x}px;top:${r.box.y}px;width:${r.box.width}px;height:${r.box.height}px;">` +
      `<span class="ply-region-guide-label">${escapeHtml(r.label)}</span>` +
      `<span class="ply-region-guide-reason">${escapeHtml(r.reason)}</span></div>`,
  ).join("");
  return (
    `<style>` +
    `.ply-region-guide{position:absolute;outline:3px dashed #ff00ff;outline-offset:-3px;background:rgba(255,0,255,0.18);}` +
    `.ply-region-guide .ply-region-guide-label{position:absolute;left:6px;top:4px;font:bold 14px/18px sans-serif;color:#cc00cc;}` +
    `.ply-region-guide .ply-region-guide-reason{position:absolute;left:6px;top:22px;font:12px/16px sans-serif;color:#990099;max-width:calc(100% - 12px);overflow-wrap:break-word;}` +
    `</style>${boxes}`
  );
}

/**
 * The guideline page: the Composition's own render page (byte-identical to
 * what a final render paints) with the caller's region overlay appended
 * before </body> — the view shows exactly what would render, plus the
 * regions the caller's platform UI covers.
 */
export function guidelinePageHtml(
  canvas: { width: number; height: number },
  layers: SnapshotLayer[],
  regions: Region[],
): string {
  return buildCompositionHtml(canvas, layers).replace(
    "</body>",
    `${guidelineOverlayMarkup(regions)}\n</body>`,
  );
}

export interface CompositionGuidelineResult {
  composition: string;
  canvas: { width: number; height: number };
  /** The written guideline PNG path (absolute). */
  output: string;
  /** The region file path, as supplied by the caller. */
  regionFile: string;
  /** How many regions the file supplied. */
  regionCount: number;
}

export interface CompositionGuidelineOptions {
  /** Caller-owned page (tests: route-aborted offline evidence); never closed. */
  page?: Page;
  /** Caller-chosen review-artifact path; defaults to guidelines/<comp>.guidelines.png. */
  out?: string;
}

/**
 * Render the guideline view: the Composition exactly as `composition render`
 * would draw it, plus the caller-supplied regions as an inspectable overlay.
 * `options.page` is the existing render-page injection seam (tests:
 * route-aborted offline evidence); without one, the shared render page runs
 * the paint, exactly as in `composition render`.
 *
 * Ordering is cheap-before-expensive: the region file is parsed first (a
 * malformed file fails before the browser pass), then the Composition
 * snapshot is resolved through the render resolver, then the canvas contract
 * is enforced, then the destination is checked against recorded Render
 * outputs — all before any paint.
 */
export async function renderCompositionGuidelines(
  projectPath: string,
  compName: string,
  regionFilePath: string,
  options: CompositionGuidelineOptions = {},
): Promise<CompositionGuidelineResult> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  const file = await readRegionFile(regionFilePath);
  const snapshot = await resolveCompositionSnapshot(resolvedRoot, compName);
  const regions = ingestRegionCanvas(file, snapshot.canvas, regionFilePath);

  // The review artifact's destination: caller-chosen, or the default
  // guidelines/<comp>.guidelines.png under the Project. A recorded Render
  // output — in the Project's renders/ history or recorded by any manifest
  // beside the target — is never overwritten (fail-closed readers).
  const output = options.out
    ? path.resolve(options.out)
    : path.join(resolvedRoot, "guidelines", `${snapshot.name}.guidelines.png`);
  const conflict =
    (await projectRenderOutputConflict(resolvedRoot, output)) ??
    (await renderOutputConflict(output));
  if (conflict) {
    throw new Error(
      `"${output}" is a Render output — the manifest "${path.basename(conflict.manifest)}" records it, and ` +
        `the guideline view must never overwrite a final Render. Pick a different --out path.`,
    );
  }

  const { png } = await paintCompositionHtml(
    snapshot.canvas,
    guidelinePageHtml(snapshot.canvas, snapshot.layers, regions),
    snapshot.layers,
    options,
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, png);

  return {
    composition: snapshot.name,
    canvas: snapshot.canvas,
    output,
    regionFile: regionFilePath,
    regionCount: regions.length,
  };
}