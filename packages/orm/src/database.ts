import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseAdapter, DatabaseResult as DatabaseWriteResult, ColumnInfo, FieldDefinition } from "./types.js";
import { DatabaseResult } from "./databaseResult.js";
import { CachedDatabaseAdapter, type CachedAdapterOptions } from "./cachedDatabase.js";
import { QueryCache } from "./sqlTranslator.js";

/**
 * v3.13.12 — strip trailing `;` and whitespace from user-supplied SQL
 * before the framework wraps it with COUNT(*) subqueries or appends
 * LIMIT/OFFSET clauses. Without this, `"SELECT * FROM t;"` becomes
 * `"SELECT * FROM t; LIMIT 100 OFFSET 0"` — a syntax error on every
 * engine. Internal semicolons (in string literals, between meaningful
 * statements) are left alone; drivers reject those if the engine
 * doesn't support multi-statement.
 *
 * Exported so adapters and external tooling can compose it.
 */
export function stripTrailingSemicolons(sql: string): string {
  if (!sql) return sql;
  let stripped = sql.replace(/\s+$/, "");
  while (stripped.endsWith(";")) {
    stripped = stripped.slice(0, -1).replace(/\s+$/, "");
  }
  return stripped;
}

/**
 * Adapter bridge helpers (v3.14.0, Option A).
 *
 * The public Database/BaseModel/QueryBuilder API is async so it works on the
 * async adapters (PostgreSQL/MySQL/MSSQL/Firebird/Mongo). SQLite implements
 * only the synchronous methods (`node:sqlite` is sync); the async adapters
 * implement only the `*Async` variants and make the sync methods throw.
 *
 * Each helper prefers the adapter's `*Async` method when present and awaits it,
 * otherwise falls back to the sync method. For SQLite the fallback resolves
 * instantly; for async adapters the awaited promise does the real work. This is
 * the single chokepoint every public read/write flows through.
 */
export async function adapterFetch<T = Record<string, unknown>>(
  adapter: DatabaseAdapter, sql: string, params?: unknown[], limit?: number, skip?: number, noCache?: boolean,
): Promise<T[]> {
  // `noCache` is forwarded to the CachedDatabaseAdapter so a single read can
  // bypass the query cache; raw adapters have no query cache and no `noCache`
  // parameter, so it is simply not passed to the raw `fetch` path.
  return (adapter as any).fetchAsync
    ? await (adapter as any).fetchAsync(sql, params, limit, skip, noCache)
    : adapter.fetch<T>(sql, params, limit, skip);
}

export async function adapterQuery<T = Record<string, unknown>>(
  adapter: DatabaseAdapter, sql: string, params?: unknown[],
): Promise<T[]> {
  return (adapter as any).queryAsync
    ? await (adapter as any).queryAsync(sql, params)
    : adapter.query<T>(sql, params);
}

export async function adapterFetchOne<T = Record<string, unknown>>(
  adapter: DatabaseAdapter, sql: string, params?: unknown[],
): Promise<T | null> {
  return (adapter as any).fetchOneAsync
    ? await (adapter as any).fetchOneAsync(sql, params)
    : adapter.fetchOne<T>(sql, params);
}

export async function adapterExecute(
  adapter: DatabaseAdapter, sql: string, params?: unknown[],
): Promise<unknown> {
  return (adapter as any).executeAsync
    ? await (adapter as any).executeAsync(sql, params)
    : adapter.execute(sql, params);
}

export async function adapterStartTransaction(adapter: DatabaseAdapter): Promise<void> {
  if ((adapter as any).startTransactionAsync) await (adapter as any).startTransactionAsync();
  else adapter.startTransaction();
}

export async function adapterCommit(adapter: DatabaseAdapter): Promise<void> {
  if ((adapter as any).commitAsync) await (adapter as any).commitAsync();
  else adapter.commit();
}

export async function adapterRollback(adapter: DatabaseAdapter): Promise<void> {
  if ((adapter as any).rollbackAsync) await (adapter as any).rollbackAsync();
  else adapter.rollback();
}

export async function adapterTableExists(adapter: DatabaseAdapter, name: string): Promise<boolean> {
  return (adapter as any).tableExistsAsync
    ? await (adapter as any).tableExistsAsync(name)
    : adapter.tableExists(name);
}

export async function adapterTables(adapter: DatabaseAdapter): Promise<string[]> {
  return (adapter as any).tablesAsync
    ? await (adapter as any).tablesAsync()
    : adapter.tables();
}

export async function adapterColumns(adapter: DatabaseAdapter, table: string): Promise<ColumnInfo[]> {
  return (adapter as any).columnsAsync
    ? await (adapter as any).columnsAsync(table)
    : adapter.columns(table);
}

export async function adapterCreateTable(
  adapter: DatabaseAdapter, name: string, columns: Record<string, FieldDefinition>,
): Promise<void> {
  if ((adapter as any).createTableAsync) await (adapter as any).createTableAsync(name, columns);
  else adapter.createTable(name, columns);
}

/**
 * Extract the engine-assigned auto-increment id from an `execute()` result.
 *
 * SQLite returns `{ lastInsertRowid }`. PostgreSQL (pg) returns a result whose
 * `rows[0].id` holds the value when the statement had a `RETURNING` clause
 * (insertAsync adds one). MySQL/MSSQL adapters set the adapter's lastId,
 * so callers fall back to `adapter.lastInsertId()` when the result has neither.
 */
