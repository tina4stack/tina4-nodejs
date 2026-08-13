/**
 * Shared migration contract -- feature 15 (OWNER-DECISIONS.md Batch 4,
 * feature doc 015-migrations.md, MIG-DEC-01/02/03). Real engines only
 * (SQLite, PostgreSQL, MySQL, MSSQL, Firebird 5) -- no mocks, no fakes. The
 * SAME case names are proven in all four frameworks; the shared fixture is
 * tina4-documentation/plan/v3/fixtures/migrations_contract.json.
 *
 * MIG-DEC-01 (MIG-NODE-CLI-DIVERGENT): the CLI `tina4 migrate`
 * (packages/cli/src/commands/migrate.ts) used to be a SECOND, weaker
 * migration implementation -- naive `sql.split(";")`, no per-file
 * transaction, no Firebird/MSSQL idempotency skips, ledger recorded outside
 * any transaction. It now delegates to the SAME migrate() the ORM uses.
 * cli_and_orm_paths_identical proves the CLI path now gets the transactional,
 * robust-split, idempotent behaviour -- a `;` inside a string literal (which
 * the OLD naive split broke on) survives through the CLI the same way it
 * does through the ORM call.
 *
 * MIG-DEC-02: rollback() used to log a warning/error for a missing/failed
 * down artifact and STILL unconditionally remove the tracking record
 * (outside any transaction). It now RAISES (the delete moved INSIDE the same
 * transaction as the down statements), mirroring the Python reference model.
 * failed_or_missing_down_does_not_drop_ledger proves the row survives.
 *
 * MIG-DEC-03: firebird_mssql_create_add_idempotency_real replaces
 * migrationFootguns.test.ts's fake MssqlAdapter/FirebirdAdapter classes
 * (constructor.name spoofed to satisfy engineOf()'s dialect detection --
 * MIG-FBMSSQL-MOCK) with REAL Firebird 5 / REAL MSSQL, modelled on
 * tina4-php's MigrationFootgunsLiveEngineTest ("NO DOUBLES").
 *
 * migrate_status_prints_without_crashing drives the REAL CLI command
 * function (packages/cli/src/commands/migrateStatus.ts) in-process, the SAME
 * pattern test/migrateCli.test.ts already uses for `migrate` -- Node's
 * migrate:status was NOT flagged broken by the audit (only Python + PHP
 * were), so this is a NEW regression lock on already-correct behaviour, not
 * a fix.
 *
 * Run with: npx tsx test/migrationContract.test.ts
 *
 * Env contract (identical to the write-path/pgprovider/mysqlprovider/
 * mssqlprovider/firebirdprovider runners): TINA4_TEST_PG_HOST/_PORT/_USERNAME/
 * _PASSWORD/_DB (default 127.0.0.1:55432, tina4/tina4); TINA4_TEST_MYSQL_HOST/
 * _PORT/_USERNAME/_PASSWORD/_DB (default 127.0.0.1:3306, tina4/tina4);
 * TINA4_TEST_MSSQL_HOST/_PORT/_USERNAME/_PASSWORD/_DB (default 127.0.0.1:1433,
 * sa/TinaSQL123!Secure); TINA4_TEST_FIREBIRD_URL (a live Firebird 5 URL; unset
 * means the Firebird cases skip locally -- the lab gate's own preflight FATALs
 * if it is unreachable there, a skipped required engine is a ghost).
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import process from "node:process";
import {
  initDatabase,
  closeDatabase,
  getAdapter,
  setAdapter,
  createAdapterFromUrl,
  migrate,
  rollback,
  ensureMigrationTable,
  shouldSkipCreateTable,
  shouldSkipForFirebird,
  adapterExecute,
  adapterQuery,
  adapterTableExists,
} from "../packages/orm/src/index.js";
import type { DatabaseAdapter } from "../packages/orm/src/index.js";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

/** Capture console.log emitted while fn runs (mirrors test/cli.test.ts's captureLog). */
async function captureLog(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  let buf = "";
  console.log = (...a: unknown[]) => { buf += a.map(String).join(" ") + "\n"; };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return buf;
}

