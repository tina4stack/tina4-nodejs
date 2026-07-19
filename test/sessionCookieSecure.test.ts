/**
 * Wire-level tests for proxy-aware `Secure` on the auto session cookie (nodejs#34).
 *
 * NO MOCKS — a real @tina4/core server is started, real HTTP requests are made,
 * and the ACTUAL `Set-Cookie` header the server emits is asserted. The bug: an
 * HTTPS deploy behind a TLS-terminating proxy (nginx/ALB/Cloudflare/containers)
 * forwards plain HTTP to Node with `X-Forwarded-Proto: https`, and the session
 * cookie shipped WITHOUT `Secure` unless the operator set TINA4_SESSION_SECURE.
 *
 * Contract (parity with tina4-php Request::isSecureScheme, php#175):
 *   Secure = TINA4_SESSION_SECURE truthy
 *         || SameSite === "None"                 (browsers reject None w/o Secure)
 *         || client scheme is https via x-forwarded-proto (first hop of a chain)
 *   Plain http, no proxy header, no TLS => NOT Secure (else undeliverable).
 *
 * Run with: npx tsx test/sessionCookieSecure.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = "/tmp/tina4-session-secure-test";
const PORT = 3418;
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

/** Return the raw `set-cookie` header value (first entry) the server emits. */
function setCookie(
  headers?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path: "/api/ping", method: "GET", headers: headers ?? {} },
      (res) => {
        res.on("data", () => { /* drain */ });
        res.on("end", () => {
          const raw = res.headers["set-cookie"];
          resolve(Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? ""));
        });
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

// Isolate session files to a temp dir; keep the rate limiter out of the way.
const sessDir = mkdtempSync(join(tmpdir(), "tina4-sess-"));
process.env.TINA4_SESSION_PATH = sessDir;
process.env.TINA4_RATE_LIMIT = "100000";
// Ensure a clean baseline for the env-driven cases.
delete process.env.TINA4_SESSION_SECURE;
delete process.env.TINA4_SESSION_SAMESITE;

console.log("=== Session cookie Secure (proxy-aware) Tests ===\n");

const server = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});

// Sanity — the auto session cookie is actually emitted on a fresh request.
const baseline = await setCookie();
assert("fresh request emits a Set-Cookie for the session",
  baseline.startsWith("tina4_session="), `got "${baseline}"`);
assert("baseline cookie has HttpOnly + SameSite=Lax",
  baseline.includes("HttpOnly") && baseline.includes("SameSite=Lax"), `got "${baseline}"`);

console.log("\n--- proxy-aware Secure via X-Forwarded-Proto ---");

// POSITIVE: X-Forwarded-Proto: https => Secure present (the core bug).
const httpsCookie = await setCookie({ "X-Forwarded-Proto": "https" });
assert("XFP: https => Set-Cookie has Secure",
  httpsCookie.includes("Secure"), `got "${httpsCookie}"`);

// POSITIVE: proxy chain "https, http" — the FIRST (client-facing) hop wins.
const chainCookie = await setCookie({ "X-Forwarded-Proto": "https, http" });
assert("XFP chain 'https, http' => first hop wins => Secure",
  chainCookie.includes("Secure"), `got "${chainCookie}"`);

// NEGATIVE: no proxy header, plain http, no TLS => NOT Secure (undeliverable otherwise).
const plainCookie = await setCookie();
assert("plain http, no XFP => NO Secure",
  !plainCookie.includes("Secure"), `got "${plainCookie}"`);

// NEGATIVE: X-Forwarded-Proto: http => NOT Secure.
const xfpHttpCookie = await setCookie({ "X-Forwarded-Proto": "http" });
assert("XFP: http => NO Secure",
  !xfpHttpCookie.includes("Secure"), `got "${xfpHttpCookie}"`);

// NEGATIVE: a downstream hop reporting http first must NOT flip Secure on.
const chainHttpFirst = await setCookie({ "X-Forwarded-Proto": "http, https" });
assert("XFP chain 'http, https' => first hop http => NO Secure",
  !chainHttpFirst.includes("Secure"), `got "${chainHttpFirst}"`);

console.log("\n--- env override: TINA4_SESSION_SECURE ---");

// POSITIVE: explicit opt-in forces Secure even on plain http.
process.env.TINA4_SESSION_SECURE = "true";
const envSecure = await setCookie();
assert("TINA4_SESSION_SECURE=true => Secure on plain http",
  envSecure.includes("Secure"), `got "${envSecure}"`);
delete process.env.TINA4_SESSION_SECURE;

console.log("\n--- RFC: SameSite=None forces Secure ---");

// POSITIVE: SameSite=None requires Secure — browsers drop it otherwise.
process.env.TINA4_SESSION_SAMESITE = "None";
const noneCookie = await setCookie();
assert("SameSite=None => Secure (even on plain http)",
  noneCookie.includes("SameSite=None") && noneCookie.includes("Secure"), `got "${noneCookie}"`);
delete process.env.TINA4_SESSION_SAMESITE;

// Confirm the None fix did not leave Secure globally on.
const afterNone = await setCookie();
assert("after None cleared, plain http is NO Secure again",
  !afterNone.includes("Secure"), `got "${afterNone}"`);

server.close();

// Cleanup
delete process.env.TINA4_SESSION_PATH;
delete process.env.TINA4_RATE_LIMIT;
try { rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
try { rmSync(sessDir, { recursive: true }); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
