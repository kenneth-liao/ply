/**
 * Matting publication contract version 2 (spec #159 ticket #160, US-003/US-004):
 * new published mattes retain a content-addressed copy of the exact source
 * bytes (`sources/<sha256>.png`, named by `request.source.file`) and record
 * the engine-declared `result.backend` and `result.timing` with a stated
 * boundary. Native-alpha records store one blob and omit the inference facts.
 * Version 1 records stay readable with no backfill; missing new facts on v1
 * is not an error. A version 2 inference record that omits the new required
 * facts fails to parse.
 *
 * The MatteEngine is injected at the CLI seam (deterministic, no weights, no
 * network) — the default suite never loads weights.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseMattingRecord } from "../src/matting.js";
import { run, type MattingCliDeps } from "../src/matting-cli.js";
import { composeMatte, NATIVE_ALPHA, type MatteEngine } from "../src/matte.js";
import { encodePng, decodePng, opaqueSubject, subjectMask } from "./png.js";

let root: string;
let matteRoot: string;
let sourcePath: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-matting-v2-"));
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

/** A source that already carries a real matte — the native-alpha route. */
const NATIVE_ALPHA_PNG = encodePng(16, 16, (x, y) =>
  x < 8 && y < 8 ? [255, 0, 0, 255] : [0, 0, 0, 0],
);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Fake inference engine that declares its backend and timing (the v2 seam shape). */
const engineOf = (
  mask: Uint8Array,
  opts?: { engine?: string; backend?: string; timing?: { millis: number; scope: string } },
): MatteEngine =>
  async ({ bytes, label }) => ({
    bytes: composeMatte(bytes, mask, label),
    engine: opts?.engine ?? "test/segmenter",
    backend: opts?.backend ?? "test-backend",
    timing: opts?.timing ?? { millis: 42, scope: "test-engine-call" },
  });

/** A fake engine from before the v2 contract — declares no backend or timing. */
const legacyEngine: MatteEngine = async ({ bytes, label }) => ({
  bytes: composeMatte(bytes, MASK, label),
  engine: "test/legacy-segmenter",
});

function deps(engine: MatteEngine = engineOf(MASK)): Partial<MattingCliDeps> {
  return { engine, matteRoot };
}

async function writeSource(bytes: Uint8Array, name = "source.png"): Promise<string> {
  const file = name === "source.png" ? sourcePath : path.join(root, name);
  await writeFile(file, bytes);
  return file;
}

const H = "a".repeat(64);
const G = "b".repeat(64);

function v1Record(): any {
  return {
    schemaVersion: 1,
    matteId: "matte-v1",
    kind: "matting",
    createdAt: "2026-09-08T12:00:00.000Z",
    request: { source: { path: "caller.png", contentHash: H } },
    result: {
      engine: "test/segmenter",
      alpha: { width: 16, height: 16, transparentPx: 192, opaquePx: 64 },
      warnings: [],
      outputs: [{ contentHash: G, file: `outputs/${G}.png`, mediaType: "image/png" }],
    },
  };
}

function v2InferenceRecord(): any {
  return {
    schemaVersion: 2,
    matteId: "matte-v2",
    kind: "matting",
    createdAt: "2026-09-12T12:00:00.000Z",
    request: { source: { path: "caller.png", contentHash: H, file: `sources/${H}.png` } },
    result: {
      engine: "test/segmenter",
      backend: "test-backend",
      timing: { millis: 42, scope: "test-engine-call" },
      alpha: { width: 16, height: 16, transparentPx: 192, opaquePx: 64 },
      warnings: [],
      outputs: [{ contentHash: G, file: `outputs/${G}.png`, mediaType: "image/png" }],
    },
  };
}

function v2NativeAlphaRecord(): any {
  return {
    schemaVersion: 2,
    matteId: "matte-native",
    kind: "matting",
    createdAt: "2026-09-12T12:00:00.000Z",
    request: { source: { path: "native.png", contentHash: H } },
    result: {
      engine: NATIVE_ALPHA,
      alpha: { width: 16, height: 16, transparentPx: 192, opaquePx: 64 },
      warnings: [],
      outputs: [{ contentHash: H, file: `outputs/${H}.png`, mediaType: "image/png" }],
    },
  };
}

