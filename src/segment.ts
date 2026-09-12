/**
 * Local subject segmentation — the shipped matting engine (spec #159,
 * ADR-0020, superseding ADR-0009).
 *
 * Isolation runs **on this machine**: one-shot pinned `uv` Python runs the
 * BiRefNet Dynamic checkpoint on PyTorch/MPS
 * (`scripts/matte-birefnet-dynamic.py`), predicts the subject mask, and
 * `composeMatte` applies that mask as the candidate's alpha channel. No
 * image model, no second Gateway hop, nothing billed — which is why a
 * matting attempt has no cost to lose when it fails. No daemon, no warm
 * session: a fresh `ply matte` is seconds-level end to end.
 *
 * Weights are not in the repo. They live in a gitignored cache, pinned by
 * exact filename and sha-256 and verified before every matte (streamed, so
 * the 444 MB file is never held in memory): a missing or wrong-bytes model
 * fails loudly with the file to fetch and where, and the matting pass never
 * silently degrades into "no isolation". MPS is asserted inside the single
 * inference process before any mask is written — there is exactly one Python
 * launch per matte, and no CPU or CoreML fallback anywhere.
 */
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { readPngHeader, PngParseError } from "./png.js";
import { composeMatte, type MatteEngine } from "./matte.js";

/**
 * The pinned segmenter. BiRefNet Dynamic (MIT) on PyTorch/MPS — the
 * measured replacement for the retired BiRefNet HR ONNX/CoreML pin
 * (spec #159, ADR-0020): seconds-level fresh whole-command time with white
 * interiors kept opaque, at a 444 MB weight file.
 *
 * The pin is the provenance: a weights file that doesn't hash to it is not
 * this model. Never `main`: a floating tip could execute different remote
 * code (`trust_remote_code`) and produce a mask this pin cannot vouch for.
 * Verified on the production-path file at implement time — never copied
 * from memory.
 */
export const DYNAMIC_SEGMENTER = {
  file: "birefnet-dynamic.safetensors",
  sha256: "e3d2e4884e51ff30f0cd630edc6b1e41b06b7f23a0a2a5169f7b7cb33a711c2d",
  /** Pinned model repo. */
  repo: "ZhengPeng7/BiRefNet_dynamic",
  /** Immutable Hugging Face commit the weights and architecture pin to. Never `main`. */
  revision: "280306042f57b7a33854319da62fd86aaa89ec4c",
  /** The exact published weights bytes (MIT), pinned. */
  source:
    "https://huggingface.co/ZhengPeng7/BiRefNet_dynamic/resolve/280306042f57b7a33854319da62fd86aaa89ec4c/model.safetensors",
  /** Long-side cap of the US-002 geometry contract (production detail lives in the script). */
  maxSide: 2048,
} as const;

/** Engine identity recorded on every successful inference matte: the exact pin. */
export const ENGINE_ID =
  `local-segmentation:birefnet-dynamic@${DYNAMIC_SEGMENTER.revision}` as const;

/** The only backend a successful inference matte may record. */
export const BACKEND_MPS = "mps" as const;

/** Where weights are cached. Gitignored; `PLY_MODEL_DIR` overrides it. */
export function modelDir(): string {
  return process.env.PLY_MODEL_DIR ?? path.resolve("models");
}

export function weightsPath(): string {
  return path.join(modelDir(), DYNAMIC_SEGMENTER.file);
}

/** The one-shot inference script, resolved against this module — never cwd. */
export function dynamicScriptPath(): string {
  return path.join(import.meta.dir, "..", "scripts", "matte-birefnet-dynamic.py");
}

/** The one message that tells a human exactly how to fix missing weights. */
export function missingWeightsMessage(why: string): string {
  return [
    `The local matting model is unusable: ${why}`,
    ``,
    `Expected: ${weightsPath()}`,
    `sha-256:  ${DYNAMIC_SEGMENTER.sha256}`,
    ``,
    `Fetch it once (about 444 MB, cached and gitignored) — the exact pinned`,
    `bytes at revision ${DYNAMIC_SEGMENTER.revision}:`,
    `  ${DYNAMIC_SEGMENTER.source}`,
    `  mkdir -p ${modelDir()}`,
    `  curl -L --fail -o ${weightsPath()} ${DYNAMIC_SEGMENTER.source}`,
    ``,
    `Then warm the pinned architecture cache once (small, needs network once):`,
    `  uv run --locked --script scripts/matte-birefnet-dynamic.py --warm-cache`,
    ``,
    `The locked script runs that revision and nothing else — the pin above is`,
    `the model's identity. Inference needs Apple Silicon with PyTorch MPS:`,
    `there is no CPU or CoreML fallback, and a machine without MPS fails here`,
    `rather than recording a matte from the wrong backend.`,
    ``,
    `Isolation is local by design (ADR-0015) — the pass never falls back to an`,
    `un-matted candidate, so a matting operation stops here rather than`,
    `recording candidates that could never be adopted.`,
  ].join("\n");
}

