/**
 * Real-PostgreSQL regression test for the migration tracking-table DDL bug.
 *
 * The migration runner's tracking-table creator used to emit SQLite-specific
 * DDL (`id INTEGER PRIMARY KEY AUTOINCREMENT`) for every non-Firebird engine,
 * AND mis-identified the Postgres adapter as Firebird (a duck-type check that
 * matched every async adapter). On PostgreSQL the result was a hard failure on
 * the FIRST migration — `syntax error at or near "AUTOINCREMENT"` /
 * `CREATE GENERATOR` syntax error / aborted transaction — so migrations were
 * unusable on PG. This test runs the real `migrate()` runner against a live
 * PostgreSQL and asserts it now succeeds with an engine-aware SERIAL tracking
 * table.
 *
 * NO MOCKS: this hits a real PostgreSQL server (no stub/fake adapter). It is
 * gated on TCP reachability — when PG is unreachable it SKIPS cleanly and
 * prints the count line the runner expects, exactly like postgresUuidPk.test.ts.
 *
 * Live infra: localhost:55432, user/pass tina4/tina4, database tina4_node.
 * Override via TINA4_TEST_PG_HOST / _PORT / _USER / _PASS / _DB.
 *
 * Run with:
 *   TINA4_TEST_PG_PORT=55432 TINA4_TEST_PG_USERNAME=tina4 TINA4_TEST_PG_PASSWORD=tina4 \
 *   TINA4_TEST_PG_DB=tina4_node npx tsx test/migrationPostgres.test.ts
 */
import net from "node:net";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "localhost";
const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "55432", 10);
const PG_USER = process.env.TINA4_TEST_PG_USERNAME ?? "tina4";
const PG_PASS = process.env.TINA4_TEST_PG_PASSWORD ?? "tina4";
const PG_DB = process.env.TINA4_TEST_PG_DB ?? "tina4_node";

const MIGRATION_TABLE = "tina4_migration";
const WIDGET_TABLE = "mig_node_widget";

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

