/**
 * Project containment and lifecycle — the authoritative boundary for Compositions,
 * Layers, immutable content, and Render history (ADR-0013, DEC-001–006).
 */
import path from "node:path";
import { mkdir, readFile, writeFile, readdir, stat, lstat } from "node:fs/promises";
import { outsideDir, escapesDirReal } from "./paths.js";

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
 * Inspect an existing Project.
 * Validates manifest integrity and reports project state.
 */
export async function inspectProject(targetPath: string): Promise<ProjectInfo> {
  const resolvedPath = path.resolve(targetPath);

  if (!(await pathExists(resolvedPath))) {
    throw new Error(`Project directory not found: "${targetPath}"`);
  }

  if (!(await isDirectory(resolvedPath))) {
    throw new Error(`Target path is not a directory: "${targetPath}"`);
  }

  const manifestPath = path.join(resolvedPath, PROJECT_MANIFEST_FILENAME);
  if (!(await pathExists(manifestPath))) {
    throw new Error(`Not a valid Ply project: missing ${PROJECT_MANIFEST_FILENAME} in "${targetPath}"`);
  }

  if (await escapesDirReal(resolvedPath, manifestPath)) {
    throw new Error(`Security error: project manifest in "${targetPath}" escapes project boundary.`);
  }

  let manifest: ProjectManifest;
  try {
    const raw = await readFile(manifestPath, "utf8");
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed project manifest in "${targetPath}": ${(err as Error).message}`);
  }

  if (typeof manifest !== "object" || manifest === null) {
    throw new Error(`Invalid project manifest in "${targetPath}": root must be an object.`);
  }

  if (typeof manifest.schemaVersion !== "number") {
    throw new Error(`Invalid project manifest in "${targetPath}": missing or invalid "schemaVersion".`);
  }

  if (manifest.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported project schemaVersion ${manifest.schemaVersion} (current supported version is ${CURRENT_SCHEMA_VERSION}).`);
  }

  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    throw new Error(`Invalid project manifest in "${targetPath}": missing or empty "name".`);
  }

  // Validate containment for all owned project subdirectories
  for (const subdir of PROJECT_SUBDIRS) {
    const subdirPath = path.join(resolvedPath, subdir);
    if (await pathExists(subdirPath)) {
      if (await escapesDirReal(resolvedPath, subdirPath)) {
        throw new Error(`Security error: project subdirectory "${subdir}" in "${targetPath}" escapes project boundary.`);
      }
      if (!(await isDirectory(subdirPath))) {
        throw new Error(`Project subdirectory "${subdir}" in "${targetPath}" is not a directory.`);
      }
    }
  }

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
    createdAt: manifest.createdAt ?? "",
    compositionsCount,
    layersCount,
  };
}
