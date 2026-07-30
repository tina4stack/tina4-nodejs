/**
 * Contract test for how the runner reads a test file's summary line.
 *
 * REGRESSION: five metrics files died at import, printed no summary, and were
 * read as "0 passed, 0 failed" — so the grand total announced
 * `6112 passed, 0 failed` on the line directly above a `Failed files:` list
 * naming all five. A separate file (devAdmin.test) exited 0 without a summary
 * after a genuinely failing assertion and was reported `PASS (0 passed)`.
 *
 * Both come from the same hole: "no summary line" was treated as two zeroes
 * instead of "this file never reported a result". Locked in here positive and
 * negative so the headline number can never disagree with the failure list.
 *
 * Run with: npx tsx test/testSummaryContract.test.ts
 */
import { summarizeTestOutput } from "./_testSummary.ts";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

console.log("=== Test Summary Contract ===\n");

// ── Positive: a file that reports its results ─────────────────
console.log("--- reported runs ---");

const green = summarizeTestOutput("  Results: 7 passed, 0 failed, 0 skipped");
assert("a green summary reports its pass count", green.passed === 7, `passed=${green.passed}`);
assert("a green summary reports zero failures", green.failed === 0, `failed=${green.failed}`);
assert("a green summary is marked reported", green.reported === true);

const red = summarizeTestOutput("  Results: 190 passed, 3 failed");
assert("a red summary keeps its real failure count", red.failed === 3, `failed=${red.failed}`);
assert("a red summary keeps its real pass count", red.passed === 190, `passed=${red.passed}`);
assert("a red summary is marked reported", red.reported === true);

// An all-skipped run (Firebird in the main job) is a genuine zero-zero report,
// NOT a missing summary — it must stay green and must not be charged a failure.
const skipped = summarizeTestOutput("  Results: 0 passed, 0 failed, 7 skipped");
assert("an all-skipped run is reported, not charged", skipped.reported === true && skipped.failed === 0,
  `reported=${skipped.reported} failed=${skipped.failed}`);

// ── Negative: a file that never reports ───────────────────────
console.log("\n--- unreported runs (the regression) ---");

// This is the actual shape of a file that dies at import.
const crashed = summarizeTestOutput(
  "TypeError: Cannot read properties of undefined (reading 'jobs')\n" +
    "    at file:///repo/test/devAdmin.test.ts:535:31"
);
assert("a crash with no summary is NOT marked reported", crashed.reported === false);
assert("a crash with no summary is charged one failure", crashed.failed === 1, `failed=${crashed.failed}`);
assert("a crash with no summary claims no passes", crashed.passed === 0, `passed=${crashed.passed}`);

const silent = summarizeTestOutput("=== versionConsistency: ok ===");
assert("a clean exit with no summary is NOT marked reported", silent.reported === false);
assert("a clean exit with no summary is charged one failure", silent.failed === 1, `failed=${silent.failed}`);

const empty = summarizeTestOutput("");
assert("empty output is charged one failure", empty.failed === 1 && empty.reported === false,
  `failed=${empty.failed} reported=${empty.reported}`);

// The headline invariant: an unreported file must move the failure total, so a
// grand total can never read "0 failed" while naming files as failed.
const files = ["  Results: 10 passed, 0 failed", "boom, no summary here", ""];
const totalFailed = files.reduce((sum, out) => sum + summarizeTestOutput(out).failed, 0);
assert("two unreported files move the grand total off zero", totalFailed === 2, `totalFailed=${totalFailed}`);

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
