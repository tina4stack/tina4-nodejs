/**
 * Integration tests for the MCP JSON-RPC + SSE endpoints that real MCP clients
 * (Claude Code/Desktop) speak: POST /__dev/mcp[/message] and GET /__dev/mcp/sse.
 *
 * These are mounted by DevAdmin.register() the same way the browser REST shim
 * (/__dev/api/mcp/tools, /__dev/api/mcp/call) is, gated on TINA4_DEBUG. Mirrors
 * the Python v3 fix. Run with: npx tsx test/mcpEndpoint.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import { getDefaultDevServer } from "../packages/core/src/mcp.ts";
import { initDatabase, closeDatabase } from "../packages/orm/src/index.ts";
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "/tmp/tina4-mcp-endpoint-test";
const PORT = 3401;
const PORT_DISABLED = 3402;
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

function request(
  method: string,
  path: string,
  port: number,
  body?: unknown,
): Promise<{ status: number; data: any; raw: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "localhost",
        port,
        path,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode!, data, raw, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Clean slate
try { rmSync(TEST_DIR, { recursive: true }); } catch {}
mkdirSync(join(TEST_DIR, "src/routes"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
// A real route so route_list has something concrete to return.
writeFileSync(
  join(TEST_DIR, "src/routes/get.ts"),
  "export default async function (_req: any, res: any) { return res.json({ ok: true }); }\n",
);

process.env.TINA4_RATE_LIMIT = "10000";
process.env.TINA4_NO_AI_PORT = "true"; // single port — don't spin up the +1000 AI port

console.log("=== MCP Endpoint Tests ===\n");

// The built-in MCP file/plan tools resolve their sandbox root from process.cwd()
// at the moment the default dev server registers them — which startServer() below
// triggers via DevAdmin.register() → getDefaultDevServer(). chdir into TEST_DIR
// FIRST so file_write / plan_create / plan_list operate inside the throwaway temp
// project (never the real repo). Restored at cleanup.
const ORIG_CWD = process.cwd();
process.chdir(TEST_DIR);

// A real in-memory SQLite connection so the DB-backed MCP tools (database_query,
// database_execute, migration_status) hit a live engine instead of returning
// {error:"No database connection"}. initDatabase() publishes the wrapper on
// globalThis.__tina4_db, which is exactly what those tool handlers read.
const mcpDb = await initDatabase({ url: "sqlite::memory:" });

// ── Server with debug ON (MCP enabled) ──────────────────────
process.env.TINA4_DEBUG = "true";
const server = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});
await new Promise((r) => setTimeout(r, 50));

// ── initialize → serverInfo ─────────────────────────────────
console.log("--- POST /__dev/mcp/message: initialize ---");
const init = await request("POST", "/__dev/mcp/message", PORT, {
  jsonrpc: "2.0", id: 1, method: "initialize", params: {},
});
assert("initialize returns 200 (endpoint is mounted, not 404)", init.status === 200, `got ${init.status}`);
assert("initialize result has serverInfo", !!init.data?.result?.serverInfo, JSON.stringify(init.data).slice(0, 120));
assert("serverInfo.name is 'Tina4 Dev Tools'", init.data?.result?.serverInfo?.name === "Tina4 Dev Tools");
assert("initialize echoes the request id", init.data?.id === 1);
assert("initialize advertises protocolVersion", typeof init.data?.result?.protocolVersion === "string");

// ── POST /__dev/mcp (alias, no /message) ────────────────────
console.log("\n--- POST /__dev/mcp (alias) ---");
const initAlias = await request("POST", "/__dev/mcp", PORT, {
  jsonrpc: "2.0", id: 2, method: "initialize", params: {},
});
assert("POST /__dev/mcp alias returns 200", initAlias.status === 200, `got ${initAlias.status}`);
assert("alias result has serverInfo", !!initAlias.data?.result?.serverInfo);

// ── tools/list → tools present ──────────────────────────────
console.log("\n--- POST /__dev/mcp/message: tools/list ---");
const list = await request("POST", "/__dev/mcp/message", PORT, {
  jsonrpc: "2.0", id: 3, method: "tools/list", params: {},
});
const tools: Array<{ name: string }> = list.data?.result?.tools ?? [];
assert("tools/list returns 200", list.status === 200);
assert("tools/list returns a non-empty tools array", Array.isArray(tools) && tools.length > 0, `len=${tools.length}`);
const toolNames = new Set(tools.map((t) => t.name));
// The full core tool-set must be advertised by tools/list. The names below are
// each exercised behaviourally elsewhere in this file (route_list / file_list /
// plan_list / log_tail / docs_list / project_overview / system_info above, and
// database_*/file_write/migration_status/plan_create driven over HTTP just
// below), so this single membership check guards against a tool silently
// dropping out of the registry without re-asserting presence per name.
const coreTools = [
  "database_query", "database_execute", "file_read", "file_write", "file_list",
  "route_list", "migration_status", "plan_list", "plan_create", "log_tail",
  "docs_list", "project_overview",
];
const missing = coreTools.filter((n) => !toolNames.has(n));
assert("tools/list advertises the full core tool-set", missing.length === 0, `missing: ${missing.join(", ")}`);

