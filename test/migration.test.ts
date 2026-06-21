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
  status,
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

await ensureMigrationTable();
assert("Migration table created", (adapter as any).tableExists("tina4_migration"));

// Calling again should be idempotent
await ensureMigrationTable();
assert("ensureMigrationTable is idempotent", (adapter as any).tableExists("tina4_migration"));

// --- Batch Tracking ---
console.log("\n--- Batch Tracking ---");

const batch1 = await getNextBatch();
assert("First batch is 1", batch1 === 1);

// --- Apply Migrations ---
console.log("\n--- Apply Migrations ---");

await applyMigration("20250101120000_create_users", () => {
  adapter.execute(`CREATE TABLE IF NOT EXISTS "test_users" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL
  )`);
}, batch1);

assert("Migration recorded", await isMigrationApplied("20250101120000_create_users"));
assert("test_users table created", (adapter as any).tableExists("test_users"));

await applyMigration("20250101120100_create_posts", () => {
  adapter.execute(`CREATE TABLE IF NOT EXISTS "test_posts" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    user_id INTEGER
  )`);
}, batch1);

assert("Second migration in same batch", await isMigrationApplied("20250101120100_create_posts"));
assert("test_posts table created", (adapter as any).tableExists("test_posts"));

// --- Duplicate Migration Prevention ---
console.log("\n--- Duplicate Prevention ---");

let duplicateRan = false;
await applyMigration("20250101120000_create_users", () => {
  duplicateRan = true;
}, batch1);
assert("Duplicate migration skipped", !duplicateRan);

// --- Second Batch ---
console.log("\n--- Second Batch ---");

const batch2 = await getNextBatch();
assert("Second batch is 2", batch2 === 2);

await applyMigration("20250201120000_add_age_column", () => {
  adapter.execute(`ALTER TABLE "test_users" ADD COLUMN age INTEGER DEFAULT 0`);
}, batch2);

assert("Batch 2 migration applied", await isMigrationApplied("20250201120000_add_age_column"));

// --- Get Applied Migrations ---
console.log("\n--- Applied Migrations List ---");

const applied = await getAppliedMigrations();
assert("All 3 migrations recorded", applied.length === 3);
assert("Correct batch numbers", applied[0].batch === 1 && applied[2].batch === 2);
assert("Migration names stored", applied[0].name === "20250101120000_create_users");

// --- Last Batch Migrations ---
console.log("\n--- Last Batch ---");

const lastBatch = await getLastBatchMigrations();
assert("Last batch has 1 migration", lastBatch.length === 1);
assert("Last batch is batch 2", lastBatch[0].batch === 2);

// --- Rollback (legacy Map API) ---
console.log("\n--- Rollback (legacy Map API) ---");

const downFunctions = new Map<string, () => void>();
downFunctions.set("20250201120000_add_age_column", () => {
  adapter.execute(`CREATE TABLE IF NOT EXISTS "_rollback_marker" (id INTEGER)`);
});

const rolledBack = await rollback(downFunctions);
assert("Rollback returns rolled-back migration names", rolledBack.length === 1);
assert("Correct migration rolled back", rolledBack[0] === "20250201120000_add_age_column");
assert("Down function executed", (adapter as any).tableExists("_rollback_marker"));
assert("Migration record removed", !(await isMigrationApplied("20250201120000_add_age_column")));

// --- Verify batch 1 still intact ---
console.log("\n--- Post-Rollback State ---");

const remaining = await getAppliedMigrations();
assert("Batch 1 migrations still applied", remaining.length === 2);
assert("Still applied: create_users", await isMigrationApplied("20250101120000_create_users"));
assert("Still applied: create_posts", await isMigrationApplied("20250101120100_create_posts"));

// --- Rollback batch 1 ---
console.log("\n--- Rollback Batch 1 ---");

const batch1Downs = new Map<string, () => void>();
batch1Downs.set("20250101120100_create_posts", () => {
  adapter.execute(`DROP TABLE IF EXISTS "test_posts"`);
});
batch1Downs.set("20250101120000_create_users", () => {
  adapter.execute(`DROP TABLE IF EXISTS "test_users"`);
});

const rolledBack2 = await rollback(batch1Downs);
assert("Batch 1 rollback: 2 migrations", rolledBack2.length === 2);
assert("test_posts table dropped", !(adapter as any).tableExists("test_posts"));
assert("test_users table dropped", !(adapter as any).tableExists("test_users"));

const afterFullRollback = await getAppliedMigrations();
assert("No migrations remain after full rollback", afterFullRollback.length === 0);

// --- Rollback with no migrations ---
console.log("\n--- Empty Rollback ---");

const emptyRollback = await rollback(new Map());
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

const result1Create = await createMigration("create users table", { migrationsDir: MIGRATIONS_DIR });
assert("createMigration returns upPath", result1Create.upPath.includes("_create_users_table.sql"));
assert("createMigration returns downPath", result1Create.downPath.includes("_create_users_table.down.sql"));
assert("Up migration file created on disk", existsSync(result1Create.upPath));
assert("Down migration file created on disk", existsSync(result1Create.downPath));

// Small delay to ensure different timestamp
await new Promise((r) => setTimeout(r, 1100));

const result2Create = await createMigration("add email column", { migrationsDir: MIGRATIONS_DIR });
assert("Second up migration created", existsSync(result2Create.upPath));
assert("Second down migration created", existsSync(result2Create.downPath));

// List files in dir — should be 4 files (2 up + 2 down)
const migFiles = readdirSync(MIGRATIONS_DIR).sort();
assert("Four migration files exist (2 up + 2 down)", migFiles.length === 4);

