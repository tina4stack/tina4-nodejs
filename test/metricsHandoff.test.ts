import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enginePath, fileDetail, fullAnalysis, MetricsEngineError } from "../packages/core/src/metrics.ts";

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  PASS ${name}`);
    passed++;
  } else {
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

const directory = mkdtempSync(join(tmpdir(), "tina4-metrics-handoff-"));
const source = join(directory, "orders.ts");
try {
  writeFileSync(source, "export function total(lines: unknown[]): number { return lines.length; }\n");
  assert("native tina4 CLI is on PATH", enginePath() !== null);

  const full = fullAnalysis(directory);
  assert("full analysis names native engine", full.engine === "tina4-cli");
  assert("full analysis returns source files", full.files_analyzed >= 1);
  assert("full analysis preserves chart payload", Array.isArray(full.file_metrics) && !!full.dependency_graph);

  const detail = fileDetail(source);
  assert("file detail names native engine", detail.engine === "tina4-cli");
  assert("file detail identifies source", String(detail.path).endsWith("orders.ts"));
  assert("file detail preserves function count", detail.function_count >= 1);
  assert("file detail returns chart functions", Array.isArray(detail.functions));
  assert("file detail returns native function name", detail.functions[0]?.name === "total");

  let error: unknown;
  try { fileDetail(join(directory, "missing.ts")); } catch (caught) { error = caught; }
  assert("missing file fails loudly", error instanceof MetricsEngineError && /no such file/.test(error.message));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