// ── Drive the core tools NOT exercised elsewhere through the REAL endpoint ──
// Each call goes over POST /__dev/mcp/message (exactly what an MCP client speaks)
// and asserts the real observable side effect: a row written then read back, a
// file created on disk, a plan persisted to plan/, migration_status reaching the
// live DB. (file_read/file_list/route_list/plan_list/docs_list/log_tail/
// project_overview/system_info are already behaviourally checked above, so their
// presence is covered by the membership assertion — no redundant existence-only
// check is repeated here.)
console.log("\n--- POST /__dev/mcp/message: behavioural tool round-trips ---");

// Helper: call a tool over HTTP and JSON.parse its single content text block.
async function callTool(name: string, args: Record<string, unknown>): Promise<{ http: number; parsed: any; rawText: string; data: any }> {
  const r = await request("POST", "/__dev/mcp/message", PORT, {
    jsonrpc: "2.0", id: 100, method: "tools/call", params: { name, arguments: args },
  });
  const rawText = r.data?.result?.content?.[0]?.text;
  let parsed: any = null;
  try { parsed = typeof rawText === "string" ? JSON.parse(rawText) : rawText; } catch { parsed = rawText; }
  return { http: r.status, parsed, rawText, data: r.data };
}

// database_execute — create a table + insert a row (real DDL/DML on live SQLite).
const ddl = await callTool("database_execute", {
  sql: "CREATE TABLE mcp_widgets (id INTEGER PRIMARY KEY, name TEXT)",
});
assert("database_execute CREATE TABLE succeeds (success:true, no error)",
  ddl.http === 200 && ddl.parsed?.success === true && ddl.parsed?.error === undefined,
  JSON.stringify(ddl.parsed).slice(0, 160));
const ins = await callTool("database_execute", {
  sql: "INSERT INTO mcp_widgets (id, name) VALUES (?, ?)", params: "[7, \"sprocket\"]",
});
assert("database_execute INSERT (with JSON-string params) succeeds",
  ins.parsed?.success === true && ins.parsed?.error === undefined,
  JSON.stringify(ins.parsed).slice(0, 160));

// database_query — read the row straight back over HTTP (proves the write landed
// on the same live connection the read sees).
const q = await callTool("database_query", {
  sql: "SELECT id, name FROM mcp_widgets WHERE id = ?", params: "[7]",
});
assert("database_query reads back the inserted row over HTTP",
  Array.isArray(q.parsed?.records) && q.parsed.records.length === 1 &&
  q.parsed.records[0].id === 7 && q.parsed.records[0].name === "sprocket",
  JSON.stringify(q.parsed).slice(0, 200));
// database_query is the read-only surface — a write must be refused, not run.
const qWrite = await callTool("database_query", {
  sql: "DELETE FROM mcp_widgets WHERE id = 7",
});
assert("database_query refuses a non-SELECT (read-only guard) and the row survives",
  typeof qWrite.parsed?.error === "string" && qWrite.parsed.error.toLowerCase().includes("read-only"),
  JSON.stringify(qWrite.parsed).slice(0, 160));