/** Stream the file's sha-256 without holding 444 MB in memory. */
function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk as Buffer));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// The verified identity, per process: after one successful hash of a file,
// only a size/mtime change re-hashes. Preflight and the engine call both
// verify, so one matte hashes the weights exactly once — the second check is
// a stat. A mid-session swap of a file this process already opened is not a
// threat the check could catch anyway.
const verified = new Map<string, { size: number; mtimeMs: number }>();

/**
 * Read and verify the weights. Pure TypeScript — file existence plus the
 * streaming sha-256 pin. No Python is launched here (or anywhere in
 * preflight): there is exactly one Python process per matte, the inference
 * call itself, which asserts MPS before writing any mask.
 */
async function verifyWeights(): Promise<void> {
  const file = weightsPath();
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new Error(missingWeightsMessage("the weights file is not there"));
  }
  const known = verified.get(file);
  if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return;
  const actual = await sha256File(file).catch(() => {
    throw new Error(missingWeightsMessage("the weights file cannot be read"));
  });
  if (actual !== DYNAMIC_SEGMENTER.sha256)
    throw new Error(
      missingWeightsMessage(
        `the file's sha-256 is ${actual}, not the pinned identity — re-download it, or update the pin deliberately if the model is being changed`,
      ),
    );
  verified.set(file, { size: info.size, mtimeMs: info.mtimeMs });
}

/** Whether process output reports an unavailable-MPS refusal. Word-boundary:
 * bare /mps/i also matches ordinary words (samples, amps, dumps). */
function isMpsUnavailable(text: string): boolean {
  return /\bmps\b/i.test(text);
}

/** Whether the text already names the fix (path, pin, fetch) — the new
 * script shape carries them, so the seam must not duplicate the block. */
function hasPrereqFacts(text: string): boolean {
  return (
    text.includes(DYNAMIC_SEGMENTER.sha256) &&
    text.includes(DYNAMIC_SEGMENTER.revision) &&
    text.includes(DYNAMIC_SEGMENTER.source)
  );
}

/**
 * Enrich an MPS-unavailable refusal with the actionable diagnostic (spec
 * #159 US-006, ADR-0020): expected weights path, pin, fetch command, and
 * the MPS/no-fallback requirement. Defense in depth behind the script's
 * own message — the one diagnostic text (`missingWeightsMessage`) stays
 * the single home for the fix, so all three prerequisite failures read
 * the same. A process text that already names the fix passes through
 * untouched, keeping the message compact.
 */
function withMpsDiagnostic(base: string, procText: string, why: string): string {
  if (hasPrereqFacts(procText)) return base;
  return `${base}\n${missingWeightsMessage(why)}`;
}

/** What the one-shot inference process reported on stdout. */
export interface InferenceObservation {
  maskPath: string;
  device: typeof BACKEND_MPS;
}

/**
 * Parse the single-process boundary: the process speaks MPS or the matte
 * fails. A non-MPS observation is a loud backend failure, never a silent
 * device switch; a nonzero exit carries stderr; unparseable or negative
 * output never produces a mask. MPS-unavailable refusals always carry the
 * actionable diagnostic (expected weights path, pin, fetch command, MPS
 * requirement): the script names them itself, and this seam appends the
 * one diagnostic text when an older process text lacks them.
 */
export function parseInferenceResult(
  stdout: string,
  stderr: string,
  exitCode: number,
): InferenceObservation {
  const tail = stderr.trim().slice(-2000);
  if (exitCode !== 0) {
    const base =
      `Local matting failed (exit ${exitCode}): ${tail || "the inference process reported no error"}`;
    if (isMpsUnavailable(`${stdout}\n${tail}`))
      throw new Error(
        withMpsDiagnostic(
          base,
          `${stdout}\n${tail}`,
          "MPS is not available on this machine — the single inference process refused before writing any mask",
        ),
      );
    throw new Error(base);
  }
  let rec: unknown;
  try {
    rec = JSON.parse(stdout);
  } catch {
    throw new Error(
      `Local matting returned unparseable output: ${stdout.slice(0, 500) || "(empty stdout)"}${tail ? `\nstderr: ${tail}` : ""}`,
    );
  }
  const r = rec as { ok?: unknown; error?: unknown; mask?: unknown; device_observable?: unknown };
  if (typeof r !== "object" || r === null || r.ok !== true) {
    const detail =
      typeof (r as { error?: unknown } | null)?.error === "string" &&
      (r as { error: string }).error !== ""
        ? (r as { error: string }).error
        : "the inference process reported failure";
    const base = `Local matting failed: ${detail}${tail ? `\nstderr: ${tail}` : ""}`;
    if (isMpsUnavailable(`${detail}\n${tail}`))
      throw new Error(
        withMpsDiagnostic(
          base,
          `${detail}\n${tail}`,
          "MPS is not available on this machine — the single inference process refused before writing any mask",
        ),
      );
    throw new Error(base);
  }
  if (r.device_observable !== BACKEND_MPS)
    throw new Error(
      withMpsDiagnostic(
        `Local matting ran on backend ${JSON.stringify(r.device_observable)}, not MPS — ` +
          `there is no CPU or CoreML fallback, so nothing was published. ` +
          `Run on Apple Silicon with a PyTorch MPS build.`,
        tail,
        `the inference process ran on ${JSON.stringify(r.device_observable)} instead of MPS — inference needs Apple Silicon with a PyTorch MPS build`,
      ),
    );
  if (typeof r.mask !== "string" || r.mask === "")
    throw new Error(`Local matting reported success but named no mask file — nothing was published`);
  return { maskPath: r.mask, device: BACKEND_MPS };
}

