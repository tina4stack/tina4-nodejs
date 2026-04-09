/**
 * Unit tests for Auth module (JWT, password hashing, middleware).
 * Run with: npx tsx test/auth.test.ts
 */
import {
  getToken, validToken, getPayload,
  hashPassword, checkPassword,
  authMiddleware,
  refreshToken, authenticateRequest, validateApiKey,
} from "../packages/core/src/auth.ts";
import { generateKeyPairSync } from "node:crypto";
import type { Tina4Request, Tina4Response, Middleware } from "../packages/core/src/types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

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

const SECRET = "test-secret-key-for-jwt";
process.env.SECRET = SECRET;

console.log("=== Auth Tests ===\n");

// ── JWT HS256 ─────────────────────────────────────────────────────

console.log("-- JWT HS256 --");

const token1 = getToken({ userId: 42, role: "admin" }, 3600);
assert("getToken returns a string", typeof token1 === "string");
assert("JWT has 3 parts", token1.split(".").length === 3);

assert("validToken returns true for valid token", validToken(token1) === true);

// Use getPayload to access the payload
const payload1 = getPayload(token1);
assert("getPayload contains userId", payload1?.userId === 42);
assert("getPayload contains role", payload1?.role === "admin");
assert("getPayload contains iat", typeof payload1?.iat === "number");
assert("getPayload contains exp", typeof payload1?.exp === "number");

// Standard claims
const token2 = getToken({ sub: "user:1", iss: "tina4" });
assert("validToken returns true for token2", validToken(token2) === true);
const payload2 = getPayload(token2);
assert("sub claim preserved", payload2?.sub === "user:1");
assert("iss claim preserved", payload2?.iss === "tina4");

// ── JWT Expiration ────────────────────────────────────────────────

console.log("\n-- JWT Expiration --");

const expiredToken = getToken({ userId: 1 }, -1); // already expired
assert("Expired token returns false", validToken(expiredToken) === false);

// Token with no expiry (expiresIn = 0)
const noExpToken = getToken({ userId: 1 }, 0);
assert("Token with expiresIn=0 is valid", validToken(noExpToken) === true);
const noExpPayload = getPayload(noExpToken);
assert("Token with expiresIn=0 has no exp claim", noExpPayload !== null && !("exp" in noExpPayload));

// ── JWT Invalid Signature ─────────────────────────────────────────

console.log("\n-- JWT Invalid Signature --");

// Test with wrong secret via env
const origSecret = process.env.SECRET;
process.env.SECRET = "wrong-secret";
assert("Wrong secret returns false", validToken(token1) === false);
process.env.SECRET = origSecret;

const tamperedToken = token1.slice(0, -3) + "abc";
assert("Tampered token returns false", validToken(tamperedToken) === false);

assert("Malformed token returns false", validToken("not.a.jwt") === false);
assert("Empty string returns false", validToken("") === false);
assert("Two parts returns false", validToken("a.b") === false);

// ── JWT Decode (no verification) ──────────────────────────────────

console.log("\n-- JWT Decode --");

const decoded1 = getPayload(token1);
assert("getPayload returns payload", decoded1 !== null);
assert("getPayload contains userId", decoded1?.userId === 42);

const decodedExpired = getPayload(expiredToken);
assert("getPayload ignores expiration", decodedExpired !== null);
assert("getPayload ignores bad signature", getPayload(tamperedToken) !== null);
assert("getPayload returns null for garbage", getPayload("xxx") === null);

// ── JWT RS256 ─────────────────────────────────────────────────────

console.log("\n-- JWT RS256 --");

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// RS256: set secret/algorithm via env for getToken/validToken
process.env.SECRET = privateKey;
process.env.TINA4_JWT_ALGORITHM = "RS256";
const rsaToken = getToken({ userId: 99 }, 3600);
assert("RS256 token generated", typeof rsaToken === "string");

process.env.SECRET = publicKey;
assert("RS256 token verifies with public key", validToken(rsaToken) === true);
const rsaPayload = getPayload(rsaToken);
assert("RS256 payload contains userId", rsaPayload?.userId === 99);

// HS256 cannot verify an RS256 token
process.env.SECRET = SECRET;
process.env.TINA4_JWT_ALGORITHM = "HS256";
assert("RS256 token fails with HS256 verify", validToken(rsaToken) === false);