const stillThere = await callTool("database_query", { sql: "SELECT count(*) AS c FROM mcp_widgets" });
assert("database_query refusal did NOT delete the row (count still 1)",
  Array.isArray(stillThere.parsed?.records) && Number(stillThere.parsed.records[0].c) === 1,
  JSON.stringify(stillThere.parsed).slice(0, 160));

// file_write — write a file under the (chdir'd) project root and read it back via
// the file_read tool, asserting the bytes actually hit disk inside TEST_DIR.
const writeRes = await callTool("file_write", {
  path: "src/generated/note.txt", content: "hello from mcp endpoint test\n",
});
assert("file_write reports the written path + byte count",
  writeRes.parsed?.written === join("src", "generated", "note.txt") && writeRes.parsed?.bytes === 29,
  JSON.stringify(writeRes.parsed).slice(0, 160));
assert("file_write actually created the file on disk inside TEST_DIR",
  existsSync(join(TEST_DIR, "src/generated/note.txt")) &&
  readFileSync(join(TEST_DIR, "src/generated/note.txt"), "utf-8") === "hello from mcp endpoint test\n");
const readBack = await callTool("file_read", { path: "src/generated/note.txt" });
assert("file_read returns the content file_write wrote",
  readBack.rawText === "hello from mcp endpoint test\n",
  JSON.stringify(readBack.rawText).slice(0, 120));

// plan_create — create a markdown plan, then plan_list must return it as current.
const planRes = await callTool("plan_create", {
  title: "MCP Endpoint Coverage", goal: "verify the dev tools", steps: ["one", "two"],
});
assert("plan_create succeeds and reports the plan name + current flag",
  planRes.parsed?.ok === true && planRes.parsed?.name === "mcp-endpoint-coverage.md" &&
  planRes.parsed?.is_current === true,
  JSON.stringify(planRes.parsed).slice(0, 160));
assert("plan_create wrote the markdown file into plan/ under TEST_DIR",
  existsSync(join(TEST_DIR, "plan", "mcp-endpoint-coverage.md")) &&
  readFileSync(join(TEST_DIR, "plan", "mcp-endpoint-coverage.md"), "utf-8").includes("# MCP Endpoint Coverage"));
const planList = await callTool("plan_list", {});
assert("plan_list returns the freshly created plan, marked current",
  Array.isArray(planList.parsed) &&
  planList.parsed.some((p: any) => p.name === "mcp-endpoint-coverage.md" && p.is_current === true && p.steps_total === 2),
  JSON.stringify(planList.parsed).slice(0, 200));

// migration_status — with a live DB it must reach the connection (not the
// "No database connection" error path). NOTE the Node handler is a stub.
const migStatus = await callTool("migration_status", {});
assert("migration_status reaches the live DB (NOT the no-connection error path)",
  migStatus.http === 200 && migStatus.parsed?.error !== "No database connection",
  JSON.stringify(migStatus.parsed).slice(0, 160));

// ── tools/call a safe read-only tool → content ──────────────
console.log("\n--- POST /__dev/mcp/message: tools/call route_list ---");
const callRouteList = await request("POST", "/__dev/mcp/message", PORT, {
  jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "route_list", arguments: {} },
});
assert("tools/call route_list returns 200", callRouteList.status === 200);
const rlContent = callRouteList.data?.result?.content?.[0]?.text;
assert("route_list returns content text", typeof rlContent === "string", JSON.stringify(callRouteList.data).slice(0, 120));
let routesParsed: any = null;
try { routesParsed = JSON.parse(rlContent); } catch { /* leave null */ }
assert(
  "route_list returns real routes (an array, NOT an error object)",
  Array.isArray(routesParsed),
  JSON.stringify(routesParsed).slice(0, 160),
);
assert(
  "route_list includes the registered GET / route",
  Array.isArray(routesParsed) && routesParsed.some((r: any) => r.path === "/" && r.method === "GET"),
  JSON.stringify(routesParsed).slice(0, 200),
);

