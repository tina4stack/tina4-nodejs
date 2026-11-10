/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Tina4 Node.js — Inline testing framework.
 *
 * Attach test expectations to functions and run them all at once.
 *
 *     import { tests, expectEqual, expectRaises, runAll } from "./testing.js";
 *
 *     const add = tests(
 *       expectEqual([5, 3], 8),
 *       expectRaises(Error, [null]),
 *     )(function add(a: number, b: number | null = null): number {
 *       if (b === null) throw new Error("b required");
 *       return a + b;
 *     });
 *
 *     runAll();              // synchronous test functions
 *     await runAllAsync();   // async test functions (awaited, with a timeout)
 *
 * The builders are named expect* — DESCRIPTORS that record an expectation for the
 * runner — deliberately distinct from the xUnit assert* on Tina4Test (test.ts),
 * so importing the wrong surface can never silently change call semantics.
 */

// ── Types ──────────────────────────────────────────────────────────

interface Assertion {
  type: "equal" | "raises" | "true" | "false";
  args: unknown[];
  expected?: unknown;
  exception?: new (...a: unknown[]) => Error;
}

interface RegistryEntry {
  name: string;
  fn: (...args: unknown[]) => unknown;
  assertions: Assertion[];
}

interface TestResults {
  passed: number;
  failed: number;
  errors: number;
  details: Array<{ name: string; status: string; message?: string }>;
}

// ── Registry ───────────────────────────────────────────────────────

const registry: RegistryEntry[] = [];

// ── Assertion builders ─────────────────────────────────────────────

/** Expect that calling the function with `args` returns `expected`. */
export function expectEqual(args: unknown[], expected: unknown): Assertion {
  return { type: "equal", args, expected };
}

/** Expect that calling the function with `args` throws an instance of `errorClass`. */
export function expectRaises(
  errorClass: new (...a: unknown[]) => Error,
  args: unknown[],
): Assertion {
  return { type: "raises", args, exception: errorClass };
}

/** Expect that calling the function with `args` returns a truthy value. */
export function expectTrue(args: unknown[]): Assertion {
  return { type: "true", args };
}

/** Expect that calling the function with `args` returns a falsy value. */
export function expectFalse(args: unknown[]): Assertion {
  return { type: "false", args };
}

// ── Decorator ──────────────────────────────────────────────────────

/**
 * Attach inline test assertions to a function.
 *
 * Returns a wrapper that accepts the function and registers it,
 * then returns the original function unchanged.
 *
 *     const myFn = tests(assertEqual([1,2], 3))(function myFn(a,b) { return a+b; });
 */
export function tests(
  ...assertions: Assertion[]
): <T extends (...args: unknown[]) => unknown>(fn: T) => T {
  return <T extends (...args: unknown[]) => unknown>(fn: T): T => {
    registry.push({
      name: fn.name || "anonymous",
      fn: fn as (...args: unknown[]) => unknown,
      assertions,
    });
    return fn;
  };
}

// ── Runner ─────────────────────────────────────────────────────────

interface RunOptions {
  quiet?: boolean;
  failfast?: boolean;
}

interface AsyncRunOptions extends RunOptions {
  /** Per-call limit in milliseconds for an async test function (default 30000). */
  timeoutMs?: number;
}

/**
 * Run all registered tests synchronously. Returns the results summary.
 *
 * A test function that returns a Promise (an async function) cannot be judged
 * here: its result is not known yet. It is reported as an ERROR naming
 * `runAllAsync()`, never as a pass. Use `await runAllAsync()` for async tests.
 */
export function runAll(options: RunOptions = {}): TestResults {
  const { quiet = false, failfast = false } = options;
  const results: TestResults = { passed: 0, failed: 0, errors: 0, details: [] };

  for (const entry of registry) {
    if (!quiet) console.log(`\n  ${entry.name}`);
    for (const assertion of entry.assertions) {
      const label = assertionLabel(assertion, entry.name);
      const ok = record(results, label, quiet, () => judge(assertion, callSync(entry.fn, assertion.args)));
      if (!ok && failfast) {
        printSummary(results, quiet);
        return results;
      }
    }
  }

  printSummary(results, quiet);
  return results;
}

/**
 * Run all registered tests, awaiting each test function. Resolves to the
 * results summary.
 *
 * An async function is judged on what it resolves to or rejects with. A call
 * that has not settled after `timeoutMs` (default 30000) is reported as an
 * error, so one stuck test cannot hang the run.
 */
export async function runAllAsync(options: AsyncRunOptions = {}): Promise<TestResults> {
  const { quiet = false, failfast = false, timeoutMs = 30_000 } = options;
  const results: TestResults = { passed: 0, failed: 0, errors: 0, details: [] };

  for (const entry of registry) {
    if (!quiet) console.log(`\n  ${entry.name}`);
    for (const assertion of entry.assertions) {
      const label = assertionLabel(assertion, entry.name);
      const outcome = await callAsync(entry.fn, assertion.args, timeoutMs);
      const ok = record(results, label, quiet, () => {
        if (outcome instanceof TestRunError) throw outcome;
        judge(assertion, outcome);
      });
      if (!ok && failfast) {
        printSummary(results, quiet);
        return results;
      }
    }
  }

  printSummary(results, quiet);
  return results;
}

