/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Unit tests for the inline testing framework (testing.ts).
 * Run with: npx tsx test/testing.test.ts
 */
import { tests, expectEqual, expectRaises, expectTrue, expectFalse, runAll, reset } from "../packages/core/src/index.ts";
import * as testingApi from "../packages/core/src/index.ts";

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
tests(expectEqual([1, 1], 2))(function f(a: number, b: number): number { return a + b; });
{
  const r = runAll({ quiet: true });
  assert("tests registers one passing entry", r.passed === 1 && r.failed === 0 && r.errors === 0 && r.details.length === 1);
}

// expectEqual drives a real comparison: 1+1+1 == 3 passes against add3.
reset();
tests(expectEqual([1, 1, 1], 3))(function add3(a: number, b: number, c: number): number { return a + b + c; });
assert("expectEqual is exercised by runAll", runAll({ quiet: true }).passed === 1);

// expectRaises catches a real thrown error.
reset();
tests(expectRaises(Error, [null]))(function g(b: number | null): number { if (b === null) throw new Error("x"); return b; });
assert("expectRaises is exercised by runAll", runAll({ quiet: true }).passed === 1);

// expectTrue verifies a real truthy result.
reset();
tests(expectTrue([1]))(function idTrue(x: unknown): unknown { return x; });
assert("expectTrue is exercised by runAll", runAll({ quiet: true }).passed === 1);

// expectFalse verifies a real falsy result.
reset();
tests(expectFalse([0]))(function idFalse(x: unknown): unknown { return x; });
assert("expectFalse is exercised by runAll", runAll({ quiet: true }).passed === 1);

// runAll returns a real results summary reflecting the registered tests.
reset();
tests(expectEqual([2, 2], 4))(function add2(a: number, b: number): number { return a + b; });
assert("runAll reports the registered pass", runAll({ quiet: true }).passed === 1);

// reset() clears the registry: after reset, runAll sees nothing.
reset();
tests(expectEqual([9, 9], 18))(function add9(a: number, b: number): number { return a + b; });
reset();
{
  const r = runAll({ quiet: true });
  assert("reset clears the registry", r.passed === 0 && r.failed === 0 && r.errors === 0 && r.details.length === 0);
}

// --- expectEqual (behavioural) ---
console.log("\n--- expectEqual ---");

function addEq(a: number, b: number): number { return a + b; }

// The built assertion actually drives a passing test against add(2,3)===5.
reset();
tests(expectEqual([2, 3], 5))(addEq);
assert("expectEqual drives a passing test", runAll({ quiet: true }).passed === 1);

// The 'equal' assertion FAILS when the function returns the wrong value.
reset();
tests(expectEqual([1, 1], 999))(addEq);
{
  const r = runAll({ quiet: true });
  assert("expectEqual fails on wrong return value", r.failed === 1 && r.details[0].status === "failed");
}

// The stored args are actually passed to the function: [2,3] applied -> 5.
reset();
tests(expectEqual([2, 3], 5))(function add(a: number, b: number): number { return a + b; });
assert("expectEqual passes stored args to the function", runAll({ quiet: true }).passed === 1);

// The expected value is the comparison target: 1+1!==3 fails, ===2 passes.
reset();
tests(expectEqual([1, 1], 3))(addEq);
assert("expectEqual expected is the comparison target (mismatch fails)", runAll({ quiet: true }).failed === 1);
reset();
tests(expectEqual([1, 1], 2))(addEq);
assert("expectEqual expected is the comparison target (match passes)", runAll({ quiet: true }).passed === 1);

// --- expectRaises (behavioural) ---
console.log("\n--- expectRaises ---");

// The raises assertion catches a thrown Error.
reset();
tests(expectRaises(Error, [null]))(function fRaises(b: number | null): number { if (b === null) throw new Error("x"); return b; });
assert("expectRaises catches the thrown Error", runAll({ quiet: true }).passed === 1);

// A raises assertion FAILS when no error is thrown.
reset();
tests(expectRaises(Error, [1]))(function fNoThrow(b: number): number { return b; });
assert("expectRaises fails when nothing is thrown", runAll({ quiet: true }).failed === 1);

