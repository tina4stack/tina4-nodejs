/**
 * Tina4 Redis Session Handler — Redis via `redis` npm package (optional dependency).
 *
 * Provides a session handler backed by the official `redis` npm package,
 * complementing the built-in raw-TCP RedisSessionHandler in session.ts.
 *
 * This handler uses synchronous child-process execution (same pattern as
 * valkeyHandler.ts) so it fits the synchronous SessionHandler interface
 * without requiring async refactoring.
 *
 * Configure via environment variables:
 *   TINA4_SESSION_REDIS_HOST     (default: "127.0.0.1")
 *   TINA4_SESSION_REDIS_PORT     (default: 6379)
 *   TINA4_SESSION_REDIS_URL      (optional — full redis:// URL, overrides host/port)
 *   TINA4_SESSION_REDIS_PASSWORD  (optional)
 *   TINA4_SESSION_REDIS_PREFIX   (default: "tina4:session:")
 *   TINA4_SESSION_REDIS_DB       (default: 0)
 */
import { execFileSync } from "node:child_process";
import { childFailureError } from "./childError.js";
import { createRequire } from "node:module";
import type { SessionHandler } from "../session.js";
import { respCommandSync } from "./respClient.js";

// Resolve packages relative to this module so the optional `redis` driver is
// detected exactly as a consumer would resolve it (createRequire works in ESM).
const moduleRequire = createRequire(import.meta.url);
function redisDriverAvailable(): boolean {
  try {
    moduleRequire.resolve("redis");
    return true;
  } catch {
    return false;
  }
}

interface SessionData {
  _created: number;
  _accessed: number;
  [key: string]: unknown;
}

export interface RedisNpmSessionConfig {
  host?: string;
  port?: number;
  url?: string;
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
 * Redis session handler using the `redis` npm package.
 *
 * Falls back to raw TCP (RESP protocol) if the `redis` package is not
 * installed, matching the approach used by the Valkey handler.
 *
 * Stores session data as JSON strings with Redis TTL for automatic expiry.
 */
export class RedisNpmSessionHandler implements SessionHandler {
  private host: string;
  private port: number;
  private url: string;
  private password: string;
  private prefix: string;
  private db: number;

  constructor(config?: RedisNpmSessionConfig) {
    this.url = config?.url
      ?? process.env.TINA4_SESSION_REDIS_URL
      ?? "";
    this.host = config?.host
      ?? process.env.TINA4_SESSION_REDIS_HOST
      ?? "127.0.0.1";
    this.port = config?.port
      ?? (process.env.TINA4_SESSION_REDIS_PORT
        ? parseInt(process.env.TINA4_SESSION_REDIS_PORT, 10)
        : 6379);
    this.password = config?.password
      ?? process.env.TINA4_SESSION_REDIS_PASSWORD
      ?? "";
    this.prefix = config?.prefix
      ?? process.env.TINA4_SESSION_REDIS_PREFIX
      ?? "tina4:session:";
    this.db = config?.db
      ?? (process.env.TINA4_SESSION_REDIS_DB
        ? parseInt(process.env.TINA4_SESSION_REDIS_DB, 10)
        : 0);
  }

  /** Resolve a host/port for the raw-RESP path (parses TINA4_SESSION_REDIS_URL if set). */
  private resolveHostPort(): { host: string; port: number } {
    if (this.url) {
      try {
        const u = new URL(this.url);
        return { host: u.hostname || "127.0.0.1", port: parseInt(u.port, 10) || 6379 };
      } catch {
        return { host: this.host, port: this.port };
      }
    }
    return { host: this.host, port: this.port };
  }

  /**
   * Execute a Redis command synchronously.
   *
   * Prefers the official `redis` driver when it is installed (the class's reason
   * to exist); otherwise speaks raw RESP via the shared {@link respCommandSync}
   * transport — same correct path as the Valkey handler, no `redis` dependency.
   *
   * A genuine key miss yields `""`; a transport/connection FAILURE (server
   * unreachable, rejected AUTH, timeout) THROWS so the Session boundary can
   * distinguish "not found" (silent) from "backend failed" (log-loud + degrade).
   */
  private execSync(args: string[]): string {
    if (redisDriverAvailable()) {
      return this.execViaNpm(args);
    }
    const { host, port } = this.resolveHostPort();
    return respCommandSync({ host, port, password: this.password, db: this.db }, args, "Redis");
  }

  /** Drive the command through the `redis` npm client in a short-lived child. */
  private execViaNpm(args: string[]): string {
    const script = `
      const useUrl = ${JSON.stringify(!!this.url)};
      const url = ${JSON.stringify(this.url)};
      const host = ${JSON.stringify(this.host)};
      const port = ${this.port};
      const password = ${JSON.stringify(this.password)};
      const db = ${this.db};
      const args = ${JSON.stringify(args)};
      (async () => {
        try {
          const redis = require("redis");
          // reconnectStrategy: false — this child runs ONE command and exits, so
          // retrying inside it is pointless: the handler is called again on the
          // next request anyway. With the driver's default strategy a refused
          // connection never rejects, the child hangs until execFileSync's 5s
          // timeout kills it, and the caller is told "timed out" when the truth
          // is "connection refused". Off, connect() rejects in ~5ms with the real
          // reason -- a better message AND no 5s stall per request when Redis is
          // down.
          const clientOpts = useUrl
            ? { url, socket: { reconnectStrategy: false } }
            : { socket: { host, port, reconnectStrategy: false }, password: password || undefined, database: db };
          const client = redis.createClient(clientOpts);
          client.on("error", () => {});
          await client.connect();
          const cmd = args[0].toUpperCase();
          let result;
          if (cmd === "GET") result = await client.get(args[1]);
          else if (cmd === "SET") result = await client.set(args[1], args[2]);
          else if (cmd === "SETEX") result = await client.setEx(args[1], parseInt(args[2], 10), args[3]);
          else if (cmd === "DEL") result = await client.del(args[1]);
          await client.quit();
          const out = (result === null || result === undefined) ? "__NULL__" : String(result);
          process.stdout.write(out, () => process.exit(0));
        } catch (err) {
          // Exit from the write CALLBACK: stderr to a pipe is an async write and
          // a bare process.exit() truncates it, which left the parent with an
          // empty stderr and nothing but execFileSync's script-dump message.
          process.stderr.write(String((err && err.message) || err), () => process.exit(1));
        }
      })();
    `;
    let result: string;
    try {
      result = execFileSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      // The child's stderr carries the driver's real reason; execFileSync's
      // message carries the whole generated script. Prefer the former.
      throw childFailureError("Redis", err);
    }
    if (result === "__NULL__") return "";       // genuine key miss
    return result;
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
