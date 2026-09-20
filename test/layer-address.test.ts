/**
 * Layer name addressing (spec #226 US-003, TEST-005 — CLI seam).
 *
 * Verifies:
 * - Every id-accepting command (layer edit, layer inspect, layer review)
 *   gives the same result for a <composition>/<use> address as for the
 *   Layer id it resolves to.
 * - An unknown Composition or use is refused (exit 1) listing what exists;
 *   nothing is published.
 * - A malformed address is refused as a usage error (exit 2).
 * - A name address to a shared Layer still requires --in-place or --fork;
 *   with --fork the address supplies the Composition and use, so they are
 *   not repeated, and explicit flags conflicting with the address refuse.
 * - A Layer id continues to work everywhere.
 * - Help documents the address form.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePngRgba } from "../src/png.js";

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

function json(result: { stdout: string }): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgba[0];
    buf[i + 1] = rgba[1];
    buf[i + 2] = rgba[2];
    buf[i + 3] = rgba[3];
  }
  return encodePngRgba(width, height, buf);
}

const RED: [number, number, number, number] = [255, 0, 0, 255];

let tempDir: string;
let projDir: string;
let imageFile: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-layer-address-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "address-test-proj"]);
  imageFile = path.join(tempDir, "red.png");
  await writeFile(imageFile, solidPng(40, 30, RED));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

/** One Composition with one image Layer use. Returns { comp, use, layerId }. */
async function makeCompWithImage(name: string, useName = "banner") {
  await invoke([
    "composition", "create", name, "--width", "200", "--height", "150",
    "--project", projDir, "--json",
  ]);
  const add = json(await invoke([
    "composition", "add", name, useName, "--image", imageFile,
    "--x", "10", "--y", "20", "--project", projDir, "--json",
  ])) as { use: { layerId: string } };
  return { comp: name, use: useName, layerId: add.use.layerId };
}

test("layer inspect accepts a composition/use address and returns the same result as the Layer id", async () => {
  const { comp, use, layerId } = await makeCompWithImage("poster", "headline");
  const byId = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  const byAddress = await invoke(["layer", "inspect", `${comp}/${use}`, "--project", projDir, "--json"]);
  expect(byId.code).toBe(0);
  expect(byAddress.code).toBe(0);
  expect(json(byAddress)).toEqual(json(byId));
});

test("layer edit by address publishes the same edit as by id", async () => {
  // Two identically built Layers: one edited by id, one by address.
  const a = await makeCompWithImage("comp-a", "banner");
  const b = await makeCompWithImage("comp-b", "banner");
  const byId = json(await invoke([
    "layer", "edit", a.layerId, "--x", "55", "--project", projDir, "--json",
  ])) as { layer: { currentRevision: { x: number; y: number } } };
  const byAddress = json(await invoke([
    "layer", "edit", `${b.comp}/${b.use}`, "--x", "55", "--project", projDir, "--json",
  ])) as { layer: { currentRevision: { x: number; y: number } } };
  expect(byAddress.layer.currentRevision.x).toBe(55);
  // The two edits publish equivalent revisions (modulo the independent
  // identities and timestamps the publication protocol stamps).
  const stripMutable = (rev: Record<string, unknown>) => ({
    ...rev,
    revisionId: undefined,
    layerId: undefined,
    createdAt: undefined,
  });
  expect(stripMutable(byAddress.layer.currentRevision as Record<string, unknown>)).toEqual(
    stripMutable(byId.layer.currentRevision as Record<string, unknown>),
  );
});

test("layer review by address writes the same sheet as by id", async () => {
  // A Layer with retained evidence (offline fake provider — no network,
  // nothing billed), so the review sheet is a real artifact.
  const { comp, use, layerId } = await makeGeneratedLayer("poster", "photo");
  const outId = path.join(tempDir, "review-id.html");
  const outAddr = path.join(tempDir, "review-address.html");
  const byId = await invoke(["layer", "review", layerId, "--out", outId, "--project", projDir, "--json"]);
  const byAddress = await invoke(["layer", "review", `${comp}/${use}`, "--out", outAddr, "--project", projDir, "--json"]);
  expect(byId.code).toBe(0);
  expect(byAddress.code).toBe(0);
  const idHtml = await readFile(outId, "utf8");
  const addrHtml = await readFile(outAddr, "utf8");
  // The sheet embeds the wall-clock review time; everything else is identical.
  const stripStamp = (html: string) => html.replace(/reviewed [^<\s]+/, "reviewed <stamp>");
  expect(stripStamp(addrHtml)).toBe(stripStamp(idHtml));
});

