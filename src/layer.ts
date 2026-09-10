import { isStoredTimestamp } from "./stored-schema.js";
/**
 * Layer identity, immutable revisions, and content-addressed image/text
 * ingestion (ADR-0013, ADR-0014, DEC-001–006, #81).
 */
import { createHash } from "node:crypto";
import { open as fsOpen, readFile, readdir, lstat, mkdir, unlink, rmdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { MAX_DIMENSION, MAX_ENCODED_BYTES, MAX_PIXELS, decodePng } from "./png.js";
import { readRasterMeta, type RasterMeta } from "./raster-meta.js";
import { escapesDirReal, outsideDir } from "./paths.js";
import { atomicCreate, atomicReplace, withProjectLock } from "./project-lock.js";
import { resolveProjectRoot } from "./project.js";
import { withRenderPage } from "./browser.js";
import { parseCompositionDocument, readMutableComposition, type Composition } from "./composition.js";
import { resolveFace, fontAssetBytes } from "./fonts.js";
import {
  selectGenerationOutput,
  retainGenerationRecord,
  type GenerationOutputSelection,
  type RetainedProvenance as RetainedGenerationProvenance,
} from "./generation-retention.js";
import {
  selectMatteOutput,
  retainMattingRecord,
  findGenerationPredecessor,
} from "./matting-retention.js";

export const LAYER_SCHEMA_VERSION = 1;

/**
 * Maximum stored text content length for a text Layer revision (#81). A
 * bound, not a typographic feature: pathological inputs are rejected at the
 * ingestion boundary instead of reaching the renderer.
 */
export const MAX_TEXT_LENGTH = 2000;

export interface LayerIdentity {
  schemaVersion: number;
  id: string;
  createdAt: string;
  currentRevision: string;
}

/** Shared revision header: identity, immutability facts, and placement. */
interface LayerRevisionBase {
  schemaVersion: number;
  layerId: string;
  createdAt: string;
  x: number;
  y: number;
  opacity: number;
  /**
   * Canonical transform scale (#133, ADR-0016): the Layer's effective painted
   * size is its content size multiplied by these factors, applied about the
   * Layer's (x, y) top-left placement point. These are revision facts shared
   * as a whole (DEC-002); width/height conveniences normalize to them at the
   * command boundary and are never stored.
   *
   * Optional in the stored shape only for revisions written before #133 —
   * absent fields mean scale 1 and are normalized by the one revision reader,
   * so no downstream reader needs a fallback. Every newly written revision
   * records both fields explicitly, keeping the revision hash covering the
   * full canonical transform (a resize-only edit is a new revision).
   */
  scaleX?: number;
  scaleY?: number;
  /**
   * Canonical transform rotation (#134, ADR-0016): the Layer's rotation in
   * degrees about its (x, y) top-left placement point, applied AFTER scale
   * (the content stretches along its own axes, then the stretched result
   * rotates). Positive degrees rotate clockwise (CSS convention). This is a
   * revision fact shared as a whole (DEC-002) and stored verbatim — the
   * command sets an absolute angle, so equivalent angles are distinct
   * deliberate edits.
   *
   * Optional in the stored shape only for revisions written before #134 —
   * absent means 0 and is normalized by the one revision reader, so no
   * downstream reader needs a fallback. Every newly written revision records
   * it explicitly, and the hash appends it only when present, so revisions
   * written before #134 (with or without scale fields) keep their exact ids.
   */
  rotationDeg?: number;
  /**
   * Canonical transform reflection (#135, ADR-0016): whether the Layer's
   * content is mirrored along its own horizontal axis (`flipX`, left–right)
   * and/or vertical axis (`flipY`, top–bottom), about its `(x, y)` top-left
   * placement point. Two axes of the one reflection operation — one shared
   * representation, no separate lifecycle. The command sets an ABSOLUTE
   * reflection state that replaces any previous one.
   *
   * Optional in the stored shape only for revisions written before #135 —
   * absent means false and is normalized by the one revision reader, so no
   * downstream reader needs a fallback. Every newly written revision records
   * both fields explicitly (always together, like scale), and the hash
   * appends them only when present, so revisions written before #135 keep
   * their exact ids.
   */
  flipX?: boolean;
  flipY?: boolean;
  /**
   * Canonical Layer shadow (#139, ADR-0018): a drop shadow applied to the
   * Layer's content in its LOCAL coordinate space — before the canonical
   * transform, which maps content+shadow together — then faded by the
   * Layer's opacity. `dx`/`dy` are the shadow offset in px (negative
   * allowed), `blur` the softening radius in px (≥ 0), `color` a hex color
   * (#RGB/#RRGGBB/#RRGGBBAA — alpha softens the shadow). The fact applies
   * uniformly to image alpha and text glyphs (DEC-006: a bounded effect,
   * never a general filter framework), and is a revision fact shared as a
   * whole (DEC-002).
   *
   * Present ⟺ a shadow exists: absence IS the canonical no-shadow form, so
   * removal drops the field and every reader treats absence as none — no
   * second "no shadow" representation. The revision hash appends it only
   * when present, so revisions written before #139 keep their exact ids.
   */
  shadow?: LayerShadow;
}

/** Canonical shadow parameters (#139, ADR-0018): offset, softening, color. */
export interface LayerShadow {
  dx: number;
  dy: number;
  blur: number;
  color: string;
}

/**
 * Discriminated Layer revision content (#81, DEC-003): `kind` selects the
 * content contract. Both kinds share the identity/revision/use lifecycle,
 * publication protocol, and storage layout — there is no second lifecycle
 * for text.
 *
 * Content identity semantics: `contentHash` pins the revision's retained
 * bytes in `content/<sha256>` — decoded raster bytes for `"image"`, the
 * exact bundled font face bytes for `"text"`. For a text revision the
 * rendered string, size, and color are immutable revision facts covered by
 * the revision hash; the face's family/weight are add-time bundled-face
 * selection facts (via `resolveFace`) and are deliberately NOT persisted —
 * the retained bytes are the only font identity, so the renderer declares
 * them under an internal family name and never needs `assets/fonts/`.
 */
export interface LayerImageRevision extends LayerRevisionBase {
  kind: "image";
  contentHash: string;
}

export interface LayerTextRevision extends LayerRevisionBase {
  kind: "text";
  contentHash: string;
  text: string;
  fontSize: number;
  color: string;
}

export type LayerRevision = LayerImageRevision | LayerTextRevision;

/** Canonical normalized transform scale: the one shape every consumer reads. */
export interface LayerTransformScale {
  scaleX: number;
  scaleY: number;
}

/**
 * Canonical stored-scale validation and normalization (#133, ADR-0016). This
 * is the one normalization boundary for transform scale: stored documents
 * written before #133 lack the fields (only a missing field is absent — a
 * present `null` or any other non-number is a malformed document, never a
 * silent default) and normalize to scale 1 here; every downstream reader
 * projects through this function and never re-derives a default. Stored
 * fields must be present together and be finite positive numbers — a partial
 * or invalid pair is a malformed document, refused loudly before the revision
 * hash is consulted.
 */
export function normalizeStoredScale(revision: {
  scaleX?: unknown;
  scaleY?: unknown;
}): LayerTransformScale {
  const hasX = revision.scaleX !== undefined;
  const hasY = revision.scaleY !== undefined;
  if (hasX !== hasY) {
    throw new Error(
      `Malformed revision document: scaleX and scaleY must be present together (got scaleX ${JSON.stringify(revision.scaleX)}, scaleY ${JSON.stringify(revision.scaleY)}).`,
    );
  }
  if (!hasX) {
    return { scaleX: 1, scaleY: 1 };
  }
  const scaleX = revision.scaleX;
  const scaleY = revision.scaleY;
  if (
    typeof scaleX !== "number" || !Number.isFinite(scaleX) || scaleX <= 0 ||
    typeof scaleY !== "number" || !Number.isFinite(scaleY) || scaleY <= 0
  ) {
    throw new Error(
      `Malformed revision document: scaleX and scaleY must be finite numbers greater than 0 (got ${JSON.stringify(scaleX)}, ${JSON.stringify(scaleY)}).`,
    );
  }
  return { scaleX, scaleY };
}

/**
 * Canonical stored-rotation validation and normalization (#134, ADR-0016).
 * The one normalization boundary for transform rotation: documents written
 * before #134 lack the field (only a missing field is absent — a present
 * `null` or any other non-number is a malformed document, never a silent
 * default) and normalize to 0 here; every downstream reader projects through
 * this function and never re-derives a default. A present field must be a
 * finite number (degrees, clockwise positive, stored verbatim).
 */
export function normalizeStoredRotation(revision: { rotationDeg?: unknown }): number {
  const rotation = revision.rotationDeg;
  if (rotation === undefined) {
    return 0;
  }
  if (typeof rotation !== "number" || !Number.isFinite(rotation)) {
    throw new Error(
      `Malformed revision document: rotationDeg must be a finite number of degrees when present (got ${JSON.stringify(rotation)}).`,
    );
  }
  return rotation;
}

/** Canonical normalized transform reflection: the one shape every consumer reads. */
export interface LayerTransformFlip {
  flipX: boolean;
  flipY: boolean;
}

/**
 * Canonical stored-reflection validation and normalization (#135, ADR-0016).
 * The one normalization boundary for transform reflection: documents written
 * before #135 lack the fields (only a missing field is absent — a present
 * `null` or any other non-boolean is a malformed document, never a silent
 * default) and normalize to false here; every downstream reader projects
 * through this function and never re-derives a default. A present pair must
 * be two booleans, recorded together like scale.
 */
export function normalizeStoredFlip(revision: {
  flipX?: unknown;
  flipY?: unknown;
}): LayerTransformFlip {
  const hasX = revision.flipX !== undefined;
  const hasY = revision.flipY !== undefined;
  if (hasX !== hasY) {
    throw new Error(
      `Malformed revision document: flipX and flipY must be present together (got flipX ${JSON.stringify(revision.flipX)}, flipY ${JSON.stringify(revision.flipY)}).`,
    );
  }
  if (!hasX) {
    return { flipX: false, flipY: false };
  }
  const flipX = revision.flipX;
  const flipY = revision.flipY;
  if (typeof flipX !== "boolean" || typeof flipY !== "boolean") {
    throw new Error(
      `Malformed revision document: flipX and flipY must be booleans when present (got flipX ${JSON.stringify(flipX)}, flipY ${JSON.stringify(flipY)}).`,
    );
  }
  return { flipX, flipY };
}

/** Shadow parameter bounds (#139, ADR-0018): a bounded effect footprint, so
 * painted-extent capture stays bounded (DEC-006). Offsets may be negative. */
const MAX_SHADOW_OFFSET_PX = 256;
const MAX_SHADOW_BLUR_PX = 256;

/** Shadow hex color: #RGB, #RRGGBB, or #RRGGBBAA (alpha softens the shadow). */
const SHADOW_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Canonical stored-shadow validation and normalization (#139, ADR-0018).
 * The one normalization boundary for the shadow effect: documents written
 * before #139 lack the field, and absence IS the canonical no-shadow form —
 * every downstream reader projects through this function and never re-derives
 * a default. A present field must be a valid shadow object: finite `dx`/`dy`
 * within the offset cap, finite `blur` ≥ 0 within the blur cap, and a hex
 * `color` (#RGB/#RRGGBB/#RRGGBBAA) — anything else is a malformed document,
 * refused loudly before the revision hash is consulted.
 */
export function normalizeStoredShadow(revision: { shadow?: unknown }): LayerShadow | undefined {
  if (revision.shadow === undefined) {
    return undefined;
  }
  const raw = revision.shadow;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Malformed revision document: shadow must be a shadow object when present (got ${JSON.stringify(raw)}).`,
    );
  }
  const { dx, dy, blur, color } = raw as Record<string, unknown>;
  for (const [label, value] of [["dx", dx], ["dy", dy]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_SHADOW_OFFSET_PX) {
      throw new Error(
        `Malformed revision document: shadow.${label} must be a finite number of px within ±${MAX_SHADOW_OFFSET_PX} (got ${JSON.stringify(value)}).`,
      );
    }
  }
  if (typeof blur !== "number" || !Number.isFinite(blur) || blur < 0 || blur > MAX_SHADOW_BLUR_PX) {
    throw new Error(
      `Malformed revision document: shadow.blur must be a finite number of px between 0 and ${MAX_SHADOW_BLUR_PX} (got ${JSON.stringify(blur)}).`,
    );
  }
  if (typeof color !== "string" || !SHADOW_COLOR_PATTERN.test(color)) {
    throw new Error(
      `Malformed revision document: shadow.color must be a hex color like #000000, #000, or #00000080 (got ${JSON.stringify(color)}).`,
    );
  }
  return { dx, dy, blur, color } as LayerShadow;
}

export type ResolvedLayerRevision =
  | (LayerImageRevision & { revisionId: string; format: "png" | "jpeg" | "webp"; width: number; height: number; bytes: number; scaleX: number; scaleY: number; rotationDeg: number; flipX: boolean; flipY: boolean })
  | (LayerTextRevision & { revisionId: string; fontBytes: number; scaleX: number; scaleY: number; rotationDeg: number; flipX: boolean; flipY: boolean });

export interface ResolvedLayer {
  id: string;
  createdAt: string;
  currentRevisionId: string;
  currentRevision: ResolvedLayerRevision;
}

/** Decode image in headless browser to verify full payload integrity for general formats. */
async function decodeInBrowser(bytes: Buffer, format: string): Promise<{ width: number; height: number }> {
  const mime = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
  const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  return withRenderPage(async (page) => {
    return page.evaluate((src) => {
      return new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          if (!img.naturalWidth || !img.naturalHeight) {
            reject(new Error("Decoded image has 0 dimensions"));
          } else {
            resolve({ width: img.naturalWidth, height: img.naturalHeight });
          }
        };
        img.onerror = () => {
          reject(new Error("Image decoding failed"));
        };
        img.src = src;
      });
    }, dataUrl);
  });
}

