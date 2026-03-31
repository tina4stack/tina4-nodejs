// Tina4 MCP Server — Model Context Protocol for AI tool integration.
//
// Built-in MCP server for dev tools + developer API for custom MCP servers.
//
// Usage (developer):
//
//   import { McpServer, mcpTool, mcpResource } from "@tina4/core";
//
//   const mcp = new McpServer("/my-mcp", "My App Tools");
//
//   mcpTool("lookup_invoice", "Find invoice by number", mcp)(
//     (args: { invoice_no: string }) => db.fetchOne("SELECT * FROM invoices WHERE invoice_no = ?", [args.invoice_no])
//   );
//
// Built-in dev tools auto-register when TINA4_DEBUG=true and running on localhost.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Types ─────────────────────────────────────────────────────

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: Record<string, unknown>) => unknown;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  handler: () => unknown;
}

export interface JsonSchema {
  type: string;
  properties: Record<string, { type: string; default?: unknown }>;
  required?: string[];
}

export interface McpToolParam {
  name: string;
  type: "string" | "integer" | "number" | "boolean" | "array" | "object";
  required?: boolean;
  default?: unknown;
}

// ── JSON-RPC 2.0 Protocol ────────────────────────────────────

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export function encodeResponse(requestId: number | string | null | undefined, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: requestId, result });
}

export function encodeError(
  requestId: number | string | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): string {
  const error: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return JSON.stringify({ jsonrpc: "2.0", id: requestId, error });
}

export function encodeNotification(method: string, params?: Record<string, unknown>): string {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) {
    msg.params = params;
  }
  return JSON.stringify(msg);
}