/** One Composition with one generated-content image Layer use, built through
 * the library functions with a deterministic fake provider (offline, never
 * billed). Returns { comp, use, layerId }. */
async function makeGeneratedLayer(name: string, useName = "photo") {
  const { createComposition, addGeneratedLayerToComposition } = await import("../src/composition.js");
  const { runUniformGeneration } = await import("../src/generation.js");
  const { DEFAULT_MODEL } = await import("../src/models.js");
  const { encodePng } = await import("./png.js");
  await createComposition(projDir, name, { width: 200, height: 150 });
  const jobsRoot = path.join(tempDir, "out", "generation");
  const bytes = encodePng(24, 24, () => [180, 60, 30, 255]);
  const provider = {
    image: async () => ({ images: [{ base64: bytes.toString("base64") }], warnings: [] }),
    text: async () => ({ files: [{ mediaType: "image/png", uint8Array: bytes }], text: "", warnings: [] }),
  };
  const job = await runUniformGeneration(jobsRoot, "gen-addr-1", {
    prompt: "a solid swatch",
    intent: "full-canvas",
    model: DEFAULT_MODEL,
    count: 1,
  }, { provider });
  const result = await addGeneratedLayerToComposition(projDir, name, useName, {
    jobId: "gen-addr-1",
    output: job.run.outputs[0]!.contentHash,
    jobRoot: jobsRoot,
  }, { x: 10, y: 20 });
  return { comp: name, use: useName, layerId: result.use.layerId };
}

test("an unknown Composition in an address is refused listing what exists; nothing is published", async () => {
  const { comp, use } = await makeCompWithImage("poster", "headline");
  await invoke(["composition", "create", "other", "--width", "100", "--height", "100", "--project", projDir, "--json"]);
  const before = json(await invoke(["layer", "inspect", `${comp}/${use}`, "--project", projDir, "--json"])) as {
    layer: { currentRevisionId: string };
  };
  const res = await invoke(["layer", "edit", "missing-comp/headline", "--x", "5", "--project", projDir, "--json"]);
  expect(res.code).toBe(1);
  const body = json(res) as { ok: boolean; error: string };
  expect(body.ok).toBe(false);
  expect(body.error).toContain('"poster"');
  expect(body.error).toContain('"other"');
  // The refusing edit publishes nothing.
  const after = json(await invoke(["layer", "inspect", `${comp}/${use}`, "--project", projDir, "--json"])) as {
    layer: { currentRevisionId: string };
  };
  expect(after.layer.currentRevisionId).toBe(before.layer.currentRevisionId);
});

test("an unknown use in an address is refused listing the Composition's use names; nothing is published", async () => {
  const { comp, use, layerId } = await makeCompWithImage("poster", "headline");
  // A second use in the SAME Composition, so the listing has something to name.
  await invoke(["composition", "add", comp, "caption", "--image", imageFile, "--project", projDir, "--json"]);
  const before = json(await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])) as {
    layer: { currentRevisionId: string };
  };
  const res = await invoke(["layer", "edit", `${comp}/no-such-use`, "--x", "5", "--project", projDir, "--json"]);
  expect(res.code).toBe(1);
  const body = json(res) as { ok: boolean; error: string };
  expect(body.ok).toBe(false);
  expect(body.error).toContain(`Use "no-such-use" not found in composition "${comp}"`);
  expect(body.error).toContain('"headline"');
  expect(body.error).toContain('"caption"');
  const after = json(await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"])) as {
    layer: { currentRevisionId: string };
  };
  expect(after.layer.currentRevisionId).toBe(before.layer.currentRevisionId);
});

test("a malformed address is refused as a usage error", async () => {
  await makeCompWithImage("poster", "headline");
  for (const token of ["poster/headline/extra", "poster/", "/headline", "poster/h eadline"]) {
    const res = await invoke(["layer", "inspect", token, "--project", projDir, "--json"]);
    expect(res.code).toBe(2);
    expect((json(res) as { error: string }).error).toContain("address");
  }
});

