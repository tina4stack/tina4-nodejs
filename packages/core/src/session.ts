/**
 * Tina4 Session — Pluggable session backends, zero core dependencies.
 *
 * File-based sessions by default. Redis backend available via raw TCP (no ioredis needed).
 * Database (SQLite) backend available via Node's built-in node:sqlite.
 *
 *   import { Session, RedisSessionHandler } from "@tina4/core";
 *
 *   // File backend (default)
 *   const session = new Session();
 *
 *   // Redis backend
 *   const session = new Session("redis", {
 *     redisHost: "127.0.0.1",
 *     redisPort: 6379,
 *   });
 *
 *   // Database backend (SQLite via node:sqlite)
 *   const session = new Session("database");
 *   // or: new Session("db");
 *
 *   const id = session.start();
 *   session.set("user", { name: "Alice" });
 *   session.get("user");  // { name: "Alice" }
 *   session.destroy();
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Log } from "./logger.js";
import { isTruthy } from "./dotenv.js";
import { respCommandSync } from "./sessionHandlers/respClient.js";
import { RedisNpmSessionHandler } from "./sessionHandlers/redisHandler.js";
import { ValkeySessionHandler } from "./sessionHandlers/valkeyHandler.js";
import { MongoSessionHandler } from "./sessionHandlers/mongoHandler.js";
import { DatabaseSessionHandler } from "./sessionHandlers/databaseHandler.js";

// ── Types ─────────────────────────────────────────────────────────

export interface SessionConfig {
  /** Session backend type: "file", "redis", "valkey", "mongo", "database" (or "db") */
  backend?: string;
  /** File storage path (default: "data/sessions") */
  path?: string;
  /** Time-to-live in seconds (default: 3600) */
  ttl?: number;
  /** Redis host (default: "127.0.0.1") */
  redisHost?: string;
  /** Redis port (default: 6379) */
  redisPort?: number;
  /** Redis password (optional) */
  redisPassword?: string;
  /** Redis key prefix (default: "tina4:session:") */
  redisPrefix?: string;
  /** Redis database index (default: 0) */
  redisDb?: number;
}

interface SessionData {
  _created: number;
  _accessed: number;
  [key: string]: unknown;
}

// ── Session Handler Interface ─────────────────────────────────────

/**
 * Base interface for session storage backends.
 * Implementations must provide read, write, and destroy.
 */
export interface SessionHandler {
  read(sessionId: string): SessionData | null;
  write(sessionId: string, data: SessionData, ttl?: number): void;
  destroy(sessionId: string): void;
  /** Garbage-collect expired sessions. Optional — Redis/Valkey/Mongo handle TTL natively. */
  gc?(maxLifetime: number): void;
}

// ── File Session Handler ──────────────────────────────────────────

export class FileSessionHandler implements SessionHandler {
  private storagePath: string;

  constructor(storagePath?: string) {
    this.storagePath = storagePath
      ?? process.env.TINA4_SESSION_PATH
      ?? "data/sessions";
  }

  private ensureDir(): void {
    if (!existsSync(this.storagePath)) {
      mkdirSync(this.storagePath, { recursive: true });
    }
  }

  private filePath(id: string): string {
    return join(this.storagePath, `${id}.json`);
  }

  read(sessionId: string): SessionData | null {
    const filePath = this.filePath(sessionId);
    try {
      if (!existsSync(filePath)) return null;
      const raw = readFileSync(filePath, "utf-8");
      const wrapper = JSON.parse(raw);
      // Check expiry
      if (wrapper._expires && wrapper._expires > 0 && Date.now() / 1000 > wrapper._expires) {
        try { unlinkSync(filePath); } catch { /* ignore */ }
        return null;
      }
      return (wrapper._data ?? wrapper) as SessionData;
    } catch {
      return null;
    }
  }

  write(sessionId: string, data: SessionData, ttl: number = 0): void {
    this.ensureDir();
    const expires = ttl > 0 ? Math.floor(Date.now() / 1000) + ttl : 0;
    const wrapper = { _data: data, _expires: expires };
    writeFileSync(this.filePath(sessionId), JSON.stringify(wrapper), "utf-8");
  }

  destroy(sessionId: string): void {
    const filePath = this.filePath(sessionId);
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch { /* ignore */ }
  }

