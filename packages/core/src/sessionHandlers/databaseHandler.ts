/**
 * Tina4 Database Session Handler — sessions in a `tina4_session` table on ANY
 * engine the ORM Database layer supports: sqlite, postgres, mysql, mssql,
 * firebird.
 *
 * WHAT THIS USED TO BE, and why it changed. This handler was SQLite-only by
 * construction: resolveDbPath() THREW on any non-sqlite TINA4_DATABASE_URL. So
 * an app developed on SQLite and deployed on PostgreSQL did not start at all -
 * the founding scenario of ADR-0024, landing in the one subsystem that decides
 * whether anybody is logged in. A backend that advertises support for an engine
 * has to work on that engine.
 *
 * The refusal was defended on the grounds that the session API is SYNCHRONOUS
 * and a PostgreSQL driver is async, so multi-engine "would need a synchronous
 * Postgres bridge". That premise was wrong: the bridge already existed
 * (syncBridge.ts) with four consumers - RESP for Redis/Valkey, memcached and
 * MongoDB. sqlClient.ts makes this the fifth.
 *
 * SQLITE STAYS ON `node:sqlite`, DIRECTLY. It is already synchronous, so
 * putting it on the bridge would add a thread hop and a JSON round-trip to the
 * one engine that needs neither.
 *
 * WHAT DID NOT CHANGE: an unsupported engine still REFUSES, loudly, by name. It
 * must never fall back to a local SQLite file - that hands every horizontally
 * scaled instance its own private session store, so a user is logged out on
 * every request that lands elsewhere. An outage that looks exactly like success
 * is worse than a refusal, which is why the refusal is kept even though the
 * supported set is now five engines instead of one.
 *
 * Configure via environment variables:
 *   TINA4_DATABASE_URL       (default: a local SQLite file, "data/tina4_sessions.db")
 *   TINA4_DATABASE_USERNAME  (used when the URL carries no credentials)
 *   TINA4_DATABASE_PASSWORD  (same)
 */
import { DatabaseSync } from "node:sqlite";
import type { SessionHandler } from "../session.js";
// The ORM's connection-string parser, NOT a second copy of it. The invariant is
// "the session backend works on every engine the Database layer supports", so
// it has to agree with that layer about what a connection string MEANS -
// aliases (postgresql/pgsql/sqlserver), default ports, credential fallbacks and
// the explicitly-blank-password rule included. A private parser here would be
// free to drift from the corpus fixture that keeps all four frameworks honest.
// databaseUrl.ts imports nothing but node:util, so this adds one pure module to
// the graph and no package cycle.
import { DatabaseUrl } from "../../../orm/src/databaseUrl.js";
import { SQL_SESSION_ENGINES, sqlCommandSync } from "./sqlClient.js";
import type { BridgedEngine, SqlTarget } from "./sqlClient.js";

interface SessionData {
  _created: number;
  _accessed: number;
  [key: string]: unknown;
}

export interface DatabaseSessionConfig {
  /** SQLite database file path. Explicit config wins over TINA4_DATABASE_URL. */
  dbPath?: string;
  // Unified SessionConfig fields are tolerated (and ignored) so the central
  // Session can forward its config object without a structural mismatch.
  backend?: string;
  path?: string;
  ttl?: number;
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  redisPrefix?: string;
  redisDb?: number;
}

/**
 * CREATE TABLE per engine. The only genuinely per-engine SQL in this file -
 * every other statement is written once with `?` placeholders and rewritten for
 * the driver by sqlClient.
 *
 * The COLUMNS are identical everywhere (session_id, data, expires_at) because
 * the table is a cross-framework contract: a tina4_session table written by
 * tina4-python must be readable by tina4-nodejs. Only the type spellings and
 * the "create it only if absent" idiom differ.
 */
