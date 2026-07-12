/**
 * Tina4 Dev Admin — Built-in development dashboard, zero dependencies.
 *
 * Auto-registered admin panel for development mode.
 * Provides API endpoints and a single-page UI at /__dev/ for:
 *   - Route inspector (all registered routes, methods)
 *   - Message log (tracked debug messages)
 *   - Request inspector (captured HTTP requests)
 *   - System info (Node.js version, V8, memory, uptime, platform)
 */

import { cpus as osCpus } from "node:os";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Router } from "./router.js";
import type { RouteHandler, Tina4Request } from "./types.js";
import { DevMailbox } from "./devMailbox.js";
import { isTruthy } from "./dotenv.js";
import { quickMetrics, fullAnalysis, fileDetail } from "./metrics.js";
import { registerFeedbackRoutes } from "./feedback.js";
import { getDefaultDevServer, mcpEnabled, isRequestAllowed } from "./mcp.js";
import { timingSafeEqual } from "node:crypto";

const cpuCount = osCpus().length;

// Read version from root package.json dynamically
const TINA4_VERSION = (() => {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Try root package.json first, then core package.json
    for (const rel of ["../../../package.json", "../../package.json"]) {
      const p = resolve(__dirname, rel);
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf-8"));
        if (pkg.version) return pkg.version;
      }
    }
  } catch {}
  return "0.0.0";
})();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LogEntry {
  id: string;
  timestamp: string;
  category: string;
  level: string;
  message: string;
  data?: unknown;
}

interface RequestEntry {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

interface RequestStats {
  total: number;
  avgMs: number;
  errors: number;
  slowestMs: number;
}

interface ErrorEntry {
  id: string;
  timestamp: string;
  message: string;
  stack?: string;
  resolved: boolean;
}

interface QueueJob {
  id: string;
  timestamp: string;
  name: string;
  status: "pending" | "completed" | "failed" | "reserved";
  payload?: unknown;
  result?: unknown;
  error?: string;
}

interface WsConnection {
  id: string;
  connectedAt: string;
  remoteAddress: string;
  path: string;
}

// ---------------------------------------------------------------------------
// MessageLog — In-memory message log for dev mode tracking
// ---------------------------------------------------------------------------

export class MessageLog {
  private static messages: LogEntry[] = [];
  private static maxMessages = 500;

  static log(category: string, level: string, message: string, data?: unknown): void {
    const entry: LogEntry = {
      id: `${Date.now()}_${this.messages.length}`,
      timestamp: new Date().toISOString(),
      category,
      level,
      message,
      data,
    };
    this.messages.push(entry);
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }

  static get(category?: string, limit = 100): LogEntry[] {
    let msgs = this.messages;
    if (category) {
      msgs = msgs.filter((m) => m.category === category);
    }
    return msgs.slice().reverse().slice(0, limit);
  }

  static clear(category?: string): void {
    if (category) {
      this.messages = this.messages.filter((m) => m.category !== category);
    } else {
      this.messages = [];
    }
  }

  static count(): Record<string, number> {
    const counts: Record<string, number> = { total: this.messages.length };
    for (const m of this.messages) {
      counts[m.category] = (counts[m.category] ?? 0) + 1;
    }
    return counts;
  }
}

// ---------------------------------------------------------------------------
// RequestInspector — Captures recent HTTP requests
// ---------------------------------------------------------------------------

export class RequestInspector {
  private static requests: RequestEntry[] = [];
  private static maxRequests = 200;

  static capture(method: string, path: string, status: number, duration: number): void {
    const entry: RequestEntry = {
      id: `${Date.now()}_${this.requests.length}`,
      timestamp: new Date().toISOString(),
      method,
      path,
      status,
      durationMs: Math.round(duration * 100) / 100,
    };
    this.requests.push(entry);
    if (this.requests.length > this.maxRequests) {
      this.requests = this.requests.slice(-this.maxRequests);
    }
  }

  static get(limit = 50): RequestEntry[] {
    return this.requests.slice().reverse().slice(0, limit);
  }

  static stats(): RequestStats {
    if (this.requests.length === 0) {
      return { total: 0, avgMs: 0, errors: 0, slowestMs: 0 };
    }
    const durations = this.requests.map((r) => r.durationMs);
    const errors = this.requests.filter((r) => r.status >= 400).length;
    return {
      total: this.requests.length,
      avgMs: Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 100) / 100,
      errors,
      slowestMs: Math.round(Math.max(...durations) * 100) / 100,
    };
  }

  static clear(): void {
    this.requests = [];
  }
}

// ---------------------------------------------------------------------------
// ErrorTracker — In-memory tracked errors for dev mode
// ---------------------------------------------------------------------------

export class ErrorTracker {
  private static errors: ErrorEntry[] = [];
  private static maxErrors = 200;
  private static registered = false;

  /**
   * Capture an error with dedup (matches PHP/Ruby/Python signature).
   * Duplicate errors (same message) increment count and update last_seen.
   */
  static capture(errorType: string, message: string, traceback = "", file = "", line = 0): void {
    const fingerprint = `${errorType}|${message}|${file}|${line}`;
    const existing = this.errors.find((e) => (e as any).fingerprint === fingerprint);
    const now = new Date().toISOString();

    if (existing) {
      (existing as any).count = ((existing as any).count || 1) + 1;
      (existing as any).last_seen = now;
      existing.resolved = false; // re-open resolved duplicates
    } else {
      this.errors.push({
        id: `err_${Date.now()}_${this.errors.length}`,
        timestamp: now,
        message,
        stack: traceback || undefined,
        resolved: false,
        ...({ fingerprint, error_type: errorType, file, line, count: 1, first_seen: now, last_seen: now } as any),
      });
      if (this.errors.length > this.maxErrors) {
        this.errors = this.errors.slice(-this.maxErrors);
      }
    }
  }

  /** Legacy alias for capture (backward compatibility). */
  static track(message: string, stack?: string): void {
    this.capture("Error", message, stack || "");
  }

  static get(): ErrorEntry[] {
    return this.errors.slice().reverse();
  }

  static resolve(id: string): boolean {
    const entry = this.errors.find((e) => e.id === id);
    if (entry) {
      entry.resolved = true;
      return true;
    }
    return false;
  }

  static clearResolved(): void {
    this.errors = this.errors.filter((e) => !e.resolved);
  }

  /** Remove ALL tracked errors. */
  static clearAll(): void {
    this.errors = [];
  }

  /** Health summary — are there unresolved errors? */
  static health(): { healthy: boolean; total: number; unresolved: number; resolved: number } {
    const total = this.errors.length;
    const resolved = this.errors.filter((e) => e.resolved).length;
    const unresolved = total - resolved;
    return { healthy: unresolved === 0, total, unresolved, resolved };
  }

  /** Count of unresolved errors. */
  static unresolvedCount(): number {
    return this.errors.filter((e) => !e.resolved).length;
  }

  /** Reset all state (for testing). */
  static reset(): void {
    this.errors = [];
    this.registered = false;
  }

  /**
   * Register global error handlers to feed the tracker.
   * Safe to call multiple times — only registers once.
   */
  static register(): void {
    if (this.registered) return;
    this.registered = true;

    process.on("uncaughtException", (err: Error) => {
      this.capture(
        err.constructor.name,
        err.message,
        err.stack || "",
      );
    });

    process.on("unhandledRejection", (reason: unknown) => {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      this.capture(
        err.constructor.name,
        err.message,
        err.stack || "",
      );
    });
  }
}

// ---------------------------------------------------------------------------
// DevMailboxStore — File-backed dev mailbox (delegates to DevMailbox)
// ---------------------------------------------------------------------------

export class DevMailboxStore {
  private static mailbox = new DevMailbox();

  static inbox(folder: string = "inbox", limit: number = 50, offset: number = 0) {
    return this.mailbox.inbox(limit, offset, folder);
  }

  static read(id: string) {
    return this.mailbox.read(id);
  }

  static seed(count = 5): void {
    this.mailbox.seed(count);
  }

  static clear(folder?: string): void {
    this.mailbox.clear(folder);
  }

  static unreadCount(): number {
    return this.mailbox.unreadCount();
  }

  static count(folder?: string): { inbox: number; outbox: number; total: number } {
    return this.mailbox.count(folder);
  }
}

// ---------------------------------------------------------------------------
// DevQueue — In-memory dev queue
// ---------------------------------------------------------------------------

export class DevQueue {
  private static jobs: QueueJob[] = [];

  static stats(): { pending: number; completed: number; failed: number; reserved: number; jobs: QueueJob[] } {
    const pending = this.jobs.filter((j) => j.status === "pending").length;
    const completed = this.jobs.filter((j) => j.status === "completed").length;
    const failed = this.jobs.filter((j) => j.status === "failed").length;
    const reserved = this.jobs.filter((j) => j.status === "reserved").length;
    return { pending, completed, failed, reserved, jobs: this.jobs.slice().reverse() };
  }

  static add(name: string, payload?: unknown): QueueJob {
    const job: QueueJob = {
      id: `job_${Date.now()}_${this.jobs.length}`,
      timestamp: new Date().toISOString(),
      name,
      status: "pending",
      payload,
    };
    this.jobs.push(job);
    return job;
  }

  static retryFailed(): number {
    let count = 0;
    for (const job of this.jobs) {
      if (job.status === "failed") {
        job.status = "pending";
        job.error = undefined;
        count++;
      }
    }
    return count;
  }

