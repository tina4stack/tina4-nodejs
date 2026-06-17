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
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
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
// Core tool-set coverage (the names the task calls out explicitly).
const coreTools = [
  "database_query", "database_execute", "file_read", "file_write", "file_list",
  "route_list", "migration_status", "plan_list", "plan_create", "log_tail",
  "docs_list", "project_overview",
];
for (const name of coreTools) {
  assert(`tool registered: ${name}`, toolNames.has(name));
}

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
const defList = JSON.parse(def.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} })));
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
delete process.env.TINA4_RATE_LIMIT;
delete process.env.TINA4_NO_AI_PORT;
delete process.env.TINA4_DEBUG;
try { rmSync(TEST_DIR, { recursive: true }); } catch {}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
