/**
 * Render history capture and replay (#87, spec #77 US-007 / US-008 / US-006, DEC-001–006).
 *
 * Slice 1 — capture: every successful `ply composition render` returns a
 * retained Project-owned manifest regardless of PNG export destination.
 * The manifest pins the exact ordered Layer revisions, canvas, content, and
 * rendering-environment identity from the same resolved inputs used to
 * produce the Render; it is independent of later current-state edits.
 *
 * Slice 2 — replay: `ply composition replay` regenerates byte-identical
 * output from pinned revisions and retained bytes only — never current Layer
 * pointers or the current Composition document — after edits, removals,
 * relocation, and external source deletion.
 *
 * Slice 3 — failure boundaries and concurrency: missing/corrupted/malformed
 * history fails loudly with no published output; environment mismatch is
 * rejected before output; concurrent current-state mutation between snapshot
 * and publication cannot mix revisions into a captured manifest
 * (deterministic --preload signal-file handshakes, no sleeps).
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir, unlink, rename, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodePngRgba, readPngHeader, decodePng } from "../src/png.js";
import { replayRender } from "../src/composition-render.js";
import { getBrowser, closeBrowser } from "../src/browser.js";

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
const GREEN: [number, number, number, number] = [0, 255, 0, 255];

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-render-history-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "history-proj"]);
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

interface RenderInvocation {
  json: { ok: boolean; render?: { output: string; manifest: string; name: string; width: number; height: number }; error?: string };
  code: number;
}

/** Render a composition through the public CLI and return its parsed JSON. */
async function renderJson(name: string, extra: string[] = []) {
  const res = await invoke(["composition", "render", name, "--project", projDir, "--json", ...extra]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(true);
  return json as RenderInvocation["json"];
}

/** The single manifest stored under the Project's renders/ directory. */
async function readSoleManifest(): Promise<Record<string, any>> {
  const entries = await readdir(path.join(projDir, "renders"));
  const manifests = entries.filter((f) => f.endsWith(".manifest.json"));
  expect(manifests).toHaveLength(1);
  return JSON.parse(await readFile(path.join(projDir, "renders", manifests[0]!), "utf8"));
}

// ---------------------------------------------------------------------------
// Slice 1 — capture
// ---------------------------------------------------------------------------

test("default render captures a manifest beside the PNG pinning revisions, canvas, and environment", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(64, 64, RED));
  await invoke(["composition", "create", "poster", "--width", "128", "--height", "64", "--project", projDir]);
  const add = await invoke(["composition", "add", "poster", "bg", "--image", img, "--project", projDir, "--json"]);
  const layerId = JSON.parse(add.stdout).use.layerId as string;
  const inspect = await invoke(["composition", "inspect", "poster", "--project", projDir, "--json"]);
  const revId = JSON.parse(inspect.stdout).composition.layers[0].revision.revisionId as string;

  const { json } = { json: (await renderJson("poster")).render! };
  // The PNG and the manifest are both Project-owned render history. The
  // command result reports filesystem paths; the manifest records the
  // project-relative informational form.
  expect(json.output).toMatch(/\/renders\/poster-.+\.png$/);
  expect(json.manifest).toMatch(/\/renders\/poster-.+\.manifest\.json$/);
  expect(path.basename(json.manifest, ".manifest.json")).toBe(path.basename(json.output, ".png"));
  const png = await readFile(json.output);
  expect(readPngHeader(png).width).toBe(128);

  const manifest = JSON.parse(await readFile(json.manifest, "utf8"));
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.composition).toBe("poster");
  expect(manifest.canvas).toEqual({ width: 128, height: 64 });
  expect(manifest.layers).toEqual([{ name: "bg", layerId, revisionId: revId }]);
  // Environment identity: tool, runtime, browser, platform — all captured.
  expect(manifest.environment.tool.name).toBe("ply");
  expect(typeof manifest.environment.tool.version).toBe("string");
  expect(manifest.environment.runtime).toMatch(/^bun /);
  expect(typeof manifest.environment.browser).toBe("string");
  expect(manifest.environment.browser.length).toBeGreaterThan(0);
  expect(typeof manifest.environment.platform).toBe("string");
  expect(manifest.environment.platform).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  // `output` is informational, project-relative, never an absolute path; the
  // createdAt timestamp is canonical ISO.
  expect(manifest.output).toMatch(/^renders\/poster-.+\.png$/);
  expect(new Date(manifest.createdAt).toISOString()).toBe(manifest.createdAt);
  expect(new Date(manifest.createdAt).toISOString()).toBe(manifest.createdAt);
});

