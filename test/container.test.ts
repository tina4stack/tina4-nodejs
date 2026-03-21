/**
 * Unit tests for the DI Container.
 * Run with: npx tsx test/container.test.ts
 */
import { Container, container } from "../packages/core/src/index.ts";

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

console.log("=== DI Container Tests ===\n");

// --- Constructor ---
console.log("--- Basic Construction ---");

const c = new Container();
assert("New container has no registrations", !c.has("anything"));

// --- Default Instance ---
console.log("\n--- Default Instance ---");

assert("Default container export exists", container instanceof Container);
container.reset();

// --- Register (Transient) ---
console.log("\n--- Transient Registration ---");

let callCount = 0;
c.register("counter", () => {
  callCount++;
  return { count: callCount };
});

assert("has() returns true after register", c.has("counter"));

const a1 = c.get<{ count: number }>("counter");
const a2 = c.get<{ count: number }>("counter");

assert("Transient creates new instance each call", a1 !== a2);
assert("First call returns count 1", a1.count === 1);
assert("Second call returns count 2", a2.count === 2);

// --- Singleton ---
console.log("\n--- Singleton Registration ---");

let singletonCalls = 0;
c.singleton("config", () => {
  singletonCalls++;
  return { env: "test", callNum: singletonCalls };
});

assert("has() returns true for singleton", c.has("config"));

const s1 = c.get<{ env: string; callNum: number }>("config");
const s2 = c.get<{ env: string; callNum: number }>("config");

assert("Singleton returns same instance", s1 === s2);
assert("Factory called only once", singletonCalls === 1);
assert("Instance has correct value", s1.env === "test");

// --- get() throws for unregistered ---
console.log("\n--- Error Handling ---");

let threw = false;
try {
  c.get("nonexistent");
} catch (e) {
  threw = true;
  assert(
    "Error message includes service name",
    (e as Error).message.includes("nonexistent"),
  );
}
assert("get() throws for unregistered service", threw);

// --- register() rejects non-functions ---
let typeThrew = false;
try {
  c.register("bad", "not a function" as unknown as () => unknown);
} catch (e) {
  typeThrew = true;
  assert(
    "TypeError message mentions callable",
    (e as Error).message.includes("callable"),
  );
}
assert("register() throws TypeError for non-function", typeThrew);

// --- singleton() rejects non-functions ---
let singletonTypeThrew = false;
try {
  c.singleton("bad2", 42 as unknown as () => unknown);
} catch (e) {
  singletonTypeThrew = true;
}
assert("singleton() throws TypeError for non-function", singletonTypeThrew);

// --- has() returns false for unregistered ---
assert("has() returns false for unregistered", !c.has("missing"));

// --- Override: transient -> singleton ---
console.log("\n--- Override Behavior ---");

c.register("svc", () => ({ type: "transient" }));
assert("Registered as transient", c.has("svc"));
const t1 = c.get<{ type: string }>("svc");
assert("Returns transient instance", t1.type === "transient");

c.singleton("svc", () => ({ type: "singleton" }));
const t2 = c.get<{ type: string }>("svc");
const t3 = c.get<{ type: string }>("svc");
assert("Override to singleton works", t2.type === "singleton");
assert("Singleton returns same instance after override", t2 === t3);

// --- Override: singleton -> transient ---
c.register("svc", () => ({ type: "transient-again" }));
const t4 = c.get<{ type: string }>("svc");
const t5 = c.get<{ type: string }>("svc");
assert("Override back to transient works", t4.type === "transient-again");
assert("Transient creates new instances again", t4 !== t5);

// --- Reset ---
console.log("\n--- Reset ---");

c.register("a", () => 1);
c.singleton("b", () => 2);
assert("Before reset: has a", c.has("a"));
assert("Before reset: has b", c.has("b"));

c.reset();

assert("After reset: a gone", !c.has("a"));
assert("After reset: b gone", !c.has("b"));

// Verify get throws after reset
let postResetThrew = false;
try {
  c.get("a");
} catch {
  postResetThrew = true;
}
assert("get() throws after reset", postResetThrew);

// --- Singleton instance cleared on re-register ---
console.log("\n--- Singleton Re-registration ---");

let factoryCallsA = 0;
c.singleton("dbA", () => {
  factoryCallsA++;
  return { connection: factoryCallsA };
});

const db1 = c.get<{ connection: number }>("dbA");
assert("First singleton creation", db1.connection === 1);

// Re-register with a new factory
c.singleton("dbA", () => {
  factoryCallsA++;
  return { connection: factoryCallsA };
});

const db2 = c.get<{ connection: number }>("dbA");
assert("Re-registered singleton creates new instance", db2.connection === 2);
assert("Re-registered singleton is different object", db1 !== db2);

// --- Multiple independent containers ---
console.log("\n--- Multiple Containers ---");

const c1 = new Container();
const c2 = new Container();

c1.register("x", () => "from c1");
c2.register("x", () => "from c2");

assert("Container c1 returns its value", c1.get("x") === "from c1");
assert("Container c2 returns its value", c2.get("x") === "from c2");

c1.reset();
assert("c1 reset doesn't affect c2", c2.has("x"));
assert("c1 no longer has x", !c1.has("x"));

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
