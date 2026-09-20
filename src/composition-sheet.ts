/**
 * The comparison sheet (spec #226 US-006, DEC-007/008/009, TEST-008): one
 * command lays out an ordered list of inputs — Composition names (rendered
 * current), retained Render manifests, and local image files — as one
 * labelled PNG grid, with a pairing mode for reference-beside-result rows.
 *
 * It is a review artifact like the guideline view (#174), not a Render: it
 * writes no Render manifest and adds nothing to retained Render history,
 * and it publishes through the render path's ONE export-target boundary —
 * reserved Project inputs, existing in-Project state, directories, and
 * non-regular files are refused there and nowhere else — checked against
 * recorded Render outputs under the same Project lock that publishes, with
 * the render path's atomic publication. A recorded Render output is never
 * overwritten, so a sheet can never present review pixels as an accepted
 * Render. The default destination is a fresh, never-colliding file under
 * the Project's guidelines/ review-output directory (ignorable, never
 * Project state).
 *
 * No second rendering authority (DEC-007): Composition inputs are rendered
 * through the existing render path — `resolveCompositionSnapshot` plus
 * `paintComposition`, the exact pass `composition render` paints. Retained
 * Render manifest inputs resolve through the replay path's own machinery —
 * `readRenderManifest`, `resolveHistoricalLayers` under the Project lock,
 * painted at the manifest's recorded canvas and supersample factor, with
 * the same environment-match gate replay applies — minus every history
 * publication. The sheet grid itself is assembled locally (DEC-007's
 * delivery choice): the cell PNGs are embedded as data URLs and laid out in
 * one static page painted on the shared render page — no network, no
 * inference weights, no model calls.
 *
 * Local image inputs are the formats the tool already reads: PNG, JPEG, and
 * WebP headers through src/raster-meta.ts, and SVG intrinsic sizes through
 * src/svg-meta.ts — the same two readers image ingestion uses, never a new
 * decoder, with the same dimension caps and the same #214 inertness gate on
 * SVG bytes (`scanSvgExternalReferences`), so an SVG cell can never fetch a
 * reference during the paint. Header facts are checked before the browser
 * pass, so an undecodable input is refused naming it before anything runs; a
 * file whose header passes but whose body cannot decode is caught by the
 * awaited decode gate before the screenshot, also naming the input.
 *
 * Every fallible step — input classification, snapshot and history
 * resolution, per-cell paints, geometry caps — precedes output publication:
 * a refused input writes nothing.
 */
import { lstat, mkdir, readFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Page } from "playwright";
import { MAX_DIMENSION, MAX_PIXELS, MAX_ENCODED_BYTES } from "./png.js";
import { escapeHtml, paintComposition } from "./composition-paint.js";
import {
  assertRenderableCanvas,
  assertSupersampledPaintSize,
  resolveCompositionSnapshot,
  resolveExportTarget,
} from "./composition-render.js";
import {
  readRenderManifest,
  requireProjectRenderManifest,
  resolveHistoricalLayers,
  verifyEnvironmentMatch,
  projectRenderOutputConflict,
} from "./render-history.js";
import { readRasterMeta, sniffRasterFormat } from "./raster-meta.js";
import { readSvgMeta } from "./svg-meta.js";
import { scanSvgExternalReferences } from "./svg-inertness.js";
import { renderOutputConflict } from "./manifest.js";
import { atomicCreate, atomicReplace, withProjectLock } from "./project-lock.js";
import { resolveProjectRoot } from "./project.js";
import { withRenderPage } from "./browser.js";

/**
 * The sheet's geometry constants — the one home for the numbers the layout,
 * the page builder, and the tests share (never a second copy).
 */
