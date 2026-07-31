/**
 * Real-time collaboration — end-to-end, NO-MOCK tests (parity with the Python
 * master's tests/test_realtime.py and the PHP/Ruby realtime suites).
 *
 * Everything here runs against REAL collaborators:
 *   - a REAL SQLite database (a temp file) via initDatabase()
 *   - the REAL framework-owned ORM models (tina4_rt_* tables created for real)
 *   - a REAL HTTP server booted with startServer() (the same entry a live app
 *     uses; it wires user WS routes through serveWebSocketRoute on `upgrade`)
 *   - REAL WebSocket clients speaking the RFC 6455 wire protocol over node:net
 *     (masked client frames out, unmasked server frames in), and REAL HTTP
 *     requests via global fetch (multipart uploads via FormData/Blob).
 *
 * It locks in BOTH framework fixes this feature needed on Node:
 *   1. Router.matchWebSocketWithParams — WS routes now extract `{room}`/`{channel}`
 *      path params into connection.params (previously always {}).
 *   2. Per-room broadcast — connection.joinRoom / getRoomConnections /
 *      broadcastToRoom deliver to room members only, exclude-self honoured.
 *
 * ...plus the realtime surface: ICE config, permissioned file upload/download,
 * secured chat WebSocket with presence roster / message fan-out+persist / typing,
 * and the message-history endpoint.
 *
 * Run with: npx tsx test/realtime.test.ts
 */
import { createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Deterministic, isolated environment BEFORE any framework code runs.
delete process.env.DATABASE_URL; // pre-3.12 unprefixed vars would be refused
delete process.env.SECRET;
delete process.env.TINA4_DEBUG; // no dev toolbar / no second AI port
process.env.TINA4_SECRET = "rt-test-secret";
const dbDir = mkdtempSync(join(tmpdir(), "tina4-rt-"));
process.env.TINA4_DATABASE_URL = "sqlite:///" + join(dbDir, "rt.db");

import { startServer, getToken, Router, defaultRouter } from "../packages/core/src/index.ts";
import { freePort } from "./freePort.ts";
import {
  initDatabase,
  realtime,
  RealtimeWorkspace,
  RealtimeChannel,
  RealtimeChannelMember,
  RealtimeMessage,
} from "../packages/orm/src/index.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("=== Realtime end-to-end tests (real DB + real server + real WS) ===\n");

// ── minimal RFC 6455 client (real wire protocol, zero deps) ─────────────────
interface WsClient {
  status: number;
  messages: string[];
  send(text: string): void;
  close(): void;
  closed: boolean;
}

function encodeMaskedText(text: string): Buffer {
  const payload = Buffer.from(text, "utf-8");
  const len = payload.length;
  const mask = randomBytes(4);
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** Drain complete frames from `buf`; return decoded TEXT payloads + the remainder. */
function drainFrames(buf: Buffer): { texts: string[]; closed: boolean; rest: Buffer } {
  const texts: string[] = [];
  let closed = false;
  let off = 0;
  while (off + 2 <= buf.length) {
    const b1 = buf[off + 1];
    const opcode = buf[off] & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let hdr = 2;
    if (len === 126) {
      if (off + 4 > buf.length) break;
      len = buf.readUInt16BE(off + 2);
      hdr = 4;
    } else if (len === 127) {
      if (off + 10 > buf.length) break;
      len = Number(buf.readBigUInt64BE(off + 2));
      hdr = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (off + hdr + maskLen + len > buf.length) break; // incomplete frame
    let payload = buf.subarray(off + hdr + maskLen, off + hdr + maskLen + len);
    if (masked) {
      const m = buf.subarray(off + hdr, off + hdr + 4);
      const u = Buffer.alloc(len);
      for (let i = 0; i < len; i++) u[i] = payload[i] ^ m[i % 4];
      payload = u;
    }
    if (opcode === 0x1) texts.push(payload.toString("utf-8"));
    else if (opcode === 0x8) closed = true; // CLOSE
    off += hdr + maskLen + len;
  }
  return { texts, closed, rest: buf.subarray(off) };
}

function wsConnect(port: number, path: string, subprotocol?: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let settled = false;
    const messages: string[] = [];
    const client: WsClient = {
      status: 0,
      messages,
      closed: false,
      send: (t: string) => sock.write(encodeMaskedText(t)),
      close: () => sock.destroy(),
    };
    const sock = createConnection({ host: "127.0.0.1", port }, () => {
      let req =
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
      if (subprotocol) req += `Sec-WebSocket-Protocol: ${subprotocol}\r\n`;
      req += "\r\n";
      sock.write(req);
    });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error(`ws connect timeout: ${path}`));
      }
    }, 4000);
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = buf.subarray(0, idx).toString();
        client.status = parseInt(head.split("\r\n")[0].split(" ")[1] ?? "0", 10);
        upgraded = true;
        buf = buf.subarray(idx + 4);
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(client);
        }
        if (client.status !== 101) return;
      }
      if (client.status === 101) {
        const { texts, closed, rest } = drainFrames(buf);
        for (const t of texts) messages.push(t);
        if (closed) client.closed = true;
        buf = rest;
      }
    });
    sock.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(client); // let the caller inspect status/closed
      }
    });
    sock.on("close", () => {
      client.closed = true;
    });
  });
}

