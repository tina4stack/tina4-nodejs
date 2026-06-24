/**
 * Unit tests for DevAdmin utility classes (MessageLog, RequestInspector, ErrorTracker).
 * Run with: npx tsx test/devAdmin.test.ts
 */
import {
  MessageLog, RequestInspector, ErrorTracker,
} from "../packages/core/src/index.ts";
import { SQLiteAdapter } from "../packages/orm/src/index.ts";

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

console.log("=== DevAdmin Tests ===\n");

// ── MessageLog ──────────────────────────────────────────────

console.log("--- MessageLog ---");

// Clear any state from previous tests
MessageLog.clear();

MessageLog.log("http", "info", "Request received", { path: "/api/users" });
MessageLog.log("http", "warn", "Slow request", { durationMs: 500 });
MessageLog.log("auth", "error", "Invalid token");

const allLogs = MessageLog.get();
assert("get() returns logged messages", allLogs.length === 3);
assert("messages are in reverse order (newest first)", allLogs[0].message === "Invalid token");
assert("message has id", typeof allLogs[0].id === "string");
assert("message has timestamp", typeof allLogs[0].timestamp === "string");
assert("message has category", allLogs[0].category === "auth");
assert("message has level", allLogs[0].level === "error");
assert("message has data when provided", allLogs[2].data !== undefined);

// --- MessageLog get with category filter ---
console.log("\n--- MessageLog category filter ---");

const httpLogs = MessageLog.get("http");
assert("get(category) filters by category", httpLogs.length === 2);
assert("filtered logs all have correct category", httpLogs.every((l) => l.category === "http"));

const authLogs = MessageLog.get("auth");
assert("auth category has 1 log", authLogs.length === 1);

// --- MessageLog get with limit ---
console.log("\n--- MessageLog limit ---");

const limited = MessageLog.get(undefined, 1);
assert("get with limit returns limited results", limited.length === 1);

// --- MessageLog count ---
console.log("\n--- MessageLog count ---");

const counts = MessageLog.count();
assert("count returns total", counts.total === 3);
assert("count returns http count", counts.http === 2);
assert("count returns auth count", counts.auth === 1);

// --- MessageLog clear with category ---
console.log("\n--- MessageLog clear ---");

MessageLog.clear("http");
const afterClearHttp = MessageLog.get();
assert("clear(category) removes only that category", afterClearHttp.length === 1);
assert("remaining message is auth", afterClearHttp[0].category === "auth");

// --- MessageLog clear all ---
MessageLog.clear();
const afterClearAll = MessageLog.get();
assert("clear() removes all messages", afterClearAll.length === 0);

// ── RequestInspector ────────────────────────────────────────

console.log("\n--- RequestInspector ---");

RequestInspector.clear();

RequestInspector.capture("GET", "/api/users", 200, 12.5);
RequestInspector.capture("POST", "/api/users", 201, 45.3);
RequestInspector.capture("GET", "/api/users/1", 404, 3.7);
RequestInspector.capture("GET", "/api/health", 500, 200.1);

const reqs = RequestInspector.get();
assert("get() returns captured requests", reqs.length === 4);
assert("requests are in reverse order", reqs[0].path === "/api/health");
assert("request has id", typeof reqs[0].id === "string");
assert("request has timestamp", typeof reqs[0].timestamp === "string");
assert("request has method", reqs[0].method === "GET");
assert("request has status", reqs[0].status === 500);
assert("request has durationMs", typeof reqs[0].durationMs === "number");

// --- RequestInspector get with limit ---
console.log("\n--- RequestInspector limit ---");

const limitedReqs = RequestInspector.get(2);
assert("get(limit) limits results", limitedReqs.length === 2);

// --- RequestInspector stats ---
console.log("\n--- RequestInspector stats ---");

const stats = RequestInspector.stats();
assert("stats total is 4", stats.total === 4);
assert("stats has avgMs", typeof stats.avgMs === "number" && stats.avgMs > 0);
assert("stats errors counts 4xx and 5xx", stats.errors === 2);
assert("stats slowestMs is max duration", stats.slowestMs >= 200);

// --- RequestInspector stats empty ---
console.log("\n--- RequestInspector stats empty ---");

RequestInspector.clear();
const emptyStats = RequestInspector.stats();
assert("empty stats total is 0", emptyStats.total === 0);
assert("empty stats avgMs is 0", emptyStats.avgMs === 0);
assert("empty stats errors is 0", emptyStats.errors === 0);
assert("empty stats slowestMs is 0", emptyStats.slowestMs === 0);

// --- RequestInspector clear ---
console.log("\n--- RequestInspector clear ---");

RequestInspector.capture("GET", "/test", 200, 1);
RequestInspector.clear();
assert("clear empties requests", RequestInspector.get().length === 0);

// ── ErrorTracker ────────────────────────────────────────────

console.log("\n--- ErrorTracker ---");

// Clear static state
ErrorTracker.reset();

ErrorTracker.capture("Error", "Something went wrong", "Error\n  at main.ts:10");
ErrorTracker.capture("Error", "Database connection failed");
ErrorTracker.capture("Error", "Timeout exceeded", "Error\n  at db.ts:42");

