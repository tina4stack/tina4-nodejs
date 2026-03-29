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
  type?: "sqlite" | "postgres" | "mysql" | "mssql" | "sqlserver" | "firebird";
  path?: string;
  url?: string;
  host?: string;
  port?: number;
  user?: string;
  username?: string;
  password?: string;
  database?: string;
}

/**
 * Parsed result from a DATABASE_URL connection string.
 */
export interface ParsedDatabaseUrl {
  type: "sqlite" | "postgres" | "mysql" | "mssql" | "firebird";
  path?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
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

  // Handle sqlite:// separately because URL class mangles the path
  if (url.startsWith("sqlite:///")) {
    // sqlite:///absolute/path — three slashes means absolute
    const path = url.slice("sqlite://".length);
    result = { type: "sqlite", path };
  } else if (url.startsWith("sqlite://")) {
    // sqlite://./relative or sqlite://relative
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
  private poolSize: number = 0;

  /** Round-robin index */
  private poolIndex: number = 0;

  /** Factory for creating new adapters (used by pool) */
  private adapterFactory: (() => Promise<DatabaseAdapter>) | null = null;

  /** Whether to automatically commit after each write operation */
  private autoCommit: boolean = process.env.TINA4_AUTOCOMMIT === "true";

  /** Database engine type (sqlite, postgres, mysql, mssql, firebird) */
  private dbType: string = "sqlite";

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
      db.poolSize = pool;
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
   */
  private getNextAdapter(): DatabaseAdapter {
    if (this.poolSize > 0) {
      const idx = this.poolIndex;
      this.poolIndex = (this.poolIndex + 1) % this.poolSize;
      return this.pool[idx] as DatabaseAdapter;
    }

    return this.adapter!;
  }

  /** Get the underlying adapter (for advanced / escape-hatch usage). */
  getAdapter(): DatabaseAdapter {
    return this.getNextAdapter();
  }

  /** Get the pool size (0 = single connection mode). */
  getPoolSize(): number {
    return this.poolSize;
  }

  /** Get the number of active (created) connections in the pool. */
  getActivePoolCount(): number {
    if (this.poolSize === 0) return this.adapter ? 1 : 0;
    return this.pool.filter(a => a !== null).length;
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

  /** Execute a statement (INSERT, UPDATE, DELETE, DDL). */
  execute(sql: string, params?: unknown[]): unknown {
    const adapter = this.getNextAdapter();
    const result = adapter.execute(sql, params);
    if (this.autoCommit) {
      try { adapter.commit(); } catch { /* no active transaction */ }
    }
    return result;
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
  update(table: string, data: Record<string, unknown>, filter?: Record<string, unknown>): DatabaseWriteResult {
    const adapter = this.getNextAdapter();
    const result = adapter.update(table, data, filter ?? {});
    if (this.autoCommit) {
      try { adapter.commit(); } catch { /* no active transaction */ }
    }
    return result;
  }

  /** Delete rows from a table matching filter. */
  delete(table: string, filter?: Record<string, unknown>): DatabaseWriteResult {
    const adapter = this.getNextAdapter();
    const result = adapter.delete(table, filter ?? {});
    if (this.autoCommit) {
      try { adapter.commit(); } catch { /* no active transaction */ }
    }
    return result;
  }

  /** Close all database connections (pool or single). */
  close(): void {
    if (this.poolSize > 0) {
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

  /** Start a transaction. */
  startTransaction(): void {
    this.getNextAdapter().startTransaction();
  }

  /** Commit the current transaction. */
  commit(): void {
    this.getNextAdapter().commit();
  }

  /** Rollback the current transaction. */
  rollback(): void {
    this.getNextAdapter().rollback();
  }

  /** Check if a table exists. */
  tableExists(name: string): boolean {
    return this.getNextAdapter().tableExists(name);
  }

  /** List all tables in the database. */
  getTables(): string[] {
    return this.getNextAdapter().tables();
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
  }
}

/**
 * Initialize the database from a config object or DATABASE_URL env var.
 * Now returns a Database wrapper instance.
 *
 * Priority:
 *   1. config.url (explicit URL)
 *   2. process.env.DATABASE_URL
 *   3. config.type + config.path (legacy)
 */
export async function initDatabase(config?: DatabaseConfig): Promise<Database> {
  // Resolve credentials: config.user > config.username > env DATABASE_USERNAME
  const resolvedUser = config?.user ?? config?.username ?? process.env.DATABASE_USERNAME;
  const resolvedPassword = config?.password ?? process.env.DATABASE_PASSWORD;

  // Resolve from URL if provided
  const url = config?.url ?? process.env.DATABASE_URL;

  if (url) {
    const adapter = await createAdapterFromUrl(url, resolvedUser, resolvedPassword);
    setAdapter(adapter);
    return new Database(adapter);
  }

  // Legacy config path — normalize "sqlserver" to "mssql"
  const rawType = config?.type ?? "sqlite";
  const type = rawType === "sqlserver" ? "mssql" : rawType;

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
    default:
      throw new Error(`Unknown database type: ${type}`);
  }
}