/** Poll a client's message list for the first frame whose parsed JSON matches. */
async function waitForMsg(
  client: WsClient,
  match: (m: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown> | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const raw of client.messages) {
      try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        if (match(obj)) return obj;
      } catch {
        /* not json */
      }
    }
    await sleep(40);
  }
  return null;
}

// ── boot: real DB, real realtime mount, real seed, real server ──────────────
await initDatabase({ url: process.env.TINA4_DATABASE_URL });
const paths = await realtime({ features: ["calls", "chat", "files"] });

// Seed workspace + two channels. Channel 1: members "1" & "2". Channel 2: member "1" only.
const ws = new RealtimeWorkspace({ name: "Test Co", created_at: "2026-07-08T00:00:00Z" });
await ws.save();
async function seedChannel(name: string, members: string[]): Promise<number> {
  const c = new RealtimeChannel({
    workspace_id: (ws as any).id,
    name,
    kind: "public",
    created_at: "2026-07-08T00:00:00Z",
  });
  await c.save();
  const cid = (c as any).id as number;
  for (const uid of members) {
    await new RealtimeChannelMember({ channel_id: cid, user_id: uid, role: uid === members[0] ? "owner" : "member" }).save();
  }
  return cid;
}
const CH1 = await seedChannel("general", ["1", "2"]);
const CH2 = await seedChannel("private", ["1"]);

const srv = await startServer({ port: await freePort(), host: "127.0.0.1" });
const port = srv.port;
const base = `http://127.0.0.1:${port}`;
const tok = (user: number) => getToken({ user_id: user });

