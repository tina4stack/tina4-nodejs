/**
 * Behavioural tests for CsrfMiddleware (class-based before/after convention).
 * Run with: npx tsx test/csrfMiddleware.test.ts
 *
 * Port of tina4-python/tests/test_csrf_middleware.py. NO MOCKS of the security-
 * relevant collaborators: real HS256 (getToken/validToken/getPayload), real
 * Frond token generation ({{ form_token_value() }} -> _buildFormTokenJwt), real
 * global-middleware registry (MiddlewareRunner). The req is a plain value
 * carrier (as the Python test builds a scope) and res is a callable that
 * captures the status/body exactly as the real Response's call contract does.
 *
 * Tina4 CSRF convention (feature 37):
 *   - GET/HEAD/OPTIONS are skipped (safe methods)
 *   - POST/PUT/PATCH/DELETE require a valid formToken whose type claim is "form"
 *   - Token accepted in request.body.formToken or X-Form-Token header
 *   - Token rejected if sent in query params (security risk)
 *   - Routes marked noAuth skip CSRF
 *   - Requests with a valid Authorization: Bearer skip CSRF
 *   - Session binding: token session_id must match request session
 *   - Fails CLOSED: TINA4_SECRET unset (blank secret) => every write 403
 *   - TINA4_CSRF=false/0/no disables all checks (kill switch once attached)
 *   - Every rejection is 403 { error:true, code:"CSRF_INVALID", message, status:403 }
 */
import {
  CsrfMiddleware,
  MiddlewareRunner,
  attachCsrfFromEnv,
} from "../packages/core/src/middleware.ts";
import { getToken } from "../packages/core/src/auth.ts";
import { Frond, setFormTokenSessionId } from "../packages/frond/src/engine.ts";
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
process.env.TINA4_SECRET = SECRET;

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

/**
 * A REAL, correctly-signed form token: type="form" JWT signed with the current
 * TINA4_SECRET via the real getToken (HS256). Mirrors Python's _make_form_token.
 */
function makeFormToken(extraClaims?: Record<string, unknown>): string {
  return getToken({ type: "form", ...(extraClaims ?? {}) }, 60);
}

/** Enforcement on, secret configured. */
function csrfOn() {
  process.env.TINA4_CSRF = "true";
  process.env.TINA4_SECRET = SECRET;
}

/** Enforcement on, TINA4_SECRET UNSET — the fail-closed / SEC-01 state. */
function csrfNoSecret() {
  process.env.TINA4_CSRF = "true";
  delete process.env.TINA4_SECRET;
}

function cleanEnv() {
  delete process.env.TINA4_CSRF;
  delete process.env.TINA4_SECRET;
}

/**
 * Save the REAL global-middleware registry, run fn with CsrfMiddleware removed
 * from it, then restore — so the attach tests observe the true registry without
 * leaking state. Uses only the public MiddlewareRunner API (getGlobal/reset/use).
 */
function withSavedRegistry(fn: () => void) {
  const saved = MiddlewareRunner.getGlobal();
  try {
    MiddlewareRunner.reset();
    for (const m of saved) if (m !== CsrfMiddleware) MiddlewareRunner.use(m);
    fn();
  } finally {
    MiddlewareRunner.reset();
    for (const m of saved) MiddlewareRunner.use(m);
  }
}

console.log("=== CSRF Middleware Tests ===\n");

// ── Safe methods are skipped ────────────────────────────────────

console.log("-- Safe method skipping --");

