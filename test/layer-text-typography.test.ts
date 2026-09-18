/**
 * Text tracking and line height as revision facts (#187, ADR-0021): a text
 * Layer selects its typography with an optional `tracking` (em, -0.5..1) and
 * `lineHeight` (unitless multiplier, 0.5..3) control next to `--font-size`.
 * Both are font-independent and stored ONLY when set: an omitted control (or
 * `--tracking 0` / `--line-height normal`) stores nothing and paints exactly
 * as before — normal letter spacing and the font's own line height. The
 * stored fields are the only thing paint and measurement read. Every
 * assertion runs through the public CLI against temporary Projects, not
 * private mutation.
 */
import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { decodePng } from "../src/png.js";
import { computeRevisionHash, type LayerTextRevision } from "../src/layer.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

async function invoke(args: string[]) {
  const result = Bun.spawn([process.execPath, cli, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
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
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-text-typography-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "typography-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComposition(name: string, width: number, height: number) {
  const res = await invoke([
    "composition", "create", name, "--width", String(width), "--height", String(height), "--project", projDir,
  ]);
  expect(res.code).toBe(0);
}

async function addText(name: string, local: string, opts: {
  text: string;
  font?: string;
  fontSize?: number;
  color?: string;
  tracking?: number;
  lineHeight?: number | "normal";
  weight?: number;
  width?: number;
  x?: number;
  y?: number;
}) {
  const args = ["composition", "add", name, local, "--text", opts.text, "--font", opts.font ?? "Archivo", "--project", projDir, "--json"];
  if (opts.fontSize !== undefined) args.push("--font-size", String(opts.fontSize));
  if (opts.color !== undefined) args.push("--color", opts.color);
  if (opts.tracking !== undefined) args.push("--tracking", opts.tracking === 0 ? "0" : String(opts.tracking));
  if (opts.lineHeight !== undefined) args.push("--line-height", opts.lineHeight === "normal" ? "normal" : String(opts.lineHeight));
  if (opts.weight !== undefined) args.push("--weight", String(opts.weight));
  if (opts.width !== undefined) args.push("--width", String(opts.width));
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  return invoke(args);
}

async function layerIdOf(comp: string, local: string): Promise<string> {
  const inspect = JSON.parse(
    (await invoke(["composition", "inspect", comp, "--project", projDir, "--json"])).stdout,
  );
  return inspect.composition.layers.find((l: { name: string }) => l.name === local).layerId as string;
}

/** The stored text revision document for a Layer, re-read from Project storage. */
async function readStoredTextRevision(layerId: string): Promise<{ revision: LayerTextRevision; revHash: string }> {
  const identity = JSON.parse(await readFile(path.join(projDir, "layers", `${layerId}.json`), "utf8"));
  const revHash = identity.currentRevision as string;
  const revision = JSON.parse(
    await readFile(path.join(projDir, "layers", `${layerId}.revisions`, `${revHash}.json`), "utf8"),
  );
  return { revision, revHash };
}

// ---------------------------------------------------------------------------
// Stored form and revision hash: present only when set, old ids stable.
// ---------------------------------------------------------------------------

/** The pre-#187 hash formula: identical to the post-#179 formula (scale,
 * rotation, flip, shadow, outline, text axes appended only when present),
 * with NO tracking/line-height fields. Kept inline as the compatibility
 * oracle. */
function pre187RevisionHash(rev: {
  layerId: string; kind: string; contentHash: string; x: number; y: number; opacity: number; createdAt: string;
  text: string; fontSize: number; color: string;
  weight?: number; width?: number;
  scaleX?: number; scaleY?: number; rotationDeg?: number; flipX?: boolean; flipY?: boolean;
  shadow?: { dx: number; dy: number; blur: number; color: string };
  outline?: { width: number; color: string };
}): string {
  const base = `${rev.layerId}:${rev.kind}:${rev.contentHash}:${rev.x}:${rev.y}:${rev.opacity}:${rev.createdAt}`;
  const textFields = `:${rev.text}:${rev.fontSize}:${rev.color}`;
  const textAxes =
    rev.weight !== undefined || rev.width !== undefined ? `:textaxes(${rev.weight},${rev.width})` : "";
  const scaleFields =
    rev.scaleX !== undefined || rev.scaleY !== undefined ? `:${rev.scaleX}:${rev.scaleY}` : "";
  const rotationField = rev.rotationDeg !== undefined ? `:${rev.rotationDeg}` : "";
  const flipFields =
    rev.flipX !== undefined || rev.flipY !== undefined ? `:${rev.flipX}:${rev.flipY}` : "";
  const shadowField =
    rev.shadow !== undefined
      ? `:shadow(${rev.shadow.dx},${rev.shadow.dy},${rev.shadow.blur},${rev.shadow.color})`
      : "";
  const outlineField =
    rev.outline !== undefined ? `:outline(${rev.outline.width},${rev.outline.color})` : "";
  return `rev_${createHash("sha256").update(`${base}${textFields}${scaleFields}${rotationField}${flipFields}${shadowField}${outlineField}${textAxes}`).digest("hex").slice(0, 16)}`;
}

describe("stored form and revision hash (#187, ADR-0021)", () => {
  test("a revision with neither control stores neither field and hashes exactly as pre-#187", async () => {
    await makeComposition("poster", 600, 400);
    const res = await addText("poster", "plain", { text: "Hello", fontSize: 64, color: "#ff0000" });
    expect(res.code).toBe(0);
    const layerId = JSON.parse(res.stdout).use.layerId as string;
    const { revision, revHash } = await readStoredTextRevision(layerId);

    expect(revision.tracking).toBeUndefined();
    expect(revision.lineHeight).toBeUndefined();
    // The stored document IS the pre-#187 shape: id derived without the new
    // fields, by both the inline oracle and the current hash.
    expect(pre187RevisionHash(revision)).toBe(revHash);
    expect(computeRevisionHash(revision)).toBe(revHash);
  });

  test("each control is stored only when set, and the hash appends each field only when present", async () => {
    await makeComposition("poster", 600, 400);
    const a = await addText("poster", "display", { text: "Ply", fontSize: 64, tracking: -0.032, lineHeight: 0.88 });
    expect(a.code).toBe(0);
    const display = await readStoredTextRevision(JSON.parse(a.stdout).use.layerId as string);
    expect(display.revision.tracking).toBe(-0.032);
    expect(display.revision.lineHeight).toBe(0.88);
    // The current hash includes the fields; the pre-#187 oracle (no fields)
    // must NOT, proving the fields participate.
    expect(pre187RevisionHash(display.revision)).not.toBe(display.revHash);
    expect(computeRevisionHash(display.revision)).toBe(display.revHash);

    // One control alone stores exactly that one.
    const b = await addText("poster", "utility", { text: "Ply", fontSize: 64, tracking: 0.16 });
    expect(b.code).toBe(0);
    const utility = await readStoredTextRevision(JSON.parse(b.stdout).use.layerId as string);
    expect(utility.revision.tracking).toBe(0.16);
    expect(utility.revision.lineHeight).toBeUndefined();
    expect(computeRevisionHash(utility.revision)).toBe(utility.revHash);

    const c = await addText("poster", "tight", { text: "Ply", fontSize: 64, lineHeight: 0.88 });
    expect(c.code).toBe(0);
    const tight = await readStoredTextRevision(JSON.parse(c.stdout).use.layerId as string);
    expect(tight.revision.tracking).toBeUndefined();
    expect(tight.revision.lineHeight).toBe(0.88);
    expect(computeRevisionHash(tight.revision)).toBe(tight.revHash);
  });

  test("tracking 0 is never stored: --tracking 0 on add stores no tracking", async () => {
    await makeComposition("poster", 600, 400);
    const res = await addText("poster", "zero", { text: "Ply", fontSize: 64, tracking: 0 });
    expect(res.code).toBe(0);
    const { revision, revHash } = await readStoredTextRevision(JSON.parse(res.stdout).use.layerId as string);
    expect(revision.tracking).toBeUndefined();
    // One stored form per look: identical to the same input with no control.
    expect(pre187RevisionHash(revision)).toBe(revHash);
    expect(computeRevisionHash(revision)).toBe(revHash);
  });

  test("--line-height normal on add stores no lineHeight", async () => {
    await makeComposition("poster", 600, 400);
    const res = await addText("poster", "normal", { text: "Ply", fontSize: 64, lineHeight: "normal" });
    expect(res.code).toBe(0);
    const { revision } = await readStoredTextRevision(JSON.parse(res.stdout).use.layerId as string);
    expect(revision.lineHeight).toBeUndefined();
  });
});
// ---------------------------------------------------------------------------
// Edit semantics: explicit sets/clears, omitted carries (font-independent).
// ---------------------------------------------------------------------------

describe("edit semantics (#187, ADR-0021)", () => {
  test("--tracking 0 on edit removes stored tracking, and the id equals the one a revision that never had it gets", async () => {
    await makeComposition("poster", 600, 400);
    const res = await addText("poster", "display", { text: "Ply", fontSize: 64 });
    const layerId = JSON.parse(res.stdout).use.layerId as string;
    const original = await readStoredTextRevision(layerId);

    // Set, then clear: the stored field disappears and the cleared revision
    // hashes exactly as the pre-#187 formula does for the same fields — the
    // id a revision that never had tracking receives. (Revision ids also
    // cover each edit's own createdAt, so the equality that matters is with
    // the never-had-it hash for the same facts, not the original add's id.)
    const set = await invoke(["layer", "edit", layerId, "--tracking", "-0.032", "--in-place", "--project", projDir, "--json"]);
    expect(set.code).toBe(0);
    const tracked = await readStoredTextRevision(layerId);
    expect(tracked.revision.tracking).toBe(-0.032);
    expect(tracked.revHash).not.toBe(original.revHash);

    const clear = await invoke(["layer", "edit", layerId, "--tracking", "0", "--in-place", "--project", projDir, "--json"]);
    expect(clear.code).toBe(0);
    const cleared = await readStoredTextRevision(layerId);
    expect(cleared.revision.tracking).toBeUndefined();
    expect(pre187RevisionHash(cleared.revision)).toBe(cleared.revHash);
    expect(computeRevisionHash(cleared.revision)).toBe(cleared.revHash);
  });

  test("--line-height normal on edit removes stored lineHeight", async () => {
    await makeComposition("poster", 600, 400);
    const res = await addText("poster", "display", { text: "Ply", fontSize: 64 });
    const layerId = JSON.parse(res.stdout).use.layerId as string;

    const set = await invoke(["layer", "edit", layerId, "--line-height", "0.88", "--in-place", "--project", projDir, "--json"]);
    expect(set.code).toBe(0);
    const setRev = await readStoredTextRevision(layerId);
    expect(setRev.revision.lineHeight).toBe(0.88);

    const clear = await invoke(["layer", "edit", layerId, "--line-height", "normal", "--in-place", "--project", projDir, "--json"]);
    expect(clear.code).toBe(0);
    const cleared = await readStoredTextRevision(layerId);
    expect(cleared.revision.lineHeight).toBeUndefined();
    // The cleared revision hashes exactly as the pre-#187 formula does for
    // the same facts — the id a revision that never had line height gets.
    expect(pre187RevisionHash(cleared.revision)).toBe(cleared.revHash);
  });

  test("an omitted control carries its current value across edits, including --font", async () => {
    await makeComposition("poster", 600, 400);
    // Archivo 500/100 can carry to IBM Plex Mono 500 (the #179 carry rule);
    // the typography must carry with it regardless of the face.
    const res = await addText("poster", "display", { text: "Ply", fontSize: 64, weight: 500, tracking: -0.032, lineHeight: 0.88 });
    const layerId = JSON.parse(res.stdout).use.layerId as string;

    // A --font edit that changes nothing else keeps both values.
    const fontEdit = await invoke(["layer", "edit", layerId, "--font", "IBM Plex Mono", "--in-place", "--project", projDir, "--json"]);
    expect(fontEdit.code).toBe(0);
    const mono = await readStoredTextRevision(layerId);
    expect(mono.revision.tracking).toBe(-0.032);
    expect(mono.revision.lineHeight).toBe(0.88);
    // The font actually changed (retained bytes are the new face's).
    const plexBytes = await readFile(
      path.join(projDir, "content", mono.revision.contentHash),
    );
    expect(
      createHash("sha256").update(plexBytes).digest("hex"),
    ).toBe(mono.revision.contentHash);

    // And back to Archivo: still carried.
    const back = await invoke(["layer", "edit", layerId, "--font", "Archivo", "--in-place", "--project", projDir, "--json"]);
    expect(back.code).toBe(0);
    const archivo = await readStoredTextRevision(layerId);
    expect(archivo.revision.tracking).toBe(-0.032);
    expect(archivo.revision.lineHeight).toBe(0.88);

    // A text-only edit carries them too.
    const textEdit = await invoke(["layer", "edit", layerId, "--text", "Changed", "--in-place", "--project", projDir, "--json"]);
    expect(textEdit.code).toBe(0);
    const afterText = await readStoredTextRevision(layerId);
    expect(afterText.revision.tracking).toBe(-0.032);
    expect(afterText.revision.lineHeight).toBe(0.88);
  });

  test("out-of-range or non-numeric values are usage errors naming the control and its range, publishing nothing", async () => {
    await makeComposition("poster", 600, 400);
    const res = await addText("poster", "display", { text: "Ply", fontSize: 64 });
    const layerId = JSON.parse(res.stdout).use.layerId as string;
    const before = await readStoredTextRevision(layerId);
    const compBefore = await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"]);

    for (const [args, name, range] of [
      [["--tracking", "-0.6"], "Tracking", "-0.5"],
      [["--tracking", "1.1"], "Tracking", "1"],
      [["--line-height", "0.4"], "Line height", "0.5"],
      [["--line-height", "3.1"], "Line height", "3"],
      // A negative line height in space form (INT-1/PROD-2): the dash-join
      // gets it to the validator, so the refusal names the control and its
      // range instead of the parser's generic ambiguity error.
      [["--line-height", "-0.5"], "Line height", "0.5"],
    ] as [string[], string, string][]) {
      // On edit:
      const refused = await invoke(["layer", "edit", layerId, ...args, "--in-place", "--project", projDir]);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain(name);
      expect(refused.stderr).toContain(range);
      // On add:
      const refusedAdd = await invoke([
        "composition", "add", "poster", "refused", "--text", "Ply", "--font", "Archivo", ...args, "--project", projDir,
      ]);
      expect(refusedAdd.code).toBe(2);
      expect(refusedAdd.stderr).toContain(name);
      expect(refusedAdd.stderr).toContain(range);
      // Non-numeric (other than the lineHeight "normal" clear word), on both
      // the edit and the add path (INT-2):
      const nonNumeric = await invoke(["layer", "edit", layerId, ...args.slice(0, 1), "abc", "--in-place", "--project", projDir]);
      expect(nonNumeric.code).toBe(2);
      expect(nonNumeric.stderr).toContain(name);
      const nonNumericAdd = await invoke([
        "composition", "add", "poster", "refused", "--text", "Ply", "--font", "Archivo",
        ...args.slice(0, 1), "abc", "--project", projDir,
      ]);
      expect(nonNumericAdd.code).toBe(2);
      expect(nonNumericAdd.stderr).toContain(name);
    }

    // Nothing was published: the Layer's revision and the Composition are
    // untouched by the refusals.
    const after = await readStoredTextRevision(layerId);
    expect(after.revHash).toBe(before.revHash);
    const compAfter = await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"]);
    expect(JSON.parse(compAfter.stdout)).toEqual(JSON.parse(compBefore.stdout));
  });

  test("tracking and line height are font-independent: they validate the same on any face", async () => {
    await makeComposition("poster", 600, 400);
    // A static face accepts the same ranges — no face validation involved.
    const ok = await addText("poster", "mono", { text: "Ply", font: "IBM Plex Mono", fontSize: 64, tracking: 0.16, lineHeight: 0.88 });
    expect(ok.code).toBe(0);
    const mono = await readStoredTextRevision(JSON.parse(ok.stdout).use.layerId as string);
    expect(mono.revision.tracking).toBe(0.16);
    expect(mono.revision.lineHeight).toBe(0.88);
    // ...and its range refusals do not depend on the face either.
    const refused = await invoke([
      "composition", "add", "poster", "refused", "--text", "Ply", "--font", "IBM Plex Mono", "--tracking", "2", "--project", projDir,
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("-0.5");
  });
});

// ---------------------------------------------------------------------------
// Paint/measure parity, inspect output, pinned-history compatibility.
// ---------------------------------------------------------------------------

describe("paint, measure, and inspect (#187, ADR-0021)", () => {
  test("tracking -0.032 / lineHeight 0.88 renders visibly different spacing from no controls, on both faces", async () => {
    await makeComposition("poster", 700, 400);
    // Display text with Groundline display typography vs the same text with
    // no controls — same font, size, color, placement.
    await addText("poster", "display", { text: "PLY", fontSize: 72, tracking: -0.032, lineHeight: 0.88, color: "#ff0000", x: 20, y: 20 });
    await addText("poster", "plain", { text: "PLY", fontSize: 72, color: "#0000ff", x: 20, y: 200 });
    const measure = await invoke(["composition", "measure", "poster", "--project", projDir, "--json"]);
    expect(measure.code).toBe(0);
    const layers = JSON.parse(measure.stdout).layers;
    const display = layers.find((l: { name: string }) => l.name === "display");
    const plain = layers.find((l: { name: string }) => l.name === "plain");
    expect(display.typography).toEqual({ tracking: -0.032, lineHeight: 0.88 });
    expect(plain.typography).toEqual({});
    // Tighter tracking + smaller line boxes → a visibly narrower, shorter
    // content box than the same text with no controls.
    expect(display.content.width).toBeLessThan(plain.content.width);
    expect(display.content.height).toBeLessThan(plain.content.height);

    // Utility tracking 0.16: the same criterion's other half — wider spacing
    // than the same look (same face, size, weight, width, color) with no
    // tracking control.
    await addText("poster", "utility", { text: "PLY 187", font: "Archivo", fontSize: 72, weight: 800, width: 122, tracking: 0.16, color: "#00ff00", x: 20, y: 20 });
    await addText("poster", "utilityPlain", { text: "PLY 187", font: "Archivo", fontSize: 72, weight: 800, width: 122, color: "#0000ff", x: 20, y: 20 });
    const measure2 = await invoke(["composition", "measure", "poster", "utility", "--project", projDir, "--json"]);
    expect(measure2.code).toBe(0);
    const utility = JSON.parse(measure2.stdout).layers[0];
    expect(utility.typography).toEqual({ tracking: 0.16 });
    const measure3 = await invoke(["composition", "measure", "poster", "utilityPlain", "--project", projDir, "--json"]);
    expect(measure3.code).toBe(0);
    const utilityPlain = JSON.parse(measure3.stdout).layers[0];
    expect(utilityPlain.typography).toEqual({});
    expect(utility.content.width).toBeGreaterThan(utilityPlain.content.width);
  });

  test("measure extents equal the rendered ink for a multi-line Layer at tracking -0.032 / lineHeight 0.88 (measure/render parity)", async () => {
    await makeComposition("poster", 500, 400);
    const res = await addText("poster", "body", {
      text: "PLY\nPLY", fontSize: 64, tracking: -0.032, lineHeight: 0.88, color: "#ff0000", x: 40, y: 30,
    });
    expect(res.code).toBe(0);
    const layerId = JSON.parse(res.stdout).use.layerId as string;

    const measure = await invoke(["composition", "measure", "poster", "body", "--project", projDir, "--json"]);
    expect(measure.code).toBe(0);
    const layer = JSON.parse(measure.stdout).layers[0];
    expect(layer.typography).toEqual({ tracking: -0.032, lineHeight: 0.88 });

    const render = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
    expect(render.code).toBe(0);
    const png = decodePng(await readFile(JSON.parse(render.stdout).render.output as string));
    const reds: { x: number; y: number }[] = [];
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const i = (y * png.width + x) * 4;
        if (png.rgba[i + 3]! > 0 && png.rgba[i]! > 200 && png.rgba[i + 1]! < 100 && png.rgba[i + 2]! < 100) {
          reds.push({ x, y });
        }
      }
    }
    expect(reds.length).toBeGreaterThan(100);
    const inkMinX = Math.min(...reds.map((p) => p.x));
    const inkMinY = Math.min(...reds.map((p) => p.y));
    const inkMaxX = Math.max(...reds.map((p) => p.x));
    const inkMaxY = Math.max(...reds.map((p) => p.y));
    // The layout box is a superset of the glyph ink up to the painted
    // capture's 1px pixel grid (painted extents are quantized to the
    // screenshot's pixel grid, so a sub-pixel layout-box overhang — negative
    // tracking narrows the advance, not the ink — rounds across the edge),
    // tight enough to prove it measured this typography-selected look — the
    // same parity contract the other text facts hold in
    // composition-measure.test.ts.
    expect(inkMinX).toBeGreaterThanOrEqual(layer.box.x);
    expect(inkMinY).toBeGreaterThanOrEqual(layer.box.y);
    expect(inkMaxX).toBeLessThanOrEqual(layer.box.x + layer.box.width + 1);
    expect(inkMaxY).toBeLessThanOrEqual(layer.box.y + layer.box.height + 1);
    expect(layer.box.x + layer.box.width - inkMaxX).toBeLessThan(20);
    expect(layer.box.y + layer.box.height - inkMaxY).toBeLessThan(60);
    expect(inkMinX - layer.box.x).toBeLessThan(20);

    // The line-box height reflects lineHeight 0.88: two 64px lines at 0.88
    // measure ~112.6px tall, well under the ~160px the font's own line
    // height would give — and measure agrees with render (the ink above).
    expect(layer.content.height).toBeGreaterThan(100);
    expect(layer.content.height).toBeLessThan(130);
  });

  test("layer inspect shows tracking and line height when set, and nothing when absent", async () => {
    await makeComposition("poster", 600, 400);
    const res = await addText("poster", "display", { text: "Ply", fontSize: 64, tracking: -0.032, lineHeight: 0.88 });
    const layerId = JSON.parse(res.stdout).use.layerId as string;

    const json = JSON.parse((await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])).stdout);
    expect(json.layer.currentRevision.tracking).toBe(-0.032);
    expect(json.layer.currentRevision.lineHeight).toBe(0.88);

    const text = await invoke(["layer", "inspect", layerId, "--project", projDir]);
    expect(text.stdout).toContain("-0.032em");
    expect(text.stdout).toContain("Line height: 0.88");

    const plain = await addText("poster", "plain", { text: "Ply", fontSize: 64 });
    const plainId = JSON.parse(plain.stdout).use.layerId as string;
    const plainText = await invoke(["layer", "inspect", plainId, "--project", projDir]);
    expect(plainText.stdout).not.toContain("Tracking");
    expect(plainText.stdout).not.toContain("Line height");
  });

  test("a pre-#187 text revision keeps its revision id and its pinned Render replays byte-identically", async () => {
    await makeComposition("poster", 600, 400);
    const res = await addText("poster", "head", { text: "Hello", font: "Anton", fontSize: 96, color: "#ff0000" });
    const layerId = JSON.parse(res.stdout).use.layerId as string;
    const { revision, revHash } = await readStoredTextRevision(layerId);

    // The stored document IS the pre-#187 shape: no typography fields, id
    // derived without them.
    expect(revision.tracking).toBeUndefined();
    expect(revision.lineHeight).toBeUndefined();
    expect(pre187RevisionHash(revision)).toBe(revHash);
    expect(computeRevisionHash(revision)).toBe(revHash);

    // Its pinned Render replays byte-identically after the current revision
    // advances — the retained-content replay contract is untouched.
    const firstOut = path.join(tempDir, "first.png");
    const first = await invoke(["composition", "render", "poster", "--project", projDir, "--out", firstOut, "--json"]);
    expect(first.code).toBe(0);
    const manifest = JSON.parse(first.stdout).render.manifest as string;

    await invoke(["layer", "edit", layerId, "--tracking", "-0.032", "--line-height", "0.88", "--in-place", "--project", projDir, "--json"]);
    const replayOut = path.join(tempDir, "replay.png");
    const replay = await invoke(["composition", "replay", manifest, "--project", projDir, "--out", replayOut, "--json"]);
    expect(replay.code).toBe(0);
    expect(await readFile(replayOut)).toEqual(await readFile(firstOut));
  });
});