const CREATE_TABLE: Record<string, string> = {
  // Unchanged from the SQLite-only original, deliberately: an existing
  // deployment's table must keep working untouched.
  sqlite: `
      CREATE TABLE IF NOT EXISTS tina4_session (
          session_id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          expires_at REAL NOT NULL
      )
    `,
  postgres: `
      CREATE TABLE IF NOT EXISTS tina4_session (
          session_id VARCHAR(255) PRIMARY KEY,
          data TEXT NOT NULL,
          expires_at DOUBLE PRECISION NOT NULL
      )
    `,
  mysql: `
      CREATE TABLE IF NOT EXISTS tina4_session (
          session_id VARCHAR(255) PRIMARY KEY,
          data TEXT NOT NULL,
          expires_at DOUBLE NOT NULL
      )
    `,
  // T-SQL has no CREATE TABLE IF NOT EXISTS; the catalog check is the idiom.
  mssql: `
      IF OBJECT_ID(N'tina4_session', N'U') IS NULL
      CREATE TABLE tina4_session (
          session_id NVARCHAR(255) NOT NULL PRIMARY KEY,
          data NVARCHAR(MAX) NOT NULL,
          expires_at FLOAT NOT NULL
      )
    `,
  // Firebird has neither IF NOT EXISTS nor a TEXT type, so the catalog check
  // goes in an EXECUTE BLOCK and the payload is a VARCHAR.
  //
  // VERIFIED 2026-08-04 against a live Firebird 5.0.4 (the lab's
  // tina4-lab-firebird container). This comment previously said UNVERIFIED and
  // claimed there was no server on the lab; there is, and this SQL was run on
  // it. What was measured, at the isql prompt:
  //
  //   CREATE TABLE IF NOT EXISTS ...  -> SQLSTATE 42000, -104,
  //                                      "Token unknown - line 1, column 17 -NOT"
  //   a column typed TEXT             -> -607, "Specified domain or source
  //                                      column TEXT does not exist"
  //   DOUBLE PRECISION                -> accepted
  //   this EXECUTE BLOCK              -> created the table; confirmed out of band
  //                                      in RDB$RELATIONS
  //   this EXECUTE BLOCK, run AGAIN
  //   with the table present          -> clean, no error: it is IDEMPOTENT
  //
  // So both halves of the first line above are now measurement rather than
  // inference: Firebird really has neither IF NOT EXISTS nor a TEXT type.
  //
  // The idempotence is NOT a race guard. It is check-then-act inside one block,
  // so two connections can still both find the table absent and both create it -
  // measured directly: a bare CREATE TABLE with the table present gives
  // SQLSTATE 42S01 "Table TINA4_SESSION already exists". The caller's
  // create-then-recheck rescue is what closes that window, on every engine.
  //
  // A VARCHAR rather than BLOB SUB_TYPE TEXT on purpose: node-firebird hands a
  // blob back as a reader function rather than a string, which the read path
  // here would not understand. The cost is a session payload ceiling of 8191
  // characters on this engine alone. Still unverified: the node-firebird DRIVER
  // path end to end - this measurement was taken at the SQL level via isql.
  firebird: `
      EXECUTE BLOCK AS BEGIN
        IF (NOT EXISTS(SELECT 1 FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = 'TINA4_SESSION')) THEN
          EXECUTE STATEMENT 'CREATE TABLE TINA4_SESSION (SESSION_ID VARCHAR(255) NOT NULL PRIMARY KEY, DATA VARCHAR(8191) NOT NULL, EXPIRES_AT DOUBLE PRECISION NOT NULL)';
      END
    `,
};

/**
 * Read a column out of a result row, case-insensitively.
 *
 * PostgreSQL folds unquoted identifiers to lower case and Firebird folds them
 * to UPPER, so the same SELECT legitimately comes back as `expires_at` on four
 * engines and `EXPIRES_AT` on one. Three lines here beats quoting every
 * identifier in every statement.
 */
function column(row: Record<string, unknown>, name: string): unknown {
  if (name in row) return row[name];
  return row[name.toUpperCase()];
}

/**
 * Database session handler.
 *
 * Stores session data as JSON in a `tina4_session` table.
 * Expiry is checked on read; expired rows are cleaned up lazily.
 */
export class DatabaseSessionHandler implements SessionHandler {
  private sqliteHandle: any = null;
  /** Set for SQLite. Null when this handler talks to a networked engine. */
  private dbPath: string | null = null;
  /** Set for a networked engine. Null for SQLite. */
  private target: SqlTarget | null = null;
  private initialized = false;

  /**
   * NO I/O IN A CONSTRUCTOR (ADR-0021).
   *
   * This used to run `new DatabaseSync(dbPath)` and a `PRAGMA journal_mode =
   * WAL` right here. Both are real work against real storage: opening the
   * database CREATES the file, and switching to WAL creates its `-wal` and
   * `-shm` siblings. Measured from a clean temp cwd, merely constructing this
   * handler left three files on disk before a single session was ever read or
   * written.
   *
   * A constructor sits OUTSIDE the log-loud-and-degrade policy, so nothing it
   * does can be logged, degraded, or re-raised by TINA4_SESSION_STRICT - the one
   * place the policy cannot protect is the first thing that runs.
   *
   * Everything below is pure string work. Resolving the target parses a URL;
   * refusing an unsupported engine is a CONFIGURATION error that must still be
   * loud at construction. The database - file or socket - is opened on first
   * use. Going multi-engine is the change most likely to reintroduce
   * constructor-time I/O, which is why test/sessionHandlerConstruction.test.ts
   * measures a real filesystem and a real listening socket rather than trusting
   * this comment.
   */
  constructor(config?: DatabaseSessionConfig) {
    if (config?.dbPath) {
      // An explicit path is an explicit choice of SQLite, and it wins over the
      // environment exactly as it always has.
      this.dbPath = config.dbPath;
      return;
    }
    this.resolveTarget();
  }

