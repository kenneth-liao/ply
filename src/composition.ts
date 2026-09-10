/**
 * Composition authoring, layer reference management, and inspection (ADR-0013, ADR-0014, DEC-001–006).
 */
import { readFile, readdir, lstat, mkdir, unlink, rmdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { outsideDir, escapesDirReal } from "./paths.js";
import { atomicCreate, atomicReplace, withProjectLock, acquireProjectLock, type ProjectLock } from "./project-lock.js";
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
  validateImageBytes,
  validateTextContent,
  storeContentBlob,
  readLayerInternal,
  readLayerInternalFull,
} from "./layer.js";
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
 * Unlocked internal reader for stored Composition JSON documents.
 * Verifies Project boundary containment and parses the stored document through
 * the canonical parser.
 */
async function readCompositionDocument(
  resolvedRoot: string,
  compName: string,
): Promise<{ comp: Composition; compFile: string }> {
  const compFile = path.join(resolvedRoot, "compositions", `${compName}.json`);

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
  return { comp, compFile };
}

/**
 * Unlocked internal reader for a to-be-mutated Composition document.
 * Verifies Project boundary containment, parses the stored document through
 * the canonical parser, and confirms that every existing Layer reference
 * still resolves — never mutate a composition whose existing references no
 * longer resolve.
 *
 * This is the ONE canonical pre-mutation reading boundary: in-Project
 * mutations in this module and fork-target validation in `src/layer.ts` (#85,
 * local review CRAFT-1) all reuse it — there is no second boundary.
 * Callers must hold the Project lock.
 *
 * If `checkUniqueLocalName` is provided, additionally enforces that the local
 * name is not already in use within the Composition.
 */
export async function readMutableComposition(
  resolvedRoot: string,
  compName: string,
  checkUniqueLocalName?: string,
): Promise<{ comp: Composition; compFile: string }> {
  const { comp, compFile } = await readCompositionDocument(resolvedRoot, compName);

  // Local name uniqueness check
  if (checkUniqueLocalName !== undefined && comp.layers.some((l) => l.name === checkUniqueLocalName)) {
    throw new Error(
      `duplicate local name "${checkUniqueLocalName}" in composition "${compName}" — local names within a composition must be unique.`,
    );
  }

  for (const use of comp.layers) {
    await readLayerInternal(resolvedRoot, use.layerId);
  }
  return { comp, compFile };
}

export interface AddLayerOptions {
  x?: number;
  y?: number;
  opacity?: number;
}

/**
 * The one name rule for Project-visible names (Compositions, Layers, uses):
 * nonempty, alphanumeric, dash, underscore. Render manifests reuse it so a
 * stored composition name is always a safe single path component (CRAFT-1).
 */
export function sanitizeName(name: string): string {
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
export function parseCompositionDocument(raw: string, expectedName: string): Composition {
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
    const { comp, compFile } = await readMutableComposition(resolvedRoot, sanitizedComp, sanitizedLocalName);

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
        scaleX: 1,
        scaleY: 1,
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
    const { comp, compFile } = await readMutableComposition(resolvedRoot, sanitizedComp, sanitizedLocalName);

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
        scaleX: 1,
        scaleY: 1,
      };
    }).then(({ layerId, layer }) => ({
      composition: sanitizedComp,
      use: { name: sanitizedLocalName, layerId },
      layer,
    }));
  });
}

/** A selected Generation Job output for ingestion (#107): the job id and, for
 * multi-output records, the explicit 1-based index or sha-256 selection. */
export interface GenerationLayerSource extends GenerationOutputSelection {
  jobId: string;
  /** Root of the published Generation Job records (default: <cwd>/out/generation). */
  jobRoot: string;
}

export interface GeneratedLayerResult {
  composition: string;
  use: CompositionLayerUse;
  layer: ResolvedLayer;
  generatedFrom: { jobId: string; contentHash: string };
}

/** A published matte for ingestion (#108): the matte id under the matte root. */
export interface MattingLayerSource {
  matteId: string;
  /** Root of the published matte records (default: <cwd>/out/matting). */
  matteRoot: string;
  /** Root of the published Generation Job records, for derived predecessor lineage (default: <cwd>/out/generation). */
  generationRoot: string;
}

export interface MattedLayerResult {
  composition: string;
  use: CompositionLayerUse;
  layer: ResolvedLayer;
  mattedFrom: { matteId: string; engine: string; contentHash: string };
  /** Present when the matte's source was itself a published generation output — the retained predecessor provenance. */
  generatedFrom?: { jobId: string; contentHash: string };
}

