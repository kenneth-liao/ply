/**
 * Composition rendering — paint a resolved local image Composition through the
 * shared render page (ADR-0013, DEC-001–006, #77 US-006 / US-008).
 *
 * Foundation render contract for successors (#80, DEC-004):
 * - Output is a PNG at exactly the Composition's canvas dimensions. The
 *   canvas must be positive integers within the PNG parse caps
 *   (MAX_DIMENSION per axis, MAX_PIXELS total); invalid dimensions fail
 *   before any painting or output publication.
 * - Layers paint in reference-list order — later Layers paint over earlier
 *   ones — at each revision's stored position (x, y) and opacity in [0, 1],
 *   at the retained content's intrinsic size, clipped to the canvas. Areas
 *   no Layer covers stay transparent.
 * - Supported Layer effects in this foundation are position and opacity
 *   only. Text Layers are locally rendered DOM text (#81): each text
 *   revision's retained font bytes are loaded through an internal @font-face
 *   family (never re-consulting assets/fonts/), and every text layer's
 *   family is probed for actual load/resolution after page load — an
 *   unresolved face or unavailable font fails the render before any output
 *   is published. Render-history capture/replay and advanced effects are
 *   separately scoped (#87).
 * - The Project lock covers the snapshot: the Composition document, its
 *   current revisions, and verified retained bytes are resolved exactly once
 *   through the canonical full resolver, then the lock is released and those
 *   exact bytes are painted. Retained bytes were hash-verified by that
 *   resolver; corrupted or missing content fails loudly and publishes no
 *   output.
 * - Default output is a fresh, never-colliding file under the Project's
 *   renders/ directory. An explicit --out may resolve outside the Project or
 *   be a brand-new file directly under renders/; every existing in-Project
 *   path is protected state. External destinations are replaced by
 *   destination-entry atomic rename (temp file in the destination directory),
 *   so a hardlink alias onto Project state is never written through. A
 *   failed Render publishes no output.
 */
import { lstat, mkdir, realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { MAX_DIMENSION, MAX_PIXELS } from "./png.js";
import { readCompositionInternalFull, type ResolvedCompositionLayerFull } from "./composition.js";
import { resolveProjectRoot } from "./project.js";
import { atomicCreate, atomicReplace, withProjectLock } from "./project-lock.js";
import { withRenderPage } from "./browser.js";
import type { Page } from "playwright";
import { familyResolved } from "./fonts.js";

const MIME: Record<"png" | "jpeg" | "webp", string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export interface RenderCompositionResult {
  name: string;
  width: number;
  height: number;
  output: string;
}

export interface RenderCompositionOptions {
  /** Caller-chosen export path; must resolve outside the Project. */
  out?: string;
}

/** Render a resolved Composition to a PNG. See the module contract above. */
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

    const { width, height } = comp.canvas;
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw new Error(
        `Invalid canvas dimensions ${width}×${height} for Composition "${comp.name}": ` +
          `the render limit is ${MAX_DIMENSION}px per axis.`,
      );
    }
    if (width * height > MAX_PIXELS) {
      throw new Error(
        `Invalid canvas dimensions ${width}×${height} for Composition "${comp.name}": ` +
          `the render limit is ${MAX_PIXELS.toLocaleString("en-US")} pixels.`,
      );
    }

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

    const output = options.out
      ? await resolveExportTarget(resolvedRoot, options.out)
      : { path: await defaultRenderOutput(resolvedRoot, comp.name), mode: "create" as const };

    return { comp, layers, output };
  });

  const png = await paintComposition(snapshot.comp.canvas, snapshot.layers);

  if (snapshot.output.mode === "create") {
    // Fresh destination (the default renders/ path, or a fresh in-Project
    // export): O_EXCL creation. A concurrent render racing the same fresh
    // path loses loudly here instead of silently replacing the winner's
    // output; the loser publishes nothing.
    await atomicCreate(snapshot.output.path, png);
  } else {
    // External export: destination-entry atomic replacement — write a temp
    // file in the destination directory and rename it over the target. The
    // rename swaps the directory entry — it never writes through the
    // target's inode, so an external hardlink alias onto Project state (e.g.
    // ply.json) keeps its original bytes. atomicReplace cleans up the temp
    // file on failure.
    await atomicReplace(snapshot.output.path, png);
  }

  return {
    name: snapshot.comp.name,
    width: snapshot.comp.canvas.width,
    height: snapshot.comp.canvas.height,
    output: snapshot.output.path,
  };
}

