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
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Log } from "./logger.js";
import { isTruthy } from "./dotenv.js";
import { respCommandSync } from "./sessionHandlers/respClient.js";
import { ValkeySessionHandler } from "./sessionHandlers/valkeyHandler.js";
import { MemcachedSessionHandler } from "./sessionHandlers/memcachedHandler.js";
import { MongoSessionHandler } from "./sessionHandlers/mongoHandler.js";
import { DatabaseSessionHandler } from "./sessionHandlers/databaseHandler.js";

// ── Types ─────────────────────────────────────────────────────────

export interface SessionConfig {
  /** Session backend type: "file", "redis", "valkey", "mongo", "memcached", "database" (or "db") */
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

// ── Session id validation ─────────────────────────────────────────

/**
 * A session id is OPAQUE — an unguessable lookup token and nothing else. It is
 * never a filename, a path, a SQL fragment or a Redis key fragment, so the only
 * characters it may contain are the ones every backend treats as inert.
 *
 * The alphabet is the RFC 4648 base64url set, which is exactly what all four
 * frameworks already mint: Python `secrets.token_urlsafe(32)`, Ruby
 * `SecureRandom.hex(32)`, PHP/Node `hex(16)`. Validation is therefore
 * non-breaking for every id the family has ever issued, while rejecting the
 * `.` and `/` that turn a cookie into a path traversal.
 *
 * The rule is the ALPHABET, not the length. The vulnerability was `.` and `/`
 * turning a cookie into a path; entropy is not something this check can supply,
 * because unguessability comes from the framework's own minting and an app that
 * calls `start("my-session-id")` is a trusted caller managing its own id, not an
 * attacker. So the floor is 1, and only the 128-character ceiling remains — it
 * bounds what an attacker can push through a backend key.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Is `sessionId` a well-formed opaque session identifier?
 *
 * Callers pass UNTRUSTED input here (the session cookie is attacker-chosen), so
 * anything that is not a string of the opaque alphabet is rejected.
 */
export function isValidSessionId(sessionId: unknown): boolean {
  return typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId);
}

// ── Backend name resolution ───────────────────────────────────────

/**
 * Every accepted backend name, aliases included. Byte-identical membership in
 * all four frameworks. Written once here so the switch below and the error
 * message cannot disagree.
 */
export const VALID_SESSION_BACKENDS = [
  "file", "filesystem",
  "redis",
  "valkey",
  "mongodb", "mongo",
  "memcached", "memcache",
  "database", "db",
] as const;

/** Canonical name of each backend, for the error message (aliases omitted). */
export const CANONICAL_SESSION_BACKENDS = [
  "file", "redis", "valkey", "mongodb", "memcached", "database",
] as const;

/**
 * Names that USED to work, mapped to the message a caller needs to migrate.
 *
 * A retired name must not fall into the generic "unknown backend" message: the
 * operator had a working config, and telling them what replaced it is the whole
 * point. Checked before the membership test so the specific message wins.
 */
const RETIRED_SESSION_BACKENDS: Record<string, string> = {
  "redis-npm":
    'TINA4_SESSION_BACKEND="redis-npm" was removed on 2026-07-31. Use "redis": '
    + "it is the same Redis backend and reads the same TINA4_SESSION_REDIS_* "
    + "settings, over a faster persistent connection.",
};

/**
 * Normalise a backend name and reject anything unrecognised.
 *
 * An UNKNOWN name used to fall through to `default:` in the switch below, which
 * is the file handler. A typo in TINA4_SESSION_BACKEND ("redsi") - or, before
 * this normalisation existed, merely a capital ("Redis") - produced a running
 * app writing sessions to local disk while the operator believed they were in
 * Redis. Nothing logged, nothing failed, and the symptom surfaced much later as
 * users being logged out whenever a request landed on another instance.
 *
 * A BLANK name still means file. An env var set to "" is a SET variable, so it
 * never reaches the `??` default; rejecting blank would break every deployment
 * that clears the var to take the default.
 */
