/**
 * Evidence inspection for the new workflow (#109, spec #102 US-005):
 *
 * - `ply generate review <jobId>` builds an offline evidence sheet from the
 *   PUBLISHED records: the exact ordered References (verified against the
 *   identities recorded at Job creation), every generated output
 *   (content-identity verified), and the associated matte where one exists
 *   (found by the derived source-identity linkage, verified before display).
 * - `ply layer review <layer-id> --out <path>` builds the same kind of sheet
 *   from RETAINED Project evidence: the Layer's hash-verified bytes, the
 *   retained matte/generation lineage, and caller References shown only when
 *   their recorded paths still verify — unavailable ones are labeled with
 *   their recorded identity, never substituted and never invented.
 *
 * Nothing here adopts, approves, or promotes: a review result never implies
 * likeness approval or cutout promotion, the legacy `jobs review` surface is
 * untouched, and no test generates, bills, or loads real weights.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng } from "./png.js";
import { initProject } from "../src/project.js";
import { runUniformGeneration, type UniformProvider } from "../src/generation.js";
import { runMatting, type MattingRecord } from "../src/matting.js";
import { composeMatte, type MatteEngine } from "../src/matte.js";
import { createComposition, addGeneratedLayerToComposition, addMattedLayerToComposition } from "../src/composition.js";
import { reviewPublishedGeneration, reviewRetainedLayer } from "../src/evidence-review.js";
import { run as runGenerateCli, type GenerationCliDeps } from "../src/generation-cli.js";
import { DEFAULT_MODEL } from "../src/models.js";

let root: string;
let jobsRoot: string;
let matteRoot: string;
let projDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-evidence-review-"));
  jobsRoot = path.join(root, "out", "generation");
  matteRoot = path.join(root, "out", "matting");
  projDir = path.join(root, "proj");
  await initProject(projDir, { name: "review-project" });
  await createComposition(projDir, "thumb", { width: 64, height: 64 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let n = 0;

/** Provider returning a distinct solid PNG per call (deterministic, never billed). */
function fakeProvider(): UniformProvider {
  const bytes = encodePng(24, 24, (x, y) => [n * 10 + x, y, 100, 255]);
  n++;
  return {
    image: async () => ({ images: [{ base64: bytes.toString("base64") }], warnings: [] }),
    text: async () => ({ files: [{ mediaType: "image/png", uint8Array: bytes }], text: "", warnings: [] }),
  };
}

