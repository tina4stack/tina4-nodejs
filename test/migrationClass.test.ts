/**
 * Unit tests for the Migration class (OOP wrapper around migration functions).
 * Run with: npx tsx test/migrationClass.test.ts
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Migration } from "../packages/orm/src/migration.ts";
import { SQLiteAdapter } from "../packages/orm/src/adapters/sqlite.ts";
import { setAdapter } from "../packages/orm/src/database.ts";

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

/** Create a temporary directory with its own SQLite DB and return helpers. */
function makeEnv() {
  const base = join(tmpdir(), `tina4-migration-test-${randomUUID()}`);
  const migrationsDir = join(base, "migrations");
  mkdirSync(migrationsDir, { recursive: true });
  const db = new SQLiteAdapter(`:memory:`);
  setAdapter(db);
  const m = new Migration(db, { migrationsDir });
  return { base, migrationsDir, db, m };
}

function teardown(base: string) {
  if (existsSync(base)) rmSync(base, { recursive: true, force: true });
}

function writeMigration(dir: string, name: string, upSql: string, downSql = "") {
  writeFileSync(join(dir, name), upSql, "utf-8");
  writeFileSync(
    join(dir, name.replace(".sql", ".down.sql")),
    downSql || `-- rollback ${name}\n`,
    "utf-8",
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log("=== Migration Class Tests ===\n");

// -- Instantiation -----------------------------------------------------------
{
  const { base, m } = makeEnv();
  assert("Migration class instantiates", m instanceof Migration);
  teardown(base);
}

// -- migrate() on empty directory --------------------------------------------
{
  const { base, m } = makeEnv();
  const result = await m.migrate();
  assert("migrate() returns MigrationResult", typeof result === "object" && "applied" in result);
  assert("migrate() applied is empty list on empty dir", result.applied.length === 0);
  teardown(base);
}

// -- migrate() applies pending migration -------------------------------------
{
  const { base, migrationsDir, m } = makeEnv();
  writeMigration(
    migrationsDir,
    "000001_create_users.sql",
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
    "DROP TABLE users;",
  );
  const result = await m.migrate();
  assert("migrate() applies pending migration", result.applied.includes("000001_create_users.sql"));
  teardown(base);
}

// -- migrate() skips already applied -----------------------------------------
{
  const { base, migrationsDir, m } = makeEnv();
  writeMigration(
    migrationsDir,
    "000001_create_users.sql",
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
    "DROP TABLE users;",
  );
  await m.migrate();
  const result2 = await m.migrate();
  assert("migrate() skips already-applied migration", result2.applied.length === 0);
  assert("migrate() tracks in skipped", result2.skipped.includes("000001_create_users.sql"));
  teardown(base);
}

// -- rollback() after migration ----------------------------------------------
{
  const { base, migrationsDir, m } = makeEnv();
  writeMigration(
    migrationsDir,
    "000001_create_users.sql",
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
    "DROP TABLE users;",
  );
  await m.migrate();
  const rolled = await m.rollback();
  assert("rollback() returns array", Array.isArray(rolled));
  assert("rollback() rolled back migration", rolled.length >= 1);
  teardown(base);
}

// -- rollback(steps=2) -------------------------------------------------------
{
  const { base, migrationsDir, m } = makeEnv();
  writeMigration(
    migrationsDir,
    "000001_create_users.sql",
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
    "DROP TABLE users;",
  );
  await m.migrate();
  writeMigration(
    migrationsDir,
    "000002_add_email.sql",
    "ALTER TABLE users ADD COLUMN email TEXT;",
    "-- no-op",
  );
  await m.migrate();
  const rolled = await m.rollback(2);
  assert("rollback(2) returns at least 1 item", rolled.length >= 1);
  teardown(base);
}

// -- rollback() on empty history returns [] ----------------------------------
{
  const { base, m } = makeEnv();
  const rolled = await m.rollback();
  assert("rollback() on empty history returns []", Array.isArray(rolled) && rolled.length === 0);
  teardown(base);
}

// -- status() structure ------------------------------------------------------
{
  const { base, migrationsDir, m } = makeEnv();
  writeMigration(
    migrationsDir,
    "000001_create_users.sql",
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
    "DROP TABLE users;",
  );
  await m.migrate();
  const s = await m.status();
  assert("status() has completed key", "completed" in s);
  assert("status() has pending key", "pending" in s);
  assert("status() completed has 1 entry", s.completed.length === 1);
  assert("status() pending is empty", s.pending.length === 0);
  teardown(base);
}

// -- getApplied() ------------------------------------------------------------
{
  const { base, migrationsDir, m } = makeEnv();
  writeMigration(
    migrationsDir,
    "000001_create_users.sql",
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
    "DROP TABLE users;",
  );
  await m.migrate();
  const applied = await m.getApplied();
  assert("getApplied() returns array", Array.isArray(applied));
  assert("getApplied() has 1 entry", applied.length === 1);
  teardown(base);
}

// -- getPending() before migration -------------------------------------------
{
  const { base, migrationsDir, m } = makeEnv();
  writeMigration(
    migrationsDir,
    "000001_create_users.sql",
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
  );
  const pending = await m.getPending();
  assert("getPending() returns array", Array.isArray(pending));
  assert("getPending() has 1 pending item", pending.length === 1);
  teardown(base);
}

// -- getFiles() --------------------------------------------------------------
{
  const { base, migrationsDir, m } = makeEnv();
  writeMigration(migrationsDir, "000001_create_users.sql", "CREATE TABLE users (id INTEGER PRIMARY KEY);");
  writeMigration(migrationsDir, "000002_add_email.sql", "ALTER TABLE users ADD COLUMN email TEXT;");
  const files = m.getFiles();
  assert("getFiles() returns array", Array.isArray(files));
  assert("getFiles() includes up migrations", files.includes("000001_create_users.sql"));
  assert("getFiles() excludes .down.sql", files.every((f: string) => !f.endsWith(".down.sql")));
  assert("getFiles() is sorted", JSON.stringify(files) === JSON.stringify([...files].sort()));
  teardown(base);
}

// -- create() scaffolds files ------------------------------------------------
{
  const { base, migrationsDir, m } = makeEnv();
  const result = await m.create("add products table");
  assert("create() returns upPath and downPath", "upPath" in result && "downPath" in result);
  assert("create() up file exists", existsSync(result.upPath));
  assert("create() down file exists", existsSync(result.downPath));
  assert("create() filename contains description", result.upPath.includes("add_products_table"));
  teardown(base);
}

// -- create() then migrate() -------------------------------------------------
{
  const { base, migrationsDir, m } = makeEnv();
  const { upPath } = await m.create("create test table");
  // Fill the up migration with actual SQL
  writeFileSync(upPath, "CREATE TABLE test_table (id INTEGER PRIMARY KEY);", "utf-8");
  const result = await m.migrate();
  assert("create() + migrate() applies new migration", result.applied.length === 1);
  teardown(base);
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
