/**
 * Wire-level tests for the configurable session cookie NAME (TINA4_SESSION_NAME).
 *
 * NO MOCKS — a real @tina4/core server is started, real HTTP requests are made,
 * and the ACTUAL `Set-Cookie` header the server emits (and the session it reads
 * back) are asserted against a real file-backed session store.
 *
 * The bug this locks in (parity with the Python master 3.13.79 batch): the
 * WRITE side emitted the cookie under TINA4_SESSION_NAME, but if the READ side
 * did not resolve the SAME name, a renamed cookie was written and then never
 * read back — the session silently never resumed. The fix is ONE shared
 * resolver, `sessionCookieName()` (env TINA4_SESSION_NAME, default
 * tina4_session), used by BOTH the write path (buildSessionCookie) and the read
 * path (the auto-session parse in server.ts).
 *
 * Contract:
 *   - Env var: TINA4_SESSION_NAME   Default: tina4_session
 *   - Set-Cookie is emitted under the configured name.
 *   - The incoming cookie is matched by its exact `name=` prefix, so a second
 *     request replaying that cookie resumes the SAME session (counter
 *     increments across requests).
 *   - Default (var unset) behaviour is byte-identical to `tina4_session`.
 *
 * Run with: npx tsx test/sessionCookieName.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort } from "./freePort.ts";

const TEST_DIR = "/tmp/tina4-session-name-test";
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

/**
 * Hit the counter route once. Returns the raw first `set-cookie` value (or "")
 * and the parsed JSON body. Optionally replays a `Cookie` header.
 */
function hit(cookie?: string): Promise<{ setCookie: string; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (cookie) headers["Cookie"] = cookie;
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path: "/api/count", method: "GET", headers },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          const raw = res.headers["set-cookie"];
          const setCookie = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
          let body: any = null;
          try { body = JSON.parse(data); } catch { /* leave null */ }
          resolve({ setCookie, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** The `name=value` pair (first segment) of a Set-Cookie, for replay as a Cookie header. */
function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0];
}

// Clean slate + a route that increments a per-session counter.
try { rmSync(TEST_DIR, { recursive: true }); } catch { /* fresh */ }
mkdirSync(join(TEST_DIR, "src/routes/api/count"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, "src/routes/api/count/get.ts"), `
export default async function (req: any, res: any) {
  const current = Number(req.session.get("count") ?? 0) + 1;
  req.session.set("count", current);
  return res.json({ count: current });
}
`);

// Isolate session files; keep the rate limiter out of the way.
const sessDir = mkdtempSync(join(tmpdir(), "tina4-sessname-"));
process.env.TINA4_SESSION_PATH = sessDir;
process.env.TINA4_RATE_LIMIT = "100000";
delete process.env.TINA4_SESSION_SECURE;
delete process.env.TINA4_SESSION_SAMESITE;
delete process.env.TINA4_SESSION_NAME;

console.log("=== Session cookie NAME (TINA4_SESSION_NAME) Tests ===\n");

const server = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});

// ---------------------------------------------------------------------------
console.log("--- default name (TINA4_SESSION_NAME unset) ---");

const d1 = await hit();
assert("default: fresh request emits Set-Cookie under tina4_session=",
  d1.setCookie.startsWith("tina4_session="), `got "${d1.setCookie}"`);
assert("default: first request counter is 1",
  d1.body?.count === 1, `got ${JSON.stringify(d1.body)}`);

const d2 = await hit(cookiePair(d1.setCookie));
assert("default: replaying tina4_session cookie resumes the session (counter -> 2)",
  d2.body?.count === 2, `got ${JSON.stringify(d2.body)}`);

// ---------------------------------------------------------------------------
console.log("\n--- custom name (TINA4_SESSION_NAME=my_app_session) ---");
process.env.TINA4_SESSION_NAME = "my_app_session";

const c1 = await hit();
assert("custom: Set-Cookie is emitted under my_app_session=",
  c1.setCookie.startsWith("my_app_session="), `got "${c1.setCookie}"`);
assert("custom: Set-Cookie does NOT use the default tina4_session name",
  !c1.setCookie.includes("tina4_session="), `got "${c1.setCookie}"`);
assert("custom: first request counter is 1",
  c1.body?.count === 1, `got ${JSON.stringify(c1.body)}`);

// THE BITE: request 2 replays the my_app_session cookie. The READ side must
// resolve the SAME configured name, find the pair, and resume the session.
const c2 = await hit(cookiePair(c1.setCookie));
assert("custom: replaying my_app_session cookie RESUMES the session (counter -> 2)",
  c2.body?.count === 2, `got ${JSON.stringify(c2.body)}`);

// A second resume proves it keeps reading by the configured name.
const c3 = await hit(cookiePair(c1.setCookie));
assert("custom: a third request on the same cookie continues the session (counter -> 3)",
  c3.body?.count === 3, `got ${JSON.stringify(c3.body)}`);

// NEGATIVE: under the custom config, presenting the OLD default-named cookie
// must NOT resume — it is a different cookie name, so a fresh session starts.
const cWrongName = await hit(`tina4_session=${cookiePair(c1.setCookie).split("=")[1]}`);
assert("custom: an incoming tina4_session cookie does NOT resume under the custom name (counter -> 1)",
  cWrongName.body?.count === 1, `got ${JSON.stringify(cWrongName.body)}`);

// NEGATIVE: prefix-collision — a differently named cookie whose name merely
// STARTS WITH the configured name must not be mistaken for it.
const cCollision = await hit(`my_app_session_other=${cookiePair(c1.setCookie).split("=")[1]}`);
assert("custom: a my_app_session_other cookie does NOT resume (prefix-collision guard, counter -> 1)",
  cCollision.body?.count === 1, `got ${JSON.stringify(cCollision.body)}`);

// NEGATIVE: suffix-collision — a cookie whose name ENDS WITH the configured
// name must not be mistaken for it. This is the case the old global-regex match
// (`name=([^;]+)` anywhere in the header) got WRONG; the exact `name=` prefix
// parse per cookie pair rejects it.
const cSuffix = await hit(`x${cookiePair(c1.setCookie)}`);
assert("custom: an x<name> suffix-collision cookie does NOT resume (counter -> 1)",
  cSuffix.body?.count === 1, `got ${JSON.stringify(cSuffix.body)}`);

delete process.env.TINA4_SESSION_NAME;

// ---------------------------------------------------------------------------
console.log("\n--- default restored (var cleared) ---");
const r1 = await hit();
assert("after clearing the var, Set-Cookie is tina4_session= again",
  r1.setCookie.startsWith("tina4_session="), `got "${r1.setCookie}"`);

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
