/**
 * Unit tests for the ServiceRunner module.
 * Run with: npx tsx test/service.test.ts
 */
import {
  ServiceRunner,
  matchCronField,
  matchesCron,
} from "../packages/core/src/index.ts";
import type { ServiceContext } from "../packages/core/src/index.ts";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TEST_DIR = join("/tmp", "tina4-service-test-" + Date.now());

function cleanup() {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  ServiceRunner.clear();
}

// Clean up before tests
cleanup();

console.log("=== Service Runner Tests ===\n");

// ─── Cron field matching ─────────────────────────────────────────────────────

console.log("--- Cron field matching ---");

assert("wildcard * matches any value", matchCronField("*", 0));
assert("wildcard * matches 59", matchCronField("*", 59));

assert("step */5 matches 0", matchCronField("*/5", 0));
assert("step */5 matches 15", matchCronField("*/5", 15));
assert("step */5 does not match 3", !matchCronField("*/5", 3));

assert("exact value 30 matches 30", matchCronField("30", 30));
assert("exact value 30 does not match 31", !matchCronField("30", 31));

assert("list 1,15,30 matches 15", matchCronField("1,15,30", 15));
assert("list 1,15,30 does not match 10", !matchCronField("1,15,30", 10));

assert("range 1-5 matches 3", matchCronField("1-5", 3));
assert("range 1-5 matches 1 (lower bound)", matchCronField("1-5", 1));
assert("range 1-5 matches 5 (upper bound)", matchCronField("1-5", 5));
assert("range 1-5 does not match 6", !matchCronField("1-5", 6));

// ─── Cron expression matching ────────────────────────────────────────────────

console.log("\n--- Cron expression matching ---");

// "every minute" should match any date
const anyDate = new Date(2026, 2, 20, 10, 30, 0); // March 20, 2026 10:30:00
assert(
  "\"* * * * *\" matches any date",
  matchesCron("* * * * *", anyDate),
);

// Specific minute: minute=30
assert(
  "\"30 * * * *\" matches when minute is 30",
  matchesCron("30 * * * *", anyDate),
);
assert(
  "\"31 * * * *\" does not match when minute is 30",
  !matchesCron("31 * * * *", anyDate),
);

// Specific hour and minute
assert(
  "\"30 10 * * *\" matches 10:30",
  matchesCron("30 10 * * *", anyDate),
);
assert(
  "\"30 11 * * *\" does not match 10:30",
  !matchesCron("30 11 * * *", anyDate),
);

// Day of week: March 20, 2026 is a Friday (5)
assert(
  "\"* * * * 5\" matches Friday",
  matchesCron("* * * * 5", anyDate),
);
assert(
  "\"* * * * 1\" does not match Friday",
  !matchesCron("* * * * 1", anyDate),
);

// Invalid cron (wrong number of fields)
assert(
  "invalid cron (4 fields) returns false",
  !matchesCron("* * * *", anyDate),
);

// ─── Service registration ────────────────────────────────────────────────────

console.log("\n--- Service registration ---");

ServiceRunner.clear();

let handlerCalled = false;
ServiceRunner.register("test-svc", () => { handlerCalled = true; });

const list = ServiceRunner.list();
assert("registered service appears in list", list.length === 1);
assert("registered service has correct name", list[0].name === "test-svc");
assert("registered service is not running initially", !list[0].running);
assert("isRunning returns false before start", !ServiceRunner.isRunning("test-svc"));

// ─── Start / Stop lifecycle ──────────────────────────────────────────────────

console.log("\n--- Start / Stop lifecycle ---");

ServiceRunner.start("test-svc");
assert("isRunning returns true after start", ServiceRunner.isRunning("test-svc"));

// For a service with no timing/interval/daemon, it runs once immediately
await sleep(50);
assert("handler was called after start (no-timer service)", handlerCalled);

ServiceRunner.stop("test-svc");
assert("isRunning returns false after stop", !ServiceRunner.isRunning("test-svc"));

// ─── Context object ─────────────────────────────────────────────────────────

console.log("\n--- Context object ---");

ServiceRunner.clear();

let capturedContext: ServiceContext | null = null;
ServiceRunner.register("ctx-svc", (ctx) => {
  capturedContext = { ...ctx };
});
ServiceRunner.start("ctx-svc");
await sleep(50);

assert("context has name", capturedContext !== null && capturedContext.name === "ctx-svc");
assert("context has running=true during execution", capturedContext !== null && capturedContext.running === true);

ServiceRunner.stop("ctx-svc");

// ─── Interval-based execution ────────────────────────────────────────────────

console.log("\n--- Interval-based execution ---");

ServiceRunner.clear();

let intervalCount = 0;
ServiceRunner.register("interval-svc", () => {
  intervalCount++;
}, { interval: 0.1 }); // 100ms interval

ServiceRunner.start("interval-svc");
await sleep(350); // should fire ~3 times
ServiceRunner.stop("interval-svc");