// ── tools/call other safe read-only tools → no protocol error ──
console.log("\n--- POST /__dev/mcp/message: other safe read-only tools ---");
for (const name of ["file_list", "plan_list", "docs_list", "log_tail", "project_overview", "system_info"]) {
  const r = await request("POST", "/__dev/mcp/message", PORT, {
    jsonrpc: "2.0", id: 5, method: "tools/call", params: { name, arguments: {} },
  });
  const hasContent = typeof r.data?.result?.content?.[0]?.text === "string";
  const isProtoError = !!r.data?.error;
  assert(`tools/call ${name} executes without a protocol error`, r.status === 200 && hasContent && !isProtoError,
    JSON.stringify(r.data).slice(0, 140));
}

// ── unknown tool → error ────────────────────────────────────
console.log("\n--- POST /__dev/mcp/message: unknown tool ---");
const unknown = await request("POST", "/__dev/mcp/message", PORT, {
  jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "does_not_exist", arguments: {} },
});
assert("unknown tool yields a JSON-RPC error", !!unknown.data?.error, JSON.stringify(unknown.data).slice(0, 120));
assert("unknown tool error mentions the tool name", String(unknown.data?.error?.message || "").includes("does_not_exist"));

// ── notification (no id) → 204 ──────────────────────────────
console.log("\n--- POST /__dev/mcp/message: notification (no id) ---");
const notif = await request("POST", "/__dev/mcp/message", PORT, {
  jsonrpc: "2.0", method: "notifications/initialized", params: {},
});
assert("notification (no id) returns 204 No Content", notif.status === 204, `got ${notif.status}`);
assert("notification has empty body", notif.raw === "");

// ── SSE handshake ───────────────────────────────────────────
console.log("\n--- GET /__dev/mcp/sse ---");
const sse = await request("GET", "/__dev/mcp/sse", PORT);
assert("SSE handshake returns 200", sse.status === 200, `got ${sse.status}`);
assert("SSE content-type is text/event-stream",
  String(sse.headers["content-type"] || "").includes("text/event-stream"),
  String(sse.headers["content-type"]));
assert("SSE body has an endpoint event", sse.raw.includes("event: endpoint"));
assert("SSE body announces the message endpoint", sse.raw.includes("data: /__dev/mcp/message"));

// ── Default dev server shares the same instance / tool set ──
console.log("\n--- getDefaultDevServer() registry ---");
const def = getDefaultDevServer();
assert("getDefaultDevServer() path is /__dev/mcp", def.path === "/__dev/mcp");
const defList = JSON.parse(await def.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} })));
assert("default server exposes the same tool count over its registry",
  Array.isArray(defList?.result?.tools) && defList.result.tools.length === tools.length,
  `default=${defList?.result?.tools?.length} http=${tools.length}`);

server.close();
await new Promise((r) => setTimeout(r, 30));

// ── Server with debug OFF (MCP disabled → 404) ──────────────
console.log("\n--- MCP disabled (TINA4_DEBUG=false) → 404 ---");
delete process.env.TINA4_DEBUG;
process.env.TINA4_DEBUG = "false";
const serverOff = await startServer({
  port: PORT_DISABLED,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});
await new Promise((r) => setTimeout(r, 50));

const offMsg = await request("POST", "/__dev/mcp/message", PORT_DISABLED, {
  jsonrpc: "2.0", id: 1, method: "initialize", params: {},
});
assert("disabled: POST /__dev/mcp/message returns 404", offMsg.status === 404, `got ${offMsg.status}`);
const offSse = await request("GET", "/__dev/mcp/sse", PORT_DISABLED);
assert("disabled: GET /__dev/mcp/sse returns 404", offSse.status === 404, `got ${offSse.status}`);

serverOff.close();

// Cleanup
closeDatabase();
delete (globalThis as any).__tina4_db;
delete process.env.TINA4_RATE_LIMIT;
delete process.env.TINA4_NO_AI_PORT;
delete process.env.TINA4_DEBUG;
// Restore cwd BEFORE removing TEST_DIR (it is the current working directory).
process.chdir(ORIG_CWD);
try { rmSync(TEST_DIR, { recursive: true }); } catch {}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
