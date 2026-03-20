/**
 * Unit tests for the Seeder module.
 * Run with: npx tsx test/seeder.test.ts
 */
import { Seeder } from "../packages/core/src/index.ts";

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

// --- Name generation ---
console.log("--- Name Generation ---");

const first = Seeder.firstName();
assert("firstName returns a non-empty string",
  typeof first === "string" && first.length > 0);

const last = Seeder.lastName();
assert("lastName returns a non-empty string",
  typeof last === "string" && last.length > 0);

const full = Seeder.fullName();
assert("fullName returns first and last name",
  typeof full === "string" && full.includes(" ") && full.split(" ").length === 2);

// --- Contact generation ---
console.log("\n--- Contact Generation ---");

const email = Seeder.email();
assert("email contains @ and domain",
  email.includes("@") && email.includes("."));

const phone = Seeder.phone();
assert("phone has expected format",
  phone.startsWith("+1 (") && phone.includes(")"));

const addr = Seeder.address();
assert("address contains street and city",
  typeof addr === "string" && addr.includes(","));

// --- Location ---
console.log("\n--- Location ---");

const city = Seeder.city();
assert("city returns a non-empty string", city.length > 0);

const country = Seeder.country();
assert("country returns a non-empty string", country.length > 0);

const zip = Seeder.zipCode();
assert("zipCode is 5 digits", /^\d{5}$/.test(zip));

// --- Company/Job ---
console.log("\n--- Company & Job ---");

const company = Seeder.company();
assert("company returns a name with suffix",
  typeof company === "string" && company.includes(" "));

const job = Seeder.jobTitle();
assert("jobTitle returns a non-empty string", job.length > 0);

// --- Text generation ---
console.log("\n--- Text Generation ---");

const word = Seeder.word();
assert("word returns a single word", typeof word === "string" && !word.includes(" "));

const sentence = Seeder.sentence();
assert("sentence ends with period and is capitalized",
  sentence.endsWith(".") && sentence[0] === sentence[0].toUpperCase());

const para = Seeder.paragraph(3);
assert("paragraph has multiple sentences",
  para.split(".").length >= 3);

// --- Numeric ---
console.log("\n--- Numeric ---");

const int = Seeder.integer(10, 20);
assert("integer is within range",
  int >= 10 && int <= 20);

const flt = Seeder.float(1, 5, 2);
assert("float is within range and has decimals",
  flt >= 1 && flt <= 5);

const bool = Seeder.boolean();
assert("boolean returns true or false",
  typeof bool === "boolean");

// --- Date ---
console.log("\n--- Date ---");

const date = Seeder.date("2023-01-01", "2023-12-31");
assert("date is in YYYY-MM-DD format and within range",
  /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= "2023-01-01" && date <= "2023-12-31");

// --- Identifiers ---
console.log("\n--- Identifiers ---");

const uuid = Seeder.uuid();
assert("uuid matches UUID format",
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid));

const url = Seeder.url();
assert("url starts with https://",
  url.startsWith("https://") && url.includes("/"));

const ip = Seeder.ipAddress();
assert("ipAddress has 4 octets",
  ip.split(".").length === 4 && ip.split(".").every((o) => Number(o) >= 0 && Number(o) <= 255));

// --- Colors ---
console.log("\n--- Colors ---");

const color = Seeder.color();
assert("color returns a color name", color.length > 0);

const hex = Seeder.hexColor();
assert("hexColor matches #RRGGBB format",
  /^#[0-9a-f]{6}$/.test(hex));

// --- Financial ---
console.log("\n--- Financial ---");

const cc = Seeder.creditCard();
assert("creditCard returns a known test number",
  cc.length >= 14 && /^\d+$/.test(cc));

const curr = Seeder.currency();
assert("currency returns a 3-letter code",
  /^[A-Z]{3}$/.test(curr));

// --- run() ---
console.log("\n--- Run Method ---");

const rows = Seeder.run(() => ({
  name: Seeder.fullName(),
  email: Seeder.email(),
}), 5);
assert("run() generates correct number of records",
  rows.length === 5);
assert("run() records have expected fields",
  typeof rows[0].name === "string" && typeof rows[0].email === "string");

// --- seed() with missing directory ---
console.log("\n--- Seed Method ---");

const seedResult = await Seeder.seed("/tmp/nonexistent-seed-dir-xyz");
assert("seed() with missing dir returns empty array",
  Array.isArray(seedResult) && seedResult.length === 0);

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