export function decodeRequest(data: string | Record<string, unknown>): {
  method: string;
  params: Record<string, unknown>;
  requestId: number | string | null;
} {
  let msg: Record<string, unknown>;

  if (typeof data === "string") {
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Invalid JSON: ${(e as Error).message}`);
    }
  } else {
    msg = data;
  }

  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    throw new Error("Message must be a JSON object");
  }

  if (msg.jsonrpc !== "2.0") {
    throw new Error("Missing or invalid jsonrpc version");
  }

  const method = msg.method;
  if (!method || typeof method !== "string") {
    throw new Error("Missing or invalid method");
  }

  const params = (msg.params as Record<string, unknown>) || {};
  const requestId = (msg.id as number | string | null) ?? null;

  return { method, params, requestId };
}

// ── Schema extraction from parameter metadata ────────────────

/**
 * Build a JSON Schema from an explicit parameter list.
 * Since TypeScript erases types at runtime, we use explicit metadata.
 */
export function schemaFromParams(params: McpToolParam[]): JsonSchema {
  const properties: Record<string, { type: string; default?: unknown }> = {};
  const required: string[] = [];

  for (const p of params) {
    const prop: { type: string; default?: unknown } = { type: p.type };
    if (p.default !== undefined) {
      prop.default = p.default;
    }
    if (p.required !== false && p.default === undefined) {
      required.push(p.name);
    }
    properties[p.name] = prop;
  }

  const schema: JsonSchema = { type: "object", properties };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

// ── Localhost detection ──────────────────────────────────────

export function isLocalhost(): boolean {
  const hostEnv = process.env.HOST_NAME || "localhost:7148";
  const host = hostEnv.split(":")[0];
  return ["localhost", "127.0.0.1", "0.0.0.0", "::1", ""].includes(host);
}

// ── McpServer class ──────────────────────────────────────────

export class McpServer {
  static _instances: McpServer[] = [];

  path: string;
  name: string;
  version: string;

  private _tools: Map<string, McpToolDefinition> = new Map();
  private _resources: Map<string, McpResourceDefinition> = new Map();
  private _initialized = false;

  constructor(mcpPath: string, name = "Tina4 MCP", version = "1.0.0") {
    this.path = mcpPath.replace(/\/+$/, "");
    this.name = name;
    this.version = version;
    McpServer._instances.push(this);
  }

  registerTool(
    name: string,
    handler: (args: Record<string, unknown>) => unknown,
    description = "",
    schema?: JsonSchema,
  ): void {
    const inputSchema = schema || { type: "object", properties: {} };
    this._tools.set(name, {
      name,
      description,
      inputSchema,
      handler,
    });
  }

  registerResource(
    uri: string,
    handler: () => unknown,
    description = "",
    mimeType = "application/json",
  ): void {
    this._resources.set(uri, {
      uri,
      name: description || uri,
      description,
      mimeType,
      handler,
    });
  }

  handleMessage(rawData: string | Record<string, unknown>): string {
    let method: string;
    let params: Record<string, unknown>;
    let requestId: number | string | null;

    try {
      ({ method, params, requestId } = decodeRequest(rawData));
    } catch (e) {
      return encodeError(null, PARSE_ERROR, (e as Error).message);
    }

    const handlers: Record<string, (p: Record<string, unknown>) => unknown> = {
      initialize: (p) => this._handleInitialize(p),
      "notifications/initialized": (p) => this._handleInitialized(p),
      "tools/list": (p) => this._handleToolsList(p),
      "tools/call": (p) => this._handleToolsCall(p),
      "resources/list": (p) => this._handleResourcesList(p),
      "resources/read": (p) => this._handleResourcesRead(p),
      ping: (p) => this._handlePing(p),
    };

    const handler = handlers[method];
    if (!handler) {
      return encodeError(requestId, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }

    try {
      const result = handler(params);
      if (requestId === null) {
        return ""; // Notification — no response
      }
      return encodeResponse(requestId, result);
    } catch (e) {
      return encodeError(requestId, INTERNAL_ERROR, (e as Error).message);
    }
  }

  private _handleInitialize(_params: Record<string, unknown>): Record<string, unknown> {
    this._initialized = true;
    return {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: {
        name: this.name,
        version: this.version,
      },
    };
  }

  private _handleInitialized(_params: Record<string, unknown>): void {
    // no-op
  }

  private _handlePing(_params: Record<string, unknown>): Record<string, unknown> {
    return {};
  }

  private _handleToolsList(_params: Record<string, unknown>): Record<string, unknown> {
    const tools: Record<string, unknown>[] = [];
    for (const t of this._tools.values()) {
      tools.push({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      });
    }
    return { tools };
  }

  private _handleToolsCall(params: Record<string, unknown>): Record<string, unknown> {
    const toolName = params.name as string | undefined;
    if (!toolName) {
      throw new Error("Missing tool name");
    }

    const tool = this._tools.get(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    const args = (params.arguments as Record<string, unknown>) || {};
    const result = tool.handler(args);

    // Format result as MCP content
    let content: { type: string; text: string }[];
    if (typeof result === "string") {
      content = [{ type: "text", text: result }];
    } else if (typeof result === "object" && result !== null) {
      content = [{ type: "text", text: JSON.stringify(result, null, 2) }];
    } else {
      content = [{ type: "text", text: String(result) }];
    }

    return { content };
  }

  private _handleResourcesList(_params: Record<string, unknown>): Record<string, unknown> {
    const resources: Record<string, unknown>[] = [];
    for (const r of this._resources.values()) {
      resources.push({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      });
    }
    return { resources };
  }

  private _handleResourcesRead(params: Record<string, unknown>): Record<string, unknown> {
    const uri = params.uri as string | undefined;
    if (!uri) {
      throw new Error("Missing resource URI");
    }

    const resource = this._resources.get(uri);
    if (!resource) {
      throw new Error(`Unknown resource: ${uri}`);
    }

    const result = resource.handler();

    let text: string;
    if (typeof result === "string") {
      text = result;
    } else if (typeof result === "object" && result !== null) {
      text = JSON.stringify(result, null, 2);
    } else {
      text = String(result);
    }

    return {
      contents: [
        {
          uri,
          mimeType: resource.mimeType,
          text,
        },
      ],
    };
  }

  /**
   * Register HTTP routes for this MCP server on the Tina4 router.
   *
   * Registers:
   *   POST {path}/message  — JSON-RPC message endpoint
   *   GET  {path}/sse      — SSE endpoint for streaming
   */
  registerRoutes(router: {
    post: (pattern: string, handler: (req: unknown, res: unknown) => unknown) => { noAuth: () => unknown };
    get: (pattern: string, handler: (req: unknown, res: unknown) => unknown) => { noAuth: () => unknown };
  }): void {
    const server = this;
    const msgPath = `${this.path}/message`;
    const ssePath = `${this.path}/sse`;

    router
      .post(msgPath, (req: unknown, res: unknown) => {
        const request = req as { body: unknown; url?: string };
        const response = res as ((data: unknown, status?: number, contentType?: string) => unknown);
        const body = request.body;
        let raw: string | Record<string, unknown>;
        if (typeof body === "object" && body !== null) {
          raw = body as Record<string, unknown>;
        } else {
          raw = typeof body === "string" ? body : String(body);
        }
        const result = server.handleMessage(raw);
        if (!result) {
          return response("", 204);
        }
        return response(JSON.parse(result));
      })
      .noAuth();

    router
      .get(ssePath, (req: unknown, res: unknown) => {
        const request = req as { url?: string; headers?: Record<string, string> };
        const response = res as {
          header: (name: string, value: string) => unknown;
          send: (data: string, status?: number, contentType?: string) => unknown;
        };
        // Determine base URL for the endpoint
        const reqUrl = request.url || ssePath;
        const endpointUrl = reqUrl.replace(/\/sse$/, "/message");
        const sseData = `event: endpoint\ndata: ${endpointUrl}\n\n`;
        response.header("Content-Type", "text/event-stream");
        response.header("Cache-Control", "no-cache");
        response.header("Connection", "keep-alive");
        return response.send(sseData, 200, "text/event-stream");
      })
      .noAuth();
  }

  /**
   * Write/update .claude/settings.json with this MCP server config.
   */
  writeClaudeConfig(port = 7148): void {
    const configDir = path.resolve(".claude");
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const configFile = path.join(configDir, "settings.json");
    let config: Record<string, unknown> = {};
    if (fs.existsSync(configFile)) {
      try {
        config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      } catch {
        // ignore parse errors
      }
    }

    if (!config.mcpServers || typeof config.mcpServers !== "object") {
      config.mcpServers = {};
    }

    const serverKey = this.name.toLowerCase().replace(/ /g, "-");
    (config.mcpServers as Record<string, unknown>)[serverKey] = {
      url: `http://localhost:${port}${this.path}/sse`,
    };

    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", "utf-8");
  }
}