/**
 * Validate already-read image bytes for Layer ingestion: resource bounds,
 * format sniffing, and full decode verification. The one content-validation
 * home shared by file ingestion (`validateAndIngestImage`) and generated-byte
 * ingestion (#107), so every ingestion path applies identical checks.
 */
export async function validateImageBytes(
  bytes: Buffer,
  sourceName: string,
): Promise<{ bytes: Buffer; contentHash: string; format: "png" | "jpeg" | "webp"; width: number; height: number }> {
  if (bytes.length === 0) {
    throw new Error(`"${sourceName}" is empty (0 bytes)`);
  }
  if (bytes.length > MAX_ENCODED_BYTES) {
    throw new Error(
      `"${sourceName}" is ${(bytes.length / 1024 / 1024).toFixed(1)} MB — over the ${MAX_ENCODED_BYTES / 1024 / 1024} MB limit`,
    );
  }

  const rasterMeta = readRasterMeta(bytes, sourceName);
  if (typeof rasterMeta === "string") {
    throw new Error(rasterMeta);
  }
  const meta: RasterMeta = rasterMeta;

  if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) {
    throw new Error(
      `"${sourceName}" declares a ${meta.width}×${meta.height} canvas — over the ${MAX_DIMENSION}px per-axis limit`,
    );
  }
  if (meta.width * meta.height > MAX_PIXELS) {
    throw new Error(
      `"${sourceName}" declares ${meta.width}×${meta.height} — over the ${MAX_PIXELS.toLocaleString("en-US")}-pixel limit`,
    );
  }

  // Full image decompression / decoding verification
  let decodedWidth = meta.width;
  let decodedHeight = meta.height;

  if (meta.format === "png") {
    try {
      const decoded = decodePng(bytes);
      decodedWidth = decoded.width;
      decodedHeight = decoded.height;
    } catch (pngErr) {
      const errMsg = (pngErr as Error).message;
      if (errMsg.includes("not supported")) {
        // Unsupported feature in simple parser (e.g. palette, interlaced) -> verify with browser
        try {
          const browserDecoded = await decodeInBrowser(bytes, "png");
          decodedWidth = browserDecoded.width;
          decodedHeight = browserDecoded.height;
        } catch {
          throw new Error(`Corrupted PNG image "${sourceName}": ${errMsg}`);
        }
      } else {
        // Real corruption (bad CRC, truncated IDAT, etc.)
        throw new Error(`Corrupted PNG image "${sourceName}": ${errMsg}`);
      }
    }
  } else {
    try {
      const browserDecoded = await decodeInBrowser(bytes, meta.format);
      decodedWidth = browserDecoded.width;
      decodedHeight = browserDecoded.height;
    } catch (browserErr) {
      throw new Error(`Corrupted ${meta.format.toUpperCase()} image "${sourceName}": ${(browserErr as Error).message}`);
    }
  }

  const contentHash = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    contentHash,
    format: meta.format,
    width: decodedWidth,
    height: decodedHeight,
  };
}

/**
 * Validate and ingest an external image file.
 * Returns the validated raw bytes, SHA-256 hash, and intrinsic dimensions.
 */
