/**
 * Lock-in tests for `tina4nodejs metrics` — the offenders() analyzer and the
 * CLI handler (packages/core/src/metrics.ts + packages/cli/src/commands/metrics.ts).
 *
 * Engine/CLI-agnostic: builds throwaway projects on disk, runs the real
 * analyzer + the real CLI handler, and asserts on the structured offenders
 * list, the --json shape, --top truncation, the "clean" path, and every
 * --fail-on exit-code branch. Also locks in the PRECISE test-detection fix:
 * a file with no DEDICATED test reports untested, while a file a test really
 * imports reports tested.
 *
 * These guard against silent drift in the scoring rules, the exit-code
 * contract, or the coverage-badge precision.
 *
 * Run with: npx tsx test/metrics-cli.test.ts
 */
import { offenders, fullAnalysis, SEVERITY_RANK } from "../packages/core/src/metrics.ts";
import { runMetrics } from "../packages/cli/src/commands/metrics.ts";
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

console.log("=== Metrics CLI / offenders Tests ===\n");

// ── Helpers ────────────────────────────────────────────────────────────

let seq = 0;
/** Make a fresh temp project root (unique → fullAnalysis cache never collides). */
function freshRoot(label: string): string {
  const dir = join(tmpdir(), `tina4-metrics-cli-${label}-${process.pid}-${Date.now()}-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const originalCwd = process.cwd();
/** Run fn with cwd chdir'd into root, restoring cwd afterwards. */
function inDir<T>(root: string, fn: () => T): T {
  process.chdir(root);
  try {
    return fn();
  } finally {
    process.chdir(originalCwd);
  }
}

/** Capture everything written to stdout while fn runs. */
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // @ts-expect-error — narrow override for the test
  process.stdout.write = (chunk: any) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

/** A function whose cyclomatic complexity exceeds 20 (an "error" offender). */
function badFunctionSource(name = "messy", branches = 25): string {
  const lines = [`export function ${name}(x: number): number {`];
  for (let i = 0; i < branches; i++) {
    lines.push(`  if (x === ${i}) {`);
    lines.push(`    return ${i};`);
    lines.push("  }");
  }
  lines.push("  return -1;");
  lines.push("}");
  return lines.join("\n") + "\n";
}

/** A file with > 500 lines of code (a "large_file" warn offender). */
function hugeFileSource(loc = 600): string {
  let out = "";
  for (let i = 0; i < loc; i++) out += `const a${i} = ${i};\n`;
  return out;
}

/** Lay down a src/ tree with a deliberately bad, untested module. */
function writeBadProject(root: string): void {
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  // One module that is BOTH over-complex AND huge AND untested.
  const bad = badFunctionSource() + "\n" + hugeFileSource();
  writeFileSync(join(src, "bad.ts"), bad);
}

/** A tiny, simple, tested src/ tree → zero offenders. */
function writeCleanProject(root: string): void {
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "clean.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  const tests = join(root, "test");
  mkdirSync(tests, { recursive: true });
  // A precise IMPORTING test so has_tests is True (not an "untested" offender).
  writeFileSync(
    join(tests, "clean.test.ts"),
    'import { add } from "../src/clean.js";\nadd(1, 2);\n'
  );
}

// ── offenders() — positive ─────────────────────────────────────────────

console.log("--- offenders() positive: each kind surfaces ---");
{
  const root = freshRoot("bad-kinds");
  writeBadProject(root);
  const result = inDir(root, () => offenders("src", 50));
  const offs = result.offenders;
  const kinds = new Set(offs.map((o) => o.kind));

  assert("over-20 CC function flagged as 'complexity'", kinds.has("complexity"));
  assert(">500 LOC file flagged as 'large_file'", kinds.has("large_file"));
  assert("module with no dedicated test flagged as 'untested'", kinds.has("untested"));

  const complexity = offs.find((o) => o.kind === "complexity");
  assert("complexity offender is error severity (CC>20)", complexity?.severity === "error");
  assert("complexity score > 20", (complexity?.score ?? 0) > 20);
  assert("complexity detail mentions complexity", /complexity/i.test(complexity?.detail ?? ""));

  const large = offs.find((o) => o.kind === "large_file");
  assert("large_file offender is warn severity", large?.severity === "warn");
  assert("large_file detail mentions LOC", /LOC/.test(large?.detail ?? ""));
  assert("large_file score = loc/100", (large?.score ?? 0) > 5);

  const untested = offs.find((o) => o.kind === "untested");
  assert("untested offender is info severity", untested?.severity === "info");

  rmSync(root, { recursive: true, force: true });
}

console.log("\n--- offenders() positive: required keys ---");
{
  const root = freshRoot("keys");
  writeBadProject(root);
  const offs = inDir(root, () => offenders("src", 50)).offenders;
  let allHaveKeys = offs.length > 0;
  for (const o of offs) {
    for (const k of ["file", "line", "kind", "severity", "score", "detail"] as const) {
      if (!(k in o)) allHaveKeys = false;
    }
  }
  assert("every offender has file/line/kind/severity/score/detail", allHaveKeys);
  rmSync(root, { recursive: true, force: true });
}

console.log("\n--- offenders() positive: ranking (error > warn > info, then score) ---");
{
  const root = freshRoot("ranking");
  writeBadProject(root);
  const offs = inDir(root, () => offenders("src", 50)).offenders;
  const ranks = offs.map((o) => SEVERITY_RANK[o.severity]);
  const sortedDesc = [...ranks].sort((a, b) => b - a);
  assert("offenders are severity-descending", JSON.stringify(ranks) === JSON.stringify(sortedDesc));
  assert("first offender is error severity", offs[0]?.severity === "error");

  // Within the top error run, score must be non-increasing.
  let scoreOrderOk = true;
  for (let i = 1; i < offs.length; i++) {
    if (SEVERITY_RANK[offs[i].severity] === SEVERITY_RANK[offs[i - 1].severity]) {
      if (offs[i].score > offs[i - 1].score) scoreOrderOk = false;
    }
  }
  assert("within a severity tier, score is non-increasing", scoreOrderOk);
  rmSync(root, { recursive: true, force: true });
}

console.log("\n--- offenders() positive: summary headline numbers ---");
{
  const root = freshRoot("summary");
  writeBadProject(root);
  const summary = inDir(root, () => offenders("src", 5)).summary;
  assert("summary.files_analyzed >= 1", summary.files_analyzed >= 1);
  assert("summary.total_offenders >= 3", summary.total_offenders >= 3);
  assert("summary has avg_complexity", "avg_complexity" in summary);
  assert("summary has avg_maintainability", "avg_maintainability" in summary);
  assert("summary has total_functions", "total_functions" in summary);
  assert("summary.scan_mode is project|framework", ["project", "framework"].includes(summary.scan_mode));
  assert("summary has scan_root", typeof summary.scan_root === "string");
  rmSync(root, { recursive: true, force: true });
}

console.log("\n--- offenders() positive: --top truncates ---");
{
  const root = freshRoot("top");
  writeBadProject(root);
  const top1 = inDir(root, () => offenders("src", 1));
  assert("top=1 returns exactly 1 offender", top1.offenders.length === 1);
  assert("summary.total_offenders unaffected by truncation (>= 3)", top1.summary.total_offenders >= 3);
  rmSync(root, { recursive: true, force: true });
}

// ── offenders() — negative ──────────────────────────────────────────────

console.log("\n--- offenders() negative: clean project = no offenders ---");
{
  const root = freshRoot("clean");
  writeCleanProject(root);
  const result = inDir(root, () => offenders("src", 20));
  assert("clean project has zero offenders", result.offenders.length === 0);
  assert("clean project summary.total_offenders === 0", result.summary.total_offenders === 0);
  rmSync(root, { recursive: true, force: true });
}

// ── PRECISE test-detection fix (Part A) ─────────────────────────────────

console.log("\n--- detection-fix: no-dedicated-test file reports UNTESTED ---");
{
  // A "default DB adapter" with NO dedicated test, and an UNRELATED test in the
  // tree that merely mentions the word "sqlite" as a string — the old loose
  // bare-word/parent-dir heuristic would have falsely marked it tested.
  const root = freshRoot("untested");
  const src = join(root, "src", "adapters");
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, "sqlite.ts"),
    "export class SqliteAdapter {\n  connect() { return true; }\n}\n"
  );
  // sibling source so the scan isn't a single file
  writeFileSync(join(root, "src", "index.ts"), 'export const name = "app";\n');
  const tests = join(root, "test");
  mkdirSync(tests, { recursive: true });
  // A test for SOMETHING ELSE that only mentions "sqlite" as a bare word/string,
  // never imports the module, never references the SqliteAdapter class.
  writeFileSync(
    join(tests, "index.test.ts"),
    'import { name } from "../src/index.js";\n' +
      'const note = "we use sqlite by default";\n' +
      "void name; void note;\n"
  );
  const analysis = inDir(root, () => fullAnalysis("src"));
  const sqliteFm = analysis.file_metrics.find((f: any) => f.path.includes("sqlite"));
  assert("sqlite adapter file is in metrics", sqliteFm !== undefined);
  assert(
    "no-dedicated-test adapter reports has_tests === false",
    sqliteFm?.has_tests === false
  );

  // And it surfaces as an 'untested' offender.
  const offs = inDir(root, () => offenders("src", 50)).offenders;
  const untested = offs.find((o) => o.kind === "untested" && o.file.includes("sqlite"));
  assert("sqlite adapter surfaces as an 'untested' offender", untested !== undefined);
  rmSync(root, { recursive: true, force: true });
}

console.log("\n--- detection-fix: a file a test really IMPORTS reports TESTED ---");
{
  const root = freshRoot("imported");
  const src = join(root, "src", "adapters");
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, "mysql.ts"),
    "export class MysqlAdapter {\n  connect() { return true; }\n}\n"
  );
  const tests = join(root, "test");
  mkdirSync(tests, { recursive: true });
  // A test that ACTUALLY imports the module path (not a dedicated mysql.test.ts —
  // proving import-based detection, not just filename detection).
  writeFileSync(
    join(tests, "database-drivers.test.ts"),
    'import { MysqlAdapter } from "../src/adapters/mysql.js";\n' +
      "const a = new MysqlAdapter();\nvoid a;\n"
  );
  const analysis = inDir(root, () => fullAnalysis("src"));
  const mysqlFm = analysis.file_metrics.find((f: any) => f.path.includes("mysql"));
  assert("mysql adapter file is in metrics", mysqlFm !== undefined);
  assert("imported adapter reports has_tests === true", mysqlFm?.has_tests === true);
  rmSync(root, { recursive: true, force: true });
}

console.log("\n--- detection-fix: a test referencing a DEFINED class reports TESTED ---");
{
  const root = freshRoot("classref");
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, "widget.ts"),
    "export class WidgetFactory {\n  build() { return {}; }\n}\n"
  );
  const tests = join(root, "test");
  mkdirSync(tests, { recursive: true });
  // No import of widget, but references the distinctive class name it defines.
  writeFileSync(
    join(tests, "misc.test.ts"),
    "// exercises the factory indirectly\nconst f: any = (globalThis as any).WidgetFactory;\nvoid f;\n"
  );
  const analysis = inDir(root, () => fullAnalysis("src"));
  const fm = analysis.file_metrics.find((f: any) => f.path.includes("widget"));
  assert("class-referenced file reports has_tests === true", fm?.has_tests === true);
  rmSync(root, { recursive: true, force: true });
}

console.log("\n--- detection-fix: dedicated <module>.test.ts reports TESTED ---");
{
  const root = freshRoot("dedicated");
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "thing.ts"), "export const x = 1;\n");
  const tests = join(root, "test");
  mkdirSync(tests, { recursive: true });
  // Dedicated file by name, even with empty body, counts.
  writeFileSync(join(tests, "thing.test.ts"), "// dedicated test\n");
  const analysis = inDir(root, () => fullAnalysis("src"));
  const fm = analysis.file_metrics.find((f: any) => f.path.includes("thing"));
  assert("dedicated <module>.test.ts marks file tested", fm?.has_tests === true);
  rmSync(root, { recursive: true, force: true });
}

console.log("\n--- detection-fix: parent-dir test does NOT blanket-mark siblings ---");
{
  // One test_database / database.test.ts must not mark every file under the
  // dir tested. Here a test imports ONLY postgres; sqlite under the same dir
  // must stay untested.
  const root = freshRoot("noblanket");
  const src = join(root, "src", "adapters");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "postgres.ts"), "export class PostgresAdapter {}\n");
  writeFileSync(join(src, "sqlite.ts"), "export class SqliteAdapter {}\n");
  const tests = join(root, "test");
  mkdirSync(tests, { recursive: true });
  writeFileSync(
    join(tests, "adapters.test.ts"),
    'import { PostgresAdapter } from "../src/adapters/postgres.js";\nvoid PostgresAdapter;\n'
  );
  const analysis = inDir(root, () => fullAnalysis("src"));
  const pg = analysis.file_metrics.find((f: any) => f.path.includes("postgres"));
  const sq = analysis.file_metrics.find((f: any) => f.path.includes("sqlite"));
  assert("imported postgres adapter is tested", pg?.has_tests === true);
  assert("sibling sqlite adapter stays UNtested (no blanket match)", sq?.has_tests === false);
  rmSync(root, { recursive: true, force: true });
}

// ── CLI handler — JSON output ───────────────────────────────────────────

console.log("\n--- CLI --json: valid JSON {summary, offenders}, exit 0 ---");
{
  const root = freshRoot("json");
  writeBadProject(root);
  let out = "";
  const code = inDir(root, () => {
    let rc = -1;
    out = captureStdout(() => {
      rc = runMetrics(["--json"]);
    });
    return rc;
  });
  assert("--json default (no --fail-on) exits 0", code === 0);
  let parsed: any = null;
  let parseOk = true;
  try {
    parsed = JSON.parse(out);
  } catch {
    parseOk = false;
  }
  assert("--json prints ONLY valid JSON", parseOk);
  assert("--json output has summary", parsed && "summary" in parsed);
  assert("--json output has offenders", parsed && "offenders" in parsed);
  assert("--json summary.total_offenders >= 3", parsed?.summary?.total_offenders >= 3);
  assert("--json offenders length >= 3", Array.isArray(parsed?.offenders) && parsed.offenders.length >= 3);
  rmSync(root, { recursive: true, force: true });
}

console.log("\n--- CLI --json --top 1: exactly one offender ---");
{
  const root = freshRoot("json-top");
  writeBadProject(root);
  let out = "";
  inDir(root, () => {
    out = captureStdout(() => runMetrics(["--json", "--top", "1"]));
  });
  const parsed = JSON.parse(out);
  assert("--json --top 1 yields one offender", parsed.offenders.length === 1);
  rmSync(root, { recursive: true, force: true });
}

// ── CLI handler — human output ──────────────────────────────────────────

console.log("\n--- CLI human: clean project prints friendly line, exit 0 ---");
{
  const root = freshRoot("human-clean");
  writeCleanProject(root);
  let out = "";
  const code = inDir(root, () => {
    let rc = -1;
    out = captureStdout(() => {
      rc = runMetrics([]);
    });
    return rc;
  });
  assert("clean project exits 0", code === 0);
  assert("clean project prints 'no offenders'", /no offenders/.test(out));
  rmSync(root, { recursive: true, force: true });
}

console.log("\n--- CLI human: bad project prints ranked table ---");
{
  const root = freshRoot("human-bad");
  writeBadProject(root);
  let out = "";
  const code = inDir(root, () => {
    let rc = -1;
    out = captureStdout(() => {
      rc = runMetrics([]);
    });
    return rc;
  });
  assert("human report (no --fail-on) exits 0", code === 0);
  assert("human report has 'Tina4 Metrics' header", /Tina4 Metrics/.test(out));
  assert("human report has SEVERITY column", /SEVERITY/.test(out));
  assert("human report mentions 'complexity'", /complexity/.test(out));
  rmSync(root, { recursive: true, force: true });
}

// ── CLI handler — exit codes (--fail-on) ────────────────────────────────

console.log("\n--- CLI --fail-on: default exits 0 even with offenders ---");
{
  const root = freshRoot("failon-default");
  writeBadProject(root);
  const code = inDir(root, () => {
    let rc = -1;
    captureStdout(() => {
      rc = runMetrics(["--json"]);
    });
    return rc;
  });
  assert("no --fail-on → exit 0 despite offenders", code === 0);
  rmSync(root, { recursive: true, force: true });
}

console.log("\n--- CLI --fail-on error: exit 1 when an error offender present ---");
{
  const root = freshRoot("failon-error");
  writeBadProject(root); // has an error-severity complexity offender
  const code = inDir(root, () => {
    let rc = -1;
    captureStdout(() => {
      rc = runMetrics(["--json", "--fail-on", "error"]);
    });
    return rc;
  });
  assert("--fail-on error with error offender → exit 1", code === 1);
  rmSync(root, { recursive: true, force: true });
}

console.log("\n--- CLI --fail-on warn: exit 1 when offenders present ---");
{
  const root = freshRoot("failon-warn");
  writeBadProject(root);
  const code = inDir(root, () => {
    let rc = -1;
    captureStdout(() => {
      rc = runMetrics(["--json", "--fail-on", "warn"]);
    });
    return rc;
  });
  assert("--fail-on warn with offenders → exit 1", code === 1);
  rmSync(root, { recursive: true, force: true });
}

console.log("\n--- CLI --fail-on error: exit 0 when only warn/info (warn/info-only fixture) ---");
{
  // 25 trivial functions, untested: offenders are warn (too_many_functions)
  // + info (untested), and — critically — small enough that maintainability
  // stays healthy, so NO error offender. --fail-on error must ignore them.
  const root = freshRoot("warninfo-only");
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  let body = "";
  for (let i = 0; i < 25; i++) body += `export function f${i}(): number {\n  return ${i};\n}\n\n`;
  writeFileSync(join(src, "many.ts"), body);

  let out = "";
  const code = inDir(root, () => {
    let rc = -1;
    out = captureStdout(() => {
      rc = runMetrics(["--json", "--fail-on", "error"]);
    });
    return rc;
  });
  const parsed = JSON.parse(out);
  const severities = new Set(parsed.offenders.map((o: any) => o.severity));
  assert("warn/info fixture produces NO error offender", !severities.has("error"));
  assert("warn/info fixture produces warn and/or info offenders", severities.has("warn") || severities.has("info"));
  assert("--fail-on error ignores warn/info → exit 0", code === 0);
  rmSync(root, { recursive: true, force: true });
}

console.log("\n--- CLI --fail-on warn: exit 1 on the warn-only fixture ---");
{
  const root = freshRoot("warn-only-fail");
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  let body = "";
  for (let i = 0; i < 25; i++) body += `export function f${i}(): number {\n  return ${i};\n}\n\n`;
  writeFileSync(join(src, "many.ts"), body);
  const code = inDir(root, () => {
    let rc = -1;
    captureStdout(() => {
      rc = runMetrics(["--json", "--fail-on", "warn"]);
    });
    return rc;
  });
  assert("--fail-on warn on warn/info fixture → exit 1", code === 1);
  rmSync(root, { recursive: true, force: true });
}

console.log("\n--- CLI --fail-on warn: clean project exits 0 ---");
{
  const root = freshRoot("failon-clean");
  writeCleanProject(root);
  const code = inDir(root, () => {
    let rc = -1;
    captureStdout(() => {
      rc = runMetrics(["--json", "--fail-on", "warn"]);
    });
    return rc;
  });
  assert("clean project with --fail-on warn → exit 0", code === 0);
  rmSync(root, { recursive: true, force: true });
}

console.log("\n--- CLI: bad --fail-on value exits 2 ---");
{
  const root = freshRoot("badflag");
  writeCleanProject(root);
  const code = inDir(root, () => {
    let rc = -1;
    captureStdout(() => {
      rc = runMetrics(["--fail-on", "boom"]);
    });
    return rc;
  });
  assert("invalid --fail-on value → exit 2", code === 2);
  rmSync(root, { recursive: true, force: true });
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
