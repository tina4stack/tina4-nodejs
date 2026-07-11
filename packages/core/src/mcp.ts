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
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

// Synchronous CommonJS-style require that works under real ESM (where the
// bare `require` global is undefined). Dev-tool handlers are synchronous, so
// they can't `await import()` — this gives them a working require. Mirrors the
// pattern already used by the ORM adapters (mysql.ts, postgres.ts, etc.).
const req = createRequire(import.meta.url);

/**
 * Require a sibling @tina4 workspace package (orm / swagger / frond) in a way
 * that works whether we're running from source (monorepo, where the package's
 * `exports` only exposes the TS `import` condition that `require()` can't see)
 * or as an installed dependency (where the package name resolves directly).
 *
 * Tries the package name first; on failure falls back to the in-repo source
 * path relative to this file (packages/core/src → packages/<name>/src). This
 * is why `route_list`, `database_query`, `swagger_spec`, etc. work when a real
 * MCP client hits /__dev/mcp from a from-source dev server.
 */
function reqSibling(pkg: "orm" | "swagger" | "frond"): Record<string, unknown> {
  // Resolve the sibling package from its in-repo/installed SOURCE path. A bare
  // `@tina4/${pkg}` specifier does NOT resolve in a consumer install — the root
  // `tina4-nodejs` package is the only thing on disk, there is no `@tina4/*` in
  // node_modules (that was the #32 break) — so go straight to the relative src.
  // createRequire + tsx resolves the .ts here (synchronous dev-tool path); each
  // caller already wraps this in try/catch and degrades gracefully on failure.
  return req(`../../${pkg}/src/index.ts`) as Record<string, unknown>;
}

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
  // Handlers may be sync or async — the dispatch (`_handleToolsCall`) awaits the
  // return value, so DB tools that hit the async Database wrapper resolve before
  // the result is formatted. A sync handler's plain return passes through awaiting
  // unchanged.
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
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

// MCP protocol versions this server can speak, newest first. The 2025-* versions
// are the Streamable HTTP era; 2024-11-05 is the legacy HTTP+SSE transport we
// still accept for older clients (Claude Desktop et al.).
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

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

/**
 * Informational only — whether the CONFIGURED host looks local.
 *
 * NOT the security gate. Reads `TINA4_HOST_NAME` (the configured bind address),
 * which on a 0.0.0.0 bind looks "local" while still accepting remote clients.
 * Trust decisions use {@link isRequestAllowed} with the RAW socket peer instead.
 * Kept for diagnostics / back-compat.
 */
export function isLocalhost(): boolean {
  const hostEnv = process.env.TINA4_HOST_NAME || "localhost:7148";
  const host = hostEnv.split(":")[0];
  return ["localhost", "127.0.0.1", "0.0.0.0", "::1", ""].includes(host);
}

// ── MCP env config (Python parity) ───────────────────────────

/** Truthy check that mirrors `dotenv.isTruthy` without the import cycle. */
function envTruthy(val: string | undefined): boolean {
  if (val == null) return false;
  return ["true", "1", "yes", "on"].includes(val.trim().toLowerCase());
}

/**
 * Whether an address is a loopback (in-process / same-host) peer.
 *
 * Operates on the RAW socket peer, never X-Forwarded-For. Empty/undefined means
 * an in-process / synthetic request (no socket) and is trusted. The `::ffff:`
 * IPv4-mapped prefix is stripped. NOTE: 0.0.0.0 is a BIND address, never a
 * client address, so it is deliberately NOT loopback.
 *
 * Python master parity: tina4_python.mcp.is_loopback.
 */
export function isLoopback(ip: string | undefined | null): boolean {
  if (ip == null || ip === "") return true;
  let addr = ip.trim().toLowerCase();
  if (addr.startsWith("::ffff:")) addr = addr.slice(7);
  return addr === "::1" || addr === "localhost" || addr.startsWith("127.");
}

/**
 * Capability gate — whether MCP may run at all.
 *
 * Pure capability, host-INDEPENDENT (Python master parity):
 *   1. `TINA4_MCP` explicit on/off override (sysadmin, any host).
 *   2. Else `TINA4_DEBUG=true` → MCP is a capability of this deployment.
 *   3. Otherwise off.
 *
 * This NO LONGER consults the host. A debug box bound to 0.0.0.0 still "has"
 * the capability, but {@link isRequestAllowed} decides whether a given CALLER
 * may use it — loopback always, remote only with an explicit opt-in plus a
 * valid token. Splitting capability from per-request authorisation closes the
 * hole where a 0.0.0.0 bind auto-exposed DB/file tools to remote
 * unauthenticated callers (the pre-3.13.40 isLocalhost() treated 0.0.0.0 local).
 */
export function mcpEnabled(): boolean {
  const explicit = process.env.TINA4_MCP;
  if (explicit !== undefined && explicit.trim() !== "") {
    return envTruthy(explicit);
  }
  return envTruthy(process.env.TINA4_DEBUG);
}

/**
 * Per-request authorisation — whether THIS caller may use MCP.
 *
 * @param remoteIp        Raw socket peer (`req.socket.remoteAddress`), never XFF.
 * @param hasValidToken   True when the request carried a token matching TINA4_MCP_TOKEN.
 *
 * Rules (Python master parity, tina4_python.mcp.is_request_allowed):
 *   - Capability off ({@link mcpEnabled} false) → deny.
 *   - Loopback peer → allow.
 *   - Remote peer → only when TINA4_MCP_REMOTE is truthy AND a valid token was
 *     presented. No configured token ⇒ remote can never pass.
 */
export function isRequestAllowed(remoteIp: string | undefined | null, hasValidToken = false): boolean {
  if (!mcpEnabled()) return false;
  if (isLoopback(remoteIp)) return true;
  return envTruthy(process.env.TINA4_MCP_REMOTE) && hasValidToken;
}

/**
 * Resolve the MCP HTTP port. Default: HTTP server port + 2000.
 *
 * `TINA4_MCP_PORT` overrides directly. The `mainPort` argument is the
 * primary HTTP port (the framework passes `port` from `resolvePortAndHost`).
 */
