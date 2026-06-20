/**
 * Regression tests for the metrics test-coverage detector
 * (packages/core/src/metrics.ts → hasMatchingTest, surfaced via the "untested"
 * offender kind in offenders()).
 *
 * Mirrors the Python master fix (tina4-python cd4a1c5,
 * dev_admin/metrics.py _has_matching_test): the dashboard "T" badge and
 * `tina4 metrics` "untested" list were mislabelling heavily-tested files as
 * UNTESTED. Two causes, both reproduced here:
 *
 *   (1) the module-path import patterns must match the FULL package path a test
 *       actually uses ("../packages/.../mod.ts") — including the TS inline-type
 *       `import("…/mod.ts").Type` idiom — by treating the leading qualifier as
 *       an optional SUFFIX boundary;
 *   (2) the defined-class symbol gate required name.length > 3, silently
 *       dropping short-but-real classes like ORM/Api/Log/Env so a test that
 *       references `new Api()` / `Log.error()` left the file flagged UNTESTED.
 *       Gate lowered to > 2.
 *
 * Run with: npx tsx test/metricsCoverage.test.ts
 */
import { offenders } from "../packages/core/src/metrics.ts";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
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

/** True when the analyzer flags `relFile` (relative to the scan root) UNTESTED. */
function isUntested(root: string, relFile: string): boolean {
  const r = offenders(root, 500);
  return r.offenders.some((o) => o.kind === "untested" && o.file === relFile);
}

console.log("=== Metrics Coverage Detection Tests ===\n");

// ── Cause (2): a 3-char class referenced by a test counts as tested ──────────
console.log("--- 3-char class referenced by a test is detected as tested ---");
{
  const root = "/tmp/tina4-metrics-cov-cls-" + Date.now();
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });

  // A source file whose ONLY exported symbol is a 3-char class — the exact
  // shape (ORM/Api/Log/Env) the old `length > 3` gate dropped.
  writeFileSync(
    join(root, "src", "orm.ts"),
    `export class ORM {\n  connect(): boolean { return true; }\n}\n`
  );
  // A test that references the class BY NAME only (no path import) — must count.
  writeFileSync(
    join(root, "test", "orm-usage.test.ts"),
    `import { something } from "../src/other.js";\nconst x = new ORM();\nx.connect();\n`
  );
  // A control file with a 3-char class that NO test mentions — stays untested.
  // The class name is assembled at runtime ("Q" + "qz") so the literal never
  // appears verbatim in THIS test file — otherwise the cwd test-dir scan would
  // see it here and wrongly count the control as covered.
  const ctrlCls = "Q" + "qz";
  writeFileSync(
    join(root, "src", "ctrl3.ts"),
    `export class ${ctrlCls} {\n  noop(): void {}\n}\n`
  );

  assert(
    "3-char class ORM referenced by test → NOT untested",
    !isUntested(join(root, "src"), "orm.ts")
  );
  assert(
    "unreferenced 3-char class → still untested (no false positive)",
    isUntested(join(root, "src"), "ctrl3.ts")
  );

  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

// ── Cause (1): full-path / inline-type import is matched as a suffix ─────────
console.log("\n--- full package-path import (incl. inline type import) is detected ---");
{
  const root = "/tmp/tina4-metrics-cov-imp-" + Date.now();
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });

  // An interface-only module (no class) — coverage can ONLY come from a path
  // import, never a class-name reference.
  writeFileSync(
    join(root, "src", "widgetConnection.ts"),
    `export interface WidgetConnection {\n  id: string;\n  send(data: string): void;\n}\n`
  );
  // A test that references it ONLY through the TS inline-type import idiom with
  // the FULL relative path + .ts extension (the line shape that previously
  // slipped past every import regex).
  writeFileSync(
    join(root, "test", "widget.test.ts"),
    `const conn: import("../src/widgetConnection.ts").WidgetConnection = {\n` +
      `  id: "1",\n  send(_d: string) {},\n};\nvoid conn;\n`
  );
  // A control interface-only module no test references at all. Interface name
  // assembled at runtime so the literal never appears verbatim in THIS file.
  const ctrlIface = "Sol" + "oIface";
  writeFileSync(
    join(root, "src", "ctrlIface.ts"),
    `export interface ${ctrlIface} {\n  x: number;\n}\n`
  );

  assert(
    "inline-type import of full .ts path → NOT untested",
    !isUntested(join(root, "src"), "widgetConnection.ts")
  );
  assert(
    "unreferenced interface module → still untested (no false positive)",
    isUntested(join(root, "src"), "ctrlIface.ts")
  );

  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

// ── Outcome guard: the framework's own websocketConnection.ts is tested ──────
console.log("\n--- framework outcome: websocketConnection.ts is NOT untested ---");
{
  // packages/core/src/websocketConnection.ts is exercised by
  // test/websocket.test.ts via `import("../packages/core/src/websocketConnection.ts")`.
  // Before the fix it was wrongly flagged UNTESTED.
  assert(
    "packages/core/src/websocketConnection.ts → NOT untested",
    !isUntested("packages/core/src", "websocketConnection.ts")
  );
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