const errors = ErrorTracker.get();
assert("get() returns tracked errors", errors.length === 3);
assert("errors are in reverse order", errors[0].message === "Timeout exceeded");
assert("error has id", typeof errors[0].id === "string");
assert("error has timestamp", typeof errors[0].timestamp === "string");
assert("error has message", errors[0].message === "Timeout exceeded");
assert("error has stack when provided", typeof errors[0].stack === "string");
assert("error has resolved=false", errors[0].resolved === false);
assert("error without stack has undefined stack", errors[1].stack === undefined);

// --- ErrorTracker capture dedup ---
console.log("\n--- ErrorTracker capture dedup ---");

ErrorTracker.reset();
ErrorTracker.capture("ValueError", "bad input", "", "app.ts", 10);
ErrorTracker.capture("ValueError", "bad input", "", "app.ts", 10);
const dedupErrors = ErrorTracker.get();
assert("dedup: same error produces 1 entry", dedupErrors.length === 1);
assert("dedup: count increments to 2", (dedupErrors[0] as any).count === 2);

// --- ErrorTracker resolve ---
console.log("\n--- ErrorTracker resolve ---");

ErrorTracker.reset();
ErrorTracker.capture("Error", "Timeout exceeded", "Error\n  at db.ts:42");
ErrorTracker.capture("Error", "Database connection failed");
const errorsForResolve = ErrorTracker.get();
const errId = errorsForResolve[0].id;
const resolved = ErrorTracker.resolve(errId);
assert("resolve returns true for existing error", resolved === true);

const updatedErrors = ErrorTracker.get();
const resolvedErr = updatedErrors.find((e) => e.id === errId);
assert("resolved error has resolved=true", resolvedErr?.resolved === true);

const resolveFalse = ErrorTracker.resolve("nonexistent-id");
assert("resolve returns false for unknown id", resolveFalse === false);

// --- ErrorTracker clearResolved ---
console.log("\n--- ErrorTracker clearResolved ---");

ErrorTracker.clearResolved();
const afterClearResolved = ErrorTracker.get();
assert("clearResolved removes resolved errors", afterClearResolved.length === 1);
assert("unresolved errors remain", afterClearResolved.every((e) => e.resolved === false));

// --- ErrorTracker health ---
console.log("\n--- ErrorTracker health ---");

ErrorTracker.reset();
ErrorTracker.capture("Error", "one", "", "a.ts", 1);
ErrorTracker.capture("Error", "two", "", "b.ts", 2);
const healthId = ErrorTracker.get()[0].id;
ErrorTracker.resolve(healthId);
const health = ErrorTracker.health();
assert("health total is 2", health.total === 2);
assert("health unresolved is 1", health.unresolved === 1);
assert("health resolved is 1", health.resolved === 1);
assert("health healthy is false", health.healthy === false);

// --- ErrorTracker health empty ---
ErrorTracker.reset();
const emptyHealth = ErrorTracker.health();
assert("empty health is healthy", emptyHealth.healthy === true);
assert("empty health total is 0", emptyHealth.total === 0);

// --- ErrorTracker unresolvedCount ---
console.log("\n--- ErrorTracker unresolvedCount ---");

ErrorTracker.reset();
ErrorTracker.capture("Error", "one", "", "a.ts", 1);
ErrorTracker.capture("Error", "two", "", "b.ts", 2);
const ucId = ErrorTracker.get()[0].id;
ErrorTracker.resolve(ucId);
assert("unresolvedCount returns 1", ErrorTracker.unresolvedCount() === 1);

// --- ErrorTracker clearAll ---
console.log("\n--- ErrorTracker clearAll ---");

ErrorTracker.capture("Error", "three", "", "c.ts", 3);
ErrorTracker.clearAll();
assert("clearAll removes all errors", ErrorTracker.get().length === 0);

// --- ErrorTracker reset ---
console.log("\n--- ErrorTracker reset ---");

ErrorTracker.capture("Error", "after-clear");
ErrorTracker.reset();
assert("reset removes all errors", ErrorTracker.get().length === 0);

// --- ErrorTracker track (legacy alias) ---
console.log("\n--- ErrorTracker track (legacy) ---");

ErrorTracker.reset();
ErrorTracker.track("Legacy message", "stack trace");
const legacyErrors = ErrorTracker.get();
assert("track still works as legacy alias", legacyErrors.length === 1);
assert("track message stored", legacyErrors[0].message === "Legacy message");

// ── Multi-statement SQL execution ──────────────────────────

console.log("\n--- Multi-statement SQL execution ---");

const multiDb = new SQLiteAdapter(":memory:");

// Execute multi-statement batch: CREATE TABLE + INSERTs (mirrors handleQuery logic)
multiDb.startTransaction();
multiDb.execute("CREATE TABLE test_multi (id INTEGER PRIMARY KEY, name TEXT)");
multiDb.execute("INSERT INTO test_multi (id, name) VALUES (1, 'Alice')");
multiDb.execute("INSERT INTO test_multi (id, name) VALUES (2, 'Bob')");
multiDb.commit();

