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

const onResult = wss.on("connection", () => {});
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

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
