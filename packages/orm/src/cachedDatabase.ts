/**
 * Tina4 Cached Database — Transparent query cache decorator for DatabaseAdapter.
 *
 * Wraps any DatabaseAdapter and caches SELECT results from fetch() and fetchOne()
 * (plus their *Async variants). Write operations (insert, update, delete, execute,
 * createTable, addColumn) flush the entire cache when caching is enabled.
 *
 * One store, two layers (mirrors the Python master — tina4_python/database/connection.py):
 *
 *   • request-scoped (DEFAULT OFF, opt-in TINA4_AUTO_CACHING=true) — dedupes
 *     identical SELECTs to protect the DB from rapid repeat reads. Cleared at the
 *     START of every HTTP request (via Database.resetRequestCaches()) AND on any
 *     write, with a short safety TTL (TINA4_AUTO_CACHING_TTL, default 5s) for
 *     non-request contexts (scripts/workers). Default OFF because a request-scoped
 *     cache defaulting ON is a footgun — a read-after-write in one request (e.g.
 *     SELECT MAX(id) then INSERT) returns a cached pre-write value. Opt in for
 *     read-heavy endpoints.
 *   • persistent (opt-in, TINA4_DB_CACHE=true) — cross-request TTL cache that is
 *     NOT cleared per request; entries expire by TINA4_DB_CACHE_TTL (default 30s).
 *
 *   enabled = persistent || requestScoped
 *   mode    = persistent ? "persistent" : (requestScoped ? "request" : "off")
 *   ttl     = persistent ? 30 : 5  (env-overridable)
 *
 * Usage (the framework wires this automatically at the adapter bind path):
 *   import { CachedDatabaseAdapter } from "@tina4/orm";
 *   import { SQLiteAdapter } from "./adapters/sqlite.js";
 *
 *   const raw = new SQLiteAdapter("./data/app.db");
 *   const db = new CachedDatabaseAdapter(raw);
 *   db.fetch("SELECT * FROM users");   // cached on second call
 *   db.cacheStats();                   // { enabled, mode, hits, misses, size, ttl }
 */

import { QueryCache } from "./sqlTranslation.js";
import type { DatabaseAdapter, DatabaseResult, ColumnInfo, FieldDefinition } from "./types.js";
import type { CacheBackend } from "@tina4/core";

function isTruthy(val: string | undefined): boolean {
  return ["true", "1", "yes", "on"].includes((val ?? "").trim().toLowerCase());
}

/**
 * Options for wrapping an adapter with a query cache. When several pooled
 * connections must share one cache store (so a write on any connection
 * invalidates reads cached by all of them), pass the same `sharedCache`.
 */
export interface CachedAdapterOptions {
  /** Force-enable the persistent (cross-request) layer. Defaults to TINA4_DB_CACHE. */
  persistent?: boolean;
  /** Force-enable the request-scoped layer. Defaults to TINA4_AUTO_CACHING (default false / opt-in). */
  requestScoped?: boolean;
  /** Override the effective TTL (seconds). Defaults to the mode-appropriate env var. */
  ttl?: number;
  /** Share a single QueryCache store across multiple wrappers (pooled connections). */
  sharedCache?: QueryCache;
}

export class CachedDatabaseAdapter implements DatabaseAdapter {
  /**
   * Live wrappers, so the request dispatcher can clear the request-scoped cache
   * on every connection at the start of each HTTP request. Mirrors Python's
   * `Database._instances` WeakSet. A WeakSet lets closed connections be GC'd.
   */
  private static instances: Set<CachedDatabaseAdapter> = new Set();

  private adapter: DatabaseAdapter;
  private cache: QueryCache;
  /** Persistent (cross-request) layer — TINA4_DB_CACHE. */
  private cachePersistent: boolean;
  /** Request-scoped layer — TINA4_AUTO_CACHING (default OFF / opt-in). */
  private cacheRequestScoped: boolean;
  private enabled: boolean;
  private ttl: number;
  private hits: number = 0;
  private misses: number = 0;

