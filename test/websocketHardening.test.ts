/**
 * Lock-in tests for the WebSocket + SSE hardening sweep (Node parity with the
 * Python master, commit f5c8f85). Engine-agnostic — no real Redis/NATS/sockets.
 * A tiny in-memory FakeBackplane proves the cross-instance relay path
 * end-to-end, and a MockSocket stands in for a real client socket.
 *
 *   - Backplane relay across simulated instances + origin-guard-no-echo
 *   - bytes round-trip through the envelope (base64)
 *   - broadcast resilience (one dead client never aborts delivery; it is pruned)
 *   - origin allow-list semantics (empty=allow, set=reject)
 *   - idle reaper (disabled=no-op, set=closes stale)
 *
 * Run with: npx tsx test/websocketHardening.test.ts
 */
import {
  WebSocketServer,
  WsBackplaneManager,
  buildEnvelope,
  originAllowed,
  WS_BACKPLANE_CHANNEL,
  parseFrame,
  OP_TEXT,
  OP_BINARY,
} from "../packages/core/src/index.ts";
import type { WebSocketBackplane, WsEnvelope, WebSocketClient } from "../packages/core/src/index.ts";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

// ── Fakes ─────────────────────────────────────────────────────

/**
 * In-memory pub/sub backplane. `publish` synchronously fans the raw message
 * out to every subscribed callback — exactly what a real backplane does, minus
 * the network. Because Node is single-threaded async, the manager's callback
 * relays directly (no thread bridge), so this exercises the real relay path.
 */
class FakeBackplane implements WebSocketBackplane {
  private subs: Map<string, ((message: string) => void)[]> = new Map();
  public published: string[] = [];

  async publish(channel: string, message: string): Promise<void> {
    this.published.push(message);
    for (const cb of this.subs.get(channel) ?? []) cb(message);
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    const list = this.subs.get(channel) ?? [];
    list.push(callback);
    this.subs.set(channel, list);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.subs.delete(channel);
  }

  async close(): Promise<void> {
    this.subs.clear();
  }
}

/** Records frames written; can be told to throw on write (broadcast resilience). */
class MockSocket {
  written: Buffer[] = [];
  destroyed = false;
  remoteAddress = "127.0.0.1";
  writableLength = 0;
  throwOnWrite = false;

