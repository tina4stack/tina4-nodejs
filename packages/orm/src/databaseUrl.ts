/**
 * A parsed database connection URL, as a VALUE.
 *
 * Feature 5 of the feature audit. This used to be `parseDatabaseUrl()`, a single
 * function with a cyclomatic complexity of 43 - the worst function measured
 * anywhere in the audit - whose entire job is string-to-struct. It is now one
 * small parser per engine, each well under the threshold, behind a value type
 * with the same surface as PHP's `DatabaseUrl` (the reference for this row).
 *
 * Core Principle 6 says a connection string must mean literally the same thing
 * in every framework. `test/fixtures/database_url_corpus.json` is the answer
 * key, byte-identical in all four.
 */

/** The canonical engine names. Aliases resolve to these ONCE, at parse. */
export type DatabaseEngine =
  | "sqlite"
  | "postgres"
  | "mysql"
  | "mssql"
  | "firebird"
  | "mongodb"
  | "odbc";

/**
 * URL scheme to canonical engine.
 *
 * `sqlite3` is accepted because the driver is literally named sqlite3 in every
 * framework (Python's sqlite3 module, Ruby's sqlite3 gem, PHP's ext-sqlite3,
 * Node's node:sqlite), so people type it. The "3" is a file-format version, not
 * a different engine, which is why the canonical name stays `sqlite`.
 */
const ENGINE_ALIASES: Record<string, DatabaseEngine> = {
  sqlite: "sqlite",
  sqlite3: "sqlite",
  postgres: "postgres",
  postgresql: "postgres",
  pgsql: "postgres",
  mysql: "mysql",
  mssql: "mssql",
  sqlserver: "mssql",
  firebird: "firebird",
  mongodb: "mongodb",
  "mongodb+srv": "mongodb",
  odbc: "odbc",
};

/**
 * Default port per engine, applied AT PARSE.
 *
 * The port is part of our contract, not the driver's business. Node used to
 * leave it unset and let the third-party driver fill in its own default, so the
 * parsed struct for `postgresql://localhost/db` differed from PHP's while the
 * connection still worked - a divergence hidden behind somebody else's
 * assumption.
 */
const DEFAULT_PORTS: Partial<Record<DatabaseEngine, number>> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
  firebird: 3050,
  mongodb: 27017,
};

