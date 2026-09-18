/**
 * Caller-supplied region files (#173, spec #172 US-001/US-004, DEC-002,
 * DEC-004, ADR-0015) — the single ingestion point for caller-owned region
 * data.
 *
 * A region file is a JSON document the caller owns and passes by path. It
 * names axis-aligned rectangles in canvas pixels, each with a stable id, a
 * human-readable label, and the reason it is protected. The schema (this
 * is the contract every consumer builds on — #173's check, #174's
 * guideline view, #175's starter file, #176's legacy reader; the shipped
 * YouTube instance lives at examples/youtube-regions.json):
 *
 *     {
 *       "schemaVersion": 1,
 *       "canvas": { "width": 1280, "height": 720 },
 *       "regions": [
 *         {
 *           "id": "top-banner",
 *           "label": "top banner",
 *           "reason": "the platform pins a banner over the top edge",
 *           "box": { "x": 0, "y": 0, "width": 1280, "height": 80 }
 *         }
 *       ]
 *     }
 *
 * - `schemaVersion` — the region-file schema version; the only supported
 *   value is `REGION_SCHEMA_VERSION` (1). A missing or unknown version
 *   fails loudly with an actionable error.
 * - `canvas` — the canvas the file targets, in pixels. Regions are
 *   canvas-pixel data, never a 1280×720 assumption in code (DEC-004);
 *   ingestion validates the file's canvas against the Composition's
 *   canvas (the canvas contract), so a mismatched file fails loudly
 *   instead of silently checking nothing.
 * - `regions[].box` — the protected rectangle, `{ x, y, width, height }`,
 *   the repo's one rectangle representation (`Box` from
 *   src/scene-geometry.ts; the shape `ProtectedRegion` already carries).
 *   Each box must lie within the file's declared canvas.
 * - `regions[].id` — non-empty and unique within the file; it names the
 *   region in findings.
 * - `regions[].label` / `regions[].reason` — human-readable text surfaced
 *   in findings and the guideline overlay markup.
 *
 * Parse-don't-validate: raw JSON becomes trusted internal data exactly
 * here, in one pass, and every malformed shape is rejected with an
 * actionable error naming the file path and the offending field. Nothing
 * downstream sees raw file data, an alternate rectangle shape, or a
 * second parser: the region object is structurally identical to
 * safe-area.ts's `ProtectedRegion` (id/label/reason + `box: Box`), so the
 * legacy machinery consumes this same file format through the same
 * parser (#176) without a translation layer.
 *
 * Region data is caller-owned policy (ADR-0015): Ply validates its shape
 * and canvas contract, never its content. No network, no inference
 * weights — reading and validating a region file is a local, offline
 * operation.
 */
import { readFileSync } from "node:fs";
// The rectangle type is a type-only import: one box representation across
// the repo (the user-approved contract — the region object is structurally
// identical to safe-area.ts's ProtectedRegion, and #176's legacy reader
// feeds this same file into that machinery), with no runtime coupling
// into the legacy Scene surface.
import type { Box } from "./scene-geometry.js";
// Type-only compile-time pin (review INT-4): the two shapes stay
// assignable in both directions, so the "no translation layer at the #176
// seam" claim cannot silently rot — a field added to either side without
// the other fails `tsc --noEmit`. This imports a type; it does not modify
// or extend the legacy module.
import type { ProtectedRegion } from "./safe-area.js";

/** One caller-protected rectangle of a canvas. */
export interface Region {
  id: string;
  /** Human-readable name used in findings and the guideline overlay. */
  label: string;
  /** Why the region is protected — surfaced in findings and overlay markup. */
  reason: string;
  /** The protected rectangle in canvas pixels. */
  box: Box;
}

/** The canvas a region file targets, in pixels. */
export interface RegionCanvas {
  width: number;
  height: number;
}

/** The parsed, trusted form of a caller-supplied region file (schema v1). */
export interface RegionFile {
  schemaVersion: number;
  canvas: RegionCanvas;
  regions: Region[];
}

/** The only supported region-file schema version. */
export const REGION_SCHEMA_VERSION = 1;

// The two-directional assignability pin, evaluated once at module load.
type _RegionMatchesProtectedRegion = [Region] extends [ProtectedRegion]
  ? [ProtectedRegion] extends [Region]
    ? true
    : never
  : never;
const _regionMatchesProtectedRegion: _RegionMatchesProtectedRegion = true;
void _regionMatchesProtectedRegion;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function fail(source: string, detail: string): never {
  throw new Error(`Region file "${source}" ${detail}`);
}

/** Non-empty trimmed string, or a rejection naming the field. The caller
 * receives the TRIMMED value: normalization happens at this boundary, so
 * a " dup" id cannot bypass uniqueness against a stored "dup". */
function requiredString(doc: Record<string, unknown>, field: string, source: string, context: string): string {
  const v = doc[field];
  if (typeof v !== "string" || v.trim() === "") {
    fail(source, `${context}: "${field}" must be a non-empty string.`);
  }
  return (v as string).trim();
}

/** Parse and validate the raw JSON document — the one boundary where
 * untyped caller data becomes trusted region data. Every field the check
 * (and the guideline view) reads is coerced or rejected here. */
