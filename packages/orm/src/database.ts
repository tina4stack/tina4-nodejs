import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseAdapter, DatabaseResult as DatabaseWriteResult } from "./types.js";
import { DatabaseResult } from "./databaseResult.js";

let activeAdapter: DatabaseAdapter | null = null;
const namedAdapters: Map<string, DatabaseAdapter> = new Map();

export function setAdapter(adapter: DatabaseAdapter): void {
  activeAdapter = adapter;
}

export function getAdapter(): DatabaseAdapter {
  if (!activeAdapter) {
    throw new Error("No database adapter configured. Call setAdapter() first.");
  }
  return activeAdapter;
}

/**
 * Register a named adapter for multi-database support.
 * Models reference it via `static _db = 'name'`.
 */
export function setNamedAdapter(name: string, adapter: DatabaseAdapter): void {
  namedAdapters.set(name, adapter);
}

/**
 * Get a named adapter. Falls back to the default adapter if name not found.
 */
export function getNamedAdapter(name: string): DatabaseAdapter {
  const adapter = namedAdapters.get(name);
  if (adapter) return adapter;
  // Fall back to default
  return getAdapter();
}

export function closeDatabase(): void {
  if (activeAdapter) {
    activeAdapter.close();
    activeAdapter = null;
  }
  for (const [, adapter] of namedAdapters) {
    adapter.close();
  }
  namedAdapters.clear();
}

export interface DatabaseConfig {
  type?: "sqlite" | "postgres" | "mysql" | "mssql" | "sqlserver" | "firebird" | "mongodb" | "odbc";
  path?: string;
  url?: string;
  host?: string;
  port?: number;
  user?: string;
  username?: string;
  password?: string;
  database?: string;
  /** ODBC-specific: full connection string, e.g. "DSN=MyDSN" or "DRIVER={SQL Server};SERVER=host;DATABASE=db" */
  connectionString?: string;
}

/**
 * Parsed result from a DATABASE_URL connection string.
 */
export interface ParsedDatabaseUrl {
  type: "sqlite" | "postgres" | "mysql" | "mssql" | "firebird" | "mongodb" | "odbc";
  path?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** ODBC-specific: raw connection string passed to odbc.connect() */
  connectionString?: string;
}

/**
 * Parse a DATABASE_URL connection string into its components.
 *
 * Supported formats:
 *   sqlite:///path/to/db.sqlite
 *   sqlite://./relative/path.db
 *   postgresql://user:pass@host:port/dbname
 *   postgres://user:pass@host:port/dbname
 *   mysql://user:pass@host:port/dbname
 *
 * @param url - The connection URL string.
 * @param username - Optional username to merge when the URL has no credentials.
 * @param password - Optional password to merge when the URL has no credentials.
 * @returns Parsed database configuration.
 * @throws Error if the URL scheme is not supported.
 */
