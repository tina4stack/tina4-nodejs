/**
 * Regression tests for the JWT algorithm/nbf cluster (nodejs#39, mirroring the
 * Python master's python#105/#106/#107 — tests/test_auth_jwt_algorithm_nbf.py).
 *
 * Each test is named for the behaviour it pins and carries a positive AND a
 * negative case, so reverting a fix reproduces the original bug rather than
 * silently passing. No doubles anywhere: these exercise the real auth functions
 * against real node:crypto HMAC digests and a real RSA key pair.
 *
 * Run with: npx tsx test/authJwtAlgorithmNbf.test.ts
 */
import { createHmac, generateKeyPairSync } from "node:crypto";
import {
  getToken,
  validToken,
  getPayload,
  authMiddleware,
  JWT_LEEWAY_SECONDS,
  resolveAlgorithm,
} from "../packages/core/src/auth.ts";
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

/** Assert that `fn` throws, and hand the message to a predicate. */
function assertThrows(label: string, fn: () => unknown, messageCheck: (message: string) => boolean) {
  try {
    fn();
    assert(label, false);
  } catch (error) {
    assert(label, messageCheck(error instanceof Error ? error.message : String(error)));
  }
}

const SECRET = "jwt-cluster-regression-secret";
const HMAC_ALGORITHMS = ["HS256", "HS384", "HS512"] as const;
/** node:crypto digest name + digest SIZE IN BYTES for each HMAC algorithm. */
const DIGEST_FOR: Record<string, { digest: string; bytes: number }> = {
  HS256: { digest: "sha256", bytes: 32 },
  HS384: { digest: "sha384", bytes: 48 },
  HS512: { digest: "sha512", bytes: 64 },
};

process.env.TINA4_SECRET = SECRET;
delete process.env.TINA4_JWT_ALGORITHM;

function base64urlDecode(value: string): Buffer {
  let s = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = 4 - (s.length % 4);
  if (pad !== 4) s += "=".repeat(pad);
  return Buffer.from(s, "base64");
}

function base64urlEncode(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a token into [header, payload, rawSignatureString]. */
function partsOf(token: string): [Record<string, unknown>, Record<string, unknown>, string] {
  const [h, p, sig] = token.split(".");
  return [
    JSON.parse(base64urlDecode(h).toString()) as Record<string, unknown>,
    JSON.parse(base64urlDecode(p).toString()) as Record<string, unknown>,
    sig,
  ];
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

console.log("=== JWT algorithm / nbf regression tests (nodejs#39) ===\n");

// ── The header must name the algorithm that actually signed (python#105) ──

console.log("-- header alg matches the signing digest --");

for (const algorithm of HMAC_ALGORITHMS) {
  // POSITIVE: for every supported alg the signature is INDEPENDENTLY recomputable
  // as that alg's HMAC over the real signing input. Before the fix `sign()`
  // hardcoded sha256, so an HS512 token carried a header saying HS512 over an
  // HMAC-SHA256 signature — any RFC-conformant verifier reading the header
  // computed a different digest and rejected the token.
  const token = getToken({ userId: 7 }, SECRET, 60, algorithm);
  const [header, , signature] = partsOf(token);
  assert(`${algorithm}: header alg is ${algorithm}`, header.alg === algorithm);

  const signingInput = token.split(".").slice(0, 2).join(".");
  const expected = base64urlEncode(
    createHmac(DIGEST_FOR[algorithm].digest, SECRET).update(signingInput).digest(),
  );
  assert(
    `${algorithm}: signature equals an independently computed ${DIGEST_FOR[algorithm].digest} HMAC`,
    signature === expected,
  );
}

for (const algorithm of HMAC_ALGORITHMS) {
  // NEGATIVE: proves the digest really varies with the alg, INDEPENDENT of the
  // signing input. Comparing an HS256 token's signature to an HS512 token's is
  // NOT a valid probe — the header is part of the signing input, so the two
  // differ even when both are secretly signed with sha256. The digest LENGTH
  // cannot lie: sha256 is 32 bytes, sha384 48, sha512 64. Under a hardcoded
  // sha256 every token carries 32 bytes regardless of the alg it advertises.
  const token = getToken({ userId: 7 }, SECRET, 60, algorithm);
  const rawSignature = base64urlDecode(token.split(".")[2]);
  assert(
    `${algorithm}: signature is ${DIGEST_FOR[algorithm].bytes} raw bytes (the declared alg's digest size)`,
    rawSignature.length === DIGEST_FOR[algorithm].bytes,
  );
}

// ── Algorithm pinning: the token header must not choose the verifier ──

console.log("\n-- alg pinning (alg substitution / alg:none) --");

{
  const token = getToken({ userId: 7 }, SECRET, 60, "HS256");
  const [h, p, sig] = token.split(".");

  for (const forgedAlgorithm of ["none", "HS384", "HS512", "RS256"]) {
    const forgedHeader = base64urlEncode(
      Buffer.from(JSON.stringify({ alg: forgedAlgorithm, typ: "JWT" })),
    );
    assert(
      `forged header alg "${forgedAlgorithm}" is rejected when HS256 is expected`,
      validToken(`${forgedHeader}.${p}.${sig}`, SECRET, "HS256") === null,
    );
  }

  // POSITIVE control: the untampered token still validates, so the pin rejects
  // the substitution rather than everything.
  assert(
    "untampered HS256 token still validates",
    validToken(token, SECRET, "HS256") !== null,
  );
}

{
  // An alg:none token with an EMPTY signature — the classic bypass — is refused.
  const header = base64urlEncode(Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })));
  const payload = base64urlEncode(Buffer.from(JSON.stringify({ userId: 1, admin: true })));
  assert(
    'alg:"none" with an empty signature is rejected',
    validToken(`${header}.${payload}.`, SECRET, "HS256") === null,
  );
}