/**
 * Add one selected generated output as an ordinary image Layer (#107, US-003)
 * through the exact image publication protocol: same identity/revision/use
 * staging, same lock, same rollback. The output's bytes are verified against
 * the record's content identity, retained into the content store, and the
 * record is retained verbatim under the Project's generation/ directory — the
 * one canonical retained provenance representation, resolvable by the
 * revision's contentHash after the external generation files are removed.
 * No generated-Layer identity, category, or approval fields exist; this is
 * an ordinary image Layer from a caller-declared source.
 */
export async function addGeneratedLayerToComposition(
  projectPath: string,
  compName: string,
  localName: string,
  source: GenerationLayerSource,
  options: AddLayerOptions = {},
): Promise<GeneratedLayerResult> {
  const sanitizedComp = sanitizeName(compName);
  const sanitizedLocalName = sanitizeName(localName);

  const { x, y, opacity } = parsePlacement(options);

  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, async () => {
    const { comp, compFile } = await readMutableComposition(resolvedRoot, sanitizedComp, sanitizedLocalName);

    return publishLayerUse(resolvedRoot, comp, compFile, sanitizedLocalName, async (layerId, createdAt) => {
      // Verify the generated output against its recorded identity, then
      // retain pixels and provenance before any revision staging — the
      // established ingestion-then-publish order under the Project lock.
      const selected = await selectGenerationOutput(source.jobRoot, source.jobId, { output: source.output });
      const validated = await validateImageBytes(
        selected.bytes,
        `Generation Job "${selected.job.jobId}" output "${selected.output.file}"`,
      );
      await storeContentBlob(resolvedRoot, validated.contentHash, validated.bytes);
      await retainGenerationRecord(resolvedRoot, selected.job.jobId, selected.recordBytes);
      return {
        schemaVersion: LAYER_SCHEMA_VERSION,
        layerId,
        createdAt,
        kind: "image",
        contentHash: validated.contentHash,
        x,
        y,
        opacity,
        scaleX: 1,
        scaleY: 1,
      };
    }).then(({ layerId, layer }) => ({
      composition: sanitizedComp,
      use: { name: sanitizedLocalName, layerId },
      layer,
      generatedFrom: { jobId: source.jobId, contentHash: layer.currentRevision.contentHash },
    }));
  });
}

/**
 * Add one published matte's verified output as an ordinary image Layer (#108,
 * US-003) through the exact image publication protocol: same
 * identity/revision/use staging, same lock, same rollback as #107's
 * generated-content ingestion. The matte record is read through the one
 * published-record parser, its single output's bytes are verified against
 * the recorded content identity, the pixels are retained into the content
 * store, the matte record is retained verbatim under the Project's matting/
 * directory, and — derived linkage — when the matte's source was itself a
 * published Generation Job output, that job's record is retained verbatim
 * too. All verification and retention happens before any revision staging,
 * so no failure leaves a live incomplete Layer. No matted-Layer identity,
 * category, or approval fields exist; this is an ordinary image Layer from a
 * caller-declared source. No engine runs and nothing generates: ingestion
 * reads an existing published result.
 */
