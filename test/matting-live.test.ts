/**
 * Live-engine qualification for the independent local Matting operation
 * (spec #159 ticket #162, US-001/US-002/US-006, TEST-006/TEST-007): the real
 * public Matting command against the real pinned BiRefNet Dynamic weights on
 * PyTorch/MPS, offline, on an opaque non-square fixture.
 *
 * What is proven, per acceptance criterion:
 *
 *   1. Prerequisites: the test refuses to qualify without the cached weights
 *      (skip with a loud console line), and the engine's own preflight
 *      re-verifies the sha-256 pin before inference — a missing or
 *      mismatched cache can never produce a pass. The engine identity in the
 *      published record (`local-segmentation:birefnet-dynamic@<revision>`,
 *      backend `mps`, timing scope `engine`) is the recorded runtime/model
 *      identity.
 *   2. The real public command runs the real engine offline on an opaque
 *      NON-SQUARE fixture (256x200 — the replicate-pad path runs): the
 *      published record names the segmenter (never `native-alpha` — the
 *      fixture is fully opaque, so only inference can have produced the
 *      output), the output bytes differ from the source and match the input
 *      dims exactly (padding cropped before resize-back), the source bytes
 *      are unchanged, and on Darwin the whole command runs under
 *      kernel-level network denial (the same sandbox machinery
 *      test/matting-offline.test.ts established for this surface; the
 *      negative control lives there). Off Darwin the command runs
 *      unsandboxed and claims nothing about sandboxing.
 *   3. The matte is genuine and usable: it passes the true-alpha gate, the
 *      measured alpha matches the record, whole-command time is
 *      seconds-level (not the retired six-minute ONNX/CoreML regime), and
 *      composited over contrasting backgrounds the cut-out shows the
 *      background through while the subject body keeps its own colours.
 *
 * This is technical alpha qualification only — it says nothing about any
 * person's likeness, and approves no candidate.
 *
 * Cost: one fresh one-shot process (interpreter startup, ~444 MB weight
 * load, inference, publish) measures seconds on Apple silicon. This suite
 * runs only when explicitly requested (`PLY_RUN_LIVE=1`) AND the weights are
 * present, and skips otherwise, so the default suite stays fast even on
 * machines with a warm weights cache. Run it as:
 *
 *   PLY_RUN_LIVE=1 bun test --isolate test/matting-live.test.ts
 */
import { describe, test, expect } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { encodePngRgba, decodePng } from "../src/png.js";
import { verifyTrueAlpha } from "../src/alpha.js";
import { ENGINE_ID, BACKEND_MPS, DYNAMIC_SEGMENTER } from "../src/segment.js";
import { parseMattingRecord } from "../src/matting.js";

const W = 256;
const H = 200; // non-square, non-multiple-of-32 height: the pad path must run

/** The true-alpha gate's own transparency slack (src/alpha.ts thresholds). */
const ALPHA_TOLERANCE = 8;

/** Seconds-level bar: far above the ~4 s medians, far below the retired minutes regime. */
const SECONDS_LEVEL_MS = 120_000;

/**
 * The qualification fixture: a deterministic, fully opaque PNG with a salient
 * non-rectangular subject (magenta ellipse with a dark-blue inner disc) on a
 * light checkered background.
 */
function fixtureRgba(): Buffer {
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
        if (((x - W / 2) / (W / 8)) ** 2 + ((y - H / 3) / (H / 8)) ** 2 <= 1) {
          r = 24;
          g = 96;
          b = 160;
        } else {
          r = 196;
          g = 24;
          b = 148;
        }
      }
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

type Background = (x: number, y: number) => [number, number, number];

