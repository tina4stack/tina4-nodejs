/**
 * Lock-in tests for the `tina4_migration.passed` bookkeeping column (issues
 * #129 / #172). NO MOCKS — real node:sqlite via a real SQLiteAdapter throughout,
 * exactly as migration.test.ts / migrationFootguns.test.ts build it.
 *
 * The canonical v3 tracking table is identical across all four frameworks:
 *   id, migration_name VARCHAR(500) NOT NULL UNIQUE, description VARCHAR(500),
 *   batch INTEGER NOT NULL DEFAULT 1, executed_at VARCHAR(50) NOT NULL,
 *   passed INTEGER NOT NULL DEFAULT 1
 * A migration is "applied" IFF a row exists for it with `passed = 1`. migrate()
 * writes ONLY passed=1 rows, delete-before-insert (it DELETEs any existing row
 * for the migration_name before the fresh passed=1 INSERT); the public
 * recordMigration(name,batch,passed) can write passed=0, and any passed=0 row is
 * treated as NOT applied - so a leftover passed=0 row re-applies CLEANLY on the
 * next migrate() (the stale row is superseded, never colliding on the UNIQUE
 * migration_name). The table holds at most one row per migration_name.
 *
 * Run with: npx tsx test/migrationPassedColumn.test.ts
 */
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  initDatabase,
  closeDatabase,
  getAdapter,
  ensureMigrationTable,
  recordMigration,
  isMigrationApplied,
  getAppliedMigrations,
  migrate,
  status,
  adapterExecute,
  adapterQuery,
  adapterColumns,
} from "../packages/orm/src/index.ts";

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

const CANONICAL = ["id", "migration_name", "description", "batch", "executed_at", "passed"];

console.log("=== tina4_migration `passed` Column Lock-in Tests (#129/#172) ===\n");

// ── (1) a fresh v3 tracking table carries the canonical `passed` column ──────
console.log("--- [1] fresh v3 table has the `passed` column ---");
{
  const TMP = "/tmp/tina4-mig-passed-fresh";
  try { rmSync(TMP, { recursive: true }); } catch { /* fresh */ }
  mkdirSync(TMP, { recursive: true });

  await initDatabase({ type: "sqlite", path: join(TMP, "test.db") });
  const db = getAdapter();

  await ensureMigrationTable();
  assert("tracking table created on a fresh adapter", (db as any).tableExists("tina4_migration"));

  const cols = new Set(
    (await adapterColumns(db, "tina4_migration")).map((c) => c.name.toLowerCase()),
  );
  assert("fresh table has the `passed` column", cols.has("passed"), JSON.stringify([...cols]));
  for (const c of CANONICAL) {
    assert(`fresh table has canonical column '${c}'`, cols.has(c), JSON.stringify([...cols]));
  }
  // Negative: the column set is EXACTLY the canonical six (no stray legacy cols).
  assert(
    "column set is exactly the canonical six",
    cols.size === CANONICAL.length && CANONICAL.every((c) => cols.has(c)),
    JSON.stringify([...cols]),
  );

  closeDatabase();
  try { rmSync(TMP, { recursive: true }); } catch { /* ignore */ }
}

// ── (2) an applied migration is recorded passed=1 and is NOT re-run ─────────
console.log("\n--- [2] applied migration -> passed=1, second migrate skips it ---");
{
  const TMP = "/tmp/tina4-mig-passed-applied";
  const MIGS = join(TMP, "migrations");
  try { rmSync(TMP, { recursive: true }); } catch { /* fresh */ }
  mkdirSync(MIGS, { recursive: true });
  writeFileSync(join(MIGS, "000001_widgets.sql"), "CREATE TABLE pc_widgets (id INTEGER PRIMARY KEY, name TEXT);");

  await initDatabase({ type: "sqlite", path: join(TMP, "test.db") });
  const db = getAdapter();

  const r1 = await migrate(db, { migrationsDir: MIGS });
  assert("first migrate applies the file", r1.applied.includes("000001_widgets.sql"), JSON.stringify(r1));
  assert("no failures on first migrate", r1.failed.length === 0, JSON.stringify(r1));
  assert("migration body ran (table created)", (db as any).tableExists("pc_widgets"));

  const rows = await adapterQuery<{ migration_name: string; passed: number }>(
    db,
    `SELECT migration_name, passed FROM "tina4_migration" WHERE migration_name = ?`,
    ["000001_widgets"],
  );
  assert("exactly one tracking row for the migration", rows.length === 1, JSON.stringify(rows));
  assert("the applied migration is recorded passed = 1", Number(rows[0]?.passed) === 1, JSON.stringify(rows));
  assert("isMigrationApplied() is true for the passed=1 migration", await isMigrationApplied("000001_widgets"));

  // Second run: nothing new applied, the file is skipped, the table survives.
  const r2 = await migrate(db, { migrationsDir: MIGS });
  assert("second migrate applies nothing", r2.applied.length === 0, JSON.stringify(r2));
  assert("second migrate skips the already-applied file", r2.skipped.includes("000001_widgets.sql"), JSON.stringify(r2));
  assert("second migrate has no failures", r2.failed.length === 0, JSON.stringify(r2));
  assert("the created table still exists after the re-run", (db as any).tableExists("pc_widgets"));

  closeDatabase();
  try { rmSync(TMP, { recursive: true }); } catch { /* ignore */ }
}

