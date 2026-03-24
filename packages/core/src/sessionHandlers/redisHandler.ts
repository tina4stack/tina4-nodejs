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
import type { SessionHandler } from "../session.js";

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

  /**
   * Execute a Redis command synchronously via a short-lived child process.
   *
   * Attempts to use the `redis` npm package first. If unavailable, falls
   * back to raw TCP (RESP protocol) — same as valkeyHandler.ts.
   */
  private execSync(args: string[]): string {
    const script = `
      const net = require("node:net");
      const host = ${JSON.stringify(this.url || this.host)};
      const port = ${this.port};
      const password = ${JSON.stringify(this.password)};
      const db = ${this.db};
      const useUrl = ${JSON.stringify(!!this.url)};
      const url = ${JSON.stringify(this.url)};
      const args = ${JSON.stringify(args)};

      // Try the redis npm package first
      let redisAvailable = false;
      try {
        require.resolve("redis");
        redisAvailable = true;
      } catch {}

      if (redisAvailable) {
        const redis = require("redis");
        (async () => {
          try {
            const clientOpts = useUrl
              ? { url }
              : { socket: { host, port }, password: password || undefined, database: db };
            const client = redis.createClient(clientOpts);
            client.on("error", () => {});
            await client.connect();

            const cmd = args[0].toUpperCase();
            let result;
            if (cmd === "GET") {
              result = await client.get(args[1]);
            } else if (cmd === "SET") {
              result = await client.set(args[1], args[2]);
            } else if (cmd === "SETEX") {
              result = await client.setEx(args[1], parseInt(args[2], 10), args[3]);
            } else if (cmd === "DEL") {
              result = await client.del(args[1]);
            }
            await client.quit();

            if (result === null || result === undefined) {
              process.stdout.write("__NULL__");
            } else {
              process.stdout.write(String(result));
            }
          } catch (err) {
            process.stderr.write(err.message);
            process.exit(1);
          }
        })();
      } else {
        // Fallback: raw TCP RESP protocol (no redis package needed)
        const actualHost = useUrl ? (() => {
          try { const u = new URL(url); return u.hostname || "127.0.0.1"; } catch { return "127.0.0.1"; }
        })() : host;
        const actualPort = useUrl ? (() => {
          try { const u = new URL(url); return parseInt(u.port, 10) || 6379; } catch { return 6379; }
        })() : port;

        function buildCommand(a) {
          let cmd = "*" + a.length + "\\r\\n";
          for (const s of a) cmd += "$" + Buffer.byteLength(s) + "\\r\\n" + s + "\\r\\n";
          return cmd;
        }

        const sock = net.createConnection({ host: actualHost, port: actualPort }, () => {
          let commands = "";
          if (password) commands += buildCommand(["AUTH", password]);
          if (db !== 0) commands += buildCommand(["SELECT", String(db)]);
          commands += buildCommand(args);
          sock.write(commands);
        });

        let buffer = Buffer.alloc(0);
        sock.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
        });
        sock.on("end", () => {
          const lines = buffer.toString("utf-8").split("\\r\\n");
          let responses = [];
          let i = 0;
          while (i < lines.length) {
            const line = lines[i];
            if (!line) { i++; continue; }
            if (line.startsWith("+") || line.startsWith("-") || line.startsWith(":")) {
              responses.push(line);
              i++;
            } else if (line.startsWith("$")) {
              const len = parseInt(line.slice(1), 10);
              if (len === -1) { responses.push(null); i++; }
              else { responses.push(lines[i+1] || ""); i += 2; }
            } else { i++; }
          }
          const result = responses[responses.length - 1];
          if (result === null) process.stdout.write("__NULL__");
          else if (typeof result === "string" && result.startsWith("-")) process.stdout.write("__ERR__" + result);
          else process.stdout.write(String(result ?? "__NULL__"));
        });
        sock.on("error", (err) => {
          process.stderr.write(err.message);
          process.exit(1);
        });
        setTimeout(() => { sock.destroy(); process.exit(1); }, 3000);
      }
    `;

    try {
      const result = execFileSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (result === "__NULL__") return "";
      if (result.startsWith("__ERR__")) return "";
      return result;
    } catch {
      return "";
    }
  }

  private key(sessionId: string): string {
    return `${this.prefix}${sessionId}`;
  }

  read(sessionId: string): SessionData | null {
    const raw = this.execSync(["GET", this.key(sessionId)]);
    if (!raw) return null;
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
