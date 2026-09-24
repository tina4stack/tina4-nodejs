/**
 * execute() returns the rows of any statement that produces them, as the SAME
 * result type fetch() returns (cross-framework contract, matching PHP).
 *
 * THE CONTRACT: execute(sql, params) of a statement that returns rows - SELECT,
 * WITH ... SELECT, INSERT/UPDATE/DELETE ... RETURNING (SQL Server OUTPUT), or a
 * CALL/EXEC procedure returning a result set - returns a DatabaseResult carrying
 * those rows. It runs exactly once, with no COUNT probe and no LIMIT/OFFSET. A
 * write that returns no rows keeps its return value (`true`). Writes commit as
 * before, and a read outside an explicit transaction ends its transaction.
 *
 * THE NODE DEFECT: execute() handed back whatever the DRIVER returned - a pg
 * Result, tedious's {rows,rowCount}, a mysql2 array, an odbc array - and only
 * for text that contained "RETURNING" or began "SELECT "/"CALL "/"EXEC ". On
 * SQLite and Firebird the rows were lost entirely (node:sqlite's run() and
 * node-firebird's execute() return none), and a WITH ... SELECT returned `true`.
 *
 * NO MOCKS: real PostgreSQL, MySQL, SQL Server, Firebird, ODBC (psqlODBC ->
 * PostgreSQL) and a real SQLite file. Row counts are read through a SECOND
 * connection.
 *
 * Same case names in all four frameworks:
 *   - execute_select_returns_the_same_rows_as_fetch
 *   - execute_with_select_returns_rows
 *   - execute_insert_returning_returns_the_id_and_writes_once
 *   - execute_update_without_returning_keeps_its_return_value
 *   - execute_procedure_returns_its_result_set (PostgreSQL, MySQL, SQL Server)
 *   - read_through_execute_leaves_no_open_transaction (PostgreSQL)
 *
 * Run with: npx tsx test/executeReturnsRows.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, DatabaseResult } from "../packages/orm/src/index.ts";

let pass = 0;
let fail = 0;
let skipped = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function skip(name: string, reason: string): void {
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} (${reason})`);
  skipped++;
}

const sqliteDir = mkdtempSync(join(tmpdir(), "tina4-exec-rows-"));

interface Dialect {
  label: string;
  url: string | undefined;
  urlEnv: string;
  table: string;
  drop: string;
  dropMayFail?: boolean;
  create: string;
  insertReturning?: string;
  procedure?: { create: string[]; call: string; params: unknown[]; drop: string; expect: number };
}

function dialects(): Dialect[] {
  const pgTable = "issue_exec_node_pg";
  const odbcTable = "issue_exec_node_odbc";
  return [
    {
      label: "postgres", url: process.env.TINA4_TEST_PG_URL, urlEnv: "TINA4_TEST_PG_URL",
      table: pgTable, drop: `DROP TABLE IF EXISTS ${pgTable}`,
      create: `CREATE TABLE ${pgTable} (id serial PRIMARY KEY, body varchar(100) NOT NULL)`,
      insertReturning: `INSERT INTO ${pgTable} (body) VALUES (?) RETURNING id`,
      procedure: {
        create: ["CREATE OR REPLACE PROCEDURE issue_exec_node_proc(INOUT n integer) LANGUAGE plpgsql AS $$ BEGIN n := n + 1; END $$"],
        call: "CALL issue_exec_node_proc(CAST(? AS INTEGER))", params: [41], drop: "DROP PROCEDURE IF EXISTS issue_exec_node_proc(integer)", expect: 42,
      },
    },
    {
      label: "mysql", url: process.env.TINA4_TEST_MYSQL_URL, urlEnv: "TINA4_TEST_MYSQL_URL",
      table: "issue_exec_node_my", drop: "DROP TABLE IF EXISTS issue_exec_node_my",
      create: "CREATE TABLE issue_exec_node_my (id INT AUTO_INCREMENT PRIMARY KEY, body VARCHAR(100) NOT NULL)",
      // MySQL has no INSERT ... RETURNING.
      procedure: {
        create: ["DROP PROCEDURE IF EXISTS issue_exec_node_proc", "CREATE PROCEDURE issue_exec_node_proc(IN x INT) SELECT x + 1 AS n"],
        call: "CALL issue_exec_node_proc(?)", params: [41], drop: "DROP PROCEDURE IF EXISTS issue_exec_node_proc", expect: 42,
      },
    },
    {
      label: "mssql", url: process.env.TINA4_TEST_MSSQL_URL, urlEnv: "TINA4_TEST_MSSQL_URL",
      table: "issue_exec_node_ms", drop: "IF OBJECT_ID('issue_exec_node_ms', 'U') IS NOT NULL DROP TABLE issue_exec_node_ms",
      create: "CREATE TABLE issue_exec_node_ms (id INT IDENTITY(1,1) PRIMARY KEY, body NVARCHAR(100) NOT NULL)",
      insertReturning: "INSERT INTO issue_exec_node_ms (body) OUTPUT inserted.id VALUES (?)",
      procedure: {
        create: ["IF OBJECT_ID('issue_exec_node_proc', 'P') IS NOT NULL DROP PROCEDURE issue_exec_node_proc",
          "CREATE PROCEDURE issue_exec_node_proc @x INT AS SELECT @x + 1 AS n"],
        call: "EXEC issue_exec_node_proc ?", params: [41],
        drop: "IF OBJECT_ID('issue_exec_node_proc', 'P') IS NOT NULL DROP PROCEDURE issue_exec_node_proc", expect: 42,
      },
    },
    {
      label: "firebird", url: process.env.TINA4_TEST_FIREBIRD_URL, urlEnv: "TINA4_TEST_FIREBIRD_URL",
      table: "issue_exec_node_fb", drop: "DROP TABLE issue_exec_node_fb", dropMayFail: true,
      create: "CREATE TABLE issue_exec_node_fb (id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, body VARCHAR(100) NOT NULL)",
      insertReturning: "INSERT INTO issue_exec_node_fb (body) VALUES (?) RETURNING id",
    },
    {
      label: "odbc", url: process.env.TINA4_TEST_ODBC_DSN ? "odbc:///" + process.env.TINA4_TEST_ODBC_DSN : undefined,
      urlEnv: "TINA4_TEST_ODBC_DSN",
      table: odbcTable, drop: `DROP TABLE IF EXISTS ${odbcTable}`,
      create: `CREATE TABLE ${odbcTable} (id serial PRIMARY KEY, body varchar(100) NOT NULL)`,
      insertReturning: `INSERT INTO ${odbcTable} (body) VALUES (?) RETURNING id`,
    },
    {
      label: "sqlite", url: `sqlite:///${join(sqliteDir, "exec.db")}`, urlEnv: "",
      table: "issue_exec_node_lite", drop: "DROP TABLE IF EXISTS issue_exec_node_lite",
      create: "CREATE TABLE issue_exec_node_lite (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)",
      insertReturning: "INSERT INTO issue_exec_node_lite (body) VALUES (?) RETURNING id",
    },
  ];
}

/** Lower-case the keys (Firebird folds column names to upper case). */
function norm(rows: unknown[]): Array<Record<string, unknown>> {
  return rows.map((r) => Object.fromEntries(Object.entries(r as Record<string, unknown>)
    .map(([k, v]) => [k.toLowerCase(), typeof v === "bigint" ? Number(v) : v])));
}

