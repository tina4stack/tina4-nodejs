/**
 * CORS: a SAME-origin request is not a CORS event, and no warning ever advises
 * '*' (tina4-python#139 parity).
 *
 * THE DEFECT (Python, CONFIRMED in Node): CorsPolicy treated every request that
 * carried an Origin header as cross-origin. Browsers send Origin on every
 * same-origin POST/PUT/PATCH/DELETE, so an SPA served by the app itself logged
 * "CORS: refused cross-origin request ... (or '*' to allow any origin)" on its
 * first save - and the advice would open the API to every website to silence a
 * warning about the app's own page. With an allow-list for other sites the same
 * request logged "the browser will block this response", also untrue.
 *
 * THE CONTRACT: a request whose Origin equals its own origin (scheme://host
 * [:port], with http:80 and https:443 as default ports, scheme honouring
 * X-Forwarded-Proto) is same-origin: no CORS warning, never refused. That only
 * silences a warning and never GRANTS anything (no Access-Control-Allow-Origin
 * is added for it), so a spoofed Host gains nothing. A genuinely cross-origin
 * request that is not allowed still warns, naming the origin to add, never '*'.
 *
 * NO MOCKS: each policy runs a REAL startServer() in a child process; the test
 * makes real HTTP requests and reads the child's REAL stdout, where Log writes.
 *
 * Same case names in all four frameworks:
 *   - same_origin_post_logs_no_cors_warning
 *   - same_origin_with_default_port_is_same_origin
 *   - same_origin_behind_an_https_proxy_is_same_origin
 *   - same_origin_is_never_granted_cors_headers
 *   - disallowed_cross_origin_warns_without_advising_wildcard
 *   - allowed_cross_origin_gets_cors_headers
 *
 * Run with: npx tsx test/corsSameOrigin.test.ts
 */
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

const REPO = resolve(import.meta.dirname, "..");
const TEST_DIR = mkdtempSync(join(tmpdir(), "tina4-cors-same-origin-"));
mkdirSync(join(TEST_DIR, "src/routes/api/save"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, "src/routes/api/save/post.ts"), `
export const noAuth = true;
export default async function (req: any, res: any) {
  return res.json({ saved: true });
}
`);
writeFileSync(join(TEST_DIR, "server.ts"), `
import { startServer } from ${JSON.stringify(join(REPO, "packages/core/src/index.ts"))};
await startServer({ port: Number(process.env.PORT), basePath: ${JSON.stringify(TEST_DIR)} });
console.log("TEST-SERVER-READY");
`);

interface Server { port: number; child: ChildProcess; output: () => string }

async function boot(env: Record<string, string>): Promise<Server> {
  const port = await freePort();
  const childEnv: Record<string, string | undefined> = {
    ...process.env, ...env, PORT: String(port), TINA4_DEBUG: "false", TINA4_RATE_LIMIT: "100000",
    TINA4_OVERRIDE_CLIENT: "true", TINA4_NO_AI_PORT: "true",
  };
  if (!("TINA4_CORS_ORIGINS" in env)) delete childEnv.TINA4_CORS_ORIGINS;
  const child = spawn(process.execPath, ["--import", "tsx", join(TEST_DIR, "server.ts")], {
    cwd: REPO, env: childEnv as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (c) => { out += c; });
  child.stderr!.on("data", (c) => { out += c; });
  await new Promise<void>((ready, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 60000);
    const check = setInterval(() => {
      if (out.includes("TEST-SERVER-READY")) { clearInterval(check); clearTimeout(timer); ready(); }
    }, 50);
    child.on("exit", (code) => { clearInterval(check); clearTimeout(timer); reject(new Error(`server exited ${code}:\n${out}`)); });
  });
  return { port, child, output: () => out };
}

interface Reply { status: number; headers: http.IncomingHttpHeaders }

function send(port: number, method: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((done, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/api/save", method, headers }, (res) => {
      res.on("data", () => { /* drain */ });
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

/** The CORS lines the server wrote since `mark`. */
async function corsLinesSince(server: Server, mark: number): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 150));
  return server.output().slice(mark).split("\n").filter((l) => l.includes("CORS"));
}

const JSON_POST = { "Content-Type": "application/json" };

console.log("=== CORS same-origin (tina4-python#139 parity) ===");

