/**
 * Pre-spec Render fixture (spec #226 A226-003 → #260, US-007 bullet 1 as
 * scoped in the 2026-09-21 decision on #226): a Project whose Render was
 * captured by Ply 4.23.0 — the last pre-#226 release, commit e0e126b —
 * proves that the #226 delivery changed nothing that alters a Render
 * retained before it.
 *
 * Two live facts are asserted on current code:
 * 1. `composition replay` still REFUSES the unmodified pre-spec manifest:
 *    the ISC-14 recorded-environment gate (src/render-history.ts
 *    verifyEnvironmentMatch) stays unchanged, and a manifest from another
 *    Ply version is refused.
 * 2. With ONLY the Ply-version comparison substituted in the test — the
 *    manifest carries no integrity hash over `environment`, so the test
 *    rewrites that one field in a temp copy; no product-code seam exists —
 *    the pre-spec manifest repaints to bytes IDENTICAL to the committed
 *    pre-spec PNG. Runtime, browser, and platform checks stay live: the
 *    repaint test skips with a stated reason when any of them differs from
 *    the fixture's recording, detected through the live gate's own refusal.
 *
 * The fixture's provenance is recorded in test/fixtures/pre-spec-render/README.md.
 * All pixel work is local (no network, no weights), offline, per the repo's
 * per-file `--isolate` test topology.
 */
import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { toolIdentity } from "../src/manifest.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const fixtureProject = path.resolve(import.meta.dir, "fixtures/pre-spec-render/project");
const RECORDED_VERSION = "4.23.0";
const RECORDED_MANIFEST = "hero-mubtt4wv-af1f94e2.manifest.json";
const RECORDED_PNG = "hero-mubtt4wv-af1f94e2.png";

async function spawn(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn([process.execPath, cli, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, code };
}

/**
 * Probe the live environment gate ONCE, at module load, by replaying the
 * unmodified pre-spec manifest against current code. The gate captures the
 * LIVE environment inside the paint pass and refuses before any output is
 * published, so its refusal names exactly which recorded fields differ from
 * this run: the Ply version always does (that is the point of the fixture);
 * runtime/browser/platform must match for the repaint to be possible.
 */
const probe = await (async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "ply-pre-spec-probe-"));
  try {
    const proj = path.join(temp, "project");
    await cp(fixtureProject, proj, { recursive: true });
    const res = await spawn([
      "composition", "replay", path.join(proj, "renders", RECORDED_MANIFEST), "--project", proj,
    ]);
    // Each mismatch entry starts right after the gate's opening "{" or an
    // entry separator ", " — e.g. `{tool version "4.23.0" ≠ "4.37.3",
    // runtime "bun 1.4.0" ≠ "bun 1.5.0"}` — so the label is only a field
    // name when anchored this way, never incidental prose.
    const mismatchFields = [
      "tool name", "tool version", "runtime", "browser", "platform",
    ].filter((f) => new RegExp(`(?:\\{|, )${f} `).test(res.stderr));
    return { ...res, mismatchFields };
  } catch (err) {
    throw new Error(
      `Pre-spec replay probe failed: ${(err as Error).message} — cannot classify the live environment gate's refusal.`,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
})();

/** Fields beyond the tool identity that the live gate already refuses — any of these means this run's runtime/browser/platform differs from the recording, and the repaint cannot even be attempted. */
const nonVersionMismatches = probe.mismatchFields.filter(
  (f) => f !== "tool version" && f !== "tool name",
);
const repaintSkipReason = nonVersionMismatches.length > 0
  ? `recorded environment differs from this run's live capture: ${nonVersionMismatches.join(", ")}` +
    " — the live recorded-environment gate refuses before any paint; regenerate the fixture on a matching environment"
  : null;

test("unstubbed replay refuses the pre-spec manifest (another Ply version; ISC-14 gate unchanged)", () => {
  // The gate must fire — never silently succeed on foreign history.
  expect(probe.code).toBe(1);
  expect(probe.stderr).toContain("Render environment mismatch");
  expect(probe.mismatchFields).toContain("tool version");
  // The refusal is specifically the version comparison: the recorded
  // pre-spec version and the current tool version are both named.
  expect(probe.stderr).toContain(`"${RECORDED_VERSION}"`);
  expect(probe.stderr).toContain(`"${toolIdentity().version}"`);
});

test.skipIf(repaintSkipReason !== null)(
  repaintSkipReason
    ? `repaints the pre-spec manifest byte-identically on current code [skipped: ${repaintSkipReason}]`
    : "repaints the pre-spec manifest byte-identically on current code",
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "ply-pre-spec-fixture-"));
    try {
      const proj = path.join(temp, "project");
      await cp(fixtureProject, proj, { recursive: true });

      // The one test-only substitution (#260): rewrite the recorded Ply
      // version to the current one in a temp copy of the manifest — the
      // stored manifest carries no integrity hash over `environment`, so
      // this is a plain JSON field edit at the test boundary. Runtime,
      // browser, and platform stay exactly as recorded and are checked live
      // by the unmodified gate inside replay.
      const manifestPath = path.join(proj, "renders", RECORDED_MANIFEST);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        environment: { tool: { version: string } };
      };
      manifest.environment.tool.version = toolIdentity().version;
      const stubbedPath = path.join(proj, "renders", "version-stubbed.manifest.json");
      await writeFile(stubbedPath, JSON.stringify(manifest, null, 2) + "\n");

      const outPath = path.join(temp, "repaint.png");
      const res = await spawn([
        "composition", "replay", stubbedPath, "--out", outPath, "--project", proj,
      ]);
      expect(res.stderr).toBe("");
      expect(res.code).toBe(0);

      // The repaint is byte-identical to the PNG Ply 4.23.0 published.
      const repainted = await readFile(outPath);
      const committed = await readFile(path.join(fixtureProject, "renders", RECORDED_PNG));
      expect(repainted.equals(committed)).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);