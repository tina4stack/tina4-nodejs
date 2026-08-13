/**
 * Shared cross-framework conformance for feature 131 (TestClient fidelity).
 *
 * Plan: tina4-documentation/plan/v3/features/131-test-client.md
 * Fixture: tina4-documentation/plan/v3/fixtures/test_client_contract.json
 *
 * TC-DEC-01: Node's TestClient used to RE-IMPLEMENT the dispatch order
 * (matching the route directly, running global/route middleware and the auth
 * gate by hand) instead of calling the server's real pipeline. That meant the
 * session stage never ran (a session-token auth regression was structurally
 * unreachable) and route middleware ran BEFORE the auth gate (the live order
 * is gate-first, ADR-0012). TestClient now calls server.ts's exported
 * runDispatch() — the SAME function every live socket connection runs — via
 * either the live server's DispatchContext (getLiveDispatchContext(), when
 * one is running in this process) or a standalone one bound to the given
 * router (buildDispatchContext()). This suite is the shared fixture that
 * proves it, mirroring Python/PHP/Ruby's own TestClient contract suites.
 *
 * TC-DEC-02: getHeaderList(name) is the new multi accessor for a duplicate
 * response header (two Set-Cookie) — headers[name] stays the back-compat
 * single (last) value.
 *
 * Four cases, identical names in all four frameworks' own idiom:
 *   - test client response equals a real socket request — THE ORACLE. Boots
 *     a REAL server (startServer(), on a real ephemeral port) and asserts
 *     the in-process TestClient response equals what the real socket gave
 *     back for the IDENTICAL route (status, body, content-type, a custom
 *     marker header). TestClient() with no explicit router prefers the live
 *     server's own DispatchContext, so both legs drive the literal same app.
 *   - a secured route returns 401 without running its route middleware —
 *     locks gate-BEFORE-middleware (ADR-0012): a visible marker proves the
 *     route's own middleware never ran on a request the gate already
 *     rejected.
 *   - a session login then authenticated request succeeds — locks the
 *     session stage: a login route sets req.session.set("token", ...), the
 *     Set-Cookie is threaded BY HAND (no cookie jar — TC-NO-COOKIE-JAR is
 *     deliberately out of scope) into a second request to a .secure() route.
 *     This is THE case that was structurally impossible before TC-DEC-01,
 *     since the old TestClient never attached req.session at all.
 *   - duplicate response headers are all exposed — two response.cookie()
 *     calls on one route; getHeaderList("set-cookie") returns BOTH,
 *     headers["set-cookie"] still collapses to the last (back-compat).
 *
 * NO MOCKS: the oracle is a real HTTP server on a real socket; every other
 * case drives the real in-process dispatch (runDispatch) through TestClient
 * with an isolated Router (parity with testClientFrontController.test.ts's
 * isolation contract — a dedicated router never races with other TestClient
 * suites running concurrently). Positive AND negative assertions throughout.
 *
 * Mirrors: Python tests/test_test_client_contract.py,
 *          PHP tests/TestClientContractTest.php,
 *          Ruby spec/test_client_contract_spec.rb.
 */

process.env.TINA4_SECRET = "tc131-contract-secret";
delete process.env.TINA4_API_KEY;

import { strict as assert } from "node:assert";
import http from "node:http";
import { startServer, get, Router, TestClient, getToken } from "@tina4/core";
import type { Tina4Request, Tina4Response } from "@tina4/core";
import { freePort } from "./freePort.js";

let passed = 0;
let failed = 0;

// SEQUENTIAL, unlike the fire-and-forget `it()` most Node suites in this repo
// use — case 1 boots a real server (a non-trivial, real async operation) and
// case 2 depends on a module-level marker nothing else here touches, so
// running the four cases one at a time (awaited) removes any doubt about
// ordering or a fixed grace period being long enough for real I/O.
async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
    failed++;
  }
}

/** Visible marker a route-attached middleware class flips when it runs. */
class Tc131Marker {
  static ran = false;
  static beforeMarker(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] {
    Tc131Marker.ran = true;
    return [req, res];
  }
}