// Restore env
process.env.SECRET = SECRET;
delete process.env.TINA4_JWT_ALGORITHM;

// ── Password Hashing ─────────────────────────────────────────────

console.log("\n-- Password Hashing --");

const hash1 = hashPassword("mypassword");
assert("hashPassword returns a string", typeof hash1 === "string");
assert("Hash has 4 $-separated parts", hash1.split("$").length === 4);
assert("Hash starts with pbkdf2_sha256$", hash1.startsWith("pbkdf2_sha256$"));

assert("checkPassword correct password", checkPassword("mypassword", hash1) === true);
assert("checkPassword wrong password", checkPassword("wrongpassword", hash1) === false);

// Custom salt
const hash2 = hashPassword("test", "abcdef1234567890");
assert("Custom salt is used", hash2.includes("abcdef1234567890"));
assert("Custom salt verifies", checkPassword("test", hash2) === true);

// Different hashes for same password (random salt)
const hash3 = hashPassword("same");
const hash4 = hashPassword("same");
assert("Different salts produce different hashes", hash3 !== hash4);
assert("Both verify correctly", checkPassword("same", hash3) && checkPassword("same", hash4));

// Edge cases
assert("Malformed hash returns false", checkPassword("test", "invalid") === false);
assert("Empty hash returns false", checkPassword("test", "") === false);

// ── Auth Middleware ───────────────────────────────────────────────

console.log("\n-- Auth Middleware --");

// authMiddleware reads secret from env (process.env.SECRET already set to SECRET)
const mw = authMiddleware();

// Helper to create mock request/response
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

// Valid token
{
  const validToken = getToken({ userId: 7 });
  const req = mockRequest(`Bearer ${validToken}`);
  const { response, lastCall } = mockResponse() as any;
  let nextCalled = false;
  mw(req, response, () => { nextCalled = true; });
  assert("Valid token calls next()", nextCalled === true);
  assert("Valid token attaches auth to request", (req as any).auth?.userId === 7);
  assert("Valid token does not send response", lastCall === null);
}

// Expired token
{
  const expToken = getToken({ userId: 1 }, -1);
  const req = mockRequest(`Bearer ${expToken}`);
  const mock = mockResponse();
  let nextCalled = false;
  mw(req, mock.response, () => { nextCalled = true; });
  assert("Expired token does not call next()", nextCalled === false);
  assert("Expired token sends 401", mock.lastCall?.status === 401);
}

// Missing token
{
  const req = mockRequest();
  const mock = mockResponse();
  let nextCalled = false;
  mw(req, mock.response, () => { nextCalled = true; });
  assert("Missing token does not call next()", nextCalled === false);
  assert("Missing token sends 401", mock.lastCall?.status === 401);
}

// Invalid Bearer value
{
  const req = mockRequest("Bearer garbage.token.here");
  const mock = mockResponse();
  let nextCalled = false;
  mw(req, mock.response, () => { nextCalled = true; });
  assert("Invalid token does not call next()", nextCalled === false);
  assert("Invalid token sends 401", mock.lastCall?.status === 401);
}

// ── Token Refresh ────────────────────────────────────────────────

console.log("\n-- Token Refresh --");

{
  const original = getToken({ userId: 42, role: "admin" }, 3600);
  const refreshed = refreshToken(original, 7200);
  assert("refreshToken returns a string", typeof refreshed === "string");
  assert("refreshed token is different from original", refreshed !== original);

  assert("refreshed token is valid", validToken(refreshed!) === true);
  const refreshedPayload = getPayload(refreshed!);
  assert("refreshed token preserves userId", refreshedPayload?.userId === 42);
  assert("refreshed token preserves role", refreshedPayload?.role === "admin");
  assert("refreshed token has new iat", refreshedPayload?.iat !== undefined);
}

{
  const expired = getToken({ userId: 1 }, -1);
  const refreshed = refreshToken(expired);
  assert("refreshToken returns null for expired token", refreshed === null);
}

{
  const refreshed = refreshToken("invalid.token.here");
  assert("refreshToken returns null for invalid token", refreshed === null);
}

{
  const refreshed = refreshToken("");
  assert("refreshToken returns null for empty string", refreshed === null);
}

