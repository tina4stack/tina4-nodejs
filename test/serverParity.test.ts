/**
 * Tests for Server cross-framework parity: handle(), start(), stop().
 *
 * The framework refuses to boot without the tina4 Rust CLI unless
 * TINA4_OVERRIDE_CLIENT is set. Tests bypass that guard so start() can run.
 *
 * These exercise the REAL server lifecycle: routes are registered on the
 * default router, start() binds a real socket, requests travel over a real
 * loopback TCP connection (no mocks/stubs/fakes), and stop() must genuinely
 * close the listener so a subsequent connection is refused (ECONNREFUSED).
 */
process.env.TINA4_OVERRIDE_CLIENT = "true";
// Keep the banner + browser-open + AI dual-port out of the test run.
process.env.TINA4_SUPPRESS = "true";
process.env.TINA4_NO_BROWSER = "true";
process.env.TINA4_NO_AI_PORT = "true";
import assert from "node:assert";
import http, { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import { handle, start, stop, startServer } from "../packages/core/src/server.js";
import { get, defaultRouter } from "../packages/core/src/router.js";

// ── Real-IO helpers (no mocks) ───────────────────────────────────────────

/** Perform a real HTTP GET over loopback; resolve with status + body text. */
function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body: raw }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Open a raw TCP connection to a port and resolve with whether it was REFUSED.
 * Proves the listener is gone after stop() — a refused connect (ECONNREFUSED)
 * means nothing is accepting on that port anymore.
 */
function connectRefused(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      // Connected — port is still listening, NOT refused.
      socket.destroy();
      resolvePromise(false);
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      socket.destroy();
      resolvePromise(err.code === "ECONNREFUSED");
    });
  });
}

async function testStartAndStop() {
  // Register a real route BEFORE start() so it is merged into the server's
  // router at boot. The handler's body is what we assert reaches the client.
  get("/__test/start-and-stop", async (_req, res) => { res.send("start-stop-OK"); });

  const port = 17148;
  const srv = await start({ port });
  try {
    assert.ok(srv, "start() should return a server handle");
    assert.ok(typeof srv.close === "function", "handle should have close()");
    // The bound port must be the requested port, not merely "a number".
    assert.strictEqual(srv.port, port, `handle.port should be the bound port ${port}`);

    // Drive a real request through the running server and assert the route's
    // handler output reaches us — proves start() actually serves traffic.
    const res = await httpGet(port, "/__test/start-and-stop");
    assert.strictEqual(res.status, 200, "registered route should respond 200");
    assert.strictEqual(res.body, "start-stop-OK", "response body must be the handler output");
  } finally {
    stop();
  }

  // After stop() the listener must be gone: a fresh connection is refused.
  // Poll briefly because the OS reclaims the socket asynchronously.
  let refused = false;
  for (let i = 0; i < 50 && !refused; i++) {
    refused = await connectRefused(port);
    if (!refused) await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(refused, `port ${port} should refuse connections after stop()`);

  console.log("  + start() serves a real route then stop() closes the listener");
}

async function testHandleExists() {
  // Before any startServer(), handle() must refuse — there is no dispatcher yet.
  // (This case runs FIRST, so _dispatchFn is still null at this point.)
  await assert.rejects(
    () => handle({} as IncomingMessage, {} as ServerResponse),
    /Tina4 server not started/,
    "handle() must throw before startServer() is called",
  );

  // Register a route, start the server (which wires up handle()'s dispatcher),
  // then feed handle() a REAL IncomingMessage/ServerResponse pair produced by a
  // throwaway http.Server whose request listener delegates to handle(). The
  // response we read back is whatever the matched route handler wrote.
  get("/__test/handle", async (_req, res) => { res.json({ via: "handle", ok: true }); });

  const port = 17149;
  const srv = await start({ port });

  // A second loopback server that does NOTHING but forward to handle(). This
  // gives us genuine node:http objects — no hand-rolled request/response.
  const proxy = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end("handle threw");
      }
    });
  });
  const proxyPort = 17150;
  await new Promise<void>((r) => proxy.listen(proxyPort, "127.0.0.1", r));

  try {
    const res = await httpGet(proxyPort, "/__test/handle");
    assert.strictEqual(res.status, 200, "handle() should drive the route to a 200");
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.via, "handle", "body must come from the matched route handler");
    assert.strictEqual(parsed.ok, true, "handler payload must round-trip through handle()");
  } finally {
    await new Promise<void>((r) => proxy.close(() => r()));
    stop();
  }

  console.log("  + handle() throws before start and drives a real route after start");
}

async function testStopWithoutStart() {
  // stop() with no running server must be a safe no-op (no throw).
  stop();
  stop(); // idempotent — calling twice is also safe.

  // Behavioural proof that the no-op did not leave a half-started server: a
  // fresh start() afterwards binds and serves correctly, and stop() then truly
  // closes the listener (subsequent connect is REFUSED).
  get("/__test/stop-noop", async (_req, res) => { res.send("noop-then-serve"); });

  const port = 17151;
  const srv = await start({ port });
  try {
    assert.strictEqual(srv.port, port, "start() after a bare stop() should bind the requested port");
    const res = await httpGet(port, "/__test/stop-noop");
    assert.strictEqual(res.status, 200, "server started after a no-op stop() should serve");
    assert.strictEqual(res.body, "noop-then-serve", "route body must reach the client");
  } finally {
    stop();
  }

  let refused = false;
  for (let i = 0; i < 50 && !refused; i++) {
    refused = await connectRefused(port);
    if (!refused) await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(refused, `port ${port} should refuse connections after stop()`);

  console.log("  + stop() without start() is a safe no-op and never corrupts later start()/stop()");
}

async function main() {
  console.log("Server Parity Tests");

  let passed = 0;
  let failed = 0;
  const tests = [testHandleExists, testStopWithoutStart, testStartAndStop];
  for (const t of tests) {
    try {
      await t();
      passed++;
    } catch (err) {
      console.error(`  \x1b[31m✗\x1b[0m ${t.name} threw: ${err instanceof Error ? err.message : err}`);
      failed++;
    } finally {
      // Defensive: never leak a listener between cases. defaultRouter routes
      // are harmless to leave registered (unique /__test/* paths).
      try { stop(); } catch { /* already stopped */ }
    }
  }
  // Silence the unused-import lint for startServer (kept for API surface parity
  // with the cross-framework test set) without changing the import list.
  void startServer;
  void defaultRouter;
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