function resolveBackend(name: string): string {
  const normalised = String(name).trim().toLowerCase();
  if (normalised === "") return "file";

  const retired = RETIRED_SESSION_BACKENDS[normalised];
  if (retired) throw new Error(retired);

  if (!(VALID_SESSION_BACKENDS as readonly string[]).includes(normalised)) {
    throw new Error(
      `Unknown session backend "${normalised}". `
      + `Valid backends: ${CANONICAL_SESSION_BACKENDS.join(", ")}. `
      + "Leave TINA4_SESSION_BACKEND unset for the file default.",
    );
  }
  return normalised;
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

  /**
   * Derive the file backing a session id. TWO independent guards, both required.
   *
   * This is the one place a session id becomes a filesystem path, and it used to
   * interpolate the id RAW: `join(storagePath, "../../OUTSIDE/appconfig.json")`
   * left the session directory entirely, so a cookie could read an existing
   * .json from anywhere on disk into `session.all()` and then OVERWRITE it on
   * save. Reproduced on Node 24.9.0 / macOS.
   *
   *  1. VALIDATE — a malformed id is refused outright. It throws rather than
   *     returning null so a hostile id can never be mistaken for an ordinary
   *     cache miss (the Session layer catches it, logs it, and degrades).
   *  2. HASH — the filename is a SHA-256 of the id, matching the Python master
   *     (`hashlib.sha256(session_id.encode()).hexdigest()`). A hex digest cannot
   *     contain a separator or a dot, so even an id that somehow passed the
   *     validator can only ever name a file inside `storagePath`.
   *
   * DEPLOY NOTE: hashing CHANGES the filename for every id, so existing on-disk
   * sessions are orphaned and every logged-in user is logged out ONCE on the
   * deploy that ships this. That is accepted: under strict session mode an old
   * cookie is discarded on a read miss anyway, so the sessions were going to be
   * dropped regardless.
   */
  private filePath(id: string): string {
    if (!isValidSessionId(id)) {
      throw new Error(
        `Invalid session id ${JSON.stringify(id)} — a session id is opaque and must match `
        + `${SESSION_ID_PATTERN.source}. It is never a path, so it is refused rather than `
        + "resolved to a file.",
      );
    }
    return join(this.storagePath, `${createHash("sha256").update(id).digest("hex")}.json`);
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
  /**
   * True when the LAST backend read RAISED rather than returning a miss.
   * Lets `start()` tell "no such session" from "the store is unreachable".
   */
  private lastReadFailed = false;

  constructor(backend?: string, config?: SessionConfig) {
    const backendType = resolveBackend(
      backend
        ?? config?.backend
        ?? process.env.TINA4_SESSION_BACKEND
        ?? "file",
    );

    this.ttl = config?.ttl
      ?? (process.env.TINA4_SESSION_TTL ? parseInt(process.env.TINA4_SESSION_TTL, 10) : 3600);

    this.strict = isTruthy(process.env.TINA4_SESSION_STRICT);

    // Select handler based on backend type
    switch (backendType) {
      case "redis":
        this.handler = new RedisSessionHandler(config);
        break;
      // `redis-npm` was RETIRED here on 2026-07-31 (a Node-only backend NAME for
      // the optional `redis` npm driver, still running execFileSync per command).
      // Its rejection now lives in RETIRED_SESSION_BACKENDS above, so the helpful
      // migration message survives the generic unknown-name check rather than
      // being swallowed by it.
      case "valkey": {
        this.handler = new ValkeySessionHandler(config);
        break;
      }
      case "mongo":
      case "mongodb": {
        this.handler = new MongoSessionHandler(config);
        break;
      }
      case "memcached":
      case "memcache": {
        this.handler = new MemcachedSessionHandler(config);
        break;
      }
      case "database":
      case "db": {
        this.handler = new DatabaseSessionHandler(config);
        break;
      }
      case "file":
      case "filesystem":
        this.handler = new FileSessionHandler(config?.path);
        break;
      default:
        // Unreachable for a user's typo - resolveBackend already rejected it.
        // Only a name that IS in VALID_SESSION_BACKENDS but has no case above can
        // land here, which is a bug in this switch rather than a configuration
        // error, so it must not be swallowed into a file handler either.
        throw new Error(
          `Session backend "${backendType}" is listed in VALID_SESSION_BACKENDS `
          + "but has no handler case. This is a framework bug, not a "
          + "configuration error.",
        );
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

  /**
   * Read through the backend; on FAILURE log + degrade to empty (or re-throw
   * under strict).
   *
   * Sets {@link lastReadFailed} so `start()` can tell "the store answered, and
   * has no such session" from "the store did not answer at all". Strict mode
   * must discard an id only on the first: treating an outage as an unknown id
   * rotates the session id on EVERY request for the whole outage, logging the
   * entire userbase out over one Redis blip and orphaning their stored
   * sessions. The policy is log-loud + degrade, never rotate.
   */
  private safeRead(sessionId: string): SessionData | null {
    this.lastReadFailed = false;
    try {
      return this.handler.read(sessionId);
    } catch (err) {
      this.lastReadFailed = true;
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
   *
   * `sessionId` is UNTRUSTED — it arrives from the session cookie, which the
   * client fully controls. An id that is not a well-formed opaque identifier is
   * DISCARDED and a fresh one minted, never adopted: adopting it let a cookie
   * steer a filesystem path (a `tina4_session=../../OUTSIDE/appconfig` cookie
   * read an existing .json from outside the session directory into
   * `session.all()`, then OVERWROTE it on save) and let an attacker pre-plant a
   * session id that survived the victim's login (session fixation).
   *
   * The check runs BEFORE the read, so a hostile id never reaches a handler at
   * all. A legitimate id from any of the four frameworks passes unchanged.
   *
   * STRICT SESSION MODE (deliberate, and Node is the family reference for it):
   * an id that is WELL-FORMED but UNKNOWN to the backend is also discarded and
   * a fresh one minted — the `if (loaded)` below only adopts an id the store
   * actually knows. That is OWASP's strict mode and PHP's own
   * `session.use_strict_mode=1` default, and it is what stops an attacker
   * planting a session id that survives the victim's login. The validation
   * above sits IN FRONT of it; neither replaces the other.
   *
   * @param sessionId - Existing session ID to resume (optional)
   * @returns The session ID
   */
  start(sessionId?: string): string {
    if (sessionId !== undefined && !isValidSessionId(sessionId)) {
      sessionId = undefined;
    }
    if (sessionId) {
      const loaded = this.safeRead(sessionId);
      if (!loaded && this.lastReadFailed) {
        // The store did not ANSWER. That is not evidence the id is unknown, so
        // keep it and degrade to an empty session rather than rotating.
        this.sessionId = sessionId;
        const now = Math.floor(Date.now() / 1000);
        this.data = { _created: now, _accessed: now };
        this.dirty = false;
        return sessionId;
      }
      if (loaded) {
        // Expiry is the HANDLER's job, and it is decided from the record's own
        // absolute deadline. There used to be a SECOND, relative check here —
        // `loaded._accessed && (now - loaded._accessed) > this.ttl` followed by
        // safeDestroy() — running in series with the handler's absolute one.
        //
        // That is the exact shape that made tina4-php's file backend destroy
        // records on read (a missing stamp fed into a subtraction, failure branch
        // deletes). It was defused here only by the leading `loaded._accessed &&`
        // short-circuit, and it was a landmine: two expiry mechanisms on the same
        // data, one of them the broken shape, and this one judged a stored record
        // against whatever ttl the READER happened to carry rather than the
        // deadline the record was written with.
        const now = Math.floor(Date.now() / 1000);
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