  write(data: Buffer): boolean {
    if (this.throwOnWrite) throw new Error("simulated broken pipe");
    this.written.push(data);
    return true;
  }
  end(): void {
    this.destroyed = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  on(): void {
    /* no-op */
  }
}

function makeServer(): WebSocketServer {
  return new WebSocketServer({ port: 0 });
}

/** Inject a fake client directly into a server's clients map. Returns the socket. */
function injectClient(server: WebSocketServer, id: string, path = "/"): MockSocket {
  const socket = new MockSocket();
  (server as unknown as { clients: Map<string, WebSocketClient> }).clients.set(id, {
    id,
    socket: socket as unknown as WebSocketClient["socket"],
    ip: "127.0.0.1",
    connectedAt: Date.now(),
    closed: false,
    path,
    lastActivity: Date.now(),
  });
  return socket;
}

/** Decode the latest text/binary frame a mock socket received into a message. */
function lastMessage(socket: MockSocket): string | Buffer | null {
  if (socket.written.length === 0) return null;
  const frame = parseFrame(socket.written[socket.written.length - 1]);
  if (!frame) return null;
  return frame.opcode === OP_BINARY ? frame.payload : frame.payload.toString("utf-8");
}

// ════════════════════════════════════════════════════════════════
console.log("=== WebSocket + SSE Hardening Tests ===\n");

// ── Backplane relay + origin guard (FakeBackplane, two managers) ──
console.log("--- Backplane relay + origin guard ---");

{
  // A remote envelope is relayed to the local relay callback exactly once.
  const backplane = new FakeBackplane();
  const mgrA = new WsBackplaneManager();
  const mgrB = new WsBackplaneManager();
  const relayedB: WsEnvelope[] = [];

  await mgrA.ensure(() => {}, undefined as never);
  await mgrB.ensure((env) => relayedB.push(env), undefined as never);
  // Re-wire to the SAME fake bus (ensure() with no env config attaches no bus).
  (mgrA as unknown as { backplane: WebSocketBackplane }).backplane = backplane;
  (mgrB as unknown as { backplane: WebSocketBackplane }).backplane = backplane;
  await backplane.subscribe(WS_BACKPLANE_CHANNEL, (raw) => mgrA.onMessage(raw));
  await backplane.subscribe(WS_BACKPLANE_CHANNEL, (raw) => mgrB.onMessage(raw));

  mgrA.publish("all", "hello-cluster");
  await tick();

  assert("remote broadcast relayed to sibling instance", relayedB.length === 1 && relayedB[0].text === "hello-cluster");
}

{
  // Origin guard: a manager NEVER relays an envelope tagged with its own id.
  const backplane = new FakeBackplane();
  const mgr = new WsBackplaneManager();
  const relayed: WsEnvelope[] = [];
  (mgr as unknown as { backplane: WebSocketBackplane }).backplane = backplane;
  (mgr as unknown as { started: boolean }).started = true;
  (mgr as unknown as { relay: (e: WsEnvelope) => void }).relay = (env) => relayed.push(env);

  const echo = JSON.stringify({
    src: mgr.instanceId,
    kind: "all",
    exclude: null,
    room: null,
    path: null,
    text: "echo-should-be-dropped",
  });
  mgr.onMessage(echo);
  await tick();

  assert("origin guard drops our own echo (no relay)", relayed.length === 0);
}

{
  // A foreign-src envelope IS relayed (the complement of the origin guard).
  const mgr = new WsBackplaneManager();
  const relayed: WsEnvelope[] = [];
  (mgr as unknown as { relay: (e: WsEnvelope) => void }).relay = (env) => relayed.push(env);

  const foreign = JSON.stringify({ src: "some-other-instance", kind: "all", text: "from-elsewhere" });
  mgr.onMessage(foreign);
  await tick();

  assert("foreign-src envelope is relayed", relayed.length === 1 && relayed[0].text === "from-elsewhere");
}

{
  // Malformed JSON on the bus is dropped, never throws.
  const mgr = new WsBackplaneManager();
  let threw = false;
  try {
    mgr.onMessage("{not json");
    mgr.onMessage("null");
    mgr.onMessage("42");
  } catch {
    threw = true;
  }
  assert("malformed/non-object envelope dropped without throwing", !threw);
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

// ── Full server relay: cross-instance, no double-delivery, bytes ──
console.log("\n--- Server cross-instance relay (FakeBackplane) ---");

{
  // Wire two real WebSocketServer instances onto one fake bus and prove a
  // broadcast on A is delivered once on A (locally) and once on B (via relay),
  // with NO double-delivery (origin guard) and NO re-publish loop.
  const backplane = new FakeBackplane();
  const serverA = makeServer();
  const serverB = makeServer();

  const mgrA = (serverA as unknown as { backplane: WsBackplaneManager }).backplane;
  const mgrB = (serverB as unknown as { backplane: WsBackplaneManager }).backplane;

  // Manually wire each server's manager to the shared bus + its own relay
  // (mirrors what ensureBackplane() does once a bus is configured).
  (serverA as unknown as { backplaneStarted: boolean }).backplaneStarted = true;
  (serverB as unknown as { backplaneStarted: boolean }).backplaneStarted = true;
  (mgrA as unknown as { started: boolean }).started = true;
  (mgrB as unknown as { started: boolean }).started = true;
  (mgrA as unknown as { backplane: WebSocketBackplane }).backplane = backplane;
  (mgrB as unknown as { backplane: WebSocketBackplane }).backplane = backplane;
  (mgrA as unknown as { relay: (e: WsEnvelope) => void }).relay = (env) =>
    (serverA as unknown as { relayLocal: (e: WsEnvelope) => void }).relayLocal(env);
  (mgrB as unknown as { relay: (e: WsEnvelope) => void }).relay = (env) =>
    (serverB as unknown as { relayLocal: (e: WsEnvelope) => void }).relayLocal(env);
  await backplane.subscribe(WS_BACKPLANE_CHANNEL, (raw) => mgrA.onMessage(raw));
  await backplane.subscribe(WS_BACKPLANE_CHANNEL, (raw) => mgrB.onMessage(raw));

  const sockA = injectClient(serverA, "a1");
  const sockB = injectClient(serverB, "b1");

  serverA.broadcast("ping");
  await tick();

  assert("A delivers locally exactly once", sockA.written.length === 1 && lastMessage(sockA) === "ping");
  assert("B receives the relay exactly once", sockB.written.length === 1 && lastMessage(sockB) === "ping");
  assert("origin guard prevents A re-delivering its own echo", sockA.written.length === 1);
  assert("relay did NOT re-publish (no cluster loop)", backplane.published.length === 1);

  // Bytes round-trip through the JSON envelope via base64.
  const payload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x66]);
  serverA.broadcast(payload);
  await tick();
  const got = lastMessage(sockB);
  assert("bytes round-trip through envelope on relay", Buffer.isBuffer(got) && got.equals(payload));

