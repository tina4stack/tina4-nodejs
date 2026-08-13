/**
 * Dev-admin security conformance (feature 127) — REAL dispatch, NO mocks.
 *
 * Drives the shared devadmin_contract.json cases through the REAL front
 * controller — the exported `handle()` (the exact entry the bound server uses)
 * → the `dispatch` closure `startServer` installed → the real `runMatchedRoute`
 * gate → the real dev-admin handlers → a real file-backed SQLite. NOTHING is
 * mocked: the witness of every case is a real side effect (a file that is / is
 * not written, a real SQLite row that is / is not inserted, a secret string that
 * never appears in a response body, escaped bytes in the injected toolbar).
 *
 * The audit found the OLD tina4-nodejs dev-admin test drove handlers through
 * mock req/res that BYPASSED the mount gate and the guard, so a passing test
 * proved nothing about the wire. This suite is deliberately real-dispatch.
 *
 * HOW THE NON-LOOPBACK PEER IS DRIVEN (the crux, mirrors test/mcpCallGate.test.ts):
 * a real `http.Server` whose request listener calls `handle()`; at its
 * `'connection'` event we `Object.defineProperty` the ACCEPTED socket's
 * `remoteAddress` to the exact value a genuine remote client would present
 * (8.8.8.8). Real socket + full real pipeline; only the peer's reported address
 * is set — X-Forwarded-For never governs.
 *
 * Fixture: tina4-documentation/plan/v3/fixtures/devadmin_contract.json
 * Owner decisions: DEVADMIN-DEC-01 (same-origin), DEC-02 (loopback), DEC-03
 * (.env denylist), DEC-04 (toolbar escape), DEC-05 (mcp/call gate), DEC-06 (this).
 *
 * Run with: npx tsx test/devAdminConformance.test.ts
 */
import { startServer, handle } from "../packages/core/src/index.ts";
import { initDatabase, closeDatabase } from "../packages/orm/src/index.ts";
import http from "node:http";
import net from "node:net";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { freePort } from "./freePort.ts";

const TEST_DIR = "/tmp/tina4-devadmin-conformance-test";
const SECRET = "sup3r-sekret-do-not-leak-127";
const DB_PASSWORD_LEAK = "pg-password-leak";

let pass = 0;
let fail = 0;
function assert(label: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`);
    fail++;
  }
}

// ── env plumbing (read lazily per request, so flipping between calls is faithful) ──
const ENV_KEYS = [
  "TINA4_DEBUG", "TINA4_MCP", "TINA4_MCP_REMOTE", "TINA4_MCP_TOKEN",
  "TINA4_API_KEY", "TINA4_RATE_LIMIT", "TINA4_NO_AI_PORT", "TINA4_CSRF",
  "TINA4_SECRET", "TINA4_DATABASE_URL",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
function setEnv(patch: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ── real HTTP requests over a real socket (fresh conn each time → current peer) ──
function request(
  method: string,
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1", port, path, method,
        agent: false, // fresh socket per request → fresh 'connection' → current peer
        headers: {
          ...(payload !== undefined
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
          Connection: "close",
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let data: any;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode!, data, raw });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
const post = (port: number, path: string, body: unknown, headers: Record<string, string> = {}) =>
  request("POST", port, path, body, headers);
const get = (port: number, path: string, headers: Record<string, string> = {}) =>
  request("GET", port, path, undefined, headers);

// A RAW socket GET so the malformed toolbar target (`//<script>...`, which
// http.request refuses as unescaped) reaches the server verbatim. The server's
// llhttp accepts the target, `new URL` then throws and the framework falls back
// to the raw path — the exact real Node XSS vector the toolbar reflects.
function rawGet(port: number, target: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const hdrs = Object.entries({ Host: "localhost", Accept: "text/html", Connection: "close", ...headers })
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
      socket.write(`GET ${target} HTTP/1.1\r\n${hdrs}\r\n\r\n`);
    });
    let raw = "";
    socket.on("data", (c) => (raw += c.toString()));
    socket.on("end", () => resolve(raw));
    socket.on("error", reject);
  });
}

