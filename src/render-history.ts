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
import { toolIdentity } from "./manifest.js";
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