const multiRows = multiDb.fetch<{ id: number; name: string }>("SELECT * FROM test_multi");
assert("multi-statement: table created and rows inserted", multiRows.length === 2);
assert("multi-statement: first row is Alice", multiRows[0].name === "Alice");
assert("multi-statement: second row is Bob", multiRows[1].name === "Bob");
multiDb.close();

// ── Multi-statement rollback ───────────────────────────────

console.log("\n--- Multi-statement rollback ---");

const rbDb = new SQLiteAdapter(":memory:");
// CREATE TABLE runs outside a transaction (auto-commit)
rbDb.execute("CREATE TABLE test_rb (id INTEGER PRIMARY KEY, name TEXT)");

// Start transaction, insert a row, then try bad statement
rbDb.startTransaction();
rbDb.execute("INSERT INTO test_rb (id, name) VALUES (1, 'Alice')");
let rollbackError = false;
try {
  rbDb.execute("INSERT INTO nonexistent_table (x) VALUES (1)");
} catch {
  rollbackError = true;
  rbDb.rollback();
}
assert("multi-statement rollback: bad statement throws error", rollbackError === true);

// After rollback, the valid INSERT should also be rolled back
const rbRows = rbDb.fetch<{ id: number }>("SELECT * FROM test_rb");
assert("multi-statement rollback: no rows after rollback", rbRows.length === 0);
rbDb.close();

// ── SQLite LIMIT dedup ─────────────────────────────────────

console.log("\n--- SQLite LIMIT dedup ---");

const limDb = new SQLiteAdapter(":memory:");
limDb.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
limDb.startTransaction();
for (let i = 0; i < 10; i++) {
  limDb.execute(`INSERT INTO items (id, name) VALUES (${i}, 'item${i}')`);
}
limDb.commit();

// SQL already has LIMIT — should NOT double it
const withLimit = limDb.fetch<{ id: number }>("SELECT * FROM items LIMIT 3", undefined, 20);
assert("fetch with existing LIMIT: returns 3 rows (not 20)", withLimit.length === 3);

// SQL without LIMIT — adapter adds the requested limit
const withoutLimit = limDb.fetch<{ id: number }>("SELECT * FROM items", undefined, 5);
assert("fetch without LIMIT: adapter adds limit, returns 5 rows", withoutLimit.length === 5);

// SQL without LIMIT and no limit param — returns all rows
const noLimitParam = limDb.fetch<{ id: number }>("SELECT * FROM items");
assert("fetch with no limit param: returns all 10 rows", noLimitParam.length === 10);

limDb.close();

// ── DevAdmin API Endpoint Tests ────────────────────────────
// These tests register the DevAdmin routes on a real Router instance,
// then invoke each handler with mock req/res objects and assert the
// response shape.

console.log("\n--- DevAdmin API Endpoint Tests ---");

import {
  DevAdmin, DevQueue,
} from "../packages/core/src/index.ts";
import { Router } from "../packages/core/src/index.ts";

// Set TINA4_DEBUG so DevAdmin.isEnabled() is true
process.env.TINA4_DEBUG = "true";

const router = new Router();
DevAdmin.register(router);

// Helper: find a registered handler by method + pattern
function findHandler(method: string, pattern: string) {
  const routes = router.getRoutes();
  const route = routes.find((r) => r.method === method && r.pattern === pattern);
  return route?.handler;
}

// Helper: create a mock request
function mockReq(url = "/"): any {
  return { url, headers: {}, method: "GET" };
}

// Helper: create a mock response that captures the JSON output
function mockRes(): any {
  let captured: any = undefined;
  return {
    json(data: any, _status?: number) { captured = data; },
    html(_data: any, _status?: number) {},
    get result() { return captured; },
  };
}

// --- handleStatus ---
console.log("\n--- handleStatus endpoint ---");

const statusHandler = findHandler("GET", "/__dev/api/status");
assert("handleStatus handler is registered", statusHandler !== undefined);

