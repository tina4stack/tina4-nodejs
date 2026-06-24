/**
 * Tests for startup auto-migration (autoMigrateOnStartup in server.ts).
 * Run with: npx tsx test/autoMigrate.test.ts
 *
 * Covers the 4 cases:
 *   1. migrations/ dir + .sql files + flag on (default) → pending migrations applied
 *   2. TINA4_AUTO_MIGRATE falsy → skipped (no tables created)
 *   3. no migrations/ dir → silent no-op (never throws)
 *   4. a failing migration → logged, NEVER re-raised (boot continues)
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoMigrateOnStartup } from "../packages/core/src/server.ts";
import { initDatabase, getAdapter, closeDatabase } from "../packages/orm/src/index.ts";

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

/** Make a fresh project base dir with an in-memory-ish sqlite DB bound. */
async function freshProject(): Promise<string> {
  const base = mkdtempSync(join(tmpdir(), "tina4-automig-"));
  // Each test gets its own on-disk sqlite file so adapters don't collide.
  await initDatabase({ url: `sqlite://${join(base, "test.db")}` });
  return base;
}

function writeMigration(base: string, name: string, sql: string): void {
  const dir = join(base, "migrations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), sql, "utf-8");
}

function tableExists(name: string): boolean {
  try {
    return getAdapter().tableExists(name);
  } catch {
    return false;
  }
}

/** The current set of user tables, via the real adapter introspection. */
function listTables(): string[] {
  return (getAdapter() as { tables(): string[] }).tables();
}

/** Run a raw query against the real adapter (used to inspect tina4_migration rows). */
function queryRows<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
  return (getAdapter() as { query<R>(sql: string, params?: unknown[]): R[] }).query<T>(sql, params);
}

console.log("=== Startup Auto-Migration Tests ===\n");

// Clear any inherited flag so the default ("on") path is exercised deterministically.
delete process.env.TINA4_AUTO_MIGRATE;

await (async () => {
  // --- Case 1: dir + .sql + flag on (default) → applied ---
  console.log("--- Case 1: applies pending migrations (default on) ---");
  {
    const base = await freshProject();
    writeMigration(base, "000001_create_widgets.sql",
      "CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT);");
    let threw = false;
    try {
      await autoMigrateOnStartup("migrations", base);
    } catch {
      threw = true;
    }
    assert("did not throw", !threw);
    assert("widgets table created", tableExists("widgets"));
    assert("tracking table created", tableExists("tina4_migration"));
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }

  // --- Case 2: flag off → skipped (no table) ---
  console.log("\n--- Case 2: TINA4_AUTO_MIGRATE off → skipped ---");
  for (const val of ["false", "0", "no", "off"]) {
    const base = await freshProject();
    writeMigration(base, "000001_create_gadgets.sql",
      "CREATE TABLE gadgets (id INTEGER PRIMARY KEY);");
    process.env.TINA4_AUTO_MIGRATE = val;
    await autoMigrateOnStartup("migrations", base);
    assert(`flag="${val}" → gadgets NOT created`, !tableExists("gadgets"));
    delete process.env.TINA4_AUTO_MIGRATE;
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }

  // --- Case 3: no migrations/ dir → genuine no-op (DB untouched) ---
  console.log("\n--- Case 3: no migrations/ dir → genuine no-op ---");
  {
    const base = await freshProject();
    // Snapshot the real table set BEFORE — a fresh sqlite DB has no user tables.
    const tablesBefore = listTables();
    let threw = false;
    try {
      await autoMigrateOnStartup("migrations", base); // dir does not exist
    } catch {
      threw = true;
    }
    assert("no-op did not throw", !threw);
    // Behavioural contract: with no migrations/ dir the runner must do NOTHING —
    // not even bootstrap its own bookkeeping table. A non-throw alone could hide a
    // runner that created tina4_migration (a real side effect) before bailing.
    assert(
      "no-op created NO tracking table",
      !tableExists("tina4_migration"),
      `(tables=${JSON.stringify(listTables())})`,
    );
    // ...and the DB must remain fully usable: the live adapter still introspects,
    // and the table set is byte-for-byte the pre-call set (proves a true no-op, not
    // a partial side effect that happened to leave tina4_migration absent).
    const tablesAfter = listTables();
    assert(
      "DB still usable + table set unchanged",
      JSON.stringify(tablesAfter) === JSON.stringify(tablesBefore),
      `(before=${JSON.stringify(tablesBefore)} after=${JSON.stringify(tablesAfter)})`,
    );
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }

  // --- Case 4: failing migration → logged-and-skipped, NEVER re-raised ---
  console.log("\n--- Case 4: failing migration is non-breaking ---");
  {
    const base = await freshProject();
    // A two-statement file: a valid CREATE followed by invalid SQL. The whole file
    // runs in one per-file transaction, so the failure on statement 2 must roll the
    // file back as a unit.
    writeMigration(base, "000001_broken.sql",
      "CREATE TABLE oops (id INTEGER PRIMARY KEY); THIS IS NOT VALID SQL;");
    let threw = false;
    try {
      await autoMigrateOnStartup("migrations", base);
    } catch {
      threw = true;
    }
    // Resilience contract #1: a bad migration must NEVER take boot down.
    assert("failing migration did NOT throw out of startup hook", !threw);

    // Resilience contract #2: the runner DID engage — it bootstrapped its tracking
    // table before applying files — so this is genuine "logged and skipped", not
    // "bailed before touching the DB" (which Case 3 already covers).
    assert(
      "tracking table was created (runner engaged)",
      tableExists("tina4_migration"),
      `(tables=${JSON.stringify(listTables())})`,
    );

    // Resilience contract #3: a FAILED file is NEVER recorded as applied — no row
    // with its name — so a fixed file re-runs on the next boot (idempotent retry).
    const brokenRows = queryRows<{ name: string }>(
      'SELECT name FROM "tina4_migration" WHERE name = ?',
      ["000001_broken"],
    );
    assert(
      "broken migration was NOT recorded as applied",
      brokenRows.length === 0,
      `(rows=${JSON.stringify(brokenRows)})`,
    );

    // Resilience contract #4: per-file transactional rollback — the partial 'oops'
    // CREATE from statement 1 is rolled back when statement 2 fails, so the schema
    // is NOT left silently half-applied.
    assert(
      "partial 'oops' table rolled back (not half-applied)",
      !tableExists("oops"),
      `(tables=${JSON.stringify(listTables())})`,
    );
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
})();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