function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((res) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => { socket.destroy(); res(ok); };
    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "127.0.0.1";
const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "55432", 10);
const PG_USER = process.env.TINA4_TEST_PG_USERNAME ?? "tina4";
const PG_PASS = process.env.TINA4_TEST_PG_PASSWORD ?? "tina4";
const PG_DB = process.env.TINA4_TEST_PG_DB ?? "tina4_node";

const MYSQL_HOST = process.env.TINA4_TEST_MYSQL_HOST ?? "127.0.0.1";
const MYSQL_PORT = parseInt(process.env.TINA4_TEST_MYSQL_PORT ?? "3306", 10);
const MYSQL_USER = process.env.TINA4_TEST_MYSQL_USERNAME ?? "tina4";
const MYSQL_PASS = process.env.TINA4_TEST_MYSQL_PASSWORD ?? "tina4";
const MYSQL_DB = process.env.TINA4_TEST_MYSQL_DB ?? "tina4_test";

const MSSQL_HOST = process.env.TINA4_TEST_MSSQL_HOST ?? "127.0.0.1";
const MSSQL_PORT = parseInt(process.env.TINA4_TEST_MSSQL_PORT ?? "1433", 10);
const MSSQL_USER = process.env.TINA4_TEST_MSSQL_USERNAME ?? "sa";
const MSSQL_PASS = process.env.TINA4_TEST_MSSQL_PASSWORD ?? "TinaSQL123!Secure";
const MSSQL_DB = process.env.TINA4_TEST_MSSQL_DB ?? "tina4_test";

const FIREBIRD_URL = process.env.TINA4_TEST_FIREBIRD_URL ?? "";

async function withAdapter<T>(url: string, fn: (db: DatabaseAdapter) => Promise<T>): Promise<T> {
  const adapter = await createAdapterFromUrl(url);
  let prior: DatabaseAdapter | null = null;
  try {
    prior = getAdapter();
  } catch {
    // No adapter configured yet (first call in the process) -- nothing to restore.
  }
  setAdapter(adapter);
  try {
    return await fn(adapter);
  } finally {
    if (prior) setAdapter(prior);
    try {
      closeDatabase();
    } catch {
      // best-effort close
    }
  }
}

/**
 * Best-effort delete of a stale tina4_migration row. On a genuinely fresh
 * database/engine the tracking table itself may not exist yet (nothing has
 * called migrate() there before) -- that is not a real failure, just nothing
 * to clean up.
 */
async function cleanLedgerRow(db: DatabaseAdapter, migrationName: string): Promise<void> {
  try {
    await adapterExecute(db, `DELETE FROM tina4_migration WHERE migration_name = ?`, [migrationName]);
  } catch {
    // table doesn't exist yet -- nothing to clean up
  }
}

function tmpMigDir(label: string): string {
  const dir = resolve(tmpdir(), `tina4_mig_contract_${label}_${process.pid}_${Date.now()}`);
  mkdirSync(join(dir, "migrations"), { recursive: true });
  return dir;
}

console.log("=== Migration Contract Tests (feature 15) ===\n");