/** Outer padding, every side. */
export const SHEET_PAD = 8;
/** Gap between neighbouring cells (rows and columns). */
export const SHEET_GUTTER = 8;
/** Label strip under each cell, gap included. */
export const SHEET_LABEL_STRIP = 28;
/** Gap between a cell's bottom edge and its label's ink area. */
export const SHEET_LABEL_GAP = 4;
/** Default grid width in cells. */
export const DEFAULT_SHEET_COLUMNS = 2;
/** Default cell box side in px (square cells). */
export const DEFAULT_SHEET_CELL = 512;

export interface SheetGeometry {
  columns: number;
  rows: number;
  /** The output PNG's exact dimensions. */
  width: number;
  height: number;
  cell: number;
}

/**
 * The sheet's deterministic geometry: `count` cells in `columns` columns of
 * square `cell`-px boxes, each with a label strip under it. The output
 * dimensions and every cell/label rectangle are pure functions of
 * (columns, cell, count) — TEST-008 asserts output pixels from these
 * rectangles.
 */
export function sheetGeometry(columns: number, cell: number, count: number): SheetGeometry {
  if (!Number.isInteger(columns) || columns < 1) {
    throw new Error(`Sheet columns must be an integer of at least 1 (got ${columns}).`);
  }
  if (!Number.isInteger(cell) || cell < 1) {
    throw new Error(`Sheet cell size must be an integer of at least 1 (got ${cell}).`);
  }
  if (cell > MAX_DIMENSION) {
    throw new Error(`Sheet cell size ${cell}px exceeds the ${MAX_DIMENSION}px per-axis render limit.`);
  }
  const rows = Math.max(1, Math.ceil(count / columns));
  const width = SHEET_PAD * 2 + columns * cell + (columns - 1) * SHEET_GUTTER;
  const height = SHEET_PAD * 2 + rows * (cell + SHEET_LABEL_STRIP) + (rows - 1) * SHEET_GUTTER;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(
      `A ${columns}-column sheet of ${cell}px cells needs ${width}×${height}px — over the ` +
        `${MAX_DIMENSION}px per-axis render limit. Use a smaller --cell, fewer --columns, or fewer inputs.`,
    );
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(
      `A ${columns}-column sheet of ${cell}px cells is ${width}×${height} — over the ` +
        `${MAX_PIXELS.toLocaleString("en-US")}-pixel render limit. Use a smaller --cell, fewer ` +
        `--columns, or fewer inputs.`,
    );
  }
  return { columns, rows, width, height, cell };
}

/** One cell's content box in the output image, in paint order (row-major). */
export function sheetCellRect(
  g: SheetGeometry,
  index: number,
): { x: number; y: number; width: number; height: number } {
  const col = index % g.columns;
  const row = Math.floor(index / g.columns);
  return {
    x: SHEET_PAD + col * (g.cell + SHEET_GUTTER),
    y: SHEET_PAD + row * (g.cell + SHEET_LABEL_STRIP + SHEET_GUTTER),
    width: g.cell,
    height: g.cell,
  };
}

/** One cell's label box, under its cell (sheetLabelRect(g, i) pairs with sheetCellRect(g, i)). */
export function sheetLabelRect(
  g: SheetGeometry,
  index: number,
): { x: number; y: number; width: number; height: number } {
  const cell = sheetCellRect(g, index);
  return { x: cell.x, y: cell.y + cell.height + SHEET_LABEL_GAP, width: cell.width, height: SHEET_LABEL_STRIP - SHEET_LABEL_GAP };
}

export interface SheetEntry {
  /** A data: URL for the cell's pixels (never a network reference). */
  src: string;
  /** The caller-visible label, already caller-supplied or defaulted. */
  label: string;
}

/**
 * The sheet page: one fixed cell per input (flex-centred `img` fitted with
 * max-width/max-height — aspect preserved, never distorted, whatever the
 * input's aspect ratio), a label strip under each cell, and an opaque white
 * backing so transparent render content is reviewable. Labels are
 * HTML-escaped; image sources are data URLs only, so the page makes no
 * network request by construction.
 */