export async function validateAndIngestImage(
  imagePath: string,
): Promise<{ bytes: Buffer; contentHash: string; format: "png" | "jpeg" | "webp"; width: number; height: number }> {
  const resolvedPath = path.resolve(imagePath);

  let fh: FileHandle;
  try {
    fh = await fsOpen(resolvedPath, "r");
  } catch (err) {
    throw new Error(`cannot read the input image "${imagePath}": ${(err as Error).message}`);
  }

  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      throw new Error(`"${imagePath}" is not a regular file — supported input is a regular local PNG, JPEG, or WebP file`);
    }
    if (st.size > MAX_ENCODED_BYTES) {
      throw new Error(
        `"${imagePath}" is ${(st.size / 1024 / 1024).toFixed(1)} MB — over the ${MAX_ENCODED_BYTES / 1024 / 1024} MB limit`,
      );
    }
    if (st.size === 0) {
      throw new Error(`"${imagePath}" is empty (0 bytes)`);
    }

    const bytes = Buffer.alloc(st.size);
    let totalRead = 0;
    while (totalRead < bytes.length) {
      const { bytesRead } = await fh.read(bytes, totalRead, bytes.length - totalRead, totalRead);
      if (bytesRead <= 0) {
        throw new Error(`"${imagePath}" changed while being read`);
      }
      totalRead += bytesRead;
    }

    return await validateImageBytes(bytes, imagePath);
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Canonical text content validation (#81): one home for the text facts every
 * writer and reader must agree on. Ingestion and the stored-revision parser
 * both call this, so no alternate representation can drift.
 */
export function validateTextContent(text: unknown, fontSize: unknown, color: unknown): void {
  if (typeof text !== "string" || text.length === 0 || text.trim().length === 0) {
    throw new Error(`Invalid text content: must be a nonempty string.`);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(`Invalid text content: ${text.length} characters exceeds the ${MAX_TEXT_LENGTH}-character limit.`);
  }
  if (typeof fontSize !== "number" || !Number.isFinite(fontSize) || fontSize <= 0 || fontSize > MAX_DIMENSION) {
    throw new Error(
      `Invalid font size ${fontSize}: must be a finite number between 0 and ${MAX_DIMENSION}.`,
    );
  }
  if (typeof color !== "string" || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
    throw new Error(`Invalid color "${color}": must be a hex color like #ffffff or #fff.`);
  }
}

/** Compute content-derived revision hash for an immutable revision record.
 * The scale fields are appended only when present, so revisions written
 * before #133 hash to exactly their pre-resize ids: older revisions retain
 * their original hash and paint meaning (#133). The rotation field is
 * likewise appended only when present, so revisions written before #134 —
 * with or without scale fields — keep their exact ids (#134). The flip
 * fields are appended only when present, so revisions written before #135
 * keep their exact ids (#135). */
export function computeRevisionHash(rev: LayerRevision): string {
  const base = `${rev.layerId}:${rev.kind}:${rev.contentHash}:${rev.x}:${rev.y}:${rev.opacity}:${rev.createdAt}`;
  const textFields = rev.kind === "text" ? `:${rev.text}:${rev.fontSize}:${rev.color}` : "";
  const scaleFields =
    rev.scaleX !== undefined || rev.scaleY !== undefined ? `:${rev.scaleX}:${rev.scaleY}` : "";
  const rotationField = rev.rotationDeg !== undefined ? `:${rev.rotationDeg}` : "";
  const flipFields =
    rev.flipX !== undefined || rev.flipY !== undefined ? `:${rev.flipX}:${rev.flipY}` : "";
  const shadowField =
    rev.shadow !== undefined
      ? `:shadow(${rev.shadow.dx},${rev.shadow.dy},${rev.shadow.blur},${rev.shadow.color})`
      : "";
  return `rev_${createHash("sha256").update(`${base}${textFields}${scaleFields}${rotationField}${flipFields}${shadowField}`).digest("hex").slice(0, 16)}`;
}

/** Generate a unique stable Layer ID. */
export function generateLayerId(): string {
  return `layer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Store content blob into project's content/ directory with deduplication and validation.
 */
export async function storeContentBlob(projectPath: string, contentHash: string, bytes: Buffer): Promise<void> {
  const contentDir = path.join(projectPath, "content");
  const blobPath = path.join(contentDir, contentHash);

  if (outsideDir(projectPath, blobPath)) {
    throw new Error(`Security error: content path escapes project boundary.`);
  }

  try {
    await lstat(blobPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await atomicCreate(blobPath, bytes);
    return;
  }
  if (await escapesDirReal(projectPath, blobPath)) {
    throw new Error("Security error: content blob escapes project boundary.");
  }
  const existing = await readFile(blobPath);
  if (createHash("sha256").update(existing).digest("hex") !== contentHash) {
    throw new Error(`Corrupted content blob "${contentHash}": stored bytes do not match the content hash.`);
  }
}

/**
 * Unlocked internal reader that also returns the verified retained content
 * bytes. Callers must hold the Project lock. This is the one canonical
 * Layer resolution site: identity, current revision, and content are read,
 * validated, and hash-verified here exactly once; metadata-only readers
 * project from it without a second read or a second verification.
 */
export async function readLayerInternalFull(
  projectPath: string,
  layerId: string,
): Promise<ResolvedLayer & { contentBytes: Buffer }> {
  if (!/^layer_[a-zA-Z0-9_]+$/.test(layerId)) {
    throw new Error(`Invalid Layer identity "${layerId}".`);
  }
  const resolvedRoot = path.resolve(projectPath);
  const layerFile = path.join(resolvedRoot, "layers", `${layerId}.json`);

  if (outsideDir(resolvedRoot, layerFile)) {
    throw new Error(`Security error: layer path "${layerId}" escapes project boundary.`);
  }

  if (await escapesDirReal(resolvedRoot, layerFile)) {
    throw new Error(`Security error: layer "${layerId}" escapes project boundary.`);
  }

  let identityRaw: string;
  try {
    identityRaw = await readFile(layerFile, "utf8");
  } catch {
    throw new Error(`Layer "${layerId}" not found in project.`);
  }


  let identity: LayerIdentity;
  try {
    identity = JSON.parse(identityRaw);
  } catch (err) {
    throw new Error(`Malformed Layer manifest for "${layerId}": ${(err as Error).message}`);
  }

  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error(`Malformed Layer manifest for "${layerId}": root must be an object.`);
  }
  if (!isStoredTimestamp(identity.createdAt)) {
    throw new Error(`Malformed Layer manifest for "${layerId}": missing or invalid createdAt.`);
  }
  if (typeof identity.currentRevision !== "string" || !/^rev_[0-9a-f]{16}$/.test(identity.currentRevision)) {
    throw new Error(`Malformed Layer manifest for "${layerId}": invalid currentRevision.`);
  }
  if (identity.schemaVersion !== LAYER_SCHEMA_VERSION) {
    throw new Error(`Unsupported layer schemaVersion ${identity.schemaVersion} for layer "${layerId}"`);
  }
  if (identity.id !== layerId) {
    throw new Error(
      `Malformed Layer manifest for "${layerId}": identity id "${identity.id}" does not match its file.`,
    );
  }

  const revHash = identity.currentRevision;
  const resolved = await readRevisionInternalFull(resolvedRoot, layerId, revHash);
  return {
    id: identity.id,
    createdAt: identity.createdAt,
    currentRevisionId: revHash,
    currentRevision: resolved.revision,
    contentBytes: resolved.contentBytes,
  };
}

/**
 * Resolve a pinned revision of a Layer by identity and revision id, without
 * consulting the Layer identity document (#87). This is the one canonical
 * revision-resolution site: the revision document is validated, hash-verified,
 * and its retained content blob is read and hash-verified here exactly once —
 * the same validation `readLayerInternalFull` performs for current revisions.
 * Historical replay (render manifests, #87) resolves through this reader, so
 * it never depends on current Layer pointers or Composition documents.
 *
 * Both pinned identifiers are strictly validated BEFORE any filesystem path
 * is constructed. Callers must hold the Project lock.
 */
export async function readRevisionInternalFull(
  projectPath: string,
  layerId: string,
  revisionId: string,
): Promise<{ revision: ResolvedLayerRevision; contentBytes: Buffer }> {
  if (!/^layer_[a-zA-Z0-9_]+$/.test(layerId)) {
    throw new Error(`Invalid Layer identity "${layerId}".`);
  }
  if (!/^rev_[0-9a-f]{16}$/.test(revisionId)) {
    throw new Error(`Invalid revision id "${revisionId}" for layer "${layerId}".`);
  }
  const resolvedRoot = path.resolve(projectPath);
  const revDir = path.join(resolvedRoot, "layers", `${layerId}.revisions`);
  const revFile = path.join(revDir, `${revisionId}.json`);

  if (outsideDir(resolvedRoot, revFile)) {
    throw new Error(`Security error: revision path for layer "${layerId}" escapes project boundary.`);
  }

  // Existence first: a missing revision gets its clear actionable failure,
  // never a raw filesystem error. Only an existing file is judged by its
  // resolved location, so an escaping alias is still refused.
  try {
    await lstat(revFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Revision "${revisionId}" for layer "${layerId}" not found in project.`);
    }
    throw err;
  }
  if (await escapesDirReal(resolvedRoot, revFile)) {
    throw new Error(`Security error: revision for layer "${layerId}" escapes project boundary.`);
  }

  const revRaw = await readFile(revFile, "utf8");

  let revision: LayerRevision;
  try {
    revision = JSON.parse(revRaw);
  } catch (err) {
    throw new Error(`Malformed revision document for layer "${layerId}": ${(err as Error).message}`);
  }

  // Canonical revision shape: the document must be a valid, self-consistent
  // revision of this Layer before anything downstream trusts it.
  if (!revision || typeof revision !== "object" || Array.isArray(revision)) {
    throw new Error(`Malformed revision document for "${layerId}": root must be an object.`);
  }
  if (!isStoredTimestamp(revision.createdAt)) {
    throw new Error(`Malformed revision document for "${layerId}": missing or invalid createdAt.`);
  }
  if (revision.schemaVersion !== LAYER_SCHEMA_VERSION) {
    throw new Error(`Unsupported revision schemaVersion ${revision.schemaVersion} for layer "${layerId}"`);
  }
  if (revision.layerId !== layerId) {
    throw new Error(
      `Malformed revision document "${revisionId}" for layer "${layerId}": layerId "${revision.layerId}" does not match.`,
    );
  }
  const storedKind = (revision as { kind?: unknown }).kind;
  if (storedKind !== "image" && storedKind !== "text") {
    throw new Error(
      `Malformed revision document "${revisionId}" for layer "${layerId}": unsupported kind "${String(storedKind)}".`,
    );
  }
  if (typeof revision.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(revision.contentHash)) {
    throw new Error(
      `Malformed revision document "${revisionId}" for layer "${layerId}": contentHash is not a sha-256 digest.`,
    );
  }
  if (revision.kind === "text") {
    // Canonical text content: validated here and at ingestion through the
    // same validator — no alternate representation exists.
    validateTextContent(revision.text, revision.fontSize, revision.color);
  }
  if (!Number.isFinite(revision.x) || !Number.isFinite(revision.y)) {
    throw new Error(
      `Malformed revision document "${revisionId}" for layer "${layerId}": x and y must be finite numbers.`,
    );
  }
  if (!Number.isFinite(revision.opacity) || revision.opacity < 0 || revision.opacity > 1) {
    throw new Error(
      `Malformed revision document "${revisionId}" for layer "${layerId}": opacity must be a finite number between 0 and 1.`,
    );
  }
  // Canonical transform scale: validated and normalized at this one boundary
  // (#133, ADR-0016) — malformed stored pairs are refused loudly before the
  // revision hash is consulted.
  const scale = normalizeStoredScale(revision);
  // Canonical transform rotation: validated and normalized at this same one
  // boundary (#134, ADR-0016) — a malformed stored field is refused loudly
  // before the revision hash is consulted.
  const rotationDeg = normalizeStoredRotation(revision);
  // Canonical transform reflection: validated and normalized at this same one
  // boundary (#135, ADR-0016) — malformed stored fields are refused loudly
  // before the revision hash is consulted.
  const flip = normalizeStoredFlip(revision);
  // Canonical shadow effect: validated and normalized at this same one
  // boundary (#139, ADR-0018) — a malformed stored field is refused loudly
  // before the revision hash is consulted. Absence IS the no-shadow form.
  const shadow = normalizeStoredShadow(revision);

  // The stored document must hash to exactly the pinned revision id
  if (computeRevisionHash(revision) !== revisionId) {
    throw new Error(
      `Corrupted revision document "${revisionId}" for layer "${layerId}": contents do not match the revision hash.`,
    );
  }

  // Read and verify content blob — existence first, then the resolved-location
  // gate, then the bytes (missing stays a clear failure, never raw ENOENT).
  const contentBlob = path.join(resolvedRoot, "content", revision.contentHash);
  if (outsideDir(resolvedRoot, contentBlob)) {
    throw new Error(`Security error: content blob escapes project boundary.`);
  }

  try {
    await lstat(contentBlob);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Content blob "${revision.contentHash}" for layer "${layerId}" missing in project.`);
    }
    throw err;
  }
  if (await escapesDirReal(resolvedRoot, contentBlob)) {
    throw new Error(`Security error: content blob for layer "${layerId}" escapes project boundary.`);
  }

  let contentBytes: Buffer;
  try {
    contentBytes = await readFile(contentBlob);
  } catch {
    throw new Error(`Content blob "${revision.contentHash}" for layer "${layerId}" missing in project.`);
  }

  // Retained bytes must still hash to the content identity the revision pins
  const actualHash = createHash("sha256").update(contentBytes).digest("hex");
  if (actualHash !== revision.contentHash) {
    throw new Error(
      `Corrupted content blob "${revision.contentHash}" for layer "${layerId}": stored bytes do not match the content hash.`,
    );
  }

  // Discriminated content resolution (#81): one resolver, one verification
  // pass, kind-specific projection. Image revisions derive intrinsic raster
  // facts from the verified bytes; text revisions carry their facts in the
  // hash-covered revision document and pin the retained font bytes.
  const resolved: ResolvedLayerRevision =
    revision.kind === "image"
      ? (() => {
          const meta = readRasterMeta(contentBytes, contentBlob);
          if (typeof meta === "string") {
            throw new Error(`Invalid content blob "${revision.contentHash}" for layer "${layerId}": ${meta}`);
          }
          return {
            schemaVersion: revision.schemaVersion,
            revisionId,
            layerId: revision.layerId,
            createdAt: revision.createdAt,
            kind: revision.kind,
            contentHash: revision.contentHash,
            x: revision.x,
            y: revision.y,
            opacity: revision.opacity,
            scaleX: scale.scaleX,
            scaleY: scale.scaleY,
            rotationDeg,
            flipX: flip.flipX,
            flipY: flip.flipY,
            ...(shadow !== undefined ? { shadow } : {}),
            format: meta.format,
            width: meta.width,
            height: meta.height,
            bytes: contentBytes.length,
          };
        })()
      : {
          schemaVersion: revision.schemaVersion,
          revisionId,
          layerId: revision.layerId,
          createdAt: revision.createdAt,
          kind: revision.kind,
          contentHash: revision.contentHash,
          x: revision.x,
          y: revision.y,
          opacity: revision.opacity,
          scaleX: scale.scaleX,
          scaleY: scale.scaleY,
          rotationDeg,
          flipX: flip.flipX,
          flipY: flip.flipY,
          ...(shadow !== undefined ? { shadow } : {}),
          text: revision.text,
          fontSize: revision.fontSize,
          color: revision.color,
          fontBytes: contentBytes.length,
        };

  return { revision: resolved, contentBytes };
}

/** Unlocked internal reader for Layer identity and its active revision. Callers must hold the Project lock. */
export async function readLayerInternal(projectPath: string, layerId: string): Promise<ResolvedLayer> {
  const full = await readLayerInternalFull(projectPath, layerId);
  return {
    id: full.id,
    createdAt: full.createdAt,
    currentRevisionId: full.currentRevisionId,
    currentRevision: full.currentRevision,
  };
}

/** Inspect a specific Layer in a Project (acquires Project lock for consistent snapshot). */
export async function inspectLayer(projectPath: string, layerId: string): Promise<ResolvedLayer> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, () => readLayerInternal(resolvedRoot, layerId));
}

/** List all Layers in a Project. */
export async function listLayers(projectPath: string): Promise<ResolvedLayer[]> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, async () => {
    const layersDir = path.join(resolvedRoot, "layers");
    const entries = await readdir(layersDir);
    const layerFiles = entries.filter((f) => f.endsWith(".json"));

    const layers: ResolvedLayer[] = [];
    for (const file of layerFiles) {
      const layerId = path.basename(file, ".json");
      const resolved = await readLayerInternal(resolvedRoot, layerId);
      layers.push(resolved);
    }
    return layers;
  });
}

export interface EditLayerOptions {
  inPlace?: boolean;
  /** Explicit fork intent (#85): publish a new Layer identity for one Composition use. */
  fork?: boolean;
  /** Fork target Composition (required with `fork`). */
  composition?: string;
  /** Fork target use local name (required with `fork`). */
  use?: string;
  image?: string;
  text?: string;
  font?: string;
  fontSize?: number;
  color?: string;
  x?: number;
  y?: number;
  opacity?: number;
  /**
   * Resize by a relative scale factor (#133, ADR-0016): multiplies the
   * Layer's current canonical scale. Mutually exclusive with `resizeTo` and
   * with content-replacement options — resizing changes placement, never
   * retained pixels, and one edit carries one intent.
   */
  resizeFactor?: number;
  /**
   * Resize to an absolute effective size in px (#133, ADR-0016): image Layers
   * only (text has no intrinsic pixel size until measurement exists). One
   * omitted axis preserves the Layer's current aspect ratio (a deliberate
   * both-axes change survives); both axes deliberately change it. Normalized
   * to canonical scale here at the edit boundary; never stored as
   * authoritative fields.
   */
  resizeTo?: { width?: number; height?: number };
  /**
   * Rotate the Layer to an ABSOLUTE angle in degrees (#134, ADR-0016): sets
   * the Layer's canonical rotation, replacing any previous angle — repeating
   * the same command keeps the same angle, and 0 removes the rotation. Unlike
   * the relative resize factor this is never incremental. Rotation is
   * independent of the retained content's size, so it combines freely with
   * other edit options, including content replacement and resize.
   */
  rotateDeg?: number;
  /**
   * Flip the Layer to an ABSOLUTE reflection state (#135, ADR-0016): sets the
   * Layer's canonical reflection, replacing any previous state — `horizontal`
   * mirrors along the content's own vertical axis (left–right), `vertical`
   * along its horizontal axis (top–bottom), `both` mirrors both axes, and
   * `none` removes the reflection. Like rotation this is never incremental:
   * the same command twice keeps the same state. Flip is independent of the
   * retained content's size, so it combines freely with other edit options,
   * including content replacement and resize.
   */
  flip?: "horizontal" | "vertical" | "both" | "none";
  /**
   * Apply a shadow to the Layer's content (#139, ADR-0018): an ABSOLUTE
   * setter that replaces any previous shadow — the same command twice keeps
   * the same shadow — and `"none"` removes it. The spec string is normalized
   * by `resolveEditShadow` against the current revision, so an omitted option
   * preserves the current revision's shadow. Independent of the retained
   * content's size, so it combines freely with other edit options including
   * content replacement and resize; it must not combine with --anchor, whose
   * resolution would see different ink than the edit publishes.
   */
  shadow?: string;
  /**
   * Generated-content ingestion (#107): explicitly replace an image Layer's
   * content with one selected output of a Generation Job, retaining the job's
   * provenance with the Project. Mutually exclusive with `image`; only valid
   * on image Layers (kind stability applies unchanged).
   */
  fromGeneration?: GenerationOutputSelection & { jobRoot: string; jobId: string };
  /**
   * Matting-content ingestion (#108): explicitly replace an image Layer's
   * content with the verified output of a published matte, retaining the
   * matte's provenance — and, derived from the source identity, any
   * predecessor generation provenance — with the Project. Mutually exclusive
   * with `image` and `fromGeneration`; only valid on image Layers (kind
   * stability applies unchanged). No engine runs and nothing generates.
   */
  fromMatte?: { matteRoot: string; matteId: string; generationRoot: string };
}

/** Canonical normalized edit intent (#85, DEC-003): the only shape the edit
 * lifecycle branches on. Normalized once at the entry of the edit path. */
type EditIntent =
  | { mode: "in-place" }
  | { mode: "fork"; composition: string; use: string };

/** Normalize and validate external edit intent into the canonical shape.
 * Flag misuse reaches here as a fail-fast guard; the CLI classifies the same
 * misuse as a usage error (exit 2) before invoking the edit. */
function normalizeEditIntent(options: EditLayerOptions): EditIntent {
  if (options.fork) {
    if (options.inPlace) {
      throw new Error("--fork and --in-place are mutually exclusive edit intents.");
    }
    if (!options.composition || options.composition.trim() === "") {
      throw new Error("Fork editing requires --composition <comp>: the Composition whose use is retargeted.");
    }
    if (!options.use || options.use.trim() === "") {
      throw new Error("Fork editing requires --use <local-name>: the use in the target Composition to retarget.");
    }
    return { mode: "fork", composition: options.composition, use: options.use };
  }
  if (options.composition !== undefined || options.use !== undefined) {
    throw new Error("--composition and --use are only valid together with --fork.");
  }
  return { mode: "in-place" };
}

export interface ForkInfo {
  previousLayerId: string;
  composition: string;
  use: string;
}

export interface EditLayerResult {
  layer: ResolvedLayer;
  referringCompositions: string[];
  referrersCount: number;
  /** Present only when the edit published a fork. */
  fork?: ForkInfo;
  /**
   * Present when the edit resized the Layer (#133): the absolute effective
   * scale (auditable across repeated relative resizes) and, for image Layers,
   * the absolute effective size in px. The scale is always reported; the
   * effective pixel size for text Layers awaits read-only measurement.
   */
  resized?: { scaleX: number; scaleY: number; width?: number; height?: number };
  /** Present when the edit rotated the Layer (#134): the absolute rotation in
   * degrees now recorded on the revision. */
  rotated?: { rotationDeg: number };
  /** Present when the edit flipped the Layer (#135): the absolute reflection
   * state now recorded on the revision. */
  flipped?: { flip: "horizontal" | "vertical" | "both" | "none" };
  /** Present when the edit set or removed the shadow (#139): the absolute
   * shadow state now recorded on the revision (null when removed). */
  shadowed?: { shadow: LayerShadow | null };
  /** Present only when the edit ingested generated content (#107). */
  generatedFrom?: { jobId: string; contentHash: string };
  /** Present only when the edit ingested matted content (#108). */
  mattedFrom?: { matteId: string; engine: string; contentHash: string };
}

/**
 * Unlocked internal scanner that discovers all Compositions in the Project
 * referencing a given Layer identity. Callers must hold the Project lock.
 *
 * Scans every composition JSON file in compositions/ using the canonical
 * parseCompositionDocument. Fails closed immediately if any Composition
 * document in the Project is unreadable or malformed, ensuring sharing is
 * never falsely assumed absent. Returns a sorted list of unique Composition
 * names.
 */
export async function findLayerReferrersInternal(
  projectPath: string,
  layerId: string,
): Promise<string[]> {
  const resolvedRoot = path.resolve(projectPath);
  const compDir = path.join(resolvedRoot, "compositions");

  if (outsideDir(resolvedRoot, compDir) || (await escapesDirReal(resolvedRoot, compDir))) {
    throw new Error("Security error: compositions directory escapes project boundary.");
  }

  let entries: string[];
  try {
    entries = await readdir(compDir);
  } catch (err) {
    throw new Error(`Cannot read compositions directory: ${(err as Error).message}`);
  }

  const compFiles = entries.filter((f) => f.endsWith(".json")).sort();
  const referringCompositions: string[] = [];

  for (const file of compFiles) {
    const compName = path.basename(file, ".json");
    const compFile = path.join(compDir, file);

    if (outsideDir(resolvedRoot, compFile) || (await escapesDirReal(resolvedRoot, compFile))) {
      throw new Error(`Security error: composition "${compName}" escapes project boundary.`);
    }

    let raw: string;
    try {
      raw = await readFile(compFile, "utf8");
    } catch (err) {
      throw new Error(`Cannot read composition document "${compName}": ${(err as Error).message}`);
    }

    // Fail closed: if ANY composition is malformed, reject immediately
    const comp = parseCompositionDocument(raw, compName);

    if (comp.layers.some((use) => use.layerId === layerId)) {
      referringCompositions.push(compName);
    }
  }

  return referringCompositions;
}

/**
 * Discover all Compositions referencing a Layer (acquires Project lock for consistent snapshot).
 */
export async function findLayerReferrers(projectPath: string, layerId: string): Promise<string[]> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, () => findLayerReferrersInternal(resolvedRoot, layerId));
}

/** Placement values for an edited revision: explicit options win, omitted values preserve the current revision. */
function resolveEditPlacement(options: EditLayerOptions, prevRev: LayerRevision): { x: number; y: number; opacity: number } {
  const x = options.x !== undefined ? options.x : prevRev.x;
  const y = options.y !== undefined ? options.y : prevRev.y;
  const opacity = options.opacity !== undefined ? options.opacity : prevRev.opacity;

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Invalid placement (${options.x}, ${options.y}): x and y must be finite numbers.`);
  }
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new Error(`Invalid opacity ${options.opacity}: must be a finite number between 0 and 1.`);
  }
  return { x, y, opacity };
}

