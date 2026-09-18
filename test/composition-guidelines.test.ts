/**
 * The Composition guideline view (#174, spec #172 US-002, ADR-0005's
 * render-excluded overlay disposition carried forward by ADR-0015).
 *
 * Verifies through the public CLI seam where practical:
 * - `ply composition guidelines <comp> --regions <file>` renders the
 *   Composition canvas with the caller's regions drawn as inspectable
 *   overlay markup, each region's label and reason visible — through the
 *   same region ingestion point `composition check` accepts.
 * - Structural exclusion: the guideline markup exists only on the guideline
 *   code path; the final-render path cannot emit it. The key behavioral
 *   proof is the byte-equal render → guidelines → render sequence.
 * - The view writes no Render manifest and adds nothing to retained Render
 *   history; it refuses to overwrite any output a Render manifest or the
 *   Project's Render history records.
 * - Malformed region files, out-of-canvas regions, canvas mismatches, and
 *   missing Compositions fail loudly (exit 1, actionable error); usage
 *   errors exit 2. Compact text by default, valid JSON under --json.
 * - The view is local: the offline test reuses the suite's network-abort
 *   page seam; no inference weights are involved.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, writeFile, readFile, readdir, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePngRgba, decodePng } from "../src/png.js";
import { buildCompositionHtml } from "../src/composition-paint.js";
import { guidelinePageHtml, placeRegionCallouts } from "../src/composition-guidelines.js";
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
  return encodePngRgba(width, buf.length / 4 / width, buf);
}

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-comp-guidelines-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "guideline-proj"]);
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

/** Write a region file (same schema `composition check` accepts) and return its path. */
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

async function guidelines(comp: string, regionFile: string, extra: string[] = []) {
  const args = ["composition", "guidelines", comp, "--regions", regionFile, "--project", projDir, "--json", ...extra];
  const res = await invoke(args);
  return { res, json: res.code === 0 ? JSON.parse(res.stdout) : undefined };
}

async function render(comp: string, extra: string[] = []) {
  const res = await invoke(["composition", "render", comp, "--project", projDir, "--json", ...extra]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  return { json, bytes: await readFile(json.render.output as string) };
}

/** Walk the Project tree into a path → base64 byte map. */
async function walk(dir: string, into: Map<string, string>): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, into);
    else into.set(p, (await readFile(p)).toString("base64"));
  }
}

const ALPHA_AT = (png: Buffer, x: number, y: number, width: number): number => {
  const decoded = decodePng(png);
  return decoded.rgba[(y * width + x) * 4 + 3]!;
};

