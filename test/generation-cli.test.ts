/**
 * The uniform generation command's public CLI contract (spec #102 ticket #104,
 * US-001/US-005): compact default text, valid --json, exit codes 0/1/2,
 * actionable nonzero failures, offline inspection, no implicit Matting, and no
 * mutation of existing Projects on any failure path.
 *
 * The provider is injected at the CLI seam (deterministic, never billed);
 * subprocess coverage in ply-cli.test.ts exercises routing and the usage
 * contract that needs no provider.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initProject, inspectProject } from "../src/project.js";
import { run, type GenerationCliDeps } from "../src/generation-cli.js";
import type { UniformProvider } from "../src/generation.js";

let root: string;
let jobsRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-generation-cli-"));
  jobsRoot = path.join(root, "generation");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let n = 0;

/** Provider returning deterministic PNG-ish bytes for every request. */
function fakeProvider(over?: Partial<UniformProvider>): UniformProvider {
  const bytes = Buffer.from(`cli-fake-${n++}`);
  return {
    image: async () =>
      over?.image
        ? over.image({ model: "openai/gpt-image-2", prompt: "p", size: "1024x1024" })
        : { images: [{ base64: bytes.toString("base64") }], warnings: [] },
    text: async () =>
      over?.text
        ? over.text({ model: "google/gemini-3.1-flash-image", prompt: "p" })
        : {
            files: [{ mediaType: "image/png", uint8Array: bytes }],
            text: "",
            warnings: [],
          },
  };
}

/** A provider that must never be called — proves show/list/help are offline. */
const neverProvider: UniformProvider = {
  image: async () => {
    throw new Error("TRIPWIRE: generation must not run for this operation");
  },
  text: async () => {
    throw new Error("TRIPWIRE: generation must not run for this operation");
  },
};

function deps(provider: UniformProvider = fakeProvider()): Partial<GenerationCliDeps> {
  return { provider, jobsRoot };
}

async function publishedIds(): Promise<string[]> {
  try {
    return (await readdir(jobsRoot)).filter((d) => !d.startsWith("."));
  } catch {
    return [];
  }
}

describe("ply generate — success contract", () => {
  test("full-canvas with an explicit non-thumbnail size succeeds and publishes", async () => {
    const res = await run(
      ["a red barn at noon", "--model", "gpt-image", "--size", "1080x1080", "--json"],
      deps(),
    );
    expect(res.exitCode).toBe(0);
    const json = res.json as Record<string, any>;
    expect(json.ok).toBe(true);
    expect(json.jobId).toMatch(/^gen-[a-z0-9-]+$/);
    expect(json.job.request).toMatchObject({
      prompt: "a red barn at noon",
      intent: "full-canvas",
      sizing: { kind: "size", width: 1080, height: 1080 },
    });
    expect(json.job.run.model).toBe("openai/gpt-image-2");
    expect(json.job.run.fullPrompt).toBe("a red barn at noon");
    expect(json.job.run.outputs).toHaveLength(1);
    const file = path.join(json.jobDir, json.job.run.outputs[0].file);
    const bytes = await readFile(file);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      json.job.run.outputs[0].contentHash,
    );
  });

  test("isolated intent succeeds without any Matting and records the no-matte warning", async () => {
    const res = await run(
      ["a presenter portrait", "--intent", "isolated", "--json"],
      deps(),
    );
    expect(res.exitCode).toBe(0);
    const json = res.json as Record<string, any>;
    expect(json.job.request.intent).toBe("isolated");
    expect(json.job.run.warnings.join(" ")).toMatch(/not.*matte|not verified/i);
    expect(existsSync(path.join(json.jobDir, "mattes"))).toBe(false);
  });

  test("default output is compact text; --json emits strict JSON", async () => {
    const compact = await run(["a red barn", "--model", "gpt-image", "--size", "1024x1024"], deps());
    expect(compact.exitCode).toBe(0);
    // Compact: a handful of lines, not a JSON dump.
    expect(compact.text.split("\n").length).toBeLessThanOrEqual(8);
    expect(compact.text).toContain("a red barn");
    expect(compact.text).not.toContain("{");

    const jsonRes = await run(["a red barn", "--model", "gpt-image", "--size", "1024x1024", "--json"], deps());
    expect(() => JSON.parse(JSON.stringify(jsonRes.json))).not.toThrow();
    expect((jsonRes.json as Record<string, unknown>).ok).toBe(true);
  });

  test("multimodal models take --aspect and route through the text seam", async () => {
    const res = await run(
      ["a tall poster", "--model", "nano-2", "--aspect", "4:5", "--json"],
      deps(),
    );
    expect(res.exitCode).toBe(0);
    const json = res.json as Record<string, any>;
    expect(json.job.request.sizing).toEqual({ kind: "aspectRatio", ratio: "4:5" });
    expect(json.job.run.model).toBe("google/gemini-3.1-flash-image");
  });

  test("model-neutral defaults: 1024x1024 for image-kind, 1:1 for multimodal", async () => {
    const image = await run(["scene one", "--model", "gpt-image", "--json"], deps());
    expect((image.json as any).job.request.sizing).toEqual({
      kind: "size",
      width: 1024,
      height: 1024,
    });
    const multi = await run(["scene two", "--model", "nano-2", "--json"], deps());
    expect((multi.json as any).job.request.sizing).toEqual({
      kind: "aspectRatio",
      ratio: "1:1",
    });
  });
});

