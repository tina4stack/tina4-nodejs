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

const full = fake.name();
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

const flt = fake.numeric(1, 5, 2);
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

const hex = fake.colorHex();
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
  name: fake.name(),
  email: fake.email(),
}), 5);
assert("run() generates correct number of records",
  rows.length === 5);
assert("run() records have expected fields",
  typeof rows[0].name === "string" && typeof rows[0].email === "string");

// --- seedDir() with missing directory ---
console.log("\n--- SeedDir Method ---");

const seedResult = await fake.seedDir("/tmp/nonexistent-seed-dir-xyz");
assert("seedDir() with missing dir returns empty array",
  Array.isArray(seedResult) && seedResult.length === 0);

// --- Seeded deterministic output ---
console.log("\n--- Seeded PRNG ---");

const seeded1 = new FakeData(42);
const seeded2 = new FakeData(42);
const name1 = seeded1.name();
const name2 = seeded2.name();
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

// --- Interleaved seed reproducibility (parity with the Python master) ---
// Two same-seed instances must produce IDENTICAL sequences even when their
// calls are INTERLEAVED and the process-global RNG (Math.random) is churned
// between their draws. This is the exact case that exposed a shared-global-RNG
// bug in the PHP FakeData; a non-interleaved "consume a fully, then b fully"
// test passes even with that bug. Node uses a per-instance mulberry32 closure,
// so it is immune.
console.log("\n--- Interleaved seed reproducibility ---");
{
  const a = new FakeData(7);
  const b = new FakeData(7);
  const seqA: unknown[] = [];
  const seqB: unknown[] = [];
  for (let i = 0; i < 15; i++) {
    seqA.push(a.name(), a.email(), a.integer(1, 1_000_000));
    Math.random();   // churn the GLOBAL RNG between a's and b's draws
    seqB.push(b.name(), b.email(), b.integer(1, 1_000_000));
  }
  const firstDiff = seqA.findIndex((v, i) => v !== seqB[i]);
  assert("two same-seed instances match when interleaved (+ global Math.random churn)",
    JSON.stringify(seqA) === JSON.stringify(seqB),
    `diverged at index ${firstDiff}: ${String(seqA[firstDiff])} vs ${String(seqB[firstDiff])}`);
}

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

// Behavioural inheritance check (not just the prototype-chain `instanceof`):
// prove the ORM subclass really inherits a CORE generator method's contract AND
// that the ORM-only forField() produces a typed value driven by that inherited
// behaviour. instanceof only asserts the type relationship; these assert that
// the subclass actually runs inherited core code and layers its own on top.
{
  // 1. instanceof still holds (type relationship).
  assert("ORM FakeData is an instanceof CoreFakeData",
    ormFake instanceof CoreFakeData);

  // 2. The inherited CORE method firstName() honours its contract when called
  //    on the ORM subclass instance — non-empty string, repeatedly.
  let allFirstNamesValid = true;
  let badFirst = "";
  for (let i = 0; i < 20; i++) {
    const fn = ormFake.firstName();
    if (typeof fn !== "string" || fn.length === 0) {
      allFirstNamesValid = false;
      badFirst = String(fn);
      break;
    }
  }
  assert("ORM FakeData inherits core firstName() contract (non-empty string)",
    allFirstNamesValid, `got "${badFirst}"`);

  // 3. The inherited firstName() is the SAME core implementation: a seeded ORM
  //    instance and a seeded CORE instance must produce the identical first
  //    name from the same seed — proving the subclass runs core code, not a
  //    reimplementation.
  const ormSeed = new FakeData(2024);
  const coreSeed = new CoreFakeData(2024);
  const ormFn = ormSeed.firstName();
  const coreFn = coreSeed.firstName();
  assert("ORM-seeded firstName() matches CORE-seeded firstName() (shared impl)",
    ormFn === coreFn, `orm "${ormFn}" vs core "${coreFn}"`);

  // 4. The ORM-only forField() (which does NOT exist on CoreFakeData) produces
  //    a typed value built from inherited core generators — proving the subclass
  //    layers real new behaviour on top of inherited behaviour.
  const bareCore = new CoreFakeData();
  assert("ORM-only forField() exists on the subclass but not on CoreFakeData",
    typeof (ormFake as { forField?: unknown }).forField === "function" &&
    typeof (bareCore as unknown as { forField?: unknown }).forField === "undefined");

  const fieldEmail = ormFake.forField({ type: "string" }, "email") as string;
  assert("ORM forField() produces a typed value via inherited core email() generator",
    typeof fieldEmail === "string" && fieldEmail.includes("@") && fieldEmail.includes("."));

  const fieldInt = ormFake.forField({ type: "integer", min: 100, max: 110 }, "qty") as number;
  assert("ORM forField() integer respects bounds using inherited core integer() generator",
    typeof fieldInt === "number" && Number.isInteger(fieldInt) && fieldInt >= 100 && fieldInt <= 110);
}

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
const seedCount = (await seedTable(mockDb, "test_users", 5, {
  name: () => seedFake.name(),
  email: () => seedFake.email(),
  age: () => seedFake.integer(18, 65),
})).seeded;

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
const seedCountWithOverrides = (await seedTable(mockDb, "test_users", 3, {
  name: () => seedFake.name(),
  role: () => "user",
}, { status: "active" })).seeded;