async function attempt<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try { return { value: await fn() }; } catch (e) {
    const message = String((e as Error)?.message || e || "threw").split("\n")[0];
    return { error: message || "threw" };
  }
}

async function countFrom(reader: Database, table: string): Promise<number> {
  const row = await reader.fetchOne<Record<string, unknown>>(`SELECT COUNT(*) AS n FROM ${table}`, [], { noCache: true });
  return Number(row?.n ?? row?.N ?? NaN);
}

async function runDialect(d: Dialect): Promise<void> {
  console.log(`\n--- ${d.label} ---`);
  if (!d.url) {
    skip(`${d.label}: execute returns rows`, `${d.label === "odbc" ? "" : `[needs:${d.label}] `}${d.urlEnv} not set, ${d.label} not reachable`);
    return;
  }
  const L = d.label;
  const db = await Database.create(d.url);
  const reader = await Database.create(d.url);
  const drop = async () => { try { await db.execute(d.drop); } catch (e) { if (!d.dropMayFail) throw e; } };
  try {
    await drop();
    await db.execute(d.create);
    for (const body of ["one", "two", "three"]) {
      await db.execute(`INSERT INTO ${d.table} (body) VALUES (?)`, [body]);
    }

    const select = `SELECT id, body FROM ${d.table} WHERE id > ? ORDER BY id`;
    const e1 = await attempt(() => db.execute(select, [0]));
    const f1 = await db.fetch(select, [0]);
    const got = e1.value as DatabaseResult | undefined;
    assert(`${L}: execute_select_returns_the_same_rows_as_fetch`,
      !e1.error && got instanceof DatabaseResult && got.count === 3
        && JSON.stringify(norm(got.records)) === JSON.stringify(norm(f1.records)),
      e1.error ?? `got ${got?.constructor?.name ?? typeof e1.value}: ${JSON.stringify((got as any)?.records ?? e1.value)?.slice(0, 160)}`);

    const e2 = await attempt(() => db.execute(
      `WITH picked AS (SELECT id, body FROM ${d.table} WHERE body <> ?) SELECT body FROM picked ORDER BY body`, ["two"]));
    const got2 = e2.value as DatabaseResult | undefined;
    assert(`${L}: execute_with_select_returns_rows`,
      !e2.error && got2 instanceof DatabaseResult
        && JSON.stringify(norm(got2.records).map((r) => String(r.body).trimEnd())) === JSON.stringify(["one", "three"]),
      e2.error ?? `got ${JSON.stringify((got2 as any)?.records ?? e2.value)?.slice(0, 160)}`);

    if (d.insertReturning) {
      const before = await countFrom(reader, d.table);
      const e3 = await attempt(() => db.execute(d.insertReturning!, ["four"]));
      const after = await countFrom(reader, d.table);
      const got3 = e3.value as DatabaseResult | undefined;
      const id = got3 instanceof DatabaseResult ? Number(norm(got3.records)[0]?.id) : NaN;
      assert(`${L}: execute_insert_returning_returns_the_id_and_writes_once`,
        !e3.error && got3 instanceof DatabaseResult && got3.records.length === 1 && id > 3 && after === before + 1,
        e3.error ?? `got ${JSON.stringify((got3 as any)?.records ?? e3.value)?.slice(0, 160)} rows ${before} -> ${after}`);
    }

    const e4 = await attempt(() => db.execute(`UPDATE ${d.table} SET body = ? WHERE body = ?`, ["uno", "one"]));
    assert(`${L}: execute_update_without_returning_keeps_its_return_value`, !e4.error && e4.value === true,
      e4.error ?? `got ${typeof e4.value} ${JSON.stringify(e4.value)?.slice(0, 100)}`);

    if (d.procedure) {
      const p = d.procedure;
      try {
        for (const stmt of p.create) await db.execute(stmt);
        const e5 = await attempt(() => db.execute(p.call, p.params));
        const got5 = e5.value as DatabaseResult | undefined;
        assert(`${L}: execute_procedure_returns_its_result_set`,
          !e5.error && got5 instanceof DatabaseResult && Number(norm(got5.records)[0]?.n) === p.expect,
          e5.error ?? `got ${JSON.stringify((got5 as any)?.records ?? e5.value)?.slice(0, 160)}`);
      } finally {
        try { await db.execute(p.drop); } catch { /* best effort */ }
      }
    }

    if (L === "postgres") {
      await db.execute(select, [0]);
      const pidRow = await db.fetchOne<Record<string, unknown>>("SELECT pg_backend_pid() AS pid", [], { noCache: true });
      const state = await reader.fetchOne<Record<string, unknown>>(
        "SELECT state FROM pg_stat_activity WHERE pid = ?", [Number(pidRow?.pid)], { noCache: true });
      assert(`${L}: read_through_execute_leaves_no_open_transaction`, state?.state === "idle",
        `backend state = ${JSON.stringify(state)}`);
    }
  } finally {
    await drop();
    db.close();
    reader.close();
  }
}

console.log("=== execute() returns the rows of a row-producing statement ===");
const selectedEngine = process.argv.find(arg => arg.startsWith("--engine="))?.slice("--engine=".length);
const availableDialects = dialects();
if (selectedEngine && !availableDialects.some(d => d.label === selectedEngine)) {
  throw new Error(`Unknown engine: ${selectedEngine}`);
}
for (const d of availableDialects.filter(d => !selectedEngine || d.label === selectedEngine)) {
  try {
    await runDialect(d);
  } catch (err) {
    assert(`${d.label}: suite ran without error`, false, (err as Error).stack ?? String(err));
  }
}
try { rmSync(sqliteDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
