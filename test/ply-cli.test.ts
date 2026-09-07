import { expect, test } from "bun:test";
import path from "node:path";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

async function invoke(...args: string[]) {
  const result = Bun.spawn([process.execPath, cli, ...args], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited,
  ]);
  return { stdout, stderr, code };
}

test("ply routes scene commands with their arguments and JSON intact", async () => {
  const result = await invoke("scene", "schema");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toBeObject();
  expect(result.stderr).toBe("");
});

test("ply help names only available modules", async () => {
  const result = await invoke("--help");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Ply");
  for (const [module, code] of [["scene", 2], ["library", 0], ["jobs", 2]] as const) {
    expect(result.stdout).toContain(module);
    // Preserve the existing surfaces: scene/jobs classify help as usage (2).
    const help = await invoke(module, "--help");
    expect(help.code).toBe(code);
    expect(help.stdout).toContain(module);
  }
});

test("ply rejects unknown modules and preserves module failures", async () => {
  expect((await invoke("not-a-module")).code).toBe(2);
  const result = await invoke("scene", "validate", "does-not-exist.scene.json");
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).ok).toBe(false);
});
