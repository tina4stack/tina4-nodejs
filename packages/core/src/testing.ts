/**
 * Tina4 Node.js — Inline testing framework.
 *
 * Attach test assertions to functions and run them all at once.
 *
 *     import { tests, assertEqual, assertThrows, runAllTests } from "./testing.js";
 *
 *     const add = tests(
 *       assertEqual([5, 3], 8),
 *       assertThrows(Error, [null]),
 *     )(function add(a: number, b: number | null = null): number {
 *       if (b === null) throw new Error("b required");
 *       return a + b;
 *     });
 *
 *     runAllTests();
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

/** Assert that calling the function with `args` returns `expected`. */
export function assertEqual(args: unknown[], expected: unknown): Assertion {
  return { type: "equal", args, expected };
}

/** Assert that calling the function with `args` throws an instance of `errorClass`. */
export function assertThrows(
  errorClass: new (...a: unknown[]) => Error,
  args: unknown[],
): Assertion {
  return { type: "raises", args, exception: errorClass };
}

/** Assert that calling the function with `args` returns a truthy value. */
export function assertTrue(args: unknown[]): Assertion {
  return { type: "true", args };
}

/** Assert that calling the function with `args` returns a falsy value. */
export function assertFalse(args: unknown[]): Assertion {
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

/** Run all registered tests. Returns results summary. */
export function runAllTests(
  options: { quiet?: boolean; failfast?: boolean } = {},
): TestResults {
  const { quiet = false, failfast = false } = options;
  const results: TestResults = { passed: 0, failed: 0, errors: 0, details: [] };

  for (const entry of registry) {
    if (!quiet) {
      console.log(`\n  ${entry.name}`);
    }

    for (const assertion of entry.assertions) {
      const label = assertionLabel(assertion, entry.name);
      try {
        runAssertion(entry.fn, assertion);
        results.passed++;
        results.details.push({ name: label, status: "passed" });
        if (!quiet) {
          console.log(`    \x1b[32m+\x1b[0m ${label}`);
        }
      } catch (err) {
        if (err instanceof TestAssertionError) {
          results.failed++;
          results.details.push({ name: label, status: "failed", message: err.message });
          if (!quiet) {
            console.log(`    \x1b[31mx\x1b[0m ${label}: ${err.message}`);
          }
        } else {
          results.errors++;
          const msg = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
          results.details.push({ name: label, status: "error", message: msg });
          if (!quiet) {
            console.log(`    \x1b[33m!\x1b[0m ${label}: ${msg}`);
          }
        }
        if (failfast) {
          printSummary(results, quiet);
          return results;
        }
      }
    }
  }

  printSummary(results, quiet);
  return results;
}

/** Reset the test registry (useful between test runs). */
export function resetTests(): void {
  registry.length = 0;
}

// ── Internals ──────────────────────────────────────────────────────

class TestAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestAssertionError";
  }
}

function runAssertion(fn: (...args: unknown[]) => unknown, assertion: Assertion): void {
  const { type, args } = assertion;

  switch (type) {
    case "equal": {
      const result = fn(...args);
      const expected = assertion.expected;
      if (result !== expected) {
        throw new TestAssertionError(
          `expected ${JSON.stringify(expected)}, got ${JSON.stringify(result)}`,
        );
      }
      break;
    }

    case "raises": {
      const ExcClass = assertion.exception!;
      try {
        fn(...args);
      } catch (err) {
        if (err instanceof ExcClass) {
          return; // success
        }
        throw new TestAssertionError(
          `expected ${ExcClass.name}, got ${err instanceof Error ? err.constructor.name : typeof err}: ${err}`,
        );
      }
      throw new TestAssertionError(`expected ${ExcClass.name} to be raised`);
    }

    case "true": {
      const result = fn(...args);
      if (!result) {
        throw new TestAssertionError(`expected truthy, got ${JSON.stringify(result)}`);
      }
      break;
    }

    case "false": {
      const result = fn(...args);
      if (result) {
        throw new TestAssertionError(`expected falsy, got ${JSON.stringify(result)}`);
      }
      break;
    }

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