test("external --out render still captures a Project-owned manifest in renders/", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(64, 64, RED));
  await invoke(["composition", "create", "exported", "--width", "64", "--height", "64", "--project", projDir]);
  await invoke(["composition", "add", "exported", "bg", "--image", img, "--project", projDir]);

  const out = path.join(tempDir, "elsewhere", "out.png");
  await mkdir(path.dirname(out), { recursive: true });
  const { json } = { json: (await renderJson("exported", ["--out", out])).render! };
  expect(json.output).toBe(out);
  await readFile(out); // the exported PNG exists

  // History stays inside the Project's renders/; the external path is
  // informational only and never required for replay.
  const entries = await readdir(path.join(projDir, "renders"));
  expect(entries.filter((f) => f.endsWith(".png"))).toHaveLength(0);
  expect(entries.filter((f) => f.endsWith(".manifest.json"))).toHaveLength(1);
  const manifest = JSON.parse(await readFile(path.join(projDir, "renders", entries.find((f) => f.endsWith(".manifest.json"))!), "utf8"));
  expect(manifest.composition).toBe("exported");
  expect(manifest.layers).toHaveLength(1);
  // The external destination is recorded informationally, never as a
  // replay-required input.
  expect(manifest.output).toBe(out);
});

test("in-project --out render captures its manifest alongside the exported PNG", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(64, 64, RED));
  await invoke(["composition", "create", "inproj", "--width", "64", "--height", "64", "--project", projDir]);
  await invoke(["composition", "add", "inproj", "bg", "--image", img, "--project", projDir]);

  const out = path.join(projDir, "exports", "kept.png");
  await mkdir(path.dirname(out), { recursive: true });
  const { json } = { json: (await renderJson("inproj", ["--out", out])).render! };
  expect(json.output).toBe(out);
  await readFile(out);
  const manifest = JSON.parse(await readFile(json.manifest, "utf8"));
  expect(manifest.composition).toBe("inproj");
});

test("capture pins the render-time revisions: later in-place edits do not change the manifest", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(64, 64, RED));
  await invoke(["composition", "create", "pinned", "--width", "64", "--height", "64", "--project", projDir]);
  const add = await invoke(["composition", "add", "pinned", "bg", "--image", img, "--project", projDir, "--json"]);
  const layerId = JSON.parse(add.stdout).use.layerId as string;

  const { json } = { json: (await renderJson("pinned")).render! };
  const before = JSON.parse(await readFile(json.manifest, "utf8"));

  // Advance the Layer and change the Composition after the render.
  const green = path.join(tempDir, "green.png");
  await writeFile(green, solidPng(64, 64, GREEN));
  const edit = await invoke(["layer", "edit", layerId, "--image", green, "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);
  await invoke(["composition", "reorder", "pinned", "--order", "bg", "--project", projDir]);

  const after = JSON.parse(await readFile(json.manifest, "utf8"));
  expect(after).toEqual(before);
  expect(after.layers[0].layerId).toBe(layerId);
});

test("capture covers text Layers with their pinned revisions and font content identity", async () => {
  await invoke(["composition", "create", "texted", "--width", "200", "--height", "100", "--project", projDir]);
  await invoke(["composition", "add", "texted", "headline", "--text", "Hello", "--font", "Anton", "--project", projDir]);
  const inspect = await invoke(["composition", "inspect", "texted", "--project", projDir, "--json"]);
  const layer = JSON.parse(inspect.stdout).composition.layers[0];
  expect(layer.kind).toBe("text");

  const { json } = { json: (await renderJson("texted")).render! };
  const manifest = JSON.parse(await readFile(json.manifest, "utf8"));
  expect(manifest.layers).toEqual([
    { name: "headline", layerId: layer.layerId, revisionId: layer.revision.revisionId },
  ]);
});

