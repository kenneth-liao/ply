/**
 * The uniform Generation Job domain (spec #102 ticket #104, US-001/US-002):
 * prompt-only requests with full-canvas or isolated intent, caller-selected
 * sizing, no subject policy, publication of the effective request/outputs/
 * provenance, and publication-failure discipline.
 *
 * The provider seam is injected — the unit suite never bills or touches the
 * network. The Matting tripwire proves the surface never imports or runs the
 * local Matting engine (US-002: generation works without Matting weights).
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildUniformPrompt,
  executeUniformGeneration,
  GENERATION_JOB_SCHEMA_VERSION,
  ingestUniformRequest,
  listGenerationJobs,
  loadGenerationJob,
  runUniformGeneration,
  validateUniformRequest,
  type IngestedUniformRequest,
  type UniformGenerationRequest,
  type UniformProvider,
  type UniformSizing,
} from "../src/generation.js";
import { resolveModel } from "../src/models.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-generation-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A recording provider: captures the exact args each call received. */
function fakeProvider(
  over?: Partial<UniformProvider>,
): UniformProvider & { imageCalls: unknown[]; textCalls: unknown[] } {
  let n = 0;
  const imageCalls: unknown[] = [];
  const textCalls: unknown[] = [];
  return {
    imageCalls,
    textCalls,
    async image(args) {
      imageCalls.push(args);
      if (over?.image) return over.image(args);
      return {
        images: [{ base64: Buffer.from(`fake-bytes-${n++}`).toString("base64") }],
        warnings: [],
      };
    },
    async text(args) {
      textCalls.push(args);
      if (over?.text) return over.text(args);
      return {
        files: [{ mediaType: "image/png", uint8Array: Buffer.from(`fake-text-bytes-${n++}`) }],
        text: "",
        warnings: [],
      };
    },
  };
}

const base: UniformGenerationRequest & { sizing: UniformSizing } = {
  prompt: "a lighthouse at dusk",
  intent: "full-canvas",
  model: "gpt-image",
  sizing: { kind: "size", width: 1080, height: 1080 },
  count: 1,
};

function jobRoot(): string {
  return path.join(root, "generation");
}

async function expectNoPublication(): Promise<void> {
  const dir = path.join(jobRoot(), "gen-test");
  expect(existsSync(path.join(dir, "job.json"))).toBe(false);
  if (existsSync(dir)) expect(await readdirNames(dir)).toEqual([]);
}

async function readdirNames(dir: string): Promise<string[]> {
  return readdir(dir);
}

describe("validateUniformRequest", () => {
  test("accepts a valid request and resolves the model spec", () => {
    const { spec } = validateUniformRequest(base);
    expect(spec.id).toBe("openai/gpt-image-2");
  });

  test("rejects an empty or whitespace-only prompt", () => {
    expect(() => validateUniformRequest({ ...base, prompt: "   " })).toThrow(/prompt/i);
  });

  test("rejects count outside 1..8", () => {
    expect(() => validateUniformRequest({ ...base, count: 0 })).toThrow(/count/i);
    expect(() => validateUniformRequest({ ...base, count: 9 })).toThrow(/count/i);
    expect(() => validateUniformRequest({ ...base, count: 1.5 })).toThrow(/count/i);
  });

  test("rejects an unknown intent", () => {
    expect(() =>
      validateUniformRequest({ ...base, intent: "cutout" as never }),
    ).toThrow(/intent/i);
  });

  test("rejects malformed size and aspect formats", () => {
    for (const sizing of [
      { kind: "size", width: 0, height: 100 },
      { kind: "size", width: -5, height: 100 },
      { kind: "aspectRatio", ratio: "16/9" },
      { kind: "aspectRatio", ratio: "0:9" },
      { kind: "aspectRatio", ratio: "abc" },
    ] as never[]) {
      expect(() => validateUniformRequest({ ...base, sizing })).toThrow(/sizing|aspect/i);
    }
  });

  test("refuses a size-sizing mismatch with the model's provider shape — before any call", () => {
    expect(() =>
      validateUniformRequest({ ...base, model: "nano-2" }),
    ).toThrow(/--aspect/i);
    expect(() =>
      validateUniformRequest({
        ...base,
        model: "gpt-image",
        sizing: { kind: "aspectRatio", ratio: "16:9" },
      }),
    ).toThrow(/--size/i);
  });

  test("temperature is multimodal-only", () => {
    expect(() => validateUniformRequest({ ...base, temperature: 0.5 })).toThrow(
      /temperature/i,
    );
    const ok = validateUniformRequest({
      ...base,
      model: "nano-2",
      sizing: { kind: "aspectRatio", ratio: "1:1" },
      temperature: 0.7,
    });
    expect(ok.spec.kind).toBe("multimodal");
  });

  test("unknown model names the options", () => {
    expect(() => validateUniformRequest({ ...base, model: "nope" })).toThrow(
      /Unknown model/,
    );
  });
});

