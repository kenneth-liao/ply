/**
 * Prerequisite-failure coverage for independent local Matting (spec #159
 * ticket #166, US-006 / TEST-003): missing weights, wrong sha-256, and
 * unavailable MPS each fail through the public Matting CLI with an
 * actionable diagnostic, leave the source byte-identical, and publish no
 * successful record.
 *
 * Weight-free by design: the missing/wrong cases drive the real production
 * engine (`localSegmentationMatteEngine`) against an isolated `PLY_MODEL_DIR`
 * that is empty or holds wrong bytes — preflight refuses before any Python
 * is launched. The unavailable-MPS case stubs only the process boundary:
 * the stub produces its error through the real `parseInferenceResult`, so
 * the CLI text/JSON assertions cover the production enrichment path
 * without requiring a real MPS failure on this machine. No test here loads
 * real weights or launches Python.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/matting-cli.js";
import {
  DYNAMIC_SEGMENTER,
  localSegmentationMatteEngine,
  parseInferenceResult,
  weightsPath,
} from "../src/segment.js";
import { opaqueSubject } from "./png.js";

const originalModelDir = process.env.PLY_MODEL_DIR;

let root: string;
let matteRoot: string;
let modelDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-matting-prereq-"));
  matteRoot = path.join(root, "matting");
  modelDir = path.join(root, "models");
  process.env.PLY_MODEL_DIR = modelDir;
});

afterEach(async () => {
  if (originalModelDir === undefined) delete process.env.PLY_MODEL_DIR;
  else process.env.PLY_MODEL_DIR = originalModelDir;
  await rm(root, { recursive: true, force: true });
});

const OPAQUE_SUBJECT = opaqueSubject();

async function publishedIds(): Promise<string[]> {
  try {
    return (await readdir(matteRoot)).filter((d) => !d.startsWith("."));
  } catch {
    return [];
  }
}

/** Every prerequisite failure must name the fix: path, pin, fetch, backend. */
function expectActionableDiagnostic(text: string) {
  expect(text).toContain(path.join(modelDir, DYNAMIC_SEGMENTER.file));
  expect(text).toContain(DYNAMIC_SEGMENTER.sha256);
  expect(text).toContain(DYNAMIC_SEGMENTER.revision);
  expect(text).toContain(DYNAMIC_SEGMENTER.source);
  expect(text).toMatch(/uv run --locked --script/);
  expect(text).toMatch(/MPS/i);
  expect(text).toMatch(/no CPU or CoreML fallback/i);
}

async function writeSource(bytes: Uint8Array, name = "source.png"): Promise<string> {
  const file = path.join(root, name);
  await writeFile(file, bytes);
  return file;
}

describe("prerequisite failures through the public CLI", () => {
  test("missing weights: nonzero, source preserved, nothing published, diagnostic in text+JSON", async () => {
    const sourceBytes = Buffer.from(OPAQUE_SUBJECT);
    const source = await writeSource(sourceBytes);
    const res = await run([source], {
      engine: localSegmentationMatteEngine(),
      matteRoot,
    });
    expect(res.exitCode).toBe(1);
    expectActionableDiagnostic(res.text);
    const json = res.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expectActionableDiagnostic(json.error);
    expect((await readFile(source)).equals(sourceBytes)).toBe(true);
    expect(await publishedIds()).toEqual([]);
  });

  test("wrong weights hash: nonzero, source preserved, nothing published, diagnostic in text+JSON", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(modelDir, { recursive: true });
    await writeFile(path.join(modelDir, DYNAMIC_SEGMENTER.file), "not the model");
    const sourceBytes = Buffer.from(OPAQUE_SUBJECT);
    const source = await writeSource(sourceBytes);
    const res = await run([source], {
      engine: localSegmentationMatteEngine(),
      matteRoot,
    });
    expect(res.exitCode).toBe(1);
    expectActionableDiagnostic(res.text);
    const json = res.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expectActionableDiagnostic(json.error);
    expect(res.text).toMatch(/sha-256 is [0-9a-f]{64}/);
    expect((await readFile(source)).equals(sourceBytes)).toBe(true);
    expect(await publishedIds()).toEqual([]);
  });

  test("unavailable MPS: nonzero, source preserved, nothing published, diagnostic in text+JSON", async () => {
    // Stub only the process boundary: the error is the real parser's refusal
    // of a minimal MPS-unavailable process result (the old script shape,
    // without path/pin/fetch) — proving the TypeScript seam enriches it.
    const mpsUnavailableEngine = Object.assign(
      async (): Promise<never> => {
        parseInferenceResult(
          "",
          "matte-birefnet-dynamic: MPS is required for local matting but is not the running device (mps built: true, available: false). There is no CPU or CoreML fallback — run on Apple Silicon with a PyTorch MPS build.",
          1,
        );
        throw new Error("unreachable: parseInferenceResult always throws on exit 1");
      },
      { preflight: async () => {} },
    );
    const sourceBytes = Buffer.from(OPAQUE_SUBJECT);
    const source = await writeSource(sourceBytes);
    const res = await run([source], { engine: mpsUnavailableEngine, matteRoot });
    expect(res.exitCode).toBe(1);
    expectActionableDiagnostic(res.text);
    const json = res.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expectActionableDiagnostic(json.error);
    expect((await readFile(source)).equals(sourceBytes)).toBe(true);
    expect(await publishedIds()).toEqual([]);
  });
});

