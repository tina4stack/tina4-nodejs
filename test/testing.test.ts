/**
 * Unit tests for the inline testing framework (testing.ts).
 * Run with: npx tsx test/testing.test.ts
 */
import { tests, assertEqual, assertThrows, assertTrue, assertFalse, runAllTests, resetTests } from "../packages/core/src/index.ts";

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

// --- Exports ---
console.log("--- Exports ---");
assert("tests is a function", typeof tests === "function");
assert("assertEqual is a function", typeof assertEqual === "function");
assert("assertThrows is a function", typeof assertThrows === "function");
assert("assertTrue is a function", typeof assertTrue === "function");
assert("assertFalse is a function", typeof assertFalse === "function");
assert("runAllTests is a function", typeof runAllTests === "function");
assert("resetTests is a function", typeof resetTests === "function");

// --- assertEqual ---
console.log("\n--- assertEqual ---");

const eq = assertEqual([1, 2], 3);
assert("assertEqual returns assertion object", eq !== null && typeof eq === "object");
assert("assertEqual type is 'equal'", eq.type === "equal");
assert("assertEqual stores args", Array.isArray(eq.args) && eq.args[0] === 1 && eq.args[1] === 2);
assert("assertEqual stores expected", eq.expected === 3);

// --- assertThrows ---
console.log("\n--- assertThrows ---");

const throws = assertThrows(Error, ["bad"]);
assert("assertThrows returns assertion object", throws !== null);
assert("assertThrows type is 'raises'", throws.type === "raises");
assert("assertThrows stores exception class", throws.exception === Error);
assert("assertThrows stores args", throws.args[0] === "bad");

// --- assertTrue ---
console.log("\n--- assertTrue ---");

const trueAssert = assertTrue([42]);
assert("assertTrue returns assertion object", trueAssert !== null);
assert("assertTrue type is 'true'", trueAssert.type === "true");
assert("assertTrue stores args", trueAssert.args[0] === 42);

// --- assertFalse ---
console.log("\n--- assertFalse ---");

const falseAssert = assertFalse([0]);
assert("assertFalse returns assertion object", falseAssert !== null);
assert("assertFalse type is 'false'", falseAssert.type === "false");
assert("assertFalse stores args", falseAssert.args[0] === 0);

// --- tests decorator ---
console.log("\n--- tests Decorator ---");

resetTests();

const add = tests(
  assertEqual([2, 3], 5),
  assertEqual([0, 0], 0),
  assertEqual([-1, 1], 0),
)(function add(a: number, b: number): number {
  return a + b;
});

assert("tests() returns the original function", typeof add === "function");
assert("Decorated function still works", add(10, 20) === 30);

// --- runAllTests with passing tests ---
console.log("\n--- runAllTests Passing ---");

const results = runAllTests({ quiet: true });
assert("runAllTests returns results object", results !== null);
assert("Results has passed count", typeof results.passed === "number");
assert("Results has failed count", typeof results.failed === "number");
assert("Results has errors count", typeof results.errors === "number");
assert("Results has details array", Array.isArray(results.details));
assert("All 3 add tests passed", results.passed === 3);
assert("No failures", results.failed === 0);
assert("No errors", results.errors === 0);
assert("Details has 3 entries", results.details.length === 3);
assert("First detail status is passed", results.details[0].status === "passed");

// --- runAllTests with failing test ---
console.log("\n--- runAllTests Failing ---");

resetTests();

tests(
  assertEqual([1, 1], 999),  // This will fail: 1+1=2, not 999
)(function badAdd(a: number, b: number): number {
  return a + b;
});

const failResults = runAllTests({ quiet: true });
assert("Failing test increments failed count", failResults.failed === 1);
assert("Failing test detail has status 'failed'", failResults.details[0].status === "failed");
assert("Failing test detail has message", typeof failResults.details[0].message === "string");

// --- runAllTests with error (throws) ---
console.log("\n--- runAllTests with assertThrows ---");

resetTests();

tests(
  assertThrows(Error, [null]),
  assertEqual([5, 3], 8),
)(function divide(a: number, b: number | null = null): number {
  if (b === null) throw new Error("b required");
  return a + b;
});

const throwResults = runAllTests({ quiet: true });
assert("assertThrows passes when error thrown", throwResults.passed === 2);
assert("No failures in throw test", throwResults.failed === 0);

// --- assertTrue / assertFalse in runAllTests ---
console.log("\n--- assertTrue/assertFalse in Runner ---");

resetTests();

tests(
  assertTrue([1]),
  assertTrue(["hello"]),
  assertFalse([0]),
  assertFalse([""]),
  assertFalse([null]),
)(function identity(x: unknown): unknown {
  return x;
});

const boolResults = runAllTests({ quiet: true });
assert("All truthy/falsy assertions pass", boolResults.passed === 5 && boolResults.failed === 0);

// --- resetTests ---
console.log("\n--- resetTests ---");

resetTests();
const emptyResults = runAllTests({ quiet: true });
assert("After reset, no tests run", emptyResults.passed === 0 && emptyResults.failed === 0 && emptyResults.errors === 0);
assert("After reset, details empty", emptyResults.details.length === 0);

// --- failfast option ---
console.log("\n--- failfast ---");

resetTests();

tests(
  assertEqual([1, 1], 999),  // fail
  assertEqual([1, 1], 2),    // would pass, but won't run with failfast
)(function mathy(a: number, b: number): number {
  return a + b;
});

const ffResults = runAllTests({ quiet: true, failfast: true });
assert("Failfast stops after first failure", ffResults.details.length === 1);
assert("Failfast reports the failure", ffResults.failed === 1);

// --- Named function preserved ---
console.log("\n--- Function Name ---");

resetTests();

const myFunc = tests()(function namedFunction(x: number): number { return x; });
assert("Named function name preserved", myFunc.name === "namedFunction");

// --- Anonymous function ---
resetTests();

const anonFunc = tests()((x: number) => x * 2);
assert("Anonymous function works", anonFunc(5) === 10);

// Cleanup
resetTests();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