describe("buildUniformPrompt", () => {
  test("full-canvas sends the caller's prompt verbatim — no zone, no bans, no recipe", () => {
    const prompt = buildUniformPrompt(base, validateUniformRequest(base).spec);
    expect(prompt).toBe("a lighthouse at dusk");
  });

  test("isolated intent adds isolation framing only — never a transparency request", () => {
    const req: UniformGenerationRequest & { sizing: UniformSizing } = { ...base, intent: "isolated" };
    const prompt = buildUniformPrompt(req, validateUniformRequest(req).spec);
    expect(prompt).toContain("a lighthouse at dusk");
    expect(prompt).toContain("isolated");
    expect(prompt).toContain("plain");
    expect(prompt.toLowerCase()).not.toContain("transparent");
    expect(prompt.toLowerCase()).not.toContain("checkerboard");
    expect(prompt.toLowerCase()).not.toContain("alpha");
  });

  test("prompt text that names text, logos, or people passes through untouched", () => {
    for (const p of [
      "a UI panel with the headline 'LAUNCH DAY' rendered in the image",
      "a fictional logo for ACME rocketry, flat vector mark",
      "a portrait of a presenter, waist up, studio lighting",
    ]) {
      const prompt = buildUniformPrompt({ ...base, prompt: p }, validateUniformRequest(base).spec);
      expect(prompt).toContain(p);
    }
  });

  test("multimodal models with an aspect selection carry the ratio in the effective prompt", () => {
    const req: UniformGenerationRequest & { sizing: UniformSizing } = {
      ...base,
      model: "nano-2",
      sizing: { kind: "aspectRatio", ratio: "4:5" },
    };
    const prompt = buildUniformPrompt(req, validateUniformRequest(req).spec);
    expect(prompt).toContain("Output aspect ratio: 4:5");
    expect(prompt).toContain("a lighthouse at dusk");
  });

  test("full-canvas multimodal records the aspect in the effective prompt, including the 1:1 default", () => {
    const req: UniformGenerationRequest & { sizing: UniformSizing } = {
      ...base,
      model: "nano-2",
      sizing: { kind: "aspectRatio", ratio: "1:1" },
    };
    const prompt = buildUniformPrompt(req, validateUniformRequest(req).spec);
    expect(prompt).toContain("a lighthouse at dusk");
    expect(prompt).toContain("Output aspect ratio: 1:1");
  });
});

