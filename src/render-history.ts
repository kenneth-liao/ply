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
import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { toolIdentity, fsIdentity } from "./manifest.js";
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
  /** The integer supersample factor the pixels were painted at (#184,
   * ADR-0022): device pixels per canvas pixel, area-averaged back to the
   * canvas size. New manifests always record it; the parser defaults a
   * missing factor (pre-#184 history) to 1 at that one ingestion boundary. */
  supersample: number;
  environment: RenderEnvironment;
  /** Informational destination record: project-relative for in-Project
   * destinations, absolute for external ones (#174's render-output guard
   * compares by this recorded form — never ambiguous cwd-relative data);
   * replay never requires it. */
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
  snapshot: {
    name: string;
    canvas: { width: number; height: number };
    layers: SnapshotLayer[];
    supersample: number;
  },
  environment: PaintEnvironment,
  informationalOutput: string,
  now = new Date(),
): RenderManifestDocument {
  return {
    schemaVersion: RENDER_MANIFEST_SCHEMA_VERSION,
    composition: snapshot.name,
    canvas: { width: snapshot.canvas.width, height: snapshot.canvas.height },
    supersample: snapshot.supersample,
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
  // The supersample factor defaults to 1 exactly here (#184): manifests
  // written before supersampling record no factor and replay at 1. A present
  // factor must be a positive integer — anything else is malformed history,
  // not a value to repair.
  if (m.supersample === undefined) {
    m.supersample = 1;
  } else if (!Number.isInteger(m.supersample) || m.supersample < 1) {
    throw new Error(
      `Malformed render manifest: "supersample" ${JSON.stringify(m.supersample)} must be a positive integer.`,
    );
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
    const { revision, contentBytes, runFonts } = await readRevisionInternalFull(resolvedRoot, entry.layerId, entry.revisionId);
    layers.push({
      name: entry.name,
      layerId: entry.layerId,
      revision,
      contentBytes,
      ...(runFonts !== undefined && runFonts.length > 0 ? { runFonts } : {}),
    });
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
/**
 * The one reader for "does the Project's Render history record this path as
 * an output" (#174): scan the Project's renders/ manifests and compare each
 * recorded `output` against the candidate by filesystem identity
 * (`fsIdentity`), so a symlink alias cannot slip a recorded Render past the
 * guard. Recorded outputs are unambiguous by contract: the render boundary
 * records external destinations absolute and in-Project destinations
 * project-relative, so a relative record resolves against the Project root.
 *
 * Narrowed fail-closed rule (#174 review PROD-2): the guard vetoes a write
 * only on evidence that concerns the target, never on unrelated decay.
 * - A manifest that cannot be read or parsed is itself the conflict: it
 *   cannot prove ANY target unrecorded, so it vetoes every write
 *   (fail-closed) — the caller's error names the manifest and suggests
 *   --out.
 * - A recorded output that no longer exists (a deleted external export is
 *   routine — it is user-owned temp outside the Project) is compared
 *   lexically (fsIdentity's ENOENT fallback): a different path is not a
 *   conflict; the recorded path itself still is (the history still names
 *   it).
 * - A non-ENOENT I/O failure answering the question is itself the conflict
 *   — a write that cannot be proven safe is not performed (fail-closed,
 *   like the legacy directory reader in src/manifest.ts).
 * The guideline view consults this so a review artifact can never overwrite
 * published Render pixels. Renders themselves never consult it.
 */
export async function projectRenderOutputConflict(
  resolvedRoot: string,
  outputPath: string,
): Promise<{ manifest: string } | undefined> {
  const dir = path.join(resolvedRoot, "renders");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    // Only absence proves nothing is recorded there. A permission or I/O
    // failure answers nothing — fail closed by propagating, never fail open.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const target = await fsIdentity(outputPath);
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".manifest.json")) continue;
    const file = path.join(dir, entry);
    let manifest: RenderManifestDocument;
    try {
      manifest = await readRenderManifest(file);
    } catch {
      // An unreadable history manifest cannot prove the target safe.
      return { manifest: file };
    }
    const recorded = path.resolve(resolvedRoot, manifest.output);
    try {
      // fsIdentity resolves ENOENT lexically (real parent + basename), so a
      // DELETED record still names its path: it vetoes only a write to that
      // same path and never an unrelated target (PROD-2). Only a non-ENOENT
      // failure leaves the question unanswered — fail closed, naming the
      // manifest.
      if ((await fsIdentity(recorded)) === target) return { manifest: file };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err;
      return { manifest: file };
    }
  }
  return undefined;
}