export function buildSheetPageHtml(g: SheetGeometry, entries: { src: string; label: string }[]): string {
  const cells = entries
    .map((e, i) => {
      const c = sheetCellRect(g, i);
      const label = sheetLabelRect(g, i);
      return (
        `<div class="ply-sheet-cell" style="left:${c.x}px;top:${c.y}px;width:${c.width}px;height:${c.height}px;">` +
        `<img id="ply-sheet-img-${i}" src="${e.src}"></div>` +
        `<div class="ply-sheet-label" style="left:${label.x}px;top:${label.y}px;width:${label.width}px;height:${label.height}px;">` +
        `${escapeHtml(e.label)}</div>`
      );
    })
    .join("");
  return (
    `<!doctype html><html><head><style>` +
    `html,body{margin:0;padding:0;background:#ffffff}` +
    `.ply-sheet{position:relative;width:${g.width}px;height:${g.height}px;background:#ffffff}` +
    `.ply-sheet-cell{position:absolute;display:flex;align-items:center;justify-content:center;}` +
    `.ply-sheet-cell img{max-width:100%;max-height:100%;display:block;}` +
    `.ply-sheet-label{position:absolute;font:13px/17px sans-serif;color:#111111;text-align:center;overflow:hidden;}` +
    `</style></head>` +
    `<body><div class="ply-sheet">${cells}</div></body></html>`
  );
}

const IMAGE_MIME: Record<"png" | "jpeg" | "webp" | "svg", string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** A file input's default label: its own file name, extension dropped. */
function fileLabel(input: string): string {
  return path.basename(path.resolve(input), path.extname(input));
}

/**
 * The ingestion caps a file cell must pass before its bytes are embedded —
 * the same per-axis and pixel-count limits image ingestion applies (the one
 * constants from the PNG reader), so a cell cannot ask the browser to decode
 * more pixels than the tool would ever retain.
 */
function refuseOversizedImage(
  meta: { width: number; height: number },
  input: string,
): void {
  if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) {
    throw new Error(
      `Sheet input "${input}" declares a ${meta.width}×${meta.height} canvas — over the ` +
        `${MAX_DIMENSION}px per-axis render limit.`,
    );
  }
  if (meta.width * meta.height > MAX_PIXELS) {
    throw new Error(
      `Sheet input "${input}" declares ${meta.width}×${meta.height} — over the ` +
        `${MAX_PIXELS.toLocaleString("en-US")}-pixel render limit.`,
    );
  }
}

export interface ComparisonSheetResult {
  /** The written sheet PNG path (absolute). */
  output: string;
  width: number;
  height: number;
  columns: number;
  cell: number;
  paired: boolean;
  inputs: { index: number; kind: "composition" | "manifest" | "file"; label: string; source: string }[];
}

export interface ComparisonSheetOptions {
  /** Caller-owned page (tests: route-aborted offline evidence); never closed. */
  page?: Page;
  /** Caller-chosen review-artifact path, resolved through the render path's
   *  export-target boundary; defaults to a fresh, never-colliding file under
   *  the Project's guidelines/. */
  out?: string;
  /** Grid width in cells (default 2). */
  columns?: number;
  /** Square cell size in px (default 512). */
  cell?: number;
  /** Pairing mode: inputs are reference,result pairs, one pair per row. */
  pair?: boolean;
  /** Label overrides, CLI form: "1-based index=label text" (repeatable). */
  labels?: string[];
}

/** Parse --label overrides: 1-based indices within the input count, unique.
 *  Exported so the CLI shapes the syntax as a usage error (exit 2) at its
 *  boundary; the module re-runs the same parse as its API-boundary fail-fast. */
