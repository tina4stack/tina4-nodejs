/**
 * Tina4 Auth — Zero-dependency JWT, password hashing, and auth middleware.
 *
 * Uses only Node.js built-in `crypto` module. No external dependencies.
 *
 *   import { getToken, validToken, hashPassword, checkPassword } from "./auth.js";
 *
 *   const token = getToken({ userId: 1 }, "my-secret");
 *   const payload = validToken(token, "my-secret");
 *
 *   const hash = hashPassword("secret123");
 *   checkPassword("secret123", hash);  // true
 */
import { createHmac, createSign, createVerify, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Middleware, Tina4Request, Tina4Response } from "./types.js";
import { isTruthy } from "./dotenv.js";

// ── Blank-secret warning + dev-secret bootstrap ────────────────────
//
// Mirrors the Python master (tina4_python/auth/__init__.py):
//   • The default signing secret stays BLANK — never a guessable built-in.
//   • In DEV (not CI, not production) a blank secret is auto-generated once and
//     persisted to a gitignored .env.local, so a local dev never has to be told
//     what to set. INFO, not a warning.
//   • In CI / production a blank secret keeps the loud, ACTIONABLE warning.

/** Actionable blank-secret warning — emitted from both the bootstrap (CI/prod) and the lazy resolvers. */
const BLANK_SECRET_WARNING =
  "Auth: TINA4_SECRET is not set — JWT signing is insecure. Set TINA4_SECRET to a random " +
  "value (e.g. `openssl rand -hex 32`) in your environment or .env before serving traffic. " +
  "For LOCAL DEV, set TINA4_DEBUG=true and a per-machine secret is generated automatically " +
  "into .env.local (gitignored). Seeing this warning means the run was NOT detected as dev — " +
  "typically a container or CI without TINA4_DEBUG set, or TINA4_ENV=production.";

/** True when running under CI — the de-facto `CI` env var (set by every major CI). */
function _isCi(): boolean {
  return isTruthy(process.env.CI);
}

/** True in development — the framework debug flag is truthy (e.g. TINA4_DEBUG=true). */
function _isDev(): boolean {
  return isTruthy(process.env.TINA4_DEBUG);
}

/** True when TINA4_ENV is explicitly "production". */
function _isProduction(): boolean {
  return (process.env.TINA4_ENV ?? "development") === "production";
}

/** INFO log via Tina4 Log when available, else stderr. (Local import avoids a load-time cycle.) */
async function _logInfo(message: string): Promise<void> {
  try {
    const { Log } = await import("./logger.js");
    Log.info(message);
  } catch {
    process.stderr.write(message + "\n");
  }
}

/** WARNING log via Tina4 Log when available, else stderr. */
async function _logWarning(message: string): Promise<void> {
  try {
    const { Log } = await import("./logger.js");
    Log.warning(message);
  } catch {
    process.stderr.write(message + "\n");
  }
}

/** Emit the shared, actionable blank-secret warning (used by CI/prod bootstrap + lazy resolvers). */
function _warnBlankSecret(): void {
  void _logWarning(BLANK_SECRET_WARNING);
}

/**
 * Ensure a usable TINA4_SECRET exists. Run ONCE at server boot, after env load
 * and before auth is used. Mirrors Python's `ensure_dev_secret()`.
 *
 * Order:
 *   1. TINA4_SECRET already set → no-op (return null).
 *   2. NOT dev, OR CI, OR production → emit the actionable warning, return null.
 *      NEVER generates or persists a secret in CI / production / non-dev.
 *   3. Otherwise (dev, not CI, not prod, blank secret) → generate a 32-byte hex
 *      secret, set it in process.env for THIS run immediately, then try to append
 *      it to <cwd>/.env.local (create if missing; never touch .env). On a write
 *      failure keep the in-memory secret and warn — boot must never crash.
 *
 * @param cwd - Directory to write .env.local into. Tests pass a temp dir; production passes nothing.
 * @returns The newly-generated secret, or null when nothing was generated.
 */
