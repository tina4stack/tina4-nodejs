/**
 * Tina4 synchronous RESP transport — shared by every Redis/Valkey session handler.
 *
 * The session-handler interface is synchronous, but node:net is async-only, so a
 * command runs in a short-lived `node -e` child (execFileSync) that blocks the
 * caller until it exits. This module is the ONE correct implementation of that
 * child; the Redis/Valkey handlers delegate here instead of inlining their own.
 *
 * The bug this replaces: the old child parsed the reply on the socket "end" event.
 * Redis/Valkey keep the connection OPEN after a reply (they never half-close for a
 * GET/SET/DEL), so "end" never fires — the child waited out its timeout, exited
 * non-zero, and execFileSync re-threw it as a "transport failure". EVERY command
 * failed against a reachable server. Here the child parses replies INCREMENTALLY on
 * the "data" event (the same proven RESP parser cache.ts's RespClient uses): it
 * reads exactly the replies it sent commands for (AUTH? + SELECT? + the command),
 * then returns the LAST (command) reply.
 */
import { execFileSync } from "node:child_process";
import { childFailureError } from "./childError.js";

export interface RespTarget {
  host: string;
  port: number;
  /** AUTH password (empty/undefined = no AUTH sent). */
  password?: string;
  /** SELECT db index (0/undefined = no SELECT sent). */
  db?: number;
}

/**
 * Run a single RESP command synchronously against host:port and return the reply.
 *
 * - A genuine nil / key-miss returns `""` (callers treat "" as "no session yet").
 * - A transport FAILURE (server unreachable, timeout, connection closed before a
 *   reply) THROWS `<label> command failed: ...`.
 * - A RESP error reply — including a rejected AUTH/SELECT handshake — THROWS
 *   `<label> error: ...`. A rejected handshake is a transport failure, not a
 *   result, so it is surfaced ahead of the command reply.
 *
 * Session values are JSON strings (they start with `{`), so they never collide
 * with the `__NULL__` / `__ERR__` sentinels the child uses on stdout.
 */
export function respCommandSync(target: RespTarget, args: string[], label = "Redis"): string {
  const host = target.host;
  const port = target.port;
  const password = target.password ?? "";
  const db = target.db ?? 0;

  const script = `
    const net = require("node:net");
    const host = ${JSON.stringify(host)};
    const port = ${port};
    const password = ${JSON.stringify(password)};
    const db = ${db};
    const args = ${JSON.stringify(args)};
    // Replies to consume = AUTH? + SELECT? + the command. The LAST is our result.
    const expected = (password ? 1 : 0) + (db !== 0 ? 1 : 0) + 1;

    function encode(a) {
      let c = "*" + a.length + "\\r\\n";
      for (const s of a) c += "$" + Buffer.byteLength(s) + "\\r\\n" + s + "\\r\\n";
      return c;
    }

    // Parse one RESP value at offset. Returns { value, next } or null if more bytes
    // are needed (so a bulk string split across TCP chunks is handled correctly).
    function parse(buf, off) {
      if (off >= buf.length) return null;
      const type = buf[off];
      const crlf = buf.indexOf("\\r\\n", off + 1, "utf-8");
      if (crlf === -1) return null;
      const line = buf.toString("utf-8", off + 1, crlf);
      const after = crlf + 2;
      if (type === 0x2b) return { value: line, next: after };             // '+' simple string
      if (type === 0x3a) return { value: line, next: after };             // ':' integer
      if (type === 0x2d) return { value: { __err: line }, next: after };  // '-' error
      if (type === 0x24) {                                                // '$' bulk string
        const len = parseInt(line, 10);
        if (len === -1) return { value: null, next: after };
        if (after + len + 2 > buf.length) return null;
        return { value: buf.toString("utf-8", after, after + len), next: after + len + 2 };
      }
      if (type === 0x2a) {                                                // '*' array
        const count = parseInt(line, 10);
        if (count === -1) return { value: null, next: after };
        const arr = [];
        let pos = after;
        for (let i = 0; i < count; i++) {
          const el = parse(buf, pos);
          if (!el) return null;
          arr.push(el.value);
          pos = el.next;
        }
        return { value: arr, next: pos };
      }
      return { value: line, next: after };
    }

    const sock = net.createConnection({ host, port });
    sock.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    const replies = [];
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} process.stderr.write("timeout"); process.exitCode = 1; } }, 3000);

    function emit(s) {
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

    sock.on("connect", () => {
      let cmds = "";
      if (password) cmds += encode(["AUTH", password]);
      if (db !== 0) cmds += encode(["SELECT", String(db)]);
      cmds += encode(args);
      sock.write(cmds);
    });
    sock.on("data", (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (true) {
        const p = parse(buffer, 0);
        if (!p) break;
        buffer = buffer.subarray(p.next);
        replies.push(p.value);
        if (replies.length < expected) continue;
        // A rejected AUTH/SELECT is a transport failure — surface it first.
        for (let i = 0; i < expected - 1; i++) {
          const r = replies[i];
          if (r && typeof r === "object" && r.__err !== undefined) { emit("__ERR__" + r.__err); return; }
        }
        const result = replies[expected - 1];
        if (result && typeof result === "object" && result.__err !== undefined) emit("__ERR__" + result.__err);
        else if (result === null || result === undefined) emit("__NULL__");
        else emit(String(result));
        return;
      }
    });
    sock.on("error", (err) => fail(err.message));
    sock.on("close", () => { if (!done) fail("connection closed before reply"); });
  `;

  let result: string;
  try {
    result = execFileSync(process.execPath, ["-e", script], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    // Non-zero exit = socket error / timeout / closed connection: a transport
    // FAILURE, not a key miss. Surface it so the Session boundary logs + degrades
    // (or re-throws under strict mode).
    //
    // Report the CHILD's stderr, not execFileSync's message -- that message
    // embeds the whole generated script and buries the actual reason.
    throw childFailureError(label, err);
  }
  if (result === "__NULL__") return "";       // genuine key miss
  if (result.startsWith("__ERR__")) {
    throw new Error(`${label} error: ${result.slice("__ERR__".length)}`);
  }
  return result;
}
