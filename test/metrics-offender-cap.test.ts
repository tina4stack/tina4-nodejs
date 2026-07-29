/**
 * Regression: the metrics offenders list must NOT be capped to the top-15
 * most-complex functions.
 *
 * Latent bug (fixed): fullAnalysis() returned `most_complex_functions.slice(0,15)`
 * and offenders() sourced the complexity offenders from that capped list, so the
 * 16th+ function over the complexity threshold was silently dropped from the
 * offenders list, the total_offenders count, AND the `--fail-on` gate — a
 * genuinely too-complex function escaped the build gate. offenders() now reads
 * the full `all_functions` list; `most_complex_functions.slice(0,15)` stays for
 * the display report.
 *
 * No mocks: writes a real .ts file and runs the real analyzer over it.
 *
 * Run with: npx tsx test/metrics-offender-cap.test.ts
 */
import { offenders, fullAnalysis } from "../packages/core/src/metrics.ts";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

console.log("=== Metrics Offender-Cap Regression ===\n");

let seq = 0;
/** Fresh, unique temp root so fullAnalysis's mtime/hash cache never collides. */
function freshRoot(label: string): string {
  const dir = join(tmpdir(), `tina4-metrics-cap-${label}-${process.pid}-${Date.now()}-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A function with `decisions` independent `if` statements ->
 * cyclomatic complexity = 1 + decisions. 22 -> CC 23 (> 20 => "error" severity).
 */
function highCcFunction(name: string, decisions = 22): string {
  const body = Array.from(
    { length: decisions },
    (_, j) => `  if (${j} === ${j}) { count++; }`
  ).join("\n");
  return `export function ${name}(): number {\n  let count = 0;\n${body}\n  return count;\n}\n`;
}

/** Write a single module of `n` high-CC functions into a fresh root. */
function writeBigModule(root: string, n: number): void {
  const source = Array.from({ length: n }, (_, i) => highCcFunction(`fn${i}`)).join("\n");
  writeFileSync(join(root, "bigmod.ts"), source);
}

// ── offenders() is NOT capped at the top-15 complex functions ──────────────
console.log("--- offenders(): all 18 over-threshold functions surface (not just 15) ---");
{
  const n = 18; // > 15, so the old slice(0,15) cap would silently drop fn15..fn17
  const root = freshRoot("offenders");
  writeBigModule(root, n);

  const result = offenders(root, 100);
  const complexity = result.offenders.filter((o) => o.kind === "complexity");

  // All 18 over-threshold functions must surface (old code: exactly 15).
  assert(
    `all ${n} complexity offenders surface (not top-15 capped)`,
    complexity.length === n,
    `expected ${n}, got ${complexity.length} — top-15 cap regression`
  );
  // They are error-severity (CC 23 > 20) and therefore MUST reach --fail-on error.
  assert(
    "every complexity offender is error severity (CC 23 > 20)",
    complexity.every((o) => o.severity === "error")
  );
  assert(
    `summary.total_offenders >= ${n}`,
    result.summary.total_offenders >= n,
    `got ${result.summary.total_offenders}`
  );

  rmSync(root, { recursive: true, force: true });
}

// ── The display report keeps its top-15 contract ──────────────────────────
console.log("\n--- fullAnalysis(): display report still caps most_complex at 15 ---");
{
  const n = 18;
  const root = freshRoot("display");
  writeBigModule(root, n);

  const analysis = fullAnalysis(root);
  assert(
    "most_complex_functions is display-capped at 15",
    analysis.most_complex_functions.length === 15,
    `got ${analysis.most_complex_functions.length}`
  );
  // fullAnalysis no longer republishes the uncapped function list: the engine
  // ranks offenders itself and its own --fail-on gate reads that same ranking,
  // so the CLI and the dashboard cannot disagree. total_offenders is the honest
  // proof nothing was lost at the display cap.
  assert(
    "the engine owns the ranking now (no all_functions)",
    analysis.all_functions === undefined,
    `got ${JSON.stringify(analysis.all_functions)}`
  );
  const uncapped = offenders(root, Number.MAX_SAFE_INTEGER);
  assert(
    `total_offenders counts the whole set (>= ${n})`,
    uncapped.summary.total_offenders >= n,
    `got ${uncapped.summary.total_offenders}`
  );

  rmSync(root, { recursive: true, force: true });
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