test("a name address to a shared Layer still requires --in-place or --fork", async () => {
  const { comp, use, layerId } = await makeCompWithImage("main", "banner");
  // Share the Layer into a second Composition.
  await invoke(["composition", "create", "mirror", "--width", "200", "--height", "150", "--project", projDir, "--json"]);
  await invoke(["composition", "import", "mirror", "main", "--project", projDir, "--json"]);
  const res = await invoke(["layer", "edit", `${comp}/${use}`, "--x", "30", "--project", projDir, "--json"]);
  expect(res.code).toBe(1);
  const body = json(res) as { error: string };
  expect(body.error).toContain(`Layer "${layerId}"`);
  expect(body.error).toContain('"main"');
  expect(body.error).toContain('"mirror"');
  expect(body.error).toContain("--in-place");
});

test("with --fork, the address supplies the Composition and use so they are not repeated", async () => {
  const { comp, use, layerId } = await makeCompWithImage("main", "banner");
  await invoke(["composition", "create", "mirror", "--width", "200", "--height", "150", "--project", projDir, "--json"]);
  await invoke(["composition", "import", "mirror", "main", "--project", projDir, "--json"]);
  const res = await invoke([
    "layer", "edit", `${comp}/${use}`, "--fork", "--x", "44", "--project", projDir, "--json",
  ]);
  expect(res.code).toBe(0);
  const body = json(res) as { ok: boolean; fork: { composition: string; use: string; previousLayerId: string }; layer: { id: string } };
  expect(body.ok).toBe(true);
  expect(body.fork.composition).toBe(comp);
  expect(body.fork.use).toBe(use);
  expect(body.fork.previousLayerId).toBe(layerId);
  // The fork retargets the use the address names (in "main"); the other
  // referring Composition keeps the original identity.
  const main = json(await invoke(["composition", "inspect", comp, "--project", projDir, "--json"])) as {
    composition: { layers: Array<{ name: string; layerId: string }> };
  };
  const mirror = json(await invoke(["composition", "inspect", "mirror", "--project", projDir, "--json"])) as {
    composition: { layers: Array<{ name: string; layerId: string }> };
  };
  expect(main.composition.layers.find((l) => l.name === use)!.layerId).not.toBe(layerId);
  expect(mirror.composition.layers.find((l) => l.name === use)!.layerId).toBe(layerId);
});

test("an explicit --composition/--use that conflicts with the address is refused", async () => {
  const { comp, use } = await makeCompWithImage("main", "banner");
  await invoke(["composition", "create", "other", "--width", "100", "--height", "100", "--project", projDir, "--json"]);
  const byComposition = await invoke([
    "layer", "edit", `${comp}/${use}`, "--fork", "--composition", "other", "--x", "5", "--project", projDir, "--json",
  ]);
  expect(byComposition.code).toBe(2);
  expect((json(byComposition) as { error: string }).error).toContain("conflicts");
  const byUse = await invoke([
    "layer", "edit", `${comp}/${use}`, "--fork", "--use", "other-use", "--x", "5", "--project", projDir, "--json",
  ]);
  expect(byUse.code).toBe(2);
  expect((json(byUse) as { error: string }).error).toContain("conflicts");
});

test("a Layer id continues to work everywhere the address works", async () => {
  const { layerId } = await makeCompWithImage("poster", "headline");
  const inspect = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(inspect.code).toBe(0);
  const edit = await invoke(["layer", "edit", layerId, "--x", "7", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);
});

test("help documents the address form", async () => {
  const help = await invoke(["layer", "--help"]);
  expect(help.code).toBe(0);
  const text = help.stdout;
  expect(text).toContain("<composition>/<use>");
  expect(text).toContain("address");
});

test("an address resolves through one boundary: downstream never sees it", async () => {
  const { comp, use, layerId } = await makeCompWithImage("poster", "headline");
  // The edit result by address must be identical in shape to the id result
  // (modulo the resolved layer facts) — no address fields leak into output.
  const byAddress = json(await invoke([
    "layer", "edit", `${comp}/${use}`, "--y", "33", "--project", projDir, "--json",
  ])) as { layer: { id: string }; referringCompositions: string[] };
  expect(byAddress.layer.id).toBe(layerId);
  expect(Object.keys(byAddress)).not.toContain("address");
  expect(JSON.stringify(byAddress)).not.toContain(`${comp}/`);
});