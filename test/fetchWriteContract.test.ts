/**
 * The fetch-write contract: a write that returns rows, run through fetch() or
 * fetchOne(), runs EXACTLY ONCE, unpaginated, uncached, and commits
 * (tina4-python#133 follow-up, shared cross-framework contract).
 *
 * THE CONTRACT (identical in all four frameworks; Python's _is_write_statement):
 * a statement is a WRITE when, after removing string literals, comments and
 * leading whitespace/brackets, its first word is INSERT, UPDATE, DELETE, MERGE,
 * UPSERT or REPLACE, OR it starts with WITH and its body contains INSERT,
 * UPDATE, DELETE or MERGE (a data-modifying CTE). A write through fetch/fetchOne
 * runs exactly once, with no COUNT probe and no LIMIT/OFFSET/ROWS/TOP
 * pagination; its result is never cached; and it commits like execute().
 *
 * THE NODE DEFECTS THIS FIXES (measured on the lab):
 *   - db.fetch() applies its default 100-row cap, so `INSERT ... RETURNING id`
 *     went out as `... RETURNING id LIMIT 100` (Postgres/SQLite: syntax error),
 *     `... ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY` (SQL
 *     Server: syntax error) or `... ROWS 1 TO 100` (Firebird: syntax error).
 *   - Firebird fetchOne() appended `ROWS 1 TO 1`, so fetchOne() of an
 *     `INSERT ... RETURNING` failed with "Token unknown ... ROWS".
 *   - With the query cache on, a repeated fetchOne() of the same INSERT was
 *     answered from the cache: the second row was never inserted.
 *
 * NO MOCKS: real PostgreSQL, SQL Server, Firebird and a real SQLite file. Every
 * durability check reads through a SECOND connection. The classification table
 * is a pure function with no dependency.
 *
 * Same case names in all four frameworks:
 *   - write_statement_classification
 *   - fetch_of_a_write_runs_once_unpaginated_and_commits
 *   - fetch_ignores_explicit_pagination_for_a_write
 *   - fetch_one_insert_returning_commits (Firebird: the ROWS 1 TO 1 defect)
 *   - fetch_one_data_modifying_cte_is_committed (PostgreSQL)
 *   - a_returning_write_is_never_served_from_the_query_cache
 *   - explicit_transaction_rollback_undoes_a_fetch_write
 *   - a_read_is_still_paginated
 *
 * Run with: npx tsx test/fetchWriteContract.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, SQLTranslator } from "../packages/orm/src/index.ts";

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

// ── 1. The classification, exactly as Python's table plus Node's extras ─────
console.log("=== fetch-write contract (tina4-python#133 follow-up) ===\n\n--- write_statement_classification ---");
const CASES: Array<[string, boolean]> = [
  ["INSERT INTO t (a) VALUES (1) RETURNING id", true],
  ["  -- a leading comment\n update t SET a = 1 RETURNING a", true],
  ["/* block */ DELETE FROM t RETURNING id", true],
  ["WITH gone AS (DELETE FROM t RETURNING id) SELECT count(*) FROM gone", true],
  ["SELECT * FROM t WHERE note = 'INSERT INTO x'", false],
  ["SELECT id FROM t -- UPDATE later", false],
  ["WITH recent AS (SELECT id FROM t) SELECT * FROM recent", false],
  ["SELECT replace(name, 'a', 'b') AS updated FROM t", false],
  ["(INSERT INTO t (a) VALUES (1) RETURNING id)", true],
  ["MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a", true],
  ["REPLACE INTO t (id, a) VALUES (1, 2)", true],
  ["UPSERT INTO t (id, a) VALUES (1, 2)", true],
  ["insert into t (a) output inserted.id values (1)", true],
  ["SELECT * FROM t WHERE note = 'DELETE'", false],
  ["select 'UPDATE' as verb", false],
  ["", false],
];
const isWriteStatement = (SQLTranslator as unknown as { isWriteStatement?: (sql: string) => boolean }).isWriteStatement;
for (const [sql, expected] of CASES) {
  if (typeof isWriteStatement !== "function") {
    assert(`write_statement_classification: ${JSON.stringify(sql)} -> ${expected}`, false, "SQLTranslator.isWriteStatement does not exist");
    continue;
  }
  const got = isWriteStatement(sql);
  assert(`write_statement_classification: ${JSON.stringify(sql)} -> ${expected}`, got === expected, `got ${got}`);
}

// ── 2. Live engines ──────────────────────────────────────────────────────────
const TABLE = "issue133_node_fetchw";
const sqliteDir = mkdtempSync(join(tmpdir(), "tina4-fetchw-"));

