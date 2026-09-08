/**
 * Composition authoring, layer reference management, and inspection (ADR-0013, ADR-0014, DEC-001–006).
 */
import { readFile, readdir, lstat, mkdir, unlink, rmdir } from "node:fs/promises";
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
  storeContentBlob,
  readLayerInternal,
} from "./layer.js";

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
  kind: "image";
  revision: ResolvedLayerRevision;
}

export interface ResolvedComposition {
  name: string;
  canvas: CompositionCanvas;
  layers: ResolvedCompositionLayer[];
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

  const x = options.x ?? 0;
  const y = options.y ?? 0;
  const opacity = options.opacity ?? 1.0;

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Invalid placement (${options.x}, ${options.y}): x and y must be finite numbers.`);
  }
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new Error(`Invalid opacity ${options.opacity}: must be a finite number between 0 and 1.`);
  }

  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, async () => {
    const compDir = path.join(resolvedRoot, "compositions");
    const compFile = path.join(compDir, `${sanitizedComp}.json`);

    if (await escapesDirReal(resolvedRoot, compFile)) {
      throw new Error(`Security error: composition "${sanitizedComp}" escapes project boundary.`);
    }

    let compRaw: string;
    try {
      compRaw = await readFile(compFile, "utf8");
    } catch {
      throw new Error(`Composition "${sanitizedComp}" not found in project.`);
    }


    const comp = parseCompositionDocument(compRaw, sanitizedComp);

    // Local name uniqueness check
    if (comp.layers.some((l) => l.name === sanitizedLocalName)) {
      throw new Error(
        `duplicate local name "${sanitizedLocalName}" in composition "${sanitizedComp}" — local names within a composition must be unique.`,
      );
    }

    // Never mutate a composition whose existing references no longer resolve
    for (const use of comp.layers) {
      await readLayerInternal(resolvedRoot, use.layerId);
    }

    // Step 1 & 2: Ingest & decode input image
    const ingested = await validateAndIngestImage(imagePath);

    // Step 3: Stage content blob
    await storeContentBlob(projectPath, ingested.contentHash, ingested.bytes);

    // Step 4: Stage revision document & Layer identity
    const layerId = generateLayerId();
    const createdAt = new Date().toISOString();

    const revision: LayerRevision = {
      schemaVersion: LAYER_SCHEMA_VERSION,
      layerId,
      createdAt,
      kind: "image",
      contentHash: ingested.contentHash,
      x,
      y,
      opacity,
    };

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

      // Step 5: Live Commit Point in Composition
      const updatedComp: Composition = {
        ...comp,
        layers: [...comp.layers, { name: sanitizedLocalName, layerId }],
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

    return {
      composition: sanitizedComp,
      use: { name: sanitizedLocalName, layerId },
      layer: resolvedLayer,
    };
  });
}

/** Unlocked internal reader for Composition. Callers must hold the Project lock. */
export async function readCompositionInternal(
  projectPath: string,
  compName: string,
): Promise<ResolvedComposition> {
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

  const resolvedLayers: ResolvedCompositionLayer[] = [];
  for (const use of comp.layers) {
    const layer = await readLayerInternal(projectPath, use.layerId);
    resolvedLayers.push({
      name: use.name,
      layerId: use.layerId,
      kind: layer.currentRevision.kind,
      revision: layer.currentRevision,
    });
  }

  return {
    name: comp.name,
    canvas: comp.canvas,
    layers: resolvedLayers,
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
