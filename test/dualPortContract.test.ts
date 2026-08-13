/**
 * Feature 128 — dual development/test port (the "AI port" at base + 1000).
 *
 * While a developer edits code, the main dev port hot-reloads. In debug mode
 * Tina4 also opens a SECOND listener at base + 1000 serving the identical app
 * with the reload signal turned off — a stable connection for an AI agent, a
 * test runner, or an MCP session. See
 * tina4-documentation/plan/v3/features/128-dual-test-port.md and
 * tina4-documentation/plan/v3/OWNER-DECISIONS.md (DUALPORT-DEC-01/02).
 *
 * DUALPORT-DEC-01 (DUALPORT-TEST-GAP): Node already has the ONLY real
 * dual-port test of the four frameworks — test/aiPortRange.test.ts, which
 * pins a specific historical bug (an out-of-range derived port hanging
 * startServer()). That file is untouched and stays as its own regression.
 * This is a SEPARATE, NEW suite that ports its "real sockets, no mocks"
 * shape onto the four SHARED conformance cases named in
 * tina4-documentation/plan/v3/fixtures/dual_port_contract.json (identical
 * case names in Python/PHP/Ruby):
 *
 *   1. base + 1000 accepts a connection and serves the SAME app (a known
 *      route — /health — returns its real body).
 *   2. a reload-WebSocket UPGRADE on base + 1000 is REFUSED (404, not 101).
 *   3. TINA4_NO_AI_PORT=true leaves ONLY the base port listening.
 *   4. a BUSY base + 1000 (pre-bound by this test, before startServer() is
 *      even called) yields a WARNING and the base port still serves —
 *      non-fatal skip, deliberately the OPPOSITE of the main port's
 *      takeover (feature 129).
 *
 * DUALPORT-STABLE-SEMANTICS: "stable" means the CONNECTION and the reload
 * SIGNAL are stable, not a pinned code version — a hot-reload via
 * /__dev/api/reload is reflected on base + 1000 too, on the very next
 * request there.
 *
 * NO MOCKS: real `startServer()`, real ports found by really binding them,
 * real HTTP requests over real sockets, a real raw RFC 6455 upgrade
 * handshake, and the warning is read back out of the REAL log file the real
 * logger wrote (same technique as aiPortRange.test.ts).
 *
 * Mutation-proved (2026-08-13, macOS + the Linux lab): temporarily changing
 * server.ts's gate from `isDebug && !noAiPort` to `isDebug` (ignoring
 * TINA4_NO_AI_PORT) turns no_ai_port_env_leaves_only_the_base_port RED — the
 * AI port opens anyway. Reverted.
 *
 * Case 4 retries its first request through getSettled() — see the comment
 * there for the measured startup-window finding.
 *
 * Run with: npx tsx test/dualPortContract.test.ts
 */
