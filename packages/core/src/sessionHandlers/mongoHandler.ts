/**
 * Tina4 MongoDB Session Handler — MongoDB wire protocol via raw TCP, zero dependencies.
 *
 * Stores session data in MongoDB using the MongoDB wire protocol directly.
 * No `mongodb` or `mongoose` npm package required.
 *
 * Configure via environment variables:
 *   TINA4_SESSION_MONGO_HOST       (default: "127.0.0.1")
 *   TINA4_SESSION_MONGO_PORT       (default: 27017)
 *   TINA4_SESSION_MONGO_URI        (overrides host/port if set)
 *   TINA4_SESSION_MONGO_USERNAME   (optional)
 *   TINA4_SESSION_MONGO_PASSWORD   (optional)
 *   TINA4_SESSION_MONGO_DB         (default: "tina4_sessions")
 *   TINA4_SESSION_MONGO_COLLECTION (default: "sessions")
 */
import type { SessionHandler } from "../session.js";
import { mongoCommandSync, type MongoTarget } from "./mongoClient.js";

interface SessionData {
  _created: number;
  _accessed: number;
  [key: string]: unknown;
}

export interface MongoSessionConfig {
  host?: string;
  port?: number;
  uri?: string;
  username?: string;
  password?: string;
  database?: string;
  collection?: string;
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
 * MongoDB session handler using raw TCP (MongoDB wire protocol).
 *
 * Uses synchronous socket communication via child process — no external
 * MongoDB client library required. Stores session data as BSON documents
 * with TTL index support.
 */
export class MongoSessionHandler implements SessionHandler {
  private host: string;
  private port: number;
  private uri: string;
  private username: string;
  private password: string;
  private database: string;
  private collection: string;

  constructor(config?: MongoSessionConfig) {
    this.host = config?.host
      ?? process.env.TINA4_SESSION_MONGO_HOST
      ?? "127.0.0.1";
    this.port = config?.port
      ?? (process.env.TINA4_SESSION_MONGO_PORT
        ? parseInt(process.env.TINA4_SESSION_MONGO_PORT, 10)
        : 27017);
    // Canonical TINA4_SESSION_MONGO_URI; TINA4_SESSION_MONGO_URL is a legacy alias.
    this.uri = config?.uri
      ?? process.env.TINA4_SESSION_MONGO_URI
      ?? process.env.TINA4_SESSION_MONGO_URL
      ?? "";
    this.username = config?.username
      ?? process.env.TINA4_SESSION_MONGO_USERNAME
      ?? "";
    this.password = config?.password
      ?? process.env.TINA4_SESSION_MONGO_PASSWORD
      ?? "";
    this.database = config?.database
      ?? process.env.TINA4_SESSION_MONGO_DB
      ?? "tina4_sessions";
    this.collection = config?.collection
      ?? process.env.TINA4_SESSION_MONGO_COLLECTION
      ?? "sessions";
  }

  /** Resolve the effective host/port (honours a configured mongodb:// URI). */
  private target(): MongoTarget {
    let host = this.host;
    let port = this.port;
    if (this.uri) {
      const match = this.uri.match(/mongodb:\/\/(?:[^@/]+@)?([^/:]+):?(\d+)?/);
      if (match) {
        host = match[1];
        port = match[2] ? parseInt(match[2], 10) : 27017;
      }
    }
    return { host, port, database: this.database, collection: this.collection };
  }

  read(sessionId: string): SessionData | null {
    const result = mongoCommandSync(this.target(), "find", { filter: { _id: sessionId } });
    if (!result || result === "__EMPTY__") return null;   // genuine miss
    try {
      const doc = JSON.parse(result) as { data?: unknown };
      const data = doc?.data;
      // Stored as a nested document (parity with the Python master); read returns it.
      return data && typeof data === "object" ? (data as SessionData) : null;
    } catch {
      return null;
    }
  }

  write(sessionId: string, data: SessionData, _ttl: number): void {
    mongoCommandSync(this.target(), "update", {
      filter: { _id: sessionId },
      data,
      last_accessed: Date.now() / 1000,
    });
  }

  destroy(sessionId: string): void {
    mongoCommandSync(this.target(), "delete", { filter: { _id: sessionId } });
  }
}
