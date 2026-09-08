/**
 * Composition rendering — paint a resolved local image Composition and retain
 * its exact historical inputs (ADR-0013, DEC-001–006, #77 US-006 / US-007 / US-008).
 *
 * Render contract (#80, DEC-004):
 * - Output is a PNG at exactly the Composition's canvas dimensions. The
 *   canvas must be positive integers within the PNG parse caps
 *   (MAX_DIMENSION per axis, MAX_PIXELS total); invalid dimensions fail
 *   before any painting or output publication.
 * - Layers paint in reference-list order — later Layers paint over earlier
 *   ones — at each revision's stored position (x, y) and opacity in [0, 1],
 *   at the retained content's intrinsic size, clipped to the canvas. Areas
 *   no Layer covers stay transparent. Painting itself lives in
 *   `src/composition-paint.ts`, shared with historical replay (#87).
 * - Supported Layer effects in this foundation are position and opacity
 *   only. Text Layers are locally rendered DOM text (#81): each text
 *   revision's retained font bytes are loaded through an internal @font-face
 *   family (never re-consulting assets/fonts/), and every text layer's
 *   family is probed for actual load/resolution after page load — an
 *   unresolved face or unavailable font fails the render before any output
 *   is published.
 * - The Project lock covers the snapshot: the Composition document, its
 *   current revisions, and verified retained bytes are resolved exactly once
 *   through the canonical full resolver, then the lock is released and those
 *   exact bytes are painted. Retained bytes were hash-verified by that
 *   resolver; corrupted or missing content fails loudly and publishes no
 *   output.
 *
 * Render history (#87, US-007):
 * - Every successful Render captures a retained Project-owned manifest under
 *   the Project's renders/ directory — whatever PNG destination the caller
 *   chose (`--out` included). The manifest is built strictly from the locked
 *   snapshot plus the environment identity captured inside the same paint
 *   pass; it never re-consults Project state, so a concurrent current-state
 *   edit cannot mix revisions into a captured manifest.
 * - Owned history is published before the final output: a successful Render
 *   always reports both its PNG and its manifest. All fallible preparation
 *   (paint, manifest creation) precedes final output publication; if output
 *   publication fails, the freshly created manifest is removed — never a
 *   preexisting or concurrent winner (fresh names are O_EXCL-created by this
 *   render). No multi-file atomicity across a crash is promised: abrupt
 *   termination can leave a manifest without its PNG (replay regenerates the
 *   pixels from retained inputs) — the interrupted-operations notes in the
 *   storage contract cover recovery.
 * - The manifest's `output` field is informational (project-relative for
 *   in-Project destinations, the caller-chosen path verbatim for external
 *   ones); replay never requires the original PNG or any absolute path.
 * - Default output is a fresh, never-colliding file under the Project's
 *   renders/ directory. An explicit --out may resolve outside the Project or
 *   be a brand-new file directly under renders/; every existing in-Project
 *   path is protected state. External destinations are replaced by
 *   destination-entry atomic rename (temp file in the destination directory),
 *   so a hardlink alias onto Project state is never written through. A
 *   failed Render publishes no output and no history.
 */
import { lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { MAX_DIMENSION, MAX_PIXELS } from "./png.js";
import { readCompositionInternalFull } from "./composition.js";
import { resolveProjectRoot } from "./project.js";
import { atomicCreate, atomicReplace, withProjectLock } from "./project-lock.js";
import { paintComposition, type SnapshotLayer } from "./composition-paint.js";
import {
  buildRenderManifest,
  readRenderManifest,
  requireProjectRenderManifest,
  resolveHistoricalLayers,
  verifyEnvironmentMatch,
  type RenderManifestDocument,
} from "./render-history.js";
import type { Page } from "playwright";

export interface RenderCompositionResult {
  name: string;
  width: number;
  height: number;
  output: string;
  /** The retained Project-owned manifest published for this Render (#87). */
  manifest: string;
}

export interface RenderCompositionOptions {
  /** Caller-chosen export path; must resolve outside the Project. */
  out?: string;
}

/** Render a resolved Composition to a PNG and capture its history. See the module contract above. */
export async function renderComposition(
  projectPath: string,
  compName: string,
  options: RenderCompositionOptions = {},
): Promise<RenderCompositionResult> {
  const resolvedRoot = await resolveProjectRoot(projectPath);

  // Lock snapshot: resolve the Composition, its verified retained bytes, and
  // the output path as one consistent read, then release the lock before
  // painting. Painting never re-reads Project state.
  const snapshot = await withProjectLock(resolvedRoot, async () => {
    // One canonical pass: the document, every Layer's revision metadata, and
    // the verified retained bytes are resolved exactly once.
    const comp = await readCompositionInternalFull(resolvedRoot, compName);

    // One canonical cap check, shared with replay (INT-1): invalid dimensions
    // fail before any Layer resolution or output destination is staged.
    assertRenderableCanvas(comp.canvas, comp.name);

    const layers: SnapshotLayer[] = [];
    for (const use of comp.layers) {
      if (use.kind !== "image" && use.kind !== "text") {
        throw new Error(
          `Layer "${use.name}" in Composition "${comp.name}" has kind "${use.kind}", ` +
            `which this foundation cannot render.`,
        );
      }
      layers.push(toSnapshotLayer(use));
    }

    const destination = options.out
      ? await resolveExportTarget(resolvedRoot, options.out)
      : await defaultRenderDestination(resolvedRoot, comp.name);

    return { comp, layers, destination };
  });

  // Painting uses the snapshot's exact bytes and captures the environment
  // identity inside the same paint pass. A paint failure publishes nothing.
  const { png, environment } = await paintComposition(snapshot.comp.canvas, snapshot.layers);

  // The manifest is built purely from the in-memory snapshot — capture cannot
  // consult current state after the snapshot, whatever commits concurrently.
  const manifest: RenderManifestDocument = buildRenderManifest(
    { name: snapshot.comp.name, canvas: snapshot.comp.canvas, layers: snapshot.layers },
    environment,
    snapshot.destination.informationalOutput,
  );

  await publishRender(png, manifest, snapshot.destination);

  return {
    name: snapshot.comp.name,
    width: snapshot.comp.canvas.width,
    height: snapshot.comp.canvas.height,
    output: snapshot.destination.path,
    manifest: snapshot.destination.manifest,
  };
}

/**
 * Render caps shared by current rendering and historical replay: a manifest's
 * recorded canvas is untrusted input, so replay applies the exact limits the
 * render boundary enforces before painting anything (CRAFT-2).
 */
function assertRenderableCanvas(canvas: { width: number; height: number }, name: string): void {
  const { width, height } = canvas;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(
      `Invalid canvas dimensions ${width}×${height} for Composition "${name}": ` +
        `the render limit is ${MAX_DIMENSION}px per axis.`,
    );
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(
      `Invalid canvas dimensions ${width}×${height} for Composition "${name}": ` +
        `the render limit is ${MAX_PIXELS.toLocaleString("en-US")} pixels.`,
    );
  }
}

/**
 * The one publication path for render history and output, shared by render
 * and replay: owned history is created (O_EXCL) before the PNG is published,
 * so a successful render always reports both; output-publication failure
 * removes only the freshly created manifest — never a preexisting or
 * concurrently-winning file. No multi-file atomicity across a crash is
 * promised (documented in the storage contract).
 */
async function publishRender(
  png: Buffer,
  manifest: RenderManifestDocument,
  destination: ExportTarget,
): Promise<void> {
  await atomicCreate(destination.manifest, JSON.stringify(manifest, null, 2) + "\n");
  try {
    if (destination.mode === "create") {
      // Fresh destination (the default renders/ path, or a fresh in-Project
      // export): O_EXCL creation. A concurrent render racing the same fresh
      // path loses loudly here instead of silently replacing the winner's
      // output; the loser publishes nothing and its history is removed.
      await atomicCreate(destination.path, png);
    } else {
      // External export: destination-entry atomic replacement — write a temp
      // file in the destination directory and rename it over the target. The
      // rename swaps the directory entry — it never writes through the
      // target's inode, so an external hardlink alias onto Project state
      // (e.g. ply.json) keeps its original bytes. atomicReplace cleans up the
      // temp file on failure.
      await atomicReplace(destination.path, png);
    }
  } catch (err) {
    await unlink(destination.manifest).catch(() => {});
    throw err;
  }
}

export interface ReplayRenderOptions extends RenderCompositionOptions {
  /** Caller-owned page (tests: route-aborted offline evidence); never closed. */
  page?: Page;
}

