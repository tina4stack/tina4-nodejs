/**
 * Auth-token rules: the cross-framework contract (ADR-0079).
 *
 * The answer key is tina4-documentation/plan/v3/fixtures/auth_token_contract.json.
 * Each assert label below is a `case` in that fixture; the SAME cases run in:
 *
 *   tina4-python/tests/test_auth_token_contract.py   (reference)
 *   tina4-php/tests/AuthTokenContractTest.php
 *   tina4-ruby/spec/auth_token_contract_spec.rb
 *
 * A REAL server (startServer) on its own port, real file routes, real Frond form
 * tokens, real HMAC, real sessions and real child processes for the boot checks.
 * No mocks.
 */
import http from "node:http";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getToken, validToken, refreshToken, authenticateRequest, authMiddleware,
} from "../packages/core/src/auth.ts";
import { wsAuthorized } from "../packages/core/src/websocket.ts";
import { isLoopback, isRequestAllowed } from "../packages/core/src/mcp.ts";
import { startServer } from "../packages/core/src/index.ts";
import { Frond, setFormTokenSessionId } from "../packages/frond/src/engine.ts";
import { freePort } from "./freePort.ts";

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`); }
}
async function check(label: string, body: () => Promise<boolean | [boolean, string]> | boolean | [boolean, string]): Promise<void> {
  try {
    const outcome = await body();
    const [ok, detail] = Array.isArray(outcome) ? outcome : [outcome, ""];
    assert(label, ok, detail);
  } catch (error) {
    assert(label, false, `threw ${(error as Error).message}`);
  }
}

const SECRET = "auth-token-contract-secret-0123456789abcdef";
process.env.TINA4_SECRET = SECRET;
process.env.TINA4_RATE_LIMIT = "100000";
delete process.env.TINA4_API_KEY;
delete process.env.TINA4_TOKEN_LIMIT;
setFormTokenSessionId("");

const repo = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "tina4-auth-contract-"));
for (const dir of ["contract/session", "contract/write", "contract/read"]) {
  mkdirSync(join(root, "src/routes", dir), { recursive: true });
}
writeFileSync(join(root, "package.json"), '{"type":"module"}');
writeFileSync(join(root, "src/routes/contract/session/post.ts"),
  "export const secure = false;\n" +
  "export default async function (req: any, res: any) {\n" +
  "  for (const [key, value] of Object.entries(req.body ?? {})) req.session.set(key, value);\n" +
  "  res.json({ ok: true });\n" +
  "}\n");
writeFileSync(join(root, "src/routes/contract/write/post.ts"),
  "export default async function (req: any, res: any) { res.json({ user: req.user ?? null }); }\n");
writeFileSync(join(root, "src/routes/contract/read/get.ts"),
  "export const secure = true;\n" +
  "export default async function (req: any, res: any) { res.json({ user: req.user ?? null }); }\n");

interface Result { status: number; json: any; body: string; headers: http.IncomingHttpHeaders }
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
        resolve({ status: res.statusCode!, json, body: text, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const formToken = (): string => String(new Frond().renderString("{{ form_token_value() }}", {})).trim();

function hs256(payload: Record<string, unknown>, key: string): string {
  const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64url");
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify(payload));
  return `${head}.${body}.${createHmac("sha256", key).update(`${head}.${body}`).digest("base64url")}`;
}

console.log("=== Auth-token rules (ADR-0079) - REAL server ===\n");

const PORT = await freePort();
const server = await startServer({
  port: PORT,
  routesDir: join(root, "src/routes"),
  modelsDir: join(root, "src/models"),
  staticDir: join(root, "public"),
});
const call = (m: string, p: string, h: Record<string, string> = {}, b?: unknown) => request(PORT, m, p, h, b);
async function sessionCookie(values: Record<string, unknown>): Promise<string> {
  const stored = await call("POST", "/contract/session", {}, values);
  const setCookie = stored.headers["set-cookie"] ?? [];
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

try {
  // ── auth-form-token-is-not-identity ──────────────────────────────────
  await check("a form token in the bearer header is refused by the route gate", async () => {
    const res = await call("POST", "/contract/write", { Authorization: `Bearer ${formToken()}` });
    return [res.status === 401, `status=${res.status}`];
  });

  await check("a form token in the body is refused by the route gate", async () => {
    const res = await call("POST", "/contract/write", {}, { formToken: formToken() });
    return [res.status === 401 && res.headers["freshtoken"] === undefined, `status=${res.status}`];
  });

  await check("a form token in the session is refused by the route gate", async () => {
    const cookie = await sessionCookie({ token: formToken() });
    const res = await call("GET", "/contract/read", { Cookie: cookie });
    return [cookie !== "" && res.status === 401, `cookie=${cookie} status=${res.status}`];
  });

  await check("a form token in the body falls through to the session token", async () => {
    const cookie = await sessionCookie({ token: getToken({ user_id: 7 }) });
    const res = await call("POST", "/contract/write", { Cookie: cookie }, { formToken: formToken() });
    return [res.status === 200 && res.json?.user?.user_id === 7, `status=${res.status} body=${res.body}`];
  });

  await check("a form token is refused on a secured websocket upgrade", () => {
    const form = formToken();
    const route = { authRequired: true };
    const viaHeader = wsAuthorized(route, { authorization: `Bearer ${form}` });
    const viaSubprotocol = wsAuthorized(route, {}, "", `bearer, ${form}`);
    const viaQuery = wsAuthorized(route, {}, `token=${form}`);
    const [payload, ok] = wsAuthorized(route, { authorization: `Bearer ${getToken({ user_id: 3 })}` });
    return [!viaHeader[1] && viaHeader[0] === null && !viaSubprotocol[1] && !viaQuery[1] && ok && payload?.user_id === 3,
      JSON.stringify([viaHeader, viaSubprotocol, viaQuery])];
  });

  await check("a form token is refused by authenticate request", () => {
    let middlewareStatus = 0;
    const res: any = (_body: unknown, status: number) => { middlewareStatus = status; };
    authMiddleware()({ headers: { authorization: `Bearer ${formToken()}` } } as any, res, () => { middlewareStatus = 200; });
    return [authenticateRequest({ authorization: `Bearer ${formToken()}` }) === null
      && authenticateRequest({ authorization: `Bearer ${getToken({ user_id: 4 })}` })?.user_id === 4
      && middlewareStatus === 401, `middleware=${middlewareStatus}`];
  });

  await check("refresh never issues a fresh token from a form token", async () => {
    const gate = await call("POST", "/contract/write", {}, { formToken: formToken() });
    const rotated = refreshToken(formToken());
    const rotatedGate = await call("POST", "/contract/write", { Authorization: `Bearer ${rotated}` });
    const refreshed = refreshToken(getToken({ user_id: 5 }));
    return [gate.headers["freshtoken"] === undefined && validToken(rotated!)?.type === "form"
      && rotatedGate.status === 401 && validToken(refreshed!)?.user_id === 5, `rotatedGate=${rotatedGate.status}`];
  });

  await check("an auth token still passes the route gate", async () => {
    const token = getToken({ user_id: 9 });
    const bearer = await call("POST", "/contract/write", { Authorization: `Bearer ${token}` });
    const body = await call("POST", "/contract/write", {}, { formToken: token });
    return [bearer.status === 200 && body.status === 200 && typeof body.headers["freshtoken"] === "string",
      `bearer=${bearer.status} body=${body.status}`];
  });

  // ── auth-secret-strength ─────────────────────────────────────────────
  await check("signing with a blank secret is refused", () => {
    delete process.env.TINA4_SECRET;
    try {
      let envMessage = "";
      try { getToken({ user_id: 1 }); } catch (error) { envMessage = (error as Error).message; }
      let explicitMessage = "";
      try { getToken({ user_id: 1 }, ""); } catch (error) { explicitMessage = (error as Error).message; }
      return [/TINA4_SECRET.*openssl rand -hex 32/.test(envMessage) && /TINA4_SECRET/.test(explicitMessage),
        `env=${envMessage} explicit=${explicitMessage}`];
    } finally {
      process.env.TINA4_SECRET = SECRET;
    }
  });

  await check("signing with a secret shorter than 32 bytes is refused", () => {
    let message = "";
    try { getToken({ user_id: 1 }, "x".repeat(31)); } catch (error) { message = (error as Error).message; }
    return [/32 bytes/.test(message), message];
  });

  await check("a token forged with the empty key is rejected", async () => {
    const forged = hs256({ user_id: 1, exp: Math.floor(Date.now() / 1000) + 600 }, "");
    delete process.env.TINA4_SECRET;
    try {
      const gate = await call("POST", "/contract/write", { Authorization: `Bearer ${forged}` });
      return [validToken(forged) === null && validToken(forged, "") === null && gate.status === 401,
        `gate=${gate.status}`];
    } finally {
      process.env.TINA4_SECRET = SECRET;
    }
  });

  await check("a weak key rejection names the fix", () => {
    // Rejection alone is guaranteed twice over (the signer refuses too); the
    // verifier's own check is what TELLS the operator why every token fails.
    // Observed in a real child process.
    const token = hs256({ user_id: 1 }, "short");
    const code = `import { validToken } from ${JSON.stringify(join(repo, "packages/core/src/auth.ts"))};\n` +
      `console.log("RESULT", JSON.stringify(validToken(${JSON.stringify(token)}, "short")));\n` +
      "setTimeout(() => process.exit(0), 200);\n";
    const dir = mkdtempSync(join(tmpdir(), "tina4-weak-"));
    try {
      writeFileSync(join(dir, "weak.ts"), code);
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith("TINA4_") && value !== undefined) env[key] = value;
      }
      const result = spawnSync(process.execPath, ["--import", join(repo, "node_modules/tsx/dist/loader.mjs"), join(dir, "weak.ts")],
        { cwd: dir, env, encoding: "utf8", timeout: 60_000 });
      const output = `${result.stdout}${result.stderr}`;
      return [result.status === 0 && output.includes("RESULT null") && output.includes("at least 32 bytes")
        && output.includes("openssl rand -hex 32"), output.slice(0, 400)];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await check("a 32 byte secret signs and verifies", () => {
    const key = "k".repeat(32);
    return validToken(getToken({ user_id: 2 }, key), key)?.user_id === 2;
  });

  function boot(envFile: string): { status: number | null; output: string } {
    const dir = mkdtempSync(join(tmpdir(), "tina4-boot-"));
    try {
      mkdirSync(join(dir, "src/routes"), { recursive: true });
      writeFileSync(join(dir, "package.json"), '{"type":"module"}');
      writeFileSync(join(dir, ".env"), envFile);
      writeFileSync(join(dir, "boot.ts"),
        `import { startServer } from ${JSON.stringify(join(repo, "packages/core/src/index.ts"))};\n` +
        `const server = await startServer({ port: 0, routesDir: ${JSON.stringify(join(dir, "src/routes"))} });\n` +
        "console.log('BOOTED'); server.close(); process.exit(0);\n");
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith("TINA4_") && value !== undefined) env[key] = value;
      }
      env.TINA4_NO_BROWSER = "true";
      const result = spawnSync(process.execPath, ["--import", join(repo, "node_modules/tsx/dist/loader.mjs"), join(dir, "boot.ts")],
        { cwd: dir, env, encoding: "utf8", timeout: 60_000 });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  await check("boot outside dev refuses a blank secret", () => {
    const { status, output } = boot("TINA4_DEBUG=false\n");
    return [status !== 0 && !output.includes("BOOTED") && output.includes("TINA4_SECRET") && output.includes("openssl rand -hex 32"),
      `status=${status} output=${output.slice(0, 300)}`];
  });

  await check("boot outside dev refuses a short secret", () => {
    const { status, output } = boot("TINA4_DEBUG=false\nTINA4_SECRET=too-short\n");
    return [status !== 0 && !output.includes("BOOTED") && output.includes("32 bytes"),
      `status=${status} output=${output.slice(0, 300)}`];
  });

  // ── empty-peer-is-not-loopback ───────────────────────────────────────
  await check("an empty peer is not loopback", () => isLoopback("") === false && isLoopback(null) === false && isLoopback(undefined) === false);

  await check("a loopback peer is loopback", () =>
    ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1", "localhost"].every((a) => isLoopback(a))
    && ["10.0.0.1", "0.0.0.0", "192.168.1.5", "::ffff:10.0.0.1"].every((a) => !isLoopback(a)));

  await check("an empty peer is refused by the mcp gate", () => {
    const saved = { debug: process.env.TINA4_DEBUG, mcp: process.env.TINA4_MCP, remote: process.env.TINA4_MCP_REMOTE };
    process.env.TINA4_DEBUG = "true";
    delete process.env.TINA4_MCP;
    delete process.env.TINA4_MCP_REMOTE;
    try {
      return isRequestAllowed("", false) === false && isRequestAllowed("127.0.0.1", false) === true;
    } finally {
      if (saved.debug === undefined) delete process.env.TINA4_DEBUG; else process.env.TINA4_DEBUG = saved.debug;
      if (saved.mcp !== undefined) process.env.TINA4_MCP = saved.mcp;
      if (saved.remote !== undefined) process.env.TINA4_MCP_REMOTE = saved.remote;
    }
  });

  // ── sso-identity-expires ─────────────────────────────────────────────
  const sso = (expiresAt: number) => ({ marker: 1, _tina4_sso: { version: 1, expires_at: expiresAt,
    identity: { issuer: "https://idp.example", subject: "u-1" } } });

  await check("an expired sso identity is refused", async () => {
    const res = await call("GET", "/contract/read", { Cookie: await sessionCookie(sso(Math.floor(Date.now() / 1000) - 5)) });
    return [res.status === 401, `status=${res.status}`];
  });

  await check("a live sso identity passes", async () => {
    const live = await call("GET", "/contract/read", { Cookie: await sessionCookie(sso(Math.floor(Date.now() / 1000) + 300)) });
    const noLifetime = await call("GET", "/contract/read", { Cookie: await sessionCookie(sso(0)) });
    return [live.status === 200 && live.json?.user?.subject === "u-1" && noLifetime.status === 200,
      `live=${live.status} none=${noLifetime.status}`];
  });

  // ── form-token-lifetime ──────────────────────────────────────────────
  await check("a form token lives token limit minutes", () => {
    process.env.TINA4_TOKEN_LIMIT = "5";
    try {
      const payload = validToken(formToken());
      return [(payload?.exp as number) - (payload?.iat as number) === 300, JSON.stringify(payload)];
    } finally {
      delete process.env.TINA4_TOKEN_LIMIT;
    }
  });
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
  delete process.env.TINA4_RATE_LIMIT;
}

// ── a form token still passes csrf (its own server: CSRF is a global gate) ──
{
  const csrfRoot = mkdtempSync(join(tmpdir(), "tina4-auth-contract-csrf-"));
  mkdirSync(join(csrfRoot, "src/routes/contract/session"), { recursive: true });
  mkdirSync(join(csrfRoot, "src/routes/contract/csrf"), { recursive: true });
  writeFileSync(join(csrfRoot, "package.json"), '{"type":"module"}');
  writeFileSync(join(csrfRoot, "src/routes/contract/session/post.ts"),
    "export const secure = false;\n" +
    "export default async function (req: any, res: any) {\n" +
    "  for (const [key, value] of Object.entries(req.body ?? {})) req.session.set(key, value);\n" +
    "  res.json({ ok: true });\n" +
    "}\n");
  writeFileSync(join(csrfRoot, "src/routes/contract/csrf/post.ts"),
    "export default async function (req: any, res: any) { res.json({ user: req.user ?? null }); }\n");
  process.env.TINA4_CSRF = "true";
  const csrfPort = await freePort();
  const csrfServer = await startServer({ port: csrfPort, routesDir: join(csrfRoot, "src/routes"),
    modelsDir: join(csrfRoot, "src/models"), staticDir: join(csrfRoot, "public") });
  try {
    await check("a form token still passes csrf", async () => {
      // CSRF skips noAuth routes, so the realistic case is a logged-in user
      // (auth token in the session) posting a rendered form.
      const stored = await request(csrfPort, "POST", "/contract/session", { "X-Form-Token": formToken() },
        { token: getToken({ user_id: 11 }) });
      const cookie = (stored.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
      const passedCsrf = await request(csrfPort, "POST", "/contract/csrf", { Cookie: cookie }, { formToken: formToken() });
      const refused = await request(csrfPort, "POST", "/contract/csrf", { Cookie: cookie }, { x: 1 });
      // A form token in the Bearer slot is not an API-client identity, so it
      // does not skip the CSRF check either.
      const bearerForm = await request(csrfPort, "POST", "/contract/csrf",
        { Cookie: cookie, Authorization: `Bearer ${formToken()}` }, { x: 1 });
      return [passedCsrf.status === 200 && passedCsrf.json?.user?.user_id === 11 && refused.status === 403
        && bearerForm.status === 403,
        `stored=${stored.status} passed=${passedCsrf.status} ${passedCsrf.body} refused=${refused.status} bearerForm=${bearerForm.status}`];
    });
  } finally {
    csrfServer.close();
    delete process.env.TINA4_CSRF;
    rmSync(csrfRoot, { recursive: true, force: true });
  }
}

if (existsSync(root)) rmSync(root, { recursive: true, force: true });
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