describe("parseMattingRecord — schema expand (v1 readable, v2 required facts)", () => {
  test("a version 1 record without the new facts still parses", () => {
    const record = parseMattingRecord(JSON.stringify(v1Record()), "matte-v1");
    expect(record.schemaVersion).toBe(1);
    expect(record.result.engine).toBe("test/segmenter");
  });

  test("a version 2 inference record with all new facts parses", () => {
    const record = parseMattingRecord(JSON.stringify(v2InferenceRecord()), "matte-v2");
    expect(record.schemaVersion).toBe(2);
    expect(record.request.source.file).toBe(`sources/${H}.png`);
    expect(record.result.backend).toBe("test-backend");
    expect(record.result.timing).toEqual({ millis: 42, scope: "test-engine-call" });
  });

  test("a version 2 native-alpha record without backend/timing parses", () => {
    const record = parseMattingRecord(JSON.stringify(v2NativeAlphaRecord()), "matte-native");
    expect(record.schemaVersion).toBe(2);
    expect(record.result.engine).toBe(NATIVE_ALPHA);
  });

  test("a version 2 inference record missing the source file fails to parse", () => {
    const raw = v2InferenceRecord();
    delete raw.request.source.file;
    expect(() => parseMattingRecord(JSON.stringify(raw), "matte-v2")).toThrow(/source/i);
  });

  test("a version 2 inference record missing the backend fails to parse", () => {
    const raw = v2InferenceRecord();
    delete raw.result.backend;
    expect(() => parseMattingRecord(JSON.stringify(raw), "matte-v2")).toThrow(/backend/i);
  });

  test("a version 2 inference record missing the timing fails to parse", () => {
    const raw = v2InferenceRecord();
    delete raw.result.timing;
    expect(() => parseMattingRecord(JSON.stringify(raw), "matte-v2")).toThrow(/timing/i);
  });

  test("a version 2 inference record with a malformed timing fails to parse", () => {
    for (const timing of [
      { millis: -1, scope: "test-engine-call" },
      { millis: 42, scope: "" },
      { millis: Number.NaN, scope: "test-engine-call" },
      "42ms",
    ]) {
      const raw = v2InferenceRecord();
      raw.result.timing = timing;
      expect(() => parseMattingRecord(JSON.stringify(raw), "matte-v2")).toThrow(/timing/i);
    }
  });

  test("a version 2 source file that is not the source identity fails to parse", () => {
    const raw = v2InferenceRecord();
    raw.request.source.file = `sources/${G}.png`; // names the output hash, not the source
    expect(() => parseMattingRecord(JSON.stringify(raw), "matte-v2")).toThrow(/source/i);
  });

  test("a version 2 inference record whose output equals the source fails to parse", () => {
    const raw = v2InferenceRecord();
    raw.result.outputs[0].contentHash = H;
    raw.result.outputs[0].file = `outputs/${H}.png`;
    expect(() => parseMattingRecord(JSON.stringify(raw), "matte-v2")).toThrow();
  });

  test("a version 2 native-alpha record naming a source copy fails to parse", () => {
    const raw = v2NativeAlphaRecord();
    raw.request.source.file = `sources/${H}.png`;
    expect(() => parseMattingRecord(JSON.stringify(raw), "matte-native")).toThrow(/source/i);
  });

  test("a version 2 native-alpha record naming inference facts fails to parse", () => {
    const withBackend = v2NativeAlphaRecord();
    withBackend.result.backend = "test-backend";
    expect(() => parseMattingRecord(JSON.stringify(withBackend), "matte-native")).toThrow(/backend|timing/i);
    const withTiming = v2NativeAlphaRecord();
    withTiming.result.timing = { millis: 0, scope: "test-engine-call" };
    expect(() => parseMattingRecord(JSON.stringify(withTiming), "matte-native")).toThrow(/backend|timing/i);
  });

  test("an unknown schema version still fails to parse", () => {
    const raw = v2InferenceRecord();
    raw.schemaVersion = 3;
    expect(() => parseMattingRecord(JSON.stringify(raw), "matte-v2")).toThrow(/schemaVersion/i);
  });
});