test("default compact text output stays one actionable line and names the manifest", async () => {
  const img = path.join(tempDir, "red.png");
  await writeFile(img, solidPng(64, 64, RED));
  await invoke(["composition", "create", "tiny", "--width", "64", "--height", "64", "--project", projDir]);
  await invoke(["composition", "add", "tiny", "bg", "--image", img, "--project", projDir]);
  const res = await invoke(["composition", "render", "tiny", "--project", projDir]);
  expect(res.code).toBe(0);
  const lines = res.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("tiny");
  expect(lines[0]).toContain("64×64");
  expect(lines[0]).toContain(".png");
  expect(lines[0]).toContain(".manifest.json");
});
// ---------------------------------------------------------------------------
// Slice 2 — replay
// ---------------------------------------------------------------------------

/** Build a mixed image+text Composition and render it; return ids and the PNG bytes. */
async function setupHistoryFixture(): Promise<{
  manifestPath: string;
  originalPng: Buffer;
  imageLayerId: string;
  textLayerId: string;
  sourceImage: string;
}> {
  const sourceImage = path.join(tempDir, "sources", "red.png");
  await mkdir(path.dirname(sourceImage), { recursive: true });
  await writeFile(sourceImage, solidPng(64, 64, RED));
  await invoke(["composition", "create", "hist", "--width", "200", "--height", "100", "--project", projDir]);
  const imgAdd = await invoke(["composition", "add", "hist", "badge", "--image", sourceImage, "--x", "10", "--y", "10", "--project", projDir, "--json"]);
  expect(imgAdd.code).toBe(0);
  const textAdd = await invoke(["composition", "add", "hist", "headline", "--text", "Hello", "--font", "Anton", "--x", "80", "--y", "30", "--project", projDir, "--json"]);
  expect(textAdd.code).toBe(0);
  const { json } = { json: (await renderJson("hist")).render! };
  return {
    manifestPath: json.manifest,
    originalPng: await readFile(json.output),
    imageLayerId: JSON.parse(imgAdd.stdout).use.layerId,
    textLayerId: JSON.parse(textAdd.stdout).use.layerId,
    sourceImage,
  };
}

/** Replay a manifest through the public CLI; returns JSON + replay output bytes. */
async function replayJson(manifestPath: string, extra: string[] = []) {
  const res = await invoke(["composition", "replay", manifestPath, "--project", projDir, "--json", ...extra]);
  return { res, json: res.stdout ? JSON.parse(res.stdout) : {} };
}

test("replay regenerates byte-identical output from pinned history", async () => {
  const fx = await setupHistoryFixture();
  const { res, json } = await replayJson(fx.manifestPath);
  expect(res.code).toBe(0);
  expect(json.ok).toBe(true);
  expect(json.replay.name).toBe("hist");
  const replayed = await readFile(json.replay.output);
  expect(replayed.equals(fx.originalPng)).toBe(true);
});

test("replay is byte-identical after in-place edits, use removal, and reordering", async () => {
  const fx = await setupHistoryFixture();

  // Advance both source Layers in place (new image bytes, new text).
  const green = path.join(tempDir, "sources", "green.png");
  await writeFile(green, solidPng(64, 64, GREEN));
  const edit1 = await invoke(["layer", "edit", fx.imageLayerId, "--image", green, "--in-place", "--project", projDir, "--json"]);
  expect(edit1.code).toBe(0);
  const edit2 = await invoke(["layer", "edit", fx.textLayerId, "--text", "Changed", "--in-place", "--project", projDir, "--json"]);
  expect(edit2.code).toBe(0);

  // Remove the text use, then restore order changes on the current document.
  const rm = await invoke(["composition", "remove", "hist", "headline", "--project", projDir]);
  expect(rm.code).toBe(0);
  const readd = await invoke(["composition", "add", "hist", "footer", "--image", green, "--project", projDir]);
  expect(readd.code).toBe(0);

  const { res, json } = await replayJson(fx.manifestPath);
  expect(res.code).toBe(0);
  const replayed = await readFile(json.replay.output);
  expect(replayed.equals(fx.originalPng)).toBe(true);
});

