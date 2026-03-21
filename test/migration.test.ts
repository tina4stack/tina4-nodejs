/**
 * Unit tests for the Migration enhancements (Phase 2).
 * Run with: npx tsx test/migration.test.ts
 */
import { rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  initDatabase,
  closeDatabase,
  getAdapter,
  ensureMigrationTable,
  getNextBatch,
  applyMigration,
  isMigrationApplied,
  rollback,
  getAppliedMigrations,
  getLastBatchMigrations,
  migrate,
  createMigration,
} from "../packages/orm/src/index.ts";

const TEST_DB = "/tmp/tina4-migration-test/test.db";
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

// Clean slate
try { rmSync("/tmp/tina4-migration-test", { recursive: true }); } catch {}
mkdirSync("/tmp/tina4-migration-test", { recursive: true });

console.log("=== Migration Enhancement Tests ===\n");

// Initialize database
await initDatabase({ type: "sqlite", path: TEST_DB });
const adapter = getAdapter();

// --- Migration Table Creation ---
console.log("--- Migration Table ---");

ensureMigrationTable();
assert("Migration table created", (adapter as any).tableExists("tina4_migration"));

// Calling again should be idempotent
ensureMigrationTable();
assert("ensureMigrationTable is idempotent", (adapter as any).tableExists("tina4_migration"));

// --- Batch Tracking ---
console.log("\n--- Batch Tracking ---");

const batch1 = getNextBatch();
assert("First batch is 1", batch1 === 1);

// --- Apply Migrations ---
console.log("\n--- Apply Migrations ---");

applyMigration("20250101120000_create_users", () => {
  adapter.execute(`CREATE TABLE IF NOT EXISTS "test_users" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL
  )`);
}, batch1);

assert("Migration recorded", isMigrationApplied("20250101120000_create_users"));
assert("test_users table created", (adapter as any).tableExists("test_users"));

applyMigration("20250101120100_create_posts", () => {
  adapter.execute(`CREATE TABLE IF NOT EXISTS "test_posts" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    user_id INTEGER
  )`);
}, batch1);

assert("Second migration in same batch", isMigrationApplied("20250101120100_create_posts"));
assert("test_posts table created", (adapter as any).tableExists("test_posts"));

// --- Duplicate Migration Prevention ---
console.log("\n--- Duplicate Prevention ---");

let duplicateRan = false;
applyMigration("20250101120000_create_users", () => {
  duplicateRan = true;
}, batch1);
assert("Duplicate migration skipped", !duplicateRan);

// --- Second Batch ---
console.log("\n--- Second Batch ---");

const batch2 = getNextBatch();
assert("Second batch is 2", batch2 === 2);

applyMigration("20250201120000_add_age_column", () => {
  adapter.execute(`ALTER TABLE "test_users" ADD COLUMN age INTEGER DEFAULT 0`);
}, batch2);

assert("Batch 2 migration applied", isMigrationApplied("20250201120000_add_age_column"));

// --- Get Applied Migrations ---
console.log("\n--- Applied Migrations List ---");

const applied = getAppliedMigrations();
assert("All 3 migrations recorded", applied.length === 3);
assert("Correct batch numbers", applied[0].batch === 1 && applied[2].batch === 2);
assert("Migration names stored", applied[0].name === "20250101120000_create_users");

// --- Last Batch Migrations ---
console.log("\n--- Last Batch ---");

const lastBatch = getLastBatchMigrations();
assert("Last batch has 1 migration", lastBatch.length === 1);
assert("Last batch is batch 2", lastBatch[0].batch === 2);

// --- Rollback ---
console.log("\n--- Rollback ---");

const downFunctions = new Map<string, () => void>();
downFunctions.set("20250201120000_add_age_column", () => {
  // SQLite doesn't support DROP COLUMN easily, but we can verify the rollback mechanism
  // Just create a marker table to prove the down function ran
  adapter.execute(`CREATE TABLE IF NOT EXISTS "_rollback_marker" (id INTEGER)`);
});

