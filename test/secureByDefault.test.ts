/**
 * Unit tests for secure-by-default route behaviour.
 *
 * Write methods (POST, PUT, PATCH, DELETE) are secure by default — they
 * require a valid Bearer token unless .noAuth() is called.
 * GET is NOT secure by default but can be made secure with .secure().
 *
 * These tests exercise the Router flags and replicate the auth enforcement
 * logic from server.ts without starting a real HTTP server.
 *
 * Run with: npx tsx test/secureByDefault.test.ts
 */
import { Router } from "../packages/core/src/router.ts";
import { getToken, validToken } from "../packages/core/src/auth.ts";
import type { Tina4Request, Tina4Response, RouteHandler } from "../packages/core/src/types.ts";

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

const SECRET = "secure-test-secret";
process.env.SECRET = SECRET;

// Dummy handler
const handler: RouteHandler = async (_req: Tina4Request, res: Tina4Response) => {
  res({ ok: true }, 200);
};

/**
 * Simulate the auth enforcement logic from server.ts (lines 687-700).
 * Returns the HTTP status code the server would send.
 */
function simulateAuthEnforcement(
  match: { secure?: boolean; noAuth?: boolean },
  authHeader?: string,
): { status: number; userPayload: Record<string, unknown> | null } {
  if (match.secure === true && match.noAuth !== true) {
    const header = authHeader ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const payload = token ? validToken(token) : null;

    if (!payload) {
      return { status: 401, userPayload: null };
    }
    return { status: 200, userPayload: payload };
  }
  // Not secure or noAuth — request proceeds
  return { status: 200, userPayload: null };
}

console.log("=== Secure-by-Default Tests ===\n");

// ── 13. POST without Bearer returns 401 ─────────────────────────

console.log("-- Write methods (secure by default) --");

{
  const router = new Router();
  router.post("/api/data", handler);
  const match = router.match("POST", "/api/data");
  assert("13a. POST route is found", match !== null);
  assert("13b. POST route has secure=true by default", match?.secure === true);
  const result = simulateAuthEnforcement(match!, undefined);
  assert("13. POST without Bearer returns 401", result.status === 401);
}

// ── 14. POST with valid Bearer returns 200 ──────────────────────

{
  const router = new Router();
  router.post("/api/data", handler);
  const match = router.match("POST", "/api/data");
  const token = getToken({ userId: 42 }, 3600);
  const result = simulateAuthEnforcement(match!, `Bearer ${token}`);
  assert("14. POST with valid Bearer returns 200", result.status === 200);
  assert("14b. User payload attached", result.userPayload?.userId === 42);
}

// ── 15. POST with .noAuth() returns 200 without token ───────────

console.log("\n-- noAuth override --");

{
  const router = new Router();
  router.post("/api/public", handler).noAuth();
  const match = router.match("POST", "/api/public");
  assert("15a. noAuth flag is set", match?.noAuth === true);
  const result = simulateAuthEnforcement(match!, undefined);
  assert("15. POST with .noAuth() returns 200 without token", result.status === 200);
}

// ── 16. GET with .secure() returns 401 without token ────────────

console.log("\n-- GET security --");

{
  const router = new Router();
  router.get("/api/private", handler).secure();
  const match = router.match("GET", "/api/private");
  assert("16a. GET .secure() sets secure=true", match?.secure === true);
  const result = simulateAuthEnforcement(match!, undefined);
  assert("16. GET with .secure() returns 401 without token", result.status === 401);
}

// ── 17. GET without .secure() returns 200 ───────────────────────

{
  const router = new Router();
  router.get("/api/open", handler);
  const match = router.match("GET", "/api/open");
  assert("17a. GET route has secure=undefined by default", match?.secure === undefined);
  const result = simulateAuthEnforcement(match!, undefined);
  assert("17. GET without .secure() returns 200", result.status === 200);
}

// ── Extra: PUT, PATCH, DELETE are also secure by default ────────

console.log("\n-- Other write methods --");

{
  const router = new Router();
  router.put("/api/item", handler);
  const match = router.match("PUT", "/api/item");
  assert("PUT is secure by default", match?.secure === true);
  const result = simulateAuthEnforcement(match!, undefined);
  assert("PUT without Bearer returns 401", result.status === 401);
}

{
  const router = new Router();
  router.patch("/api/item", handler);
  const match = router.match("PATCH", "/api/item");
  assert("PATCH is secure by default", match?.secure === true);
}

{
  const router = new Router();
  router.delete("/api/item", handler);
  const match = router.match("DELETE", "/api/item");
  assert("DELETE is secure by default", match?.secure === true);
}

// ── Extra: expired Bearer on secure route returns 401 ───────────

console.log("\n-- Edge cases --");

{
  const router = new Router();
  router.post("/api/data", handler);
  const match = router.match("POST", "/api/data");
  const expiredToken = getToken({ userId: 1 }, -1);
  const result = simulateAuthEnforcement(match!, `Bearer ${expiredToken}`);
  assert("Expired Bearer on POST returns 401", result.status === 401);
}

{
  const router = new Router();
  router.post("/api/data", handler);
  const match = router.match("POST", "/api/data");
  const result = simulateAuthEnforcement(match!, "Bearer garbage.token.here");
  assert("Invalid Bearer on POST returns 401", result.status === 401);
}

{
  const router = new Router();
  router.get("/api/private", handler).secure();
  const match = router.match("GET", "/api/private");
  const token = getToken({ role: "admin" }, 3600);
  const result = simulateAuthEnforcement(match!, `Bearer ${token}`);
  assert("Valid Bearer on secure GET returns 200", result.status === 200);
}

// ── Summary ─────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
