/**
 * Feature 9: graceful shutdown (signal handling).
 *
 * Every case here spawns a REAL server as a CHILD PROCESS, issues a REAL slow
 * HTTP request over a REAL socket, sends a REAL POSIX signal to that process,
 * and reads the REAL exit code. There is no in-process seam that can honestly
 * test signal handling: calling a "handler" function directly proves only that
 * the function runs, not that the signal reaches it, not that the listener
 * stops accepting, and not what the process exits with. NO MOCKS.
 *
 * Two defects this file locks out, both measured before the fix:
 *
 *  1. A plain `startServer()` app trapped NOTHING. SIGTERM hit Node's default
 *     disposition: process gone in ~150ms, in-flight response dropped
 *     ("connection closed without response"), exit 143.
 *
 *  2. Registering ANY background() task made it WORSE. background.ts bound
 *     process.on("SIGTERM") handlers that only cleared timers and never
 *     exited. Adding a listener REPLACES Node's default disposition, so the
 *     process ignored SIGTERM entirely and ran forever, still answering 200s,
 *     until SIGKILL. Under Kubernetes that burns the whole
 *     terminationGracePeriodSeconds on every rolling deploy.
 *
 * Identical case names in all four frameworks:
 *   tina4-python/tests/test_graceful_shutdown.py
 *   tina4-php/tests/GracefulShutdownTest.php
 *   tina4-ruby/spec/graceful_shutdown_spec.rb
 *
 * PLATFORM: measured on macOS (Darwin). Signal delivery and socket teardown
 * differ on Linux; these assertions are written to be platform-independent
 * (drained / refused / exit code) rather than to pin Darwin timings.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection, createServer } from "node:net";
import { request } from "node:http";
import { randomBytes } from "node:crypto";
import { shutdownTimeoutSeconds, DEFAULT_SHUTDOWN_TIMEOUT_SECONDS } from "../packages/core/src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const TSX = join(REPO, "node_modules", ".bin", "tsx");

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Every child we start, so a thrown assertion still cannot leak a server. */
const spawned = new Set<ChildProcess>();

function reapAll(): void {
  for (const child of spawned) {
    if (!child.pid) continue;
    // Kill the process GROUP (negative pid) UNCONDITIONALLY, even when the
    // child handle already looks dead.
    //
    // tsx runs the real server as a CHILD of the wrapper this handle points
    // at. When a signal takes the wrapper down but not the server, exitCode
    // is set while the server keeps listening - so gating this on "handle
    // still alive" skips the one case that actually leaks. That is exactly
    // how three orphaned servers were left holding ports 49402/49564/49607
    // during this audit's own measurement run.
    //
    // killpg on an already-empty group throws ESRCH, which is why this is
    // wrapped rather than guarded.
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ }
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  spawned.clear();
}
process.on("exit", reapAll);

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => res(p));
    });
  });
}

function portAccepts(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((res) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    const done = (v: boolean) => { sock.destroy(); res(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

interface HttpOutcome { status?: number; body?: string; error?: string; elapsedMs: number }

function httpGet(port: number, path: string, timeoutMs = 30000): Promise<HttpOutcome> {
  const started = Date.now();
  return new Promise((res) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs },
      (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => res({ status: r.statusCode, body, elapsedMs: Date.now() - started }));
      },
    );
    req.once("error", (e) => res({ error: e.message, elapsedMs: Date.now() - started }));
    req.once("timeout", () => { req.destroy(); res({ error: "timeout", elapsedMs: Date.now() - started }); });
    req.end();
  });
}

interface Booted { child: ChildProcess; port: number; logPath: string }

/**
 * Write a real Tina4 app (file-based routes, exactly how a deployment declares
 * them) and boot it as a detached child.
 *
 * The child's stdout/stderr go to a FILE, never inherited. An inherited fd
 * keeps the runner's pipe open and wedges a piped `npm test` forever even
 * after the runner itself has finished.
 */
