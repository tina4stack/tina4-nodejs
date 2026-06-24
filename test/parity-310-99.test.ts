/**
 * Parity tests for features added/changed in 3.10.99.
 * Run with: npx tsx test/parity-310-99.test.ts
 */
import { rmSync, mkdirSync } from "node:fs";
import {
  initDatabase,
  closeDatabase,
  BaseModel,
  syncModels,
} from "../packages/orm/src/index.ts";
import type { FieldDefinition, DiscoveredModel } from "../packages/orm/src/index.ts";
import { Frond } from "../packages/frond/src/index.ts";
import { ServiceRunner } from "../packages/core/src/service.ts";

const TEST_DB = "/tmp/tina4-parity-310-99/test.db";
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

// Clean slate
try { rmSync("/tmp/tina4-parity-310-99", { recursive: true }); } catch {}
mkdirSync("/tmp/tina4-parity-310-99", { recursive: true });

console.log("=== Parity 3.10.99 Tests ===\n");

// Initialize database
await initDatabase({ type: "sqlite", path: TEST_DB });

// --- Define a model with snake_case DB columns via camelCase fields ---

class UserProfile extends BaseModel {
  static tableName = "user_profiles";
  static fields: Record<string, FieldDefinition> = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    firstName: { type: "string", required: true },
    lastName: { type: "string", required: true },
    emailAddress: { type: "string", required: true },
  };
}

const userProfileModel: DiscoveredModel = {
  definition: {
    tableName: "user_profiles",
    fields: UserProfile.fields,
  },
  filePath: "test",
  modelClass: UserProfile,
};

syncModels([userProfileModel]);

// Insert a record
const profile = new UserProfile({
  first_name: "Alice",
  last_name: "Smith",
  email_address: "alice@example.com",
});
profile.save();

// ── toDict case 'camel' (default) ────────────────────────────────
console.log("--- toDict case 'camel' (default) ---");

{
  const dict = profile.toDict();
  assert("toDict default returns camelCase keys", "firstName" in dict && "lastName" in dict && "emailAddress" in dict);
  assert("toDict default does NOT have snake_case keys", !("first_name" in dict) && !("last_name" in dict));
  assert("toDict default values are correct", dict.firstName === "Alice" && dict.lastName === "Smith");
}

// ── toDict case 'snake' ──────────────────────────────────────────
console.log("\n--- toDict case 'snake' ---");

{
  const dict = profile.toDict(undefined, "snake");
  assert("toDict snake returns snake_case keys", "first_name" in dict && "last_name" in dict && "email_address" in dict);
  assert("toDict snake does NOT have camelCase keys (firstName)", !("firstName" in dict) || dict["firstName"] === undefined);
  assert("toDict snake values are correct", dict.first_name === "Alice" && dict.last_name === "Smith");
}

// ── autoMap defaults to true ─────────────────────────────────────
console.log("\n--- autoMap defaults to true ---");

{
  class Fresh extends BaseModel {
    static tableName = "fresh_models";
    static fields: Record<string, FieldDefinition> = {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      someField: { type: "string" },
    };
  }
  assert("autoMap defaults to true on BaseModel subclass", Fresh.autoMap === true);
}

// ── Frond replace filter with object arg ─────────────────────────
console.log("\n--- Frond replace filter with object arg ---");

{
  const engine = new Frond("/tmp/tina4-parity-310-99");
  // The replace filter accepts an object map for multi-replacement.
  // Test the filter function directly since inline object literals in
  // template filter args are not yet supported by the parser.
  const filters = (engine as any).filters as Record<string, Function>;
  const replaceFn = filters["replace"];
  const result = replaceFn("2024-01-15T10:30:00", { "T": " ", "-": "/" });
  assert("replace with object arg transforms datetime string", result === "2024/01/15 10:30:00");
}

// ── Frond replace filter with positional args ────────────────────
console.log("\n--- Frond replace filter with positional args ---");

{
  const engine = new Frond("/tmp/tina4-parity-310-99");
  const result = engine.renderString(
    '{{ val|replace("hello", "world") }}',
    { val: "say hello" },
  );
  assert("replace with positional args substitutes correctly", result === "say world");
}

// ── ServiceRunner registration ───────────────────────────────────
console.log("\n--- ServiceRunner registration ---");

{
  ServiceRunner.clear();
  let executed = false;
  let seenContextName: string | null = null;
  // interval 0.01s == 10ms; the interval timer fires several times within 50ms.
  ServiceRunner.register("test-task", async (ctx) => {
    executed = true;
    seenContextName = ctx.name;
  }, { interval: 0.01 });

  const services = ServiceRunner.list();
  assert("ServiceRunner registers a task", services.length === 1);
  assert("Registered task has correct name", services[0].name === "test-task");

  // Drive the real lifecycle: before start the task is NOT running, the handler
  // has NOT fired, and lastRun is null.
  assert(
    "Registered task is not running before start",
    ServiceRunner.isRunning("test-task") === false && services[0].running === false,
  );
  assert("Handler has not fired before start", executed === false);
  assert("lastRun is null before start", services[0].lastRun === null);

  // Start the interval service and let it tick.
  ServiceRunner.start("test-task");
  assert("isRunning flips to true after start", ServiceRunner.isRunning("test-task") === true);

  await new Promise((r) => setTimeout(r, 50));
  ServiceRunner.stop("test-task");

  // The registered handler actually ran (real side effect), received the live
  // ServiceContext, and the runner stamped lastRun with a real Date.
  assert("Registered handler actually fired after start", executed === true);
  assert("Handler received the live ServiceContext (name)", seenContextName === "test-task");
  const afterRun = ServiceRunner.list();
  assert("lastRun is a real Date after the handler ran", afterRun[0].lastRun instanceof Date);

  // After stop, isRunning flips back to false (lifecycle teardown).
  assert("isRunning flips back to false after stop", ServiceRunner.isRunning("test-task") === false);

  ServiceRunner.clear();
  const afterClear = ServiceRunner.list();
  assert("ServiceRunner clear removes all tasks", afterClear.length === 0);
}

// Cleanup
closeDatabase();
try { rmSync("/tmp/tina4-parity-310-99", { recursive: true }); } catch {}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
