/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Database statement semantics - the runner for statement_semantics_contract.json (ADR-0065).
 *
 * test/fixtures/statement_semantics_contract.json is a byte-for-byte copy of
 * tina4-documentation/plan/v3/fixtures/statement_semantics_contract.json. The
 * same file drives the Python, PHP and Ruby runners, so a vector added there is
 * a vector all four frameworks must answer identically.
 *
 *   - write detection and placeholder translation walk the fixture's vectors
 *     through SQLTranslator.isWriteStatement() and placeholderStyle(sql, ":");
 *   - fetch of a write, execute rows and the query cache run against a REAL
 *     SQLite file, with durability read back on a SECOND, fresh connection;
 *   - OUTPUT and EXEC run against a REAL SQL Server, and the no-parameters rule
 *     against a REAL PostgreSQL. Under TINA4_REQUIRE_SERVICES a missing service
 *     fails the run (run-all's service gate turns the skip into a failure).
 *
 * NO MOCKS.
 *
 * Run with: npx tsx test/statementSemanticsContract.test.ts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, DatabaseResult } from "../packages/orm/src/index.ts";
import { SQLTranslator } from "../packages/orm/src/sqlTranslator.ts";

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

async function check(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    assert(name, false, `threw: ${(error as Error).stack ?? String(error)}`);
  }
}

const contract = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "statement_semantics_contract.json"), "utf8"));
const sqliteDir = mkdtempSync(join(tmpdir(), "tina4-statement-semantics-"));
let sqliteFileNumber = 0;
const JSONB = `'{"a":1}'::jsonb`;

type Row = Record<string, unknown>;
const lowerKeys = (row: Row | null | undefined): Row =>
  Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [key.toLowerCase(), typeof value === "bigint" ? Number(value) : value]));

/** A fresh SQLite file with an empty `note` table. */
async function sqliteUrl(): Promise<string> {
  const url = `sqlite:///${join(sqliteDir, `semantics_${++sqliteFileNumber}.db`)}`;
  const setup = await Database.create(url);
  await setup.execute("CREATE TABLE note (id INTEGER PRIMARY KEY AUTOINCREMENT, text VARCHAR(40))");
  setup.close();
  return url;
}

async function rowsSeenByAFreshConnection(url: string): Promise<number> {
  const fresh = await Database.create(url);
  try {
    return Number(lowerKeys(await fresh.fetchOne<Row>("SELECT COUNT(*) AS n FROM note", [], { noCache: true })).n);
  } finally {
    fresh.close();
  }
}

console.log("=== statement semantics contract (ADR-0065) ===");

// ── Vectors: the same data through every framework's own function ──────────

{
  const wrong = contract.write_detection_vectors
    .filter((vector: { sql: string; write: boolean }) => SQLTranslator.isWriteStatement(vector.sql) !== vector.write)
    .map((vector: { sql: string; write: boolean }) => `${JSON.stringify(vector.sql)} expected write=${vector.write}`);
  assert("write detection answers every fixture vector", wrong.length === 0, wrong.join("; "));
}

{
  const wrong = contract.placeholder_vectors
    .map((vector: { sql: string; numbered: string }) => ({ vector, got: SQLTranslator.placeholderStyle(vector.sql, ":") }))
    .filter(({ vector, got }: { vector: { numbered: string }; got: string }) => got !== vector.numbered)
    .map(({ vector, got }: { vector: { sql: string; numbered: string }; got: string }) =>
      `${JSON.stringify(vector.sql)} -> ${JSON.stringify(got)}, expected ${JSON.stringify(vector.numbered)}`);
  assert("placeholder translation answers every fixture vector", wrong.length === 0, wrong.join("; "));
}

// ── SQLite: fetch of a write, execute rows, the query cache ─────────────────

await check("fetch of an insert returning runs once and commits", async () => {
  const url = await sqliteUrl();
  const writer = await Database.create(url);
  const result = await writer.fetch("INSERT INTO note (text) VALUES (?) RETURNING id", ["via fetch"]);
  writer.close();
  const seen = await rowsSeenByAFreshConnection(url);
  assert("fetch of an insert returning runs once and commits",
    result.records.length === 1 && Number(lowerKeys(result.records[0] as Row).id) === 1 && seen === 1,
    `records=${JSON.stringify(result.records)} rows seen by a fresh connection=${seen}`);
});

await check("fetch one of an insert returning runs once and commits", async () => {
  const url = await sqliteUrl();
  const writer = await Database.create(url);
  const row = await writer.fetchOne<Row>("INSERT INTO note (text) VALUES (?) RETURNING id", ["via fetchOne"]);
  writer.close();
  const seen = await rowsSeenByAFreshConnection(url);
  assert("fetch one of an insert returning runs once and commits",
    Number(lowerKeys(row).id) === 1 && seen === 1, `row=${JSON.stringify(row)} rows seen by a fresh connection=${seen}`);
});

await check("a fetched write is never cached and flushes the cache", async () => {
  const url = await sqliteUrl();
  process.env.TINA4_DB_CACHE = "true";
  const database = await Database.create(url);
  delete process.env.TINA4_DB_CACHE;
  const countSql = "SELECT COUNT(*) AS n FROM note";
  const before = Number(lowerKeys(await database.fetchOne<Row>(countSql)).n); // a cached read
  const first = lowerKeys(await database.fetchOne<Row>("INSERT INTO note (text) VALUES (?) RETURNING id", ["same"]));
  const second = lowerKeys(await database.fetchOne<Row>("INSERT INTO note (text) VALUES (?) RETURNING id", ["same"]));
  const after = Number(lowerKeys(await database.fetchOne<Row>(countSql)).n);
  database.close();
  const seen = await rowsSeenByAFreshConnection(url);
  assert("a fetched write is never cached and flushes the cache",
    before === 0 && Number(first.id) !== Number(second.id) && after === 2 && seen === 2,
    `cached count ${before} -> ${after}, ids ${first.id}/${second.id}, rows seen by a fresh connection=${seen}`);
});

