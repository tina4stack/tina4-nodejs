/**
 * Tina4 Valkey Session Handler — Valkey (Redis-compatible) via raw TCP, zero dependencies.
 *
 * Same as the Redis handler but uses VALKEY-prefixed configuration variables.
 * Valkey is a Redis-compatible key-value store fork.
 *
 * Configure via environment variables:
 *   TINA4_SESSION_VALKEY_HOST     (default: "127.0.0.1")
 *   TINA4_SESSION_VALKEY_PORT     (default: 6379)
 *   TINA4_SESSION_VALKEY_PASSWORD (optional)
 *   TINA4_SESSION_VALKEY_PREFIX   (default: "tina4:session:")
 *   TINA4_SESSION_VALKEY_DB       (default: 0)
 */
import type { SessionHandler } from "../session.js";
import { respCommandSync } from "./respClient.js";

interface SessionData {
  _created: number;
  _accessed: number;
  [key: string]: unknown;
}

export interface ValkeySessionConfig {
  host?: string;
  port?: number;
  password?: string;
  prefix?: string;
  db?: number;
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
 * Valkey session handler using raw TCP (RESP protocol).
 *
 * Uses synchronous socket communication — no external Valkey/Redis client required.
 * Stores session data as JSON strings with Valkey TTL for automatic expiry.
 *
 * Valkey uses the same RESP protocol as Redis, so this handler is functionally
 * identical to RedisSessionHandler but with VALKEY config variable names.
 */
export class ValkeySessionHandler implements SessionHandler {
  private host: string;
  private port: number;
  private password: string;
  private prefix: string;
  private db: number;

  constructor(config?: ValkeySessionConfig) {
    this.host = config?.host
      ?? process.env.TINA4_SESSION_VALKEY_HOST
      ?? "127.0.0.1";
    this.port = config?.port
      ?? (process.env.TINA4_SESSION_VALKEY_PORT
        ? parseInt(process.env.TINA4_SESSION_VALKEY_PORT, 10)
        : 6379);
    this.password = config?.password
      ?? process.env.TINA4_SESSION_VALKEY_PASSWORD
      ?? "";
    this.prefix = config?.prefix
      ?? process.env.TINA4_SESSION_VALKEY_PREFIX
      ?? "tina4:session:";
    this.db = config?.db
      ?? (process.env.TINA4_SESSION_VALKEY_DB
        ? parseInt(process.env.TINA4_SESSION_VALKEY_DB, 10)
        : 0);
  }

  /**
   * Execute a RESP command synchronously against the live Valkey server.
   *
   * Delegates to the shared {@link respCommandSync} transport: a genuine key miss
   * yields `""`, and a transport/connection FAILURE (server unreachable, rejected
   * AUTH, timeout) THROWS so the Session boundary can distinguish "not found"
   * (silent) from "backend failed" (log-loud + degrade). Backend-failure parity.
   */
  private execSync(args: string[]): string {
    return respCommandSync(
      { host: this.host, port: this.port, password: this.password, db: this.db },
      args,
      "Valkey",
    );
  }

  private key(sessionId: string): string {
    return `${this.prefix}${sessionId}`;
  }

  read(sessionId: string): SessionData | null {
    const raw = this.execSync(["GET", this.key(sessionId)]);
    if (!raw) return null;     // key miss — normal "no session yet", NOT an error
    try {
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }

  write(sessionId: string, data: SessionData, ttl: number): void {
    const json = JSON.stringify(data);
    if (ttl > 0) {
      this.execSync(["SETEX", this.key(sessionId), String(ttl), json]);
    } else {
      this.execSync(["SET", this.key(sessionId), json]);
    }
  }

  destroy(sessionId: string): void {
    this.execSync(["DEL", this.key(sessionId)]);
  }
}
