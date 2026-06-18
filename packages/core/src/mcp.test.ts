/**
 * Unit tests for the MCP (Model Context Protocol) implementation.
 * Run with: npx tsx packages/core/src/mcp.test.ts
 */
import {
  encodeResponse, encodeError, encodeNotification, decodeRequest,
  McpServer, isLocalhost, schemaFromParams, registerDevTools,
  PARSE_ERROR, METHOD_NOT_FOUND, INTERNAL_ERROR,
} from "./mcp.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

function assertThrows(name: string, fn: () => void, match?: string) {
  try {
    fn();
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} (no exception thrown)`);
    fail++;
  } catch (e) {
    if (match && !(e as Error).message.includes(match)) {
      console.log(`  \x1b[31mFAIL\x1b[0m ${name} (expected "${match}" in "${(e as Error).message}")`);
      fail++;
    } else {
      console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
      pass++;
    }
  }
}

// ── JSON-RPC 2.0 Protocol ────────────────────────────────────

console.log("\nJSON-RPC 2.0 Protocol");

{
  const raw = encodeResponse(1, { tools: [] });
  const msg = JSON.parse(raw);
  assert("encodeResponse — jsonrpc", msg.jsonrpc === "2.0");
  assert("encodeResponse — id", msg.id === 1);
  assert("encodeResponse — result", JSON.stringify(msg.result) === JSON.stringify({ tools: [] }));
}

{
  const raw = encodeError(2, METHOD_NOT_FOUND, "Not found");
  const msg = JSON.parse(raw);
  assert("encodeError — jsonrpc", msg.jsonrpc === "2.0");
  assert("encodeError — id", msg.id === 2);
  assert("encodeError — code", msg.error.code === -32601);
  assert("encodeError — message", msg.error.message === "Not found");
}

{
  const raw = encodeError(3, INTERNAL_ERROR, "Fail", { detail: "extra" });
  const msg = JSON.parse(raw);
  assert("encodeError with data", msg.error.data?.detail === "extra");
}

{
  const { method, params, requestId } = decodeRequest(JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "tools/list", params: {},
  }));
  assert("decodeRequest — method", method === "tools/list");
  assert("decodeRequest — params", JSON.stringify(params) === "{}");
  assert("decodeRequest — id", requestId === 3);
}

{
  const { method, requestId } = decodeRequest({
    jsonrpc: "2.0", method: "notifications/initialized",
  });
  assert("decodeRequest notification — method", method === "notifications/initialized");
  assert("decodeRequest notification — id null", requestId === null);
}

assertThrows("decodeRequest invalid JSON", () => decodeRequest("not json"), "Invalid JSON");

assertThrows("decodeRequest missing method", () => decodeRequest({ jsonrpc: "2.0", id: 1 } as any), "method");

assertThrows("decodeRequest missing jsonrpc", () => decodeRequest({ method: "test", id: 1 } as any), "jsonrpc");

// ── Notification Encoding ────────────────────────────────────

console.log("\nNotification Encoding");

{
  const raw = encodeNotification("test/event", { key: "value" });
  const msg = JSON.parse(raw);
  assert("encodeNotification — jsonrpc", msg.jsonrpc === "2.0");
  assert("encodeNotification — method", msg.method === "test/event");
  assert("encodeNotification — params", msg.params?.key === "value");
  assert("encodeNotification — no id", msg.id === undefined);
}

{
  const raw = encodeNotification("test/simple");
  const msg = JSON.parse(raw);
  assert("encodeNotification without params", msg.params === undefined);
}

// ── McpServer Core ───────────────────────────────────────────

console.log("\nMcpServer Core");

{
  McpServer._instances = [];
  const server = new McpServer("/test-mcp", "Test Server", "0.1.0");
  const resp = JSON.parse(await server.handleMessage({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    },
  }));
  assert("initialize — protocolVersion", resp.result.protocolVersion === "2024-11-05");
  assert("initialize — serverInfo.name", resp.result.serverInfo.name === "Test Server");
  assert("initialize — capabilities.tools", resp.result.capabilities.tools !== undefined);
}

{
  McpServer._instances = [];
  const server = new McpServer("/test-mcp", "Test Server");
  const resp = JSON.parse(await server.handleMessage({
    jsonrpc: "2.0", id: 2, method: "ping", params: {},
  }));
  assert("ping — result empty", JSON.stringify(resp.result) === "{}");
}

{
  McpServer._instances = [];
  const server = new McpServer("/test-mcp", "Test Server");
  const resp = JSON.parse(await server.handleMessage({
    jsonrpc: "2.0", id: 3, method: "nonexistent", params: {},
  }));
  assert("method not found — code", resp.error.code === -32601);
}

{
  McpServer._instances = [];
  const server = new McpServer("/test-mcp", "Test Server");
  const resp = await server.handleMessage({
    jsonrpc: "2.0", method: "notifications/initialized",
  });
  assert("notification — empty response", resp === "");
}

// ── Tool Registration and Call ───────────────────────────────

console.log("\nTool Registration and Call");

{
  McpServer._instances = [];
  const server = new McpServer("/test-tools", "Tool Test");
  server.registerTool(
    "greet",
    (args) => `Hello, ${args.name}!`,
    "Greet someone",
    schemaFromParams([{ name: "name", type: "string" }]),
  );

  const resp = JSON.parse(await server.handleMessage({
    jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
  }));
  const tools = resp.result.tools;
  assert("registerTool — count", tools.length === 1);
  assert("registerTool — name", tools[0].name === "greet");
  assert("registerTool — schema type", tools[0].inputSchema.properties.name.type === "string");
  assert("registerTool — required", tools[0].inputSchema.required?.includes("name") === true);
}

{
  McpServer._instances = [];
  const server = new McpServer("/test-tools", "Tool Test");
  server.registerTool(
    "add",
    (args) => (args.a as number) + (args.b as number),
    "Add two numbers",
    schemaFromParams([{ name: "a", type: "integer" }, { name: "b", type: "integer" }]),
  );

  const resp = JSON.parse(await server.handleMessage({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "add", arguments: { a: 3, b: 5 } },
  }));
  const content = resp.result.content;
  assert("callTool — content count", content.length === 1);
  assert("callTool — type", content[0].type === "text");
  assert("callTool — result contains 8", content[0].text.includes("8"));
}

{
  McpServer._instances = [];
  const server = new McpServer("/test-tools", "Tool Test");
  const resp = JSON.parse(await server.handleMessage({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "missing", arguments: {} },
  }));
  assert("unknown tool — error code", resp.error.code === -32603);
}

{
  McpServer._instances = [];
  const server = new McpServer("/test-tools", "Tool Test");
  server.registerTool("echo", (args) => args.msg as string, "Echo",
    schemaFromParams([{ name: "msg", type: "string" }]));

  const resp = JSON.parse(await server.handleMessage({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "echo", arguments: { msg: "hello" } },
  }));
  assert("tool string result", resp.result.content[0].text === "hello");
}

{
  McpServer._instances = [];
  const server = new McpServer("/test-tools", "Tool Test");
  server.registerTool("data", () => ({ a: 1, b: 2 }), "Return data");

  const resp = JSON.parse(await server.handleMessage({
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "data", arguments: {} },
  }));
  const data = JSON.parse(resp.result.content[0].text);
  assert("tool object result — a", data.a === 1);
  assert("tool object result — b", data.b === 2);
}

// ── Schema from Params ───────────────────────────────────────

console.log("\nSchema from Params");

{
  const schema = schemaFromParams([
    { name: "name", type: "string" },
    { name: "count", type: "integer", default: 5 },
    { name: "active", type: "boolean", default: true },
  ]);
  assert("schema — name type", schema.properties.name.type === "string");
  assert("schema — count type", schema.properties.count.type === "integer");
  assert("schema — count default", schema.properties.count.default === 5);
  assert("schema — active type", schema.properties.active.type === "boolean");
  assert("schema — required only name", JSON.stringify(schema.required) === '["name"]');
}

// ── Resource Registration and Read ───────────────────────────

console.log("\nResource Registration and Read");

{
  McpServer._instances = [];
  const server = new McpServer("/test-resources", "Resource Test");
  server.registerResource("app://tables", () => ["users", "products"], "Database tables");

  const resp = JSON.parse(await server.handleMessage({
    jsonrpc: "2.0", id: 1, method: "resources/list", params: {},
  }));
  const resources = resp.result.resources;
  assert("registerResource — count", resources.length === 1);
  assert("registerResource — uri", resources[0].uri === "app://tables");
}

{
  McpServer._instances = [];
  const server = new McpServer("/test-resources", "Resource Test");
  server.registerResource("app://info", () => ({ version: "1.0", name: "Test App" }), "App info");

  const resp = JSON.parse(await server.handleMessage({
    jsonrpc: "2.0", id: 2, method: "resources/read",
    params: { uri: "app://info" },
  }));
  const contents = resp.result.contents;
  assert("readResource — count", contents.length === 1);
  const data = JSON.parse(contents[0].text);
  assert("readResource — version", data.version === "1.0");
}

{
  McpServer._instances = [];
  const server = new McpServer("/test-resources", "Resource Test");
  const resp = JSON.parse(await server.handleMessage({
    jsonrpc: "2.0", id: 3, method: "resources/read",
    params: { uri: "app://missing" },
  }));
  assert("unknown resource — error code", resp.error.code === -32603);
}

// ── Localhost Detection ──────────────────────────────────────

console.log("\nLocalhost Detection");

{
  const oldHost = process.env.TINA4_HOST_NAME;

  process.env.TINA4_HOST_NAME = "localhost:7148";
  assert("isLocalhost — localhost", isLocalhost() === true);

  process.env.TINA4_HOST_NAME = "127.0.0.1:7148";
  assert("isLocalhost — 127.0.0.1", isLocalhost() === true);

  process.env.TINA4_HOST_NAME = "0.0.0.0:7148";
  assert("isLocalhost — 0.0.0.0", isLocalhost() === true);

  process.env.TINA4_HOST_NAME = "myserver.example.com:7148";
  assert("isLocalhost — remote false", isLocalhost() === false);

  // Restore
  if (oldHost !== undefined) {
    process.env.TINA4_HOST_NAME = oldHost;
  } else {
    delete process.env.TINA4_HOST_NAME;
  }
}

// ── File Sandbox ─────────────────────────────────────────────

console.log("\nFile Sandbox");

{
  McpServer._instances = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tina4-mcp-test-"));
  const oldCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const server = new McpServer("/test-sandbox", "Sandbox Test");
    registerDevTools(server);

    const resp = JSON.parse(await server.handleMessage({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "file_read", arguments: { path: "../../../etc/passwd" } },
    }));
    const hasError = resp.error !== undefined;
    const errorMsg = resp.error?.message?.toLowerCase() ?? "";
    assert(
      "file_read sandbox — rejects path escape",
      hasError && (errorMsg.includes("escapes") || errorMsg.includes("path")),
      `Got: ${JSON.stringify(resp)}`,
    );
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

{
  McpServer._instances = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tina4-mcp-test-"));
  const oldCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const server = new McpServer("/test-sandbox2", "Sandbox Test 2");
    registerDevTools(server);

    const resp = JSON.parse(await server.handleMessage({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "file_write", arguments: { path: "../../evil.txt", content: "hacked" } },
    }));
    assert(
      "file_write sandbox — rejects path escape",
      resp.error !== undefined,
      `Got: ${JSON.stringify(resp)}`,
    );
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Instance Registry ────────────────────────────────────────

console.log("\nInstance Registry");

{
  McpServer._instances = [];
  assert("instances — starts empty", McpServer._instances.length === 0);
  new McpServer("/a", "Server A");
  new McpServer("/b", "Server B");
  assert("instances — two registered", McpServer._instances.length === 2);
  McpServer._instances = [];
  assert("instances — cleared", McpServer._instances.length === 0);
}

// ── Defensive Write Helpers (Tier 1 parity port from Python) ─

console.log("\nDefensive Write Helpers");

/**
 * Invoke an MCP tool and unwrap the JSON-RPC + tools/call envelope.
 * The MCP `tools/call` response shape is:
 *   { jsonrpc, id, result: { content: [{ type: "text", text: "<json>" }] } }
 * For string returns the inner text is the raw string; for object returns
 * it is JSON-encoded — try to parse it back, fall through to the raw text.
 */
async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<{
  rpc: { jsonrpc?: string; id?: unknown; result?: unknown; error?: { code: number; message: string } };
  result: Record<string, unknown> | string | null;
}> {
  const rpc = JSON.parse(await server.handleMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args },
  }));
  let result: Record<string, unknown> | string | null = null;
  const content = (rpc.result as { content?: Array<{ text?: string }> } | undefined)?.content;
  if (content && content.length > 0 && typeof content[0].text === "string") {
    const raw = content[0].text;
    try {
      result = JSON.parse(raw);
    } catch {
      result = raw;
    }
  }
  return { rpc, result };
}

// refuses prose paths in file_write
{
  McpServer._instances = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tina4-mcp-test-"));
  const oldCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const server = new McpServer("/test-prose", "Prose Test");
    registerDevTools(server);
    const { result } = await callTool(server, "file_write", {
      path: "The plan requires implementing a new feature for users.ts",
      content: "x",
    });
    assert(
      "refuses prose paths in file_write",
      typeof result === "object" && result !== null && typeof (result as Record<string, unknown>).error === "string",
      `Got: ${JSON.stringify(result)}`,
    );
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// normalizes bare routes/ to src/routes/
{
  McpServer._instances = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tina4-mcp-test-"));
  const oldCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const server = new McpServer("/test-normalize", "Normalize Test");
    registerDevTools(server);
    const { result } = await callTool(server, "file_write", {
      path: "routes/foo.ts",
      content: "export default async function (req, res) {}\n",
    });
    const landedAt = path.join(tmpDir, "src", "routes", "foo.ts");
    const written = (result as { written?: string } | null)?.written;
    assert(
      "normalizes bare routes/ to src/routes/ — file lands at src/routes/foo.ts",
      fs.existsSync(landedAt) && (written ?? "").replace(/\\/g, "/") === "src/routes/foo.ts",
      `Got: ${JSON.stringify(result)}; exists=${fs.existsSync(landedAt)}`,
    );
    const logPath = path.join(tmpDir, ".tina4", "agent.log");
    const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
    assert(
      "normalizes bare routes/ to src/routes/ — agent.log has path_normalized entry",
      logContent.includes("write.path_normalized") && logContent.includes("routes/foo.ts"),
      `Log content: ${logContent.slice(0, 300)}`,
    );
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// backs up existing file before overwrite
{
  McpServer._instances = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tina4-mcp-test-"));
  const oldCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const server = new McpServer("/test-backup", "Backup Test");
    registerDevTools(server);
    const target = path.join(tmpDir, "src", "routes", "foo.ts");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "original content\n", "utf-8");

    const { result } = await callTool(server, "file_write", {
      path: "src/routes/foo.ts",
      content: "new content that is reasonably similar in length to the old one\n",
    });
    const backup = (result as { backup?: string } | null)?.backup ?? "";
    const backupDir = path.join(tmpDir, ".tina4", "backups");
    const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    assert(
      "backs up existing file before overwrite — backup in .tina4/backups/",
      backups.length === 1 && backup.startsWith(".tina4/backups/"),
      `Got: ${JSON.stringify(result)}; backups=${JSON.stringify(backups)}`,
    );
    assert(
      "backs up existing file before overwrite — backup contains original",
      backups.length === 1 &&
        fs.readFileSync(path.join(backupDir, backups[0]), "utf-8") === "original content\n",
    );
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// refuses suspicious truncation
{
  McpServer._instances = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tina4-mcp-test-"));
  const oldCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const server = new McpServer("/test-truncation", "Truncation Test");
    registerDevTools(server);
    const target = path.join(tmpDir, "src", "routes", "big.ts");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 500-byte original
    const original = "x".repeat(500);
    fs.writeFileSync(target, original, "utf-8");

    // Overwrite with 50 bytes — should be REFUSED (50/500 = 10% < 30%)
    const { result } = await callTool(server, "file_write", {
      path: "src/routes/big.ts",
      content: "y".repeat(50),
    });
    const r = result as { error?: string; refused?: boolean } | null;
    assert(
      "refuses suspicious truncation — returns error with refused flag",
      r !== null && r.refused === true && typeof r.error === "string" && r.error.includes("REFUSED"),
      `Got: ${JSON.stringify(result)}`,
    );
    const stillThere = fs.readFileSync(target, "utf-8");
    assert(
      "refuses suspicious truncation — original file intact",
      stillThere === original,
      `Original was modified: length=${stillThere.length}`,
    );
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// lets canonical src/ paths pass through (no rewrite)
{
  McpServer._instances = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tina4-mcp-test-"));
  const oldCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const server = new McpServer("/test-passthrough", "Passthrough Test");
    registerDevTools(server);
    const { result } = await callTool(server, "file_write", {
      path: "src/routes/foo.ts",
      content: "export default async function (req, res) {}\n",
    });
    const landedAt = path.join(tmpDir, "src", "routes", "foo.ts");
    const written = (result as { written?: string } | null)?.written;
    assert(
      "lets canonical src/ paths pass through — file lands at src/routes/foo.ts",
      fs.existsSync(landedAt) && (written ?? "").replace(/\\/g, "/") === "src/routes/foo.ts",
      `Got: ${JSON.stringify(result)}`,
    );
    // Path should NOT have been double-prefixed to src/src/routes/foo.ts
    const doublyPrefixed = path.join(tmpDir, "src", "src", "routes", "foo.ts");
    assert(
      "lets canonical src/ paths pass through — no double-prefix",
      !fs.existsSync(doublyPrefixed),
    );
    // agent.log should NOT contain a path_normalized entry for this write
    const logPath = path.join(tmpDir, ".tina4", "agent.log");
    const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
    assert(
      "lets canonical src/ paths pass through — no path_normalized log entry",
      !logContent.includes("write.path_normalized"),
      `Log content: ${logContent.slice(0, 300)}`,
    );
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// catches JS syntax errors via node --check
{
  McpServer._instances = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tina4-mcp-test-"));
  const oldCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const server = new McpServer("/test-verify-js", "Verify JS");
    registerDevTools(server);
    const { result } = await callTool(server, "file_write", {
      path: "src/routes/broken.js",
      content: "const x = ;\n",
    });
    const r = result as { written?: string; import_error?: string } | null;
    assert(
      "catches JS syntax errors via node --check — result has import_error",
      r !== null && typeof r.import_error === "string" && r.import_error.length > 0,
      `Got: ${JSON.stringify(result)}`,
    );
    const logPath = path.join(tmpDir, ".tina4", "agent.log");
    const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
    assert(
      "catches JS syntax errors via node --check — agent.log has write.import_failed",
      logContent.includes("write.import_failed") && logContent.includes("src/routes/broken.js"),
      `Log content: ${logContent.slice(0, 400)}`,
    );
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// skips non-code files (no syntax check attempted)
{
  McpServer._instances = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tina4-mcp-test-"));
  const oldCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const server = new McpServer("/test-verify-skip-ext", "Verify Skip Ext");
    registerDevTools(server);
    // .twig content that would obviously fail any JS parser
    const { result } = await callTool(server, "file_write", {
      path: "src/templates/page.twig",
      content: "{% if not valid js %}<h1>Hi</h1>{% endif %}\n",
    });
    const r = result as { written?: string; import_error?: string } | null;
    assert(
      "skips non-code files — no import_error attached",
      r !== null && r.import_error === undefined && typeof r.written === "string",
      `Got: ${JSON.stringify(result)}`,
    );
    const logPath = path.join(tmpDir, ".tina4", "agent.log");
    const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
    assert(
      "skips non-code files — no write.import_failed in agent.log",
      !logContent.includes("write.import_failed"),
      `Log content: ${logContent.slice(0, 400)}`,
    );
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// skips files outside src/
{
  McpServer._instances = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tina4-mcp-test-"));
  const oldCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const server = new McpServer("/test-verify-skip-outside", "Verify Skip Outside");
    registerDevTools(server);
    // Broken JS placed under tests/ — must NOT be checked
    const { result } = await callTool(server, "file_write", {
      path: "tests/foo.js",
      content: "const x = ;\n",
    });
    const r = result as { written?: string; import_error?: string } | null;
    assert(
      "skips files outside src/ — no import_error attached",
      r !== null && r.import_error === undefined && typeof r.written === "string",
      `Got: ${JSON.stringify(result)}`,
    );
    const logPath = path.join(tmpDir, ".tina4", "agent.log");
    const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
    assert(
      "skips files outside src/ — no write.import_failed in agent.log",
      !logContent.includes("write.import_failed"),
      `Log content: ${logContent.slice(0, 400)}`,
    );
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Summary ──────────────────────────────────────────────────

console.log(`\nMCP Tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
