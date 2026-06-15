/**
 * Tina4 Cached Database — Transparent query cache decorator for DatabaseAdapter.
 *
 * Wraps any DatabaseAdapter and caches SELECT results from fetch() and fetchOne()
 * (plus their *Async variants). Write operations (insert, update, delete, execute,
 * createTable, addColumn) flush the entire cache when caching is enabled.
 *
 * One store, two layers (mirrors the Python master — tina4_python/database/connection.py):
 *
 *   • request-scoped (DEFAULT ON, off-switch TINA4_QUERY_CACHE=false) — dedupes
 *     identical SELECTs to protect the DB from rapid repeat reads. Cleared at the
 *     START of every HTTP request (via Database.resetRequestCaches()) AND on any
 *     write, with a short safety TTL (TINA4_QUERY_CACHE_TTL, default 5s) for
 *     non-request contexts (scripts/workers).
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
  /** Force-enable the request-scoped layer. Defaults to TINA4_QUERY_CACHE (default true). */
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
  /** Request-scoped layer — TINA4_QUERY_CACHE (default ON). */
  private cacheRequestScoped: boolean;
  private enabled: boolean;
  private ttl: number;
  private hits: number = 0;
  private misses: number = 0;

  constructor(adapter: DatabaseAdapter, options: CachedAdapterOptions = {}) {
    this.adapter = adapter;
    this.cachePersistent = options.persistent ?? isTruthy(process.env.TINA4_DB_CACHE);
    this.cacheRequestScoped = options.requestScoped
      ?? (process.env.TINA4_QUERY_CACHE === undefined ? true : isTruthy(process.env.TINA4_QUERY_CACHE));
    this.enabled = this.cachePersistent || this.cacheRequestScoped;

    if (options.ttl !== undefined) {
      this.ttl = options.ttl;
    } else if (this.cachePersistent) {
      this.ttl = parseInt(process.env.TINA4_DB_CACHE_TTL ?? "30", 10);
    } else {
      this.ttl = parseInt(process.env.TINA4_QUERY_CACHE_TTL ?? "5", 10);
    }

    this.cache = options.sharedCache ?? new QueryCache({ defaultTtl: this.ttl, maxSize: 10000 });
    CachedDatabaseAdapter.instances.add(this);
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
    hits: number; misses: number; size: number; ttl: number;
  } {
    return {
      enabled: this.enabled,
      mode: this.cacheMode(),
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size(),
      ttl: this.ttl,
    };
  }

  /** Flush the query cache and reset counters. Mirrors Python `cache_clear()`. */
  cacheClear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** Clear the entire query cache (called on writes). */
  private invalidate(): void {
    this.cache.clear();
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

  fetch<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): T[] {
    if (this.enabled) {
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

  fetchOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    if (this.enabled) {
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

  async fetchAsync<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): Promise<T[]> {
    if (this.enabled) {
      const key = QueryCache.queryKey(sql + `:L${limit}:S${skip}`, params as unknown[] | undefined);
      const cached = this.cache.get<T[]>(key);
      if (cached !== undefined) {
        this.hits++;
        return cached;
      }
      const result = (this.adapter as any).fetchAsync
        ? await (this.adapter as any).fetchAsync(sql, params, limit, skip)
        : this.adapter.fetch<T>(sql, params, limit, skip);
      this.cache.set(key, result, this.ttl);
      this.misses++;
      return result;
    }
    return (this.adapter as any).fetchAsync
      ? await (this.adapter as any).fetchAsync(sql, params, limit, skip)
      : this.adapter.fetch<T>(sql, params, limit, skip);
  }

  async fetchOneAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    if (this.enabled) {
      const key = QueryCache.queryKey(sql + ":ONE", params as unknown[] | undefined);
      const cached = this.cache.get<T | null>(key);
      if (cached !== undefined) {
        this.hits++;
        return cached;
      }
      const result = (this.adapter as any).fetchOneAsync
        ? await (this.adapter as any).fetchOneAsync(sql, params)
        : this.adapter.fetchOne<T>(sql, params);
      this.cache.set(key, result, this.ttl);
      this.misses++;
      return result;
    }
    return (this.adapter as any).fetchOneAsync
      ? await (this.adapter as any).fetchOneAsync(sql, params)
      : this.adapter.fetchOne<T>(sql, params);
  }

  async queryAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    if (this.enabled) {
      const key = QueryCache.queryKey(sql + ":Q", params as unknown[] | undefined);
      const cached = this.cache.get<T[]>(key);
      if (cached !== undefined) {
        this.hits++;
        return cached;
      }
      const result = (this.adapter as any).queryAsync
        ? await (this.adapter as any).queryAsync(sql, params)
        : this.adapter.query<T>(sql, params);
      this.cache.set(key, result, this.ttl);
      this.misses++;
      return result;
    }
    return (this.adapter as any).queryAsync
      ? await (this.adapter as any).queryAsync(sql, params)
      : this.adapter.query<T>(sql, params);
  }

  async executeAsync(sql: string, params?: unknown[]): Promise<unknown> {
    if (this.enabled) this.invalidate();
    return (this.adapter as any).executeAsync
      ? await (this.adapter as any).executeAsync(sql, params)
      : this.adapter.execute(sql, params);
  }

  async insertAsync(table: string, data: Record<string, unknown> | Record<string, unknown>[]): Promise<DatabaseResult> {
    if (this.enabled) this.invalidate();
    return (this.adapter as any).insertAsync
      ? await (this.adapter as any).insertAsync(table, data)
      : this.adapter.insert(table, data);
  }

  async updateAsync(table: string, data: Record<string, unknown>, filter: Record<string, unknown>, params?: unknown[]): Promise<DatabaseResult> {
    if (this.enabled) this.invalidate();
    return (this.adapter as any).updateAsync
      ? await (this.adapter as any).updateAsync(table, data, filter, params)
      : this.adapter.update(table, data, filter);
  }

  async deleteAsync(table: string, filter: Record<string, unknown> | string | Record<string, unknown>[], params?: unknown[]): Promise<DatabaseResult> {
    if (this.enabled) this.invalidate();
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