if (statusHandler) {
  // Seed some data so status has content
  MessageLog.clear();
  MessageLog.log("test", "info", "status check");
  RequestInspector.clear();
  RequestInspector.capture("GET", "/test", 200, 5);

  // Register a known user route on the SAME router so the reported route
  // count must reflect the real route table (not just be a number).
  router.get("/__status_probe_route", async (_req, res2) => res2.json({ ok: true }));
  const realRouteCount = router.getRoutes().length;

  const res = mockRes();
  await statusHandler(mockReq("/__dev/api/status"), res);
  const data = res.result;

  assert("handleStatus returns an object", typeof data === "object" && data !== null);
  assert("handleStatus has framework field", typeof data.framework === "string" && data.framework.includes("tina4-nodejs"));
  // routes must equal the live router's real route-table length, and must
  // include the probe route we just registered.
  assert("handleStatus routes reflects the real route table",
    data.routes === realRouteCount,
    `data.routes=${data.routes} expected ${realRouteCount}`);
  assert("handleStatus routes counts our newly-registered probe route",
    data.routes >= 1 && router.getRoutes().some((r) => r.pattern === "/__status_probe_route"));
  assert("handleStatus has messages field", data.messages !== undefined);
  assert("handleStatus has requests field", data.requests !== undefined);
  // memory: rss must be a real positive megabyte count from process.memoryUsage().
  const liveRssMb = Math.round(process.memoryUsage().rss / 1048576);
  assert("handleStatus memory.rss is a real positive MB count",
    typeof data.memory === "object" && data.memory.rss > 0 && data.memory.rss <= liveRssMb + 64,
    `data.memory.rss=${data.memory?.rss} liveRssMb=${liveRssMb}`);
  // uptime: the handler returns Math.round(process.uptime()); it must track the
  // real process uptime (non-negative and not beyond it — a sub-second uptime
  // legitimately rounds to 0), not be an arbitrary number.
  assert("handleStatus uptime tracks the real process.uptime()",
    typeof data.uptime === "number" && data.uptime >= 0 && data.uptime <= Math.ceil(process.uptime()) + 1,
    `data.uptime=${data.uptime} process.uptime=${process.uptime()}`);
  // timestamp: a real, parseable, near-now ISO date (within 5s of Date.now()).
  const tsMs = new Date(data.timestamp).getTime();
  assert("handleStatus timestamp is a finite near-now ISO date",
    Number.isFinite(tsMs) && Math.abs(Date.now() - tsMs) < 5000,
    `data.timestamp=${data.timestamp}`);
  // nodeVersion: the actual running Node version.
  assert("handleStatus nodeVersion equals process.version",
    data.nodeVersion === process.version,
    `data.nodeVersion=${data.nodeVersion} process.version=${process.version}`);
  // debug: TINA4_DEBUG was set to "true" above, so it must reflect that.
  assert("handleStatus debug reflects TINA4_DEBUG=true",
    data.debug === process.env.TINA4_DEBUG && data.debug === "true",
    `data.debug=${data.debug}`);
  assert("handleStatus has health field", typeof data.health === "object");
}

// --- handleRoutes ---
console.log("\n--- handleRoutes endpoint ---");

const routesHandler = findHandler("GET", "/__dev/api/routes");
assert("handleRoutes handler is registered", routesHandler !== undefined);

if (routesHandler) {
  const res = mockRes();
  routesHandler(mockReq("/__dev/api/routes"), res);
  const data = res.result;

  assert("handleRoutes returns an object", typeof data === "object" && data !== null);
  assert("handleRoutes has routes array", Array.isArray(data.routes));
  assert("handleRoutes has count field", typeof data.count === "number");
  assert("handleRoutes count matches routes length", data.count === data.routes.length);
  // Internal routes (/__dev) should be filtered out
  const hasDevRoute = data.routes.some((r: any) => r.path.startsWith("/__dev"));
  assert("handleRoutes filters out /__dev routes", !hasDevRoute);
}

// --- handleMessages ---
console.log("\n--- handleMessages endpoint ---");

const messagesHandler = findHandler("GET", "/__dev/api/messages");
assert("handleMessages handler is registered", messagesHandler !== undefined);

if (messagesHandler) {
  MessageLog.clear();
  MessageLog.log("api", "info", "Test message 1");
  MessageLog.log("api", "warn", "Test message 2");

  const res = mockRes();
  messagesHandler(mockReq("/__dev/api/messages"), res);
  const data = res.result;

  assert("handleMessages returns an object", typeof data === "object" && data !== null);
  assert("handleMessages has messages array", Array.isArray(data.messages));
  assert("handleMessages messages has correct count", data.messages.length === 2);
  assert("handleMessages has counts field", typeof data.counts === "object");
  assert("handleMessages counts has total", typeof data.counts.total === "number");

  // Test category filter via query param
  MessageLog.log("other", "info", "Other category");
  const resFiltered = mockRes();
  messagesHandler(mockReq("/__dev/api/messages?category=api"), resFiltered);
  const filteredData = resFiltered.result;
  assert("handleMessages category filter works", filteredData.messages.length === 2);
  assert("handleMessages filtered messages are all 'api'", filteredData.messages.every((m: any) => m.category === "api"));
}

// --- handleSystem ---
console.log("\n--- handleSystem endpoint ---");

const systemHandler = findHandler("GET", "/__dev/api/system");
assert("handleSystem handler is registered", systemHandler !== undefined);