/**
 * Replay a retained Render manifest (#87, US-007): regenerate the Render's
 * pixels byte-identically from the pinned historical inputs, independent of
 * current Layer revisions and Composition documents.
 *
 * Resolution order — every fallible step precedes output publication:
 * 1. The manifest is read and strictly parsed (malformed/unsupported history
 *    fails loudly, publishing nothing).
 * 2. The manifest must live inside the Project, outside reserved input
 *    storage (render history is Project-owned; relocation moves it along).
 * 3. Under the Project lock, every pinned use is resolved through the one
 *    canonical revision reader — the exact revision documents and their
 *    hash-verified retained bytes. Current Layer identity pointers and
 *    Composition documents are never consulted, so changed or removed
 *    current uses cannot invalidate replay.
 * 4. The pinned bytes are painted; the environment captured inside the same
 *    paint pass must exactly match the recorded one or replay is rejected
 *    before any output is published (byte identity is guaranteed within one
 *    environment, never claimed across environments).
 * 5. The replayed render is itself retained history: its manifest is
 *    published before its PNG under the same publication discipline as
 *    render — output-publication failure removes only the freshly created
 *    manifest.
 */
export async function replayRender(
  projectPath: string,
  manifestPath: string,
  options: ReplayRenderOptions = {},
): Promise<RenderCompositionResult> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  await requireProjectRenderManifest(resolvedRoot, manifestPath);
  const manifest = await readRenderManifest(manifestPath);

  // Locked historical snapshot: pinned revisions + verified retained bytes,
  // resolved exactly once. Painting never re-reads Project state.
  const layers = await withProjectLock(resolvedRoot, () => resolveHistoricalLayers(resolvedRoot, manifest));

  // A manifest's canvas is untrusted input: apply the same render caps as the
  // render boundary before any paint (CRAFT-2).
  assertRenderableCanvas(manifest.canvas, manifest.composition);

  const { png, environment } = await paintComposition(manifest.canvas, layers, { page: options.page });
  // Reject an unsupported environment before any output is published.
  verifyEnvironmentMatch(manifest.environment, environment);

  const destination = options.out
    ? await resolveExportTarget(resolvedRoot, options.out)
    : await defaultRenderDestination(resolvedRoot, manifest.composition);

  const replayedManifest: RenderManifestDocument = buildRenderManifest(
    { name: manifest.composition, canvas: manifest.canvas, layers },
    environment,
    destination.informationalOutput,
  );

  await publishRender(png, replayedManifest, destination);

  return {
    name: manifest.composition,
    width: manifest.canvas.width,
    height: manifest.canvas.height,
    output: destination.path,
    manifest: destination.manifest,
  };
}

/** Fresh, never-colliding default PNG+manifest destination under renders/. */
interface RenderDestination {
  path: string;
  manifest: string;
  informationalOutput: string;
  mode: "create" | "replace";
}