{
  // A genuinely-signed HS512 token must not validate where HS256 is expected,
  // even though both are supported algorithms.
  const hs512Token = getToken({ userId: 7 }, SECRET, 60, "HS512");
  assert(
    "a real HS512 token does not validate under an HS256 expectation",
    validToken(hs512Token, SECRET, "HS256") === null,
  );
  assert(
    "the same HS512 token validates under an HS512 expectation",
    validToken(hs512Token, SECRET, "HS512") !== null,
  );
}

// ── TINA4_JWT_ALGORITHM must actually be read (python#106) ──

console.log("\n-- TINA4_JWT_ALGORITHM is honoured --");

{
  // POSITIVE: setting the env var changes the algorithm used to sign. It was
  // registered in the CLI's known_vars and could be read for HS256/RS256, but
  // HS384/HS512 were simply unsupported — a user could set HS512 and get an
  // "Unsupported algorithm" crash instead of an HS512 token.
  process.env.TINA4_JWT_ALGORITHM = "HS512";
  assert("resolveAlgorithm() reads TINA4_JWT_ALGORITHM (HS512)", resolveAlgorithm() === "HS512");

  const envToken = getToken({ userId: 1 });
  const [header, , signature] = partsOf(envToken);
  assert("env HS512: header alg is HS512", header.alg === "HS512");
  assert(
    "env HS512: signature is a 64-byte sha512 digest",
    base64urlDecode(signature).length === 64,
  );
  assert("env HS512: the token round-trips through validToken", validToken(envToken) !== null);

  // NEGATIVE for precedence: an explicit argument must WIN over the environment.
  assert(
    "explicit algorithm argument beats the env var",
    resolveAlgorithm("HS256") === "HS256",
  );
  const [explicitHeader] = partsOf(getToken({ userId: 1 }, SECRET, 60, "HS256"));
  assert("explicit HS256 signs HS256 while env says HS512", explicitHeader.alg === "HS256");

  delete process.env.TINA4_JWT_ALGORITHM;
}

{
  // Unset ⇒ HS256, the documented default.
  delete process.env.TINA4_JWT_ALGORITHM;
  assert("unset TINA4_JWT_ALGORITHM defaults to HS256", resolveAlgorithm() === "HS256");
  const [header] = partsOf(getToken({ userId: 1 }));
  assert("unset TINA4_JWT_ALGORITHM signs HS256", header.alg === "HS256");
}

