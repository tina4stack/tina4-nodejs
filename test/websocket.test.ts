/**
 * Unit tests for the WebSocket module (Phase 5).
 * Run with: npx tsx test/websocket.test.ts
 *
 * These are unit tests for the WebSocket utilities and server API.
 * No actual socket connections are made.
 */
import {
  WebSocketServer,
  computeAcceptKey,
  parseUpgradeHeaders,
  buildFrame,
  parseFrame,
  OP_TEXT,
  OP_BINARY,
  OP_CLOSE,
  OP_PING,
  OP_PONG,
  CLOSE_NORMAL,
  CLOSE_PROTOCOL_ERROR,
} from "../packages/core/src/index.ts";
import type { WebSocketClient } from "../packages/core/src/index.ts";

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

console.log("=== WebSocket Tests ===\n");

// --- Handshake Key Computation ---
console.log("--- Handshake Key Computation ---");

// Test vector from RFC 6455 Section 4.2.2
const testKey = "dGhlIHNhbXBsZSBub25jZQ==";
const expectedAccept = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
const accept = computeAcceptKey(testKey);
assert("computeAcceptKey produces correct RFC 6455 value", accept === expectedAccept);

const key2 = computeAcceptKey("x3JJHMbDL1EzLkh9GBhXDw==");
assert("computeAcceptKey produces non-empty base64", key2.length > 0 && key2.endsWith("="));

const key3 = computeAcceptKey("anotherKey");
assert("different keys produce different accepts", key3 !== accept);

// --- Header Parsing ---
console.log("\n--- Header Parsing ---");

const rawHeaders = [
  "GET /ws HTTP/1.1",
  "Host: localhost:8080",
  "Upgrade: websocket",
  "Connection: Upgrade",
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version: 13",
  "",
  "",
].join("\r\n");

const headers = parseUpgradeHeaders(rawHeaders);
assert("parsed method is GET", headers["_method"] === "GET");
assert("parsed path is /ws", headers["_path"] === "/ws");
assert("parsed upgrade header", headers["upgrade"] === "websocket");
assert("parsed websocket key", headers["sec-websocket-key"] === "dGhlIHNhbXBsZSBub25jZQ==");
assert("parsed websocket version", headers["sec-websocket-version"] === "13");

// --- Frame Building (small payload) ---
console.log("\n--- Frame Building ---");

const smallPayload = Buffer.from("Hello", "utf-8");
const smallFrame = buildFrame(OP_TEXT, smallPayload);
assert("small frame starts with FIN + TEXT opcode", (smallFrame[0] & 0xff) === 0x81);
assert("small frame has correct length byte", smallFrame[1] === 5);
assert("small frame payload matches", smallFrame.subarray(2).toString("utf-8") === "Hello");

// --- Frame Building (medium payload, 126-byte extended) ---
const medPayload = Buffer.alloc(200, 0x41); // 200 bytes of 'A'
const medFrame = buildFrame(OP_TEXT, medPayload);
assert("medium frame uses 126 extended length", medFrame[1] === 126);
const medLen = medFrame.readUInt16BE(2);
assert("medium frame extended length is 200", medLen === 200);

// --- Frame Building (binary) ---
const binPayload = Buffer.from([0x00, 0x01, 0x02, 0x03]);
const binFrame = buildFrame(OP_BINARY, binPayload);
assert("binary frame has BINARY opcode", (binFrame[0] & 0x0f) === OP_BINARY);

// --- Frame Parsing (unmasked, small) ---
console.log("\n--- Frame Parsing ---");

const parsed = parseFrame(smallFrame);
assert("parsed small frame is not null", parsed !== null);
assert("parsed frame has fin=true", parsed!.fin === true);
assert("parsed frame has TEXT opcode", parsed!.opcode === OP_TEXT);
assert("parsed frame payload is Hello", parsed!.payload.toString("utf-8") === "Hello");
assert("parsed frame bytesConsumed correct", parsed!.bytesConsumed === smallFrame.length);

// --- Frame Parsing (masked, simulating client frame) ---
console.log("\n--- Masked Frame Parsing ---");

// Build a masked frame manually
const maskKey = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
const rawPayload = Buffer.from("Hi", "utf-8");
const maskedPayload = Buffer.alloc(rawPayload.length);
for (let i = 0; i < rawPayload.length; i++) {
  maskedPayload[i] = rawPayload[i] ^ maskKey[i % 4];
}