test("the guideline output draws the caller regions over the canvas; the final render of the same Composition is byte-identical and contains none of the overlay", async () => {
  const img = path.join(tempDir, "small.png");
  await writeFile(img, solidPng(64, 48, RED));
  await makeComp("thumb");
  // The Layer sits top-left; the region sits over otherwise-transparent
  // canvas, so the overlay tint there is attributable to the overlay alone.
  await addImageLayer("thumb", "corner", img, { x: 10, y: 10 });
  const regions = await writeRegionFile("g.json", regionFileBody([
    region("corner-box", { x: 250, y: 180, width: 80, height: 50 }, "duration badge", "the platform pins a badge here"),
  ]));

  const first = await render("thumb");
  const renderBytes = first.bytes;

  const { res, json } = await guidelines("thumb", regions);
  expect(res.code).toBe(0);
  expect(json.ok).toBe(true);
  expect(json.composition).toBe("thumb");
  expect(json.canvas).toEqual({ width: 400, height: 300 });
  expect(json.regionCount).toBe(1);
  expect(json.regionFile).toBe(regions);
  // Fresh, never-colliding default under the Project's guidelines/ (review
  // output; re-running never overwrites the artifact under review).
  expect(path.dirname(json.output)).toBe(path.join(projDir, "guidelines"));
  expect(path.basename(json.output)).toMatch(/^thumb-[a-z0-9]+-[a-f0-9]{8}\.guidelines\.png$/);
  const guidelinePng = await readFile(json.output);
  // Same canvas dimensions as the Composition.
  expect(decodePng(guidelinePng).width).toBe(400);
  expect(decodePng(guidelinePng).height).toBe(300);

  // The overlay is really painted: a pixel inside the region box — over
  // transparent canvas, away from the dashed border — carries the overlay's
  // alpha, where the same pixel in the final render is empty. And the
  // callout pill (white background, real text ink) paints somewhere in the
  // view where the final render has none.
  const gx = 290, gy = 205; // strictly inside the box, clear of border
  expect(ALPHA_AT(guidelinePng, gx, gy, 400)).toBeGreaterThan(0);
  expect(ALPHA_AT(renderBytes, gx, gy, 400)).toBe(0);
  const pillPixels = (png: Buffer): number => {
    const d = decodePng(png).rgba;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i]! > 200 && d[i - 1]! > 240 && d[i - 2]! > 240 && d[i - 3]! > 240) n++;
    }
    return n;
  };
  expect(pillPixels(guidelinePng)).toBeGreaterThan(50);
  expect(pillPixels(renderBytes)).toBe(0);

  // The structural proof: re-rendering the same Composition after the
  // guideline view produces byte-identical output — none of the overlay
  // can have entered the final render bytes.
  const second = await render("thumb");
  expect(Buffer.compare(renderBytes, second.bytes)).toBe(0);
  expect(ALPHA_AT(second.bytes, gx, gy, 400)).toBe(0);
});

test("the overlay markup exists only on the guideline code path — the shared page builder cannot emit it", () => {
  // The final render path paints exactly buildCompositionHtml's markup; it
  // takes no overlay parameter and can produce none of the guide markup.
  const base = buildCompositionHtml({ width: 400, height: 300 }, []);
  expect(base).not.toContain("ply-region-guide");
  expect(base).not.toContain("data-region-id");

  // The guideline wrapper is the only page that carries it, with each
  // region's label and reason visible in the markup.
  const regions = [region("corner-box", { x: 250, y: 180, width: 80, height: 50 }, "duration badge", "the platform pins a badge here")];
  const guideline = guidelinePageHtml({ width: 400, height: 300 }, [], regions);
  expect(guideline).toContain("ply-region-guide");
  expect(guideline).toContain('data-region-id="corner-box"');
  expect(guideline).toContain("duration badge");
  expect(guideline).toContain("the platform pins a badge here");
  // The base page markup is untouched underneath the wrapper.
  expect(guideline.startsWith(base.slice(0, base.indexOf("</body>")))).toBe(true);
});

test("the guideline view writes no Render manifest and adds nothing to retained Render history", async () => {
  const img = path.join(tempDir, "bg.png");
  await writeFile(img, solidPng(400, 300, RED));
  await makeComp("plate");
  await addImageLayer("plate", "bg", img, { x: 0, y: 0 });
  const regions = await writeRegionFile("ro.json", regionFileBody([region("r", { x: 0, y: 0, width: 100, height: 100 })]));

  // A render first: its manifest and PNG are retained history.
  const { json } = await render("plate");
  const rendersBefore = new Map<string, string>();
  await walk(path.join(projDir, "renders"), rendersBefore);

  const before = new Map<string, string>();
  await walk(projDir, before);

  const { res } = await guidelines("plate", regions);
  expect(res.code).toBe(0);

  // The Project gained exactly one new file — the guideline PNG under
  // guidelines/. renders/ is byte-for-byte unchanged: no manifest, no
  // history entry, nothing recorded.
  const after = new Map<string, string>();
  await walk(projDir, after);
  const added = [...after.keys()].filter((p) => !before.has(p));
  expect(added).toHaveLength(1);
  expect(path.dirname(added[0]!)).toBe(path.join(projDir, "guidelines"));
  expect(added[0]!).toMatch(/\.guidelines\.png$/);

  const rendersAfter = new Map<string, string>();
  await walk(path.join(projDir, "renders"), rendersAfter);
  expect(rendersAfter.size).toBe(rendersBefore.size);
  for (const [p, bytes] of rendersBefore) {
    expect(rendersAfter.get(p)).toBe(bytes);
  }
});

