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
import type { RouteHandler } from "./types.js";
import { DevMailbox } from "./devMailbox.js";
import { isTruthy } from "./dotenv.js";
import { quickMetrics, fullAnalysis, fileDetail } from "./metrics.js";

const cpuCount = osCpus().length;

const TINA4_VERSION = "3.10.34";

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

  static track(message: string, stack?: string): void {
    this.errors.push({
      id: `err_${Date.now()}_${this.errors.length}`,
      timestamp: new Date().toISOString(),
      message,
      stack,
      resolved: false,
    });
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
    const routes: Array<{ method: string; pattern: string; handler: RouteHandler }> = [
      // Dashboard
      { method: "GET", pattern: "/__dev", handler: handleDashboard },
      { method: "GET", pattern: "/__dev/", handler: handleDashboard },
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
      // Chat
      { method: "POST", pattern: "/__dev/api/chat", handler: handleChat },
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
      // Version check (proxy to avoid CORS)
      { method: "GET", pattern: "/__dev/api/version-check", handler: handleVersionCheck },
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
  res.raw.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.raw.end(renderDashboard());
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
      const { getAdapter } = await import("@tina4/orm");
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
      .map((r) => ({
        method: r.method,
        path: r.pattern,
        filePath: r.filePath ?? null,
        hasMiddleware: (r.middlewares?.length ?? 0) > 0,
        meta: r.meta ?? null,
      }));
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
    const { getAdapter } = await import("@tina4/orm");
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

const handleQueue: RouteHandler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const statusFilter = url.searchParams.get("status") ?? "";
  const data = DevQueue.stats();
  let jobs = data.jobs;
  if (statusFilter) {
    jobs = jobs.filter((j) => j.status === statusFilter);
  }
  // Map to shared JS format: topic, attempts, created_at, data
  const mappedJobs = jobs.map((j) => ({
    id: j.id,
    topic: j.name,
    status: j.status,
    attempts: 1,
    created_at: j.timestamp,
    data: j.payload ?? {},
  }));
  res.json({
    stats: { pending: data.pending, completed: data.completed, failed: data.failed, reserved: data.reserved },
    jobs: mappedJobs,
  });
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

// -- Database handlers (stubs) --

const handleTable: RouteHandler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const name = url.searchParams.get("name") ?? "";
  if (!name) {
    res.json({ error: "Missing table name parameter" });
    return;
  }
  // Stub response — actual implementation will use ORM adapter
  res.json({ table: name, columns: [], rows: [], message: "Database not connected or table not found" });
};

const handleTables: RouteHandler = async (_req, res) => {
  try {
    const { getAdapter } = await import("@tina4/orm");
    const db = getAdapter();
    const tables = db.tables();
    res.json({ tables });
  } catch {
    res.json({ tables: [], message: "Database not connected" });
  }
};

const handleSeed: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const table = url.searchParams.get("table") ?? (req as any).body?.table ?? "";
  const count = parseInt(String(url.searchParams.get("count") ?? (req as any).body?.count ?? "10"), 10) || 10;
  if (!table) {
    res.json({ error: "Missing table parameter" });
    return;
  }
  try {
    const orm = await import("@tina4/orm");
    const db = orm.getAdapter();
    const { seedTable } = orm;
    const fake = new orm.FakeData();
    const columns = db.columns(table);
    if (!columns.length) {
      res.json({ error: `Table '${table}' not found or has no columns` });
      return;
    }
    // Build a field map based on column info
    const fieldMap: Record<string, () => unknown> = {};
    for (const col of columns) {
      const name = col.name.toLowerCase();
      const type = col.type.toLowerCase();
      if (name === "id") continue; // skip primary key
      if (name.includes("email")) { fieldMap[col.name] = () => fake.email(); }
      else if (name.includes("name")) { fieldMap[col.name] = () => fake.name(); }
      else if (name.includes("phone")) { fieldMap[col.name] = () => fake.phone(); }
      else if (name.includes("address") || name.includes("city") || name.includes("country")) { fieldMap[col.name] = () => fake.address(); }
      else if (name.includes("url") || name.includes("website")) { fieldMap[col.name] = () => fake.url(); }
      else if (type.includes("int")) { fieldMap[col.name] = () => fake.integer(1, 1000); }
      else if (type.includes("real") || type.includes("float") || type.includes("double") || type.includes("numeric") || type.includes("decimal")) { fieldMap[col.name] = () => fake.decimal(0, 1000, 2); }
      else if (type.includes("bool")) { fieldMap[col.name] = () => fake.boolean(); }
      else if (type.includes("date") || type.includes("time")) { fieldMap[col.name] = () => fake.date(); }
      else { fieldMap[col.name] = () => fake.sentence(3); }
    }
    let inserted = 0;
    for (let i = 0; i < count; i++) {
      const row: Record<string, unknown> = {};
      for (const [col, gen] of Object.entries(fieldMap)) {
        row[col] = gen();
      }
      try {
        db.insert(table, row);
        inserted++;
      } catch { /* skip failed rows */ }
    }
    res.json({ inserted, table });
  } catch {
    res.json({ error: "Database not connected" });
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
    const { getAdapter } = await import("@tina4/orm");
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
  ErrorTracker.clearResolved();
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

// -- Chat handler --

const handleChat: RouteHandler = (req, res) => {
  const message = (req as any).body?.message ?? "";
  if (!message) {
    res.json({ error: "Missing message parameter" });
    return;
  }
  // Placeholder AI chat response
  res.json({
    reply: `AI chat is not yet configured. You said: "${message}"`,
    timestamp: new Date().toISOString(),
  });
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
    url: env.DATABASE_URL ?? "",
    username: env.DATABASE_USERNAME ?? "",
    password: env.DATABASE_PASSWORD ? "***" : "",
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
    const { initDatabase } = await import("@tina4/orm").catch(() => ({ initDatabase: null }));
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
      if (urlLower.includes("sqlite")) {
        const row = db.execute("SELECT sqlite_version() as v") as Record<string, unknown>[] | undefined;
        version = `SQLite ${(row as any)?.[0]?.v ?? ""}`;
      } else if (urlLower.includes("postgres")) {
        const row = db.execute("SELECT version() as v") as Record<string, unknown>[] | undefined;
        version = ((row as any)?.[0]?.v ?? "PostgreSQL").toString().split(",")[0];
      } else if (urlLower.includes("mysql")) {
        const row = db.execute("SELECT version() as v") as Record<string, unknown>[] | undefined;
        version = `MySQL ${(row as any)?.[0]?.v ?? ""}`;
      } else if (urlLower.includes("mssql")) {
        const row = db.execute("SELECT @@VERSION as v") as Record<string, unknown>[] | undefined;
        version = ((row as any)?.[0]?.v ?? "MSSQL").toString().split("\n")[0];
      } else if (urlLower.includes("firebird")) {
        const row = db.execute("SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') as v FROM rdb$database") as Record<string, unknown>[] | undefined;
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
    const keysFound: Record<string, boolean> = { DATABASE_URL: false, DATABASE_USERNAME: false, DATABASE_PASSWORD: false };
    const newLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        newLines.push(line);
        continue;
      }
      const key = trimmed.split("=", 1)[0].trim();
      if (key === "DATABASE_URL") { newLines.push(`DATABASE_URL=${url}`); keysFound.DATABASE_URL = true; }
      else if (key === "DATABASE_USERNAME") { newLines.push(`DATABASE_USERNAME=${username}`); keysFound.DATABASE_USERNAME = true; }
      else if (key === "DATABASE_PASSWORD") { newLines.push(`DATABASE_PASSWORD=${password}`); keysFound.DATABASE_PASSWORD = true; }
      else { newLines.push(line); }
    }
    const values: Record<string, string> = { DATABASE_URL: url, DATABASE_USERNAME: username, DATABASE_PASSWORD: password };
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
// Dev Admin JS handler — serves the shared JS file
// ---------------------------------------------------------------------------

const handleDevAdminJs: RouteHandler = (_req, res) => {
  res.raw.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" });
  res.raw.end(renderDevAdminJs());
};

// ---------------------------------------------------------------------------
// Shared Dev Admin JS — cross-language, vanilla JS, zero dependencies
// ---------------------------------------------------------------------------

function renderAppShell(): string[] {
  return [
    "let currentTab = 'routes';",
    "let queueFilter = '';",
    "let mailboxFolder = '';",
    "",
    "function showTab(tab, e) {",
    "    currentTab = tab;",
    "    document.querySelectorAll('.dev-tab').forEach(function(t) { t.classList.remove('active'); });",
    "    document.querySelectorAll('.dev-panel').forEach(function(p) { p.classList.add('hidden'); });",
    "    if (e) e.target.closest('.dev-tab').classList.add('active');",
    "    document.getElementById('panel-' + tab).classList.remove('hidden');",
    "    var loaders = {routes:loadRoutes, queue:loadQueue, mailbox:loadMailbox, messages:loadMessages, database:loadTables, requests:loadRequests, errors:loadErrors, websockets:loadWebSockets, system:loadSystem, tools:function(){}};",
    "    if (loaders[tab]) loaders[tab]();",
    "}",
    "",
    "function api(path, method, body) {",
    "    var opts = { method: method || 'GET', headers: {} };",
    "    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }",
    "    return fetch(path, opts).then(function(r) { return r.json(); });",
    "}",
  ];
}

function renderRoutesTab(): string[] {
  return [
    "// -- Routes --",
    "function loadRoutes() {",
    "    api('/__dev/api/routes').then(function(d) {",
    "        document.getElementById('routes-count').textContent = d.count;",
    "        document.getElementById('routes-body').innerHTML = d.routes.map(function(r) {",
    "            return '<tr>' +",
    "                '<td><span class=\"method method-' + r.method.toLowerCase() + '\">' + r.method + '</span></td>' +",
    "                '<td class=\"path\"><a href=\"' + (r.path || r.pattern || '') + '\" target=\"_blank\" title=\"' + (r.method !== 'GET' ? r.method + ' route \\u2014 may not respond to browser GET' : 'Open in new tab') + '\" style=\"color:inherit;text-decoration:underline dotted;' + (r.method !== 'GET' ? 'opacity:0.7' : '') + '\">' + (r.path || r.pattern || '') + '</a></td>' +",
    "                '<td>' + (r.auth_required || r.secure ? '<span class=\"badge-pill bg-reserved\">auth</span>' : '<span class=\"badge-pill bg-success\">open</span>') + '</td>' +",
    "                '<td class=\"text-sm text-muted\">' + (r.handler || '') + (r.module ? ' <small>(' + r.module + ')</small>' : '') + '</td>' +",
    "            '</tr>';",
    "        }).join('');",
    "    });",
    "}",
  ];
}

function renderQueueTab(): string[] {
  return [
    "// -- Queue --",
    "function loadQueue() {",
    "    var qs = queueFilter ? '?status=' + queueFilter : '';",
    "    api('/__dev/api/queue' + qs).then(function(d) {",
    "        ['pending','completed','failed','reserved'].forEach(function(s) {",
    "            var el = document.getElementById('q-' + s);",
    "            if (el) el.textContent = d.stats[s] || 0;",
    "        });",
    "        document.getElementById('queue-count').textContent = Object.values(d.stats).reduce(function(a,b){return a+b;}, 0);",
    "        var tbody = document.getElementById('queue-body');",
    "        var empty = document.getElementById('queue-empty');",
    "        if (!d.jobs.length) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }",
    "        empty.classList.add('hidden');",
    "        tbody.innerHTML = d.jobs.map(function(j) {",
    "            return '<tr>' +",
    "                '<td>' + j.id + '</td>' +",
    "                '<td class=\"path\">' + j.topic + '</td>' +",
    "                '<td><span class=\"badge-pill bg-' + j.status + '\">' + j.status + '</span></td>' +",
    "                '<td>' + j.attempts + '</td>' +",
    "                '<td class=\"text-sm text-muted\">' + (j.created_at || '') + '</td>' +",
    "                '<td class=\"text-mono text-sm\" style=\"max-width:250px;overflow:hidden;text-overflow:ellipsis\">' + (typeof j.data === 'object' ? JSON.stringify(j.data) : j.data) + '</td>' +",
    "                '<td><button class=\"btn btn-sm\" onclick=\"replayJob(\\'' + j.id + '\\',\\'' + j.topic + '\\')\">Replay</button></td>' +",
    "            '</tr>';",
    "        }).join('');",
    "    });",
    "}",
    "function filterQueue(status, e) {",
    "    queueFilter = status;",
    "    document.querySelectorAll('#panel-queue .filter-btn').forEach(function(b) { b.classList.remove('active'); });",
    "    if (e) e.target.classList.add('active');",
    "    loadQueue();",
    "}",
    "function retryQueue() { api('/__dev/api/queue/retry', 'POST', {}).then(function() { loadQueue(); }); }",
    "function purgeQueue() { api('/__dev/api/queue/purge', 'POST', {}).then(function() { loadQueue(); }); }",
    "function replayJob(id, topic) { api('/__dev/api/queue/replay', 'POST', {job_id: id, topic: topic}).then(function() { loadQueue(); }); }",
  ];
}

function renderMailboxTab(): string[] {
  return [
    "// -- Mailbox --",
    "function loadMailbox() {",
    "    var qs = mailboxFolder ? '?folder=' + mailboxFolder : '';",
    "    api('/__dev/api/mailbox' + qs).then(function(d) {",
    "        document.getElementById('mailbox-count').textContent = d.unread;",
    "        document.getElementById('mail-detail').classList.add('hidden');",
    "        var list = document.getElementById('mailbox-list');",
    "        if (!d.messages.length) { list.innerHTML = '<div class=\"empty\">No messages. Click \"Seed 5\" to generate test emails.</div>'; return; }",
    "        list.innerHTML = d.messages.map(function(m) {",
    "            return '<div class=\"mail-item ' + (m.read ? '' : 'unread') + '\" onclick=\"readMail(\\'' + m.id + '\\')\">'+",
    "                '<span class=\"text-sm text-muted\" style=\"float:right\">' + (m.date||'').substring(0,16) + '</span>'+",
    "                '<div class=\"text-sm text-muted\">' + m.from + ' &rarr; ' + (m.to||[]).join(', ') + '</div>'+",
    "                '<div style=\"font-weight:600;font-size:0.8rem\">' + m.subject + '</div>'+",
    "                '<span class=\"badge-pill bg-' + (m.type === 'inbox' ? 'success' : 'primary') + '\" style=\"margin-top:0.2rem\">' + m.type + '</span>'+",
    "            '</div>';",
    "        }).join('');",
    "    });",
    "}",
    "function filterMailbox(folder, e) {",
    "    mailboxFolder = folder;",
    "    document.querySelectorAll('#panel-mailbox .filter-btn').forEach(function(b) { b.classList.remove('active'); });",
    "    if (e) e.target.classList.add('active');",
    "    loadMailbox();",
    "}",
    "function readMail(id) {",
    "    api('/__dev/api/mailbox/read?id=' + id).then(function(m) {",
    "        var det = document.getElementById('mail-detail');",
    "        det.classList.remove('hidden');",
    "        det.innerHTML = '<h3 style=\"font-size:0.9rem\">' + m.subject + '</h3>'+",
    "            '<p class=\"text-sm text-muted\">From: ' + m.from + ' | To: ' + (m.to||[]).join(', ') + ' | ' + m.date + '</p>'+",
    "            '<div style=\"background:var(--bg);padding:0.75rem;border-radius:var(--radius);margin-top:0.5rem;font-size:0.8rem\">' + (m.html ? m.body : '<pre>' + (m.body||'') + '</pre>') + '</div>';",
    "    });",
    "}",
    "function seedMailbox() { api('/__dev/api/mailbox/seed', 'POST', {count:5}).then(function() { loadMailbox(); }); }",
    "function clearMailbox() { api('/__dev/api/mailbox/clear', 'POST', {}).then(function() { loadMailbox(); }); }",
  ];
}

function renderMessagesTab(): string[] {
  return [
    "// -- Messages --",
    "function loadMessages() {",
    "    api('/__dev/api/messages').then(function(d) {",
    "        document.getElementById('messages-count').textContent = d.counts.total || 0;",
    "        renderMessages(d.messages);",
    "    });",
    "}",
    "function searchMessages() {",
    "    var q = document.getElementById('msg-search').value.trim();",
    "    if (!q) { loadMessages(); return; }",
    "    api('/__dev/api/messages/search?q=' + encodeURIComponent(q)).then(function(d) { renderMessages(d.messages); });",
    "}",
    "function renderMessages(messages) {",
    "    var list = document.getElementById('messages-list');",
    "    var empty = document.getElementById('messages-empty');",
    "    if (!messages.length) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }",
    "    empty.classList.add('hidden');",
    "    list.innerHTML = messages.map(function(m) {",
    "        return '<div class=\"msg-entry\">'+",
    "            '<span class=\"time\">' + (m.timestamp||'').substring(11,19) + '</span> '+",
    "            '<span class=\"cat\">' + m.category + '</span> '+",
    "            '<span class=\"level-' + m.level + '\">[' + m.level + ']</span> '+",
    "            esc(m.message) +",
    "            (m.data ? ' <code class=\"text-sm text-muted\">' + JSON.stringify(m.data) + '</code>' : '') +",
    "        '</div>';",
    "    }).join('');",
    "}",
    "function clearMessages() { api('/__dev/api/messages/clear', 'POST', {}).then(function() { loadMessages(); }); }",
  ];
}

function renderDatabaseTab(): string[] {
  return [
    "// -- Database --",
    "var _currentTable = '';",
    "",
    "function _clipCopy(text, btn) {",
    "    var orig = btn.textContent;",
    "    var ta = document.createElement('textarea');",
    "    ta.value = text;",
    "    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';",
    "    document.body.appendChild(ta);",
    "    ta.focus();",
    "    ta.select();",
    "    try { document.execCommand('copy'); btn.textContent = 'Copied!'; btn.style.color = 'var(--success)'; }",
    "    catch(e) { btn.textContent = 'Failed'; btn.style.color = 'var(--danger)'; }",
    "    document.body.removeChild(ta);",
    "    setTimeout(function() { btn.textContent = orig; btn.style.color = ''; }, 1500);",
    "}",
    "",
    "function copyResults(fmt, btn) {",
    "    var el = document.getElementById('query-results');",
    "    var tbl = el ? el.querySelector('table') : null;",
    "    if (!tbl) { btn.textContent = 'No data'; btn.style.color = 'var(--danger)'; setTimeout(function() { btn.textContent = fmt === 'json' ? 'Copy JSON' : 'Copy CSV'; btn.style.color = ''; }, 1500); return; }",
    "    var headerCells = tbl.querySelectorAll('thead th');",
    "    var headers = []; headerCells.forEach(function(h) { headers.push(h.textContent); });",
    "    var bodyRows = tbl.querySelectorAll('tbody tr');",
    "    var data = [];",
    "    bodyRows.forEach(function(row) {",
    "        var cells = row.querySelectorAll('td');",
    "        var obj = {};",
    "        cells.forEach(function(c, i) { obj[headers[i] || ('col' + i)] = c.textContent === 'null' ? null : c.textContent; });",
    "        data.push(obj);",
    "    });",
    "    var text = '';",
    "    if (fmt === 'json') {",
    "        text = JSON.stringify(data, null, 2);",
    "    } else {",
    "        var lines = [headers.join(',')];",
    "        data.forEach(function(r) {",
    "            lines.push(headers.map(function(h) { var v = (r[h] !== null ? r[h] : ''); return v.indexOf(',') >= 0 || v.indexOf('\"') >= 0 ? '\"' + v.replace(/\"/g, '\"\"') + '\"' : v; }).join(','));",
    "        });",
    "        text = lines.join(String.fromCharCode(10));",
    "    }",
    "    _clipCopy(text, btn);",
    "}",
    "",
    "function pasteData() {",
    "    var NL = String.fromCharCode(10);",
    "    var TAB = String.fromCharCode(9);",
    "    var overlay = document.createElement('div');",
    "    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center';",
    "    var box = document.createElement('div');",
    "    box.style.cssText = 'background:var(--bg,#1e293b);border:1px solid var(--border,#334155);border-radius:0.5rem;padding:1rem;width:500px;max-width:90vw';",
    "    box.innerHTML = '<div style=\"font-weight:600;margin-bottom:0.5rem;color:var(--text,#e2e8f0)\">Paste Data</div><div style=\"font-size:0.75rem;color:var(--muted,#94a3b8);margin-bottom:0.5rem\">Paste JSON array or CSV/tab-separated data below</div>';",
    "    var ta = document.createElement('textarea');",
    "    ta.style.cssText = 'width:100%;height:150px;font-family:monospace;font-size:0.75rem;background:var(--bg-alt,#0f172a);color:var(--text,#e2e8f0);border:1px solid var(--border,#334155);border-radius:0.25rem;padding:0.5rem;resize:vertical';",
    "    ta.placeholder = 'Paste here (Ctrl+V)...';",
    "    var btns = document.createElement('div');",
    "    btns.style.cssText = 'display:flex;gap:0.5rem;margin-top:0.5rem;justify-content:flex-end';",
    "    var cancelBtn = document.createElement('button');",
    "    cancelBtn.className = 'btn btn-sm'; cancelBtn.textContent = 'Cancel';",
    "    cancelBtn.onclick = function() { document.body.removeChild(overlay); };",
    "    var goBtn = document.createElement('button');",
    "    goBtn.className = 'btn btn-sm btn-primary'; goBtn.textContent = 'Generate SQL';",
    "    goBtn.onclick = function() {",
    "        var text = ta.value.trim();",
    "        if (!text) { alert('Paste some data first'); return; }",
    "        var upper = text.substring(0, 50).toUpperCase();",
    "        if (upper.indexOf('INSERT ') >= 0 || upper.indexOf('CREATE ') >= 0 || upper.indexOf('SELECT ') >= 0) {",
    "            document.getElementById('query-input').value = text;",
    "            document.body.removeChild(overlay);",
    "            return;",
    "        }",
    "        var rows = [];",
    "        var parsed = null;",
    "        try { parsed = JSON.parse(text); } catch(e) {}",
    "        if (parsed && Array.isArray(parsed) && parsed.length > 0) {",
    "            rows = parsed;",
    "        } else {",
    "            var lines = text.split(NL);",
    "            if (lines.length < 2) { alert('Need a header row + at least one data row'); return; }",
    "            var sep = lines[0].indexOf(TAB) >= 0 ? TAB : ',';",
    "            var hdrs = lines[0].split(sep);",
    "            for (var i = 1; i < lines.length; i++) {",
    "                var vals = lines[i].split(sep);",
    "                if (!vals.length || vals.join('').trim() === '') continue;",
    "                var row = {};",
    "                hdrs.forEach(function(h, idx) { row[h.trim()] = vals[idx] !== undefined ? vals[idx].trim() : ''; });",
    "                rows.push(row);",
    "            }",
    "        }",
    "        if (!rows.length) { alert('No data rows found'); return; }",
    "        var allCols = Object.keys(rows[0]);",
    "        var table = _currentTable || '';",
    "        var isNew = false;",
    "        if (!table) {",
    "            table = prompt('No table selected. Enter table name (creates if new):');",
    "            if (!table) { return; }",
    "            isNew = true;",
    "        }",
    "        var sql = '';",
    "        if (isNew) {",
    "            var hasId = allCols.some(function(c) { return c.toLowerCase() === 'id'; });",
    "            var colDefs = allCols.map(function(h) {",
    "                if (h.toLowerCase() === 'id') return h + ' INTEGER PRIMARY KEY AUTOINCREMENT';",
    "                return h + ' TEXT';",
    "            }).join(', ');",
    "            if (!hasId) colDefs = 'id INTEGER PRIMARY KEY AUTOINCREMENT, ' + colDefs;",
    "            sql = 'CREATE TABLE IF NOT EXISTS ' + table + ' (' + colDefs + ');' + NL;",
    "        }",
    "        sql += rows.map(function(r) {",
    "            var keys = Object.keys(r);",
    "            if (isNew) { keys = keys.filter(function(k) { return k.toLowerCase() !== 'id'; }); }",
    "            var cols = keys.join(', ');",
    "            var vs = keys.map(function(k) { var v = r[k]; return v === null ? 'NULL' : \"'\" + String(v).replace(/'/g, \"''\") + \"'\"; }).join(', ');",
    "            return 'INSERT INTO ' + table + ' (' + cols + ') VALUES (' + vs + ')';",
    "        }).join(';' + NL);",
    "        document.getElementById('query-input').value = sql;",
    "        document.body.removeChild(overlay);",
    "    };",
    "    btns.appendChild(cancelBtn); btns.appendChild(goBtn);",
    "    box.appendChild(ta); box.appendChild(btns);",
    "    overlay.appendChild(box); document.body.appendChild(overlay);",
    "    ta.focus();",
    "}",
    "",
    "function loadTables() {",
    "    api('/__dev/api/tables').then(function(d) {",
    "        if (d.error) { document.getElementById('table-list').innerHTML = '<div style=\"color:var(--danger)\">' + d.error + '</div>'; return; }",
    "        var tables = d.tables || [];",
    "        document.getElementById('db-count').textContent = tables.length;",
    "        var list = document.getElementById('table-list');",
    "        if (!tables.length) { list.innerHTML = '<div class=\"text-muted\">No tables</div>'; return; }",
    "        list.innerHTML = '';",
    "        tables.forEach(function(t) {",
    "            var div = document.createElement('div');",
    "            div.style.cssText = 'cursor:pointer;padding:4px 6px;color:var(--primary);border-radius:4px;margin-bottom:1px';",
    "            div.textContent = t;",
    "            div.addEventListener('mouseenter', function() { if (t !== _currentTable) div.style.background = 'var(--bg-alt,rgba(255,255,255,0.05))'; });",
    "            div.addEventListener('mouseleave', function() { if (t !== _currentTable) div.style.background = ''; });",
    "            div.addEventListener('click', function() {",
    "                list.querySelectorAll('div').forEach(function(d) { d.style.background = ''; d.style.fontWeight = ''; });",
    "                div.style.background = 'var(--primary-bg,rgba(53,114,165,0.2))'; div.style.fontWeight = '600';",
    "                browseTable(t);",
    "            });",
    "            list.appendChild(div);",
    "        });",
    "        var sel = document.getElementById('seed-table');",
    "        sel.innerHTML = '<option value=\"\">Pick table...</option>' + tables.map(function(t) { return '<option value=\"' + t + '\">' + t + '</option>'; }).join('');",
    "    }).catch(function(e) { document.getElementById('table-list').innerHTML = '<div style=\"color:var(--danger)\">' + e.message + '</div>'; });",
    "}",
    "",
    "function browseTable(name) {",
    "    _currentTable = name;",
    "    var lim = document.getElementById('query-limit').value;",
    "    document.getElementById('query-input').value = 'SELECT * FROM ' + name + (lim !== '0' ? ' LIMIT ' + lim : '');",
    "    runQuery();",
    "}",
    "",
    "function seedTable() {",
    "    var table = document.getElementById('seed-table').value;",
    "    var count = parseInt(document.getElementById('seed-count').value) || 10;",
    "    if (!table) return;",
    "    api('/__dev/api/seed', 'POST', {table:table, count:count}).then(function(d) {",
    "        if (d.error) { alert(d.error); return; }",
    "        browseTable(table);",
    "    });",
    "}",
    "",
    "function runQuery() {",
    "    var query = document.getElementById('query-input').value.trim();",
    "    var type = document.getElementById('query-type').value;",
    "    var errorEl = document.getElementById('query-error');",
    "    var resultEl = document.getElementById('query-results');",
    "    if (!query) { errorEl.textContent = 'Enter a query'; errorEl.classList.remove('hidden'); return; }",
    "    errorEl.classList.add('hidden');",
    "    resultEl.innerHTML = '<p class=\"text-muted\">Running...</p>';",
    "    api('/__dev/api/query', 'POST', {query:query, type:type}).then(function(d) {",
    "        if (d.error) { errorEl.textContent = d.error; errorEl.classList.remove('hidden'); resultEl.innerHTML = ''; return; }",
    "        if (d.rows) {",
    "            if (!d.rows.length) { resultEl.innerHTML = '<p class=\"text-muted\">No results</p>'; return; }",
    "            var cols = d.columns || Object.keys(d.rows[0]);",
    "            var html = '<div class=\"text-muted\" style=\"margin-bottom:0.25rem\">' + d.rows.length + ' row(s)</div><table class=\"table\"><thead><tr>' + cols.map(function(c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead><tbody>';",
    "            d.rows.forEach(function(row) { html += '<tr>' + cols.map(function(c) { return '<td>' + (row[c] !== null ? row[c] : '<em>null</em>') + '</td>'; }).join('') + '</tr>'; });",
    "            html += '</tbody></table>'; resultEl.innerHTML = html;",
    "        } else if (d.data) {",
    "            resultEl.innerHTML = '<pre class=\"p-md text-mono text-sm\">' + JSON.stringify(d.data, null, 2) + '</pre>';",
    "        } else if (d.success) {",
    "            resultEl.innerHTML = '<p style=\"color:var(--success)\">' + (d.affected || 0) + ' row(s) affected</p>';",
    "            loadTables();",
    "        } else {",
    "            resultEl.innerHTML = '<div class=\"empty\">No results</div>';",
    "        }",
    "    }).catch(function(e) { errorEl.textContent = e.message; errorEl.classList.remove('hidden'); });",
    "}",
  ];
}

function renderRequestsTab(): string[] {
  return [
    "// -- Requests --",
    "function loadRequests() {",
    "    api('/__dev/api/requests').then(function(d) {",
    "        var stats = d.stats || {};",
    "        document.getElementById('req-count').textContent = stats.total || 0;",
    "        document.getElementById('req-stats').innerHTML = 'Total: ' + (stats.total||0) + ' | Avg: ' + (stats.avg_ms||0) + 'ms | Errors: ' + (stats.errors||0) + ' | Slowest: ' + (stats.slowest_ms||0) + 'ms';",
    "        var tbody = document.getElementById('req-body');",
    "        var empty = document.getElementById('req-empty');",
    "        if (!(d.requests||[]).length) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }",
    "        empty.classList.add('hidden');",
    "        tbody.innerHTML = d.requests.map(function(r) {",
    "            var sc = r.status >= 500 ? 'status-err' : r.status >= 400 ? 'status-warn' : 'status-ok';",
    "            return '<tr>'+",
    "                '<td class=\"text-sm text-muted text-mono\">' + (r.timestamp||'').substring(11,19) + '</td>'+",
    "                '<td><span class=\"method method-' + r.method.toLowerCase() + '\">' + r.method + '</span></td>'+",
    "                '<td class=\"path\">' + r.path + '</td>'+",
    "                '<td class=\"' + sc + '\" style=\"font-weight:600\">' + r.status + '</td>'+",
    "                '<td class=\"text-mono text-sm\">' + r.duration_ms + 'ms</td>'+",
    "                '<td class=\"text-sm text-muted\">' + (r.body_size ? r.body_size + 'B' : '') + '</td>'+",
    "            '</tr>';",
    "        }).join('');",
    "    });",
    "}",
    "function clearRequests() { api('/__dev/api/requests/clear', 'POST', {}).then(function() { loadRequests(); }); }",
  ];
}

function renderErrorsTab(): string[] {
  return [
    "// -- Errors --",
    "function loadErrors() {",
    "    api('/__dev/api/broken').then(function(d) {",
    "        var health = d.health || {};",
    "        document.getElementById('err-count').textContent = health.unresolved || 0;",
    "        var list = document.getElementById('errors-list');",
    "        var empty = document.getElementById('errors-empty');",
    "        if (!(d.errors||[]).length) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }",
    "        empty.classList.add('hidden');",
    "        list.innerHTML = d.errors.map(function(e) {",
    "            return '<div style=\"padding:0.6rem 0.75rem;border-bottom:1px solid var(--border)\">'+",
    "                '<div class=\"flex justify-between items-center\">'+",
    "                    '<span class=\"badge-pill ' + (e.resolved ? 'bg-success' : 'bg-danger') + '\">' + (e.resolved ? 'resolved' : 'unresolved') + '</span>'+",
    "                    '<span class=\"text-sm text-muted\">x' + e.count + ' | ' + (e.last_seen||'').substring(0,19) + '</span>'+",
    "                '</div>'+",
    "                '<div style=\"font-weight:600;font-size:0.8rem;margin-top:0.25rem\">' + esc(e.error_type) + ': ' + esc(e.message) + '</div>'+",
    "                (e.traceback ? '<pre class=\"text-sm text-muted\" style=\"margin-top:0.25rem;max-height:100px;overflow:auto\">' + esc(e.traceback) + '</pre>' : '') +",
    "                (!e.resolved ? '<button class=\"btn btn-sm btn-success\" style=\"margin-top:0.25rem\" onclick=\"resolveError(\\'' + e.id + '\\')\">Resolve</button>' : '') +",
    "                '<button class=\"btn btn-sm btn-primary\" style=\"margin-top:0.25rem;margin-left:0.25rem\" data-err=\"' + btoa(e.error_type + ': ' + e.message) + '\" data-tb=\"' + btoa((e.traceback||'').substring(0,500)) + '\" onclick=\"askAboutError(this)\">Ask Tina4</button>'+",
    "            '</div>';",
    "        }).join('');",
    "    });",
    "}",
    "function resolveError(id) { api('/__dev/api/broken/resolve', 'POST', {id:id}).then(function() { loadErrors(); }); }",
    "function clearResolvedErrors() { api('/__dev/api/broken/clear', 'POST', {}).then(function() { loadErrors(); }); }",
  ];
}

function renderWebSocketTab(): string[] {
  return [
    "// -- WebSockets --",
    "function loadWebSockets() {",
    "    api('/__dev/api/websockets').then(function(d) {",
    "        document.getElementById('ws-count').textContent = d.count || 0;",
    "        var tbody = document.getElementById('ws-body');",
    "        var empty = document.getElementById('ws-empty');",
    "        if (!(d.connections||[]).length) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }",
    "        empty.classList.add('hidden');",
    "        tbody.innerHTML = d.connections.map(function(c) {",
    "            return '<tr>'+",
    "                '<td class=\"text-mono text-sm\">' + c.id + '</td>'+",
    "                '<td class=\"path\">' + c.path + '</td>'+",
    "                '<td class=\"text-sm text-muted\">' + c.ip + '</td>'+",
    "                '<td class=\"text-sm text-muted\">' + (c.connected_at||'').substring(11,19) + '</td>'+",
    "                '<td><span class=\"badge-pill ' + (c.closed ? 'bg-danger' : 'bg-success') + '\">' + (c.closed ? 'closed' : 'active') + '</span></td>'+",
    "                '<td>' + (!c.closed ? '<button class=\"btn btn-sm btn-danger\" onclick=\"wsDisconnect(\\'' + c.id + '\\')\">Disconnect</button>' : '') + '</td>'+",
    "            '</tr>';",
    "        }).join('');",
    "    });",
    "}",
    "function wsDisconnect(id) { api('/__dev/api/websockets/disconnect', 'POST', {id:id}).then(function() { loadWebSockets(); }); }",
  ];
}

function renderSystemTab(): string[] {
  return [
    "// -- System --",
    "function loadSystem() {",
    "    api('/__dev/api/system').then(function(d) {",
    "        var nodeVersion = d.node_version || (d.node ? d.node.version : '') || 'N/A';",
    "        var platform = d.os || d.platform || (d.node ? d.node.platform : '') || '';",
    "        var arch = d.architecture || (d.node ? d.node.arch : '') || '';",
    "        var memCurrent = d.memory ? (d.memory.current_mb ? d.memory.current_mb + ' MB' : d.memory.heapUsed || 'N/A') : 'N/A';",
    "        var memPeak = d.memory ? (d.memory.peak_mb ? d.memory.peak_mb + ' MB' : d.memory.rss || 'N/A') : 'N/A';",
    "        var memLimit = d.memory ? (d.memory.limit || 'N/A') : 'N/A';",
    "        var fwName = d.framework ? (typeof d.framework === 'object' ? d.framework.name : d.framework) : '';",
    "        var fwVersion = d.framework ? (typeof d.framework === 'object' ? d.framework.version : '') : '';",
    "        var routeCount = d.framework ? (typeof d.framework === 'object' ? d.framework.route_count : '') : (d.route_count || '');",
    "",
    "        var html = '<div class=\"sys-card\"><div class=\"label\">Node.js</div><div class=\"value text-sm\">' + nodeVersion + '</div></div>' +",
    "            '<div class=\"sys-card\"><div class=\"label\">Platform</div><div class=\"value text-sm\">' + platform + '</div></div>' +",
    "            '<div class=\"sys-card\"><div class=\"label\">Architecture</div><div class=\"value text-sm\">' + arch + '</div></div>' +",
    "            '<div class=\"sys-card\"><div class=\"label\">Memory (Current)</div><div class=\"value\">' + memCurrent + '</div></div>' +",
    "            '<div class=\"sys-card\"><div class=\"label\">Memory (Peak)</div><div class=\"value\">' + memPeak + '</div></div>' +",
    "            '<div class=\"sys-card\"><div class=\"label\">Memory Limit</div><div class=\"value text-sm\">' + memLimit + '</div></div>';",
    "",
    "        if (fwName) html += '<div class=\"sys-card\"><div class=\"label\">Framework</div><div class=\"value text-sm\">' + fwName + '</div></div>';",
    "        if (fwVersion) html += '<div class=\"sys-card\"><div class=\"label\">Version</div><div class=\"value text-sm\">' + fwVersion + '</div></div>';",
    "        if (routeCount !== '') html += '<div class=\"sys-card\"><div class=\"label\">Routes</div><div class=\"value\">' + routeCount + '</div></div>';",
    "",
    "        html += '<div class=\"sys-card\"><div class=\"label\">DB Tables</div><div class=\"value\">' + (d.db_tables !== undefined ? d.db_tables : 'N/A') + '</div></div>';",
    "        html += '<div class=\"sys-card\"><div class=\"label\">DB Connected</div><div class=\"value\">' + (d.db_connected ? '<span style=\"color:var(--success)\">Yes</span>' : '<span style=\"color:var(--danger)\">No</span>') + '</div></div>';",
    "",
    "        if (d.node && d.node.v8) html += '<div class=\"sys-card\"><div class=\"label\">V8 Engine</div><div class=\"value text-sm\">' + d.node.v8 + '</div></div>';",
    "        if (d.pid) html += '<div class=\"sys-card\"><div class=\"label\">PID</div><div class=\"value text-sm\">' + d.pid + '</div></div>';",
    "        if (d.cpus) html += '<div class=\"sys-card\"><div class=\"label\">CPU Cores</div><div class=\"value\">' + d.cpus + '</div></div>';",
    "        if (d.uptime) html += '<div class=\"sys-card\"><div class=\"label\">Uptime</div><div class=\"value text-sm\">' + (d.uptime.formatted || d.uptime.seconds + 's') + '</div></div>';",
    "        if (d.debug_level) html += '<div class=\"sys-card\"><div class=\"label\">Debug Level</div><div class=\"value text-sm\">' + d.debug_level + '</div></div>';",
    "        if (d.memory && d.memory.heapTotal) html += '<div class=\"sys-card\"><div class=\"label\">Heap Total</div><div class=\"value text-sm\">' + d.memory.heapTotal + '</div></div>';",
    "        if (d.memory && d.memory.external) html += '<div class=\"sys-card\"><div class=\"label\">External</div><div class=\"value text-sm\">' + d.memory.external + '</div></div>';",
    "        if (d.env) html += '<div class=\"sys-card\"><div class=\"label\">TINA4_DEBUG</div><div class=\"value text-sm\">' + (d.env.TINA4_DEBUG || 'false') + '</div></div>';",
    "",
    "        document.getElementById('sys-cards').innerHTML = html;",
    "    });",
    "}",
  ];
}

function renderChatTab(): string[] {
  return [
    "// -- Chat (Tina4) --",
    "var _aiKey = '';",
    "var _aiProvider = 'anthropic';",
    "function setAiKey() {",
    "    _aiKey = document.getElementById('ai-key').value.trim();",
    "    _aiProvider = document.getElementById('ai-provider').value;",
    "    document.getElementById('ai-key').value = '';",
    "    document.getElementById('ai-status').textContent = _aiKey ? (_aiProvider === 'anthropic' ? 'Claude key set' : 'OpenAI key set') : 'No key set';",
    "    document.getElementById('ai-status').style.color = _aiKey ? 'var(--success)' : 'var(--muted)';",
    "}",
    "function sendChat() {",
    "    var input = document.getElementById('chat-input');",
    "    var msg = input.value.trim();",
    "    if (!msg) return;",
    "    input.value = '';",
    "    var container = document.getElementById('chat-messages');",
    "    container.innerHTML += '<div class=\"chat-msg chat-user\">' + esc(msg) + '</div>';",
    "    container.innerHTML += '<div class=\"chat-msg chat-bot\" id=\"chat-loading\" style=\"color:var(--muted)\">Thinking...</div>';",
    "    container.scrollTop = container.scrollHeight;",
    "    var body = {message: msg, provider: _aiProvider};",
    "    if (_aiKey) body.api_key = _aiKey;",
    "    api('/__dev/api/chat', 'POST', body).then(function(d) {",
    "        var loading = document.getElementById('chat-loading');",
    "        if (loading) loading.remove();",
    "        container.innerHTML += '<div class=\"chat-msg chat-bot\">' + formatChat(d.reply||'No response') + '</div>';",
    "        container.scrollTop = container.scrollHeight;",
    "    }).catch(function() {",
    "        var loading = document.getElementById('chat-loading');",
    "        if (loading) { loading.textContent = 'Error connecting to API'; loading.id = ''; }",
    "    });",
    "}",
    "function formatChat(text) {",
    "    return text.replace(/`([^`]+)`/g, '<code style=\"background:var(--surface);padding:0.1rem 0.25rem;border-radius:0.2rem;font-size:0.8em\">$1</code>').replace(/\\n/g, '<br>');",
    "}",
    "",
    "// -- Ask Tina4 about errors --",
    "function askAboutError(btn) {",
    "    var error = atob(btn.dataset.err);",
    "    var trace = atob(btn.dataset.tb);",
    "    currentTab = 'chat';",
    "    document.querySelectorAll('.dev-tab').forEach(function(t) { t.classList.remove('active'); });",
    "    document.querySelectorAll('.dev-panel').forEach(function(p) { p.classList.add('hidden'); });",
    "    document.querySelectorAll('.dev-tab').forEach(function(t) { if(t.textContent.includes('Tina4')) t.classList.add('active'); });",
    "    document.getElementById('panel-chat').classList.remove('hidden');",
    "    var msg = 'I have this error in my Tina4 app, help me fix it:\\n\\n' + error + '\\n\\nStack trace:\\n' + trace;",
    "    document.getElementById('chat-input').value = msg;",
    "    sendChat();",
    "}",
  ];
}

function renderToolsTab(): string[] {
  return [
    "// -- Tools --",
    "function runTool(tool) {",
    "    var titles = {carbon:'Carbon Benchmark',test:'Test Suite',routes:'Routes',migrate:'Migrations',seed:'Seeders',ai:'AI Detection'};",
    "    document.getElementById('tool-title').textContent = titles[tool] || tool;",
    "    document.getElementById('tool-result').textContent = 'Running...';",
    "    document.getElementById('tool-output').classList.remove('hidden');",
    "    api('/__dev/api/tool', 'POST', {tool:tool}).then(function(d) {",
    "        document.getElementById('tool-result').textContent = d.output || d.error || JSON.stringify(d, null, 2);",
    "    }).catch(function(e) {",
    "        document.getElementById('tool-result').textContent = 'Error: ' + e.message;",
    "    });",
    "}",
  ];
}

function renderUtilitiesAndInit(): string[] {
  return [
    "// -- Exit Dev Admin --",
    "function exitDevAdmin() {",
    "    if (document.referrer && !document.referrer.includes('/__dev')) { window.location.href = document.referrer; }",
    "    else if (window.history.length > 1) { window.history.back(); }",
    "    else { window.location.href = '/'; }",
    "}",
    "",
    "// -- Utilities --",
    "function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }",
    "",
    "document.addEventListener('keydown', function(e) {",
    "    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && currentTab === 'database') { e.preventDefault(); runQuery(); }",
    "});",
    "",
    "// Init",
    "function updateTimestamp() { document.getElementById('timestamp').textContent = new Date().toLocaleTimeString(); }",
    "setInterval(updateTimestamp, 1000);",
    "updateTimestamp();",
    "loadRoutes();",
    "",
    "api('/__dev/api/status').then(function(d) {",
    "    if (d.mailbox) document.getElementById('mailbox-count').textContent = d.mailbox.total || 0;",
    "    if (d.messages) document.getElementById('messages-count').textContent = d.messages.total || 0;",
    "    if (d.message_counts) document.getElementById('messages-count').textContent = d.message_counts.total || 0;",
    "    if (d.health) document.getElementById('err-count').textContent = d.health.unresolved || 0;",
    "    if (d.requests) document.getElementById('req-count').textContent = d.requests.total || 0;",
    "    if (d.request_stats) document.getElementById('req-count').textContent = d.request_stats.total || 0;",
    "    if (d.db_tables !== undefined) document.getElementById('db-count').textContent = d.db_tables;",
    "});",
  ];
}

function renderDevAdminJs(): string {
  return [
    ...renderAppShell(),
    "",
    ...renderRoutesTab(),
    "",
    ...renderQueueTab(),
    "",
    ...renderMailboxTab(),
    "",
    ...renderMessagesTab(),
    "",
    ...renderDatabaseTab(),
    "",
    ...renderRequestsTab(),
    "",
    ...renderErrorsTab(),
    "",
    ...renderWebSocketTab(),
    "",
    ...renderSystemTab(),
    "",
    ...renderChatTab(),
    "",
    ...renderToolsTab(),
    "",
    ...renderUtilitiesAndInit(),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Dashboard HTML — Single-page app
// ---------------------------------------------------------------------------

export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tina4 Dev Admin</title>
<style>
:root {
    --bg: #0f172a; --surface: #1e293b; --border: #334155;
    --text: #e2e8f0; --muted: #94a3b8; --primary: #2e7d32;
    --success: #22c55e; --danger: #ef4444; --warn: #f59e0b;
    --info: #06b6d4; --radius: 0.5rem;
    --mono: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    --font: system-ui, -apple-system, sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }

body { font-family: var(--font); background: var(--bg); color: var(--text); font-size: 0.875rem; }
.dev-header {
    background: var(--surface); border-bottom: 1px solid var(--border);
    padding: 0.75rem 1.5rem; display: flex; align-items: center; gap: 1rem;
    position: sticky; top: 0; z-index: 100;
}
.dev-header h1 { font-size: 1rem; font-weight: 600; }
.dev-header .badge {
    background: var(--primary); color: #fff; padding: 0.15rem 0.5rem;
    border-radius: 1rem; font-size: 0.7rem; font-weight: 600;
}
.dev-tabs {
    display: flex; gap: 0; background: var(--surface);
    border-bottom: 1px solid var(--border); overflow-x: auto;
    position: sticky; top: 2.75rem; z-index: 100;
}
.dev-tab {
    padding: 0.6rem 1rem; cursor: pointer; font-size: 0.8rem;
    border-bottom: 2px solid transparent; color: var(--muted);
    transition: all 0.15s; background: none; border-top: none;
    border-left: none; border-right: none; white-space: nowrap;
}
.dev-tab:hover { color: var(--text); }
.dev-tab.active { color: var(--primary); border-bottom-color: var(--primary); }
.dev-tab .count {
    background: var(--border); color: var(--muted); padding: 0.1rem 0.4rem;
    border-radius: 0.75rem; font-size: 0.65rem; margin-left: 0.25rem;
}
.dev-content { padding: 0.25rem; }
.dev-panel {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); overflow: visible;
}
.dev-panel-header {
    padding: 0.75rem 1rem; border-bottom: 1px solid var(--border);
    display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem;
}
.dev-panel-header h2 { font-size: 0.9rem; font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
th { text-align: left; padding: 0.5rem 0.75rem; color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--border); }
td { padding: 0.4rem 0.75rem; border-bottom: 1px solid var(--border); }
tr:hover { background: rgba(46, 125, 50, 0.05); }
.method { font-family: var(--mono); font-size: 0.7rem; font-weight: 700; }
.method-get { color: var(--success); }
.method-post { color: var(--primary); }
.method-put { color: var(--warn); }
.method-delete { color: var(--danger); }
.path { font-family: var(--mono); font-size: 0.75rem; }
.badge-pill {
    display: inline-block; padding: 0.1rem 0.5rem; border-radius: 1rem;
    font-size: 0.65rem; font-weight: 600; text-transform: uppercase;
}
.bg-pending { background: rgba(245,158,11,0.15); color: var(--warn); }
.bg-completed, .bg-success { background: rgba(34,197,94,0.15); color: var(--success); }
.bg-failed, .bg-danger { background: rgba(239,68,68,0.15); color: var(--danger); }
.bg-reserved, .bg-primary { background: rgba(46,125,50,0.15); color: var(--primary); }
.bg-info { background: rgba(6,182,212,0.15); color: var(--info); }
.btn {
    padding: 0.3rem 0.65rem; border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--surface); color: var(--text); cursor: pointer; font-size: 0.75rem;
    transition: all 0.15s;
}
.btn:hover { border-color: var(--primary); color: var(--primary); }
.btn-primary { background: var(--primary); color: #fff; border-color: var(--primary); }
.btn-primary:hover { background: #388e3c; }
.btn-danger { border-color: var(--danger); color: var(--danger); }
.btn-danger:hover { background: rgba(239,68,68,0.1); }
.btn-success { border-color: var(--success); color: var(--success); }
.btn-sm { padding: 0.2rem 0.5rem; font-size: 0.7rem; }
.empty { padding: 2rem; text-align: center; color: var(--muted); }
.input {
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 0.35rem 0.5rem; font-size: 0.8rem;
    font-family: var(--font);
}
.input:focus { outline: none; border-color: var(--primary); }
.input-mono { font-family: var(--mono); }
select.input { padding: 0.3rem; }
textarea.input { resize: vertical; font-family: var(--mono); }
.flex { display: flex; }
.gap-sm { gap: 0.5rem; }
.gap-md { gap: 1rem; }
.items-center { align-items: center; }
.justify-between { justify-content: space-between; }
.flex-1 { flex: 1; }
.p-sm { padding: 0.5rem; }
.p-md { padding: 1rem; }
.mb-sm { margin-bottom: 0.5rem; }
.text-sm { font-size: 0.75rem; }
.text-muted { color: var(--muted); }
.text-mono { font-family: var(--mono); }
.mail-item { padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border); cursor: pointer; }
.mail-item:hover { background: rgba(46,125,50,0.05); }
.mail-item.unread { border-left: 3px solid var(--primary); }
.msg-entry { padding: 0.4rem 0.75rem; border-bottom: 1px solid var(--border); font-size: 0.75rem; }
.msg-entry .cat {
    font-family: var(--mono); font-size: 0.65rem; padding: 0.1rem 0.35rem;
    border-radius: 0.25rem; background: rgba(46,125,50,0.15); color: var(--primary);
}
.msg-entry .time { color: var(--muted); font-size: 0.7rem; font-family: var(--mono); }
.level-error { color: var(--danger); }
.level-warn { color: var(--warn); }
.toolbar { display: flex; gap: 0.5rem; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); flex-wrap: wrap; align-items: center; }
.hidden { display: none; }
/* Chat panel */
.chat-container { display: flex; flex-direction: column; height: 500px; }
.chat-messages { flex: 1; overflow-y: auto; padding: 0.75rem; }
.chat-msg { margin-bottom: 0.75rem; padding: 0.5rem 0.75rem; border-radius: var(--radius); font-size: 0.8rem; max-width: 85%; }
.chat-user { background: var(--primary); color: #fff; margin-left: auto; }
.chat-bot { background: var(--bg); border: 1px solid var(--border); }
.chat-input-row { display: flex; gap: 0.5rem; padding: 0.75rem; border-top: 1px solid var(--border); }
.chat-input-row input { flex: 1; }
/* System cards */
.sys-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem; padding: 1rem; }
.sys-card { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.75rem; }
.sys-card .label { font-size: 0.7rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
.sys-card .value { font-size: 1.25rem; font-weight: 600; margin-top: 0.25rem; }
/* Request table */
.status-ok { color: var(--success); }
.status-err { color: var(--danger); }
.status-warn { color: var(--warn); }
/* Extension tags */
.ext-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.ext-tag { background: rgba(46, 125, 50, 0.15); color: #81c784; padding: 3px 10px; border-radius: 12px; font-size: 0.78em; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem; margin-bottom: 0.75rem; }
.card h3 { color: #81c784; margin-bottom: 0.75rem; font-size: 0.95rem; }
.sys-item { display: flex; justify-content: space-between; padding: 0.4rem 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
.sys-label { color: var(--muted); font-size: 0.82rem; }
.sys-value { font-weight: 500; font-size: 0.82rem; }
code, .mono { font-family: var(--mono); font-size: 0.82rem; }
</style>
</head>
<body>

<div class="dev-header">
    <img src="/images/logo.svg" style="width:1.5rem;height:1.5rem;cursor:pointer;opacity:0.7;transition:opacity 0.15s" title="Back to app" onclick="exitDevAdmin()" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'" alt="Tina4">
    <h1>Tina4 Dev Admin</h1>
    <span class="badge">DEV</span>
    <span style="margin-left:auto; font-size:0.75rem; color:var(--muted)" id="timestamp"></span>
</div>

<div class="dev-tabs">
    <button class="dev-tab active" onclick="showTab('routes', event)">Routes <span class="count" id="routes-count">0</span></button>
    <button class="dev-tab" onclick="showTab('queue', event)">Queue <span class="count" id="queue-count">0</span></button>
    <button class="dev-tab" onclick="showTab('mailbox', event)">Mailbox <span class="count" id="mailbox-count">0</span></button>
    <button class="dev-tab" onclick="showTab('messages', event)">Messages <span class="count" id="messages-count">0</span></button>
    <button class="dev-tab" onclick="showTab('database', event)">Database <span class="count" id="db-count">0</span></button>
    <button class="dev-tab" onclick="showTab('requests', event)">Requests <span class="count" id="req-count">0</span></button>
    <button class="dev-tab" onclick="showTab('errors', event)">Errors <span class="count" id="err-count">0</span></button>
    <button class="dev-tab" onclick="showTab('websockets', event)">WS <span class="count" id="ws-count">0</span></button>
    <button class="dev-tab" onclick="showTab('system', event)">System</button>
    <button class="dev-tab" onclick="showTab('tools', event)">Tools</button>
    <button class="dev-tab" onclick="showTab('connections', event)">Connections</button>
    <button class="dev-tab" onclick="showTab('metrics', event)">Metrics</button>
    <button class="dev-tab" onclick="showTab('chat', event)">Tina4</button>
</div>

<div class="dev-content">

<!-- Routes Panel -->
<div id="panel-routes" class="dev-panel">
    <div class="dev-panel-header">
        <h2>Registered Routes</h2>
        <button class="btn btn-sm" onclick="loadRoutes()">Refresh</button>
    </div>
    <table>
        <thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Handler</th></tr></thead>
        <tbody id="routes-body"></tbody>
    </table>
</div>

<!-- Queue Panel -->
<div id="panel-queue" class="dev-panel hidden">
    <div class="dev-panel-header">
        <h2>Queue Jobs</h2>
        <div class="flex gap-sm">
            <button class="btn btn-sm" onclick="loadQueue()">Refresh</button>
            <button class="btn btn-sm" onclick="retryQueue()">Retry Failed</button>
            <button class="btn btn-sm btn-danger" onclick="purgeQueue()">Purge Done</button>
        </div>
    </div>
    <div class="toolbar">
        <button class="btn btn-sm filter-btn active" onclick="filterQueue('', event)">All</button>
        <button class="btn btn-sm filter-btn" onclick="filterQueue('pending', event)">Pending <span id="q-pending">0</span></button>
        <button class="btn btn-sm filter-btn" onclick="filterQueue('completed', event)">Done <span id="q-completed">0</span></button>
        <button class="btn btn-sm filter-btn" onclick="filterQueue('failed', event)">Failed <span id="q-failed">0</span></button>
        <button class="btn btn-sm filter-btn" onclick="filterQueue('reserved', event)">Active <span id="q-reserved">0</span></button>
    </div>
    <table>
        <thead><tr><th>ID</th><th>Topic</th><th>Status</th><th>Attempts</th><th>Created</th><th>Data</th><th></th></tr></thead>
        <tbody id="queue-body"></tbody>
    </table>
    <div id="queue-empty" class="empty hidden">No queue jobs</div>
</div>

<!-- Mailbox Panel -->
<div id="panel-mailbox" class="dev-panel hidden">
    <div class="dev-panel-header">
        <h2>Dev Mailbox</h2>
        <div class="flex gap-sm">
            <button class="btn btn-sm" onclick="loadMailbox()">Refresh</button>
            <button class="btn btn-sm btn-primary" onclick="seedMailbox()">Seed 5</button>
            <button class="btn btn-sm btn-danger" onclick="clearMailbox()">Clear</button>
        </div>
    </div>
    <div class="toolbar">
        <button class="btn btn-sm filter-btn active" onclick="filterMailbox('', event)">All</button>
        <button class="btn btn-sm filter-btn" onclick="filterMailbox('inbox', event)">Inbox</button>
        <button class="btn btn-sm filter-btn" onclick="filterMailbox('outbox', event)">Outbox</button>
    </div>
    <div id="mailbox-list"></div>
    <div id="mail-detail" class="hidden p-md"></div>
</div>

<!-- Messages Panel -->
<div id="panel-messages" class="dev-panel hidden">
    <div class="dev-panel-header">
        <h2>Message Log</h2>
        <div class="flex gap-sm items-center">
            <input type="text" id="msg-search" class="input" placeholder="Search messages..." onkeydown="if(event.key==='Enter')searchMessages()">
            <button class="btn btn-sm" onclick="searchMessages()">Search</button>
            <button class="btn btn-sm" onclick="loadMessages()">All</button>
            <button class="btn btn-sm btn-danger" onclick="clearMessages()">Clear</button>
        </div>
    </div>
    <div id="messages-list"></div>
    <div id="messages-empty" class="empty">No messages logged</div>
</div>

<!-- Database Panel -->
<div id="panel-database" class="dev-panel hidden">
    <div class="dev-panel-header">
        <h2>Database</h2>
        <button class="btn btn-sm" onclick="loadTables()">Refresh</button>
    </div>
    <div style="display:flex;height:calc(100vh - 140px);overflow:hidden">
        <!-- Left: Tables navigation -->
        <div style="width:200px;min-width:200px;border-right:1px solid var(--border);padding:0.5rem;overflow-y:auto;display:flex;flex-direction:column;gap:0.5rem">
            <div class="text-sm text-muted" style="font-weight:600">Tables</div>
            <div id="table-list" class="text-sm"></div>
            <div style="border-top:1px solid var(--border);padding-top:0.5rem;margin-top:auto">
                <div class="text-sm text-muted" style="font-weight:600;margin-bottom:0.25rem">Seed Data</div>
                <select id="seed-table" class="input" style="width:100%;margin-bottom:0.25rem;font-size:0.75rem"><option value="">Pick table...</option></select>
                <div class="flex gap-sm items-center">
                    <input type="number" id="seed-count" class="input" value="10" min="1" max="1000" style="width:60px;font-size:0.75rem">
                    <button class="btn btn-sm btn-success" onclick="seedTable()">Seed</button>
                </div>
            </div>
        </div>
        <!-- Right: Query + Results -->
        <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;padding:0.5rem">
            <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.25rem">
                <select id="query-type" class="input" style="width:auto;font-size:0.75rem">
                    <option value="sql">SQL</option>
                    <option value="graphql">GraphQL</option>
                </select>
                <span class="text-sm text-muted">Limit</span>
                <select id="query-limit" class="input" style="width:70px;font-size:0.75rem">
                    <option value="20">20</option>
                    <option value="50">50</option>
                    <option value="100">100</option>
                    <option value="500">500</option>
                    <option value="0">All</option>
                </select>
                <button class="btn btn-sm btn-primary" onclick="runQuery()">Run</button>
                <button class="btn btn-sm" id="btn-csv" onclick="copyResults('csv',this)" title="Copy results as CSV">Copy CSV</button>
                <button class="btn btn-sm" id="btn-json" onclick="copyResults('json',this)" title="Copy results as JSON">Copy JSON</button>
                <button class="btn btn-sm" onclick="pasteData()" title="Paste tab-separated data as INSERTs">Paste</button>
                <span class="text-sm text-muted">Ctrl+Enter</span>
            </div>
            <textarea id="query-input" rows="3" placeholder="SELECT * FROM users LIMIT 20" class="input input-mono" style="width:100%;font-size:0.75rem;resize:vertical"></textarea>
            <div id="query-error" class="hidden" style="color:var(--danger);font-size:0.75rem;margin-top:0.25rem"></div>
            <div id="query-results" style="flex:1;overflow:auto;margin-top:0.25rem;font-size:0.75rem"></div>
        </div>
    </div>
</div>

<!-- Requests Panel -->
<div id="panel-requests" class="dev-panel hidden">
    <div class="dev-panel-header">
        <h2>Request Inspector</h2>
        <div class="flex gap-sm">
            <button class="btn btn-sm" onclick="loadRequests()">Refresh</button>
            <button class="btn btn-sm btn-danger" onclick="clearRequests()">Clear</button>
        </div>
    </div>
    <div id="req-stats" class="toolbar text-sm text-muted"></div>
    <table>
        <thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>Duration</th><th>Size</th></tr></thead>
        <tbody id="req-body"></tbody>
    </table>
    <div id="req-empty" class="empty hidden">No requests captured</div>
</div>

<!-- Errors Panel -->
<div id="panel-errors" class="dev-panel hidden">
    <div class="dev-panel-header">
        <h2>Error Tracker</h2>
        <div class="flex gap-sm">
            <button class="btn btn-sm" onclick="loadErrors()">Refresh</button>
            <button class="btn btn-sm btn-danger" onclick="clearResolvedErrors()">Clear Resolved</button>
        </div>
    </div>
    <div id="errors-list"></div>
    <div id="errors-empty" class="empty">No errors tracked</div>
</div>

<!-- WebSocket Panel -->
<div id="panel-websockets" class="dev-panel hidden">
    <div class="dev-panel-header">
        <h2>WebSocket Connections</h2>
        <button class="btn btn-sm" onclick="loadWebSockets()">Refresh</button>
    </div>
    <table>
        <thead><tr><th>ID</th><th>Path</th><th>IP</th><th>Connected</th><th>Status</th><th></th></tr></thead>
        <tbody id="ws-body"></tbody>
    </table>
    <div id="ws-empty" class="empty">No active connections</div>
</div>

<!-- System Panel -->
<div id="panel-system" class="dev-panel hidden">
    <div class="dev-panel-header">
        <h2>System Overview</h2>
        <button class="btn btn-sm" onclick="loadSystem()">Refresh</button>
    </div>
    <div id="sys-cards" class="sys-grid"></div>
    <div id="sys-extensions" class="hidden"></div>
</div>

<!-- Tools Panel -->
<div id="panel-tools" class="dev-panel hidden">
    <div class="dev-panel-header">
        <h2>Developer Tools</h2>
    </div>
    <div class="sys-grid">
        <div class="sys-card" style="cursor:pointer" onclick="runTool('test')">
            <div class="label">Run Tests</div>
            <div style="font-size:0.8rem;margin-top:0.25rem">Execute the test suite</div>
        </div>
        <div class="sys-card" style="cursor:pointer" onclick="runTool('routes')">
            <div class="label">List Routes</div>
            <div style="font-size:0.8rem;margin-top:0.25rem">Show all registered routes with auth status</div>
        </div>
        <div class="sys-card" style="cursor:pointer" onclick="runTool('migrate')">
            <div class="label">Run Migrations</div>
            <div style="font-size:0.8rem;margin-top:0.25rem">Apply pending database migrations</div>
        </div>
        <div class="sys-card" style="cursor:pointer" onclick="runTool('seed')">
            <div class="label">Run Seeders</div>
            <div style="font-size:0.8rem;margin-top:0.25rem">Execute seed scripts</div>
        </div>
    </div>
    <div id="tool-output" class="hidden" style="margin:1rem">
        <div class="dev-panel-header">
            <h2 id="tool-title">Output</h2>
            <button class="btn btn-sm" onclick="document.getElementById('tool-output').classList.add('hidden')">Close</button>
        </div>
        <pre id="tool-result" style="padding:1rem;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);font-size:0.75rem;font-family:var(--mono);max-height:400px;overflow:auto;white-space:pre-wrap"></pre>
    </div>
</div>

<!-- Connections Panel -->
<div id="panel-connections" class="dev-panel hidden">
    <div class="dev-panel-header">
        <h2>Connection Builder</h2>
    </div>
    <div class="p-md">
        <div class="flex gap-md" style="flex-wrap:wrap">
            <div style="flex:1;min-width:300px">
                <div class="mb-sm">
                    <label class="text-sm text-muted" style="display:block;margin-bottom:0.25rem">Driver</label>
                    <select id="conn-driver" class="input" style="width:100%" onchange="connDriverChanged()">
                        <option value="sqlite">SQLite</option>
                        <option value="postgresql">PostgreSQL</option>
                        <option value="mysql">MySQL</option>
                        <option value="mssql">MSSQL</option>
                        <option value="firebird">Firebird</option>
                    </select>
                </div>
                <div class="mb-sm conn-server-field">
                    <label class="text-sm text-muted" style="display:block;margin-bottom:0.25rem">Host</label>
                    <input type="text" id="conn-host" class="input" style="width:100%" value="localhost" placeholder="localhost" oninput="updateConnectionUrl()">
                </div>
                <div class="mb-sm conn-server-field">
                    <label class="text-sm text-muted" style="display:block;margin-bottom:0.25rem">Port</label>
                    <input type="number" id="conn-port" class="input" style="width:100%" placeholder="5432" oninput="updateConnectionUrl()">
                </div>
                <div class="mb-sm">
                    <label class="text-sm text-muted" style="display:block;margin-bottom:0.25rem">Database</label>
                    <input type="text" id="conn-database" class="input" style="width:100%" placeholder="mydb" oninput="updateConnectionUrl()">
                </div>
                <div class="mb-sm conn-server-field">
                    <label class="text-sm text-muted" style="display:block;margin-bottom:0.25rem">Username</label>
                    <input type="text" id="conn-username" class="input" style="width:100%" placeholder="username">
                </div>
                <div class="mb-sm conn-server-field">
                    <label class="text-sm text-muted" style="display:block;margin-bottom:0.25rem">Password</label>
                    <input type="password" id="conn-password" class="input" style="width:100%" placeholder="password">
                </div>
                <div class="mb-sm">
                    <label class="text-sm text-muted" style="display:block;margin-bottom:0.25rem">Connection URL</label>
                    <input type="text" id="conn-url" class="input input-mono" style="width:100%" readonly>
                </div>
                <div class="flex gap-sm">
                    <button class="btn btn-primary" onclick="testConnection()">Test Connection</button>
                    <button class="btn btn-success" onclick="saveConnection()">Save to .env</button>
                </div>
            </div>
            <div style="width:300px">
                <div class="dev-panel" style="margin-bottom:1rem">
                    <div class="dev-panel-header"><h2>Test Result</h2></div>
                    <div id="conn-test-result" class="p-md text-sm text-muted">No test run yet</div>
                </div>
                <div class="dev-panel">
                    <div class="dev-panel-header"><h2>Current .env Values</h2></div>
                    <div id="conn-env-values" class="p-md text-sm text-muted">Loading...</div>
                </div>
            </div>
        </div>
    </div>
</div>

<script>
function connDriverChanged() {
    var driver = document.getElementById('conn-driver').value;
    var ports = {postgresql: 5432, mysql: 3306, mssql: 1433, firebird: 3050};
    var isSqlite = (driver === 'sqlite');
    document.getElementById('conn-port').value = ports[driver] || '';
    var fields = document.querySelectorAll('.conn-server-field');
    for (var i = 0; i < fields.length; i++) {
        fields[i].style.display = isSqlite ? 'none' : '';
    }
    updateConnectionUrl();
}
function updateConnectionUrl() {
    var driver = document.getElementById('conn-driver').value;
    var host = document.getElementById('conn-host').value || 'localhost';
    var port = document.getElementById('conn-port').value;
    var database = document.getElementById('conn-database').value;
    if (driver === 'sqlite') {
        document.getElementById('conn-url').value = 'sqlite:///' + database;
    } else {
        document.getElementById('conn-url').value = driver + '://' + host + ':' + port + '/' + database;
    }
}
function testConnection() {
    var url = document.getElementById('conn-url').value;
    var username = document.getElementById('conn-username').value;
    var password = document.getElementById('conn-password').value;
    var el = document.getElementById('conn-test-result');
    el.innerHTML = '<span class="text-muted">Testing...</span>';
    fetch('/__dev/api/connections/test', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({url: url, username: username, password: password})
    }).then(function(r){return r.json()}).then(function(data) {
        if (data.success) {
            el.innerHTML = '<div style="color:var(--success);font-weight:600;margin-bottom:0.5rem">&#10004; Connected</div>' +
                '<div class="text-sm">Version: ' + (data.version || 'N/A') + '</div>' +
                '<div class="text-sm">Tables: ' + (data.tables !== undefined ? data.tables : 'N/A') + '</div>';
        } else {
            el.innerHTML = '<div style="color:var(--danger);font-weight:600;margin-bottom:0.5rem">&#10008; Failed</div>' +
                '<div class="text-sm" style="color:var(--danger)">' + (data.error || 'Unknown error') + '</div>';
        }
    }).catch(function(e) {
        el.innerHTML = '<div style="color:var(--danger)">Error: ' + e.message + '</div>';
    });
}
function saveConnection() {
    var url = document.getElementById('conn-url').value;
    var username = document.getElementById('conn-username').value;
    var password = document.getElementById('conn-password').value;
    if (!url) { alert('Please build a connection URL first'); return; }
    fetch('/__dev/api/connections/save', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({url: url, username: username, password: password})
    }).then(function(r){return r.json()}).then(function(data) {
        if (data.success) {
            alert('Connection saved to .env');
            loadConnectionEnv();
        } else {
            alert('Save failed: ' + (data.error || 'Unknown error'));
        }
    }).catch(function(e) { alert('Error: ' + e.message); });
}
function loadConnectionEnv() {
    fetch('/__dev/api/connections').then(function(r){return r.json()}).then(function(data) {
        var el = document.getElementById('conn-env-values');
        el.innerHTML = '<div class="mb-sm"><span class="text-muted">DATABASE_URL:</span> <code>' + (data.url || '<em>not set</em>') + '</code></div>' +
            '<div class="mb-sm"><span class="text-muted">DATABASE_USERNAME:</span> <code>' + (data.username || '<em>not set</em>') + '</code></div>' +
            '<div><span class="text-muted">DATABASE_PASSWORD:</span> <code>' + (data.password || '<em>not set</em>') + '</code></div>';
    }).catch(function() {
        document.getElementById('conn-env-values').innerHTML = '<span class="text-muted">Could not load .env values</span>';
    });
}
document.addEventListener('DOMContentLoaded', function() {
    var connTab = document.querySelector('[onclick*="connections"]');
    if (connTab) {
        connTab.addEventListener('click', function() { loadConnectionEnv(); }, {once: true});
    }
});
</script>

<!-- Metrics Panel -->
<div id="panel-metrics" class="dev-panel hidden">
    <div class="dev-panel-header">
        <h2>Code Metrics</h2>
        <div>
            <button class="btn btn-sm" onclick="loadAllMetrics()">Refresh</button>
        </div>
    </div>
    <div id="metrics-bubble" style="margin:1rem;"></div>
    <div id="metrics-drilldown" style="margin:0 1rem;display:none;"></div>
    <div id="metrics-quick" class="sys-grid"></div>
    <div id="metrics-largest" style="margin-top:1rem;"></div>
    <div id="metrics-tables" style="margin-top:1rem;padding:0 1rem 1rem;overflow-x:auto;">
        <h3 style="margin:1rem 0 0.5rem;color:var(--primary);">File Analysis</h3>
        <div id="metrics-heatmap"></div>
        <h3 style="margin:1rem 0 0.5rem;color:var(--primary);">Most Complex Functions</h3>
        <div id="metrics-complex"></div>
        <h3 style="margin:1rem 0 0.5rem;color:var(--primary);">Coupling Analysis</h3>
        <div id="metrics-coupling"></div>
        <h3 style="margin:1rem 0 0.5rem;color:var(--primary);">Violations</h3>
        <div id="metrics-violations"></div>
    </div>
</div>

<!-- Chat Panel (Tina4) -->
<div id="panel-chat" class="dev-panel hidden">
    <div class="dev-panel-header">
        <h2>Tina4</h2>
        <div class="flex gap-sm items-center">
            <select id="ai-provider" class="input" style="width:120px">
                <option value="anthropic">Claude</option>
                <option value="openai">OpenAI</option>
            </select>
            <input type="password" id="ai-key" class="input" placeholder="Paste API key..." style="width:250px">
            <button class="btn btn-sm btn-primary" onclick="setAiKey()">Set Key</button>
            <span class="text-sm text-muted" id="ai-status">No key set</span>
        </div>
    </div>
    <div class="chat-container">
        <div class="chat-messages" id="chat-messages">
            <div class="chat-msg chat-bot">Hi! I'm Tina4. Ask me about routes, ORM, database, queues, templates, auth, or any Tina4 feature.</div>
        </div>
        <div class="chat-input-row">
            <input type="text" id="chat-input" class="input" placeholder="Ask Tina4..." onkeydown="if(event.key==='Enter')sendChat()">
            <button class="btn btn-primary" onclick="sendChat()">Send</button>
        </div>
    </div>
</div>

</div>

<script src="/__dev/js/tina4-dev-admin.min.js"></script>
<script>
// ── Metrics Panel JS ──
var _metricsFullData=null;
function miColor(mi){
    if(mi>=60) return 'rgb('+(Math.round(34+(1-((mi-60)/40))*186))+','+(Math.round(197-(1-((mi-60)/40))*50))+',0)';
    if(mi>=30) return 'rgb('+(Math.round(220+((60-mi)/30)*19))+','+(Math.round(180-((60-mi)/30)*112))+',0)';
    return 'rgb(239,'+(Math.round(68-mi*2))+',0)';
}
function renderBubbleChart(files,depGraph,scanMode){
    var container=document.getElementById('metrics-bubble');
    if(!files||!files.length){container.innerHTML='<p style="color:var(--muted);padding:1rem">No files to analyze</p>';return;}
    depGraph=depGraph||{};
    scanMode=scanMode||'project';
    var W=container.offsetWidth||900,H=Math.max(450,Math.min(650,W*0.45));
    var maxLoc=Math.max.apply(null,files.map(function(f){return f.loc}))||1;
    var maxDeps=Math.max.apply(null,files.map(function(f){return f.dep_count||0}))||1;
    var maxCC=Math.max.apply(null,files.map(function(f){return f.complexity||0}))||1;
    var minR=14,maxR=Math.min(70,W/10);
    // Composite health colour: complexity + tests + dependencies
    function healthColor(f){
        var cc=Math.min((f.avg_complexity||0)/10,1);
        var untested=f.has_tests?0:1;
        var deps=Math.min((f.dep_count||0)/5,1);
        var score=cc*0.4+untested*0.4+deps*0.2;
        score=Math.max(0,Math.min(1,score));
        var hue=Math.round(120*(1-score));
        var sat=Math.round(70+score*30);
        var lit=Math.round(42+18*(1-score));
        return 'hsl('+hue+','+sat+'%,'+lit+'%)';
    }
    // Build path->index lookup
    var pathIdx={};
    files.forEach(function(f,i){pathIdx[f.path]=i;});
    // Spiral placement
    function sizeScore(f){return (f.loc/maxLoc)*0.4+((f.avg_complexity||0)/10)*0.4+((f.dep_count||0)/maxDeps)*0.2;}
    var sorted=files.slice().sort(function(a,b){return sizeScore(a)-sizeScore(b)});
    var cx=W/2,cy=H/2;
    var bubbles=[];
    var angle=0,spiralR=0;
    for(var i=0;i<sorted.length;i++){
        var f=sorted[i];
        var r=minR+Math.sqrt(sizeScore(f))*(maxR-minR);
        var color=healthColor(f);
        var placed=false;
        for(var attempt=0;attempt<800;attempt++){
            var px=cx+spiralR*Math.cos(angle);
            var py=cy+spiralR*Math.sin(angle);
            var collides=false;
            for(var j=0;j<bubbles.length;j++){
                var dx=px-bubbles[j].x,dy=py-bubbles[j].y;
                if(Math.sqrt(dx*dx+dy*dy)<r+bubbles[j].r+2){collides=true;break;}
            }
            if(!collides&&px>r+2&&px<W-r-2&&py>r+25&&py<H-r-2){
                bubbles.push({x:px,y:py,vx:0,vy:0,r:r,color:color,f:f});
                placed=true;break;
            }
            angle+=0.2;spiralR+=0.04;
        }
        if(!placed){bubbles.push({x:cx+(Math.random()-0.5)*W*0.3,y:cy+(Math.random()-0.5)*H*0.3,vx:0,vy:0,r:r,color:color,f:f});}
    }
    // Build edge list from dependency graph — match by filename not full path
    var edges=[];
    function basename(p){var n=p.split('/').pop();var d=n.lastIndexOf('.');return(d>0?n.substring(0,d):n).toLowerCase();}
    var nameIdx={};
    bubbles.forEach(function(b,i){nameIdx[basename(b.f.path)]=i;});
    Object.keys(depGraph).forEach(function(src){
        var srcIdx=null;
        bubbles.forEach(function(b,i){if(b.f.path===src)srcIdx=i;});
        if(srcIdx===null)return;
        (depGraph[src]||[]).forEach(function(tgt){
            var tgtName=basename(tgt);
            var tgtIdx=nameIdx[tgtName];
            if(tgtIdx!==undefined&&srcIdx!==tgtIdx)edges.push([srcIdx,tgtIdx]);
        });
    });
    // Canvas
    var canvas=document.createElement('canvas');
    canvas.width=W;canvas.height=H;
    canvas.style.cssText='display:block;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:#0f172a';
    var modeLabel=scanMode==='framework'?'<span style="color:#cba6f7;font-weight:600"> (Framework)</span> Add code to src/ to see your project':'';
    container.innerHTML='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem"><h3 style="margin:0;color:var(--primary)">Code Landscape'+modeLabel+'</h3><span style="font-size:0.7rem;color:var(--muted)">Drag bubbles | Click to drill down | Size=LOC | Colour=health | T=tested | D=deps</span></div>';
    container.appendChild(canvas);
    var ctx=canvas.getContext('2d');
    var hoveredIdx=-1,dragIdx=-1,dragOX=0,dragOY=0;
    // Physics
    function simulate(){
        var damping=0.65,springK=0.002,repulse=40,gravity=0.008;
        var cx=W/2,cy=H/2;
        // Gravity: pull all bubbles toward center, bigger = stronger pull
        bubbles.forEach(function(b,idx){
            if(idx===dragIdx)return;
            var dx=cx-b.x,dy=cy-b.y;
            var sizeFactor=0.3+(b.r/maxR)*0.7;
            var pull=gravity*sizeFactor*sizeFactor;
            b.vx+=dx*pull;b.vy+=dy*pull;
        });
        // Spring forces along edges
        edges.forEach(function(e){
            var a=bubbles[e[0]],b=bubbles[e[1]];
            var dx=b.x-a.x,dy=b.y-a.y;
            var dist=Math.sqrt(dx*dx+dy*dy)||1;
            var rest=a.r+b.r+20;
            var force=(dist-rest)*springK;
            var fx=dx/dist*force,fy=dy/dist*force;
            if(e[0]!==dragIdx){a.vx+=fx;a.vy+=fy;}
            if(e[1]!==dragIdx){b.vx-=fx;b.vy-=fy;}
        });
        // Soft repulsion
        for(var i=0;i<bubbles.length;i++){
            for(var j=i+1;j<bubbles.length;j++){
                var a=bubbles[i],b=bubbles[j];
                var dx=b.x-a.x,dy=b.y-a.y;
                var dist=Math.sqrt(dx*dx+dy*dy)||1;
                var minDist=a.r+b.r+20;
                if(dist<minDist){
                    var force=repulse*(minDist-dist)/minDist;
                    var fx=dx/dist*force,fy=dy/dist*force;
                    if(i!==dragIdx){a.vx-=fx;a.vy-=fy;}
                    if(j!==dragIdx){b.vx+=fx;b.vy+=fy;}
                }
            }
        }
        // Apply velocity + damping + boundary
        bubbles.forEach(function(b,idx){
            if(idx===dragIdx)return;
            b.vx*=damping;b.vy*=damping;
            // Cap velocity
            var maxV=2;
            if(b.vx>maxV)b.vx=maxV;if(b.vx<-maxV)b.vx=-maxV;
            if(b.vy>maxV)b.vy=maxV;if(b.vy<-maxV)b.vy=-maxV;
            b.x+=b.vx;b.y+=b.vy;
            b.x=Math.max(b.r+2,Math.min(W-b.r-2,b.x));
            b.y=Math.max(b.r+25,Math.min(H-b.r-2,b.y));
        });
    }
    // Draw
    function draw(){
        simulate();
        ctx.clearRect(0,0,W,H);
        ctx.save();ctx.translate(panX,panY);ctx.scale(zoom,zoom);
        // Grid
        ctx.strokeStyle='rgba(255,255,255,0.03)';ctx.lineWidth=1/zoom;
        for(var gx=0;gx<W/zoom;gx+=50){ctx.beginPath();ctx.moveTo(gx,0);ctx.lineTo(gx,H/zoom);ctx.stroke();}
        for(var gy=0;gy<H/zoom;gy+=50){ctx.beginPath();ctx.moveTo(0,gy);ctx.lineTo(W/zoom,gy);ctx.stroke();}
        // Dependency arrows
        edges.forEach(function(e){
            var a=bubbles[e[0]],b=bubbles[e[1]];
            var dx=b.x-a.x,dy=b.y-a.y;
            var dist=Math.sqrt(dx*dx+dy*dy)||1;
            var highlighted=(hoveredIdx===e[0]||hoveredIdx===e[1]);
            ctx.beginPath();
            ctx.moveTo(a.x+dx/dist*a.r,a.y+dy/dist*a.r);
            var ex=b.x-dx/dist*b.r,ey=b.y-dy/dist*b.r;
            ctx.lineTo(ex,ey);
            ctx.strokeStyle=highlighted?'rgba(139,180,250,0.9)':'rgba(255,255,255,0.3)';
            ctx.lineWidth=highlighted?3:1.5;ctx.stroke();
            // Arrowhead
            var aLen=highlighted?14:8;
            var aAngle=Math.atan2(dy,dx);
            ctx.beginPath();
            ctx.moveTo(ex,ey);
            ctx.lineTo(ex-aLen*Math.cos(aAngle-0.4),ey-aLen*Math.sin(aAngle-0.4));
            ctx.lineTo(ex-aLen*Math.cos(aAngle+0.4),ey-aLen*Math.sin(aAngle+0.4));
            ctx.closePath();ctx.fillStyle=ctx.strokeStyle;ctx.fill();
        });
        // Bubbles
        bubbles.forEach(function(b,idx){
            var isHovered=(idx===hoveredIdx);
            var drawR=isHovered?b.r+4:b.r;
            if(isHovered){ctx.beginPath();ctx.arc(b.x,b.y,drawR+8,0,Math.PI*2);ctx.fillStyle='rgba(255,255,255,0.08)';ctx.fill();}
            // Matte flat bubble
            ctx.beginPath();ctx.arc(b.x,b.y,drawR,0,Math.PI*2);
            ctx.fillStyle=b.color;ctx.globalAlpha=isHovered?1.0:0.85;ctx.fill();
            ctx.globalAlpha=1;ctx.strokeStyle=isHovered?'rgba(255,255,255,0.6)':'rgba(255,255,255,0.25)';ctx.lineWidth=isHovered?2.5:1.5;ctx.stroke();
            // Label
            var name=b.f.path.split('/').pop().replace('.ts','').replace('.js','');
            if(drawR>16){
                var fs=Math.max(8,Math.min(13,drawR*0.38));
                ctx.fillStyle='#fff';ctx.font='600 '+fs+'px monospace';ctx.textAlign='center';
                ctx.fillText(name,b.x,b.y-2);
                ctx.fillStyle='rgba(255,255,255,0.65)';ctx.font=(fs-1)+'px monospace';
                ctx.fillText(b.f.loc+' LOC',b.x,b.y+fs);
                if(isHovered&&drawR>25){
                    ctx.fillStyle='rgba(255,255,255,0.5)';ctx.font=(fs-2)+'px monospace';
                    ctx.fillText('CC:'+b.f.complexity+' MI:'+b.f.maintainability,b.x,b.y+fs*2);
                }
            }
            // Markers: T (tested) and D (dependencies) — inverted badges
            var mfs=Math.max(9,drawR*0.3);
            var mrad=mfs*0.7;
            var mpad=mrad*2.4;
            var my=b.y-drawR+mrad+3;
            if(drawR>14&&b.f.has_tests){
                var mx=b.x-(b.f.dep_count>0?mpad*0.5:0);
                ctx.beginPath();ctx.arc(mx,my,mrad,0,Math.PI*2);
                ctx.fillStyle='#16a34a';ctx.fill();
                ctx.fillStyle='#fff';ctx.font='bold '+mfs+'px sans-serif';ctx.textAlign='center';
                ctx.fillText('T',mx,my+mfs*0.35);
            }
            if(drawR>14&&b.f.dep_count>0){
                var mx2=b.x+(b.f.has_tests?mpad*0.5:0);
                ctx.beginPath();ctx.arc(mx2,my,mrad,0,Math.PI*2);
                ctx.fillStyle='#ea580c';ctx.fill();
                ctx.fillStyle='#fff';ctx.font='bold '+mfs+'px sans-serif';ctx.textAlign='center';
                ctx.fillText('D',mx2,my+mfs*0.35);
            }
            b._drawX=b.x;b._drawY=b.y;b._drawR=drawR;
        });
        // Summary
        var totalLoc=0,totalFiles=bubbles.length,testedCount=0;
        bubbles.forEach(function(b){totalLoc+=b.f.loc;if(b.f.has_tests)testedCount++;});
        var avgMI=bubbles.reduce(function(s,b){return s+b.f.maintainability},0)/totalFiles;
        ctx.fillStyle='rgba(255,255,255,0.35)';ctx.font='11px monospace';ctx.textAlign='right';
        ctx.restore();
        ctx.fillStyle='rgba(255,255,255,0.35)';ctx.font='11px monospace';ctx.textAlign='right';
        ctx.fillText(totalFiles+' files | '+totalLoc.toLocaleString()+' LOC | MI:'+avgMI.toFixed(1)+' | Tested:'+testedCount+'/'+totalFiles,W-12,H-10);
        window._metricsAnimFrame=requestAnimationFrame(draw);
    }
    draw();
    // Mouse events — hover + drag bubbles + right-click pan
    var panning=false,panStartX=0,panStartY=0;
    canvas.addEventListener('contextmenu',function(e){e.preventDefault();});
    canvas.addEventListener('mousemove',function(e){
        var rect=canvas.getBoundingClientRect();
        var mx=e.clientX-rect.left,my=e.clientY-rect.top;
        if(panning){
            panX+=(mx-panStartX);panY+=(my-panStartY);
            panStartX=mx;panStartY=my;return;
        }
        if(dragIdx>=0){
            var wmx=(mx-panX)/zoom,wmy=(my-panY)/zoom;
            bubbles[dragIdx].x=wmx-dragOX;bubbles[dragIdx].y=wmy-dragOY;
            bubbles[dragIdx].vx=0;bubbles[dragIdx].vy=0;return;
        }
        var wmx2=(mx-panX)/zoom,wmy2=(my-panY)/zoom;
        hoveredIdx=-1;
        for(var i=bubbles.length-1;i>=0;i--){
            var b=bubbles[i];
            var dx=wmx2-b.x,dy=wmy2-b.y;
            if(Math.sqrt(dx*dx+dy*dy)<=b.r){hoveredIdx=i;break;}
        }
        canvas.style.cursor=panning?'move':hoveredIdx>=0?'grab':'default';
    });
    canvas.addEventListener('mousedown',function(e){
        var rect=canvas.getBoundingClientRect();
        var mx=e.clientX-rect.left,my=e.clientY-rect.top;
        if(e.button===2){
            panning=true;panStartX=mx;panStartY=my;
            canvas.style.cursor='move';return;
        }
        if(hoveredIdx>=0){
            dragIdx=hoveredIdx;
            var wmx=(mx-panX)/zoom;
            var wmy=(my-panY)/zoom;
            dragOX=wmx-bubbles[dragIdx].x;
            dragOY=wmy-bubbles[dragIdx].y;
            canvas.style.cursor='grabbing';
        }
    });
    canvas.addEventListener('mouseup',function(){
        if(panning){panning=false;canvas.style.cursor='default';}
        if(dragIdx>=0){canvas.style.cursor='grab';dragIdx=-1;}
    });
    canvas.addEventListener('mouseleave',function(){hoveredIdx=-1;dragIdx=-1;panning=false;});
    canvas.addEventListener('dblclick',function(e){
        if(hoveredIdx<0)return;
        drillDownFile(bubbles[hoveredIdx].f.path);
    });
    // Zoom with mouse wheel
    var zoom=1.0,panX=0,panY=0;
    canvas.addEventListener('wheel',function(e){
        e.preventDefault();
        var rect=canvas.getBoundingClientRect();
        var mx=(e.clientX-rect.left-panX)/zoom;
        var my=(e.clientY-rect.top-panY)/zoom;
        var oldZoom=zoom;
        zoom*=e.deltaY<0?1.08:0.93;
        zoom=Math.max(0.5,Math.min(2.5,zoom));
        panX+=(mx*oldZoom-mx*zoom);
        panY+=(my*oldZoom-my*zoom);
        bubbles.forEach(function(b){});
    },{passive:false});
    bubbles.forEach(function(b){b._baseR=b.r;});
}
function drillDownFile(path){
    var dd=document.getElementById('metrics-drilldown');
    dd.style.display='block';
    dd.innerHTML='<div class="dev-panel" style="margin-bottom:1rem"><div class="dev-panel-header"><h2>'+path+'</h2><button class="btn btn-sm" onclick="document.getElementById(&#39;metrics-drilldown&#39;).style.display=&#39;none&#39;">Close</button></div><div class="p-md"><p style="color:var(--muted)">Loading file analysis...</p></div></div>';
    fetch('/__dev/api/metrics/file?path='+encodeURIComponent(path)).then(function(r){return r.json()}).then(function(d){
        if(d.error){dd.querySelector('.p-md').innerHTML='<p style="color:var(--danger)">'+d.error+'</p>';return;}
        var html='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:0.5rem;margin-bottom:1rem">';
        html+='<div class="sys-card"><div class="label">LOC</div><div class="value">'+d.loc+'</div></div>';
        html+='<div class="sys-card"><div class="label">Total Lines</div><div class="value">'+d.total_lines+'</div></div>';
        html+='<div class="sys-card"><div class="label">Classes</div><div class="value">'+d.classes+'</div></div>';
        html+='<div class="sys-card"><div class="label">Functions</div><div class="value">'+(d.functions?d.functions.length:0)+'</div></div>';
        html+='<div class="sys-card"><div class="label">Imports</div><div class="value">'+(d.imports?d.imports.length:0)+'</div></div>';
        html+='</div>';
        if(d.functions&&d.functions.length){
            html+='<h3 style="margin:0.5rem 0;color:var(--primary);font-size:0.85rem">Cyclomatic Complexity by Function</h3>';
            var maxCC=Math.max.apply(null,d.functions.map(function(f){return f.complexity}))||1;
            html+='<div style="display:flex;flex-direction:column;gap:4px">';
            d.functions.forEach(function(f){
                var pct=Math.max(3,f.complexity/maxCC*100);
                var color=f.complexity>20?'#ef4444':f.complexity>10?'#eab308':f.complexity>5?'#3b82f6':'#22c55e';
                html+='<div style="display:flex;align-items:center;gap:8px;font-size:0.75rem;font-family:var(--mono)">';
                html+='<span style="width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)" title="'+f.name+'">'+f.name+'</span>';
                html+='<div style="flex:1;height:16px;background:var(--bg);border-radius:3px;overflow:hidden;position:relative">';
                html+='<div style="width:'+pct+'%;height:100%;background:'+color+';border-radius:3px;transition:width 0.3s"></div>';
                html+='</div>';
                html+='<span style="width:70px;text-align:right;color:'+color+';font-weight:600">CC:'+f.complexity+'</span>';
                html+='<span style="width:60px;text-align:right;color:var(--muted)">'+f.loc+' LOC</span>';
                html+='<span style="width:30px;text-align:right;color:var(--muted)">L'+f.line+'</span>';
                html+='</div>';
            });
            html+='</div>';
        }
        if(d.imports&&d.imports.length){
            html+='<h3 style="margin:0.75rem 0 0.25rem;color:var(--primary);font-size:0.85rem">Dependencies</h3>';
            html+='<div style="display:flex;flex-wrap:wrap;gap:4px">';
            d.imports.forEach(function(imp){
                html+='<span style="padding:2px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-size:0.7rem;font-family:var(--mono)">'+imp+'</span>';
            });
            html+='</div>';
        }
        if(d.warnings&&d.warnings.length){
            html+='<h3 style="margin:0.75rem 0 0.25rem;color:#eab308;font-size:0.85rem">&#9888; Warnings</h3>';
            html+='<div style="display:flex;flex-direction:column;gap:4px">';
            d.warnings.forEach(function(w){
                html+='<div style="padding:4px 8px;background:rgba(234,179,8,0.08);border-left:3px solid #eab308;border-radius:0 4px 4px 0;font-size:0.75rem;font-family:var(--mono);color:var(--text)">';
                html+='<span style="color:#eab308;margin-right:6px">L'+w.line+'</span>'+w.message+'</div>';
            });
            html+='</div>';
        }
        dd.querySelector('.p-md').innerHTML=html;
    }).catch(function(e){
        dd.querySelector('.p-md').innerHTML='<p style="color:var(--danger)">Error: '+e.message+'</p>';
    });
    dd.scrollIntoView({behavior:'smooth',block:'start'});
}
function loadAllMetrics(){
    if(window._metricsAnimFrame)cancelAnimationFrame(window._metricsAnimFrame);
    var el=document.getElementById('metrics-quick');
    el.innerHTML='<div class="sys-card"><div class="value">Loading...</div></div>';
    fetch('/__dev/api/metrics').then(function(r){return r.json()}).then(function(d){
        if(d.error){el.innerHTML='<div class="sys-card"><div class="value" style="color:var(--danger)">'+d.error+'</div></div>';return;}
        el.innerHTML=
            '<div class="sys-card"><div class="label">TS/JS Files</div><div class="value">'+d.file_count+'</div></div>'+
            '<div class="sys-card"><div class="label">Lines of Code</div><div class="value">'+d.total_loc.toLocaleString()+'</div></div>'+
            '<div class="sys-card"><div class="label">Comment Lines</div><div class="value">'+d.total_comment.toLocaleString()+'</div></div>'+
            '<div class="sys-card"><div class="label">Blank Lines</div><div class="value">'+d.total_blank.toLocaleString()+'</div></div>'+
            '<div class="sys-card"><div class="label">Classes</div><div class="value">'+d.classes+'</div></div>'+
            '<div class="sys-card"><div class="label">Functions</div><div class="value">'+d.functions+'</div></div>'+
            '<div class="sys-card"><div class="label">Routes</div><div class="value">'+d.route_count+'</div></div>'+
            '<div class="sys-card"><div class="label">ORM Models</div><div class="value">'+d.orm_count+'</div></div>'+
            '<div class="sys-card"><div class="label">Templates</div><div class="value">'+d.template_count+'</div></div>'+
            '<div class="sys-card"><div class="label">Migrations</div><div class="value">'+d.migration_count+'</div></div>';
    }).catch(function(e){el.innerHTML='<div class="sys-card"><div class="value" style="color:var(--danger)">Error: '+e.message+'</div></div>';});
    document.getElementById('metrics-bubble').innerHTML='<p style="color:var(--muted);padding:1rem">Analyzing codebase...</p>';
    fetch('/__dev/api/metrics/full').then(function(r){return r.json()}).then(function(d){
        _metricsFullData=d;
        if(d.error){document.getElementById('metrics-bubble').innerHTML='<p style="color:var(--danger);padding:1rem">'+d.error+'</p>';return;}
        renderBubbleChart(d.file_metrics,d.dependency_graph,d.scan_mode);
        var hm=document.getElementById('metrics-heatmap');
        var rows=d.file_metrics.map(function(f){
            var color=miColor(f.maintainability);
            var barW=Math.max(2,Math.min(100,f.maintainability));
            return '<tr style="cursor:pointer" onclick="drillDownFile(&#39;'+f.path+'&#39;)"><td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:'+color+';margin-right:6px"></span>'+f.path+'</td><td>'+f.loc+'</td><td>'+f.complexity+'</td><td>'+f.avg_complexity+'</td><td><div style="display:flex;align-items:center;gap:6px"><div style="width:'+barW+'px;height:6px;border-radius:3px;background:'+color+'"></div><span>'+f.maintainability+'</span></div></td><td>'+f.instability+'</td></tr>';
        }).join('');
        hm.innerHTML='<table style="width:100%"><thead><tr><th>File</th><th>LOC</th><th>CC</th><th>Avg CC</th><th>MI</th><th>Instab.</th></tr></thead><tbody>'+rows+'</tbody></table>';
        var cf=document.getElementById('metrics-complex');
        var frows=d.most_complex_functions.map(function(f){
            var color=f.complexity>20?'#ef4444':f.complexity>10?'#eab308':'#22c55e';
            return '<tr style="cursor:pointer" onclick="drillDownFile(&#39;'+f.file+'&#39;)"><td><span style="color:'+color+';font-weight:bold">'+f.complexity+'</span></td><td>'+f.name+'</td><td>'+f.file+':'+f.line+'</td><td>'+f.loc+'</td></tr>';
        }).join('');
        cf.innerHTML='<table style="width:100%"><thead><tr><th>CC</th><th>Function</th><th>File</th><th>LOC</th></tr></thead><tbody>'+frows+'</tbody></table>';
        var cp=document.getElementById('metrics-coupling');
        var crows=d.file_metrics.filter(function(f){return f.coupling_afferent>0||f.coupling_efferent>0}).map(function(f){
            return '<tr style="cursor:pointer" onclick="drillDownFile(&#39;'+f.path+'&#39;)"><td>'+f.path+'</td><td>'+f.coupling_afferent+'</td><td>'+f.coupling_efferent+'</td><td>'+f.instability+'</td></tr>';
        }).join('');
        cp.innerHTML=crows?'<table style="width:100%"><thead><tr><th>File</th><th>Ca (in)</th><th>Ce (out)</th><th>Instability</th></tr></thead><tbody>'+crows+'</tbody></table>':'<p style="color:var(--muted)">No coupling data</p>';
        var vl=document.getElementById('metrics-violations');
        if(d.violations&&d.violations.length){
            var vrows=d.violations.map(function(v){
                var icon=v.type==='error'?'&#9888;':'&#9432;';
                var color=v.type==='error'?'#ef4444':'#eab308';
                return '<tr style="cursor:pointer" onclick="drillDownFile(&#39;'+v.file+'&#39;)"><td style="color:'+color+'">'+icon+'</td><td>'+v.message+'</td><td>'+v.file+(v.line?':'+v.line:'')+'</td></tr>';
            }).join('');
            vl.innerHTML='<table style="width:100%"><thead><tr><th></th><th>Issue</th><th>Location</th></tr></thead><tbody>'+vrows+'</tbody></table>';
        }else{
            vl.innerHTML='<p style="color:#22c55e">&#10003; No violations found</p>';
        }
    }).catch(function(e){
        document.getElementById('metrics-bubble').innerHTML='<p style="color:var(--danger);padding:1rem">Error: '+e.message+'</p>';
    });
}
var _metricsLoaded=false;
var _origShowTab=typeof showTab==='function'?showTab:null;
if(_origShowTab){
    showTab=function(name){
        _origShowTab(name);
        if(name==='metrics'&&!_metricsLoaded){_metricsLoaded=true;loadAllMetrics();}
    };
}
var metricsTab=document.querySelector('[onclick*="metrics"]');
if(metricsTab)metricsTab.addEventListener('click',function(){if(!_metricsLoaded){_metricsLoaded=true;loadAllMetrics();}});
</script>
<script>
// Self-diagnostic — detect if the external JS failed to load
(function() {
    if (typeof showTab !== 'function') {
        var banner = document.createElement('div');
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#ef4444;color:#fff;padding:0.75rem 1rem;font-family:system-ui;font-size:0.85rem;text-align:center';
        banner.innerHTML = '<strong>Dev Admin Error:</strong> tina4-dev-admin.min.js failed to load.';
        document.body.insertBefore(banner, document.body.firstChild);
    }
})();
</script>
</body>
</html>`;
}

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
    <a href="#" onclick="(function(e){e.preventDefault();var p=document.getElementById('tina4-dev-panel');if(p){p.style.display=p.style.display==='none'?'block':'none';return;}var c=document.createElement('div');c.id='tina4-dev-panel';c.style.cssText='position:fixed;top:3rem;left:0;right:0;bottom:2rem;z-index:99998;transition:all 0.2s';var f=document.createElement('iframe');f.src='/__dev';f.style.cssText='width:100%;height:100%;border:1px solid #2e7d32;border-radius:0.5rem;box-shadow:0 8px 32px rgba(0,0,0,0.5);background:#0f172a';c.appendChild(f);document.body.appendChild(c);})(event)" style="color:#ef9a9a;margin-left:auto;text-decoration:none;cursor:pointer;">Dashboard &#8599;</a>
    <span onclick="this.parentElement.style.display='none'" style="cursor:pointer;color:#888;margin-left:8px;">&#10005;</span>
</div>
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
</script>`;
}
