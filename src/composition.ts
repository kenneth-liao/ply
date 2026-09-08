/**
 * Composition authoring, layer reference management, and inspection (ADR-0013, ADR-0014, DEC-001–006).
 */
import { readFile, readdir, lstat, mkdir, unlink, rmdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { outsideDir, escapesDirReal } from "./paths.js";
import { atomicCreate, atomicReplace, withProjectLock } from "./project-lock.js";
import { resolveProjectRoot } from "./project.js";
import {
  LAYER_SCHEMA_VERSION,
  type LayerIdentity,
  type LayerRevision,
  type ResolvedLayerRevision,
  type ResolvedLayer,
  generateLayerId,
  computeRevisionHash,
  validateAndIngestImage,
  validateTextContent,
  storeContentBlob,
  readLayerInternal,
  readLayerInternalFull,
} from "./layer.js";
import { resolveFace, fontAssetBytes } from "./fonts.js";

export const COMPOSITION_SCHEMA_VERSION = 1;

export interface CompositionCanvas {
  width: number;
  height: number;
}

export interface CompositionLayerUse {
  name: string;
  layerId: string;
}

export interface Composition {
  schemaVersion: number;
  name: string;
  canvas: CompositionCanvas;
  layers: CompositionLayerUse[];
}

export interface ResolvedCompositionLayer {
  name: string;
  layerId: string;
  kind: "image" | "text";
  revision: ResolvedLayerRevision;
}

export interface ResolvedComposition {
  name: string;
  canvas: CompositionCanvas;
  layers: ResolvedCompositionLayer[];
}

/**
 * Shared Layer publication protocol (#79, #81): stage the immutable revision,
 * stage the identity, resolve the staged Layer, then commit the Composition
 * use as the live commit point. Both image and text ingestion publish through
 * this one protocol — there is no text-specific publication copy.
 */
async function publishLayerUse(
  resolvedRoot: string,
  comp: Composition,
  compFile: string,
  localName: string,
  makeRevision: (layerId: string, createdAt: string) => Promise<LayerRevision>,
): Promise<{ layerId: string; layer: ResolvedLayer }> {
  const layerId = generateLayerId();
  const createdAt = new Date().toISOString();

  const revision = await makeRevision(layerId, createdAt);
  const revHash = computeRevisionHash(revision);
  const revDir = path.join(resolvedRoot, "layers", `${layerId}.revisions`);
  const revFile = path.join(revDir, `${revHash}.json`);
  const identityFile = path.join(resolvedRoot, "layers", `${layerId}.json`);

  await mkdir(revDir, { recursive: true });

  let stagedRevision = false;
  let stagedIdentity = false;

  let resolvedLayer: ResolvedLayer;
  try {
    await atomicCreate(revFile, JSON.stringify(revision, null, 2) + "\n");
    stagedRevision = true;

    const identity: LayerIdentity = {
      schemaVersion: LAYER_SCHEMA_VERSION,
      id: layerId,
      createdAt,
      currentRevision: revHash,
    };

    await atomicCreate(identityFile, JSON.stringify(identity, null, 2) + "\n");
    stagedIdentity = true;

    resolvedLayer = await readLayerInternal(resolvedRoot, layerId);

    // Live Commit Point in Composition
    const updatedComp: Composition = {
      ...comp,
      layers: [...comp.layers, { name: localName, layerId }],
    };

    await atomicReplace(compFile, JSON.stringify(updatedComp, null, 2) + "\n");
  } catch (err) {
    // Rollback staged layer files on failure
    if (stagedIdentity) {
      await unlink(identityFile).catch(() => {});
    }
    if (stagedRevision) {
      await unlink(revFile).catch(() => {});
      await rmdir(revDir).catch(() => {}); // remove the now-empty revision directory
    }
    throw err;
  }

  return { layerId, layer: resolvedLayer };
}

/** Placement validation shared by both ingestion kinds. */
function parsePlacement(options: AddLayerOptions): { x: number; y: number; opacity: number } {
  const x = options.x ?? 0;
  const y = options.y ?? 0;
  const opacity = options.opacity ?? 1.0;

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Invalid placement (${options.x}, ${options.y}): x and y must be finite numbers.`);
  }
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new Error(`Invalid opacity ${options.opacity}: must be a finite number between 0 and 1.`);
  }
  return { x, y, opacity };
}

/**
 * Read the target Composition under the lock for a live mutation: contained,
 * parseable, unique local name for the new use, and every existing reference
 * still resolving — never mutate a composition whose existing references no
 * longer resolve.
 */
async function readMutableComposition(
  resolvedRoot: string,
  compFile: string,
  compName: string,
  localName: string,
): Promise<Composition> {
  if (await escapesDirReal(resolvedRoot, compFile)) {
    throw new Error(`Security error: composition "${compName}" escapes project boundary.`);
  }

  let compRaw: string;
  try {
    compRaw = await readFile(compFile, "utf8");
  } catch {
    throw new Error(`Composition "${compName}" not found in project.`);
  }

  const comp = parseCompositionDocument(compRaw, compName);

  // Local name uniqueness check
  if (comp.layers.some((l) => l.name === localName)) {
    throw new Error(
      `duplicate local name "${localName}" in composition "${compName}" — local names within a composition must be unique.`,
    );
  }

  for (const use of comp.layers) {
    await readLayerInternal(resolvedRoot, use.layerId);
  }
  return comp;
}

export interface AddLayerOptions {
  x?: number;
  y?: number;
  opacity?: number;
}

function sanitizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Name cannot be empty.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error(`Name "${name}" contains invalid characters (use alphanumeric, dash, or underscore).`);
  }
  return trimmed;
}

/**
 * Parse and validate a stored Composition document at its single ingestion
 * point. Every reader of composition JSON goes through here, so downstream
 * code can assume the canonical shape: matching name, positive-integer
 * canvas, and an ordered list of unique `{ name, layerId }` uses.
 */
function parseCompositionDocument(raw: string, expectedName: string): Composition {
  let comp: Composition;
  try {
    comp = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed composition document "${expectedName}": ${(err as Error).message}`);
  }

  if (!comp || typeof comp !== "object" || Array.isArray(comp)) {
    throw new Error(`Malformed composition document "${expectedName}": not a JSON object.`);
  }
  if (comp.schemaVersion !== COMPOSITION_SCHEMA_VERSION) {
    throw new Error(
      `Malformed composition document "${expectedName}": unsupported schemaVersion ${comp.schemaVersion}, expected ${COMPOSITION_SCHEMA_VERSION}.`,
    );
  }
  if (comp.name !== expectedName) {
    throw new Error(
      `Malformed composition document "${expectedName}": document name "${comp.name}" does not match its file.`,
    );
  }
  const canvas = comp.canvas as CompositionCanvas | undefined;
  if (
    !canvas ||
    typeof canvas !== "object" ||
    !Number.isInteger(canvas.width) ||
    canvas.width <= 0 ||
    !Number.isInteger(canvas.height) ||
    canvas.height <= 0
  ) {
    throw new Error(`Malformed composition document "${expectedName}": canvas must specify positive integer width and height.`);
  }
  if (!Array.isArray(comp.layers)) {
    throw new Error(`Malformed composition document "${expectedName}": layers must be an array of { name, layerId } uses.`);
  }
  const seen = new Set<string>();
  for (const use of comp.layers) {
    if (!use || typeof use.name !== "string" || use.name === "" || typeof use.layerId !== "string" || use.layerId === "") {
      throw new Error(`Malformed composition document "${expectedName}": layers must be an array of { name, layerId } uses.`);
    }
    if (seen.has(use.name)) {
      throw new Error(`Malformed composition document "${expectedName}": duplicate local name "${use.name}".`);
    }
    seen.add(use.name);
  }
  return comp;
}

