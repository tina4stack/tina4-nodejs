/**
 * CLI command: test — Run project tests.
 *
 * Looks for test files and executes them with tsx.
 * Supports: test/integration.ts, test/*.ts, tests/*.ts, *.test.ts patterns.
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";

export async function runTests(testPath?: string): Promise<void> {
  const cwd = process.cwd();

  // If a specific test file is provided, run it directly
  if (testPath) {
    const file = resolve(testPath);
    if (!existsSync(file)) {
      console.error(`  Error: Test file not found: ${testPath}`);
      process.exit(1);
    }
    console.log(`  Running: ${testPath}\n`);
    try {
      execSync(`npx tsx "${file}"`, { cwd, stdio: "inherit" });
    } catch {
      process.exit(1);
    }
    return;
  }

  // Auto-discover test files
  const candidates = [
    "test/integration.ts",
    "test",
    "tests",
  ];

  let testFiles: string[] = [];

  for (const candidate of candidates) {
    const fullPath = resolve(cwd, candidate);
    if (!existsSync(fullPath)) continue;

    // If it's a file, run it
    if (candidate.endsWith(".ts")) {
      testFiles.push(fullPath);
      break;
    }

    // If it's a directory, collect all .ts and .test.ts files
    try {
      const files = readdirSync(fullPath)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join(fullPath, f));
      testFiles.push(...files);
    } catch {
      // skip
    }
    if (testFiles.length > 0) break;
  }

  if (testFiles.length === 0) {
    console.log("  No test files found.");
    console.log("  Looked in: test/integration.ts, test/*.ts, tests/*.ts");
    return;
  }

  console.log(`  Found ${testFiles.length} test file(s)\n`);

  let failed = false;
  for (const file of testFiles) {
    const relative = file.replace(cwd + "/", "");
    console.log(`  Running: ${relative}`);
    try {
      execSync(`npx tsx "${file}"`, { cwd, stdio: "inherit" });
    } catch {
      failed = true;
    }
  }

  if (failed) {
    process.exit(1);
  }
}
