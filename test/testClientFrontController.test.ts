/**
 * D6: TestClient dispatches through the REAL front-controller behaviour.
 *
 * The in-process TestClient is the surface developers test routes on. Before
 * this fix, on a route miss it returned a hand-invented {"error":"Not found"}
 * body that the live server never sends, and it skipped RFC 9110 conformance
 * (OPTIONS/405) and global middleware — so a green test proved nothing about
 * production. This is the same silent-success class as Python's pre-fix client
 * (fixed in the Python master).
 *
 * TestClient now mirrors the live dispatch tail (server.ts): on a miss it does
 * RFC 9110 conformance first (a path registered under another method answers
 * OPTIONS with 204 + Allow and any other method with 405 + Allow), then the
 * framework's REAL 404 — the exact {"error":"Not Found",statusCode,message}
 * body the live front controller emits when no HTML error template is
 * available. It also runs the same global (Router.use) + per-route middleware.
 *
 * The discriminator: the miss body is the real 404 JSON, NOT the fabricated
 * {"error":"Not found"}. If a future change reverts TestClient to the invented
 * body, the assertion below fails — that is the bite.
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

  // ── THE discriminator: a miss is the real 404, never a fabricated body ──
  it("returns the real 404, not the fabricated {\"error\":\"Not found\"}", async () => {
    const r = await client.get("/d6-definitely-not-a-route");
    assert.equal(r.status, 404);
    assert.notEqual(r.text(), '{"error":"Not found"}', "TestClient still fabricates the pre-fix 404 body");
    const body = r.json() as Record<string, unknown>;
    assert.equal(body.error, "Not Found");
    assert.equal(body.statusCode, 404);
    assert.ok(String(body.message).includes("/d6-definitely-not-a-route"));
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
