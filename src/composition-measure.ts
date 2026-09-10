/**
 * Read-only Composition layout measurement (#136, spec #132 US-002 / US-006,
 * DEC-001, DEC-003–004).
 *
 * One measuring authority: measurement renders the EXACT markup the paint
 * path builds (`buildCompositionHtml` — same retained font bytes under the
 * same internal @font-face families, same emitted rotate∘flip∘scale
 * transforms about (x, y), same canvas and text wrapping) into the shared
 * render page, applies the paint path's content-decode and font-resolution
 * rejection contract, and then reads each Layer element's geometry with the
 * browser's own measurement — never a second transform model, font source,
 * or markup builder. Because Layers are absolutely positioned, one Layer's
 * geometry never depends on the others; the full Composition is always
 * measured and a requested use merely filters the report.
 *
 * What each reported box means (documented, DEC-004 — layout ≠ painted):
 * - `content` — the Layer's untransformed content box along its own axes.
 *   Image Layers: the retained content's intrinsic size (the canonical
 *   revision facts verified at ingestion). Text Layers: the DOM line-box
 *   layout extent of the retained face at the revision's font size under
 *   the Composition's text wrapping — includes line-box leading; there is
 *   no stored intrinsic text size to consult.
 * - `corners` — the transformed content rectangle's four corners (top-left,
 *   top-right, bottom-right, bottom-left) in Composition coordinates,
 *   browser-measured through the revision's canonical transform.
 * - `box` — the axis-aligned bounding box of those corners: the layout
 *   footprint in Composition coordinates, UNCLIPPED (a Layer extending past
 *   the canvas reports its full geometry; canvas clipping is later work).
 * These are LAYOUT boxes, deliberately NOT painted extents: image boxes
 * include transparent padding, text boxes are line-box extents rather than
 * tight glyph ink, and effects/opacity are not reflected. Visible
 * alpha/glyph painted bounds belong to ticket #137.
 *
 * The query writes no Project state: the Composition, its current revisions,
 * and verified retained bytes are resolved exactly once through the
 * canonical full resolver under the Project lock (corrupt, missing, or
 * malformed retained state fails loudly there), then measured from that
 * in-memory snapshot. Resolution is fully local — no network, no billing.
 */
import { withRenderPage } from "./browser.js";
import { readCompositionInternalFull } from "./composition.js";
import { resolveProjectRoot } from "./project.js";
import { withProjectLock } from "./project-lock.js";
import { buildCompositionHtml, rejectUnresolvedFonts, type SnapshotLayer } from "./composition-paint.js";
import type { Page } from "playwright";

/** One Layer's measured layout geometry (module doc documents each box). */
export interface MeasuredLayerBounds {
  name: string;
  layerId: string;
  kind: "image" | "text";
  /** Untransformed content box along the content's own axes (px). */
  content: { width: number; height: number };
  /** Axis-aligned bounding box of the transformed content rectangle in Composition coordinates (px, unclipped). */
  box: { x: number; y: number; width: number; height: number };
  /** Transformed content rectangle corners, clockwise from top-left, in Composition coordinates (px). */
  corners: { x: number; y: number }[];
  /** The revision's placement facts, verbatim. */
  placement: { x: number; y: number; opacity: number };
  /** The revision's normalized canonical transform facts, verbatim. */
  transform: { scaleX: number; scaleY: number; rotationDeg: number; flipX: boolean; flipY: boolean };
}

export interface MeasureCompositionResult {
  composition: string;
  canvas: { width: number; height: number };
  layers: MeasuredLayerBounds[];
}

/**
 * Browser-side geometry probe, evaluated in the render page. Must stay
 * self-contained — Playwright serializes it. For each Layer element (DOM
 * order = reference-list order) it reads the untransformed content box by
 * temporarily clearing the inline transform (the measure page is throwaway
 * and never paints), then maps the content rectangle's corners through the
 * restored transform and reports its axis-aligned bounding box — all in
 * coordinates relative to the canvas origin, i.e. Composition coordinates.
 */
const MEASURE_PROBE = () => {
  const canvasEl = document.getElementById("canvas");
  if (!canvasEl) {
    throw new Error("measure probe: #canvas element missing");
  }
  const origin = canvasEl.getBoundingClientRect();
  return Array.from(canvasEl.children, (el) => {
    const saved = (el as HTMLElement).style.transform;
    const matrix = saved ? new DOMMatrixReadOnly(saved) : new DOMMatrixReadOnly();
    // Untransformed content box: transform removal never reflows other
    // Layers (they are absolutely positioned), so one element's measurement
    // cannot disturb another's.
    (el as HTMLElement).style.transform = "none";
    const plain = el.getBoundingClientRect();
    const content = { width: plain.width, height: plain.height };
    const lx = plain.left - origin.left;
    const ly = plain.top - origin.top;
    (el as HTMLElement).style.transform = saved;
    // The markup always sets transform-origin: 0 0, so the transform maps
    // local coordinates about the element's own top-left layout corner.
    const corner = (u: number, v: number) => {
      const p = matrix.transformPoint(new DOMPoint(u, v));
      return { x: lx + p.x, y: ly + p.y };
    };
    const corners = [
      corner(0, 0),
      corner(content.width, 0),
      corner(content.width, content.height),
      corner(0, content.height),
    ];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      content,
      corners,
      box: {
        x: minX,
        y: minY,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
      },
    };
  });
};

