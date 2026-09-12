/**
 * The independent local Matting command's contract (spec #102 ticket #106,
 * US-002/US-005): a caller-invoked local operation with no Generation Job or
 * adoption state, real-alpha output through the public operation, native
 * alpha preserved without inference, engine preflight before inference,
 * source preservation, published result + Matting provenance, and the
 * introduced-command output contract (compact text, valid --json, exit
 * 0/1/2, accurate help, nonzero failures that publish nothing).
 *
 * The MatteEngine is injected at the CLI seam (deterministic, no weights, no
 * network); live-engine qualification is #112's ownership.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, type MattingCliDeps } from "../src/matting-cli.js";
import type { MatteEngine } from "../src/matte.js";
import { composeMatte, NATIVE_ALPHA } from "../src/matte.js";
import { verifyTrueAlpha } from "../src/alpha.js";
import { encodePng, decodePng, opaqueSubject, subjectMask } from "./png.js";

let root: string;
let matteRoot: string;
let sourcePath: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-matting-cli-"));
  matteRoot = path.join(root, "matting");
  sourcePath = path.join(root, "source.png");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** An opaque RGB PNG — the ordinary Matting input that needs inference. */
const OPAQUE_SUBJECT = opaqueSubject();

/** Its segmentation mask: white subject, black background. */
const MASK = subjectMask();

const ALL_BLACK = encodePng(16, 16, () => [0, 0, 0, 255], { colorType: 2 });
const ALL_WHITE = encodePng(16, 16, () => [255, 255, 255, 255], { colorType: 2 });

/** A source that already carries a real matte — the native-alpha route. */
const NATIVE_ALPHA_PNG = encodePng(16, 16, (x, y) =>
  x < 8 && y < 8 ? [255, 0, 0, 255] : [0, 0, 0, 0],
);

/** Fake engine that mattes through a given mask (the test seam's normal shape). */
const engineOf = (mask: Uint8Array, engine = "test/segmenter"): MatteEngine =>
  async ({ bytes, label }) => ({
    bytes: composeMatte(bytes, mask, label),
    engine,
    backend: "test-backend",
    timing: { millis: 42, scope: "test-engine-call" },
  });

/** An engine that must never be called — proves native alpha needs no inference. */
const neverEngine: MatteEngine = Object.assign(
  async () => {
    throw new Error("TRIPWIRE: the engine must not run for a natively isolated source");
  },
  { preflight: async () => { throw new Error("TRIPWIRE: preflight must not run"); } },
);

/** An engine whose preflight fails — the missing/mismatched-weights shape. */
const failingPreflightEngine: MatteEngine = Object.assign(
  async () => {
    throw new Error("TRIPWIRE: the engine must not run when preflight refuses");
  },
  { preflight: async () => { throw new Error("The local matting model is unusable: the weights file is not there"); } },
);

function deps(engine: MatteEngine = engineOf(MASK)): Partial<MattingCliDeps> {
  return { engine, matteRoot };
}

