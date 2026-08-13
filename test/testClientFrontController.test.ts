/**
 * D6 / feature 131 (TC-DEC-01): TestClient dispatches through the REAL
 * front-controller behaviour — server.ts's runDispatch(), the exact function
 * every live socket connection runs (see testClientDispatchesThroughRealPipeline
 * .test.ts for the full oracle/session/gate-order/duplicate-header suite).
 *
 * Before the D6 fix, a route miss returned a hand-invented
 * {"error":"Not found"} body the live server never sends, and TestClient
 * skipped RFC 9110 conformance (OPTIONS/405) and global middleware — so a
 * green test proved nothing about production. Before the 131 fix, TestClient
 * still RE-IMPLEMENTED the dispatch order (its own route matching, its own
 * hand-built 404/405 JSON, middleware BEFORE the auth gate) instead of
 * calling the live pipeline — this file's own 404 assertions were pinned to
 * that hand-built shape, not to what a live request actually gets.
 *
 * TestClient now calls the real runDispatch(), so a miss falls all the way
 * through FALLBACK_STAGES exactly as a live request would: RFC 9110
 * conformance first (a path registered under another method answers OPTIONS
 * with 204 + Allow and any other method with 405 + Allow — serveMethodNotAllowed's
 * own JSON shape, unchanged), THEN content negotiation (ERR-DEC-02,
 * negotiatedErrorBody — `Accept: application/json` gets the real
 * {error:true,code,message,status,request_id} envelope; a browser-style or
 * absent Accept header gets the framework's HTML 404 page, not JSON — this
 * is genuinely new, since the old TestClient could not distinguish the two).
 *
 * The discriminator: the miss body is the real negotiated 404, NOT the
 * fabricated {"error":"Not found"}. If a future change reverts TestClient to
 * the invented body, the assertion below fails — that is the bite.
 *
 * NOT a mock: real Router registration, real router.match / methodsAllowedForPath,
 * real enforceRouteAuth, real dispatch.
 *
 * Mirrors: Python tests/test_test_client_front_controller.py,
 *          PHP tests/TestClientFrontControllerTest.php.
 */

process.env.TINA4_SECRET = "node-d6-front-controller-secret";

import { strict as assert } from "node:assert";
import { TestClient, Router } from "@tina4/core";
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
  // A dedicated Router (not the shared defaultRouter) so this suite never races
  // with the other concurrent TestClient suites.
  const router = new Router();
  router.get("/d6-open", async (_req: Tina4Request, res: Tina4Response) => res.json({ ok: true }));
  const client = new TestClient(router);

  // ── THE discriminator: a miss is the real negotiated 404, never a fabricated body ──
  it("returns the real negotiated 404 JSON for an Accept:application/json miss, not the fabricated {\"error\":\"Not found\"}", async () => {
    const r = await client.get("/d6-definitely-not-a-route", { headers: { Accept: "application/json" } });
    assert.equal(r.status, 404);
    assert.notEqual(r.text(), '{"error":"Not found"}', "TestClient still fabricates the pre-fix 404 body");
    // The REAL envelope (response.ts negotiatedErrorBody, ERR-DEC-02) — not
    // the old TestClient's hand-rolled {error,statusCode,message} shape.
    const body = r.json() as Record<string, unknown>;
    assert.equal(body.error, true);
    assert.equal(body.code, "NOT_FOUND");
    assert.equal(body.message, "Not Found");
    assert.equal(body.status, 404);
    assert.ok(typeof body.request_id === "string" && body.request_id.length > 0);
  });

  // ── A miss with no Accept header gets the real HTML 404 page, not JSON ──
  // (content negotiation, ERR-DEC-02) — the old TestClient always returned
  // JSON regardless of Accept, which is what the pre-131 version of this
  // very test asserted; that was the low-fidelity re-implementation, not the
  // live server's actual behaviour.
  it("returns the framework's real HTML 404 page for a miss with no Accept header", async () => {
    const r = await client.get("/d6-definitely-not-a-route");
    assert.equal(r.status, 404);
    assert.ok(r.contentType.includes("text/html"), `expected an HTML 404, got content-type ${r.contentType}`);
    assert.ok(r.text().includes("404"), "the framework's built-in 404 page must mention 404");
    assert.notEqual(r.text(), '{"error":"Not found"}', "TestClient still fabricates the pre-fix 404 body");
  });

  // ── A matched route runs the full pipeline ──────────────────────────────
  it("runs a matched route through the pipeline", async () => {
    const r = await client.get("/d6-open");
    assert.equal(r.status, 200);
    assert.equal((r.json() as Record<string, unknown>).ok, true);
  });

  // ── RFC 9110: wrong method on a known path is 405 + Allow (not 404) ──────
  it("returns 405 + Allow for a wrong method on a known path", async () => {
    const r = await client.delete("/d6-open");
    assert.equal(r.status, 405, "a known path under another method must 405, not 404");
    assert.ok((r.headers["allow"] ?? "").includes("GET"), "405 must carry an Allow header listing GET");
  });

  // ── The parity accessor is `status` (Ruby/PHP/Node), never `status_code` ─
  it("exposes .status (cross-framework parity accessor)", async () => {
    const r = await client.get("/d6-open");
    assert.ok("status" in r, ".status must exist");
    assert.equal((r as unknown as Record<string, unknown>).status_code, undefined, "status_code must not exist");
  });

  await new Promise((r) => setTimeout(r, 300));

  // eslint-disable-next-line no-console
  console.log(`\nTestClient front-controller tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