export function mcpPort(mainPort: number = 7148): number {
  const raw = process.env.TINA4_MCP_PORT;
  if (raw && raw.trim() !== "") {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return mainPort + 2000;
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

  // Streamable HTTP session ids issued at initialize time -> creation ts. A
  // request bearing an unknown id gets a 404 so the client re-initializes.
  private _sessions: Map<string, number> = new Map();
  // Open legacy HTTP+SSE streams keyed by session id. GET /sse registers a
  // channel; POST /message pushes each JSON-RPC response onto it so it streams
  // back on the open connection (the 2024-11-05 transport). Node is single-
  // threaded, so this in-process map is the whole coordination mechanism.
  private _sseChannels: Map<string, { buffer: string[]; wake: (() => void) | null }> = new Map();

  constructor(mcpPath: string, name = "Tina4 MCP", version = "1.0.0") {
    this.path = mcpPath.replace(/\/+$/, "");
    this.name = name;
    this.version = version;
    McpServer._instances.push(this);
  }

  // ── Session lifecycle + protocol negotiation ──────────────────

  /** Mint a new session id and remember it. Called on `initialize`. */
  openSession(): string {
    const sid = randomBytes(16).toString("hex");
    this._sessions.set(sid, Date.now());
    return sid;
  }

  /** True when `sessionId` was issued by this server and is still open. */
  isValidSession(sessionId: string | undefined | null): boolean {
    return !!sessionId && this._sessions.has(sessionId);
  }

  /** Forget a session (client DELETE or SSE stream close). */
  closeSession(sessionId: string | undefined | null): boolean {
    return sessionId ? this._sessions.delete(sessionId) : false;
  }

  /**
   * Pick the protocol version to run on. Echo the client's requested version
   * when we support it (proper negotiation), else fall back to the newest we
   * speak so an unversioned/old client still connects.
   */
  negotiateProtocolVersion(requested: string | undefined | null): string {
    return requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
  }

  private _peekMethod(raw: string | Record<string, unknown>): string | null {
    try {
      const obj = typeof raw === "object" && raw !== null ? raw : JSON.parse(String(raw || "{}"));
      return obj && typeof obj === "object" ? ((obj as Record<string, unknown>).method as string) ?? null : null;
    } catch {
      return null;
    }
  }

  // ── Streamable HTTP transport (transport-agnostic, mirrors Python) ──

  /**
   * Streamable HTTP POST handler. initialize mints a session id (returned in
   * the Mcp-Session-Id response header); a non-initialize request with an
   * unknown session id is a 404 (client re-inits); a notification is 202; else
   * 200 with the JSON-RPC response as application/json (which the spec permits
   * for a POST that resolves to a single response).
   */
  async dispatchHttp(
    raw: string | Record<string, unknown>,
    sessionId = "",
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const isInit = this._peekMethod(raw) === "initialize";
    if (!isInit && sessionId && !this.isValidSession(sessionId)) {
      return { status: 404, headers: {}, body: encodeError(null, INVALID_REQUEST, "session not found") };
    }
    const body = await this.handleMessage(raw);
    const headers: Record<string, string> = {};
    if (isInit) headers["Mcp-Session-Id"] = this.openSession();
    if (!body) return { status: 202, headers, body: "" };
    return { status: 200, headers, body };
  }

  /**
   * Legacy HTTP+SSE POST /message handler. When a live SSE stream is open for
   * `sessionId`, run the message and push the response down that stream (202
   * here); with no open stream it degrades to an inline Streamable HTTP
   * response, so the same path serves a legacy SSE client and a plain POST.
   */
  async dispatchSseMessage(
    raw: string | Record<string, unknown>,
    sessionId = "",
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const channel = sessionId ? this._sseChannels.get(sessionId) : undefined;
    if (!channel) return this.dispatchHttp(raw, sessionId);
    const body = await this.handleMessage(raw);
    if (body) {
      channel.buffer.push(body);
      if (channel.wake) {
        const wake = channel.wake;
        channel.wake = null;
        wake();
      }
    }
    return { status: 202, headers: {}, body: "" };
  }

  /**
   * Async generator of SSE frames for the legacy HTTP+SSE transport. Emits the
   * `endpoint` event first (naming the POST target), then each queued JSON-RPC
   * response as it arrives, with periodic keep-alive comments. Registers the
   * per-session channel up front and tears it down (plus the session) when the
   * client disconnects and the generator is closed.
   */
  async *sseStream(sessionId: string, endpointUrl: string, keepaliveMs = 15000): AsyncGenerator<string> {
    const channel: { buffer: string[]; wake: (() => void) | null } = { buffer: [], wake: null };
    this._sseChannels.set(sessionId, channel);
    try {
      yield `event: endpoint\ndata: ${endpointUrl}\n\n`;
      for (;;) {
        if (channel.buffer.length > 0) {
          yield `event: message\ndata: ${channel.buffer.shift()}\n\n`;
          continue;
        }
        const gotMessage = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            channel.wake = null;
            resolve(false);
          }, keepaliveMs);
          channel.wake = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
        if (!gotMessage) yield `: keep-alive\n\n`;
      }
    } finally {
      this._sseChannels.delete(sessionId);
      this.closeSession(sessionId);
    }
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

  // Async since the DB dev-tool handlers (database_query/execute/tables/columns,
  // migration_*, seed_table, project_overview) reach the Database wrapper on
  // `globalThis.__tina4_db`, whose read/write methods are async. The handler is
  // awaited below; sync handlers (the file/plan/route tools) are unaffected
  // because awaiting a non-Promise resolves immediately. Returns a
  // Promise<string> — every caller must await it.
  async handleMessage(rawData: string | Record<string, unknown>): Promise<string> {
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
      const result = await handler(params);
      if (requestId === null) {
        return ""; // Notification — no response
      }
      return encodeResponse(requestId, result);
    } catch (e) {
      return encodeError(requestId, INTERNAL_ERROR, (e as Error).message);
    }
  }

  private _handleInitialize(params: Record<string, unknown>): Record<string, unknown> {
    this._initialized = true;
    const requested = params ? (params.protocolVersion as string | undefined) : undefined;
    return {
      protocolVersion: this.negotiateProtocolVersion(requested),
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

  private async _handleToolsCall(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const toolName = params.name as string | undefined;
    if (!toolName) {
      throw new Error("Missing tool name");
    }

    const tool = this._tools.get(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    const args = (params.arguments as Record<string, unknown>) || {};
    // Tool handlers may be async (the DB tools await the Database wrapper); a
    // sync handler's plain return value passes through `await` unchanged.
    const result = await tool.handler(args);

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

  /** Coerce a route handler's parsed body into what the dispatchers accept. */
  private _normalizeBody(body: unknown): string | Record<string, unknown> {
    if (typeof body === "object" && body !== null) return body as Record<string, unknown>;
    if (typeof body === "string") return body;
    return String(body ?? "");
  }

  /**
   * Register HTTP routes for this MCP server on the Tina4 router. Mounts both
   * supported transports on `path`:
   *   POST {path}          — Streamable HTTP (current transport)
   *   POST {path}/message  — legacy HTTP+SSE message sink (+ inline fallback)
   *   GET  {path}/sse      — legacy HTTP+SSE stream (persistent)
   *
   * A Streamable HTTP client (Claude Code `--transport http`) POSTs to `{path}`
   * and reads the JSON-RPC response inline, with an Mcp-Session-Id header on
   * initialize. A legacy SSE client GETs `{path}/sse`, gets the endpoint event,
   * and its responses stream back on that connection.
   */
  registerRoutes(router: {
    post: (pattern: string, handler: (req: unknown, res: unknown) => unknown) => { noAuth: () => unknown };
    get: (pattern: string, handler: (req: unknown, res: unknown) => unknown) => { noAuth: () => unknown };
  }): void {
    const server = this;
    type Resp = ((data: unknown, status?: number, contentType?: string) => unknown) & {
      addHeader?: (name: string, value: string) => unknown;
      stream?: (source: AsyncIterable<string>, contentType?: string) => unknown;
    };
    const session = (req: { headers?: Record<string, string> }): string =>
      (req.headers?.["mcp-session-id"] as string) || "";
    const apply = (response: Resp, outcome: { status: number; headers: Record<string, string>; body: string }) => {
      for (const [n, v] of Object.entries(outcome.headers)) response.addHeader?.(n, v);
      if (!outcome.body) return response("", outcome.status);
      return response(JSON.parse(outcome.body), outcome.status);
    };

    router
      .post(this.path, async (req: unknown, res: unknown) => {
        const request = req as { body: unknown; headers?: Record<string, string> };
        return apply(res as Resp, await server.dispatchHttp(server._normalizeBody(request.body), session(request)));
      })
      .noAuth();

    router
      .post(`${this.path}/message`, async (req: unknown, res: unknown) => {
        const request = req as { body: unknown; headers?: Record<string, string>; query?: Record<string, string> };
        const sessionId = (request.query?.sessionId as string) || session(request);
        return apply(res as Resp, await server.dispatchSseMessage(server._normalizeBody(request.body), sessionId));
      })
      .noAuth();

    router
      .get(`${this.path}/sse`, (req: unknown, res: unknown) => {
        const request = req as { path?: string };
        const response = res as Resp;
        const sessionId = server.openSession();
        const base = (request.path || `${server.path}/sse`).replace(/\/sse$/, "");
        return response.stream!(server.sseStream(sessionId, `${base}/message?sessionId=${sessionId}`));
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
      type: "http",
      url: `http://localhost:${port}${this.path}`,
    };

    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", "utf-8");
  }
}

// ── Decorator API ──────────────────────────────────────────────

let _defaultServer: McpServer | null = null;
let _defaultToolsRegistered = false;

function _getDefaultServer(): McpServer {
  if (_defaultServer === null) {
    _defaultServer = new McpServer("/__dev/mcp", "Tina4 Dev Tools");
  }
  return _defaultServer;
}

/**
 * The default `/__dev/mcp` MCP server with the built-in dev tools registered.
 *
 * This is the single shared instance backing BOTH the browser REST shim
 * (`/__dev/api/mcp/tools` + `/__dev/api/mcp/call`) and the JSON-RPC + SSE
 * endpoints (`/__dev/mcp[/message]` + `/__dev/mcp/sse`) that real MCP clients
 * (Claude Code/Desktop) speak. Tools are registered exactly once (idempotent).
 * Mirrors Python's default MCP server used by `get_api_handlers()`.
 */
export function getDefaultDevServer(): McpServer {
  const server = _getDefaultServer();
  if (!_defaultToolsRegistered) {
    registerDevTools(server);
    _defaultToolsRegistered = true;
  }
  return server;
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
  // Compare against root + separator, not a bare prefix: a plain
  // startsWith(projectRoot) also accepts a sibling like "<root>-evil".
  // path.resolve collapses ".." so a climb-out lands outside root.
  const rootPrefix = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
  if (resolved !== projectRoot && !resolved.startsWith(rootPrefix)) {
    throw new Error(`Path escapes project directory: ${relPath}`);
  }
  // Belt-and-braces against symlink escapes: if the path exists, canonicalise
  // it and re-check containment. A symlink inside the tree pointing outside
  // would otherwise slip past the textual check. New paths (parent not yet
  // created) have no realpath and rely on the resolve() containment above.
  let real: string | null = null;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    real = null; // not created yet — textual guard above holds
  }
  if (real !== null) {
    const realRoot = fs.realpathSync(projectRoot);
    const realPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (real !== realRoot && !real.startsWith(realPrefix)) {
      throw new Error(`Path escapes project directory: ${relPath}`);
    }
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

// ── Defensive write helpers (mirrors tina4-python tools.py) ──
//
// Five layered guards wrap `file_write` and `file_patch`:
//   1. agentLog — structured audit log at .tina4/agent.log + stderr
//   2. looksLikeProse — reject sentences-as-filenames (AI mishap)
//   3. normalizeCoderPath — rewrite bare routes/, orm/, ... to src/<dir>/
//   4. agentBackup — copy pre-write content to .tina4/backups/
//   5. truncation guard (inline in file_write) — refuse suspicious shrinkage

/**
 * Append a structured line to `.tina4/agent.log` AND echo to stderr.
 * Cheap — never blocks the caller on I/O failure.
 */
function agentLog(projectRoot: string, category: string, message: string): void {
  try {
    const logDir = path.join(projectRoot, ".tina4");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logPath = path.join(logDir, "agent.log");
    const ts = new Date().toISOString().replace(/\..+/, "Z");
    fs.appendFileSync(logPath, `${ts} [${category}] ${message}\n`, "utf-8");
  } catch {
    // logging must never fail the actual call
  }
  process.stderr.write(`  [agent ${category}] ${message}\n`);
}

const SANE_PATH_SEGMENT = /^[A-Za-z0-9._\-]+$/;

/**
 * Return an error string if the path looks like prose, else null.
 * AI agents sometimes pass natural language as `path` to file_write
 * and produce folders with prose names — catch the slip here.
 */
function looksLikeProse(relPath: string): string | null {
  if (!relPath || !relPath.trim()) {
    return "path is empty";
  }
  if (relPath.length > 300) {
    return `path too long (${relPath.length} chars); use a real filename`;
  }
  const badSequences = ["`", "\n", "\t", "  ", " — ", " (", " [", "?", "*", "<", ">", "|"];
  for (const bad of badSequences) {
    if (relPath.includes(bad)) {
      return `path contains illegal character sequence ${JSON.stringify(bad)} — looks like prose, not a filename`;
    }
  }
  for (const seg of relPath.split("/")) {
    if (!seg || seg === "." || seg === "..") {
      continue;
    }
    if (seg.length > 80) {
      return `path segment too long: ${JSON.stringify(seg.slice(0, 60))}… — use a short filename`;
    }
    if (!SANE_PATH_SEGMENT.test(seg)) {
      return `path segment ${JSON.stringify(seg)} contains disallowed characters — stick to [A-Za-z0-9._-]`;
    }
  }
  return null;
}

/**
 * Rewrite bare top-level Tina4-conventional directories into their
 * `src/<dir>/` canonical form. The framework's auto-discovery only
 * scans `src/`, so a file at `templates/foo.twig` is dead weight —
 * the framework never loads it. Mirrors Python's _normalize_coder_path.
 */
function normalizeCoderPath(projectRoot: string, relPath: string): string {
  const passthroughPrefixes = ["src/", "migrations/", "plan/", "tests/", "test/", ".tina4/"];
  const passthroughFiles = new Set([
    "app.py", "app.ts", "app.rb", "index.php",
    "composer.json", "package.json", "Gemfile",
    "pyproject.toml", "requirements.txt",
    ".env", ".env.example",
  ]);
  if (passthroughPrefixes.some((p) => relPath.startsWith(p))) {
    return relPath;
  }
  if (passthroughFiles.has(relPath)) {
    return relPath;
  }
  const bareDirs = ["routes", "orm", "templates", "seeds", "controllers", "models", "middleware"];
  for (const d of bareDirs) {
    if (relPath.startsWith(`${d}/`)) {
      const rewritten = `src/${relPath}`;
      agentLog(projectRoot, "write.path_normalized", `${relPath} → ${rewritten}`);
      return rewritten;
    }
  }
  return relPath;
}

/**
 * Copy `target` into `.tina4/backups/` with a timestamped name.
 * Returns the relative backup path on success, null on failure.
 */
function agentBackup(projectRoot: string, target: string): string | null {
  try {
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return null;
    }
    const backupDir = path.join(projectRoot, ".tina4", "backups");
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    let rel = path.relative(projectRoot, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      rel = path.basename(target);
    }
    const safe = rel.replace(/[/\\]/g, "__");
    const ts = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "Z");
    const backupName = `${safe}.${ts}.bak`;
    const backupPath = path.join(backupDir, backupName);
    fs.writeFileSync(backupPath, fs.readFileSync(target));
    return `.tina4/backups/${backupName}`;
  } catch (e) {
    agentLog(projectRoot, "write.backup_failed", `${target}: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Try syntax-checking a freshly-written JS/TS module to catch
 * hallucinated framework APIs and broken syntax BEFORE the next
 * request hits the broken handler. Mirrors Python's _verify_python_import.
 *
 * Returns null on success, or the captured error string on failure.
 *
 * - Only checks files under `src/` with extensions .js / .ts / .mjs / .cjs.
 * - Skips test files (*.test.{ts,js}, *.spec.{ts,js}) — they have their
 *   own loading patterns and would fail single-file type checking.
 * - .js / .mjs / .cjs → `node --check <file>` (fast, exit 0 = OK).
 * - .ts → `npx --no-install tsc --noEmit --allowJs --skipLibCheck <file>`.
 *   If tsc isn't available locally, returns null (don't block the write).
 * - Uses spawnSync with 5-second timeout so a hung subprocess never
 *   blocks the MCP server.
 */
function verifyNodeSyntax(absPath: string, relPath: string): string | null {
  if (!relPath.startsWith("src/")) {
    return null;
  }
  const ext = path.extname(relPath).toLowerCase();
  if (![".js", ".ts", ".mjs", ".cjs"].includes(ext)) {
    return null;
  }
  const base = path.basename(relPath);
  if (/\.(test|spec)\.(ts|js|mjs|cjs)$/.test(base)) {
    return null;
  }

  let cmd: string;
  let args: string[];
  if (ext === ".ts") {
    cmd = "npx";
    args = ["--no-install", "tsc", "--noEmit", "--allowJs", "--skipLibCheck", absPath];
  } else {
    cmd = "node";
    args = ["--check", absPath];
  }

  let proc;
  try {
    proc = spawnSync(cmd, args, {
      encoding: "utf-8",
      timeout: 5000,
      cwd: path.dirname(path.dirname(absPath)),
    });
  } catch (e) {
    return `verification subprocess failed: ${(e as Error).message}`;
  }

  // npx may fail to find tsc — gracefully return null instead of blocking.
  if (ext === ".ts" && (proc.error || proc.status === null || proc.status === 127)) {
    return null;
  }
  if (proc.error) {
    return `verification subprocess failed: ${proc.error.message}`;
  }
  if (proc.status === 0) {
    return null;
  }

  // Errors land on stderr for `node --check`, stdout for tsc.
  const raw = (ext === ".ts" ? (proc.stdout || "") + (proc.stderr || "") : (proc.stderr || "") + (proc.stdout || "")).trim();
  // npx placeholder when tsc isn't installed locally — bail silently
  // rather than block the write with a meaningless banner.
  if (ext === ".ts" && raw.includes("This is not the tsc command")) {
    return null;
  }
  if (!raw) {
    return `syntax check failed (exit ${proc.status}, no output)`;
  }
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return `syntax check failed (exit ${proc.status})`;
  }
  // Strip the absolute path prefix from the first meaningful line so the
  // LLM sees a stable, project-relative error message.
  const stripPath = (line: string): string => line.replace(absPath, relPath);
  // For tsc: the first line is usually "src/foo.ts(3,5): error TS1109: ...".
  // For node --check: the first line is the file path; the actual error is
  // a later "SyntaxError: ..." line. Pick the most informative line.
  for (const line of lines) {
    if (/error|SyntaxError|TS\d+/i.test(line)) {
      return stripPath(line);
    }
  }
  return stripPath(lines[0]);
}

/** Latest resolved KV cache stats snapshot (the async API resolves into this). */
let _lastCacheStats: Record<string, unknown> | null = null;

/**
 * Register all built-in dev tools on the given McpServer (the api_* reflection
 * tools plus code_search, the fuzzy FTS grounding tool).
 */
export function registerDevTools(server: McpServer): void {
  const projectRoot = path.resolve(process.cwd());

  // ── Database Tools ──────────────────────────────────────────

  server.registerTool(
    "database_query",
    async (args) => {
      try {
        const db = (globalThis as any).__tina4_db;
        if (!db) return { error: "No database connection" };
        let params = typeof args.params === "string" ? JSON.parse(args.params as string) : (args.params || []);
        if (!Array.isArray(params)) params = [];
        // Defense-in-depth: this tool is read-only. Strip comments, reject
        // multiple statements, and require a leading SELECT/WITH so it can never
        // mutate data even if reached (database_execute is the write surface,
        // gated separately). Mirrors the Python master.
        const cleaned = (args.sql as string)
          .replace(/--[^\r\n]*/g, " ")
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .trim()
          .replace(/[;\s]+$/, "");
        if (cleaned.includes(";")) return { error: "database_query rejects multiple statements" };
        if (!/^(select|with)\b/i.test(cleaned)) {
          return { error: "database_query is read-only (SELECT/WITH only)" };
        }
        const result = await db.fetch(cleaned, params);
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
    async (args) => {
      try {
        const db = (globalThis as any).__tina4_db;
        if (!db) return { error: "No database connection" };
        const params = typeof args.params === "string" ? JSON.parse(args.params as string) : (args.params || []);
        const result = await db.execute(args.sql as string, params);
        await db.commit?.();
        return { success: true, affected_rows: (result as any)?.count ?? 0 };
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
    async (_args) => {
      try {
        const db = (globalThis as any).__tina4_db;
        if (!db) return { error: "No database connection" };
        return (await db.getTables?.()) ?? [];
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "List all database tables",
    schemaFromParams([]),
  );

  server.registerTool(
    "database_columns",
    async (args) => {
      try {
        const db = (globalThis as any).__tina4_db;
        if (!db) return { error: "No database connection" };
        // Constrain the table name to a safe identifier (optionally
        // schema-qualified) — defense-in-depth so it can never be abused for
        // injection even if an adapter interpolates it. Parity with Python/PHP.
        const table = String(args.table ?? "");
        if (!/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/.test(table)) {
          return { error: "Invalid table name" };
        }
        return (await db.getColumns?.(table)) ?? [];
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
        // Prefer the active server router (set by startServer) so file-discovered
        // routes are included; startServer builds a fresh Router rather than using
        // defaultRouter. Fall back to defaultRouter when no server is running.
        // route_list lives inside @tina4/core, so reach the router via the local
        // module — req("@tina4/core") depends on a built dist/ and fails under a
        // from-source ESM runtime (the real MCP-client code path).
        const { defaultRouter } = req("./router.js") as typeof import("./router.js");
        const activeRouter = (globalThis as any).__tina4_router;
        const router = activeRouter ?? defaultRouter;
        const routes = router?.listRoutes?.() ?? [];
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
        const { generate } = reqSibling("swagger") as { generate?: (routes: unknown[], models?: unknown) => unknown };
        const { defaultRouter } = req("./router.js") as typeof import("./router.js");
        const routes = defaultRouter?.getRoutes?.() ?? [];
        return generate?.(routes, []) ?? { info: "Swagger not available" };
      } catch (e) {
        return { error: (e as Error).message };
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
        const { Frond } = reqSibling("frond") as { Frond?: new (dir?: string) => { renderString: (s: string, d?: Record<string, unknown>) => string } };
        if (!Frond) return "Template engine not available";
        const data = typeof args.data === "string" ? JSON.parse(args.data as string) : (args.data || {});
        const frond = new Frond(path.join(projectRoot, "src", "templates"));
        return frond.renderString(args.template as string, data as Record<string, unknown>);
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
      let rawPath = (args.path as string) || "";
      // 1. Prose check first — before path resolution.
      const proseErr = looksLikeProse(rawPath);
      if (proseErr) {
        return { error: `Invalid path ${JSON.stringify(rawPath)}: ${proseErr}` };
      }
      // 2. Coder-path normalization — rewrite bare top-level
      //    Tina4 dirs (templates/, routes/, ...) into src/.
      rawPath = normalizeCoderPath(projectRoot, rawPath);
      // 3. Safe path resolution (sandbox check — throws on escape).
      const p = safePath(projectRoot, rawPath);
      // 4. Compute old/new sizes for truncation guard + audit log.
      const oldBytes = fs.existsSync(p) && fs.statSync(p).isFile()
        ? fs.readFileSync(p)
        : Buffer.alloc(0);
      const oldSize = oldBytes.length;
      const oldLines = (oldBytes.toString("utf-8").match(/\n/g) || []).length;
      const content = args.content as string;
      const newBytes = Buffer.from(content, "utf-8");
      const newSize = newBytes.length;
      const newLines = (content.match(/\n/g) || []).length;
      const relPath = path.relative(projectRoot, p);

      // 5. Truncation guard — refuse suspicious shrinkage on non-trivial files.
      if (oldSize > 200 && newSize * 100 < oldSize * 30) {
        const msg = `REFUSED ${relPath} (would shrink ${oldSize} → ${newSize} bytes / ` +
          `${oldLines} → ${newLines} lines, looks truncated)`;
        agentLog(projectRoot, "write.refused", msg);
        return { error: msg, refused: true, old_bytes: oldSize, new_bytes: newSize };
      }

      // 6. Backup before overwrite.
      const backupRel = oldSize > 0 ? agentBackup(projectRoot, p) : null;

      // 7. Write.
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(p, content, "utf-8");

      agentLog(projectRoot, "write.ok",
        `${relPath} (${oldSize}B/${oldLines}L → ${newSize}B/${newLines}L, ` +
        `backup: ${backupRel || "(no prior file)"})`);

      const result: Record<string, unknown> = { written: relPath, bytes: newSize };
      if (backupRel) {
        result.backup = backupRel;
      }
      // 8. Post-write syntax verification — catch broken JS/TS inline
      //    so the LLM sees the error on its next turn.
      const importErr = verifyNodeSyntax(p, relPath);
      if (importErr) {
        result.import_error = importErr;
        agentLog(projectRoot, "write.import_failed", `${relPath}: ${importErr}`);
      }
      return result;
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
    async (_args) => {
      try {
        const db = (globalThis as any).__tina4_db;
        if (!db) return { error: "No database connection" };
        // Use the real migration API (parity with the Python master, whose MCP
        // migration_status calls MigrationRunner(db).status()). Previously a stub.
        // Load orm via dynamic ESM import (the same mechanism server.ts uses for
        // autoMigrateOnStartup) — reqSibling()'s createRequire fails here because
        // @tina4/orm imports @tina4/core (no CJS "exports" main).
        const orm = await import("../../orm/src/index.js");
        if (typeof orm.status !== "function") {
          return { error: "Migration API not available (install @tina4/orm)" };
        }
        const st = await orm.status(db, { migrationsDir: path.join(projectRoot, "migrations") });
        return { completed: st.completed, pending: st.pending };
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
    async (_args) => {
      try {
        const db = (globalThis as any).__tina4_db;
        if (!db) return { error: "No database connection" };
        // Run pending migrations for real (parity with the Python master's MCP
        // migration_run -> Migration(db).migrate()). Previously a stub. Load orm
        // via dynamic ESM import (server.ts's mechanism); reqSibling's createRequire
        // fails because @tina4/orm imports @tina4/core.
        const orm = await import("../../orm/src/index.js");
        if (typeof orm.migrate !== "function") {
          return { error: "Migration API not available (install @tina4/orm)" };
        }
        const result = await orm.migrate(db, { migrationsDir: path.join(projectRoot, "migrations") });
        return { applied: result.applied, skipped: result.skipped, failed: result.failed };
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
        const { Queue } = req("./queue.js") as typeof import("./queue.js");
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
      // The KV cache API is async on Node (cacheStats() returns a Promise) and
      // the MCP dispatch is synchronous, so we resolve the stats and return the
      // latest snapshot once available. The very first call may report the
      // pending placeholder; subsequent calls return live figures.
      try {
        const mod = req("./cache.js") as typeof import("./cache.js");
        const stats = mod.cacheStats?.();
        if (stats && typeof stats.then === "function") {
          stats.then((s: unknown) => { _lastCacheStats = s as Record<string, unknown>; }).catch(() => {});
          return _lastCacheStats ?? { hits: 0, misses: 0, size: 0, backend: "pending" };
        }
        return stats ?? {};
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
        const { ErrorTracker } = req("./devAdmin.js") as typeof import("./devAdmin.js");
        const limit = (args.limit as number) || 20;
        return ErrorTracker.get().slice(0, limit);
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
    async (args) => {
      try {
        const { seedTable } = reqSibling("orm") as { seedTable?: (db: unknown, table: string, count: number) => number | Promise<number> };
        const db = (globalThis as any).__tina4_db;
        if (!db) return { error: "No database connection" };
        const count = (args.count as number) || 10;
        const inserted = (await seedTable?.(db, args.table as string, count)) ?? 0;
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

  // ── Plan tools ──────────────────────────────────────────────
  //
  // Ported from Python's tina4_python.mcp.tools — names match exactly.
  // The Plan storage format is byte-for-byte compatible across frameworks.

  const loadPlan = () => req("./plan.js").Plan as typeof import("./plan.js").Plan;
  const loadIndex = () =>
    req("./projectIndex.js").ProjectIndex as typeof import("./projectIndex.js").ProjectIndex;

  server.registerTool(
    "plan_current",
    () => loadPlan().current(),
    "The active plan: title, steps (done/not), next step, progress",
    schemaFromParams([]),
  );

  server.registerTool(
    "plan_list",
    () => loadPlan().listPlans(),
    "All plans in plan/ with progress and which one is active",
    schemaFromParams([]),
  );

  server.registerTool(
    "plan_create",
    (args) =>
      loadPlan().create(
        (args.title as string) || "",
        (args.goal as string) || "",
        (args.steps as string[]) || [],
        args.make_current !== false,
      ),
    "Create a new markdown plan in plan/ and make it active",
    schemaFromParams([
      { name: "title", type: "string" },
      { name: "goal", type: "string", default: "" },
      { name: "steps", type: "array", default: [] },
      { name: "make_current", type: "boolean", default: true },
    ]),
  );

  server.registerTool(
    "plan_switch_to",
    (args) => loadPlan().setCurrent((args.name as string) || ""),
    "Make a different plan the active one",
    schemaFromParams([{ name: "name", type: "string" }]),
  );

  server.registerTool(
    "plan_complete_step",
    (args) => loadPlan().completeStep((args.index as number) ?? -1),
    "Tick a step as done (call the moment the step finishes)",
    schemaFromParams([{ name: "index", type: "integer" }]),
  );

  server.registerTool(
    "plan_add_step",
    (args) => loadPlan().addStep((args.text as string) || ""),
    "Append a new unchecked step to the current plan",
    schemaFromParams([{ name: "text", type: "string" }]),
  );

  server.registerTool(
    "plan_note",
    (args) => loadPlan().appendNote((args.text as string) || ""),
    "Append a timestamped note/breadcrumb to the current plan",
    schemaFromParams([{ name: "text", type: "string" }]),
  );

  server.registerTool(
    "plan_archive",
    (args) => loadPlan().archive((args.name as string) || ""),
    "Move a finished plan to plan/done/ and clear the current pointer",
    schemaFromParams([{ name: "name", type: "string", default: "" }]),
  );

  server.registerTool(
    "plan_read",
    (args) => loadPlan().read((args.name as string) || ""),
    "Full structured view of any plan by filename",
    schemaFromParams([{ name: "name", type: "string" }]),
  );

  server.registerTool(
    "plan_flesh",
    async (args) =>
      await loadPlan().flesh((args.name as string) || "", (args.prompt as string) || ""),
    "Auto-generate concrete build steps via the AI backend and append them to an existing plan",
    schemaFromParams([
      { name: "name", type: "string", default: "" },
      { name: "prompt", type: "string", default: "" },
    ]),
  );

  // ── Project-index tools ─────────────────────────────────────

  server.registerTool(
    "index_rebuild",
    () => loadIndex().refresh(),
    "Refresh the persistent project index (lazy, mtime-based)",
    schemaFromParams([]),
  );

  server.registerTool(
    "index_search",
    (args) => loadIndex().search((args.query as string) || "", (args.limit as number) || 20),
    "Find files by path, symbol, route, or summary — use FIRST for 'where is X'",
    schemaFromParams([
      { name: "query", type: "string" },
      { name: "limit", type: "integer", default: 20 },
    ]),
  );

  server.registerTool(
    "index_file",
    (args) => loadIndex().fileEntry((args.path as string) || ""),
    "Full index entry for one file: symbols, routes, imports",
    schemaFromParams([{ name: "path", type: "string" }]),
  );

  server.registerTool(
    "index_overview",
    () => loadIndex().overview(),
    "Project shape: files by language, routes, models, recent edits",
    schemaFromParams([]),
  );

  server.registerTool(
    "project_overview",
    async () => {
      const out: Record<string, unknown> = {};
      try { out.index = loadIndex().overview(); } catch (e) { out.index = { error: (e as Error).message }; }
      try { out.plans = loadPlan().listPlans(); } catch (e) { out.plans = { error: (e as Error).message }; }
      try { out.current_plan = loadPlan().current(); } catch (e) { out.current_plan = { error: (e as Error).message }; }
      try {
        const db = (globalThis as any).__tina4_db;
        out.tables = (await db?.getTables?.()) ?? [];
      } catch (e) { out.tables = { error: (e as Error).message }; }
      return out;
    },
    "One-shot snapshot: index overview, plans, current plan, tables",
    schemaFromParams([]),
  );

  // ── file_patch (targeted edit) ──────────────────────────────

  server.registerTool(
    "file_patch",
    (args) => {
      try {
        let rel = (args.path as string) || "";
        const oldStr = (args.old_string as string) || "";
        const newStr = (args.new_string as string) || "";
        const count = (args.count as number) || 1;
        const projectRoot = path.resolve(process.cwd());

        // 1. Prose check first — before path resolution.
        const proseErr = looksLikeProse(rel);
        if (proseErr) {
          return { error: `Invalid path ${JSON.stringify(rel)}: ${proseErr}` };
        }
        // 2. Coder-path normalization.
        rel = normalizeCoderPath(projectRoot, rel);
        // 3. Safe path resolution (sandbox check).
        const resolved = path.resolve(projectRoot, rel);
        if (!resolved.startsWith(projectRoot)) {
          return { error: `Path escapes project directory: ${rel}` };
        }
        // 4. Existence check.
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
          return { error: `File not found: ${rel}` };
        }
        const original = fs.readFileSync(resolved, "utf-8");
        // 5. Match-count guard.
        let occurrences = 0;
        let idx = -1;
        while ((idx = original.indexOf(oldStr, idx + 1)) !== -1) occurrences++;
        if (occurrences === 0) return { error: `old_string not found in ${rel}` };
        if (occurrences !== count) {
          return {
            error:
              `old_string appears ${occurrences} times, expected ${count}. ` +
              "Expand old_string to make it unique, or set count explicitly.",
          };
        }
        let updated = original;
        for (let i = 0; i < count; i++) updated = updated.replace(oldStr, newStr);

        // 6. Backup before overwrite — same path as file_write so
        //    recovery is uniform regardless of which tool touched the file.
        const backupRel = agentBackup(projectRoot, resolved);

        // 7. Write.
        fs.writeFileSync(resolved, updated, "utf-8");
        try { loadPlan().recordAction("patched", rel); } catch { /* best-effort */ }

        const oldSize = Buffer.byteLength(original, "utf-8");
        const newSize = Buffer.byteLength(updated, "utf-8");
        agentLog(projectRoot, "patch.ok",
          `${rel} (replaced ${count}× old_string, ${oldSize}B → ${newSize}B, ` +
          `backup: ${backupRel || "(none)"})`);

        const result: Record<string, unknown> = {
          patched: rel,
          replacements: count,
          bytes: newSize,
        };
        if (backupRel) {
          result.backup = backupRel;
        }
        // 8. Post-patch syntax verification — same inline check as
        //    file_write so a hallucinated edit surfaces immediately.
        const importErr = verifyNodeSyntax(resolved, rel);
        if (importErr) {
          result.import_error = importErr;
          agentLog(projectRoot, "patch.import_failed", `${rel}: ${importErr}`);
        }
        return result;
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "Targeted edit: replace old_string with new_string in a file (must match exactly `count` times)",
    schemaFromParams([
      { name: "path", type: "string" },
      { name: "old_string", type: "string" },
      { name: "new_string", type: "string" },
      { name: "count", type: "integer", default: 1 },
    ]),
  );

  // ── docs_list / docs_search / docs_section ──────────────────

  const frameworkDocPaths = (): string[] => {
    const projectRoot = path.resolve(process.cwd());
    const candidates = [
      path.join(projectRoot, "CLAUDE.md"),
      path.join(projectRoot, "AGENTS.md"),
      path.join(projectRoot, "CONVENTIONS.md"),
      path.join(projectRoot, "README.md"),
    ];
    return candidates.filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  };

  server.registerTool(
    "docs_list",
    () => frameworkDocPaths().map((p) => ({ name: path.basename(p), bytes: fs.statSync(p).size })),
    "List framework documentation files available for lookup",
    schemaFromParams([]),
  );

  server.registerTool(
    "docs_search",
    (args) => {
      const query = (args.query as string) || "";
      const limit = (args.limit as number) || 5;
      const contextLines = (args.context_lines as number) || 4;
      if (!query || query.length < 2) return { error: "query must be at least 2 characters" };
      const needle = query.toLowerCase();
      const hits: Array<{ file: string; line: number; score: number; snippet: string }> = [];
      for (const p of frameworkDocPaths()) {
        let lines: string[];
        try { lines = fs.readFileSync(p, "utf-8").split(/\r?\n/); } catch { continue; }
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            const start = Math.max(0, i - contextLines);
            const end = Math.min(lines.length, i + contextLines + 1);
            const snippet = lines.slice(start, end).join("\n");
            let score = 1;
            if (lines[i].includes(query)) score += 1;
            if (lines[i].trimStart().startsWith("#")) score += 2;
            hits.push({ file: path.basename(p), line: i + 1, score, snippet });
          }
        }
      }
      hits.sort((a, b) => b.score - a.score);
      return hits.slice(0, Math.max(1, limit));
    },
    "Search Tina4 framework docs for a query string (use before guessing)",
    schemaFromParams([
      { name: "query", type: "string" },
      { name: "limit", type: "integer", default: 5 },
      { name: "context_lines", type: "integer", default: 4 },
    ]),
  );

  server.registerTool(
    "docs_section",
    (args) => {
      const file = (args.file as string) || "";
      const heading = (args.heading as string) || "";
      const match = frameworkDocPaths().find((p) => path.basename(p) === file);
      if (!match) return { error: `Unknown doc file: ${file}. Try docs_list() first.` };
      const lines = fs.readFileSync(match, "utf-8").split(/\r?\n/);
      const headingLc = heading.toLowerCase().trim();
      let start = -1;
      let startLevel = 0;
      for (let i = 0; i < lines.length; i++) {
        const stripped = lines[i].replace(/^\s+/, "");
        if (stripped.startsWith("#")) {
          const level = stripped.length - stripped.replace(/^#+/, "").length;
          const title = stripped.slice(level).trim().toLowerCase();
          if (title.includes(headingLc)) {
            start = i;
            startLevel = level;
            break;
          }
        }
      }
      if (start < 0) return { error: `Heading '${heading}' not found in ${file}` };
      let end = lines.length;
      for (let j = start + 1; j < lines.length; j++) {
        const stripped = lines[j].replace(/^\s+/, "");
        if (stripped.startsWith("#")) {
          const level = stripped.length - stripped.replace(/^#+/, "").length;
          if (level <= startLevel) { end = j; break; }
        }
      }
      return { file, heading: lines[start].trim(), body: lines.slice(start, end).join("\n") };
    },
    "Return a full markdown section from a framework doc file",
    schemaFromParams([
      { name: "file", type: "string" },
      { name: "heading", type: "string" },
    ]),
  );

  // ── git_status / deps_list ──────────────────────────────────

  server.registerTool(
    "git_status",
    () => {
      try {
        const { execFileSync } = req("node:child_process") as typeof import("node:child_process");
        const cwd = path.resolve(process.cwd());
        const run = (args: string[]): string => {
          return execFileSync("git", args, { cwd, timeout: 3000, encoding: "utf-8" }).toString().trim();
        };
        try {
          execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 3000 });
        } catch {
          return { error: "Not a git repository" };
        }
        return {
          branch: run(["branch", "--show-current"]),
          status: run(["status", "--porcelain"]).split(/\r?\n/).filter((l) => l),
          recent_commits: run(["log", "--oneline", "-5"]).split(/\r?\n/).filter((l) => l),
        };
      } catch (e) {
        return { error: `git unavailable: ${(e as Error).message}` };
      }
    },
    "Show git branch, modified/untracked files, recent commits",
    schemaFromParams([]),
  );

  server.registerTool(
    "deps_list",
    () => {
      const pkgPath = path.join(path.resolve(process.cwd()), "package.json");
      if (!fs.existsSync(pkgPath)) return { error: "No package.json at project root" };
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        return {
          name: pkg.name || "",
          version: pkg.version || "",
          engines: pkg.engines || {},
          dependencies: pkg.dependencies || {},
          devDependencies: pkg.devDependencies || {},
        };
      } catch (e) {
        return { error: `Failed to parse package.json: ${(e as Error).message}` };
      }
    },
    "List this project's declared Node.js dependencies",
    schemaFromParams([]),
  );

  // ── Live API RAG (Docs) — plan/v3/22-LIVE-API-RAG.md ──────────

  server.registerTool(
    "api_search",
    (args) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Docs } = req("./docs.js") as typeof import("./docs.js");
        return Docs.mcpSearch(
          (args.query as string) || "",
          parseInt(String(args.k ?? 5), 10) || 5,
          undefined,
          (args.source as string) || "all",
          Boolean(args.include_private),
        );
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "Search the live API index (framework + user code) for matching classes/methods",
    schemaFromParams([
      { name: "query", type: "string" },
      { name: "k", type: "integer", default: 5 },
      { name: "source", type: "string", default: "all" },
      { name: "include_private", type: "boolean", default: false },
    ]),
  );

  server.registerTool(
    "api_class",
    (args) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Docs } = req("./docs.js") as typeof import("./docs.js");
        const spec = Docs.mcpClass((args.name as string) || "");
        return spec ?? { error: `class not found: ${args.name}` };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "Return the full class spec (methods + properties) for a single class FQN",
    schemaFromParams([{ name: "name", type: "string" }]),
  );

  server.registerTool(
    "api_method",
    (args) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Docs } = req("./docs.js") as typeof import("./docs.js");
        // PHP names the param `class`, Python names it `class_` — Node.js MCP
        // accepts the raw `class` field from the JSON-RPC payload.
        const cls = (args.class as string) || (args.class_name as string) || "";
        const name = (args.name as string) || "";
        const spec = Docs.mcpMethod(cls, name);
        return spec ?? { error: `method not found: ${cls}.${name}` };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "Return the full spec for a single method (signature, file, line, visibility)",
    schemaFromParams([
      { name: "class", type: "string" },
      { name: "name", type: "string" },
    ]),
  );

  // ── Code/doc grounding (context subsystem) ──────────────────
  // Sibling of api_* but the DUAL of it: api_* is exact structural reflection
  // (class/method signatures); code_search is fuzzy/semantic FTS over the
  // project's own SOURCE + docs. Use code_search for "where/how is X done in
  // THIS codebase?" and api_* for "what's the signature of X?". Backed by a
  // zero-dependency node:sqlite FTS5 index at .tina4/context.db, held as a
  // PROCESS-WIDE shared Context (context.defaultContext) so the dev-reload hook
  // (handleReload) can keep the SAME index fresh on every file save.
  server.registerTool(
    "code_search",
    (args) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { defaultContext } = req("./context/index.js") as typeof import("./context/index.js");
        // Index src/ when present (falls back to the project root), mirroring
        // the Python master's _code_root().
        const srcDir = path.join(projectRoot, "src");
        const root = fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory() ? srcDir : projectRoot;
        const ctx = defaultContext(root, path.join(projectRoot, ".tina4", "context.db"));
        if (!ctx.available) {
          return { error: "SQLite FTS5 is not available in this Node build; code_search is disabled." };
        }
        if (args.rebuild) {
          ctx.reset();
          ctx.indexRoot(root);
        }
        const k = parseInt(String(args.k ?? 5), 10) || 5;
        return ctx.search((args.query as string) || "", k);
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    "Fuzzy/semantic search over THIS project's own source + docs (node:sqlite FTS5, zero-dep). " +
      "Ranks definitions above tests that merely mention a symbol. Use for 'where is X done here?'; " +
      "use api_* for exact signatures. Returns [{path, score, snippet}].",
    schemaFromParams([
      { name: "query", type: "string" },
      { name: "k", type: "integer", default: 5 },
      { name: "rebuild", type: "boolean", default: false },
    ]),
  );
}

/** Alias for registerDevTools — parity with PHP/Ruby/Python. */
export const register = registerDevTools;
