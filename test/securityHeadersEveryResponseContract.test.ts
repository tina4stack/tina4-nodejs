/**
 * Security headers on every response, from every entry point (ADR-0066).
 *
 * The runner for the three ADR-0066 invariants in
 * tina4-documentation/plan/v3/fixtures/securityheaders_contract.json; the
 * Python, PHP and Ruby suites carry the same case names.
 *
 *   - static files, the 404 and 405 fallbacks and the framework's own refusals
 *     carry the canonical security header set (tina4-python#137);
 *   - a header a route already set is kept - only missing headers are filled in;
 *   - both Node entry points, the startServer() listener and handle() embedded
 *     in the caller's own node:http server, attach the security headers and
 *     CSRF and serve the configured SSO routes (tina4-python#134).
 *
 * NO MOCKS: a real startServer() on a real socket, handle() mounted in a real
 * node:http server on its own port, and a real OIDC discovery document served
 * by a real local HTTP server.
 *
 * Run with: npx tsx test/securityHeadersEveryResponseContract.test.ts
 */
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle, startServer } from "../packages/core/src/index.ts";
import { freePort } from "./freePort.ts";

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

const CANONICAL = ["x-frame-options", "x-content-type-options", "content-security-policy",
  "referrer-policy", "x-xss-protection", "permissions-policy"];
const ROUTE_CSP = "default-src 'none'; img-src 'self'";
const TEST_DIR = mkdtempSync(join(tmpdir(), "tina4-secure-contract-"));
const SESSION_DIR = mkdtempSync(join(tmpdir(), "tina4-secure-contract-sess-"));
const LISTENER_PORT = await freePort();
const EMBED_PORT = await freePort();
const IDP_PORT = await freePort();
const ISSUER = `http://127.0.0.1:${IDP_PORT}/realms/contract`;

interface Reply { status: number; headers: http.IncomingHttpHeaders }

function send(port: number, method: string, path: string): Promise<Reply> {
  return new Promise((done, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path, method,
      headers: { "Content-Type": "application/json" } }, (response) => {
      response.on("data", () => { /* drain */ });
      response.on("end", () => done({ status: response.statusCode ?? 0, headers: response.headers }));
    });
    request.on("error", reject);
    request.end(method === "POST" || method === "PUT" ? "{}" : undefined);
  });
}

const missing = (reply: Reply): string[] => CANONICAL.filter((name) => reply.headers[name] === undefined);

// The OpenID provider: only discovery is needed to prove the routes are mounted.
const idp = http.createServer((req, res) => {
  if (req.url === "/realms/contract/.well-known/openid-configuration") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`,
      token_endpoint: `${ISSUER}/token`, introspection_endpoint: `${ISSUER}/introspect` }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((ready) => idp.listen(IDP_PORT, "127.0.0.1", () => ready()));

for (const route of ["secure-contract/page", "secure-contract/own-headers", "secure-contract/write"]) {
  mkdirSync(join(TEST_DIR, "src/routes", route), { recursive: true });
}
mkdirSync(join(TEST_DIR, "src/public"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, "src/public/hello.html"), "<!doctype html><title>static</title><p>static</p>");
writeFileSync(join(TEST_DIR, "src/routes/secure-contract/page/get.ts"), `
export default async function (req: any, res: any) {
  return res.html("<!doctype html><title>page</title>");
}
`);
writeFileSync(join(TEST_DIR, "src/routes/secure-contract/own-headers/get.ts"), `
export default async function (req: any, res: any) {
  res.header("Content-Security-Policy", ${JSON.stringify(ROUTE_CSP)});
  res.header("X-Frame-Options", "DENY");
  return res.html("shaped by the route");
}
`);
writeFileSync(join(TEST_DIR, "src/routes/secure-contract/write/post.ts"), `
export default async function (req: any, res: any) {
  return res.json({ written: true });
}
`);

process.env.TINA4_CSRF = "true";
process.env.TINA4_SECRET = "secure-contract-secret";
process.env.TINA4_DEBUG = "false";
process.env.TINA4_RATE_LIMIT = "100000";
process.env.TINA4_SESSION_PATH = SESSION_DIR;
process.env.TINA4_SSO_ISSUER = ISSUER;
process.env.TINA4_SSO_CLIENT_ID = "secure-contract-app";
process.env.TINA4_SSO_CLIENT_SECRET = "secure-contract-secret";
process.env.TINA4_SSO_REDIRECT_URI = `http://127.0.0.1:${LISTENER_PORT}/auth/callback`;
for (const key of ["TINA4_CSP", "TINA4_FRAME_OPTIONS", "TINA4_HSTS", "TINA4_PUBLIC_DIR"]) delete process.env[key];

console.log("=== Security headers on every response, from every entry point (ADR-0066) ===");

const server = await startServer({ port: LISTENER_PORT, basePath: TEST_DIR });
const embed = http.createServer((rawRequest, rawResponse) => {
  handle(rawRequest, rawResponse).catch((error) => {
    rawResponse.statusCode = 500;
    rawResponse.end(String(error));
  });
});
await new Promise<void>((ready) => embed.listen(EMBED_PORT, "127.0.0.1", () => ready()));

const ENTRY_POINTS: Array<[string, number]> = [["startServer listener", LISTENER_PORT], ["handle() embedded", EMBED_PORT]];

try {
  for (const [label, port] of ENTRY_POINTS) {
    console.log(`\n--- ${label} ---`);
    const expect = async (name: string, method: string, path: string, statuses: number[]) => {
      const reply = await send(port, method, path);
      assert(`${name} (${label})`, statuses.includes(reply.status) && missing(reply).length === 0
        && reply.headers["x-content-type-options"] === "nosniff",
        `status=${reply.status} missing=${JSON.stringify(missing(reply))}`);
    };
    await expect("a static file carries the security headers", "GET", "/hello.html", [200]);
    await expect("a 404 carries the security headers", "GET", "/secure-contract/nowhere", [404]);
    await expect("a 405 carries the security headers", "PUT", "/secure-contract/page", [405]);
    await expect("a refusal carries the security headers", "POST", "/secure-contract/write", [401, 403]);

    const own = await send(port, "GET", "/secure-contract/own-headers");
    assert(`a header the route already set is not overwritten (${label})`,
      own.status === 200 && own.headers["content-security-policy"] === ROUTE_CSP
        && own.headers["x-frame-options"] === "DENY" && own.headers["x-content-type-options"] === "nosniff",
      `status=${own.status} csp=${String(own.headers["content-security-policy"])} xfo=${String(own.headers["x-frame-options"])}`);

    const page = await send(port, "GET", "/secure-contract/page");
    const forged = await send(port, "POST", "/secure-contract/write");
    assert(`every entry point attaches the security headers and csrf (${label})`,
      page.status === 200 && missing(page).length === 0 && [401, 403].includes(forged.status),
      `page=${page.status} missing=${JSON.stringify(missing(page))} write=${forged.status}`);

    const login = await send(port, "GET", "/auth/login");
    assert(`every entry point mounts the sso routes (${label})`,
      [302, 303].includes(login.status) && String(login.headers.location ?? "").startsWith(`${ISSUER}/auth`),
      `status=${login.status} location=${String(login.headers.location)}`);
  }
} finally {
  embed.close();
  idp.close();
  server.close();
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(SESSION_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