describe("runUniformGeneration", () => {
  test("full-canvas publishes the effective request, model, outputs, and provenance", async () => {
    const provider = fakeProvider();
    const job = await runUniformGeneration(jobRoot(), "gen-test", { ...base, count: 2 }, { provider });

    // The exact provider request: registry id, verbatim prompt, caller size.
    expect(provider.imageCalls).toHaveLength(2);
    for (const call of provider.imageCalls) expect(call).toEqual({
      model: "openai/gpt-image-2",
      prompt: "a lighthouse at dusk",
      size: "1080x1080",
    });

    expect(job.schemaVersion).toBe(GENERATION_JOB_SCHEMA_VERSION);
    expect(job.kind).toBe("generation");
    expect(job.request).toEqual({ ...base, count: 2 } as typeof job.request);
    expect(job.run.model).toBe("openai/gpt-image-2");
    expect(job.run.fullPrompt).toBe("a lighthouse at dusk");
    expect(job.run.outputs).toHaveLength(2);
    expect(job.run.costMeasured).toBe(true);
    expect(job.run.costUsd).toBeCloseTo(0.0045 * 2, 10);
    for (const out of job.run.outputs) {
      expect(out.file).toMatch(/^outputs\/[a-f0-9]{64}\.png$/);
      expect(out.contentHash).toMatch(/^[a-f0-9]{64}$/);
      // The published bytes are exactly what the identity claims.
      const bytes = await readFile(path.join(jobRoot(), "gen-test", out.file));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(out.contentHash);
    }
    // The record is on disk exactly as returned.
    const onDisk = JSON.parse(await readFile(path.join(jobRoot(), "gen-test", "job.json"), "utf8"));
    expect(onDisk).toEqual(job);
  });

  test("isolated intent records the warning that intent is not a matte", async () => {
    const provider = fakeProvider();
    const job = await runUniformGeneration(
      jobRoot(),
      "gen-test",
      { ...base, intent: "isolated" },
      { provider },
    );
    expect(provider.imageCalls).toEqual([
      { model: "openai/gpt-image-2", prompt: expect.stringContaining("isolated"), size: "1080x1080" },
    ]);
    expect(job.run.fullPrompt).toContain("isolated");
    expect(job.run.warnings.join("\n")).toMatch(/not.*matte|not verified/i);
  });

  test("multimodal requests go through the text seam with the ratio line", async () => {
    const provider = fakeProvider();
    const req: UniformGenerationRequest & { sizing: UniformSizing } = {
      ...base,
      model: "nano-2",
      sizing: { kind: "aspectRatio", ratio: "4:5" },
      temperature: 0.7,
    };
    const job = await runUniformGeneration(jobRoot(), "gen-test", req, { provider });
    expect(provider.textCalls).toHaveLength(1);
    expect(provider.textCalls[0]).toEqual({
      model: "google/gemini-3.1-flash-image",
      prompt: expect.stringContaining("Output aspect ratio: 4:5"),
      temperature: 0.7,
    });
    expect(job.run.model).toBe("google/gemini-3.1-flash-image");
    expect(provider.imageCalls).toHaveLength(0);
  });

  test("a missing-image response is refused — nothing is published as success", async () => {
    const provider = fakeProvider({ image: async () => ({ images: [], warnings: [] }) });
    await mkdir(jobRoot(), { recursive: true });
    await expect(
      runUniformGeneration(jobRoot(), "gen-test", base, { provider }),
    ).rejects.toThrow(/returned no image/);
    await expectNoPublication();
  });

  test("a provider error leaves no job record and no partial outputs", async () => {
    const provider = fakeProvider({
      image: async () => {
        throw new Error("provider exploded");
      },
    });
    await mkdir(jobRoot(), { recursive: true });
    await expect(
      runUniformGeneration(jobRoot(), "gen-test", { ...base, count: 3 }, { provider }),
    ).rejects.toThrow(/provider exploded/);
    await expectNoPublication();
  });

  test("a publication write failure leaves nothing published as success", async () => {
    // Block the outputs directory: a file where the directory must be created.
    const provider = fakeProvider();
    const dir = path.join(jobRoot(), "gen-test");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "outputs"), "not a directory");
    await expect(
      runUniformGeneration(jobRoot(), "gen-test", base, { provider }),
    ).rejects.toThrow(/outputs/i);
    expect(existsSync(path.join(dir, "job.json"))).toBe(false);
    await rm(jobRoot(), { recursive: true, force: true });
  });

  test("creating over an existing job id is refused before any provider call", async () => {
    const provider = fakeProvider();
    await runUniformGeneration(jobRoot(), "gen-test", base, { provider });
    await expect(
      runUniformGeneration(jobRoot(), "gen-test", base, { provider }),
    ).rejects.toThrow(/already exists/);
    expect(provider.imageCalls).toHaveLength(1);
  });
});

