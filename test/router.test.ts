/**
 * Unit tests for the Router enhancements (Phase 2).
 * Run with: npx tsx test/router.test.ts
 */
import { Router, RouteGroup, runRouteMiddlewares, resolveStringMiddleware, clearCache, _resetBackend } from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response, Middleware } from "../packages/core/src/index.ts";

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

console.log("=== Router Enhancement Tests ===\n");

// --- Programmatic Route Registration ---
console.log("--- Programmatic Routes ---");

const router = new Router();
const handler = async (req: Tina4Request, res: Tina4Response) => {};

router.get("/hello", handler);
router.post("/hello", handler);
router.put("/hello", handler);
router.patch("/hello", handler);
router.delete("/hello", handler);

const getMatch = router.match("GET", "/hello");
assert("GET route registered and matched", getMatch !== null);

const postMatch = router.match("POST", "/hello");
assert("POST route registered and matched", postMatch !== null);

const putMatch = router.match("PUT", "/hello");
assert("PUT route registered and matched", putMatch !== null);

const patchMatch = router.match("PATCH", "/hello");
assert("PATCH route registered and matched", patchMatch !== null);

const deleteMatch = router.match("DELETE", "/hello");
assert("DELETE route registered and matched", deleteMatch !== null);

const noMatch = router.match("GET", "/nonexistent");
assert("Non-existent route returns null", noMatch === null);

// --- Dynamic Parameters ---
console.log("\n--- Dynamic Parameters ---");

const router2 = new Router();
router2.get("/users/{id}", handler);
router2.get("/posts/:postId/comments/:commentId", handler);
router2.get("/files/[...path]", handler);

const userMatch = router2.match("GET", "/users/42");
assert("{id} param extracted", userMatch !== null && userMatch.params.id === "42");

const commentMatch = router2.match("GET", "/posts/1/comments/5");
assert(":param syntax works", commentMatch !== null && commentMatch.params.postId === "1" && commentMatch.params.commentId === "5");

const catchAll = router2.match("GET", "/files/a/b/c.txt");
assert("[...path] catch-all works", catchAll !== null && catchAll.params.path === "a/b/c.txt");

// --- Any Method ---
console.log("\n--- Any Method ---");

const router3 = new Router();
router3.any("/wildcard", handler);

assert("ANY matches GET", router3.match("GET", "/wildcard") !== null);
assert("ANY matches POST", router3.match("POST", "/wildcard") !== null);
assert("ANY matches DELETE", router3.match("DELETE", "/wildcard") !== null);
assert("ANY matches OPTIONS", router3.match("OPTIONS", "/wildcard") !== null);
assert("ANY matches HEAD", router3.match("HEAD", "/wildcard") !== null);

// --- Route Groups ---
console.log("\n--- Route Groups ---");

const router4 = new Router();
router4.group("/api/v1", (group) => {
  group.get("/users", handler);
  group.post("/users", handler);
  group.get("/users/{id}", handler);
});

const groupGet = router4.match("GET", "/api/v1/users");
assert("Group GET /api/v1/users matches", groupGet !== null);

const groupPost = router4.match("POST", "/api/v1/users");
assert("Group POST /api/v1/users matches", groupPost !== null);

const groupParam = router4.match("GET", "/api/v1/users/99");
assert("Group param route matches", groupParam !== null && groupParam.params.id === "99");

const groupNoMatch = router4.match("GET", "/users");
assert("Group route doesn't match without prefix", groupNoMatch === null);

// --- Nested Groups ---
console.log("\n--- Nested Groups ---");

const router5 = new Router();
router5.group("/api", (api) => {
  api.group("/v2", (v2) => {
    v2.get("/items", handler);
  });
});

const nestedMatch = router5.match("GET", "/api/v2/items");
assert("Nested group matches /api/v2/items", nestedMatch !== null);

// --- Route Middleware Chain ---
console.log("\n--- Route Middleware ---");

const router6 = new Router();
const logs: string[] = [];

const mw1: Middleware = (req, res, next) => {
  logs.push("mw1");
  next();
};

const mw2: Middleware = (req, res, next) => {
  logs.push("mw2");
  next();
};

const blockingMw: Middleware = (req, res, next) => {
  logs.push("blocked");
  // Intentionally not calling next()
};

router6.get("/protected", handler, [mw1, mw2]);
router6.get("/blocked", handler, [blockingMw]);

