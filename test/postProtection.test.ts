/**
 * Tests for POST route protection — verifying authMiddleware blocks
 * unauthenticated requests on write routes.
 *
 * Run with: npx tsx test/postProtection.test.ts
 */
import { Router, runRouteMiddlewares } from "../packages/core/src/router.ts";
import { createToken, validateToken, authMiddleware } from "../packages/core/src/auth.ts";
import type { Tina4Request, Tina4Response, Middleware } from "../packages/core/src/types.ts";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
  }
}

const SECRET = "test-secret-key-for-post-protection";
const authMw = authMiddleware(SECRET);

// ── Helpers ───────────────────────────────────────────────────────

function mockRequest(authHeader?: string): Tina4Request {
  const req = {
    headers: {} as Record<string, string>,
    params: {},
    query: {},
    body: null,
    ip: "127.0.0.1",
    files: [],
  } as unknown as Tina4Request;
  if (authHeader) {
    req.headers.authorization = authHeader;
  }
  return req;
}

function mockResponse(): { response: Tina4Response; lastCall: { data: unknown; status: number } | null } {
  const state = { lastCall: null as { data: unknown; status: number } | null };
  const response = function (data?: unknown, statusCode?: number) {
    state.lastCall = { data, status: statusCode ?? 200 };
    return response;
  } as Tina4Response;
  return { response, get lastCall() { return state.lastCall; } };
}

console.log("=== POST Route Protection Tests ===\n");

// ── POST route with authMiddleware rejects unauthenticated ───────

console.log("-- POST with authMiddleware --");

{
  const req = mockRequest();
  const mock = mockResponse();
  let nextCalled = false;
  authMw(req, mock.response, () => { nextCalled = true; });
  assert("POST without token: middleware blocks (no next)", nextCalled === false);
  assert("POST without token: returns 401", mock.lastCall?.status === 401);
}

// ── POST with valid token succeeds ──────────────────────────────

{
  const token = createToken({ userId: 1, role: "admin" }, SECRET);
  const req = mockRequest(`Bearer ${token}`);
  const mock = mockResponse();
  let nextCalled = false;
  authMw(req, mock.response, () => { nextCalled = true; });
  assert("POST with valid token: middleware calls next()", nextCalled === true);
  assert("POST with valid token: attaches auth to request", (req as any).auth?.userId === 1);
  assert("POST with valid token: no error response sent", mock.lastCall === null);
}

// ── POST with expired token returns 401 ──────────────────────────

console.log("\n-- Expired token --");

{
  const expiredToken = createToken({ userId: 1 }, SECRET, -1);
  const req = mockRequest(`Bearer ${expiredToken}`);
  const mock = mockResponse();
  let nextCalled = false;
  authMw(req, mock.response, () => { nextCalled = true; });
  assert("Expired token: does not call next()", nextCalled === false);
  assert("Expired token: returns 401", mock.lastCall?.status === 401);
}

// ── POST with malformed token returns 401 ────────────────────────

console.log("\n-- Malformed token --");

{
  const req = mockRequest("Bearer not.a.valid.jwt");
  const mock = mockResponse();
  let nextCalled = false;
  authMw(req, mock.response, () => { nextCalled = true; });
  assert("Malformed token: does not call next()", nextCalled === false);
  assert("Malformed token: returns 401", mock.lastCall?.status === 401);
}

// ── POST with wrong secret returns 401 ───────────────────────────

console.log("\n-- Wrong secret --");

{
  const wrongToken = createToken({ userId: 1 }, "wrong-secret");
  const req = mockRequest(`Bearer ${wrongToken}`);
  const mock = mockResponse();
  let nextCalled = false;
  authMw(req, mock.response, () => { nextCalled = true; });
  assert("Wrong secret: does not call next()", nextCalled === false);
  assert("Wrong secret: returns 401", mock.lastCall?.status === 401);
}

// ── GET route without middleware is public ────────────────────────

console.log("\n-- Route registration and matching --");

{
  const router = new Router();
  const handler = async (req: Tina4Request, res: Tina4Response) => {};

  // GET without middleware
  router.get("/api/items", handler);
  const getResult = router.match("GET", "/api/items");
  assert("GET route registered and matchable", getResult !== null);
  assert("GET route has no middleware by default", (getResult?.middlewares?.length ?? 0) === 0);
}

