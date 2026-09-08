import { isStoredTimestamp } from "./stored-schema.js";
/**
 * Layer identity, immutable revisions, and content-addressed image/text
 * ingestion (ADR-0013, ADR-0014, DEC-001–006, #81).
 */
import { createHash } from "node:crypto";
import { open as fsOpen, readFile, readdir, lstat, mkdir, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { MAX_DIMENSION, MAX_ENCODED_BYTES, MAX_PIXELS, decodePng } from "./png.js";
import { readRasterMeta, type RasterMeta } from "./raster-meta.js";
import { escapesDirReal, outsideDir } from "./paths.js";
import { atomicCreate, atomicReplace, withProjectLock } from "./project-lock.js";
import { resolveProjectRoot } from "./project.js";
import { withRenderPage } from "./browser.js";
import { parseCompositionDocument } from "./composition.js";
import { resolveFace, fontAssetBytes } from "./fonts.js";

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

export type ResolvedLayerRevision =
  | (LayerImageRevision & { revisionId: string; format: "png" | "jpeg" | "webp"; width: number; height: number; bytes: number })
  | (LayerTextRevision & { revisionId: string; fontBytes: number });

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

  let bytes: Buffer;
  let meta: RasterMeta;
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

    bytes = Buffer.alloc(st.size);
    let totalRead = 0;
    while (totalRead < bytes.length) {
      const { bytesRead } = await fh.read(bytes, totalRead, bytes.length - totalRead, totalRead);
      if (bytesRead <= 0) {
        throw new Error(`"${imagePath}" changed while being read`);
      }
      totalRead += bytesRead;
    }

    const rasterMeta = readRasterMeta(bytes, imagePath);
    if (typeof rasterMeta === "string") {
      throw new Error(rasterMeta);
    }
    meta = rasterMeta;

    if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) {
      throw new Error(
        `"${imagePath}" declares a ${meta.width}×${meta.height} canvas — over the ${MAX_DIMENSION}px per-axis limit`,
      );
    }
    if (meta.width * meta.height > MAX_PIXELS) {
      throw new Error(
        `"${imagePath}" declares ${meta.width}×${meta.height} — over the ${MAX_PIXELS.toLocaleString("en-US")}-pixel limit`,
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
            throw new Error(`Corrupted PNG image "${imagePath}": ${errMsg}`);
          }
        } else {
          // Real corruption (bad CRC, truncated IDAT, etc.)
          throw new Error(`Corrupted PNG image "${imagePath}": ${errMsg}`);
        }
      }
    } else {
      try {
        const browserDecoded = await decodeInBrowser(bytes, meta.format);
        decodedWidth = browserDecoded.width;
        decodedHeight = browserDecoded.height;
      } catch (browserErr) {
        throw new Error(`Corrupted ${meta.format.toUpperCase()} image "${imagePath}": ${(browserErr as Error).message}`);
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

/** Compute content-derived revision hash for an immutable revision record. */
export function computeRevisionHash(rev: LayerRevision): string {
  const base = `${rev.layerId}:${rev.kind}:${rev.contentHash}:${rev.x}:${rev.y}:${rev.opacity}:${rev.createdAt}`;
  const payload =
    rev.kind === "text" ? `${base}:${rev.text}:${rev.fontSize}:${rev.color}` : base;
  return `rev_${createHash("sha256").update(payload).digest("hex").slice(0, 16)}`;
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
  const revDir = path.join(resolvedRoot, "layers", `${layerId}.revisions`);
  const revFile = path.join(revDir, `${revHash}.json`);

  if (outsideDir(resolvedRoot, revFile)) {
    throw new Error(`Security error: revision path for layer "${layerId}" escapes project boundary.`);
  }

  if (await escapesDirReal(resolvedRoot, revFile)) {
    throw new Error(`Security error: revision for layer "${layerId}" escapes project boundary.`);
  }

  let revRaw: string;
  try {
    revRaw = await readFile(revFile, "utf8");
  } catch {
    throw new Error(`Current revision "${revHash}" for layer "${layerId}" not found.`);
  }


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
      `Malformed revision document "${revHash}" for layer "${layerId}": layerId "${revision.layerId}" does not match.`,
    );
  }
  const storedKind = (revision as { kind?: unknown }).kind;
  if (storedKind !== "image" && storedKind !== "text") {
    throw new Error(
      `Malformed revision document "${revHash}" for layer "${layerId}": unsupported kind "${String(storedKind)}".`,
    );
  }
  if (typeof revision.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(revision.contentHash)) {
    throw new Error(
      `Malformed revision document "${revHash}" for layer "${layerId}": contentHash is not a sha-256 digest.`,
    );
  }
  if (revision.kind === "text") {
    // Canonical text content: validated here and at ingestion through the
    // same validator — no alternate representation exists.
    validateTextContent(revision.text, revision.fontSize, revision.color);
  }
  if (!Number.isFinite(revision.x) || !Number.isFinite(revision.y)) {
    throw new Error(
      `Malformed revision document "${revHash}" for layer "${layerId}": x and y must be finite numbers.`,
    );
  }
  if (!Number.isFinite(revision.opacity) || revision.opacity < 0 || revision.opacity > 1) {
    throw new Error(
      `Malformed revision document "${revHash}" for layer "${layerId}": opacity must be a finite number between 0 and 1.`,
    );
  }

  // The stored document must hash to exactly the revision the identity points at
  if (computeRevisionHash(revision) !== revHash) {
    throw new Error(
      `Corrupted revision document "${revHash}" for layer "${layerId}": contents do not match the revision hash.`,
    );
  }

  // Read and verify content blob
  const contentBlob = path.join(resolvedRoot, "content", revision.contentHash);
  if (outsideDir(resolvedRoot, contentBlob)) {
    throw new Error(`Security error: content blob escapes project boundary.`);
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
  const currentRevision: ResolvedLayerRevision =
    revision.kind === "image"
      ? (() => {
          const meta = readRasterMeta(contentBytes, contentBlob);
          if (typeof meta === "string") {
            throw new Error(`Invalid content blob "${revision.contentHash}" for layer "${layerId}": ${meta}`);
          }
          return {
            schemaVersion: revision.schemaVersion,
            revisionId: revHash,
            layerId: revision.layerId,
            createdAt: revision.createdAt,
            kind: revision.kind,
            contentHash: revision.contentHash,
            x: revision.x,
            y: revision.y,
            opacity: revision.opacity,
            format: meta.format,
            width: meta.width,
            height: meta.height,
            bytes: contentBytes.length,
          };
        })()
      : {
          schemaVersion: revision.schemaVersion,
          revisionId: revHash,
          layerId: revision.layerId,
          createdAt: revision.createdAt,
          kind: revision.kind,
          contentHash: revision.contentHash,
          x: revision.x,
          y: revision.y,
          opacity: revision.opacity,
          text: revision.text,
          fontSize: revision.fontSize,
          color: revision.color,
          fontBytes: contentBytes.length,
        };

  return {
    id: identity.id,
    createdAt: identity.createdAt,
    currentRevisionId: revHash,
    currentRevision,
    contentBytes,
  };
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
  image?: string;
  text?: string;
  font?: string;
  fontSize?: number;
  color?: string;
  x?: number;
  y?: number;
  opacity?: number;
}

export interface EditLayerResult {
  layer: ResolvedLayer;
  referringCompositions: string[];
  referrersCount: number;
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

  // 1. Authoritative referrer discovery under the Project lock
  const referringCompositions = await findLayerReferrersInternal(resolvedRoot, layerId);
  const referrersCount = referringCompositions.length;

  // 2. Blast-radius guard: require --in-place when referenced by multiple Compositions
  if (referrersCount > 1 && !options.inPlace) {
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

  // 3. Placement options: preserve existing values if omitted
  const x = options.x !== undefined ? options.x : prevRev.x;
  const y = options.y !== undefined ? options.y : prevRev.y;
  const opacity = options.opacity !== undefined ? options.opacity : prevRev.opacity;

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Invalid placement (${options.x}, ${options.y}): x and y must be finite numbers.`);
  }
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new Error(`Invalid opacity ${options.opacity}: must be a finite number between 0 and 1.`);
  }

  // 4. Kind stability and kind-specific option handling
  let newRevision: LayerRevision;

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
    if (options.image !== undefined) {
      const ingested = await validateAndIngestImage(options.image);
      await storeContentBlob(resolvedRoot, ingested.contentHash, ingested.bytes);
      contentHash = ingested.contentHash;
    }

    // No-op check: if all fields are identical to previous revision, avoid storage churn
    if (
      contentHash === prevRev.contentHash &&
      x === prevRev.x &&
      y === prevRev.y &&
      opacity === prevRev.opacity
    ) {
      const resolved = await readLayerInternal(resolvedRoot, layerId);
      return { layer: resolved, referringCompositions, referrersCount };
    }

    newRevision = {
      schemaVersion: LAYER_SCHEMA_VERSION,
      layerId,
      createdAt: new Date().toISOString(),
      kind: "image",
      contentHash,
      x,
      y,
      opacity,
    };
  } else if (prevRev.kind === "text") {
    // Incompatible image option passed to text layer
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

    // No-op check: if all fields are identical to previous revision, avoid storage churn
    if (
      contentHash === prevRev.contentHash &&
      text === prevRev.text &&
      fontSize === prevRev.fontSize &&
      color === prevRev.color &&
      x === prevRev.x &&
      y === prevRev.y &&
      opacity === prevRev.opacity
    ) {
      const resolved = await readLayerInternal(resolvedRoot, layerId);
      return { layer: resolved, referringCompositions, referrersCount };
    }

    newRevision = {
      schemaVersion: LAYER_SCHEMA_VERSION,
      layerId,
      createdAt: new Date().toISOString(),
      kind: "text",
      contentHash,
      text,
      fontSize,
      color,
      x,
      y,
      opacity,
    };
  } else {
    throw new Error(`Unsupported Layer kind on layer "${layerId}".`);
  }

  // 5. Compute new revision hash and stage revision document
  const revHash = computeRevisionHash(newRevision);
  const revDir = path.join(resolvedRoot, "layers", `${layerId}.revisions`);
  const revFile = path.join(revDir, `${revHash}.json`);
  const identityFile = path.join(resolvedRoot, "layers", `${layerId}.json`);

  await mkdir(revDir, { recursive: true });

  let stagedRevision = false;
  try {
    await atomicCreate(revFile, JSON.stringify(newRevision, null, 2) + "\n");
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