try {
  // ── framework fix 1: WS route param extraction (unit, real Router) ────────
  console.log("--- framework fix: WS {param} matching ---");
  {
    const m = Router.matchWebSocketWithParams(`${paths.signalling}/room-42`);
    assert("rtc WS route matches and extracts {room}", m?.params.room === "room-42", JSON.stringify(m?.params));
    const c = Router.matchWebSocketWithParams(`${paths.chat}/${CH1}`);
    assert("chat WS route matches and extracts {channel}", c?.params.channel === String(CH1), JSON.stringify(c?.params));
  }

  // ── config endpoint ───────────────────────────────────────────────────────
  console.log("\n--- config endpoint ---");
  {
    const r = await fetch(`${base}/api/rtc/config`);
    const body = (await r.json()) as any;
    assert("config 200", r.status === 200);
    assert("config backend=mesh", body.backend === "mesh");
    assert("config has iceServers array", Array.isArray(body.iceServers) && body.iceServers.length >= 1);
    assert("config signalling path is per-room", typeof body.signalling === "string" && body.signalling.endsWith("/{room}"));
    assert("config advertises chat + messages + files", !!body.chat && !!body.messages && !!body.files);
  }

  // ── framework fix 2: per-room signalling relay (real WS, public route) ─────
  console.log("\n--- calls: mesh signalling relay is per-room ---");
  {
    const a = await wsConnect(port, `${paths.signalling}/room-A`);
    const b = await wsConnect(port, `${paths.signalling}/room-A`);
    const c = await wsConnect(port, `${paths.signalling}/room-B`);
    assert("rtc peers upgraded (101)", a.status === 101 && b.status === 101 && c.status === 101);
    await sleep(120); // let all three join their rooms
    a.send(JSON.stringify({ type: "offer", sdp: "x" }));
    const got = await waitForMsg(b, (m) => m.type === "offer" && m.sdp === "x");
    assert("peer B in the same room receives A's offer", got !== null);
    assert("sender A does NOT receive its own offer (exclude self)", a.messages.every((m) => !m.includes('"offer"')));
    await sleep(150);
    assert("peer C in a DIFFERENT room receives nothing (room isolation)", c.messages.length === 0);
    a.close();
    b.close();
    c.close();
  }

  // ── files: permissioned upload + download (real multipart over fetch) ──────
  console.log("\n--- files: permissioned upload + download ---");
  let uploadedKey = "";
  {
    const form = new FormData();
    form.set("channel_id", String(CH1));
    form.set("file", new Blob([Buffer.from("tina4-realtime-file-bytes")], { type: "text/plain" }), "note.txt");

    const noTok = await fetch(`${base}/api/files`, { method: "POST", body: form });
    assert("upload without a token is 401", noTok.status === 401);

    const form2 = new FormData();
    form2.set("file", new Blob([Buffer.from("x")], { type: "text/plain" }), "x.txt");
    const noChan = await fetch(`${base}/api/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok(1)}` },
      body: form2,
    });
    assert("upload without channel_id is 400", noChan.status === 400);

    const form3 = new FormData();
    form3.set("channel_id", String(CH1));
    form3.set("file", new Blob([Buffer.from("tina4-realtime-file-bytes")], { type: "text/plain" }), "note.txt");
    const ok = await fetch(`${base}/api/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok(1)}` },
      body: form3,
    });
    const saved = (await ok.json()) as any;
    uploadedKey = saved.key;
    assert("member upload is 201", ok.status === 201);
    assert("upload returns a storage key + size", typeof uploadedKey === "string" && saved.size === 25);
  }
  {
    const withTok = await fetch(`${base}/api/files/${uploadedKey}`, { headers: { Authorization: `Bearer ${tok(1)}` } });
    const text = await withTok.text();
    assert("member download is 200", withTok.status === 200);
    assert("download returns the exact stored bytes", text === "tina4-realtime-file-bytes");

    const noTok = await fetch(`${base}/api/files/${uploadedKey}`);
    assert("download without a token is 401", noTok.status === 401);

    const nonMember = await fetch(`${base}/api/files/${uploadedKey}`, { headers: { Authorization: `Bearer ${tok(9)}` } });
    assert("download by a non-member is 403", nonMember.status === 403);
  }

  // ── chat: secured WS presence + fan-out + persist + typing (real WS) ───────
  console.log("\n--- chat: presence, fan-out, persist, typing ---");
  {
    const u1 = await wsConnect(port, `${paths.chat}/${CH1}`, `bearer, ${tok(1)}`);
    assert("chat WS user 1 upgraded (101)", u1.status === 101);
    const roster1 = await waitForMsg(u1, (m) => m.type === "presence" && m.event === "roster");
    assert("user 1 receives a presence roster on open", roster1 !== null && Array.isArray(roster1?.users));

    const u2 = await wsConnect(port, `${paths.chat}/${CH1}`, `bearer, ${tok(2)}`);
    assert("chat WS user 2 upgraded (101)", u2.status === 101);
    const roster2 = await waitForMsg(u2, (m) => m.type === "presence" && m.event === "roster");
    assert(
      "user 2 roster contains both members [1,2]",
      JSON.stringify((roster2?.users as string[])?.slice().sort()) === '["1","2"]',
      JSON.stringify(roster2?.users),
    );
    const joinEvt = await waitForMsg(u1, (m) => m.type === "presence" && m.event === "join" && m.user_id === "2");
    assert("user 1 sees a presence join for user 2", joinEvt !== null);

    // user 1 sends a message; BOTH users receive it (fan-out INCLUDING sender).
    u1.send(JSON.stringify({ type: "message", body: "hello-realtime" }));
    const gotAt2 = await waitForMsg(u2, (m) => m.type === "message" && (m.message as any)?.body === "hello-realtime");
    const gotAt1 = await waitForMsg(u1, (m) => m.type === "message" && (m.message as any)?.body === "hello-realtime");
    assert("recipient user 2 receives the chat message", gotAt2 !== null);
    assert("sender user 1 also receives the message (fan-out incl. sender)", gotAt1 !== null);
    assert("delivered message carries a persisted id", Number((gotAt2?.message as any)?.id) > 0);

    // persisted for real — read it straight from the DB via the ORM.
    const rows = (await RealtimeMessage.where("channel_id = ? AND body = ?", [CH1, "hello-realtime"])) as any[];
    assert("message row persisted in tina4_rt_messages", rows.length === 1 && rows[0].user_id === "1");

    // typing indicator fans out to the OTHER member only.
    u2.send(JSON.stringify({ type: "typing" }));
    const typing = await waitForMsg(u1, (m) => m.type === "typing" && m.user_id === "2");
    assert("typing indicator relayed to the other member", typing !== null);

    u1.close();
    u2.close();
  }

  // ── chat: a non-member is refused on open ──────────────────────────────────
  console.log("\n--- chat: non-member refused ---");
  {
    const intruder = await wsConnect(port, `${paths.chat}/${CH1}`, `bearer, ${tok(9)}`);
    // valid JWT so the upgrade is accepted, but the open handler rejects a non-member.
    assert("non-member upgrade accepted (valid JWT)", intruder.status === 101);
    const err = await waitForMsg(intruder, (m) => m.type === "error");
    assert("non-member receives an error frame then is closed", err !== null);
    await sleep(120);
    assert("non-member socket was closed by the server", intruder.closed === true);
    intruder.close();
  }

  // ── message history endpoint (membership-gated) ────────────────────────────
  console.log("\n--- messages history endpoint ---");
  {
    const member = await fetch(`${base}/api/channels/${CH1}/messages`, { headers: { Authorization: `Bearer ${tok(1)}` } });
    const list = (await member.json()) as any[];
    assert("member history is 200", member.status === 200);
    assert("history returns the persisted message", Array.isArray(list) && list.some((m) => m.body === "hello-realtime"));

    const nonMember = await fetch(`${base}/api/channels/${CH1}/messages`, { headers: { Authorization: `Bearer ${tok(9)}` } });
    assert("non-member history is 403", nonMember.status === 403);

    const noTok = await fetch(`${base}/api/channels/${CH1}/messages`);
    assert("history without a token is 401", noTok.status === 401);
  }
} finally {
  srv.close();
  defaultRouter.clear();
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
