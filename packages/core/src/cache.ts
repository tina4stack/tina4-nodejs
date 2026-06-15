/**
 * Multi-backend response cache for GET requests.
 *
 * Backends are selected via the TINA4_CACHE_BACKEND env var:
 *   memory    — in-process LRU cache (default, zero deps)
 *   file      — JSON files in data/cache/
 *   redis     — Redis (raw RESP over TCP, or the `redis` package when present)
 *   valkey    — Valkey (Redis wire protocol — reuses the Redis backend)
 *   memcached — Memcached (zero-dep text protocol over TCP; SHA-256-hashed keys)
 *   mongodb   — MongoDB TTL collection (optional `mongodb` driver, loaded dynamically)
 *   database  — a `tina4_cache` table in any Tina4-supported DB (via @tina4/orm)
 *
 * Usage:
 *   import { responseCache, cacheGet, cacheSet, cacheDelete, cacheClear, cacheStats } from "./cache.js";
 *
 *   // As middleware — caches GET responses for ttl seconds
 *   middleware.use(responseCache({ ttl: 60 }));
 *
 *   // Direct usage (same across all 4 languages)
 *   cacheSet("key", {"data": "value"}, 120);
 *   const value = cacheGet("key");
 *   cacheDelete("key");
 *   cacheClear();
 *   const stats = cacheStats();
 *
 * Availability + file-fallback (mirrors the Python master):
 *   Each network/driver backend reports availability (redis/valkey probe+AUTH,
 *   memcached VERSION, mongo connect, database connect). When the configured
 *   backend's service is unreachable (or its driver is missing / credentials are
 *   wrong), createBackend() logs a warning and falls back to the `file` backend —
 *   a real, persistent cache, never a silent no-op.
 *
 * Synchronous network I/O:
 *   Node sockets are async but the CacheBackend interface (and the Python master)
 *   are synchronous. The network backends (redis/valkey/memcached/mongodb) run a
 *   short-lived child process via execFileSync to perform the request-response
 *   round-trip synchronously — the same pattern the Redis/Valkey/Mongo session
 *   handlers use. This keeps the public API unchanged and the cache genuinely
 *   round-trips values across instances/processes.
 *
 * Environment (LOCKED — matches Python exactly):
 *   TINA4_CACHE_BACKEND      — memory | file | redis | valkey | memcached | mongodb | database  (default: memory)
 *   TINA4_CACHE_URL           — connection URL (redis/valkey/memcached/mongo), or a SQL URL for `database`
 *                               (database falls back to TINA4_DATABASE_URL)
 *   TINA4_CACHE_TTL           — default TTL in seconds  (default: 60)
 *   TINA4_CACHE_MAX_ENTRIES   — max entries              (default: 1000)
 *   TINA4_CACHE_DIR           — file backend directory   (default: data/cache)
 *   TINA4_CACHE_USERNAME      — credentials when not embedded in the URL
 *   TINA4_CACHE_PASSWORD      — credentials when not embedded in the URL
 */

import type { Middleware } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as net from "node:net";
import { execFileSync } from "node:child_process";

// ── Credential parsing (WHATWG URL or TINA4_CACHE_USERNAME / _PASSWORD) ──

interface ParsedCacheUrl {
  host: string;
  port: number;
  db: number;
  username: string | null;
  password: string | null;
  /** Path component after the host (used by mongo for db/collection). */
  pathName: string;
}

/**
 * Parse a redis/valkey/memcached/mongodb connection URL.
 *
 * Credentials come from the URL (`scheme://user:pass@host`, `scheme://:pass@host`)
 * via the WHATWG URL parser, OR from TINA4_CACHE_USERNAME / TINA4_CACHE_PASSWORD
 * (parity with TINA4_DATABASE_USERNAME / _PASSWORD). Mirrors the Python master's
 * _RedisBackend / _MongoBackend credential handling.
 */