describe("ply generate — default model selection (#141, TEST-005)", () => {
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
        return { images: [{ base64: Buffer.from(`default-${imageArgs.length}`).toString("base64") }], warnings: [] };
      },
      text: async (args) => {
        textArgs.push(args);
        return { files: [{ mediaType: "image/png", uint8Array: Buffer.from(`default-text-${textArgs.length}`) }], text: "", warnings: [] };
      },
    };
  }

  test("omitting --model sends nano-2 outbound and retains it as effective provenance", async () => {
    const provider = capturingProvider();
    const res = await run(["a red barn at noon", "--json"], deps(provider));
    expect(res.exitCode).toBe(0);
    // The outbound request carries nano-2's gateway id, not gpt-image's.
    expect(provider.textArgs).toHaveLength(1);
    expect(provider.textArgs[0].model).toBe("google/gemini-3.1-flash-image");
    expect(provider.imageArgs).toHaveLength(0);
    // Provenance: the selected model key and the effective resolved id.
    const json = res.json as Record<string, any>;
    expect(json.job.request.model).toBe("nano-2");
    expect(json.job.run.model).toBe("google/gemini-3.1-flash-image");
    // The default fills the multimodal sizing shape (1:1).
    expect(json.job.request.sizing).toEqual({ kind: "aspectRatio", ratio: "1:1" });
  });

  test("an explicit --model keeps precedence over the nano-2 default", async () => {
    const provider = capturingProvider();
    const res = await run(
      ["a red barn at noon", "--model", "gpt-image", "--json"],
      deps(provider),
    );
    expect(res.exitCode).toBe(0);
    // The outbound request carries the explicitly selected model's id.
    expect(provider.imageArgs).toHaveLength(1);
    expect(provider.imageArgs[0].model).toBe("openai/gpt-image-2");
    expect(provider.textArgs).toHaveLength(0);
    const json = res.json as Record<string, any>;
    expect(json.job.request.model).toBe("gpt-image");
    expect(json.job.run.model).toBe("openai/gpt-image-2");
  });

  test("provider failures on the default path surface the error and never switch models", async () => {
    // The text seam (nano-2's call shape) throws: the provider error surfaces
    // as {ok:false}, nothing is published, and the image seam is never
    // touched — a refusal is surfaced, changing models is a caller choice.
    const throwing = capturingProvider();
    const res = await run(["a barn", "--json"], deps({ ...throwing, text: async () => {
      throw new Error("gateway 503 on gemini");
    } }));
    expect(res.exitCode).toBe(1);
    expect((res.json as Record<string, unknown>).ok).toBe(false);
    expect((res.json as any).error).toMatch(/gateway 503/);
    expect(res.text).toMatch(/gateway 503/);
    expect(throwing.imageArgs).toHaveLength(0);
    expect(await publishedIds()).toEqual([]);

    // A text-seam response with no image fails the same way — still no
    // model switch.
    const empty = capturingProvider();
    const res2 = await run(["a barn", "--json"], deps({
      ...empty,
      text: async () => ({ files: [], text: "", warnings: [] }),
    }));
    expect(res2.exitCode).toBe(1);
    expect((res2.json as any).error).toMatch(/returned no image/i);
    expect(empty.imageArgs).toHaveLength(0);
    expect(await publishedIds()).toEqual([]);
  });

  test("--help identifies nano-2 as the default", async () => {
    const res = await run(["--help"], { provider: neverProvider, jobsRoot });
    expect(res.exitCode).toBe(0);
    expect(res.text).toContain("(default: nano-2)");
  });
});