const protectedMatch = router6.match("GET", "/protected");
assert("Route with middleware has middlewares array", protectedMatch?.middlewares?.length === 2);

// Test runRouteMiddlewares
const mockReq = {} as Tina4Request;
const mockRes = { raw: { writableEnded: false } } as Tina4Response;

logs.length = 0;
const proceed = await runRouteMiddlewares(protectedMatch!.middlewares!, mockReq, mockRes);
assert("All middlewares ran and returned true", proceed === true);
assert("Both middlewares executed in order", logs[0] === "mw1" && logs[1] === "mw2");

const blockedMatch = router6.match("GET", "/blocked");
logs.length = 0;
const blocked = await runRouteMiddlewares(blockedMatch!.middlewares!, mockReq, mockRes);
assert("Blocking middleware returns false", blocked === false);
assert("Blocking middleware ran", logs[0] === "blocked");

// --- Group Middlewares ---
console.log("\n--- Group Middlewares ---");

const router7 = new Router();
const groupMw: Middleware = (req, res, next) => { next(); };
const routeMw: Middleware = (req, res, next) => { next(); };

router7.group("/admin", (group) => {
  group.get("/dashboard", handler, [routeMw]);
}, [groupMw]);

const adminMatch = router7.match("GET", "/admin/dashboard");
assert("Group middleware + route middleware merged", adminMatch?.middlewares?.length === 2);

// --- Route Listing ---
console.log("\n--- Route Listing ---");

const router8 = new Router();
function namedHandler(req: Tina4Request, res: Tina4Response) {}
router8.get("/list-test", namedHandler);
router8.post("/list-test", handler);

const listing = router8.listRoutes();
assert("listRoutes returns correct count", listing.length === 2);
assert("listRoutes has method and path", listing[0].method === "GET" && listing[0].path === "/list-test");
assert("listRoutes shows handler name", listing[0].handler === "namedHandler");

// --- Route Overwriting (Hot Reload) ---
console.log("\n--- Route Overwriting ---");

const router9 = new Router();
let version = "v1";

router9.get("/test", async (req, res) => { version = "v1"; });
router9.get("/test", async (req, res) => { version = "v2"; });

const routes = router9.listRoutes();
assert("Duplicate route replaced (not duplicated)", routes.filter(r => r.path === "/test").length === 1);

// --- Clear ---
console.log("\n--- Clear ---");

router9.clear();
assert("Clear removes all routes", router9.listRoutes().length === 0);

// --- Typed-parameter constraints (parity with tina4-python) ---
// Fixes tina4-book#125. All 4 frameworks share the same type set:
//   string (default), int/integer, float/number, alpha, alnum, slug,
//   uuid, path (greedy). Unknown types throw at registration.
console.log("\n--- Typed parameters ---");
{
  const r = new Router();
  const h = async (_req: any, _res: any) => {};

  r.get("/users/{id:int}", h);
  assert("{id:int} matches digits", r.match("GET", "/users/123") !== null);
  assert("{id:int} rejects non-numeric", r.match("GET", "/users/abc") === null);

  r.clear();
  r.get("/users/{name:alpha}", h);
  assert("{name:alpha} matches letters", r.match("GET", "/users/Alice") !== null);
  assert("{name:alpha} rejects digits", r.match("GET", "/users/alice123") === null);
  assert("{name:alpha} rejects hyphen", r.match("GET", "/users/alice-bob") === null);

  r.clear();
  r.get("/api/{code:alnum}", h);
  assert("{code:alnum} matches letters+digits", r.match("GET", "/api/abc123") !== null);
  assert("{code:alnum} rejects hyphen", r.match("GET", "/api/abc-123") === null);
  assert("{code:alnum} rejects dot", r.match("GET", "/api/abc.123") === null);

  r.clear();
  r.get("/posts/{slug:slug}", h);
  assert("{slug:slug} matches url-safe slug", r.match("GET", "/posts/hello-world") !== null);
  assert("{slug:slug} rejects uppercase", r.match("GET", "/posts/Hello-World") === null);
  assert("{slug:slug} rejects underscore", r.match("GET", "/posts/hello_world") === null);

  r.clear();
  r.get("/api/{id:uuid}", h);
  assert(
    "{id:uuid} matches UUID",
    r.match("GET", "/api/550e8400-e29b-41d4-a716-446655440000") !== null,
  );
  assert("{id:uuid} rejects non-UUID", r.match("GET", "/api/not-a-uuid") === null);

  r.clear();
  r.get("/a/{name:string}", h);
  r.get("/b/{name}", h);
  assert("{name:string} matches default", r.match("GET", "/a/alice") !== null);
  assert("{name} implicit still works", r.match("GET", "/b/alice") !== null);

  // Unknown types throw at registration
  const bad = [":str", ":inetger", ":word"];
  for (const t of bad) {
    let threw = false;
    let msg = "";
    try {
      r.clear();
      r.get(`/api/{x${t}}`, h);
    } catch (e: any) {
      threw = true;
      msg = String(e?.message ?? e);
    }
    assert(`Unknown type '${t}' throws at registration`, threw);
    assert(`Unknown type '${t}' message mentions 'Unknown param type'`, msg.includes("Unknown param type"));
  }

  // Message lists valid types
  let errMsg = "";
  try {
    r.clear();
    r.get("/api/{x:word}", h);
  } catch (e: any) {
    errMsg = String(e?.message ?? e);
  }
  for (const t of ["alpha", "alnum", "int", "slug", "uuid"]) {
    assert(`Error message lists '${t}'`, errMsg.includes(t));
  }
}

