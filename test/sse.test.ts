/**
 * Unit tests for Response.stream() — Server-Sent Events (SSE) support.
 * Run with: npx tsx test/sse.test.ts
 */
import { createResponse } from "../packages/core/src/index.ts";
import type { ServerResponse } from "node:http";

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

/** Create a mock ServerResponse that tracks writeHead, write, and end calls. */
function mockStreamResponse(): {
  res: ServerResponse;
  state: {
    headStatus: number;
    headHeaders: Record<string, string>;
    chunks: string[];
    ended: boolean;
    headersSent: boolean;
  };
} {
  const state = {
    headStatus: 0,
    headHeaders: {} as Record<string, string>,
    chunks: [] as string[],
    ended: false,
    headersSent: false,
  };

  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name: string, value: string | string[]) {
      state.headHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    },
    getHeader(name: string) {
      return state.headHeaders[name.toLowerCase()];
    },
    writeHead(status: number, headers?: Record<string, string>) {
      state.headStatus = status;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          state.headHeaders[k.toLowerCase()] = v;
        }
      }
      state.headersSent = true;
      (res as any).headersSent = true;
    },
    write(data: string | Buffer) {
      state.chunks.push(typeof data === "string" ? data : data.toString());
    },
    end(data?: unknown) {
      if (data != null) {
        state.chunks.push(String(data));
      }
      state.ended = true;
    },
  } as unknown as ServerResponse;

  return { res, state };
}

console.log("=== SSE / Stream Tests ===\n");

// --- stream() sets correct headers ---
console.log("--- Headers ---");

{
  const { res, state } = mockStreamResponse();
  const response = createResponse(res);

  async function* generate() {
    yield "data: hello\n\n";
  }

  await (response as any).stream(generate());
  assert("stream sets Content-Type to text/event-stream", state.headHeaders["content-type"] === "text/event-stream");
  assert("stream sets Cache-Control to no-cache", state.headHeaders["cache-control"] === "no-cache");
  assert("stream sets Connection to keep-alive", state.headHeaders["connection"] === "keep-alive");
  assert("stream sets X-Accel-Buffering to no", state.headHeaders["x-accel-buffering"] === "no");
  assert("stream sets status 200", state.headStatus === 200);
}

// --- stream() with custom content type ---
console.log("\n--- Custom Content-Type ---");

{
  const { res, state } = mockStreamResponse();
  const response = createResponse(res);

  async function* generate() {
    yield "binary chunk";
  }

  await (response as any).stream(generate(), "application/octet-stream");
  assert("stream custom content type is set", state.headHeaders["content-type"] === "application/octet-stream");
}

// --- stream() collects chunks ---
console.log("\n--- Chunk streaming ---");

{
  const { res, state } = mockStreamResponse();
  const response = createResponse(res);

  async function* generate() {
    yield "data: message 0\n\n";
    yield "data: message 1\n\n";
    yield "data: message 2\n\n";
  }

  await (response as any).stream(generate());
  assert("stream writes 3 chunks", state.chunks.length === 3);
  assert("first chunk is correct", state.chunks[0] === "data: message 0\n\n");
  assert("second chunk is correct", state.chunks[1] === "data: message 1\n\n");
  assert("third chunk is correct", state.chunks[2] === "data: message 2\n\n");
  assert("stream calls end()", state.ended === true);
}

// --- stream() single chunk ---
console.log("\n--- Single chunk ---");

{
  const { res, state } = mockStreamResponse();
  const response = createResponse(res);

  async function* generate() {
    yield "data: hello\n\n";
  }

  await (response as any).stream(generate());
  assert("single chunk is written", state.chunks.length === 1);
  assert("single chunk content is correct", state.chunks[0] === "data: hello\n\n");
}

// --- stream() SSE formatted messages ---
console.log("\n--- SSE formatted messages ---");

{
  const { res, state } = mockStreamResponse();
  const response = createResponse(res);

  async function* generate() {
    for (let i = 0; i < 5; i++) {
      yield `event: update\ndata: {"count":${i}}\n\n`;
    }
  }

  await (response as any).stream(generate());
  assert("SSE writes 5 chunks", state.chunks.length === 5);
  assert("first SSE chunk has event field", state.chunks[0].includes("event: update"));
  assert("first SSE chunk has count 0", state.chunks[0].includes('"count":0'));
  assert("last SSE chunk has count 4", state.chunks[4].includes('"count":4'));
}

// --- stream() returns the response ---
console.log("\n--- Return value ---");

{
  const { res } = mockStreamResponse();
  const response = createResponse(res);

  async function* generate() {
    yield "data: hello\n\n";
  }

  const result = await (response as any).stream(generate());
  assert("stream returns the response object", result === response);
}

// --- stream() with NDJSON ---
console.log("\n--- NDJSON streaming ---");

{
  const { res, state } = mockStreamResponse();
  const response = createResponse(res);

  async function* generate() {
    yield '{"event":"start"}\n';
    yield '{"event":"end"}\n';
  }

  await (response as any).stream(generate(), "application/x-ndjson");
  assert("NDJSON content type is set", state.headHeaders["content-type"] === "application/x-ndjson");
  assert("NDJSON writes 2 chunks", state.chunks.length === 2);
  assert("first NDJSON chunk is correct", state.chunks[0].includes('"event":"start"'));
  assert("second NDJSON chunk is correct", state.chunks[1].includes('"event":"end"'));
}

// --- stream() empty generator ---
console.log("\n--- Empty generator ---");

{
  const { res, state } = mockStreamResponse();
  const response = createResponse(res);

  async function* generate() {
    // empty
  }

  await (response as any).stream(generate());
  assert("empty generator writes no chunks", state.chunks.length === 0);
  assert("empty generator still calls end()", state.ended === true);
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