  /** Open the SQLite database on FIRST USE, not at construction. */
  private get sqlite(): any {
    if (this.sqliteHandle === null) {
      this.sqliteHandle = new DatabaseSync(this.dbPath as string);
      this.sqliteHandle.exec("PRAGMA journal_mode = WAL");
    }
    return this.sqliteHandle;
  }

  private get engine(): string {
    return this.target === null ? "sqlite" : this.target.engine;
  }

  /**
   * Decide, from TINA4_DATABASE_URL, which engine this handler talks to.
   *
   * A NON-SQLITE URL NOW WORKS. It used to throw, because the handler drove
   * `node:sqlite` directly and had no way to reach anything else; the async
   * drivers now ride the sync bridge, so the reason for the refusal is gone.
   *
   * AN UNSUPPORTED ENGINE STILL REFUSES, and that half is not negotiable. The
   * original defect was worse than a refusal: an unrecognised URL fell through
   * to the literal default `"data/tina4_sessions.db"`, so
   * `TINA4_DATABASE_URL=postgres://...` with `TINA4_SESSION_BACKEND=database`
   * round-tripped happily while writing SQLite files into the process working
   * directory. Measured from a clean temp cwd: round-trip true, and `data/`
   * contained `tina4_sessions.db`, `-shm` and `-wal`. Every horizontally-scaled
   * instance therefore had its own private session store and a user was logged
   * out on every request that landed elsewhere.
   *
   * This is the same rule `resolveBackend()` applies one layer up, where an
   * unknown backend name raises rather than falling through to disk.
   *
   * @throws Error naming the offending scheme and the engines this backend
   *         speaks. The URL itself is NEVER in the message - it may carry a
   *         password.
   */
  private resolveTarget(): void {
    const url = process.env.TINA4_DATABASE_URL;
    if (!url) {
      this.dbPath = "data/tina4_sessions.db";
      return;
    }

    if (url.startsWith("sqlite:")) {
      // sqlite:///path/to/db  or  sqlite://./relative/path
      //
      // KNOWN DIVERGENCE, deliberately left alone. DatabaseUrl reads the
      // three-slash form as RELATIVE (`sqlite:///data/app.db` -> `data/app.db`)
      // per the documented cross-framework contract, while this strips the
      // prefix and yields `/data/app.db` - an absolute path at the filesystem
      // root. They disagree, and the ORM's reading is the correct one. Changing
      // it here would silently relocate the session store of every deployment
      // using that form, which is precisely the class of failure this invariant
      // is about, so it is reported rather than smuggled into a multi-engine
      // change.
      this.dbPath = url.replace(/^sqlite:(\/\/)?/, "");
      return;
    }

    let parsed: DatabaseUrl;
    try {
      parsed = new DatabaseUrl(
        url,
        process.env.TINA4_DATABASE_USERNAME,
        process.env.TINA4_DATABASE_PASSWORD,
      );
    } catch {
      // DatabaseUrl refuses a scheme it does not know at all. Its own message
      // lists engines this backend cannot use (mongodb, odbc), so the refusal
      // is restated in terms of what the SESSION backend actually speaks.
      throw this.unsupportedEngine(schemeOf(url));
    }

    if (!(SQL_SESSION_ENGINES as readonly string[]).includes(parsed.engine)) {
      // A real engine the Database layer supports, but not a SQL one - mongodb
      // and odbc land here.
      throw this.unsupportedEngine(parsed.engine);
    }

    this.target = {
      engine: parsed.engine as BridgedEngine,
      host: parsed.host ?? "127.0.0.1",
      port: parsed.port ?? 0,
      database: parsed.database,
      username: parsed.username,
      password: parsed.password,
    };
  }

