/**
 * Regression test for nodejs #33 — malformed request-target must NOT crash the
 * worker (P1, security / unauthenticated remote DoS).
 *
 * `GET //` (also `///` and `/\`) throws `ERR_INVALID_URL` in the WHATWG `URL`
 * parser used by createRequest(). That parse runs BEFORE the dispatch try/catch,
 * and the uncaughtException net is only wired under TINA4_DEBUG — so in
 * PRODUCTION (debug unset) an unguarded throw took the worker down. Scanners
 * send `//` routinely, so this was a trivially-triggerable remote DoS.
 *
 * This test boots a REAL server (in-process, so a crash would kill this test
 * process too — the strongest possible proof of survival) with TINA4_DEBUG
 * explicitly UNSET, then for each malformed target opens a RAW TCP socket and
 * writes a literal `GET <target> HTTP/1.1` request line (http.request() would
 * normalise/refuse these, so a raw socket is required). It asserts:
 *   1. the malformed request gets a clean 4xx (a normal 404), and
 *   2. the server still answers a following NORMAL request (it did not crash).
 *
 * Run with: npx tsx test/malformedPath.test.ts
 */
import net from "node:net";
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// The fix must work with the dev-only ErrorTracker absent — force prod-shape env.
delete process.env.TINA4_DEBUG;
delete process.env.TINA4_PRODUCTION;

const TEST_DIR = "/tmp/tina4-malformed-path-test";
const PORT = 3418;
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

/**
 * Send a literal request-target down a raw TCP socket and return the HTTP
 * status code parsed from the response status line. Rejects on connection
 * failure (which is exactly what a crashed server would produce).
 */
function rawRequestStatus(target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let raw = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, 3000);
    socket.connect(PORT, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => { raw += chunk.toString("latin1"); });
    socket.on("end", () => {
      clearTimeout(timer);
      const statusLine = raw.split("\r\n")[0] ?? "";
      const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
      if (m) resolve(parseInt(m[1], 10));
      else reject(new Error(`no status line in response: ${JSON.stringify(raw.slice(0, 80))}`));
    });
    socket.on("error", reject);
  });
}

/** A normal in-process request via http.request (proves the server survived). */
function normalRequestStatus(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: PORT, path, method: "GET" }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject);
    req.end();
  });
}

// Clean slate — one real route so the "normal following request" has a 200 target.
try { rmSync(TEST_DIR, { recursive: true }); } catch {}
mkdirSync(join(TEST_DIR, "src/routes/ok"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, "src/routes/ok/get.ts"), `
export default async function(req: any, res: any) {
  res.json({ ok: true });
}
`);

// Keep the run single-process and quiet.
process.env.TINA4_RATE_LIMIT = "100000";

const { startServer } = await import("../packages/core/src/index.ts");

console.log("=== #33 malformed-path crash guard (TINA4_DEBUG unset) ===\n");

const server = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});

try {
  // Sanity: the real route answers before we send anything malformed.
  assert("baseline: normal request returns 200", (await normalRequestStatus("/ok")) === 200);

  // The three malformed targets from the issue. Each must yield a clean 4xx
  // (a normal 404) — NOT crash the worker — and the server must survive.
  for (const target of ["//", "///", "/\\"]) {
    let status = 0;
    let crashed = false;
    try {
      status = await rawRequestStatus(target);
    } catch (err) {
      crashed = true;
      console.log(`    (raw request for ${JSON.stringify(target)} failed: ${(err as Error).message})`);
    }
    assert(
      `malformed target ${JSON.stringify(target)} returns a clean 4xx (no crash)`,
      !crashed && status >= 400 && status < 500,
      `(crashed=${crashed} status=${status})`,
    );
    // The server must still answer a NORMAL request afterwards.
    let survived = false;
    try {
      survived = (await normalRequestStatus("/ok")) === 200;
    } catch { survived = false; }
    assert(
      `server survives ${JSON.stringify(target)} and still serves a normal request`,
      survived,
    );
  }
} finally {
  server.close();
  try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  delete process.env.TINA4_RATE_LIMIT;
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