export function parseDatabaseUrl(url: string, username?: string, password?: string): ParsedDatabaseUrl {
  let result: ParsedDatabaseUrl;

  // Handle sqlite:// separately because URL class mangles the path.
  //
  // Convention (matches tina4-python, tina4-php, and the docs):
  //   sqlite::memory:              → in-memory
  //   sqlite:///:memory:           → in-memory (URL form)
  //   sqlite:///app.db             → ./app.db (relative to cwd)
  //   sqlite:///data/app.db        → ./data/app.db (relative)
  //   sqlite:////absolute/app.db   → /absolute/app.db (absolute)
  //   sqlite:///C:/Users/app.db    → C:/Users/app.db (Windows absolute)
  if (url === "sqlite::memory:" || url === "sqlite:///:memory:") {
    result = { type: "sqlite", path: ":memory:" };
  } else if (url.startsWith("sqlite:///")) {
    // Strip the "sqlite://" prefix (leaving one "/" + path)
    let rest = url.slice("sqlite://".length); // e.g. "/data/app.db" or "//abs/app.db" or "/C:/Users/..."
    // Drop exactly one leading "/"
    if (rest.startsWith("/")) rest = rest.slice(1);
    // Windows absolute: C:/Users/app.db or C:\...
    const isWindowsAbs = /^[A-Za-z]:[\/\\]/.test(rest);
    // Unix absolute: still starts with "/" after the strip (four-slash URL form)
    const isUnixAbs = rest.startsWith("/");
    result = { type: "sqlite", path: isWindowsAbs || isUnixAbs ? rest : rest };
    // Relative paths are resolved against cwd by the SQLite adapter at connect time;
    // keep the string as-is here so tests can inspect the raw form.
  } else if (url.startsWith("sqlite://")) {
    // sqlite://./relative or sqlite://relative — legacy two-slash form
    const path = url.slice("sqlite://".length);
    result = { type: "sqlite", path };
  } else if (url.startsWith("mssql://") || url.startsWith("sqlserver://")) {
    // Handle mssql:// and sqlserver:// with custom parsing (URL class doesn't know these schemes)
    const match = url.match(/(?:mssql|sqlserver):\/\/(?:([^:]+):([^@]+)@)?([^:/]+)(?::(\d+))?\/(.*)/);
    if (!match) throw new Error(`Invalid MSSQL URL: ${url}`);
    result = {
      type: "mssql",
      user: match[1] ? decodeURIComponent(match[1]) : undefined,
      password: match[2] ? decodeURIComponent(match[2]) : undefined,
      host: match[3],
      port: match[4] ? parseInt(match[4], 10) : undefined,
      database: match[5],
    };
  } else if (url.startsWith("firebird://")) {
    const match = url.match(/firebird:\/\/(?:([^:]+):([^@]+)@)?([^:/]+)(?::(\d+))?\/(.*)/);
    if (!match) throw new Error(`Invalid Firebird URL: ${url}`);
    result = {
      type: "firebird",
      user: match[1] ? decodeURIComponent(match[1]) : undefined,
      password: match[2] ? decodeURIComponent(match[2]) : undefined,
      host: match[3],
      port: match[4] ? parseInt(match[4], 10) : undefined,
      database: "/" + match[5],
    };
  } else if (url.startsWith("odbc:///")) {
    // odbc:///DSN=MyDSN  or  odbc:///DRIVER={driver};SERVER=host;DATABASE=db
    // Strip the "odbc:///" prefix and pass the rest directly as the connection string
    const connectionString = url.slice("odbc:///".length);
    result = { type: "odbc", connectionString };
  } else if (url.startsWith("mongodb://") || url.startsWith("mongodb+srv://")) {
    // Pass through as-is; MongodbAdapter handles the full connection string
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid MongoDB URL: ${url}`);
    }
    const database = parsed.pathname.replace(/^\//, "") || "tina4";
    result = {
      type: "mongodb",
      host: parsed.hostname || undefined,
      port: parsed.port ? parseInt(parsed.port, 10) : undefined,
      user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      database,
    };
  } else {
    // Normalize postgres:// to postgresql:// for URL parsing
    const normalizedUrl = url.startsWith("postgres://")
      ? url.replace(/^postgres:\/\//, "postgresql://")
      : url;

    let parsed: URL;
    try {
      parsed = new URL(normalizedUrl);
    } catch {
      throw new Error(`Invalid database URL: ${url}`);
    }

    const scheme = parsed.protocol.replace(/:$/, "");
    let type: "sqlite" | "postgres" | "mysql" | "mssql" | "firebird";

    switch (scheme) {
      case "postgresql":
        type = "postgres";
        break;
      case "mysql":
        type = "mysql";
        break;
      default:
        throw new Error(`Unsupported database URL scheme: "${scheme}". Supported: sqlite, postgres/postgresql, mysql, mssql/sqlserver, firebird.`);
    }

    const database = parsed.pathname.startsWith("/")
      ? parsed.pathname.slice(1)
      : parsed.pathname;

    result = {
      type,
      host: parsed.hostname || undefined,
      port: parsed.port ? parseInt(parsed.port, 10) : undefined,
      user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      database: database || undefined,
    };
  }

  // Merge separate username/password when the URL contained no credentials
  if (!result.user && username) {
    result.user = username;
  }
  if (!result.password && password) {
    result.password = password;
  }

  return result;
}

/**
 * A wrapper class around a DatabaseAdapter that provides a clean, high-level API.
 *
 * Mirrors the Database class in Python/Ruby Tina4 implementations.
 *
 * Usage:
 *   const db = await Database.create("sqlite:///path/to/db.sqlite");
 *   const rows = db.fetch("SELECT * FROM users WHERE active = ?", [true], 10, 0);
 *   const user = db.fetchOne("SELECT * FROM users WHERE id = ?", [1]);
 *   db.insert("users", { name: "Alice", email: "alice@example.com" });
 *   db.update("users", { name: "Bob" }, { id: 1 });
 *   db.delete("users", { id: 1 });
 *   db.close();
 *
 * Connection pooling:
 *   const db = await Database.create("sqlite:///data/app.db", undefined, undefined, 4);
 *   // 4 connections, round-robin rotation
 */
export class Database {
  private adapter: DatabaseAdapter | null;

  /** Connection pool — array of adapters with lazy creation */
  private pool: (DatabaseAdapter | null)[] = [];

  /** Pool size (0 = single connection) */
  private _poolSize: number = 0;

  /** Round-robin index */
  private poolIndex: number = 0;

  /** Factory for creating new adapters (used by pool) */
  private adapterFactory: (() => Promise<DatabaseAdapter>) | null = null;

  /** Whether to automatically commit after each write operation */
  private autoCommit: boolean = process.env.TINA4_AUTOCOMMIT === "true";
  private lastError: string | null = null;

  /** Database engine type (sqlite, postgres, mysql, mssql, firebird) */
  private dbType: string = "sqlite";

  /**
   * Async-local storage for the adapter pinned to the current transaction.
   *
   * With pooling enabled, ordinary calls round-robin through the pool. Inside
   * a transaction, however, all calls must land on the SAME adapter — otherwise
   * startTransaction(), execute() and commit() each rotate to a different
   * connection and the transaction is meaningless (executes autocommit on
   * whatever adapter they hit; the final commit lands on yet another adapter
   * that has nothing to commit; rollback() is silently no-op'd).
   *
   * AsyncLocalStorage is the Node analog of Python's threading.local. It pins
   * the adapter to the current async task tree so concurrent transactions on
   * the same Database don't clobber each other. startTransaction() sets the
   * pin via .enterWith(); commit()/rollback() clear it.
   */
  private txStore: AsyncLocalStorage<{ adapter: DatabaseAdapter | null }> = new AsyncLocalStorage();

  /**
   * Create a Database wrapping an existing adapter.
   * For creating a Database from a URL, use the async static factories:
   *   Database.create(url) or Database.fromEnv()
   */
  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter;
  }

  /**
   * Async factory: creates a Database from a connection URL.
   * Works with all adapter types (sqlite, postgres, mysql, mssql, firebird).
   *
   * @param url - Connection URL
   * @param username - Optional username
   * @param password - Optional password
   * @param pool - Number of pooled connections (0 = single, N>0 = round-robin)
   */
  static async create(url: string, username?: string, password?: string, pool: number = 0): Promise<Database> {
    const parsed = parseDatabaseUrl(url, username, password);

    if (pool > 0) {
      // Pooled mode — create all adapters eagerly
      const adapters: DatabaseAdapter[] = [];
      for (let i = 0; i < pool; i++) {
        adapters.push(await createAdapterFromUrl(url, username, password));
      }

      // Set the first adapter as the global default
      setAdapter(adapters[0]);

      const db = new Database(adapters[0]);
      db._poolSize = pool;
      db.pool = adapters;
      db.poolIndex = 0;
      db.adapter = null;  // Don't use single-adapter path
      db.adapterFactory = () => createAdapterFromUrl(url, username, password);
      db.dbType = parsed.type;
      return db;
    }

    // Single-connection mode — current behavior
    const adapter = await createAdapterFromUrl(url, username, password);
    setAdapter(adapter);
    const db = new Database(adapter);
    db.dbType = parsed.type;
    return db;
  }

  /**
   * Create a Database from an environment variable.
   * @param envKey - Name of the env var holding the connection URL. Defaults to "DATABASE_URL".
   * @param pool - Number of pooled connections (0 = single, N>0 = round-robin)
   */
  static async fromEnv(envKey = "DATABASE_URL", pool: number = 0): Promise<Database> {
    const url = process.env[envKey];
    if (!url) {
      throw new Error(`Environment variable "${envKey}" is not set.`);
    }
    return Database.create(url, undefined, undefined, pool);
  }

  /**
   * Get the next adapter — from pool (round-robin) or single connection.
   *
   * If a transaction is active (an adapter is pinned in async-local storage),
   * that adapter is returned for every call so the whole transaction is
   * atomic on one connection. Otherwise pooled mode round-robins.
   */
  private getNextAdapter(): DatabaseAdapter {
    const pinned = this.txStore.getStore()?.adapter;
    if (pinned) return pinned;

    if (this._poolSize > 0) {
      const idx = this.poolIndex;
      this.poolIndex = (this.poolIndex + 1) % this._poolSize;
      return this.pool[idx] as DatabaseAdapter;
    }

    return this.adapter!;
  }

  /** Get the underlying adapter (for advanced / escape-hatch usage). */
  getAdapter(): DatabaseAdapter {
    return this.getNextAdapter();
  }

  /** Get the pool size (0 = single connection mode). */
  poolSize(): number {
    return this._poolSize;
  }

  /** Alias for poolSize() — returns total pool size (0 = single connection mode). */
  size(): number {
    return this._poolSize;
  }

  /** Get the number of active (created) connections in the pool. */
  activeCount(): number {
    if (this._poolSize === 0) return this.adapter ? 1 : 0;
    return this.pool.filter(a => a !== null).length;
  }

  /**
   * Borrow a connection from the pool (or the single adapter).
   * The caller is responsible for returning it via checkin().
   */
  checkout(): DatabaseAdapter {
    return this.getNextAdapter();
  }

  /**
   * Return a borrowed connection to the pool.
   * For round-robin pools this is a no-op (connections stay in the pool array),
   * but the method exists for API parity and future pooling strategies.
   */
  checkin(_adapter: DatabaseAdapter): void {
    // No-op for round-robin pool — connections are not removed on checkout.
  }

  /**
   * Close all pooled connections and clear the pool.
   * Equivalent to close() but named for explicit pool teardown.
   */
  closeAll(): void {
    this.close();
  }

  /** Query rows with optional pagination. Returns a DatabaseResult wrapper. */
  fetch(sql: string, params?: unknown[], limit?: number, offset?: number): DatabaseResult {
    const adapter = this.getNextAdapter();
    const rows = adapter.fetch<Record<string, unknown>>(sql, params, limit, offset);
    return new DatabaseResult(rows, undefined, undefined, limit, offset, adapter, sql);
  }

  /** Fetch a single row or null. */
  fetchOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    return this.getNextAdapter().fetchOne<T>(sql, params);
  }

  /**
   * Execute a write statement. Returns true/false for simple writes.
   * If SQL contains RETURNING, CALL, EXEC, or SELECT, returns the result set.
   */
  execute(sql: string, params?: unknown[]): boolean | unknown {
    try {
      const adapter = this.getNextAdapter();
      const result = adapter.execute(sql, params);
      if (this.autoCommit) {
        try { adapter.commit(); } catch { /* no active transaction */ }
      }
      this.lastError = null;
      const upper = sql.trim().toUpperCase();
      if (upper.includes("RETURNING") || upper.startsWith("CALL ") ||
          upper.startsWith("EXEC ") || upper.startsWith("SELECT ")) {
        return result;
      }
      return true;
    } catch (e: any) {
      this.lastError = e?.message ?? String(e);
      return false;
    }
  }

  /** Insert a row into a table. */
  insert(table: string, data: Record<string, unknown>): DatabaseWriteResult {
    const adapter = this.getNextAdapter();
    const result = adapter.insert(table, data);
    if (this.autoCommit) {
      try { adapter.commit(); } catch { /* no active transaction */ }
    }
    return result;
  }

  /** Update rows in a table matching filter. */
  update(table: string, data: Record<string, unknown>, filter?: Record<string, unknown>, params?: unknown[]): DatabaseWriteResult {
    const adapter = this.getNextAdapter();
    const result = adapter.update(table, data, filter ?? {}, params);
    if (this.autoCommit) {
      try { adapter.commit(); } catch { /* no active transaction */ }
    }
    return result;
  }

  /** Delete rows from a table matching filter. */
  delete(table: string, filter?: Record<string, unknown>, params?: unknown[]): DatabaseWriteResult {
    const adapter = this.getNextAdapter();
    const result = adapter.delete(table, filter ?? {}, params);
    if (this.autoCommit) {
      try { adapter.commit(); } catch { /* no active transaction */ }
    }
    return result;
  }

  /** Close all database connections (pool or single). */
  close(): void {
    if (this._poolSize > 0) {
      for (let i = 0; i < this.pool.length; i++) {
        if (this.pool[i] !== null) {
          this.pool[i]!.close();
          this.pool[i] = null;
        }
      }
    } else if (this.adapter) {
      this.adapter.close();
    }
  }

  /**
   * Start a transaction. Pins the adapter to the current async context for
   * the whole transaction so executes and the final commit/rollback all run
   * on the same connection (critical when pool > 0).
   */
  startTransaction(): void {
    // Pick an adapter using the normal selection logic, then pin it.
    const adapter = this.getNextAdapter();
    let store = this.txStore.getStore();
    if (store) {
      store.adapter = adapter;
    } else {
      this.txStore.enterWith({ adapter });
    }
    adapter.startTransaction();
  }

  /** Commit the current transaction and release the adapter pin. */
  commit(): void {
    const adapter = this.getNextAdapter();
    adapter.commit();
    const store = this.txStore.getStore();
    if (store) store.adapter = null;
  }

  /** Rollback the current transaction and release the adapter pin. */
  rollback(): void {
    const adapter = this.getNextAdapter();
    adapter.rollback();
    const store = this.txStore.getStore();
    if (store) store.adapter = null;
  }

  /** Check if a table exists. */
  tableExists(name: string): boolean {
    return this.getNextAdapter().tableExists(name);
  }

  /** List all tables in the database. */
  getTables(): string[] {
    return this.getNextAdapter().tables();
  }

  /**
   * Get column metadata for a table.
   * Uses the adapter's columns() method which handles engine-specific introspection
   * (PRAGMA table_info for SQLite, information_schema.columns for others).
   *
   * @param tableName - Name of the table to inspect.
   * @returns Array of column info objects: { name, type, nullable, default, primaryKey }.
   */
  getColumns(tableName: string): { name: string; type: string; nullable?: boolean; default?: unknown; primaryKey?: boolean }[] {
    return this.getNextAdapter().columns(tableName);
  }

  /**
   * Execute a SQL statement with multiple parameter sets (batch insert/update).
   * Wraps all executions in a single transaction for atomicity and performance.
   *
   * @param sql - The SQL statement with parameter placeholders.
   * @param paramSets - Array of parameter arrays, one per execution.
   * @returns Array of results from each execution.
   */
  executeMany(sql: string, paramSets: unknown[][] = []): unknown[] {
    const adapter = this.getNextAdapter();
    const results: unknown[] = [];

    adapter.startTransaction();
    try {
      for (const params of paramSets) {
        results.push(adapter.execute(sql, params));
      }
      adapter.commit();
    } catch (e) {
      adapter.rollback();
      throw e;
    }

    return results;
  }

  /** Return the last execute() error message, or null. */
  getError(): string | null {
    return this.lastError ?? null;
  }

  /** Return query cache statistics. */
  cacheStats(): { enabled: boolean; size: number; ttl: number } {
    return {
      enabled: process.env.TINA4_DB_CACHE === "true",
      size: 0,
      ttl: parseInt(process.env.TINA4_DB_CACHE_TTL ?? "30", 10),
    };
  }

  /** Clear the query result cache. */
  cacheClear(): void {
    // Node database layer does not maintain an internal query cache at this
    // level (caching lives in the SQLTranslation layer). This method exists
    // for API parity with PHP, Python, and Ruby.
    // To clear the SQLTranslation query cache use: QueryCache.clear()
  }

  /** Get the last auto-increment id. */
  getLastId(): string | number {
    const id = this.getNextAdapter().lastInsertId();
    if (id === null) return 0;
    return typeof id === "bigint" ? id.toString() : id;
  }

  /**
   * Create the tina4_sequences table if it doesn't exist.
   * Used by sequenceNext() for race-safe ID generation on
   * SQLite, MySQL, MSSQL, and as a PostgreSQL fallback.
   */
  private ensureSequenceTable(): void {
    const adapter = this.getNextAdapter();

    if (!adapter.tableExists("tina4_sequences")) {
      if (this.dbType === "mssql") {
        adapter.execute(
          "CREATE TABLE tina4_sequences (" +
          "seq_name VARCHAR(200) NOT NULL PRIMARY KEY, " +
          "current_value INTEGER NOT NULL DEFAULT 0)"
        );
      } else {
        adapter.execute(
          "CREATE TABLE IF NOT EXISTS tina4_sequences (" +
          "seq_name VARCHAR(200) NOT NULL PRIMARY KEY, " +
          "current_value INTEGER NOT NULL DEFAULT 0)"
        );
      }
      try { adapter.commit(); } catch { /* no active transaction */ }
    }
  }

  /**
   * Atomically increment and return the next value from the sequence table.
   *
   * If the sequence row doesn't exist yet, seeds it from MAX(pkColumn)
   * of the given table (or 0 if the table is empty/missing).
   */
  private sequenceNext(seqName: string, table?: string, pkColumn = "id"): number {
    this.ensureSequenceTable();
    const adapter = this.getNextAdapter();

    // Check if the sequence row exists
    const existing = adapter.fetchOne<Record<string, unknown>>(
      "SELECT current_value FROM tina4_sequences WHERE seq_name = ?",
      [seqName]
    );

    if (existing == null) {
      // Seed from current MAX
      let seedValue = 0;
      if (table) {
        try {
          const maxRow = adapter.fetchOne<Record<string, unknown>>(
            `SELECT MAX(${pkColumn}) AS max_id FROM ${table}`
          );
          if (maxRow?.max_id != null) {
            seedValue = Number(maxRow.max_id);
          }
        } catch {
          // Table doesn't exist — start at 0
        }
      }

      adapter.execute(
        "INSERT INTO tina4_sequences (seq_name, current_value) VALUES (?, ?)",
        [seqName, seedValue]
      );
      try { adapter.commit(); } catch { /* no active transaction */ }
    }

    // Atomic increment
    adapter.execute(
      "UPDATE tina4_sequences SET current_value = current_value + 1 WHERE seq_name = ?",
      [seqName]
    );
    try { adapter.commit(); } catch { /* no active transaction */ }

    // Read the new value
    const row = adapter.fetchOne<Record<string, unknown>>(
      "SELECT current_value FROM tina4_sequences WHERE seq_name = ?",
      [seqName]
    );
    return row?.current_value != null ? Number(row.current_value) : 1;
  }

  /**
   * Pre-generate the next available primary key ID using engine-aware strategies.
   *
   * - Firebird: auto-creates a generator if missing, then increments via GEN_ID (atomic).
   * - PostgreSQL: tries nextval() first; if sequence missing, auto-creates it
   *   seeded from MAX; falls through to sequence table on failure.
   * - SQLite/MySQL/MSSQL: uses tina4_sequences table with atomic UPDATE + SELECT
   *   (race-safe, replaces old MAX+1).
   * - Returns 1 if the table is empty or does not exist.
   */
  getNextId(table: string, pkColumn = "id", generatorName?: string): number {
    const adapter = this.getNextAdapter();

    // MongoDB — getNextId() is not supported synchronously.
    // MongoDB uses ObjectId for primary keys by default.
    // For integer sequences, use getNextIdAsync() instead.
    if (this.dbType === "mongodb") {
      throw new Error(
        "getNextId() is not supported for MongoDB (async adapter). " +
        "MongoDB uses ObjectId for _id by default. " +
        "For integer sequences, use getNextIdAsync() or let MongoDB generate _id automatically.",
      );
    }

    // Firebird — use generators (atomic)
    if (this.dbType === "firebird") {
      const genName = generatorName ?? `GEN_${table.toUpperCase()}_ID`;

      // Auto-create the generator if it does not exist
      try {
        adapter.execute(`CREATE GENERATOR ${genName}`);
      } catch {
        // Generator already exists — ignore
      }

      const row = adapter.fetchOne<Record<string, unknown>>(`SELECT GEN_ID(${genName}, 1) AS NEXT_ID FROM RDB$DATABASE`);
      return Number(row?.NEXT_ID ?? row?.next_id ?? 1);
    }

    // PostgreSQL — try sequence first, auto-create if missing, fall through to sequence table
    if (this.dbType === "postgres") {
      const seqName = generatorName ?? `${table.toLowerCase()}_${pkColumn.toLowerCase()}_seq`;
      try {
        const row = adapter.fetchOne<Record<string, unknown>>(`SELECT nextval('${seqName}') AS next_id`);
        if (row?.next_id != null) {
          return Number(row.next_id);
        }
      } catch {
        // Sequence doesn't exist — try to auto-create it
      }

      // Auto-create sequence seeded from MAX
      try {
        const maxRow = adapter.fetchOne<Record<string, unknown>>(
          `SELECT COALESCE(MAX(${pkColumn}), 0) AS max_id FROM ${table}`
        );
        const start = maxRow?.max_id != null ? Number(maxRow.max_id) + 1 : 1;
        adapter.execute(`CREATE SEQUENCE ${seqName} START WITH ${start}`);
        try { adapter.commit(); } catch { /* no active transaction */ }
        const row = adapter.fetchOne<Record<string, unknown>>(`SELECT nextval('${seqName}') AS next_id`);
        if (row?.next_id != null) {
          return Number(row.next_id);
        }
      } catch {
        // Fall through to sequence table
      }
    }

    // SQLite / MySQL / MSSQL / PostgreSQL fallback — atomic sequence table
    const seqKey = generatorName ?? `${table}.${pkColumn}`;
    return this.sequenceNext(seqKey, table, pkColumn);
  }
}

/**
 * Internal helper: create a DatabaseAdapter from a parsed URL.
 * Extracted from initDatabase so Database.create() can reuse it.
 */
async function createAdapterFromUrl(url: string, username?: string, password?: string): Promise<DatabaseAdapter> {
  const parsed = parseDatabaseUrl(url, username, password);

  switch (parsed.type) {
    case "sqlite": {
      const { SQLiteAdapter } = await import("./adapters/sqlite.js");
      return new SQLiteAdapter(parsed.path ?? "./data/tina4.db");
    }
    case "postgres": {
      const { PostgresAdapter } = await import("./adapters/postgres.js");
      const adapter = new PostgresAdapter({
        host: parsed.host,
        port: parsed.port,
        user: parsed.user,
        password: parsed.password,
        database: parsed.database,
      });
      await adapter.connect();
      return adapter;
    }
    case "mysql": {
      const { MysqlAdapter } = await import("./adapters/mysql.js");
      const adapter = new MysqlAdapter({
        host: parsed.host,
        port: parsed.port,
        user: parsed.user,
        password: parsed.password,
        database: parsed.database,
      });
      await adapter.connect();
      return adapter;
    }
    case "mssql": {
      const { MssqlAdapter } = await import("./adapters/mssql.js");
      const adapter = new MssqlAdapter({
        host: parsed.host,
        port: parsed.port,
        user: parsed.user,
        password: parsed.password,
        database: parsed.database,
      });
      await adapter.connect();
      return adapter;
    }
    case "firebird": {
      const { FirebirdAdapter } = await import("./adapters/firebird.js");
      const adapter = new FirebirdAdapter({
        host: parsed.host,
        port: parsed.port,
        user: parsed.user,
        password: parsed.password,
        database: parsed.database,
      });
      await adapter.connect();
      return adapter;
    }
    case "mongodb": {
      const { MongodbAdapter } = await import("./adapters/mongodb.js");
      const adapter = new MongodbAdapter(url);
      await adapter.connect();
      return adapter;
    }
    case "odbc": {
      const { OdbcAdapter } = await import("./adapters/odbc.js");
      const adapter = new OdbcAdapter({ connectionString: parsed.connectionString ?? "" });
      await adapter.connect();
      return adapter;
    }
  }
}

/**
 * Initialize the database from a config object or TINA4_DATABASE_URL env var.
 * Now returns a Database wrapper instance.
 *
 * Priority:
 *   1. config.url (explicit URL)
 *   2. process.env.TINA4_DATABASE_URL
 *   3. config.type + config.path (legacy)
 */
/**
 * Resolve the connection-pool size from `TINA4_DB_POOL`.
 *
 * Default: 0 (single-connection mode). Any positive integer enables
 * round-robin pooling with that many connections — Database.create() honours
 * this transparently. The env var is the simple deploy-time override; tests
 * and library users can still pass `pool` directly to Database.create().
 */
export function resolveDbPool(): number {
  const raw = process.env.TINA4_DB_POOL;
  if (raw === undefined || raw.trim() === "") return 0;
  const n = parseInt(raw, 10);
  return isNaN(n) || n < 0 ? 0 : n;
}

export async function initDatabase(config?: DatabaseConfig): Promise<Database> {
  // Resolve credentials: config.user > config.username > env TINA4_DATABASE_USERNAME
  const resolvedUser = config?.user ?? config?.username ?? process.env.TINA4_DATABASE_USERNAME;
  const resolvedPassword = config?.password ?? process.env.TINA4_DATABASE_PASSWORD;

  // Resolve from URL if provided
  const url = config?.url ?? process.env.TINA4_DATABASE_URL;

  if (url) {
    const pool = resolveDbPool();
    if (pool > 0) {
      // Pool-aware path — delegate to Database.create which manages
      // round-robin adapter rotation and async-local-storage transaction pinning.
      return Database.create(url, resolvedUser, resolvedPassword, pool);
    }
    const adapter = await createAdapterFromUrl(url, resolvedUser, resolvedPassword);
    setAdapter(adapter);
    return new Database(adapter);
  }

  // Legacy config path — normalize "sqlserver" to "mssql"
  const rawType = config?.type ?? "sqlite";
  const type = rawType === "sqlserver" ? "mssql" : rawType;

  // Loud warning when we hit the default SQLite path because nothing was
  // configured. Silent fallback was the cause of "my migrations went to the
  // wrong DB" — the developer thought their .env was being honoured.
  // Only warn when the caller passed no config AND no env var was set; an
  // explicit `{ type: "sqlite" }` call is intentional and stays silent.
  if (config === undefined && !process.env.TINA4_DATABASE_URL) {
    const path = "./data/tina4.db";
    console.warn(
      `[tina4] No TINA4_DATABASE_URL set — falling back to SQLite at ${path}. ` +
      `If you meant to use Postgres/MySQL/etc., set TINA4_DATABASE_URL in your .env ` +
      `and re-run. (Was the .env loaded? CLI commands must call loadEnv() first.)`,
    );
  }

  switch (type) {
    case "sqlite": {
      const { SQLiteAdapter } = await import("./adapters/sqlite.js");
      const adapter = new SQLiteAdapter(config?.path ?? "./data/tina4.db");
      setAdapter(adapter);
      return new Database(adapter);
    }
    case "postgres": {
      const { PostgresAdapter } = await import("./adapters/postgres.js");
      const adapter = new PostgresAdapter({
        host: config?.host,
        port: config?.port,
        user: resolvedUser,
        password: resolvedPassword,
        database: config?.database,
      });
      await adapter.connect();
      setAdapter(adapter);
      return new Database(adapter);
    }
    case "mysql": {
      const { MysqlAdapter } = await import("./adapters/mysql.js");
      const adapter = new MysqlAdapter({
        host: config?.host,
        port: config?.port,
        user: resolvedUser,
        password: resolvedPassword,
        database: config?.database,
      });
      await adapter.connect();
      setAdapter(adapter);
      return new Database(adapter);
    }
    case "mssql": {
      const { MssqlAdapter } = await import("./adapters/mssql.js");
      const adapter = new MssqlAdapter({
        host: config?.host,
        port: config?.port,
        user: resolvedUser,
        password: resolvedPassword,
        database: config?.database,
      });
      await adapter.connect();
      setAdapter(adapter);
      return new Database(adapter);
    }
    case "firebird": {
      const { FirebirdAdapter } = await import("./adapters/firebird.js");
      const adapter = new FirebirdAdapter({
        host: config?.host,
        port: config?.port,
        user: resolvedUser,
        password: resolvedPassword,
        database: config?.database,
      });
      await adapter.connect();
      setAdapter(adapter);
      return new Database(adapter);
    }
    case "mongodb": {
      const { MongodbAdapter } = await import("./adapters/mongodb.js");
      const creds = resolvedUser && resolvedPassword
        ? `${encodeURIComponent(resolvedUser)}:${encodeURIComponent(resolvedPassword)}@`
        : "";
      const host = config?.host ?? "localhost";
      const port = config?.port ?? 27017;
      const database = config?.database ?? "tina4";
      const connectionString = `mongodb://${creds}${host}:${port}/${database}`;
      const adapter = new MongodbAdapter(connectionString);
      await adapter.connect();
      setAdapter(adapter);
      return new Database(adapter);
    }
    case "odbc": {
      const { OdbcAdapter } = await import("./adapters/odbc.js");
      const connStr = config?.connectionString ?? config?.url?.replace(/^odbc:\/\/\//, "") ?? "";
      const adapter = new OdbcAdapter({ connectionString: connStr });
      await adapter.connect();
      setAdapter(adapter);
      return new Database(adapter);
    }
    default:
      throw new Error(`Unknown database type: ${type}`);
  }
}
