/**
 * Tina4 SQL Translation — Cross-engine SQL translator.
 *
 * Translates SQL dialect differences between engines so that application
 * code can use a single SQL style and have it adapted at runtime.
 *
 *   import { SQLTranslator } from "@tina4/orm";
 *
 *   // Firebird: LIMIT/OFFSET → ROWS X TO Y
 *   SQLTranslator.limitToRows("SELECT * FROM users LIMIT 10 OFFSET 5");
 *   // → "SELECT * FROM users ROWS 6 TO 15"
 *
 *   // MSSQL: LIMIT → TOP N
 *   SQLTranslator.limitToTop("SELECT * FROM users LIMIT 10");
 *   // → "SELECT TOP 10 * FROM users"
 *
 * Also includes a query cache with TTL support.
 */

// ── SQL Translator ───────────────────────────────────────────

export class SQLTranslator {
  /**
   * Convert LIMIT/OFFSET to Firebird ROWS...TO syntax.
   *
   * LIMIT 10 OFFSET 5  →  ROWS 6 TO 15
   * LIMIT 10           →  ROWS 1 TO 10
   */
  static limitToRows(sql: string): string {
    // Match LIMIT n OFFSET m at end of statement
    const limitOffset = /\bLIMIT\s+(\d+)\s+OFFSET\s+(\d+)\s*$/i;
    let m = sql.match(limitOffset);
    if (m) {
      const limit = parseInt(m[1], 10);
      const offset = parseInt(m[2], 10);
      const start = offset + 1;
      const end = offset + limit;
      return sql.slice(0, m.index) + `ROWS ${start} TO ${end}`;
    }

    // Match LIMIT n at end of statement
    const limitOnly = /\bLIMIT\s+(\d+)\s*$/i;
    m = sql.match(limitOnly);
    if (m) {
      const limit = parseInt(m[1], 10);
      return sql.slice(0, m.index) + `ROWS 1 TO ${limit}`;
    }

    return sql;
  }

  /**
   * Convert LIMIT to MSSQL TOP syntax.
   *
   * SELECT ... LIMIT 10  →  SELECT TOP 10 ...
   * Does NOT convert if OFFSET is present (TOP doesn't support it).
   */
  static limitToTop(sql: string): string {
    const limitOnly = /\bLIMIT\s+(\d+)\s*$/i;
    const m = sql.match(limitOnly);
    if (m && !/\bOFFSET\b/i.test(sql)) {
      const limit = parseInt(m[1], 10);
      const body = sql.slice(0, m.index).trim();
      return body.replace(/^(SELECT)\b/i, `$1 TOP ${limit}`);
    }
    return sql;
  }

  /**
   * Convert || concatenation to CONCAT() for MySQL/MSSQL.
   *
   * 'a' || 'b' || 'c'  →  CONCAT('a', 'b', 'c')
   */
  static concatPipesToFunc(sql: string): string {
    if (!sql.includes("||")) return sql;
    const parts = sql.split("||");
    if (parts.length > 1) {
      return "CONCAT(" + parts.map((p) => p.trim()).join(", ") + ")";
    }
    return sql;
  }

  /**
   * Convert TRUE/FALSE to 1/0 for engines without boolean type (Firebird).
   */
  static booleanToInt(sql: string): string {
    sql = sql.replace(/\bTRUE\b/gi, "1");
    sql = sql.replace(/\bFALSE\b/gi, "0");
    return sql;
  }

  /**
   * Convert ILIKE to LOWER() LIKE LOWER() for engines without ILIKE.
   */
  static ilikeToLike(sql: string): string {
    return sql.replace(
      /(\S+)\s+ILIKE\s+(\S+)/gi,
      (_match, col: string, val: string) => `LOWER(${col.trim()}) LIKE LOWER(${val.trim()})`,
    );
  }

  /**
   * Translate AUTOINCREMENT across engines in DDL.
   */
  static autoIncrementSyntax(sql: string, engine: string): string {
    switch (engine) {
      case "mysql":
        return sql.replace(/AUTOINCREMENT/gi, "AUTO_INCREMENT");
      case "postgresql":
        return sql.replace(
          /INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi,
          "SERIAL PRIMARY KEY",
        );
      case "mssql":
        return sql.replace(/AUTOINCREMENT/gi, "IDENTITY(1,1)");
      case "firebird":
        return sql.replace(/\s*AUTOINCREMENT\b/gi, "");
      default:
        return sql;
    }
  }

  /**
   * Convert ? placeholders to engine-specific style.
   *
   * ? → %s (MySQL, PostgreSQL)
   * ? → :1, :2, :3 (Oracle, Firebird)
   */
  static placeholderStyle(sql: string, style: string): string {
    if (style === "%s") {
      return sql.replace(/\?/g, "%s");
    }
    if (style.startsWith(":")) {
      let count = 0;
      return sql.replace(/\?/g, () => {
        count++;
        return `:${count}`;
      });
    }
    return sql;
  }

  /**
   * Detect and strip RETURNING clause from INSERT/UPDATE statements.
   * Returns the cleaned SQL and the list of RETURNING columns.
   *
   * "INSERT INTO t (x) VALUES (1) RETURNING id, name"
   * → { sql: "INSERT INTO t (x) VALUES (1)", columns: ["id", "name"] }
   */
  static parseReturning(sql: string): { sql: string; columns: string[] } {
    const m = sql.match(/\bRETURNING\s+(.+)$/i);
    if (!m) return { sql, columns: [] };
    const columns = m[1].split(",").map((c) => c.trim());
    return {
      sql: sql.slice(0, m.index!).trim(),
      columns,
    };
  }
}

// ── Query Cache ──────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Simple in-memory query cache with TTL support.
 */
export class QueryCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private defaultTtl: number;
  private maxSize: number;

  constructor(options?: { defaultTtl?: number; maxSize?: number }) {
    this.defaultTtl = options?.defaultTtl ?? 60;
    this.maxSize = options?.maxSize ?? 1000;
  }

  /**
   * Generate a cache key from a SQL query and params.
   */
  static queryKey(sql: string, params?: unknown[]): string {
    const paramStr = params ? JSON.stringify(params) : "";
    // Simple hash via string combination
    return `query:${sql}:${paramStr}`;
  }

  /**
   * Get a cached value. Returns undefined if expired or missing.
   */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Set a cached value with optional TTL (seconds).
   */
  set<T>(key: string, value: T, ttl?: number): void {
    // Evict oldest entry if at max size
    if (this.store.size >= this.maxSize) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttl ?? this.defaultTtl) * 1000,
    });
  }

  /**
   * Check if a key exists and is not expired.
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Delete a specific key.
   */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /**
   * Remove all expired entries.
   */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get the number of cached entries.
   */
  size(): number {
    return this.store.size;
  }

  /**
   * Get or set a value using a factory function.
   */
  remember<T>(key: string, ttl: number, factory: () => T): T {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = factory();
    this.set(key, value, ttl);
    return value;
  }
}
