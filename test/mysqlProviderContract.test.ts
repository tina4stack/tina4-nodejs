/**
 * MySQL provider contract — feature 10 (mysqlprovider_contract.json), parity with
 * tina4-python/tests/test_mysqlprovider_contract.py.
 *
 * MYSQL-DEC-01 + MYSQL-DEC-02 (OWNER-DECISIONS.md Batch 5, feature doc
 * 010-mysql-provider.md). Every case drives the lab's REAL MySQL :3306
 * (tina4/tina4 → tina4_test) through the public Database facade → MysqlAdapter.
 * No mocks. Durability is read back on a SECOND, FRESH connection.
 *
 * This adapter does NOT emulate MySQL RETURNING (only the Python adapter does); a
 * non-`id`-PK insert surfaces the correct generated id through mysql2's
 * column-independent insertId (invariant 1). MYSQL-DEC-02 here: the DESCRIBE
 * introspection is STRICT-quoted with embedded backticks ESCAPED
 * (MYSQL-DESCRIBE-UNPARAM). Node loops a batch row-at-a-time, so it has no
 * FIRST→LAST block to de-duplicate (the batch case is a green regression lock).
 *
 * Mutation-proof: revert the escaped back-quote in columnsAsync → "describe of an
 * odd table name returns its columns" goes RED (the embedded backtick closes the
 * identifier early and the DESCRIBE errors).
 *
 * Run with: npx tsx test/mysqlProviderContract.test.ts
 */
import process from "node:process";
import net from "node:net";
// Import from SOURCE (not the "@tina4/orm" exports map, which resolves to the
// prebuilt dist bundle) so this contract exercises the CHANGED src adapter
// (packages/orm/src/adapters/mysql.ts), not a stale dist. Same convention as
// test/sqlTranslatorContract.test.ts.
import { Database, createAdapterFromUrl } from "../packages/orm/src/index.js";

const HOST = process.env.TINA4_TEST_MYSQL_HOST ?? "127.0.0.1";
const PORT = parseInt(process.env.TINA4_TEST_MYSQL_PORT ?? "3306", 10);
const USER = process.env.TINA4_TEST_MYSQL_USERNAME ?? "tina4";
const PASS = process.env.TINA4_TEST_MYSQL_PASSWORD ?? "tina4";
const DB = process.env.TINA4_TEST_MYSQL_DB ?? "tina4_test";

const NONID = "mysqlprov_nonid";      // a table whose PK is deliberately NOT `id`
const BATCH = "mysqlprov_batch";
const SENTINEL = "mysqlprov_sentinel";
const ODD = "mysqlprov`odd";          // an embedded backtick -> needs strict quoting

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
  }
}

const requireServices = /^(1|true|yes|on)$/i.test(process.env.TINA4_REQUIRE_SERVICES ?? "");
function skip(msg: string): void {
  // "a run with skips is NOT verification" — under the gate a provisioned service
  // that is missing is a hard FAILURE, not a green skip.
  if (requireServices) {
    console.error(`  \x1b[31mSKIP-AS-FAIL\x1b[0m ${msg}`);
    process.exit(1);
  }
  console.log(`  \x1b[33mSKIP\x1b[0m ${msg}`);
}

function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

const mysqlUrl = (): string => `mysql://${USER}:${PASS}@${HOST}:${PORT}/${DB}`;