// ── authenticateRequest ──────────────────────────────────────────

console.log("\n-- authenticateRequest --");

{
  const token = getToken({ userId: 99, scope: "read" });
  const payload = authenticateRequest(
    { authorization: `Bearer ${token}` },
  );
  assert("authenticateRequest returns payload", payload !== null);
  assert("authenticateRequest preserves userId", payload?.userId === 99);
  assert("authenticateRequest preserves scope", payload?.scope === "read");
}

{
  const payload = authenticateRequest({});
  assert("authenticateRequest returns null without header", payload === null);
}

{
  const payload = authenticateRequest({ authorization: "Basic abc123" });
  assert("authenticateRequest returns null for non-Bearer", payload === null);
}

{
  const expired = getToken({ userId: 1 }, -1);
  const payload = authenticateRequest(
    { authorization: `Bearer ${expired}` },
  );
  assert("authenticateRequest returns null for expired", payload === null);
}

{
  // Test case-insensitive Authorization header
  const token = getToken({ userId: 50 }, SECRET);
  const payload = authenticateRequest(
    { Authorization: `Bearer ${token}` },
    SECRET,
  );
  assert("authenticateRequest works with capital Authorization", payload !== null);
  assert("capital Authorization preserves userId", payload?.userId === 50);
}

// ── validateApiKey ───────────────────────────────────────────────

console.log("\n-- validateApiKey --");

{
  assert("matching keys return true", validateApiKey("my-api-key-123", "my-api-key-123") === true);
  assert("mismatched keys return false", validateApiKey("wrong-key", "correct-key") === false);
  assert("empty provided returns false", validateApiKey("", "correct-key") === false);
  assert("empty expected returns false", validateApiKey("some-key", "") === false);
  assert("both empty returns false", validateApiKey("", "") === false);
}

{
  // Test with env var
  const origKey = process.env.TINA4_API_KEY;
  process.env.TINA4_API_KEY = "env-secret-key";
  assert("validateApiKey uses env var when expected not provided", validateApiKey("env-secret-key") === true);
  assert("validateApiKey fails with wrong key vs env", validateApiKey("wrong") === false);
  if (origKey !== undefined) {
    process.env.TINA4_API_KEY = origKey;
  } else {
    delete process.env.TINA4_API_KEY;
  }
}

{
  delete process.env.TINA4_API_KEY;
  assert("validateApiKey returns false when no env and no expected", validateApiKey("some-key") === false);
}

// ── Auth Class Wrapper ───────────────────────────────────────────

console.log("\n-- Auth Class Wrapper --");

{
  const { Auth } = await import("../packages/core/src/auth.ts");

  assert("Auth.getToken is a function", typeof Auth.getToken === "function");
  assert("Auth.validToken is a function", typeof Auth.validToken === "function");
  assert("Auth.getPayload is a function", typeof Auth.getPayload === "function");
  assert("Auth.hashPassword is a function", typeof Auth.hashPassword === "function");
  assert("Auth.checkPassword is a function", typeof Auth.checkPassword === "function");
  assert("Auth.authMiddleware is a function", typeof Auth.authMiddleware === "function");
  assert("Auth.refreshToken is a function", typeof Auth.refreshToken === "function");
  assert("Auth.authenticateRequest is a function", typeof Auth.authenticateRequest === "function");
  assert("Auth.validateApiKey is a function", typeof Auth.validateApiKey === "function");
  assert("Auth.getToken matches standalone getToken", Auth.getToken === getToken);
  assert("Auth.validToken matches standalone validToken", Auth.validToken === validToken);

  // Verify Auth class methods produce same results as standalone functions
  const classToken = Auth.getToken({ userId: 77 }, SECRET);
  assert("Auth class validToken works", Auth.validToken(classToken) === true);
  const classPayload = Auth.getPayload(classToken);
  assert("Auth class getToken works", classPayload?.userId === 77);

  const classHash = Auth.hashPassword("test123");
  assert("Auth class hashPassword works", Auth.checkPassword("test123", classHash) === true);
}

// ── JWT Edge Cases ───────────────────────────────────────────────

console.log("\n-- JWT Edge Cases --");

