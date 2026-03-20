/**
 * Unit tests for the Migration enhancements (Phase 2).
 * Run with: npx tsx test/migration.test.ts
 */
import { rmSync, mkdirSync } from "node:fs";
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
assert("Migration table created", (adapter as any).tableExists("_tina4_migrations"));

// Calling again should be idempotent
ensureMigrationTable();
assert("ensureMigrationTable is idempotent", (adapter as any).tableExists("_tina4_migrations"));

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

// Cleanup
closeDatabase();
try { rmSync("/tmp/tina4-migration-test", { recursive: true }); } catch {}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
