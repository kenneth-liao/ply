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
 * carried forward by ADR-0015): the guideline markup and the in-page
 * placement pass exist only in this module — `guidelineOverlayMarkup`
 * wrapped around the shared page builder by `guidelinePageHtml`, placed by
 * `placeRegionCallouts` through the guideline-only `beforeScreenshot` hook —
 * and only `renderCompositionGuidelines` consumes that wrapped page. The
 * render path (`composition render` → paintComposition →
 * buildCompositionHtml) takes no parameter, flag, or branch that could emit
 * or place the overlay, so a final Render structurally cannot contain it;
 * the byte-equal render → guidelines → render sequence in
 * test/composition-guidelines.test.ts is the behavioral proof.
 *
 * This is a review artifact, not a reproducible Render: it writes no Render
 * manifest and adds nothing to retained Render history, and it refuses to
 * overwrite any output a Render manifest or the Project's Render history
 * records — overwriting a recorded Render would leave its manifest
 * presenting guideline pixels as an accepted Render.
 *
 * Destination and publication (#174 review PROD-1/PROD-3): every
 * destination — the default and caller-chosen `--out` alike — resolves
 * through the render path's one export-target boundary
 * (`resolveExportTarget`: reserved Project inputs, existing in-Project
 * state, directories, and non-regular files are refused there and nowhere
 * else), and the conflict check plus the publish run under the same Project
 * lock the snapshot resolved under, with the render path's atomic
 * publication (O_EXCL create for fresh in-Project destinations, temp-file
 * rename for external replacements). The paint runs outside the lock.
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
 * history lives only in renders/. Whole-tree enumerators (share, export,
 * backup) must treat it as an ignorable review-output directory — the
 * ignore contract is documented at PROJECT_SUBDIRS in src/project.ts and in
 * README's guideline-view section.
 */
import { lstat, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Page } from "playwright";
import {
  paintCompositionHtml,
  buildCompositionHtml,
  paintMaskRasters,
  escapeHtml,
  type SnapshotLayer,
} from "./composition-paint.js";
import { withRenderPage } from "./browser.js";
import { resolveCompositionSnapshot, resolveExportTarget } from "./composition-render.js";
import { ingestRegionCanvas, readRegionFile, type Region } from "./composition-regions.js";
import { renderOutputConflict } from "./manifest.js";
import { atomicCreate, atomicReplace, withProjectLock } from "./project-lock.js";
import { resolveProjectRoot } from "./project.js";
import { projectRenderOutputConflict } from "./render-history.js";

/**
 * The region overlay (the legacy REQ-012 shape, caller-parameterized), with
 * the label/reason callout as a SIBLING of the region box (#174 review
 * INT-1): the dashed outline and tint stay exactly on the region box, while
 * the label + reason render in a white pill that a measured in-page pass
 * (`placeRegionCallouts`) positions where it is fully visible inside the
 * canvas — inside the box when it fits, otherwise flipped above, below,
 * right, or left of the box. Text inside thin or canvas-edge regions (the
 * YouTube progress strip is 16px tall at the canvas bottom edge) would
 * paint outside the viewport; the callout flip keeps label and reason
 * readable for arbitrary caller regions.
 *
 * One <style> block plus one box div and one callout div per region, in
 * region-file order (the placement pass pairs them by index). Scoped to
 * .ply-region-guide / .ply-region-guide-callout so the selectors can never
 * touch #canvas or its Layer elements. Only the guideline page ever
 * includes this markup — buildCompositionHtml cannot, so the overlay
 * structurally cannot enter a final render's output. Region text is
 * escaped with the paint builder's shared escapeHtml.
 */
function guidelineOverlayMarkup(regions: Region[]): string {
  const boxes = regions.map(
    (r) =>
      `<div class="ply-region-guide" data-region-id="${escapeHtml(r.id)}" ` +
      `style="left:${r.box.x}px;top:${r.box.y}px;width:${r.box.width}px;height:${r.box.height}px;" ` +
      `title="${escapeHtml(`${r.label}: ${r.reason}`)}"></div>` +
      `<div class="ply-region-guide-callout">` +
      `<span class="ply-region-guide-label">${escapeHtml(r.label)}</span>` +
      `<span class="ply-region-guide-reason">${escapeHtml(r.reason)}</span></div>`,
  ).join("");
  return (
    `<style>` +
    `.ply-region-guide{position:absolute;outline:3px dashed #ff00ff;outline-offset:-3px;background:rgba(255,0,255,0.18);}` +
    `.ply-region-guide-callout{position:absolute;background:rgba(255,255,255,0.92);border:1px solid #ff00ff;` +
    `padding:3px 6px;max-width:480px;overflow-wrap:break-word;}` +
    `.ply-region-guide-callout .ply-region-guide-label{display:block;font:bold 13px/17px sans-serif;color:#8a008a;}` +
    `.ply-region-guide-callout .ply-region-guide-reason{display:block;font:12px/16px sans-serif;color:#5a005a;}` +
    `</style>${boxes}`
  );
}

/**
 * The in-page placement pass (#174 review INT-1): measure each callout's
 * real rendered size and position it where it is fully visible inside the
 * canvas, trying — in order — just inside the region box (the compact
 * default), then above, below, right, and left of the box, and finally a
 * clamped position inside the canvas. Runs through the guideline-only
 * `beforeScreenshot` hook after fonts have loaded, so the screenshot shows
 * the placed callouts; the render path never runs it. Pairs boxes and
 * callouts by index (both are emitted in region-file order; duplicate ids
 * are rejected at the ingestion point). A missing box or callout is a
 * markup-contract violation and fails loudly, like
 * `sizeEffectFilterRegions`.
 */
export async function placeRegionCallouts(page: Page): Promise<void> {
  const failure = await page.evaluate(() => {
    const cw = document.documentElement.clientWidth;
    const ch = document.documentElement.clientHeight;
    const boxes = Array.from(document.querySelectorAll<HTMLElement>(".ply-region-guide"));
    const callouts = Array.from(document.querySelectorAll<HTMLElement>(".ply-region-guide-callout"));
    if (boxes.length !== callouts.length) {
      return `region boxes (${boxes.length}) and callouts (${callouts.length}) are not paired`;
    }
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
    for (let i = 0; i < callouts.length; i++) {
      const box = boxes[i]!;
      const callout = callouts[i]!;
      const b = box.getBoundingClientRect();
      const c = callout.getBoundingClientRect();
      const w = c.width;
      const h = c.height;
      // Horizontal clamp for candidates that keep the callout at the box's
      // vertical band; guards against a hi < lo when w exceeds the canvas.
      const cx = clamp(b.left, 4, cw - w - 4);
      const cy = clamp(b.top, 4, ch - h - 4);
      // Preference order: inside the box (inset 4px, only when the pill
      // fits within it), then above, below, right, left of the box.
      const candidates: { x: number; y: number; inside?: boolean }[] = [
        { x: b.left + 4, y: b.top + 4, inside: true },
        { x: cx, y: b.top - h - 4 },
        { x: cx, y: b.bottom + 4 },
        { x: b.right + 4, y: cy },
        { x: b.left - w - 4, y: cy },
      ];
      let placed = false;
      for (const cand of candidates) {
        if (cand.inside && !(w <= b.width - 8 && h <= b.height - 8)) continue;
        const x = Math.round(cand.x);
        const y = Math.round(cand.y);
        // The box lies inside the canvas, so an inside placement is already
        // contained; every other candidate must fit the canvas itself.
        const contained = cand.inside || (x >= 0 && y >= 0 && x + w <= cw && y + h <= ch);
        if (contained) {
          callout.style.left = `${x}px`;
          callout.style.top = `${y}px`;
          placed = true;
          break;
        }
      }
      if (!placed) {
        // Extreme case (pill wider than the canvas): clamp it into the
        // canvas so it stays anchored; the text then clips, loudly reviewable
        // in the PNG.
        callout.style.left = `${Math.round(cx)}px`;
        callout.style.top = `${Math.round(cy)}px`;
      }
    }
    return null;
  });
  if (failure !== null) {
    throw new Error(
      `Region callout placement failed: ${failure}. The page is not the markup the guideline builder ` +
        `emitted — refusing to paint a view with misplaced callouts.`,
    );
  }
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
  maskImages: Map<string, string> = new Map(),
): string {
  return buildCompositionHtml(canvas, layers, 1, maskImages).replace(
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
  /** Caller-chosen review-artifact path, resolved through the render path's
   * export-target boundary (PROD-1); defaults to a fresh, never-colliding
   * file under the Project's guidelines/. */
  out?: string;
}

/**
 * A fresh, never-colliding default view destination under the Project's
 * guidelines/ directory — the same fresh-name discipline as the render
 * path's default renders/ destination, so re-running the view never
 * overwrites the artifact a reviewer may still be looking at. Callers hold
 * the Project lock.
 */
async function defaultViewDestination(resolvedRoot: string, compName: string): Promise<string> {
  const dir = path.join(resolvedRoot, "guidelines");
  await mkdir(dir, { recursive: true });
  for (;;) {
    const candidate = path.join(dir, `${compName}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.guidelines.png`);
    try {
      await lstat(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw err;
    }
  }
}

/**
 * Render the guideline view: the Composition exactly as `composition render`
 * would draw it, plus the caller-supplied regions as an inspectable overlay.
 * `options.page` is the existing render-page injection seam (tests:
 * route-aborted offline evidence); without one, the shared render page runs
 * the paint, exactly as in `composition render`.
 *
 * Ordering is cheap-before-expensive, with the paint outside the Project
 * lock: the region file is parsed first (a malformed file fails before the
 * browser pass), the Composition snapshot is resolved through the render
 * resolver, the canvas contract is enforced, and the paint runs — then, under
 * the Project lock, the destination is resolved through the one export-target
 * boundary, checked against recorded Render outputs, and published
 * atomically (O_EXCL create for fresh in-Project destinations, temp-file
 * rename for external replacements). A concurrent render publishing to the
 * same destination therefore cannot slip between the guard and the write.
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

  // The paint (with the guideline-only callout placement pass) stays outside
  // the lock; everything that reads or writes Project-visible state happens
  // under it, immediately before publishing. The mask pass (ADR-0025, #305)
  // runs on the same page first — the guideline view shows exactly what
  // would render, clips included.
  const paint = async (page: Page) => {
    const maskImages = await paintMaskRasters(snapshot.canvas, snapshot.layers, {
      page,
      supersample: 1,
    });
    return paintCompositionHtml(
      snapshot.canvas,
      guidelinePageHtml(snapshot.canvas, snapshot.layers, regions, maskImages),
      snapshot.layers,
      { page, beforeScreenshot: placeRegionCallouts },
    );
  };
  const { png } = await (options.page ? paint(options.page) : withRenderPage(paint));

  return withProjectLock(resolvedRoot, async () => {
    // One destination boundary for both the default and --out (PROD-1):
    // reserved Project inputs, existing in-Project state, directories, and
    // non-regular files are refused here and nowhere else.
    const target = options.out ?? (await defaultViewDestination(resolvedRoot, snapshot.name));
    const destination = await resolveExportTarget(resolvedRoot, target);

    // A recorded Render output — in the Project's renders/ history or
    // recorded by any manifest beside the target — is never overwritten
    // (fail-closed readers), checked under the same lock that publishes.
    const conflict =
      (await projectRenderOutputConflict(resolvedRoot, destination.path)) ??
      (await renderOutputConflict(destination.path));
    if (conflict) {
      throw new Error(
        `"${destination.path}" is a Render output — the manifest "${path.basename(conflict.manifest)}" records it, and ` +
          `the guideline view must never overwrite a final Render. Pick a different --out path.`,
      );
    }

    // Atomic publication, matching the render path's discipline (PROD-3):
    // fresh in-Project destinations lose loudly to a concurrent winner
    // (O_EXCL); external replacements swap the directory entry.
    if (destination.mode === "create") {
      await atomicCreate(destination.path, png);
    } else {
      await atomicReplace(destination.path, png);
    }

    return {
      composition: snapshot.name,
      canvas: snapshot.canvas,
      output: destination.path,
      regionFile: regionFilePath,
      regionCount: regions.length,
    };
  });
}