export function parseLabelOverrides(specs: string[] | undefined, count: number): Map<number, string> {
  const overrides = new Map<number, string>();
  for (const spec of specs ?? []) {
    const match = /^(\d+)=(.*)$/s.exec(spec);
    if (!match) {
      throw new Error(
        `Invalid label override "${spec}": use --label <1-based input index>=<label text> ` +
          `(for example --label 2="reference thumb").`,
      );
    }
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 1 || index > count) {
      throw new Error(`Label override "${spec}" names input ${index}, but the sheet has ${count} input(s).`);
    }
    if (overrides.has(index)) {
      throw new Error(`Label override for input ${index} was given more than once.`);
    }
    overrides.set(index, match[2]!);
  }
  return overrides;
}

/**
 * A fresh, never-colliding default sheet destination under the Project's
 * guidelines/ review-output directory — the same fresh-name discipline as
 * the render path's default destination, so re-running the sheet never
 * overwrites the artifact a reviewer may still be looking at. Callers hold
 * the Project lock.
 */
async function defaultSheetDestination(resolvedRoot: string): Promise<string> {
  const dir = path.join(resolvedRoot, "guidelines");
  await mkdir(dir, { recursive: true });
  for (;;) {
    const candidate = path.join(dir, `sheet-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.png`);
    try {
      await lstat(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw err;
    }
  }
}

/**
 * Build the comparison sheet: resolve every input (all fallible work), paint
 * the grid, and publish the PNG — a review artifact with the guideline
 * view's exact destination discipline. See the module contract above.
 */
export async function renderComparisonSheet(
  projectPath: string,
  inputs: string[],
  options: ComparisonSheetOptions = {},
): Promise<ComparisonSheetResult> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  if (inputs.length === 0) {
    throw new Error("A comparison sheet needs at least one input.");
  }
  const pair = options.pair ?? false;
  const columns = pair ? 2 : (options.columns ?? DEFAULT_SHEET_COLUMNS);
  const cell = options.cell ?? DEFAULT_SHEET_CELL;
  if (options.columns !== undefined && pair) {
    throw new Error("--pair defines the layout itself (one reference beside one result per row); it cannot be combined with --columns.");
  }
  if (pair && inputs.length % 2 !== 0) {
    throw new Error(
      `Pairing mode needs an even number of inputs laid as reference-beside-result rows, ` +
        `but ${inputs.length} inputs were given. Reorder the list so each reference is immediately ` +
        `followed by its result, and drop or add one input.`,
    );
  }
  const overrides = parseLabelOverrides(options.labels, inputs.length);
  const geometry = sheetGeometry(columns, cell, inputs.length);

  // Cheap before expensive: every input is classified and resolved before any
  // browser pass, and every refusal names its input. Composition snapshots
  // and manifest history resolve under the Project lock (the render path's
  // own resolvers); the paints run outside it.
  interface PendingPaint {
    cellIndex: number;
    png: Promise<Buffer>;
  }
  const cells: { src: string; label: string }[] = [];
  const pendingPaints: PendingPaint[] = [];
  const sourceFacts: ComparisonSheetResult["inputs"] = [];

  for (const [cellIndex, input] of inputs.entries()) {
    const target = path.resolve(input);
    // stat() (not lstat): a symlink to an image is an image — the same
    // followed-link reading every other local-file input takes. A missing
    // or non-regular target means the token must be a Composition name.
    let st;
    try {
      st = await stat(target);
    } catch {
      st = undefined;
    }
    if (st === undefined || !st.isFile()) {
      // Not an existing regular file → the token must be a Composition name,
      // rendered current through the existing render path (no second
      // rendering authority, DEC-007).
      const snapshot = await resolveCompositionSnapshot(resolvedRoot, input).catch((err: Error) => {
        throw new Error(`Sheet input "${input}": ${err.message}`);
      });
      // The render path's default quality: the same supersampled paint
      // `composition render` performs (its factor cap is checked here too).
      assertSupersampledPaintSize(snapshot.canvas, 2, snapshot.name);
      pendingPaints.push({
        cellIndex,
        png: paintComposition(snapshot.canvas, snapshot.layers, { page: options.page, supersample: 2 }).then((r) => r.png),
      });
      sourceFacts[cellIndex] = { index: cellIndex + 1, kind: "composition", label: input, source: input };
      cells[cellIndex] = { src: "", label: input };
      continue;
    }

    // An existing file: read its bytes once and classify by content — raster
    // header, SVG facts, or a retained Render manifest.
    if (st.size > MAX_ENCODED_BYTES) {
      throw new Error(
        `Sheet input "${input}" is ${(st.size / (1024 * 1024)).toFixed(1)} MB — over the ` +
          `${(MAX_ENCODED_BYTES / (1024 * 1024))} MB input cap.`,
      );
    }
    const bytes = await readFile(target).catch((err: Error) => {
      throw new Error(`Sheet input "${input}" cannot be read: ${err.message}`);
    });
    const raster = sniffRasterFormat(bytes);
    if (raster) {
      const meta = readRasterMeta(bytes, input);
      if (typeof meta === "string") {
        throw new Error(`Sheet input "${input}" is not a decodable image: ${meta}`);
      }
      refuseOversizedImage(meta, input);
      cells[cellIndex] = { src: `data:${IMAGE_MIME[meta.format]};base64,${bytes.toString("base64")}`, label: fileLabel(input) };
      sourceFacts[cellIndex] = { index: cellIndex + 1, kind: "file", label: fileLabel(input), source: input };
      continue;
    }
    const svg = readSvgMeta(bytes, input);
    if (typeof svg !== "string") {
      refuseOversizedImage(svg, input);
      // The #214 inertness gate, the one image ingestion applies: an SVG cell
      // rides to the browser as a data URL, and an external reference would
      // violate the sheet's offline contract — refused naming the reference.
      const inertnessRefusal = scanSvgExternalReferences(bytes, input);
      if (inertnessRefusal !== undefined) {
        throw new Error(`Sheet input "${input}" references content outside itself — ${inertnessRefusal}`);
      }
      cells[cellIndex] = { src: `data:${IMAGE_MIME.svg};base64,${bytes.toString("base64")}`, label: fileLabel(input) };
      sourceFacts[cellIndex] = { index: cellIndex + 1, kind: "file", label: fileLabel(input), source: input };
      continue;
    }
    // Not a decodable image: the bytes must be a retained Render manifest,
    // resolved through the exact passes replay uses (minus publication). Both
    // attempts are reported, so an SVG-shaped file that is not a manifest
    // keeps its real reason instead of a confusing manifest-only message.
    const svgReason = svg;
    await requireProjectRenderManifest(resolvedRoot, target).catch((err: Error) => {
      throw new Error(
        `Sheet input "${input}" is not a decodable image (${svgReason}) and not a usable Render manifest: ${err.message}`,
      );
    });
    const manifest = await readRenderManifest(target).catch((err: Error) => {
      throw new Error(
        `Sheet input "${input}" is not a decodable image (${svgReason}) and not a usable Render manifest: ${err.message}`,
      );
    });
    assertRenderableCanvas(manifest.canvas, manifest.composition);
    assertSupersampledPaintSize(manifest.canvas, manifest.supersample, manifest.composition);
    const layers = await withProjectLock(resolvedRoot, () => resolveHistoricalLayers(resolvedRoot, manifest));
    pendingPaints.push({
      cellIndex,
      // Manifest history paints exactly as replay repaints it — same canvas,
      // same recorded factor — then the same environment gate applies, named
      // for the input that failed it.
      png: paintComposition(manifest.canvas, layers, { page: options.page, supersample: manifest.supersample }).then(
        ({ png: painted, environment }) => {
          try {
            verifyEnvironmentMatch(manifest.environment, environment);
          } catch (err) {
            throw new Error(`Sheet input "${input}": ${(err as Error).message}`);
          }
          return painted;
        },
      ),
    });
    sourceFacts[cellIndex] = { index: cellIndex + 1, kind: "manifest", label: manifest.composition, source: input };
    cells[cellIndex] = { src: "", label: manifest.composition };
  }

  // All inputs resolved: paint the composition/manifest cells, then embed.
  for (const pending of pendingPaints) {
    cells[pending.cellIndex]!.src = `data:image/png;base64,${(await pending.png).toString("base64")}`;
  }
  for (const [i, entry] of cells.entries()) {
    const overridden = overrides.get(i + 1);
    entry.label = overridden ?? entry.label;
    if (overridden !== undefined) sourceFacts[i]!.label = overridden;
  }

  // One paint pass on the shared render page: the awaited decode gate refuses
  // an input whose bytes passed header checks but cannot actually decode,
  // naming the input, before any screenshot exists.
  const png = await paintSheetPage(geometry, cells, options.page, inputs);

  return withProjectLock(resolvedRoot, async () => {
    // One destination boundary for both the default and --out, exactly like
    // the guideline view: reserved Project inputs, existing in-Project state,
    // directories, and non-regular files are refused here and nowhere else.
    const target = options.out ?? (await defaultSheetDestination(resolvedRoot));
    const destination = await resolveExportTarget(resolvedRoot, target);

    // A recorded Render output — in the Project's renders/ history or
    // recorded by any manifest beside the target — is never overwritten,
    // checked under the same lock that publishes.
    const conflict =
      (await projectRenderOutputConflict(resolvedRoot, destination.path)) ??
      (await renderOutputConflict(destination.path));
    if (conflict) {
      throw new Error(
        `"${destination.path}" is a Render output — the manifest "${path.basename(conflict.manifest)}" records it, and ` +
          `the comparison sheet must never overwrite a final Render. Pick a different --out path.`,
      );
    }

    if (destination.mode === "create") {
      await atomicCreate(destination.path, png);
    } else {
      await atomicReplace(destination.path, png);
    }

    return {
      output: destination.path,
      width: geometry.width,
      height: geometry.height,
      columns: geometry.columns,
      cell: geometry.cell,
      paired: pair,
      inputs: sourceFacts,
    };
  });
}

