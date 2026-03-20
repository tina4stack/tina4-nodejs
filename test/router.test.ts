/**
 * Unit tests for the Router enhancements (Phase 2).
 * Run with: npx tsx test/router.test.ts
 */
import { Router, RouteGroup, runRouteMiddlewares } from "../packages/core/src/index.ts";
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

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
