import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, rename, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

async function invoke(args: string[], cwd?: string) {
  const result = Bun.spawn([process.execPath, cli, ...args], {
    cwd: cwd ?? path.resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
    result.exited,
  ]);
  return { stdout, stderr, code };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-project-test-"));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ply project init creates a self-contained project and inspect reads it", async () => {
  const projectDir = path.join(tempDir, "my-project");
  const initResult = await invoke(["project", "init", projectDir, "--name", "my-project", "--json"]);
  expect(initResult.code).toBe(0);
  const initJson = JSON.parse(initResult.stdout);
  expect(initJson.ok).toBe(true);
  expect(initJson.project.name).toBe("my-project");
  expect(initJson.project.schemaVersion).toBe(1);

  // Inspect with explicit --project flag
  const inspectResult = await invoke(["project", "inspect", "--project", projectDir, "--json"]);
  expect(inspectResult.code).toBe(0);
  const inspectJson = JSON.parse(inspectResult.stdout);
  expect(inspectJson.ok).toBe(true);
  expect(inspectJson.project.name).toBe("my-project");
  expect(inspectJson.project.schemaVersion).toBe(1);
  expect(inspectJson.project.compositionsCount).toBe(0);
  expect(inspectJson.project.layersCount).toBe(0);

  // Inspect with default text output
  const textResult = await invoke(["project", "inspect", "--project", projectDir]);
  expect(textResult.code).toBe(0);
  expect(textResult.stdout).toContain("my-project");
  expect(textResult.stdout).toContain("schema v1");
});

test("a project contains no absolute paths and can be relocated seamlessly", async () => {
  const origDir = path.join(tempDir, "orig-project");
  const initResult = await invoke(["project", "init", origDir, "--name", "relocatable-proj", "--json"]);
  expect(initResult.code).toBe(0);

  // Check manifest contains no absolute paths
  const rawManifest = await readFile(path.join(origDir, "ply.json"), "utf8");
  expect(rawManifest).not.toContain(tempDir);
  expect(rawManifest).not.toContain(origDir);
  const parsedManifest = JSON.parse(rawManifest);
  expect(parsedManifest.name).toBe("relocatable-proj");
  expect(parsedManifest.schemaVersion).toBe(1);

  // Move project to a new location
  const movedDir = path.join(tempDir, "moved-project");
  await rename(origDir, movedDir);

  // Inspecting at the new location succeeds with explicit --project
  const inspectResult = await invoke(["project", "inspect", "--project", movedDir, "--json"]);
  expect(inspectResult.code).toBe(0);
  const inspectJson = JSON.parse(inspectResult.stdout);
  expect(inspectJson.ok).toBe(true);
  expect(inspectJson.project.name).toBe("relocatable-proj");
  expect(inspectJson.project.path).toBe(movedDir);
});

test("project inspection rejects missing, non-directory, or uninitialized locations with actionable errors", async () => {
  // Non-existent path
  const nonExistent = path.join(tempDir, "does-not-exist");
  const res1 = await invoke(["project", "inspect", "--project", nonExistent, "--json"]);
  expect(res1.code).toBe(1);
  const json1 = JSON.parse(res1.stdout);
  expect(json1.ok).toBe(false);
  expect(json1.error).toContain("not found");

  // Path is a file, not directory
  const filePath = path.join(tempDir, "some-file.txt");
  await writeFile(filePath, "hello");
  const res2 = await invoke(["project", "inspect", "--project", filePath, "--json"]);
  expect(res2.code).toBe(1);
  const json2 = JSON.parse(res2.stdout);
  expect(json2.ok).toBe(false);
  expect(json2.error).toContain("not a directory");

  // Uninitialized directory (no ply.json)
  const emptyDir = path.join(tempDir, "empty-dir");
  await mkdir(emptyDir);
  const res3 = await invoke(["project", "inspect", "--project", emptyDir, "--json"]);
  expect(res3.code).toBe(1);
  const json3 = JSON.parse(res3.stdout);
  expect(json3.ok).toBe(false);
  expect(json3.error).toContain("missing ply.json");
});

test("project inspection rejects malformed or incompatible manifests", async () => {
  const projDir = path.join(tempDir, "corrupted-project");
  await mkdir(projDir);

  // Invalid JSON
  await writeFile(path.join(projDir, "ply.json"), "invalid json content {{{");
  const res1 = await invoke(["project", "inspect", "--project", projDir, "--json"]);
  expect(res1.code).toBe(1);
  expect(JSON.parse(res1.stdout).ok).toBe(false);
  expect(JSON.parse(res1.stdout).error).toContain("Malformed");

  // Unsupported schemaVersion
  await writeFile(path.join(projDir, "ply.json"), JSON.stringify({ schemaVersion: 99, name: "future" }));
  const res2 = await invoke(["project", "inspect", "--project", projDir, "--json"]);
  expect(res2.code).toBe(1);
  expect(JSON.parse(res2.stdout).ok).toBe(false);
  expect(JSON.parse(res2.stdout).error).toContain("Unsupported project schemaVersion 99");

  // Missing name
  await writeFile(path.join(projDir, "ply.json"), JSON.stringify({ schemaVersion: 1, name: "" }));
  const res3 = await invoke(["project", "inspect", "--project", projDir, "--json"]);
  expect(res3.code).toBe(1);
  expect(JSON.parse(res3.stdout).ok).toBe(false);
  expect(JSON.parse(res3.stdout).error).toContain("missing or empty \"name\"");
});

test("project initialization rejects existing projects and conflicting/symlinked destinations safely", async () => {
  const projDir = path.join(tempDir, "target-dir");
  await mkdir(projDir);

  // 1. Existing project in place
  await writeFile(path.join(projDir, "ply.json"), JSON.stringify({ schemaVersion: 1, name: "existing" }));
  const res1 = await invoke(["project", "init", projDir, "--json"]);
  expect(res1.code).toBe(1);
  expect(JSON.parse(res1.stdout).ok).toBe(false);
  expect(JSON.parse(res1.stdout).error).toContain("already contains a ply.json manifest");

  // 2. Conflicting directory in destination
  const conflictDir = path.join(tempDir, "conflict-dir");
  await mkdir(conflictDir);
  await mkdir(path.join(conflictDir, "compositions"));
  const res2 = await invoke(["project", "init", conflictDir, "--json"]);
  expect(res2.code).toBe(1);
  expect(JSON.parse(res2.stdout).ok).toBe(false);
  expect(JSON.parse(res2.stdout).error).toContain("conflicting \"compositions\" directory already exists");

  // 3. Symlink inside destination
  const symlinkDir = path.join(tempDir, "symlink-dir");
  await mkdir(symlinkDir);
  await symlink(tempDir, path.join(symlinkDir, "link-to-parent"));
  const res3 = await invoke(["project", "init", symlinkDir, "--json"]);
  expect(res3.code).toBe(1);
  expect(JSON.parse(res3.stdout).ok).toBe(false);
  expect(JSON.parse(res3.stdout).error).toContain("contains symlinked item");
});

test("project CLI handles invalid command and help gracefully", async () => {
  const resHelp = await invoke(["project", "--help"]);
  expect(resHelp.code).toBe(0);
  expect(resHelp.stdout).toContain("project — self-contained Project management");

  const resUnknown = await invoke(["project", "unknown-cmd", "--json"]);
  expect(resUnknown.code).toBe(2);
  expect(JSON.parse(resUnknown.stdout).ok).toBe(false);
});