test("replay depends on neither current Layer pointers nor the current Composition document", async () => {
  const fx = await setupHistoryFixture();

  // Advance sources so replay must use the pinned revision, then remove the
  // current-state documents replay must never consult.
  const green = path.join(tempDir, "sources", "green.png");
  await writeFile(green, solidPng(64, 64, GREEN));
  await invoke(["layer", "edit", fx.imageLayerId, "--image", green, "--in-place", "--project", projDir]);

  await unlink(path.join(projDir, "layers", `${fx.imageLayerId}.json`));
  await unlink(path.join(projDir, "layers", `${fx.textLayerId}.json`));
  await unlink(path.join(projDir, "compositions", "hist.json"));

  const { res, json } = await replayJson(fx.manifestPath);
  expect(res.code).toBe(0);
  const replayed = await readFile(json.replay.output);
  expect(replayed.equals(fx.originalPng)).toBe(true);
});

test("replay survives Project relocation and deletion of external source files", async () => {
  const fx = await setupHistoryFixture();
  const moved = path.join(tempDir, "relocated");
  await cp(projDir, moved, { recursive: true });
  // The original source file is gone and the Project moved elsewhere.
  await rm(path.dirname(fx.sourceImage), { recursive: true, force: true });

  const res = await invoke(["composition", "replay", path.join(moved, path.relative(projDir, fx.manifestPath)), "--project", moved, "--json"]);
  expect(res.code).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(true);
  const replayed = await readFile(json.replay.output);
  expect(replayed.equals(fx.originalPng)).toBe(true);
});

test("replay works when the original PNG is gone", async () => {
  const fx = await setupHistoryFixture();
  const { res, json } = await replayJson(fx.manifestPath);
  expect(res.code).toBe(0);
  // Delete the original output; a replayed replay must still regenerate it.
  const rmRes = await invoke(["composition", "replay", fx.manifestPath, "--project", projDir, "--json"]);
  expect(rmRes.code).toBe(0);
  const replayed = await readFile(JSON.parse(rmRes.stdout).replay.output);
  expect(replayed.equals(fx.originalPng)).toBe(true);
  expect(replayed.equals(await readFile(json.replay.output))).toBe(true);
});

test("replay honors --out with the same export policy and still retains history", async () => {
  const fx = await setupHistoryFixture();
  const out = path.join(tempDir, "replay-out.png");
  const { res, json } = await replayJson(fx.manifestPath, ["--out", out]);
  expect(res.code).toBe(0);
  expect(json.replay.output).toBe(out);
  expect((await readFile(out)).equals(fx.originalPng)).toBe(true);
  // The replayed render is itself retained history.
  const manifest = JSON.parse(await readFile(json.replay.manifest, "utf8"));
  expect(manifest.composition).toBe("hist");
  expect(manifest.layers).toHaveLength(2);
});

test("compact replay text is one actionable line; usage errors exit 2", async () => {
  const fx = await setupHistoryFixture();
  const res = await invoke(["composition", "replay", fx.manifestPath, "--project", projDir]);
  expect(res.code).toBe(0);
  const lines = res.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("hist");
  expect(lines[0]).toContain(".png");

  const usage = await invoke(["composition", "replay", "--project", projDir]);
  expect(usage.code).toBe(2);

  const help = await invoke(["composition", "--help"]);
  expect(help.stdout).toContain("replay");
});

// ---------------------------------------------------------------------------
// Slice 3 — failure boundaries, publication discipline, concurrent capture
// ---------------------------------------------------------------------------

const compositionCli = path.resolve(import.meta.dir, "../src/composition-cli.ts");
const lockModule = path.resolve(import.meta.dir, "../src/project-lock.ts");

/** Spawn the composition CLI directly with a --preload mock module applied. */
function invokePreloaded(preload: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, "--preload", preload, compositionCli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc;
}

async function waitForSignal(file: string, what: string): Promise<void> {
  for (;;) {
    try {
      await readFile(file);
      return;
    } catch {
      await Bun.sleep(10);
    }
  }
}

test("a missing render manifest fails loudly without publishing output", async () => {
  const before = (await readdir(path.join(projDir, "renders")).catch(() => [])).length;
  const { res } = await replayJson(path.join(projDir, "renders", "absent.manifest.json"));
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error).toContain("not found");
  expect((await readdir(path.join(projDir, "renders")).catch(() => [])).length).toBe(before);
});

test("a malformed render manifest fails with a field-specific error", async () => {
  await writeFile(path.join(projDir, "renders", "broken.manifest.json"), "{not json");
  const { res } = await replayJson(path.join(projDir, "renders", "broken.manifest.json"));
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error).toContain("Malformed render manifest");
});

