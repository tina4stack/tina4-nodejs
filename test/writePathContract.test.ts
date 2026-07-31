/**
 * The write-path contract (feature 3/4 of the feature audit).
 *
 * `test/fixtures/write_path_contract.json` is byte-identical in all four
 * frameworks and is the shared answer key: the same cases, the same seeds, the
 * same expectations, executed identically in python, php, ruby and node.
 *
 * The bug these lock in: db.update(table, data) with no explicit filter used to
 * build "UPDATE table SET ... WHERE " with an empty clause — invalid SQL, which
 * the adapters caught and reported as { success: false, affectedRows: 0 }, so a
 * caller who did not inspect the result believed the write landed. A write with
 * no filter is now an error.
 *
 * The fixture used to be ORPHANED — nothing read it, and the four runners were
 * hand-written independently. They drifted to 17/16/15/14 cases with different
 * names, and the case "a_string_filter_with_params_works_the_same_as_a_hash_filter"
 * was executed by NONE of them while exactly that shape shipped broken HERE:
 * the postgres/mysql/mssql/firebird adapters walked a string filter with
 * Object.keys(), so Object.keys("1 = 1") yielded ["0","1",...] and PostgreSQL
 * answered `column "0" does not exist`. Every case now runs in every framework.
 *
 * RUN IT AGAINST EVERY LIVE ENGINE. SQLite alone proves nothing: the whole
 * reason per-adapter write SQL exists is that placeholder style, RETURNING
 * support and identifier quoting differ exactly where the engine differs.
 *
 *   TINA4_TEST_WRITE_PATH_URL=postgres://host:5432/db \
 *   TINA4_TEST_WRITE_PATH_USERNAME=u TINA4_TEST_WRITE_PATH_PASSWORD=p \
 *     npx tsx test/writePathContract.test.ts
 *
 * Unset, it falls back to a temp SQLite file so the suite still runs anywhere.
 * No mocks — a database is a real dependency and CI provisions it.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase } from "../packages/orm/src/database.js";

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => unknown): Promise<void> {
  try {
    // MUST await: an async body returns a pending promise, and without the await
    // check() sees no throw and counts a genuine failure as a pass.
    await fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${(e as Error).message}`);
    failed++;
  }
}

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error(message);
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "write_path_contract.json");
const CONTRACT = JSON.parse(readFileSync(FIXTURE, "utf-8"));

const TABLE: string = CONTRACT.table.name;
const COMPOSITE_TABLE: string = CONTRACT.composite_table.name;

// Cases and errors are one flat list: both halves are contract cases, they only
// differ in whether the expectation is a raise.
const ALL_CASES: any[] = [...CONTRACT.cases, ...CONTRACT.errors];

// Every op the dispatcher below implements. A fixture case naming an op that is
// not here fails loudly rather than being silently skipped — the orphan guard.
const IMPLEMENTED_OPS = new Set([
  "insert", "insert_batch", "update", "delete", "truncate", "primary_key",
  "transaction_rollback", "transaction_commit", "execute_raw",
]);

const ENGINE_URL = process.env.TINA4_TEST_WRITE_PATH_URL || "";
const ENGINE_USERNAME = process.env.TINA4_TEST_WRITE_PATH_USERNAME ?? "";
const ENGINE_PASSWORD = process.env.TINA4_TEST_WRITE_PATH_PASSWORD ?? "";

let dir = "";
let url = "";

/** Open a connection to the engine under test. */
async function connect(): Promise<any> {
  return ENGINE_URL
    ? await initDatabase({ url, username: ENGINE_USERNAME, password: ENGINE_PASSWORD })
    : await initDatabase({ url });
}

function tableFor(kase: any): string {
  return kase.table === "composite" ? COMPOSITE_TABLE : TABLE;
}

async function rows(db: any, table: string): Promise<Record<string, unknown>[]> {
  const r = await db.fetch(`SELECT * FROM ${table}`, [], 1000);
  return r.records as Record<string, unknown>[];
}

/**
 * Engine-tolerant value comparison. Engines disagree on the JS type of an
 * INTEGER column (number, bigint, string on some drivers); this contract is
 * about WHICH rows a write touched, not about type mapping, which the adapter
 * contract owns.
 */
function same(actual: unknown, expected: unknown): boolean {
  return actual === expected || String(actual) === String(expected);
}

/** Both tables empty. Raw DELETE, never truncate() — that is under test. */
async function resetTables(db: any): Promise<void> {
  for (const table of [TABLE, COMPOSITE_TABLE]) {
    await db.execute(`DELETE FROM ${table}`);
  }
}

async function seed(db: any, kase: any, table: string): Promise<void> {
  for (const row of kase.seed ?? []) {
    await db.insert(table, row);
  }
}

async function runOp(db: any, kase: any, table: string): Promise<any> {
  const data = kase.data;

  switch (kase.op) {
    case "insert":
    case "insert_batch":
      return await db.insert(table, data);

    case "update":
      if ("filter_sql" in kase) return await db.update(table, { ...data }, kase.filter_sql, kase.filter_params);
      if ("filter" in kase) return await db.update(table, { ...data }, kase.filter);
      return await db.update(table, { ...data });

    case "delete":
      if ("filter_sql" in kase) return await db.delete(table, kase.filter_sql, kase.filter_params);
      if ("filter" in kase) return await db.delete(table, kase.filter);
      return await db.delete(table);

    case "truncate":
      return await db.truncate(table);

    case "primary_key":
      return await db.primaryKey(table);

    case "transaction_rollback":
    case "transaction_commit":
      await db.startTransaction();
      await db.insert(table, data);
      if (kase.op === "transaction_commit") await db.commit();
      else await db.rollback();
      return null;

    case "execute_raw":
      return await db.execute(kase.sql);
  }

  throw new Error(`unimplemented op ${kase.op} in case ${kase.name}`);
}

