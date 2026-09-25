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
let svgPath: string;

/** A minimal two-rect SVG with a declared intrinsic size: the vector
 *  content the vector-colour guard leg needs (the colour refuses on the
 *  raster fixture). */
function markSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48" viewBox="0 0 64 48">` +
    `<rect width="64" height="48" fill="#ff0000"/>` +
    `<rect x="16" y="12" width="32" height="24" fill="#0000ff"/>` +
    `</svg>`
  );
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-one-command-add-"));
  projDir = path.join(tempDir, "proj");
  await spawn(["project", "init", projDir]);
  await spawn(["composition", "create", "poster", "--width", "400", "--height", "300", "--project", projDir]);
  imagePath = path.join(tempDir, "red.png");
  await writeFile(imagePath, solidPng(64, 48, RED));
  svgPath = path.join(tempDir, "mark.svg");
  await writeFile(svgPath, markSvg());
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
    case "wrap-width": return ["220"];
    case "x": case "y": return ["40"];
    case "opacity": return ["0.8"];
    case "anchor": return ["right"];
    case "resize": return ["1.25"];
    case "resize-to": return ["96x"];
    case "cover-to": return ["canvas"];
    case "scale": return ["2"];
    case "scale-to": return ["1.3x0.8"];
    case "rotate": return ["12"];
    case "flip": return ["horizontal"];
    case "skew": return ["15x0"];
    case "perspective": return ["0x20"];
    case "shadow": return ["2,3,4,#000000"];
    case "outline": return ["2,#00ff00"];
    case "visible-region": return ["10,10,20,20"];
    case "visible-region-radius": return ["8"];
    case "vector-color": return ["#22c55e"];
    case "brightness": return ["1.5"];
    case "contrast": return ["1.2"];
    case "saturation": return ["0.8"];
    case "warmth": return ["0.5"];
    case "blend": return ["multiply"];
    case "glow": return ["6,2,#ff9900"];
    case "blur": return ["6"];
    case "choke": return ["4"];
    case "feather": return ["3"];
    case "fit-box": return ["600x200"];
    // The runs options (#297) never reach this guardValue: they are text
    // CONTENT (the --run occurrences), not layer-level style setters, so
    // the text guard skips them and the dedicated runs test exercises them.
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
    "shape", "size", "corner-radius", "fill",
    "font", "font-file", "font-size", "color", "weight", "width", "tracking", "line-height", "wrap-width", "fit-box",
    "run", "run-text", "runs", "run-color", "run-font", "run-font-file", "run-weight", "run-width",
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
    case "cover-to":
      // "canvas" on a 64x48 image in the 400x300 poster: the uniform cover
      // scale = max(400/64, 300/48) = 6.25 (#293, DEC-011).
      expect(rev.scaleX).toBe(6.25);
      expect(rev.scaleY).toBe(6.25);
      break;
    case "scale":
      // The absolute scale setter writes the canonical scale directly.
      expect(rev.scaleX).toBe(2);
      expect(rev.scaleY).toBe(2);
      break;
    case "scale-to":
      // The absolute per-axis setter writes the same canonical scale fact
      // (#296): the two factors ARE scaleX/scaleY.
      expect(rev.scaleX).toBe(1.3);
      expect(rev.scaleY).toBe(0.8);
      break;
    case "rotate": expect(rev.rotationDeg).toBe(12); break;
    case "flip":
      expect(rev.flipX).toBe(true);
      expect(rev.flipY).toBe(false);
      break;
    case "skew":
      expect(rev.skewXDeg).toBe(15);
      expect(rev.skewYDeg).toBe(0);
      break;
    case "perspective":
      expect(rev.perspectiveTiltXDeg).toBe(0);
      expect(rev.perspectiveTiltYDeg).toBe(20);
      break;
    case "shadow": expect((rev.shadow as { dx: number } | undefined)?.dx).toBe(2); break;
    case "outline": expect((rev.outline as { width: number } | undefined)?.width).toBe(2); break;
    case "visible-region": expect(rev.visibleRegion).toEqual({ x: 10, y: 10, width: 20, height: 20 }); break;
    case "visible-region-radius":
      // The guard add supplies --visible-region "10,10,20,20" beside the
      // radius (a fresh Layer has no region to round): the radius lands on
      // the same fact.
      expect(rev.visibleRegion).toEqual({ x: 10, y: 10, width: 20, height: 20, cornerRadius: 8 });
      break;
    case "vector-color":
      // The guard add for the vector colour uses an SVG image (the colour
      // refuses on raster content): the canonical colour lands on the
      // revision.
      expect(rev.format).toBe("svg");
      expect(rev.vectorColor).toBe("#22c55e");
      break;
    case "brightness": expect((rev.grade as { brightness: number } | undefined)?.brightness).toBe(1.5); break;
    case "contrast": expect((rev.grade as { contrast: number } | undefined)?.contrast).toBe(1.2); break;
    case "saturation": expect((rev.grade as { saturation: number } | undefined)?.saturation).toBe(0.8); break;
    case "warmth": expect((rev.grade as { warmth: number } | undefined)?.warmth).toBe(0.5); break;
    case "blend": expect(rev.blend).toBe("multiply"); break;
    case "glow": expect(rev.glow).toEqual({ width: 6, softness: 2, color: "#ff9900" }); break;
    case "blur": expect(rev.blur).toBe(6); break;
    case "choke": expect(rev.choke).toBe(4); break;
    case "feather": expect(rev.feather).toBe(3); break;
    case "font-size": expect(rev.fontSize).toBe(64); break;
    case "color": expect(rev.color).toBe("#ffcc00"); break;
    case "weight": expect(rev.weight).toBe(800); break;
    case "width": expect(rev.width).toBe(122); break;
    case "tracking": expect(rev.tracking).toBe(0.1); break;
    case "line-height": expect(rev.lineHeight).toBe(1.4); break;
    case "wrap-width": expect(rev.wrapWidth).toBe(220); break;
    case "fit-box":
      expect(rev.fitWidth).toBe(600);
      expect(rev.fitHeight).toBe(200);
      break;
    default: throw new Error(`guard test: no applied-fact read-back for option "${key}"`);
  }
}

