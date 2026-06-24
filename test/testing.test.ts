/**
 * Unit tests for the inline testing framework (testing.ts).
 * Run with: npx tsx test/testing.test.ts
 */
import { tests, assertEqual, assertRaises, assertTrue, assertFalse, runAll, reset } from "../packages/core/src/index.ts";

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

console.log("=== Inline Testing Framework Tests ===\n");

// --- Exports (behavioural) ---
console.log("--- Exports (behavioural) ---");

// tests() registers exactly one entry that runAll reports as a single pass.
reset();
tests(assertEqual([1, 1], 2))(function f(a: number, b: number): number { return a + b; });
{
  const r = runAll({ quiet: true });
  assert("tests registers one passing entry", r.passed === 1 && r.failed === 0 && r.errors === 0 && r.details.length === 1);
}

// assertEqual drives a real comparison: 1+1+1 == 3 passes against add3.
reset();
tests(assertEqual([1, 1, 1], 3))(function add3(a: number, b: number, c: number): number { return a + b + c; });
assert("assertEqual is exercised by runAll", runAll({ quiet: true }).passed === 1);

// assertRaises catches a real thrown error.
reset();
tests(assertRaises(Error, [null]))(function g(b: number | null): number { if (b === null) throw new Error("x"); return b; });
assert("assertRaises is exercised by runAll", runAll({ quiet: true }).passed === 1);

// assertTrue verifies a real truthy result.
reset();
tests(assertTrue([1]))(function idTrue(x: unknown): unknown { return x; });
assert("assertTrue is exercised by runAll", runAll({ quiet: true }).passed === 1);

// assertFalse verifies a real falsy result.
reset();
tests(assertFalse([0]))(function idFalse(x: unknown): unknown { return x; });
assert("assertFalse is exercised by runAll", runAll({ quiet: true }).passed === 1);

// runAll returns a real results summary reflecting the registered tests.
reset();
tests(assertEqual([2, 2], 4))(function add2(a: number, b: number): number { return a + b; });
assert("runAll reports the registered pass", runAll({ quiet: true }).passed === 1);

// reset() clears the registry: after reset, runAll sees nothing.
reset();
tests(assertEqual([9, 9], 18))(function add9(a: number, b: number): number { return a + b; });
reset();
{
  const r = runAll({ quiet: true });
  assert("reset clears the registry", r.passed === 0 && r.failed === 0 && r.errors === 0 && r.details.length === 0);
}

// --- assertEqual (behavioural) ---
console.log("\n--- assertEqual ---");

function addEq(a: number, b: number): number { return a + b; }

// The built assertion actually drives a passing test against add(2,3)===5.
reset();
tests(assertEqual([2, 3], 5))(addEq);
assert("assertEqual drives a passing test", runAll({ quiet: true }).passed === 1);

// The 'equal' assertion FAILS when the function returns the wrong value.
reset();
tests(assertEqual([1, 1], 999))(addEq);
{
  const r = runAll({ quiet: true });
  assert("assertEqual fails on wrong return value", r.failed === 1 && r.details[0].status === "failed");
}

// The stored args are actually passed to the function: [2,3] applied -> 5.
reset();
tests(assertEqual([2, 3], 5))(function add(a: number, b: number): number { return a + b; });
assert("assertEqual passes stored args to the function", runAll({ quiet: true }).passed === 1);

// The expected value is the comparison target: 1+1!==3 fails, ===2 passes.
reset();
tests(assertEqual([1, 1], 3))(addEq);
assert("assertEqual expected is the comparison target (mismatch fails)", runAll({ quiet: true }).failed === 1);
reset();
tests(assertEqual([1, 1], 2))(addEq);
assert("assertEqual expected is the comparison target (match passes)", runAll({ quiet: true }).passed === 1);

// --- assertRaises (behavioural) ---
console.log("\n--- assertRaises ---");

// The raises assertion catches a thrown Error.
reset();
tests(assertRaises(Error, [null]))(function fRaises(b: number | null): number { if (b === null) throw new Error("x"); return b; });
assert("assertRaises catches the thrown Error", runAll({ quiet: true }).passed === 1);

// A raises assertion FAILS when no error is thrown.
reset();
tests(assertRaises(Error, [1]))(function fNoThrow(b: number): number { return b; });
assert("assertRaises fails when nothing is thrown", runAll({ quiet: true }).failed === 1);

// The exception class is matched: wrong class does NOT pass, right class does.
reset();
tests(assertRaises(TypeError, [null]))(function fRange(): number { throw new RangeError("x"); });
assert("assertRaises fails on wrong exception class", runAll({ quiet: true }).passed === 0);
reset();
tests(assertRaises(RangeError, [null]))(function fRange2(): number { throw new RangeError("x"); });
assert("assertRaises passes on matching exception class", runAll({ quiet: true }).passed === 1);

// The args reach the function: 'bad' triggers the throw.
reset();
tests(assertRaises(Error, ["bad"]))(function fArg(x: string): void { if (x === "bad") throw new Error("boom"); });
assert("assertRaises passes args through to the function", runAll({ quiet: true }).passed === 1);

// --- assertTrue (behavioural) ---
console.log("\n--- assertTrue ---");

function idT(x: unknown): unknown { return x; }

// 42 is truthy -> assertTrue passes.
reset();
tests(assertTrue([42]))(idT);
assert("assertTrue passes on a truthy result", runAll({ quiet: true }).passed === 1);

