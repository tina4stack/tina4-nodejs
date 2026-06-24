/**
 * Unit tests for the Migration class (OOP wrapper around migration functions).
 * Run with: npx tsx test/migrationClass.test.ts
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
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

// -- Instantiation: instance is wired to the real adapter + directory ---------
{
  const { base, migrationsDir, db, m } = makeEnv();
  // A bare `instanceof` check proves nothing about wiring. Instead, write a real
  // migration file and prove the constructed instance runs it against the adapter
  // and directory it was given: the file is applied AND its CREATE TABLE side
  // effect is observable on the same db handle.
  writeMigration(
    migrationsDir,
    "000001_create_widgets.sql",
    "CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT);",
    "DROP TABLE widgets;",
  );
  const res = await m.migrate();
  assert(
    "Migration instance is wired to its adapter + dir (applies real file)",
    res.applied.includes("000001_create_widgets.sql") && (db as any).tableExists("widgets"),
  );
  teardown(base);
}

// -- migrate() on empty directory --------------------------------------------
{
  const { base, m } = makeEnv();
  const result = await m.migrate();
  // Full MigrationResult shape with real values on an empty dir: every bucket is
  // an actual empty array, not merely a key that happens to be present.
  assert(
    "migrate() returns full empty MigrationResult on empty dir",
    Array.isArray(result.applied) && Array.isArray(result.skipped) && Array.isArray(result.failed) &&
      result.applied.length === 0 && result.skipped.length === 0 && result.failed.length === 0,
  );
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

// -- rollback() runs the down SQL (real DROP side effect) --------------------
{
  const { base, migrationsDir, db, m } = makeEnv();
  writeMigration(
    migrationsDir,
    "000001_create_users.sql",
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
    "DROP TABLE users;",
  );
  await m.migrate();
  assert("rollback() precondition: users table created", (db as any).tableExists("users"));
  const rolled = await m.rollback();
  // rollback() returns the tracked migration NAMES (the bookkeeping `name`, which
  // is the filename with the .sql suffix stripped — see migrate()'s migrationId).
  // Assert the real returned name AND that the down SQL's DROP actually executed.
  assert(
    "rollback() reports the rolled-back migration name",
    rolled.includes("000001_create_users"),
  );
  assert("rollback() down SQL dropped the users table", !(db as any).tableExists("users"));
  teardown(base);
}

// -- rollback(steps=2) -------------------------------------------------------
{
  const { base, migrationsDir, db, m } = makeEnv();
  writeMigration(
    migrationsDir,
    "000001_create_users.sql",
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
    "DROP TABLE users;",
  );
  await m.migrate();   // batch 1: 000001
  writeMigration(
    migrationsDir,
    "000002_add_email.sql",
    "ALTER TABLE users ADD COLUMN email TEXT;",
    "DROP TABLE users;",  // real down SQL so the rollback has an observable effect
  );
  await m.migrate();   // batch 2: 000002
  const rolled = await m.rollback(2);  // unwind both batches
  // Assert the down SQL of both batches actually ran: nothing remains applied and
  // the users table created by 000001 is gone (000002's DROP TABLE executed first,
  // then 000001's record is removed) — not merely that the result has >= 1 entry.
  assert(
    "rollback(2) reports both rolled-back migration names",
    rolled.includes("000002_add_email") && rolled.includes("000001_create_users"),
  );
  assert("rollback(2) leaves nothing applied", (await m.getApplied()).length === 0);
  assert("rollback(2) down SQL dropped the users table", !(db as any).tableExists("users"));
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
  // Exercise the tracking-table read-back: the single applied entry must name the
  // migration we just ran (getApplied() reports completed filenames, .sql kept).
  assert(
    "getApplied() reports the applied migration by name",
    applied.length === 1 && applied[0].includes("000001_create_users"),
  );
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
  // Confirm getPending() reports the actual un-applied file by name, not just any array.
  assert(
    "getPending() reports the un-applied file by name",
    pending.includes("000001_create_users.sql"),
  );
  assert("getPending() has 1 pending item", pending.length === 1);
  teardown(base);
}

// -- getFiles() --------------------------------------------------------------
{
  const { base, migrationsDir, m } = makeEnv();
  writeMigration(migrationsDir, "000001_create_users.sql", "CREATE TABLE users (id INTEGER PRIMARY KEY);");
  writeMigration(migrationsDir, "000002_add_email.sql", "ALTER TABLE users ADD COLUMN email TEXT;");
  const files = m.getFiles();
  // Both written .sql up-migrations are discovered (the .down.sql siblings excluded).
  assert("getFiles() discovers both written up-migrations", files.length === 2);
  assert("getFiles() includes up migrations", files.includes("000001_create_users.sql"));
  assert("getFiles() excludes .down.sql", files.every((f: string) => !f.endsWith(".down.sql")));
  assert("getFiles() is sorted", JSON.stringify(files) === JSON.stringify([...files].sort()));
  teardown(base);
}

// -- create() scaffolds files ------------------------------------------------
{
  const { base, migrationsDir, m } = makeEnv();
  const result = await m.create("add products table") as { upPath: string; downPath: string };
  // Content check, not mere key-presence: the scaffolded up file carries the real
  // migration template header, and the down path is a distinct .down.sql sibling.
  const upContent = readFileSync(result.upPath, "utf-8");
  assert(
    "create() scaffolds an up file with the migration template header",
    upContent.includes("-- Migration: add products table"),
  );
  assert(
    "create() down path is a distinct .down.sql sibling",
    result.downPath.endsWith(".down.sql") && result.downPath !== result.upPath,
  );
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