export function ensureDevSecret(cwd?: string): string | null {
  if (process.env.TINA4_SECRET) return null; // already configured

  // Only the dev-and-not-CI-and-not-production path may generate / persist.
  if (!_isDev() || _isCi() || _isProduction()) {
    _warnBlankSecret();
    return null;
  }

  // 32 bytes hex = 64 hex chars (parity with Python's secrets.token_hex(32)).
  const newSecret = randomBytes(32).toString("hex");
  // Set immediately so it's available for this run even if the write fails.
  process.env.TINA4_SECRET = newSecret;

  const baseDir = cwd ?? process.cwd();
  const envLocalPath = join(baseDir, ".env.local");
  try {
    // If the file exists and its content doesn't end in a newline, prepend one
    // so the new key lands on its own line.
    let prefix = "";
    if (existsSync(envLocalPath)) {
      const existing = readFileSync(envLocalPath, "utf-8");
      if (existing.length > 0 && !existing.endsWith("\n")) prefix = "\n";
    }
    appendFileSync(envLocalPath, `${prefix}TINA4_SECRET=${newSecret}\n`);
    void _logInfo("Auth: generated a development secret, saved to .env.local (gitignored)");
  } catch {
    // Keep the in-memory secret for this run; warn but never crash boot.
    void _logWarning(
      "Auth: generated a development secret but could not write .env.local — " +
        "using it in-memory for this run only.",
    );
  }

  return newSecret;
}

// ── JWT algorithms + runtime capability ───────────────────────────
//
// HMAC — HS256 / HS384 / HS512 — is THE Tina4 JWT algorithm family, and it is
// zero-dependency in all four frameworks:
//     python  hmac + hashlib          (stdlib)
//     php     hash_hmac               (ext-hash, PHP core)
//     ruby    OpenSSL::HMAC           (stdlib default gem, NOT the jwt gem)
//     node    node:crypto createHmac  (builtin)
//
// RS256 is an OPT-IN EXTRA, offered only where the RUNTIME provides asymmetric
// crypto natively — never as a third-party dependency. Node gets it from the
// same builtin node:crypto, so tina4-nodejs is the REFERENCE for what RS256
// looks like when available; tina4-php has it from core ext-openssl and
// tina4-ruby from its stdlib openssl default gem. tina4-python does NOT offer
// it, because Python's standard library has no asymmetric crypto at all and
// Tina4 will not add a package for it. That is not an outlier: HMAC is the
// standard, not a fallback.
//
// The capability is PROBED rather than assumed (see `capabilityFailure`). A
// table says what we intend to support; only running the primitive says what
// THIS build can do. A crypto provider that refuses RSA-SHA256 must produce the
// same loud, actionable failure a developer gets from tina4-python — never a
// silent downgrade to HMAC, never a mysterious `false`.
//
// SECURITY, documented rather than buried: HMAC is SYMMETRIC. Every service
// that VERIFIES a token holds the SAME secret that signs it, so any verifier
// can also MINT tokens. That is fine for one app or a fleet you control, and
// WRONG for handing tokens to a third party you do not — RS256 exists so a
// verifier can hold only the public key.
//
// The digest is LOOKED UP from the configured algorithm rather than hardcoded,
// so the "alg" advertised in the header is always the one that actually
// produced the signature (python#105). TINA4_JWT_ALGORITHM is read for real,
// and an algorithm we cannot sign fails loudly instead of silently downgrading
// to HS256 (python#106).

/** HMAC algorithms → their node:crypto digest name. The cross-framework standard. */
const HMAC_DIGESTS = new Map<string, string>([
  ["HS256", "sha256"],
  ["HS384", "sha384"],
  ["HS512", "sha512"],
]);

/** RSA algorithms → their node:crypto sign/verify algorithm name. The opt-in extra. */
const RSA_SIGN_ALGORITHMS = new Map<string, string>([["RS256", "RSA-SHA256"]]);

/** Every algorithm Tina4 for Node KNOWS, available in this runtime or not. */
const KNOWN_ALGORITHMS: readonly string[] = [
  ...HMAC_DIGESTS.keys(),
  ...RSA_SIGN_ALGORITHMS.keys(),
];

/**
 * How to get an algorithm back when this runtime cannot provide it. Only the
 * remedy differs between frameworks; the sentence around it is identical, so
 * "RS256 is not available" reads the same everywhere.
 */