/**
 * Canonical rotation normalization (#134, ADR-0016): `--rotate` sets an
 * ABSOLUTE angle in degrees, replacing any previous rotation. Omitted option
 * preserves the current revision's rotation. The refusal runs before any
 * staging, so an invalid angle never advances live state.
 */
function resolveEditRotation(options: EditLayerOptions, prevRev: ResolvedLayerRevision): number {
  if (options.rotateDeg === undefined) {
    return prevRev.rotationDeg;
  }
  const deg = options.rotateDeg;
  if (!Number.isFinite(deg)) {
    throw new Error(`Invalid rotation ${deg}: --rotate takes a finite number of degrees (clockwise positive).`);
  }
  return deg;
}

/**
 * Canonical reflection normalization (#135, ADR-0016): `--flip` sets an
 * ABSOLUTE reflection state, replacing any previous one. Omitted option
 * preserves the current revision's reflection. The refusal runs before any
 * staging, so an invalid mode never advances live state.
 */
function resolveEditFlip(options: EditLayerOptions, prevRev: ResolvedLayerRevision): LayerTransformFlip {
  if (options.flip === undefined) {
    return { flipX: prevRev.flipX, flipY: prevRev.flipY };
  }
  switch (options.flip) {
    case "horizontal":
      return { flipX: true, flipY: false };
    case "vertical":
      return { flipX: false, flipY: true };
    case "both":
      return { flipX: true, flipY: true };
    case "none":
      return { flipX: false, flipY: false };
    default:
      throw new Error(
        `Invalid flip "${String(options.flip)}": --flip takes horizontal, vertical, both, or none.`,
      );
  }
}

