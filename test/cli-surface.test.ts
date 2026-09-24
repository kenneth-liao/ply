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
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePngRgba } from "../src/png.js";

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
    expect(res.stderr.length).toBeLessThan(400);
  }
  // The same failures in JSON mode are one valid structured result on stdout.
  const jsonFail = await invoke(["library", "badcommand", "--json"], { env });
  expect(jsonFail.code).toBe(2);
  expect(JSON.parse(jsonFail.stdout).ok).toBe(false);
  expect(jsonFail.stderr).toBe("");
  // generate's usage errors are concise too — never the embedded manual.
  const genUsage = await invoke(["generate", "--bogus"]);
  expect(genUsage.code).toBe(2);
  expect(genUsage.stderr).toContain('ply generate --help');
  expect(genUsage.stderr.length).toBeLessThan(400);
  // The same actionable message (correction + pointer) in the JSON result.
  const genUsageJson = await invoke(["generate", "--bogus", "--json"]);
  expect(genUsageJson.code).toBe(2);
  expect(JSON.parse(genUsageJson.stdout).error).toContain("ply generate --help");
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
  expect(bad.stderr.length).toBeLessThan(400);
  const jsonBad = await invoke(["scene", "badcommand", "--json"]);
  expect(jsonBad.code).toBe(2);
  const parsed = JSON.parse(jsonBad.stdout);
  expect(parsed.ok).toBe(false);
  expect(parsed.errors[0].message).not.toContain("Safe areas");
  // --json is accepted alongside valid commands (scene dispatch never sees it).
  expect((await invoke(["scene", "schema", "--json"])).code).toBe(0);
  // An unrecognized option in the file position is a usage error (exit 2),
  // never a failed file read dressed up as an operational failure (SPEC-1).
  const optionLike = await invoke(["scene", "render", "--bogus"]);
  expect(optionLike.code).toBe(2);
  expect(optionLike.stderr).toContain('ply scene --help');
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

test("add and layer edit help name the same Layer kinds for the resize forms (#234 review INT-1)", async () => {
  // DEC-001: the kind phrases have one home (layer-options.ts), so the two
  // help surfaces cannot drift — shape Layers accept --resize-to and --scale.
  const { RESIZE_TO_HELP_KINDS, SCALE_HELP_KINDS } = await import("../src/layer-options.js");
  const squash = (s: string) => s.replace(/\s+/g, " ");
  for (const module of ["composition", "layer"]) {
    const help = await invoke([module, "--help"]);
    expect(help.code).toBe(0);
    const text = squash(help.stdout);
    expect(text).toContain(`(${RESIZE_TO_HELP_KINDS} —`);
    expect(text).toContain(`Works on ${SCALE_HELP_KINDS}`);
    expect(text).not.toContain("(image Layers only");
  }
});

/**
 * Test-only arg builders for the unknown-Composition seam (review INT-1):
 * the production table keeps only the `takesExistingComposition` fact, so
 * the per-command invocation shapes (fixture paths, dummy layer names) live
 * here. The exact-set assertions below fail when a builder is missing or
 * extra relative to the table, so no command can silently opt out (INT-2).
 */
const MISSING_COMPOSITION_ARGS: Record<string, (missing: string, ctx: {
  project: string;
  imageFile: string;
  regionFile: string;
  existingComp: string;
}) => string[]> = {
  add: (missing, ctx) => [
    "composition", "add", missing, "layer1", "--image", ctx.imageFile, "--project", ctx.project,
  ],
  import: (missing, ctx) => [
    "composition", "import", missing, ctx.existingComp, "--project", ctx.project,
  ],
  remove: (missing, ctx) => [
    "composition", "remove", missing, "layer1", "--project", ctx.project,
  ],
  reorder: (missing, ctx) => [
    "composition", "reorder", missing, "--order", "layer1", "--project", ctx.project,
  ],
  inspect: (missing, ctx) => [
    "composition", "inspect", missing, "--project", ctx.project,
  ],
  measure: (missing, ctx) => [
    "composition", "measure", missing, "--project", ctx.project,
  ],
  check: (missing, ctx) => [
    "composition", "check", missing, "--regions", ctx.regionFile, "--project", ctx.project,
  ],
  guidelines: (missing, ctx) => [
    "composition", "guidelines", missing, "--regions", ctx.regionFile, "--project", ctx.project,
  ],
  sheet: (missing, ctx) => [
    "composition", "sheet", missing, "--project", ctx.project,
  ],
  render: (missing, ctx) => [
    "composition", "render", missing, "--project", ctx.project,
  ],
};