const maskedFrame = Buffer.alloc(2 + 4 + rawPayload.length);
maskedFrame[0] = 0x81; // FIN + TEXT
maskedFrame[1] = 0x80 | rawPayload.length; // MASKED + length
maskKey.copy(maskedFrame, 2);
maskedPayload.copy(maskedFrame, 6);

const parsedMasked = parseFrame(maskedFrame);
assert("masked frame parsed correctly", parsedMasked !== null);
assert("masked frame unmasked to 'Hi'", parsedMasked!.payload.toString("utf-8") === "Hi");

// --- Frame Round-trip ---
console.log("\n--- Frame Round-trip ---");

const testMessages = ["", "a", "Hello, World!", "Unicode: \u00e9\u00e8\u00ea"];
for (const msg of testMessages) {
  const payload = Buffer.from(msg, "utf-8");
  const frame = buildFrame(OP_TEXT, payload);
  const p = parseFrame(frame);
  assert(`round-trip: "${msg}"`, p !== null && p.payload.toString("utf-8") === msg);
}

// --- Incomplete Frame ---
const incomplete = Buffer.from([0x81]); // Only 1 byte
const parsedIncomplete = parseFrame(incomplete);
assert("incomplete frame returns null", parsedIncomplete === null);

// --- WebSocketServer API ---
console.log("\n--- WebSocketServer API ---");

const wss = new WebSocketServer({ port: 0 });
assert("WebSocketServer constructor works", wss !== null);

const onResult = wss.on("open", () => {});
assert("on() returns WebSocketServer (chaining)", onResult === wss);

const clients = wss.getClients();
assert("getClients returns a Map", clients instanceof Map);
assert("initial client count is 0", clients.size === 0);

// --- Close Frame ---
console.log("\n--- Close Frame ---");

const closePayload = Buffer.from([0x03, 0xe8]); // 1000 = normal close
const closeFrame = buildFrame(OP_CLOSE, closePayload);
const parsedClose = parseFrame(closeFrame);
assert("close frame has CLOSE opcode", parsedClose!.opcode === OP_CLOSE);
assert("close frame payload has code 1000", parsedClose!.payload.readUInt16BE(0) === 1000);

// --- Ping/Pong Frames ---
console.log("\n--- Ping/Pong Frames ---");

const pingFrame = buildFrame(OP_PING, Buffer.alloc(0));
const parsedPing = parseFrame(pingFrame);
assert("ping frame has PING opcode", parsedPing!.opcode === OP_PING);

const pongFrame = buildFrame(OP_PONG, Buffer.from("pong-data"));
const parsedPong = parseFrame(pongFrame);
assert("pong frame has PONG opcode", parsedPong!.opcode === OP_PONG);
assert("pong frame has payload", parsedPong!.payload.toString("utf-8") === "pong-data");

// --- Constants ---
console.log("\n--- Constants ---");

assert("OP_TEXT is 0x1", OP_TEXT === 0x1);
assert("OP_BINARY is 0x2", OP_BINARY === 0x2);
assert("OP_CLOSE is 0x8", OP_CLOSE === 0x8);
assert("CLOSE_NORMAL is 1000", CLOSE_NORMAL === 1000);
assert("CLOSE_PROTOCOL_ERROR is 1002", CLOSE_PROTOCOL_ERROR === 1002);

// --- Extended Payload: 16-bit length ---
console.log("\n--- Extended Payload: 16-bit length ---");

const payload200 = Buffer.alloc(200, 0x42); // 200 bytes of 'B'
const frame200 = buildFrame(OP_TEXT, payload200);
const parsed200 = parseFrame(frame200);
assert("16-bit frame parsed correctly", parsed200 !== null);
assert("16-bit frame payload length is 200", parsed200!.payload.length === 200);
assert("16-bit frame payload content correct", parsed200!.payload[0] === 0x42 && parsed200!.payload[199] === 0x42);
assert("16-bit frame fin is true", parsed200!.fin === true);
assert("16-bit frame opcode is TEXT", parsed200!.opcode === OP_TEXT);

// --- Extended Payload: 64-bit length ---
console.log("\n--- Extended Payload: 64-bit length ---");

const payload70k = Buffer.alloc(70000, 0x43); // 70000 bytes of 'C'
const frame70k = buildFrame(OP_BINARY, payload70k);
assert("64-bit frame uses 127 extended length byte", frame70k[1] === 127);

const parsed70k = parseFrame(frame70k);
assert("64-bit frame parsed correctly", parsed70k !== null);
assert("64-bit frame payload length is 70000", parsed70k!.payload.length === 70000);
assert("64-bit frame payload content correct", parsed70k!.payload[0] === 0x43 && parsed70k!.payload[69999] === 0x43);
assert("64-bit frame opcode is BINARY", parsed70k!.opcode === OP_BINARY);