test("an unsupported manifest schemaVersion is rejected, not replayed", async () => {
  const fx = await setupHistoryFixture();
  const m = JSON.parse(await readFile(fx.manifestPath, "utf8"));
  m.schemaVersion = 99;
  const p = path.join(projDir, "renders", "future.manifest.json");
  await writeFile(p, JSON.stringify(m, null, 2));
  const { res } = await replayJson(p);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error).toContain("schemaVersion");
});

test("pinned identifiers are validated before any filesystem path construction", async () => {
  const fx = await setupHistoryFixture();
  const m = JSON.parse(await readFile(fx.manifestPath, "utf8"));
  m.layers[0].revisionId = "rev_../../evil";
  const p = path.join(projDir, "renders", "evil.manifest.json");
  await writeFile(p, JSON.stringify(m, null, 2));
  const { res } = await replayJson(p);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error).toContain("not a valid revision id");
  // The evil path never escaped: nothing under the project tree changed.
  expect(await readdir(path.join(projDir, "renders"))).not.toContain("evil");
});

test("a manifest outside the Project is refused — history is Project-owned", async () => {
  const fx = await setupHistoryFixture();
  const outside = path.join(tempDir, "copied.manifest.json");
  await writeFile(outside, await readFile(fx.manifestPath, "utf8"));
  const { res } = await replayJson(outside);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error).toContain("outside the project");
});

test("a missing pinned historical revision fails and never resolves current content", async () => {
  const fx = await setupHistoryFixture();
  const m = JSON.parse(await readFile(fx.manifestPath, "utf8"));
  const entry = m.layers[0];
  await unlink(path.join(projDir, "layers", `${entry.layerId}.revisions`, `${entry.revisionId}.json`));
  const { res } = await replayJson(fx.manifestPath);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error).toContain(entry.revisionId);
});

test("a corrupted pinned revision document fails the revision-hash check", async () => {
  const fx = await setupHistoryFixture();
  const m = JSON.parse(await readFile(fx.manifestPath, "utf8"));
  const entry = m.layers[0];
  const revFile = path.join(projDir, "layers", `${entry.layerId}.revisions`, `${entry.revisionId}.json`);
  const rev = JSON.parse(await readFile(revFile, "utf8"));
  rev.x = 1234; // contents no longer hash to the pinned revision id
  await writeFile(revFile, JSON.stringify(rev, null, 2));
  const { res } = await replayJson(fx.manifestPath);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error).toContain("Corrupted revision document");
});

test("a missing pinned content blob fails loudly", async () => {
  const fx = await setupHistoryFixture();
  const m = JSON.parse(await readFile(fx.manifestPath, "utf8"));
  const entry = m.layers[0];
  const revFile = path.join(projDir, "layers", `${entry.layerId}.revisions`, `${entry.revisionId}.json`);
  const rev = JSON.parse(await readFile(revFile, "utf8"));
  await unlink(path.join(projDir, "content", rev.contentHash));
  const { res } = await replayJson(fx.manifestPath);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error).toContain("missing in project");
});

test("a corrupted retained content blob fails identity verification instead of resolving substitute bytes", async () => {
  const fx = await setupHistoryFixture();
  const m = JSON.parse(await readFile(fx.manifestPath, "utf8"));
  const entry = m.layers[0];
  const revFile = path.join(projDir, "layers", `${entry.layerId}.revisions`, `${entry.revisionId}.json`);
  const rev = JSON.parse(await readFile(revFile, "utf8"));
  await writeFile(path.join(projDir, "content", rev.contentHash), Buffer.from("garbage bytes"));
  const { res } = await replayJson(fx.manifestPath);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error).toContain("Corrupted content blob");
});

test("an unsupported rendering environment is rejected before any output", async () => {
  const fx = await setupHistoryFixture();
  const m = JSON.parse(await readFile(fx.manifestPath, "utf8"));
  m.environment.browser = "chromium 1.2.3-not-the-real-browser";
  const p = path.join(projDir, "renders", "foreign-env.manifest.json");
  await writeFile(p, JSON.stringify(m, null, 2));
  const before = (await readdir(path.join(projDir, "renders"))).length;
  const { res } = await replayJson(p);
  expect(res.code).toBe(1);
  expect(JSON.parse(res.stdout).error).toContain("environment mismatch");
  expect((await readdir(path.join(projDir, "renders"))).length).toBe(before);
});