{
  csrfOn();
  const req = mockRequest({ method: "GET" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("GET passes without token", raw.statusCode === 200);
}

{
  csrfOn();
  const req = mockRequest({ method: "HEAD" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("HEAD passes without token", raw.statusCode === 200);
}

{
  csrfOn();
  const req = mockRequest({ method: "OPTIONS" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("OPTIONS passes without token", raw.statusCode === 200);
}

// ── POST/PUT/DELETE without token are blocked ────────────────────

console.log("\n-- Token enforcement (no token = 403) --");

{
  csrfOn();
  const req = mockRequest({ method: "POST" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("POST without token returns 403", raw.statusCode === 403);
}

{
  csrfOn();
  const req = mockRequest({ method: "PUT" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("PUT without token returns 403", raw.statusCode === 403);
}

{
  csrfOn();
  const req = mockRequest({ method: "DELETE" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("DELETE without token returns 403", raw.statusCode === 403);
}

// ── Token accepted in body ───────────────────────────────────────

console.log("\n-- Body token --");

{
  csrfOn();
  const req = mockRequest({ method: "POST", body: { formToken: makeFormToken() } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("POST with valid body token passes", raw.statusCode === 200);
}

{
  csrfOn();
  const req = mockRequest({ method: "PUT", body: { formToken: makeFormToken() } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("PUT with valid body token passes", raw.statusCode === 200);
}

// ── Token accepted in X-Form-Token header ────────────────────────

console.log("\n-- Header token --");

{
  csrfOn();
  const req = mockRequest({ method: "POST", headers: { "x-form-token": makeFormToken() } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("POST with valid header token passes", raw.statusCode === 200);
}

{
  csrfOn();
  const req = mockRequest({
    method: "POST",
    body: {},
    headers: { "x-form-token": makeFormToken() },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Header takes precedence when body has no formToken", raw.statusCode === 200);
}

// ── Header precedence over body ──────────────────────────────────

console.log("\n-- Header precedence over body --");

{
  csrfOn();
  const req = mockRequest({
    method: "POST",
    body: { formToken: "not.a.valid.token" },
    headers: { "x-form-token": makeFormToken() },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  // Body token is checked first; an invalid body token loses to nothing — it is
  // used and fails (403), documenting the body-before-header precedence.
  assert("Body formToken checked before header (body invalid = 403)", raw.statusCode === 403);
}

{
  csrfOn();
  const req = mockRequest({
    method: "POST",
    body: { formToken: makeFormToken() },
    headers: { "x-form-token": makeFormToken() },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Both body and header valid passes", raw.statusCode === 200);
}

// ── Token rejected in query params ───────────────────────────────

console.log("\n-- Query param rejection --");

{
  csrfOn();
  const req = mockRequest({ method: "POST", query: { formToken: makeFormToken() } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("POST with query param token returns 403", raw.statusCode === 403);
}

{
  csrfOn();
  const req = mockRequest({ method: "POST", query: { formToken: makeFormToken() } });
  const { res, state } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  const msg = ((state.lastData as any)?.message ?? "").toLowerCase();
  assert("Query param rejection message mentions query string", msg.includes("query string"));
}

// ── Malformed / expired / wrong-secret tokens ────────────────────

console.log("\n-- Invalid tokens --");

{
  csrfOn();
  const req = mockRequest({ method: "POST", body: { formToken: "not.a.valid.token" } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Malformed token returns 403", raw.statusCode === 403);
}

{
  csrfOn();
  const expiredToken = getToken({ type: "form" }, -1); // expired 1 minute ago
  const req = mockRequest({ method: "POST", body: { formToken: expiredToken } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Expired token returns 403", raw.statusCode === 403);
}

{
  csrfOn();
  process.env.TINA4_SECRET = "wrong-secret";
  const wrongSecretToken = getToken({ type: "form" }, 60);
  process.env.TINA4_SECRET = SECRET;
  const req = mockRequest({ method: "POST", body: { formToken: wrongSecretToken } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Wrong-secret token returns 403", raw.statusCode === 403);
}

// ── noAuth handler skips CSRF ────────────────────────────────────

console.log("\n-- noAuth route flag --");

{
  csrfOn();
  const req = mockRequest({ method: "POST", route: { noAuth: true } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("noAuth handler skips CSRF", raw.statusCode === 200);
}

{
  csrfOn();
  const req = mockRequest({ method: "POST", route: { noAuth: false } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Handler without noAuth requires CSRF (403)", raw.statusCode === 403);
}

// ── Valid Bearer JWT skips CSRF ───────────────────────────────────

console.log("\n-- Bearer auth skip --");

{
  csrfOn();
  const bearerToken = getToken({ userId: 1 }, 60);
  const req = mockRequest({ method: "POST", headers: { authorization: `Bearer ${bearerToken}` } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Valid Bearer JWT skips CSRF", raw.statusCode === 200);
}

{
  csrfOn();
  const req = mockRequest({ method: "POST", headers: { authorization: "Bearer invalid-token" } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Invalid Bearer does not skip CSRF (403)", raw.statusCode === 403);
}

// ── Session ID matching ──────────────────────────────────────────

console.log("\n-- Session binding --");

{
  csrfOn();
  const token = makeFormToken({ session_id: "session-abc" });
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
  csrfOn();
  const token = makeFormToken({ session_id: "session-match" });
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
  csrfOn();
  const token = makeFormToken();
  const req = mockRequest({ method: "POST", body: { formToken: token } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("Token without session_id claim skips session check (passes)", raw.statusCode === 200);
}

// ── CSRF disabled via env vars ───────────────────────────────────

console.log("\n-- CSRF env toggle --");

{
  process.env.TINA4_CSRF = "false";
  process.env.TINA4_SECRET = SECRET;
  const req = mockRequest({ method: "POST" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("TINA4_CSRF=false disables CSRF (POST passes without token)", raw.statusCode === 200);
}

{
  process.env.TINA4_CSRF = "0";
  process.env.TINA4_SECRET = SECRET;
  const req = mockRequest({ method: "POST" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("TINA4_CSRF=0 disables CSRF (POST passes without token)", raw.statusCode === 200);
}

{
  process.env.TINA4_CSRF = "no";
  process.env.TINA4_SECRET = SECRET;
  const req = mockRequest({ method: "POST" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("TINA4_CSRF=no disables CSRF (POST passes without token)", raw.statusCode === 200);
}

{
  process.env.TINA4_CSRF = "true";
  process.env.TINA4_SECRET = SECRET;
  const req = mockRequest({ method: "POST" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("TINA4_CSRF=true keeps CSRF active (POST without token = 403)", raw.statusCode === 403);
}

{
  delete process.env.TINA4_CSRF;
  process.env.TINA4_SECRET = SECRET;
  const req = mockRequest({ method: "POST" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  // Without env set, CSRF is active (not in the false/0/no list)
  assert("Without TINA4_CSRF env, CSRF defaults to active (403)", raw.statusCode === 403);
}

// ── Error response envelope (4-key CSRF_INVALID shape) ────────────

console.log("\n-- Error response structure --");

{
  csrfOn();
  const req = mockRequest({ method: "POST" });
  const { res, state } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  const body = state.lastData as any;
  assert("403 body has error:true", body?.error === true);
}

{
  csrfOn();
  const req = mockRequest({ method: "POST" });
  const { res, state } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  const body = state.lastData as any;
  assert("403 body has code CSRF_INVALID", body?.code === "CSRF_INVALID");
}

{
  csrfOn();
  const req = mockRequest({ method: "POST" });
  const { res, state } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("403 response has message field", typeof (state.lastData as any)?.message === "string");
}

{
  csrfOn();
  const req = mockRequest({ method: "POST" });
  const { res, raw, state } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  const body = state.lastData as any;
  assert("403 body carries status 403 and raw statusCode 403", body?.status === 403 && raw.statusCode === 403);
}

// ── Cross-framework conformance: the csrf_contract.json invariants ─────
//
// Each assert label below matches a `case` in
// tina4-documentation/plan/v3/fixtures/csrf_contract.json verbatim, so the
// shared auditor credits this suite. The SAME case names appear in the Python,
// PHP and Ruby CSRF suites — Python is the reference. Real HS256, real Frond
// generation, real global-middleware registry; no mocks of those collaborators.

console.log("\n-- Conformance (csrf_contract.json) --");

// csrf-no-default-secret (SEC-01 / CSRF-DEC-01): TINA4_SECRET unset => fail closed.
{
  csrfNoSecret();
  // A formToken forged with the RETIRED public 'tina4-default-secret'.
  const forged = getToken({ type: "form" }, "tina4-default-secret");
  const req = mockRequest({ method: "POST", body: { formToken: forged } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("forged default secret token is rejected", raw.statusCode === 403);
}

{
  csrfNoSecret();
  // A formToken forged with the BLANK '' key (publicly reproducible).
  const forged = getToken({ type: "form" }, "");
  const req = mockRequest({ method: "POST", body: { formToken: forged } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("forged blank secret token is rejected", raw.statusCode === 403);
}

// csrf-frond-token-validates: a REAL Frond-generated token passes (generator and
// validator resolve the SAME secret).
{
  csrfOn();
  setFormTokenSessionId(""); // no session binding
  const token = String(new Frond().renderString("{{ form_token_value() }}", {})).trim();
  const req = mockRequest({ method: "POST", body: { formToken: token } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("a frond emitted form token passes csrf", raw.statusCode === 200);
}

// csrf-type-must-be-form: a validly-signed but non-form JWT is rejected.
{
  csrfOn();
  const authJwt = getToken({ user_id: 1 }, 60); // valid signature, no type:"form"
  const req = mockRequest({ method: "POST", body: { formToken: authJwt } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("a non form jwt in the form token slot is rejected", raw.statusCode === 403);
}

// csrf-session-binding: a token minted for one session cannot be replayed on another.
{
  csrfOn();
  const token = makeFormToken({ session_id: "session-A" });
  const req = mockRequest({
    method: "POST",
    body: { formToken: token },
    session: { session_id: "session-B" },
  });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("a token bound to a foreign session is rejected", raw.statusCode === 403);
}

// csrf-safe-methods-skipped
{
  csrfOn();
  const req = mockRequest({ method: "GET" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("a safe get request skips csrf", raw.statusCode === 200);
}

// csrf-write-methods-gated
{
  csrfOn();
  const req = mockRequest({ method: "POST" });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("a post without a token is rejected", raw.statusCode === 403);
}

// csrf-noauth-exempt
{
  csrfOn();
  const req = mockRequest({ method: "POST", route: { noAuth: true } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("a noauth write route skips csrf", raw.statusCode === 200);
}

// csrf-bearer-exempt
{
  csrfOn();
  const bearer = getToken({ user_id: 1 }, 60);
  const req = mockRequest({ method: "POST", headers: { authorization: `Bearer ${bearer}` } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("a valid bearer token skips csrf", raw.statusCode === 200);
}

// csrf-query-token-rejected
{
  csrfOn();
  const token = makeFormToken();
  const req = mockRequest({ method: "POST", query: { formToken: token } });
  const { res, raw } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  assert("a form token in the query string is rejected", raw.statusCode === 403);
}

// csrf-env-attach: OFF by default; TINA4_CSRF=true attaches at boot.
{
  delete process.env.TINA4_CSRF;
  withSavedRegistry(() => {
    const attached = attachCsrfFromEnv();
    assert(
      "csrf is off by default",
      attached === false && !MiddlewareRunner.getGlobal().includes(CsrfMiddleware),
    );
  });
}

{
  process.env.TINA4_CSRF = "true";
  withSavedRegistry(() => {
    const attached = attachCsrfFromEnv();
    assert(
      "csrf true attaches the middleware",
      attached === true && MiddlewareRunner.getGlobal().includes(CsrfMiddleware),
    );
  });
}

// csrf-403-envelope
{
  csrfOn();
  const req = mockRequest({ method: "POST" });
  const { res, raw, state } = mockResponse();
  CsrfMiddleware.beforeCsrf(req, res);
  const body = state.lastData as any;
  assert(
    "the rejection body is the csrf invalid envelope",
    raw.statusCode === 403 && body?.error === true && body?.code === "CSRF_INVALID" && body?.status === 403,
  );
}

// ── Cleanup ──────────────────────────────────────────────────────

cleanEnv();

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
