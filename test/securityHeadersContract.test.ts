/**
 * Security headers conformance — secure-by-default register + HTTPS-guarded HSTS.
 *
 * Feature 36. See SECHDR-DEC-01/02 and
 * tina4-documentation/plan/v3/fixtures/securityheaders_contract.json.
 *
 * NO MOCKS — a REAL @tina4/core server is booted with startServer (which runs the
 * real boot that registers SecurityHeadersMiddleware in the default chain), REAL
 * HTTP requests are made, and the ACTUAL headers the server emits are asserted.
 *
 * 1. SECURE-BY-DEFAULT. A default app (nothing opted in) response carries the
 *    canonical header set with byte-identical VALUES to Python/PHP/Ruby, and CSP
 *    is default-src 'self'. Before SECHDR-DEC-01 the middleware existed with good
 *    defaults but was NEVER registered, so a default app had none of these.
 * 2. HSTS IS HTTPS-ONLY. Strict-Transport-Security is emitted only when TINA4_HSTS
 *    is set AND the request is HTTPS (X-Forwarded-Proto first hop); ABSENT on
 *    plain HTTP even with TINA4_HSTS set.
 *
 * Mutation-proved: unregister the middleware (drop the MiddlewareRunner.use call)
 * and the canonical-set case goes RED; drop the HTTPS guard (emit HSTS on any
 * scheme) and the plain-http HSTS case goes RED.
 *
 * Same case names in all four:
 *   tina4-python/tests/test_security_headers_contract.py
 *   tina4-php/tests/SecurityHeadersContractTest.php
 *   tina4-ruby/spec/security_headers_contract_spec.rb
 *
 * Run with: npx tsx test/securityHeadersContract.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { freePort } from "./freePort.ts";

const TEST_DIR = "/tmp/tina4-security-headers-test";
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

// The canonical set every framework emits, byte-identical values (Node lower-cases
// response header names on the wire, so we read them lower-cased).
const CANONICAL: Record<string, string> = {
  "x-frame-options": "SAMEORIGIN",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'self'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-xss-protection": "0",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
const HSTS = "31536000";

/** GET /api/ping and resolve the raw response headers the server emitted. */
function getHeaders(reqHeaders?: Record<string, string>): Promise<http.IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path: "/api/ping", method: "GET", headers: reqHeaders ?? {} },
      (res) => {
        res.on("data", () => { /* drain */ });
        res.on("end", () => resolve(res.headers));
      },
    );
    req.on("error", reject);
    req.end();
  });
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

// Keep the rate limiter out of the way; clean baseline for the env-driven cases.
process.env.TINA4_RATE_LIMIT = "100000";
delete process.env.TINA4_HSTS;
delete process.env.TINA4_CSP;
delete process.env.TINA4_FRAME_OPTIONS;
delete process.env.TINA4_REFERRER_POLICY;
delete process.env.TINA4_PERMISSIONS_POLICY;
delete process.env.TINA4_CSRF;

console.log("=== Security headers (secure-by-default) Tests ===\n");

const server = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});

// --- secure-by-default set ---
{
  const headers = await getHeaders();
  let allPresent = true;
  let detail = "";
  for (const [name, value] of Object.entries(CANONICAL)) {
    if (headers[name] !== value) {
      allPresent = false;
      detail += ` [${name}=${String(headers[name])} want ${value}]`;
    }
  }
  // Also assert HSTS is NOT present by default (TINA4_HSTS unset).
  const noHstsByDefault = headers["strict-transport-security"] === undefined;
  assert("a default app response carries the canonical security header set",
    allPresent && noHstsByDefault, `${detail}${noHstsByDefault ? "" : " [unexpected HSTS by default]"}`);

  assert("csp defaults to default src self",
    headers["content-security-policy"] === "default-src 'self'",
    `got "${String(headers["content-security-policy"])}"`);
}

// --- HSTS HTTPS-guarded ---
console.log("\n--- HSTS is HTTPS-only ---");
process.env.TINA4_HSTS = HSTS;

// POSITIVE: X-Forwarded-Proto: https => HSTS present with the exact value.
{
  const headers = await getHeaders({ "X-Forwarded-Proto": "https" });
  assert("hsts is present on an https request",
    headers["strict-transport-security"] === `max-age=${HSTS}; includeSubDomains`,
    `got "${String(headers["strict-transport-security"])}"`);
}

// NEGATIVE: plain http, no proxy header => HSTS ABSENT even with TINA4_HSTS set.
{
  const headers = await getHeaders();
  assert("hsts is absent on a plain http request",
    headers["strict-transport-security"] === undefined,
    `got "${String(headers["strict-transport-security"])}"`);
}

// NEGATIVE (extra): a proxy chain whose first hop is http must NOT set HSTS.
{
  const headers = await getHeaders({ "X-Forwarded-Proto": "http, https" });
  assert("XFP chain 'http, https' => first hop http => NO HSTS",
    headers["strict-transport-security"] === undefined,
    `got "${String(headers["strict-transport-security"])}"`);
}

delete process.env.TINA4_HSTS;

server.close();

// Cleanup
delete process.env.TINA4_RATE_LIMIT;
try { rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