interface Dialect {
  label: string;
  url: string | undefined;
  urlEnv: string;
  drop: string;
  dropMayFail?: boolean;
  create: string;
  insertReturning: string;
  cte?: string;
}

const DIALECTS: Dialect[] = [
  {
    label: "postgres",
    url: process.env.TINA4_TEST_PG_URL,
    urlEnv: "TINA4_TEST_PG_URL",
    drop: `DROP TABLE IF EXISTS ${TABLE}`,
    create: `CREATE TABLE ${TABLE} (id serial PRIMARY KEY, body varchar(200) NOT NULL)`,
    insertReturning: `INSERT INTO ${TABLE} (body) VALUES (?) RETURNING id`,
    cte: `WITH created AS (INSERT INTO ${TABLE} (body) VALUES (?) RETURNING id) SELECT id FROM created`,
  },
  {
    label: "sqlite",
    url: `sqlite:///${join(sqliteDir, "fetchw.db")}`,
    urlEnv: "",
    drop: `DROP TABLE IF EXISTS ${TABLE}`,
    create: `CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)`,
    insertReturning: `INSERT INTO ${TABLE} (body) VALUES (?) RETURNING id`,
  },
  {
    label: "mssql",
    url: process.env.TINA4_TEST_MSSQL_URL,
    urlEnv: "TINA4_TEST_MSSQL_URL",
    drop: `IF OBJECT_ID('${TABLE}', 'U') IS NOT NULL DROP TABLE ${TABLE}`,
    create: `CREATE TABLE ${TABLE} (id INT IDENTITY(1,1) PRIMARY KEY, body NVARCHAR(200) NOT NULL)`,
    insertReturning: `INSERT INTO ${TABLE} (body) OUTPUT inserted.id VALUES (?)`,
  },
  {
    label: "firebird",
    url: process.env.TINA4_TEST_FIREBIRD_URL,
    urlEnv: "TINA4_TEST_FIREBIRD_URL",
    drop: `DROP TABLE ${TABLE}`,
    dropMayFail: true,
    create: `CREATE TABLE ${TABLE} (id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, body VARCHAR(200) NOT NULL)`,
    insertReturning: `INSERT INTO ${TABLE} (body) VALUES (?) RETURNING id`,
  },
];

function idOf(row: Record<string, unknown> | null | undefined): number {
  if (!row) return NaN;
  return Number(row.id ?? row.ID);
}

async function countFrom(reader: Database): Promise<number> {
  const row = await reader.fetchOne<Record<string, unknown>>(`SELECT COUNT(*) AS n FROM ${TABLE}`, [], { noCache: true });
  return Number(row?.n ?? row?.N ?? NaN);
}

async function attempt<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await fn() };
  } catch (e) {
    const message = String((e as Error)?.message || e || "threw").split("\n")[0];
    return { error: message || "threw" };
  }
}