  gc(maxLifetime: number = 0): void {
    if (!existsSync(this.storagePath)) return;
    const now = Math.floor(Date.now() / 1000);
    try {
      const files = readdirSync(this.storagePath);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const fullPath = join(this.storagePath, file);
        try {
          const raw = readFileSync(fullPath, "utf-8");
          const wrapper = JSON.parse(raw);
          if (wrapper._expires && wrapper._expires > 0 && now > wrapper._expires) {
            unlinkSync(fullPath);
          }
        } catch {
          // Corrupt file — remove it
          try { unlinkSync(fullPath); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
}

// ── Redis Session Handler (raw TCP, zero dependencies) ────────────

/**
 * Redis session handler using raw TCP (RESP protocol).
 *
 * Uses synchronous socket communication — no external Redis client required.
 * Stores session data as JSON strings with Redis TTL for automatic expiry.
 *
 * Configure via environment variables:
 *   TINA4_SESSION_REDIS_HOST    (default: "127.0.0.1")
 *   TINA4_SESSION_REDIS_PORT    (default: 6379)
 *   TINA4_SESSION_REDIS_PASSWORD (optional)
 *   TINA4_SESSION_REDIS_PREFIX  (default: "tina4:session:")
 *   TINA4_SESSION_REDIS_DB      (default: 0)
 *
 * Or pass via SessionConfig.
 */
export class RedisSessionHandler implements SessionHandler {
  private host: string;
  private port: number;
  private password: string;
  private prefix: string;
  private db: number;

  constructor(config?: SessionConfig) {
    this.host = config?.redisHost
      ?? process.env.TINA4_SESSION_REDIS_HOST
      ?? "127.0.0.1";
    this.port = config?.redisPort
      ?? (process.env.TINA4_SESSION_REDIS_PORT
        ? parseInt(process.env.TINA4_SESSION_REDIS_PORT, 10)
        : 6379);
    this.password = config?.redisPassword
      ?? process.env.TINA4_SESSION_REDIS_PASSWORD
      ?? "";
    this.prefix = config?.redisPrefix
      ?? process.env.TINA4_SESSION_REDIS_PREFIX
      ?? "tina4:session:";
    this.db = config?.redisDb
      ?? (process.env.TINA4_SESSION_REDIS_DB
        ? parseInt(process.env.TINA4_SESSION_REDIS_DB, 10)
        : 0);
  }

  /**
   * Execute a Redis command synchronously against the live server.
   *
   * Delegates to the shared {@link respCommandSync} transport: a genuine key miss
   * yields `""`, and a transport/connection FAILURE (server unreachable, rejected
   * AUTH, timeout) THROWS so the Session boundary can distinguish "not found"
   * (silent) from "backend failed" (log-loud + degrade). Backend-failure parity.
   */
  private execSync(args: string[]): string {
    return respCommandSync(
      { host: this.host, port: this.port, password: this.password, db: this.db },
      args,
      "Redis",
    );
  }

  private key(sessionId: string): string {
    return `${this.prefix}${sessionId}`;
  }

  read(sessionId: string): SessionData | null {
    const raw = this.execSync(["GET", this.key(sessionId)]);
    if (!raw) return null;     // key miss — normal "no session yet", NOT an error
    try {
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }

  write(sessionId: string, data: SessionData, ttl: number = 0): void {
    const json = JSON.stringify(data);
    if (ttl > 0) {
      this.execSync(["SETEX", this.key(sessionId), String(ttl), json]);
    } else {
      this.execSync(["SET", this.key(sessionId), json]);
    }
  }

  destroy(sessionId: string): void {
    this.execSync(["DEL", this.key(sessionId)]);
  }
}

// ── Flash data prefix ─────────────────────────────────────────────

const FLASH_PREFIX = "_flash_";

// ── Session Class ─────────────────────────────────────────────────

export class Session {
  private handler: SessionHandler;
  private ttl: number;
  private sessionId: string | null = null;
  private data: SessionData | null = null;
  /**
   * Dirty flag — set when data changes, cleared only on a successful write.
   * Retained on a failed write so a later save() retries once the backend
   * recovers (mirrors the Python `_dirty` semantics).
   */
  private dirty = false;
  /**
   * Backend-failure policy: log-loud + degrade (default), or re-raise when
   * TINA4_SESSION_STRICT is truthy. A read failure logs + yields an empty
   * session, a write failure logs + returns false (best-effort, dirty
   * retained), destroy/gc failures log + swallow. Parity across all four
   * frameworks. Strict mode is the escape hatch (same as events/seeding).
   */
  private strict: boolean;

  constructor(backend?: string, config?: SessionConfig) {
    const backendType = backend
      ?? config?.backend
      ?? process.env.TINA4_SESSION_BACKEND
      ?? "file";

    this.ttl = config?.ttl
      ?? (process.env.TINA4_SESSION_TTL ? parseInt(process.env.TINA4_SESSION_TTL, 10) : 3600);

    this.strict = isTruthy(process.env.TINA4_SESSION_STRICT);

    // Select handler based on backend type
    switch (backendType) {
      case "redis":
        this.handler = new RedisSessionHandler(config);
        break;
      case "redis-npm": {
        this.handler = new RedisNpmSessionHandler(config);
        break;
      }
      case "valkey": {
        this.handler = new ValkeySessionHandler(config);
        break;
      }
      case "mongo":
      case "mongodb": {
        this.handler = new MongoSessionHandler(config);
        break;
      }
      case "database":
      case "db": {
        this.handler = new DatabaseSessionHandler(config);
        break;
      }
      case "file":
      default:
        this.handler = new FileSessionHandler(config?.path);
        break;
    }
  }

  /**
   * Use a custom session handler (for advanced use cases).
   */
  setHandler(handler: SessionHandler): void {
    this.handler = handler;
  }

  // ── Backend-failure policy: log-loud + degrade ─────────────────────
  //
  // The handlers themselves stay honest — they raise when the backend
  // (Redis/Valkey/Mongo/DB) is unreachable, and return null/empty WITHOUT
  // raising for a genuine "no session yet" miss. The Session layer is the
  // single place that decides the resilience policy so every backend behaves
  // the same: a transient outage logs + degrades rather than 500-ing every
  // request (cascade outage) or vanishing silently (data loss). A genuinely
  // empty result is NOT an error and never reaches these logs.

  private logBackendError(op: string, err: unknown): void {
    const handlerName = (this.handler as object)?.constructor?.name ?? "SessionHandler";
    const message = err instanceof Error ? err.message : String(err);
    Log.error(`Session backend ${op} failed (${handlerName}): ${message}`);
  }

  /** Read through the backend; on FAILURE log + degrade to empty (or re-throw under strict). */
  private safeRead(sessionId: string): SessionData | null {
    try {
      return this.handler.read(sessionId);
    } catch (err) {
      this.logBackendError("read", err);
      if (this.strict) throw err;
      return null;
    }
  }

  /** Write through the backend; on FAILURE log + return false (or re-throw under strict). */
  private safeWrite(sessionId: string, data: SessionData, ttl: number): boolean {
    try {
      this.handler.write(sessionId, data, ttl);
      return true;
    } catch (err) {
      this.logBackendError("write", err);
      if (this.strict) throw err;
      return false;
    }
  }

  /** Destroy through the backend; on FAILURE log + swallow (or re-throw under strict). */
  private safeDestroy(sessionId: string): boolean {
    try {
      this.handler.destroy(sessionId);
      return true;
    } catch (err) {
      this.logBackendError("destroy", err);
      if (this.strict) throw err;
      return false;
    }
  }

  /**
   * Start or resume a session.
   * @param sessionId - Existing session ID to resume (optional)
   * @returns The session ID
   */
  start(sessionId?: string): string {
    if (sessionId) {
      const loaded = this.safeRead(sessionId);
      if (loaded) {
        // Check TTL for file backend (Redis handles TTL natively)
        const now = Math.floor(Date.now() / 1000);
        if (loaded._accessed && (now - loaded._accessed) > this.ttl) {
          this.safeDestroy(sessionId);
        } else {
          this.sessionId = sessionId;
          this.data = loaded;
          this.data._accessed = now;
          this.dirty = false;
          // Refresh the accessed timestamp; a write failure here is logged but
          // must not abort the resume — the request still serves.
          this.safeWrite(this.sessionId, this.data, this.ttl);
          return sessionId;
        }
      }
    }

    // Generate new session
    this.sessionId = randomBytes(16).toString("hex");
    const now = Math.floor(Date.now() / 1000);
    this.data = { _created: now, _accessed: now };
    this.dirty = false;
    this.safeWrite(this.sessionId, this.data, this.ttl);
    return this.sessionId;
  }

  /**
   * Get a value from the session.
   */
  get(key: string, defaultValue?: unknown): unknown {
    if (!this.data) return defaultValue;
    if (key in this.data) {
      return this.data[key] ?? defaultValue;
    }
    return defaultValue;
  }

  /**
   * Set a value in the session.
   */
  set(key: string, value: unknown): void {
    if (!this.data) return;
    this.data[key] = value;
    this.dirty = true;
    this.save();
  }

  /**
   * Delete a key from the session.
   */
  delete(key: string): void {
    if (!this.data) return;
    delete this.data[key];
    this.dirty = true;
    this.save();
  }

  /**
   * Destroy the entire session.
   *
   * A backend failure is logged (never silent) but does not throw under the
   * default policy — local state is cleared regardless so the request proceeds.
   */
  destroy(): void {
    if (this.sessionId) {
      this.safeDestroy(this.sessionId);
    }
    this.sessionId = null;
    this.data = null;
    this.dirty = false;
  }

  /**
   * Get all session data (excluding internal keys).
   */
  all(): Record<string, unknown> {
    if (!this.data) return {};
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.data)) {
      if (!k.startsWith("_")) {
        result[k] = v;
      }
    }
    return result;
  }

  /**
   * Clear all session data (but keep the session alive).
   */
  clear(): void {
    if (!this.data) return;
    const now = Math.floor(Date.now() / 1000);
    this.data = { _created: this.data._created, _accessed: now };
    this.dirty = true;
    this.save();
  }

  /**
   * Check if a key exists in the session.
   */
  has(key: string): boolean {
    if (!this.data) return false;
    return key in this.data;
  }

  /**
   * Regenerate the session ID (keeps data, new ID).
   *
   * Call this right after a successful login or any privilege change to defeat
   * session fixation — the pre-auth ID is destroyed and the data is carried
   * onto a fresh, unguessable ID. A backend destroy/write failure is logged
   * (never silent) but does not throw under the default policy.
   */
  regenerate(): string {
    const oldId = this.sessionId;
    const oldData = this.data;

    // Remove old session
    if (oldId) {
      this.safeDestroy(oldId);
    }

    // New ID, keep data
    this.sessionId = randomBytes(16).toString("hex");
    this.data = oldData ?? { _created: Math.floor(Date.now() / 1000), _accessed: Math.floor(Date.now() / 1000) };
    this.data._accessed = Math.floor(Date.now() / 1000);
    this.dirty = true;
    this.save();
    return this.sessionId;
  }

  /**
   * Dual-mode flash: set with value, get+remove without.
   *
   *   session.flash("message", "Saved!")  // set
   *   session.flash("message")            // get + auto-remove → "Saved!"
   */
  flash(key: string, value?: unknown): unknown {
    const flashKey = `${FLASH_PREFIX}${key}`;
    if (value !== undefined) {
      // Set mode
      this.set(flashKey, value);
      return undefined;
    }
    // Get mode — read and remove
    if (!this.data || !(flashKey in this.data)) return undefined;
    const stored = this.data[flashKey];
    delete this.data[flashKey];
    this.dirty = true;
    this.save();
    return stored;
  }

  /**
   * Get flash data by key (alias for flash(key) without value).
   */
  getFlash(key: string, defaultValue?: unknown): unknown {
    const result = this.flash(key);
    return result !== undefined ? result : defaultValue;
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Return a Set-Cookie header value for this session.
   *
   * Honours these env vars (cross-framework parity):
   *   TINA4_SESSION_NAME      — cookie name (default: "tina4_session")
   *   TINA4_SESSION_SAMESITE  — SameSite attribute (default: "Lax")
   *   TINA4_SESSION_HTTPONLY  — emit HttpOnly (default: true)
   *   TINA4_SESSION_SECURE    — emit Secure (default: false)
   */
  cookieHeader(cookieName?: string): string {
    return buildSessionCookie(this.sessionId, this.ttl, cookieName);
  }

  /**
   * Run garbage collection on the session backend.
   * Removes expired file/database sessions. Redis/Valkey/Mongo handle TTL natively.
   *
   * A backend failure is logged (never silent) but does not throw under the
   * default policy (re-raises under TINA4_SESSION_STRICT=true).
   */
  gc(): void {
    if (!this.handler.gc) return;
    try {
      this.handler.gc(this.ttl);
    } catch (err) {
      this.logBackendError("gc", err);
      if (this.strict) throw err;
    }
  }

  /**
   * Persist session data to the backend.
   *
   * Returns true on a successful persist, false if the backend was unreachable
   * (logged). The dirty flag is cleared only on success so a later save()
   * retries once the backend recovers. A nothing-to-persist call returns true.
   */
  save(): boolean {
    if (!this.sessionId || !this.data) return true;
    if (!this.dirty) return true;
    if (this.safeWrite(this.sessionId, this.data, this.ttl)) {
      this.dirty = false;
      return true;
    }
    return false;  // write failed (logged); dirty RETAINED for retry
  }
}

/**
 * Is the client's scheme HTTPS? Proxy-aware.
 *
 * TLS is normally terminated at a proxy (nginx, HAProxy, ALB, Cloudflare, most
 * container deploys) which then forwards plain HTTP to Node — so the native
 * socket is NOT encrypted on exactly the deployments that ARE https, and it
 * cannot be the only signal. `x-forwarded-proto` carries the scheme the client
 * actually used; a chain of proxies appends each hop ("https, http") and the
 * FIRST is the client-facing one, which is the scheme the browser used.
 *
 * Parity with PHP `Request::isSecureScheme` (tina4-php#175). Spoofable when the
 * app is directly reachable, but the failure mode is self-limiting: a spoofed
 * `https` only makes the cookie MORE restrictive, and `request.ts` already
 * trusts the same header for URL construction — honouring it here is consistent.
 *
 * @param forwardedProto Raw `x-forwarded-proto` value (or a resolved scheme like
 *                       "https"/"http"); "" / undefined means "absent".
 * @param socketEncrypted True when Node terminated TLS itself (direct https, no
 *                        proxy) — the native fallback when no forwarded header.
 */
export function isSecureScheme(forwardedProto?: string, socketEncrypted?: boolean): boolean {
  const forwarded = (forwardedProto ?? "").trim();
  if (forwarded !== "") {
    return forwarded.split(",")[0].trim().toLowerCase() === "https";
  }
  return socketEncrypted === true;
}

/**
 * Resolve the session cookie name — the single source of truth shared by the
 * WRITE side (`buildSessionCookie` / `Session.cookieHeader`) and the READ side
 * (the auto-session cookie parse in `server.ts`), so a cookie written under a
 * renamed name is read back on the next request.
 *
 *   TINA4_SESSION_NAME   Cookie name (default: "tina4_session")
 *
 * Keeping this in one place means the default can never drift between the two
 * sides: an operator who sets `TINA4_SESSION_NAME` renames the cookie on both
 * the emit and the parse paths at once. Parity with Python
 * `session.session_cookie_name()`.
 */
export function sessionCookieName(): string {
  return process.env.TINA4_SESSION_NAME ?? "tina4_session";
}

/**
 * Build the `Set-Cookie` header value for a Tina4 session. Centralised so
 * the auto-cookie path in server.ts and `Session.cookieHeader()` agree on
 * which env vars are honoured and what the defaults are.
 *
 * Env vars (Python parity):
 *   TINA4_SESSION_NAME      — cookie name (default: "tina4_session")
 *   TINA4_SESSION_SAMESITE  — SameSite attribute (default: "Lax")
 *   TINA4_SESSION_HTTPONLY  — emit HttpOnly (default: true)
 *   TINA4_SESSION_SECURE    — emit Secure (default: false; SameSite=None forces it on)
 *
 * `Secure` is emitted when ANY of: TINA4_SESSION_SECURE is truthy; SameSite is
 * `None` (browsers reject a None cookie without Secure); OR the request scheme
 * is https, detected proxy-aware from `forwardedProto` / `socketEncrypted`. The
 * auto-cookie path in server.ts threads the request's scheme in so an HTTPS
 * deploy behind a TLS-terminating proxy ships Secure without the operator
 * having to know about TINA4_SESSION_SECURE (nodejs#34). Plain HTTP with no
 * proxy header and no native TLS stays NOT Secure — an eager Secure would make
 * http://localhost dev cookies undeliverable.
 */
export function buildSessionCookie(
  sessionId: string | null,
  ttl: number,
  cookieName?: string,
  forwardedProto?: string,
  socketEncrypted?: boolean,
): string {
  const name = cookieName ?? sessionCookieName();
  const sameSite = process.env.TINA4_SESSION_SAMESITE ?? "Lax";

  // HttpOnly defaults to TRUE (matches existing behaviour and Python parity).
  // Treat any explicit non-truthy value (false/0/no/off) as opt-out.
  const httpOnlyRaw = process.env.TINA4_SESSION_HTTPONLY;
  const httpOnly = httpOnlyRaw === undefined
    ? true
    : !["false", "0", "no", "off"].includes(httpOnlyRaw.trim().toLowerCase());

  // Secure defaults to FALSE, then turns ON for any of the three signals above.
  const secure = isTruthy(process.env.TINA4_SESSION_SECURE)
    || sameSite.trim().toLowerCase() === "none"
    || isSecureScheme(forwardedProto, socketEncrypted);

  const parts = [`${name}=${sessionId ?? ""}`, "Path=/"];
  if (httpOnly) parts.push("HttpOnly");
  parts.push(`SameSite=${sameSite}`);
  if (secure) parts.push("Secure");
  parts.push(`Max-Age=${ttl}`);
  return parts.join("; ");
}
