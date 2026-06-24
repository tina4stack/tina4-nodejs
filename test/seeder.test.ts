/**
 * Unit tests for the database seeder (seeder.ts).
 * Run with: npx tsx test/seeder.test.ts
 */
import { seedTable, seedOrm, FakeData, createAdapterFromUrl } from "../packages/orm/src/index.ts";

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

liveDb.execute(
  `CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL)`,
);
const fake = new FakeData(42);
const count = (await seedTable(liveDb, "users", 5, {
  name: () => fake.name(),
  email: () => fake.email(),
})).seeded;
const usersRows = liveDb.fetch<{ id: number; name: string; email: string }>("SELECT * FROM users ORDER BY id");
assert("seedTable returns inserted count", count === 5);
assert("Real table received 5 rows", usersRows.length === 5);
assert("Seeded rows have a non-empty name", typeof usersRows[0].name === "string" && usersRows[0].name.length > 0);
assert("Seeded rows have a structured email", usersRows[0].email.includes("@"));
assert("Auto-increment PK assigned 1..5", usersRows[0].id === 1 && usersRows[4].id === 5);

// --- seedTable with static values ---
console.log("\n--- seedTable Static Values ---");

liveDb.execute(
  `CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, category TEXT)`,
);
const count2 = (await seedTable(liveDb, "items", 3, {
  name: () => "dynamic",
  category: "static-value",
})).seeded;
const itemsRows = liveDb.fetch<{ name: string; category: string }>("SELECT * FROM items");
assert("Static values accepted in fieldMap", count2 === 3);
assert("Real rows store the static value verbatim", itemsRows.length === 3 && itemsRows.every((r) => r.category === "static-value"));
assert("Real rows store the dynamic value", itemsRows[0].name === "dynamic");

// --- seedTable with overrides ---
console.log("\n--- seedTable Overrides ---");

liveDb.execute(
  `CREATE TABLE users_override (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, role TEXT)`,
);
const count3 = (await seedTable(liveDb, "users_override", 2, {
  name: () => "generated",
  role: () => "generated-role",
}, { role: "admin" })).seeded;
const overrideRows = liveDb.fetch<{ name: string; role: string }>("SELECT * FROM users_override");
assert("Overrides applied", count3 === 2);
assert("Override value wins in the real row (role=admin, not generated-role)", overrideRows.length === 2 && overrideRows.every((r) => r.role === "admin"));
assert("Non-overridden field keeps its generated value", overrideRows[0].name === "generated");

// --- seedTable with no fieldMap ---
console.log("\n--- seedTable Empty ---");

liveDb.execute(
  `CREATE TABLE empty_tbl (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`,
);
const count4 = (await seedTable(liveDb, "empty_tbl", 10)).seeded;
const emptyAfterNoMap = liveDb.fetchOne<{ c: number }>("SELECT COUNT(*) AS c FROM empty_tbl");
assert("No fieldMap returns 0", count4 === 0);
assert("No rows written to the real table when fieldMap is absent", emptyAfterNoMap?.c === 0);

const count5 = (await seedTable(liveDb, "empty_tbl", 10, {})).seeded;
const emptyAfterEmptyMap = liveDb.fetchOne<{ c: number }>("SELECT COUNT(*) AS c FROM empty_tbl");
assert("Empty fieldMap returns 0", count5 === 0);
assert("No rows written to the real table when fieldMap is empty", emptyAfterEmptyMap?.c === 0);

// --- seedTable default count ---
console.log("\n--- seedTable Default Count ---");

liveDb.execute(
  `CREATE TABLE defaults_tbl (id INTEGER PRIMARY KEY AUTOINCREMENT, col TEXT)`,
);
const count6 = (await seedTable(liveDb, "defaults_tbl", undefined, {
  col: () => "val",
})).seeded;
const defaultsCount = liveDb.fetchOne<{ c: number }>("SELECT COUNT(*) AS c FROM defaults_tbl");
assert("Default count is 10", count6 === 10);
assert("10 rows actually landed in the real table", defaultsCount?.c === 10);

