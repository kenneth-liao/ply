/**
 * Read-only Composition geometry measurement (#136/#137, spec #132 US-002 /
 * US-006, DEC-001, DEC-003–004).
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
 *   the canvas reports its full geometry).
 * - `painted` — the axis-aligned bounding box of the Layer's VISIBLE ink
 *   (alpha > 0) in Composition coordinates, UNCLIPPED: image alpha trimming
 *   excludes transparent padding from painted but not from content, and text
 *   painted bounds are tight glyph ink rather than the line-box extent.
 *   The ink pass renders the same paint-identical page, hides the other
 *   Layers (no reflow — they are absolutely positioned), screenshots the
 *   Layer alone through a bounded per-Layer capture window (shifted, never
 *   grown with the Layer's off-canvas distance), and reads its alpha
 *   support — so the numbers are the browser's own paint, never a second
 *   rasterizer. Values are reported through round2 (fractional): the ink
 *   support is quantized to the screenshot's pixel grid, but the canvas
 *   offsets are layout-derived and may be fractional. Layers without visible
 *   ink (fully transparent content, or opacity 0) report `painted: null`;
 *   opacity scaling changes alpha values, never the ink support (and a
 *   Layer's footprint is its own ink — occlusion by later Layers is
 *   stacking, not footprint). Painted extents are the alpha support of the
 *   browser's actual paint, so resampling (scale/rotation interpolation)
 *   may bleed ink roughly a pixel past the geometric ink boundary — that
 *   bleed is genuinely painted and the render shows it too. A Layer whose
 *   layout box exceeds the bounded capture window is refused loudly rather
 *   than measured with unbounded memory. A shadow (#139, ADR-0018) extends
 *   the ink beyond the layout box: the ink pass captures the same paint
 *   markup (so the shadow's ink IS part of `painted`), and the capture
 *   window is widened by the revision's canvas-space shadow reach (the
 *   local reach |dx| + |dy| + 2·blur, scaled by the transform's largest
 *   factor — the shadow paints before the transform), from the facts
 *   alone — a shadowed Layer's full extent is captured or
 *   the measurement is refused loudly, never silently clipped.
 * - `paintedOnCanvas` — `painted` ∩ the canvas rectangle: the footprint that
 *   actually shows in a render; `null` when empty (no visible ink, or ink
 *   entirely outside the canvas).
 * - `clipped` — whether painted ink falls outside the canvas, computed
 *   against the PAINTED extents, never the layout box (a mostly transparent
 *   image may have a layout box past the canvas while all of its ink stays
 *   visible).
 *
 * These remain LAYOUT-vs-PAINTED distinct by construction (DEC-004): `box`
 * is layout geometry, `painted` is ink geometry, both in Composition
 * coordinates through the same retained font bytes and the same emitted
 * transforms. The shadow effect is reflected in painted extents and in the
 * reported `effects` facts (#139, ADR-0018); outline (#140) and any wider
 * effect surface extend the same contract.
 *
 * The query writes no Project state: the Composition, its current revisions,
 * and verified retained bytes are resolved exactly once through the
 * canonical full resolver under the Project lock (corrupt, missing, or
 * malformed retained state fails loudly there), then measured from that
 * in-memory snapshot. Resolution is fully local — no network, no billing.
 */
import { withRenderPage } from "./browser.js";
import { readCompositionInternalFull } from "./composition.js";
import { readLayerInternalFull } from "./layer.js";
import { resolveProjectRoot } from "./project.js";
import { withProjectLock } from "./project-lock.js";
import { decodePng } from "./png.js";
import { buildCompositionHtml, rejectUnresolvedFonts, type SnapshotLayer } from "./composition-paint.js";
import type { ResolvedLayerRevision, LayerShadow } from "./layer.js";
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
  /** Axis-aligned bounding box of the Layer's visible ink (alpha > 0) in Composition coordinates (px, unclipped, quantized to the screenshot's pixel grid; offsets are layout-derived and may be fractional); null when nothing is visible. */
  painted: { x: number; y: number; width: number; height: number } | null;
  /** The painted extent's intersection with the canvas rectangle — the footprint that shows in a render; null when empty. */
  paintedOnCanvas: { x: number; y: number; width: number; height: number } | null;
  /** Whether painted ink falls outside the canvas, judged against the painted extents (never the layout box). */
  clipped: boolean;
  /** The revision's placement facts, verbatim. */
  placement: { x: number; y: number; opacity: number };
  /** The revision's normalized canonical transform facts, verbatim. */
  transform: { scaleX: number; scaleY: number; rotationDeg: number; flipX: boolean; flipY: boolean };
  /** The revision's effective effect facts (#139): `shadow` is the stored
   * shadow parameters (or null when the Layer has none) — the same facts
   * painting applies, reported for auditability. */
  effects: { shadow: LayerShadow | null };
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
 * Safety pad (px) added around each Layer box when sizing its ink-capture
 * window: glyph ink may overhang its line box by a pixel or two (italic
 * faces), so the captured region must not end exactly at the box.
 */
