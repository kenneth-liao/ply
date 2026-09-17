/**
 * Shared CLI presentation conventions (#128) — the one home for the facts
 * every module's entry point reads the same way:
 *
 * - `--json` switches presentation (not semantics): compact text by default,
 *   one valid JSON result on stdout in JSON mode (F14, ISC-20).
 * - Usage errors are concise and actionable: the correction plus a pointer
 *   to the module's help — never the entire module manual embedded in the
 *   message (F12, F16).
 * - `--help --json` returns the help text inside one valid JSON result.
 *
 * Argument *parsing* stays per-module: this module only owns presentation.
 */
export type CliExitCode = 0 | 1 | 2;

/** Whether `--json` appears anywhere in the raw arguments (pre-parse scan). */
export function wantsJson(args: string[]): boolean {
  return args.includes("--json");
}

/**
 * The module-global presentation flags, extracted before per-module dispatch:
 * `--json` switches output presentation, `--help`/`-h` request help. Anything
 * else is the caller's command line, unchanged. Scanning is by exact token —
 * a value is never confused with the flag, and a path never starts with `-`.
 */
export function extractGlobalFlags(args: string[]): {
  json: boolean;
  help: boolean;
  rest: string[];
} {
  const rest = args.filter((a) => a !== "--json" && a !== "--help" && a !== "-h");
  return {
    json: args.includes("--json"),
    help: args.includes("--help") || args.includes("-h"),
    rest,
  };
}

/**
 * A negative number is a valid value for these numeric options (#128), but
 * parseArgs refuses a dash-leading option value ("--y -40" reads as an
 * ambiguous flag), so join a following dash-leading numeric token into
 * "--<flag>=<value>" before parsing. The regex only matches numerics — a
 * following option is never consumed as a value — and a missing value falls
 * through to the parser's own concise missing-value error. Equals-form
 * values pass through untouched, so both syntaxes reach the same parser.
 */
export function joinDashLeadingNumericValues(args: string[], flags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (
      flags.includes(arg) &&
      args[i + 1] !== undefined &&
      /^-(?:\.?\d)/.test(args[i + 1]!)
    ) {
      out.push(`${arg}=${args[i + 1]!}`);
      i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** Concise usage-error message: the correction, then a pointer to relevant help. */
export function usageMessage(message: string, moduleName: string): string {
  return `${message}\nRun "ply ${moduleName} --help" for commands and options.`;
}

/** The `--help --json` payload shape: help text inside one valid JSON result. */
export function helpResult(helpText: string): { ok: true; help: string } {
  return { ok: true, help: helpText };
}

/**
 * Print one CLI result in the caller's chosen presentation: JSON mode emits
 * exactly one JSON result on stdout; text mode prints compact text to stdout
 * on success and stderr on failure — no prose ever contaminates a JSON stdout.
 * `text` is required in text mode: every command has a rendering, so a
 * missing text is a contract bug, never a silent no-output success.
 */
export function printResult(
  result: { exitCode: CliExitCode; text: string; json: unknown },
  isJson: boolean,
): void {
  if (isJson) console.log(JSON.stringify(result.json, null, 2));
  else (result.exitCode === 0 ? console.log : console.error)(result.text);
}
