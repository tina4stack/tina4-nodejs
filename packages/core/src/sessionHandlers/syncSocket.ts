/**
 * Tina4 synchronous socket transport — ONE persistent connection per target.
 *
 * Serves the RESP backends (Redis, Valkey) and memcached's text protocol. The
 * sync-over-async plumbing lives in syncBridge; this file is only the socket
 * worker and the two protocol entry points.
 *
 * See syncBridge for WHY: each command used to run in a short-lived `node -e`
 * child, paying a process spawn AND a fresh TCP connection every time (spawn p50
 * 41ms / p99 487ms, connect tail 0.5-0.9s), and that tail tripped the child's
 * deadline under load — the cause of the Valkey session flake.
 *
 * Reconnection is the worker's business: a dropped socket is re-established on
 * the next command rather than surfacing as a caller error.
 */
import {
  getBridge,
  closeBridges,
  DATA_BYTES,
  STATUS_ERROR,
  STATUS_NIL,
  STATUS_OK,
  STATUS_TRANSPORT,
} from "./syncBridge.js";

export interface SyncSocketTarget {
  host: string;
  port: number;
  /** AUTH password (empty/undefined = no AUTH sent). */
  password?: string;
  /** SELECT db index (0/undefined = no SELECT sent). */
  db?: number;
}

/**
 * How long the worker waits for a TCP connection. Deliberately shorter than the
 * bridge's reply timeout so an unreachable host is reported as a connect failure
 * with a useful message, rather than as a generic reply timeout — before this
 * existed, learning a server was down took the full 5s deadline.
 */
const CONNECT_TIMEOUT_MS = 2000;

const SOCKET_WORKER = `
const net = require("node:net");
const target = workerData.target;

let sock = null;
let buffer = Buffer.alloc(0);
let pending = null;

function encodeCommand(args) {
  let out = "*" + args.length + "\\r\\n";
  for (const s of args) out += "$" + Buffer.byteLength(s) + "\\r\\n" + s + "\\r\\n";
  return out;
}

// Parse one RESP value at offset. Returns { value, next } or null when more
// bytes are needed, so a bulk string split across TCP chunks is reassembled
// rather than truncated.
function parse(buf, off) {
  if (off >= buf.length) return null;
  const type = buf[off];
  const crlf = buf.indexOf("\\r\\n", off + 1, "utf-8");
  if (crlf === -1) return null;
  const line = buf.toString("utf-8", off + 1, crlf);
  const after = crlf + 2;
  if (type === 0x2b) return { value: line, next: after };              // '+'
  if (type === 0x3a) return { value: line, next: after };              // ':'
  if (type === 0x2d) return { value: { __err: line }, next: after };   // '-'
  if (type === 0x24) {                                                 // '$'
    const len = parseInt(line, 10);
    if (len === -1) return { value: null, next: after };
    if (after + len + 2 > buf.length) return null;
    return { value: buf.toString("utf-8", after, after + len), next: after + len + 2 };
  }
  if (type === 0x2a) {                                                 // '*'
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

function settle(status, payload) {
  if (!pending) return;
  pending = null;
  __reply(status, payload);
}

function drop(err) {
  // The socket is gone. Fail the in-flight command, then let the NEXT command
  // reconnect - a transient blip must not poison the channel forever.
  try { if (sock) sock.destroy(); } catch (e) {}
  sock = null;
  buffer = Buffer.alloc(0);
  settle(${STATUS_TRANSPORT}, err || "connection lost");
}

function onRespData(chunk) {
  buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
  while (pending) {
    const p = parse(buffer, 0);
    if (!p) break;
    buffer = buffer.subarray(p.next);
    pending.replies.push(p.value);
    if (pending.replies.length < pending.expected) continue;

    // A rejected AUTH/SELECT is surfaced ahead of the command's own reply.
    for (let i = 0; i < pending.expected - 1; i++) {
      const r = pending.replies[i];
      if (r && typeof r === "object" && r.__err !== undefined) { settle(${STATUS_ERROR}, r.__err); return; }
    }
    const result = pending.replies[pending.expected - 1];
    if (result && typeof result === "object" && result.__err !== undefined) settle(${STATUS_ERROR}, result.__err);
    else if (result === null || result === undefined) settle(${STATUS_NIL}, null);
    else settle(${STATUS_OK}, result);
    return;
  }
}

function onTextData(chunk) {
  // Text protocols (memcached) carry no length prefix: the reply is complete
  // when one of the caller's terminators appears.
  buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
  if (!pending) return;
  const text = buffer.toString("utf-8");
  for (const t of pending.terminators) {
    if (text.includes(t)) { buffer = Buffer.alloc(0); settle(${STATUS_OK}, text); return; }
  }
}

function connect(then) {
  const s = net.createConnection({ host: target.host, port: target.port });
  s.setNoDelay(true);
  // An unroutable host neither connects nor errors promptly, so bound it here:
  // otherwise the caller sits out its whole reply deadline for a host that was
  // never going to answer.
  const connectTimer = setTimeout(() => {
    if (sock !== s) { try { s.destroy(); } catch (e) {} drop("connect timed out"); }
  }, ${CONNECT_TIMEOUT_MS});
  s.on("data", (c) => (pending && pending.text ? onTextData(c) : onRespData(c)));
  s.on("error", (e) => { clearTimeout(connectTimer); drop(e.message); });
  s.on("close", () => { clearTimeout(connectTimer); if (sock === s) drop("connection closed"); });
  s.on("connect", () => { clearTimeout(connectTimer); sock = s; then(); });
}

parentPort.on("message", (msg) => {
  // Set pending BEFORE connecting. A connect error (ECONNREFUSED) otherwise
  // arrives with nothing in flight, and the caller blocks for its full reply
  // timeout just to learn the server is down.
  const fresh = !sock;

  if (msg.mode === "text") {
    pending = { text: true, terminators: msg.terminators };
    const writeText = () => {
      try { sock.write(msg.payload, "utf-8"); } catch (e) { drop(e.message); }
    };
    if (sock) writeText(); else { try { connect(writeText); } catch (e) { drop(e.message); } }
    return;
  }

  // The handshake rides with the FIRST command on a fresh connection only;
  // afterwards the connection is already authenticated and selected.
  const handshake = fresh ? ((target.password ? 1 : 0) + (target.db ? 1 : 0)) : 0;
  pending = { expected: 1 + handshake, replies: [] };

  const write = () => {
    let payload = "";
    if (fresh) {
      if (target.password) payload += encodeCommand(["AUTH", target.password]);
      if (target.db) payload += encodeCommand(["SELECT", String(target.db)]);
    }
    payload += encodeCommand(msg.args);
    try { sock.write(payload); } catch (e) { drop(e.message); }
  };

  if (sock) write(); else { try { connect(write); } catch (e) { drop(e.message); } }
});
`;