const rolledBack = rollback(downFunctions);
assert("Rollback returns rolled-back migration names", rolledBack.length === 1);
assert("Correct migration rolled back", rolledBack[0] === "20250201120000_add_age_column");
assert("Down function executed", (adapter as any).tableExists("_rollback_marker"));
assert("Migration record removed", !isMigrationApplied("20250201120000_add_age_column"));

// --- Verify batch 1 still intact ---
console.log("\n--- Post-Rollback State ---");

const remaining = getAppliedMigrations();
assert("Batch 1 migrations still applied", remaining.length === 2);
assert("Still applied: create_users", isMigrationApplied("20250101120000_create_users"));
assert("Still applied: create_posts", isMigrationApplied("20250101120100_create_posts"));

// --- Rollback batch 1 ---
console.log("\n--- Rollback Batch 1 ---");

const batch1Downs = new Map<string, () => void>();
batch1Downs.set("20250101120100_create_posts", () => {
  adapter.execute(`DROP TABLE IF EXISTS "test_posts"`);
});
batch1Downs.set("20250101120000_create_users", () => {
  adapter.execute(`DROP TABLE IF EXISTS "test_users"`);
});

const rolledBack2 = rollback(batch1Downs);
assert("Batch 1 rollback: 2 migrations", rolledBack2.length === 2);
assert("test_posts table dropped", !(adapter as any).tableExists("test_posts"));
assert("test_users table dropped", !(adapter as any).tableExists("test_users"));

const afterFullRollback = getAppliedMigrations();
assert("No migrations remain after full rollback", afterFullRollback.length === 0);

// --- Rollback with no migrations ---
console.log("\n--- Empty Rollback ---");

const emptyRollback = rollback(new Map());
assert("Rollback on empty state returns empty array", emptyRollback.length === 0);

// ========================================================================
// SQL-File Migration Tests (migrate / createMigration)
// ========================================================================

console.log("\n\n=== SQL-File Migration Tests ===\n");

// Close old db, create fresh one for SQL-file tests
closeDatabase();
try { rmSync("/tmp/tina4-migration-test", { recursive: true }); } catch {}
mkdirSync("/tmp/tina4-migration-test", { recursive: true });

const TEST_DB_2 = "/tmp/tina4-migration-test/test2.db";
await initDatabase({ type: "sqlite", path: TEST_DB_2 });
const adapter2 = getAdapter();

const MIGRATIONS_DIR = "/tmp/tina4-migration-test/migrations";

// --- createMigration() ---
console.log("--- createMigration ---");

const path1 = await createMigration("create users table", { migrationsDir: MIGRATIONS_DIR });
assert("createMigration returns a path", path1.includes("000001_create_users_table.sql"));
assert("Migration file created on disk", existsSync(path1));

const path2 = await createMigration("add email column", { migrationsDir: MIGRATIONS_DIR });
assert("Second migration has sequence 000002", path2.includes("000002_add_email_column.sql"));

// List files in dir
const migFiles = readdirSync(MIGRATIONS_DIR).sort();
assert("Two migration files exist", migFiles.length === 2);
assert("Files are sorted correctly", migFiles[0].startsWith("000001") && migFiles[1].startsWith("000002"));

// --- Write SQL content to migration files ---
writeFileSync(path1, `
-- Migration: create users table
CREATE TABLE test_sql_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);
`, "utf-8");

writeFileSync(path2, `
-- Migration: add email column
ALTER TABLE test_sql_users ADD COLUMN email TEXT;
`, "utf-8");

// --- migrate() with no existing tracking table ---
console.log("\n--- migrate() ---");

const result1 = await migrate(adapter2, { migrationsDir: MIGRATIONS_DIR });
assert("migrate() applied 2 files", result1.applied.length === 2);
assert("migrate() skipped 0", result1.skipped.length === 0);
assert("migrate() failed 0", result1.failed.length === 0);
assert("test_sql_users table exists", adapter2.tableExists("test_sql_users"));

// Verify data can be inserted (email column was added)
adapter2.execute(`INSERT INTO test_sql_users (name, email) VALUES ('Alice', 'alice@test.com')`);
const rows = adapter2.query<{ name: string; email: string }>("SELECT * FROM test_sql_users");
assert("Data inserted correctly", rows.length === 1 && rows[0].name === "Alice" && rows[0].email === "alice@test.com");

