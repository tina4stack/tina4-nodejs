/**
 * Unit tests for CsrfMiddleware (class-based before/after convention).
 * Run with: npx tsx test/csrfMiddleware.test.ts
 */
import { CsrfMiddleware } from "../packages/core/src/middleware.ts";
import { createToken, validToken } from "../packages/core/src/auth.ts";
import type { Tina4Request, Tina4Response } from "../packages/core/src/types.ts";

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

const SECRET = "csrf-test-secret";
// Set SECRET env so CsrfMiddleware picks it up
process.env.SECRET = SECRET;

// ── Helpers ──────────────────────────────────────────────────────

interface MockRaw {
  statusCode: number;
  writableEnded: boolean;
}

interface ResponseState {
  lastData: unknown;
  lastStatus: number;
}

function mockRequest(overrides: Partial<{
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  query: Record<string, string>;
  route: { noAuth?: boolean };
  session: Record<string, unknown>;
}>): Tina4Request {
  return {
    method: overrides.method ?? "POST",
    headers: overrides.headers ?? {},
    body: overrides.body ?? null,
    query: overrides.query ?? {},
    params: {},
    ip: "127.0.0.1",
    files: [],
    _route: overrides.route ?? undefined,
    session: overrides.session ?? undefined,
  } as unknown as Tina4Request;
}

function mockResponse(): { res: Tina4Response; raw: MockRaw; state: ResponseState } {
  const raw: MockRaw = { statusCode: 200, writableEnded: false };
  const state: ResponseState = { lastData: null, lastStatus: 200 };

  const resFn = function (data?: unknown, statusCode?: number) {
    if (statusCode !== undefined) {
      raw.statusCode = statusCode;
    }
    state.lastData = data;
    state.lastStatus = statusCode ?? 200;
    return resFn;
  } as Tina4Response;

  resFn.raw = raw as any;
  resFn.header = () => resFn;

  return { res: resFn, raw, state };
}

console.log("=== CSRF Middleware Tests ===\n");

// ── 1. CSRF skips GET requests ──────────────────────────────────

console.log("-- Safe method skipping --");

{
  const req = mockRequest({ method: "GET" });
  const { res, raw } = mockResponse();
  const [, , ] = CsrfMiddleware.beforeCsrf(req, res);
  assert("1. CSRF skips GET requests", raw.statusCode === 200);
}

// ── 2. CSRF skips HEAD requests ──────────────────────────────────

{
  const req = mockRequest({ method: "HEAD" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("2. CSRF skips HEAD requests", raw.statusCode === 200);
}

// ── 3. CSRF skips OPTIONS requests ──────────────────────────────

{
  const req = mockRequest({ method: "OPTIONS" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("3. CSRF skips OPTIONS requests", raw.statusCode === 200);
}

// ── 4. CSRF blocks POST without token — returns 403 ────────────

console.log("\n-- Token enforcement --");

{
  const req = mockRequest({ method: "POST" });
  const { res, raw, state } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("4. CSRF blocks POST without token — returns 403", raw.statusCode === 403);
  assert("4b. Error body has CSRF_INVALID", (state.lastData as any)?.error === "CSRF_INVALID");
}

// ── 5. CSRF accepts formToken in body ───────────────────────────

{
  const token = createToken({ csrf: true }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    body: { formToken: token },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("5. CSRF accepts formToken in body", raw.statusCode === 200);
}

// ── 6. CSRF accepts X-Form-Token header ─────────────────────────

{
  const token = createToken({ csrf: true }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    headers: { "x-form-token": token },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("6. CSRF accepts X-Form-Token header", raw.statusCode === 200);
}

// ── 7. CSRF rejects formToken in query params — returns 403 ────

{
  const token = createToken({ csrf: true }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    query: { formToken: token },
  });
  const { res, raw, state } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("7. CSRF rejects formToken in query params — returns 403", raw.statusCode === 403);
  assert("7b. Error mentions query string",
    ((state.lastData as any)?.message ?? "").includes("query string"));
}

// ── 8. CSRF rejects invalid/expired token — returns 403 ────────

{
  // Expired token
  const expiredToken = createToken({ csrf: true }, SECRET, -1);
  const req = mockRequest({
    method: "POST",
    body: { formToken: expiredToken },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("8a. CSRF rejects expired token — returns 403", raw.statusCode === 403);
}

{
  // Completely invalid token
  const req = mockRequest({
    method: "POST",
    body: { formToken: "not.a.valid.token" },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("8b. CSRF rejects invalid token — returns 403", raw.statusCode === 403);
}

{
  // Token signed with wrong secret
  const wrongSecretToken = createToken({ csrf: true }, "wrong-secret", 3600);
  const req = mockRequest({
    method: "POST",
    body: { formToken: wrongSecretToken },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("8c. CSRF rejects token with wrong secret — returns 403", raw.statusCode === 403);
}

// ── 9. CSRF skips noAuth routes ─────────────────────────────────

console.log("\n-- Route flags --");

{
  const req = mockRequest({
    method: "POST",
    route: { noAuth: true },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("9. CSRF skips noAuth routes", raw.statusCode === 200);
}

// ── 10. CSRF skips Bearer auth requests ─────────────────────────

{
  const bearerToken = createToken({ userId: 1 }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    headers: { authorization: `Bearer ${bearerToken}` },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("10. CSRF skips Bearer auth requests", raw.statusCode === 200);
}

// ── 11. CSRF rejects token with wrong session_id — returns 403 ─

console.log("\n-- Session binding --");

{
  const token = createToken({ csrf: true, session_id: "session-abc" }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    body: { formToken: token },
    session: { session_id: "session-xyz" },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("11. CSRF rejects token with wrong session_id — returns 403", raw.statusCode === 403);
}

// ── 12. CSRF accepts token with matching session_id ─────────────

{
  const token = createToken({ csrf: true, session_id: "session-match" }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    body: { formToken: token },
    session: { session_id: "session-match" },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("12. CSRF accepts token with matching session_id", raw.statusCode === 200);
}

// ── Summary ─────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
