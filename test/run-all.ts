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
import { requireServices, findProvisionedServiceSkips } from "./_serviceGate.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

// Discover all test files
const testFiles = readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.ts"))
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

function collectServiceSkips(label: string, output: string): void {
  if (!gateOn || !output) return;
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
    const match = output.match(/(\d+)\s+passed.*?(\d+)\s+failed/);
    const passed = match ? parseInt(match[1], 10) : 0;
    const failed = match ? parseInt(match[2], 10) : 0;

    totalPass += passed;
    totalFail += failed;
    filesRun++;

    collectServiceSkips(label, output);

    if (failed > 0) {
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

    // The process exited non-zero — parse output for counts anyway
    const output = (err.stdout || "") + (err.stderr || "");
    const match = output.match(/(\d+)\s+passed.*?(\d+)\s+failed/);
    const passed = match ? parseInt(match[1], 10) : 0;
    const failed = match ? parseInt(match[2], 10) : 0;

    totalPass += passed;
    totalFail += failed;

    collectServiceSkips(label, output);

    console.log(`  \x1b[31mFAIL\x1b[0m ${label} (${passed} passed, ${failed} failed)`);
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
console.log(
  `  Grand Total: \x1b[32m${totalPass} passed\x1b[0m, \x1b[31m${totalFail} failed\x1b[0m across ${filesRun} files`
);
if (failures.length > 0) {
  console.log(`  Failed files: ${failures.join(", ")}`);
}
console.log(`${"=".repeat(60)}\n`);

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
