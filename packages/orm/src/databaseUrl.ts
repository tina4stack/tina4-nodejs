/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

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
import { inspect } from "node:util";
import { REDACTED, redactCredentials } from "../../core/src/urlRedaction.js";
import { ConnectionUrlError, splitConnectionUrl, type ConnectionUrlParts } from "../../core/src/connectionUrl.js";

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

// ── redaction ──────────────────────────────────────────────────────────────
// ONE primitive, used by every path that can put a connection string in front
// of a human. It lives in core's dependency-free urlRedaction.ts so that core
// (mqtt, the AMQP queue, the backplane, the boot log) and this package share
// the SAME rule rather than two drifting copies. Re-exported here because it
// has always been part of @tina4/orm's public surface.
export { redactCredentials };

/**
 * The failure a malformed `TINA4_DATABASE_URL` raises.
 *
 * The message NEVER carries the URL, and nothing it chains does either. It
 * stays diagnosable: the scheme or engine is named, plus the host:port when it
 * sits after the last `@` (the only place it cannot be part of a password).
 */
function invalidUrlError(raw: string, engine: DatabaseEngine, why: string): Error {
  let hostPort: string | undefined;
  try {
    const parts = splitConnectionUrl(raw, { label: "DatabaseUrl" });
    if (parts.userinfo !== null && parts.hostPort !== "") hostPort = parts.hostPort;
  } catch {
    // already refused: name nothing beyond the engine
  }
  return new ConnectionUrlError(
    `DatabaseUrl: invalid ${engine} URL${hostPort ? ` at '${hostPort}'` : ""} (${why}) - expected ` +
      "scheme://[user[:password]@]host[:port]/database. " +
      "The URL itself is not shown because it may contain a password.",
  );
}

/** Split under the shared rule; the refusal names the scheme, never the value. */
function split(url: string): ConnectionUrlParts {
  return splitConnectionUrl(url, {
    label: "DatabaseUrl",
    expected: "scheme://[user[:password]@]host[:port]/database",
  });
}