/** Create a new Composition document in the Project. */
export async function createComposition(
  projectPath: string,
  name: string,
  canvas: { width: number; height: number },
): Promise<Composition> {
  const sanitized = sanitizeName(name);

  if (!Number.isInteger(canvas.width) || canvas.width <= 0) {
    throw new Error(`Invalid canvas width ${canvas.width}: must be a positive integer.`);
  }
  if (!Number.isInteger(canvas.height) || canvas.height <= 0) {
    throw new Error(`Invalid canvas height ${canvas.height}: must be a positive integer.`);
  }

  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, async () => {
    const compDir = path.join(resolvedRoot, "compositions");
    const compFile = path.join(compDir, `${sanitized}.json`);

    try {
      await lstat(compFile);
      throw new Error(`Composition "${sanitized}" already exists in project.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    const comp: Composition = {
      schemaVersion: COMPOSITION_SCHEMA_VERSION,
      name: sanitized,
      canvas: {
        width: canvas.width,
        height: canvas.height,
      },
      layers: [],
    };

    await atomicCreate(compFile, JSON.stringify(comp, null, 2) + "\n");
    return comp;
  });
}

/** Add a local image Layer to a Composition safely with atomic publication and rollback. */
export async function addLayerToComposition(
  projectPath: string,
  compName: string,
  localName: string,
  imagePath: string,
  options: AddLayerOptions = {},
): Promise<{ composition: string; use: CompositionLayerUse; layer: ResolvedLayer }> {
  const sanitizedComp = sanitizeName(compName);
  const sanitizedLocalName = sanitizeName(localName);

  const { x, y, opacity } = parsePlacement(options);

  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, async () => {
    const compFile = path.join(resolvedRoot, "compositions", `${sanitizedComp}.json`);
    const comp = await readMutableComposition(resolvedRoot, compFile, sanitizedComp, sanitizedLocalName);

    return publishLayerUse(resolvedRoot, comp, compFile, sanitizedLocalName, async (layerId, createdAt) => {
      // Ingest & decode input image, then stage the content blob.
      const ingested = await validateAndIngestImage(imagePath);
      await storeContentBlob(projectPath, ingested.contentHash, ingested.bytes);
      return {
        schemaVersion: LAYER_SCHEMA_VERSION,
        layerId,
        createdAt,
        kind: "image",
        contentHash: ingested.contentHash,
        x,
        y,
        opacity,
      };
    }).then(({ layerId, layer }) => ({ composition: sanitizedComp, use: { name: sanitizedLocalName, layerId }, layer }));
  });
}

/**
 * Add a locally rendered text Layer (#81) through the exact image publication
 * protocol: same identity/revision/use staging, same lock, same rollback.
 * The bundled face is resolved once here; its raw bytes are retained into the
 * Project content store and become the revision's content identity. The
 * family/weight facts live only in the bundled-face registry — the stored
 * revision pins the bytes, text, size, and color.
 */
export async function addTextLayerToComposition(
  projectPath: string,
  compName: string,
  localName: string,
  input: {
    /** Rendered string content (nonempty, ≤ MAX_TEXT_LENGTH). */
    text: string;
    /** A bundled font family name — resolved once at add, never re-consulted. */
    font: string;
    /** Strict hex color (#RGB / #RRGGBB); default #ffffff. */
    color?: string;
  },
  options: AddLayerOptions & { fontSize?: number } = {},
): Promise<{ composition: string; use: CompositionLayerUse; layer: ResolvedLayer }> {
  const sanitizedComp = sanitizeName(compName);
  const sanitizedLocalName = sanitizeName(localName);

  const { x, y, opacity } = parsePlacement(options);
  const fontSize = options.fontSize ?? 48;
  const color = input.color ?? "#ffffff";
  // Canonical text validation at the ingestion boundary; the stored-revision
  // parser reuses the same validator.
  validateTextContent(input.text, fontSize, color);

  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, async () => {
    const compFile = path.join(resolvedRoot, "compositions", `${sanitizedComp}.json`);
    const comp = await readMutableComposition(resolvedRoot, compFile, sanitizedComp, sanitizedLocalName);

    return publishLayerUse(resolvedRoot, comp, compFile, sanitizedLocalName, async (layerId, createdAt) => {
      // Resolve the bundled face once and retain its exact bytes as the
      // revision's content identity. Unknown families and missing bundled
      // bytes fail loudly here, naming the bundled families.
      const face = resolveFace(input.font);
      const bytes = fontAssetBytes(face);
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      await storeContentBlob(projectPath, contentHash, bytes);
      return {
        schemaVersion: LAYER_SCHEMA_VERSION,
        layerId,
        createdAt,
        kind: "text",
        contentHash,
        text: input.text,
        fontSize,
        color,
        x,
        y,
        opacity,
      };
    }).then(({ layerId, layer }) => ({
      composition: sanitizedComp,
      use: { name: sanitizedLocalName, layerId },
      layer,
    }));
  });
}

export interface ResolvedCompositionLayerFull extends ResolvedCompositionLayer {
  /** The Layer's verified retained content bytes. Internal projection — never serialized. */
  contentBytes: Buffer;
}

export interface ResolvedCompositionFull extends Omit<ResolvedComposition, "layers"> {
  layers: ResolvedCompositionLayerFull[];
}

/**
 * Unlocked internal reader that also returns each Layer's verified retained
 * content bytes. Callers must hold the Project lock. This is the canonical
 * Composition resolution site: the document is parsed once and every Layer is
 * resolved exactly once through the canonical Layer resolver; metadata-only
 * readers project from this result without a second read or a second
 * verification.
 */
export async function readCompositionInternalFull(
  projectPath: string,
  compName: string,
): Promise<ResolvedCompositionFull> {
  const sanitized = sanitizeName(compName);
  const resolvedRoot = path.resolve(projectPath);
  const compFile = path.join(resolvedRoot, "compositions", `${sanitized}.json`);

  if (await escapesDirReal(resolvedRoot, compFile)) {
    throw new Error(`Security error: composition "${sanitized}" escapes project boundary.`);
  }

  let compRaw: string;
  try {
    compRaw = await readFile(compFile, "utf8");
  } catch {
    throw new Error(`Composition "${sanitized}" not found in project.`);
  }


  const comp = parseCompositionDocument(compRaw, sanitized);

  const resolvedLayers: ResolvedCompositionLayerFull[] = [];
  for (const use of comp.layers) {
    const layer = await readLayerInternalFull(projectPath, use.layerId);
    resolvedLayers.push({
      name: use.name,
      layerId: use.layerId,
      kind: layer.currentRevision.kind,
      revision: layer.currentRevision,
      contentBytes: layer.contentBytes,
    });
  }

  return {
    name: comp.name,
    canvas: comp.canvas,
    layers: resolvedLayers,
  };
}

/** Unlocked internal reader for Composition. Callers must hold the Project lock. */
export async function readCompositionInternal(
  projectPath: string,
  compName: string,
): Promise<ResolvedComposition> {
  const full = await readCompositionInternalFull(projectPath, compName);
  return {
    name: full.name,
    canvas: full.canvas,
    layers: full.layers.map(({ name, layerId, kind, revision }) => ({ name, layerId, kind, revision })),
  };
}

/** Inspect a Composition in the Project (acquires Project lock for consistent snapshot). */
export async function inspectComposition(
  projectPath: string,
  compName: string,
): Promise<ResolvedComposition> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, () => readCompositionInternal(resolvedRoot, compName));
}

/** List all Compositions in the Project. */
export async function listCompositions(projectPath: string): Promise<ResolvedComposition[]> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, async () => {
    const compDir = path.join(resolvedRoot, "compositions");
    const entries = await readdir(compDir);
    const compFiles = entries.filter((f) => f.endsWith(".json"));

    const compositions: ResolvedComposition[] = [];
    for (const file of compFiles) {
      const name = path.basename(file, ".json");
      const resolved = await readCompositionInternal(resolvedRoot, name);
      compositions.push(resolved);
    }
    return compositions;
  });
}