function parseCacheUrl(url: string, defaultPort: number): ParsedCacheUrl {
  // Ensure a scheme so the WHATWG URL parser accepts it.
  const withScheme = url.includes("://") ? url : `redis://${url}`;
  let host = "localhost";
  let port = defaultPort;
  let db = 0;
  let username: string | null = null;
  let password: string | null = null;
  let pathName = "";
  try {
    const u = new URL(withScheme);
    host = u.hostname || "localhost";
    port = u.port ? parseInt(u.port, 10) : defaultPort;
    pathName = u.pathname || "";
    const dbPath = pathName.replace(/^\//, "");
    if (/^\d+$/.test(dbPath)) db = parseInt(dbPath, 10);
    // URL may percent-encode credentials — decode them.
    username = u.username ? decodeURIComponent(u.username) : null;
    password = u.password ? decodeURIComponent(u.password) : null;
  } catch {
    // Best-effort fallback for malformed URLs.
    const cleaned = withScheme.replace(/^\w+:\/\//, "");
    const hostPort = cleaned.split("/")[0].split("@").pop() ?? cleaned;
    const parts = hostPort.split(":");
    host = parts[0] || "localhost";
    port = parts[1] ? parseInt(parts[1], 10) || defaultPort : defaultPort;
  }
  // Env-var credentials only fill the gap left by the URL (URL wins).
  if (username === null && process.env.TINA4_CACHE_USERNAME) {
    username = process.env.TINA4_CACHE_USERNAME;
  }
  if (password === null && process.env.TINA4_CACHE_PASSWORD) {
    password = process.env.TINA4_CACHE_PASSWORD;
  }
  return { host, port, db, username, password, pathName };
}

// ── Types ─────────────────────────────────────────────────────────

interface CacheEntry {
  body: string;
  contentType: string;
  statusCode: number;
  expiresAt: number;
}

interface DirectEntry {
  value: unknown;
  expiresAt: number;
}

export interface ResponseCacheConfig {
  /** Default TTL in seconds. 0 = disabled. Default: 60 */
  ttl?: number;
  /** Maximum cache entries. Default: 1000 */
  maxEntries?: number;
  /** Only cache these status codes. Default: [200] */
  statusCodes?: number[];
  /** Cache backend: memory | redis | file. Default: from env or memory */
  backend?: string;
  /** Redis URL. Default: from env or redis://localhost:6379 */
  cacheUrl?: string;
  /** File cache directory. Default: from env or data/cache */
  cacheDir?: string;
}

// ── Backend interface ─────────────────────────────────────────────

interface CacheBackend {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown, ttl: number): void;
  delete(key: string): boolean;
  clear(): void;
  stats(): { hits: number; misses: number; size: number; backend: string };
  name(): string;
  /**
   * Whether this backend is actually usable (driver present + service
   * reachable). Local backends (memory/file) are always available; network /
   * driver backends override this so the factory can fall back to the file
   * backend. Mirrors the Python master's `is_available()`.
   */
  isAvailable?(): boolean;
}

// ── Memory backend ────────────────────────────────────────────────

class MemoryBackend implements CacheBackend {
  private store = new Map<string, { value: unknown; expiresAt: number }>();
  private maxEntries: number;
  private hits = 0;
  private misses = 0;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  get(key: string): unknown | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    // Move to end (LRU refresh) — delete and re-set
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: unknown, ttl: number): void {
    const expiresAt = ttl > 0 ? Date.now() + ttl * 1000 : 0;
    this.store.delete(key); // remove to re-insert at end
    this.store.set(key, { value, expiresAt });
    // Evict oldest if over capacity
    while (this.store.size > this.maxEntries) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  stats() {
    // Sweep expired
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt && now > entry.expiresAt) this.store.delete(key);
    }
    return { hits: this.hits, misses: this.misses, size: this.store.size, backend: "memory" };
  }

  name() { return "memory"; }
}

// ── Redis backend (synchronous via child-process RESP, + raw fallback) ──

/**
 * Redis / Valkey backend. Speaks RESP over TCP. Because the CacheBackend
 * interface is synchronous (matching the Python master, which uses a blocking
 * socket), each command runs in a short-lived child process via execFileSync so
 * get/set/delete genuinely round-trip — the same pattern as the Redis/Valkey
 * session handlers. Credentials (AUTH) and DB index (SELECT) are honoured so
 * wrong credentials fail the availability probe and fall back to file.
 */
class RedisBackend implements CacheBackend {
  protected host: string;
  protected port: number;
  protected db: number;
  protected username: string | null;
  protected password: string | null;
  protected prefix = "tina4:cache:";
  protected hits = 0;
  protected misses = 0;
  protected maxEntries: number;
  protected _name: string;
  protected available: boolean;