test("every edit option applicable to an image Layer is accepted and APPLIED on an image add (TEST-003)", async () => {
  const applicable = layerOptionsApplicableTo("image");
  expect(applicable).toContain("resize-to");
  expect(applicable).toContain("cover-to");
  let n = 0;
  for (const key of applicable) {
    if (["image", "from-generation", "from-matte", "output"].includes(key)) continue; // content/selector options: their own adds
    // The vector colour is defined for vector content only (the raster
    // refusal names it): the guard add uses an SVG image for that option.
    const useImage = key === "vector-color" ? svgPath : imagePath;
    const extra = key === "anchor"
      ? ["--x", "80", "--y", "60"]
      : key === "visible-region-radius"
        ? ["--visible-region", "10,10,20,20"]
        : [];
    const { revision } = await addJson(`p${n++}`, [
      "--image", useImage,
      `--${key}`, ...guardValue(key, imagePath), ...extra,
    ]);
    expectAppliedFact(key, revision);
  }
});

test("every edit option applicable to a text Layer is accepted and APPLIED on a text add (TEST-003)", async () => {
  const applicable = layerOptionsApplicableTo("text");
  expect(applicable).not.toContain("resize-to");
  expect(applicable).not.toContain("cover-to");
  // The runs options (#297) are TEXT CONTENT, not layer-level style: --run
  // authors runs (mutually exclusive with --text), and the per-run setters
  // name runs the --text form does not have. They are exercised below.
  const runKeys = ["run", "run-text", "runs", "run-color", "run-font", "run-font-file", "run-weight", "run-width"];
  expect(applicable).toEqual(expect.arrayContaining(runKeys));
  let n = 0;
  for (const key of applicable) {
    if (["image", "from-generation", "from-matte", "output", "text", "font", "font-file", ...runKeys].includes(key)) continue;
    const extra = key === "anchor"
      ? ["--x", "80", "--y", "60"]
      : key === "visible-region-radius"
        ? ["--visible-region", "10,10,20,20"]
        : [];
    const { revision } = await addJson(`t${n++}`, [
      "--text", "Groundline", "--font", "Archivo",
      `--${key}`, ...guardValue(key, imagePath), ...extra,
    ]);
    expectAppliedFact(key, revision);
  }
}, 30_000);

