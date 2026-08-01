/**
 * Generator for `jwt_cross_framework.json` — the cross-framework JWT contract fixture.
 *
 * Run it once and commit the JSON; it is not run by the test suite (the runner
 * only picks up `test/*.test.ts`). It lives here so the fixture can be
 * regenerated and audited rather than being an unexplained blob.
 *
 *   npx tsx test/fixtures/generateJwtCrossFramework.ts > test/fixtures/jwt_cross_framework.json
 *
 * What the fixture is FOR: all four frameworks must ACCEPT every `accept` entry
 * and REJECT every `reject` entry, with the same key and the same configured
 * algorithm. A byte-identical copy lives in each repo — tina4-python
 * `tests/fixtures/`, tina4-php `tests/fixtures/`, tina4-ruby `spec/fixtures/` —
 * following the same convention as adapter_contract.json and
 * batch_write_contract.json. Regenerate here, then copy to all four; each repo's
 * own test asserts the copy is in sync.
 *
 * HMAC (HS256/HS384/HS512) is the zero-dependency standard everywhere. RS256 is
 * the opt-in extra and works in all four: builtin `node:crypto` here, stdlib
 * `OpenSSL::PKey::RSA` in Ruby, suggested `ext-openssl` in PHP, and the
 * `cryptography` package (never declared by Tina4) in Python — where its absence
 * must fail LOUDLY at the point of use rather than silently.
 *
 * Only the PUBLIC key is written. Verification never needs the private key, so
 * no private key is committed.
 */
import { createHmac, generateKeyPairSync } from "node:crypto";
import { getToken } from "../../packages/core/src/auth.ts";

const HMAC_SECRET = "tina4-cross-framework-jwt-fixture-secret";
/** A secret the fixture NEVER signs with — the wrong-key negative control. */
const WRONG_SECRET = "tina4-cross-framework-jwt-fixture-WRONG-secret";
const NBF = 1767225600; // 2026-01-01T00:00:00Z — safely in the past
const EXP = 4102444800; // 2100-01-01T00:00:00Z — safely in the future
const EXPIRED = 1577836800; // 2020-01-01T00:00:00Z — permanently expired

const rsa = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const claims = { sub: "tina4-cross-framework", userId: 42, nbf: NBF, exp: EXP };