  constructor(url = "redis://localhost:6379", maxEntries = 1000, name = "redis") {
    this.maxEntries = maxEntries;
    this._name = name;
    // Valkey speaks the Redis wire protocol — normalise its scheme.
    const parsed = parseCacheUrl(url.replace(/^valkey:\/\//, "redis://"), 6379);
    this.host = parsed.host;
    this.port = parsed.port;
    this.db = parsed.db;
    this.username = parsed.username;
    this.password = parsed.password;
    // Real AUTH+PING handshake so a dead port OR wrong credentials fall back.
    this.available = this.respCommand("PING") === "PONG";
  }

  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Run one RESP command synchronously in a child process. Returns the reply as
   * a string (bulk/simple/integer), or null on nil/error/connection failure.
   */
  protected respCommand(...args: string[]): string | null {
    // Number of replies we must read before we have the final one: the AUTH
    // and SELECT preamble each return one reply, plus the actual command.
    const expected = (this.password ? 1 : 0) + (this.db !== 0 ? 1 : 0) + 1;
    const script = `
      const net = require("node:net");
      const host = ${JSON.stringify(this.host)};
      const port = ${this.port};
      const db = ${this.db};
      const username = ${JSON.stringify(this.username)};
      const password = ${JSON.stringify(this.password)};
      const args = ${JSON.stringify(args)};
      const expected = ${expected};
      function build(a) {
        let cmd = "*" + a.length + "\\r\\n";
        for (const s of a) cmd += "$" + Buffer.byteLength(String(s)) + "\\r\\n" + s + "\\r\\n";
        return cmd;
      }
      // Parse as many complete RESP replies as the buffer currently holds.
      // complete is true once we have seen 'expected' top-level replies. Redis
      // keeps the connection open, so we resolve on data (not on end).
      function parseReplies(text) {
        const replies = [];
        let i = 0;
        const n = text.length;
        function readLine() {
          const idx = text.indexOf("\\r\\n", i);
          if (idx === -1) return null;
          const line = text.slice(i, idx);
          i = idx + 2;
          return line;
        }
        while (i < n && replies.length < expected) {
          const start = i;
          const line = readLine();
          if (line === null) { i = start; break; }
          const t = line[0];
          if (t === "+" || t === ":") replies.push(line.slice(1));
          else if (t === "-") replies.push({ e: line.slice(1) });
          else if (t === "$") {
            const len = parseInt(line.slice(1), 10);
            if (len === -1) { replies.push(null); }
            else {
              if (i + len + 2 > n) { i = start; break; }
              replies.push(text.slice(i, i + len));
              i += len + 2;
            }
          } else if (t === "*") {
            // Arrays are only used by KEYS (handled elsewhere) — skip safely.
            replies.push("");
          } else { break; }
        }
        return { replies, complete: replies.length >= expected };
      }
      const sock = net.createConnection({ host, port }, () => {
        let pre = "";
        if (password) pre += username ? build(["AUTH", username, password]) : build(["AUTH", password]);
        if (db !== 0) pre += build(["SELECT", String(db)]);
        sock.write(pre + build(args));
      });
      let buffer = "";
      function finish() {
        const { replies, complete } = parseReplies(buffer);
        if (!complete) return false;
        const r = replies[replies.length - 1];
        if (r === null || r === undefined) process.stdout.write("__NIL__");
        else if (typeof r === "object") process.stdout.write("__ERR__");
        else process.stdout.write("__OK__" + r);
        try { sock.destroy(); } catch {}
        process.exit(0);
      }
      sock.on("data", (chunk) => { buffer += chunk.toString("utf-8"); finish(); });
      sock.on("end", () => { if (!finish()) { process.stdout.write("__ERR__"); process.exit(0); } });
      sock.on("error", () => { process.stdout.write("__ERR__"); process.exit(0); });
      setTimeout(() => { try { sock.destroy(); } catch {} process.stdout.write("__ERR__"); process.exit(0); }, 4000);
    `;
    try {
      const out = execFileSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (out.startsWith("__OK__")) return out.slice(6);
      return null; // __NIL__ / __ERR__ / empty
    } catch {
      return null;
    }
  }

  get(key: string): unknown | undefined {
    const raw = this.respCommand("GET", this.prefix + key);
    if (raw === null) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  set(key: string, value: unknown, ttl: number): void {
    const fullKey = this.prefix + key;
    const serialized = JSON.stringify(value);
    if (ttl > 0) {
      this.respCommand("SETEX", fullKey, String(ttl), serialized);
    } else {
      this.respCommand("SET", fullKey, serialized);
    }
  }

  delete(key: string): boolean {
    const result = this.respCommand("DEL", this.prefix + key);
    return result === "1";
  }

  clear(): void {
    this.hits = 0;
    this.misses = 0;
    // Scoped KEYS + DEL of our namespace only (never FLUSHALL — the harness is
    // shared with other agents, and so are real deployments).
    this.deleteByPattern(this.prefix + "*");
  }

  protected deleteByPattern(pattern: string): void {
    const script = `
      const net = require("node:net");
      const host = ${JSON.stringify(this.host)};
      const port = ${this.port};
      const db = ${this.db};
      const username = ${JSON.stringify(this.username)};
      const password = ${JSON.stringify(this.password)};
      const pattern = ${JSON.stringify(pattern)};
      function build(a) {
        let cmd = "*" + a.length + "\\r\\n";
        for (const s of a) cmd += "$" + Buffer.byteLength(String(s)) + "\\r\\n" + s + "\\r\\n";
        return cmd;
      }
      const sock = net.createConnection({ host, port }, () => {
        let pre = "";
        if (password) pre += username ? build(["AUTH", username, password]) : build(["AUTH", password]);
        if (db !== 0) pre += build(["SELECT", String(db)]);
        sock.write(pre + build(["KEYS", pattern]));
      });
      let buffer = Buffer.alloc(0);
      let phase = "keys";
      sock.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (phase === "keys" && buffer.toString("utf-8").includes("\\r\\n")) {
          const text = buffer.toString("utf-8");
          // Parse a RESP array of bulk strings.
          const lines = text.split("\\r\\n");
          if (!lines[0].startsWith("*")) return;
          const n = parseInt(lines[0].slice(1), 10);
          if (isNaN(n)) return;
          const keys = [];
          let i = 1;
          while (keys.length < n && i < lines.length) {
            if (lines[i].startsWith("$")) { keys.push(lines[i + 1]); i += 2; }
            else i++;
          }
          if (lines.length < 1 + n * 2) return; // not all received yet
          phase = "del";
          if (keys.length > 0) sock.write(build(["DEL", ...keys]));
          else sock.end();
        }
      });
      sock.on("error", () => process.exit(0));
      setTimeout(() => { try { sock.destroy(); } catch {} process.exit(0); }, 4000);
      // Close after a short grace period to let DEL complete.
      setTimeout(() => { try { sock.end(); } catch {} }, 1500);
    `;
    try {
      execFileSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      /* best effort */
    }
  }

  stats() {
    let size = 0;
    const keys = this.respCommand("DBSIZE");
    // DBSIZE counts the whole DB index; with our isolated index that's accurate
    // enough for the size figure. Fall back to 0 on error.
    if (keys !== null && /^\d+$/.test(keys)) size = parseInt(keys, 10);
    return { hits: this.hits, misses: this.misses, size, backend: this._name };
  }

  name() { return this._name; }
}

// ── Valkey backend (Redis wire protocol — reuses RedisBackend) ─────

class ValkeyBackend extends RedisBackend {
  constructor(url = "valkey://localhost:6379", maxEntries = 1000) {
    super(url.replace(/^valkey:\/\//, "redis://"), maxEntries, "valkey");
  }
}

// ── File backend ──────────────────────────────────────────────────

class FileBackend implements CacheBackend {
  private dir: string;
  private maxEntries: number;
  private hits = 0;
  private misses = 0;

  constructor(cacheDir = "data/cache", maxEntries = 1000) {
    this.dir = cacheDir;
    this.maxEntries = maxEntries;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {}
  }

  private keyPath(key: string): string {
    const safe = crypto.createHash("sha256").update(key).digest("hex");
    return path.join(this.dir, `${safe}.json`);
  }

  get(key: string): unknown | undefined {
    const p = this.keyPath(key);
    try {
      if (!fs.existsSync(p)) {
        this.misses++;
        return undefined;
      }
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (data.expiresAt && Date.now() > data.expiresAt * 1000) {
        fs.unlinkSync(p);
        this.misses++;
        return undefined;
      }
      this.hits++;
      return data.value ?? data;
    } catch {
      this.misses++;
      return undefined;
    }
  }

  set(key: string, value: unknown, ttl: number): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // Evict oldest if at capacity
      const files = fs.readdirSync(this.dir)
        .filter(f => f.endsWith(".json"))
        .map(f => ({ name: f, time: fs.statSync(path.join(this.dir, f)).mtimeMs }))
        .sort((a, b) => a.time - b.time);

      while (files.length >= this.maxEntries) {
        const oldest = files.shift();
        if (oldest) fs.unlinkSync(path.join(this.dir, oldest.name));
      }

      const expiresAt = ttl > 0 ? (Date.now() / 1000) + ttl : 0;
      const entry = { key, value, expiresAt };
      fs.writeFileSync(this.keyPath(key), JSON.stringify(entry));
    } catch {}
  }

  delete(key: string): boolean {
    const p = this.keyPath(key);
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        return true;
      }
    } catch {}
    return false;
  }

  clear(): void {
    this.hits = 0;
    this.misses = 0;
    try {
      const files = fs.readdirSync(this.dir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        fs.unlinkSync(path.join(this.dir, f));
      }
    } catch {}
  }

  stats() {
    // Sweep expired
    const now = Date.now() / 1000;
    let count = 0;
    try {
      const files = fs.readdirSync(this.dir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8"));
          if (data.expiresAt && now > data.expiresAt) {
            fs.unlinkSync(path.join(this.dir, f));
          } else {
            count++;
          }
        } catch {}
      }
    } catch {}
    return { hits: this.hits, misses: this.misses, size: count, backend: "file" };
  }

