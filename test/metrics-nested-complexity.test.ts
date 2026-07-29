/**
 * Nested functions are measured once, not charged to every enclosing function.
 *
 * Each function's raw score covers its whole span, so a branch inside a nested
 * function used to land on that function AND every function around it. The
 * over-count compounded with depth: an IIFE wrapper or a registrar defining
 * twenty inner handlers absorbed the whole file's complexity and topped the
 * offenders list, hiding the real hot spots. Parity with Python master, PHP,
 * Ruby and the Rust engine.
 *
 * Run with: npx tsx test/metrics-nested-complexity.test.ts
 */
import { fullAnalysis } from "../packages/core/src/metrics.ts";
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

const tmpDir = "/tmp/tina4-metrics-nested-" + process.pid + "-" + Date.now();

async function complexityByName(source: string): Promise<Record<string, number>> {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, "nested.ts"), source);
  const result: any = await fullAnalysis(tmpDir);
  const byName: Record<string, number> = {};
  for (const f of result.most_complex_functions ?? []) byName[f.name] = f.complexity;
  return byName;
}

console.log("=== Metrics: nested complexity ===\n");

async function main() {
  let cc = await complexityByName(
    `export function outer(a: number) {
  function inner1(x: number) { if (x) { return 1; } if (x > 2) { return 2; } return 3; }
  function inner2(y: number) { if (y) { return 1; } if (y > 2) { return 2; } return 3; }
  return inner1(a) + inner2(a);
}
`,
  );
  assert(
    "a parent with no branches of its own scores 1",
    cc.outer === 1,
    `got ${cc.outer} (was 5 before the fix)`,
  );
  assert("inner1 keeps its own branches", cc.inner1 === 3, `got ${cc.inner1}`);
  assert("inner2 keeps its own branches", cc.inner2 === 3, `got ${cc.inner2}`);

  cc = await complexityByName(
    `export function outer(a: number) {
  if (a) { return 0; }
  function inner(x: number) { if (x) { return 1; } return 2; }
  return inner(a);
}
`,
  );
  assert("the parent keeps its own branches", cc.outer === 2, `got ${cc.outer}`);
  assert("the child is unchanged", cc.inner === 2, `got ${cc.inner}`);

  cc = await complexityByName(
    `export function a(x: number) {
  if (x) { x = 1; }
  function b(y: number) {
    if (y) { y = 1; }
    function c(z: number) { if (z) { return 1; } return 2; }
    return c(y);
  }
  return b(x);
}
`,
  );
  assert(
    "three levels deep, each keeps only its own",
    cc.a === 2 && cc.b === 2 && cc.c === 2,
    `got a=${cc.a} b=${cc.b} c=${cc.c}`,
  );

  cc = await complexityByName(
    `class A {
  one(x: number) { if (x) { return 1; } return 2; }
  two(y: number) { if (y) { return 1; } return 2; }
}
export { A };
`,
  );
  // Guards against an over-eager fix that subtracts from siblings too.
  assert(
    "sibling methods never affect each other",
    cc["A.one"] === 2 && cc["A.two"] === 2,
    `got one=${cc["A.one"]} two=${cc["A.two"]}`,
  );

  // --- function LOC counts code lines, same rule as file LOC ---
  // This was `funcBody.split("\n").length` - a raw line span - while file LOC
  // excluded blanks and comments, so `loc` meant two different things at once.
  let full: any = await (async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "loc.ts"),
      `export class A {
  // a comment
  withComments(x: number) {

    /* block comment */

    if (x) { return 1; }
    return 2;
  }
}
`,
    );
    const { fullAnalysis: fa } = await import("../packages/core/src/metrics.ts");
    return fa(tmpDir);
  })();
  const withComments = (full.most_complex_functions ?? []).find((f: any) =>
    String(f.name).endsWith("withComments"),
  );
  assert(
    "function LOC excludes blank lines and comments",
    withComments?.loc === 4,
    `got ${withComments?.loc} (span is 8; code lines are method+if+return+brace)`,
  );

  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, "one.ts"), "export function f() { return 1; }\n");
  full = await (await import("../packages/core/src/metrics.ts")).fullAnalysis(tmpDir);
  assert(
    "function LOC never reports zero",
    (full.most_complex_functions ?? [])[0]?.loc >= 1,
    `got ${(full.most_complex_functions ?? [])[0]?.loc}`,
  );

  rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

await main();