/**
 * Run the one production inference: exactly one `uv` process per matte.
 * MPS is asserted inside that process before any mask is written; the Hub is
 * never contacted (`HF_HUB_OFFLINE=1` — architecture and weights come from
 * the local caches warmed once at fetch time), and uv itself runs
 * `--offline`, so PyPI is never contacted either.
 */
async function runDynamicInference(
  bytes: Uint8Array,
): Promise<{ mask: Uint8Array; device: typeof BACKEND_MPS }> {
  try {
    readPngHeader(bytes);
  } catch (err) {
    if (err instanceof PngParseError)
      throw new Error(`The candidate cannot be segmented: ${err.message}`);
    throw err;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "ply-matte-"));
  try {
    const input = path.join(dir, "input.png");
    const outMask = path.join(dir, "mask.png");
    await writeFile(input, bytes);
    let proc;
    try {
      proc = Bun.spawn(
        [
          "uv",
          "run",
          "--locked",
          // Cache-only: with weights present, a matte must make no network
          // call — neither the Hub (see HF_HUB_OFFLINE below) nor PyPI.
          // First fetch and --warm-cache stay online; they are manual steps.
          "--offline",
          "--script",
          dynamicScriptPath(),
          "--weights",
          weightsPath(),
          "--input",
          input,
          "--out-mask",
          outMask,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HF_HUB_OFFLINE: "1" },
        },
      );
    } catch (err) {
      throw new Error(
        `Local matting needs the "uv" launcher on PATH to run the pinned inference process: ${(err as Error).message}`,
        { cause: err },
      );
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const { maskPath, device } = parseInferenceResult(stdout, stderr, exitCode);
    // The process must hand back the mask it was asked to write — a drifted
    // script must not redirect ingestion to an arbitrary path.
    if (maskPath !== outMask)
      throw new Error(
        `Local matting named mask ${JSON.stringify(maskPath)}, not the requested output — nothing was published`,
      );
    let mask: Buffer;
    try {
      mask = await readFile(maskPath);
    } catch (err) {
      throw new Error(
        `Local matting reported success but its mask cannot be read (${maskPath}): ${(err as Error).message}`,
        { cause: err },
      );
    }
    return { mask, device };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Verify the pin before any of it is needed.
 *
 * This is the engine's `preflight`: it checks the weights file and hash in
 * TypeScript, before inference and before publish, so missing or off-pin
 * weights stop the operation while nothing is spent. MPS itself is asserted
 * inside the single inference process (there is no second `uv --check`
 * process — that would double cold start and miss the seconds-level bar).
 */
export async function ensureSegmenterReady(): Promise<void> {
  await verifyWeights();
}

/**
 * The shipped matting engine: predict the subject mask locally on
 * PyTorch/MPS, then apply it as the candidate's alpha channel.
 * Segmentation, never colour distance; no network call at matting time once
 * the weights are cached.
 */
export function localSegmentationMatteEngine(): MatteEngine {
  const engine = async ({ bytes, label }: { bytes: Uint8Array; label: string }) => {
    // Scope "engine": wall time of this call after preflight, covering the
    // one and only inference process — startup, weight load, inference, and
    // mask write. The matting pass always preflights before invoking the
    // engine, so the weights pin is already verified here and this process
    // is always fresh: never mix this figure with a warm-loaded one.
    // Monotonic clock: a wall-clock step must never produce a negative figure.
    const started = performance.now();
    await verifyWeights();
    const { mask, device } = await runDynamicInference(bytes);
    const composed = composeMatte(bytes, mask, label);
    return {
      bytes: composed,
      engine: ENGINE_ID,
      warnings: [],
      backend: device,
      timing: { millis: Math.max(0, Math.round(performance.now() - started)), scope: "engine" },
    };
  };
  return Object.assign(engine, { preflight: ensureSegmenterReady });
}
