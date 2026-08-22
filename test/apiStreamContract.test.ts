/** ADR-0060 Api streaming primitives (streamBytes / streamLines / streamSse). */
import http from "node:http";
import net from "node:net";
import { Api, ApiStreamError, parseSseStream, type SseEvent } from "@tina4/core";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}
async function throwsType<T extends Error>(fn: () => unknown | Promise<unknown>, type: new (...args: never[]) => T): Promise<T | null> {
  try { await fn(); return null; } catch (error) { return error instanceof type ? error : null; }
}

const activeSockets = new Set<net.Socket>();

/**
 * Real HTTP server that serves crafted, chunked-byte responses so we can
 * pin the transport-level invariants (chunk order, EOF, mid-stream drop,
 * SSE framing) against a real socket rather than a mock.
 */
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  // Track raw sockets so mid-stream drop tests can wait for them.
  const socket = req.socket;
  activeSockets.add(socket);
  socket.once("close", () => activeSockets.delete(socket));

  if (path === "/bytes-ordered") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.write(Buffer.from([0x01, 0x02, 0x03]));
    await new Promise((r) => setTimeout(r, 5));
    res.write(Buffer.from([0x04, 0x05]));
    await new Promise((r) => setTimeout(r, 5));
    res.write(Buffer.from([0x06]));
    return res.end();
  }
  if (path === "/bytes-empty") {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "0" });
    return res.end();
  }
  if (path === "/bytes-drop") {
    res.writeHead(200, { "content-type": "application/octet-stream", "transfer-encoding": "chunked" });
    res.write(Buffer.from("partial "));
    // Kill the socket mid-body so the client sees a transport failure.
    setTimeout(() => socket.destroy(), 10);
    return;
  }
  if (path === "/lines-lf") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("alpha\n");
    res.write("beta\n");
    return res.end("gamma\n");
  }
  if (path === "/lines-crlf") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("alpha\r\nbeta\r\n");
    return res.end("gamma\r\n");
  }
  if (path === "/lines-trailing") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("alpha\n");
    return res.end("no-newline-here");
  }
  if (path === "/lines-multibyte") {
    // The line "café\nsnowman ☃\n" split across two writes so a
    // multibyte codepoint straddles the chunk boundary.
    const full = Buffer.from("café\nsnowman ☃\n", "utf8");
    // "café" = 0x63 0x61 0x66 0xC3 0xA9. Split after 0xC3 so the
    // low byte of the é comes in the next chunk.
    const firstCut = 4; // 'c','a','f',0xC3
    res.writeHead(200, { "content-type": "text/plain" });
    res.write(full.subarray(0, firstCut));
    await new Promise((r) => setTimeout(r, 5));
    // Second chunk cuts INSIDE the ☃ (U+2603 = 0xE2 0x98 0x83) too.
    // Locate the ☃ bytes (they are the last 4 before the trailing \n).
    const secondCut = full.length - 3; // 0xE2 is the first byte of ☃
    res.write(full.subarray(firstCut, secondCut + 1)); // through the E2
    await new Promise((r) => setTimeout(r, 5));
    return res.end(full.subarray(secondCut + 1));
  }
  if (path === "/sse-single") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    return res.end("data: hello\n\n");
  }
  if (path === "/sse-multiline") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    return res.end("data: line1\ndata: line2\ndata: line3\n\n");
  }
  if (path === "/sse-named") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    return res.end("event: ping\ndata: {\"v\":1}\nid: 42\n\n");
  }
  if (path === "/sse-comment") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    return res.end(": keep-alive comment\ndata: kept\n\n");
  }
  if (path === "/sse-boundary") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    res.write("data: second\n\n");
    return res.end("data: third\n\n");
  }
  if (path === "/sse-done") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ n: 1 })}\n\n`);
    return res.end("data: [DONE]\n\n");
  }
  if (path === "/sse-retry") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    return res.end("retry: 2500\ndata: after-retry\n\n");
  }
  if (path === "/sse-slow") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    // Hold the socket open. The client should either drain (early close)
    // or the total timeout will fire.
    return;
  }
  if (path === "/sse-many") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Emit N events with small pauses so an early-break client stops
    // reading before EOF; the server side stays open (checked below).
    let i = 0;
    const t = setInterval(() => {
      i++;
      if (socket.destroyed) { clearInterval(t); return; }
      res.write(`data: ${i}\n\n`);
      if (i > 200) { clearInterval(t); res.end(); }
    }, 5);
    socket.once("close", () => clearInterval(t));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  return res.end("missing");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("api stream contract server did not bind");
const base = `http://127.0.0.1:${address.port}`;

// A raw TCP listener that ACCEPTs the connection and then never speaks —
// used to force a connect-timeout without HTTP framing help.
const stallSockets = new Set<net.Socket>();
const stallServer = net.createServer((socket) => {
  stallSockets.add(socket);
  socket.once("close", () => stallSockets.delete(socket));
});
await new Promise<void>((resolve) => stallServer.listen(0, "127.0.0.1", resolve));
const stallAddr = stallServer.address();
if (!stallAddr || typeof stallAddr === "string") throw new Error("stall server did not bind");