  static purgeCompleted(): number {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.status !== "completed");
    return before - this.jobs.length;
  }

  static replay(id: string): QueueJob | undefined {
    const job = this.jobs.find((j) => j.id === id);
    if (job) {
      const newJob = this.add(job.name, job.payload);
      return newJob;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// WsTracker — In-memory WebSocket connection tracker
// ---------------------------------------------------------------------------

export class WsTracker {
  private static connections: WsConnection[] = [];

  static add(remoteAddress: string, path: string): string {
    const conn: WsConnection = {
      id: `ws_${Date.now()}_${this.connections.length}`,
      connectedAt: new Date().toISOString(),
      remoteAddress,
      path,
    };
    this.connections.push(conn);
    return conn.id;
  }

  static remove(id: string): boolean {
    const idx = this.connections.findIndex((c) => c.id === id);
    if (idx >= 0) {
      this.connections.splice(idx, 1);
      return true;
    }
    return false;
  }

  static list(): WsConnection[] {
    return this.connections.slice();
  }
}

// ---------------------------------------------------------------------------
// DevAdmin — Registers /__dev routes on the router
// ---------------------------------------------------------------------------

export class DevAdmin {
  /**
   * Check whether dev mode is enabled.
   */
  static isEnabled(): boolean {
    return isTruthy(process.env.TINA4_DEBUG);
  }

  /**
   * Register all /__dev routes on the given router.
   */
  static register(router: Router): void {
    // Register error handlers to feed the ErrorTracker
    ErrorTracker.register();

    // Customer feedback widget routes — gated at request time by
    // TINA4_ENABLE_FEEDBACK + TINA4_FEEDBACK_WHITELIST. The handlers
    // themselves are always registered (so toggling env vars doesn't
    // require a server restart) but each request re-checks the gate.
    registerFeedbackRoutes(router);

    const routes: Array<{ method: string; pattern: string; handler: RouteHandler }> = [
      // Dashboard
      { method: "GET", pattern: "/__dev", handler: handleDashboard },
      { method: "GET", pattern: "/__dev/", handler: handleDashboard },
      // Reload — called by Rust CLI on file changes
      { method: "GET", pattern: "/__dev/api/mtime", handler: handleMtime },
      { method: "POST", pattern: "/__dev/api/reload", handler: handleReload },
      // Status & system
      { method: "GET", pattern: "/__dev/api/status", handler: handleStatus(router) },
      { method: "GET", pattern: "/__dev/api/system", handler: handleSystem },
      // Routes
      { method: "GET", pattern: "/__dev/api/routes", handler: handleRoutes(router) },
      // Messages
      { method: "GET", pattern: "/__dev/api/messages", handler: handleMessages },
      { method: "POST", pattern: "/__dev/api/messages/clear", handler: handleMessagesClear },
      { method: "GET", pattern: "/__dev/api/messages/search", handler: handleMessagesSearch },
      // Requests
      { method: "GET", pattern: "/__dev/api/requests", handler: handleRequests },
      { method: "POST", pattern: "/__dev/api/requests/clear", handler: handleRequestsClear },
      // Queue management
      { method: "GET", pattern: "/__dev/api/queue", handler: handleQueue },
      { method: "GET", pattern: "/__dev/api/queue/topics", handler: handleQueueTopics },
      { method: "GET", pattern: "/__dev/api/queue/dead-letters", handler: handleQueueDeadLetters },
      { method: "POST", pattern: "/__dev/api/queue/retry", handler: handleQueueRetry },
      { method: "POST", pattern: "/__dev/api/queue/purge", handler: handleQueuePurge },
      { method: "POST", pattern: "/__dev/api/queue/replay", handler: handleQueueReplay },
      // Mailbox
      { method: "GET", pattern: "/__dev/api/mailbox", handler: handleMailbox },
      { method: "GET", pattern: "/__dev/api/mailbox/read", handler: handleMailboxRead },
      { method: "POST", pattern: "/__dev/api/mailbox/seed", handler: handleMailboxSeed },
      { method: "POST", pattern: "/__dev/api/mailbox/clear", handler: handleMailboxClear },
      // Database
      { method: "GET", pattern: "/__dev/api/table", handler: handleTable },
      { method: "GET", pattern: "/__dev/api/tables", handler: handleTables },
      { method: "POST", pattern: "/__dev/api/seed", handler: handleSeed },
      { method: "POST", pattern: "/__dev/api/query", handler: handleQuery },
      // Errors / Broken
      { method: "GET", pattern: "/__dev/api/broken", handler: handleBroken },
      { method: "POST", pattern: "/__dev/api/broken/resolve", handler: handleBrokenResolve },
      { method: "POST", pattern: "/__dev/api/broken/clear", handler: handleBrokenClear },
      // WebSockets
      { method: "GET", pattern: "/__dev/api/websockets", handler: handleWebsockets },
      { method: "POST", pattern: "/__dev/api/websockets/disconnect", handler: handleWebsocketsDisconnect },
      // Tools
      { method: "POST", pattern: "/__dev/api/tool", handler: handleTool },
      // Chat — proxies to Rust agent /chat (SSE passthrough). Forwards
      // active_file and any other body keys verbatim. See proxyToSupervisor.
      { method: "POST", pattern: "/__dev/api/chat", handler: handleChat },
      // Threads — proxies to Rust agent /threads. Mirrors Python's
      // _api_threads + _api_threads_sub.
      { method: "GET",  pattern: "/__dev/api/threads", handler: handleThreads },
      { method: "POST", pattern: "/__dev/api/threads", handler: handleThreads },
      { method: "GET",    pattern: "/__dev/api/threads/{id}", handler: handleThreadsSub },
      { method: "PATCH",  pattern: "/__dev/api/threads/{id}", handler: handleThreadsSub },
      { method: "DELETE", pattern: "/__dev/api/threads/{id}", handler: handleThreadsSub },
      { method: "GET",    pattern: "/__dev/api/threads/{id}/messages", handler: handleThreadsSub },
      { method: "POST",   pattern: "/__dev/api/threads/{id}/messages", handler: handleThreadsSub },
      // Connections
      { method: "GET", pattern: "/__dev/api/connections", handler: handleConnections },
      { method: "POST", pattern: "/__dev/api/connections/test", handler: handleConnectionsTest },
      { method: "POST", pattern: "/__dev/api/connections/save", handler: handleConnectionsSave },
      // Gallery
      { method: "GET", pattern: "/__dev/api/gallery", handler: handleGalleryList },
      { method: "POST", pattern: "/__dev/api/gallery/deploy", handler: handleGalleryDeploy(router) },
      // Metrics
      { method: "GET", pattern: "/__dev/api/metrics", handler: (_req: any, res: any) => { res.json(quickMetrics()); } },
      { method: "GET", pattern: "/__dev/api/metrics/full", handler: (_req: any, res: any) => { res.json(fullAnalysis()); } },
      { method: "GET", pattern: "/__dev/api/metrics/file", handler: (req: any, res: any) => { const url = new URL(req.url ?? "/", "http://localhost"); const p = (url.searchParams.get("path") || "").toString(); res.json(fileDetail(p)); } },
      // GraphQL schema introspection (auto-discovers registered ORM models)
      { method: "GET", pattern: "/__dev/api/graphql/schema", handler: async (_req: any, res: any) => {
        try {
          const { GraphQL } = require("./graphql.js");
          const gql = new GraphQL();

          // Auto-discover ORM models from BaseModel registry
          try {
            const orm = await import("../../orm/src/index.js");
            const registry = (orm as any).BaseModel?._modelRegistry as Record<string, any> | undefined;
            if (registry) {
              for (const modelClass of Object.values(registry)) {
                if (modelClass?.tableName && modelClass?.fields) {
                  gql.fromOrm(modelClass);
                }
              }
            }
          } catch (_ormErr: any) {
            // ORM package not available — continue with empty schema
          }

          res.json({ schema: gql.introspect(), sdl: gql.schemaSdl() });
        } catch (e: any) {
          res.json({ error: e.message }, 400);
        }
      }},
      // Version check (proxy to avoid CORS)
      { method: "GET", pattern: "/__dev/api/version-check", handler: handleVersionCheck },
      // ── Parity surface area (ported from Python tina4_python.dev_admin) ──
      // Thoughts / activity feed (live tail of MessageLog for the AI chat pane)
      { method: "GET", pattern: "/__dev/api/thoughts", handler: handleThoughts },
      // Supervise — currently stubbed; full implementation requires a Rust
      // agent + worktree manager that doesn't exist in tina4-nodejs yet.
      { method: "POST", pattern: "/__dev/api/supervise/create", handler: handleSuperviseStub },
      { method: "GET", pattern: "/__dev/api/supervise/sessions", handler: handleSuperviseStub },
      { method: "GET", pattern: "/__dev/api/supervise/diff", handler: handleSuperviseStub },
      { method: "POST", pattern: "/__dev/api/supervise/commit", handler: handleSuperviseStub },
      { method: "POST", pattern: "/__dev/api/supervise/cancel", handler: handleSuperviseStub },
      // Execute — proxies to the framework_port+2000 Rust agent (SSE passthrough)
      { method: "POST", pattern: "/__dev/api/execute", handler: handleExecute },
      // Framework-grounding MCP token config — self-contained (.env upsert)
      { method: "GET", pattern: "/__dev/api/grounding/status", handler: handleGroundingStatus },
      { method: "POST", pattern: "/__dev/api/grounding/token", handler: handleGroundingToken },
      // Scaffold run chips — project-level operations (distinct from create)
      { method: "POST", pattern: "/__dev/api/migrate", handler: handleMigrate },
      { method: "POST", pattern: "/__dev/api/test", handler: handleTest },
      { method: "POST", pattern: "/__dev/api/seed/run", handler: handleSeedRun },
      // File browser / editor
      { method: "GET", pattern: "/__dev/api/files", handler: handleFiles },
      { method: "GET", pattern: "/__dev/api/file", handler: handleFileRead },
      { method: "POST", pattern: "/__dev/api/file/save", handler: handleFileSave },
      { method: "GET", pattern: "/__dev/api/file/raw", handler: handleFileRaw },
      { method: "POST", pattern: "/__dev/api/file/rename", handler: handleFileRename },
      { method: "POST", pattern: "/__dev/api/file/delete", handler: handleFileDelete },
      // Dependency search (npm registry) + install
      { method: "GET", pattern: "/__dev/api/deps/search", handler: handleDepsSearch },
      { method: "POST", pattern: "/__dev/api/deps/install", handler: handleDepsInstall },
      // Git status
      { method: "GET", pattern: "/__dev/api/git/status", handler: handleGitStatus },
      // Scaffolding
      { method: "GET", pattern: "/__dev/api/scaffold", handler: handleScaffoldList },
      { method: "POST", pattern: "/__dev/api/scaffold/run", handler: handleScaffoldRun },
      // Plan API (ported from Python)
      { method: "GET", pattern: "/__dev/api/plan/current", handler: handlePlanCurrent },
      { method: "GET", pattern: "/__dev/api/plan/list", handler: handlePlanList },
      { method: "POST", pattern: "/__dev/api/plan/create", handler: handlePlanCreate },
      { method: "POST", pattern: "/__dev/api/plan/switch", handler: handlePlanSwitch },
      { method: "POST", pattern: "/__dev/api/plan/complete-step", handler: handlePlanCompleteStep },
      { method: "POST", pattern: "/__dev/api/plan/add-step", handler: handlePlanAddStep },
      { method: "POST", pattern: "/__dev/api/plan/note", handler: handlePlanNote },
      { method: "POST", pattern: "/__dev/api/plan/archive", handler: handlePlanArchive },
      { method: "GET", pattern: "/__dev/api/plan/read", handler: handlePlanRead },
      { method: "POST", pattern: "/__dev/api/plan/flesh", handler: handlePlanFlesh },
      // Project index API
      { method: "POST", pattern: "/__dev/api/index/rebuild", handler: handleIndexRebuild },
      { method: "GET", pattern: "/__dev/api/index/search", handler: handleIndexSearch },
      { method: "GET", pattern: "/__dev/api/index/file", handler: handleIndexFile },
      { method: "GET", pattern: "/__dev/api/index/overview", handler: handleIndexOverview },
      // Live API RAG (Docs) — see plan/v3/22-LIVE-API-RAG.md
      { method: "GET", pattern: "/__dev/api/docs/search", handler: handleDocsSearch },
      { method: "GET", pattern: "/__dev/api/docs/class", handler: handleDocsClass },
      { method: "GET", pattern: "/__dev/api/docs/method", handler: handleDocsMethod },
      { method: "GET", pattern: "/__dev/api/docs/index", handler: handleDocsIndex },
      { method: "GET", pattern: "/__dev/api/docs/.well-known.json", handler: handleDocsWellKnown },
      // JS asset
      { method: "GET", pattern: "/__dev/js/tina4-dev-admin.min.js", handler: handleDevAdminJs },
    ];

    for (const route of routes) {
      router.addRoute({
        method: route.method,
        pattern: route.pattern,
        handler: route.handler,
      });
    }

    // MCP exposure is gated SEPARATELY from the rest of the dev dashboard.
    // The MCP dev tools expose powerful operations (DB query, file read/WRITE,
    // route listing), so they must NOT auto-expose on a non-localhost
    // TINA4_DEBUG=true deployment. mcpEnabled() honours an explicit TINA4_MCP on
    // any host, else requires TINA4_DEBUG AND (localhost OR TINA4_MCP_REMOTE) —
    // full parity with Python master tina4_python.mcp.is_enabled(). When the
    // gate is closed, neither the REST shim, the JSON-RPC/SSE endpoints, nor the
    // default dev MCP server (with its dev tools) are registered.
    if (mcpEnabled()) {
      const mcpRoutes: Array<{ method: string; pattern: string; handler: RouteHandler }> = [
        // MCP tool introspection over the built-in MCP server (browser dev-admin REST shim)
        { method: "GET", pattern: "/__dev/api/mcp/tools", handler: handleMcpTools },
        { method: "POST", pattern: "/__dev/api/mcp/call", handler: handleMcpCall },
        // MCP transport endpoints that REAL MCP clients (Claude Code/Desktop) speak.
        // /__dev/mcp is the Streamable HTTP endpoint (current transport): POST = a
        // JSON-RPC message (initialize issues Mcp-Session-Id), DELETE = terminate a
        // session, GET = 405 (this server initiates no messages). /message + /sse
        // are the legacy 2024-11-05 HTTP+SSE transport, kept for older SSE-only
        // clients. Mirrors the Python master.
        { method: "POST", pattern: "/__dev/mcp", handler: handleMcpStreamable },
        { method: "DELETE", pattern: "/__dev/mcp", handler: handleMcpDelete },
        { method: "GET", pattern: "/__dev/mcp", handler: handleMcpGet405 },
        { method: "POST", pattern: "/__dev/mcp/message", handler: handleMcpLegacyMessage },
        { method: "GET", pattern: "/__dev/mcp/sse", handler: handleMcpSse },
      ];
      for (const route of mcpRoutes) {
        router.addRoute({
          method: route.method,
          pattern: route.pattern,
          handler: route.handler,
        });
      }

      // Ensure the default /__dev/mcp MCP server exists with its dev tools
      // registered. This is the single shared instance behind both the REST shim
      // and the JSON-RPC + SSE endpoints registered above, so tools/list and the
      // REST shim return tools immediately, before any first call.
      getDefaultDevServer();
    }
  }

  /**
   * Returns the dev toolbar HTML to inject into HTML pages.
   */
  static renderToolbarHtml(ctx: {
    version: string;
    method: string;
    path: string;
    matchedPattern: string;
    requestId: string;
    routeCount: number;
  }): string {
    return renderToolbarHtml(ctx);
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

const handleDashboard: RouteHandler = (_req, res) => {
  const spa = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Tina4 Dev Admin</title></head><body><div id="app" data-framework="nodejs" data-color="#22c55e"></div><script src="/__dev/js/tina4-dev-admin.min.js"></script></body></html>';
  res.raw.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.raw.end(spa);
};

// Reload mtime counter — updated by POST /__dev/api/reload from Rust CLI
let _reloadMtime = 0;
let _reloadFile = "";

const handleMtime: RouteHandler = async (_req, res) => {
  res.json({ mtime: _reloadMtime, file: _reloadFile });
};

const handleReload: RouteHandler = async (req, res) => {
  _reloadMtime = Math.floor(Date.now() / 1000);
  const body = req.body as Record<string, unknown> | undefined;
  _reloadFile = (body?.file as string) || "";
  const reloadType = (body?.type as string) || "reload";
  console.log(`  External reload trigger: ${reloadType}${_reloadFile ? ` (${_reloadFile})` : ""}`);

  // Re-discover so new files in src/routes/ register without a server restart.
  // rediscoverRoutes() is idempotent — already-loaded files are skipped, only
  // the new ones run. Add the freshly-discovered routes to the default router.
  try {
    const { rediscoverRoutes } = await import("./routeDiscovery.js");
    const newRoutes = await rediscoverRoutes();
    if (newRoutes.length > 0) {
      // Add to the LIVE server router — startServer() builds a fresh Router and
      // exposes it as globalThis.__tina4_router; that's the instance dispatch
      // matches against. Adding to defaultRouter would land the re-imported
      // handler in a table nobody serves from, so the stale route keeps winning
      // (an edited route would never hot-reload). addRoute() replaces by pattern,
      // so the fresh handler overwrites the old one in place. Fall back to
      // defaultRouter when no server is running (e.g. unit tests).
      const liveRouter = (globalThis as any).__tina4_router;
      const target = liveRouter ?? (await import("./router.js")).defaultRouter;
      for (const route of newRoutes) target.addRoute(route);
      console.log(`  Re-discovered ${newRoutes.length} route(s) on reload`);
    }
  } catch (err) {
    console.error(`  Re-discover on reload failed:`, err);
  }

  // Keep the code Context index LIVE on the same reload trigger: reindex just
  // the changed file (UPSERT) so the dev-MCP code_search reflects the edit
  // immediately. existingContext() only touches an already-built index (it never
  // creates one — nothing to keep fresh until code_search has run), and the
  // whole block is guarded so a context failure never breaks the reload.
  try {
    if (_reloadFile) {
      const { existingContext } = await import("./context/index.js");
      const ctx = existingContext();
      if (ctx) ctx.reindexFile(_reloadFile);
    }
  } catch (err) {
    console.error(`  Context reindex on reload failed:`, err);
  }

  // WebSocket-primary reload: push an instant message to every browser
  // connected on /__dev_reload. The toolbar client (and the dev-admin
  // dashboard) act on this immediately — the mtime poll is only a fallback for
  // when the socket is down. CSS changes swap stylesheets; everything else
  // triggers a full page reload, so we normalise the wire `type` to
  // "css"/"reload". The HTTP response still echoes the caller's original type.
  // Wrapped so a broadcast failure (or zero clients) never 500s the endpoint.
  const wsType = reloadType === "css" ? "css" : "reload";
  try {
    const { devReloadWs } = await import("./websocket.js");
    devReloadWs.broadcast(JSON.stringify({ type: wsType, file: _reloadFile, mtime: _reloadMtime }));
  } catch (err) {
    console.error(`  Dev-reload WebSocket broadcast failed:`, err);
  }

  res.json({ ok: true, type: reloadType });
};

function handleStatus(router: Router): RouteHandler {
  return async (_req, res) => {
    const mem = process.memoryUsage();
    const reqStats = RequestInspector.stats();
    const msgCounts = MessageLog.count();
    const errors = ErrorTracker.get();
    const unresolved = errors.filter((e) => !e.resolved).length;
    const mailboxCounts = DevMailboxStore.count();
    let dbTableCount = 0;
    try {
      const { getAdapter } = await import("../../orm/src/index.js");
      const db = getAdapter();
      dbTableCount = db.tables().length;
    } catch { /* no database connected */ }
    res.json({
      nodeVersion: process.version,
      framework: `tina4-nodejs v${TINA4_VERSION}`,
      debug: process.env.TINA4_DEBUG ?? "false",
      logLevel: process.env.TINA4_LOG_LEVEL ?? "ERROR",
      routes: router.getRoutes().length,
      db_tables: dbTableCount,
      messages: msgCounts,
      message_counts: msgCounts,
      requests: reqStats,
      request_stats: { total: reqStats.total, avg_ms: reqStats.avgMs, errors: reqStats.errors, slowest_ms: reqStats.slowestMs },
      health: { unresolved },
      mailbox: { total: mailboxCounts.total, unread: DevMailboxStore.unreadCount() },
      memory: {
        rss: Math.round(mem.rss / 1048576),
        heapUsed: Math.round(mem.heapUsed / 1048576),
        heapTotal: Math.round(mem.heapTotal / 1048576),
      },
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  };
}

function handleRoutes(router: Router): RouteHandler {
  const internalPrefixes = ["/__dev", "/health", "/swagger"];
  return (_req, res) => {
    const allRoutes = router.getRoutes();
    const result = allRoutes
      .filter((r) => !internalPrefixes.some((prefix) => r.pattern.startsWith(prefix)))
      .map((r) => {
        const filePath = r.filePath ?? null;
        return {
          method: r.method,
          path: r.pattern,
          pattern: r.pattern,
          auth_required: (r.secure ?? false) && !(r.noAuth ?? false),
          handler: filePath ? `${filePath.split("/").pop()}` : "Closure",
          module: filePath ? filePath.substring(0, filePath.lastIndexOf("/")) : "",
          filePath,
          hasMiddleware: (r.middlewares?.length ?? 0) > 0,
          meta: r.meta ?? null,
        };
      });
    res.json({ routes: result, count: result.length });
  };
}

const handleMessages: RouteHandler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const category = url.searchParams.get("category") ?? undefined;
  const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
  res.json({
    messages: MessageLog.get(category, limit),
    counts: MessageLog.count(),
  });
};

const handleMessagesClear: RouteHandler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const category = url.searchParams.get("category") ?? undefined;
  MessageLog.clear(category);
  res.json({ cleared: true });
};

const handleRequests: RouteHandler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const rawRequests = RequestInspector.get(limit);
  const rawStats = RequestInspector.stats();
  // Map to shared JS format: duration_ms, body_size, avg_ms, errors, slowest_ms
  const mappedRequests = rawRequests.map((r) => ({
    timestamp: r.timestamp,
    method: r.method,
    path: r.path,
    status: r.status,
    duration_ms: r.durationMs,
    body_size: 0,
  }));
  res.json({
    requests: mappedRequests,
    stats: {
      total: rawStats.total,
      avg_ms: rawStats.avgMs,
      errors: rawStats.errors,
      slowest_ms: rawStats.slowestMs,
    },
  });
};

const handleRequestsClear: RouteHandler = (_req, res) => {
  RequestInspector.clear();
  res.json({ cleared: true });
};

const handleSystem: RouteHandler = async (_req, res) => {
  const mem = process.memoryUsage();
  const heapUsedMb = Math.round(mem.heapUsed / 1048576);
  const rssMb = Math.round(mem.rss / 1048576);
  let dbTableCount: number | undefined;
  let dbConnected = false;
  try {
    const { getAdapter } = await import("../../orm/src/index.js");
    const db = getAdapter();
    dbTableCount = db.tables().length;
    dbConnected = true;
  } catch { /* no database connected */ }
  // Respond in both the shared-JS format and the Node-specific format
  res.json({
    // Shared JS fields
    node_version: process.version,
    platform: process.platform,
    architecture: process.arch,
    os: `${process.platform} ${process.arch}`,
    pid: process.pid,
    memory_mb: heapUsedMb,
    db_tables: dbTableCount !== undefined ? dbTableCount : "N/A",
    db_connected: dbConnected,
    memory: {
      current_mb: heapUsedMb,
      peak_mb: rssMb,
      limit: "V8 default",
      rss: `${rssMb} MB`,
      heapUsed: `${heapUsedMb} MB`,
      heapTotal: `${Math.round(mem.heapTotal / 1048576)} MB`,
      external: `${Math.round(mem.external / 1048576)} MB`,
    },
    framework: {
      name: "tina4-nodejs",
      version: TINA4_VERSION,
      route_count: "",
    },
    debug: process.env.TINA4_DEBUG ?? "false",
    log_level: process.env.TINA4_LOG_LEVEL ?? "ERROR",
    // Node-specific extras
    node: {
      version: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    },
    uptime: {
      seconds: Math.round(process.uptime()),
      formatted: formatUptime(process.uptime()),
    },
    env: {
      TINA4_DEBUG: process.env.TINA4_DEBUG ?? "false",
      TINA4_LOG_LEVEL: process.env.TINA4_LOG_LEVEL ?? "ERROR",
    },
    cpus: cpuCount,
  });
};

// -- Messages search --

const handleMessagesSearch: RouteHandler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  if (!q) {
    res.json({ messages: [], query: "" });
    return;
  }
  const all = MessageLog.get(undefined, 500);
  const results = all.filter(
    (m) => m.message.toLowerCase().includes(q) || m.category.toLowerCase().includes(q),
  );
  res.json({ messages: results, query: q, count: results.length });
};

// -- Queue handlers --

/**
 * Map a file-backed QueueJob (LiteBackend on-disk shape) to the shared JS
 * dev-admin format the SPA queue panel renders.
 */
function mapQueueJob(job: any, topic: string, status: string) {
  return {
    id: job?.id ?? "",
    topic: job?.topic ?? topic,
    status,
    attempts: Number(job?.attempts ?? 0) || 0,
    created_at: job?.createdAt ?? job?.created_at ?? "",
    data: job?.payload ?? {},
  };
}

const handleQueue: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const topic = url.searchParams.get("topic") ?? "default";
  const statusFilter = url.searchParams.get("status") ?? "";
  try {
    const { Queue } = await import("./queue.js");
    const queue = new Queue({ topic });

    const stats = {
      pending: queue.size("pending"),
      completed: queue.size("completed"),
      failed: queue.size("failed"),
      reserved: queue.size("reserved"),
    };

    // Jobs by status — parity with Python's _api_queue: list PENDING by reading
    // the on-disk queue files directly (data/queue/<topic>/*.queue-data), then
    // fold in the file-backed failed() + deadLetters() jobs. This is why real
    // persisted jobs now show even though DevQueue (in-memory) is empty.
    const jobs: Array<ReturnType<typeof mapQueueJob>> = [];

    if (!statusFilter || statusFilter === "pending") {
      const queueDir = join(process.cwd(), "data", "queue", topic);
      if (existsSync(queueDir)) {
        for (const filename of readdirSync(queueDir).sort()) {
          if (!filename.endsWith(".queue-data")) continue; // skips failed/ + reserved/ subdirs
          try {
            const job = JSON.parse(readFileSync(join(queueDir, filename), "utf-8"));
            jobs.push(mapQueueJob(job, topic, "pending"));
          } catch {
            // skip corrupt files
          }
        }
      }
    }
    if (!statusFilter || statusFilter === "failed") {
      for (const j of queue.failed()) jobs.push(mapQueueJob(j, topic, "failed"));
    }
    if (!statusFilter || statusFilter === "dead") {
      for (const j of queue.deadLetters()) jobs.push(mapQueueJob(j, topic, "dead_letter"));
    }

    res.json({ stats, jobs });
  } catch (e: any) {
    res.json({
      stats: { pending: 0, completed: 0, failed: 0, reserved: 0 },
      jobs: [],
      error: String(e?.message ?? e),
    });
  }
};

const handleQueueTopics: RouteHandler = (_req, res) => {
  try {
    // Prefer on-disk file-queue topics under ./data/queue; fall back to "default".
    // Using dynamic require avoids a hard dep on node:fs in tree-shaken builds.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("node:path");
    const queueDir = path.join(process.cwd(), "data", "queue");
    let topics: string[] = [];
    if (fs.existsSync(queueDir)) {
      topics = fs
        .readdirSync(queueDir)
        .filter((d: string) => {
          try { return fs.statSync(path.join(queueDir, d)).isDirectory(); } catch { return false; }
        })
        .sort();
    }
    if (topics.length === 0) topics = ["default"];
    res.json({ topics });
  } catch (e: any) {
    res.json({ topics: ["default"], error: String(e?.message ?? e) });
  }
};

const handleQueueDeadLetters: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const topic = url.searchParams.get("topic") ?? "default";
  // Parity with Python's _api_queue_dead_letters: read the file-backed
  // dead-letter store (data/queue/<topic>/failed/*.queue-data) so real
  // exhausted-retry jobs surface, not just the empty in-memory DevQueue.
  try {
    const { Queue } = await import("./queue.js");
    const queue = new Queue({ topic });
    const jobs = queue.deadLetters().map((j) => mapQueueJob(j, topic, "dead_letter"));
    res.json({ jobs, count: jobs.length, topic });
  } catch (e: any) {
    res.json({ jobs: [], count: 0, topic, error: String(e?.message ?? e) });
  }
};

