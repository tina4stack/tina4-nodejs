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
  type?: "sqlite" | "postgres" | "mysql";
  path?: string;
  url?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

/**
 * Parsed result from a DATABASE_URL connection string.
 */
export interface ParsedDatabaseUrl {
  type: "sqlite" | "postgres" | "mysql";
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
 * @returns Parsed database configuration.
 * @throws Error if the URL scheme is not supported.
 */
export function parseDatabaseUrl(url: string): ParsedDatabaseUrl {
  // Handle sqlite:// separately because URL class mangles the path
  if (url.startsWith("sqlite:///")) {
    // sqlite:///absolute/path — three slashes means absolute
    const path = url.slice("sqlite://".length);
    return { type: "sqlite", path };
  }

  if (url.startsWith("sqlite://")) {
    // sqlite://./relative or sqlite://relative
    const path = url.slice("sqlite://".length);
    return { type: "sqlite", path };
  }

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
  let type: "sqlite" | "postgres" | "mysql";

  switch (scheme) {
    case "postgresql":
      type = "postgres";
      break;
    case "mysql":
      type = "mysql";
      break;
    default:
      throw new Error(`Unsupported database URL scheme: "${scheme}". Supported: sqlite, postgres/postgresql, mysql.`);
  }

  const database = parsed.pathname.startsWith("/")
    ? parsed.pathname.slice(1)
    : parsed.pathname;

  return {
    type,
    host: parsed.hostname || undefined,
    port: parsed.port ? parseInt(parsed.port, 10) : undefined,
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database: database || undefined,
  };
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
  // Resolve from URL if provided
  const url = config?.url ?? process.env.DATABASE_URL;

  if (url) {
    const parsed = parseDatabaseUrl(url);

    switch (parsed.type) {
      case "sqlite": {
        const { SQLiteAdapter } = await import("./adapters/sqlite.js");
        const adapter = new SQLiteAdapter(parsed.path ?? "./data/tina4.db");
        setAdapter(adapter);
        return adapter;
      }
      case "postgres":
        throw new Error("PostgreSQL adapter not yet implemented. Coming soon.");
      case "mysql":
        throw new Error("MySQL adapter not yet implemented. Coming soon.");
    }
  }

  // Legacy config path
  const type = config?.type ?? "sqlite";

  switch (type) {
    case "sqlite": {
      const { SQLiteAdapter } = await import("./adapters/sqlite.js");
      const adapter = new SQLiteAdapter(config?.path ?? "./data/tina4.db");
      setAdapter(adapter);
      return adapter;
    }
    case "postgres":
      throw new Error("PostgreSQL adapter not yet implemented. Coming soon.");
    case "mysql":
      throw new Error("MySQL adapter not yet implemented. Coming soon.");
    default:
      throw new Error(`Unknown database type: ${type}`);
  }
}