/**
 * Canonical shadow normalization (#139, ADR-0018): `--shadow` sets an ABSOLUTE
 * shadow, replacing any previous one; `"none"` removes it. Omitted option
 * preserves the current revision's shadow. Every refusal runs before any
 * staging, so an invalid shadow never advances live state. Exported for the
 * CLI boundary: the command classifies malformed specs as usage errors
 * (exit 2) with this same parser, so the two never disagree.
 */
export function parseShadowSpec(spec: string, prev?: LayerShadow): LayerShadow | undefined {
  const raw = spec.trim();
  if (raw.toLowerCase() === "none") {
    return undefined;
  }
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== 4) {
    throw new Error(
      `Invalid shadow "${raw}": --shadow takes "<dx>,<dy>,<blur>,<color>" (e.g. "10,10,4,#000000") or "none".`,
    );
  }
  const [dxRaw, dyRaw, blurRaw, colorRaw] = parts;
  const dx = Number(dxRaw);
  const dy = Number(dyRaw);
  const blur = Number(blurRaw);
  const color = colorRaw ?? "";
  if (dxRaw === "" || dyRaw === "" || blurRaw === "" || color === "") {
    throw new Error(
      `Invalid shadow "${raw}": --shadow takes "<dx>,<dy>,<blur>,<color>" (e.g. "10,10,4,#000000") or "none".`,
    );
  }
  for (const [label, value] of [["dx", dx], ["dy", dy]] as const) {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_SHADOW_OFFSET_PX) {
      throw new Error(
        `Invalid shadow offset ${label} ${dxRaw}: must be a finite number of px within ±${MAX_SHADOW_OFFSET_PX}.`,
      );
    }
  }
  if (!Number.isFinite(blur) || blur < 0 || blur > MAX_SHADOW_BLUR_PX) {
    throw new Error(
      `Invalid shadow blur ${blurRaw}: must be a finite number of px between 0 and ${MAX_SHADOW_BLUR_PX}.`,
    );
  }
  if (!SHADOW_COLOR_PATTERN.test(color)) {
    throw new Error(
      `Invalid shadow color "${color}": must be a hex color like #000000, #000, or #00000080.`,
    );
  }
  return { dx, dy, blur, color };
}

