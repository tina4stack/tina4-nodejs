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
 */
export class Database {
  private adapter: DatabaseAdapter;

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
   */
  static async create(url: string, username?: string, password?: string): Promise<Database> {
    const adapter = await createAdapterFromUrl(url, username, password);
    setAdapter(adapter);
    return new Database(adapter);
  }

  /**
   * Create a Database from an environment variable.
   * @param envKey - Name of the env var holding the connection URL. Defaults to "DATABASE_URL".
   */
  static async fromEnv(envKey = "DATABASE_URL"): Promise<Database> {
    const url = process.env[envKey];
    if (!url) {
      throw new Error(`Environment variable "${envKey}" is not set.`);
    }
    return Database.create(url);
  }

  /** Get the underlying adapter (for advanced / escape-hatch usage). */
  getAdapter(): DatabaseAdapter {
    return this.adapter;
  }

  /** Query rows with optional pagination. Returns a DatabaseResult wrapper. */
  fetch(sql: string, params?: unknown[], limit?: number, offset?: number): DatabaseResult {
    const rows = this.adapter.fetch<Record<string, unknown>>(sql, params, limit, offset);
    return new DatabaseResult(rows, undefined, undefined, limit, offset);
  }

  /** Fetch a single row or null. */
  fetchOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    return this.adapter.fetchOne<T>(sql, params);
  }

  /** Execute a statement (INSERT, UPDATE, DELETE, DDL). */
  execute(sql: string, params?: unknown[]): unknown {
    return this.adapter.execute(sql, params);
  }

  /** Insert a row into a table. */
  insert(table: string, data: Record<string, unknown>): DatabaseWriteResult {
    return this.adapter.insert(table, data);
  }

  /** Update rows in a table matching filter. */
  update(table: string, data: Record<string, unknown>, filter?: Record<string, unknown>): DatabaseWriteResult {
    return this.adapter.update(table, data, filter ?? {});
  }

  /** Delete rows from a table matching filter. */
  delete(table: string, filter?: Record<string, unknown>): DatabaseWriteResult {
    return this.adapter.delete(table, filter ?? {});
  }

  /** Close the database connection. */
  close(): void {
    this.adapter.close();
  }

  /** Start a transaction. */
  startTransaction(): void {
    this.adapter.startTransaction();
  }

  /** Commit the current transaction. */
  commit(): void {
    this.adapter.commit();
  }

  /** Rollback the current transaction. */
  rollback(): void {
    this.adapter.rollback();
  }

  /** Check if a table exists. */
  tableExists(name: string): boolean {
    return this.adapter.tableExists(name);
  }

  /** List all tables in the database. */
  getTables(): string[] {
    return this.adapter.tables();
  }

  /** Get the last auto-increment id. */
  getLastId(): string | number {
    const id = this.adapter.lastInsertId();
    if (id === null) return 0;
    return typeof id === "bigint" ? id.toString() : id;
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