/**
 * DISPLAY REDACTS, FIDELITY DOES NOT. JSON.stringify, util.inspect, String() and
 * toSafeString() replace the password with the redaction marker, so a log line, a
 * stack or a status payload is safe. structuredClone deliberately does not: its
 * contract is a faithful structural copy, and a masked clone would produce an
 * object whose password is the literal "***".
 *
 * The consequence: DO NOT PERSIST THIS OBJECT. A DatabaseUrl structured-cloned
 * onto a worker thread, into a cache or into a queue payload carries a cleartext
 * credential across that boundary. Use toSafeString() instead.
 * test/databaseUrlRedaction.test.ts fails the build if framework code ever does.
 */
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

  /**
   * Connection target for the adapter. sqlite and odbc are the whole value.
   *
   * NOT SAFE TO LOG. For every network engine this is credential-free
   * (host:port/database), which makes it look loggable - but the odbc branch
   * returns the connection string VERBATIM, `PWD=` included, because that is
   * what the driver has to receive. Log `toSafeString()`; never this.
   */
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
    // The odbc branch used to return the connection string VERBATIM - `PWD=`
    // and all - so the ONE method whose job is redaction handed back the
    // password in full. The negative test "to_safe_string_never_contains_the_
    // password" passed in all four frameworks the whole time, because the
    // shared corpus had no odbc row: a green guard protecting nothing.
    if (this.engine === "odbc") return `odbc:///${redactCredentials(this.connectionString ?? "")}`;

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

  /**
   * What `JSON.stringify(url)` emits.
   *
   * Without it, stringifying the value - directly, or as one field of a config
   * object being logged - emitted `"password":"<the real password>"`, measured
   * on this class. Python guards the same exposure with `__repr__` and Ruby
   * with `#inspect`; JSON is the shape Node actually serialises into a log
   * line, so it needs the guard too.
   *
   * Structure is preserved so the dump is still worth having: only the secret
   * is masked. `null` stays `null` - an ABSENT password and a masked one are
   * different facts, and flattening them would hide exactly the confusion C7
   * is about.
   */
  toJSON(): Record<string, unknown> {
    return {
      engine: this.engine,
      host: this.host,
      port: this.port,
      database: this.database,
      username: this.username,
      password: this.password === null ? null : REDACTED,
      connectionString:
        this.connectionString === null ? null : redactCredentials(this.connectionString),
    };
  }

  /**
   * What `console.log(url)` / `util.inspect(url)` print.
   *
   * Node's equivalent of Python's `__repr__` and Ruby's `#inspect`, and the
   * same rendering they produce - `DatabaseUrl('postgres://user:***@h:5432/db')`
   * (tina4-python/tina4_python/database/database_url.py:153). Without it,
   * `console.log(url)` printed the default field dump, password included.
   */
  [inspect.custom](): string {
    return `DatabaseUrl('${this.toSafeString()}')`;
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
    const parts = split(url);
    if (parts.scheme === "mssql" || parts.scheme === "sqlserver") {
      return DatabaseUrl.parsePathForm(url, parts, "mssql");
    }
    if (parts.scheme === "firebird") {
      return DatabaseUrl.parsePathForm(url, parts, "firebird");
    }
    return DatabaseUrl.parseStandard(url, parts);
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
   * mssql and firebird: `host[:port]/database`, split by the shared splitter.
   *
   * These used to be one regex each that split userinfo at the FIRST `@` and
   * the password at the first `/`, so `mssql://u:p@ss@h/db` connected to a host
   * named `ss@h` and printed it in the driver's error.
   *
   * The database keeps its own leading slash when the URL had two, which is
   * how the documented absolute Firebird form survives. The old code did
   * `"/" + match[5]`, ADDING a slash - so an absolute path came back with two
   * and a relative path was silently made absolute. Verified against live
   * Firebird 5.0.4: the driver takes one or two leading slashes and rejects a
   * relative path outright.
   */
  private static parsePathForm(url: string, parts: ConnectionUrlParts, engine: DatabaseEngine): ParsedParts {
    if (parts.host === "" || /[:/]/.test(parts.host) || parts.hostPort.startsWith("[")) {
      throw invalidUrlError(url, engine, "a host is required");
    }
    if (!parts.tail.startsWith("/")) throw invalidUrlError(url, engine, "a /database is required");
    return {
      engine,
      username: parts.username === "" ? null : parts.username,
      password: parts.password,
      host: parts.host,
      port: parts.port ?? undefined,
      database: parts.tail.slice(1),
    };
  }

  /**
   * postgres / mysql / mongodb.
   *
   * Userinfo comes from the shared splitter (the last-`@` rule), never from the
   * URL class: `new URL()` cuts a password at its first `/`, `?` or `#`, reads
   * `postgres:/u:pw@h` as a path, and throws a TypeError whose `.input` is the
   * whole URL. The class only sees a credential-free rebuild, for the host,
   * port and path it already normalises the way every corpus row expects.
   */
  private static parseStandard(url: string, parts: ConnectionUrlParts): ParsedParts {
    const engine = ENGINE_ALIASES[parts.scheme];
    if (engine === undefined) {
      throw new Error(
        `DatabaseUrl: Unsupported database scheme '${parts.scheme}'. Supported: ${Object.keys(ENGINE_ALIASES).join(", ")}`
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(`${parts.scheme}://${parts.hostPort}${parts.tail}`);
    } catch {
      // No `cause`: the TypeError carries its input.
      throw invalidUrlError(url, engine, "the host, port or path is malformed");
    }
    const database = stripOneSlash(parsed.pathname);
    // A password that was WRITTEN but left blank (`postgres://user:@host/db`)
    // is an explicitly-empty password, NOT an absent one, so the
    // TINA4_DATABASE_PASSWORD fallback in the constructor must not fire for it.
    // The splitter reads the RAW userinfo, so it tells the two apart (`""`
    // versus null) where the URL class normalised both to `.password === ""`.
    return {
      engine,
      host: parsed.hostname || undefined,
      port: parsed.port ? parseInt(parsed.port, 10) : undefined,
      username: parts.username === "" ? null : parts.username,
      password: parts.password,
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
