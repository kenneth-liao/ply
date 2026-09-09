#!/usr/bin/env bun
/**
 * The Generation Job CLI — read-only inspection for the legacy
 * plate/object/creator Generation Job records (REQ-013/REQ-014/REQ-015).
 *
 * The category-specific generation entry points (`jobs plates`, `jobs
 * objects`, `jobs creators`), kind-dispatched `jobs rerun` generation, and
 * candidate adoption (`jobs adopt`, `library adopt`) are retired (#114,
 * #115, spec #102): the one uniform generation operation is `ply generate`,
 * isolation is the independent `ply matte` operation, and generated or
 * matted content enters Projects as ordinary Layers — not the asset library.
 * What remains here is the read-only record surface — `show`, `list`,
 * `review`. New Generation Jobs are published under `out/generation/<jobId>/`;
 * this surface only reads the legacy records under `<cwd>/out/jobs/<jobId>/`.
 *
 * Same contract as the Scene CLI: every command prints machine-readable JSON
 * on stdout ({ok: true, ...} or {ok: false, errors: [...]}), exit codes
 * 0 ok / 1 failure / 2 usage error. run() is the error boundary — an
 * unexpected failure (I/O) lands in the same structured shape. Nothing here
 * edits a Scene, a library asset, or a record.
 */
import path from "node:path";
import { loadJob, listJobs } from "./jobs.js";
import { reviewJob } from "./review.js";

const HELP = `
ply jobs — inspect the legacy Generation Job records

  bun run jobs show <jobId>                 Full job record: request, typed references, runs
  bun run jobs list                         Summarize recorded jobs
  bun run jobs review <jobId>               Candidate review for any job kind — every
                                            distinct candidate at full size and at
                                            168px, its recorded isolation evidence
                                            (the matte, checkerboard-showing the
                                            alpha), and — for creators — face detail
                                            against the identity anchors
                                            (writes <jobDir>/review.html, offline)

Category-specific generation and candidate adoption are retired: "jobs
plates", "jobs objects", "jobs creators", "jobs rerun", and "jobs adopt" no
longer exist. To produce isolated content, generate source images with the
one uniform operation — "bun run generate <prompt> [options]" (full-canvas or
--intent isolated, optional ordered --ref local files) — isolate explicitly
with "bun run matte <image>", and ingest the verified result as an ordinary
Project Layer ("ply composition add <comp> <name> --from-generation <jobId>"
or "--from-matte <matteId>"). Published records live under out/generation/
(inspect with "bun run generate show|list|review"). This command only reads
records that already exist under out/jobs/; it does not start generation and
it publishes nothing.

Every command prints JSON: { "ok": true, ... } or { "ok": false, "errors": [...]}.
`;

interface CliResult {
  exitCode: 0 | 1 | 2;
  output: unknown;
}

const ok = (output: unknown): CliResult => ({ exitCode: 0, output });
const usageError = (message: string): CliResult => ({
  exitCode: 2,
  output: { ok: false, errors: [{ path: "argv", message: `${message}\n\n${HELP.trim()}` }] },
});
const failure = (message: string, path = "jobs"): CliResult => ({
  exitCode: 1,
  output: { ok: false, errors: [{ path, message }] },
});

export interface JobCliDeps {
  /** Where job records live (default: <cwd>/out/jobs). */
  jobsRoot: string;
}

const REMAINING_COMMANDS = "show, list, or review";

async function dispatch(args: string[], deps: JobCliDeps): Promise<CliResult> {
  const [cmd, first, second] = args;

  if (cmd === "show") {
    if (!first || second !== undefined) return usageError('"jobs show" takes exactly one <jobId>');
    const job = await loadJob(deps.jobsRoot, first);
    return ok({ ok: true, job });
  }

  if (cmd === "list") {
    if (first) return usageError('"jobs list" takes no arguments');
    return ok({ ok: true, jobs: await listJobs(deps.jobsRoot) });
  }

  if (cmd === "review") {
    if (!first || second !== undefined) return usageError('"jobs review" takes exactly one <jobId>');
    const review = await reviewJob(deps.jobsRoot, first);
    return ok({
      ok: true,
      jobId: review.jobId,
      kind: review.kind,
      review: review.reviewPath,
      candidates: review.candidates.map((c) => ({
        contentHash: c.contentHash,
        runIndex: c.runIndex,
        file: c.file,
        isolation: c.isolation.from,
        ...(c.isolation.from === "matte" ? { engine: c.isolation.engine } : {}),
      })),
      anchors: review.anchors.map((a) => ({ id: a.id, path: a.path })),
    });
  }

  return usageError(
    cmd === undefined
      ? `missing command — expected ${REMAINING_COMMANDS}. Generation and adoption are retired — generate with "bun run generate", matte with "bun run matte", and ingest as a Layer with "ply composition add --from-generation|--from-matte"`
      : `unknown command "${cmd}" — expected ${REMAINING_COMMANDS}. Generation and adoption are retired — generate with "bun run generate", matte with "bun run matte", and ingest as a Layer with "ply composition add --from-generation|--from-matte"`,
  );
}

/**
 * The error boundary: an unexpected failure is structured JSON
 * like any other result — never a raw stack trace.
 */
export async function run(
  args: string[],
  deps?: Partial<JobCliDeps>,
): Promise<CliResult> {
  const resolved: JobCliDeps = {
    jobsRoot: deps?.jobsRoot ?? path.resolve("out", "jobs"),
  };
  const [cmd] = args;
  try {
    return await dispatch(args, resolved);
  } catch (err) {
    return failure((err as Error).message || String(err), cmd ?? "jobs");
  }
}

if (import.meta.main) {
  const { exitCode, output } = await run(process.argv.slice(2));
  console.log(JSON.stringify(output, null, 2));
  process.exit(exitCode);
}
