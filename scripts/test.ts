import { Glob } from "bun";
import { join } from "node:path";

function getGitInfo(toplevel: string) {
  const shaRes = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: toplevel });
  const sha = shaRes.exitCode === 0 ? shaRes.stdout.toString().trim() : "unknown";

  const statusRes = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: toplevel });
  const dirtyState = statusRes.exitCode === 0
    ? (statusRes.stdout.toString().trim().length > 0 ? "dirty" : "clean")
    : "unknown";

  return { checkout: toplevel, sha, dirtyState };
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

function extractLastNumber(text: string, pattern: RegExp): number {
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return 0;
  return parseInt(matches[matches.length - 1][1], 10);
}

async function pump(stream: ReadableStream<Uint8Array>, write: (chunk: string) => void): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const str = decoder.decode(value, { stream: true });
      text += str;
      write(str);
    }
    const rem = decoder.decode();
    text += rem;
    write(rem);
  } finally {
    reader.releaseLock();
  }
  return text;
}

const toplevel = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]).stdout.toString().trim() || process.cwd();

const glob = new Glob("**/*.test.ts");
const testFiles: string[] = [];
for (const f of glob.scanSync({ cwd: join(toplevel, "test") })) {
  testFiles.push(`test/${f}`);
}
testFiles.sort();

let totalPass = 0;
let totalFail = 0;
let totalSkip = 0;
const failingFiles: string[] = [];

for (const file of testFiles) {
  const proc = Bun.spawn(["bun", "test", "--isolate", file], {
    cwd: toplevel,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    pump(proc.stdout, (chunk) => process.stdout.write(chunk)),
    pump(proc.stderr, (chunk) => process.stderr.write(chunk)),
  ]);

  const exitCode = await proc.exited;
  const combined = stripAnsi(stdout + "\n" + stderr);

  const pass = extractLastNumber(combined, /^\s*(\d+)\s+pass\s*$/gm);
  let fail = extractLastNumber(combined, /^\s*(\d+)\s+fail\s*$/gm);
  const skip = extractLastNumber(combined, /^\s*(\d+)\s+skip\s*$/gm);

  if (exitCode !== 0 || fail > 0) {
    failingFiles.push(file);
    if (fail === 0) {
      fail = 1;
    }
  }

  totalPass += pass;
  totalFail += fail;
  totalSkip += skip;
}

const { checkout, sha, dirtyState } = getGitInfo(toplevel);

console.log("\n" + "=".repeat(80));
console.log("Test Summary");
console.log(`  Checkout: ${checkout}`);
console.log(`  Commit:   ${sha} (${dirtyState})`);
console.log(`  Files:    ${testFiles.length} run (${testFiles.length - failingFiles.length} passed, ${failingFiles.length} failed)`);
console.log(`  Totals:   ${totalPass} pass, ${totalFail} fail, ${totalSkip} skip`);
if (failingFiles.length > 0) {
  console.log("\nFailing files:");
  for (const f of failingFiles) {
    console.log(`  - ${f}`);
  }
}
console.log("=".repeat(80));

process.exit(failingFiles.length === 0 ? 0 : 1);
