/**
 * Feature 29 - HTTP request model - shared cross-language contract (3.13.99).
 *
 * Four named cases, identical across Python/PHP/Ruby/Node
 * (plan/v3/fixtures/request_contract.json), each driven through the REAL
 * front controller (TestClient -> Router.match + enforceRouteAuth +
 * createRequest) — no mocks, no hand-invoked handlers.
 *
 *   route_param_not_shadowed_by_query  - REQ-PARAM-POLLUTION (security):
 *       params is route-only; a client ?id= can never shadow the route {id}.
 *       Already correct in Node — locked in here under the shared fixture name.
 *   malformed_json_body_agreed_result  - REQ-BODY-DIVERGE: malformed JSON ->
 *       the raw string, in all four. Already correct in Node.
 *   auth_middleware_sets_request_user  - the secure-by-default auth gate
 *       stashes the verified payload on req.user. Already correct in Node.
 *   ip_honours_xff_only_from_trusted_proxy - DO NOT REGRESS: remoteIp is
 *       always the raw peer; ip honours X-Forwarded-For ONLY from a
 *       TINA4_TRUSTED_PROXIES peer (see test/trustedProxy.test.ts for the
 *       deeper suite — this locks the existing algorithm, doesn't change it).
 */

process.env.TINA4_SECRET = "request-contract-secret";

import { strict as assert } from "node:assert";
import http from "node:http";
import { TestClient, Router } from "@tina4/core";
import { getToken } from "@tina4/core";
import { createRequest } from "../packages/core/src/request.ts";
import { createResponse } from "../packages/core/src/response.ts";
import { resetTrustedProxyCache } from "../packages/core/src/trustedProxy.ts";
import { freePort } from "./freePort.ts";
import type { Tina4Request, Tina4Response } from "@tina4/core";

let passed = 0;
let failed = 0;

function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      // eslint-disable-next-line no-console
      console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
      passed++;
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`  \x1b[31mFAIL\x1b[0m ${name}: ${(err as Error).message}`);
      failed++;
    });
}

async function run(): Promise<void> {
  // A dedicated Router (not the shared defaultRouter) so this suite never
  // races with other concurrent TestClient suites.
  const router = new Router();

  router.get("/__rq29/{id}", async (req: Tina4Request, res: Tina4Response) =>
    res.json({ params: req.params, query: req.query }));

  router.post("/__rq29/body", async (req: Tina4Request, res: Tina4Response) =>
    res.json({ body: req.body })).noAuth();

  router.post("/__rq29/whoami", async (req: Tina4Request, res: Tina4Response) =>
    res.json({ user: req.user ?? null }));

  const client = new TestClient(router);

  await it("route_param_not_shadowed_by_query", async () => {
    // A route `/{id}` hit with `?id=other` -> params["id"] is the ROUTE
    // value; the client value is only ever in query. Also asserts an
    // UNRELATED query key (`extra`) never leaks into params.
    const r = await client.get("/__rq29/1?id=other&extra=leak");
    assert.equal(r.status, 200);
    const body = r.json() as { params: Record<string, unknown>; query: Record<string, unknown> };
    assert.equal(body.params["id"], "1");
    assert.equal(body.query["id"], "other");
    assert.equal("extra" in body.params, false);
    assert.equal(body.query["extra"], "leak");
  });

  await it("malformed_json_body_agreed_result", async () => {
    const malformed = "{not valid json";
    const r = await client.post("/__rq29/body", {
      body: malformed,
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(r.status, 200);
    assert.equal((r.json() as { body: unknown }).body, malformed);
  });

  await it("auth_middleware_sets_request_user", async () => {
    const token = getToken({ sub: "contract-user", role: "tester" });
    const r = await client.post("/__rq29/whoami", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 200);
    const user = (r.json() as { user: Record<string, unknown> | null }).user;
    assert.ok(user, "request.user must be set for a valid bearer token");
    assert.equal(user!["sub"], "contract-user");
    assert.equal(user!["role"], "tester");
  });

  await it("ip_honours_xff_only_from_trusted_proxy", async () => {
    // A REAL node:http server + a REAL loopback TCP connection (the same
    // gold-standard pattern as test/trustedProxy.test.ts's withLimitedServer)
    // — the peer is always 127.0.0.1 (a genuine OS-assigned socket peer, not
    // a faked field), and TINA4_TRUSTED_PROXIES is toggled to make that peer
    // trusted or not. No doubles anywhere in the request path.
    const port = await freePort();
    const server = http.createServer((raw, rawRes) => {
      const req = createRequest(raw);
      const res = createResponse(rawRes);
      res({ ip: req.ip, remoteIp: req.remoteIp }, 200);
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

    const hit = (xff: string): Promise<{ ip: string; remoteIp: string }> =>
      new Promise((resolve, reject) => {
        const r = http.request(
          { host: "127.0.0.1", port, path: "/probe", method: "GET",
            headers: { "X-Forwarded-For": xff } },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (c) => chunks.push(c));
            response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
          },
        );
        r.on("error", reject);
        r.end();
      });

    const spoofed = "1.2.3.4";
    try {
      // Trusted peer: X-Forwarded-For IS honoured. The loopback peer of this
      // very connection is 127.0.0.1 — list it as the trusted proxy.
      process.env.TINA4_TRUSTED_PROXIES = "127.0.0.1";
      resetTrustedProxyCache();
      let result = await hit(spoofed);
      assert.equal(result.remoteIp, "127.0.0.1");
      assert.equal(result.ip, spoofed);

      // Untrusted peer: nothing lists 127.0.0.1 — X-Forwarded-For is ignored,
      // the raw peer wins.
      delete process.env.TINA4_TRUSTED_PROXIES;
      resetTrustedProxyCache();
      result = await hit(spoofed);
      assert.equal(result.remoteIp, "127.0.0.1");
      assert.equal(result.ip, "127.0.0.1");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // eslint-disable-next-line no-console
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