// ── (3) a passed=0 row is pending, then migrate() re-applies it cleanly ──────
//
// POSITIVE (#172 lock): "applied" == a row with passed=1, so a passed=0 row is
// PENDING - getAppliedMigrations() (WHERE passed=1) must NOT contain it and
// status().pending MUST contain its file. (A passed=1 row is the contrast.)
//
// RE-RUNNABLE (fix "(b)", tina4-php#129 / #172; verified against real
// node:sqlite): re-running migrate() while a leftover passed=0 row exists for
// the SAME migration_name now APPLIES the migration cleanly. The success path
// DELETEs any existing row for the migration_name before the fresh passed=1
// INSERT (recordApplied()), so the stale passed=0 row is SUPERSEDED instead of
// colliding on the UNIQUE migration_name (that collision used to wedge a
// previously-failed migration). Identical to the Python master's _record_applied()
// design. The framework source is not modified by this test.
console.log("\n--- [3] passed=0 row is pending, then migrate() re-applies it cleanly ---");
{
  const TMP = "/tmp/tina4-mig-passed-zero";
  const MIGS = join(TMP, "migrations");
  try { rmSync(TMP, { recursive: true }); } catch { /* fresh */ }
  mkdirSync(MIGS, { recursive: true });
  writeFileSync(join(MIGS, "000001_pending.sql"), "CREATE TABLE pc_pending (id INTEGER PRIMARY KEY, label TEXT);");

  await initDatabase({ type: "sqlite", path: join(TMP, "test.db") });
  const db = getAdapter();

  // Fresh canonical table, then write a passed=0 row for the on-disk migration
  // AND a passed=1 row for an unrelated migration (recordMigration uses the
  // global/bound adapter - the same one initDatabase() just bound).
  await ensureMigrationTable();
  await recordMigration("000001_pending", 1, 0); // failed/incomplete -> passed=0
  await recordMigration("000000_done", 1, 1);    // succeeded          -> passed=1

  // POSITIVE: passed=0 is NOT applied and IS pending; passed=1 IS applied.
  assert("isMigrationApplied() is FALSE for the passed=0 row", (await isMigrationApplied("000001_pending")) === false);
  assert("isMigrationApplied() is TRUE for the passed=1 row", await isMigrationApplied("000000_done"));

  const appliedNames = (await getAppliedMigrations()).map((m) => m.migration_name);
  assert("getAppliedMigrations() EXCLUDES the passed=0 migration", !appliedNames.includes("000001_pending"), JSON.stringify(appliedNames));
  assert("getAppliedMigrations() INCLUDES the passed=1 migration", appliedNames.includes("000000_done"), JSON.stringify(appliedNames));

  const st = await status(db, { migrationsDir: MIGS });
  assert("status().pending CONTAINS the passed=0 migration's file", st.pending.includes("000001_pending.sql"), JSON.stringify(st));
  assert("status().completed does NOT contain the passed=0 migration's file", !st.completed.includes("000001_pending.sql"), JSON.stringify(st));

  // RE-RUNNABLE ("(b)"): migrate() over the leftover passed=0 row now applies
  // the migration cleanly - the success path DELETEs the stale row for this
  // migration_name before the passed=1 INSERT, so there is no UNIQUE collision.
  const r = await migrate(db, { migrationsDir: MIGS });
  assert("migrate() re-applies the previously-failed migration cleanly", r.applied.includes("000001_pending.sql"), JSON.stringify(r));
  assert("migrate() reports no failures on the clean re-run", r.failed.length === 0, JSON.stringify(r));
  assert("migrate() created the migration's table on the re-run", (db as any).tableExists("pc_pending"));

  // The stale passed=0 row is superseded: exactly ONE row remains for this
  // migration_name, now passed=1 (delete-before-insert holds the invariant).
  const pendingRows = await adapterQuery<{ passed: number }>(
    db,
    `SELECT passed FROM "tina4_migration" WHERE migration_name = ?`,
    ["000001_pending"],
  );
  assert("exactly one tracking row remains for the name (stale passed=0 superseded)", pendingRows.length === 1, JSON.stringify(pendingRows));
  assert("that single row is now passed = 1", Number(pendingRows[0]?.passed) === 1, JSON.stringify(pendingRows));

  // And it now counts as applied / executed.
  assert("isMigrationApplied() is TRUE after the clean re-run", await isMigrationApplied("000001_pending"));

  closeDatabase();
  try { rmSync(TMP, { recursive: true }); } catch { /* ignore */ }
}