if (systemHandler) {
  const os = await import("node:os");
  const res = mockRes();
  await systemHandler(mockReq("/__dev/api/system"), res);
  const data = res.result;

  assert("handleSystem returns an object", typeof data === "object" && data !== null);
  // Each field must equal the real value computed from the live process, not
  // merely be of the right JS type.
  assert("handleSystem node_version equals process.version",
    data.node_version === process.version, `got ${data.node_version}`);
  assert("handleSystem platform equals process.platform",
    data.platform === process.platform, `got ${data.platform}`);
  assert("handleSystem architecture equals process.arch",
    data.architecture === process.arch, `got ${data.architecture}`);
  assert("handleSystem pid equals process.pid",
    data.pid === process.pid, `got ${data.pid}`);
  assert("handleSystem cpus equals os.cpus().length",
    data.cpus === os.cpus().length, `got ${data.cpus} expected ${os.cpus().length}`);
  assert("handleSystem memory_mb is a real positive heap-used MB count",
    typeof data.memory_mb === "number" && data.memory_mb > 0, `got ${data.memory_mb}`);
  assert("handleSystem has memory object", typeof data.memory === "object");
  assert("handleSystem memory has current_mb", typeof data.memory.current_mb === "number");
  assert("handleSystem has framework object", typeof data.framework === "object");
  assert("handleSystem framework has name", data.framework.name === "tina4-nodejs");
  assert("handleSystem has uptime object", typeof data.uptime === "object");
  assert("handleSystem uptime has seconds", typeof data.uptime.seconds === "number");
  assert("handleSystem has node object", typeof data.node === "object");
}

// --- handleTables ---
console.log("\n--- handleTables endpoint ---");

const tablesHandler = findHandler("GET", "/__dev/api/tables");
assert("handleTables handler is registered", tablesHandler !== undefined);

if (tablesHandler) {
  // Without a database connected, it should return empty tables array
  const res = mockRes();
  await tablesHandler(mockReq("/__dev/api/tables"), res);
  const data = res.result;

  assert("handleTables returns an object", typeof data === "object" && data !== null);
  assert("handleTables has tables field", Array.isArray(data.tables));
  // When no DB is connected, tables should be empty and may have a message
  assert("handleTables tables is an array (empty without DB)", data.tables.length === 0);
}

// --- handleQueue ---
console.log("\n--- handleQueue endpoint ---");

const queueHandler = findHandler("GET", "/__dev/api/queue");
assert("handleQueue handler is registered", queueHandler !== undefined);

if (queueHandler) {
  // Clear and seed some queue jobs
  // DevQueue has no public clear, so we work with what's there
  DevQueue.add("send-email", { to: "test@example.com" });
  DevQueue.add("process-image", { file: "photo.jpg" });

  const res = mockRes();
  queueHandler(mockReq("/__dev/api/queue"), res);
  const data = res.result;

  assert("handleQueue returns an object", typeof data === "object" && data !== null);
  assert("handleQueue has jobs array", Array.isArray(data.jobs));
  assert("handleQueue has stats object", typeof data.stats === "object");
  // The two jobs we just enqueued are freshly added → pending, so pending must
  // count at least those two real jobs.
  assert("handleQueue stats.pending counts the jobs we enqueued",
    data.stats.pending >= 2,
    `stats.pending=${data.stats.pending}`);
  // The per-status counts must add up to the real number of jobs returned (no
  // status filter on this call), proving stats reflect the actual queue.
  const statusSum = data.stats.pending + data.stats.completed + data.stats.failed + (data.stats.reserved ?? 0);
  assert("handleQueue stats sum equals the total job count",
    statusSum === data.jobs.length,
    `pending+completed+failed+reserved=${statusSum} jobs.length=${data.jobs.length}`);
  assert("handleQueue jobs have expected shape", data.jobs.length >= 2);
  const job = data.jobs[0];
  assert("handleQueue job has id", typeof job.id === "string");
  assert("handleQueue job has topic", typeof job.topic === "string");
  assert("handleQueue job has status", typeof job.status === "string");
  assert("handleQueue job has created_at", typeof job.created_at === "string");

  // Test status filter
  const resFiltered = mockRes();
  queueHandler(mockReq("/__dev/api/queue?status=completed"), resFiltered);
  const filteredData = resFiltered.result;
  assert("handleQueue status filter returns only matching jobs",
    filteredData.jobs.every((j: any) => j.status === "completed") || filteredData.jobs.length === 0);
}

// --- Hot reload parity ---
// Mirrors tina4-php/tests/DevAdminTest.php, tina4-python/tests/test_dev_admin.py,
// tina4-ruby/spec/dev_admin_spec.rb. The mtime counter must only advance when
// POST /__dev/api/reload is called. No filesystem scan, no sentinel file.
console.log("\n--- hot reload ---");

const mtimeHandler = findHandler("GET", "/__dev/api/mtime");
const reloadHandler = findHandler("POST", "/__dev/api/reload");
assert("mtime handler is registered", mtimeHandler !== undefined);
assert("reload handler is registered", reloadHandler !== undefined);

