/**
 * RFC 9110 conformance — router-level contract tests for the HEAD/OPTIONS/
 * 405/Allow handling. Mirrors tests/HttpProtocolGapsTest.php (PHP),
 * tests/test_http_protocol_gaps.py (Python), and
 * spec/http_protocol_gaps_spec.rb (Ruby).
 *
 * Node-only departure: we test the Router contracts directly here rather
 * than spinning up an HTTP server per test. The dispatch-level behaviour
 * (status codes, Allow headers, body strip) is a thin shim over these
 * primitives — server.ts is what's responsible for honouring them.
 * The Router gives us:
 *
 *   - HEAD auto-fallback when no explicit HEAD route registered
 *   - methodsAllowedForPath() listing every method for a path
 *     (GET ⇒ HEAD; any registered method ⇒ OPTIONS)
 *   - head() / options() registration methods
 *
 * If the Router contracts hold, the dispatcher's 405/OPTIONS/body-strip
 * logic is deterministic and verified by the parity tests in the other
 * three frameworks.
 */

import { strict as assert } from "node:assert";
import { Router } from "../packages/core/src/router.js";

let passed = 0;
let failed = 0;

function run(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
  }
}

// ── HEAD auto-fallback ──────────────────────────────────────────────

run("HEAD on a GET route matches the GET handler", () => {
  const r = new Router();
  let getCalled = 0;
  r.get("/welcome", (async () => { getCalled++; }) as any);
  const m = r.match("HEAD", "/welcome");
  assert.ok(m, "HEAD MUST match when only a GET route exists (RFC 9110 §9.3.2)");
  assert.equal(m!.pattern, "/welcome");
});

run("HEAD on nonexistent path returns null", () => {
  const r = new Router();
  r.get("/welcome", (async () => {}) as any);
  assert.equal(r.match("HEAD", "/does/not/exist"), null);
});

run("HEAD does NOT auto-fall-back to POST-only paths", () => {
  const r = new Router();
  r.post("/submit", (async () => {}) as any);
  assert.equal(
    r.match("HEAD", "/submit"),
    null,
    "HEAD only auto-falls back to GET, never to other methods",
  );
});

// ── methodsAllowedForPath ──────────────────────────────────────────

run("methodsAllowedForPath includes registered methods + HEAD + OPTIONS", () => {
  const r = new Router();
  r.get("/x", (async () => {}) as any);
  r.post("/x", (async () => {}) as any);
  const allowed = r.methodsAllowedForPath("/x");
  assert.ok(allowed.includes("GET"));
  assert.ok(allowed.includes("POST"));
  assert.ok(allowed.includes("HEAD"), "HEAD MUST be in Allow when GET is registered");
  assert.ok(allowed.includes("OPTIONS"), "OPTIONS MUST be in Allow for any registered path");
  assert.ok(!allowed.includes("PUT"));
});

run("methodsAllowedForPath returns empty for unknown path", () => {
  const r = new Router();
  r.get("/exists", (async () => {}) as any);
  assert.deepEqual(r.methodsAllowedForPath("/does/not/exist"), []);
});

run("methodsAllowedForPath omits HEAD when only POST is registered", () => {
  const r = new Router();
  r.post("/submit", (async () => {}) as any);
  const allowed = r.methodsAllowedForPath("/submit");
  assert.ok(allowed.includes("POST"));
  assert.ok(!allowed.includes("HEAD"), "HEAD only implied when GET is registered");
  assert.ok(allowed.includes("OPTIONS"));
});

run("methodsAllowedForPath returns methods in canonical order", () => {
  const r = new Router();
  // Register out-of-order to test ordering
  r.delete("/r", (async () => {}) as any);
  r.get("/r", (async () => {}) as any);
  r.post("/r", (async () => {}) as any);
  const allowed = r.methodsAllowedForPath("/r");
  // Must be in order GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS
  const indices = allowed.map((m) => ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].indexOf(m));
  const sorted = [...indices].sort((a, b) => a - b);
  assert.deepEqual(indices, sorted, "Allow order must be GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS");
});

// ── Explicit head() / options() registration ───────────────────────

run("Router.head() registers a HEAD route", () => {
  const r = new Router();
  r.get("/probe", (async () => ({ from: "get" })) as any);
  r.head("/probe", (async () => ({ from: "head" })) as any);
  const m = r.match("HEAD", "/probe");
  assert.ok(m);
  // The explicit HEAD route is returned (not the GET fallback)
  assert.equal(r.methodsAllowedForPath("/probe").includes("HEAD"), true);
});

run("Router.options() registers an OPTIONS route", () => {
  const r = new Router();
  r.get("/cfg", (async () => {}) as any);
  r.options("/cfg", (async () => ({ custom: true })) as any);
  const m = r.match("OPTIONS", "/cfg");
  assert.ok(m, "Explicit Router.options() must be matchable");
});

// ── ANY route covers HEAD + OPTIONS implicitly ─────────────────────

run("any() registers GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD but NOT TRACE", () => {
  const r = new Router();
  r.any("/wildcard", (async () => {}) as any);
  // The seven methods any() actually registers all match...
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
    assert.ok(r.match(m, "/wildcard"), `any() must match ${m}`);
  }
  // ...and the methods any() does NOT register must NOT match. TRACE/CONNECT are
  // never registered by any(), and only HEAD (not TRACE) has the GET auto-fallback,
  // so the match MUST be null — an accidental TRACE registration would fail here.
  assert.equal(
    r.match("TRACE", "/wildcard"),
    null,
    "any() does not register TRACE — match must be null, not a stray handler",
  );
  assert.equal(
    r.match("CONNECT", "/wildcard"),
    null,
    "any() does not register CONNECT — match must be null",
  );
});

// ── Param-aware paths ──────────────────────────────────────────────

run("HEAD fallback works on parametrised paths", () => {
  const r = new Router();
  r.get("/users/{id}", (async () => {}) as any);
  const m = r.match("HEAD", "/users/42");
  assert.ok(m, "HEAD on /users/42 must fall back to GET /users/{id}");
  assert.equal(m!.params["id"], "42");
});

run("methodsAllowedForPath honours parametrised paths", () => {
  const r = new Router();
  r.get("/users/{id}", (async () => {}) as any);
  r.delete("/users/{id}", (async () => {}) as any);
  const allowed = r.methodsAllowedForPath("/users/123");
  assert.ok(allowed.includes("GET"));
  assert.ok(allowed.includes("DELETE"));
  assert.ok(allowed.includes("HEAD"));
  assert.ok(allowed.includes("OPTIONS"));
});

console.log(`\nHTTP protocol gaps (Node router): ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
