/**
 * Default-CSP warn-once — the visible half of the secure-by-default CSP.
 *
 * Issue tina4-nodejs#61. `default-src 'self'` stays the secure default, but when
 * TINA4_CSP is unset the framework says so ONCE per process, so a cross-origin app
 * (runtime inline styles, CDN fonts/scripts, a separate API/LiveKit WebSocket) is
 * not silently broken with the failure only visible in the browser at runtime.
 *
 * NO MOCKS — a REAL @tina4/core server is booted with startServer, REAL HTTP
 * requests are made, and the ACTUAL log the server writes (forced to a file sink
 * via TINA4_LOG_FILE) is read back and counted.
 *
 * Three rules:
 *  1. TINA4_CSP unset -> the warning is emitted exactly ONCE across many requests.
 *  2. TINA4_CSP set   -> NO new warning (the app opted in).
 *  3. Behaviour is UNCHANGED: the CSP header is still `default-src 'self'` when
 *     unset, and reflects the value once set.
 *
 * Mutation-proved: drop the warnCspDefaultOnce() call and rule 1 goes RED; warn on
 * every request (remove the ledger guard) and "exactly once" goes RED.
 *
 * Same case names in all four:
 *   tina4-python/tests/test_csp_default_warning.py
 *   tina4-php/tests/CspDefaultWarningTest.php
 *   tina4-ruby/spec/csp_default_warning_spec.rb
 *
 * Run with: npx tsx test/cspDefaultWarning.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import http from "node:http";
import os from "node:os";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { freePort } from "./freePort.ts";

const TEST_DIR = join(os.tmpdir(), "tina4-csp-warn-test");
const LOG_FILE = join(TEST_DIR, "tina4.log");
const MARK = "TINA4_CSP is not set";
const PORT = await freePort();
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

function getHeaders(): Promise<http.IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path: "/api/ping", method: "GET" },
      (res) => {
        res.on("data", () => { /* drain */ });
        res.on("end", () => resolve(res.headers));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function markCount(): Promise<number> {
  // Small flush window so the synchronous append is on disk before we read.
  await new Promise((r) => setTimeout(r, 50));
  if (!existsSync(LOG_FILE)) return 0;
  return readFileSync(LOG_FILE, "utf8").split("\n").filter((l) => l.includes(MARK)).length;
}

// Clean slate + a single route so the server has something to serve.
try { rmSync(TEST_DIR, { recursive: true }); } catch { /* fresh */ }
mkdirSync(join(TEST_DIR, "src/routes/api/ping"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, "src/routes/api/ping/get.ts"), `
export default async function (req: any, res: any) {
  return res.json({ ok: true });
}
`);

// Baseline: rate limiter out of the way, CSP unset, and the log forced to a FILE
// so the real warning is captured (TINA4_LOG_FILE always forces a file sink).
process.env.TINA4_RATE_LIMIT = "100000";
delete process.env.TINA4_CSP;
process.env.TINA4_LOG_OUTPUT = "file";
process.env.TINA4_LOG_FILE = LOG_FILE;

console.log("=== Default-CSP warn-once Tests ===\n");

const server = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});

// --- Rule 1: unset -> warns exactly once, header unchanged ---
{
  const h1 = await getHeaders();
  await getHeaders();
  await getHeaders();
  const n = await markCount();
  assert("default csp warns exactly once", n === 1, `saw ${n}`);
  assert("csp header is still default-src 'self'",
    h1["content-security-policy"] === "default-src 'self'",
    `got "${String(h1["content-security-policy"])}"`);
}

// --- Rule 2: set -> no NEW warning, header reflects the set value ---
{
  const before = await markCount();
  process.env.TINA4_CSP = "default-src 'self' https://api.example";
  const h = await getHeaders();
  const after = await markCount();
  assert("set csp does not add a warning", after === before && before === 1,
    `before=${before} after=${after}`);
  assert("set csp is reflected in the header",
    h["content-security-policy"] === "default-src 'self' https://api.example",
    `got "${String(h["content-security-policy"])}"`);
}

delete process.env.TINA4_CSP;
delete process.env.TINA4_LOG_FILE;
delete process.env.TINA4_LOG_OUTPUT;
server.close();

delete process.env.TINA4_RATE_LIMIT;
try { rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