import net from "node:net";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the REAL logger at a real file before anything imports it (same
// technique as aiPortRange.test.ts) — needed only for case 4's warning check.
const LOG_DIR = mkdtempSync(join(tmpdir(), "tina4-dualport-log-"));
process.env.TINA4_LOG_OUTPUT = "file";
process.env.TINA4_LOG_DIR = LOG_DIR;
process.env.TINA4_LOG_LEVEL = "DEBUG";
process.env.TINA4_LOG_FORMAT = "json";
process.env.TINA4_SUPPRESS = "true";
process.env.TINA4_NO_BROWSER = "true";
process.env.TINA4_RATE_LIMIT = "10000";
process.env.TINA4_OVERRIDE_CLIENT = "true";

const { startServer } = await import("../packages/core/src/index.ts");

const LOG_FILE = join(LOG_DIR, "tina4.log");
const logSize = (): number => { try { return statSync(LOG_FILE).size; } catch { return 0; } };
const logSince = (from: number): string => {
  const size = logSize();
  if (size <= from) return "";
  return readFileSync(LOG_FILE).subarray(from, size).toString("utf-8");
};

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

/** Really bind the port, then release it. No guessing about availability. */
function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/** A base port whose derived AI port (base + 1000) is legal AND free. */
async function freeBaseWithHeadroom(): Promise<number> {
  for (let p = 21500; p < 22000; p++) {
    if ((await bindable(p)) && (await bindable(p + 1000))) return p;
  }
  throw new Error("could not find a free base port pair in 21500-22000 (+1000)");
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

/**
 * Case 4 only: retry a GET that resets the very first connection.
 *
 * MEASURED (2026-08-13, Linux lab): immediately after startServer() resolves
 * with the AI port busy (aiServer's EADDRINUSE handler firing asynchronously
 * right around the same moment), the base port's very first request can come
 * back "socket hang up" (ECONNRESET) before settling — reproduced in complete
 * isolation, not just under full-suite contention. A fixed sleep before the
 * first attempt masks it; a bounded retry proves the base port recovers on
 * its own within a short window without weakening what case 4 asserts.
 */
async function getSettled(
  port: number,
  path: string,
  attempts = 5,
): Promise<{ status: number; body: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await get(port, path);
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw lastError;
}

/** Real RFC 6455 upgrade request; returns the response's first status line. */
function wsUpgradeStatusLine(port: number, path: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      const key = Buffer.from(String(Math.random())).toString("base64").slice(0, 24);
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, timeoutMs);
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      if (buf.includes("\r\n")) {
        clearTimeout(timer);
        socket.destroy();
        resolve(buf.split("\r\n")[0]);
      }
    });
    socket.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function project(name: string): string {
  const dir = join(tmpdir(), `tina4-dualport-${process.pid}-${name}-${Date.now()}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src", "routes"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  return dir;
}

async function boot(dir: string, port: number, noAiPort: boolean): Promise<any> {
  process.env.TINA4_DEBUG = "true";
  if (noAiPort) process.env.TINA4_NO_AI_PORT = "true";
  else delete process.env.TINA4_NO_AI_PORT;

  return startServer({
    port,
    host: "127.0.0.1",
    routesDir: join(dir, "src/routes"),
    modelsDir: join(dir, "src/models"),
    staticDir: join(dir, "public"),
  } as any);
}

console.log("=== Dual development/test port (feature 128) ===\n");

// ── 1. debug_mode_opens_the_ai_port_at_base_plus_1000 ────────────────────────
{
  const base = await freeBaseWithHeadroom();
  const dir = project("case1");
  const server = await boot(dir, base, false);
  try {
    const r = await get(base + 1000, "/health");
    assert(
      "debug_mode_opens_the_ai_port_at_base_plus_1000: status",
      r.status === 200,
      `GET 127.0.0.1:${base + 1000}/health -> ${r.status}`,
    );
    assert(
      "debug_mode_opens_the_ai_port_at_base_plus_1000: serves the same app",
      r.body.includes("tina4-nodejs"),
      `body: ${r.body.slice(0, 200)}`,
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 2. the_ai_port_refuses_a_reload_websocket_upgrade ────────────────────────
{
  const base = await freeBaseWithHeadroom();
  const dir = project("case2");
  const server = await boot(dir, base, false);
  try {
    const statusLine = await wsUpgradeStatusLine(base + 1000, "/__dev_reload");
    assert(
      "the_ai_port_refuses_a_reload_websocket_upgrade: 404",
      statusLine.includes("404"),
      `status line: ${statusLine}`,
    );
    assert(
      "the_ai_port_refuses_a_reload_websocket_upgrade: never 101",
      !statusLine.includes("101"),
      `status line: ${statusLine}`,
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 3. no_ai_port_env_leaves_only_the_base_port ──────────────────────────────
{
  const base = await freeBaseWithHeadroom();
  const dir = project("case3");
  const server = await boot(dir, base, true);
  try {
    const r = await get(base, "/health");
    assert("no_ai_port_env_leaves_only_the_base_port: base port serves", r.status === 200, String(r.status));

    const stillFree = await bindable(base + 1000);
    assert(
      "no_ai_port_env_leaves_only_the_base_port: nothing on base+1000",
      stillFree,
      `base+1000 was NOT rebindable — something is still listening on ${base + 1000}`,
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 4. a_busy_ai_port_is_skipped_without_failing_the_base_port ──────────────
{
  const base = await freeBaseWithHeadroom();
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(base + 1000, "127.0.0.1", () => resolve());
  });

  const dir = project("case4");
  const from = logSize();
  let server: any = null;
  try {
    server = await boot(dir, base, false);

    const r = await getSettled(base, "/health");
    assert(
      "a_busy_ai_port_is_skipped_without_failing_the_base_port: base port still serves",
      r.status === 200,
      `GET 127.0.0.1:${base}/health -> ${r.status}`,
    );

    const written = logSince(from);
    assert(
      "a_busy_ai_port_is_skipped_without_failing_the_base_port: warns and names the port",
      written.includes(String(base + 1000)) && /in use/i.test(written) && /skip/i.test(written),
      `log delta: ${written.slice(0, 400)}`,
    );

    // Our own blocker is still the one holding the port — the server never
    // touched it.
    const stillBlocked = await bindable(base + 1000);
    assert(
      "a_busy_ai_port_is_skipped_without_failing_the_base_port: our blocker is untouched",
      !stillBlocked,
      `base+1000 should still be held by OUR blocker`,
    );
  } finally {
    if (server) server.close();
    await new Promise((r) => blocker.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}

delete process.env.TINA4_DEBUG;
delete process.env.TINA4_NO_AI_PORT;
delete process.env.TINA4_OVERRIDE_CLIENT;
delete process.env.TINA4_RATE_LIMIT;
delete process.env.TINA4_NO_BROWSER;
delete process.env.TINA4_SUPPRESS;
rmSync(LOG_DIR, { recursive: true, force: true });

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

if (fail > 0) process.exitCode = 1;