const handleQueueRetry: RouteHandler = (_req, res) => {
  const count = DevQueue.retryFailed();
  res.json({ retried: count });
};

const handleQueuePurge: RouteHandler = (_req, res) => {
  const count = DevQueue.purgeCompleted();
  res.json({ purged: count });
};

const handleQueueReplay: RouteHandler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const id = url.searchParams.get("id") ?? "";
  if (!id) {
    // Try reading from body
    const bodyId = (req as any).body?.id ?? "";
    if (!bodyId) {
      res.json({ error: "Missing job id" });
      return;
    }
    const job = DevQueue.replay(bodyId);
    res.json(job ? { replayed: true, job } : { error: "Job not found" });
    return;
  }
  const job = DevQueue.replay(id);
  res.json(job ? { replayed: true, job } : { error: "Job not found" });
};

// -- Mailbox handlers --

const handleMailbox: RouteHandler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const folder = url.searchParams.get("folder") ?? "inbox";
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const messages = DevMailboxStore.inbox(folder, limit, offset);
  const counts = DevMailboxStore.count();
  const unread = DevMailboxStore.unreadCount();
  res.json({ messages, counts, unread });
};

const handleMailboxRead: RouteHandler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const id = url.searchParams.get("id") ?? "";
  const msg = DevMailboxStore.read(id);
  // Shared JS expects the message fields at top level (not wrapped in .message)
  res.json(msg ? msg : { error: "Message not found" });
};

const handleMailboxSeed: RouteHandler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const count = parseInt(url.searchParams.get("count") ?? "5", 10);
  DevMailboxStore.seed(count);
  res.json({ seeded: count });
};

const handleMailboxClear: RouteHandler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const folder = url.searchParams.get("folder") ?? undefined;
  DevMailboxStore.clear(folder);
  res.json({ cleared: true, folder: folder ?? "all" });
};

// -- Database handlers --

/**
 * Quote a (optionally schema-qualified) table reference for safe interpolation.
 * Returns null for anything that isn't one or two plain SQL identifiers, so a
 * hostile ?name= can never reach the SELECT. Mirrors the identifier guard the
 * sqlite adapter uses for PRAGMA table_info.
 */
function quoteTableRef(name: string): string | null {
  const parts = name.split(".");
  if (parts.length === 0 || parts.length > 2) return null;
  for (const p of parts) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) return null;
  }
  return parts.map((p) => `"${p}"`).join(".");
}

