/**
 * Tina4 synchronous MongoDB transport — ONE persistent client per target.
 *
 * The session-handler interface is synchronous but every Mongo client is async,
 * so this rides the shared sync-over-async bridge (syncBridge): a Worker thread
 * keeps its own event loop and holds the connection, the caller blocks in
 * Atomics.wait until the worker answers through a SharedArrayBuffer.
 *
 * WHY IT CHANGED. Each command used to run in a short-lived `node -e` child, so
 * every session read or write paid a process spawn AND a `require("mongodb")`
 * AND a fresh connection handshake. Measured on this machine that was p50 230ms
 * per session write+read — by far the worst of the four backends (Valkey on the
 * same bridge is p50 10.5ms), and the same class of defect that made the Valkey
 * session tests flaky. The client is now created once and reused.
 *
 * Two transports are kept, mirroring the Python master's pymongo-first design:
 *
 *   1. The official `mongodb` driver when it resolves (the normal path —
 *      @tina4/orm depends on it, so it is present in any app that uses the ORM).
 *   2. A raw MongoDB wire-protocol (OP_MSG) fallback over node:net with a
 *      minimal BSON codec — zero dependencies.
 *
 * The raw path's hard-won details are preserved exactly: the command name comes
 * FIRST and `$db` LAST (putting `$db` first made the server read it as the
 * command name and answer CommandNotFound), the BSON codec is little-endian and
 * encodes arrays/booleans/doubles properly, and the OP_MSG response is decoded
 * rather than regex-matched against binary.
 */
import {
  getBridge,
  STATUS_ERROR,
  STATUS_NIL,
  STATUS_OK,
  STATUS_TRANSPORT,
} from "./syncBridge.js";

export interface MongoTarget {
  host: string;
  port: number;
  database: string;
  collection: string;
}

/** Command args: `filter` (always), plus `data`/`last_accessed` for an update. */
export interface MongoCommandArgs {
  filter: Record<string, unknown>;
  data?: unknown;
  last_accessed?: number;
}

/**
 * Server-selection budget for the driver. Kept BELOW the bridge's reply timeout
 * so an unreachable server is reported as a Mongo connection failure with a real
 * message, rather than surfacing as the caller's generic reply timeout.
 */
const SERVER_SELECTION_MS = 3000;