async function bootServer(opts: { withBackgroundTask?: boolean; slowSeconds?: number; env?: Record<string, string> } = {}): Promise<Booted> {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), "tina4-shutdown-"));
  const routes = join(root, "src", "routes");
  mkdirSync(join(routes, "fast"), { recursive: true });
  mkdirSync(join(routes, "slow"), { recursive: true });

  writeFileSync(join(root, "package.json"), '{"name":"shutdown-probe","type":"module","private":true}\n');
  writeFileSync(
    join(routes, "fast", "get.ts"),
    "export default async function (_req: any, res: any) { return res('FAST', 200); }\n",
  );
  // setTimeout is not signal-interruptible, so this handler genuinely occupies
  // the full duration. (A blocking sleep would return early on EINTR and make
  // a merely-interrupted handler look like a successful drain - that false
  // positive actually occurred while measuring PHP.)
  writeFileSync(
    join(routes, "slow", "get.ts"),
    "export default async function (_req: any, res: any) {\n" +
      `  await new Promise((r) => setTimeout(r, ${Math.round((opts.slowSeconds ?? 2) * 1000)}));\n` +
      "  return res('SLOW-DONE', 200);\n" +
      "}\n",
  );

  const bg = opts.withBackgroundTask
    ? `import { background } from '${REPO}/packages/core/src/background.ts';\nbackground(() => {}, 5);\n`
    : "";
  writeFileSync(
    join(root, "app.ts"),
    `import { startServer } from '${REPO}/packages/core/src/index.ts';\n` +
      bg +
      `await startServer({ port: ${port}, routesDir: '${routes}' } as never);\n`,
  );

  const logPath = join(root, "server.log");
  const logFd = openSync(logPath, "w");
  const child = spawn(TSX, ["app.ts"], {
    cwd: root,
    detached: true, // own process group, so we can signal the GROUP on cleanup
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      TINA4_OVERRIDE_CLIENT: "true",
      TINA4_NO_BROWSER: "true",
      TINA4_SUPPRESS: "true",
      TINA4_NO_AI_PORT: "true",
      TINA4_DEBUG: "false",
      PORT: String(port),
      ...(opts.env ?? {}),
    },
  });
  spawned.add(child);
  closeSync(logFd);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await portAccepts(port)) return { child, port, logPath };
    if (child.exitCode !== null) {
      throw new Error(`child died during boot:\n${readFileSync(logPath, "utf8").slice(-2000)}`);
    }
    await sleep(50);
  }
  throw new Error(`server never became ready on ${port}:\n${readFileSync(logPath, "utf8").slice(-2000)}`);
}

