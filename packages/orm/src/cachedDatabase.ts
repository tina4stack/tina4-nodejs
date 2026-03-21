/**
 * Tina4 Cached Database — Transparent query cache decorator for DatabaseAdapter.
 *
 * Wraps any DatabaseAdapter and caches SELECT results from fetch() and fetchOne().
 * Write operations (insert, update, delete, execute) invalidate the entire cache.
 *
 * Opt-in via .env:
 *   TINA4_DB_CACHE=true          # enable (default: false)
 *   TINA4_DB_CACHE_TTL=30        # TTL in seconds (default: 30)
 *
 * Usage:
 *   import { CachedDatabaseAdapter } from "@tina4/orm";
 *   import { SQLiteAdapter } from "./adapters/sqlite.js";
 *
 *   const raw = new SQLiteAdapter("./data/app.db");
 *   const db = new CachedDatabaseAdapter(raw);
 *   db.fetch("SELECT * FROM users");   // cached on second call
 *   db.cacheStats();                   // { enabled: true, hits: 1, ... }
 */

import { QueryCache } from "./sqlTranslation.js";
import type { DatabaseAdapter, DatabaseResult, ColumnInfo, FieldDefinition } from "./types.js";

function isTruthy(val: string | undefined): boolean {
  return ["true", "1", "yes", "on"].includes((val ?? "").trim().toLowerCase());
}

export class CachedDatabaseAdapter implements DatabaseAdapter {
  private adapter: DatabaseAdapter;
  private cache: QueryCache;
  private enabled: boolean;
  private ttl: number;
  private hits: number = 0;
  private misses: number = 0;

  constructor(adapter: DatabaseAdapter, enabled?: boolean, ttl?: number) {
    this.adapter = adapter;
    this.enabled = enabled ?? isTruthy(process.env.TINA4_DB_CACHE);
    this.ttl = ttl ?? parseInt(process.env.TINA4_DB_CACHE_TTL ?? "30", 10);
    this.cache = new QueryCache({ defaultTtl: this.ttl, maxSize: 10000 });
  }

  // ── Cache helpers ─────────────────────────────────────────

  cacheStats(): { enabled: boolean; hits: number; misses: number; size: number; ttl: number } {
    return {
      enabled: this.enabled,
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size(),
      ttl: this.ttl,
    };
  }

  cacheClear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  private invalidate(): void {
    this.cache.clear();
  }

  // ── DatabaseAdapter interface ─────────────────────────────

  execute(sql: string, params?: unknown[]): unknown {
    if (this.enabled) this.invalidate();
    return this.adapter.execute(sql, params);
  }

  executeMany(sql: string, paramsList: unknown[][]): { totalAffected: number; lastInsertId?: number | bigint } {
    if (this.enabled) this.invalidate();
    return this.adapter.executeMany(sql, paramsList);
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
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

  /**
   * Access the underlying adapter directly.
   */
  getAdapter(): DatabaseAdapter {
    return this.adapter;
  }
}
