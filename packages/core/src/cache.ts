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
 * Usage (the KV/module API is ASYNC on Node — Node is async-everywhere):
 *   import { responseCache, cacheGet, cacheSet, cacheDelete, cacheClear, cacheStats } from "./cache.js";
 *
 *   // As middleware — caches GET responses for ttl seconds
 *   middleware.use(responseCache({ ttl: 60 }));
 *
 *   // Direct usage (await — same semantics as the other 3 languages, async transport)
 *   await cacheSet("key", {"data": "value"}, 120);
 *   const value = await cacheGet("key");
 *   await cacheDelete("key");
 *   await cacheClear();
 *   const stats = await cacheStats();
 *
 * Availability + file-fallback (mirrors the Python master):
 *   Each network/driver backend reports availability (redis/valkey connect+AUTH+PING,
 *   memcached VERSION, mongo connect+ping, database connect). When the configured
 *   backend's service is unreachable (or its driver is missing / credentials are
 *   wrong), createBackend() logs a warning and falls back to the `file` backend —
 *   a real, persistent cache, never a silent no-op. The probe is asynchronous, so
 *   createBackend() returns a Promise.
 *
 * Asynchronous, NATIVE network I/O (NO child process):
 *   The CacheBackend interface is async (get/set/delete/clear/stats return
 *   Promises). The network backends use native async Node I/O — redis/valkey speak
 *   RESP over a node:net socket (with AUTH + SELECT db), memcached speaks its text
 *   protocol over node:net, and mongodb uses the optional `mongodb` driver. No
 *   execFileSync, no child processes — connections are pooled per backend instance
 *   so each cache op is a single async round-trip (~sub-ms locally), not a ~30-80ms
 *   process spawn. Local backends (memory/file/database-sqlite) resolve immediately.
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
  /** RFC 9111 s4.1 — the field names the origin nominated in its Vary header. */
  vary?: string[];
  /** The values those fields had on the request that caused this to be stored. */
  varyValues?: Record<string, string | undefined>;
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
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttl: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  /**
   * Evict expired entries and return HOW MANY were actually evicted.
   *
   * REQUIRED, not optional. It used to be neither declared nor implemented, so
   * the module-level sweep() found no backend method and returned a permanent
   * 0: the one API whose job is reclaiming expired space did nothing and
   * reported success. Declaring it here makes "every provider can sweep" a
   * compile-time fact instead of a runtime hope.
   *
   * 0 is the HONEST answer on redis/valkey/memcached/mongodb - they expire
   * entries server-side, so there is nothing left for us to evict. It is the
   * WRONG answer for memory, file and database, which own their own expiry.
   */
  sweep(): Promise<number>;
  stats(): Promise<{ hits: number; misses: number; size: number; backend: string }>;
  name(): string;
  /**
   * Whether this backend is actually usable (driver present + service
   * reachable). Local backends (memory/file) are always available; network /
   * driver backends override this so the factory can fall back to the file
   * backend. Mirrors the Python master's `is_available()`. Probed asynchronously
   * (connect/AUTH/PING/VERSION/ping) so no child process is spawned.
   */
  isAvailable?(): Promise<boolean>;
  /** One-time async connect/probe. Resolves once the backend has decided
   *  availability; createBackend() awaits this before falling back to file. */
  ready?(): Promise<void>;
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

  async get(key: string): Promise<unknown | undefined> {
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

  async set(key: string, value: unknown, ttl: number): Promise<void> {
    const expiresAt = ttl > 0 ? Date.now() + ttl * 1000 : 0;
    this.store.delete(key); // remove to re-insert at end
    this.store.set(key, { value, expiresAt });
    // Evict oldest if over capacity
    while (this.store.size > this.maxEntries) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Drop expired entries and count them. `expiresAt > 0` is load-bearing: an
   * entry stored with ttl <= 0 is permanent and carries 0, so a bare
   * `now > expiresAt` would evict every permanent entry on the first sweep.
   */
  async sweep(): Promise<number> {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt > 0 && now > entry.expiresAt) {
        this.store.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  async stats() {
    // Sweep expired
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt && now > entry.expiresAt) this.store.delete(key);
    }
    return { hits: this.hits, misses: this.misses, size: this.store.size, backend: "memory" };
  }

  name() { return "memory"; }
}

// ── Zero-dep async RESP client over node:net (no child process) ──────

/** A RESP reply: string (simple/bulk/integer), array, null (nil), or Error. */
type RespReply = string | RespReply[] | null | Error;

/**
 * Minimal async RESP client over a single persistent node:net socket. Commands
 * are pipelined and replies dequeued in order (Redis preserves command order on
 * one connection). Zero dependencies — preferred over adding redis/ioredis as a
 * hard dep. Handles AUTH + SELECT on connect so wrong credentials surface as a
 * failed handshake (→ file fallback). Replaces the old execFileSync transport.
 */
class RespClient {
  private host: string;
  private port: number;
  private db: number;
  private username: string | null;
  private password: string | null;
  private sock: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private waiters: Array<{ resolve: (r: RespReply) => void; reject: (e: Error) => void }> = [];
  private connecting: Promise<void> | null = null;
  private connected = false;
  private brokenError: Error | null = null;

  constructor(opts: { host: string; port: number; db: number; username: string | null; password: string | null }) {
    this.host = opts.host;
    this.port = opts.port;
    this.db = opts.db;
    this.username = opts.username;
    this.password = opts.password;
  }

  /** Encode a RESP command (array of bulk strings). */
  private static encode(args: (string | number)[]): Buffer {
    let cmd = `*${args.length}\r\n`;
    for (const a of args) {
      const s = String(a);
      cmd += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
    }
    return Buffer.from(cmd, "utf-8");
  }

