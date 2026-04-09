/**
 * Tina4 Session — Pluggable session backends, zero core dependencies.
 *
 * File-based sessions by default. Redis backend available via raw TCP (no ioredis needed).
 * Database (SQLite) backend available via better-sqlite3.
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
 *   // Database backend (SQLite via better-sqlite3)
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
import { execFileSync } from "node:child_process";
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
   * Execute a Redis command synchronously via a short-lived TCP connection.
   *
   * Returns the raw RESP response string.
   */
  private execSync(args: string[]): string {
    const script = `
      const net = require("node:net");
      const host = ${JSON.stringify(this.host)};
      const port = ${this.port};
      const password = ${JSON.stringify(this.password)};
      const db = ${this.db};
      const args = ${JSON.stringify(args)};

      function buildCommand(a) {
        let cmd = "*" + a.length + "\\r\\n";
        for (const s of a) cmd += "$" + Buffer.byteLength(s) + "\\r\\n" + s + "\\r\\n";
        return cmd;
      }

      function parseResp(buf) {
        const str = buf.toString("utf-8");
        if (str.startsWith("+")) return str.slice(1).split("\\r\\n")[0];
        if (str.startsWith("-")) return "ERR:" + str.slice(1).split("\\r\\n")[0];
        if (str.startsWith(":")) return str.slice(1).split("\\r\\n")[0];
        if (str.startsWith("$-1")) return null;
        if (str.startsWith("$")) {
          const nl = str.indexOf("\\r\\n");
          const len = parseInt(str.slice(1, nl), 10);
          const start = nl + 2;
          return str.slice(start, start + len);
        }
        return str;
      }

      const sock = net.createConnection({ host, port }, () => {
        let commands = "";
        if (password) commands += buildCommand(["AUTH", password]);
        if (db !== 0) commands += buildCommand(["SELECT", String(db)]);
        commands += buildCommand(args);
        sock.write(commands);
      });

      let buffer = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
      });
      sock.on("end", () => {
        // Parse last response (skip AUTH/SELECT responses)
        const lines = buffer.toString("utf-8").split("\\r\\n");
        let responses = [];
        let i = 0;
        while (i < lines.length) {
          const line = lines[i];
          if (!line) { i++; continue; }
          if (line.startsWith("+") || line.startsWith("-") || line.startsWith(":")) {
            responses.push(line);
            i++;
          } else if (line.startsWith("$")) {
            const len = parseInt(line.slice(1), 10);
            if (len === -1) { responses.push(null); i++; }
            else { responses.push(lines[i+1] || ""); i += 2; }
          } else { i++; }
        }
        // The last response is our actual command result
        const result = responses[responses.length - 1];
        if (result === null) process.stdout.write("__NULL__");
        else if (typeof result === "string" && result.startsWith("-")) process.stdout.write("__ERR__" + result);
        else process.stdout.write(String(result ?? "__NULL__"));
      });
      sock.on("error", (err) => {
        process.stderr.write(err.message);
        process.exit(1);
      });
      setTimeout(() => { sock.destroy(); process.exit(1); }, 3000);
    `;

    try {
      const result = execFileSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (result === "__NULL__") return "";
      if (result.startsWith("__ERR__")) return "";
      return result;
    } catch {
      return "";
    }
  }

  private key(sessionId: string): string {
    return `${this.prefix}${sessionId}`;
  }

  read(sessionId: string): SessionData | null {
    const raw = this.execSync(["GET", this.key(sessionId)]);
    if (!raw) return null;
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

  constructor(backend?: string, config?: SessionConfig) {
    const backendType = backend
      ?? config?.backend
      ?? process.env.TINA4_SESSION_BACKEND
      ?? "file";

    this.ttl = config?.ttl
      ?? (process.env.TINA4_SESSION_TTL ? parseInt(process.env.TINA4_SESSION_TTL, 10) : 3600);

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

  /**
   * Start or resume a session.
   * @param sessionId - Existing session ID to resume (optional)
   * @returns The session ID
   */
  start(sessionId?: string): string {
    if (sessionId) {
      const loaded = this.handler.read(sessionId);
      if (loaded) {
        // Check TTL for file backend (Redis handles TTL natively)
        const now = Math.floor(Date.now() / 1000);
        if (loaded._accessed && (now - loaded._accessed) > this.ttl) {
          this.handler.destroy(sessionId);
        } else {
          this.sessionId = sessionId;
          this.data = loaded;
          this.data._accessed = now;
          this.handler.write(this.sessionId, this.data, this.ttl);
          return sessionId;
        }
      }
    }

    // Generate new session
    this.sessionId = randomBytes(16).toString("hex");
    const now = Math.floor(Date.now() / 1000);
    this.data = { _created: now, _accessed: now };
    this.handler.write(this.sessionId, this.data, this.ttl);
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
    this.save();
  }

  /**
   * Delete a key from the session.
   */
  delete(key: string): void {
    if (!this.data) return;
    delete this.data[key];
    this.save();
  }

  /**
   * Destroy the entire session.
   */
  destroy(): void {
    if (this.sessionId) {
      this.handler.destroy(this.sessionId);
    }
    this.sessionId = null;
    this.data = null;
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
   */
  regenerate(): string {
    const oldId = this.sessionId;
    const oldData = this.data;

    // Remove old session
    if (oldId) {
      this.handler.destroy(oldId);
    }

    // New ID, keep data
    this.sessionId = randomBytes(16).toString("hex");
    this.data = oldData ?? { _created: Math.floor(Date.now() / 1000), _accessed: Math.floor(Date.now() / 1000) };
    this.data._accessed = Math.floor(Date.now() / 1000);
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
   */
  cookieHeader(cookieName: string = "tina4_session"): string {
    const sameSite = process.env.TINA4_SESSION_SAMESITE ?? "Lax";
    return `${cookieName}=${this.sessionId}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${this.ttl}`;
  }

  /**
   * Run garbage collection on the session backend.
   * Removes expired file/database sessions. Redis/Valkey/Mongo handle TTL natively.
   */
  gc(): void {
    if (this.handler.gc) {
      this.handler.gc(this.ttl);
    }
  }

  /**
   * Persist session data to the backend.
   */
  save(): void {
    if (!this.sessionId || !this.data) return;
    this.handler.write(this.sessionId, this.data, this.ttl);
  }
}