test("all Composition commands taking a composition name refuse unknown names with existing names and no raw ENOENT (TEST-006, DEC-003)", async () => {
  const { COMPOSITION_COMMANDS, HELP } = await import("../src/composition-cli.js");

  // INT-2: the table's key set must equal the CLI's published command set —
  // the `ply composition <command>` usage lines in HELP. A new dispatched
  // command missing from the table, or a stale table entry HELP doesn't
  // document, fails here; the flag must be set consciously.
  const helpCommands = [
    ...new Set([...HELP.matchAll(/^\s*ply composition ([a-z-]+)/gm)].map((m) => m[1]!)),
  ].sort();
  expect(Object.keys(COMPOSITION_COMMANDS).sort()).toEqual(helpCommands);

  // INT-2: the builders must cover exactly the commands the table flags as
  // taking an existing Composition — missing or extra builders fail, so the
  // enumeration cannot be silently narrowed by a wrong flag.
  const flaggedCommands = Object.entries(COMPOSITION_COMMANDS)
    .filter(([, meta]) => meta.takesExistingComposition)
    .map(([name]) => name)
    .sort();
  expect(Object.keys(MISSING_COMPOSITION_ARGS).sort()).toEqual(flaggedCommands);

  const projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "test-proj"]);
  await invoke(["composition", "create", "alpha", "--width", "200", "--height", "100", "--project", projDir]);
  await invoke(["composition", "create", "beta", "--width", "300", "--height", "150", "--project", projDir]);

  const imgPath = path.join(tempDir, "dummy.png");
  const redPng = encodePngRgba(10, 10, Buffer.alloc(10 * 10 * 4, 255));
  await writeFile(imgPath, redPng);

  const regionPath = path.join(tempDir, "regions.json");
  await writeFile(
    regionPath,
    JSON.stringify({
      schemaVersion: 1,
      canvas: { width: 200, height: 100 },
      regions: [{ id: "r1", label: "R1", reason: "test", "box": { x: 0, y: 0, width: 50, height: 50 } }],
    }),
  );

  const ctx = {
    project: projDir,
    imageFile: imgPath,
    regionFile: regionPath,
    existingComp: "alpha",
  };

  const missingComp = "non-existent-comp";

  for (const cmd of flaggedCommands) {
    const args = MISSING_COMPOSITION_ARGS[cmd]!(missingComp, ctx);

    // Text presentation: nonzero exit, missing name, existing names, no raw ENOENT
    const resText = await invoke(args);
    expect(resText.code).not.toBe(0);
    const combinedText = `${resText.stdout}\n${resText.stderr}`;
    expect(combinedText).toContain(missingComp);
    expect(combinedText).toContain("alpha");
    expect(combinedText).toContain("beta");
    expect(combinedText).not.toContain("ENOENT");

    // JSON presentation: one valid structured JSON result with ok: false, no raw ENOENT
    const resJson = await invoke([...args, "--json"]);
    expect(resJson.code).not.toBe(0);
    expect(resJson.stderr).toBe("");
    const parsed = JSON.parse(resJson.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain(missingComp);
    expect(parsed.error).toContain("alpha");
    expect(parsed.error).toContain("beta");
    expect(parsed.error).not.toContain("ENOENT");
  }
});

