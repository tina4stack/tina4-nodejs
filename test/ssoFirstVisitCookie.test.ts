/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * A first visit to SSO login gets a session cookie, so the callback finds the
 * pending state (tina4-python#135 parity lock-in).
 *
 * THE PYTHON DEFECT: on a visitor's first request Sso.login() stores the pending
 * state (state, nonce, PKCE verifier) in a NEW session, but the save stage skips
 * a new session whose all() is empty, and all() hides the _tina4_sso keys. So a
 * new session holding only the SSO pending state sent no cookie, the identity
 * provider redirected back to a fresh session, and sign-in failed - for exactly
 * the users who had no session yet.
 *
 * NODE IS NOT AFFECTED. sessionAutoStart (dispatchPipeline.ts) emits the cookie
 * whenever the session id differs from the one the request brought, with no
 * emptiness test: a first visit always gets its cookie, and Session.start()
 * persists the new record straight away. all() hiding underscore keys has no
 * bearing on the cookie.
 *
 * NO MOCKS: a REAL startServer() mounts the framework's OWN configured SSO routes
 * (/auth/login, /auth/callback via Sso.mountConfigured) against a REAL local
 * HTTP server acting as the OpenID provider - discovery, an authorization
 * endpoint that redirects back with a code, a token endpoint that checks the
 * PKCE verifier, and introspection. Every hop is a real request over a socket.
 *
 * Same case names in all four frameworks:
 *   - sso_first_visit_login_sets_the_session_cookie
 *   - sso_first_visit_callback_finds_the_pending_state
 *   - sso_callback_without_the_login_cookie_is_refused
 *
 * Run with: npx tsx test/ssoFirstVisitCookie.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort } from "./freePort.ts";

const TEST_DIR = mkdtempSync(join(tmpdir(), "tina4-sso-first-visit-"));
const SESSION_DIR = mkdtempSync(join(tmpdir(), "tina4-sso-first-visit-sess-"));
const APP_PORT = await freePort();
const IDP_PORT = await freePort();
const ISSUER = `http://127.0.0.1:${IDP_PORT}/realms/issue135-node`;
const CLIENT_ID = "issue135-node-app";
const CLIENT_SECRET = "issue135-node-secret";
const REDIRECT_URI = `http://127.0.0.1:${APP_PORT}/auth/callback`;
const SUBJECT = "user-135";

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

const b64url = (value: object | string): string =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

// ── The OpenID provider: a real HTTP server on a real socket ─────────────────
interface Grant { nonce: string; challenge: string; redirectUri: string }
const grants = new Map<string, Grant>();

function readBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolveBody) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolveBody(new URLSearchParams(data)));
  });
}

function sendJson(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const idp = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ISSUER);
  const path = url.pathname.replace("/realms/issue135-node", "");
  if (path === "/.well-known/openid-configuration") {
    return sendJson(res, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
      token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
      introspection_endpoint: `${ISSUER}/protocol/openid-connect/token/introspect`,
    });
  }
  if (path === "/protocol/openid-connect/auth") {
    // The user "signs in" and the provider sends the browser back with a code.
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
  if (path === "/protocol/openid-connect/token" && req.method === "POST") {
    const form = await readBody(req);
    const grant = grants.get(form.get("code") ?? "");
    grants.delete(form.get("code") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    const pkceOk = grant && createHash("sha256").update(verifier).digest("base64url") === grant.challenge;
    if (!grant || !pkceOk || form.get("redirect_uri") !== grant.redirectUri) {
      return sendJson(res, 400, { error: "invalid_grant" });
    }
    return sendJson(res, 200, {
      access_token: `at-${randomBytes(8).toString("hex")}`,
      id_token: `${b64url({ alg: "none" })}.${b64url({ iss: ISSUER, sub: SUBJECT, nonce: grant.nonce })}.sig`,
      refresh_token: "rt-issue135",
      expires_in: 300,
    });
  }
  if (path === "/protocol/openid-connect/token/introspect" && req.method === "POST") {
    return sendJson(res, 200, {
      active: true, iss: ISSUER, client_id: CLIENT_ID, aud: CLIENT_ID,
      sub: SUBJECT, preferred_username: "issue135",
    });
  }
  sendJson(res, 404, { error: "not_found" });
});
await new Promise<void>((ready) => idp.listen(IDP_PORT, "127.0.0.1", () => ready()));