const INK_PAD_PX = 16;

/**
 * Single-dimension cap (px) for the per-Layer ink-capture window (review
 * INT-1/PROD-1): a layout box needing more is refused loudly instead of
 * growing a viewport without bound. 8192 keeps one window screenshot at
 * most ~256MB of RGBA — bounded, and far above any on-canvas ink a
 * Composition-scale Layer produces.
 */
const MAX_INK_VIEWPORT_PX = 8192;

/** Standalone measurement canvas edge (px): large enough that a text Layer's
 * pre-wrap shrink-to-fit line cannot wrap inside it (the containing block
 * width caps the line), while staying inside the bounded ink-capture window
 * with its pad. Used only by `measureStandaloneLayer` (#138). */
const STANDALONE_CANVAS_PX = MAX_INK_VIEWPORT_PX - 2 * INK_PAD_PX;

type Box = { x: number; y: number; width: number; height: number };

/**
 * The px a Layer's shadow may extend its ink beyond the layout box, in every
 * canvas direction (#139, ADR-0018). The shadow paints in the Layer's LOCAL
 * space — before the canonical transform — so its LOCAL reach (|dx| + |dy| +
 * 2·blur, the margin over the CSS blur radius's ~1.5× visible extent) maps
 * through the transform: rotation preserves lengths, and the AABB of a
 * transformed reach ball is bounded by its largest semi-axis, so the
 * canvas-space reach is the local reach × max(scaleX, scaleY), derived from
 * the revision facts alone (deterministic, never rendering-consulted).
 */
function shadowReachPx(revision: ResolvedLayerRevision): number {
  if (!revision.shadow) return 0;
  const local = Math.abs(revision.shadow.dx) + Math.abs(revision.shadow.dy) + 2 * revision.shadow.blur;
  return local * Math.max(revision.scaleX, revision.scaleY);
}

/** Round every component of an optional box for reporting. */
function roundBox(box: Box | null): Box | null {
  return box ? { x: round2(box.x), y: round2(box.y), width: round2(box.width), height: round2(box.height) } : null;
}

