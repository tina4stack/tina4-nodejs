/**
 * SECURITY lock-in (MCP-02): the MCP tool-INVOCATION REST shim
 * `POST /__dev/api/mcp/call` must enforce its per-request authorisation gate
 * over the wire.
 *
 * WHY THIS FILE EXISTS. In tina4-python this exact shim was UNGATED: a remote
 * unauthenticated caller against a `TINA4_DEBUG=true`, 0.0.0.0-bound server could
 * invoke `database_execute` / `file_write` (arbitrary tool exec). Node ALREADY
 * gates it correctly — `handleMcpCall` opens with `if (!mcpRequestAllowed(req))
 * { res.json({error:"MCP forbidden"}, 404); return; }` and `mcpRequestAllowed`
 * reads the RAW socket peer (`req.socket.remoteAddress`), never X-Forwarded-For.
 * But the existing `test/mcpEndpoint.test.ts` only toggles the CAPABILITY gate
 * from LOOPBACK; it never drives `/call` from a NON-loopback peer, never with a
 * token, and `mcpTokenOk` had NO test at all. This file LOCKS the /call
 * authorization gate so it can never regress the way Python's did.
 *
 * HOW THE NON-LOOPBACK PEER IS DRIVEN (the crux). The gate reads the real TCP
 * peer, and a test host cannot make 8.8.8.8 actually dial it, so the peer is
 * presented over a REAL socket two ways, both exercising the FULL real dispatch
 * pipeline (the exported `handle()` → the `dispatch` closure `startServer`
 * installed → the real `handleMcpCall` → the real gate → the real
 * `database_execute` tool → a real file-backed SQLite):
 *
 *   1. peerServer — a real http.Server whose request listener calls `handle()`.
 *      At its `'connection'` event we `Object.defineProperty` the ACCEPTED
 *      socket's `remoteAddress` to the exact value a genuine remote client would
 *      present (e.g. "8.8.8.8"). This is a real socket + full real pipeline;
 *      only the peer's reported address is set. Deterministic on every host.
 *
 *   2. ifaceServer — a real http.Server bound to 0.0.0.0 with NO override. When
 *      the host has a real non-loopback IPv4 we connect to THAT address, so the
 *      KERNEL itself reports a non-loopback peer (zero override). This is the
 *      strongest witness; it runs wherever an interface exists (dev Mac, lab CI)
 *      and is a supplement — the override path above already proves the property
 *      deterministically, so the property is never left unproven.
 *
 * No mocks: nothing is stubbed — real startServer, real `handle()`, real
 * http.request over real sockets, real bound SQLite, real dev tool. The witness
 * is the DATABASE ROW (`mcp_probe`): a denied /call must NOT have inserted it.
 *
 * Run with: npx tsx test/mcpCallGate.test.ts
 */
import { startServer, handle } from "../packages/core/src/index.ts";
import { initDatabase, closeDatabase } from "../packages/orm/src/index.ts";
import http from "node:http";
import os from "node:os";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { freePort } from "./freePort.ts";

const TEST_DIR = "/tmp/tina4-mcp-call-gate-test";
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

// ── env plumbing ────────────────────────────────────────────
// mcpEnabled() / isRequestAllowed() / mcpTokenOk() all read process.env LAZILY
// per request, so flipping these between calls (no restart) is faithful.
const ENV_KEYS = [
  "TINA4_DEBUG", "TINA4_MCP", "TINA4_MCP_REMOTE", "TINA4_MCP_TOKEN",
  "TINA4_API_KEY", "TINA4_RATE_LIMIT", "TINA4_NO_AI_PORT",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

function setEnv(patch: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const TOKEN = "s3cr3t-mcp-token-value-42";
const API_KEY = "api-key-fallback-value-99";

// Body every /call carries: the dangerous write surface the Python hole exposed.
function insertBody(note: string) {
  return {
    name: "database_execute",
    arguments: { sql: `INSERT INTO mcp_probe (note) VALUES ('${note}')` },
  };
}

// ── real HTTP POST over a real socket ───────────────────────
function post(
  host: string,
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host,
        port,
        path,
        method: "POST",
        agent: false, // fresh socket per request → fresh 'connection' → current peer
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
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
    req.write(payload);
    req.end();
  });
}