/** Every expectation the fixture declares, checked by name. */
async function checkExpectations(db: any, kase: any, table: string, result: any): Promise<void> {
  const name = kase.name;
  const expect = kase.expect ?? {};

  if ("affected_rows" in expect) {
    assert(
      result.affectedRows === expect.affected_rows,
      `${name}: expected affectedRows ${expect.affected_rows}, got ${result.affectedRows}`,
    );
  }

  const current = ("rows_after" in expect || "unchanged" in expect) ? await rows(db, table) : [];

  if ("rows_after" in expect) {
    assert(
      current.length === expect.rows_after,
      `${name}: expected ${expect.rows_after} row(s) after, got ${current.length}: ${JSON.stringify(current)}`,
    );
  }

  for (const matcher of expect.unchanged ?? []) {
    const matched = current.filter((row) =>
      Object.entries(matcher).every(([key, value]) => same(row[key], value)),
    );
    assert(
      matched.length === 1,
      `${name}: expected exactly one row matching ${JSON.stringify(matcher)}, ` +
        `found ${matched.length} in ${JSON.stringify(current)}`,
    );
  }

  if ("primary_key" in expect) {
    assert(
      JSON.stringify(result) === JSON.stringify(expect.primary_key),
      `${name}: expected primary key ${JSON.stringify(expect.primary_key)}, got ${JSON.stringify(result)}`,
    );
  }

  if (expect.last_id_is_null) {
    assert(
      result.lastId === undefined || result.lastId === null,
      `${name}: lastId is insert-only, but this write reported ${result.lastId}`,
    );
  }

  if ("last_id_is_not_stale" in expect) {
    const reported = result.lastId;
    // undefined / null / 0 / "" all mean "this engine cannot report one", which
    // the contract allows. A stale value is the failure being pinned.
    const unreported = reported === undefined || reported === null || Number(reported) === 0 || reported === "";
    if (!unreported) {
      assert(
        !same(reported, expect.last_id_is_not_stale),
        `${name}: lastId came back as the EARLIER row's id (${expect.last_id_is_not_stale}) — ` +
          `the adapter is reporting a stale id rather than null`,
      );
    }
  }

  if (expect.visible_after_reconnect) {
    // A write only visible on the connection that made it is not durable, and
    // reading it back on the same handle cannot tell the difference.
    const other = await connect();
    try {
      const seen = await rows(other, table);
      assert(
        seen.length === (expect.rows_after ?? 1),
        `${name}: the write is not visible on a second connection — it was never durable`,
      );
    } finally {
      try { other.close(); } catch { /* already closed */ }
    }
  }
}

async function main(): Promise<void> {
  console.log("write-path contract");

  dir = mkdtempSync(join(tmpdir(), "tina4-writepath-"));
  url = ENGINE_URL || `sqlite://${join(dir, "contract.db")}`;

  // The orphan guard, checked before any connection: a case naming an op the
  // dispatcher does not implement must FAIL, never be quietly skipped. Silent
  // skipping is how the fixture went unread for its whole life while the four
  // runners drifted apart.
  await check("implements every op the shared fixture uses", () => {
    const missing = [...new Set(ALL_CASES.map((k) => k.op))].filter((op) => !IMPLEMENTED_OPS.has(op));
    assert(missing.length === 0, `the shared fixture declares op(s) this runner cannot execute: ${missing}`);
  });

  const db = await connect();
  try {
    for (const table of [TABLE, COMPOSITE_TABLE]) {
      try {
        await db.execute(`DROP TABLE ${table}`);
      } catch { /* first run against this engine */ }
    }
    // The DDL lives in the shared fixture so all four frameworks create
    // literally the same table. Ids come from the case data, not a sequence —
    // an identity column would fight the explicit ids the cases name.
    await db.execute(CONTRACT.table.ddl);
    await db.execute(CONTRACT.composite_table.ddl);

    // Not a gate — the record. A reader must be able to see whether this
    // contract was checked against a real engine or only against the one that
    // shares nothing with them.
    console.log(`  ---- covered: ${ENGINE_URL ? (ENGINE_URL.split(":")[0] || "?") : "sqlite"} ----`);

    for (const kase of ALL_CASES) {
      await check(`${kase.name} (shared fixture)`, async () => {
        const table = tableFor(kase);
        await resetTables(db);
        await seed(db, kase, table);

        if (kase.expect_raises) {
          let threw = false;
          try {
            await runOp(db, kase, table);
          } catch {
            threw = true;
          }
          assert(threw, `${kase.name}: the op did not throw`);
          // The write must not have landed. This is the data-loss property.
          await checkExpectations(db, kase, table, null);
          if (kase.expect_error_recorded) {
            assert(
              !!db.getError(),
              `${kase.name}: the statement threw but getError() was empty — ` +
                `the cause has to stay readable after the throw`,
            );
          }
          return;
        }

        await checkExpectations(db, kase, table, await runOp(db, kase, table));
      });
    }

    for (const table of [TABLE, COMPOSITE_TABLE]) {
      try {
        await db.execute(`DROP TABLE ${table}`);
      } catch { /* teardown must never mask a failure */ }
    }
  } finally {
    // A live engine keeps a real socket open, and an unclosed socket pins the
    // Node event loop: the file only ever exited because a FAILING run hit
    // process.exit(1) at the end. An all-green run hung forever with its
    // connections idle — the green path was untestable.
    try { db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// Self-executing: a test file that only DEFINES tests reports a passing
// "0 passed" and hides everything.
await main();