async function defaultRenderDestination(
  resolvedRoot: string,
  compName: string,
): Promise<RenderDestination> {
  const rendersDir = path.join(resolvedRoot, "renders");
  await mkdir(rendersDir, { recursive: true });
  for (;;) {
    const renderId = `${compName}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const output = path.join(rendersDir, `${renderId}.png`);
    try {
      await lstat(output);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      return {
        path: output,
        manifest: path.join(rendersDir, `${renderId}.manifest.json`),
        informationalOutput: `renders/${renderId}.png`,
        mode: "create",
      };
    }
  }
}

/**
 * A resolved --out destination and its publication mode: "create" for a
 * fresh destination (O_EXCL, so a concurrent render racing the same path
 * loses loudly instead of replacing the winner), "replace" for an existing
 * external regular file (destination-entry atomic rename). `manifest` is the
 * render history location under the Project's renders/ (always captured);
 * `informationalOutput` is the manifest's record of the destination —
 * project-relative for in-Project targets, the caller-chosen path verbatim
 * for external ones.
 */
interface ExportTarget {
  path: string;
  manifest: string;
  informationalOutput: string;
  mode: "create" | "replace";
}

/**
 * Reserved Project inputs a caller export may never create into or overwrite:
 * the manifest, the lock, and the canonical compositions/layers/content
 * storage. Existing paths anywhere in the Project (including render history
 * already in renders/) are refused separately by the existence check; fresh
 * paths under reserved storage are refused here.
 */
const RESERVED_PROJECT_PATHS = ["ply.json", ".ply.lock", "compositions", "layers", "content"];

/** Resolve an --out export target and refuse every path that could damage Project state or retained inputs. */
async function resolveExportTarget(resolvedRoot: string, outPath: string): Promise<ExportTarget> {
  const target = path.resolve(outPath);
  const realRoot = await realpath(resolvedRoot);

  let st: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    st = await lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`--out path "${outPath}" cannot be inspected: ${(err as Error).message}`);
    }
  }

  if (st) {
    let real: string;
    try {
      real = await realpath(target);
    } catch {
      throw new Error(`--out path "${outPath}" cannot be resolved (broken symlink?).`);
    }
    refuseExistingInsideProject(realRoot, real, outPath);
    if (st.isDirectory()) {
      throw new Error(`--out path "${outPath}" is a directory; it must name a PNG file.`);
    }
    if (!st.isFile() && !st.isSymbolicLink()) {
      throw new Error(`--out path "${outPath}" is not a regular file.`);
    }
    // The caller-chosen path is kept verbatim for writing and reporting; the
    // realpath above is only the containment guard.
    return {
      path: target,
      manifest: await freshHistoryManifest(resolvedRoot),
      informationalOutput: outPath,
      mode: "replace",
    };
  }

  const parent = path.dirname(target);
  let parentReal: string;
  try {
    parentReal = await realpath(parent);
  } catch {
    throw new Error(`--out parent directory does not exist: "${parent}"`);
  }
  const candidate = path.join(parentReal, path.basename(target));

  if (isWithinProject(realRoot, candidate)) {
    refuseReservedProjectPath(realRoot, candidate, outPath);
    return {
      path: target,
      manifest: await freshHistoryManifest(resolvedRoot),
      informationalOutput: relPath(realRoot, candidate),
      mode: "create",
    };
  }

  // Same caller-chosen-path rule: the realpath only proves the parent's real
  // location is outside the Project.
  return {
    path: target,
    manifest: await freshHistoryManifest(resolvedRoot),
    informationalOutput: outPath,
    mode: "replace",
  };
}

/** A fresh, never-colliding manifest path under the Project's renders/. */
async function freshHistoryManifest(resolvedRoot: string): Promise<string> {
  const rendersDir = path.join(resolvedRoot, "renders");
  await mkdir(rendersDir, { recursive: true });
  for (;;) {
    const candidate = path.join(rendersDir, `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.manifest.json`);
    try {
      await lstat(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return candidate;
      }
      throw err;
    }
  }
}

/** Portable `/`-separated path relative to the Project root (informational only). */
function relPath(fromDir: string, target: string): string {
  return path.relative(fromDir, target).split(path.sep).join("/");
}

function isWithinProject(realRoot: string, realTarget: string): boolean {
  const rel = path.relative(realRoot, realTarget);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function refuseReservedProjectPath(realRoot: string, realTarget: string, outPath: string): void {
  const rel = path.relative(realRoot, realTarget);
  const top = rel.split(path.sep)[0]!;
  if (rel === "" || RESERVED_PROJECT_PATHS.includes(top)) {
    throw new Error(
      `--out path "${outPath}" would create a file inside reserved Project storage ` +
        `(${rel === "" ? "." : top + "/"}); the manifest, lock, compositions/, layers/, content/, and ` +
        `render history are protected. Export elsewhere in the Project or outside it.`,
    );
  }
}

function refuseExistingInsideProject(realRoot: string, realTarget: string, outPath: string): void {
  const rel = path.relative(realRoot, realTarget);
  if (isWithinProject(realRoot, realTarget)) {
    throw new Error(
      `--out path "${outPath}" resolves inside the Project ` +
        `(${path.join(realRoot, rel)}); existing Project state and retained inputs cannot be exported over. ` +
        `Use a fresh path or a path outside the Project.`,
    );
  }
}

/**
 * A locked snapshot layer: the exact verified bytes plus discriminated
 * revision metadata, resolved once under the Project lock.
 */
function toSnapshotLayer(use: {
  name: string;
  layerId: string;
  revision: SnapshotLayer["revision"];
  contentBytes: Buffer;
}): SnapshotLayer {
  return { name: use.name, layerId: use.layerId, revision: use.revision, contentBytes: use.contentBytes };
}