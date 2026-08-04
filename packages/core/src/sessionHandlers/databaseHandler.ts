/**
 * Tina4 Database Session Handler — SQLite via Node's built-in node:sqlite,
 * zero extra dependencies.
 *
 * Uses the same `node:sqlite` (DatabaseSync) the ORM's SQLite adapter uses —
 * no third-party driver, nothing to install.
 * Stores sessions in a `tina4_session` table with JSON data and expiry.
 *
 * Configure via environment variables:
 *   TINA4_DATABASE_URL  (default: "sqlite:///data/tina4_sessions.db")
 */
import { DatabaseSync } from "node:sqlite";
import type { SessionHandler } from "../session.js";

interface SessionData {
  _created: number;
  _accessed: number;
  [key: string]: unknown;
}

export interface DatabaseSessionConfig {
  /** SQLite database file path (default: extracted from TINA4_DATABASE_URL or "data/tina4_sessions.db") */
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
 * Database session handler using node:sqlite (synchronous SQLite).
 *
 * Stores session data as JSON in a `tina4_session` table.
 * Expiry is checked on read; expired rows are cleaned up lazily.
 */
export class DatabaseSessionHandler implements SessionHandler {
  private dbHandle: any = null;
  private dbPath: string;
  private initialized = false;

  /**
   * NO I/O IN A CONSTRUCTOR (ADR-0021).
   *
   * This used to run `new DatabaseSync(dbPath)` and a `PRAGMA journal_mode = WAL`
   * right here. Both are real work against real storage: opening the database
   * CREATES the file, and switching to WAL creates its `-wal` and `-shm`
   * siblings. Measured from a clean temp cwd, merely constructing this handler
   * left three files on disk before a single session was ever read or written.
   *
   * A constructor sits OUTSIDE the log-loud-and-degrade policy, so nothing it
   * does can be logged, degraded, or re-raised by TINA4_SESSION_STRICT - the one
   * place the policy cannot protect is the first thing that runs. The path is
   * resolved here (pure string work, and resolveDbPath's refusal of a non-sqlite
   * URL is a CONFIGURATION error that must still be loud at construction), and
   * the database itself is opened on first use.
   */
  constructor(config?: DatabaseSessionConfig) {
    this.dbPath = config?.dbPath ?? this.resolveDbPath();
  }

  /** Open the database on FIRST USE, not at construction. */
  private get db(): any {
    if (this.dbHandle === null) {
      this.dbHandle = new DatabaseSync(this.dbPath);
      this.dbHandle.exec("PRAGMA journal_mode = WAL");
    }
    return this.dbHandle;
  }

  /**
   * Resolve the database file path from TINA4_DATABASE_URL or use the default.
   *
   * A NON-SQLITE URL RAISES. It used to fall through to the literal default
   * `"data/tina4_sessions.db"`, so `TINA4_DATABASE_URL=postgres://...` with
   * `TINA4_SESSION_BACKEND=database` round-tripped happily while writing SQLite
   * files into the process working directory. Measured from a clean temp cwd:
   * round-trip true, and `data/` contained `tina4_sessions.db`, `-shm` and
   * `-wal`. Every horizontally-scaled instance therefore had its own private
   * session store and a user was logged out on every request that landed
   * elsewhere - an outage that looks exactly like success.
   *
   * This is the same rule `resolveBackend()` already applies one layer up, where
   * an unknown backend name raises rather than falling through to disk, and for
   * the same reason: a silent demotion to local disk is indistinguishable from
   * working until users start losing their sessions.
   *
   * This handler is SQLite-only by construction - it drives `node:sqlite`
   * directly - so a non-sqlite URL is a configuration error, not something to
   * paper over.
   *
   * @throws Error naming the offending URL scheme and the two ways out.
   */
  private resolveDbPath(): string {
    const url = process.env.TINA4_DATABASE_URL;
    if (!url) return "data/tina4_sessions.db";

    if (url.startsWith("sqlite:")) {
      // sqlite:///path/to/db  or  sqlite://./relative/path
      return url.replace(/^sqlite:(\/\/)?/, "");
    }

    const scheme = url.split(":", 1)[0];
    throw new Error(
      `The "database" session backend is SQLite-only, but TINA4_DATABASE_URL is a `
      + `"${scheme}" URL. It used to silently write a local SQLite file instead, which `
      + `gives every instance its own private session store. Either point `
      + `TINA4_DATABASE_URL at a sqlite:// URL, or pass an explicit dbPath in the `
      + `session config, or choose a session backend that speaks ${scheme} `
      + `(redis, valkey, mongodb, memcached).`,
    );
  }

  /**
   * Ensure the session table exists (called once on first use).
   */
  private ensureTable(): void {
    if (this.initialized) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tina4_session (
          session_id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          expires_at REAL NOT NULL
      )
    `);
    this.initialized = true;
  }

  read(sessionId: string): SessionData | null {
    this.ensureTable();

    const row = this.db
      .prepare("SELECT data, expires_at FROM tina4_session WHERE session_id = ?")
      .get(sessionId) as { data: string; expires_at: number } | undefined;

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
    if (row.expires_at > 0 && row.expires_at < now) {
      // Expired — clean up and return null
      this.destroy(sessionId);
      return null;
    }

    try {
      return JSON.parse(row.data) as SessionData;
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

    const existing = this.db
      .prepare("SELECT 1 FROM tina4_session WHERE session_id = ?")
      .get(sessionId);

    if (existing) {
      this.db
        .prepare("UPDATE tina4_session SET data = ?, expires_at = ? WHERE session_id = ?")
        .run(json, expiresAt, sessionId);
    } else {
      this.db
        .prepare("INSERT INTO tina4_session (session_id, data, expires_at) VALUES (?, ?, ?)")
        .run(sessionId, json, expiresAt);
    }
  }

  destroy(sessionId: string): void {
    this.ensureTable();
    this.db
      .prepare("DELETE FROM tina4_session WHERE session_id = ?")
      .run(sessionId);
  }

  gc(_maxLifetime: number): void {
    this.ensureTable();
    const now = Date.now() / 1000;
    this.db
      .prepare("DELETE FROM tina4_session WHERE expires_at > 0 AND expires_at < ?")
      .run(now);
  }
}