  /** Connect once, run the AUTH/SELECT handshake. Idempotent. */
  private connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      sock.setNoDelay(true);
      const onError = (err: Error) => {
        this.brokenError = err;
        // Fail every pending waiter so callers don't hang.
        for (const w of this.waiters.splice(0)) w.reject(err);
        this.connected = false;
        try { sock.destroy(); } catch { /* noop */ }
        reject(err);
      };
      sock.once("error", onError);
      sock.on("data", (chunk) => this.onData(chunk));
      sock.on("close", () => {
        this.connected = false;
        const err = this.brokenError ?? new Error("redis connection closed");
        for (const w of this.waiters.splice(0)) w.reject(err);
      });
      sock.once("connect", async () => {
        this.sock = sock;
        this.connected = true;
        try {
          if (this.password) {
            const authArgs = this.username
              ? ["AUTH", this.username, this.password]
              : ["AUTH", this.password];
            const r = await this.raw(authArgs);
            if (r instanceof Error) throw r;
          }
          if (this.db !== 0) {
            const r = await this.raw(["SELECT", String(this.db)]);
            if (r instanceof Error) throw r;
          }
          // Swap the bootstrap error handler for a non-rejecting one.
          sock.removeListener("error", onError);
          sock.on("error", (e: Error) => { this.brokenError = e; });
          resolve();
        } catch (e) {
          onError(e as Error);
        }
      });
    });
    return this.connecting;
  }

  /** Feed incoming bytes through the RESP parser and settle waiters in order. */
  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    // Parse as many complete replies as the buffer holds.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const parsed = RespClient.parse(this.buffer, 0);
      if (!parsed) break;
      this.buffer = this.buffer.subarray(parsed.next);
      const w = this.waiters.shift();
      if (w) {
        if (parsed.value instanceof Error) w.resolve(parsed.value); // surface as reply, caller decides
        else w.resolve(parsed.value);
      }
    }
  }

  /** Parse one RESP value at offset. Returns null if more bytes are needed. */
  private static parse(buf: Buffer, offset: number): { value: RespReply; next: number } | null {
    if (offset >= buf.length) return null;
    const type = buf[offset];
    const crlf = buf.indexOf("\r\n", offset + 1, "utf-8");
    if (crlf === -1) return null;
    const line = buf.toString("utf-8", offset + 1, crlf);
    const after = crlf + 2;
    switch (type) {
      case 0x2b: // '+' simple string
        return { value: line, next: after };
      case 0x3a: // ':' integer
        return { value: line, next: after };
      case 0x2d: // '-' error
        return { value: new Error(line), next: after };
      case 0x24: { // '$' bulk string
        const len = parseInt(line, 10);
        if (len === -1) return { value: null, next: after };
        if (after + len + 2 > buf.length) return null; // need more
        const str = buf.toString("utf-8", after, after + len);
        return { value: str, next: after + len + 2 };
      }
      case 0x2a: { // '*' array
        const count = parseInt(line, 10);
        if (count === -1) return { value: null, next: after };
        const arr: RespReply[] = [];
        let pos = after;
        for (let i = 0; i < count; i++) {
          const el = RespClient.parse(buf, pos);
          if (!el) return null; // need more
          arr.push(el.value);
          pos = el.next;
        }
        return { value: arr, next: pos };
      }
      default:
        // Unknown type byte — treat the line as a raw reply.
        return { value: line, next: after };
    }
  }

  /** Send one command and await its reply (assumes socket is up). */
  private raw(args: (string | number)[]): Promise<RespReply> {
    return new Promise<RespReply>((resolve, reject) => {
      if (!this.sock || this.sock.destroyed) {
        reject(this.brokenError ?? new Error("redis socket not connected"));
        return;
      }
      this.waiters.push({ resolve, reject });
      this.sock.write(RespClient.encode(args));
    });
  }

  /** Public: connect-if-needed then send one command. */
  async command(...args: (string | number)[]): Promise<RespReply> {
    await this.connect();
    return this.raw(args);
  }

  close(): void {
    try { this.sock?.destroy(); } catch { /* noop */ }
    this.sock = null;
    this.connected = false;
  }
}

// ── Redis backend (native async RESP over node:net — no child process) ──

