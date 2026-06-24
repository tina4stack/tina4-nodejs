/**
 * Tina4 synchronous MongoDB transport — used by the MongoDB session handler.
 *
 * The session-handler interface is synchronous, but every Mongo client is async,
 * so a command runs in a short-lived `node -e` child (execFileSync) that blocks
 * the caller until it exits. Two transports, mirroring the Python master's
 * pymongo-first design:
 *
 *   1. The official `mongodb` driver when it resolves (robust, the normal path —
 *      @tina4/orm depends on it, so it is present in any app that uses the ORM).
 *   2. A raw MongoDB wire-protocol (OP_MSG) fallback over node:net with a minimal
 *      BSON codec — zero dependencies.
 *
 * The bugs this replaces (raw path): the old encoder put `$db` FIRST in the command
 * document, so the server read `$db` as the command name and answered
 * CommandNotFound; doubles were written big-endian; arrays/booleans were not encoded
 * at all (so `updates: [{... upsert: true}]` was malformed); and the response was
 * "parsed" by regex-matching `"data":{...}` against binary BSON, which can never
 * match. Here the command name comes first and `$db` last (matching the Python
 * master), the BSON codec is little-endian and handles every type the commands use,
 * and the OP_MSG response is decoded properly (cursor.firstBatch for find, `ok` for
 * writes).
 */
import { execFileSync } from "node:child_process";

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
 * Run a session Mongo command synchronously and return the raw child stdout.
 *
 * - command "find"   -> the matched document as a JSON string, or "__EMPTY__".
 * - command "update" -> "__OK__" (upsert of `{_id, data, last_accessed}`).
 * - command "delete" -> "__OK__".
 *
 * THROWS `<label> command failed: ...` on a transport failure (server unreachable,
 * timeout) OR a Mongo command error (`ok != 1`), so the Session boundary can
 * log-loud + degrade (or re-throw under strict mode).
 */
export function mongoCommandSync(
  target: MongoTarget,
  command: "find" | "update" | "delete",
  args: MongoCommandArgs,
  label = "MongoDB",
): string {
  const script = `
    const net = require("node:net");
    const host = ${JSON.stringify(target.host)};
    const port = ${target.port};
    const database = ${JSON.stringify(target.database)};
    const collection = ${JSON.stringify(target.collection)};
    const command = ${JSON.stringify(command)};
    const args = ${JSON.stringify(args)};

    // ── driver path (preferred — matches the Python master's pymongo-first) ──
    let hasDriver = false;
    try { require.resolve("mongodb"); hasDriver = true; } catch (e) {}

    if (hasDriver) {
      (async () => {
        let client;
        try {
          const { MongoClient } = require("mongodb");
          client = new MongoClient("mongodb://" + host + ":" + port, { serverSelectionTimeoutMS: 4000 });
          await client.connect();
          const coll = client.db(database).collection(collection);
          let out;
          if (command === "find") {
            const doc = await coll.findOne(args.filter);
            out = doc ? JSON.stringify(doc) : "__EMPTY__";
          } else if (command === "update") {
            await coll.updateOne(args.filter, { $set: { data: args.data, last_accessed: args.last_accessed } }, { upsert: true });
            out = "__OK__";
          } else {
            await coll.deleteOne(args.filter);
            out = "__OK__";
          }
          await client.close();
          process.stdout.write(out, () => process.exit(0));
        } catch (err) {
          try { if (client) await client.close(); } catch (e) {}
          process.stderr.write(String((err && err.message) || err));
          process.exit(1);
        }
      })();
    } else {

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

    let cmdDoc;
    if (command === "find") {
      cmdDoc = { find: collection, filter: args.filter, limit: 1, "$db": database };
    } else if (command === "update") {
      const u = { _id: args.filter._id, data: args.data, last_accessed: args.last_accessed };
      cmdDoc = { update: collection, updates: [{ q: args.filter, u: u, upsert: true }], "$db": database };
    } else {
      cmdDoc = { delete: collection, deletes: [{ q: args.filter, limit: 1 }], "$db": database };
    }

    const bodyDoc = encDoc(cmdDoc);
    const section = Buffer.concat([Buffer.from([0]), bodyDoc]); // section kind 0 = body
    const flags = Buffer.alloc(4);                              // flagBits = 0
    const payload = Buffer.concat([flags, section]);
    const header = Buffer.alloc(16);
    header.writeInt32LE(16 + payload.length, 0);                // messageLength
    header.writeInt32LE(1, 4);                                  // requestID
    header.writeInt32LE(0, 8);                                  // responseTo
    header.writeInt32LE(2013, 12);                              // opCode = OP_MSG
    const message = Buffer.concat([header, payload]);

    const sock = net.createConnection({ host, port });
    sock.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} process.stderr.write("timeout"); process.exitCode = 1; } }, 5000);
    function emit(s) {
      if (done) return; done = true; clearTimeout(timer);
      process.stdout.write(s, () => { try { sock.destroy(); } catch (e) {} });
    }
    function fail(msg) {
      if (done) return; done = true; clearTimeout(timer);
      try { sock.destroy(); } catch (e) {}
      process.stderr.write(msg || ""); process.exitCode = 1;
    }
    sock.on("connect", () => sock.write(message));
    sock.on("data", (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      if (buffer.length < 4) return;
      const msgLen = buffer.readInt32LE(0);
      if (buffer.length < msgLen) return;
      let doc;
      try { doc = decDoc(buffer, { i: 21 }); } catch (e) { fail("decode error: " + e.message); return; }
      const ok = doc && (doc.ok === 1 || doc.ok === 1.0);
      if (!ok) { fail("command error: " + ((doc && doc.errmsg) || JSON.stringify(doc))); return; }
      if (command === "find") {
        const batch = (doc.cursor && doc.cursor.firstBatch) || [];
        emit(batch.length ? JSON.stringify(batch[0]) : "__EMPTY__");
      } else {
        emit("__OK__");
      }
    });
    sock.on("error", (err) => fail(err.message));
    sock.on("close", () => { if (!done) fail("connection closed before reply"); });
    }
  `;

  try {
    return execFileSync(process.execPath, ["-e", script], {
      encoding: "utf-8",
      timeout: 8000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(`${label} command failed: ${(err as Error).message}`);
  }
}
