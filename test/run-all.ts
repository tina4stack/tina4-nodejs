/**
 * Test runner — executes ALL test files and aggregates results.
 * Run with: npx tsx test/run-all.ts
 *
 * Each test file is spawned as a child process so its process.exit()
 * doesn't kill the runner. Pass/fail counts are parsed from each
 * file's summary line and aggregated into a grand total.
 */
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
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

// Discover all test files.
// The i18n suites are vitest tests (describe/it/expect) — they are run by the
// `test:i18n` npm script (`vitest run …`), NOT by this tsx-spawning runner,
// so skip them here (tsx can't execute a vitest suite — it errors on the
// `vitest` import). The root `npm test` runs this runner THEN `test:i18n`.
const VITEST_FILES = new Set(["i18n.test.ts", "i18n-leaf-alias.test.ts"]);

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

const testFiles = readdirSync(__dirname)
  .filter(
    (f) =>
      f.endsWith(".test.ts") &&
      !VITEST_FILES.has(f) &&
      !(skipMetrics && METRICS_FILES.has(f))
  )
  .sort();

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
process.exit(totalFail > 0 || filesFailed > 0 || gateFailed ? 1 : 0);
