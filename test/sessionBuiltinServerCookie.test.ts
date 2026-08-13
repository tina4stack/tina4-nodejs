/**
 * Real-bug audit (3.13.99): the built-in server's FIRST-TIME session cookie.
 *
 * CONFIRMED BROKEN in PHP: Tina4\Server (the raw-socket engine `tina4 serve`
 * boots) never triggers PHP's headers_sent() -- a raw socket engages no real
 * PHP SAPI header-sending mechanism at all -- so Router::emitSessionCookie()
 * took the native setcookie() branch, which writes into a void nothing reads
 * back under that engine. A first-time session login under `tina4 serve`
 * emitted NO Set-Cookie at all: session auth was silently broken on the
 * framework's own recommended dev/prod server. Fixed in PHP by giving
 * Response a rawSocket flag Tina4\Server sets, read by emitSessionCookie().
 *
 * CROSS-CHECKED HERE: Node's built-in server IS node:http, always -- there is
 * no PHP-style CGI-heritage split between "a real SAPI" and "a raw socket
 * engine with no SAPI at all". dispatchPipeline.ts calls
 * `rawRes.appendHeader("Set-Cookie", buildSessionCookie(...))` directly on the
 * real outgoing http.ServerResponse, unconditionally. 131 (TestClient) found
 * no Node gap but did not deep-audit this specific path; this suite is that
 * audit: a real, no-mock proof (not merely read from source) that a REAL
 * `startServer()` -- the exact server `tina4 serve` boots -- emits a
 * first-time Set-Cookie and that replaying it resumes the session. Mirrors
 * test/sessionCookieName.test.ts's established real-server pattern (which
 * already incidentally proves the same shape for a GET counter route; this
 * suite proves it for the POST-login shape the OTHER three frameworks use,
 * with the matching case name for the shared contract fixture).
 *
 * Same case name in all four (tina4-documentation/plan/v3/fixtures/session_contract.json):
 *   - first_time_session_cookie_is_emitted_and_a_replay_resumes_it
 *
 * Run with: npx tsx test/sessionBuiltinServerCookie.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort } from "./freePort.ts";

const TEST_DIR = "/tmp/tina4-session-builtin-cookie-test";
const PORT = await freePort();
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

function post(path: string): Promise<{ setCookies: string[]; status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          const raw = res.headers["set-cookie"];
          const setCookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
          let body: any = null;
          try { body = JSON.parse(data); } catch { /* leave null */ }
          resolve({ setCookies, status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

function get(path: string, cookie?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (cookie) headers["Cookie"] = cookie;
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path, method: "GET", headers },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          let body: any = null;
          try { body = JSON.parse(data); } catch { /* leave null */ }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// A noauth POST /login writes to the session; GET /whoami reads it back.
try { rmSync(TEST_DIR, { recursive: true }); } catch { /* fresh */ }
mkdirSync(join(TEST_DIR, "src/routes/login"), { recursive: true });
mkdirSync(join(TEST_DIR, "src/routes/whoami"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, "src/routes/login/post.ts"), `
export const noAuth = true;
export default async function (req: any, res: any) {
  req.session.set("token", "abc");
  return res.json({ ok: true });
}
`);
writeFileSync(join(TEST_DIR, "src/routes/whoami/get.ts"), `
export default async function (req: any, res: any) {
  return res.json({ token: req.session.get("token") ?? null });
}
`);

const sessDir = mkdtempSync(join(tmpdir(), "tina4-session-builtin-cookie-"));
process.env.TINA4_SESSION_PATH = sessDir;
process.env.TINA4_RATE_LIMIT = "100000";

console.log("=== Session contract - built-in server first-time cookie (real-bug audit 3.13.99) ===\n");

const server = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});

const login = await post("/login");
assert("first_time_session_cookie_is_emitted_and_a_replay_resumes_it (login succeeds)",
  login.status === 200, `got status=${login.status} body=${JSON.stringify(login.body)}`);
assert("first_time_session_cookie_is_emitted_and_a_replay_resumes_it (Set-Cookie present on first write)",
  login.setCookies.length > 0,
  "a first-time session write over the REAL built-in server must emit a Set-Cookie - " +
  "this is the exact defect confirmed in PHP's Tina4\\Server");

const tina4Cookie = login.setCookies.find((c) => c.startsWith("tina4_session="));
assert("first_time_session_cookie_is_emitted_and_a_replay_resumes_it (it is the tina4_session cookie)",
  !!tina4Cookie, `got: ${JSON.stringify(login.setCookies)}`);

if (tina4Cookie) {
  const cookiePair = tina4Cookie.split(";")[0];
  const whoami = await get("/whoami", cookiePair);
  assert("first_time_session_cookie_is_emitted_and_a_replay_resumes_it (replay resumes the session)",
    whoami.body?.token === "abc", `got ${JSON.stringify(whoami.body)}`);
}

server.close();

delete process.env.TINA4_SESSION_PATH;
delete process.env.TINA4_RATE_LIMIT;
try { rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
try { rmSync(sessDir, { recursive: true }); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
