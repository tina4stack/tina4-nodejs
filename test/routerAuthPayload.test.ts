/**
 * Integration tests verifying that after the validToken() → bool refactor
 * the auth enforcement block in server.ts correctly:
 *   1. Returns 401 for POST without a Bearer token
 *   2. Returns 200 AND sets userPayload to the actual payload object (not true)
 *      for a POST with a valid Bearer token
 *   3. Returns 401 for POST with an invalid Bearer token
 *   4. Returns 200 with null userPayload for an open GET (no .secure())
 *
 * These tests replicate the auth enforcement logic from server.ts lines 788-800
 * without starting a real HTTP server — same pattern as secureByDefault.test.ts.
 *
 * Run: npx tsx test/routerAuthPayload.test.ts
 */

import { Router } from "../packages/core/src/router.ts";
import { getToken, validToken, getPayload } from "../packages/core/src/auth.ts";
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

const SECRET = "test-router-auth-secret";
process.env.SECRET = SECRET;

// Dummy handler — used when we only care about auth enforcement, not route logic
const handler: RouteHandler = async (_req: Tina4Request, res: Tina4Response) => {
  res({ ok: true }, 200);
};

/**
 * Replicate the auth enforcement block from server.ts (lines 788-800).
 *
 * Returns status and the userPayload that would be assigned to req.user.
 * When validToken() was changed to return bool, getPayload() was still
 * called separately — this confirms that path is exercised and returns
 * the actual payload object rather than true.
 */
function simulateAuthEnforcement(
  match: { secure?: boolean; noAuth?: boolean },
  authHeader?: string,
): { status: number; userPayload: Record<string, unknown> | null } {
  if (match.secure === true && match.noAuth !== true) {
    const header = authHeader ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !validToken(token)) {
      return { status: 401, userPayload: null };
    }
    // server.ts: req.user = getPayload(token) ?? {};
    // This must be a dict, not true.
    const payload = getPayload(token) ?? {};
    return { status: 200, userPayload: payload };
  }
  // Not secured — request proceeds, no payload attached
  return { status: 200, userPayload: null };
}

console.log("=== Router Auth Payload Tests ===\n");

// ── 1. POST without Bearer returns 401 ──────────────────────────

console.log("-- Auth enforcement: missing token --");

{
  const router = new Router();
  router.post("/api/data", handler);
  const match = router.match("POST", "/api/data");
  assert("1a. POST route exists", match !== null);
  assert("1b. POST route is secure by default", match?.secure === true);
  const result = simulateAuthEnforcement(match!, undefined);
  assert("1. POST without Bearer returns 401", result.status === 401);
  assert("1c. userPayload is null when 401", result.userPayload === null);
}

// ── 2. POST with valid Bearer → 200 and payload is object ───────

console.log("\n-- Auth enforcement: valid token --");

{
  const router = new Router();
  router.post("/api/data", handler);
  const match = router.match("POST", "/api/data");

  const token = getToken({ userId: 42 }, 3600);
  const result = simulateAuthEnforcement(match!, `Bearer ${token}`);

  assert("2. POST with valid Bearer returns 200", result.status === 200);

  // This is the critical regression check: userPayload must be a dict, not `true`
  assert(
    "2a. userPayload is an object (not true)",
    typeof result.userPayload === "object" && result.userPayload !== null,
  );
  assert(
    "2b. userPayload.userId === 42 (not true)",
    result.userPayload?.userId === 42,
  );
}

// ── 3. POST with invalid Bearer returns 401 ─────────────────────

console.log("\n-- Auth enforcement: invalid token --");

{
  const router = new Router();
  router.post("/api/data", handler);
  const match = router.match("POST", "/api/data");
  const result = simulateAuthEnforcement(match!, "Bearer garbage.token.here");
  assert("3. POST with invalid Bearer returns 401", result.status === 401);
  assert("3a. userPayload is null when 401", result.userPayload === null);
}

// ── 4. GET (open by default) returns 200 with null payload ───────

console.log("\n-- Open GET route --");

{
  const router = new Router();
  router.get("/api/open", handler);
  const match = router.match("GET", "/api/open");
  assert("4a. GET route has no secure flag by default", match?.secure === undefined);
  const result = simulateAuthEnforcement(match!, undefined);
  assert("4. GET without .secure() returns 200", result.status === 200);
  assert("4b. userPayload is null for open route", result.userPayload === null);
}

// ── 5. Expired token returns 401 ────────────────────────────────

console.log("\n-- Edge cases --");

{
  const router = new Router();
  router.post("/api/data", handler);
  const match = router.match("POST", "/api/data");
  const expiredToken = getToken({ userId: 1 }, -1);
  const result = simulateAuthEnforcement(match!, `Bearer ${expiredToken}`);
  assert("5. Expired Bearer on POST returns 401", result.status === 401);
}

// ── 6. Payload carries all original claims ───────────────────────

{
  const router = new Router();
  router.post("/api/data", handler);
  const match = router.match("POST", "/api/data");
  const token = getToken({ userId: 99, role: "admin", org: "tina4" }, 3600);
  const result = simulateAuthEnforcement(match!, `Bearer ${token}`);
  assert("6. userPayload carries all claims (userId)", result.userPayload?.userId === 99);
  assert("6b. userPayload carries all claims (role)", result.userPayload?.role === "admin");
  assert("6c. userPayload carries all claims (org)", result.userPayload?.org === "tina4");
}

// ── Summary ─────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
