/**
 * Unit tests for _checkAuth logic in server.ts — the three-source token resolution.
 *
 * Tests the auth enforcement block that checks:
 *   1. Authorization Bearer header (priority 1)
 *   2. formToken in request body (priority 2)
 *   3. Session token (priority 3)
 *
 * Run with: npx tsx test/checkAuth.test.ts
 */
import { getToken, validToken, getPayload, refreshToken } from "../packages/core/src/auth.ts";

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

const SECRET = "test-secret-for-checkauth";
process.env.SECRET = SECRET;

console.log("=== checkAuth Tests ===\n");

// ── Simulate the auth check logic from server.ts ─────────────────

interface MockReq {
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  session: { get(key: string): unknown } | undefined;
  user: Record<string, unknown> | undefined;
}

interface CheckAuthResult {
  authorized: boolean;
  user: Record<string, unknown> | undefined;
  freshToken: string | null;
  statusCode: number | null;
}

/**
 * Reproduces the auth enforcement logic from server.ts so we can test
 * the three-source priority chain in isolation.
 */
function checkAuth(req: MockReq): CheckAuthResult {
  const result: CheckAuthResult = {
    authorized: false,
    user: undefined,
    freshToken: null,
    statusCode: null,
  };

  const authHeader = req.headers.authorization ?? "";
  const headerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  // Priority 1: Authorization Bearer header
  let resolvedToken = "";
  let tokenSource: "header" | "body" | "session" | "" = "";

  if (headerToken && validToken(headerToken)) {
    resolvedToken = headerToken;
    tokenSource = "header";
  }

  // Priority 2: formToken from request body
  if (!resolvedToken) {
    const bodyToken = (req.body as Record<string, unknown>)?.formToken as string | undefined;
    if (bodyToken && validToken(bodyToken)) {
      resolvedToken = bodyToken;
      tokenSource = "body";
    }
  }

  // Priority 3: Session token
  if (!resolvedToken) {
    const sessionToken = req.session?.get?.("token") as string | undefined;
    if (sessionToken && validToken(sessionToken)) {
      resolvedToken = sessionToken;
      tokenSource = "session";
    }
  }

  if (!resolvedToken) {
    result.statusCode = 401;
    return result;
  }

  result.authorized = true;
  result.user = getPayload(resolvedToken) ?? {};

  // When body formToken validates, return a FreshToken
  if (tokenSource === "body") {
    const fresh = refreshToken(resolvedToken);
    if (fresh) {
      result.freshToken = fresh;
    }
  }

  return result;
}

// ── Valid Bearer header passes ───────────────────────────────────

console.log("-- Bearer Header --");

{
  const token = getToken({ userId: 1, role: "admin" }, 3600);
  const result = checkAuth({
    headers: { authorization: `Bearer ${token}` },
    body: undefined,
    session: undefined,
    user: undefined,
  });
  assert("Valid Bearer header passes", result.authorized === true);
  assert("Bearer header sets user.userId", result.user?.userId === 1);
  assert("Bearer header sets user.role", result.user?.role === "admin");
  assert("Bearer header does not set FreshToken", result.freshToken === null);
}

// ── Invalid Bearer header fails with 401 ─────────────────────────

console.log("\n-- Invalid Bearer Header --");

{
  const result = checkAuth({
    headers: { authorization: "Bearer invalid.token.here" },
    body: undefined,
    session: undefined,
    user: undefined,
  });
  assert("Invalid Bearer header returns 401", result.statusCode === 401);
  assert("Invalid Bearer header is not authorized", result.authorized === false);
}

{
  const expired = getToken({ userId: 1 }, -1);
  const result = checkAuth({
    headers: { authorization: `Bearer ${expired}` },
    body: undefined,
    session: undefined,
    user: undefined,
  });
  assert("Expired Bearer header returns 401", result.statusCode === 401);
  assert("Expired Bearer header is not authorized", result.authorized === false);
}

{
  const result = checkAuth({
    headers: {},
    body: undefined,
    session: undefined,
    user: undefined,
  });
  assert("Missing Authorization header returns 401", result.statusCode === 401);
}

// ── Valid formToken in body passes ────────────────────────────────

console.log("\n-- Body formToken --");

{
  const token = getToken({ userId: 2, scope: "write" }, 3600);
  const result = checkAuth({
    headers: {},
    body: { formToken: token, name: "Test" },
    session: undefined,
    user: undefined,
  });
  assert("Valid body formToken passes", result.authorized === true);
  assert("Body formToken sets user.userId", result.user?.userId === 2);
  assert("Body formToken sets user.scope", result.user?.scope === "write");
}

{
  const result = checkAuth({
    headers: {},
    body: { formToken: "invalid.token.value" },
    session: undefined,
    user: undefined,
  });
  assert("Invalid body formToken returns 401", result.statusCode === 401);
  assert("Invalid body formToken is not authorized", result.authorized === false);
}

{
  const expired = getToken({ userId: 1 }, -1);
  const result = checkAuth({
    headers: {},
    body: { formToken: expired },
    session: undefined,
    user: undefined,
  });
  assert("Expired body formToken returns 401", result.statusCode === 401);
}

// ── FreshToken header is returned when body token validates ──────

console.log("\n-- FreshToken on body auth --");

