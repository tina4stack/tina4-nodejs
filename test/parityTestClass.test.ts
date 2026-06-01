/**
 * Parity tests for the new Tina4Test base class (3.13.0) and the
 * Auth.validToken return-type change. Mirrors:
 *
 *   Python:  tests/test_parity_group_c.py / group_d.py
 *   PHP:     tests/ParityTestClassTest.php
 *   Ruby:    spec/parity_test_class_spec.rb
 *
 * Until 3.13.0 `class FooTest extends Tina4Test {}` crashed with
 * "ReferenceError: Tina4Test is not defined". This pins the contract.
 */

import { strict as assert } from "node:assert";
import { Tina4Test, Tina4AssertionError, validToken, getToken } from "@tina4/core";

let passed = 0;
let failed = 0;

function it(name: string, fn: () => Promise<void> | void): void {
  Promise.resolve()
    .then(fn)
    .then(() => {
      // eslint-disable-next-line no-console
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`  ✗ ${name}: ${(err as Error).message}`);
      failed++;
    });
}

async function run(): Promise<void> {
  // ── Tina4Test class shape ────────────────────────────────────────────
  it("Tina4Test class is defined", () => {
    assert.equal(typeof Tina4Test, "function");
  });

  it("Subclasses can be instantiated", () => {
    class MyTest extends Tina4Test {
      async testNoop(): Promise<void> { this.assertTrue(true); }
    }
    const suite = new MyTest();
    assert.equal(typeof suite.assertEqual, "function");
    assert.equal(typeof suite.get, "function");
    assert.equal(typeof suite.post, "function");
    assert.equal(typeof suite.put, "function");
    assert.equal(typeof suite.patch, "function");
    assert.equal(typeof suite.delete, "function");
  });

  // ── Positional assertions ────────────────────────────────────────────
  it("assertEqual passes on match", () => {
    class T extends Tina4Test { test() { this.assertEqual(2 + 2, 4); } }
    new T().test();
  });

  it("assertEqual throws AssertionError on mismatch", () => {
    class T extends Tina4Test { test() { this.assertEqual(2 + 2, 5); } }
    assert.throws(() => new T().test(), Tina4AssertionError);
  });

  it("assertNotEqual works", () => {
    class T extends Tina4Test { test() { this.assertNotEqual("hi", "bye"); } }
    new T().test();
  });

  it("assertTrue / assertFalse work", () => {
    class T extends Tina4Test {
      test() {
        this.assertTrue(1);
        this.assertFalse(0);
      }
    }
    new T().test();
  });

  it("assertTrue throws on falsy", () => {
    class T extends Tina4Test { test() { this.assertTrue(null); } }
    assert.throws(() => new T().test(), Tina4AssertionError);
  });

  it("assertNull / assertNotNull work", () => {
    class T extends Tina4Test {
      test() {
        this.assertNull(null);
        this.assertNotNull(0);
        this.assertNotNull("");
      }
    }
    new T().test();
  });

  it("assertRaises catches the documented exception", async () => {
    class T extends Tina4Test {
      async test() {
        await this.assertRaises(TypeError, () => {
          throw new TypeError("boom");
        });
      }
    }
    await new T().test();
  });

  it("assertRaises fails when wrong exception thrown", async () => {
    class T extends Tina4Test {
      async test() {
        await this.assertRaises(TypeError, () => {
          throw new RangeError("wrong");
        });
      }
    }
    await assert.rejects(new T().test(), Tina4AssertionError);
  });

  it("assertRaises fails when no exception thrown", async () => {
    class T extends Tina4Test {
      async test() {
        await this.assertRaises(TypeError, () => 42);
      }
    }
    await assert.rejects(new T().test(), Tina4AssertionError);
  });

  // ── Built-in runner ──────────────────────────────────────────────────
  it("static run() reports passed/failed/errors counts", async () => {
    class CountTest extends Tina4Test {
      async testPass() { this.assertTrue(true); }
      async testFail() { this.assertTrue(false); }
      async testError() { throw new Error("boom"); }
    }
    const results = await CountTest.run();
    assert.equal(results.passed, 1);
    assert.equal(results.failed, 1);
    assert.equal(results.errors, 1);
  });

  it("lifecycle setUp/tearDown fire around each test", async () => {
    const log: string[] = [];
    class HookTest extends Tina4Test {
      async setUp() { log.push("setUp"); }
      async tearDown() { log.push("tearDown"); }
      async testFirst() { log.push("testFirst"); this.assertTrue(true); }
    }
    await HookTest.run();
    assert.deepEqual(log, ["setUp", "testFirst", "tearDown"]);
  });

  // ── Auth.validToken return type 3.13.0 ──────────────────────────────
  it("validToken returns payload object on success", () => {
    process.env.TINA4_SECRET = "parity-d-secret";
    const token = getToken({ user_id: 42, role: "admin" });
    const result = validToken(token);
    assert.ok(result !== null && typeof result === "object", "expected object payload");
    assert.equal((result as Record<string, unknown>).user_id, 42);
    assert.equal((result as Record<string, unknown>).role, "admin");
  });

  it("validToken returns null on invalid token", () => {
    assert.equal(validToken("not.a.jwt"), null);
    assert.equal(validToken(""), null);
    assert.equal(validToken("a.b.c"), null);
  });

  it("validToken truthy/falsy contract preserved", () => {
    process.env.TINA4_SECRET = "parity-d-secret";
    const token = getToken({ x: 1 });
    assert.ok(!!validToken(token), "valid token should be truthy");
    assert.ok(!validToken("bogus"), "invalid token should be falsy");
  });

  // Wait for the deferred its
  await new Promise((r) => setTimeout(r, 100));

  // eslint-disable-next-line no-console
  console.log(`\nParity tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