test("the view refuses to overwrite a Render output — the default render destination and an explicit --out both fail loudly", async () => {
  const img = path.join(tempDir, "bg.png");
  await writeFile(img, solidPng(400, 300, RED));
  await makeComp("kept");
  await addImageLayer("kept", "bg", img, { x: 0, y: 0 });
  const regions = await writeRegionFile("k.json", regionFileBody([region("r", { x: 0, y: 0, width: 100, height: 100 })]));

  // A default render under the Project's renders/ history.
  const { json } = await render("kept");
  const historyPng = json.render.output as string;
  const historyBytes = await readFile(historyPng);

  // Pointing the guideline view at the retained history output is refused —
  // it is existing in-Project state, so the export-target boundary refuses
  // it before anything else.
  const res = await invoke(["composition", "guidelines", "kept", "--regions", regions, "--out", historyPng, "--project", projDir, "--json"]);
  expect(res.code).toBe(1);
  const out = JSON.parse(res.stdout);
  expect(out.ok).toBe(false);
  expect(out.error).toContain("inside the Project");
  // The recorded bytes are untouched.
  expect(Buffer.compare(await readFile(historyPng), historyBytes)).toBe(0);

  // An external --out a Render recorded via render --out is refused too.
  const external = path.join(tempDir, "exported", "kept.png");
  await mkdir(path.dirname(external), { recursive: true });
  await render("kept", ["--out", external]);
  const extBytes = await readFile(external);
  const res2 = await invoke(["composition", "guidelines", "kept", "--regions", regions, "--out", external, "--project", projDir, "--json"]);
  expect(res2.code).toBe(1);
  expect(JSON.parse(res2.stdout).ok).toBe(false);
  expect(JSON.parse(res2.stdout).error).toContain(".manifest.json");
  expect(Buffer.compare(await readFile(external), extBytes)).toBe(0);

  // A RELATIVE external --out is recorded absolute at the render boundary
  // (never ambiguous cwd-relative data), so the refusal follows the caller
  // to the absolute path even when the render ran from another directory.
  const relDir = path.join(tempDir, "from-cwd");
  await mkdir(path.join(relDir, "rel-view"), { recursive: true });
  const relOut = "./rel-view/kept.png";
  const relRender = await invoke(
    ["composition", "render", "kept", "--out", relOut, "--project", projDir, "--json"],
    relDir,
  );
  expect(relRender.code).toBe(0);
  // The record is absolute: resolve the caller's relative form through its
  // real parent (the recorded form is the realpath-resolved target).
  const recordedAbs = await realpath(path.resolve(relDir, relOut));
  expect(JSON.parse(relRender.stdout).render.output).toBe(recordedAbs);
  const relBytes = await readFile(recordedAbs);
  const res3 = await invoke(["composition", "guidelines", "kept", "--regions", regions, "--out", recordedAbs, "--project", projDir, "--json"]);
  expect(res3.code).toBe(1);
  expect(JSON.parse(res3.stdout).ok).toBe(false);
  expect(JSON.parse(res3.stdout).error).toContain(".manifest.json");
  expect(Buffer.compare(await readFile(recordedAbs), relBytes)).toBe(0);
});

