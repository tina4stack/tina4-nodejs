/**
 * Lock-in test for python#96 parity: `tina4nodejs test` MUST exit non-zero
 * when a test fails — in BOTH runTests() branches (packages/cli/src/commands/test.ts).
 *
 * Fully REAL (no mocks): each case writes a real temp project with real test
 * file(s), spawns the REAL CLI test command (packages/cli/src/bin.ts) as a
 * child process via node:child_process spawnSync (cwd = the temp project), and
 * asserts the child's real exit code.
 *
 * Positive (passing test -> exit 0) AND negative (throwing / process.exit(1)
 * test -> exit non-zero) for:
 *   • the auto-discover branch (a tests/ directory), and
 *   • the explicit single-file arg branch.
 * Plus the crux of python#96: a mixed directory where only ONE discovered file
 * fails must STILL exit non-zero — the discover loop must never let a passing
 * file mask an earlier failure.
 *
 * The temp project lives INSIDE the repo tree so the CLI's inner
 * `npx tsx "<file>"` resolves the repo's own tsx (fast + offline) rather than
 * triggering an npx network fetch — mirrors test/cliGenerateCoemits.test.ts.
 *
 * Run with: npx tsx test/cliTestExitCode.test.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`); }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(repoRoot, "node_modules/.bin/tsx");
const cliBin = join(repoRoot, "packages/cli/src/bin.ts");
const baseDir = join(repoRoot, `.tmp_testexit_${process.pid}`);

const PASS_BODY = 'console.log("ok — a passing test");\n';          // clean exit 0
const THROW_BODY = 'throw new Error("boom — a failing test");\n';   // uncaught -> non-zero exit
const EXIT1_BODY = 'console.log("failing via exit code");\nprocess.exit(1);\n';

/** Spawn the REAL `tina4nodejs test [args]` in `cwd`; return its real exit code. */
function runTestCli(cwd: string, args: string[] = []): number {
  const res = spawnSync(tsxBin, [cliBin, "test", ...args], {
    cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000,
  });
  if (res.error) throw res.error;
  // status is null only if the child was killed by a signal — treat as failure.
  return res.status ?? -1;
}

/** Write a real temp project (relative path -> file body) and return its dir. */
function makeProject(name: string, files: Record<string, string>): string {
  const dir = join(baseDir, name);
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

console.log("=== CLI `test` exit-code lock-in (python#96 parity, real subprocess) ===\n");

rmSync(baseDir, { recursive: true, force: true });
mkdirSync(baseDir, { recursive: true });

try {
  // ── Auto-discover branch (tests/ directory) ──────────────────────
  console.log("--- auto-discover branch ---");
  // Positive: a single passing discovered test -> exit 0.
  {
    const dir = makeProject("discover_pass", { "tests/ok.ts": PASS_BODY });
    assert("auto-discover: all passing -> exit 0", runTestCli(dir) === 0);
  }
  // Negative: a single throwing discovered test -> non-zero.
  {
    const dir = makeProject("discover_throw", { "tests/bad.ts": THROW_BODY });
    assert("auto-discover: a throwing test -> exit non-zero", runTestCli(dir) !== 0);
  }
  // Negative: a discovered test that process.exit(1)s -> non-zero.
  {
    const dir = makeProject("discover_exit1", { "tests/bad.ts": EXIT1_BODY });
    assert("auto-discover: a process.exit(1) test -> exit non-zero", runTestCli(dir) !== 0);
  }
  // CRUX of python#96: mixed dir, only ONE file fails -> STILL non-zero.
  {
    const dir = makeProject("discover_mixed", {
      "tests/a_fail.ts": THROW_BODY,
      "tests/z_pass.ts": PASS_BODY,
    });
    assert(
      "auto-discover: one failure among passes -> exit non-zero (loop must not mask it)",
      runTestCli(dir) !== 0,
    );
  }

  // ── Explicit single-file arg branch ──────────────────────────────
  console.log("\n--- explicit single-file branch ---");
  {
    const dir = makeProject("file_pass", { "tests/ok.ts": PASS_BODY });
    assert("explicit file: passing file -> exit 0", runTestCli(dir, ["tests/ok.ts"]) === 0);
  }
  {
    const dir = makeProject("file_throw", { "tests/bad.ts": THROW_BODY });
    assert("explicit file: throwing file -> exit non-zero", runTestCli(dir, ["tests/bad.ts"]) !== 0);
  }
} finally {
  rmSync(baseDir, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