// --- Close codes ---
console.log("\n--- Close codes ---");

// 1000 - Normal
const closeNormal = Buffer.alloc(2);
closeNormal.writeUInt16BE(1000, 0);
const closeNormalFrame = buildFrame(OP_CLOSE, closeNormal);
const parsedCloseNormal = parseFrame(closeNormalFrame);
assert("close 1000 (normal) round-trips", parsedCloseNormal!.payload.readUInt16BE(0) === 1000);

// 1001 - Going Away
const closeGoingAway = Buffer.alloc(2);
closeGoingAway.writeUInt16BE(1001, 0);
const closeGAFrame = buildFrame(OP_CLOSE, closeGoingAway);
const parsedCloseGA = parseFrame(closeGAFrame);
assert("close 1001 (going away) round-trips", parsedCloseGA!.payload.readUInt16BE(0) === 1001);

// 1002 - Protocol Error
const closeProto = Buffer.alloc(2);
closeProto.writeUInt16BE(1002, 0);
const closeProtoFrame = buildFrame(OP_CLOSE, closeProto);
const parsedCloseProto = parseFrame(closeProtoFrame);
assert("close 1002 (protocol error) round-trips", parsedCloseProto!.payload.readUInt16BE(0) === 1002);

// Close with reason text
const closeWithReason = Buffer.alloc(2 + Buffer.byteLength("Server shutting down"));
closeWithReason.writeUInt16BE(1001, 0);
closeWithReason.write("Server shutting down", 2, "utf-8");
const closeReasonFrame = buildFrame(OP_CLOSE, closeWithReason);
const parsedCloseReason = parseFrame(closeReasonFrame);
assert("close with reason preserves code", parsedCloseReason!.payload.readUInt16BE(0) === 1001);
assert("close with reason preserves text", parsedCloseReason!.payload.subarray(2).toString("utf-8") === "Server shutting down");

// --- Multiple opcodes ---
console.log("\n--- Multiple opcodes ---");

// OP_CONTINUATION
const contFrame = buildFrame(0x0, Buffer.from("continuation"));
const parsedCont = parseFrame(contFrame);
assert("continuation frame opcode is 0x0", parsedCont!.opcode === 0x0);

// OP_PING with data
const pingData = Buffer.from("ping-payload");
const pingFrame2 = buildFrame(OP_PING, pingData);
const parsedPing2 = parseFrame(pingFrame2);
assert("ping with data round-trips", parsedPing2!.payload.toString("utf-8") === "ping-payload");
assert("ping opcode is 0x9", parsedPing2!.opcode === 0x9);

// OP_PONG with data
const pongData = Buffer.from("pong-payload");
const pongFrame2 = buildFrame(OP_PONG, pongData);
const parsedPong2 = parseFrame(pongFrame2);
assert("pong with data round-trips", parsedPong2!.payload.toString("utf-8") === "pong-payload");
assert("pong opcode is 0xa", parsedPong2!.opcode === 0xa);

// --- FIN flag ---
console.log("\n--- FIN flag ---");

const noFinFrame = buildFrame(OP_TEXT, Buffer.from("partial"), false);
const parsedNoFin = parseFrame(noFinFrame);
assert("non-FIN frame has fin=false", parsedNoFin!.fin === false);
assert("non-FIN frame still has correct payload", parsedNoFin!.payload.toString("utf-8") === "partial");

const finFrame = buildFrame(OP_TEXT, Buffer.from("complete"), true);
const parsedFin = parseFrame(finFrame);
assert("FIN frame has fin=true", parsedFin!.fin === true);

// --- Empty payload frames ---
console.log("\n--- Empty payload ---");

const emptyTextFrame = buildFrame(OP_TEXT, Buffer.alloc(0));
const parsedEmpty = parseFrame(emptyTextFrame);
assert("empty payload frame parses", parsedEmpty !== null);
assert("empty payload has length 0", parsedEmpty!.payload.length === 0);

const emptyPingFrame = buildFrame(OP_PING, Buffer.alloc(0));
const parsedEmptyPing = parseFrame(emptyPingFrame);
assert("empty ping frame parses", parsedEmptyPing !== null);

// --- Exactly 125 bytes (max small payload) ---
console.log("\n--- Boundary payload sizes ---");