/** Paint the sheet page; `options.page` is the tests' offline evidence seam. */
async function paintSheetPage(
  g: SheetGeometry,
  entries: { src: string; label: string }[],
  pageOption: Page | undefined,
  sourceNames: string[],
): Promise<Buffer> {
  const paint = async (page: Page): Promise<Buffer> => {
    await page.setViewportSize({ width: g.width, height: g.height });
    // Data URLs only: every SVG byte rode the #214 inertness gate at
    // resolution, so the page makes no network request by construction.
    await page.setContent(buildSheetPageHtml(g, entries), { waitUntil: "load" });
    // Awaited decode for every embedded image, mapped back to the caller's
    // input names: a body that cannot decode refuses the sheet before any
    // screenshot exists, and nothing is written.
    const failedIndices = (await page.evaluate(() =>
      Promise.all(
        Array.from(document.images, async (img) => {
          try {
            await img.decode();
            return null;
          } catch {
            return Number(img.id.replace("ply-sheet-img-", ""));
          }
        }),
      ),
    )) as (number | null)[];
    const broken = failedIndices
      .filter((i): i is number => i !== null)
      .map((i) => sourceNames[i] ?? `cell ${i}`);
    if (broken.length > 0) {
      throw new Error(
        `Sheet input(s) ${broken.map((n) => `"${n}"`).join(", ")} could not be decoded as images ` +
          `(the file's header looked plausible, but the body does not decode) — nothing was written.`,
      );
    }
    const png = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: g.width, height: g.height },
      timeout: 60000,
    });
    return Buffer.from(png);
  };
  return pageOption ? paint(pageOption) : withRenderPage(paint);
}