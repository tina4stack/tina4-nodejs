/**
 * Unit tests for Auth module (JWT, password hashing, middleware).
 * Run with: npx tsx test/auth.test.ts
 */
import {
  generateToken, verifyToken, decodeToken,
  hashPassword, verifyPassword,
  authMiddleware,
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

console.log("=== Auth Tests ===\n");

// ── JWT HS256 ─────────────────────────────────────────────────────

console.log("-- JWT HS256 --");

const token1 = generateToken({ userId: 42, role: "admin" }, SECRET, 3600, "HS256");
assert("generateToken returns a string", typeof token1 === "string");
assert("JWT has 3 parts", token1.split(".").length === 3);

const payload1 = verifyToken(token1, SECRET, "HS256");
assert("verifyToken returns payload", payload1 !== null);
assert("payload contains userId", payload1?.userId === 42);
assert("payload contains role", payload1?.role === "admin");
assert("payload contains iat", typeof payload1?.iat === "number");
assert("payload contains exp", typeof payload1?.exp === "number");

// Standard claims
const token2 = generateToken({ sub: "user:1", iss: "tina4" }, SECRET);
const payload2 = verifyToken(token2, SECRET);
assert("sub claim preserved", payload2?.sub === "user:1");
assert("iss claim preserved", payload2?.iss === "tina4");

// ── JWT Expiration ────────────────────────────────────────────────

console.log("\n-- JWT Expiration --");

const expiredToken = generateToken({ userId: 1 }, SECRET, -1); // already expired
const expiredPayload = verifyToken(expiredToken, SECRET);
assert("Expired token returns null", expiredPayload === null);

// Token with no expiry (expiresIn = 0)
const noExpToken = generateToken({ userId: 1 }, SECRET, 0);
const noExpPayload = verifyToken(noExpToken, SECRET);
assert("Token with expiresIn=0 has no exp claim", noExpPayload !== null && !("exp" in noExpPayload));

// ── JWT Invalid Signature ─────────────────────────────────────────

console.log("\n-- JWT Invalid Signature --");

const badSigPayload = verifyToken(token1, "wrong-secret");
assert("Wrong secret returns null", badSigPayload === null);

const tamperedToken = token1.slice(0, -3) + "abc";
const tamperedPayload = verifyToken(tamperedToken, SECRET);
assert("Tampered token returns null", tamperedPayload === null);

assert("Malformed token returns null", verifyToken("not.a.jwt", SECRET) === null);
assert("Empty string returns null", verifyToken("", SECRET) === null);
assert("Two parts returns null", verifyToken("a.b", SECRET) === null);

// ── JWT Decode (no verification) ──────────────────────────────────

console.log("\n-- JWT Decode --");

const decoded1 = decodeToken(token1);
assert("decodeToken returns payload", decoded1 !== null);
assert("decoded contains userId", decoded1?.userId === 42);

const decodedExpired = decodeToken(expiredToken);
assert("decodeToken ignores expiration", decodedExpired !== null);
assert("decodeToken ignores bad signature", decodeToken(tamperedToken) !== null);
assert("decodeToken returns null for garbage", decodeToken("xxx") === null);

// ── JWT RS256 ─────────────────────────────────────────────────────

console.log("\n-- JWT RS256 --");

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const rsaToken = generateToken({ userId: 99 }, privateKey, 3600, "RS256");
assert("RS256 token generated", typeof rsaToken === "string");

const rsaPayload = verifyToken(rsaToken, publicKey, "RS256");
assert("RS256 token verifies with public key", rsaPayload !== null);
assert("RS256 payload contains userId", rsaPayload?.userId === 99);

const rsaWrongKey = verifyToken(rsaToken, SECRET, "HS256");
assert("RS256 token fails with HS256 verify", rsaWrongKey === null);

// ── Password Hashing ─────────────────────────────────────────────

console.log("\n-- Password Hashing --");

const hash1 = hashPassword("mypassword");
assert("hashPassword returns a string", typeof hash1 === "string");
assert("Hash has 4 colon-separated parts", hash1.split(":").length === 4);
assert("Hash starts with pbkdf2_sha256", hash1.startsWith("pbkdf2_sha256:"));

assert("verifyPassword correct password", verifyPassword("mypassword", hash1) === true);
assert("verifyPassword wrong password", verifyPassword("wrongpassword", hash1) === false);

// Custom salt
const hash2 = hashPassword("test", "abcdef1234567890");
assert("Custom salt is used", hash2.includes("abcdef1234567890"));
assert("Custom salt verifies", verifyPassword("test", hash2) === true);

// Different hashes for same password (random salt)
const hash3 = hashPassword("same");
const hash4 = hashPassword("same");
assert("Different salts produce different hashes", hash3 !== hash4);
assert("Both verify correctly", verifyPassword("same", hash3) && verifyPassword("same", hash4));

// Edge cases
assert("Malformed hash returns false", verifyPassword("test", "invalid") === false);
assert("Empty hash returns false", verifyPassword("test", "") === false);

// ── Auth Middleware ───────────────────────────────────────────────

console.log("\n-- Auth Middleware --");

const mw = authMiddleware(SECRET);

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
  const validToken = generateToken({ userId: 7 }, SECRET);
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
  const expToken = generateToken({ userId: 1 }, SECRET, -1);
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

// ── Summary ───────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