describe("the script and the TypeScript seam name the same pin", () => {
  test("WEIGHTS_SHA256/WEIGHTS_SOURCE match DYNAMIC_SEGMENTER", async () => {
    const script = await readFile(path.resolve("scripts/matte-birefnet-dynamic.py"), "utf8");
    expect(script).toContain(`WEIGHTS_SHA256 = "${DYNAMIC_SEGMENTER.sha256}"`);
    expect(script).toContain(DYNAMIC_SEGMENTER.revision);
    expect(script).toContain(DYNAMIC_SEGMENTER.repo);
    expect(DYNAMIC_SEGMENTER.source).toContain(DYNAMIC_SEGMENTER.revision);
  });

  test("the script's MPS refusal names the fix itself", async () => {
    const script = await readFile(path.resolve("scripts/matte-birefnet-dynamic.py"), "utf8");
    const refusal = script.slice(script.indexOf("def assert_mps"), script.indexOf('return "mps"'));
    expect(refusal).toMatch(/Expected weights/);
    expect(refusal).toContain("WEIGHTS_SHA256");
    expect(refusal).toContain("WEIGHTS_SOURCE");
    expect(refusal).toMatch(/curl -L --fail -o/);
    expect(refusal).toMatch(/warm-cache/);
    expect(refusal).toMatch(/no CPU or CoreML fallback/i);
  });
});

describe("parseInferenceResult — MPS-unavailable errors carry the fix", () => {
  test("a minimal MPS nonzero-exit carries path, pin, fetch, and the MPS requirement", () => {
    const err = (() => {
      try {
        parseInferenceResult("", "matte-birefnet-dynamic: MPS is required but unavailable", 1);
        throw new Error("unreachable");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err.message).toContain(weightsPath());
    expect(err.message).toContain(DYNAMIC_SEGMENTER.sha256);
    expect(err.message).toContain(DYNAMIC_SEGMENTER.revision);
    expect(err.message).toContain(DYNAMIC_SEGMENTER.source);
    expect(err.message).toMatch(/MPS/i);
    expect(err.message).toMatch(/no CPU or CoreML fallback/i);
  });

  test("a non-mps device observation carries path, pin, fetch, and the MPS requirement", () => {
    const err = (() => {
      try {
        parseInferenceResult(
          JSON.stringify({ ok: true, mask: "/tmp/mask.png", device_observable: "cpu" }),
          "",
          0,
        );
        throw new Error("unreachable");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err.message).toContain(weightsPath());
    expect(err.message).toContain(DYNAMIC_SEGMENTER.sha256);
    expect(err.message).toContain(DYNAMIC_SEGMENTER.revision);
    expect(err.message).toContain(DYNAMIC_SEGMENTER.source);
    expect(err.message).toMatch(/no CPU or CoreML fallback/i);
  });

  test("a non-MPS failure stays unenriched — no MPS word, no diagnostic", () => {
    const err = (() => {
      try {
        parseInferenceResult("", "weight load blew up", 1);
        throw new Error("unreachable");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err.message).not.toContain(DYNAMIC_SEGMENTER.sha256);
  });

  test("ordinary words containing 'mps' do not trigger the MPS diagnostic", () => {
    // amps, dumps, glimpse all contain the letters mps without the word MPS.
    const err = (() => {
      try {
        parseInferenceResult("", "inference crashed: amps dumped a glimpse of the mask", 1);
        throw new Error("unreachable");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err.message).toContain("amps dumped a glimpse");
    expect(err.message).not.toContain(DYNAMIC_SEGMENTER.sha256);
    expect(err.message).not.toContain(DYNAMIC_SEGMENTER.source);
  });

  test("a genuine MPS inference failure stays unenriched — names the device, not the refusal", () => {
    // After assert_mps succeeds the script can still fail inference on MPS
    // (OOM, etc.): that is not an unavailable-MPS machine, so the operator
    // must not be told to re-fetch weights (INT-1).
    const err = (() => {
      try {
        parseInferenceResult("", "matte-birefnet-dynamic: inference failed on mps: MPS out of memory", 1);
        throw new Error("unreachable");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err.message).toContain("inference failed on mps");
    expect(err.message).not.toContain(DYNAMIC_SEGMENTER.sha256);
    expect(err.message).not.toContain(DYNAMIC_SEGMENTER.source);
  });

  test("an MPS failure record carries path, pin, fetch, and the MPS requirement", () => {
    const err = (() => {
      try {
        parseInferenceResult(
          JSON.stringify({ ok: false, error: "MPS is required for local matting" }),
          "",
          0,
        );
        throw new Error("unreachable");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err.message).toContain(weightsPath());
    expect(err.message).toContain(DYNAMIC_SEGMENTER.sha256);
    expect(err.message).toMatch(/MPS/i);
  });
});
