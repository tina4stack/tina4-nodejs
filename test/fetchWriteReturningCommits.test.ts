/**
 * A write that returns rows, run through fetchOne()/fetchAll(), is COMMITTED
 * (tina4-python#133 parity lock-in).
 *
 * THE PYTHON DEFECT: fetch_one()/fetch() are treated as reads, so outside an
 * explicit transaction the connection is closed with a ROLLBACK. An
 * `INSERT ... RETURNING id` goes through fetch_one() naturally (you want the new
 * id), so the caller got the id of a row that was then rolled back - silent data
 * loss.
 *
 * NODE IS NOT AFFECTED, and this suite pins why on every engine that can express
 * a row-returning write: Database.fetch()/fetchOne() never open an implicit
 * transaction and never issue a ROLLBACK. The drivers run a statement outside
 * BEGIN in autocommit (pg, tedious, node:sqlite), so the write is durable the
 * moment the statement returns. Only an EXPLICIT startTransaction() governs it,
 * and there rollback() must still undo it (the negative case).
 *
 * Every durability check reads through a SECOND, independent connection - the
 * writer's own connection could see its own uncommitted row.
 *
 * NO MOCKS: real PostgreSQL, real SQL Server, a real SQLite file.
 *
 * Same case names in all four frameworks:
 *   - fetch_one_insert_returning_is_committed
 *   - fetch_update_returning_is_committed
 *   - fetch_one_delete_returning_is_committed
 *   - fetch_one_insert_returning_runs_exactly_once / fetch_all_... / fetch_...
 *     / fetch_one_delete_returning_runs_exactly_once: the table holds EXACTLY
 *     the expected number of rows, counted through a brand-new connection (PHP's
 *     SQLite driver ran a write through fetch twice; "the row exists" missed it)
 *   - explicit_transaction_rollback_still_undoes_a_fetch_write
 *   - read_through_fetch_one_leaves_no_open_transaction (PostgreSQL)
 *
 * Run with: npx tsx test/fetchWriteReturningCommits.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../packages/orm/src/index.ts";

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

const TABLE = "issue133_node_note";

interface Dialect {
  label: string;
  url: string | undefined;
  urlEnv: string;
  drop: string;
  create: string;
  insertReturning: string;
  updateReturning: string;
  deleteReturning: string;
}

const sqliteDir = mkdtempSync(join(tmpdir(), "tina4-issue133-"));

const DIALECTS: Dialect[] = [
  {
    label: "postgres",
    url: process.env.TINA4_TEST_PG_URL,
    urlEnv: "TINA4_TEST_PG_URL",
    drop: `DROP TABLE IF EXISTS ${TABLE}`,
    create: `CREATE TABLE ${TABLE} (id serial PRIMARY KEY, body varchar(200) NOT NULL)`,
    insertReturning: `INSERT INTO ${TABLE} (body) VALUES (?) RETURNING id`,
    updateReturning: `UPDATE ${TABLE} SET body = ? WHERE id = ? RETURNING id`,
    deleteReturning: `DELETE FROM ${TABLE} WHERE id = ? RETURNING id`,
  },
  {
    label: "sqlite",
    url: `sqlite:///${join(sqliteDir, "issue133.db")}`,
    urlEnv: "",
    drop: `DROP TABLE IF EXISTS ${TABLE}`,
    create: `CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)`,
    insertReturning: `INSERT INTO ${TABLE} (body) VALUES (?) RETURNING id`,
    updateReturning: `UPDATE ${TABLE} SET body = ? WHERE id = ? RETURNING id`,
    deleteReturning: `DELETE FROM ${TABLE} WHERE id = ? RETURNING id`,
  },
  {
    // SQL Server spells RETURNING as OUTPUT inserted./deleted.
    label: "mssql",
    url: process.env.TINA4_TEST_MSSQL_URL,
    urlEnv: "TINA4_TEST_MSSQL_URL",
    drop: `IF OBJECT_ID('${TABLE}', 'U') IS NOT NULL DROP TABLE ${TABLE}`,
    create: `CREATE TABLE ${TABLE} (id INT IDENTITY(1,1) PRIMARY KEY, body NVARCHAR(200) NOT NULL)`,
    insertReturning: `INSERT INTO ${TABLE} (body) OUTPUT inserted.id VALUES (?)`,
    updateReturning: `UPDATE ${TABLE} SET body = ? OUTPUT inserted.id WHERE id = ?`,
    deleteReturning: `DELETE FROM ${TABLE} OUTPUT deleted.id WHERE id = ?`,
  },
];

function idOf(row: Record<string, unknown> | null | undefined): number {
  if (!row) return NaN;
  return Number(row.id ?? row.ID);
}

/** Row count as a DIFFERENT connection sees it - the only honest durability check. */
async function countFrom(reader: Database, where = "", params: unknown[] = []): Promise<number> {
  const row = await reader.fetchOne<Record<string, unknown>>(
    `SELECT COUNT(*) AS n FROM ${TABLE}${where}`, params, { noCache: true },
  );
  return Number(row?.n ?? row?.N ?? NaN);
}

/**
 * EXACT row count through a brand-new connection, opened for this one read.
 * "The row exists" is not enough: PHP's SQLite driver ran a write through fetch
 * TWICE, which a WHERE id = ? check cannot see - the table held two rows.
 */
async function exactRows(url: string): Promise<number> {
  const fresh = await Database.create(url);
  try {
    return await countFrom(fresh);
  } finally {
    fresh.close();
  }
}

