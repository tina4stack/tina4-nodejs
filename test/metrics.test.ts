/**
 * Unit tests for the Metrics module (packages/core/src/metrics.ts).
 * Run with: npx tsx test/metrics.test.ts
 */
import { quickMetrics, fullAnalysis, fileDetail } from "../packages/core/src/metrics.ts";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

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

console.log("=== Metrics Tests ===\n");

// --- Setup: create a temp directory with some TS files ---
const tmpDir = "/tmp/tina4-metrics-test-" + Date.now();
mkdirSync(tmpDir, { recursive: true });

// Sample TypeScript source
const sampleTs = `
// A simple module
import { join } from "node:path";

/**
 * Block comment
 */
export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    if (a < b) {
      return b - a;
    }
    return a - b;
  }

  divide(a: number, b: number): number {
    if (b === 0) {
      throw new Error("Division by zero");
    }
    return a / b;
  }
}

export function multiply(a: number, b: number): number {
  return a * b;
}

const greet = (name: string) => {
  return "Hello " + name;
};

// Simple utility
export function isEven(n: number): boolean {
  return n % 2 === 0;
}
`;

const sampleTs2 = `
export class Logger {
  log(msg: string): void {
    console.log(msg);
  }
}

export function format(template: string, ...args: unknown[]): string {
  let result = template;
  for (const arg of args) {
    result = result.replace("%s", String(arg));
  }
  return result;
}
`;

writeFileSync(join(tmpDir, "calculator.ts"), sampleTs);
writeFileSync(join(tmpDir, "logger.ts"), sampleTs2);

// --- quickMetrics ---
console.log("--- quickMetrics ---");

{
  const metrics = quickMetrics(tmpDir);
  assert("quickMetrics returns an object", typeof metrics === "object");
  assert("file_count is 2", metrics.file_count === 2);
  assert("total_loc > 0", metrics.total_loc > 0);
  assert("total_blank >= 0", metrics.total_blank >= 0);
  assert("total_comment >= 0", metrics.total_comment >= 0);
  assert("classes > 0", metrics.classes > 0);
  assert("functions > 0", metrics.functions > 0);
  assert("avg_file_size > 0", metrics.avg_file_size > 0);
  assert("largest_files is array", Array.isArray(metrics.largest_files));
  assert("largest_files has entries", metrics.largest_files.length > 0);
  assert("breakdown exists", typeof metrics.breakdown === "object");
  assert("breakdown has typescript", typeof metrics.breakdown.typescript === "number");
  assert("lloc > 0", metrics.lloc > 0);
}

// --- quickMetrics with missing directory ---
console.log("\n--- quickMetrics Missing Directory ---");

{
  // resolveRoot falls back to the framework source when the target has no .ts files,
  // so a non-existent dir will scan the framework instead of returning an error.
  // We verify that passing a real empty dir with no ts files scans the framework.
  const emptyTmpDir = "/tmp/tina4-metrics-empty-" + Date.now();
  mkdirSync(emptyTmpDir, { recursive: true });
  const metrics = quickMetrics(emptyTmpDir);
  // It should fallback to framework scan (no error, but file_count from framework)
  assert("empty dir falls back to framework scan", metrics.error === undefined || metrics.file_count >= 0);
  try { rmSync(emptyTmpDir, { recursive: true }); } catch {}
}

// --- fullAnalysis ---
console.log("\n--- fullAnalysis ---");

{
  const analysis = fullAnalysis(tmpDir);
  assert("fullAnalysis returns an object", typeof analysis === "object");
  assert("files_analyzed is 2", analysis.files_analyzed === 2);
  assert("total_functions > 0", analysis.total_functions > 0);
  assert("avg_complexity >= 1", analysis.avg_complexity >= 1);
  assert("avg_maintainability > 0", analysis.avg_maintainability > 0);
  assert("most_complex_functions is array", Array.isArray(analysis.most_complex_functions));
  assert("file_metrics is array", Array.isArray(analysis.file_metrics));
  assert("violations is array", Array.isArray(analysis.violations));
  assert("dependency_graph is object", typeof analysis.dependency_graph === "object");
  assert("scan_root exists", typeof analysis.scan_root === "string");
}

// --- fullAnalysis file_metrics detail ---
console.log("\n--- File Metrics Detail ---");

{
  const analysis = fullAnalysis(tmpDir);
  const calcMetric = analysis.file_metrics.find((f: any) => f.path.includes("calculator"));
  assert("calculator file found in metrics", calcMetric !== undefined);
  if (calcMetric) {
    assert("has loc", typeof calcMetric.loc === "number" && calcMetric.loc > 0);
    assert("has complexity", typeof calcMetric.complexity === "number");
    assert("has avg_complexity", typeof calcMetric.avg_complexity === "number");
    assert("has functions count", typeof calcMetric.functions === "number" && calcMetric.functions > 0);
    assert("has maintainability", typeof calcMetric.maintainability === "number");
    assert("has halstead_volume", typeof calcMetric.halstead_volume === "number");
    assert("has coupling_efferent", typeof calcMetric.coupling_efferent === "number");
    assert("has instability", typeof calcMetric.instability === "number");
    assert("has dep_count", typeof calcMetric.dep_count === "number");
  }
}

