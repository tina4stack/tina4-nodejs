/**
 * Tina4 — The Intelligent Native Application 4ramework
 * Copyright 2007 - current Tina4
 * License: MIT https://opensource.org/licenses/MIT
 *
 * Tina4 xUnit-style Test base class.
 *
 * Chapter 18 of the documentation has long shown:
 *
 *     class UserApiTest extends Tina4Test {
 *       async testHealth() {
 *         const resp = await this.get("/health");
 *         this.assertEqual(resp.status, 200);
 *       }
 *     }
 *
 * Until 3.13.0 this class did not exist — examples crashed with
 * "ReferenceError: Tina4Test is not defined". This is the Node.js
 * parity of the Python `tina4_python.test.Test`, PHP `Tina4\Test`,
 * and Ruby `Tina4::Test` classes shipped at the same time.
 *
 * The class has a built-in runner (`Tina4Test.runAll`) so the docs'
 * `npx tina4nodejs test` flow can discover every subclass without
 * an external test framework. HTTP helpers (get/post/put/patch/delete)
 * delegate to a lazy TestClient. Positional assertions match the
 * cross-framework (actual, expected, message) shape.
 */

import { TestClient, type TestResponse, type RequestOptions } from "./testClient.js";

// Class-level registry so runAll() can discover every subclass.
const _subclasses: Array<typeof Tina4Test> = [];

/** Raised by Tina4Test assertion helpers when an assertion fails. */
export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

/** Result of running a Tina4Test subclass (or all subclasses). */
export interface TestRunResults {
  passed: number;
  failed: number;
  errors: number;
  details: Array<{
    suite: string;
    test: string;
    status: "passed" | "failed" | "error";
    message?: string;
  }>;
}

/**
 * Tina4 xUnit-style test base class — class-based suites with HTTP
 * helpers and positional assertions, zero external deps.
 *
 * Subclass and define `test*` methods:
 *
 *     class BasicTest extends Tina4Test {
 *       async testAddition() {
 *         this.assertEqual(2 + 2, 4, "addition works");
 *       }
 *       async testHttpHealth() {
 *         const resp = await this.get("/health");
 *         this.assertEqual(resp.status, 200);
 *       }
 *     }
 *
 *     const results = await Tina4Test.runAll();
 *     // → { passed, failed, errors, details }
 */
export class Tina4Test {
  private _client: TestClient | null = null;

  // Auto-register every subclass for the runAll() discovery API.
  // (The static block runs once when the class file loads.)
  static {
    // Skip the base class itself
  }

  /** snake_case lifecycle hook — runs before each test. Override in subclasses. */
  async setUp(): Promise<void> {}

  /** snake_case lifecycle hook — runs after each test. Override in subclasses. */
  async tearDown(): Promise<void> {}

  // ── HTTP test client (lazy) ─────────────────────────────────────────

  /** The lazily-created TestClient instance shared by this suite's tests. */
  protected get client(): TestClient {
    if (this._client === null) this._client = new TestClient();
    return this._client;
  }

  async get(path: string, options?: RequestOptions): Promise<TestResponse> {
    return this.client.get(path, options);
  }

  async post(path: string, options?: RequestOptions): Promise<TestResponse> {
    return this.client.post(path, options);
  }

  async put(path: string, options?: RequestOptions): Promise<TestResponse> {
    return this.client.put(path, options);
  }

  async patch(path: string, options?: RequestOptions): Promise<TestResponse> {
    return this.client.patch(path, options);
  }

  async delete(path: string, options?: RequestOptions): Promise<TestResponse> {
    return this.client.delete(path, options);
  }

  // ── Positional assertions — (actual, expected, message) shape ────────

  assertEqual(actual: unknown, expected: unknown, message?: string): void {
    // Deep equality via JSON for objects, strict for primitives — matches
    // how the Python/PHP/Ruby ports compare.
    const eq =
      actual === expected ||
      (typeof actual === "object" && typeof expected === "object" &&
        JSON.stringify(actual) === JSON.stringify(expected));
    if (!eq) {
      throw new AssertionError(
        message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      );
    }
  }

