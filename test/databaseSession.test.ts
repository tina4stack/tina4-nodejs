/**
 * Unit tests for DatabaseSessionHandler class.
 * Run with: npx tsx test/databaseSession.test.ts
 *
 * Tests class structure, interface, and basic read/write/destroy via
 * an in-memory-style SQLite database (temp file). Uses Node's built-in
 * node:sqlite (DatabaseSync) — no third-party driver, always available.
 */
import {
  DatabaseSessionHandler,
} from "../packages/core/src/index.ts";
import type { SessionHandler } from "../packages/core/src/session.ts";
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

// node:sqlite is built into Node (20+), so the backing store is always
// available — there is no "driver not installed" skip. A constructor error
// here is a real failure and must surface loudly rather than be swallowed.
const handler: InstanceType<typeof DatabaseSessionHandler> = new DatabaseSessionHandler({ dbPath: TEST_DB });
// Behavioural: a constructed handler is never null in JS, so prove the
// constructor actually opened/created the backing SQLite store and the
// table by exercising a real write/read round-trip through it.
const bootId = "boot-" + Date.now();
handler.write(bootId, { _created: Date.now(), _accessed: Date.now(), user: "x" }, 60);
const boot = handler.read(bootId);
assert(
  "DatabaseSessionHandler constructor opens a usable backing store (write/read round-trip)",
  boot !== null && (boot as any).user === "x",
  `expected user "x", got ${JSON.stringify(boot)}`,
);
handler.destroy(bootId);

// --- Required methods (proven by behaviour, not typeof) ---
console.log("\n--- Required Methods ---");

// read: prove it returns the exact data a prior write stored.
const readBehaveId = "read-behave-" + Date.now();
handler.write(readBehaveId, { _created: Date.now(), _accessed: Date.now(), k: "v" }, 60);
const readBehave = handler.read(readBehaveId);
assert(
  "read returns the value a prior write stored",
  readBehave !== null && (readBehave as any).k === "v",
  `expected k="v", got ${JSON.stringify(readBehave)}`,
);
handler.destroy(readBehaveId);

// write: prove it PERSISTS to the DB FILE — open a SECOND handler on the same
// dbPath and assert it can read the value the first handler wrote.
const writePersistId = "write-persist-" + Date.now();
handler.write(writePersistId, { _created: Date.now(), _accessed: Date.now(), n: 1 }, 60);
const handler2 = new DatabaseSessionHandler({ dbPath: TEST_DB });
const persisted = handler2.read(writePersistId);
assert(
  "write persists to the DB file (a second handler on the same dbPath reads it back)",
  persisted !== null && (persisted as any).n === 1,
  `expected n=1 via second handler, got ${JSON.stringify(persisted)}`,
);
handler.destroy(writePersistId);

// destroy: prove the side effect — written session is readable, then gone after destroy.
const destroyBehaveId = "destroy-behave-" + Date.now();
handler.write(destroyBehaveId, { _created: Date.now(), _accessed: Date.now(), x: 1 }, 60);
const beforeDestroy = handler.read(destroyBehaveId);
handler.destroy(destroyBehaveId);
const afterDestroy = handler.read(destroyBehaveId);
assert(
  "destroy removes a previously-written session (read non-null before, null after)",
  beforeDestroy !== null && afterDestroy === null,
  `before=${JSON.stringify(beforeDestroy)} after=${JSON.stringify(afterDestroy)}`,
);

// --- Interface parity with SessionHandler ---
console.log("\n--- Interface Parity ---");

// Prove parity by BEHAVIOUR, not by reflecting on method names: drive a full
// session lifecycle through a variable typed as the SessionHandler interface
// (write -> read -> destroy -> read===null). If any interface method were
// missing or non-conforming, this would not compile / would not round-trip.
const iface: SessionHandler = handler;
const parityId = "iface-parity-" + Date.now();
iface.write(parityId, { _created: Date.now(), _accessed: Date.now(), claim: "ok" }, 60);
const parityRead = iface.read(parityId);
iface.destroy(parityId);
const parityGone = iface.read(parityId);
assert(
  "SessionHandler interface lifecycle works via the interface type (write/read/destroy)",
  parityRead !== null && (parityRead as any).claim === "ok" && parityGone === null,
  `read=${JSON.stringify(parityRead)} afterDestroy=${JSON.stringify(parityGone)}`,
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
