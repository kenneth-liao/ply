/**
 * The behaviour-preservation contract for the shared option definition
 * (#226 DEC-001) at the CLI seam: WHICH refusal fires FIRST when several
 * are possible, on each surface. The shared module's own tests
 * (test/layer-options.test.ts) pin texts and key sets — a reorder of the
 * check sequence in either command boundary would pass them. This file
 * pins the call-site sequencing in-repo: exclusivity before shape errors,
 * the generation/matte trim-vs-conflict interleaving (which differs
 * between the surfaces by design), the generation/output block before the
 * numeric parses, the placement block before the transform/effect/anchor
 * blocks, the address boundary before everything on edit, and the add
 * surface's blank `--image` fall-through to the missing-content refusal
 * (the truthiness hunk in `layerContentKindConflict`, INT-1).
 *
 * Every case is offline: a real Project, one Composition, one image Layer.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePngRgba } from "../src/png.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

let tempDir: string;
let projDir: string;
let layerId: string;

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
    const [r, g, b, a] = rgba;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  }
  return encodePngRgba(width, height, buf);
}

const RED: [number, number, number, number] = [255, 0, 0, 255];

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-option-boundaries-"));
  projDir = path.join(tempDir, "proj");
  await spawn(["project", "init", projDir]);
  await spawn(["composition", "create", "demo", "--width", "200", "--height", "200", "--project", projDir]);
  const imagePath = path.join(tempDir, "red.png");
  await writeFile(imagePath, solidPng(8, 8, RED));
  const added = await spawn(["composition", "add", "demo", "base", "--image", imagePath, "--project", projDir, "--json"]);
  expect(added.code).toBe(0);
  layerId = JSON.parse(added.stdout).layer.id;
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

/** Asserts that `expected` is the FIRST refusal: the full stderr text. */
async function expectRefusal(args: string[], code: number, stderrPart: string): Promise<void> {
  const res = await spawn(args);
  expect(res.code).toBe(code);
  expect(res.stderr).toContain(stderrPart);
}

test("layer edit: the address boundary precedes every option check", async () => {
  await expectRefusal(
    ["layer", "edit", "demo/nosuch", "--opacity", "abc", "--project", projDir],
    1,
    "nosuch",
  );
});

test("layer edit: content-kind exclusivity precedes shape errors", async () => {
  await expectRefusal(
    ["layer", "edit", layerId, "--image", "a.png", "--text", "hi", "--opacity", "abc", "--project", projDir],
    2,
    "--image and text options (--text, --font, --font-file, --font-size, --color, --weight, --width, --tracking, --line-height, --wrap-width) are mutually exclusive.",
  );
});

test("layer edit: the edit surface reads --image presence exactly (blank --image still conflicts, INT-1)", async () => {
  await expectRefusal(
    ["layer", "edit", layerId, "--image", "", "--text", "hi", "--project", projDir],
    2,
    "--image and text options (--text, --font, --font-file, --font-size, --color, --weight, --width, --tracking, --line-height, --wrap-width) are mutually exclusive.",
  );
});

test("layer edit: generation/matte trim checks precede their conflicts", async () => {
  await expectRefusal(
    ["layer", "edit", layerId, "--from-generation", "", "--image", "a.png", "--project", projDir],
    2,
    "--from-generation takes a Generation Job id (see ply generate list).",
  );
  await expectRefusal(
    ["layer", "edit", layerId, "--from-matte", "", "--text", "hi", "--project", projDir],
    2,
    "--from-matte takes a matte id (see ply matte).",
  );
  // The --from-generation trim also precedes the --from-matte checks.
  await expectRefusal(
    ["layer", "edit", layerId, "--from-matte", "m1", "--from-generation", "", "--project", projDir],
    2,
    "--from-generation takes a Generation Job id (see ply generate list).",
  );
});

test("layer edit: the generation/output block precedes the numeric parses", async () => {
  // --output alone is not an edit option: the enumeration refusal fires first.
  await expectRefusal(
    ["layer", "edit", layerId, "--output", "2", "--project", projDir],
    2,
    "No edit options provided: specify at least one of --image, --from-generation, --from-matte, --text, --shape, --size, --corner-radius, --fill, --vector-color, --font, --font-file, --font-size, --color, --weight, --width, --tracking, --line-height, --wrap-width, --x, --y, --opacity, --anchor, --resize, --resize-to, --cover-to, --scale, --rotate, --flip, --shadow, --outline, --visible-region, --visible-region-radius, --brightness, --contrast, --saturation, --warmth, --blend, --glow, or --fork.",
  );
  // With a real edit option supplied, the output-selector check precedes it.
  await expectRefusal(
    ["layer", "edit", layerId, "--output", "abc", "--opacity", "abc", "--project", projDir],
    2,
    "--output is only valid together with --from-generation <jobId>.",
  );
});

