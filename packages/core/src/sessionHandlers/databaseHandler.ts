/**
 * Tina4 Database Session Handler — SQLite via better-sqlite3, zero extra dependencies.
 *
 * Uses the same `better-sqlite3` library the ORM already depends on.
 * Stores sessions in a `tina4_session` table with JSON data and expiry.
 *
 * Configure via environment variables:
 *   DATABASE_URL  (default: "sqlite:///data/tina4_sessions.db")
 *
 * The handler dynamically imports `better-sqlite3` and throws a clear
 * error if the package is not installed.
 */
import { createRequire } from "node:module";
import type { SessionHandler } from "../session.js";

const _require = createRequire(import.meta.url);

interface SessionData {
  _created: number;
  _accessed: number;
  [key: string]: unknown;
}

export interface DatabaseSessionConfig {
  /** SQLite database file path (default: extracted from DATABASE_URL or "data/tina4_sessions.db") */
  dbPath?: string;
}

/**
 * Database session handler using better-sqlite3 (synchronous SQLite).
 *
 * Stores session data as JSON in a `tina4_session` table.
 * Expiry is checked on read; expired rows are cleaned up lazily.
 */
export class DatabaseSessionHandler implements SessionHandler {
  private db: any;
  private initialized = false;

  constructor(config?: DatabaseSessionConfig) {
    const dbPath = config?.dbPath ?? this.resolveDbPath();

    let Database: any;
    try {
      Database = _require("better-sqlite3");
    } catch {
      throw new Error(
        "DatabaseSessionHandler requires 'better-sqlite3'. " +
        "Install it with: npm install better-sqlite3"
      );
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
  }

  /**
   * Resolve the database file path from DATABASE_URL or use the default.
   */
  private resolveDbPath(): string {
    const url = process.env.DATABASE_URL;
    if (url && url.startsWith("sqlite://")) {
      // sqlite:///path/to/db  or  sqlite://./relative/path
      return url.replace(/^sqlite:\/\//, "");
    }
    return "data/tina4_sessions.db";
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

    // Check expiry
    const now = Date.now() / 1000;
    if (row.expires_at < now) {
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
    const expiresAt = (Date.now() / 1000) + (ttl > 0 ? ttl : 3600);

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
}
