/**
 * Tina4 Auth — Zero-dependency JWT, password hashing, and auth middleware.
 *
 * Uses only Node.js built-in `crypto` module. No external dependencies.
 *
 *   import { generateToken, verifyToken, hashPassword, verifyPassword } from "./auth.js";
 *
 *   const token = generateToken({ userId: 1 }, "my-secret");
 *   const payload = verifyToken(token, "my-secret");
 *
 *   const hash = hashPassword("secret123");
 *   verifyPassword("secret123", hash);  // true
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
 * Generate a signed JWT token.
 *
 * @param payload  - Claims to encode (e.g. `{ userId: 1, role: "admin" }`)
 * @param secret   - HMAC secret (HS256) or PEM private key (RS256)
 * @param expiresIn - Lifetime in seconds (default 3600)
 * @param algorithm - "HS256" or "RS256" (default "HS256")
 * @returns Signed JWT string: header.payload.signature
 */
export function generateToken(
  payload: Record<string, unknown>,
  secret: string,
  expiresIn: number = 3600,
  algorithm: string = "HS256",
): string {
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
 * Verify a JWT token and return the decoded payload, or null if invalid/expired.
 */
export function verifyToken(
  token: string,
  secret: string,
  algorithm: string = "HS256",
): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [h, p, sig] = parts;
    const signingInput = `${h}.${p}`;

    if (!verifySignature(signingInput, sig, secret, algorithm)) {
      return null;
    }

    const payload = JSON.parse(base64urlDecode(p).toString()) as Record<string, unknown>;

    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Decode a JWT payload WITHOUT verifying signature or expiration.
 */
export function decodeToken(token: string): Record<string, unknown> | null {
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
 * @returns Format: `pbkdf2_sha256:iterations:salt:hash` (all hex-encoded)
 */
export function hashPassword(
  password: string,
  salt?: string,
  iterations: number = 100000,
): string {
  const actualSalt = salt ?? randomBytes(16).toString("hex");
  const dk = pbkdf2Sync(password, actualSalt, iterations, 32, "sha256");
  return `pbkdf2_sha256:${iterations}:${actualSalt}:${dk.toString("hex")}`;
}

/**
 * Verify a password against a PBKDF2 hash string.
 */
export function verifyPassword(password: string, hash: string): boolean {
  try {
    const parts = hash.split(":");
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
export function authMiddleware(secret: string, algorithm: string = "HS256"): Middleware {
  return (req: Tina4Request, res: Tina4Response, next: () => void): void => {
    const authHeader = req.headers.authorization ?? "";

    if (!authHeader.startsWith("Bearer ")) {
      res({ error: "Unauthorized" }, 401);
      return;
    }

    const token = authHeader.slice(7);
    const payload = verifyToken(token, secret, algorithm);

    if (payload === null) {
      res({ error: "Unauthorized" }, 401);
      return;
    }

    (req as any).auth = payload;
    next();
  };
}