  // Room relay targets only room members on the sibling instance.
  serverB.joinRoom("b1", "lobby");
  const sockOut = injectClient(serverB, "b2");
  serverA.broadcastToRoom("lobby", "room-msg");
  await tick();
  assert("room relay targets only room members", lastMessage(sockB) === "room-msg" && sockOut.written.length === 0);
}

// ── Broadcast resilience (dead client pruned, others still served) ──
console.log("\n--- Broadcast resilience ---");

{
  const server = makeServer();
  const good1 = injectClient(server, "g1");
  const bad = injectClient(server, "bad");
  const good2 = injectClient(server, "g2");
  bad.throwOnWrite = true;

  server.broadcast("payload");

  assert("good1 received despite dead client", lastMessage(good1) === "payload");
  assert("good2 received despite dead client", lastMessage(good2) === "payload");
  assert("dead client pruned from manager", server.getClients().get("bad") === undefined);
  assert("manager count drops to 2 after prune", server.getClients().size === 2);
}

{
  const server = makeServer();
  const good = injectClient(server, "g", "/chat");
  const bad = injectClient(server, "bad", "/chat");
  bad.throwOnWrite = true;

  server.broadcast("hi", undefined, "/chat");

  assert("path broadcast: good client served", lastMessage(good) === "hi");
  assert("path broadcast: dead client pruned", server.getClients().get("bad") === undefined);
}

{
  // Slow-client backpressure: a hopelessly-behind client (backlog over the cap)
  // is dropped rather than buffered without bound.
  const prev = process.env.TINA4_WS_MAX_BACKLOG;
  process.env.TINA4_WS_MAX_BACKLOG = "100";
  const server = makeServer();
  const slow = injectClient(server, "slow");
  slow.writableLength = 999999; // pretend the kernel buffer is hopelessly full

  server.broadcast("x");

  assert("saturated slow client is dropped/closed", server.getClients().get("slow") === undefined);
  if (prev === undefined) delete process.env.TINA4_WS_MAX_BACKLOG;
  else process.env.TINA4_WS_MAX_BACKLOG = prev;
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
  const server = makeServer();
  injectClient(server, "c1");
  assert("reapIdle(0) is a no-op (reaper disabled)", server.reapIdle(0) === 0);
  assert("reapIdle(0) keeps the connection", server.getClients().size === 1);
}

{
  const server = makeServer();
  const fresh = injectClient(server, "fresh");
  const stale = injectClient(server, "stale");
  const freshClient = server.getClients().get("fresh")!;
  const staleClient = server.getClients().get("stale")!;
  freshClient.lastActivity = Date.now();
  staleClient.lastActivity = Date.now() - 1_000_000; // long idle

  const reaped = server.reapIdle(30);

  assert("idle reaper reaps exactly the stale connection", reaped === 1);
  assert("stale connection removed", server.getClients().get("stale") === undefined);
  assert("stale socket closed", stale.destroyed === true);
  assert("fresh connection survives", server.getClients().get("fresh") !== undefined);
  void fresh;
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
