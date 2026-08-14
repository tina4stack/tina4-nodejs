/**
 * Test runner — executes ALL test files and aggregates results.
 * Run with: npx tsx test/run-all.ts
 *
 * Each test file is spawned as a child process so its process.exit()
 * doesn't kill the runner. Pass/fail counts are parsed from each
 * file's summary line and aggregated into a grand total.
 */
import { execSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  requireServices,
  findProvisionedServiceSkips,
  findSkipLines,
} from "./_serviceGate.ts";
import { summarizeTestOutput } from "./_testSummary.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

// A test run must never launch a browser. `startServer()` opens one 2s after
// listen unless TINA4_NO_BROWSER is set (server.ts), and only 6 of the ~27
// test files that spawn a server set it — so a full run threw a fistful of
// tabs, each of them blank, because the ephemeral-port server was already
// closed by the time the tab loaded. Setting it here covers every child: the
// spawns below inherit this process's env.
process.env.TINA4_NO_BROWSER = "true";

// ── Temp sandbox ────────────────────────────────────────────────────────────
//
// Every temp path this run creates goes into ONE per-run directory, removed
// wholesale at the end. MEASURED on the lab: a full Node suite added 38 entries
// to /tmp per run -- tina4_provider_ (10), tina4_cache_inv_ (8), tina4_ident_,
// tina4_clearpersist_, tina4_cache_node_db_ and a tail of others, from files
// nobody had touched. Converting call sites does not converge; PHP proved that
// (17 conversions there still left 45 entries per run).
//
// os.tmpdir() reads TMPDIR at CALL TIME, and the spawns below inherit this
// process's env exactly as TINA4_NO_BROWSER above does, so one assignment here
// covers every test file and every server they start. The directory must EXIST
// before it is announced: Node returns TMPDIR verbatim, but a test that writes
// into a missing directory fails rather than falling back.
const tmpSandbox = join(tmpdir(), `tina4-node-tests-${process.pid}`);
mkdirSync(tmpSandbox, { recursive: true });
process.env.TMPDIR = tmpSandbox;

// Guarded on the OWNING pid. A child that re-imports this module, or any forked
// helper, must never remove the sandbox its parent and siblings are still
// using -- that exact mistake broke three PHP tests when 60 pcntl_fork children
// each ran the parent's shutdown handler.
const sandboxOwnerPid = process.pid;
function reapSandbox(): void {
  if (process.pid !== sandboxOwnerPid) return;
  try { rmSync(tmpSandbox, { recursive: true, force: true }); } catch { /* never fail a run over cleanup */ }
}
// An "exit" handler rather than an inline call before the runner returns: it
// fires on the normal exit AND on a crash or an uncaught throw, so a runner that
// dies early still takes its sandbox with it. (It is also the only cleanup path
// now that the runner sets process.exitCode instead of calling process.exit --
// see the end of this file for why.)
process.on("exit", reapSandbox);