  /**
   * Persistent-mode distributed backend (TINA4_DB_CACHE=true). Built lazily from
   * the SAME unified `createBackend()` factory the response/KV cache uses, so
   * multiple Database instances share one cache with global write-invalidation
   * (parity with Python's connection.py, which routes the persistent DB cache
   * through `_create_backend`). The read path (`fetchAsync`/`fetchOneAsync`/
   * `queryAsync`) is async, so the backend's async get/set work directly — no
   * sync-path restriction. Request-scoped mode keeps the in-process QueryCache
   * above (ephemeral, fastest, never serialized).
   *
   * `null` until the first async read builds it; a `memory` backend (the
   * default) means the persistent layer behaves in-process exactly as before, so
   * default behaviour is unchanged and only an explicit redis/etc. backend
   * distributes.
   */
  private backend: CacheBackend | null = null;
  private backendPromise: Promise<CacheBackend | null> | null = null;
  private backendName: string;

  constructor(adapter: DatabaseAdapter, options: CachedAdapterOptions = {}) {
    this.adapter = adapter;
    this.cachePersistent = options.persistent ?? isTruthy(process.env.TINA4_DB_CACHE);
    // Request-scoped cache defaults to OFF (opt-in). A request-scoped cache
    // defaulting ON is a footgun: a `SELECT MAX(id)` (or generator read) right
    // before an INSERT in the same request returns a cached pre-write value →
    // duplicate primary keys; any read-after-write in one request shows stale
    // state. So the DEFAULT is OFF; opt in for read-heavy endpoints with
    // TINA4_AUTO_CACHING=true. Mirrors the Python master
    // (tina4_python/database/connection.py: default literal "false").
    this.cacheRequestScoped = options.requestScoped ?? isTruthy(process.env.TINA4_AUTO_CACHING);
    this.enabled = this.cachePersistent || this.cacheRequestScoped;

    if (options.ttl !== undefined) {
      this.ttl = options.ttl;
    } else if (this.cachePersistent) {
      this.ttl = parseInt(process.env.TINA4_DB_CACHE_TTL ?? "30", 10);
    } else {
      this.ttl = parseInt(process.env.TINA4_AUTO_CACHING_TTL ?? "5", 10);
    }

    this.cache = options.sharedCache ?? new QueryCache({ defaultTtl: this.ttl, maxSize: 10000 });

    // Persistent mode now routes through the unified async backend (the read
    // path — fetchAsync/fetchOneAsync/queryAsync — is async, so the backend's
    // async get/set work directly). TINA4_DB_CACHE_BACKEND + TINA4_DB_CACHE_URL
    // select the backend (default `memory` = in-process, unchanged behaviour).
    // The backend is built lazily on first async read so an unreachable network
    // backend degrades to `file` (via createBackend's own fallback) without
    // blocking construction.
    this.backendName = (process.env.TINA4_DB_CACHE_BACKEND ?? "memory").toLowerCase().trim();

    CachedDatabaseAdapter.instances.add(this);
  }

  /**
   * Whether the persistent layer should use a distributed/serialised backend.
   * For the default `memory` backend we keep the in-process QueryCache (fast,
   * no serialisation) so behaviour is identical to before; only an explicit
   * non-memory backend (redis/valkey/memcached/mongodb/database/file) routes
   * through the unified async backend for cross-instance sharing.
   */
  private usesPersistentBackend(): boolean {
    return this.cachePersistent && this.backendName !== "memory";
  }

  /** Lazily build (and memoise) the persistent backend via createBackend(). */
  private async getBackend(): Promise<CacheBackend | null> {
    if (this.backend) return this.backend;
    if (!this.backendPromise) {
      this.backendPromise = (async () => {
        try {
          // Dynamic import keeps @tina4/orm free of an import-time cycle with
          // @tina4/core (whose `database` backend dynamically imports @tina4/orm).
          const core: any = await import("@tina4/core");
          const b: CacheBackend = await core.createBackend({
            backend: this.backendName,
            cacheUrl: process.env.TINA4_DB_CACHE_URL,
          });
          this.backend = b;
          return b;
        } catch {
          return null; // fall back to the in-process QueryCache
        }
      })();
    }
    return this.backendPromise;
  }