async function run(): Promise<void> {
  // ── the oracle ──────────────────────────────────────────────────────
  await it("test client response equals a real socket request", async () => {
    // Registered on defaultRouter BEFORE startServer() boots — startServer()
    // merges defaultRouter's routes into its own live router exactly once,
    // at boot. The handler ALSO touches req.session — session is Node's own
    // historical gap (TC-DEC-01a), so this one route is enough on its own to
    // catch a reintroduced skip: the old re-implemented dispatch never
    // attached req.session at all, so this line would throw under it (each
    // leg starts a fresh session — no cookie is shared between the live
    // socket call and the TestClient call — so a correct dispatch reads back
    // 1 on both sides regardless).
    get("/tc131-oracle", async (req: Tina4Request, res: Tina4Response) => {
      const visits = Number((req as any).session.get("oracle_visits") ?? 0) + 1;
      (req as any).session.set("oracle_visits", visits);
      res.header("X-Tc131-Marker", "oracle");
      return res.json({ pipeline: "ok", visits });
    });

    const port = await freePort();
    const server = await startServer({
      port,
      routesDir: "/tmp/tc131-nonexistent-routes",
      modelsDir: "/tmp/tc131-nonexistent-models",
      staticDir: "/tmp/tc131-nonexistent-static",
    });

    try {
      const live = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
        (resolve, reject) => {
          const req = http.get({ host: "127.0.0.1", port, path: "/tc131-oracle" }, (res) => {
            let body = "";
            res.on("data", (c) => { body += c; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
          });
          req.on("error", reject);
        },
      );

      // The live server is the oracle: prove IT answered (with a session
      // that really ran, visits: 1) before trusting the comparison — a
      // shared failure could vacuously "match".
      assert.equal(live.status, 200, "live server did not answer /tc131-oracle");
      assert.equal(live.headers["x-tc131-marker"], "oracle");
      assert.equal(JSON.parse(live.body).visits, 1, "the live server's own session stage did not run");

      // No explicit router -> TestClient prefers the LIVE server's own
      // DispatchContext (getLiveDispatchContext()), so this drives the
      // literal same app the socket just hit.
      const testResult = await new TestClient().get("/tc131-oracle");

      assert.equal(testResult.status, live.status);
      assert.equal(testResult.body, live.body);
      assert.equal(testResult.headers["content-type"], live.headers["content-type"]);
      assert.equal(testResult.headers["x-tc131-marker"], live.headers["x-tc131-marker"]);
      assert.equal(
        (testResult.json() as { visits: number }).visits,
        1,
        "TestClient's own session stage did not run (feature 131, TC-DEC-01a)",
      );
    } finally {
      server.close();
    }
  });

  // ── gate BEFORE route middleware (ADR-0012) ─────────────────────────
  await it("a secured route returns 401 without running its route middleware", async () => {
    Tc131Marker.ran = false;
    const router = new Router();
    router.post("/tc131-secured-write", async (_req: Tina4Request, res: Tina4Response) => res.json({ created: true }, 201), [
      Tc131Marker,
    ]);
    const client = new TestClient(router);

    assert.equal(Tc131Marker.ran, false, "marker must start unset");

    const rejected = await client.post("/tc131-secured-write", { json: { name: "Mallory" } });
    assert.equal(rejected.status, 401, "a tokenless write to a secured route must 401");
    assert.equal(
      Tc131Marker.ran,
      false,
      "the route's own middleware ran on a request the auth gate should have rejected first — " +
        "gate-before-middleware order (ADR-0012) is broken",
    );

    // Positive control: a VALID token lets the request through, and only
    // THEN does the route's own middleware run — proving the marker
    // mechanism itself works (a permanently-false marker would pass the
    // negative assertion above for the wrong reason).
    const token = getToken({ sub: "tc131-user" });
    const ok = await client.post("/tc131-secured-write", {
      json: { name: "Alice" },
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(ok.status, 201);
    assert.equal(Tc131Marker.ran, true, "middleware must run for an authorised request");
  });

  // ── the session stage runs (Node's structural gap) ──────────────────
  await it("a session login then authenticated request succeeds", async () => {
    const router = new Router();
    router
      .post("/tc131-login", async (req: Tina4Request, res: Tina4Response) => {
        const token = getToken({ sub: "tc131-user" });
        (req as any).session.set("token", token);
        return res.json({ logged_in: true });
      })
      .noAuth();
    router.get("/tc131-protected", async (_req: Tina4Request, res: Tina4Response) => res.json({ ok: true })).secure();

    const client = new TestClient(router);

    // Negative first: the protected route is genuinely gated.
    const bare = await client.get("/tc131-protected");
    assert.equal(bare.status, 401, "the session-guarded route must reject an unauthenticated request");

    const loginRes = await client.post("/tc131-login");
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers["set-cookie"];
    assert.ok(setCookie, "login must set a session cookie for the session stage to have run");
    const cookiePair = setCookie!.split(";")[0]!;

    const protectedRes = await client.get("/tc131-protected", { headers: { Cookie: cookiePair } });
    assert.equal(
      protectedRes.status,
      200,
      "replaying the session cookie must authenticate the request via the session-token path — " +
        "this is structurally unreachable if the session stage never attaches req.session",
    );
    assert.deepEqual(protectedRes.json(), { ok: true });
  });

  // ── duplicate response headers are all exposed (TC-DEC-02) ─────────
  await it("duplicate response headers are all exposed", async () => {
    const router = new Router();
    router.get("/tc131-cookies", async (_req: Tina4Request, res: Tina4Response) => {
      res.cookie("tc131_a", "1");
      res.cookie("tc131_b", "2");
      return res.json({ ok: true });
    });

    const response = await new TestClient(router).get("/tc131-cookies");

    assert.equal(response.status, 200);
    const allCookies = response.getHeaderList("set-cookie");
    // The framework auto-starts a session on every request (independent of
    // this route), so a THIRD, incidental Set-Cookie (tina4_session) is real
    // and expected here too — filter to the two THIS route set on purpose
    // rather than asserting a total count sensitive to that.
    const tc131Cookies = allCookies.filter((c) => c.startsWith("tc131_a=") || c.startsWith("tc131_b="));
    assert.equal(tc131Cookies.length, 2, `expected 2 Set-Cookie values, got ${JSON.stringify(allCookies)}`);
    assert.ok(tc131Cookies.some((c) => c.startsWith("tc131_a=1")));
    assert.ok(tc131Cookies.some((c) => c.startsWith("tc131_b=2")));

    // Back-compat: the single accessor still collapses to ONE value (the
    // last one sent), never a joined string or an array — existing callers
    // are unaffected.
    assert.equal(typeof response.headers["set-cookie"], "string");
    assert.ok(allCookies.includes(response.headers["set-cookie"]!));

    // Negative: a header that was only ever sent once returns a one-item
    // array, not an empty one, and a header never sent returns [].
    assert.deepEqual(response.getHeaderList("content-type"), [response.headers["content-type"]]);
    assert.deepEqual(response.getHeaderList("x-tc131-never-sent"), []);
  });

  // eslint-disable-next-line no-console
  console.log(`\nTestClient contract tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
