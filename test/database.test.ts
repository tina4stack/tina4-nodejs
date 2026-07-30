/**
 * Unit tests for the TINA4_DATABASE_URL parser.
 * Run with: npx tsx test/database.test.ts
 */
import { Database, parseDatabaseUrl } from "../packages/orm/src/index.ts";

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
assert("sqlite:/// is relative (type)", sqlite1.engine === "sqlite");
assert("sqlite:/// is relative (path)", sqlite1.database === "data/app.db");

const sqlite1a = parseDatabaseUrl("sqlite:///app.db");
assert("sqlite:///app.db bare relative", sqlite1a.database === "app.db");

const sqlite1b = parseDatabaseUrl("sqlite:////var/data/app.db");
assert("sqlite:////X is absolute", sqlite1b.database === "/var/data/app.db");

const sqlite1c = parseDatabaseUrl("sqlite:///C:/Users/app.db");
assert("sqlite:///C:/ is Windows absolute", sqlite1c.database === "C:/Users/app.db");

const sqlite1m1 = parseDatabaseUrl("sqlite::memory:");
assert("sqlite::memory: short form", sqlite1m1.database === ":memory:");
const sqlite1m2 = parseDatabaseUrl("sqlite:///:memory:");
assert("sqlite:///:memory: URL form", sqlite1m2.database === ":memory:");

const sqlite2 = parseDatabaseUrl("sqlite://./data/app.db");
assert("sqlite:// two-slash legacy relative path type", sqlite2.engine === "sqlite");
assert("sqlite:// two-slash legacy relative path", sqlite2.database === "./data/app.db");

// --- PostgreSQL ---
console.log("\n--- PostgreSQL URLs ---");

const pg1 = parseDatabaseUrl("postgresql://admin:secret@db.example.com:5432/myapp");
assert("postgresql type", pg1.engine === "postgres");
assert("postgresql host", pg1.host === "db.example.com");
assert("postgresql port", pg1.port === 5432);
assert("postgresql user", pg1.username === "admin");
assert("postgresql password", pg1.password === "secret");
assert("postgresql database", pg1.database === "myapp");

// pgsql:// is the PDO/Laravel/Doctrine scheme name (issue #58)
const pgsql = parseDatabaseUrl("pgsql://user:pass@localhost:5432/testdb");
assert("pgsql:// scheme type", pgsql.engine === "postgres");
assert("pgsql:// scheme host", pgsql.host === "localhost");
assert("pgsql:// scheme port", pgsql.port === 5432);
assert("pgsql:// scheme database", pgsql.database === "testdb");

const pg2 = parseDatabaseUrl("postgres://user:pass@localhost/testdb");
assert("postgres:// shorthand type", pg2.engine === "postgres");
assert("postgres:// shorthand host", pg2.host === "localhost");
// The engine default is applied AT PARSE now: the port is part of our
// contract, not the third-party driver's business (feature 5, D2).
assert("postgres:// shorthand gets the default port", pg2.port === 5432);
assert("postgres:// shorthand user", pg2.username === "user");
assert("postgres:// shorthand database", pg2.database === "testdb");

// --- MySQL ---
console.log("\n--- MySQL URLs ---");

const mysql1 = parseDatabaseUrl("mysql://root:password@mysql-host:3306/production");
assert("mysql type", mysql1.engine === "mysql");
assert("mysql host", mysql1.host === "mysql-host");
assert("mysql port", mysql1.port === 3306);
assert("mysql user", mysql1.username === "root");
assert("mysql password", mysql1.password === "password");
assert("mysql database", mysql1.database === "production");

// --- URL-encoded credentials ---
console.log("\n--- Special Characters ---");

const encoded = parseDatabaseUrl("postgresql://user%40domain:p%40ss%23word@host/db");
assert("URL-encoded user", encoded.username === "user@domain");
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

// --- Database.fromEnv() default env var — regression for tina4-nodejs#45 ---
//
// Before the fix, fromEnv() defaulted to the legacy bare "DATABASE_URL"
// while the rest of the framework reads "TINA4_DATABASE_URL". A caller
// invoking Database.fromEnv() with no argument would look up the wrong
// env var and either throw or silently miss the project's connection.
console.log("\n--- Database.fromEnv default key ---");

// Save + clear both keys so we know exactly what's being read.
const _saved = {
  TINA4_DATABASE_URL: process.env.TINA4_DATABASE_URL,
  DATABASE_URL: process.env.DATABASE_URL,
};
delete process.env.TINA4_DATABASE_URL;
delete process.env.DATABASE_URL;

// Bare DATABASE_URL alone must NOT satisfy the lookup.
process.env.DATABASE_URL = "sqlite:///wrong.db";
let bareThrew = false;
try {
  await Database.fromEnv();
} catch (e) {
  bareThrew = /TINA4_DATABASE_URL/.test(String(e));
}
assert("fromEnv() default key is TINA4_DATABASE_URL, not bare DATABASE_URL", bareThrew);

// With TINA4_DATABASE_URL set it must succeed.
process.env.TINA4_DATABASE_URL = "sqlite::memory:";
let goodOk = false;
try {
  const db = await Database.fromEnv();
  goodOk = !!db;
} catch {}
assert("fromEnv() reads TINA4_DATABASE_URL when set", goodOk);

// Restore previous environment so other tests in the suite stay clean.
delete process.env.TINA4_DATABASE_URL;
delete process.env.DATABASE_URL;
if (_saved.TINA4_DATABASE_URL !== undefined) process.env.TINA4_DATABASE_URL = _saved.TINA4_DATABASE_URL;
if (_saved.DATABASE_URL !== undefined) process.env.DATABASE_URL = _saved.DATABASE_URL;

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