// ── (4) an older-v3 name/applied_at table upgrades in place; applied not re-run
//
// A table created by an older v3 (<= 3.13.54) has `id, name, batch, applied_at`
// and no `migration_name`/`passed`. ensureMigrationTableOn() (via migrate())
// upgrades it in place: it ADDs migration_name/description/passed/executed_at and
// backfills migration_name=name, passed=1, executed_at=applied_at, so a migration
// already recorded in the legacy table stays "applied" and is NOT re-run.
console.log("\n--- [4] older-v3 name/applied_at table upgrades in place; applied not re-run ---");
{
  const TMP = "/tmp/tina4-mig-passed-upgrade";
  const MIGS = join(TMP, "migrations");
  try { rmSync(TMP, { recursive: true }); } catch { /* fresh */ }
  mkdirSync(MIGS, { recursive: true });
  // The on-disk migration whose row we pre-seed as already applied. Its CREATE
  // TABLE (no IF NOT EXISTS) would ERROR "table pc_legacy already exists" if it
  // re-ran — but it must be skipped, so migrate() reports no failure and the
  // effect table is never (re-)created by the runner.
  writeFileSync(join(MIGS, "000001_legacy.sql"), "CREATE TABLE pc_legacy (id INTEGER PRIMARY KEY);");

  await initDatabase({ type: "sqlite", path: join(TMP, "test.db") });
  const db = getAdapter();

  // Hand-build the OLD-v3 shaped tracking table + one already-applied row.
  await adapterExecute(db, `CREATE TABLE "tina4_migration" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(500) NOT NULL,
    batch INTEGER NOT NULL DEFAULT 1,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await adapterExecute(db,
    `INSERT INTO "tina4_migration" (name, batch, applied_at) VALUES (?, ?, ?)`,
    ["000001_legacy", 1, "2026-01-01T00:00:00.000Z"],
  );

  const before = new Set(
    (await adapterColumns(db, "tina4_migration")).map((c) => c.name.toLowerCase()),
  );
  assert("pre-upgrade: legacy `name` column present", before.has("name"), JSON.stringify([...before]));
  assert("pre-upgrade: no `migration_name` column yet", !before.has("migration_name"), JSON.stringify([...before]));
  assert("pre-upgrade: no `passed` column yet", !before.has("passed"), JSON.stringify([...before]));

  // migrate() -> ensureMigrationTableOn() -> upgradeMigrationTable() (in place).
  const r = await migrate(db, { migrationsDir: MIGS });
  assert("upgrade: no error running migrate over the legacy table", r.failed.length === 0, JSON.stringify(r));
  assert("upgrade: already-applied migration is NOT re-applied", !r.applied.includes("000001_legacy.sql"), JSON.stringify(r));
  assert("upgrade: already-applied migration is reported skipped", r.skipped.includes("000001_legacy.sql"), JSON.stringify(r));
  assert("upgrade: legacy migration body did NOT re-execute", !(db as any).tableExists("pc_legacy"));

  const after = new Set(
    (await adapterColumns(db, "tina4_migration")).map((c) => c.name.toLowerCase()),
  );
  assert("upgrade: `migration_name` column added in place", after.has("migration_name"), JSON.stringify([...after]));
  assert("upgrade: `passed` column added in place", after.has("passed"), JSON.stringify([...after]));
  assert("upgrade: legacy `name` column left intact", after.has("name"), JSON.stringify([...after]));

  const rows = await adapterQuery<{ name: string; migration_name: string; passed: number }>(
    db,
    `SELECT name, migration_name, passed FROM "tina4_migration"`,
  );
  assert("upgrade: exactly one row after upgrade", rows.length === 1, JSON.stringify(rows));
  assert("upgrade: migration_name backfilled from name", rows[0]?.migration_name === "000001_legacy", JSON.stringify(rows));
  assert("upgrade: passed backfilled to 1", Number(rows[0]?.passed) === 1, JSON.stringify(rows));
  assert("upgrade: isMigrationApplied() true after in-place upgrade", await isMigrationApplied("000001_legacy"));

  closeDatabase();
  try { rmSync(TMP, { recursive: true }); } catch { /* ignore */ }
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