const MONGO_WORKER = `
const net = require("node:net");
const target = workerData.target;
const host = target.host;
const port = target.port;
const database = target.database;
const collection = target.collection;

// TINA4_MONGO_FORCE_RAW selects the zero-dep wire-protocol path even where the
// driver IS installed. Without it the raw fallback can never be exercised on a
// machine that has mongodb (which is every machine using @tina4/orm), so the
// zero-dependency path would ship untested. This selects a REAL code path
// against a REAL server - it is not a stub.
let hasDriver = false;
if (!workerData.forceRaw) {
  try { require.resolve("mongodb"); hasDriver = true; } catch (e) {}
}

// ── driver path (preferred — matches the Python master's pymongo-first) ──
// The client is created ONCE and reused. Creating and closing one per command
// was the whole cost: a driver load plus a handshake on every session read.
let client = null;
let coll = null;

async function driverCall(command, args) {
  try {
    if (!coll) {
      const { MongoClient } = require("mongodb");
      client = new MongoClient("mongodb://" + host + ":" + port, { serverSelectionTimeoutMS: ${SERVER_SELECTION_MS} });
      await client.connect();
      coll = client.db(database).collection(collection);
    }
    if (command === "find") {
      const doc = await coll.findOne(args.filter);
      // A genuine miss is NOT a failure - it is "no session yet".
      if (!doc) { __reply(${STATUS_NIL}, null); return; }
      __reply(${STATUS_OK}, JSON.stringify(doc));
      return;
    }
    if (command === "update") {
      await coll.updateOne(
        args.filter,
        { $set: { data: args.data, last_accessed: args.last_accessed } },
        { upsert: true },
      );
    } else {
      await coll.deleteOne(args.filter);
    }
    __reply(${STATUS_OK}, "__OK__");
  } catch (err) {
    // Drop the client so the NEXT command reconnects - a transient blip must
    // not poison the channel forever.
    try { if (client) await client.close(); } catch (e) {}
    client = null;
    coll = null;
    __reply(${STATUS_TRANSPORT}, String((err && err.message) || err));
  }
}

// ── raw OP_MSG fallback (zero-dep, mirrors the Python master codec) ──
function encElem(key, value) {
  const ck = Buffer.concat([Buffer.from(key, "utf-8"), Buffer.from([0])]);
  if (value === null || value === undefined) return Buffer.concat([Buffer.from([0x0a]), ck]);
  if (typeof value === "boolean") return Buffer.concat([Buffer.from([0x08]), ck, Buffer.from([value ? 1 : 0])]);
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
      const b = Buffer.alloc(4); b.writeInt32LE(value, 0);
      return Buffer.concat([Buffer.from([0x10]), ck, b]);
    }
    if (Number.isInteger(value)) {
      const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value), 0);
      return Buffer.concat([Buffer.from([0x12]), ck, b]);
    }
    const b = Buffer.alloc(8); b.writeDoubleLE(value, 0);
    return Buffer.concat([Buffer.from([0x01]), ck, b]);
  }
  if (typeof value === "string") {
    const s = Buffer.from(value, "utf-8");
    const len = Buffer.alloc(4); len.writeInt32LE(s.length + 1, 0);
    return Buffer.concat([Buffer.from([0x02]), ck, len, s, Buffer.from([0])]);
  }
  if (Array.isArray(value)) {
    const indexed = {};
    value.forEach((v, i) => { indexed[String(i)] = v; });
    return Buffer.concat([Buffer.from([0x04]), ck, encDoc(indexed)]);
  }
  if (typeof value === "object") return Buffer.concat([Buffer.from([0x03]), ck, encDoc(value)]);
  const s = Buffer.from(String(value), "utf-8");
  const len = Buffer.alloc(4); len.writeInt32LE(s.length + 1, 0);
  return Buffer.concat([Buffer.from([0x02]), ck, len, s, Buffer.from([0])]);
}
function encDoc(obj) {
  let body = Buffer.alloc(0);
  for (const k of Object.keys(obj)) body = Buffer.concat([body, encElem(k, obj[k])]);
  body = Buffer.concat([body, Buffer.from([0])]);
  const out = Buffer.alloc(4 + body.length);
  out.writeInt32LE(out.length, 0);
  body.copy(out, 4);
  return out;
}
function decDoc(buf, pos) {
  const docLen = buf.readInt32LE(pos.i); pos.i += 4;
  const end = pos.i + docLen - 5;
  const doc = {};
  while (pos.i < end) {
    const type = buf[pos.i]; pos.i += 1;
    const keyEnd = buf.indexOf(0, pos.i);
    const key = buf.toString("utf-8", pos.i, keyEnd);
    pos.i = keyEnd + 1;
    doc[key] = decVal(buf, pos, type, end);
  }
  pos.i += 1;
  return doc;
}
function decVal(buf, pos, type, end) {
  if (type === 0x01) { const v = buf.readDoubleLE(pos.i); pos.i += 8; return v; }
  if (type === 0x02) { const len = buf.readInt32LE(pos.i); pos.i += 4; const v = buf.toString("utf-8", pos.i, pos.i + len - 1); pos.i += len; return v; }
  if (type === 0x03) return decDoc(buf, pos);
  if (type === 0x04) { const d = decDoc(buf, pos); return Object.keys(d).map((k) => d[k]); }
  if (type === 0x05) { const len = buf.readInt32LE(pos.i); pos.i += 4; pos.i += 1; const v = buf.subarray(pos.i, pos.i + len); pos.i += len; return v; }
  if (type === 0x07) { const v = buf.toString("hex", pos.i, pos.i + 12); pos.i += 12; return v; }
  if (type === 0x08) { const v = buf[pos.i] !== 0; pos.i += 1; return v; }
  if (type === 0x09) { const v = Number(buf.readBigInt64LE(pos.i)); pos.i += 8; return v; }
  if (type === 0x0a) return null;
  if (type === 0x10) { const v = buf.readInt32LE(pos.i); pos.i += 4; return v; }
  if (type === 0x11) { const v = Number(buf.readBigUInt64LE(pos.i)); pos.i += 8; return v; }
  if (type === 0x12) { const v = Number(buf.readBigInt64LE(pos.i)); pos.i += 8; return v; }
  // Unknown type: cannot size it — stop at the document boundary to avoid a loop.
  pos.i = end;
  return null;
}

let sock = null;
let buffer = Buffer.alloc(0);
let pending = null;    // { command }
let requestId = 0;

function settle(status, payload) {
  if (!pending) return;
  pending = null;
  __reply(status, payload);
}

function drop(err) {
  try { if (sock) sock.destroy(); } catch (e) {}
  sock = null;
  buffer = Buffer.alloc(0);
  settle(${STATUS_TRANSPORT}, err || "connection lost");
}

function onData(chunk) {
  buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
  if (!pending) return;
  if (buffer.length < 4) return;
  const msgLen = buffer.readInt32LE(0);
  if (buffer.length < msgLen) return;         // OP_MSG split across TCP chunks

  const frame = buffer.subarray(0, msgLen);
  buffer = buffer.subarray(msgLen);

  let doc;
  // 16 header + 4 flagBits + 1 section kind = 21
  try { doc = decDoc(frame, { i: 21 }); } catch (e) { settle(${STATUS_TRANSPORT}, "decode error: " + e.message); return; }

  const ok = doc && (doc.ok === 1 || doc.ok === 1.0);
  if (!ok) { settle(${STATUS_ERROR}, "command error: " + ((doc && doc.errmsg) || JSON.stringify(doc))); return; }

  if (pending.command === "find") {
    const batch = (doc.cursor && doc.cursor.firstBatch) || [];
    if (!batch.length) { settle(${STATUS_NIL}, null); return; }
    settle(${STATUS_OK}, JSON.stringify(batch[0]));
    return;
  }
  settle(${STATUS_OK}, "__OK__");
}

function buildMessage(command, args) {
  let cmdDoc;
  // The command name FIRST and $db LAST. Reversed, the server reads $db as the
  // command name and answers CommandNotFound.
  if (command === "find") {
    cmdDoc = { find: collection, filter: args.filter, limit: 1, "$db": database };
  } else if (command === "update") {
    const u = { _id: args.filter._id, data: args.data, last_accessed: args.last_accessed };
    cmdDoc = { update: collection, updates: [{ q: args.filter, u: u, upsert: true }], "$db": database };
  } else {
    cmdDoc = { delete: collection, deletes: [{ q: args.filter, limit: 1 }], "$db": database };
  }

  const bodyDoc = encDoc(cmdDoc);
  const section = Buffer.concat([Buffer.from([0]), bodyDoc]);   // section kind 0 = body
  const flags = Buffer.alloc(4);                                // flagBits = 0
  const payload = Buffer.concat([flags, section]);
  const header = Buffer.alloc(16);
  requestId += 1;
  header.writeInt32LE(16 + payload.length, 0);                  // messageLength
  header.writeInt32LE(requestId, 4);                            // requestID
  header.writeInt32LE(0, 8);                                    // responseTo
  header.writeInt32LE(2013, 12);                                // opCode = OP_MSG
  return Buffer.concat([header, payload]);
}

function connect(then) {
  const s = net.createConnection({ host: host, port: port });
  s.setNoDelay(true);
  const connectTimer = setTimeout(() => {
    if (sock !== s) { try { s.destroy(); } catch (e) {} drop("connect timed out"); }
  }, ${SERVER_SELECTION_MS});
  s.on("data", onData);
  s.on("error", (e) => { clearTimeout(connectTimer); drop(e.message); });
  s.on("close", () => { clearTimeout(connectTimer); if (sock === s) drop("connection closed"); });
  s.on("connect", () => { clearTimeout(connectTimer); sock = s; then(); });
}

function rawCall(command, args) {
  // Set pending BEFORE connecting: a connect error otherwise arrives with
  // nothing in flight and the caller blocks for its whole reply timeout.
  pending = { command: command };
  const write = () => {
    try { sock.write(buildMessage(command, args)); } catch (e) { drop(e.message); }
  };
  if (sock) write(); else { try { connect(write); } catch (e) { drop(e.message); } }
}

parentPort.on("message", (msg) => {
  if (hasDriver) void driverCall(msg.command, msg.args);
  else rawCall(msg.command, msg.args);
});
`;