describe("ply matte — version 2 publication", () => {
  test("inference stores a content-addressed copy of the exact source bytes beside the output", async () => {
    const source = await writeSource(OPAQUE_SUBJECT);
    const res = await run([source], deps());
    expect(res.exitCode).toBe(0);
    const json = res.json as Record<string, any>;
    const record = json.matte;
    expect(record.schemaVersion).toBe(2);
    expect(record.request.source.contentHash).toBe(sha256(OPAQUE_SUBJECT));

    // The retained copy is the source identity, not a second hash.
    expect(record.request.source.file).toBe(`sources/${sha256(OPAQUE_SUBJECT)}.png`);
    const retained = await readFile(path.join(json.matteDir, record.request.source.file));
    expect(retained.equals(Buffer.from(OPAQUE_SUBJECT))).toBe(true);

    // The output is distinct bytes with its own identity.
    expect(record.result.outputs[0].contentHash).not.toBe(record.request.source.contentHash);

    // The caller's original file is never overwritten.
    expect((await readFile(source)).equals(Buffer.from(OPAQUE_SUBJECT))).toBe(true);
  });

  test("new inference records include the engine-declared backend and timing", async () => {
    const source = await writeSource(OPAQUE_SUBJECT);
    const res = await run(
      [source],
      deps(engineOf(MASK, { backend: "test-backend", timing: { millis: 7, scope: "test-engine-call" } })),
    );
    expect(res.exitCode).toBe(0);
    const record = (res.json as Record<string, any>).matte;
    expect(record.result.backend).toBe("test-backend");
    expect(record.result.timing).toEqual({ millis: 7, scope: "test-engine-call" });
  });

  test("a natively isolated source stores one blob and omits the inference facts", async () => {
    const source = await writeSource(NATIVE_ALPHA_PNG);
    const res = await run([source], deps());
    expect(res.exitCode).toBe(0);
    const json = res.json as Record<string, any>;
    const record = json.matte;
    expect(record.schemaVersion).toBe(2);
    expect(record.result.engine).toBe(NATIVE_ALPHA);
    expect(record.request.source.file).toBeUndefined();
    expect(record.result.backend).toBeUndefined();
    expect(record.result.timing).toBeUndefined();
    // One blob: the output hash equals the source hash, and no sources/ dir exists.
    expect(record.result.outputs[0].contentHash).toBe(sha256(NATIVE_ALPHA_PNG));
    expect(existsSync(path.join(json.matteDir, "sources"))).toBe(false);
  });

  test("an engine that declares no backend or timing fails loud and publishes nothing", async () => {
    const sourceBytes = OPAQUE_SUBJECT;
    const source = await writeSource(sourceBytes);
    const res = await run([source, "--id", "matte-legacy"], deps(legacyEngine));
    expect(res.exitCode).toBe(1);
    expect(res.text).toMatch(/backend|timing/i);
    expect(existsSync(path.join(matteRoot, "matte-legacy"))).toBe(false);
    expect((await readFile(source)).equals(Buffer.from(sourceBytes))).toBe(true);
  });

  test("compact text exposes backend, timing, and the retained source path", async () => {
    const source = await writeSource(OPAQUE_SUBJECT);
    const res = await run([source], deps());
    expect(res.exitCode).toBe(0);
    expect(res.text).toContain("backend: test-backend");
    expect(res.text).toContain("timing: 42 ms (test-engine-call)");
    expect(res.text).toContain(`source-copy: sources/${sha256(OPAQUE_SUBJECT)}.png`);
    const record = (res.json as Record<string, any>).matte;
    expect(record.result.backend).toBe("test-backend");
    expect(record.request.source.file).toBe(`sources/${sha256(OPAQUE_SUBJECT)}.png`);
  });

  test("ply matte on the retained source bytes publishes a new matte id and leaves the old record alone", async () => {
    const source = await writeSource(OPAQUE_SUBJECT);
    const first = await run([source, "--id", "matte-first"], deps());
    expect(first.exitCode).toBe(0);
    const firstJson = first.json as Record<string, any>;
    const retainedPath = path.join(firstJson.matteDir, firstJson.matte.request.source.file);
    const beforeRecord = await readFile(path.join(firstJson.matteDir, "matte.json"), "utf8");
    const beforeSource = await readFile(retainedPath);
    const beforeOutput = await readFile(
      path.join(firstJson.matteDir, firstJson.matte.result.outputs[0].file),
    );

    const second = await run([retainedPath, "--id", "matte-remat"], deps());
    expect(second.exitCode).toBe(0);
    const secondJson = second.json as Record<string, any>;
    expect(secondJson.matteId).toBe("matte-remat");
    expect(secondJson.matte.request.source.contentHash).toBe(sha256(OPAQUE_SUBJECT));

    // The old record and bytes are unchanged.
    expect(await readFile(path.join(firstJson.matteDir, "matte.json"), "utf8")).toBe(beforeRecord);
    expect((await readFile(retainedPath)).equals(beforeSource)).toBe(true);
    expect(
      (await readFile(path.join(firstJson.matteDir, firstJson.matte.result.outputs[0].file))).equals(
        beforeOutput,
      ),
    ).toBe(true);
  });
});