export function extractLastInsertId(result: unknown): number | bigint | null {
  if (result && typeof result === "object") {
    const r = result as any;
    if (r.lastInsertRowid !== undefined && r.lastInsertRowid !== null) return r.lastInsertRowid;
    if (r.rows?.[0]?.id !== undefined && r.rows[0].id !== null) return r.rows[0].id;
    if (r.lastId !== undefined && r.lastId !== null) return r.lastId;
  }
  return null;
}

let activeAdapter: DatabaseAdapter | null = null;
const namedAdapters: Map<string, DatabaseAdapter> = new Map();

/**
 * Wrap a raw adapter with the query cache so BOTH `db.fetch()` (via the
 * Database wrapper) AND ORM reads (via `getAdapter()` / `getNamedAdapter()`)
 * are cached through the same store and counters.
 *
 * Idempotent: an already-wrapped adapter is returned as-is, so re-binding the
 * same adapter (or binding the adapter a Database wrapper already holds) never
 * double-wraps. `options.sharedCache` backs all pooled connections with one
 * store so a write on any connection invalidates reads cached by all of them.
 *
 * Caching is OFF by default — both layers are opt-in. Turn the request-scoped
 * layer on with TINA4_AUTO_CACHING=true (for read-heavy endpoints) and/or the
 * persistent cross-request layer with TINA4_DB_CACHE=true. With both unset the
 * wrapper passes everything straight through (no cached read-after-write footgun).
 */
export function wrapWithCache(adapter: DatabaseAdapter, options?: CachedAdapterOptions): DatabaseAdapter {
  if (adapter instanceof CachedDatabaseAdapter) return adapter;
  return new CachedDatabaseAdapter(adapter, options);
}

/**
 * Resolve the underlying wrapped adapter for a given raw adapter — used so the
 * Database wrapper and `getAdapter()` end up holding the SAME
 * CachedDatabaseAdapter instance (one cache, one set of counters).
 */
export function setAdapter(adapter: DatabaseAdapter): DatabaseAdapter {
  activeAdapter = wrapWithCache(adapter);
  return activeAdapter;
}

/**
 * Publish the live Database wrapper on `globalThis.__tina4_db` so framework
 * tooling that runs outside the request/ORM path can reach it. The built-in
 * MCP dev-tool handlers (database_query/execute/tables/columns, migration_*,
 * seed_table, project_overview in `@tina4/core`'s mcp.ts) read this global; it
 * is the single chokepoint every `initDatabase()` / `Database.create()` return
 * path flows through, so the global is always set once a connection exists.
 *
 * Returns the same instance so it composes cleanly around a `return`.
 */
function exposeDb(db: Database): Database {
  (globalThis as any).__tina4_db = db;
  return db;
}

/**
 * Clear the request-scoped query cache on every live connection at the start of
 * each HTTP request, so request-scoped caching never serves rows across
 * requests. Persistent-mode connections (TINA4_DB_CACHE=true) are untouched.
 *
 * The request dispatcher calls this. Mirrors Python's
 * `Database.reset_request_caches()`.
 */
export function resetRequestCaches(): void {
  CachedDatabaseAdapter.resetRequestCaches();
}

/**
 * Public, user-facing API to bind a database connection.
 *
 * - No `name`  → registers `adapter` as the global default connection
 *   (what `getAdapter()` returns and what every model resolves to unless it
 *   declares `static _db`). This is the manual equivalent of the auto-binding
 *   that `initDatabase()` performs from `.env`/`TINA4_DATABASE_URL`.
 * - With `name` → registers `adapter` in the named registry. A model with
 *   `static _db = name` resolves to it via `getNamedAdapter(name)`.
 *
 * Mirrors the Python master `bind_database(db, name=None)`.
 *
 *     import { bindDatabase, createAdapterFromUrl } from "@tina4/orm";
 *
 *     // Default connection
 *     bindDatabase(adapter);
 *
 *     // Named secondary connection built from a URL (kept synchronous —
 *     // build the adapter first, then bind it)
 *     bindDatabase(await createAdapterFromUrl(url, user, pass), "analytics");
 *
 * `bindDatabase` itself is synchronous: it takes an already-constructed
 * adapter. Use `createAdapterFromUrl()` to build a named secondary adapter
 * from a URL without making it the default.
 */
export function bindDatabase(adapter: DatabaseAdapter, name?: string): void {
  if (name === undefined) {
    setAdapter(adapter);
  } else {
    // Named connections are cached too, so ORM models pointed at them with
    // `static _db = name` get the same request-scoped/persistent caching.
    namedAdapters.set(name, wrapWithCache(adapter));
  }
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
  namedAdapters.set(name, wrapWithCache(adapter));
}

/**
 * Get a named adapter previously registered via `bindDatabase(adapter, name)`
 * (or the lower-level `setNamedAdapter(name, adapter)`).
 *
 * Throws a clear error if the name isn't registered — a model that declares
 * `static _db = "name"` resolves through here, so a missing name means the
 * connection was never bound. The message tells the developer exactly how to
 * fix it rather than silently falling back to the default connection (which
 * would hide the mistake and write to the wrong database).
 */