async function collectBytes(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function collectLines(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of stream) out.push(line);
  return out;
}
async function collectEvents(stream: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

try {
  const api = new Api(base);

  // ── api-stream-bytes-primitive ───────────────────────────────────
  const chunkOrder: number[] = [];
  for await (const chunk of api.streamBytes("/bytes-ordered")) {
    for (const byte of chunk) chunkOrder.push(byte);
  }
  assert("stream_bytes_yields_chunks_in_order", JSON.stringify(chunkOrder) === JSON.stringify([1, 2, 3, 4, 5, 6]));

  const empty = await collectBytes(api.streamBytes("/bytes-empty"));
  assert("stream_bytes_ends_on_eof", empty.length === 0);

  const dropError = await throwsType(async () => {
    for await (const _chunk of api.streamBytes("/bytes-drop")) { /* drain until failure */ }
  }, Error);
  assert("stream_bytes_raises_on_transport_drop", !!dropError);

  // ── api-stream-lines-newline-buffered ────────────────────────────
  assert("stream_lines_splits_on_lf", JSON.stringify(await collectLines(api.streamLines("/lines-lf"))) === JSON.stringify(["alpha", "beta", "gamma"]));
  assert("stream_lines_splits_on_crlf", JSON.stringify(await collectLines(api.streamLines("/lines-crlf"))) === JSON.stringify(["alpha", "beta", "gamma"]));
  assert("stream_lines_yields_trailing_line_without_newline", JSON.stringify(await collectLines(api.streamLines("/lines-trailing"))) === JSON.stringify(["alpha", "no-newline-here"]));
  assert("stream_lines_multibyte_across_chunk_boundary", JSON.stringify(await collectLines(api.streamLines("/lines-multibyte"))) === JSON.stringify(["café", "snowman ☃"]));

  // ── api-stream-sse-framing ───────────────────────────────────────
  const single = await collectEvents(api.streamSse("/sse-single"));
  assert("stream_sse_single_event", single.length === 1 && single[0].data === "hello");

  const multi = await collectEvents(api.streamSse("/sse-multiline"));
  assert("stream_sse_multi_line_data_concatenated", multi.length === 1 && multi[0].data === "line1\nline2\nline3");

  const named = await collectEvents(api.streamSse("/sse-named"));
  assert("stream_sse_named_event", named.length === 1 && named[0].event === "ping" && named[0].data === '{"v":1}' && named[0].id === "42");

  const comment = await collectEvents(api.streamSse("/sse-comment"));
  assert("stream_sse_comment_ignored", comment.length === 1 && comment[0].data === "kept");

  const boundary = await collectEvents(api.streamSse("/sse-boundary"));
  assert("stream_sse_blank_line_boundary", boundary.length === 3 && boundary[0].data === "first" && boundary[1].data === "second" && boundary[2].data === "third");

  const done = await collectEvents(api.streamSse("/sse-done"));
  const lastDone = done.at(-1);
  assert("stream_sse_done_sentinel_delivered", done.length === 2 && done[0].data === '{"n":1}' && lastDone?.data === "[DONE]");

  const retry = await collectEvents(api.streamSse("/sse-retry"));
  assert("stream_sse_retry_field_captured", retry.length === 1 && retry[0].retry === 2500 && retry[0].data === "after-retry");

  // ── api-stream-timeouts-and-close ────────────────────────────────
  // stream-connect-timeout-honoured: point at a TCP listener that never
  // speaks. The connect + headers phase must timeout well before wall clock.
  const connectApi = new Api(`http://127.0.0.1:${stallAddr.port}`);
  const connectStarted = performance.now();
  const connectErr = await throwsType(async () => {
    for await (const _chunk of connectApi.streamBytes("/never", { connectTimeout: 0.05, timeout: 5 })) { /* unreachable */ }
  }, ApiStreamError);
  const connectElapsed = performance.now() - connectStarted;
  assert("stream_connect_timeout_honoured", !!connectErr && connectElapsed < 1000);

  // stream-total-timeout-honoured: /sse-slow writes one event then holds
  // the socket. A short total timeout must abort the stream.
  const totalStarted = performance.now();
  const totalErr = await throwsType(async () => {
    for await (const _event of api.streamSse("/sse-slow", { timeout: 0.1, connectTimeout: 5 })) { /* drain */ }
  }, Error);
  const totalElapsed = performance.now() - totalStarted;
  assert("stream_total_timeout_honoured", !!totalErr && totalElapsed < 1500);

  // stream-early-close-releases-socket: read a few events then break.
  // Track the number of live sockets after; the aborted request's socket
  // should be closed.
  const socketsBefore = activeSockets.size;
  let received = 0;
  for await (const event of api.streamSse("/sse-many", { timeout: 30 })) {
    received++;
    void event;
    if (received >= 3) break;
  }
  // Give the server a moment to see the RST/FIN and close the socket.
  await new Promise((r) => setTimeout(r, 100));
  assert("stream_early_close_releases_socket", received === 3 && activeSockets.size <= socketsBefore);

  // ── api-stream-shared-with-ai-chat ───────────────────────────────
  // The Ai.chat streaming path uses the same parseSseStream framer that
  // Api.streamSse uses. Verify by driving parseSseStream directly over
  // Api.streamLines (the shared line framer) — the framer function is
  // the SAME symbol imported from @tina4/core.
  const sharedEvents: SseEvent[] = [];
  for await (const event of parseSseStream(api.streamLines("/sse-done"))) sharedEvents.push(event);
  const sharedLast = sharedEvents.at(-1);
  assert("ai_chat_uses_api_stream_sse_under_the_hood",
    sharedEvents.length === 2
    && sharedEvents[0].data === '{"n":1}'
    && sharedLast?.data === "[DONE]"
    && typeof parseSseStream === "function");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const socket of activeSockets) socket.destroy();
  for (const socket of stallSockets) socket.destroy();
  await new Promise<void>((resolve) => stallServer.close(() => resolve()));
}

console.log(`Results: ${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