async function runDialect(d: Dialect): Promise<void> {
  console.log(`\n--- ${d.label} ---`);
  if (!d.url) {
    skip(`${d.label}: fetch-write contract`, `${d.label === "odbc" ? "" : `[needs:${d.label}] `}${d.urlEnv} not set, ${d.label} not reachable`);
    return;
  }

  const writer = await Database.create(d.url);
  const reader = await Database.create(d.url);
  const drop = async (db: Database) => {
    try { await db.execute(d.drop); } catch (e) { if (!d.dropMayFail) throw e; }
  };
  try {
    await drop(writer);
    await writer.execute(d.create);

    // fetch() with its DEFAULT 100-row cap.
    let before = await countFrom(reader);
    const capped = await attempt(() => writer.fetch(d.insertReturning, ["via fetch default cap"]));
    let after = await countFrom(reader);
    assert(`${d.label}: fetch_of_a_write_runs_once_unpaginated_and_commits`,
      !capped.error && capped.value!.records.length === 1 && Number.isFinite(idOf(capped.value!.records[0] as any)) && after === before + 1,
      capped.error ? `raised: ${capped.error}` : `records=${JSON.stringify(capped.value!.records)} rows ${before} -> ${after}`);

    // fetch() with EXPLICIT pagination: offset 5 would skip the only row.
    before = await countFrom(reader);
    const paged = await attempt(() => writer.fetch(d.insertReturning, ["via fetch limit 10 offset 5"], 10, 5));
    after = await countFrom(reader);
    assert(`${d.label}: fetch_ignores_explicit_pagination_for_a_write`,
      !paged.error && paged.value!.records.length === 1 && after === before + 1,
      paged.error ? `raised: ${paged.error}` : `records=${JSON.stringify(paged.value!.records)} rows ${before} -> ${after}`);

    // fetchOne() of an INSERT ... RETURNING.
    before = await countFrom(reader);
    const one = await attempt(() => writer.fetchOne<Record<string, unknown>>(d.insertReturning, ["via fetchOne"]));
    after = await countFrom(reader);
    assert(`${d.label}: fetch_one_insert_returning_commits`,
      !one.error && Number.isFinite(idOf(one.value)) && after === before + 1,
      one.error ? `raised: ${one.error}` : `row=${JSON.stringify(one.value)} rows ${before} -> ${after}`);

    if (d.cte) {
      before = await countFrom(reader);
      const cte = await attempt(() => writer.fetchOne<Record<string, unknown>>(d.cte!, ["via cte"]));
      after = await countFrom(reader);
      assert(`${d.label}: fetch_one_data_modifying_cte_is_committed`,
        !cte.error && Number.isFinite(idOf(cte.value)) && after === before + 1,
        cte.error ? `raised: ${cte.error}` : `row=${JSON.stringify(cte.value)} rows ${before} -> ${after}`);
    }

    // Query cache ON: the same INSERT twice must insert twice.
    process.env.TINA4_AUTO_CACHING = "true";
    const cached = await Database.create(d.url);
    delete process.env.TINA4_AUTO_CACHING;
    try {
      before = await countFrom(reader);
      const first = await attempt(() => cached.fetchOne<Record<string, unknown>>(d.insertReturning, ["same"]));
      const second = await attempt(() => cached.fetchOne<Record<string, unknown>>(d.insertReturning, ["same"]));
      after = await countFrom(reader);
      assert(`${d.label}: a_returning_write_is_never_served_from_the_query_cache`,
        !first.error && !second.error && idOf(second.value) !== idOf(first.value) && after === before + 2,
        `first=${JSON.stringify(first.value ?? first.error)} second=${JSON.stringify(second.value ?? second.error)} rows ${before} -> ${after}`);

      // A cached READ must not survive a write made through fetchOne.
      const countSql = `SELECT COUNT(*) AS n FROM ${TABLE}`;
      const readBefore = await cached.fetchOne<Record<string, unknown>>(countSql);
      await attempt(() => cached.fetchOne(d.insertReturning, ["flushes the cache"]));
      const readAfter = await cached.fetchOne<Record<string, unknown>>(countSql);
      const nBefore = Number(readBefore?.n ?? readBefore?.N);
      const nAfter = Number(readAfter?.n ?? readAfter?.N);
      assert(`${d.label}: a_returning_write_is_never_served_from_the_query_cache (a write flushes cached reads)`,
        nAfter === nBefore + 1, `cached count ${nBefore} -> ${nAfter}`);
    } finally {
      cached.close();
    }

    // NEGATIVE: an explicit transaction still owns a fetch() write.
    before = await countFrom(reader);
    await writer.startTransaction();
    const inTx = await attempt(() => writer.fetch(d.insertReturning, ["inside a transaction"]));
    await writer.rollback();
    after = await countFrom(reader);
    assert(`${d.label}: explicit_transaction_rollback_undoes_a_fetch_write`,
      !inTx.error && inTx.value!.records.length === 1 && after === before,
      inTx.error ? `raised: ${inTx.error}` : `rows before=${before} after rollback=${after}`);

    // NEGATIVE: a read is still paginated and counted, even one whose literal
    // spells a DML verb. Rows written by plain execute(), so this case stands
    // on its own whatever the write cases above did.
    for (const body of ["r1", "r2", "r3", "r4"]) {
      await writer.execute(`INSERT INTO ${TABLE} (body) VALUES (?)`, [body]);
    }
    await writer.execute(`UPDATE ${TABLE} SET body = ? WHERE id = (SELECT MIN(id) FROM ${TABLE})`, ["DELETE"]);
    const total = await countFrom(reader);
    const page = await writer.fetch(`SELECT id FROM ${TABLE} WHERE body <> 'DELETE'`, [], 2, 1);
    assert(`${d.label}: a_read_is_still_paginated`,
      page.records.length === 2 && page.count === total - 1,
      `records=${page.records.length} total=${page.count} (expected 2 of ${total - 1})`);
  } finally {
    try { await drop(writer); } catch { /* best effort */ }
    writer.close();
    reader.close();
  }
}

const selectedEngine = process.argv.find(arg => arg.startsWith("--engine="))?.slice("--engine=".length);
const availableDialects = DIALECTS;
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