{
  const token = getToken({ userId: 3, role: "editor" }, 3600);
  const result = checkAuth({
    headers: {},
    body: { formToken: token },
    session: undefined,
    user: undefined,
  });
  assert("FreshToken is returned for body formToken", result.freshToken !== null);
  assert("FreshToken is a valid JWT", typeof result.freshToken === "string" && validToken(result.freshToken!));
  const freshPayload = getPayload(result.freshToken!);
  assert("FreshToken preserves userId", freshPayload?.userId === 3);
  assert("FreshToken preserves role", freshPayload?.role === "editor");
  // FreshToken may equal original if refreshed within the same second (same iat/exp),
  // but it must be a valid, non-null JWT with the correct payload
  assert("FreshToken is a non-empty string", typeof result.freshToken === "string" && result.freshToken!.length > 0);
}

// ── Valid session token passes ───────────────────────────────────

console.log("\n-- Session Token --");

{
  const token = getToken({ userId: 4, role: "viewer" }, 3600);
  const mockSession = {
    get(key: string): unknown {
      if (key === "token") return token;
      return undefined;
    },
  };
  const result = checkAuth({
    headers: {},
    body: undefined,
    session: mockSession,
    user: undefined,
  });
  assert("Valid session token passes", result.authorized === true);
  assert("Session token sets user.userId", result.user?.userId === 4);
  assert("Session token sets user.role", result.user?.role === "viewer");
  assert("Session token does not set FreshToken", result.freshToken === null);
}

{
  const mockSession = {
    get(key: string): unknown {
      if (key === "token") return "invalid.session.token";
      return undefined;
    },
  };
  const result = checkAuth({
    headers: {},
    body: undefined,
    session: mockSession,
    user: undefined,
  });
  assert("Invalid session token returns 401", result.statusCode === 401);
  assert("Invalid session token is not authorized", result.authorized === false);
}

{
  const expired = getToken({ userId: 1 }, -1);
  const mockSession = {
    get(key: string): unknown {
      if (key === "token") return expired;
      return undefined;
    },
  };
  const result = checkAuth({
    headers: {},
    body: undefined,
    session: mockSession,
    user: undefined,
  });
  assert("Expired session token returns 401", result.statusCode === 401);
}

// ── All invalid returns 401 ──────────────────────────────────────

console.log("\n-- All Sources Invalid --");

{
  const expired = getToken({ userId: 1 }, -1);
  const mockSession = {
    get(key: string): unknown {
      if (key === "token") return "bad.session.jwt";
      return undefined;
    },
  };
  const result = checkAuth({
    headers: { authorization: "Bearer bad.header.jwt" },
    body: { formToken: "bad.body.jwt" },
    session: mockSession,
    user: undefined,
  });
  assert("All three sources invalid returns 401", result.statusCode === 401);
  assert("All three sources invalid is not authorized", result.authorized === false);
}

{
  const result = checkAuth({
    headers: {},
    body: {},
    session: { get: () => undefined },
    user: undefined,
  });
  assert("All sources missing/empty returns 401", result.statusCode === 401);
}

// ── Priority chain: header > body > session ──────────────────────

console.log("\n-- Priority Chain --");

{
  const headerToken = getToken({ userId: 10, source: "header" }, 3600);
  const bodyToken = getToken({ userId: 20, source: "body" }, 3600);
  const sessionToken = getToken({ userId: 30, source: "session" }, 3600);
  const mockSession = {
    get(key: string): unknown {
      if (key === "token") return sessionToken;
      return undefined;
    },
  };

  // All three present — header wins
  const result1 = checkAuth({
    headers: { authorization: `Bearer ${headerToken}` },
    body: { formToken: bodyToken },
    session: mockSession,
    user: undefined,
  });
  assert("Header wins when all three present", result1.user?.source === "header");
  assert("Header wins: correct userId", result1.user?.userId === 10);
  assert("Header wins: no FreshToken", result1.freshToken === null);

  // Body + session present, no header — body wins
  const result2 = checkAuth({
    headers: {},
    body: { formToken: bodyToken },
    session: mockSession,
    user: undefined,
  });
  assert("Body wins when header absent", result2.user?.source === "body");
  assert("Body wins: correct userId", result2.user?.userId === 20);
  assert("Body wins: FreshToken is set", result2.freshToken !== null);

  // Only session present — session wins
  const result3 = checkAuth({
    headers: {},
    body: undefined,
    session: mockSession,
    user: undefined,
  });
  assert("Session wins when header and body absent", result3.user?.source === "session");
  assert("Session wins: correct userId", result3.user?.userId === 30);
  assert("Session wins: no FreshToken", result3.freshToken === null);
}

{
  // Invalid header falls through to valid body
  const bodyToken = getToken({ userId: 25, source: "body" }, 3600);
  const result = checkAuth({
    headers: { authorization: "Bearer invalid.header.jwt" },
    body: { formToken: bodyToken },
    session: undefined,
    user: undefined,
  });
  assert("Invalid header falls through to valid body", result.user?.source === "body");
  assert("Fallthrough body: correct userId", result.user?.userId === 25);
  assert("Fallthrough body: FreshToken is set", result.freshToken !== null);
}

{
  // Invalid header + invalid body falls through to valid session
  const sessionToken = getToken({ userId: 35, source: "session" }, 3600);
  const mockSession = {
    get(key: string): unknown {
      if (key === "token") return sessionToken;
      return undefined;
    },
  };
  const result = checkAuth({
    headers: { authorization: "Bearer invalid.header.jwt" },
    body: { formToken: "invalid.body.jwt" },
    session: mockSession,
    user: undefined,
  });
  assert("Invalid header+body falls through to valid session", result.user?.source === "session");
  assert("Fallthrough session: correct userId", result.user?.userId === 35);
  assert("Fallthrough session: no FreshToken", result.freshToken === null);
}

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