if (mtimeHandler && reloadHandler) {
  function reqWithBody(url: string, body: any): any {
    return { url, headers: {}, method: "POST", body };
  }

  // POST bumps the counter
  const beforeTs = Math.floor(Date.now() / 1000);
  const postRes = mockRes();
  await reloadHandler(reqWithBody("/__dev/api/reload", { file: "src/routes/home.ts", type: "reload" }), postRes);
  const afterTs = Math.floor(Date.now() / 1000);

  assert("reload returns ok", postRes.result?.ok === true);
  assert("reload echoes type", postRes.result?.type === "reload");

  const g1 = mockRes();
  await mtimeHandler(mockReq("/__dev/api/mtime"), g1);
  const d1 = g1.result;
  assert("mtime in [before, after]", d1.mtime >= beforeTs && d1.mtime <= afterTs);
  assert("mtime file echoes POST body", d1.file === "src/routes/home.ts");

  // No sentinel file is written to disk
  const fs = await import("node:fs");
  const path = await import("node:path");
  const srcSentinel = path.join(process.cwd(), "src", ".reload_sentinel");
  const tinaSentinel = path.join(process.cwd(), ".tina4", ".reload_sentinel");
  assert("no src/.reload_sentinel on disk", !fs.existsSync(srcSentinel));
  assert("no .tina4/.reload_sentinel on disk", !fs.existsSync(tinaSentinel));

  // Monotonic across successive reloads
  await new Promise((r) => setTimeout(r, 1100));
  const postRes2 = mockRes();
  await reloadHandler(reqWithBody("/__dev/api/reload", { file: "b.ts" }), postRes2);

  const g2 = mockRes();
  await mtimeHandler(mockReq("/__dev/api/mtime"), g2);
  assert("mtime strictly greater after a later reload", g2.result.mtime > d1.mtime);
  assert("file updated to latest reload", g2.result.file === "b.ts");
}

// ── Supervisor proxy (chat + threads) ──────────────────────
// Spins up a local HTTP stub on a random port, points
// TINA4_SUPERVISOR_URL at it, and asserts our /__dev/api/chat and
// /__dev/api/threads* handlers forward correctly. Mirrors Python's
// proxy parity (tina4_python.dev_admin._api_chat / _api_threads).
console.log("\n--- supervisor proxy (chat + threads) ---");
{
  const { createServer } = await import("node:http");

  type Captured = {
    method: string;
    url: string;
    body: string;
    contentType: string;
  };

  // Tiny stub for the Rust agent. Routes responses based on path:
  //   /chat            → SSE stream of two events
  //   /threads (GET)   → JSON list
  //   /threads (POST)  → JSON echo
  //   /threads/<id>    → JSON echo (handles PATCH/GET)
  const captured: Captured[] = [];
  const stub = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body,
        contentType: String(req.headers["content-type"] ?? ""),
      });

      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;

      if (path === "/chat") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        res.write("event: status\ndata: {\"ok\":true}\n\n");
        res.write("event: done\ndata: {}\n\n");
        res.end();
        return;
      }

      if (path === "/threads" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ threads: [{ id: "abc" }, { id: "def" }] }));
        return;
      }

      if (path === "/threads" && req.method === "POST") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ created: true, echo: body }));
        return;
      }

      if (path.startsWith("/threads/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ path, method: req.method, echo: body }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "stub: not found" }));
    });
  });

  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubPort = (stub.address() as import("node:net").AddressInfo).port;
  const prevSupervisor = process.env.TINA4_SUPERVISOR_URL;
  process.env.TINA4_SUPERVISOR_URL = `http://127.0.0.1:${stubPort}`;

  // Re-register routes so any cached env reads (there are none here, but
  // safety) settle. The existing `router` already has handlers wired —
  // supervisorBaseUrl() reads process.env on every call.
  const chatHandler = findHandler("POST", "/__dev/api/chat");
  const threadsListHandler = findHandler("GET", "/__dev/api/threads");
  const threadsCreateHandler = findHandler("POST", "/__dev/api/threads");
  const threadsPatchHandler = findHandler("PATCH", "/__dev/api/threads/{id}");
  const threadsMessagesHandler = findHandler("GET", "/__dev/api/threads/{id}/messages");

  assert("chat handler registered", chatHandler !== undefined);
  assert("threads GET handler registered", threadsListHandler !== undefined);
  assert("threads POST handler registered", threadsCreateHandler !== undefined);
  assert("threads PATCH handler registered", threadsPatchHandler !== undefined);
  assert("threads messages GET handler registered", threadsMessagesHandler !== undefined);

  // Build a fuller mock res for streaming + status capture
  function streamingRes(): any {
    let json: any = undefined;
    let status: number | undefined = undefined;
    let chunks: Buffer[] = [];
    let headers: Record<string, string | number | string[]> = {};
    return {
      json(data: any, s?: number) { json = data; status = s; },
      html(_: any, s?: number) { status = s; },
      raw: {
        writeHead(code: number, h?: Record<string, string | number | string[]>) {
          status = code;
          if (h) headers = h;
        },
        write(buf: Buffer | string) {
          chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)));
        },
        end(buf?: Buffer | string) {
          if (buf !== undefined) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)));
        },
        flushHeaders() { /* noop */ },
      },
      get result() { return json; },
      get status() { return status; },
      get streamed() { return Buffer.concat(chunks).toString("utf-8"); },
      get streamHeaders() { return headers; },
    };
  }

  function reqWith(opts: { url: string; method: string; body?: any }): any {
    return { url: opts.url, method: opts.method, headers: {}, body: opts.body };
  }

  // 1. proxies threads list to the supervisor
  captured.length = 0;
  {
    const res = streamingRes();
    await threadsListHandler!(reqWith({ url: "/__dev/api/threads", method: "GET" }), res);
    assert("threads list reached the stub", captured.some((c) => c.method === "GET" && c.url === "/threads"));
    assert(
      "threads list response forwarded verbatim",
      res.result && Array.isArray((res.result as any).threads) && (res.result as any).threads.length === 2,
    );
  }

  // 2. honours TINA4_SUPERVISOR_URL env var
  //    The previous assertion already proves it (the stub is on a random
  //    port that only TINA4_SUPERVISOR_URL points at) — assert it
  //    explicitly so the intent is documented.
  assert(
    "honours TINA4_SUPERVISOR_URL env var",
    captured.length >= 1 && process.env.TINA4_SUPERVISOR_URL === `http://127.0.0.1:${stubPort}`,
  );

  // 3. forwards active_file in chat POST (SSE response)
  captured.length = 0;
  {
    const res = streamingRes();
    await chatHandler!(reqWith({
      url: "/__dev/api/chat",
      method: "POST",
      body: { message: "hello", active_file: "src/routes/home.ts", thread_id: "t1" },
    }), res);
    const chatCall = captured.find((c) => c.url === "/chat" && c.method === "POST");
    assert("chat POST reached the stub", chatCall !== undefined);
    let forwardedBody: any = {};
    try { forwardedBody = JSON.parse(chatCall?.body ?? "{}"); } catch { /* leave default */ }
    assert("active_file forwarded verbatim", forwardedBody.active_file === "src/routes/home.ts");
    assert("message forwarded verbatim", forwardedBody.message === "hello");
    assert("thread_id forwarded verbatim", forwardedBody.thread_id === "t1");
    assert("chat content-type is JSON to upstream", chatCall?.contentType.includes("application/json") ?? false);
    assert("chat response streamed back as SSE", res.streamed.includes("event: status") && res.streamed.includes("event: done"));
  }

  // 4. patches threads on upstream
  captured.length = 0;
  {
    const res = streamingRes();
    await threadsPatchHandler!(reqWith({
      url: "/__dev/api/threads/abc123",
      method: "PATCH",
      body: { archived: true },
    }), res);
    const patchCall = captured.find((c) => c.method === "PATCH" && c.url === "/threads/abc123");
    assert("PATCH threads/{id} reached the stub", patchCall !== undefined);
    let forwardedBody: any = {};
    try { forwardedBody = JSON.parse(patchCall?.body ?? "{}"); } catch { /* leave default */ }
    assert("PATCH body forwarded verbatim", forwardedBody.archived === true);
    const result = res.result as any;
    assert(
      "PATCH response forwarded verbatim",
      result && result.path === "/threads/abc123" && result.method === "PATCH",
    );
  }

  // 5. threads messages history (sub-path forwarding)
  captured.length = 0;
  {
    const res = streamingRes();
    await threadsMessagesHandler!(reqWith({
      url: "/__dev/api/threads/abc123/messages",
      method: "GET",
    }), res);
    const msgCall = captured.find((c) => c.method === "GET" && c.url === "/threads/abc123/messages");
    assert("messages sub-path forwarded verbatim", msgCall !== undefined);
  }

  // 6. threads POST create rejects unsupported methods? GET/POST/PATCH all supported here.
  //    The list+create handler enforces GET/POST only — sanity-check that.
  {
    const res = streamingRes();
    await threadsListHandler!(reqWith({ url: "/__dev/api/threads", method: "PUT" }), res);
    assert("threads list/create rejects PUT with 405", res.status === 405 && (res.result as any)?.error === "method not allowed");
  }

  // Cleanup
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  if (prevSupervisor === undefined) delete process.env.TINA4_SUPERVISOR_URL;
  else process.env.TINA4_SUPERVISOR_URL = prevSupervisor;
}