// ── POST route with authMiddleware registered ────────────────────

{
  const router = new Router();
  const handler = async (req: Tina4Request, res: Tina4Response) => {};

  router.post("/api/items", handler, [authMw]);
  const postResult = router.match("POST", "/api/items");
  assert("POST route with authMiddleware registered", postResult !== null);
  assert("POST route has 1 middleware", postResult?.middlewares?.length === 1);
}

// ── PUT/PATCH/DELETE with authMiddleware ──────────────────────────

console.log("\n-- PUT/PATCH/DELETE with authMiddleware --");

{
  const router = new Router();
  const handler = async (req: Tina4Request, res: Tina4Response) => {};

  router.put("/api/items/{id}", handler, [authMw]);
  router.patch("/api/items/{id}", handler, [authMw]);
  router.delete("/api/items/{id}", handler, [authMw]);

  const putResult = router.match("PUT", "/api/items/1");
  const patchResult = router.match("PATCH", "/api/items/1");
  const deleteResult = router.match("DELETE", "/api/items/1");

  assert("PUT route with authMiddleware", putResult !== null && (putResult.middlewares?.length ?? 0) === 1);
  assert("PATCH route with authMiddleware", patchResult !== null && (patchResult.middlewares?.length ?? 0) === 1);
  assert("DELETE route with authMiddleware", deleteResult !== null && (deleteResult.middlewares?.length ?? 0) === 1);
}

// ── PUT without token blocked by middleware ───────────────────────

{
  const req = mockRequest();
  const mock = mockResponse();
  let nextCalled = false;
  authMw(req, mock.response, () => { nextCalled = true; });
  assert("PUT without token: middleware blocks", nextCalled === false);
  assert("PUT without token: returns 401", mock.lastCall?.status === 401);
}

// ── Mixed: GET public, POST protected ────────────────────────────

console.log("\n-- Mixed routes --");

{
  const router = new Router();
  const getHandler = async (req: Tina4Request, res: Tina4Response) => {};
  const postHandler = async (req: Tina4Request, res: Tina4Response) => {};

  router.get("/api/items", getHandler);
  router.post("/api/items", postHandler, [authMw]);

  const getMatch = router.match("GET", "/api/items");
  const postMatch = router.match("POST", "/api/items");

  assert("GET /api/items is public (no middleware)", (getMatch?.middlewares?.length ?? 0) === 0);
  assert("POST /api/items is protected (has middleware)", (postMatch?.middlewares?.length ?? 0) === 1);
}

// ── Token with custom claims ─────────────────────────────────────

console.log("\n-- Custom claims preserved through auth --");

{
  const token = createToken({ userId: 42, role: "admin", scope: "write" }, SECRET);
  const req = mockRequest(`Bearer ${token}`);
  const mock = mockResponse();
  let nextCalled = false;
  authMw(req, mock.response, () => { nextCalled = true; });
  assert("Custom claims: next called", nextCalled === true);
  assert("Custom claims: userId preserved", (req as any).auth?.userId === 42);
  assert("Custom claims: role preserved", (req as any).auth?.role === "admin");
  assert("Custom claims: scope preserved", (req as any).auth?.scope === "write");
}

// ── Route group with middleware ──────────────────────────────────

console.log("\n-- Route group with authMiddleware --");

{
  const router = new Router();
  const handler = async (req: Tina4Request, res: Tina4Response) => {};

  router.group("/api/admin", (group) => {
    group.get("/users", handler);
    group.post("/users", handler);
    group.delete("/users/{id}", handler);
  }, [authMw]);

  const adminGet = router.match("GET", "/api/admin/users");
  const adminPost = router.match("POST", "/api/admin/users");
  const adminDelete = router.match("DELETE", "/api/admin/users/1");

  assert("Group GET has auth middleware", (adminGet?.middlewares?.length ?? 0) === 1);
  assert("Group POST has auth middleware", (adminPost?.middlewares?.length ?? 0) === 1);
  assert("Group DELETE has auth middleware", (adminDelete?.middlewares?.length ?? 0) === 1);
}

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
