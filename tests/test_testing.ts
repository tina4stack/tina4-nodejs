/**
 * Tests for the inline testing framework itself.
 */

import {
  tests, assertEqual, assertThrows, assertTrue, assertFalse,
  runAllTests, resetTests,
} from "../packages/core/src/testing.js";

// ── Functions under test ───────────────────────────────────────────

const add = tests(
  assertEqual([5, 3], 8),
  assertEqual([0, 0], 0),
  assertEqual([-1, 1], 0),
)(function add(a: unknown, b: unknown): number {
  return (a as number) + (b as number);
});

const upper = tests(
  assertEqual(["hello"], "HELLO"),
  assertEqual(["World"], "WORLD"),
)(function upper(s: unknown): string {
  return (s as string).toUpperCase();
});

const addSafe = tests(
  assertThrows(Error, [null]),
  assertEqual([5, 3], 8),
)(function addSafe(a: unknown, b: unknown = null): number {
  if (b === null) throw new Error("b required");
  return (a as number) + (b as number);
});

const isTruthy = tests(
  assertTrue([10]),
  assertTrue([1]),
  assertFalse([0]),
  assertFalse([""]),
)(function isTruthy(value: unknown): boolean {
  return Boolean(value);
});

// ── Run and verify ─────────────────────────────────────────────────

const results = runAllTests({ quiet: true });

const errors: string[] = [];

if (results.passed !== 11) errors.push(`expected 11 passed, got ${results.passed}`);
if (results.failed !== 0) errors.push(`expected 0 failed, got ${results.failed}`);
if (results.errors !== 0) errors.push(`expected 0 errors, got ${results.errors}`);
if (results.details.length !== 11) errors.push(`expected 11 details, got ${results.details.length}`);

for (const d of results.details) {
  if (d.status !== "passed") {
    errors.push(`expected passed, got ${d.status} for ${d.name}`);
  }
}

// ── Test deliberate failure ────────────────────────────────────────

resetTests();

tests(
  assertEqual([1, 1], 999),
)(function badAdd(a: unknown, b: unknown): number {
  return (a as number) + (b as number);
});

const failResults = runAllTests({ quiet: true });

if (failResults.failed !== 1) errors.push(`expected 1 failed for badAdd, got ${failResults.failed}`);
if (failResults.passed !== 0) errors.push(`expected 0 passed for badAdd, got ${failResults.passed}`);

// ── Test error reporting ───────────────────────────────────────────

resetTests();

tests(
  assertEqual([1], 1),
)(function willCrash(_a: unknown): number {
  throw new Error("boom");
});

const errorResults = runAllTests({ quiet: true });

if (errorResults.errors !== 1) errors.push(`expected 1 error for willCrash, got ${errorResults.errors}`);

// ── Report ─────────────────────────────────────────────────────────

if (errors.length === 0) {
  console.log("\nAll meta-tests passed.");
  process.exit(0);
} else {
  console.log("\nFAILED:");
  for (const e of errors) {
    console.log(`  - ${e}`);
  }
  process.exit(1);
}
