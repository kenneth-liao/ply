/**
 * The comparison sheet (spec #226 US-006, DEC-007/008/009, TEST-008; #292
 * extends the inputs and loosens the Project requirement): one command lays
 * out an ordered list of inputs — Composition names (rendered current),
 * retained Render manifests, and local image files, including Generation Job
 * outputs, which are labelled '<job id> #<output index>' from their record —
 * as one labelled PNG grid, with a pairing mode for reference-beside-result
 * rows.
 *
 * It is a review artifact like the guideline view (#174), not a Render: it
 * writes no Render manifest and adds nothing to retained Render history.
 * With a Project involved it publishes through the render path's ONE
 * export-target boundary — reserved Project inputs, existing in-Project
 * state, directories, and non-regular files are refused there and nowhere
 * else — checked against recorded Render outputs under the same Project lock
 * that publishes, with the render path's atomic publication. A recorded
 * Render output is never overwritten, so a sheet can never present review
 * pixels as an accepted Render. The default destination is a fresh,
 * never-colliding file under the Project's guidelines/ review-output
 * directory (ignorable, never Project state).
 *
 * A sheet whose inputs are ALL local image files — plain images and
 * verifiable Generation Job outputs — needs no Project when --out names the
 * destination (#292): the Project is resolved lazily, exactly when an input
 * or the default destination needs it, and a refusal names what the Project
 * was needed for. Outside a Project, --out is the plain destination with the
 * same existing-target refusals and the Project-independent render-output
 * conflict guard.
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
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Page } from "playwright";
import { MAX_DIMENSION, MAX_PIXELS, MAX_ENCODED_BYTES } from "./png.js";
import { generationOutputLabel, resolveGenerationOutputFile } from "./generation-retention.js";
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

/** A cell's content box: WxH for 16:9 work (#292), a single size meaning square. */
export interface SheetCell {
  width: number;
  height: number;
}

/**
 * Parse a --cell spec: a single integer size (a square box) or a `WxH` pair.
 * The ONE boundary for the grammar — the CLI calls this same function, so a
 * malformed spec reads identically at both seams. Both axes must be integers
 * of at least 1; the geometry limits (per-axis render cap, total pixels) are
 * enforced later in sheetGeometry, per axis.
 */
export function parseSheetCellSpec(raw: string): SheetCell {
  const trimmed = raw.trim();
  const box = /^(\d+)x(\d+)$/.exec(trimmed);
  if (box) {
    const width = Number(box[1]);
    const height = Number(box[2]);
    if (width >= 1 && height >= 1) return { width, height };
  } else if (/^\d+$/.test(trimmed)) {
    const side = Number(trimmed);
    if (side >= 1) return { width: side, height: side };
  }
  throw new Error(`--cell takes a size in px or a WxH box of positive integers (got "${raw}")`);
}

export interface SheetGeometry {
  columns: number;
  rows: number;
  /** The output PNG's exact dimensions. */
  width: number;
  height: number;
  cell: SheetCell;
}

/**
 * The sheet's deterministic geometry: `count` cells in `columns` columns of
 * `cell`-px boxes (a single size spreads to a square box), each with a label
 * strip under it. The output dimensions and every cell/label rectangle are
 * pure functions of (columns, cell, count) — TEST-008 asserts output pixels
 * from these rectangles. The geometry limits apply to BOTH axes (#292): each
 * of the cell's axes against the per-axis render cap, and the sheet's total
 * dimensions against the per-axis cap and the pixel cap.
 */
