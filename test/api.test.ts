/**
 * Unit tests for the Api HTTP client (packages/core/src/api.ts).
 * Covers construction/options and the opt-in retry/backoff feature.
 * Run with: npx tsx test/api.test.ts
 */
import { Api } from "../packages/core/src/api.ts";
import http from "node:http";
import type { AddressInfo } from "node:net";

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

/**
 * Tiny local server that returns 503 for the first `failFirst` requests then
 * 200, counting every request it receives. Returned `count()` lets tests
 * assert how many attempts the client actually made.
 */
function makeServer(failFirst: number, okBody: unknown = { ok: true }) {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    if (count <= failFirst) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unavailable", attempt: count }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(okBody));
    }
  });
  return {
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          resolve((server.address() as AddressInfo).port);
        });
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    count: () => count,
  };
}

/** Server that always returns the given status, counting requests. */
function makeStatusServer(status: number) {
  let count = 0;
  const server = http.createServer((_req, res) => {
    count++;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status }));
  });
  return {
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          resolve((server.address() as AddressInfo).port);
        });
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    count: () => count,
  };
}

console.log("=== Api Client Tests ===\n");

// ── Constructor / options ───────────────────────────────────────────────

{
  const api = new Api("https://api.example.com/");
  // baseUrl trailing slash stripped — verify via buildUrl behaviour through a
  // private field check is not possible, so assert the object constructs.
  assert("constructs with positional baseUrl", api instanceof Api);
}

{
  // Legacy positional form (baseUrl, authHeader, timeout)
  const api = new Api("https://api.example.com", "Bearer xyz", 15);
  assert("constructs with positional authHeader + timeout", api instanceof Api);
}

{
  // Options bag: bearer token
  const api = new Api("https://api.example.com", { bearerToken: "sk-abc" });
  assert("constructs with bearerToken option", api instanceof Api);
}

{
  // Options bag: basic auth + custom headers + timeout
  const api = new Api("https://api.example.com", {
    username: "u",
    password: "p",
    headers: { "X-Tenant": "acme" },
    timeout: 5,
  });
  assert("constructs with basic-auth + headers + timeout", api instanceof Api);
}

{
  // Retry options stored and clamped (negative -> 0)
  const api = new Api("https://api.example.com", { maxRetries: 3, retryBackoff: 0.01 });
  assert("constructs with maxRetries + retryBackoff", api instanceof Api);
  assert("maxRetries field set", (api as any).maxRetries === 3);
  assert("retryBackoff field set", (api as any).retryBackoff === 0.01);

  const clamped = new Api("https://api.example.com", { maxRetries: -5 });
  assert("negative maxRetries clamps to 0", (clamped as any).maxRetries === 0);

  const defaults = new Api("https://api.example.com");
  assert("default maxRetries is 0 (off)", (defaults as any).maxRetries === 0);
  assert("default retryBackoff is 0.5", (defaults as any).retryBackoff === 0.5);

  // setter helpers still work post-construction
  api.addHeaders({ "X-Trace": "1" });
  api.setBearerToken("tok");
  api.setBasicAuth("a", "b");
  api.setIgnoreSsl(true);
  assert("setter helpers do not throw", true);
}

// ── (a) default (maxRetries=0) makes ONE attempt on 503 ──────────────────

{
  const srv = makeServer(99); // always 503
  const port = await srv.listen();
  const api = new Api(`http://127.0.0.1:${port}`, { retryBackoff: 0.01 });
  const r = await api.get("/");
  await srv.close();

  assert("(a) default: returns 503", r.http_code === 503);
  assert("(a) default: exactly ONE attempt", srv.count() === 1, `got ${srv.count()}`);
  // Negative: did NOT silently succeed or retry
  assert("(a) default: not a 200", r.http_code !== 200);
}

// ── (b) 503-then-200 recovers in 2 attempts ──────────────────────────────

{
  const srv = makeServer(1, { recovered: true }); // 1st 503, then 200
  const port = await srv.listen();
  const api = new Api(`http://127.0.0.1:${port}`, { maxRetries: 3, retryBackoff: 0.01 });
  const r = await api.get("/");
  await srv.close();

  assert("(b) 503-then-200: returns 200", r.http_code === 200);
  assert("(b) 503-then-200: body parsed", (r.body as any).recovered === true);
  assert("(b) 503-then-200: exactly 2 attempts", srv.count() === 2, `got ${srv.count()}`);
}

// ── (c) transport-error-then-200 recovers ────────────────────────────────

{
  // Start a server that recovers, but point the FIRST attempt at a dead port.
  // To exercise transport-error recovery deterministically we use a server
  // that the client can reach, started AFTER the Api is pointed at it.
  // Approach: bind a server, capture port, then on the first request destroy
  // the socket (transport error) and serve 200 thereafter.
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    if (count === 1) {
      // Hard transport failure on the first attempt
      req.destroy();
      res.destroy();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ healed: true }));
    }
  });
  const port: number = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

  const api = new Api(`http://127.0.0.1:${port}`, { maxRetries: 3, retryBackoff: 0.01 });
  const r = await api.get("/");
  await new Promise<void>((resolve) => server.close(() => resolve()));

  assert("(c) transport-error-then-200: returns 200", r.http_code === 200, JSON.stringify(r));
  assert("(c) transport-error-then-200: body parsed", (r.body as any).healed === true);
  assert("(c) transport-error-then-200: at least 2 attempts", count >= 2, `got ${count}`);
  assert("(c) transport-error-then-200: error cleared on recovery", r.error === null);
}

// ── (d) exhaust retries returns the last 503 ─────────────────────────────

{
  const srv = makeServer(99); // always 503
  const port = await srv.listen();
  const api = new Api(`http://127.0.0.1:${port}`, { maxRetries: 2, retryBackoff: 0.01 });
  const r = await api.get("/");
  await srv.close();

  assert("(d) exhaust: returns last 503", r.http_code === 503);
  assert("(d) exhaust: maxRetries=2 => 3 attempts", srv.count() === 3, `got ${srv.count()}`);
  // Negative: not a transport-null and not a 200
  assert("(d) exhaust: http_code is not null", r.http_code !== null);
}

// ── (e) 404 is NOT retried (non-retryable 4xx) ───────────────────────────

{
  const srv = makeStatusServer(404);
  const port = await srv.listen();
  const api = new Api(`http://127.0.0.1:${port}`, { maxRetries: 5, retryBackoff: 0.01 });
  const r = await api.get("/missing");
  await srv.close();

  assert("(e) 404: returns 404", r.http_code === 404);
  assert("(e) 404: NOT retried — exactly 1 attempt", srv.count() === 1, `got ${srv.count()}`);
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
