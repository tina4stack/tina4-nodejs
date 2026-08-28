/**
 * Secure route hands the validated principal + session + cookies to the handler.
 *
 * Regresses tina4-nodejs#57 (reported on 3.13.103): a login route stores a signed
 * token in the session (`req.session.set("token", token)`), a later SECURE GET is
 * router-authenticated via the returned HttpOnly session cookie (a request WITHOUT
 * the cookie gets 401), but the report says the handler saw `req.user`,
 * `req.session` and `req.cookies` as UNAVAILABLE. Expected: the secure handler
 * receives the validated principal AND the session.
 *
 * NO MOCKS - a REAL @tina4/core server, REAL http.request, a REAL session-cookie
 * round trip, and route handlers that echo `req.user` / `req.session.get("token")`
 * / `req.cookies` back onto the wire, so the assertion reads what the client
 * actually received.
 *
 * Flow (exactly the reporter's):
 *   1. POST /api/login (public) stores a signed token in the session -> Set-Cookie.
 *   2. GET /api/secure (secured) WITHOUT the cookie -> 401 (the router gate works).
 *   3. GET /api/secure WITH the session cookie -> 200, and the handler sees:
 *        - req.user = the validated principal (user_id === 1), NOT true/undefined
 *        - req.session.get("token") = the token a PRIOR request stored
 *        - req.cookies carrying the session cookie
 *
 * Mutation-proof: this is authentication-via-session-cookie, distinct from the
 * Bearer path in routerAuthPayload.test.ts. If the auth gate stopped attaching
 * the principal, or session/cookies were not loaded for a secured GET, case 3
 * goes red on the wire.
 *
 * Same case names in all four:
 *   tina4-python/tests/test_secure_route_session_handoff.py
 *   tina4-php/tests/SecureRouteSessionHandoffTest.php
 *   tina4-ruby/spec/secure_route_session_handoff_spec.rb
 *
 * Run: npx tsx test/secureRouteSessionHandoff.test.ts
 */
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getToken } from "../packages/core/src/auth.ts";
import { startServer } from "../packages/core/src/index.ts";
import { freePort } from "./freePort.ts";

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`); }
}

const SECRET = "test-secure-handoff-secret";
process.env.TINA4_SECRET = SECRET;
process.env.TINA4_RATE_LIMIT = "100000";

const root = mkdtempSync(join(tmpdir(), "tina4-securehandoff-"));
mkdirSync(join(root, "src/routes/api/login"), { recursive: true });
mkdirSync(join(root, "src/routes/api/secure"), { recursive: true });
writeFileSync(join(root, "package.json"), '{"type":"module"}');

// Public login route: store the token the TEST minted into the session. Writing
// it server-side is what mints the HttpOnly session cookie the next call rides.
writeFileSync(join(root, "src/routes/api/login/post.ts"),
  "export const secure = false;\n" +
  "export default async function (req: any, res: any) {\n" +
  "  req.session.set('token', req.body?.token);\n" +
  "  res.json({ ok: true });\n" +
  "}\n");

// Secured GET: echo exactly the three things #57 says go missing.
writeFileSync(join(root, "src/routes/api/secure/get.ts"),
  "export const secure = true;\n" +
  "export default async function (req: any, res: any) {\n" +
  "  res.json({\n" +
  "    ok: true,\n" +
  "    userType: typeof req.user,\n" +
  "    user: req.user ?? null,\n" +
  "    sessionToken: req.session ? (req.session.get('token') ?? null) : null,\n" +
  "    cookieKeys: Object.keys(req.cookies ?? {}),\n" +
  "  });\n" +
  "}\n");

interface Result { status: number; json: any; body: string; setCookie: string[] }
function request(port: number, method: string, path: string,
                 headers: Record<string, string> = {}, body?: unknown): Promise<Result> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h = { ...headers };
    if (payload !== undefined) { h["Content-Type"] = "application/json"; h["Content-Length"] = String(Buffer.byteLength(payload)); }
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers: h }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode!, json, body: text, setCookie: res.headers["set-cookie"] ?? [] });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// Turn a Set-Cookie array into a Cookie request header (name=value pairs only).
function cookieHeader(setCookie: string[]): string {
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

console.log("=== Secure route session handoff (#57) - REAL server, REAL cookies ===\n");

const PORT = await freePort();
const server = await startServer({
  port: PORT,
  routesDir: join(root, "src/routes"),
  modelsDir: join(root, "src/models"),
  staticDir: join(root, "public"),
});
const call = (m: string, p: string, h: Record<string, string> = {}, b?: unknown) => request(PORT, m, p, h, b);

try {
  const token = getToken({ user_id: 1, role: "admin" }, 3600);

  // 1. Log in: the token lands in the session; the response mints the cookie.
  const login = await call("POST", "/api/login", {}, { token });
  assert("1. login succeeds", login.status === 200, `status=${login.status} body=${login.body}`);
  const cookie = cookieHeader(login.setCookie);
  assert("1a. login returns a session cookie", cookie.length > 0, `set-cookie=${JSON.stringify(login.setCookie)}`);

  // 2. The router gate really gates: no cookie -> 401, handler never runs.
  const denied = await call("GET", "/api/secure");
  assert("2. secure GET without the cookie is 401", denied.status === 401, `status=${denied.status}`);
  assert("2a. the handler never ran on the 401", denied.json?.ok === undefined, `body=${denied.body}`);

  // 3. THE #57 assertion: with the cookie, the handler receives principal + session + cookies.
  const ok = await call("GET", "/api/secure", { Cookie: cookie });
  assert("3. secure GET with the session cookie is 200", ok.status === 200, `status=${ok.status} body=${ok.body}`);
  assert("3a. req.user is the validated principal object (not true/undefined)",
    ok.json?.userType === "object" && ok.json?.user !== null,
    `userType=${ok.json?.userType} user=${JSON.stringify(ok.json?.user)}`);
  assert("3b. req.user carries the claims (user_id === 1)",
    ok.json?.user?.user_id === 1, `got ${JSON.stringify(ok.json?.user)}`);
  assert("3c. req.session reflects what the prior request stored (token round-trips)",
    ok.json?.sessionToken === token, `sessionToken=${String(ok.json?.sessionToken).slice(0, 12)}...`);
  assert("3d. req.cookies is populated for the secured handler",
    Array.isArray(ok.json?.cookieKeys) && ok.json.cookieKeys.length > 0,
    `cookieKeys=${JSON.stringify(ok.json?.cookieKeys)}`);
} finally {
  server.close();
  try { rmSync(root, { recursive: true }); } catch { /* ignore */ }
  delete process.env.TINA4_RATE_LIMIT;
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
