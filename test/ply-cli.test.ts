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
  const result = await invoke("scene", "schema", "--json");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toBeObject();
  expect(result.stderr).toBe("");
});

test("ply help names only available modules", async () => {
  const result = await invoke("--help");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Ply");
  for (const [module, code] of [
    ["project", 0],
    ["composition", 0],
    ["layer", 0],
    ["generate", 0],
    ["matte", 0],
    ["scene", 0],
    ["library", 0],
    ["jobs", 0],
  ] as const) {
    expect(result.stdout).toContain(module);
    // Help succeeds on every exposed module (F12); exit 0, focused text.
    const help = await invoke(module, "--help");
    expect(help.code).toBe(code);
    expect(help.stdout).toContain(module);
    // --help --json is one valid JSON result containing the help (F12).
    const helpJson = await invoke(module, "--help", "--json");
    expect(helpJson.code).toBe(0);
    expect(JSON.parse(helpJson.stdout)).toMatchObject({ ok: true });
    expect(JSON.parse(helpJson.stdout).help).toContain(module);
    // Canonical invocation spellings in help (F15): no legacy script forms.
    expect(help.stdout).not.toContain("bun run");
  }
});

test("ply rejects unknown modules and preserves module failures", async () => {
  expect((await invoke("not-a-module")).code).toBe(2);
  const result = await invoke("scene", "validate", "does-not-exist.scene.json");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("does-not-exist");
  // The structured failure stays available under --json.
  const asJson = await invoke("scene", "validate", "does-not-exist.scene.json", "--json");
  expect(asJson.code).toBe(1);
  expect(JSON.parse(asJson.stdout).ok).toBe(false);
});

test("generate rejects a missing prompt through the public entry point", async () => {
  const result = await invoke("generate");
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("prompt");
});

test("matte rejects a missing image through the public entry point", async () => {
  const result = await invoke("matte");
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("ply matte");
});
