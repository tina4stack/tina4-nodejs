/**
 * Unit tests for the database seeder (seeder.ts).
 * Run with: npx tsx test/seeder.test.ts
 */
import { seedTable, seedOrm, FakeData, createAdapterFromUrl } from "../packages/orm/src/index.ts";
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

// --- Behavioural existence: seedTable / seedOrm / FakeData against a REAL SQLite DB ---
// These replace the old `typeof === "function"` smoke checks with real exercises:
// a real in-memory SQLite adapter (node:sqlite via createAdapterFromUrl) is created,
// rows are seeded, and the inserted rows are read back. No mocks.
console.log("--- Behavioural existence (real SQLite) ---");

const liveDb = await createAdapterFromUrl("sqlite:///:memory:");

// 1. seedTable really inserts into a real table and the rows read back.
liveDb.execute(
  `CREATE TABLE live_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`,
);
const liveTableSummary = await seedTable(liveDb, "live_users", 3, { name: () => "Ada" });
const liveTableRows = liveDb.fetch<{ id: number; name: string }>("SELECT * FROM live_users");
assert(
  "seedTable inserts rows into a real SQLite table",
  liveTableSummary.seeded === 3 && liveTableRows.length === 3 && liveTableRows[0].name === "Ada",
  `seeded=${liveTableSummary.seeded} rows=${liveTableRows.length}`,
);

// 2. seedOrm really seeds an ORM model, auto-increment PK is populated by the DB,
//    and the generated INSERT omits the auto-increment 'id' column.
liveDb.execute(
  `CREATE TABLE live_products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price REAL)`,
);
const liveOrmModel = {
  tableName: "live_products",
  fields: {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true },
    price: { type: "number" as const },
  },
  getDb: () => liveDb,
};
const liveOrmSummary = await seedOrm(liveOrmModel, 4, undefined, 99);
const liveOrmRows = liveDb.fetch<{ id: number; name: string; price: number }>(
  "SELECT * FROM live_products ORDER BY id",
);
assert(
  "seedOrm seeds a real ORM model with DB-assigned auto-increment PKs",
  liveOrmSummary.seeded === 4 &&
    liveOrmRows.length === 4 &&
    liveOrmRows[0].id === 1 &&
    liveOrmRows[3].id === 4 &&
    typeof liveOrmRows[0].name === "string",
  `seeded=${liveOrmSummary.seeded} rows=${liveOrmRows.length} firstId=${liveOrmRows[0]?.id}`,
);

// 3. FakeData is a real, deterministic generator: same seed → same value,
//    different seed → (in practice) different value.
const fdSeedA = new FakeData(42);
const fdSeedB = new FakeData(42);
const fdSeedC = new FakeData(43);
assert(
  "FakeData is deterministic per seed (42==42, 42!=43)",
  fdSeedA.name() === fdSeedB.name() && fdSeedA.name() !== fdSeedC.name(),
  `a=${new FakeData(42).name()} c=${new FakeData(43).name()}`,
);

// --- seedTable basic ---
console.log("\n--- seedTable Basic ---");

const db1 = createMockDb();
const fake = new FakeData(42);
const count = (await seedTable(db1, "users", 5, {
  name: () => fake.name(),
  email: () => fake.email(),
})).seeded;
assert("seedTable returns inserted count", count === 5);
assert("Database received 5 INSERT statements", db1._inserts.length === 5);
assert("INSERT targets correct table", db1._inserts[0].sql.includes('"users"'));
assert("INSERT has correct columns", db1._inserts[0].sql.includes('"name"') && db1._inserts[0].sql.includes('"email"'));
assert("INSERT has placeholders", db1._inserts[0].sql.includes("?"));
assert("INSERT params have 2 values", db1._inserts[0].params.length === 2);

// --- seedTable with static values ---
console.log("\n--- seedTable Static Values ---");

const db2 = createMockDb();
const count2 = (await seedTable(db2, "items", 3, {
  name: () => "dynamic",
  category: "static-value",
})).seeded;
assert("Static values accepted in fieldMap", count2 === 3);
assert("Params include static value", db2._inserts[0].params.includes("static-value"));

