/**
 * Unit tests for the FakeData module (core + ORM seeder).
 * Run with: npx tsx test/fakeData.test.ts
 */
import { FakeData as CoreFakeData } from "../packages/core/src/index.ts";
import { FakeData } from "../packages/orm/src/fakeData.ts";
import { seedTable } from "../packages/orm/src/seeder.ts";
import type { FieldDefinition, DatabaseAdapter } from "../packages/orm/src/types.ts";

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

console.log("=== FakeData Tests ===\n");

const fake = new FakeData();

// --- Name generation ---
console.log("--- Name Generation ---");

const first = fake.firstName();
assert("firstName returns a non-empty string",
  typeof first === "string" && first.length > 0);

const last = fake.lastName();
assert("lastName returns a non-empty string",
  typeof last === "string" && last.length > 0);

const full = fake.fullName();
assert("fullName returns first and last name",
  typeof full === "string" && full.includes(" ") && full.split(" ").length === 2);

// --- Contact generation ---
console.log("\n--- Contact Generation ---");

const email = fake.email();
assert("email contains @ and domain",
  email.includes("@") && email.includes("."));

const phone = fake.phone();
assert("phone has expected format",
  phone.startsWith("+1 (") && phone.includes(")"));

const addr = fake.address();
assert("address contains street and city",
  typeof addr === "string" && addr.includes(","));

// --- Location ---
console.log("\n--- Location ---");

const city = fake.city();
assert("city returns a non-empty string", city.length > 0);

const country = fake.country();
assert("country returns a non-empty string", country.length > 0);

const zip = fake.zipCode();
assert("zipCode is 5 digits", /^\d{5}$/.test(zip));

// --- Company/Job ---
console.log("\n--- Company & Job ---");

const company = fake.company();
assert("company returns a name with suffix",
  typeof company === "string" && company.includes(" "));

const job = fake.jobTitle();
assert("jobTitle returns a non-empty string", job.length > 0);

// --- Text generation ---
console.log("\n--- Text Generation ---");

const word = fake.word();
assert("word returns a single word", typeof word === "string" && !word.includes(" "));

const sentence = fake.sentence();
assert("sentence ends with period and is capitalized",
  sentence.endsWith(".") && sentence[0] === sentence[0].toUpperCase());

const para = fake.paragraph(3);
assert("paragraph has multiple sentences",
  para.split(".").length >= 3);

// --- Numeric ---
console.log("\n--- Numeric ---");

const int = fake.integer(10, 20);
assert("integer is within range",
  int >= 10 && int <= 20);

const flt = fake.float(1, 5, 2);
assert("float is within range and has decimals",
  flt >= 1 && flt <= 5);

const bool = fake.boolean();
assert("boolean returns true or false",
  typeof bool === "boolean");

// --- Date ---
console.log("\n--- Date ---");

const date = fake.date("2023-01-01", "2023-12-31");
assert("date is in YYYY-MM-DD format and within range",
  /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= "2023-01-01" && date <= "2023-12-31");

// --- Identifiers ---
console.log("\n--- Identifiers ---");

const uuid = fake.uuid();
assert("uuid matches UUID format",
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid));

const url = fake.url();
assert("url starts with https://",
  url.startsWith("https://") && url.includes("/"));

const ip = fake.ipAddress();
assert("ipAddress has 4 octets",
  ip.split(".").length === 4 && ip.split(".").every((o) => Number(o) >= 0 && Number(o) <= 255));

// --- Colors ---
console.log("\n--- Colors ---");

const color = fake.color();
assert("color returns a color name", color.length > 0);