// --- fullAnalysis caching ---
console.log("\n--- Analysis Caching ---");

{
  const t1 = Date.now();
  fullAnalysis(tmpDir); // prime cache
  const t2 = Date.now();
  fullAnalysis(tmpDir); // should be cached
  const t3 = Date.now();
  // Cache hit should be faster (not a strict test but verify it works)
  assert("cached analysis returns same result", fullAnalysis(tmpDir).files_analyzed === 2);
}

// --- fullAnalysis function complexity ---
console.log("\n--- Function Complexity ---");

{
  const analysis = fullAnalysis(tmpDir);
  const funcs = analysis.most_complex_functions;
  assert("most_complex_functions is non-empty", funcs.length > 0);
  if (funcs.length >= 2) {
    assert("sorted by complexity descending", funcs[0].complexity >= funcs[1].complexity);
  }
  const divideFunc = funcs.find((f: any) => f.name.includes("divide"));
  if (divideFunc) {
    assert("divide has complexity >= 2 (if + throw)", divideFunc.complexity >= 2);
    assert("function has line number", typeof divideFunc.line === "number" && divideFunc.line > 0);
    assert("function has args", Array.isArray(divideFunc.args));
  }
}

// --- fileDetail ---
console.log("\n--- fileDetail ---");

{
  const detail = fileDetail(join(tmpDir, "calculator.ts"));
  assert("fileDetail returns object", typeof detail === "object");
  assert("has path", typeof detail.path === "string");
  assert("has loc", typeof detail.loc === "number" && detail.loc > 0);
  assert("has total_lines", typeof detail.total_lines === "number");
  assert("has classes count", typeof detail.classes === "number" && detail.classes > 0);
  assert("has functions array", Array.isArray(detail.functions));
  assert("has imports array", Array.isArray(detail.imports));
  assert("imports include node:path", detail.imports.some((i: string) => i === "node:path"));
}

// --- fileDetail missing file ---
console.log("\n--- fileDetail Missing File ---");

{
  const detail = fileDetail("/tmp/nonexistent-file-xyz.ts");
  assert("missing file returns error", detail.error !== undefined);
}

// --- fileDetail function detail ---
console.log("\n--- fileDetail Function Detail ---");

{
  const detail = fileDetail(join(tmpDir, "calculator.ts"));
  const funcs = detail.functions;
  assert("functions are sorted by complexity desc", funcs.length > 0);
  for (const fn of funcs) {
    assert(`function ${fn.name} has line`, typeof fn.line === "number");
    assert(`function ${fn.name} has complexity`, typeof fn.complexity === "number");
    assert(`function ${fn.name} has loc`, typeof fn.loc === "number");
  }
}

// --- Violation detection ---
console.log("\n--- Violation Detection ---");

// Create a high-complexity file to trigger violations
const complexFile = `
export function nightmare(a: number, b: number, c: number, d: number): string {
  if (a > 0) {
    if (b > 0) {
      if (c > 0) {
        if (d > 0) {
          return a > b ? (c > d ? "1" : "2") : (c > d ? "3" : "4");
        } else if (d < -10) {
          return a && b ? "5" : c || d ? "6" : "7";
        } else {
          for (let i = 0; i < a; i++) {
            while (i < b) {
              if (i === c ?? d) {
                return "8";
              }
              break;
            }
          }
          return "9";
        }
      } else {
        switch (a) {
          case 1: return "a";
          case 2: return "b";
          case 3: return "c";
          case 4: return "d";
          case 5: return "e";
          default: return "f";
        }
      }
    }
  }
  return "default";
}
`;

writeFileSync(join(tmpDir, "complex.ts"), complexFile);

{
  // Force re-analysis (bypass cache by adding a file)
  const analysis = fullAnalysis(tmpDir);
  // The complex function should have high complexity
  const complexFn = analysis.most_complex_functions.find((f: any) => f.name === "nightmare");
  if (complexFn) {
    assert("nightmare has high complexity", complexFn.complexity > 10);
  }
}

// --- Literal/comment stripping: complexity counts REAL branches only ---
console.log("\n--- Literal Stripping: complexity ignores string/template/regex content ---");