test("layer edit: placement precedes transform, transform precedes anchor", async () => {
  await expectRefusal(
    ["layer", "edit", layerId, "--opacity", "abc", "--resize", "abc", "--project", projDir],
    2,
    "Opacity (--opacity) must be a finite number between 0 and 1.",
  );
  await expectRefusal(
    ["layer", "edit", layerId, "--tracking", "5", "--resize", "2", "--project", projDir],
    2,
    "Tracking (--tracking) must be between -0.5 and 1 (inclusive) — 5 is out of range.",
  );
  await expectRefusal(
    ["layer", "edit", layerId, "--resize-to", "100", "--rotate", "abc", "--project", projDir],
    2,
    '--resize-to takes "<W>x<H>" (both axes: deliberate aspect change) or "<W>x" / "x<H>" (one axis: aspect preserved), e.g. "800x600", "800x", "x600" — got "100".',
  );
  // Rotation and effects are parsed before --anchor, so their shape errors win.
  await expectRefusal(
    ["layer", "edit", layerId, "--anchor", "center", "--rotate", "abc", "--project", projDir],
    2,
    'Rotation (--rotate) must be a finite number of degrees, clockwise positive (got "abc").',
  );
  await expectRefusal(
    ["layer", "edit", layerId, "--anchor", "center", "--shadow", "1,2,3", "--project", projDir],
    2,
    'Invalid shadow "1,2,3": --shadow takes "<dx>,<dy>,<blur>,<color>" (e.g. "10,10,4,#000000") or "none".',
  );
});

test("composition add: content-kind conflicts precede the trim checks (opposite of edit)", async () => {
  await expectRefusal(
    ["composition", "add", "demo", "t1", "--from-generation", "", "--image", "a.png", "--project", projDir],
    2,
    "--from-generation and --image/--text/--shape options are mutually exclusive content kinds; use one per Layer.",
  );
  await expectRefusal(
    ["composition", "add", "demo", "t2", "--from-matte", "", "--text", "hi", "--project", projDir],
    2,
    "--from-matte and --image/--text/--from-generation/--shape options are mutually exclusive content kinds; use one per Layer.",
  );
  // Without a conflicting kind, the trim check still fires.
  await expectRefusal(
    ["composition", "add", "demo", "t3", "--from-matte", "", "--project", projDir],
    2,
    "--from-matte takes a matte id (see ply matte).",
  );
});

test("composition add: exclusivity and require-text precede the shape errors", async () => {
  await expectRefusal(
    ["composition", "add", "demo", "t4", "--image", "a.png", "--text", "hi", "--tracking", "abc", "--project", projDir],
    2,
    "--image and --text are mutually exclusive content kinds; use one per Layer.",
  );
  await expectRefusal(
    ["composition", "add", "demo", "t5", "--tracking", "5", "--project", projDir],
    2,
    "--font, --font-file, --font-size, --color, --weight, --width, --tracking, --line-height, and --wrap-width require --text <str>.",
  );
});

test("composition add: the blank --image falls past the exclusivity refusal (INT-1)", async () => {
  // The add surface reads truthiness: a blank --image is not a supplied
  // content kind, so the exclusivity refusal does not fire. The command
  // falls through to the add path's later refusals: with --text, the text
  // branch's missing-font refusal; without any content, missing-content.
  await expectRefusal(
    ["composition", "add", "demo", "t5", "--image", "", "--text", "hi", "--project", projDir],
    2,
    "Missing required option: a font — --font <family> (bundled) or --font-file <path> (caller-supplied) — is required with --text",
  );
  await expectRefusal(
    ["composition", "add", "demo", "t5b", "--image", "", "--project", projDir],
    2,
    "Missing required content: --image <path>, --text <str> (with --font <family> or --font-file <path>), --shape rectangle|ellipse (with --size and --fill), --from-generation <jobId>, or --from-matte <matteId>",
  );
});