test("the view refuses to write Project state — --out routes through the render path's export-target boundary", async () => {
  const img = path.join(tempDir, "bg.png");
  await writeFile(img, solidPng(64, 64, RED));
  await makeComp("guard");
  await addImageLayer("guard", "bg", img, { x: 0, y: 0 });
  const regions = await writeRegionFile("g2.json", regionFileBody([region("r", { x: 0, y: 0, width: 10, height: 10 })]));

  // Existing Project state is never written over.
  for (const victim of ["ply.json", "compositions/guard.json", "layers/whatever.json"]) {
    const res = await invoke(["composition", "guidelines", "guard", "--regions", regions, "--out", path.join(projDir, victim), "--project", projDir, "--json"]);
    expect(res.code, victim).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.ok, victim).toBe(false);
    expect(out.error, victim).toContain(victim);
  }
  // The manifest survived byte-for-byte.
  expect(await readFile(path.join(projDir, "ply.json"), "utf8")).toContain('"guideline-proj"');

  // A fresh path under reserved storage is refused too.
  const freshReserved = path.join(projDir, "compositions", "sneaky.png");
  const res2 = await invoke(["composition", "guidelines", "guard", "--regions", regions, "--out", freshReserved, "--project", projDir, "--json"]);
  expect(res2.code).toBe(1);
  expect(JSON.parse(res2.stdout).error).toContain("reserved");
  expect(await readdir(path.join(projDir, "compositions"))).not.toContain("sneaky.png");

  // A fresh path whose parent does not exist is refused, not auto-created.
  const missingParent = path.join(tempDir, "no-such-dir", "view.png");
  const res3 = await invoke(["composition", "guidelines", "guard", "--regions", regions, "--out", missingParent, "--project", projDir, "--json"]);
  expect(res3.code).toBe(1);
  expect(JSON.parse(res3.stdout).error).toContain("parent directory does not exist");
});

test("a fresh --out outside the Project and a repeat run over the view's own previous output both succeed", async () => {
  const img = path.join(tempDir, "bg.png");
  await writeFile(img, solidPng(400, 300, RED));
  await makeComp("fresh");
  await addImageLayer("fresh", "bg", img, { x: 0, y: 0 });
  const regions = await writeRegionFile("f.json", regionFileBody([region("r", { x: 0, y: 0, width: 100, height: 100 })]));

  const custom = path.join(tempDir, "elsewhere", "view.png");
  await mkdir(path.dirname(custom), { recursive: true });
  const { res, json } = await guidelines("fresh", regions, ["--out", custom]);
  expect(res.code).toBe(0);
  expect(json.output).toBe(custom);
  expect((await readFile(custom)).length).toBeGreaterThan(0);

  // The guideline view is a review artifact, not recorded state: writing
  // its own previous output again replaces it without a manifest conflict.
  const { res: res2 } = await guidelines("fresh", regions, ["--out", custom]);
  expect(res2.code).toBe(0);
});

test("malformed region files, out-of-canvas regions, canvas mismatches, and missing Compositions fail loudly with exit 1", async () => {
  await makeComp("loud");
  const good = await writeRegionFile("good.json", regionFileBody([region("r", { x: 10, y: 10, width: 20, height: 20 })]));

  // Malformed region file.
  const bad = await writeRegionFile("bad.json", "{ nope");
  const { res } = await guidelines("loud", bad);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).ok).toBe(false);
  expect(JSON.parse(res.stdout).error).toContain("bad.json");

  // Out-of-canvas region.
  const outside = await writeRegionFile("outside.json", regionFileBody([
    region("spills", { x: 350, y: 250, width: 100, height: 100 }),
  ]));
  const { res: res2 } = await guidelines("loud", outside);
  expect(res2.code).toBe(1);
  expect(JSON.parse(res2.stdout).error).toContain("spills");

  // Canvas mismatch.
  const wrong = await writeRegionFile("wrong.json", regionFileBody(
    [region("r", { x: 0, y: 0, width: 100, height: 100 })],
    { width: 1280, height: 720 },
  ));
  const { res: res3 } = await guidelines("loud", wrong);
  expect(res3.code).toBe(1);
  expect(JSON.parse(res3.stdout).error).toContain("1280×720");
  expect(JSON.parse(res3.stdout).error).toContain("400×300");

  // Missing Composition.
  const { res: res4 } = await guidelines("no-such-comp", good);
  expect(res4.code).toBe(1);
  expect(JSON.parse(res4.stdout).error).toContain("no-such-comp");

  // Missing region file.
  const { res: res5 } = await guidelines("loud", path.join(tempDir, "gone.json"));
  expect(res5.code).toBe(1);
  expect(JSON.parse(res5.stdout).error).toContain("gone.json");
});