// ── Decorator API ──────────────────────────────────────────────

let _defaultServer: McpServer | null = null;

function _getDefaultServer(): McpServer {
  if (_defaultServer === null) {
    _defaultServer = new McpServer("/__dev/mcp", "Tina4 Dev Tools");
  }
  return _defaultServer;
}

/**
 * Register a function as an MCP tool.
 *
 * Usage:
 *   const greet = mcpTool("greet", "Say hello", server, [
 *     { name: "name", type: "string" },
 *   ])((args) => `Hello, ${args.name}!`);
 *
 * Returns the original function with _mcpToolName attached.
 */
export function mcpTool(
  name: string,
  description = "",
  server?: McpServer,
  params?: McpToolParam[],
): <T extends (args: Record<string, unknown>) => unknown>(fn: T) => T & { _mcpToolName: string } {
  return <T extends (args: Record<string, unknown>) => unknown>(fn: T) => {
    const target = server || _getDefaultServer();
    const schema = params ? schemaFromParams(params) : { type: "object" as const, properties: {} };
    target.registerTool(name, fn, description, schema);
    (fn as T & { _mcpToolName: string })._mcpToolName = name;
    return fn as T & { _mcpToolName: string };
  };
}

/**
 * Register a function as an MCP resource.
 *
 * Usage:
 *   const tables = mcpResource("app://tables", "Database tables", "application/json", server)(
 *     () => ["users", "products"]
 *   );
 */
export function mcpResource(
  uri: string,
  description = "",
  mimeType = "application/json",
  server?: McpServer,
): <T extends () => unknown>(fn: T) => T & { _mcpResourceUri: string } {
  return <T extends () => unknown>(fn: T) => {
    const target = server || _getDefaultServer();
    target.registerResource(uri, fn, description, mimeType);
    (fn as T & { _mcpResourceUri: string })._mcpResourceUri = uri;
    return fn as T & { _mcpResourceUri: string };
  };
}

// ── Built-in dev tools ───────────────────────────────────────

/**
 * Resolve a path and ensure it is within the project directory.
 */
