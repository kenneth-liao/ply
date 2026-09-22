/**
 * Spec #206: One oversized Layer blocks measure and --anchor for every Layer in the Composition.
 *
 * Acceptance criteria:
 * - With an oversized Layer big and a text Layer t in Composition c,
 *   ply composition measure c exits 1, reports both Layers, shows t with painted extents,
 *   and shows big with refused set to the existing capture-window message and painted: null.
 * - ply composition measure c t exits 0 and reports t with painted extents; big is neither captured nor mentioned.
 * - ply layer edit c/t --anchor left,top --x 10 --y 10 succeeds and places t exactly as it would in a Composition without big.
 * - ply layer edit c/big --anchor … still fails with the existing capture-window message naming big.
 * - ply composition check c --regions <file> completes, reports t's footprint findings as before, and reports big as refused with a non-zero exit.
 * - A Layer with no visible ink (opacity 0 or fully transparent) still reports painted: null and refused: null.
 * - The existing visible-region test is updated to assert the per-Layer refused field rather than a thrown error.
 * - Measured numbers for a Layer are identical whether it is reported alone or with neighbours.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePngRgba } from "../src/png.js";
import { measureCompositionLayers, measureStandaloneLayer } from "../src/composition-measure.js";

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
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-test-issue-206-"));
  projDir = path.join(tempDir, "proj");
  const init = await invoke(["project", "init", projDir, "--name", "test-206"]);
  expect(init.code).toBe(0);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgba[0]!;
    buf[i + 1] = rgba[1]!;
    buf[i + 2] = rgba[2]!;
    buf[i + 3] = rgba[3]!;
  }
  return encodePngRgba(width, height, buf);
}

test("oversized Layer refusal is per-Layer in composition measure, anchor edit, and region check (#206)", async () => {
  // Setup: a 2048x1536 PNG resized by 2.3 creates a ~4711x3533 layout box (over 16,777,216 px total pixel budget).
  const bigPng = path.join(tempDir, "big-2048x1536.png");
  await writeFile(bigPng, solidPng(2048, 1536, [255, 0, 0, 255]));

  // Create Composition c (5000x4000)
  expect((await invoke(["composition", "create", "c", "--width", "5000", "--height", "4000", "--project", projDir])).code).toBe(0);

  // Add oversized Layer big
  const addBig = await invoke([
    "composition", "add", "c", "big",
    "--image", bigPng,
    "--project", projDir,
    "--json",
  ]);
  expect(addBig.code).toBe(0);
  const bigLayerId = JSON.parse(addBig.stdout).use.layerId as string;
  expect((await invoke(["layer", "edit", bigLayerId, "--resize", "2.3", "--in-place", "--project", projDir])).code).toBe(0);

  // Add text Layer t
  const addText = await invoke([
    "composition", "add", "c", "t",
    "--text", "Hi",
    "--font", "Archivo",
    "--x", "50",
    "--y", "50",
    "--project", projDir,
    "--json",
  ]);
  expect(addText.code).toBe(0);
  const textLayerId = JSON.parse(addText.stdout).use.layerId as string;

  // 1. `ply composition measure c` exits 1, ok stays true, reports both Layers,
  // t has painted extents, big has refused set and painted: null, paintedOnCanvas: null, clipped: false.
  const measureComp = await invoke(["composition", "measure", "c", "--project", projDir, "--json"]);
  expect(measureComp.code).toBe(1);
  const measureJson = JSON.parse(measureComp.stdout);
  expect(measureJson.ok).toBe(true);
  expect(measureJson.layers).toHaveLength(2);

  const bigReport = measureJson.layers.find((l: { name: string }) => l.name === "big");
  const textReport = measureJson.layers.find((l: { name: string }) => l.name === "t");

  expect(bigReport).toBeDefined();
  expect(bigReport.refused).toMatch(/beyond the painted-extent capture window/i);
  expect(bigReport.refused).toContain("big");
  expect(bigReport.painted).toBeNull();
  expect(bigReport.paintedOnCanvas).toBeNull();
  expect(bigReport.clipped).toBe(false);
  expect(bigReport.box.width).toBeGreaterThan(4000);

  expect(textReport).toBeDefined();
  expect(textReport.refused).toBeNull();
  expect(textReport.painted).not.toBeNull();
  expect(textReport.painted.width).toBeGreaterThan(0);

  // Human output for `composition measure c` marks refused ones
  const humanMeasure = await invoke(["composition", "measure", "c", "--project", projDir]);
  expect(humanMeasure.code).toBe(1);
  expect(humanMeasure.stdout).toContain('"big"');
  expect(humanMeasure.stdout).toContain('"t"');
  expect(humanMeasure.stdout).toMatch(/refused/i);

  // 2. `ply composition measure c t` exits 0 and reports t with painted extents; big is neither captured nor mentioned.
  const measureT = await invoke(["composition", "measure", "c", "t", "--project", projDir, "--json"]);
  expect(measureT.code).toBe(0);
  const jsonT = JSON.parse(measureT.stdout);
  expect(jsonT.ok).toBe(true);
  expect(jsonT.layers).toHaveLength(1);
  expect(jsonT.layers[0].name).toBe("t");
  expect(jsonT.layers[0].refused).toBeNull();
  expect(jsonT.layers[0].painted).not.toBeNull();

  // 8. Numbers for t are identical whether reported alone or with big
  expect(jsonT.layers[0].box).toEqual(textReport.box);
  expect(jsonT.layers[0].painted).toEqual(textReport.painted);

  // 3. `ply layer edit c/t --anchor left,top --x 10 --y 10` succeeds and places t exactly as it would without big
  // Build identical composition without big to verify exact placement parity
  expect((await invoke(["composition", "create", "withoutbig", "--width", "5000", "--height", "4000", "--project", projDir])).code).toBe(0);
  const addSolo = await invoke([
    "composition", "add", "withoutbig", "tSolo",
    "--text", "Hi",
    "--font", "Archivo",
    "--x", "50",
    "--y", "50",
    "--project", projDir,
    "--json",
  ]);
  expect(addSolo.code).toBe(0);
  const anchorSolo = await invoke([
    "layer", "edit", "withoutbig/tSolo",
    "--anchor", "left,top",
    "--x", "10",
    "--y", "10",
    "--project", projDir,
    "--json",
  ]);
  expect(anchorSolo.code).toBe(0);
  const anchorSoloJson = JSON.parse(anchorSolo.stdout);

  const anchorT = await invoke([
    "layer", "edit", "c/t",
    "--anchor", "left,top",
    "--x", "10",
    "--y", "10",
    "--project", projDir,
    "--json",
  ]);
  expect(anchorT.code).toBe(0);
  const anchorTJson = JSON.parse(anchorT.stdout);
  expect(anchorTJson.ok).toBe(true);
  expect(anchorTJson.layer.currentRevision.x).toBe(anchorSoloJson.layer.currentRevision.x);
  expect(anchorTJson.layer.currentRevision.y).toBe(anchorSoloJson.layer.currentRevision.y);
  expect(anchorTJson.anchored.placement).toEqual(anchorSoloJson.anchored.placement);

  // 4. `ply layer edit c/big --anchor …` still fails with the existing capture-window message naming big
  const anchorBig = await invoke([
    "layer", "edit", "c/big",
    "--anchor", "center,center",
    "--x", "100",
    "--y", "100",
    "--project", projDir,
    "--json",
  ]);
  expect(anchorBig.code).toBe(1);
  const anchorBigJson = JSON.parse(anchorBig.stdout);
  expect(anchorBigJson.ok).toBe(false);
  expect(anchorBigJson.error).toMatch(/beyond the painted-extent capture window/i);
  expect(anchorBigJson.error).toContain("big");

  // 5. `ply composition check c --regions <file>` completes, reports t findings, and reports big as refused with exit 1
  const regionFile = path.join(tempDir, "regions.json");
  await writeFile(
    regionFile,
    JSON.stringify({
      schemaVersion: 1,
      canvas: { width: 5000, height: 4000 },
      regions: [
        {
          id: "badge",
          label: "badge",
          reason: "top left badge",
          box: { x: 0, y: 0, width: 200, height: 200 },
        },
      ],
    }) + "\n",
  );
  const checkComp = await invoke([
    "composition", "check", "c",
    "--regions", regionFile,
    "--project", projDir,
    "--json",
  ]);
  expect(checkComp.code).toBe(1);
  const checkJson = JSON.parse(checkComp.stdout);
  expect(checkJson.ok).toBe(true);
  expect(checkJson.findings.length).toBeGreaterThan(0);
  expect(checkJson.findings.some((f: { layer: string }) => f.layer === "t")).toBe(true);
  expect(checkJson.refused).toBeDefined();
  expect(checkJson.refused).toHaveLength(1);
  expect(checkJson.refused[0].layer).toBe("big");
  expect(checkJson.refused[0].layerId).toBe(bigLayerId);
  expect(checkJson.refused[0].message).toMatch(/beyond the painted-extent capture window/i);

  // 6. A Layer with no visible ink (opacity 0 or fully transparent) reports painted: null and refused: null
  const addTransparent = await invoke([
    "composition", "add", "c", "ghost",
    "--text", "Phantom",
    "--font", "Archivo",
    "--opacity", "0",
    "--project", projDir,
    "--json",
  ]);
  expect(addTransparent.code).toBe(0);
  const measureGhost = await invoke(["composition", "measure", "c", "ghost", "--project", projDir, "--json"]);
  expect(measureGhost.code).toBe(0);
  const ghostReport = JSON.parse(measureGhost.stdout).layers[0];
  expect(ghostReport.painted).toBeNull();
  expect(ghostReport.refused).toBeNull();

  // 7. Direct API check for measureCompositionLayers and measureStandaloneLayer
  const directComp = await measureCompositionLayers(projDir, "c");
  const directBig = directComp.layers.find((l) => l.name === "big")!;
  expect(directBig.refused).toMatch(/beyond the painted-extent capture window/i);
  expect(directBig.painted).toBeNull();

  const directStandalone = await measureStandaloneLayer(projDir, bigLayerId);
  expect(directStandalone.refused).toMatch(/beyond the painted-extent capture window/i);
  expect(directStandalone.painted).toBeNull();
}, 120000);