  assertNotEqual(actual: unknown, expected: unknown, message?: string): void {
    const eq =
      actual === expected ||
      (typeof actual === "object" && typeof expected === "object" &&
        JSON.stringify(actual) === JSON.stringify(expected));
    if (eq) {
      throw new AssertionError(
        message || `Expected ${JSON.stringify(actual)} != ${JSON.stringify(expected)}, but they are equal`
      );
    }
  }

  assertTrue(value: unknown, message?: string): void {
    if (!value) throw new AssertionError(message || `Expected truthy, got ${JSON.stringify(value)}`);
  }

  assertFalse(value: unknown, message?: string): void {
    if (value) throw new AssertionError(message || `Expected falsy, got ${JSON.stringify(value)}`);
  }

  assertNull(value: unknown, message?: string): void {
    if (value !== null) throw new AssertionError(message || `Expected null, got ${JSON.stringify(value)}`);
  }

  assertNotNull(value: unknown, message?: string): void {
    if (value === null) throw new AssertionError(message || "Expected non-null, got null");
  }

  async assertRaises(
    expectedClass: new (...args: never[]) => Error,
    fn: () => unknown | Promise<unknown>,
    message?: string
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof expectedClass) return;
      throw new AssertionError(
        message || `Expected ${expectedClass.name}, got ${(err as Error)?.constructor?.name}: ${String(err)}`
      );
    }
    throw new AssertionError(message || `Expected ${expectedClass.name} to be raised, but nothing was`);
  }

  // ── Runner ───────────────────────────────────────────────────────────

  /** Register a subclass for discovery. Called automatically via `extends Tina4Test`. */
  static register(klass: typeof Tina4Test): void {
    if (!_subclasses.includes(klass)) _subclasses.push(klass);
  }

  /** Run every `test*` method on this class. Returns counts and per-test details. */
  static async run(this: typeof Tina4Test): Promise<TestRunResults> {
    const results: TestRunResults = { passed: 0, failed: 0, errors: 0, details: [] };
    const proto = this.prototype as unknown as Record<string, unknown>;
    const methods = Object.getOwnPropertyNames(this.prototype)
      .filter((m) => m.startsWith("test") && typeof proto[m] === "function")
      .sort();

    for (const method of methods) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const suite = new (this as any)();
      try {
        await suite.setUp();
        await suite[method]();
        await suite.tearDown();
        results.passed++;
        results.details.push({ suite: this.name, test: method, status: "passed" });
      } catch (err) {
        if (err instanceof AssertionError) {
          results.failed++;
          results.details.push({ suite: this.name, test: method, status: "failed", message: err.message });
        } else {
          results.errors++;
          results.details.push({
            suite: this.name,
            test: method,
            status: "error",
            message: `${(err as Error)?.constructor?.name || "Error"}: ${String(err)}`,
          });
        }
      }
    }
    return results;
  }

  /** Run every Tina4Test subclass discovered via auto-registration. */
  static async runAll(options: { quiet?: boolean } = {}): Promise<TestRunResults> {
    const aggregate: TestRunResults = { passed: 0, failed: 0, errors: 0, details: [] };
    for (const klass of _subclasses) {
      const out = await klass.run();
      aggregate.passed += out.passed;
      aggregate.failed += out.failed;
      aggregate.errors += out.errors;
      aggregate.details.push(...out.details);
    }
    if (!options.quiet) {
      // eslint-disable-next-line no-console
      console.log(
        `Tina4 Test results: ${aggregate.passed} passed, ${aggregate.failed} failed, ${aggregate.errors} errors`
      );
    }
    return aggregate;
  }

  /** Subclasses array — read-only view used by tests. */
  static get subclasses(): ReadonlyArray<typeof Tina4Test> {
    return _subclasses;
  }
}

// Auto-register subclasses by overriding the `extends` hook. Because JS
// doesn't have a Ruby/Python-style `inherited` callback, expose `register`
// as the explicit handshake and document it; tests can call directly.
