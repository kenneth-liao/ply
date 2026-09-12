/**
 * The coherent CLI surface (#128, F12–F16, F18, ISC-20/ISC-22):
 * help succeeds everywhere, usage failures are concise actionable errors
 * with no uncaught stack traces, and ordinary results use compact text by
 * default with one valid JSON result under --json — including the retained
 * legacy Scene, Job, and library surfaces.
 *
 * Spawn-level: every claim here goes through a module's real entry point,
 * so exit codes, stream separation, and stdout purity are part of the
 * verified behavior.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-cli-surface-"));
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

interface InvokeResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function invoke(args: string[], opts?: { env?: Record<string, string>; cwd?: string }): Promise<InvokeResult> {
  const result = Bun.spawn([process.execPath, cli, ...args], {
    cwd: opts?.cwd ?? path.resolve(import.meta.dir, ".."),
    env: { ...process.env, ...opts?.env },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited,
  ]);
  return { stdout, stderr, code };
}

test("library list --json is one valid JSON result on stdout, not a crash (F13)", async () => {
  const res = await invoke(["library", "list", "--json"], {
    env: { PLY_LIBRARY_ROOT: path.join(tempDir, "assets") },
  });
  expect(res.code).toBe(0);
  const parsed = JSON.parse(res.stdout);
  expect(parsed.ok).toBe(true);
  for (const kind of ["logos", "plates", "cutouts", "objects", "masks"]) {
    expect(parsed[kind]).toBeArray();
  }
  expect(res.stderr).toBe("");
});

test("library list text mode stays compact with an Objects section, --json mirrors it", async () => {
  const libDir = path.join(tempDir, "assets", "logos", "probe-logo");
  await Bun.write(path.join(libDir, "logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"/>`);
  await Bun.write(
    path.join(libDir, "meta.json"),
    JSON.stringify({ kind: "logo", id: "probe-logo", name: "Probe", tags: ["test"] }),
  );
  const text = await invoke(["library", "list"], { env: { PLY_LIBRARY_ROOT: path.join(tempDir, "assets") } });
  expect(text.code).toBe(0);
  expect(text.stdout).toContain("Logos (1)");
  expect(text.stdout).toContain("probe-logo");
  // Retained objects stay listable — the listing and the JSON agree (spec #102).
  expect(text.stdout).toContain("Objects (0)");
  const json = await invoke(["library", "list", "--json"], { env: { PLY_LIBRARY_ROOT: path.join(tempDir, "assets") } });
  expect(json.code).toBe(0);
  expect(JSON.parse(json.stdout).logos[0]).toMatchObject({ id: "probe-logo", tags: ["test"] });
});

test("library argument failures are usage errors — exit 2, concise, no stack trace (F13, F18)", async () => {
  const env = { PLY_LIBRARY_ROOT: path.join(tempDir, "assets") };
  for (const args of [
    ["library", "badcommand"],
    ["library", "list", "--nope"],
    ["library", "add-cutout", "x.png", "--id", "probe", "--approval", "approved"],
  ]) {
    const res = await invoke(args, { env });
    expect(res.code).toBe(2);
    expect(res.stderr).not.toContain("TypeError");
    expect(res.stderr).not.toContain("throw");
    expect(res.stderr).toContain("ply library --help");
    expect(res.stderr.length).toBeLessThan(600);
  }
  // The same failures in JSON mode are one valid structured result on stdout.
  const jsonFail = await invoke(["library", "badcommand", "--json"], { env });
  expect(jsonFail.code).toBe(2);
  expect(JSON.parse(jsonFail.stdout).ok).toBe(false);
  expect(jsonFail.stderr).toBe("");
});

test("scene and jobs --help succeed with focused text; --help --json is valid JSON (F12)", async () => {
  for (const module of ["scene", "jobs"]) {
    const help = await invoke([module, "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(`ply ${module}`);
    // Focused: commands and options, not the operational manual (F16).
    expect(help.stdout.length).toBeLessThan(4000);
    const asJson = await invoke([module, "--help", "--json"]);
    expect(asJson.code).toBe(0);
    const parsed = JSON.parse(asJson.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.help).toContain(`ply ${module}`);
    expect((await invoke([module, "-h"])).code).toBe(0);
  }
});

test("scene usage failures are concise, exit 2, no embedded manual (F12, F16)", async () => {
  const bad = await invoke(["scene", "badcommand"]);
  expect(bad.code).toBe(2);
  expect(bad.stderr).toContain("unknown command");
  expect(bad.stderr).toContain('ply scene --help');
  expect(bad.stderr.length).toBeLessThan(600);
  const jsonBad = await invoke(["scene", "badcommand", "--json"]);
  expect(jsonBad.code).toBe(2);
  const parsed = JSON.parse(jsonBad.stdout);
  expect(parsed.ok).toBe(false);
  expect(parsed.errors[0].message).not.toContain("Safe areas");
  // --json is accepted alongside valid commands (scene dispatch never sees it).
  expect((await invoke(["scene", "schema", "--json"])).code).toBe(0);
});

test("scene results are compact text by default and one valid JSON under --json (ISC-20)", async () => {
  // Reference data: text is human-sized, --json is the strict machine form.
  const themesText = await invoke(["scene", "themes"]);
  expect(themesText.code).toBe(0);
  expect(themesText.stdout).toContain("Themes (");
  expect(themesText.stdout).not.toMatch(/^\{/);
  const themesJson = await invoke(["scene", "themes", "--json"]);
  expect(themesText.stdout).toContain(JSON.parse(themesJson.stdout).themes[0].name);
  const schemaText = await invoke(["scene", "schema"]);
  expect(schemaText.code).toBe(0);
  expect(schemaText.stdout).toContain("--json");
  expect(schemaText.stdout.length).toBeLessThan(400);
  // A minimal offline Scene validates and inspects in both modes.
  const sceneFile = path.join(tempDir, "probe.scene.json");
  await Bun.write(
    sceneFile,
    JSON.stringify({
      schemaVersion: 1,
      canvas: { width: 1280, height: 720 },
      layers: [
        {
          id: "headline",
          type: "text",
          text: "Probe",
          position: { x: 100, y: 50 },
          size: { width: 400, height: 100 },
          font: "Anton",
          fontSize: 48,
        },
      ],
    }),
  );
  const validText = await invoke(["scene", "validate", sceneFile]);
  expect(validText.code).toBe(0);
  expect(validText.stdout).toContain("Scene valid");
  const validJson = await invoke(["scene", "validate", sceneFile, "--json"]);
  expect(JSON.parse(validJson.stdout).ok).toBe(true);
  const inspectText = await invoke(["scene", "inspect", sceneFile]);
  expect(inspectText.code).toBe(0);
  expect(inspectText.stdout).toContain("headline");
  // An invalid scene is an operational failure: exit 1, text on stderr,
  // one structured JSON result on stdout under --json.
  const badFile = path.join(tempDir, "bad.scene.json");
  await Bun.write(badFile, JSON.stringify({ schemaVersion: 99, canvas: {}, layers: [] }));
  const badText = await invoke(["scene", "validate", badFile]);
  expect(badText.code).toBe(1);
  expect(badText.stdout).toBe("");
  expect(badText.stderr).not.toBe("");
  const badJson = await invoke(["scene", "validate", badFile, "--json"]);
  expect(badJson.code).toBe(1);
  expect(JSON.parse(badJson.stdout).ok).toBe(false);
  expect(badJson.stderr).toBe("");
});

test("jobs results are compact text by default and one valid JSON under --json (ISC-20)", async () => {
  const listText = await invoke(["jobs", "list"], { cwd: tempDir });
  expect(listText.code).toBe(0);
  expect(listText.stdout).toContain("No recorded jobs");
  const listJson = await invoke(["jobs", "list", "--json"], { cwd: tempDir });
  expect(JSON.parse(listJson.stdout).ok).toBe(true);
  // A missing record is an operational failure: exit 1 in both presentations.
  const showText = await invoke(["jobs", "show", "missing-job"], { cwd: tempDir });
  expect(showText.code).toBe(1);
  expect(showText.stderr).toContain("missing-job");
  const showJson = await invoke(["jobs", "show", "missing-job", "--json"], { cwd: tempDir });
  expect(showJson.code).toBe(1);
  expect(JSON.parse(showJson.stdout).ok).toBe(false);
});

test("root --help --json is valid JSON; unknown module in JSON mode is structured (ISC-20)", async () => {
  expect((await invoke(["-h"])).code).toBe(0);
  const helpJson = await invoke(["--help", "--json"]);
  expect(helpJson.code).toBe(0);
  const parsed = JSON.parse(helpJson.stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.help).toContain("Ply");
  const unknown = await invoke(["not-a-module", "--json"]);
  expect(unknown.code).toBe(2);
  expect(JSON.parse(unknown.stdout).ok).toBe(false);
  expect(unknown.stderr).toBe("");
});

test("library add-logo and resolve support --json; operational failures stay exit 1", async () => {
  const env = { PLY_LIBRARY_ROOT: path.join(tempDir, "assets") };
  const logo = path.join(tempDir, "probe.svg");
  await Bun.write(logo, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"/>`);
  const add = await invoke(["library", "add-logo", logo, "--id", "probe-logo", "--json"], { env });
  expect(add.code).toBe(0);
  const added = JSON.parse(add.stdout);
  expect(added.ok).toBe(true);
  expect(added.path).toContain("probe-logo");
  const resolve = await invoke(["library", "resolve", "probe-logo", "--json"], { env });
  expect(resolve.code).toBe(0);
  const resolved = JSON.parse(resolve.stdout);
  expect(resolved.ok).toBe(true);
  expect(resolved.scope).toBe("library");
  // An unknown ref is operational, not a usage error: exit 1, structured in JSON.
  const missing = await invoke(["library", "resolve", "no-such-asset", "--json"], { env });
  expect(missing.code).toBe(1);
  expect(JSON.parse(missing.stdout).ok).toBe(false);
});