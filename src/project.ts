import { isStoredTimestamp } from "./stored-schema.js";
/**
 * Project containment and lifecycle — the authoritative boundary for Compositions,
 * Layers, immutable content, and Render history (ADR-0013, DEC-001–006).
 */
import path from "node:path";
import { mkdir, readFile, writeFile, readdir, stat, lstat } from "node:fs/promises";
import { outsideDir, escapesDirReal } from "./paths.js";
import { withProjectLock } from "./project-lock.js";

export const PROJECT_MANIFEST_FILENAME = "ply.json";
export const CURRENT_SCHEMA_VERSION = 1;
export const PROJECT_SUBDIRS = ["compositions", "layers", "content", "renders"] as const;

export interface ProjectManifest {
  schemaVersion: number;
  name: string;
  createdAt: string;
}

export interface ProjectInfo {
  name: string;
  schemaVersion: number;
  path: string;
  createdAt: string;
  compositionsCount: number;
  layersCount: number;
}

/** Validate that a project name matches standard alphanumeric/hyphen/underscore naming. */
export function sanitizeProjectName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Project name cannot be empty.");
  }
  return trimmed;
}

/** Check whether a path exists. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Check whether a path is a directory. */
async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Initialize a new self-contained Project at the target path.
 * Rejects existing projects, conflicting non-empty destinations, or symlink escapes.
 */
export async function initProject(
  targetPath: string,
  options: { name?: string } = {},
): Promise<ProjectInfo> {
  const resolvedPath = path.resolve(targetPath);
  const name = sanitizeProjectName(options.name ?? path.basename(resolvedPath));

  const exists = await pathExists(resolvedPath);
  if (exists) {
    const isDir = await isDirectory(resolvedPath);
    if (!isDir) {
      throw new Error(`Cannot initialize project at "${targetPath}": path exists and is not a directory.`);
    }

    // Check if it is already a Project
    const manifestPath = path.join(resolvedPath, PROJECT_MANIFEST_FILENAME);
    if (await pathExists(manifestPath)) {
      throw new Error(`Cannot initialize project at "${targetPath}": already contains a ${PROJECT_MANIFEST_FILENAME} manifest.`);
    }

    // Check existing contents for conflicts or symlinks
    const entries = await readdir(resolvedPath);
    for (const entry of entries) {
      const entryPath = path.join(resolvedPath, entry);
      const l = await lstat(entryPath);
      if (l.isSymbolicLink()) {
        throw new Error(`Cannot initialize project at "${targetPath}": directory contains symlinked item "${entry}".`);
      }
      if ((PROJECT_SUBDIRS as readonly string[]).includes(entry)) {
        throw new Error(`Cannot initialize project at "${targetPath}": conflicting "${entry}" directory already exists.`);
      }
    }
  } else {
    await mkdir(resolvedPath, { recursive: true });
  }

  // Create project subdirectories
  for (const subdir of PROJECT_SUBDIRS) {
    const subdirPath = path.join(resolvedPath, subdir);
    if (outsideDir(resolvedPath, subdirPath)) {
      throw new Error(`Security error: subdirectory "${subdir}" escapes project boundary.`);
    }
    await mkdir(subdirPath, { recursive: true });
  }

  const manifest: ProjectManifest = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    name,
    createdAt: new Date().toISOString(),
  };

  const manifestPath = path.join(resolvedPath, PROJECT_MANIFEST_FILENAME);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return {
    name: manifest.name,
    schemaVersion: manifest.schemaVersion,
    path: resolvedPath,
    createdAt: manifest.createdAt,
    compositionsCount: 0,
    layersCount: 0,
  };
}

/**
 * Resolve and validate a Project root: the single ingestion gate for every
 * command that reads or mutates Project state. Verifies an existing directory
 * with a parseable, current `ply.json` manifest, and that every canonical
 * subdirectory stays inside the Project once symlinks are resolved.
 * Returns the resolved root path; callers pass it to the lock and readers.
 */
