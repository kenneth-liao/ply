/**
 * Project-level locking and atomic filesystem operations.
 *
 * Provides serialized access to a Project's state during mutations and
 * reader consistency during inspection.
 */
import { open as fsOpen, readFile, stat, unlink, writeFile, rename, link } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { escapesDirReal } from "./paths.js";

export const PROJECT_LOCK_FILENAME = ".ply.lock";
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
export const LOCK_POLL_INTERVAL_MS = 50;

export interface ProjectLock {
  token: string;
  release: () => Promise<void>;
}

export interface LockFilePayload {
  pid: number;
  token: string;
  createdAt: string;
}

/** Check whether a process PID is currently alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM"; // EPERM means process exists but we lack permission to signal it
  }
}

/**
 * Acquire the Project's transaction lock (.ply.lock in the project root).
 * Rejects stale locks if holding process has died, or after bounded timeout.
 */
export async function acquireProjectLock(
  projectPath: string,
  opts?: { timeoutMs?: number },
): Promise<ProjectLock> {
  const lockPath = path.join(path.resolve(projectPath), PROJECT_LOCK_FILENAME);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const token = crypto.randomUUID();

  for (;;) {
    let fh: FileHandle | undefined;
    try {
      fh = await fsOpen(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }

      try {
        if (await escapesDirReal(projectPath, lockPath)) {
          throw new Error("Security error: Project lock escapes project boundary.");
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }

      // Read existing lock payload to check holder PID
      let stale = false;
      let holderPid: number | undefined;
      try {
        const raw = await readFile(lockPath, "utf8");
        const parsed = JSON.parse(raw) as LockFilePayload;
        holderPid = parsed.pid;
        if (typeof holderPid === "number" && !isPidAlive(holderPid)) {
          stale = true;
        }
      } catch {
        // Lock might be in the middle of being written or invalid
      }

      if (stale) {
        throw new Error(
          `Project lock at "${lockPath}" is held by a dead process (PID ${holderPid}). ` +
            `Remove the stale lock file manually (operator cleanup) and retry.`,
        );
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for Project lock at "${lockPath}". ` +
            (holderPid !== undefined ? `Lock is currently held by PID ${holderPid}. ` : "") +
            `If the process crashed, remove the lock file manually and retry.`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
      continue;
    }

    const payload: LockFilePayload = {
      pid: process.pid,
      token,
      createdAt: new Date().toISOString(),
    };
    await fh.write(JSON.stringify(payload) + "\n");
    const held = await fh.stat();

    let released = false;
    return {
      token,
      release: async () => {
        if (released) return;
        released = true;
        try {
          const current = await stat(lockPath);
          if (current.ino !== held.ino || current.dev !== held.dev) {
            return;
          }
          if (await escapesDirReal(projectPath, lockPath)) return;
          const content = await readFile(lockPath, "utf8").catch(() => undefined);
          if (!content || !content.includes(token)) {
            return;
          }
          await unlink(lockPath);
        } catch {
          // Lock already removed or unlinked
        } finally {
          await fh?.close().catch(() => {});
        }
      },
    };
  }
}

/** Execute an asynchronous operation while holding the exclusive Project lock. */
export async function withProjectLock<T>(
  projectPath: string,
  fn: () => Promise<T>,
  opts?: { timeoutMs?: number },
): Promise<T> {
  const lock = await acquireProjectLock(projectPath, opts);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/**
 * Replace an existing file atomically via temp write and rename.
 */
export async function atomicReplace(file: string, content: string | Buffer): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    await writeFile(tmp, content);
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Create a brand-new file atomically via temp write and hard link (fails if destination already exists).
 */
export async function atomicCreate(file: string, content: string | Buffer): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    await writeFile(tmp, content);
    await link(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await unlink(tmp).catch(() => {});
}
