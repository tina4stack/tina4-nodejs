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

  /**
   * v3.13.14 (#48): split a possibly-qualified table name into [schema, table].
   *
   * A model whose table name is qualified — PostgreSQL "gift_cards.gift_card",
   * MSSQL "dbo.widget", MySQL "otherdb.table", SQLite "attached.table" — lives
   * in that schema/catalog, not the default. Adapters use this so tableExists /
   * getColumns query the right namespace instead of matching the whole dotted
   * string as one flat name. Returns [null, name] for a bare name. Splits on the
   * first dot. Firebird has no schemas, so its adapter ignores this.
   */
  static splitSchema(name: string): [string | null, string] {
    const idx = name.indexOf(".");
    if (idx === -1) return [null, name];
    return [name.slice(0, idx), name.slice(idx + 1)];
  }

  /**
   * Hard per-statement bind-parameter ceiling per engine. 0 = never collapse.
   * Sourced from test/fixtures/batch_write_contract.json, byte-identical in all
   * four frameworks.
   */
  static readonly MAX_BIND_PARAMS: Record<string, number> = {
    sqlite: 999,
    postgres: 65535,
    mysql: 65535,
    mssql: 2100,
    firebird: 0,
    odbc: 0,
    mongodb: 0,
  };

  /**
   * The four frameworks do not agree on what an engine calls itself — Python
   * and PHP report "postgresql", Ruby and Node report "postgres". Without
   * normalising, the cap lookup misses and the collapse silently does nothing
   * on the engine with the largest win.
   */
  static readonly ENGINE_ALIASES: Record<string, string> = {
    postgresql: "postgres",
    pgsql: "postgres",
    sqlite3: "sqlite",
    sqlserver: "mssql",
    sqlsrv: "mssql",
    mariadb: "mysql",
  };

  // The `d` flag records group indices, so the head can be sliced at the exact
  // start of the VALUES group rather than by hunting for a parenthesis (the
  // column list has parentheses too).
  private static readonly INSERT_VALUES =
    /^\s*INSERT\s+INTO\s+.+?\s+VALUES\s*\(([^()]*)\)\s*$/dis;

  /**
   * Engines whose lastInsertId reports the FIRST generated id of a multi-row
   * INSERT rather than the last. Verified live, not assumed: a 3-row insert
   * into a fresh MySQL table reports 1 while MAX(id) is 3. SQLite, PostgreSQL
   * and MSSQL already report the last, so collapsing does not change them.
   */
  static readonly FIRST_ID_ENGINES: readonly string[] = ["mysql"];

  /**
   * Normalise a collapsed batch's last id to the LAST row's id.
   *
   * A row-at-a-time batch reports the last row's id simply because the last
   * statement inserted the last row. Collapsing rows into one statement changes
   * that on any engine that reports the FIRST generated id, so this restores
   * the contract instead of quietly redefining it. The ids in one statement are
   * consecutive, so the last is `first + rows - 1`.
   */
  static batchLastId(reportedId: unknown, rowsInChunk: number, engine: string): unknown {
    const lower = (engine ?? "").toLowerCase();
    const name = SQLTranslator.ENGINE_ALIASES[lower] ?? lower;
    if (!SQLTranslator.FIRST_ID_ENGINES.includes(name)) return reportedId;

    const n = typeof reportedId === "bigint" ? Number(reportedId) : Number(reportedId);
    if (reportedId === null || reportedId === undefined || Number.isNaN(n)) {
      return reportedId;                    // UUID/ULID key — no successor
    }
    return n + Math.max(rowsInChunk, 1) - 1;
  }

  /**
   * Collapse a row-at-a-time INSERT batch into chunked multi-row VALUES.
   *
   * A batch that loops one INSERT per row pays a full network round-trip per
   * row, and the round-trip — not SQL building — is the entire cost of a batch
   * write. Measured over 500 rows: PostgreSQL 9848ms row-at-a-time against
   * 15.8ms as a single multi-row statement (625x), MySQL 216x, MSSQL 121x.
   *
   * PURE: no I/O and no engine contact, so the chunking rules are checkable
   * without a database. The live-engine runners prove the rows land.
   *
   * @returns Statements to run INSTEAD of the loop, or an EMPTY array meaning
   *          "not collapsible — keep looping", which is always correct.
   */
  static buildBatchInserts(
    sql: string,
    paramSets: unknown[][],
    engine: string,
  ): Array<[string, unknown[]]> {
    const rows = paramSets ?? [];
    if (rows.length < 2) return [];

    const lower = (engine ?? "").toLowerCase();
    const name = SQLTranslator.ENGINE_ALIASES[lower] ?? lower;
    const cap = SQLTranslator.MAX_BIND_PARAMS[name] ?? 0;
    // Firebird has no multi-row VALUES syntax (verified against a live 5.0.4:
    // -104 Token unknown); ODBC's real ceiling depends on the driver behind it.
    // Emitting SQL the engine cannot parse to save a round-trip is not a trade
    // worth making.
    if (cap <= 0) return [];

    const upper = sql.toUpperCase();
    // A collapsed statement returns N rows where the caller expects one, and
    // conflict arbitration changes once rows share a statement.
    if (
      upper.includes("RETURNING") ||
      upper.includes("ON CONFLICT") ||
      upper.includes("ON DUPLICATE KEY")
    ) {
      return [];
    }

    const match = SQLTranslator.INSERT_VALUES.exec(sql);
    if (match === null) return [];

    // Every slot must be a bare placeholder. `now()` repeated per row inside one
    // statement is not the same write as `now()` evaluated per statement.
    const slots = match[1].split(",").map((s) => s.trim());
    if (slots.length === 0 || slots.some((s) => s !== "?")) return [];

    const columns = slots.length;
    if (rows.some((params) => params.length !== columns)) return [];

    const chunkRows = Math.max(1, Math.floor(cap / columns));
    if (chunkRows < 2) return [];

    const valuesStart = match.indices?.[1]?.[0];
    if (valuesStart === undefined) return [];
    const head = sql.slice(0, valuesStart - 1).trimEnd();
    const oneRow = `(${new Array(columns).fill("?").join(", ")})`;

    const statements: Array<[string, unknown[]]> = [];
    for (let start = 0; start < rows.length; start += chunkRows) {
      const chunk = rows.slice(start, start + chunkRows);
      const flat: unknown[] = [];
      for (const params of chunk) flat.push(...params);
      statements.push([`${head} ${new Array(chunk.length).fill(oneRow).join(", ")}`, flat]);
    }
    return statements;
  }

  /**
   * Blank out string literals, quoted identifiers and comments, so a keyword
   * search sees only real SQL. Blanks are spaces of the SAME LENGTH (newlines
   * preserved), so offsets and line structure still line up with the original.
   *
   * This exists because "does the caller's SQL already have a LIMIT?" used to be
   * `sql.toUpperCase().split("--")[0].includes("LIMIT")`, and MEASURED on a real
   * 150-row table with the 100-row cap in force, every one of these returned
   * ALL 150 ROWS instead of 100:
   *
   *     SELECT * FROM t WHERE label != 'LIMIT' ORDER BY id     -- literal
   *     SELECT * FROM t ORDER BY id -- LIMIT 5                 -- line comment
   *     SELECT * FROM t ORDER BY id /* LIMIT 5 *\/              -- block comment
   *
   * A column named `rate_limit` does it too. That is a silently UNCAPPED read of
   * a whole table, which is the exact production incident the row cap exists to
   * prevent, reachable through an ordinary column name.
   *
   * @param sql Raw SQL, exactly as the caller wrote it.
   * @returns The same string with literals and comments replaced by spaces.
   */
  static scrubSqlText(sql: string): string {
    let out = "";
    let i = 0;
    const blank = (ch: string): string => (ch === "\n" ? "\n" : " ");

    while (i < sql.length) {
      const c = sql[i];
      const next = sql[i + 1];

      // '...' string literal, with '' as the embedded-quote escape
      if (c === "'" || c === '"') {
        const quote = c;
        out += " ";
        i++;
        while (i < sql.length) {
          if (sql[i] === quote) {
            if (sql[i + 1] === quote) {
              out += "  ";
              i += 2;
              continue;
            }
            out += " ";
            i++;
            break;
          }
          out += blank(sql[i]);
          i++;
        }
        continue;
      }

      // -- line comment, to end of line
      if (c === "-" && next === "-") {
        while (i < sql.length && sql[i] !== "\n") {
          out += " ";
          i++;
        }
        continue;
      }

      // /* block comment */
      if (c === "/" && next === "*") {
        out += "  ";
        i += 2;
        while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
          out += blank(sql[i]);
          i++;
        }
        if (i < sql.length) {
          out += "  ";
          i += 2;
        }
        continue;
      }

      out += c;
      i++;
    }

    return out;
  }

  /**
   * True when the statement ENDS with its own LIMIT clause, so appending another
   * would be wrong (and on SQLite, a syntax error).
   *
   * Anchored to the END on purpose. A bare "contains LIMIT" test also matches a
   * LIMIT inside a subquery, where the OUTER statement still needs its cap. This
   * is tina4-php's `SqlNormalizerTrait::hasTrailingLimit` regex, ported verbatim
   * so all four frameworks answer identically: it accepts a numeric value, `?`,
   * `$1` and `:name` placeholders, MySQL's `LIMIT a, b`, and a trailing OFFSET.
   *
   * @param sql Raw SQL; literals and comments are scrubbed before matching.
   */
  static hasTrailingLimit(sql: string): boolean {
    const val = String.raw`(?:\d+|\?|\$\d+|:\w+)`;
    const re = new RegExp(
      String.raw`\bLIMIT\s+${val}(?:\s*,\s*${val})?(?:\s+OFFSET\s+${val})?\s*;?\s*$`,
      "i",
    );
    return re.test(SQLTranslator.scrubSqlText(sql));
  }

  /**
   * Append `LIMIT`/`OFFSET` to a statement unless it already carries its own.
   *
   * The clause goes on a NEW LINE. Appending it inline is the second half of the
   * same bug: `SELECT * FROM t -- note` + ` LIMIT 100` puts the clause INSIDE the
   * trailing comment, where SQLite silently ignores it and the whole table comes
   * back. A newline cannot be commented out by a `--` that started on the line
   * above. Trailing semicolons are stripped first for the same reason
   * (`SELECT * FROM t;` + `LIMIT 100` is a syntax error).
   *
   * @param sql    The caller's statement.
   * @param limit  Row cap to apply; a non-positive value means "no cap".
   * @param offset Rows to skip; omitted or 0 emits no OFFSET.
   */
  static appendLimit(sql: string, limit?: number, offset?: number): string {
    if (limit === undefined || limit === null || limit <= 0) return sql;
    if (SQLTranslator.hasTrailingLimit(sql)) return sql;

    const trimmed = sql.replace(/[\s;]+$/, "");
    const suffix = offset !== undefined && offset > 0
      ? `LIMIT ${limit} OFFSET ${offset}`
      : `LIMIT ${limit}`;
    return `${trimmed}\n${suffix}`;
  }
}

// ── Query Cache ──────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  tags: string[];
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
   * Set a cached value with optional TTL (seconds) and tags for grouped
   * invalidation via clearTag().
   */
  set<T>(key: string, value: T, ttl?: number, tags: string[] = []): void {
    // Evict oldest entry if at max size
    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttl ?? this.defaultTtl) * 1000,
      tags,
    });
  }

  /**
   * Remove all entries that carry the given tag. Returns the number removed.
   */
  clearTag(tag: string): number {
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.tags.includes(tag)) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
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