// 0 is falsy -> assertTrue fails.
reset();
tests(assertTrue([0]))(idT);
assert("assertTrue fails on a falsy result", runAll({ quiet: true }).failed === 1);

// The arg drives truthiness: 0 fails, 42 passes.
reset();
tests(assertTrue([0]))(idT);
assert("assertTrue arg drives truthiness (0 fails)", runAll({ quiet: true }).failed === 1);
reset();
tests(assertTrue([42]))(idT);
assert("assertTrue arg drives truthiness (42 passes)", runAll({ quiet: true }).passed === 1);

// --- assertFalse (behavioural) ---
console.log("\n--- assertFalse ---");

function idF(x: unknown): unknown { return x; }

// 0 is falsy -> assertFalse passes.
reset();
tests(assertFalse([0]))(idF);
assert("assertFalse passes on a falsy result", runAll({ quiet: true }).passed === 1);

// 1 is truthy -> assertFalse fails.
reset();
tests(assertFalse([1]))(idF);
assert("assertFalse fails on a truthy result", runAll({ quiet: true }).failed === 1);

// The arg drives falsiness: 1 fails, 0 passes.
reset();
tests(assertFalse([1]))(idF);
assert("assertFalse arg drives falsiness (1 fails)", runAll({ quiet: true }).failed === 1);
reset();
tests(assertFalse([0]))(idF);
assert("assertFalse arg drives falsiness (0 passes)", runAll({ quiet: true }).passed === 1);

// --- tests decorator ---
console.log("\n--- tests Decorator ---");

reset();

function originalAdd(a: number, b: number): number {
  return a + b;
}
const add = tests(
  assertEqual([2, 3], 5),
  assertEqual([0, 0], 0),
  assertEqual([-1, 1], 0),
)(originalAdd);

// tests() returns the SAME function object unchanged (identity), still callable.
assert("tests() returns the original function (identity)", add === originalAdd);
assert("Decorated function still works", add(10, 20) === 30);

// --- runAll with passing tests ---
console.log("\n--- runAll Passing ---");

const results = runAll({ quiet: true });
assert("runAll returns results object", results !== null);
// passed count is the real number of passing assertions (3 add tests).
assert("Results passed count is the real value (3)", results.passed === 3);
// failed count is the real number of failures (none here).
assert("Results failed count is the real value (0)", results.failed === 0);
// errors count is the real number of errors (none here).
assert("Results errors count is the real value (0)", results.errors === 0);
// details holds one real entry per assertion, with the real recorded status.
assert("Results details holds one entry per assertion", results.details.length === 3 && results.details[0].status === "passed");
assert("All 3 add tests passed", results.passed === 3);
assert("No failures", results.failed === 0);
assert("No errors", results.errors === 0);
assert("Details has 3 entries", results.details.length === 3);
assert("First detail status is passed", results.details[0].status === "passed");

// --- runAll with failing test ---
console.log("\n--- runAll Failing ---");

reset();

tests(
  assertEqual([1, 1], 999),  // This will fail: 1+1=2, not 999
)(function badAdd(a: number, b: number): number {
  return a + b;
});

const failResults = runAll({ quiet: true });
assert("Failing test increments failed count", failResults.failed === 1);
assert("Failing test detail has status 'failed'", failResults.details[0].status === "failed");
assert("Failing test detail has message", typeof failResults.details[0].message === "string");

// --- runAll with error (throws) ---
console.log("\n--- runAll with assertRaises ---");

reset();

tests(
  assertRaises(Error, [null]),
  assertEqual([5, 3], 8),
)(function divide(a: number, b: number | null = null): number {
  if (b === null) throw new Error("b required");
  return a + b;
});

const throwResults = runAll({ quiet: true });
assert("assertRaises passes when error thrown", throwResults.passed === 2);
assert("No failures in throw test", throwResults.failed === 0);

// --- assertTrue / assertFalse in runAll ---
console.log("\n--- assertTrue/assertFalse in Runner ---");

reset();

tests(
  assertTrue([1]),
  assertTrue(["hello"]),
  assertFalse([0]),
  assertFalse([""]),
  assertFalse([null]),
)(function identity(x: unknown): unknown {
  return x;
});

const boolResults = runAll({ quiet: true });
assert("All truthy/falsy assertions pass", boolResults.passed === 5 && boolResults.failed === 0);

// --- reset ---
console.log("\n--- reset ---");

reset();
const emptyResults = runAll({ quiet: true });
assert("After reset, no tests run", emptyResults.passed === 0 && emptyResults.failed === 0 && emptyResults.errors === 0);
assert("After reset, details empty", emptyResults.details.length === 0);

// --- failfast option ---
console.log("\n--- failfast ---");

reset();

tests(
  assertEqual([1, 1], 999),  // fail
  assertEqual([1, 1], 2),    // would pass, but won't run with failfast
)(function mathy(a: number, b: number): number {
  return a + b;
});

const ffResults = runAll({ quiet: true, failfast: true });
assert("Failfast stops after first failure", ffResults.details.length === 1);
assert("Failfast reports the failure", ffResults.failed === 1);

// --- Named function preserved ---
console.log("\n--- Function Name ---");

reset();

const myFunc = tests()(function namedFunction(x: number): number { return x; });
assert("Named function name preserved", myFunc.name === "namedFunction");

// --- Anonymous function ---
reset();

const anonFunc = tests()((x: number) => x * 2);
assert("Anonymous function works", anonFunc(5) === 10);

// Cleanup
reset();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