const hex = fake.hexColor();
assert("hexColor matches #RRGGBB format",
  /^#[0-9a-f]{6}$/.test(hex));

// --- Financial ---
console.log("\n--- Financial ---");

const cc = fake.creditCard();
assert("creditCard returns a known test number",
  cc.length >= 14 && /^\d+$/.test(cc));

const curr = fake.currency();
assert("currency returns a 3-letter code",
  /^[A-Z]{3}$/.test(curr));

// --- run() ---
console.log("\n--- Run Method ---");

const rows = fake.run(() => ({
  name: fake.fullName(),
  email: fake.email(),
}), 5);
assert("run() generates correct number of records",
  rows.length === 5);
assert("run() records have expected fields",
  typeof rows[0].name === "string" && typeof rows[0].email === "string");

// --- runSeeds() with missing directory ---
console.log("\n--- RunSeeds Method ---");

const seedResult = await fake.runSeeds("/tmp/nonexistent-seed-dir-xyz");
assert("runSeeds() with missing dir returns empty array",
  Array.isArray(seedResult) && seedResult.length === 0);

// --- Seeded deterministic output ---
console.log("\n--- Seeded PRNG ---");

const seeded1 = new FakeData(42);
const seeded2 = new FakeData(42);
const name1 = seeded1.fullName();
const name2 = seeded2.fullName();
assert("new FakeData(42) produces deterministic fullName",
  name1 === name2, `got "${name1}" vs "${name2}"`);

const email1 = new FakeData(99).email();
const email2 = new FakeData(99).email();
assert("new FakeData(99) produces deterministic email",
  email1 === email2, `got "${email1}" vs "${email2}"`);

const int1 = new FakeData(7).integer(1, 100);
const int2 = new FakeData(7).integer(1, 100);
assert("new FakeData(7) produces deterministic integer",
  int1 === int2, `got ${int1} vs ${int2}`);

// --- ORM FakeData extensions ---
console.log("\n--- ORM FakeData Extensions ---");

const ormFake = new FakeData();

const nameResult = ormFake.name();
assert("name() returns a full name with space",
  typeof nameResult === "string" && nameResult.includes(" "));

const numericResult = ormFake.numeric(1, 100, 3);
assert("numeric() returns a number within range",
  numericResult >= 1 && numericResult <= 100);

const dtResult = ormFake.datetime(2022, 2024);
assert("datetime() returns a Date object within range",
  dtResult instanceof Date && dtResult.getFullYear() >= 2022 && dtResult.getFullYear() <= 2024);

// --- forField() ---
console.log("\n--- forField() Method ---");

const emailFieldDef: FieldDefinition = { type: "string" };
const emailVal = ormFake.forField(emailFieldDef, "email");
assert("forField with 'email' column generates an email",
  typeof emailVal === "string" && (emailVal as string).includes("@"));

const phoneFieldDef: FieldDefinition = { type: "string" };
const phoneVal = ormFake.forField(phoneFieldDef, "phone");
assert("forField with 'phone' column generates a phone number",
  typeof phoneVal === "string" && (phoneVal as string).startsWith("+1"));

const intFieldDef: FieldDefinition = { type: "integer", min: 5, max: 50 };
const intVal = ormFake.forField(intFieldDef, "age") as number;
assert("forField with integer type respects min/max",
  typeof intVal === "number" && intVal >= 5 && intVal <= 50);

const boolFieldDef: FieldDefinition = { type: "boolean" };
const boolVal = ormFake.forField(boolFieldDef, "active");
assert("forField with boolean type returns boolean",
  typeof boolVal === "boolean");

const dtFieldDef: FieldDefinition = { type: "datetime" };
const dtFieldVal = ormFake.forField(dtFieldDef, "created_at");
assert("forField with datetime type returns ISO string",
  typeof dtFieldVal === "string" && /^\d{4}-\d{2}-\d{2}T/.test(dtFieldVal as string));

const autoIncPk: FieldDefinition = { type: "integer", primaryKey: true, autoIncrement: true };
const pkVal = ormFake.forField(autoIncPk, "id");
assert("forField skips auto-increment primary keys (returns undefined)",
  pkVal === undefined);

const textFieldDef: FieldDefinition = { type: "text" };
const textVal = ormFake.forField(textFieldDef, "description");
assert("forField with text type returns a paragraph",
  typeof textVal === "string" && (textVal as string).length > 20);

const numberFieldDef: FieldDefinition = { type: "number", min: 0, max: 100 };
const numVal = ormFake.forField(numberFieldDef, "price") as number;
assert("forField with number type returns a float in range",
  typeof numVal === "number" && numVal >= 0 && numVal <= 100);

// --- ORM FakeData deterministic ---
console.log("\n--- ORM FakeData Deterministic ---");

const ormSeeded1 = new FakeData(123);
const ormSeeded2 = new FakeData(123);
assert("ORM FakeData(123) produces deterministic name()",
  ormSeeded1.name() === ormSeeded2.name());

assert("ORM FakeData inherits from CoreFakeData",
  ormFake instanceof CoreFakeData);

// --- seedTable() ---
console.log("\n--- seedTable() ---");

// Create a mock database adapter
const insertedRows: Array<{ sql: string; params: unknown[] }> = [];
const mockDb: DatabaseAdapter = {
  execute(sql: string, params?: unknown[]): unknown {
    insertedRows.push({ sql, params: params ?? [] });
    return { lastInsertRowid: insertedRows.length };
  },
  query<T>(_sql: string, _params?: unknown[]): T[] {
    return [] as T[];
  },
  close(): void {},
  tableExists(_name: string): boolean {
    return true;
  },
  createTable(): void {},
};

const seedFake = new FakeData(42);
const seedCount = await seedTable(mockDb, "test_users", 5, {
  name: () => seedFake.name(),
  email: () => seedFake.email(),
  age: () => seedFake.integer(18, 65),
});

assert("seedTable returns correct count",
  seedCount === 5);

assert("seedTable inserted correct number of rows",
  insertedRows.length === 5);

assert("seedTable SQL targets correct table",
  insertedRows[0].sql.includes('"test_users"'));

assert("seedTable SQL has correct columns",
  insertedRows[0].sql.includes('"name"') && insertedRows[0].sql.includes('"email"') && insertedRows[0].sql.includes('"age"'));

// Test with overrides
insertedRows.length = 0;
const seedCountWithOverrides = await seedTable(mockDb, "test_users", 3, {
  name: () => seedFake.name(),
  role: () => "user",
}, { status: "active" });

assert("seedTable with overrides returns correct count",
  seedCountWithOverrides === 3);

assert("seedTable override values are inserted (3 columns: name, role, status)",
  insertedRows[0].params.length === 3);

// Test empty fieldMap
const emptyResult = await seedTable(mockDb, "test_users", 10);
assert("seedTable with no fieldMap returns 0",
  emptyResult === 0);

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