/** Intersection of a box with the canvas rectangle; null when empty. */
function clipToCanvas(box: Box, canvas: { width: number; height: number }): Box | null {
  const x1 = Math.max(box.x, 0);
  const y1 = Math.max(box.y, 0);
  const x2 = Math.min(box.x + box.width, canvas.width);
  const y2 = Math.min(box.y + box.height, canvas.height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null;
}

/** Bounding box of every alpha > 0 pixel, mapped from page coordinates into Composition coordinates. */
function inkBounds(png: { width: number; height: number; rgba: Uint8Array }, offsetX: number, offsetY: number): Box | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (png.rgba[(y * png.width + x) * 4 + 3]! > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return minX === Infinity ? null : { x: minX - offsetX, y: minY - offsetY, width: maxX - minX + 1, height: maxY - minY + 1 };
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
): Promise<{ content: { width: number; height: number }; corners: { x: number; y: number }[]; box: Box; painted: Box | null }[]> {
  const run = async (page: Page) => {
    await page.setViewportSize({ width: canvas.width, height: canvas.height });
    await page.setContent(buildCompositionHtml(canvas, layers), { waitUntil: "load" });
    // Awaited decode: a partially painted or broken image is never measured.
    await page.evaluate(() => Promise.all(Array.from(document.images, (img) => img.decode())));
    // The same retained-font gate as painting: an unresolved face is a
    // loud failure, never a fallback measurement.
    await rejectUnresolvedFonts(page, layers);
    const measured = await page.evaluate(MEASURE_PROBE);

    // Painted-ink pass (#137): the same page that just measured layout —
    // the paint path's exact markup, the same decode and font gates — is
    // screenshotted once per Layer with the others hidden (they are
    // absolutely positioned, so hiding changes no geometry, and the page
    // is throwaway). The canvas overflow is released, so ink beyond the
    // canvas can be captured and the canvas intersection reported against
    // the PAINTED extents, never the layout box.
    //
    // Bounded capture (review INT-1/PROD-1): the capture window is sized
    // for the largest single Layer box plus the pad — never the union of
    // all off-canvas extents — and the canvas is SHIFTED per Layer so its
    // box sits inside the window. A placement far off-canvas costs a
    // window shift, not viewport growth; a box beyond the cap is refused
    // loudly, because a read-only query must fail safely, never grow
    // memory without bound. Cost ceiling: O(Layers × capture-window
    // area) — one screenshot plus one pixel scan per Layer.
    //
    // Shadow reach (#139, ADR-0018): a Layer's shadow extends its ink
    // beyond the layout box by up to its LOCAL reach (|dx| + |dy| + 2·blur
    // px) MAPPED THROUGH the canonical transform — the shadow paints before
    // the transform, so the canvas-space reach is the local reach scaled by
    // max(scaleX, scaleY) (rotation preserves lengths; the transformed
    // reach ball's AABB is bounded by its largest semi-axis). The reach is
    // derived from the revision facts — deterministic, no rendering
    // consulted — and widened into the window sizing and the loud-refusal
    // cap, so a shadowed Layer's full painted extent is captured or
    // refused, never clipped into a smaller report.
    let painted: (Box | null)[] = [];
    if (measured.length > 0) {
      const boxes = measured.map((m) => m.box);
      const reaches = layers.map((l) => shadowReachPx(l.revision));
      const widest = Math.max(...boxes.map((b, i) => b.width + 2 * reaches[i]!));
      const tallest = Math.max(...boxes.map((b, i) => b.height + 2 * reaches[i]!));
      if (
        widest + 2 * INK_PAD_PX > MAX_INK_VIEWPORT_PX ||
        tallest + 2 * INK_PAD_PX > MAX_INK_VIEWPORT_PX
      ) {
        const bad = boxes.findIndex(
          (b, i) => b.width + 2 * reaches[i]! + 2 * INK_PAD_PX > MAX_INK_VIEWPORT_PX ||
            b.height + 2 * reaches[i]! + 2 * INK_PAD_PX > MAX_INK_VIEWPORT_PX,
        );
        const reach = reaches[bad]!;
        throw new Error(
          `Layer "${layers[bad]!.name}" has a layout box ${Math.ceil(boxes[bad]!.width)}×${Math.ceil(boxes[bad]!.height)}px` +
            (reach > 0 ? ` plus up to ${reach}px of shadow extent` : "") +
            `, beyond the ${MAX_INK_VIEWPORT_PX}×${MAX_INK_VIEWPORT_PX}px painted-extent capture window. Painted extents are refused ` +
            `instead of growing measurement memory without bound — reduce the transform scale, the shadow extent, or place the Layer nearer the canvas.`,
        );
      }
      const captureW = Math.max(1, Math.ceil(widest + 2 * INK_PAD_PX));
      const captureH = Math.max(1, Math.ceil(tallest + 2 * INK_PAD_PX));
      await page.setViewportSize({ width: captureW, height: captureH });
      for (let i = 0; i < measured.length; i++) {
        const b = boxes[i]!;
        // Window shift: position the canvas (and its absolutely positioned
        // children, so this Layer's box) inside the fixed capture window,
        // centered with the pad on every side (rounded to whole pixels — a
        // fractional shift would re-render the Layer at a subpixel offset
        // and bleed its raster). Feasible because the cap check above
        // bounds every box.
        const left = Math.round(captureW / 2 - (b.x + b.width / 2));
        const top = Math.round(captureH / 2 - (b.y + b.height / 2));
        await page.evaluate(
          ({ left, top }) => {
            const canvasEl = document.getElementById("canvas") as HTMLElement;
            canvasEl.style.overflow = "visible";
            canvasEl.style.left = `${left}px`;
            canvasEl.style.top = `${top}px`;
          },
          { left, top },
        );
        await page.evaluate((idx) => {
          const kids = Array.from((document.getElementById("canvas") as HTMLElement).children) as HTMLElement[];
          kids.forEach((el, j) => {
            el.style.visibility = j === idx ? "" : "hidden";
          });
        }, i);
        const shot = await page.screenshot({ type: "png", omitBackground: true });
        painted.push(inkBounds(decodePng(Buffer.from(shot)), left, top));
      }
    }

    return measured.map((m, i) => ({ ...m, painted: painted[i] ?? null }));
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
      // One home for the reported painted box: clipping and the canvas
      // intersection are derived from the same rounded values the report
      // carries, so a consumer recomputing them from the JSON can never
      // disagree with the reported `clipped`.
      const painted = m.painted ? roundBox(m.painted) : null;
      const paintedOnCanvas = painted ? roundBox(clipToCanvas(painted, comp.canvas)) : null;
      const clipped =
        painted !== null &&
        (painted.x < 0 ||
          painted.y < 0 ||
          painted.x + painted.width > comp.canvas.width ||
          painted.y + painted.height > comp.canvas.height);
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
        painted,
        paintedOnCanvas,
        clipped,
        corners: m.corners.map((c) => ({ x: round2(c.x), y: round2(c.y) })),
        placement: { x: rev.x, y: rev.y, opacity: rev.opacity },
        transform: {
          scaleX: rev.scaleX,
          scaleY: rev.scaleY,
          rotationDeg: rev.rotationDeg,
          flipX: rev.flipX,
          flipY: rev.flipY,
        },
        effects: { shadow: rev.shadow ?? null },
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

/**
 * Measure one Layer standalone — outside any Composition, at placement
 * (0, 0) on an effectively unwrapped canvas (#138). The read-snapshot
 * pattern is unchanged: the Layer's current revision and verified bytes are
 * resolved once under the Project lock, then measured from that snapshot;
 * nothing is written. The painted box of the (0, 0) copy IS the ink's
 * offset from the placement point, which is what anchored placement
 * (#138) needs for a Layer with no referring Composition.
 *
 * Documented semantics: the standalone line does not wrap (the canvas
 * exceeds any line a Composition could give the Layer while staying inside
 * the bounded ink-capture window), so an unreferenced text Layer resolves
 * against its unwrapped ink; once the Layer is added to a Composition,
 * anchoring there re-resolves against that Composition's wrapping. A Layer
 * whose layout box exceeds the bounded capture window is refused loudly,
 * exactly as in Composition measurement.
 */
export async function measureStandaloneLayer(
  projectPath: string,
  layerId: string,
  options: { page?: Page } = {},
): Promise<{ painted: Box | null; box: Box; content: { width: number; height: number } }> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  const { currentRevision, contentBytes } = await withProjectLock(resolvedRoot, () =>
    readLayerInternalFull(resolvedRoot, layerId),
  );
  const standalone: SnapshotLayer = {
    name: layerId,
    layerId,
    revision: { ...currentRevision, x: 0, y: 0 },
    contentBytes,
  };
  const canvas = { width: STANDALONE_CANVAS_PX, height: STANDALONE_CANVAS_PX };
  const [measured] = await measureSnapshot(canvas, [standalone], options);
  if (!measured) {
    throw new Error(`Standalone measurement of Layer "${layerId}" produced no geometry.`);
  }
  return {
    painted: measured.painted ? roundBox(measured.painted) : null,
    box: {
      x: round2(measured.box.x),
      y: round2(measured.box.y),
      width: round2(measured.box.width),
      height: round2(measured.box.height),
    },
    content: {
      width:
        currentRevision.kind === "image"
          ? currentRevision.width
          : round2(measured.content.width),
      height:
        currentRevision.kind === "image"
          ? currentRevision.height
          : round2(measured.content.height),
    },
  };
}