export function sheetGeometry(columns: number, cell: SheetCell, count: number): SheetGeometry {
  if (!Number.isInteger(columns) || columns < 1) {
    throw new Error(`Sheet columns must be an integer of at least 1 (got ${columns}).`);
  }
  if (!Number.isInteger(cell.width) || cell.width < 1 || !Number.isInteger(cell.height) || cell.height < 1) {
    throw new Error(
      `Sheet cell size must be an integer of at least 1 on each axis ` +
        `(got ${cell.width}×${cell.height}).`,
    );
  }
  if (cell.width > MAX_DIMENSION || cell.height > MAX_DIMENSION) {
    const over = [cell.width > MAX_DIMENSION ? `width ${cell.width}` : undefined, cell.height > MAX_DIMENSION ? `height ${cell.height}` : undefined].filter(Boolean).join(", ");
    throw new Error(
      `Sheet cell size ${cell.width}×${cell.height}px exceeds the ${MAX_DIMENSION}px per-axis render limit (${over}).`,
    );
  }
  const rows = Math.max(1, Math.ceil(count / columns));
  const width = SHEET_PAD * 2 + columns * cell.width + (columns - 1) * SHEET_GUTTER;
  const height = SHEET_PAD * 2 + rows * (cell.height + SHEET_LABEL_STRIP) + (rows - 1) * SHEET_GUTTER;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(
      `A ${columns}-column sheet of ${cell.width}×${cell.height}px cells needs ${width}×${height}px — over the ` +
        `${MAX_DIMENSION}px per-axis render limit. Use a smaller --cell, fewer --columns, or fewer inputs.`,
    );
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(
      `A ${columns}-column sheet of ${cell.width}×${cell.height}px cells is ${width}×${height} — over the ` +
        `${MAX_PIXELS.toLocaleString("en-US")}-pixel render limit. Use a smaller --cell, fewer ` +
        `--columns, or fewer inputs.`,
    );
  }
  return { columns, rows, width, height, cell: { width: cell.width, height: cell.height } };
}