/** Fresh, never-colliding default output path under the Project's renders/. */
async function defaultRenderOutput(resolvedRoot: string, compName: string): Promise<string> {
  const rendersDir = path.join(resolvedRoot, "renders");
  await mkdir(rendersDir, { recursive: true });
  for (;;) {
    const candidate = path.join(
      rendersDir,
      `${compName}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.png`,
    );
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

/**
 * A resolved --out destination and its publication mode: "create" for a
 * fresh destination (O_EXCL, so a concurrent render racing the same path
 * loses loudly instead of replacing the winner), "replace" for an existing
 * external regular file (destination-entry atomic rename).
 */
interface ExportTarget {
  path: string;
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

/**
 * Resolve an --out export target and refuse every path that could damage
 * Project state or retained inputs. The target is judged by where it really
 * lands: an existing path (including a symlink alias) by its own realpath,
 * an absent path by its parent's realpath joined with its basename.
 *
 * - Every existing in-Project path is protected Project state and refused —
 *   render history in renders/, the manifest, canonical storage directories,
 *   and any symlink alias onto them (judged by realpath, so an in-project
 *   alias cannot dodge the guard).
 * - A fresh path with an existing parent directory is permitted anywhere in
 *   the Project except reserved storage (RESERVED_PROJECT_PATHS, which also
 *   covers fresh writes under compositions/, layers/, and content/). The
 *   parent must already exist; missing parents are refused, never created.
 *   Fresh in-Project targets publish with O_EXCL (mode "create"), so
 *   concurrent renders racing the same path cannot silently replace each
 *   other (RE-1).
 * - Outside the Project, the parent directory must exist, and the target
 *   publishes by destination-entry atomic replacement (mode "replace"), so a
 *   hardlink alias onto Project state is never written through.
 */
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
    return { path: target, mode: "replace" };
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
    return { path: target, mode: "create" };
  }

  // Same caller-chosen-path rule: the realpath only proves the parent's real
  // location is outside the Project.
  return { path: target, mode: "replace" };
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
type SnapshotLayer = {
  name: string;
  layerId: string;
  revision: ResolvedCompositionLayerFull["revision"];
  contentBytes: Buffer;
};

function toSnapshotLayer(use: ResolvedCompositionLayerFull): SnapshotLayer {
  return { name: use.name, layerId: use.layerId, revision: use.revision, contentBytes: use.contentBytes };
}

/**
 * Paint the snapshot's exact bytes through the shared render page: one
 * absolutely-positioned element per Layer at its stored position and opacity,
 * in reference-list order, over a transparent canvas sized to the
 * Composition. Images paint at intrinsic size; text layers paint as DOM text
 * with their retained font bytes declared under an internal @font-face
 * family (#81). The screenshot is taken only after every image has fully
 * decoded AND every text family has actually loaded — an unresolved face
 * fails the render instead of falling back silently.
 */
async function paintComposition(
  canvas: { width: number; height: number },
  layers: SnapshotLayer[],
): Promise<Buffer> {
  return withRenderPage(async (page) => {
    await page.setViewportSize({ width: canvas.width, height: canvas.height });
    await page.setContent(buildCompositionHtml(canvas, layers), { waitUntil: "load" });
    // Awaited decode: a partially painted canvas is never screenshotted.
    await page.evaluate(() => Promise.all(Array.from(document.images, (img) => img.decode())));
    await rejectUnresolvedFonts(page, layers);
    return page.screenshot({
      type: "png",
      omitBackground: true,
      clip: { x: 0, y: 0, width: canvas.width, height: canvas.height },
    });
  });
}

/**
 * Internal @font-face family name for a retained font blob (#81). Derived
 * from the content hash — the retained bytes are the only font identity, so
 * the renderer never needs the bundled registry or the original family name.
 */
function internalFontFamily(contentHash: string): string {
  return `ply-face-${contentHash.slice(0, 16)}`;
}

/**
 * Verify each text layer's font actually loaded and resolved in the page via
 * the shared family-resolution probe. Garbage bytes, undecodable faces, or a
 * failed load fall through to a fallback font — detected here and rejected
 * before any output is published.
 */
async function rejectUnresolvedFonts(page: Page, layers: SnapshotLayer[]): Promise<void> {
  const byFamily = new Map<string, string[]>();
  for (const l of layers) {
    if (l.revision.kind !== "text") continue;
    const family = internalFontFamily(l.revision.contentHash);
    byFamily.set(family, [...(byFamily.get(family) ?? []), l.name]);
  }
  const unresolved: string[] = [];
  for (const [family, names] of byFamily) {
    if (!(await page.evaluate(familyResolved, family))) {
      unresolved.push(`Layer "${names.join('", "')}"`);
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      `Font face failed to load from retained bytes for ${unresolved.join(", ")} — ` +
        `silent fallback is not allowed; the retained font content may be invalid or corrupted.`,
    );
  }
}

/** Minimal HTML escaping for text layer content (#81). */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The page HTML for one Composition. Layer names never reach the markup;
 * every interpolated value is a validated finite number, a whitelisted MIME
 * type, a hash-derived internal family, or the strict-hex validated color —
 * except text content, which is HTML-escaped.
 */
function buildCompositionHtml(canvas: { width: number; height: number }, layers: SnapshotLayer[]): string {
  const faces = new Map<string, Buffer>();
  for (const l of layers) {
    if (l.revision.kind === "text" && !faces.has(l.revision.contentHash)) {
      faces.set(l.revision.contentHash, l.contentBytes);
    }
  }
  const fontCss = [...faces]
    .map(
      ([hash, bytes]) =>
        `@font-face { font-family: "${internalFontFamily(hash)}"; ` +
        `src: url(data:font/ttf;base64,${bytes.toString("base64")}) format("truetype"); }`,
    )
    .join("\n");
  const els = layers
    .map((l) => {
      const rev = l.revision;
      const base = `position:absolute;left:${rev.x}px;top:${rev.y}px;opacity:${rev.opacity};`;
      if (rev.kind === "text") {
        const style =
          `${base}font-family:'${internalFontFamily(rev.contentHash)}';` +
          `font-size:${rev.fontSize}px;color:${rev.color};white-space:pre-wrap;`;
        return `<div style="${style}">${escapeHtml(rev.text)}</div>`;
      }
      return `<img src="data:${MIME[rev.format]};base64,${l.contentBytes.toString("base64")}" style="${base}">`;
    })
    .join("");
  return (
    `<!doctype html><html><head><style>` +
    fontCss +
    `html,body{margin:0;padding:0;background:transparent}` +
    `#canvas{position:relative;width:${canvas.width}px;height:${canvas.height}px;overflow:hidden}` +
    `</style></head>` +
    `<body><div id="canvas">${els}</div></body></html>`
  );
}