// --- file browser (/__dev/api/files) ---
// Locks the SPA contract that broke once: every entry MUST carry `is_dir`
// (boolean) so the dashboard can render folders, plus `has_children`,
// `git_status` and `size`; the payload carries the git `branch`. Mirrors the
// tina4-python / tina4-php / tina4-ruby files endpoint 1:1.
console.log("\n--- file browser ---");

const filesHandler = findHandler("GET", "/__dev/api/files");
assert("files handler is registered", filesHandler !== undefined);

if (filesHandler) {
  const res = mockRes();
  await filesHandler(mockReq("/__dev/api/files?path=."), res);
  const data = res.result;

  assert("files returns path", typeof data?.path === "string");
  assert("files returns branch (string)", typeof data?.branch === "string");
  assert("files returns entries array", Array.isArray(data?.entries) && data.entries.length > 0);

  const entry = data.entries[0];
  assert("entry has is_dir (boolean)", typeof entry?.is_dir === "boolean");
  assert("entry has has_children field", "has_children" in entry);
  assert("entry has git_status (string)", typeof entry?.git_status === "string");
  assert("entry has size field", "size" in entry);
  assert("entry has name + path", typeof entry?.name === "string" && typeof entry?.path === "string");
  // The legacy `type` field is gone — canonical shape is is_dir, not type.
  assert("no legacy `type` field on entries", data.entries.every((e: any) => !("type" in e)));

  const dir = data.entries.find((e: any) => e.is_dir === true);
  const file = data.entries.find((e: any) => e.is_dir === false);
  assert("at least one directory (is_dir true, size null)", dir !== undefined && dir.size === null);
  assert("directory reports has_children boolean", dir === undefined || typeof dir.has_children === "boolean");
  assert("at least one file (is_dir false, has_children null)", file !== undefined && file.has_children === null);

  // Missing / invalid path: empty-but-valid shape, never a throwing 404.
  const resMissing = mockRes();
  await filesHandler(mockReq("/__dev/api/files?path=__does_not_exist__"), resMissing);
  assert("missing path returns entries: []", Array.isArray(resMissing.result?.entries) && resMissing.result.entries.length === 0);
  assert("missing path still returns branch", typeof resMissing.result?.branch === "string");
}

