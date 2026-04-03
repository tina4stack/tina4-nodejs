/**
 * Unit tests for Session module (file backend, flash data, TTL).
 * Run with: npx tsx test/session.test.ts
 */
import { Session } from "../packages/core/src/session.ts";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
  }
}

const TEST_PATH = "/tmp/tina4-session-test";

// Clean slate
try { rmSync(TEST_PATH, { recursive: true }); } catch { /* ignore */ }

console.log("=== Session Tests ===\n");

// ── Start and ID generation ──────────────────────────────────────

console.log("-- Start & ID --");

const s1 = new Session("file", { path: TEST_PATH });
const id1 = s1.start();
assert("start() returns a string", typeof id1 === "string");
assert("Session ID is 32 hex chars", /^[0-9a-f]{32}$/.test(id1));
assert("getId() matches", s1.getSessionId() === id1);

// ── Set / Get / Has / Delete ─────────────────────────────────────

console.log("\n-- Set/Get/Has/Delete --");

s1.set("name", "Alice");
assert("get returns set value", s1.get("name") === "Alice");

s1.set("count", 42);
assert("get returns number value", s1.get("count") === 42);

assert("has returns true for existing key", s1.has("name") === true);
assert("has returns false for missing key", s1.has("nope") === false);

assert("get with default for missing key", s1.get("missing", "fallback") === "fallback");

s1.delete("count");
assert("delete removes key", s1.has("count") === false);
assert("get after delete returns default", s1.get("count", 0) === 0);

// ── All (public keys only) ───────────────────────────────────────

console.log("\n-- All --");

s1.set("color", "blue");
const allData = s1.all();
assert("all() includes public keys", allData.name === "Alice" && allData.color === "blue");
assert("all() excludes internal _created", !("_created" in allData));
assert("all() excludes internal _accessed", !("_accessed" in allData));

// ── Session Destroy ──────────────────────────────────────────────

console.log("\n-- Destroy --");

const s2 = new Session("file", { path: TEST_PATH });
const id2 = s2.start();
s2.set("key", "value");
const filePath2 = join(TEST_PATH, `${id2}.json`);
assert("Session file exists before destroy", existsSync(filePath2));

s2.destroy();
assert("Session file removed after destroy", !existsSync(filePath2));
assert("getId() is null after destroy", s2.getSessionId() === null);
assert("get returns default after destroy", s2.get("key", "gone") === "gone");

// ── Session Regenerate ───────────────────────────────────────────

console.log("\n-- Regenerate --");

const s3 = new Session("file", { path: TEST_PATH });
const id3 = s3.start();
s3.set("keep", "this");
const oldFile = join(TEST_PATH, `${id3}.json`);

const id3new = s3.regenerate();
assert("regenerate returns new ID", id3new !== id3);
assert("New ID is 32 hex chars", /^[0-9a-f]{32}$/.test(id3new));
assert("Old file removed", !existsSync(oldFile));
assert("Data preserved after regenerate", s3.get("keep") === "this");
assert("New file exists", existsSync(join(TEST_PATH, `${id3new}.json`)));

// ── Flash Data ───────────────────────────────────────────────────

console.log("\n-- Flash Data --");

const s4 = new Session("file", { path: TEST_PATH });
s4.start();
s4.flash("message", "Hello!");

assert("getFlash returns flash value", s4.getFlash("message") === "Hello!");
assert("getFlash auto-deletes (second read is default)", s4.getFlash("message", "gone") === "gone");
assert("getFlash missing key returns default", s4.getFlash("nope", "def") === "def");

// ── File Backend Persistence ─────────────────────────────────────

console.log("\n-- File Persistence --");

const s5 = new Session("file", { path: TEST_PATH });
const id5 = s5.start();
s5.set("persistent", "data");

// Create a new Session instance and resume the same ID
const s5b = new Session("file", { path: TEST_PATH });
const resumedId = s5b.start(id5);
assert("Resume returns same ID", resumedId === id5);
assert("Resumed session has persisted data", s5b.get("persistent") === "data");

// Verify actual file content (wrapped in {_data, _expires})
const rawFile = readFileSync(join(TEST_PATH, `${id5}.json`), "utf-8");
const parsed = JSON.parse(rawFile);
assert("File contains data as JSON", (parsed._data ?? parsed).persistent === "data");

// ── TTL Expiration ───────────────────────────────────────────────

console.log("\n-- TTL Expiration --");

const s6 = new Session("file", { path: TEST_PATH, ttl: 1 });
const id6 = s6.start();
s6.set("temp", "value");

// Manually backdate the _expires timestamp to simulate expiration
const filePath6 = join(TEST_PATH, `${id6}.json`);
const data6 = JSON.parse(readFileSync(filePath6, "utf-8"));
data6._expires = Math.floor(Date.now() / 1000) - 10; // expired 10 seconds ago
const { writeFileSync: wfs } = await import("node:fs");
wfs(filePath6, JSON.stringify(data6), "utf-8");

// Try to resume — should fail due to TTL
const s6b = new Session("file", { path: TEST_PATH, ttl: 1 });
const id6b = s6b.start(id6);
assert("Expired session gets new ID", id6b !== id6);
assert("Expired session data is gone", s6b.get("temp", "gone") === "gone");

// ── Cleanup ──────────────────────────────────────────────────────

try { rmSync(TEST_PATH, { recursive: true }); } catch { /* ignore */ }

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
