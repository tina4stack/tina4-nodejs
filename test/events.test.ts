/**
 * Unit tests for the Events module (observer pattern).
 * Run with: npx tsx test/events.test.ts
 */
import { Events } from "../packages/core/src/index.ts";

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

console.log("=== Events Tests ===\n");

// Clean up any leftover state
Events.clear();

// --- on() registers listener ---
console.log("--- on() ---");

let called = false;
const testHandler = () => { called = true; };
Events.on("test.event", testHandler);

assert("on() retains the exact registered callback identity", Events.listeners("test.event")[0] === testHandler);
assert("listener registered", Events.listeners("test.event").length === 1);

// --- emit() calls listeners ---
console.log("\n--- emit() ---");

Events.emit("test.event");
assert("emit calls registered listener", called === true);

// Reset
called = false;
Events.clear();

// --- emit() passes arguments ---
console.log("\n--- emit() with args ---");

let receivedArgs: unknown[] = [];
Events.on("data.event", (...args: unknown[]) => { receivedArgs = args; });
Events.emit("data.event", "hello", 42, { key: "value" });

assert("emit passes first arg", receivedArgs[0] === "hello");
assert("emit passes second arg", receivedArgs[1] === 42);
assert("emit passes third arg", (receivedArgs[2] as any).key === "value");

Events.clear();

// --- emit() returns results ---
console.log("\n--- emit() return values ---");

Events.on("calc", (a: unknown, b: unknown) => (a as number) + (b as number));
Events.on("calc", (a: unknown, b: unknown) => (a as number) * (b as number));

const results = Events.emit("calc", 3, 4);
assert("emit returns array of results", Array.isArray(results));
assert("emit returns results from all listeners", results.length === 2);
assert("first result is sum", results[0] === 7);
assert("second result is product", results[1] === 12);

Events.clear();

// --- emit() on unregistered event ---
console.log("\n--- emit() no listeners ---");

const emptyResults = Events.emit("unregistered.event");
assert("emit on unregistered event returns empty array", emptyResults.length === 0);

// --- once() fires only once ---
console.log("\n--- once() ---");

let onceCount = 0;
Events.once("one.time", () => { onceCount++; });

Events.emit("one.time");
Events.emit("one.time");
Events.emit("one.time");

assert("once listener fires only once", onceCount === 1);
assert("once listener removed after first fire", Events.listeners("one.time").length === 0);

Events.clear();

// --- off() removes specific listener ---
console.log("\n--- off() specific listener ---");

let countA = 0;
let countB = 0;
const handlerA = () => { countA++; };
const handlerB = () => { countB++; };

Events.on("remove.test", handlerA);
Events.on("remove.test", handlerB);

assert("two listeners registered", Events.listeners("remove.test").length === 2);

Events.off("remove.test", handlerA);
assert("one listener after off()", Events.listeners("remove.test").length === 1);

Events.emit("remove.test");
assert("removed handler not called", countA === 0);
assert("remaining handler called", countB === 1);

Events.clear();

// --- off() removes all listeners for event ---
console.log("\n--- off() all listeners ---");

Events.on("all.remove", () => {});
Events.on("all.remove", () => {});
Events.on("other.event", () => {});

Events.off("all.remove");
assert("off(event) removes all listeners for event", Events.listeners("all.remove").length === 0);
assert("off(event) does not affect other events", Events.listeners("other.event").length === 1);

Events.clear();

// --- Priority ordering ---
console.log("\n--- Priority ordering ---");

const order: number[] = [];
Events.on("priority.test", () => { order.push(1); }, 1);
Events.on("priority.test", () => { order.push(3); }, 3);
Events.on("priority.test", () => { order.push(2); }, 2);

Events.emit("priority.test");
assert("highest priority fires first", order[0] === 3);
assert("second priority fires second", order[1] === 2);
assert("lowest priority fires last", order[2] === 1);

Events.clear();

// --- Default priority is 0 ---
console.log("\n--- Default priority ---");

const defOrder: string[] = [];
Events.on("def.priority", () => { defOrder.push("high"); }, 10);
Events.on("def.priority", () => { defOrder.push("default"); });
Events.on("def.priority", () => { defOrder.push("low"); }, -5);

Events.emit("def.priority");
assert("high priority first", defOrder[0] === "high");
assert("default priority second", defOrder[1] === "default");
assert("negative priority last", defOrder[2] === "low");

Events.clear();

// --- listeners() ---
console.log("\n--- listeners() ---");

const fn1 = () => {};
const fn2 = () => {};
Events.on("list.test", fn1);
Events.on("list.test", fn2);

const listeners = Events.listeners("list.test");
assert("listeners returns array of callbacks", listeners.length === 2);
assert("listeners includes fn1", listeners.includes(fn1));
assert("listeners includes fn2", listeners.includes(fn2));

const emptyListeners = Events.listeners("nonexistent");
assert("listeners returns empty array for unknown event", emptyListeners.length === 0);

Events.clear();

// --- events() ---
console.log("\n--- events() ---");

Events.on("alpha", () => {});
Events.on("beta", () => {});
Events.on("gamma", () => {});

const eventNames = Events.events();
assert("events returns all event names", eventNames.length === 3);
assert("events includes alpha", eventNames.includes("alpha"));
assert("events includes beta", eventNames.includes("beta"));
assert("events includes gamma", eventNames.includes("gamma"));

// --- clear() ---
console.log("\n--- clear() ---");

Events.clear();
assert("clear removes all events", Events.events().length === 0);

// --- once() with priority ---
console.log("\n--- once() with priority ---");

const oncePriOrder: string[] = [];
Events.on("once.pri", () => { oncePriOrder.push("normal"); }, 0);
Events.once("once.pri", () => { oncePriOrder.push("once-high"); }, 10);

Events.emit("once.pri");
assert("once with higher priority fires first", oncePriOrder[0] === "once-high");
assert("normal listener fires second", oncePriOrder[1] === "normal");

Events.emit("once.pri");
// Second emit only calls the normal listener
assert("once listener not called on second emit (total calls = 3)", oncePriOrder.length === 3);

Events.clear();

// --- Multiple events independent ---
console.log("\n--- Multiple events ---");

let aCount = 0, bCount = 0;
Events.on("a", () => { aCount++; });
Events.on("b", () => { bCount++; });

Events.emit("a");
Events.emit("a");
Events.emit("b");

assert("event a fired twice", aCount === 2);
assert("event b fired once", bCount === 1);

Events.clear();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