async function run(): Promise<void> {
  // ── ledger-row-commits-atomically-with-ddl ─────────────────────────────
  console.log("--- ledger_row_commits_atomically_with_ddl ---");

  {
    const projectDir = tmpMigDir("ledger_sqlite");
    try {
      writeFileSync(
        join(projectDir, "migrations", "000001_create_widgets.sql"),
        "CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT);",
      );
      await withAdapter(`sqlite:///${join(projectDir, "ledger.db")}`, async (db) => {
        const result = await migrate(db, { migrationsDir: join(projectDir, "migrations") });
        check("SQLite: migration applied", result.applied.length === 1, JSON.stringify(result));
        check("SQLite: DDL applied", await adapterTableExists(db, "widgets"));
        const rows = await adapterQuery<{ migration_name: string; batch: number }>(
          db, `SELECT migration_name, batch FROM "tina4_migration" WHERE migration_name = ?`,
          ["000001_create_widgets"],
        );
        check("SQLite: ledger row written alongside the DDL", rows.length === 1, JSON.stringify(rows));
        check("SQLite: ledger row batch is 1", rows[0]?.batch === 1);
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }

  if (await tcpReachable(MYSQL_HOST, MYSQL_PORT)) {
    const projectDir = tmpMigDir("ledger_mysql");
    const table = "mig_node_mysql_atomic";
    const name = "000001_mysql_atomic";
    try {
      await withAdapter(`mysql://${MYSQL_USER}:${MYSQL_PASS}@${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DB}`, async (db) => {
        await adapterExecute(db, `DROP TABLE IF EXISTS ${table}`);
        await cleanLedgerRow(db, name);

        writeFileSync(
          join(projectDir, "migrations", `${name}.sql`),
          `CREATE TABLE ${table} (id INT PRIMARY KEY);\nTHIS IS NOT VALID SQL;`,
        );
        const result = await migrate(db, { migrationsDir: join(projectDir, "migrations") });
        check("MySQL: migration recorded as failed", result.failed.includes(`${name}.sql`), JSON.stringify(result));
        check("MySQL: DDL auto-committed (precondition)", await adapterTableExists(db, table));
        const rows = await adapterQuery<{ x: number }>(
          db, `SELECT 1 as x FROM tina4_migration WHERE migration_name = ?`, [name],
        );
        check(
          "MySQL: ledger row never written for a failed migration (even on non-transactional DDL)",
          rows.length === 0,
          JSON.stringify(rows),
        );
        await adapterExecute(db, `DROP TABLE IF EXISTS ${table}`);
        await cleanLedgerRow(db, name);
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  } else {
    console.log(`  \x1b[33mSKIP\x1b[0m MySQL not reachable at ${MYSQL_HOST}:${MYSQL_PORT}`);
  }

  // ── midfile-failure-rolls-back-on-transactional-ddl ────────────────────
  console.log("\n--- midfile_failure_rolls_back_on_transactional_ddl ---");

  if (await tcpReachable(PG_HOST, PG_PORT)) {
    const projectDir = tmpMigDir("midfile_pg");
    const table = "mig_node_pg_midfile";
    const name = "000001_pg_midfile";
    try {
      await withAdapter(`postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}`, async (db) => {
        await adapterExecute(db, `DROP TABLE IF EXISTS ${table}`);
        await cleanLedgerRow(db, name);

        writeFileSync(
          join(projectDir, "migrations", `${name}.sql`),
          `CREATE TABLE ${table} (id SERIAL PRIMARY KEY, name VARCHAR(50));\nTHIS IS NOT VALID SQL;`,
        );
        const result = await migrate(db, { migrationsDir: join(projectDir, "migrations") });
        check("PG: migration recorded as failed", result.failed.includes(`${name}.sql`), JSON.stringify(result));
        check(
          "PG: transactional DDL rolls back the earlier CREATE TABLE in the same failed file",
          !(await adapterTableExists(db, table)),
        );
        const rows = await adapterQuery<{ x: number }>(
          db, `SELECT 1 as x FROM tina4_migration WHERE migration_name = ?`, [name],
        );
        check("PG: no ledger row for a fully-rolled-back file", rows.length === 0);
        await adapterExecute(db, `DROP TABLE IF EXISTS ${table}`);
        await cleanLedgerRow(db, name);
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  } else {
    console.log(`  \x1b[33mSKIP\x1b[0m PostgreSQL not reachable at ${PG_HOST}:${PG_PORT}`);
  }

  {
    // The SQLite analog -- proves CLAUDE.md's corrected "SQLite has
    // transactional DDL" claim, not just PostgreSQL's.
    const projectDir = tmpMigDir("midfile_sqlite");
    try {
      writeFileSync(
        join(projectDir, "migrations", "000001_sqlite_midfile.sql"),
        "CREATE TABLE good (id INTEGER);\nTHIS WILL FAIL;",
      );
      await withAdapter(`sqlite:///${join(projectDir, "midfile.db")}`, async (db) => {
        const result = await migrate(db, { migrationsDir: join(projectDir, "migrations") });
        check("SQLite: migration recorded as failed", result.failed.length === 1, JSON.stringify(result));
        check(
          "SQLite: a multi-statement failure rolls back the DDL too (transactional DDL)",
          !(await adapterTableExists(db, "good")),
        );
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }

  // ── migrate-status-prints-without-crashing ─────────────────────────────
  console.log("\n--- migrate_status_prints_without_crashing ---");

  {
    const projectDir = tmpMigDir("status");
    const dbPath = join(projectDir, "status.db");
    const originalCwd = process.cwd();
    try {
      writeFileSync(
        join(projectDir, "migrations", "000001_create_accounts.sql"),
        "CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT);",
      );
      process.env.TINA4_DATABASE_URL = `sqlite:///${dbPath}`;
      process.chdir(projectDir);

      const orm = await import("../packages/orm/src/index.js");
      (orm as { setAdapter?: (a: unknown) => void }).setAdapter?.(null);
      const { runMigrations } = await import("../packages/cli/src/commands/migrate.js");
      await runMigrations();

      // A SECOND, still-pending migration so status prints BOTH branches --
      // MIG-CLI-STATUS-BROKEN crashed in the equivalent Python/PHP code on
      // EITHER branch once at least one migration existed.
      writeFileSync(
        join(projectDir, "migrations", "000002_add_index.sql"),
        "CREATE INDEX idx_accounts_name ON accounts (name);",
      );

      let threw: Error | null = null;
      let out = "";
      try {
        const { migrateStatus } = await import("../packages/cli/src/commands/migrateStatus.js");
        out = await captureLog(() => migrateStatus(join(projectDir, "migrations")));
      } catch (err) {
        threw = err instanceof Error ? err : new Error(String(err));
      }

      check("migrate:status does not crash", threw === null, threw?.message ?? "");
      check("migrate:status prints Completed section", out.includes("Completed"), out);
      check("migrate:status prints the applied migration", out.includes("000001_create_accounts.sql"), out);
      check("migrate:status prints Pending section", out.includes("Pending"), out);
      check("migrate:status prints the pending migration", out.includes("000002_add_index.sql"), out);
    } finally {
      process.chdir(originalCwd);
      delete process.env.TINA4_DATABASE_URL;
      rmSync(projectDir, { recursive: true, force: true });
    }
  }

  // ── failed-or-missing-down-does-not-drop-ledger ────────────────────────
  console.log("\n--- failed_or_missing_down_does_not_drop_ledger ---");

  {
    const projectDir = tmpMigDir("no_down");
    try {
      writeFileSync(join(projectDir, "migrations", "000001_no_down.sql"), "CREATE TABLE nd (id INTEGER);");
      await withAdapter(`sqlite:///${join(projectDir, "nodown.db")}`, async (db) => {
        await migrate(db, { migrationsDir: join(projectDir, "migrations") });

        const before = await adapterQuery<{ migration_name: string }>(
          db, `SELECT migration_name FROM tina4_migration WHERE migration_name = ?`, ["000001_no_down"],
        );
        check("precondition: migration recorded", before.length === 1);

        let threw: Error | null = null;
        try {
          await rollback(join(projectDir, "migrations"));
        } catch (err) {
          threw = err instanceof Error ? err : new Error(String(err));
        }
        check("a missing .down.sql RAISES", threw !== null && /no \.down\.sql file found/.test(threw.message), threw?.message ?? "(nothing thrown)");

        const after = await adapterQuery<{ migration_name: string }>(
          db, `SELECT migration_name FROM tina4_migration WHERE migration_name = ?`, ["000001_no_down"],
        );
        check(
          "a missing .down.sql must never drop the ledger row -- the schema is still there and must stay tracked",
          after.length === 1,
        );
        check("the user table itself is untouched", await adapterTableExists(db, "nd"));
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }

  {
    const projectDir = tmpMigDir("bad_down");
    try {
      writeFileSync(join(projectDir, "migrations", "000001_bad_down.sql"), "CREATE TABLE bd (id INTEGER);");
      writeFileSync(join(projectDir, "migrations", "000001_bad_down.down.sql"), "THIS IS NOT VALID SQL;");
      await withAdapter(`sqlite:///${join(projectDir, "baddown.db")}`, async (db) => {
        await migrate(db, { migrationsDir: join(projectDir, "migrations") });

        let threw: Error | null = null;
        try {
          await rollback(join(projectDir, "migrations"));
        } catch (err) {
          threw = err instanceof Error ? err : new Error(String(err));
        }
        check("a FAILING down statement RAISES", threw !== null, threw?.message ?? "(nothing thrown)");

        const after = await adapterQuery<{ migration_name: string }>(
          db, `SELECT migration_name FROM tina4_migration WHERE migration_name = ?`, ["000001_bad_down"],
        );
        check("a FAILING down statement must also never drop the ledger row", after.length === 1);
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }

  // ── firebird-mssql-create-add-idempotency-real ─────────────────────────
  // NO DOUBLES. Replaces migrationFootguns.test.ts's fake MssqlAdapter /
  // FirebirdAdapter (MIG-FBMSSQL-MOCK) -- modelled on tina4-php's
  // MigrationFootgunsLiveEngineTest.
  console.log("\n--- firebird_mssql_create_add_idempotency_real ---");

  if (await tcpReachable(MSSQL_HOST, MSSQL_PORT)) {
    const table = "nomock_mig_ctr_node_mssql";
    await withAdapter(`mssql://${MSSQL_USER}:${MSSQL_PASS}@${MSSQL_HOST}:${MSSQL_PORT}/${MSSQL_DB}`, async (db) => {
      try {
        await adapterExecute(db, `IF OBJECT_ID('${table}','U') IS NOT NULL DROP TABLE ${table}`);
        await adapterExecute(db, `CREATE TABLE ${table} (id INT)`);
        check("MSSQL: precondition table exists", await adapterTableExists(db, table));

        const reason = await shouldSkipCreateTable(db, `CREATE TABLE ${table} (id INT)`);
        check("MSSQL: a really-existing table makes CREATE TABLE skip", reason !== null && reason.includes(table), String(reason));

        const absentReason = await shouldSkipCreateTable(db, `CREATE TABLE nomock_mig_ctr_node_absent (id INT)`);
        check("MSSQL: an absent table is NOT skipped -- the migration has to run", absentReason === null);
      } finally {
        await adapterExecute(db, `IF OBJECT_ID('${table}','U') IS NOT NULL DROP TABLE ${table}`);
      }
    });
  } else {
    console.log(`  \x1b[33mSKIP\x1b[0m MSSQL not reachable at ${MSSQL_HOST}:${MSSQL_PORT}`);
  }

  if (FIREBIRD_URL) {
    const table = "NOMOCK_MIG_CTR_NODE";
    await withAdapter(FIREBIRD_URL, async (db) => {
      try {
        try { await adapterExecute(db, `DROP TABLE ${table}`); } catch { /* absent */ }
        await adapterExecute(db, `CREATE TABLE ${table} (id INTEGER NOT NULL PRIMARY KEY)`);
        check("Firebird: precondition table exists", await adapterTableExists(db, table));

        const reason = await shouldSkipCreateTable(db, `CREATE TABLE ${table} (id INTEGER NOT NULL PRIMARY KEY)`);
        check("Firebird: a really-existing table makes CREATE TABLE skip", reason !== null, String(reason));

        // ALTER TABLE ... ADD idempotency (Firebird-only guard).
        await adapterExecute(db, `ALTER TABLE ${table} ADD extra_col VARCHAR(50)`);
        const addReason = await shouldSkipForFirebird(db, `ALTER TABLE ${table} ADD extra_col VARCHAR(50)`);
        check("Firebird: a really-existing column makes ALTER ADD skip", addReason !== null && addReason.includes("extra_col"), String(addReason));

        const absentAddReason = await shouldSkipForFirebird(db, `ALTER TABLE ${table} ADD never_added VARCHAR(10)`);
        check("Firebird: an absent column is NOT skipped -- the ADD has to run", absentAddReason === null);
      } finally {
        try { await adapterExecute(db, `DROP TABLE ${table}`); } catch { /* best effort */ }
      }
    });
  } else {
    console.log("  \x1b[33mSKIP\x1b[0m TINA4_TEST_FIREBIRD_URL not set (needs a live Firebird)");
  }

  {
    // Negative control: the SQLite/Postgres branch never touches the
    // database at all (returns null before calling tableExists).
    await withAdapter(`sqlite:///:memory:`, async (db) => {
      const reason = await shouldSkipCreateTable(db, "CREATE TABLE anything (id INT)");
      check("SQLite: never skipped by this guard (IF NOT EXISTS engines)", reason === null);
    });
  }

  // ── cli-and-orm-paths-identical (Node-only) ────────────────────────────
  console.log("\n--- cli_and_orm_paths_identical (Node-only) ---");

  {
    // Two identical migration sets, one run through the CLI (runMigrations),
    // one through the ORM's migrate() directly. A multi-statement file with
    // a ';' inside a string literal is the exact case the OLD naive
    // sql.split(";") CLI implementation broke on -- proving the CLI now
    // takes the SAME robust-split, transactional path as the ORM.
    const sql =
      "CREATE TABLE cli_orm_parity (id INTEGER PRIMARY KEY, note TEXT);\n" +
      "INSERT INTO cli_orm_parity (note) VALUES ('a;b;c');\n" +
      "CREATE TABLE cli_orm_parity_2 (id INTEGER PRIMARY KEY);";

    const cliProject = tmpMigDir("parity_cli");
    const ormProject = tmpMigDir("parity_orm");
    const originalCwd = process.cwd();
    try {
      writeFileSync(join(cliProject, "migrations", "000001_parity.sql"), sql);
      writeFileSync(join(ormProject, "migrations", "000001_parity.sql"), sql);

      // CLI path
      const cliDbPath = join(cliProject, "cli.db");
      process.env.TINA4_DATABASE_URL = `sqlite:///${cliDbPath}`;
      process.chdir(cliProject);
      const orm = await import("../packages/orm/src/index.js");
      (orm as { setAdapter?: (a: unknown) => void }).setAdapter?.(null);
      const { runMigrations } = await import("../packages/cli/src/commands/migrate.js");
      await runMigrations();
      process.chdir(originalCwd);
      delete process.env.TINA4_DATABASE_URL;

      // ORM path
      const ormDbPath = join(ormProject, "orm.db");
      await withAdapter(`sqlite:///${ormDbPath}`, async (db) => {
        const result = await migrate(db, { migrationsDir: join(ormProject, "migrations") });
        check("ORM path: migration applied", result.applied.length === 1, JSON.stringify(result));
      });

      // Compare both databases independently via fresh adapters. withAdapter
      // uses a process-wide singleton adapter, so these run SEQUENTIALLY
      // (never nested) -- the CLI-path results are captured into a variable
      // for the final cross-database comparison below.
      let cliNote: string | undefined;
      await withAdapter(`sqlite:///${cliDbPath}`, async (cliDb) => {
        check("CLI path: the ';'-in-string-literal statement was NOT mis-split (table 1 exists)", await adapterTableExists(cliDb, "cli_orm_parity"));
        check("CLI path: the SECOND statement (after the embedded ';') also applied (table 2 exists)", await adapterTableExists(cliDb, "cli_orm_parity_2"));
        const rows = await adapterQuery<{ note: string }>(cliDb, "SELECT note FROM cli_orm_parity");
        cliNote = rows[0]?.note;
        check("CLI path: the string literal's embedded ';' survived intact", cliNote === "a;b;c", JSON.stringify(rows));
        const ledger = await adapterQuery<{ migration_name: string; batch: number }>(
          cliDb, `SELECT migration_name, batch FROM tina4_migration WHERE migration_name = ?`, ["000001_parity"],
        );
        check("CLI path: ledger row recorded", ledger.length === 1 && ledger[0].batch === 1, JSON.stringify(ledger));
      });

      await withAdapter(`sqlite:///${ormDbPath}`, async (ormDb) => {
        const ormRows = await adapterQuery<{ note: string }>(ormDb, "SELECT note FROM cli_orm_parity");
        check(
          "CLI and ORM paths produce IDENTICAL schema + data results",
          await adapterTableExists(ormDb, "cli_orm_parity") &&
            await adapterTableExists(ormDb, "cli_orm_parity_2") &&
            ormRows[0]?.note === cliNote,
          `orm=${JSON.stringify(ormRows)} cliNote=${JSON.stringify(cliNote)}`,
        );
      });
    } finally {
      process.chdir(originalCwd);
      delete process.env.TINA4_DATABASE_URL;
      rmSync(cliProject, { recursive: true, force: true });
      rmSync(ormProject, { recursive: true, force: true });
    }
  }

  console.log(`\nmigrationContract: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