/** Resolves with how the child ended: a clean code, or the signal that killed it. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: string | null; timedOut: boolean }> {
  return new Promise((res) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      res({ code: child.exitCode, signal: child.signalCode, timedOut: false });
      return;
    }
    const timer = setTimeout(() => res({ code: null, signal: null, timedOut: true }), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      res({ code, signal, timedOut: false });
    });
  });
}

function kill(child: ChildProcess, signal: NodeJS.Signals): void {
  // Signal the process GROUP so tsx's node child receives it too - signalling
  // only the wrapper is how a "handled" signal silently never reaches the
  // server.
  if (child.pid) process.kill(-child.pid, signal);
}

async function cleanup(b: Booted): Promise<void> {
  // Unconditional group kill - see reapAll(). A dead wrapper handle is not
  // proof the server it spawned is dead.
  if (b.child.pid) {
    try { process.kill(-b.child.pid, "SIGKILL"); } catch { /* group already gone */ }
    await waitForExit(b.child, 5000);
  }
  spawned.delete(b.child);
  try { rmSync(dirname(b.logPath), { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log("=== Graceful Shutdown (real process, real signal) ===\n");

// ── The budget resolver ────────────────────────────────────────────────────
// A pure function over one env var: no dependency, no double. A typo must not
// silently become a zero-second budget, which would turn every shutdown into
// an immediate force-kill and look exactly like having no drain at all.
{
  const saved = process.env.TINA4_SHUTDOWN_TIMEOUT;
  const set = (v: string | undefined) => {
    if (v === undefined) delete process.env.TINA4_SHUTDOWN_TIMEOUT;
    else process.env.TINA4_SHUTDOWN_TIMEOUT = v;
  };
  try {
    set(undefined);
    assert("TINA4_SHUTDOWN_TIMEOUT defaults to 30 seconds",
      shutdownTimeoutSeconds() === 30 && DEFAULT_SHUTDOWN_TIMEOUT_SECONDS === 30,
      `(got ${shutdownTimeoutSeconds()})`);

    set("5");
    assert("TINA4_SHUTDOWN_TIMEOUT is honoured when numeric",
      shutdownTimeoutSeconds() === 5, `(got ${shutdownTimeoutSeconds()})`);

    set("0");
    assert("TINA4_SHUTDOWN_TIMEOUT=0 is honoured as an explicit no-wait",
      shutdownTimeoutSeconds() === 0, `(got ${shutdownTimeoutSeconds()})`);

    for (const bad of ["abc", "-5", "", "   "]) {
      set(bad);
      assert(`TINA4_SHUTDOWN_TIMEOUT=${JSON.stringify(bad)} falls back to 30, never 0`,
        shutdownTimeoutSeconds() === 30, `(got ${shutdownTimeoutSeconds()})`);
    }
  } finally {
    set(saved);
  }
}

// ── SIGTERM: the core contract ─────────────────────────────────────────────
{
  const b = await bootServer();
  try {
    const warmup = await httpGet(b.port, "/fast");
    assert("server is serving before the signal", warmup.status === 200 && warmup.body === "FAST",
      `(got ${warmup.status} ${warmup.body ?? warmup.error})`);

    // Fire the slow request, let it get INTO the handler, then signal.
    const inFlight = httpGet(b.port, "/slow");
    await sleep(600);
    const signalledAt = Date.now();
    kill(b.child, "SIGTERM");

    // Immediately after the signal the listener must be gone.
    await sleep(200);
    const stillAccepting = await portAccepts(b.port);
    const afterSignal = await httpGet(b.port, "/fast", 3000);

    const slow = await inFlight;
    const exit = await waitForExit(b.child, 40_000);

    assert("SIGTERM lets the in-flight request finish",
      slow.status === 200 && slow.body === "SLOW-DONE",
      `(got status=${slow.status} body=${slow.body} error=${slow.error} after ${slow.elapsedMs}ms)`);

    assert("SIGTERM stops accepting new connections",
      !stillAccepting && afterSignal.status === undefined,
      `(accepting=${stillAccepting} newRequest=${afterSignal.status ?? afterSignal.error})`);

    assert("SIGTERM exits with code 0",
      exit.code === 0 && exit.signal === null,
      `(code=${exit.code} signal=${exit.signal} timedOut=${exit.timedOut})`);

    // The drain must have actually WAITED - an exit faster than the remaining
    // handler time would mean the request was cut off, not drained.
    const drainMs = Date.now() - signalledAt;
    assert("SIGTERM drains rather than exiting immediately", drainMs >= 1000,
      `(exited ${drainMs}ms after the signal; the handler had ~1400ms left)`);

    assert("SIGTERM releases the listening port",
      !(await portAccepts(b.port)), "(port still accepting after exit)");
  } finally {
    await cleanup(b);
  }
}

// ── SIGINT: same contract ──────────────────────────────────────────────────
{
  const b = await bootServer();
  try {
    const inFlight = httpGet(b.port, "/slow");
    await sleep(600);
    kill(b.child, "SIGINT");
    const slow = await inFlight;
    const exit = await waitForExit(b.child, 40_000);

    assert("SIGINT lets the in-flight request finish",
      slow.status === 200 && slow.body === "SLOW-DONE",
      `(got status=${slow.status} body=${slow.body} error=${slow.error})`);
    assert("SIGINT exits with code 0",
      exit.code === 0 && exit.signal === null,
      `(code=${exit.code} signal=${exit.signal} timedOut=${exit.timedOut})`);
  } finally {
    await cleanup(b);
  }
}

// ── SIGHUP: deliberately NOT trapped ───────────────────────────────────────
// Pinned so nobody "fixes" this by accident. The Rust CLI owns file watching
// and production logs go to stdout, so neither Puma's log-reopen nor
// gunicorn's config-reload use for SIGHUP is a Tina4 need.
{
  const b = await bootServer();
  try {
    await sleep(200);
    kill(b.child, "SIGHUP");
    const exit = await waitForExit(b.child, 20_000);
    assert("SIGHUP is not trapped and terminates the process",
      !exit.timedOut && exit.code !== 0,
      `(code=${exit.code} signal=${exit.signal} timedOut=${exit.timedOut})`);
  } finally {
    await cleanup(b);
  }
}

// ── REGRESSION: the background() hang ──────────────────────────────────────
// background.ts used to bind process.on("SIGTERM", clearTimers) with no exit.
// Registering a listener REPLACES Node's default disposition, so a server with
// one background task ignored SIGTERM and ran forever. This is the exact
// scenario, with a real task registered.
{
  const b = await bootServer({ withBackgroundTask: true });
  try {
    const inFlight = httpGet(b.port, "/slow");
    await sleep(600);
    kill(b.child, "SIGTERM");
    const slow = await inFlight;
    const exit = await waitForExit(b.child, 40_000);

    assert("a registered background task does not block shutdown",
      !exit.timedOut && exit.code === 0,
      `(code=${exit.code} signal=${exit.signal} timedOut=${exit.timedOut} - a timeout here is the old hang)`);
    assert("a registered background task still drains the in-flight request",
      slow.status === 200 && slow.body === "SLOW-DONE",
      `(got status=${slow.status} body=${slow.body} error=${slow.error})`);
  } finally {
    await cleanup(b);
  }
}

// ── The shutdown budget is real, not decorative ────────────────────────────
// TINA4_SHUTDOWN_TIMEOUT=1 against a 6s handler: the process must give up and
// exit well before the handler would have finished. The in-flight request IS
// expected to be cut short here - that is the whole point of a bound.
{
  const b = await bootServer({ slowSeconds: 6, env: { TINA4_SHUTDOWN_TIMEOUT: "1" } });
  try {
    const inFlight = httpGet(b.port, "/slow", 20_000);
    await sleep(400);
    const signalledAt = Date.now();
    kill(b.child, "SIGTERM");
    const exit = await waitForExit(b.child, 20_000);
    const elapsed = Date.now() - signalledAt;
    void inFlight;

    assert("TINA4_SHUTDOWN_TIMEOUT bounds the drain",
      !exit.timedOut && exit.code === 0 && elapsed < 4000,
      `(exited after ${elapsed}ms with code=${exit.code}; the handler needed ~5600ms more, the budget was 1s)`);
  } finally {
    await cleanup(b);
  }
}

// ── WebSocket peers are told 1001 "going away" ─────────────────────────────
// RFC 6455 s7.4.1 defines 1001 for a server going down. A client told 1001
// reconnects on a schedule; a socket that just vanishes looks like a network
// fault and surfaces as an error. This uses a REAL raw RFC 6455 client over a
// REAL socket and reads the REAL close frame off the wire.
{
  const b = await bootServer({ env: { TINA4_DEBUG: "true", TINA4_NO_AI_PORT: "true" } });
  try {
    const key = randomBytes(16).toString("base64");
    const closeCode = await new Promise<number | string>((resolveCode) => {
      let handshakeDone = false;
      let buffered = Buffer.alloc(0);
      const settle = (v: number | string) => { try { sock.destroy(); } catch { /* gone */ } resolveCode(v); };
      const timer = setTimeout(() => settle("timeout waiting for a close frame"), 25_000);

      const sock = createConnection({ host: "127.0.0.1", port: b.port }, () => {
        sock.write(
          `GET /__dev_reload HTTP/1.1\r\nHost: 127.0.0.1:${b.port}\r\n` +
            `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });

      sock.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (!handshakeDone) {
          const headerEnd = buffered.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const head = buffered.subarray(0, headerEnd).toString();
          if (!head.includes("101")) { clearTimeout(timer); settle(`handshake refused: ${head.split("\r\n")[0]}`); return; }
          handshakeDone = true;
          buffered = buffered.subarray(headerEnd + 4);
          // Handshake is up. Now signal the server and wait for its close frame.
          setTimeout(() => kill(b.child, "SIGTERM"), 300);
        }
        // An unmasked server frame: [FIN|opcode][len][payload]. A close frame
        // carries the status code as a big-endian uint16 in its first 2 bytes.
        while (buffered.length >= 2) {
          const opcode = buffered[0] & 0x0f;
          const len = buffered[1] & 0x7f;
          if (len > 125 || buffered.length < 2 + len) break;
          const payload = buffered.subarray(2, 2 + len);
          buffered = buffered.subarray(2 + len);
          if (opcode === 0x8) {
            clearTimeout(timer);
            settle(payload.length >= 2 ? payload.readUInt16BE(0) : "close frame carried no code");
            return;
          }
        }
      });
      sock.on("close", () => { clearTimeout(timer); settle("socket closed with no close frame"); });
      sock.on("error", (e) => { clearTimeout(timer); settle(`socket error: ${e.message}`); });
    });

    assert("shutdown closes live WebSockets with RFC 6455 code 1001",
      closeCode === 1001, `(got ${JSON.stringify(closeCode)})`);

    const exit = await waitForExit(b.child, 40_000);
    assert("a live WebSocket does not block shutdown",
      !exit.timedOut && exit.code === 0,
      `(code=${exit.code} signal=${exit.signal} timedOut=${exit.timedOut})`);
  } finally {
    await cleanup(b);
  }
}

// ── TINA4_DEFAULT_WEBSERVER is accepted, and is a no-op here ───────────────
// Python and Ruby hand the socket to uvicorn / Puma in production, so there the
// var really switches servers. Node has only node:http, so there is nothing to
// switch. It still has to be ACCEPTED, because the env surface is uniform
// across the four and an operator setting it must not get an error or a dead
// server. Booting with it set and serving a real request is the whole contract.
{
  const b = await bootServer({ env: { TINA4_DEFAULT_WEBSERVER: "TRUE" } });
  try {
    const r = await httpGet(b.port, "/fast");
    assert("TINA4_DEFAULT_WEBSERVER is accepted and the server still serves",
      r.status === 200 && r.body === "FAST",
      `(got ${r.status} ${r.body ?? r.error})`);

    kill(b.child, "SIGTERM");
    const exit = await waitForExit(b.child, 40_000);
    assert("TINA4_DEFAULT_WEBSERVER does not change shutdown behaviour",
      !exit.timedOut && exit.code === 0,
      `(code=${exit.code} signal=${exit.signal} timedOut=${exit.timedOut})`);
  } finally {
    await cleanup(b);
  }
}

reapAll();
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
