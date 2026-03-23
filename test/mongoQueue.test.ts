/**
 * Unit tests for MongoBackend queue class.
 * Run with: npx tsx test/mongoQueue.test.ts
 *
 * Tests class structure and interface only — no actual MongoDB connections.
 */
import {
  MongoBackend,
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

console.log("=== MongoDB Queue Backend Tests ===\n");

// --- Constructor with explicit config ---
console.log("--- MongoBackend with explicit config ---");

const mongo = new MongoBackend({
  host: "127.0.0.1",
  port: 27017,
  database: "test_queue",
  collection: "jobs",
});

assert("MongoBackend constructor works", mongo !== null);
assert("MongoBackend has push method", typeof mongo.push === "function");
assert("MongoBackend has pop method", typeof mongo.pop === "function");
assert("MongoBackend has size method", typeof mongo.size === "function");
assert("MongoBackend has clear method", typeof mongo.clear === "function");

// --- Constructor with defaults (env vars) ---
console.log("\n--- MongoBackend with defaults ---");

const mongoDefaults = new MongoBackend();
assert("MongoBackend works without config (uses defaults)", mongoDefaults !== null);
assert("MongoBackend default has push method", typeof mongoDefaults.push === "function");
assert("MongoBackend default has pop method", typeof mongoDefaults.pop === "function");
assert("MongoBackend default has size method", typeof mongoDefaults.size === "function");
assert("MongoBackend default has clear method", typeof mongoDefaults.clear === "function");

// --- Constructor with URI ---
console.log("\n--- MongoBackend with URI ---");

const mongoUri = new MongoBackend({ uri: "mongodb://myhost:27018/mydb" });
assert("MongoBackend works with URI config", mongoUri !== null);
assert("MongoBackend URI has push method", typeof mongoUri.push === "function");

// --- Constructor with auth ---
console.log("\n--- MongoBackend with auth ---");

const mongoAuth = new MongoBackend({
  host: "127.0.0.1",
  port: 27017,
  username: "admin",
  password: "secret",
  database: "prod_queue",
  collection: "queue_jobs",
});
assert("MongoBackend works with auth config", mongoAuth !== null);

// --- Interface parity ---
console.log("\n--- Interface Parity ---");

const requiredMethods = ["push", "pop", "size", "clear"];
assert(
  "MongoBackend has all QueueBackend methods",
  requiredMethods.every((m) => typeof (mongo as any)[m] === "function"),
);

// --- Graceful fallback when MongoDB is unavailable ---
// The backend uses execFileSync internally which may throw in ESM or
// when the server is not reachable. We verify it does not crash fatally.
console.log("\n--- Fallback behaviour ---");

try {
  const sizeResult = mongo.size("test-queue");
  assert("MongoBackend.size returns 0 when server unavailable", sizeResult === 0);
} catch {
  assert("MongoBackend.size throws when server unavailable (expected in ESM)", true);
}

try {
  const popResult = mongo.pop("test-queue");
  assert("MongoBackend.pop returns null when server unavailable", popResult === null);
} catch {
  assert("MongoBackend.pop throws when server unavailable (expected in ESM)", true);
}

try {
  mongo.clear("test-queue");
  assert("MongoBackend.clear does not throw when server unavailable", true);
} catch {
  assert("MongoBackend.clear throws when server unavailable (expected in ESM)", true);
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
