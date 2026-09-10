/**
 * The shared generation provider-call machinery (spec #102): the one home of
 * the image-kind provider request shape, reference read-and-verify, and
 * warning flattening. The category-specific prompt builders and
 * plate/object/creator generation workflows were retired with the legacy
 * `jobs plates|objects|creators|rerun` entry points (#114) — the one uniform
 * generation operation lives in src/generation.ts and builds its provider
 * requests through `buildImageRequestArgs`, so the call shape cannot drift.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { isImageQuality, validateQualitySupport, type ImageQuality, type ModelSpec } from "./models.js";

export type TextZone = "left" | "right" | "bottom" | "none";

/** AI SDK warnings are objects; flatten to one readable line. */
export function describeWarning(model: string, w: unknown): string {
  const o = w as { type?: string; feature?: string; setting?: string; details?: string; message?: string };
  const what = o?.feature ?? o?.setting ?? o?.type ?? "setting";
  return `${model}: ${o?.details ?? o?.message ?? `unsupported ${what}`}`;
}

/**
 * The one home of the image-kind provider request shape: the registry-resolved
 * model id, reference adaptation (raw bytes in GenerateImagePrompt.images), and
 * the caller's explicit sizing. Production uniform generation builds its
 * request through this function (with the normalized sizing every request
 * carries), so the harness and tests certify the exact call shape production
 * takes. Image-branch only by construction: a multimodal model has no image
 * request to build — it takes generateText with message parts.
 */
export function buildImageRequestArgs(
  spec: ModelSpec,
  prompt: string,
  refBytes: Uint8Array[],
  /** The caller-selected sizing — required; there is no implicit default. */
  explicitSizing: { size: `${number}x${number}` } | { aspectRatio: `${number}:${number}` },
  /** The caller-selected quality (#142) — present only when the request selected one. */
  quality?: ImageQuality,
): {
  model: string;
  prompt: string | { text: string; images: Uint8Array[] };
  size?: `${number}x${number}`;
  aspectRatio?: `${number}:${number}`;
  quality?: ImageQuality;
} {
  if (spec.kind !== "image") {
    throw new Error(
      `buildImageRequestArgs is the image-kind call shape — "${spec.id}" is ${spec.kind} and takes generateText with message parts, not generateImage`,
    );
  }
  if (quality !== undefined) {
    // The canonical capability refusal (SPEC-1/CRAFT-3, #142 review): the one
    // home in models.ts, never a second message shape.
    if (!isImageQuality(quality))
      throw new Error(
        `Unknown quality ${JSON.stringify(String(quality))} — --quality takes low, medium, or high`,
      );
    validateQualitySupport(spec, quality);
  }
  if ("size" in explicitSizing) {
    if (spec.sizing !== "size")
      throw new Error(
        `Model "${spec.id}" takes an aspect ratio, not explicit pixel dimensions — pass --aspect W:H instead of --size`,
      );
    return {
      model: spec.id,
      ...(refBytes.length ? { prompt: { text: prompt, images: refBytes } } : { prompt }),
      size: explicitSizing.size,
      ...(quality !== undefined ? { quality } : {}),
    };
  }
  return {
    model: spec.id,
    ...(refBytes.length ? { prompt: { text: prompt, images: refBytes } } : { prompt }),
    aspectRatio: explicitSizing.aspectRatio,
    ...(quality !== undefined ? { quality } : {}),
  };
}

/** A reference whose exact bytes are already loaded — no re-read, no drift. */
export interface LoadedRef {
  path: string;
  bytes: Uint8Array;
}
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Read one reference file and verify its bytes against a recorded identity —
 * the one read-and-verify home every workflow's generation shares (CRAFT-1):
 * the path is resolved exactly once here, and the returned bytes are exactly
 * what the model is sent, so the provider can never receive different content
 * than the Job records (INT: request-to-generation drift is refused, not
 * sent). A reference without a recorded identity is loaded without
 * verification because there is nothing to compare it with; a role, when
 * present, names the reference in every diagnostic.
 */
export async function loadVerifiedReference(input: {
  path: string;
  role?: string;
  contentHash?: string;
}): Promise<LoadedRef> {
  // Resolve the path once, at this boundary — every use below (read, error,
  // drift message) names the same resolved location.
  const resolved = path.resolve(input.path);
  const label = input.role ? ` (role ${input.role})` : "";
  let bytes: Buffer;
  try {
    bytes = await readFile(resolved);
  } catch {
    throw new Error(
      `Reference "${resolved}"${label} is missing — cannot start the generation`,
    );
  }
  if (input.contentHash !== undefined) {
    const actual = sha256(bytes);
    if (actual !== input.contentHash)
      throw new Error(
        `Reference "${resolved}"${label} changed content identity after the request was recorded — sha-256 ${input.contentHash}, actual ${actual}. Record a new job for different references.`,
      );
  }
  return { path: resolved, bytes };
}
