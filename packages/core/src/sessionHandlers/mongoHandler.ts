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
  private hostExplicit: boolean;
  private portExplicit: boolean;
  private uriExplicit: boolean;

  constructor(config?: MongoSessionConfig) {
    // WHICH VALUES THE CALLER GAVE US EXPLICITLY, recorded because a URI from the
    // ENVIRONMENT must never override an argument the caller passed by hand. See
    // target() for the precedence and the defect this fixes.
    this.hostExplicit = config?.host !== undefined;
    this.portExplicit = config?.port !== undefined;
    this.uriExplicit = config?.uri !== undefined;

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

  /**
   * Resolve the effective host/port (honours a configured mongodb:// URI).
   *
   * PRECEDENCE, and it runs the way every other resolver in Tina4 runs -
   * EXPLICIT CONFIGURATION BEATS THE ENVIRONMENT:
   *
   *   1. an explicitly passed `uri`      - the caller named a complete address
   *   2. an explicitly passed host/port  - per field, and an ENV uri may not touch them
   *   3. TINA4_SESSION_MONGO_URI / _URL  - the ambient address
   *   4. TINA4_SESSION_MONGO_HOST/_PORT  - ambient parts
   *   5. 127.0.0.1:27017
   *
   * THE DEFECT THIS FIXES, measured 2026-08-05 on the lab host: the URI won
   * UNCONDITIONALLY, including over an argument the caller had just passed by
   * hand. With TINA4_SESSION_MONGO_URI=mongodb://127.0.0.1:27017/tina4_node
   * exported - an entirely ordinary deployment setting -
   *
   *     new MongoSessionHandler({ host: "127.0.0.1", port: 59999 })
   *
   * resolved to 127.0.0.1:27017. The handler dialled a DIFFERENT SERVER from the
   * one it was told to use, said nothing, and a read against it came back null:
   * indistinguishable from a genuine miss. So an app that points a handler at one
   * Mongo while the environment names another writes its sessions to the wrong
   * server, and the backend-failure policy cannot fire because nothing failed.
   *
   * It also made two suites report a framework contract as broken - the
   * unreachable-server-must-throw cases in sessionHandlers and
   * sessionMongoRawProtocol never reached the dead port at all, so they measured
   * a live server and got a miss. Those cases were RIGHT; this was the bug they
   * were catching.
   *
   * Same class as the TINA4_QUEUE_URL precedence inversion fixed in PHP's
   * Queue::resolveMongoConfig earlier the same day: environment quietly beating
   * an explicit argument.
   */
  private target(): MongoTarget {
    let host = this.host;
    let port = this.port;
    // An ENV-supplied uri may fill in only what the caller did NOT pin. An
    // explicitly passed uri is the caller's own choice and still wins outright.
    const uriMayOverrideHost = this.uriExplicit || !this.hostExplicit;
    const uriMayOverridePort = this.uriExplicit || !this.portExplicit;
    if (this.uri && (uriMayOverrideHost || uriMayOverridePort)) {
      const match = this.uri.match(/mongodb:\/\/(?:[^@/]+@)?([^/:]+):?(\d+)?/);
      if (match) {
        if (uriMayOverrideHost) host = match[1];
        if (uriMayOverridePort) port = match[2] ? parseInt(match[2], 10) : 27017;
      }
    }
    return { host, port, database: this.database, collection: this.collection };
  }

  read(sessionId: string): SessionData | null {
    const result = mongoCommandSync(this.target(), "find", { filter: { _id: sessionId } });
    if (!result || result === "__EMPTY__") return null;   // genuine miss
    try {
      const doc = JSON.parse(result) as { data?: unknown; expires_at?: number };

      // Expiry is an ABSOLUTE deadline stamped at write time, and an absent or
      // zero stamp means "never expires" - so it is guarded OUT of the
      // comparison, never fed INTO it. Before this, read() consulted NOTHING:
      // no stamp was stored, no TTL index was created, and write() took the ttl
      // as `_ttl` and discarded it, so a mongodb-backed session never expired at
      // all. Measured: write with ttl=1, sleep 3s, read still returned the data
      // while file/redis/valkey/memcached/database all returned null.
      const expiresAt = Number(doc?.expires_at ?? 0);
      if (expiresAt > 0 && Date.now() / 1000 > expiresAt) {
        this.destroy(sessionId);
        return null;
      }

      const data = doc?.data;
      // Stored as a nested document (parity with the Python master); read returns it.
      return data && typeof data === "object" ? (data as SessionData) : null;
    } catch {
      return null;
    }
  }

  /**
   * Write session data.
   *
   * The ttl is consumed HERE, at write time, and baked into an absolute deadline,
   * so nothing at read time needs to know what the ttl was. The parameter used to
   * be named `_ttl` and thrown away.
   *
   * @param sessionId - the session id
   * @param data - the payload to store
   * @param ttl - lifetime in seconds; 0 or less means never expires
   */
  write(sessionId: string, data: SessionData, ttl: number = 0): void {
    mongoCommandSync(this.target(), "update", {
      filter: { _id: sessionId },
      data,
      expires_at: ttl > 0 ? Math.floor(Date.now() / 1000) + ttl : 0,
      last_accessed: Date.now() / 1000,
    });
  }

  destroy(sessionId: string): void {
    mongoCommandSync(this.target(), "delete", { filter: { _id: sessionId } });
  }
}