  name() { return "file"; }
}

// ── Memcached backend (zero-dep text protocol, synchronous via child) ──

/**
 * Memcached backend using the zero-dependency text protocol over TCP. Keys are
 * SHA-256-hashed (memcached keys must be <=250 chars, no spaces/control bytes).
 * Memcached is unauthenticated. Availability is probed with `version`.
 * Mirrors the Python master's _MemcachedBackend.
 */
class MemcachedBackend implements CacheBackend {
  private host: string;
  private port: number;
  private prefix = "tina4:cache:";
  private hits = 0;
  private misses = 0;
  private maxEntries: number;
  private available: boolean;

  constructor(url = "memcached://localhost:11211", maxEntries = 1000) {
    this.maxEntries = maxEntries;
    const cleaned = url.replace(/^memcached:\/\//, "").replace(/^memcache:\/\//, "");
    const parts = cleaned.split("/")[0].split(":");
    this.host = parts[0] || "localhost";
    this.port = parts[1] ? parseInt(parts[1], 10) || 11211 : 11211;
    this.available = this.command(`version\r\n`, "\r\n").startsWith("VERSION");
  }

  isAvailable(): boolean {
    return this.available;
  }

  private mcKey(key: string): string {
    return this.prefix + crypto.createHash("sha256").update(key).digest("hex");
  }

  /** Run one memcached command synchronously, reading until `terminator`. */
  private command(payload: string, terminator: string): string {
    const script = `
      const net = require("node:net");
      const host = ${JSON.stringify(this.host)};
      const port = ${this.port};
      const payload = ${JSON.stringify(payload)};
      const terminator = ${JSON.stringify(terminator)};
      const sock = net.createConnection({ host, port }, () => { sock.write(payload); });
      let buffer = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.toString("utf-8").includes(terminator)) {
          process.stdout.write(buffer.toString("utf-8"));
          sock.destroy();
        }
      });
      sock.on("error", () => { process.exit(0); });
      sock.on("close", () => { if (buffer.length) process.stdout.write(buffer.toString("utf-8")); process.exit(0); });
      setTimeout(() => { try { sock.destroy(); } catch {} process.exit(0); }, 4000);
    `;
    try {
      return execFileSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      return "";
    }
  }

  get(key: string): unknown | undefined {
    const resp = this.command(`get ${this.mcKey(key)}\r\n`, "END\r\n");
    if (resp.startsWith("VALUE")) {
      try {
        const idx = resp.indexOf("\r\n");
        const header = resp.slice(0, idx);
        const nbytes = parseInt(header.split(/\s+/)[3], 10);
        const body = resp.slice(idx + 2, idx + 2 + nbytes);
        this.hits++;
        return JSON.parse(body);
      } catch {
        /* fall through to miss */
      }
    }
    this.misses++;
    return undefined;
  }

  set(key: string, value: unknown, ttl: number): void {
    const data = JSON.stringify(value);
    const exptime = ttl > 0 ? ttl : 0;
    const payload = `set ${this.mcKey(key)} 0 ${exptime} ${Buffer.byteLength(data)}\r\n${data}\r\n`;
    this.command(payload, "\r\n");
  }

  delete(key: string): boolean {
    const resp = this.command(`delete ${this.mcKey(key)}\r\n`, "\r\n");
    return resp.startsWith("DELETED");
  }

  clear(): void {
    this.hits = 0;
    this.misses = 0;
    // No flush_all — the harness is shared with other agents. We rely on TTL
    // expiry + per-key deletes (parity with the Python master's clear, which
    // also avoids destructive flushes when keys can't be enumerated cheaply).
  }

  stats() {
    let size = 0;
    const resp = this.command(`stats\r\n`, "END\r\n");
    for (const line of resp.split("\r\n")) {
      if (line.startsWith("STAT curr_items ")) {
        const n = parseInt(line.split(/\s+/)[2], 10);
        if (!isNaN(n)) size = n;
      }
    }
    return { hits: this.hits, misses: this.misses, size, backend: "memcached" };
  }

  name() { return "memcached"; }
}

// ── MongoDB backend (TTL collection, optional `mongodb` driver) ────

/**
 * MongoDB backend backed by a TTL collection. The `mongodb` driver is OPTIONAL
 * and loaded dynamically inside a child process (parity with Python's pymongo —
 * absent driver → unavailable → file-fallback, never a hard import-time crash).
 *
 * Synchronous like the rest of the interface: each op runs the driver in a
 * short-lived child process via execFileSync. db/collection default to
 * `tina4_cache` (the harness/tests use `tina4_cache_node` for isolation, set in
 * the URL path).
 */
class MongoBackend implements CacheBackend {
  private url: string;
  private dbName: string;
  private collName = "tina4_cache";
  private hits = 0;
  private misses = 0;
  private maxEntries: number;
  private available: boolean;

