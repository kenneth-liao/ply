/**
 * Numeric placement arguments accept both syntaxes everywhere coordinates
 * are supported (#128, F4/F18): separate dash-leading values (`--x -40`)
 * and equals-form values (`--x=-40`) produce equivalent placement, for
 * negative integers and fractions. A following option is never consumed as
 * a number, missing/invalid values are concise usage errors (exit 2, no
 * stack trace), and Layer effects keep their existing negative-value
 * support. Equivalence is asserted against real placement in a real
 * Project, not just argument parsing.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePngRgba } from "../src/png.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-coord-args-"));
  projDir = path.join(tempDir, "proj");
  await spawn(["project", "init", projDir]);
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

interface Result {
  stdout: string;
  stderr: string;
  code: number;
}

async function spawn(args: string[]): Promise<Result> {
  const proc = Bun.spawn([process.execPath, cli, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, code };
}

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgba[0]; buf[i + 1] = rgba[1]; buf[i + 2] = rgba[2]; buf[i + 3] = rgba[3];
  }
  return encodePngRgba(width, height, buf);
}

const RED: [number, number, number, number] = [255, 0, 0, 255];

/** One image Layer in one Composition — a single-referrer placement edit target. */
async function addImageLayer(localName: string, opts: { x?: string; y?: string } = {}): Promise<string> {
  const img = path.join(tempDir, `${localName}.png`);
  await writeFile(img, solidPng(40, 40, RED));
  const args = ["composition", "add", "board", localName, "--image", img, "--project", projDir, "--json"];
  if (opts.x !== undefined) args.push("--x", opts.x);
  if (opts.y !== undefined) args.push("--y", opts.y);
  const res = await spawn(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).layer.id as string;
}

async function placement(layerId: string): Promise<{ x: number; y: number }> {
  const res = await spawn(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const current = JSON.parse(res.stdout).layer.currentRevision;
  return { x: current.x, y: current.y };
}

async function editPlacement(layerId: string, placementArgs: string[]): Promise<Result> {
  return spawn(["layer", "edit", layerId, ...placementArgs, "--project", projDir, "--json"]);
}

test("layer edit accepts --y -40 and --y=-40 equivalently, including fractions", async () => {
  await spawn(["composition", "create", "board", "--width", "1280", "--height", "720", "--project", projDir]);
  const dash = await addImageLayer("dash");
  const equals = await addImageLayer("equals");
  for (const [a, b] of [
    [["--y", "-40"], ["--y=-40"]],
    [["--x", "-40"], ["--x=-40"]],
    [["--x", "-40.5", "--y", "-.5"], ["--x=-40.5", "--y=-.5"]],
  ] as [string[], string[]][]) {
    const viaDash = await editPlacement(dash, a);
    const viaEquals = await editPlacement(equals, b);
    expect(viaDash.code).toBe(0);
    expect(viaEquals.code).toBe(0);
    const p1 = await placement(dash);
    const p2 = await placement(equals);
    expect(p1).toEqual(p2);
    expect(p1.x < 0 || p1.y < 0).toBe(true);
    // Rebase: move the equals twin onto the dash twin's placement for the next pair.
    const restore = await editPlacement(equals, ["--x", String(p1.x), "--y", String(p1.y)]);
    expect(restore.code).toBe(0);
  }
});

test("a following option is never consumed as a number; missing/invalid values are usage errors", async () => {
  await spawn(["composition", "create", "board", "--width", "1280", "--height", "720", "--project", projDir]);
  const layer = await addImageLayer("probe", { x: "-40", y: "-40" });
  // The option after a dash-leading numeric value still reaches the parser:
  // --json switches presentation while the placement stays exactly -40.
  const withJson = await editPlacement(layer, ["--y", "-40", "--json"]);
  expect(withJson.code).toBe(0);
  expect(JSON.parse(withJson.stdout).layer.currentRevision.y).toBe(-40);
  expect(withJson.stderr).toBe("");
  // Missing value: a concise usage error, no stack trace, pointing at help
  // (text mode: the correction on stderr; JSON mode: one structured result).
  const missing = await spawn(["layer", "edit", layer, "--x", "--project", projDir]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain("ply layer --help");
  expect(missing.stderr).not.toContain("TypeError");
  const missingJson = await spawn(["layer", "edit", layer, "--x", "--project", projDir, "--json"]);
  expect(missingJson.code).toBe(2);
  expect(JSON.parse(missingJson.stdout).ok).toBe(false);
  expect(missingJson.stderr).toBe("");
  // An invalid value is refused cleanly.
  const invalid = await editPlacement(layer, ["--x", "abc"]);
  expect(invalid.code).toBe(2);
  expect(invalid.stderr).not.toContain("TypeError");
});

test("composition add places dash-leading and equals-form coordinates identically", async () => {
  await spawn(["composition", "create", "board", "--width", "1280", "--height", "720", "--project", projDir]);
  const img = path.join(tempDir, "img.png");
  await writeFile(img, solidPng(40, 40, RED));
  const dash = await spawn(["composition", "add", "board", "dash", "--image", img, "--x", "-40", "--y", "-40.5", "--project", projDir, "--json"]);
  expect(dash.code).toBe(0);
  const equals = await spawn(["composition", "add", "board", "equals", "--image", img, "--x=-40", "--y=-40.5", "--project", projDir, "--json"]);
  expect(equals.code).toBe(0);
  const inspect = await spawn(["composition", "inspect", "board", "--project", projDir, "--json"]);
  expect(inspect.code).toBe(0);
  const layers = JSON.parse(inspect.stdout).composition.layers as { name: string; revision: { x: number; y: number } }[];
  const dashPos = layers.find((l) => l.name === "dash");
  const equalsPos = layers.find((l) => l.name === "equals");
  expect(dashPos?.revision).toMatchObject({ x: -40, y: -40.5 });
  expect(equalsPos?.revision).toMatchObject({ x: -40, y: -40.5 });
});