describe("ply generate — failure contract", () => {
  test("usage errors exit 2 with actionable text and publish nothing", async () => {
    const cases: string[][] = [
      [],
      ["--intent", "full-canvas"], // missing prompt
      ["a barn", "--size", "abc"],
      ["a barn", "--size", "0x100"],
      ["a barn", "--aspect", "16/9"],
      ["a barn", "--intent", "cutout"],
      ["a barn", "--count", "0"],
      ["a barn", "--count", "9"],
      ["a barn", "--size", "10x10", "--aspect", "1:1"],
      ["a barn", "--unknown-flag"],
    ];
    for (const argv of cases) {
      const res = await run(argv, deps());
      expect(res.exitCode).toBe(2);
      expect(res.text).not.toBe("");
      expect((res.json as Record<string, unknown>).ok).toBe(false);
    }
    expect(await publishedIds()).toEqual([]);
  });

  test("domain refusals exit 1: unknown model, sizing/kind mismatch, temperature on image models, implicit-default size refusal", async () => {
    const unknown = await run(["a barn", "--model", "nope", "--json"], deps());
    expect(unknown.exitCode).toBe(1);
    expect((unknown.json as Record<string, any>).ok).toBe(false);
    expect((unknown.json as any).error).toMatch(/Unknown model/);

    const aspect = await run(["a barn", "--model", "gpt-image", "--aspect", "16:9", "--json"], deps());
    expect(aspect.exitCode).toBe(1);
    expect((aspect.json as any).error).toMatch(/--size/);

    const temp = await run(["a barn", "--model", "gpt-image", "--temperature", "0.5", "--json"], deps());
    expect(temp.exitCode).toBe(1);
    expect((temp.json as any).error).toMatch(/temperature/i);

    const sizeOnDefault = await run(["a barn", "--size", "1024x1024", "--json"], deps());
    expect(sizeOnDefault.exitCode).toBe(1);
    expect((sizeOnDefault.json as any).error).toMatch(/--aspect/);
    expect(await publishedIds()).toEqual([]);
  });

  test("a provider error exits 1 with {ok:false} and leaves no job record", async () => {
    const res = await run(["a barn", "--model", "gpt-image", "--json"], {
      provider: {
        image: async () => {
          throw new Error("gateway 500");
        },
        text: neverProvider.text,
      },
      jobsRoot,
    });
    expect(res.exitCode).toBe(1);
    expect((res.json as Record<string, unknown>).ok).toBe(false);
    expect((res.json as any).error).toMatch(/gateway 500/);
    expect(res.text).toMatch(/gateway 500/);
    expect(await publishedIds()).toEqual([]);
  });

  test("a missing-image response exits 1 and publishes nothing", async () => {
    const res = await run(["a barn", "--model", "gpt-image", "--json"], {
      provider: { image: async () => ({ images: [], warnings: [] }), text: neverProvider.text },
      jobsRoot,
    });
    expect(res.exitCode).toBe(1);
    expect((res.json as any).error).toMatch(/returned no image/i);
    expect(await publishedIds()).toEqual([]);
  });

  test("an output-publication failure exits 1, reports no success, and leaves no record", async () => {
    // A file where the outputs directory must be created blocks publication.
    const provider = fakeProvider();
    const blocker = path.join(jobsRoot, "gen-blocked", "outputs");
    await mkdir(path.dirname(blocker), { recursive: true });
    await writeFile(blocker, "not a directory");
    const res = await run(["a barn", "--job", "gen-blocked", "--json"], { provider, jobsRoot });
    expect(res.exitCode).toBe(1);
    expect((res.json as Record<string, unknown>).ok).toBe(false);
    expect(existsSync(path.join(jobsRoot, "gen-blocked", "job.json"))).toBe(false);
    await rm(jobsRoot, { recursive: true, force: true });
  });

  test("a duplicate job id is refused with guidance and runs nothing", async () => {
    await run(["first", "--job", "gen-dup", "--json"], deps());
    const res = await run(["second", "--job", "gen-dup", "--json"], deps());
    expect(res.exitCode).toBe(1);
    expect((res.json as any).error).toMatch(/already exists/);
  });

  test("failure paths never mutate an existing Project", async () => {
    const projectDir = path.join(root, "proj");
    await initProject(projectDir, { name: "watched" });
    const snapshot = await projectFingerprint(projectDir);

    for (const argv of [
      ["a barn", "--model", "gpt-image", "--json"], // provider error
      ["a barn", "--size", "abc", "--json"], // usage error
    ]) {
      const provider: UniformProvider =
        argv.includes("--size")
          ? fakeProvider()
          : {
              image: async () => {
                throw new Error("gateway down");
              },
              text: neverProvider.text,
            };
      await run(argv, { provider, jobsRoot: path.join(projectDir, "out", "generation") });
    }
    expect(await projectFingerprint(projectDir)).toEqual(snapshot);
  });
});