// --- Typed-parameter VALUE coercion (int/float → number) ---
// Parity with Python/PHP/Ruby: a typed {id:int} constrains matching AND the
// value arrives coerced — req.params.id is the number 42, not the string "42".
// Untyped {id} and all string-ish types stay strings.
console.log("\n--- Typed parameter coercion ---");
{
  const r = new Router();
  const h = async (_req: any, _res: any) => {};

  r.get("/users/{id:int}", h);
  const intMatch = r.match("GET", "/users/42");
  assert("{id:int} value is a number", typeof intMatch?.params.id === "number");
  assert("{id:int} value equals 42", intMatch?.params.id === 42);

  r.clear();
  r.get("/users/{id:integer}", h);
  const integerMatch = r.match("GET", "/users/7");
  assert("{id:integer} value is a number", typeof integerMatch?.params.id === "number");
  assert("{id:integer} value equals 7", integerMatch?.params.id === 7);

  r.clear();
  r.get("/products/{price:float}", h);
  const floatMatch = r.match("GET", "/products/19.99");
  assert("{price:float} value is a number", typeof floatMatch?.params.price === "number");
  assert("{price:float} value equals 19.99", floatMatch?.params.price === 19.99);

  r.clear();
  r.get("/products/{qty:number}", h);
  const numberMatch = r.match("GET", "/products/3.5");
  assert("{qty:number} value is a number", typeof numberMatch?.params.qty === "number");
  assert("{qty:number} value equals 3.5", numberMatch?.params.qty === 3.5);

  // String-ish types stay strings
  r.clear();
  r.get("/u/{name:alpha}", h);
  const alphaMatch = r.match("GET", "/u/Alice");
  assert("{name:alpha} value stays a string", typeof alphaMatch?.params.name === "string" && alphaMatch?.params.name === "Alice");

  r.clear();
  r.get("/api/{id:uuid}", h);
  const uuidMatch = r.match("GET", "/api/550e8400-e29b-41d4-a716-446655440000");
  assert("{id:uuid} value stays a string", typeof uuidMatch?.params.id === "string");

  r.clear();
  r.get("/files/{p:path}", h);
  const pathMatch = r.match("GET", "/files/a/b/c.txt");
  assert("{p:path} value stays a string", typeof pathMatch?.params.p === "string" && pathMatch?.params.p === "a/b/c.txt");

  r.clear();
  r.get("/a/{name:string}", h);
  const strMatch = r.match("GET", "/a/42");
  assert("{name:string} numeric-looking value stays a string", typeof strMatch?.params.name === "string" && strMatch?.params.name === "42");

  // Untyped param stays a string even when it looks numeric
  r.clear();
  r.get("/x/{id}", h);
  const untypedMatch = r.match("GET", "/x/42");
  assert("untyped {id} value stays the string '42'", typeof untypedMatch?.params.id === "string" && untypedMatch?.params.id === "42");

  // Non-numeric never reaches an int route (regex rejects → 404 / null)
  r.clear();
  r.get("/n/{id:int}", h);
  assert("{id:int} non-numeric does not match (404)", r.match("GET", "/n/abc") === null);
}