// The exception class is matched: wrong class does NOT pass, right class does.
reset();
tests(expectRaises(TypeError, [null]))(function fRange(): number { throw new RangeError("x"); });
assert("expectRaises fails on wrong exception class", runAll({ quiet: true }).passed === 0);
reset();
tests(expectRaises(RangeError, [null]))(function fRange2(): number { throw new RangeError("x"); });
assert("expectRaises passes on matching exception class", runAll({ quiet: true }).passed === 1);

// The args reach the function: 'bad' triggers the throw.
reset();
tests(expectRaises(Error, ["bad"]))(function fArg(x: string): void { if (x === "bad") throw new Error("boom"); });
assert("expectRaises passes args through to the function", runAll({ quiet: true }).passed === 1);

// --- expectTrue (behavioural) ---
console.log("\n--- expectTrue ---");

function idT(x: unknown): unknown { return x; }

// 42 is truthy -> expectTrue passes.
reset();
tests(expectTrue([42]))(idT);
assert("expectTrue passes on a truthy result", runAll({ quiet: true }).passed === 1);

// 0 is falsy -> expectTrue fails.
reset();
tests(expectTrue([0]))(idT);
assert("expectTrue fails on a falsy result", runAll({ quiet: true }).failed === 1);

// The arg drives truthiness: 0 fails, 42 passes.
reset();
tests(expectTrue([0]))(idT);
assert("expectTrue arg drives truthiness (0 fails)", runAll({ quiet: true }).failed === 1);
reset();
tests(expectTrue([42]))(idT);
assert("expectTrue arg drives truthiness (42 passes)", runAll({ quiet: true }).passed === 1);

// --- expectFalse (behavioural) ---
console.log("\n--- expectFalse ---");

function idF(x: unknown): unknown { return x; }

// 0 is falsy -> expectFalse passes.
reset();
tests(expectFalse([0]))(idF);
assert("expectFalse passes on a falsy result", runAll({ quiet: true }).passed === 1);

// 1 is truthy -> expectFalse fails.
reset();
tests(expectFalse([1]))(idF);
assert("expectFalse fails on a truthy result", runAll({ quiet: true }).failed === 1);

// The arg drives falsiness: 1 fails, 0 passes.
reset();
tests(expectFalse([1]))(idF);
assert("expectFalse arg drives falsiness (1 fails)", runAll({ quiet: true }).failed === 1);
reset();
tests(expectFalse([0]))(idF);
assert("expectFalse arg drives falsiness (0 passes)", runAll({ quiet: true }).passed === 1);

// --- tests decorator ---
console.log("\n--- tests Decorator ---");

reset();

function originalAdd(a: number, b: number): number {
  return a + b;
}
const add = tests(
  expectEqual([2, 3], 5),
  expectEqual([0, 0], 0),
  expectEqual([-1, 1], 0),
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
  expectEqual([1, 1], 999),  // This will fail: 1+1=2, not 999
)(function badAdd(a: number, b: number): number {
  return a + b;
});

const failResults = runAll({ quiet: true });
assert("Failing test increments failed count", failResults.failed === 1);
assert("Failing test detail has status 'failed'", failResults.details[0].status === "failed");
assert("Failing test detail has message", typeof failResults.details[0].message === "string");

// --- runAll with error (throws) ---
console.log("\n--- runAll with expectRaises ---");

reset();

tests(
  expectRaises(Error, [null]),
  expectEqual([5, 3], 8),
)(function divide(a: number, b: number | null = null): number {
  if (b === null) throw new Error("b required");
  return a + b;
});

const throwResults = runAll({ quiet: true });
assert("expectRaises passes when error thrown", throwResults.passed === 2);
assert("No failures in throw test", throwResults.failed === 0);

// --- expectTrue / expectFalse in runAll ---
console.log("\n--- expectTrue/expectFalse in Runner ---");

reset();

