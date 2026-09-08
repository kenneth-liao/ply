/**
 * Render history — the retained record of one Render and its exact historical
 * inputs (#87, spec #77 US-007, ADR-0013, DEC-001–006).
 *
 * A successful Render captures a Project-owned manifest beside its output
 * (always under the Project's renders/ directory, whatever PNG destination
 * the caller chose). The manifest pins identities only: the exact ordered
 * Layer revisions (layerId + revisionId), the canvas, and the rendering
 * environment that painted. Revision facts stay in the immutable hash-named
 * revision documents; content identity stays in those revisions' contentHash
 * — the manifest never duplicates a fact's canonical home. It records no
 * filesystem paths that replay depends on: it is relocation-proof by
 * construction, and replay works even when the original PNG is gone.
 *
 * Replay resolves those pinned revisions and their retained content directly
 * — never Layer identity pointers (layers/<id>.json) or Composition
 * documents (compositions/*.json) — so changing or removing current uses
 * cannot invalidate retained Render history. Missing, corrupted, or
 * malformed history fails loudly and never resolves to current or newer
 * content.
 */
import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { toolIdentity } from "./manifest.js";
import { readRevisionInternalFull } from "./layer.js";
import { sanitizeName } from "./composition.js";
import { escapesDirReal } from "./paths.js";
import { isStoredTimestamp } from "./stored-schema.js";
import type { SnapshotLayer, PaintEnvironment } from "./composition-paint.js";

export const RENDER_MANIFEST_SCHEMA_VERSION = 1;

/** The rendering environment that painted a Render — identity fields only. */
export interface RenderEnvironment {
  tool: { name: string; version: string };
  runtime: string;
  browser: string;
  platform: string;
}

export interface RenderManifestLayer {
  /** The Composition-local name of the use at render time. */
  name: string;
  /** The stable Layer identity the use referenced at render time. */
  layerId: string;
  /** The exact immutable revision the render resolved, by content-derived id. */
  revisionId: string;
}

export interface RenderManifestDocument {
  schemaVersion: number;
  composition: string;
  canvas: { width: number; height: number };
  environment: RenderEnvironment;
  /** Informational, project-relative output path; replay never requires it. */
  output: string;
  createdAt: string;
  layers: RenderManifestLayer[];
}

/**
 * Build the Render manifest from the exact snapshot the paint used, plus the
 * environment captured inside the same paint pass. Pure: no Project reads —
 * capture cannot consult current state after the snapshot (no-mix invariant).
 */
export function buildRenderManifest(
  snapshot: { name: string; canvas: { width: number; height: number }; layers: SnapshotLayer[] },
  environment: PaintEnvironment,
  informationalOutput: string,
  now = new Date(),
): RenderManifestDocument {
  return {
    schemaVersion: RENDER_MANIFEST_SCHEMA_VERSION,
    composition: snapshot.name,
    canvas: { width: snapshot.canvas.width, height: snapshot.canvas.height },
    environment: {
      tool: { name: environment.tool.name, version: environment.tool.version },
      runtime: environment.runtime,
      browser: environment.browser,
      platform: environment.platform,
    },
    output: informationalOutput,
    createdAt: now.toISOString(),
    layers: snapshot.layers.map((l) => ({
      name: l.name,
      layerId: l.layerId,
      revisionId: l.revision.revisionId,
    })),
  };
}

const LAYER_ID_PATTERN = /^layer_[a-zA-Z0-9_]+$/;
const REVISION_ID_PATTERN = /^rev_[0-9a-f]{16}$/;

function nonemptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`Malformed render manifest: "${field}" must be a nonempty string.`);
  }
  return value;
}

/**
 * Parse a stored Render manifest at its single ingestion point (#87).
 * Strict field-specific validation: unknown schema versions, wrong shapes,
 * and malformed pinned identifiers are rejected here — pinned layer/revision
 * ids are validated before any filesystem path is ever constructed from
 * them. The recorded environment and informational output are validated for
 * shape only; replay never trusts the output field for resolution.
 */