/**
 * Redis / Valkey backend. Speaks RESP over a single persistent node:net socket
 * via the zero-dep RespClient above — no execFileSync, no child process. Each
 * cache op is one async round-trip. AUTH + SELECT db run once on connect so a
 * dead port OR wrong credentials fail the availability probe and fall back to
 * file. Mirrors the Python master's _RedisBackend semantics (prefix, SETEX,
 * scoped SCAN+DEL clear, DBSIZE stats).
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
  protected client: RespClient;
  protected available = false;
  protected readyPromise: Promise<void>;

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
    this.client = new RespClient({
      host: this.host, port: this.port, db: this.db,
      username: this.username, password: this.password,
    });
    // Real connect + AUTH + PING handshake so a dead port OR wrong credentials
    // fall back to file. Probed asynchronously (await ready() in the factory).
    this.readyPromise = this.probe();
  }

  private async probe(): Promise<void> {
    try {
      const r = await this.client.command("PING");
      this.available = r === "PONG";
    } catch {
      this.available = false;
    }
    if (!this.available) this.client.close();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  async isAvailable(): Promise<boolean> {
    await this.readyPromise;
    return this.available;
  }

  /** One RESP command → reply string, or null on nil/error/connection failure. */
  protected async respCommand(...args: string[]): Promise<string | null> {
    try {
      const r = await this.client.command(...args);
      if (r === null || r === undefined) return null;
      if (r instanceof Error) return null;
      if (Array.isArray(r)) return null; // array replies handled by callers that need them
      return String(r);
    } catch {
      return null;
    }
  }

  async get(key: string): Promise<unknown | undefined> {
    const raw = await this.respCommand("GET", this.prefix + key);
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

  async set(key: string, value: unknown, ttl: number): Promise<void> {
    const fullKey = this.prefix + key;
    const serialized = JSON.stringify(value);
    if (ttl > 0) {
      await this.respCommand("SETEX", fullKey, String(ttl), serialized);
    } else {
      await this.respCommand("SET", fullKey, serialized);
    }
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.respCommand("DEL", this.prefix + key);
    return result === "1";
  }

  /**
   * Remove EVERY entry this cache can serve, and nothing else.
   *
   * SCAN, not KEYS: clear() runs on EVERY WRITE in persistent DB-cache mode,
   * and KEYS is O(N) over the whole keyspace and blocks the entire server for
   * its duration. Redis's own documentation says to prefer SCAN in production.
   * The cursor loop is scoped to our prefix, so another application sharing the
   * server is untouched - FLUSHALL/FLUSHDB would take their data with it and is
   * never used here.
   *
   * The scan runs to cursor 0, so a keyspace larger than one page is fully
   * cleared; stopping at the first page would leave later entries readable and
   * still look green on a small test.
   */
  /**
   * Walk every key under OUR prefix, handing each page to `onPage`.
   *
   * ONE walk drives both clear() and stats(), so the two can never disagree
   * about what this cache holds - which is exactly how stats() came to report a
   * different keyspace from the one clear() empties.
   *
   * SCAN, not KEYS: clear() runs on EVERY WRITE in persistent DB-cache mode,
   * and KEYS is O(N) over the whole keyspace and blocks the entire server for
   * its duration. Redis's own documentation says to prefer SCAN. The walk is
   * scoped to our prefix, so another application sharing the server is
   * untouched, and it runs to cursor 0 so a keyspace larger than one page is
   * fully covered.
   */
  private async walkPrefixedKeys(onPage: (keys: string[]) => Promise<void>): Promise<void> {
    let cursor = "0";
    do {
      const reply = await this.client.command(
        "SCAN", cursor, "MATCH", this.prefix + "*", "COUNT", "500",
      );
      // A SCAN reply is a 2-element multi-bulk: [next cursor, [key, ...]].
      if (!Array.isArray(reply) || reply.length !== 2) break;
      cursor = typeof reply[0] === "string" ? reply[0] : "0";
      const page = reply[1];
      if (Array.isArray(page) && page.length > 0) {
        const keys = page.filter((k): k is string => typeof k === "string");
        if (keys.length > 0) await onPage(keys);
      }
    } while (cursor !== "0");
  }

  async clear(): Promise<void> {
    this.hits = 0;
    this.misses = 0;
    try {
      await this.walkPrefixedKeys(async (keys) => {
        await this.client.command("DEL", ...keys);
      });
    } catch {
      /* best effort */
    }
  }

  /**
   * Nothing to do: redis/valkey expires entries SERVER-SIDE (the TTL set by SETEX), so by the
   * time a sweep runs there is nothing left for us to evict. 0 is the honest
   * count, not a stub - inventing a number here would be a lie, and scanning
   * the keyspace to "prove" it would cost a full scan to always return 0.
   */
  async sweep(): Promise<number> {
    return 0;
  }

  /**
   * Report OUR entries, not the whole server's.
   *
   * This used to read DBSIZE, which counts the WHOLE database index - so on a
   * shared Redis it included every key any other tenant had written. MEASURED
   * before the fix: three of our writes plus two foreign keys reported size 5.
   * Every other backend here is scoped (memory counts its own map, file its own
   * directory, mongo its own collection, database its own table, memcached its
   * own write log), and Ruby/Python had the same rule broken the other way
   * round, returning a constant 0. Both fail the same rule: the number must
   * describe THIS cache.
   *
   * The count comes from the same scoped walk clear() uses. Keys are deduped
   * through a Set because SCAN may return a given key more than once across
   * iterations (Redis guarantees at-least-once, not exactly-once).
   */
  async stats() {
    const seen = new Set<string>();
    try {
      await this.walkPrefixedKeys(async (keys) => {
        for (const key of keys) seen.add(key);
      });
    } catch {
      /* a failed walk reports 0 rather than a number from somewhere else */
    }
    return { hits: this.hits, misses: this.misses, size: seen.size, backend: this._name };
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

  async get(key: string): Promise<unknown | undefined> {
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
      // A cached null must come back as NULL, not as the storage envelope.
      //
      // This was `data.value ?? data`. `data` is the envelope
      // {key, value, expiresAt}, so whenever the stored value was null the
      // `??` fell through and handed the caller that OBJECT - which is truthy -
      // where the caller had stored nothing. Every `if (cached)` then took the
      // hit branch with a meaningless object, so the cache turned "this lookup
      // found nothing" into "this lookup found something". Caching a negative
      // lookup is the most common reason to cache a null at all, so it was
      // wrong exactly where the feature gets used.
      //
      // The test is the ENVELOPE SHAPE, never the value's truthiness: false, 0,
      // "" and [] are values, and a truthiness check would break all of them.
      // The non-envelope fallback stays for a file this backend did not write.
      const isEnvelope = data !== null && typeof data === "object"
        && "value" in data && "expiresAt" in data;
      return isEnvelope ? data.value : data;
    } catch {
      this.misses++;
      return undefined;
    }
  }

  async set(key: string, value: unknown, ttl: number): Promise<void> {
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

  async delete(key: string): Promise<boolean> {
    const p = this.keyPath(key);
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        return true;
      }
    } catch {}
    return false;
  }

  async clear(): Promise<void> {
    this.hits = 0;
    this.misses = 0;
    try {
      const files = fs.readdirSync(this.dir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        fs.unlinkSync(path.join(this.dir, f));
      }
    } catch {}
  }

  async stats() {
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

  /**
   * Delete expired cache files and count them. `expiresAt > 0` is load-bearing:
   * a no-TTL entry is stored with 0 and must survive every sweep.
   */
  async sweep(): Promise<number> {
    const now = Date.now() / 1000;
    let evicted = 0;
    try {
      for (const f of fs.readdirSync(this.dir).filter((n) => n.endsWith(".json"))) {
        const p = path.join(this.dir, f);
        try {
          const data = JSON.parse(fs.readFileSync(p, "utf-8"));
          if (data.expiresAt > 0 && now > data.expiresAt) {
            fs.unlinkSync(p);
            evicted++;
          }
        } catch { /* an unreadable file is not ours to count */ }
      }
    } catch { /* no cache directory yet */ }
    return evicted;
  }

  name() { return "file"; }
}

// ── Memcached client (zero-dep async text protocol over node:net) ───

/**
 * Minimal async memcached client over a single persistent node:net socket. One
 * command in flight at a time, replies read until a terminator. Zero deps, no
 * child process. Memcached is unauthenticated.
 */
class MemcachedClient {
  private host: string;
  private port: number;
  private sock: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private pending: { terminator: string; resolve: (s: string) => void } | null = null;
  private connecting: Promise<void> | null = null;
  private connected = false;

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
  }

  private connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      sock.setNoDelay(true);
      sock.once("error", (err) => { this.connected = false; reject(err); });
      sock.once("connect", () => {
        this.sock = sock;
        this.connected = true;
        sock.on("data", (chunk) => this.onData(chunk));
        sock.on("error", () => { /* surfaced per-command via rejection on next write */ });
        sock.on("close", () => {
          this.connected = false;
          if (this.pending) { const p = this.pending; this.pending = null; p.resolve(this.buffer.toString("utf-8")); }
        });
        resolve();
      });
    });
    return this.connecting;
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.pending && this.buffer.toString("utf-8").includes(this.pending.terminator)) {
      const p = this.pending;
      this.pending = null;
      const out = this.buffer.toString("utf-8");
      this.buffer = Buffer.alloc(0);
      p.resolve(out);
    }
  }

  /**
   * Send one command, resolve with the reply read until `terminator`.
   *
   * Commands are SERIALISED: the socket carries one reply stream with no
   * request ids, so two commands in flight resolve each other's replies. That
   * matters more than it looks - every key now carries a generation READ FROM
   * THE SERVER, so a crossed reply computes the WRONG key and silently reads or
   * overwrites the wrong entry. One command at a time on one socket.
   */
  command(payload: string, terminator: string): Promise<string> {
    const next = this.chain.then(() => this.send(payload, terminator));
    // The chain must never reject, or every later command inherits the failure.
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  private chain: Promise<unknown> = Promise.resolve();

  private async send(payload: string, terminator: string): Promise<string> {
    await this.connect();
    if (!this.sock || this.sock.destroyed) return "";
    return new Promise<string>((resolve) => {
      this.buffer = Buffer.alloc(0);
      this.pending = { terminator, resolve };
      const timer = setTimeout(() => {
        if (this.pending && this.pending.resolve === resolve) {
          this.pending = null;
          resolve(this.buffer.toString("utf-8"));
        }
      }, 4000);
      if (timer.unref) timer.unref();
      this.sock!.write(payload);
    });
  }

  close(): void {
    try { this.sock?.destroy(); } catch { /* noop */ }
    this.sock = null;
    this.connected = false;
  }
}

