/**
 * Multi-backend response cache for GET requests.
 *
 * Backends are selected via the TINA4_CACHE_BACKEND env var:
 *   memory — in-process LRU cache (default, zero deps)
 *   redis  — Redis / Valkey (uses `ioredis` or raw RESP over TCP)
 *   file   — JSON files in data/cache/
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
 * Environment:
 *   TINA4_CACHE_BACKEND      — memory | redis | file  (default: memory)
 *   TINA4_CACHE_URL           — redis://localhost:6379  (redis only)
 *   TINA4_CACHE_TTL           — default TTL in seconds  (default: 0 = disabled)
 *   TINA4_CACHE_MAX_ENTRIES   — max entries              (default: 1000)
 */

import type { Middleware } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as net from "node:net";

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

// ── Redis backend ─────────────────────────────────────────────────

class RedisBackend implements CacheBackend {
  private host: string;
  private port: number;
  private db: number;
  private prefix = "tina4:cache:";
  private hits = 0;
  private misses = 0;
  private maxEntries: number;

  constructor(url = "redis://localhost:6379", maxEntries = 1000) {
    this.maxEntries = maxEntries;
    const cleaned = url.replace("redis://", "");
    const parts = cleaned.split(":");
    this.host = parts[0] || "localhost";
    const portAndDb = parts[1] ? parts[1].split("/") : ["6379"];
    this.port = parseInt(portAndDb[0], 10) || 6379;
    this.db = portAndDb[1] ? parseInt(portAndDb[1], 10) : 0;
  }

  private respCommand(...args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        let cmd = `*${args.length}\r\n`;
        for (const arg of args) {
          cmd += `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`;
        }

        const sock = new net.Socket();
        sock.setTimeout(5000);
        let response = "";

        sock.connect(this.port, this.host, () => {
          if (this.db > 0) {
            const selectCmd = `*2\r\n$6\r\nSELECT\r\n$${String(this.db).length}\r\n${this.db}\r\n`;
            sock.write(selectCmd);
          }
          sock.write(cmd);
        });

        sock.on("data", (data) => {
          response += data.toString();
          sock.end();
        });

        sock.on("end", () => {
          if (response.startsWith("+")) {
            resolve(response.slice(1).trim());
          } else if (response.startsWith("$-1")) {
            resolve(null);
          } else if (response.startsWith("$")) {
            const lines = response.split("\r\n");
            resolve(lines[1] ?? null);
          } else if (response.startsWith(":")) {
            resolve(response.slice(1).trim());
          } else {
            resolve(null);
          }
        });

        sock.on("error", () => resolve(null));
        sock.on("timeout", () => { sock.destroy(); resolve(null); });
      } catch {
        resolve(null);
      }
    });
  }

  get(key: string): unknown | undefined {
    // Synchronous fallback — Redis is async, so direct API uses sync memory store
    // For the response cache middleware, this returns undefined and falls through
    this.misses++;
    return undefined;
  }

  set(key: string, value: unknown, ttl: number): void {
    const fullKey = this.prefix + key;
    const serialized = JSON.stringify(value);
    if (ttl > 0) {
      this.respCommand("SETEX", fullKey, String(ttl), serialized).catch(() => {});
    } else {
      this.respCommand("SET", fullKey, serialized).catch(() => {});
    }
  }

  delete(key: string): boolean {
    const fullKey = this.prefix + key;
    this.respCommand("DEL", fullKey).catch(() => {});
    return true; // best-effort
  }

  clear(): void {
    this.hits = 0;
    this.misses = 0;
  }

  stats() {
    return { hits: this.hits, misses: this.misses, size: 0, backend: "redis" };
  }

  name() { return "redis"; }
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

// ── Backend factory ───────────────────────────────────────────────

function createBackend(config?: {
  backend?: string;
  cacheUrl?: string;
  cacheDir?: string;
  maxEntries?: number;
}): CacheBackend {
  const backendName = (config?.backend ?? process.env.TINA4_CACHE_BACKEND ?? "memory").toLowerCase().trim();
  const maxEntries = config?.maxEntries ?? (process.env.TINA4_CACHE_MAX_ENTRIES ? parseInt(process.env.TINA4_CACHE_MAX_ENTRIES, 10) : 1000);

  switch (backendName) {
    case "redis": {
      const url = config?.cacheUrl ?? process.env.TINA4_CACHE_URL ?? "redis://localhost:6379";
      return new RedisBackend(url, maxEntries);
    }
    case "file": {
      const dir = config?.cacheDir ?? process.env.TINA4_CACHE_DIR ?? "data/cache";
      return new FileBackend(dir, maxEntries);
    }
    default:
      return new MemoryBackend(maxEntries);
  }
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

/** Get cache stats (middleware store) */
export function cacheStats(): { size: number; keys: string[]; backend: string } {
  return { size: store.size, keys: [...store.keys()], backend: _getBackend().name() };
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

/** Return cache statistics from the active backend. */
export function cacheBackendStats(): { hits: number; misses: number; size: number; backend: string } {
  return _getBackend().stats();
}

/** Reset the default backend (for testing). */
export function _resetBackend(): void {
  _defaultBackend = null;
  _defaultTtl = null;
}
