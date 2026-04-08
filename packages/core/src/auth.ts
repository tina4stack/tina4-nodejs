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
import type { Middleware, Tina4Request, Tina4Response } from "./types.js";

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
 * Secret is always read from `process.env.SECRET`.
 * Algorithm is read from `process.env.TINA4_JWT_ALGORITHM` (default "HS256").
 *
 * @param payload   - Claims to encode (e.g. `{ userId: 1, role: "admin" }`)
 * @param expiresIn - Lifetime in seconds (default 3600)
 * @returns Signed JWT string: header.payload.signature
 */
export function getToken(
  payload: Record<string, unknown>,
  expiresIn: number = 3600,
): string {
  const secret = process.env.SECRET ?? "";
  if (!secret) {
    console.warn("Auth: SECRET not set in .env — using blank secret (insecure)");
  }
  const algorithm = process.env.TINA4_JWT_ALGORITHM ?? "HS256";

  const header = { alg: algorithm, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);

  const claims: Record<string, unknown> = { ...payload, iat: now };
  if (expiresIn !== 0) {
    claims.exp = now + expiresIn;
  }

  const h = base64urlEncode(Buffer.from(JSON.stringify(header)));
  const p = base64urlEncode(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${h}.${p}`;
  const signature = sign(signingInput, secret, algorithm);

  return `${h}.${p}.${signature}`;
}

/**
 * Validate a JWT token and return the decoded payload, or false if invalid/expired.
 *
 * Secret is always read from `process.env.SECRET`.
 * Algorithm is read from `process.env.TINA4_JWT_ALGORITHM` (default "HS256").
 */
export function validToken(token: string): boolean {
  const secret = process.env.SECRET ?? "";
  if (!secret) {
    console.warn("Auth: SECRET not set in .env — using blank secret (insecure)");
  }
  const algorithm = process.env.TINA4_JWT_ALGORITHM ?? "HS256";
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const [h, p, sig] = parts;
    const signingInput = `${h}.${p}`;

    if (!verifySignature(signingInput, sig, secret as string, algorithm)) {
      return false;
    }

    const payload = JSON.parse(base64urlDecode(p).toString()) as Record<string, unknown>;

    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) {
      return false;
    }

    return true;
  } catch {
    return false;
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
  if (algorithm === "HS256") {
    const sig = createHmac("sha256", secret).update(input).digest();
    return base64urlEncode(sig);
  }
  if (algorithm === "RS256") {
    const signer = createSign("RSA-SHA256");
    signer.update(input);
    const sig = signer.sign(secret);
    return base64urlEncode(sig);
  }
  throw new Error(`Unsupported algorithm: ${algorithm}`);
}

function verifySignature(input: string, sig: string, secret: string, algorithm: string): boolean {
  if (algorithm === "HS256") {
    const expected = sign(input, secret, algorithm);
    // Constant-time comparison
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
  if (algorithm === "RS256") {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(input);
    return verifier.verify(secret, base64urlDecode(sig));
  }
  throw new Error(`Unsupported algorithm: ${algorithm}`);
}

// ── Password Hashing (PBKDF2) ────────────────────────────────────

/**
 * Hash a password using PBKDF2-SHA256.
 *
 * @param password   - Plaintext password
 * @param salt       - Hex-encoded salt (auto-generated if omitted)
 * @param iterations - PBKDF2 iterations (default 100000)
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
 */
export function authMiddleware(secret?: string, algorithm: string = "HS256"): Middleware {
  return (req: Tina4Request, res: Tina4Response, next: () => void): void => {
    const authHeader = req.headers.authorization ?? "";

    if (!authHeader.startsWith("Bearer ")) {
      res({ error: "Unauthorized" }, 401);
      return;
    }

    const token = authHeader.slice(7);
    if (!validToken(token)) {
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
 * Secret is always read from `process.env.SECRET`.
 *
 * @param token     - Existing JWT to refresh
 * @param expiresIn - New lifetime in seconds (default 3600)
 * @returns New signed JWT string, or null if the input token is invalid/expired
 */
export function refreshToken(
  token: string,
  expiresIn: number = 3600,
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
 * @param algorithm - "HS256" or "RS256" (default "HS256")
 * @returns Decoded payload, or null if missing/invalid
 */
export function authenticateRequest(
  headers: Record<string, string | string[] | undefined>,
  secret?: string,
  algorithm: string = "HS256",
): Record<string, unknown> | null {
  const authHeader =
    (headers.authorization ?? headers.Authorization ?? "") as string;

  if (!authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);

  // Try JWT first (secret/algorithm params kept for backward compat but validToken reads from env)
  if (validToken(token)) return getPayload(token);

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
  static getPayload = getPayload;
  static hashPassword = hashPassword;
  static checkPassword = checkPassword;
  static authMiddleware = authMiddleware;
  static refreshToken = refreshToken;
  static authenticateRequest = authenticateRequest;
  static validateApiKey = validateApiKey;
}