test("replay works when the original PNG is gone", async () => {
  const fx = await setupHistoryFixture();
  await rm(fx.manifestPath.replace(/\.manifest\.json$/, ".png"));
  const { res, json } = await replayJson(fx.manifestPath);
  expect(res.code).toBe(0);
  const replayed = await readFile(json.replay.output);
  expect(replayed.equals(fx.originalPng)).toBe(true);
});

test("unknown commands list replay in the available surface", async () => {
  const res = await invoke(["composition", "nonsense", "--project", projDir]);
  expect(res.code).toBe(2);
  expect(res.stderr).toContain("replay");
});

test("concurrent capture cannot mix current-state revisions into a published snapshot", async () => {
  const fx = await setupHistoryFixture();
  const inspect0 = JSON.parse((await invoke(["layer", "inspect", fx.imageLayerId, "--project", projDir, "--json"])).stdout);
  const rev1 = inspect0.layer.currentRevision.revisionId as string;

  const signals = path.join(tempDir, "signals");
  await mkdir(signals, { recursive: true });
  const snapshotReleased = path.join(signals, "snapshot-released");
  const gate = path.join(signals, "edit-committed");

  // Render-process preload: after the locked snapshot is resolved and the
  // lock released, signal and hold until the test's edit has committed.
  const preload = path.join(tempDir, "render-gate.ts");
  await writeFile(
    preload,
    `
    import { mock } from "bun:test";
    import * as lock from ${JSON.stringify(lockModule)};
    const original = { ...lock };
    mock.module(${JSON.stringify(lockModule)}, () => ({
      ...original,
      withProjectLock: async (root: string, fn: () => Promise<unknown>) => {
        const result = await original.withProjectLock(root, fn);
        const { writeFile } = await import("node:fs/promises");
        await writeFile(${JSON.stringify(snapshotReleased)}, "1");
        const { existsSync } = await import("node:fs");
        while (!existsSync(${JSON.stringify(gate)})) {
          await new Promise((r) => setTimeout(r, 20));
        }
        return result;
      },
    }));
    `,
  );

  const proc = invokePreloaded(preload, ["render", "hist", "--project", projDir, "--json"]);
  await waitForSignal(snapshotReleased, "render snapshot released");

  // Deterministically commit a current-state revision advance while the
  // render holds no lock but has not yet published.
  const green = path.join(tempDir, "sources", "green.png");
  await writeFile(green, solidPng(64, 64, GREEN));
  const edit = await invoke(["layer", "edit", fx.imageLayerId, "--image", green, "--in-place", "--project", projDir, "--json"]);
  expect(edit.code).toBe(0);
  await writeFile(gate, "1");

  expect(await proc.exited).toBe(0);
  const json = JSON.parse(await new Response(proc.stdout).text());
  expect(json.ok).toBe(true);

  // The published manifest pins the pre-edit revision, and the published PNG
  // shows the pre-edit pixels — even though the current revision advanced
  // before publication.
  const manifest = JSON.parse(await readFile(json.render.manifest, "utf8"));
  expect(manifest.layers[0].revisionId).toBe(rev1);
  const decoded = decodePng(await readFile(json.render.output));
  // Pixel (30, 30) sits inside the image Layer's 64×64 span at (10, 10) —
  // red under the pinned revision, green under the concurrent edit.
  const mid = (30 * decoded.width + 30) * 4;
  expect(decoded.rgba[mid]!).toBe(255);
  expect(decoded.rgba[mid + 1]!).toBe(0);

  const inspect1 = JSON.parse((await invoke(["layer", "inspect", fx.imageLayerId, "--project", projDir, "--json"])).stdout);
  expect(inspect1.layer.currentRevision.revisionId).not.toBe(rev1);

  // And the retained history still replays byte-identically to that snapshot.
  const replayed = await replayJson(json.render.manifest);
  expect(replayed.res.code).toBe(0);
  expect((await readFile(replayed.json.replay.output)).equals(await readFile(json.render.output))).toBe(true);
});