// --- seedTable with overrides ---
console.log("\n--- seedTable Overrides ---");

const db3 = createMockDb();
const count3 = (await seedTable(db3, "users", 2, {
  name: () => "generated",
  role: () => "generated-role",
}, { role: "admin" })).seeded;
assert("Overrides applied", count3 === 2);
assert("Override value in params", db3._inserts[0].params.includes("admin"));

// --- seedTable with no fieldMap ---
console.log("\n--- seedTable Empty ---");

const db4 = createMockDb();
const count4 = (await seedTable(db4, "empty", 10)).seeded;
assert("No fieldMap returns 0", count4 === 0);
assert("No inserts executed", db4._inserts.length === 0);

const db5 = createMockDb();
const count5 = (await seedTable(db5, "empty", 10, {})).seeded;
assert("Empty fieldMap returns 0", count5 === 0);

// --- seedTable default count ---
console.log("\n--- seedTable Default Count ---");

const db6 = createMockDb();
const count6 = (await seedTable(db6, "defaults", undefined, {
  col: () => "val",
})).seeded;
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

const ormCount = (await seedOrm(mockModel, 5)).seeded;
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

const ormCount2 = (await seedOrm(mockModel2, 3, { role: "admin" })).seeded;
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

// 4. name() — pinned deterministic output + reproducibility across instances.
//    With seed 123 the PRNG produces firstName "Penny" + lastName "Martinez".
assert(
  "FakeData.name() is deterministic and pins to the exact seeded output",
  new FakeData(123).name() === "Penny Martinez" &&
    new FakeData(123).name() === new FakeData(123).name(),
  `got=${new FakeData(123).name()}`,
);

// 5. email() — structured shape (first.last@domain) + reproducibility.
const fdEmail = new FakeData(123).email();
assert(
  "FakeData.email() matches first.last@domain and reproduces per seed",
  /^[a-z]+\.[a-z]+@[a-z.]+$/.test(fdEmail) &&
    fdEmail === new FakeData(123).email(),
  `got=${fdEmail}`,
);

// 6. uuid() — real UUID format; two consecutive calls on the same instance differ
//    (the PRNG advances).
const fdUuidInstance = new FakeData(123);
const uuid1 = fdUuidInstance.uuid();
const uuid2 = fdUuidInstance.uuid();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
assert(
  "FakeData.uuid() matches UUID hex format and advances per call",
  uuidPattern.test(uuid1) && uuidPattern.test(uuid2) && uuid1 !== uuid2,
  `uuid1=${uuid1} uuid2=${uuid2}`,
);

// 7. boolean() — distribution (both values occur) + deterministic sequence per seed.
const fdBoolA = new FakeData(123);
const boolSeqA: boolean[] = [];
for (let i = 0; i < 100; i++) boolSeqA.push(fdBoolA.boolean());
const fdBoolB = new FakeData(123);
const boolSeqB: boolean[] = [];
for (let i = 0; i < 100; i++) boolSeqB.push(fdBoolB.boolean());
assert(
  "FakeData.boolean() yields both values and is reproducible per seed",
  boolSeqA.includes(true) &&
    boolSeqA.includes(false) &&
    JSON.stringify(boolSeqA) === JSON.stringify(boolSeqB),
  `true=${boolSeqA.filter((b) => b).length} false=${boolSeqA.filter((b) => !b).length}`,
);

// 8. integer(1, 100) — within bounds (an integer in [1, 100]) + deterministic per seed.
//    Note: FakeData.integer(min, max) is INCLUSIVE of max (randInt(min, max+1)),
//    so the real bound is 1..100 inclusive — assert against actual behaviour.
const intVal = new FakeData(123).integer(1, 100);
assert(
  "FakeData.integer(1,100) is an in-bounds integer and reproducible per seed",
  Number.isInteger(intVal) &&
    intVal >= 1 &&
    intVal <= 100 &&
    intVal === new FakeData(123).integer(1, 100),
  `got=${intVal}`,
);

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