const payload125 = Buffer.alloc(125, 0x44);
const frame125 = buildFrame(OP_TEXT, payload125);
assert("125-byte payload uses small length encoding", frame125[1] === 125);
const parsed125 = parseFrame(frame125);
assert("125-byte payload round-trips", parsed125!.payload.length === 125);

const payload126 = Buffer.alloc(126, 0x45);
const frame126 = buildFrame(OP_TEXT, payload126);
assert("126-byte payload uses 16-bit extended length", frame126[1] === 126);
const parsed126 = parseFrame(frame126);
assert("126-byte payload round-trips", parsed126!.payload.length === 126);

const payload65535 = Buffer.alloc(65535, 0x46);
const frame65535 = buildFrame(OP_TEXT, payload65535);
assert("65535-byte payload uses 16-bit extended length", frame65535[1] === 126);

const payload65536 = Buffer.alloc(65536, 0x47);
const frame65536 = buildFrame(OP_TEXT, payload65536);
assert("65536-byte payload uses 64-bit extended length", frame65536[1] === 127);

// --- Truncated extended frames ---
console.log("\n--- Truncated frames ---");

// 16-bit extended but only 3 bytes available
const trunc16 = Buffer.from([0x81, 126, 0x00]); // missing second byte of length
const parsedTrunc16 = parseFrame(trunc16);
assert("truncated 16-bit frame returns null", parsedTrunc16 === null);

// 64-bit extended but only 5 bytes available
const trunc64 = Buffer.from([0x81, 127, 0x00, 0x00, 0x00]); // missing rest of 8-byte length
const parsedTrunc64 = parseFrame(trunc64);
assert("truncated 64-bit frame returns null", parsedTrunc64 === null);

// --- WebSocket Rooms ---
console.log("\n--- WebSocket Rooms ---");

// Mock socket that records written data
class MockSocket {
  written: Buffer[] = [];
  closed = false;
  remoteAddress = "127.0.0.1";
  write(data: Buffer): boolean { this.written.push(data); return true; }
  end(): void { this.closed = true; }
  on(): void {}
}

function makeTestServer(): WebSocketServer {
  return new WebSocketServer({ port: 0 });
}

function injectClient(server: WebSocketServer, id: string, path = "/"): MockSocket {
  const socket = new MockSocket();
  (server as unknown as Record<string, unknown>)["clients"].set(id, {
    id, socket, ip: "127.0.0.1", connectedAt: Date.now(), closed: false, path,
  } as WebSocketClient);
  return socket;
}

// getRoomConnections returns empty array for unknown room
{
  const s = makeTestServer();
  const conns = s.getRoomConnections("chat");
  assert("getRoomConnections returns [] for unknown room", Array.isArray(conns) && conns.length === 0);
}

// roomCount returns 0 for unknown room
{
  const s = makeTestServer();
  assert("roomCount returns 0 for unknown room", s.roomCount("chat") === 0);
}

// joinRoom adds client to room
{
  const s = makeTestServer();
  injectClient(s, "c1");
  s.joinRoom("c1", "chat");
  assert("joinRoom: client appears in room", s.getRoomConnections("chat").includes("c1"));
}

// roomCount reflects membership
{
  const s = makeTestServer();
  injectClient(s, "c1");
  injectClient(s, "c2");
  s.joinRoom("c1", "chat");
  s.joinRoom("c2", "chat");
  assert("roomCount is 2 after two joins", s.roomCount("chat") === 2);
}

// joinRoom is idempotent
{
  const s = makeTestServer();
  injectClient(s, "c1");
  s.joinRoom("c1", "chat");
  s.joinRoom("c1", "chat");
  assert("joinRoom idempotent: roomCount stays 1", s.roomCount("chat") === 1);
}

// leaveRoom removes client from room
{
  const s = makeTestServer();
  injectClient(s, "c1");
  s.joinRoom("c1", "chat");
  s.leaveRoom("c1", "chat");
  assert("leaveRoom: client removed from room", !s.getRoomConnections("chat").includes("c1"));
}

// leaveRoom on non-member is no-op
{
  const s = makeTestServer();
  s.leaveRoom("nobody", "chat");
  assert("leaveRoom on non-member: no error", s.roomCount("chat") === 0);
}

// getClientRooms returns room names for a client
{
  const s = makeTestServer();
  injectClient(s, "c1");
  s.joinRoom("c1", "chat");
  s.joinRoom("c1", "sports");
  const rooms = s.getClientRooms("c1");
  assert("getClientRooms returns both rooms",
    rooms.includes("chat") && rooms.includes("sports") && rooms.length === 2);
}

