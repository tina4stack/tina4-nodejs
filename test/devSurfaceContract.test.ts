/**
 * Dev-surface gate contract (ADR-0078) — REAL server, REAL sockets, NO mocks.
 *
 * Drives tina4-documentation/plan/v3/fixtures/devsurface_contract.json through
 * the real bound server (`startServer`) and a peer-controllable real
 * `http.Server` that calls the exported `handle()` (the pattern of
 * test/devAdminConformance.test.ts). The witness of every case is a real side
 * effect: a secret that is not returned, a file that is not written, a WebSocket
 * upgrade that is refused on a real TCP socket.
 *
 * Run with: npx tsx test/devSurfaceContract.test.ts
 */
import { startServer, handle, resolveTemplate } from "../packages/core/src/index.ts";
import { initDatabase, closeDatabase } from "../packages/orm/src/index.ts";
import http from "node:http";
import net from "node:net";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { freePort } from "./freePort.ts";

const BASE_DIR = "/tmp/tina4-dev-surface-contract";
const TEST_DIR = join(BASE_DIR, "app");
const SIBLING_DIR = join(BASE_DIR, "app-sibling");
const SECRET = "dev-surface-secret-0078";

let pass = 0;
let fail = 0;
function assert(label: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${label}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`); fail++; }
}

const ENV_KEYS = [
  "TINA4_DEBUG", "TINA4_MCP", "TINA4_MCP_REMOTE", "TINA4_MCP_TOKEN", "TINA4_API_KEY",
  "TINA4_RATE_LIMIT", "TINA4_NO_AI_PORT", "TINA4_CSRF", "TINA4_HOST", "TINA4_SECRET",
  "TINA4_DATABASE_URL",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
function setEnv(patch: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function request(method: string, port: number, path: string, body: unknown, headers: Record<string, string> = {}):
  Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port, path, method, agent: false,
      headers: {
        ...(payload !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        Connection: "close", ...headers,
      },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode!, raw }));
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
const get = (port: number, path: string, headers: Record<string, string> = {}) => request("GET", port, path, undefined, headers);
const post = (port: number, path: string, body: unknown, headers: Record<string, string> = {}) => request("POST", port, path, body, headers);

/** A raw socket request, so a path like `/../x` reaches the server verbatim. */
function rawRequest(port: number, head: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(head));
    let raw = "";
    socket.setTimeout(3000, () => socket.destroy());
    socket.on("data", (c) => {
      raw += c.toString();
      if (raw.startsWith("HTTP/1.1 101")) socket.destroy();
    });
    socket.on("close", () => resolve(raw));
    socket.on("error", reject);
  });
}
const wsUpgrade = (port: number, host: string) => rawRequest(port,
  `GET /__dev_reload HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
  `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);

// ── throwaway project + a sibling that shares its name as a prefix ───────────
try { rmSync(BASE_DIR, { recursive: true }); } catch {}
mkdirSync(join(TEST_DIR, "src/routes"), { recursive: true });
mkdirSync(join(TEST_DIR, "src/templates/pages"), { recursive: true });
mkdirSync(SIBLING_DIR, { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, ".env"), `TINA4_SECRET=${SECRET}\n`);
writeFileSync(join(TEST_DIR, "readme.txt"), "public-readme\n");
writeFileSync(join(TEST_DIR, "src/templates/pages/hello.twig"), "PAGE-OK");
writeFileSync(join(TEST_DIR, "src/templates/partial_secret.twig"), "PARTIAL-LEAK");
writeFileSync(join(TEST_DIR, "outside.twig"), "ROOT-LEAK");
writeFileSync(join(SIBLING_DIR, "secret.txt"), "SIBLING-LEAK");
symlinkSync(join(TEST_DIR, ".env"), join(TEST_DIR, "innocent.txt"));

const ORIG_CWD = process.cwd();
process.chdir(TEST_DIR);
setEnv({
  TINA4_RATE_LIMIT: "100000", TINA4_NO_AI_PORT: "true", TINA4_CSRF: undefined,
  TINA4_MCP: undefined, TINA4_MCP_REMOTE: undefined, TINA4_MCP_TOKEN: undefined,
  TINA4_API_KEY: undefined, TINA4_HOST: undefined, TINA4_SECRET: "app-secret",
  TINA4_DATABASE_URL: undefined,
});

console.log("=== Dev-surface gate contract (ADR-0078) — real server, no mocks ===\n");

// ── health outside debug (its own server boot) ──────────────────────────────
setEnv({ TINA4_DEBUG: "false" });
{
  const prodPort = await freePort();
  const prod = await startServer({
    port: prodPort, routesDir: join(TEST_DIR, "src/routes"),
    modelsDir: join(TEST_DIR, "src/models"), staticDir: join(TEST_DIR, "public"),
  });
  await new Promise((r) => setTimeout(r, 40));
  const keysOf = async (p: string) => {
    const r = await get(prodPort, p);
    try { return r.status + ":" + Object.keys(JSON.parse(r.raw)).sort().join(","); } catch { return r.status + ":" + r.raw; }
  };
  const health = await keysOf("/health");
  const underscored = await keysOf("/__health");
  assert("health omits the version outside debug",
    health === "200:framework,status,uptime" && underscored === "200:framework,status,uptime",
    `health=${health} __health=${underscored}`);
  prod.close();
  await new Promise((r) => setTimeout(r, 30));
}

// ── the debug server + a peer-controllable pipeline ─────────────────────────
setEnv({ TINA4_DEBUG: "true" });
const db: any = await initDatabase({ url: "sqlite:///surface.db" });
await db.execute("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT)");
await db.execute("INSERT INTO people (name) VALUES ('ada')");
await db.commit?.();

const BOOT_PORT = await freePort();
const boot = await startServer({
  port: BOOT_PORT, routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"), staticDir: join(TEST_DIR, "public"),
});
await new Promise((r) => setTimeout(r, 40));

let currentPeer = "127.0.0.1";
const peerServer = http.createServer((rawReq, rawRes) => { void handle(rawReq, rawRes); });
peerServer.on("connection", (socket) => {
  Object.defineProperty(socket, "remoteAddress", { value: currentPeer, configurable: true, enumerable: true });
});
await new Promise<void>((r) => peerServer.listen(0, "127.0.0.1", () => r()));
const port = (peerServer.address() as any).port;

// ── resolve first, then the secret denylist ─────────────────────────────────
{
  const results: string[] = [];
  let leaked = false;
  for (const trick of [".env/.", ".env/x/..", "src/../.env", "./.env"]) {
    for (const endpoint of ["/__dev/api/file", "/__dev/api/file/raw"]) {
      const r = await get(port, `${endpoint}?path=${encodeURIComponent(trick)}`);
      results.push(`${endpoint}?${trick}=${r.status}`);
      if (r.raw.includes(SECRET) || (r.status !== 403 && r.status !== 404)) leaked = true;
    }
  }
  assert("a dotenv path with a trailing dot segment is refused", !leaked, results.join(" "));
}
{
  const r = await get(port, "/__dev/api/file?path=innocent.txt");
  assert("a symlink to dotenv is refused", r.status === 403 && !r.raw.includes(SECRET), `status=${r.status}`);
}
{
  const read = await get(port, "/__dev/api/file?path=../app-sibling/secret.txt");
  const raw = await get(port, "/__dev/api/file/raw?path=../app-sibling/secret.txt");
  const save = await post(port, "/__dev/api/file/save", { path: "../app-sibling/written.txt", content: "x" },
    { "Sec-Fetch-Site": "same-origin" });
  assert("a sibling prefix directory is outside the project",
    read.status === 403 && raw.status === 403 && [400, 403].includes(save.status) &&
      !read.raw.includes("SIBLING-LEAK") && !raw.raw.includes("SIBLING-LEAK") &&
      !existsSync(join(SIBLING_DIR, "written.txt")),
    `read=${read.status} raw=${raw.status} save=${save.status}`);
}
{
  const abs = await get(port, `/__dev/api/metrics/file?path=${encodeURIComponent(join(SIBLING_DIR, "secret.txt"))}`);
  const rel = await get(port, "/__dev/api/metrics/file?path=../app-sibling/secret.txt");
  assert("metrics file refuses a path outside the project", abs.status === 403 && rel.status === 403,
    `abs=${abs.status} rel=${rel.status}`);
}

// ── reads carry the same gate as writes ─────────────────────────────────────
{
  const cross = await get(port, "/__dev/api/file?path=readme.txt", { "Sec-Fetch-Site": "cross-site" });
  const same = await get(port, "/__dev/api/file?path=readme.txt", { "Sec-Fetch-Site": "same-origin" });
  assert("a cross origin read is refused",
    cross.status === 403 && !cross.raw.includes("public-readme") && same.status === 200 && same.raw.includes("public-readme"),
    `cross=${cross.status} same=${same.status}`);
}
{
  const read = await get(port, "/__dev/api/file?path=readme.txt", { "Sec-Fetch-Site": "same-site" });
  const save = await post(port, "/__dev/api/file/save", { path: "same_site_probe.txt", content: "x" },
    { "Sec-Fetch-Site": "same-site" });
  assert("a same site fetch is refused",
    read.status === 403 && save.status === 403 && !existsSync(join(TEST_DIR, "same_site_probe.txt")),
    `read=${read.status} save=${save.status}`);
}
{
  currentPeer = "203.0.113.9";
  const r = await get(port, "/__dev/api/file?path=readme.txt");
  currentPeer = "127.0.0.1";
  assert("a non loopback peer cannot read", r.status === 403 && !r.raw.includes("public-readme"), `status=${r.status}`);
}

// ── Host allow-list (DNS rebinding) ─────────────────────────────────────────
{
  const statuses: number[] = [];
  let leaked = false;
  for (const p of ["/__dev", "/__dev/api/status", "/__dev/api/file?path=readme.txt"]) {
    const r = await get(port, p, { Host: "rebind.evil.example:7148" });
    statuses.push(r.status);
    if (r.raw.includes("public-readme")) leaked = true;
  }
  assert("a foreign host header is refused", statuses.every((s) => s === 403) && !leaked, statuses.join(","));
}
{
  const statuses: string[] = [];
  for (const host of ["localhost:7148", "127.0.0.1:7148", "[::1]:7148", "localhost"]) {
    statuses.push(`${host}=${(await get(port, "/__dev/api/status", { Host: host })).status}`);
  }
  setEnv({ TINA4_HOST: "devbox.internal" });
  statuses.push(`devbox=${(await get(port, "/__dev/api/status", { Host: "devbox.internal:7148" })).status}`);
  setEnv({ TINA4_HOST: undefined });
  assert("a loopback host header is allowed", statuses.every((s) => s.endsWith("=200")), statuses.join(" "));
}
{
  const tools = await get(port, "/__dev/api/mcp/tools", { Host: "rebind.evil.example" });
  const rpc = await post(port, "/__dev/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { Host: "rebind.evil.example" });
  assert("a foreign host cannot reach mcp", tools.status === 403 && rpc.status === 403, `tools=${tools.status} rpc=${rpc.status}`);
}
{
  const foreign = await wsUpgrade(BOOT_PORT, `rebind.evil.example:${BOOT_PORT}`);
  const local = await wsUpgrade(BOOT_PORT, `localhost:${BOOT_PORT}`);
  assert("a foreign host cannot open the reload socket",
    !foreign.startsWith("HTTP/1.1 101") && foreign.startsWith("HTTP/1.1 403") && local.startsWith("HTTP/1.1 101"),
    `foreign=${JSON.stringify(foreign.split("\r\n")[0])} local=${JSON.stringify(local.split("\r\n")[0])}`);
}

// ── only TINA4_MCP_TOKEN unlocks the remote dev surface ─────────────────────
{
  setEnv({ TINA4_API_KEY: "app-api-key" });
  currentPeer = "203.0.113.9";
  const probe = join(TEST_DIR, "api_key_probe.txt");
  const bearer = await post(port, "/__dev/api/file/save", { path: "api_key_probe.txt", content: "x" },
    { Authorization: "Bearer app-api-key" });
  const apiKey = await post(port, "/__dev/api/file/save", { path: "api_key_probe.txt", content: "x" },
    { "X-Api-Key": "app-api-key" });
  const wroteEarly = existsSync(probe);
  setEnv({ TINA4_MCP_REMOTE: "true" });
  const mcp = await get(port, "/__dev/api/mcp/tools", { Authorization: "Bearer app-api-key" });
  setEnv({ TINA4_MCP_TOKEN: "mcp-token-0078" });
  const ok = await post(port, "/__dev/api/file/save", { path: "api_key_probe.txt", content: "ok" },
    { Authorization: "Bearer mcp-token-0078", Host: "devbox.lan:7148" });
  currentPeer = "127.0.0.1";
  setEnv({ TINA4_API_KEY: undefined, TINA4_MCP_REMOTE: undefined, TINA4_MCP_TOKEN: undefined });
  assert("the api key does not unlock dev writes",
    bearer.status === 403 && apiKey.status === 403 && !wroteEarly && mcp.status === 404 &&
      ok.status === 200 && readFileSync(probe, "utf-8") === "ok",
    `bearer=${bearer.status} apiKey=${apiKey.status} wrote=${wroteEarly} mcp=${mcp.status} ok=${ok.status}`);
}

// ── table viewer takes only a real table name ───────────────────────────────
{
  const good = await get(port, "/__dev/api/table?name=people");
  const results: string[] = [];
  let bad = false;
  for (const name of ["(SELECT 'INJECTED' AS leak)", "people WHERE 1=0 UNION SELECT 1,'INJECTED'", "no_such_table"]) {
    const r = await get(port, `/__dev/api/table?name=${encodeURIComponent(name)}`);
    results.push(String(r.status));
    if (r.status !== 404 || r.raw.includes("INJECTED")) bad = true;
  }
  assert("table info rejects an unknown table name",
    good.status === 200 && good.raw.includes("ada") && !bad, `good=${good.status} bad=${results.join(",")}`);
}

// ── template auto-routing stays inside the pages root ───────────────────────
{
  const templatesDir = join(TEST_DIR, "src/templates");
  const direct = ["/../partial_secret", "/../../outside", "/sub/../../partial_secret"]
    .map((p) => resolveTemplate(p, templatesDir));
  const page = await get(BOOT_PORT, "/hello");
  const raw = await rawRequest(BOOT_PORT, "GET /../partial_secret HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  assert("template auto routing cannot leave the templates root",
    direct.every((t) => t === null) && page.raw.includes("PAGE-OK") &&
      !raw.includes("PARTIAL-LEAK") && !raw.includes("ROOT-LEAK"),
    `direct=${JSON.stringify(direct)} page=${page.status}`);
}

// ── health carries the version in debug ─────────────────────────────────────
{
  const r = await get(BOOT_PORT, "/health");
  let version = "";
  try { version = JSON.parse(r.raw).version ?? ""; } catch {}
  assert("health carries the version in debug", r.status === 200 && /^\d+\.\d+\.\d+/.test(version), `version=${version}`);
}

// ── cleanup — reap everything we spawned ────────────────────────────────────
peerServer.close();
boot.close();
await new Promise((r) => setTimeout(r, 40));
closeDatabase();
delete (globalThis as any).__tina4_db;
for (const k of ENV_KEYS) setEnv({ [k]: savedEnv[k] });
process.chdir(ORIG_CWD);
try { rmSync(BASE_DIR, { recursive: true }); } catch {}


console.log(`\n${"=".repeat(60)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(60)}\n`);
process.exit(fail > 0 ? 1 : 0);
