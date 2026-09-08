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
 *   only. Text Layers, Render-history capture/replay, and advanced effects
 *   are separately scoped (#81, #87).
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
import { readCompositionInternalFull } from "./composition.js";
import { resolveProjectRoot } from "./project.js";
import { atomicCreate, atomicReplace, withProjectLock } from "./project-lock.js";
import { withRenderPage } from "./browser.js";

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

    const layers = [];
    for (const use of comp.layers) {
      if (use.kind !== "image") {
        throw new Error(
          `Layer "${use.name}" in Composition "${comp.name}" has kind "${use.kind}", ` +
            `which this foundation cannot render.`,
        );
      }
      layers.push({
        name: use.name,
        layerId: use.layerId,
        revision: use.revision,
        contentBytes: use.contentBytes,
      });
    }

    const output = options.out
      ? await resolveExportTarget(resolvedRoot, options.out)
      : await defaultRenderOutput(resolvedRoot, comp.name);

    return { comp, layers, output };
  });

  const png = await paintComposition(snapshot.comp.canvas, snapshot.layers);

  if (options.out) {
    // Destination-entry atomic replacement: write a temp file in the
    // destination directory and rename it over the target. The rename swaps
    // the directory entry — it never writes through the target's inode, so an
    // external hardlink alias onto Project state (e.g. ply.json) keeps its
    // original bytes. atomicReplace cleans up the temp file on failure.
    await atomicReplace(snapshot.output, png);
  } else {
    // Project-owned default output is always a brand-new file; O_EXCL keeps
    // a collision from silently replacing an earlier Render.
    await atomicCreate(snapshot.output, png);
  }

  return {
    name: snapshot.comp.name,
    width: snapshot.comp.canvas.width,
    height: snapshot.comp.canvas.height,
    output: snapshot.output,
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
 * Resolve an --out export target and refuse every path that could damage
 * Project state or retained inputs. The target is judged by where it really
 * lands: an existing path (including a symlink alias) by its own realpath,
 * an absent path by its parent's realpath joined with its basename.
 *
 * - Every existing in-Project path is protected Project state and refused —
 *   the manifest, canonical storage directories, retained inputs, render
 *   outputs, and any symlink alias onto them. The realpath check cannot be
 *   fooled by an alias, but it also cannot see hardlinks; hardlink safety is
 *   provided by writing through destination-entry atomic replacement (see
 *   the render write site), never by writing through the target's inode.
 * - A brand-new file directly under the Project's renders/ is a safe
 *   in-Project export and is permitted; any other absent in-Project location
 *   (root, compositions/, layers/, content/) is refused.
 * - Outside the Project, the parent directory must exist; an existing
 *   regular file (or symlink onto one) is the documented overwrite case.
 */
async function resolveExportTarget(resolvedRoot: string, outPath: string): Promise<string> {
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
    return target;
  }

  const parent = path.dirname(target);
  let parentReal: string;
  try {
    parentReal = await realpath(parent);
  } catch {
    throw new Error(`--out parent directory does not exist: "${parent}"`);
  }
  const candidate = path.join(parentReal, path.basename(target));

  if (isInsideDir(realRoot, candidate)) {
    // In-Project export: only a brand-new file directly in renders/ is safe.
    // content/, compositions/, layers/, and the Project root are protected
    // storage; nothing else in the Project gains caller files.
    const rendersReal = await realpath(path.join(realRoot, "renders"));
    const rel = path.relative(rendersReal, candidate);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes("/")) {
      throw new Error(
        `--out path "${outPath}" would create a file inside the Project at a protected location. ` +
          `A new export inside the Project must go directly into renders/; ` +
          `everything else in the Project is protected state.`,
      );
    }
    return target;
  }

  // Same caller-chosen-path rule: the realpath only proves the parent's real
  // location is outside the Project.
  return target;
}

function isInsideDir(realRoot: string, realTarget: string): boolean {
  const rel = path.relative(realRoot, realTarget);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function refuseExistingInsideProject(realRoot: string, realTarget: string, outPath: string): void {
  const rel = path.relative(realRoot, realTarget);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new Error(
      `--out path "${outPath}" resolves inside the Project ` +
        `(${path.join(realRoot, rel)}); existing Project state and retained inputs cannot be exported over. ` +
        `Use the default renders/ output or a path outside the Project.`,
    );
  }
}

interface PaintLayer {
  name: string;
  revision: { format: "png" | "jpeg" | "webp"; x: number; y: number; opacity: number };
  contentBytes: Buffer;
}

/**
 * Paint the snapshot's exact bytes through the shared render page: one
 * absolutely-positioned image per Layer at its stored position and opacity,
 * intrinsic size, in reference-list order, over a transparent canvas sized
 * to the Composition. The screenshot is taken only after every image has
 * fully decoded.
 */
async function paintComposition(
  canvas: { width: number; height: number },
  layers: PaintLayer[],
): Promise<Buffer> {
  return withRenderPage(async (page) => {
    await page.setViewportSize({ width: canvas.width, height: canvas.height });
    await page.setContent(buildCompositionHtml(canvas, layers), { waitUntil: "load" });
    // Awaited decode: a partially painted canvas is never screenshotted.
    await page.evaluate(() => Promise.all(Array.from(document.images, (img) => img.decode())));
    return page.screenshot({
      type: "png",
      omitBackground: true,
      clip: { x: 0, y: 0, width: canvas.width, height: canvas.height },
    });
  });
}

/**
 * The page HTML for one Composition. Layer names never reach the markup;
 * every interpolated value is a validated finite number or a whitelisted
 * MIME type, so the markup needs no escaping.
 */
function buildCompositionHtml(canvas: { width: number; height: number }, layers: PaintLayer[]): string {
  const imgs = layers
    .map((l) => {
      const style = `position:absolute;left:${l.revision.x}px;top:${l.revision.y}px;opacity:${l.revision.opacity};`;
      return `<img src="data:${MIME[l.revision.format]};base64,${l.contentBytes.toString("base64")}" style="${style}">`;
    })
    .join("");
  return (
    `<!doctype html><html><head><style>` +
    `html,body{margin:0;padding:0;background:transparent}` +
    `#canvas{position:relative;width:${canvas.width}px;height:${canvas.height}px;overflow:hidden}` +
    `</style></head>` +
    `<body><div id="canvas">${imgs}</div></body></html>`
  );
}