// ── throwaway project with a real .env carrying secrets ──────────────────────
try { rmSync(TEST_DIR, { recursive: true }); } catch {}
mkdirSync(join(TEST_DIR, "src/routes"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(
  join(TEST_DIR, "src/routes/get.ts"),
  "export default async function (_req: any, res: any) { return res.json({ ok: true }); }\n",
);
writeFileSync(
  join(TEST_DIR, ".env"),
  `TINA4_SECRET=${SECRET}\nTINA4_DATABASE_PASSWORD=${DB_PASSWORD_LEAK}\nTINA4_MCP_TOKEN=mcp-token-leak\n`,
);
writeFileSync(join(TEST_DIR, ".env.example"), "TINA4_SECRET=\n");
writeFileSync(join(TEST_DIR, "readme.txt"), "public\n");

// The dev tools + file endpoints resolve their root from process.cwd() at
// registration/request time, so chdir into TEST_DIR FIRST. Restored at cleanup.
const ORIG_CWD = process.cwd();
process.chdir(TEST_DIR);

// A clean env baseline for every case (mirrors the Python fixture's delenv).
setEnv({
  TINA4_RATE_LIMIT: "100000", TINA4_NO_AI_PORT: "true", TINA4_CSRF: undefined,
  TINA4_MCP: undefined, TINA4_MCP_REMOTE: undefined, TINA4_MCP_TOKEN: undefined,
  TINA4_API_KEY: undefined, TINA4_SECRET: SECRET, TINA4_DATABASE_URL: undefined,
});

console.log("=== Dev-admin security conformance (feature 127) — real dispatch, no mocks ===\n");

// ─────────────────────────────────────────────────────────────────────────────
// DEVADMIN-DEC-06 — behavioural prod-404 (TINA4_DEBUG off ⇒ /__dev is ABSENT)
// ─────────────────────────────────────────────────────────────────────────────
console.log("-- DEC-06: prod-404 (debug off) --");
setEnv({ TINA4_DEBUG: "false" });
{
  const prodPort = await freePort();
  const prodBoot = await startServer({
    port: prodPort,
    routesDir: join(TEST_DIR, "src/routes"),
    modelsDir: join(TEST_DIR, "src/models"),
    staticDir: join(TEST_DIR, "public"),
  });
  await new Promise((r) => setTimeout(r, 40));

  const ui = await get(prodPort, "/__dev");
  const probe = join(TEST_DIR, "prod404_probe.txt");
  try { rmSync(probe); } catch {}
  const save = await post(
    prodPort, "/__dev/api/file/save",
    { path: "prod404_probe.txt", content: "should not exist" },
    { "Sec-Fetch-Site": "same-origin" },
  );
  assert(
    "dev admin is absent without debug",
    ui.status === 404 && save.status === 404 && !existsSync(probe),
    `ui=${ui.status} save=${save.status} wrote=${existsSync(probe)}`,
  );
  prodBoot.close();
  await new Promise((r) => setTimeout(r, 30));
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot the REAL debug server + the peer-controllable pipeline for DEC-01..05.
// ─────────────────────────────────────────────────────────────────────────────
setEnv({ TINA4_DEBUG: "true" });

// Real file-backed SQLite the mcp database_execute tool writes to; initDatabase
// publishes the wrapper on globalThis.__tina4_db — exactly what the tool reads.
const mcpDb: any = await initDatabase({ url: "sqlite:///gate_probe.db" });
await mcpDb.execute("CREATE TABLE gate_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
await mcpDb.commit?.();
async function rowCount(): Promise<number> {
  const row: any = await mcpDb.fetchOne("SELECT COUNT(*) AS c FROM gate_probe");
  return Number(row?.c ?? -1);
}

const BOOT_PORT = await freePort();
const boot = await startServer({
  port: BOOT_PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});
await new Promise((r) => setTimeout(r, 40));

// peerServer: real http.Server → real handle(); the accepted socket's peer is
// set per scenario (the deterministic non-loopback witness, mirrors mcpCallGate).
let currentPeer = "127.0.0.1";
const peerServer = http.createServer((rawReq, rawRes) => { void handle(rawReq, rawRes); });
peerServer.on("connection", (socket) => {
  Object.defineProperty(socket, "remoteAddress", {
    value: currentPeer, configurable: true, enumerable: true,
  });
});
await new Promise<void>((r) => peerServer.listen(0, "127.0.0.1", () => r()));
const peerPort = (peerServer.address() as any).port;

function probePath(name: string): string {
  const p = join(TEST_DIR, name);
  try { rmSync(p); } catch {}
  return p;
}

// ── DEC-01: fail-closed same-origin gate ─────────────────────────────────────
console.log("\n-- DEC-01: same-origin gate --");
{
  currentPeer = "127.0.0.1"; // loopback, so ONLY same-origin can refuse here
  const probe = probePath("csrf_probe.txt");
  const secFetch = await post(
    peerPort, "/__dev/api/file/save",
    { path: "csrf_probe.txt", content: "pwned by drive-by CSRF" },
    { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" },
  );
  const originOnly = await post(
    peerPort, "/__dev/api/file/save",
    { path: "csrf_probe.txt", content: "pwned" },
    { Origin: "https://evil.example" },
  );
  assert(
    "a cross origin write is refused and writes nothing",
    secFetch.status === 403 && originOnly.status === 403 && !existsSync(probe),
    `secFetch=${secFetch.status} originOnly=${originOnly.status} wrote=${existsSync(probe)}`,
  );
}
{
  currentPeer = "127.0.0.1";
  const probe = probePath("same_origin_probe.txt");
  const res = await post(
    peerPort, "/__dev/api/file/save",
    { path: "same_origin_probe.txt", content: "legit save" },
    { "Sec-Fetch-Site": "same-origin" },
  );
  assert(
    "a same origin write is allowed",
    res.status === 200 && existsSync(probe) && readFileSync(probe, "utf-8") === "legit save",
    `status=${res.status} wrote=${existsSync(probe)}`,
  );
}

// ── DEC-03: .env / secret denylist ───────────────────────────────────────────
console.log("\n-- DEC-03: .env denylist --");
{
  currentPeer = "127.0.0.1";
  const read = await get(peerPort, "/__dev/api/file?path=.env");
  const raw = await get(peerPort, "/__dev/api/file/raw?path=.env");
  const example = await get(peerPort, "/__dev/api/file?path=.env.example");
  const leaked = (r: { raw: string }) => r.raw.includes(SECRET) || r.raw.includes(DB_PASSWORD_LEAK);
  assert(
    "the file read endpoint refuses dotenv secrets",
    read.status === 403 && !leaked(read) &&
      raw.status === 403 && !leaked(raw) &&
      example.status === 200,
    `read=${read.status} leakRead=${leaked(read)} raw=${raw.status} leakRaw=${leaked(raw)} example=${example.status}`,
  );
}
{
  currentPeer = "127.0.0.1";
  const listing = await get(peerPort, "/__dev/api/files?path=.");
  const names: string[] = Array.isArray(listing.data?.entries)
    ? listing.data.entries.map((e: any) => e.name)
    : [];
  assert(
    "the file listing hides dotenv",
    listing.status === 200 &&
      !names.includes(".env") &&
      names.includes("readme.txt") &&
      !listing.raw.includes(SECRET),
    `status=${listing.status} names=${JSON.stringify(names)}`,
  );
}

// ── DEC-02: loopback-only mutations (raw socket peer governs, not XFF) ────────
console.log("\n-- DEC-02: loopback-only mutations --");
{
  currentPeer = "8.8.8.8";
  const probe = probePath("loopback_probe.txt");
  const remote = await post(
    peerPort, "/__dev/api/file/save",
    { path: "loopback_probe.txt", content: "remote write" },
    { "Sec-Fetch-Site": "same-origin" },
  );
  const xff = await post(
    peerPort, "/__dev/api/file/save",
    { path: "loopback_probe.txt", content: "xff bypass" },
    { "Sec-Fetch-Site": "same-origin", "X-Forwarded-For": "127.0.0.1" },
  );
  assert(
    "a non loopback peer cannot mutate",
    remote.status === 403 && xff.status === 403 && !existsSync(probe),
    `remote=${remote.status} xff=${xff.status} wrote=${existsSync(probe)}`,
  );
}
{
  currentPeer = "127.0.0.1";
  const probe = probePath("loopback_ok_probe.txt");
  const res = await post(
    peerPort, "/__dev/api/file/save",
    { path: "loopback_ok_probe.txt", content: "local write" },
    { "Sec-Fetch-Site": "same-origin" },
  );
  assert(
    "a loopback peer may mutate",
    res.status === 200 && existsSync(probe) && readFileSync(probe, "utf-8") === "local write",
    `status=${res.status} wrote=${existsSync(probe)}`,
  );
}

// ── DEC-04: injected toolbar escapes the reflected request path ──────────────
console.log("\n-- DEC-04: toolbar escaping --");
{
  currentPeer = "127.0.0.1";
  // `//<script>...` trips `new URL`, so the framework falls back to the RAW path
  // (literal <script>) — the real Node vector the toolbar rides on the 404 HTML.
  const body = await rawGet(peerPort, "//<script>alert(1)</script>y", { Accept: "text/html" });
  assert(
    "the injected toolbar escapes the request path",
    body.includes("tina4-dev-toolbar") &&
      !body.includes("<script>alert(1)</script>") &&
      body.includes("&lt;script&gt;alert(1)&lt;/script&gt;"),
    `toolbar=${body.includes("tina4-dev-toolbar")} rawScript=${body.includes("<script>alert(1)</script>")} escaped=${body.includes("&lt;script&gt;alert(1)&lt;/script&gt;")}`,
  );
}

// ── DEC-05: mcp/call tool-execution gate (remote unauth ⇒ 404, tool NOT run) ──
console.log("\n-- DEC-05: mcp/call gate --");
{
  const insert = { name: "database_execute", arguments: { sql: "INSERT INTO gate_probe (v) VALUES ('x')" } };

  currentPeer = "8.8.8.8";
  const before1 = await rowCount();
  const remote = await post(peerPort, "/__dev/api/mcp/call", insert);
  const after1 = await rowCount();

  currentPeer = "8.8.8.8";
  const before2 = await rowCount();
  const xff = await post(peerPort, "/__dev/api/mcp/call", insert, { "X-Forwarded-For": "127.0.0.1" });
  const after2 = await rowCount();

  currentPeer = "127.0.0.1";
  const before3 = await rowCount();
  const loop = await post(peerPort, "/__dev/api/mcp/call", insert);
  const after3 = await rowCount();

  assert(
    "a remote unauthenticated mcp call is refused and the tool does not run",
    remote.status === 404 && after1 - before1 === 0 &&
      xff.status === 404 && after2 - before2 === 0 &&
      loop.status === 200 && after3 - before3 === 1,
    `remote=${remote.status}(+${after1 - before1}) xff=${xff.status}(+${after2 - before2}) loop=${loop.status}(+${after3 - before3})`,
  );
}

// ── cleanup — reap EVERYTHING we spawned ─────────────────────────────────────
peerServer.close();
boot.close();
await new Promise((r) => setTimeout(r, 40));
closeDatabase();
delete (globalThis as any).__tina4_db;
for (const k of ENV_KEYS) setEnv({ [k]: savedEnv[k] });
process.chdir(ORIG_CWD);
try { rmSync(TEST_DIR, { recursive: true }); } catch {}

console.log(`\n${"=".repeat(60)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(60)}\n`);

process.exit(fail > 0 ? 1 : 0);