describe("loadGenerationJob and listGenerationJobs", () => {
  test("load round-trips a published record", async () => {
    const provider = fakeProvider();
    await runUniformGeneration(jobRoot(), "gen-test", base, { provider });
    const job = await loadGenerationJob(jobRoot(), "gen-test");
    expect(job.jobId).toBe("gen-test");
    expect(job.run.outputs).toHaveLength(1);
  });

  test("load refuses missing, unreadable, and contradictory records", async () => {
    await expect(loadGenerationJob(jobRoot(), "missing")).rejects.toThrow(/No generation job/);
    await mkdir(path.join(jobRoot(), "bad"), { recursive: true });
    await writeFile(path.join(jobRoot(), "bad", "job.json"), "{ not json");
    await expect(loadGenerationJob(jobRoot(), "bad")).rejects.toThrow(/unreadable/i);
    await rm(jobRoot(), { recursive: true, force: true });
    await mkdir(path.join(jobRoot(), "wrong"), { recursive: true });
    await writeFile(
      path.join(jobRoot(), "wrong", "job.json"),
      JSON.stringify({ schemaVersion: 1, jobId: "wrong", kind: "plate" }),
    );
    await expect(loadGenerationJob(jobRoot(), "wrong")).rejects.toThrow(/kind/i);
  });

  test("list summarizes published jobs and skips unreadable directories", async () => {
    const provider = fakeProvider();
    await runUniformGeneration(jobRoot(), "gen-a", base, { provider });
    await runUniformGeneration(
      jobRoot(),
      "gen-b",
      { ...base, intent: "isolated" },
      { provider },
    );
    await mkdir(path.join(jobRoot(), "junk"), { recursive: true });
    const jobs = await listGenerationJobs(jobRoot());
    expect(jobs.map((j) => j.jobId)).toEqual(["gen-a", "gen-b"]);
    expect(jobs[0]).toMatchObject({ intent: "full-canvas", outputs: 1 });
    expect(jobs[1]).toMatchObject({ intent: "isolated", outputs: 1 });
  });
});

/**
 * US-001 Reference ingestion (ticket #105): identities derived once at Job
 * creation, in caller order; unsupported capability and missing files refused
 * before any provider call.
 */
describe("ingestUniformRequest — Reference ingestion at Job creation", () => {
  async function ref(name: string, bytes: string): Promise<string> {
    const p = path.join(root, name);
    await writeFile(p, bytes);
    return p;
  }

  test("derives ordered sha-256 identities from the caller's paths", async () => {
    const a = await ref("a.png", "reference-bytes-a");
    const b = await ref("b.png", "reference-bytes-b");
    const c = await ref("c.png", "reference-bytes-c");
    const ingested = await ingestUniformRequest({ ...base, references: [a, b, c] });
    expect(ingested.request.references).toEqual([
      { path: a, contentHash: createHash("sha256").update("reference-bytes-a").digest("hex") },
      { path: b, contentHash: createHash("sha256").update("reference-bytes-b").digest("hex") },
      { path: c, contentHash: createHash("sha256").update("reference-bytes-c").digest("hex") },
    ]);
  });

  test("attachment order follows caller order, not any category reorder", async () => {
    const a = await ref("first.png", "one");
    const b = await ref("second.png", "two");
    const reversed = await ingestUniformRequest({ ...base, references: [b, a] });
    expect(reversed.request.references!.map((r) => r.path)).toEqual([b, a]);
  });

  test("a missing Reference file is refused before any provider call", async () => {
    await expect(
      ingestUniformRequest({ ...base, references: [path.join(root, "absent.png")] }),
    ).rejects.toThrow(/absent\.png.*missing|missing.*absent\.png/i);
  });

  test("a model without a qualified reference claim is refused before any byte is read", async () => {
    const a = await ref("a.png", "bytes");
    for (const model of ["flux", "bytedance/unregistered-raw-id"]) {
      await expect(
        ingestUniformRequest({ ...base, model, references: [a] }),
      ).rejects.toThrow(/not qualified reference-capable/);
    }
  });

  test("a zero-Reference request ingests without a references field", async () => {
    const ingested = await ingestUniformRequest(base);
    expect("references" in ingested.request).toBe(false);
  });
});

