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
 * - The Project lock covers the snapshot: Composition references, current
 *   revisions, and verified retained bytes are read together, then the lock
 *   is released and those exact bytes are painted. Retained bytes were
 *   hash-verified by the canonical Layer resolver; corrupted or missing
 *   content fails loudly and publishes no output.
 * - Default output is a fresh, never-colliding file under the Project's
 *   renders/ directory; an explicit --out must resolve (through symlinks)
 *   outside the Project so no Project state or retained input can be
 *   clobbered. A failed Render publishes no output.
 */
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { MAX_DIMENSION, MAX_PIXELS } from "./png.js";
import { readLayerInternalFull } from "./layer.js";
import { readCompositionInternal } from "./composition.js";
import { resolveProjectRoot } from "./project.js";
import { atomicCreate, withProjectLock } from "./project-lock.js";
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
    const comp = await readCompositionInternal(resolvedRoot, compName);

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
      const full = await readLayerInternalFull(resolvedRoot, use.layerId);
      layers.push({
        name: use.name,
        layerId: use.layerId,
        revision: use.revision,
        contentBytes: full.contentBytes,
      });
    }

    const output = options.out
      ? await resolveExportTarget(resolvedRoot, options.out)
      : await defaultRenderOutput(resolvedRoot, comp.name);

    return { comp, layers, output };
  });

  const png = await paintComposition(snapshot.comp.canvas, snapshot.layers);

  if (options.out) {
    // An export target already existed only as an external regular file
    // (resolveExportTarget refused everything else); overwriting it is the
    // documented export semantics.
    await writeFile(snapshot.output, png);
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
 * an absent path by its parent's realpath joined with its basename. Anything
 * resolving inside the Project — the manifest, the content store, an alias
 * pointing at a retained input — is refused, and the parent directory must
 * exist. Outside the Project, an existing regular file is the documented
 * overwrite case.
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
    refuseInsideProject(realRoot, real, outPath);
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
  refuseInsideProject(realRoot, candidate, outPath);
  // Same caller-chosen-path rule: the realpath only proves the parent's real
  // location is outside the Project.
  return target;
}

function refuseInsideProject(realRoot: string, realTarget: string, outPath: string): void {
  const rel = path.relative(realRoot, realTarget);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new Error(
      `--out path "${outPath}" resolves inside the Project ` +
        `(${path.join(realRoot, rel)}); Project state and retained inputs cannot be exported over. ` +
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