/** One cell's content box in the output image, in paint order (row-major). */
export function sheetCellRect(
  g: SheetGeometry,
  index: number,
): { x: number; y: number; width: number; height: number } {
  const col = index % g.columns;
  const row = Math.floor(index / g.columns);
  return {
    x: SHEET_PAD + col * (g.cell.width + SHEET_GUTTER),
    y: SHEET_PAD + row * (g.cell.height + SHEET_LABEL_STRIP + SHEET_GUTTER),
    width: g.cell.width,
    height: g.cell.height,
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
  cell: SheetCell;
  paired: boolean;
  inputs: {
    index: number;
    kind: "composition" | "manifest" | "file" | "generation";
    label: string;
    source: string;
  }[];
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
  /** Cell content box — a WxH pair, or a single size meaning square
   *  (default 512×512). */
  cell?: SheetCell;
  /** Pairing mode: inputs are reference,result pairs, one pair per row. */
  pair?: boolean;
  /** Label overrides, CLI form: "1-based index=label text" (repeatable). */
  labels?: string[];
  /** A caller-explicitly-supplied Project is required, never lazily skipped
   *  (the CLI sets this when --project was passed). */
  requireProject?: boolean;
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
 * Resolve an --out destination when no Project is involved (#292): the same
 * existing-target refusals as the render path's export boundary — directories,
 * non-regular files, and a broken symlink (which the export boundary also
 * refuses, "cannot be resolved"). Project-state checks are not skipped here
 * lightly: the caller first resolves the destination's enclosing Project, if
 * any (see the publish path), so this resolver only runs when the destination
 * genuinely sits outside every Project. A recorded Render output beside the
 * target is refused by the caller's renderOutputConflict — that guard is
 * Project-independent, so the no-Project route keeps it.
 */
async function resolvePlainExportTarget(outPath: string): Promise<{ path: string; mode: "create" | "replace" }> {
  const target = path.resolve(outPath);
  let st;
  try {
    st = await lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`--out path "${outPath}" cannot be inspected: ${(err as Error).message}`);
    }
    st = undefined;
  }
  if (st) {
    // A broken symlink cannot be resolved — refused like the export boundary
    // does, instead of silently renaming over the dangling link.
    try {
      await realpath(target);
    } catch {
      throw new Error(`--out path "${outPath}" cannot be resolved (broken symlink?).`);
    }
    if (st.isDirectory()) {
      throw new Error(`--out path "${outPath}" is a directory; it must name a PNG file.`);
    }
    if (!st.isFile() && !st.isSymbolicLink()) {
      throw new Error(`--out path "${outPath}" is not a regular file.`);
    }
    return { path: target, mode: "replace" };
  }
  try {
    await realpath(path.dirname(target));
  } catch {
    throw new Error(`--out parent directory does not exist: "${path.dirname(target)}"`);
  }
  return { path: target, mode: "create" };
}

/**
 * The nearest directory at or above `from` containing a ply.json — the one
 * marker every Ply surface uses for "this is a Project". Undefined when no
 * ancestor claims Project-hood (#292 review SPEC-1: a destination inside a
 * Project is never written through the plain route, whatever the inputs).
 */
async function enclosingProjectRoot(from: string): Promise<string | undefined> {
  let dir = from;
  for (;;) {
    try {
      await lstat(path.join(dir, "ply.json"));
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The one publish-via-Project route (review INT-1): the render path's
 * export-target boundary (default destination included), both conflict
 * guards — the Project's renders/ history and any manifest beside the
 * target — and publication, all under the same Project lock. The in-Project
 * route and the enclosing-Project destination route share it, so a future
 * guard change cannot update one and leave the other overwriting a Render.
 */
async function publishViaProject(
  root: string,
  out: string | undefined,
  png: Buffer,
  geometry: SheetGeometry,
  pair: boolean,
  sourceFacts: ComparisonSheetResult["inputs"],
): Promise<ComparisonSheetResult> {
  return withProjectLock(root, async () => {
    const target = out ?? (await defaultSheetDestination(root));
    const destination = await resolveExportTarget(root, target);
    const conflict =
      (await projectRenderOutputConflict(root, destination.path)) ??
      (await renderOutputConflict(destination.path));
    return writeSheetPng(destination, conflict, png, geometry, pair, sourceFacts);
  });
}

/**
 * The shared publish tail: the render-output conflict refusal, atomic
 * publication, and the result literal — one home so the two publish routes
 * (in-Project and plain) cannot drift (review CRAFT-4).
 */
async function writeSheetPng(
  destination: { path: string; mode: "create" | "replace" },
  conflict: { manifest: string } | undefined,
  png: Buffer,
  geometry: SheetGeometry,
  pair: boolean,
  sourceFacts: ComparisonSheetResult["inputs"],
): Promise<ComparisonSheetResult> {
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
  if (inputs.length === 0) {
    throw new Error("A comparison sheet needs at least one input.");
  }
  const pair = options.pair ?? false;
  const columns = pair ? 2 : (options.columns ?? DEFAULT_SHEET_COLUMNS);
  const cell = options.cell ?? { width: DEFAULT_SHEET_CELL, height: DEFAULT_SHEET_CELL };
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

  // The Project is resolved lazily (#292): a sheet whose inputs are all local
  // image files — including verifiable Generation Job outputs — needs no
  // Project state when --out names the destination. It is resolved exactly
  // when something needs it — a Composition-name token, a Render manifest
  // input, or the default in-Project destination — and a failure is reported
  // through the reason that forced it, so the refusal says what the Project
  // was needed FOR, never a bare filesystem complaint.
  let resolvedRoot: string | undefined;
  const ensureProject = async (why: string): Promise<string> => {
    if (resolvedRoot !== undefined) return resolvedRoot;
    try {
      resolvedRoot = await resolveProjectRoot(projectPath);
    } catch (err) {
      throw new Error(`${why}: ${(err as Error).message}`);
    }
    return resolvedRoot;
  };

  // An explicitly given --project is a caller statement that a Project is
  // involved (#292 review SPEC-1) — never silently ignored, bogus path or
  // not. Its Project is resolved before anything else, exactly as it was
  // before lazy resolution existed.
  if (options.requireProject) {
    await ensureProject(`The Project given with --project ("${projectPath}") is required`);
  }

  // Cheap before expensive: every input is classified and resolved before any
  // browser pass, and every refusal names its input. Composition snapshots
  // and manifest history resolve under the Project lock (the render path's
  // own resolvers); the paints run outside it. The paints are recorded as
  // THUNKS, not started promises: they run one at a time after all inputs
  // resolve, so even a caller-owned page (the tests' offline seam) never has
  // two cell paints racing its viewport and document at once (review INT-1,
  // PR #255) — the shared render page serializes anyway, so sequencing costs
  // nothing there.
  interface PendingPaint {
    cellIndex: number;
    paint: () => Promise<Buffer>;
  }
  const cells: { src: string; label: string }[] = [];
  const pendingPaints: PendingPaint[] = [];
  const sourceFacts: ComparisonSheetResult["inputs"] = [];

  for (const [cellIndex, input] of inputs.entries()) {
    const target = path.resolve(input);
    // stat() (not lstat): a symlink to an image is an image — the same
    // followed-link reading every other local-file input takes. A missing
    // target means the token must be a Composition name.
    let st;
    try {
      st = await stat(target);
    } catch (err) {
      // Only a path that does not exist falls through to the Composition
      // reading; an existing but unreadable path says so.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new Error(`Sheet input "${input}" cannot be read: ${(err as Error).message}`);
      }
      st = undefined;
    }
    if (st !== undefined && st.isDirectory()) {
      throw new Error(`Sheet input "${input}" is a directory — pass an image file, a Render manifest, or a Composition name.`);
    }
    if (st === undefined || !st.isFile()) {
      // Not an existing regular file → the token must be a Composition name,
      // rendered current through the existing render path (no second
      // rendering authority, DEC-007). Resolving one needs Project state —
      // the sheet refuses clearly when there is none (#292).
      await ensureProject(
        `Sheet input "${input}" is not an existing local image file — resolving it as a Composition needs a Project`,
      );
      const snapshot = await resolveCompositionSnapshot(resolvedRoot!, input).catch((err: Error) => {
        throw new Error(
          `Sheet input "${input}" is neither an existing local file nor a Composition in this Project ` +
            `(${err.message.replace(/\.$/, "")}). Check the path, or list Compositions with 'ply composition list'.`,
        );
      });
      // The render path's default quality: the same supersampled paint
      // `composition render` performs (its factor cap is checked here too).
      assertSupersampledPaintSize(snapshot.canvas, 2, snapshot.name);
      pendingPaints.push({
        cellIndex,
        paint: () =>
          paintComposition(snapshot.canvas, snapshot.layers, { page: options.page, supersample: 2 }).then((r) => r.png),
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
    // The cap is re-checked on the bytes actually read: a file swapped for a
    // larger one between the size check and the read cannot slip the cap
    // (review PROD-1, PR #255).
    if (bytes.length > MAX_ENCODED_BYTES) {
      throw new Error(
        `Sheet input "${input}" is ${(bytes.length / (1024 * 1024)).toFixed(1)} MB — over the ` +
          `${(MAX_ENCODED_BYTES / (1024 * 1024))} MB input cap.`,
      );
    }
    const raster = sniffRasterFormat(bytes);
    if (raster) {
      const meta = readRasterMeta(bytes, input);
      if (typeof meta === "string") {
        throw new Error(`Sheet input "${input}" is not a decodable image: ${meta}`);
      }
      refuseOversizedImage(meta, input);
      // A file inside a Generation Job's outputs/ is labelled from its record
      // (#292) — '<job id> #<output index>' through the one shared label
      // function — and a record missing, unreadable, or not listing this file
      // is refused there, never silently degraded to a bare file name.
      const genOutput = await resolveGenerationOutputFile(target, bytes);
      const label = genOutput ? generationOutputLabel(genOutput.jobId, genOutput.outputIndex) : fileLabel(input);
      cells[cellIndex] = { src: `data:${IMAGE_MIME[meta.format]};base64,${bytes.toString("base64")}`, label };
      sourceFacts[cellIndex] = { index: cellIndex + 1, kind: genOutput ? "generation" : "file", label, source: input };
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
      // The same Generation-Job-output labelling as raster inputs (#292).
      const genOutput = await resolveGenerationOutputFile(target, bytes);
      const label = genOutput ? generationOutputLabel(genOutput.jobId, genOutput.outputIndex) : fileLabel(input);
      cells[cellIndex] = { src: `data:${IMAGE_MIME.svg};base64,${bytes.toString("base64")}`, label };
      sourceFacts[cellIndex] = { index: cellIndex + 1, kind: genOutput ? "generation" : "file", label, source: input };
      continue;
    }
    // Not a decodable image: the bytes must be a retained Render manifest,
    // resolved through the exact passes replay uses (minus publication). Both
    // attempts are reported, so an SVG-shaped file that is not a manifest
    // keeps its real reason instead of a confusing manifest-only message.
    // Replaying Project history needs Project state — refused clearly when
    // there is none (#292).
    const svgReason = svg;
    await ensureProject(
      `Sheet input "${input}" is not a decodable image — replaying it as a Render manifest needs a Project`,
    );
    await requireProjectRenderManifest(resolvedRoot!, target).catch((err: Error) => {
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
    const layers = await withProjectLock(resolvedRoot!, () => resolveHistoricalLayers(resolvedRoot!, manifest));
    pendingPaints.push({
      cellIndex,
      // Manifest history paints exactly as replay repaints it — same canvas,
      // same recorded factor — then the same environment gate applies, named
      // for the input that failed it.
      paint: () =>
        paintComposition(manifest.canvas, layers, { page: options.page, supersample: manifest.supersample }).then(
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

  // Without --out, the default destination lives inside the Project's
  // guidelines/ — a deterministic dependency, so it is enforced BEFORE any
  // browser work (cheap before expensive, review CRAFT-3): input resolution
  // keeps its precedence, then this refusal, then the cell paints and the
  // page paint.
  if (resolvedRoot === undefined && options.out === undefined) {
    await ensureProject(
      `A comparison sheet without --out is written under the Project's guidelines/ — pass --out <path> to write one without a Project, or run inside a valid Project`,
    );
  }

  // All inputs resolved: paint the composition/manifest cells ONE AT A TIME
  // (review INT-1, PR #255 — a caller-owned page must never run two cell
  // paints at once), then embed.
  for (const pending of pendingPaints) {
    cells[pending.cellIndex]!.src = `data:image/png;base64,${(await pending.paint()).toString("base64")}`;
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

  if (resolvedRoot !== undefined) {
    // One publish-via-Project function for every Project-aware route (review
    // INT-1): the export boundary, both conflict guards, and the lock have
    // one home, so a future guard change cannot update one route and leave
    // the other overwriting a Render.
    return publishViaProject(resolvedRoot, options.out, png, geometry, pair, sourceFacts);
  }

  // No Project has been needed so far — but the destination may still lie
  // inside one (#292 review SPEC-1): a sheet must never write reserved
  // Project state or overwrite a recorded Render output wherever it lands.
  // A destination under a ply.json directory therefore publishes through
  // that Project's boundary, resolving it (and refusing clearly if it is
  // not a valid one). The walk sees the destination's REAL location
  // (review PROD-1): an existing target and a symlinked parent resolve
  // exactly as resolveExportTarget resolves them, so a symlinked --out
  // into a Project cannot take the plain route.
  const outPath = path.resolve(options.out!);
  let realOutDir: string;
  let outSt;
  try {
    outSt = await lstat(outPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`--out path "${options.out}" cannot be inspected: ${(err as Error).message}`);
    }
  }
  if (outSt) {
    let realTarget: string;
    try {
      realTarget = await realpath(outPath);
    } catch {
      throw new Error(`--out path "${options.out}" cannot be resolved (broken symlink?).`);
    }
    realOutDir = path.dirname(realTarget);
  } else {
    try {
      realOutDir = path.dirname(await realpath(path.dirname(outPath)));
    } catch {
      throw new Error(`--out parent directory does not exist: "${path.dirname(outPath)}"`);
    }
  }
  const enclosing = await enclosingProjectRoot(realOutDir);
  if (enclosing !== undefined) {
    try {
      resolvedRoot = await resolveProjectRoot(enclosing);
    } catch (err) {
      throw new Error(
        `--out path "${options.out}" lies inside the Ply Project at "${enclosing}" — ` +
          `publishing there needs a valid Project: ${(err as Error).message}`,
      );
    }
    return publishViaProject(resolvedRoot, options.out, png, geometry, pair, sourceFacts);
  }

  // Genuinely outside every Project: --out is the plain destination (#292).
  // The same existing-target refusals as the export boundary, minus every
  // Project-state check there is nothing to protect — and a recorded Render
  // output beside the target is still refused, that guard is
  // Project-independent.
  const destination = await resolvePlainExportTarget(options.out!);
  const conflict = await renderOutputConflict(destination.path);
  return writeSheetPng(destination, conflict, png, geometry, pair, sourceFacts);
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
