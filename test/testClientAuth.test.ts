/**
 * TestClient routes through the REAL auth gate (parity with Python #PY2).
 *
 * The in-process TestClient is the surface developers test routes on. Before
 * this fix it matched a route and ran its handler DIRECTLY, skipping the
 * secure-by-default auth gate the live server applies — so a tokenless write
 * returned the handler's 201 in a test while the live server returned 401. A
 * green test hid a live failure: the verification layer lied.
 *
 * TestClient now calls the same enforceRouteAuth (authGate.ts) the live server
 * dispatch uses, so an auth-required write (secure-by-default POST/PUT/PATCH/
 * DELETE, or any .secure() route) with no valid token returns 401 exactly as in
 * production; a valid Bearer token (or a formToken in the body) passes; a public
 * route (GET, or a write marked .noAuth()) is unaffected.
 *
 * NOT a mock: real Router registration, real JWTs via getToken / validToken
 * signed with a real TINA4_SECRET, real enforceRouteAuth.
 *
 * Mirrors: Python tests/test_test_client_auth.py, Ruby spec/test_client_auth_spec.rb,
 *          PHP tests/TestClientAuthTest.php.
 */

// A real signing secret so getToken() and validToken() agree — set before any
// token is minted. Clear a stray API key so the JWT path is what's under test.
process.env.TINA4_SECRET = "node-py2-testclient-auth-secret";
delete process.env.TINA4_API_KEY;

import { strict as assert } from "node:assert";
import { TestClient, defaultRouter, getToken } from "@tina4/core";
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
  // Register routes ONCE (the deferred its run concurrently on the shared
  // defaultRouter, so registering per-test would race). Distinct paths, reads only.
  defaultRouter.post("/tc-secure-write", async (_req: Tina4Request, res: Tina4Response) => {
    return res.json({ created: true }, 201);
  });
  defaultRouter
    .post("/tc-public-write", async (_req: Tina4Request, res: Tina4Response) => {
      return res.json({ created: true }, 201);
    })
    .noAuth();
  defaultRouter.get("/tc-public-read", async (_req: Tina4Request, res: Tina4Response) => {
    return res.json({ ok: true });
  });
  defaultRouter
    .get("/tc-secured-read", async (_req: Tina4Request, res: Tina4Response) => {
      return res.json({ secret: true });
    })
    .secure();

  const client = new TestClient();

  // ── The core contract: a tokenless write is rejected ─────────────
  it("rejects a tokenless write with 401", async () => {
    const r = await client.post("/tc-secure-write", { json: { name: "Alice" } });
    assert.equal(r.status, 401, "tokenless write must 401, not silently succeed");
    assert.equal((r.json() as Record<string, unknown>).error, "Unauthorized");
  });

  // ── A valid Bearer token passes ──────────────────────────────────
  it("passes a write with a valid Bearer token", async () => {
    const token = getToken({ sub: "user-1" });
    const r = await client.post("/tc-secure-write", {
      json: { name: "Alice" },
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 201);
    assert.equal((r.json() as Record<string, unknown>).created, true);
  });

  // ── A formToken in the body passes (frond.js posts the token there) ─
  it("passes a write with a formToken in the body", async () => {
    const token = getToken({ sub: "user-1" });
    const r = await client.post("/tc-secure-write", { json: { name: "Bob", formToken: token } });
    assert.equal(r.status, 201);
  });

  // ── An invalid token is rejected ─────────────────────────────────
  it("rejects a write with an invalid token", async () => {
    const r = await client.post("/tc-secure-write", {
      json: { name: "Mallory" },
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    assert.equal(r.status, 401);
  });

  // ── A write opened with .noAuth() needs no token ─────────────────
  it("allows a .noAuth() write with no token", async () => {
    const r = await client.post("/tc-public-write", { json: { name: "Anon" } });
    assert.equal(r.status, 201);
  });

  // ── A plain GET needs no token ───────────────────────────────────
  it("allows a public GET with no token", async () => {
    const r = await client.get("/tc-public-read");
    assert.equal(r.status, 200);
    assert.equal((r.json() as Record<string, unknown>).ok, true);
  });

  // ── A .secure() GET without a token is rejected ──────────────────
  it("rejects a .secure() GET with no token", async () => {
    const r = await client.get("/tc-secured-read");
    assert.equal(r.status, 401);
  });

  // ── A .secure() GET with a valid token passes ────────────────────
  it("passes a .secure() GET with a valid token", async () => {
    const token = getToken({ sub: "user-1" });
    const r = await client.get("/tc-secured-read", { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
    assert.equal((r.json() as Record<string, unknown>).secret, true);
  });

  // Wait for the deferred its to settle
  await new Promise((r) => setTimeout(r, 300));

  defaultRouter.clear();

  // eslint-disable-next-line no-console
  console.log(`\nTestClient auth tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