/** A fake matte engine applying a hard-edged mask (true alpha, passes the gate). */
function fakeEngine(mask: (x: number, y: number) => boolean): MatteEngine {
  const m = encodePng(24, 24, (x, y) => (mask(x, y) ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  return async ({ bytes, label }) => ({ bytes: composeMatte(bytes, m, label), engine: "test/segmenter" });
}

async function publishJob(jobId: string, refs: string[]): Promise<{ outputHash: string; outputFile: string }> {
  const job = await runUniformGeneration(
    jobsRoot,
    jobId,
    {
      prompt: "a presenter portrait",
      intent: "full-canvas",
      model: DEFAULT_MODEL,
      count: 1,
      ...(refs.length ? { references: refs } : {}),
    },
    { provider: fakeProvider() },
  );
  const output = job.run.outputs[0]!;
  return { outputHash: output.contentHash, outputFile: path.join(jobsRoot, jobId, output.file) };
}

async function publishMatte(matteId: string, sourceFile: string, engine: MatteEngine): Promise<MattingRecord> {
  return runMatting(matteRoot, matteId, sourceFile, { engine });
}

const halfMask = (x: number, y: number) => x < 12;

function genDeps(provider: UniformProvider = fakeProvider()): Partial<GenerationCliDeps> {
  return { provider, jobsRoot, matteRoot };
}

// ---------------------------------------------------------------------------
// ply generate review — external published evidence
// ---------------------------------------------------------------------------

describe("generate review — published evidence", () => {
  test("builds a self-contained sheet from verified References, candidate, and matte", async () => {
    const refA = path.join(root, "anchor-a.png");
    const refB = path.join(root, "anchor-b.png");
    await writeFile(refA, encodePng(8, 8, () => [200, 10, 10, 255]));
    await writeFile(refB, encodePng(8, 8, () => [10, 200, 10, 255]));
    const { outputHash, outputFile } = await publishJob("gen-review-1", [refA, refB]);
    const matte = await publishMatte("matte-review-1", outputFile, fakeEngine(halfMask));

    const review = await reviewPublishedGeneration(jobsRoot, matteRoot, "gen-review-1");
    expect(review.jobId).toBe("gen-review-1");
    expect(review.reviewPath).toBe(path.join(jobsRoot, "gen-review-1", "review.html"));
    expect(review.references.map((r) => r.path)).toEqual([refA, refB]);
    expect(review.references.every((r) => r.bytes !== null)).toBe(true);
    expect(review.outputs).toHaveLength(1);
    expect(review.outputs[0]!.contentHash).toBe(outputHash);
    expect(review.outputs[0]!.matte?.matteId).toBe(matte.matteId);
    expect(review.outputs[0]!.matte?.engine).toBe("test/segmenter");

    const html = await readFile(review.reviewPath, "utf8");
    // Every displayed image is embedded verified bytes; the sheet needs nothing else.
    expect(html).toContain("data:image/png;base64,");
    // The restrictive CSP forbids anything but embedded evidence.
    expect(html).toContain("default-src 'none'");
    // References appear in caller order with their recorded identities.
    expect(html.indexOf("anchor-a.png")).toBeLessThan(html.indexOf("anchor-b.png"));
    // Matte evidence is labeled with its engine and alpha report.
    expect(html).toContain("test/segmenter");
    expect(html).toContain("transparent");
    // Review evidence never implies approval or promotion.
    expect(html).toContain("approval");
  });

  test("a candidate without a matte is reviewed as generated, clearly marked", async () => {
    await publishJob("gen-review-2", []);
    const review = await reviewPublishedGeneration(jobsRoot, matteRoot, "gen-review-2");
    expect(review.outputs[0]!.matte).toBeNull();
    const html = await readFile(review.reviewPath, "utf8");
    expect(html).toContain("no matte");
  });

  test("multi-output jobs review every output, each with its own matte association", async () => {
    let seed = 0;
    const job = await runUniformGeneration(
      jobsRoot,
      "gen-review-3",
      { prompt: "two candidates", intent: "full-canvas", model: "gpt-image", count: 2 },
      { provider: { image: async () => { const s = seed++; const b = encodePng(24, 24, (x, y) => [s, y, x, 255]); return { images: [{ base64: b.toString("base64") }], warnings: [] }; }, text: async () => ({ files: [], text: "", warnings: [] }) } },
    );
    expect(job.run.outputs).toHaveLength(2);
    // Matte only the first output.
    const first = path.join(jobsRoot, "gen-review-3", job.run.outputs[0]!.file);
    await publishMatte("matte-review-3", first, fakeEngine(halfMask));

    const review = await reviewPublishedGeneration(jobsRoot, matteRoot, "gen-review-3");
    expect(review.outputs[0]!.matte?.matteId).toBe("matte-review-3");
    expect(review.outputs[1]!.matte).toBeNull();
  });

  test("missing Reference fails the review clearly — no sheet, no substitution", async () => {
    const ref = path.join(root, "anchor-gone.png");
    await writeFile(ref, encodePng(8, 8, () => [1, 2, 3, 255]));
    await publishJob("gen-review-missing", [ref]);
    await rm(ref);

    await expect(reviewPublishedGeneration(jobsRoot, matteRoot, "gen-review-missing"))
      .rejects.toThrow(/missing/);
    expect(existsSync(path.join(jobsRoot, "gen-review-missing", "review.html"))).toBe(false);
  });

  test("a newer Reference (changed bytes) fails the review with both identities", async () => {
    const ref = path.join(root, "anchor-edited.png");
    await writeFile(ref, encodePng(8, 8, () => [1, 2, 3, 255]));
    await publishJob("gen-review-changed", [ref]);
    await writeFile(ref, encodePng(8, 8, () => [9, 9, 9, 255])); // newer content, same path

    await expect(reviewPublishedGeneration(jobsRoot, matteRoot, "gen-review-changed"))
      .rejects.toThrow(/changed content identity/);
    expect(existsSync(path.join(jobsRoot, "gen-review-changed", "review.html"))).toBe(false);
  });

  test("corrupt candidate output fails the review before anything is displayed", async () => {
    await publishJob("gen-review-corrupt", []);
    const job = JSON.parse(await readFile(path.join(jobsRoot, "gen-review-corrupt", "job.json"), "utf8"));
    const outputFile = path.join(jobsRoot, "gen-review-corrupt", job.run.outputs[0].file);
    await writeFile(outputFile, Buffer.from("tampered bytes"));

    await expect(reviewPublishedGeneration(jobsRoot, matteRoot, "gen-review-corrupt"))
      .rejects.toThrow(/does not match its recorded content identity/);
    expect(existsSync(path.join(jobsRoot, "gen-review-corrupt", "review.html"))).toBe(false);
  });

  test("two mattes claiming one candidate are ambiguous lineage — fail closed", async () => {
    const { outputFile } = await publishJob("gen-review-ambig", []);
    await publishMatte("matte-ambig-a", outputFile, fakeEngine(halfMask));
    await publishMatte("matte-ambig-b", outputFile, fakeEngine(halfMask));

    await expect(reviewPublishedGeneration(jobsRoot, matteRoot, "gen-review-ambig"))
      .rejects.toThrow(/ambiguous/);
    expect(existsSync(path.join(jobsRoot, "gen-review-ambig", "review.html"))).toBe(false);
  });

  test("a corrupt associated matte fails the review — never shown as evidence", async () => {
    const { outputFile } = await publishJob("gen-review-badmatte", []);
    await publishMatte("matte-bad", outputFile, fakeEngine(halfMask));
    const record = JSON.parse(await readFile(path.join(matteRoot, "matte-bad", "matte.json"), "utf8"));
    await writeFile(path.join(matteRoot, "matte-bad", record.result.outputs[0].file), Buffer.from("not the matte"));

    await expect(reviewPublishedGeneration(jobsRoot, matteRoot, "gen-review-badmatte"))
      .rejects.toThrow(/does not match its recorded content identity/);
  });

  test("compact text, JSON payload, help, and usage errors follow the CLI contract", async () => {
    const ref = path.join(root, "anchor-cli.png");
    await writeFile(ref, encodePng(8, 8, () => [5, 5, 5, 255]));
    await publishJob("gen-review-cli", [ref]);

    // Compact text success.
    const ok = await runGenerateCli(["review", "gen-review-cli"], genDeps());
    expect(ok.exitCode).toBe(0);
    expect(ok.text).toContain("gen-review-cli");
    expect(ok.text).toContain("review.html");
    expect(ok.text).toContain("anchor-cli.png");

    // JSON payload.
    const json = await runGenerateCli(["review", "gen-review-cli", "--json"], genDeps());
    expect(json.exitCode).toBe(0);
    const payload = json.json as { ok: boolean; jobId: string; review: string; references: { path: string; contentHash: string }[]; outputs: { contentHash: string; matte: { matteId: string } | null }[] };
    expect(payload.ok).toBe(true);
    expect(payload.jobId).toBe("gen-review-cli");
    expect(payload.references).toEqual([{ path: ref, contentHash: payload.references[0]!.contentHash }]);
    expect(payload.outputs[0]!.matte).toBeNull();

    // Usage errors — exit 2, review is an offline inspection command.
    const noArgs = await runGenerateCli(["review"], genDeps());
    expect(noArgs.exitCode).toBe(2);
    const extra = await runGenerateCli(["review", "a", "b"], genDeps());
    expect(extra.exitCode).toBe(2);
    const withRef = await runGenerateCli(["review", "gen-review-cli", "--ref", "x.png"], genDeps());
    expect(withRef.exitCode).toBe(2);
    expect(withRef.text).toMatch(/offline inspection command/);
    const withIntent = await runGenerateCli(["review", "gen-review-cli", "--intent", "isolated"], genDeps());
    expect(withIntent.exitCode).toBe(2);

    // Runtime failure — missing job exits 1.
    const missing = await runGenerateCli(["review", "gen-nope"], genDeps());
    expect(missing.exitCode).toBe(1);
    expect((missing.json as { ok: boolean }).ok).toBe(false);

    // Help names the review command.
    const help = await runGenerateCli(["--help"], genDeps());
    expect(help.exitCode).toBe(0);
    expect(help.text).toContain("generate review");
  });
});

// ---------------------------------------------------------------------------
// ply layer review — retained Project evidence
// ---------------------------------------------------------------------------

describe("layer review — retained evidence", () => {
  test("reviews a generated Layer offline from retained Project evidence alone", async () => {
    const ref = path.join(root, "anchor-retained.png");
    await writeFile(ref, encodePng(8, 8, () => [42, 42, 42, 255]));
    const { outputHash, outputFile } = await publishJob("gen-retained-1", [ref]);
    const ingested = await addGeneratedLayerToComposition(projDir, "thumb", "hero", {
      jobRoot: jobsRoot,
      jobId: "gen-retained-1",
    });
    const layerId = ingested.layer.id;

    // External temporary generation/Matting files are removed, the caller's
    // Reference file is gone too, and the Project is relocated.
    await rm(path.join(root, "out"), { recursive: true, force: true });
    await rm(ref);
    const moved = path.join(root, "moved");
    await rename(projDir, moved);

    const review = await reviewRetainedLayer(moved, layerId, path.join(root, "retained-review.html"));
    expect(review.generation?.jobId).toBe("gen-retained-1");
    expect(review.matting).toBeNull();
    expect(review.candidate.contentHash).toBe(outputHash);
    // The Reference file is also gone: labeled unavailable with its recorded
    // identity — never substituted, and the review stays usable.
    expect(review.references[0]!.bytes).toBeNull();
    expect(review.references[0]!.unavailable).toBeTruthy();

    const html = await readFile(review.reviewPath, "utf8");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("unavailable");
    expect(html).toContain("approval");
  });

  test("a matted generated Layer shows the matte, engine, and alpha from retained lineage", async () => {
    const { outputFile } = await publishJob("gen-retained-2", []);
    const matte = await publishMatte("matte-retained-2", outputFile, fakeEngine(halfMask));
    const ingested = await addMattedLayerToComposition(projDir, "thumb", "hero", {
      matteRoot,
      matteId: "matte-retained-2",
      generationRoot: jobsRoot,
    });

    const review = await reviewRetainedLayer(projDir, ingested.layer.id, path.join(root, "matted-review.html"));
    expect(review.matting?.matteId).toBe("matte-retained-2");
    expect(review.matting?.engine).toBe("test/segmenter");
    expect(review.matting?.alpha.transparentPx).toBeGreaterThan(0);
    expect(review.generation?.jobId).toBe("gen-retained-2");
    // The predecessor candidate's pixels were never retained — the sheet says so.
    expect(review.predecessorCandidateNote).toBeTruthy();

    const html = await readFile(review.reviewPath, "utf8");
    expect(html).toContain("test/segmenter");
  });

  test("a generated Layer's associated matte pixels come from the retained matte result", async () => {
    const { outputHash, outputFile } = await publishJob("gen-retained-3", []);
    const matte = await publishMatte("matte-retained-3", outputFile, fakeEngine(halfMask));
    const generated = await addGeneratedLayerToComposition(projDir, "thumb", "hero", {
      jobRoot: jobsRoot,
      jobId: "gen-retained-3",
    });
    await addMattedLayerToComposition(projDir, "thumb", "cutout", {
      matteRoot,
      matteId: "matte-retained-3",
      generationRoot: jobsRoot,
    });

    const review = await reviewRetainedLayer(projDir, generated.layer.id, path.join(root, "assoc-review.html"));
    expect(review.generation?.jobId).toBe("gen-retained-3");
    expect(review.matting).toBeNull();
    expect(review.associatedMatte?.matteId).toBe(matte.matteId);
    expect(review.associatedMatte?.contentHash).not.toBe(outputHash);
    const html = await readFile(review.reviewPath, "utf8");
    expect(html).toContain("matte-retained-3");
  });

  test("References still on disk are verified before display in retained review", async () => {
    const ref = path.join(root, "anchor-live.png");
    await writeFile(ref, encodePng(8, 8, () => [7, 7, 7, 255]));
    await publishJob("gen-retained-4", [ref]);
    const ingested = await addGeneratedLayerToComposition(projDir, "thumb", "hero", {
      jobRoot: jobsRoot,
      jobId: "gen-retained-4",
    });

    const review = await reviewRetainedLayer(projDir, ingested.layer.id, path.join(root, "live-ref-review.html"));
    expect(review.references[0]!.bytes).not.toBeNull();
    expect(review.references[0]!.path).toBe(ref);

    // A newer Reference at the same path is labeled unavailable, never shown.
    await writeFile(ref, encodePng(8, 8, () => [8, 8, 8, 255]));
    const changed = await reviewRetainedLayer(projDir, ingested.layer.id, path.join(root, "changed-ref-review.html"));
    expect(changed.references[0]!.bytes).toBeNull();
    expect(changed.references[0]!.unavailable).toMatch(/changed|missing/i);
  });

  test("an ordinary image Layer has no generation or Matting evidence — clear failure", async () => {
    const img = path.join(root, "plain.png");
    await writeFile(img, encodePng(8, 8, () => [3, 3, 3, 255]));
    const added = await import("../src/composition.js");
    const res = await added.addLayerToComposition(projDir, "thumb", "plain", img);
    await expect(
      reviewRetainedLayer(projDir, res.layer.id, path.join(root, "plain-review.html")),
    ).rejects.toThrow(/not generated or matted content/);
  });

  test("--out into the Project's reserved storage is refused — never clobbers Project state", async () => {
    await publishJob("gen-dest-1", []);
    const ingested = await addGeneratedLayerToComposition(projDir, "thumb", "hero", {
      jobRoot: jobsRoot,
      jobId: "gen-dest-1",
    });
    for (const dest of [path.join(projDir, "ply.json"), path.join(projDir, "layers", "x.html"), path.join(projDir, "content", "x.html")]) {
      await expect(reviewRetainedLayer(projDir, ingested.layer.id, dest)).rejects.toThrow(/reserved storage/);
    }
    // An existing in-Project file is refused too — in-Project state is never overwritten.
    const existing = path.join(projDir, "existing-review.html");
    await writeFile(existing, "prior sheet");
    await expect(reviewRetainedLayer(projDir, ingested.layer.id, existing)).rejects.toThrow(/never overwritten/);
    // A fresh non-reserved path inside the Project works.
    const fresh = path.join(projDir, "fresh-review.html");
    const ok = await reviewRetainedLayer(projDir, ingested.layer.id, fresh);
    expect(ok.reviewPath).toBe(fresh);
  });

  test("an external directory symlink into the Project cannot bypass protection (PROD-1)", async () => {
    await publishJob("gen-dest-2", []);
    const ingested = await addGeneratedLayerToComposition(projDir, "thumb", "hero", {
      jobRoot: jobsRoot,
      jobId: "gen-dest-2",
    });
    const manifestBefore = await readFile(path.join(projDir, "ply.json"));

    // alias -> proj: the lexical destination looks external, the write would
    // land inside the Project. Every reserved target through the alias is
    // refused and the Project's bytes stay intact.
    const alias = path.join(root, "alias");
    await Bun.spawn(["ln", "-s", projDir, alias]).exited;
    for (const dest of [
      path.join(alias, "ply.json"),
      path.join(alias, ".ply.lock"),
      path.join(alias, "renders", "x.html"),
      path.join(alias, "compositions", "x.html"),
    ]) {
      await expect(reviewRetainedLayer(projDir, ingested.layer.id, dest)).rejects.toThrow(/reserved storage/);
    }
    expect(await readFile(path.join(projDir, "ply.json"))).toEqual(manifestBefore);

    // A fresh non-reserved path through the alias is allowed and lands in
    // the Project; a second attempt on the same physical path is refused —
    // in-Project state is never overwritten.
    const throughAlias = path.join(alias, "alias-review.html");
    const ok = await reviewRetainedLayer(projDir, ingested.layer.id, throughAlias);
    // The reported path is the caller-chosen destination verbatim; realpaths
    // are containment guards only.
    expect(ok.reviewPath).toBe(throughAlias);
    await expect(reviewRetainedLayer(projDir, ingested.layer.id, throughAlias)).rejects.toThrow(/never overwritten/);
    expect(await readFile(path.join(projDir, "alias-review.html"), "utf8")).toContain("evidence ·");
  });

  test("a text Layer has no evidence to inspect — clear failure", async () => {
    const added = await import("../src/composition.js");
    const res = await added.addTextLayerToComposition(projDir, "thumb", "headline", {
      text: "hold the line",
      font: "Anton",
    });
    await expect(
      reviewRetainedLayer(projDir, res.layer.id, path.join(root, "text-review.html")),
    ).rejects.toThrow(/no evidence to review/);
  });

  test("an edited Layer no longer matches its retained lineage — fail, never substitute", async () => {
    await publishJob("gen-retained-5", []);
    const ingested = await addGeneratedLayerToComposition(projDir, "thumb", "hero", {
      jobRoot: jobsRoot,
      jobId: "gen-retained-5",
    });
    await writeFile(path.join(root, "plain2.png"), encodePng(8, 8, () => [4, 4, 4, 255]));
    const layerCli = path.resolve(import.meta.dir, "../src/layer-cli.ts");
    const proc = Bun.spawn(
      [process.execPath, layerCli, "edit", ingested.layer.id, "--image", path.join(root, "plain2.png"), "--json", "--project", projDir],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;

    await expect(
      reviewRetainedLayer(projDir, ingested.layer.id, path.join(root, "edited-review.html")),
    ).rejects.toThrow(/not generated or matted content/);
  });
});

// ---------------------------------------------------------------------------
// ply layer review — public CLI partition
// ---------------------------------------------------------------------------

describe("layer review — CLI contract", () => {
  test("compact text, JSON, exit codes, and --out requirement", async () => {
    await publishJob("gen-cli-1", []);
    const ingested = await addGeneratedLayerToComposition(projDir, "thumb", "hero", {
      jobRoot: jobsRoot,
      jobId: "gen-cli-1",
    });
    const out = path.join(root, "cli-review.html");
    const cli = path.resolve(import.meta.dir, "../src/cli.ts");
    const invoke = async (args: string[]) => {
      const p = Bun.spawn([process.execPath, cli, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { stdout, stderr, code };
    };

    // Missing --out is a usage error (JSON goes to stdout, like every
    // structured layer-cli result).
    const noOut = await invoke(["layer", "review", ingested.layer.id, "--project", projDir, "--json"]);
    expect(noOut.code).toBe(2);
    expect(JSON.parse(noOut.stdout).ok).toBe(false);

    // Success: compact text on stdout, JSON under --json.
    const ok = await invoke(["layer", "review", ingested.layer.id, "--out", out, "--project", projDir]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("gen-cli-1");
    expect(existsSync(out)).toBe(true);

    const json = await invoke(["layer", "review", ingested.layer.id, "--out", out, "--project", projDir, "--json"]);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.generation.jobId).toBe("gen-cli-1");
    expect(payload.review).toBeTruthy();

    // Unknown Layer fails with exit 1.
    const missing = await invoke(["layer", "review", "layer_nope", "--out", out, "--project", projDir, "--json"]);
    expect(missing.code).toBe(1);
  });
});