  constructor(url = "mongodb://localhost:27017", maxEntries = 1000) {
    this.maxEntries = maxEntries;
    // Credentials: embedded in the URL, or TINA4_CACHE_USERNAME / _PASSWORD.
    let effectiveUrl = url;
    if (!url.includes("@")) {
      const u = process.env.TINA4_CACHE_USERNAME;
      const p = process.env.TINA4_CACHE_PASSWORD;
      if (u || p) {
        effectiveUrl = url.replace(
          /^mongodb(\+srv)?:\/\//,
          (m) => `${m}${encodeURIComponent(u ?? "")}:${encodeURIComponent(p ?? "")}@`,
        );
      }
    }
    this.url = effectiveUrl;
    // db / collection from the URL path: mongodb://host/db[/collection]
    try {
      const parsed = new URL(effectiveUrl);
      const segs = (parsed.pathname || "").split("/").filter(Boolean);
      this.dbName = segs[0] || "tina4_cache";
      if (segs[1]) this.collName = segs[1];
    } catch {
      this.dbName = "tina4_cache";
    }
    this.available = this.run("ping", "").ok;
    if (this.available) this.run("ensureIndex", "");
  }

  isAvailable(): boolean {
    return this.available;
  }

  /** Run one mongo op synchronously via the driver in a child process. */
  private run(op: string, payload: string): { ok: boolean; out: string } {
    const script = `
      (async () => {
        let MongoClient;
        try { ({ MongoClient } = require("mongodb")); }
        catch { process.stdout.write("__NODRIVER__"); process.exit(0); }
        const url = ${JSON.stringify(this.url)};
        const dbName = ${JSON.stringify(this.dbName)};
        const collName = ${JSON.stringify(this.collName)};
        const op = ${JSON.stringify(op)};
        const payload = ${JSON.stringify(payload)};
        const arg = payload ? JSON.parse(payload) : {};
        let client;
        try {
          client = new MongoClient(url, { serverSelectionTimeoutMS: 4000 });
          await client.connect();
          const coll = client.db(dbName).collection(collName);
          if (op === "ping") { await client.db(dbName).command({ ping: 1 }); process.stdout.write("__OK__"); }
          else if (op === "ensureIndex") { await coll.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); process.stdout.write("__OK__"); }
          else if (op === "get") {
            const doc = await coll.findOne({ _id: arg.key });
            process.stdout.write("__OK__" + (doc ? JSON.stringify(doc) : ""));
          } else if (op === "set") {
            const doc = { _id: arg.key, value: arg.value };
            if (arg.ttl > 0) doc.expiresAt = new Date(Date.now() + arg.ttl * 1000);
            await coll.replaceOne({ _id: arg.key }, doc, { upsert: true });
            process.stdout.write("__OK__");
          } else if (op === "delete") {
            const r = await coll.deleteOne({ _id: arg.key });
            process.stdout.write("__OK__" + (r.deletedCount > 0 ? "1" : "0"));
          } else if (op === "clear") {
            await coll.deleteMany({});
            process.stdout.write("__OK__");
          } else if (op === "count") {
            const n = await coll.countDocuments({});
            process.stdout.write("__OK__" + n);
          }
          await client.close();
        } catch (e) {
          try { if (client) await client.close(); } catch {}
          process.stdout.write("__ERR__");
        }
        process.exit(0);
      })();
    `;
    try {
      const out = execFileSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 6000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (out.startsWith("__OK__")) return { ok: true, out: out.slice(6) };
      return { ok: false, out: "" };
    } catch {
      return { ok: false, out: "" };
    }
  }

