/**
 * Refusal parity for the shared option surface (spec #226 US-001 bullet 1,
 * DEC-001; finding A226-001, ticket #257): for EVERY option the shared
 * option table declares, the same invalid value is refused with
 * byte-identical stderr text and the same exit status on `composition add`
 * and `layer edit`.
 *
 * The rows are enumerated against the table (`LAYER_OPTION_DEFS`): an
 * option added to the table without a row fails the completeness guard, so
 * a future option cannot reach one surface with a wording or exit status
 * the other does not share. The recorded decision on #226: the `layer
 * edit` refusal wording and exit status are canonical; a refusal on `add`
 * may change to match, while successful `add` invocations keep their
 * output.
 *
 * Every row is offline: one real Project, one Composition, four Layers
 * (image, text, shape, and a vector image for the vector colour). A bad
 * value is chosen per option so no other refusal can fire first, and the
 * same args (beyond the row's content context) run on both surfaces.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePngRgba } from "../src/png.js";
import { LAYER_OPTION_DEFS, type LayerOptionKey } from "../src/layer-options.js";

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
  for (let i = 0; i < buf.length; i++) {
    buf[i * 4] = rgba[0]; buf[i * 4 + 1] = rgba[1]; buf[i * 4 + 2] = rgba[2]; buf[i * 4 + 3] = rgba[3];
  }
  return encodePngRgba(width, height, buf);
}

const RED: [number, number, number, number] = [255, 0, 0, 255];

let tempDir: string;
let projDir: string;
let imagePath: string;
let svgPath: string;
let imageId: string;
let textId: string;
let shapeId: string;
let svgId: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-refusal-parity-"));
  projDir = path.join(tempDir, "proj");
  await spawn(["project", "init", projDir]);
  await spawn(["composition", "create", "poster", "--width", "400", "--height", "300", "--project", projDir]);
  imagePath = path.join(tempDir, "red.png");
  await writeFile(imagePath, solidPng(64, 48, RED));
  svgPath = path.join(tempDir, "mark.svg");
  await writeFile(
    svgPath,
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48" viewBox="0 0 64 48">` +
    `<rect width="64" height="48" fill="#ff0000"/></svg>`,
  );
  imageId = await addLayer("img", ["--image", imagePath]);
  svgId = await addLayer("vec", ["--image", svgPath]);
  textId = await addLayer("txt", ["--text", "hi", "--font", "Archivo"]);
  shapeId = await addLayer("shp", ["--shape", "rectangle", "--size", "40x20", "--fill", "#ff0000"]);
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

/** A successful seed add (JSON mode): the Layer id only. */
async function addLayer(name: string, args: string[]): Promise<string> {
  const res = await spawn(["composition", "add", "poster", name, ...args, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return (JSON.parse(res.stdout) as { layer: { id: string } }).layer.id;
}

/**
 * One parity row per shared option: the invalid value's args (identical on
 * both surfaces) beside each surface's content context. The edit target is
 * the Layer kind the row's context names; the add's use name is derived
 * from the key. `names` is the fragment of the row's OWN refusal that the
 * row asserts on (INT-1): the flag the validator names, or — for the rows
 * whose validator speaks in values, not flags — that validator's
 * distinctive refusal text, so a future check reorder cannot silently
 * un-exercise a row while it stays green.
 */
const PARITY_ROWS: ReadonlyArray<{
  key: LayerOptionKey;
  /** The invalid value's args — passed verbatim to BOTH surfaces. */
  bad: string[];
  /** The content context each surface gets (add seeds its own content). */
  addContext: string[];
  editContext: string[];
  editId: "imageId" | "textId" | "shapeId" | "svgId";
  /** The fragment the row's own validator's refusal must contain. */
  names: string;
}> = [
  { key: "image", bad: ["--image", "ply-refusal-parity-missing.png"], addContext: [], editContext: [], editId: "imageId", names: 'cannot read the input image "ply-refusal-parity-missing.png"' },
  { key: "from-generation", bad: ["--from-generation", " "], addContext: [], editContext: [], editId: "imageId", names: "--from-generation takes a Generation Job id" },
  { key: "from-matte", bad: ["--from-matte", " "], addContext: [], editContext: [], editId: "imageId", names: "--from-matte takes a matte id" },
  { key: "output", bad: ["--from-generation", "no-such-job", "--output", "banana"], addContext: [], editContext: [], editId: "imageId", names: "--output takes a 1-based output index" },
  { key: "text", bad: ["--text", "   ", "--font", "Archivo"], addContext: [], editContext: [], editId: "textId", names: "Invalid text content" },
  { key: "shape", bad: ["--shape", "banana"], addContext: [], editContext: [], editId: "shapeId", names: "Shape (--shape)" },
  { key: "size", bad: ["--shape", "rectangle", "--size", "banana"], addContext: [], editContext: ["--shape", "rectangle"], editId: "shapeId", names: '--size takes "<W>x<H>"' },
  { key: "corner-radius", bad: ["--corner-radius", "banana"], addContext: ["--shape", "rectangle", "--size", "40x20", "--fill", "#ff0000"], editContext: ["--shape", "rectangle", "--size", "40x20", "--fill", "#ff0000"], editId: "shapeId", names: "Corner radius (--corner-radius)" },
  { key: "fill", bad: ["--fill", "banana"], addContext: ["--shape", "rectangle", "--size", "40x20"], editContext: ["--shape", "rectangle", "--size", "40x20"], editId: "shapeId", names: 'Invalid fill color "banana"' },
  { key: "vector-color", bad: ["--vector-color", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "svgId", names: 'Invalid fill color "banana"' },
  { key: "font", bad: ["--font", "Comic Sans MS"], addContext: ["--text", "hi"], editContext: [], editId: "textId", names: 'unknown font family "Comic Sans MS"' },
  { key: "font-file", bad: ["--font-file", " "], addContext: ["--text", "hi"], editContext: [], editId: "textId", names: "--font-file takes a path" },
  { key: "font-size", bad: ["--font-size", "0"], addContext: ["--text", "hi", "--font", "Archivo"], editContext: [], editId: "textId", names: "Font size (--font-size)" },
  { key: "color", bad: ["--color", "banana"], addContext: ["--text", "hi", "--font", "Archivo"], editContext: [], editId: "textId", names: 'Invalid --color "banana"' },
  { key: "weight", bad: ["--weight", "banana"], addContext: ["--text", "hi", "--font", "Archivo"], editContext: [], editId: "textId", names: "Weight (--weight)" },
  { key: "width", bad: ["--width", "banana"], addContext: ["--text", "hi", "--font", "Archivo"], editContext: [], editId: "textId", names: "Width (--width)" },
  { key: "tracking", bad: ["--tracking", "banana"], addContext: ["--text", "hi", "--font", "Archivo"], editContext: [], editId: "textId", names: "Tracking (--tracking)" },
  { key: "line-height", bad: ["--line-height", "banana"], addContext: ["--text", "hi", "--font", "Archivo"], editContext: [], editId: "textId", names: "Line height (--line-height)" },
  { key: "wrap-width", bad: ["--wrap-width", "banana"], addContext: ["--text", "hi", "--font", "Archivo"], editContext: [], editId: "textId", names: "Wrap width (--wrap-width)" },
  { key: "fit-box", bad: ["--fit-box", "banana"], addContext: ["--text", "hi", "--font", "Archivo"], editContext: [], editId: "textId", names: "Fit box (--fit-box)" },
  { key: "x", bad: ["--x", "abc"], addContext: ["--text", "hi", "--font", "Archivo"], editContext: [], editId: "textId", names: "Placement coordinate (--x)" },
  { key: "y", bad: ["--y", "abc"], addContext: ["--text", "hi", "--font", "Archivo"], editContext: [], editId: "textId", names: "Placement coordinate (--y)" },
  { key: "opacity", bad: ["--opacity", "banana"], addContext: ["--text", "hi", "--font", "Archivo"], editContext: [], editId: "textId", names: "Opacity (--opacity)" },
  { key: "anchor", bad: ["--anchor", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: 'Invalid anchor "banana"' },
  { key: "resize", bad: ["--resize", "0"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: "Resize factor (--resize)" },
  { key: "resize-to", bad: ["--resize-to", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: "--resize-to takes" },
  { key: "cover-to", bad: ["--cover-to", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: "--cover-to takes" },
  { key: "scale", bad: ["--scale", "0"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: "Scale (--scale)" },
  { key: "scale-to", bad: ["--scale-to", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: "--scale-to takes" },
  { key: "rotate", bad: ["--rotate", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: "Rotation (--rotate)" },
  { key: "flip", bad: ["--flip", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: "Flip (--flip)" },
  { key: "shadow", bad: ["--shadow", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: 'Invalid shadow "banana"' },
  { key: "outline", bad: ["--outline", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: 'Invalid outline "banana"' },
  { key: "visible-region", bad: ["--visible-region", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: 'Invalid visible region "banana"' },
  { key: "visible-region-radius", bad: ["--visible-region", "10,10,20,20", "--visible-region-radius", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: ["--visible-region", "10,10,20,20"], editId: "imageId", names: 'Invalid visible-region corner radius "banana"' },
  { key: "brightness", bad: ["--brightness", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: "Brightness (--brightness)" },
  { key: "contrast", bad: ["--contrast", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: "Contrast (--contrast)" },
  { key: "saturation", bad: ["--saturation", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: "Saturation (--saturation)" },
  { key: "warmth", bad: ["--warmth", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: "Warmth (--warmth)" },
  { key: "blend", bad: ["--blend", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: "Blend mode (--blend)" },
  { key: "glow", bad: ["--glow", "banana"], addContext: ["--image", "SET_AT_RUNTIME"], editContext: [], editId: "imageId", names: "--glow" },
];

test("the parity rows cover every option the shared table declares", () => {
  // The enumeration guard: a table entry without a parity row (or a row
  // whose key the table no longer declares) fails here, so a future option
  // cannot reach one surface with a different refusal contract. Compared
  // as sets plus a length check (INT-2): a pure table reorder must not
  // break the guard, only a coverage change may.
  const rowKeys = PARITY_ROWS.map((row) => row.key);
  const tableKeys = LAYER_OPTION_DEFS.map((def) => def.key);
  expect(rowKeys).toHaveLength(tableKeys.length);
  expect([...rowKeys].sort()).toEqual([...tableKeys].sort());
});

test(
  "every shared option refuses the same invalid value identically on add and layer edit",
  async () => {
  const editTarget = (field: "imageId" | "textId" | "shapeId" | "svgId"): string => {
    switch (field) {
      case "imageId": return imageId;
      case "textId": return textId;
      case "shapeId": return shapeId;
      case "svgId": return svgId;
    }
  };

  let n = 0;
  for (const row of PARITY_ROWS) {
    const addImage = row.addContext.includes("SET_AT_RUNTIME") ? imagePath : undefined;
    const addContext = row.addContext.map((arg) => (arg === "SET_AT_RUNTIME" ? addImage! : arg));
    const add = await spawn([
      "composition", "add", "poster", `p${n++}`, ...addContext, ...row.bad, "--project", projDir,
    ]);
    const edit = await spawn([
      "layer", "edit", editTarget(row.editId), ...row.editContext, ...row.bad, "--project", projDir,
    ]);
    expect(
      { code: add.code, stderr: add.stderr },
      `parity row "${row.key}" (add exit ${add.code}, edit exit ${edit.code})`,
    ).toEqual({ code: edit.code, stderr: edit.stderr });
    // INT-1: the refusal must come from the ROW's own validator — both
    // surfaces' stderr must contain the row's distinctive fragment (the
    // flag the validator names, or that validator's distinctive text for
    // the rows whose validators speak in values, not flags) — so a future
    // check reorder cannot silently un-exercise a row while it stays green.
    expect(add.stderr).toContain(row.names);
    expect(edit.stderr).toContain(row.names);
  }
  },
  // 31 rows x 2 CLI spawns each: one generous timeout for the whole loop.
  120_000,
);