// ── No policy configured ───────────────────────────────────────────────────
console.log("\n--- TINA4_CORS_ORIGINS unset ---");
{
  const s = await boot({});
  try {
    let mark = s.output().length;
    const own = await send(s.port, "POST", { ...JSON_POST, Origin: `http://127.0.0.1:${s.port}` });
    let lines = await corsLinesSince(s, mark);
    assert("same_origin_post_logs_no_cors_warning (no policy)", own.status === 200 && lines.length === 0,
      `status=${own.status} log=${JSON.stringify(lines)}`);

    mark = s.output().length;
    const evil = await send(s.port, "POST", { ...JSON_POST, Origin: "https://evil.example" });
    lines = await corsLinesSince(s, mark);
    assert("disallowed_cross_origin_warns_without_advising_wildcard (no policy)",
      evil.headers["access-control-allow-origin"] === undefined
        && lines.length === 1 && lines[0].split(/\s+/).includes("https://evil.example") && !lines[0].includes("*")
        && lines[0].includes("TINA4_CORS_ORIGINS"),
      `acao=${String(evil.headers["access-control-allow-origin"])} log=${JSON.stringify(lines)}`);
  } finally {
    s.child.kill("SIGKILL");
  }
}

// ── An allow-list for OTHER sites ───────────────────────────────────────────
console.log("\n--- TINA4_CORS_ORIGINS=https://partner.example.com ---");
{
  const s = await boot({ TINA4_CORS_ORIGINS: "https://partner.example.com" });
  try {
    let mark = s.output().length;
    const own = await send(s.port, "POST", { ...JSON_POST, Origin: `http://127.0.0.1:${s.port}` });
    let lines = await corsLinesSince(s, mark);
    assert("same_origin_post_logs_no_cors_warning (allow-list)", own.status === 200 && lines.length === 0,
      `status=${own.status} log=${JSON.stringify(lines)}`);
    assert("same_origin_is_never_granted_cors_headers", own.headers["access-control-allow-origin"] === undefined,
      `acao=${String(own.headers["access-control-allow-origin"])}`);

    mark = s.output().length;
    const other = await send(s.port, "POST", { ...JSON_POST, Origin: "https://other.example" });
    lines = await corsLinesSince(s, mark);
    assert("disallowed_cross_origin_warns_without_advising_wildcard (allow-list)",
      other.headers["access-control-allow-origin"] === undefined
        && lines.length === 1 && lines[0].split(/\s+/).includes("https://other.example") && !lines[0].includes("*"),
      `acao=${String(other.headers["access-control-allow-origin"])} log=${JSON.stringify(lines)}`);

    mark = s.output().length;
    const partner = await send(s.port, "POST", { ...JSON_POST, Origin: "https://partner.example.com" });
    const preflight = await send(s.port, "OPTIONS", {
      Origin: "https://partner.example.com", "Access-Control-Request-Method": "POST",
    });
    lines = await corsLinesSince(s, mark);
    assert("allowed_cross_origin_gets_cors_headers",
      partner.status === 200 && partner.headers["access-control-allow-origin"] === "https://partner.example.com"
        && preflight.status === 204 && preflight.headers["access-control-allow-origin"] === "https://partner.example.com"
        && String(preflight.headers["access-control-allow-methods"] ?? "").includes("POST")
        && lines.length === 0,
      `post=${partner.status}/${String(partner.headers["access-control-allow-origin"])} `
        + `preflight=${preflight.status}/${String(preflight.headers["access-control-allow-origin"])} log=${JSON.stringify(lines)}`);
  } finally {
    s.child.kill("SIGKILL");
  }
}

// ── Default ports and an https proxy ───────────────────────────────────────
// Warnings are warn-once PER REASON (ADR-0048), so each of these runs as the
// FIRST request on a fresh server - under the defect it would be the one that
// logs the "denied" warning.
console.log("\n--- same-origin variants, each on a fresh server ---");
const VARIANTS: Array<[string, Record<string, string>]> = [
  ["same_origin_with_default_port_is_same_origin", { Host: "app.test", Origin: "http://app.test:80" }],
  ["same_origin_behind_an_https_proxy_is_same_origin",
    { Host: "app.test", "X-Forwarded-Proto": "https", Origin: "https://app.test:443" }],
];
for (const [name, headers] of VARIANTS) {
  const s = await boot({ TINA4_CORS_ORIGINS: "https://partner.example.com" });
  try {
    const mark = s.output().length;
    const r = await send(s.port, "POST", { ...JSON_POST, ...headers });
    const lines = await corsLinesSince(s, mark);
    assert(name, r.status === 200 && lines.length === 0 && r.headers["access-control-allow-origin"] === undefined,
      `status=${r.status} acao=${String(r.headers["access-control-allow-origin"])} log=${JSON.stringify(lines)}`);
  } finally {
    s.child.kill("SIGKILL");
  }
}

try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
