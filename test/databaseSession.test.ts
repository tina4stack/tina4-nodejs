/**
 * Unit tests for DatabaseSessionHandler class.
 * Run with: npx tsx test/databaseSession.test.ts
 *
 * Tests class structure, interface, and basic read/write/destroy via
 * an in-memory-style SQLite database (temp file). Requires better-sqlite3.
 */
import {
  DatabaseSessionHandler,
} from "../packages/core/src/index.ts";
import { join } from "node:path";
import { rmSync, mkdirSync } from "node:fs";

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

console.log("=== Database Session Handler Tests ===\n");

const TEST_DIR = join("/tmp", "tina4-dbsess-test-" + Date.now());
mkdirSync(TEST_DIR, { recursive: true });
const TEST_DB = join(TEST_DIR, "sessions.db");

// --- Constructor ---
console.log("--- Constructor ---");

let handler: InstanceType<typeof DatabaseSessionHandler>;
try {
  handler = new DatabaseSessionHandler({ dbPath: TEST_DB });
  assert("DatabaseSessionHandler constructor works", handler !== null);
} catch (err: any) {
  // If better-sqlite3 is not installed, skip gracefully
  if (err.message && err.message.includes("better-sqlite3")) {
    console.log("  SKIP — better-sqlite3 not installed");
    console.log(`\n${"=".repeat(50)}`);
    console.log(`  Results: \x1b[32m0 passed\x1b[0m, \x1b[31m0 failed\x1b[0m`);
    console.log(`${"=".repeat(50)}\n`);
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
    process.exit(0);
  }
  throw err;
}

// --- Required methods ---
console.log("\n--- Required Methods ---");

assert("DatabaseSessionHandler has read method", typeof handler.read === "function");
assert("DatabaseSessionHandler has write method", typeof handler.write === "function");
assert("DatabaseSessionHandler has destroy method", typeof handler.destroy === "function");

// --- Interface parity with SessionHandler ---
console.log("\n--- Interface Parity ---");

const requiredMethods = ["read", "write", "destroy"];
assert(
  "DatabaseSessionHandler has all SessionHandler methods",
  requiredMethods.every((m) => typeof (handler as any)[m] === "function"),
);

// --- Read non-existent session ---
console.log("\n--- Read / Write / Destroy ---");

const readMissing = handler.read("nonexistent-session-id");
assert("read returns null for non-existent session", readMissing === null);

// --- Write and read back ---
const sessionId = "test-session-" + Date.now();
const sessionData = { _created: Date.now(), _accessed: Date.now(), user: "alice", role: "admin" };

handler.write(sessionId, sessionData, 3600);
const readBack = handler.read(sessionId);
assert("write then read returns data", readBack !== null);
assert("read data has correct user", readBack !== null && (readBack as any).user === "alice");
assert("read data has correct role", readBack !== null && (readBack as any).role === "admin");

// --- Update existing session ---
const updatedData = { _created: Date.now(), _accessed: Date.now(), user: "alice", role: "superadmin" };
handler.write(sessionId, updatedData, 3600);
const readUpdated = handler.read(sessionId);
assert("update then read returns updated data", readUpdated !== null && (readUpdated as any).role === "superadmin");

// --- Destroy session ---
handler.destroy(sessionId);
const readAfterDestroy = handler.read(sessionId);
assert("destroy removes session", readAfterDestroy === null);

// --- TTL behaviour ---
console.log("\n--- TTL behaviour ---");

// TTL <= 0 defaults to 3600 seconds, so the session should still be readable
const ttlId = "ttl-session-" + Date.now();
const ttlData = { _created: Date.now(), _accessed: Date.now(), temp: true };
handler.write(ttlId, ttlData, 0); // TTL of 0 defaults to 3600
const readTtl = handler.read(ttlId);
assert("write with TTL 0 uses default TTL (session readable)", readTtl !== null);

// Positive TTL should keep session alive
const positiveTtlId = "pos-ttl-" + Date.now();
handler.write(positiveTtlId, ttlData, 60);
const readPosTtl = handler.read(positiveTtlId);
assert("write with positive TTL keeps session alive", readPosTtl !== null);

// --- Multiple sessions ---
console.log("\n--- Multiple Sessions ---");

const id1 = "multi-1-" + Date.now();
const id2 = "multi-2-" + Date.now();

handler.write(id1, { _created: Date.now(), _accessed: Date.now(), name: "session1" }, 3600);
handler.write(id2, { _created: Date.now(), _accessed: Date.now(), name: "session2" }, 3600);

const read1 = handler.read(id1);
const read2 = handler.read(id2);
assert("multiple sessions are independent (session 1)", read1 !== null && (read1 as any).name === "session1");
assert("multiple sessions are independent (session 2)", read2 !== null && (read2 as any).name === "session2");

// Destroy one, other persists
handler.destroy(id1);
const read1After = handler.read(id1);
const read2After = handler.read(id2);
assert("destroying one session does not affect another", read1After === null && read2After !== null);

// Cleanup
try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