describe("ply generate show/list — offline inspection", () => {
  test("show prints the published record offline", async () => {
    await run(["a barn", "--job", "gen-x", "--json"], deps());
    const res = await run(["show", "gen-x", "--json"], { provider: neverProvider, jobsRoot });
    expect(res.exitCode).toBe(0);
    expect((res.json as any).job.jobId).toBe("gen-x");
    expect((res.json as any).job.run.outputs).toHaveLength(1);
  });

  test("show refuses a missing job with exit 1", async () => {
    const res = await run(["show", "gen-missing", "--json"], { provider: neverProvider, jobsRoot });
    expect(res.exitCode).toBe(1);
    expect((res.json as any).error).toMatch(/No generation job/);
  });

  test("list summarizes jobs offline; empty list is not an error", async () => {
    const empty = await run(["list", "--json"], { provider: neverProvider, jobsRoot });
    expect(empty.exitCode).toBe(0);
    expect((empty.json as any).jobs).toEqual([]);

    await run(["a barn", "--job", "gen-y", "--json"], deps());
    const res = await run(["list", "--json"], { provider: neverProvider, jobsRoot });
    expect(res.exitCode).toBe(0);
    expect((res.json as any).jobs[0]).toMatchObject({ jobId: "gen-y", intent: "full-canvas" });
    expect(res.text).toContain("gen-y");
  });

  test("--help documents the syntax and runs offline with exit 0", async () => {
    const res = await run(["--help"], { provider: neverProvider, jobsRoot });
    expect(res.exitCode).toBe(0);
    expect(res.text).toContain("--intent");
    expect(res.text).toContain("--size");
    expect(res.text).toContain("--aspect");
    expect(res.text).toContain("--json");
    expect(res.text).toContain("show");
    expect(res.text).toContain("list");
  });
});