test("usage errors exit 2 with guidance", async () => {
  await makeComp("usage");
  const file = await writeRegionFile("u.json", regionFileBody([region("r", { x: 0, y: 0, width: 10, height: 10 })]));

  // Missing --regions.
  const noFlag = await invoke(["composition", "guidelines", "usage", "--project", projDir, "--json"]);
  expect(noFlag.code).toBe(2);
  expect(JSON.parse(noFlag.stdout).error).toContain("--regions");

  // Missing composition argument.
  const noComp = await invoke(["composition", "guidelines", "--regions", file, "--project", projDir, "--json"]);
  expect(noComp.code).toBe(2);
  expect(JSON.parse(noComp.stdout).error).toContain("Usage: ply composition guidelines");

  // Blank --regions value.
  const blank = await invoke(["composition", "guidelines", "usage", "--regions", " ", "--project", projDir, "--json"]);
  expect(blank.code).toBe(2);
});

test("compact text by default and valid JSON under --json", async () => {
  const img = path.join(tempDir, "bg.png");
  await writeFile(img, solidPng(400, 300, RED));
  await makeComp("shape");
  await addImageLayer("shape", "bg", img, { x: 0, y: 0 });
  const regions = await writeRegionFile("shape.json", regionFileBody([
    region("corner-box", { x: 250, y: 180, width: 80, height: 50 }, "duration badge", "the platform pins a badge here"),
  ]));

  const text = await invoke(["composition", "guidelines", "shape", "--regions", regions, "--project", projDir]);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain('Guideline view for Composition "shape"');
  expect(text.stdout).toContain("400×300");
  expect(text.stdout).toContain("1 caller-supplied region");
  expect(text.stdout).toContain("review artifact");
  expect(text.stdout).not.toContain('"ok"');

  const { json } = await guidelines("shape", regions);
  expect(json.ok).toBe(true);
  expect(json.composition).toBe("shape");
  expect(json.canvas).toEqual({ width: 400, height: 300 });
  expect(json.regionCount).toBe(1);
  expect(json.output.endsWith(".guidelines.png")).toBe(true);
  expect(path.dirname(json.output)).toBe(path.join(projDir, "guidelines"));
});

