/**
 * One-command `composition add` (spec #226 US-001, DEC-001/DEC-002).
 *
 * This file pins the option-parity guard (TEST-003) and the
 * nothing-published-on-refusal guarantee at the CLI seam:
 *
 * - TEST-003: a guard test enumerates `layer edit`'s options — from the
 *   shared option definition's table — and proves `composition add` accepts
 *   each option applicable to the Layer kind it is exercised on AND APPLIES
 *   it: each add reads the option's applied fact back from the published
 *   revision (exit 0 alone would prove parsing, not application), or proves
 *   it parses and routes to its established semantic refusal (the
 *   generation/matte/output selectors, which need external fixtures).
 * - A refused option publishes nothing: no Layer, no use, no content — the
 *   one-command resolutions (scale bounds, the text-Layer --resize-to
 *   refusal, anchored-placement ink resolution) all run before any content
 *   retention or revision staging.
 * - The `--width` decision recorded on #229: on add it IS the text width
 *   axis (the same spelling `layer edit` uses, validated through the same
 *   shared validator); no rename, no alias.
 *
 * Rendered-pixel parity with the multi-command sequence lives in
 * test/one-command-add-parity.test.ts (TEST-002).
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePngRgba } from "../src/png.js";
import {
  LAYER_OPTION_DEFS,
  layerOptionsApplicableTo,
  oneCommandAddOptionKeys,
  oneCommandApplicationOrder,
  type LayerOptionKey,
} from "../src/layer-options.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

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

let tempDir: string;
let projDir: string;
let imagePath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-one-command-add-"));
  projDir = path.join(tempDir, "proj");
  await spawn(["project", "init", projDir]);
  await spawn(["composition", "create", "poster", "--width", "400", "--height", "300", "--project", projDir]);
  imagePath = path.join(tempDir, "red.png");
  await writeFile(imagePath, solidPng(64, 48, RED));
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

/** The Layer revision facts of a successful add (JSON mode). */
async function addJson(localName: string, args: string[]): Promise<{ ok: boolean; revision: Record<string, unknown> }> {
  const res = await spawn(["composition", "add", "poster", localName, ...args, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  const parsed = JSON.parse(res.stdout);
  return { ok: parsed.ok, revision: parsed.layer.currentRevision };
}

// ---------------------------------------------------------------------------
// TEST-003: the option-parity guard.
// ---------------------------------------------------------------------------

/** A valid value per option, for a real add that must be accepted. */
function guardValue(key: LayerOptionKey, imgPath: string): string[] {
  switch (key) {
    case "image": return [imgPath];
    case "text": return ["Groundline"];
    case "font": return ["Anton"];
    case "font-size": return ["64"];
    case "color": return ["#ffcc00"];
    case "weight": return ["800"];
    case "width": return ["122"];
    case "tracking": return ["0.1"];
    case "line-height": return ["1.4"];
    case "x": case "y": return ["40"];
    case "opacity": return ["0.8"];
    case "anchor": return ["right"];
    case "resize": return ["1.25"];
    case "resize-to": return ["96x"];
    case "rotate": return ["12"];
    case "flip": return ["horizontal"];
    case "shadow": return ["2,3,4,#000000"];
    case "outline": return ["2,#00ff00"];
    default: throw new Error(`guard test: no value for option "${key}"`);
  }
}

test("the guard table: every edit option is an accepted add option (TEST-003)", () => {
  // The post-content set derives from the option table's group fact; the
  // guard is written against the TABLE (layer edit's options), so an option
  // added only to one surface fails this file. Content, the selector, and
  // the plain placement options are accepted through their established
  // surface rules (exercised per kind in the tests below and in the
  // pre-#229 boundary tests).
  const editOptions = LAYER_OPTION_DEFS.filter((def) => def.editOption).map((def) => def.key);
  const oneCommand = oneCommandAddOptionKeys();
  const established = [
    "image", "from-generation", "from-matte", "output", "text", "x", "y", "opacity",
    "font", "font-size", "color", "weight", "width", "tracking", "line-height",
  ];
  for (const key of editOptions) {
    expect(oneCommand.includes(key) || established.includes(key)).toBe(true);
  }
});

/** The applied revision fact each guard option must leave on the published
 *  revision — read back per kind (review INT-plumb-1: an exit-0-only guard
 *  proves parsing, and a future option could parse and be silently dropped
 *  while the guard stayed green; with the apply switch's `default: throw`
 *  in `src/composition.ts` plus these read-backs, a dropped option fails
 *  loudly). The placement/transform/effect facts are kind-shared; the text
 *  style facts are text-only (`appliesTo` keeps `--resize-to` out of the
 *  text loop and the content/selector options out of both). */
function expectAppliedFact(key: LayerOptionKey, rev: Record<string, unknown>): void {
  switch (key) {
    case "x": expect(rev.x).toBe(40); break;
    case "y": expect(rev.y).toBe(40); break;
    case "opacity": expect(rev.opacity).toBe(0.8); break;
    case "anchor":
      // "right": the ink's right edge lands at the --x target (80), so the
      // placement must sit strictly LEFT of the plain placement (80) — a
      // silently dropped --anchor would leave x at exactly 80, so this
      // read-back discriminates application from parsing.
      expect(rev.x).toBeLessThan(80);
      // The unanchored vertical axis keeps the supplied plain placement.
      expect(rev.y).toBe(60);
      break;
    case "resize":
      expect(rev.scaleX).toBe(1.25);
      expect(rev.scaleY).toBe(1.25);
      break;
    case "resize-to":
      // "96x" on a 64px-wide image: aspect preserved.
      expect(rev.scaleX).toBe(1.5);
      expect(rev.scaleY).toBe(1.5);
      break;
    case "rotate": expect(rev.rotationDeg).toBe(12); break;
    case "flip":
      expect(rev.flipX).toBe(true);
      expect(rev.flipY).toBe(false);
      break;
    case "shadow": expect((rev.shadow as { dx: number } | undefined)?.dx).toBe(2); break;
    case "outline": expect((rev.outline as { width: number } | undefined)?.width).toBe(2); break;
    case "font-size": expect(rev.fontSize).toBe(64); break;
    case "color": expect(rev.color).toBe("#ffcc00"); break;
    case "weight": expect(rev.weight).toBe(800); break;
    case "width": expect(rev.width).toBe(122); break;
    case "tracking": expect(rev.tracking).toBe(0.1); break;
    case "line-height": expect(rev.lineHeight).toBe(1.4); break;
    default: throw new Error(`guard test: no applied-fact read-back for option "${key}"`);
  }
}

test("every edit option applicable to an image Layer is accepted and APPLIED on an image add (TEST-003)", async () => {
  const applicable = layerOptionsApplicableTo("image");
  expect(applicable).toContain("resize-to");
  let n = 0;
  for (const key of applicable) {
    if (["image", "from-generation", "from-matte", "output"].includes(key)) continue; // content/selector options: their own adds
    const extra = key === "anchor" ? ["--x", "80", "--y", "60"] : [];
    const { revision } = await addJson(`p${n++}`, [
      "--image", imagePath,
      `--${key}`, ...guardValue(key, imagePath), ...extra,
    ]);
    expectAppliedFact(key, revision);
  }
});

test("every edit option applicable to a text Layer is accepted and APPLIED on a text add (TEST-003)", async () => {
  const applicable = layerOptionsApplicableTo("text");
  expect(applicable).not.toContain("resize-to");
  let n = 0;
  for (const key of applicable) {
    if (["image", "from-generation", "from-matte", "output", "text", "font"].includes(key)) continue;
    const extra = key === "anchor" ? ["--x", "80", "--y", "60"] : [];
    const { revision } = await addJson(`t${n++}`, [
      "--text", "Groundline", "--font", "Archivo",
      `--${key}`, ...guardValue(key, imagePath), ...extra,
    ]);
    expectAppliedFact(key, revision);
  }
});

test("the generation/matte/output flags parse and route to their established refusals (TEST-003)", async () => {
  // These need external fixtures to accept; the guard pins that add parses
  // them (never an unknown-option usage failure) and routes them to the
  // same semantic refusals the edit surface's options have.
  const missingJob = await spawn([
    "composition", "add", "poster", "g1", "--from-generation", "no-such-job", "--rotate", "10", "--project", projDir,
  ]);
  expect(missingJob.code).toBe(1);
  expect(missingJob.stderr).not.toContain("Unknown option");
  const missingMatte = await spawn([
    "composition", "add", "poster", "g2", "--from-matte", "no-such-matte", "--rotate", "10", "--project", projDir,
  ]);
  expect(missingMatte.code).toBe(1);
  expect(missingMatte.stderr).not.toContain("Unknown option");
  const outputAlone = await spawn([
    "composition", "add", "poster", "g3", "--output", "2", "--project", projDir,
  ]);
  expect(outputAlone.code).toBe(2);
  expect(outputAlone.stderr).toContain("--output is only valid together with --from-generation <jobId>.");
});

// ---------------------------------------------------------------------------
// A refused option publishes nothing (DEC-002).
// ---------------------------------------------------------------------------

async function stateSnapshot(): Promise<{ uses: string[]; layerFiles: number; contentFiles: number }> {
  const compDoc = JSON.parse(await Bun.file(path.join(projDir, "compositions", "poster.json")).text());
  const layers = (await readdir(path.join(projDir, "layers"))).filter((f) => f.endsWith(".json"));
  const content = await readdir(path.join(projDir, "content"));
  return {
    uses: compDoc.layers.map((l: { name: string }) => l.name),
    layerFiles: layers.length,
    contentFiles: content.length,
  };
}

test("a refused transform publishes nothing: no Layer, no use, no content", async () => {
  const before = await stateSnapshot();
  // Over the per-axis effective-size cap: the scale resolution refuses
  // inside the publication path, before any retention.
  const res = await spawn([
    "composition", "add", "poster", "too-big", "--image", imagePath, "--resize", "200",
    "--project", projDir,
  ]);
  expect(res.code).toBe(1);
  expect(res.stderr).toContain("Resize result 12800×9600px is over the 8192px per-axis limit");
  const after = await stateSnapshot();
  expect(after).toEqual(before);
});

test("a refused anchored placement publishes nothing: no Layer, no use, no content", async () => {
  // A fully transparent image has no visible painted ink: the anchor
  // resolution refuses, before the content blob is even stored.
  const transparent = path.join(tempDir, "transparent.png");
  await writeFile(transparent, solidPng(32, 32, [0, 0, 0, 0]));
  const before = await stateSnapshot();
  const res = await spawn([
    "composition", "add", "poster", "no-ink", "--image", transparent, "--anchor", "left", "--x", "10",
    "--project", projDir,
  ]);
  expect(res.code).toBe(1);
  expect(res.stderr).toContain("no visible painted ink");
  const after = await stateSnapshot();
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// The --width decision recorded on #229: the text width axis, through the
// shared definition.
// ---------------------------------------------------------------------------

test("--width on add is the text width axis, validated through the shared definition", async () => {
  const add = await addJson("w1", [
    "--text", "Groundline", "--font", "Archivo", "--width", "122",
  ]);
  expect(add.revision.width).toBe(122);
  expect(add.revision.weight).toBe(400);
  // The shape refusal keeps its shared text, and the static-face range
  // refusal names the face's implicit width — the same validator the edit
  // surface runs.
  const badShape = await spawn([
    "composition", "add", "poster", "w2", "--text", "hi", "--font", "Archivo", "--width", "abc",
    "--project", projDir,
  ]);
  expect(badShape.code).toBe(2);
  expect(badShape.stderr).toContain("Width (--width) must be a finite number.");
  const badRange = await spawn([
    "composition", "add", "poster", "w3", "--text", "hi", "--font", "Anton", "--width", "122",
    "--project", projDir,
  ]);
  expect(badRange.code).toBe(2);
  expect(badRange.stderr).toContain("Anton");
});

// ---------------------------------------------------------------------------
// Sequencing pins for the new block (placement precedes it; it precedes the
// text-branch validators; anchor's shape check comes last in the block).
// ---------------------------------------------------------------------------

test("composition add: the transform block precedes the text-branch validators", async () => {
  const res = await spawn([
    "composition", "add", "poster", "s1", "--text", "hi", "--font", "Archivo", "--resize", "abc",
    "--tracking", "abc", "--project", projDir,
  ]);
  expect(res.code).toBe(2);
  expect(res.stderr).toContain('Resize factor (--resize) must be a finite number greater than 0 (got "abc").');
});

test("composition add: rotation and effect shape errors precede --anchor's", async () => {
  const res = await spawn([
    "composition", "add", "poster", "s2", "--image", imagePath, "--anchor", "center", "--rotate", "abc",
    "--project", projDir,
  ]);
  expect(res.code).toBe(2);
  expect(res.stderr).toContain('Rotation (--rotate) must be a finite number of degrees, clockwise positive (got "abc").');
});

test("composition add: --anchor requires explicit targets for the anchored axes", async () => {
  const noX = await spawn([
    "composition", "add", "poster", "s3", "--image", imagePath, "--anchor", "left", "--project", projDir,
  ]);
  expect(noX.code).toBe(2);
  expect(noX.stderr).toContain("--x <target> is required to anchor horizontally: the left ink edge/center lands at the requested x.");
  const noY = await spawn([
    "composition", "add", "poster", "s4", "--image", imagePath, "--anchor", "top", "--project", projDir,
  ]);
  expect(noY.code).toBe(2);
  expect(noY.stderr).toContain("--y <target> is required to anchor vertically: the top ink edge/center lands at the requested y.");
});

test("the one-command application order comes from the option table (transform, anchor, effect)", () => {
  expect(
    oneCommandApplicationOrder({ shadow: "1", rotate: "1", anchor: "1", resize: "1", outline: "1", flip: "1" }),
  ).toEqual(["resize", "rotate", "flip", "anchor", "shadow", "outline"]);
});