function socketBridge(target: SyncSocketTarget) {
  const key = `sock:${target.host}:${target.port}:${target.db ?? 0}:${target.password ? "auth" : ""}`;
  return getBridge(key, SOCKET_WORKER, { target });
}

/**
 * Run a single RESP command synchronously and return the reply.
 *
 * - A genuine nil / key-miss returns `""` (callers treat "" as "no session yet").
 * - A transport FAILURE (unreachable, timeout, connection closed) THROWS
 *   `<label> command failed: ...`.
 * - A RESP error reply — including a rejected AUTH/SELECT — THROWS
 *   `<label> error: ...`.
 *
 * The miss/failure split is the whole contract: collapsing them is how a dead
 * backend silently logs every user out instead of surfacing an outage. A dead
 * socket and a healthy server saying "-ERR" are different failures and read
 * differently in a log, so they keep different wording.
 */
export function syncCommand(target: SyncSocketTarget, args: string[], label = "Redis"): string {
  const { status, payload } = socketBridge(target).call({ args }, label);

  if (status === STATUS_NIL) return "";               // genuine key miss
  if (status === STATUS_TRANSPORT) throw new Error(`${label} command failed: ${payload}`);
  if (status === STATUS_ERROR) throw new Error(`${label} error: ${payload}`);
  return payload;
}

/**
 * Run a raw text-protocol command (memcached) over the same persistent channel.
 *
 * The reply is whatever arrived once one of `terminators` appears — a text
 * protocol carries no length prefix, so the caller names its own end markers.
 * Failure semantics match {@link syncCommand}.
 */
export function syncTextCommand(
  target: SyncSocketTarget,
  payload: string,
  terminators: string[],
  label = "Memcached",
): string {
  const reply = socketBridge(target).call({ mode: "text", payload, terminators }, label);
  if (reply.status === STATUS_TRANSPORT) throw new Error(`${label} command failed: ${reply.payload}`);
  return reply.payload;
}

/** Re-exported so callers do not need to know the bridge exists. */
export { closeBridges as closeSyncSockets, DATA_BYTES };