  // ── Cache mode helpers ────────────────────────────────────

  /** Current cache mode: "persistent" | "request" | "off". */
  cacheMode(): "persistent" | "request" | "off" {
    return this.cachePersistent ? "persistent" : (this.cacheRequestScoped ? "request" : "off");
  }

  /** Whether either cache layer is active. */
  cacheEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Clear the request-scoped cache at the start of an HTTP request.
   * No-op in persistent mode (cross-request entries survive to their TTL).
   * Cumulative hit/miss counters are preserved. Mirrors Python's
   * `Database.cache_new_request()`.
   */
  cacheNewRequest(): void {
    if (this.cacheRequestScoped && !this.cachePersistent) {
      this.cache.clear();
    }
  }

  /**
   * Clear the request-scoped cache on every live wrapper. The request
   * dispatcher calls this at the start of each HTTP request so request-scoped
   * caching never serves rows across requests. Persistent-mode connections are
   * left alone. Mirrors Python's `Database.reset_request_caches()` classmethod.
   */
  static resetRequestCaches(): void {
    for (const inst of CachedDatabaseAdapter.instances) {
      try {
        inst.cacheNewRequest();
      } catch {
        /* a closed/broken wrapper must not break the request boundary */
      }
    }
  }

  // ── Cache stats / management ──────────────────────────────

  cacheStats(): {
    enabled: boolean; mode: "persistent" | "request" | "off";
    hits: number; misses: number; size: number; ttl: number; backend?: string;
  } {
    return {
      enabled: this.enabled,
      mode: this.cacheMode(),
      hits: this.hits,
      misses: this.misses,
      // `size` is the in-process figure. When a distributed persistent backend
      // is active the authoritative size lives in redis/etc.; the hit/miss
      // counters here are still real (tracked locally per the read path).
      size: this.cache.size(),
      ttl: this.ttl,
      // Report the actually-configured persistent backend so the operator sees
      // where cross-instance entries land (parity with Python's cache_stats).
      backend: this.usesPersistentBackend() ? this.backendName : "memory",
    };
  }