assert(
  "interval service fires multiple times",
  intervalCount >= 2,
  `expected >= 2, got ${intervalCount}`,
);

// Ensure it stops firing after stop
const countAfterStop = intervalCount;
await sleep(200);
assert(
  "interval service stops firing after stop()",
  intervalCount === countAfterStop,
  `expected ${countAfterStop}, got ${intervalCount}`,
);

// ─── Last run tracking ───────────────────────────────────────────────────────

console.log("\n--- Last run tracking ---");

ServiceRunner.clear();

ServiceRunner.register("lastrun-svc", () => {}, { interval: 0.1 });
const infoBeforeStart = ServiceRunner.list().find((s) => s.name === "lastrun-svc");
assert("lastRun is null before start", infoBeforeStart?.lastRun === null);

ServiceRunner.start("lastrun-svc");
await sleep(150);
ServiceRunner.stop("lastrun-svc");

const infoAfterRun = ServiceRunner.list().find((s) => s.name === "lastrun-svc");
assert("lastRun is set after execution", infoAfterRun?.lastRun instanceof Date);

// ─── Remove ──────────────────────────────────────────────────────────────────

console.log("\n--- Remove ---");

ServiceRunner.clear();
ServiceRunner.register("removable", () => {});
assert("remove returns true for existing", ServiceRunner.remove("removable"));
assert("remove returns false for non-existing", !ServiceRunner.remove("nonexistent"));
assert("list is empty after remove", ServiceRunner.list().length === 0);

// ─── Multiple services ──────────────────────────────────────────────────────

console.log("\n--- Multiple services ---");

ServiceRunner.clear();
ServiceRunner.register("svc-a", () => {});
ServiceRunner.register("svc-b", () => {});
ServiceRunner.register("svc-c", () => {});

assert("three services registered", ServiceRunner.list().length === 3);

ServiceRunner.start(); // start all
assert("all three running", ServiceRunner.list().every((s) => s.running));

ServiceRunner.stop("svc-b"); // stop one
assert("svc-a still running", ServiceRunner.isRunning("svc-a"));
assert("svc-b stopped", !ServiceRunner.isRunning("svc-b"));
assert("svc-c still running", ServiceRunner.isRunning("svc-c"));

ServiceRunner.stop(); // stop all

// ─── Service discovery ───────────────────────────────────────────────────────

console.log("\n--- Service discovery ---");

ServiceRunner.clear();

mkdirSync(join(TEST_DIR, "services"), { recursive: true });
writeFileSync(
  join(TEST_DIR, "services", "ping.ts"),
  `
export default {
  name: "ping-service",
  interval: 60,
  handler: () => { /* ping */ },
};
`,
);
writeFileSync(
  join(TEST_DIR, "services", "cleanup.ts"),
  `
export default {
  name: "cleanup-service",
  timing: "0 2 * * *",
  handler: () => { /* cleanup */ },
};
`,
);
// Non-service file (no handler export)
writeFileSync(join(TEST_DIR, "services", "readme.txt"), "not a service");

const discovered = await ServiceRunner.discover(join(TEST_DIR, "services"));
assert(
  "discovered 2 services from directory",
  discovered.length === 2,
  `expected 2, got ${discovered.length}`,
);

const names = discovered.map((s) => s.name).sort();
assert(
  "discovered correct service names",
  names[0] === "cleanup-service" && names[1] === "ping-service",
  `got ${JSON.stringify(names)}`,
);

// Check they're registered
const allServices = ServiceRunner.list();
assert(
  "discovered services are registered",
  allServices.length === 2,
);

// ─── Discovery on missing directory ──────────────────────────────────────────

console.log("\n--- Discovery on missing directory ---");

ServiceRunner.clear();
const missing = await ServiceRunner.discover("/tmp/nonexistent-service-dir-" + Date.now());
assert("discover returns empty on missing dir", missing.length === 0);

// ─── Daemon mode ─────────────────────────────────────────────────────────────

console.log("\n--- Daemon mode ---");

ServiceRunner.clear();

let daemonRanOnce = false;
ServiceRunner.register("daemon-svc", async (ctx) => {
  daemonRanOnce = true;
  // A daemon handler typically loops while ctx.running
  while (ctx.running) {
    await sleep(50);
  }
}, { daemon: true });

ServiceRunner.start("daemon-svc");
await sleep(100);
assert("daemon handler was invoked", daemonRanOnce);
assert("daemon service is running", ServiceRunner.isRunning("daemon-svc"));

ServiceRunner.stop("daemon-svc");
await sleep(100);
assert("daemon service stopped via context.running", !ServiceRunner.isRunning("daemon-svc"));

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("\n=== Results ===");
console.log(`  ${pass} passed, ${fail} failed, ${pass + fail} total\n`);

// Cleanup
cleanup();

process.exit(fail > 0 ? 1 : 0);