/** Strip EXACTLY ONE leading slash: the URL path separator, never more. */
function stripOneSlash(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

function decode(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  return decodeURIComponent(value);
}

export class DatabaseUrl {
  readonly engine: DatabaseEngine;
  /** Null for sqlite and odbc - a file or a DSN string has no host. */
  readonly host: string | null;
  /** Null for sqlite and odbc. Otherwise always set: the engine default applies. */
  readonly port: number | null;
  readonly database: string;
  /** Null when absent, never an empty string - absent and blank differ. */
  readonly username: string | null;
  readonly password: string | null;
  /** ODBC only: the raw connection string handed to odbc.connect(). */
  readonly connectionString: string | null;

  constructor(url: string, username?: string, password?: string) {
    const parsed = DatabaseUrl.parse(url);
    this.engine = parsed.engine;
    this.host = parsed.host ?? null;
    this.port = parsed.port ?? DEFAULT_PORTS[parsed.engine] ?? null;
    this.database = parsed.database ?? "";
    this.connectionString = parsed.connectionString ?? null;
    // Separate credentials fill in only when the URL carried none.
    this.username = parsed.username ?? (username ? username : null);
    this.password = parsed.password ?? (password ? password : null);
  }

  static fromEnv(key = "TINA4_DATABASE_URL"): DatabaseUrl | null {
    const url = (process.env[key] ?? "").trim();
    if (url === "") return null;
    return new DatabaseUrl(
      url,
      process.env.TINA4_DATABASE_USERNAME,
      process.env.TINA4_DATABASE_PASSWORD
    );
  }

  /** Connection target for the adapter. sqlite and odbc are the whole value. */
  dsn(): string {
    if (this.engine === "sqlite") return this.database;
    if (this.engine === "odbc") return this.connectionString ?? "";
    let dsn = this.host ?? "";
    if (this.port !== null) dsn += `:${this.port}`;
    if (this.database !== "") dsn += `/${this.database}`;
    return dsn;
  }

  /**
   * The URL with the password replaced by ***.
   *
   * The ONLY form allowed in a log line or an error message: a connection URL in
   * a log is a credential leak. Node had no such method at all before this,
   * which meant every call site that wanted to log a connection target had to
   * redact it by hand. It round-trips, so it stays readable as well as safe.
   */
  toSafeString(): string {
    if (this.engine === "sqlite") return `sqlite:///${this.database}`;
    if (this.engine === "odbc") return `odbc:///${this.connectionString ?? ""}`;

    let out = `${this.engine}://`;
    if (this.username !== null) {
      out += this.username;
      if (this.password !== null) out += ":***";
      out += "@";
    }
    out += this.host ?? "";
    if (this.port !== null) out += `:${this.port}`;
    if (this.database !== "") out += `/${this.database}`;
    return out;
  }

  // ── parsing ────────────────────────────────────────────────
  // One small parser per engine. The 43-CC original is gone.

  private static parse(url: string): ParsedParts {
    if (typeof url !== "string" || url.trim() === "") {
      throw new Error("DatabaseUrl: the URL is empty");
    }
    if (url.startsWith("sqlite:") || url.startsWith("sqlite3:")) {
      return DatabaseUrl.parseSqlite(url);
    }
    if (url.startsWith("odbc:///")) {
      return { engine: "odbc", connectionString: url.slice("odbc:///".length) };
    }
    if (url.startsWith("mssql://") || url.startsWith("sqlserver://")) {
      return DatabaseUrl.parseRegexForm(url, "mssql", /(?:mssql|sqlserver):\/\/(?:([^:]+):([^@]+)@)?([^:/]+)(?::(\d+))?\/(.*)/);
    }
    if (url.startsWith("firebird://")) {
      return DatabaseUrl.parseRegexForm(url, "firebird", /firebird:\/\/(?:([^:]+):([^@]+)@)?([^:/]+)(?::(\d+))?\/(.*)/);
    }
    return DatabaseUrl.parseStandard(url);
  }

  /**
   * sqlite is parsed on the RAW string. The URL class collapses `sqlite:/x` and
   * `sqlite:///x`, losing the difference between a one-slash ABSOLUTE path and
   * the documented three-slash RELATIVE form.
   *
   *   sqlite:///app.db        -> app.db        (three slashes = relative to cwd)
   *   sqlite:////abs/app.db   -> /abs/app.db   (four slashes = absolute)
   *   sqlite:/abs/app.db      -> /abs/app.db   (one slash = a real absolute path)
   *   sqlite:app.db           -> app.db
   */
  private static parseSqlite(url: string): ParsedParts {
    const normalised = url.startsWith("sqlite3:") ? `sqlite:${url.slice("sqlite3:".length)}` : url;
    if (normalised === "sqlite::memory:" || normalised === "sqlite:///:memory:") {
      return { engine: "sqlite", database: ":memory:" };
    }
    if (normalised.startsWith("sqlite:///")) {
      return { engine: "sqlite", database: stripOneSlash(normalised.slice("sqlite://".length)) };
    }
    if (normalised.startsWith("sqlite://")) {
      return { engine: "sqlite", database: normalised.slice("sqlite://".length) };
    }
    return { engine: "sqlite", database: normalised.slice("sqlite:".length) };
  }

  /**
   * mssql and firebird: the URL class does not know these schemes, so they are
   * matched directly.
   *
   * The captured path keeps its own leading slash when the URL had two, which is
   * how the documented absolute Firebird form survives. The old code did
   * `"/" + match[5]`, ADDING a slash - so an absolute path came back with two
   * and a relative path was silently made absolute. Verified against live
   * Firebird 5.0.4: the driver takes one or two leading slashes and rejects a
   * relative path outright.
   */
  private static parseRegexForm(url: string, engine: DatabaseEngine, pattern: RegExp): ParsedParts {
    const m = url.match(pattern);
    if (!m) throw new Error(`DatabaseUrl: invalid ${engine} URL '${url}'`);
    return {
      engine,
      username: decode(m[1]),
      password: decode(m[2]),
      host: m[3],
      port: m[4] ? parseInt(m[4], 10) : undefined,
      database: m[5],
    };
  }

  /** postgres / mysql / mongodb, via the URL class. */
  private static parseStandard(url: string): ParsedParts {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`DatabaseUrl: invalid URL format '${url}'`);
    }
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    const engine = ENGINE_ALIASES[scheme];
    if (engine === undefined) {
      throw new Error(
        `DatabaseUrl: Unsupported database scheme '${scheme}'. Supported: ${Object.keys(ENGINE_ALIASES).join(", ")}`
      );
    }
    const database = stripOneSlash(parsed.pathname);
    return {
      engine,
      host: parsed.hostname || undefined,
      port: parsed.port ? parseInt(parsed.port, 10) : undefined,
      username: decode(parsed.username),
      password: decode(parsed.password),
      database: engine === "mongodb" ? database || "tina4" : database,
    };
  }
}

interface ParsedParts {
  engine: DatabaseEngine;
  host?: string;
  port?: number;
  database?: string;
  username?: string | null;
  password?: string | null;
  connectionString?: string;
}
