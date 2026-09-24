/**
 * Lock-in tests for the WebSocket + SSE hardening sweep (Node parity with the
 * Python master, commit f5c8f85). NO DOUBLES: real WebSocketServer instances
 * on real ports, real clients over real sockets, and a real Redis backplane.
 *
 * This file used to prove the cross-instance relay with an in-memory
 * FakeBackplane and fake client sockets written into the server's private
 * client map. A fake bus proves the manager talks to the fake, not that two
 * servers relay through Redis; it is now two servers relaying through the lab
 * Redis, with an independent Redis subscriber counting what really went over
 * the channel.
 *
 *   - Backplane relay across two real instances + origin guard (no echo, no loop)
 *   - bytes round-trip through the envelope (base64), room relay targeting
 *   - broadcast resilience (a client that vanished never aborts delivery; it is pruned)
 *   - slow-client backpressure (a client that never reads is dropped)
 *   - origin allow-list semantics (empty=allow, set=reject)
 *   - idle reaper (disabled=no-op, set=closes only the stale connection)
 *
 * Needs TINA4_TEST_REDIS_URL (default redis://127.0.0.1:6379) for the relay
 * section; without it that section SKIPs loudly (a failure under
 * TINA4_REQUIRE_SERVICES).
 *
 * Run with: npx tsx test/websocketHardening.test.ts
 */
import net from "node:net";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import {
  WebSocketServer,
  WsBackplaneManager,
  buildEnvelope,
  originAllowed,
  WS_BACKPLANE_CHANNEL,
} from "../packages/core/src/index.ts";
import type { WsEnvelope } from "../packages/core/src/index.ts";