/** Reset the test registry (useful between test runs). */
export function reset(): void {
  registry.length = 0;
}

// ── Internals ──────────────────────────────────────────────────────

class TestAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestAssertionError";
  }
}

/** What calling a test function produced: a value, or a thrown error. */
type Outcome = { threw: false; value: unknown } | { threw: true; error: unknown };

/** Raised when a test cannot be judged at all (not a failed assertion). */
class TestRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestRunError";
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function callSync(fn: (...args: unknown[]) => unknown, args: unknown[]): Outcome {
  let value: unknown;
  try {
    value = fn(...args);
  } catch (error) {
    return { threw: true, error };
  }
  if (isThenable(value)) {
    // Settle it quietly: its rejection must not surface as an unhandled one.
    Promise.resolve(value).then(undefined, () => undefined);
    throw new TestRunError(
      "returned a Promise (async test function): runAll() cannot judge it, use await runAllAsync()",
    );
  }
  return { threw: false, value };
}

async function callAsync(
  fn: (...args: unknown[]) => unknown,
  args: unknown[],
  timeoutMs: number,
): Promise<Outcome | TestRunError> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = fn(...args);
    if (!isThenable(value)) return { threw: false, value };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new TestRunError(`did not settle within ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    return { threw: false, value: await Promise.race([Promise.resolve(value), timeout]) };
  } catch (error) {
    if (error instanceof TestRunError) return error;
    return { threw: true, error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Record one assertion's result; returns true when it passed. */
function record(results: TestResults, label: string, quiet: boolean, check: () => void): boolean {
  try {
    check();
    results.passed++;
    results.details.push({ name: label, status: "passed" });
    if (!quiet) console.log(`    \x1b[32m+\x1b[0m ${label}`);
    return true;
  } catch (err) {
    if (err instanceof TestAssertionError) {
      results.failed++;
      results.details.push({ name: label, status: "failed", message: err.message });
      if (!quiet) console.log(`    \x1b[31mx\x1b[0m ${label}: ${err.message}`);
    } else {
      results.errors++;
      const msg = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
      results.details.push({ name: label, status: "error", message: msg });
      if (!quiet) console.log(`    \x1b[33m!\x1b[0m ${label}: ${msg}`);
    }
    return false;
  }
}

/** Judge an expectRaises assertion: the call must have thrown that class. */
function judgeRaises(assertion: Assertion, outcome: Outcome): void {
  const ExcClass = assertion.exception!;
  if (!outcome.threw) throw new TestAssertionError(`expected ${ExcClass.name} to be raised`);
  const err = outcome.error;
  if (err instanceof ExcClass) return;
  throw new TestAssertionError(
    `expected ${ExcClass.name}, got ${err instanceof Error ? err.constructor.name : typeof err}: ${err}`,
  );
}

/** Judge one assertion against what the call produced. */
function judge(assertion: Assertion, outcome: Outcome): void {
  const { type } = assertion;

  if (type === "raises") return judgeRaises(assertion, outcome);

  // Any other assertion: an exception from the function is an error, not a failure.
  if (outcome.threw) throw outcome.error;
  const result = outcome.value;

  switch (type) {
    case "equal": {
      const expected = assertion.expected;
      if (result !== expected) {
        throw new TestAssertionError(
          `expected ${JSON.stringify(expected)}, got ${JSON.stringify(result)}`,
        );
      }
      return;
    }
    case "true":
      if (!result) throw new TestAssertionError(`expected truthy, got ${JSON.stringify(result)}`);
      return;
    case "false":
      if (result) throw new TestAssertionError(`expected falsy, got ${JSON.stringify(result)}`);
      return;
    default:
      throw new Error(`unknown assertion type: ${type}`);
  }
}

function assertionLabel(assertion: Assertion, fnName: string): string {
  const args = JSON.stringify(assertion.args);
  switch (assertion.type) {
    case "equal":
      return `${fnName}(${args}) == ${JSON.stringify(assertion.expected)}`;
    case "raises":
      return `${fnName}(${args}) raises ${assertion.exception!.name}`;
    case "true":
      return `${fnName}(${args}) is truthy`;
    case "false":
      return `${fnName}(${args}) is falsy`;
    default:
      return `${fnName} [${assertion.type}]`;
  }
}

function printSummary(results: TestResults, quiet: boolean): void {
  if (quiet) return;
  const total = results.passed + results.failed + results.errors;
  console.log(
    `\n  ${total} tests: ` +
    `\x1b[32m${results.passed} passed\x1b[0m, ` +
    `\x1b[31m${results.failed} failed\x1b[0m, ` +
    `\x1b[33m${results.errors} errors\x1b[0m\n`,
  );
}