test("composition add: the placement block precedes the text-branch validators", async () => {
  await expectRefusal(
    ["composition", "add", "demo", "t6", "--text", "hi", "--font", "Archivo", "--weight", "95", "--opacity", "2", "--project", projDir],
    2,
    "Opacity (--opacity) must be a finite number between 0 and 1.",
  );
  // The refusal names the single coordinate axis (the canonical wording,
  // #257).
  await expectRefusal(
    ["composition", "add", "demo", "t7", "--text", "hi", "--font", "Archivo", "--opacity", "abc", "--x", "abc", "--project", projDir],
    2,
    "Placement coordinate (--x) must be a finite number.",
  );
});

test("composition add: the text branch validates font size, then axes, in order", async () => {
  await expectRefusal(
    ["composition", "add", "demo", "t8", "--text", "hi", "--font", "Archivo", "--tracking", "abc", "--font-size", "abc", "--project", projDir],
    2,
    "Font size (--font-size) must be a positive finite number.",
  );
  await expectRefusal(
    ["composition", "add", "demo", "t9", "--text", "hi", "--font", "Archivo", "--tracking", "abc", "--line-height", "abc", "--project", projDir],
    2,
    "Tracking (--tracking) must be a finite number.",
  );
});

test("composition add: the canvas --width value is validated as the text axis (the conflation, INT-2)", async () => {
  // --width names the canvas dimension on this surface, but the
  // established add path reads it as the text width axis in the text
  // branch — preserved byte-identically; #229 owns the disambiguation.
  await expectRefusal(
    ["composition", "add", "demo", "t10", "--text", "hi", "--font", "Archivo", "--width", "abc", "--project", projDir],
    2,
    "Width (--width) must be a finite number.",
  );
});

// One-command creation (#229): the transform/effect/anchor block sits
// between the placement block and the text-branch validators, and the
// anchor's shape check comes last in that block — the same
// placement-before-transform, transform-before-anchor spine as the edit
// surface. The refused-option parity tests live in
// test/one-command-add.test.ts.

test("composition add: the placement block precedes the one-command transform block (#229)", async () => {
  await expectRefusal(
    ["composition", "add", "demo", "t11", "--image", "a.png", "--opacity", "abc", "--resize", "abc", "--project", projDir],
    2,
    "Opacity (--opacity) must be a finite number between 0 and 1.",
  );
});

test("composition add: the one-command transform block precedes the anchor's shape check (#229)", async () => {
  await expectRefusal(
    ["composition", "add", "demo", "t12", "--image", "a.png", "--anchor", "center", "--flip", "sideways", "--project", projDir],
    2,
    'Flip (--flip) takes horizontal, vertical, both, or none (got "sideways").',
  );
  await expectRefusal(
    ["composition", "add", "demo", "t13", "--image", "a.png", "--anchor", "center", "--shadow", "1,2,3", "--project", projDir],
    2,
    'Invalid shadow "1,2,3": --shadow takes "<dx>,<dy>,<blur>,<color>" (e.g. "10,10,4,#000000") or "none".',
  );
});
test("caller font files (#232): the blank --font-file shape error is a usage error on edit; the add surface's truthiness falls through to its established refusals", async () => {
  // The edit surface reads presence exactly: a blank --font-file IS a
  // supplied font source, so the shape refusal fires (exit 2).
  await expectRefusal(
    ["layer", "edit", layerId, "--font-file", "", "--project", projDir],
    2,
    "--font-file takes a path to a local TrueType or OpenType font file.",
  );
  // The add surface reads truthiness (the established blank --image hunk):
  // a blank --font-file is not a supplied font, so the missing-font refusal
  // fires first — and with a bundled family also named, the one-font-source
  // exclusivity refusal fires.
  await expectRefusal(
    ["composition", "add", "demo", "f1", "--text", "hi", "--font-file", "", "--project", projDir],
    2,
    "Missing required option: a font — --font <family> (bundled) or --font-file <path> (caller-supplied) — is required with --text",
  );
  await expectRefusal(
    ["composition", "add", "demo", "f1b", "--text", "hi", "--font", "Archivo", "--font-file", "", "--project", projDir],
    2,
    "--font and --font-file name one font per edit",
  );
});

test("caller font files (#232): --font-file on an image add rides the content-kind exclusivity refusal", async () => {
  await expectRefusal(
    ["composition", "add", "demo", "f2", "--image", "a.png", "--font-file", "face.ttf", "--project", projDir],
    2,
    "--image and --text are mutually exclusive content kinds; use one per Layer.",
  );
});