/**
 * Canonical shadow edit resolution (#139, ADR-0018): an omitted option
 * preserves the current revision's shadow; a spec sets or removes it
 * absolutely. The refusal runs before any staging, so an invalid shadow
 * never advances live state.
 */
function resolveEditShadow(options: EditLayerOptions, prevRev: ResolvedLayerRevision): LayerShadow | undefined {
  if (options.shadow === undefined) {
    return prevRev.shadow;
  }
  return parseShadowSpec(options.shadow, prevRev.shadow);
}

/** Rendered effective size rounds to hundredths of a px: auditable display of the scale's effect. */
export function roundEffective(px: number): number {
  return Math.round(px * 100) / 100;
}

/**
 * Canonical resize normalization (#133, ADR-0016): scale factors are the one
 * authoritative transform representation; width/height conveniences become
 * scale here at the edit boundary, against the retained content's intrinsic
 * size. Every refusal runs before any staging, so an invalid or conflicting
 * resize never advances live state.
 *
 * Omitted resize options preserve the current revision's scale. Aspect-ratio
 * rules: a relative factor preserves the current ratio by definition; an
 * absolute target with one omitted axis preserves the Layer's current aspect
 * ratio (a deliberate both-axes change survives, never reset to intrinsic);
 * both axes supplied deliberately change it.
 */
function resolveEditScale(
  options: EditLayerOptions,
  prevRev: ResolvedLayerRevision,
  layerId: string,
): LayerTransformScale {
  const hasFactor = options.resizeFactor !== undefined;
  const hasTarget = options.resizeTo !== undefined;
  if (!hasFactor && !hasTarget) {
    return { scaleX: prevRev.scaleX, scaleY: prevRev.scaleY };
  }

  if (hasFactor && hasTarget) {
    throw new Error("--resize and --resize-to are mutually exclusive resize forms: use one per edit.");
  }
  const replacesContent =
    options.image !== undefined || options.fromGeneration !== undefined || options.fromMatte !== undefined;
  if (replacesContent) {
    throw new Error(
      `Resize and content replacement are separate edits: Layer "${layerId}" cannot replace its source and resize in one edit, because the resize reference size would be ambiguous.`,
    );
  }

  if (hasFactor) {
    const factor = options.resizeFactor!;
    if (!Number.isFinite(factor) || factor <= 0 || factor > MAX_DIMENSION) {
      throw new Error(
        `Invalid resize factor ${factor}: must be a finite number between 0 and ${MAX_DIMENSION}.`,
      );
    }
    return boundedScale({ scaleX: prevRev.scaleX * factor, scaleY: prevRev.scaleY * factor }, prevRev, layerId);
  }

  if (prevRev.kind === "text") {
    throw new Error(
      `--resize-to needs an intrinsic pixel size: Layer "${layerId}" is a text Layer — use --resize <factor>.`,
    );
  }
  const { width, height } = options.resizeTo!;
  for (const [label, value] of [["width", width], ["height", height]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > MAX_DIMENSION)) {
      throw new Error(
        `Invalid resize target ${label} ${value}: must be a finite number between 0 and ${MAX_DIMENSION}.`,
      );
    }
  }
  if (width === undefined && height === undefined) {
    throw new Error("Invalid resize target: --resize-to needs at least one of width or height.");
  }
  let scaleX: number;
  let scaleY: number;
  if (width !== undefined && height !== undefined) {
    // Both axes supplied: the aspect change is deliberate, not accidental.
    scaleX = width / prevRev.width;
    scaleY = height / prevRev.height;
  } else if (width !== undefined) {
    // One axis supplied: preserve the Layer's CURRENT aspect ratio — a
    // deliberate both-axes change is explicitly kept, never silently reset
    // to the intrinsic ratio (#133, ADR-0016). For a uniform prior this is
    // exactly intrinsic-ratio preservation.
    scaleX = width / prevRev.width;
    scaleY = (scaleX * prevRev.scaleY) / prevRev.scaleX;
  } else {
    scaleY = height! / prevRev.height;
    scaleX = (scaleY * prevRev.scaleX) / prevRev.scaleY;
  }
  return boundedScale({ scaleX, scaleY }, prevRev, layerId);
}

/** Shared effective-size bound (#133): the scaled result shares the existing
 * content-dimension cap so no second constant exists. Refuses before staging. */
function boundedScale(
  scale: LayerTransformScale,
  prevRev: ResolvedLayerRevision,
  layerId: string,
): LayerTransformScale {
  if (prevRev.kind === "image") {
    const width = roundEffective(prevRev.width * scale.scaleX);
    const height = roundEffective(prevRev.height * scale.scaleY);
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw new Error(
        `Resize result ${width}×${height}px is over the ${MAX_DIMENSION}px per-axis limit for Layer "${layerId}".`,
      );
    }
  } else if (scale.scaleX > MAX_DIMENSION || scale.scaleY > MAX_DIMENSION) {
    throw new Error(`Resize scale over the ${MAX_DIMENSION} limit for Layer "${layerId}".`);
  }
  return scale;
}

/**
 * Canonical edited-revision construction shared by in-place and fork editing
 * (#85): one home for kind stability, content ingestion/validation, and
 * field preservation, so no publication path can build a divergent revision.
 *
 * Returns the fully formed revision document for `layerId`/`createdAt` plus
 * whether every field is identical to the current revision. In-place editing
 * uses `unchanged` to skip storage churn; fork ignores it because an explicit
 * fork always publishes a new identity, even with unchanged content.
 */