const ALGORITHM_REMEDY = new Map<string, string>([
  [
    "RS256",
    "RS256 comes from builtin node:crypto, so no package installs it — this build's " +
      'crypto provider refused RSA-SHA256 (check `node -p "process.versions.openssl"`)',
  ],
]);

/** Probe results, memoised: algorithm → null when usable here, else the runtime's own reason. */
const capabilityCache = new Map<string, string | null>();

/**
 * Ask the RUNTIME — not a lookup table — whether it can actually sign and
 * verify with `algorithm`, and remember the answer.
 *
 * Only meaningful for a KNOWN algorithm; every caller checks membership first.
 *
 * @returns `null` when the algorithm works here, else the runtime's own reason.
 */
function capabilityFailure(algorithm: string): string | null {
  const cached = capabilityCache.get(algorithm);
  if (cached !== undefined) return cached;

  let failure: string | null = null;
  try {
    const digest = HMAC_DIGESTS.get(algorithm);
    if (digest !== undefined) {
      createHmac(digest, "tina4-capability-probe").update("").digest();
    } else {
      const rsaAlgorithm = RSA_SIGN_ALGORITHMS.get(algorithm) as string;
      createSign(rsaAlgorithm).update("");
      createVerify(rsaAlgorithm).update("");
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  capabilityCache.set(algorithm, failure);
  return failure;
}

/**
 * Can this runtime actually sign and verify `algorithm` right now?
 *
 * The cross-framework capability check — same question, same answer shape, in
 * all four frameworks. HMAC answers `true` everywhere. RS256 answers `true`
 * only where the runtime ships asymmetric crypto natively (node:crypto here,
 * core ext-openssl in PHP, the stdlib openssl gem in Ruby) and `false` in
 * tina4-python. An algorithm Tina4 does not know at all answers `false`.
 */
export function algorithmAvailable(algorithm: string): boolean {
  const chosen = String(algorithm ?? "").trim();
  return KNOWN_ALGORITHMS.includes(chosen) && capabilityFailure(chosen) === null;
}

/** Every algorithm this runtime can sign and verify right now, in advertised order. */
export function availableAlgorithms(): string[] {
  return KNOWN_ALGORITHMS.filter((algorithm) => capabilityFailure(algorithm) === null);
}

/**
 * Seconds of clock skew tolerated on the "nbf" (not-before) claim.
 *
 * Without this, a token minted on one host and validated on another a second
 * behind is rejected for no real reason; RFC 7519 explicitly allows "a small
 * leeway". Same value as the Python master's `_JWT_LEEWAY_SECONDS`.
 */
export const JWT_LEEWAY_SECONDS = 60;

/**
 * Coerce an RFC 7519 NumericDate claim to integer seconds, else `null`.
 *
 * RFC 7519 s2 defines `exp`/`nbf`/`iat` as a NumericDate — a JSON numeric
 * value. A claim that is PRESENT but not a number is malformed, and a malformed
 * constraint must never read as "no constraint": treating a non-numeric `exp`
 * as absent turns a broken token into one that never expires.
 *
 * `typeof value === "number"` already excludes boolean, string, null, array and
 * object; the finite check additionally rejects NaN and Infinity, which would
 * otherwise make every comparison silently false. Truncation is toward the
 * earlier second, so a fractional expiry can only expire sooner, never later.
 */
function numericDate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.floor(value);
}

/** The loud, actionable failure for an algorithm Tina4 does not know at all. */
function unsupportedAlgorithmError(algorithm: string): Error {
  return new Error(
    `Unsupported JWT algorithm "${algorithm}". Tina4 knows ${KNOWN_ALGORITHMS.join(", ")} ` +
      `(HMAC via node:crypto; RS256 needs a PEM key pair); available in this runtime: ` +
      `${availableAlgorithms().join(", ") || "(none)"}. ` +
      `Set TINA4_JWT_ALGORITHM to one of the available ones.`,
  );
}

/**
 * The loud, actionable failure for an algorithm Tina4 knows but this RUNTIME
 * cannot provide.
 *
 * Never a silent fallback to HMAC and never a bare `false`: the message names
 * WHAT is missing and HOW to get it. The sentence skeleton is identical in
 * tina4-python / tina4-php / tina4-ruby — only `reason` and the remedy differ —
 * so "RS256 is not available" is one recognisable experience in all four.
 */
function unavailableAlgorithmError(algorithm: string, reason: string): Error {
  const remedy =
    ALGORITHM_REMEDY.get(algorithm) ??
    `${algorithm} comes from builtin node:crypto, so no package installs it — this ` +
      `build's crypto provider refused it`;
  return new Error(
    `JWT algorithm "${algorithm}" is not available in this runtime: ${reason}. ${remedy}. ` +
      `Available right now: ${availableAlgorithms().join(", ") || "(none)"}. ` +
      `HMAC (HS256/HS384/HS512) is the Tina4 standard in all four frameworks and ` +
      `needs no extra dependency.`,
  );
}

/**
 * Pick the JWT algorithm: explicit argument, else TINA4_JWT_ALGORITHM, else HS256.
 *
 * Throws when asked for an algorithm Tina4 does not know (naming the known set,
 * what is available here, and the env var), and throws again — with the runtime's
 * own reason and a remedy — when it knows the algorithm but this build cannot
 * provide it. A silent downgrade to HS256 is the whole bug in python#106, and a
 * silent downgrade from RS256 would be worse: it would quietly turn asymmetric
 * verification into a shared secret.
 *
 * @param algorithm - Explicit algorithm; wins over the environment when given.
 */
export function resolveAlgorithm(algorithm?: string): string {
  const chosen = (algorithm || process.env.TINA4_JWT_ALGORITHM || "HS256").trim();
  if (!KNOWN_ALGORITHMS.includes(chosen)) {
    throw unsupportedAlgorithmError(chosen);
  }
  const failure = capabilityFailure(chosen);
  if (failure !== null) {
    throw unavailableAlgorithmError(chosen, failure);
  }
  return chosen;
}

// ── Base64url helpers (RFC 7515) ──────────────────────────────────

function base64urlEncode(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Buffer {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = 4 - (s.length % 4);
  if (pad !== 4) s += "=".repeat(pad);
  return Buffer.from(s, "base64");
}

// ── JWT ───────────────────────────────────────────────────────────

/**
 * Create a signed JWT token.
 *
 * Secret is always read from `process.env.TINA4_SECRET`.
 * Algorithm is read from `process.env.TINA4_JWT_ALGORITHM` (default "HS256").
 * HS256 / HS384 / HS512 is the cross-framework standard; RS256 is an opt-in
 * extra that Node provides from builtin node:crypto (pass the PEM private key
 * as the secret). An unknown algorithm, or one this runtime cannot provide,
 * throws — see `resolveAlgorithm`.
 *
 * The header's `alg` is always the algorithm that actually signed the token.
 *
 * No `nbf` (not-before) claim is stamped — parity with Python and PHP. Pass your
 * own `nbf` in the payload to post-date a token; `validToken` enforces it.
 *
 * @param payload          - Claims to encode (e.g. `{ userId: 1, role: "admin" }`)
 * @param secretOrExpiresIn - Signing secret string, OR expiresIn number in MINUTES (back-compat with old 2-arg form)
 * @param expiresIn         - Lifetime in MINUTES (default 60). `0` ⇒ no `exp` claim (non-expiring). Only used when secret is a string.
 * @param algorithm         - Overrides TINA4_JWT_ALGORITHM for this call.
 * @returns Signed JWT string: header.payload.signature
 * @throws When the resolved algorithm is not one Tina4 can sign.
 */
export function getToken(
  payload: Record<string, unknown>,
  secretOrExpiresIn?: string | number,
  expiresIn: number = 60,
  algorithm?: string,
): string {
  // Back-compat: if second arg is a number, treat it as expiresIn in minutes (old 2-arg form)
  let resolvedSecret: string;
  let resolvedExpiresIn: number;
  if (typeof secretOrExpiresIn === "number") {
    resolvedSecret = process.env.TINA4_SECRET ?? "";
    resolvedExpiresIn = secretOrExpiresIn;
  } else {
    resolvedSecret = secretOrExpiresIn ?? process.env.TINA4_SECRET ?? "";
    resolvedExpiresIn = expiresIn;
  }

  if (!resolvedSecret) {
    _warnBlankSecret();
  }
  // Throws on an algorithm we cannot sign — never silently downgrades to HS256.
  const resolvedAlgorithm = resolveAlgorithm(algorithm);

  const header = { alg: resolvedAlgorithm, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);

  const claims: Record<string, unknown> = { ...payload, iat: now };
  // expiresIn is in MINUTES (parity with Python/PHP/Ruby); 0 ⇒ non-expiring.
  if (resolvedExpiresIn !== 0) {
    claims.exp = now + resolvedExpiresIn * 60;
  }

  const h = base64urlEncode(Buffer.from(JSON.stringify(header)));
  const p = base64urlEncode(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${h}.${p}`;
  const signature = sign(signingInput, resolvedSecret, resolvedAlgorithm);

  return `${h}.${p}.${signature}`;
}

/**
 * Validate a JWT token. Returns the decoded payload on success, `null` if
 * invalid/expired/malformed.
 *
 * 3.13.0 — return type changed from `boolean` to `Record<string, unknown> | null`.
 * Matches the convention used by `jsonwebtoken` and the Python / PHP / Ruby
 * Auth.validToken signatures shipped at the same time. Legacy
 * `if (validToken(t))` patterns keep working because a non-null object is
 * truthy and null is falsy.
 *
 * Secret is read from `process.env.TINA4_SECRET` when not passed explicitly.
 * Algorithm is read from `process.env.TINA4_JWT_ALGORITHM` (default "HS256").
 *
 * Checks, in order: the header's `alg` must BE the expected algorithm (blocks alg
 * substitution, including `alg: "none"`, before any signature work), then the
 * signature, then `exp`, then `nbf` (with `JWT_LEEWAY_SECONDS` of clock skew).
 */
export function validToken(token: string, secret?: string, algorithm?: string): Record<string, unknown> | null {
  const resolvedSecret = secret ?? process.env.TINA4_SECRET ?? "";
  if (!resolvedSecret) {
    _warnBlankSecret();
  }
  // Resolved OUTSIDE the try so a bad TINA4_JWT_ALGORITHM throws rather than
  // being swallowed into a null. A misconfigured algorithm is a deployment
  // error, not a bad token: swallowing it turns one actionable message into a
  // silent 401 on every request, which is far harder to diagnose. It also could
  // not hide the fault anyway - getToken() already throws on the same value, so
  // a typo surfaces at login regardless; swallowing here only made the two paths
  // disagree. Python (master, raises in the constructor) and PHP both throw.
  const resolvedAlgorithm = resolveAlgorithm(algorithm);

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [h, p, sig] = parts;

    // Pin the algorithm to OUR configured one instead of trusting the token's
    // header. A token asking to be verified as anything else — "none", a weaker
    // HMAC, or an RSA alg when we sign HMAC — is rejected BEFORE any signature
    // work, which is what blocks alg substitution. Matches the Python master.
    const header = JSON.parse(base64urlDecode(h).toString()) as Record<string, unknown>;
    if (header.alg !== resolvedAlgorithm) return null;

    const signingInput = `${h}.${p}`;
    if (!verifySignature(signingInput, sig, resolvedSecret, resolvedAlgorithm)) {
      return null;
    }

    const payload = JSON.parse(base64urlDecode(p).toString()) as Record<string, unknown>;

    // Integer seconds, so all four frameworks compare the SAME number. PHP/Ruby
    // read an integer clock and Python/Node a float one; with a float clock
    // `now > exp` and `now >= exp` differ only on an exactly integral instant,
    // so truncating here is what makes the boundary identical everywhere rather
    // than merely close.
    const now = Math.floor(Date.now() / 1000);

    // RFC 7519 s4.1.4: "The processing of the 'exp' claim requires that the
    // current date/time MUST be before the expiration date/time". now == exp is
    // therefore ALREADY expired, so the test is >=. A PRESENT but malformed exp
    // is rejected: the old `typeof payload.exp === "number"` SKIPPED the whole
    // check for `exp: "abc"` / `exp: null`, so a malformed claim read as a token
    // that never expires. No exp key at all stays unconstrained (non-breaking).
    if (Object.hasOwn(payload, "exp")) {
      const expires = numericDate(payload.exp);
      if (expires === null || now >= expires) return null;
    }

    // "nbf" (not-before): a post-dated token is not valid YET. Was honoured only
    // by Ruby, so Python/PHP/Node accepted tokens their issuer had explicitly
    // marked as not-yet-usable (nodejs#39 / python#107). Tolerates
    // JWT_LEEWAY_SECONDS of clock skew, which RFC 7519 s4.1.5 permits. Same
    // malformed-is-rejected rule as exp, through the same helper so the two
    // claims can never drift apart.
    if (Object.hasOwn(payload, "nbf")) {
      const notBefore = numericDate(payload.nbf);
      if (notBefore === null || now + JWT_LEEWAY_SECONDS < notBefore) return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Get the JWT payload WITHOUT verifying signature or expiration.
 */
export function getPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(base64urlDecode(parts[1]).toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Signing helpers ───────────────────────────────────────────────

function sign(input: string, secret: string, algorithm: string): string {
  // The digest comes from the configured algorithm, so the "alg" we advertise in
  // the header is the one that actually produced this signature.
  const digest = HMAC_DIGESTS.get(algorithm);
  if (digest) {
    return base64urlEncode(createHmac(digest, secret).update(input).digest());
  }
  const rsaAlgorithm = RSA_SIGN_ALGORITHMS.get(algorithm);
  if (rsaAlgorithm) {
    const signer = createSign(rsaAlgorithm);
    signer.update(input);
    return base64urlEncode(signer.sign(secret));
  }
  throw unsupportedAlgorithmError(algorithm);
}

function verifySignature(input: string, sig: string, secret: string, algorithm: string): boolean {
  if (HMAC_DIGESTS.has(algorithm)) {
    const expected = sign(input, secret, algorithm);
    // Constant-time comparison
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
  const rsaAlgorithm = RSA_SIGN_ALGORITHMS.get(algorithm);
  if (rsaAlgorithm) {
    const verifier = createVerify(rsaAlgorithm);
    verifier.update(input);
    return verifier.verify(secret, base64urlDecode(sig));
  }
  throw unsupportedAlgorithmError(algorithm);
}

// ── Password Hashing (PBKDF2) ────────────────────────────────────

/**
 * Hash a password using PBKDF2-SHA256.
 *
 * @param password   - Plaintext password
 * @param salt       - Hex-encoded salt (auto-generated if omitted)
 * @param iterations - PBKDF2 iterations (default 260000)
 * @returns Format: `pbkdf2_sha256$iterations$salt$hash` (all hex-encoded)
 */
export function hashPassword(
  password: string,
  salt?: string,
  iterations: number = 260000,
): string {
  const actualSalt = salt ?? randomBytes(16).toString("hex");
  const dk = pbkdf2Sync(password, actualSalt, iterations, 32, "sha256");
  return `pbkdf2_sha256$${iterations}$${actualSalt}$${dk.toString("hex")}`;
}

/**
 * Check a password against a PBKDF2 hash string.
 * Supports both $ and : delimiters for backward compatibility.
 */
export function checkPassword(password: string, hash: string): boolean {
  try {
    // Support both $ (standard) and : (legacy) delimiters
    const delimiter = hash.includes("$") ? "$" : ":";
    const parts = hash.split(delimiter);
    if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;

    const iterations = parseInt(parts[1], 10);
    const salt = parts[2];
    const expected = parts[3];

    const dk = pbkdf2Sync(password, salt, iterations, 32, "sha256");
    const actual = dk.toString("hex");

    // Constant-time comparison
    const a = Buffer.from(actual);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── Auth Middleware ───────────────────────────────────────────────

/**
 * Auth middleware that extracts and verifies a Bearer JWT from the
 * Authorization header. On success, attaches the decoded payload to
 * `(request as any).auth`. On failure, sends a 401 JSON response.
 *
 * @param secret    - Signing secret / PEM public key (default: TINA4_SECRET env var).
 * @param algorithm - JWT algorithm. Omit it to honour TINA4_JWT_ALGORITHM (then
 *   HS256). It used to default to the literal "HS256", which SHADOWED the env
 *   var: an app on TINA4_JWT_ALGORITHM=HS512 minted HS512 tokens and this
 *   middleware verified them as HS256, rejecting every valid token.
 */
export function authMiddleware(secret?: string, algorithm?: string): Middleware {
  return (req: Tina4Request, res: Tina4Response, next: () => void): void => {
    const authHeader = req.headers.authorization ?? "";

    if (!authHeader.startsWith("Bearer ")) {
      res({ error: "Unauthorized" }, 401);
      return;
    }

    const token = authHeader.slice(7);
    if (!validToken(token, secret, algorithm)) {
      res({ error: "Unauthorized" }, 401);
      return;
    }

    (req as any).auth = getPayload(token);
    next();
  };
}

// ── Token Refresh ────────────────────────────────────────────────

/**
 * Refresh a JWT token — validate the existing token then re-sign
 * with a fresh expiry.
 *
 * Secret is always read from `process.env.TINA4_SECRET`.
 *
 * @param token     - Existing JWT to refresh
 * @param expiresIn - New lifetime in MINUTES (default 60)
 * @returns New signed JWT string, or null if the input token is invalid/expired
 */
export function refreshToken(
  token: string,
  expiresIn: number = 60,
): string | null {
  if (!validToken(token)) return null;

  const payload = getPayload(token);
  if (!payload) return null;

  // Strip standard timing claims so getToken sets fresh ones
  const { iat: _iat, exp: _exp, ...claims } = payload;
  return getToken(claims, expiresIn);
}

// ── Request Authentication ───────────────────────────────────────

/**
 * Extract a Bearer token from request headers and validate it.
 *
 * @param headers   - Object with header keys (e.g. `{ authorization: "Bearer ..." }`)
 * @param secret    - HMAC secret or PEM public key
 * @param algorithm - Omit it to honour TINA4_JWT_ALGORITHM (then HS256). HS256 /
 *   HS384 / HS512 everywhere; RS256 where the runtime provides it (it does here).
 * @returns Decoded payload, or null if missing/invalid
 */
export function authenticateRequest(
  headers: Record<string, string | string[] | undefined>,
  secret?: string,
  algorithm?: string,
): Record<string, unknown> | null {
  const authHeader =
    (headers.authorization ?? headers.Authorization ?? "") as string;

  if (!authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);

  // Both overrides are FORWARDED. They used to be accepted and dropped - the
  // body called bare validToken(token), so a caller passing secret= or
  // algorithm= silently got the env values instead, and `algorithm` defaulted to
  // the literal "HS256" which additionally shadowed TINA4_JWT_ALGORITHM. Python,
  // PHP and Ruby all honour these; Node was the last one that did not.
  if (validToken(token, secret, algorithm)) return getPayload(token);

  // Fallback: treat Bearer value as API key
  if (validateApiKey(token)) {
    return { _auth: "api_key" };
  }

  return null;
}

// ── API Key Validation ───────────────────────────────────────────

/**
 * Compare an API key against an expected value.
 * If `expected` is omitted, falls back to the `TINA4_API_KEY` env var.
 *
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param provided - The API key provided by the caller
 * @param expected - The correct API key (defaults to `process.env.TINA4_API_KEY`)
 * @returns true if the keys match
 */
export function validateApiKey(
  provided: string,
  expected?: string,
): boolean {
  const key = expected ?? process.env.TINA4_API_KEY;
  if (!key || !provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(key);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Auth Class Wrapper ──────────────────────────────────────────

/**
 * Auth class that wraps the standalone auth functions so both patterns work:
 *
 *   import { Auth } from "tina4-nodejs";
 *   const token = Auth.getToken(payload, secret);
 *
 *   import { getToken } from "tina4-nodejs";
 *   const token = getToken(payload, secret);
 */
export class Auth {
  static getToken = getToken;
  static validToken = validToken;
  static resolveAlgorithm = resolveAlgorithm;
  static algorithmAvailable = algorithmAvailable;
  static availableAlgorithms = availableAlgorithms;
  static getPayload = getPayload;
  static hashPassword = hashPassword;
  static checkPassword = checkPassword;
  static authMiddleware = authMiddleware;
  static refreshToken = refreshToken;
  static authenticateRequest = authenticateRequest;
  static validateApiKey = validateApiKey;
}
