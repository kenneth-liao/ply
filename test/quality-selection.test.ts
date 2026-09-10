/**
 * Explicit GPT Image 2 quality selection (#142, spec #132 US-005, TEST-005):
 * the public CLI accepts --quality low|medium|high for the qualified GPT
 * Image 2 model, forwards the requested value through the provider seam,
 * retains it as request AND effective run provenance, refuses unsupported
 * model/quality combinations before any provider call (no invented nano-2
 * tiers, no raw-id claims), and leaves no-choice records honestly empty of
 * quality. Deterministic injected providers only — never billed, never
 * online.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, type GenerationCliDeps } from "../src/generation-cli.js";
import type { UniformProvider } from "../src/generation.js";

let root: string;
let jobsRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-quality-"));
  jobsRoot = path.join(root, "generation");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A provider capturing exactly what reaches the outbound seam. */
function capturingProvider(): UniformProvider & {
  imageArgs: Parameters<UniformProvider["image"]>[0][];
  textArgs: Parameters<UniformProvider["text"]>[0][];
} {
  const imageArgs: Parameters<UniformProvider["image"]>[0][] = [];
  const textArgs: Parameters<UniformProvider["text"]>[0][] = [];
  return {
    imageArgs,
    textArgs,
    image: async (args) => {
      imageArgs.push(args);
      return { images: [{ base64: Buffer.from(`q-${imageArgs.length}`).toString("base64") }], warnings: [] };
    },
    text: async (args) => {
      textArgs.push(args);
      return { files: [{ mediaType: "image/png", uint8Array: Buffer.from(`qt-${textArgs.length}`) }], text: "", warnings: [] };
    },
  };
}

function deps(provider: UniformProvider): Partial<GenerationCliDeps> {
  return { provider, jobsRoot };
}

async function publishedIds(): Promise<string[]> {
  try {
    return (await readdir(jobsRoot)).filter((d) => !d.startsWith("."));
  } catch {
    return [];
  }
}

describe("ply generate --quality — explicit GPT Image 2 quality (#142)", () => {
  test("each qualified tier is forwarded and retained as request and run provenance", async () => {
    for (const quality of ["low", "medium", "high"] as const) {
      const provider = capturingProvider();
      const res = await run(
        ["a red barn at noon", "--model", "gpt-image", "--quality", quality, "--json"],
        deps(provider),
      );
      expect(res.exitCode).toBe(0);
      // Forwarded through the image seam — the call shape gpt-image takes.
      expect(provider.imageArgs).toHaveLength(1);
      expect(provider.imageArgs[0].quality).toBe(quality);
      expect(provider.textArgs).toHaveLength(0);
      // Effective provenance: the selected quality in both request and run.
      const json = res.json as Record<string, any>;
      expect(json.job.request.quality).toBe(quality);
      expect(json.job.run.quality).toBe(quality);
    }
  });

  test("the registered raw gateway id carries the same qualified claim", async () => {
    const provider = capturingProvider();
    const res = await run(
      ["a barn", "--model", "openai/gpt-image-2", "--quality", "high", "--json"],
      deps(provider),
    );
    expect(res.exitCode).toBe(0);
    expect(provider.imageArgs[0].quality).toBe("high");
    expect((res.json as any).job.run.quality).toBe("high");
  });

  test("an unselected quality records no fabricated choice", async () => {
    const provider = capturingProvider();
    const res = await run(["a barn", "--model", "gpt-image", "--json"], deps(provider));
    expect(res.exitCode).toBe(0);
    const json = res.json as Record<string, any>;
    // The record gains no quality key: the provider's own default applied,
    // and no historical choice is invented.
    expect("quality" in json.job.request).toBe(false);
    expect("quality" in json.job.run).toBe(false);
    expect(provider.imageArgs[0].quality).toBeUndefined();
  });

  test("an unsupported combination fails before any provider call — no invented nano-2 tiers", async () => {
    const provider = capturingProvider();
    const res = await run(["a barn", "--quality", "high", "--json"], deps(provider));
    expect(res.exitCode).toBe(1);
    const json = res.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect((json.error as string)).toMatch(/quality/i);
    expect((json.error as string)).toMatch(/google\/gemini-3\.1-flash-image/);
    // Nothing called, nothing published.
    expect(provider.imageArgs).toHaveLength(0);
    expect(provider.textArgs).toHaveLength(0);
    expect(await publishedIds()).toEqual([]);
  });

  test("an unregistered raw gateway id gains no quality claim", async () => {
    const provider = capturingProvider();
    const res = await run(
      ["a barn", "--model", "bytedance/seedream-5.0-pro", "--quality", "low", "--json"],
      deps(provider),
    );
    expect(res.exitCode).toBe(1);
    expect((res.json as any).error).toMatch(/quality/i);
    expect(provider.imageArgs).toHaveLength(0);
    expect(await publishedIds()).toEqual([]);
  });

  test("a malformed tier is a usage error (exit 2)", async () => {
    const provider = capturingProvider();
    for (const argv of [["a barn", "--quality", "banana"], ["a barn", "--quality"]]) {
      const res = await run(argv, deps(provider));
      expect(res.exitCode).toBe(2);
      expect((res.json as any).error).toMatch(/--quality/);
    }
    expect(provider.imageArgs).toHaveLength(0);
    expect(await publishedIds()).toEqual([]);
  });

  test("show reports the selected quality; compact text names it", async () => {
    await run(["a barn", "--model", "gpt-image", "--quality", "medium", "--job", "gen-q", "--json"], deps(capturingProvider()));
    const shown = await run(["show", "gen-q", "--json"], {
      provider: { image: async () => { throw new Error("TRIPWIRE"); }, text: async () => { throw new Error("TRIPWIRE"); } },
      jobsRoot,
    });
    expect(shown.exitCode).toBe(0);
    expect((shown.json as any).job.request.quality).toBe("medium");
    expect((shown.json as any).job.run.quality).toBe("medium");
    expect(shown.text).toContain("medium");
    // The offline list summary reports it too.
    const listed = await run(["list", "--json"], {
      provider: { image: async () => { throw new Error("TRIPWIRE"); }, text: async () => { throw new Error("TRIPWIRE"); } },
      jobsRoot,
    });
    expect(listed.exitCode).toBe(0);
    expect((listed.json as any).jobs[0]).toMatchObject({ quality: "medium" });
    expect(listed.text).toContain("(medium)");
  });

  test("show and list refuse --quality as an offline inspection flag (exit 2)", async () => {
    for (const argv of [["show", "gen-x", "--quality", "low"], ["list", "--quality", "high"]]) {
      const res = await run(argv, deps(capturingProvider()));
      expect(res.exitCode).toBe(2);
      expect((res.json as any).error).toMatch(/--quality/);
    }
  });

  test("--help documents --quality with the GPT Image 2 qualification", async () => {
    const res = await run(["--help"], deps(capturingProvider()));
    expect(res.exitCode).toBe(0);
    expect(res.text).toContain("--quality");
    expect(res.text).toContain("gpt-image");
  });
});
