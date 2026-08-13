/**
 * CLI command: test — Run project tests.
 *
 * Two stages, and the process exits non-zero if EITHER fails:
 *  1. Inline @tests stage (INLINE-DEC-01) — discover functions decorated with the
 *     inline tests() builder under src/ and run them with a real exit code. Only
 *     files that call tests() are imported, so discovery never runs an arbitrary
 *     scanned source file's side effect (INLINE-DEC-02).
 *  2. File-runner stage — execute test files with tsx (test/*.ts, tests/*.ts, an
 *     explicit file arg), propagating their exit codes (python#96 parity).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

/** Collect every .ts/.js file under a directory, recursively. */
function walkSource(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkSource(full));
    } else if (name.endsWith(".ts") || name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Discover inline tests() under src/ and run them. Returns true if any inline
 * test FAILED or ERRORED. Only files that call tests() are imported, so a source
 * file without an inline test is never executed during discovery.
 */
async function runInlineTests(cwd: string): Promise<boolean> {
  const srcDir = resolve(cwd, "src");
  if (!existsSync(srcDir)) return false;

  const { runAll, reset } = await import("@tina4/core");
  reset();

  let discovered = 0;
  for (const file of walkSource(srcDir)) {
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (!/\btests\s*\(/.test(text)) continue; // only files using the inline decorator
    discovered++;
    try {
      await import(pathToFileURL(file).href);
    } catch (err) {
      console.log(
        `  ! could not import ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (discovered === 0) return false;

  const results = runAll();
  return results.failed + results.errors > 0;
}

export async function runTests(testPath?: string): Promise<void> {
  const cwd = process.cwd();

  // Stage 1 — inline @tests discovered under src/, run with a real exit code.
  const inlineFailed = await runInlineTests(cwd);

  // Stage 2 — file runner (existing behaviour), capturing failure into fileFailed.
  let fileFailed = false;

  // If a specific test file is provided, run it directly.
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
      fileFailed = true;
    }
    process.exit(inlineFailed || fileFailed ? 1 : 0);
  }

  // Auto-discover test files.
  const candidates = ["test/integration.ts", "test", "tests"];

  let testFiles: string[] = [];

  for (const candidate of candidates) {
    const fullPath = resolve(cwd, candidate);
    if (!existsSync(fullPath)) continue;

    // If it's a file, run it.
    if (candidate.endsWith(".ts")) {
      testFiles.push(fullPath);
      break;
    }

    // If it's a directory, collect all .ts and .test.ts files.
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
    if (inlineFailed) {
      process.exit(1);
    }
    console.log("  No test files found.");
    console.log("  Looked in: src/**/*.ts (@tests), test/integration.ts, test/*.ts, tests/*.ts");
    process.exit(0);
  }

  console.log(`  Found ${testFiles.length} test file(s)\n`);

  for (const file of testFiles) {
    const relative = file.replace(cwd + "/", "");
    console.log(`  Running: ${relative}`);
    try {
      execSync(`npx tsx "${file}"`, { cwd, stdio: "inherit" });
    } catch {
      fileFailed = true;
    }
  }

  process.exit(inlineFailed || fileFailed ? 1 : 0);
}