// getClientRooms returns [] for unknown client
{
  const s = makeTestServer();
  assert("getClientRooms returns [] for unknown client",
    Array.isArray(s.getClientRooms("ghost")) && s.getClientRooms("ghost").length === 0);
}

// client can be in multiple rooms
{
  const s = makeTestServer();
  injectClient(s, "c1");
  s.joinRoom("c1", "room-a");
  s.joinRoom("c1", "room-b");
  s.joinRoom("c1", "room-c");
  assert("client can join 3 rooms", s.getClientRooms("c1").length === 3);
}

// multiple clients in same room
{
  const s = makeTestServer();
  injectClient(s, "c1");
  injectClient(s, "c2");
  injectClient(s, "c3");
  s.joinRoom("c1", "lobby");
  s.joinRoom("c2", "lobby");
  s.joinRoom("c3", "lobby");
  const conns = s.getRoomConnections("lobby");
  assert("3 clients in same room",
    conns.includes("c1") && conns.includes("c2") && conns.includes("c3"));
}

// room is empty after last member leaves
{
  const s = makeTestServer();
  injectClient(s, "c1");
  s.joinRoom("c1", "quiet");
  s.leaveRoom("c1", "quiet");
  assert("room is empty after last member leaves", s.roomCount("quiet") === 0);
}

// broadcastToRoom sends to all room members
{
  const s = makeTestServer();
  const sock1 = injectClient(s, "c1");
  const sock2 = injectClient(s, "c2");
  injectClient(s, "c3");  // not in room
  s.joinRoom("c1", "vip");
  s.joinRoom("c2", "vip");
  s.broadcastToRoom("vip", "hello");
  assert("broadcastToRoom sends to room members",
    sock1.written.length === 1 && sock2.written.length === 1);
}

// broadcastToRoom does not send to non-members
{
  const s = makeTestServer();
  injectClient(s, "c1");
  const sock2 = injectClient(s, "c2");
  s.joinRoom("c1", "vip");
  // c2 not in room
  s.broadcastToRoom("vip", "hello");
  assert("broadcastToRoom does not send to non-members", sock2.written.length === 0);
}

// broadcastToRoom with exclude list
{
  const s = makeTestServer();
  const sock1 = injectClient(s, "c1");
  const sock2 = injectClient(s, "c2");
  s.joinRoom("c1", "room");
  s.joinRoom("c2", "room");
  s.broadcastToRoom("room", "msg", ["c1"]);
  assert("broadcastToRoom excludes specified client",
    sock1.written.length === 0 && sock2.written.length === 1);
}

// broadcastToRoom to empty room is no-op
{
  const s = makeTestServer();
  s.broadcastToRoom("ghost-room", "hello");
  assert("broadcastToRoom on empty room is no-op", true);
}

// rooms are cleaned up when client leaves all rooms
{
  const s = makeTestServer();
  injectClient(s, "c1");
  s.joinRoom("c1", "a");
  s.joinRoom("c1", "b");
  s.leaveRoom("c1", "a");
  s.leaveRoom("c1", "b");
  assert("client has no rooms after leaving all", s.getClientRooms("c1").length === 0);
}

// --- WebSocketConnection.sendJson (interface parity with Python/PHP) ---
console.log("\n--- WebSocketConnection.sendJson ---");

{
  // Build a minimal object satisfying the WebSocketConnection interface
  // with sendJson delegating to send() (the canonical implementation pattern).
  const sent: string[] = [];
  const conn: import("../packages/core/src/websocketConnection.ts").WebSocketConnection = {
    id: "test-1",
    path: "/ws/test",
    ip: "127.0.0.1",
    headers: {},
    params: {},
    send(message: string) { sent.push(message); },
    sendJson(data: unknown) { this.send(JSON.stringify(data)); },
    broadcast() {},
    joinRoom() {},
    leaveRoom() {},
    close() {},
    _onMessage: null,
    _onClose: null,
    onMessage(h) { this._onMessage = h; },
    onClose(h) { this._onClose = h; },
  };

  assert("sendJson exists on interface impl", typeof conn.sendJson === "function");

  conn.sendJson({ hello: "world", n: 42 });
  assert(
    "sendJson serializes object to JSON via send()",
    sent.length === 1 && sent[0] === '{"hello":"world","n":42}',
  );

  conn.sendJson([1, 2, 3]);
  assert("sendJson serializes array to JSON via send()", sent[1] === "[1,2,3]");

  conn.sendJson(null);
  assert("sendJson handles null", sent[2] === "null");
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