test("the runs options author runs on a text add and the edit-only forms refuse (TEST-003, #297)", async () => {
  const { revision } = await addJson("runs-guard", [
    "--run", "Ground", "--run", "line ", "--run", "runs", "--font", "Archivo",
    "--run-color", "2=#ffcc00",
    "--run-weight", "2=800",
    "--run-width", "2=122",
    "--run-font", "3=Archivo Black", // a static face: no axes are stored for it
  ]);
  expect(revision.text).toBe("Groundline runs");
  const runs = (revision as { runs?: Array<Record<string, unknown>> }).runs!;
  expect(runs).toHaveLength(3);
  expect(runs[1]).toMatchObject({ start: 6, color: "#ffcc00", weight: 800, width: 122 });
  expect(runs[2]).toMatchObject({ start: 11 });
  expect(typeof (runs[2] as { contentHash?: string }).contentHash).toBe("string");
  // The edit-only forms refuse on add: a new Layer carries no runs to
  // rewrite or collapse.
  const res = await spawn([
    "composition", "add", "poster", "edit-only", "--text", "hi", "--font", "Archivo",
    "--run-text", "1=nope", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(2);
  expect(res.stderr + res.stdout).toContain("edit-only");
  const res2 = await spawn([
    "composition", "add", "poster", "edit-only-2", "--text", "hi", "--font", "Archivo",
    "--runs", "none", "--project", projDir, "--json",
  ]);
  expect(res2.code).toBe(2);
  expect(res2.stderr + res2.stdout).toContain("edit-only");
}, 30_000);

test("every edit option applicable to a shape Layer is accepted and APPLIED on a shape add (TEST-003, #259)", async () => {
  // The table's shape applicability is the ONE home for the fact: the guard
  // enumerates it (A226-004), spot-pins the controls production supports on
  // shapes, and pins the one refusal the table carries for the kind (the
  // vector colour — a shape's colour is its fill).
  const applicable = layerOptionsApplicableTo("shape");
  expect(applicable).toContain("anchor");
  expect(applicable).toContain("resize");
  expect(applicable).toContain("resize-to");
  expect(applicable).not.toContain("cover-to");
  expect(applicable).toContain("scale");
  expect(applicable).toContain("rotate");
  expect(applicable).toContain("flip");
  expect(applicable).toContain("skew");
  expect(applicable).toContain("perspective");
  expect(applicable).toContain("shadow");
  expect(applicable).toContain("outline");
  expect(applicable).toContain("visible-region");
  expect(applicable).toContain("brightness");
  expect(applicable).toContain("contrast");
  expect(applicable).toContain("saturation");
  expect(applicable).toContain("warmth");
  expect(applicable).toContain("blend");
  expect(applicable).toContain("glow");
  expect(applicable).not.toContain("vector-color");
  expect(applicable).not.toContain("font-size");
  // The guard shape is 64×48 so the resize-to read-back ("96x" → 96/64 = 1.5)
  // is shared with the image loop unchanged.
  let n = 0;
  for (const key of applicable) {
    if (["image", "from-generation", "from-matte", "output", "text", "font", "font-file", "shape", "size", "corner-radius", "fill"].includes(key)) continue;
    const extra = key === "anchor"
      ? ["--x", "80", "--y", "60"]
      : key === "visible-region-radius"
        ? ["--visible-region", "10,10,20,20"]
        : [];
    const { revision } = await addJson(`sh${n++}`, [
      "--shape", "rectangle", "--size", "64x48", "--fill", "#1d4ed8",
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
    oneCommandApplicationOrder({ shadow: "1", rotate: "1", anchor: "1", resize: "1", "resize-to": "1", "cover-to": "1", scale: "1", outline: "1", flip: "1", skew: "1", perspective: "1", "visible-region": "1", "visible-region-radius": "1" }),
  ).toEqual(["resize", "resize-to", "cover-to", "scale", "rotate", "flip", "skew", "perspective", "visible-region", "visible-region-radius", "anchor", "shadow", "outline"]);
});