test("composition --help documents the guidelines command", async () => {
  const help = await invoke(["composition", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("guidelines <comp>");
  expect(help.stdout).toContain("--regions");
});

test("the guideline view completes with every browser network route aborted (offline evidence)", async () => {
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
    const { renderCompositionGuidelines } = await import("../src/composition-guidelines.js");
    const result = await renderCompositionGuidelines(projDir, "offline", regions, {
      page,
      out: path.join(tempDir, "offline-view.png"),
    });
    expect(result.regionCount).toBe(1);
    expect(decodePng(await readFile(result.output)).width).toBe(400);
  } finally {
    await ctx.close();
    await closeBrowser();
  }
});
test("a deleted recorded output does not veto unrelated targets, but an unreadable history manifest still vetoes (narrowed fail-closed)", async () => {
  const img = path.join(tempDir, "bg.png");
  await writeFile(img, solidPng(64, 64, RED));
  await makeComp("decay");
  await addImageLayer("decay", "bg", img, { x: 0, y: 0 });
  const regions = await writeRegionFile("d.json", regionFileBody([region("r", { x: 0, y: 0, width: 10, height: 10 })]));

  // An external export the caller later deletes is routine; its stale
  // record must not veto an unrelated fresh target.
  const doomed = path.join(tempDir, "doomed", "kept.png");
  await mkdir(path.dirname(doomed), { recursive: true });
  await render("decay", ["--out", doomed]);
  await rm(doomed);
  const unrelated = path.join(tempDir, "unrelated", "view.png");
  await mkdir(path.dirname(unrelated), { recursive: true });
  const { res } = await guidelines("decay", regions, ["--out", unrelated]);
  expect(res.code).toBe(0);
  expect((await readFile(unrelated)).length).toBeGreaterThan(0);

  // The stale record still names its own path: a write to that exact path
  // is refused (lexical comparison when the recorded file is gone).
  const res2 = await invoke(["composition", "guidelines", "decay", "--regions", regions, "--out", doomed, "--project", projDir, "--json"]);
  expect(res2.code).toBe(1);
  expect(JSON.parse(res2.stdout).ok).toBe(false);
  expect(JSON.parse(res2.stdout).error).toContain(".manifest.json");

  // An unreadable history manifest cannot prove any target unrecorded: it
  // vetoes, naming the manifest and suggesting --out.
  await writeFile(path.join(projDir, "renders", "corrupt.manifest.json"), "{ not json");
  const blocked = path.join(tempDir, "elsewhere2", "view.png");
  await mkdir(path.dirname(blocked), { recursive: true });
  const res3 = await invoke(["composition", "guidelines", "decay", "--regions", regions, "--out", blocked, "--project", projDir, "--json"]);
  expect(res3.code).toBe(1);
  const out3 = JSON.parse(res3.stdout);
  expect(out3.ok).toBe(false);
  expect(out3.error).toContain("corrupt.manifest.json");
  expect(out3.error).toContain("--out");
});

test("label and reason callouts stay fully inside the canvas for thin and edge regions — measured in the browser page", async () => {
  // The canonical YouTube geometry plus hostile shapes: a 16px strip at the
  // canvas bottom edge (the progress bar), the duration badge, a top-edge
  // sliver, a tiny box, and a full-canvas box.
  const cw = 1280, ch = 720;
  const regions = [
    region("duration-badge", { x: 1120, y: 650, width: 160, height: 70 }, "duration badge",
      "the platform pins the video duration over this corner"),
    region("progress-strip", { x: 0, y: 704, width: 1280, height: 16 }, "progress strip",
      "the platform draws the watched-progress bar across this strip"),
    region("top-edge", { x: 0, y: 0, width: 200, height: 12 }, "top edge", "a banner pinned along the top edge"),
    region("tiny", { x: 600, y: 350, width: 30, height: 20 }, "tiny", "a very small protected area"),
    region("whole", { x: 0, y: 0, width: 1280, height: 720 }, "whole canvas", "covers everything"),
  ];
  const html = guidelinePageHtml({ width: cw, height: ch }, [], regions);

  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: cw, height: ch }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    await placeRegionCallouts(page);
    const rects = await page.evaluate(() => {
      return Array.from(document.querySelectorAll<HTMLElement>(".ply-region-guide-callout")).map((el) => {
        const label = el.querySelector<HTMLElement>(".ply-region-guide-label")!.getBoundingClientRect();
        const reason = el.querySelector<HTMLElement>(".ply-region-guide-reason")!.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        return {
          box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
          label: { left: label.left, top: label.top, right: label.right, bottom: label.bottom },
          reason: { left: reason.left, top: reason.top, right: reason.right, bottom: reason.bottom },
        };
      });
    });
    expect(rects).toHaveLength(regions.length);
    for (const r of rects) {
      // The callout and both text lines sit fully inside the canvas — for
      // the bottom strip this is the acceptance bar text-inside-the-box
      // could never meet.
      expect(r.box.left).toBeGreaterThanOrEqual(0);
      expect(r.box.top).toBeGreaterThanOrEqual(0);
      expect(r.box.right).toBeLessThanOrEqual(cw);
      expect(r.box.bottom).toBeLessThanOrEqual(ch);
      expect(r.label.bottom).toBeLessThanOrEqual(ch);
      expect(r.reason.bottom).toBeLessThanOrEqual(ch);
      expect(r.label.right).toBeLessThanOrEqual(cw);
      expect(r.reason.right).toBeLessThanOrEqual(cw);
      // The text is not clipped by its own container.
      expect(r.label.bottom).toBeLessThanOrEqual(r.box.bottom + 0.5);
      expect(r.reason.bottom).toBeLessThanOrEqual(r.box.bottom + 0.5);
    }
  } finally {
    await ctx.close();
    await closeBrowser();
  }
});