let pass = 0;
let fail = 0;
let skipped = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function skip(name: string, reason: string) {
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} — ${reason}`);
  skipped++;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(20);
  }
  return condition();
}

function reachable(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port: Number(port || 6379) });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}

/** Start a real server on an ephemeral port and return it with that port. */
async function startServer(): Promise<{ server: WebSocketServer; port: number }> {
  const server = new WebSocketServer({ port: 0 });
  await server.start();
  const address = (server as unknown as { server: net.Server }).server.address() as net.AddressInfo;
  return { server, port: address.port };
}

/** A real WebSocket client (Node's built-in) that records every message it receives. */
interface RecordingClient {
  socket: WebSocket;
  received: Array<string | Buffer>;
  closed: boolean;
}

async function connectClient(port: number, path = "/"): Promise<RecordingClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  socket.binaryType = "arraybuffer";
  const client: RecordingClient = { socket, received: [], closed: false };
  socket.addEventListener("message", (event) => {
    client.received.push(typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer));
  });
  socket.addEventListener("close", () => { client.closed = true; });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`could not connect to ${port}${path}`)), { once: true });
  });
  return client;
}

/**
 * A raw TCP client that completes the WebSocket handshake by hand and then
 * does whatever the test needs with the bare socket (never read, or vanish).
 */
async function rawHandshake(port: number, path = "/"): Promise<net.Socket> {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${Buffer.from(randomUUID().slice(0, 16)).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  await new Promise<void>((resolve) => {
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (head.includes("\r\n\r\n")) { socket.off("data", onData); resolve(); }
    };
    socket.on("data", onData);
  });
  return socket;
}

/** The server-side id of the client that connected on `path`. */
function clientIdOnPath(server: WebSocketServer, path: string): string | undefined {
  for (const [id, client] of server.getClients()) if (client.path === path) return id;
  return undefined;
}

// ════════════════════════════════════════════════════════════════
console.log("=== WebSocket + SSE Hardening Tests ===\n");

// ── Manager: origin guard and malformed input (pure, no bus) ──
console.log("--- Backplane manager ---");

{
  // ensure() with no backplane configured installs the relay and attaches no
  // bus, so onMessage() can be driven directly with real envelopes.
  const previous = process.env.TINA4_WS_BACKPLANE;
  delete process.env.TINA4_WS_BACKPLANE;
  const manager = new WsBackplaneManager();
  const relayed: WsEnvelope[] = [];
  await manager.ensure((env) => relayed.push(env));
  if (previous !== undefined) process.env.TINA4_WS_BACKPLANE = previous;

  manager.onMessage(JSON.stringify({ src: manager.instanceId, kind: "all", text: "echo-should-be-dropped" }));
  assert("origin guard drops our own echo (no relay)", relayed.length === 0);

  manager.onMessage(JSON.stringify({ src: "some-other-instance", kind: "all", text: "from-elsewhere" }));
  assert("foreign-src envelope is relayed", relayed.length === 1 && relayed[0].text === "from-elsewhere");

  let threw = false;
  try {
    manager.onMessage("{not json");
    manager.onMessage("null");
    manager.onMessage("42");
  } catch {
    threw = true;
  }
  assert("malformed/non-object envelope dropped without throwing", !threw && relayed.length === 1);
}

// ── Envelope encoding (cross-framework wire shape) ────────────
console.log("\n--- Envelope encoding ---");

{
  const env = buildEnvelope("inst-1", "all", "plain text");
  assert("string message rides under 'text'", env.text === "plain text" && env.b64 === undefined);
  assert("envelope carries src + kind", env.src === "inst-1" && env.kind === "all");
  assert("envelope null-fills exclude/room/path", env.exclude === null && env.room === null && env.path === null);
}

{
  const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff]);
  const env = buildEnvelope("inst-1", "all", bytes);
  assert("binary message rides under 'b64'", env.b64 === bytes.toString("base64") && env.text === undefined);
  assert("channel constant is 'tina4:ws' (cross-framework parity)", WS_BACKPLANE_CHANNEL === "tina4:ws");
}

{
  const decoded = WsBackplaneManager.decodeMessage({ src: "x", kind: "all", b64: Buffer.from("hi").toString("base64") });
  assert("decodeMessage reconstructs Buffer from b64", Buffer.isBuffer(decoded) && decoded.toString() === "hi");
  const decodedText = WsBackplaneManager.decodeMessage({ src: "x", kind: "all", text: "yo" });
  assert("decodeMessage reconstructs string from text", decodedText === "yo");
  assert("decodeMessage returns null when neither present", WsBackplaneManager.decodeMessage({ src: "x", kind: "all" }) === null);
}

// ── Two real servers relaying through a real Redis ──
console.log("\n--- Server cross-instance relay (real Redis backplane) ---");

const REDIS_URL = process.env.TINA4_TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
if (!(await reachable(REDIS_URL))) {
  skip("cross-instance relay through Redis", `redis not reachable at ${new URL(REDIS_URL).host}`);
} else {
  process.env.TINA4_WS_BACKPLANE = "redis";
  process.env.TINA4_WS_BACKPLANE_URL = REDIS_URL;
  // Other suites on a shared host may use the same channel, so every message
  // this section sends carries a token and only token-bearing traffic counts.
  const token = randomUUID().slice(0, 8);

  // An INDEPENDENT subscriber: counts what really crossed the channel.
  const observer = createClient({ url: REDIS_URL });
  await observer.connect();
  const onChannel: WsEnvelope[] = [];
  await observer.subscribe(WS_BACKPLANE_CHANNEL, (raw: string) => {
    try {
      const envelope = JSON.parse(raw) as WsEnvelope;
      const text = envelope.text ?? (envelope.b64 ? Buffer.from(envelope.b64, "base64").toString("latin1") : "");
      if (text.includes(token)) onChannel.push(envelope);
    } catch { /* not ours */ }
  });

  const a = await startServer();
  const b = await startServer();
  const clientA = await connectClient(a.port, "/a1");
  const clientB1 = await connectClient(b.port, "/b1");
  const clientB2 = await connectClient(b.port, "/b2");

  // Each server wires its backplane on its first broadcast (asynchronously),
  // so probe until a broadcast from A reaches B and one from B reaches A.
  const wired = await waitFor(() => {
    a.server.broadcast(`probe-${token}`);
    b.server.broadcast(`probe-${token}`);
    return clientB1.received.some((m) => m === `probe-${token}`) && clientA.received.filter((m) => m === `probe-${token}`).length > 1;
  }, 10_000);
  assert("both servers wired to the Redis backplane", wired);
  await sleep(300);
  for (const client of [clientA, clientB1, clientB2]) client.received.length = 0;
  onChannel.length = 0;

  const ping = `ping-${token}`;
  a.server.broadcast(ping);
  await waitFor(() => clientB1.received.includes(ping) && clientB2.received.includes(ping));
  await sleep(300); // time for any duplicate to show up
  assert("A delivers locally exactly once", clientA.received.filter((m) => m === ping).length === 1,
    JSON.stringify(clientA.received));
  assert("B receives the relay exactly once", clientB1.received.filter((m) => m === ping).length === 1,
    JSON.stringify(clientB1.received));
  const pingEnvelopes = onChannel.filter((e) => e.text === ping);
  assert("exactly one envelope crossed Redis (no re-publish loop)", pingEnvelopes.length === 1,
    `${pingEnvelopes.length} envelopes`);
  assert("the envelope names A as its origin", pingEnvelopes[0]?.src === a.server.instanceId);

  // Bytes round-trip through the JSON envelope via base64.
  const payload = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0xff]), Buffer.from(token)]);
  a.server.broadcast(payload);
  await waitFor(() => clientB1.received.some((m) => Buffer.isBuffer(m) && m.equals(payload)));
  assert("bytes round-trip through envelope on relay",
    clientB1.received.some((m) => Buffer.isBuffer(m) && m.equals(payload)));

  // Room relay targets only room members on the sibling instance.
  const room = `lobby-${token}`;
  const b1Id = clientIdOnPath(b.server, "/b1");
  b.server.joinRoom(b1Id!, room);
  const roomMessage = `room-${token}`;
  const b2Before = clientB2.received.length;
  a.server.broadcastToRoom(room, roomMessage);
  await waitFor(() => clientB1.received.includes(roomMessage));
  await sleep(300);
  assert("room relay reaches the room member", clientB1.received.includes(roomMessage));
  assert("room relay skips a non-member", clientB2.received.length === b2Before);

  for (const client of [clientA, clientB1, clientB2]) client.socket.close();
  a.server.stop();
  b.server.stop();
  await observer.quit();
  delete process.env.TINA4_WS_BACKPLANE;
  delete process.env.TINA4_WS_BACKPLANE_URL;
}

// ── Broadcast resilience (a vanished client is pruned, others still served) ──
console.log("\n--- Broadcast resilience ---");

{
  const { server, port } = await startServer();
  const good1 = await connectClient(port, "/g1");
  const vanished = await rawHandshake(port, "/gone");
  const good2 = await connectClient(port, "/g2");
  await waitFor(() => server.getClients().size === 3);
  vanished.resetAndDestroy(); // the peer disappears without a close frame

  server.broadcast("payload");
  await waitFor(() => good1.received.includes("payload") && good2.received.includes("payload"));
  assert("good1 received despite the vanished client", good1.received.includes("payload"));
  assert("good2 received despite the vanished client", good2.received.includes("payload"));
  assert("vanished client pruned from manager", await waitFor(() => clientIdOnPath(server, "/gone") === undefined));
  assert("manager count drops to 2 after prune", server.getClients().size === 2);

  // Path broadcast after the prune still reaches the right client.
  server.broadcast("hi", undefined, "/g1");
  await waitFor(() => good1.received.includes("hi"));
  assert("path broadcast: matching client served", good1.received.includes("hi"));
  assert("path broadcast: other path not served", !good2.received.includes("hi"));
  good1.socket.close();
  good2.socket.close();
  server.stop();
}

{
  // Slow-client backpressure: a client that never reads is dropped once its
  // queued backlog passes TINA4_WS_MAX_BACKLOG, instead of growing the heap.
  const previous = process.env.TINA4_WS_MAX_BACKLOG;
  process.env.TINA4_WS_MAX_BACKLOG = "100";
  const { server, port } = await startServer();
  const neverReads = await rawHandshake(port, "/slow");
  neverReads.pause();
  await waitFor(() => clientIdOnPath(server, "/slow") !== undefined);

  server.broadcast(Buffer.alloc(8 * 1024 * 1024, 0x61)); // far more than any socket buffer holds

  assert("saturated slow client is dropped/closed", clientIdOnPath(server, "/slow") === undefined);
  neverReads.destroy();
  server.stop();
  if (previous === undefined) delete process.env.TINA4_WS_MAX_BACKLOG;
  else process.env.TINA4_WS_MAX_BACKLOG = previous;
}

// ── Origin allow-list ─────────────────────────────────────────
console.log("\n--- Origin allow-list ---");

{
  const prev = process.env.TINA4_WS_ALLOWED_ORIGINS;

  delete process.env.TINA4_WS_ALLOWED_ORIGINS;
  assert("empty env allows all origins", originAllowed({ origin: "https://anything.example" }) === true);
  assert("empty env allows a missing origin", originAllowed({}) === true);

  process.env.TINA4_WS_ALLOWED_ORIGINS = "   ";
  assert("blank env allows all origins", originAllowed({ origin: "https://anything.example" }) === true);

  process.env.TINA4_WS_ALLOWED_ORIGINS = "https://app.example.com, https://admin.example.com";
  assert("listed origin allowed", originAllowed({ origin: "https://app.example.com" }) === true);
  assert("second listed origin allowed", originAllowed({ origin: "https://admin.example.com" }) === true);

  process.env.TINA4_WS_ALLOWED_ORIGINS = "https://app.example.com";
  assert("mismatched origin rejected", originAllowed({ origin: "https://evil.example.com" }) === false);
  assert("missing origin rejected when allow-list active", originAllowed({}) === false);
  assert("case-insensitive header key (Origin)", originAllowed({ Origin: "https://app.example.com" }) === true);

  if (prev === undefined) delete process.env.TINA4_WS_ALLOWED_ORIGINS;
  else process.env.TINA4_WS_ALLOWED_ORIGINS = prev;
}

// ── Idle reaper ───────────────────────────────────────────────
console.log("\n--- Idle reaper ---");

{
  const { server, port } = await startServer();
  const client = await connectClient(port, "/c1");
  await waitFor(() => server.getClients().size === 1);
  assert("reapIdle(0) is a no-op (reaper disabled)", server.reapIdle(0) === 0);
  assert("reapIdle(0) keeps the connection", server.getClients().size === 1);
  client.socket.close();
  server.stop();
}

{
  const { server, port } = await startServer();
  const fresh = await connectClient(port, "/fresh");
  const stale = await connectClient(port, "/stale");
  await waitFor(() => server.getClients().size === 2);
  await sleep(1300); // both idle past a 1s timeout...
  fresh.socket.send("still here"); // ...then one of them speaks
  await sleep(200);

  const reaped = server.reapIdle(1);

  assert("idle reaper reaps exactly the stale connection", reaped === 1, `reaped ${reaped}`);
  assert("stale connection removed", clientIdOnPath(server, "/stale") === undefined);
  assert("stale client really received the close", await waitFor(() => stale.closed));
  assert("fresh connection survives", clientIdOnPath(server, "/fresh") !== undefined && !fresh.closed);
  fresh.socket.close();
  server.stop();
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