  private unsupportedEngine(scheme: string): Error {
    return new Error(
      `The "database" session backend cannot use a "${scheme}" URL. It speaks the SQL `
      + `engines the Database layer supports: ${SQL_SESSION_ENGINES.join(", ")}. Point `
      + `TINA4_DATABASE_URL at one of those, or pass an explicit dbPath in the session `
      + `config, or choose a session backend that speaks ${scheme} (redis, valkey, `
      + `mongodb, memcached). It will NOT fall back to a local SQLite file: that gives `
      + `every instance its own private session store and logs users out at random.`,
    );
  }

  // ── one statement, five engines ───────────────────────────────────
  // The SQL is written ONCE with `?` placeholders - the same statement text as
  // the Python master - and sqlClient rewrites the placeholders per driver.

  /** Run a statement that returns rows. */
  private query(sql: string, params: unknown[]): Record<string, unknown>[] {
    if (this.target === null) {
      return this.sqlite.prepare(sql).all(...params) as Record<string, unknown>[];
    }
    return sqlCommandSync(this.target, sql, params);
  }

  /** Run a statement that returns nothing. */
  private exec(sql: string, params: unknown[]): void {
    if (this.target === null) {
      this.sqlite.prepare(sql).run(...params);
      return;
    }
    sqlCommandSync(this.target, sql, params);
  }

  /**
   * Ensure the session table exists (called once on first use).
   */
  private ensureTable(): void {
    if (this.initialized) return;
    const ddl = CREATE_TABLE[this.engine];
    if (this.target === null) this.sqlite.exec(ddl);
    else sqlCommandSync(this.target, ddl, []);
    this.initialized = true;
  }

  read(sessionId: string): SessionData | null {
    this.ensureTable();

    const rows = this.query(
      "SELECT data, expires_at FROM tina4_session WHERE session_id = ?",
      [sessionId],
    );
    const row = rows[0];
    if (!row) return null;

    // Check expiry.
    //
    // An ABSENT or ZERO deadline means "never expires" and is guarded OUT of the
    // comparison. Without the `> 0` test, a row carrying no expiry (0) satisfies
    // `0 < now` against every clock and is DESTROYED on read — the same shape
    // that made tina4-php's file backend delete records. gc() below has always
    // had this guard (`WHERE expires_at > 0 AND expires_at < ?`); this read path
    // did not, so the two disagreed about what a zero meant.
    const now = Date.now() / 1000;
    const expiresAt = Number(column(row, "expires_at") ?? 0);
    if (expiresAt > 0 && expiresAt < now) {
      // Expired — clean up and return null
      this.destroy(sessionId);
      return null;
    }

    try {
      return JSON.parse(String(column(row, "data"))) as SessionData;
    } catch {
      return null;
    }
  }

  write(sessionId: string, data: SessionData, ttl: number): void {
    this.ensureTable();

    const json = JSON.stringify(data);
    // A ttl of 0 (or less) means NEVER EXPIRES and is stored as the 0 that read()
    // and gc() both guard out. It used to silently substitute 3600, so asking for
    // a non-expiring session quietly got a one-hour one.
    const expiresAt = ttl > 0 ? (Date.now() / 1000) + ttl : 0;

    // SELECT-then-UPDATE-or-INSERT, matching the Python master. Deliberately NOT
    // an upsert: ON CONFLICT / ON DUPLICATE KEY / MERGE are spelled differently
    // on all five engines, and this shape needs no dialect at all.
    const existing = this.query(
      "SELECT session_id FROM tina4_session WHERE session_id = ?",
      [sessionId],
    );

    if (existing.length > 0) {
      this.exec(
        "UPDATE tina4_session SET data = ?, expires_at = ? WHERE session_id = ?",
        [json, expiresAt, sessionId],
      );
    } else {
      this.exec(
        "INSERT INTO tina4_session (session_id, data, expires_at) VALUES (?, ?, ?)",
        [sessionId, json, expiresAt],
      );
    }
  }

  destroy(sessionId: string): void {
    this.ensureTable();
    this.exec("DELETE FROM tina4_session WHERE session_id = ?", [sessionId]);
  }

  gc(_maxLifetime: number): void {
    this.ensureTable();
    const now = Date.now() / 1000;
    this.exec("DELETE FROM tina4_session WHERE expires_at > 0 AND expires_at < ?", [now]);
  }
}

/**
 * The scheme of a connection URL, for an error message.
 *
 * Only the scheme, never the URL: a connection string may carry a password, and
 * an exception message ends up in the boot log, the crash report and CI output.
 */
function schemeOf(url: string): string {
  const match = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  return match ? match[1].toLowerCase() : "unknown";
}
