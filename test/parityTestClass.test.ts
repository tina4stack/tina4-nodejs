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
import {
  Tina4Test,
  Tina4AssertionError,
  validToken,
  getToken,
  defaultRouter,
} from "@tina4/core";
import type { Tina4Request, Tina4Response } from "@tina4/core";

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
  it("Tina4Test base class drives a subclass test to completion", async () => {
    // Behavioural smoke: a minimal subclass with one passing test method,
    // run through the real built-in runner, must report exactly one pass.
    class Sub extends Tina4Test {
      async testNoop(): Promise<void> {
        this.assertTrue(true);
      }
    }
    const results = await Sub.run();
    assert.equal(results.passed, 1, "one test method should pass");
    assert.equal(results.failed, 0);
    assert.equal(results.errors, 0);
    // The per-test detail records the real outcome, not just a count.
    assert.deepEqual(results.details, [
      { suite: "Sub", test: "testNoop", status: "passed" },
    ]);
  });

  it("Subclass behaviour: assertions enforce + HTTP helpers dispatch a real request", async () => {
    // Register a real in-process route the suite's HTTP client will hit.
    // TestClient executes against defaultRouter using real node:http
    // IncomingMessage/ServerResponse objects — no mock collaborator.
    defaultRouter.clear();
    defaultRouter.get("/__parity/echo", async (req: Tina4Request, res: Tina4Response) => {
      return res.json({ ok: true, who: req.query["who"] ?? "anon" }, 201);
    });

    class MyTest extends Tina4Test {
      async testNoop(): Promise<void> { this.assertTrue(true); }
    }
    const suite = new MyTest();

    // 1. assertEqual is a real predicate: passes on a match, throws on a mismatch.
    suite.assertEqual(1, 1);
    assert.throws(() => suite.assertEqual(1, 2), Tina4AssertionError);

    // 2. The HTTP helper issues a real request and returns the route's
    //    actual status + parsed body — proving instantiation by behaviour.
    const resp = await suite.get("/__parity/echo?who=parity");
    assert.equal(resp.status, 201, "handler's explicit 201 status must round-trip");
    const body = resp.json() as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.who, "parity", "query param must reach the handler and come back in the body");

    // 3. POST helper carries a JSON body through to a second real route.
    //    .noAuth() because this asserts body PLUMBING, not auth — the TestClient
    //    now enforces the real secure-by-default gate (#PY2 parity), so a
    //    tokenless write to an auth-required route would 401 before the handler.
    defaultRouter.post("/__parity/sum", async (req: Tina4Request, res: Tina4Response) => {
      const b = (req.body ?? {}) as Record<string, number>;
      return res.json({ total: (b.a ?? 0) + (b.b ?? 0) });
    }).noAuth();
    const postResp = await suite.post("/__parity/sum", { json: { a: 2, b: 3 } });
    assert.equal(postResp.status, 200);
    assert.equal((postResp.json() as Record<string, unknown>).total, 5);

    defaultRouter.clear();
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
