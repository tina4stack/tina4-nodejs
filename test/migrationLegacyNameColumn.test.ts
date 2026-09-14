/**
 * tina4-python #128 parity sweep + a Node-native legacy-column fix it surfaced.
 *
 * ── #128 (the reason for this sweep): NOT a Node bug. ──────────────────────────
 * Python's v2 recorded the migration identifier straight from os.listdir, so it
 * carried the ".sql"/".py" extension while migrate() compares against the file
 * STEM (no extension) — they never matched and the whole history replayed. Node
 * has no such v2 era: its only legacy tracking shape is an OLD v3 (<= 3.13.54)
 * `name`/`applied_at` table, and that old v3 recorded the STEM
 * (file.replace(/\.sql$/, "")) into `name`. upgradeMigrationTable() copies
 * `migration_name = name` (stem -> stem) and migrate() compares the stem, so they
 * MATCH and nothing replays. `test_128_*` proves that: no extension-stripping fix
 * is needed or added.
 *
 * ── The bug this sweep DID surface (fixed here): NOT NULL `name` wedge. ─────────
 * The real pre-3.13.55 DDL is `name VARCHAR(500) NOT NULL`. upgradeMigrationTable()
 * adds the canonical columns beside it but leaves `name` in place (SQLite cannot
 * drop a NOT NULL column without a rebuild). recordApplied() only backfilled the
 * python#93 legacy `migration_id` column — it never populated `name`, so the FIRST
 * new migration recorded after the upgrade failed with
 * "NOT NULL constraint failed: tina4_migration.name" and migrate() stopped,
 * wedging every migration on that database. This is the Node-native twin of
 * python#93; the fix mirrors that column's handling for `name`.
 *
 * Real SQLite via node:sqlite — no mocks.
 * Run with: npx tsx test/migrationLegacyNameColumn.test.ts
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

const root = join(tmpdir(), `tina4_legacyname_${process.pid}_${Math.floor(Date.now() / 1000)}`);
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

/**
 * Recreate the EXACT old-v3 (<= 3.13.54) tracking table: `name`/`applied_at`,
 * `name VARCHAR(500) NOT NULL` (no migration_name/description/passed/batch-canonical).
 * This is what an upgrading Node app actually carries on disk.
 */
async function legacyEnv() {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "migrations"), { recursive: true });
  await initDatabase({ url: `sqlite:///${join(root, "app.db")}` });
  const db = getAdapter();
  await db.execute(`
    CREATE TABLE tina4_migration (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(500) NOT NULL,
      batch INTEGER NOT NULL DEFAULT 1,
      applied_at VARCHAR(50) NOT NULL DEFAULT 'legacy'
    )
  `);
  return db;
}

console.log("migrationLegacyNameColumn (#128 no-replay + NOT NULL name wedge, real SQLite)");

// ── #128 POSITIVE: an old-v3 name history is seen as APPLIED and does NOT replay.
//    Non-idempotent migration, so a replay would fail LOUDLY (mirrors Python's
//    test_v2_filenames_do_not_replay_on_upgrade). Proves Node is NOT affected by #128.
await test("test_128_old_v3_name_history_does_not_replay", async () => {
  const db = await legacyEnv();

  // The app already ran this in the old-v3 era: schema + data exist.
  await db.execute("CREATE TABLE checklist_item_group (group_name TEXT UNIQUE)");
  await db.execute("INSERT INTO checklist_item_group (group_name) VALUES ('window_&_entrance')");

  // Old v3 recorded the STEM (no extension) in `name` — the real value it wrote.
  await db.execute(
    "INSERT INTO tina4_migration (name, batch, applied_at) VALUES (?, 1, 'legacy')",
    ["0000002_data_migration_for_show_room"],
  );

  // Non-idempotent on-disk migration: a replay violates the UNIQUE and fails loudly.
  writeFileSync(
    join(root, "migrations", "0000002_data_migration_for_show_room.sql"),
    "INSERT INTO checklist_item_group (group_name) VALUES ('window_&_entrance');",
  );

  const result = await migrate(db, { migrationsDir: join(root, "migrations") });

  assert.deepStrictEqual(result.applied, [], `must NOT re-apply, got ${JSON.stringify(result.applied)}`);
  assert.deepStrictEqual(result.failed, [], `no replay attempt, so nothing fails, got ${JSON.stringify(result.failed)}`);
  assert.ok(
    result.skipped.includes("0000002_data_migration_for_show_room.sql"),
    "the legacy migration must be recognised as already applied (skipped)",
  );
  const row: any = db.fetchOne("SELECT COUNT(*) AS c FROM checklist_item_group");
  assert.strictEqual(Number(row.c), 1, "exactly one row — the migration did not replay");
  const mig: any = db.fetchOne("SELECT migration_name, passed FROM tina4_migration");
  assert.strictEqual(mig.migration_name, "0000002_data_migration_for_show_room", "legacy name copied verbatim (stem -> stem)");
  assert.strictEqual(Number(mig.passed), 1);

  await closeDatabase();
});

