/**
 * Tina4 Memcached Session Handler — zero-dependency text protocol over TCP.
 *
 * Memcached was already one of the seven CACHE backends in all four frameworks
 * but was NOT a session backend in any of them, even though it is the classic
 * PHP session store. This closes that gap.
 *
 * The SessionHandler interface is synchronous and node:net is async-only, so a
 * command runs in a short-lived `node -e` child (execFileSync) that blocks the
 * caller until it exits — the same transport the Redis/Valkey handlers use (see
 * respClient.ts). The child parses the reply INCREMENTALLY on the "data" event:
 * memcached keeps the connection open after a reply, so waiting for "end" would
 * hang until the timeout.
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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { SessionHandler } from "../session.js";
import { childFailureError } from "./childError.js";

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
   * @param payload Bytes to send
   * @param terminators Any of these ends the reply
   * @throws Error on any transport failure — never swallowed to an empty
   *         result, because for a session an outage must be distinguishable
   *         from "no session yet".
   */
  private command(payload: string, terminators: string[]): string {
    const script = `
      const net = require("node:net");
      const host = ${JSON.stringify(this.host)};
      const port = ${this.port};
      const payload = ${JSON.stringify(payload)};
      const terminators = ${JSON.stringify(terminators)};

      const sock = net.createConnection({ host, port });
      sock.setNoDelay(true);
      let buffer = "";
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch (e) {}
        process.stderr.write("timeout");
        process.exitCode = 1;
      }, 3000);

      function finish(s) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // The write callback guarantees stdout is flushed before exit (a bare
        // process.exit can truncate piped stdout).
        process.stdout.write(s, () => { try { sock.destroy(); } catch (e) {} });
      }
      function fail(msg) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { sock.destroy(); } catch (e) {}
        process.stderr.write(msg || "");
        process.exitCode = 1;
      }

      sock.on("connect", () => sock.write(payload, "binary"));
      sock.on("data", (chunk) => {
        buffer += chunk.toString("binary");
        for (const t of terminators) {
          if (buffer.includes(t)) { finish(buffer); return; }
        }
      });
      sock.on("error", (err) => fail(err.message));
      sock.on("close", () => { if (!done) fail("connection closed before a complete reply"); });
    `;

    try {
      return execFileSync(process.execPath, ["-e", script], {
        encoding: "binary",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }) as unknown as string;
    } catch (err) {
      // Non-zero exit = socket error / timeout / closed connection: a transport
      // FAILURE, not a key miss. Surface it so the Session boundary logs +
      // degrades (or re-throws under strict mode).
      throw childFailureError("Memcached", err);
    }
  }

  read(sessionId: string): SessionData | null {
    const resp = this.command(`get ${this.key(sessionId)}\r\n`, ["END\r\n"]);
    if (!resp.startsWith("VALUE")) return null;   // genuine miss — NOT an error

    const split = resp.indexOf("\r\n");
    if (split === -1) return null;
    const header = resp.slice(0, split).split(" ");
    const bytes = parseInt(header[3] ?? "0", 10);
    const body = Buffer.from(resp.slice(split + 2), "binary").subarray(0, bytes).toString("utf-8");
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