/**
 * US-001 execution (ticket #105): the canonical verified representation —
 * recorded identities — is verified against the files at generation, and the
 * exact verified bytes reach the provider in caller order. No alternate
 * unverified attachment path exists.
 */
describe("executeUniformGeneration — verified Reference bytes", () => {
  async function ingestedWithRefs(): Promise<{ ingested: IngestedUniformRequest; paths: string[] }> {
    const paths = [
      path.join(root, "r1.png"),
      path.join(root, "r2.png"),
      path.join(root, "r3.png"),
    ];
    await writeFile(paths[0], "reference-alpha");
    await writeFile(paths[1], "reference-beta");
    await writeFile(paths[2], "reference-gamma");
    const ingested = await ingestUniformRequest({ ...base, references: paths });
    return { ingested, paths };
  }

  test("image-kind requests receive the verified bytes in caller order", async () => {
    const provider = fakeProvider();
    const { ingested, paths } = await ingestedWithRefs();
    await executeUniformGeneration(jobRoot(), "gen-test", ingested, { provider });
    expect(provider.imageCalls).toHaveLength(1);
    const call = provider.imageCalls[0] as { prompt: { text: string; images: Uint8Array[] } };
    expect(call.prompt.images).toEqual([
      Buffer.from("reference-alpha"),
      Buffer.from("reference-beta"),
      Buffer.from("reference-gamma"),
    ]);
    expect(call.prompt.text).toBe("a lighthouse at dusk");
    expect(paths).toHaveLength(3);
  });

  test("multimodal requests carry the verified bytes in caller order on the text seam", async () => {
    const provider = fakeProvider();
    const { ingested } = await ingestedWithRefs();
    const multi: IngestedUniformRequest = {
      ...ingested,
      request: {
        ...ingested.request,
        model: "nano-2",
        sizing: { kind: "aspectRatio", ratio: "1:1" },
      },
      spec: validateUniformRequest({ ...base, model: "nano-2", sizing: { kind: "aspectRatio", ratio: "1:1" } }).spec,
    };
    await executeUniformGeneration(jobRoot(), "gen-multi", multi, { provider });
    expect(provider.textCalls).toHaveLength(1);
    expect((provider.textCalls[0] as { images?: Uint8Array[] }).images).toEqual([
      Buffer.from("reference-alpha"),
      Buffer.from("reference-beta"),
      Buffer.from("reference-gamma"),
    ]);
    expect(provider.imageCalls).toHaveLength(0);
  });

  test("a file changed between request capture and execution is refused — no provider call, no publication", async () => {
    const provider = fakeProvider();
    const { ingested, paths } = await ingestedWithRefs();
    await writeFile(paths[1], "mutated-after-capture");
    await expect(
      executeUniformGeneration(jobRoot(), "gen-drift", ingested, { provider }),
    ).rejects.toThrow(/changed content identity/);
    expect(provider.imageCalls).toHaveLength(0);
    expect(provider.textCalls).toHaveLength(0);
    await expectNoPublication();
  });

  test("a Reference deleted after capture is refused with no publication", async () => {
    const provider = fakeProvider();
    const { ingested, paths } = await ingestedWithRefs();
    await rm(paths[2]);
    await expect(
      executeUniformGeneration(jobRoot(), "gen-gone", ingested, { provider }),
    ).rejects.toThrow(/missing/i);
    expect(provider.imageCalls).toHaveLength(0);
    await expectNoPublication();
  });

  test("an unsupported model caught only at execution still refuses before the provider call", async () => {
    // Defense in depth: a tampered ingested request cannot smuggle References
    // onto an unqualified model past the execution boundary.
    const provider = fakeProvider();
    const raw = await ingestUniformRequest({ ...base, references: [path.join(root, "a.png")] }).catch(() => null);
    expect(raw).toBeNull(); // ingestion refuses; construct the bypass by hand instead
    const handBuilt: IngestedUniformRequest = {
      request: { ...base, references: [{ path: path.join(root, "a.png"), contentHash: "a".repeat(64) }] },
      spec: resolveModel("flux"),
    };
    await expect(
      executeUniformGeneration(jobRoot(), "gen-cap", handBuilt, { provider }),
    ).rejects.toThrow(/not qualified reference-capable/);
    expect(provider.imageCalls).toHaveLength(0);
  });

  test("published provenance records the ordered identities and honest cost for a text-only rate", async () => {
    const provider = fakeProvider();
    const { ingested } = await ingestedWithRefs();
    const job = await executeUniformGeneration(jobRoot(), "gen-refs", ingested, { provider });
    expect(job.request.references).toEqual(ingested.request.references);
    expect(job.request.references?.map((r) => r.path)).toEqual(ingested.request.references!.map((r) => r.path));
    // gpt-image's measured rate covers text-only calls (costCoversRefs: false):
    // a reference call records unknown cost with its basis stated.
    expect(job.run.costUsd).toBeNull();
    expect(job.run.costMeasured).toBe(false);
    expect(job.run.warnings.join("\n")).toMatch(/reference-call cost recorded as unknown/);
    const onDisk = JSON.parse(await readFile(path.join(jobRoot(), "gen-refs", "job.json"), "utf8"));
    expect(onDisk).toEqual(job);
  });

  test("a reference-capable model with a ref-covering rate keeps the measured cost", async () => {
    const provider = fakeProvider();
    const p = path.join(root, "a.png");
    await writeFile(p, "bytes");
    const ingested = await ingestUniformRequest({
      ...base,
      model: "nano-2",
      sizing: { kind: "aspectRatio", ratio: "1:1" },
      references: [p],
    });
    const job = await executeUniformGeneration(jobRoot(), "gen-covered", ingested, { provider });
    expect(job.run.costMeasured).toBe(true);
    expect(job.run.costUsd).toBeCloseTo(0.067, 10);
  });
});