/** Strict backtick-quote for building DDL / reads against an odd name in the test. */
const q = (name: string): string => "`" + name.replace(/`/g, "``") + "`";

async function connect(): Promise<{ db: Database; adapter: any }> {
  const adapter: any = await createAdapterFromUrl(mysqlUrl());
  const db = new Database(adapter);
  db.setDbType("mysql");
  return { db, adapter };
}

/** Every row on a SECOND connection — the durability witness. */
async function freshRows(table: string, orderCol: string): Promise<Record<string, unknown>[]> {
  const { db, adapter } = await connect();
  try {
    const result = await db.fetch(`SELECT * FROM ${q(table)} ORDER BY ${q(orderCol)}`, [], 1000);
    return result.records as Record<string, unknown>[];
  } finally {
    try { await adapter.close(); } catch { /* ignore */ }
  }
}

/** A fresh AUTO_INCREMENT table with a NON-`id` PK so its sequence restarts at 1. */
async function freshNonid(db: Database): Promise<void> {
  await db.execute(`DROP TABLE IF EXISTS ${NONID}`);
  await db.execute(
    `CREATE TABLE ${NONID} (person_key INT NOT NULL AUTO_INCREMENT PRIMARY KEY, code VARCHAR(40) NOT NULL UNIQUE, qty INTEGER)`,
  );
}

async function withDb(fn: (db: Database) => Promise<void>): Promise<void> {
  const { db, adapter } = await connect();
  try {
    await fn(db);
  } finally {
    for (const t of [q(NONID), q(BATCH), q(SENTINEL), q(ODD)]) {
      try { await db.execute(`DROP TABLE IF EXISTS ${t}`); } catch { /* ignore */ }
    }
    try { await adapter.close(); } catch { /* ignore */ }
  }
}

async function run(): Promise<void> {
  if (!(await tcpReachable(HOST, PORT))) {
    skip(`no reachable MySQL at ${HOST}:${PORT} (set TINA4_TEST_MYSQL_*)`);
    console.log(`\nmysqlProviderContract: ${pass} passed, ${fail} failed (MySQL unreachable)`);
    return;
  }

  // ── mysql-nonid-pk-generated-id ──────────────────────────────────────────
  await withDb(async (db) => {
    await freshNonid(db);
    const result = await db.insert(NONID, { code: "a", qty: 10 });
    const rows = await freshRows(NONID, "person_key");
    check(
      "a non id primary key insert returns the generated last id",
      Number(result.lastId) === 1 && rows.length === 1 && Number(rows[0]!.person_key) === 1 && rows[0]!.code === "a",
      `lastId=${String(result.lastId)} rows=${JSON.stringify(rows)}`,
    );
  });

  await withDb(async (db) => {
    await freshNonid(db);
    const first = await db.insert(NONID, { code: "a", qty: 10 });
    const second = await db.insert(NONID, { code: "b", qty: 20 });
    check(
      "a second non id primary key insert returns the next generated id",
      Number(first.lastId) === 1 && Number(second.lastId) === 2 && second.lastId !== first.lastId,
      `first=${String(first.lastId)} second=${String(second.lastId)}`,
    );
  });

  await withDb(async (db) => {
    await freshNonid(db);
    const result = await db.insert(NONID, { code: "a", qty: 10 });
    check("a non id primary key insert reports affected rows of one", result.affectedRows === 1, `affectedRows=${result.affectedRows}`);
  });

  // ── mysql-write-affected-count ───────────────────────────────────────────
  await withDb(async (db) => {
    await freshNonid(db);
    await db.insert(NONID, { code: "a", qty: 10 });
    await db.insert(NONID, { code: "b", qty: 20 });
    await db.insert(NONID, { code: "c", qty: 40 });
    const result = await db.update(NONID, { qty: 99 }, "qty < ?", [30]);
    check("update reports the exact number of rows changed", result.affectedRows === 2, `affectedRows=${result.affectedRows}`);
  });

  await withDb(async (db) => {
    await freshNonid(db);
    await db.insert(NONID, { code: "a", qty: 10 });
    await db.insert(NONID, { code: "b", qty: 20 });
    const result = await db.delete(NONID, { code: "a" });
    const rows = await freshRows(NONID, "person_key");
    check(
      "delete reports the exact number of rows removed",
      result.affectedRows === 1 && rows.length === 1 && rows[0]!.code === "b",
      `affectedRows=${result.affectedRows} rows=${JSON.stringify(rows)}`,
    );
  });

  await withDb(async (db) => {
    await freshNonid(db);
    await db.insert(NONID, { code: "a", qty: 10 });
    const result = await db.update(NONID, { qty: 99 }, "code = ?", ["a"]);
    check(
      "an update reports a null last id",
      result.lastId === null || result.lastId === undefined,
      `lastId=${String(result.lastId)}`,
    );
  });

  // ── mysql-describe-safe ──────────────────────────────────────────────────
  await withDb(async (db) => {
    await db.execute(`DROP TABLE IF EXISTS ${q(ODD)}`);
    await db.execute(`CREATE TABLE ${q(ODD)} (person_key INT NOT NULL AUTO_INCREMENT PRIMARY KEY, val VARCHAR(20))`);
    // A back-quoted-but-unescaped DESCRIBE lets the embedded backtick close the
    // identifier early; escaping it introspects the odd name correctly.
    const cols = await db.getColumns(ODD);
    const names = cols.map((c) => c.name);
    const pk = cols.filter((c) => c.primaryKey).map((c) => c.name);
    check(
      "describe of an odd table name returns its columns",
      JSON.stringify(names) === JSON.stringify(["person_key", "val"]) && JSON.stringify(pk) === JSON.stringify(["person_key"]),
      `cols=${JSON.stringify(cols)}`,
    );
  });

  await withDb(async (db) => {
    await db.execute(`DROP TABLE IF EXISTS ${SENTINEL}`);
    await db.execute(`CREATE TABLE ${SENTINEL} (id INT PRIMARY KEY)`);
    const crafted = `x\`; DROP TABLE ${SENTINEL}; --`;
    // The crafted name becomes ONE escaped identifier -> a clean "unknown table"
    // (no runnable SQL). The result is irrelevant; the sentinel must survive.
    try { await db.getColumns(crafted); } catch { /* clean unknown-table error */ }
    const survived = await db.tableExists(SENTINEL);
    check("describe of a crafted table name does not inject", survived === true, `sentinel survived=${survived}`);
  });

  // ── mysql-batch-sequential-ids ───────────────────────────────────────────
  await withDb(async (db) => {
    await db.execute(`DROP TABLE IF EXISTS ${BATCH}`);
    await db.execute(`CREATE TABLE ${BATCH} (seq_key INT NOT NULL AUTO_INCREMENT PRIMARY KEY, code VARCHAR(40) NOT NULL, qty INTEGER)`);
    const result = await db.insert(BATCH, [
      { code: "b1", qty: 1 },
      { code: "b2", qty: 2 },
      { code: "b3", qty: 3 },
    ]);
    check("a batch insert returns the last sequential generated id", Number(result.lastId) === 3, `lastId=${String(result.lastId)}`);
  });

  await withDb(async (db) => {
    await db.execute(`DROP TABLE IF EXISTS ${BATCH}`);
    await db.execute(`CREATE TABLE ${BATCH} (seq_key INT NOT NULL AUTO_INCREMENT PRIMARY KEY, code VARCHAR(40) NOT NULL, qty INTEGER)`);
    await db.insert(BATCH, [
      { code: "b1", qty: 1 },
      { code: "b2", qty: 2 },
      { code: "b3", qty: 3 },
    ]);
    const rows = await freshRows(BATCH, "seq_key");
    const keys = rows.map((r) => Number(r.seq_key));
    const codes = rows.map((r) => r.code);
    check(
      "a batch insert assigns consecutive ids to every row",
      JSON.stringify(keys) === JSON.stringify([1, 2, 3]) && JSON.stringify(codes) === JSON.stringify(["b1", "b2", "b3"]),
      `rows=${JSON.stringify(rows)}`,
    );
  });

  console.log(`\nmysqlProviderContract: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
