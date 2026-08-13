/**
 * Feature 32 (route groups) - the prefix+path JOIN grammar (RG-DEC-01).
 *
 * The audit found the join grammar diverges and is UNGATED: PHP fully
 * normalizes (Tina4/Router.php addRoute - the reference: one separator, no
 * double slash, a single leading slash); Node's RouteGroup did NO
 * normalization at all (the worst of the four) - `pattern: this.prefix +
 * path` bare-concatenated, so group("/api") + get("users") silently
 * mis-registered at "/apiusers". This converges Node onto PHP's grammar
 * (router.ts joinGroupPath, ported verbatim from Router.php).
 *
 * Real registration through the real Router, real HTTP through a real
 * server and a real socket (startServer + fetch) - no mocks. Positive AND
 * negative: a mis-registered path must 404.
 *
 * Same case names in all four:
 *   tina4-python/tests/test_route_groups_contract.py
 *   tina4-php/tests/RouteGroupsContractTest.php
 *   tina4-ruby/spec/route_groups_contract_spec.rb
 *
 * See tina4-documentation/plan/v3/fixtures/route_groups_contract.json.
 *
 * Run with: npx tsx test/routeGroupsContract.test.ts
 */
import { mkdirSync } from "node:fs";
import { Router, defaultRouter, startServer } from "../packages/core/src/index.ts";
import { freePort } from "./freePort.ts";

const ROUTES_DIR = "/tmp/tina4-routegroups-contract/src/routes";
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

const ok = async (_req: any, res: any) => res({ ok: true }, 200);

/** An ordinary group middleware. It does NOT do auth. */
let middlewareRuns = 0;
const counting = (_req: any, _res: any, next: any) => { middlewareRuns++; next(); };

// group("/api") + get("users") - the route's own path has NO leading slash.
// The old bare concatenation silently produced "/apiusers".
Router.group("/__rg32/c1", (group) => { group.get("users", ok); });

// group("/api") + get("/users") - the route's own path already carries its
// leading slash. Must land on the SAME canonical path, never a double slash.
Router.group("/__rg32/c2", (group) => { group.get("/users", ok); });

// group("/api/") + get("/users") - the GROUP prefix carries a trailing
// slash. Must ALSO land on the same canonical path.
Router.group("/__rg32/c3/", (group) => { group.get("/users", ok); });

// group("/api") > group("/v1") + get("users") -> "/api/v1/users".
Router.group("/__rg32/c4", (group) => {
  group.group("/v1", (inner) => { inner.get("users", ok); });
});

// LOCK: group middleware must never disable the write-auth gate - including
// under the normalized prefix join.
Router.group("/__rg32/c5", (group) => { group.post("/thing", ok); }, [counting]);

const port = await freePort();
const server: any = await startServer({ port, routesDir: ROUTES_DIR });

const hit = async (method: string, path: string) =>
  (await fetch(`http://127.0.0.1:${port}${path}`, { method })).status;

console.log("\n  Route groups contract - slash normalization\n");

// group_prefix_joins_to_a_single_slash_path
assert("group_prefix_joins_to_a_single_slash_path",
  (await hit("GET", "/__rg32/c1/users")) === 200);
assert("group_prefix_joins_to_a_single_slash_path (negative: bare-concat mis-registration must 404)",
  (await hit("GET", "/__rg32/c1users")) === 404);

// leading_slash_on_the_route_is_normalized
assert("leading_slash_on_the_route_is_normalized",
  (await hit("GET", "/__rg32/c2/users")) === 200);
{
  const paths = defaultRouter.listRoutes().map((r: any) => r.path ?? r.pattern);
  assert("leading_slash_on_the_route_is_normalized (no doubled separator)",
    paths.includes("/__rg32/c2/users") && !paths.includes("/__rg32/c2//users"),
    `got ${JSON.stringify(paths.filter((p: string) => p.includes("c2")))}`);
}

// trailing_slash_on_the_prefix_is_normalized
assert("trailing_slash_on_the_prefix_is_normalized",
  (await hit("GET", "/__rg32/c3/users")) === 200);
{
  const paths = defaultRouter.listRoutes().map((r: any) => r.path ?? r.pattern);
  assert("trailing_slash_on_the_prefix_is_normalized (no doubled separator)",
    paths.includes("/__rg32/c3/users") && !paths.includes("/__rg32/c3//users"),
    `got ${JSON.stringify(paths.filter((p: string) => p.includes("c3")))}`);
}

// nested_groups_concatenate_the_prefix
assert("nested_groups_concatenate_the_prefix",
  (await hit("GET", "/__rg32/c4/v1/users")) === 200);
assert("nested_groups_concatenate_the_prefix (negative: bare-concat mis-registration must 404)",
  (await hit("GET", "/__rg32/c4/v1users")) === 404);

// group_middleware_never_opens_the_write_auth_gate
assert("group_middleware_never_opens_the_write_auth_gate",
  (await hit("POST", "/__rg32/c5/thing")) === 401);

if (server?.close) server.close();

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