// --- file read language detection (/__dev/api/file) ---
// Locks the SPA contract that the editor needs to syntax-highlight: the
// file-read endpoint MUST return a `language` string derived from the file
// extension, identical in coverage to the Python master lang_map. This was the
// "ts not highlighting on Node" bug — the endpoint returned no language at all.
console.log("\n--- file read language detection ---");

const fileReadHandler = findHandler("GET", "/__dev/api/file");
assert("file read handler is registered", fileReadHandler !== undefined);

if (fileReadHandler) {
  const fsmod = await import("node:fs");
  const pathmod = await import("node:path");
  const root = process.cwd();

  // Write two tiny real files under the repo so the handler reads them through
  // its normal safeJoin/readFileSync path (path is repo-relative).
  const tsRel = pathmod.join("data", "__lang_probe.ts");
  const rbRel = pathmod.join("data", "__lang_probe.rb");
  const tsAbs = pathmod.join(root, tsRel);
  const rbAbs = pathmod.join(root, rbRel);
  fsmod.mkdirSync(pathmod.dirname(tsAbs), { recursive: true });
  fsmod.writeFileSync(tsAbs, "export const x: number = 1;\n", "utf-8");
  fsmod.writeFileSync(rbAbs, "x = 1\n", "utf-8");

  try {
    const tsRes = mockRes();
    await fileReadHandler(mockReq(`/__dev/api/file?path=${encodeURIComponent(tsRel)}`), tsRes);
    assert("file read returns content", typeof tsRes.result?.content === "string");
    assert("file read keeps path/bytes", typeof tsRes.result?.path === "string" && typeof tsRes.result?.bytes === "number");
    assert(".ts yields language typescript", tsRes.result?.language === "typescript", `got ${tsRes.result?.language}`);

    const rbRes = mockRes();
    await fileReadHandler(mockReq(`/__dev/api/file?path=${encodeURIComponent(rbRel)}`), rbRes);
    assert(".rb yields language ruby", rbRes.result?.language === "ruby", `got ${rbRes.result?.language}`);
  } finally {
    try { fsmod.unlinkSync(tsAbs); } catch { /* ignore */ }
    try { fsmod.unlinkSync(rbAbs); } catch { /* ignore */ }
  }
}

// Also exercise the helper directly across the full canonical map coverage,
// including the no-extension Dockerfile detection and the .env / .env.example
// two-part cases.
import { devAdminLanguage } from "../packages/core/src/index.ts";

assert("helper: .ts → typescript", devAdminLanguage("src/routes/get.ts") === "typescript");
assert("helper: .rb → ruby", devAdminLanguage("lib/foo.rb") === "ruby");
assert("helper: .py → python", devAdminLanguage("app.py") === "python");
assert("helper: .tsx → typescript", devAdminLanguage("App.tsx") === "typescript");
assert("helper: .jsx → javascript", devAdminLanguage("App.jsx") === "javascript");
assert("helper: .twig → html", devAdminLanguage("page.twig") === "html");
assert("helper: .xml → html", devAdminLanguage("pom.xml") === "html");
assert("helper: .scss → css", devAdminLanguage("a.scss") === "css");
assert("helper: .yml → yaml", devAdminLanguage("ci.yml") === "yaml");
assert("helper: .gemspec → ruby", devAdminLanguage("foo.gemspec") === "ruby");
assert("helper: .svg → svg", devAdminLanguage("logo.svg") === "svg");
assert("helper: .env → env", devAdminLanguage(".env") === "env");
assert("helper: .env.example → env", devAdminLanguage("config/.env.example") === "env");
assert("helper: Dockerfile → dockerfile", devAdminLanguage("Dockerfile") === "dockerfile");
assert("helper: Dockerfile.dev → dockerfile", devAdminLanguage("Dockerfile.dev") === "dockerfile");
assert("helper: Dockerfile.prod → dockerfile", devAdminLanguage("ops/Dockerfile.prod") === "dockerfile");
assert("helper: unknown ext → text", devAdminLanguage("weird.qzx") === "text");
assert("helper: no extension → text", devAdminLanguage("LICENSE") === "text");

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
