/**
 * Unit tests for the MCP module (Model Context Protocol).
 * Mirrors Python's test_mcp.py test structure.
 * Run with: npx tsx test/mcp.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  encodeResponse,
  encodeError,
  encodeNotification,
  decodeRequest,
  McpServer,
  mcpTool,
  mcpResource,
  schemaFromParams,
  isLocalhost,
  registerDevTools,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
} from "../packages/core/src/mcp.js";
import { initDatabase, closeDatabase } from "../packages/orm/src/index.js";

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

function assertThrows(name: string, fn: () => void, matchStr?: string) {
  try {
    fn();
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} (expected throw)`);
    fail++;
  } catch (e) {
    const msg = (e as Error).message;
    if (matchStr && !msg.toLowerCase().includes(matchStr.toLowerCase())) {
      console.log(`  \x1b[31mFAIL\x1b[0m ${name} (expected "${matchStr}" in "${msg}")`);
      fail++;
    } else {
      console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
      pass++;
    }
  }
}

// ══════════════════════════════════════════════════════════════
// TestJsonRpcProtocol — JSON-RPC 2.0 codec tests
// ══════════════════════════════════════════════════════════════
console.log("=== JSON-RPC Protocol Tests ===\n");

// test_encode_response
{
  const raw = encodeResponse(1, { tools: [] });
  const msg = JSON.parse(raw);
  assert("encode_response jsonrpc", msg.jsonrpc === "2.0");
  assert("encode_response id", msg.id === 1);
  assert("encode_response result", JSON.stringify(msg.result) === JSON.stringify({ tools: [] }));
}

// test_encode_error
{
  const raw = encodeError(2, METHOD_NOT_FOUND, "Not found");
  const msg = JSON.parse(raw);
  assert("encode_error jsonrpc", msg.jsonrpc === "2.0");
  assert("encode_error id", msg.id === 2);
  assert("encode_error code", msg.error.code === -32601);
  assert("encode_error message", msg.error.message === "Not found");
}

// test_encode_error with data
{
  const raw = encodeError(3, INTERNAL_ERROR, "Server error", { detail: "foo" });
  const msg = JSON.parse(raw);
  assert("encode_error with data", msg.error.data?.detail === "foo");
}

// test_encode_notification
{
  const raw = encodeNotification("test/notify", { foo: "bar" });
  const msg = JSON.parse(raw);
  assert("encode_notification jsonrpc", msg.jsonrpc === "2.0");
  assert("encode_notification method", msg.method === "test/notify");
  assert("encode_notification no id", msg.id === undefined);
  assert("encode_notification params", msg.params?.foo === "bar");
}

// test_decode_request
{
  const { method, params, requestId } = decodeRequest(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {},
    }),
  );
  assert("decode_request method", method === "tools/list");
  assert("decode_request params", JSON.stringify(params) === "{}");
  assert("decode_request id", requestId === 3);
}

// test_decode_notification
{
  const { method, params, requestId } = decodeRequest({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert("decode_notification method", method === "notifications/initialized");
  assert("decode_notification id is null", requestId === null);
}

// test_invalid_request (bad JSON)
assertThrows("decode invalid json throws", () => {
  decodeRequest("not json");
}, "Invalid JSON");

// test_missing_method
assertThrows("decode missing method throws", () => {
  decodeRequest({ jsonrpc: "2.0", id: 1 });
}, "method");

// test_missing_jsonrpc
assertThrows("decode missing jsonrpc throws", () => {
  decodeRequest({ method: "test", id: 1 });
}, "jsonrpc");

// ══════════════════════════════════════════════════════════════
// TestMcpServer — core functionality
// ══════════════════════════════════════════════════════════════
console.log("\n=== McpServer Tests ===\n");

// test_initialize_handshake
{
  const server = new McpServer("/test-mcp", "Test Server", "0.1.0");
  const resp = JSON.parse(
    await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    }),
  );
  assert("initialize protocolVersion", resp.result.protocolVersion === "2024-11-05");
  assert("initialize serverInfo name", resp.result.serverInfo.name === "Test Server");
  assert("initialize capabilities.tools", "tools" in resp.result.capabilities);
}

// test_ping
{
  const server = new McpServer("/test-ping", "Ping Test");
  const resp = JSON.parse(
    await server.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "ping",
      params: {},
    }),
  );
  assert("ping result is empty object", JSON.stringify(resp.result) === "{}");
}

// test_method_not_found
{
  const server = new McpServer("/test-404", "404 Test");
  const resp = JSON.parse(
    await server.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "nonexistent",
      params: {},
    }),
  );
  assert("method_not_found code", resp.error.code === -32601);
}

// test_notification_no_response
{
  const server = new McpServer("/test-notif", "Notif Test");
  const resp = await server.handleMessage({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert("notification returns empty string", resp === "");
}

// test_parse_error
{
  const server = new McpServer("/test-parse", "Parse Test");
  const resp = JSON.parse(await server.handleMessage("invalid json {{{"));
  assert("parse error code", resp.error.code === PARSE_ERROR);
}

// ══════════════════════════════════════════════════════════════
// TestToolRegistration — tool registration and invocation
// ══════════════════════════════════════════════════════════════
console.log("\n=== Tool Registration Tests ===\n");

// test_register_tool
{
  const server = new McpServer("/test-tools", "Tool Test");
  server.registerTool(
    "greet",
    (args) => `Hello, ${args.name}!`,
    "Greet someone",
    schemaFromParams([{ name: "name", type: "string" }]),
  );

  const resp = JSON.parse(
    await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  );
  const tools = resp.result.tools;
  assert("register_tool count", tools.length === 1);
  assert("register_tool name", tools[0].name === "greet");
  assert("register_tool schema type", tools[0].inputSchema.properties.name.type === "string");
  assert("register_tool required", tools[0].inputSchema.required?.includes("name"));
}

// test_call_tool
{
  const server = new McpServer("/test-call", "Call Test");
  server.registerTool(
    "add",
    (args) => (args.a as number) + (args.b as number),
    "Add two numbers",
    schemaFromParams([
      { name: "a", type: "integer" },
      { name: "b", type: "integer" },
    ]),
  );

  const resp = JSON.parse(
    await server.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "add", arguments: { a: 3, b: 5 } },
    }),
  );
  const content = resp.result.content;
  assert("call_tool content length", content.length === 1);
  assert("call_tool content type", content[0].type === "text");
  assert("call_tool result contains 8", content[0].text.includes("8"));
}

// test_unknown_tool
{
  const server = new McpServer("/test-unknown", "Unknown Test");
  const resp = JSON.parse(
    await server.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "missing", arguments: {} },
    }),
  );
  assert("unknown_tool error code", resp.error.code === INTERNAL_ERROR);
}

// test_schema_from_params
{
  const schema = schemaFromParams([
    { name: "name", type: "string" },
    { name: "count", type: "integer", default: 5 },
    { name: "active", type: "boolean", default: true },
  ]);
  assert("schema name type", schema.properties.name.type === "string");
  assert("schema count type", schema.properties.count.type === "integer");
  assert("schema count default", schema.properties.count.default === 5);
  assert("schema active type", schema.properties.active.type === "boolean");
  assert("schema required only name", JSON.stringify(schema.required) === JSON.stringify(["name"]));
}

// test_string_result
{
  const server = new McpServer("/test-str", "String Test");
  server.registerTool("echo", (args) => `echo: ${args.msg}`, "Echo",
    schemaFromParams([{ name: "msg", type: "string" }]));

  const resp = JSON.parse(
    await server.handleMessage({
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "echo", arguments: { msg: "hello" } },
    }),
  );
  assert("string result", resp.result.content[0].text === "echo: hello");
}

// test_object_result
{
  const server = new McpServer("/test-obj", "Object Test");
  server.registerTool("info", () => ({ version: "1.0", items: [1, 2, 3] }), "Info",
    schemaFromParams([]));

  const resp = JSON.parse(
    await server.handleMessage({
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "info", arguments: {} },
    }),
  );
  const data = JSON.parse(resp.result.content[0].text);
  assert("object result version", data.version === "1.0");
  assert("object result items", data.items.length === 3);
}

// ══════════════════════════════════════════════════════════════
// TestResourceRegistration — resource registration and reading
// ══════════════════════════════════════════════════════════════
console.log("\n=== Resource Registration Tests ===\n");

// test_register_resource
{
  const server = new McpServer("/test-resources", "Resource Test");
  server.registerResource("app://tables", () => ["users", "products"], "Database tables");

  const resp = JSON.parse(
    await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/list",
      params: {},
    }),
  );
  const resources = resp.result.resources;
  assert("register_resource count", resources.length === 1);
  assert("register_resource uri", resources[0].uri === "app://tables");
}

// test_read_resource
{
  const server = new McpServer("/test-read-res", "Read Resource Test");
  server.registerResource("app://info", () => ({ version: "1.0", name: "Test App" }), "App info");

  const resp = JSON.parse(
    await server.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri: "app://info" },
    }),
  );
  const contents = resp.result.contents;
  assert("read_resource count", contents.length === 1);
  const data = JSON.parse(contents[0].text);
  assert("read_resource version", data.version === "1.0");
}

// test_unknown_resource
{
  const server = new McpServer("/test-unknown-res", "Unknown Resource Test");
  const resp = JSON.parse(
    await server.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: "app://missing" },
    }),
  );
  assert("unknown_resource error code", resp.error.code === INTERNAL_ERROR);
}

// test_string_resource
{
  const server = new McpServer("/test-str-res", "String Resource Test");
  server.registerResource("app://readme", () => "Hello World", "Readme", "text/plain");

  const resp = JSON.parse(
    await server.handleMessage({
      jsonrpc: "2.0", id: 4, method: "resources/read",
      params: { uri: "app://readme" },
    }),
  );
  assert("string resource text", resp.result.contents[0].text === "Hello World");
  assert("string resource mime", resp.result.contents[0].mimeType === "text/plain");
}

// ══════════════════════════════════════════════════════════════
// TestDecoratorApi — mcpTool and mcpResource
// ══════════════════════════════════════════════════════════════
console.log("\n=== Decorator API Tests ===\n");

// test_mcp_tool_decorator
{
  const server = new McpServer("/test-decorator", "Decorator Test");

  const hello = mcpTool("hello", "Say hello", server, [
    { name: "name", type: "string" },
  ])((args: Record<string, unknown>) => `Hello, ${args.name}!`);

  assert("mcpTool sets _mcpToolName", hello._mcpToolName === "hello");

  const resp = JSON.parse(
    await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "hello", arguments: { name: "World" } },
    }),
  );
  assert("mcpTool invocation", resp.result.content[0].text.includes("Hello, World!"));
}

// test_mcp_resource_decorator
{
  const server = new McpServer("/test-decorator2", "Decorator Test 2");

  const getData = mcpResource("test://data", "Test data", "application/json", server)(
    () => [1, 2, 3],
  );

  assert("mcpResource sets _mcpResourceUri", getData._mcpResourceUri === "test://data");

  // Follow through like the mcpTool block above: prove the decorated getter is
  // actually wired into the server registry and invoked, by reading it back
  // through the real resources/read JSON-RPC path (not just the metadata flag).
  const resp = JSON.parse(
    await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "test://data" },
    }),
  );
  const contents = resp.result?.contents;
  assert(
    "mcpResource read-back returns one content entry",
    Array.isArray(contents) && contents.length === 1,
    JSON.stringify(resp).slice(0, 160),
  );
  assert(
    "mcpResource read-back echoes the uri",
    contents?.[0]?.uri === "test://data",
    JSON.stringify(contents?.[0]).slice(0, 160),
  );
  assert(
    "mcpResource read-back carries the declared mimeType",
    contents?.[0]?.mimeType === "application/json",
    JSON.stringify(contents?.[0]).slice(0, 160),
  );
  const payload = JSON.parse(contents[0].text);
  assert(
    "mcpResource decorated getter actually ran (deep-equals [1,2,3])",
    JSON.stringify(payload) === JSON.stringify([1, 2, 3]),
    JSON.stringify(payload).slice(0, 160),
  );
}

// ══════════════════════════════════════════════════════════════
// TestSecurity — localhost detection and file sandbox
// ══════════════════════════════════════════════════════════════
console.log("\n=== Security Tests ===\n");

// test_localhost_detection
{
  const oldHost = process.env.TINA4_HOST_NAME;
  try {
    process.env.TINA4_HOST_NAME = "localhost:7148";
    assert("localhost:7148 is localhost", isLocalhost() === true);

    process.env.TINA4_HOST_NAME = "127.0.0.1:7148";
    assert("127.0.0.1 is localhost", isLocalhost() === true);

    process.env.TINA4_HOST_NAME = "0.0.0.0:7148";
    assert("0.0.0.0 is localhost", isLocalhost() === true);

    process.env.TINA4_HOST_NAME = "myserver.example.com:7148";
    assert("remote host is not localhost", isLocalhost() === false);
  } finally {
    if (oldHost !== undefined) {
      process.env.TINA4_HOST_NAME = oldHost;
    } else {
      delete process.env.TINA4_HOST_NAME;
    }
  }
}

// test_file_sandbox
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const server = new McpServer("/test-sandbox", "Sandbox Test");
    registerDevTools(server);

    // Try to read a file outside project dir
    const resp = JSON.parse(
      await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "file_read", arguments: { path: "../../../etc/passwd" } },
      }),
    );
    assert(
      "file_read sandbox blocks path traversal",
      resp.error !== undefined &&
        (resp.error.message.toLowerCase().includes("escapes") ||
          resp.error.message.toLowerCase().includes("path")),
    );
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// test_file_write_sandbox
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-write-"));
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const server = new McpServer("/test-sandbox2", "Sandbox Test 2");
    registerDevTools(server);

    const resp = JSON.parse(
      await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "file_write", arguments: { path: "../../evil.txt", content: "hacked" } },
      }),
    );
    assert(
      "file_write sandbox blocks path traversal",
      resp.error !== undefined,
    );
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// test_file_read_valid (inside project)
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-valid-"));
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  fs.writeFileSync(path.join(tmpDir, "test.txt"), "hello world", "utf-8");
  try {
    const server = new McpServer("/test-valid-read", "Valid Read Test");
    registerDevTools(server);

    const resp = JSON.parse(
      await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "file_read", arguments: { path: "test.txt" } },
      }),
    );
    assert("file_read valid file", resp.result.content[0].text === "hello world");
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// test_file_write_valid (inside project)
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-write-valid-"));
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const server = new McpServer("/test-valid-write", "Valid Write Test");
    registerDevTools(server);

    const resp = JSON.parse(
      await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "file_write", arguments: { path: "output.txt", content: "written" } },
      }),
    );
    assert("file_write valid returns written", resp.result.content[0].text.includes("output.txt"));
    assert("file_write creates file", fs.existsSync(path.join(tmpDir, "output.txt")));
    assert("file_write content correct", fs.readFileSync(path.join(tmpDir, "output.txt"), "utf-8") === "written");
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════
// TestWriteClaudeConfig
// ══════════════════════════════════════════════════════════════
console.log("\n=== writeClaudeConfig Tests ===\n");

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-config-"));
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const server = new McpServer("/my-mcp", "My App Tools", "2.0.0");
    server.writeClaudeConfig(9000);

    const configFile = path.join(tmpDir, ".claude", "settings.json");
    assert("writeClaudeConfig creates file", fs.existsSync(configFile));

    const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    assert("writeClaudeConfig has mcpServers", "mcpServers" in config);
    assert("writeClaudeConfig server key", "my-app-tools" in config.mcpServers);
    assert(
      "writeClaudeConfig url",
      config.mcpServers["my-app-tools"].url === "http://localhost:9000/my-mcp/sse",
    );
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════
// TestDevTools — verify all 24 tools register
// ══════════════════════════════════════════════════════════════
console.log("\n=== Dev Tools Registration Tests ===\n");

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-devtools-"));
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const server = new McpServer("/test-devtools", "Dev Tools Test");
    registerDevTools(server);

    const resp = JSON.parse(
      await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    );
    const tools = resp.result.tools;
    // Node.js mirrors the Python master surface area (24 original + 21 parity
    // tools: plan_*, index_*, project_overview, file_patch, docs_*, git_status,
    // deps_list) plus 3 Live API RAG tools (api_search/class/method, parity with
    // PHP/Python). plan_uncomplete_step is available on the Plan class but not
    // exposed via MCP (matches Python — only plan_complete_step is a tool).
    assert("all 48 dev tools registered", tools.length === 48);

    const toolNames = tools.map((t: any) => t.name).sort();
    const expectedNames = [
      "api_class",
      "api_method",
      "api_search",
      "asset_upload",
      "cache_stats",
      "database_columns",
      "database_execute",
      "database_query",
      "database_tables",
      "deps_list",
      "docs_list",
      "docs_search",
      "docs_section",
      "env_list",
      "error_log",
      "file_list",
      "file_patch",
      "file_read",
      "file_write",
      "git_status",
      "index_file",
      "index_overview",
      "index_rebuild",
      "index_search",
      "log_tail",
      "migration_create",
      "migration_run",
      "migration_status",
      "orm_describe",
      "plan_add_step",
      "plan_archive",
      "plan_complete_step",
      "plan_create",
      "plan_current",
      "plan_flesh",
      "plan_list",
      "plan_note",
      "plan_read",
      "plan_switch_to",
      "project_overview",
      "queue_status",
      "route_list",
      "route_test",
      "seed_table",
      "session_list",
      "swagger_spec",
      "system_info",
      "template_render",
    ].sort();

    if (JSON.stringify(toolNames) !== JSON.stringify(expectedNames)) {
      console.log("  expected: " + JSON.stringify(expectedNames));
      console.log("  actual:   " + JSON.stringify(toolNames));
    }
    assert("all expected tool names present", JSON.stringify(toolNames) === JSON.stringify(expectedNames));
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════
// TestDatabaseTools — end-to-end DB tools over a live SQLite connection
//
// Regression for the two bugs that made the MCP DB tools dead:
//   1. globalThis.__tina4_db was never set — initDatabase() now exposes it.
//   2. The tool dispatch was sync while Database is async — handleMessage and
//      the DB tool handlers now await the Database wrapper.
// This drives `tools/call database_query` and `database_tables` through the
// server exactly like a real MCP client and asserts real rows come back (not
// `{error:"No database connection"}`, not an empty/Promise result).
// ══════════════════════════════════════════════════════════════
console.log("\n=== Database Tools (live SQLite) Tests ===\n");

{
  // In-memory SQLite: single-connection mode shares one adapter between the
  // Database wrapper and the global the MCP tools read, so the CREATE/INSERT
  // below and the tool's SELECT/getTables hit the same connection.
  const db = await initDatabase({ url: "sqlite::memory:" });
  try {
    await db.execute("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)");
    await db.execute("INSERT INTO widgets (id, name) VALUES (1, 'sprocket')");

    assert(
      "initDatabase exposes globalThis.__tina4_db",
      (globalThis as any).__tina4_db === db,
    );

    const server = new McpServer("/test-db-tools", "DB Tools Test");
    registerDevTools(server);

    // ── database_query returns real records (not "No database connection") ──
    const qResp = JSON.parse(
      await server.handleMessage({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "database_query", arguments: { sql: "SELECT id, name FROM widgets ORDER BY id" } },
      }),
    );
    const qText = qResp.result?.content?.[0]?.text;
    assert("database_query returns content text", typeof qText === "string", JSON.stringify(qResp).slice(0, 160));
    const qParsed = JSON.parse(qText);
    assert(
      "database_query did NOT return 'No database connection'",
      qParsed?.error !== "No database connection",
      JSON.stringify(qParsed).slice(0, 160),
    );
    assert(
      "database_query returns a non-empty records array",
      Array.isArray(qParsed?.records) && qParsed.records.length === 1,
      JSON.stringify(qParsed).slice(0, 160),
    );
    assert(
      "database_query record has the real row data",
      qParsed?.records?.[0]?.id === 1 && qParsed?.records?.[0]?.name === "sprocket",
      JSON.stringify(qParsed?.records).slice(0, 160),
    );

    // ── database_query with bound params (JSON string, as MCP clients send) ──
    const qParamResp = JSON.parse(
      await server.handleMessage({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "database_query", arguments: { sql: "SELECT name FROM widgets WHERE id = ?", params: "[1]" } },
      }),
    );
    const qParamParsed = JSON.parse(qParamResp.result.content[0].text);
    assert(
      "database_query honours JSON-string params",
      Array.isArray(qParamParsed?.records) && qParamParsed.records[0]?.name === "sprocket",
      JSON.stringify(qParamParsed).slice(0, 160),
    );

    // ── database_tables lists the table ─────────────────────────
    const tResp = JSON.parse(
      await server.handleMessage({
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "database_tables", arguments: {} },
      }),
    );
    const tParsed = JSON.parse(tResp.result.content[0].text);
    assert(
      "database_tables returns an array (not an error)",
      Array.isArray(tParsed),
      JSON.stringify(tParsed).slice(0, 160),
    );
    assert(
      "database_tables lists the created table",
      Array.isArray(tParsed) && tParsed.includes("widgets"),
      JSON.stringify(tParsed).slice(0, 160),
    );
  } finally {
    closeDatabase();
    delete (globalThis as any).__tina4_db;
  }
}

// ══════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════

console.log(`\n${"=".repeat(50)}`);
console.log(`MCP Tests: ${pass} passed, ${fail} failed`);
console.log(`${"=".repeat(50)}\n`);

if (fail > 0) {
  process.exit(1);
}
