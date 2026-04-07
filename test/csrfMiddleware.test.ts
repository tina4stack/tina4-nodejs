/**
 * Unit tests for CsrfMiddleware (class-based before/after convention).
 * Run with: npx tsx test/csrfMiddleware.test.ts
 *
 * Port of tina4-python/tests/test_csrf_middleware.py (29 tests).
 *
 * Tina4 CSRF convention:
 *   - GET/HEAD/OPTIONS are skipped (safe methods)
 *   - POST/PUT/PATCH/DELETE require a valid formToken
 *   - Token accepted in request.body.formToken or X-Form-Token header
 *   - Token rejected if sent in query params (security risk)
 *   - Routes marked noAuth skip CSRF
 *   - Requests with valid Authorization: Bearer skip CSRF
 *   - Session binding: token session_id must match request session
 *   - TINA4_CSRF=false/0/no disables all checks
 */
import { CsrfMiddleware } from "../packages/core/src/middleware.ts";
import { getToken, validToken } from "../packages/core/src/auth.ts";
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

/** Helper: ensure env is set before each logical test group */
function setupEnv() {
  process.env.TINA4_CSRF = "true";
  process.env.SECRET = SECRET;
}

function cleanEnv() {
  delete process.env.TINA4_CSRF;
  delete process.env.SECRET;
}

console.log("=== CSRF Middleware Tests ===\n");

// ── Safe methods are skipped ────────────────────────────────────

console.log("-- Safe method skipping --");