function safePath(projectRoot: string, relPath: string): string {
  const resolved = path.resolve(projectRoot, relPath);
  if (!resolved.startsWith(projectRoot)) {
    throw new Error(`Path escapes project directory: ${relPath}`);
  }
  return resolved;
}

/**
 * Redact sensitive environment variable values.
 */
function redactEnv(key: string, value: string): string {
  const sensitive = ["secret", "password", "token", "key", "credential", "api_key"];
  if (sensitive.some((s) => key.toLowerCase().includes(s))) {
    return "***REDACTED***";
  }
  return value;
}

/**
 * Register all 24 built-in dev tools on the given McpServer.
 */
export function registerDevTools(server: McpServer): void {
  const projectRoot = path.resolve(process.cwd());

  // ── Database Tools ──────────────────────────────────────────

  server.registerTool(
    "database_query",
    (args) => {
      try {
        const { initDatabase } = require("@tina4/orm");
        const db = (globalThis as any).__tina4_db;
        if (!db) return { error: "No database connection" };
        const params = typeof args.params === "string" ? JSON.parse(args.params as string) : (args.params || []);
        const result = db.fetch(args.sql as string, params);
        return { records: result.records || [], count: result.count || 0 };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "Execute a read-only SQL query (SELECT)",
    schemaFromParams([
      { name: "sql", type: "string" },
      { name: "params", type: "string", default: "[]" },
    ]),
  );

  server.registerTool(
    "database_execute",
    (args) => {
      try {
        const db = (globalThis as any).__tina4_db;
        if (!db) return { error: "No database connection" };
        const params = typeof args.params === "string" ? JSON.parse(args.params as string) : (args.params || []);
        const result = db.execute(args.sql as string, params);
        db.commit?.();
        return { success: true, affected_rows: result?.count ?? 0 };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "Execute arbitrary SQL (INSERT/UPDATE/DELETE/DDL)",
    schemaFromParams([
      { name: "sql", type: "string" },
      { name: "params", type: "string", default: "[]" },
    ]),
  );

  server.registerTool(
    "database_tables",
    (_args) => {
      try {
        const db = (globalThis as any).__tina4_db;
        if (!db) return { error: "No database connection" };
        return db.getTables?.() ?? [];
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "List all database tables",
    schemaFromParams([]),
  );

  server.registerTool(
    "database_columns",
    (args) => {
      try {
        const db = (globalThis as any).__tina4_db;
        if (!db) return { error: "No database connection" };
        return db.getColumns?.(args.table as string) ?? [];
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "Get column definitions for a table",
    schemaFromParams([{ name: "table", type: "string" }]),
  );

  // ── Route Tools ─────────────────────────────────────────────

  server.registerTool(
    "route_list",
    (_args) => {
      try {
        const { defaultRouter } = require("@tina4/core");
        const routes = defaultRouter?.listRoutes?.() ?? [];
        return routes.map((r: any) => ({
          method: r.method || "",
          path: r.pattern || r.path || "",
          auth_required: r.secure ?? false,
        }));
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "List all registered routes",
    schemaFromParams([]),
  );

  server.registerTool(
    "route_test",
    (args) => {
      // Simplified: return info about what would be tested
      return {
        info: "Route testing requires the test client",
        method: args.method,
        path: args.path,
      };
    },
    "Call a route and return the response",
    schemaFromParams([
      { name: "method", type: "string" },
      { name: "path", type: "string" },
      { name: "body", type: "string", default: "" },
      { name: "headers", type: "string", default: "{}" },
    ]),
  );

  server.registerTool(
    "swagger_spec",
    (_args) => {
      try {
        const { generateSpec } = require("@tina4/swagger");
        return generateSpec?.() ?? { info: "Swagger not available" };
      } catch {
        return { info: "Swagger package not loaded" };
      }
    },
    "Return the OpenAPI 3.0.3 JSON spec",
    schemaFromParams([]),
  );

  // ── Template Tools ──────────────────────────────────────────

  server.registerTool(
    "template_render",
    (args) => {
      try {
        const { renderTemplate } = require("@tina4/twig");
        const data = typeof args.data === "string" ? JSON.parse(args.data as string) : (args.data || {});
        return renderTemplate?.(args.template as string, data) ?? "Template engine not available";
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "Render a template string with data",
    schemaFromParams([
      { name: "template", type: "string" },
      { name: "data", type: "string", default: "{}" },
    ]),
  );

  // ── File Tools ──────────────────────────────────────────────

  server.registerTool(
    "file_read",
    (args) => {
      const p = safePath(projectRoot, args.path as string);
      if (!fs.existsSync(p)) return `File not found: ${args.path}`;
      const stat = fs.statSync(p);
      if (!stat.isFile()) return `Not a file: ${args.path}`;
      return fs.readFileSync(p, "utf-8");
    },
    "Read a project file",
    schemaFromParams([{ name: "path", type: "string" }]),
  );

  server.registerTool(
    "file_write",
    (args) => {
      const p = safePath(projectRoot, args.path as string);
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const content = args.content as string;
      fs.writeFileSync(p, content, "utf-8");
      const relPath = path.relative(projectRoot, p);
      return { written: relPath, bytes: Buffer.byteLength(content, "utf-8") };
    },
    "Write or update a project file",
    schemaFromParams([
      { name: "path", type: "string" },
      { name: "content", type: "string" },
    ]),
  );

  server.registerTool(
    "file_list",
    (args) => {
      const relPath = (args.path as string) || ".";
      const p = safePath(projectRoot, relPath);
      if (!fs.existsSync(p)) return { error: `Directory not found: ${relPath}` };
      const stat = fs.statSync(p);
      if (!stat.isDirectory()) return { error: `Not a directory: ${relPath}` };
      const entries = fs.readdirSync(p, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file",
          size: entry.isFile() ? fs.statSync(path.join(p, entry.name)).size : 0,
        }));
      return entries;
    },
    "List files in a directory",
    schemaFromParams([{ name: "path", type: "string", default: "." }]),
  );

  server.registerTool(
    "asset_upload",
    (args) => {
      const filename = args.filename as string;
      const content = args.content as string;
      const encoding = (args.encoding as string) || "utf-8";
      const target = safePath(projectRoot, `src/public/${filename}`);
      const dir = path.dirname(target);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (encoding === "base64") {
        fs.writeFileSync(target, Buffer.from(content, "base64"));
      } else {
        fs.writeFileSync(target, content, "utf-8");
      }
      const relPath = path.relative(projectRoot, target);
      return { uploaded: relPath, bytes: fs.statSync(target).size };
    },
    "Upload a file to src/public/",
    schemaFromParams([
      { name: "filename", type: "string" },
      { name: "content", type: "string" },
      { name: "encoding", type: "string", default: "utf-8" },
    ]),
  );

  // ── Migration Tools ─────────────────────────────────────────

  server.registerTool(
    "migration_status",
    (_args) => {
      try {
        const db = (globalThis as any).__tina4_db;
        if (!db) return { error: "No database connection" };
        return { info: "Migration status not yet implemented for Node.js" };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "List pending and completed migrations",
    schemaFromParams([]),
  );

  server.registerTool(
    "migration_create",
    (args) => {
      const desc = (args.description as string).replace(/\s+/g, "_").toLowerCase();
      const migrationsDir = path.join(projectRoot, "migrations");
      if (!fs.existsSync(migrationsDir)) {
        fs.mkdirSync(migrationsDir, { recursive: true });
      }
      const existing = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
      const nextNum = String(existing.length + 1).padStart(6, "0");
      const filename = `${nextNum}_${desc}.sql`;
      fs.writeFileSync(path.join(migrationsDir, filename), `-- Migration: ${args.description}\n`, "utf-8");
      return { created: filename };
    },
    "Create a new migration file",
    schemaFromParams([{ name: "description", type: "string" }]),
  );

  server.registerTool(
    "migration_run",
    (_args) => {
      try {
        const db = (globalThis as any).__tina4_db;
        if (!db) return { error: "No database connection" };
        return { info: "Migration run not yet implemented for Node.js" };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "Run all pending migrations",
    schemaFromParams([]),
  );

  // ── Queue Tools ─────────────────────────────────────────────

  server.registerTool(
    "queue_status",
    (args) => {
      try {
        const { Queue } = require("@tina4/core");
        const topic = (args.topic as string) || "default";
        const q = new Queue({ topic });
        return {
          topic,
          pending: q.size?.("pending") ?? 0,
          completed: q.size?.("completed") ?? 0,
          failed: q.size?.("failed") ?? 0,
        };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "Get queue size by status",
    schemaFromParams([{ name: "topic", type: "string", default: "default" }]),
  );

  // ── Session/Cache Tools ─────────────────────────────────────

  server.registerTool(
    "session_list",
    (_args) => {
      const sessionDir = path.join(projectRoot, "data", "sessions");
      if (!fs.existsSync(sessionDir)) return [];
      const sessions: { id: string; data?: unknown; error?: string }[] = [];
      const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(sessionDir, f), "utf-8"));
          sessions.push({ id: f.replace(".json", ""), data });
        } catch {
          sessions.push({ id: f.replace(".json", ""), error: "corrupt" });
        }
      }
      return sessions;
    },
    "List active sessions",
    schemaFromParams([]),
  );

  server.registerTool(
    "cache_stats",
    (_args) => {
      try {
        const { cacheStats } = require("@tina4/core");
        return cacheStats?.() ?? {};
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "Get response cache statistics",
    schemaFromParams([]),
  );

  // ── ORM Tools ───────────────────────────────────────────────

  server.registerTool(
    "orm_describe",
    (_args) => {
      try {
        const modelsDir = path.join(projectRoot, "src", "models");
        if (!fs.existsSync(modelsDir)) return [];
        const modelFiles = fs.readdirSync(modelsDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
        const models: Record<string, unknown>[] = [];
        for (const f of modelFiles) {
          models.push({ file: f, info: "Model inspection requires runtime import" });
        }
        return models;
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "List all ORM models with fields and types",
    schemaFromParams([]),
  );

  // ── Debugging Tools ─────────────────────────────────────────

  server.registerTool(
    "log_tail",
    (args) => {
      const lines = (args.lines as number) || 50;
      const logFile = path.join(projectRoot, "logs", "debug.log");
      if (!fs.existsSync(logFile)) return [];
      const allLines = fs.readFileSync(logFile, "utf-8").split("\n");
      return allLines.slice(-lines);
    },
    "Read recent log entries",
    schemaFromParams([{ name: "lines", type: "integer", default: 50 }]),
  );

  server.registerTool(
    "error_log",
    (args) => {
      try {
        const { DevAdmin } = require("@tina4/core");
        const tracker = DevAdmin?.errorTracker;
        if (tracker?.get) {
          return tracker.get(args.limit || 20);
        }
        return [];
      } catch {
        return [];
      }
    },
    "Recent errors and exceptions",
    schemaFromParams([{ name: "limit", type: "integer", default: 20 }]),
  );

  server.registerTool(
    "env_list",
    (_args) => {
      const result: Record<string, string> = {};
      const sorted = Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b));
      for (const [k, v] of sorted) {
        if (v !== undefined) {
          result[k] = redactEnv(k, v);
        }
      }
      return result;
    },
    "List environment variables (secrets redacted)",
    schemaFromParams([]),
  );

  // ── Data Tools ──────────────────────────────────────────────

  server.registerTool(
    "seed_table",
    (args) => {
      try {
        const { seedTable } = require("@tina4/orm");
        const db = (globalThis as any).__tina4_db;
        if (!db) return { error: "No database connection" };
        const count = (args.count as number) || 10;
        const inserted = seedTable?.(db, args.table as string, count) ?? 0;
        return { table: args.table, inserted };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "Seed a table with fake data",
    schemaFromParams([
      { name: "table", type: "string" },
      { name: "count", type: "integer", default: 10 },
    ]),
  );

  // ── System Tools ────────────────────────────────────────────

  server.registerTool(
    "system_info",
    (_args) => {
      let version = "unknown";
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
        version = pkg.version || "unknown";
      } catch {
        // ignore
      }
      return {
        framework: "tina4-nodejs",
        version,
        node: process.version,
        platform: `${os.type()} ${os.release()} ${os.arch()}`,
        cwd: projectRoot,
        debug: process.env.TINA4_DEBUG || "false",
      };
    },
    "Framework version, Node.js version, project info",
    schemaFromParams([]),
  );
}
