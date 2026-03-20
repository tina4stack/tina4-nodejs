/**
 * Unit tests for DevAdmin utility classes (MessageLog, RequestInspector, ErrorTracker).
 * Run with: npx tsx test/devAdmin.test.ts
 */
import {
  MessageLog, RequestInspector, ErrorTracker,
} from "../packages/core/src/index.ts";

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
(ErrorTracker as any).errors = [];

ErrorTracker.track("Something went wrong", "Error\n  at main.ts:10");
ErrorTracker.track("Database connection failed");
ErrorTracker.track("Timeout exceeded", "Error\n  at db.ts:42");

const errors = ErrorTracker.get();
assert("get() returns tracked errors", errors.length === 3);
assert("errors are in reverse order", errors[0].message === "Timeout exceeded");
assert("error has id", typeof errors[0].id === "string");
assert("error has timestamp", typeof errors[0].timestamp === "string");
assert("error has message", errors[0].message === "Timeout exceeded");
assert("error has stack when provided", typeof errors[0].stack === "string");
assert("error has resolved=false", errors[0].resolved === false);
assert("error without stack has undefined stack", errors[1].stack === undefined);

// --- ErrorTracker resolve ---
console.log("\n--- ErrorTracker resolve ---");

const errId = errors[0].id;
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
assert("clearResolved removes resolved errors", afterClearResolved.length === 2);
assert("unresolved errors remain", afterClearResolved.every((e) => e.resolved === false));

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