export async function addMattedLayerToComposition(
  projectPath: string,
  compName: string,
  localName: string,
  source: MattingLayerSource,
  options: AddLayerOptions = {},
): Promise<MattedLayerResult> {
  const sanitizedComp = sanitizeName(compName);
  const sanitizedLocalName = sanitizeName(localName);

  const { x, y, opacity } = parsePlacement(options);

  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, async () => {
    const { comp, compFile } = await readMutableComposition(resolvedRoot, sanitizedComp, sanitizedLocalName);

    let selected: Awaited<ReturnType<typeof selectMatteOutput>> | undefined;
    let retainedGeneration: RetainedGenerationProvenance | null = null;
    return publishLayerUse(resolvedRoot, comp, compFile, sanitizedLocalName, async (layerId, createdAt) => {
      // Verify the matte's output against its recorded identity, then retain
      // pixels and provenance before any revision staging — the established
      // ingestion-then-publish order under the Project lock.
      const selectedOutput = await selectMatteOutput(source.matteRoot, source.matteId);
      selected = selectedOutput;
      const validated = await validateImageBytes(
        selectedOutput.bytes,
        `Matte "${selectedOutput.matte.matteId}" output "${selectedOutput.output.file}"`,
      );
      // Everything that can refuse the source (record parse, output hash,
      // decode, predecessor ambiguity) runs before any Project write, so a
      // refusal leaves no partial retention.
      const predecessor = await findGenerationPredecessor(
        source.generationRoot,
        selectedOutput.matte.request.source.contentHash,
      );
      await storeContentBlob(resolvedRoot, validated.contentHash, validated.bytes);
      await retainMattingRecord(resolvedRoot, selectedOutput.matte.matteId, selectedOutput.recordBytes);
      if (predecessor) {
        await retainGenerationRecord(resolvedRoot, predecessor.job.jobId, predecessor.recordBytes);
        retainedGeneration = {
          jobId: predecessor.job.jobId,
          job: predecessor.job,
          output: predecessor.job.run.outputs.find(
            (o) => o.contentHash === selectedOutput.matte.request.source.contentHash,
          )!,
        };
      }
      return {
        schemaVersion: LAYER_SCHEMA_VERSION,
        layerId,
        createdAt,
        kind: "image" as const,
        contentHash: validated.contentHash,
        x,
        y,
        opacity,
        scaleX: 1,
        scaleY: 1,
      };
    }).then(({ layerId, layer }) => ({
      composition: sanitizedComp,
      use: { name: sanitizedLocalName, layerId },
      layer,
      mattedFrom: {
        matteId: selected!.matte.matteId,
        engine: selected!.matte.result.engine,
        contentHash: layer.currentRevision.contentHash,
      },
      ...(retainedGeneration
        ? { generatedFrom: { jobId: retainedGeneration.jobId, contentHash: layer.currentRevision.contentHash } }
        : {}),
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
  const { comp } = await readCompositionDocument(resolvedRoot, sanitized);

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

export interface RemoveLayerResult {
  composition: string;
  removedUse: CompositionLayerUse;
  layers: CompositionLayerUse[];
}

export interface ReorderLayersResult {
  composition: string;
  layers: CompositionLayerUse[];
}

/**
 * Remove a Layer use from a Composition without deleting the Layer, its revisions,
 * or its content blobs (ADR-0013, spec #77 US-002).
 */
export async function removeLayerFromComposition(
  projectPath: string,
  compName: string,
  localName: string,
): Promise<RemoveLayerResult> {
  const sanitizedComp = sanitizeName(compName);
  const sanitizedLocalName = sanitizeName(localName);

  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, async () => {
    const { comp, compFile } = await readMutableComposition(resolvedRoot, sanitizedComp);

    const useIndex = comp.layers.findIndex((l) => l.name === sanitizedLocalName);
    if (useIndex === -1) {
      throw new Error(`Use "${sanitizedLocalName}" not found in composition "${sanitizedComp}".`);
    }

    const removedUse = comp.layers[useIndex]!;
    const updatedLayers = comp.layers.filter((_, idx) => idx !== useIndex);
    const updatedComp: Composition = {
      ...comp,
      layers: updatedLayers,
    };

    await atomicReplace(compFile, JSON.stringify(updatedComp, null, 2) + "\n");
    return {
      composition: sanitizedComp,
      removedUse,
      layers: updatedLayers,
    };
  });
}

/**
 * Reorder Layer uses in a Composition (ADR-0013, spec #77 US-002).
 * Accepts an exact full-order permutation of existing use names.
 */
export async function reorderCompositionLayers(
  projectPath: string,
  compName: string,
  order: string | string[],
): Promise<ReorderLayersResult> {
  const sanitizedComp = sanitizeName(compName);

  let rawNames: string[];
  if (typeof order === "string") {
    if (order.trim() === "") {
      rawNames = [];
    } else {
      rawNames = order.split(",").map((s) => s.trim());
    }
  } else if (Array.isArray(order)) {
    rawNames = order.map((s) => (typeof s === "string" ? s.trim() : ""));
  } else {
    throw new Error("Invalid order specification: must be a comma-separated string or array of names.");
  }

  // Check for empty string elements when order was specified
  for (const name of rawNames) {
    if (!name) {
      throw new Error("Empty use name in order list.");
    }
  }

  const sanitizedOrder = rawNames.map((n) => sanitizeName(n));

  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, async () => {
    const { comp, compFile } = await readMutableComposition(resolvedRoot, sanitizedComp);

    if (comp.layers.length === 0) {
      if (sanitizedOrder.length === 0) {
        return { composition: sanitizedComp, layers: [] };
      }
      throw new Error(
        `Cannot reorder empty composition "${sanitizedComp}": expected 0 names, received ${sanitizedOrder.length}.`,
      );
    }

    if (sanitizedOrder.length !== comp.layers.length) {
      throw new Error(
        `Invalid reorder for composition "${sanitizedComp}": expected ${comp.layers.length} names, received ${sanitizedOrder.length}.`,
      );
    }

    const seen = new Set<string>();
    for (const name of sanitizedOrder) {
      if (seen.has(name)) {
        throw new Error(`Duplicate name "${name}" in reorder list.`);
      }
      seen.add(name);
    }

    const useMap = new Map<string, CompositionLayerUse>();
    for (const use of comp.layers) {
      useMap.set(use.name, use);
    }

    for (const name of sanitizedOrder) {
      if (!useMap.has(name)) {
        throw new Error(`Use "${name}" not found in composition "${sanitizedComp}".`);
      }
    }

    const reorderedLayers = sanitizedOrder.map((name) => useMap.get(name)!);

    // No-op check: if order is identical, return without file replacement churn
    const isNoop = reorderedLayers.every((use, idx) => use.name === comp.layers[idx]!.name);
    if (isNoop) {
      return { composition: sanitizedComp, layers: comp.layers };
    }

    const updatedComp: Composition = {
      ...comp,
      layers: reorderedLayers,
    };

    await atomicReplace(compFile, JSON.stringify(updatedComp, null, 2) + "\n");
    return {
      composition: sanitizedComp,
      layers: reorderedLayers,
    };
  });
}

export interface ImportCompositionResult {
  composition: string;
  sourceComposition: string;
  importedUses: CompositionLayerUse[];
  layers: CompositionLayerUse[];
}

/**
 * Build a destination revision document for a cross-Project copy (#86, US-005).
 * The canonical revision construction for copies: immutable source facts are
 * preserved verbatim (kind, contentHash, placement, opacity, transform scale,
 * and text fields), bound to the new destination identity with a fresh
 * createdAt, and text fields are re-validated through the one shared text
 * validator used at ingestion. The retained content bytes are copied
 * separately — no bundled face resolution and no re-reading of `assets/fonts/`
 * happens during a copy. The source snapshot comes from the canonical Layer
 * resolver, so its transform scale is already normalized (#133, ADR-0016):
 * resize metadata survives cross-Project import instead of being dropped by
 * revision reconstruction.
 */
function buildCopiedRevision(newLayerId: string, createdAt: string, source: ResolvedLayerRevision): LayerRevision {
  if (source.kind === "text") {
    validateTextContent(source.text, source.fontSize, source.color);
    return {
      schemaVersion: LAYER_SCHEMA_VERSION,
      layerId: newLayerId,
      createdAt,
      kind: "text",
      contentHash: source.contentHash,
      text: source.text,
      fontSize: source.fontSize,
      color: source.color,
      x: source.x,
      y: source.y,
      opacity: source.opacity,
      scaleX: source.scaleX,
      scaleY: source.scaleY,
    };
  }
  if (source.kind !== "image") {
    throw new Error(`Unsupported Layer kind "${(source as { kind: string }).kind}" on source Layer revision.`);
  }
  return {
    schemaVersion: LAYER_SCHEMA_VERSION,
    layerId: newLayerId,
    createdAt,
    kind: "image",
    contentHash: source.contentHash,
    x: source.x,
    y: source.y,
    opacity: source.opacity,
    scaleX: source.scaleX,
    scaleY: source.scaleY,
  };
}

/**
 * Copy a source Project Composition's reusable Layers into a destination
 * Project Composition (ADR-0013, spec #77 US-005). Each distinct source Layer
 * identity becomes exactly one independent destination Layer identity with the
 * retained bytes required for inspection/edit/render; duplicate source uses
 * remap through one identity map. The source Project is never mutated.
 * Callers must hold BOTH Projects' locks.
 */
async function copyCrossProject(
  destRoot: string,
  srcRoot: string,
  targetName: string,
  sourceName: string,
): Promise<ImportCompositionResult> {
  // One consistent source snapshot through the canonical bytes-bearing reader
  // (`readCompositionInternalFull`): the document is parsed once and every
  // referenced source use is resolved through the canonical Layer resolver
  // `readLayerInternalFull` (hash-verified identity, revision, and content
  // bytes) — fail-closed on malformed or dangling source state. The source is
  // read-only; the pre-mutation reader guards only the destination mutation
  // boundary. Duplicate uses resolve per use; the identity map below remaps
  // each distinct source Layer to one destination identity.
  const sourceFull = await readCompositionInternalFull(srcRoot, sourceName);
  const { comp: targetComp, compFile: targetCompFile } = await readMutableComposition(destRoot, targetName);

  // Empty-source no-op: clean success with 0 imported uses, no storage churn.
  if (sourceFull.layers.length === 0) {
    return {
      composition: targetName,
      sourceComposition: sourceName,
      importedUses: [],
      layers: targetComp.layers,
    };
  }

  // Collision check BEFORE staging: fail-closed with a byte-identical
  // destination and no partial live identity state.
  const targetNames = new Set(targetComp.layers.map((l) => l.name));
  const collidingNames = sourceFull.layers.map((l) => l.name).filter((name) => targetNames.has(name));
  if (collidingNames.length > 0) {
    const namesFormatted = collidingNames.map((n) => `"${n}"`).join(", ");
    throw new Error(
      `Collision detected: local name(s) ${namesFormatted} already exist in composition "${targetName}". ` +
        `Rejection leaves destination references unchanged.`,
    );
  }

  // Map each DISTINCT source Layer identity to one destination identity from
  // the verified snapshot — no second Full resolution; duplicate uses share
  // the single mapped identity.
  const identityMap = new Map<string, { revision: ResolvedLayerRevision; contentBytes: Buffer }>();
  for (const layer of sourceFull.layers) {
    if (!identityMap.has(layer.layerId)) {
      identityMap.set(layer.layerId, { revision: layer.revision, contentBytes: layer.contentBytes });
    }
  }

  const newIdBySource = new Map<string, string>();
  const staged: Array<{ identityFile: string; revFile: string; revDir: string }> = [];
  try {
    for (const [srcId, snapshot] of identityMap) {
      const newId = generateLayerId();
      newIdBySource.set(srcId, newId);

      // Copy the retained content bytes into the destination content store
      // (deduplicated, integrity-verified on reuse by storeContentBlob).
      await storeContentBlob(destRoot, snapshot.revision.contentHash, snapshot.contentBytes);

      const createdAt = new Date().toISOString();
      const revision = buildCopiedRevision(newId, createdAt, snapshot.revision);
      const revHash = computeRevisionHash(revision);
      const revDir = path.join(destRoot, "layers", `${newId}.revisions`);
      const revFile = path.join(revDir, `${revHash}.json`);
      const identityFile = path.join(destRoot, "layers", `${newId}.json`);
      staged.push({ identityFile, revFile, revDir });

      await mkdir(revDir, { recursive: true });
      await atomicCreate(revFile, JSON.stringify(revision, null, 2) + "\n");
      const identity: LayerIdentity = {
        schemaVersion: LAYER_SCHEMA_VERSION,
        id: newId,
        createdAt,
        currentRevision: revHash,
      };
      await atomicCreate(identityFile, JSON.stringify(identity, null, 2) + "\n");
    }

    // Resolve every staged Layer before the live commit (publication protocol).
    for (const newId of newIdBySource.values()) {
      await readLayerInternal(destRoot, newId);
    }

    const importedUses: CompositionLayerUse[] = sourceFull.layers.map((layer) => ({
      name: layer.name,
      layerId: newIdBySource.get(layer.layerId)!,
    }));

    // Live Commit Point: one atomic replacement of the destination document.
    const updatedTarget: Composition = {
      ...targetComp,
      layers: [...targetComp.layers, ...importedUses],
    };
    await atomicReplace(targetCompFile, JSON.stringify(updatedTarget, null, 2) + "\n");

    return {
      composition: targetName,
      sourceComposition: sourceName,
      importedUses,
      layers: updatedTarget.layers,
    };
  } catch (err) {
    // Caught-error cleanup: remove staged identities/revisions (best-effort).
    // Retained content blobs stay for deduplication (established protocol).
    for (const artifact of staged) {
      await unlink(artifact.identityFile).catch(() => {});
      await unlink(artifact.revFile).catch(() => {});
      await rmdir(artifact.revDir).catch(() => {}); // only if now-empty
    }
    throw err;
  }
}

/**
 * Copy a Composition's reusable Layers across Project boundaries (#86, spec
 * #77 US-005, ADR-0013). Both Projects are locked in deterministic
 * sorted-canonical-realpath order so reverse-direction imports serialize
 * instead of deadlocking; a failed second acquisition releases the first.
 * A source path resolving to the destination Project is refused with
 * guidance to same-Project import — cross-Project copy semantics and
 * same-Project shared-identity reuse must never be silently confused.
 */
export async function importCompositionCrossProject(
  destinationProjectPath: string,
  targetCompName: string,
  sourceCompName: string,
  sourceProjectPath: string,
): Promise<ImportCompositionResult> {
  const sanitizedTarget = sanitizeName(targetCompName);
  const sanitizedSource = sanitizeName(sourceCompName);

  const destRoot = await resolveProjectRoot(destinationProjectPath);
  const srcRoot = await resolveProjectRoot(sourceProjectPath);

  // Alias guard (poka-yoke): identical realpaths mean one Project, whatever
  // path spelling reached it. There is no "another Project" to copy into.
  const [destReal, srcReal] = await Promise.all([realpath(destRoot), realpath(srcRoot)]);
  if (destReal === srcReal) {
    throw new Error(
      `Source project "${sourceProjectPath}" resolves to the same Project as the destination (${destReal}). ` +
        `Cross-Project import copies Layers into another Project with independent identities; to reuse ` +
        `shared Layer identities within one Project, run ` +
        `"ply composition import ${sanitizedTarget} ${sanitizedSource}" without --from-project.`,
    );
  }

  // Dual-Project locking in sorted canonical order. The lock paths derive
  // from the resolved roots, while ordering uses the canonical realpaths so
  // every cooperating process agrees on the same global order.
  const ordered: [string, string] = destReal < srcReal ? [destRoot, srcRoot] : [srcRoot, destRoot];
  const first = await acquireProjectLock(ordered[0]!);
  let second: ProjectLock;
  try {
    second = await acquireProjectLock(ordered[1]!);
  } catch (err) {
    await first.release();
    throw err;
  }
  try {
    return await copyCrossProject(destRoot, srcRoot, sanitizedTarget, sanitizedSource);
  } finally {
    await second.release();
    await first.release();
  }
}

/**
 * Import a Composition's Layer references into another Composition within the same Project (ADR-0013, spec #77 US-003).
 * Preserves shared Layer identities while creating an independent reference list in the destination Composition.
 */
export async function importComposition(
  projectPath: string,
  targetCompName: string,
  sourceCompName: string,
): Promise<ImportCompositionResult> {
  const sanitizedTarget = sanitizeName(targetCompName);
  const sanitizedSource = sanitizeName(sourceCompName);

  if (sanitizedTarget === sanitizedSource) {
    throw new Error(`Cannot import composition "${sanitizedTarget}" into itself.`);
  }

  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, async () => {
    const { comp: targetComp, compFile: targetCompFile } = await readMutableComposition(resolvedRoot, sanitizedTarget);
    const { comp: sourceComp } = await readMutableComposition(resolvedRoot, sanitizedSource);

    // Empty source import is a no-op with 0 imported uses
    if (sourceComp.layers.length === 0) {
      return {
        composition: sanitizedTarget,
        sourceComposition: sanitizedSource,
        importedUses: [],
        layers: targetComp.layers,
      };
    }

    // Explicit collision check: existing local names in target must not be overwritten
    const targetNames = new Set(targetComp.layers.map((l) => l.name));
    const collidingNames = sourceComp.layers.map((l) => l.name).filter((name) => targetNames.has(name));
    if (collidingNames.length > 0) {
      const namesFormatted = collidingNames.map((n) => `"${n}"`).join(", ");
      throw new Error(
        `Collision detected: local name(s) ${namesFormatted} already exist in composition "${sanitizedTarget}". Rejection leaves destination references unchanged.`,
      );
    }

    // Preserve raw source use fields when copying references
    const importedUses: CompositionLayerUse[] = sourceComp.layers.map((use) => ({
      name: use.name,
      layerId: use.layerId,
    }));

    const updatedLayers = [...targetComp.layers, ...importedUses];
    const updatedTargetComp: Composition = {
      ...targetComp,
      layers: updatedLayers,
    };

    await atomicReplace(targetCompFile, JSON.stringify(updatedTargetComp, null, 2) + "\n");

    return {
      composition: sanitizedTarget,
      sourceComposition: sanitizedSource,
      importedUses,
      layers: updatedLayers,
    };
  });
}