{
  // Surrounding whitespace in the env var is tolerated (parity with Python's .strip()).
  process.env.TINA4_JWT_ALGORITHM = "  HS384  ";
  assert("whitespace around the env algorithm is trimmed", resolveAlgorithm() === "HS384");
  delete process.env.TINA4_JWT_ALGORITHM;
}

console.log("\n-- an unsupported algorithm fails loudly --");

{
  // NEGATIVE: an algorithm we cannot sign must throw with a message naming the
  // supported set and the env var — never quietly downgrade to HS256, which is
  // the whole bug in python#106.
  const namesEverything = (message: string) =>
    message.includes("banana") &&
    ["HS256", "HS384", "HS512", "RS256"].every((alg) => message.includes(alg)) &&
    message.includes("TINA4_JWT_ALGORITHM");

  assertThrows(
    "resolveAlgorithm throws for an unsupported algorithm, naming the supported set + env var",
    () => resolveAlgorithm("banana"),
    namesEverything,
  );
  assertThrows(
    "getToken throws for an unsupported explicit algorithm",
    () => getToken({ userId: 1 }, SECRET, 60, "banana"),
    namesEverything,
  );

  process.env.TINA4_JWT_ALGORITHM = "banana";
  assertThrows(
    "getToken throws for an unsupported env algorithm",
    () => getToken({ userId: 1 }),
    namesEverything,
  );
  // Validation THROWS on a misconfigured algorithm rather than swallowing it
  // into a null. Cross-framework contract: Python (master) raises in the
  // constructor and PHP throws out of validToken, so Node must not be the one
  // framework that silently turns a deployment error into a 401 on every
  // request. It cannot hide the fault anyway - getToken throws on the same
  // value (asserted just above), so a typo surfaces at login either way.
  assertThrows(
    "validToken throws when the configured algorithm is unsupported",
    () => validToken(getToken({ userId: 1 }, SECRET, 60, "HS256")),
    namesEverything,
  );
  delete process.env.TINA4_JWT_ALGORITHM;

  // A prototype-chain key must not sneak through the supported-algorithm lookup.
  assertThrows(
    'resolveAlgorithm throws for "toString" (no prototype-chain leak)',
    () => resolveAlgorithm("toString"),
    (message) => message.includes("toString"),
  );
}

// ── nbf (not-before) must be validated (nodejs#39 / python#107) ──

console.log("\n-- nbf (not-before) --");

{
  // NEGATIVE: a token the issuer marked not-yet-valid must not authenticate.
  // Only Ruby honoured nbf, so Node accepted tokens explicitly stamped as
  // unusable — a deliberately post-dated credential worked immediately.
  const future = nowSeconds() + JWT_LEEWAY_SECONDS + 600;
  const postDated = getToken({ userId: 1, nbf: future }, SECRET);
  assert("a post-dated nbf token is rejected", validToken(postDated, SECRET) === null);
  // The claim really is on the token (so the rejection is about nbf, not a typo).
  assert("the rejected token really carries the nbf claim", partsOf(postDated)[1].nbf === future);
}

{
  // POSITIVE: nbf in the past does not block a valid token.
  const past = nowSeconds() - 600;
  const payload = validToken(getToken({ userId: 1, nbf: past }, SECRET), SECRET);
  assert("an nbf in the past is accepted", payload !== null && payload.userId === 1);
}

{
  // POSITIVE: clock-skew tolerance. An nbf a few seconds ahead — the normal case
  // for a token minted on another host — must not be rejected.
  const slightlyAhead = nowSeconds() + Math.max(1, Math.floor(JWT_LEEWAY_SECONDS / 2));
  assert(
    "an nbf within the leeway still validates",
    validToken(getToken({ userId: 1, nbf: slightlyAhead }, SECRET), SECRET) !== null,
  );
  assert("the leeway is 60 seconds (Python parity)", JWT_LEEWAY_SECONDS === 60);
}

{
  // POSITIVE: absent nbf means no not-before constraint, so existing tokens keep
  // working — this is what keeps the change non-breaking.
  const token = getToken({ userId: 1 }, SECRET);
  assert("getToken emits no nbf claim", !Object.hasOwn(partsOf(token)[1], "nbf"));
  assert("a token without nbf is unaffected", validToken(token, SECRET) !== null);
}