async function buildEditedRevision(
  resolvedRoot: string,
  prevRev: ResolvedLayerRevision,
  layerId: string,
  createdAt: string,
  options: EditLayerOptions,
  placement: { x: number; y: number; opacity: number },
  scale: LayerTransformScale,
  rotationDeg: number,
  flip: LayerTransformFlip,
  shadow: LayerShadow | undefined,
): Promise<{
  revision: LayerRevision;
  unchanged: boolean;
  /** Present when this edit ingested matted content (#108). */
  mattedFrom?: EditLayerResult["mattedFrom"];
  /** Present when the ingested matte's source was a retained generation output (#108). */
  retainedGeneration: RetainedGenerationProvenance | null;
}> {
  const { x, y, opacity } = placement;

  if (prevRev.kind === "image") {
    // Incompatible text options passed to image layer
    if (
      options.text !== undefined ||
      options.font !== undefined ||
      options.fontSize !== undefined ||
      options.color !== undefined
    ) {
      throw new Error(`Cannot edit text attributes on an image Layer. Layer "${layerId}" is an image Layer.`);
    }

    let contentHash = prevRev.contentHash;
    let mattedFrom: EditLayerResult["mattedFrom"];
    let retainedGeneration: RetainedGenerationProvenance | null = null;
    if (options.fromGeneration !== undefined) {
      // Generated-content ingestion (#107): verify the selected output's bytes
      // against the recorded identity, retain the pixels in the content store,
      // and retain the record verbatim — all before any revision staging, so
      // the bytes, provenance, and revision publish coherently under the same
      // publication protocol and the same rollback discipline.
      const selected = await selectGenerationOutput(
        options.fromGeneration.jobRoot,
        options.fromGeneration.jobId,
        { output: options.fromGeneration.output },
      );
      const validated = await validateImageBytes(
        selected.bytes,
        `Generation Job "${selected.job.jobId}" output "${selected.output.file}"`,
      );
      await storeContentBlob(resolvedRoot, validated.contentHash, validated.bytes);
      await retainGenerationRecord(resolvedRoot, selected.job.jobId, selected.recordBytes);
      contentHash = validated.contentHash;
    } else if (options.fromMatte !== undefined) {
      // Matted-content ingestion (#108): verify the matte's output bytes
      // against the recorded identity, retain the pixels in the content
      // store, and retain the matte record verbatim — all before any revision
      // staging, under the same publication protocol and rollback discipline
      // as every other content source. When the matte's source was a
      // published generation output, that job's record is retained verbatim
      // too (derived linkage; no second copy of the request facts). No
      // engine runs and nothing generates: this reads an existing result.
      const selected = await selectMatteOutput(options.fromMatte.matteRoot, options.fromMatte.matteId);
      const validated = await validateImageBytes(
        selected.bytes,
        `Matte "${selected.matte.matteId}" output "${selected.output.file}"`,
      );
      // Everything that can refuse the source (record parse, output hash,
      // decode, predecessor ambiguity) runs before any Project write, so a
      // refusal leaves no partial retention.
      const predecessor = await findGenerationPredecessor(
        options.fromMatte.generationRoot,
        selected.matte.request.source.contentHash,
      );
      await storeContentBlob(resolvedRoot, validated.contentHash, validated.bytes);
      await retainMattingRecord(resolvedRoot, selected.matte.matteId, selected.recordBytes);
      if (predecessor) {
        await retainGenerationRecord(resolvedRoot, predecessor.job.jobId, predecessor.recordBytes);
        retainedGeneration = {
          jobId: predecessor.job.jobId,
          job: predecessor.job,
          output: predecessor.job.run.outputs.find(
            (o) => o.contentHash === selected.matte.request.source.contentHash,
          )!,
        };
      }
      contentHash = validated.contentHash;
      mattedFrom = { matteId: selected.matte.matteId, engine: selected.matte.result.engine, contentHash: validated.contentHash };
    } else if (options.image !== undefined) {
      const ingested = await validateAndIngestImage(options.image);
      await storeContentBlob(resolvedRoot, ingested.contentHash, ingested.bytes);
      contentHash = ingested.contentHash;
    }

    const revision: LayerRevision = {
      schemaVersion: LAYER_SCHEMA_VERSION,
      layerId,
      createdAt,
      kind: "image",
      contentHash,
      x,
      y,
      opacity,
      scaleX: scale.scaleX,
      scaleY: scale.scaleY,
      rotationDeg,
      flipX: flip.flipX,
      flipY: flip.flipY,
      ...(shadow !== undefined ? { shadow } : {}),
    };
    const unchanged =
      contentHash === prevRev.contentHash && x === prevRev.x && y === prevRev.y && opacity === prevRev.opacity &&
      scale.scaleX === prevRev.scaleX && scale.scaleY === prevRev.scaleY &&
      rotationDeg === prevRev.rotationDeg &&
      flip.flipX === prevRev.flipX && flip.flipY === prevRev.flipY &&
      shadow === prevRev.shadow;
    return { revision, unchanged, mattedFrom, retainedGeneration };
  }

  if (prevRev.kind === "text") {
    // Incompatible image option passed to text layer
    if (options.fromGeneration !== undefined) {
      throw new Error(
        `Cannot replace content from a Generation Job on a text Layer. Layer "${layerId}" is a text Layer.`,
      );
    }
    if (options.fromMatte !== undefined) {
      throw new Error(
        `Cannot replace content from a matte on a text Layer. Layer "${layerId}" is a text Layer.`,
      );
    }
    if (options.image !== undefined) {
      throw new Error(`Cannot edit image source on a text Layer. Layer "${layerId}" is a text Layer.`);
    }

    let contentHash = prevRev.contentHash;
    if (options.font !== undefined) {
      const face = resolveFace(options.font);
      const bytes = fontAssetBytes(face);
      const fontHash = createHash("sha256").update(bytes).digest("hex");
      await storeContentBlob(resolvedRoot, fontHash, bytes);
      contentHash = fontHash;
    }

    const text = options.text !== undefined ? options.text : prevRev.text;
    const fontSize = options.fontSize !== undefined ? options.fontSize : prevRev.fontSize;
    const color = options.color !== undefined ? options.color : prevRev.color;

    // Canonical text validation
    validateTextContent(text, fontSize, color);

    const revision: LayerRevision = {
      schemaVersion: LAYER_SCHEMA_VERSION,
      layerId,
      createdAt,
      kind: "text",
      contentHash,
      text,
      fontSize,
      color,
      x,
      y,
      opacity,
      scaleX: scale.scaleX,
      scaleY: scale.scaleY,
      rotationDeg,
      flipX: flip.flipX,
      flipY: flip.flipY,
      ...(shadow !== undefined ? { shadow } : {}),
    };
    const unchanged =
      contentHash === prevRev.contentHash &&
      text === prevRev.text &&
      fontSize === prevRev.fontSize &&
      color === prevRev.color &&
      x === prevRev.x &&
      y === prevRev.y &&
      opacity === prevRev.opacity &&
      scale.scaleX === prevRev.scaleX &&
      scale.scaleY === prevRev.scaleY &&
      rotationDeg === prevRev.rotationDeg &&
      flip.flipX === prevRev.flipX &&
      flip.flipY === prevRev.flipY &&
      shadow === prevRev.shadow;
    return { revision, unchanged, retainedGeneration: null };
  }

  throw new Error(`Unsupported Layer kind on layer "${layerId}".`);
}

/**
 * Validate the fork target against the canonical target/use→original-id rule
 * (#85): the Composition must exist and parse, the selected use must exist in
 * it, and that use must reference the Layer being forked. Composition
 * boundary containment, canonical parsing, and reference-resolution
 * verification are all delegated to the one canonical pre-mutation reader
 * `readMutableComposition` (#85, local review CRAFT-1) — the only fork-"
 * specific checks here are the use lookup and the id match. Callers must
 * hold the Project lock.
 */
async function resolveForkTarget(
  resolvedRoot: string,
  composition: string,
  useName: string,
  originalLayerId: string,
): Promise<{ comp: Composition; compFile: string }> {
  const { comp, compFile } = await readMutableComposition(resolvedRoot, composition);

  const targetUse = comp.layers.find((u) => u.name === useName);
  if (!targetUse) {
    throw new Error(`Use "${useName}" not found in composition "${composition}".`);
  }
  if (targetUse.layerId !== originalLayerId) {
    throw new Error(
      `Use "${useName}" in composition "${composition}" references Layer "${targetUse.layerId}", not "${originalLayerId}".`,
    );
  }

  return { comp, compFile };
}

/**
 * Fork publication (#85): stage the new identity and edited revision, then
 * retarget ONLY the selected use in the target Composition as the live commit
 * point. Other uses keep their raw fields; the original identity, its
 * revisions, and its content are never touched. Caught-error cleanup removes
 * only the newly staged identity/revision — never old content or history.
 * Callers must hold the Project lock.
 */
async function publishForkEdit(
  resolvedRoot: string,
  originalLayerId: string,
  fork: { composition: string; use: string },
  target: { comp: Composition; compFile: string },
  newLayerId: string,
  revision: LayerRevision,
  refs: { referringCompositions: string[]; referrersCount: number },
): Promise<EditLayerResult> {
  const { comp, compFile } = target;
  const revHash = computeRevisionHash(revision);
  const revDir = path.join(resolvedRoot, "layers", `${newLayerId}.revisions`);
  const revFile = path.join(revDir, `${revHash}.json`);
  const identityFile = path.join(resolvedRoot, "layers", `${newLayerId}.json`);

  await mkdir(revDir, { recursive: true });

  let stagedRevision = false;
  let stagedIdentity = false;
  try {
    await atomicCreate(revFile, JSON.stringify(revision, null, 2) + "\n");
    stagedRevision = true;

    const identity: LayerIdentity = {
      schemaVersion: LAYER_SCHEMA_VERSION,
      id: newLayerId,
      createdAt: revision.createdAt,
      currentRevision: revHash,
    };

    await atomicCreate(identityFile, JSON.stringify(identity, null, 2) + "\n");
    stagedIdentity = true;

    // Resolve the staged Layer before the live commit (publication protocol).
    await readLayerInternal(resolvedRoot, newLayerId);

    // Live Commit Point: retarget only the selected use, preserving every
    // other raw document/use field.
    const updatedComp: Composition = {
      ...comp,
      layers: comp.layers.map((use) => (use.name === fork.use ? { name: use.name, layerId: newLayerId } : use)),
    };

    await atomicReplace(compFile, JSON.stringify(updatedComp, null, 2) + "\n");
  } catch (err) {
    if (stagedIdentity) {
      await unlink(identityFile).catch(() => {});
    }
    if (stagedRevision) {
      await unlink(revFile).catch(() => {});
      await rmdir(revDir).catch(() => {}); // remove the now-empty revision directory
    }
    throw err;
  }

  const layer = await readLayerInternal(resolvedRoot, newLayerId);
  return {
    layer,
    referringCompositions: refs.referringCompositions,
    referrersCount: refs.referrersCount,
    fork: { previousLayerId: originalLayerId, composition: fork.composition, use: fork.use },
  };
}