/**
 * Run a session Mongo command synchronously.
 *
 * - command "find"   -> the matched document as a JSON string, or "__EMPTY__".
 * - command "update" -> "__OK__" (upsert of `{_id, data, last_accessed}`).
 * - command "delete" -> "__OK__".
 *
 * THROWS `<label> command failed: ...` on a transport failure (server
 * unreachable, timeout) OR a Mongo command error (`ok != 1`), so the Session
 * boundary can log-loud + degrade (or re-throw under strict mode). A genuine
 * miss is NOT a failure and comes back as "__EMPTY__" — collapsing the two is
 * how a dead backend silently logs every user out.
 */
export function mongoCommandSync(
  target: MongoTarget,
  command: "find" | "update" | "delete",
  args: MongoCommandArgs,
  label = "MongoDB",
): string {
  const key = `mongo:${target.host}:${target.port}:${target.database}:${target.collection}`;
  const forceRaw = process.env.TINA4_MONGO_FORCE_RAW ? 1 : 0;
  const { status, payload } = getBridge(
    `${key}:${forceRaw ? "raw" : "drv"}`,
    MONGO_WORKER,
    { target, forceRaw },
  ).call({ command, args }, label);

  if (status === STATUS_NIL) return "__EMPTY__";        // genuine miss, not an error
  if (status === STATUS_TRANSPORT || status === STATUS_ERROR) {
    throw new Error(`${label} command failed: ${payload}`);
  }
  return payload;
}