tests(
  expectTrue([1]),
  expectTrue(["hello"]),
  expectFalse([0]),
  expectFalse([""]),
  expectFalse([null]),
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
  expectEqual([1, 1], 999),  // fail
  expectEqual([1, 1], 2),    // would pass, but won't run with failfast
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

// --- async test functions ---
// runAll() is synchronous: it cannot judge an async function and must say so
// (an error naming runAllAsync), never count it as a pass. runAllAsync()
// awaits each call and judges what it resolves to.
console.log("\n--- async ---");

const runAllAsync = (testingApi as Record<string, unknown>).runAllAsync as
  | ((o?: { quiet?: boolean; failfast?: boolean; timeoutMs?: number }) => Promise<ReturnType<typeof runAll>>)
  | undefined;
assert("runAllAsync is exported", typeof runAllAsync === "function");
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
const unhandled: unknown[] = [];
process.on("unhandledRejection", (e) => { unhandled.push(e); });

reset();
tests(expectTrue([]))(async function resolvesFalse(): Promise<boolean> { await tick(); return false; });
{
  const r = runAll({ quiet: true });
  assert("runAll never passes an async function", r.passed === 0);
  assert("runAll reports an async function as an error naming runAllAsync",
    r.errors === 1 && /runAllAsync/.test(r.details[0]?.message ?? ""));
}

reset();
tests(expectTrue([]))(async function rejectsInSync(): Promise<boolean> { await tick(); throw new TypeError("db gone"); });
{
  const r = runAll({ quiet: true });
  await tick(); await tick();
  assert("runAll leaves no unhandled rejection behind", r.errors === 1 && unhandled.length === 0);
}

// The documented recipe for synchronous tests keeps working unchanged.
reset();
tests(expectEqual([2, 3], 5))(function addSync(a: number, b: number): number { return a + b; });
{
  const results = runAll({ quiet: true });
  assert("documented recipe: const results = runAll(); results.failed === 0", results.failed === 0 && results.passed === 1);
}

if (runAllAsync) {
  reset();
  tests(expectTrue([]))(async function asyncFalse(): Promise<boolean> { await tick(); return false; });
  assert("runAllAsync fails expectTrue when the function resolves falsy", (await runAllAsync({ quiet: true })).failed === 1);

  reset();
  tests(expectTrue([]))(async function asyncTrue(): Promise<boolean> { await tick(); return true; });
  assert("runAllAsync passes expectTrue when the function resolves truthy", (await runAllAsync({ quiet: true })).passed === 1);

  reset();
  tests(expectEqual([2], 3), expectEqual([2], 5))(async function addOne(n: number): Promise<number> { await tick(); return n + 1; });
  {
    const r = await runAllAsync({ quiet: true });
    assert("runAllAsync compares the resolved value", r.passed === 1 && r.failed === 1);
  }

  reset();
  tests(expectRaises(RangeError, [-1]), expectRaises(RangeError, [1]))(async function rejects(n: number): Promise<number> {
    await tick();
    if (n < 0) throw new RangeError("negative");
    return n;
  });
  {
    const r = await runAllAsync({ quiet: true });
    assert("runAllAsync expectRaises: right rejection passes, no rejection fails", r.passed === 1 && r.failed === 1);
  }

  reset();
  tests(expectTrue([]))(async function rejectsUnexpectedly(): Promise<boolean> { await tick(); throw new TypeError("db gone"); });
  {
    const r = await runAllAsync({ quiet: true });
    assert("runAllAsync: an unexpected rejection is an error, not a pass", r.errors === 1 && r.passed === 0);
  }

  reset();
  tests(expectTrue([]))(function neverSettles(): Promise<boolean> { return new Promise(() => {}); });
  {
    const started = Date.now();
    const r = await runAllAsync({ quiet: true, timeoutMs: 100 });
    assert("runAllAsync reports a never-settling call as a timeout error",
      r.errors === 1 && /did not settle/.test(r.details[0]?.message ?? "") && Date.now() - started < 5000);
  }

  reset();
  tests(expectTrue([]))(function thenable(): PromiseLike<boolean> {
    return { then: (ok: (v: boolean) => void) => { ok(false); } } as PromiseLike<boolean>;
  });
  assert("runAllAsync judges a non-Promise thenable on its value", (await runAllAsync({ quiet: true })).failed === 1);

  reset();
  tests(expectTrue([]), expectTrue([]))(async function failsTwice(): Promise<boolean> { await tick(); return false; });
  {
    const r = await runAllAsync({ quiet: true, failfast: true });
    assert("runAllAsync failfast stops after the first failure", r.details.length === 1 && r.failed === 1);
  }

  reset();
  tests(expectEqual([4], 5))(function syncInAsync(n: number): number { return n + 1; });
  assert("runAllAsync still runs synchronous tests", (await runAllAsync({ quiet: true })).passed === 1);
}

// Cleanup
reset();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
