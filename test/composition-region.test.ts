/**
 * Caller-parameterized region checking for Compositions (#173, spec #172
 * US-001/US-004, DEC-002, DEC-004, ADR-0015, ADR-0005's warning-only
 * disposition).
 *
 * Verifies through the public CLI seam:
 * - `ply composition check <comp> --regions <file>` tests every visible
 *   Layer's painted footprint — the shared extents `composition measure`
 *   reports, never a second geometry model — against every caller-supplied
 *   region, one finding per (layer, region) intersection naming the layer,
 *   its footprint, and the region.
 * - Findings are information, never render failures: the check exits 0
 *   with findings, writes nothing, and changes neither render exit code
 *   nor pixels.
 * - Compact text by default, valid JSON under --json.
 * - Malformed region files, out-of-canvas regions, canvas-contract
 *   mismatches, and missing Compositions fail loudly (exit 1,
 *   actionable error); usage errors exit 2.
 * - Layers that paint nothing (opacity 0, fully transparent) report
 *   nothing.
 * - The check is local: the offline test reuses the suite's network-abort
 *   page seam; no inference weights are involved.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePngRgba, decodePng } from "../src/png.js";
import { checkCompositionRegions } from "../src/composition-region-check.js";
import { getBrowser, closeBrowser } from "../src/browser.js";

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

const RED: [number, number, number, number] = [255, 0, 0, 255];

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

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-comp-region-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "region-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeComp(name: string, width = 400, height = 300) {
  const res = await invoke([
    "composition", "create", name, "--width", String(width), "--height", String(height), "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
}

async function addImageLayer(comp: string, localName: string, imgFile: string, opts: { x?: number; y?: number } = {}) {
  const args = ["composition", "add", comp, localName, "--image", imgFile, "--project", projDir, "--json"];
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

async function addTextLayer(
  comp: string,
  localName: string,
  text: string,
  opts: { font?: string; fontSize?: number; color?: string; x?: number; y?: number } = {},
) {
  const args = ["composition", "add", comp, localName, "--text", text, "--font", opts.font ?? "Anton", "--project", projDir, "--json"];
  if (opts.fontSize !== undefined) args.push("--font-size", String(opts.fontSize));
  if (opts.color !== undefined) args.push("--color", opts.color);
  if (opts.x !== undefined) args.push("--x", String(opts.x));
  if (opts.y !== undefined) args.push("--y", String(opts.y));
  const res = await invoke(args);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

/** Write a region file (object or pre-serialized string) and return its path. */
async function writeRegionFile(rel: string, body: unknown): Promise<string> {
  const p = path.join(tempDir, rel);
  await writeFile(p, typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
  return p;
}

const region = (id: string, box: { x: number; y: number; width: number; height: number }, label = id, reason = `${id} overlay covers content`) => ({ id, label, reason, box });
const regionFileBody = (
  regions: ReturnType<typeof region>[],
  canvas = { width: 400, height: 300 },
) => ({ schemaVersion: 1, canvas, regions });

async function check(comp: string, regionFile: string, extra: string[] = []) {
  const args = ["composition", "check", comp, "--regions", regionFile, "--project", projDir, "--json", ...extra];
  const res = await invoke(args);
  return { res, json: res.code === 0 ? JSON.parse(res.stdout) : undefined };
}

async function measurePainted(comp: string, useName: string) {
  const res = await invoke(["composition", "measure", comp, useName, "--project", projDir, "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).layers[0].painted as
    | { x: number; y: number; width: number; height: number }
    | null;
}

test("check reports one finding per (layer, region) intersection, naming layer, footprint, and region; footprint equals measure's painted extent", async () => {
  const img = path.join(tempDir, "deco.png");
  await writeFile(img, solidPng(64, 48, RED));
  await makeComp("thumb");
  await addTextLayer("thumb", "banner", "HOLD", { fontSize: 64, color: "#ff0000", x: 300, y: 220 });
  // Region well inside the banner's expected ink: the intersection is
  // asserted through the reported geometry, never a hardcoded guess.
  const regions = path.join(tempDir, "one.json");
  await writeFile(regions, JSON.stringify(regionFileBody([region("corner-box", { x: 330, y: 240, width: 30, height: 20 })])) + "\n");

  const { res, json } = await check("thumb", regions);
  expect(res.code).toBe(0);
  expect(json.ok).toBe(true);
  expect(json.composition).toBe("thumb");
  expect(json.canvas).toEqual({ width: 400, height: 300 });
  expect(json.regionCount).toBe(1);
  expect(json.findings).toHaveLength(1);

  const finding = json.findings[0];
  expect(finding.layer).toBe("banner");
  expect(finding.layerId).toBeTruthy();
  expect(finding.region.id).toBe("corner-box");
  expect(finding.region.label).toBe("corner-box");
  expect(finding.region.reason).toBe("corner-box overlay covers content");
  expect(finding.region.box).toEqual({ x: 330, y: 240, width: 30, height: 20 });
  // The footprint is the shared measurement authority's painted extent —
  // the exact number `composition measure` reports for the same use.
  const painted = await measurePainted("thumb", "banner");
  expect(painted).not.toBeNull();
  expect(finding.footprint).toEqual(painted);
  // And it genuinely intersects the region (strict overlap, edges touching excluded).
  const f = finding.footprint;
  const r = finding.region.box;
  expect(f.x < r.x + r.width && f.x + f.width > r.x && f.y < r.y + r.height && f.y + f.height > r.y).toBe(true);
});

test("a full-bleed background intersecting every region is reported per region without failing (information, never a ban)", async () => {
  const img = path.join(tempDir, "bg.png");
  await writeFile(img, solidPng(400, 300, RED));
  await makeComp("plate");
  await addImageLayer("plate", "bg", img, { x: 0, y: 0 });
  const regions = await writeRegionFile("all.json", regionFileBody([
    region("corner-box", { x: 360, y: 250, width: 40, height: 50 }),
    region("bottom-strip", { x: 0, y: 285, width: 400, height: 15 }),
  ]));

  const { res, json } = await check("plate", regions);
  expect(res.code).toBe(0);
  expect(json.ok).toBe(true);
  expect(json.findings).toHaveLength(2);
  expect(json.findings.map((f: { region: { id: string } }) => f.region.id).sort()).toEqual(["bottom-strip", "corner-box"]);
  for (const f of json.findings) {
    expect(f.layer).toBe("bg");
    expect(f.footprint).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  }
});

test("a layer clear of every region produces no findings with exit 0", async () => {
  const img = path.join(tempDir, "small.png");
  await writeFile(img, solidPng(64, 48, RED));
  await makeComp("clear");
  await addImageLayer("clear", "corner", img, { x: 10, y: 10 });
  const regions = await writeRegionFile("far.json", regionFileBody([region("far-away", { x: 200, y: 200, width: 100, height: 50 })]));

  const { res, json } = await check("clear", regions);
  expect(res.code).toBe(0);
  expect(json.ok).toBe(true);
  expect(json.findings).toEqual([]);
});

test("edges touching exactly is not an intersection (the strict-overlap boundary)", async () => {
  // A painted extent ending exactly where a region begins shares an edge
  // but overlaps no pixels — the legacy safe-area rule, which a future
  // `>` → `>=` flip would silently break.
  const img = path.join(tempDir, "top.png");
  await writeFile(img, solidPng(400, 100, RED));
  await makeComp("touching");
  await addImageLayer("touching", "top", img, { x: 0, y: 0 });
  const regions = await writeRegionFile("touching.json", regionFileBody([
    region("just-below", { x: 0, y: 100, width: 400, height: 100 }),
  ]));

  const { res, json } = await check("touching", regions);
  expect(res.code).toBe(0);
  expect(json.findings).toEqual([]);

  // One pixel into the region is enough again.
  await makeComp("overlapping");
  await addImageLayer("overlapping", "top", img, { x: 0, y: 1 });
  const { res: res2, json: json2 } = await check("overlapping", regions);
  expect(res2.code).toBe(0);
  expect(json2.findings).toHaveLength(1);
  expect(json2.findings[0].layer).toBe("top");
});

// An empty regions array is schema-legal: the check completes with zero
// regions, zero findings, and exit 0.
test("a region file with an empty regions array checks nothing, successfully", async () => {
  const img = path.join(tempDir, "bg.png");
  await writeFile(img, solidPng(400, 300, RED));
  await makeComp("noregions");
  await addImageLayer("noregions", "bg", img, { x: 0, y: 0 });
  const regions = await writeRegionFile("empty.json", regionFileBody([]));

  const { res, json } = await check("noregions", regions);
  expect(res.code).toBe(0);
  expect(json.ok).toBe(true);
  expect(json.regionCount).toBe(0);
  expect(json.findings).toEqual([]);
});

test("layers that paint nothing — opacity 0 or fully transparent content — produce no findings", async () => {
  const visible = path.join(tempDir, "on.png");
  await writeFile(visible, solidPng(64, 48, RED));
  const invisible = path.join(tempDir, "invisible.png");
  await writeFile(invisible, solidPng(64, 48, [255, 0, 0, 0]));
  await makeComp("ghosts");
  await addImageLayer("ghosts", "on", visible, { x: 10, y: 10 });
  await addImageLayer("ghosts", "alpha-zero", invisible, { x: 100, y: 100 });
  await addImageLayer("ghosts", "zero-opacity", visible, { x: 200, y: 200 });
  const zeroId = JSON.parse(
    (await invoke(["composition", "inspect", "ghosts", "--project", projDir, "--json"])).stdout,
  ).composition.layers.find((l: { name: string }) => l.name === "zero-opacity").layerId as string;
  expect((await invoke(["layer", "edit", zeroId, "--opacity", "0", "--in-place", "--project", projDir, "--json"])).code).toBe(0);

  // One giant region covers the whole canvas: only the visible layer reports.
  const regions = await writeRegionFile("giant.json", regionFileBody([region("whole", { x: 0, y: 0, width: 400, height: 300 })]));
  const { res, json } = await check("ghosts", regions);
  expect(res.code).toBe(0);
  expect(json.findings).toHaveLength(1);
  expect(json.findings[0].layer).toBe("on");
});

test("compact text by default and valid parseable JSON under --json", async () => {
  const img = path.join(tempDir, "bg.png");
  await writeFile(img, solidPng(400, 300, RED));
  await makeComp("shape");
  await addImageLayer("shape", "bg", img, { x: 0, y: 0 });
  const regions = await writeRegionFile("shape.json", regionFileBody([
    region("corner-box", { x: 360, y: 250, width: 40, height: 50 }, "corner box", "platform UI pins here"),
  ]));

  // JSON shape carries every actionable field.
  const { json } = await check("shape", regions);
  expect(json.regionFile).toBe(regions);
  expect(json.findings[0].region).toEqual({
    id: "corner-box", label: "corner box", reason: "platform UI pins here", box: { x: 360, y: 250, width: 40, height: 50 },
  });

  // Compact text: header plus one line per finding, no raw JSON dump.
  const text = await invoke(["composition", "check", "shape", "--regions", regions, "--project", projDir]);
  expect(text.code).toBe(0);
  const lines = text.stdout.trim().split("\n");
  expect(lines[0]).toContain(`Checked Composition "shape" (400×300) against 1 caller-supplied region`);
  expect(lines[0]).toContain(`1 finding(s)`);
  expect(lines[1]).toContain(`layer "bg" (painted (0, 0) 400×300)`);
  expect(lines[1]).toContain(`intersects region "corner-box"`);
  expect(lines[1]).toContain(`corner box: platform UI pins here`);
  expect(lines[1]).toContain(`move, resize, or accept the overlap`);
  expect(text.stdout).not.toContain('"ok"');

  // Zero findings in compact text: a small corner Layer clear of the region.
  const img2 = path.join(tempDir, "small2.png");
  await writeFile(img2, solidPng(64, 48, RED));
  await makeComp("clear2");
  await addImageLayer("clear2", "corner", img2, { x: 10, y: 10 });
  const far = await writeRegionFile("far2.json", regionFileBody([region("far-away", { x: 200, y: 200, width: 100, height: 50 })]));
  const empty = await invoke(["composition", "check", "clear2", "--regions", far, "--project", projDir]);
  expect(empty.code).toBe(0);
  expect(empty.stdout).toContain("no findings.");
});

test("a malformed region file fails loudly with an actionable error and exit 1", async () => {
  await makeComp("malformed");
  await addTextLayer("malformed", "t", "hi", { fontSize: 32 });
  const file = await writeRegionFile("ok.json", regionFileBody([region("r", { x: 10, y: 10, width: 20, height: 20 })]));

  const cases: { name: string; body: unknown; expect: string }[] = [
    { name: "not JSON", body: "this is not json", expect: "not valid JSON" },
    { name: "not an object", body: [1, 2, 3], expect: "expected a JSON object" },
    { name: "missing schemaVersion", body: { canvas: { width: 400, height: 300 }, regions: [] }, expect: 'missing "schemaVersion"' },
    { name: "unknown schemaVersion", body: { schemaVersion: 2, canvas: { width: 400, height: 300 }, regions: [] }, expect: "schemaVersion" },
    { name: "missing canvas", body: { schemaVersion: 1, regions: [] }, expect: '"canvas"' },
    { name: "bad canvas", body: { schemaVersion: 1, canvas: { width: 400 }, regions: [] }, expect: '"canvas"' },
    { name: "missing regions", body: { schemaVersion: 1, canvas: { width: 400, height: 300 } }, expect: '"regions"' },
    { name: "regions not an array", body: { schemaVersion: 1, canvas: { width: 400, height: 300 }, regions: "nope" }, expect: '"regions"' },
    { name: "region not an object", body: { schemaVersion: 1, canvas: { width: 400, height: 300 }, regions: ["x"] }, expect: "regions[0]" },
    { name: "blank id", body: { schemaVersion: 1, canvas: { width: 400, height: 300 }, regions: [region("", { x: 0, y: 0, width: 10, height: 10 })] }, expect: '"id"' },
    { name: "missing label", body: { schemaVersion: 1, canvas: { width: 400, height: 300 }, regions: [{ id: "r", reason: "why", box: { x: 0, y: 0, width: 10, height: 10 } }] }, expect: '"label"' },
    { name: "blank reason", body: { schemaVersion: 1, canvas: { width: 400, height: 300 }, regions: [region("r", { x: 0, y: 0, width: 10, height: 10 }, "r", " ")] }, expect: '"reason"' },
    { name: "non-numeric box", body: { schemaVersion: 1, canvas: { width: 400, height: 300 }, regions: [region("r", { x: "0", y: 0, width: 10, height: 10 } as unknown as { x: number; y: number; width: number; height: number })] }, expect: '"box.x"' },
    { name: "nonpositive box size", body: { schemaVersion: 1, canvas: { width: 400, height: 300 }, regions: [region("r", { x: 0, y: 0, width: 0, height: 10 })] }, expect: "positive" },
    { name: "duplicate ids", body: { schemaVersion: 1, canvas: { width: 400, height: 300 }, regions: [region("dup", { x: 0, y: 0, width: 10, height: 10 }), region("dup", { x: 50, y: 50, width: 10, height: 10 })] }, expect: 'duplicate region id "dup"' },
  ];
  for (const c of cases) {
    const bad = await writeRegionFile("bad.json", c.body);
    const { res } = await check("malformed", bad);
    const out = JSON.parse(res.stdout);
    expect(res.code).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("bad.json");
    expect(out.error).toContain(c.expect);
  }

  // The valid file still checks the same Composition afterwards: the
  // malformed cases never corrupted anything.
  const { res } = await check("malformed", file);
  expect(res.code).toBe(0);
});

test("a region outside the file's canvas fails loudly with exit 1", async () => {
  const img = path.join(tempDir, "any.png");
  await writeFile(img, solidPng(32, 32, RED));
  await makeComp("outside");
  await addImageLayer("outside", "bg", img, { x: 0, y: 0 });
  const bad = await writeRegionFile("out.json", regionFileBody([
    region("spills", { x: 350, y: 250, width: 100, height: 100 }),
  ]));
  const { res } = await check("outside", bad);
  expect(res.code).toBe(1);
  const out = JSON.parse(res.stdout);
  expect(out.ok).toBe(false);
  expect(out.error).toContain("spills");
  expect(out.error).toMatch(/canvas/i);
});

test("every visible layer x every region reports exactly one finding each (N×M fan-out with attribution)", async () => {
  // Two full-bleed layers, two regions: 2×2 = 4 findings, and each finding
  // must name the right (layer, region) pair — a loop that breaks early or
  // misattributes cannot pass this.
  const imgA = path.join(tempDir, "a.png");
  await writeFile(imgA, solidPng(400, 300, RED));
  const imgB = path.join(tempDir, "b.png");
  await writeFile(imgB, solidPng(400, 300, [0, 0, 255, 255]));
  await makeComp("fanout");
  await addImageLayer("fanout", "alpha", imgA, { x: 0, y: 0 });
  await addImageLayer("fanout", "beta", imgB, { x: 0, y: 0 });
  const regions = await writeRegionFile("fanout.json", regionFileBody([
    region("corner-box", { x: 360, y: 250, width: 40, height: 50 }),
    region("bottom-strip", { x: 0, y: 285, width: 400, height: 15 }),
  ]));

  const { res, json } = await check("fanout", regions);
  expect(res.code).toBe(0);
  expect(json.findings).toHaveLength(4);
  const pairs = json.findings.map((f: { layer: string; region: { id: string } }) => `${f.layer}/${f.region.id}`).sort();
  expect(pairs).toEqual(["alpha/bottom-strip", "alpha/corner-box", "beta/bottom-strip", "beta/corner-box"]);
  // Every finding carries its own layer identity and the shared painted extent.
  for (const f of json.findings) {
    expect(f.layerId).toBeTruthy();
    expect(f.footprint).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  }
});

// Review INT-2/PROD-1 pinned: a bad region file fails before the browser
// pass, so its error takes precedence even when the Composition is also
// missing.
test("a malformed region file fails before the Composition is measured", async () => {
  const bad = await writeRegionFile("bad-order.json", "{ nope");
  const { res } = await check("no-such-comp", bad);
  expect(res.code).toBe(1);
  const out = JSON.parse(res.stdout);
  expect(out.ok).toBe(false);
  expect(out.error).toContain("bad-order.json");
  expect(out.error).not.toContain("no-such-comp");
});

test("a region file whose canvas does not match the Composition's canvas fails loudly with exit 1", async () => {
  const img = path.join(tempDir, "bg.png");
  await writeFile(img, solidPng(400, 300, RED));
  await makeComp("mismatch");
  await addImageLayer("mismatch", "bg", img, { x: 0, y: 0 });
  const wrong = await writeRegionFile("wrong.json", regionFileBody(
    [region("r", { x: 0, y: 0, width: 100, height: 100 })],
    { width: 1280, height: 720 },
  ));
  const { res } = await check("mismatch", wrong);
  expect(res.code).toBe(1);
  const out = JSON.parse(res.stdout);
  expect(out.ok).toBe(false);
  expect(out.error).toContain("wrong.json");
  expect(out.error).toContain("1280×720");
  expect(out.error).toContain("400×300");
});

test("a missing region file and a missing Composition each fail loudly with exit 1", async () => {
  await makeComp("there");
  const missingFile = path.join(tempDir, "does-not-exist.json");
  const { res } = await check("there", missingFile);
  expect(res.code).toBe(1);
  const out = JSON.parse(res.stdout);
  expect(out.ok).toBe(false);
  expect(out.error).toContain("does-not-exist.json");

  const file = await writeRegionFile("fine.json", regionFileBody([region("r", { x: 0, y: 0, width: 100, height: 100 })]));
  const { res: res2 } = await check("nope", file);
  expect(res2.code).toBe(1);
  const out2 = JSON.parse(res2.stdout);
  expect(out2.ok).toBe(false);
  expect(out2.error).toContain("nope");
});

test("usage errors exit 2 with guidance", async () => {
  await makeComp("usage");
  const file = await writeRegionFile("u.json", regionFileBody([region("r", { x: 0, y: 0, width: 10, height: 10 })]));

  // Missing --regions.
  const noFlag = await invoke(["composition", "check", "usage", "--project", projDir, "--json"]);
  expect(noFlag.code).toBe(2);
  expect(JSON.parse(noFlag.stdout).error).toContain("--regions");

  // Missing composition argument.
  const noComp = await invoke(["composition", "check", "--regions", file, "--project", projDir, "--json"]);
  expect(noComp.code).toBe(2);
  expect(JSON.parse(noComp.stdout).error).toContain("Usage: ply composition check");

  // Blank --regions value.
  const blank = await invoke(["composition", "check", "usage", "--regions", " ", "--project", projDir, "--json"]);
  expect(blank.code).toBe(2);
});

test("composition --help documents the check command and the --regions flag", async () => {
  const help = await invoke(["composition", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("check <comp>");
  expect(help.stdout).toContain("--regions");
  expect(help.stdout).toContain("measure <comp>");
});

test("checking writes no Project state", async () => {
  const img = path.join(tempDir, "bg.png");
  await writeFile(img, solidPng(400, 300, RED));
  await makeComp("readonly");
  await addImageLayer("readonly", "bg", img, { x: 0, y: 0 });
  const regions = await writeRegionFile("ro.json", regionFileBody([region("r", { x: 0, y: 0, width: 100, height: 100 })]));

  const walk = async (dir: string, into: Map<string, string>) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p, into);
      else into.set(p, (await readFile(p)).toString("base64"));
    }
  };
  const before = new Map<string, string>();
  await walk(projDir, before);

  expect((await check("readonly", regions)).res.code).toBe(0);
  const text = await invoke(["composition", "check", "readonly", "--regions", regions, "--project", projDir]);
  expect(text.code).toBe(0);

  const after = new Map<string, string>();
  await walk(projDir, after);
  expect(after.size).toBe(before.size);
  for (const [p, bytes] of before) {
    expect(after.get(p)).toBe(bytes);
  }
});

test("the check alters neither render exit code nor pixels", async () => {
  const img = path.join(tempDir, "bg.png");
  await writeFile(img, solidPng(400, 300, RED));
  await makeComp("stable");
  await addImageLayer("stable", "bg", img, { x: 0, y: 0 });
  const regions = await writeRegionFile("s.json", regionFileBody([
    region("corner-box", { x: 360, y: 250, width: 40, height: 50 }),
    region("bottom-strip", { x: 0, y: 285, width: 400, height: 15 }),
  ]));

  const first = await invoke(["composition", "render", "stable", "--project", projDir, "--json"]);
  expect(first.code).toBe(0);
  const firstBytes = await readFile(JSON.parse(first.stdout).render.output as string);

  // The check reports findings for the full-bleed background and exits 0.
  const { res, json } = await check("stable", regions);
  expect(res.code).toBe(0);
  expect(json.findings).toHaveLength(2);

  const second = await invoke(["composition", "render", "stable", "--project", projDir, "--json"]);
  expect(second.code).toBe(0);
  const secondBytes = await readFile(JSON.parse(second.stdout).render.output as string);
  expect(Buffer.compare(firstBytes, secondBytes)).toBe(0);
});

test("the check completes with every browser network route aborted (offline evidence)", async () => {
  const img = path.join(tempDir, "bg.png");
  await writeFile(img, solidPng(400, 300, RED));
  await makeComp("offline");
  await addImageLayer("offline", "bg", img, { x: 0, y: 0 });
  const regions = await writeRegionFile("off.json", regionFileBody([region("r", { x: 0, y: 0, width: 100, height: 100 })]));

  const browser = await getBrowser();
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  await ctx.route("**/*", (route) => route.abort());
  const page = await ctx.newPage();
  try {
    const result = await checkCompositionRegions(projDir, "offline", regions, { page });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.layer).toBe("bg");
    expect(result.findings[0]!.region.id).toBe("r");
  } finally {
    await ctx.close();
    await closeBrowser();
  }
});