// Discover all test files.
//
// Some suites are vitest (describe/it/expect) rather than plain tsx scripts.
// tsx cannot execute those - it errors on the `vitest` import - so they are
// collected separately and driven through `vitest run` further down.
//
// DETECTED, not listed. This was a hardcoded set of two filenames, and a new
// vitest suite added to test/ was silently spawned under tsx, died on the
// import, and reported as "FAIL <file> (died before reporting - no summary
// line)" - which reads like a broken test rather than a runner that cannot run
// it. Three new suites hit that on the same day. A file that imports from
// "vitest" IS a vitest suite; asking the file beats maintaining a list of them.
const isVitestSuite = (f: string): boolean => {
  try {
    return /\bfrom\s+["']vitest["']/.test(readFileSync(join(__dirname, f), "utf8"));
  } catch {
    return false;
  }
};

// Metrics is measured by the NATIVE engine in the tina4 Rust CLI (ADR-0002) and
// has no in-framework fallback, so these files need that binary on PATH and
// simply cannot run in CI. The engine is tested where it lives — tina4stack/tina4
// src/metrics.rs, exercised by `cargo test` in its own pipeline — so skipping
// them here loses no coverage; installing a second toolchain in four framework
// pipelines to re-test one Rust binary would only duplicate it. Set
// TINA4_SKIP_METRICS=0 to run them locally with the CLI installed.
const METRICS_FILES = new Set([
  "metrics.test.ts",
  "metrics-cli.test.ts",
  "metrics-nested-complexity.test.ts",
  "metrics-offender-cap.test.ts",
  "metricsCoverage.test.ts",
  "metrics-dispatch-pipeline.test.ts",
]);
const skipMetrics = (process.env.TINA4_SKIP_METRICS ?? "1") !== "0";

const allTestFiles = readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

const VITEST_FILES = new Set(allTestFiles.filter(isVitestSuite));

const testFiles = allTestFiles.filter(
  (f) => !VITEST_FILES.has(f) && !(skipMetrics && METRICS_FILES.has(f))
);

// Also include integration.ts
const allFiles = ["integration.ts", ...testFiles];

let totalPass = 0;
let totalFail = 0;
let filesRun = 0;
let filesFailed = 0;
const failures: string[] = [];

// Real-service gate: collect skips that name a PROVISIONED service that was
// unavailable. When TINA4_REQUIRE_SERVICES is set, these turn the run red
// (mirrors tina4-python/tests/conftest.py). MySQL/MSSQL joined the provisioned
// set in #262; only Firebird is excluded now.
const gateOn = requireServices();
const serviceSkips: { file: string; reason: string }[] = [];

// EVERY skip, not just the gate-matching ones. The runner throws away a passing
// file's stdout, so a skip inside a green file used to leave no trace anywhere:
// the grand total counted passed and failed only, and grepping a run log for
// SKIP found nothing. That made Node the one framework whose skip count could
// not be measured — Python prints "N skipped", PHPUnit "Skipped: N", RSpec
// "N pending". Collected unconditionally (the gate flag only decides whether
// skips FAIL the run, never whether they are COUNTED).
const allSkips: { file: string; reason: string }[] = [];

function collectServiceSkips(label: string, output: string): void {
  if (!output) return;
  for (const reason of findSkipLines(output)) {
    allSkips.push({ file: label, reason });
  }
  if (!gateOn) return;
  for (const reason of findProvisionedServiceSkips(output)) {
    serviceSkips.push({ file: label, reason });
  }
}

console.log(`\n\x1b[1m=== Tina4 Test Suite — ${allFiles.length} test files ===\x1b[0m\n`);

for (const file of allFiles) {
  const filePath = join(__dirname, file);
  const label = file.replace(/\.ts$/, "");

  try {
    const output = execSync(`npx tsx "${filePath}"`, {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
      env: { ...process.env },
    });

    // Parse "Results: N passed, M failed" from output
    const { passed, failed, reported } = summarizeTestOutput(output);

    totalPass += passed;
    totalFail += failed;
    filesRun++;

    collectServiceSkips(label, output);

    if (!reported) {
      // Exit 0 with no summary line: the file never reported a result, so
      // nothing here proves it ran. A test file that does not SELF-EXECUTE its
      // cases exits clean and silent, and reporting that as `PASS (0 passed)`
      // is how a suite of dead tests reads green.
      filesFailed++;
      failures.push(label);
      console.log(
        `  \x1b[31mFAIL\x1b[0m ${label} (exited 0 but reported no results — did its cases run?)`
      );
      console.log(output);
    } else if (failed > 0) {
      console.log(`  \x1b[31mFAIL\x1b[0m ${label} (${passed} passed, ${failed} failed)`);
      filesFailed++;
      failures.push(label);
      // Print the test output so failures are visible
      console.log(output);
    } else {
      console.log(`  \x1b[32mPASS\x1b[0m ${label} (${passed} passed)`);
    }
  } catch (err: any) {
    filesRun++;
    filesFailed++;

    // The process exited non-zero — parse output for counts anyway. A file that
    // died before it could report (a bad import, a throwing top-level await) is
    // charged one failure by summarizeTestOutput, so the grand total can never
    // read "0 failed" for a run that just listed failed files.
    const output = (err.stdout || "") + (err.stderr || "");
    const { passed, failed, reported } = summarizeTestOutput(output);

    totalPass += passed;
    totalFail += failed;

    collectServiceSkips(label, output);

    console.log(
      reported
        ? `  \x1b[31mFAIL\x1b[0m ${label} (${passed} passed, ${failed} failed)`
        : `  \x1b[31mFAIL\x1b[0m ${label} (died before reporting — no summary line)`
    );
    failures.push(label);

    // Print output for debugging
    if (output.trim()) {
      const lines = output.trim().split("\n");
      // Show only FAIL lines and errors for brevity
      const relevant = lines.filter(
        (l) => l.includes("FAIL") || l.includes("Error") || l.includes("error")
      );
      if (relevant.length > 0) {
        for (const line of relevant) {
          console.log(`    ${line}`);
        }
      }
    }
  }
}

// ── The vitest suites, run HERE rather than left to the caller ────────────
//
// i18n.test.ts and i18n-leaf-alias.test.ts are vitest suites, which tsx cannot
// execute, so they are filtered out of the file list above. They used to be the
// caller's problem -- package.json chains `tsx test/run-all.ts && npm run
// test:i18n` -- and every lab script invokes THIS FILE DIRECTLY. So 44 tests
// never ran in a single lab verification, and were not reported as skipped
// either: filtered out before counting, invisible in a headline that read
// "253 files, 0 failed".
//
// Running them from here means no invoker can miss them. If vitest is somehow
// unavailable the run FAILS rather than quietly dropping them again -- silently
// losing coverage is the exact failure this replaces.
if (VITEST_FILES.size > 0) {
  const vitestArgs = [...VITEST_FILES].map((f) => `test/${f}`);
  console.log(`\n${"─".repeat(60)}\n  vitest suites: ${vitestArgs.join(", ")}\n`);
  const vit = spawnSync("npx", ["vitest", "run", ...vitestArgs], {
    cwd: join(__dirname, ".."),
    encoding: "utf8",
    stdio: "pipe",
  });
  const vout = (vit.stdout ?? "") + (vit.stderr ?? "");
  console.log(vout.trim());
  // "Tests  44 passed (44)" is vitest's own tally; trust it over re-counting.
  // Strip ANSI first: vitest colourises its summary, so /Tests\s+(\d+)\s+passed/
  // never matched the real bytes and every green run was scored as a failure --
  // 44 passing tests reported as "vitest run failed (exit 0)".
  const plain = vout.replace(/\x1b\[[0-9;]*m/g, "");
  const m = plain.match(/Tests\s+(?:(\d+)\s+failed[^\n]*?)?(\d+)\s+passed/);
  const vFail = m?.[1] ? Number(m[1]) : 0;
  const vPass = m?.[2] ? Number(m[2]) : 0;
  if (vit.status !== 0 || vPass === 0) {
    totalFail += Math.max(vFail, 1);
    filesFailed += VITEST_FILES.size;
    failures.push(...vitestArgs);
    console.log(
      `  \x1b[31mvitest run failed (exit ${vit.status}) — these suites are NOT optional\x1b[0m`
    );
  } else {
    totalPass += vPass;
    totalFail += vFail;
  }
  filesRun += VITEST_FILES.size;
}

// Grand summary
console.log(`\n${"=".repeat(60)}`);
// The file-level count is part of the headline, not a footnote: case counts
// come from each file's own summary, so a file that dies before printing one
// contributes no cases and would otherwise vanish from the number a human reads.
console.log(
  `  Grand Total: \x1b[32m${totalPass} passed\x1b[0m, \x1b[31m${totalFail} failed\x1b[0m` +
    `, \x1b[33m${allSkips.length} skipped\x1b[0m` +
    ` across ${filesRun} files (\x1b[31m${filesFailed} files failed\x1b[0m)`
);
if (failures.length > 0) {
  console.log(`  Failed files: ${failures.join(", ")}`);
}
console.log(`${"=".repeat(60)}\n`);

// The skip roster. A count alone cannot be acted on — driving skips to zero
// needs the REASON for each one, which is exactly what the discarded per-file
// output used to hide.
if (allSkips.length > 0) {
  console.log(`  \x1b[33mSkipped (${allSkips.length}):\x1b[0m`);
  for (const { file, reason } of allSkips) {
    console.log(`    - [${file}] ${reason}`);
  }
  console.log("");
}

// Real-service gate verdict. With TINA4_REQUIRE_SERVICES set, a skip caused by
// a PROVISIONED service being unavailable fails the whole run — a green skip of
// an integration test in CI is exactly what we must never allow.
if (gateOn && serviceSkips.length > 0) {
  console.log(
    "\x1b[31m  TINA4_REQUIRE_SERVICES is set, but real-service tests SKIPPED because a\x1b[0m"
  );
  console.log(
    "\x1b[31m  provisioned service or client library was unavailable:\x1b[0m"
  );
  for (const { file, reason } of serviceSkips) {
    console.log(`\x1b[31m    - [${file}] ${reason}\x1b[0m`);
  }
  console.log(
    "\x1b[31m  Provision the service / install the client, or unset TINA4_REQUIRE_SERVICES.\x1b[0m\n"
  );
}

const gateFailed = gateOn && serviceSkips.length > 0;

// Set the exit CODE and let the process exit on its own — do NOT call
// process.exit() here. process.exit() tears the process down synchronously and
// DISCARDS anything still sitting in an asynchronously-buffered stdout, and this
// runner's stdout IS async-buffered whenever it is not a TTY: a backgrounded
// run, a pipe (`npm test | tee`), or a CI log capture. The loop above is ~260
// back-to-back execSync() calls, each of which blocks the event loop, so the
// per-file PASS lines queue up faster than libuv can flush them to a pipe and a
// large backlog builds by the tail of the run. process.exit() then threw that
// backlog away — INCLUDING this Grand Total summary — so a piped/backgrounded
// run stopped mid-list with no summary and exit 1, while the identical run in a
// terminal (synchronous stdout) looked fine. Assigning process.exitCode lets the
// event loop drain the buffered writes and exit with the right code on its own;
// the runner holds no open handles (every child is reaped by execSync/spawnSync),
// so it exits promptly once stdout has drained.
process.exitCode = totalFail > 0 || filesFailed > 0 || gateFailed ? 1 : 0;