{
  setupEnv();
  const req = mockRequest({ method: "GET" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("GET passes without token", raw.statusCode === 200);
}

{
  setupEnv();
  const req = mockRequest({ method: "HEAD" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("HEAD passes without token", raw.statusCode === 200);
}

{
  setupEnv();
  const req = mockRequest({ method: "OPTIONS" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("OPTIONS passes without token", raw.statusCode === 200);
}

// ── POST/PUT/DELETE without token are blocked ────────────────────

console.log("\n-- Token enforcement (no token = 403) --");

{
  setupEnv();
  const req = mockRequest({ method: "POST" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("POST without token returns 403", raw.statusCode === 403);
}

{
  setupEnv();
  const req = mockRequest({ method: "PUT" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("PUT without token returns 403", raw.statusCode === 403);
}

{
  setupEnv();
  const req = mockRequest({ method: "DELETE" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("DELETE without token returns 403", raw.statusCode === 403);
}

// ── Token accepted in body ───────────────────────────────────────

console.log("\n-- Body token --");

{
  setupEnv();
  const token = getToken({ csrf: true }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    body: { formToken: token },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("POST with valid body token passes", raw.statusCode === 200);
}

{
  setupEnv();
  const token = getToken({ csrf: true }, SECRET, 3600);
  const req = mockRequest({
    method: "PUT",
    body: { formToken: token },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("PUT with valid body token passes", raw.statusCode === 200);
}

// ── Token accepted in X-Form-Token header ────────────────────────

console.log("\n-- Header token --");

{
  setupEnv();
  const token = getToken({ csrf: true }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    headers: { "x-form-token": token },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("POST with valid header token passes", raw.statusCode === 200);
}

{
  setupEnv();
  const token = getToken({ csrf: true }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    body: {},
    headers: { "x-form-token": token },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Header takes precedence when body has no formToken", raw.statusCode === 200);
}

// ── Header precedence over body ──────────────────────────────────

console.log("\n-- Header precedence over body --");

{
  setupEnv();
  const validHeaderToken = getToken({ csrf: true }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    body: { formToken: "not.a.valid.token" },
    headers: { "x-form-token": validHeaderToken },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  // Body token is checked first in the implementation; if body has formToken it uses that.
  // So with invalid body token + valid header, body wins (403).
  // This documents actual behaviour.
  assert("Body formToken checked before header (body invalid = 403)", raw.statusCode === 403);
}

{
  setupEnv();
  const validBodyToken = getToken({ csrf: true }, SECRET, 3600);
  const validHeaderToken = getToken({ csrf: true }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    body: { formToken: validBodyToken },
    headers: { "x-form-token": validHeaderToken },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Both body and header valid passes", raw.statusCode === 200);
}

// ── Token rejected in query params ───────────────────────────────

console.log("\n-- Query param rejection --");

{
  setupEnv();
  const token = getToken({ csrf: true }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    query: { formToken: token },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("POST with query param token returns 403", raw.statusCode === 403);
}

{
  setupEnv();
  const token = getToken({ csrf: true }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    query: { formToken: token },
  });
  const { res, raw, state } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  const msg = ((state.lastData as any)?.message ?? "").toLowerCase();
  assert("Query param rejection message mentions query string", msg.includes("query string"));
}

// ── Malformed / expired / wrong-secret tokens ────────────────────

console.log("\n-- Invalid tokens --");

{
  setupEnv();
  const req = mockRequest({
    method: "POST",
    body: { formToken: "not.a.valid.token" },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Malformed token returns 403", raw.statusCode === 403);
}

{
  setupEnv();
  const expiredToken = getToken({ csrf: true }, SECRET, -1);
  const req = mockRequest({
    method: "POST",
    body: { formToken: expiredToken },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Expired token returns 403", raw.statusCode === 403);
}

{
  setupEnv();
  const wrongSecretToken = getToken({ csrf: true }, "wrong-secret", 3600);
  const req = mockRequest({
    method: "POST",
    body: { formToken: wrongSecretToken },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Wrong-secret token returns 403", raw.statusCode === 403);
}

// ── noAuth handler skips CSRF ────────────────────────────────────

console.log("\n-- noAuth route flag --");

{
  setupEnv();
  const req = mockRequest({
    method: "POST",
    route: { noAuth: true },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("noAuth handler skips CSRF", raw.statusCode === 200);
}

{
  setupEnv();
  const req = mockRequest({
    method: "POST",
    route: { noAuth: false },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Handler without noAuth requires CSRF (403)", raw.statusCode === 403);
}

// ── Valid Bearer JWT skips CSRF ───────────────────────────────────

console.log("\n-- Bearer auth skip --");

{
  setupEnv();
  const bearerToken = getToken({ userId: 1 }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    headers: { authorization: `Bearer ${bearerToken}` },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Valid Bearer JWT skips CSRF", raw.statusCode === 200);
}

{
  setupEnv();
  const req = mockRequest({
    method: "POST",
    headers: { authorization: "Bearer invalid-token" },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Invalid Bearer does not skip CSRF (403)", raw.statusCode === 403);
}

// ── Session ID matching ──────────────────────────────────────────

console.log("\n-- Session binding --");

{
  setupEnv();
  const token = getToken({ csrf: true, session_id: "session-abc" }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    body: { formToken: token },
    session: { session_id: "session-xyz" },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Token with wrong session_id returns 403", raw.statusCode === 403);
}

{
  setupEnv();
  const token = getToken({ csrf: true, session_id: "session-match" }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    body: { formToken: token },
    session: { session_id: "session-match" },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Token with matching session_id passes", raw.statusCode === 200);
}

{
  setupEnv();
  const token = getToken({ csrf: true }, SECRET, 3600);
  const req = mockRequest({
    method: "POST",
    body: { formToken: token },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Token without session_id claim skips session check (passes)", raw.statusCode === 200);
}

// ── CSRF disabled via env vars ───────────────────────────────────

console.log("\n-- CSRF env toggle --");

{
  process.env.TINA4_CSRF = "false";
  process.env.SECRET = SECRET;
  const req = mockRequest({ method: "POST" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("TINA4_CSRF=false disables CSRF (POST passes without token)", raw.statusCode === 200);
}

{
  process.env.TINA4_CSRF = "0";
  process.env.SECRET = SECRET;
  const req = mockRequest({ method: "POST" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("TINA4_CSRF=0 disables CSRF (POST passes without token)", raw.statusCode === 200);
}

{
  process.env.TINA4_CSRF = "no";
  process.env.SECRET = SECRET;
  const req = mockRequest({ method: "POST" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("TINA4_CSRF=no disables CSRF (POST passes without token)", raw.statusCode === 200);
}

{
  process.env.TINA4_CSRF = "true";
  process.env.SECRET = SECRET;
  const req = mockRequest({ method: "POST" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("TINA4_CSRF=true keeps CSRF active (POST without token = 403)", raw.statusCode === 403);
}

{
  delete process.env.TINA4_CSRF;
  process.env.SECRET = SECRET;
  const req = mockRequest({ method: "POST" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  // Without env set, CSRF is active (not in the false/0/no list)
  assert("Without TINA4_CSRF env, CSRF defaults to active (403)", raw.statusCode === 403);
}

// ── Error response envelope ──────────────────────────────────────

console.log("\n-- Error response structure --");

{
  setupEnv();
  const req = mockRequest({ method: "POST" });
  const { res, raw, state } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("403 response has error field", (state.lastData as any)?.error === "CSRF_INVALID");
}

{
  setupEnv();
  const req = mockRequest({ method: "POST" });
  const { res, raw, state } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("403 response has message field", typeof (state.lastData as any)?.message === "string");
}

{
  setupEnv();
  const req = mockRequest({ method: "POST" });
  const { res, raw, state } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("403 response status code is set on raw", raw.statusCode === 403);
}

// ── Cleanup ──────────────────────────────────────────────────────

cleanEnv();

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