// --- String middleware specs ("ResponseCache" / "ResponseCache:300") ---
// The router resolves a string middleware spec to the response-cache
// middleware (parity with Python/PHP/Ruby). A route registered with the
// string middleware caches the GET response and sets the X-Cache header.
async function stringMiddlewareTests() {
  console.log("\n--- String Middleware Specs ---");

  // Resolution: string → middleware function (3-arg signature).
  const mw = await resolveStringMiddleware("ResponseCache:300");
  assert("'ResponseCache:300' resolves to a middleware function", typeof mw === "function" && mw.length === 3);
  const mwNoTtl = await resolveStringMiddleware("ResponseCache");
  assert("'ResponseCache' (no ttl) resolves to a middleware function", typeof mwNoTtl === "function");

  // Unknown spec throws so a typo surfaces.
  let threw = false;
  try { await resolveStringMiddleware("Nope"); } catch { threw = true; }
  assert("unknown string middleware throws", threw);

  // A route registered with the string middleware caches + sets X-Cache.
  // Drive it through runRouteMiddlewares exactly as the dispatcher does, so
  // the spec is resolved at run time.
  _resetBackend();
  await clearCache();

  const url = "/api/string-mw?x=" + Date.now();
  const body = JSON.stringify({ ok: true });
  const r = new Router();
  // String spec in the middleware list — never imported responseCache here.
  const mwHandler = async (_req: Tina4Request, _res: Tina4Response) => {};
  r.get("/api/string-mw", mwHandler, ["ResponseCache:300"]);
  const m = r.match("GET", "/api/string-mw");
  assert("route registered with string middleware matches", m !== null && (m!.middlewares?.length ?? 0) === 1);

  // First request — MISS. runRouteMiddlewares resolves the string, runs the
  // cache middleware, calls next(); we then emit the body via res.raw.end so
  // the middleware captures + stores it (and sets X-Cache: MISS + X-Cache-TTL).
  const h1: Record<string, string> = {};
  const req1 = { method: "GET", url } as Tina4Request;
  const res1 = {
    raw: {
      writableEnded: false, statusCode: 200,
      end(_chunk: any) { return this; },
      getHeader: (n: string) => h1[n.toLowerCase()] || "application/json",
    },
    header: (n: string, v: string) => { h1[n.toLowerCase()] = v; },
  } as unknown as Tina4Response;
  const proceed1 = await runRouteMiddlewares(m!.middlewares!, req1, res1);
  assert("string-mw first request proceeds (MISS → next)", proceed1 === true);
  (res1.raw.end as any)(body);
  assert("string-mw MISS sets X-Cache: MISS", h1["x-cache"] === "MISS", JSON.stringify(h1));
  assert("string-mw MISS sets X-Cache-TTL: 300", h1["x-cache-ttl"] === "300", JSON.stringify(h1));
  // Let the fire-and-forget backend.set settle.
  await new Promise((res) => setTimeout(res, 30));

  // Second request — HIT, served from cache (next NOT called) with X-Cache: HIT.
  const h2: Record<string, string> = {};
  let servedBody: string | null = null;
  const req2 = { method: "GET", url } as Tina4Request;
  const res2 = Object.assign(
    function (b: any) { servedBody = b; },
    {
      raw: {
        writableEnded: false, statusCode: 200,
        end(_chunk: any) { return this; },
        getHeader: (n: string) => h2[n.toLowerCase()] || "application/json",
      },
      header: (n: string, v: string) => { h2[n.toLowerCase()] = v; },
    },
  ) as unknown as Tina4Response;
  await runRouteMiddlewares(m!.middlewares!, req2, res2);
  // runRouteMiddlewares returns false on a HIT because the cache mw doesn't
  // call next() — it serves directly. Verify by the served body + header.
  assert("string-mw second request is a cache HIT (body served)", servedBody === body, `served=${servedBody}`);
  assert("string-mw HIT sets X-Cache: HIT", h2["x-cache"] === "HIT", JSON.stringify(h2));
  assert("string-mw HIT sets X-Cache-TTL: 300", h2["x-cache-ttl"] === "300", JSON.stringify(h2));

  await clearCache();
  _resetBackend();
}

await stringMiddlewareTests();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
