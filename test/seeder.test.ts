/**
 * Unit tests for the database seeder (seeder.ts).
 * Run with: npx tsx test/seeder.test.ts
 */
import { seedTable, seedOrm, FakeData } from "../packages/orm/src/index.ts";
import type { DatabaseAdapter, FieldDefinition } from "../packages/orm/src/index.ts";

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

// Mock database adapter
function createMockDb(): DatabaseAdapter & { _inserts: Array<{ sql: string; params: unknown[] }> } {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  return {
    _inserts: inserts,
    execute(sql: string, params?: unknown[]) {
      inserts.push({ sql, params: params ?? [] });
      return { lastInsertRowid: inserts.length };
    },
    query() { return []; },
    fetch() { return []; },
    fetchOne() { return null; },
    insert() { return { success: true, rowsAffected: 1 }; },
    update() { return { success: true, rowsAffected: 0 }; },
    delete() { return { success: true, rowsAffected: 0 }; },
    startTransaction() {},
    commit() {},
    rollback() {},
    tables() { return []; },
    columns() { return []; },
    lastInsertId() { return null; },
    close() {},
    tableExists() { return true; },
    createTable() {},
  };
}

console.log("=== Seeder Tests ===\n");

// --- Exports ---
console.log("--- Exports ---");
assert("seedTable is a function", typeof seedTable === "function");
assert("seedOrm is a function", typeof seedOrm === "function");
assert("FakeData is a constructor", typeof FakeData === "function");

// --- seedTable basic ---
console.log("\n--- seedTable Basic ---");

const db1 = createMockDb();
const fake = new FakeData(42);
const count = await seedTable(db1, "users", 5, {
  name: () => fake.name(),
  email: () => fake.email(),
});
assert("seedTable returns inserted count", count === 5);
assert("Database received 5 INSERT statements", db1._inserts.length === 5);
assert("INSERT targets correct table", db1._inserts[0].sql.includes('"users"'));
assert("INSERT has correct columns", db1._inserts[0].sql.includes('"name"') && db1._inserts[0].sql.includes('"email"'));
assert("INSERT has placeholders", db1._inserts[0].sql.includes("?"));
assert("INSERT params have 2 values", db1._inserts[0].params.length === 2);

// --- seedTable with static values ---
console.log("\n--- seedTable Static Values ---");

const db2 = createMockDb();
const count2 = await seedTable(db2, "items", 3, {
  name: () => "dynamic",
  category: "static-value",
});
assert("Static values accepted in fieldMap", count2 === 3);
assert("Params include static value", db2._inserts[0].params.includes("static-value"));

// --- seedTable with overrides ---
console.log("\n--- seedTable Overrides ---");

const db3 = createMockDb();
const count3 = await seedTable(db3, "users", 2, {
  name: () => "generated",
  role: () => "generated-role",
}, { role: "admin" });
assert("Overrides applied", count3 === 2);
assert("Override value in params", db3._inserts[0].params.includes("admin"));

// --- seedTable with no fieldMap ---
console.log("\n--- seedTable Empty ---");

const db4 = createMockDb();
const count4 = await seedTable(db4, "empty", 10);
assert("No fieldMap returns 0", count4 === 0);
assert("No inserts executed", db4._inserts.length === 0);

const db5 = createMockDb();
const count5 = await seedTable(db5, "empty", 10, {});
assert("Empty fieldMap returns 0", count5 === 0);

// --- seedTable default count ---
console.log("\n--- seedTable Default Count ---");

const db6 = createMockDb();
const count6 = await seedTable(db6, "defaults", undefined, {
  col: () => "val",
});
assert("Default count is 10", count6 === 10);
assert("10 inserts executed", db6._inserts.length === 10);

// --- seedOrm ---
console.log("\n--- seedOrm ---");

const db7 = createMockDb();
const mockModel = {
  tableName: "products",
  fields: {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true },
    price: { type: "number" as const },
    active: { type: "boolean" as const },
    description: { type: "text" as const },
    created_at: { type: "datetime" as const },
  },
  getDb: () => db7,
};

const ormCount = await seedOrm(mockModel, 5);
assert("seedOrm returns count", ormCount === 5);
assert("seedOrm executed 5 inserts", db7._inserts.length === 5);
assert("seedOrm skips auto-increment PK", !db7._inserts[0].sql.includes('"id"'));
assert("seedOrm includes name field", db7._inserts[0].sql.includes('"name"'));
assert("seedOrm includes price field", db7._inserts[0].sql.includes('"price"'));

// --- seedOrm with overrides ---
console.log("\n--- seedOrm Overrides ---");

const db8 = createMockDb();
const mockModel2 = {
  tableName: "users",
  fields: {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const },
    role: { type: "string" as const },
  },
  getDb: () => db8,
};

const ormCount2 = await seedOrm(mockModel2, 3, { role: "admin" });
assert("seedOrm with override returns count", ormCount2 === 3);
assert("Override field excluded from generated", !db8._inserts[0].sql.includes('"role"') || db8._inserts[0].params.includes("admin"));

// --- seedOrm deterministic seed ---
console.log("\n--- seedOrm Deterministic ---");

const db9 = createMockDb();
const db10 = createMockDb();
const seedModel = {
  tableName: "items",
  fields: {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const },
  },
  getDb: () => db9,
};
const seedModel2 = { ...seedModel, getDb: () => db10 };

await seedOrm(seedModel, 3, undefined, 42);
await seedOrm(seedModel2, 3, undefined, 42);
assert("Same seed produces same data", JSON.stringify(db9._inserts[0].params) === JSON.stringify(db10._inserts[0].params));

// --- FakeData basic ---
console.log("\n--- FakeData ---");

const fd = new FakeData(123);
assert("FakeData.name() returns string", typeof fd.name() === "string");
assert("FakeData.email() returns string with @", fd.email().includes("@"));
assert("FakeData.uuid() returns string with dashes", fd.uuid().includes("-"));
assert("FakeData.boolean() returns boolean", typeof fd.boolean() === "boolean");
assert("FakeData.integer() returns number", typeof fd.integer(1, 100) === "number");

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
