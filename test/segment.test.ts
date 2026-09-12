import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DYNAMIC_SEGMENTER,
  ENGINE_ID,
  BACKEND_MPS,
  dynamicScriptPath,
  ensureSegmenterReady,
  localSegmentationMatteEngine,
  missingWeightsMessage,
  parseInferenceResult,
  weightsPath,
} from "../src/segment.js";
import { dynamicGeometry } from "../src/dynamic-geometry.js";
import { verifyTrueAlpha } from "../src/alpha.js";
import { encodePng } from "./png.js";
import { readPngHeader } from "../src/png.js";

const originalModelDir = process.env.PLY_MODEL_DIR;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-segment-"));
});
afterEach(async () => {
  if (originalModelDir === undefined) delete process.env.PLY_MODEL_DIR;
  else process.env.PLY_MODEL_DIR = originalModelDir;
  await rm(root, { recursive: true, force: true });
});

describe("engine identity", () => {
  test("the one production engine names the pinned Dynamic revision", () => {
    expect(ENGINE_ID).toBe(
      `local-segmentation:birefnet-dynamic@${DYNAMIC_SEGMENTER.revision}`,
    );
    expect(DYNAMIC_SEGMENTER.repo).toBe("ZhengPeng7/BiRefNet_dynamic");
    expect(DYNAMIC_SEGMENTER.revision).toBe("280306042f57b7a33854319da62fd86aaa89ec4c");
    expect(DYNAMIC_SEGMENTER.file).toBe("birefnet-dynamic.safetensors");
    expect(DYNAMIC_SEGMENTER.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(BACKEND_MPS).toBe("mps");
  });

  test("the source URL is pinned to the revision, never main", () => {
    expect(DYNAMIC_SEGMENTER.source).not.toMatch(/\/main\//);
    expect(DYNAMIC_SEGMENTER.source).toContain(DYNAMIC_SEGMENTER.revision);
  });
});

/**
 * These run before the live check on purpose: preflight is pure TypeScript
 * (file + hash, no Python), so the failure paths must be exercised while the
 * weights are absent.
 */
describe("weights are pinned and failures are loud", () => {
  const OPAQUE = encodePng(16, 16, (x, y) => (x < 8 ? [200, 30, 40, 255] : [20, 90, 200, 255]), {
    colorType: 2,
  });

  test("missing weights name the file, the pin, the fetch, and the MPS requirement", async () => {
    process.env.PLY_MODEL_DIR = root;
    const err = await localSegmentationMatteEngine()({ bytes: OPAQUE, label: "cand.png" }).catch(
      (e) => e as Error,
    );
    const message = (err as Error).message;
    expect(message).toContain(path.join(root, DYNAMIC_SEGMENTER.file));
    expect(message).toContain(DYNAMIC_SEGMENTER.sha256);
    expect(message).toContain(DYNAMIC_SEGMENTER.revision);
    expect(message).toContain(DYNAMIC_SEGMENTER.source);
    expect(message).toContain("scripts/matte-birefnet-dynamic.py");
    expect(message).toMatch(/uv run --locked --script/);
    // MPS is required: the message states there is no fallback, and it never
    // offers a CPU/CoreML path (no fallback instructions, no device switch).
    expect(message).toMatch(/MPS/i);
    expect(message).toMatch(/no CPU or CoreML fallback/i);
    expect(message).not.toMatch(/fall back to CPU|fallback to CPU|run on CPU|CPU mode/i);
    // Never a silent skip: the pass refuses rather than recording no matte.
    expect(message).toMatch(/never falls back|fails|unusable/i);
  });

  test("weights whose bytes do not match the pin are refused, with the actual hash", async () => {
    process.env.PLY_MODEL_DIR = root;
    await writeFile(path.join(root, DYNAMIC_SEGMENTER.file), "not the model");
    const err = await localSegmentationMatteEngine()({ bytes: OPAQUE, label: "cand.png" }).catch(
      (e) => e as Error,
    );
    expect((err as Error).message).toMatch(/sha-256 is [0-9a-f]{64}/);
  });

  test("preflight refuses before any candidate is matted, with the same message", async () => {
    process.env.PLY_MODEL_DIR = root;
    const engine = localSegmentationMatteEngine();
    expect(engine.preflight).toBe(ensureSegmenterReady);
    const err = await engine.preflight!().catch((e) => e as Error);
    expect((err as Error).message).toContain(path.join(root, DYNAMIC_SEGMENTER.file));
    expect((err as Error).message).toContain(DYNAMIC_SEGMENTER.sha256);
    expect((err as Error).message).toContain(DYNAMIC_SEGMENTER.source);
  });

  test("the fix-it message is one text, whatever raised it", () => {
    process.env.PLY_MODEL_DIR = root;
    expect(missingWeightsMessage("because")).toContain(weightsPath());
  });

  test("the recovery command is pinned to the same identity the runtime verifies", async () => {
    // A floating /main URL or an unlocked uv run can produce bytes that are
    // not DYNAMIC_SEGMENTER.sha256, so the documented fix would still fail at
    // load. The message and the pin share one revision; the inference script
    // names the same revision; uv --locked is the only documented run.
    expect(DYNAMIC_SEGMENTER.source).not.toMatch(/\/main\//);
    expect(DYNAMIC_SEGMENTER.source).toContain(DYNAMIC_SEGMENTER.revision);
    const message = missingWeightsMessage("because");
    expect(message).toContain(DYNAMIC_SEGMENTER.sha256);
    expect(message).toContain(DYNAMIC_SEGMENTER.revision);
    expect(message).toContain("uv run --locked --script");
    expect(message).toContain("scripts/matte-birefnet-dynamic.py");
    const script = await readFile(path.resolve("scripts/matte-birefnet-dynamic.py"), "utf8");
    expect(script).toContain(DYNAMIC_SEGMENTER.revision);
    expect(script).toContain(DYNAMIC_SEGMENTER.repo);
  });
});

describe("the inference script asserts its own backend (static: no Python launched)", () => {
  test("the script gates on MPS, loads the pinned revision locally, and offers no CPU path", async () => {
    const script = await readFile(path.resolve("scripts/matte-birefnet-dynamic.py"), "utf8");
    expect(script).toMatch(/mps.*is_available|is_available.*mps/i);
    expect(script).toContain("revision=");
    expect(script).toContain(DYNAMIC_SEGMENTER.revision);
    // The US-002 defaults are locked: the cap and the patch-grid multiple
    // are the contract, and the extra flags are diagnostic-only (production
    // never passes them — one Python launch per matte, defaults always).
    expect(script).toContain("MAX_SIDE = 2048");
    expect(script).toContain("PAD_MULTIPLE = 32");
    expect(script).toMatch(/diagnostic only/);
    // No silent device switch: the script never assigns cpu as an inference
    // device (safetensors staging to host memory via load_file is not inference).
    expect(script).not.toMatch(/\.to\(["']cpu["']\)|^\s*device\s*=\s*["']cpu["']/m);
    expect(script).not.toMatch(/set_default_device/);
    // Offline after cache: the run path must not reach the Hub.
    expect(script).toMatch(/local_files_only|HF_HUB_OFFLINE/);
  });
});

describe("parseInferenceResult — the single-process boundary speaks mps or it fails", () => {
  const mask = "/tmp/mask.png";

  test("an mps observation parses", () => {
    const out = parseInferenceResult(JSON.stringify({ ok: true, mask, device_observable: "mps" }), "", 0);
    expect(out).toEqual({ maskPath: mask, device: "mps" });
  });

  test("a non-mps device is a loud backend failure, not a silent switch", () => {
    for (const device of ["cpu", "cuda", "xpu", ""]) {
      expect(() =>
        parseInferenceResult(JSON.stringify({ ok: true, mask, device_observable: device }), "", 0),
      ).toThrow(/MPS|backend/i);
    }
  });

  test("a nonzero exit carries stderr and never parses", () => {
    expect(() => parseInferenceResult("", "MPS is required but unavailable", 1)).toThrow(
      /MPS is required but unavailable/,
    );
  });

  test("unparseable stdout is a loud failure", () => {
    expect(() => parseInferenceResult("not json", "", 0)).toThrow(/unparseable|invalid/i);
  });

  test("a failure record is a loud failure", () => {
    expect(() =>
      parseInferenceResult(JSON.stringify({ ok: false, error: "weight load failed" }), "", 0),
    ).toThrow(/weight load failed/);
  });

  test("a null JSON body is a loud failure, not a TypeError", () => {
    expect(() => parseInferenceResult("null", "", 0)).toThrow(/Local matting failed/);
  });
});

/**
 * The live check. It exercises the real pinned weights through the real
 * one-shot process and runs only when explicitly requested (`PLY_RUN_LIVE=1`)
 * with the weights present — default tests never launch Python and never
 * load weights, and the default suite stays fast even on machines with a
 * warm cache. Run it as:
 *
 *   PLY_RUN_LIVE=1 bun test --isolate test/segment.test.ts
 */
describe("local segmentation (live)", () => {
  const liveOnly = test.skipIf(!process.env.PLY_RUN_LIVE);
  liveOnly("mattes an opaque fixture to a true-alpha PNG on MPS", async () => {
    if (!(await stat(weightsPath()).catch(() => null))) {
      console.log("skipped: PLY_RUN_LIVE=1 is set but local matting weights are not on this machine");
      return;
    }
    // Deterministic opaque fixture: magenta ellipse subject on a checkered
    // ground. Needs no gitignored inputs.
    const W = 256;
    const H = 192; // non-square: the pad path runs, output must match input dims
    const rgba = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const cell = (Math.floor(x / 16) + Math.floor(y / 16)) % 2;
        let r = cell ? 232 : 204;
        let g = r;
        let b = r;
        const dx = (x - W / 2) / (W / 4);
        const dy = (y - H / 2) / (H / 3);
        if (dx * dx + dy * dy <= 1) {
          r = 196;
          g = 24;
          b = 148;
        }
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = 255;
      }
    }
    const bytes = encodePng(W, H, (x, y) => {
      const i = (y * W + x) * 4;
      return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, 255];
    }, { colorType: 2 });

    const result = await localSegmentationMatteEngine()({ bytes, label: "live-fixture.png" });
    expect(result.engine).toBe(ENGINE_ID);
    expect(result.backend).toBe("mps");
    expect(result.timing).toMatchObject({ scope: "engine" });
    expect(result.timing!.millis).toBeGreaterThanOrEqual(0);
    const report = verifyTrueAlpha(result.bytes, "live-fixture.png");
    expect(report.width).toBe(W);
    expect(report.height).toBe(H);
    const total = W * H;
    expect(report.transparentPx / total).toBeGreaterThan(0.2);
    expect(report.opaquePx / total).toBeGreaterThan(0.05);
  }, 300_000);

  liveOnly("the script reports the US-002 working geometry honestly", async () => {
    // Binds the production preprocessing to the weight-free contract lock:
    // the script's own reported working geometry must equal
    // dynamicGeometry for the same input, and the mask must come back at
    // the input's own dims. A silent change to the script's cap/pad/crop
    // arithmetic fails here. Runs the real weights (live gate above).
    if (!(await stat(weightsPath()).catch(() => null))) {
      console.log("skipped: PLY_RUN_LIVE=1 is set but local matting weights are not on this machine");
      return;
    }
    const W = 250;
    const H = 190; // pads right 6 / bottom 2
    const bytes = encodePng(W, H, (x, y) => {
      const dx = (x - W / 2) / (W / 4);
      const dy = (y - H / 2) / (H / 3);
      return dx * dx + dy * dy <= 1 ? [196, 24, 148, 255] : [204, 204, 204, 255];
    }, { colorType: 2 });
    const dir = await mkdtemp(path.join(tmpdir(), "ply-segment-geometry-live-"));
    try {
      const input = path.join(dir, "input.png");
      const outMask = path.join(dir, "mask.png");
      await writeFile(input, bytes);
      const proc = Bun.spawn(
        ["uv", "run", "--locked", "--script", dynamicScriptPath(),
          "--weights", weightsPath(), "--input", input, "--out-mask", outMask],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, HF_HUB_OFFLINE: "1" } },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(`geometry live run exited ${code}: ${stderr.slice(-2000)}`);
      const rec = JSON.parse(stdout) as {
        ok: boolean; device_observable: string; input_size: [number, number];
        output_size: [number, number]; internal: string;
      };
      expect(rec.ok).toBe(true);
      expect(rec.device_observable).toBe("mps");
      expect(rec.input_size).toEqual([W, H]);
      expect(rec.output_size).toEqual([W, H]);
      // The reported working geometry equals the contract lock exactly.
      const g = dynamicGeometry(W, H);
      const m = /^(\d+)x(\d+) \(pre-pad (\d+)x(\d+), pad right (\d+) bottom (\d+) replicate, scale ([\d.]+)\)$/.exec(rec.internal);
      expect(m).not.toBeNull();
      expect([Number(m![1]), Number(m![2])]).toEqual([g.paddedW, g.paddedH]);
      expect([Number(m![3]), Number(m![4])]).toEqual([g.workW, g.workH]);
      expect([Number(m![5]), Number(m![6])]).toEqual([g.padRight, g.padBottom]);
      expect(g.padRight).toBe(6);
      expect(g.padBottom).toBe(2);
      // And the mask on disk is at the input's own dims (padding cropped
      // before resize-back — not the padded frame).
      const header = readPngHeader(await readFile(outMask));
      expect(header.width).toBe(W);
      expect(header.height).toBe(H);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