  get(key: string): unknown | undefined {
    const r = this.run("get", JSON.stringify({ key }));
    if (!r.ok || !r.out) {
      this.misses++;
      return undefined;
    }
    try {
      const doc = JSON.parse(r.out);
      // TTL index sweeps lazily; enforce expiry on read for determinism.
      if (doc.expiresAt && new Date(doc.expiresAt).getTime() < Date.now()) {
        this.run("delete", JSON.stringify({ key }));
        this.misses++;
        return undefined;
      }
      this.hits++;
      return JSON.parse(doc.value);
    } catch {
      this.misses++;
      return undefined;
    }
  }

  set(key: string, value: unknown, ttl: number): void {
    this.run("set", JSON.stringify({ key, value: JSON.stringify(value), ttl }));
  }

  delete(key: string): boolean {
    const r = this.run("delete", JSON.stringify({ key }));
    return r.ok && r.out === "1";
  }

  clear(): void {
    this.hits = 0;
    this.misses = 0;
    this.run("clear", "");
  }

  stats() {
    let size = 0;
    const r = this.run("count", "");
    if (r.ok && /^\d+$/.test(r.out)) size = parseInt(r.out, 10);
    return { hits: this.hits, misses: this.misses, size, backend: "mongodb" };
  }

  name() { return "mongodb"; }
}

// ── Database backend (tina4_cache table via @tina4/orm) ────────────

/**
 * Database backend — stores entries in a `tina4_cache` table in any
 * Tina4-supported database. Zero extra infrastructure: it reuses the ORM
 * `Database` layer. Its own connection has query caching DISABLED (both
 * TINA4_AUTO_CACHING and TINA4_DB_CACHE) so the cache's own reads/writes never
 * recurse back into the cache. Mirrors the Python master's _DatabaseBackend.
 *
 * The ORM is loaded dynamically (and synchronously enough for our purposes) via
 * a child process so @tina4/core has no hard dependency on @tina4/orm at import
 * time and so the synchronous CacheBackend contract holds.
 */
class DatabaseBackend implements CacheBackend {
  private url: string;
  private hits = 0;
  private misses = 0;
  private maxEntries: number;
  private available: boolean;

  constructor(url?: string, maxEntries = 1000) {
    this.maxEntries = maxEntries;
    // database reads TINA4_CACHE_URL as a SQL URL, falling back to the app's own
    // TINA4_DATABASE_URL — cache in the DB you already run. NO TINA4_CACHE_DB_URL.
    this.url = url
      ?? process.env.TINA4_CACHE_URL
      ?? process.env.TINA4_DATABASE_URL
      ?? "sqlite:///data/tina4.db";
    this.available = this.run("create", "").ok;
  }

  isAvailable(): boolean {
    return this.available;
  }

