/**
 * Composition authoring, layer reference management, and inspection (ADR-0013, ADR-0014, DEC-001–006).
 */
import { readFile, readdir, lstat, mkdir, unlink, rmdir, realpath, readlink } from "node:fs/promises";
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
  resolveTextTypographyControls,
  resolveTextWrapWidthControl,
  resolveTextFitBoxControl,
  textFitBoxNarrowerThanWrapRefusal,
  textFitRefusal,
  validateShapeContent,
  shapeContentIdentity,
  type LayerShapeGeometry,
} from "./layer.js";
import { resolveFace, resolveTextAxes, fontAssetBytes, callerFontFace, verifyCallerFontResolves, type CallerFontFacts } from "./fonts.js";
import { readCallerFontFile } from "./font-file.js";
import { measureTextFit } from "./composition-measure.js";
import { refuseDivergentPerspectiveProjection, storedEffectStack } from "./layer.js";
import { type LayerFill, canonicalizeTextFillForStorage } from "./fill.js";
import {
  type ResolvedTextInputRuns,
  resolveTextInputRuns,
  type SnapshotRunFont,
  type TextInputRuns,
} from "./layer.js";
import {
  oneCommandApplicationOrder,
  applyLayerOption,
  type SharedOptionApplyContext,
  type SharedOptionValues,
  type SharedOptionDraft,
} from "./layer-options.js";
import {
  provisionalScaleContext,
  type OneCommandOptionValues,
} from "./one-command.js";
import {
  selectGenerationOutput,
  retainGenerationRecord,
  type GenerationOutputSelection,
  type RetainedProvenance as RetainedGenerationProvenance,
} from "./generation-retention.js";
import {
  selectMatteOutput,
  retainMattingRecord,
  retainMattingSourceBytes,
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
  kind: "image" | "text" | "shape";
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
  position?: StackPosition,
): Promise<{ layerId: string; layer: ResolvedLayer }> {
  // Stack position (#230): resolved BEFORE any content retention, revision
  // staging, or identity staging — an unknown use name refuses here with
  // the Composition's use names and nothing is published.
  const insertIndex = position ? resolveStackPositionIndex(comp, position) : comp.layers.length;
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
    const updatedLayers = [...comp.layers];
    updatedLayers.splice(insertIndex, 0, { name: localName, layerId });
    const updatedComp: Composition = {
      ...comp,
      layers: updatedLayers,
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
 * The Project's stored Composition names, sorted alphabetically (deliberate:
 * deterministic across filesystems, unlike directory order) — the "what
 * exists" listing that address and Composition command refusals name
 * (spec #226, #289 DEC-003). Guidance only: no lock and no Layer resolution.
 * Takes the resolved Project root, the same convention as
 * `readCompositionDocument` (#289 review INT-3).
 */
export async function listCompositionNames(resolvedRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(path.join(resolvedRoot, "compositions"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  return entries.filter((f) => f.endsWith(".json")).map((f) => path.basename(f, ".json")).sort();
}

/**
 * The one missing-Composition refusal (DEC-003): names the missing
 * Composition and lists what exists, so no raw filesystem error such as
 * ENOENT reaches output.
 */
async function missingCompositionError(
  resolvedRoot: string,
  compName: string,
): Promise<Error> {
  const names = await listCompositionNames(resolvedRoot);
  const listing =
    names.length === 0
      ? "No Compositions exist in this Project yet."
      : `Existing Compositions: ${names.map((n) => `"${n}"`).join(", ")}.`;
  return new Error(`Composition "${compName}" not found in project. ${listing}`);
}

/**
 * Unlocked internal reader for stored Composition JSON documents.
 * Verifies Project boundary containment and parses the stored document through
 * the canonical parser.
 *
 * Exported as the ONE read-only document reader for Layer name-address
 * resolution and all Composition commands (spec #226 US-003, spec #285 DEC-003):
 * every command resolves Composition documents through this single reader.
 * Refuses missing compositions with a formatted listing of what exists, and
 * enforces boundary containment whether or not the target exists.
 */
export async function readCompositionDocument(
  resolvedRoot: string,
  compName: string,
): Promise<{ comp: Composition; compFile: string }> {
  const compDir = path.join(resolvedRoot, "compositions");
  const compFile = path.join(compDir, `${compName}.json`);

  // 1. Lexical boundary containment check: cannot escape compositions/ or project root,
  // whether or not the target exists.
  if (outsideDir(compDir, compFile) || outsideDir(resolvedRoot, compFile)) {
    throw new Error(`Security error: composition "${compName}" escapes project boundary.`);
  }

  // 2. Check existence / symlink via lstat
  let st;
  try {
    st = await lstat(compFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw await missingCompositionError(resolvedRoot, compName);
    }
    throw err;
  }

  // 3. Symlink / realpath containment check
  if (st.isSymbolicLink()) {
    try {
      if (await escapesDirReal(resolvedRoot, compFile)) {
        throw new Error(`Security error: composition "${compName}" escapes project boundary.`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Dangling symlink: verify where the link points
        const linkTarget = await readlink(compFile);
        const realRoot = await realpath(resolvedRoot).catch(() => resolvedRoot);
        const realDirname = await realpath(path.dirname(compFile)).catch(() => path.dirname(compFile));
        const resolvedTarget = path.resolve(realDirname, linkTarget);
        // Either signal refuses: the resolved target may not leave the real
        // Project root, and it may not leave it lexically either (the same
        // strictness whether or not the target exists, #289).
        if (outsideDir(realRoot, resolvedTarget) || outsideDir(resolvedRoot, path.resolve(path.dirname(compFile), linkTarget))) {
          throw new Error(`Security error: composition "${compName}" escapes project boundary.`);
        }
        throw await missingCompositionError(resolvedRoot, compName);
      }
      throw err;
    }
  } else {
    if (await escapesDirReal(resolvedRoot, compFile)) {
      throw new Error(`Security error: composition "${compName}" escapes project boundary.`);
    }
  }

  // 4. File exists and is contained: read and parse
  let compRaw: string;
  try {
    compRaw = await readFile(compFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw await missingCompositionError(resolvedRoot, compName);
    }
    throw err;
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

/**
 * Stack position on add and import (#230, spec #226 US-002, DEC-004). Paint
 * order stays owned by the Composition's ordered use list (ISC-6, ADR-0013):
 * a position is a creation-time argument that selects an insertion point in
 * that list — never a Layer revision fact, so no Layer revision stores one
 * and the position is deliberately NOT a member of the shared Layer option
 * table (`LAYER_OPTION_DEFS`, #228) and never appears on layer edit.
 *
 * - `top` — appended after every existing use (painted last, on top). This
 *   is the default: absent, an add or import behaves exactly as before.
 * - `bottom` — prepended before every existing use (painted first).
 * - `before:<use-name>` / `after:<use-name>` — inserted immediately before
 *   or after the named existing use in paint order.
 */
export type StackPosition =
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "before"; useName: string }
  | { kind: "after"; useName: string };

/**
 * The ONE position reader (spec #226 US-002): grammar parsing shared by the
 * `composition add` and `composition import` command boundaries — the flag
 * spelling is a single spec string following the established `--anchor`
 * convention (DEC-009). The use name reuses the one name rule
 * (`sanitizeName`), so the existing use-name grammar applies unchanged.
 * Grammar errors throw here (usage errors at the command boundary); the
 * unknown-use refusal is semantic and runs in
 * `resolveStackPositionIndex` inside the publication path, before anything
 * is published.
 */
export function parseStackPosition(spec: string): StackPosition {
  const trimmed = spec.trim();
  if (trimmed === "top") return { kind: "top" };
  if (trimmed === "bottom") return { kind: "bottom" };
  const named = /^(before|after):(.+)$/.exec(trimmed);
  if (named) {
    const kind = named[1] as "before" | "after";
    const useName = sanitizeName(named[2]!.trim());
    return { kind, useName };
  }
  throw new Error(
    `Invalid --position "${spec}": use "top", "bottom", "before:<use-name>", or "after:<use-name>" (an existing use of the target Composition).`,
  );
}

/** Compact display form of a parsed position (compact text output, refusals). */
export function stackPositionSpec(position: StackPosition): string {
  return position.kind === "before" || position.kind === "after"
    ? `${position.kind}:${position.useName}`
    : position.kind;
}

/**
 * The ONE position validation (spec #226 US-002): resolve a parsed position
 * against a Composition's ordered use list to the insertion index. Runs
 * inside the publication path BEFORE any content retention, revision
 * staging, or use commit, so an unknown use name is refused with the
 * Composition's use names listed and nothing is published — no Layer, no
 * use, no content (#229's fail-closed ordering).
 */
export function resolveStackPositionIndex(comp: Composition, position: StackPosition): number {
  if (position.kind === "top") return comp.layers.length;
  if (position.kind === "bottom") return 0;
  const index = comp.layers.findIndex((use) => use.name === position.useName);
  if (index === -1) {
    const uses =
      comp.layers.length === 0
        ? "the Composition has no uses"
        : `the Composition's uses are: ${comp.layers.map((use) => `"${use.name}"`).join(", ")}`;
    throw new Error(
      `Unknown use "${position.useName}" for --position ${stackPositionSpec(position)}: ${uses}.`,
    );
  }
  return position.kind === "before" ? index : index + 1;
}

export interface AddLayerOptions {
  x?: number;
  y?: number;
  opacity?: number;
  /**
   * Stack position (#230, spec #226 US-002, DEC-004): where the new use
   * goes in the Composition's paint order. Parsed once at the command
   * boundary through `parseStackPosition`; validated against the target
   * Composition inside the publication path before anything is published.
   * Absent keeps the established append-at-top behavior byte-identical.
   */
  position?: StackPosition;
  /**
   * One-command creation (#229, spec #226 US-001/DEC-002): the post-content
   * options — transforms, anchored placement, effects — applied to the
   * initial revision in the documented order, publishing exactly one Layer
   * revision. Normalized at the command boundary through the ONE shared
   * parse (`parseOneCommandOptionValues`, DEC-001); the semantic
   * resolutions run here, before any content retention or revision staging,
   * so a refused option publishes nothing. Absent (or empty) keeps the
   * established single-option add behavior byte-identical.
   */
  oneCommand?: OneCommandOptionValues;
}

/**
 * One-command option application (spec #226 US-001, DEC-002): the ONE
 * publication-path step for applying one-command `composition add`'s
 * post-content options to a freshly built content revision — transforms
 * first, then anchored placement, then effects, the order derived from the
 * shared option table's group fact (`oneCommandApplicationOrder`) — so the
 * result equals the documented multi-command sequence and publishes exactly
 * ONE Layer revision. Everything here runs inside the publication protocol
 * BEFORE any content retention or revision staging, so a refused option
 * publishes nothing: no Layer, no use, no content.
 *
 * With no post-content option supplied the revision is returned untouched,
 * so existing `add` invocations keep their meaning and their exact stored
 * revision bytes.
 *
 * There is NO per-option application code here (DEC-001, A226-002, #263):
 * each supplied key dispatches through its ONE shared application case,
 * carried on the shared option table itself (the case takes the context it
 * resolves against — the stored revision under lock on edit, the
 * provisional fresh revision here), and a key without a case fails loudly
 * (review INT-plumb-1): an option that parses at the command boundary but
 * has no application case would otherwise be silently dropped while the
 * guard test stays green — exactly the parse-but-drop gap. The guard test
 * (TEST-003) reads the applied facts back from the published revision per
 * kind, and the probe test registers a new option through the shared
 * definition alone, so a future table key without a case fails the build,
 * not a Project.
 */
async function applyOneCommandOptions(
  revision: LayerRevision,
  options: SharedOptionValues | undefined,
  context: SharedOptionApplyContext,
): Promise<LayerRevision> {
  // The application order reads the option table by its own key names; the
  // parsed values are already keyed by those keys — no name mapping.
  const supplied = oneCommandApplicationOrder(options ?? {});
  if (supplied.length === 0) {
    return revision;
  }
  const rev = { ...revision } as SharedOptionDraft;
  // The shared cases resolve against the fresh content's provisional facts
  // at scale 1 (`provisionalScaleContext`) — the stored-revision-under-lock
  // side of the same context the edit path supplies.
  const applyContext: SharedOptionApplyContext = {
    ...context,
    surface: "add",
    base: provisionalScaleContext(context),
    layerId: revision.layerId,
    parsed: options ?? {},
  };
  for (const key of supplied) {
    // The ONE single-option dispatch (DEC-001, #263): the same lookup the
    // edit path runs — a parse-present/apply-missing key fails loudly
    // here, never silently dropped.
    await applyLayerOption(key, rev, options![key], applyContext);
  }
  // The divergent-perspective publication gate (PROD-1, #298 review): the
  // ONE refusal the add and edit publication paths share, run on the
  // resulting revision before anything stages — the tilt can only come
  // from the supplied options on this surface, and the fresh revision
  // pins the fresh content's bytes. The extent is the fresh content's
  // intrinsic size (every non-text add dispatcher supplies it); a text
  // Layer's extent is measured from its bytes inside the gate.
  await refuseDivergentPerspectiveProjection(
    rev as unknown as LayerRevision,
    context.intrinsic,
    context.contentBytes,
    context.runFonts,
  );
  return rev as unknown as LayerRevision;
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
      // One-command application (DEC-002) runs BEFORE any retention: a
      // refused option publishes nothing — no Layer, no use, no content.
      const revision = await applyOneCommandOptions(
        {
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
          rotationDeg: 0,
          flipX: false,
          flipY: false,
        },
        options.oneCommand,
        {
          composition: sanitizedComp,
          canvas: comp.canvas,
          contentBytes: ingested.bytes,
          format: ingested.format,
          intrinsic: { width: ingested.width, height: ingested.height },
        },
      );
      await storeContentBlob(projectPath, ingested.contentHash, ingested.bytes);
      return revision;
    }, options.position).then(({ layerId, layer }) => ({ composition: sanitizedComp, use: { name: sanitizedLocalName, layerId }, layer }));
  });
}

/**
 * Add a locally rendered text Layer (#81, #232) through the exact image
 * publication protocol: same identity/revision/use staging, same lock, same
 * rollback. The font is resolved once here — a bundled family from the
 * registry, or a caller-supplied file whose bytes are read and whose facts
 * are parsed ONCE from the file's own tables (#232, DEC-006) — and its raw
 * bytes are retained into the Project content store as the revision's
 * content identity. A caller font's own facts are stored with the revision;
 * bundled family/weight facts live only in the bundled-face registry — the
 * stored revision pins the bytes, text, size, color, axes, and (for a
 * caller font) the file's facts.
 */
export async function addTextLayerToComposition(
  projectPath: string,
  compName: string,
  localName: string,
  input: {
    /** Rendered string content (nonempty, ≤ MAX_TEXT_LENGTH). With runs
     *  (#297), the --run occurrences' concatenation is the text — one form
     *  or the other, never both. */
    text?: string;
    /**
     * A bundled font family name — resolved once at add, never re-consulted.
     * Mutually exclusive with `fontFile`: one font source per Layer (#232).
     */
    font?: string;
    /**
     * A caller-supplied font file (#232, spec #226 US-005, DEC-006): a path
     * to a local TrueType/OpenType font. The bytes are read and their facts
     * parsed ONCE here, the file is retained by content identity through the
     * same path bundled faces use, and the revision stores the file's own
     * facts — so rendering, measure, replay, relocation, and cross-Project
     * import never need the original file. Mutually exclusive with `font`.
     */
    fontFile?: string;
    /** Strict hex color (#RGB / #RRGGBB); default #ffffff. */
    color?: string;
    /**
     * Optional text axes (#179/#196, ADR-0021): validated against the face's
     * real axis ranges — a variable face stores the resolved pair (omitted
     * controls resolve to its default instance), a static face accepts only
     * its own weight and its implicit width (100) or omission.
     */
    weight?: number;
    width?: number;
    /**
     * Optional text typography (#187, ADR-0021): font-independent, validated
     * against the fixed allowed ranges — tracking in em (-0.5..1, a 0 is
     * stored as absent), line height as a unitless multiplier (0.5..3). Each
     * field is stored only when set.
     */
    tracking?: number | null;
    lineHeight?: number | null;
    /**
     * Optional text wrap width in layout px (#294, spec #285 US-015,
     * ISC-55, DEC-001/DEC-005, ADR-0017 amendment): font-independent,
     * validated as a positive finite number at the ONE domain boundary — a
     * refused width publishes nothing, and a set value is stored only when
     * set. `null` is the removal form (meaningless on add — there is no
     * previous value — and stores nothing).
     */
    wrapWidth?: number | null;
    /**
     * Optional text fit box in layout px (#295, spec #285 US-016, ISC-56,
     * DEC-010/DEC-005): validated as a pair of positive finite numbers at
     * the ONE domain boundary — a refused box publishes nothing, and a set
     * value is stored only when set. `null` is the removal form (meaningless
     * on add — there is no previous value — and stores nothing).
     */
    fitBox?: { width: number; height: number } | null;
    /**
     * Text runs (#297, spec #285 US-017, ISC-54, ADR-0021 amendment): the
     * run texts whose concatenation IS the Layer text, plus per-run style
     * edits by 1-based index. One occurrence normalizes to the single-run
     * form at the ONE ingestion point (`resolveTextInputRuns`); fewer than
     * two runs means no runs field — a single-run Layer is today's text
     * Layer. Omitted: the plain `--text` form.
     */
    runs?: TextInputRuns;
  },
  options: AddLayerOptions & { fontSize?: number } = {},
): Promise<{ composition: string; use: CompositionLayerUse; layer: ResolvedLayer }> {
  const sanitizedComp = sanitizeName(compName);
  const sanitizedLocalName = sanitizeName(localName);

  // One font source per Layer (#232): a bundled family (--font) and a caller
  // font file (--font-file) are mutually exclusive — the same exclusivity
  // rule the command boundary enforces, re-checked at the domain boundary.
  if (input.font !== undefined && input.fontFile !== undefined) {
    throw new Error(
      "--font and --font-file name one font per edit — pass a bundled family (--font) or a local font file (--font-file), not both.",
    );
  }
  // Runs vs plain text (#297): the run occurrences and the whole-text form
  // are one content — the command boundary refuses the pair, the domain
  // re-checks so no caller of the functions can bypass it.
  if (input.text !== undefined && input.runs !== undefined) {
    throw new Error(
      "--text and --run are mutually exclusive content options: --text is the single-run form; author runs with one or more --run occurrences.",
    );
  }

  const { x, y, opacity } = parsePlacement(options);
  const fontSize = options.fontSize ?? 48;

  // The runs facts (#297) resolve at the ONE ingestion point
  // (`resolveTextInputRuns`), which also owns the single-run fold: per-run
  // style edits that leave a single run fold into the Layer-level facts
  // there (a single-run Layer IS today's text Layer) — never pre-handled or
  // dropped by the CLI. The Layer font resolves through the SAME callback
  // the fold's font override goes through, AFTER the fold, so the folded
  // face is the face the Layer stores.
  const runsInput = input.runs;
  const layerFontInput = {
    ...(input.font !== undefined ? { font: input.font } : {}),
    ...(input.fontFile !== undefined ? { fontFile: input.fontFile } : {}),
  };
  const text = runsInput !== undefined ? runsInput.runTexts.join("") : input.text ?? "";
  const resolvedRuns = await resolveTextInputRuns({
    text,
    ...(runsInput !== undefined ? { runs: runsInput } : {}),
    layerFontInput,
    ...(input.color !== undefined ? { layerColorSpec: input.color } : {}),
    ...(input.weight !== undefined ? { layerWeight: input.weight } : {}),
    ...(input.width !== undefined ? { layerWidth: input.width } : {}),
    resolveLayerFont: async (fontInput) => {
      if (fontInput.fontFile !== undefined) {
        const ingested = await readCallerFontFile(fontInput.fontFile);
        return {
          face: callerFontFace(ingested.facts),
          bytes: ingested.bytes,
          callerFont: ingested.facts,
          contentHash: createHash("sha256").update(ingested.bytes).digest("hex"),
        };
      }
      const face = resolveFace(fontInput.font!);
      const bytes = fontAssetBytes(face);
      return { face, bytes, contentHash: createHash("sha256").update(bytes).digest("hex") };
    },
  });
  const { face, bytes, callerFont, contentHash: layerContentHash } = resolvedRuns.layerFont;
  const rawColor = resolvedRuns.folded?.color ?? input.color ?? "#ffffff";
  // Axes resolve BEFORE any retention, so a refused control publishes
  // nothing — not even a stray content blob (#179, ADR-0021). The fold's
  // raw axis controls ride beside the Layer's own.
  const axes = resolveTextAxes(face, {
    weight: resolvedRuns.folded?.weight ?? input.weight,
    width: resolvedRuns.folded?.width ?? input.width,
  });
  // Canonical text validation at the ingestion boundary; the stored-revision
  // parser reuses the same validator (the folded colour is canonical —
  // exactly the Layer colour path's stored form — and re-validates here).
  const fill = validateTextContent(text, fontSize, rawColor);
  const color = canonicalizeTextFillForStorage(fill);
  const runsField = resolvedRuns.runs;
  const runFontsToRetain = resolvedRuns.runFonts;

  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, async () => {
    const { comp, compFile } = await readMutableComposition(resolvedRoot, sanitizedComp, sanitizedLocalName);

    return publishLayerUse(resolvedRoot, comp, compFile, sanitizedLocalName, async (layerId, createdAt) => {
      // The Layer font resolved at the ONE ingestion point above (through
      // the same resolveFace/readCallerFontFile flow): unknown families,
      // unreadable or non-font files, missing bundled bytes, and
      // out-of-range/unsupported weight or width controls refused before
      // anything is published.
      // Typography resolves at the same one boundary (#187, ADR-0021) — a
      // refused tracking/line-height publishes nothing, and a set value is
      // stored only when set (a tracking of 0 is the same look as absent).
      const typography = resolveTextTypographyControls({
        tracking: input.tracking,
        lineHeight: input.lineHeight,
      });
      // The wrap width resolves at the same one boundary (#294, DEC-001/
      // DEC-005) — a refused width publishes nothing, and a set value is
      // stored only when set.
      const wrapWidth = resolveTextWrapWidthControl(input.wrapWidth);
      // The fit box resolves at the same one boundary (#295, DEC-010/
      // DEC-005) — a refused box publishes nothing, and a set value is
      // stored only when set. The fit/wrap combination rule compares the
      // resolved values: a box narrower than the wrap width could never be
      // satisfied by shrinking, so it is refused here.
      const fitBox = resolveTextFitBoxControl(input.fitBox);
      if (fitBox !== undefined && wrapWidth !== undefined && fitBox.width < wrapWidth) {
        throw new Error(textFitBoxNarrowerThanWrapRefusal(fitBox.width, wrapWidth));
      }
      const contentHash = layerContentHash;
      if (callerFont !== undefined) {
        // The render probe's family-resolution gate applies to caller fonts
        // BEFORE publication (#232): a file the browser cannot resolve
        // refuses with no Layer, no use, and no stray content blob.
        await verifyCallerFontResolves(contentHash, bytes, callerFont);
      }
      // One-command application (DEC-002) runs BEFORE any retention: a
      // refused option publishes nothing — no Layer, no use, no content.
      const revision = await applyOneCommandOptions(
        {
          schemaVersion: LAYER_SCHEMA_VERSION,
          layerId,
          createdAt,
          kind: "text",
          contentHash,
          text,
          fontSize,
          color,
          layoutRule: "natural",
          ...(axes.weight !== undefined ? { weight: axes.weight, width: axes.width } : {}),
          ...(typography.tracking !== undefined ? { tracking: typography.tracking } : {}),
          ...(typography.lineHeight !== undefined ? { lineHeight: typography.lineHeight } : {}),
          ...(wrapWidth !== undefined ? { wrapWidth } : {}),
          ...(fitBox !== undefined ? { fitWidth: fitBox.width, fitHeight: fitBox.height } : {}),
          ...(callerFont !== undefined ? { callerFont } : {}),
          ...(runsField !== undefined ? { runs: runsField } : {}),
          x,
          y,
          opacity,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          flipX: false,
          flipY: false,
        },
        options.oneCommand,
        {
          composition: sanitizedComp,
          canvas: comp.canvas,
          contentBytes: bytes,
          ...(runFontsToRetain.length > 0 ? { runFonts: runFontsToRetain } : {}),
        },
      );
      // Fit-to-box validation (#295, spec #285 US-016, DEC-010): the box is
      // validated against the FINAL revision before anything is retained or
      // published — the ONE in-page fit derivation (the same pass paint,
      // measure, and anchor run) derives the effective size, and text that
      // cannot fit at the minimum size is refused, naming the box and the
      // size needed. A refused add leaves no Layer, no use, and no content.
      if (revision.kind === "text" && revision.fitWidth !== undefined) {
        const fit = await measureTextFit(
          { ...revision, x: 0, y: 0 } as ResolvedLayerRevision,
          bytes,
          { ...(runFontsToRetain.length > 0 ? { runFonts: runFontsToRetain } : {}) },
        );
        if (fit !== null && !fit.fits) {
          throw new Error(
            textFitRefusal(revision.text, revision.fitWidth, revision.fitHeight!, fit.neededFontSize ?? revision.fontSize),
          );
        }
      }
      await storeContentBlob(projectPath, contentHash, bytes);
      // Run font retention (#297): the SAME content-store path, AFTER the
      // final revision has validated — a refused add leaves no Layer, no
      // use, and no content blob, layer or run.
      for (const runFont of runFontsToRetain) {
        await storeContentBlob(projectPath, runFont.contentHash, runFont.bytes);
      }
      return revision;
    }, options.position).then(({ layerId, layer }) => ({
      composition: sanitizedComp,
      use: { name: sanitizedLocalName, layerId },
      layer,
    }));
  });
}

/**
 * Add a shape Layer (#208, spec #207 US-001, DEC-001/002/003) through the
 * exact image/text publication protocol: same identity/revision/use staging,
 * same lock, same rollback. The Layer is created from parameters alone —
 * geometry, size, optional corner radius, and ONE fill — validated at this
 * ONE ingestion boundary through the shared shape validator (`layer.ts`):
 * non-positive size, a negative or oversized radius, and a malformed colour
 * are refused here, naming the parameter and its range, before anything is
 * published. No image file is read and no image bytes are stored (DEC-001):
 * the revision's content identity is derived from the canonical parameter
 * form, and nothing is written to `content/`.
 */
export async function addShapeLayerToComposition(
  projectPath: string,
  compName: string,
  localName: string,
  input: {
    /** The geometry: rectangle (optional corner radius) or ellipse. */
    shape: LayerShapeGeometry;
    /** The geometry's size in canvas px (positive, ≤ MAX_DIMENSION). */
    width: number;
    height: number;
    /** Optional corner radius in px (rectangle only, 0..min(w,h)/2). */
    cornerRadius?: number;
    /** The ONE fill (DEC-003): a solid color here. */
    fill: LayerFill;
  },
  options: AddLayerOptions = {},
): Promise<{ composition: string; use: CompositionLayerUse; layer: ResolvedLayer }> {
  const sanitizedComp = sanitizeName(compName);
  const sanitizedLocalName = sanitizeName(localName);

  const { x, y, opacity } = parsePlacement(options);
  // Canonical shape validation at the ingestion boundary; the stored-revision
  // parser reuses the same validator. Runs BEFORE any publication, so a
  // refused parameter publishes nothing — no Layer, no use, no storage churn.
  const shape = validateShapeContent(input.shape, input.width, input.height, input.cornerRadius, input.fill);
  // The content identity IS the canonical parameter form (DEC-001): hashed
  // once here, verified by the revision reader, never stored as bytes.
  const contentHash = createHash("sha256")
    .update(shapeContentIdentity({ ...shape }))
    .digest("hex");

  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, async () => {
    const { comp, compFile } = await readMutableComposition(resolvedRoot, sanitizedComp, sanitizedLocalName);

    return publishLayerUse(resolvedRoot, comp, compFile, sanitizedLocalName, async (layerId, createdAt) => {
      // One-command application (DEC-002) runs BEFORE any staging: a refused
      // option publishes nothing. The shape's intrinsic size drives the scale
      // resolution exactly like an image's; there are no content bytes to
      // pass — the provisional paint builds the shape from its parameters.
      const revision = await applyOneCommandOptions(
        {
          schemaVersion: LAYER_SCHEMA_VERSION,
          layerId,
          createdAt,
          kind: "shape",
          contentHash,
          shape: shape.shape,
          width: shape.width,
          height: shape.height,
          ...(shape.cornerRadius !== undefined ? { cornerRadius: shape.cornerRadius } : {}),
          fill: shape.fill,
          x,
          y,
          opacity,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          flipX: false,
          flipY: false,
        },
        options.oneCommand,
        {
          composition: sanitizedComp,
          canvas: comp.canvas,
          contentBytes: Buffer.alloc(0),
          intrinsic: { width: shape.width, height: shape.height },
        },
      );
      return revision;
    }, options.position).then(({ layerId, layer }) => ({
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
      // One-command application (DEC-002) runs BEFORE any retention: a
      // refused option publishes nothing — no Layer, no use, no content.
      const revision = await applyOneCommandOptions(
        {
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
          rotationDeg: 0,
          flipX: false,
          flipY: false,
        },
        options.oneCommand,
        {
          composition: sanitizedComp,
          canvas: comp.canvas,
          contentBytes: validated.bytes,
          format: validated.format,
          intrinsic: { width: validated.width, height: validated.height },
        },
      );
      await storeContentBlob(resolvedRoot, validated.contentHash, validated.bytes);
      await retainGenerationRecord(resolvedRoot, selected.job.jobId, selected.recordBytes);
      return revision;
    }, options.position).then(({ layerId, layer }) => ({
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
      // source-copy shape/hash/size/traversal, decode, predecessor ambiguity)
      // runs before any Project write, so a refusal leaves no partial retention.
      const predecessor = await findGenerationPredecessor(
        source.generationRoot,
        selectedOutput.matte.request.source.contentHash,
      );
      // One-command application (DEC-002) runs BEFORE any retention: a
      // refused option publishes nothing — no Layer, no use, no content.
      const revision = await applyOneCommandOptions(
        {
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
          rotationDeg: 0,
          flipX: false,
          flipY: false,
        },
        options.oneCommand,
        {
          composition: sanitizedComp,
          canvas: comp.canvas,
          contentBytes: validated.bytes,
          format: validated.format,
          intrinsic: { width: validated.width, height: validated.height },
        },
      );
      await storeContentBlob(resolvedRoot, validated.contentHash, validated.bytes);
      await retainMattingRecord(resolvedRoot, selectedOutput.matte.matteId, selectedOutput.recordBytes);
      if (selectedOutput.sourceBytes) {
        await retainMattingSourceBytes(resolvedRoot, selectedOutput.matte, selectedOutput.sourceBytes);
      }
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
      return revision;
    }, options.position).then(({ layerId, layer }) => ({
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
  /** The Layer's run font bytes (#297): every distinct run font override's
   *  verified retained bytes — the @font-face inputs paint and measurement
   *  declare for run font overrides. Present only for text Layers with run
   *  font overrides. Internal projection — never serialized. */
  runFonts?: SnapshotRunFont[];
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
      ...(layer.runFonts !== undefined && layer.runFonts.length > 0 ? { runFonts: layer.runFonts } : {}),
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

/** Result of deleting a Composition (#290, ISC-3). */
export interface DeleteCompositionResult {
  composition: string;
}

/**
 * Delete a Composition (#290, ISC-3): remove the Composition document from
 * the Project under the Project lock. The unknown-name refusal comes from the
 * one Composition-name resolver (`readCompositionDocument`, #289 DEC-003) —
 * no second lookup exists here, so boundary containment and the formatted
 * missing-name listing are enforced by the same gates as every other
 * Composition command.
 *
 * Deliberately retained (ADR-0013 Project-scoped sharing and retained Render
 * history):
 * - Layers and their revisions: shared Project-owned identities; deletion of
 *   one Composition must not remove Layers other state may still reference.
 * - Retained Renders under renders/: replay paints from the manifest snapshot
 *   alone (`resolveHistoricalLayers` reads pinned Layer revisions;
 *   Composition documents are never consulted), so Renders of the deleted
 *   Composition keep replaying.
 * - Guidelines views under guidelines/: caller-facing artifacts keyed with a
 *   fresh random suffix, never read back, so nothing stale is inherited.
 *
 * No other per-Composition state exists: the Project keeps no per-Composition
 * index (compositionsCount is computed by listing), regions are caller-owned
 * files, and the Project lock is the only lock. A later `composition create`
 * of the same name therefore starts fresh with an empty use list.
 */
export async function deleteComposition(
  projectPath: string,
  compName: string,
): Promise<DeleteCompositionResult> {
  const sanitizedComp = sanitizeName(compName);
  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, async () => {
    const { compFile } = await readCompositionDocument(resolvedRoot, sanitizedComp);
    await unlink(compFile);
    return { composition: sanitizedComp };
  });
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
 * Build a destination revision document for a cross-Project copy (#86, US-005,
 * #232). The canonical revision construction for copies: immutable source
 * facts are preserved verbatim (kind, contentHash, placement, opacity,
 * transform scale, the text fields, the resolved text axes and typography,
 * and a caller font's stored facts), bound to the new destination identity
 * with a fresh createdAt, and text fields are re-validated through the one
 * shared text validator used at ingestion. The retained content bytes are
 * copied separately — no bundled face resolution and no re-reading of
 * `assets/fonts/` happens during a copy, and a caller font's original file
 * is never needed (#232, DEC-006): the retained bytes ARE the font. The
 * source snapshot comes from the canonical Layer resolver, so its transform
 * scale is already normalized (#133, ADR-0016): resize metadata survives
 * cross-Project import instead of being dropped by revision reconstruction.
 */
function buildCopiedRevision(newLayerId: string, createdAt: string, source: ResolvedLayerRevision): LayerRevision {
  if (source.kind === "text") {
    const fill = validateTextContent(source.text, source.fontSize, source.color);
    return {
      schemaVersion: LAYER_SCHEMA_VERSION,
      layerId: newLayerId,
      createdAt,
      kind: "text",
      contentHash: source.contentHash,
      text: source.text,
      fontSize: source.fontSize,
      color: canonicalizeTextFillForStorage(fill),
      ...(source.layoutRule === "natural" ? { layoutRule: "natural" } : {}),
      ...(source.weight !== undefined ? { weight: source.weight, width: source.width } : {}),
      ...(source.tracking !== undefined ? { tracking: source.tracking } : {}),
      ...(source.lineHeight !== undefined ? { lineHeight: source.lineHeight } : {}),
      ...(source.wrapWidth !== undefined ? { wrapWidth: source.wrapWidth } : {}),
      ...(source.fitWidth !== undefined ? { fitWidth: source.fitWidth, fitHeight: source.fitHeight } : {}),
      ...(source.callerFont !== undefined ? { callerFont: source.callerFont } : {}),
      // Text runs (#297): validated stored facts — boundaries and overrides
      // — copied verbatim, the same carry the other revision facts get.
      ...(source.runs !== undefined ? { runs: source.runs } : {}),
      x: source.x,
      y: source.y,
      opacity: source.opacity,
      scaleX: source.scaleX,
      scaleY: source.scaleY,
      rotationDeg: source.rotationDeg,
      flipX: source.flipX,
      flipY: source.flipY,
      // Skew and perspective (#298, ADR-0016 amendment): revision facts
      // copied verbatim — stored only when set, so an unskewed source's
      // copy keeps its exact document shape.
      ...(source.skewXDeg !== undefined && (source.skewXDeg !== 0 || source.skewYDeg !== 0)
        ? { skewXDeg: source.skewXDeg, skewYDeg: source.skewYDeg }
        : {}),
      ...(source.perspectiveTiltXDeg !== undefined &&
          (source.perspectiveTiltXDeg !== 0 || source.perspectiveTiltYDeg !== 0)
        ? { perspectiveTiltXDeg: source.perspectiveTiltXDeg, perspectiveTiltYDeg: source.perspectiveTiltYDeg }
        : {}),
      ...(source.shadow !== undefined ? { shadow: storedEffectStack(source.shadow) } : {}),
      // Blur (#299, ADR-0024 amendment): the radius copied verbatim — stored
      // only when set, so an unblurred source's copy keeps its exact shape.
      ...(source.blur !== undefined && source.blur > 0 ? { blur: source.blur } : {}),
      ...(source.outline !== undefined ? { outline: storedEffectStack(source.outline) } : {}),
      ...(source.innerShadow !== undefined ? { innerShadow: storedEffectStack(source.innerShadow) } : {}),
      ...(source.visibleRegion !== undefined ? { visibleRegion: { ...source.visibleRegion } } : {}),
    };
  }
  if (source.kind === "shape") {
    // Shape copy (#208): the parameters ARE the content — re-validated
    // through the one shared shape validator (the same rule ingestion
    // applies), then copied verbatim. No content bytes exist to copy.
    validateShapeContent(source.shape, source.width, source.height, source.cornerRadius, source.fill);
    return {
      schemaVersion: LAYER_SCHEMA_VERSION,
      layerId: newLayerId,
      createdAt,
      kind: "shape",
      contentHash: source.contentHash,
      shape: source.shape,
      width: source.width,
      height: source.height,
      ...(source.cornerRadius !== undefined ? { cornerRadius: source.cornerRadius } : {}),
      fill: { ...source.fill },
      x: source.x,
      y: source.y,
      opacity: source.opacity,
      scaleX: source.scaleX,
      scaleY: source.scaleY,
      rotationDeg: source.rotationDeg,
      flipX: source.flipX,
      flipY: source.flipY,
      // Skew and perspective (#298, ADR-0016 amendment): revision facts
      // copied verbatim — stored only when set, so an unskewed source's
      // copy keeps its exact document shape.
      ...(source.skewXDeg !== undefined && (source.skewXDeg !== 0 || source.skewYDeg !== 0)
        ? { skewXDeg: source.skewXDeg, skewYDeg: source.skewYDeg }
        : {}),
      ...(source.perspectiveTiltXDeg !== undefined &&
          (source.perspectiveTiltXDeg !== 0 || source.perspectiveTiltYDeg !== 0)
        ? { perspectiveTiltXDeg: source.perspectiveTiltXDeg, perspectiveTiltYDeg: source.perspectiveTiltYDeg }
        : {}),
      ...(source.shadow !== undefined ? { shadow: storedEffectStack(source.shadow) } : {}),
      // Blur (#299, ADR-0024 amendment): the radius copied verbatim — stored
      // only when set, so an unblurred source's copy keeps its exact shape.
      ...(source.blur !== undefined && source.blur > 0 ? { blur: source.blur } : {}),
      ...(source.outline !== undefined ? { outline: storedEffectStack(source.outline) } : {}),
      ...(source.innerShadow !== undefined ? { innerShadow: storedEffectStack(source.innerShadow) } : {}),
      ...(source.visibleRegion !== undefined ? { visibleRegion: { ...source.visibleRegion } } : {}),
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
    rotationDeg: source.rotationDeg,
    flipX: source.flipX,
    flipY: source.flipY,
    // Skew and perspective (#298, ADR-0016 amendment): revision facts
    // copied verbatim — stored only when set, so an unskewed source's
    // copy keeps its exact document shape.
    ...(source.skewXDeg !== undefined && (source.skewXDeg !== 0 || source.skewYDeg !== 0)
      ? { skewXDeg: source.skewXDeg, skewYDeg: source.skewYDeg }
      : {}),
    ...(source.perspectiveTiltXDeg !== undefined &&
        (source.perspectiveTiltXDeg !== 0 || source.perspectiveTiltYDeg !== 0)
      ? { perspectiveTiltXDeg: source.perspectiveTiltXDeg, perspectiveTiltYDeg: source.perspectiveTiltYDeg }
      : {}),
    ...(source.shadow !== undefined ? { shadow: storedEffectStack(source.shadow) } : {}),
    // Blur (#299, ADR-0024 amendment): the radius copied verbatim — stored
    // only when set, so an unblurred source's copy keeps its exact shape.
    ...(source.blur !== undefined && source.blur > 0 ? { blur: source.blur } : {}),
    ...(source.outline !== undefined ? { outline: storedEffectStack(source.outline) } : {}),
    ...(source.innerShadow !== undefined ? { innerShadow: storedEffectStack(source.innerShadow) } : {}),
    ...(source.visibleRegion !== undefined ? { visibleRegion: { ...source.visibleRegion } } : {}),
    // The vector colour (#215, DEC-002 — a revision fact shared as a whole):
    // copied verbatim with the Layer. A source revision cannot carry the
    // fact on raster content (the setter's raster gate), so no format gate
    // is needed here — the copy re-validates through the revision reader.
    ...(source.vectorColor !== undefined ? { vectorColor: source.vectorColor } : {}),
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
  position?: StackPosition,
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

  // Stack position (#230): validated against the target's use list BEFORE
  // any staging — an unknown use name refuses here, naming the target's
  // uses, and nothing is published.
  const insertIndex = position ? resolveStackPositionIndex(targetComp, position) : targetComp.layers.length;

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
  const identityMap = new Map<string, { revision: ResolvedLayerRevision; contentBytes: Buffer; runFonts?: SnapshotRunFont[] }>();
  for (const layer of sourceFull.layers) {
    if (!identityMap.has(layer.layerId)) {
      identityMap.set(layer.layerId, {
        revision: layer.revision,
        contentBytes: layer.contentBytes,
        ...(layer.runFonts !== undefined && layer.runFonts.length > 0 ? { runFonts: layer.runFonts } : {}),
      });
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
      // A shape Layer (#208, DEC-001) has no retained bytes: its content IS
      // its parameters, so there is nothing to copy into content/.
      if (snapshot.revision.kind !== "shape") {
        await storeContentBlob(destRoot, snapshot.revision.contentHash, snapshot.contentBytes);
      }
      // Run font blobs (#297, INT-paint-2): the copied revision carries the
      // runs verbatim, so every distinct run font's verified bytes copy
      // alongside the Layer's own — a cross-Project import paints from the
      // destination store alone.
      for (const runFont of snapshot.runFonts ?? []) {
        await storeContentBlob(destRoot, runFont.contentHash, runFont.bytes);
      }

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
    // The imported set stays contiguous and in source order, inserted at the
    // resolved stack position (#230).
    const updatedLayers = [...targetComp.layers];
    updatedLayers.splice(insertIndex, 0, ...importedUses);
    const updatedTarget: Composition = {
      ...targetComp,
      layers: updatedLayers,
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
  position?: StackPosition,
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
    return await copyCrossProject(destRoot, srcRoot, sanitizedTarget, sanitizedSource, position);
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
  position?: StackPosition,
): Promise<ImportCompositionResult> {
  const sanitizedTarget = sanitizeName(targetCompName);
  const sanitizedSource = sanitizeName(sourceCompName);

  if (sanitizedTarget === sanitizedSource) {
    throw new Error(`Cannot import composition "${sanitizedTarget}" into itself.`);
  }

  const resolvedRoot = await resolveProjectRoot(projectPath);
  return withProjectLock(resolvedRoot, async () => {
    const { comp: targetComp, compFile: targetCompFile } = await readMutableComposition(resolvedRoot, sanitizedTarget);

    // Stack position (#230): validated against the target's use list before
    // any commit — an unknown use name refuses here, naming the target's
    // uses, and nothing is published.
    const insertIndex = position ? resolveStackPositionIndex(targetComp, position) : targetComp.layers.length;

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

    // The imported set stays contiguous and in source order, inserted at the
    // resolved stack position (#230).
    const updatedLayers = [...targetComp.layers];
    updatedLayers.splice(insertIndex, 0, ...importedUses);
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