describe("loadGenerationJob — Reference record validation", () => {
  test("contradictory references shapes are refused loudly", async () => {
    const provider = fakeProvider();
    await runUniformGeneration(jobRoot(), "gen-ok", base, { provider });
    const raw = JSON.parse(await readFile(path.join(jobRoot(), "gen-ok", "job.json"), "utf8"));
    raw.request.references = "not an array";
    await writeFile(path.join(jobRoot(), "gen-ok", "job.json"), JSON.stringify(raw));
    await expect(loadGenerationJob(jobRoot(), "gen-ok")).rejects.toThrow(/references/i);
  });

  test("a references entry without a valid sha-256 identity is refused", async () => {
    const provider = fakeProvider();
    await runUniformGeneration(jobRoot(), "gen-ok", base, { provider });
    const raw = JSON.parse(await readFile(path.join(jobRoot(), "gen-ok", "job.json"), "utf8"));
    raw.request.references = [{ path: "x.png", contentHash: "not-a-hash" }];
    await writeFile(path.join(jobRoot(), "gen-ok", "job.json"), JSON.stringify(raw));
    await expect(loadGenerationJob(jobRoot(), "gen-ok")).rejects.toThrow(/references/i);
  });
});

/**
 * US-002 tripwire: the local Matting engine must never even load for this
 * surface. The mock turns any import of the engine module into a hard failure;
 * the generation below runs with the production dependency wiring.
 */
mock.module("../src/segment.js", () => {
  throw new Error("TRIPWIRE: the uniform generation surface imported the Matting engine module");
});

describe("generation runs with Matting unavailable (tripwire armed)", () => {
  test("full-canvas and isolated intent complete with the engine module forbidden", async () => {
    // Import lazily inside the test so the mock is definitely armed first.
    const { run } = await import("../src/generation-cli.js");
    const provider = fakeProvider();
    const res = await run(
      ["a lighthouse at dusk", "--intent", "isolated", "--json"],
      { provider, jobsRoot: jobRoot() },
    );
    expect(res.exitCode).toBe(0);
    expect((res.json as Record<string, unknown>).ok).toBe(true);
    const res2 = await run(["a second scene", "--json"], { provider, jobsRoot: jobRoot() });
    expect(res2.exitCode).toBe(0);
  });
});