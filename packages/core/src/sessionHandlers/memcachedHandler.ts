/**
 * Tina4 Memcached Session Handler — zero-dependency text protocol over TCP.
 *
 * Memcached was already one of the seven CACHE backends in all four frameworks
 * but was NOT a session backend in any of them, even though it is the classic
 * PHP session store. This closes that gap.
 *
 * The SessionHandler interface is synchronous and node:net is async-only, so
 * commands go through the shared persistent-connection transport (syncSocket) —
 * one long-lived socket behind a worker thread, the same transport the
 * Redis/Valkey handlers use. Memcached keeps the connection open after a reply
 * and its text protocol carries no length prefix, so the reply is complete when
 * one of the caller's terminators appears.
 *
 * BACKEND-FAILURE POLICY. A genuine key miss returns `null` silently (no session
 * yet is normal). A TRANSPORT failure — server unreachable, connection dropped
 * mid-reply, a protocol error — THROWS, so the Session layer can log-loud and
 * degrade. Collapsing the two is how a dead cache silently logs every user out.
 *
 * Memcached has no persistence and no replication: a restart drops every
 * session. That is a deliberate trade (it is a cache), and it is why
 * file/database remain the defaults.
 *
 * Configure via environment variables:
 *   TINA4_SESSION_MEMCACHED_HOST   (default: "127.0.0.1")
 *   TINA4_SESSION_MEMCACHED_PORT   (default: 11211)
 *   TINA4_SESSION_MEMCACHED_PREFIX (default: "tina4:session:")
 *   TINA4_SESSION_TTL              (default: 3600)
 */
import { createHash } from "node:crypto";
import type { SessionHandler } from "../session.js";
import { syncTextCommand } from "./syncSocket.js";

interface SessionData {
  _created: number;
  _accessed: number;
  [key: string]: unknown;
}

export interface MemcachedSessionConfig {
  host?: string;
  port?: number;
  prefix?: string;
  ttl?: number;
  // Unified SessionConfig fields are tolerated (and ignored) so the central
  // Session can forward its config object without a structural mismatch.
  backend?: string;
  path?: string;
}

/**
 * Memcached rejects a key over 250 bytes or containing a space/control
 * character. A key that could break either rule is HASHED rather than
 * truncated — truncating would let two different sessions collide on one key,
 * handing one user another user's session.
 */
const MAX_KEY_BYTES = 250;

export class MemcachedSessionHandler implements SessionHandler {
  private host: string;
  private port: number;
  private prefix: string;
  private ttl: number;

  constructor(config?: MemcachedSessionConfig) {
    this.host = config?.host ?? process.env.TINA4_SESSION_MEMCACHED_HOST ?? "127.0.0.1";
    this.port =
      config?.port ??
      (process.env.TINA4_SESSION_MEMCACHED_PORT
        ? parseInt(process.env.TINA4_SESSION_MEMCACHED_PORT, 10)
        : 11211);
    this.prefix = config?.prefix ?? process.env.TINA4_SESSION_MEMCACHED_PREFIX ?? "tina4:session:";
    this.ttl =
      config?.ttl ??
      (process.env.TINA4_SESSION_TTL ? parseInt(process.env.TINA4_SESSION_TTL, 10) : 3600);
  }

  private key(sessionId: string): string {
    const candidate = `${this.prefix}${sessionId}`;
    if (Buffer.byteLength(candidate) > MAX_KEY_BYTES || /[\x00-\x20\x7f]/.test(candidate)) {
      return `${this.prefix}${createHash("sha256").update(sessionId).digest("hex")}`;
    }
    return candidate;
  }

  /**
   * Run one memcached command synchronously and return the raw reply.
   *
   * Delegates to the shared persistent-connection transport (syncSocket) rather
   * than spawning a child per command: that cost a process spawn plus a fresh
   * TCP connection every time (p50 41ms, p99 487ms) and its tail tripped the
   * deadline under load — the same defect that made the Valkey session tests
   * flaky, which this handler inherited on the day it was written.
   *
   * @throws Error on any transport failure — never swallowed to an empty
   *         result, because for a session an outage must be distinguishable
   *         from "no session yet".
   */
  private command(payload: string, terminators: string[]): string {
    return syncTextCommand(
      { host: this.host, port: this.port },
      payload,
      terminators,
      "Memcached",
    );
  }

  read(sessionId: string): SessionData | null {
    const resp = this.command(`get ${this.key(sessionId)}\r\n`, ["END\r\n"]);
    if (!resp.startsWith("VALUE")) return null;   // genuine miss — NOT an error

    const split = resp.indexOf("\r\n");
    if (split === -1) return null;
    const header = resp.slice(0, split).split(" ");
    const bytes = parseInt(header[3] ?? "0", 10);
    const body = Buffer.from(resp.slice(split + 2), "utf-8").subarray(0, bytes).toString("utf-8");
    try {
      return JSON.parse(body) as SessionData;
    } catch {
      // A corrupt value is treated as no session rather than crashing the
      // request; the next write replaces it.
      return null;
    }
  }

  write(sessionId: string, data: SessionData, ttl: number): void {
    const effectiveTtl = ttl > 0 ? ttl : this.ttl;
    const json = JSON.stringify(data);
    const bytes = Buffer.byteLength(json);
    const cmd = `set ${this.key(sessionId)} 0 ${effectiveTtl} ${bytes}\r\n`;
    const resp = this.command(`${cmd}${json}\r\n`, [
      "STORED\r\n",
      "ERROR\r\n",
      "SERVER_ERROR",
      "CLIENT_ERROR",
    ]);
    if (!resp.startsWith("STORED")) {
      throw new Error(`Memcached did not store the session: ${resp.slice(0, 80)}`);
    }
  }

  destroy(sessionId: string): void {
    // A session that was already gone is not an error.
    this.command(`delete ${this.key(sessionId)}\r\n`, [
      "DELETED\r\n",
      "NOT_FOUND\r\n",
      "ERROR\r\n",
    ]);
  }

  /** No-op — memcached expires its own keys via the TTL set on write. */
  gc(_maxLifetime: number): void {}
}