describe("ply generate --ref — ordered verified References (#105)", () => {
  function recordingProvider(): UniformProvider & {
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
        return { images: [{ base64: Buffer.from(`ref-cli-${imageArgs.length}`).toString("base64") }], warnings: [] };
      },
      text: async (args) => {
        textArgs.push(args);
        return { files: [{ mediaType: "image/png", uint8Array: Buffer.from(`ref-cli-text-${textArgs.length}`) }], text: "", warnings: [] };
      },
    };
  }

  async function ref(name: string, bytes: string): Promise<string> {
    const p = path.join(root, name);
    await writeFile(p, bytes);
    return p;
  }

  test("outbound attachments carry the distinct Reference bytes in caller order, and the record lists them in order", async () => {
    const a = await ref("alpha.png", "reference-alpha-bytes");
    const b = await ref("beta.png", "reference-beta-bytes");
    const c = await ref("gamma.png", "reference-gamma-bytes");
    const provider = recordingProvider();
    const res = await run(
      ["a lighthouse collage from these photos", "--model", "gpt-image", "--ref", a, "--ref", b, "--ref", c, "--json"],
      deps(provider),
    );
    expect(res.exitCode).toBe(0);
    const json = res.json as Record<string, any>;
    // The recorded identities, in caller order.
    expect(json.job.request.references).toEqual([
      { path: a, contentHash: createHash("sha256").update("reference-alpha-bytes").digest("hex") },
      { path: b, contentHash: createHash("sha256").update("reference-beta-bytes").digest("hex") },
      { path: c, contentHash: createHash("sha256").update("reference-gamma-bytes").digest("hex") },
    ]);
    // The actual outbound attachment order and bytes match caller order.
    expect(provider.imageArgs).toHaveLength(1);
    expect((provider.imageArgs[0].prompt as { text: string; images: Uint8Array[] }).images).toEqual([
      Buffer.from("reference-alpha-bytes"),
      Buffer.from("reference-beta-bytes"),
      Buffer.from("reference-gamma-bytes"),
    ]);
    expect((provider.imageArgs[0].prompt as { text: string; images: Uint8Array[] }).text).toBe("a lighthouse collage from these photos");
    expect(provider.imageArgs[0].size).toBe("1024x1024");
    // Reversing the flag order reverses the attachments — no reordering.
    const provider2 = recordingProvider();
    const res2 = await run(["mirror order", "--model", "gpt-image", "--ref", c, "--ref", a, "--json"], deps(provider2));
    expect(res2.exitCode).toBe(0);
    expect((provider2.imageArgs[0].prompt as { images: Uint8Array[] }).images).toEqual([
      Buffer.from("reference-gamma-bytes"),
      Buffer.from("reference-alpha-bytes"),
    ]);
    expect(((res2.json as Record<string, any>).job.request.references as { path: string }[]).map((r) => r.path)).toEqual([c, a]);
  });

  test("multimodal models attach the verified bytes as ordered message images", async () => {
    const a = await ref("alpha.png", "reference-alpha-bytes");
    const provider = recordingProvider();
    const res = await run(
      ["a portrait study", "--model", "nano-2", "--ref", a, "--json"],
      deps(provider),
    );
    expect(res.exitCode).toBe(0);
    expect(provider.textArgs).toHaveLength(1);
    expect(provider.textArgs[0].images).toEqual([Buffer.from("reference-alpha-bytes")]);
    expect(provider.imageArgs).toHaveLength(0);
  });

  test("an unqualified model is refused with the canonical capability message and no provider call", async () => {
    const a = await ref("alpha.png", "bytes");
    const provider = recordingProvider();
    const res = await run(["a barn", "--model", "flux", "--ref", a, "--json"], deps(provider));
    expect(res.exitCode).toBe(1);
    expect((res.json as any).error).toMatch(/not qualified reference-capable/);
    expect(provider.imageArgs).toHaveLength(0);
    expect(await publishedIds()).toEqual([]);
  });

  test("a missing Reference file exits 1 with an actionable diagnostic and publishes nothing", async () => {
    const provider = recordingProvider();
    const res = await run(["a barn", "--ref", path.join(root, "absent.png"), "--json"], deps(provider));
    expect(res.exitCode).toBe(1);
    expect((res.json as any).error).toMatch(/absent\.png/);
    expect((res.json as any).error).toMatch(/missing/i);
    expect(provider.imageArgs).toHaveLength(0);
    expect(await publishedIds()).toEqual([]);
  });

  test("the recorded identity is the verified pre-run bytes even when the file changes during the run", async () => {
    // Single-shot capture and execution both read the file; a mutation between
    // the identity read and the verification read is caught by hash mismatch.
    const a = await ref("alpha.png", "capture-bytes");
    const provider = recordingProvider();
    // The provider mutates the file the instant it is called — after the
    // verification read, so the run succeeds and records the captured identity.
    const mutating: UniformProvider = {
      image: async (args) => {
        await writeFile(a, "mutated-after-verification");
        return provider.image(args);
      },
      text: provider.text,
    };
    const res = await run(["a barn", "--model", "gpt-image", "--ref", a, "--json"], deps(mutating));
    expect(res.exitCode).toBe(0);
    expect((res.json as any).job.request.references[0].contentHash).toBe(
      createHash("sha256").update("capture-bytes").digest("hex"),
    );
  });

  test("compact text lists each Reference in order; show repeats them", async () => {
    const a = await ref("alpha.png", "bytes-one");
    const b = await ref("beta.png", "bytes-two");
    const res = await run(["a barn", "--ref", a, "--ref", b, "--job", "gen-refs"], deps());
    expect(res.exitCode).toBe(0);
    expect(res.text).toContain(`ref 1: ${a}`);
    expect(res.text).toContain(`ref 2: ${b}`);
    const shown = await run(["show", "gen-refs", "--json"], { provider: neverProvider, jobsRoot });
    expect(shown.exitCode).toBe(0);
    expect((shown.json as any).job.request.references).toHaveLength(2);
  });

  test("show and list refuse --ref as a generation flag (exit 2)", async () => {
    const a = await ref("alpha.png", "bytes");
    for (const argv of [["show", "gen-x", "--ref", a], ["list", "--ref", a]]) {
      const res = await run(argv, deps());
      expect(res.exitCode).toBe(2);
      expect((res.json as any).error).toMatch(/--ref/);
    }
  });

  test("usage errors: empty and missing --ref values exit 2 and publish nothing", async () => {
    for (const argv of [["a barn", "--ref"], ["a barn", "--ref", ""], ["a barn", "--ref="]]) {
      const res = await run(argv, deps());
      expect(res.exitCode).toBe(2);
      expect((res.json as any).error).toMatch(/--ref/);
    }
    expect(await publishedIds()).toEqual([]);
  });

  test("a duplicate --job id is refused before any Reference byte is read", async () => {
    await run(["first", "--job", "gen-preflight", "--json"], deps());
    const provider = recordingProvider();
    const res = await run(
      ["second", "--job", "gen-preflight", "--ref", path.join(root, "absent.png"), "--json"],
      deps(provider),
    );
    expect(res.exitCode).toBe(1);
    expect((res.json as any).error).toMatch(/already exists/);
    expect(provider.imageArgs).toHaveLength(0);
  });

  test("--help documents --ref", async () => {
    const res = await run(["--help"], { provider: neverProvider, jobsRoot });
    expect(res.text).toContain("--ref");
  });
});

// --- helpers ---------------------------------------------------------------

async function projectFingerprint(projectDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile()) {
        out[path.relative(projectDir, p)] = createHash("sha256")
          .update(await readFile(p))
          .digest("hex");
      }
    }
  };
  await walk(projectDir);
  return out;
}