/** Report precision: CSS matrix arithmetic produces sub-0.01px noise; two decimals keep reports stable without hiding real geometry. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Measure the snapshot's exact bytes through the render page using the
 * paint path's markup and rejection contract. Mirrors `paintComposition`'s
 * page flow: viewport = canvas, same content, awaited image decode (a
 * corrupt image fails loudly instead of measuring a broken layout), the
 * same retained-font resolution gate, then the geometry probe.
 */
async function measureSnapshot(
  canvas: { width: number; height: number },
  layers: SnapshotLayer[],
  options: { page?: Page } = {},
): Promise<{ content: { width: number; height: number }; corners: { x: number; y: number }[]; box: { x: number; y: number; width: number; height: number } }[]> {
  const run = async (page: Page) => {
    await page.setViewportSize({ width: canvas.width, height: canvas.height });
    await page.setContent(buildCompositionHtml(canvas, layers), { waitUntil: "load" });
    // Awaited decode: a partially painted or broken image is never measured.
    await page.evaluate(() => Promise.all(Array.from(document.images, (img) => img.decode())));
    // The same retained-font gate as painting: an unresolved face is a
    // loud failure, never a fallback measurement.
    await rejectUnresolvedFonts(page, layers);
    return page.evaluate(MEASURE_PROBE);
  };
  return options.page ? run(options.page) : withRenderPage(run);
}

/**
 * Measure Layer layout bounds in Composition coordinates, read-only. See
 * the module contract for the reported boxes and their meaning. When
 * `useName` is given, only that use is reported — the full Composition is
 * still what gets measured, so a Layer's numbers are identical whether it
 * is reported alone or with its neighbors.
 */
export async function measureCompositionLayers(
  projectPath: string,
  compName: string,
  useName?: string,
  options: { page?: Page } = {},
): Promise<MeasureCompositionResult> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  // The snapshot is resolved under the Project lock exactly once, then the
  // lock is released before the browser measurement — the documented
  // read-snapshot pattern (`renderComposition`): measuring reads only the
  // in-memory snapshot and writes nothing, so no Project state is held
  // during the browser pass.
  const { comp, layers } = await withProjectLock(resolvedRoot, async () => {
    const comp = await readCompositionInternalFull(resolvedRoot, compName);
    const layers: SnapshotLayer[] = comp.layers.map((use) => ({
      name: use.name,
      layerId: use.layerId,
      revision: use.revision,
      contentBytes: use.contentBytes,
    }));
    return { comp, layers };
  });

  const measured = await measureSnapshot(comp.canvas, layers, options);

  const bounds: MeasuredLayerBounds[] = layers.map((l, i) => {
      const m = measured[i]!;
      const rev = l.revision;
      return {
        name: l.name,
        layerId: l.layerId,
        kind: rev.kind,
        // Image content size is the canonical verified revision fact; text
        // has no stored size — its measured line-box layout extent is the
        // only source, from the same face bytes painting uses.
        content:
          rev.kind === "image"
            ? { width: rev.width, height: rev.height }
            : { width: round2(m.content.width), height: round2(m.content.height) },
        box: {
          x: round2(m.box.x),
          y: round2(m.box.y),
          width: round2(m.box.width),
          height: round2(m.box.height),
        },
        corners: m.corners.map((c) => ({ x: round2(c.x), y: round2(c.y) })),
        placement: { x: rev.x, y: rev.y, opacity: rev.opacity },
        transform: {
          scaleX: rev.scaleX,
          scaleY: rev.scaleY,
          rotationDeg: rev.rotationDeg,
          flipX: rev.flipX,
          flipY: rev.flipY,
        },
      };
    });

  const selected = useName
    ? bounds.filter((b) => b.name === useName)
    : bounds;
  if (useName && selected.length === 0) {
    const names = bounds.map((b) => `"${b.name}"`).join(", ");
    throw new Error(
      `Use "${useName}" not found in composition "${comp.name}".` +
        (bounds.length > 0 ? ` Available uses: ${names}.` : " The Composition has no Layers."),
    );
  }

  return { composition: comp.name, canvas: comp.canvas, layers: selected };
}