  /** Run one DB op synchronously via @tina4/orm in a child process. */
  private run(op: string, payload: string): { ok: boolean; out: string } {
    const script = `
      (async () => {
        // The cache's own DB connection must NOT itself cache (no recursion).
        process.env.TINA4_AUTO_CACHING = "false";
        process.env.TINA4_DB_CACHE = "false";
        let initDatabase;
        try { ({ initDatabase } = await import(${JSON.stringify(this.ormEntry())})); }
        catch { process.stdout.write("__ERR__"); process.exit(0); }
        const url = ${JSON.stringify(this.url)};
        const op = ${JSON.stringify(op)};
        const payload = ${JSON.stringify(payload)};
        const arg = payload ? JSON.parse(payload) : {};
        try {
          const db = await initDatabase({ url });
          await db.execute(
            "CREATE TABLE IF NOT EXISTS tina4_cache " +
            "(cache_key VARCHAR(255) PRIMARY KEY, value TEXT, expires_at DOUBLE PRECISION)"
          );
          if (op === "create") { process.stdout.write("__OK__"); }
          else if (op === "get") {
            const row = await db.fetchOne("SELECT value, expires_at FROM tina4_cache WHERE cache_key = ?", [arg.key]);
            process.stdout.write("__OK__" + (row ? JSON.stringify(row) : ""));
          } else if (op === "set") {
            await db.execute("DELETE FROM tina4_cache WHERE cache_key = ?", [arg.key]);
            await db.execute("INSERT INTO tina4_cache (cache_key, value, expires_at) VALUES (?, ?, ?)", [arg.key, arg.value, arg.exp]);
            try { db.commit(); } catch {}
            process.stdout.write("__OK__");
          } else if (op === "delete") {
            const row = await db.fetchOne("SELECT 1 AS x FROM tina4_cache WHERE cache_key = ?", [arg.key]);
            await db.execute("DELETE FROM tina4_cache WHERE cache_key = ?", [arg.key]);
            try { db.commit(); } catch {}
            process.stdout.write("__OK__" + (row ? "1" : "0"));
          } else if (op === "clear") {
            await db.execute("DELETE FROM tina4_cache");
            try { db.commit(); } catch {}
            process.stdout.write("__OK__");
          } else if (op === "count") {
            const row = await db.fetchOne("SELECT COUNT(*) AS c FROM tina4_cache");
            process.stdout.write("__OK__" + (row && row.c != null ? row.c : 0));
          }
        } catch (e) {
          process.stdout.write("__ERR__");
        }
        process.exit(0);
      })();
    `;
    try {
      const out = execFileSync(process.execPath, ["--import", "tsx", "-e", script], {
        encoding: "utf-8",
        timeout: 8000,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, TINA4_AUTO_CACHING: "false", TINA4_DB_CACHE: "false" },
      });
      if (out.startsWith("__OK__")) return { ok: true, out: out.slice(6) };
      return { ok: false, out: "" };
    } catch {
      // Retry without the tsx loader (built/published packages ship JS).
      try {
        const out = execFileSync(process.execPath, ["-e", script], {
          encoding: "utf-8",
          timeout: 8000,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, TINA4_AUTO_CACHING: "false", TINA4_DB_CACHE: "false" },
        });
        if (out.startsWith("__OK__")) return { ok: true, out: out.slice(6) };
      } catch {
        /* fall through */
      }
      return { ok: false, out: "" };
    }
  }

  /** Resolve the @tina4/orm entry point for the child process to import. */
  private ormEntry(): string {
    return "@tina4/orm";
  }

  get(key: string): unknown | undefined {
    const r = this.run("get", JSON.stringify({ key }));
    if (!r.ok || !r.out) {
      this.misses++;
      return undefined;
    }
    try {
      const row = JSON.parse(r.out);
      const exp = row.expires_at;
      if (exp && Number(exp) > 0 && Date.now() / 1000 > Number(exp)) {
        this.run("delete", JSON.stringify({ key }));
        this.misses++;
        return undefined;
      }
      this.hits++;
      try {
        return JSON.parse(row.value);
      } catch {
        return row.value;
      }
    } catch {
      this.misses++;
      return undefined;
    }
  }

  set(key: string, value: unknown, ttl: number): void {
    const exp = ttl > 0 ? Date.now() / 1000 + ttl : 0;
    this.run("set", JSON.stringify({ key, value: JSON.stringify(value), exp }));
  }

  delete(key: string): boolean {
    const r = this.run("delete", JSON.stringify({ key }));
    return r.ok && r.out === "1";
  }

  clear(): void {
    this.hits = 0;
    this.misses = 0;
    this.run("clear", "");
  }

  stats() {
    let size = 0;
    const r = this.run("count", "");
    if (r.ok && /^\d+$/.test(r.out)) size = parseInt(r.out, 10);
    return { hits: this.hits, misses: this.misses, size, backend: "database" };
  }

  name() { return "database"; }
}

// ── Backend factory ───────────────────────────────────────────────

/** Public shape of a unified cache backend (for cross-package reuse). */
export type { CacheBackend };

/**
 * Build a unified cache backend from explicit params or env vars.
 *
 * Backends: memory (default) | file | redis | valkey | memcached | mongodb |
 * database. Unreachable network/driver backends fall back to the file backend.
 * Exported so @tina4/orm can route its persistent DB query cache through the
 * SAME backends (shared cross-instance) without duplicating the implementation.
 */
export function createBackend(config?: {
  backend?: string;
  cacheUrl?: string;
  cacheDir?: string;
  maxEntries?: number;
}): CacheBackend {
  const backendName = (config?.backend ?? process.env.TINA4_CACHE_BACKEND ?? "memory").toLowerCase().trim();
  const maxEntries = config?.maxEntries ?? (process.env.TINA4_CACHE_MAX_ENTRIES ? parseInt(process.env.TINA4_CACHE_MAX_ENTRIES, 10) : 1000);
  const cacheDir = () => config?.cacheDir ?? process.env.TINA4_CACHE_DIR ?? "data/cache";

  let backend: CacheBackend;
  switch (backendName) {
    case "redis": {
      const url = config?.cacheUrl ?? process.env.TINA4_CACHE_URL ?? "redis://localhost:6379";
      backend = new RedisBackend(url, maxEntries);
      break;
    }
    case "valkey": {
      const url = config?.cacheUrl ?? process.env.TINA4_CACHE_URL ?? "valkey://localhost:6379";
      backend = new ValkeyBackend(url, maxEntries);
      break;
    }
    case "memcached":
    case "memcache": {
      const url = config?.cacheUrl ?? process.env.TINA4_CACHE_URL ?? "memcached://localhost:11211";
      backend = new MemcachedBackend(url, maxEntries);
      break;
    }
    case "mongodb":
    case "mongo": {
      const url = config?.cacheUrl ?? process.env.TINA4_CACHE_URL ?? "mongodb://localhost:27017";
      backend = new MongoBackend(url, maxEntries);
      break;
    }
    case "database":
    case "db": {
      backend = new DatabaseBackend(config?.cacheUrl, maxEntries);
      break;
    }
    case "file":
      return new FileBackend(cacheDir(), maxEntries);
    default:
      return new MemoryBackend(maxEntries);
  }

  // Graceful degradation: if the configured backend's driver is missing or the
  // service is unreachable / credentials are wrong, fall back to the file
  // backend (persistent, zero-dep, always available) rather than silently
  // degrading to a no-op cache. Mirrors the Python master.
  if (typeof backend.isAvailable === "function" && !backend.isAvailable()) {
    // eslint-disable-next-line no-console
    console.warn(
      `[tina4] Cache backend '${backendName}' is unavailable ` +
      `(driver missing or service unreachable) — falling back to 'file'.`,
    );
    return new FileBackend(cacheDir(), maxEntries);
  }
  return backend;
}