const handleTable: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const name = url.searchParams.get("name") ?? "";
  if (!name) {
    res.json({ error: "Missing table name parameter" });
    return;
  }
  // Real implementation — parity with Python's _api_table_info: return the
  // table's column list + a sample of up to 20 rows via the same DB adapter
  // `tables`/`query` use.
  try {
    const { getAdapter } = await import("../../orm/src/index.js");
    const db = getAdapter();
    const columns = db.columns(name);
    if (!columns.length) {
      res.json({ table: name, columns: [], rows: [], message: "Database not connected or table not found" });
      return;
    }
    const ref = quoteTableRef(name);
    if (!ref) {
      // Columns resolved but the name isn't a plain identifier we'll splice
      // into SQL — surface the schema without the sample rather than risk it.
      res.json({ table: name, columns, rows: [], count: 0, message: "Invalid table name for sampling" });
      return;
    }
    const rows = db.fetch(`SELECT * FROM ${ref} LIMIT 20`);
    res.json({ table: name, columns, rows, count: rows.length });
  } catch (e) {
    res.json({ table: name, columns: [], rows: [], message: (e as Error)?.message ?? "Database not connected or table not found" });
  }
};

const handleTables: RouteHandler = async (_req, res) => {
  try {
    const { getAdapter } = await import("../../orm/src/index.js");
    const db = getAdapter();
    const tables = db.tables();
    res.json({ tables });
  } catch {
    res.json({ tables: [], message: "Database not connected" });
  }
};

const handleSeed: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const body = (req as any).body ?? {};
  const table = url.searchParams.get("table") ?? body?.table ?? "";
  const count = parseInt(String(url.searchParams.get("count") ?? body?.count ?? "10"), 10) || 10;
  // P4b — accept seed/clear/strict; drop the previous hard-coded behaviour.
  const seedRaw = url.searchParams.get("seed") ?? body?.seed;
  const seed = seedRaw !== undefined && seedRaw !== null && String(seedRaw) !== ""
    ? (Number.isNaN(parseInt(String(seedRaw), 10)) ? undefined : parseInt(String(seedRaw), 10))
    : undefined;
  const clear = String(url.searchParams.get("clear") ?? body?.clear ?? "") === "true" || body?.clear === true;
  const strict = String(url.searchParams.get("strict") ?? body?.strict ?? "") === "true" || body?.strict === true;
  if (!table) {
    res.json({ error: "Missing table parameter" });
    return;
  }
  try {
    const orm = await import("../../orm/src/index.js");
    const db = orm.getAdapter();
    const { seedTable } = orm;
    // A shared FakeData seeds the RNG so a `seed` makes the run reproducible.
    const fake = new orm.FakeData(seed);
    const columns = db.columns(table);
    if (!columns.length) {
      res.json({ error: `Table '${table}' not found or has no columns` });
      return;
    }
    // Build a field map based on column info (skip auto-increment/id PKs).
    const fieldMap: Record<string, () => unknown> = {};
    for (const col of columns) {
      const name = col.name.toLowerCase();
      const type = col.type.toLowerCase();
      if (name === "id" || (col as any).primaryKey === true) continue; // skip primary key
      if (name.includes("email")) { fieldMap[col.name] = () => fake.email(); }
      else if (name.includes("name")) { fieldMap[col.name] = () => fake.name(); }
      else if (name.includes("phone")) { fieldMap[col.name] = () => fake.phone(); }
      else if (name.includes("address") || name.includes("city") || name.includes("country")) { fieldMap[col.name] = () => fake.address(); }
      else if (name.includes("url") || name.includes("website")) { fieldMap[col.name] = () => fake.url(); }
      else if (type.includes("int")) { fieldMap[col.name] = () => fake.integer(1, 1000); }
      else if (type.includes("real") || type.includes("float") || type.includes("double") || type.includes("numeric") || type.includes("decimal")) { fieldMap[col.name] = () => fake.numeric(0, 1000, 2); }
      else if (type.includes("bool")) { fieldMap[col.name] = () => fake.boolean(); }
      else if (type.includes("date") || type.includes("time")) { fieldMap[col.name] = () => fake.date(); }
      else { fieldMap[col.name] = () => fake.sentence(3); }
    }
    // P1 — delegate to the shared seedTable so each row is wrapped (no
    // unhandled failure can crash the endpoint) and we get a summary back.
    const summary = await seedTable(db, table, count, fieldMap, undefined, { clear, seed, strict });
    res.json({ seeded: summary.seeded, failed: summary.failed, errors: summary.errors, table });
  } catch (e) {
    res.json({ error: (e as Error)?.message ?? "Database not connected" });
  }
};

const handleQuery: RouteHandler = async (req, res) => {
  const query = ((req as any).body?.query ?? "").trim();
  const queryType = (req as any).body?.type ?? "sql";
  if (!query) {
    res.json({ error: "Missing query parameter" });
    return;
  }

  if (queryType === "graphql") {
    // GraphQL stub — can be extended when GraphQL module is available
    res.json({ error: "GraphQL not yet supported in dev admin" });
    return;
  }

  try {
    const { getAdapter } = await import("../../orm/src/index.js");
    const db = getAdapter();

    // Split multiple statements on semicolons
    const statements = query.split(";").map((s: string) => s.trim()).filter((s: string) => s.length > 0);

    if (statements.length === 1) {
      const upper = statements[0].toUpperCase().trimStart();
      const isRead = upper.startsWith("SELECT") || upper.startsWith("PRAGMA") || upper.startsWith("SHOW") || upper.startsWith("DESCRIBE");

      if (isRead) {
        const rows = db.fetch(statements[0]);
        MessageLog.log("query", "info", `SQL: ${statements[0].substring(0, 80)}`, { rows: rows.length });
        res.json({ rows, count: rows.length });
        return;
      }
    }

    // Execute all statements (single write or multi-statement batch)
    let totalAffected = 0;
    db.startTransaction();
    try {
      for (const stmt of statements) {
        const result = db.execute(stmt);
        // execute may return an object with affected count or a number
        if (typeof result === "number") {
          totalAffected += result;
        } else if (result && typeof result === "object" && "changes" in (result as Record<string, unknown>)) {
          totalAffected += Number((result as Record<string, unknown>).changes) || 0;
        }
      }
      db.commit();
    } catch (e: unknown) {
      db.rollback();
      const msg = e instanceof Error ? e.message : String(e);
      res.json({ error: msg });
      return;
    }

    MessageLog.log("query", "warn", `SQL batch: ${statements.length} statement(s)`, { affected: totalAffected });
    res.json({ affected: totalAffected, success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.json({ error: msg });
  }
};

// -- Broken (errors) handlers --

const handleBroken: RouteHandler = (_req, res) => {
  const errors = ErrorTracker.get();
  const unresolved = errors.filter((e) => !e.resolved).length;
  // Map to shared JS format: error_type, message, traceback, count, last_seen
  const mappedErrors = errors.map((e) => ({
    id: e.id,
    error_type: "Error",
    message: e.message,
    traceback: e.stack ?? "",
    count: 1,
    last_seen: e.timestamp,
    resolved: e.resolved,
  }));
  res.json({ errors: mappedErrors, health: { unresolved }, count: errors.length });
};

const handleBrokenResolve: RouteHandler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const id = url.searchParams.get("id") ?? (req as any).body?.id ?? "";
  if (!id) {
    res.json({ error: "Missing error id" });
    return;
  }
  const resolved = ErrorTracker.resolve(id);
  res.json({ resolved });
};

const handleBrokenClear: RouteHandler = (_req, res) => {
  // "Clear All" button — flush every tracked error, not only the
  // ones individually marked resolved. Matches PHP/Python/Ruby.
  ErrorTracker.clearAll();
  res.json({ cleared: true });
};

// -- WebSocket handlers --

const handleWebsockets: RouteHandler = (_req, res) => {
  const conns = WsTracker.list();
  // Map to shared JS format: ip, connected_at, closed
  const mapped = conns.map((c) => ({
    id: c.id,
    path: c.path,
    ip: c.remoteAddress,
    connected_at: c.connectedAt,
    closed: false,
  }));
  res.json({ connections: mapped, count: mapped.length });
};

const handleWebsocketsDisconnect: RouteHandler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const id = url.searchParams.get("id") ?? (req as any).body?.id ?? "";
  if (!id) {
    res.json({ error: "Missing connection id" });
    return;
  }
  const removed = WsTracker.remove(id);
  res.json({ disconnected: removed });
};

// -- Tool handler --

const handleTool: RouteHandler = (req, res) => {
  const tool = (req as any).body?.tool ?? "";
  const validTools = ["test", "migrate", "seed", "routes", "carbon", "ai"];
  if (!tool || !validTools.includes(tool)) {
    res.json({ error: `Invalid tool. Valid tools: ${validTools.join(", ")}` });
    return;
  }
  // Stub response — actual implementations will be wired in later
  res.json({ tool, status: "executed", message: `Tool '${tool}' executed (stub)`, timestamp: new Date().toISOString() });
};

// -- Supervisor proxy helpers --

/**
 * Return the base URL for the co-located Rust agent server.
 *
 * Mirrors Python's `_supervisor_base_url()` in
 * `tina4_python/dev_admin/__init__.py`. Resolution order:
 *   1. `TINA4_SUPERVISOR_URL` — explicit full URL.
 *   2. `TINA4_AGENT_PORT` — explicit port on 127.0.0.1.
 *   3. `PORT` + 2000 — auto-derived (matches `tina4 serve` agent port).
 *   4. Fallback `http://127.0.0.1:9145` — matches standalone `tina4 agent`.
 */
export function supervisorBaseUrl(): string {
  const explicit = (process.env.TINA4_SUPERVISOR_URL ?? "").replace(/\/+$/, "");
  if (explicit) return explicit;
  const agentPort = (process.env.TINA4_AGENT_PORT ?? "").trim();
  if (/^\d+$/.test(agentPort)) return `http://127.0.0.1:${parseInt(agentPort, 10)}`;
  const fwPort = (process.env.PORT ?? "").trim();
  if (/^\d+$/.test(fwPort)) return `http://127.0.0.1:${parseInt(fwPort, 10) + 2000}`;
  return "http://127.0.0.1:9145";
}

/**
 * Forward a dev-admin request to the Rust agent server.
 *
 * Mirrors Python's `_proxy_to_supervisor()`. Strips the `/__dev/api` prefix,
 * forwards method/body/query verbatim to `<base>{downstreamPath}`, and pipes
 * the response back. SSE (`text/event-stream`) is streamed chunk-by-chunk so
 * progress events reach the SPA live instead of after the full multi-agent
 * run completes. When the agent is unreachable we respond with 503 and a
 * hint so the SPA can show a useful error.
 */
async function proxyToSupervisor(
  req: any,
  res: any,
  downstreamPath: string,
): Promise<void> {
  const base = supervisorBaseUrl();

  // Forward query string verbatim
  let qs = "";
  try {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    if (reqUrl.search) qs = reqUrl.search;
  } catch { /* ignore */ }
  const target = `${base}${downstreamPath}${qs}`;

  const method = (req.method ?? "GET").toUpperCase();

  // Build the body for methods that carry one
  let bodyText: string | undefined;
  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
    const body = (req as any).body;
    if (body !== undefined && body !== null) {
      if (typeof body === "string") {
        bodyText = body;
      } else if (typeof body === "object") {
        // SPA→agent convention fixup (matches Python): `/execute` sends
        // plan_file as a bare filename but the rust agent expects a
        // project-relative path. Prepend `plan/` when no slash is present.
        let outBody: any = body;
        if (!Array.isArray(body)) {
          const pf = (body as any).plan_file;
          if (typeof pf === "string" && pf && !pf.includes("/")) {
            outBody = { ...body, plan_file: `plan/${pf}` };
          }
        }
        bodyText = JSON.stringify(outBody);
      }
    }
  }

  // Heavy multi-agent endpoints get a generous timeout; metadata-only
  // /supervise/* and /threads/* calls return fast.
  const timeoutMs = downstreamPath === "/execute" || downstreamPath === "/chat" ? 600_000 : 30_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers: { "Content-Type": "application/json" },
      body: bodyText,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    res.json(
      {
        error: "supervisor unavailable",
        detail: (e as Error).message,
        hint: "Run `tina4 serve` (starts the agent server) or set TINA4_SUPERVISOR_URL",
      },
      503,
    );
    return;
  }

  const ct = (upstream.headers.get("content-type") ?? "").toLowerCase();

  // SSE / event-stream — stream chunks through as they arrive.
  if (ct.includes("text/event-stream")) {
    res.raw.writeHead(upstream.status || 200, {
      "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    if (typeof (res.raw as any).flushHeaders === "function") {
      (res.raw as any).flushHeaders();
    }
    if (!upstream.body) {
      res.raw.end();
      clearTimeout(timer);
      return;
    }
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.raw.write(Buffer.from(value));
      }
    } finally {
      clearTimeout(timer);
      res.raw.end();
    }
    return;
  }

  clearTimeout(timer);

  // JSON / other — drain the body and return as before.
  const raw = await upstream.text();
  const status = upstream.status || 200;
  try {
    res.json(JSON.parse(raw), status);
  } catch {
    // Non-JSON upstream — pass through as text with the same status.
    res.raw.writeHead(status, {
      "Content-Type": upstream.headers.get("content-type") ?? "text/plain; charset=utf-8",
    });
    res.raw.end(raw);
  }
}

// -- Chat handler --
//
// Proxies POST /__dev/api/chat → Rust agent `POST /chat`. The SPA's Chat
// view POSTs `{message, settings?, thread_id?, active_file?, files?}` and
// expects an SSE stream of `event: status / message / done` chunks.
// active_file (and any other body keys) are forwarded verbatim.
const handleChat: RouteHandler = async (req, res) => {
  await proxyToSupervisor(req, res, "/chat");
};

// -- Framework-grounding (mcp.tina4.com) token config --
//
// TINA4_MCP_TOKEN grounds the coder against mcp.tina4.com's tina4_context.
// These routes are self-contained: they read/write the token in the project
// .env directly (no dependency on the Rust agent being up), matching the
// python/php/ruby dev_admin. The agent still resolves the same TINA4_MCP_TOKEN
// (process env → .env) when it runs.
//   GET  /__dev/api/grounding/status → {configured, last4, url}
//   POST /__dev/api/grounding/token  → upsert TINA4_MCP_TOKEN in .env
const DEFAULT_MCP_URL = "https://mcp.tina4.com";