// ── NEGATIVE / the fix: a genuinely-unapplied migration STILL runs after the
//    upgrade — it must NOT die on the legacy `name` NOT NULL column. (RED before
//    the recordApplied() fix: "NOT NULL constraint failed: tina4_migration.name".)
await test("new_migration_applies_on_upgraded_legacy_name_table", async () => {
  const db = await legacyEnv();

  // Legacy history: 000001 already applied (stem in `name`), schema present.
  await db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY)");
  await db.execute("INSERT INTO tina4_migration (name, batch, applied_at) VALUES (?, 1, 'legacy')", ["000001_create_users"]);
  writeFileSync(join(root, "migrations", "000001_create_users.sql"), "CREATE TABLE users (id INTEGER PRIMARY KEY);");

  // A NEW migration added after the upgrade — never recorded, must apply.
  writeFileSync(join(root, "migrations", "000002_create_orders.sql"), "CREATE TABLE orders (id INTEGER PRIMARY KEY);");

  const result = await migrate(db, { migrationsDir: join(root, "migrations") });

  assert.deepStrictEqual(result.applied, ["000002_create_orders.sql"], `only the new migration runs, got applied=${JSON.stringify(result.applied)} failed=${JSON.stringify(result.failed)}`);
  assert.deepStrictEqual(result.failed, [], `the new migration must not die on the NOT NULL name column, got ${JSON.stringify(result.failed)}`);
  assert.ok(result.skipped.includes("000001_create_users.sql"), "the legacy migration stays skipped, not replayed");
  assert.ok(db.tableExists("orders"), "the new migration's DDL must have run");

  // The new bookkeeping row must populate BOTH the canonical migration_name AND the
  // legacy NOT NULL `name`, mirroring the python#93 migration_id handling.
  const row: any = db.fetchOne("SELECT migration_name, name, passed FROM tina4_migration WHERE migration_name = '000002_create_orders'");
  assert.ok(row, "a bookkeeping row for the new migration must exist");
  assert.strictEqual(row.migration_name, "000002_create_orders");
  assert.strictEqual(row.name, "000002_create_orders", "the legacy NOT NULL `name` column must be populated, mirroring migration_name");
  assert.strictEqual(Number(row.passed), 1);

  await closeDatabase();
});

// ── CONTROL: a fresh canonical table has no `name` column and must never grow one
//    (guards the fix against over-reach — the insert stays canonical-only).
await test("fresh_canonical_table_never_grows_a_name_column", async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "migrations"), { recursive: true });
  await initDatabase({ url: `sqlite:///${join(root, "app.db")}` });
  const db = getAdapter();
  writeFileSync(join(root, "migrations", "000009_seed.sql"), "CREATE TABLE seed_marker (id INTEGER);");

  const result = await migrate(db, { migrationsDir: join(root, "migrations") });

  assert.deepStrictEqual(result.applied, ["000009_seed.sql"]);
  const cols = db.getColumns("tina4_migration").map((c: any) => String(c.name).toLowerCase());
  assert.ok(!cols.includes("name"), "a fresh v3 table must never grow the legacy `name` column");
  const row: any = db.fetchOne("SELECT migration_name FROM tina4_migration");
  assert.strictEqual(row.migration_name, "000009_seed", "recorded identifier is the stem — no .sql extension ever stored");

  await closeDatabase();
});

rmSync(root, { recursive: true, force: true });
console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
