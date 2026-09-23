/**
 * GPT Image 2.5 Flare and Sunburst registration (#270): each key carries only
 * the capabilities its real Gateway probes proved (typed References, the
 * low/medium/high tiers, explicit size), and every surface that names
 * quality-capable models reads the one registry — help and the refusal no
 * longer claim GPT Image 2 is the only model with tiers. Deterministic
 * injected providers only — never billed, never online.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, type GenerationCliDeps } from "../src/generation-cli.js";
import type { UniformProvider } from "../src/generation.js";

const NEW_MODELS = [
  { key: "gpt-image-flare", id: "openai/gpt-image-2.5-flare" },
  { key: "gpt-image-sunburst", id: "openai/gpt-image-2.5-sunburst" },
] as const;

let root: string;
let jobsRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-gpt25-"));
  jobsRoot = path.join(root, "generation");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function capturingProvider(): UniformProvider & { imageArgs: Parameters<UniformProvider["image"]>[0][] } {
  const imageArgs: Parameters<UniformProvider["image"]>[0][] = [];
  return {
    imageArgs,
    image: async (args) => {
      imageArgs.push(args);
      return { images: [{ base64: Buffer.from(`g25-${imageArgs.length}`).toString("base64") }], warnings: [] };
    },
    text: async () => {
      throw new Error("TRIPWIRE: GPT Image models take the image call shape");
    },
  };
}

function deps(provider: UniformProvider): Partial<GenerationCliDeps> {
  return { provider, jobsRoot };
}

describe("GPT Image 2.5 Flare and Sunburst (#270)", () => {
  test("--help lists both keys as models and as quality-capable", async () => {
    const res = await run(["--help"], deps(capturingProvider()));
    expect(res.exitCode).toBe(0);
    const quality = res.text.slice(res.text.indexOf("--quality"), res.text.indexOf("--count"));
    for (const { key } of NEW_MODELS) {
      expect(res.text).toContain(key);
      expect(quality).toContain(key);
    }
    expect(quality).not.toMatch(/GPT Image 2 \(gpt-image\) only/);
  });

  for (const { key, id } of NEW_MODELS) {
    test(`${key}: a Job with a typed Reference is accepted and sent on the image call shape`, async () => {
      const ref = path.join(root, "anchor.png");
      await writeFile(ref, "anchor-bytes");
      const provider = capturingProvider();
      const res = await run(["a portrait", "--model", key, "--ref", ref, "--size", "1024x1536", "--json"], deps(provider));
      expect(res.exitCode).toBe(0);
      expect(provider.imageArgs).toHaveLength(1);
      expect(provider.imageArgs[0].model).toBe(id);
      expect(provider.imageArgs[0].size).toBe("1024x1536");
      expect((provider.imageArgs[0].prompt as { images: Uint8Array[] }).images).toEqual([Buffer.from("anchor-bytes")]);
    });

    test(`${key}: every proven tier is forwarded and retained`, async () => {
      for (const quality of ["low", "medium", "high"] as const) {
        const provider = capturingProvider();
        const res = await run(["a barn", "--model", key, "--quality", quality, "--json"], deps(provider));
        expect(res.exitCode).toBe(0);
        expect(provider.imageArgs[0].quality).toBe(quality);
        expect((res.json as any).job.run.quality).toBe(quality);
      }
    });

    test(`${key}: --model <raw gateway id> resolves to the registered claims`, async () => {
      const provider = capturingProvider();
      const res = await run(["a barn", "--model", id, "--quality", "high", "--json"], deps(provider));
      expect(res.exitCode).toBe(0);
      expect(provider.imageArgs[0].quality).toBe("high");
    });
  }

  test("the quality refusal names every quality-capable model from the registry", async () => {
    const provider = capturingProvider();
    const res = await run(["a barn", "--model", "nano-2", "--quality", "high", "--json"], deps(provider));
    expect(res.exitCode).toBe(1);
    const error = (res.json as any).error as string;
    expect(error).not.toMatch(/GPT Image 2 only/);
    for (const key of ["gpt-image", "gpt-image-flare", "gpt-image-sunburst"]) expect(error).toContain(key);
    expect(provider.imageArgs).toHaveLength(0);
  });
});