// ── The app ──────────────────────────────────────────────────────────────────
mkdirSync(join(TEST_DIR, "src/routes/me"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, "src/routes/me/get.ts"), `
export default async function (req: any, res: any) {
  const stored = req.session?.get("_tina4_sso");
  return res.json({ subject: stored?.identity?.subject ?? null });
}
`);

process.env.TINA4_SSO_ISSUER = ISSUER;
process.env.TINA4_SSO_CLIENT_ID = CLIENT_ID;
process.env.TINA4_SSO_CLIENT_SECRET = CLIENT_SECRET;
process.env.TINA4_SSO_REDIRECT_URI = REDIRECT_URI;
process.env.TINA4_SESSION_BACKEND = "file";
process.env.TINA4_SESSION_PATH = SESSION_DIR;
process.env.TINA4_DEBUG = "false";
process.env.TINA4_RATE_LIMIT = "100000";
delete process.env.TINA4_CSRF;

interface Reply { status: number; location: string; cookies: string[]; body: string }

function get(url: string, cookie = ""): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const target = new URL(url);
    const headers: Record<string, string> = cookie ? { Cookie: cookie } : {};
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: "GET", headers },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          const raw = res.headers["set-cookie"];
          const cookies = (Array.isArray(raw) ? raw : raw ? [raw] : [])
            .map((c) => c.split(";")[0])
            .filter((c) => c.startsWith("tina4_session="));
          resolveReply({ status: res.statusCode ?? 0, location: String(res.headers.location ?? ""), cookies, body: data });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

console.log("=== SSO first visit: login sets the session cookie (tina4-python#135 parity) ===\n");

const server = await startServer({ port: APP_PORT, basePath: TEST_DIR });
const APP = `http://127.0.0.1:${APP_PORT}`;

// 1. First visit: no cookie at all. The only thing the new session holds is the
//    SSO pending state - exactly the shape Python dropped.
const login = await get(`${APP}/auth/login?return_to=/dashboard`);
const loginCookie = login.cookies[0] ?? "";
assert("sso_first_visit_login_sets_the_session_cookie (redirects to the provider)",
  login.status === 302 && login.location.startsWith(`${ISSUER}/protocol/openid-connect/auth`),
  `status=${login.status} location=${login.location}`);
assert("sso_first_visit_login_sets_the_session_cookie (Set-Cookie present)", loginCookie !== "",
  "a first visit to /auth/login must carry the session cookie holding the pending state");

// 2. The provider authenticates and redirects back with code + state.
const authorize = await get(login.location);
assert("provider redirects back to the app callback", authorize.status === 302 && authorize.location.startsWith(REDIRECT_URI),
  `status=${authorize.status} location=${authorize.location}`);

// 3. The browser replays the cookie from step 1 at the callback.
const callback = await get(authorize.location, loginCookie);
const signedInCookie = callback.cookies[0] ?? "";
assert("sso_first_visit_callback_finds_the_pending_state (callback succeeds)",
  callback.status === 302 && callback.location === "/dashboard", `status=${callback.status} body=${callback.body}`);
assert("sso_first_visit_callback_finds_the_pending_state (session rotated on sign-in)",
  signedInCookie !== "" && signedInCookie !== loginCookie, `cookies=${JSON.stringify(callback.cookies)}`);

const me = await get(`${APP}/me`, signedInCookie);
let subject: unknown = null;
try { subject = JSON.parse(me.body).subject; } catch { /* not JSON */ }
assert("sso_first_visit_callback_finds_the_pending_state (identity is in the session)", subject === SUBJECT,
  `status=${me.status} body=${me.body}`);

// 4. NEGATIVE: the cookie is what carries the state. Without it the callback
//    must be refused, never signed in.
const secondLogin = await get(`${APP}/auth/login`);
const secondAuthorize = await get(secondLogin.location);
const cookieless = await get(secondAuthorize.location);
assert("sso_callback_without_the_login_cookie_is_refused",
  cookieless.status === 400 && cookieless.body.includes("SSO_CALLBACK_FAILED"),
  `status=${cookieless.status} body=${cookieless.body}`);

server.close();
idp.close();
for (const key of ["TINA4_SSO_ISSUER", "TINA4_SSO_CLIENT_ID", "TINA4_SSO_CLIENT_SECRET", "TINA4_SSO_REDIRECT_URI",
  "TINA4_SESSION_BACKEND", "TINA4_SESSION_PATH", "TINA4_RATE_LIMIT"]) delete process.env[key];
try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
try { rmSync(SESSION_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