// --- Running migrate() again should skip all ---
console.log("\n--- migrate() idempotent ---");

const result2 = await migrate(adapter2, { migrationsDir: MIGRATIONS_DIR });
assert("Second migrate() applied 0", result2.applied.length === 0);
assert("Second migrate() skipped 2", result2.skipped.length === 2);

// --- Add a third migration ---
console.log("\n--- Incremental migration ---");

const path3 = await createMigration("create orders table", { migrationsDir: MIGRATIONS_DIR });
writeFileSync(path3, `
CREATE TABLE test_sql_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  total REAL
);
`, "utf-8");

const result3 = await migrate(adapter2, { migrationsDir: MIGRATIONS_DIR });
assert("Third migrate() applied 1 new file", result3.applied.length === 1);
assert("Third migrate() skipped 2 existing", result3.skipped.length === 2);
assert("test_sql_orders table exists", adapter2.tableExists("test_sql_orders"));

// --- migrate() with empty directory ---
console.log("\n--- migrate() edge cases ---");

const emptyDir = "/tmp/tina4-migration-test/empty_migrations";
mkdirSync(emptyDir, { recursive: true });
const resultEmpty = await migrate(adapter2, { migrationsDir: emptyDir });
assert("Empty dir: no applied", resultEmpty.applied.length === 0);
assert("Empty dir: no skipped", resultEmpty.skipped.length === 0);

// --- migrate() with non-existent directory ---
const resultNoDir = await migrate(adapter2, { migrationsDir: "/tmp/tina4-migration-test/nonexistent" });
assert("Non-existent dir: no applied", resultNoDir.applied.length === 0);

// --- migrate() with a failing SQL file ---
console.log("\n--- migrate() error handling ---");

const failDir = "/tmp/tina4-migration-test/fail_migrations";
mkdirSync(failDir, { recursive: true });
writeFileSync(join(failDir, "000001_good.sql"), `CREATE TABLE good_table (id INTEGER PRIMARY KEY);`, "utf-8");
writeFileSync(join(failDir, "000002_bad.sql"), `THIS IS NOT VALID SQL;`, "utf-8");
writeFileSync(join(failDir, "000003_also_good.sql"), `CREATE TABLE another_good (id INTEGER PRIMARY KEY);`, "utf-8");

const resultFail = await migrate(adapter2, { migrationsDir: failDir });
assert("Good migration applied", resultFail.applied.includes("000001_good.sql"));
assert("Bad migration failed", resultFail.failed.includes("000002_bad.sql"));
assert("Migration after failure still runs", resultFail.applied.includes("000003_also_good.sql"));
assert("good_table exists", adapter2.tableExists("good_table"));
assert("another_good exists", adapter2.tableExists("another_good"));

// --- migrate() with multi-statement and comments ---
console.log("\n--- Multi-statement + comments ---");

const multiDir = "/tmp/tina4-migration-test/multi_migrations";
mkdirSync(multiDir, { recursive: true });
writeFileSync(join(multiDir, "000001_multi.sql"), `
-- This is a comment
CREATE TABLE multi_a (id INTEGER PRIMARY KEY);

-- Another comment
CREATE TABLE multi_b (id INTEGER PRIMARY KEY);

/* Block comment */
CREATE TABLE multi_c (id INTEGER PRIMARY KEY);
`, "utf-8");

const resultMulti = await migrate(adapter2, { migrationsDir: multiDir });
assert("Multi-statement migration applied", resultMulti.applied.length === 1);
assert("multi_a exists", adapter2.tableExists("multi_a"));
assert("multi_b exists", adapter2.tableExists("multi_b"));
assert("multi_c exists", adapter2.tableExists("multi_c"));

// --- createMigration() sanitises description ---
console.log("\n--- createMigration description sanitisation ---");

const pathSpecial = await createMigration("Add user's EMAIL & Phone!", { migrationsDir: MIGRATIONS_DIR });
assert("Special chars sanitised", pathSpecial.includes("add_user_s_email_phone"));

// Cleanup
closeDatabase();
try { rmSync("/tmp/tina4-migration-test", { recursive: true }); } catch {}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
