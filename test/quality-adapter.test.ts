/**
 * The real production adapter's quality emission (#142, TEST-005): with the
 * `ai` SDK mocked, ply's own PRODUCTION_UNIFORM_PROVIDER must carry the
 * selected quality inside `providerOptions.openai.quality` — the provider-
 * options channel verified (against the installed SDK, ai 7.0.82 /
 * @ai-sdk/gateway 4.0.67) to reach the Gateway image request body verbatim.
 * The Gateway's mapping of that option onto the upstream quality parameter
 * is Gateway-service behavior, documented by Vercel — not provable locally;
 * this test pins exactly what ply emits, so the assumption has a pinned
 * boundary. No network, no billing.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type GenerateImageArgs = Record<string, unknown>;
const imageCalls: GenerateImageArgs[] = [];

mock.module("ai", () => ({
  generateImage: async (args: GenerateImageArgs) => {
    imageCalls.push(args);
    return { images: [{ base64: Buffer.from("adapter-fake").toString("base64") }], warnings: [] };
  },
  generateText: async () => {
    throw new Error("TRIPWIRE: quality adapter test must not use the text seam");
  },
}));

let root: string;
let jobsRoot: string;

beforeEach(async () => {
  imageCalls.length = 0;
  root = await mkdtemp(path.join(tmpdir(), "ply-quality-adapter-"));
  jobsRoot = path.join(root, "generation");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("PRODUCTION_UNIFORM_PROVIDER — quality reaches the gateway request channel (#142)", () => {
  test("the selected quality is emitted inside providerOptions.openai.quality", async () => {
    // Imported lazily so the mock is definitely armed first.
    const { run } = await import("../src/generation-cli.js");
    const res = await run(
      ["a red barn at noon", "--model", "gpt-image", "--quality", "low", "--json"],
      { jobsRoot },
    );
    expect(res.exitCode).toBe(0);
    expect(imageCalls).toHaveLength(1);
    expect(imageCalls[0].model).toBe("openai/gpt-image-2");
    expect(imageCalls[0].providerOptions).toEqual({ openai: { quality: "low" } });

    // Unselected: no quality is emitted at all — no fabricated default.
    imageCalls.length = 0;
    const res2 = await run(["a barn", "--model", "gpt-image", "--job", "gen-q2", "--json"], { jobsRoot });
    expect(res2.exitCode).toBe(0);
    expect(imageCalls[0].providerOptions).toBeUndefined();
  });

  test("a non-quality request keeps the exact legacy call shape", async () => {
    const { run } = await import("../src/generation-cli.js");
    const res = await run(
      ["a barn", "--model", "gpt-image", "--size", "1080x1080", "--job", "gen-shape", "--json"],
      { jobsRoot },
    );
    expect(res.exitCode).toBe(0);
    expect(Object.keys(imageCalls[0]).sort()).toEqual(["model", "prompt", "size"]);
  });
});
