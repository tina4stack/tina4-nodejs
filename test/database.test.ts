/**
 * Unit tests for the DATABASE_URL parser.
 * Run with: npx tsx test/database.test.ts
 */
import { parseDatabaseUrl } from "../packages/orm/src/index.ts";

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

console.log("=== DATABASE_URL Parser Tests ===\n");

// --- SQLite ---
console.log("--- SQLite URLs ---");

// Convention (matches tina4-python + tina4-php):
//   sqlite:///X       → relative to cwd (three slashes)
//   sqlite:////X      → absolute (four slashes)
//   sqlite:///C:/...  → Windows absolute (drive letter)
//   sqlite::memory:   → in-memory

const sqlite1 = parseDatabaseUrl("sqlite:///data/app.db");
assert("sqlite:/// is relative (type)", sqlite1.type === "sqlite");
assert("sqlite:/// is relative (path)", sqlite1.path === "data/app.db");

const sqlite1a = parseDatabaseUrl("sqlite:///app.db");
assert("sqlite:///app.db bare relative", sqlite1a.path === "app.db");

const sqlite1b = parseDatabaseUrl("sqlite:////var/data/app.db");
assert("sqlite:////X is absolute", sqlite1b.path === "/var/data/app.db");

const sqlite1c = parseDatabaseUrl("sqlite:///C:/Users/app.db");
assert("sqlite:///C:/ is Windows absolute", sqlite1c.path === "C:/Users/app.db");

const sqlite1m1 = parseDatabaseUrl("sqlite::memory:");
assert("sqlite::memory: short form", sqlite1m1.path === ":memory:");
const sqlite1m2 = parseDatabaseUrl("sqlite:///:memory:");
assert("sqlite:///:memory: URL form", sqlite1m2.path === ":memory:");

const sqlite2 = parseDatabaseUrl("sqlite://./data/app.db");
assert("sqlite:// two-slash legacy relative path type", sqlite2.type === "sqlite");
assert("sqlite:// two-slash legacy relative path", sqlite2.path === "./data/app.db");

// --- PostgreSQL ---
console.log("\n--- PostgreSQL URLs ---");

const pg1 = parseDatabaseUrl("postgresql://admin:secret@db.example.com:5432/myapp");
assert("postgresql type", pg1.type === "postgres");
assert("postgresql host", pg1.host === "db.example.com");
assert("postgresql port", pg1.port === 5432);
assert("postgresql user", pg1.user === "admin");
assert("postgresql password", pg1.password === "secret");
assert("postgresql database", pg1.database === "myapp");

const pg2 = parseDatabaseUrl("postgres://user:pass@localhost/testdb");
assert("postgres:// shorthand type", pg2.type === "postgres");
assert("postgres:// shorthand host", pg2.host === "localhost");
assert("postgres:// shorthand no port", pg2.port === undefined);
assert("postgres:// shorthand user", pg2.user === "user");
assert("postgres:// shorthand database", pg2.database === "testdb");

// --- MySQL ---
console.log("\n--- MySQL URLs ---");

const mysql1 = parseDatabaseUrl("mysql://root:password@mysql-host:3306/production");
assert("mysql type", mysql1.type === "mysql");
assert("mysql host", mysql1.host === "mysql-host");
assert("mysql port", mysql1.port === 3306);
assert("mysql user", mysql1.user === "root");
assert("mysql password", mysql1.password === "password");
assert("mysql database", mysql1.database === "production");

// --- URL-encoded credentials ---
console.log("\n--- Special Characters ---");

const encoded = parseDatabaseUrl("postgresql://user%40domain:p%40ss%23word@host/db");
assert("URL-encoded user", encoded.user === "user@domain");
assert("URL-encoded password", encoded.password === "p@ss#word");

// --- Error handling ---
console.log("\n--- Error Handling ---");

let threw = false;
try {
  parseDatabaseUrl("redis://localhost:6379");
} catch (e) {
  threw = true;
  assert("Error mentions unsupported scheme",
    (e as Error).message.includes("Unsupported"));
}
assert("Throws on unsupported scheme", threw);

let threw2 = false;
try {
  parseDatabaseUrl("not a url at all");
} catch {
  threw2 = true;
}
assert("Throws on invalid URL", threw2);

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