async function runDialect(d: Dialect): Promise<void> {
  console.log(`\n--- ${d.label} ---`);
  if (!d.url) {
    skip(`${d.label}: fetch write returning commits`, `${d.urlEnv} not set, ${d.label} not reachable`);
    return;
  }

  const writer = await Database.create(d.url);
  const reader = await Database.create(d.url);
  try {
    await writer.execute(d.drop);
    await writer.execute(d.create);

    // 1. fetchOne of an INSERT ... RETURNING - the exact Python repro.
    const inserted = await writer.fetchOne<Record<string, unknown>>(d.insertReturning, ["written with fetchOne"]);
    const id = idOf(inserted);
    assert(`${d.label}: fetch_one_insert_returning_is_committed (id returned)`, Number.isFinite(id) && id > 0,
      `got ${JSON.stringify(inserted)}`);
    const seen = await countFrom(reader, " WHERE id = ?", [id]);
    assert(`${d.label}: fetch_one_insert_returning_is_committed (a fresh connection sees the row)`, seen === 1,
      `a second connection counted ${seen} rows with id ${id} (expected 1)`);
    const afterOne = await exactRows(d.url);
    assert(`${d.label}: fetch_one_insert_returning_runs_exactly_once (table holds exactly 1 row)`, afterOne === 1,
      `a fresh connection counted ${afterOne} rows after ONE fetchOne insert`);

    // 2. fetchAll of an UPDATE ... RETURNING (uncapped fetch: a LIMIT cannot be
    //    appended to a DML statement).
    const updated = await writer.fetchAll<Record<string, unknown>>(d.updateReturning, ["updated with fetch", id]);
    assert(`${d.label}: fetch_update_returning_is_committed (row returned)`,
      updated.length === 1 && idOf(updated[0]) === id, `got ${JSON.stringify(updated)}`);
    const updatedSeen = await countFrom(reader, " WHERE id = ? AND body = ?", [id, "updated with fetch"]);
    assert(`${d.label}: fetch_update_returning_is_committed (a fresh connection sees the update)`, updatedSeen === 1,
      `a second connection counted ${updatedSeen} updated rows (expected 1)`);

    // 2b. fetchAll and fetch (default 100-row cap) of an INSERT ... RETURNING:
    //     each adds EXACTLY one row.
    const viaFetchAll = await writer.fetchAll<Record<string, unknown>>(d.insertReturning, ["written with fetchAll"]);
    const afterFetchAll = await exactRows(d.url);
    assert(`${d.label}: fetch_all_insert_returning_runs_exactly_once (table holds exactly 2 rows)`,
      viaFetchAll.length === 1 && afterFetchAll === 2,
      `returned ${viaFetchAll.length} rows; a fresh connection counted ${afterFetchAll} (expected 2)`);
    const viaFetch = await writer.fetch(d.insertReturning, ["written with fetch"]);
    const afterFetch = await exactRows(d.url);
    assert(`${d.label}: fetch_insert_returning_runs_exactly_once (table holds exactly 3 rows)`,
      viaFetch.records.length === 1 && afterFetch === 3,
      `returned ${viaFetch.records.length} rows; a fresh connection counted ${afterFetch} (expected 3)`);

    // 3. fetchOne of a DELETE ... RETURNING.
    const deleted = await writer.fetchOne<Record<string, unknown>>(d.deleteReturning, [id]);
    assert(`${d.label}: fetch_one_delete_returning_is_committed (row returned)`, idOf(deleted) === id,
      `got ${JSON.stringify(deleted)}`);
    const afterDelete = await countFrom(reader, " WHERE id = ?", [id]);
    assert(`${d.label}: fetch_one_delete_returning_is_committed (a fresh connection no longer sees it)`,
      afterDelete === 0, `a second connection still counted ${afterDelete} rows`);
    const afterDeleteTotal = await exactRows(d.url);
    assert(`${d.label}: fetch_one_delete_returning_runs_exactly_once (table holds exactly 2 rows)`,
      afterDeleteTotal === 2, `a fresh connection counted ${afterDeleteTotal} (expected 2)`);

    // 4. NEGATIVE: an EXPLICIT transaction still owns the write. Committing a
    //    fetch write must never bypass the caller's rollback().
    const before = await countFrom(reader);
    await writer.startTransaction();
    const txRow = await writer.fetchOne<Record<string, unknown>>(d.insertReturning, ["inside a transaction"]);
    await writer.rollback();
    const after = await countFrom(reader);
    assert(`${d.label}: explicit_transaction_rollback_still_undoes_a_fetch_write`,
      Number.isFinite(idOf(txRow)) && after === before,
      `id=${JSON.stringify(txRow)} rows before=${before} after rollback=${after}`);

    // 5. The read path keeps its guarantee: a plain SELECT through fetchOne does
    //    not leave the connection idle in a transaction.
    if (d.label === "postgres") {
      const pidRow = await writer.fetchOne<Record<string, unknown>>("SELECT pg_backend_pid() AS pid", [], { noCache: true });
      const state = await reader.fetchOne<Record<string, unknown>>(
        "SELECT state FROM pg_stat_activity WHERE pid = ?", [Number(pidRow?.pid)], { noCache: true },
      );
      assert(`${d.label}: read_through_fetch_one_leaves_no_open_transaction`, state?.state === "idle",
        `writer backend state = ${JSON.stringify(state)}`);
    }
  } finally {
    try { await writer.execute(d.drop); } catch { /* best effort */ }
    writer.close();
    reader.close();
  }
}

console.log("=== fetch()/fetchOne() of a row-returning write commits (tina4-python#133 parity) ===");

for (const d of DIALECTS) {
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
