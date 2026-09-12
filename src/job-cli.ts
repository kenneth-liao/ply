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
import { extractGlobalFlags, helpResult, usageMessage, wantsJson, printResult } from "./cli-present.js";

const HELP = `
ply jobs — inspect the legacy Generation Job records (read-only)

  ply jobs show <jobId>       Full job record: request, typed references, runs
  ply jobs list               Summarize recorded jobs
  ply jobs review <jobId>     Candidate review for any job kind — every distinct candidate
                              at full size and at 168px, its recorded isolation evidence,
                              and — for creators — face detail against the identity
                              anchors (writes <jobDir>/review.html, offline)

Category-specific generation ("jobs plates|objects|creators"), kind-dispatched
"jobs rerun", and candidate adoption ("jobs adopt", "library adopt") are retired.
New content: generate with "ply generate", isolate with "ply matte", and ingest
as an ordinary Project Layer ("ply composition add ... --from-generation" or
"--from-matte"). This command only reads records that already exist under
out/jobs/ — it does not start generation and publishes nothing. Published
records live under out/generation/ (inspect with "ply generate show|list|review").

Output is compact text by default; --json emits one valid JSON result:
{"ok": true, ...} or {"ok": false, "errors": [...]}. Exit codes: 0 ok,
1 failure, 2 usage error.
`;

interface CliResult {
  exitCode: 0 | 1 | 2;
  output: unknown;
}

const ok = (output: unknown): CliResult => ({ exitCode: 0, output });
const usageError = (message: string): CliResult => ({
  exitCode: 2,
  // Concise and actionable: the correction plus a pointer — never the whole
  // module manual embedded in the message (#128, F12/F16).
  output: { ok: false, errors: [{ path: "argv", message: usageMessage(message, "jobs") }] },
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
      ? `missing command — expected ${REMAINING_COMMANDS}. Generation and adoption are retired — generate with "ply generate", matte with "ply matte", and ingest as a Layer with "ply composition add --from-generation|--from-matte"`
      : `unknown command "${cmd}" — expected ${REMAINING_COMMANDS}. Generation and adoption are retired — generate with "ply generate", matte with "ply matte", and ingest as a Layer with "ply composition add --from-generation|--from-matte"`,
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
  // --json / --help / -h are module-global presentation flags: stripped before
  // dispatch, which hand-parses only each command's own arguments (#128).
  const { help, rest } = extractGlobalFlags(args);
  const [cmd] = rest;
  const resolved: JobCliDeps = {
    jobsRoot: deps?.jobsRoot ?? path.resolve("out", "jobs"),
  };
  try {
    if (help) return { exitCode: 0, output: helpResult(HELP.trim()) };
    return await dispatch(rest, resolved);
  } catch (err) {
    return failure((err as Error).message || String(err), cmd ?? "jobs");
  }
}

/** Compact default text for one structured jobs result (#128, ISC-20). */
function jobsText(cmd: string, output: unknown): string {
  const out = output as {
    ok: boolean;
    errors?: { message: string }[];
    help?: string;
    job?: { jobId: string; kind: string; createdAt: string; runs: unknown[] };
    jobs?: { jobId: string; kind: string; subject: string; createdAt: string; runs: number; candidates: number }[];
    review?: string;
    candidates?: unknown[];
    anchors?: unknown[];
  };
  if (out.ok === false) return (out.errors ?? []).map((e) => e.message).join("\n");
  if (typeof out.help === "string") return out.help;
  switch (cmd) {
    case "show": {
      const job = out.job!;
      return `Job ${job.jobId} (${job.kind}, ${job.createdAt}): ${job.runs.length} runs — the full record prints under --json.`;
    }
    case "list": {
      const jobs = out.jobs ?? [];
      if (jobs.length === 0) return "No recorded jobs.";
      return (
        `Jobs (${jobs.length}):\n` +
        jobs
          .map((j) => `  ${j.jobId} (${j.kind}, ${j.createdAt}): ${j.runs} runs, ${j.candidates} candidates — "${j.subject.slice(0, 48)}"`)
          .join("\n")
      );
    }
    case "review":
      return (
        `Review: ${out.review}\nCandidates (${(out.candidates ?? []).length}):` +
        (out.candidates as { file: string }[]).map((c) => `\n  ${c.file}`).join("") +
        `\nAnchors (${(out.anchors ?? []).length})`
      );
    default:
      // An unrendered command result is visible rather than silently blank;
      // every ordinary command has a case above, so this is a bug marker.
      return JSON.stringify(out, null, 2);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const isJson = wantsJson(argv);
  const { exitCode, output } = await run(argv);
  printResult({ exitCode, text: jobsText(extractGlobalFlags(argv).rest[0] ?? "", output), json: output }, isJson);
  process.exit(exitCode);
}