/** Resolve a var from the live process env, falling back to the project .env. */
function resolveDevEnvVar(key: string): string {
  const live = process.env[key];
  if (live !== undefined && live !== "") return live;
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return "";
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const eq = t.indexOf("=");
    if (t.slice(0, eq).trim() === key) return t.slice(eq + 1).trim();
  }
  return "";
}

/** Upsert KEY=value into the project .env (creates the file if absent). */
function upsertDevEnvVar(key: string, value: string): void {
  const envPath = join(process.cwd(), ".env");
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf-8").split("\n") : [];
  let found = false;
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) { out.push(line); continue; }
    if (t.slice(0, t.indexOf("=")).trim() === key) { out.push(`${key}=${value}`); found = true; }
    else out.push(line);
  }
  if (!found) out.push(`${key}=${value}`);
  writeFileSync(envPath, out.join("\n").replace(/\n+$/, "") + "\n");
}

const handleGroundingStatus: RouteHandler = async (_req, res) => {
  const token = resolveDevEnvVar("TINA4_MCP_TOKEN");
  const url = resolveDevEnvVar("TINA4_MCP_URL") || DEFAULT_MCP_URL;
  res.json({ configured: token.length > 0, last4: token ? token.slice(-4) : "", url });
};
const handleGroundingToken: RouteHandler = async (req, res) => {
  const body = (req.body as Record<string, unknown>) || {};
  const token = String(body.token ?? "").trim();
  try {
    upsertDevEnvVar("TINA4_MCP_TOKEN", token);
    // Reflect into the live process env so a follow-up status reads back at once.
    process.env.TINA4_MCP_TOKEN = token;
    res.json({ ok: true, configured: token.length > 0, last4: token ? token.slice(-4) : "" });
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message }, 500);
  }
};

// -- Scaffold run chips: migrate / test / seed-all --
//
// The dev-admin's ▶ Migrate / ▶ Test / ▶ Seed chips are project-level
// operations, distinct from the create endpoint (/scaffold/run). Each uses the
// framework's own machinery so behaviour matches the CLI.

/** POST /__dev/api/migrate — apply pending migrations via the ORM's migrate(). */
const handleMigrate: RouteHandler = async (_req, res) => {
  try {
    const orm = await import("../../orm/src/index.js");
    const result = await orm.migrate();
    res.json({
      ok: result.failed.length === 0,
      applied: result.applied,
      skipped: result.skipped,
      failed: result.failed,
    });
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message }, 500);
  }
};

/** POST /__dev/api/seed/run — seed every discovered model, FK-ordered. */
const handleSeedRun: RouteHandler = async (req, res) => {
  const body = (req.body as Record<string, unknown>) || {};
  const count = parseInt(String(body.count ?? "10"), 10) || 10;
  try {
    const orm = await import("../../orm/src/index.js");
    // Models live in src/orm/ (primary) and src/models/ (fallback) — same dirs
    // the server discovers on startup.
    const dirs = ["src/orm", "src/models"].map((d) => resolve(process.cwd(), d)).filter((d) => existsSync(d));
    const classes: unknown[] = [];
    for (const dir of dirs) {
      for (const m of await orm.discoverModels(dir)) classes.push(m.modelClass);
    }
    if (classes.length === 0) {
      res.json({ ok: false, error: "No models found in src/orm/ or src/models/" }, 400);
      return;
    }
    const summaries = await orm.seedModels(classes as never[], count);
    let seeded = 0, failed = 0;
    for (const s of Object.values(summaries) as Array<{ seeded: number; failed: number }>) {
      seeded += s.seeded; failed += s.failed;
    }
    res.json({ ok: failed === 0, seeded, failed, tables: Object.keys(summaries).length });
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message }, 500);
  }
};

/** POST /__dev/api/test — run the project test suite (`npm test`) and stream back
 *  the combined output + exit code. Bounded timeout so a hung suite can't wedge
 *  the dev server. */