function skipClean(msg: string): never {
  console.log(`  \x1b[33mSKIP\x1b[0m ${msg}`);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m0 passed\x1b[0m, \x1b[31m0 failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(0);
}

function pgReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    socket.connect(PG_PORT, PG_HOST, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

console.log("=== Migration runner on real PostgreSQL (AUTOINCREMENT bug) ===\n");

if (!(await pgReachable())) {
  skipClean(`PostgreSQL not reachable at ${PG_HOST}:${PG_PORT} — skipping`);
}

// Load the real pg-backed adapter; skip cleanly if pg isn't available at all.
let PostgresAdapter: any = null;
try {
  ({ PostgresAdapter } = await import("../packages/orm/src/adapters/postgres.ts"));
} catch (err) {
  skipClean(`Could not load PostgresAdapter: ${(err as Error).message}`);
}
try {
  await import("pg");
} catch {
  skipClean("'pg' package not installed — npm install pg");
}

const { migrate } = await import("../packages/orm/src/migration.ts");

// Build the adapter through the REAL initDatabase() path. initDatabase wraps
// every adapter in CachedDatabaseAdapter (the global a running app uses), so
// migrate()'s engine detection sees constructor.name === "CachedDatabaseAdapter"
// and MUST unwrap it. An earlier version of this test used `new PostgresAdapter`
// directly (an UNWRAPPED adapter) and so never exercised the wrapper — which is
// exactly how the wrapper-misdetection bug (PG mis-read as SQLite -> AUTOINCREMENT)
// shipped. Using initDatabase here is the regression guard.
const { initDatabase, getAdapter } = await import("../packages/orm/src/database.ts");
await initDatabase({
  url: `postgresql://${PG_HOST}:${PG_PORT}/${PG_DB}`,
  user: PG_USER,
  password: PG_PASS,
});
const db: any = getAdapter();
assert(
  "adapter is the wrapped CachedDatabaseAdapter (real initDatabase path)",
  db.constructor.name === "CachedDatabaseAdapter",
  `got ${db.constructor.name}`,
);

const TMP = "/tmp/tina4-migration-pg-test";
const MIGS = join(TMP, "migrations");

try {
  // DROP both tables first so the CREATE path (the path that used to throw
  // AUTOINCREMENT) actually runs from scratch.
  await db.executeAsync(`DROP TABLE IF EXISTS "${MIGRATION_TABLE}"`);
  await db.executeAsync(`DROP TABLE IF EXISTS ${WIDGET_TABLE}`);

  try { rmSync(TMP, { recursive: true }); } catch { /* fresh */ }
  mkdirSync(MIGS, { recursive: true });

  // A real migration: CREATE the widget table + seed one row.
  writeFileSync(
    join(MIGS, "000001_widget.sql"),
    `CREATE TABLE ${WIDGET_TABLE} (id SERIAL PRIMARY KEY, name VARCHAR(50));\n` +
      `INSERT INTO ${WIDGET_TABLE} (name) VALUES ('widget-one');`,
  );

  // Run the migration runner — the path that used to die on AUTOINCREMENT.
  const result = await migrate(db, { migrationsDir: MIGS });

  assert(
    "migrate() applied the migration (no AUTOINCREMENT syntax error)",
    result.applied.includes("000001_widget.sql"),
    JSON.stringify(result),
  );
  assert(
    "migrate() reported NO failures",
    result.failed.length === 0,
    JSON.stringify(result),
  );

  // Tracking table exists.
  const trackingExists = await db.tableExistsAsync(MIGRATION_TABLE);
  assert("tracking table tina4_migration exists", trackingExists === true);

  // Widget table exists.
  const widgetExists = await db.tableExistsAsync(WIDGET_TABLE);
  assert(`migrated table ${WIDGET_TABLE} exists`, widgetExists === true);

  // Seeded row is readable.
  const widgetRows = await db.queryAsync<{ id: number; name: string }>(
    `SELECT id, name FROM ${WIDGET_TABLE} ORDER BY id`,
  );
  assert(
    "seeded widget row is readable",
    widgetRows.length === 1 && widgetRows[0]?.name === "widget-one",
    JSON.stringify(widgetRows),
  );

  // A tracking row was recorded with an auto-assigned id (SERIAL).
  const trackRows = await db.queryAsync<{ id: number; migration_name: string; batch: number }>(
    `SELECT id, migration_name, batch FROM "${MIGRATION_TABLE}" ORDER BY id`,
  );
  assert(
    "exactly one tracking row recorded",
    trackRows.length === 1,
    JSON.stringify(trackRows),
  );
  assert(
    "tracking row migration_name matches the migration",
    trackRows[0]?.migration_name === "000001_widget",
    JSON.stringify(trackRows),
  );
  assert(
    "tracking row got an auto-assigned id (SERIAL PK)",
    typeof trackRows[0]?.id === "number" && Number(trackRows[0]?.id) >= 1,
    JSON.stringify(trackRows),
  );

  // The tracking id column is an engine-aware auto-increment (Postgres SERIAL
  // → DEFAULT nextval(...)), proving the SQLite AUTOINCREMENT DDL is gone.
  const cols = await db.columnsAsync(MIGRATION_TABLE);
  const idCol = cols.find((c: any) => c.name === "id");
  assert(
    "tracking id column is SERIAL (DEFAULT nextval) — not SQLite AUTOINCREMENT",
    !!idCol && typeof idCol.default === "string" && idCol.default.includes("nextval"),
    JSON.stringify(idCol),
  );

  // Re-run is idempotent: the already-applied migration is skipped, not re-run.
  const rerun = await migrate(db, { migrationsDir: MIGS });
  assert(
    "re-run skips the already-applied migration",
    rerun.skipped.includes("000001_widget.sql") && rerun.applied.length === 0,
    JSON.stringify(rerun),
  );
} finally {
  // Clean up both tables + temp dir.
  try { await db.executeAsync(`DROP TABLE IF EXISTS "${MIGRATION_TABLE}"`); } catch { /* ignore */ }
  try { await db.executeAsync(`DROP TABLE IF EXISTS ${WIDGET_TABLE}`); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  try { rmSync(TMP, { recursive: true }); } catch { /* ignore */ }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