test("Composition commands report no Compositions exist in an empty project without raw ENOENT (DEC-003)", async () => {
  const projDir = path.join(tempDir, "empty-proj");
  await invoke(["project", "init", projDir, "--name", "empty-proj"]);

  const res = await invoke(["composition", "inspect", "missing-comp", "--project", projDir, "--json"]);
  expect(res.code).toBe(1);
  const parsed = JSON.parse(res.stdout);
  expect(parsed.ok).toBe(false);
  expect(parsed.error).toContain("No Compositions exist in this Project yet");
  expect(parsed.error).not.toContain("ENOENT");
});

test("Composition commands reject names escaping project boundary whether or not target exists (DEC-003)", async () => {
  const projDir = path.join(tempDir, "sec-proj");
  await invoke(["project", "init", projDir, "--name", "sec-proj"]);
  await invoke(["composition", "create", "base", "--width", "100", "--height", "100", "--project", projDir]);

  // 1. Lexical escape when target does NOT exist. At the CLI seam the name
  // sanitizer refuses first (invalid characters); the reader's own lexical
  // gate is unit-tested directly in test/composition.test.ts (#289).
  const resLexNonexistent = await invoke([
    "composition", "inspect", "../../non-existent-file", "--project", projDir, "--json",
  ]);
  expect(resLexNonexistent.code).not.toBe(0);
  const parsedLex = JSON.parse(resLexNonexistent.stdout);
  expect(parsedLex.ok).toBe(false);
  expect(parsedLex.error).toContain("invalid characters");
  expect(parsedLex.error).not.toContain("ENOENT");

  // 2. Lexical escape when target exists outside project — same sanitizer
  // refusal, whether or not the target exists (#289).
  const outsideFile = path.join(tempDir, "outside.json");
  await writeFile(outsideFile, JSON.stringify({ schemaVersion: 1, name: "outside", canvas: { width: 100, height: 100 }, layers: [] }));
  const resLexExist = await invoke([
    "composition", "inspect", "../../outside", "--project", projDir, "--json",
  ]);
  expect(resLexExist.code).not.toBe(0);
  const parsedLexExist = JSON.parse(resLexExist.stdout);
  expect(parsedLexExist.ok).toBe(false);
  expect(parsedLexExist.error).toContain("invalid characters");
  expect(parsedLexExist.error).not.toContain("ENOENT");

  // 3. Symlink inside compositions escaping root when target exists
  const extCompDir = path.join(tempDir, "ext-dir");
  await mkdir(extCompDir, { recursive: true });
  await writeFile(path.join(extCompDir, "ext.json"), JSON.stringify({ schemaVersion: 1, name: "ext", canvas: { width: 100, height: 100 }, layers: [] }));
  await symlink(path.join(extCompDir, "ext.json"), path.join(projDir, "compositions", "esc-symlink.json"));

  const resSym = await invoke(["composition", "inspect", "esc-symlink", "--project", projDir, "--json"]);
  expect(resSym.code).not.toBe(0);
  const parsedSym = JSON.parse(resSym.stdout);
  expect(parsedSym.ok).toBe(false);
  expect(parsedSym.error).toContain("escapes project boundary");

  // 4. Dangling symlink inside compositions escaping root when target does NOT exist
  await symlink(path.join(extCompDir, "nonexistent.json"), path.join(projDir, "compositions", "dangling-symlink.json"));

  const resDangling = await invoke(["composition", "inspect", "dangling-symlink", "--project", projDir, "--json"]);
  expect(resDangling.code).not.toBe(0);
  const parsedDangling = JSON.parse(resDangling.stdout);
  expect(parsedDangling.ok).toBe(false);
  expect(parsedDangling.error).toContain("escapes project boundary");
  expect(parsedDangling.error).not.toContain("ENOENT");
});