async function publishedIds(): Promise<string[]> {
  try {
    return (await readdir(matteRoot)).filter((d) => !d.startsWith("."));
  } catch {
    return [];
  }
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function writeSource(bytes: Uint8Array, name = "source.png"): Promise<string> {
  const file = name === "source.png" ? sourcePath : path.join(root, name);
  await writeFile(file, bytes);
  return file;
}

describe("ply matte — success through the public operation", () => {
  test("an imported opaque PNG is matted through the injected engine and verified as real alpha", async () => {
    const source = await writeSource(OPAQUE_SUBJECT);
    const res = await run([source], deps());
    expect(res.exitCode).toBe(0);
    const json = res.json as Record<string, any>;
    expect(json.ok).toBe(true);
    expect(json.matteId).toMatch(/^matte-[a-z0-9-]+$/);

    const record = json.matte;
    expect(record.kind).toBe("matting");
    expect(record.schemaVersion).toBe(2);
    expect(record.request.source.path).toBe(source);
    expect(record.request.source.contentHash).toBe(sha256(OPAQUE_SUBJECT));
    expect(record.result.engine).toBe("test/segmenter");
    // Real alpha, verified — not a transparency prompt.
    expect(record.result.alpha).toMatchObject({ width: 16, height: 16, opaquePx: 64 });
    const output = record.result.outputs[0];
    const bytes = await readFile(path.join(json.matteDir, output.file));
    expect(sha256(bytes)).toBe(output.contentHash);
    expect(output.mediaType).toBe("image/png");
    const png = decodePng(bytes);
    expect(png.px(6, 6)).toEqual([200, 30, 40, 255]); // subject colour kept
    expect(png.px(0, 0)[3]).toBe(0); // background cut out
    // The published output passes the true-alpha gate on its own.
    expect(verifyTrueAlpha(bytes, "published").opaquePx).toBe(64);

    // matte.json is on disk — the published record is the record, not a copy.
    const onDisk = JSON.parse(
      await readFile(path.join(json.matteDir, "matte.json"), "utf8"),
    );
    expect(onDisk).toEqual(record);
  });

  test("a generated-output-shaped PNG mattes the same way without generation as a prerequisite", async () => {
    // Bytes shaped exactly like a generation output, placed at the path such
    // output would take — constructed directly, no provider, no Generation Job.
    const outputBytes = OPAQUE_SUBJECT;
    const genOutput = path.join(
      root,
      "out",
      "generation",
      "gen-20260908-ab12cd34",
      "outputs",
      `${sha256(outputBytes)}.png`,
    );
    await mkdir(path.dirname(genOutput), { recursive: true });
    await writeFile(genOutput, outputBytes);
    const res = await run([genOutput], deps());
    expect(res.exitCode).toBe(0);
    const json = res.json as Record<string, any>;
    expect(json.ok).toBe(true);
    expect(json.matte.request.source.contentHash).toBe(sha256(outputBytes));
    expect(json.matte.result.engine).toBe("test/segmenter");
    // No generation state was read or written.
    expect(existsSync(path.join(root, "out", "generation", "gen-20260908-ab12cd34", "job.json"))).toBe(false);
  });

  test("a natively isolated source is kept as-is — the engine is never invoked", async () => {
    const source = await writeSource(NATIVE_ALPHA_PNG);
    const res = await run([source], deps(neverEngine));
    expect(res.exitCode).toBe(0);
    const json = res.json as Record<string, any>;
    expect(json.matte.result.engine).toBe(NATIVE_ALPHA);
    expect(json.matte.result.warnings).toEqual([]);
    // The bytes are the source's own matte — same content identity.
    expect(json.matte.result.outputs[0].contentHash).toBe(sha256(NATIVE_ALPHA_PNG));
  });

  test("default text is compact and --json is strict JSON", async () => {
    const source = await writeSource(OPAQUE_SUBJECT);
    const res = await run([source], deps());
    expect(res.exitCode).toBe(0);
    expect(res.text).toContain("Matte matte-");
    expect(res.text).toContain("source: ");
    expect(res.text).toContain("engine: test/segmenter");
    expect(res.text).toContain("output: outputs/");
    const json = res.json as Record<string, any>;
    expect(json.ok).toBe(true);
  });
});

describe("ply matte — failure contract", () => {
  test("a missing source file is refused with an actionable message and publishes nothing", async () => {
    const res = await run([path.join(root, "nope.png")], deps());
    expect(res.exitCode).toBe(1);
    expect((res.json as Record<string, any>).ok).toBe(false);
    expect(res.text).toMatch(/no such file|not there|cannot be read/i);
    expect(await publishedIds()).toEqual([]);
  });

  test("a non-PNG source is refused with an actionable convert-locally diagnostic", async () => {
    const source = await writeSource(Buffer.from("definitely not a png"), "photo.jpg");
    const res = await run([source], deps());
    expect(res.exitCode).toBe(1);
    expect(res.text).toMatch(/PNG/i);
    expect(res.text).toMatch(/convert/i);
    expect(await publishedIds()).toEqual([]);
  });

  test("a corrupt PNG is refused and publishes nothing", async () => {
    const corrupt = new Uint8Array(OPAQUE_SUBJECT);
    corrupt.fill(0x55, 40, 60); // break an IDAT body
    const source = await writeSource(corrupt, "corrupt.png");
    const res = await run([source], deps());
    expect(res.exitCode).toBe(1);
    expect((res.json as Record<string, any>).ok).toBe(false);
    expect(await publishedIds()).toEqual([]);
  });

  test("engine preflight failure refuses with an actionable message before anything is published", async () => {
    const sourceBytes = OPAQUE_SUBJECT;
    const source = await writeSource(sourceBytes);
    const res = await run([source], deps(failingPreflightEngine));
    expect(res.exitCode).toBe(1);
    expect(res.text).toContain("The local matting model is unusable");
    expect(await publishedIds()).toEqual([]);
    // The source bytes are untouched.
    expect((await readFile(source)).equals(sourceBytes)).toBe(true);
  });

  test("an all-transparent engine result is refused at the pass that produced it", async () => {
    const source = await writeSource(OPAQUE_SUBJECT);
    const res = await run([source], deps(engineOf(ALL_BLACK, "test/empty")));
    expect(res.exitCode).toBe(1);
    expect(res.text).toContain("test/empty");
    // The gate's why is kept, with this operation's recovery — the adoption
    // recovery is not this surface's (there is no Job to rerun).
    expect(res.text).toMatch(/matte is empty|opaque pixels/i);
    expect(res.text).toMatch(/ply matte/);
    expect(res.text).not.toMatch(/jobs rerun|adopt/i);
    expect(await publishedIds()).toEqual([]);
  });

  test("an all-opaque engine result is refused as effectively opaque", async () => {
    const source = await writeSource(OPAQUE_SUBJECT);
    const res = await run([source], deps(engineOf(ALL_WHITE, "test/opaque")));
    expect(res.exitCode).toBe(1);
    expect(res.text).toMatch(/effectively opaque|transparent/i);
    expect(res.text).not.toMatch(/jobs rerun|adopt/i);
    expect(await publishedIds()).toEqual([]);
  });

  test("a duplicate matte id is refused and nothing is overwritten", async () => {
    const source = await writeSource(OPAQUE_SUBJECT);
    const first = await run([source, "--id", "matte-fixed"], deps());
    expect(first.exitCode).toBe(0);
    const before = await readFile(path.join(matteRoot, "matte-fixed", "matte.json"), "utf8");
    const again = await run([source, "--id", "matte-fixed"], deps());
    expect(again.exitCode).toBe(1);
    expect(again.text).toMatch(/already exists/i);
    expect(await readFile(path.join(matteRoot, "matte-fixed", "matte.json"), "utf8")).toBe(before);
  });

  test("a publication failure leaves the source byte-identical and no successful-looking result", async () => {
    const sourceBytes = OPAQUE_SUBJECT;
    const source = await writeSource(sourceBytes);
    // The root is a regular file, so creating the matte directory fails.
    await writeFile(matteRoot, "not a directory");
    const res = await run([source], deps());
    expect(res.exitCode).toBe(1);
    expect((res.json as Record<string, any>).ok).toBe(false);
    // No source replacement: the exact source bytes remain.
    expect((await readFile(source)).equals(sourceBytes)).toBe(true);
    // No successful-looking result: no record, no output bytes anywhere.
    expect(existsSync(path.join(matteRoot, "matte.json"))).toBe(false);
  });

  test("a failure after the output write removes the partial publication too", async () => {
    const sourceBytes = OPAQUE_SUBJECT;
    const source = await writeSource(sourceBytes);
    // Poison the exact output path with a directory: the output write fails
    // only after the fresh matte directory already exists, exercising the
    // caught-error cleanup rather than the first mkdir.
    const poisoned = path.join(
      matteRoot,
      "matte-pubfail",
      "outputs",
      `${sha256(composeMatte(OPAQUE_SUBJECT, MASK, "source.png"))}.png`,
    );
    await mkdir(poisoned, { recursive: true });
    const res = await run([source, "--id", "matte-pubfail"], deps());
    expect(res.exitCode).toBe(1);
    expect(res.text).toMatch(/could not be published/i);
    expect((await readFile(source)).equals(sourceBytes)).toBe(true);
    expect(existsSync(path.join(matteRoot, "matte-pubfail"))).toBe(false);
  });
});

describe("ply matte — usage contract", () => {
  test("no argument is a usage error (exit 2) with accurate help", async () => {
    const res = await run([], deps());
    expect(res.exitCode).toBe(2);
    expect(res.text).toContain("ply matte");
    expect((res.json as Record<string, any>).ok).toBe(false);
  });

  test("an invalid --id is a usage error", async () => {
    const res = await run(["whatever", "--id", "BAD_ID"], deps());
    expect(res.exitCode).toBe(2);
    expect(res.text).toMatch(/--id/i);
  });

  test("--help exits 0 and documents the operation", async () => {
    const res = await run(["--help"], deps());
    expect(res.exitCode).toBe(0);
    expect(res.text).toMatch(/native/i);
    expect(res.text).toMatch(/PNG/i);
  });
});