const upFiles = migFiles.filter(f => f.endsWith(".sql") && !f.endsWith(".down.sql"));
const downFiles = migFiles.filter(f => f.endsWith(".down.sql"));
assert("Two up migration files", upFiles.length === 2);
assert("Two down migration files", downFiles.length === 2);

// --- Write SQL content to migration files ---
writeFileSync(result1Create.upPath, `
-- Migration: create users table
CREATE TABLE test_sql_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);
`, "utf-8");

writeFileSync(result2Create.upPath, `
-- Migration: add email column
ALTER TABLE test_sql_users ADD COLUMN email TEXT;
`, "utf-8");

// --- migrate() with no existing tracking table ---
console.log("\n--- migrate() ---");

const result1Migrate = await migrate(adapter2, { migrationsDir: MIGRATIONS_DIR });
assert("migrate() applied 2 files", result1Migrate.applied.length === 2);
assert("migrate() skipped 0", result1Migrate.skipped.length === 0);
assert("migrate() failed 0", result1Migrate.failed.length === 0);
assert("test_sql_users table exists", adapter2.tableExists("test_sql_users"));

// Verify data can be inserted (email column was added)
adapter2.execute(`INSERT INTO test_sql_users (name, email) VALUES ('Alice', 'alice@test.com')`);
const rows = adapter2.query<{ name: string; email: string }>("SELECT * FROM test_sql_users");
assert("Data inserted correctly", rows.length === 1 && rows[0].name === "Alice" && rows[0].email === "alice@test.com");

// --- Running migrate() again should skip all ---
console.log("\n--- migrate() idempotent ---");

const result2Migrate = await migrate(adapter2, { migrationsDir: MIGRATIONS_DIR });
assert("Second migrate() applied 0", result2Migrate.applied.length === 0);
assert("Second migrate() skipped 2", result2Migrate.skipped.length === 2);

// --- Add a third migration ---
console.log("\n--- Incremental migration ---");

const result3Create = await createMigration("create orders table", { migrationsDir: MIGRATIONS_DIR });
writeFileSync(result3Create.upPath, `
CREATE TABLE test_sql_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  total REAL
);
`, "utf-8");

const result3Migrate = await migrate(adapter2, { migrationsDir: MIGRATIONS_DIR });
assert("Third migrate() applied 1 new file", result3Migrate.applied.length === 1);
assert("Third migrate() skipped 2 existing", result3Migrate.skipped.length === 2);
assert("test_sql_orders table exists", adapter2.tableExists("test_sql_orders"));

// --- status() function ---
console.log("\n--- status() ---");

const statusResult = await status(adapter2, { migrationsDir: MIGRATIONS_DIR });
assert("status() completed has 3", statusResult.completed.length === 3);
assert("status() pending has 0", statusResult.pending.length === 0);

// Add a new migration without running it
const result4Create = await createMigration("pending migration", { migrationsDir: MIGRATIONS_DIR });
writeFileSync(result4Create.upPath, `CREATE TABLE pending_table (id INTEGER PRIMARY KEY);`, "utf-8");

const statusResult2 = await status(adapter2, { migrationsDir: MIGRATIONS_DIR });
assert("status() with pending: completed has 3", statusResult2.completed.length === 3);
assert("status() with pending: pending has 1", statusResult2.pending.length === 1);

// --- .down.sql rollback ---
console.log("\n--- .down.sql Rollback ---");

// Write a down migration for the orders table
writeFileSync(result3Create.downPath, `DROP TABLE IF EXISTS test_sql_orders;`, "utf-8");

// Rollback using directory-based .down.sql files
const rolledBackSql = await rollback(MIGRATIONS_DIR);
assert("SQL rollback rolled back migrations", rolledBackSql.length > 0);
assert("test_sql_orders table dropped after rollback", !adapter2.tableExists("test_sql_orders"));

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
// G3 (data-integrity): migrate() STOPS at the first failed file — a later
// migration must NOT be applied on top of a missing earlier one (parity with
// Python/PHP/Ruby).
assert("Migration after failure does NOT run (stopped)", !resultFail.applied.includes("000003_also_good.sql"));
assert("good_table exists", adapter2.tableExists("good_table"));
assert("another_good NOT created (stopped before it)", !adapter2.tableExists("another_good"));

// --- Both naming patterns supported ---
console.log("\n--- Dual naming pattern support ---");

const mixedDir = "/tmp/tina4-migration-test/mixed_migrations";
mkdirSync(mixedDir, { recursive: true });
writeFileSync(join(mixedDir, "000001_sequential.sql"), `CREATE TABLE seq_table (id INTEGER PRIMARY KEY);`, "utf-8");
writeFileSync(join(mixedDir, "20250101120000_timestamp.sql"), `CREATE TABLE ts_table (id INTEGER PRIMARY KEY);`, "utf-8");

const resultMixed = await migrate(adapter2, { migrationsDir: mixedDir });
assert("Sequential migration applied", resultMixed.applied.includes("000001_sequential.sql"));
assert("Timestamp migration applied", resultMixed.applied.includes("20250101120000_timestamp.sql"));
assert("seq_table exists", adapter2.tableExists("seq_table"));
assert("ts_table exists", adapter2.tableExists("ts_table"));

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

const resultSpecial = await createMigration("Add user's EMAIL & Phone!", { migrationsDir: MIGRATIONS_DIR });
assert("Special chars sanitised", resultSpecial.upPath.includes("add_user_s_email_phone"));
assert("Down file also sanitised", resultSpecial.downPath.includes("add_user_s_email_phone"));

// Cleanup
closeDatabase();
try { rmSync("/tmp/tina4-migration-test", { recursive: true }); } catch {}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