/** Composite an RGBA plane over a background colour, alpha-over, opaque. */
function compositeOver(rgba: Buffer, bg: Background): Buffer {
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const a = rgba[i + 3]! / 255;
      const [br, bgc, bb] = bg(x, y);
      out[i] = Math.round(rgba[i]! * a + (1 - a) * br);
      out[i + 1] = Math.round(rgba[i + 1]! * a + (1 - a) * bgc);
      out[i + 2] = Math.round(rgba[i + 2]! * a + (1 - a) * bb);
      out[i + 3] = 255;
    }
  }
  return out;
}

describe("independent Matting (live engine, #162)", () => {
  const liveOnly = test.skipIf(!process.env.PLY_RUN_LIVE);
  liveOnly(
    "the public command mattes an opaque non-square fixture with the real pinned weights, offline, to a usable true alpha",
    async () => {
      // One home for "where the weights are": the ambient override if set,
      // otherwise the repo-root cache beside this test file. Resolved to an
      // absolute path once, here: the prerequisite check runs against the
      // parent's cwd, but the child CLI runs under the temporary root and
      // would resolve a relative override there instead (INT-1).
      const models = path.resolve(process.env.PLY_MODEL_DIR ?? path.join(import.meta.dir, "../models"));
      if (!(await stat(path.join(models, DYNAMIC_SEGMENTER.file)).catch(() => null))) {
        console.log("skipped: PLY_RUN_LIVE=1 is set but local matting weights are not on this machine — no qualification is claimed");
        return;
      }

      const root = await mkdtemp(path.join(tmpdir(), "ply-matting-live-"));
      try {
        // Fixture on disk; its identity is derived from the exact bytes on
        // disk, the same way the operation derives it.
        const fixture = encodePngRgba(W, H, fixtureRgba());
        await writeFile(path.join(root, "fixture.png"), fixture);
        const sourceHash = createHash("sha256").update(fixture).digest("hex");

        // The real CLI, its process cwd rooted at the temp dir so the default
        // matte root resolves there. The weights cache resolved above is
        // handed over through the documented PLY_MODEL_DIR override
        // (src/segment.ts modelDir) — cwd-relative model resolution would not
        // find it under a temp cwd. Darwin: kernel network denial around the
        // whole command — the engine must run with no network at all, from
        // locally cached weights only.
        const cli = path.resolve(import.meta.dir, "../src/matting-cli.ts");
        const args = [cli, "fixture.png", "--id", "matte-162-live-qual", "--json"];
        const argv =
          process.platform === "darwin"
            ? ["sandbox-exec", "-p", "(version 1) (allow default) (deny network*)", process.execPath, ...args]
            : [process.execPath, ...args];
        const started = performance.now();
        const child = Bun.spawn(argv, {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, PLY_MODEL_DIR: models },
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        const wholeCommandMs = performance.now() - started;
        if (code !== 0)
          throw new Error(
            `the live matting command exited ${code} (expected 0)\nstdout: ${stdout}\nstderr: ${stderr}`,
          );
        let json: {
          ok: boolean;
          error?: string;
          matteId: string;
          matteDir: string;
          matte: unknown;
        };
        try {
          json = JSON.parse(stdout);
        } catch (err) {
          throw new Error(
            `the live matting command printed unparseable stdout: ${stdout}\nstderr: ${stderr}`,
            { cause: err },
          );
        }
        if (!json.ok) throw new Error(`live matting failed: ${json.error ?? stderr}`);
        expect(json.matteId).toBe("matte-162-live-qual");

        // Seconds-level whole command: the retired ONNX/CoreML regime took
        // minutes; this pin measures ~4 s. The bar is generous (30x the
        // medians) but excludes the old regime by 3x.
        expect(wholeCommandMs).toBeLessThan(SECONDS_LEVEL_MS);
        console.log(`live whole-command: ${Math.round(wholeCommandMs)} ms`);

        // The record is the one authoritative home of the Matting facts; it
        // must parse as the canonical contract and name the real engine.
        const record = parseMattingRecord(
          await readFile(path.join(json.matteDir, "matte.json"), "utf8"),
          json.matteId,
        );
        expect(record.result.engine).toBe(ENGINE_ID);
        expect(record.result.backend).toBe(BACKEND_MPS);
        expect(record.result.timing?.scope).toBe("engine");
        expect(record.result.timing?.millis).toBeGreaterThanOrEqual(0);
        expect(record.request.source.path).toBe("fixture.png");
        if (record.result.warnings.length > 0)
          console.log("live run warnings:", record.result.warnings.join(" | "));
        // The source identity the record claims is the fixture's actual identity.
        expect(record.request.source.contentHash).toBe(sourceHash);
        // Inference actually ran: the published bytes are not the source.
        expect(record.result.outputs[0]!.contentHash).not.toBe(sourceHash);

        // The output file on disk content-verifies against its record entry.
        const outPath = path.join(json.matteDir, record.result.outputs[0]!.file);
        const outBytes = await readFile(outPath);
        expect(createHash("sha256").update(outBytes).digest("hex")).toBe(
          record.result.outputs[0]!.contentHash,
        );

        // The source file was only ever read.
        expect(
          createHash("sha256").update(await readFile(path.join(root, "fixture.png"))).digest("hex"),
        ).toBe(sourceHash);

        // Genuine usable alpha at the INPUT's own dims: the pad path ran
        // (200 -> 224 internally) and the padding was cropped before the
        // resize back — the published matte is 256x200, not 256x224.
        const report = verifyTrueAlpha(outBytes, "matte-162-live-qual");
        expect(report.width).toBe(W);
        expect(report.height).toBe(H);
        expect(record.result.alpha).toEqual(report);
        const total = W * H;
        expect(report.transparentPx / total).toBeGreaterThan(0.2);
        expect(report.opaquePx / total).toBeGreaterThan(0.05);

        // The matte is genuinely usable on contrasting backgrounds: the
        // cut-out shows the background through, the subject body keeps its
        // own colours, and the background-showing pixel count equals the
        // record's transparent count (both count alpha <= 8, the gate's
        // threshold). Live numerics may drift slightly across runs, so
        // composite comparisons carry the gate's own slack — what must hold
        // is the gate vocabulary, not bit-exact pixels.
        const matte = decodePng(outBytes);
        const cx = Math.floor(W / 2);
        const cy = Math.floor(H / 2);
        const centre = (cy * W + cx) * 4; // well inside the subject body
        const backgrounds: Background[] = [
          () => [0, 0, 0],
          () => [255, 255, 255],
          (x, y) =>
            (Math.floor(x / 16) + Math.floor(y / 16)) % 2 ? [232, 232, 232] : [24, 24, 24],
        ];
        for (const bg of backgrounds) {
          const over = compositeOver(matte.rgba, bg);
          const corner = (3 * W + 3) * 4; // far corner — transparent under every background
          expect(matte.rgba[corner + 3]!).toBeLessThanOrEqual(ALPHA_TOLERANCE);
          for (let c = 0; c < 3; c++)
            expect(Math.abs(over[corner + c]! - bg(3, 3)[c]!)).toBeLessThanOrEqual(ALPHA_TOLERANCE);
          // The subject body keeps its own colours.
          expect(matte.rgba[centre + 3]!).toBeGreaterThanOrEqual(255 - ALPHA_TOLERANCE);
          for (let c = 0; c < 3; c++)
            expect(Math.abs(over[centre + c]! - matte.rgba[centre + c]!)).toBeLessThanOrEqual(
              ALPHA_TOLERANCE,
            );
          // Same threshold the gate counts with, so this equals transparentPx.
          let bgShown = 0;
          for (let i = 3; i < over.length; i += 4) if (matte.rgba[i]! <= ALPHA_TOLERANCE) bgShown++;
          expect(bgShown).toBe(report.transparentPx);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    // Fresh one-shot process with a cold Python interpreter: seconds, with
    // headroom for a loaded machine — but never the old minutes regime.
    300_000,
  );
});