// --- seedOrm ---
console.log("\n--- seedOrm ---");

// Every field type round-trips through the REAL node:sqlite driver, INCLUDING a
// boolean column: forField() emits a JS boolean, and the SQLite adapter's
// toSqlParams() now coerces it to 0/1 at the bind boundary (node:sqlite refuses
// to bind a raw boolean otherwise). This locks in the boolean-coercion fix.
liveDb.execute(
  `CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price REAL, description TEXT, active INTEGER, created_at TEXT)`,
);
const ormModel = {
  tableName: "products",
  fields: {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true },
    price: { type: "number" as const },
    description: { type: "text" as const },
    active: { type: "boolean" as const },
    created_at: { type: "datetime" as const },
  },
  getDb: () => liveDb,
};

const ormCount = (await seedOrm(ormModel, 5)).seeded;
const productRows = liveDb.fetch<{ id: number; name: string; price: number; description: string; active: number; created_at: string }>(
  "SELECT * FROM products ORDER BY id",
);
assert("seedOrm returns count", ormCount === 5);
assert("seedOrm wrote 5 real rows", productRows.length === 5);
assert("seedOrm let the DB assign the auto-increment PK (1..5)", productRows[0].id === 1 && productRows[4].id === 5);
assert("seedOrm populated the required name field", typeof productRows[0].name === "string" && productRows[0].name.length > 0);
assert("seedOrm populated the price field with a number", typeof productRows[0].price === "number");
assert("seedOrm populated the text description column", typeof productRows[0].description === "string" && productRows[0].description.length > 0);
assert("seedOrm coerced the boolean column to 0/1 on the real driver", productRows.every((r) => r.active === 0 || r.active === 1));
assert("seedOrm populated the datetime column with an ISO timestamp", /^\d{4}-\d{2}-\d{2}T/.test(productRows[0].created_at));

// --- seedOrm with overrides ---
console.log("\n--- seedOrm Overrides ---");

liveDb.execute(
  `CREATE TABLE orm_override_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, role TEXT)`,
);
const ormOverrideModel = {
  tableName: "orm_override_users",
  fields: {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const },
    role: { type: "string" as const },
  },
  getDb: () => liveDb,
};

const ormCount2 = (await seedOrm(ormOverrideModel, 3, { role: "admin" })).seeded;
const ormOverrideRows = liveDb.fetch<{ name: string; role: string }>("SELECT * FROM orm_override_users");
assert("seedOrm with override returns count", ormCount2 === 3);
assert("Override field lands as the literal value in every real row", ormOverrideRows.length === 3 && ormOverrideRows.every((r) => r.role === "admin"));

// --- seedOrm deterministic seed ---
console.log("\n--- seedOrm Deterministic ---");

liveDb.execute(
  `CREATE TABLE seed_items_a (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`,
);
liveDb.execute(
  `CREATE TABLE seed_items_b (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`,
);
const seedModelA = {
  tableName: "seed_items_a",
  fields: {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const },
  },
  getDb: () => liveDb,
};
const seedModelB = { ...seedModelA, tableName: "seed_items_b" };

await seedOrm(seedModelA, 3, undefined, 42);
await seedOrm(seedModelB, 3, undefined, 42);
const namesA = liveDb.fetch<{ name: string }>("SELECT name FROM seed_items_a ORDER BY id").map((r) => r.name);
const namesB = liveDb.fetch<{ name: string }>("SELECT name FROM seed_items_b ORDER BY id").map((r) => r.name);
assert(
  "Same seed produces identical real rows in two independent tables",
  namesA.length === 3 && JSON.stringify(namesA) === JSON.stringify(namesB),
  `a=${JSON.stringify(namesA)} b=${JSON.stringify(namesB)}`,
);

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