export function parseRegionFile(raw: unknown, source: string): RegionFile {
  if (!isRecord(raw)) {
    fail(source, `expected a JSON object with "schemaVersion", "canvas", and "regions".`);
  }
  const doc = raw as Record<string, unknown>;

  if (!("schemaVersion" in doc)) {
    fail(
      source,
      `is missing "schemaVersion"; the supported region-file schema is version ${REGION_SCHEMA_VERSION}.`,
    );
  }
  const version = doc.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version !== REGION_SCHEMA_VERSION) {
    fail(
      source,
      `declares schemaVersion ${JSON.stringify(version)}; the supported region-file schema is version ${REGION_SCHEMA_VERSION}.`,
    );
  }

  const canvasDoc = doc.canvas;
  if (!isRecord(canvasDoc)) {
    fail(source, `"canvas" must be an object with positive integer "width" and "height".`);
  }
  const width = canvasDoc.width;
  const height = canvasDoc.height;
  if (
    typeof width !== "number" || !Number.isInteger(width) || width <= 0 ||
    typeof height !== "number" || !Number.isInteger(height) || height <= 0
  ) {
    fail(source, `"canvas" must be an object with positive integer "width" and "height".`);
  }

  if (!Array.isArray(doc.regions)) {
    fail(source, `"regions" must be an array.`);
  }

  const seen = new Set<string>();
  const regions: Region[] = doc.regions.map((entry, i) => {
    const context = `regions[${i}]`;
    if (!isRecord(entry)) {
      fail(source, `${context} must be an object with "id", "label", "reason", and "box".`);
    }
    const r = entry as Record<string, unknown>;
    const id = requiredString(r, "id", source, context);
    if (seen.has(id)) {
      fail(source, `${context}: duplicate region id "${id}".`);
    }
    seen.add(id);
    const label = requiredString(r, "label", source, context);
    const reason = requiredString(r, "reason", source, context);

    const boxDoc = r.box;
    if (!isRecord(boxDoc)) {
      fail(source, `${context} ("${id}"): "box" must be an object with numeric "x", "y", "width", "height".`);
    }
    const box = boxDoc as Record<string, unknown>;
    for (const f of ["x", "y", "width", "height"] as const) {
      if (typeof box[f] !== "number" || !Number.isFinite(box[f] as number)) {
        fail(source, `${context} ("${id}"): "box.${f}" must be a finite number.`);
      }
    }
    const b: Box = {
      x: box.x as number,
      y: box.y as number,
      width: box.width as number,
      height: box.height as number,
    };
    if (b.width <= 0 || b.height <= 0) {
      fail(source, `${context} ("${id}"): "box.width" and "box.height" must be positive.`);
    }
    // The box lies within the file's declared canvas: a region outside the
    // canvas can never be intersected by on-canvas content, so it is a
    // caller mistake to reject, never something to check silently.
    if (b.x < 0 || b.y < 0 || b.x + b.width > width || b.y + b.height > height) {
      fail(
        source,
        `${context} ("${id}"): box (${b.x}, ${b.y}) ${b.width}×${b.height} lies outside the file's ` +
          `${width}×${height} canvas.`,
      );
    }
    return { id, label, reason, box: b };
  });

  return { schemaVersion: version, canvas: { width, height }, regions };
}

/**
 * Read and parse a region file from disk — parse-don't-validate at one
 * boundary. The async form delegates to the sync twin: one reading half
 * (same file access, same actionable errors), one parser, two call
 * signatures.
 */
export async function readRegionFile(regionFilePath: string): Promise<RegionFile> {
  return readRegionFileSync(regionFilePath);
}

/**
 * The one reading half shared by both call signatures — sync (the legacy
 * safe-area reader's consumers are synchronous) and, via the delegation
 * in `readRegionFile`, async. Reads the file, JSON-parses it, and hands
 * the result to the one parser; every failure is loud and names the
 * file. There is deliberately no second reading recipe.
 */
export function readRegionFileSync(regionFilePath: string): RegionFile {
  let raw: string;
  try {
    raw = readFileSync(regionFilePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      fail(regionFilePath, `does not exist — supply a region file the caller owns (see ply composition check --help).`);
    }
    fail(regionFilePath, `could not be read (${(err as Error).message}).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(regionFilePath, `is not valid JSON: ${(err as Error).message}`);
  }
  return parseRegionFile(parsed, regionFilePath);
}

/**
 * The single ingestion point every region consumer calls (#173's check,
 * #174's guideline view): parse the caller's file, then validate its
 * canvas contract against the Composition's canvas. Returns the trusted
 * regions in file order. A file whose canvas does not match fails loudly
 * — regions are canvas-pixel data, so a mismatch would silently check
 * nothing meaningful.
 */
export async function loadCompositionRegions(
  regionFilePath: string,
  compositionCanvas: RegionCanvas,
): Promise<{ file: RegionFile; regions: Region[] }> {
  const file = await readRegionFile(regionFilePath);
  return { file, regions: ingestRegionCanvas(file, compositionCanvas, regionFilePath) };
}

/**
 * The canvas-contract half of the ingestion point, callable separately so
 * a consumer can parse first (cheap, loud failure before any browser
 * work) and validate the canvas contract once the Composition is known
 * without re-reading the file. `sourcePath` is only for error messages.
 */
export function ingestRegionCanvas(
  file: RegionFile,
  compositionCanvas: RegionCanvas,
  sourcePath: string,
): Region[] {
  if (file.canvas.width !== compositionCanvas.width || file.canvas.height !== compositionCanvas.height) {
    throw new Error(
      `Region file "${sourcePath}" targets a ${file.canvas.width}×${file.canvas.height} canvas, ` +
        `but the Composition's canvas is ${compositionCanvas.width}×${compositionCanvas.height}. ` +
        `Regions are canvas-pixel data, so the file's canvas must match the Composition's canvas — ` +
        `edit the file's "canvas" to match, or check a Composition of that size.`,
    );
  }
  return file.regions;
}
