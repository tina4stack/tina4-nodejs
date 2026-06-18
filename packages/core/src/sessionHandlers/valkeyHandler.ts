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
import { execFileSync } from "node:child_process";
import type { SessionHandler } from "../session.js";

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
   * Execute a RESP command synchronously via a short-lived TCP connection.
   *
   * Returns the command result string. A genuine key miss yields `""`. A
   * transport/connection FAILURE (server unreachable, AUTH error, timeout)
   * THROWS so the Session boundary can distinguish "not found" (silent) from
   * "backend failed" (log-loud + degrade). Backend-failure policy parity.
   */
  private execSync(args: string[]): string {
    const script = `
      const net = require("node:net");
      const host = ${JSON.stringify(this.host)};
      const port = ${this.port};
      const password = ${JSON.stringify(this.password)};
      const db = ${this.db};
      const args = ${JSON.stringify(args)};

      function buildCommand(a) {
        let cmd = "*" + a.length + "\\r\\n";
        for (const s of a) cmd += "$" + Buffer.byteLength(s) + "\\r\\n" + s + "\\r\\n";
        return cmd;
      }

      function parseResp(buf) {
        const str = buf.toString("utf-8");
        if (str.startsWith("+")) return str.slice(1).split("\\r\\n")[0];
        if (str.startsWith("-")) return "ERR:" + str.slice(1).split("\\r\\n")[0];
        if (str.startsWith(":")) return str.slice(1).split("\\r\\n")[0];
        if (str.startsWith("$-1")) return null;
        if (str.startsWith("$")) {
          const nl = str.indexOf("\\r\\n");
          const len = parseInt(str.slice(1, nl), 10);
          const start = nl + 2;
          return str.slice(start, start + len);
        }
        return str;
      }

      const sock = net.createConnection({ host, port }, () => {
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
        // Parse last response (skip AUTH/SELECT responses)
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
        // The last response is our actual command result
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
    `;

    let result: string;
    try {
      result = execFileSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      // Non-zero exit = the child hit a socket error / AUTH failure / timeout.
      // That is a transport FAILURE, not a key miss — surface it so the
      // Session boundary logs + degrades (or re-throws under strict mode).
      throw new Error(`Valkey command failed: ${(err as Error).message}`);
    }
    if (result === "__NULL__") return "";        // genuine key miss
    if (result.startsWith("__ERR__")) {
      throw new Error(`Valkey error: ${result.slice("__ERR__".length)}`);
    }
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