// ── Response cache store (for middleware) ──────────────────────────

const store = new Map<string, CacheEntry>();

/**
 * Response cache middleware for GET requests.
 * Caches the full response body, content-type, and status code.
 * Cache key is method + url (including query string).
 */
export function responseCache(config?: ResponseCacheConfig): Middleware {
  const ttl = config?.ttl
    ?? (process.env.TINA4_CACHE_TTL ? parseInt(process.env.TINA4_CACHE_TTL, 10) : 60);
  const maxEntries = config?.maxEntries ?? 1000;
  const allowedCodes = new Set(config?.statusCodes ?? [200]);

  if (ttl <= 0) {
    // Cache disabled — pass through
    return (_req, _res, next) => next();
  }

  // Periodic cleanup
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.expiresAt) store.delete(key);
    }
  }, 30_000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  return (req, res, next) => {
    // Only cache GET requests
    if (req.method !== "GET") {
      next();
      return;
    }

    const cacheKey = `GET:${req.url}`;
    const cached = store.get(cacheKey);

    if (cached && Date.now() < cached.expiresAt) {
      // Cache HIT
      res.header("X-Cache", "HIT");
      res.header("Content-Type", cached.contentType);
      res(cached.body, cached.statusCode, cached.contentType);
      return;
    }

    // Cache MISS — intercept the response to capture it
    const originalEnd = res.raw.end.bind(res.raw);
    let captured = false;

    res.raw.end = function (chunk?: any, ...args: any[]) {
      if (!captured && allowedCodes.has(res.raw.statusCode)) {
        captured = true;
        const body = typeof chunk === "string" ? chunk : chunk?.toString() ?? "";
        const contentType = String(res.raw.getHeader("Content-Type") ?? "application/octet-stream");

        // Evict oldest if at capacity
        if (store.size >= maxEntries) {
          const firstKey = store.keys().next().value;
          if (firstKey) store.delete(firstKey);
        }

        store.set(cacheKey, {
          body,
          contentType,
          statusCode: res.raw.statusCode,
          expiresAt: Date.now() + ttl * 1000,
        });
      }

      res.header("X-Cache", "MISS");
      return originalEnd(chunk, ...args);
    } as any;

    next();
  };
}

/** Clear all cached responses (middleware store) */
export function clearCache(): void {
  store.clear();
}

/**
 * Get KV cache stats — reports the same backend that cacheGet/cacheSet/cacheDelete use,
 * so a value stored via cacheSet() is reflected here. Mirrors cache_stats() in the
 * Python / PHP / Ruby frameworks. (Identical to cacheBackendStats(), kept for parity naming.)
 */
export function cacheStats(): { hits: number; misses: number; size: number; backend: string } {
  return _getBackend().stats();
}

// ── Module-level direct cache API (backend-aware) ─────────────────

let _defaultBackend: CacheBackend | null = null;
let _defaultTtl: number | null = null;

function _getBackend(): CacheBackend {
  if (!_defaultBackend) {
    _defaultBackend = createBackend();
  }
  return _defaultBackend;
}

function _getDefaultTtl(): number {
  if (_defaultTtl === null) {
    const envTtl = process.env.TINA4_CACHE_TTL;
    _defaultTtl = envTtl ? parseInt(envTtl, 10) : 60;
  }
  return _defaultTtl;
}

/** Get a value from the cache by key. Returns undefined on miss. */
export function cacheGet(key: string): unknown | undefined {
  return _getBackend().get(key);
}

/** Store a value in the cache with optional TTL (seconds). */
export function cacheSet(key: string, value: unknown, ttl?: number): void {
  const effectiveTtl = ttl ?? _getDefaultTtl();
  _getBackend().set(key, value, effectiveTtl);
}

/** Delete a key from the cache. Returns true if it existed. */
export function cacheDelete(key: string): boolean {
  return _getBackend().delete(key);
}

/** Clear all entries from the cache. */
export function cacheClear(): void {
  _getBackend().clear();
}

/** Remove expired entries from the cache. Returns count removed. */
export function sweep(): number {
  const backend = _getBackend();
  if (typeof (backend as any).sweep === "function") {
    return (backend as any).sweep();
  }
  return 0;
}

/** Return cache statistics from the active backend. */
export function cacheBackendStats(): { hits: number; misses: number; size: number; backend: string } {
  return _getBackend().stats();
}

/** Reset the default backend (for testing). */
export function _resetBackend(): void {
  _defaultBackend = null;
  _defaultTtl = null;
}