// ── clean slate + throwaway project ─────────────────────────
try { rmSync(TEST_DIR, { recursive: true }); } catch {}
mkdirSync(join(TEST_DIR, "src/routes"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(
  join(TEST_DIR, "src/routes/get.ts"),
  "export default async function (_req: any, res: any) { return res.json({ ok: true }); }\n",
);

setEnv({ TINA4_RATE_LIMIT: "10000", TINA4_NO_AI_PORT: "true", TINA4_DEBUG: "true" });

console.log("=== MCP /call REST shim gate — remote unauth tool-exec lock (MCP-02) ===\n");

// The dev tools resolve their sandbox root + DB from process.cwd()/globalThis at
// registration time (startServer → DevAdmin.register → getDefaultDevServer), so
// chdir into TEST_DIR FIRST. Restored at cleanup.
const ORIG_CWD = process.cwd();
process.chdir(TEST_DIR);

// A REAL file-backed SQLite (shared across connections, so the tool's write and
// our row-witness read see the same data regardless of pooling). initDatabase()
// publishes the wrapper on globalThis.__tina4_db — exactly what the
// database_execute tool reads. `sqlite:///probe.db` is relative to the chdir'd
// TEST_DIR.
const mcpDb: any = await initDatabase({ url: "sqlite:///probe.db" });
await mcpDb.execute("CREATE TABLE mcp_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT)");
await mcpDb.commit?.();

async function probeCount(): Promise<number> {
  const row: any = await mcpDb.fetchOne("SELECT COUNT(*) AS c FROM mcp_probe");
  return Number(row?.c ?? -1);
}

// ── boot the REAL server (mounts /call under the gate, installs _dispatchFn) ──
const BOOT_PORT = await freePort();
const boot = await startServer({
  port: BOOT_PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});
await new Promise((r) => setTimeout(r, 50));

assert(
  "route_mounted_by_real_boot: POST /__dev/api/mcp/call resolves in the real route table",
  boot.router.match("POST", "/__dev/api/mcp/call") !== null,
);

// ── peerServer: real socket + full real pipeline, peer set per scenario ──────
let currentPeer = "8.8.8.8";
const peerServer = http.createServer((rawReq, rawRes) => { void handle(rawReq, rawRes); });
peerServer.on("connection", (socket) => {
  // Own instance property shadows net.Socket.prototype's non-configurable
  // remoteAddress getter — the gate then reads exactly this value, identical to
  // a kernel-reported peer. (Verified on Node v24.)
  Object.defineProperty(socket, "remoteAddress", {
    value: currentPeer, configurable: true, enumerable: true,
  });
});
await new Promise<void>((r) => peerServer.listen(0, "127.0.0.1", () => r()));
const peerPort = (peerServer.address() as any).port;

// call /call through peerServer with a chosen non-loopback (or loopback) peer.
async function callAs(peer: string, note: string, headers: Record<string, string> = {}) {
  currentPeer = peer;
  const before = await probeCount();
  const res = await post("127.0.0.1", peerPort, "/__dev/api/mcp/call", insertBody(note), headers);
  const after = await probeCount();
  return { status: res.status, data: res.data, before, after, inserted: after - before };
}

// ── 1) REQUIRED: remote peer + NO token → 404 AND row NOT inserted ───────────
console.log("--- remote peer, no token (the Python hole) ---");
setEnv({ TINA4_MCP_REMOTE: undefined, TINA4_MCP_TOKEN: undefined, TINA4_API_KEY: undefined });
{
  const r = await callAs("8.8.8.8", "r1-must-not-run");
  assert(
    "remote_8888_no_token__404_forbidden",
    r.status === 404 && r.data?.error === "MCP forbidden",
    `status=${r.status} body=${JSON.stringify(r.data).slice(0, 120)}`,
  );
  assert("remote_8888_no_token__row_NOT_inserted", r.inserted === 0, `delta=${r.inserted}`);
}

// ── 2) REQUIRED: remote + TINA4_MCP_REMOTE + token via Bearer → 200 AND row ──
console.log("\n--- remote peer, opt-in + valid Bearer token ---");
setEnv({ TINA4_MCP_REMOTE: "true", TINA4_MCP_TOKEN: TOKEN, TINA4_API_KEY: undefined });
{
  const r = await callAs("8.8.8.8", "r2-authed", { Authorization: `Bearer ${TOKEN}` });
  assert(
    "remote_8888_optin_plus_bearer__200_ok",
    r.status === 200 && r.data?.ok === true,
    `status=${r.status} body=${JSON.stringify(r.data).slice(0, 140)}`,
  );
  assert("remote_8888_optin_plus_bearer__row_inserted", r.inserted === 1, `delta=${r.inserted}`);
}

// ── 3) REQUIRED: remote peer + spoofed X-Forwarded-For:127.0.0.1, no token ───
//     → 404 AND row NOT inserted (proves the RAW peer governs, not XFF).
console.log("\n--- remote peer, spoofed X-Forwarded-For: 127.0.0.1, no token ---");
setEnv({ TINA4_MCP_REMOTE: "true", TINA4_MCP_TOKEN: TOKEN, TINA4_API_KEY: undefined });
{
  const r = await callAs("8.8.8.8", "r3-xff-spoof", { "X-Forwarded-For": "127.0.0.1" });
  assert(
    "remote_8888_spoofed_xff_loopback_no_token__404_forbidden",
    r.status === 404 && r.data?.error === "MCP forbidden",
    `status=${r.status} body=${JSON.stringify(r.data).slice(0, 120)}`,
  );
  assert("remote_8888_spoofed_xff_loopback_no_token__row_NOT_inserted", r.inserted === 0, `delta=${r.inserted}`);
}

// ── 4) control: loopback peer, no token → 200 AND row (allow path is real) ───
console.log("\n--- loopback control (allow path) ---");
setEnv({ TINA4_MCP_REMOTE: undefined, TINA4_MCP_TOKEN: undefined, TINA4_API_KEY: undefined });
{
  const r = await callAs("127.0.0.1", "c1-loopback");
  assert(
    "loopback_127_no_token__200_ok",
    r.status === 200 && r.data?.ok === true,
    `status=${r.status} body=${JSON.stringify(r.data).slice(0, 140)}`,
  );
  assert("loopback_127_no_token__row_inserted", r.inserted === 1, `delta=${r.inserted}`);
}

// ── 5) negative: remote + valid token but NO remote opt-in → 404 (needs BOTH) ─
console.log("\n--- remote peer, valid token but TINA4_MCP_REMOTE unset ---");
setEnv({ TINA4_MCP_REMOTE: undefined, TINA4_MCP_TOKEN: TOKEN, TINA4_API_KEY: undefined });
{
  const r = await callAs("8.8.8.8", "r5-token-without-optin", { Authorization: `Bearer ${TOKEN}` });
  assert(
    "remote_8888_valid_token_without_optin__404_forbidden",
    r.status === 404 && r.data?.error === "MCP forbidden",
    `status=${r.status} body=${JSON.stringify(r.data).slice(0, 120)}`,
  );
  assert("remote_8888_valid_token_without_optin__row_NOT_inserted", r.inserted === 0, `delta=${r.inserted}`);
}

// ── mcpTokenOk coverage (previously UNTESTED): three transports + fallback ───
// All under remote peer + TINA4_MCP_REMOTE=true, so the token is the ONLY thing
// that can flip the gate — an accepted token → 200 + row, a rejected one → 404 +
// no row. Witnessed by the real DB row every time.
console.log("\n--- mcpTokenOk: accepted transports (Bearer / X-MCP-Token / X-Api-Key) ---");
setEnv({ TINA4_MCP_REMOTE: "true", TINA4_MCP_TOKEN: TOKEN, TINA4_API_KEY: undefined });
{
  const b = await callAs("8.8.8.8", "t-bearer", { Authorization: `Bearer ${TOKEN}` });
  assert("mcpTokenOk_authorization_bearer_accepted__200_and_row",
    b.status === 200 && b.data?.ok === true && b.inserted === 1,
    `status=${b.status} delta=${b.inserted}`);

  const x = await callAs("8.8.8.8", "t-xmcp", { "X-MCP-Token": TOKEN });
  assert("mcpTokenOk_x_mcp_token_accepted__200_and_row",
    x.status === 200 && x.data?.ok === true && x.inserted === 1,
    `status=${x.status} delta=${x.inserted}`);

  const a = await callAs("8.8.8.8", "t-xapi", { "X-Api-Key": TOKEN });
  assert("mcpTokenOk_x_api_key_accepted__200_and_row",
    a.status === 200 && a.data?.ok === true && a.inserted === 1,
    `status=${a.status} delta=${a.inserted}`);

  // The Bearer prefix check is case-insensitive (auth.toLowerCase()).
  const lc = await callAs("8.8.8.8", "t-lcbearer", { Authorization: `bearer ${TOKEN}` });
  assert("mcpTokenOk_lowercase_bearer_prefix_accepted__200_and_row",
    lc.status === 200 && lc.data?.ok === true && lc.inserted === 1,
    `status=${lc.status} delta=${lc.inserted}`);
}

console.log("\n--- mcpTokenOk: rejected (wrong / absent) ---");
setEnv({ TINA4_MCP_REMOTE: "true", TINA4_MCP_TOKEN: TOKEN, TINA4_API_KEY: undefined });
{
  const wrong = await callAs("8.8.8.8", "t-wrong", { Authorization: "Bearer not-the-token" });
  assert("mcpTokenOk_wrong_token_rejected__404_and_no_row",
    wrong.status === 404 && wrong.data?.error === "MCP forbidden" && wrong.inserted === 0,
    `status=${wrong.status} delta=${wrong.inserted}`);

  const absent = await callAs("8.8.8.8", "t-absent");
  assert("mcpTokenOk_absent_token_rejected__404_and_no_row",
    absent.status === 404 && absent.data?.error === "MCP forbidden" && absent.inserted === 0,
    `status=${absent.status} delta=${absent.inserted}`);

  // Wrong transport carrying the RIGHT value is still rejected if it's not one
  // of the three accepted headers (e.g. a bare query-style header).
  const wrongHeader = await callAs("8.8.8.8", "t-wrongheader", { "X-Wrong-Header": TOKEN });
  assert("mcpTokenOk_token_in_unrecognised_header_rejected__404_and_no_row",
    wrongHeader.status === 404 && wrongHeader.inserted === 0,
    `status=${wrongHeader.status} delta=${wrongHeader.inserted}`);
}

console.log("\n--- mcpTokenOk: TINA4_API_KEY fallback (no TINA4_MCP_TOKEN) ---");
setEnv({ TINA4_MCP_REMOTE: "true", TINA4_MCP_TOKEN: undefined, TINA4_API_KEY: API_KEY });
{
  const ok = await callAs("8.8.8.8", "t-apikey-ok", { "X-Api-Key": API_KEY });
  assert("mcpTokenOk_api_key_env_fallback_accepted__200_and_row",
    ok.status === 200 && ok.data?.ok === true && ok.inserted === 1,
    `status=${ok.status} delta=${ok.inserted}`);

  const bad = await callAs("8.8.8.8", "t-apikey-bad", { "X-Api-Key": "wrong-api-key" });
  assert("mcpTokenOk_api_key_env_fallback_wrong_rejected__404_and_no_row",
    bad.status === 404 && bad.inserted === 0,
    `status=${bad.status} delta=${bad.inserted}`);
}

// ── ZERO-OVERRIDE WITNESS: a genuine kernel-reported non-loopback peer ───────
// Connect to the host's real non-loopback IPv4 (server bound to 0.0.0.0, NO
// socket override). The kernel puts a non-loopback address in remoteAddress, so
// this proves the deny path with nothing set by the test at all. Supplements the
// override path above (which already proves the property deterministically).
console.log("\n--- genuine non-loopback interface (zero override) ---");
let nonLoopIp: string | null = null;
for (const addrs of Object.values(os.networkInterfaces())) {
  for (const a of addrs || []) {
    if (a && a.family === "IPv4" && !a.internal) { nonLoopIp = a.address; break; }
  }
  if (nonLoopIp) break;
}
let ifaceServer: http.Server | null = null;
if (nonLoopIp) {
  ifaceServer = http.createServer((rawReq, rawRes) => { void handle(rawReq, rawRes); });
  await new Promise<void>((r) => ifaceServer!.listen(0, "0.0.0.0", () => r()));
  const ifacePort = (ifaceServer.address() as any).port;
  console.log(`  (real non-loopback IPv4: ${nonLoopIp})`);

  // deny: no opt-in / no token
  setEnv({ TINA4_MCP_REMOTE: undefined, TINA4_MCP_TOKEN: undefined, TINA4_API_KEY: undefined });
  {
    const before = await probeCount();
    const res = await post(nonLoopIp, ifacePort, "/__dev/api/mcp/call", insertBody("iface-deny"));
    const after = await probeCount();
    assert("real_interface_nonloopback_no_token__404_forbidden",
      res.status === 404 && res.data?.error === "MCP forbidden",
      `status=${res.status} body=${JSON.stringify(res.data).slice(0, 120)}`);
    assert("real_interface_nonloopback_no_token__row_NOT_inserted", after - before === 0, `delta=${after - before}`);
  }
  // allow: opt-in + token
  setEnv({ TINA4_MCP_REMOTE: "true", TINA4_MCP_TOKEN: TOKEN, TINA4_API_KEY: undefined });
  {
    const before = await probeCount();
    const res = await post(nonLoopIp, ifacePort, "/__dev/api/mcp/call", insertBody("iface-allow"),
      { Authorization: `Bearer ${TOKEN}` });
    const after = await probeCount();
    assert("real_interface_nonloopback_optin_plus_bearer__200_ok",
      res.status === 200 && res.data?.ok === true,
      `status=${res.status} body=${JSON.stringify(res.data).slice(0, 140)}`);
    assert("real_interface_nonloopback_optin_plus_bearer__row_inserted", after - before === 1, `delta=${after - before}`);
  }
} else {
  console.log("  NOTE: no non-loopback IPv4 on this host — zero-override interface witness not run "
    + "(the override-based 8.8.8.8 tests above cover the property deterministically). [needs:non-loopback-iface]");
}

// ── cleanup — reap everything we spawned ────────────────────
peerServer.close();
ifaceServer?.close();
boot.close();
await new Promise((r) => setTimeout(r, 30));
closeDatabase();
delete (globalThis as any).__tina4_db;
for (const k of ENV_KEYS) setEnv({ [k]: savedEnv[k] });
process.chdir(ORIG_CWD);
try { rmSync(TEST_DIR, { recursive: true }); } catch {}

console.log(`\n${"=".repeat(56)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(56)}\n`);

process.exit(fail > 0 ? 1 : 0);