{
  // NEGATIVE: a present-but-malformed nbf must not read as "no constraint"
  // (Python raises a TypeError comparing to a string and returns None).
  for (const malformed of ["9999999999", null, {}]) {
    assert(
      `a non-numeric nbf (${JSON.stringify(malformed)}) is rejected, not ignored`,
      validToken(getToken({ userId: 1, nbf: malformed }, SECRET), SECRET) === null,
    );
  }
}

{
  // NEGATIVE: adding nbf must not have displaced the exp check. expiresIn=0
  // means "do not stamp an exp", which lets the payload's own exp survive.
  const alreadyExpired = getToken({ userId: 1, exp: nowSeconds() - 600 }, SECRET, 0);
  assert("expiry is still enforced alongside nbf", validToken(alreadyExpired, SECRET) === null);
}

{
  // Both claims together: valid nbf + expired exp still fails.
  const token = getToken(
    { userId: 1, nbf: nowSeconds() - 600, exp: nowSeconds() - 60 },
    SECRET,
    0,
  );
  assert("a past nbf does not rescue an expired token", validToken(token, SECRET) === null);
}

{
  // The nbf claim survives the round-trip into the returned payload.
  const notBefore = nowSeconds() - 30;
  const payload = validToken(getToken({ userId: 4, nbf: notBefore }, SECRET), SECRET);
  assert("the validated payload carries the nbf claim through", payload?.nbf === notBefore);
}

// ── Round-trip + wrong-secret across every HMAC algorithm ──

console.log("\n-- round-trip per algorithm --");

for (const algorithm of HMAC_ALGORITHMS) {
  const token = getToken({ userId: 3, role: "admin" }, SECRET, 60, algorithm);
  const payload = validToken(token, SECRET, algorithm);
  assert(`${algorithm}: sign → validate round-trip returns the payload`, payload !== null);
  assert(
    `${algorithm}: round-trip preserves userId + role`,
    payload?.userId === 3 && payload?.role === "admin",
  );
  assert(
    `${algorithm}: a different secret never validates`,
    validToken(token, "not-the-secret", algorithm) === null,
  );
  assert(
    `${algorithm}: getPayload still decodes without verifying`,
    getPayload(token)?.userId === 3,
  );
}

// ── RS256 still works (Node-only extra — node:crypto, zero dependencies) ──

console.log("\n-- RS256 (Node/PHP-only extra) --");

{
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const rsaToken = getToken({ userId: 99 }, privateKey, 60, "RS256");
  const [header] = partsOf(rsaToken);
  assert("RS256: header alg is RS256", header.alg === "RS256");
  assert(
    "RS256: token verifies with the public key",
    validToken(rsaToken, publicKey, "RS256") !== null,
  );
  assert(
    "RS256: payload survives the round-trip",
    validToken(rsaToken, publicKey, "RS256")?.userId === 99,
  );
  assert("RS256 is a supported algorithm", resolveAlgorithm("RS256") === "RS256");

  // NEGATIVE: an RS256 token must not validate under an HMAC expectation, and a
  // different key pair must not verify it.
  assert(
    "RS256: token is rejected under an HS256 expectation",
    validToken(rsaToken, publicKey, "HS256") === null,
  );
  const otherPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  assert(
    "RS256: a different public key never validates",
    validToken(rsaToken, otherPair.publicKey, "RS256") === null,
  );

  // RS256 honours nbf too.
  const postDatedRsa = getToken(
    { userId: 99, nbf: nowSeconds() + JWT_LEEWAY_SECONDS + 600 },
    privateKey,
    60,
    "RS256",
  );
  assert(
    "RS256: a post-dated nbf token is rejected",
    validToken(postDatedRsa, publicKey, "RS256") === null,
  );
}

// ── authMiddleware must not shadow TINA4_JWT_ALGORITHM ──

console.log("\n-- authMiddleware honours TINA4_JWT_ALGORITHM --");

function mockRequest(authHeader?: string): Tina4Request {
  const request = {
    headers: {} as Record<string, string>,
    params: {},
    query: {},
    body: null,
    ip: "127.0.0.1",
    files: [],
  } as unknown as Tina4Request;
  if (authHeader) request.headers.authorization = authHeader;
  return request;
}

