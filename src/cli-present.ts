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
 * else is the caller's command line, unchanged.
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
 */
export function printResult(
  result: { exitCode: CliExitCode; text?: string; json: unknown },
  isJson: boolean,
): void {
  if (isJson) console.log(JSON.stringify(result.json, null, 2));
  else if (result.text !== undefined)
    (result.exitCode === 0 ? console.log : console.error)(result.text);
}