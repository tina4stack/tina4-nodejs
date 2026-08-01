/**
 * Feature 79 (route groups) - a group must not weaken the auth gate.
 *
 * ADR-0019. Python shipped a hole here: attaching middleware to a group set
 * auth_required = False, so an ordinary logging middleware made every write
 * route inside the group PUBLIC. Node has always been correct - router.ts
 * annotates its own version "parity with PY-10-02", naming Python as the
 * framework that had the bug.
 *
 * These assertions exist so Node CANNOT acquire it. That is the point: the hole
 * survived in Python precisely because nothing asserted the opposite. Case
 * names match tina4-python/tests/test_route_groups.py,
 * tina4-php/tests/RouteGroupAuthTest.php and
 * tina4-ruby/spec/route_group_auth_spec.rb.
 *
 * Real HTTP through a real server and the real auth gate. No doubles.
 *
 * Run with: npx tsx test/routeGroupAuth.test.ts
 */
import { mkdirSync } from "node:fs";
import { Router, defaultRouter, getToken, startServer } from "../packages/core/src/index.ts";
import { freePort } from "./freePort.ts";

process.env.TINA4_SECRET = "route-group-auth-secret";
const ROUTES_DIR = "/tmp/tina4-routegroup-auth/src/routes";
mkdirSync(ROUTES_DIR, { recursive: true });

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

/** An ordinary group middleware. It does NOT do auth. */
let middlewareRuns = 0;
const counting = (_req: any, _res: any, next: any) => { middlewareRuns++; next(); };
const ok = async (_req: any, res: any) => res({ ok: true }, 200);

Router.post("/rg/plain", ok);

Router.group("/rg/secured", (group) => { group.post("/thing", ok); }, [counting]);

Router.group("/rg/outer", (group) => {
  group.group("/inner", (inner) => { inner.post("/thing", ok); });
}, [counting]);

Router.group("/rg/public", (group) => { group.post("/thing", ok).noAuth(); }, [counting]);

Router.group("/rg/once", (group) => { group.get("/thing", ok); }, [counting]);

Router.group("/rg/api", (group) => {
  group.group("/admin", (admin) => { admin.get("/stats", ok); });
});

const port = await freePort();
const server: any = await startServer({ port, routesDir: ROUTES_DIR });

const hit = async (method: string, path: string, headers: Record<string, string> = {}) =>
  (await fetch(`http://127.0.0.1:${port}${path}`, { method, headers })).status;

console.log("\n  Route group auth\n");

// The control. If this ever goes public the assertion below proves nothing.
assert("ungrouped write route is secured by default",
  (await hit("POST", "/rg/plain")) === 401);

assert("group middleware does not open a secured write route",
  (await hit("POST", "/rg/secured/thing")) === 401,
  "group middleware silently opened a secured write route");

assert("group middleware does not open a nested write route",
  (await hit("POST", "/rg/outer/inner/thing")) === 401);

// The positive twin: noAuth() is the explicit spelling and must work, or there
// would be no way to declare a public write route inside a group.
assert("group route can still be opened explicitly",
  (await hit("POST", "/rg/public/thing")) === 200);

// Python merged group middleware twice, so it ran twice and a counter or a
// rate-limit bucket double-counted every request.
middlewareRuns = 0;
const onceStatus = await hit("GET", "/rg/once/thing");
assert("group middleware runs once per request",
  onceStatus === 200 && middlewareRuns === 1,
  `status ${onceStatus}, middleware ran ${middlewareRuns} time(s)`);

// A secured route must still admit a valid token, or "401 for everyone" would
// pass every negative case above while being completely broken.
assert("a valid token still reaches a grouped write route",
  (await hit("POST", "/rg/secured/thing",
    { Authorization: `Bearer ${getToken({ user: "alice" })}` })) === 200);

const patterns = defaultRouter.listRoutes().map((r: any) => r.path ?? r.pattern);
assert("nested group prefix composes",
  patterns.includes("/rg/api/admin/stats") && !patterns.includes("/rg/api/stats"),
  `got ${JSON.stringify(patterns.filter((p: string) => p.includes("stats")))}`);

if (server?.close) server.close();

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