function mockResponse(): { response: Tina4Response; state: { lastStatus: number | null } } {
  const state = { lastStatus: null as number | null };
  const response = function (_data?: unknown, statusCode?: number) {
    state.lastStatus = statusCode ?? 200;
    return response;
  } as Tina4Response;
  return { response, state };
}

{
  // NEGATIVE: authMiddleware's algorithm parameter used to DEFAULT to the literal
  // "HS256", which shadowed the env var — an app on TINA4_JWT_ALGORITHM=HS512
  // minted HS512 tokens and the middleware verified them as HS256, so alg pinning
  // rejected every legitimately-signed token.
  process.env.TINA4_JWT_ALGORITHM = "HS512";
  const middleware = authMiddleware();
  const request = mockRequest(`Bearer ${getToken({ userId: 11 })}`);
  const { response, state } = mockResponse();
  let nextCalled = false;
  middleware(request, response, () => {
    nextCalled = true;
  });
  assert("authMiddleware() accepts an HS512 token when the env says HS512", nextCalled === true);
  assert("authMiddleware() sends no 401 for a valid HS512 token", state.lastStatus === null);
  assert(
    "authMiddleware() attaches the decoded payload (userId === 11)",
    (request as unknown as { auth?: Record<string, unknown> }).auth?.userId === 11,
  );
  delete process.env.TINA4_JWT_ALGORITHM;
}

{
  // POSITIVE control: a post-dated token is still refused by the middleware, so
  // nbf is enforced on the real request path and not just in validToken.
  const postDated = getToken({ userId: 12, nbf: nowSeconds() + JWT_LEEWAY_SECONDS + 600 });
  const request = mockRequest(`Bearer ${postDated}`);
  const { response, state } = mockResponse();
  let nextCalled = false;
  authMiddleware()(request, response, () => {
    nextCalled = true;
  });
  assert("authMiddleware rejects a post-dated (nbf) token", nextCalled === false);
  assert("authMiddleware sends 401 for a post-dated token", state.lastStatus === 401);
}

{
  // An explicit algorithm argument still wins inside the middleware.
  process.env.TINA4_JWT_ALGORITHM = "HS512";
  const hs256Token = getToken({ userId: 13 }, SECRET, 60, "HS256");
  const request = mockRequest(`Bearer ${hs256Token}`);
  const { response } = mockResponse();
  let nextCalled = false;
  authMiddleware(SECRET, "HS256")(request, response, () => {
    nextCalled = true;
  });
  assert("authMiddleware(secret, 'HS256') overrides the env var", nextCalled === true);
  delete process.env.TINA4_JWT_ALGORITHM;
}

// ── A misconfigured algorithm THROWS, it is not swallowed ─────────
// Cross-framework contract: Python (master) raises in the constructor and PHP
// throws out of validToken, so Node must not quietly turn a deployment error
// into a null. Swallowing it produced a silent 401 on every request while
// getToken threw on the same value - two paths disagreeing about one typo.

{
  process.env.TINA4_JWT_ALGORITHM = "HS2566"; // a plausible typo
  assertThrows(
    "validToken throws on a bad TINA4_JWT_ALGORITHM instead of returning null",
    () => validToken("a.b.c"),
    (message) =>
      message.includes("HS2566") &&
      message.includes("HS256") &&
      message.includes("HS384") &&
      message.includes("HS512") &&
      message.includes("TINA4_JWT_ALGORITHM"),
  );
  assertThrows(
    "getToken throws on the same bad value, so both paths agree",
    () => getToken({ userId: 1 }, SECRET),
    (message) => message.includes("HS2566"),
  );
  delete process.env.TINA4_JWT_ALGORITHM;
}

{
  // NEGATIVE: a malformed token under a VALID algorithm still returns null
  // rather than throwing. Only the config error escapes.
  delete process.env.TINA4_JWT_ALGORITHM;
  assert("a malformed token under a valid alg still returns null", validToken("not.a.jwt") === null);
  assert("an empty token still returns null", validToken("") === null);
}

// ── Summary ───────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