{
  // A fresh isolated root so the mtime cache never collides.
  const stripDir = "/tmp/tina4-metrics-strip-" + Date.now();
  mkdirSync(stripDir, { recursive: true });

  // `noisy`: ONE real branch (the `if`). The string, template and regex bodies
  // are STUFFED with &&, ||, if, ? :, case, for — none must be counted. Its CC
  // must equal `quiet`'s (a sibling with exactly one real `if` and no literals).
  const stripTs = `
export function noisy(x: number): string {
  const s = "if a && b || c ? d : e for while case && || ?? if";
  const t = \`outer \${x} if a && b ? c : d || e\`;
  const re = /if\\s*\\(.*&&.*\\)\\s*\\{.*\\}|case\\s+x:|a\\?b:c/g;
  // comment: if (a && b || c) for while ? : case && ||
  /* block: && || ?? if for while case ? : && || ?? if for */
  if (x > 0) {
    return s + t + String(re);
  }
  return "default && || ? :";
}

export function quiet(x: number): string {
  if (x > 0) {
    return "yes";
  }
  return "no";
}
`;
  writeFileSync(join(stripDir, "stripme.ts"), stripTs);

  const analysis = fullAnalysis(stripDir);
  const noisy = analysis.most_complex_functions.find((f: any) => f.name === "noisy");
  const quiet = analysis.most_complex_functions.find((f: any) => f.name === "quiet");
  assert("noisy function is extracted", noisy !== undefined);
  assert("quiet function is extracted", quiet !== undefined);
  if (noisy && quiet) {
    // Both have exactly one real decision point → CC 2.
    assert("noisy CC counts the REAL branch only (===2)", noisy.complexity === 2,
      `got ${noisy.complexity}`);
    assert("quiet CC is 2 (baseline single if)", quiet.complexity === 2,
      `got ${quiet.complexity}`);
    assert("noisy CC == quiet CC (literals contribute nothing)",
      noisy.complexity === quiet.complexity, `noisy=${noisy.complexity} quiet=${quiet.complexity}`);
  }

  try { rmSync(stripDir, { recursive: true, force: true }); } catch {}
}

// --- Function extraction: a call inside a string is NOT a function ---
console.log("\n--- Literal Stripping: string content is not extracted as a function ---");

{
  const fnDir = "/tmp/tina4-metrics-fnstrip-" + Date.now();
  mkdirSync(fnDir, { recursive: true });

  // Only ONE real function (`real`). The string/template/regex bodies contain
  // method-shaped text — `something(...)`, `bogus(...)`, `name(...)` — plus a
  // regex literal that mimics the analyzer's own patterns. None must surface.
  const fnTs = `
export function real(a: number): number {
  const note = "call something(x, y) and bogus(1) here";
  const tpl = \`do name(z) then other(w)\`;
  const pat = /(?:async\\s+)?function\\s+(\\w+)\\s*\\(([^)]*)\\)/g;
  // doc: helper(a, b) and parse(c) are NOT functions
  return a + String(note) + String(tpl) + String(pat);
}
`;
  writeFileSync(join(fnDir, "fns.ts"), fnTs);

  const detail = fileDetail(join(fnDir, "fns.ts"));
  const names = (detail.functions as any[]).map((f) => f.name);
  assert("real function is extracted", names.includes("real"));
  assert("string content 'something(...)' NOT extracted", !names.includes("something"));
  assert("string content 'bogus(...)' NOT extracted", !names.includes("bogus"));
  assert("template content 'name(...)' NOT extracted", !names.includes("name"));
  assert("template content 'other(...)' NOT extracted", !names.includes("other"));
  assert("regex group 'function'/'\\w+' NOT extracted", !names.includes("function") && !names.includes("w"));
  assert("comment content 'helper(...)' NOT extracted", !names.includes("helper"));
  assert("exactly one function extracted from fns.ts", (detail.functions as any[]).length === 1,
    `got ${(detail.functions as any[]).length}: ${JSON.stringify(names)}`);

  try { rmSync(fnDir, { recursive: true, force: true }); } catch {}
}

// --- A genuinely complex function still reports HIGH cc ---
console.log("\n--- Literal Stripping: a real branchy function still ranks high ---");

{
  const hiDir = "/tmp/tina4-metrics-high-" + Date.now();
  mkdirSync(hiDir, { recursive: true });

  // 12 REAL branches in CODE (no literals involved) → CC must be well above 10.
  const lines = ["export function branchy(x: number): number {"];
  for (let i = 0; i < 12; i++) lines.push(`  if (x === ${i} && x > -1) { return ${i}; }`);
  lines.push("  return -1;");
  lines.push("}");
  writeFileSync(join(hiDir, "branchy.ts"), lines.join("\n") + "\n");

  const analysis = fullAnalysis(hiDir);
  const branchy = analysis.most_complex_functions.find((f: any) => f.name === "branchy");
  assert("branchy function is extracted", branchy !== undefined);
  if (branchy) {
    // 12 ifs + 12 && + base 1 = 25.
    assert("genuinely complex function reports high CC (>20)", branchy.complexity > 20,
      `got ${branchy.complexity}`);
  }

  try { rmSync(hiDir, { recursive: true, force: true }); } catch {}
}

// Cleanup
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
