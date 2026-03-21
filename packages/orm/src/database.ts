import type { DatabaseAdapter } from "./types.js";

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
 * Initialize the database from a config object or DATABASE_URL env var.
 *
 * Priority:
 *   1. config.url (explicit URL)
 *   2. process.env.DATABASE_URL
 *   3. config.type + config.path (legacy)
 */
export async function initDatabase(config?: DatabaseConfig): Promise<DatabaseAdapter> {
  // Resolve credentials: config.user > config.username > env DATABASE_USERNAME
  const resolvedUser = config?.user ?? config?.username ?? process.env.DATABASE_USERNAME;
  const resolvedPassword = config?.password ?? process.env.DATABASE_PASSWORD;

  // Resolve from URL if provided
  const url = config?.url ?? process.env.DATABASE_URL;

  if (url) {
    const parsed = parseDatabaseUrl(url, resolvedUser, resolvedPassword);

    switch (parsed.type) {
      case "sqlite": {
        const { SQLiteAdapter } = await import("./adapters/sqlite.js");
        const adapter = new SQLiteAdapter(parsed.path ?? "./data/tina4.db");
        setAdapter(adapter);
        return adapter;
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
        setAdapter(adapter);
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
        setAdapter(adapter);
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
        setAdapter(adapter);
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
        setAdapter(adapter);
        return adapter;
      }
    }
  }

  // Legacy config path — normalize "sqlserver" to "mssql"
  const rawType = config?.type ?? "sqlite";
  const type = rawType === "sqlserver" ? "mssql" : rawType;

  switch (type) {
    case "sqlite": {
      const { SQLiteAdapter } = await import("./adapters/sqlite.js");
      const adapter = new SQLiteAdapter(config?.path ?? "./data/tina4.db");
      setAdapter(adapter);
      return adapter;
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
      return adapter;
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
      return adapter;
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
      return adapter;
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
      return adapter;
    }
    default:
      throw new Error(`Unknown database type: ${type}`);
  }
}