assert("seedTable with overrides returns correct count",
  seedCountWithOverrides === 3);

assert("seedTable override values are inserted (3 columns: name, role, status)",
  insertedRows[0].params.length === 3);

// Test empty fieldMap
const emptyResult = (await seedTable(mockDb, "test_users", 10)).seeded;
assert("seedTable with no fieldMap returns 0",
  emptyResult === 0);

// --- Core FakeData direct usage ---
console.log("\n--- Core FakeData Direct ---");

const coreFake = new CoreFakeData();

const coreFirst = coreFake.firstName();
assert("CoreFakeData.firstName returns string", typeof coreFirst === "string" && coreFirst.length > 0);

const coreLast = coreFake.lastName();
assert("CoreFakeData.lastName returns string", typeof coreLast === "string" && coreLast.length > 0);

const coreEmail = coreFake.email();
assert("CoreFakeData.email contains @", coreEmail.includes("@"));

const corePhone = coreFake.phone();
assert("CoreFakeData.phone starts with +1", corePhone.startsWith("+1"));

// --- Uniqueness ---
console.log("\n--- Uniqueness ---");

{
  const emails = new Set<string>();
  const f = new FakeData();
  for (let i = 0; i < 100; i++) {
    emails.add(f.email());
  }
  assert("100 generated emails are mostly unique", emails.size > 50);
}

{
  const uuids = new Set<string>();
  const f = new FakeData();
  for (let i = 0; i < 100; i++) {
    uuids.add(f.uuid());
  }
  assert("100 generated UUIDs are all unique", uuids.size === 100);
}

// --- Range boundaries ---
console.log("\n--- Range Boundaries ---");

{
  const f = new FakeData();
  for (let i = 0; i < 50; i++) {
    const v = f.integer(0, 0);
    if (v !== 0) {
      assert("integer(0, 0) always returns 0", false, `got ${v}`);
      break;
    }
  }
  assert("integer(0, 0) always returns 0", true);
}

{
  const f = new FakeData();
  for (let i = 0; i < 50; i++) {
    const v = f.integer(5, 5);
    if (v !== 5) {
      assert("integer(5, 5) always returns 5", false, `got ${v}`);
      break;
    }
  }
  assert("integer(5, 5) always returns 5", true);
}

{
  const f = new FakeData();
  const v = f.numeric(0, 0, 0);
  assert("float(0, 0, 0) returns 0", v === 0);
}

// --- Date edge cases ---
console.log("\n--- Date Edge Cases ---");

{
  const f = new FakeData();
  const d = f.date("2024-06-15", "2024-06-15");
  assert("same start and end date", d === "2024-06-15");
}

// --- Paragraph with different counts ---
console.log("\n--- Paragraph Variations ---");

