/**
 * No-network / no-generation qualification for the independent local Matting
 * command (spec #102 ticket #106, US-002, TEST-005):
 *
 * 1. Tripwire: the matting surface never imports the generation SDK module
 *    ("ai") — any accidental import turns into a hard failure. The run below
 *    uses the production dependency wiring.
 * 2. Kernel-level network denial (Darwin `sandbox-exec '(deny network*)'`)
 *    running the real CLI on a natively isolated source — the command
 *    completes offline. A negative-control probe proves the denial is active.
 *    Off Darwin the suite skips rather than claiming weaker isolation.
 *
 * Live-engine qualification with real weights is #112's ownership and is
 * never attempted here — the native-alpha path needs no inference at all.
 */
import { describe, test, expect, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng } from "./png.js";

/** Run the real CLI under kernel-level network denial (Darwin sandbox-exec). */
async function invokeOffline(cwd: string, args: string[]) {
  const result = Bun.spawn(
    [
      "sandbox-exec",
      "-p",
      "(version 1) (allow default) (deny network*)",
      process.execPath,
      cli,
      ...args,
    ],
    {
      cwd,
      stdout: "pipe", stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
    result.exited,
  ]);
  return { stdout, stderr, code };
}

const cli = path.resolve(import.meta.dir, "../src/matting-cli.ts");

describe("ply matte works offline — no generation import (tripwire armed)", () => {
  test("native-alpha and inference paths complete with the generation SDK module forbidden", async () => {
    // Import lazily inside the test so the mock is definitely armed first.
    const { run } = await import("../src/matting-cli.js");
    const root = await mkdtemp(path.join(tmpdir(), "ply-matting-offline-"));
    try {
      const native = encodePng(8, 8, (x, y) => (x < 4 ? [1, 2, 3, 255] : [4, 5, 6, 0]));
      const nativePath = path.join(root, "native.png");
      await writeFile(nativePath, native);
      const res = await run([nativePath, "--json"], {
        matteRoot: path.join(root, "matting"),
      });
      expect(res.exitCode).toBe(0);
      expect((res.json as Record<string, any>).matte.result.engine).toBe("native-alpha");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const darwinOnly = test.skipIf(process.platform !== "darwin");

darwinOnly(
  "the real CLI completes a native-alpha matting under kernel-level network denial",
  async () => {
    // Negative control first: prove the denial is active in this environment.
    const probe = Bun.spawn(
      [
        "sandbox-exec",
        "-p",
        "(version 1) (allow default) (deny network*)",
        process.execPath,
        "-e",
        `fetch("https://example.invalid/probe").then(() => process.exit(0)).catch(() => process.exit(42))`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await probe.exited).toBe(42);

    const root = await mkdtemp(path.join(tmpdir(), "ply-matting-sandbox-"));
    try {
      const native = encodePng(8, 8, (x, y) => (x < 4 ? [1, 2, 3, 255] : [4, 5, 6, 0]));
      const nativePath = path.join(root, "native.png");
      await writeFile(nativePath, native);
      const res = await invokeOffline(root, [nativePath, "--json"]);
      expect(res.code).toBe(0);
      const json = JSON.parse(res.stdout);
      expect(json.ok).toBe(true);
      expect(json.matte.result.engine).toBe("native-alpha");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

/**
 * US-002 tripwire: the uniform generation SDK must never even load for this
 * surface. The mock turns any import of the "ai" module into a hard failure;
 * the matting above runs with the production dependency wiring.
 */
mock.module("ai", () => {
  throw new Error("TRIPWIRE: the matting surface imported the generation SDK module");
});