/**
 * Live-engine qualification for the independent local Matting operation
 * (spec #102 ticket #112, US-002, TEST-003): the real public Matting command
 * against the real pinned BiRefNet weights, offline, on an opaque fixture.
 *
 * The machine-level qualification this test encodes ran on 2026-09-09 and is
 * recorded on ticket #112. Its reproducible shape, in one command:
 *
 *   bun test test/matting-live.test.ts
 *
 * What is proven, per acceptance criterion:
 *
 *   1. Prerequisites: the test refuses to qualify without the cached weights
 *      (skip with a loud console line), and the engine's own preflight
 *      re-verifies the sha-256 pin before inference — a missing or
 *      mismatched cache can never produce a pass. The engine identity in the
 *      published record (`local-segmentation:birefnet-hr-fp16.onnx` through
 *      onnxruntime-node) is the recorded runtime/model identity.
 *   2. The real public command runs the real engine offline on an opaque
 *      fixture: the published record names the segmenter (never
 *      `native-alpha` — the fixture is fully opaque, so only inference can
 *      have produced the output), the output bytes differ from the source,
 *      the source bytes are unchanged, and on Darwin the whole command runs
 *      under kernel-level network denial (the same sandbox machinery
 *      test/matting-offline.test.ts established for this surface; the
 *      negative control lives there). Off Darwin the command runs
 *      unsandboxed and claims nothing about sandboxing.
 *   3. The matte is genuine and usable: it passes the true-alpha gate, the
 *      measured alpha matches the record, and composited over contrasting
 *      backgrounds the cut-out shows the background through while the
 *      subject body keeps its own colours.
 *
 * This is technical alpha qualification only — it says nothing about any
 * person's likeness, and approves no candidate.
 *
 * Cost: loading the ~560 MB weights and the one-time CoreML MLProgram
 * compile take minutes per fresh process on Apple silicon (measured ~6 min
 * for session build + first inference). Like the live check in
 * test/segment.test.ts this runs whenever the weights are present and skips
 * otherwise, so CI without the cache stays fast.
 */
import { describe, test, expect } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { encodePngRgba, decodePng } from "../src/png.js";
import { verifyTrueAlpha } from "../src/alpha.js";
import { weightsPath, SUBJECT_SEGMENTER } from "../src/segment.js";
import { parseMattingRecord } from "../src/matting.js";

const W = 256;
const H = 256;

/**
 * The qualification fixture: a deterministic, fully opaque PNG with a salient
 * non-rectangular subject (magenta ellipse with a dark-blue inner disc) on a
 * light checkered background. Same generator recorded on ticket #112.
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
      const dx = (x - 128) / 76;
      const dy = (y - 132) / 100;
      if (dx * dx + dy * dy <= 1) {
        if (((x - 128) / 44) ** 2 + ((y - 108) / 34) ** 2 <= 1) {
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

describe("independent Matting (live engine, #112)", () => {
  test(
    "the public command mattes an opaque fixture with the real pinned weights, offline, to a usable true alpha",
    async () => {
      if (!(await stat(weightsPath()).catch(() => null))) {
        console.log("skipped: local matting weights are not on this machine — no qualification is claimed");
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
        // matte root resolves there. The weights cache is handed over through
        // the documented PLY_MODEL_DIR override (src/segment.ts modelDir) —
        // cwd-relative model resolution would not find it under a temp cwd.
        // Darwin: kernel network denial around the whole command — the engine
        // must run with no network at all, from locally cached weights only.
        const cli = path.resolve(import.meta.dir, "../src/matting-cli.ts");
        const args = [cli, "fixture.png", "--id", "matte-112-live-qual", "--json"];
        const argv =
          process.platform === "darwin"
            ? ["sandbox-exec", "-p", "(version 1) (allow default) (deny network*)", process.execPath, ...args]
            : [process.execPath, ...args];
        const child = Bun.spawn(argv, {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, PLY_MODEL_DIR: path.resolve(import.meta.dir, "../models") },
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code).toBe(0);
        const json = JSON.parse(stdout) as {
          ok: boolean;
          error?: string;
          matteId: string;
          matteDir: string;
          matte: unknown;
        };
        if (!json.ok) throw new Error(`live matting failed: ${json.error ?? stderr}`);
        expect(json.matteId).toBe("matte-112-live-qual");

        // The record is the one authoritative home of the Matting facts; it
        // must parse as the canonical contract and name the real engine.
        const record = parseMattingRecord(
          await readFile(path.join(json.matteDir, "matte.json"), "utf8"),
          json.matteId,
        );
        expect(record.result.engine).toBe(`local-segmentation:${SUBJECT_SEGMENTER.file}`);
        expect(record.request.source.path).toBe("fixture.png");
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

        // Genuine usable alpha: the true-alpha gate accepts the published
        // bytes and the record's measured counts agree with a fresh measure.
        const report = verifyTrueAlpha(outBytes, "matte-112-live-qual");
        expect(record.result.alpha).toEqual(report);
        const total = W * H;
        expect(report.transparentPx / total).toBeGreaterThan(0.4);
        expect(report.opaquePx / total).toBeGreaterThan(0.05);

        // The matte is genuinely usable on contrasting backgrounds: the
        // cut-out shows the background through (transparent pixels take the
        // background colour), the subject body keeps its own colours, and the
        // background-showing pixel count tracks the record's transparent count.
        const matte = decodePng(outBytes);
        const centre = (132 * W + 128) * 4; // well inside the subject body
        const backgrounds: [string, Background][] = [
          ["black", () => [0, 0, 0]],
          ["white", () => [255, 255, 255]],
          ["checker", (x, y) =>
            (Math.floor(x / 16) + Math.floor(y / 16)) % 2 ? [232, 232, 232] : [24, 24, 24]],
        ];
        for (const [name, bg] of backgrounds) {
          const over = compositeOver(matte.rgba, bg);
          const corner = (3 * W + 3) * 4; // far corner — transparent under every background
          expect(over[corner]!).toBe(bg(3, 3)[0]);
          expect(over[corner + 1]!).toBe(bg(3, 3)[1]);
          expect(over[corner + 2]!).toBe(bg(3, 3)[2]);
          // The subject body's colours survive compositing unchanged.
          for (let c = 0; c < 3; c++) expect(over[centre + c]!).toBe(matte.rgba[centre + c]!);
          let bgShown = 0;
          for (let i = 3; i < over.length; i += 4) if (matte.rgba[i]! / 255 < 0.02) bgShown++;
          expect(bgShown).toBeGreaterThan(total * 0.6);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    // Weights + one-time CoreML compile: minutes, not the usual test budget.
    900_000,
  );
});