test("injected manifest-publication failure publishes no PNG and no orphan history", async () => {
  await setupHistoryFixture();
  await rm(path.join(projDir, "renders"), { recursive: true, force: true });
  await mkdir(path.join(projDir, "renders"));

  const preload = path.join(tempDir, "manifest-fail.ts");
  await writeFile(
    preload,
    `
    import { mock } from "bun:test";
    import * as lock from ${JSON.stringify(lockModule)};
    const original = { ...lock };
    mock.module(${JSON.stringify(lockModule)}, () => ({
      ...original,
      atomicCreate: async (file: string, content: Buffer | string) => {
        if (file.endsWith(".manifest.json")) {
          throw new Error("injected manifest publication failure");
        }
        return original.atomicCreate(file, content);
      },
    }));
    `,
  );

  const proc = invokePreloaded(preload, ["render", "hist", "--project", projDir, "--json"]);
  expect(await proc.exited).toBe(1);
  const out = JSON.parse(await new Response(proc.stdout).text());
  expect(out.ok).toBe(false);
  expect(out.error).toContain("injected manifest publication failure");
  // No PNG and no orphan manifest: nothing was published.
  expect(await readdir(path.join(projDir, "renders"))).toEqual([]);
});

test("injected output-publication failure cleans the freshly created manifest", async () => {
  await setupHistoryFixture();
  await rm(path.join(projDir, "renders"), { recursive: true, force: true });
  await mkdir(path.join(projDir, "renders"));

  const preload = path.join(tempDir, "png-fail.ts");
  await writeFile(
    preload,
    `
    import { mock } from "bun:test";
    import * as lock from ${JSON.stringify(lockModule)};
    const original = { ...lock };
    mock.module(${JSON.stringify(lockModule)}, () => ({
      ...original,
      atomicCreate: async (file: string, content: Buffer | string) => {
        if (file.endsWith(".png")) {
          throw new Error("injected output publication failure");
        }
        return original.atomicCreate(file, content);
      },
    }));
    `,
  );

  const proc = invokePreloaded(preload, ["render", "hist", "--project", projDir, "--json"]);
  expect(await proc.exited).toBe(1);
  const out = JSON.parse(await new Response(proc.stdout).text());
  expect(out.ok).toBe(false);
  // The freshly created manifest was removed; nothing preexisting was touched.
  expect(await readdir(path.join(projDir, "renders"))).toEqual([]);
});

test("injected external-export failure cleans owned history and leaves the external file untouched", async () => {
  await setupHistoryFixture();
  await rm(path.join(projDir, "renders"), { recursive: true, force: true });
  await mkdir(path.join(projDir, "renders"));
  const external = path.join(tempDir, "external-out.png");
  const originalBytes = solidPng(8, 8, GREEN);
  await writeFile(external, originalBytes);

  const preload = path.join(tempDir, "replace-fail.ts");
  await writeFile(
    preload,
    `
    import { mock } from "bun:test";
    import * as lock from ${JSON.stringify(lockModule)};
    const original = { ...lock };
    mock.module(${JSON.stringify(lockModule)}, () => ({
      ...original,
      atomicReplace: async () => {
        throw new Error("injected external export failure");
      },
    }));
    `,
  );

  const proc = invokePreloaded(preload, ["render", "hist", "--project", projDir, "--out", external, "--json"]);
  expect(await proc.exited).toBe(1);
  const out = JSON.parse(await new Response(proc.stdout).text());
  expect(out.ok).toBe(false);
  expect((await readFile(external)).equals(originalBytes)).toBe(true);
  expect((await readdir(path.join(projDir, "renders"))).filter((f) => f.endsWith(".manifest.json"))).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Limited offline evidence (#87 owns its commands' US-006 partition; #88 owns
// full OS-level CLI isolation). Replay resolves retained bytes locally and
// paints embedded data URLs; this probe renders a replay with every browser
// network route aborted — evidence that the replay path issues no requests,
// not a claim of full CLI offline qualification.
// ---------------------------------------------------------------------------
test("replay completes with every browser network route aborted", async () => {
  const fx = await setupHistoryFixture();
  const browser = await getBrowser();
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  await ctx.route("**/*", (route) => route.abort());
  const page = await ctx.newPage();
  try {
    const result = await replayRender(projDir, fx.manifestPath, { page });
    expect((await readFile(result.output)).equals(fx.originalPng)).toBe(true);
  } finally {
    await ctx.close();
    await closeBrowser();
  }
});
