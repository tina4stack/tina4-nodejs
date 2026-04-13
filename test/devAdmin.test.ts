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

  const res = mockRes();
  await statusHandler(mockReq("/__dev/api/status"), res);
  const data = res.result;

  assert("handleStatus returns an object", typeof data === "object" && data !== null);
  assert("handleStatus has framework field", typeof data.framework === "string" && data.framework.includes("tina4-nodejs"));
  assert("handleStatus has routes field (number)", typeof data.routes === "number");
  assert("handleStatus has messages field", data.messages !== undefined);
  assert("handleStatus has requests field", data.requests !== undefined);
  assert("handleStatus has memory field", typeof data.memory === "object");
  assert("handleStatus has uptime field", typeof data.uptime === "number");
  assert("handleStatus has timestamp field", typeof data.timestamp === "string");
  assert("handleStatus has nodeVersion field", typeof data.nodeVersion === "string");
  assert("handleStatus has debug field", typeof data.debug === "string");
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
  const res = mockRes();
  await systemHandler(mockReq("/__dev/api/system"), res);
  const data = res.result;

  assert("handleSystem returns an object", typeof data === "object" && data !== null);
  assert("handleSystem has node_version field", typeof data.node_version === "string");
  assert("handleSystem has platform field", typeof data.platform === "string");
  assert("handleSystem has architecture field", typeof data.architecture === "string");
  assert("handleSystem has pid field", typeof data.pid === "number");
  assert("handleSystem has memory_mb field", typeof data.memory_mb === "number");
  assert("handleSystem has memory object", typeof data.memory === "object");
  assert("handleSystem memory has current_mb", typeof data.memory.current_mb === "number");
  assert("handleSystem has framework object", typeof data.framework === "object");
  assert("handleSystem framework has name", data.framework.name === "tina4-nodejs");
  assert("handleSystem has uptime object", typeof data.uptime === "object");
  assert("handleSystem uptime has seconds", typeof data.uptime.seconds === "number");
  assert("handleSystem has cpus field", typeof data.cpus === "number");
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
  assert("handleQueue stats has pending field", typeof data.stats.pending === "number");
  assert("handleQueue stats has completed field", typeof data.stats.completed === "number");
  assert("handleQueue stats has failed field", typeof data.stats.failed === "number");
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

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