  /** Flush the query cache and reset counters. Mirrors Python `cache_clear()`. */
  cacheClear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    // Best-effort flush of the distributed backend too (fire-and-forget — this
    // method is synchronous to keep db.cacheClear() ergonomic).
    if (this.usesPersistentBackend()) {
      void this.getBackend().then((b) => b?.clear()).catch(() => { /* best effort */ });
    }
  }

  /** Clear the entire query cache (called on writes). */
  private invalidate(): void {
    this.cache.clear();
    // Persistent distributed backend: clear it too so a write on ANY instance
    // invalidates entries cached by ALL instances (global write-invalidation,
    // parity with Python's _cache_invalidate → backend.clear()). Fire-and-forget
    // on the sync write path (execute/insert/...); the async write methods below
    // await invalidateAsync() instead for deterministic ordering.
    if (this.usesPersistentBackend()) {
      void this.getBackend().then((b) => b?.clear()).catch(() => { /* best effort */ });
    }
  }

  /** Async write-invalidation — awaits the distributed backend clear. */
  private async invalidateAsync(): Promise<void> {
    this.cache.clear();
    if (this.usesPersistentBackend()) {
      const b = await this.getBackend();
      if (b) { try { await b.clear(); } catch { /* best effort */ } }
    }
  }

  // ── Persistent-backend get/set helpers (serialised rows) ──
  //
  // The persistent backend stores the adapter's row payload (T[] for fetch/
  // query, {row:T|null} for fetchOne) as plain JSON — every backend (redis
  // SETEX, mongo doc, db row) round-trips it. fetchOne is wrapped in an object
  // so a genuine `null` row is distinguishable from a cache miss (the backend
  // returns undefined on miss).

  private async backendGetRows<T>(key: string): Promise<T[] | undefined> {
    const b = await this.getBackend();
    if (!b) return undefined;
    const raw = await b.get(key);
    return Array.isArray(raw) ? (raw as T[]) : undefined;
  }

  private async backendSetRows<T>(key: string, rows: T[]): Promise<void> {
    const b = await this.getBackend();
    if (b) { try { await b.set(key, rows, this.ttl); } catch { /* best effort */ } }
  }

  private async backendGetOne<T>(key: string): Promise<{ row: T | null } | undefined> {
    const b = await this.getBackend();
    if (!b) return undefined;
    const raw = await b.get(key);
    if (raw && typeof raw === "object" && "row" in (raw as object)) {
      return raw as { row: T | null };
    }
    return undefined;
  }

  private async backendSetOne<T>(key: string, row: T | null): Promise<void> {
    const b = await this.getBackend();
    if (b) { try { await b.set(key, { row }, this.ttl); } catch { /* best effort */ } }
  }

  // ── DatabaseAdapter interface — writes flush, reads cache ──

  execute(sql: string, params?: unknown[]): unknown {
    if (this.enabled) this.invalidate();
    return this.adapter.execute(sql, params);
  }

  executeMany(sql: string, paramsList: unknown[][]): { totalAffected: number; lastInsertId?: number | bigint } {
    if (this.enabled) this.invalidate();
    return this.adapter.executeMany(sql, paramsList);
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    // The Node ORM reads most rows through query() (find/where/all/relationships),
    // so caching here is what makes ORM reads dedupe — matching the Python master
    // where every ORM read flows through the cached db.fetch(). Same store, same
    // counters, flushed on writes.
    if (this.enabled) {
      const key = QueryCache.queryKey(sql + ":Q", params as unknown[] | undefined);
      const cached = this.cache.get<T[]>(key);
      if (cached !== undefined) {
        this.hits++;
        return cached;
      }
      const result = this.adapter.query<T>(sql, params);
      this.cache.set(key, result, this.ttl);
      this.misses++;
      return result;
    }
    return this.adapter.query(sql, params);
  }

  fetch<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number, noCache?: boolean): T[] {
    // `noCache` bypasses the query cache for this one call — no lookup, no
    // store, run straight against the underlying adapter (mirrors the Python
    // master's `no_cache`). Counters are left untouched so a bypass read isn't
    // misreported as a hit or a miss.
    if (this.enabled && !noCache) {
      const key = QueryCache.queryKey(sql + `:L${limit}:S${skip}`, params as unknown[] | undefined);
      const cached = this.cache.get<T[]>(key);
      if (cached !== undefined) {
        this.hits++;
        return cached;
      }
      const result = this.adapter.fetch<T>(sql, params, limit, skip);
      this.cache.set(key, result, this.ttl);
      this.misses++;
      return result;
    }
    return this.adapter.fetch(sql, params, limit, skip);
  }

  fetchOne<T = Record<string, unknown>>(sql: string, params?: unknown[], noCache?: boolean): T | null {
    if (this.enabled && !noCache) {
      const key = QueryCache.queryKey(sql + ":ONE", params as unknown[] | undefined);
      const cached = this.cache.get<T | null>(key);
      if (cached !== undefined) {
        this.hits++;
        return cached;
      }
      const result = this.adapter.fetchOne<T>(sql, params);
      this.cache.set(key, result, this.ttl);
      this.misses++;
      return result;
    }
    return this.adapter.fetchOne(sql, params);
  }

  insert(table: string, data: Record<string, unknown> | Record<string, unknown>[]): DatabaseResult {
    if (this.enabled) this.invalidate();
    return this.adapter.insert(table, data);
  }

  update(table: string, data: Record<string, unknown>, filter: Record<string, unknown>): DatabaseResult {
    if (this.enabled) this.invalidate();
    return this.adapter.update(table, data, filter);
  }

  delete(table: string, filter: Record<string, unknown> | string | Record<string, unknown>[]): DatabaseResult {
    if (this.enabled) this.invalidate();
    return this.adapter.delete(table, filter);
  }

  startTransaction(): void {
    this.adapter.startTransaction();
  }

  commit(): void {
    this.adapter.commit();
  }

  rollback(): void {
    this.adapter.rollback();
  }

  tables(): string[] {
    return this.adapter.tables();
  }

  columns(table: string): ColumnInfo[] {
    return this.adapter.columns(table);
  }

  lastInsertId(): number | bigint | null {
    return this.adapter.lastInsertId();
  }

  close(): void {
    CachedDatabaseAdapter.instances.delete(this);
    this.adapter.close();
  }

  tableExists(name: string): boolean {
    return this.adapter.tableExists(name);
  }

  createTable(name: string, columns: Record<string, FieldDefinition>): void {
    if (this.enabled) this.invalidate();
    this.adapter.createTable(name, columns);
  }

  getTableColumns?(name: string): Array<{ name: string; type: string }> {
    return this.adapter.getTableColumns?.(name) ?? [];
  }

  addColumn?(table: string, colName: string, def: FieldDefinition): void {
    if (this.enabled) this.invalidate();
    this.adapter.addColumn?.(table, colName, def);
  }

  // ── Async passthroughs (PostgreSQL/MySQL/MSSQL/Firebird/Mongo) ──
  //
  // The async adapters implement *Async methods; the Database wrapper and the
  // ORM read/write path prefer those when present. We mirror them here so the
  // cache sits in front of the async path too. Reads cache; writes flush.

  async fetchAsync<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number, noCache?: boolean): Promise<T[]> {
    const run = async (): Promise<T[]> => (this.adapter as any).fetchAsync
      ? await (this.adapter as any).fetchAsync(sql, params, limit, skip)
      : this.adapter.fetch<T>(sql, params, limit, skip);
    // `noCache` bypasses both cache layers for this one call — no lookup, no
    // store, run directly (mirrors the Python master's `no_cache`).
    if (this.enabled && !noCache) {
      const key = QueryCache.queryKey(sql + `:L${limit}:S${skip}`, params as unknown[] | undefined);
      // Persistent distributed backend is AUTHORITATIVE (mirrors Python, where a
      // configured _cache_backend bypasses the in-process dict). This keeps
      // cross-instance write-invalidation deterministic: a write clears the
      // shared backend, so every instance misses on its next read.
      if (this.usesPersistentBackend()) {
        const shared = await this.backendGetRows<T>(key);
        if (shared !== undefined) { this.hits++; return shared; }
        const result = await run();
        await this.backendSetRows(key, result);
        this.misses++;
        return result;
      }
      const cached = this.cache.get<T[]>(key);
      if (cached !== undefined) {
        this.hits++;
        return cached;
      }
      const result = await run();
      this.cache.set(key, result, this.ttl);
      this.misses++;
      return result;
    }
    return run();
  }

  async fetchOneAsync<T = Record<string, unknown>>(sql: string, params?: unknown[], noCache?: boolean): Promise<T | null> {
    const run = async (): Promise<T | null> => (this.adapter as any).fetchOneAsync
      ? await (this.adapter as any).fetchOneAsync(sql, params)
      : this.adapter.fetchOne<T>(sql, params);
    // `noCache` bypasses both cache layers for this one call (see fetchAsync).
    if (this.enabled && !noCache) {
      const key = QueryCache.queryKey(sql + ":ONE", params as unknown[] | undefined);
      if (this.usesPersistentBackend()) {
        const shared = await this.backendGetOne<T>(key);
        if (shared !== undefined) { this.hits++; return shared.row; }
        const result = await run();
        await this.backendSetOne(key, result);
        this.misses++;
        return result;
      }
      const cached = this.cache.get<T | null>(key);
      if (cached !== undefined) {
        this.hits++;
        return cached;
      }
      const result = await run();
      this.cache.set(key, result, this.ttl);
      this.misses++;
      return result;
    }
    return run();
  }

  async queryAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const run = async (): Promise<T[]> => (this.adapter as any).queryAsync
      ? await (this.adapter as any).queryAsync(sql, params)
      : this.adapter.query<T>(sql, params);
    if (this.enabled) {
      const key = QueryCache.queryKey(sql + ":Q", params as unknown[] | undefined);
      if (this.usesPersistentBackend()) {
        const shared = await this.backendGetRows<T>(key);
        if (shared !== undefined) { this.hits++; return shared; }
        const result = await run();
        await this.backendSetRows(key, result);
        this.misses++;
        return result;
      }
      const cached = this.cache.get<T[]>(key);
      if (cached !== undefined) {
        this.hits++;
        return cached;
      }
      const result = await run();
      this.cache.set(key, result, this.ttl);
      this.misses++;
      return result;
    }
    return run();
  }

  async executeAsync(sql: string, params?: unknown[]): Promise<unknown> {
    if (this.enabled) await this.invalidateAsync();
    return (this.adapter as any).executeAsync
      ? await (this.adapter as any).executeAsync(sql, params)
      : this.adapter.execute(sql, params);
  }

  async insertAsync(table: string, data: Record<string, unknown> | Record<string, unknown>[]): Promise<DatabaseResult> {
    if (this.enabled) await this.invalidateAsync();
    return (this.adapter as any).insertAsync
      ? await (this.adapter as any).insertAsync(table, data)
      : this.adapter.insert(table, data);
  }

  async updateAsync(table: string, data: Record<string, unknown>, filter: Record<string, unknown>, params?: unknown[]): Promise<DatabaseResult> {
    if (this.enabled) await this.invalidateAsync();
    return (this.adapter as any).updateAsync
      ? await (this.adapter as any).updateAsync(table, data, filter, params)
      : this.adapter.update(table, data, filter);
  }

  async deleteAsync(table: string, filter: Record<string, unknown> | string | Record<string, unknown>[], params?: unknown[]): Promise<DatabaseResult> {
    if (this.enabled) await this.invalidateAsync();
    return (this.adapter as any).deleteAsync
      ? await (this.adapter as any).deleteAsync(table, filter, params)
      : this.adapter.delete(table, filter as Record<string, unknown>);
  }

  async startTransactionAsync(): Promise<void> {
    if ((this.adapter as any).startTransactionAsync) await (this.adapter as any).startTransactionAsync();
    else this.adapter.startTransaction();
  }

  async commitAsync(): Promise<void> {
    if ((this.adapter as any).commitAsync) await (this.adapter as any).commitAsync();
    else this.adapter.commit();
  }

  async rollbackAsync(): Promise<void> {
    if ((this.adapter as any).rollbackAsync) await (this.adapter as any).rollbackAsync();
    else this.adapter.rollback();
  }

  async tableExistsAsync(name: string): Promise<boolean> {
    return (this.adapter as any).tableExistsAsync
      ? await (this.adapter as any).tableExistsAsync(name)
      : this.adapter.tableExists(name);
  }

  async tablesAsync(): Promise<string[]> {
    return (this.adapter as any).tablesAsync
      ? await (this.adapter as any).tablesAsync()
      : this.adapter.tables();
  }

  async columnsAsync(table: string): Promise<ColumnInfo[]> {
    return (this.adapter as any).columnsAsync
      ? await (this.adapter as any).columnsAsync(table)
      : this.adapter.columns(table);
  }

  async createTableAsync(name: string, columns: Record<string, FieldDefinition>): Promise<void> {
    if (this.enabled) this.invalidate();
    if ((this.adapter as any).createTableAsync) await (this.adapter as any).createTableAsync(name, columns);
    else this.adapter.createTable(name, columns);
  }

  /**
   * Access the underlying (unwrapped) adapter directly.
   */
  getAdapter(): DatabaseAdapter {
    return this.adapter;
  }
}