const handleTest: RouteHandler = async (_req, res) => {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    try {
      const { stdout, stderr } = await run("npm", ["test"], {
        cwd: resolve(process.cwd()),
        timeout: 180_000,
        encoding: "utf-8",
        maxBuffer: 8 * 1024 * 1024,
      });
      res.json({ ok: true, code: 0, output: `${stdout}${stderr}` });
    } catch (err) {
      // Non-zero exit (failing tests) lands here — that's a valid, reportable
      // result, not a 500. Surface the output + code so the UI shows failures.
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      res.json({
        ok: false,
        code: typeof e.code === "number" ? e.code : 1,
        output: `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message || "tests failed",
      });
    }
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message }, 500);
  }
};

// -- Threads handlers --

/**
 * Proxy /__dev/api/threads → Rust agent /threads.
 *   GET  → list threads
 *   POST → create thread
 * Method-multiplexed — anything else gets a 405.
 */
const handleThreads: RouteHandler = async (req, res) => {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    res.json({ error: "method not allowed" }, 405);
    return;
  }
  await proxyToSupervisor(req, res, "/threads");
};

/**
 * Proxy /__dev/api/threads/{id}[/messages] → Rust agent.
 *
 * Strips the dev-admin prefix and forwards the remaining path verbatim so
 * /__dev/api/threads/abc/messages becomes /threads/abc/messages on the
 * agent side. Mirrors Python's `_api_threads_sub`.
 */
const handleThreadsSub: RouteHandler = async (req, res) => {
  let pathname = "";
  try {
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    pathname = req.url ?? "";
  }
  const prefix = "/__dev/api";
  if (!pathname.startsWith(prefix)) {
    res.json({ error: "not found" }, 404);
    return;
  }
  const suffix = pathname.slice(prefix.length); // "/threads/abc[/messages]"
  if (!suffix.startsWith("/threads/")) {
    res.json({ error: "not found" }, 404);
    return;
  }
  await proxyToSupervisor(req, res, suffix);
};

// ---------------------------------------------------------------------------

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

function parseEnvFile(): Record<string, string> {
  const envPath = join(process.cwd(), ".env");
  const result: Record<string, string> = {};
  if (!existsSync(envPath)) return result;
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    result[key.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  return result;
}

const handleConnections: RouteHandler = (_req, res) => {
  const env = parseEnvFile();
  res.json({
    url: env.TINA4_DATABASE_URL ?? "",
    username: env.TINA4_DATABASE_USERNAME ?? "",
    password: env.TINA4_DATABASE_PASSWORD ? "***" : "",
  });
};

const handleConnectionsTest: RouteHandler = async (req, res) => {
  const body = req.body as Record<string, string> | undefined;
  const url = body?.url ?? "";
  const username = body?.username ?? "";
  const password = body?.password ?? "";
  if (!url) {
    res.json({ success: false, error: "No connection URL provided" });
    return;
  }
  try {
    // Try to use the ORM's initDatabase if available
    const { initDatabase } = await import("../../orm/src/index.js").catch(() => ({ initDatabase: null }));
    if (!initDatabase) {
      res.json({ success: false, error: "Database module (@tina4/orm) not available" });
      return;
    }
    const db = await initDatabase({ url, username, password });
    let version = "Connected";
    let tableCount = 0;
    try {
      const tables = db.getTables();
      tableCount = Array.isArray(tables) ? tables.length : 0;
    } catch { tableCount = 0; }
    try {
      const urlLower = url.toLowerCase();
      // NOTE: db.execute() is async; these calls are intentionally left
      // un-awaited to preserve the exact existing runtime behaviour during
      // this type-only cleanup. `row` is therefore a Promise and the `as any`
      // access below evaluates to the fallback string. See report open question.
      if (urlLower.includes("sqlite")) {
        const row = db.execute("SELECT sqlite_version() as v");
        version = `SQLite ${(row as any)?.[0]?.v ?? ""}`;
      } else if (urlLower.includes("postgres")) {
        const row = db.execute("SELECT version() as v");
        version = ((row as any)?.[0]?.v ?? "PostgreSQL").toString().split(",")[0];
      } else if (urlLower.includes("mysql")) {
        const row = db.execute("SELECT version() as v");
        version = `MySQL ${(row as any)?.[0]?.v ?? ""}`;
      } else if (urlLower.includes("mssql")) {
        const row = db.execute("SELECT @@VERSION as v");
        version = ((row as any)?.[0]?.v ?? "MSSQL").toString().split("\n")[0];
      } else if (urlLower.includes("firebird")) {
        const row = db.execute("SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') as v FROM rdb$database");
        version = `Firebird ${(row as any)?.[0]?.v ?? ""}`;
      }
    } catch { /* keep version as Connected */ }
    db.close();
    res.json({ success: true, version, tables: tableCount });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.json({ success: false, error: msg });
  }
};

const handleConnectionsSave: RouteHandler = (req, res) => {
  const body = req.body as Record<string, string> | undefined;
  const url = body?.url ?? "";
  const username = body?.username ?? "";
  const password = body?.password ?? "";
  if (!url) {
    res.json({ success: false, error: "No connection URL provided" });
    return;
  }
  try {
    const envPath = join(process.cwd(), ".env");
    const lines = existsSync(envPath) ? readFileSync(envPath, "utf-8").split("\n") : [];
    const keysFound: Record<string, boolean> = { TINA4_DATABASE_URL: false, TINA4_DATABASE_USERNAME: false, TINA4_DATABASE_PASSWORD: false };
    const newLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        newLines.push(line);
        continue;
      }
      const key = trimmed.split("=", 1)[0].trim();
      if (key === "TINA4_DATABASE_URL") { newLines.push(`TINA4_DATABASE_URL=${url}`); keysFound.TINA4_DATABASE_URL = true; }
      else if (key === "TINA4_DATABASE_USERNAME") { newLines.push(`TINA4_DATABASE_USERNAME=${username}`); keysFound.TINA4_DATABASE_USERNAME = true; }
      else if (key === "TINA4_DATABASE_PASSWORD") { newLines.push(`TINA4_DATABASE_PASSWORD=${password}`); keysFound.TINA4_DATABASE_PASSWORD = true; }
      else { newLines.push(line); }
    }
    const values: Record<string, string> = { TINA4_DATABASE_URL: url, TINA4_DATABASE_USERNAME: username, TINA4_DATABASE_PASSWORD: password };
    for (const [key, found] of Object.entries(keysFound)) {
      if (!found) newLines.push(`${key}=${values[key]}`);
    }
    writeFileSync(envPath, newLines.join("\n") + "\n");
    res.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.json({ success: false, error: msg });
  }
};

// ---------------------------------------------------------------------------
// Gallery handlers — list and deploy gallery examples
// ---------------------------------------------------------------------------

const __devAdminFilename = fileURLToPath(import.meta.url);
const __devAdminDirname = dirname(__devAdminFilename);

function walkDirRecursive(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walkDirRecursive(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

const handleGalleryList: RouteHandler = (_req, res) => {
  const galleryDir = resolve(__devAdminDirname, "..", "gallery");
  const items: Array<Record<string, unknown>> = [];

  if (existsSync(galleryDir)) {
    const entries = readdirSync(galleryDir).sort();
    for (const entry of entries) {
      const entryPath = join(galleryDir, entry);
      const metaFile = join(entryPath, "meta.json");
      if (statSync(entryPath).isDirectory() && existsSync(metaFile)) {
        try {
          const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
          meta.id = entry;
          // List the files that would be deployed
          const srcDir = join(entryPath, "src");
          if (existsSync(srcDir)) {
            const allFiles = walkDirRecursive(srcDir);
            meta.files = allFiles.map((f) => relative(srcDir, f));
          }
          // Check if already deployed
          const projectSrc = resolve(process.cwd(), "src");
          if (existsSync(srcDir) && meta.files) {
            meta.deployed = (meta.files as string[]).every((f: string) =>
              existsSync(join(projectSrc, f)),
            );
          } else {
            meta.deployed = false;
          }
          items.push(meta);
        } catch {
          // Skip invalid meta.json
        }
      }
    }
  }

  res.json({ gallery: items, count: items.length });
};

function handleGalleryDeploy(router: Router): RouteHandler {
  return async (req, res): Promise<void> => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const name = (body.name as string) ?? "";
    if (!name) {
      res.json({ error: "No gallery item specified" }, 400);
      return;
    }

    const galleryDir = resolve(__devAdminDirname, "..", "gallery");
    const gallerySrc = join(galleryDir, name, "src");
    if (!existsSync(gallerySrc)) {
      res.json({ error: `Gallery item '${name}' not found` }, 404);
      return;
    }

    const projectSrc = resolve(process.cwd(), "src");
    const copied: string[] = [];

    const allFiles = walkDirRecursive(gallerySrc);
    for (const srcFile of allFiles) {
      const rel = relative(gallerySrc, srcFile);
      const dest = join(projectSrc, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(srcFile, dest);
      copied.push(rel);
    }

    // Re-discover routes so new files are immediately available
    try {
      const routesDir = resolve(process.cwd(), "src", "routes");
      if (existsSync(routesDir)) {
        const { discoverRoutes } = await import("./routeDiscovery.js");
        const routes = await discoverRoutes(routesDir);
        for (const route of routes) {
          // Only add if not already registered
          const existing = router.match(route.method, route.pattern.replace(/\{(\w+)\}/g, "test").replace(/\{\.\.\.\w+\}/g, "test"));
          if (!existing) {
            router.addRoute(route);
          }
        }
      }
    } catch {
      // Non-fatal — routes will load on next restart
    }

    res.json({ deployed: name, files: copied });
  };
}

// ---------------------------------------------------------------------------
// Version check — proxy to npm registry to avoid browser CORS errors
// ---------------------------------------------------------------------------

const handleVersionCheck: RouteHandler = async (_req, res) => {
  const current = TINA4_VERSION;
  let latest = current;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch("https://registry.npmjs.org/tina4-nodejs/latest", {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (resp.ok) {
      const data = (await resp.json()) as Record<string, unknown>;
      if (typeof data.version === "string") latest = data.version;
    }
  } catch {
    // Offline or timeout — return current as latest
  }
  res.json({ current, latest });
};

// ---------------------------------------------------------------------------
// Parity handlers — ported from Python tina4_python.dev_admin
// ---------------------------------------------------------------------------

function safeJoin(projectRoot: string, rel: string): string | null {
  const resolved = resolve(projectRoot, rel);
  if (!resolved.startsWith(projectRoot)) return null;
  return resolved;
}

const handleThoughts: RouteHandler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
  const entries = MessageLog.get(undefined, limit).map((e) => ({
    id: e.id,
    timestamp: e.timestamp,
    level: e.level,
    category: e.category,
    message: e.message,
    data: e.data,
  }));
  res.json({ thoughts: entries, count: entries.length });
};

const handleSuperviseStub: RouteHandler = (_req, res) => {
  res.json(
    {
      error: "supervise API not implemented in tina4-nodejs yet",
      note: "Requires Rust agent + worktree manager for parity with Python/PHP. Stubbed intentionally.",
    },
    501,
  );
};

const handleExecute: RouteHandler = async (req, res) => {
  // Proxy to framework_port+2000 Rust agent (SSE passthrough).
  const port = parseInt(process.env.TINA4_PORT ?? process.env.PORT ?? "7148", 10);
  const agentUrl = `http://127.0.0.1:${port + 2000}/execute`;
  try {
    const upstream = await fetch(agentUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    });
    if (!upstream.body) {
      res.json({ error: "agent returned no body" }, 502);
      return;
    }
    res.raw.writeHead(upstream.status || 200, {
      "Content-Type": upstream.headers.get("content-type") || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.raw.write(Buffer.from(value));
    }
    res.raw.end();
  } catch (e) {
    res.json({ error: `agent unreachable at ${agentUrl}: ${(e as Error).message}` }, 502);
  }
};

// --- file-browser noise filter + git decoration (mirrors PHP/Python dev-admin) ---
const DEV_FILES_IGNORED = new Set([
  "__pycache__", "node_modules", "vendor", ".git",
  "venv", ".venv", "dist", "target", ".tina4",
]);

// Hidden dot-entries are filtered too, except the env files.
function devFilesHidden(name: string): boolean {
  if (DEV_FILES_IGNORED.has(name)) return true;
  return name.startsWith(".") && name !== ".env" && name !== ".env.example";
}

// Same 4-status mapping Python/PHP use for a porcelain code.
function devGitStatusLabel(code: string): string {
  if (code === "??") return "untracked";
  if (code.includes("M")) return "modified";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  return "clean";
}

/**
 * Branch + porcelain status map for the file browser, mirroring PHP's
 * devAdminGit* helpers 1:1. Paths git reports are relative to the repo
 * root (always forward-slash); the project root may sit inside a larger
 * repo (monorepo), so the toplevel is returned too for rebasing. Degrades
 * to empty (every entry "clean") on any error / no git.
 */
async function devGitInfo(root: string): Promise<{ branch: string; gitRoot: string | null; status: Map<string, string> }> {
  const empty = { branch: "", gitRoot: null as string | null, status: new Map<string, string>() };
  try {
    const { execFileSync } = await import("node:child_process");
    const git = (args: string[]): string | null => {
      try {
        return execFileSync("git", args, { cwd: root, timeout: 3000, encoding: "utf-8" }).toString();
      } catch {
        return null;
      }
    };
    const inside = git(["rev-parse", "--is-inside-work-tree"]);
    if (!inside || inside.trim() !== "true") return empty;
    const branch = (git(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "").trim();
    const topRaw = git(["rev-parse", "--show-toplevel"]);
    const gitRoot = topRaw && topRaw.trim() !== ""
      ? topRaw.trim().replace(/\\/g, "/").replace(/\/+$/, "")
      : null;
    const status = new Map<string, string>();
    const porcelain = git(["status", "--porcelain", "-uall"]);
    if (porcelain) {
      for (const line of porcelain.split(/\r?\n/)) {
        if (line.length < 4) continue;
        const code = line.slice(0, 2).trim();
        let p = line.slice(3).trim();
        const arrow = p.indexOf(" -> ");      // rename/copy — keep destination
        if (arrow !== -1) p = p.slice(arrow + 4);
        if (p === "") continue;
        status.set(p, code);
      }
    }
    return { branch, gitRoot, status };
  } catch {
    return empty;
  }
}

const handleFiles: RouteHandler = async (req, res) => {
  // Response shape matches tina4-python / tina4-php 1:1 so the dev-admin SPA
  // works against every framework with no branching: each entry carries
  // `is_dir`, `has_children`, `git_status` and `size`; the payload carries the
  // git `branch`. Noise dirs + hidden dot-files (except .env/.env.example) are
  // filtered out.
  const url = new URL(req.url ?? "/", "http://localhost");
  const rel = url.searchParams.get("path") ?? ".";
  const root = resolve(process.cwd());
  const target = safeJoin(root, rel);
  const { branch, gitRoot, status: gitStatus } = await devGitInfo(root);

  // Missing/invalid paths return an empty-but-valid shape (not 404): the SPA
  // restores expanded-folder state from localStorage, and folders that don't
  // exist in this harness would otherwise spam the console with red 404s.
  if (!target || !existsSync(target) || !statSync(target).isDirectory()) {
    res.json({ path: rel, branch, entries: [], error: "not a directory" });
    return;
  }

  // Rebase entry paths onto the git repo root when the project sits inside a
  // larger repo. Everything runs in forward-slash form.
  const rootFwd = root.replace(/\\/g, "/");
  let cwdInGit = "";
  if (gitRoot && gitRoot !== rootFwd && rootFwd.startsWith(gitRoot)) {
    cwdInGit = rootFwd.slice(gitRoot.length).replace(/^\/+/, "");
    if (cwdInGit !== "") cwdInGit += "/";
  }

  const entries: Array<Record<string, unknown>> = [];
  for (const name of readdirSync(target).sort()) {   // alphabetical; no re-sort by type
    if (devFilesHidden(name)) continue;
    const full = join(target, name);
    const entryRel = relative(root, full).replace(/\\/g, "/");

    let isDir = false;
    let size: number | null = null;
    try {
      const st = statSync(full);
      isDir = st.isDirectory();
      if (!isDir) size = st.size;
    } catch { /* unreadable entry */ }

    // git status for this entry (same mapping PHP/Python use)
    const gitPath = cwdInGit + entryRel;
    let gitLabel = "clean";
    const code = gitStatus.get(gitPath);
    if (code !== undefined) {
      gitLabel = devGitStatusLabel(code);
    } else if (isDir) {
      const prefix = gitPath + "/";          // propagate dirty status from any child
      for (const [gf, gc] of gitStatus) {
        if (gf.startsWith(prefix)) { gitLabel = gc === "??" ? "untracked" : "modified"; break; }
      }
    }

    // has_children: does the dir contain anything visible?
    let hasChildren: boolean | null = null;
    if (isDir) {
      hasChildren = false;
      try {
        for (const c of readdirSync(full)) {
          if (devFilesHidden(c)) continue;
          hasChildren = true;
          break;
        }
      } catch { /* ignore */ }
    }

    entries.push({
      name,
      path: entryRel,
      is_dir: isDir,
      has_children: hasChildren,
      git_status: gitLabel,
      size,
    });
  }

  res.json({ path: relative(root, target).replace(/\\/g, "/") || ".", branch, entries });
};

// Canonical extension→language map. Kept identical in coverage to the Python
// master (tina4_python/tina4_python/dev_admin/__init__.py `lang_map`) and the
// PHP/Ruby file-read endpoints. The dev-admin SPA maps the returned "language"
// string to a CodeMirror grammar for syntax highlighting.
const DEV_ADMIN_LANG_MAP: Record<string, string> = {
  ".py": "python", ".php": "php", ".rb": "ruby",
  ".ts": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".tsx": "typescript", ".json": "json", ".html": "html",
  ".twig": "html", ".css": "css", ".scss": "css",
  ".md": "markdown", ".sql": "sql", ".yaml": "yaml",
  ".yml": "yaml", ".toml": "toml", ".xml": "html",
  ".env": "env", ".env.example": "env",
  ".sh": "shell", ".bash": "shell",
  ".bat": "shell", ".cmd": "shell", ".ps1": "shell",
  ".rs": "rust", ".go": "go", ".java": "java",
  ".txt": "text", ".csv": "text", ".log": "text",
  ".gemspec": "ruby", ".rake": "ruby",
  ".svg": "svg",
};

/**
 * Resolve a CodeMirror-friendly language id from a file path's basename.
 *
 * - `Dockerfile` / `Dockerfile.dev` / `Dockerfile.prod` (no extension) → "dockerfile"
 * - `.env.example` (two-part) and `.env` → "env"
 * - otherwise the file extension is looked up in DEV_ADMIN_LANG_MAP
 * - anything unknown → "text"
 */
export function devAdminLanguage(rel: string): string {
  const base = (rel.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (base === "dockerfile" || base === "dockerfile.dev" || base === "dockerfile.prod") {
    return "dockerfile";
  }
  // Two-part extension first (e.g. ".env.example"), then the single extension.
  if (base.endsWith(".env.example")) return DEV_ADMIN_LANG_MAP[".env.example"];
  const dot = base.lastIndexOf(".");
  // A leading dot with no other dot is a dotfile name, not an extension
  // (e.g. ".env" → ext ".env"); only treat as "no extension" when there's no dot.
  if (dot < 0) return "text";
  const ext = base.slice(dot);
  return DEV_ADMIN_LANG_MAP[ext] ?? "text";
}

const handleFileRead: RouteHandler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const rel = url.searchParams.get("path") ?? "";
  const root = resolve(process.cwd());
  const target = safeJoin(root, rel);
  if (!target || !existsSync(target) || !statSync(target).isFile()) {
    res.json({ error: `File not found: ${rel}` }, 404);
    return;
  }
  try {
    const content = readFileSync(target, "utf-8");
    const path = relative(root, target);
    res.json({ path, content, language: devAdminLanguage(path), bytes: Buffer.byteLength(content, "utf-8") });
  } catch (e) {
    res.json({ error: (e as Error).message }, 500);
  }
};

const handleFileSave: RouteHandler = async (req, res) => {
  const body = (req.body as Record<string, unknown>) || {};
  const rel = (body.path as string) || "";
  const content = (body.content as string) ?? "";
  const root = resolve(process.cwd());
  const target = safeJoin(root, rel);
  if (!target) {
    res.json({ error: `Path escapes project directory: ${rel}` }, 400);
    return;
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    const existed = existsSync(target);
    writeFileSync(target, content, "utf-8");
    try {
      const { Plan } = await import("./plan.js");
      Plan.recordAction(existed ? "patched" : "created", relative(root, target));
    } catch { /* ignore */ }
    res.json({ ok: true, path: relative(root, target), bytes: Buffer.byteLength(content, "utf-8") });
  } catch (e) {
    res.json({ error: (e as Error).message }, 500);
  }
};

const handleFileRaw: RouteHandler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const rel = url.searchParams.get("path") ?? "";
  const root = resolve(process.cwd());
  const target = safeJoin(root, rel);
  if (!target || !existsSync(target) || !statSync(target).isFile()) {
    res.raw.writeHead(404);
    res.raw.end("Not found");
    return;
  }
  try {
    const buf = readFileSync(target);
    const ext = target.slice(target.lastIndexOf(".") + 1).toLowerCase();
    const mime: Record<string, string> = {
      js: "application/javascript", ts: "text/plain", json: "application/json",
      html: "text/html", css: "text/css", svg: "image/svg+xml",
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      md: "text/markdown", txt: "text/plain",
    };
    res.raw.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
    res.raw.end(buf);
  } catch (e) {
    res.raw.writeHead(500);
    res.raw.end((e as Error).message);
  }
};

const handleFileRename: RouteHandler = async (req, res) => {
  const body = (req.body as Record<string, unknown>) || {};
  const from = (body.from as string) || "";
  const to = (body.to as string) || "";
  const root = resolve(process.cwd());
  const src = safeJoin(root, from);
  const dst = safeJoin(root, to);
  if (!src || !dst) {
    res.json({ error: "Invalid path" }, 400);
    return;
  }
  if (!existsSync(src)) {
    res.json({ error: `Source not found: ${from}` }, 404);
    return;
  }
  try {
    const { renameSync } = await import("node:fs");
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
    res.json({ ok: true, from: relative(root, src), to: relative(root, dst) });
  } catch (e) {
    res.json({ error: (e as Error).message }, 500);
  }
};

const handleFileDelete: RouteHandler = async (req, res) => {
  const body = (req.body as Record<string, unknown>) || {};
  const rel = (body.path as string) || "";
  const root = resolve(process.cwd());
  const target = safeJoin(root, rel);
  if (!target) {
    res.json({ error: "Invalid path" }, 400);
    return;
  }
  if (!existsSync(target)) {
    res.json({ error: `Not found: ${rel}` }, 404);
    return;
  }
  try {
    const { rmSync } = await import("node:fs");
    rmSync(target, { recursive: true, force: true });
    res.json({ ok: true, deleted: relative(root, target) });
  } catch (e) {
    res.json({ error: (e as Error).message }, 500);
  }
};

const handleDepsSearch: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const q = url.searchParams.get("q") ?? "";
  if (!q) {
    res.json({ error: "q required" }, 400);
    return;
  }
  try {
    const r = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=20`);
    const data = (await r.json()) as { objects?: Array<Record<string, any>> };
    const results = (data.objects || []).map((o) => ({
      name: o.package?.name,
      version: o.package?.version,
      description: o.package?.description,
      links: o.package?.links,
    }));
    res.json({ results });
  } catch (e) {
    res.json({ error: (e as Error).message }, 502);
  }
};

const handleDepsInstall: RouteHandler = async (req, res) => {
  const body = (req.body as Record<string, unknown>) || {};
  const pkg = (body.package as string) || "";
  const dev = Boolean(body.dev);
  if (!pkg || !/^[@A-Za-z0-9][\w@/.\-]*$/.test(pkg)) {
    res.json({ error: "invalid package name" }, 400);
    return;
  }
  try {
    const { execFileSync } = await import("node:child_process");
    const args = ["install", dev ? "--save-dev" : "--save", pkg];
    const output = execFileSync("npm", args, {
      cwd: resolve(process.cwd()),
      timeout: 120_000,
      encoding: "utf-8",
    }).toString();
    res.json({ ok: true, package: pkg, output });
  } catch (e) {
    res.json({ error: (e as Error).message }, 500);
  }
};

const handleGitStatus: RouteHandler = async (_req, res) => {
  try {
    const { execFileSync } = await import("node:child_process");
    const cwd = resolve(process.cwd());
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 3000 });
    } catch {
      res.json({ error: "Not a git repository" }, 400);
      return;
    }
    const run = (args: string[]): string =>
      execFileSync("git", args, { cwd, timeout: 3000, encoding: "utf-8" }).toString().trim();
    res.json({
      branch: run(["branch", "--show-current"]),
      status: run(["status", "--porcelain"]).split(/\r?\n/).filter((l) => l),
      recent_commits: run(["log", "--oneline", "-5"]).split(/\r?\n/).filter((l) => l),
    });
  } catch (e) {
    res.json({ error: `git unavailable: ${(e as Error).message}` }, 500);
  }
};

/** Constant-time string compare (length-guarded so timingSafeEqual never throws). */
function mcpSecureEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Whether the request carried a token matching TINA4_MCP_TOKEN (fallback
 * TINA4_API_KEY). Transports: Authorization Bearer / X-MCP-Token / X-Api-Key.
 * No configured token ⇒ a remote caller can never present a valid one.
 */
function mcpTokenOk(req: Tina4Request): boolean {
  let expected = process.env.TINA4_MCP_TOKEN;
  if (!expected) expected = process.env.TINA4_API_KEY;
  if (!expected) return false;
  let provided = "";
  const auth = req.header("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) provided = auth.slice(7).trim();
  if (!provided) provided = req.header("x-mcp-token") ?? "";
  if (!provided) provided = req.header("x-api-key") ?? "";
  if (!provided) return false;
  return mcpSecureEqual(expected, provided);
}

/**
 * Per-request MCP authorisation using the RAW socket peer (never X-Forwarded-For,
 * which is spoofable). Loopback is always allowed; a remote caller needs
 * TINA4_MCP_REMOTE=true plus a valid token. Mirrors the Python/PHP/Ruby gate.
 */
function mcpRequestAllowed(req: Tina4Request): boolean {
  const peer = (req as unknown as { socket?: { remoteAddress?: string } }).socket?.remoteAddress ?? "";
  return isRequestAllowed(peer, mcpTokenOk(req));
}

const handleMcpTools: RouteHandler = async (req, res) => {
  if (!mcpRequestAllowed(req)) {
    res.json({ tools: [], error: "MCP forbidden" }, 404);
    return;
  }
  try {
    // Ensure the default /__dev/mcp server exists with its dev tools registered,
    // then enumerate every registered MCP server instance (app-defined servers
    // register themselves on construction too).
    const { McpServer, getDefaultDevServer } = await import("./mcp.js");
    getDefaultDevServer();
    const instances = (McpServer as unknown as { _instances: Array<any> })._instances || [];
    const tools: Array<{ server: string; name: string; description: string; inputSchema: unknown }> = [];
    for (const s of instances) {
      for (const t of ((s as any)._tools as Map<string, any>).values()) {
        tools.push({ server: s.name, name: t.name, description: t.description, inputSchema: t.inputSchema });
      }
    }
    res.json({ tools, count: tools.length });
  } catch (e) {
    res.json({ error: (e as Error).message }, 500);
  }
};

const handleMcpCall: RouteHandler = async (req, res) => {
  if (!mcpRequestAllowed(req)) {
    res.json({ error: "MCP forbidden" }, 404);
    return;
  }
  const body = (req.body as Record<string, unknown>) || {};
  const name = (body.name as string) || "";
  const args = (body.arguments as Record<string, unknown>) || {};
  try {
    const { McpServer, getDefaultDevServer } = await import("./mcp.js");
    getDefaultDevServer();
    const instances = (McpServer as unknown as { _instances: Array<any> })._instances || [];
    for (const s of instances) {
      const tool = ((s as any)._tools as Map<string, any>).get(name);
      if (tool) {
        const result = await tool.handler(args);
        res.json({ ok: true, result });
        return;
      }
    }
    res.json({ error: `Unknown tool: ${name}` }, 404);
  } catch (e) {
    res.json({ error: (e as Error).message }, 500);
  }
};

/**
 * JSON-RPC message endpoint for real MCP clients.
 *
 * Mounted at POST /__dev/mcp (Streamable HTTP). Forwards the body to the default
 * dev MCP server via dispatchHttp(): initialize issues an Mcp-Session-Id header,
 * an unknown session id is 404 (client re-inits), a notification is 202, else
 * 200 with the JSON-RPC response as application/json. The /__dev path is always
 * public (auth-bypassed), so MCP clients connect without a token.
 */
function mcpNormalizeBody(body: unknown): string | Record<string, unknown> {
  if (typeof body === "object" && body !== null) return body as Record<string, unknown>;
  if (typeof body === "string") return body;
  return String(body ?? "");
}

function applyMcpOutcome(
  res: Parameters<RouteHandler>[1],
  outcome: { status: number; headers: Record<string, string>; body: string },
): void {
  for (const [n, v] of Object.entries(outcome.headers)) res.addHeader(n, v);
  if (!outcome.body) {
    res.send("", outcome.status);
    return;
  }
  res.json(JSON.parse(outcome.body), outcome.status);
}

const handleMcpStreamable: RouteHandler = async (req, res) => {
  if (!mcpRequestAllowed(req)) {
    res.json({ error: "MCP forbidden" }, 404);
    return;
  }
  try {
    const { getDefaultDevServer } = await import("./mcp.js");
    const server = getDefaultDevServer();
    const sessionId = req.header("mcp-session-id") ?? "";
    applyMcpOutcome(res, await server.dispatchHttp(mcpNormalizeBody(req.body), sessionId));
  } catch (e) {
    res.json({ error: (e as Error).message }, 500);
  }
};

/** DELETE /__dev/mcp — terminate the session named by Mcp-Session-Id. */
const handleMcpDelete: RouteHandler = async (req, res) => {
  if (!mcpRequestAllowed(req)) {
    res.json({ error: "MCP forbidden" }, 404);
    return;
  }
  const { getDefaultDevServer } = await import("./mcp.js");
  getDefaultDevServer().closeSession(req.header("mcp-session-id") ?? "");
  res.send("", 204);
};

/** GET /__dev/mcp — 405: this server initiates no messages (use /sse for a stream). */
const handleMcpGet405: RouteHandler = (req, res) => {
  if (!mcpRequestAllowed(req)) {
    res.json({ error: "MCP forbidden" }, 404);
    return;
  }
  res.addHeader("Allow", "POST, DELETE");
  res.json({ error: "method not allowed" }, 405);
};

/**
 * POST /__dev/mcp/message — legacy HTTP+SSE message sink. Delivers the JSON-RPC
 * response on the matching open SSE stream (202 here); with no open stream it
 * degrades to an inline Streamable HTTP response, so the path serves a plain
 * POST client too.
 */
const handleMcpLegacyMessage: RouteHandler = async (req, res) => {
  if (!mcpRequestAllowed(req)) {
    res.json({ error: "MCP forbidden" }, 404);
    return;
  }
  try {
    const { getDefaultDevServer } = await import("./mcp.js");
    const server = getDefaultDevServer();
    const sessionId = (req.query?.sessionId as string) || (req.header("mcp-session-id") ?? "");
    applyMcpOutcome(res, await server.dispatchSseMessage(mcpNormalizeBody(req.body), sessionId));
  } catch (e) {
    res.json({ error: (e as Error).message }, 500);
  }
};

/**
 * GET /__dev/mcp/sse — legacy HTTP+SSE stream. Opens a persistent SSE connection:
 * first the `endpoint` event naming the (session-tagged) POST target, then each
 * JSON-RPC response as it arrives. Node's single event loop lets a separate POST
 * to /message feed this stream via an in-process channel.
 */
const handleMcpSse: RouteHandler = async (req, res) => {
  if (!mcpRequestAllowed(req)) {
    res.json({ error: "MCP forbidden" }, 404);
    return;
  }
  const { getDefaultDevServer } = await import("./mcp.js");
  const server = getDefaultDevServer();
  const sessionId = server.openSession();
  const base = (req.path || "/__dev/mcp/sse").replace(/\/sse$/, "");
  await res.stream(server.sseStream(sessionId, `${base}/message?sessionId=${sessionId}`));
};

const handleScaffoldList: RouteHandler = (_req, res) => {
  res.json({
    scaffolds: [
      { name: "route", description: "Create a new route file in src/routes/" },
      { name: "model", description: "Create a new ORM model in src/models/" },
      { name: "migration", description: "Create a new SQL migration file" },
      { name: "middleware", description: "Create a new middleware class" },
    ],
  });
};

const handleScaffoldRun: RouteHandler = async (req, res) => {
  const body = (req.body as Record<string, unknown>) || {};
  const kind = (body.kind as string) || "";
  const name = (body.name as string) || "";
  if (!kind || !name || !/^[A-Za-z_][\w]*$/.test(name)) {
    res.json({ error: "kind and valid name required" }, 400);
    return;
  }
  try {
    const { execFileSync } = await import("node:child_process");
    const output = execFileSync("npx", ["tina4nodejs", "generate", kind, name], {
      cwd: resolve(process.cwd()),
      timeout: 30_000,
      encoding: "utf-8",
    }).toString();
    res.json({ ok: true, kind, name, output });
  } catch (e) {
    res.json({ error: (e as Error).message }, 500);
  }
};

// ── Plan routes ─────────────────────────────────────────────

const handlePlanCurrent: RouteHandler = async (_req, res) => {
  const { Plan } = await import("./plan.js");
  res.json(Plan.current());
};

const handlePlanList: RouteHandler = async (_req, res) => {
  const { Plan } = await import("./plan.js");
  res.json({ plans: Plan.listPlans() });
};

const handlePlanCreate: RouteHandler = async (req, res) => {
  const { Plan } = await import("./plan.js");
  const body = (req.body as Record<string, unknown>) || {};
  res.json(
    Plan.create(
      (body.title as string) || "",
      (body.goal as string) || "",
      (body.steps as string[]) || [],
      body.make_current !== false,
    ),
  );
};

const handlePlanSwitch: RouteHandler = async (req, res) => {
  const { Plan } = await import("./plan.js");
  const body = (req.body as Record<string, unknown>) || {};
  res.json(Plan.setCurrent((body.name as string) || ""));
};

const handlePlanCompleteStep: RouteHandler = async (req, res) => {
  const { Plan } = await import("./plan.js");
  const body = (req.body as Record<string, unknown>) || {};
  res.json(Plan.completeStep((body.index as number) ?? -1, (body.name as string) || ""));
};

const handlePlanAddStep: RouteHandler = async (req, res) => {
  const { Plan } = await import("./plan.js");
  const body = (req.body as Record<string, unknown>) || {};
  res.json(Plan.addStep((body.text as string) || "", (body.name as string) || ""));
};

const handlePlanNote: RouteHandler = async (req, res) => {
  const { Plan } = await import("./plan.js");
  const body = (req.body as Record<string, unknown>) || {};
  res.json(Plan.appendNote((body.text as string) || "", (body.name as string) || ""));
};

const handlePlanArchive: RouteHandler = async (req, res) => {
  const { Plan } = await import("./plan.js");
  const body = (req.body as Record<string, unknown>) || {};
  res.json(Plan.archive((body.name as string) || ""));
};

const handlePlanRead: RouteHandler = async (req, res) => {
  const { Plan } = await import("./plan.js");
  const url = new URL(req.url ?? "/", "http://localhost");
  const name = url.searchParams.get("name") ?? "";
  res.json(Plan.read(name));
};

const handlePlanFlesh: RouteHandler = async (req, res) => {
  const { Plan } = await import("./plan.js");
  const body = (req.body as Record<string, unknown>) || {};
  res.json(await Plan.flesh((body.name as string) || "", (body.prompt as string) || ""));
};

// ── Project index routes ────────────────────────────────────

const handleIndexRebuild: RouteHandler = async (_req, res) => {
  const { ProjectIndex } = await import("./projectIndex.js");
  res.json(ProjectIndex.refresh());
};

const handleIndexSearch: RouteHandler = async (req, res) => {
  const { ProjectIndex } = await import("./projectIndex.js");
  const url = new URL(req.url ?? "/", "http://localhost");
  const q = url.searchParams.get("q") ?? "";
  const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  res.json({ results: ProjectIndex.search(q, limit) });
};

const handleIndexFile: RouteHandler = async (req, res) => {
  const { ProjectIndex } = await import("./projectIndex.js");
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.searchParams.get("path") ?? "";
  res.json(ProjectIndex.fileEntry(p));
};

const handleIndexOverview: RouteHandler = async (_req, res) => {
  const { ProjectIndex } = await import("./projectIndex.js");
  res.json(ProjectIndex.overview());
};

// ---------------------------------------------------------------------------
// Live API RAG (Docs) — plan/v3/22-LIVE-API-RAG.md
// ---------------------------------------------------------------------------

const handleDocsSearch: RouteHandler = async (req, res) => {
  const { Docs } = await import("./docs.js");
  const url = new URL(req.url ?? "/", "http://localhost");
  const q = url.searchParams.get("q") ?? "";
  const k = parseInt(url.searchParams.get("k") ?? "5", 10);
  const source = url.searchParams.get("source") ?? "all";
  const includePrivate = isTruthy(url.searchParams.get("include_private") ?? "false");
  const start = Date.now();
  const results = Docs.mcpSearch(q, k, undefined, source, includePrivate);
  res.json({ ok: true, query: q, results, took_ms: Date.now() - start });
};

const handleDocsClass: RouteHandler = async (req, res) => {
  const { Docs } = await import("./docs.js");
  const url = new URL(req.url ?? "/", "http://localhost");
  const name = url.searchParams.get("name") ?? "";
  const spec = Docs.mcpClass(name);
  if (!spec) {
    res.json({ ok: false, error: `class not found: ${name}` }, 404);
    return;
  }
  res.json({ ok: true, class: spec });
};

const handleDocsMethod: RouteHandler = async (req, res) => {
  const { Docs } = await import("./docs.js");
  const url = new URL(req.url ?? "/", "http://localhost");
  const cls = url.searchParams.get("class") ?? "";
  const name = url.searchParams.get("name") ?? "";
  const spec = Docs.mcpMethod(cls, name);
  if (!spec) {
    res.json({ ok: false, error: `method not found: ${cls}.${name}` }, 404);
    return;
  }
  res.json({ ok: true, method: spec });
};

const handleDocsIndex: RouteHandler = async (req, res) => {
  const { Docs } = await import("./docs.js");
  const url = new URL(req.url ?? "/", "http://localhost");
  const source = url.searchParams.get("source") ?? "all";
  const docs = new (Docs as any)(process.cwd());
  let entries: any[] = docs.index();
  if (source !== "all") entries = entries.filter((e) => e.source === source);
  res.json({ ok: true, count: entries.length, entries });
};

const handleDocsWellKnown: RouteHandler = async (_req, res) => {
  res.json({
    ok: true,
    name: "tina4-live-docs",
    description: "Live API docs for this Tina4 project (framework + user code)",
    spec: "plan/v3/22-LIVE-API-RAG.md",
    endpoints: {
      search: "/__dev/api/docs/search?q=<query>&k=<int>&source=<framework|user|all>&include_private=<bool>",
      class: "/__dev/api/docs/class?name=<fqn>",
      method: "/__dev/api/docs/method?class=<fqn>&name=<method>",
      index: "/__dev/api/docs/index?source=<framework|user|all>",
    },
    mcp_tools: ["api_search", "api_class", "api_method"],
  });
};

// ---------------------------------------------------------------------------
// Dev Admin JS handler — serves the shared JS file
// ---------------------------------------------------------------------------

const handleDevAdminJs: RouteHandler = async (_req, res) => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { dirname, join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = dirname(fileURLToPath(import.meta.url));

  // Try multiple paths — handles both monorepo dev and npm-installed package
  const candidates = [
    join(dir, "..", "public", "js", "tina4-dev-admin.min.js"),           // src/../public/js/
    join(dir, "..", "..", "public", "js", "tina4-dev-admin.min.js"),     // deeper nesting
    resolve(process.cwd(), "node_modules", "tina4-nodejs", "packages", "core", "public", "js", "tina4-dev-admin.min.js"),
    resolve(process.cwd(), "public", "js", "tina4-dev-admin.min.js"),   // project public/
  ];

  for (const jsPath of candidates) {
    if (existsSync(jsPath)) {
      try {
        const content = readFileSync(jsPath, "utf-8");
        res.raw.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" });
        res.raw.end(content);
        return;
      } catch { /* try next */ }
    }
  }

  // File not found — no legacy fallback
  res.raw.writeHead(404, { "Content-Type": "text/plain" });
  res.raw.end("tina4-dev-admin.min.js not found");
};

// ---------------------------------------------------------------------------
// Overlay script — floating Tina4 button
// ---------------------------------------------------------------------------

function renderToolbarHtml(ctx: {
  version: string;
  method: string;
  path: string;
  matchedPattern: string;
  requestId: string;
  routeCount: number;
}): string {
  const nodeVersion = process.version;
  return `<div id="tina4-dev-toolbar" style="position:fixed;bottom:0;left:0;right:0;background:#333;color:#fff;font-family:monospace;font-size:12px;padding:6px 16px;z-index:99999;display:flex;align-items:center;gap:16px;">
    <span id="tina4-ver-btn" style="color:#2e7d32;font-weight:bold;cursor:pointer;text-decoration:underline dotted;" onclick="tina4VersionModal()" title="Click to check for updates">Tina4 v${ctx.version}</span>
    <div id="tina4-ver-modal" style="display:none;position:fixed;bottom:3rem;left:1rem;background:#1e1e2e;border:1px solid #2e7d32;border-radius:8px;padding:16px 20px;z-index:100000;min-width:320px;box-shadow:0 8px 32px rgba(0,0,0,0.5);font-family:monospace;font-size:13px;color:#cdd6f4;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <strong style="color:#89b4fa;">Version Info</strong>
        <span onclick="document.getElementById('tina4-ver-modal').style.display='none'" style="cursor:pointer;color:#888;">&times;</span>
      </div>
      <div id="tina4-ver-body" style="line-height:1.8;">
        <div>Current: <strong style="color:#a6e3a1;">v${ctx.version}</strong></div>
        <div id="tina4-ver-latest" style="color:#888;">Checking for updates...</div>
      </div>
    </div>
    <span style="color:#4caf50;">${ctx.method}</span>
    <span>${ctx.path}</span>
    <span style="color:#666;">&rarr; ${ctx.matchedPattern}</span>
    <span style="color:#ffeb3b;">req:${ctx.requestId}</span>
    <span style="color:#90caf9;">${ctx.routeCount} routes</span>
    <span style="color:#888;">Node.js ${nodeVersion}</span>
    <a href="#" onclick="window.__tina4ToggleOverlay(event)" style="color:#ef9a9a;margin-left:auto;text-decoration:none;cursor:pointer;">Dashboard &#8599;</a>
    <span onclick="this.parentElement.style.display='none'" style="cursor:pointer;color:#888;margin-left:8px;">&#10005;</span>
</div>
<script>
// Overlay open/toggle helper + auto-restore. Persist the dev-admin
// iframe's open/closed state across parent reloads so saving a file
// doesn't lose the user's dev-admin context. Cross-framework parity
// with PHP / Python / Ruby — same localStorage key.
(function(){
    var STATE_KEY = 'tina4_dev_overlay_open';
    function buildOverlay() {
        var c = document.createElement('div');
        c.id = 'tina4-dev-panel';
        c.style.cssText = 'position:fixed;top:3rem;left:0;right:0;bottom:2rem;z-index:99998;transition:all 0.2s';
        var f = document.createElement('iframe');
        f.src = '/__dev';
        f.style.cssText = 'width:100%;height:100%;border:1px solid #2e7d32;border-radius:0.5rem;box-shadow:0 8px 32px rgba(0,0,0,0.5);background:#0f172a';
        c.appendChild(f);
        document.body.appendChild(c);
        return c;
    }
    window.__tina4ToggleOverlay = function(e) {
        if (e) e.preventDefault();
        var p = document.getElementById('tina4-dev-panel');
        if (p) {
            var hide = p.style.display !== 'none';
            p.style.display = hide ? 'none' : 'block';
            try { localStorage.setItem(STATE_KEY, hide ? '0' : '1'); } catch (_) {}
            return;
        }
        buildOverlay();
        try { localStorage.setItem(STATE_KEY, '1'); } catch (_) {}
    };
    function restoreIfOpen() {
        try {
            if (location.pathname.indexOf('/__dev') === 0) return;
            if (localStorage.getItem(STATE_KEY) === '1' && !document.getElementById('tina4-dev-panel')) {
                buildOverlay();
            }
        } catch (_) {}
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', restoreIfOpen);
    } else {
        restoreIfOpen();
    }
})();
</script>
<script>
function tina4VersionModal(){
    var m=document.getElementById('tina4-ver-modal');
    if(m.style.display==='block'){m.style.display='none';return;}
    m.style.display='block';
    var el=document.getElementById('tina4-ver-latest');
    el.innerHTML='Checking for updates...';
    el.style.color='#888';
    fetch('/__dev/api/version-check')
    .then(function(r){return r.json()})
    .then(function(d){
        var latest=d.latest;
        var current=d.current;
        if(latest===current){
            el.innerHTML='Latest: <strong style="color:#a6e3a1;">v'+latest+'</strong> &mdash; You are up to date!';
            el.style.color='#a6e3a1';
        }else{
            var cParts=current.split('.').map(Number);
            var lParts=latest.split('.').map(Number);
            var isNewer=false;
            for(var i=0;i<Math.max(cParts.length,lParts.length);i++){
                var c=cParts[i]||0,l=lParts[i]||0;
                if(l>c){isNewer=true;break;}
                if(l<c)break;
            }
            var isAhead=false;
            if(!isNewer){for(var i=0;i<Math.max(cParts.length,lParts.length);i++){var c2=cParts[i]||0,l2=lParts[i]||0;if(c2>l2){isAhead=true;break;}if(c2<l2)break;}}
            if(isNewer){
                var breaking=(lParts[0]!==cParts[0]||lParts[1]!==cParts[1]);
                el.innerHTML='Latest: <strong style="color:#f9e2af;">v'+latest+'</strong>';
                if(breaking){
                    el.innerHTML+='<div style="color:#f38ba8;margin-top:6px;">&#9888; Major/minor version change &mdash; check the <a href="https://github.com/tina4stack/tina4-nodejs/releases" target="_blank" style="color:#89b4fa;">changelog</a> for breaking changes before upgrading.</div>';
                }else{
                    el.innerHTML+='<div style="color:#f9e2af;margin-top:6px;">Patch update available. Run: <code style="background:#313244;padding:2px 6px;border-radius:3px;">npm install tina4-nodejs@latest</code></div>';
                }
            }else if(isAhead){
                el.innerHTML='You are running <strong style="color:#cba6f7;">v'+current+'</strong> (ahead of npm <strong>v'+latest+'</strong> &mdash; not yet published).';
                el.style.color='#cba6f7';
            }else{
                el.innerHTML='Latest: <strong style="color:#a6e3a1;">v'+latest+'</strong> &mdash; You are up to date!';
                el.style.color='#a6e3a1';
            }
        }
    })
    .catch(function(){
        el.innerHTML='Could not check for updates (offline?)';
        el.style.color='#f38ba8';
    });
}
</script>
<script>
(function(){
    // WebSocket-primary dev reloader. The running server re-imports changed
    // src/ routes in-process and pushes a {type,file,mtime} message over
    // /__dev_reload — no respawn, instant refresh. The mtime poll below is a
    // FALLBACK only, started when the socket is down and stopped on connect.
    var _t4_css_exts=['.css','.scss'],_t4_debounce=null;
    var _t4_interval=3000;
    var _t4_ws=null,_t4_poll_timer=null,_t4_mtime=null;
    function _t4_apply(d){
        d=d||{};
        var f=d.file||'',t=d.type||'';
        var isCss=t==='css'||_t4_css_exts.some(function(e){return f.endsWith(e)});
        if(isCss){
            var links=document.querySelectorAll('link[rel="stylesheet"]');
            links.forEach(function(l){
                var href=l.getAttribute('href');
                if(href){l.setAttribute('href',href.split('?')[0]+'?_t4='+(d.mtime||Date.now()))}
            });
        }else{
            location.reload();
        }
    }
    function _t4_poll(){
        fetch('/__dev/api/mtime').then(function(r){return r.json()}).then(function(d){
            // Sentinel: first poll only records the baseline. Use !== (not >) so
            // the first change after load is not swallowed and a counter reset on
            // server restart still triggers a reload.
            if(_t4_mtime===null){_t4_mtime=d.mtime;return;}
            if(d.mtime!==_t4_mtime){
                _t4_mtime=d.mtime;
                if(_t4_debounce)clearTimeout(_t4_debounce);
                _t4_debounce=setTimeout(function(){_t4_apply(d);},500);
            }
        }).catch(function(){});
    }
    function _t4_startPoll(){
        if(_t4_poll_timer)return;
        _t4_mtime=null;
        _t4_poll_timer=setInterval(_t4_poll,_t4_interval);
    }
    function _t4_stopPoll(){
        if(_t4_poll_timer){clearInterval(_t4_poll_timer);_t4_poll_timer=null;}
    }
    function _t4_connect(){
        var url=(location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/__dev_reload';
        try{_t4_ws=new WebSocket(url);}catch(_){_t4_startPoll();return;}
        _t4_ws.addEventListener('open',function(){_t4_stopPoll();});
        _t4_ws.addEventListener('message',function(ev){
            var d=null;
            try{d=typeof ev.data==='string'?JSON.parse(ev.data):null;}catch(_){}
            if(!d)return;
            if(d.type==='reload'||d.type==='change'||d.type==='css'){
                if(_t4_debounce)clearTimeout(_t4_debounce);
                _t4_debounce=setTimeout(function(){_t4_apply(d);},150);
            }
        });
        _t4_ws.addEventListener('close',function(){_t4_ws=null;_t4_startPoll();setTimeout(_t4_connect,2000);});
        _t4_ws.addEventListener('error',function(){try{_t4_ws&&_t4_ws.close();}catch(_){}});
    }
    _t4_connect();
})();
</script>`;
}