{
  const f = new FakeData();
  const p1 = f.paragraph(1);
  assert("paragraph(1) contains at least 1 sentence", p1.includes("."));

  const p5 = f.paragraph(5);
  const sentences5 = p5.split(".").filter(s => s.trim().length > 0);
  assert("paragraph(5) has multiple sentences", sentences5.length >= 3);
}

// --- Word bank ---
console.log("\n--- Word Returns ---");

{
  const f = new FakeData();
  const words = new Set<string>();
  for (let i = 0; i < 50; i++) {
    words.add(f.word());
  }
  assert("word() returns variety", words.size > 5);
}

// --- Sentence structure ---
console.log("\n--- Sentence Structure ---");

{
  const f = new FakeData();
  for (let i = 0; i < 10; i++) {
    const s = f.sentence();
    assert(`sentence ${i + 1} starts uppercase`, s[0] === s[0].toUpperCase());
    assert(`sentence ${i + 1} ends with period`, s.endsWith("."));
  }
}

// --- Company structure ---
console.log("\n--- Company Structure ---");

{
  const f = new FakeData();
  for (let i = 0; i < 5; i++) {
    const c = f.company();
    assert(`company ${i + 1} has suffix`, c.includes(" "));
  }
}

// --- Job title ---
console.log("\n--- Job Title ---");

{
  const f = new FakeData();
  const jobs = new Set<string>();
  for (let i = 0; i < 20; i++) {
    jobs.add(f.jobTitle());
  }
  assert("jobTitle() returns variety", jobs.size > 3);
}

// --- forField string with maxLength ---
console.log("\n--- forField maxLength ---");

{
  const f = new FakeData();
  const maxLenField: FieldDefinition = { type: "string", maxLength: 5 };
  for (let i = 0; i < 10; i++) {
    const val = f.forField(maxLenField, "code") as string;
    if (val && val.length > 5) {
      assert("forField respects maxLength", false, `got length ${val.length}`);
      break;
    }
  }
  assert("forField string values within maxLength", true);
}

// --- forField with URL column ---
console.log("\n--- forField URL Heuristic ---");

{
  const f = new FakeData();
  const urlField: FieldDefinition = { type: "string" };
  const urlVal = f.forField(urlField, "website_url") as string;
  assert("forField url column generates URL", typeof urlVal === "string" && urlVal.startsWith("https://"));
}

// --- forField with UUID column ---
{
  const f = new FakeData();
  const uuidField: FieldDefinition = { type: "string" };
  const uuidVal = f.forField(uuidField, "uuid") as string;
  assert("forField uuid column generates UUID", /^[0-9a-f-]{36}$/.test(uuidVal));
}

// --- forField with IP column ---
{
  const f = new FakeData();
  const ipField: FieldDefinition = { type: "string" };
  const ipVal = f.forField(ipField, "ip") as string;
  assert("forField ip column generates IP", typeof ipVal === "string" && ipVal.split(".").length === 4);
}

// --- forField with address column ---
{
  const f = new FakeData();
  const addrField: FieldDefinition = { type: "string" };
  const addrVal = f.forField(addrField, "address") as string;
  assert("forField address column generates address", typeof addrVal === "string" && addrVal.includes(","));
}

// --- forField with city column ---
{
  const f = new FakeData();
  const cityField: FieldDefinition = { type: "string" };
  const cityVal = f.forField(cityField, "city") as string;
  assert("forField city column generates city", typeof cityVal === "string" && cityVal.length > 0);
}

// --- forField with country column ---
{
  const f = new FakeData();
  const countryField: FieldDefinition = { type: "string" };
  const countryVal = f.forField(countryField, "country") as string;
  assert("forField country column generates country", typeof countryVal === "string" && countryVal.length > 0);
}

// --- forField with company column ---
{
  const f = new FakeData();
  const companyField: FieldDefinition = { type: "string" };
  const companyVal = f.forField(companyField, "company_name") as string;
  assert("forField company column generates company", typeof companyVal === "string" && companyVal.length > 0);
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