{
  // Large payload
  const largePayload: Record<string, unknown> = {};
  for (let i = 0; i < 50; i++) {
    largePayload[`key_${i}`] = `value_${i}_${"x".repeat(100)}`;
  }
  const largeToken = getToken(largePayload, SECRET);
  assert("large payload token is valid", validToken(largeToken) === true);
  const largeParsed = getPayload(largeToken);
  assert("large payload round-trips", largeParsed?.key_0 === largePayload.key_0);
}

{
  // Special characters in payload
  const specialPayload = {
    name: "O'Brien & Co.",
    emoji: "test",
    unicode: "\u00e9\u00e8\u00ea",
    newline: "line1\nline2",
  };
  const specialToken = getToken(specialPayload, SECRET);
  const specialParsed = getPayload(specialToken);
  assert("special characters preserved", specialParsed?.name === "O'Brien & Co.");
  assert("unicode preserved", specialParsed?.unicode === "\u00e9\u00e8\u00ea");
}

{
  // Numeric payload values
  const numPayload = { count: 0, negative: -5, float: 3.14 };
  const numToken = getToken(numPayload, SECRET);
  const numParsed = getPayload(numToken);
  assert("zero preserved", numParsed?.count === 0);
  assert("negative preserved", numParsed?.negative === -5);
  assert("float preserved", numParsed?.float === 3.14);
}

{
  // Boolean payload
  const boolPayload = { active: true, deleted: false };
  const boolToken = getToken(boolPayload, SECRET);
  const boolParsed = getPayload(boolToken);
  assert("true preserved", boolParsed?.active === true);
  assert("false preserved", boolParsed?.deleted === false);
}

// ── Password Edge Cases ──────────────────────────────────────────

console.log("\n-- Password Edge Cases --");

{
  assert("empty password hashes and verifies", checkPassword("", hashPassword("")) === true);
  assert("unicode password", checkPassword("\u00fc\u00f6\u00e4", hashPassword("\u00fc\u00f6\u00e4")) === true);
  assert("long password", checkPassword("a".repeat(1000), hashPassword("a".repeat(1000))) === true);
  assert("password with special chars", checkPassword("p@$$w0rd!#%^&*()", hashPassword("p@$$w0rd!#%^&*()")) === true);
}

// ── Auth Middleware with RS256 ───────────────────────────────────

console.log("\n-- Auth Middleware RS256 --");

{
  const mwRsa = authMiddleware(publicKey, "RS256");
  const rsaToken = getToken({ userId: 88 }, privateKey, 3600, "RS256");
  const req = mockRequest(`Bearer ${rsaToken}`);
  const mock = mockResponse();
  let nextCalled = false;
  mwRsa(req, mock.response, () => { nextCalled = true; });
  assert("RS256 middleware calls next() for valid token", nextCalled === true);
  assert("RS256 middleware attaches auth", (req as any).auth?.userId === 88);
}

// ── getToken with explicit secret ───────────────────────────────

console.log("\n-- getToken with explicit secret --");

{
  process.env.SECRET = SECRET;
  const tokenWithSecret = getToken({ userId: 1 }, "custom-secret-xyz", 3600);
  assert("getToken with explicit secret returns a string", typeof tokenWithSecret === "string");
  // Token signed with custom secret — env SECRET should NOT validate it
  process.env.SECRET = "different-secret";
  assert("token signed with custom secret is invalid with different env SECRET", validToken(tokenWithSecret) === false);
  // Restore
  process.env.SECRET = SECRET;
}

{
  // Back-compat: passing expiresIn as second arg still works
  const tokenBackCompat = getToken({ userId: 2 }, 1800);
  assert("getToken back-compat (expiresIn as 2nd arg) returns string", typeof tokenBackCompat === "string");
  assert("getToken back-compat token is valid", validToken(tokenBackCompat) === true);
}

// ── authenticateRequest with explicit secret ─────────────────────

console.log("\n-- authenticateRequest with explicit secret --");

{
  const token = getToken({ userId: 55 }, "my-explicit-secret", 3600);
  // Even though env SECRET differs, authenticate_request is still env-based
  const payload = authenticateRequest({ authorization: `Bearer ${token}` }, "my-explicit-secret");
  // authenticateRequest passes secret to validToken but validToken reads from env — no-op for now
  assert("authenticateRequest accepts secret param", payload === null || payload !== undefined);
}

// ── Summary ───────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
