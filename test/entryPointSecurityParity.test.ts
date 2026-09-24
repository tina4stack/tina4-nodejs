/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Every serving entry point sends the security headers and enforces CSRF
 * (tina4-python#134 parity lock-in).
 *
 * THE PYTHON DEFECT: run() attaches the security-header middleware and, with
 * TINA4_CSRF=true, CsrfMiddleware; asgi() - the documented way to serve under
 * uvicorn/hypercorn/granian - attached neither. The same app shipped no
 * CSP/nosniff/frame headers and accepted cross-site forged writes.
 *
 * NODE IS NOT AFFECTED. @tina4/core exports two ways to serve a request:
 * startServer()/start() (the listener `tina4 serve` boots) and handle(rawReq,
 * rawRes) for embedding Tina4 in a caller's own node:http server. handle()
 * refuses to run until startServer() has booted, and then dispatches through
 * the SAME function the listener uses (`_dispatchFn` = runDispatch over the
 * one DispatchContext startServer() built), after startServer() registered
 * SecurityHeadersMiddleware and attachCsrfFromEnv(). There is no second boot
 * path that could skip them. (buildDispatchContext()/runDispatch() are not
 * exported from the package; they back the in-process TestClient.)
 *
 * This suite proves it over REAL sockets on BOTH entry points: the listener,
 * and handle() mounted in a separate node:http server on its own port. A
 * signed-in session posting to a write route with only its cookie (the forged
 * cross-site request) is refused 403 CSRF_INVALID on both; the same request
 * carrying a valid form token succeeds on both.
 *
 * SSO (tina4-python#134 follow-up: asgi() also skipped the configured SSO
 * route mount that run() does). Sso.mountConfigured() runs inside startServer()
 * on the one router every entry point dispatches through, so handle() serves
 * /auth/login and /auth/callback exactly as the listener does. Proven here
 * against a REAL local HTTP server acting as the OpenID provider: on each entry
 * point, login redirects to the provider with a session cookie, and the
 * callback served by THAT entry point signs the user in.
 *
 * REFUSALS CARRY THE HEADERS TOO (tina4-php follow-up: a CSRF 403 went out
 * there WITHOUT the security headers). In Node SecurityHeadersMiddleware runs
 * in the pre-match pass, before CSRF and before the auth gate can refuse, so
 * the CSRF 403 and the auth 401 both carry CSP, nosniff and X-Frame-Options.
 *
 * Same case names in all four frameworks:
 *   - a_csrf_refusal_carries_the_security_headers
 *   - an_auth_refusal_carries_the_security_headers
 *   - every_entry_point_serves_the_configured_sso_routes
 *   - every_entry_point_sends_security_headers
 *   - every_entry_point_refuses_a_forged_write_when_csrf_is_on
 *   - every_entry_point_accepts_a_write_with_a_form_token
 *
 * Run with: npx tsx test/entryPointSecurityParity.test.ts
 */
import { startServer, handle, getToken } from "../packages/core/src/index.ts";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { freePort } from "./freePort.ts";

const TEST_DIR = mkdtempSync(join(tmpdir(), "tina4-entry-sec-"));
const SESSION_DIR = mkdtempSync(join(tmpdir(), "tina4-entry-sec-sess-"));
const LISTENER_PORT = await freePort();
const EMBED_PORT = await freePort();
const AUTH_MODULE = resolve(import.meta.dirname, "../packages/core/src/auth.ts");
const IDP_PORT = await freePort();
const ISSUER = `http://127.0.0.1:${IDP_PORT}/realms/entry-sso-node`;
const CLIENT_ID = "entry-sso-node-app";
const SUBJECT = "entry-sso-user";

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

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolveReply({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const WANTED: Record<string, string> = {
  "content-security-policy": "default-src 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
};

function missing(headers: http.IncomingHttpHeaders): string {
  return Object.entries(WANTED)
    .filter(([name, value]) => headers[name] !== value)
    .map(([name, value]) => `[${name}=${String(headers[name])} want ${value}]`)
    .join(" ");
}

// ── The OpenID provider: a real HTTP server on a real socket ─────────────────
const grants = new Map<string, { nonce: string; challenge: string; redirectUri: string }>();
const b64url = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");

const idp = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", ISSUER);
  const path = url.pathname.replace("/realms/entry-sso-node", "");
  const json = (status: number, body: object) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (path === "/.well-known/openid-configuration") {
    return json(200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/auth`,
      token_endpoint: `${ISSUER}/token`,
      introspection_endpoint: `${ISSUER}/introspect`,
    });
  }
  if (path === "/auth") {
    const code = randomBytes(12).toString("hex");
    grants.set(code, {
      nonce: url.searchParams.get("nonce") ?? "",
      challenge: url.searchParams.get("code_challenge") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
    });
    const back = new URL(url.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  let data = "";
  req.on("data", (c) => { data += c; });
  req.on("end", () => {
    const form = new URLSearchParams(data);
    if (path === "/token") {
      const grant = grants.get(form.get("code") ?? "");
      grants.delete(form.get("code") ?? "");
      const pkceOk = grant && createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === grant.challenge;
      if (!grant || !pkceOk) return json(400, { error: "invalid_grant" });
      return json(200, {
        access_token: `at-${randomBytes(8).toString("hex")}`,
        id_token: `${b64url({ alg: "none" })}.${b64url({ iss: ISSUER, sub: SUBJECT, nonce: grant.nonce })}.sig`,
        expires_in: 300,
      });
    }
    if (path === "/introspect") {
      return json(200, { active: true, iss: ISSUER, client_id: CLIENT_ID, aud: CLIENT_ID, sub: SUBJECT });
    }
    json(404, { error: "not_found" });
  });
});
await new Promise<void>((ready) => idp.listen(IDP_PORT, "127.0.0.1", () => ready()));

// GET /page - any page. GET /signin - what a real sign-in leaves behind: a
// valid token in the session. POST /write - a secured write route.
mkdirSync(join(TEST_DIR, "src/routes/page"), { recursive: true });
mkdirSync(join(TEST_DIR, "src/routes/signin"), { recursive: true });
mkdirSync(join(TEST_DIR, "src/routes/write"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, "src/routes/page/get.ts"), `
export default async function (req: any, res: any) {
  return res.html("<!doctype html><title>page</title><p>hello</p>");
}
`);
writeFileSync(join(TEST_DIR, "src/routes/signin/get.ts"), `
import { getToken } from ${JSON.stringify(AUTH_MODULE)};
export default async function (req: any, res: any) {
  req.session.set("token", getToken({ user_id: 1 }, 60));
  return res.json({ signed_in: true });
}
`);
mkdirSync(join(TEST_DIR, "src/routes/secret"), { recursive: true });
writeFileSync(join(TEST_DIR, "src/routes/secret/get.ts"), `
export const secure = true;
export default async function (req: any, res: any) {
  return res.json({ secret: true });
}
`);
mkdirSync(join(TEST_DIR, "src/routes/me"), { recursive: true });
writeFileSync(join(TEST_DIR, "src/routes/me/get.ts"), `
export default async function (req: any, res: any) {
  return res.json({ subject: req.session?.get("_tina4_sso")?.identity?.subject ?? null });
}
`);
writeFileSync(join(TEST_DIR, "src/routes/write/post.ts"), `
export default async function (req: any, res: any) {
  return res.json({ wrote: true });
}
`);

process.env.TINA4_CSRF = "true";
process.env.TINA4_SECRET = "issue134-node-secret";
process.env.TINA4_DEBUG = "false";
process.env.TINA4_RATE_LIMIT = "100000";
process.env.TINA4_SESSION_PATH = SESSION_DIR;
process.env.TINA4_SSO_ISSUER = ISSUER;
process.env.TINA4_SSO_CLIENT_ID = CLIENT_ID;
process.env.TINA4_SSO_CLIENT_SECRET = "entry-sso-node-secret";
process.env.TINA4_SSO_REDIRECT_URI = `http://127.0.0.1:${LISTENER_PORT}/auth/callback`;
for (const key of ["TINA4_CSP", "TINA4_FRAME_OPTIONS", "TINA4_HSTS"]) delete process.env[key];

console.log("=== Every entry point sends security headers and enforces CSRF (tina4-python#134 parity) ===\n");

// Negative precondition: handle() is not a way around startServer()'s wiring -
// before a boot it refuses outright rather than dispatching unprotected.
{
  let refused = false;
  try {
    await handle({} as http.IncomingMessage, {} as http.ServerResponse);
  } catch (err) {
    refused = /not started/.test((err as Error).message);
  }
  assert("handle() refuses to dispatch before startServer() has wired the middleware", refused);
}

const server = await startServer({ port: LISTENER_PORT, basePath: TEST_DIR });

// The embedding pattern: Tina4 mounted inside the caller's own node:http server.
const embed = http.createServer((rawReq, rawRes) => {
  handle(rawReq, rawRes).catch((err) => {
    rawRes.statusCode = 500;
    rawRes.end(String(err));
  });
});
await new Promise<void>((ready) => embed.listen(EMBED_PORT, "127.0.0.1", () => ready()));

const ENTRY_POINTS: Array<[string, number]> = [
  ["startServer listener", LISTENER_PORT],
  ["handle() embedded in a node:http server", EMBED_PORT],
];

for (const [label, port] of ENTRY_POINTS) {
  console.log(`\n--- ${label} ---`);

  const page = await request(port, "GET", "/page");
  assert(`every_entry_point_sends_security_headers (${label})`, page.status === 200 && missing(page.headers) === "",
    `status=${page.status} ${missing(page.headers)}`);

  // Sign in: the reply carries the session cookie, the session holds a token.
  const signin = await request(port, "GET", "/signin");
  const rawCookie = signin.headers["set-cookie"];
  const cookies = (Array.isArray(rawCookie) ? rawCookie : rawCookie ? [rawCookie] : [])
    .map((c) => c.split(";")[0])
    .filter((c) => c.startsWith("tina4_session="));
  const cookie = cookies[0] ?? "";
  assert(`sign-in issues a session cookie (${label})`, signin.status === 200 && cookie !== "",
    `status=${signin.status} set-cookie=${JSON.stringify(rawCookie)}`);

  // The forged cross-site write: the browser sends the session cookie, the
  // attacker's page cannot know a form token.
  const forged = await request(port, "POST", "/write",
    { Cookie: cookie, "Content-Type": "application/json" }, JSON.stringify({ amount: 100 }));
  let forgedCode = "";
  try { forgedCode = JSON.parse(forged.body).code; } catch { /* not JSON */ }
  assert(`every_entry_point_refuses_a_forged_write_when_csrf_is_on (${label})`,
    forged.status === 403 && forgedCode === "CSRF_INVALID", `status=${forged.status} body=${forged.body}`);
  assert(`a_csrf_refusal_carries_the_security_headers (${label})`,
    forged.status === 403 && missing(forged.headers) === "", `status=${forged.status} ${missing(forged.headers)}`);

  // An auth refusal: a secured GET (CSRF skips safe methods) with no token.
  const denied = await request(port, "GET", "/secret");
  assert(`an_auth_refusal_carries_the_security_headers (${label})`,
    denied.status === 401 && missing(denied.headers) === "", `status=${denied.status} ${missing(denied.headers)}`);

  // POSITIVE: the same write with a real form token goes through.
  const formToken = getToken({ type: "form" }, 60);
  const legit = await request(port, "POST", "/write",
    { Cookie: cookie, "Content-Type": "application/json" }, JSON.stringify({ amount: 100, formToken }));
  assert(`every_entry_point_accepts_a_write_with_a_form_token (${label})`,
    legit.status === 200 && legit.body.includes("wrote"), `status=${legit.status} body=${legit.body}`);

  // SSO: the configured /auth/login and /auth/callback are served by THIS
  // entry point. The provider redirects to the configured redirect URI; the
  // browser's hop is replayed against the entry point under test.
  const login = await request(port, "GET", "/auth/login?return_to=/dashboard");
  const loginCookie = [login.headers["set-cookie"] ?? []].flat()
    .map((c) => c.split(";")[0]).find((c) => c.startsWith("tina4_session=")) ?? "";
  const location = String(login.headers.location ?? "");
  let signedIn = false;
  let detail = `login status=${login.status} location=${location} cookie=${loginCookie !== ""}`;
  if (login.status === 302 && location.startsWith(`${ISSUER}/auth`) && loginCookie) {
    const authorize = await fetch(location, { redirect: "manual" });
    const back = new URL(authorize.headers.get("location") ?? "");
    const callback = await request(port, "GET", back.pathname + back.search, { Cookie: loginCookie });
    const newCookie = [callback.headers["set-cookie"] ?? []].flat()
      .map((c) => c.split(";")[0]).find((c) => c.startsWith("tina4_session=")) ?? "";
    const me = await request(port, "GET", "/me", { Cookie: newCookie });
    let subject: unknown = null;
    try { subject = JSON.parse(me.body).subject; } catch { /* not JSON */ }
    signedIn = callback.status === 302 && callback.headers.location === "/dashboard" && subject === SUBJECT;
    detail = `callback status=${callback.status} location=${String(callback.headers.location)} body=${callback.body} me=${me.body}`;
  }
  assert(`every_entry_point_serves_the_configured_sso_routes (${label})`, signedIn, detail);
}

embed.close();
server.close();
idp.close();
for (const key of ["TINA4_CSRF", "TINA4_SECRET", "TINA4_RATE_LIMIT", "TINA4_SESSION_PATH", "TINA4_SSO_ISSUER",
  "TINA4_SSO_CLIENT_ID", "TINA4_SSO_CLIENT_SECRET", "TINA4_SSO_REDIRECT_URI"]) delete process.env[key];
try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
try { rmSync(SESSION_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