function b64url(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodePayload(token: string): Record<string, unknown> {
  let s = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = 4 - (s.length % 4);
  if (pad !== 4) s += "=".repeat(pad);
  return JSON.parse(Buffer.from(s, "base64").toString()) as Record<string, unknown>;
}
/** Keep the payload + signature, swap only the header's `alg`. */
function reHeader(token: string, alg: string): string {
  const [, p, sig] = token.split(".");
  return `${b64url(Buffer.from(JSON.stringify({ alg, typ: "JWT" })))}.${p}.${sig}`;
}

/**
 * Build a token whose header BYTES carry `alg` twice, and sign it for real.
 *
 * This is THE gate on the algorithm pin, and the only construction that is.
 * Every other substitution case in this fixture is rejected even by an
 * implementation with no pin at all, because the header is part of the signing
 * input: relabel it and the recomputed signature simply stops matching. Here the
 * header bytes are UNCHANGED between signing and verifying, so the signature is
 * genuinely valid — but all four JSON parsers take the LAST duplicate key, so
 * the header PARSES as the smuggled algorithm. Only a verifier that compares the
 * parsed `alg` against its own configuration rejects it.
 *
 * It also models a real split-brain: a gateway that pre-validates on the first
 * `alg` and a backend that acts on the last are looking at different tokens.
 */
function duplicateAlgHeader(smuggled: string, honest: string, payload: string, secret: string): string {
  const header = b64url(Buffer.from(`{"alg":"${honest}","alg":"${smuggled}","typ":"JWT"}`));
  const signingInput = `${header}.${payload}`;
  const digest = { HS256: "sha256", HS384: "sha384", HS512: "sha512" }[honest] as string;
  return `${signingInput}.${b64url(createHmac(digest, secret).update(signingInput).digest())}`;
}
/** Keep the header + signature, swap the payload. */
function rePayload(token: string, payload: Record<string, unknown>): string {
  const [h, , sig] = token.split(".");
  return `${h}.${b64url(Buffer.from(JSON.stringify(payload)))}.${sig}`;
}

// getToken stamps `iat` from the clock on every call, so four separate calls can
// straddle a second boundary and produce four different payloads. One
// expectedPayload must cover all four accept tokens, so regenerate until the four
// clock reads agree rather than shipping a fixture that only sometimes matches.
// expiresIn = 0 means getToken stamps no `exp` of its own and the fixed one survives.
let hs256 = "";
let hs384 = "";
let hs512 = "";
let rs256 = "";
let attempts = 0;
do {
  if (++attempts > 50) throw new Error("could not mint four tokens within one second");
  hs256 = getToken(claims, HMAC_SECRET, 0, "HS256");
  hs384 = getToken(claims, HMAC_SECRET, 0, "HS384");
  hs512 = getToken(claims, HMAC_SECRET, 0, "HS512");
  rs256 = getToken(claims, rsa.privateKey, 0, "RS256");
} while (
  new Set([hs256, hs384, hs512, rs256].map((t) => JSON.stringify(decodePayload(t)))).size !== 1
);

const expectedPayload = decodePayload(hs256);

const fixture = {
  $comment:
    "Cross-framework JWT contract fixture, generated by tina4-nodejs using node:crypto only. " +
    "Every framework must ACCEPT each `accept` entry and REJECT each `reject` entry using the " +
    "named key and configured algorithm. HMAC (HS256/HS384/HS512) is the Tina4 standard and is " +
    "zero-dependency in all four frameworks; RS256 is an opt-in extra available only where the " +
    "runtime provides asymmetric crypto natively (node:crypto, PHP ext-openssl, Ruby stdlib " +
    "OpenSSL) and must fail LOUDLY where it does not (tina4-python). No private key is stored - " +
    "verification only ever needs the public key.",
  generatedBy: "tina4-nodejs test/fixtures/generateJwtCrossFramework.ts",
  hmacSecret: HMAC_SECRET,
  wrongSecret: WRONG_SECRET,
  rs256PublicKey: rsa.publicKey,
  expectedPayload,
  accept: [
    { name: "HS256 signed with the shared secret", algorithm: "HS256", key: "hmacSecret", token: hs256 },
    { name: "HS384 signed with the shared secret", algorithm: "HS384", key: "hmacSecret", token: hs384 },
    { name: "HS512 signed with the shared secret", algorithm: "HS512", key: "hmacSecret", token: hs512 },
    { name: "RS256 verified with the public key alone", algorithm: "RS256", key: "rs256PublicKey", token: rs256 },
  ],
  reject: [
    {
      name: "alg none with an empty signature",
      algorithm: "HS256",
      key: "hmacSecret",
      token: `${b64url(Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })))}.${hs256.split(".")[1]}.`,
    },
    {
      name: "alg none carrying the real HS256 signature",
      algorithm: "HS256",
      key: "hmacSecret",
      token: reHeader(hs256, "none"),
    },
    {
      name: "header claims RS256 over an HS256 signature (algorithm substitution)",
      algorithm: "HS256",
      key: "hmacSecret",
      token: reHeader(hs256, "RS256"),
    },
    {
      name: "a genuinely RS256-signed token offered to an HMAC verifier",
      algorithm: "HS256",
      key: "hmacSecret",
      token: rs256,
    },
    {
      name: "header claims HS256 over an RS256 signature",
      algorithm: "RS256",
      key: "rs256PublicKey",
      token: reHeader(rs256, "HS256"),
    },
    {
      name: "a real HS512 token offered to an HS256 verifier",
      algorithm: "HS256",
      key: "hmacSecret",
      token: hs512,
    },
    {
      // The brief's HS512-claimed-but-HS256-signed case. Distinct from the one
      // above: there the token really WAS HS512 and the verifier was HS256; here
      // the signature is a genuine HS256 one under a header that lies HS512, and
      // the verifier is CONFIGURED for HS512. Only the pin catches it.
      name: "header claims HS512 over a real HS256 signature, verified as HS512",
      algorithm: "HS512",
      key: "hmacSecret",
      token: reHeader(hs256, "HS512"),
    },
    {
      // THE pin gate — see duplicateAlgHeader(). A correctly-signed HS256 token
      // whose header PARSES as alg:"none". An implementation with no algorithm
      // pin ACCEPTS this; every other reject entry in this fixture is refused
      // for reasons that have nothing to do with the pin, so without these three
      // the pin is untested.
      name: 'duplicate alg key: header bytes say HS256, parses as "none", real HS256 signature',
      algorithm: "HS256",
      key: "hmacSecret",
      token: duplicateAlgHeader("none", "HS256", hs256.split(".")[1], HMAC_SECRET),
    },
    {
      name: "duplicate alg key: header bytes say HS256, parses as RS256, real HS256 signature",
      algorithm: "HS256",
      key: "hmacSecret",
      token: duplicateAlgHeader("RS256", "HS256", hs256.split(".")[1], HMAC_SECRET),
    },
    {
      name: "duplicate alg key: header bytes say HS512, parses as HS256, real HS512 signature",
      algorithm: "HS512",
      key: "hmacSecret",
      token: duplicateAlgHeader("HS256", "HS512", hs512.split(".")[1], HMAC_SECRET),
    },
    {
      // The wrong-key negative control. The token is perfectly well formed and
      // correctly signed — just not with the secret the verifier holds.
      name: "a valid HS256 token verified with the wrong secret",
      algorithm: "HS256",
      key: "wrongSecret",
      token: hs256,
    },
    {
      name: "a valid HS384 token verified with the wrong secret",
      algorithm: "HS384",
      key: "wrongSecret",
      token: hs384,
    },
    {
      name: "a valid HS512 token verified with the wrong secret",
      algorithm: "HS512",
      key: "wrongSecret",
      token: hs512,
    },
    {
      name: "HS256 with a tampered payload",
      algorithm: "HS256",
      key: "hmacSecret",
      token: rePayload(hs256, { ...expectedPayload, userId: 1, admin: true }),
    },
    {
      name: "RS256 with a tampered payload",
      algorithm: "RS256",
      key: "rs256PublicKey",
      token: rePayload(rs256, { ...expectedPayload, userId: 1, admin: true }),
    },
    {
      name: "HS256 that expired in 2020",
      algorithm: "HS256",
      key: "hmacSecret",
      token: getToken({ ...claims, exp: EXPIRED }, HMAC_SECRET, 0, "HS256"),
    },
    {
      name: "HS256 post-dated to 2100, far beyond the nbf leeway",
      algorithm: "HS256",
      key: "hmacSecret",
      token: getToken({ ...claims, nbf: EXP }, HMAC_SECRET, 0, "HS256"),
    },
  ],
};

process.stdout.write(JSON.stringify(fixture, null, 2) + "\n");