export function parseRenderManifest(raw: string): RenderManifestDocument {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed render manifest: ${(err as Error).message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("Malformed render manifest: root must be a JSON object.");
  }
  const m = doc as RenderManifestDocument;
  if (m.schemaVersion !== RENDER_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported render manifest schemaVersion ${JSON.stringify(m.schemaVersion)} — this tool reads version ${RENDER_MANIFEST_SCHEMA_VERSION} only.`,
    );
  }
  nonemptyString(m.composition, "composition");
  // The composition name becomes a path component of the default replay
  // destination (renders/<name>-<id>.png), so it must obey the one name rule
  // shared with creation — a mutated manifest can never escape renders/ (CRAFT-1).
  let compositionName: string;
  try {
    compositionName = sanitizeName(m.composition);
  } catch (err) {
    throw new Error(
      `Malformed render manifest: "composition" ${JSON.stringify(m.composition)} is not a valid Composition name — ${(err as Error).message}`,
    );
  }
  if (compositionName !== m.composition) {
    throw new Error(
      `Malformed render manifest: "composition" ${JSON.stringify(m.composition)} is not a valid Composition name.`,
    );
  }
  if (
    !m.canvas ||
    typeof m.canvas !== "object" ||
    !Number.isInteger(m.canvas.width) ||
    m.canvas.width <= 0 ||
    !Number.isInteger(m.canvas.height) ||
    m.canvas.height <= 0
  ) {
    throw new Error('Malformed render manifest: "canvas" must specify positive integer width and height.');
  }
  const env = m.environment as RenderEnvironment | undefined;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error('Malformed render manifest: "environment" must be an object.');
  }
  if (!env.tool || typeof env.tool !== "object" || Array.isArray(env.tool)) {
    throw new Error('Malformed render manifest: "environment.tool" must be an object with "name" and "version".');
  }
  nonemptyString(env.tool.name, "environment.tool.name");
  nonemptyString(env.tool.version, "environment.tool.version");
  nonemptyString(env.runtime, "environment.runtime");
  nonemptyString(env.browser, "environment.browser");
  nonemptyString(env.platform, "environment.platform");
  nonemptyString(m.output, "output");
  if (!isStoredTimestamp(m.createdAt)) {
    throw new Error('Malformed render manifest: "createdAt" must be a canonical UTC ISO 8601 timestamp.');
  }
  if (!Array.isArray(m.layers)) {
    throw new Error('Malformed render manifest: "layers" must be an array of pinned uses.');
  }
  m.layers.forEach((entry, i) => {
    const field = `layers[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Malformed render manifest: "${field}" must be an object.`);
    }
    nonemptyString(entry.name, `${field}.name`);
    if (typeof entry.layerId !== "string" || !LAYER_ID_PATTERN.test(entry.layerId)) {
      throw new Error(`Malformed render manifest: "${field}.layerId" is not a valid Layer identity.`);
    }
    if (typeof entry.revisionId !== "string" || !REVISION_ID_PATTERN.test(entry.revisionId)) {
      throw new Error(`Malformed render manifest: "${field}.revisionId" is not a valid revision id.`);
    }
  });
  return m;
}

/**
 * Read a stored Render manifest from disk. A missing manifest fails loudly —
 * replay never substitutes current state for unreadable history.
 */
export async function readRenderManifest(manifestPath: string): Promise<RenderManifestDocument> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Render manifest not found: "${manifestPath}"`);
    }
    throw new Error(`Render manifest "${manifestPath}" cannot be read: ${(err as Error).message}`);
  }
  return parseRenderManifest(raw);
}

/**
 * Compatibility gate (#87): replay requires the exact environment that
 * painted the original Render — tool version, runtime version, platform, and
 * the actual browser identity — checked before any output is published.
 * This is a conservative boundary: byte-identical replay is guaranteed within
 * one environment, never claimed universally across machines that merely
 * report equal version strings.
 */
export function verifyEnvironmentMatch(recorded: RenderEnvironment, current: PaintEnvironment): void {
  const mismatches: string[] = [];
  if (recorded.tool.name !== current.tool.name) mismatches.push(`tool name ${JSON.stringify(recorded.tool.name)} ≠ ${JSON.stringify(current.tool.name)}`);
  if (recorded.tool.version !== current.tool.version) mismatches.push(`tool version ${JSON.stringify(recorded.tool.version)} ≠ ${JSON.stringify(current.tool.version)}`);
  if (recorded.runtime !== current.runtime) mismatches.push(`runtime ${JSON.stringify(recorded.runtime)} ≠ ${JSON.stringify(current.runtime)}`);
  if (recorded.browser !== current.browser) mismatches.push(`browser ${JSON.stringify(recorded.browser)} ≠ ${JSON.stringify(current.browser)}`);
  if (recorded.platform !== current.platform) mismatches.push(`platform ${JSON.stringify(recorded.platform)} ≠ ${JSON.stringify(current.platform)}`);
  if (mismatches.length > 0) {
    throw new Error(
      `Render environment mismatch: the manifest was captured under {${mismatches.join(", ")}}. ` +
        `Byte-identical replay requires the capturing environment; render the Composition from its current state instead.`,
    );
  }
}

/**
 * Resolve the manifest's pinned historical snapshot: every ordered use's
 * exact revision document and its hash-verified retained content bytes,
 * through the one canonical revision reader. Current Layer identity pointers
 * and Composition documents are never consulted (#87, US-007).
 * Callers must hold the Project lock.
 */
export async function resolveHistoricalLayers(
  resolvedRoot: string,
  manifest: RenderManifestDocument,
): Promise<SnapshotLayer[]> {
  const layers: SnapshotLayer[] = [];
  for (const entry of manifest.layers) {
    const { revision, contentBytes } = await readRevisionInternalFull(resolvedRoot, entry.layerId, entry.revisionId);
    layers.push({ name: entry.name, layerId: entry.layerId, revision, contentBytes });
  }
  return layers;
}

/**
 * Containment guard for the caller-supplied manifest path (#87): render
 * history is Project-owned, so the manifest must live inside the Project and
 * never inside reserved input storage (compositions/, layers/, content/) —
 * history lives in renders/. Replay resolves the Project explicitly
 * (--project); relocation moves manifest and Project together.
 */
export async function requireProjectRenderManifest(resolvedRoot: string, manifestPath: string): Promise<void> {
  const target = path.resolve(manifestPath);
  try {
    await lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Absence is answered by the manifest reader's clear not-found failure.
      return;
    }
    throw err;
  }
  if (await escapesDirReal(resolvedRoot, target)) {
    throw new Error(
      `Render manifest "${manifestPath}" is outside the project; render history lives in the Project's renders/ directory.`,
    );
  }
  const rel = path.relative(resolvedRoot, target);
  const top = rel.split(path.sep)[0]!;
  if (["compositions", "layers", "content"].includes(top)) {
    throw new Error(
      `Render manifest "${manifestPath}" is inside reserved Project storage (${top}/); ` +
        `render history lives in renders/.`,
    );
  }
}