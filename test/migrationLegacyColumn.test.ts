/**
 * tina4-python#93 parity: bookkeeping insert must populate a legacy NOT NULL column.
 *
 * A tina4_migration table created by tina4-python v3 <= 3.13.54 carries
 * `migration_id NOT NULL UNIQUE`. Node never created that column, so this is only
 * reachable when a Node app is pointed at a database whose tracking table came
 * from tina4-python. If the insert omits that column, every migration on that
 * database dies on a not-null violation and none can ever apply.
 *
 * Scope, stated honestly: only the BOTH-columns shape is exercised. A table with
 * `migration_id` and NO `migration_name` is unreachable from Node - Node has no
 * python-legacy rename path (its applied-read selects migration_name, so such a
 * table fails on the READ, before bookkeeping). That rename path is a separate
 * question, not this fix.
 *
 * Real SQLite via node:sqlite - no mocks.
 * Run with: npx tsx test/migrationLegacyColumn.test.ts
 */
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert";
import {
  initDatabase,
  closeDatabase,
  getAdapter,
  migrate,
} from "../packages/orm/src/index.ts";

const root = join(tmpdir(), `tina4_issue93_${process.pid}_${Math.floor(Date.now() / 1000)}`);
let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${(e as Error).message}`);
    failed++;
  }
}

async function freshEnv(legacy: boolean) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "migrations"), { recursive: true });
  writeFileSync(join(root, "migrations", "000001_smoke.sql"), "CREATE TABLE smoke_check (id INTEGER);");
  await initDatabase({ url: `sqlite:///${join(root, "app.db")}` });
  const db = getAdapter();
  if (legacy) {
    // EXACTLY the shape tina4-python v3 <= 3.13.54 left behind, after a newer
    // framework added migration_name beside it (migration_id still NOT NULL).
    await db.execute(`
      CREATE TABLE tina4_migration (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        migration_id VARCHAR(500) NOT NULL UNIQUE,
        description VARCHAR(500),
        batch INTEGER NOT NULL DEFAULT 1,
        executed_at VARCHAR(50) NOT NULL,
        passed INTEGER NOT NULL DEFAULT 1,
        migration_name VARCHAR(500)
      )
    `);
  }
  return db;
}

console.log("migrationLegacyColumn (python#93 parity, real SQLite)");

await test("applies a pending migration and populates the legacy NOT NULL migration_id", async () => {
  const db = await freshEnv(true);
  await migrate(db, { migrationsDir: join(root, "migrations") });

  assert.ok(db.tableExists("smoke_check"), "the migration's own DDL must have run");
  const row: any = db.fetchOne("SELECT migration_name, migration_id, passed FROM tina4_migration");
  assert.ok(row, "a bookkeeping row must exist");
  assert.strictEqual(row.passed, 1);
  assert.strictEqual(
    row.migration_id, row.migration_name,
    "the legacy NOT NULL column must be populated, mirroring migration_name",
  );
  await closeDatabase();
});

await test("does not add migration_id to a fresh canonical table", async () => {
  const db = await freshEnv(false);
  await migrate(db, { migrationsDir: join(root, "migrations") });

  const cols = db.getColumns("tina4_migration").map((c: any) => String(c.name).toLowerCase());
  assert.ok(!cols.includes("migration_id"), "a fresh table must never grow the legacy column");
  const row: any = db.fetchOne("SELECT migration_name FROM tina4_migration");
  assert.ok(row?.migration_name, "the canonical row must still be written");
  await closeDatabase();
});

rmSync(root, { recursive: true, force: true });
console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
