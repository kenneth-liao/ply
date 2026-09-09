#!/usr/bin/env bun
/**
 * The Generation Job CLI — inspection and adoption for the legacy
 * plate/object/creator Generation Job records (REQ-013/REQ-014/REQ-015).
 *
 * The category-specific generation entry points (`jobs plates`, `jobs
 * objects`, `jobs creators`) and kind-dispatched `jobs rerun` generation are
 * retired (#114, spec #102): the one uniform generation operation is
 * `ply generate`, and isolation is the independent `ply matte` operation.
 * What remains here is the read-only record surface — `show`, `list`,
 * `review` — and candidate adoption for records that already exist. New
 * Generation Jobs are published under `out/generation/<jobId>/`; this
 * surface only reads the legacy records under `<cwd>/out/jobs/<jobId>/`.
 *
 * Same contract as the Scene CLI: every command prints machine-readable JSON
 * on stdout ({ok: true, ...} or {ok: false, errors: [...]}), exit codes
 * 0 ok / 1 failure / 2 usage error. run() is the error boundary — an
 * unexpected failure (I/O) lands in the same structured shape. Nothing here
 * edits a Scene or an existing asset; adoption goes through the kind's write
 * path, which cannot overwrite (and verifies true alpha for objects).
 */
import path from "node:path";
import {
  loadJob,
  listJobs,
  adoptCandidate,
} from "./jobs.js";
import { LIBRARY_ROOT } from "./assets.js";
import { reviewJob } from "./review.js";

const HELP = `
ply jobs — inspect and adopt the legacy Generation Job records

  bun run jobs show <jobId>                 Full job record: request, typed references, runs
  bun run jobs list                         Summarize recorded jobs
  bun run jobs review <jobId>               Candidate review for any job kind — every
                                            distinct candidate at full size and at
                                            168px, the isolation evidence adoption
                                            would use, and — for creators — face
                                            detail against the identity anchors
                                            (writes <jobDir>/review.html, offline)
  bun run jobs adopt <jobId> <hash> --id <assetId>
                                            Adopt a candidate (exact hash or unique prefix)
                                            as a new immutable Asset of the job's kind.
                                            Adoption never overwrites an existing asset;
                                            an object or creator candidate with a matte is
                                            adopted as that matte (verified true alpha), one
                                            without is refused; creator adoption always enters
                                            the library as trial.

Category-specific generation is retired: "jobs plates", "jobs objects",
"jobs creators", and "jobs rerun" no longer exist. Generate source images
with the one uniform operation — "bun run generate <prompt> [options]"
(full-canvas or --intent isolated, optional ordered --ref local files) — and
isolate content explicitly with "bun run matte <image>". Published records
live under out/generation/ (inspect with "bun run generate show|list|review").
This command only inspects and adopts records that already exist under
out/jobs/; it does not start new generation.

adopt options
  --id <assetId>        Library id for the adopted Asset (required)
  --name <str>          Display name (default: the id)
  --tags <csv>          Comma-separated tags

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
  /** Library root for adoption (default: the repo asset library). */
  libraryRoot: string;
}

/**
 * Collect "--flag value" / "--boolean" pairs. Names in `multiple` accumulate
 * every occurrence into an array; the rest keep their last value. Usage errors
 * carry the offending argument — errors identify the invalid field.
 */
function parseFlags(
  rest: string[],
  booleans: string[],
  allowed: string[],
  multiple: string[] = [],
): { flags: Map<string, string | string[] | true> } | { error: string } {
  const flags = new Map<string, string | string[] | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) return { error: arg };
    const name = arg.slice(2);
    if (!allowed.includes(name)) return { error: arg };
    if (booleans.includes(name)) {
      flags.set(name, true);
      continue;
    }
    const value = rest[++i];
    if (value === undefined || value.startsWith("--")) return { error: arg };
    if (multiple.includes(name)) {
      const prior = flags.get(name);
      flags.set(name, Array.isArray(prior) ? [...prior, value] : [value]);
    } else flags.set(name, value);
  }
  return { flags };
}

async function adoptCommand(
  deps: JobCliDeps,
  jobId: string | undefined,
  candidateRef: string | undefined,
  rest: string[],
): Promise<CliResult> {
  if (!jobId || !candidateRef)
    return usageError("adopt needs a <jobId> and a candidate hash (see `jobs show <jobId>`)");
  const parsed = parseFlags(rest, [], ["id", "name", "tags"]);
  if ("error" in parsed) return usageError(`unexpected argument "${parsed.error}"`);
  const assetId = parsed.flags.get("id") as string | undefined;
  if (!assetId) return usageError("adopt requires --id <assetId> for the new Asset");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(assetId))
    return usageError(`--id must be lowercase letters/digits/hyphens (got "${assetId}")`);

  const result = await adoptCandidate(deps.jobsRoot, jobId, candidateRef, assetId, {
    libraryRoot: deps.libraryRoot,
    ...(parsed.flags.has("name") ? { name: parsed.flags.get("name") as string } : {}),
    ...(parsed.flags.has("tags")
      ? {
          tags: (parsed.flags.get("tags") as string)
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }
      : {}),
  });
  return ok({ ok: true, ...result, libraryPath: result.imagePath });
}

const REMAINING_COMMANDS = "show, list, review, or adopt";

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
        adoptable: c.adoption.from !== "none",
        ...(c.adoption.from === "matte" ? { engine: c.adoption.engine } : {}),
      })),
      anchors: review.anchors.map((a) => ({ id: a.id, path: a.path })),
    });
  }

  if (cmd === "adopt") return adoptCommand(deps, first, second, args.slice(3));

  return usageError(
    cmd === undefined
      ? `missing command — expected ${REMAINING_COMMANDS}. Category-specific generation ("plates", "objects", "creators") and "rerun" are retired — generate with "bun run generate" and matte with "bun run matte"`
      : `unknown command "${cmd}" — expected ${REMAINING_COMMANDS}. Category-specific generation ("plates", "objects", "creators") and "rerun" are retired — generate with "bun run generate" and matte with "bun run matte"`,
  );
}

/**
 * The error boundary: an I/O error or refused adoption is structured JSON
 * like any other result — never a raw stack trace.
 */
export async function run(
  args: string[],
  deps?: Partial<JobCliDeps>,
): Promise<CliResult> {
  const resolved: JobCliDeps = {
    jobsRoot: deps?.jobsRoot ?? path.resolve("out", "jobs"),
    libraryRoot: deps?.libraryRoot ?? LIBRARY_ROOT,
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
