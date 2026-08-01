/**
 * The AI/test port is DERIVED (base + 1000) — and a derived port is still a port.
 *
 * THE BUG this pins (measured, not theorised): in debug mode `startServer()`
 * created a second "stable AI port" listener on `port + 1000` and called
 * `listen()` on it without checking the result was still a legal port. Node's
 * `listen()` validates the number and throws `ERR_SOCKET_BAD_PORT`
 * SYNCHRONOUSLY for anything above 65535, so any base port above 64535 threw
 * inside the MAIN server's listen callback — above the `resolvePromise(...)`
 * at the end of it. Two things then made it silent instead of loud:
 *
 *   1. debug mode registers devAdmin's ErrorTracker, whose
 *      `process.on("uncaughtException")` handler RECORDS the error and returns,
 *      so the process did not die;
 *   2. the callback never reached `resolvePromise`, so `await startServer(...)`
 *      never settled.
 *
 * The result was a half-started server: the main port bound and serving, the
 * caller's `await` hung forever. In the test suite that is a file that prints
 * no summary line and gets killed by the runner's 60s timeout — the exact
 * "died before reporting" shape. On this host `test/integration.ts` takes an
 * OS-assigned ephemeral port (macOS hands out 49152-65535), so roughly one run
 * in sixteen drew a base above 64535 and the whole file vanished from the
 * count. For an operator it is worse than a test flake: `PORT=65000
 * TINA4_DEBUG=true` hangs on boot with no error printed.
 *
 * NO MOCKS: real `startServer`, real ports found by really binding them, real
 * HTTP requests over a real socket, and the warning is read back out of the
 * REAL log file the real logger wrote.
 *
 * Run with: npx tsx test/aiPortRange.test.ts
 */
import net from "node:net";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the REAL logger at a real file before anything imports it; the logger
// resolves its destination per call, so this is honest about production.
const LOG_DIR = mkdtempSync(join(tmpdir(), "tina4-aiport-log-"));
process.env.TINA4_LOG_OUTPUT = "file";
process.env.TINA4_LOG_DIR = LOG_DIR;
process.env.TINA4_LOG_LEVEL = "DEBUG";
process.env.TINA4_LOG_FORMAT = "json";
process.env.TINA4_SUPPRESS = "true";     // no boot banner in the test output
process.env.TINA4_NO_BROWSER = "true";
process.env.TINA4_RATE_LIMIT = "10000";
process.env.TINA4_DEBUG = "true";        // dual-port mode is a DEBUG feature
delete process.env.TINA4_NO_AI_PORT;     // the AI port must be live for this test

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

/** Is anything accepting connections here right now? A real TCP connect. */
function listening(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once("connect", () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}

function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", timeout: 8000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

/**
 * startServer() with a deadline. The bug makes the promise NEVER settle, and a
 * test that hangs forever is not a test — the runner kills it and reports no
 * result at all. The deadline turns "never resolved" into a reported failure.
 */
async function startWithin(ms: number, opts: Record<string, unknown>): Promise<any | null> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((r) => { timer = setTimeout(() => r(null), ms); });
  try {
    return await Promise.race([startServer(opts as any), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A base port ABOVE 64535, so base + 1000 leaves the legal range. */
async function highBase(): Promise<number | null> {
  for (let p = 65500; p > 64535; p--) if (await bindable(p)) return p;
  return null;
}

/** A base port whose derived AI port (base + 1000) is legal AND free. */
async function lowBase(): Promise<number | null> {
  for (let p = 21000; p < 21500; p++) {
    if (await bindable(p) && await bindable(p + 1000)) return p;
  }
  return null;
}

function project(name: string): string {
  const dir = join(tmpdir(), `tina4-aiport-${process.pid}-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src", "routes"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  return dir;
}

console.log("=== AI/test port range (dual-port debug mode) ===\n");

// ── POSITIVE: the derived AI port is out of range ────────────────────────────
console.log("--- base port above 64535 (base + 1000 > 65535) ---");
{
  const base = await highBase();
  if (base === null) {
    // Loud, not silent: name what could not be obtained.
    console.log("  \x1b[33mSKIP\x1b[0m no free base port in 64536-65500 on 127.0.0.1 — cannot drive an out-of-range derived port");
    fail++;   // never let this read green: the case did not run
  } else {
    const dir = project("high");
    const from = logSize();
    const srv = await startWithin(15_000, {
      port: base,
      host: "127.0.0.1",
      routesDir: join(dir, "src/routes"),
      modelsDir: join(dir, "src/models"),
      staticDir: join(dir, "public"),
    });

    assert(
      "startServer RESOLVES when the derived AI port would be out of range",
      srv !== null,
      `base=${base}, derived=${base + 1000}: startServer never settled within 15s`,
    );

    let status = 0;
    try { status = await get(base, "/health"); } catch (err) { status = -1; }
    assert(
      "the main port still serves a real request after the AI port was skipped",
      status > 0,
      `GET http://127.0.0.1:${base}/health -> ${status}`,
    );

    const written = logSince(from);
    assert(
      "a WARNING names the out-of-range derived port instead of skipping silently",
      written.includes(String(base + 1000)) && /out of range/i.test(written),
      `log delta: ${written.slice(0, 400)}`,
    );

    if (srv) srv.close();
    await new Promise((r) => setTimeout(r, 150));
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── NEGATIVE CONTROL: the derived AI port is legal and MUST still bind ───────
// Without this, "skip the AI port" passes for a fix that just deletes the
// dual-port feature.
console.log("\n--- base port below 64536 (base + 1000 is legal) ---");
{
  const base = await lowBase();
  if (base === null) {
    console.log("  \x1b[33mSKIP\x1b[0m no free base port pair in 21000-21500 (+1000) on 127.0.0.1");
    fail++;
  } else {
    const dir = project("low");
    const srv = await startWithin(15_000, {
      port: base,
      host: "127.0.0.1",
      routesDir: join(dir, "src/routes"),
      modelsDir: join(dir, "src/models"),
      staticDir: join(dir, "public"),
    });

    assert("startServer resolves for an in-range derived port", srv !== null,
      `base=${base}: startServer never settled within 15s`);

    let status = 0;
    try { status = await get(base, "/health"); } catch { status = -1; }
    assert("the main port serves a real request in the in-range case", status > 0,
      `GET http://127.0.0.1:${base}/health -> ${status}`);

    assert(
      "the stable AI port (base + 1000) is REALLY listening when it is in range",
      await listening(base + 1000),
      `nothing accepted a connection on 127.0.0.1:${base + 1000}`,
    );

    if (srv) srv.close();
    await new Promise((r) => setTimeout(r, 150));
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

rmSync(LOG_DIR, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