export async function resolveProjectRoot(projectPath: string): Promise<string> {
  const resolvedPath = path.resolve(projectPath);

  if (!(await pathExists(resolvedPath))) {
    throw new Error(`Project directory not found: "${projectPath}"`);
  }
  if (!(await isDirectory(resolvedPath))) {
    throw new Error(`Target path is not a directory: "${projectPath}"`);
  }

  await readProjectManifest(resolvedPath);
  return resolvedPath;
}

/** Complete stored Project validator, shared by selection and inspection. */
async function readProjectManifest(resolvedPath: string): Promise<ProjectManifest> {
  const manifestPath = path.join(resolvedPath, PROJECT_MANIFEST_FILENAME);
  try {
    await lstat(manifestPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    throw new Error(`Not a valid Ply project: missing ply.json in "${resolvedPath}".`);
  }
  if (await escapesDirReal(resolvedPath, manifestPath)) {
    throw new Error("Security error: project manifest escapes project boundary.");
  }
  let manifest: ProjectManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`Malformed project manifest ply.json: ${(err as Error).message}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Invalid project manifest: root must be an object.");
  }
  if (manifest.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported project schemaVersion ${manifest.schemaVersion}.`);
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    throw new Error('Invalid project manifest: missing or empty "name".');
  }
  if (!isStoredTimestamp(manifest.createdAt)) {
    throw new Error('Invalid project manifest: missing or invalid "createdAt".');
  }
  for (const subdir of PROJECT_SUBDIRS) {
    const subdirPath = path.join(resolvedPath, subdir);
    if (await escapesDirReal(resolvedPath, subdirPath)) {
      throw new Error(`Security error: project subdirectory "${subdir}" escapes project boundary.`);
    }
    if (!(await isDirectory(subdirPath))) {
      throw new Error(`Not a valid Ply project: missing "${subdir}" directory.`);
    }
  }
  // Retained generation provenance (#107): the generation/ directory is
  // created on first retention, so it is validated only when present — a
  // Project without it simply has no retained provenance.
  const generationDir = path.join(resolvedPath, "generation");
  if (await pathExists(generationDir)) {
    if (!(await isDirectory(generationDir))) {
      throw new Error('Not a valid Ply project: "generation" exists but is not a directory.');
    }
    if (await escapesDirReal(resolvedPath, generationDir)) {
      throw new Error('Security error: project subdirectory "generation" escapes project boundary.');
    }
  }
  return manifest;
}

/** Internal unlocked reader for project inspection. */
async function inspectProjectInternal(resolvedPath: string): Promise<ProjectInfo> {
  const manifest = await readProjectManifest(resolvedPath);
  // Count Compositions and Layers
  let compositionsCount = 0;
  const compDir = path.join(resolvedPath, "compositions");
  if (await isDirectory(compDir)) {
    const comps = await readdir(compDir);
    compositionsCount = comps.filter((f) => f.endsWith(".json")).length;
  }

  let layersCount = 0;
  const layerDir = path.join(resolvedPath, "layers");
  if (await isDirectory(layerDir)) {
    const layers = await readdir(layerDir);
    layersCount = layers.filter((f) => f.endsWith(".json")).length;
  }

  return {
    name: manifest.name,
    schemaVersion: manifest.schemaVersion,
    path: resolvedPath,
    createdAt: manifest.createdAt,
    compositionsCount,
    layersCount,
  };
}

/**
 * Inspect an existing Project.
 * Validates manifest integrity and reports project state under Project lock.
 */
export async function inspectProject(targetPath: string): Promise<ProjectInfo> {
  const resolvedPath = path.resolve(targetPath);

  if (!(await pathExists(resolvedPath))) {
    throw new Error(`Project directory not found: "${targetPath}"`);
  }

  if (!(await isDirectory(resolvedPath))) {
    throw new Error(`Target path is not a directory: "${targetPath}"`);
  }

  return withProjectLock(resolvedPath, () => inspectProjectInternal(resolvedPath));
}
