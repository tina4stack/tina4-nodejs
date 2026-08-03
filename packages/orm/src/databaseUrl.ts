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

// ── redaction ──────────────────────────────────────────────────────────────
// ONE primitive, used by every path that can put a connection string in front
// of a human. Before this, `toSafeString()` had ZERO call sites outside the
// corpus test - its own docblock called it "the ONLY form allowed in a log
// line" while the invalid-URL exception interpolated the RAW url and the odbc
// branch returned the connection string VERBATIM, `PWD=` and all.

/** The single mask. One spelling, so grepping for it finds every redaction. */
const REDACTED = "***";

/**
 * Where a keyword VALUE ends in a keyword/value connection string.
 *
 * NOT at the first whitespace. tina4-php redacted its connect-failure message
 * with a `\bpassword=\S` + star pattern, and a password containing a SPACE kept
 * its TAIL in the logged line. The real terminators are the field separators -
 * `;` for ODBC/libpq, `&` for a query string - plus the closing brace/quote of
 * a quoted value, since `PWD={p;w}` and the libpq quoted form both legally
 * contain a separator.
 */
function endOfKeywordValue(text: string, start: number): number {
  const open = text[start];
  if (open === "{") {
    const close = text.indexOf("}", start + 1);
    return close === -1 ? text.length : close + 1;
  }
  if (open === "'" || open === '"') {
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i] === open) return i + 1;
      i++;
    }
    return text.length;
  }
  let i = start;
  while (i < text.length && text[i] !== ";" && text[i] !== "&") i++;
  return i;
}

/** `PWD=`/`password=`/`passwd=` in an ODBC DSN, a libpq DSN or a query string. */
const SECRET_KEYWORD_PATTERN = /(^|[;&?\s])(pwd|password|passwd)(\s*=\s*)/gi;

function redactKeywordValues(text: string): string {
  const pattern = new RegExp(SECRET_KEYWORD_PATTERN.source, SECRET_KEYWORD_PATTERN.flags);
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const valueStart = match.index + match[0].length;
    out += text.slice(cursor, valueStart) + REDACTED;
    cursor = endOfKeywordValue(text, valueStart);
    pattern.lastIndex = cursor;
  }
  return out + text.slice(cursor);
}

/**
 * The authority of `scheme://user:pass@host:port/path`, or null when the string
 * has no `://` at all. Everything the other helpers need is derived from here,
 * so "where does userinfo end" is decided in exactly one place.
 */
function authorityOf(raw: string): string | null {
  const separator = raw.indexOf("://");
  if (separator === -1) return null;
  const rest = raw.slice(separator + 3);
  const end = rest.search(/[/?#]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The raw, still-encoded userinfo, or null when the URL carries none.
 *
 * Read off the RAW string on purpose: `new URL()` normalises
 * `postgres://user:@host/db` and `postgres://user@host/db` to the identical
 * href, so the URL object cannot tell an explicitly-blank password from an
 * absent one (measured on Node 24.9.0 - both report `.password === ""`).
 */
function rawUserinfo(raw: string): string | null {
  const authority = authorityOf(raw);
  if (authority === null) return null;
  const at = authority.lastIndexOf("@");
  return at === -1 ? null : authority.slice(0, at);
}

function redactUserinfoPassword(raw: string): string {
  const authority = authorityOf(raw);
  if (authority === null) return raw;
  const at = authority.lastIndexOf("@");
  if (at === -1) return raw;
  const colon = authority.slice(0, at).indexOf(":");
  if (colon === -1) return raw; // a username with no password
  const authorityStart = raw.indexOf("://") + 3;
  return (
    raw.slice(0, authorityStart + colon + 1) + REDACTED + raw.slice(authorityStart + at)
  );
}

/**
 * Remove every credential from an arbitrary connection string.
 *
 * THE single redaction primitive. It works on a RAW string - valid or
 * malformed, a URL or an ODBC DSN - so the error paths can use it too, and it
 * is what `toSafeString()` calls for the odbc form rather than hand-rolling a
 * second, weaker rule.
 *
 * It cannot be complete on a string with no recognisable credential structure
 * (`notaurl-with-hunter2` has nothing to key off), which is exactly why the
 * invalid-URL error reports the scheme and host instead of any form of the
 * input. Redaction is for strings we can parse enough to redact.
 */
export function redactCredentials(raw: string): string {
  if (typeof raw !== "string" || raw === "") return raw;
  return redactKeywordValues(redactUserinfoPassword(raw));
}

/** `postgres` from `postgres://…`, or null when the string names no scheme. */
function schemeOf(raw: string): string | null {
  const match = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * The `host:port` slice of the authority, or null.
 *
 * Credential-free BY CONSTRUCTION: it is the part AFTER the last `@`, and
 * userinfo - the only place a password may appear in a URL - is entirely
 * before it. That is what makes it safe to name in an error message.
 */
function hostPortOf(raw: string): string | null {
  const authority = authorityOf(raw);
  if (authority === null) return null;
  const at = authority.lastIndexOf("@");
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  return hostPort === "" ? null : hostPort;
}

/**
 * The failure a malformed `TINA4_DATABASE_URL` raises.
 *
 * The message NEVER carries the URL. The old one interpolated it, so a typo in
 * the port wrote the password into the boot log, the crash report, the error
 * overlay and the CI log - measured: `TINA4_DATABASE_URL` of
 * `postgres://user:SuperSecret123@host:notaport/db` produced
 * `DatabaseUrl: invalid URL format 'postgres://user:SuperSecret123@host:notaport/db'`.
 *
 * It stays diagnosable: the scheme (or engine) and the host:port are both in
 * the message, along with the shape that was expected. A redaction that leaves
 * nothing to debug with is its own kind of bug.
 */
function invalidUrlError(raw: string, engine?: DatabaseEngine): Error {
  const named = engine ?? schemeOf(raw);
  const subject = named ? `invalid ${named} URL` : "invalid URL (no scheme found)";
  const hostPort = hostPortOf(raw);
  const at = hostPort === null ? "" : ` at '${hostPort}'`;
  return new Error(
    `DatabaseUrl: ${subject}${at} - expected ` +
      "scheme://[user[:password]@]host[:port]/database. " +
      "The URL itself is not shown because it may contain a password."
  );
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
    if (!m) throw invalidUrlError(url, engine);
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
      throw invalidUrlError(url);
    }
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    const engine = ENGINE_ALIASES[scheme];
    if (engine === undefined) {
      throw new Error(
        `DatabaseUrl: Unsupported database scheme '${scheme}'. Supported: ${Object.keys(ENGINE_ALIASES).join(", ")}`
      );
    }
    const database = stripOneSlash(parsed.pathname);
    // A password that was WRITTEN but left blank (`postgres://user:@host/db`)
    // is an explicitly-empty password, NOT an absent one, so the
    // TINA4_DATABASE_PASSWORD fallback in the constructor must not fire for it.
    // `decode()` collapsed both to null and the fallback DID fire, so the same
    // .env authenticated with two different passwords depending on which
    // framework read it. The URL object cannot tell the two apart (it
    // normalises both to `.password === ""`), so the RAW userinfo decides.
    const userinfo = rawUserinfo(url);
    const passwordWasWritten = userinfo !== null && userinfo.includes(":");
    return {
      engine,
      host: parsed.hostname || undefined,
      port: parsed.port ? parseInt(parsed.port, 10) : undefined,
      username: decode(parsed.username),
      password: passwordWasWritten ? decodeURIComponent(parsed.password) : null,
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