// ── Memcached backend (native async text protocol — no child process) ──

/**
 * Memcached backend using the zero-dependency text protocol over a persistent
 * node:net socket (no execFileSync). Keys are SHA-256-hashed (memcached keys
 * must be <=250 chars, no spaces/control bytes). Memcached is unauthenticated.
 * Availability is probed asynchronously with `version`. Mirrors the Python
 * master's _MemcachedBackend.
 */
class MemcachedBackend implements CacheBackend {
  private host: string;
  private port: number;
  private prefix = "tina4:cache:";
  private hits = 0;
  private misses = 0;
  private maxEntries: number;
  private client: MemcachedClient;
  private available = false;
  private readyPromise: Promise<void>;

  constructor(url = "memcached://localhost:11211", maxEntries = 1000) {
    this.maxEntries = maxEntries;
    const cleaned = url.replace(/^memcached:\/\//, "").replace(/^memcache:\/\//, "");
    const parts = cleaned.split("/")[0].split(":");
    this.host = parts[0] || "localhost";
    this.port = parts[1] ? parseInt(parts[1], 10) || 11211 : 11211;
    this.client = new MemcachedClient(this.host, this.port);
    this.readyPromise = this.probe();
  }

  private async probe(): Promise<void> {
    try {
      const r = await this.client.command(`version\r\n`, "\r\n");
      this.available = r.startsWith("VERSION");
    } catch {
      this.available = false;
    }
    if (!this.available) this.client.close();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  async isAvailable(): Promise<boolean> {
    await this.readyPromise;
    return this.available;
  }

  /**
   * The SHARED namespace generation counter. clear() bumps it and every real
   * key carries it, so one bump orphans every entry for every instance at once.
   */
  private genKey = this.prefix + "generation";

  /**
   * Read the SHARED namespace generation from the SERVER.
   *
   * memcached has no KEYS scan and no prefix delete, so the only way to
   * invalidate globally without destroying other tenants is the documented
   * namespace idiom: every real key carries a generation, and clear() bumps it.
   * Every instance then computes a different key, and the old entries become
   * unreachable at once, expiring under the server's own TTL/LRU.
   *
   * The generation is read from the server on EVERY key computation,
   * deliberately. Caching it in-process would reintroduce exactly the bug this
   * fixes: an instance holding a stale generation keeps computing the OLD key,
   * the old key still holds the old value, so it serves a stale hit after
   * another instance cleared. One extra round trip on a sub-millisecond local
   * service is the price of cross-instance invalidation.
   */
  private async generation(): Promise<string> {
    const resp = await this.client.command(`get ${this.genKey}\r\n`, "END\r\n");
    if (resp.startsWith("VALUE")) {
      const idx = resp.indexOf("\r\n");
      const nbytes = parseInt(resp.slice(0, idx).split(/\s+/)[3], 10);
      if (idx !== -1 && Number.isFinite(nbytes)) return resp.slice(idx + 2, idx + 2 + nbytes);
    }
    return "0";
  }

  /**
   * Hash to a safe, bounded key (memcached keys: no spaces/control bytes, <=250
   * chars). The generation sits IN the key, so a clear() on ANY instance orphans
   * it for every instance at once.
   */
  private async mcKey(key: string): Promise<string> {
    return `${this.prefix}${await this.generation()}:${crypto.createHash("sha256").update(key).digest("hex")}`;
  }

  async get(key: string): Promise<unknown | undefined> {
    const resp = await this.client.command(`get ${await this.mcKey(key)}\r\n`, "END\r\n");
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

  /**
   * Keys THIS backend wrote, mapped to the moment each expires (0 = never).
   * Memcached has no KEYS/prefix scan, so neither a scoped count nor a scoped
   * clear can be driven from the server - both come from this log.
   */
  private own = new Map<string, number>();

  /**
   * memcached's 30-day cliff: an exptime AT OR BELOW 2592000 is RELATIVE
   * seconds, anything ABOVE it is an ABSOLUTE UNIX TIMESTAMP.
   *
   * The ttl used to be interpolated raw, so any TINA4_CACHE_TTL over 30 days
   * made every write vanish the instant it landed - the caller wrote a number
   * of seconds and the server read a date in 1970. memcached still answers
   * STORED, so it presented as a 100% miss rate with nothing logged: a cache
   * that looks like it is working and never returns a hit.
   *
   * CONVERT, never CLAMP. Clamping to 2592000 also makes the entry survive and
   * is also wrong - it silently discards more than half the lifetime the
   * operator explicitly configured, which is the same class of silent-wrong-
   * answer as the bug it would be replacing.
   */
  private static readonly MAX_RELATIVE_EXPTIME = 2592000;

  private exptimeFor(ttl: number): number {
    if (ttl <= 0) return 0;
    if (ttl > MemcachedBackend.MAX_RELATIVE_EXPTIME) {
      return Math.floor(Date.now() / 1000) + ttl;
    }
    return ttl;
  }

  async set(key: string, value: unknown, ttl: number): Promise<void> {
    const data = JSON.stringify(value);
    const exptime = this.exptimeFor(ttl);
    const mcKey = await this.mcKey(key);
    const payload = `set ${mcKey} 0 ${exptime} ${Buffer.byteLength(data)}\r\n${data}\r\n`;
    await this.client.command(payload, "\r\n");
    // THE WRITE LOG KEEPS THE RAW ttl, never the converted exptime. This line
    // turns its number into a wall-clock deadline, so feeding it a converted
    // absolute timestamp would compute Date.now() + <unix timestamp> * 1000 -
    // about 166 years out - and the log would then never expire anything, so
    // stats() would report expired entries as live forever.
    this.own.set(mcKey, ttl > 0 ? Date.now() + ttl * 1000 : 0);
  }

  async delete(key: string): Promise<boolean> {
    const mcKey = await this.mcKey(key);
    const resp = await this.client.command(`delete ${mcKey}\r\n`, "\r\n");
    this.own.delete(mcKey);
    return resp.startsWith("DELETED");
  }

  /**
   * Invalidate EVERY entry this cache can serve, on EVERY instance.
   *
   * Two wrong answers were shipped before this one. `flush_all` wipes EVERY key
   * on the instance including every other application's - cacheClear() is
   * public API, so calling it destroyed other tenants' data. Deleting only the
   * keys THIS process wrote fixed that but broke the contract the other way: a
   * second instance kept serving rows the first had just invalidated, because
   * it had never seen those keys.
   *
   * The namespace generation does both. Bumping the shared counter orphans
   * every previously-written entry for every instance at once, and touches
   * nothing outside our own prefix. The orphans are reclaimed by memcached's
   * own TTL and LRU - unreachable is what "removed" means for a cache.
   *
   * The local write log is still cleared so stats() reports honestly, and its
   * keys are deleted eagerly so the space comes back immediately rather than
   * waiting for eviction.
   */
  async clear(): Promise<void> {
    this.hits = 0;
    this.misses = 0;
    for (const mcKey of this.own.keys()) {
      await this.client.command(`delete ${mcKey}\r\n`, "\r\n");
    }
    this.own.clear();
    // incr is atomic, so two instances clearing at once still both advance.
    const bumped = await this.client.command(`incr ${this.genKey} 1\r\n`, "\r\n");
    if (!/^\d+/.test(bumped.trim())) {
      // No counter yet: create it. `add` fails harmlessly if another instance
      // created it in the gap, and the incr then applies on top of theirs.
      await this.client.command(`add ${this.genKey} 0 0 1\r\n1\r\n`, "\r\n");
      await this.client.command(`incr ${this.genKey} 1\r\n`, "\r\n");
    }
  }

  /**
   * Report OUR entries, not the whole server's.
   *
   * This used to read memcached's `curr_items`, a GLOBAL counter that includes
   * every key written by every other tenant of that server. Every other backend
   * here is scoped - memory counts its own map, redis/valkey scan their own
   * prefix, file counts its own directory, mongo its own collection, database
   * its own table. Memcached was the only one leaking.
   *
   * The count comes from our own write log, filtered by the TTLs we set. That
   * is exact for the keys this process wrote; a key EVICTED early under memory
   * pressure is invisible to us and would be over-counted, which is a far
   * smaller and more honest error than counting another application's keys.
   */
  async stats() {
    const now = Date.now();
    // Drop the expired ones so the log cannot grow without bound.
    for (const [k, expires] of this.own) {
      if (expires !== 0 && expires <= now) this.own.delete(k);
    }
    return { hits: this.hits, misses: this.misses, size: this.own.size, backend: "memcached" };
  }

  /**
   * Nothing to do: memcached expires entries SERVER-SIDE (the exptime set on each key), so by the
   * time a sweep runs there is nothing left for us to evict. 0 is the honest
   * count, not a stub - inventing a number here would be a lie, and scanning
   * the keyspace to "prove" it would cost a full scan to always return 0.
   */
  async sweep(): Promise<number> {
    return 0;
  }

  name() { return "memcached"; }
}

// ── MongoDB backend (TTL collection, optional `mongodb` driver) ────

/**
 * MongoDB backend backed by a TTL collection, using the OPTIONAL `mongodb`
 * driver loaded dynamically and used ASYNC (no child process). Absent driver →
 * unavailable → file-fallback, never a hard import-time crash (parity with
 * Python's pymongo). One pooled client per backend instance. db/collection
 * default to `tina4_cache` (the harness/tests use `tina4_cache_node` for
 * isolation, set in the URL path).
 */
class MongoBackend implements CacheBackend {
  private url: string;
  private dbName: string;
  private collName = "tina4_cache";
  private hits = 0;
  private misses = 0;
  private maxEntries: number;
  private available = false;
  private readyPromise: Promise<void>;
  // The mongodb driver types aren't depended on at compile time (optional dep).
  private client: any = null;
  private coll: any = null;

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
    this.readyPromise = this.probe();
  }

  /** Connect once via the optional driver; ping + ensure the TTL index. */
  private async probe(): Promise<void> {
    try {
      // Dynamic import so @tina4/core has no hard dependency on `mongodb` and an
      // absent driver degrades to file-fallback (never an import-time crash).
      const mod: any = await import("mongodb").catch(() => null);
      if (!mod || !mod.MongoClient) { this.available = false; return; }
      const client = new mod.MongoClient(this.url, { serverSelectionTimeoutMS: 4000 });
      await client.connect();
      await client.db(this.dbName).command({ ping: 1 });
      const coll = client.db(this.dbName).collection(this.collName);
      await coll.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      this.client = client;
      this.coll = coll;
      this.available = true;
    } catch {
      this.available = false;
      try { await this.client?.close(); } catch { /* noop */ }
      this.client = null;
      this.coll = null;
    }
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  async isAvailable(): Promise<boolean> {
    await this.readyPromise;
    return this.available;
  }

  async get(key: string): Promise<unknown | undefined> {
    if (!this.coll) { this.misses++; return undefined; }
    try {
      const doc = await this.coll.findOne({ _id: key });
      if (!doc) { this.misses++; return undefined; }
      // TTL index sweeps lazily; enforce expiry on read for determinism.
      if (doc.expiresAt && new Date(doc.expiresAt).getTime() < Date.now()) {
        await this.coll.deleteOne({ _id: key });
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

  async set(key: string, value: unknown, ttl: number): Promise<void> {
    if (!this.coll) return;
    try {
      const doc: Record<string, unknown> = { _id: key, value: JSON.stringify(value) };
      if (ttl > 0) doc.expiresAt = new Date(Date.now() + ttl * 1000);
      await this.coll.replaceOne({ _id: key }, doc, { upsert: true });
    } catch { /* best effort */ }
  }

  async delete(key: string): Promise<boolean> {
    if (!this.coll) return false;
    try {
      const r = await this.coll.deleteOne({ _id: key });
      return r.deletedCount > 0;
    } catch {
      return false;
    }
  }

  async clear(): Promise<void> {
    this.hits = 0;
    this.misses = 0;
    if (!this.coll) return;
    try { await this.coll.deleteMany({}); } catch { /* best effort */ }
  }

  async stats() {
    let size = 0;
    if (this.coll) {
      try { size = await this.coll.countDocuments({}); } catch { /* keep 0 */ }
    }
    return { hits: this.hits, misses: this.misses, size, backend: "mongodb" };
  }

  /**
   * Nothing to do: mongodb expires entries SERVER-SIDE (the TTL index on expiresAt), so by the
   * time a sweep runs there is nothing left for us to evict. 0 is the honest
   * count, not a stub - inventing a number here would be a lie, and scanning
   * the keyspace to "prove" it would cost a full scan to always return 0.
   */
  async sweep(): Promise<number> {
    return 0;
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
 * The ORM is loaded with a dynamic `import("@tina4/orm")` (no hard dependency at
 * @tina4/core import time) and used ASYNC — no child process / execFileSync.
 * SQLite is synchronous under the hood; we still expose an async surface so the
 * unified CacheBackend contract holds for every backend.
 */
class DatabaseBackend implements CacheBackend {
  private url: string;
  private hits = 0;
  private misses = 0;
  private maxEntries: number;
  private available = false;
  private readyPromise: Promise<void>;
  // @tina4/orm Database instance (optional dep, loaded dynamically).
  private db: any = null;

  constructor(url?: string, maxEntries = 1000) {
    this.maxEntries = maxEntries;
    // database reads TINA4_CACHE_URL as a SQL URL, falling back to the app's own
    // TINA4_DATABASE_URL — cache in the DB you already run. NO TINA4_CACHE_DB_URL.
    this.url = url
      ?? process.env.TINA4_CACHE_URL
      ?? process.env.TINA4_DATABASE_URL
      ?? "sqlite:///data/tina4.db";
    this.readyPromise = this.probe();
  }

  /** Connect once and ensure the cache table exists. */
  private async probe(): Promise<void> {
    // The cache's own DB connection must NOT itself cache (no recursion).
    const prevAuto = process.env.TINA4_AUTO_CACHING;
    const prevDb = process.env.TINA4_DB_CACHE;
    process.env.TINA4_AUTO_CACHING = "false";
    process.env.TINA4_DB_CACHE = "false";
    try {
      const mod: any = await import("../../orm/src/index.js").catch(() => null);
      if (!mod || !mod.initDatabase) { this.available = false; return; }
      const db = await mod.initDatabase({ url: this.url });
      await db.execute(
        "CREATE TABLE IF NOT EXISTS tina4_cache " +
        "(cache_key VARCHAR(255) PRIMARY KEY, value TEXT, expires_at DOUBLE PRECISION)",
      );
      try { db.commit(); } catch { /* sqlite autocommits DDL */ }
      this.db = db;
      this.available = true;
    } catch {
      this.available = false;
    } finally {
      if (prevAuto === undefined) delete process.env.TINA4_AUTO_CACHING; else process.env.TINA4_AUTO_CACHING = prevAuto;
      if (prevDb === undefined) delete process.env.TINA4_DB_CACHE; else process.env.TINA4_DB_CACHE = prevDb;
    }
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  async isAvailable(): Promise<boolean> {
    await this.readyPromise;
    return this.available;
  }

  async get(key: string): Promise<unknown | undefined> {
    if (!this.db) { this.misses++; return undefined; }
    try {
      const row = await this.db.fetchOne("SELECT value, expires_at FROM tina4_cache WHERE cache_key = ?", [key]);
      if (!row) { this.misses++; return undefined; }
      const exp = row.expires_at;
      if (exp && Number(exp) > 0 && Date.now() / 1000 > Number(exp)) {
        await this.db.execute("DELETE FROM tina4_cache WHERE cache_key = ?", [key]);
        try { this.db.commit(); } catch { /* noop */ }
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

  async set(key: string, value: unknown, ttl: number): Promise<void> {
    if (!this.db) return;
    const exp = ttl > 0 ? Date.now() / 1000 + ttl : 0;
    try {
      await this.db.execute("DELETE FROM tina4_cache WHERE cache_key = ?", [key]);
      await this.db.execute(
        "INSERT INTO tina4_cache (cache_key, value, expires_at) VALUES (?, ?, ?)",
        [key, JSON.stringify(value), exp],
      );
      try { this.db.commit(); } catch { /* noop */ }
    } catch { /* best effort */ }
  }

  async delete(key: string): Promise<boolean> {
    if (!this.db) return false;
    try {
      const row = await this.db.fetchOne("SELECT 1 AS x FROM tina4_cache WHERE cache_key = ?", [key]);
      await this.db.execute("DELETE FROM tina4_cache WHERE cache_key = ?", [key]);
      try { this.db.commit(); } catch { /* noop */ }
      return row != null;
    } catch {
      return false;
    }
  }

  async clear(): Promise<void> {
    this.hits = 0;
    this.misses = 0;
    if (!this.db) return;
    try {
      await this.db.execute("DELETE FROM tina4_cache");
      try { this.db.commit(); } catch { /* noop */ }
    } catch { /* best effort */ }
  }

  async stats() {
    let size = 0;
    if (this.db) {
      try {
        const row = await this.db.fetchOne("SELECT COUNT(*) AS c FROM tina4_cache");
        if (row && row.c != null) size = Number(row.c);
      } catch { /* keep 0 */ }
    }
    return { hits: this.hits, misses: this.misses, size, backend: "database" };
  }

  /**
   * Delete expired rows and return how many went.
   *
   * The network providers return 0 because they expire entries SERVER-SIDE -
   * nothing was evicted because there was nothing left to evict, and 0 is the
   * honest answer there. A SQL TABLE EXPIRES NOTHING BY ITSELF. Before this
   * override the database backend had no sweep at all, so expired rows were
   * removed only when someone happened to read that exact key again: the table
   * grew without bound while the one API whose job is reclaiming that space
   * reported success having done nothing.
   *
   * `expires_at > 0` is load-bearing: an entry stored with ttl <= 0 is
   * permanent and carries 0, so a bare `now > expires_at` would evict every
   * permanent entry on the first sweep.
   */
  async sweep(): Promise<number> {
    if (!this.db) return 0;
    const now = Date.now() / 1000;
    try {
      const row = await this.db.fetchOne(
        "SELECT COUNT(*) AS c FROM tina4_cache WHERE expires_at > 0 AND expires_at < ?",
        [now],
      );
      const expired = row && row.c != null ? Number(row.c) : 0;
      if (expired > 0) {
        await this.db.execute(
          "DELETE FROM tina4_cache WHERE expires_at > 0 AND expires_at < ?", [now],
        );
        try { this.db.commit(); } catch { /* sqlite autocommits */ }
      }
      return expired;
    } catch {
      return 0;
    }
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
 * ASYNC because availability is probed asynchronously (connect/AUTH/PING/ping)
 * — no child process. Exported so @tina4/orm can route its persistent DB query
 * cache through the SAME backends (shared cross-instance) without duplicating
 * the implementation. Callers `await createBackend(...)`.
 */
export async function createBackend(config?: {
  backend?: string;
  cacheUrl?: string;
  cacheDir?: string;
  maxEntries?: number;
}): Promise<CacheBackend> {
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
    case "memory":
    case "":
      return new MemoryBackend(maxEntries);
    default:
      // An UNRECOGNISED name THROWS, naming the bad value and the valid ones —
      // the contract the session layer already settled on. Falling through to
      // memory turned a typo (TINA4_CACHE_BACKEND=redsi) into a running app
      // with a per-process cache while the operator believed it was Redis.
      throw new Error(
        `Unknown cache backend '${backendName}'. Valid backends: ` +
        "memory, file, redis, valkey, memcached, mongodb, database.",
      );
  }

  // Wait for the async connect/probe to settle before deciding availability.
  if (typeof backend.ready === "function") {
    try { await backend.ready(); } catch { /* isAvailable() reflects the failure */ }
  }

  // Graceful degradation: if the configured backend's driver is missing or the
  // service is unreachable / credentials are wrong, fall back to the file
  // backend (persistent, zero-dep, always available) rather than silently
  // degrading to a no-op cache. Mirrors the Python master.
  if (typeof backend.isAvailable === "function" && !(await backend.isAvailable())) {
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

/**
 * The responseCache middleware's backend. Built lazily (and memoised) from the
 * SAME unified `createBackend()` factory as the KV API, so cached GET responses
 * distribute across instances via redis/valkey/memcached/mongodb/database
 * (parity with Python's ResponseCache, which routes through `_create_backend`).
 *
 * The default backend is `memory` (in-process), so the DEFAULT behaviour is
 * unchanged — only an explicit redis/etc. backend distributes. Each middleware
 * instance resolves the shared module-level backend; a fresh middleware
 * instance therefore serves hits stored by an earlier one (cross-instance via a
 * network backend, same-process via memory).
 *
 * Response entries are stored as a plain JSON-serialisable object so every
 * backend (redis SETEX, mongo doc, etc.) can round-trip them.
 */
let _responseBackend: CacheBackend | null = null;
let _responseBackendPromise: Promise<CacheBackend> | null = null;
/**
 * Backends built for an EXPLICITLY configured responseCache, keyed by the
 * provider-affecting part of its config. Kept apart from the shared
 * module-level backend so a named provider is never overridden by ambient state.
 */
const _explicitResponseBackends = new Map<string, Promise<CacheBackend>>();

export function _getResponseBackend(config?: ResponseCacheConfig): Promise<CacheBackend> {
  // An EXPLICITLY requested provider gets its OWN backend; only the
  // no-argument case shares the module-level one (mirrors the Python master).
  //
  // This function used to open with `if (_responseBackend) return ...`, so the
  // memoised backend was handed back BEFORE config was ever read. Once any
  // responseCache middleware existed, every later explicitly-named provider was
  // silently ignored: the developer names a backend, the framework quietly uses
  // a different one, and the only symptom is cache behaviour that does not
  // match the configuration.
  const wantsItsOwn = config?.backend !== undefined
    || config?.cacheUrl !== undefined
    || config?.cacheDir !== undefined
    || config?.maxEntries !== undefined;

  if (wantsItsOwn) {
    // Memoised per DISTINCT config, not per call: the middleware resolves its
    // backend on every request, so building a fresh one each time would open a
    // new connection per request. Two different configs stay two different
    // stores, which is the half that actually matters - honouring the NAME
    // while still returning the shared object would change nothing observable.
    const key = JSON.stringify([config?.backend, config?.cacheUrl, config?.cacheDir, config?.maxEntries]);
    let built = _explicitResponseBackends.get(key);
    if (!built) {
      built = createBackend({
        backend: config?.backend,
        cacheUrl: config?.cacheUrl,
        cacheDir: config?.cacheDir,
        maxEntries: config?.maxEntries,
      });
      _explicitResponseBackends.set(key, built);
    }
    return built;
  }

  if (_responseBackend) return Promise.resolve(_responseBackend);
  if (!_responseBackendPromise) {
    _responseBackendPromise = createBackend().then((b) => {
      _responseBackend = b;
      return b;
    });
  }
  return _responseBackendPromise;
}

/**
 * Response cache middleware for GET requests.
 * Caches the full response body, content-type, and status code through the
 * unified async backend. Cache key is method + url (including query string).
 *
 * The middleware is ASYNC: the before-path awaits `backend.get` (serve hit) and
 * the after-path awaits `backend.set` (store on the captured `res.raw.end`).
 * The framework's middleware chain (`runRouteMiddlewares` / `MiddlewareChain`)
 * already awaits middleware, so async is transparent. Honors ttl/statusCodes/
 * maxEntries. With the default `memory` backend behaviour is unchanged; a
 * redis/etc. backend distributes cross-instance.
 */
/**
 * Response directives that let a SHARED cache store a response to a request
 * carrying Authorization (RFC 9111 s3.5).
 */
const SHARED_CACHE_DIRECTIVES = ["public", "s-maxage", "must-revalidate"];

/** Case-insensitive request header lookup. */
function requestHeader(req: { headers?: Record<string, unknown> }, name: string): string | undefined {
  const headers = req?.headers;
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return undefined;
}

/** The lower-cased field names in a response's Vary header. */
function varyFields(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const text = Array.isArray(raw) ? raw.join(",") : String(raw);
  return text.split(",").map((f) => f.trim().toLowerCase()).filter((f) => f !== "");
}

/**
 * May a SHARED cache store this response? (RFC 9111 s3, s4.1)
 *
 * s3 — "if the cache is shared: the Authorization header field is not present
 * in the request ... or a response directive is present that explicitly allows
 * shared caching". The key is method + URL only, and on Node the cache answers
 * BEFORE the auth gate, so without this an anonymous caller was served an
 * authenticated caller's body with a 200.
 *
 * s4.1 — a stored response whose Vary contains "*" "always fails to match", so
 * storing one is pointless.
 */
function mayStore(req: { headers?: Record<string, unknown> }, vary: string[], cacheControl: unknown): boolean {
  if (vary.includes("*")) return false;
  if (requestHeader(req, "authorization") === undefined) return true;
  const cc = String(cacheControl ?? "").toLowerCase();
  return SHARED_CACHE_DIRECTIVES.some((directive) => cc.includes(directive));
}

/**
 * Do the nominated request headers match the ones recorded on the entry?
 *
 * RFC 9111 s4.1 — the cache MUST NOT use a stored response unless every request
 * header field nominated by its Vary value matches. An absent field only
 * matches an absent field.
 */
function varyMatches(entry: CacheEntry, req: { headers?: Record<string, unknown> }): boolean {
  const vary = entry.vary ?? [];
  if (vary.length === 0) return true;
  const recorded = entry.varyValues ?? {};
  return vary.every((field) => requestHeader(req, field) === recorded[field]);
}

export function responseCache(config?: ResponseCacheConfig): Middleware {
  const ttl = config?.ttl
    ?? (process.env.TINA4_CACHE_TTL ? parseInt(process.env.TINA4_CACHE_TTL, 10) : 60);
  const allowedCodes = new Set(config?.statusCodes ?? [200]);

  if (ttl <= 0) {
    // Cache disabled — pass through
    return (_req, _res, next) => next();
  }

  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== "GET") {
      next();
      return;
    }

    const backend = await _getResponseBackend(config);
    const cacheKey = `response:GET:${req.url}`;
    const cached = (await backend.get(cacheKey)) as CacheEntry | undefined;

    if (cached && typeof cached === "object" && typeof cached.body === "string"
        && varyMatches(cached, req as any)) {
      // Cache HIT — serve from the (possibly distributed) backend.
      res.header("X-Cache", "HIT");
      // X-Cache-TTL advertises the configured cache lifetime in seconds
      // (parity with Python/PHP/Ruby, which set it alongside X-Cache).
      res.header("X-Cache-TTL", String(ttl));
      res.header("Content-Type", cached.contentType);
      res(cached.body, cached.statusCode, cached.contentType);
      return;
    }

    // Cache MISS — intercept the response to capture and store it.
    const originalEnd = res.raw.end.bind(res.raw);
    let captured = false;

    res.raw.end = function (chunk?: any, ...args: any[]) {
      const vary = varyFields(res.raw.getHeader("Vary"));
      if (!captured && allowedCodes.has(res.raw.statusCode)
          && mayStore(req as any, vary, res.raw.getHeader("Cache-Control"))) {
        captured = true;
        const body = typeof chunk === "string" ? chunk : chunk?.toString() ?? "";
        const contentType = String(res.raw.getHeader("Content-Type") ?? "application/octet-stream");
        const varyValues: Record<string, string | undefined> = {};
        for (const field of vary) varyValues[field] = requestHeader(req as any, field);

        // backend.set is async; the captured end() must stay synchronous (Node
        // flushes the body here), so fire-and-forget the store. The backend's
        // TTL + maxEntries handle expiry/eviction. Errors are swallowed so a
        // cache write can never break the response.
        void backend.set(cacheKey, {
          body,
          contentType,
          statusCode: res.raw.statusCode,
          expiresAt: Date.now() + ttl * 1000,
          vary,
          varyValues,
        } as CacheEntry, ttl).catch(() => { /* best effort */ });
      }

      res.header("X-Cache", "MISS");
      res.header("X-Cache-TTL", String(ttl));
      return originalEnd(chunk, ...args);
    } as any;

    next();
  };
}

/**
 * Clear all cached responses (the responseCache middleware backend).
 * ASYNC on Node — callers `await clearCache()` — because the backend may be a
 * network backend (redis/etc.). Resets the backend's namespace; mirrors the
 * Python ResponseCache.clear_cache() which clears its backend.
 */
export async function clearCache(): Promise<void> {
  if (!_responseBackend && !_responseBackendPromise) {
    // Nothing built yet — build the default so a clear before first use still
    // resolves to a real (empty) backend rather than silently no-op'ing.
    await _getResponseBackend();
  }
  const backend = await _getResponseBackend();
  await backend.clear();
}

/**
 * Get KV cache stats — reports the same backend that cacheGet/cacheSet/cacheDelete use,
 * so a value stored via cacheSet() is reflected here. Mirrors cache_stats() in the
 * Python / PHP / Ruby frameworks. (Identical to cacheBackendStats(), kept for parity naming.)
 * ASYNC on Node — callers `await cacheStats()`.
 */
export async function cacheStats(): Promise<{ hits: number; misses: number; size: number; backend: string }> {
  return (await _getBackend()).stats();
}

// ── Module-level direct cache API (backend-aware, async) ───────────

let _defaultBackend: CacheBackend | null = null;
let _defaultBackendPromise: Promise<CacheBackend> | null = null;
let _defaultTtl: number | null = null;

/**
 * Lazily build the module-level default backend. Async because createBackend()
 * probes the configured network backend before resolving. The built backend is
 * memoised so subsequent calls reuse the same pooled connection.
 */
async function _getBackend(): Promise<CacheBackend> {
  if (_defaultBackend) return _defaultBackend;
  if (!_defaultBackendPromise) {
    _defaultBackendPromise = createBackend().then((b) => {
      _defaultBackend = b;
      return b;
    });
  }
  return _defaultBackendPromise;
}

function _getDefaultTtl(): number {
  if (_defaultTtl === null) {
    const envTtl = process.env.TINA4_CACHE_TTL;
    _defaultTtl = envTtl ? parseInt(envTtl, 10) : 60;
  }
  return _defaultTtl;
}

/** Get a value from the cache by key. Returns undefined on miss. */
export async function cacheGet(key: string): Promise<unknown | undefined> {
  return (await _getBackend()).get(key);
}

/** Store a value in the cache with optional TTL (seconds). */
export async function cacheSet(key: string, value: unknown, ttl?: number): Promise<void> {
  const effectiveTtl = ttl ?? _getDefaultTtl();
  await (await _getBackend()).set(key, value, effectiveTtl);
}

/** Delete a key from the cache. Returns true if it existed. */
export async function cacheDelete(key: string): Promise<boolean> {
  return (await _getBackend()).delete(key);
}

/** Clear all entries from the cache. */
export async function cacheClear(): Promise<void> {
  await (await _getBackend()).clear();
}

/** Remove expired entries from the cache. Returns count removed. */
export async function sweep(): Promise<number> {
  return (await _getBackend()).sweep();
}

/** Return cache statistics from the active backend. */
export async function cacheBackendStats(): Promise<{ hits: number; misses: number; size: number; backend: string }> {
  return (await _getBackend()).stats();
}

/** Reset the default backend (for testing). Closes any pooled connection. */
export function _resetBackend(): void {
  for (const b of [_defaultBackend, _responseBackend] as any[]) {
    if (b && typeof b.client?.close === "function") { try { b.client.close(); } catch { /* noop */ } }
    if (b && typeof b.client?.close !== "function" && typeof b.db?.close === "function") { /* leave shared ORM db */ }
  }
  _defaultBackend = null;
  _defaultBackendPromise = null;
  _responseBackend = null;
  _responseBackendPromise = null;
  // Explicitly-configured backends are memoised too, so a reset that left them
  // behind would leak one test's provider into the next.
  _explicitResponseBackends.clear();
  _defaultTtl = null;
}