await check("execute returns rows for select with select and returning", async () => {
  const url = await sqliteUrl();
  const database = await Database.create(url);
  await database.execute("INSERT INTO note (text) VALUES (?)", ["one"]);
  const cases: Array<[string, unknown[], Row[]]> = [
    ["SELECT id, text FROM note WHERE id = ?", [1], [{ id: 1, text: "one" }]],
    ["WITH later AS (SELECT id FROM note WHERE id >= ?) SELECT id FROM later", [1], [{ id: 1 }]],
    ["INSERT INTO note (text) VALUES (?) RETURNING id", ["two"], [{ id: 2 }]],
  ];
  const wrong: string[] = [];
  for (const [sql, params, expected] of cases) {
    const result = await database.execute(sql, params);
    const rows = result instanceof DatabaseResult ? result.records.map((row) => lowerKeys(row as Row)) : null;
    if (JSON.stringify(rows) !== JSON.stringify(expected)) wrong.push(`${sql} -> ${JSON.stringify(rows ?? result)}`);
  }
  database.close();
  const seen = await rowsSeenByAFreshConnection(url);
  assert("execute returns rows for select with select and returning", wrong.length === 0 && seen === 2,
    `${wrong.join("; ")} rows seen by a fresh connection=${seen}`);
});

await check("execute of a plain write keeps its return value", async () => {
  const url = await sqliteUrl();
  const database = await Database.create(url);
  const result = await database.execute("INSERT INTO note (text) VALUES (?)", ["plain"]);
  database.close();
  const seen = await rowsSeenByAFreshConnection(url);
  assert("execute of a plain write keeps its return value", result === true && seen === 1,
    `returned ${JSON.stringify(result)}, rows seen by a fresh connection=${seen}`);
});

// ── SQL Server: OUTPUT and EXEC ─────────────────────────────────────────────

const mssqlUrl = process.env.TINA4_TEST_MSSQL_URL;
if (!mssqlUrl) {
  skip("execute returns rows for output and exec on sql server", "[needs:mssql] TINA4_TEST_MSSQL_URL not set, mssql not reachable");
} else {
  await check("execute returns rows for output and exec on sql server", async () => {
    const database = await Database.create(mssqlUrl);
    const dropAll = async () => {
      await database.execute("IF OBJECT_ID('contract_node_notes', 'P') IS NOT NULL DROP PROCEDURE contract_node_notes");
      await database.execute("IF OBJECT_ID('contract_node_note', 'U') IS NOT NULL DROP TABLE contract_node_note");
    };
    try {
      await dropAll();
      await database.execute("CREATE TABLE contract_node_note (id INT IDENTITY(1,1) PRIMARY KEY, text VARCHAR(40))");
      await database.execute("CREATE PROCEDURE contract_node_notes AS SELECT id, text FROM contract_node_note ORDER BY id");
      const inserted = await database.execute("INSERT INTO contract_node_note (text) OUTPUT inserted.id VALUES (?)", ["out"]);
      const listed = await database.execute("EXEC contract_node_notes");
      const insertedRows = inserted instanceof DatabaseResult ? inserted.records.map((row) => lowerKeys(row as Row)) : null;
      const listedRows = listed instanceof DatabaseResult ? listed.records.map((row) => lowerKeys(row as Row)) : null;
      assert("execute returns rows for output and exec on sql server",
        JSON.stringify(insertedRows) === JSON.stringify([{ id: 1 }])
          && JSON.stringify(listedRows) === JSON.stringify([{ id: 1, text: "out" }]),
        `OUTPUT -> ${JSON.stringify(insertedRows ?? inserted)}, EXEC -> ${JSON.stringify(listedRows ?? listed)}`);
    } finally {
      await dropAll();
      database.close();
    }
  });
}

// ── PostgreSQL: no parameters, no rewrite ───────────────────────────────────

const postgresUrl = process.env.TINA4_TEST_PG_URL;
if (!postgresUrl) {
  skip("sql with no parameters is sent exactly as written on postgresql", "[needs:postgres] TINA4_TEST_PG_URL not set, postgres not reachable");
  skip("jsonb exists functions and literal percent work with parameters on postgresql", "[needs:postgres] TINA4_TEST_PG_URL not set, postgres not reachable");
} else {
  const database = await Database.create(postgresUrl);
  try {
    await check("sql with no parameters is sent exactly as written on postgresql", async () => {
      const row = await database.fetchOne<Row>(
        `SELECT ${JSONB} ? 'a' AS has_key, ${JSONB} ?| array['a','z'] AS any_key, ${JSONB} ?& array['a'] AS all_keys, 'a%' AS percent`,
        [], { noCache: true });
      assert("sql with no parameters is sent exactly as written on postgresql",
        JSON.stringify(row) === JSON.stringify({ has_key: true, any_key: true, all_keys: true, percent: "a%" }),
        `got ${JSON.stringify(row)}`);
    });
    await check("jsonb exists functions and literal percent work with parameters on postgresql", async () => {
      const row = await database.fetchOne<Row>(`SELECT jsonb_exists(${JSONB}, ?) AS has_key, 'a%' || ? AS joined`, ["a", "b"], { noCache: true });
      assert("jsonb exists functions and literal percent work with parameters on postgresql",
        JSON.stringify(row) === JSON.stringify({ has_key: true, joined: "a%b" }), `got ${JSON.stringify(row)}`);
    });
  } finally {
    database.close();
  }
}

try { rmSync(sqliteDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