export function getNamedAdapter(name: string): DatabaseAdapter {
  const adapter = namedAdapters.get(name);
  if (adapter) return adapter;
  throw new Error(
    `No database adapter registered under the name "${name}". ` +
    `Call bindDatabase(adapter, "${name}") before using a model with ` +
    `static _db = "${name}" (build a secondary adapter with ` +
    `createAdapterFromUrl(url, user, pass) if you need one from a URL).`,
  );
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
 * Parsed result from a TINA4_DATABASE_URL connection string.
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
 * Parse a TINA4_DATABASE_URL connection string into its components.
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
  } else if (url.startsWith("sqlite:")) {
    // sqlite:/abs/app.db (one slash = a real absolute path) or sqlite:app.db (relative).
    // Keep the leading slash so resolveSqlitePath's isAbsolute() sees the absolute path —
    // this form used to fall through and throw "unsupported scheme" (the naive-abs footgun).
    const path = url.slice("sqlite:".length);
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
    // Normalize postgres:// and pgsql:// (the PDO/Laravel/Doctrine scheme
    // name, issue #58) to postgresql:// for URL parsing.
    const normalizedUrl = /^(postgres|pgsql):\/\//.test(url)
      ? url.replace(/^(postgres|pgsql):\/\//, "postgresql://")
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

  /**
   * Whether a standalone write auto-commits. ON by default — a write made
   * outside an explicit transaction commits on its own connection before
   * returning (so it's durable and visible across pooled connections). Inside
   * startTransaction()/commit()/rollback() the per-statement commit is
   * suppressed, so explicit transactions stay atomic. Set TINA4_AUTOCOMMIT=false
   * for strict manual-commit mode.
   */
  private autoCommit: boolean = ["true", "1", "yes"].includes(
    (process.env.TINA4_AUTOCOMMIT ?? "true").toLowerCase(),
  );
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
  private txStore: AsyncLocalStorage<{ adapter: DatabaseAdapter | null; depth?: number }> = new AsyncLocalStorage();

  /**
   * Create a Database wrapping an existing adapter.
   * For creating a Database from a URL, use the async static factories:
   *   Database.create(url) or Database.fromEnv()
   */
  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter;
  }

  /**
   * Set the engine type ("sqlite" | "postgres" | "mysql" | "mssql" |
   * "firebird" | "mongodb"). The static `Database.create` factory assigns the
   * private `dbType` directly; `initDatabase()` (a free function, no private
   * access) routes through this setter so a URL connection is correctly typed.
   * Without it a `postgres://` connection kept the `"sqlite"` default and
   * `getNextId()` took the SQLite branch — hitting the non-existent
   * `tina4_sequences` table on PostgreSQL instead of native sequences (#255).
   */
  setDbType(type: string): void {
    this.dbType = type;
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
      // Pooled mode — create all adapters eagerly, then wrap each with the
      // query cache backed by ONE shared store so a write on any pooled
      // connection invalidates reads cached by all of them.
      const sharedCache = new QueryCache({ maxSize: 10000 });
      const adapters: DatabaseAdapter[] = [];
      for (let i = 0; i < pool; i++) {
        const raw = await createAdapterFromUrl(url, username, password);
        adapters.push(wrapWithCache(raw, { sharedCache }));
      }

      // Set the first adapter as the global default (already cache-wrapped).
      activeAdapter = adapters[0];

      const db = new Database(adapters[0]);
      db._poolSize = pool;
      db.pool = adapters;
      db.poolIndex = 0;
      db.adapter = null;  // Don't use single-adapter path
      db.adapterFactory = async () => wrapWithCache(await createAdapterFromUrl(url, username, password), { sharedCache });
      db.dbType = parsed.type;
      return exposeDb(db);
    }

    // Single-connection mode — wrap once and share the SAME wrapped adapter
    // between getAdapter() (ORM reads) and the Database wrapper (db.fetch()),
    // so both hit one cache + one set of counters.
    const adapter = await createAdapterFromUrl(url, username, password);
    const wrapped = setAdapter(adapter);
    const db = new Database(wrapped);
    db.dbType = parsed.type;
    return exposeDb(db);
  }

  /**
   * Create a Database from an environment variable.
   * @param envKey - Name of the env var holding the connection URL. Defaults to "TINA4_DATABASE_URL".
   * @param pool - Number of pooled connections (0 = single, N>0 = round-robin)
   */
  static async fromEnv(envKey = "TINA4_DATABASE_URL", pool: number = 0): Promise<Database> {
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

  /** Query rows with optional pagination. Returns a DatabaseResult wrapper.
   *
   * Async since v3.14.0 (Option A): the public API awaits the adapter's
   * `*Async` method when present (PostgreSQL/MySQL/MSSQL/Firebird/Mongo) and
   * falls back to the synchronous method for SQLite (`node:sqlite` is sync, so
   * the fallback resolves instantly). This is the breaking change that makes
   * the wrapper work uniformly across every engine.
   */
  async fetch(sql: string, params?: unknown[], limit?: number, offset?: number, opts?: { noCache?: boolean }): Promise<DatabaseResult> {
    // v3.13.12: strip trailing `;` before the adapter wraps with COUNT(*)
    // or appends LIMIT/OFFSET. Without this, `"SELECT * FROM t;"` becomes
    // `"SELECT * FROM t; LIMIT 100 OFFSET 0"` — a syntax error.
    sql = stripTrailingSemicolons(sql);
    const adapter = this.getNextAdapter();
    try {
      // `opts.noCache` bypasses the query cache for this one call — no lookup,
      // no store, run directly (mirrors the Python master's `no_cache`).
      const rows = await adapterFetch(adapter, sql, params, limit, offset, opts?.noCache);
      this.lastError = null;
      return new DatabaseResult(rows, undefined, undefined, limit, offset, adapter, sql);
    } catch (e: any) {
      // v3.13.11 #49.2: fetch() records last_error like execute() does.
      this.lastError = e?.message ?? String(e);
      throw e;
    }
  }

  /**
   * Fetch a single row or null.
   *
   * Pass `{ noCache: true }` as the trailing options object to bypass the
   * query cache for this one call — no lookup, no store, run directly
   * (mirrors the Python master's `no_cache`). Default preserves caching.
   */
  async fetchOne<T = Record<string, unknown>>(sql: string, params?: unknown[], opts?: { noCache?: boolean }): Promise<T | null> {
    sql = stripTrailingSemicolons(sql);
    const adapter = this.getNextAdapter();
    try {
      // DB-contract A: route fetchOne through the SAME error-capturing path as
      // fetch()/execute(). Pre-3.13.37 it called the adapter directly, so a SQL
      // error raised (good) but db.getError() stayed null — the public API
      // couldn't read the cause. Now it FAILS LOUD *and* populates lastError.
      // The throw happens before the CachedDatabaseAdapter ever reaches its
      // cache.set(), so a buried failure can never be cached either.
      const row = (adapter as any).fetchOneAsync
        ? await (adapter as any).fetchOneAsync(sql, params, opts?.noCache)
        : adapter.fetchOne<T>(sql, params);
      this.lastError = null;
      return row;
    } catch (e: any) {
      this.lastError = e?.message ?? String(e);
      throw e;
    }
  }

  /**
   * Fetch rows and return the records array directly.
   *
   * Symmetric with `fetchOne`. For the common case where you just want
   * the rows and don't need the `DatabaseResult` metadata, this is one
   * less attribute access than `fetch(...).records`.
   *
   *     const rows = db.fetchAll("SELECT * FROM users WHERE active = ?", [true]);
   *     for (const row of rows) console.log(row.name);
   *
   * Returns `[]` (not `null`) when no rows match. Cross-framework parity
   * with Python `db.fetch_all()`, PHP `$db->fetchAll()`, and Ruby `db.fetch_all`.
   *
   * Pass `{ noCache: true }` as the trailing options object to bypass the
   * query cache for this one call — no lookup, no store, run directly
   * (mirrors the Python master's `no_cache`). The options object is a
   * SEPARATE trailing argument, never the params array.
   */
  async fetchAll<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, offset?: number, opts?: { noCache?: boolean }): Promise<T[]> {
    return (await this.fetch(sql, params, limit, offset, opts)).records as T[];
  }

  /**
   * Execute a write statement.
   *
   * On SUCCESS returns `true` for simple writes, or the result set when the
   * SQL contains RETURNING / CALL / EXEC / SELECT.
   *
   * On a SQL error (bad SQL, constraint violation, dead/aborted connection,
   * missing driver) it FAILS LOUD: it records the cause on `lastError`
   * (readable via `getError()`) and then RE-THROWS — it never swallows the
   * error and returns `false`. This mirrors `fetch()`/`fetchOne()`, which
   * already raise. Callers that need a boolean (e.g. ORM `save()`,
   * `createTable()`, the migration runner, dev-admin/MCP DB tools) must
   * `try/catch` and convert, rather than testing the return value.
   */
  async execute(sql: string, params?: unknown[]): Promise<boolean | unknown> {
    try {
      const adapter = this.getNextAdapter();
      const result = await adapterExecute(adapter, sql, params);
      if (this.autoCommit && !this.inExplicitTransaction()) {
        try { await adapterCommit(adapter); } catch { /* no active transaction */ }
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
      throw e;
    }
  }

  /** Insert one row (object) or a batch of rows (array of objects) into a table. */
  async insert(table: string, data: Record<string, unknown> | Record<string, unknown>[]): Promise<DatabaseWriteResult> {
    const adapter = this.getNextAdapter();
    const result = (adapter as any).insertAsync
      ? await (adapter as any).insertAsync(table, data)
      : adapter.insert(table, data);
    if (this.autoCommit && !this.inExplicitTransaction()) {
      try { await adapterCommit(adapter); } catch { /* no active transaction */ }
    }
    return result;
  }

  /** Update rows in a table matching filter. */
  async update(table: string, data: Record<string, unknown>, filter?: Record<string, unknown>, params?: unknown[]): Promise<DatabaseWriteResult> {
    const adapter = this.getNextAdapter();
    const result = (adapter as any).updateAsync
      ? await (adapter as any).updateAsync(table, data, filter ?? {}, params)
      : adapter.update(table, data, filter ?? {}, params);
    if (this.autoCommit && !this.inExplicitTransaction()) {
      try { await adapterCommit(adapter); } catch { /* no active transaction */ }
    }
    return result;
  }

  /** Delete rows from a table matching filter. */
  async delete(table: string, filter?: Record<string, unknown>, params?: unknown[]): Promise<DatabaseWriteResult> {
    const adapter = this.getNextAdapter();
    const result = (adapter as any).deleteAsync
      ? await (adapter as any).deleteAsync(table, filter ?? {}, params)
      : adapter.delete(table, filter ?? {}, params);
    if (this.autoCommit && !this.inExplicitTransaction()) {
      try { await adapterCommit(adapter); } catch { /* no active transaction */ }
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
   * True while an explicit transaction is active on the current async context.
   * startTransaction() pins an adapter into txStore; commit()/rollback() clear
   * it. Standalone writes only auto-commit when this is false, so per-statement
   * commits never break the atomicity of an explicit transaction.
   */
  private inExplicitTransaction(): boolean {
    return !!this.txStore.getStore()?.adapter;
  }

  /**
   * Start a transaction. Pins the adapter to the current async context for
   * the whole transaction so executes and the final commit/rollback all run
   * on the same connection (critical when pool > 0).
   *
   * Nested-begin guard (DB-contract C): a second startTransaction() on a
   * context that already has a pinned adapter is a double-begin — the inner
   * BEGIN silently commits or no-ops on most engines, leaving the connection
   * mid-transaction with the caller none the wiser. We keep a depth counter and
   * log a clear warning instead of silently re-beginning; the pin stays on the
   * original adapter so the eventual commit/rollback still land on the right
   * connection, and the matching inner commit just unwinds the depth.
   */
  async startTransaction(): Promise<void> {
    const store = this.txStore.getStore();
    if (store?.adapter) {
      const depth = store.depth ?? 1;
      console.warn(
        "[tina4] startTransaction() called while a transaction is already open " +
        `on this context (depth would become ${depth + 1}). Nested transactions ` +
        "are not supported — the existing transaction stays open on its pinned " +
        "connection and this nested begin is ignored. Commit or rollback the " +
        "outer transaction first.",
      );
      store.depth = depth + 1;
      return;
    }
    // Pick an adapter using the normal selection logic, then pin it.
    const adapter = this.getNextAdapter();
    if (store) {
      store.adapter = adapter;
      store.depth = 1;
    } else {
      this.txStore.enterWith({ adapter, depth: 1 });
    }
    await adapterStartTransaction(adapter);
  }

  /**
   * Commit the current transaction.
   *
   * FAIL LOUD (DB-contract C): if the underlying commit raises, capture
   * lastError and RE-THROW — never swallow. On failure the transaction pin is
   * RETAINED so the caller's follow-up rollback() lands on the SAME connection
   * (clearing it would leak a dirty connection back into the pool and route the
   * rollback to a different one). The pin is cleared ONLY on a successful
   * commit. An inner commit of an ignored nested begin (depth > 1) just unwinds
   * the depth — the outer commit is the real one.
   */
  async commit(): Promise<void> {
    const store = this.txStore.getStore();
    const depth = store?.depth ?? 0;
    if (depth > 1) {
      // Inner commit of an ignored nested begin — just unwind the depth.
      if (store) store.depth = depth - 1;
      return;
    }
    const adapter = this.getNextAdapter();
    try {
      await adapterCommit(adapter);
      this.lastError = null;
    } catch (e: any) {
      // Keep the pin so rollback() reaches this same connection.
      this.lastError = e?.message ?? String(e);
      throw e;
    }
    // Success — release the pin.
    if (store) { store.adapter = null; store.depth = 0; }
  }

  /**
   * Rollback the current transaction — the terminal cleanup of a transaction,
   * so it ALWAYS clears the pin (and the depth counter), even after a failed
   * commit (it routes to the retained pinned connection and cleans it up). If
   * the underlying rollback itself raises, lastError is captured and the error
   * re-thrown, but the pin is still released so a poisoned connection doesn't
   * stay pinned to this context forever.
   */
  async rollback(): Promise<void> {
    const adapter = this.getNextAdapter();
    const store = this.txStore.getStore();
    try {
      await adapterRollback(adapter);
      this.lastError = null;
    } catch (e: any) {
      this.lastError = e?.message ?? String(e);
      throw e;
    } finally {
      // Terminal cleanup — always release the pin.
      if (store) { store.adapter = null; store.depth = 0; }
    }
  }

  /** Check if a table exists. */
  async tableExists(name: string): Promise<boolean> {
    return adapterTableExists(this.getNextAdapter(), name);
  }

  /** List all tables in the database. */
  async getTables(): Promise<string[]> {
    return adapterTables(this.getNextAdapter());
  }

  /**
   * Get column metadata for a table.
   * Uses the adapter's columns() method which handles engine-specific introspection
   * (PRAGMA table_info for SQLite, information_schema.columns for others).
   *
   * @param tableName - Name of the table to inspect.
   * @returns Array of column info objects: { name, type, nullable, default, primaryKey }.
   */
  async getColumns(tableName: string): Promise<{ name: string; type: string; nullable?: boolean; default?: unknown; primaryKey?: boolean }[]> {
    return adapterColumns(this.getNextAdapter(), tableName);
  }

  /**
   * Execute a SQL statement with multiple parameter sets (batch insert/update).
   * Wraps all executions in a single transaction for atomicity and performance.
   *
   * @param sql - The SQL statement with parameter placeholders.
   * @param paramSets - Array of parameter arrays, one per execution.
   * @returns Array of results from each execution.
   */
  async executeMany(sql: string, paramSets: unknown[][] = []): Promise<unknown[]> {
    const adapter = this.getNextAdapter();
    const results: unknown[] = [];

    await adapterStartTransaction(adapter);
    try {
      for (const params of paramSets) {
        results.push(await adapterExecute(adapter, sql, params));
      }
      await adapterCommit(adapter);
    } catch (e) {
      await adapterRollback(adapter);
      throw e;
    }

    return results;
  }

  /** Return the last execute() error message, or null. */
  getError(): string | null {
    return this.lastError ?? null;
  }

  /**
   * Return query cache statistics from the REAL cache backing this connection.
   *
   * The bound adapter is a CachedDatabaseAdapter (caching is OFF by default —
   * both layers opt-in: request-scoped via TINA4_AUTO_CACHING=true, persistent
   * via TINA4_DB_CACHE=true), so we read the live counters + size + mode from it.
   * Mirrors Python's `Database.cache_stats()`: `{ enabled, mode, hits, misses, size, ttl }`.
   */
  cacheStats(): { enabled: boolean; mode: "persistent" | "request" | "off"; hits: number; misses: number; size: number; ttl: number; backend?: string } {
    const adapter = this.getNextAdapter();
    if (adapter instanceof CachedDatabaseAdapter) {
      return adapter.cacheStats();
    }
    // Adapter isn't cache-wrapped (shouldn't happen via initDatabase/create) —
    // report a disabled cache truthfully rather than lying about size.
    return { enabled: false, mode: "off", hits: 0, misses: 0, size: 0, ttl: 0 };
  }

  /** Flush the query cache and reset counters (mirrors Python `cache_clear()`). */
  cacheClear(): void {
    const adapter = this.getNextAdapter();
    if (adapter instanceof CachedDatabaseAdapter) {
      adapter.cacheClear();
    }
  }

  /**
   * Clear the request-scoped cache at the START of an HTTP request on this
   * connection (no-op in persistent mode). Mirrors Python's
   * `Database.cache_new_request()`.
   */
  cacheNewRequest(): void {
    const adapter = this.getNextAdapter();
    if (adapter instanceof CachedDatabaseAdapter) {
      adapter.cacheNewRequest();
    }
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
  private async ensureSequenceTable(): Promise<void> {
    const adapter = this.getNextAdapter();

    if (!(await adapterTableExists(adapter, "tina4_sequences"))) {
      if (this.dbType === "mssql") {
        await adapterExecute(adapter,
          "CREATE TABLE tina4_sequences (" +
          "seq_name VARCHAR(200) NOT NULL PRIMARY KEY, " +
          "current_value INTEGER NOT NULL DEFAULT 0)"
        );
      } else {
        await adapterExecute(adapter,
          "CREATE TABLE IF NOT EXISTS tina4_sequences (" +
          "seq_name VARCHAR(200) NOT NULL PRIMARY KEY, " +
          "current_value INTEGER NOT NULL DEFAULT 0)"
        );
      }
      try { await adapterCommit(adapter); } catch { /* no active transaction */ }
    }
  }

  /**
   * Best-effort MAX(pk) seed for a new sequence row. 0 if the table is
   * missing/empty. Mirrors Python's `_sequence_seed_value`.
   */
  private async sequenceSeedValue(adapter: DatabaseAdapter, table: string | undefined, pkColumn: string): Promise<number> {
    if (!table) return 0;
    try {
      const maxRow = await adapterFetchOne<Record<string, unknown>>(adapter,
        `SELECT MAX(${pkColumn}) AS max_id FROM ${table}`,
      );
      if (maxRow?.max_id != null) return Number(maxRow.max_id);
    } catch {
      // Table doesn't exist — start at 0.
    }
    return 0;
  }

  /**
   * Atomically increment and return the next value from the sequence table.
   *
   * DB-contract B (no duplicate primary keys under concurrency): the old path
   * was read-increment-read across several `await` points, so two concurrent
   * async callers could read the same `current_value` and return the same id.
   * This now uses a single atomic increment-and-return per engine, pinned to
   * ONE adapter so the two statements (where two are needed) land on the same
   * connection:
   *
   *   * SQLite:  the SQLiteAdapter does ensure-table + seed + the atomic
   *     `UPDATE ... RETURNING current_value` (>= 3.35; else `+1` then `SELECT`)
   *     as ONE synchronous burst — no `await` between read and write, so no
   *     other async task can interleave (Node analog of Python's _write_lock).
   *   * MySQL:  `UPDATE ... SET current_value = LAST_INSERT_ID(current_value + 1)`
   *     then `SELECT LAST_INSERT_ID()` on the SAME pinned connection
   *     (LAST_INSERT_ID is per-connection → race-safe).
   *   * MSSQL:  `UPDATE ... SET current_value = current_value + 1 OUTPUT
   *     inserted.current_value ...` — one atomic statement.
   *
   * Seeding is always a race-safe insert-if-absent (INSERT OR IGNORE /
   * INSERT IGNORE / INSERT ... WHERE NOT EXISTS) seeded from MAX(pk), run
   * BEFORE the increment — never a read-then-insert gap. On error we RAISE
   * (never silently fall back to 1).
   */
  private async sequenceNext(seqName: string, table?: string, pkColumn = "id"): Promise<number> {
    // Pin a single adapter for the whole sequence operation so seed +
    // increment + read all hit the SAME connection. Inside an active
    // transaction the adapter is already pinned; otherwise pin here and
    // release in the finally so the pool can rotate afterwards.
    const store = this.txStore.getStore();
    const alreadyPinned = !!store?.adapter;
    const adapter = this.getNextAdapter();
    if (!alreadyPinned) {
      if (store) store.adapter = adapter;
      else this.txStore.enterWith({ adapter });
    }

    try {
      if (this.dbType === "sqlite") {
        // SQLite: the adapter does ensure-table + seed + atomic increment as one
        // synchronous burst. We compute the seed first (its own read can yield,
        // but that's fine — INSERT OR IGNORE makes the seed idempotent and the
        // increment itself is the atomic step).
        const seed = await this.sequenceSeedValue(adapter, table, pkColumn);
        const raw = (adapter as any).getAdapter ? (adapter as any).getAdapter() : adapter;
        if (typeof raw.sequenceNextSqlite === "function") {
          return raw.sequenceNextSqlite(seqName, seed);
        }
        // Defensive fallback if the underlying adapter lacks the atomic helper.
        return this.sequenceNextGeneric(adapter, seqName, seed);
      }

      await this.ensureSequenceTable();
      if (this.dbType === "mysql") {
        return this.sequenceNextMysql(adapter, seqName, table, pkColumn);
      }
      if (this.dbType === "mssql") {
        return this.sequenceNextMssql(adapter, seqName, table, pkColumn);
      }
      // Any other engine routed here (defensive) — generic atomic-ish path.
      const seed = await this.sequenceSeedValue(adapter, table, pkColumn);
      return this.sequenceNextGeneric(adapter, seqName, seed);
    } finally {
      if (!alreadyPinned) {
        const s = this.txStore.getStore();
        if (s) s.adapter = null;
      }
    }
  }

  /**
   * MySQL atomic sequence step. LAST_INSERT_ID(expr) stashes `expr` in this
   * CONNECTION's session var and returns it, so the read-back is per-connection
   * and race-safe. Runs on the pinned adapter.
   */
  private async sequenceNextMysql(adapter: DatabaseAdapter, seqName: string, table: string | undefined, pkColumn: string): Promise<number> {
    const seed = await this.sequenceSeedValue(adapter, table, pkColumn);
    // Race-safe seed: INSERT IGNORE is a no-op if the row exists.
    await adapterExecute(adapter,
      "INSERT IGNORE INTO tina4_sequences (seq_name, current_value) VALUES (?, ?)",
      [seqName, seed],
    );
    try { await adapterCommit(adapter); } catch { /* no active transaction */ }
    await adapterExecute(adapter,
      "UPDATE tina4_sequences SET current_value = LAST_INSERT_ID(current_value + 1) WHERE seq_name = ?",
      [seqName],
    );
    try { await adapterCommit(adapter); } catch { /* no active transaction */ }
    const row = await adapterFetchOne<Record<string, unknown>>(adapter, "SELECT LAST_INSERT_ID() AS next_id");
    if (!row) {
      throw new Error(`getNextId: LAST_INSERT_ID() returned nothing for '${seqName}'`);
    }
    return Number(Object.values(row)[0]);
  }

  /**
   * MSSQL atomic sequence step. A single `UPDATE ... OUTPUT
   * inserted.current_value` increments and returns the new value in one
   * statement. Runs on the pinned adapter.
   */
  private async sequenceNextMssql(adapter: DatabaseAdapter, seqName: string, table: string | undefined, pkColumn: string): Promise<number> {
    const seed = await this.sequenceSeedValue(adapter, table, pkColumn);
    // Race-safe seed: INSERT only when absent (single statement).
    await adapterExecute(adapter,
      "INSERT INTO tina4_sequences (seq_name, current_value) " +
      "SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM tina4_sequences WHERE seq_name = ?)",
      [seqName, seed, seqName],
    );
    try { await adapterCommit(adapter); } catch { /* no active transaction */ }
    // Single atomic statement: increment + return the new value via OUTPUT.
    const result = await adapterExecute(adapter,
      "UPDATE tina4_sequences SET current_value = current_value + 1 " +
      "OUTPUT inserted.current_value AS next_id WHERE seq_name = ?",
      [seqName],
    ) as any;
    const rows = result?.rows ?? result?.records ?? null;
    if (rows && rows.length > 0 && rows[0].next_id != null) {
      return Number(rows[0].next_id);
    }
    throw new Error(`getNextId: OUTPUT produced no row for sequence '${seqName}'`);
  }

  /**
   * Defensive generic atomic-ish path for any engine not otherwise special-cased
   * (and the SQLite fallback if the adapter lacks the synchronous helper). Seeds
   * if absent, then increments and reads on the pinned connection.
   */
  private async sequenceNextGeneric(adapter: DatabaseAdapter, seqName: string, seed: number): Promise<number> {
    try {
      await adapterExecute(adapter,
        "INSERT INTO tina4_sequences (seq_name, current_value) VALUES (?, ?)",
        [seqName, seed],
      );
      try { await adapterCommit(adapter); } catch { /* no active transaction */ }
    } catch {
      // Row likely already exists (PK conflict) — fine, keep going.
      try { await adapterRollback(adapter); } catch { /* nothing to roll back */ }
    }
    await adapterExecute(adapter,
      "UPDATE tina4_sequences SET current_value = current_value + 1 WHERE seq_name = ?",
      [seqName],
    );
    try { await adapterCommit(adapter); } catch { /* no active transaction */ }
    const row = await adapterFetchOne<Record<string, unknown>>(adapter,
      "SELECT current_value FROM tina4_sequences WHERE seq_name = ?",
      [seqName],
    );
    if (!row || row.current_value == null) {
      throw new Error(`getNextId: sequence row '${seqName}' missing`);
    }
    return Number(row.current_value);
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
  async getNextId(table: string, pkColumn = "id", generatorName?: string): Promise<number> {
    const adapter = this.getNextAdapter();

    // MongoDB uses ObjectId for _id by default; integer sequences fall through
    // to the tina4_sequences table strategy below (which works on Mongo too
    // because the adapter implements the SQL-ish methods over collections).

    // Firebird — use generators (atomic)
    if (this.dbType === "firebird") {
      const genName = generatorName ?? `GEN_${table.toUpperCase()}_ID`;

      // Auto-create the generator if it does not exist
      try {
        await adapterExecute(adapter, `CREATE GENERATOR ${genName}`);
      } catch {
        // Generator already exists — ignore
      }

      const row = await adapterFetchOne<Record<string, unknown>>(adapter, `SELECT GEN_ID(${genName}, 1) AS NEXT_ID FROM RDB$DATABASE`);
      return Number(row?.NEXT_ID ?? row?.next_id ?? 1);
    }

    // PostgreSQL — try sequence first, auto-create if missing, fall through to sequence table
    if (this.dbType === "postgres") {
      const seqName = generatorName ?? `${table.toLowerCase()}_${pkColumn.toLowerCase()}_seq`;
      try {
        const row = await adapterFetchOne<Record<string, unknown>>(adapter, `SELECT nextval('${seqName}') AS next_id`);
        if (row?.next_id != null) {
          return Number(row.next_id);
        }
      } catch {
        // Sequence doesn't exist — try to auto-create it
      }

      // Auto-create sequence seeded from MAX
      try {
        const maxRow = await adapterFetchOne<Record<string, unknown>>(adapter,
          `SELECT COALESCE(MAX(${pkColumn}), 0) AS max_id FROM ${table}`
        );
        const start = maxRow?.max_id != null ? Number(maxRow.max_id) + 1 : 1;
        await adapterExecute(adapter, `CREATE SEQUENCE ${seqName} START WITH ${start}`);
        try { await adapterCommit(adapter); } catch { /* no active transaction */ }
        const row = await adapterFetchOne<Record<string, unknown>>(adapter, `SELECT nextval('${seqName}') AS next_id`);
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
 * Build a connected `DatabaseAdapter` from a connection URL.
 *
 * Used internally by `initDatabase()` and `Database.create()`, and exported so
 * users can construct a NAMED secondary adapter without making it the default:
 *
 *     bindDatabase(await createAdapterFromUrl(url, user, pass), "analytics");
 *
 * Unlike `initDatabase()`, this does NOT call `setAdapter()` — it returns a
 * standalone adapter that the caller decides what to do with. For async engines
 * (Postgres/MySQL/MSSQL/Firebird/Mongo) the returned adapter is already
 * connected; SQLite connects lazily.
 */
export async function createAdapterFromUrl(url: string, username?: string, password?: string): Promise<DatabaseAdapter> {
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

/**
 * Open a database connection — convention name matching SQLAlchemy
 * `engine.connect()` and the cross-framework Database.get_connection()
 * surface shipped in 3.13.x.
 *
 * Equivalent to `initDatabase({ url })` but with an opinionated, simpler
 * signature: pass a URL string directly, or omit for env-based defaults
 * (falls back to in-memory SQLite when nothing resolves).
 *
 *     const db = await Database.getConnection();                        // from env
 *     const db = await Database.getConnection("sqlite://./app.db");     // explicit URL
 *     const db = await Database.getConnection("postgres://localhost/x", { username: "u", password: "p" });
 *
 * Cross-framework parity with Python `Database.get_connection()`, PHP
 * `\Tina4\Database::getConnection()`, and Ruby `Tina4::Database.get_connection`.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Database {
  export async function getConnection(
    url?: string,
    opts: { username?: string; password?: string } = {}
  ): Promise<Database> {
    const resolvedUrl = url ?? process.env.TINA4_DATABASE_URL ?? "sqlite::memory:";
    return initDatabase({
      url: resolvedUrl,
      username: opts.username,
      password: opts.password,
    });
  }

  /**
   * Clear the request-scoped query cache on every live connection.
   *
   * Static convenience mirroring Python's `Database.reset_request_caches()`
   * classmethod. The request dispatcher calls this at the start of each HTTP
   * request so request-scoped caching never serves rows across requests.
   * Persistent-mode connections (TINA4_DB_CACHE=true) are left alone.
   */
  export function resetRequestCaches(): void {
    CachedDatabaseAdapter.resetRequestCaches();
  }
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
      // Database.create already sets dbType + exposes the global; exposeDb here
      // is idempotent.
      return exposeDb(await Database.create(url, resolvedUser, resolvedPassword, pool));
    }
    // Single-connection URL path. Parse the URL so the engine type is known and
    // set it on the Database — otherwise dbType keeps its "sqlite" default and a
    // postgres://… connection takes the SQLite getNextId branch, crashing on the
    // missing tina4_sequences table instead of using native sequences (#255).
    const parsed = parseDatabaseUrl(url, resolvedUser, resolvedPassword);
    const adapter = await createAdapterFromUrl(url, resolvedUser, resolvedPassword);
    const db = new Database(setAdapter(adapter));
    db.setDbType(parsed.type);
    return exposeDb(db);
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

  // Legacy config-object path. As with the URL path above, the constructed
  // Database must be told its engine type — otherwise dbType keeps its "sqlite"
  // default and a `{ type: "postgres" }` connection takes the SQLite getNextId
  // branch and crashes on the missing tina4_sequences table (#255).
  const finished = (adapter: DatabaseAdapter): Database => {
    const db = new Database(setAdapter(adapter));
    db.setDbType(type);
    return exposeDb(db);
  };

  switch (type) {
    case "sqlite": {
      const { SQLiteAdapter } = await import("./adapters/sqlite.js");
      const adapter = new SQLiteAdapter(config?.path ?? "./data/tina4.db");
      return finished(adapter);
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
      return finished(adapter);
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
      return finished(adapter);
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
      return finished(adapter);
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
      return finished(adapter);
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
      return finished(adapter);
    }
    case "odbc": {
      const { OdbcAdapter } = await import("./adapters/odbc.js");
      const connStr = config?.connectionString ?? config?.url?.replace(/^odbc:\/\/\//, "") ?? "";
      const adapter = new OdbcAdapter({ connectionString: connStr });
      await adapter.connect();
      return finished(adapter);
    }
    default:
      throw new Error(`Unknown database type: ${type}`);
  }
}
