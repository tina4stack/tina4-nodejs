/**
 * Unit tests for Session Handler classes (MongoDB and Valkey).
 * Run with: npx tsx test/sessionHandlers.test.ts
 *
 * Tests class structure and interface only — no actual MongoDB/Valkey connections.
 */
import {
  MongoSessionHandler, ValkeySessionHandler,
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

console.log("=== Session Handlers Tests ===\n");

// --- MongoDB Handler ---
console.log("--- MongoDB Session Handler ---");

const mongo = new MongoSessionHandler({
  host: "127.0.0.1",
  port: 27017,
  database: "test_sessions",
  collection: "sessions",
});

assert("MongoSessionHandler constructor works", mongo !== null);
assert("MongoSessionHandler has read method", typeof mongo.read === "function");
assert("MongoSessionHandler has write method", typeof mongo.write === "function");
assert("MongoSessionHandler has destroy method", typeof mongo.destroy === "function");

// With defaults
const mongoDefaults = new MongoSessionHandler();
assert("MongoSessionHandler works without config", mongoDefaults !== null);
assert("MongoSessionHandler default has read method", typeof mongoDefaults.read === "function");

// With URI
const mongoUri = new MongoSessionHandler({ uri: "mongodb://myhost:27018/mydb" });
assert("MongoSessionHandler works with URI config", mongoUri !== null);

// Backend-failure policy: an UNREACHABLE server is a transport FAILURE — the
// handler must SURFACE it (throw) so the Session boundary can log-loud + degrade,
// rather than swallowing it into a null (which is indistinguishable from a
// genuine "no session yet" miss). Mirrors the all-backend policy in session.ts.
let mongoThrew = false;
try {
  mongo.read("nonexistent-session");
} catch {
  mongoThrew = true;
}
assert("MongoSessionHandler.read THROWS when server unreachable (transport failure surfaced)", mongoThrew);

// --- Valkey Handler ---
console.log("\n--- Valkey Session Handler ---");

const valkey = new ValkeySessionHandler({
  host: "127.0.0.1",
  port: 6379,
  prefix: "test:session:",
  db: 0,
});

assert("ValkeySessionHandler constructor works", valkey !== null);
assert("ValkeySessionHandler has read method", typeof valkey.read === "function");
assert("ValkeySessionHandler has write method", typeof valkey.write === "function");
assert("ValkeySessionHandler has destroy method", typeof valkey.destroy === "function");

// With defaults
const valkeyDefaults = new ValkeySessionHandler();
assert("ValkeySessionHandler works without config", valkeyDefaults !== null);
assert("ValkeySessionHandler default has read method", typeof valkeyDefaults.read === "function");

// With password
const valkeyWithAuth = new ValkeySessionHandler({
  host: "127.0.0.1",
  port: 6379,
  password: "secret",
  prefix: "app:sess:",
  db: 2,
});
assert("ValkeySessionHandler works with password config", valkeyWithAuth !== null);

// Backend-failure policy: an unreachable Valkey is a transport FAILURE — the
// handler must SURFACE it (throw), same contract as the Mongo handler above.
let valkeyThrew = false;
try {
  valkey.read("nonexistent-session");
} catch {
  valkeyThrew = true;
}
assert("ValkeySessionHandler.read THROWS when server unreachable (transport failure surfaced)", valkeyThrew);

// --- Interface Parity ---
console.log("\n--- Interface Parity ---");

// Both handlers implement the same SessionHandler interface
const mongoMethods = ["read", "write", "destroy"];
const valkeyMethods = ["read", "write", "destroy"];

assert(
  "MongoDB handler has all SessionHandler methods",
  mongoMethods.every((m) => typeof (mongo as any)[m] === "function"),
);

assert(
  "Valkey handler has all SessionHandler methods",
  valkeyMethods.every((m) => typeof (valkey as any)[m] === "function"),
);

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