/**
 * Unlocked internal editor for Layer identity and revision advancement.
 * Callers must hold the Project lock.
 */
export async function editLayerInternal(
  projectPath: string,
  layerId: string,
  options: EditLayerOptions,
): Promise<EditLayerResult> {
  const resolvedRoot = path.resolve(projectPath);
  const current = await readLayerInternalFull(resolvedRoot, layerId);
  const prevRev = current.currentRevision;

  // Generated-content (#107) and matted-content (#108) ingestion and file
  // ingestion are mutually exclusive content options — one edit replaces
  // content from one source.
  if (options.image !== undefined && options.fromGeneration !== undefined) {
    throw new Error("--image and --from-generation are mutually exclusive content options.");
  }
  if (options.image !== undefined && options.fromMatte !== undefined) {
    throw new Error("--image and --from-matte are mutually exclusive content options.");
  }
  if (options.fromGeneration !== undefined && options.fromMatte !== undefined) {
    throw new Error("--from-generation and --from-matte are mutually exclusive content options.");
  }

  // Normalize intent once into the canonical discriminated shape (#85).
  const intent = normalizeEditIntent(options);

  // 1. Authoritative referrer discovery under the Project lock (fail-closed)
  const referringCompositions = await findLayerReferrersInternal(resolvedRoot, layerId);
  const referrersCount = referringCompositions.length;

  // 2. Blast-radius guard: in-place editing only; a fork changes exactly one
  //    use in one Composition, so it never needs the propagation flag.
  if (intent.mode === "in-place" && referrersCount > 1 && !options.inPlace) {
    const namesList = referringCompositions.map((n) => `"${n}"`).join(", ");
    const err = new Error(
      `Layer "${layerId}" is referenced by ${referrersCount} Compositions (${namesList}). ` +
        `Editing it in-place will affect all of them. Pass --in-place to confirm, or fork into an independent Layer.`,
    );
    (err as unknown as { referringCompositions: string[]; referrersCount: number }).referringCompositions =
      referringCompositions;
    (err as unknown as { referringCompositions: string[]; referrersCount: number }).referrersCount =
      referrersCount;
    throw err;
  }

  // 3. Placement and transform-scale options: preserve existing values if omitted
  const placement = resolveEditPlacement(options, prevRev);
  const scale = resolveEditScale(options, prevRev, layerId);
  const rotationDeg = resolveEditRotation(options, prevRev);
  const flip = resolveEditFlip(options, prevRev);
  // Shadow effect (#139, ADR-0018): absolute setter, refusal before staging.
  const shadow = resolveEditShadow(options, prevRev);
  const hasShadow = options.shadow !== undefined;
  const shadowedReport = { shadow: shadow ?? null };
  // Absolute effective facts for the result (#133): the scale is authoritative
  // and always reported; image Layers additionally report the effective size
  // the scale produces from the retained content's intrinsic dimensions.
  const resizedReport =
    prevRev.kind === "image"
      ? {
          scaleX: scale.scaleX,
          scaleY: scale.scaleY,
          width: roundEffective(prevRev.width * scale.scaleX),
          height: roundEffective(prevRev.height * scale.scaleY),
        }
      : { scaleX: scale.scaleX, scaleY: scale.scaleY };
  const hasResize = options.resizeFactor !== undefined || options.resizeTo !== undefined;
  const hasRotate = options.rotateDeg !== undefined;
  const rotatedReport = { rotationDeg };
  // Narrowed once: a defined flip is always a validated literal mode, so the
  // report never needs a cast (and absence means no --flip option was given).
  const flippedReport =
    options.flip !== undefined ? { flip: options.flip } : undefined;

  if (intent.mode === "fork") {
    // Canonical target/use→original-id validation before any content work.
    const target = await resolveForkTarget(resolvedRoot, intent.composition, intent.use, layerId);

    // New identity + edited revision through the shared canonical builder.
    const newLayerId = generateLayerId();
    const createdAt = new Date().toISOString();
    const { revision, mattedFrom, retainedGeneration } = await buildEditedRevision(
      resolvedRoot,
      prevRev,
      newLayerId,
      createdAt,
      options,
      placement,
      scale,
      rotationDeg,
      flip,
      shadow,
    );
    // An explicit fork always publishes the new identity, even when the
    // edited revision is field-identical to the current one (documented
    // no-content-change fork).
    const forkResult = await publishForkEdit(resolvedRoot, layerId, intent, target, newLayerId, revision, {
      referringCompositions,
      referrersCount,
    });
    const withResized = hasResize ? { ...forkResult, resized: resizedReport } : forkResult;
    const withRotated = hasRotate ? { ...withResized, rotated: rotatedReport } : withResized;
    const withFlipped = flippedReport ? { ...withRotated, flipped: flippedReport } : withRotated;
    const withShadow = hasShadow ? { ...withFlipped, shadowed: shadowedReport } : withFlipped;
    return options.fromGeneration !== undefined
      ? { ...withShadow, generatedFrom: { jobId: options.fromGeneration.jobId, contentHash: revision.contentHash } }
      : mattedFrom !== undefined
        ? {
            ...withShadow,
            mattedFrom,
            ...(retainedGeneration
              ? { generatedFrom: { jobId: retainedGeneration.jobId, contentHash: revision.contentHash } }
              : {}),
          }
        : withShadow;
  }

  // 4. Shared canonical edited-revision construction (in-place)
  const { revision, unchanged, mattedFrom, retainedGeneration } = await buildEditedRevision(
    resolvedRoot,
    prevRev,
    layerId,
    new Date().toISOString(),
    options,
    placement,
    scale,
    rotationDeg,
    flip,
    shadow,
  );

  // No-op check: if all fields are identical to previous revision, avoid storage churn
  if (unchanged) {
    const resolved = await readLayerInternal(resolvedRoot, layerId);
    return {
      layer: resolved,
      referringCompositions,
      referrersCount,
      ...(hasResize ? { resized: resizedReport } : {}),
      ...(hasRotate ? { rotated: rotatedReport } : {}),
      ...(flippedReport ? { flipped: flippedReport } : {}),
      ...(hasShadow ? { shadowed: shadowedReport } : {}),
      ...(options.fromGeneration !== undefined
        ? { generatedFrom: { jobId: options.fromGeneration.jobId, contentHash: revision.contentHash } }
        : {}),
      ...(mattedFrom !== undefined
        ? {
            mattedFrom,
            ...(retainedGeneration
              ? { generatedFrom: { jobId: retainedGeneration.jobId, contentHash: revision.contentHash } }
              : {}),
          }
        : {}),
    };
  }

  // 5. Compute new revision hash and stage revision document
  const revHash = computeRevisionHash(revision);
  const revDir = path.join(resolvedRoot, "layers", `${layerId}.revisions`);
  const revFile = path.join(revDir, `${revHash}.json`);
  const identityFile = path.join(resolvedRoot, "layers", `${layerId}.json`);

  await mkdir(revDir, { recursive: true });

  let stagedRevision = false;
  try {
    await atomicCreate(revFile, JSON.stringify(revision, null, 2) + "\n");
    stagedRevision = true;

    const identity: LayerIdentity = {
      schemaVersion: LAYER_SCHEMA_VERSION,
      id: layerId,
      createdAt: current.createdAt,
      currentRevision: revHash,
    };

    // 6. Live commit point: update Layer identity currentRevision
    await atomicReplace(identityFile, JSON.stringify(identity, null, 2) + "\n");
  } catch (err) {
    if (stagedRevision) {
      await unlink(revFile).catch(() => {});
    }
    throw err;
  }

  const updatedLayer = await readLayerInternal(resolvedRoot, layerId);
  return {
    layer: updatedLayer,
    referringCompositions,
    referrersCount,
    ...(hasResize ? { resized: resizedReport } : {}),
    ...(hasRotate ? { rotated: rotatedReport } : {}),
    ...(flippedReport ? { flipped: flippedReport } : {}),
    ...(hasShadow ? { shadowed: shadowedReport } : {}),
    ...(options.fromGeneration !== undefined
      ? { generatedFrom: { jobId: options.fromGeneration.jobId, contentHash: revision.contentHash } }
      : {}),
    ...(mattedFrom !== undefined
      ? {
          mattedFrom,
          ...(retainedGeneration
            ? { generatedFrom: { jobId: retainedGeneration.jobId, contentHash: revision.contentHash } }
            : {}),
        }
      : {}),
  };
}

/**
 * Edit a Layer in a Project (acquires Project lock for consistent discovery and atomic publication).
 */
export async function editLayer(
  projectPath: string,
  layerId: string,
  options: EditLayerOptions,
): Promise<EditLayerResult> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, () => editLayerInternal(resolvedRoot, layerId, options));
}

